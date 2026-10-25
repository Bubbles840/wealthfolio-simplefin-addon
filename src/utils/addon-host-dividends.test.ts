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
