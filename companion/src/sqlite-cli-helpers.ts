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
