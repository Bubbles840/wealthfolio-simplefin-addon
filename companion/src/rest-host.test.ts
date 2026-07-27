import { describe, it, expect, vi } from 'vitest';
import { RestSyncHost, RestSyncStore } from './rest-host.js';

describe('RestSyncHost', () => {
  it('reports readsSourceGroupId = true', () => {
    const host = new RestSyncHost({} as any);
    expect(host.capabilities.readsSourceGroupId).toBe(true);
  });

  it('links a pair with one call to linkTransferActivities and returns confirmed groupId', async () => {
    const client = {
      linkTransferActivities: vi.fn(async () => {}),
      searchActivities: vi.fn(async () => [
        { id: 'act-out', sourceGroupId: 'gid-123' },
      ]),
    } as any;
    const host = new RestSyncHost(client);
    const leg = (wfId: string) => ({
      wfId, accountId: 'wf-a', txId: wfId, activityType: 'TRANSFER_OUT',
      date: '2026-07-01', absCents: 100, currency: 'USD', comment: `x · ${wfId}`,
    });
    const result = await host.linkPair([leg('act-out'), leg('act-in')]);
    expect(client.linkTransferActivities).toHaveBeenCalledWith('act-out', 'act-in');
    expect(result.linked).toBe(true);
    expect(result.groupId).toBe('gid-123');
  });

  it('returns linked: false if linkTransferActivities throws', async () => {
    const client = {
      linkTransferActivities: vi.fn(async () => { throw new Error('fail'); }),
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
});
