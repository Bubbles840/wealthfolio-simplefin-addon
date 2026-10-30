/**
 * companion/src/sqlite-native.ts
 *
 * Reads Wealthfolio's native SQLite database (wealthfolio.db) directly
 * for 100% exact, native category budget allocations and spent totals.
 */

import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import { descriptionFromComment, PENDING_SUFFIX as PENDING_NOTE_SUFFIX } from '../../shared/sync-core.js';
import { IN_TRANSIT_COMMENT_PREFIX } from '../../shared/reconcile.js';
import { cashSignSql } from '../../shared/audit-ledger.js';
import { CLI_SEPARATOR, isDay, isTrue, NOTES, shiftDay, SPENDING_BUDGET_TARGET_FILTER, tail, TOP_CATEGORY_CTE } from './sqlite-cli-helpers.js';
import { spendLines, topCategoryId, SPENDING_TAXONOMY, type SpendLine, type SpendRow } from '../../shared/wf-spending.js';

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
  /** The sqlite3 CLI's column separator for this query's fallback. Default
   *  `|`; a query whose free text can contain one passes an unambiguous one. */
  separator = '|',
): Row[] {
  return tryQueryNativeDb(dbPath, label, query, fromCliParts, separator) ?? [];
}

/** Thrown by the story readers (1.61) when the database cannot be read: they
 *  must tell "could not look" from "nothing there", which `[]` cannot. */
export class NativeDbUnreadableError extends Error {
  constructor(what: string) {
    super(`Could not read the Wealthfolio database (${what})`);
    this.name = 'NativeDbUnreadableError';
  }
}

/** `queryNativeDb`, except a database that is not there or that every path
 *  failed to read throws `NativeDbUnreadableError`. Exported for the audits'
 *  readers (sqlite-audit.ts, 2c). */
export function queryNativeDbStrict<Row>(
  dbPath: string,
  label: string,
  query: string,
  fromCliParts: (parts: string[]) => Row | null,
  separator = '|',
  /** The sqlite3 CLI's output buffer, in bytes, for a read whose output can
   *  pass execFileSync's 1 MB default (the audits read the whole ledger).
   *  Absent: the default. */
  maxBuffer?: number,
): Row[] {
  if (!dbPath || !existsSync(dbPath)) throw new NativeDbUnreadableError(`${label}: no database at ${dbPath || '(unset)'}`);
  const rows = tryQueryNativeDb(dbPath, label, query, fromCliParts, separator, maxBuffer);
  if (rows === null) throw new NativeDbUnreadableError(label);
  return rows;
}

/**
 * The URIs a read tries, in order. The `immutable=1` snapshot ignores the
 * write-ahead log and has been seen two days stale, so a read that must see
 * writes made seconds ago passes `liveOnly`: better unread than stale.
 */
export function nativeDbUris(dbPath: string, liveOnly = false): string[] {
  if (dbPath.startsWith('file:')) return [dbPath];
  return [
    `file:${dbPath}?mode=ro`,
    `file:${dbPath}?mode=ro&readonly_shm=1`,
    ...(liveOnly ? [] : [`file:${dbPath}?immutable=1`]),
  ];
}

