import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileSyncBookkeeping, type BookkeepingFilingDeps } from './bookkeeping-category.js';
import { SYNC_BOOKKEEPING_DESCRIPTION } from '../../shared/bookkeeping-filing.js';
import type { ChangeDraft } from '../../shared/change-entries.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Wealthfolio's tables: a checking account and a card the Spending page reads, savings it does not. */
function database(rows: string, settings = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-bk-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT, is_archived INTEGER DEFAULT 0);
    CREATE TABLE activities (id TEXT PRIMARY KEY, account_id TEXT, activity_type TEXT, activity_type_override TEXT, subtype TEXT,
      activity_date TEXT, amount TEXT, notes TEXT, source_group_id TEXT);
    CREATE TABLE taxonomy_categories (id TEXT, taxonomy_id TEXT, name TEXT, parent_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (id TEXT, activity_id TEXT, taxonomy_id TEXT, category_id TEXT, source TEXT, created_at TEXT);
    CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT);
    INSERT INTO accounts VALUES ('chk', 'PNC Checking', 'CASH', 0), ('visa', 'Visa', 'CREDIT_CARD', 0), ('sav', 'Savings', 'CASH', 0);
    INSERT INTO app_settings VALUES ('spending.enabled', 'true'), ('spending.account_ids', '["chk","visa"]');
    INSERT INTO taxonomy_categories VALUES ('cat-gro', 'spending_categories', 'Groceries', NULL), ('cat-open', 'spending_categories', 'Opening balances', NULL);
    ${settings}
    ${rows}
  `);
  db.close();
  return path;
}

function deps(dbPath: string, over: Partial<BookkeepingFilingDeps> = {}) {
  const recorded: ChangeDraft[] = [];
  const d: BookkeepingFilingDeps = {
    dbPath,
    createCategory: vi.fn(async () => 'cat-sync-new'),
    setExcluded: vi.fn(async () => {}),
    assign: vi.fn(async () => {}),
    unassign: vi.fn(async () => {}),
    appVersion: vi.fn(async () => '3.10.0'),
    record: (draft) => { recorded.push(draft); },
    log: vi.fn(),
    ...over,
  };
  return { d, recorded };
}

const PLACEHOLDER = `INSERT INTO activities VALUES ('ph', 'chk', 'TRANSFER_OUT', NULL, NULL, '2026-10-05T12:00:00+00:00', '600', '↔️ In-transit transfer · ZELLE · TRN-1', NULL);`;

describe('fileSyncBookkeeping', () => {
  it('files a placeholder under a new "Sync bookkeeping", excludes the category from spending, and logs one entry', async () => {
    const { d, recorded } = deps(database(PLACEHOLDER, `INSERT INTO app_settings VALUES ('spending.excluded_category_ids', '["cat-mine"]');`));
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 1, unfiled: 0 });
    expect(d.createCategory).toHaveBeenCalledWith('Sync bookkeeping', SYNC_BOOKKEEPING_DESCRIPTION);
    // Appended to the person's own exclusions, never replacing them.
    expect(d.setExcluded).toHaveBeenCalledWith(['cat-mine', 'cat-sync-new']);
    expect(d.assign).toHaveBeenCalledWith('ph', 'cat-sync-new');
    expect(recorded).toEqual([expect.objectContaining({ kind: 'bookkeeping', after: expect.objectContaining({ step: 'sync-bookkeeping', count: 1, unfiled: 0 }) })]);
  });

  it('takes out an expired placeholder, leaves a hand-filed row and one already filed alone', async () => {
    const path = database(`
      INSERT INTO taxonomy_categories VALUES ('cat-sync', 'spending_categories', 'Sync bookkeeping', NULL);
      INSERT INTO activities VALUES ('expired', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-09-20T12:00:00+00:00', '40', 'ZELLE TO MOM · TRN-2', NULL);
      INSERT INTO activities VALUES ('mine', 'chk', 'TRANSFER_OUT', NULL, NULL, '2026-10-05T12:00:00+00:00', '25', 'Balance adjustment · sfin-1 · 2026-10-05', NULL);
      INSERT INTO activities VALUES ('done', 'visa', 'WITHDRAWAL', NULL, NULL, '2026-10-06T12:00:00+00:00', '9', '↔️ In-transit transfer · PAYMENT · TRN-3', NULL);
      INSERT INTO activity_taxonomy_assignments VALUES
        ('f1', 'expired', 'spending_categories', 'cat-sync', 'manual', '2026-09-20T13:00:00Z'),
        ('f2', 'mine', 'spending_categories', 'cat-gro', 'manual', '2026-10-05T13:00:00Z'),
        ('f3', 'done', 'spending_categories', 'cat-sync', 'manual', '2026-10-06T13:00:00Z');
    `, `INSERT INTO app_settings VALUES ('spending.excluded_category_ids', '["cat-sync"]');`);
    const { d, recorded } = deps(path);
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 1 });
    expect(d.unassign).toHaveBeenCalledWith('expired');
    expect(d.assign).not.toHaveBeenCalled();
    expect(d.createCategory).not.toHaveBeenCalled();
    expect(d.setExcluded).not.toHaveBeenCalled();
    expect(recorded.map((r) => r.summary)).toEqual(['Took 1 row that is no longer bookkeeping out of "Sync bookkeeping"']);
  });

  it.each([['3.8.0'], ['3.8.4'], [null]])('does nothing at all on Wealthfolio %s, which excludes no category', async (version) => {
    const { d, recorded } = deps(database(PLACEHOLDER), { appVersion: vi.fn(async () => version) });
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 0 });
    expect(d.createCategory).not.toHaveBeenCalled();
    expect(d.assign).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('skips rows Wealthfolio does not count as spending, and rows in accounts its Spending page does not read', async () => {
    const { d } = deps(database(`
      INSERT INTO activities VALUES ('in', 'chk', 'TRANSFER_IN', NULL, NULL, '2026-10-05T12:00:00+00:00', '600', '↔️ In-transit transfer · FROM ALLY · TRN-1', NULL);
      INSERT INTO activities VALUES ('linked', 'chk', 'TRANSFER_OUT', NULL, NULL, '2026-10-05T12:00:00+00:00', '600', '↔️ In-transit transfer · TO ALLY · TRN-2', 'g-1');
      INSERT INTO activities VALUES ('card310', 'visa', 'TRANSFER_OUT', NULL, NULL, '2026-10-05T12:00:00+00:00', '5', 'Balance adjustment · sfin-v · 2026-10-05', NULL);
      INSERT INTO activities VALUES ('elsewhere', 'sav', 'TRANSFER_OUT', NULL, NULL, '2026-10-05T12:00:00+00:00', '7', 'Balance adjustment · sfin-s · 2026-10-05', NULL);
      INSERT INTO activities VALUES ('credit', 'chk', 'CREDIT', NULL, NULL, '2026-01-01T12:00:00+00:00', '900', 'Starting balance · sfin-c', NULL);
    `));
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 0 });
    expect(d.createCategory).not.toHaveBeenCalled();
  });

  it('keeps a starting balance unfiled when the person undid its account’s opening filing, and goes on past a refused filing', async () => {
    const path = database(`
      INSERT INTO activities VALUES ('sb', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-01-01T12:00:00+00:00', '80', 'Starting balance · sfin-chk', NULL);
      INSERT INTO activities VALUES ('p1', 'chk', 'TRANSFER_OUT', NULL, NULL, '2026-10-05T12:00:00+00:00', '600', '↔️ In-transit transfer · ZELLE · TRN-1', NULL);
      INSERT INTO activities VALUES ('p2', 'visa', 'WITHDRAWAL', NULL, NULL, '2026-10-06T12:00:00+00:00', '15', '↔️ In-transit transfer · PAYMENT · TRN-2', NULL);
    `);
    const { d } = deps(path, {
      noOpeningFile: (id) => id === 'sfin-chk',
      assign: vi.fn(async (id: string) => { if (id === 'p1') throw new Error('Activity is not in the spending bucket'); }),
    });
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 1, unfiled: 0 });
    expect((d.assign as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['p1', 'p2']);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("Couldn't file p1"));
  });
});
