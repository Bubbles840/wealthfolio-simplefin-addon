import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  balanceCorrectionChange, categoryFiledChange, importChange, paybackFiledChange, stampChange, type ChangeDraft,
} from '../../shared/change-entries';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log';
import type { UndoOutcome } from '../../shared/change-undo-run';
import { UNDO_UNREACHABLE } from '../../shared/change-undo';
import {
  emptySyncOverrides, setAccountOverride, setTxOverride, type LoadedSyncOverrides,
} from '../../shared/sync-overrides';
import {
  ChangeLogCard, CHANGE_LOG_READ_FAILED, OVERRIDES_EMPTY, OVERRIDES_READ_FAILED, OVERRIDES_UNREADABLE, OVERRIDE_REMOVED, OVERRIDE_PAYBACK_UNDO, type ChangeLogCardProps } from './ChangeLogCard';

const at = (month: number, day: number, h: number, m: number) => new Date(2026, month, day, h, m);
const NOW = at(9, 13, 15, 0);
const CHECKING = { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' };
const item = (draft: ChangeDraft, when: Date): ChangeLogItem => stampChange(draft, 'companion', when);
const imported = () => item(importChange({
  account: CHECKING, txKey: 'sfin-1\u0000tx-1', activityId: 'act-1', description: 'SQ *BLUE_BOTTLE', amountCents: -650,
  date: '2026-10-12', pending: false, activityType: 'WITHDRAWAL',
}), at(9, 13, 9, 0));
const yourCorrection = () => item(balanceCorrectionChange({
  account: CHECKING, actor: 'you', activityId: 'plug-1', amountCents: 215, date: '2026-10-13', activityType: 'CREDIT', comment: 'Balance adjustment · sfin-1 · 2026-10-13',
}), at(9, 13, 10, 0));
const filing = () => item(categoryFiledChange({
  actor: 'you', activityId: 'act-5', description: 'VENMO *J SMITH', before: null, after: { categoryId: 'c', categoryName: 'Dining' },
}), at(9, 13, 11, 0));
const log = (entries: ChangeLogItem[]): ChangeLogRead =>
  ({ entries: [...entries].sort((a, b) => (a.at < b.at ? 1 : -1)), gaps: [], trimmed: 0, unreadable: [] });
const KEY = 'sfin-1\u0000tx-9';
const covering = () => item(paybackFiledChange({
  account: CHECKING, txKeys: [KEY], activityId: 'act-9', description: 'VENMO CASHOUT', amountCents: 5000, date: '2026-10-12',
  subtypeBefore: null, categoryId: 'cat-1', categoryName: 'Dining',
}), at(9, 13, 9, 0));
const EMOJI = /\p{Extended_Pictographic}/u;

function mount(entries: ChangeLogItem[], props: Partial<ChangeLogCardProps> = {}) {
  const load = vi.fn(async () => log(entries));
  render(<ChangeLogCard load={load} now={() => NOW} companionVersion="1.61.0" {...props} />);
  return load;
}
const open = async (name: RegExp) => fireEvent.click(await screen.findByRole('button', { name }));
const detail = () => document.querySelector('.sfin-log-detail') as HTMLElement;

describe('ChangeLogCard — Undo and Redo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('undoes at once — no confirmation — says what happened, and reads the log again', async () => {
    const e = yourCorrection();
    const undo = vi.fn(async (): Promise<UndoOutcome> => ({ ok: true, message: 'Undone — the correction is gone.', needsSync: false }));
    const load = mount([e], { undo });
    await open(/Added a balance correction/);
    fireEvent.click(within(detail()).getByRole('button', { name: 'Undo' }));
    expect(await within(detail()).findByText('Undone — the correction is gone.')).toBeInTheDocument();
    expect(undo).toHaveBeenCalledWith(expect.objectContaining({ id: e.id }), [e], 'undo');
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('after a sync decision: "Takes effect on the next sync." beside Sync now', async () => {
    const onSyncNow = vi.fn(async () => 'Synced — 0 imported.');
    mount([imported()], {
      undo: vi.fn(async () => ({ ok: true as const, message: "Undone — it's removed and won't be imported again.", needsSync: true })),
      onSyncNow,
    });
    await open(/Imported SQ \*BLUE_BOTTLE/);
    fireEvent.click(within(detail()).getByRole('button', { name: 'Undo' }));
    expect(await within(detail()).findByText(/Takes effect on the next sync\./)).toBeInTheDocument();
    fireEvent.click(within(detail()).getByRole('button', { name: 'Sync now' }));
    expect(await within(detail()).findByText('Synced — 0 imported.')).toBeInTheDocument();
    expect(onSyncNow).toHaveBeenCalledTimes(1);
  });

  it('an old companion disables a sync decision’s Undo: "Update the companion first"', async () => {
    const undo = vi.fn();
    mount([imported()], { undo, companionVersion: '1.59.2' });
    await open(/Imported SQ \*BLUE_BOTTLE/);
    const button = within(detail()).getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(within(detail()).getByText('Update the companion first')).toBeInTheDocument();
    fireEvent.click(button);
    expect(undo).not.toHaveBeenCalled();
  });

  it('a category entry points at Telegram while a companion runs, and offers nothing without one', async () => {
    mount([filing()], { undo: vi.fn() });
    await open(/Filed VENMO/);
    expect(within(detail()).getByText('Undo this from Telegram: /changes')).toBeInTheDocument();
    expect(within(detail()).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('a category entry with no companion shows no undo line at all', async () => {
    mount([filing()], { undo: vi.fn(), companionVersion: null });
    await open(/Filed VENMO/);
    expect(within(detail()).queryByText(/from Telegram/)).toBeNull();
    expect(document.querySelector('.sfin-log-undo')).toBeNull();
  });

  it('an undone row is muted, says "Undone by you", and offers Redo', async () => {
    const e = { ...yourCorrection(), undone: { by: 'a9', at: at(9, 13, 12, 0).toISOString() } };
    const undo = vi.fn(async (): Promise<UndoOutcome> => ({ ok: true, message: 'Redone — the correction is back.', needsSync: false }));
    mount([e], { undo });
    const row = await screen.findByRole('button', { name: /Added a balance correction/ });
    expect(row.className).toContain('sfin-log-row--undone');
    expect(row.textContent).toContain('· Undone by you Oct 13');
    fireEvent.click(row);
    fireEvent.click(within(detail()).getByRole('button', { name: 'Redo' }));
    await within(detail()).findByText('Redone — the correction is back.');
    expect(undo).toHaveBeenCalledWith(expect.anything(), expect.any(Array), 'redo');
  });

  it('says a refusal under the row', async () => {
    mount([yourCorrection()], { undo: vi.fn(async () => ({ ok: false as const, message: 'It has changed since — nothing was undone.' })) });
    await open(/Added a balance correction/);
    fireEvent.click(within(detail()).getByRole('button', { name: 'Undo' }));
    expect(await within(detail()).findByText('It has changed since — nothing was undone.')).toBeInTheDocument();
    expect(within(detail()).queryByText(/Takes effect/)).toBeNull();
  });

  const deferred = () => {
    let resolve!: (o: UndoOutcome) => void;
    const promise = new Promise<UndoOutcome>((r) => { resolve = r; });
    return { promise, resolve };
  };

  it('one undo per click: a second click while it runs does nothing, and the button says it is busy', async () => {
    const d = deferred();
    const undo = vi.fn(() => d.promise);
    mount([yourCorrection()], { undo });
    await open(/Added a balance correction/);
    const button = within(detail()).getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    d.resolve({ ok: true, message: 'Undone.', needsSync: false });
    await within(detail()).findByText('Undone.');
  });

  it('a failed re-read after an undo keeps the rows, the result, and Sync now, with an inline note', async () => {
    const e = imported();
    let reads = 0;
    const load = vi.fn(async () => {
      reads += 1;
      if (reads > 1) throw new Error('boom');
      return log([e]);
    });
    render(<ChangeLogCard
      load={load}
      now={() => NOW}
      companionVersion="1.61.0"
      undo={vi.fn(async () => ({ ok: true as const, message: 'Undone — removed.', needsSync: true }))}
      onSyncNow={vi.fn(async () => 'Synced.')}
    />);
    await open(/Imported SQ \*BLUE_BOTTLE/);
    fireEvent.click(within(detail()).getByRole('button', { name: 'Undo' }));
    expect(await within(detail()).findByText('Undone — removed.')).toBeInTheDocument();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(CHANGE_LOG_READ_FAILED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Imported SQ/ })).toBeInTheDocument();
    expect(within(detail()).getByText('Undone — removed.')).toBeInTheDocument();
    expect(within(detail()).getByText(/Takes effect on the next sync\./)).toBeInTheDocument();
    expect(within(detail()).getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
  });

  it('a first read that fails still shows the failure state', async () => {
    render(<ChangeLogCard load={vi.fn(async () => null)} now={() => NOW} />);
    expect(await screen.findByText(CHANGE_LOG_READ_FAILED)).toBeInTheDocument();
  });

  it('result and synced lines are polite live regions', async () => {
    mount([imported()], {
      undo: vi.fn(async () => ({ ok: true as const, message: 'Undone.', needsSync: true })),
      onSyncNow: vi.fn(async () => 'Synced — 0 imported.'),
    });
    await open(/Imported SQ/);
    fireEvent.click(within(detail()).getByRole('button', { name: 'Undo' }));
    await within(detail()).findByText('Undone.');
    fireEvent.click(await within(detail()).findByRole('button', { name: 'Sync now' }));
    const synced = await within(detail()).findByText('Synced — 0 imported.');
    expect(synced.getAttribute('role')).toBe('status');
    expect(within(detail()).getByText('Undone.').getAttribute('role')).toBe('status');
  });

  it('undo rejecting shows UNDO_UNREACHABLE', async () => {
    mount([yourCorrection()], { undo: vi.fn(async () => { throw new Error('x'); }) });
    await open(/Added a balance correction/);
    fireEvent.click(within(detail()).getByRole('button', { name: 'Undo' }));
    expect(await within(detail()).findByText(UNDO_UNREACHABLE)).toBeInTheDocument();
  });

  it('Sync now rejecting says the sync failed', async () => {
    mount([imported()], {
      undo: vi.fn(async () => ({ ok: true as const, message: 'Undone.', needsSync: true })),
      onSyncNow: vi.fn(async () => { throw new Error('bridge down'); }),
    });
    await open(/Imported SQ/);
    fireEvent.click(within(detail()).getByRole('button', { name: 'Undo' }));
    fireEvent.click(await within(detail()).findByRole('button', { name: 'Sync now' }));
    expect(await within(detail()).findByText('The sync failed: bridge down')).toBeInTheDocument();
  });

  it('unmounting while an undo is pending, then resolving it, updates nothing and logs no error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deferred();
    const undo = vi.fn(() => d.promise);
    const load = vi.fn(async () => log([yourCorrection()]));
    const { unmount } = render(<ChangeLogCard load={load} now={() => NOW} companionVersion="1.61.0" undo={undo} />);
    await open(/Added a balance correction/);
    fireEvent.click(within(detail()).getByRole('button', { name: 'Undo' }));
    unmount();
    d.resolve({ ok: true, message: 'Undone.', needsSync: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(err).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('stays read-only without the undo prop, as in R1', async () => {
    mount([yourCorrection()]);
    await open(/Added a balance correction/);
    expect(within(detail()).queryByRole('button')).toBeNull();
  });

  describe('a run row (one sync’s imports)', () => {
    const runImport = (n: number, when: Date, over: Partial<ChangeLogItem> = {}): ChangeLogItem => ({
      ...stampChange(importChange({
        account: CHECKING, txKey: `sfin-1\u0000tx-${n}`, activityId: `act-${n}`, description: `KROGER #${n}`, amountCents: -1234,
        date: '2026-10-12', pending: false, activityType: 'WITHDRAWAL',
      }), 'companion', when, 'runA'),
      ...over,
    });
    /** The detail a run line opens, right under it. */
    const lineDetail = (line: HTMLElement) => line.closest('.sfin-log-item')!.querySelector(':scope > .sfin-log-detail') as HTMLElement;

    it('opens a line to its own detail, whose Undo undoes that entry and says so inline', async () => {
      const a = runImport(1, at(9, 13, 9, 0));
      const b = runImport(2, at(9, 13, 9, 1));
      const undo = vi.fn(async (): Promise<UndoOutcome> => ({ ok: true, message: "Undone — it's removed and won't be imported again.", needsSync: false }));
      const load = mount([a, b], { undo });
      await open(/Imported 2 transactions/);
      const line = screen.getByRole('button', { name: /Imported KROGER #1/ });
      expect(line.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(line);
      expect(line.getAttribute('aria-expanded')).toBe('true');
      // Opening rows reads nothing: the log is read once per opening of the card.
      expect(load).toHaveBeenCalledTimes(1);
      const d = lineDetail(line);
      expect(d.textContent).toContain('Automatic — the background sync');
      expect(screen.getByRole('button', { name: /Imported KROGER #2/ }).getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(within(d).getByRole('button', { name: 'Undo' }));
      expect(await within(d).findByText("Undone — it's removed and won't be imported again.")).toBeInTheDocument();
      expect(undo).toHaveBeenCalledTimes(1);
      expect(undo).toHaveBeenCalledWith(expect.objectContaining({ id: a.id }), expect.arrayContaining([a, b]), 'undo');
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      // The re-read keeps the run and the line open, with the result under it.
      expect(within(lineDetail(screen.getByRole('button', { name: /Imported KROGER #1/ }))).getByText("Undone — it's removed and won't be imported again.")).toBeInTheDocument();
    });

    it('an undone line is muted and offers Redo', async () => {
      const a = runImport(1, at(9, 13, 9, 0), { undone: { by: 'a9', at: at(9, 13, 12, 0).toISOString() } });
      const undo = vi.fn(async (): Promise<UndoOutcome> => ({ ok: true, message: 'Redone — the next sync imports it again.', needsSync: true }));
      mount([a, runImport(2, at(9, 13, 9, 1))], { undo });
      await open(/Imported 2 transactions/);
      const line = screen.getByRole('button', { name: /Imported KROGER #1/ });
      expect(line.className).toContain('sfin-log-row--undone');
      expect(line.textContent).toContain('· Undone by you Oct 13');
      fireEvent.click(line);
      fireEvent.click(within(lineDetail(line)).getByRole('button', { name: 'Redo' }));
      expect(await within(lineDetail(line)).findByText(/Takes effect on the next sync\./)).toBeInTheDocument();
      expect(undo).toHaveBeenCalledWith(expect.objectContaining({ id: a.id }), expect.any(Array), 'redo');
    });

    it('a line whose entry cannot be undone shows no button', async () => {
      const undo = vi.fn();
      mount([runImport(1, at(9, 13, 9, 0), { undoable: false }), runImport(2, at(9, 13, 9, 1))], { undo });
      await open(/Imported 2 transactions/);
      const line = screen.getByRole('button', { name: /Imported KROGER #1/ });
      fireEvent.click(line);
      const d = lineDetail(line);
      expect(d.textContent).toContain('Automatic — the background sync');
      expect(within(d).queryByRole('button')).toBeNull();
      expect(d.querySelector('.sfin-log-undo')).toBeNull();
    });
  });
});

describe('ChangeLogCard — Your overrides', () => {
  const doc = (): LoadedSyncOverrides => ({
    overrides: setAccountOverride(
      setTxOverride(emptySyncOverrides(), 'sfin-1\u0000tx-1', 'notTransfer', new Date('2026-10-12T09:00:00Z'), { label: 'CITI AUTOPAY · Checking' }),
      'sfin-1', 'noAutoCorrect', new Date('2026-10-13T09:00:00Z'), { label: 'Checking' },
    ),
    unreadable: false,
  });

  it('lists each override in words, newest first, and Remove takes one out', async () => {
    let current = doc();
    const loadOverrides = vi.fn(async () => current);
    const removeOverride = vi.fn(async () => { current = { overrides: setTxOverride(emptySyncOverrides(), 'x', 'notTransfer', new Date('2026-10-12T09:00:00Z'), { label: 'CITI AUTOPAY · Checking' }), unreadable: false }; });
    mount([], { loadOverrides, removeOverride });
    expect(await screen.findByText('Your overrides')).toBeInTheDocument();
    const rows = () => Array.from(document.querySelectorAll('.sfin-log-override')).map((r) => r.querySelector('.sfin-log-summary')!.textContent);
    expect(rows()).toEqual(['No automatic balance corrections: Checking', 'Not a transfer: CITI AUTOPAY · Checking']);
    fireEvent.click(within(document.querySelectorAll('.sfin-log-override')[0] as HTMLElement).getByRole('button', { name: 'Remove No automatic balance corrections: Checking' }));
    expect(await screen.findByText(OVERRIDE_REMOVED)).toBeInTheDocument();
    expect(removeOverride).toHaveBeenCalledWith(expect.objectContaining({ scope: 'account', key: 'sfin-1', flag: 'noAutoCorrect' }), false);
    await waitFor(() => expect(rows()).toEqual(['Not a transfer: CITI AUTOPAY · Checking']));
  });

  it('a Payback row is read-only: it points to /changes and has no Remove button (I-1)', async () => {
    const removeOverride = vi.fn();
    mount([covering()], { loadOverrides: vi.fn(async () => ({
      overrides: setTxOverride(doc().overrides, 'sfin-1\u0000tx-9', 'asReimbursement', new Date('2026-10-14T09:00:00Z'), { label: 'VENMO CASHOUT · Checking' }),
      unreadable: false,
    })), removeOverride });
    await screen.findByText('Payback: VENMO CASHOUT · Checking');
    const paybackRow = Array.from(document.querySelectorAll('.sfin-log-override')).find((r) => r.textContent!.includes('Payback:')) as HTMLElement;
    expect(OVERRIDE_PAYBACK_UNDO).toBe('Undo it from Telegram: /changes');
    expect(paybackRow.textContent).toContain(OVERRIDE_PAYBACK_UNDO);
    expect(within(paybackRow).queryByRole('button')).toBeNull();
    // The other rows keep theirs.
    expect(screen.getByRole('button', { name: 'Remove Not a transfer: CITI AUTOPAY · Checking' })).toBeInTheDocument();
    expect(/\p{Extended_Pictographic}/u.test(paybackRow.textContent!)).toBe(false);
  });

  describe('a Payback row with no Undo behind it (W11-C I1)', () => {
    const paybackEntry = covering;
    const overrides = () => vi.fn(async () => ({
      overrides: setTxOverride(doc().overrides, KEY, 'asReimbursement', new Date('2026-10-14T09:00:00Z'), { label: 'VENMO CASHOUT · Checking' }),
      unreadable: false,
    }));
    const paybackRow = () => Array.from(document.querySelectorAll('.sfin-log-override')).find((r) => r.textContent!.includes('Payback:')) as HTMLElement;

    it('offers Remove, and passes that no Undo covers it', async () => {
      const removeOverride = vi.fn(async () => {});
      mount([], { loadOverrides: overrides(), removeOverride });
      await screen.findByText('Payback: VENMO CASHOUT · Checking');
      expect(paybackRow().textContent).not.toContain(OVERRIDE_PAYBACK_UNDO);
      fireEvent.click(within(paybackRow()).getByRole('button', { name: 'Remove Payback: VENMO CASHOUT · Checking' }));
      await waitFor(() => expect(removeOverride).toHaveBeenCalledWith(expect.objectContaining({ flag: 'asReimbursement', key: KEY }), false));
    });

    it('keeps the Telegram pointer and no button while an un-undone payback-filed entry covers the key', async () => {
      mount([paybackEntry()], { loadOverrides: overrides(), removeOverride: vi.fn() });
      await screen.findByText('Payback: VENMO CASHOUT · Checking');
      expect(paybackRow().textContent).toContain(OVERRIDE_PAYBACK_UNDO);
      expect(within(paybackRow()).queryByRole('button')).toBeNull();
    });
  });

  it('Remove is guarded while it runs: a double click removes once', async () => {
    let release!: () => void;
    const removeOverride = vi.fn(() => new Promise<void>((r) => { release = r; }));
    mount([], { loadOverrides: vi.fn(async () => doc()), removeOverride });
    const button = await screen.findByRole('button', { name: 'Remove No automatic balance corrections: Checking' }) as HTMLButtonElement;
    fireEvent.click(button);
    fireEvent.click(button);
    expect(removeOverride).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    release();
    expect(await screen.findByText(OVERRIDE_REMOVED)).toBeInTheDocument();
  });

  it('a removal that throws shows its message', async () => {
    mount([], { loadOverrides: vi.fn(async () => doc()), removeOverride: vi.fn(async () => { throw new Error('Could not save'); }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove No automatic balance corrections: Checking' }));
    expect(await screen.findByText('Could not save')).toBeInTheDocument();
  });

  it('loadOverrides returning null or rejecting says the overrides could not be read', async () => {
    const { unmount } = render(<ChangeLogCard load={vi.fn(async () => log([]))} now={() => NOW} loadOverrides={vi.fn(async () => null)} />);
    expect(await screen.findByText(OVERRIDES_READ_FAILED)).toBeInTheDocument();
    unmount();
    render(<ChangeLogCard load={vi.fn(async () => log([]))} now={() => NOW} loadOverrides={vi.fn(async () => { throw new Error('x'); })} />);
    expect(await screen.findByText(OVERRIDES_READ_FAILED)).toBeInTheDocument();
  });

  it('says when there are none, and turns read-only over an unreadable document', async () => {
    mount([], { loadOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: false })) });
    expect(await screen.findByText(OVERRIDES_EMPTY)).toBeInTheDocument();
  });

  it('an unreadable document: the notice, no Remove', async () => {
    mount([], { loadOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: true })), removeOverride: vi.fn() });
    expect(await screen.findByText(OVERRIDES_UNREADABLE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('carries no emoji in its copy', async () => {
    mount([imported(), filing()], { undo: vi.fn(), loadOverrides: vi.fn(async () => doc()), companionVersion: '1.59.2' });
    await screen.findByText('Your overrides');
    await open(/Imported SQ/);
    await open(/Filed VENMO/);
    const chrome = Array.from(document.querySelectorAll('button, .sfin-subtle, .sfin-log-overrides-title, .sfin-log-result, .sfin-log-note, [role="status"]'))
      .map((el) => el.textContent ?? '').join('\n');
    expect(chrome).not.toMatch(EMOJI);
  });
});
