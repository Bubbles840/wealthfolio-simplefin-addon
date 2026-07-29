import { describe, it, expect, vi } from 'vitest';
import { RestSyncHost, RestSyncStore } from './rest-host.js';

describe('RestSyncHost', () => {
  it('reports readsSourceGroupId = true', () => {
    const host = new RestSyncHost({} as any);
    expect(host.capabilities.readsSourceGroupId).toBe(true);
  });

  // Regression test: the REST activity-search endpoint is 0-INDEXED (verified
  // against a live server: page 0 and page 1 return different rows). Asking for
  // page 1 with pageSize 500 returned an EMPTY list on every account with fewer
  // than 500 activities, so the sync core believed nothing had ever been
  // imported, planned a create for every transaction, and Wealthfolio's dedup
  // rejected the whole batch with "Duplicate activity detected". Assert the
  // outgoing request, not just the mapped result - mocking the client wholesale
  // is exactly how this survived.
  it('listActivities asks for page 0 (the first page), not page 1', async () => {
    const client = {
      searchActivities: vi.fn(async () => [
        { id: 'act-1', accountId: 'wf-a', activityType: 'DEPOSIT', date: '2026-07-05', amount: '10' },
      ]),
    } as any;
    const host = new RestSyncHost(client);
    const rows = await host.listActivities('wf-a');

    expect(client.searchActivities).toHaveBeenCalledTimes(1);
    expect(client.searchActivities.mock.calls[0][0]).toEqual({
      page: 0,
      pageSize: 500,
      accountIdFilter: ['wf-a'],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('act-1');
    expect(rows[0].accountId).toBe('wf-a');
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
