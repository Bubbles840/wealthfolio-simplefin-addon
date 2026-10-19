/**
 * src/utils/holdings-prices.ts
 *
 * A price for each holding Wealthfolio cannot price itself, from what SimpleFin
 * says the holding is worth (shared/holdings.ts `feedPrices`).
 *
 * Wealthfolio values a position as shares × the asset's latest quote, and a
 * snapshot carries only the share count. A ticker gets its quotes from a market
 * data provider; a holding that is not a ticker never does (a basket of
 * stocks reported as one holding was valued at $0 while the bank reported its
 * market value).
 *
 * Which holdings need one (`needsFeedPrice`):
 *  - MANUAL quote mode: Wealthfolio prices these only from quotes someone
 *    writes, and the bank's figure is the best one there is.
 *  - MARKET quote mode with NO quote at all. Only an asset that existed before
 *    this sync is judged (an id from the pre-import check), so a ticker just
 *    created has had a market sync to get its first quote before its silence
 *    counts.
 *  - MARKET with quotes: never touched. A real ticker's provider price wins.
 *
 * Such a holding is priced on its own PER-ACCOUNT asset (shared/holdings.ts
 * `accountTag`), never on the shared one: Wealthfolio keeps one asset per
 * symbol across accounts, and two accounts' baskets under one name are two
 * different things. Pricing the shared asset let the last account written
 * value every account's shares.
 *
 * A snapshot import on a MANUAL asset also writes the day's price, from the
 * position's average cost (Wealthfolio manual_snapshot_service.rs). The feed's
 * price is written AFTER the import, and a manual quote is one per asset and
 * day (last write wins), so the market value is what stays.
 *
 * Quote ids: Wealthfolio derives a MANUAL quote's id from the asset and the
 * day and saves over it (quotes/service.rs `update_quote`, v3.10), so writing
 * the day's price on every sync replaces it rather than piling up rows.
 *
 * Nothing here fails a sync: each asset is tried on its own, and a host that
 * refuses the calls (an older one, or a missing permission) prices nothing.
 */
import { scopedSymbol, type FeedPrice, type HoldingsSnapshot } from '../../shared/holdings';
import type { HoldingsSyncOutcome } from '../../shared/sync-host';

/** The four host calls this needs, as the SDK names them. */
export interface PricingApi {
  getProfile(assetId: string): Promise<{ quoteMode?: string | null }>;
  updateQuoteMode(assetId: string, quoteMode: string): Promise<unknown>;
  getHistory(assetId: string): Promise<Array<{ close?: number | string | null }>>;
  updateQuote(assetId: string, quote: ManualQuote): Promise<void>;
}

export interface ManualQuote {
  id: string;
  createdAt: string;
  dataSource: 'MANUAL';
  timestamp: string;
  assetId: string;
  open: number;
  high: number;
  low: number;
  volume: number;
  close: number;
  adjclose: number;
  currency: string;
  notes: string;
}

export const FEED_PRICE_NOTE = 'Market value reported by SimpleFin';

/** Noon UTC on the snapshot's day, as Wealthfolio stamps its own snapshot quotes. */
const quoteTimestamp = (date: string) => `${date}T12:00:00.000Z`;

export function manualQuote(assetId: string, date: string, price: string, currency: string, now = new Date()): ManualQuote {
  const close = Number(price);
  return {
    id: `${date.replace(/-/g, '')}_${assetId.toUpperCase()}`,
    createdAt: now.toISOString(),
    dataSource: 'MANUAL',
    timestamp: quoteTimestamp(date),
    assetId,
    open: close,
    high: close,
    low: close,
    volume: 0,
    close,
    adjclose: close,
    currency,
    notes: FEED_PRICE_NOTE,
  };
}

const hasMarketPrice = (history: Array<{ close?: number | string | null }>) =>
  history.some((q) => Number(q.close) > 0);

/** Whether Wealthfolio has no price of its own for this asset (see above). A
 *  host that refuses the calls says no: nothing is moved or priced. */
export async function needsFeedPrice(api: PricingApi, assetId: string): Promise<boolean> {
  try {
    const mode = String((await api.getProfile(assetId))?.quoteMode ?? '').toUpperCase();
    if (mode === 'MANUAL') return true;
    return mode === 'MARKET' && !hasMarketPrice(await api.getHistory(assetId));
  } catch {
    return false;
  }
}

/**
 * Writes the day's price for every holding that needs one. `assetIds` maps an
 * UPPERCASED symbol to the id Wealthfolio's import check found for it before
 * this sync wrote anything. Returns the symbols priced.
 */
