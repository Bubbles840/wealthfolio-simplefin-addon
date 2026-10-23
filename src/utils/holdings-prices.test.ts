import { describe, it, expect, vi } from 'vitest';
import { manualQuote, syncHoldingsWithFeedPrices, FEED_PRICE_NOTE, UNPRICED_FOR_MS, type PricingApi, type SnapshotIo } from './holdings-prices';
import type { FeedPrice, HoldingsSnapshot } from '../../shared/holdings';

const DAY = '2026-10-19';
const NOW = new Date('2026-10-19T18:00:00Z');
const OLD = new Date(NOW.getTime() - UNPRICED_FOR_MS - 60_000).toISOString();
const NEW = new Date(NOW.getTime() - 60_000).toISOString();

describe('manualQuote', () => {
  it('is a one-day quote at the price, under the id Wealthfolio gives a manual quote', () => {
    expect(manualQuote('asset-basket', DAY, '124.84394507', 'USD', new Date('2026-10-19T22:00:00Z'))).toEqual({
      id: '20261019_ASSET-BASKET',
      createdAt: '2026-10-19T22:00:00.000Z',
      dataSource: 'MANUAL',
      timestamp: '2026-10-19T12:00:00.000Z',
      assetId: 'asset-basket',
      open: 124.84394507, high: 124.84394507, low: 124.84394507, close: 124.84394507, adjclose: 124.84394507,
      volume: 0,
      currency: 'USD',
      notes: FEED_PRICE_NOTE,
    });
  });
});

/**
 * A small Wealthfolio, as its source behaves (v3.10): ONE asset per symbol for
 * every account; one quote per asset, day and source, the last write winning;
 * a snapshot is one row per account and date; importing a snapshot onto a
 * MANUAL asset writes the day's price from the position's average cost; and an
 * account's holdings are its latest snapshot's positions, each with its
 * asset's mode (`instrument.pricingMode`) and latest price. A holding's
 * `instrument.symbol` is the asset's display code, which drops a known
 * exchange suffix ("SHOP.TO" shows as "SHOP").
 */
