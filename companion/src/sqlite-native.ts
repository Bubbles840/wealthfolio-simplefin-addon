/**
 * companion/src/sqlite-native.ts
 *
 * Reads Wealthfolio's native SQLite database (wealthfolio.db) directly
 * for 100% exact, native category budget allocations and spent totals.
 */

import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import { descriptionFromComment } from '../../shared/sync-core.js';

export interface NativeCategorySpending {
  categoryName: string;
  spent: number;
}

/** One individual spending transaction, ready to print. */
export interface NativeSpendingTransaction {
  /** Magnitude in dollars — always positive, like the aggregate reader's totals. */
  amount: number;
  /** Display-ready bank description: the stored note with the SimpleFin tx id,
   *  the pending marker and the in-transit prefix removed (see
   *  `descriptionFromComment`). Empty when the bank sent no description. */
  description: string;
  /** Parent category name where one exists, so the label matches every other
   *  category figure in the reports. */
  categoryName: string;
}

/**
 * Runs one read-only query against wealthfolio.db, preferring `node:sqlite` and
 * falling back to the `sqlite3` CLI.
 *
 * Every reader in this file shares this body, so the immutable-open URI, the
 * two-path fallback and the "log and give up empty" behaviour exist once. The
 * two paths return different shapes — `node:sqlite` gives objects keyed by the
 * SELECT aliases, the CLI gives `|`-delimited text — so callers supply
 * `fromCliParts` to rebuild a row from the split line, and alias their columns to
 * the field names they want.
 *
 * `label` only names the reader in log lines.
 */
function queryNativeDb<Row>(
  dbPath: string,
  label: string,
  query: string,
  fromCliParts: (parts: string[]) => Row | null,
): Row[] {
  // LIVE read first, snapshot only as a fallback. `immutable=1` reads the main
  // DB file alone and ignores the write-ahead log — and Wealthfolio checkpoints
  // rarely (a live instance was observed 2 DAYS behind, 2.4 MB of WAL), so an
  // immutable read silently served days-old budgets, spending, and category
  // data. `mode=ro` attaches the WAL; `readonly_shm=1` covers the read-only
  // bind mount, where the shm index can't be created but CAN be read as long as
  // Wealthfolio itself keeps one alive — which a running instance always does.
  // Requires the -wal/-shm files to be visible, i.e. the DIRECTORY mounted, not
  // the bare .db file; with a file-only mount both live opens fail and the
  // immutable fallback preserves the old (stale but working) behaviour.
  const uris = dbPath.startsWith('file:')
    ? [dbPath]
    : [
        `file:${dbPath}?mode=ro`,
        `file:${dbPath}?mode=ro&readonly_shm=1`,
        `file:${dbPath}?immutable=1`,
      ];
  for (const uri of uris) {
    try {
      const db = new DatabaseSync(uri);
      try {
        return db.prepare(query).all() as Row[];
      } finally {
        db.close();
      }
    } catch (err) {
      console.error(`[simplefin-sync] node:sqlite ${label} error on ${uri.slice(uri.indexOf('?'))}:`, err);
    }
  }

  try {
    const cmd = `sqlite3 "${dbPath}" "${query.replace(/\n/g, ' ')}"`;
    const output = execSync(cmd, { encoding: 'utf8' });
    const rows: Row[] = [];
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = fromCliParts(trimmed.split('|'));
      if (row) rows.push(row);
    }
    return rows;
  } catch (err) {
    console.error(`[simplefin-sync] Failed to read native sqlite ${label}:`, err);
    return [];
  }
}

/**
 * The date bounds are interpolated into SQL rather than bound as parameters (the
 * sqlite3-CLI fallback path has no parameter binding), so they are validated
 * rather than trusted. Every caller builds them from date arithmetic, so a
 * failure here means a bug, not user input — refusing to run is the safe
 * response either way.
 */
function validDateBounds(startInclusive: string, endExclusive: string): boolean {
  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (isDate(startInclusive) && isDate(endExclusive)) return true;
  console.error(`[simplefin-sync] Refusing spending query with malformed date bounds: ${startInclusive}..${endExclusive}`);
  return false;
}

/**
 * The joins and predicates that define "spending", shared verbatim by the
 * aggregate reader and the biggest-transactions reader so the two can never
 * disagree about what counts. In particular the transfers exclusion has to apply
 * to both: a transfer miscategorised as spending is typically the largest row of
 * the week and would otherwise top the list.
 */
const SPENDING_FROM = `
    FROM activities a
    JOIN accounts acc ON a.account_id = acc.id
    JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
    JOIN taxonomy_categories tc ON ata.category_id = tc.id
    LEFT JOIN taxonomy_categories parent ON tc.parent_id = parent.id`;

/** The rolled-up label: the parent category where there is one, else the
 *  category itself. Both readers select and filter on this same expression. */
const SPENDING_CATEGORY = `COALESCE(parent.name, tc.name)`;

