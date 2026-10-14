import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChangeDraft } from '../../shared/change-entries.js';
import { EXTERNAL_BOOKKEEPING_METADATA } from '../../shared/sync-core.js';
import type { SaveManyRequest, SaveManyResult } from '../../shared/sync-host.js';
import { CARD_REWRITE_BATCH, rewriteCardBookkeeping, type CardRewriteDeps } from './card-bookkeeping-rewrite.js';

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
    INSERT INTO accounts VALUES ('card','Citi','CREDIT_CARD'),('cash','Spend','CASH');
    ${rows}
  `);
  db.close();
  return path;
}
const row = (id: string, notes: string, over: { account?: string; type?: string; group?: string; asset?: string; override?: string; date?: string } = {}) =>
  `INSERT INTO activities VALUES ('${id}','${over.account ?? 'card'}',${over.asset ? `'${over.asset}'` : 'NULL'},'${over.type ?? 'WITHDRAWAL'}',${over.override ? `'${over.override}'` : 'NULL'},'${over.date ?? '2026-04-20T00:00:00+00:00'}','464.6','USD','${notes}',${over.group ? `'${over.group}'` : 'NULL'});`;

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
      id: 'open', accountId: 'card', activityType: 'TRANSFER_OUT', activityDate: '2026-04-20T12:00:00+00:00', amount: 464.6, fee: 0,
      currency: 'USD', comment: 'Starting balance · sfc', metadata: EXTERNAL_BOOKKEEPING_METADATA,
    });
    expect(updates.every((u) => u.symbol === undefined)).toBe(true);
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

  it('stops at a refused batch unmarked, logs what it wrote, and the next sync carries on with what is left', async () => {
    const rows = Array.from({ length: CARD_REWRITE_BATCH + 2 }, (_, i) => row(`plug-${String(i).padStart(3, '0')}`, `Balance adjustment · sfc · day-${i}`)).join('\n');
    const path = ledger(rows);
    let calls = 0;
    const t = deps(path, {
      saveMany: vi.fn(async (req: SaveManyRequest): Promise<SaveManyResult> => {
        calls += 1;
        if (calls === 2) return { created: [], updated: [], errors: [{ action: 'update', message: 'database is locked' }] };
        // What Wealthfolio would now store: rewrite those rows in the file.
        applyAsWealthfolio(path, req);
        return { created: [], updated: [], errors: [] };
      }),
    });
    expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'stopped', rewritten: CARD_REWRITE_BATCH, why: 'update: database is locked' });
    expect(t.marker()).toBeNull();
    expect(t.drafts).toHaveLength(1);
    expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'done', rewritten: 2, left: 0 });
    expect(t.marker()).toBe(NOW.toISOString());
  });

  it('does nothing without the database', async () => {
    const t = deps('/nowhere/wealthfolio.db');
    expect(await rewriteCardBookkeeping(t.d)).toEqual({ kind: 'no-database' });
    expect(t.marker()).toBeNull();
  });
});
