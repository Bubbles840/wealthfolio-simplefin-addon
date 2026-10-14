/**
 * companion/src/sqlite-audit.ts
 *
 * The audits' database reads (2c), in a focused file beside sqlite-native.ts
 * (already ~1,900 lines). Strict like the story readers: each throws
 * NativeDbUnreadableError rather than answering [] for a database it could
 * not read, because a check must say "couldn't read", never "nothing wrong".
 *
 * Ported from companion/tools: the row read is audit-health.mjs part 1's
 * (`activity_type_override`, `status`, `metadata`, `asset_id`) with
 * fix-transfers.mjs's archived flag and its `$CASH` asset test; the month
 * read and the settings are the report's own (1.62: `getNativeSpendRows` and
 * `getNativeSpendingSettings` in sqlite-native.ts — the rows and the Spending
 * page's settings shared/wf-spending.ts counts with). Every table and column
 * read here is the same on Wealthfolio 3.8, 3.9 and 3.10; a blank override
 * reads as none, and the excluded-categories setting (3.9+) as none when it
 * is not there.
 *
 * The sqlite3 CLI fallback splits on the unit separator, with the free text
 * (a name, a note) last, so a separator inside it cannot shift the columns.
 * It prints one row per line, so the notes are read with every newline made a
 * space (display only — a note's ` · <txId>` tail and markers survive), and
 * its output, the whole ledger, gets a buffer far past execFileSync's 1 MB
 * default (AUDIT_CLI_MAX_BUFFER).
 */
import type { AuditAccount, AuditLedger, AuditLedgerRow } from '../../shared/audit-ledger.js';
import type { HeadlineDbRow } from '../../shared/audit-headline.js';
import { isDay, isTrue, NOTES, shiftDay, tail } from './sqlite-cli-helpers.js';
import { DRILL_CLI_SEPARATOR, getNativeSpendingSettings, getNativeSpendRows, queryNativeDbStrict, SPEND_CLI_MAX_BUFFER } from './sqlite-native.js';

/** The `$CASH` security the July 2026 bulk import minted (audit-health.mjs). */
export const PHANTOM_CASH_ASSET_ID = '9231cb80-4223-4c04-98e3-dd3b1af60311';

const SEP = DRILL_CLI_SEPARATOR;
/** The sqlite3 CLI's output buffer for every audit read: the ledger read
 *  returns every row Wealthfolio holds. The spending reads' own. */
export const AUDIT_CLI_MAX_BUFFER = SPEND_CLI_MAX_BUFFER;

/** CLI line → the account read's columns (the name last). */
export function auditAccountFromCliParts(parts: string[]): Record<string, unknown> | null {
  return parts.length >= 5 ? { c0: parts[0], c1: parts[1], c2: parts[2], c3: parts[3], c4: tail(parts, 4) } : null;
}

/** CLI line → the ledger read's fourteen columns (the note last). */
export function auditRowFromCliParts(parts: string[]): Record<string, unknown> | null {
  if (parts.length < 14 || !Number.isFinite(parseFloat(parts[7]))) return null;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < 13; i++) out[`c${i}`] = parts[i];
  out.c13 = tail(parts, 13);
  return out;
}

