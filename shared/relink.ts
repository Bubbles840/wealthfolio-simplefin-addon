/**
 * shared/relink.ts
 *
 * A SimpleFin connection that is removed and added again comes back with new
 * ids for every account and every transaction. Mapped again to the same
 * Wealthfolio account, the new account's download overlaps what is already
 * stored, but nothing matches by transaction id, so the first sync after the
 * reconnect imports the overlap a second time.
 *
 * One download cannot tell a reconnect apart from two feeds mapped to one
 * account on purpose, one of them missing for a run (a SimpleFin error). So the
 * sync acts only on a re-link the PERSON confirmed (`ConfirmedRelink`, asked in
 * the account mapping when the shape appears); the shape alone (`detectRelinks`)
 * is only ever a question. A confirmed re-link is remembered: its old ids stay
 * retired even if one reports again.
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
  /** Mapped to the same Wealthfolio account; absent from the download when
   *  detected, retired once confirmed. */
  oldIds: string[];
}

/**
 * The re-link SHAPE in this download: a Wealthfolio account with two or more
 * mapped SimpleFin ids, exactly one of which is in the download. Two in the
 * download (two feeds deliberately mapped to one account) is not one, and
 * neither is one id absent with no other present (a feed that is down). The
 * shape is only a question for the person: a merged account whose other feed is
 * missing for a run looks exactly the same.
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

export const RELINKS_SECRET_KEY = 'relinks';

/** What the person said about re-link shapes: confirmed ones the sync acts
 *  on, and declined ones (`declineKey`) the mapping no longer asks about. */
export interface RelinkDecisions {
  confirmed: Relink[];
  declined: string[];
}

export const emptyRelinkDecisions = (): RelinkDecisions => ({ confirmed: [], declined: [] });

/** The question a shape asks, as a stable key: account, new id, old ids. */
export const declineKey = (r: Relink): string => [r.wfAccountId, r.newId, ...[...r.oldIds].sort()].join('|');

/** The stored decisions, dropping anything malformed. Absent or corrupt is none. */
export function parseRelinkDecisions(raw: string | null | undefined): RelinkDecisions {
  if (!raw) return emptyRelinkDecisions();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyRelinkDecisions();
  }
  if (!parsed || typeof parsed !== 'object') return emptyRelinkDecisions();
  const doc = parsed as { confirmed?: unknown; declined?: unknown };
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const confirmed = (Array.isArray(doc.confirmed) ? doc.confirmed : [])
    .filter((r): r is Relink => !!r && str(r.wfAccountId) && str(r.newId)
      && Array.isArray(r.oldIds) && r.oldIds.length > 0 && r.oldIds.every(str) && !r.oldIds.includes(r.newId))
    .map((r) => ({ wfAccountId: r.wfAccountId, newId: r.newId, oldIds: [...r.oldIds].sort() }));
  const declined = (Array.isArray(doc.declined) ? doc.declined : []).filter(str);
  return { confirmed, declined };
}

export type ParsedRelinkDecisions = { kind: 'absent' } | { kind: 'corrupt' } | { kind: 'ok'; decisions: RelinkDecisions };

/** The stored decisions with corrupt told apart from absent, for a writer: a
 *  document with anything it cannot read must not be saved over, or the
 *  answers it did not understand are lost. The sync keeps the lenient read. */
export function parseRelinkDecisionsStrict(raw: string | null | undefined): ParsedRelinkDecisions {
  if (raw === null || raw === undefined || raw.trim() === '') return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'corrupt' };
  const doc = parsed as { confirmed?: unknown; declined?: unknown };
  if (!Array.isArray(doc.confirmed ?? []) || !Array.isArray(doc.declined ?? [])) return { kind: 'corrupt' };
  const decisions = parseRelinkDecisions(raw);
  const given = ((doc.confirmed as unknown[] | undefined) ?? []).length + ((doc.declined as unknown[] | undefined) ?? []).length;
  if (decisions.confirmed.length + decisions.declined.length !== given) return { kind: 'corrupt' };
  return { kind: 'ok', decisions };
}

export class RelinkDecisionsUnreadableError extends Error {
  constructor() {
    super("Your answers about reconnected accounts can't be read, so nothing was changed.");
    this.name = 'RelinkDecisionsUnreadableError';
  }
}

/**
 * The confirmed re-links in force: the new id still feeds the same Wealthfolio
 * account. Their old ids are retired whatever the download holds: one that
 * reports again (the new connection was added before the old one was removed),
 * or reports while the new one misses a run, would import the overlap again.
 * Matching and removing copies needs the new id's own download, so it happens
 * only on a run that has it.
 */
export function activeRelinks(
  confirmed: readonly Relink[],
  mapping: Readonly<Record<string, string>>,
): Relink[] {
  return confirmed.filter((r) => mapping[r.newId] === r.wfAccountId);
}

/**
 * The old ids the confirmed re-links in force retire: each only while it is
 * still mapped to its re-link's Wealthfolio account, or unmapped and not linked
 * to a loan. An old id the person has since mapped elsewhere, or linked to a
 * loan, is a feed of its own again (a Yes given by mistake), so it is not
 * dropped from the download. Shared by the sync and the held-transfer judge.
 */
