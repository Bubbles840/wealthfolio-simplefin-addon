/**
 * companion/src/sqlite-guess.ts
 *
 * The one read behind guessed categories (project 3): every spending filing
 * since a day, as the row's description and its category. Strict like the
 * audits' readers (./sqlite-audit.ts) — it throws NativeDbUnreadableError
 * rather than answering [] — because a failed read must mean "no guesses",
 * never a guess drawn from part of the history.
 *
 * Which filings: the spending taxonomy's assignments whose `source` is
 * `manual` (a person — in Wealthfolio, in Telegram, and the Amazon filer, all
 * of which go through the assign route that writes `manual`) or `rule` (your
 * rules), created on or after the day. `migrated` — older Wealthfolio's own
 * conversion of its categories — is left out. The add-on's own bookkeeping
 * rows are left out by their note markers. The same tables and columns on
 * Wealthfolio 3.8, 3.9 and 3.10.
 *
 * The sqlite3 CLI fallback splits on the unit separator with the note last,
 * newlines made spaces (it prints one row per line).
 */
import type { PastFiling } from '../../shared/category-guess.js';
import { SPENDING_TAXONOMY_ID } from '../../shared/cash-flow-bucket.js';
import { descriptionFromComment } from '../../shared/sync-core.js';
import { DRILL_CLI_SEPARATOR, queryNativeDbStrict } from './sqlite-native.js';

/** A year of filings is far past execFileSync's 1 MB default on the CLI path. */
const GUESS_CLI_MAX_BUFFER = 64 * 1024 * 1024;
const NOTES = `REPLACE(REPLACE(COALESCE(a.notes, ''), char(13), ' '), char(10), ' ')`;

/** CLI line → the three columns (the note last, whatever it holds). */
export function pastFilingFromCliParts(parts: string[]): Record<string, unknown> | null {
  return parts.length >= 3 ? { c0: parts[0], c1: parts[1], c2: parts.slice(2).join(DRILL_CLI_SEPARATOR) } : null;
}

/** Every spending filing made on or after `sinceDay` (YYYY-MM-DD). Throws when
 *  the database cannot be read, or for a malformed day. */
export function getNativePastFilings(dbPath: string, sinceDay: string): PastFiling[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDay)) throw new Error(`Refusing past filings since a malformed day: ${sinceDay}`);
  // Only an activity's LATEST spending assignment counts (a row re-filed from A
  // to B is B, once), judged before the source and the window are applied; the
  // category is joined from the live table, so an assignment whose category is
  // gone is left out and a renamed one carries its current name. `created_at`
  // is compared by its day, so the boundary day is wholly in.
  const AT = (alias: string) => `replace(substr(COALESCE(${alias}.created_at, ''), 1, 19), 'T', ' ')`;
  const query = `
    SELECT ata.category_id AS category_id,
           tc.name AS category_name,
           ${NOTES} AS notes
    FROM activity_taxonomy_assignments ata
    JOIN activities a ON a.id = ata.activity_id
    JOIN taxonomy_categories tc ON tc.id = ata.category_id AND tc.taxonomy_id = ata.taxonomy_id
    WHERE ata.taxonomy_id = '${SPENDING_TAXONOMY_ID}'
      AND NOT EXISTS (
        SELECT 1 FROM activity_taxonomy_assignments newer
        WHERE newer.activity_id = ata.activity_id AND newer.taxonomy_id = ata.taxonomy_id
          AND (${AT('newer')} > ${AT('ata')} OR (${AT('newer')} = ${AT('ata')} AND COALESCE(newer.id, '') > COALESCE(ata.id, '')))
      )
      AND LOWER(COALESCE(ata.source, '')) IN ('manual', 'rule')
      AND substr(COALESCE(ata.created_at, ''), 1, 10) >= '${sinceDay}'
      AND COALESCE(a.notes, '') NOT LIKE 'Starting balance · %'
      AND COALESCE(a.notes, '') NOT LIKE 'Balance adjustment · %'
      AND COALESCE(a.notes, '') NOT LIKE '↔️ In-transit transfer · %';
  `;
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath, 'past filings', query, pastFilingFromCliParts, DRILL_CLI_SEPARATOR, GUESS_CLI_MAX_BUFFER,
  );
  return rows.map((r) => {
    const v = Object.values(r);
    return {
      categoryId: String(v[0] ?? ''),
      categoryName: String(v[1] ?? ''),
      description: descriptionFromComment(String(v[2] ?? '')),
    };
  });
}
