import React from 'react';
import { Button, Disclosure } from './ui';
import type { UncategorizedRow } from '../../shared/uncategorized';

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    .format(cents / 100);
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
  if (rows.length === 0) return null;
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
            >
              Dismiss
            </Button>
          </div>
        ))}
        {(capped || onOpenActivities) && (
          <div className="sfin-uncat-undo">
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
