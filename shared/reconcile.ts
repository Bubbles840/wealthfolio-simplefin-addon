/**
 * Marks a spending-neutral placeholder standing in for a transfer leg whose
 * other side hasn't posted yet. A PREFIX, deliberately: the `… · <txId>` suffix
 * is what `txIdFromComment` reads, so nothing may follow it.
 *
 * Defined HERE, in the module that imports nothing, and re-exported from
 * sync-core.ts (which owns writing it) — `changed()` has to recognise the marker
 * on a stored row, and importing it the other way round would make a cycle.
 */
export const IN_TRANSIT_COMMENT_PREFIX = '↔️ In-transit transfer · ';

export interface FeedTx {
  txId: string;
  wfAccountId: string;
  absCents: number;
  type: string;
  date: string;      // YYYY-MM-DD
  pending: boolean;
  /** Cents of `absCents` to book as `fee` instead of `amount` — used only by
   *  the in-transit transfer placeholder (see sync-core.ts), which needs the
   *  same amount/fee split neutralAdjustmentFields uses for balance plugs. */
  feeCents?: number;
  /** True when this row is a spending-neutral placeholder for a transfer leg
   *  whose other side hasn't posted yet. Written as the comment prefix, and
   *  compared by `changed()` — on a non-CASH account the placeholder and the
   *  expired row are the SAME DEPOSIT/WITHDRAWAL, so the marker is the only
   *  thing that differs when such a placeholder times out. */
  inTransit?: boolean;
  /** The subtype a rule assigned to this transaction (e.g. `REIMBURSEMENT`).
   *  Omitted — not `null` — when no rule set one; see `normSubtype` for why
   *  that distinction matters to `changed()`. */
  subtype?: string;
}

export interface ExistingRow {
  wfId: string;
  wfAccountId: string;
  txId: string;
  absCents: number;
  type: string;
  date: string;      // YYYY-MM-DD
  pending: boolean;
  /** Resolved asset on the stored row. A cash-transfer leg must have NO asset to
   *  book cash and to stay pairable; legs imported before that was understood
   *  carry the phantom "$CASH" security here and need re-creating. */
  assetId?: string;
  /** The row's stored comment, kept verbatim so a re-created leg preserves its
   *  description even when the transaction is outside this run's fetch window
   *  (where the SimpleFin description is no longer available to rebuild it). */
  comment?: string;
  /** Resolved subtype on the stored row. The host adapter normalizes an
   *  absent subtype to `null` (never leaves it `undefined`), but older rows
   *  written before this field existed may read back `''`; see `normSubtype`. */
  subtype?: string | null;
}

export interface ReconcilePlan {
  creates: FeedTx[];
  updates: Array<{ wfId: string; to: FeedTx }>;
  deleteIds: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / DAY_MS;
}

/**
 * What an existing row's `amount` holds once this feed tx is written: the fee
 * side of a split is booked as `fee`, not `amount`, so it is NOT part of the
 * stored amount an `ExistingRow` reports back. Comparing raw `absCents` against
 * a stored fee-split row would find a difference on every single sync and
 * re-update the row forever (a host reads back no fee at all).
 */
function bookedCents(tx: FeedTx): number {
  return tx.absCents - (tx.feeCents ?? 0);
}

/** Whether the STORED row is already marked as an in-transit placeholder. The
 *  comment is optional, and a row without one is not a placeholder. */
function isInTransitRow(row: ExistingRow): boolean {
  return (row.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX);
}

/** `undefined` (feed carries no subtype), `null` (host reported none) and `''`
 *  are all "no subtype". Comparing raw values would report a difference on every
 *  row that never had one, and `changed()` is the write trigger — that would
 *  rewrite every activity on every sync, forever. */
function normSubtype(v: string | null | undefined): string {
  return (v ?? '').trim().toUpperCase();
}

function changed(row: ExistingRow, tx: FeedTx): boolean {
  return (
    row.absCents !== bookedCents(tx) ||
    row.type !== tx.type ||
    row.date !== tx.date ||
    row.pending !== tx.pending ||
    // Placeholder-ness is a real difference even when nothing else moved: a
    // non-CASH placeholder expires into the identical DEPOSIT/WITHDRAWAL, so
    // without this the row would keep its in-transit marker forever on a leg
    // that will never pair.
    isInTransitRow(row) !== !!tx.inTransit ||
    // Subtype only ever gets ADDED here, never removed. The write path omits
    // the `subtype` key entirely whenever the feed has none (see
    // toActivityCreate in sync-core.ts) — it deliberately never sends `''`,
    // because an explicit empty string is indistinguishable from a genuine
    // instruction to clear a subtype the user (or Wealthfolio) set by hand.
    // If this compared symmetrically, a row whose rule stopped assigning a
    // subtype would look "changed" forever: the update that gets issued can
    // never actually clear the stored value, so the row differs again next
    // sync, and the one issued before it, and so on — an identical no-op
    // update, every sync, forever. The accepted trade (the user's call):
    // removing a rule's subtype does not reach rows already imported; those
    // get cleared by hand in Wealthfolio.
    (!!tx.subtype && normSubtype(row.subtype) !== normSubtype(tx.subtype))
  );
}

/**
 * Decide create / update-in-place / delete for a sync run.
 *
 * - feed tx with no existing row (by tx id) -> create.
 * - feed tx with an existing row that changed -> update in place (same wfId).
 * - existing row marked pending, absent from the feed:
 *     - if an unmatched feed CREATE in the same account has an amount within
 *       epsilon and a date within the window, treat it as the same transaction
 *       that posted under a new id: update the pending row in place to the
 *       posted values (drops that create). Preserves the activity id/category.
 *     - otherwise the pending genuinely dropped off -> delete.
 * - existing posted row absent from the feed (aged out) -> untouched.
 */
export function planReconciliation(
  feed: FeedTx[],
  existing: ExistingRow[],
  opts: { amountEpsilonCents?: number; dateWindowDays?: number } = {},
): ReconcilePlan {
  const epsilon = opts.amountEpsilonCents ?? 0;
  const window = opts.dateWindowDays ?? 3;

  const existingByTxId = new Map(existing.map((r) => [r.txId, r]));
  const feedTxIds = new Set(feed.map((t) => t.txId));

  const creates: FeedTx[] = [];
  const updates: Array<{ wfId: string; to: FeedTx }> = [];
  const deleteIds: string[] = [];

  // Pass 1: creates and same-id updates.
  for (const tx of feed) {
    const row = existingByTxId.get(tx.txId);
    if (!row) {
      creates.push(tx);
    } else if (changed(row, tx)) {
      updates.push({ wfId: row.wfId, to: tx });
    }
  }

  // Pass 2: vanished pending -> match to an unmatched create, else delete.
  // A create is "available" for matching until claimed here.
  const claimed = new Set<string>();
  for (const row of existing) {
    if (!row.pending || feedTxIds.has(row.txId)) continue; // still present or not pending
    const match = creates.find(
      (c) =>
        !claimed.has(c.txId) &&
        c.wfAccountId === row.wfAccountId &&
        Math.abs(bookedCents(c) - row.absCents) <= epsilon &&
        daysBetween(c.date, row.date) <= window,
    );
    if (match) {
      claimed.add(match.txId);
      updates.push({ wfId: row.wfId, to: match });
    } else {
      deleteIds.push(row.wfId);
    }
  }

  // Remove claimed creates (they became in-place updates of a pending row).
  const finalCreates = creates.filter((c) => !claimed.has(c.txId));

  return { creates: finalCreates, updates, deleteIds };
}
