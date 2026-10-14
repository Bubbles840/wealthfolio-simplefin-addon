import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  auditAccountFromCliParts, auditRowFromCliParts, getNativeAuditLedger, getNativeAuditSettings, getNativeHeadlineRows,
  headlineRowFromCliParts, PHANTOM_CASH_ASSET_ID,
} from './sqlite-audit.js';
import { NativeDbUnreadableError } from './sqlite-native.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real tables and column names, only the columns these readers touch. */
function ledger(settings = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-audit-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT, is_archived BOOLEAN NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT 1);
    CREATE TABLE activities (id TEXT PRIMARY KEY, account_id TEXT, activity_type TEXT, activity_type_override TEXT, subtype TEXT,
      status TEXT, activity_date TEXT, amount TEXT, currency TEXT, asset_id TEXT, metadata TEXT, notes TEXT, source_group_id TEXT, quantity TEXT);
    CREATE TABLE assets (id TEXT PRIMARY KEY, display_code TEXT, instrument_symbol TEXT, name TEXT);
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, taxonomy_id TEXT, name TEXT, parent_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (id TEXT, activity_id TEXT, taxonomy_id TEXT, category_id TEXT, weight INTEGER, source TEXT, created_at TEXT);
    INSERT INTO accounts VALUES ('wf-chk', 'PNC Checking', 'cash', 0, 1), ('wf-ally', 'Ally Savings', 'CASH', 1, 0);
    INSERT INTO assets VALUES ('cash-by-code', '$CASH', NULL, 'Cash'), ('AAPL', 'AAPL', 'AAPL', 'Apple');
    INSERT INTO activities VALUES
      ('act-1', 'wf-chk', 'TRANSFER_OUT', NULL, NULL, NULL, '2026-10-04T00:00:00+00:00', '600', 'usd', NULL, '{"flow":{"is_external":true}}', 'TRANSFER TO ALLY · TRN-1', NULL, NULL),
      ('act-2', 'wf-chk', 'DEPOSIT', 'TRANSFER_IN', 'refund', 'posted', '2026-10-05T04:00:00+00:00', '12.35', 'USD', 'cash-by-code', '{"flow":{"is_external":false}}', 'A | B · TRN-2', 'g1', '1.5'),
      ('act-3', 'wf-ally', 'WITHDRAWAL', NULL, NULL, 'PENDING', '2026-09-30T00:00:00+00:00', '-9.99', 'USD', '${PHANTOM_CASH_ASSET_ID}', 'not json', NULL, NULL, ''),
      ('act-4', 'wf-chk', 'WITHDRAWAL', '  ', NULL, NULL, '2026-11-01T00:00:00+00:00', '5', 'USD', 'AAPL', '{"flow":{"is_external":"true"}}', 'LATE · TRN-4', NULL, '-3');
    INSERT INTO taxonomy_categories VALUES ('cat-a', 'spending_categories', 'Food', NULL), ('cat-b', 'spending_categories', 'Fun', 'cat-a'), ('inc', 'income_sources', 'Pay', NULL);
    INSERT INTO activity_taxonomy_assignments VALUES
      ('x1', 'act-2', 'spending_categories', 'cat-a', 10000, 'rule', '2026-10-06T00:00:00Z'),
      ('x2', 'act-2', 'spending_categories', 'cat-b', 10000, 'manual', '2026-10-05T09:00:00Z'),
      ('x3', 'act-2', 'income_sources', 'inc', 10000, 'manual', '2026-10-01T00:00:00Z');
  `);
  if (settings) {
    db.exec(`
      CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT);
      INSERT INTO app_settings VALUES ('timezone', 'America/New_York'), ('spending.excluded_category_ids', '["cat-a", 5, "cat-b"]'), ('theme', 'dark');
    `);
  }
  db.close();
  return path;
}

describe('getNativeAuditLedger', () => {
  it('reads every account and every row, the override type for Health (a blank one is none) and the raw type for cash', () => {
    const { accounts, rows } = getNativeAuditLedger(ledger());
    expect(accounts).toEqual([
      { id: 'wf-ally', type: 'CASH', archived: true, active: false, name: 'Ally Savings' },
      { id: 'wf-chk', type: 'CASH', archived: false, active: true, name: 'PNC Checking' },
    ]);
    expect(rows).toEqual([
      {
        id: 'act-3', accountId: 'wf-ally', date: '2026-09-30', currency: 'USD', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', status: 'PENDING',
        absCents: 999, group: '', assetId: PHANTOM_CASH_ASSET_ID, quantity: null, external: false, phantomCash: true, notes: '',
      },
      {
        id: 'act-1', accountId: 'wf-chk', date: '2026-10-04', currency: 'USD', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', status: 'POSTED',
        absCents: 60000, group: '', assetId: '', quantity: null, external: true, phantomCash: false, notes: 'TRANSFER TO ALLY · TRN-1',
      },
      {
        id: 'act-2', accountId: 'wf-chk', date: '2026-10-05', currency: 'USD', rawType: 'DEPOSIT', type: 'TRANSFER_IN', status: 'POSTED',
        absCents: 1235, group: 'g1', assetId: 'cash-by-code', quantity: 1.5, external: false, phantomCash: true, notes: 'A | B · TRN-2',
      },
      {
        id: 'act-4', accountId: 'wf-chk', date: '2026-11-01', currency: 'USD', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', status: 'POSTED',
        absCents: 500, group: '', assetId: 'AAPL', quantity: -3, external: false, phantomCash: false, notes: 'LATE · TRN-4',
      },
    ]);
  });

  it('throws — unknown, never "nothing" — when the database cannot be read', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => getNativeAuditLedger('/nope/wealthfolio.db')).toThrow(NativeDbUnreadableError);
      expect(() => getNativeAuditLedger('')).toThrow(NativeDbUnreadableError);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('getNativeHeadlineRows', () => {
  it('reads the month’s rows in every account, with their spending filings and every category', () => {
    const rows = getNativeHeadlineRows(ledger(), '2026-10-01', '2026-11-01');
    expect(rows.map((r) => r.id)).toEqual(['act-1', 'act-2']);
    const two = rows[1];
    expect({ ...two, categoryIds: [...two.categoryIds].sort() }).toEqual({
      id: 'act-2', date: '2026-10-05T04:00:00+00:00', accountType: 'CASH', type: 'DEPOSIT', subtype: 'REFUND', absCents: 1235,
      spendingFilings: 2, categoryIds: ['cat-a', 'cat-b', 'inc'], spendingCategoryId: 'cat-b', accountName: 'PNC Checking', notes: 'A | B · TRN-2',
    });
    expect(rows[0]).toMatchObject({ spendingFilings: 0, categoryIds: [], spendingCategoryId: null });
  });

  it('refuses malformed bounds, and throws when the database cannot be read', () => {
    expect(() => getNativeHeadlineRows(ledger(), "2026-10-01' OR 1=1 --", '2026-11-01')).toThrow(/malformed month bounds/);
    expect(() => getNativeHeadlineRows('/nope/wealthfolio.db', '2026-10-01', '2026-11-01')).toThrow(NativeDbUnreadableError);
  });
});

describe('getNativeAuditSettings', () => {
  it('reads Wealthfolio’s timezone, the categories it excludes and each spending category’s parent', () => {
    expect(getNativeAuditSettings(ledger())).toEqual({
      timezone: 'America/New_York', excludedCategoryIds: ['cat-a', 'cat-b'], categoryParents: { 'cat-a': null, 'cat-b': 'cat-a' },
    });
  });

  it('reads an unset or unparseable setting as none, and a missing table as unreadable', () => {
    const path = ledger();
    const db = new DatabaseSync(path);
    db.exec(`DELETE FROM app_settings WHERE setting_key = 'timezone'; UPDATE app_settings SET setting_value = '[oops' WHERE setting_key = 'spending.excluded_category_ids';`);
    db.close();
    expect(getNativeAuditSettings(path)).toMatchObject({ timezone: null, excludedCategoryIds: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => getNativeAuditSettings(ledger(false))).toThrow(NativeDbUnreadableError);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('the CLI fallback parsers split on the unit separator', () => {
  it('keeps a separator or a | inside the last column, and drops a shifted line', () => {
    const row = ['act-1', 'wf-chk', '2026-10-04', 'USD', 'TRANSFER_OUT', 'TRANSFER_OUT', 'POSTED', '60000', '', '', 'true', '0', '2', 'A\x1fB | C'];
    expect(auditRowFromCliParts(row)).toMatchObject({ c0: 'act-1', c7: '60000', c12: '2', c13: 'A\x1fB | C' });
    expect(auditRowFromCliParts(['act-1', 'x'])).toBeNull();
    expect(auditRowFromCliParts([...row.slice(0, 7), 'oops', ...row.slice(8)])).toBeNull();
    expect(auditAccountFromCliParts(['wf-chk', 'CASH', '0', '1', 'Joe\x1fCo'])).toEqual({ c0: 'wf-chk', c1: 'CASH', c2: '0', c3: '1', c4: 'Joe\x1fCo' });
    const month = ['act-2', '2026-10-05', 'CASH', 'DEPOSIT', '', '1235', '2', 'cat-a,cat-b', 'cat-b', 'PNC', 'A | B'];
    expect(headlineRowFromCliParts(month)).toMatchObject({ c5: '1235', c8: 'cat-b', c10: 'A | B' });
    expect(headlineRowFromCliParts(month.slice(0, 5))).toBeNull();
  });
});