function wealthfolio() {
  type Asset = { id: string; quoteMode: string; createdAt: string; displayCode?: string };
  const assets = new Map<string, Asset>();
  const quotes = new Map<string, { close: number; dataSource: string }>(); // `${assetId}|${day}|${source}`
  const snapshots = new Map<string, HoldingsSnapshot>(); // `${account}|${date}`
  const key = (s: string) => s.trim().toUpperCase();
  const byId = (id: string) => [...assets.values()].find((a) => a.id === id)!;
  const quotesOf = (id: string) => [...quotes].filter(([k]) => k.startsWith(`${id}|`))
    .map(([k, q]) => ({ timestamp: `${k.split('|')[1]}T12:00:00Z`, close: q.close, dataSource: q.dataSource }));
  const latest = (id: string) => quotesOf(id).sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0]?.close ?? null;

  const io: SnapshotIo = {
    checkImport: vi.fn(async (account: string, [snap]: HoldingsSnapshot[]) => ({
      existingDates: [...snapshots.keys()].filter((k) => k.startsWith(`${account}|`)).map((k) => k.split('|')[1]),
      symbols: snap.positions.map((p) => {
        const asset = assets.get(key(p.symbol));
        return { symbol: key(p.symbol), found: !!asset, ...(asset ? { assetId: asset.id } : {}) };
      }),
      validationErrors: [],
    })),
    importSnapshots: vi.fn(async (account: string, [snap]: HoldingsSnapshot[]) => {
      for (const p of snap.positions) {
        let asset = assets.get(key(p.symbol));
        if (!asset) {
          asset = { id: `asset-${assets.size + 1}`, quoteMode: p.quoteMode ?? 'MARKET', createdAt: NOW.toISOString() };
          assets.set(key(p.symbol), asset);
        }
        if (asset.quoteMode === 'MANUAL' && p.avgCost) quotes.set(`${asset.id}|${snap.date}|MANUAL`, { close: Number(p.avgCost), dataSource: 'MANUAL' });
      }
      snapshots.set(`${account}|${snap.date}`, snap);
      return { snapshotsImported: 1, errors: [] };
    }),
  };
  const pricing = {
    getHoldings: vi.fn(async (account: string) => {
      const dates = [...snapshots.keys()].filter((k) => k.startsWith(`${account}|`)).sort();
      if (dates.length === 0) return [];
      return snapshots.get(dates[dates.length - 1])!.positions.map((p) => {
        const asset = assets.get(key(p.symbol))!;
        return { instrument: { id: asset.id, symbol: asset.displayCode ?? p.symbol, pricingMode: asset.quoteMode }, price: latest(asset.id) };
      });
    }),
    getProfile: vi.fn(async (id: string) => ({ quoteMode: byId(id).quoteMode, createdAt: byId(id).createdAt })),
    updateQuoteMode: vi.fn(async (id: string, mode: string) => { byId(id).quoteMode = mode; }),
    getHistory: vi.fn(async (id: string) => quotesOf(id)),
    updateQuote: vi.fn(async (id: string, quote: { timestamp: string; close: number }) => {
      quotes.set(`${id}|${quote.timestamp.slice(0, 10)}|MANUAL`, { close: quote.close, dataSource: 'MANUAL' });
    }),
  } satisfies PricingApi;

  /** What a position is worth in this account on this day, as Wealthfolio values it. */
  const value = (account: string, date: string, symbolPrefix: string) => {
    const snap = snapshots.get(`${account}|${date}`)!;
    const p = snap.positions.find((x) => key(x.symbol).startsWith(key(symbolPrefix)))!;
    const asset = assets.get(key(p.symbol))!;
    const day = quotesOf(asset.id).filter((q) => q.timestamp.slice(0, 10) <= date)
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];
    return { symbol: p.symbol, value: Math.round(Number(p.quantity) * (day?.close ?? 0) * 100) / 100 };
  };
  /** An asset already on file, made `createdAt` ago. */
  const seedAsset = (symbol: string, quoteMode: string, createdAt: string, displayCode?: string) => {
    assets.set(key(symbol), { id: `asset-${assets.size + 1}`, quoteMode, createdAt, ...(displayCode ? { displayCode } : {}) });
    return assets.get(key(symbol))!;
  };
  const marketQuote = (id: string, day: string, close: number) => quotes.set(`${id}|${day}|YAHOO`, { close, dataSource: 'YAHOO' });
  return { io, pricing, assets, quotes, snapshots, value, seedAsset, marketQuote };
}

const snap = (symbol: string, quantity: string, date = DAY, avgCost?: string): HoldingsSnapshot => ({
  date,
  positions: [{ symbol, quantity, currency: 'USD', ...(avgCost ? { avgCost } : {}) }],
  cashBalances: { USD: '0' },
});
const priceOf = (symbol: string, price: string, extra: Partial<FeedPrice> = {}): FeedPrice[] => [{ symbol, price, currency: 'USD', ...extra }];

/** An account holding a basket on the shared asset since `createdAt`, already
 *  imported for DAY, with no quote: Wealthfolio values it at $0. */
function withBasket(createdAt = OLD) {
  const wf = wealthfolio();
  wf.seedAsset('MODEL BASKET', 'MARKET', createdAt);
  wf.snapshots.set(`wf-a|${DAY}`, snap('MODEL BASKET', '400.5'));
  return wf;
}