/**
 * Wealthfolio's own spending classification, transcribed from upstream —
 * `docs/upstream-spending-buckets.md` §2 quotes the Rust with line numbers.
 * `+1` is an Expense, `-1` an ExpenseRefund (money BACK, which reduces what a
 * category has cost), `0` Ignored.
 *
 * This existed here as `activity_type IN ('WITHDRAWAL','FEE','TAX')` — a
 * simplification that silently disagreed with the app on three counts, all in
 * the same direction (over-reporting spend):
 *
 *  • A `REIMBURSEMENT`/`REFUND`/`REBATE` credit on a cash account reduces the
 *    category upstream and was ignored here. Found live 2026-08-21: Food &
 *    Dining read $157.16 in the Telegram report against $16.35 in the app,
 *    the difference being $140.81 of Venmo paybacks — the very rows v1.14.0
 *    taught Wealthfolio to treat this way, while this query was never told.
 *  • ANY credit on a credit-card account is a refund upstream, subtype
 *    irrelevant. A $14.42 statement credit was being ignored here.
 *  • `TRANSFER_OUT` (cash) and `INTEREST` (credit card) are expenses upstream
 *    and were not counted at all.
 */
const SPENDING_SIGN = `
      CASE UPPER(acc.account_type)
        WHEN 'CREDIT_CARD' THEN CASE
          WHEN UPPER(a.activity_type) IN ('WITHDRAWAL', 'FEE', 'INTEREST') THEN 1
          WHEN UPPER(a.activity_type) = 'CREDIT' THEN -1
          ELSE 0 END
        WHEN 'CASH' THEN CASE
          WHEN UPPER(a.activity_type) IN ('WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX') THEN 1
          WHEN UPPER(a.activity_type) = 'CREDIT'
               AND UPPER(COALESCE(a.subtype, '')) IN ('REFUND', 'REBATE', 'REIMBURSEMENT') THEN -1
          ELSE 0 END
        ELSE 0
      END`;

/** Signed dollars for one assignment row: positive spend, negative refund. */
const SPENDING_SIGNED_AMOUNT = `(${SPENDING_SIGN}) * ABS(CAST(a.amount AS REAL))`;

function spendingWhere(startInclusive: string, endExclusive: string): string {
  return `
    WHERE a.activity_date >= '${startInclusive}'
      AND a.activity_date < '${endExclusive}'
      AND (${SPENDING_SIGN}) <> 0
      -- The SPENDING taxonomy only. A reimbursement carries TWO assignments —
      -- an income one and a spending one — so joining every taxonomy counted
      -- the same row twice, under two different category names.
      AND tc.taxonomy_id = 'spending_categories'
      AND LOWER(${SPENDING_CATEGORY}) NOT IN ('transfers', 'transfer', 'internal transfers', 'savings & transfers')`;
}

/**
 * Returns native category spent totals for an arbitrary date window —
 * `[startInclusive, endExclusive)`, both `YYYY-MM-DD` — matching the format
 * `activities.activity_date` is stored in.
 *
 * This is the single implementation of the spending query; the month-scoped
 * reader below computes its own bounds and delegates here, so the type filter,
 * the transfers exclusion and the parent-category rollup exist in exactly one
 * place.
 */
export function getNativeWealthfolioSpendingBetween(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): Record<string, number> {
  if (!dbPath || !existsSync(dbPath)) {
    return {};
  }
  if (!validDateBounds(startInclusive, endExclusive)) {
    return {};
  }

  const query = `
    SELECT
      ${SPENDING_CATEGORY} as parent_category,
      ROUND(SUM(${SPENDING_SIGNED_AMOUNT}), 2) as total_spent
    ${SPENDING_FROM}
    ${spendingWhere(startInclusive, endExclusive)}
    GROUP BY ${SPENDING_CATEGORY};
  `;

  const rows = queryNativeDb<{ parent_category: string; total_spent: number }>(
    dbPath,
    'spending',
    query,
    (parts) => (parts.length === 2
      ? { parent_category: parts[0].trim(), total_spent: parseFloat(parts[1]) || 0 }
      : null),
  );

  const result: Record<string, number> = {};
  for (const r of rows) {
    if (r.parent_category) {
      result[r.parent_category] = typeof r.total_spent === 'number' ? r.total_spent : parseFloat(String(r.total_spent || 0));
    }
  }
  return result;
}

/** First day of the month AFTER `yearMonth` (`2026-12` -> `2027-01-01`), as the
 *  exclusive upper bound every month-scoped query needs. */
