import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getNativeRuleFiledActivityIds } from './sqlite-native.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

function ledger(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-undo-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE activities (id TEXT PRIMARY KEY, activity_date TEXT, notes TEXT);
    CREATE TABLE activity_taxonomy_assignments (activity_id TEXT, taxonomy_id TEXT, category_id TEXT, source TEXT);
    INSERT INTO activities VALUES
      ('a1','2026-10-01','TRADER JOE S #628 · TRN-1'),
      ('a2','2026-10-05','trader joe s #91 · TRN-2'),
      ('a3','2026-10-06','TRADER JOE S #628 · TRN-3'),
      ('a4','2026-10-07','TRADER JOE S #628 · TRN-4'),
      ('a5','2026-10-08','KROGER · TRN-5');
    INSERT INTO activity_taxonomy_assignments VALUES
      ('a1','spending_categories','cat-gro','rule'),
      ('a2','spending_categories','cat-gro','RULE'),
      ('a3','spending_categories','cat-gro','manual'),
      ('a4','spending_categories','cat-din','rule'),
      ('a5','spending_categories','cat-gro','rule');
  `);
  db.close();
  return path;
}

describe('getNativeRuleFiledActivityIds', () => {
  it('lists what a rule filed: source rule, its category, a note with its words — newest first', () => {
    expect(getNativeRuleFiledActivityIds(ledger(), 'cat-gro', 'TRADER JOE S')).toEqual(['a2', 'a1']);
  });

  it('treats quotes and LIKE wildcards in the words as text', () => {
    expect(getNativeRuleFiledActivityIds(ledger(), "cat-gro' OR '1'='1", 'TRADER')).toEqual([]);
    expect(getNativeRuleFiledActivityIds(ledger(), 'cat-gro', '%')).toEqual([]);
  });

  it('is null — unknown, not none — without the database', () => {
    expect(getNativeRuleFiledActivityIds('/nope/wealthfolio.db', 'cat-gro', 'TRADER')).toBeNull();
    expect(getNativeRuleFiledActivityIds('', 'cat-gro', 'TRADER')).toBeNull();
  });
});