/** The two-path read behind both: null — not [] — when every path failed. */
function tryQueryNativeDb<Row>(
  dbPath: string,
  label: string,
  query: string,
  fromCliParts: (parts: string[]) => Row | null,
  /** The sqlite3 CLI's column separator for this query's fallback. Default
   *  `|`; a query whose free text can contain one passes an unambiguous one. */
  separator = '|',
  maxBuffer?: number,
  /** Skip the `immutable=1` snapshot (see `nativeDbUris`). The CLI fallback
   *  opens the file normally, which reads the log or fails. */
  liveOnly = false,
): Row[] | null {
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
  const uris = nativeDbUris(dbPath, liveOnly);
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
    // No shell: the query can carry typed chat text (rule patterns), so it must
    // reach sqlite3 as a single argv element.
    // The query goes through verbatim, newlines and all: execFileSync passes it
    // as ONE argv element, and sqlite3 reads it line by line, so a `--` comment
    // ends at its own line. Flattening it onto one line made the comment in
    // `spendingWhere` swallow the taxonomy filter and the GROUP BY, and the
    // uncategorized reader's swallow every filter after it.
    const args = separator === '|' ? [dbPath, query] : ['-separator', separator, dbPath, query];
    // stderr piped, not inherited: the caught error carries it, and the
    // console line below reports it once.
    const output = execFileSync('sqlite3', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(maxBuffer ? { maxBuffer } : {}),
    });
    const rows: Row[] = [];
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = fromCliParts(trimmed.split(separator));
      if (row) rows.push(row);
    }
    return rows;
  } catch (err) {
    console.error(`[simplefin-sync] Failed to read native sqlite ${label}:`, err);
    return null;
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
 * Wealthfolio's own spending classification, transcribed from upstream —
 * `docs/upstream-spending-buckets.md` §2 quotes the Rust with line numbers.
 * Since 1.62 every spending FIGURE comes from shared/wf-spending.ts (the
 * effective type, linked transfers, filings, exclusions, the local date);
 * this SQL form is left only to the rule preview's count
 * (`countRulePatternMatches`).
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

/**
 * Only activities in accounts Wealthfolio tracks for spending — the scope it
 * enforces on every category write (`ensure_activity_in_spending_scope`,
 * crates/spending cash_activities/service.rs: "Activity account is not opted
 * into spending tracking") and the only accounts its own totals read. Applied
 * to the needs-a-category list (the spending figures apply the same scope
 * through shared/wf-spending.ts).
 *
 * Without it the needs-a-category list offered rows nobody could file — live
 * 2026-10-10, six Robinhood cashback deposits failed on every attempt.
 *
 * Settings are read exactly as upstream reads them (settings/service.rs): no
 * `spending.enabled` row means OFF, and a missing or unparsable account list
 * means NO accounts. Wealthfolio files nothing in either state, so listing
 * nothing is the matching answer, not a lost signal.
 */
const IN_SPENDING_SCOPE = `
      AND (SELECT setting_value FROM app_settings WHERE setting_key = 'spending.enabled') = 'true'
      AND a.account_id IN (
        SELECT value FROM json_each((
          SELECT CASE WHEN json_valid(setting_value) THEN setting_value ELSE '[]' END
          FROM app_settings WHERE setting_key = 'spending.account_ids')))`;

/**
 * Not one half of a transfer whose other half already waits in another
 * account: an UNLINKED transfer-typed row there — the sync's in-transit
 * placeholder included — for the same amount to the cent, moving money the
 * opposite way, within the pairing window (TRANSFER_MATCH_WINDOW_SECONDS, 5
 * days). Applied to the needs-a-category list, like IN_SPENDING_SCOPE — the
 * spending figures count such a row, as Wealthfolio does (1.62).
 *
 * Live 2026-10-10: a $691.29 card payment. The card's half was typed as an
 * in-transit TRANSFER_IN, but PNC's half was still pending ("ACH DEBIT
 * ROBINHOOD CCB") and pending rows are never paired, so it sat in the
 * needs-a-category list as a $691 purchase, one tap from being filed as
 * spending.
 *
 * Read-only and self-limiting. Once the halves link both are transfers
 * anyway; if they never do, the placeholder expires into a plain
 * deposit/withdrawal after 10 days and the charge is listed again. The cost
 * accepted: a genuine purchase of exactly the same amount within 5 days of an
 * unrelated unlinked transfer is held back until that transfer links.
 */
const NOT_AWAITING_TRANSFER_HALF = `
      AND NOT EXISTS (
        SELECT 1 FROM activities b
        WHERE b.account_id <> a.account_id
          AND COALESCE(b.source_group_id, '') = ''
          AND UPPER(b.activity_type) = CASE UPPER(a.activity_type)
                WHEN 'WITHDRAWAL' THEN 'TRANSFER_IN'
                WHEN 'DEPOSIT' THEN 'TRANSFER_OUT'
                WHEN 'CREDIT' THEN 'TRANSFER_OUT' END
          AND ROUND(ABS(CAST(b.amount AS REAL)) * 100) = ROUND(ABS(CAST(a.amount AS REAL)) * 100)
          AND ABS(julianday(substr(b.activity_date, 1, 10)) - julianday(substr(a.activity_date, 1, 10))) <= 5)`;

/**
 * Every account's balance, computed from its own activities.
 *
 * Exists because Wealthfolio cannot be asked. `/valuations/latest` returns rows
 * for CASH accounts only — measured live: six accounts, two rows — and
 * `/accounts` carries no balance at all (the field exists on the SDK's
 * TypeScript `Account` type but arrives `undefined` from the self-hosted
 * server). So a credit card has no figure for the sync to compare SimpleFin
 * against, which is why the starting-balance correction has never run on one,
 * and why a card carried a $235.40 opening gap for five months with no alert.
 *
 * The sign table is `typeCashSign` (shared/audit-ledger.ts) through
 * `cashSignSql` - Wealthfolio 3.8's `type_directed_cash_effect`, including its
 * one account-dependent exception: INTEREST is income on a brokerage and a
 * charge on a credit card (`resolve_cash_with_account_context`). Since 1.64
 * (R14) it signs the EFFECTIVE type (override first), as Wealthfolio and the
 * app's own total do; that corrects a card holding an overridden row, which the
 * raw type used to sign backwards. Since 3.8 `amount` is the final cash
 * and `fee` is informational, so `fee` is deliberately absent from the
 * arithmetic — adding it back would double-count every charge.
 *
 * PENDING ROWS ARE EXCLUDED, and that is the load-bearing part. SimpleFin
 * reports a card's POSTED balance, so counting rows that have not settled
 * reports timing as drift — and worse, feeds that difference into a
 * starting-balance correction, which writes real money into the ledger.
 * Measured live: one card's posted total matched SimpleFin to the cent while
 * its two pending charges accounted for the entire apparent $87.54 gap.
 *
 * An account holding an IN-FLIGHT TRANSFER is omitted entirely, for the same
 * reason one step further on. A transfer that has posted at one end and not the
 * other is in this ledger and not in SimpleFin's balance, so the two are
 * measuring different moments and their difference is pure timing. Live on
 * 2026-09-12: a $471.74 card payment left the bank and had not reached the
 * card, showing as a $208.78 gap that would have been written into the ledger
 * as a fabricated starting balance. Omission is the right shape for "no
 * trustworthy figure" here because it is the contract the valuations API
 * already has — a caller reads a missing entry as "cannot check this account
 * right now", and the correction simply waits for a settled run.
 */
export function getNativeAccountBalances(dbPath: string, opts: { liveOnly?: boolean } = {}): Map<string, number> {
  const out = new Map<string, number>();
  if (!dbPath || !existsSync(dbPath)) return out;

  const T = hasActivityTypeOverride(dbPath)
    ? "UPPER(COALESCE(NULLIF(TRIM(a.activity_type_override), ''), a.activity_type, ''))"
    : "UPPER(COALESCE(a.activity_type, ''))";
  const query = `
    SELECT a.account_id,
           ROUND(SUM(
             (${cashSignSql(T, "UPPER(COALESCE(acc.account_type, ''))")}) * ABS(CAST(COALESCE(a.amount, '0') AS REAL))
           ), 2) AS balance
    FROM activities a
    JOIN accounts acc ON a.account_id = acc.id
    WHERE COALESCE(a.notes, '') NOT LIKE '%${PENDING_NOTE_SUFFIX}'
      AND NOT EXISTS (
        SELECT 1 FROM activities f
        WHERE f.account_id = a.account_id
          AND COALESCE(f.notes, '') LIKE '${IN_TRANSIT_COMMENT_PREFIX}%'
      )
    GROUP BY a.account_id;
  `;
  const rows = tryQueryNativeDb<{ account_id: string; balance: number | string }>(
    dbPath,
    'account balances',
    query,
    (parts) => (parts.length >= 2 ? { account_id: parts[0], balance: parseFloat(parts[1]) || 0 } : null),
    '|',
    undefined,
    !!opts.liveOnly,
  ) ?? [];
  for (const row of rows) {
    const value = typeof row.balance === 'number' ? row.balance : parseFloat(String(row.balance ?? '0'));
    if (Number.isFinite(value)) out.set(String(row.account_id), value);
  }
  return out;
}

/**
 * The spending lines the lenient readers below add up (1.62): Wealthfolio's
 * own definition (shared/wf-spending.ts), on its local days. Null — never
 * "nothing spent" — when the database is missing, the bounds are malformed or
 * a read failed; those readers then answer empty, as they always have.
 */
function spendLinesOrNull(dbPath: string, startInclusive: string, endExclusive: string): ReturnType<typeof readSpendLines> | null {
  if (!dbPath || !existsSync(dbPath) || !validDateBounds(startInclusive, endExclusive)) return null;
  try {
    return readSpendLines(dbPath, startInclusive, endExclusive);
  } catch (err) {
    console.error('[simplefin-sync] Failed to read spending:', err);
    return null;
  }
}

const toDollars = (cents: number) => Math.round(cents) / 100;

/**
 * Spending per top-level category over Wealthfolio's local days
 * `[startInclusive, endExclusive)`, in dollars: the categorized part of what
 * its Spending page counts (shared/wf-spending.ts). The uncategorized part is
 * `getNativeUncategorizedSpendingTotal`. A filing on a category the database
 * no longer names is left out of the categories.
 */
export function getNativeWealthfolioSpendingBetween(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): Record<string, number> {
  const read = spendLinesOrNull(dbPath, startInclusive, endExclusive);
  if (!read) return {};
  const cents = new Map<string, number>();
  for (const line of read.lines) {
    for (const a of line.allocations) {
      const name = topCategoryName(a.categoryId, read.settings);
      if (name) cents.set(name, (cents.get(name) ?? 0) + a.cents);
    }
  }
  return Object.fromEntries([...cents].map(([name, c]) => [name, toDollars(c)]));
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
 * The `limit` biggest INDIVIDUAL spending transactions in Wealthfolio's local
 * days `[startInclusive, endExclusive)` — largest first, once per category
 * each counts under — rather than the per-category rollup. Feeds the weekly
 * report's "biggest this week" section, which exists to say WHY the month's
 * remaining figure moved. From the same lines as
 * `getNativeWealthfolioSpendingBetween`, so the list can only ever contain
 * spending the headline total also counted. The description is the stored
 * note with the bookkeeping decorations taken off (`descriptionFromComment`).
 * A non-positive or non-finite `limit` returns `[]` without touching the
 * database.
 */
export function getNativeWealthfolioTopSpending(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
  limit: number,
): NativeSpendingTransaction[] {
  const n = Number.isFinite(limit) ? Math.floor(limit) : 0;
  if (n < 1) return [];
  const read = spendLinesOrNull(dbPath, startInclusive, endExclusive);
  if (!read) return [];
  // EXPENSES only, per category it counts under. "Biggest spends this week"
  // is a list of purchases; a large refund is money coming back and would
  // head the list as though it were the week's worst damage.
  const spends: Array<{ cents: number; notes: string; categoryName: string }> = [];
  for (const line of read.lines) {
    for (const a of line.allocations) {
      const categoryName = topCategoryName(a.categoryId, read.settings);
      if (a.cents > 0 && categoryName) spends.push({ cents: a.cents, notes: line.row.notes, categoryName });
    }
  }
  return spends.sort((x, y) => y.cents - x.cents).slice(0, n).map((s) => ({
    amount: toDollars(s.cents),
    description: descriptionFromComment(s.notes),
    categoryName: s.categoryName,
  }));
}

/**
 * Returns native category budget targets from wealthfolio.db for a given month or default.
 */
export function getNativeWealthfolioBudgets(dbPath: string, yearMonth: string): Record<string, number> {
  if (!dbPath || !existsSync(dbPath)) return {};

  const query = `
    WITH RECURSIVE ${TOP_CATEGORY_CTE}, ranked_budgets AS (
      SELECT
        category_id,
        CAST(amount AS REAL) as amount,
        ROW_NUMBER() OVER (
          PARTITION BY category_id
          ORDER BY (period_key = '${yearMonth}') DESC, updated_at DESC
        ) as rn
      FROM budget_targets
      WHERE (period_key = '${yearMonth}' OR period_key = 'default') AND ${SPENDING_BUDGET_TARGET_FILTER}
    )
    SELECT
      top.name as parent_category,
      ROUND(SUM(rb.amount), 2) as total_budget
    FROM ranked_budgets rb
    JOIN top ON top.start_id = rb.category_id
    WHERE rb.rn = 1
    GROUP BY top.name;
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
  /** Which way the money moved, derived from TYPE + account (the sync stores
   *  positive magnitudes; the activity type carries direction in Wealthfolio):
   *  out = withdrawals/fees/taxes and card interest, in = everything else,
   *  card credits (refunds — money back) included. Drives the +/− and color
   *  everywhere rows are listed. */
  direction: 'in' | 'out';
  /** Whether the INCOME taxonomy is the legal filing for this row — upstream's
   *  bucket rule (cash deposits/interest/income/dividends), NOT the same
   *  question as `direction`: a card credit is money in but a spending-bucket
   *  refund, and offering it income categories would offer only 400s. */
  incomeEligible: boolean;
  /** The stored activity type, upper-cased (1.62): only a posted DEPOSIT can be filed as a payback. */
  activityType: string;
  /** Whether the stored note marks the row pending. */
  pending: boolean;
}

/** Whether `activities` has Wealthfolio 3.8's `activity_type_override` column. */
function hasActivityTypeOverride(dbPath: string): boolean {
  const rows = queryNativeDb<Record<string, unknown>>(
    dbPath,
    'activity type override column',
    "SELECT COUNT(*) FROM pragma_table_info('activities') WHERE name = 'activity_type_override';",
    (parts) => (parts.length >= 1 ? { n: parts[0] } : null),
  );
  return Number(Object.values(rows[0] ?? {})[0]) > 0;
}

/**
 * Every account id in the database, archived ones included. With
 * `WEALTHFOLIO_PROFILE_ID` set (#50) this is how the companion proves the file
 * it reads is the profile the API serves before anything uses that profile.
 * Strict: a file that cannot be read throws, never "no accounts".
 */
export function getNativeAccountIds(dbPath: string): string[] {
  return queryNativeDbStrict<Record<string, unknown>>(
    dbPath, 'account ids',
    'SELECT id AS id FROM accounts ORDER BY id;',
    (parts) => (parts.length >= 1 ? { id: parts[0] } : null),
  ).map((r) => String(Object.values(r)[0]));
}

/** Whether the database has the spending module's split lines (Wealthfolio 3.8+). */
function hasSpendingSplits(dbPath: string): boolean {
  const rows = queryNativeDb<Record<string, unknown>>(
    dbPath,
    'spending splits table',
    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'spending_activity_splits';",
    (parts) => (parts.length >= 1 ? { n: parts[0] } : null),
  );
  return Number(Object.values(rows[0] ?? {})[0]) > 0;
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

  // The EFFECTIVE type (Wealthfolio 3.8+ keeps an override beside the stored one); a database
  // without the column reads the stored type.
  const T = hasActivityTypeOverride(dbPath)
    ? "UPPER(COALESCE(NULLIF(TRIM(a.activity_type_override), ''), a.activity_type, ''))"
    : "UPPER(COALESCE(a.activity_type, ''))";
  // A split row is filed on its lines and carries no assignment of its own.
  const NOT_SPLIT = hasSpendingSplits(dbPath)
    ? `AND NOT EXISTS (SELECT 1 FROM spending_activity_splits s WHERE s.activity_id = a.id AND s.taxonomy_id = '${SPENDING_TAXONOMY}')`
    : '';
  const query = `
    SELECT a.id, COALESCE(a.account_id, ''), COALESCE(a.notes, ''),
           ROUND(ABS(CAST(a.amount AS REAL)) * 100),
           substr(a.activity_date, 1, 10), COALESCE(ac.name, ''),
           CASE WHEN ${T} IN ('WITHDRAWAL', 'FEE', 'TAX')
                  OR (${T} = 'INTEREST' AND UPPER(COALESCE(ac.account_type, '')) = 'CREDIT_CARD')
                THEN 'out' ELSE 'in' END,
           CASE WHEN UPPER(COALESCE(ac.account_type, '')) = 'CASH'
                  AND ${T} IN ('DEPOSIT', 'INTEREST', 'INCOME', 'DIVIDEND')
                THEN 1 ELSE 0 END,
           ${T}
    FROM activities a
    LEFT JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
    LEFT JOIN accounts ac ON a.account_id = ac.id
    WHERE ata.activity_id IS NULL
      AND a.activity_date >= '${startInclusive}'
      AND a.activity_date < '${endExclusive}'
      -- Grouped rows are internal transfers, whatever type the leg wears — a
      -- linked pair can hold a WITHDRAWAL leg, and offering one for
      -- categorization (live, 2026-09-02: a paired Citi payment in /categorize)
      -- is exactly what this exclusion prevents. The TOTAL query always had it;
      -- the row list must agree with the count.
      AND COALESCE(a.source_group_id, '') = ''
      AND ${T} IN ('WITHDRAWAL', 'FEE', 'TAX', 'DEPOSIT', 'CREDIT', 'INTEREST', 'DIVIDEND', 'INCOME')
      AND COALESCE(a.notes, '') NOT LIKE 'Starting balance · %'
      AND COALESCE(a.notes, '') NOT LIKE 'Balance adjustment · %'
      AND COALESCE(a.notes, '') NOT LIKE '↔️ In-transit transfer · %'
      ${IN_SPENDING_SCOPE}
      ${NOT_AWAITING_TRANSFER_HALF}
      ${NOT_SPLIT}
    ORDER BY a.activity_date DESC, a.id;
  `;

  type Raw = [string, string, string, number, string, string, string, number | string, string];
  const rows = queryNativeDb<Record<string, unknown>>(
    dbPath,
    'uncategorized',
    query,
    (parts) => (parts.length === 9
      ? { c0: parts[0], c1: parts[1], c2: parts[2], c3: parseFloat(parts[3]) || 0, c4: parts[4], c5: parts[5], c6: parts[6], c7: parts[7], c8: parts[8] }
      : null),
  );

  return rows.map((r) => {
    // node:sqlite returns column-named objects; the CLI fallback returns the
    // c0..c8 shape built above. Read positionally either way.
    const vals = Object.values(r) as Raw;
    return {
      activityId: String(vals[0]),
      wfAccountId: String(vals[1]),
      notes: String(vals[2]),
      amountCents: Math.round(Number(vals[3]) || 0),
      date: String(vals[4]).slice(0, 10),
      accountName: String(vals[5]),
      direction: (String(vals[6]) === 'out' ? 'out' : 'in') as 'in' | 'out',
      incomeEligible: String(vals[7]) === '1',
      activityType: String(vals[8] ?? '').toUpperCase(),
      pending: String(vals[2]).endsWith(PENDING_NOTE_SUFFIX),
    };
  });
}

/** A labelled Amazon charge a RULE filed, with the category the rule chose —
 *  the "before" the change log records when the label's category replaces it. */
export interface NativeRuleCategorizedAmazonRow {
  activityId: string;
  notes: string;
  wfAccountId: string;
  accountName: string;
  amountCents: number;
  /** ISO date (yyyy-mm-dd). */
  date: string;
  direction: 'in' | 'out';
  categoryId: string;
  /** '' when the category row is missing. */
  categoryName: string;
}

/**
 * Amazon charges the order emails have labelled (`· Amazon: <label>` in the
 * note) whose spending category was set by a categorization RULE — the
 * fallback `fileAmazonCharges` replaces with the label's category.
 */
export function getNativeRuleCategorizedAmazonRows(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): NativeRuleCategorizedAmazonRow[] {
  if (!dbPath || !existsSync(dbPath)) return [];
  if (!validDateBounds(startInclusive, endExclusive)) return [];
  const query = `
    SELECT a.id AS activity_id, COALESCE(a.notes, '') AS notes, COALESCE(a.account_id, '') AS account_id,
           COALESCE(ac.name, '') AS account_name, ROUND(ABS(CAST(a.amount AS REAL)) * 100) AS amount_cents,
           substr(a.activity_date, 1, 10) AS activity_date,
           CASE WHEN UPPER(a.activity_type) IN ('WITHDRAWAL', 'FEE', 'TAX')
                  OR (UPPER(a.activity_type) = 'INTEREST' AND UPPER(COALESCE(ac.account_type, '')) = 'CREDIT_CARD')
                THEN 'out' ELSE 'in' END AS direction,
           COALESCE(ata.category_id, '') AS category_id, COALESCE(tc.name, '') AS category_name
    FROM activities a
    JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
    LEFT JOIN accounts ac ON a.account_id = ac.id
    LEFT JOIN taxonomy_categories tc ON tc.id = ata.category_id AND tc.taxonomy_id = ata.taxonomy_id
    WHERE ata.taxonomy_id = 'spending_categories'
      AND LOWER(COALESCE(ata.source, '')) = 'rule'
      AND COALESCE(a.notes, '') LIKE '%· Amazon:%'
      AND a.activity_date >= '${startInclusive}'
      AND a.activity_date < '${endExclusive}'
    ORDER BY a.activity_date DESC, a.id;
  `;
  const rows = queryNativeDb<Record<string, unknown>>(
    dbPath,
    'rule-categorized-amazon',
    query,
    (parts) => (parts.length === 9
      ? { c0: parts[0], c1: parts[1], c2: parts[2], c3: parts[3], c4: parseFloat(parts[4]) || 0, c5: parts[5], c6: parts[6], c7: parts[7], c8: parts[8] }
      : null),
  );
  return rows.map((r) => {
    // Column-named objects from node:sqlite, c0..c8 from the CLI: positional either way.
    const v = Object.values(r);
    return {
      activityId: String(v[0]),
      notes: String(v[1]),
      wfAccountId: String(v[2]),
      accountName: String(v[3]),
      amountCents: Math.round(Number(v[4]) || 0),
      date: String(v[5]).slice(0, 10),
      direction: (String(v[6]) === 'out' ? 'out' : 'in') as 'in' | 'out',
      categoryId: String(v[7]),
      categoryName: String(v[8]),
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
 * Spending split by subcategory, for the `breakdown` report mode: each
 * category's top-level name and, when the money landed below it, the
 * subcategory's (`child` null when it was booked on the top-level category
 * itself, which keeps a breakdown's parts summing to its total). From the
 * same lines as the rolled-up reader, so the two views cannot drift — a test
 * pins that their totals agree.
 */
export function getNativeSubcategorySpending(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): NativeSubcategorySpend[] {
  const read = spendLinesOrNull(dbPath, startInclusive, endExclusive);
  if (!read) return [];
  const byKey = new Map<string, { parent: string; child: string | null; cents: number }>();
  for (const line of read.lines) {
    for (const a of line.allocations) {
      const top = topCategoryId(a.categoryId, read.settings.categoryParents);
      const parent = read.settings.categoryNames[top] ?? '';
      if (!parent) continue;
      const child = top === a.categoryId ? null : read.settings.categoryNames[a.categoryId] || null;
      const key = `${parent}\u0000${child ?? ''}`;
      const entry = byKey.get(key) ?? { parent, child, cents: 0 };
      entry.cents += a.cents;
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()]
    .sort((x, y) => (x.parent === y.parent ? (x.child ?? '').localeCompare(y.child ?? '') : x.parent.localeCompare(y.parent)))
    .map((e) => ({ parent: e.parent, child: e.child, spent: toDollars(e.cents) }));
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
 * Spending in the window that has NO spending category at all — what
 * Wealthfolio's Spending page shows as "Uncategorized", refunds netted —
 * as a count and a total in dollars (1.62: shared/wf-spending.ts).
 *
 * Since 1.62 a charge dismissed from the needs-a-category list counts, as
 * Wealthfolio counts it: dismissing says "I won't file this", not "this is not
 * spending". So does one half of a transfer whose other half waits in another
 * account, and the sync's own bookkeeping rows unless they are filed under
 * an excluded category (3.9+). The needs-a-category LIST still leaves all
 * three out (`getNativeUncategorizedSpending`).
 */
export function getNativeUncategorizedSpendingTotal(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): { count: number; total: number } {
  const read = spendLinesOrNull(dbPath, startInclusive, endExclusive);
  if (!read) return { count: 0, total: 0 };
  let count = 0;
  let cents = 0;
  for (const line of read.lines) {
    if (line.uncategorizedCents === 0) continue;
    // Only a charge is something to file; a refund just nets the amount.
    if (line.uncategorizedCents > 0) count += 1;
    cents += line.uncategorizedCents;
  }
  return { count, total: toDollars(cents) };
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

/**
 * Signed spend per (month, top-level category, account) — the report cube's
 * central series, from the same lines as every other spending reader
 * (shared/wf-spending.ts), so the Budget tab can never disagree with the
 * digest, or with Wealthfolio, about what a month cost. The month is
 * Wealthfolio's local one.
 */
function spendMatrixOf(read: ReturnType<typeof readSpendLines>): Array<{ month: string; category: string; accountId: string; amount: number }> {
  const byKey = new Map<string, { month: string; category: string; accountId: string; cents: number }>();
  for (const line of read.lines) {
    for (const a of line.allocations) {
      const category = topCategoryName(a.categoryId, read.settings);
      if (!category) continue;
      const key = `${line.month}\u0000${category}\u0000${line.row.accountId}`;
      const entry = byKey.get(key) ?? { month: line.month, category, accountId: line.row.accountId, cents: 0 };
      entry.cents += a.cents;
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].map((e) => ({ month: e.month, category: e.category, accountId: e.accountId, amount: toDollars(e.cents) }));
}

export function getNativeSpendMatrix(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): Array<{ month: string; category: string; accountId: string; amount: number }> {
  const read = spendLinesOrNull(dbPath, startInclusive, endExclusive);
  return read ? spendMatrixOf(read) : [];
}

/**
 * Suggested budgets' spend read (project 4): `getNativeSpendMatrix`'s series
 * — since 1.62 exactly what Wealthfolio's budget actuals count, its spending
 * accounts and excluded categories included (shared/wf-spending.ts). Strict:
 * a database that cannot be read throws `NativeDbUnreadableError` — never
 * "nothing spent".
 */
export function getNativeBudgetSpend(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): Array<{ month: string; category: string; accountId: string; amount: number }> {
  if (!validDateBounds(startInclusive, endExclusive)) throw new Error('Refusing the budget spend read: malformed date bounds');
  return spendMatrixOf(readSpendLines(dbPath, startInclusive, endExclusive));
}

/**
 * The earliest activity day ('YYYY-MM-DD') on the given accounts that can be
 * tracked for spending — CASH and CREDIT_CARD only, as upstream's
 * `account_supports_purpose` — how far back the ledger covers, so a new install's first 30 days are not averaged
 * over three months. Null: no activity at all. Strict (throws on an unreadable
 * database); the account ids are filtered in code, not interpolated.
 */
export function getNativeSpendingHistoryStart(dbPath: string, accountIds: readonly string[]): string | null {
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'history start',
    `SELECT COALESCE(a.account_id, '') AS account_id, MIN(substr(a.activity_date, 1, 10)) AS first_day
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     WHERE UPPER(acc.account_type) IN ('CASH', 'CREDIT_CARD') AND a.activity_date IS NOT NULL AND a.activity_date <> ''
     GROUP BY a.account_id;`,
    (parts) => (parts.length >= 2 ? { c0: parts[0], c1: parts[1] } : null),
    DRILL_CLI_SEPARATOR,
  );
  const wanted = new Set(accountIds);
  let first: string | null = null;
  for (const r of rows) {
    const [accountId, day] = Object.values(r) as [string, string];
    if (!wanted.has(String(accountId)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) continue;
    if (first === null || String(day) < first) first = String(day);
  }
  return first;
}

/**
 * Income per (month, account): deposits and interest on CASH accounts —
 * Wealthfolio's income classification minus everything that merely LOOKS like
 * income. `TRANSFER_IN` is deliberately absent (internal moves and card
 * payments must never read as income; the accepted cost is missing a
 * keyword-typed external transfer-in, per the spec), card credits are refunds
 * not income, and the two balance-marker note shapes are excluded because a
 * starting-balance row is a plain DEPOSIT that would otherwise book the
 * account's whole opening balance as one month's income.
 */
export function getNativeIncomeByMonthAccount(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): Array<{ month: string; accountId: string; amount: number }> {
  if (!dbPath || !existsSync(dbPath)) return [];
  if (!validDateBounds(startInclusive, endExclusive)) return [];
  const query = `
    SELECT strftime('%Y-%m', a.activity_date) as month,
           COALESCE(a.account_id, '') as account_id,
           ROUND(SUM(ABS(CAST(a.amount AS REAL))), 2) as amount
    FROM activities a
    JOIN accounts acc ON a.account_id = acc.id
    WHERE a.activity_date >= '${startInclusive}'
      AND a.activity_date < '${endExclusive}'
      AND UPPER(acc.account_type) = 'CASH'
      AND UPPER(a.activity_type) IN ('DEPOSIT', 'INTEREST')
      AND COALESCE(a.notes, '') NOT LIKE 'Starting balance · %'
      AND COALESCE(a.notes, '') NOT LIKE 'Balance adjustment · %'
    GROUP BY month, account_id;
  `;
  const rows = queryNativeDb<Record<string, unknown>>(
    dbPath,
    'income by month',
    query,
    (parts) => (parts.length === 3
      ? { c0: parts[0], c1: parts[1], c2: parseFloat(parts[2]) || 0 }
      : null),
  );
  return rows.map((r) => {
    const v = Object.values(r) as [string, string, number | string];
    return {
      month: String(v[0]),
      accountId: String(v[1]),
      amount: typeof v[2] === 'number' ? v[2] : parseFloat(String(v[2])) || 0,
    };
  }).filter((r) => r.month);
}

/**
 * Uncategorized spending per (month, account) — `getNativeUncategorizedSpendingTotal`'s
 * lines with two groupings, refunds netted, so the cube's uncategorized cells
 * and the digest's uncategorized total are one definition.
 */
export function getNativeUncategorizedByMonthAccount(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
  /** The report cube: a database that cannot be read throws instead of answering "nothing uncategorized". */
  strict = false,
): Array<{ month: string; accountId: string; amount: number }> {
  const read = strict ? readSpendLines(dbPath, startInclusive, endExclusive) : spendLinesOrNull(dbPath, startInclusive, endExclusive);
  if (!read) return [];
  const byKey = new Map<string, { month: string; accountId: string; cents: number }>();
  for (const line of read.lines) {
    if (line.uncategorizedCents === 0) continue;
    const key = `${line.month}\u0000${line.row.accountId}`;
    const entry = byKey.get(key) ?? { month: line.month, accountId: line.row.accountId, cents: 0 };
    entry.cents += line.uncategorizedCents;
    byKey.set(key, entry);
  }
  return [...byKey.values()].map((e) => ({ month: e.month, accountId: e.accountId, amount: toDollars(e.cents) }));
}

/**
 * Raw material for the merchant leaderboard: one row per spending
 * transaction — categorized AND uncategorized, since an unfiled charge is
 * still money at a merchant — with what it adds to spending (refunds
 * negative) and the stored note VERBATIM. Normalization happens in the cube
 * builder with `descriptionFromComment`, where it is tested.
 *
 * `strict` (the cash forecast, project 5): a database that cannot be read
 * throws NativeDbUnreadableError instead of answering "no rows" — the
 * forecast must tell "could not look" from "no bill charged".
 */
export function getNativeMerchantRows(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
  strict = false,
): Array<{ month: string; date: string; notes: string; amount: number; accountId: string }> {
  let read: ReturnType<typeof readSpendLines> | null;
  if (strict) {
    if (!validDateBounds(startInclusive, endExclusive)) throw new NativeDbUnreadableError(`merchant rows: bounds ${startInclusive}..${endExclusive}`);
    read = readSpendLines(dbPath, startInclusive, endExclusive);
  } else {
    read = spendLinesOrNull(dbPath, startInclusive, endExclusive);
  }
  if (!read) return [];
  // accountId: the subscription detector joins a renamed charge only on the same account (1.63, C1).
  return read.lines.map((line) => ({ month: line.month, date: line.day, notes: line.row.notes, amount: toDollars(line.cents), accountId: line.row.accountId }));
}

/** One drill-down row. Since 1.61 it carries what the cube needs to open the
 *  row's story and say who filed it: the activity and account ids, the LEAF
 *  category id (a rule files into it, not into the rolled-up parent), the
 *  assignment's source ('' when unrecorded) and the activity type. */
export interface NativeDrillRow {
  category: string;
  date: string;
  notes: string;
  amount: number;
  account: string;
  activityId: string;
  accountId: string;
  categoryId: string;
  source: string;
  activityType: string;
}

/** The sqlite3 CLI separator for the drill query: ASCII unit separator. */
export const DRILL_CLI_SEPARATOR = CLI_SEPARATOR;

/**
 * Drill-down rows: every categorized spending transaction in the window, once
 * per category it counts under, by its ROLLED-UP category — the same lines
 * the spend matrix uses, so a category's list always sums to the bar the
 * user clicked. Newest first; the cube builder caps per category.
 */
export function getNativeDrillRows(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): NativeDrillRow[] {
  const read = spendLinesOrNull(dbPath, startInclusive, endExclusive);
  if (!read) return [];
  const out: NativeDrillRow[] = [];
  const newestFirst = [...read.lines].sort((x, y) => (x.row.date === y.row.date ? (x.row.id < y.row.id ? -1 : 1) : x.row.date < y.row.date ? 1 : -1));
  for (const line of newestFirst) {
    for (const a of line.allocations) {
      const category = topCategoryName(a.categoryId, read.settings);
      if (!category) continue;
      out.push({
        category, date: line.day, account: line.row.accountName, amount: toDollars(a.cents),
        activityId: line.row.id, accountId: line.row.accountId, categoryId: a.categoryId, source: a.source,
        activityType: line.row.type, notes: line.row.notes,
      });
    }
  }
  return out;
}

/**
 * Money that bought nothing, per month: fees on any account plus interest
 * CHARGED — interest on a card. Interest on a cash account is the bank paying
 * the user and belongs to income, which is why the account type gates it.
 */
export function getNativeFeesInterestByMonth(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): Array<{ month: string; amount: number }> {
  if (!dbPath || !existsSync(dbPath)) return [];
  if (!validDateBounds(startInclusive, endExclusive)) return [];
  const query = `
    SELECT strftime('%Y-%m', a.activity_date) as month,
           ROUND(SUM(ABS(CAST(a.amount AS REAL))), 2) as amount
    FROM activities a
    JOIN accounts acc ON a.account_id = acc.id
    WHERE a.activity_date >= '${startInclusive}'
      AND a.activity_date < '${endExclusive}'
      AND (
        UPPER(a.activity_type) = 'FEE'
        OR (UPPER(a.activity_type) = 'INTEREST' AND UPPER(acc.account_type) = 'CREDIT_CARD')
      )
    GROUP BY month;
  `;
  const rows = queryNativeDb<Record<string, unknown>>(
    dbPath,
    'fees and interest',
    query,
    (parts) => (parts.length === 2 ? { c0: parts[0], c1: parseFloat(parts[1]) || 0 } : null),
  );
  return rows.map((r) => {
    const v = Object.values(r) as [string, number | string];
    return {
      month: String(v[0]),
      amount: typeof v[1] === 'number' ? v[1] : parseFloat(String(v[1])) || 0,
    };
  }).filter((r) => r.month !== '');
}

/**
 * Total spending per day — the pool burn-down's resolution: what Wealthfolio's
 * Spending page counts, categorized and uncategorized, on its local day.
 */
export function getNativeSpendDailyTotals(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
  /** The report cube: a database that cannot be read throws instead of answering "nothing spent". */
  strict = false,
): Array<{ date: string; amount: number }> {
  const read = strict ? readSpendLines(dbPath, startInclusive, endExclusive) : spendLinesOrNull(dbPath, startInclusive, endExclusive);
  if (!read) return [];
  const byDay = new Map<string, number>();
  for (const line of read.lines) byDay.set(line.day, (byDay.get(line.day) ?? 0) + line.cents);
  return [...byDay].map(([date, cents]) => ({ date, amount: toDollars(cents) }));
}

/**
 * Month-end valuation per account, from whichever valuation-history table
 * this Wealthfolio version keeps — discovered at read time, because the
 * table is upstream's private schema and no endpoint exposes its history.
 * Every miss (no table, unknown columns, any error) returns [], which the
 * cube renders as "accruing" rather than a guess. The candidate names and
 * columns come from upstream source; the live instance's actual shape gets
 * verified against the real database when this ships (see the plan).
 */
export function getNativeValuationByMonth(
  dbPath: string,
  months: string[],
): Array<{ month: string; accountId: string; amount: number }> {
  if (!dbPath || !existsSync(dbPath)) return [];
  const safeMonths = months.filter((m) => /^[0-9]{4}-[0-9]{2}$/.test(m));
  if (safeMonths.length === 0) return [];
  try {
    const tables = queryNativeDb<Record<string, unknown>>(
      dbPath,
      'valuation table discovery',
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('daily_account_valuation', 'account_valuations', 'valuations') LIMIT 1;`,
      (parts) => (parts.length >= 1 ? { c0: parts[0] } : null),
    );
    const table = tables[0] ? String(Object.values(tables[0])[0]) : null;
    if (!table) return [];
    const cols = queryNativeDb<Record<string, unknown>>(
      dbPath,
      'valuation columns',
      `PRAGMA table_info(${table});`,
      (parts) => (parts.length >= 2 ? { c0: parts[0], c1: parts[1] } : null),
    ).map((r) => String(Object.values(r)[1] ?? ''));
    const dateCol = ['valuation_date', 'date', 'as_of_date'].find((c) => cols.includes(c));
    const valueCol = ['total_value', 'market_value', 'total_portfolio_value'].find((c) => cols.includes(c));
    if (!dateCol || !valueCol) return [];
    const monthList = safeMonths.map((m) => `'${m}'`).join(',');
    const rows = queryNativeDb<Record<string, unknown>>(
      dbPath,
      'valuation history',
      `SELECT strftime('%Y-%m', ${dateCol}) as month, account_id, CAST(${valueCol} AS REAL) as amount, ${dateCol} as d
       FROM ${table}
       WHERE strftime('%Y-%m', ${dateCol}) IN (${monthList});`,
      (parts) => (parts.length === 4
        ? { c0: parts[0], c1: parts[1], c2: parseFloat(parts[2]) || 0, c3: parts[3] }
        : null),
    );
    // Month-END per (month, account): the latest dated row wins.
    const best = new Map<string, { month: string; accountId: string; amount: number; d: string }>();
    for (const r of rows) {
      const v = Object.values(r) as [string, string, number | string, string];
      const entry = {
        month: String(v[0]),
        accountId: String(v[1]),
        amount: typeof v[2] === 'number' ? v[2] : parseFloat(String(v[2])) || 0,
        d: String(v[3]),
      };
      const key = `${entry.month} ${entry.accountId}`;
      const prev = best.get(key);
      if (!prev || entry.d > prev.d) best.set(key, entry);
    }
    return Array.from(best.values()).map(({ month, accountId, amount }) => ({ month, accountId, amount }));
  } catch {
    return [];
  }
}

