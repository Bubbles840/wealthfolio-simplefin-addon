/**
 * The sqlite3 CLI fallback, run for real: `node:sqlite` is made to throw so
 * every read takes the `execFileSync('sqlite3', …)` path. Its own file so the
 * mock touches no other suite. Skipped where sqlite3 is not on PATH.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const real = await vi.importActual<typeof import('node:sqlite')>('node:sqlite');
vi.mock('node:sqlite', () => ({
  DatabaseSync: class {
    constructor() { throw new Error('node:sqlite unavailable (forced CLI fallback)'); }
  },
}));

import { getNativeBudgetSpend, getNativeSpendingHistoryStart, getNativeSpendMatrix } from './sqlite-native.js';

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });

let hasSqlite3 = true;
try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); } catch { hasSqlite3 = false; }

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real table and column names, only the columns the readers touch. */
function database(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-realcli-'));
  dirs.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new real.DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT);
    CREATE TABLE activities (id TEXT PRIMARY KEY, amount TEXT, activity_date TEXT, activity_type TEXT, notes TEXT, account_id TEXT, subtype TEXT);
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, name TEXT, parent_id TEXT, taxonomy_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (activity_id TEXT, category_id TEXT, taxonomy_id TEXT, source TEXT);
    INSERT INTO accounts VALUES ('chk', 'Checking', 'CASH'), ('card', 'Card', 'CREDIT_CARD'), ('other', 'Elsewhere', 'CASH');
    INSERT INTO taxonomy_categories VALUES
      ('cat-food', 'Food', NULL, 'spending_categories'), ('cat-fun', 'Fun', 'cat-food', 'spending_categories'),
      ('cat-gro', 'Groceries', NULL, 'spending_categories'), ('cat-tr', 'Transfers', NULL, 'spending_categories'),
      ('inc', 'Pay', NULL, 'income_sources');
    INSERT INTO activities VALUES
      ('own', '50', '2026-08-03', 'WITHDRAWAL', 'a', 'chk', NULL),
      ('sub', '100', '2026-08-04', 'WITHDRAWAL', 'b', 'chk', NULL),
      ('gro', '30', '2026-08-05', 'WITHDRAWAL', 'c', 'card', NULL),
      ('else', '999', '2026-08-06', 'WITHDRAWAL', 'd', 'other', NULL),
      ('xfer', '700', '2026-08-07', 'WITHDRAWAL', 'e', 'chk', NULL),
      ('pay', '2000', '2026-08-08', 'DEPOSIT', 'f', 'chk', NULL),
      ('first', '5', '2026-06-20T04:00:00+00:00', 'DEPOSIT', 'g', 'card', NULL);
    INSERT INTO activity_taxonomy_assignments VALUES
      ('own', 'cat-food', 'spending_categories', 'manual'), ('sub', 'cat-fun', 'spending_categories', 'manual'),
      ('gro', 'cat-gro', 'spending_categories', 'manual'), ('else', 'cat-gro', 'spending_categories', 'manual'),
      ('xfer', 'cat-tr', 'spending_categories', 'manual'), ('pay', 'inc', 'income_sources', 'manual');
  `);
  db.close();
  return path;
}

describe.skipIf(!hasSqlite3)('the sqlite3 CLI fallback, for real', () => {
  const scope = { spendingAccountIds: ['chk', 'card'], excludedCategoryIds: ['cat-fun'], categoryParents: { 'cat-fun': 'cat-food' } as Record<string, string | null> };

  it('keeps the query\'s comments, filters and GROUP BY: the same rows as the node path', () => {
    const path = database();
    // The excluded subcategory, the non-spending account, the transfer-named
    // category and the income row are all absent; nothing is merged into one row.
    expect(getNativeBudgetSpend(path, '2026-07-01', '2026-10-01', scope).sort((a, b) => a.category.localeCompare(b.category))).toEqual([
      { month: '2026-08', category: 'Food', accountId: 'chk', amount: 50 },
      { month: '2026-08', category: 'Groceries', accountId: 'card', amount: 30 },
    ]);
    const matrix = getNativeSpendMatrix(path, '2026-07-01', '2026-10-01');
    expect(matrix).toHaveLength(3);
    expect(matrix).toContainEqual({ month: '2026-08', category: 'Food', accountId: 'chk', amount: 150 });
    expect(matrix.some((r) => r.category === 'Transfers')).toBe(false);
  });

  it('reads the earliest activity day on the spending accounts', () => {
    expect(getNativeSpendingHistoryStart(database(), ['chk', 'card'])).toBe('2026-06-20');
  });
});
