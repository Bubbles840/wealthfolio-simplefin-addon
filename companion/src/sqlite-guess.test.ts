import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getNativePastFilings, pastFilingFromCliParts } from './sqlite-guess.js';
import { NativeDbUnreadableError } from './sqlite-native.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real tables and column names, only the columns this reader touches —
 *  with Wealthfolio's one-row-per-(activity, taxonomy) unique index, and filings
 *  written the way it writes them: INSERT … ON CONFLICT DO UPDATE, which keeps
 *  `created_at` and moves `updated_at` (crates/storage-sqlite, v3.8 and v3.10). */
function db(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-guess-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE activities (id TEXT PRIMARY KEY, notes TEXT);
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, taxonomy_id TEXT, name TEXT, parent_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (
      id TEXT NOT NULL PRIMARY KEY, activity_id TEXT NOT NULL, taxonomy_id TEXT NOT NULL, category_id TEXT NOT NULL,
      weight INTEGER NOT NULL DEFAULT 10000, source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX ix_activity_taxonomy_assignment_unique ON activity_taxonomy_assignments(activity_id, taxonomy_id);
    INSERT INTO taxonomy_categories VALUES ('cat-gro', 'spending_categories', 'Groceries', NULL), ('cat-fun', 'spending_categories', 'Fun', NULL), ('inc', 'income_sources', 'Pay', NULL);
    INSERT INTO activities VALUES
      ('a1', 'KROGER #415 · TRN-1'), ('a2', 'KROGER #415 · TRN-2 · pending'), ('a3', 'KROGER #9 · TRN-3'),
      ('a4', 'OLD KROGER · TRN-4'), ('a5', 'PAYROLL · TRN-5'), ('a6', 'Starting balance · ACT-1'),
      ('a7', 'VENMO' || char(10) || 'PAYMENT · Venmo: Rent · TRN-7'), ('a8', 'MIGRATED · TRN-8'),
      ('a9', 'REFILED · TRN-9'), ('a10', NULL), ('a11', 'EDGE · TRN-11'), ('a12', 'EDGE DATE · TRN-12'),
      ('a14', 'OLD REFILE · TRN-14'), ('a15', 'RULE BUMPED · TRN-15');
  `);
  const file = d.prepare(`INSERT INTO activity_taxonomy_assignments (id, activity_id, taxonomy_id, category_id, weight, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 10000, ?, ?, ?)
    ON CONFLICT (activity_id, taxonomy_id) DO UPDATE SET
      category_id = excluded.category_id, weight = excluded.weight, source = excluded.source, updated_at = excluded.updated_at`);
  const at = (id: string, act: string, cat: string, source: string, stamp: string, tax = 'spending_categories') =>
    file.run(id, act, tax, cat, source, stamp, stamp);
  at('x1', 'a1', 'cat-gro', 'manual', '2026-10-01T09:00:00Z');
  at('x2', 'a2', 'cat-gro', 'rule', '2026-09-01 12:00:00');
  at('x3', 'a3', 'cat-gone', 'manual', '2026-08-01T00:00:00Z');
  at('x4', 'a4', 'cat-gro', 'manual', '2025-10-13T23:59:59Z');
  at('x5', 'a5', 'inc', 'manual', '2026-10-01T00:00:00Z', 'income_sources');
  at('x6', 'a6', 'cat-gro', 'manual', '2026-10-01T00:00:00Z');
  at('x7', 'a7', 'cat-gro', 'MANUAL', '2026-10-02T00:00:00Z');
  at('x8', 'a8', 'cat-gro', 'migrated', '2026-10-02T00:00:00Z');
  // Re-filed Groceries → Fun: the same row, updated in place.
  at('x9a', 'a9', 'cat-gro', 'manual', '2026-09-01T00:00:00Z');
  at('x9b', 'a9', 'cat-fun', 'manual', '2026-09-05T00:00:00Z');
  at('x10', 'a10', 'cat-gro', 'manual', '2026-10-01T00:00:00Z');
  at('x11', 'a11', 'cat-gro', 'manual', '2025-10-14T00:00:00Z');
  at('x12', 'a12', 'cat-gro', 'manual', '2025-10-14');
  // First filed before the window, re-filed inside it (chrono's to_rfc3339 stamps).
  at('x14a', 'a14', 'cat-gro', 'manual', '2025-09-01T12:00:00.123456789+00:00');
  at('x14b', 'a14', 'cat-fun', 'manual', '2026-09-05T12:00:00.123456789+00:00');
  // A rule filing from before the window whose updated_at a rules re-run bumped.
  d.prepare(`INSERT INTO activity_taxonomy_assignments VALUES ('x15', 'a15', 'spending_categories', 'cat-gro', 10000, 'rule', ?, ?)`)
    .run('2025-09-01T12:00:00+00:00', '2026-10-01T12:00:00+00:00');
  d.close();
  return path;
}

/** No unique index: a schema that kept several assignments per activity, which
 *  Wealthfolio's does not today. Only the latest filing may count. */
function multiRowDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-guess-multi-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE activities (id TEXT PRIMARY KEY, notes TEXT);
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, taxonomy_id TEXT, name TEXT, parent_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (id TEXT, activity_id TEXT, taxonomy_id TEXT, category_id TEXT, weight INTEGER, source TEXT, created_at TEXT, updated_at TEXT);
    INSERT INTO taxonomy_categories VALUES ('cat-gro', 'spending_categories', 'Groceries', NULL), ('cat-fun', 'spending_categories', 'Fun', NULL);
    INSERT INTO activities VALUES ('a9', 'REFILED · TRN-9'), ('a13', 'LATEST MIG · TRN-13');
    INSERT INTO activity_taxonomy_assignments VALUES
      ('x9a', 'a9', 'spending_categories', 'cat-gro', 10000, 'manual', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      ('x9b', 'a9', 'spending_categories', 'cat-fun', 10000, 'manual', '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z'),
      ('x13a', 'a13', 'spending_categories', 'cat-gro', 10000, 'manual', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      ('x13b', 'a13', 'spending_categories', 'cat-gro', 10000, 'migrated', '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z');
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
      { categoryId: 'cat-fun', categoryName: 'Fun', description: 'OLD REFILE' },
      { categoryId: 'cat-fun', categoryName: 'Fun', description: 'REFILED' },
      { categoryId: 'cat-gro', categoryName: 'Groceries', description: 'VENMO PAYMENT · Venmo: Rent' },
    ].sort(byText));
  });

  it('counts a transaction re-filed from A to B once, as B', () => {
    const rows = getNativePastFilings(db(), '2025-10-14');
    expect(rows.filter((r) => r.description === 'REFILED')).toEqual([{ categoryId: 'cat-fun', categoryName: 'Fun', description: 'REFILED' }]);
  });

  it('counts a re-filing (ON CONFLICT … DO UPDATE: one row, the new category) from when you re-filed it — updated_at', () => {
    // First filed 2025-09-01, before the window; re-filed under Fun on 2026-09-05.
    const rows = getNativePastFilings(db(), '2025-10-14');
    expect(rows.filter((r) => r.description === 'OLD REFILE')).toEqual([{ categoryId: 'cat-fun', categoryName: 'Fun', description: 'OLD REFILE' }]);
    // …and not once the window starts after the re-filing.
    expect(getNativePastFilings(db(), '2026-09-06').some((r) => r.description === 'OLD REFILE')).toBe(false);
  });

  it('counts a rule filing from when the rule filed it — created_at — whatever a rules re-run did to updated_at', () => {
    expect(getNativePastFilings(db(), '2025-10-14').some((r) => r.description === 'RULE BUMPED')).toBe(false);
    expect(getNativePastFilings(db(), '2025-09-01').filter((r) => r.description === 'RULE BUMPED')).toHaveLength(1);
  });

  it('a schema with several rows per activity: only the latest filing counts (the NOT EXISTS guard)', () => {
    const rows = getNativePastFilings(multiRowDb(), '2025-10-14');
    expect(rows).toEqual([{ categoryId: 'cat-fun', categoryName: 'Fun', description: 'REFILED' }]);
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
