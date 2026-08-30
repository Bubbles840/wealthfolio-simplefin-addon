import { describe, it, expect, vi } from 'vitest';
import { neutralAdjustmentFields } from '../../shared/sync-core.js';
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending,
  getNativeUncategorizedSpendingTotal, getNativeUncategorizedSpending, getNativeCategoryCatalog, getNativeSubcategorySpending, getNativeSpendingCategories, getNativeCategorizedSpending } from './sqlite-native.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeTestDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-sqlite-test-'));
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    -- taxonomy_id DEFAULTS to the spending taxonomy, and activities default to a
    -- cash account below, so the many existing fixtures that predate those two
    -- columns still describe a realistic row: in the real database every
    -- category belongs to a taxonomy and every activity to an account, and the
    -- spending reader now depends on both (see SPENDING_SIGN).
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, name TEXT, parent_id TEXT, taxonomy_id TEXT DEFAULT 'spending_categories', icon TEXT, color TEXT, sort_order INTEGER);
    -- "notes" is the real column name for what the REST API calls "comment";
    -- SELECT comment FROM activities fails with "no such column: comment", so
    -- the fixture carries the SQLite name deliberately.
    CREATE TABLE activities (id TEXT PRIMARY KEY, amount TEXT, activity_date TEXT, activity_type TEXT, notes TEXT, account_id TEXT DEFAULT 'acct-cash', subtype TEXT, currency TEXT, source_group_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (activity_id TEXT, category_id TEXT, taxonomy_id TEXT);
    CREATE TABLE budget_targets (category_id TEXT, amount TEXT, period_key TEXT, updated_at TEXT);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT);
    CREATE TABLE budget_groups (id TEXT PRIMARY KEY, name TEXT, key TEXT, color TEXT, icon TEXT, sort_order INTEGER);
    CREATE TABLE budget_group_assignments (id TEXT PRIMARY KEY, group_id TEXT, taxonomy_id TEXT, category_id TEXT);
  `);
  // One account of each kind the classifier distinguishes. `acct-cash` is the
  // activities default, so a fixture that says nothing about accounts gets the
  // cash rules — which is what every pre-existing test here assumes.
  db.exec(`
    INSERT INTO accounts (id, name, account_type) VALUES ('acct-cash', 'Spend', 'CASH');
    INSERT INTO accounts (id, name, account_type) VALUES ('acct-card', 'Card', 'CREDIT_CARD');
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

  /**
   * Wealthfolio's classification, which this reader used to approximate as
   * `activity_type IN ('WITHDRAWAL','FEE','TAX')`. Every case below was wrong
   * under that rule, and every one of them over-reported spending — so the
   * Telegram reports told the user they had less left than the app did.
   *
   * The live instance: Food & Dining read $157.16 here against $16.35 in the
   * app, the gap being $140.81 of Venmo reimbursements.
   */
  describe('spending classification matches the app', () => {
    const seed = (db: any) => {
      db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-food', 'Food & Dining', NULL)`);
      db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-health', 'Health & Wellness', NULL)`);
      // The income-taxonomy twin every reimbursement also carries.
      db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id, taxonomy_id) VALUES ('cat-income', 'Other Income', NULL, 'income_sources')`);
    };
    const add = (db: any, id: string, amount: string, type: string, opts: { acct?: string; subtype?: string; cat?: string } = {}) => {
      db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, account_id, subtype)
               VALUES ('${id}', '${amount}', '2026-08-05', '${type}', '${opts.acct ?? 'acct-cash'}', ${opts.subtype ? `'${opts.subtype}'` : 'NULL'})`);
      db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('${id}', '${opts.cat ?? 'cat-food'}')`);
    };

    it('nets a cash REIMBURSEMENT credit off the category it was filed under', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        seed(db);
        add(db, 'spend', '-157.16', 'WITHDRAWAL');
        add(db, 'back', '140.81', 'CREDIT', { subtype: 'REIMBURSEMENT' });
        db.close();
        // The exact figure the app shows for this month.
        expect(getNativeWealthfolioSpendingBetween(path, '2026-08-01', '2026-09-01')['Food & Dining'])
          .toBeCloseTo(16.35, 2);
      } finally { cleanup(); }
    });

    it('counts a reimbursement ONCE, despite its two taxonomy assignments', () => {
      // Every reimbursement is filed under both an income category and a
      // spending one. Joining all taxonomies counted the row twice, under two
      // names — and would now subtract it twice.
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        seed(db);
        add(db, 'spend', '-157.16', 'WITHDRAWAL');
        add(db, 'back', '140.81', 'CREDIT', { subtype: 'REIMBURSEMENT' });
        db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('back', 'cat-income')`);
        db.close();
        const res = getNativeWealthfolioSpendingBetween(path, '2026-08-01', '2026-09-01');
        expect(res['Food & Dining']).toBeCloseTo(16.35, 2);
        // The income side is not a spending category and must not appear at all.
        expect(res['Other Income']).toBeUndefined();
      } finally { cleanup(); }
    });

    it('treats ANY credit-card credit as a refund, subtype or not', () => {
      // Upstream ignores subtype entirely on a credit-card account, which is
      // how a $14.42 statement credit went uncounted.
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        seed(db);
        add(db, 'spend', '-100', 'WITHDRAWAL', { acct: 'acct-card', cat: 'cat-health' });
        add(db, 'credit', '14.42', 'CREDIT', { acct: 'acct-card', cat: 'cat-health' });
        db.close();
        expect(getNativeWealthfolioSpendingBetween(path, '2026-08-01', '2026-09-01')['Health & Wellness'])
          .toBeCloseTo(85.58, 2);
      } finally { cleanup(); }
    });

    it('ignores a bare cash credit, which is neither spend nor refund', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        seed(db);
        add(db, 'spend', '-100', 'WITHDRAWAL');
        add(db, 'credit', '25', 'CREDIT');
        db.close();
        expect(getNativeWealthfolioSpendingBetween(path, '2026-08-01', '2026-09-01')['Food & Dining'])
          .toBeCloseTo(100, 2);
      } finally { cleanup(); }
    });

    it('counts credit-card INTEREST and cash TRANSFER_OUT as spending', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        seed(db);
        add(db, 'int', '-9.99', 'INTEREST', { acct: 'acct-card', cat: 'cat-health' });
        add(db, 'out', '-20', 'TRANSFER_OUT');
        db.close();
        const res = getNativeWealthfolioSpendingBetween(path, '2026-08-01', '2026-09-01');
        expect(res['Health & Wellness']).toBeCloseTo(9.99, 2);
        expect(res['Food & Dining']).toBeCloseTo(20, 2);
      } finally { cleanup(); }
    });

    it('does not count cash INTEREST, which is income', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        seed(db);
        add(db, 'int', '4.13', 'INTEREST');
        db.close();
        expect(getNativeWealthfolioSpendingBetween(path, '2026-08-01', '2026-09-01')['Food & Dining'])
          .toBeUndefined();
      } finally { cleanup(); }
    });

    it('keeps a refund out of the biggest-spends list', () => {
      // That list answers "where did the money go"; a large refund topping it
      // would name the week's biggest INFLOW as its worst damage.
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        seed(db);
        add(db, 'spend', '-40', 'WITHDRAWAL');
        add(db, 'back', '140.81', 'CREDIT', { subtype: 'REIMBURSEMENT' });
        db.close();
        const top = getNativeWealthfolioTopSpending(path, '2026-08-01', '2026-09-01', 5);
        expect(top.map((t) => t.amount)).toEqual([40]);
      } finally { cleanup(); }
    });
  });

  describe('uncategorized spending total', () => {
    // The figure Wealthfolio shows as its "Uncategorized" bucket, and the one
    // every other reader here is blind to (they inner-join the assignments).
    it('counts unfiled charges but NOT internal transfers', () => {
      // The trap this exists for: a transfer between the user's own accounts is
      // uncategorizable in Wealthfolio, so it lands in exactly the "no
      // assignment" set. The first version of this query reported $3,210.62 for
      // a month whose real figure was $20.76 — a $3,000 savings transfer and two
      // card payments. A paired leg is the one thing with a source_group_id.
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, source_group_id)
                 VALUES ('t1', '-3000', '2026-08-10', 'TRANSFER_OUT', 'wf-transfer-abc')`);
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, source_group_id)
                 VALUES ('t2', '-94.93', '2026-08-05', 'TRANSFER_OUT', 'wf-transfer-def')`);
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type)
                 VALUES ('u1', '-10.59', '2026-08-20', 'WITHDRAWAL')`);
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type)
                 VALUES ('u2', '-10.17', '2026-08-20', 'WITHDRAWAL')`);
        db.close();
        const res = getNativeUncategorizedSpendingTotal(path, '2026-08-01', '2026-09-01');
        // The live figure, matching the app's own Uncategorized bucket.
        expect(res.total).toBeCloseTo(20.76, 2);
        expect(res.count).toBe(2);
      } finally { cleanup(); }
    });

    it('excludes charges the user dismissed, count and total together', () => {
      // Dismissing says "not spending I need to file". The total still fed the
      // daily digest's pool, so one dismissed charge went on shrinking every
      // category's figure with nothing on screen explaining why.
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type)
                 VALUES ('keep', '-25.00', '2026-08-20', 'WITHDRAWAL')`);
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type)
                 VALUES ('gone', '-106.00', '2026-08-20', 'WITHDRAWAL')`);
        db.close();
        expect(getNativeUncategorizedSpendingTotal(path, '2026-08-01', '2026-09-01'))
          .toEqual({ count: 2, total: 131 });
        const res = getNativeUncategorizedSpendingTotal(path, '2026-08-01', '2026-09-01', ['gone']);
        expect(res).toEqual({ count: 1, total: 25 });
      } finally { cleanup(); }
    });

    it('ignores malformed dismissal ids rather than building broken SQL', () => {
      // The ids arrive from an addon secret, so a junk value must not be able
      // to change the query's meaning — or crash the whole daily report.
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type)
                 VALUES ('keep', '-25.00', '2026-08-20', 'WITHDRAWAL')`);
        db.close();
        const res = getNativeUncategorizedSpendingTotal(
          path, '2026-08-01', '2026-09-01', ["' OR 1=1 --", 'keep'],
        );
        expect(res).toEqual({ count: 0, total: 0 });
      } finally { cleanup(); }
    });

    it('ignores a charge that HAS a category', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-1', 'Groceries', NULL)`);
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type) VALUES ('a1', '-50', '2026-08-02', 'WITHDRAWAL')`);
        db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('a1', 'cat-1')`);
        db.close();
        expect(getNativeUncategorizedSpendingTotal(path, '2026-08-01', '2026-09-01')).toEqual({ count: 0, total: 0 });
      } finally { cleanup(); }
    });

    it('ignores income, which is not spending however unfiled', () => {
      const { path, cleanup } = makeTestDb();
      try {
        const db = new DatabaseSync(path);
        db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type) VALUES ('d1', '2970', '2026-08-06', 'DEPOSIT')`);
        db.close();
        expect(getNativeUncategorizedSpendingTotal(path, '2026-08-01', '2026-09-01').total).toBe(0);
      } finally { cleanup(); }
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

    it('carries the activity type, subtype and account type — the three inputs the bucket predicate needs, and nothing else about the activity', () => {
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
          activityType: 'CREDIT',
          subtype: 'REIMBURSEMENT',
          accountType: 'CASH',
        });
        // The row is a whole `NativeCategorizedTx` and nothing more: the account id
        // and currency were selected for the per-row subtype write this release
        // cut, and no caller has read either since.
        expect(reimb).not.toHaveProperty('accountId');
        expect(reimb).not.toHaveProperty('currency');
      } finally {
        cleanup();
      }
    });

  });
});

describe('in-transit placeholder shapes against the spending classifier', () => {
  // The invariant the 2026-08-27 refund broke, checked against the classifier
  // transcription itself rather than against anyone's belief about it: every
  // placeholder shape, on every account type, in both directions, must
  // classify as ZERO spending. A control row proves the join is live, so a
  // zero cannot be the vacuous kind.
  const cases = [
    { accountType: 'CASH', acct: 'acct-cash', signed: 1300 },
    { accountType: 'CASH', acct: 'acct-cash', signed: -1300 },
    { accountType: 'CREDIT_CARD', acct: 'acct-card', signed: 429.71 },
    { accountType: 'CREDIT_CARD', acct: 'acct-card', signed: -429.71 },
  ];

  it.each(cases)('$accountType $signed classifies as no spending at all', ({ acct, accountType, signed }) => {
    const { path, cleanup } = makeTestDb();
    try {
      const db = new DatabaseSync(path);
      db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-g', 'Groceries', NULL)`);
      // Control: an ordinary charge in the same category on the same account,
      // so the expected total is exactly its amount and never a vacuous zero.
      db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, account_id)
               VALUES ('control', '-50', '2026-08-20', 'WITHDRAWAL', '${acct}')`);
      db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('control', 'cat-g')`);
      const shape = neutralAdjustmentFields(accountType, signed);
      db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, account_id)
               VALUES ('ph', '${shape.amount}', '2026-08-21', '${shape.activityType}', '${acct}')`);
      db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('ph', 'cat-g')`);
      db.close();
      expect(getNativeWealthfolioSpendingBetween(path, '2026-08-01', '2026-09-01')).toEqual({ Groceries: 50 });
    } finally { cleanup(); }
  });

  it('would have caught the refund: a bare CREDIT on a card is NOT neutral', () => {
    // The shape the previous build wrote for a card inflow, kept as the
    // negative case so the table above cannot pass by testing nothing.
    const { path, cleanup } = makeTestDb();
    try {
      const db = new DatabaseSync(path);
      db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-g', 'Groceries', NULL)`);
      db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, account_id)
               VALUES ('bad', '429.71', '2026-08-27', 'CREDIT', 'acct-card')`);
      db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('bad', 'cat-g')`);
      db.close();
      expect(getNativeWealthfolioSpendingBetween(path, '2026-08-01', '2026-09-01')).toEqual({ Groceries: -429.71 });
    } finally { cleanup(); }
  });
});

