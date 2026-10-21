/**
 * shared/relink.ts
 *
 * A SimpleFin connection that is removed and added again comes back with new
 * ids for every account and every transaction. Mapped again to the same
 * Wealthfolio account, the new account's download overlaps what is already
 * stored, but nothing matches by transaction id, so the first sync after the
 * reconnect imports the overlap a second time.
 *
 * Pure: what is a re-link, and which stored rows stand for which new
 * transactions. sync-core does the reading and writing, and imports this module,
 * so nothing here may import sync-core.
 */

/** One Wealthfolio account fed by a new SimpleFin account id that replaced old ones. */
export interface Relink {
  wfAccountId: string;
  /** The SimpleFin account in this run's download. */
  newId: string;
  /** Mapped to the same Wealthfolio account, and absent from the download. */
  oldIds: string[];
}

/**
 * The re-links in this run: a Wealthfolio account with two or more mapped
 * SimpleFin ids, exactly one of which is in the download. Two in the download
 * (two feeds deliberately mapped to one account) is not a re-link, and neither
 * is one id absent with no other present (a feed that is down).
 */
export function detectRelinks(mapping: Readonly<Record<string, string>>, feedIds: ReadonlySet<string>): Relink[] {
  const byWf = new Map<string, string[]>();
  for (const [sfinId, wfId] of Object.entries(mapping)) {
    if (!wfId) continue;
    byWf.set(wfId, [...(byWf.get(wfId) ?? []), sfinId]);
  }
  const out: Relink[] = [];
  for (const [wfAccountId, ids] of byWf) {
    if (ids.length < 2) continue;
    const present = ids.filter((id) => feedIds.has(id));
    if (present.length !== 1) continue;
    out.push({ wfAccountId, newId: present[0], oldIds: ids.filter((id) => id !== present[0]).sort() });
  }
  return out;
}

/** A stored row, as much of it as the plan reads. */
export interface RelinkRow {
  wfId: string;
  txId: string;
  date: string;
  absCents: number;
  pending: boolean;
  /** The bank's description, as the stored note carries it. */
  description: string;
  /** One of the sync's own bookkeeping rows (a starting balance or adjustment). */
  bookkeeping: boolean;
  sourceGroupId?: string | null;
}

/** A transaction in the new account's download. */
export interface RelinkTx {
  txId: string;
  date: string;
  absCents: number;
  description: string;
  pending: boolean;
}

export interface RelinkPlan {
  /** Stored rows from the old connection that stand for a new transaction with
   *  no row of its own: read under the new id, so the sync updates them instead
   *  of importing the transaction again. Nothing is written for these. */
  adopt: Map<string, string>;
  /** Both copies are stored: the old row and one imported under the new id. */
  duplicates: Array<{ keep: RelinkRow; remove: RelinkRow; txId: string }>;
  /** Copies left alone: both linked to a transfer, or more than one candidate. */
  leftAlone: number;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase();

/**
 * Which stored rows from the old connection are the new download's transactions.
 *
 * A stored row is from the old connection when its transaction id is one no
 * account reported on this run (`liveTxIds`) and it is not the sync's own
 * bookkeeping. It is a new transaction when they share the day, the amount, and
 * the bank's description. The stored description may carry notes the sync added
 * after the bank's text, so a row whose description starts with the bank's text
 * also counts, as long as it is the only candidate. Pending rows are left to the
 * reconcile planner, which already moves a pending row onto its posted copy.
 *
 * Only a one-to-one match is taken: several identical rows on one day pair off
 * when the counts agree, and anything else is left as it is. A wrong match would
 * hide a real transaction.
 *
 * Of two stored copies the old row is kept: it carries what the person did to
 * it (category, notes, transfer link). A new copy that is linked when the old
 * row is not is kept instead; both linked is left alone.
 */
export function planRelinkAdoption(
  existing: readonly RelinkRow[],
  feed: readonly RelinkTx[],
  liveTxIds: ReadonlySet<string>,
): RelinkPlan {
  const plan: RelinkPlan = { adopt: new Map(), duplicates: [], leftAlone: 0 };
  const stale = existing.filter((r) => !liveTxIds.has(r.txId) && !r.pending && !r.bookkeeping);
  const storedByTxId = new Map<string, RelinkRow>();
  for (const r of existing) if (liveTxIds.has(r.txId)) storedByTxId.set(r.txId, r);
  const posted = feed.filter((t) => !t.pending);

  const pairs: Array<[RelinkRow, RelinkTx]> = [];
  const taken = new Set<string>();
  // Exact descriptions first, paired off when the counts agree.
  const key = (date: string, cents: number, desc: string) => `${date}|${cents}|${norm(desc)}`;
  const staleByKey = new Map<string, RelinkRow[]>();
  for (const r of stale) {
    const k = key(r.date, r.absCents, r.description);
    staleByKey.set(k, [...(staleByKey.get(k) ?? []), r]);
  }
  const feedByKey = new Map<string, RelinkTx[]>();
  for (const t of posted) {
    const k = key(t.date, t.absCents, t.description);
    feedByKey.set(k, [...(feedByKey.get(k) ?? []), t]);
  }
  for (const [k, txs] of feedByKey) {
    const rows = staleByKey.get(k);
    if (!rows) continue;
    if (rows.length !== txs.length) { plan.leftAlone += txs.length; for (const t of txs) taken.add(t.txId); continue; }
    const byId = <T extends { txId: string }>(a: T, b: T) => (a.txId < b.txId ? -1 : a.txId > b.txId ? 1 : 0);
    const rs = [...rows].sort((a, b) => (a.wfId < b.wfId ? -1 : 1)), ts = [...txs].sort(byId);
    rs.forEach((r, i) => { pairs.push([r, ts[i]]); taken.add(r.wfId); taken.add(ts[i].txId); });
  }
  // Then a stored description that adds notes after the bank's text: one candidate each way.
  const restStale = stale.filter((r) => !taken.has(r.wfId));
  const restFeed = posted.filter((t) => !taken.has(t.txId));
  const extends_ = (r: RelinkRow, t: RelinkTx) => {
    const d = norm(r.description), b = norm(t.description);
    return r.date === t.date && r.absCents === t.absCents && b.length > 0 && d.startsWith(`${b} · `);
  };
  for (const t of restFeed) {
    const rows = restStale.filter((r) => extends_(r, t));
    if (rows.length !== 1) continue;
    if (restFeed.filter((u) => extends_(rows[0], u)).length !== 1) continue;
    pairs.push([rows[0], t]);
  }

  for (const [row, tx] of pairs) {
    const copy = storedByTxId.get(tx.txId);
    if (!copy) { plan.adopt.set(row.wfId, tx.txId); continue; }
    const rowLinked = !!row.sourceGroupId, copyLinked = !!copy.sourceGroupId;
    if (rowLinked && copyLinked) { plan.leftAlone++; continue; }
    plan.duplicates.push(copyLinked && !rowLinked
      ? { keep: copy, remove: row, txId: tx.txId }
      : { keep: row, remove: copy, txId: tx.txId });
  }
  return plan;
}
