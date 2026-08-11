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
  // Round-trip fidelity: a rule-set subtype must survive a read/write cycle
  // through this adapter unchanged, and a row that never had one must not
  // acquire an explicit value that a later comparison could mistake for one.
  it('listActivities carries subtype through from the search result, defaulting absent subtype to null', async () => {
    const client = {
      searchActivities: vi.fn(async () => [
        { id: 'act-1', accountId: 'wf-a', activityType: 'CREDIT', date: '2026-07-05', amount: '10', subtype: 'REIMBURSEMENT' },
        { id: 'act-2', accountId: 'wf-a', activityType: 'DEPOSIT', date: '2026-07-05', amount: '5' },
      ]),
    } as any;
    const host = new RestSyncHost(client);
    const rows = await host.listActivities('wf-a');

    expect(rows[0].subtype).toBe('REIMBURSEMENT');
    expect(rows[1].subtype).toBeNull();
  });

  it('saveMany sends a create/update subtype straight through to the client', async () => {
    const client = { saveMany: vi.fn(async () => ({ created: [], updated: [], errors: [] })) } as any;
    const host = new RestSyncHost(client);
    await host.saveMany({
      creates: [{ accountId: 'wf-a', activityType: 'CREDIT', activityDate: '2026-07-05', currency: 'USD', comment: 'x', subtype: 'REIMBURSEMENT' }],
    });

    expect(client.saveMany.mock.calls[0][0].creates[0].subtype).toBe('REIMBURSEMENT');
  });

  it('listOldestActivities starts its sweep at page 0 (the first page), not page 1', async () => {
    const client = { searchActivities: vi.fn(async () => []) } as any;
    const host = new RestSyncHost(client);
    await host.listOldestActivities('wf-a', 50);

    expect(client.searchActivities.mock.calls[0][0].page).toBe(0);
    expect(client.searchActivities.mock.calls[0][0].accountIdFilter).toEqual(['wf-a']);
  });

  // Regression test: the search endpoint's request body has no sort field, so a
  // single page comes back in the server's default order (newest first). The
  // starting-balance marker is by construction the OLDEST row on the account, so
  // reading a newest-first page as if it were oldest-first can miss it - and a
  // missed marker means a DUPLICATE starting-balance baseline, which silently
  // corrupts the account's balance.
  describe('listOldestActivities really returns the oldest rows', () => {
    /** A server that pages in its default NEWEST-first order. */
    function newestFirstClient(dates: string[], pageSize = 500) {
      const newestFirst = [...dates]
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
        .map((date, i) => ({ id: `act-${date}-${i}`, accountId: 'wf-a', activityType: 'DEPOSIT', date, amount: '1' }));
      return {
        searchActivities: vi.fn(async (body: any) => {
          expect(body.pageSize).toBe(pageSize);
          const start = body.page * body.pageSize;
          return newestFirst.slice(start, start + body.pageSize);
        }),
      } as any;
    }

    it('returns ascending-by-date rows given a server that responds newest-first', async () => {
      const client = newestFirstClient(['2026-01-05', '2026-03-01', '2025-06-30', '2026-07-05']);
      const host = new RestSyncHost(client);
      const rows = await host.listOldestActivities('wf-a', 50);

      expect(rows.map((r) => r.date)).toEqual(['2025-06-30', '2026-01-05', '2026-03-01', '2026-07-05']);
      // A single page was enough: the page was short, so the sweep stopped.
      expect(client.searchActivities).toHaveBeenCalledTimes(1);
    });

    it('sweeps every page so the oldest row is found even when it is on the last page', async () => {
      // 1200 rows on a newest-first server: the oldest row lives on page 2.
      const dates = Array.from({ length: 1200 }, (_, i) => {
        const d = new Date(Date.UTC(2020, 0, 1) + i * 86400000);
        return d.toISOString().slice(0, 10);
      });
      const client = newestFirstClient(dates);
      const host = new RestSyncHost(client);
      const rows = await host.listOldestActivities('wf-a', 3);

      expect(client.searchActivities.mock.calls.map((c: any[]) => c[0].page)).toEqual([0, 1, 2]);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.date)).toEqual(['2020-01-01', '2020-01-02', '2020-01-03']);
    });

    it('stops at a page cap and warns rather than looping forever on a pathological account', async () => {
      // A server that never returns a short page.
      const client = {
        searchActivities: vi.fn(async (body: any) =>
          Array.from({ length: body.pageSize }, (_, i) => ({
            id: `act-${body.page}-${i}`,
            accountId: 'wf-a',
            activityType: 'DEPOSIT',
            date: '2026-07-05',
            amount: '1',
          })),
        ),
      } as any;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const host = new RestSyncHost(client);
        const rows = await host.listOldestActivities('wf-a', 5);
        expect(rows).toHaveLength(5);
        expect(client.searchActivities.mock.calls.length).toBeLessThanOrEqual(20);
        expect(warn).toHaveBeenCalled();
        expect(String(warn.mock.calls[0][0])).toMatch(/oldest/i);
      } finally {
        warn.mockRestore();
      }
    });
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

  it('reads the large-transaction threshold out of telegram_config', async () => {
    const secrets = new Map<string, string>();
    const client = {
      getAddonSecret: vi.fn(async (_addonId: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    const store = new RestSyncStore(client);

    // Never configured → null, which runSyncCore reads as "off".
    expect(await store.getLargeTransactionThreshold()).toBeNull();
    expect(client.getAddonSecret).toHaveBeenCalledWith('simplefin-sync', 'telegram_config');

    secrets.set('telegram_config', JSON.stringify({
      botToken: 'tok', chatId: '1', enabled: true, largeTransactionThreshold: 750,
    }));
    expect(await store.getLargeTransactionThreshold()).toBe(750);

    // An explicit 0 must survive as 0, NOT be collapsed into null: the sibling
    // drift threshold distinguishes the two, and one adapter quietly normalising
    // would make the same stored value mean different things.
    secrets.set('telegram_config', JSON.stringify({ largeTransactionThreshold: 0 }));
    expect(await store.getLargeTransactionThreshold()).toBe(0);

    // A hand-edited string is not a threshold.
    secrets.set('telegram_config', JSON.stringify({ largeTransactionThreshold: '750' }));
    expect(await store.getLargeTransactionThreshold()).toBeNull();

    // A truncated config must not throw out of a sync.
    secrets.set('telegram_config', '{"botToken":"tok","chatId"');
    expect(await store.getLargeTransactionThreshold()).toBeNull();
  });

  it('reads the drift-alert threshold out of telegram_config, keeping an explicit 0', async () => {
    const secrets = new Map<string, string>();
    const client = {
      getAddonSecret: vi.fn(async (_addonId: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    const store = new RestSyncStore(client);

    // Absent → null, which runSyncCore turns into its $100 default. Explicit 0
    // means OFF, so it must not be reported as absent.
    expect(await store.getDriftAlertThreshold()).toBeNull();
    secrets.set('telegram_config', JSON.stringify({ driftAlertThreshold: 0 }));
    expect(await store.getDriftAlertThreshold()).toBe(0);
    secrets.set('telegram_config', JSON.stringify({ driftAlertThreshold: 250 }));
    expect(await store.getDriftAlertThreshold()).toBe(250);
  });

  it('reads and writes drift alerts as JSON under drift_alerts', async () => {
    const secrets = new Map<string, string>();
    const client = {
      getAddonSecret: vi.fn(async (_addonId: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_addonId: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;
    const store = new RestSyncStore(client);

    expect(await store.getDriftAlerts()).toEqual({});
    await store.setDriftAlerts({
      'sfin-1': { driftAmount: 1300, firstDetectedAt: '2026-07-29T00:00:00Z', alerted: true },
    });
    expect(client.setAddonSecret).toHaveBeenCalledWith(
      'simplefin-sync',
      'drift_alerts',
      '{"sfin-1":{"driftAmount":1300,"firstDetectedAt":"2026-07-29T00:00:00Z","alerted":true}}',
    );
    expect(await store.getDriftAlerts()).toEqual({
      'sfin-1': { driftAmount: 1300, firstDetectedAt: '2026-07-29T00:00:00Z', alerted: true },
    });
  });
});
