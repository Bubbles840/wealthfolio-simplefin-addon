import { describe, it, expect, vi, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileSyncBookkeeping, withoutSyncBookkeeping, type BookkeepingFilingDeps } from './bookkeeping-category.js';
import { SYNC_BOOKKEEPING_DESCRIPTION } from '../../shared/bookkeeping-filing.js';
import type { FiledState } from '../../shared/bookkeeping-filing.js';
import type { ChangeDraft } from '../../shared/change-entries.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) { try { chmodSync(d, 0o755); } catch { /* gone */ } rmSync(d, { recursive: true, force: true }); } });

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
    CREATE TABLE spending_activity_splits (id TEXT PRIMARY KEY, activity_id TEXT, taxonomy_id TEXT, category_id TEXT, amount TEXT, sort_order INTEGER);
    INSERT INTO accounts VALUES ('chk', 'PNC Checking', 'CASH', 0), ('visa', 'Visa', 'CREDIT_CARD', 0), ('sav', 'Savings', 'CASH', 0);
    INSERT INTO app_settings VALUES ('spending.enabled', 'true'), ('spending.account_ids', '["chk","visa"]');
    INSERT INTO taxonomy_categories VALUES ('cat-gro', 'spending_categories', 'Groceries', NULL), ('cat-open', 'spending_categories', 'Opening balances', NULL);
    ${settings}
    ${rows}
  `);
  db.close();
  return path;
}

function deps(dbPath: string, over: Partial<BookkeepingFilingDeps> = {}, remembered: FiledState | 'corrupt' = { categoryId: null, ids: [] }) {
  const recorded: ChangeDraft[] = [];
  const saved: FiledState[] = [];
  const d: BookkeepingFilingDeps = {
    dbPath,
    createCategory: vi.fn(async () => 'cat-sync-new'),
    setExcluded: vi.fn(async () => {}),
    assign: vi.fn(async () => {}),
    unassign: vi.fn(async () => {}),
    appVersion: vi.fn(async () => '3.10.0'),
    // Wealthfolio's own list, read right before each PUT (here: the database's).
    readExcluded: vi.fn(async () => liveExcluded(dbPath)),
    loadFiled: vi.fn(async () => remembered),
    saveFiled: vi.fn(async (state: FiledState) => { saved.push(state); }),
    record: (draft) => { recorded.push(draft); },
    log: vi.fn(),
    ...over,
  };
  return { d, recorded, saved };
}

function liveExcluded(path: string): string[] {
  const db = new DatabaseSync(path);
  try {
    const r = db.prepare(`SELECT setting_value v FROM app_settings WHERE setting_key = 'spending.excluded_category_ids'`).get() as { v: string } | undefined;
    return r ? JSON.parse(r.v) : [];
  } finally { db.close(); }
}
function write(path: string, sql: string) { const db = new DatabaseSync(path); db.exec(sql); db.close(); }

const PLACEHOLDER = `INSERT INTO activities VALUES ('ph', 'chk', 'TRANSFER_OUT', NULL, NULL, '2026-10-05T12:00:00+00:00', '600', '↔️ In-transit transfer · ZELLE · TRN-1', NULL);`;

describe('fileSyncBookkeeping', () => {
  it('files a placeholder under a new "Sync bookkeeping", excludes the category from spending, and logs one entry', async () => {
    const { d, recorded } = deps(database(PLACEHOLDER, `INSERT INTO app_settings VALUES ('spending.excluded_category_ids', '["cat-mine"]');`));
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 1, unfiled: 0 });
    expect(d.createCategory).toHaveBeenCalledWith('Sync bookkeeping', SYNC_BOOKKEEPING_DESCRIPTION);
    // Appended to the person's own exclusions, never replacing them.
    expect(d.setExcluded).toHaveBeenCalledWith(['cat-mine', 'cat-sync-new']);
    expect(d.assign).toHaveBeenCalledWith('ph', 'cat-sync-new');
    // M2: a set-up entry for the create and the exclusion, then the pass's own.
    expect(recorded).toEqual([
      expect.objectContaining({ kind: 'bookkeeping', after: expect.objectContaining({ step: 'sync-bookkeeping-setup' }) }),
      expect.objectContaining({ kind: 'bookkeeping', after: expect.objectContaining({ step: 'sync-bookkeeping', count: 1, unfiled: 0 }) }),
    ]);
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
    const { d, recorded, saved } = deps(path, {}, { categoryId: 'cat-sync', ids: ['expired', 'done'] });
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 1 });
    expect(d.unassign).toHaveBeenCalledWith('expired');
    expect(saved).toEqual([{ categoryId: 'cat-sync', ids: ['done'] }]);
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

  it('C1: a placeholder the person split is never filed — assigning would erase the split', async () => {
    const path = database(PLACEHOLDER, `INSERT INTO spending_activity_splits VALUES ('s1', 'ph', 'spending_categories', 'cat-gro', '400', 0), ('s2', 'ph', 'spending_categories', 'cat-open', '200', 1);`);
    const { d } = deps(path);
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 0 });
    expect(d.assign).not.toHaveBeenCalled();
    expect(d.createCategory).not.toHaveBeenCalled();
  });

  it('I1: a manual or rule filing under the category is left alone; the pass’s own is taken out, and forgotten', async () => {
    const path = database(`
      INSERT INTO taxonomy_categories VALUES ('cat-sync', 'spending_categories', 'Sync bookkeeping', NULL);
      INSERT INTO activities VALUES ('manual', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-10-05T12:00:00+00:00', '25', 'KROGER · TRN-9', NULL);
      INSERT INTO activities VALUES ('rule', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-10-05T12:00:00+00:00', '12', 'SHELL · TRN-8', NULL);
      INSERT INTO activities VALUES ('mine', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-10-05T12:00:00+00:00', '40', 'ZELLE TO MOM · TRN-2', NULL);
      INSERT INTO activity_taxonomy_assignments VALUES
        ('f1', 'manual', 'spending_categories', 'cat-sync', 'manual', '2026-10-05T13:00:00Z'),
        ('f2', 'rule', 'spending_categories', 'cat-sync', 'rule', '2026-10-05T13:00:00Z'),
        ('f3', 'mine', 'spending_categories', 'cat-sync', 'manual', '2026-10-05T13:00:00Z');
    `, `INSERT INTO app_settings VALUES ('spending.excluded_category_ids', '["cat-sync"]');`);
    const { d, saved } = deps(path, {}, { categoryId: 'cat-sync', ids: ['mine', 'long-gone'] });
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 1 });
    expect((d.unassign as ReturnType<typeof vi.fn>).mock.calls).toEqual([['mine']]);
    // 'mine' is unfiled and 'long-gone' no longer exists: both forgotten.
    expect(saved.at(-1)).toEqual({ categoryId: 'cat-sync', ids: [] });
  });

  it('I1: a corrupt memory means nothing is filed, nothing is taken out and it is never overwritten', async () => {
    const { d, saved } = deps(database(PLACEHOLDER), {}, 'corrupt');
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 0 });
    expect(d.assign).not.toHaveBeenCalled();
    expect(d.unassign).not.toHaveBeenCalled();
    expect(d.createCategory).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('sync_bookkeeping_filed'));
  });

  it('I1: what it files is remembered, with the category', async () => {
    const { d, saved } = deps(database(PLACEHOLDER));
    await fileSyncBookkeeping(d);
    expect(saved.at(-1)).toEqual({ categoryId: 'cat-sync-new', ids: ['ph'] });
  });

  it('I1: a re-created category forgets ids remembered for the old one (their filings cascaded away)', async () => {
    const { d, saved } = deps(database(PLACEHOLDER), {}, { categoryId: 'cat-deleted', ids: ['ph'] });
    await fileSyncBookkeeping(d);
    expect(saved.at(-1)).toEqual({ categoryId: 'cat-sync-new', ids: ['ph'] });
    expect(d.assign).toHaveBeenCalledWith('ph', 'cat-sync-new');
  });

  it('I2: a real WAL database on a mount where only a snapshot is possible (0555 directory, no -wal/-shm) is left alone', async () => {
    const path = database(PLACEHOLDER);
    write(path, 'PRAGMA journal_mode=WAL;');   // closed again: checkpointed, -wal/-shm gone, the header says WAL
    chmodSync(join(path, '..'), 0o555);
    const { d } = deps(path);
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 0 });
    expect(d.log).toHaveBeenCalledWith('Bookkeeping filing waits: the database can only be read as a snapshot');
    expect(d.createCategory).not.toHaveBeenCalled();
    expect(d.assign).not.toHaveBeenCalled();
  });

  it('I2: a file that is not a database at all is logged as unreadable, not as a snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfin-bk-'));
    made.push(dir);
    const path = join(dir, 'wealthfolio.db');
    writeFileSync(path, 'not a database');
    const { d } = deps(path);
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 0 });
    expect(d.log).toHaveBeenCalledWith("Bookkeeping filing skipped: couldn't read the database");
  });

  it('m5: a missing database file logs one line', async () => {
    const { d } = deps(join(tmpdir(), 'sfin-bk-definitely-missing', 'wealthfolio.db'));
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 0 });
    expect(d.log).toHaveBeenCalledTimes(1);
    expect(d.log).toHaveBeenCalledWith("Bookkeeping filing skipped: the database file isn't there");
  });

  it('I3: the exclusions are Wealthfolio’s live list, read right before the PUT — another writer’s exclusion is kept', async () => {
    const { d } = deps(database(PLACEHOLDER, `INSERT INTO app_settings VALUES ('spending.excluded_category_ids', '["stale"]');`), {
      readExcluded: vi.fn(async () => ['cat-open', 'cat-mine']),
    });
    await fileSyncBookkeeping(d);
    expect(d.setExcluded).toHaveBeenCalledWith(['cat-open', 'cat-mine', 'cat-sync-new']);
  });

  it('I3: each row is re-read just before its write — one the person filed meanwhile is not overwritten', async () => {
    const path = database(`
      INSERT INTO activities VALUES ('p1', 'chk', 'TRANSFER_OUT', NULL, NULL, '2026-10-05T12:00:00+00:00', '60', '↔️ In-transit transfer · VENMO · TRN-1', NULL);
      INSERT INTO activities VALUES ('p2', 'chk', 'TRANSFER_OUT', NULL, NULL, '2026-10-06T12:00:00+00:00', '61', '↔️ In-transit transfer · VENMO · TRN-2', NULL);
      INSERT INTO activities VALUES ('p3', 'chk', 'TRANSFER_OUT', NULL, NULL, '2026-10-07T12:00:00+00:00', '62', '↔️ In-transit transfer · VENMO · TRN-3', NULL);
    `);
    const { d } = deps(path);
    d.assign = vi.fn(async (id: string) => {
      if (id === 'p1') write(path, `
        INSERT INTO activity_taxonomy_assignments VALUES ('h', 'p2', 'spending_categories', 'cat-gro', 'manual', '2026-10-05T13:00:00Z');
        INSERT INTO spending_activity_splits VALUES ('s', 'p3', 'spending_categories', 'cat-gro', '62', 0);`);
    });
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 1, unfiled: 0 });
    expect((d.assign as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['p1']);
  });

  it('I3: a row the person filed elsewhere before it is taken out is not unassigned', async () => {
    const path = database(`
      INSERT INTO taxonomy_categories VALUES ('cat-sync', 'spending_categories', 'Sync bookkeeping', NULL);
      INSERT INTO activities VALUES ('e1', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-09-20T12:00:00+00:00', '40', 'ZELLE · TRN-2', NULL);
      INSERT INTO activities VALUES ('e2', 'chk', 'WITHDRAWAL', NULL, NULL, '2026-09-21T12:00:00+00:00', '41', 'ZELLE · TRN-3', NULL);
      INSERT INTO activity_taxonomy_assignments VALUES
        ('f1', 'e1', 'spending_categories', 'cat-sync', 'manual', '2026-09-20T13:00:00Z'),
        ('f2', 'e2', 'spending_categories', 'cat-sync', 'manual', '2026-09-21T13:00:00Z');
    `, `INSERT INTO app_settings VALUES ('spending.excluded_category_ids', '["cat-sync"]');`);
    const { d } = deps(path, {}, { categoryId: 'cat-sync', ids: ['e1', 'e2'] });
    d.unassign = vi.fn(async (id: string) => {
      if (id === 'e1') write(path, `UPDATE activity_taxonomy_assignments SET category_id = 'cat-gro' WHERE activity_id = 'e2';`);
    });
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 1 });
  });

  it('M1: an unreadable database is logged, not silent', async () => {
    const path = database(PLACEHOLDER);
    write(path, 'DROP TABLE activity_taxonomy_assignments;');
    const { d } = deps(path);
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 0 });
    expect(d.log).toHaveBeenCalledWith("Bookkeeping filing skipped: couldn't read the database");
  });

  it('M2: a setup entry is written when the category was made or its exclusion re-added, even if every filing then fails', async () => {
    const { d, recorded } = deps(database(PLACEHOLDER), { assign: vi.fn(async () => { throw new Error('refused'); }) });
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 0 });
    expect(recorded.map((r) => r.after)).toEqual([expect.objectContaining({ step: 'sync-bookkeeping-setup', categoryName: 'Sync bookkeeping' })]);

    const again = deps(database(`INSERT INTO taxonomy_categories VALUES ('cat-sync', 'spending_categories', 'Sync bookkeeping', NULL);\n${PLACEHOLDER}`),
      { assign: vi.fn(async () => { throw new Error('refused'); }) }, { categoryId: 'cat-sync', ids: [] });
    await fileSyncBookkeeping(again.d);
    expect(again.d.setExcluded).toHaveBeenCalledWith(['cat-sync']);
    expect(again.recorded.map((r) => r.after)).toEqual([expect.objectContaining({ step: 'sync-bookkeeping-setup' })]);
  });

  it('M5: setExcluded refused — nothing is filed under a category that is not excluded, and the create is still logged', async () => {
    const { d, recorded } = deps(database(PLACEHOLDER), { setExcluded: vi.fn(async () => { throw new Error('500'); }) });
    await expect(fileSyncBookkeeping(d)).rejects.toThrow('500');
    expect(d.assign).not.toHaveBeenCalled();
    expect(recorded.map((r) => r.after)).toEqual([expect.objectContaining({ step: 'sync-bookkeeping-setup' })]);
  });

  it('M3: below 3.10 a blank (not null) type override is skipped — 3.9 reads it as a type and refuses the filing', async () => {
    const path = database(`INSERT INTO activities VALUES ('blank', 'chk', 'TRANSFER_OUT', '', NULL, '2026-10-05T12:00:00+00:00', '600', '↔️ In-transit transfer · ZELLE · TRN-1', NULL);`);
    const old = deps(path, { appVersion: vi.fn(async () => '3.9.0') });
    expect(await fileSyncBookkeeping(old.d)).toEqual({ filed: 0, unfiled: 0 });
    expect(old.d.assign).not.toHaveBeenCalled();
    const current = deps(path);
    expect(await fileSyncBookkeeping(current.d)).toEqual({ filed: 1, unfiled: 0 });
  });

  it('M5: re-created linked rows carry no filing and are never filed; the old row’s id is forgotten', async () => {
    const path = database(`
      INSERT INTO taxonomy_categories VALUES ('cat-sync', 'spending_categories', 'Sync bookkeeping', NULL);
      INSERT INTO activities VALUES ('pla', 'chk', 'TRANSFER_OUT', NULL, NULL, '2026-10-11T12:00:00+00:00', '250', 'TO ALLY · TRN-PL', 'g-PL');
      INSERT INTO activities VALUES ('plb', 'sav', 'TRANSFER_IN', NULL, NULL, '2026-10-11T12:00:00+00:00', '250', 'FROM PNC · TRN-PLb', 'g-PL');
    `, `INSERT INTO app_settings VALUES ('spending.excluded_category_ids', '["cat-sync"]');`);
    const { d, saved } = deps(path, {}, { categoryId: 'cat-sync', ids: ['pl-old'] });
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 0 });
    expect(d.assign).not.toHaveBeenCalled();
    expect(saved.at(-1)).toEqual({ categoryId: 'cat-sync', ids: [] });
  });

  it('M6: the category is found by the remembered id first — a rename keeps working; duplicates use the remembered one', async () => {
    const path = database(`
      INSERT INTO taxonomy_categories VALUES ('cat-renamed', 'spending_categories', 'Plumbing', NULL);
      INSERT INTO taxonomy_categories VALUES ('cat-dupe', 'spending_categories', 'Sync bookkeeping', NULL);
      ${PLACEHOLDER}
    `, `INSERT INTO app_settings VALUES ('spending.excluded_category_ids', '["cat-renamed","cat-dupe"]');`);
    const { d } = deps(path, {}, { categoryId: 'cat-renamed', ids: [] });
    await fileSyncBookkeeping(d);
    expect(d.createCategory).not.toHaveBeenCalled();
    expect(d.assign).toHaveBeenCalledWith('ph', 'cat-renamed');
  });

  // The remembered rows must survive a failed save, a restart and an account that leaves Spending.
  const EXPIRE = `UPDATE activities SET activity_type = 'WITHDRAWAL', notes = 'ZELLE TO MOM · TRN-1' WHERE id = 'ph';`;
  const assignWrites = (path: string) => vi.fn(async (id: string, cat: string) => {
    write(path, `INSERT INTO activity_taxonomy_assignments VALUES ('a-${id}', '${id}', 'spending_categories', '${cat}', 'manual', '2026-10-05T13:00:00Z');`);
  });

  it('I-1 (S16): the rows are saved BEFORE they are filed — a failed final save, or a restart, still knows them', async () => {
    const path = database(PLACEHOLDER);
    const order: string[] = [];
    const saves: FiledState[] = [];
    const first = deps(path, {
      assign: vi.fn(async (id: string, cat: string) => { order.push('assign'); await assignWrites(path)(id, cat); }),
      saveFiled: vi.fn(async (state: FiledState) => { order.push('save'); saves.push(state); if (order.filter((o) => o === 'save').length > 1) throw new Error('disk full'); }),
    });
    expect(await fileSyncBookkeeping(first.d)).toEqual({ filed: 1, unfiled: 0 });
    expect(order).toEqual(['save', 'assign', 'save']);
    expect(saves[0]).toEqual({ categoryId: 'cat-sync-new', ids: ['ph'] });
    // Next run: the placeholder expired; the first run's memory (from before the writes) still names it.
    write(path, EXPIRE);
    write(path, `INSERT INTO taxonomy_categories VALUES ('cat-sync-new', 'spending_categories', 'Sync bookkeeping', NULL); INSERT INTO app_settings VALUES ('spending.excluded_category_ids', '["cat-sync-new"]');`);
    const second = deps(path, {}, saves[0]);
    expect(await fileSyncBookkeeping(second.d)).toEqual({ filed: 0, unfiled: 1 });
    expect(second.d.unassign).toHaveBeenCalledWith('ph');
  });

  it('I-1: if the rows cannot be remembered first, nothing is filed', async () => {
    const { d } = deps(database(PLACEHOLDER), { saveFiled: vi.fn(async () => { throw new Error('disk full'); }) });
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 0 });
    expect(d.assign).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("couldn't remember the rows before filing them"));
  });

  it('I-1 (S14): an account that leaves Spending for one sync does not make the pass forget its rows', async () => {
    const path = database(PLACEHOLDER);
    const first = deps(path, { assign: assignWrites(path) });
    await fileSyncBookkeeping(first.d);
    const memory = first.saved.at(-1)!;
    expect(memory.ids).toEqual(['ph']);
    write(path, `INSERT INTO taxonomy_categories VALUES ('cat-sync-new', 'spending_categories', 'Sync bookkeeping', NULL);`);   // what the real create made
    // The person takes the checking account out of Spending for a sync…
    write(path, `UPDATE app_settings SET setting_value = '["visa"]' WHERE setting_key = 'spending.account_ids'; ${EXPIRE}`);
    const away = deps(path, {}, memory);
    expect(await fileSyncBookkeeping(away.d)).toEqual({ filed: 0, unfiled: 0 });
    const kept = away.saved.at(-1) ?? memory;
    expect(kept.ids).toEqual(['ph']);
    // …and puts it back: the expired row is taken out.
    write(path, `UPDATE app_settings SET setting_value = '["chk","visa"]' WHERE setting_key = 'spending.account_ids';`);
    const back = deps(path, {}, kept);
    expect(await fileSyncBookkeeping(back.d)).toEqual({ filed: 0, unfiled: 1 });
    expect(back.d.unassign).toHaveBeenCalledWith('ph');
  });

  it('m1 (S17): a whitespace-only override is blank too — skipped below 3.10, not refused forever', async () => {
    const path = database(`INSERT INTO activities VALUES ('ws', 'chk', 'TRANSFER_OUT', '  ', NULL, '2026-10-05T12:00:00+00:00', '600', '↔️ In-transit transfer · ZELLE · TRN-1', NULL);`);
    const old = deps(path, { appVersion: vi.fn(async () => '3.9.0') });
    expect(await fileSyncBookkeeping(old.d)).toEqual({ filed: 0, unfiled: 0 });
    expect(old.d.assign).not.toHaveBeenCalled();
  });

  it('M-5: with nothing to file or take out, a category dropped from the exclusion list (an upgrade, a reset) is excluded again — after reading the list', async () => {
    const path = database(`INSERT INTO taxonomy_categories VALUES ('cat-sync', 'spending_categories', 'Sync bookkeeping', NULL);`,
      `INSERT INTO app_settings VALUES ('spending.excluded_category_ids', '["cat-mine"]');`);
    const { d, recorded } = deps(path, {}, { categoryId: 'cat-sync', ids: [] });
    expect(await fileSyncBookkeeping(d)).toEqual({ filed: 0, unfiled: 0 });
    expect(d.readExcluded).toHaveBeenCalled();
    expect(d.setExcluded).toHaveBeenCalledWith(['cat-mine', 'cat-sync']);
    expect(d.createCategory).not.toHaveBeenCalled();
    expect(recorded).toEqual([expect.objectContaining({ after: expect.objectContaining({ step: 'sync-bookkeeping-setup' }) })]);
    // Already excluded: nothing is written.
    const again = deps(database(`INSERT INTO taxonomy_categories VALUES ('cat-sync', 'spending_categories', 'Sync bookkeeping', NULL);`,
      `INSERT INTO app_settings VALUES ('spending.excluded_category_ids', '["cat-sync"]');`), {}, { categoryId: 'cat-sync', ids: [] });
    await fileSyncBookkeeping(again.d);
    expect(again.d.setExcluded).not.toHaveBeenCalled();
    // No category at all: nothing is created for nothing.
    const none = deps(database(''));
    await fileSyncBookkeeping(none.d);
    expect(none.d.createCategory).not.toHaveBeenCalled();
    expect(none.d.setExcluded).not.toHaveBeenCalled();
  });

  it('m4: the set-up entry has its own step and says only what happened', async () => {
    const ok = deps(database(PLACEHOLDER));
    await fileSyncBookkeeping(ok.d);
    expect(ok.recorded[0]).toMatchObject({ after: { step: 'sync-bookkeeping-setup' }, summary: 'Set up the "Sync bookkeeping" category and kept it out of spending' });
    const refused = deps(database(PLACEHOLDER), { setExcluded: vi.fn(async () => { throw new Error('500'); }) });
    await expect(fileSyncBookkeeping(refused.d)).rejects.toThrow('500');
    expect(refused.recorded[0]).toMatchObject({ after: { step: 'sync-bookkeeping-setup' }, summary: 'Set up the "Sync bookkeeping" category, but Wealthfolio didn\'t exclude it yet' });
  });

  it('m3: the pickers’ category lists drop "Sync bookkeeping"', () => {
    expect(withoutSyncBookkeeping([{ name: 'Groceries' }, { name: 'Sync bookkeeping' }])).toEqual([{ name: 'Groceries' }]);
  });
});
