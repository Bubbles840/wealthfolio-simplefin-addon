import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import React from 'react';
import { UncategorizedList, useDismissals } from './UncategorizedList';
import type { DismissalLedger, UncategorizedRow } from '../../shared/uncategorized';

const row = (over: Partial<UncategorizedRow> = {}): UncategorizedRow => ({
  activityId: 'a', date: '2026-08-01', amountCents: 7000,
  description: 'Thankyou Points Redeemed', accountName: 'Citi Double Cash', ...over,
});

const base = {
  rows: [row()], total: 1, id: 'uncat', open: true,
  onToggle: vi.fn(), onDismiss: vi.fn(), justDismissed: null, onUndo: vi.fn(),
};

describe('UncategorizedList', () => {
  it('shows each transaction with what a person needs to recognise it', () => {
    render(<UncategorizedList {...base} />);
    expect(screen.getByText(/Thankyou Points Redeemed/)).toBeTruthy();
    expect(screen.getByText(/Citi Double Cash/)).toBeTruthy();
    expect(screen.getByText('$70.00')).toBeTruthy();
    expect(screen.getByText('2026-08-01')).toBeTruthy();
  });

  it('renders nothing at all when nothing needs a category', () => {
    const { container } = render(<UncategorizedList {...base} rows={[]} total={0} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing when there are no rows even if the count is non-zero', () => {
    // Version skew: a v1.10.0 companion publishes a count and no rows. Gating on
    // `total` would open a disclosure onto an empty panel; the tile alone carries
    // the number in that case.
    const { container } = render(<UncategorizedList {...base} rows={[]} total={3} />);
    expect(container.textContent).toBe('');
  });

  it('dismissing reports the id up rather than hiding locally', () => {
    // The parent owns the ledger and the count, so a component that hid its own
    // row would leave the tile disagreeing with the list.
    const onDismiss = vi.fn();
    render(<UncategorizedList {...base} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledWith('a');
  });

  it('offers undo after a dismissal, and reports that up too', () => {
    // Without this a misclick silently hides a transaction for 60 days.
    const onUndo = vi.fn();
    render(<UncategorizedList {...base} justDismissed="a" onUndo={onUndo} />);
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(onUndo).toHaveBeenCalled();
  });

  it('says when the list is shorter than the count, so a cap cannot mislead', () => {
    // The published list is capped; the total is not. Showing 50 rows under a
    // heading that says 63 without explanation would read as a bug.
    render(<UncategorizedList {...base} rows={[row(), row({ activityId: 'b' })]} total={63} />);
    expect(screen.getByText(/showing 2 of 63/i)).toBeTruthy();
  });

  it('summarises the count in its header', () => {
    render(<UncategorizedList {...base} rows={[row(), row({ activityId: 'b' })]} total={2} open={false} />);
    expect(screen.getByText(/2 need a category/i)).toBeTruthy();
  });

  it('offers a way to reach the page where a category can actually be set', () => {
    const onOpenActivities = vi.fn();
    render(<UncategorizedList {...base} onOpenActivities={onOpenActivities} />);
    fireEvent.click(screen.getByRole('button', { name: /Categorize in Wealthfolio/i }));
    expect(onOpenActivities).toHaveBeenCalled();
  });

  it('shows no such button when there is nowhere to send the user', () => {
    // A button that does nothing is worse than no button.
    render(<UncategorizedList {...base} />);
    expect(screen.queryByRole('button', { name: /Categorize in Wealthfolio/i })).toBeNull();
  });

  it('keeps the undo banner up even when dismissing empties the row list', () => {
    // Dismissing the ONLY visible row makes `rows` empty too. Gating purely on
    // `rows.length` (as the version-skew case does) would unmount the whole
    // disclosure right when the undo banner is most needed — there would be
    // nothing left to click "Dismiss" on again, and `window.confirm` doesn't
    // work in this sandbox, so undo IS the confirmation.
    render(<UncategorizedList {...base} rows={[]} total={0} justDismissed="a" />);
    expect(screen.getByText(/Dismissed\./i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /undo/i })).toBeTruthy();
  });
});

describe('useDismissals', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the undo banner on its own after ~6 seconds', () => {
    let ledger: DismissalLedger = {};
    const onChange = vi.fn((next: DismissalLedger) => { ledger = next; });
    const { result, rerender } = renderHook(
      ({ dismissals }) => useDismissals(dismissals, onChange),
      { initialProps: { dismissals: ledger } },
    );

    act(() => { result.current.dismiss('a'); });
    rerender({ dismissals: ledger });
    expect(result.current.justDismissed).toBe('a');

    act(() => { vi.advanceTimersByTime(5999); });
    rerender({ dismissals: ledger });
    expect(result.current.justDismissed).toBe('a');

    act(() => { vi.advanceTimersByTime(1); });
    rerender({ dismissals: ledger });
    expect(result.current.justDismissed).toBeNull();
    // The banner clearing itself is purely local UI state — it must not have
    // undone the dismissal or written to the ledger a second time.
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('a second dismissal inside the window resets the timer to the new row', () => {
    let ledger: DismissalLedger = {};
    const onChange = vi.fn((next: DismissalLedger) => { ledger = next; });
    const { result, rerender } = renderHook(
      ({ dismissals }) => useDismissals(dismissals, onChange),
      { initialProps: { dismissals: ledger } },
    );

    act(() => { result.current.dismiss('a'); });
    rerender({ dismissals: ledger });
    act(() => { vi.advanceTimersByTime(4000); });
    act(() => { result.current.dismiss('b'); });
    rerender({ dismissals: ledger });
    // The first timer would have fired at 6000ms; it must not clear the SECOND
    // row's banner early.
    act(() => { vi.advanceTimersByTime(2000); });
    rerender({ dismissals: ledger });
    expect(result.current.justDismissed).toBe('b');

    act(() => { vi.advanceTimersByTime(4000); });
    rerender({ dismissals: ledger });
    expect(result.current.justDismissed).toBeNull();
  });

  it('cancels the pending timer on unmount, so a dead component is never told to update', () => {
    const onChange = vi.fn();
    const onError = vi.fn();
    window.addEventListener('error', onError);
    const clearSpy = vi.spyOn(window, 'clearTimeout');

    const { result, unmount } = renderHook(() => useDismissals({}, onChange));
    act(() => { result.current.dismiss('a'); });
    // Cleanup runs synchronously as part of unmount — proves the pending
    // `window.setTimeout` was actually cancelled, not just that nothing
    // observable happened to crash the test.
    unmount();
    expect(clearSpy).toHaveBeenCalled();

    // Advancing past when the (now-cancelled) timer would have fired must
    // produce no error — no update reaching a dead component.
    act(() => { vi.advanceTimersByTime(6000); });
    expect(onError).not.toHaveBeenCalled();

    window.removeEventListener('error', onError);
    clearSpy.mockRestore();
  });
});