describe('syncHoldingsWithFeedPrices', () => {
  it('moves a basket the market has not priced for days onto the account\'s own asset, and prices it', async () => {
    const wf = withBasket();
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', undefined, NOW);

    expect(r).toMatchObject({ imported: 1, pricedFromFeed: ['MODEL BASKET (AAAA1111)'] });
    expect(wf.value('wf-a', DAY, 'MODEL BASKET')).toEqual({ symbol: 'MODEL BASKET (AAAA1111)', value: 50000 });
    expect(wf.assets.get('MODEL BASKET (AAAA1111)')!.quoteMode).toBe('MANUAL');
  });

  it('gives two accounts holding one symbol each their own asset and value', async () => {
    const wf = withBasket();
    wf.snapshots.set(`wf-b|${DAY}`, snap('MODEL BASKET', '100'));
    await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', undefined, NOW);
    await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-b', snap('MODEL BASKET', '100'), priceOf('MODEL BASKET', '150'), 'BBBB2222', undefined, NOW);

    expect(wf.value('wf-a', DAY, 'MODEL BASKET').value).toBe(50000);
    expect(wf.value('wf-b', DAY, 'MODEL BASKET').value).toBe(15000);
  });

  it('waits before moving a ticker that has had no time to get its first quote', async () => {
    const wf = withBasket(NEW);
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', undefined, NOW);

    expect(r).toEqual({ imported: 0, skipped: 1, unresolvedSymbols: [] });
    expect(wf.assets.has('MODEL BASKET (AAAA1111)')).toBe(false);
  });

  it('moves a holding back to the shared asset once that one has a market quote', async () => {
    const wf = withBasket();
    await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', undefined, NOW);
    wf.marketQuote(wf.assets.get('MODEL BASKET')!.id, DAY, 126);

    const next = '2026-10-20';
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5', next), priceOf('MODEL BASKET', '125'), 'AAAA1111', undefined, NOW);
    expect(r).toEqual({ imported: 1, skipped: 0, unresolvedSymbols: [] });
    expect(wf.value('wf-a', next, 'MODEL BASKET')).toEqual({ symbol: 'MODEL BASKET', value: 50463 });
  });

  it('keeps a holding on its own asset on a day the feed sends no price for it', async () => {
    const wf = withBasket();
    await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', undefined, NOW);

    for (const [next, prices] of [['2026-10-20', []], ['2026-10-21', priceOf('MODEL BASKET', '0')]] as const) {
      await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5', next), prices, 'AAAA1111', undefined, NOW);
      // Valued at its last price, not moved onto the shared asset nobody prices.
      expect(wf.value('wf-a', next, 'MODEL BASKET')).toEqual({ symbol: 'MODEL BASKET (AAAA1111)', value: 50000 });
    }
  });

  it('keeps the last price, not the average cost, for a kept holding that reports a cost', async () => {
    const wf = withBasket();
    await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', undefined, NOW);
    const next = '2026-10-20';
    await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5', next, '100'), [], 'AAAA1111', undefined, NOW);
    expect(wf.value('wf-a', next, 'MODEL BASKET')).toEqual({ symbol: 'MODEL BASKET (AAAA1111)', value: 50000 });
  });

  it('leaves a shared asset the person set to manual alone', async () => {
    const wf = wealthfolio();
    wf.seedAsset('MODEL BASKET', 'MANUAL', OLD);
    wf.snapshots.set(`wf-a|${DAY}`, snap('MODEL BASKET', '400.5'));
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', undefined, NOW);

    expect(r).toEqual({ imported: 0, skipped: 1, unresolvedSymbols: [] });
    expect(wf.pricing.updateQuote).not.toHaveBeenCalled();
    // The holdings read already says so.
    expect(wf.pricing.getProfile).not.toHaveBeenCalled();
  });

  it('costs a ticker the market prices nothing but the account\'s one holdings read', async () => {
    const wf = wealthfolio();
    const vti = wf.seedAsset('VTI', 'MARKET', OLD);
    wf.marketQuote(vti.id, '2026-10-18', 299.5);
    wf.snapshots.set(`wf-a|${DAY}`, snap('VTI', '2'));
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('VTI', '2'), priceOf('VTI', '300'), 'AAAA1111', undefined, NOW);

    expect(r).toEqual({ imported: 0, skipped: 1, unresolvedSymbols: [] });
    expect(wf.pricing.getHoldings).toHaveBeenCalledTimes(1);
    expect(wf.pricing.getProfile).not.toHaveBeenCalled();
    expect(wf.pricing.getHistory).not.toHaveBeenCalled();
    // And no per-account symbol was sent to the import check (a provider search).
    expect(vi.mocked(wf.io.checkImport).mock.calls[0][1][0].positions.map((p) => p.symbol)).toEqual(['VTI']);
  });

  it('costs a ticker shown without its exchange suffix nothing more either', async () => {
    // Wealthfolio shows SHOP.TO as SHOP, so the holding is found by its asset, not its symbol.
    const wf = wealthfolio();
    const shop = wf.seedAsset('SHOP.TO', 'MARKET', OLD, 'SHOP');
    wf.marketQuote(shop.id, '2026-10-18', 151.2);
    wf.snapshots.set(`wf-a|${DAY}`, snap('SHOP.TO', '3'));
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('SHOP.TO', '3'), priceOf('SHOP.TO', '152'), 'AAAA1111', undefined, NOW);

    expect(r).toEqual({ imported: 0, skipped: 1, unresolvedSymbols: [] });
    expect(wf.pricing.getProfile).not.toHaveBeenCalled();
    expect(wf.pricing.getHistory).not.toHaveBeenCalled();
  });

  it('judges each of two listings shown under one code by its own asset', async () => {
    // SHOP.TO shows as SHOP: a lookup by the shown code alone can judge SHOP by SHOP.TO's asset.
    const wf = wealthfolio();
    const shop = wf.seedAsset('SHOP', 'MARKET', OLD);
    wf.marketQuote(shop.id, '2026-10-18', 105);
    wf.seedAsset('SHOP.TO', 'MARKET', OLD, 'SHOP');
    const both: HoldingsSnapshot = {
      date: DAY,
      positions: [{ symbol: 'SHOP', quantity: '2', currency: 'USD' }, { symbol: 'SHOP.TO', quantity: '3', currency: 'USD' }],
      cashBalances: { USD: '0' },
    };
    wf.snapshots.set(`wf-a|${DAY}`, both);
    const prices: FeedPrice[] = [{ symbol: 'SHOP', price: '106', currency: 'USD' }, { symbol: 'SHOP.TO', price: '140', currency: 'USD' }];
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', both, prices, 'AAAA1111', undefined, NOW);

    expect(r.pricedFromFeed).toEqual(['SHOP.TO (AAAA1111)']);
    expect(vi.mocked(wf.io.importSnapshots).mock.calls[0][1][0].positions.map((p) => p.symbol)).toEqual(['SHOP', 'SHOP.TO (AAAA1111)']);
  });

  it('reads no profile for a holding already on its own asset', async () => {
    const wf = withBasket();
    await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', undefined, NOW);
    wf.pricing.getProfile.mockClear();

    const next = '2026-10-20';
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5', next), priceOf('MODEL BASKET', '125'), 'AAAA1111', undefined, NOW);
    expect(r).toMatchObject({ imported: 1, pricedFromFeed: ['MODEL BASKET (AAAA1111)'] });
    expect(wf.pricing.getProfile).not.toHaveBeenCalled();
  });

  it('leaves a symbol the feed sends in two currencies where it is', async () => {
    // Both lines would land on one per-account asset with one price: one line's value lost.
    const wf = wealthfolio();
    wf.seedAsset('BASKET', 'MARKET', OLD);
    const twoCurrencies: HoldingsSnapshot = {
      date: DAY,
      positions: [{ symbol: 'BASKET', quantity: '10', currency: 'USD' }, { symbol: 'BASKET', quantity: '4', currency: 'CAD' }],
      cashBalances: { USD: '0' },
    };
    const prices: FeedPrice[] = [{ symbol: 'BASKET', price: '100', currency: 'USD' }, { symbol: 'BASKET', price: '300', currency: 'CAD' }];
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', twoCurrencies, prices, 'AAAA1111', undefined, NOW);

    expect(r.pricedFromFeed).toBeUndefined();
    expect(wf.pricing.updateQuote).not.toHaveBeenCalled();
    expect(vi.mocked(wf.io.importSnapshots).mock.calls[0][1][0].positions.map((p) => p.symbol)).toEqual(['BASKET', 'BASKET']);
  });

  it('moves a holding new to the account at once when its shared asset has long gone unpriced', async () => {
    // Another account (or an earlier sync) made the shared asset days ago.
    const wf = wealthfolio();
    wf.seedAsset('MODEL BASKET', 'MARKET', OLD);
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-new', snap('MODEL BASKET', '10'), priceOf('MODEL BASKET', '125'), 'DDDD4444', undefined, NOW);

    expect(r).toMatchObject({ imported: 1, pricedFromFeed: ['MODEL BASKET (DDDD4444)'] });
    expect(wf.value('wf-new', DAY, 'MODEL BASKET')).toEqual({ symbol: 'MODEL BASKET (DDDD4444)', value: 1250 });
  });

  it('leaves a holding new to the account on a shared asset the market prices', async () => {
    const wf = wealthfolio();
    const vti = wf.seedAsset('VTI', 'MARKET', OLD);
    wf.marketQuote(vti.id, '2026-10-18', 299.5);
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-new', snap('VTI', '2'), priceOf('VTI', '300'), 'DDDD4444', undefined, NOW);

    expect(r).toEqual({ imported: 1, skipped: 0, unresolvedSymbols: [] });
    expect(wf.value('wf-new', DAY, 'VTI').symbol).toBe('VTI');
  });

  it('puts a holding named from its description on its own asset from the first sync', async () => {
    const wf = wealthfolio();
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-plan', snap('TARGET DATE FUND 2060', '40'),
      priceOf('TARGET DATE FUND 2060', '250.00', { fromDescription: true }), 'CCCC3333', undefined, NOW);

    expect(r).toMatchObject({ imported: 1, pricedFromFeed: ['TARGET DATE FUND 2060 (CCCC3333)'] });
    expect([...wf.assets.keys()]).toEqual(['TARGET DATE FUND 2060 (CCCC3333)']);
    // Its bare name is never sent to the import check (a provider search).
    const checked = vi.mocked(wf.io.checkImport).mock.calls.flatMap((c) => c[1][0].positions.map((p) => p.symbol));
    expect(checked).not.toContain('TARGET DATE FUND 2060');
    expect(wf.value('wf-plan', DAY, 'TARGET DATE')).toEqual({ symbol: 'TARGET DATE FUND 2060 (CCCC3333)', value: 10000 });
  });

  it('writes the day\'s price only when it changed', async () => {
    const wf = withBasket();
    const run = (price: string) => syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', price), 'AAAA1111', undefined, NOW);
    await run('124.84394507');
    expect(await run('124.84394507')).toMatchObject({ imported: 0, skipped: 1, pricedFromFeed: [] });
    expect(await run('220')).toMatchObject({ pricedFromFeed: ['MODEL BASKET (AAAA1111)'] });
    expect(wf.pricing.updateQuote).toHaveBeenCalledTimes(2);
    expect(wf.value('wf-a', DAY, 'MODEL BASKET').value).toBe(88110);
  });

  it('keeps the market value, not the average cost the import writes on a manual asset', async () => {
    const wf = withBasket();
    await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', undefined, NOW);
    const next = '2026-10-20';
    await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5', next, '250.00'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', undefined, NOW);
    expect(wf.value('wf-a', next, 'MODEL BASKET').value).toBe(50000);
  });

  it('never prices the shared asset when the check hands it back for the per-account symbol', async () => {
    const wf = withBasket();
    const shared = wf.assets.get('MODEL BASKET')!;
    wf.assets.set('MODEL BASKET (AAAA1111)', shared); // a fuzzy match
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', undefined, NOW);

    expect(r).toEqual({ imported: 0, skipped: 1, unresolvedSymbols: [] });
    expect(wf.pricing.updateQuote).not.toHaveBeenCalled();
    expect(shared.quoteMode).toBe('MARKET');
  });

  it('skips the account for this sync when its holdings cannot be read', async () => {
    const wf = withBasket();
    wf.pricing.getHoldings.mockRejectedValueOnce(new Error('permission denied'));
    await expect(syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', undefined, NOW))
      .rejects.toThrow("could not read the account's holdings: permission denied");
    expect(wf.io.importSnapshots).not.toHaveBeenCalled();
  });

  it('keeps the snapshot and only logs when the new asset cannot be found to price', async () => {
    const wf = withBasket();
    const check = vi.mocked(wf.io.checkImport);
    check.mockImplementationOnce(check.getMockImplementation()!).mockRejectedValueOnce(new Error('timeout'));
    const log = vi.fn();
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', log, NOW);

    expect(r).toEqual({ imported: 1, skipped: 0, unresolvedSymbols: [] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not find the new per-account assets to price: timeout'));
  });

  it('keeps going past a holding it cannot price, and says why', async () => {
    const wf = withBasket();
    wf.pricing.updateQuote.mockRejectedValueOnce(new Error('refused'));
    const log = vi.fn();
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', log, NOW);

    expect(r).toMatchObject({ imported: 1, pricedFromFeed: [] });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not price MODEL BASKET (AAAA1111) from SimpleFin: refused'));
  });

  it('reads nothing and moves nothing without an account tag', async () => {
    const wf = withBasket();
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), undefined, undefined, NOW);

    expect(r).toEqual({ imported: 0, skipped: 1, unresolvedSymbols: [] });
    expect(wf.pricing.getHoldings).not.toHaveBeenCalled();
  });
});
