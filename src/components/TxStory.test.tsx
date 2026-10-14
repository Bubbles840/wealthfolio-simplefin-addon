import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { importChange, stampChange } from '../../shared/change-entries';
import type { ChangeLogItem } from '../../shared/change-log';
import type { UndoOutcome } from '../../shared/change-undo-run';
import {
  buildTxStory, TX_FACT_NOTES, TX_STORY_GONE_APP, TX_STORY_NO_HISTORY, TX_STORY_UNREACHABLE, type TxStory,
} from '../../shared/tx-story';
import { ThemeStyles } from './ui';
import { TxStoryPanel, TxStoryView, TX_STORY_REREAD_FAILED, type TxStoryActions } from './TxStory';
import type { AppStoryOutcome } from '../utils/tx-story';

const EMOJI = /\p{Extended_Pictographic}/u;
const NOW = new Date(2026, 9, 13, 15, 0);
const imported: ChangeLogItem = stampChange(importChange({
  account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' }, txKey: 'sfin-1\u0000tx-1', activityId: 'act-1',
  description: 'SQ *BLUE_BOTTLE <b>', amountCents: -650, date: '2026-10-12', pending: false, activityType: 'WITHDRAWAL',
}), 'companion', new Date(2026, 9, 12, 9, 0));
const story = (over: Partial<TxStory> = {}): TxStory => ({
  ...buildTxStory({
    row: { activityId: 'act-1', note: 'SQ *BLUE_BOTTLE <b> · tx-1', absCents: 650, date: '2026-10-12', activityType: 'WITHDRAWAL', accountName: 'Checking' },
    feed: { sfinAccountId: 'sfin-1' }, partner: null, filerHint: 'telegram', history: [imported], now: NOW,
  }),
  ...over,
});
const actions = (over: Partial<TxStoryActions> = {}): TxStoryActions => ({ companionVersion: '1.61.0', ...over });

