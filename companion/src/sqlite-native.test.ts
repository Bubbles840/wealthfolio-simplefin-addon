import { describe, it, expect } from 'vitest';
import { getNativeWealthfolioSpending, getNativeWealthfolioBudgets } from './sqlite-native.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeTestDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-sqlite-test-'));
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, name TEXT, parent_id TEXT);
    CREATE TABLE activities (id TEXT PRIMARY KEY, amount TEXT, activity_date TEXT, activity_type TEXT);
    CREATE TABLE activity_taxonomy_assignments (activity_id TEXT, category_id TEXT);
    CREATE TABLE budget_targets (category_id TEXT, amount TEXT, period_key TEXT, updated_at TEXT);
  `);
  db.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('sqlite-native', () => {
  it('returns empty record when db path does not exist', () => {
    const res = getNativeWealthfolioSpending('/nonexistent/wealthfolio.db', '2026-07');
    expect(res).toEqual({});
  });

  it('returns empty record for budgets when db path does not exist', () => {
    const res = getNativeWealthfolioBudgets('/nonexistent/wealthfolio.db', '2026-07');
    expect(res).toEqual({});
  });

  describe('getNativeWealthfolioBudgets month-vs-default selection', () => {
    it('prefers the month-specific budget row even when the default row was edited more recently', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-1', 'Groceries', NULL)`);
        // Month-specific row, edited FIRST (older updated_at)...
        db.exec(`INSERT INTO budget_targets (category_id, amount, period_key, updated_at)
                 VALUES ('cat-1', '400', '2026-07', '2026-06-01T00:00:00Z')`);
        // ...default row, edited LATER (newer updated_at) — must still lose.
        db.exec(`INSERT INTO budget_targets (category_id, amount, period_key, updated_at)
                 VALUES ('cat-1', '999', 'default', '2026-07-15T00:00:00Z')`);
        db.close();

        const result = getNativeWealthfolioBudgets(path, '2026-07');
        expect(result['Groceries']).toBe(400);
      } finally {
        cleanup();
      }
    });

    it('falls back to the default row when no month-specific row exists', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-1', 'Groceries', NULL)`);
        db.exec(`INSERT INTO budget_targets (category_id, amount, period_key, updated_at)
                 VALUES ('cat-1', '250', 'default', '2026-01-01T00:00:00Z')`);
        db.close();

        const result = getNativeWealthfolioBudgets(path, '2026-07');
        expect(result['Groceries']).toBe(250);
      } finally {
        cleanup();
      }
    });
  });

  describe('getNativeWealthfolioSpending month upper bound', () => {
    it('excludes transactions dated in a later month', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-1', 'Groceries', NULL)`);
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type)
                 VALUES ('a1', '-50', '2026-07-15', 'WITHDRAWAL')`);
        db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('a1', 'cat-1')`);
        // Next month — must NOT be counted in the July total.
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type)
                 VALUES ('a2', '-999', '2026-08-01', 'WITHDRAWAL')`);
        db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('a2', 'cat-1')`);
        db.close();

        const result = getNativeWealthfolioSpending(path, '2026-07');
        expect(result['Groceries']).toBe(50);
      } finally {
        cleanup();
      }
    });
  });
});
