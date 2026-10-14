import { describe, it, expect, vi } from 'vitest';
import { SKIPPED_TRANSACTIONS_SECRET_KEY } from '../../shared/skipped-transactions';
import {
  removalFingerprint, REMOVE_DONE, REMOVE_NOT_FEED, REMOVE_SKIP_UNREADABLE, REMOVE_UNLINK_FIRST,
} from '../../shared/tx-remove';
import { removeFromApp, type FixStore } from './audit-fix';
import { beginLink, beginSync, LINK_BUSY, REMOVE_BUSY, REMOVE_SYNC_RUNNING } from './write-lock';
import { linkFromApp } from './audit-fix';
import { REMOVE_UNLINK_FIRST as UNLINK_FIRST } from '../../shared/tx-remove';

type Row = Record<string, unknown> & { id: string; accountId: string };
const DUP: Row = {
  id: 'dup-1', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'DEPOSIT', date: '2026-10-09T00:00:00.000Z', amount: '600',
  currency: 'USD', comment: 'MOBILE DEPOSIT · TRN-600', metadata: null,
};
const shown = (r: Row) => removalFingerprint({
  activityId: r.id, note: String(r.comment), absCents: 60000, date: '2026-10-09', activityType: String(r.activityType), accountName: 'PNC Checking',
});

/** The add-on SDK, in memory: the exact-id search, accounts, the bulk endpoint and the add-on's secrets. */
function fakeCtx(rows: Row[], secrets: Record<string, string> = {}) {
  const data = new Map(Object.entries(secrets));
  const ctx = {
    api: {
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', accountType: 'CASH' }]) },
      activities: {
        search: vi.fn(async (_page: number, _size: number, filters: { activityIds?: string[] }) => ({
          data: rows.filter((r) => filters.activityIds?.includes(r.id)), meta: { totalRowCount: 0 },
        })),
        saveMany: vi.fn(async () => ({ created: [], updated: [], errors: [] })),
      },
      secrets: {
        get: vi.fn(async (k: string) => data.get(k) ?? null),
        set: vi.fn(async (k: string, v: string) => { data.set(k, v); }),
      },
    },
  };
  return { ctx: ctx as any, data };
}
const fakeStore = (over: FixStore = {}): FixStore & Record<string, any> => ({
  getAccountMapping: vi.fn(async () => ({ 'sfin-chk': 'wf-chk' })),
  getLinkedGroups: vi.fn(async () => ({})),
  recordChange: vi.fn(async () => {}),
  ...over,
});