/**
 * getNativeSpendingCategories' income-taxonomy twin, for the /categorize
 * menu's income grid. A school grant check is not spending, and upstream
 * REFUSES a spending category on an income-bucket row — so a deposit's menu
 * must offer the set Wealthfolio will actually accept (live, 2026-09-02: a
 * $999 grant check was uncategorizable from Telegram). Same aliasing and
 * null-normalisation rules as the spending reader, for the same reasons.
 */
export function getNativeIncomeCategories(dbPath: string): NativeSpendingCategory[] {
  if (!dbPath || !existsSync(dbPath)) return [];

  const query = `
    SELECT tc.id AS id, tc.name AS name, tc.parent_id AS parent_id, parent.name AS parent_name
    FROM taxonomy_categories tc
    LEFT JOIN taxonomy_categories parent ON tc.parent_id = parent.id
    WHERE tc.taxonomy_id = 'income_sources'
    ORDER BY COALESCE(parent.name, tc.name), tc.parent_id IS NOT NULL, tc.sort_order, tc.name;
  `;

  const rows = queryNativeDb<Record<string, unknown>>(
    dbPath,
    'income categories',
    query,
    (parts) => (parts.length === 4
      ? { id: parts[0], name: parts[1], parent_id: parts[2], parent_name: parts[3] }
      : null),
  );

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

/**
 * The charges a categorization rule filed: spending assignments with source
 * "rule" in the rule's category, on rows whose note contains the rule's words
 * (case-insensitive, like the rule's own `contains` match). What "Undo rule +
 * un-file its N charges" counts and takes out. A category the person chose is
 * "manual" and is never in this list.
 *
 * Null when the database is not there — "unknown", never "none".
 */
export function getNativeRuleFiledActivityIds(dbPath: string, categoryId: string, pattern: string): string[] | null {
  if (!dbPath || !existsSync(dbPath)) return null;
  // Interpolated like every bound in this file (the CLI fallback cannot bind):
  // quotes doubled, LIKE wildcards neutralised.
  const cat = categoryId.replace(/'/g, "''");
  const safe = pattern.replace(/'/g, "''").replace(/[%_]/g, ' ');
  if (!cat || !safe.trim()) return [];
  const query = `
    SELECT a.id AS activity_id
    FROM activities a
    JOIN activity_taxonomy_assignments ata ON ata.activity_id = a.id
    WHERE ata.taxonomy_id = 'spending_categories'
      AND LOWER(COALESCE(ata.source, '')) = 'rule'
      AND ata.category_id = '${cat}'
      AND LOWER(COALESCE(a.notes, '')) LIKE '%' || LOWER('${safe}') || '%'
    ORDER BY a.activity_date DESC, a.id;
  `;
  const rows = queryNativeDb<{ activity_id: string }>(
    dbPath,
    'rule-filed activities',
    query,
    (parts) => (parts.length >= 1 && parts[0] ? { activity_id: parts[0] } : null),
  );
  return rows.map((r) => String(r.activity_id));
}

// ── "Why is this here?" (1.61) ───────────────────────────────────────────
// Strict readers: each throws NativeDbUnreadableError rather than answering
// [] for a database it could not read, because the story must say "couldn't
// read" there, never "none". Ids are interpolated like every bound in this
// file (the CLI fallback cannot bind): quotes doubled.

const sqlText = (s: string) => s.replace(/'/g, "''");

// CLI-fallback row parsers (split on the unit separator, so a `|` in an
// account name, a category name or a note cannot shift columns).
export function storyPartnerFromCliParts(parts: string[]): Record<string, unknown> | null {
  return parts.length >= 3 ? { c0: parts[0], c1: parts[1], c2: parts.slice(2).join(DRILL_CLI_SEPARATOR) } : null;
}
export function storyAssignmentFromCliParts(parts: string[]): Record<string, unknown> | null {
  return parts.length >= 4
    ? { c0: parts[0], c1: parts[1], c2: parts.slice(2, -1).join(DRILL_CLI_SEPARATOR), c3: parts[parts.length - 1] }
    : null;
}
export function storySearchRowFromCliParts(parts: string[]): Record<string, unknown> | null {
  return parts.length >= 7
    ? { c0: parts[0], c1: parts[1], c2: parseFloat(parts[2]) || 0, c3: parts[3], c4: parts[4], c5: parts[5], c6: parts.slice(6).join(DRILL_CLI_SEPARATOR) }
    : null;
}

/** One taxonomy's assignment on an activity, with what the story says of it. */
export interface NativeTxAssignment {
  taxonomyId: string;
  categoryId: string;
  categoryName: string;
  /** 'rule', 'manual', … ('' when unrecorded). */
  source: string;
}

/** An activity's account type and every assignment it holds, spending or not. */
export function getNativeTxDetails(dbPath: string, activityId: string): { accountType: string; assignments: NativeTxAssignment[] } {
  const id = sqlText(activityId);
  const account = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'story account',
    `SELECT COALESCE(acc.account_type, '') AS account_type FROM activities a LEFT JOIN accounts acc ON acc.id = a.account_id WHERE a.id = '${id}';`,
    (parts) => ({ account_type: parts[0] ?? '' }),
    DRILL_CLI_SEPARATOR,
  );
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'story assignments',
    `SELECT ata.taxonomy_id AS taxonomy_id, ata.category_id AS category_id, COALESCE(tc.name, '') AS category_name,
            COALESCE(ata.source, '') AS source
     FROM activity_taxonomy_assignments ata
     LEFT JOIN taxonomy_categories tc ON tc.id = ata.category_id
     WHERE ata.activity_id = '${id}'
     ORDER BY ata.taxonomy_id;`,
    storyAssignmentFromCliParts,
    DRILL_CLI_SEPARATOR,
  );
  return {
    accountType: String(Object.values(account[0] ?? {})[0] ?? ''),
    assignments: rows.map((r) => {
      const v = Object.values(r).map((x) => String(x ?? ''));
      return { taxonomyId: v[0], categoryId: v[1], categoryName: v[2], source: v[3] };
    }),
  };
}

/** The other activity in a transfer's group: its account and day. */
export function getNativeTxPartner(dbPath: string, groupId: string, activityId: string): { activityId: string; accountName: string; date: string } | null {
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'story partner',
    `SELECT b.id AS activity_id, substr(b.activity_date, 1, 10) AS activity_date, COALESCE(acc.name, '') AS account_name
     FROM activities b LEFT JOIN accounts acc ON acc.id = b.account_id
     WHERE b.source_group_id = '${sqlText(groupId)}' AND b.id <> '${sqlText(activityId)}'
     ORDER BY b.id LIMIT 1;`,
    storyPartnerFromCliParts,
    DRILL_CLI_SEPARATOR,
  );
  if (rows.length === 0) return null;
  const v = Object.values(rows[0]).map((x) => String(x ?? ''));
  return { activityId: v[0], date: v[1], accountName: v[2] };
}

/** One activity as `/why` searches it. */
export interface NativeTxSearchRow {
  activityId: string;
  date: string;
  absCents: number;
  activityType: string;
  accountName: string;
  accountType: string;
  /** The stored note, raw. */
  notes: string;
}

/** Every activity in every account Wealthfolio has not archived — all of
 *  history, newest first. `/why` filters it in memory. */
export function getNativeTxSearchRows(dbPath: string): NativeTxSearchRow[] {
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'story search',
    `SELECT a.id AS activity_id, substr(a.activity_date, 1, 10) AS activity_date,
            ROUND(ABS(CAST(a.amount AS REAL)) * 100) AS abs_cents, UPPER(COALESCE(a.activity_type, '')) AS activity_type,
            COALESCE(acc.account_type, '') AS account_type, COALESCE(acc.name, '') AS account_name, COALESCE(a.notes, '') AS notes
     FROM activities a LEFT JOIN accounts acc ON acc.id = a.account_id
     WHERE COALESCE(acc.is_archived, 0) = 0
     ORDER BY a.activity_date DESC, a.id;`,
    storySearchRowFromCliParts,
    DRILL_CLI_SEPARATOR,
  );
  return rows.map((r) => {
    const v = Object.values(r);
    return {
      activityId: String(v[0]),
      date: String(v[1]),
      absCents: Math.round(Number(v[2]) || 0),
      activityType: String(v[3]),
      accountType: String(v[4] ?? ''),
      accountName: String(v[5] ?? ''),
      notes: String(v[6] ?? ''),
    };
  });
}