function nextMonthStart(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/**
 * Returns native category spent totals directly from wealthfolio.db for a given month (e.g. '2026-07').
 */
export function getNativeWealthfolioSpending(dbPath: string, yearMonth: string): Record<string, number> {
  return getNativeWealthfolioSpendingBetween(dbPath, `${yearMonth}-01`, nextMonthStart(yearMonth));
}

/**
 * The `limit` biggest INDIVIDUAL spending transactions in `[startInclusive,
 * endExclusive)` — largest first — rather than the per-category rollup the
 * readers above produce. Feeds the weekly report's "biggest this week"
 * section, which exists to say WHY the month's remaining figure moved.
 *
 * Shares the type filter, the transfers exclusion, the parent-category rollup,
 * the half-open bounds and the dual execution path with
 * `getNativeWealthfolioSpendingBetween` (see `SPENDING_FROM` / `spendingWhere` /
 * `queryNativeDb`), so the list can only ever contain rows the headline total
 * also counted.
 *
 * Two things worth knowing about the description:
 *  - the column is `notes`. `comment` is the REST API's name for the same field
 *    and `SELECT comment FROM activities` fails outright with `no such column`.
 *  - what is stored there is not display text; `descriptionFromComment` takes
 *    the bookkeeping decorations back off.
 *
 * `limit` is interpolated (the CLI fallback cannot bind parameters), so it is
 * floored to an integer and a non-positive or non-finite value returns `[]`
 * without touching the database — the same "refuse rather than guess" stance the
 * date bounds take.
 */
export function getNativeWealthfolioTopSpending(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
  limit: number,
): NativeSpendingTransaction[] {
  if (!dbPath || !existsSync(dbPath)) {
    return [];
  }
  if (!validDateBounds(startInclusive, endExclusive)) {
    return [];
  }
  const n = Number.isFinite(limit) ? Math.floor(limit) : 0;
  if (n < 1) return [];

  const query = `
    SELECT
      ROUND(ABS(CAST(a.amount AS REAL)), 2) as amount,
      COALESCE(a.notes, '') as notes,
      ${SPENDING_CATEGORY} as parent_category
    ${SPENDING_FROM}
    ${spendingWhere(startInclusive, endExclusive)}
      -- EXPENSES only, unlike the aggregate readers. "Biggest spends this week"
      -- is a list of purchases; a large refund is money coming back and would
      -- head the list as though it were the week's worst damage.
      AND (${SPENDING_SIGN}) > 0
    ORDER BY ABS(CAST(a.amount AS REAL)) DESC
    LIMIT ${n};
  `;

  // The CLI fallback splits on `|`, which a bank description can legitimately
  // contain, so the DESCRIPTION is read as "everything between the first and
  // last field" rather than by index. (A `|` in a category name would still
  // confuse it; the aggregate reader has the same exposure, and the node:sqlite
  // path — the one that actually runs — is unaffected.)
  const rows = queryNativeDb<{ amount: number | string; notes: string; parent_category: string }>(
    dbPath,
    'top spending',
    query,
    (parts) => (parts.length >= 3
      ? {
          amount: parseFloat(parts[0]) || 0,
          notes: parts.slice(1, -1).join('|'),
          parent_category: parts[parts.length - 1].trim(),
        }
      : null),
  );

  return rows.map((r) => ({
    amount: typeof r.amount === 'number' ? r.amount : parseFloat(String(r.amount || 0)),
    description: descriptionFromComment(r.notes),
    categoryName: r.parent_category,
  }));
}

/**
 * Returns native category budget targets from wealthfolio.db for a given month or default.
 */
export function getNativeWealthfolioBudgets(dbPath: string, yearMonth: string): Record<string, number> {
  if (!dbPath || !existsSync(dbPath)) return {};

  const query = `
    WITH ranked_budgets AS (
      SELECT
        category_id,
        CAST(amount AS REAL) as amount,
        ROW_NUMBER() OVER (
          PARTITION BY category_id
          ORDER BY (period_key = '${yearMonth}') DESC, updated_at DESC
        ) as rn
      FROM budget_targets
      WHERE period_key = '${yearMonth}' OR period_key = 'default'
    )
    SELECT
      COALESCE(parent.name, tc.name) as parent_category,
      ROUND(SUM(rb.amount), 2) as total_budget
    FROM ranked_budgets rb
    JOIN taxonomy_categories tc ON rb.category_id = tc.id
    LEFT JOIN taxonomy_categories parent ON tc.parent_id = parent.id
    WHERE rb.rn = 1
    GROUP BY COALESCE(parent.name, tc.name);
  `;

  const rows = queryNativeDb<{ parent_category: string; total_budget: number }>(
    dbPath,
    'budget',
    query,
    (parts) => (parts.length === 2
      ? { parent_category: parts[0].trim(), total_budget: parseFloat(parts[1]) || 0 }
      : null),
  );

  const result: Record<string, number> = {};
  for (const r of rows) {
    if (r.parent_category) {
      result[r.parent_category] = typeof r.total_budget === 'number' ? r.total_budget : parseFloat(String(r.total_budget || 0));
    }
  }
  return result;
}

/** One uncategorized spending row from the needs-a-category sweep. */
export interface NativeUncategorizedTx {
  activityId: string;
  wfAccountId: string;
  /** The raw stored note (`<description> · <txId>[ · pending]`) — the caller
   *  strips it down with `descriptionFromComment`/`txIdFromComment`. */
  notes: string;
  amountCents: number;
  /** ISO date (yyyy-mm-dd). */
  date: string;
  accountName: string;
}

/**
 * Spending rows in `[startInclusive, endExclusive)` with NO taxonomy
 * assignment — the needs-a-category sweep behind the import notice.
 *
 * Spending AND income types: a live user's interest deposit and card-points
 * CREDIT both wanted categorizing (2026-08-02), so only transfers — which
 * Wealthfolio classifies by linking, not by category — are excluded by type.
 * Rows the sync itself writes — starting balances, balance adjustments,
 * in-transit placeholders — are excluded by their note prefixes: nagging the
 * user to categorize a row the machine created would be absurd, and the
 * in-transit prefix is also what keeps placeholder CREDITs out now that the
 * CREDIT type is swept.
 */
export function getNativeUncategorizedSpending(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): NativeUncategorizedTx[] {
  if (!dbPath || !existsSync(dbPath)) return [];
  if (!validDateBounds(startInclusive, endExclusive)) return [];

  const query = `
    SELECT a.id, COALESCE(a.account_id, ''), COALESCE(a.notes, ''),
           ROUND(ABS(CAST(a.amount AS REAL)) * 100),
           substr(a.activity_date, 1, 10), COALESCE(ac.name, '')
    FROM activities a
    LEFT JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
    LEFT JOIN accounts ac ON a.account_id = ac.id
    WHERE ata.activity_id IS NULL
      AND a.activity_date >= '${startInclusive}'
      AND a.activity_date < '${endExclusive}'
      AND UPPER(a.activity_type) IN ('WITHDRAWAL', 'FEE', 'TAX', 'DEPOSIT', 'CREDIT', 'INTEREST', 'DIVIDEND', 'INCOME')
      AND COALESCE(a.notes, '') NOT LIKE 'Starting balance · %'
      AND COALESCE(a.notes, '') NOT LIKE 'Balance adjustment · %'
      AND COALESCE(a.notes, '') NOT LIKE '↔️ In-transit transfer · %'
    ORDER BY a.activity_date DESC, a.id;
  `;

  type Raw = [string, string, string, number, string, string];
  const rows = queryNativeDb<Record<string, unknown>>(
    dbPath,
    'uncategorized',
    query,
    (parts) => (parts.length === 6
      ? { c0: parts[0], c1: parts[1], c2: parts[2], c3: parseFloat(parts[3]) || 0, c4: parts[4], c5: parts[5] }
      : null),
  );

  return rows.map((r) => {
    // node:sqlite returns column-named objects; the CLI fallback returns the
    // c0..c5 shape built above. Read positionally either way.
    const vals = Object.values(r) as Raw;
    return {
      activityId: String(vals[0]),
      wfAccountId: String(vals[1]),
      notes: String(vals[2]),
      amountCents: Math.round(Number(vals[3]) || 0),
      date: String(vals[4]).slice(0, 10),
      accountName: String(vals[5]),
    };
  });
}

/** One taxonomy's assignment on a transaction — a transaction can carry more
 *  than one (an income assignment AND a spending one), which is why this is
 *  its own type rather than a single categoryId/categoryName pair. */
export interface NativeAssignment {
  taxonomyId: string;
  categoryId: string;
  categoryName: string;
}

/** One categorized transaction, with every taxonomy's assignment attached. */
export interface NativeCategorizedTx {
  activityId: string;
  /** RAW stored note — callers clean via `descriptionFromComment`. */
  notes: string;
  amountCents: number;
  /** ISO date (yyyy-mm-dd), truncated from the stored value for DISPLAY —
   *  every row-label screen depends on this exact truncated form. */
  date: string;
  accountName: string;
  /** UPPERCASED (`WITHDRAWAL`, `DEPOSIT`, ...). Read, with `subtype` and
   *  `accountType`, by `/recategorize`'s refusal gate — the three together are
   *  what `assignabilityOf` needs to say whether Wealthfolio will accept a
   *  spending category on this row, decided BEFORE the move deletes anything
   *  (see the `reassign` case in ./categorize.ts). It is NOT what the list
   *  screen tells a credit from a spend by; that is still the category name,
   *  never the sign (see `renderList`'s comment in
   *  shared/categorize-menu.ts). */
  activityType: string;
  /** Every taxonomy's assignment on this activity, 1 or more entries. */
  assignments: NativeAssignment[];
  /** Raw stored subtype, '' when absent. Feeds the bucket predicate. */
  subtype: string;
  /** The account's Wealthfolio type (CASH, CREDIT_CARD, …), '' when unknown. */
  accountType: string;
}

/**
 * Categorized spending AND income rows in `[startInclusive, endExclusive)` —
 * the mirror image of `getNativeUncategorizedSpending` above: an INNER JOIN on
 * `activity_taxonomy_assignments` instead of a `LEFT JOIN ... IS NULL`, so the
 * two readers partition the same universe (same type list, same note-marker
 * exclusions — see that function's comment for why both spending AND income
 * types count, and why sync-written rows are excluded by note prefix).
 *
 * `/recategorize` needs every taxonomy's assignment on a row — a transaction
 * can carry both an income assignment and a spending one — so this returns
 * `assignments[]` rather than a single category. One row per assignment comes
 * back from SQL and is folded here in JS by `activity_id`; the ORDER BY keeps
 * an activity's rows consecutive, so the fold is a single linear pass.
 *
 * Every column is aliased: `tc.name` would otherwise collide with a same-named
 * column elsewhere in the row and `node:sqlite` (which keys results by column
 * name) would silently drop one — see `getNativeSpendingCategories` for the
 * bug this already shipped once.
 *
 * `activity_type`, `subtype` and `account_type` are the THREE columns the bucket
 * predicate reads (`BucketInput`, shared/cash-flow-bucket.ts) — all already on
 * hand from the same joined row, at no extra query cost. Nothing else about the
 * activity is selected: `account_id` and `currency` were selected here for the
 * per-row subtype write this release cut, and a column no caller reads is one a
 * later change can quietly start trusting.
 */
export function getNativeCategorizedSpending(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): NativeCategorizedTx[] {
  if (!dbPath || !existsSync(dbPath)) return [];
  if (!validDateBounds(startInclusive, endExclusive)) return [];

  const query = `
    SELECT a.id            AS activity_id,
           COALESCE(a.notes, '')            AS notes,
           ROUND(ABS(CAST(a.amount AS REAL)) * 100) AS amount_cents,
           substr(a.activity_date, 1, 10)   AS activity_date,
           COALESCE(ac.name, '')            AS account_name,
           UPPER(COALESCE(a.activity_type,'')) AS activity_type,
           ata.taxonomy_id                  AS taxonomy_id,
           ata.category_id                  AS category_id,
           COALESCE(tc.name, '')            AS category_name,
           COALESCE(a.subtype, '')          AS subtype,
           COALESCE(ac.account_type, '')    AS account_type
    FROM activities a
    JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
    LEFT JOIN accounts ac ON a.account_id = ac.id
    LEFT JOIN taxonomy_categories tc
           ON tc.id = ata.category_id AND tc.taxonomy_id = ata.taxonomy_id
    WHERE a.activity_date >= '${startInclusive}' AND a.activity_date < '${endExclusive}'
      AND UPPER(a.activity_type) IN ('WITHDRAWAL', 'FEE', 'TAX', 'DEPOSIT', 'CREDIT', 'INTEREST', 'DIVIDEND', 'INCOME')
      AND COALESCE(a.notes, '') NOT LIKE 'Starting balance · %'
      AND COALESCE(a.notes, '') NOT LIKE 'Balance adjustment · %'
      AND COALESCE(a.notes, '') NOT LIKE '↔️ In-transit transfer · %'
    ORDER BY a.activity_date DESC, a.id, ata.taxonomy_id;
  `;

  const rows = queryNativeDb<Record<string, unknown>>(
    dbPath,
    'categorized',
    query,
    (parts) => (parts.length === 11
      ? {
          c0: parts[0], c1: parts[1], c2: parseFloat(parts[2]) || 0, c3: parts[3],
          c4: parts[4], c5: parts[5], c6: parts[6], c7: parts[7], c8: parts[8],
          c9: parts[9], c10: parts[10],
        }
      : null),
  );

  // node:sqlite returns column-named objects; the CLI fallback returns the
  // c0..c10 shape built above. Read positionally either way. Rows for the
  // same activity are consecutive (ORDER BY ... a.id, ata.taxonomy_id), so
  // folding by activityId is a single linear pass, not a second sort.
  const byId = new Map<string, NativeCategorizedTx>();
  const result: NativeCategorizedTx[] = [];
  for (const r of rows) {
    const v = Object.values(r) as Array<string | number>;
    const activityId = String(v[0]);
    const assignment: NativeAssignment = {
      taxonomyId: String(v[6] ?? ''),
      categoryId: String(v[7] ?? ''),
      categoryName: String(v[8] ?? ''),
    };

    let tx = byId.get(activityId);
    if (!tx) {
      tx = {
        activityId,
        notes: String(v[1] ?? ''),
        amountCents: Math.round(Number(v[2]) || 0),
        date: String(v[3]).slice(0, 10),
        accountName: String(v[4] ?? ''),
        activityType: String(v[5] ?? ''),
        assignments: [],
        subtype: String(v[9] ?? ''),
        accountType: String(v[10] ?? ''),
      };
      byId.set(activityId, tx);
      result.push(tx);
    }
    tx.assignments.push(assignment);
  }
  return result;
}

/** One spending category as Wealthfolio defines it, plus whether it matters to
 *  this month's report. */
export interface NativeCategoryCatalogEntry {
  name: string;
  /** Parent's display name, or null for a top-level category. */
  parent: string | null;
  /** lucide-react export name, straight from Wealthfolio (`Fuel`, `Gamepad2`). */
  icon: string | null;
  /** Hex, straight from Wealthfolio. */
  color: string | null;
  hasBudget: boolean;
  hasSpend: boolean;
  /** Wealthfolio's budget group — `Needs`, `Wants`, `Savings`, … — from
   *  `budget_group_assignments`. Null when nothing has assigned this category,
   *  which is a real state its own Spending Tracker also shows. */
  group: string | null;
  /** The group's own icon (lucide name) and display order, so a grouped UI can
   *  match Wealthfolio's without a second query. */
  groupIcon: string | null;
  groupSort: number | null;
}

/**
 * EVERY spending category, whether or not money or a budget touched it.
 *
 * The addon's selection list used to come from `unionCategoryNames(spent, budget)`
 * — categories with a budget or spending — so a category like Personal Care
 * could not be selected until money happened to move through it. That conflated
 * two separate questions: "what can I choose to report on?" (all of them) and
 * "what is worth printing this month?" (budgeted or spent). This answers the
 * first; `hasBudget`/`hasSpend` let the caller answer the second.
 *
 * Scoped to `spending_categories`, so income and savings taxonomies cannot leak
 * into a spending report. Icon and colour come from Wealthfolio's own columns
 * rather than a mapping of ours, so a category it adds an icon for renders
 * correctly with no change here.
 */
export function getNativeCategoryCatalog(
  dbPath: string,
  yearMonth: string,
): NativeCategoryCatalogEntry[] {
  if (!dbPath || !existsSync(dbPath)) return [];
  if (!/^\d{4}-\d{2}$/.test(yearMonth)) return [];
  const start = `${yearMonth}-01`;
  const end = nextMonthStart(yearMonth);

  const query = `
    SELECT tc.name,
           COALESCE(parent.name, ''),
           COALESCE(tc.icon, ''),
           COALESCE(tc.color, ''),
           CASE WHEN EXISTS (
             SELECT 1 FROM budget_targets bt
             WHERE bt.category_id = tc.id
               AND (bt.period_key = '${yearMonth}' OR bt.period_key = 'default')
               AND CAST(bt.amount AS REAL) > 0
           ) THEN 1 ELSE 0 END,
           CASE WHEN EXISTS (
             SELECT 1 FROM activity_taxonomy_assignments ata
             JOIN activities a ON a.id = ata.activity_id
             WHERE ata.category_id = tc.id
               AND a.activity_date >= '${start}' AND a.activity_date < '${end}'
               AND UPPER(a.activity_type) IN ('WITHDRAWAL', 'FEE', 'TAX')
           ) THEN 1 ELSE 0 END,
           COALESCE(bg.name, ''), COALESCE(bg.icon, ''), COALESCE(bg.sort_order, -1)
    FROM taxonomy_categories tc
    LEFT JOIN taxonomy_categories parent ON tc.parent_id = parent.id
    LEFT JOIN budget_group_assignments bga
           ON bga.category_id = tc.id AND bga.taxonomy_id = tc.taxonomy_id
    LEFT JOIN budget_groups bg ON bg.id = bga.group_id
    WHERE tc.taxonomy_id = 'spending_categories'
    ORDER BY COALESCE(bg.sort_order, 9999), COALESCE(parent.name, tc.name),
             tc.parent_id IS NOT NULL, tc.sort_order, tc.name;
  `;

  const rows = queryNativeDb<Record<string, unknown>>(
    dbPath,
    'category catalog',
    query,
    (parts) => (parts.length === 9
      ? {
          c0: parts[0], c1: parts[1], c2: parts[2], c3: parts[3], c4: parts[4],
          c5: parts[5], c6: parts[6], c7: parts[7], c8: parts[8],
        }
      : null),
  );

  // node:sqlite yields column-named objects, the CLI fallback the c0..c5 shape
  // above; read positionally so one mapping serves both.
  return rows.map((r) => {
    const v = Object.values(r) as Array<string | number>;
    return {
      name: String(v[0]),
      parent: String(v[1] ?? '') || null,
      icon: String(v[2] ?? '') || null,
      color: String(v[3] ?? '') || null,
      hasBudget: Number(v[4]) === 1,
      hasSpend: Number(v[5]) === 1,
      group: String(v[6] ?? '') || null,
      groupIcon: String(v[7] ?? '') || null,
      groupSort: Number(v[8]) >= 0 ? Number(v[8]) : null,
    };
  }).filter((c) => !!c.name);
}

/** One spending category id, ready to send back to the assignment/rule APIs -
 *  `getNativeCategoryCatalog` deliberately drops ids (it only ever feeds a
 *  report label), so a caller that needs to WRITE a categorisation back to
 *  Wealthfolio needs this instead. */
export interface NativeSpendingCategory {
  id: string;
  name: string;
  parentId: string | null;
  /** Parent's display name, so a picker can show "Restaurants (Food & Dining)"
   *  without a second query. Null for a top-level category. */
  parentName: string | null;
}

/**
 * Every category in the `spending_categories` taxonomy, with ids - the
 * simpler, id-carrying sibling of `getNativeCategoryCatalog` above (which is
 * report-shaped and intentionally has no ids to send back to Wealthfolio).
 *
 * `tc.name` and `parent.name` are aliased to distinct column names
 * (`name`/`parent_name`): node:sqlite keys each result row by column name, so
 * two unaliased columns both called `name` collide into one JS property and
 * the child's own name is silently lost - this is why the same query in the
 * task brief needed the aliases added, not just copied.
 */
export function getNativeSpendingCategories(dbPath: string): NativeSpendingCategory[] {
  if (!dbPath || !existsSync(dbPath)) return [];

  const query = `
    SELECT tc.id AS id, tc.name AS name, tc.parent_id AS parent_id, parent.name AS parent_name
    FROM taxonomy_categories tc
    LEFT JOIN taxonomy_categories parent ON tc.parent_id = parent.id
    WHERE tc.taxonomy_id = 'spending_categories'
    ORDER BY COALESCE(parent.name, tc.name), tc.parent_id IS NOT NULL, tc.sort_order, tc.name;
  `;

  const rows = queryNativeDb<Record<string, unknown>>(
    dbPath,
    'spending categories',
    query,
    (parts) => (parts.length === 4
      ? { id: parts[0], name: parts[1], parent_id: parts[2], parent_name: parts[3] }
      : null),
  );

  // Read positionally so ONE mapping serves both paths, and normalise the two
  // spellings of NULL: node:sqlite gives `null`, the sqlite3 CLI fallback gives
  // an EMPTY STRING (its `|`-delimited output cannot spell null). `?? null`
  // alone therefore leaves `''` standing on the CLI path, and `''` is not
  // `null` — the menu's parent filter is `parentId === null`, so every category
  // would read as a child of a parent that does not exist and the picker would
  // offer no categories at all, silently. Same idiom as every neighbouring
  // reader (`String(v[n] ?? '') || null`).
  return rows.map((r) => {
    const v = Object.values(r) as Array<string | null>;
    return {
      id: String(v[0]),
      name: String(v[1]),
      parentId: String(v[2] ?? '') || null,
      parentName: String(v[3] ?? '') || null,
    };
  });
}

/** One category's spend at CHILD granularity. `child` is null when the money was
 *  booked directly on the parent, which keeps a breakdown's parts summing to the
 *  parent's total. */
export interface NativeSubcategorySpend {
  parent: string;
  child: string | null;
  spent: number;
}

/**
 * Spending split by subcategory, for the `breakdown` report mode.
 *
 * The rolled-up reader collapses children into parents inside SQL via
 * `COALESCE(parent.name, tc.name)`, so a Transportation envelope can never show
 * where the money actually went. This returns both levels and leaves the
 * rollup-vs-breakdown choice to the formatter — which is why the existing reader
 * is left exactly as it was: the default path must not change, and a second
 * query cannot regress the first.
 *
 * Shares `SPENDING_FROM` and `spendingWhere` with the rolled-up reader, so the
 * type filter and the transfers exclusion cannot drift between the two views —
 * a test pins that their totals agree.
 */
export function getNativeSubcategorySpending(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): NativeSubcategorySpend[] {
  if (!dbPath || !existsSync(dbPath)) return [];
  if (!validDateBounds(startInclusive, endExclusive)) return [];

  const query = `
    SELECT ${SPENDING_CATEGORY} as parent_name,
           CASE WHEN parent.name IS NULL THEN '' ELSE tc.name END as child_name,
                ROUND(SUM(${SPENDING_SIGNED_AMOUNT}), 2) as total_spent
    ${SPENDING_FROM}
    ${spendingWhere(startInclusive, endExclusive)}
    GROUP BY parent_name, child_name
    ORDER BY parent_name, child_name;
  `;

  const rows = queryNativeDb<Record<string, unknown>>(
    dbPath,
    'subcategory spending',
    query,
    (parts) => (parts.length === 3
      ? { c0: parts[0], c1: parts[1], c2: parseFloat(parts[2]) || 0 }
      : null),
  );

  return rows.map((r) => {
    const v = Object.values(r) as Array<string | number>;
    return {
      parent: String(v[0]),
      child: String(v[1] ?? '') || null,
      spent: Number(v[2]) || 0,
    };
  }).filter((r) => !!r.parent);
}

/** One Amazon-looking row as Wealthfolio stores it. */
export interface NativeAmazonRow {
  notes: string;
  date: string;
  amountCents: number;
  categorized: boolean;
}

/**
 * Every Amazon-looking activity, for checking the descriptor patterns against
 * REALITY rather than against a guess.
 *
 * The bank descriptor is the one input to this feature that cannot be derived,
 * inferred, or tested from a fixture — it is whatever the user's own bank writes,
 * and it varies by institution. `AMAZON.COM*MB3T81`, `AMZN Mktp US*XY7Q2`,
 * `AMAZON MKTPLACE PMTS` and `Amazon.com*RT4KL` are all real forms from different
 * issuers. If `isAmazonDescription` does not recognise the one a user actually
 * gets, nothing ever matches and there is NO error — Amazon charges simply stay
 * uncategorized forever, which looks identical to never having set the feature up.
 *
 * So this deliberately casts wider than the matcher does (a bare LIKE on
 * amazon/amzn, which SQLite matches case-insensitively) and lets the caller show
 * which rows the matcher would and would not accept. The gap between the two lists
 * is the answer.
 */
export function getNativeAmazonRows(dbPath: string, limit = 80): NativeAmazonRow[] {
  if (!dbPath || !existsSync(dbPath)) return [];
  const capped = Math.max(1, Math.floor(limit));

  const query = `
    SELECT COALESCE(a.notes, ''),
           substr(a.activity_date, 1, 10),
           ROUND(ABS(CAST(a.amount AS REAL)) * 100),
           CASE WHEN ata.activity_id IS NULL THEN 0 ELSE 1 END
    FROM activities a
    LEFT JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
    WHERE COALESCE(a.notes, '') LIKE '%amazon%'
       OR COALESCE(a.notes, '') LIKE '%amzn%'
    ORDER BY a.activity_date DESC
    LIMIT ${capped};
  `;

  return queryNativeDb<NativeAmazonRow>(
    dbPath,
    'amazon-descriptors',
    query,
    (parts) => (parts.length === 4
      ? {
          notes: parts[0],
          date: parts[1],
          amountCents: Number(parts[2]) || 0,
          categorized: parts[3] === '1',
        }
      : null),
  ).map((r: any) => (
    Array.isArray(r)
      ? { notes: r[0], date: r[1], amountCents: Number(r[2]) || 0, categorized: r[3] === 1 }
      : {
          notes: String(Object.values(r)[0] ?? ''),
          date: String(Object.values(r)[1] ?? ''),
          amountCents: Number(Object.values(r)[2]) || 0,
          categorized: Number(Object.values(r)[3]) === 1,
        }
  ));
}

/**
 * Spending in the window that has NO category at all — what Wealthfolio's own
 * breakdown shows as "Uncategorized".
 *
 * Invisible to every other reader here, because they INNER JOIN the assignment
 * table: a charge with no category has no assignment row. Wealthfolio counts it
 * against the month regardless, so the reports were quietly short by it (found
 * 2026-08-21: the app's monthly total ran ahead of the report's by exactly the
 * uncategorized charges).
 *
 * INTERNAL TRANSFERS ARE EXCLUDED, and that exclusion is the whole difficulty.
 * `TRANSFER_OUT` is an expense upstream, and a transfer between the user's own
 * accounts is uncategorizable (Wealthfolio calls it Neutral) — so it lands in
 * exactly the "no assignment" set this function selects. The first version of
 * this query reported $3,210.62 of "uncategorized spending" for a month whose
 * real figure was $20.76, the difference being a $3,000 transfer to a savings
 * account and two credit-card payments. A grouped activity is a paired
 * transfer leg (`sourceGroupId` is only ever written for pairs — see
 * `TRANSFER_GROUP_PREFIX`), so grouping is the marker to filter on.
 */
export function getNativeUncategorizedSpendingTotal(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
  /**
   * Activity IDs the user has dismissed from the "needs a category" list.
   *
   * Dismissing says "this is not spending I need to file" — but the total fed
   * the daily digest's pool regardless, so a dismissed charge went on
   * suppressing every category's figure with no line anywhere admitting why.
   * Excluded here rather than at the call site so the count and the total can
   * never disagree about which rows they describe.
   */
  dismissedActivityIds: readonly string[] = [],
): { count: number; total: number } {
  const empty = { count: 0, total: 0 };
  if (!dbPath || !existsSync(dbPath)) return empty;
  if (!validDateBounds(startInclusive, endExclusive)) return empty;

  // Ids come from an addon secret, so they are quoted defensively rather than
  // interpolated bare — and anything not matching an activity-id shape is
  // dropped instead of escaped, since a malformed id can only be junk.
  const safeIds = dismissedActivityIds.filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id));
  const dismissedClause = safeIds.length
    ? `AND a.id NOT IN (${safeIds.map((id) => `'${id}'`).join(',')})`
    : '';

  const query = `
    SELECT COUNT(*) as n,
           ROUND(SUM(ABS(CAST(a.amount AS REAL))), 2) as total
    FROM activities a
    JOIN accounts acc ON a.account_id = acc.id
    LEFT JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
    WHERE a.activity_date >= '${startInclusive}'
      AND a.activity_date < '${endExclusive}'
      AND ata.activity_id IS NULL
      AND COALESCE(a.source_group_id, '') = ''
      ${dismissedClause}
      AND (${SPENDING_SIGN}) > 0;
  `;

  const rows = queryNativeDb<{ n: number | string; total: number | string | null }>(
    dbPath,
    'uncategorized total',
    query,
    (parts) => (parts.length >= 2 ? { n: parts[0], total: parts[1] } : null),
  );
  const row = rows[0];
  if (!row) return empty;
  const count = typeof row.n === 'number' ? row.n : parseInt(String(row.n), 10) || 0;
  const total = typeof row.total === 'number' ? row.total : parseFloat(String(row.total ?? 0)) || 0;
  return { count, total };
}

