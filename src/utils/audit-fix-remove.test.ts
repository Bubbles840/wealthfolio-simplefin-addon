import { describe, it, expect, vi } from 'vitest';
import { SKIPPED_TRANSACTIONS_SECRET_KEY } from '../../shared/skipped-transactions';
import {
  removalFingerprint, REMOVE_DONE, REMOVE_NOT_FEED, REMOVE_SKIP_UNREADABLE, REMOVE_UNLINK_FIRST,
} from '../../shared/tx-remove';
import { removeFromApp, type FixStore } from './audit-fix';
import { beginLink, beginSync, REMOVE_SYNC_RUNNING } from './write-lock';

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
    expect(await removeFromApp(f.ctx, fakeStore(), 'dup-1', shown(DUP))).toEqual({ ok: false, message: REMOVE_SKIP_UNREADABLE });
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

  it('frees the lock when the removal throws', async () => {
    const f = fakeCtx([DUP]);
    f.ctx.api.activities.search = vi.fn(async () => { throw new Error('offline'); });
    await removeFromApp(f.ctx, fakeStore(), 'dup-1', shown(DUP));
    const free = beginLink();
    expect(free).toBeTypeOf('function');
    free!();
  });
});
