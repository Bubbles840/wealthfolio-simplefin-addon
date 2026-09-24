/**
 * companion/src/ledger-facts.ts
 *
 * Gathers the facts `shared/ledger-checks.ts` judges. Every query here began as
 * a hand-run audit script in `companion/tools/` and was checked against a real
 * ledger before it was trusted to run unattended; the judgement about WHEN a
 * fact is worth a line lives in the shared module, where it is testable without
 * a database.
 *
 * Returns `null` rather than throwing when the database cannot be read. This
 * runs inside the daily report, and a checker that cannot check must never cost
 * the user the report it was meant to improve.
 */
import { existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import type { LedgerFacts } from '../../shared/ledger-checks.js';
import { IN_TRANSIT_COMMENT_PREFIX } from '../../shared/reconcile.js';
import { ruleCatchesAmazonCharges } from '../../shared/amazon-config.js';
import { PENDING_SUFFIX } from '../../shared/sync-core.js';

/** The digest's own spending sign — kept in step with `SPENDING_SIGN` in
 *  sqlite-native.ts, which transcribes Wealthfolio's classifier. */
const SPENDING_SIGN = `
  CASE UPPER(acc.account_type)
    WHEN 'CREDIT_CARD' THEN CASE
      WHEN UPPER(a.activity_type) IN ('WITHDRAWAL','FEE','INTEREST') THEN 1
      WHEN UPPER(a.activity_type) = 'CREDIT' THEN -1
      ELSE 0 END
    WHEN 'CASH' THEN CASE
      WHEN UPPER(a.activity_type) IN ('WITHDRAWAL','TRANSFER_OUT','FEE','TAX') THEN 1
      WHEN UPPER(a.activity_type) = 'CREDIT'
           AND UPPER(COALESCE(a.subtype,'')) IN ('REFUND','REBATE','REIMBURSEMENT') THEN -1
      ELSE 0 END
    ELSE 0
  END`;

/** Rows the sync writes for its own bookkeeping; never spending, never a finding. */
const NOT_BOOKKEEPING = `
  COALESCE(a.notes,'') NOT LIKE 'Starting balance · %'
  AND COALESCE(a.notes,'') NOT LIKE 'Balance adjustment · %'
  AND COALESCE(a.notes,'') NOT LIKE '${IN_TRANSIT_COMMENT_PREFIX}%'`;

/** Wealthfolio 3.8's cash direction per type, with its one account-dependent
 *  exception (card interest is a charge). `fee` is informational since 3.8. */
const CASH_EFFECT = `
  CASE
    WHEN UPPER(acc.account_type) = 'CREDIT_CARD' AND UPPER(a.activity_type) = 'INTEREST' THEN -1
    WHEN UPPER(a.activity_type) IN ('DEPOSIT','CREDIT','TRANSFER_IN','DIVIDEND','INTEREST','SELL') THEN 1
    WHEN UPPER(a.activity_type) IN ('WITHDRAWAL','TRANSFER_OUT','FEE','TAX','BUY') THEN -1
    ELSE 0 END * ABS(CAST(COALESCE(a.amount,'0') AS REAL))`;

/** How far back "recent" reaches for transfer findings. Deliberately short:
 *  older oddities are history someone has already lived with (this ledger has
 *  three hand-repaired legs from June that must NOT be re-litigated daily). */
const RECENT_DAYS = 60;
/** A leg younger than this is usually just in transit: the receiving bank's
 *  balance often includes it a day or two before its feed does, which looks
 *  exactly like a missing leg until the feed catches up. */
const MISSING_LEG_MIN_AGE_DAYS = 7;
/** How many full months a category must be over before it is "chronic". */
const CHRONIC_MONTHS = 3;

function open(dbPath: string): DatabaseSync | null {
  if (!dbPath || !existsSync(dbPath)) return null;
  // mode=ro attaches the write-ahead log; readonly_shm covers the read-only
  // bind mount; immutable is the stale-but-working fallback. Same ladder as
  // `queryNativeDb`.
  for (const uri of [`file:${dbPath}?mode=ro`, `file:${dbPath}?mode=ro&readonly_shm=1`, `file:${dbPath}?immutable=1`]) {
    try {
      const db = new DatabaseSync(uri);
      db.prepare('SELECT 1').get();
      return db;
    } catch {
      /* next form */
    }
  }
  return null;
}

const describe = (notes: unknown) => String(notes ?? '').replace(IN_TRANSIT_COMMENT_PREFIX, '').split(' · ')[0].trim() || 'A transaction';
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ym = (d: Date) => ymd(d).slice(0, 7);

export function getLedgerFacts(
  dbPath: string,
  now: Date,
  /** SimpleFin's last reported balance per WEALTHFOLIO account id. */
  bankBalanceByWfId: ReadonlyMap<string, number | null>,
  opts: { amazonMailEnabled?: boolean } = {},
): LedgerFacts | null {
  const db = open(dbPath);
  if (!db) return null;
  try {
    const all = <T>(sql: string, ...args: Array<string | number>) => db.prepare(sql).all(...args) as T[];
    const month = ym(now);
    const monthStart = `${month}-01`;
    const nextMonth = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 1));
    const recent = ymd(new Date(now.getTime() - RECENT_DAYS * 86_400_000));
    const today = ymd(now);
    const age = `CAST(julianday('${today}') - julianday(substr(a.activity_date,1,10)) AS INTEGER)`;

    const inFlightAccounts = new Set(
      all<{ account_id: string }>(
        `SELECT DISTINCT account_id FROM activities WHERE COALESCE(notes,'') LIKE '${IN_TRANSIT_COMMENT_PREFIX}%'`,
      ).map((r) => r.account_id),
    );

    const cardBalances = all<{ id: string; name: string; ledger: number }>(
      `SELECT acc.id, acc.name, ROUND(SUM(${CASH_EFFECT}), 2) ledger
       FROM activities a JOIN accounts acc ON a.account_id = acc.id
       WHERE UPPER(acc.account_type) = 'CREDIT_CARD'
         AND COALESCE(a.notes,'') NOT LIKE '%${PENDING_SUFFIX}'
       GROUP BY acc.id`,
    ).map((r) => ({
      name: String(r.name),
      ledger: Number(r.ledger),
      bank: bankBalanceByWfId.get(r.id) ?? null,
      inFlight: inFlightAccounts.has(r.id),
    }));

    const idleRefunds = all<{ id: string; notes: string; amt: number }>(
      `SELECT a.id, a.notes, ABS(CAST(a.amount AS REAL)) amt
       FROM activities a JOIN accounts acc ON a.account_id = acc.id
       WHERE a.activity_date >= ? AND a.activity_date < ?
         AND (${SPENDING_SIGN}) < 0
         AND ${NOT_BOOKKEEPING}
         AND NOT EXISTS (
           SELECT 1 FROM activity_taxonomy_assignments ata
           JOIN taxonomy_categories tc ON ata.category_id = tc.id
           WHERE ata.activity_id = a.id AND tc.taxonomy_id = 'spending_categories')`,
      monthStart, nextMonth,
    ).map((r) => ({ id: r.id, description: describe(r.notes), amount: Number(r.amt) }));

    const incomeReimbursements = all<{ id: string; notes: string; amt: number; cat: string }>(
      `SELECT a.id, a.notes, ABS(CAST(a.amount AS REAL)) amt, tc.name cat
       FROM activities a JOIN accounts acc ON a.account_id = acc.id
       JOIN activity_taxonomy_assignments ata ON ata.activity_id = a.id
       JOIN taxonomy_categories tc ON ata.category_id = tc.id
       WHERE a.activity_date >= ? AND a.activity_date < ?
         AND UPPER(acc.account_type) = 'CASH' AND UPPER(a.activity_type) = 'DEPOSIT'
         AND tc.taxonomy_id <> 'spending_categories'
         AND (LOWER(tc.name) LIKE '%reimburs%' OR LOWER(tc.name) LIKE '%refund%' OR LOWER(tc.name) LIKE '%payback%')`,
      monthStart, nextMonth,
    ).map((r) => ({ id: r.id, description: describe(r.notes), amount: Number(r.amt), category: String(r.cat) }));

    const unlinkedTransfers = all<{ id: string; notes: string; amt: number; t: string; age: number }>(
      `SELECT a.id, a.notes, ABS(CAST(a.amount AS REAL)) amt, UPPER(a.activity_type) t, ${age} age
       FROM activities a JOIN accounts acc ON a.account_id = acc.id
       WHERE substr(a.activity_date,1,10) >= ?
         AND UPPER(acc.account_type) = 'CASH'
         AND UPPER(a.activity_type) IN ('TRANSFER_IN','TRANSFER_OUT')
         AND COALESCE(a.source_group_id,'') = ''
         AND COALESCE(a.notes,'') NOT LIKE '%${PENDING_SUFFIX}'
         AND ${NOT_BOOKKEEPING}`,
      recent,
    ).map((r) => ({
      id: r.id, description: describe(r.notes), amount: Number(r.amt),
      direction: r.t === 'TRANSFER_IN' ? 'in' as const : 'out' as const, ageDays: Number(r.age),
    }));

    // Only the types that still COUNT inside a group. A bare CREDIT in a group
    // is neutral already — that is the deliberate resting shape for a leg whose
    // phantom asset makes retyping to a transfer unsafe.
    const groupedNonTransfers = all<{ id: string; notes: string; amt: number; t: string }>(
      `SELECT a.id, a.notes, ABS(CAST(a.amount AS REAL)) amt, UPPER(a.activity_type) t
       FROM activities a JOIN accounts acc ON a.account_id = acc.id
       WHERE substr(a.activity_date,1,10) >= ?
         AND COALESCE(a.source_group_id,'') <> ''
         AND UPPER(acc.account_type) = 'CASH'
         AND UPPER(a.activity_type) IN ('DEPOSIT','WITHDRAWAL')`,
      recent,
    ).map((r) => ({ id: r.id, description: describe(r.notes), amount: Number(r.amt), type: String(r.t) }));

    const heldTransfers = all<{ id: string; notes: string; amt: number; age: number }>(
      `SELECT a.id, a.notes, ABS(CAST(a.amount AS REAL)) amt, ${age} age
       FROM activities a WHERE COALESCE(a.notes,'') LIKE '${IN_TRANSIT_COMMENT_PREFIX}%'`,
    ).map((r) => ({ id: r.id, description: describe(r.notes), amount: Number(r.amt), ageDays: Number(r.age) }));

    const hasReviewColumn = all<{ name: string }>(`PRAGMA table_info(activities)`).some((c) => c.name === 'needs_review');
    const needsReview = hasReviewColumn
      ? Number(all<{ n: number }>(`SELECT COUNT(*) n FROM activities WHERE needs_review = 1`)[0]?.n ?? 0)
      : 0;

    const budgetsFor = (period: string) =>
      new Map(
        all<{ cat: string; budget: number }>(
          `WITH ranked AS (
             SELECT category_id, CAST(amount AS REAL) amount,
                    ROW_NUMBER() OVER (PARTITION BY category_id
                                       ORDER BY (period_key = ?) DESC, updated_at DESC) rn
             FROM budget_targets WHERE period_key = ? OR period_key = 'default')
           SELECT COALESCE(p.name, tc.name) cat, ROUND(SUM(r.amount), 2) budget
           FROM ranked r JOIN taxonomy_categories tc ON r.category_id = tc.id
           LEFT JOIN taxonomy_categories p ON tc.parent_id = p.id
           WHERE r.rn = 1 GROUP BY COALESCE(p.name, tc.name)`,
          period, period,
        ).map((r) => [String(r.cat), Number(r.budget)]),
      );
    const spendRows = (start: string, end: string) =>
      all<{ id: string; cat: string; signed: number; notes: string }>(
        `SELECT a.id, COALESCE(p.name, tc.name) cat, a.notes,
                (${SPENDING_SIGN}) * ABS(CAST(a.amount AS REAL)) signed
         FROM activities a JOIN accounts acc ON a.account_id = acc.id
         JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
         JOIN taxonomy_categories tc ON ata.category_id = tc.id
         LEFT JOIN taxonomy_categories p ON tc.parent_id = p.id
         WHERE tc.taxonomy_id = 'spending_categories'
           AND a.activity_date >= ? AND a.activity_date < ?
           AND (${SPENDING_SIGN}) <> 0 AND ${NOT_BOOKKEEPING}`,
        start, end,
      );

    const budgets = budgetsFor(month);
    const byCat = new Map<string, { spent: number; largest: { id: string; description: string; amount: number } | null }>();
    for (const r of spendRows(monthStart, nextMonth)) {
      const entry = byCat.get(r.cat) ?? { spent: 0, largest: null };
      entry.spent += Number(r.signed);
      if (Number(r.signed) > (entry.largest?.amount ?? 0)) {
        entry.largest = { id: r.id, description: describe(r.notes), amount: Number(r.signed) };
      }
      byCat.set(r.cat, entry);
    }
    const categories = [...byCat.entries()].map(([name, e]) => ({
      name, budget: budgets.get(name) ?? null, spent: Math.round(e.spent * 100) / 100, largest: e.largest,
    }));

    // Over budget in EVERY one of the last N full months — one good month
    // breaks the streak, because then it is a bad month, not a wrong budget.
    const overBy = new Map<string, number[]>();
    for (let back = 1; back <= CHRONIC_MONTHS; back++) {
      const start = new Date(now.getFullYear(), now.getMonth() - back, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - back + 1, 1);
      const monthBudgets = budgetsFor(ym(start));
      const spent = new Map<string, number>();
      for (const r of spendRows(ymd(start), ymd(end))) spent.set(r.cat, (spent.get(r.cat) ?? 0) + Number(r.signed));
      for (const [cat, budget] of monthBudgets) {
        const over = (spent.get(cat) ?? 0) - budget;
        if (budget > 0 && over > 0) overBy.set(cat, [...(overBy.get(cat) ?? []), over]);
      }
    }
    const chronicallyOver = [...overBy.entries()]
      .filter(([, overs]) => overs.length === CHRONIC_MONTHS)
      .map(([name, overs]) => ({
        name, months: CHRONIC_MONTHS,
        averageOver: Math.round((overs.reduce((s, v) => s + v, 0) / overs.length) * 100) / 100,
      }));

    // A transfer's other half missing from the feed leaves the receiving
    // account off from its bank by exactly the leg's amount (live: $3,000
    // Spend → Savings, 2026-08-10, six weeks unnoticed). gap = bank − ledger,
    // so money that LEFT one account shows up as a positive gap elsewhere.
    const names = new Map(all<{ id: string; name: string }>(`SELECT id, name FROM accounts`).map((r) => [r.id, String(r.name)]));
    const ledgers = new Map(
      all<{ id: string; ledger: number }>(
        `SELECT acc.id, ROUND(SUM(${CASH_EFFECT}), 2) ledger
         FROM activities a JOIN accounts acc ON a.account_id = acc.id
         WHERE UPPER(acc.account_type) IN ('CASH','CREDIT_CARD')
           AND COALESCE(a.notes,'') NOT LIKE '%${PENDING_SUFFIX}'
         GROUP BY acc.id`,
      ).map((r) => [r.id, Number(r.ledger)]),
    );
    const gaps: Array<[string, number]> = [];
    for (const [wfId, bank] of bankBalanceByWfId) {
      if (typeof bank !== 'number' || !names.has(wfId)) continue;
      const gap = Math.round((bank - (ledgers.get(wfId) ?? 0)) * 100) / 100;
      if (Math.abs(gap) >= 1) gaps.push([wfId, gap]);
    }
    const missingLegs = all<{ id: string; account_id: string; notes: string; amt: number; t: string; d: string }>(
      `SELECT a.id, a.account_id, a.notes, ABS(CAST(a.amount AS REAL)) amt, UPPER(a.activity_type) t,
              substr(a.activity_date,1,10) d
       FROM activities a JOIN accounts acc ON a.account_id = acc.id
       WHERE UPPER(a.activity_type) IN ('TRANSFER_IN','TRANSFER_OUT')
         AND COALESCE(a.source_group_id,'') = ''
         AND COALESCE(a.notes,'') NOT LIKE '%${PENDING_SUFFIX}'
         AND COALESCE(a.notes,'') NOT LIKE 'Starting balance · %'
         AND COALESCE(a.notes,'') NOT LIKE 'Balance adjustment · %'
         AND ${age} >= ${MISSING_LEG_MIN_AGE_DAYS}`,
    ).flatMap((r) => {
      const want = r.t === 'TRANSFER_OUT' ? Number(r.amt) : -Number(r.amt);
      const hits = gaps.filter(([id, gap]) => id !== r.account_id && Math.abs(gap - want) < 0.01);
      if (hits.length !== 1) return [];
      const leftFrom = r.t === 'TRANSFER_OUT' ? r.account_id : hits[0][0];
      const arrivedAt = r.t === 'TRANSFER_OUT' ? hits[0][0] : r.account_id;
      return [{
        id: r.id, description: describe(r.notes), amount: Number(r.amt), date: r.d,
        fromAccount: names.get(leftFrom) ?? leftFrom, toAccount: names.get(arrivedAt) ?? arrivedAt,
      }];
    });

    const cardsOpenedInCredit = all<{ name: string; amt: number; d: string }>(
      `SELECT acc.name, ABS(CAST(a.amount AS REAL)) amt, substr(a.activity_date,1,10) d
       FROM activities a JOIN accounts acc ON a.account_id = acc.id
       WHERE UPPER(acc.account_type) = 'CREDIT_CARD'
         AND COALESCE(a.notes,'') LIKE 'Starting balance · %'
         AND UPPER(a.activity_type) IN ('TRANSFER_IN','CREDIT')
         AND ABS(CAST(a.amount AS REAL)) >= 1`,
    ).map((r) => ({ name: String(r.name), amount: Number(r.amt), date: String(r.d) }));

    // Only worth saying while order emails are set up to label Amazon charges;
    // otherwise a broad Amazon rule is simply how the user files them.
    const hasRules = all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name='spending_categorization_rules'`).length > 0;
    const broadAmazonRules = opts.amazonMailEnabled && hasRules
      ? all<{ name: string; pattern: string; match_type: string }>(
        `SELECT name, pattern, match_type FROM spending_categorization_rules`,
      )
        .filter((r) => ruleCatchesAmazonCharges({ pattern: String(r.pattern ?? ''), matchType: String(r.match_type ?? '') }))
        .map((r) => String(r.name || r.pattern))
      : [];

    return {
      month, cardBalances, idleRefunds, incomeReimbursements, unlinkedTransfers,
      groupedNonTransfers, heldTransfers, needsReview, categories, chronicallyOver,
      missingLegs, cardsOpenedInCredit, broadAmazonRules,
    };
  } catch (err) {
    console.error('[simplefin-sync] ledger checks could not read the database:', err);
    return null;
  } finally {
    db.close();
  }
}