/** The sqlite3 CLI's output buffer for the spending reads (the audits' too):
 *  they return every row of a window, past execFileSync's 1 MB default. */
export const SPEND_CLI_MAX_BUFFER = 256 * 1024 * 1024;

/** CLI line → the spending row read's ten columns (the note last). */
export function spendRowFromCliParts(parts: string[]): Record<string, unknown> | null {
  if (parts.length < 10 || !Number.isFinite(parseFloat(parts[6]))) return null;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < 9; i++) out[`c${i}`] = parts[i];
  out.c9 = tail(parts, 9);
  return out;
}

/**
 * Every activity whose STORED date is in `[startDay, endDayExclusive)` (both
 * YYYY-MM-DD), with its account and every spending-taxonomy filing and split
 * line — the rows shared/wf-spending.ts counts. A caller placing rows by
 * Wealthfolio's local date reads a day wider on each side (`readSpendLines`).
 *
 * Strict: a database that cannot be read throws NativeDbUnreadableError, never
 * "nothing spent". Every table and column read is Wealthfolio's own on 3.8,
 * 3.9 and 3.10 (`spending_activity_splits` arrived with the spending module,
 * 3.8). The sqlite3 CLI fallback splits on the unit separator, with the free
 * text last; the account names are their own read for the same reason.
 */
