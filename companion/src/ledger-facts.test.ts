import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getLedgerFacts } from './ledger-facts.js';

const NOW = new Date(2026, 8, 20, 9, 0, 0); // 2026-09-20, local — the reader buckets by local month
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A ledger shaped like the one these checks were derived from. */
function ledger(rows: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-facts-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT);
    CREATE TABLE activities (id TEXT PRIMARY KEY, account_id TEXT, activity_type TEXT, subtype TEXT,
      activity_date TEXT, amount TEXT, notes TEXT, source_group_id TEXT, needs_review INTEGER DEFAULT 0);
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, name TEXT, parent_id TEXT, taxonomy_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (activity_id TEXT, category_id TEXT);
    CREATE TABLE budget_targets (category_id TEXT, amount TEXT, period_key TEXT, updated_at TEXT);
    INSERT INTO accounts VALUES ('cash','Spend','CASH'),('sav','Savings','CASH'),('card','Citi','CREDIT_CARD'),('card2','Robinhood','CREDIT_CARD');
    INSERT INTO taxonomy_categories VALUES
      ('ent','Entertainment',NULL,'spending_categories'),('mov','Movies & Events','ent','spending_categories'),
      ('food','Food & Dining',NULL,'spending_categories'),
      ('reimb','Reimbursements',NULL,'income_sources'),('pay','Salary',NULL,'income_sources');
    INSERT INTO budget_targets VALUES ('ent','100','default','2026-01-01'),('food','200','default','2026-01-01');
    ${rows}
  `);
  db.close();
  return path;
}
const facts = (rows: string, bank: Array<[string, number | null]> = []) => getLedgerFacts(ledger(rows), NOW, new Map(bank))!;

describe('getLedgerFacts', () => {
  it('is null, not an exception, when the database is not there', () => {
    expect(getLedgerFacts('/nope/missing.db', NOW, new Map())).toBeNull();
  });

  it('reports a card\'s POSTED ledger beside the bank figure, and marks one with a transfer in flight', () => {
    const f = facts(`
      INSERT INTO activities VALUES ('a','card','WITHDRAWAL',NULL,'2026-09-01','100','Coffee · t1',NULL,0);
      INSERT INTO activities VALUES ('b','card','TRANSFER_IN',NULL,'2026-09-02','40','Payment · t2','grp',0);
      INSERT INTO activities VALUES ('c','card','WITHDRAWAL',NULL,'2026-09-19','25','Not yet · t3 · pending',NULL,0);
      INSERT INTO activities VALUES ('d','card2','WITHDRAWAL',NULL,'2026-09-01','3','Parking · t4',NULL,0);
      INSERT INTO activities VALUES ('e','card2','TRANSFER_IN',NULL,'2026-09-18','391.33','↔️ In-transit transfer · Payment · t5',NULL,0);
    `, [['card', -84.79], ['card2', -3]]);
    const citi = f.cardBalances.find((c) => c.name === 'Citi')!;
    // −100 + 40; the pending $25 is excluded because the bank's figure is posted-only.
    expect(citi).toEqual({ name: 'Citi', ledger: -60, bank: -84.79, inFlight: false });
    expect(f.cardBalances.find((c) => c.name === 'Robinhood')!.inFlight).toBe(true);
    // Cash accounts are not here at all: they already have drift episodes.
    expect(f.cardBalances.map((c) => c.name).sort()).toEqual(['Citi', 'Robinhood']);
  });

  it('finds the refund that reduces nothing, and leaves a filed one alone', () => {
    const f = facts(`
      INSERT INTO activities VALUES ('r1','card','CREDIT',NULL,'2026-09-11','22.91','Thankyou Points Redeemed · t1',NULL,0);
      INSERT INTO activity_taxonomy_assignments VALUES ('r1','reimb');
      INSERT INTO activities VALUES ('r2','cash','CREDIT','REIMBURSEMENT','2026-09-08','50','Transfer from Venmo · t2',NULL,0);
      INSERT INTO activity_taxonomy_assignments VALUES ('r2','food'),('r2','reimb');
      INSERT INTO activities VALUES ('r3','cash','CREDIT',NULL,'2026-09-09','600','CAPITAL ONE TRANSFER · t3','grp',0);
    `);
    // r1 has a category, but an INCOME one — exactly the live case. r2 is filed
    // under spending. r3 is a bare cash credit: neutral by design, not a refund.
    expect(f.idleRefunds).toEqual([{ id: 'r1', description: 'Thankyou Points Redeemed', amount: 22.91 }]);
  });

  it('finds a cash deposit filed as reimbursement INCOME, but not ordinary pay', () => {
    const f = facts(`
      INSERT INTO activities VALUES ('d1','cash','DEPOSIT',NULL,'2026-09-11','137','Atm Deposit XX0863 · t1',NULL,0);
      INSERT INTO activity_taxonomy_assignments VALUES ('d1','reimb');
      INSERT INTO activities VALUES ('d2','cash','DEPOSIT',NULL,'2026-09-02','2000','Payroll · t2',NULL,0);
      INSERT INTO activity_taxonomy_assignments VALUES ('d2','pay');
    `);
    expect(f.incomeReimbursements).toEqual([{ id: 'd1', description: 'Atm Deposit XX0863', amount: 137, category: 'Reimbursements' }]);
  });

  it('finds unlinked cash transfers, skipping linked ones, the sync\'s own rows, cards, and old history', () => {
    const f = facts(`
      INSERT INTO activities VALUES ('u1','cash','TRANSFER_IN',NULL,'2026-09-10','1300','Transfer from Capital One · t1',NULL,0);
      INSERT INTO activities VALUES ('u2','cash','TRANSFER_OUT',NULL,'2026-09-10','500','Payment to Citi · t2','grp',0);
      INSERT INTO activities VALUES ('u3','sav','TRANSFER_OUT',NULL,'2026-09-18','600','↔️ In-transit transfer · PNC BANK · t3',NULL,0);
      INSERT INTO activities VALUES ('u4','card','TRANSFER_IN',NULL,'2026-04-20','235.4','Starting balance · sf-card',NULL,0);
      INSERT INTO activities VALUES ('u5','cash','TRANSFER_OUT',NULL,'2026-06-26','700','Payment to Citibank · t5',NULL,0);
    `);
    // u5 is the hand-repaired June leg: real, known, and not to be re-litigated daily.
    expect(f.unlinkedTransfers).toEqual([{ id: 'u1', description: 'Transfer from Capital One', amount: 1300, direction: 'in', ageDays: 10 }]);
    expect(f.heldTransfers).toEqual([{ id: 'u3', description: 'PNC BANK', amount: 600, ageDays: 2 }]);
  });

  it('finds a DEPOSIT inside a transfer group, and accepts a bare CREDIT there', () => {
    const f = facts(`
      INSERT INTO activities VALUES ('g1','cash','DEPOSIT',NULL,'2026-09-05','1300','CAPITAL ONE TRANSFER · t1','grp1',0);
      INSERT INTO activities VALUES ('g2','cash','CREDIT',NULL,'2026-09-06','600','CAPITAL ONE TRANSFER · t2','grp2',0);
    `);
    expect(f.groupedNonTransfers).toEqual([{ id: 'g1', description: 'CAPITAL ONE TRANSFER', amount: 1300, type: 'DEPOSIT' }]);
  });

  it('nets reimbursements into the month and names the largest single purchase', () => {
    const f = facts(`
      INSERT INTO activities VALUES ('p1','card','WITHDRAWAL',NULL,'2026-09-18','420.52','StubHub · t1 · pending',NULL,0);
      INSERT INTO activities VALUES ('p2','card','WITHDRAWAL',NULL,'2026-09-11','153.07','Kalshi · t2',NULL,0);
      INSERT INTO activity_taxonomy_assignments VALUES ('p1','mov'),('p2','ent');
      INSERT INTO activities VALUES ('p3','card','WITHDRAWAL',NULL,'2026-09-06','135.26','Cipollini · t3',NULL,0);
      INSERT INTO activities VALUES ('p4','cash','CREDIT','REIMBURSEMENT','2026-09-08','50','Transfer from Venmo · t4',NULL,0);
      INSERT INTO activity_taxonomy_assignments VALUES ('p3','food'),('p4','food');
    `);
    const ent = f.categories.find((c) => c.name === 'Entertainment')!;
    // The subcategory rolls up to its parent, which is what carries the budget.
    expect(ent).toEqual({ name: 'Entertainment', budget: 100, spent: 573.59, largest: { id: 'p1', description: 'StubHub', amount: 420.52 } });
    expect(f.categories.find((c) => c.name === 'Food & Dining')!.spent).toBe(85.26);
  });

  it('calls a category chronic only when it was over in EVERY one of the last three full months', () => {
    const f = facts(`
      INSERT INTO activities VALUES ('j','card','WITHDRAWAL',NULL,'2026-06-10','340','June · t1',NULL,0);
      INSERT INTO activities VALUES ('k','card','WITHDRAWAL',NULL,'2026-07-10','300','July · t2',NULL,0);
      INSERT INTO activities VALUES ('l','card','WITHDRAWAL',NULL,'2026-08-10','380','August · t3',NULL,0);
      INSERT INTO activity_taxonomy_assignments VALUES ('j','food'),('k','food'),('l','food');
      INSERT INTO activities VALUES ('m','card','WITHDRAWAL',NULL,'2026-06-10','500','June ent · t4',NULL,0);
      INSERT INTO activities VALUES ('n','card','WITHDRAWAL',NULL,'2026-08-10','500','Aug ent · t5',NULL,0);
      INSERT INTO activity_taxonomy_assignments VALUES ('m','ent'),('n','ent');
    `);
    // Entertainment had a good July, so it is two bad months, not a wrong budget.
    expect(f.chronicallyOver).toEqual([{ name: 'Food & Dining', months: 3, averageOver: 140 }]);
  });

  it('finds a transfer whose other half is missing: the one account off from its bank by exactly that amount', () => {
    // Spend's placeholder left $3,000; Savings reads exactly $3,000 below its
    // bank. Spend itself agrees with its bank, so it is not the suspect.
    const f = facts(`
      INSERT INTO activities VALUES ('s0','cash','CREDIT',NULL,'2026-04-01','5000','Starting balance · sf1',NULL,0);
      INSERT INTO activities VALUES ('ph','cash','TRANSFER_OUT',NULL,'2026-08-10','3000','↔️ In-transit transfer · Transfer to Capital One · t9',NULL,0);
      INSERT INTO activities VALUES ('v0','sav','CREDIT',NULL,'2026-04-01','12919.24','Starting balance · sf2',NULL,0);
    `, [['cash', 2000], ['sav', 15919.24]]);
    expect(f.missingLegs).toEqual([{
      id: 'ph', description: 'Transfer to Capital One', amount: 3000, date: '2026-08-10',
      fromAccount: 'Spend', toAccount: 'Savings',
    }]);
  });

  it('names no missing leg when two accounts could explain it, or none', () => {
    const ambiguous = facts(`
      INSERT INTO activities VALUES ('ph','cash','TRANSFER_OUT',NULL,'2026-08-10','50','↔️ In-transit transfer · Move · t9',NULL,0);
    `, [['cash', -50], ['sav', 50], ['card', 50]]);
    expect(ambiguous.missingLegs).toEqual([]);
    const none = facts(`
      INSERT INTO activities VALUES ('ph','cash','TRANSFER_OUT',NULL,'2026-08-10','50','↔️ In-transit transfer · Move · t9',NULL,0);
    `, [['cash', -50], ['sav', 0]]);
    expect(none.missingLegs).toEqual([]);
  });

  it('leaves a young leg alone: the other bank is usually just ahead of its feed', () => {
    const f = facts(`
      INSERT INTO activities VALUES ('ph','cash','TRANSFER_OUT',NULL,'2026-09-18','391.33','↔️ In-transit transfer · Payment · t9',NULL,0);
    `, [['cash', -391.33], ['card', 391.33]]);
    expect(f.missingLegs).toEqual([]);
  });

  it('names a broad Amazon rule only while order emails are set up to label Amazon charges', () => {
    const rows = `
      CREATE TABLE spending_categorization_rules (name TEXT, pattern TEXT, match_type TEXT);
      INSERT INTO spending_categorization_rules VALUES ('Amazon → Online Shopping','Amazon','CONTAINS'),('Kindle','Kindle Svcs','CONTAINS');
    `;
    const on = getLedgerFacts(ledger(rows), NOW, new Map(), { amazonMailEnabled: true })!;
    expect(on.broadAmazonRules).toEqual(['Amazon → Online Shopping']);
    const off = getLedgerFacts(ledger(rows), NOW, new Map())!;
    expect(off.broadAmazonRules).toEqual([]);
  });

  it('finds a card whose opening balance says it started in credit', () => {
    const f = facts(`
      INSERT INTO activities VALUES ('o1','card','TRANSFER_IN',NULL,'2026-04-20','235.4','Starting balance · sfc',NULL,0);
      INSERT INTO activities VALUES ('o2','card2','WITHDRAWAL',NULL,'2026-04-20','464.6','Starting balance · sfd',NULL,0);
    `);
    expect(f.cardsOpenedInCredit).toEqual([{ name: 'Citi', amount: 235.4, date: '2026-04-20' }]);
  });

  it('counts rows Wealthfolio flagged, and survives a schema without the column', () => {
    expect(facts(`INSERT INTO activities VALUES ('x','cash','WITHDRAWAL',NULL,'2026-09-01','5','X · t',NULL,1);`).needsReview).toBe(1);
  });
});
