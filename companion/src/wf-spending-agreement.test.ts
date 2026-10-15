/**
 * The report and Wealthfolio's Spending page agree (1.62, ruling W4), checked
 * through the real readers on a real database: for each rule 1.61's audit
 * named a reason for, the digest's month total (categories + uncategorized)
 * and the cube's (matrix + uncategorized cells) equal the figure Wealthfolio's
 * own rules give — worked out by hand from upstream crates/spending — and the
 * audit names no reason.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { explainHeadline } from '../../shared/audit-headline.js';
import {
  getNativeSpendingSettings, getNativeSpendMatrix, getNativeUncategorizedByMonthAccount, getNativeUncategorizedSpendingTotal,
  getNativeWealthfolioSpending, readSpendLines,
} from './sqlite-native.js';
import { getNativeHeadlineRows } from './sqlite-audit.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Wealthfolio's real tables, New York time, two spending accounts and savings. */
function database(rows: string, settings = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-agree-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT, is_archived INTEGER DEFAULT 0);
    CREATE TABLE activities (id TEXT PRIMARY KEY, account_id TEXT, activity_type TEXT, activity_type_override TEXT, subtype TEXT,
      activity_date TEXT, amount TEXT, notes TEXT, source_group_id TEXT);
    CREATE TABLE taxonomy_categories (id TEXT, taxonomy_id TEXT, name TEXT, parent_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (id TEXT, activity_id TEXT, taxonomy_id TEXT, category_id TEXT, source TEXT, created_at TEXT);
    CREATE TABLE spending_activity_splits (id TEXT, activity_id TEXT, taxonomy_id TEXT, category_id TEXT, amount TEXT, sort_order INTEGER);
    CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT);
    INSERT INTO accounts VALUES ('chk', 'PNC Checking', 'CASH', 0), ('visa', 'Visa', 'CREDIT_CARD', 0), ('sav', 'Ally Savings', 'CASH', 0);
    INSERT INTO app_settings VALUES ('timezone', 'America/New_York'), ('spending.enabled', 'true'), ('spending.account_ids', '["chk","visa"]');
    INSERT INTO taxonomy_categories VALUES
      ('food', 'spending_categories', 'Food & Dining', NULL), ('rest', 'spending_categories', 'Restaurants', 'food'),
      ('edu', 'spending_categories', 'Education', NULL), ('tuition', 'spending_categories', 'Tuition', 'edu'),
      ('home', 'spending_categories', 'Home', NULL), ('sync', 'spending_categories', 'Sync bookkeeping', NULL);
    ${settings}
    ${rows}
    -- Added after the rows so each keeps its short positional form above.
    ALTER TABLE activities ADD COLUMN currency TEXT;
    INSERT INTO app_settings VALUES ('base_currency', 'USD');
  `);
  db.close();
  return path;
}

/** The digest's "spent this month" and the cube's, in cents. */
function reportCents(path: string): { digest: number; cube: number } {
  const categories = Object.values(getNativeWealthfolioSpending(path, '2026-10')).reduce((s, v) => s + v, 0);
  const digest = Math.round((categories + getNativeUncategorizedSpendingTotal(path, '2026-10-01', '2026-11-01').total) * 100);
  const matrix = getNativeSpendMatrix(path, '2026-10-01', '2026-11-01').filter((r) => r.month === '2026-10').reduce((s, r) => s + r.amount, 0);
  const uncat = getNativeUncategorizedByMonthAccount(path, '2026-10-01', '2026-11-01').filter((r) => r.month === '2026-10').reduce((s, r) => s + r.amount, 0);
  return { digest, cube: Math.round((matrix + uncat) * 100) };
}

const filed = (activity: string, category: string, at = '2026-10-05T00:00:00Z', id = `${activity}-${category}`) =>
  `INSERT INTO activity_taxonomy_assignments VALUES ('${id}', '${activity}', 'spending_categories', '${category}', 'manual', '${at}');`;

describe('the report counts each case exactly as Wealthfolio does', () => {
  it.each<[string, string, string, number]>([
    ['an excluded category and its descendant', `
      INSERT INTO activities VALUES ('a1', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-10-05T12:00:00+00:00', '15', 'TUITION · TRN-1', NULL);
      ${filed('a1', 'tuition')}
      INSERT INTO activities VALUES ('a2', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-10-06T12:00:00+00:00', '100', 'KROGER · TRN-2', NULL);
      ${filed('a2', 'food')}`, `INSERT INTO app_settings VALUES ('spending.excluded_category_ids', '["edu"]');`, 10000],
    ['a row filed under two categories counts once', `
      INSERT INTO activities VALUES ('a1', 'visa', 'WITHDRAWAL', NULL, NULL, '2026-10-05T12:00:00+00:00', '12', 'SPLIT RENT · TRN-1', NULL);
      ${filed('a1', 'home', '2026-10-06T00:00:00Z')}
      ${filed('a1', 'rest', '2026-10-05T00:00:00Z')}`, '', 1200],
    ['an uncategorized refund is netted', `
      INSERT INTO activities VALUES ('a1', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-10-05T12:00:00+00:00', '50', 'TARGET · TRN-1', NULL);
      ${filed('a1', 'home')}
      INSERT INTO activities VALUES ('a2', 'chk', 'CREDIT', NULL, 'REFUND', '2026-10-06T12:00:00+00:00', '8', 'RETURN · TRN-2', NULL);
      INSERT INTO activities VALUES ('a3', 'visa', 'CREDIT', NULL, NULL, '2026-10-07T12:00:00+00:00', '3', 'STATEMENT CREDIT · TRN-3', NULL);`, '', 3900],
    ['a row stored at 00:00 UTC on the 1st is September’s in New York', `
      INSERT INTO activities VALUES ('a1', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-10-01T00:00:00+00:00', '25', 'RENT PORTAL · TRN-1', NULL);
      ${filed('a1', 'home')}
      INSERT INTO activities VALUES ('a2', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-10-01T12:00:00+00:00', '10', 'COFFEE · TRN-2', NULL);
      INSERT INTO activities VALUES ('a3', 'visa', 'WITHDRAWAL', NULL, NULL, '2026-11-01T02:00:00+00:00', '40', 'HALLOWEEN · TRN-3', NULL);
      ${filed('a3', 'rest')}`, '', 5000],
    ['a linked transfer out to savings is a saving, not spending', `
      INSERT INTO activities VALUES ('a1', 'chk', 'TRANSFER_OUT', NULL, NULL, '2026-10-05T12:00:00+00:00', '500', 'TO ALLY · TRN-1', 'g-sav');
      INSERT INTO activities VALUES ('a2', 'sav', 'TRANSFER_IN', NULL, NULL, '2026-10-05T12:00:00+00:00', '500', 'FROM PNC · TRN-2', 'g-sav');
      ${filed('a1', 'home')}
      INSERT INTO activities VALUES ('a3', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-10-06T12:00:00+00:00', '20', 'LUNCH · TRN-3', NULL);
      ${filed('a3', 'rest')}`, '', 2000],
    ['an activity type override is the type that counts', `
      INSERT INTO activities VALUES ('a1', 'chk', 'DEPOSIT', 'WITHDRAWAL', NULL, '2026-10-05T12:00:00+00:00', '30', 'MISTYPED · TRN-1', NULL);
      INSERT INTO activities VALUES ('a2', 'chk', 'WITHDRAWAL', 'DEPOSIT', NULL, '2026-10-06T12:00:00+00:00', '70', 'REFUNDED · TRN-2', NULL);
      ${filed('a2', 'home')}`, '', 3000],
    ['the sync’s bookkeeping rows filed under its excluded category (3.9+)', `
      INSERT INTO activities VALUES ('a1', 'chk', 'TRANSFER_OUT', NULL, NULL, '2026-10-05T12:00:00+00:00', '1000', '↔️ In-transit transfer · ZELLE · TRN-1', NULL);
      ${filed('a1', 'sync')}
      INSERT INTO activities VALUES ('a2', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-10-06T12:00:00+00:00', '20', 'LUNCH · TRN-2', NULL);`,
      `INSERT INTO app_settings VALUES ('spending.excluded_category_ids', '["sync"]');`, 2000],
    ['the sync’s bookkeeping rows on 3.8, which excludes nothing', `
      INSERT INTO activities VALUES ('a1', 'chk', 'TRANSFER_OUT', NULL, NULL, '2026-10-05T12:00:00+00:00', '6', 'Balance adjustment · sfin-chk · 2026-10-05', NULL);
      INSERT INTO activities VALUES ('a2', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-10-06T12:00:00+00:00', '20', 'LUNCH · TRN-2', NULL);`, '', 2600],
  ])('%s', (_name, rows, settings, wealthfolio) => {
    const path = database(rows, settings);
    const report = reportCents(path);
    expect(report).toEqual({ digest: wealthfolio, cube: wealthfolio });
    const s = getNativeSpendingSettings(path);
    const h = explainHeadline({
      month: '2026-10', timezone: s.timezone, spendingAccountIds: s.spendingAccountIds, reportAccountIds: ['chk', 'visa'],
      excludedCategoryIds: s.excludedCategoryIds, categoryParents: s.categoryParents,
      reportCents: report.cube, wealthfolioCents: wealthfolio, rows: getNativeHeadlineRows(path, '2026-10-01', '2026-11-01'),
    });
    expect(h.reasons).toEqual([]);
    expect(h.unexplainedCents).toBe(0);
  });
});

describe('readSpendLines and the settings behind it', () => {
  it('names every spending category and reads the Spending page’s accounts, archived ones out', () => {
    const path = database(`UPDATE accounts SET is_archived = 1 WHERE id = 'visa';`);
    expect(getNativeSpendingSettings(path)).toMatchObject({
      timezone: 'America/New_York', spendingOn: true, spendingAccountIds: ['chk'],
      categoryNames: { food: 'Food & Dining', rest: 'Restaurants' }, categoryParents: { rest: 'food', food: null },
    });
  });

  it('places rows on Wealthfolio’s local days, reading a day wider on each side', () => {
    const path = database(`
      INSERT INTO activities VALUES ('sept', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-10-01T03:59:59+00:00', '1', 'A · TRN-1', NULL);
      INSERT INTO activities VALUES ('first', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-10-01T04:00:00+00:00', '2', 'B · TRN-2', NULL);
      INSERT INTO activities VALUES ('last', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-11-01T03:59:59+00:00', '4', 'C · TRN-3', NULL);
      INSERT INTO activities VALUES ('nov', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-11-01T04:00:00+00:00', '8', 'D · TRN-4', NULL);`);
    const { lines } = readSpendLines(path, '2026-10-01', '2026-11-01');
    expect(lines.map((l) => [l.row.id, l.day])).toEqual([['first', '2026-10-01'], ['last', '2026-10-31']]);
  });

  it('counts nothing while Wealthfolio’s Spending page is off, as Wealthfolio counts nothing', () => {
    const path = database(`
      UPDATE app_settings SET setting_value = 'false' WHERE setting_key = 'spending.enabled';
      INSERT INTO activities VALUES ('a1', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-10-05T12:00:00+00:00', '20', 'LUNCH · TRN-1', NULL);`);
    expect(readSpendLines(path, '2026-10-01', '2026-11-01').lines).toEqual([]);
    expect(reportCents(path)).toEqual({ digest: 0, cube: 0 });
  });
});

describe('rows in another currency (1.62, ruling LU-B), through the real readers', () => {
  it('reads each row’s currency and the base currency, and the audit names the foreign rows', () => {
    const path = database(`
      INSERT INTO activities VALUES ('a1', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-10-05T12:00:00+00:00', '100', 'KROGER · TRN-1', NULL);
      INSERT INTO activities VALUES ('a2', 'visa', 'WITHDRAWAL', NULL, NULL, '2026-10-06T12:00:00+00:00', '20', 'BOULANGERIE · TRN-2', NULL);`);
    const db = new DatabaseSync(path);
    db.exec(`UPDATE activities SET currency = 'usd' WHERE id = 'a1'; UPDATE activities SET currency = 'eur' WHERE id = 'a2';`);
    db.close();
    const s = getNativeSpendingSettings(path);
    expect(s.baseCurrency).toBe('USD');
    const rows = getNativeHeadlineRows(path, '2026-10-01', '2026-11-01');
    expect(rows.map((r) => [r.id, r.currency])).toEqual([['a1', 'USD'], ['a2', 'EUR']]);
    // Wealthfolio converted the 20 EUR to 22.50 USD; the report summed it as stored.
    const h = explainHeadline({
      month: '2026-10', timezone: s.timezone, baseCurrency: s.baseCurrency, spendingAccountIds: s.spendingAccountIds, reportAccountIds: ['chk', 'visa'],
      excludedCategoryIds: s.excludedCategoryIds, categoryParents: s.categoryParents, reportCents: 12000, wealthfolioCents: 12250, rows,
    });
    expect(h.reasons).toEqual([{ kind: 'foreign-currency', cents: -250, rows: [{ date: '2026-10-06', description: 'BOULANGERIE', cents: 2000, account: 'Visa' }] }]);
    expect(h.unexplainedCents).toBe(0);
  });
});
