import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getNativePastFilings, pastFilingFromCliParts } from './sqlite-guess.js';
import { NativeDbUnreadableError } from './sqlite-native.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real tables and column names, only the columns this reader touches. */
function db(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-guess-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE activities (id TEXT PRIMARY KEY, notes TEXT);
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, taxonomy_id TEXT, name TEXT, parent_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (id TEXT, activity_id TEXT, taxonomy_id TEXT, category_id TEXT, weight INTEGER, source TEXT, created_at TEXT);
    INSERT INTO taxonomy_categories VALUES ('cat-gro', 'spending_categories', 'Groceries', NULL), ('cat-fun', 'spending_categories', 'Fun', NULL), ('inc', 'income_sources', 'Pay', NULL);
    INSERT INTO activities VALUES
      ('a1', 'KROGER #415 · TRN-1'), ('a2', 'KROGER #415 · TRN-2 · pending'), ('a3', 'KROGER #9 · TRN-3'),
      ('a4', 'OLD KROGER · TRN-4'), ('a5', 'PAYROLL · TRN-5'), ('a6', 'Starting balance · ACT-1'),
      ('a7', 'VENMO' || char(10) || 'PAYMENT · Venmo: Rent · TRN-7'), ('a8', 'MIGRATED · TRN-8'),
      ('a9', 'REFILED · TRN-9'), ('a10', NULL), ('a11', 'EDGE · TRN-11'), ('a12', 'EDGE DATE · TRN-12'), ('a13', 'LATEST MIG · TRN-13');
    INSERT INTO activity_taxonomy_assignments VALUES
      ('x1', 'a1', 'spending_categories', 'cat-gro', 10000, 'manual', '2026-10-01T09:00:00Z'),
      ('x2', 'a2', 'spending_categories', 'cat-gro', 10000, 'rule', '2026-09-01 12:00:00'),
      ('x3', 'a3', 'spending_categories', 'cat-gone', 10000, 'manual', '2026-08-01T00:00:00Z'),
      ('x4', 'a4', 'spending_categories', 'cat-gro', 10000, 'manual', '2025-10-13T23:59:59Z'),
      ('x5', 'a5', 'income_sources', 'inc', 10000, 'manual', '2026-10-01T00:00:00Z'),
      ('x6', 'a6', 'spending_categories', 'cat-gro', 10000, 'manual', '2026-10-01T00:00:00Z'),
      ('x7', 'a7', 'spending_categories', 'cat-gro', 10000, 'MANUAL', '2026-10-02T00:00:00Z'),
      ('x8', 'a8', 'spending_categories', 'cat-gro', 10000, 'migrated', '2026-10-02T00:00:00Z'),
      ('x9a', 'a9', 'spending_categories', 'cat-gro', 10000, 'manual', '2026-09-01T00:00:00Z'),
      ('x9b', 'a9', 'spending_categories', 'cat-fun', 10000, 'manual', '2026-09-05T00:00:00Z'),
      ('x10', 'a10', 'spending_categories', 'cat-gro', 10000, 'manual', '2026-10-01T00:00:00Z'),
      ('x11', 'a11', 'spending_categories', 'cat-gro', 10000, 'manual', '2025-10-14T00:00:00Z'),
      ('x12', 'a12', 'spending_categories', 'cat-gro', 10000, 'manual', '2025-10-14'),
      ('x13a', 'a13', 'spending_categories', 'cat-gro', 10000, 'manual', '2026-09-01T00:00:00Z'),
      ('x13b', 'a13', 'spending_categories', 'cat-gro', 10000, 'migrated', '2026-09-02T00:00:00Z');
  `);
  d.close();
  return path;
}

describe('getNativePastFilings', () => {
  it('reads your spending filings and your rules’ since the day — not income, bookkeeping, migrated or older ones', () => {
    const rows = getNativePastFilings(db(), '2025-10-14');
    const byText = (a: { description: string }, b: { description: string }) => (a.description < b.description ? -1 : a.description > b.description ? 1 : 0);
    expect(rows.sort(byText)).toEqual([
      { categoryId: 'cat-gro', categoryName: 'Groceries', description: '' },
      { categoryId: 'cat-gro', categoryName: 'Groceries', description: 'EDGE' },
      { categoryId: 'cat-gro', categoryName: 'Groceries', description: 'EDGE DATE' },
      { categoryId: 'cat-gro', categoryName: 'Groceries', description: 'KROGER #415' },
      { categoryId: 'cat-gro', categoryName: 'Groceries', description: 'KROGER #415' },
      { categoryId: 'cat-fun', categoryName: 'Fun', description: 'REFILED' },
      { categoryId: 'cat-gro', categoryName: 'Groceries', description: 'VENMO PAYMENT · Venmo: Rent' },
    ].sort(byText));
  });

  it('counts a transaction re-filed from A to B once, as B — and one whose latest filing is not yours not at all', () => {
    const rows = getNativePastFilings(db(), '2025-10-14');
    expect(rows.filter((r) => r.description === 'REFILED')).toEqual([{ categoryId: 'cat-fun', categoryName: 'Fun', description: 'REFILED' }]);
    expect(rows.some((r) => r.description === 'LATEST MIG')).toBe(false);
  });

  it('includes the whole boundary day, leaves out a category that no longer exists, and coalesces a null note', () => {
    const rows = getNativePastFilings(db(), '2025-10-14');
    expect(rows.map((r) => r.description)).toEqual(expect.arrayContaining(['EDGE', 'EDGE DATE', '']));
    expect(rows.some((r) => r.categoryId === 'cat-gone' || r.description === 'KROGER #9' || r.description === 'OLD KROGER')).toBe(false);
  });

  it('throws — never answers "no filings" — when the database cannot be read', () => {
    expect(() => getNativePastFilings(join(tmpdir(), 'no-such-dir', 'wealthfolio.db'), '2025-10-14')).toThrow(NativeDbUnreadableError);
    expect(() => getNativePastFilings(db(), "2025-10-14' OR 1=1 --")).toThrow(/malformed day/);
  });

  it('rebuilds a CLI line with the note last, a separator inside it kept', () => {
    expect(pastFilingFromCliParts(['cat-gro', 'Groceries', 'A', 'B · TRN-1'])).toEqual({ c0: 'cat-gro', c1: 'Groceries', c2: 'A\x1fB · TRN-1' });
    expect(pastFilingFromCliParts(['too', 'short'])).toBeNull();
  });
});
