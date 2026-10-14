import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { buildTxStory } from '../../shared/tx-story';
import { REMOVE_CHANGED, REMOVE_CONFIRM, REMOVE_DONE, REMOVE_NO_UNDO, REMOVE_UNREACHABLE, removeUnsure, type RemoveOutcome } from '../../shared/tx-remove';
import { TxStoryView, type TxStoryActions } from './TxStory';

const EMOJI = /\p{Extended_Pictographic}/u;
const NOW = new Date('2026-10-14T15:00:00Z');
const story = buildTxStory({
  now: NOW,
  row: { activityId: 'dup-1', note: 'MOBILE DEPOSIT · TRN-600', absCents: 60000, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking' },
  feed: { sfinAccountId: 'sfin-chk' }, partner: null, history: [],
});
const REMOVAL = { activityId: 'dup-1', fingerprint: 'abcd1234' };
const view = (remove?: TxStoryActions['remove'], onChanged = vi.fn(), removal: typeof REMOVAL | null = REMOVAL) =>
  render(<TxStoryView story={story} entries={[]} actions={{ companionVersion: null, remove }} onChanged={onChanged} removal={removal ?? undefined} />);

describe('Remove for good… in the app', () => {
  it('is offered only with a remover and a row that qualifies', () => {
    view(vi.fn());
    expect(screen.getByRole('button', { name: 'Remove for good…' })).toBeInTheDocument();
  });

  it('is not offered without a remover, or for a row that does not qualify', () => {
    const { unmount } = view(undefined);
    expect(screen.queryByRole('button', { name: 'Remove for good…' })).toBeNull();
    unmount();
    view(vi.fn(), vi.fn(), null);
    expect(screen.queryByRole('button', { name: 'Remove for good…' })).toBeNull();
  });

  it('the first click explains in exact words; Cancel goes back; nothing is removed', () => {
    const remove = vi.fn();
    view(remove);
    fireEvent.click(screen.getByRole('button', { name: 'Remove for good…' }));
    expect(screen.getByText(REMOVE_CONFIRM)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(REMOVE_CONFIRM)).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove for good…' })).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
  });

  it('Remove acts once, busy while it runs, then says so and leaves nothing to click', async () => {
    let finish!: (o: RemoveOutcome) => void;
    const remove = vi.fn(() => new Promise<RemoveOutcome>((r) => { finish = r; }));
    const onChanged = vi.fn();
    const { container } = view(remove, onChanged);
    fireEvent.click(screen.getByRole('button', { name: 'Remove for good…' }));
    const go = screen.getByRole('button', { name: 'Remove' });
    fireEvent.click(go);
    fireEvent.click(go);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('dup-1', 'abcd1234');
    expect(go).toBeDisabled();
    expect(go).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await act(async () => { finish({ ok: true, message: REMOVE_DONE }); });
    expect(screen.getByText(REMOVE_DONE)).toBeInTheDocument();
    expect(container.querySelectorAll('.sfin-why-remove button')).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
    expect(EMOJI.test(container.textContent ?? '')).toBe(false);
  });

  it('a refusal is said, the story is read again, and it can be tried again', async () => {
    const onChanged = vi.fn();
    view(vi.fn(async () => ({ ok: false, message: REMOVE_CHANGED })), onChanged);
    fireEvent.click(screen.getByRole('button', { name: 'Remove for good…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(REMOVE_CHANGED)).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Remove for good…' })).toBeInTheDocument();
  });

  it('a remover that throws says Wealthfolio could not be reached', async () => {
    view(vi.fn(async () => { throw new Error('offline'); }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove for good…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(REMOVE_UNREACHABLE)).toBeInTheDocument();
  });

  it('says a removal with no Undo, and leaves nothing to click', async () => {
    const onChanged = vi.fn();
    const { container } = view(vi.fn(async () => ({ ok: true, message: REMOVE_NO_UNDO })), onChanged);
    fireEvent.click(screen.getByRole('button', { name: 'Remove for good…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(REMOVE_NO_UNDO)).toBeInTheDocument();
    expect(container.querySelectorAll('.sfin-why-remove button')).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('says an unsure removal, naming the row', async () => {
    const msg = removeUnsure('offline', 'PNC Checking, 2026-10-09, $600.00, MOBILE DEPOSIT · TRN-600');
    view(vi.fn(async () => ({ ok: false, message: msg })));
    fireEvent.click(screen.getByRole('button', { name: 'Remove for good…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(msg)).toBeInTheDocument();
    expect(msg).toContain('TRN-600');
  });

  it('sets no state after the story is gone: a late refusal does not read the story again', async () => {
    let finish!: (o: RemoveOutcome) => void;
    const remove = vi.fn(() => new Promise<RemoveOutcome>((r) => { finish = r; }));
    const onChanged = vi.fn();
    const { unmount } = view(remove, onChanged);
    fireEvent.click(screen.getByRole('button', { name: 'Remove for good…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    unmount();
    await act(async () => { finish({ ok: false, message: REMOVE_CHANGED }); });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('Cancel is busy-marked while Remove runs', async () => {
    let finish!: (o: RemoveOutcome) => void;
    view(vi.fn(() => new Promise<RemoveOutcome>((r) => { finish = r; })));
    fireEvent.click(screen.getByRole('button', { name: 'Remove for good…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('aria-busy', 'true');
    await act(async () => { finish({ ok: true, message: REMOVE_DONE }); });
  });

  it('moves focus to Remove on confirm and back to the action on Cancel', () => {
    view(vi.fn());
    fireEvent.click(screen.getByRole('button', { name: 'Remove for good…' }));
    expect(screen.getByRole('button', { name: 'Remove' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Remove for good…' })).toHaveFocus();
  });

  it('keeps a refusal on screen when the re-read story no longer offers Remove', async () => {
    const remove = vi.fn(async () => ({ ok: false, message: REMOVE_CHANGED }));
    const props = { story, entries: [], actions: { companionVersion: null, remove } };
    const { rerender } = render(<TxStoryView {...props} onChanged={() => {}} removal={REMOVAL} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove for good…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(REMOVE_CHANGED)).toBeInTheDocument();
    // The panel's re-read: same view, now without a removal.
    rerender(<TxStoryView {...props} onChanged={() => {}} removal={undefined} />);
    expect(screen.getByText(REMOVE_CHANGED)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove for good…' })).toBeNull();
    expect(screen.getByText(REMOVE_CHANGED).closest('[role="status"]')).not.toBeNull();
  });
});
