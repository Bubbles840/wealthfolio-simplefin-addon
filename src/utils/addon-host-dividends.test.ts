import { describe, it, expect, vi } from 'vitest';
import { AddonSyncHost } from './addon-host';

describe('AddonSyncHost — held securities', () => {
  it('lists each holding\'s asset id and display code from portfolio.getHoldings', async () => {
    const getHoldings = vi.fn(async () => [
      { instrument: { id: 'asset-voo', symbol: 'VOO', pricingMode: 'MARKET' }, price: 600 },
      { instrument: null },
    ]);
    const host = new AddonSyncHost({ api: { portfolio: { getHoldings } } } as any);
    expect(await host.listHeldSecurities('wf-1')).toEqual([{ assetId: 'asset-voo', symbol: 'VOO' }]);
    expect(getHoldings).toHaveBeenCalledWith('wf-1');
  });
});

describe('AddonSyncHost — a stored row\'s asset symbol', () => {
  it('carries assetSymbol from the search row, and leaves it out when the row has none', async () => {
    const search = vi.fn(async () => ({
      data: [
        { id: 'a1', accountId: 'wf-1', activityType: 'DIVIDEND', date: '2027-03-10', amount: 1, assetId: 'uuid-1', assetSymbol: '$CASH' },
        { id: 'a2', accountId: 'wf-1', activityType: 'DEPOSIT', date: '2027-03-10', amount: 1 },
      ],
    }));
    const rows = await new AddonSyncHost({ api: { activities: { search } } } as any).listActivities('wf-1');
    expect(rows[0].assetSymbol).toBe('$CASH');
    expect('assetSymbol' in rows[1]).toBe(false);
  });
});

