/**
 * The sqlite3 CLI fallback, run for real: `node:sqlite` is made to throw so
 * every read takes the `execFileSync('sqlite3', …)` path. Its own file so the
 * mock touches no other suite. Skipped where sqlite3 is not on PATH.
 *
 * The query must reach sqlite3 verbatim: it reads its argument line by line,
 * so a `--` comment ends at its own line. Flattened onto one line, the comment
 * in `spendingWhere` swallowed the taxonomy filter and the GROUP BY, and the
 * uncategorized reader's swallowed the group, type, note and scope filters.
 * The budget readers (`/budgets`) take the same path.
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

import { getNativeBudgetSpend, getNativeSpendingHistoryStart, getNativeSpendMatrix, getNativeUncategorizedSpending } from './sqlite-native.js';

let hasSqlite3 = true;
try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); } catch { hasSqlite3 = false; }

let errors: ReturnType<typeof vi.spyOn>;
const dirs: string[] = [];
beforeEach(() => { errors = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => {
  errors.mockRestore();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** sqlite-native.test.ts's `makeTestDb` schema and settings, with this file's rows. */
function database(rows: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-realcli-'));
  dirs.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new real.DatabaseSync(path);
  db.exec(`
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, name TEXT, parent_id TEXT, taxonomy_id TEXT DEFAULT 'spending_categories', icon TEXT, color TEXT, sort_order INTEGER);
    CREATE TABLE activities (id TEXT PRIMARY KEY, amount TEXT, activity_date TEXT, activity_type TEXT, notes TEXT, account_id TEXT DEFAULT 'acct-cash', subtype TEXT, currency TEXT, source_group_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (activity_id TEXT, category_id TEXT, taxonomy_id TEXT, source TEXT);
    CREATE TABLE budget_targets (category_id TEXT, amount TEXT, period_key TEXT, updated_at TEXT);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT);
    CREATE TABLE budget_groups (id TEXT PRIMARY KEY, name TEXT, key TEXT, color TEXT, icon TEXT, sort_order INTEGER);
    CREATE TABLE budget_group_assignments (id TEXT PRIMARY KEY, group_id TEXT, taxonomy_id TEXT, category_id TEXT);
    CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT);
    INSERT INTO app_settings VALUES ('spending.enabled', 'true');
    INSERT INTO app_settings VALUES ('spending.account_ids', '["acct-cash","acct-card","wf-a","wf-cash"]');
    INSERT INTO accounts (id, name, account_type) VALUES ('acct-cash', 'Spend', 'CASH');
    INSERT INTO accounts (id, name, account_type) VALUES ('acct-card', 'Card', 'CREDIT_CARD');
    INSERT INTO accounts (id, name, account_type) VALUES ('acct-off', 'Untracked', 'CASH');
  `);
  db.exec(rows);
  db.close();
  return path;
}

