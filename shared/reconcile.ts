export interface FeedTx {
  txId: string;
  wfAccountId: string;
  absCents: number;
  type: string;
  date: string;      // YYYY-MM-DD
  pending: boolean;
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

function changed(row: ExistingRow, tx: FeedTx): boolean {
  return (
    row.absCents !== tx.absCents ||
    row.type !== tx.type ||
    row.date !== tx.date ||
    row.pending !== tx.pending
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
        Math.abs(c.absCents - row.absCents) <= epsilon &&
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
