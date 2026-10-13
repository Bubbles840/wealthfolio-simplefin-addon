import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileCardOpeningDebts } from './opening-balance-category.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

function ledger(rows: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-open-ov-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT);
    CREATE TABLE activities (id TEXT PRIMARY KEY, account_id TEXT, activity_type TEXT, activity_date TEXT, amount TEXT, notes TEXT);
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, name TEXT, parent_id TEXT, taxonomy_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (activity_id TEXT, category_id TEXT);
    CREATE TABLE app_settings (setting_key TEXT, setting_value TEXT);
    INSERT INTO accounts VALUES ('card','Citi','CREDIT_CARD'),('card2','Discover','CREDIT_CARD');
    ${rows}
  `);
  db.close();
  return path;
}

describe('fileCardOpeningDebts — noOpeningFile', () => {
  it('leaves the opening balance of an account whose filing the person undid', async () => {
    const d = {
      dbPath: ledger(`
        INSERT INTO taxonomy_categories VALUES ('ob','Opening balances',NULL,'spending_categories');
        INSERT INTO app_settings VALUES ('spending.excluded_category_ids','["ob"]');
        INSERT INTO activities VALUES ('o','card','WITHDRAWAL','2026-04-20','464.6','Starting balance · sfc');
        INSERT INTO activities VALUES ('p','card2','WITHDRAWAL','2026-05-20','10','Starting balance · sfd');
      `),
      createCategory: vi.fn(async () => 'new-cat'),
      setExcluded: vi.fn(async () => {}),
      assign: vi.fn(async () => {}),
      log: vi.fn(),
      noOpeningFile: (sfin: string) => sfin === 'sfc',
    };
    expect(await fileCardOpeningDebts(d)).toEqual({ filed: 1 });
    expect(d.assign).toHaveBeenCalledWith('p', 'ob');
    expect(d.assign).not.toHaveBeenCalledWith('o', 'ob');
  });

  it('creates nothing when the only opening debt is one the person undid', async () => {
    const d = {
      dbPath: ledger(`INSERT INTO activities VALUES ('o','card','WITHDRAWAL','2026-04-20','464.6','Starting balance · sfc');`),
      createCategory: vi.fn(async () => 'new-cat'),
      setExcluded: vi.fn(async () => {}),
      assign: vi.fn(async () => {}),
      log: vi.fn(),
      noOpeningFile: () => true,
    };
    expect(await fileCardOpeningDebts(d)).toEqual({ filed: 0 });
    expect(d.createCategory).not.toHaveBeenCalled();
  });
});