describe.skipIf(!hasSqlite3)('the sqlite3 CLI fallback, for real', () => {
  it('getNativeSpendMatrix keeps the taxonomy filter and the GROUP BY: one row per category, transfers and income out', () => {
    const path = database(`
      INSERT INTO taxonomy_categories (id, name, parent_id, taxonomy_id) VALUES
        ('cat-food', 'Food', NULL, 'spending_categories'), ('cat-fun', 'Fun', 'cat-food', 'spending_categories'),
        ('cat-gro', 'Groceries', NULL, 'spending_categories'), ('cat-tr', 'Transfers', NULL, 'spending_categories'),
        ('inc', 'Pay', NULL, 'income_sources');
      INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id) VALUES
        ('own', '50', '2026-08-03', 'WITHDRAWAL', 'a', 'acct-cash'),
        ('sub', '100', '2026-08-04', 'WITHDRAWAL', 'b', 'acct-cash'),
        ('gro', '30', '2026-08-05', 'WITHDRAWAL', 'c', 'acct-card'),
        ('xfer', '700', '2026-08-07', 'WITHDRAWAL', 'e', 'acct-cash'),
        ('reimb', '20', '2026-08-08', 'WITHDRAWAL', 'f', 'acct-cash');
      INSERT INTO activity_taxonomy_assignments VALUES
        ('own', 'cat-food', 'spending_categories', 'manual'), ('sub', 'cat-fun', 'spending_categories', 'manual'),
        ('gro', 'cat-gro', 'spending_categories', 'manual'), ('xfer', 'cat-tr', 'spending_categories', 'manual'),
        ('reimb', 'inc', 'income_sources', 'manual');
    `);
    const matrix = getNativeSpendMatrix(path, '2026-07-01', '2026-10-01')
      .sort((a, b) => a.category.localeCompare(b.category));
    expect(matrix).toEqual([
      { month: '2026-08', category: 'Food', accountId: 'acct-cash', amount: 150 },
      { month: '2026-08', category: 'Groceries', accountId: 'acct-card', amount: 30 },
    ]);
    // The CLI answered: every node:sqlite open threw and said so.
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('node:sqlite spend matrix error'), expect.anything());
    expect(errors).not.toHaveBeenCalledWith(expect.stringContaining('Failed to read native sqlite'), expect.anything());
  });

  it('getNativeUncategorizedSpending keeps every filter after its comment: grouped, typed-out, bookkeeping and untracked rows stay out', () => {
    const path = database(`
      INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id, source_group_id) VALUES
        ('plain', '12.34', '2026-08-03', 'WITHDRAWAL', 'COFFEE · TRN-1', 'acct-cash', NULL),
        ('grouped', '40', '2026-08-04', 'WITHDRAWAL', 'CARD PAYMENT · TRN-2', 'acct-cash', 'grp-1'),
        ('xfer', '60', '2026-08-05', 'TRANSFER_OUT', 'MOVE · TRN-3', 'acct-cash', NULL),
        ('opening', '500', '2026-08-01', 'DEPOSIT', 'Starting balance · Spend', 'acct-cash', NULL),
        ('untracked', '9', '2026-08-06', 'WITHDRAWAL', 'ELSEWHERE · TRN-4', 'acct-off', NULL);
    `);
    const rows = getNativeUncategorizedSpending(path, '2026-08-01', '2026-09-01');
    expect(rows).toEqual([
      {
        activityId: 'plain', wfAccountId: 'acct-cash', notes: 'COFFEE · TRN-1', amountCents: 1234, date: '2026-08-03',
        accountName: 'Spend', direction: 'out', incomeEligible: false, activityType: 'WITHDRAWAL', pending: false,
      },
    ]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('node:sqlite uncategorized error'), expect.anything());
    expect(errors).not.toHaveBeenCalledWith(expect.stringContaining('Failed to read native sqlite'), expect.anything());
  });

  it('getNativeBudgetSpend and getNativeSpendingHistoryStart keep their filters: the same rows as the node path', () => {
    const path = database(`
      INSERT INTO taxonomy_categories (id, name, parent_id, taxonomy_id) VALUES
        ('cat-food', 'Food', NULL, 'spending_categories'), ('cat-fun', 'Fun', 'cat-food', 'spending_categories'),
        ('cat-gro', 'Groceries', NULL, 'spending_categories'), ('cat-tr', 'Transfers', NULL, 'spending_categories'),
        ('inc', 'Pay', NULL, 'income_sources');
      INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id) VALUES
        ('own', '50', '2026-08-03', 'WITHDRAWAL', 'a', 'acct-cash'),
        ('sub', '100', '2026-08-04', 'WITHDRAWAL', 'b', 'acct-cash'),
        ('gro', '30', '2026-08-05', 'WITHDRAWAL', 'c', 'acct-card'),
        ('else', '999', '2026-08-06', 'WITHDRAWAL', 'd', 'acct-off'),
        ('xfer', '700', '2026-08-07', 'WITHDRAWAL', 'e', 'acct-cash'),
        ('pay', '2000', '2026-08-08', 'DEPOSIT', 'f', 'acct-cash'),
        ('first', '5', '2026-06-20T04:00:00+00:00', 'DEPOSIT', 'g', 'acct-card');
      INSERT INTO activity_taxonomy_assignments VALUES
        ('own', 'cat-food', 'spending_categories', 'manual'), ('sub', 'cat-fun', 'spending_categories', 'manual'),
        ('gro', 'cat-gro', 'spending_categories', 'manual'), ('else', 'cat-gro', 'spending_categories', 'manual'),
        ('xfer', 'cat-tr', 'spending_categories', 'manual'), ('pay', 'inc', 'income_sources', 'manual');
    `);
    const scope = { spendingAccountIds: ['acct-cash', 'acct-card'], excludedCategoryIds: ['cat-fun'], categoryParents: { 'cat-fun': 'cat-food' } as Record<string, string | null> };
    // The excluded subcategory, the non-spending account, the transfer-named
    // category and the income row are all absent; nothing is merged into one row.
    expect(getNativeBudgetSpend(path, '2026-07-01', '2026-10-01', scope).sort((a, b) => a.category.localeCompare(b.category))).toEqual([
      { month: '2026-08', category: 'Food', accountId: 'acct-cash', amount: 50 },
      { month: '2026-08', category: 'Groceries', accountId: 'acct-card', amount: 30 },
    ]);
    expect(getNativeSpendingHistoryStart(path, ['acct-cash', 'acct-card'])).toBe('2026-06-20');
    expect(errors).not.toHaveBeenCalledWith(expect.stringContaining('Failed to read native sqlite'), expect.anything());
  });
});
