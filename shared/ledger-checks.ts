/**
 * shared/ledger-checks.ts
 *
 * The audit a person would otherwise run by hand, judged every morning, and
 * silent unless something is wrong.
 *
 * Why this exists. The sync has always checked that balances agree with the
 * bank, and for months that read as "the numbers are right". It is only half of
 * right: every shape a row can take moves the same cash, so a balance that
 * reconciles to the cent says NOTHING about whether the row is income, spending
 * or a transfer. A full day of auditing (2026-09-12) found $1,900 of the user's
 * own money counted as income, a card $235.40 short of its opening balance for
 * five months, and reimbursements filed where they reduced nothing — all on a
 * ledger whose balances matched. None of it was detectable by looking at
 * balances, and all of it is detectable mechanically.
 *
 * Two kinds of finding live here, and the difference drives how often each
 * speaks:
 *
 *  - LEDGER errors have a right answer (link the pair, file the refund). They
 *    repeat daily until fixed, because they are actionable and quietly wrong.
 *  - BUDGET scenarios have no right answer — a purchase four times the size of
 *    its category's budget is not a bug, it is the budget no longer describing
 *    reality. Those are said ONCE, because the useful question ("reimbursable?
 *    one-off? raise the budget?") is only useful the first time.
 *
 * Pure on purpose: `facts` come from SQL in the companion, `seen` from a stored
 * ledger of when each condition was first observed, and everything about WHEN
 * to speak is decided here, where it can be tested without a database.
 */
import type { SelfCheckFinding } from './self-check.js';

export interface LedgerFacts {
  /** `YYYY-MM`, so once-a-month findings re-arm when the month turns. */
  month: string;
  /** Credit cards only. Cash accounts already have drift episodes; a card never
   *  could, because Wealthfolio reports no valuation for one. `ledger` is the
   *  POSTED balance, which is what the bank's figure means too. */
  cardBalances: Array<{ name: string; ledger: number; bank: number | null; inFlight: boolean }>;
  /** Refund-type credits with no spending category: they reduce nothing. */
  idleRefunds: Array<{ id: string; description: string; amount: number }>;
  /** Cash deposits filed under an INCOME category named like a payback. */
  incomeReimbursements: Array<{ id: string; description: string; amount: number; category: string }>;
  /** Cash transfer legs with no group, excluding the sync's own placeholders. */
  unlinkedTransfers: Array<{ id: string; description: string; amount: number; direction: 'in' | 'out'; ageDays: number }>;
  /** Rows inside a transfer group whose type is not a transfer. */
  groupedNonTransfers: Array<{ id: string; description: string; amount: number; type: string }>;
  /** In-transit placeholders, with how long each has been waiting. */
  heldTransfers: Array<{ id: string; description: string; amount: number; ageDays: number }>;
  /** Rows Wealthfolio itself flagged (3.8's `needs_review`). */
  needsReview: number;
  /** This month, per budget category. */
  categories: Array<{
    name: string;
    budget: number | null;
    spent: number;
    largest: { id: string; description: string; amount: number } | null;
  }>;
  /** Categories over budget in each of the last N full months. */
  chronicallyOver: Array<{ name: string; months: number; averageOver: number }>;
  /** Unlinked transfer legs whose other half never reached the ledger: exactly
   *  one other account is off from its bank balance by the leg's amount, in the
   *  direction the money went. */
  missingLegs: Array<{ id: string; description: string; amount: number; date: string; fromAccount: string; toAccount: string }>;
  /** Cards whose opening balance says they started in credit. */
  cardsOpenedInCredit: Array<{ name: string; amount: number; date: string }>;
}

/** When each condition was FIRST observed, keyed as `evaluateLedgerChecks`
 *  reports them. The companion persists this and prunes keys that stop
 *  appearing, so a condition that goes away and comes back is new again. */
export type LedgerCheckSeen = Record<string, string>;

/** A bank's balance can include a transaction a day or two before the feed
 *  carries it, so a card disagreement is only believed once it outlives that. */
const CARD_MISMATCH_GRACE_MS = 2 * 86_400_000;
/** Below this a difference is rounding, not information. Matches the sync's own
 *  drift display threshold. */