export function getNativeSpendRows(dbPath: string, startDay: string, endDayExclusive: string): SpendRow[] {
  // Interpolated (the CLI fallback cannot bind), so validated, never trusted.
  if (!isDay(startDay) || !isDay(endDayExclusive)) throw new Error(`malformed spending bounds: ${startDay}..${endDayExclusive}`);
  const window = `a.activity_date >= '${startDay}' AND a.activity_date < '${endDayExclusive}'`;
  const accounts = queryNativeDbStrict<Record<string, unknown>>(
    dbPath, 'spending accounts',
    `SELECT acc.id AS id, UPPER(COALESCE(acc.account_type, '')) AS account_type, COALESCE(acc.name, '') AS name FROM accounts acc ORDER BY acc.id;`,
    (parts) => (parts.length >= 3 ? { c0: parts[0], c1: parts[1], c2: tail(parts, 2) } : null),
    DRILL_CLI_SEPARATOR, SPEND_CLI_MAX_BUFFER,
  );
  const accountById = new Map(accounts.map((r) => {
    const v = Object.values(r);
    return [String(v[0]), { type: String(v[1] ?? ''), name: String(v[2] ?? '') }];
  }));
  const activities = queryNativeDbStrict<Record<string, unknown>>(
    dbPath, 'spending rows',
    `SELECT a.id AS id, a.activity_date AS activity_date, COALESCE(a.account_id, '') AS account_id,
            UPPER(COALESCE(a.activity_type, '')) AS activity_type, COALESCE(a.activity_type_override, '') AS type_override,
            UPPER(COALESCE(a.subtype, '')) AS subtype, ROUND(ABS(CAST(COALESCE(a.amount, '0') AS REAL)) * 100) AS abs_cents,
            COALESCE(a.source_group_id, '') AS grp, UPPER(COALESCE(a.currency, '')) AS ccy, ${NOTES} AS notes
     FROM activities a
     WHERE ${window}
     ORDER BY a.activity_date, a.id;`,
    spendRowFromCliParts, DRILL_CLI_SEPARATOR, SPEND_CLI_MAX_BUFFER,
  );
  const filings = queryNativeDbStrict<Record<string, unknown>>(
    dbPath, 'spending filings',
    `SELECT ata.activity_id AS activity_id, COALESCE(ata.id, '') AS id, ata.category_id AS category_id,
            COALESCE(ata.created_at, '') AS created_at, COALESCE(ata.source, '') AS source
     FROM activity_taxonomy_assignments ata JOIN activities a ON a.id = ata.activity_id
     WHERE ata.taxonomy_id = '${SPENDING_TAXONOMY}' AND ${window}
     ORDER BY ata.activity_id, ata.created_at, ata.id;`,
    (parts) => (parts.length >= 5 ? { c0: parts[0], c1: parts[1], c2: parts[2], c3: parts[3], c4: tail(parts, 4) } : null),
    DRILL_CLI_SEPARATOR, SPEND_CLI_MAX_BUFFER,
  );
  const splits = queryNativeDbStrict<Record<string, unknown>>(
    dbPath, 'spending splits',
    `SELECT s.activity_id AS activity_id, s.category_id AS category_id, ROUND(ABS(CAST(COALESCE(s.amount, '0') AS REAL)) * 100) AS abs_cents
     FROM spending_activity_splits s JOIN activities a ON a.id = s.activity_id
     WHERE s.taxonomy_id = '${SPENDING_TAXONOMY}' AND ${window}
     ORDER BY s.activity_id, s.sort_order, s.id;`,
    (parts) => (parts.length >= 3 ? { c0: parts[0], c1: parts[1], c2: parts[2] } : null),
    DRILL_CLI_SEPARATOR, SPEND_CLI_MAX_BUFFER,
  );
  const filingsOf = new Map<string, SpendRow['filings']>();
  for (const r of filings) {
    const v = Object.values(r);
    const list = filingsOf.get(String(v[0])) ?? [];
    list.push({ id: String(v[1] ?? ''), categoryId: String(v[2] ?? ''), createdAt: String(v[3] ?? ''), source: String(v[4] ?? '') });
    filingsOf.set(String(v[0]), list);
  }
  const splitsOf = new Map<string, SpendRow['splits']>();
  for (const r of splits) {
    const v = Object.values(r);
    const list = splitsOf.get(String(v[0])) ?? [];
    list.push({ categoryId: String(v[1] ?? ''), absCents: Math.round(Number(v[2]) || 0) });
    splitsOf.set(String(v[0]), list);
  }
  return activities.map((r): SpendRow => {
    const v = Object.values(r);
    const id = String(v[0]);
    const account = accountById.get(String(v[2] ?? ''));
    return {
      id, date: String(v[1] ?? ''), accountId: String(v[2] ?? ''), accountName: account?.name ?? '', accountType: account?.type ?? '',
      type: String(v[3] ?? ''), typeOverride: String(v[4] ?? ''), subtype: String(v[5] ?? ''), absCents: Math.round(Number(v[6]) || 0),
      groupId: String(v[7] ?? ''), currency: String(v[8] ?? ''), notes: String(v[9] ?? ''), filings: filingsOf.get(id) ?? [], splits: splitsOf.get(id) ?? [],
    };
  });
}