/** `quantity` as a number; null when the row has none or it is not a number. */
const quantityOf = (v: unknown): number | null => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Every account and every activity, oldest first. */
export function getNativeAuditLedger(dbPath: string): AuditLedger {
  const accounts = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'audit accounts',
    `SELECT acc.id AS id, UPPER(COALESCE(acc.account_type, '')) AS account_type,
            COALESCE(acc.is_archived, 0) AS archived, COALESCE(acc.is_active, 1) AS active, COALESCE(acc.name, '') AS name
     FROM accounts acc ORDER BY acc.id;`,
    auditAccountFromCliParts,
    SEP,
    AUDIT_CLI_MAX_BUFFER,
  );
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'audit ledger',
    `SELECT a.id AS id, a.account_id AS account_id, substr(a.activity_date, 1, 10) AS d,
            UPPER(COALESCE(a.currency, '')) AS ccy,
            UPPER(COALESCE(a.activity_type, '')) AS raw_type,
            UPPER(COALESCE(NULLIF(TRIM(a.activity_type_override), ''), a.activity_type, '')) AS t,
            UPPER(COALESCE(a.status, 'POSTED')) AS status,
            ROUND(ABS(CAST(COALESCE(a.amount, '0') AS REAL)) * 100) AS abs_cents,
            COALESCE(a.source_group_id, '') AS g,
            COALESCE(a.asset_id, '') AS asset,
            CASE WHEN json_valid(COALESCE(a.metadata, ''))
                 THEN COALESCE(json_type(a.metadata, '$.flow.is_external'), '') ELSE '' END AS ext,
            CASE WHEN COALESCE(a.asset_id, '') <> '' AND (a.asset_id = '${PHANTOM_CASH_ASSET_ID}' OR a.asset_id IN (
                   SELECT id FROM assets WHERE UPPER(COALESCE(display_code, instrument_symbol, name, id)) = '$CASH'))
                 THEN 1 ELSE 0 END AS phantom,
            COALESCE(a.quantity, '') AS quantity,
            ${NOTES} AS notes
     FROM activities a
     ORDER BY a.activity_date, a.id;`,
    auditRowFromCliParts,
    SEP,
    AUDIT_CLI_MAX_BUFFER,
  );
  return {
    accounts: accounts.map((r): AuditAccount => {
      const v = Object.values(r);
      return { id: String(v[0]), type: String(v[1] ?? ''), archived: isTrue(v[2]), active: isTrue(v[3]), name: String(v[4] ?? '') };
    }),
    rows: rows.map((r): AuditLedgerRow => {
      const v = Object.values(r);
      return {
        id: String(v[0]), accountId: String(v[1]), date: String(v[2]), currency: String(v[3] ?? ''),
        rawType: String(v[4] ?? ''), type: String(v[5] ?? ''), status: String(v[6] ?? 'POSTED'),
        absCents: Math.round(Number(v[7]) || 0), group: String(v[8] ?? ''), assetId: String(v[9] ?? ''),
        quantity: quantityOf(v[12]), external: String(v[10]) === 'true', phantomCash: isTrue(v[11]), notes: String(v[13] ?? ''),
      };
    }),
  };
}

/** The month's activities, every account, as shared/wf-spending.ts counts
 *  them: `[startInclusive, endExclusive)` on the stored date (both
 *  YYYY-MM-DD) read a day wider on each side, since Wealthfolio places a row
 *  by its local date. Each with its filings and split lines
 *  (`getNativeSpendRows`). */
export function getNativeHeadlineRows(dbPath: string, startInclusive: string, endExclusive: string): HeadlineDbRow[] {
  // Interpolated (the CLI fallback cannot bind), so validated, never trusted.
  if (!isDay(startInclusive) || !isDay(endExclusive)) throw new Error(`malformed month bounds: ${startInclusive}..${endExclusive}`);
  return getNativeSpendRows(dbPath, shiftDay(startInclusive, -1), shiftDay(endExclusive, 1));
}

/** What the headline check needs besides the rows: Wealthfolio's timezone
 *  (null when unset), the categories it excludes from spending ([] when unset
 *  — Wealthfolio 3.8 has no such setting — or not a list of strings, as
 *  upstream reads it), whether its Spending page is on and which accounts it
 *  reads, and each spending category's parent, so an excluded category's
 *  descendants count too (3.9+). The report's own read
 *  (`getNativeSpendingSettings`), without the category names. */
export function getNativeAuditSettings(dbPath: string): {
  timezone: string | null; baseCurrency: string | null; excludedCategoryIds: string[]; categoryParents: Record<string, string | null>; spendingOn: boolean;
  spendingAccountIds: string[];
} {
  const { timezone, baseCurrency, excludedCategoryIds, categoryParents, spendingOn, spendingAccountIds } = getNativeSpendingSettings(dbPath);
  return { timezone, baseCurrency, excludedCategoryIds, categoryParents, spendingOn, spendingAccountIds };
}
