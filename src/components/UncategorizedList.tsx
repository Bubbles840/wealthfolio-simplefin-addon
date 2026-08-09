import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Disclosure } from './ui';
import type { DismissalLedger, UncategorizedRow } from '../../shared/uncategorized';

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    .format(cents / 100);
}

/**
 * The dismiss/undo half of this feature: which row's "Dismissed." banner is
 * showing, and the ~6-second timer that clears it.
 *
 * Lives here, next to the only component that uses it, rather than inline in
 * `OverviewTab` — the timer needs a cleanup path that inline JSX handlers have
 * nowhere to put. `OverviewTab` unmounts on every tab switch (see `TabPanel` in
 * `SyncPage.tsx`), and a `window.setTimeout` left running past that fires
 * `setJustDismissed` on a dead component. The effect below cancels it on
 * unmount, and `dismiss` cancels any PREVIOUS pending timer so a second
 * dismissal inside the same 6-second window doesn't have an earlier one clear
 * its banner out from under it.
 *
 * The ledger itself is NOT owned here — `onChange` receives the next ledger and
 * the caller (the page shell) is the one that persists it, because state that
 * must survive a tab switch cannot live in a component that unmounts on one.
 */
export function useDismissals(
  dismissals: DismissalLedger,
  onChange: (next: DismissalLedger) => void,
): { justDismissed: string | null; dismiss: (id: string) => void; undo: () => void } {
  const [justDismissed, setJustDismissed] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Belt-and-suspenders against the dead-component case: even if a timer somehow
  // outlives `clearTimer` calls elsewhere, it's cancelled here on unmount.
  useEffect(() => clearTimer, [clearTimer]);

  const dismiss = useCallback((id: string) => {
    onChange({ ...dismissals, [id]: new Date().toISOString() });
    clearTimer();
    setJustDismissed(id);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setJustDismissed((cur) => (cur === id ? null : cur));
    }, 6000);
  }, [dismissals, onChange, clearTimer]);

  const undo = useCallback(() => {
    if (!justDismissed) return;
    const next = { ...dismissals };
    delete next[justDismissed];
    onChange(next);
    setJustDismissed(null);
    clearTimer();
  }, [dismissals, onChange, justDismissed, clearTimer]);

  return { justDismissed, dismiss, undo };
}

/**
 * The transactions behind the "Needs a category" tile, and a way to stop caring
 * about one.
 *
 * Purely presentational: the parent owns the ledger, the optimistic count and the
 * undo window. A row that hid itself would leave the tile disagreeing with the
 * list — the same class of split this feature exists to close.
 *
 * Its own file rather than more of OverviewTab, which is already at the 400-line
 * size target.
 */
export function UncategorizedList({
  rows, total, id, open, onToggle, onDismiss, justDismissed, onUndo, onOpenActivities,
}: {
  rows: UncategorizedRow[];
  total: number;
  id: string;
  open: boolean;
  onToggle: () => void;
  onDismiss: (activityId: string) => void;
  justDismissed: string | null;
  onUndo: () => void;
  /** Opens Wealthfolio's Activities page, where a category can actually be set.
   *  Optional so the component stays renderable without a host (its tests) — and
   *  absent means the affordance is simply not shown, never a dead button. */
  onOpenActivities?: () => void;
}) {
  // Gated on ROWS, not on `total`: a v1.10.0 companion publishes a count with no
  // rows, and a disclosure that opens onto nothing is worse than no disclosure.
  //
  // EXCEPT while an undo window is open: dismissing the last visible row makes
  // `rows` empty too, and unmounting right then would take the undo banner down
  // with it — the one dismissal that most needs to be undoable (there is nothing
  // left to click "Dismiss" on again) would become silently permanent. `window.
  // confirm` doesn't work in this sandbox, so the undo affordance IS the
  // confirmation; it cannot be allowed to vanish along with the row it's for.
  if (rows.length === 0 && !justDismissed) return null;
  const capped = rows.length < total;
  return (
    <div className="sfin-disc-inset">
      <Disclosure
        id={id}
        variant="inline"
        title={`${total} need${total === 1 ? 's' : ''} a category`}
        open={open}
        onToggle={onToggle}
      >
        {justDismissed && (
          <div className="sfin-uncat-undo" role="status">
            <span className="sfin-subtle">Dismissed.</span>
            <Button variant="ghost" onClick={onUndo}>Undo</Button>
          </div>
        )}
        {rows.map((r) => (
          <div className="sfin-uncat-row" key={r.activityId}>
            <span className="sfin-uncat-when">{r.date}</span>
            <span className="sfin-uncat-what">
              {r.description}
              <span className="sfin-subtle"> · {r.accountName}</span>
            </span>
            <span className="sfin-uncat-amt">{money(r.amountCents)}</span>
            <Button
              variant="ghost"
              onClick={() => onDismiss(r.activityId)}
              title="Stop counting this transaction as needing a category"
              // Nine rows otherwise announce nine identical "Dismiss, button"s to
              // assistive tech. Visible text stays "Dismiss" — only the accessible
              // name carries the distinguishing detail.
              aria-label={`Dismiss ${r.description}, ${money(r.amountCents)} on ${r.date}`}
            >
              Dismiss
            </Button>
          </div>
        ))}
        {(capped || onOpenActivities) && (
          <div className="sfin-uncat-foot">
            {capped && (
              <span className="sfin-subtle">
                Showing {rows.length} of {total}. Categorize or dismiss some to see the rest.
              </span>
            )}
            {onOpenActivities && (
              <Button variant="ghost" onClick={onOpenActivities}>Categorize in Wealthfolio</Button>
            )}
          </div>
        )}
      </Disclosure>
    </div>
  );
}