export function retiredIds(
  relinks: readonly Relink[],
  mapping: Readonly<Record<string, string>>,
  loanLinks: Readonly<Record<string, string>> = {},
): Set<string> {
  const out = new Set<string>();
  for (const r of relinks) {
    for (const id of r.oldIds) {
      if (mapping[id] === r.wfAccountId || (!mapping[id] && !loanLinks[id])) out.add(id);
    }
  }
  return out;
}

/**
 * Where each retired id's account lives now: the id that replaced it, followed
 * through every later re-link while that id is itself retired (A→B, then B→C,
 * reaches C). An id retired into two accounts reaches both. Built on
 * `retiredIds`, so it agrees with what the sync drops. `relinks`: the ones in
 * force (`activeRelinks`).
 */
export function relinkSuccessors(
  relinks: readonly Relink[],
  mapping: Readonly<Record<string, string>>,
  loanLinks: Readonly<Record<string, string>> = {},
): Map<string, Set<string>> {
  const retired = retiredIds(relinks, mapping, loanLinks);
  const next = new Map<string, string[]>();
  for (const r of relinks) {
    for (const old of r.oldIds) if (retired.has(old)) next.set(old, [...(next.get(old) ?? []), r.newId]);
  }
  const out = new Map<string, Set<string>>();
  for (const start of next.keys()) {
    const finals = new Set<string>();
    const seen = new Set([start]);
    const stack = [...next.get(start)!];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const more = next.get(id);
      if (more) stack.push(...more);
      else finals.add(id);
    }
    if (finals.size > 0) out.set(start, finals);
  }
  return out;
}

/** Whether a No covers this one old id. A key names one old id since the
 *  question is asked per id; an older key naming several covers each of them. */
export function isDeclined(declined: readonly string[], q: Relink): boolean {
  return declined.some((k) => {
    const [wf, newId, ...olds] = k.split('|');
    return wf === q.wfAccountId && newId === q.newId && q.oldIds.every((id) => olds.includes(id));
  });
}

/**
 * The questions in this download nobody has answered yet: one per old id, so
 * each absent account is its own Yes or No (two absent ids may be one
 * reconnection and one feed that is down). None whose new id a confirmed
 * re-link already retired: after "B replaces A", A reporting while B misses a
 * run would ask whether A replaces B, and a Yes would retire both, so nothing
 * would import into the account.
 */
export function openRelinkQuestions(
  mapping: Readonly<Record<string, string>>,
  feedIds: ReadonlySet<string>,
  decisions: RelinkDecisions,
): Relink[] {
  const retired = retiredIds(activeRelinks(decisions.confirmed, mapping), mapping);
  const out: Relink[] = [];
  for (const shape of detectRelinks(mapping, feedIds)) {
    if (retired.has(shape.newId)) continue;
    for (const oldId of shape.oldIds) {
      const q = { wfAccountId: shape.wfAccountId, newId: shape.newId, oldIds: [oldId] };
      if (decisions.confirmed.some((c) => c.newId === q.newId && c.oldIds.includes(oldId))) continue;
      if (isDeclined(decisions.declined, q)) continue;
      out.push(q);
    }
  }
  return out;
}

/** The Nos, with none left covering `q`'s old ids: a key naming several keeps
 *  the others. */
function declinedWithout(declined: readonly string[], q: Relink): string[] {
  return declined.flatMap((k) => {
    const [wf, newId, ...olds] = k.split('|');
    if (wf !== q.wfAccountId || newId !== q.newId || !olds.some((id) => q.oldIds.includes(id))) return [k];
    const rest = olds.filter((id) => !q.oldIds.includes(id));
    return rest.length > 0 ? [[wf, newId, ...rest].join('|')] : [];
  });
}

/** Yes to one question: its old id joins the new id's confirmed re-link, and a
 *  No to the same question (from another tab, say) is dropped, so the two are
 *  never both stored. */
export function withConfirmed(d: RelinkDecisions, q: Relink): RelinkDecisions {
  const same = d.confirmed.find((c) => c.newId === q.newId && c.wfAccountId === q.wfAccountId);
  const merged = { ...q, oldIds: [...new Set([...(same?.oldIds ?? []), ...q.oldIds])].sort() };
  return { confirmed: [...d.confirmed.filter((c) => c.newId !== q.newId), merged], declined: declinedWithout(d.declined, q) };
}

/** No to one question, remembered so it is not asked again. A Yes to the same
 *  question is taken back for that old id alone. */
export function withDeclined(d: RelinkDecisions, q: Relink): RelinkDecisions {
  const confirmed = d.confirmed.flatMap((c) => {
    if (c.newId !== q.newId || c.wfAccountId !== q.wfAccountId) return [c];
    const oldIds = c.oldIds.filter((id) => !q.oldIds.includes(id));
    return oldIds.length > 0 ? [{ ...c, oldIds }] : [];
  });
  return { confirmed, declined: isDeclined(d.declined, q) ? d.declined : [...d.declined, declineKey(q)] };
}