export async function priceHoldingsFromFeed(
  api: PricingApi,
  date: string,
  prices: readonly FeedPrice[],
  assetIds: ReadonlyMap<string, string>,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<string[]> {
  const priced: string[] = [];
  for (const { symbol, price, currency } of prices) {
    const assetId = assetIds.get(symbol.trim().toUpperCase());
    if (!assetId || !(Number(price) > 0)) continue;
    try {
      const profile = await api.getProfile(assetId);
      const mode = String(profile?.quoteMode ?? '').toUpperCase();
      if (mode !== 'MANUAL') {
        if (mode !== 'MARKET' || hasMarketPrice(await api.getHistory(assetId))) continue;
        await api.updateQuoteMode(assetId, 'MANUAL');
      }
      await api.updateQuote(assetId, manualQuote(assetId, date, price, currency));
      priced.push(symbol);
    } catch (e: any) {
      log(`[simplefin-sync] could not price ${symbol} from SimpleFin: ${e?.message ?? e}`);
    }
  }
  return priced;
}

/** The snapshot calls the holdings write needs, as the SDK names them. */
export interface SnapshotIo {
  checkImport(wfAccountId: string, snapshots: HoldingsSnapshot[]): Promise<{
    existingDates: string[];
    symbols: Array<{ symbol: string; found: boolean; assetId?: string }>;
    validationErrors: string[];
  }>;
  importSnapshots(wfAccountId: string, snapshots: HoldingsSnapshot[]): Promise<{ snapshotsImported: number; errors: string[] }>;
}

const symbolKey = (symbol: string) => symbol.trim().toUpperCase();

/**
 * One account's positions for a date, with every holding that needs a price
 * from the feed moved to its own per-account asset and priced there.
 *
 *  1. One check, over the snapshot as the bank names it plus each priced
 *     holding's per-account symbol: which assets already exist, and their ids.
 *  2. A holding moves to its per-account asset when its symbol was made from
 *     its description (never a ticker), when that asset exists, or when the
 *     shared one needs a feed price (`needsFeedPrice`). The new asset is
 *     created priced by hand (`quoteMode: 'MANUAL'`).
 *  3. The snapshot is written unless the date already has one, except on the
 *     day a holding first moves: a snapshot is one row per account and date in
 *     Wealthfolio (stable id), so writing again replaces the day's positions.
 *  4. The feed's price is written on each per-account asset, every sync.
 */
export async function syncHoldingsWithFeedPrices(
  io: SnapshotIo,
  pricing: PricingApi,
  wfAccountId: string,
  snapshot: HoldingsSnapshot,
  prices: readonly FeedPrice[],
  tag: string | undefined,
  log?: (line: string) => void,
): Promise<HoldingsSyncOutcome> {
  const priced = new Map(prices.map((p): [string, FeedPrice] => [symbolKey(p.symbol), p]));
  const scoped = (symbol: string) => scopedSymbol(symbol, tag!);
  const candidates = tag ? snapshot.positions.filter((p) => priced.has(symbolKey(p.symbol))) : [];

  const check = await io.checkImport(wfAccountId, [{
    ...snapshot,
    positions: [...snapshot.positions, ...candidates.map((p) => ({ ...p, symbol: scoped(p.symbol) }))],
  }]);
  if (check.validationErrors.length > 0) {
    throw new Error(check.validationErrors.join('; '));
  }
  // Ids of the assets that existed BEFORE this sync.
  const before = new Map(
    check.symbols
      .filter((s) => !!s.assetId)
      .map((s): [string, string] => [symbolKey(s.symbol), s.assetId!]),
  );

  const moving = new Set<string>();
  for (const p of candidates) {
    const shared = before.get(symbolKey(p.symbol));
    if (
      priced.get(symbolKey(p.symbol))!.fromDescription
      || before.has(symbolKey(scoped(p.symbol)))
      || (shared && await needsFeedPrice(pricing, shared))
    ) {
      moving.add(symbolKey(p.symbol));
    }
  }
  const written: HoldingsSnapshot = {
    ...snapshot,
    positions: snapshot.positions.map((p) =>
      moving.has(symbolKey(p.symbol)) ? { ...p, symbol: scoped(p.symbol), quoteMode: 'MANUAL' as const } : p),
  };
  const writtenKeys = new Set(written.positions.map((p) => symbolKey(p.symbol)));
  const unresolvedSymbols = check.symbols
    .filter((s) => !s.found && writtenKeys.has(symbolKey(s.symbol)))
    .map((s) => s.symbol);

  const dayOf = (value: string) => String(value).slice(0, 10);
  const firstMove = [...moving].some((k) => !before.has(symbolKey(scoped(priced.get(k)!.symbol))));
  let imported = 0;
  let skipped = 0;
  if (check.existingDates.some((d) => dayOf(d) === snapshot.date) && !firstMove) {
    skipped = 1;
  } else {
    const result = await io.importSnapshots(wfAccountId, [written]);
    if (result.errors.length > 0) {
      throw new Error(result.errors.join('; '));
    }
    imported = result.snapshotsImported;
  }

  if (moving.size === 0) return { imported, skipped, unresolvedSymbols };
  // A per-account asset created just now has an id only after the import.
  const ids = firstMove
    ? new Map(
      (await io.checkImport(wfAccountId, [written])).symbols
        .filter((s) => !!s.assetId)
        .map((s): [string, string] => [symbolKey(s.symbol), s.assetId!]),
    )
    : before;
  const scopedPrices = [...moving].map((k) => ({ ...priced.get(k)!, symbol: scoped(priced.get(k)!.symbol) }));
  const pricedFromFeed = await priceHoldingsFromFeed(pricing, snapshot.date, scopedPrices, ids, log);
  return { imported, skipped, unresolvedSymbols, pricedFromFeed };
}