/**
 * How many activities in the window a would-be mapping rule's pattern matches,
 * split by whether they are currently counted as spending.
 *
 * Exists so "mark one as a transfer" can say what it is about to do. The rule
 * that button writes is a `contains` match on the payee wording, and a generic
 * descriptor — `ACH WITHDRAWAL`, say — would retype EVERY such row as a
 * transfer, removing all of it from spending, silently and retroactively. A
 * count turns that from an accident into a choice.
 */
export function countRulePatternMatches(
  dbPath: string,
  pattern: string,
  startInclusive: string,
  endExclusive: string,
): { total: number; spending: number } {
  const empty = { total: 0, spending: 0 };
  if (!dbPath || !existsSync(dbPath)) return empty;
  if (!validDateBounds(startInclusive, endExclusive)) return empty;
  // Interpolated like every other bound in this file (the CLI fallback cannot
  // bind), so the pattern is escaped for SQL and stripped of LIKE wildcards —
  // a `%` in a descriptor would otherwise widen the match far past what the
  // rule itself would do, and understate nothing but overstate wildly.
  const safe = pattern.replace(/'/g, "''").replace(/[%_]/g, ' ');
  if (!safe.trim()) return empty;

  const query = `
    SELECT COUNT(*) as total,
           SUM(CASE WHEN (${SPENDING_SIGN}) > 0 THEN 1 ELSE 0 END) as spending
    FROM activities a
    JOIN accounts acc ON a.account_id = acc.id
    WHERE a.activity_date >= '${startInclusive}'
      AND a.activity_date < '${endExclusive}'
      AND LOWER(COALESCE(a.notes, '')) LIKE '%' || LOWER('${safe}') || '%';
  `;
  const rows = queryNativeDb<{ total: number | string; spending: number | string | null }>(
    dbPath,
    'rule pattern matches',
    query,
    (parts) => (parts.length >= 2 ? { total: parts[0], spending: parts[1] } : null),
  );
  const row = rows[0];
  if (!row) return empty;
  const num = (v: unknown) => (typeof v === 'number' ? v : parseInt(String(v ?? 0), 10) || 0);
  return { total: num(row.total), spending: num(row.spending) };
}