const CARD_MISMATCH_FLOOR = 1;
/** A pair's other half normally arrives within days; younger than this, an
 *  unlinked leg is the expected state, not a finding. */
const UNLINKED_MIN_AGE_DAYS = 3;
/** Past this a hold is no longer "waiting for the other bank to catch up". */
const HELD_MIN_AGE_DAYS = 14;
/** A "once" finding stays visible for a day, so a digest missed is not a
 *  finding missed. */
const ONCE_VISIBLE_MS = 86_400_000;
/** One purchase has to be worth mentioning in absolute terms too, or a $10
 *  parking budget files a report over a $12 ticket. */
const BUDGET_BUSTER_FLOOR = 50;
/** The digest was called bloated once already. */
const MAX_LINES = 5;

const money = (n: number) => `$${Math.abs(n).toFixed(2)}`;

interface Candidate {
  key: string;
  /** `always`: every day until fixed. `once`: only while newly seen.
   *  `after-grace`: only once it has persisted. */
  when: 'always' | 'once' | 'after-grace';
  finding: SelfCheckFinding;
}

/**
 * Judges the ledger. Returns the lines worth showing today, and EVERY condition
 * currently true (`keys`) — shown or not — so the caller can remember when each
 * was first seen and forget the ones that cleared.
 */