// Hoisted beside the tests they serve, matching the mid-file import pattern
// used elsewhere in this suite.
import {
  getNativeSpendMatrix, getNativeIncomeByMonthAccount, getNativeUncategorizedByMonthAccount,
} from './sqlite-native.js';

describe('report cube readers, month × account', () => {
  /** Two months across the two fixture accounts, with one row for every
   *  classification trap: a refund (negative spend), a transfer-in (never
   *  income), a card credit (refund, never income), and a dismissed
   *  uncategorized charge. */
  const seedTwoMonths = (path: string) => {
    const db = new DatabaseSync(path);
    db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-din', 'Dining', NULL)`);
    db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-gro', 'Groceries', NULL)`);
    db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, account_id) VALUES ('sp1', '-25.50', '2026-07-09', 'WITHDRAWAL', 'acct-cash')`);
    db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('sp1', 'cat-din')`);
    db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, account_id) VALUES ('sp2', '-40', '2026-08-03', 'WITHDRAWAL', 'acct-card')`);
    db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('sp2', 'cat-gro')`);
    db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, account_id) VALUES ('sp3', '10', '2026-08-10', 'CREDIT', 'acct-card')`);
    db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('sp3', 'cat-din')`);
    db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, account_id) VALUES ('in1', '500', '2026-07-01', 'DEPOSIT', 'acct-cash')`);
    db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, account_id) VALUES ('in2', '1.25', '2026-08-02', 'INTEREST', 'acct-cash')`);
    db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, account_id) VALUES ('tin', '300', '2026-07-05', 'TRANSFER_IN', 'acct-cash')`);
    db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, account_id, notes) VALUES ('un1', '-12', '2026-08-20', 'WITHDRAWAL', 'acct-card', 'MYSTERY · TRN-9')`);
    db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, account_id, notes) VALUES ('uncat-dismissed', '-99', '2026-07-21', 'WITHDRAWAL', 'acct-cash', 'IGNORED · TRN-8')`);
    db.close();
  };

  it('getNativeSpendMatrix groups signed spend by month, parent category, and account', () => {
    const { path, cleanup } = makeTestDb();
    try {
      seedTwoMonths(path);
      const rows = getNativeSpendMatrix(path, '2026-07-01', '2026-09-01');
      expect(rows).toContainEqual({ month: '2026-07', category: 'Dining', accountId: 'acct-cash', amount: 25.5 });
      expect(rows).toContainEqual({ month: '2026-08', category: 'Groceries', accountId: 'acct-card', amount: 40 });
      // The card credit is a refund: NEGATIVE spend, same cell addressing.
      expect(rows).toContainEqual({ month: '2026-08', category: 'Dining', accountId: 'acct-card', amount: -10 });
      // The transfer-in appears nowhere in spending.
      expect(rows.some((r) => r.amount === 300)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('getNativeIncomeByMonthAccount counts cash deposits and interest, never transfers or card credits', () => {
    const { path, cleanup } = makeTestDb();
    try {
      seedTwoMonths(path);
      const rows = getNativeIncomeByMonthAccount(path, '2026-07-01', '2026-09-01');
      expect(rows).toContainEqual({ month: '2026-07', accountId: 'acct-cash', amount: 500 });
      expect(rows).toContainEqual({ month: '2026-08', accountId: 'acct-cash', amount: 1.25 });
      expect(rows.find((r) => r.accountId === 'acct-card')).toBeUndefined();
      expect(rows.some((r) => r.amount === 300)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('getNativeUncategorizedByMonthAccount excludes the given activity ids', () => {
    const { path, cleanup } = makeTestDb();
    try {
      seedTwoMonths(path);
      const rows = getNativeUncategorizedByMonthAccount(path, '2026-07-01', '2026-09-01', ['uncat-dismissed']);
      expect(rows).toEqual([{ month: '2026-08', accountId: 'acct-card', amount: 12 }]);
    } finally {
      cleanup();
    }
  });
});
