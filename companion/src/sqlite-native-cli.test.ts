/**
 * The sqlite3-CLI FALLBACK path of ./sqlite-native.ts, which every other test in
 * sqlite-native.test.ts skips past: those hand a real database to `node:sqlite`,
 * so the CLI branch — the one the Dockerfile installs `sqlite` for, taken when
 * all three `node:sqlite` opens fail — never runs there at all.
 *
 * The two paths return DIFFERENT shapes for a NULL column: `node:sqlite` gives
 * JavaScript `null`, the CLI gives an EMPTY STRING (its `|`-delimited output has
 * no way to spell null). A mapper that only handles the first silently turns
 * every top-level category into a child of `''`, which is invisible in the data
 * and fatal in the UI (the menu's parent filter is `parentId === null`).
 *
 * Driven hermetically: a file that exists but is not a database makes all three
 * `node:sqlite` opens fail for real, and `execFileSync` is mocked so the assertions
 * are about our mapping rather than about which sqlite3 binary the machine has.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFileSync: execFileSyncMock }));

const { getNativeSpendingCategories, countRulePatternMatches, getNativeDrillRows, getNativeTxSearchRows } = await import('./sqlite-native.js');

/** A path that EXISTS (so the reader gets past its `existsSync` guard) but is not
 *  a SQLite database, so every `node:sqlite` open genuinely fails and the CLI
 *  fallback is genuinely reached. */
function notADatabase(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-sqlite-cli-'));
  const path = join(dir, 'wealthfolio.db');
  writeFileSync(path, 'this is not a sqlite database');
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('sqlite-native — sqlite3 CLI fallback', () => {
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execFileSyncMock.mockReset();
    // The three failed node:sqlite opens each log; they are the point, not noise
    // to be surprised by.
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errors.mockRestore();
  });

  describe('getNativeSpendingCategories', () => {
    it('reads NULL parent columns as null, not as the CLI\'s empty string', () => {
      const { path, cleanup } = notADatabase();
      try {
        // Exactly what `sqlite3 db.sqlite "SELECT id, name, parent_id, parent.name …"`
        // prints: one line per row, `|` between columns, NOTHING between the
        // separators where a column is NULL.
        execFileSyncMock.mockReturnValue(
          'p1|Food & Dining||\n'
          + 'c1|Restaurants|p1|Food & Dining\n'
          + 't1|Transportation||\n',
        );

        const cats = getNativeSpendingCategories(path);

        // Proves the CLI branch is what answered: node:sqlite never got this far.
        expect(execFileSyncMock).toHaveBeenCalledTimes(1);
        expect(cats).toEqual([
          { id: 'p1', name: 'Food & Dining', parentId: null, parentName: null },
          { id: 'c1', name: 'Restaurants', parentId: 'p1', parentName: 'Food & Dining' },
          { id: 't1', name: 'Transportation', parentId: null, parentName: null },
        ]);
        // The property the menu depends on, stated as the menu states it: its
        // parent filter is `parentId === null`, so an empty string here empties
        // the whole category picker.
        expect(cats.filter((c) => c.parentId === null).map((c) => c.name))
          .toEqual(['Food & Dining', 'Transportation']);
      } finally {
        cleanup();
      }
    });
  });

  describe('countRulePatternMatches', () => {
    it('hands the query to sqlite3 as one argv element, with no shell', () => {
      const { path, cleanup } = notADatabase();
      try {
        execFileSyncMock.mockReturnValue('0|0\n');
        const pattern = 'joes $(touch /tmp/pwned) `id` "quoted"';
        countRulePatternMatches(path, pattern, '2026-01-01', '2026-02-01');

        expect(execFileSyncMock).toHaveBeenCalledTimes(1);
        const [file, args, options] = execFileSyncMock.mock.calls[0];
        expect(file).toBe('sqlite3');
        expect(args[0]).toBe(path);
        expect(args).toHaveLength(2);
        expect(args[1]).toContain('joes $(touch /tmp/pwned) `id` "quoted"');
        expect(options.shell).toBeUndefined();
      } finally {
        cleanup();
      }
    });
  });

  describe('the unit separator reaches the CLI', () => {
    it('the drill query still passes -separator \\x1f through tryQueryNativeDb', () => {
      const { path, cleanup } = notADatabase();
      try {
        execFileSyncMock.mockReturnValue('');
        getNativeDrillRows(path, '2026-10-01', '2026-11-01');
        const [, args] = execFileSyncMock.mock.calls[0];
        expect(args.slice(0, 2)).toEqual(['-separator', '\x1f']);
      } finally {
        cleanup();
      }
    });

    it('the story search reads a | in an account name and a note from the CLI', () => {
      const { path, cleanup } = notADatabase();
      try {
        execFileSyncMock.mockReturnValue('act-9\x1f2026-10-04\x1f5420\x1fWITHDRAWAL\x1fCASH\x1fJoe|Co Checking\x1fSQ *A|B \u00b7 TRN-9\n');
        const rows = getNativeTxSearchRows(path);
        expect(execFileSyncMock.mock.calls[0][1].slice(0, 2)).toEqual(['-separator', '\x1f']);
        expect(rows).toEqual([
          { activityId: 'act-9', date: '2026-10-04', absCents: 5420, activityType: 'WITHDRAWAL', accountType: 'CASH', accountName: 'Joe|Co Checking', notes: 'SQ *A|B \u00b7 TRN-9' },
        ]);
      } finally {
        cleanup();
      }
    });
  });
});