/** Take back a No: the question is asked again while the shape lasts. */
export function withoutDeclined(d: RelinkDecisions, key: string): RelinkDecisions {
  return { confirmed: d.confirmed, declined: d.declined.filter((k) => k !== key) };
}

/** Undo a Yes for the whole new id. Rows already removed stay removed. */
export function withoutConfirmed(d: RelinkDecisions, newId: string): RelinkDecisions {
  return { confirmed: d.confirmed.filter((c) => c.newId !== newId), declined: d.declined };
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
  /** Money out (the stored type is an outflow): a purchase and its refund
   *  share a day, an amount and a description, never a direction. */
  outflow: boolean;
  /** One of the sync's own bookkeeping rows (a starting balance or adjustment). */
  bookkeeping: boolean;
  /** Linked to a transfer, by the host's group id or the link ledger. */
  linked: boolean;
}

/** A transaction in the new account's download. */
export interface RelinkTx {
  txId: string;
  date: string;
  absCents: number;
  description: string;
  pending: boolean;
  /** Money out (a negative amount in the feed). */
  outflow: boolean;
}

export interface RelinkPlan {
  /** Stored rows from the old connection that stand for a new transaction with
   *  no row of its own: read under the new id, so the sync matches them instead
   *  of importing the transaction again. */
  adopt: Map<string, string>;
  /** The old row and every copy imported under the new id: one is kept, the
   *  rest are surplus. */
  duplicates: Array<{ keep: RelinkRow; remove: RelinkRow[]; txId: string }>;
  /** Copies left alone: more than one linked, or more than one candidate. */
  leftAlone: number;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase();

/**
 * Which stored rows from the old connection are the new download's transactions.
 *
 * A stored row is from the old connection when its transaction id is one no
 * account reported on this run (`liveTxIds`) and it is not the sync's own
 * bookkeeping. It is a new transaction when they share the day, the amount, the
 * direction and the bank's description. The stored description may carry notes the sync added
 * after the bank's text, so a row whose description starts with the bank's text
 * also counts, as long as it is the only candidate. Pending rows are left to the
 * reconcile planner, which already moves a pending row onto its posted copy.
 *
 * Only a one-to-one match is taken: several identical rows on one day pair off
 * when the counts agree, and anything else is left as it is. A wrong match would
 * hide a real transaction.
 *
 * Of the old row and its copies under the new id, the old row is kept: it
 * carries what the person did to it (category, notes, transfer link). When only
 * one copy is linked, that one is kept instead; two or more linked are left
 * alone, since deleting a linked leg strands its partner.
 */
export function planRelinkAdoption(
  existing: readonly RelinkRow[],
  feed: readonly RelinkTx[],
  liveTxIds: ReadonlySet<string>,
): RelinkPlan {
  const plan: RelinkPlan = { adopt: new Map(), duplicates: [], leftAlone: 0 };
  const stale = existing.filter((r) => !liveTxIds.has(r.txId) && !r.pending && !r.bookkeeping);
  const copiesByTxId = new Map<string, RelinkRow[]>();
  for (const r of existing) {
    if (liveTxIds.has(r.txId)) copiesByTxId.set(r.txId, [...(copiesByTxId.get(r.txId) ?? []), r]);
  }
  const posted = feed.filter((t) => !t.pending);

  const pairs: Array<[RelinkRow, RelinkTx]> = [];
  const taken = new Set<string>();
  // Exact descriptions first, paired off when the counts agree.
  const key = (date: string, cents: number, out: boolean, desc: string) => `${date}|${cents}|${out ? 'out' : 'in'}|${norm(desc)}`;
  const staleByKey = new Map<string, RelinkRow[]>();
  for (const r of stale) {
    const k = key(r.date, r.absCents, r.outflow, r.description);
    staleByKey.set(k, [...(staleByKey.get(k) ?? []), r]);
  }
  const feedByKey = new Map<string, RelinkTx[]>();
  for (const t of posted) {
    const k = key(t.date, t.absCents, t.outflow, t.description);
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
    return r.date === t.date && r.absCents === t.absCents && r.outflow === t.outflow && b.length > 0 && d.startsWith(`${b} · `);
  };
  for (const t of restFeed) {
    const rows = restStale.filter((r) => extends_(r, t));
    if (rows.length !== 1) continue;
    if (restFeed.filter((u) => extends_(rows[0], u)).length !== 1) continue;
    pairs.push([rows[0], t]);
  }

  for (const [row, tx] of pairs) {
    const copies = copiesByTxId.get(tx.txId) ?? [];
    if (copies.length === 0) { plan.adopt.set(row.wfId, tx.txId); continue; }
    const all = [row, ...copies];
    const linked = all.filter((r) => r.linked);
    if (linked.length > 1) { plan.leftAlone++; continue; }
    const keep = linked[0] ?? row;
    plan.duplicates.push({ keep, remove: all.filter((r) => r !== keep), txId: tx.txId });
  }
  return plan;
}