export function evaluateLedgerChecks(
  facts: LedgerFacts,
  seen: LedgerCheckSeen,
  now: Date,
): { findings: SelfCheckFinding[]; keys: string[] } {
  const candidates: Candidate[] = [];
  const warn = (message: string): SelfCheckFinding => ({ kind: 'ledger', severity: 'warning', message });

  // ── ledger errors: these have a right answer ─────────────────────────────
  for (const g of facts.groupedNonTransfers) {
    candidates.push({
      key: `grouped-non-transfer:${g.id}`,
      when: 'always',
      finding: warn(`${g.description} (${money(g.amount)}) is linked as a transfer but typed ${g.type}, so it still counts — retype it as a transfer`),
    });
  }
  // A leg whose other half is provably MISSING gets the sharper message below;
  // "link it to its other half" would send the user looking for a row that
  // does not exist.
  const missingIds = new Set((facts.missingLegs ?? []).map((m) => m.id));
  for (const t of facts.unlinkedTransfers) {
    if (t.ageDays < UNLINKED_MIN_AGE_DAYS || missingIds.has(t.id)) continue;
    candidates.push({
      key: `unlinked-transfer:${t.id}`,
      when: 'always',
      finding: warn(`${t.description} (${money(t.amount)}) is an unlinked transfer, so Wealthfolio counts it as ${t.direction === 'in' ? 'income' : 'spending'} — link it to its other half`),
    });
  }
  for (const r of facts.idleRefunds) {
    candidates.push({
      key: `idle-refund:${r.id}`,
      when: 'always',
      finding: warn(`${r.description} (${money(r.amount)}) is a refund with no spending category, so it reduces nothing — give it one`),
    });
  }
  for (const c of facts.cardBalances) {
    if (c.inFlight || c.bank === null) continue;
    const diff = Math.round((c.ledger - c.bank) * 100) / 100;
    if (Math.abs(diff) < CARD_MISMATCH_FLOOR) continue;
    candidates.push({
      // The amount is part of the key: a NEW disagreement must earn its own two
      // days rather than inherit the age of a different one.
      key: `card-balance:${c.name}:${Math.round(Math.abs(diff) * 100)}`,
      when: 'after-grace',
      finding: warn(`${c.name} has been ${money(diff)} ${diff > 0 ? 'above' : 'below'} the bank's balance for over two days`),
    });
  }
  for (const m of facts.missingLegs ?? []) {
    candidates.push({
      key: `missing-leg:${m.id}`,
      when: 'always',
      finding: warn(`${m.description} (${money(m.amount)}) left ${m.fromAccount} on ${m.date} but never arrived: ${m.toAccount} is exactly ${money(m.amount)} off from its bank balance. The feed dropped the other half — run fix-transfers to add it and link the pair`),
    });
  }
  if (facts.needsReview > 0) {
    candidates.push({
      key: 'needs-review',
      when: 'always',
      finding: warn(`${facts.needsReview} transaction${facts.needsReview === 1 ? '' : 's'} flagged Needs review in Wealthfolio`),
    });
  }

  // ── budget scenarios: no right answer, so said once ──────────────────────
  for (const d of facts.incomeReimbursements) {
    candidates.push({
      key: `income-reimbursement:${d.id}`,
      when: 'once',
      finding: warn(`${d.description} (${money(d.amount)}) is filed under "${d.category}", an income category — it counts as income and offsets no spending. If it paid you back for something, make it a reimbursement credit in that purchase's category`),
    });
  }
  for (const c of facts.categories) {
    const big = c.largest;
    if (!big || c.budget === null || c.budget <= 0) continue;
    if (big.amount < c.budget || big.amount < BUDGET_BUSTER_FLOOR) continue;
    candidates.push({
      key: `budget-buster:${big.id}`,
      when: 'once',
      finding: warn(`${big.description} (${money(big.amount)}) is bigger than the whole ${c.name} budget (${money(c.budget)}) — reimbursable, a one-off, or time to raise the budget?`),
    });
  }
  for (const c of facts.chronicallyOver) {
    candidates.push({
      key: `chronic:${facts.month}:${c.name}`,
      when: 'once',
      finding: warn(`${c.name} has been over budget ${c.months} months running, by about ${money(c.averageOver)} a month — the budget may be the thing that is wrong`),
    });
  }
  for (const c of facts.cardsOpenedInCredit ?? []) {
    candidates.push({
      key: `card-opened-in-credit:${c.name}`,
      when: 'once',
      finding: warn(`${c.name}'s opening balance says it started ${money(c.amount)} in credit on ${c.date}. A card in use rarely does — an opening balance computed from the bank's figure silently absorbs any payment the feed never delivered. Check the card's payment history against its Wealthfolio payments`),
    });
  }
  for (const h of facts.heldTransfers) {
    if (h.ageDays < HELD_MIN_AGE_DAYS) continue;
    candidates.push({
      key: `held-transfer:${h.id}`,
      when: 'once',
      finding: warn(`${h.description} (${money(h.amount)}) has waited ${h.ageDays} days for its other half — a silent bank feed is holding it open`),
    });
  }

  const due = candidates.filter((c) => {
    const first = seen[c.key] ? new Date(seen[c.key]).getTime() : null;
    const age = first === null || Number.isNaN(first) ? null : now.getTime() - first;
    if (c.when === 'always') return true;
    if (c.when === 'once') return age === null || age < ONCE_VISIBLE_MS;
    return age !== null && age >= CARD_MISMATCH_GRACE_MS;
  });

  // The cap hides the tail. A hidden once-only finding must NOT be stamped as
  // seen, or it expires without ever having been shown — live on the first
  // morning: eleven findings, four shown, "…and 7 more", and the seven were
  // never said. Left unstamped, it is "new" tomorrow and takes its turn as the
  // visible ones age out. Always-on findings are stamped regardless: they
  // repeat until fixed, so the stamp costs them nothing; and a card mismatch
  // keeps aging, so a busy morning cannot reset its two-day clock.
  const shown = new Set(due.slice(0, due.length > MAX_LINES ? MAX_LINES - 1 : MAX_LINES).map((c) => c.key));
  const findings = due.map((c) => c.finding);
  if (findings.length > MAX_LINES) {
    const hidden = findings.length - (MAX_LINES - 1);
    findings.splice(MAX_LINES - 1, findings.length, {
      kind: 'ledger',
      severity: 'warning',
      message: `…and ${hidden} more ledger issue${hidden === 1 ? '' : 's'}`,
    });
  }
  const keys = candidates
    .filter((c) => c.when !== 'once' || shown.has(c.key) || (seen[c.key] !== undefined && !due.includes(c)))
    .map((c) => c.key);
  return { findings, keys };
}

/**
 * The stored ledger after a run: first-seen times kept for conditions still
 * true, stamped `now` for new ones, and DROPPED for ones that cleared — so a
 * condition that goes away and later returns is announced again.
 */
export function nextLedgerCheckSeen(seen: LedgerCheckSeen, keys: readonly string[], now: Date): LedgerCheckSeen {
  const next: LedgerCheckSeen = {};
  for (const key of keys) next[key] = seen[key] ?? now.toISOString();
  return next;
}
