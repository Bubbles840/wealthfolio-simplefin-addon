import { describe, it, expect, vi } from 'vitest';
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending } from './sqlite-native.js';
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
    -- "notes" is the real column name for what the REST API calls "comment";
    -- SELECT comment FROM activities fails with "no such column: comment", so
    -- the fixture carries the SQLite name deliberately.
    CREATE TABLE activities (id TEXT PRIMARY KEY, amount TEXT, activity_date TEXT, activity_type TEXT, notes TEXT);
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

  describe('getNativeWealthfolioSpendingBetween', () => {
    it('returns empty record when db path does not exist', () => {
      expect(getNativeWealthfolioSpendingBetween('/nonexistent/wealthfolio.db', '2026-07-06', '2026-08-01')).toEqual({});
    });

    it('counts only activities inside the half-open range', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-1', 'Groceries', NULL)`);
        // Before the window — earlier in the same month.
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type) VALUES ('a1', '-500', '2026-07-05', 'WITHDRAWAL')`);
        // Inside the window.
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type) VALUES ('a2', '-30', '2026-07-06', 'WITHDRAWAL')`);
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type) VALUES ('a3', '-20', '2026-07-31', 'WITHDRAWAL')`);
        // At the exclusive upper bound — must not count.
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type) VALUES ('a4', '-999', '2026-08-01', 'WITHDRAWAL')`);
        for (const id of ['a1', 'a2', 'a3', 'a4']) {
          db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('${id}', 'cat-1')`);
        }
        db.close();

        expect(getNativeWealthfolioSpendingBetween(path, '2026-07-06', '2026-08-01')).toEqual({ Groceries: 50 });
      } finally {
        cleanup();
      }
    });

    it('applies the same type filter, transfers exclusion and parent rollup as the month reader', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('p1', 'Food & Dining', NULL)`);
        db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('c1', 'Restaurants', 'p1')`);
        db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('t1', 'Transfers', NULL)`);
        // Child rolls up to the parent's name.
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type) VALUES ('a1', '-12.5', '2026-07-06', 'WITHDRAWAL')`);
        db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('a1', 'c1')`);
        // FEE and TAX count too.
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type) VALUES ('a2', '-2.25', '2026-07-07', 'FEE')`);
        db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('a2', 'c1')`);
        // A DEPOSIT does not.
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type) VALUES ('a3', '-100', '2026-07-08', 'DEPOSIT')`);
        db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('a3', 'c1')`);
        // Transfers are excluded entirely.
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type) VALUES ('a4', '-400', '2026-07-08', 'WITHDRAWAL')`);
        db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('a4', 't1')`);
        db.close();

        expect(getNativeWealthfolioSpendingBetween(path, '2026-07-06', '2026-08-01')).toEqual({ 'Food & Dining': 14.75 });
      } finally {
        cleanup();
      }
    });

    it('rejects a malformed date bound instead of interpolating it into SQL', () => {
      const { path, cleanup } = makeTestDb();
      try {
        expect(getNativeWealthfolioSpendingBetween(path, `2026-07-06' OR '1'='1`, '2026-08-01')).toEqual({});
      } finally {
        cleanup();
      }
    });

    it('is what the month reader delegates to — identical totals for the month window', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-1', 'Groceries', NULL)`);
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type) VALUES ('a1', '-40.10', '2026-12-01', 'WITHDRAWAL')`);
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type) VALUES ('a2', '-9.90', '2026-12-31', 'WITHDRAWAL')`);
        // December rolls the year over — the month reader must ask for
        // 2027-01-01 as its exclusive bound, not 2026-13-01.
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type) VALUES ('a3', '-1000', '2027-01-01', 'WITHDRAWAL')`);
        for (const id of ['a1', 'a2', 'a3']) {
          db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('${id}', 'cat-1')`);
        }
        db.close();

        expect(getNativeWealthfolioSpending(path, '2026-12')).toEqual({ Groceries: 50 });
        expect(getNativeWealthfolioSpending(path, '2026-12')).toEqual(
          getNativeWealthfolioSpendingBetween(path, '2026-12-01', '2027-01-01'),
        );
      } finally {
        cleanup();
      }
    });
  });

  describe('getNativeWealthfolioTopSpending', () => {
    /** A week's worth of spending covering every stored-note shape, plus the rows
     *  that must NOT make the list. Amounts are deliberately out of order. */
    function seedWeek(path: string): void {
      const db = new DatabaseSync(path);
      db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('p1', 'Food & Dining', NULL)`);
      db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('c1', 'Restaurants', 'p1')`);
      db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('t1', 'Transportation', NULL)`);
      db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('s1', 'Shopping', NULL)`);
      db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('x1', 'Transfers', NULL)`);

      const rows: Array<[string, string, string, string, string | null, string]> = [
        // id, amount, date, type, notes, category
        // Plain synced note: description + tx id. Child category rolls up to its parent.
        ['a1', '-95.50', '2026-07-08', 'WITHDRAWAL', 'TARGET 00021479 · TRN-a1b2c3d4', 'c1'],
        // Biggest of the week, and a pending row: ` · pending` trails the id.
        ['a2', '-412.37', '2026-07-07', 'WITHDRAWAL', 'WHOLE FOODS MKT · TRN-b2c3d4e5 · pending', 'c1'],
        // An in-transit placeholder the user has miscategorised as real spending —
        // the one row whose note carries the marker PREFIX as well as the suffix.
        ['a3', '-180.00', '2026-07-09', 'WITHDRAWAL', '↔️ In-transit transfer · Online Transfer to Savings · TRN-c3d4e5f6', 's1'],
        // A description that itself contains ' · ': all of it must survive.
        ['a4', '-63.00', '2026-07-10', 'FEE', 'COSTCO GAS · PUMP 4 · TRN-d4e5f6a7', 't1'],
        // No note at all (a hand-entered row, or a blank bank description).
        ['a5', '-20.00', '2026-07-10', 'TAX', null, 's1'],
        // A transfer miscategorised into the Transfers category: excluded, and it
        // would otherwise top the list by a wide margin.
        ['x1', '-5000.00', '2026-07-08', 'WITHDRAWAL', 'Online Transfer to Savings · TRN-xxxx', 'x1'],
        // Not spending.
        ['x2', '-9999.00', '2026-07-08', 'DEPOSIT', 'PAYCHECK · TRN-yyyy', 'c1'],
        // Outside the window on both sides.
        ['x3', '-8888.00', '2026-07-05', 'WITHDRAWAL', 'LAST WEEK · TRN-zzzz', 'c1'],
        ['x4', '-7777.00', '2026-07-13', 'WITHDRAWAL', 'NEXT WEEK · TRN-wwww', 'c1'],
      ];
      for (const [id, amount, date, type, notes, cat] of rows) {
        const notesSql = notes === null ? 'NULL' : `'${notes.replace(/'/g, "''")}'`;
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, notes)
                 VALUES ('${id}', '${amount}', '${date}', '${type}', ${notesSql})`);
        db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('${id}', '${cat}')`);
      }
      db.close();
    }

    it('returns an empty list when the db path does not exist', () => {
      expect(getNativeWealthfolioTopSpending('/nonexistent/wealthfolio.db', '2026-07-06', '2026-07-13', 5)).toEqual([]);
    });

    it('returns the biggest individual spends, largest first, with display-ready descriptions', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seedWeek(path);
        // Proves the primary node:sqlite path actually ran: a wrong column name
        // (`comment` — the REST API's name, not SQLite's) logs and falls through
        // to the sqlite3 CLI, which would return [] on most machines and could
        // return the right answer on some, hiding the bug either way.
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          expect(getNativeWealthfolioTopSpending(path, '2026-07-06', '2026-07-13', 5)).toEqual([
            { amount: 412.37, description: 'WHOLE FOODS MKT', categoryName: 'Food & Dining' },
            { amount: 180, description: 'Online Transfer to Savings', categoryName: 'Shopping' },
            { amount: 95.5, description: 'TARGET 00021479', categoryName: 'Food & Dining' },
            { amount: 63, description: 'COSTCO GAS · PUMP 4', categoryName: 'Transportation' },
            { amount: 20, description: '', categoryName: 'Shopping' },
          ]);
          expect(errors).not.toHaveBeenCalled();
        } finally {
          errors.mockRestore();
        }
      } finally {
        cleanup();
      }
    });

    it('limits to N — the caller asks for five, and a busy week has hundreds', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seedWeek(path);
        const top = getNativeWealthfolioTopSpending(path, '2026-07-06', '2026-07-13', 2);
        expect(top.map((t) => t.amount)).toEqual([412.37, 180]);
      } finally {
        cleanup();
      }
    });

    it('returns nothing for a non-positive or non-finite limit instead of interpolating it', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seedWeek(path);
        expect(getNativeWealthfolioTopSpending(path, '2026-07-06', '2026-07-13', 0)).toEqual([]);
        expect(getNativeWealthfolioTopSpending(path, '2026-07-06', '2026-07-13', -1)).toEqual([]);
        expect(getNativeWealthfolioTopSpending(path, '2026-07-06', '2026-07-13', NaN)).toEqual([]);
        expect(getNativeWealthfolioTopSpending(path, '2026-07-06', '2026-07-13', 1.5)).toHaveLength(1);
      } finally {
        cleanup();
      }
    });

    it('rejects a malformed date bound instead of interpolating it into SQL', () => {
      const { path, cleanup } = makeTestDb();
      try {
        expect(getNativeWealthfolioTopSpending(path, `2026-07-06' OR '1'='1`, '2026-07-13', 5)).toEqual([]);
        expect(getNativeWealthfolioTopSpending(path, '2026-07-06', `2026-07-13' --`, 5)).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it('agrees with the aggregate spending reader about what counts as spending', () => {
      // Same window, same rows: summing the individual transactions per category
      // must reproduce the category totals exactly, or the report's headline and
      // its "biggest this week" list would be describing different data.
      const { path, cleanup } = makeTestDb();
      try {
        seedWeek(path);
        const totals: Record<string, number> = {};
        for (const t of getNativeWealthfolioTopSpending(path, '2026-07-06', '2026-07-13', 100)) {
          totals[t.categoryName] = Math.round(((totals[t.categoryName] ?? 0) + t.amount) * 100) / 100;
        }
        expect(totals).toEqual(getNativeWealthfolioSpendingBetween(path, '2026-07-06', '2026-07-13'));
      } finally {
        cleanup();
      }
    });

    it('returns an empty list for a week with no spending at all', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seedWeek(path);
        expect(getNativeWealthfolioTopSpending(path, '2026-06-01', '2026-06-08', 5)).toEqual([]);
      } finally {
        cleanup();
      }
    });
  });
});
