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
 * read and the settings are audit-headline.mjs's. Every table and column
 * read here is the same on Wealthfolio 3.8, 3.9 and 3.10; a blank override
 * reads as none, and the excluded-categories setting (3.9+) as none when it
 * is not there.
 *
 * The sqlite3 CLI fallback splits on the unit separator, with the free text
 * (a name, a note) last, so a separator inside it cannot shift the columns.
 */
import type { AuditAccount, AuditLedger, AuditLedgerRow } from '../../shared/audit-ledger.js';
import type { HeadlineDbRow } from '../../shared/audit-headline.js';
import { DRILL_CLI_SEPARATOR, queryNativeDbStrict } from './sqlite-native.js';

/** The `$CASH` security the July 2026 bulk import minted (audit-health.mjs). */
export const PHANTOM_CASH_ASSET_ID = '9231cb80-4223-4c04-98e3-dd3b1af60311';

const SEP = DRILL_CLI_SEPARATOR;
const tail = (parts: string[], from: number) => parts.slice(from).join(SEP);
const isTrue = (v: unknown) => String(v) === '1' || String(v).toLowerCase() === 'true';

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

/** CLI line → the month read's eleven columns (the note last). */
export function headlineRowFromCliParts(parts: string[]): Record<string, unknown> | null {
  if (parts.length < 11 || !Number.isFinite(parseFloat(parts[5]))) return null;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < 10; i++) out[`c${i}`] = parts[i];
  out.c10 = tail(parts, 10);
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
            COALESCE(a.notes, '') AS notes
     FROM activities a
     ORDER BY a.activity_date, a.id;`,
    auditRowFromCliParts,
    SEP,
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

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** The month's activities, every account, as audit-headline.mjs reads them:
 *  `[startInclusive, endExclusive)`, both YYYY-MM-DD. */
export function getNativeHeadlineRows(dbPath: string, startInclusive: string, endExclusive: string): HeadlineDbRow[] {
  // Interpolated (the CLI fallback cannot bind), so validated, never trusted.
  if (!isDay(startInclusive) || !isDay(endExclusive)) throw new Error(`malformed month bounds: ${startInclusive}..${endExclusive}`);
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'audit month',
    `SELECT a.id AS id, a.activity_date AS activity_date, UPPER(COALESCE(acc.account_type, '')) AS account_type,
            UPPER(COALESCE(a.activity_type, '')) AS activity_type, UPPER(COALESCE(a.subtype, '')) AS subtype,
            ROUND(ABS(CAST(COALESCE(a.amount, '0') AS REAL)) * 100) AS abs_cents,
            (SELECT COUNT(*) FROM activity_taxonomy_assignments ata JOIN taxonomy_categories tc ON ata.category_id = tc.id
              WHERE ata.activity_id = a.id AND tc.taxonomy_id = 'spending_categories') AS spending_filings,
            COALESCE((SELECT group_concat(ata.category_id, ',') FROM activity_taxonomy_assignments ata
              WHERE ata.activity_id = a.id), '') AS category_ids,
            COALESCE((SELECT ata.category_id FROM activity_taxonomy_assignments ata
              WHERE ata.activity_id = a.id AND ata.taxonomy_id = 'spending_categories'
              ORDER BY ata.created_at, ata.id LIMIT 1), '') AS spending_category,
            COALESCE(acc.name, '') AS account_name,
            COALESCE(a.notes, '') AS notes
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     WHERE a.activity_date >= '${startInclusive}' AND a.activity_date < '${endExclusive}'
     ORDER BY a.activity_date, a.id;`,
    headlineRowFromCliParts,
    SEP,
  );
  return rows.map((r) => {
    const v = Object.values(r);
    const ids = String(v[7] ?? '');
    return {
      id: String(v[0]), date: String(v[1]), accountType: String(v[2] ?? ''), type: String(v[3] ?? ''),
      subtype: String(v[4] ?? ''), absCents: Math.round(Number(v[5]) || 0), spendingFilings: Number(v[6]) || 0,
      categoryIds: ids ? ids.split(',') : [], spendingCategoryId: String(v[8] ?? '') || null,
      accountName: String(v[9] ?? ''), notes: String(v[10] ?? ''),
    };
  });
}

/** What the headline check needs besides the rows: Wealthfolio's timezone
 *  (null when unset), the categories it excludes from spending ([] when unset
 *  — Wealthfolio 3.8 has no such setting — or not a list of strings, as
 *  upstream reads it), whether its Spending page is on, and each spending category's parent, so an
 *  excluded category's descendants count too (3.9+). */
export function getNativeAuditSettings(dbPath: string): {
  timezone: string | null; excludedCategoryIds: string[]; categoryParents: Record<string, string | null>; spendingOn: boolean;
} {
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'audit settings',
    `SELECT setting_key AS k, COALESCE(setting_value, '') AS v FROM app_settings
     WHERE setting_key IN ('timezone', 'spending.excluded_category_ids', 'spending.enabled', 'spending.account_ids') ORDER BY setting_key;`,
    (parts) => (parts.length >= 2 ? { c0: parts[0], c1: tail(parts, 1) } : null),
    SEP,
  );
  const value = new Map(rows.map((r) => {
    const v = Object.values(r);
    return [String(v[0]), String(v[1] ?? '')];
  }));
  // As upstream reads a list setting (settings/service.rs): `Vec<String>` or
  // nothing — one non-string element, or text that is not JSON, is the whole
  // list absent.
  const stringList = (key: string): string[] => {
    try {
      const parsed: unknown = JSON.parse(value.get(key) || '[]');
      return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  };
  const excludedCategoryIds = stringList('spending.excluded_category_ids');
  // The Spending page's own gate: off unless `spending.enabled` is "true" and
  // at least one account is opted in; a missing row is off.
  const spendingOn = value.get('spending.enabled') === 'true' && stringList('spending.account_ids').length > 0;
  const parents = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'audit categories',
    `SELECT id AS id, COALESCE(parent_id, '') AS parent FROM taxonomy_categories
     WHERE taxonomy_id = 'spending_categories' ORDER BY id;`,
    (parts) => (parts.length >= 2 ? { c0: parts[0], c1: parts[1] } : null),
    SEP,
  );
  const categoryParents: Record<string, string | null> = {};
  for (const r of parents) {
    const v = Object.values(r);
    categoryParents[String(v[0])] = String(v[1] ?? '') || null;
  }
  return { timezone: value.get('timezone') || null, excludedCategoryIds, categoryParents, spendingOn };
}