/** Wealthfolio's Spending settings and its spending categories, as its page
 *  reads them (crates/spending settings/service.rs, insight/service.rs). */
export interface NativeSpendingSettings {
  /** Wealthfolio's timezone; null when unset. */
  timezone: string | null;
  /** `spending.excluded_category_ids`; [] when unset (3.8) or not a list of strings. */
  excludedCategoryIds: string[];
  /** Every spending category's parent (null at the top). */
  categoryParents: Record<string, string | null>;
  /** Every spending category's name. */
  categoryNames: Record<string, string>;
  /** Wealthfolio's base currency (`base_currency`); null when unset. */
  baseCurrency: string | null;
  /** Off unless `spending.enabled` is "true" and at least one account is opted in. */
  spendingOn: boolean;
  /** The accounts its Spending page reads: opted in, existing, not archived,
   *  and a cash or credit-card account (upstream's `account_supports_purpose`). */
  spendingAccountIds: string[];
}

/** The account types a Spending page can read (`account_supports_purpose`). */
const SPENDING_ACCOUNT_TYPES: ReadonlySet<string> = new Set(['CASH', 'CREDIT_CARD']);

/** Strict: throws NativeDbUnreadableError when the database cannot be read. */
export function getNativeSpendingSettings(dbPath: string): NativeSpendingSettings {
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath, 'spending settings',
    `SELECT setting_key AS k, COALESCE(setting_value, '') AS v FROM app_settings
     WHERE setting_key IN ('timezone', 'base_currency', 'spending.excluded_category_ids', 'spending.enabled', 'spending.account_ids') ORDER BY setting_key;`,
    (parts) => (parts.length >= 2 ? { c0: parts[0], c1: tail(parts, 1) } : null),
    DRILL_CLI_SEPARATOR, SPEND_CLI_MAX_BUFFER,
  );
  const value = new Map(rows.map((r) => {
    const v = Object.values(r);
    return [String(v[0]), String(v[1] ?? '')];
  }));
  // As upstream reads a list setting: `Vec<String>` or nothing — one
  // non-string element, or text that is not JSON, is the whole list absent.
  const stringList = (key: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(value.get(key) || '[]');
      return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  };
  const optedIn = value.get('spending.enabled') === 'true' ? stringList('spending.account_ids') : [];
  const accounts = queryNativeDbStrict<Record<string, unknown>>(
    dbPath, 'spending settings accounts',
    `SELECT id AS id, COALESCE(is_archived, 0) AS archived, UPPER(COALESCE(account_type, '')) AS account_type FROM accounts ORDER BY id;`,
    (parts) => (parts.length >= 3 ? { c0: parts[0], c1: parts[1], c2: parts[2] } : null),
    DRILL_CLI_SEPARATOR, SPEND_CLI_MAX_BUFFER,
  );
  const live = new Set(accounts.flatMap((r) => {
    const v = Object.values(r);
    return isTrue(v[1]) || !SPENDING_ACCOUNT_TYPES.has(String(v[2])) ? [] : [String(v[0])];
  }));
  const categories = queryNativeDbStrict<Record<string, unknown>>(
    dbPath, 'spending categories',
    `SELECT id AS id, COALESCE(parent_id, '') AS parent, COALESCE(name, '') AS name FROM taxonomy_categories
     WHERE taxonomy_id = '${SPENDING_TAXONOMY}' ORDER BY id;`,
    (parts) => (parts.length >= 3 ? { c0: parts[0], c1: parts[1], c2: tail(parts, 2) } : null),
    DRILL_CLI_SEPARATOR, SPEND_CLI_MAX_BUFFER,
  );
  const categoryParents: Record<string, string | null> = {};
  const categoryNames: Record<string, string> = {};
  for (const r of categories) {
    const v = Object.values(r);
    categoryParents[String(v[0])] = String(v[1] ?? '') || null;
    categoryNames[String(v[0])] = String(v[2] ?? '');
  }
  return {
    timezone: value.get('timezone') || null,
    baseCurrency: value.get('base_currency')?.trim().toUpperCase() || null,
    excludedCategoryIds: stringList('spending.excluded_category_ids'),
    categoryParents,
    categoryNames,
    spendingOn: optedIn.length > 0,
    spendingAccountIds: optedIn.filter((id) => live.has(id)),
  };
}

