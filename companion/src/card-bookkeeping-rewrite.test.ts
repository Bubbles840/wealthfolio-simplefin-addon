import { describe, it, expect, afterEach, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChangeDraft } from '../../shared/change-entries.js';
import { EXTERNAL_BOOKKEEPING_METADATA } from '../../shared/sync-core.js';
import type { SaveManyRequest, SaveManyResult } from '../../shared/sync-host.js';
import { CARD_REWRITE_BATCH, rewriteCardBookkeeping, type CardRewriteDeps, type RewriteRestRow } from './card-bookkeeping-rewrite.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Wealthfolio's tables, as much of them as the rewrite reads. */
function ledger(rows: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-card-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT);
    CREATE TABLE assets (id TEXT PRIMARY KEY, kind TEXT, name TEXT, display_code TEXT, instrument_symbol TEXT);
    INSERT INTO assets VALUES ('9231cb80-4223-4c04-98e3-dd3b1af60311','INVESTMENT','$CASH','$CASH','$CASH'),
      ('aapl-uuid','INVESTMENT','Apple Inc','AAPL','AAPL'),('$CASH-USD','FX','USD cash','CASH:USD','CASH:USD');
    CREATE TABLE activities (id TEXT PRIMARY KEY, account_id TEXT, asset_id TEXT, activity_type TEXT, activity_type_override TEXT,
      activity_date TEXT, amount TEXT, currency TEXT, notes TEXT, source_group_id TEXT);
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, taxonomy_id TEXT, name TEXT);
    CREATE TABLE activity_taxonomy_assignments (id TEXT PRIMARY KEY, activity_id TEXT, taxonomy_id TEXT, category_id TEXT);
    CREATE TABLE spending_activity_splits (id TEXT PRIMARY KEY, activity_id TEXT, taxonomy_id TEXT, category_id TEXT, amount TEXT);
    INSERT INTO taxonomy_categories VALUES ('c-open','spending_categories','Opening balances'),('c-food','spending_categories','Dining'),('c-sync','spending_categories','Sync bookkeeping');
    INSERT INTO accounts VALUES ('card','Citi','CREDIT_CARD'),('cash','Spend','CASH');
    ${rows}
  `);
  db.close();
  return path;
}
const row = (id: string, notes: string, over: { account?: string; type?: string; group?: string; asset?: string; override?: string; date?: string } = {}) =>
  `INSERT INTO activities VALUES ('${id}','${over.account ?? 'card'}',${over.asset ? `'${over.asset}'` : 'NULL'},'${over.type ?? 'WITHDRAWAL'}',${over.override ? `'${over.override}'` : 'NULL'},'${over.date ?? '2026-04-20T00:00:00+00:00'}','464.6','USD','${notes}',${over.group ? `'${over.group}'` : 'NULL'});`;

/** Wealthfolio's search answer, read from the same file: what is stored NOW. */
function restOf(path: string) {
  return vi.fn(async (ids: string[]): Promise<RewriteRestRow[]> => {
    const db = new DatabaseSync(path);
    try {
      return ids.flatMap((id) => {
        const r = db.prepare(`SELECT id, account_id, activity_type, activity_date, notes, source_group_id FROM activities WHERE id = ?`).get(id) as any;
        return r ? [{ id: r.id, accountId: r.account_id, activityType: r.activity_type, date: r.activity_date, comment: r.notes, sourceGroupId: r.source_group_id }] : [];
      });
    } finally { db.close(); }
  });
}
const sql = (path: string, statement: string) => { const db = new DatabaseSync(path); db.exec(statement); db.close(); };

/** Wealthfolio 3.10's update path: an asset that only names a cash symbol is cleared. */
function applyAsWealthfolio(path: string, req: SaveManyRequest): void {
  const db = new DatabaseSync(path);
  for (const u of req.updates ?? []) {
    db.prepare(`UPDATE activities SET activity_type = ? WHERE id = ?`).run(u.activityType, u.id!);
    if (u.symbol && /^\$?CASH[-_:][A-Z]{3}$/i.test(u.symbol.symbol)) db.prepare(`UPDATE activities SET asset_id = NULL WHERE id = ?`).run(u.id!);
  }
  db.close();
}

function deps(dbPath: string, over: Partial<CardRewriteDeps> = {}) {
  let marker: string | null = null;
  const drafts: ChangeDraft[] = [];
  const d = {
    dbPath,
    wealthfolioVersion: '3.10.0' as string | null,
    marker: { get: vi.fn(async () => marker), set: vi.fn(async (v: string) => { marker = v; }) },
    searchByIds: restOf(dbPath),
    installedAddonVersion: (): string | null => null,
    saveMany: vi.fn(async (_req: SaveManyRequest): Promise<SaveManyResult> => ({ created: [], updated: [], errors: [] })),
    record: vi.fn((draft: ChangeDraft) => { drafts.push(draft); }),
    log: vi.fn(),
    now: NOW,
    ...over,
  };
  return { d, drafts, marker: () => marker };
}

describe('the one-time rewrite of card bookkeeping as transfers out (Wealthfolio 3.10+)', () => {
  it('restates every card bookkeeping WITHDRAWAL as a TRANSFER_OUT marked external, same instant and amount, logs it once, and marks it done', async () => {
    const t = deps(ledger(`
      ${row('open', 'Starting balance · sfc', { date: '2026-04-20T12:00:00+00:00' })}
      ${row('plug', 'Balance adjustment · sfc · 2026-09-02')}
      ${row('held', '↔️ In-transit transfer · BALANCE TRANSFER · tx-bt')}
      ${row('coffee', 'COFFEE SHOP · tx-1')}
      ${row('cash-open', 'Starting balance · sfa', { account: 'cash' })}
    `));
    expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'done', rewritten: 3, left: 0 });
    const updates = t.d.saveMany.mock.calls.flatMap(([req]) => req.updates ?? []);
    expect(updates.map((u) => u.id)).toEqual(['held', 'plug', 'open']);
    expect(updates.find((u) => u.id === 'open')).toEqual({
      id: 'open', accountId: 'card', activityType: 'TRANSFER_OUT', activityDate: '2026-04-20T12:00:00+00:00',
      currency: 'USD', comment: 'Starting balance · sfc', metadata: EXTERNAL_BOOKKEEPING_METADATA,
    });
    expect(updates.every((u) => u.symbol === undefined && !('amount' in u) && !('fee' in u))).toBe(true);
    expect(t.drafts).toEqual([expect.objectContaining({
      kind: 'bookkeeping', actor: 'auto', undoable: false, subject: { activityIds: ['held', 'plug', 'open'] },
      summary: 'Restated 3 card bookkeeping rows as transfers out, which Wealthfolio leaves out of spending',
    })]);
    expect(t.marker()).toBe(NOW.toISOString());
  });

  it('runs once: a second sync reads the marker and writes nothing', async () => {
    const t = deps(ledger(row('open', 'Starting balance · sfc')));
    await rewriteCardBookkeeping(t.d);
    t.d.saveMany.mockClear();
    expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'done-before' });
    expect(t.d.saveMany).not.toHaveBeenCalled();
  });

  it.each([['3.9.1'], [null]])('is off on Wealthfolio %s: nothing written, nothing marked', async (version) => {
    const t = deps(ledger(row('open', 'Starting balance · sfc')), { wealthfolioVersion: version });
    expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'older-host' });
    expect(t.d.saveMany).not.toHaveBeenCalled();
    expect(t.marker()).toBeNull();
  });

  it('leaves a grouped row, a row you retyped, and a row with a real security as they are; rewrites the phantom $CASH asset away — and still finishes', async () => {
    const path = ledger(`
      ${row('linked', '↔️ In-transit transfer · PAYMENT · tx-2', { group: 'grp-1' })}
      ${row('retyped', 'Balance adjustment · sfc · 2026-09-02', { override: 'FEE' })}
      ${row('phantom', 'Balance adjustment · sfc · 2026-09-03', { asset: '9231cb80-4223-4c04-98e3-dd3b1af60311' })}
      ${row('cashsym', 'Balance adjustment · sfc · 2026-09-04', { asset: '$CASH-USD' })}
      ${row('stock', 'Balance adjustment · sfc · 2026-09-05', { asset: 'aapl-uuid' })}
    `);
    const t = deps(path, {
      saveMany: vi.fn(async (req: SaveManyRequest): Promise<SaveManyResult> => {
        applyAsWealthfolio(path, req);
        return { created: [], updated: [], errors: [] };
      }),
    });
    expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'done', rewritten: 2, left: 3 });
    const updates = t.d.saveMany.mock.calls.flatMap(([req]) => req.updates ?? []);
    expect(updates.map((u) => u.id)).toEqual(['cashsym', 'phantom']);
    // The phantom asset is cleared by naming the cash symbol, which 3.10 reads as "no asset"; a row with no real asset sends none.
    expect(updates.find((u) => u.id === 'phantom')!.symbol).toEqual({ symbol: '$CASH-USD' });
    expect(updates.find((u) => u.id === 'cashsym')!.symbol).toBeUndefined();
    expect(t.d.log).toHaveBeenCalledWith('Card bookkeeping rewrite: left linked as a WITHDRAWAL — it is in a transfer group.');
    expect(t.d.log).toHaveBeenCalledWith('Card bookkeeping rewrite: left stock as a WITHDRAWAL — it carries a security (AAPL).');
    const db = new DatabaseSync(path);
    expect(db.prepare(`SELECT id, activity_type, asset_id FROM activities WHERE id IN ('phantom','cashsym','stock') ORDER BY id`).all().map((r: any) => [r.id, r.activity_type, r.asset_id]))
      .toEqual([['cashsym', 'TRANSFER_OUT', '$CASH-USD'], ['phantom', 'TRANSFER_OUT', null], ['stock', 'WITHDRAWAL', 'aapl-uuid']]);
    db.close();
    expect(t.marker()).not.toBeNull();
  });

  it('stops on a TEMPORARY failure (saveMany throws a 5xx) unmarked, logs what it wrote, and the next sync carries on', async () => {
    const rows = Array.from({ length: CARD_REWRITE_BATCH + 2 }, (_, i) => row(`plug-${String(i).padStart(3, '0')}`, `Balance adjustment · sfc · day-${i}`)).join('\n');
    const path = ledger(rows);
    let calls = 0;
    const t = deps(path, {
      saveMany: vi.fn(async (req: SaveManyRequest): Promise<SaveManyResult> => {
        calls += 1;
        if (calls === 2) throw new Error('saveMany failed: 503 - unavailable');
        applyAsWealthfolio(path, req);
        return { created: [], updated: [], errors: [] };
      }),
    });
    expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'stopped', rewritten: CARD_REWRITE_BATCH, why: 'saveMany failed: 503 - unavailable' });
    expect(t.marker()).toBeNull();
    expect(t.drafts).toHaveLength(1);
    expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'done', rewritten: 2, left: 0 });
    expect(t.marker()).toBe(NOW.toISOString());
  });

  it('I1: one row Wealthfolio refuses for good does not lock the run — 52 rows, one refused: 51 rewritten, marked done, the refusal logged and listed', async () => {
    const rows = Array.from({ length: CARD_REWRITE_BATCH + 2 }, (_, i) => row(`plug-${String(i).padStart(3, '0')}`, `Balance adjustment · sfc · day-${i}`)).join('\n');
    const path = ledger(rows);
    const t = deps(path, {
      // 3.10's bulk write is all or nothing.
      saveMany: vi.fn(async (req: SaveManyRequest): Promise<SaveManyResult> => {
        if ((req.updates ?? []).some((u) => u.id === 'plug-003')) return { created: [], updated: [], errors: [{ action: 'update', message: 'Invalid data: plug-003' }] };
        applyAsWealthfolio(path, req);
        return { created: [], updated: [], errors: [] };
      }),
    });
    expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'done', rewritten: CARD_REWRITE_BATCH + 1, left: 1 });
    expect(t.marker()).toBe(NOW.toISOString());
    const sent = t.d.saveMany.mock.calls.map(([req]) => (req.updates ?? []).map((u) => u.id));
    expect(sent.filter((ids) => ids.length === 1 && ids[0] === 'plug-003')).toHaveLength(2); // alone, then once more at the end
    expect(t.d.log).toHaveBeenCalledWith(expect.stringContaining('plug-003'));
    expect(t.d.log).toHaveBeenCalledWith(expect.stringContaining('Invalid data: plug-003'));
    expect(t.drafts).toHaveLength(1);
    expect(t.drafts[0].subject).toEqual({ activityIds: expect.arrayContaining(['plug-000']) });
    expect(t.drafts[0].summary).toContain('plug-003');
    expect((t.drafts[0].after as any).refused).toEqual(['plug-003']);
  });

  it('I1: a thrown 4xx is a refusal of that row; a thrown 5xx, 408, 423 or 429 is temporary and stops the run unmarked', async () => {
    const path = ledger(`${row('a', 'Balance adjustment · sfc · 1')}${row('b', 'Balance adjustment · sfc · 2')}`);
    const refuse = deps(path, {
      saveMany: vi.fn(async (req: SaveManyRequest): Promise<SaveManyResult> => {
        if ((req.updates ?? []).some((u) => u.id === 'a')) throw new Error('saveMany failed: 400 - bad row');
        applyAsWealthfolio(path, req);
        return { created: [], updated: [], errors: [] };
      }),
    });
    expect(await rewriteCardBookkeeping(refuse.d)).toEqual({ kind: 'done', rewritten: 1, left: 1 });
    for (const status of [429, 423, 408, 500]) {
      const p2 = ledger(row('a', 'Balance adjustment · sfc · 1'));
      const t = deps(p2, { saveMany: vi.fn(async () => { throw new Error(`saveMany failed: ${status}`); }) });
      expect(await rewriteCardBookkeeping(t.d)).toMatchObject({ kind: 'stopped', rewritten: 0 });
      expect(t.marker()).toBeNull();
    }
  });

  it('M6: marker.set rejecting — the rows are written and logged, and the next run marks it done', async () => {
    const path = ledger(row('a', 'Balance adjustment · sfc · 1'));
    let stored: string | null = null;
    let fail = true;
    const t = deps(path, {
      marker: { get: async () => stored, set: async (v: string) => { if (fail) throw new Error('secret store down'); stored = v; } },
      saveMany: vi.fn(async (req: SaveManyRequest): Promise<SaveManyResult> => { applyAsWealthfolio(path, req); return { created: [], updated: [], errors: [] }; }),
    });
    expect(await rewriteCardBookkeeping(t.d)).toMatchObject({ kind: 'stopped', rewritten: 1 });
    expect(t.drafts).toHaveLength(1);
    fail = false;
    expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'done', rewritten: 0, left: 0 });
    expect(stored).toBe(NOW.toISOString());
  });

  it('I2b: a row changed since the database read is written from the REST row — its fresh instant and note — and one that is no longer bookkeeping is dropped', async () => {
    const path = ledger(`${row('moved', 'Balance adjustment · sfc · 2026-09-02')}${row('gone', 'Balance adjustment · sfc · 2026-09-03')}${row('linked', 'Balance adjustment · sfc · 2026-09-04')}${row('retyped', 'Balance adjustment · sfc · 2026-09-05')}`);
    const rest = restOf(path);
    const t = deps(path, {
      // Between the database read and the batch, Wealthfolio's rows move on.
      searchByIds: vi.fn(async (ids: string[]) => {
        sql(path, `UPDATE activities SET activity_date = '2026-05-01T09:30:00+00:00', notes = 'Balance adjustment · sfc · edited' WHERE id = 'moved';
          UPDATE activities SET notes = 'my own note' WHERE id = 'gone';
          UPDATE activities SET source_group_id = 'g-9' WHERE id = 'linked';
          UPDATE activities SET activity_type = 'WITHDRAWAL', notes = notes WHERE id = 'retyped';`);
        const out = await rest(ids);
        return out.map((r) => (r.id === 'retyped' ? { ...r, activityType: 'FEE' } : r));
      }),
    });
    expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'done', rewritten: 1, left: 3 });
    expect(t.d.saveMany.mock.calls.flatMap(([req]) => req.updates ?? [])).toEqual([
      expect.objectContaining({ id: 'moved', activityDate: '2026-05-01T09:30:00+00:00', comment: 'Balance adjustment · sfc · edited' }),
    ]);
    expect(t.d.log).toHaveBeenCalledWith(expect.stringContaining('gone'));
  });

  it('I2a: with no live read (only the immutable snapshot opens) it does nothing, says so, and marks nothing', async () => {
    const path = ledger(row('open', 'Starting balance · sfc'));
    // A WAL-mode database in a read-only directory: no live read can attach its shared memory,
    // but the immutable form opens (and would serve a stale snapshot).
    sql(path, 'PRAGMA journal_mode=WAL');
    chmodSync(dirname(path), 0o555);
    const probe = new DatabaseSync(`file:${path}?immutable=1`);
    expect(probe.prepare('SELECT COUNT(*) n FROM activities').get()).toEqual({ n: 1 });
    probe.close();
    const t = deps(path);
    try {
      expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'no-database' });
      expect(t.d.saveMany).not.toHaveBeenCalled();
      expect(t.marker()).toBeNull();
      expect(t.d.log).toHaveBeenCalledWith('Card bookkeeping rewrite waits for a live database read.');
    } finally {
      chmodSync(dirname(path), 0o755);
    }
  });

  it('M2: waits while the installed add-on is older than 1.62.0; an absent or unreadable one runs', async () => {
    const path = ledger(row('open', 'Starting balance · sfc'));
    const old = deps(path, { installedAddonVersion: () => '1.61.0' });
    expect(await rewriteCardBookkeeping(old.d)).toEqual({ kind: 'old-addon' });
    expect(old.d.saveMany).not.toHaveBeenCalled();
    expect(old.marker()).toBeNull();
    expect(old.d.log).toHaveBeenCalledWith('Card bookkeeping rewrite waits for the 1.62 add-on.');
    const current = deps(path, { installedAddonVersion: () => '1.62.0' });
    expect(await rewriteCardBookkeeping(current.d)).toMatchObject({ kind: 'done', rewritten: 1 });
    const unknown = deps(ledger(row('open', 'Starting balance · sfc')), { installedAddonVersion: () => null });
    expect(await rewriteCardBookkeeping(unknown.d)).toMatchObject({ kind: 'done', rewritten: 1 });
  });

  it("M3: respects the person's choices — a starting balance under noOpeningFile and a row with a filing the sync did not make are left, logged", async () => {
    const path = ledger(`
      ${row('open-no', 'Starting balance · sfn')}
      ${row('open-ok', 'Starting balance · sfc')}
      ${row('mine', 'Balance adjustment · sfc · 2026-09-02')}
      ${row('ours', 'Balance adjustment · sfc · 2026-09-03')}
      INSERT INTO activity_taxonomy_assignments VALUES ('x1','mine','spending_categories','c-food'),('x2','ours','spending_categories','c-open');
    `);
    const t = deps(path, { noOpeningFile: (id: string) => id === 'sfn' });
    expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'done', rewritten: 2, left: 2 });
    expect(t.d.saveMany.mock.calls.flatMap(([req]) => req.updates ?? []).map((u) => u.id).sort()).toEqual(['open-ok', 'ours']);
    expect(t.d.log).toHaveBeenCalledWith(expect.stringContaining('left open-no'));
    expect(t.d.log).toHaveBeenCalledWith(expect.stringContaining('left mine'));
  });

  it('M4: a row with spending split lines is left (3.10 deletes them on a type change), logged', async () => {
    const path = ledger(`${row('split', 'Balance adjustment · sfc · 2026-09-02')}${row('plain', 'Balance adjustment · sfc · 2026-09-03')}
      INSERT INTO spending_activity_splits VALUES ('s1','split','spending_categories','c-food','5');`);
    const t = deps(path);
    expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'done', rewritten: 1, left: 1 });
    expect(t.d.log).toHaveBeenCalledWith(expect.stringContaining('left split'));
  });

  it('does nothing without the database, and says so', async () => {
    const t = deps('/nowhere/wealthfolio.db');
    expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'no-database' });
    expect(t.marker()).toBeNull();
    expect(t.d.log).toHaveBeenCalledWith(expect.stringContaining('no Wealthfolio database'));
  });
});
