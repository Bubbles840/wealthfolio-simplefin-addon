import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { categoryFiledChange, importChange, stampChange, transferLinkChange } from '../../shared/change-entries';
import type { ChangeBucket } from '../../shared/change-log';
import { UNDO_FROM_TELEGRAM, UNDO_UPDATE_COMPANION } from '../../shared/change-undo';
import { emptySyncOverrides, setTxOverride, SYNC_OVERRIDES_SECRET_KEY } from '../../shared/sync-overrides';
import { accountTxKey } from '../../shared/transfers';
import { SecretsStore } from './secrets';
import { undoFromApp } from './change-undo';

const NOW = new Date('2026-10-13T15:00:00Z');
const CHECKING = { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' };

/** The add-on's secrets and activities in memory, deletes included. */
function makeCtx(seed: Record<string, string> = {}, rows: any[] = []) {
  const data: Record<string, string> = { ...seed };
  const ctx = {
    api: {
      secrets: {
        get: vi.fn(async (k: string) => data[k] ?? null),
        set: vi.fn(async (k: string, v: string) => { data[k] = v; }),
        delete: vi.fn(async (k: string) => { delete data[k]; }),
      },
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-a', name: 'Checking', accountType: 'CASH', currency: 'USD' }]) },
      activities: {
        search: vi.fn(async () => ({ data: rows })),
        saveMany: vi.fn(async (req: any) => {
          for (const id of req.deleteIds ?? []) rows.splice(rows.findIndex((r) => r.id === id), 1);
          return { created: [], updated: [], deleted: [], createdMappings: [], errors: [] };
        }),
      },
    },
  } as any;
  return { ctx, data, rows };
}

const imported = () => stampChange(importChange({
  account: CHECKING, txKey: accountTxKey('sfin-1', 'tx-1'), activityId: 'act-1', description: 'SQ *BLUE_BOTTLE', amountCents: -650,
  date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
}), 'companion', new Date('2026-10-12T09:00:00Z'));
const row = () => ({ id: 'act-1', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-11', amount: 6.5, comment: 'SQ *BLUE_BOTTLE · tx-1' });

describe('undoFromApp', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('undoes an import through the SDK and records it in the add-on’s own bucket', async () => {
    const { ctx, data, rows } = makeCtx({ companion_version: '1.61.0' }, [row()]);
    const store = new SecretsStore(ctx);
    const e = imported();
    expect(await undoFromApp(ctx, store, e, [e], 'undo')).toMatchObject({ ok: true, needsSync: false });
    expect(rows).toEqual([]);
    expect(JSON.parse(data.skipped_transactions)).toEqual([expect.objectContaining({ account: 'sfin-1', txId: 'tx-1' })]);
    const bucket = JSON.parse(data['change_log:addon:2026-10']) as ChangeBucket;
    expect(bucket.entries).toEqual([expect.objectContaining({ writer: 'addon', actor: 'you', reverses: { id: e.id, op: 'undo' } })]);
  });

  it('refuses a linked import from the ledger the add-on keeps, since it cannot read groups', async () => {
    const { ctx, rows } = makeCtx({ linked_groups: JSON.stringify({ [accountTxKey('sfin-1', 'tx-1')]: 'wf-transfer-1' }) }, [row()]);
    const e = imported();
    expect(await undoFromApp(ctx, new SecretsStore(ctx), e, [e], 'undo')).toEqual({ ok: false, message: 'Undo the transfer link first.' });
    expect(rows).toHaveLength(1);
  });

  it('a category entry is undone from Telegram, and an old companion blocks a sync decision', async () => {
    const { ctx, data } = makeCtx({ companion_version: '1.59.2' });
    const store = new SecretsStore(ctx);
    const filing = stampChange(categoryFiledChange({
      actor: 'you', activityId: 'act-5', description: 'VENMO', before: null, after: { categoryId: 'c', categoryName: 'Dining' },
    }), 'companion', NOW);
    expect(await undoFromApp(ctx, store, filing, [filing], 'undo')).toEqual({ ok: false, message: UNDO_FROM_TELEGRAM });
    const link = stampChange(transferLinkChange(
      { account: CHECKING, txKey: 'k1', description: 'A', amountCents: -100, date: '2026-10-08', oldActivityId: 'o1' },
      { account: { name: 'Card' }, txKey: 'k2', description: 'B', amountCents: 100, date: '2026-10-08', oldActivityId: 'o2' },
    ), 'companion', NOW);
    expect(await undoFromApp(ctx, store, link, [link], 'undo')).toEqual({ ok: false, message: UNDO_UPDATE_COMPANION });
    expect(data[SYNC_OVERRIDES_SECRET_KEY]).toBeUndefined();
  });
});

describe('SecretsStore — the overrides list', () => {
  it('reads it with an unreadable flag, and edits it re-reading first', async () => {
    const doc = setTxOverride(emptySyncOverrides(), 'k1', 'notTransfer', NOW);
    const { ctx, data } = makeCtx({ [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(doc) });
    const store = new SecretsStore(ctx);
    expect(await store.readSyncOverrides()).toEqual({ overrides: doc, unreadable: false });
    await store.editSyncOverrides((o) => setTxOverride(o, 'k2', 'keepDuplicate', NOW));
    expect(Object.keys(JSON.parse(data[SYNC_OVERRIDES_SECRET_KEY]).tx)).toEqual(['k1', 'k2']);
  });

  it('flags a corrupt document, and refuses to overwrite it', async () => {
    const { ctx, data } = makeCtx({ [SYNC_OVERRIDES_SECRET_KEY]: '{oops' });
    const store = new SecretsStore(ctx);
    expect(await store.readSyncOverrides()).toEqual({ overrides: emptySyncOverrides(), unreadable: true });
    await expect(store.editSyncOverrides((o) => o)).rejects.toMatchObject({ name: 'SyncOverridesUnreadableError' });
    expect(data[SYNC_OVERRIDES_SECRET_KEY]).toBe('{oops');
  });

  it('is null when the read itself fails', async () => {
    const { ctx } = makeCtx();
    ctx.api.secrets.get = vi.fn(async () => { throw new Error('host gone'); });
    expect(await new SecretsStore(ctx).readSyncOverrides()).toBeNull();
  });
});
