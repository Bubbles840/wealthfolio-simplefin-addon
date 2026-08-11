import { describe, it, expect, vi } from 'vitest';
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending, getNativeCategoryCatalog, getNativeSubcategorySpending, getNativeSpendingCategories, getNativeCategorizedSpending } from './sqlite-native.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeTestDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-sqlite-test-'));
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, name TEXT, parent_id TEXT, taxonomy_id TEXT, icon TEXT, color TEXT, sort_order INTEGER);
    -- "notes" is the real column name for what the REST API calls "comment";
    -- SELECT comment FROM activities fails with "no such column: comment", so
    -- the fixture carries the SQLite name deliberately.
    CREATE TABLE activities (id TEXT PRIMARY KEY, amount TEXT, activity_date TEXT, activity_type TEXT, notes TEXT, account_id TEXT, subtype TEXT, currency TEXT);
    CREATE TABLE activity_taxonomy_assignments (activity_id TEXT, category_id TEXT, taxonomy_id TEXT);
    CREATE TABLE budget_targets (category_id TEXT, amount TEXT, period_key TEXT, updated_at TEXT);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT);
    CREATE TABLE budget_groups (id TEXT PRIMARY KEY, name TEXT, key TEXT, color TEXT, icon TEXT, sort_order INTEGER);
    CREATE TABLE budget_group_assignments (id TEXT PRIMARY KEY, group_id TEXT, taxonomy_id TEXT, category_id TEXT);
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

  describe('getNativeUncategorizedSpending', () => {
    const seed = (path: string) => {
      const db = new DatabaseSync(path);
      db.exec(`
        INSERT INTO accounts (id, name) VALUES ('wf-a', 'Spend (4937)');
        INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-1', 'Groceries', NULL);
        -- Uncategorized spending: the one row the sweep exists to find.
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id) VALUES ('act-1', '45.16', '2026-07-09T00:00:00Z', 'WITHDRAWAL', 'VENMO PAYMENT · TRN-aaa', 'wf-a');
        -- Categorized: has an assignment, must not appear.
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id) VALUES ('act-2', '12.00', '2026-07-10T00:00:00Z', 'WITHDRAWAL', 'KROGER · TRN-bbb', 'wf-a');
        INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('act-2', 'cat-1');
        -- Non-spending types: transfers and deposits need no category.
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id) VALUES ('act-3', '700.00', '2026-07-11T00:00:00Z', 'TRANSFER_OUT', 'Payment · TRN-ccc', 'wf-a');
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id) VALUES ('act-4', '61.05', '2026-07-11T00:00:00Z', 'DEPOSIT', 'Venmo in · TRN-ddd', 'wf-a');
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id) VALUES ('act-4b', '70.00', '2026-07-11T00:00:00Z', 'CREDIT', 'Thankyou Points · TRN-ddd2', 'wf-a');
        -- Internal markers: never nag about rows the sync itself wrote.
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id) VALUES ('act-5', '1169.56', '2026-07-12T00:00:00Z', 'WITHDRAWAL', 'Starting balance · ACT-x', 'wf-a');
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id) VALUES ('act-6', '10.00', '2026-07-12T00:00:00Z', 'WITHDRAWAL', 'Balance adjustment · sfin-1 · 2026-07-12', 'wf-a');
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id) VALUES ('act-7', '1300.00', '2026-07-13T00:00:00Z', 'WITHDRAWAL', '↔️ In-transit transfer · PNC · TRN-eee', 'wf-a');
        -- Outside the window.
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id) VALUES ('act-8', '9.99', '2026-05-01T00:00:00Z', 'WITHDRAWAL', 'OLD ROW · TRN-fff', 'wf-a');
      `);
      db.close();
    };

    it('returns uncategorized spending AND income inside the window, never transfers or markers', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seed(path);
        const rows = getNativeUncategorizedSpending(path, '2026-07-01', '2026-08-01');
        expect(rows.map((r) => r.activityId)).toEqual(['act-4', 'act-4b', 'act-1']);
        expect(rows[2]).toEqual({
          activityId: 'act-1',
          wfAccountId: 'wf-a',
          notes: 'VENMO PAYMENT · TRN-aaa',
          amountCents: 4516,
          date: '2026-07-09',
          accountName: 'Spend (4937)',
        });
      } finally {
        cleanup();
      }
    });

    it('reads rows a live writer has not checkpointed yet (the two-day-stale snapshot bug)', () => {
      // The live incident: the main DB file was last checkpointed 07-31, the
      // write-ahead log held TWO DAYS of newer activity, and the immutable-mode
      // read the companion used sees only the checkpointed file — so the sweep
      // missed every recent uncategorized row and the daily reports were stale.
      // The reader must see through the WAL while a writer holds it open.
      const { path, cleanup } = makeTestDb();
      try {
        seed(path);
        const writer = new DatabaseSync(path);
        writer.exec("PRAGMA journal_mode=WAL;");
        writer.exec("INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id) VALUES ('act-wal', '4.99', '2026-07-14T00:00:00Z', 'WITHDRAWAL', 'QR LIBRARY · TRN-wal', 'wf-a');");
        try {
          const rows = getNativeUncategorizedSpending(path, '2026-07-01', '2026-08-01');
          expect(rows.map((r) => r.activityId)).toContain('act-wal');
        } finally {
          writer.close();
        }
      } finally {
        cleanup();
      }
    });

    it('returns [] on malformed date bounds rather than querying with them', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seed(path);
        expect(getNativeUncategorizedSpending(path, "2026-07-01' OR 1=1 --", '2026-08-01')).toEqual([]);
      } finally {
        cleanup();
      }
    });
  });

  describe('getNativeCategoryCatalog', () => {
    const seed = (path: string) => {
      const db = new DatabaseSync(path);
      db.exec(`
        INSERT INTO taxonomy_categories (id,name,parent_id,taxonomy_id,icon,color,sort_order) VALUES
          ('cat_transport','Transportation',NULL,'spending_categories','Car','#24837B',1),
          ('cat_transport_gas','Gas & Fuel','cat_transport','spending_categories','Fuel','#24837B',1),
          ('cat_transport_park','Parking','cat_transport','spending_categories','SquareParking','#24837B',2),
          -- Neither budgeted nor spent: the whole point. Personal Care was
          -- invisible in the addon because the old list was budget-or-spend only.
          ('cat_personal','Personal Care',NULL,'spending_categories','Sparkles','#B0552E',2),
          -- A different taxonomy must not leak in.
          ('inc_other','Other Income',NULL,'income_sources','Wallet','#4F6B92',1);
        INSERT INTO accounts (id,name) VALUES ('wf-a','Spend');
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id) VALUES ('a1','71.00','2026-07-06T00:00:00Z','WITHDRAWAL','GAS','wf-a');
        INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('a1','cat_transport_gas');
        INSERT INTO budget_targets (category_id,amount,period_key,updated_at)
          VALUES ('cat_transport','300','2026-07','2026-07-01T00:00:00Z');
      `);
      db.close();
    };

    it('returns every spending category, including ones with no budget and no spending', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seed(path);
        const cat = getNativeCategoryCatalog(path, '2026-07');
        expect(cat.map((c) => c.name).sort()).toEqual(
          ['Gas & Fuel', 'Parking', 'Personal Care', 'Transportation'],
        );
        // Income lives in a different taxonomy and is not a spending category.
        expect(cat.map((c) => c.name)).not.toContain('Other Income');
      } finally {
        cleanup();
      }
    });

    it('carries the parent, and Wealthfolio own icon and colour', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seed(path);
        const byName = new Map(getNativeCategoryCatalog(path, '2026-07').map((c) => [c.name, c]));
        expect(byName.get('Gas & Fuel')).toMatchObject({
          parent: 'Transportation', icon: 'Fuel', color: '#24837B',
        });
        expect(byName.get('Transportation')).toMatchObject({ parent: null, icon: 'Car' });
      } finally {
        cleanup();
      }
    });

    it('flags which categories have a budget and which saw money move', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seed(path);
        const byName = new Map(getNativeCategoryCatalog(path, '2026-07').map((c) => [c.name, c]));
        // Budget sits on the parent; the spend sits on the child.
        expect(byName.get('Transportation')).toMatchObject({ hasBudget: true, hasSpend: false });
        expect(byName.get('Gas & Fuel')).toMatchObject({ hasBudget: false, hasSpend: true });
        // The flags are what the REPORT filters on; the addon shows all of them.
        expect(byName.get('Personal Care')).toMatchObject({ hasBudget: false, hasSpend: false });
      } finally {
        cleanup();
      }
    });


    it('carries the budget group each category belongs to, with its own icon and order', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`
          INSERT INTO taxonomy_categories (id,name,parent_id,taxonomy_id,icon,color,sort_order) VALUES
            ('cat_housing','Housing',NULL,'spending_categories','Home','#B0552E',1),
            ('cat_fun','Entertainment',NULL,'spending_categories','Film','#24837B',2),
            ('cat_loose','Uncategorised Thing',NULL,'spending_categories','Tag',NULL,3);
          INSERT INTO budget_groups (id,name,key,color,icon,sort_order) VALUES
            ('grp_needs','Needs','needs','#4F6B92','Home',1),
            ('grp_wants','Wants','wants','#B0552E','Tag',2);
          INSERT INTO budget_group_assignments (id,group_id,taxonomy_id,category_id) VALUES
            ('a1','grp_needs','spending_categories','cat_housing'),
            ('a2','grp_wants','spending_categories','cat_fun');
        `);
        db.close();

        const byName = new Map(getNativeCategoryCatalog(path, '2026-07').map((c) => [c.name, c]));
        expect(byName.get('Housing')).toMatchObject({ group: 'Needs', groupSort: 1 });
        expect(byName.get('Entertainment')).toMatchObject({ group: 'Wants', groupSort: 2 });
        // A category nobody assigned must still appear — dropping it would hide a
        // real category from the selector, which is the bug this catalog fixed.
        expect(byName.get('Uncategorised Thing')).toMatchObject({ group: null });
      } finally {
        cleanup();
      }
    });


    it('picks up a group and a category added later, with no code change', () => {
      // Groups are user-editable in Wealthfolio just like categories, so nothing
      // here may hardcode the six defaults: the catalog reads whatever exists at
      // query time and inherits Wealthfolio's own ordering.
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`
          INSERT INTO budget_groups (id,name,key,color,icon,sort_order) VALUES
            ('grp_needs','Needs','needs',NULL,'Home',1);
          INSERT INTO taxonomy_categories (id,name,parent_id,taxonomy_id,icon,color,sort_order)
            VALUES ('cat_housing','Housing',NULL,'spending_categories','Home',NULL,1);
          INSERT INTO budget_group_assignments (id,group_id,taxonomy_id,category_id)
            VALUES ('a1','grp_needs','spending_categories','cat_housing');
        `);
        db.close();
        expect(getNativeCategoryCatalog(path, '2026-07').map((c) => c.group)).toEqual(['Needs']);

        // The user adds a group AND a category, and assigns one to the other.
        const db2 = new DatabaseSync(path);
        db2.exec(`
          INSERT INTO budget_groups (id,name,key,color,icon,sort_order) VALUES
            ('grp_pets','Pet Care','pet_care',NULL,'PawPrint',2);
          INSERT INTO taxonomy_categories (id,name,parent_id,taxonomy_id,icon,color,sort_order)
            VALUES ('cat_vet','Vet',NULL,'spending_categories','Stethoscope',NULL,1);
          INSERT INTO budget_group_assignments (id,group_id,taxonomy_id,category_id)
            VALUES ('a2','grp_pets','spending_categories','cat_vet');
        `);
        db2.close();

        const after = getNativeCategoryCatalog(path, '2026-07');
        expect(after.map((c) => [c.name, c.group])).toEqual([
          ['Housing', 'Needs'],   // group sort_order 1 first...
          ['Vet', 'Pet Care'],    // ...then the new group at 2
        ]);
        expect(after.find((c) => c.name === 'Vet')!.groupIcon).toBe('PawPrint');
      } finally {
        cleanup();
      }
    });

    it('returns [] rather than throwing when the database is missing', () => {
      expect(getNativeCategoryCatalog('/nonexistent/wealthfolio.db', '2026-07')).toEqual([]);
    });
  });

  describe('getNativeSpendingCategories', () => {
    it('returns id, name and parent for every spending category, parents before their children', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`
          INSERT INTO taxonomy_categories (id,name,parent_id,taxonomy_id,sort_order) VALUES
            ('p1','Food & Dining',NULL,'spending_categories',1),
            ('c1','Restaurants','p1','spending_categories',1),
            ('c2','Groceries','p1','spending_categories',2),
            ('t1','Transportation',NULL,'spending_categories',2);
        `);
        db.close();

        const cats = getNativeSpendingCategories(path);
        // Grouped by parent name (own name for top-level rows), parent row
        // first within its group, then children by sort_order.
        expect(cats.map((c) => c.name)).toEqual([
          'Food & Dining', 'Restaurants', 'Groceries', 'Transportation',
        ]);
      } finally {
        cleanup();
      }
    });

    it('carries id, parentId and parentName for a child, and nulls for a top-level category', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`
          INSERT INTO taxonomy_categories (id,name,parent_id,taxonomy_id,sort_order) VALUES
            ('p1','Food & Dining',NULL,'spending_categories',1),
            ('c1','Restaurants','p1','spending_categories',1);
        `);
        db.close();

        const byName = new Map(getNativeSpendingCategories(path).map((c) => [c.name, c]));
        expect(byName.get('Restaurants')).toEqual({
          id: 'c1', name: 'Restaurants', parentId: 'p1', parentName: 'Food & Dining',
        });
        expect(byName.get('Food & Dining')).toEqual({
          id: 'p1', name: 'Food & Dining', parentId: null, parentName: null,
        });
      } finally {
        cleanup();
      }
    });

    it('excludes categories from other taxonomies, e.g. income_sources', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`
          INSERT INTO taxonomy_categories (id,name,parent_id,taxonomy_id,sort_order) VALUES
            ('cat-1','Groceries',NULL,'spending_categories',1),
            ('inc-1','Salary',NULL,'income_sources',1);
        `);
        db.close();

        const names = getNativeSpendingCategories(path).map((c) => c.name);
        expect(names).toContain('Groceries');
        expect(names).not.toContain('Salary');
      } finally {
        cleanup();
      }
    });

    it('returns [] rather than throwing when the database is missing', () => {
      expect(getNativeSpendingCategories('/nonexistent/wealthfolio.db')).toEqual([]);
    });
  });

  describe('getNativeSubcategorySpending', () => {
    it('returns child-level rows keyed by parent, so the caller can choose rollup or breakdown', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`
          INSERT INTO taxonomy_categories (id,name,parent_id,taxonomy_id) VALUES
            ('p1','Transportation',NULL,'spending_categories'),
            ('c1','Gas & Fuel','p1','spending_categories'),
            ('c2','Parking','p1','spending_categories'),
            ('p2','Groceries',NULL,'spending_categories');
          INSERT INTO activities (id,amount,activity_date,activity_type) VALUES
            ('a1','-71.00','2026-07-06','WITHDRAWAL'),
            ('a2','-34.00','2026-07-07','WITHDRAWAL'),
            ('a3','-15.00','2026-07-08','WITHDRAWAL'),
            ('a4','-60.00','2026-07-09','WITHDRAWAL');
          INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES
            ('a1','c1'),('a2','c2'),('a3','c1'),('a4','p2');
        `);
        db.close();

        const rows = getNativeSubcategorySpending(path, '2026-07-01', '2026-08-01');
        // Children carry their parent; spend booked straight on a parent reports
        // with a null child, so no money can go missing from a breakdown.
        expect(rows).toEqual(expect.arrayContaining([
          { parent: 'Transportation', child: 'Gas & Fuel', spent: 86 },
          { parent: 'Transportation', child: 'Parking', spent: 34 },
          { parent: 'Groceries', child: null, spent: 60 },
        ]));
        expect(rows).toHaveLength(3);
      } finally {
        cleanup();
      }
    });

    it('sums to the same totals as the rolled-up reader, so the two views cannot disagree', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`
          INSERT INTO taxonomy_categories (id,name,parent_id,taxonomy_id) VALUES
            ('p1','Transportation',NULL,'spending_categories'),
            ('c1','Gas & Fuel','p1','spending_categories');
          INSERT INTO activities (id,amount,activity_date,activity_type) VALUES
            ('a1','-71.00','2026-07-06','WITHDRAWAL'),('a2','-9.00','2026-07-07','FEE');
          INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('a1','c1'),('a2','c1');
        `);
        db.close();

        const rolled = getNativeWealthfolioSpendingBetween(path, '2026-07-01', '2026-08-01');
        const split = getNativeSubcategorySpending(path, '2026-07-01', '2026-08-01');
        const byParent: Record<string, number> = {};
        for (const r of split) byParent[r.parent] = (byParent[r.parent] ?? 0) + r.spent;
        expect(byParent).toEqual(rolled);
      } finally {
        cleanup();
      }
    });

    it('returns [] on a missing database or malformed bounds', () => {
      expect(getNativeSubcategorySpending('/nonexistent/x.db', '2026-07-01', '2026-08-01')).toEqual([]);
    });
  });

  describe('getNativeCategorizedSpending', () => {
    const seed = (path: string) => {
      const db = new DatabaseSync(path);
      db.exec(`
        INSERT INTO accounts (id, name) VALUES ('wf-a', 'Spend (4937)');
        INSERT INTO taxonomy_categories (id, name, parent_id, taxonomy_id) VALUES
          ('cat-spend', 'Groceries', NULL, 'spending_categories'),
          ('cat-inc', 'Salary', NULL, 'income_sources'),
          ('cat-spend-2', 'Restaurants', NULL, 'spending_categories');
        -- Carries an assignment in BOTH taxonomies: the load-bearing case —
        -- both must survive the fold, and each must resolve its name from its
        -- OWN taxonomy row, not the other's.
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id)
          VALUES ('act-both', '-50.00', '2026-07-10', 'WITHDRAWAL', 'DUAL TAGGED · TRN-both', 'wf-a');
        INSERT INTO activity_taxonomy_assignments (activity_id, category_id, taxonomy_id) VALUES
          ('act-both', 'cat-spend', 'spending_categories'),
          ('act-both', 'cat-inc', 'income_sources');
        -- Plain single-assignment row.
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id)
          VALUES ('act-one', '-12.00', '2026-07-09', 'WITHDRAWAL', 'KROGER · TRN-one', 'wf-a');
        INSERT INTO activity_taxonomy_assignments (activity_id, category_id, taxonomy_id)
          VALUES ('act-one', 'cat-spend-2', 'spending_categories');
        -- Uncategorized: no assignment row at all. Must be absent (INNER JOIN).
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id)
          VALUES ('act-uncat', '-9.00', '2026-07-09', 'WITHDRAWAL', 'VENMO · TRN-uncat', 'wf-a');
        -- Assignment points at a category id that no longer exists in
        -- taxonomy_categories — the LEFT JOIN yields NULL, which must coalesce
        -- to '' rather than dropping the row.
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id)
          VALUES ('act-orphan', '-7.00', '2026-07-08', 'WITHDRAWAL', 'ORPHAN CAT · TRN-orphan', 'wf-a');
        INSERT INTO activity_taxonomy_assignments (activity_id, category_id, taxonomy_id)
          VALUES ('act-orphan', 'cat-deleted', 'spending_categories');
        -- Internal marker note: categorized, but must never surface (mirrors
        -- the uncategorized reader's exclusion).
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id)
          VALUES ('act-marker', '-10.00', '2026-07-11', 'WITHDRAWAL', 'Balance adjustment · sfin-1 · 2026-07-11', 'wf-a');
        INSERT INTO activity_taxonomy_assignments (activity_id, category_id, taxonomy_id)
          VALUES ('act-marker', 'cat-spend', 'spending_categories');
        -- Outside the window.
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id)
          VALUES ('act-old', '-1.00', '2026-05-01', 'WITHDRAWAL', 'OLD ROW · TRN-old', 'wf-a');
        INSERT INTO activity_taxonomy_assignments (activity_id, category_id, taxonomy_id)
          VALUES ('act-old', 'cat-spend', 'spending_categories');
      `);
      db.close();
    };

    it('folds a row with assignments in two taxonomies into ONE tx with both entries, each name resolved from its own taxonomy', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seed(path);
        const rows = getNativeCategorizedSpending(path, '2026-07-01', '2026-08-01');
        const both = rows.find((r) => r.activityId === 'act-both');
        expect(both).toBeDefined();
        expect(both!.assignments).toHaveLength(2);
        expect(both!.assignments).toEqual(expect.arrayContaining([
          { taxonomyId: 'spending_categories', categoryId: 'cat-spend', categoryName: 'Groceries' },
          { taxonomyId: 'income_sources', categoryId: 'cat-inc', categoryName: 'Salary' },
        ]));
      } finally {
        cleanup();
      }
    });

    it('returns a row with a single assignment as a one-entry array', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seed(path);
        const rows = getNativeCategorizedSpending(path, '2026-07-01', '2026-08-01');
        const one = rows.find((r) => r.activityId === 'act-one');
        expect(one).toEqual({
          activityId: 'act-one',
          notes: 'KROGER · TRN-one',
          amountCents: 1200,
          date: '2026-07-09',
          accountName: 'Spend (4937)',
          activityType: 'WITHDRAWAL',
          // Neither the activity nor its account set these — must default to
          // '', not null/undefined, so the bucket predicate never sees a gap.
          accountId: 'wf-a',
          currency: '',
          subtype: '',
          accountType: '',
          assignments: [
            { taxonomyId: 'spending_categories', categoryId: 'cat-spend-2', categoryName: 'Restaurants' },
          ],
        });
      } finally {
        cleanup();
      }
    });

    it('excludes an uncategorized row entirely', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seed(path);
        const rows = getNativeCategorizedSpending(path, '2026-07-01', '2026-08-01');
        expect(rows.map((r) => r.activityId)).not.toContain('act-uncat');
      } finally {
        cleanup();
      }
    });

    it('coalesces a NULL category name (deleted/orphaned category) to empty string rather than dropping the row', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seed(path);
        const rows = getNativeCategorizedSpending(path, '2026-07-01', '2026-08-01');
        const orphan = rows.find((r) => r.activityId === 'act-orphan');
        expect(orphan).toBeDefined();
        expect(orphan!.assignments).toEqual([
          { taxonomyId: 'spending_categories', categoryId: 'cat-deleted', categoryName: '' },
        ]);
      } finally {
        cleanup();
      }
    });

    it('excludes rows carrying an internal stored-note marker even though categorized', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seed(path);
        const rows = getNativeCategorizedSpending(path, '2026-07-01', '2026-08-01');
        expect(rows.map((r) => r.activityId)).not.toContain('act-marker');
      } finally {
        cleanup();
      }
    });

    it('respects the half-open date bounds', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seed(path);
        const rows = getNativeCategorizedSpending(path, '2026-07-01', '2026-08-01');
        expect(rows.map((r) => r.activityId)).not.toContain('act-old');
      } finally {
        cleanup();
      }
    });

    it('returns [] when the db path is missing', () => {
      expect(getNativeCategorizedSpending('/nonexistent/wealthfolio.db', '2026-07-01', '2026-08-01')).toEqual([]);
    });

    it('returns [] on malformed date bounds rather than querying with them', () => {
      const { path, cleanup } = makeTestDb();
      try {
        seed(path);
        expect(getNativeCategorizedSpending(path, "2026-07-01' OR 1=1 --", '2026-08-01')).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it('carries subtype, accountId, currency and the account type — the inputs the reimbursement bucket predicate needs', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`
          INSERT INTO accounts (id, name, account_type) VALUES ('wf-cash', 'Checking', 'CASH');
          INSERT INTO taxonomy_categories (id, name, parent_id, taxonomy_id) VALUES ('cat-spend', 'Groceries', NULL, 'spending_categories');
          INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id, subtype, currency)
            VALUES ('act-reimb', '-25.00', '2026-07-12', 'CREDIT', 'VENMO PAYBACK · TRN-reimb', 'wf-cash', 'REIMBURSEMENT', 'USD');
          INSERT INTO activity_taxonomy_assignments (activity_id, category_id, taxonomy_id) VALUES ('act-reimb', 'cat-spend', 'spending_categories');
        `);
        db.close();

        const rows = getNativeCategorizedSpending(path, '2026-07-01', '2026-08-01');
        const reimb = rows.find((r) => r.activityId === 'act-reimb');
        expect(reimb).toBeDefined();
        expect(reimb).toMatchObject({
          accountId: 'wf-cash',
          currency: 'USD',
          subtype: 'REIMBURSEMENT',
          accountType: 'CASH',
        });
      } finally {
        cleanup();
      }
    });

  });
});
