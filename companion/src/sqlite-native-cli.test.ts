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
 * `node:sqlite` opens fail for real, and `execSync` is mocked so the assertions
 * are about our mapping rather than about which sqlite3 binary the machine has.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const execSyncMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execSync: execSyncMock }));

const { getNativeSpendingCategories } = await import('./sqlite-native.js');

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
    execSyncMock.mockReset();
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
        execSyncMock.mockReturnValue(
          'p1|Food & Dining||\n'
          + 'c1|Restaurants|p1|Food & Dining\n'
          + 't1|Transportation||\n',
        );

        const cats = getNativeSpendingCategories(path);

        // Proves the CLI branch is what answered: node:sqlite never got this far.
        expect(execSyncMock).toHaveBeenCalledTimes(1);
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
});
