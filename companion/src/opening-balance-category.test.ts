import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileCardOpeningDebts, OPENING_BALANCES_CATEGORY } from './opening-balance-category.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

function ledger(rows: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-open-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT);
    CREATE TABLE activities (id TEXT PRIMARY KEY, account_id TEXT, activity_type TEXT, activity_date TEXT, amount TEXT, notes TEXT);
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, name TEXT, parent_id TEXT, taxonomy_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (activity_id TEXT, category_id TEXT);
    CREATE TABLE app_settings (setting_key TEXT, setting_value TEXT);
    INSERT INTO accounts VALUES ('card','Citi','CREDIT_CARD'),('cash','Spend','CASH');
    ${rows}
  `);
  db.close();
  return path;
}
const deps = (dbPath: string) => ({
  dbPath,
  createCategory: vi.fn(async () => 'new-cat'),
  setExcluded: vi.fn(async () => {}),
  assign: vi.fn(async () => {}),
  log: vi.fn(),
});

describe('fileCardOpeningDebts', () => {
  // Wealthfolio 3.8 has no spending-neutral money-out type on a card, so a
  // card's opening DEBT is a WITHDRAWAL, which its Spending page counts as a
  // purchase on the opening date. Filed under a category excluded from
  // spending, it counts nowhere.
  it('creates and excludes the category, then files an uncategorised card opening debt', async () => {
    const d = deps(ledger(`
      INSERT INTO activities VALUES ('o','card','WITHDRAWAL','2026-04-20','464.6','Starting balance · sfc');
      INSERT INTO app_settings VALUES ('spending.excluded_category_ids','["x1"]');
    `));
    const res = await fileCardOpeningDebts(d);
    expect(d.createCategory).toHaveBeenCalledWith(OPENING_BALANCES_CATEGORY);
    expect(d.setExcluded).toHaveBeenCalledWith(['x1', 'new-cat']);
    expect(d.assign).toHaveBeenCalledWith('o', 'new-cat');
    expect(res).toEqual({ filed: 1 });
  });

  it('reuses an existing category and exclusion, and skips rows already filed', async () => {
    const d = deps(ledger(`
      INSERT INTO taxonomy_categories VALUES ('ob','Opening balances',NULL,'spending_categories');
      INSERT INTO app_settings VALUES ('spending.excluded_category_ids','["ob"]');
      INSERT INTO activities VALUES ('o','card','WITHDRAWAL','2026-04-20','464.6','Starting balance · sfc');
      INSERT INTO activities VALUES ('p','card','WITHDRAWAL','2026-05-20','10','Starting balance · sfd');
      INSERT INTO activity_taxonomy_assignments VALUES ('p','ob');
    `));
    const res = await fileCardOpeningDebts(d);
    expect(d.createCategory).not.toHaveBeenCalled();
    expect(d.setExcluded).not.toHaveBeenCalled();
    expect(d.assign).toHaveBeenCalledTimes(1);
    expect(d.assign).toHaveBeenCalledWith('o', 'ob');
    expect(res).toEqual({ filed: 1 });
  });

  it('does nothing — no category, no setting — when there is no card opening debt', async () => {
    // A cash opening balance is a neutral CREDIT, a card opening credit a
    // neutral TRANSFER_IN, and a user's own purchase is theirs to file.
    const d = deps(ledger(`
      INSERT INTO activities VALUES ('a','cash','CREDIT','2026-04-20','500','Starting balance · sfa');
      INSERT INTO activities VALUES ('b','card','TRANSFER_IN','2026-04-20','20','Starting balance · sfb');
      INSERT INTO activities VALUES ('c','card','WITHDRAWAL','2026-04-21','20','Coffee · t1');
    `));
    expect(await fileCardOpeningDebts(d)).toEqual({ filed: 0 });
    expect(d.createCategory).not.toHaveBeenCalled();
    expect(d.setExcluded).not.toHaveBeenCalled();
    expect(d.assign).not.toHaveBeenCalled();
  });

  it('leaves a card opening debt the user already filed elsewhere alone', async () => {
    const d = deps(ledger(`
      INSERT INTO taxonomy_categories VALUES ('mine','Credit history',NULL,'spending_categories');
      INSERT INTO activities VALUES ('o','card','WITHDRAWAL','2026-04-20','464.6','Starting balance · sfc');
      INSERT INTO activity_taxonomy_assignments VALUES ('o','mine');
    `));
    expect(await fileCardOpeningDebts(d)).toEqual({ filed: 0 });
    expect(d.assign).not.toHaveBeenCalled();
  });
});

describe('fileCardOpeningDebts — change log', () => {
  it('records the set-up as bookkeeping and each filing with its account and debt', async () => {
    const drafts: any[] = [];
    const d = { ...deps(ledger(`
      INSERT INTO activities VALUES ('o','card','WITHDRAWAL','2026-04-20T00:00:00Z','464.6','Starting balance · sfc');
    `)), record: (x: any) => drafts.push(x) };
    await fileCardOpeningDebts(d);
    expect(drafts.map((x) => [x.kind, x.summary])).toEqual([
      ['bookkeeping', 'Set up the "Opening balances" category and kept it out of spending'],
      ['opening-balance-filed', "Filed Citi's opening balance under Opening balances"],
    ]);
    expect(drafts[1]).toMatchObject({
      account: { sfinId: 'sfc', wfId: 'card', name: 'Citi' },
      subject: { activityIds: ['o'], amountCents: -46460, date: '2026-04-20', categoryName: 'Opening balances' },
      before: { categoryId: null, categoryName: null },
      after: { categoryId: 'new-cat', categoryName: 'Opening balances', taxonomyId: 'spending_categories' },
    });
  });

  it('records no set-up when the category and exclusion already exist', async () => {
    const drafts: any[] = [];
    const d = { ...deps(ledger(`
      INSERT INTO taxonomy_categories VALUES ('ob','Opening balances',NULL,'spending_categories');
      INSERT INTO app_settings VALUES ('spending.excluded_category_ids','["ob"]');
      INSERT INTO activities VALUES ('o','card','WITHDRAWAL','2026-04-20','464.6','Starting balance · sfc');
    `)), record: (x: any) => drafts.push(x) };
    await fileCardOpeningDebts(d);
    expect(drafts.map((x) => x.kind)).toEqual(['opening-balance-filed']);
    expect(drafts[0].account.sfinId).toBe('sfc');
  });

  it('a recorder that throws never costs the filing', async () => {
    const d = { ...deps(ledger(`
      INSERT INTO activities VALUES ('o','card','WITHDRAWAL','2026-04-20','464.6','Starting balance · sfc');
      INSERT INTO activities VALUES ('p','card','WITHDRAWAL','2026-04-21','10','Starting balance · sfd');
    `)), record: () => { throw new Error('boom'); } };
    await expect(fileCardOpeningDebts(d)).resolves.toEqual({ filed: 2 });
    expect(d.assign).toHaveBeenCalledTimes(2);
  });
});
