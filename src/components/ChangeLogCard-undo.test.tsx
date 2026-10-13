import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  balanceCorrectionChange, categoryFiledChange, importChange, stampChange, type ChangeDraft,
} from '../../shared/change-entries';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log';
import type { UndoOutcome } from '../../shared/change-undo-run';
import {
  emptySyncOverrides, setAccountOverride, setTxOverride, type LoadedSyncOverrides,
} from '../../shared/sync-overrides';
import { ChangeLogCard, OVERRIDES_EMPTY, OVERRIDES_UNREADABLE, OVERRIDE_REMOVED, type ChangeLogCardProps } from './ChangeLogCard';

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

  it('stays read-only without the undo prop, as in R1', async () => {
    mount([yourCorrection()]);
    await open(/Added a balance correction/);
    expect(within(detail()).queryByRole('button')).toBeNull();
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
    fireEvent.click(within(document.querySelectorAll('.sfin-log-override')[0] as HTMLElement).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(OVERRIDE_REMOVED)).toBeInTheDocument();
    expect(removeOverride).toHaveBeenCalledWith(expect.objectContaining({ scope: 'account', key: 'sfin-1', flag: 'noAutoCorrect' }));
    await waitFor(() => expect(rows()).toEqual(['Not a transfer: CITI AUTOPAY · Checking']));
  });

  it('says when there are none, and turns read-only over an unreadable document', async () => {
    mount([], { loadOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: false })) });
    expect(await screen.findByText(OVERRIDES_EMPTY)).toBeInTheDocument();
  });

  it('an unreadable document: the notice, no Remove', async () => {
    mount([], { loadOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: true })), removeOverride: vi.fn() });
    expect(await screen.findByText(OVERRIDES_UNREADABLE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('carries no emoji in its copy', async () => {
    mount([imported(), filing()], { undo: vi.fn(), loadOverrides: vi.fn(async () => doc()), companionVersion: '1.59.2' });
    await screen.findByText('Your overrides');
    await open(/Imported SQ/);
    await open(/Filed VENMO/);
    const chrome = Array.from(document.querySelectorAll('button, .sfin-subtle, .sfin-log-overrides-title, .sfin-log-result'))
      .map((el) => el.textContent ?? '').join('\n');
    expect(chrome).not.toMatch(EMOJI);
  });
});