describe('TxStoryView', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the title, the account, the answer and what happened — bank text as text, no emoji', () => {
    const { container } = render(<TxStoryView story={story()} entries={[imported]} actions={actions()} onChanged={() => {}} />);
    expect(screen.getByText('SQ *BLUE_BOTTLE <b> · -$6.50 · Oct 12')).toBeInTheDocument();
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.getByText('From your Checking bank feed.')).toBeInTheDocument();
    expect(screen.getByText('Ask /why in Telegram to see who filed it.')).toBeInTheDocument();
    expect(screen.getByText('What happened')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
    expect(EMOJI.test(container.textContent ?? '')).toBe(false);
  });

  it('says when nothing happened in 90 days, and shows no section when the log was not read', () => {
    const { rerender } = render(<TxStoryView story={story({ history: [] })} entries={[]} actions={actions()} onChanged={() => {}} />);
    expect(screen.getByText(TX_STORY_NO_HISTORY)).toBeInTheDocument();
    expect(screen.getByText("No changes in the last 90 days.")).toBeInTheDocument();
    rerender(<TxStoryView story={story({ history: null, notes: ["Couldn't read the change log just now."] })} entries={[]} actions={actions()} onChanged={() => {}} />);
    expect(screen.queryByText('What happened')).toBeNull();
    expect(screen.getByText("Couldn't read the change log just now.")).toBeInTheDocument();
  });

  it('a change log read in part never says "No changes", and says why the list may be short', () => {
    const partial = buildTxStory({
      row: { activityId: 'act-1', note: 'SQ *BLUE_BOTTLE <b> · tx-1', absCents: 650, date: '2026-10-12', activityType: 'WITHDRAWAL', accountName: 'Checking' },
      feed: { sfinAccountId: 'sfin-1' }, partner: null, history: [], failed: ['changeLogPartial'], now: NOW,
    });
    render(<TxStoryView story={partial} entries={[]} actions={actions()} onChanged={() => {}} />);
    expect(screen.getByText('What happened')).toBeInTheDocument();
    expect(screen.queryByText(TX_STORY_NO_HISTORY)).toBeNull();
    expect(screen.getByText(TX_FACT_NOTES.changeLogPartial)).toBeInTheDocument();
  });

  it('a history line opens the change log’s own entry detail, with its Undo — disabled and busy while it runs', async () => {
    let finish!: (o: UndoOutcome) => void;
    const undo = vi.fn(() => new Promise<UndoOutcome>((resolve) => { finish = resolve; }));
    const onChanged = vi.fn();
    render(<TxStoryView story={story()} entries={[imported]} actions={actions({ undo })} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /Imported SQ \*BLUE_BOTTLE/ }));
    const detail = document.querySelector('.sfin-log-detail') as HTMLElement;
    expect(within(detail).getByText(/Automatic — the background sync/)).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'Undo' }));
    const busy = within(detail).getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    await act(async () => finish({ ok: true, message: "Undone — it's removed and won't be imported again.", needsSync: true }));
    expect(await within(detail).findByText(/Takes effect on the next sync\./)).toBeInTheDocument();
    expect(undo).toHaveBeenCalledWith(imported, [imported], 'undo');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe('TxStoryPanel', () => {
  const ok = (s = story()): AppStoryOutcome => ({ kind: 'ok', story: s, entries: [imported] });

  it('loads the story for its target', async () => {
    const load = vi.fn(async () => ok());
    render(<TxStoryPanel target={{ activityId: 'act-1', categoryName: 'Dining', filer: 'h' }} load={load} actions={actions()} />);
    expect(await screen.findByText('From your Checking bank feed.')).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith({ activityId: 'act-1', categoryName: 'Dining', filer: 'h' });
  });

  it('says so when the row cannot be read, or is gone', async () => {
    const { unmount } = render(<TxStoryPanel target={{ activityId: 'a' }} load={vi.fn(async () => ({ kind: 'unreachable' as const }))} actions={actions()} />);
    expect(await screen.findByText(TX_STORY_UNREACHABLE)).toBeInTheDocument();
    unmount();
    render(<TxStoryPanel target={{ activityId: 'a' }} load={vi.fn(async () => ({ kind: 'gone' as const }))} actions={actions()} />);
    expect(await screen.findByText(TX_STORY_GONE_APP)).toBeInTheDocument();
  });

  it('an unmount while loading, then a late answer, throws nothing', async () => {
    let resolve!: (o: AppStoryOutcome) => void;
    const load = vi.fn(() => new Promise<AppStoryOutcome>((r) => { resolve = r; }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = render(<TxStoryPanel target={{ activityId: 'act-1' }} load={load} actions={actions()} />);
    unmount();
    await act(async () => resolve(ok()));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('a different transaction never shows the old one’s story under its own gone result', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce({ kind: 'gone' });
    const { rerender } = render(<TxStoryPanel target={{ activityId: 'act-1' }} load={load} actions={actions()} />);
    expect(await screen.findByText('From your Checking bank feed.')).toBeInTheDocument();
    rerender(<TxStoryPanel target={{ activityId: 'act-2' }} load={load} actions={actions()} />);
    expect(await screen.findByText(TX_STORY_GONE_APP)).toBeInTheDocument();
    expect(screen.queryByText('From your Checking bank feed.')).toBeNull();
  });

  it('reads again after an Undo; a re-read that fails keeps the story and says so', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce({ kind: 'unreachable' })
      .mockResolvedValueOnce({ kind: 'gone' });
    const undo = vi.fn(async (): Promise<UndoOutcome> => ({ ok: true, message: 'Undone.', needsSync: false }));
    render(<TxStoryPanel target={{ activityId: 'act-1' }} load={load} actions={actions({ undo })} />);
    fireEvent.click(await screen.findByRole('button', { name: /Imported SQ \*BLUE_BOTTLE/ }));
    fireEvent.click(within(document.querySelector('.sfin-log-detail') as HTMLElement).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText(TX_STORY_REREAD_FAILED)).toBeInTheDocument();
    expect(screen.getByText('From your Checking bank feed.')).toBeInTheDocument();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});

describe('the stylesheet', () => {
  it('defines the story’s classes once each, at column 0', () => {
    render(React.createElement(ThemeStyles));
    const css = Array.from(document.head.querySelectorAll('style')).map((el) => el.textContent ?? '').join('\n');
    for (const cls of ['.sfin-why-card', '.sfin-why-story', '.sfin-why-line-btn', '.sfin-why-result', '.sfin-why-inline']) {
      expect(css.match(new RegExp(`^\\${cls} \\{`, 'gm'))).toHaveLength(1);
    }
  });
});
