import { describe, it, expect, vi } from 'vitest';
import { priceHoldingsFromFeed, manualQuote, syncHoldingsWithFeedPrices, FEED_PRICE_NOTE, type PricingApi, type SnapshotIo } from './holdings-prices';
import type { FeedPrice, HoldingsSnapshot } from '../../shared/holdings';

/** A host with one asset per id, in the given quote mode, with the given quotes. */
function host(assets: Record<string, { quoteMode: string; quotes?: Array<{ close: number }> }>) {
  const api = {
    getProfile: vi.fn(async (id: string) => {
      if (!assets[id]) throw new Error(`no asset ${id}`);
      return { quoteMode: assets[id].quoteMode };
    }),
    updateQuoteMode: vi.fn(async (id: string, mode: string) => { assets[id].quoteMode = mode; }),
    getHistory: vi.fn(async (id: string) => assets[id]?.quotes ?? []),
    updateQuote: vi.fn(async () => {}),
  } satisfies PricingApi;
  return api;
}

const DAY = '2026-10-19';
// A basket reported as one holding: $50,000.00 for 400.5 shares.
const basket: FeedPrice = { symbol: 'MODEL BASKET', price: '124.84394507', currency: 'USD' };
const vti: FeedPrice = { symbol: 'VTI', price: '300.00', currency: 'USD' };
const ids = new Map([['MODEL BASKET', 'asset-basket'], ['VTI', 'asset-vti']]);

