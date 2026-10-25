import { describe, it, expect, vi, afterEach } from 'vitest';
import { RestSyncHost } from './rest-host.js';
import { WealthfolioClient } from './wealthfolio.js';

describe('RestSyncHost — held securities', () => {
  it('lists each holding\'s asset id and display code', async () => {
    const client = { getHoldings: vi.fn(async () => [{ instrument: { id: 'asset-voo', symbol: 'VOO' } }, { instrument: {} }]) };
    expect(await new RestSyncHost(client as any).listHeldSecurities('wf-1')).toEqual([{ assetId: 'asset-voo', symbol: 'VOO' }]);
    expect(client.getHoldings).toHaveBeenCalledWith('wf-1');
  });
});

describe('WealthfolioClient.getHoldings', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('GETs /holdings for one account, and reads a non-array body as no rows', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const client = new WealthfolioClient('http://wealthfolio:8088');
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [{ instrument: { id: 'a', symbol: 'VOO' } }] });
    expect(await client.getHoldings('wf 1')).toHaveLength(1);
    expect(mockFetch.mock.calls[0][0]).toBe('http://wealthfolio:8088/api/v1/holdings?accountId=wf%201');
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ not: 'a list' }) });
    expect(await client.getHoldings('wf-1')).toEqual([]);
  });
});

describe('RestSyncHost — a stored row\'s asset symbol', () => {
  it('carries assetSymbol from the search item, and leaves it out when the item has none', async () => {
    const client = {
      searchActivities: vi.fn(async () => [
        { id: 'a1', accountId: 'wf-1', activityType: 'DIVIDEND', date: '2027-03-10', amount: '1', assetId: 'uuid-1', assetSymbol: '$CASH' },
        { id: 'a2', accountId: 'wf-1', activityType: 'DEPOSIT', date: '2027-03-10', amount: '1' },
      ]),
    };
    const rows = await new RestSyncHost(client as any).listActivities('wf-1');
    expect(rows[0].assetSymbol).toBe('$CASH');
    expect('assetSymbol' in rows[1]).toBe(false);
  });
});

