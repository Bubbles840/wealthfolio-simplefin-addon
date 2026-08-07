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
    JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
    JOIN taxonomy_categories tc ON ata.category_id = tc.id
    LEFT JOIN taxonomy_categories parent ON tc.parent_id = parent.id`;

/** The rolled-up label: the parent category where there is one, else the
 *  category itself. Both readers select and filter on this same expression. */
const SPENDING_CATEGORY = `COALESCE(parent.name, tc.name)`;

function spendingWhere(startInclusive: string, endExclusive: string): string {
  return `
    WHERE a.activity_date >= '${startInclusive}'
      AND a.activity_date < '${endExclusive}'
      AND UPPER(a.activity_type) IN ('WITHDRAWAL', 'FEE', 'TAX')
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
      ROUND(SUM(ABS(CAST(a.amount AS REAL))), 2) as total_spent
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
 * readers above produce. Feeds the Saturday report's "biggest this week"
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
           ) THEN 1 ELSE 0 END
    FROM taxonomy_categories tc
    LEFT JOIN taxonomy_categories parent ON tc.parent_id = parent.id
    WHERE tc.taxonomy_id = 'spending_categories'
    ORDER BY COALESCE(parent.name, tc.name), tc.parent_id IS NOT NULL, tc.sort_order, tc.name;
  `;

  const rows = queryNativeDb<Record<string, unknown>>(
    dbPath,
    'category catalog',
    query,
    (parts) => (parts.length === 6
      ? { c0: parts[0], c1: parts[1], c2: parts[2], c3: parts[3], c4: parts[4], c5: parts[5] }
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
    };
  }).filter((c) => !!c.name);
}