describe('priceHoldingsFromFeed', () => {
  it('switches an asset with no market price to manual and writes the day’s price', async () => {
    const api = host({ 'asset-basket': { quoteMode: 'MARKET' } });
    const priced = await priceHoldingsFromFeed(api, DAY, [basket], ids);

    expect(priced).toEqual(['MODEL BASKET']);
    expect(api.updateQuoteMode).toHaveBeenCalledWith('asset-basket', 'MANUAL');
    expect(api.updateQuote).toHaveBeenCalledWith('asset-basket', expect.objectContaining({
      assetId: 'asset-basket', dataSource: 'MANUAL', close: 124.84394507, currency: 'USD',
      timestamp: '2026-10-19T12:00:00.000Z',
    }));
  });

  it('prices an asset that is already manual, without touching its mode', async () => {
    const api = host({ 'asset-basket': { quoteMode: 'MANUAL' } });
    expect(await priceHoldingsFromFeed(api, DAY, [basket], ids)).toEqual(['MODEL BASKET']);
    expect(api.updateQuoteMode).not.toHaveBeenCalled();
    expect(api.getHistory).not.toHaveBeenCalled();
    expect(api.updateQuote).toHaveBeenCalledTimes(1);
  });

  it('never touches a ticker the market prices', async () => {
    const api = host({ 'asset-vti': { quoteMode: 'MARKET', quotes: [{ close: 299.5 }] } });
    expect(await priceHoldingsFromFeed(api, DAY, [vti], ids)).toEqual([]);
    expect(api.updateQuoteMode).not.toHaveBeenCalled();
    expect(api.updateQuote).not.toHaveBeenCalled();
  });

  it('reads only zero-priced quotes as no price', async () => {
    const api = host({ 'asset-basket': { quoteMode: 'MARKET', quotes: [{ close: 0 }] } });
    expect(await priceHoldingsFromFeed(api, DAY, [basket], ids)).toEqual(['MODEL BASKET']);
  });

  it('leaves an asset this sync just created for a later sync to judge', async () => {
    const api = host({});
    expect(await priceHoldingsFromFeed(api, DAY, [basket], new Map())).toEqual([]);
    expect(api.getProfile).not.toHaveBeenCalled();
  });

  it('matches symbols the way the import check reports them: trimmed, upper case', async () => {
    const api = host({ 'asset-basket': { quoteMode: 'MANUAL' } });
    expect(await priceHoldingsFromFeed(api, DAY, [{ ...basket, symbol: ' model basket ' }], ids)).toEqual([' model basket ']);
  });

  it('keeps going past an asset it cannot price, and says why', async () => {
    const api = host({ 'asset-vti': { quoteMode: 'MANUAL' } });
    const log = vi.fn();
    expect(await priceHoldingsFromFeed(api, DAY, [basket, vti], ids, log)).toEqual(['VTI']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not price MODEL BASKET'));
  });

  it('prices nothing on a host that refuses the calls', async () => {
    const api = host({});
    api.getProfile.mockRejectedValue(new Error("Unknown addon host API method 'assets.getProfile'"));
    expect(await priceHoldingsFromFeed(api, DAY, [basket, vti], ids, () => {})).toEqual([]);
  });
});

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
 * every account; one manual quote per asset and day, the last write winning;
 * a snapshot is one row per account and date; and importing a snapshot onto a
 * MANUAL asset writes the day's price from the position's average cost.
 */
function wealthfolio() {
  const assets = new Map<string, { id: string; quoteMode: string }>();
  const quotes = new Map<string, number>(); // `${assetId}|${day}` → close
  const snapshots = new Map<string, HoldingsSnapshot>(); // `${account}|${date}`
  const key = (s: string) => s.trim().toUpperCase();
  const io: SnapshotIo = {
    async checkImport(account, [snap]) {
      return {
        existingDates: [...snapshots.keys()].filter((k) => k.startsWith(`${account}|`)).map((k) => k.split('|')[1]),
        symbols: snap.positions.map((p) => {
          const asset = assets.get(key(p.symbol));
          return { symbol: key(p.symbol), found: !!asset, ...(asset ? { assetId: asset.id } : {}) };
        }),
        validationErrors: [],
      };
    },
    async importSnapshots(account, [snap]) {
      for (const p of snap.positions) {
        let asset = assets.get(key(p.symbol));
        if (!asset) {
          asset = { id: `asset-${assets.size + 1}`, quoteMode: p.quoteMode ?? 'MARKET' };
          assets.set(key(p.symbol), asset);
        }
        if (asset.quoteMode === 'MANUAL' && p.avgCost) quotes.set(`${asset.id}|${snap.date}`, Number(p.avgCost));
      }
      snapshots.set(`${account}|${snap.date}`, snap);
      return { snapshotsImported: 1, errors: [] };
    },
  };
  const byId = (id: string) => [...assets.values()].find((a) => a.id === id)!;
  const pricing: PricingApi = {
    async getProfile(id) { return { quoteMode: byId(id).quoteMode }; },
    async updateQuoteMode(id, mode) { byId(id).quoteMode = mode; },
    async getHistory(id) {
      return [...quotes].filter(([k]) => k.startsWith(`${id}|`)).map(([, close]) => ({ close }));
    },
    async updateQuote(id, quote) { quotes.set(`${id}|${quote.timestamp.slice(0, 10)}`, quote.close); },
  };
  /** What a position is worth in this account on this day, as Wealthfolio values it. */
  const value = (account: string, date: string, symbolPrefix: string) => {
    const snap = snapshots.get(`${account}|${date}`)!;
    const p = snap.positions.find((x) => key(x.symbol).startsWith(key(symbolPrefix)))!;
    const asset = assets.get(key(p.symbol))!;
    return { symbol: p.symbol, value: Math.round(Number(p.quantity) * (quotes.get(`${asset.id}|${date}`) ?? 0) * 100) / 100 };
  };
  return { io, pricing, assets, quotes, snapshots, value };
}

const snap = (symbol: string, quantity: string, avgCost?: string): HoldingsSnapshot => ({
  date: DAY,
  positions: [{ symbol, quantity, currency: 'USD', ...(avgCost ? { avgCost } : {}) }],
  cashBalances: { USD: '0' },
});

describe('syncHoldingsWithFeedPrices', () => {
  // Two accounts each hold their own basket under one symbol. Priced on the
  // one shared asset, the second account's price valued the first's shares.
  const abcd = { snapshot: snap('MODEL BASKET', '400.5', '250.00'), price: '124.84394507' };
  const wxyz = { snapshot: snap('MODEL BASKET', '100', '240.00'), price: '150.00' };
  const priceOf = (p: string): FeedPrice[] => [{ symbol: 'MODEL BASKET', price: p, currency: 'USD' }];

  it('gives each account its own asset for a holding Wealthfolio cannot price, so each keeps its own value', async () => {
    const wf = wealthfolio();
    // Before this fix: one shared MARKET asset with no price, already on file for the day.
    await wf.io.importSnapshots('wf-abcd', [abcd.snapshot]);
    await wf.io.importSnapshots('wf-wxyz', [wxyz.snapshot]);

    const a = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-abcd', abcd.snapshot, priceOf(abcd.price), 'ABCD');
    const b = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-wxyz', wxyz.snapshot, priceOf(wxyz.price), 'WXYZ');

    expect(a.pricedFromFeed).toEqual(['MODEL BASKET (ABCD)']);
    expect(b.pricedFromFeed).toEqual(['MODEL BASKET (WXYZ)']);
    // The day's snapshot was already on file, and was REPLACED on the day the holding moved.
    expect(a.imported).toBe(1);
    expect(wf.value('wf-abcd', DAY, 'MODEL BASKET')).toEqual({ symbol: 'MODEL BASKET (ABCD)', value: 50000.00 });
    expect(wf.value('wf-wxyz', DAY, 'MODEL BASKET')).toEqual({ symbol: 'MODEL BASKET (WXYZ)', value: 15000 });
    expect(wf.assets.get('MODEL BASKET (ABCD)')!.quoteMode).toBe('MANUAL');
  });

  it('keeps the market value, not the average cost the import writes on a manual asset', async () => {
    const wf = wealthfolio();
    await wf.io.importSnapshots('wf-abcd', [abcd.snapshot]);
    await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-abcd', abcd.snapshot, priceOf(abcd.price), 'ABCD');
    // The next day: a new snapshot is imported onto the now-manual asset.
    const tomorrow = { ...abcd.snapshot, date: '2026-10-20' };
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-abcd', tomorrow, priceOf(abcd.price), 'ABCD');
    expect(r.imported).toBe(1);
    expect(wf.value('wf-abcd', '2026-10-20', 'MODEL BASKET').value).toBe(50000.00);
  });

  it('skips a snapshot already on file once the holding has moved, and still writes the price', async () => {
    const wf = wealthfolio();
    await wf.io.importSnapshots('wf-abcd', [abcd.snapshot]);
    await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-abcd', abcd.snapshot, priceOf(abcd.price), 'ABCD');
    const again = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-abcd', abcd.snapshot, priceOf('220.00'), 'ABCD');
    expect(again).toMatchObject({ imported: 0, skipped: 1, pricedFromFeed: ['MODEL BASKET (ABCD)'] });
    expect(wf.value('wf-abcd', DAY, 'MODEL BASKET').value).toBe(88110);
  });

  it('leaves a ticker the market prices on its shared asset, unpriced by the add-on', async () => {
    const wf = wealthfolio();
    await wf.io.importSnapshots('wf-abcd', [snap('VTI', '2')]);
    wf.quotes.set(`${wf.assets.get('VTI')!.id}|2026-10-18`, 299.5);
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-abcd', snap('VTI', '2'), [{ symbol: 'VTI', price: '300', currency: 'USD' }], 'ABCD');
    expect(r).toEqual({ imported: 0, skipped: 1, unresolvedSymbols: [] });
    expect(wf.assets.has('VTI (ABCD)')).toBe(false);
  });

  it('leaves a symbol it has never seen on the shared asset until a later sync can judge it', async () => {
    const wf = wealthfolio();
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-abcd', abcd.snapshot, priceOf(abcd.price), 'ABCD');
    expect(r.imported).toBe(1);
    expect(r.pricedFromFeed).toBeUndefined();
    expect([...wf.assets.keys()]).toEqual(['MODEL BASKET']);
  });

  it('puts a holding named from its description on its own asset from the first sync', async () => {
    // Never a ticker, so there is nothing to wait for: no shared asset is made.
    const wf = wealthfolio();
    const fund = snap('TARGET DATE FUND 2060', '40');
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-plan', fund,
      [{ symbol: 'TARGET DATE FUND 2060', price: '250.00', currency: 'USD', fromDescription: true }], '123456');
    expect(r).toMatchObject({ imported: 1, pricedFromFeed: ['TARGET DATE FUND 2060 (123456)'] });
    expect([...wf.assets.keys()]).toEqual(['TARGET DATE FUND 2060 (123456)']);
    expect(wf.assets.get('TARGET DATE FUND 2060 (123456)')!.quoteMode).toBe('MANUAL');
    expect(wf.value('wf-plan', DAY, 'TARGET DATE')).toEqual({ symbol: 'TARGET DATE FUND 2060 (123456)', value: 10000 });
  });

  it('prices nothing and moves nothing without an account tag', async () => {
    const wf = wealthfolio();
    await wf.io.importSnapshots('wf-abcd', [abcd.snapshot]);
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-abcd', abcd.snapshot, priceOf(abcd.price), undefined);
    expect(r).toEqual({ imported: 0, skipped: 1, unresolvedSymbols: [] });
    expect(wf.quotes.size).toBe(0);
  });
});
