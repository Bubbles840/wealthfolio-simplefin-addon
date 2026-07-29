import { describe, it, expect, vi } from 'vitest';
import { RestSyncHost, RestSyncStore } from './rest-host.js';

describe('RestSyncHost', () => {
  it('reports readsSourceGroupId = true', () => {
    const host = new RestSyncHost({} as any);
    expect(host.capabilities.readsSourceGroupId).toBe(true);
  });

  it('links a pair by deleting and re-creating both legs via saveMany, returning the echoed groupId', async () => {
    const client = {
      saveMany: vi.fn(async (req: any) => ({
        created: (req.creates ?? []).map((c: any, i: number) => ({
          id: `new-${i}`,
          accountId: c.accountId,
          activityType: c.activityType,
          date: c.activityDate,
          amount: c.amount ?? null,
          comment: c.comment,
          sourceGroupId: 'gid-123',
        })),
        updated: [],
        errors: [],
      })),
    } as any;
    const host = new RestSyncHost(client);
    const leg = (wfId: string) => ({
      wfId, accountId: 'wf-a', txId: wfId, activityType: 'TRANSFER_OUT',
      date: '2026-07-01', absCents: 100, currency: 'USD', comment: `x · ${wfId}`,
    });
    const result = await host.linkPair([leg('act-out'), leg('act-in')]);
    expect(client.saveMany).toHaveBeenCalledTimes(2);
    expect(client.saveMany.mock.calls[0][0].deleteIds).toEqual(['act-out', 'act-in']);
    expect(client.saveMany.mock.calls[1][0].creates).toHaveLength(2);
    expect(result.linked).toBe(true);
    expect(result.groupId).toBe('gid-123');
  });

  it('returns linked: false when saveMany reports errors', async () => {
    const client = {
      saveMany: vi.fn(async () => ({
        created: [],
        updated: [],
        errors: [{ action: 'create', message: 'boom' }],
      })),
    } as any;
    const host = new RestSyncHost(client);
    const leg = (wfId: string) => ({
      wfId, accountId: 'wf-a', txId: wfId, activityType: 'TRANSFER_OUT',
      date: '2026-07-01', absCents: 100, currency: 'USD', comment: `x · ${wfId}`,
    });
    const result = await host.linkPair([leg('act-out'), leg('act-in')]);
    expect(result.linked).toBe(false);
  });
});

describe('RestSyncStore', () => {
  it('reads and writes secrets via client addon secrets endpoints', async () => {
    const secrets = new Map<string, string>();
    const client = {
      getAddonSecret: vi.fn(async (_addonId: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_addonId: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;
    const store = new RestSyncStore(client);

    expect(await store.getAccessUrl()).toBeNull();
    await store.setLastSyncAt(new Date('2026-07-01T12:00:00Z'));
    expect(client.setAddonSecret).toHaveBeenCalledWith('simplefin-sync', 'last_sync_at', '2026-07-01T12:00:00.000Z');
    expect(await store.getLastSyncAt()).toEqual(new Date('2026-07-01T12:00:00Z'));
  });

  it('reads and writes transfer link failures as JSON', async () => {
    const secrets = new Map<string, string>();
    const client = {
      getAddonSecret: vi.fn(async (_addonId: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_addonId: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;
    const store = new RestSyncStore(client);

    expect(await store.getTransferLinkFailures()).toEqual({});
    await store.setTransferLinkFailures({ 'tx-out-1': { count: 2, firstFailedAt: '2026-07-27T00:00:00Z', alerted: false } });
    expect(await store.getTransferLinkFailures()).toEqual({
      'tx-out-1': { count: 2, firstFailedAt: '2026-07-27T00:00:00Z', alerted: false },
    });
  });
});