/** The lines Wealthfolio's Spending page counts on its local days
 *  `[startDay, endDayExclusive)`, and the settings they were counted with.
 *  Rows are read a day wider on each side: a row's local date is at most a
 *  day from its UTC date. Strict. */
export function readSpendLines(dbPath: string, startDay: string, endDayExclusive: string): { lines: SpendLine[]; settings: NativeSpendingSettings } {
  if (!isDay(startDay) || !isDay(endDayExclusive)) throw new Error(`malformed spending bounds: ${startDay}..${endDayExclusive}`);
  const settings = getNativeSpendingSettings(dbPath);
  const rows = getNativeSpendRows(dbPath, shiftDay(startDay, -1), shiftDay(endDayExclusive, 1));
  const lines = spendLines(rows, {
    timezone: settings.timezone,
    spendingAccountIds: settings.spendingAccountIds,
    excludedCategoryIds: settings.excludedCategoryIds,
    categoryParents: settings.categoryParents,
  }).filter((l) => l.day >= startDay && l.day < endDayExclusive);
  return { lines, settings };
}

/** A category's name rolled up to its top-level ancestor, as every report
 *  labels spending; '' when the category is unknown. */
export function topCategoryName(categoryId: string, settings: Pick<NativeSpendingSettings, 'categoryParents' | 'categoryNames'>): string {
  return settings.categoryNames[topCategoryId(categoryId, settings.categoryParents)] ?? '';
}
