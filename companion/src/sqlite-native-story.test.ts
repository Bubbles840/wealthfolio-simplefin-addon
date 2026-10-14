import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getNativeTxDetails, getNativeTxPartner, getNativeTxSearchRows, NativeDbUnreadableError, storyAssignmentFromCliParts, storyPartnerFromCliParts, storySearchRowFromCliParts } from './sqlite-native.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real tables and column names, only the columns these readers touch. */
function ledger(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-story-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT, is_archived BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE activities (id TEXT PRIMARY KEY, account_id TEXT, activity_type TEXT, activity_date TEXT, amount TEXT, notes TEXT, source_group_id TEXT);
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, taxonomy_id TEXT, name TEXT, parent_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (id TEXT, activity_id TEXT, taxonomy_id TEXT, category_id TEXT, weight INTEGER, source TEXT);
    INSERT INTO accounts VALUES ('wf-chk', 'PNC Checking', 'CASH', 0), ('wf-ally', 'Ally Savings', 'CASH', 0), ('wf-old', 'Closed card', 'CREDIT_CARD', 1);
    INSERT INTO activities VALUES
      ('act-1', 'wf-chk', 'WITHDRAWAL', '2026-10-04T04:00:00+00:00', '54.20', 'KROGER #415 · TRN-1', NULL),
      ('act-2', 'wf-chk', 'TRANSFER_OUT', '2026-10-05T04:00:00+00:00', '600', 'TRANSFER TO ALLY · TRN-2', 'wf-transfer-9'),
      ('act-3', 'wf-ally', 'TRANSFER_IN', '2026-10-06T04:00:00+00:00', '600', 'TRANSFER FROM PNC · TRN-3', 'wf-transfer-9'),
      ('act-4', 'wf-old', 'WITHDRAWAL', '2026-09-01T04:00:00+00:00', '9.99', 'OLD CARD THING · TRN-4', NULL);
    INSERT INTO taxonomy_categories VALUES ('cat-gro', 'spending_categories', 'Groceries', NULL), ('inc-sal', 'income_sources', 'Salary', NULL);
    INSERT INTO activity_taxonomy_assignments VALUES
      ('x1', 'act-1', 'income_sources', 'inc-sal', 10000, 'manual'),
      ('x2', 'act-1', 'spending_categories', 'cat-gro', 10000, 'rule');
  `);
  db.close();
  return path;
}

describe('getNativeTxDetails', () => {
  it('reads every assignment with its category name and source, and the account type', () => {
    expect(getNativeTxDetails(ledger(), 'act-1')).toEqual({
      accountType: 'CASH',
      assignments: [
        { taxonomyId: 'income_sources', categoryId: 'inc-sal', categoryName: 'Salary', source: 'manual' },
        { taxonomyId: 'spending_categories', categoryId: 'cat-gro', categoryName: 'Groceries', source: 'rule' },
      ],
    });
  });

  it('a row with no category has no assignments; quotes in an id are text', () => {
    expect(getNativeTxDetails(ledger(), 'act-2')).toEqual({ accountType: 'CASH', assignments: [] });
    expect(getNativeTxDetails(ledger(), "act-1' OR '1'='1")).toEqual({ accountType: '', assignments: [] });
  });

  it('throws — unknown, never "none" — without the database', () => {
    expect(() => getNativeTxDetails('/nope/wealthfolio.db', 'act-1')).toThrow(/Could not read the Wealthfolio database/);
  });
});

describe('getNativeTxPartner', () => {
  it('finds the other activity in the same group', () => {
    expect(getNativeTxPartner(ledger(), 'wf-transfer-9', 'act-2')).toEqual({ activityId: 'act-3', accountName: 'Ally Savings', date: '2026-10-06' });
  });

  it('is null when nothing else shares the group, and throws without the database', () => {
    expect(getNativeTxPartner(ledger(), 'wf-transfer-none', 'act-2')).toBeNull();
    expect(() => getNativeTxPartner('', 'wf-transfer-9', 'act-2')).toThrow(/Could not read the Wealthfolio database/);
  });
});

describe('getNativeTxSearchRows', () => {
  it('lists all of history, newest first, leaving out archived accounts', () => {
    expect(getNativeTxSearchRows(ledger())).toEqual([
      { activityId: 'act-3', date: '2026-10-06', absCents: 60000, activityType: 'TRANSFER_IN', accountName: 'Ally Savings', accountType: 'CASH', notes: 'TRANSFER FROM PNC · TRN-3' },
      { activityId: 'act-2', date: '2026-10-05', absCents: 60000, activityType: 'TRANSFER_OUT', accountName: 'PNC Checking', accountType: 'CASH', notes: 'TRANSFER TO ALLY · TRN-2' },
      { activityId: 'act-1', date: '2026-10-04', absCents: 5420, activityType: 'WITHDRAWAL', accountName: 'PNC Checking', accountType: 'CASH', notes: 'KROGER #415 · TRN-1' },
    ]);
  });

  it('throws when the database cannot be read', () => {
    expect(() => getNativeTxSearchRows('/nope/wealthfolio.db')).toThrow(/Could not read the Wealthfolio database/);
    expect(() => getNativeTxSearchRows('')).toThrow(NativeDbUnreadableError);
  });
});

describe('the CLI fallback parsers split on the unit separator', () => {
  it('keeps a | in an account name or a note inside its column', () => {
    expect(storySearchRowFromCliParts('act-9\x1f2026-10-04\x1f5420\x1fWITHDRAWAL\x1fCASH\x1fJoe|Co Checking\x1fSQ *A|B · TRN-9'.split('\x1f'))).toEqual({
      c0: 'act-9', c1: '2026-10-04', c2: 5420, c3: 'WITHDRAWAL', c4: 'CASH', c5: 'Joe|Co Checking', c6: 'SQ *A|B · TRN-9',
    });
    expect(storyPartnerFromCliParts('act-3\x1f2026-10-06\x1fAlly | Savings'.split('\x1f'))).toEqual({ c0: 'act-3', c1: '2026-10-06', c2: 'Ally | Savings' });
    expect(storyAssignmentFromCliParts('spending_categories\x1fcat-x\x1fFood|Drink\x1frule'.split('\x1f'))).toEqual({ c0: 'spending_categories', c1: 'cat-x', c2: 'Food|Drink', c3: 'rule' });
    expect(storyPartnerFromCliParts(['a'])).toBeNull();
  });
});

describe('queryNativeDbStrict through the readers', () => {
  it('a database that exists but lacks a table (both paths fail) throws NativeDbUnreadableError', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfin-story-'));
    made.push(dir);
    const path = join(dir, 'wealthfolio.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE unrelated (x TEXT);');
    db.close();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => getNativeTxSearchRows(path)).toThrow(NativeDbUnreadableError);
      expect(() => getNativeTxDetails(path, 'a')).toThrow(NativeDbUnreadableError);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
