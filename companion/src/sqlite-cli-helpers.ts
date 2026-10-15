/**
 * companion/src/sqlite-cli-helpers.ts
 *
 * The small pieces every read in sqlite-native.ts and sqlite-audit.ts shares:
 * the sqlite3 CLI fallback's column separator and the one-row-per-line note
 * expression, the helpers that rebuild a row from its columns, and the day
 * arithmetic that validates and widens a window. One place, so the two files
 * cannot drift apart.
 */

/** The sqlite3 CLI fallback splits on the unit separator, with the free text
 *  (a name, a note) last, so a separator inside it cannot shift the columns. */
export const CLI_SEPARATOR = '\x1f';

/** A note with each CR and LF made a space: the CLI prints a row per line. */
export const NOTES = `REPLACE(REPLACE(COALESCE(a.notes, ''), char(13), ' '), char(10), ' ')`;

/** The free text last: every column from `from` on, joined back. */
export const tail = (parts: string[], from: number) => parts.slice(from).join(CLI_SEPARATOR);

/** A SQLite boolean as node:sqlite (1) or the CLI (1 / true) prints it. */
export const isTrue = (v: unknown) => String(v) === '1' || String(v).toLowerCase() === 'true';

/** `YYYY-MM-DD`: interpolated into SQL (the CLI cannot bind), so validated. */
export const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The CTE terms `up` and `top` (use after `WITH RECURSIVE` / a comma): each
 *  category's top-level ancestor name, as upstream's budget page keys a budget
 *  and its actuals (`top_category_id`, crates/spending/src/budget/service.rs,
 *  v3.10.0), however deep the taxonomy goes. The walk is bounded (32) so a
 *  parent loop cannot hang the read; a category in such a loop has no top. */
/** Only the budget targets upstream's Spending budget page lists
 *  (budget/service.rs:250-251 at v3.10.0): category targets in the spending
 *  taxonomy, in a category that is not excluded from spending. An income
 *  target, a group buffer or an excluded category's target is no part of
 *  "left this month". Append to a WHERE on `budget_targets`. */
export const SPENDING_BUDGET_TARGET_FILTER = `target_type = 'category' AND taxonomy_id = 'spending_categories'
    AND category_id NOT IN (SELECT value FROM json_each(COALESCE((SELECT setting_value FROM app_settings WHERE setting_key = 'spending.excluded_category_ids'), '[]')))`;

export const TOP_CATEGORY_CTE = `up(start_id, parent_id, name, depth) AS (
    SELECT id, parent_id, name, 0 FROM taxonomy_categories
    UNION ALL
    SELECT up.start_id, p.parent_id, p.name, up.depth + 1 FROM up JOIN taxonomy_categories p ON up.parent_id = p.id WHERE up.depth < 32
  ), top(start_id, name) AS (SELECT start_id, name FROM up WHERE parent_id IS NULL)`;
