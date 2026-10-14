/**
 * shared/payback-row.ts
 *
 * A row as a payback reads it, and the one write that re-types it (1.62.0,
 * W6–W7) — shared by the planner (shared/payback.ts) and by the change log's
 * Undo and Redo (shared/change-undo.ts), which must not import the planner:
 * the planner reaches the change log's runner through the fixes' reader. Pure.
 */
import { REIMBURSEMENT_SUBTYPE } from './cash-flow-bucket.js';
import type { FixRow } from './fix-row.js';
import type { ActivityWrite } from './sync-host.js';

/** The fixes' row (shared/fix-row.ts), plus the stored instant exactly as the
 *  host reported it. */
export interface PaybackRow extends FixRow {
  /** `2026-10-09T12:00:00Z`, `2026-10-09T00:00:00+00:00`, or a bare day from a
   *  host that sends one: written back unchanged on a retype. */
  instant: string;
}

/** Already a payback: a CREDIT marked REIMBURSEMENT (any case, as Wealthfolio
 *  canonicalizes it). */
export const isPaybackRow = (row: Pick<FixRow, 'type' | 'subtype'>): boolean =>
  row.type === 'CREDIT' && (row.subtype ?? '').trim().toUpperCase() === REIMBURSEMENT_SUBTYPE;

/**
 * The row re-typed, as the bulk endpoint's update: the same account, date
 * (the stored instant), amount, currency and note, the cash asset by symbol
 * (as the sync writes every non-transfer row), and `subtype` stated — an
 * explicit `''` clears it (Wealthfolio 3.8–3.10 stores none for an empty
 * subtype on an update; an omitted one is kept). Fee, metadata and the review
 * flag are left out, so they stay as stored.
 */
export function paybackRetype(row: PaybackRow, activityType: string, subtype: string): ActivityWrite {
  return {
    id: row.id,
    accountId: row.accountId,
    activityType,
    activityDate: row.instant,
    symbol: { symbol: `$CASH-${row.currency}` },
    amount: row.absCents / 100,
    currency: row.currency,
    comment: row.notes,
    subtype,
  };
}
