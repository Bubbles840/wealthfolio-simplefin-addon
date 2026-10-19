import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect } from 'vitest';
import { getNativeAccountBalances } from './sqlite-native.js';
import { typeCashSign } from '../../shared/audit-ledger.js';
import { postedLedgerTotal } from '../../shared/ledger-total.js';

/**
 * 1.64 (B1, R14): the app totals a card from `activities.search` with the
 * TypeScript sign table; the companion totals it in SQL. Both must agree on
 * the same rows, overrides included — on every type, account type and
 * direction — or the badge would say "in sync" from one side and "off by $X"
 * from the other.
 */
const TYPES = ['DEPOSIT', 'CREDIT', 'TRANSFER_IN', 'DIVIDEND', 'INTEREST', 'SELL',
  'WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX', 'BUY', 'SPLIT', 'ADJUSTMENT', 'UNKNOWN'];
const ACCOUNT_TYPES = ['CASH', 'CREDIT_CARD', 'SECURITIES'];

function ledgerDb(): { path: string; db: DatabaseSync; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-sign-'));
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT);
    CREATE TABLE activities (id TEXT PRIMARY KEY, account_id TEXT, activity_type TEXT, activity_type_override TEXT,
      amount TEXT, activity_date TEXT, notes TEXT);
  `);
  return { path, db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe('the TypeScript sign table and the SQL one agree (R14)', () => {
  it('on every type × account type, stored raw', () => {
    const { path, db, cleanup } = ledgerDb();
    try {
      for (const acct of ACCOUNT_TYPES) {
        for (const type of TYPES) {
          const id = `${acct}-${type}`;
          db.prepare('INSERT INTO accounts VALUES (?, ?, ?)').run(id, id, acct);
          db.prepare("INSERT INTO activities VALUES (?, ?, ?, NULL, '10', '2026-10-01', 'ROW · t1')").run(`a-${id}`, id, type);
        }
      }
      const sql = getNativeAccountBalances(path);
      for (const acct of ACCOUNT_TYPES) {
        for (const type of TYPES) expect([acct, type, sql.get(`${acct}-${type}`)]).toEqual([acct, type, typeCashSign(type, acct) * 10]);
      }
    } finally { cleanup(); }
  });

  it('on every override over a row of the opposite direction', () => {
    const { path, db, cleanup } = ledgerDb();
    try {
      for (const acct of ACCOUNT_TYPES) {
        for (const type of TYPES) {
          const id = `${acct}-${type}`;
          const raw = typeCashSign(type, acct) > 0 ? 'WITHDRAWAL' : 'DEPOSIT';
          db.prepare('INSERT INTO accounts VALUES (?, ?, ?)').run(id, id, acct);
          db.prepare("INSERT INTO activities VALUES (?, ?, ?, ?, '10', '2026-10-01', 'ROW · t1')").run(`a-${id}`, id, raw, type);
        }
      }
      const sql = getNativeAccountBalances(path);
      for (const acct of ACCOUNT_TYPES) {
        for (const type of TYPES) expect([acct, type, sql.get(`${acct}-${type}`)]).toEqual([acct, type, typeCashSign(type, acct) * 10]);
      }
    } finally { cleanup(); }
  });

  it('so the app total equals the companion total on the same card, overrides and pending rows included', () => {
    const { path, db, cleanup } = ledgerDb();
    try {
      db.exec(`
        INSERT INTO accounts VALUES ('wf-citi', 'Citi Double Cash® Card', 'CREDIT_CARD');
        INSERT INTO activities VALUES
          ('c1', 'wf-citi', 'WITHDRAWAL', NULL, '61.20', '2026-10-01', 'GROCERY · t1'),
          ('c2', 'wf-citi', 'WITHDRAWAL', 'TRANSFER_IN', '42.40', '2026-10-02', 'AUTOPAY · t2'),
          ('c3', 'wf-citi', 'DEPOSIT', 'WITHDRAWAL', '9.99', '2026-10-03', 'STREAMING · t3'),
          ('c4', 'wf-citi', 'INTEREST', NULL, '1.25', '2026-10-04', 'INTEREST · t4'),
          ('c5', 'wf-citi', 'WITHDRAWAL', NULL, '15.00', '2026-10-05', 'PENDING CHARGE · t5 · pending');
      `);
      // What `activities.search` hands the app: COALESCE(override, type).
      const searched = [
        { activityType: 'WITHDRAWAL', amount: '61.20', comment: 'GROCERY · t1' },
        { activityType: 'TRANSFER_IN', amount: '42.40', comment: 'AUTOPAY · t2' },
        { activityType: 'WITHDRAWAL', amount: '9.99', comment: 'STREAMING · t3' },
        { activityType: 'INTEREST', amount: '1.25', comment: 'INTEREST · t4' },
        { activityType: 'WITHDRAWAL', amount: '15.00', comment: 'PENDING CHARGE · t5 · pending' },
      ];
      const app = postedLedgerTotal(searched, 'CREDIT_CARD');
      expect(app).toBe(-30.04);
      expect(getNativeAccountBalances(path).get('wf-citi')).toBeCloseTo(app!, 2);
    } finally { cleanup(); }
  });
});