describe('Remove for good from the app', () => {
  it('skips it in the add-on’s secrets, deletes it through the SDK, and records it as yours', async () => {
    const f = fakeCtx([DUP]);
    const store = fakeStore();
    expect(await removeFromApp(f.ctx, store, 'dup-1', shown(DUP))).toEqual({ ok: true, message: REMOVE_DONE });
    expect(f.ctx.api.activities.search).toHaveBeenCalledWith(0, 1, { activityIds: ['dup-1'] }, '');
    expect(JSON.parse(f.data.get(SKIPPED_TRANSACTIONS_SECRET_KEY)!)).toEqual([expect.objectContaining({ account: 'sfin-chk', txId: 'TRN-600' })]);
    expect(f.ctx.api.activities.saveMany).toHaveBeenCalledWith({ deleteIds: ['dup-1'] });
    expect(store.recordChange).toHaveBeenCalledWith(expect.objectContaining({ actor: 'you', kind: 'transaction-removed' }));
  });

  it('refuses a transfer leg it cannot rule out as linked, and a row its ledger knows', async () => {
    const leg = { ...DUP, activityType: 'TRANSFER_OUT' };
    const f = fakeCtx([leg]);
    expect(await removeFromApp(f.ctx, fakeStore(), 'dup-1', shown(leg))).toEqual({ ok: false, message: REMOVE_UNLINK_FIRST });
    const g = fakeCtx([DUP]);
    expect(await removeFromApp(g.ctx, fakeStore({ getLinkedGroups: vi.fn(async () => ({ 'sfin-chk\u0000TRN-600': 'wf-transfer-1' })) }), 'dup-1', shown(DUP)))
      .toEqual({ ok: false, message: REMOVE_UNLINK_FIRST });
    expect(f.ctx.api.activities.saveMany).not.toHaveBeenCalled();
    expect(g.ctx.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it('refuses a row in an account no feed maps to', async () => {
    const f = fakeCtx([DUP]);
    expect(await removeFromApp(f.ctx, fakeStore({ getAccountMapping: vi.fn(async () => ({ 'sfin-x': 'wf-other' })) }), 'dup-1', shown(DUP)))
      .toEqual({ ok: false, message: REMOVE_NOT_FEED });
  });

  it('deletes nothing when the skip list is corrupt', async () => {
    const f = fakeCtx([DUP], { [SKIPPED_TRANSACTIONS_SECRET_KEY]: '[{"account":1}]' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await removeFromApp(f.ctx, fakeStore(), 'dup-1', shown(DUP))).toEqual({ ok: false, message: REMOVE_SKIP_UNREADABLE });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Remove dup-1: the skip list was not saved'));
    warn.mockRestore();
    expect(f.ctx.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it('refuses while a sync holds the add-on write lock, and writes nothing', async () => {
    const f = fakeCtx([DUP]);
    const store = fakeStore();
    const endSync = await beginSync();
    try {
      expect(await removeFromApp(f.ctx, store, 'dup-1', shown(DUP))).toEqual({ ok: false, message: REMOVE_SYNC_RUNNING });
    } finally {
      endSync();
    }
    expect(REMOVE_SYNC_RUNNING).toBe('A sync is running — try again when it finishes.');
    expect(f.ctx.api.activities.search).not.toHaveBeenCalled();
    expect(f.ctx.api.activities.saveMany).not.toHaveBeenCalled();
    expect(f.data.size).toBe(0);
    expect(store.recordChange).not.toHaveBeenCalled();
  });

  it('holds the same lock as Link while it runs: a sync that starts waits, and Link is refused', async () => {
    const f = fakeCtx([DUP]);
    let release!: () => void;
    f.ctx.api.activities.saveMany = vi.fn(() => new Promise((resolve) => { release = () => resolve({ created: [], updated: [], errors: [] }); }));
    const run = removeFromApp(f.ctx, fakeStore(), 'dup-1', shown(DUP));
    await vi.waitFor(() => expect(f.ctx.api.activities.saveMany).toHaveBeenCalled());
    expect(beginLink()).toBeNull();
    let syncStarted = false;
    const sync = beginSync().then((end) => { syncStarted = true; return end; });
    await new Promise((r) => setTimeout(r, 10));
    expect(syncStarted).toBe(false);
    release();
    expect(await run).toEqual({ ok: true, message: REMOVE_DONE });
    (await sync)();
    expect(syncStarted).toBe(true);
    // free again
    const again = beginLink();
    expect(again).toBeTypeOf('function');
    again!();
  });

  it('frees the lock when the removal really throws out of the remover', async () => {
    const f = fakeCtx([DUP]);
    f.ctx.api.activities.search = vi.fn(async () => { throw new Error('offline'); });
    // The remover's own log line throws, so the error escapes removeForGood itself.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('log broke'); });
    await expect(removeFromApp(f.ctx, fakeStore(), 'dup-1', shown(DUP))).rejects.toThrow('log broke');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Remove dup-1: offline'));
    warn.mockRestore();
    const free = beginLink();
    expect(free).toBeTypeOf('function');
    free!();
  });

  it('refuses during a Link, saying another change is running, and writes nothing', async () => {
    const f = fakeCtx([DUP]);
    const endLink = beginLink()!;
    try {
      expect(await removeFromApp(f.ctx, fakeStore(), 'dup-1', shown(DUP))).toEqual({ ok: false, message: REMOVE_BUSY });
    } finally {
      endLink();
    }
    expect(REMOVE_BUSY).toBe('Another change is running — try again when it finishes.');
    expect(f.ctx.api.activities.search).not.toHaveBeenCalled();
    expect(f.ctx.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it('makes Link refuse during a Remove, saying another change is running', async () => {
    const f = fakeCtx([DUP]);
    let release!: () => void;
    f.ctx.api.activities.saveMany = vi.fn(() => new Promise((resolve) => { release = () => resolve({ created: [], updated: [], errors: [] }); }));
    const run = removeFromApp(f.ctx, fakeStore(), 'dup-1', shown(DUP));
    await vi.waitFor(() => expect(f.ctx.api.activities.saveMany).toHaveBeenCalled());
    const out = await linkFromApp(f.ctx, fakeStore(), []);
    expect(out.message).toBe(LINK_BUSY);
    expect(LINK_BUSY).toBe('Another change is running — try again when it finishes.');
    release();
    await run;
  });

  it('refuses every transfer-typed row, even one the host calls external', async () => {
    for (const activityType of ['TRANSFER_IN', 'transfer_out']) {
      const leg = { ...DUP, activityType, isExternal: true, is_external: true };
      const f = fakeCtx([leg]);
      const store = fakeStore({ getLinkedGroups: vi.fn(async () => ({ 'other\u0000x': 'g' })) });
      expect(await removeFromApp(f.ctx, store, 'dup-1', shown(leg))).toEqual({ ok: false, message: UNLINK_FIRST });
      expect(f.ctx.api.activities.saveMany).not.toHaveBeenCalled();
      expect(f.data.size).toBe(0);
    }
  });
});
