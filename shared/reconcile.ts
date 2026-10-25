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
  /** The held security a dividend is booked on (shared/dividends.ts). Absent on
   *  every other row; when set, a stored row on another security is updated. */
  assetId?: string;
  /** A payback rule decided this row's type (W10): it applies to rows the sync
   *  CREATES only. Against a stored row, `changed()` ignores type and subtype and an
   *  update writes the stored ones back. */
  createOnly?: true;
  /** A cash money-in row that nothing decides (no rule, no payback flag) and the plain
   *  mapping calls a DEPOSIT. A STORED CREDIT/REIMBURSEMENT is then a payback somebody
   *  filed (or made by hand, or a rule made before it was undone): `changed()` leaves
   *  its type and subtype alone and an update writes them back, as for `createOnly`. */
  keepPayback?: true;
  /** A dividend row (shared/dividends.ts `isDividendRow`) that this run could not
   *  name a security for: the position was sold since, the holdings read failed,
   *  or the other writer isn't new enough yet. A STORED DIVIDEND on a security
   *  stays as it is: `changed()` leaves its type alone and an update writes the
   *  stored type and security back. */
  keepDividend?: true;
  /**
   * Mark the written row as needing the user's eye — Wealthfolio 3.8's
   * `needs_review`, which it surfaces on its own Activities screen.
   *
   * Set only where the sync had to GUESS a classification it cannot prove: an
   * unpaired transfer leg that ran out of time and was booked as ordinary
   * spending or income.
   *
   * Deliberately NOT compared by `changed()`. It is set on the transition, where
   * the type and the in-transit marker already differ so an update fires anyway;
   * and leaving it out of the comparison means a flag the user CLEARS in
   * Wealthfolio is never re-applied by a later sync — which would otherwise be
   * an unclearable flag, since the row keeps expiring on every run.
   */
  needsReview?: boolean;
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
  /** The stored fee in cents. Read by the legacy placeholder rewrite in
   *  sync-core only: every outflow placeholder written before v1.49 keeps its
   *  whole amount here (a `CREDIT` with `amount` 0), and nothing else the
   *  sync writes carries a fee. */
  feeCents?: number;
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

/**
 * One in-transit outflow placeholder, two shapes: a card's is a WITHDRAWAL
 * where Wealthfolio refuses TRANSFER_OUT on a card (3.8, 3.9) and a
 * TRANSFER_OUT where it takes one (3.10+, 1.62.0 U4). A writer that would
 * pick the other shape leaves the stored one as it is, so the add-on and the
 * companion never flip it back and forth. (A cash account's placeholder is a
 * TRANSFER_OUT on every version and an investment account's a WITHDRAWAL; this
 * test does not know the account type, so its scope covers cash too: a CASH
 * in-transit placeholder stored as WITHDRAWAL is no longer retyped to
 * TRANSFER_OUT unless something else about it changes — a deliberate departure
 * from d344c96 — and a hand-retyped cash placeholder is left alone. The sync keeps the stored shape on a real change too:
 * see "A held card placeholder keeps the shape" in sync-core.ts.)
 */
function sameType(row: ExistingRow, tx: FeedTx): boolean {
  if (row.type === tx.type) return true;
  const outflow = (t: string) => t === 'WITHDRAWAL' || t === 'TRANSFER_OUT';
  return !!tx.inTransit && isInTransitRow(row) && outflow(row.type) && outflow(tx.type);
}

/** An asset id that names a security, not cash: Wealthfolio's `is_cash_symbol`
 *  forms (`$CASH-USD`, `CASH_USD`, `CASH:USD`, …) are cash. */
function isSecurityAssetId(assetId: string | undefined): boolean {
  const id = assetId?.trim() ?? '';
  return id !== '' && !/^\$?CASH[-_:]/i.test(id);
}

/** A stored dividend on a security that a `keepDividend` tx leaves where it is. */
function keepsStoredDividend(row: ExistingRow, tx: FeedTx): boolean {
  return !!tx.keepDividend && row.type === 'DIVIDEND' && isSecurityAssetId(row.assetId);
}

/** Whether the stored row's own type and subtype stand: a `createOnly` tx never re-types a
 *  stored row, a `keepPayback` tx never re-types a stored payback, and a `keepDividend` tx
 *  never re-types a stored dividend on a security. */
function keepsStored(row: ExistingRow, tx: FeedTx): boolean {
  return !!tx.createOnly
    || (!!tx.keepPayback && row.type === 'CREDIT' && normSubtype(row.subtype) === 'REIMBURSEMENT')
    || keepsStoredDividend(row, tx);
}

function changed(row: ExistingRow, tx: FeedTx): boolean {
  const keeps = keepsStored(row, tx);
  return (
    row.absCents !== tx.absCents ||
    // A tx that keeps the stored row never changes its type; otherwise one
    // in-transit outflow in either shape is the same type (`sameType`).
    (!keeps && !sameType(row, tx)) ||
    row.date !== tx.date ||
    row.pending !== tx.pending ||
    (tx.assetId !== undefined && row.assetId !== tx.assetId) ||
    // Placeholder-ness is a real difference even when nothing else moved: a
    // non-CASH placeholder expires into the identical DEPOSIT/WITHDRAWAL, so
    // without this the row would keep its in-transit marker forever on a leg
    // that will never pair.
    // (A `createOnly` tx keeps the stored marker too: its plan is never in transit.)
    (!tx.createOnly && isInTransitRow(row) !== !!tx.inTransit) ||
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
    (!keeps && !!tx.subtype && normSubtype(row.subtype) !== normSubtype(tx.subtype))
  );
}

/** The update for a stored row: a tx that keeps it writes the stored type and subtype back
 *  (for `createOnly`, the stored in-transit marker; for `keepDividend`, the stored security,
 *  or the write would name `$CASH` and drop it). */
function updateTo(row: ExistingRow, tx: FeedTx): FeedTx {
  if (!keepsStored(row, tx)) return tx;
  const { subtype: _drop, inTransit: _t, ...rest } = tx;
  return {
    ...rest, type: row.type,
    ...(row.subtype ? { subtype: row.subtype } : {}),
    ...(keepsStoredDividend(row, tx) ? { assetId: row.assetId } : {}),
    ...(tx.createOnly ? (isInTransitRow(row) ? { inTransit: true as const } : {}) : (tx.inTransit ? { inTransit: true as const } : {})),
  };
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
      updates.push({ wfId: row.wfId, to: updateTo(row, tx) });
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
      updates.push({ wfId: row.wfId, to: updateTo(row, match) });
    } else {
      deleteIds.push(row.wfId);
    }
  }

  // Remove claimed creates (they became in-place updates of a pending row).
  const finalCreates = creates.filter((c) => !claimed.has(c.txId));

  return { creates: finalCreates, updates, deleteIds };
}
