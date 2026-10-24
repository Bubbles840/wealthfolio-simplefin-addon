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
