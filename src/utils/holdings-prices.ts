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
 * Such a holding is priced on its own PER-ACCOUNT asset (shared/holdings.ts
 * `accountTag`), never on the shared one: Wealthfolio keeps one asset per
 * symbol across accounts, and two accounts' baskets under one name are two
 * different things.
 *
 * Which holdings get one, decided again on every sync:
 *  - A holding filed under its description (no symbol from the bank): always.
 *    It is never a ticker.
 *  - A holding already on its per-account asset: stays there until the shared
 *    asset has a market quote, then moves back.
 *  - A holding on the shared asset, or new to the account while its shared
 *    asset already exists: moves only when the shared asset is priced by the
 *    market (MARKET), has no market quote at all, and is older than
 *    `UNPRICED_FOR_MS`. A ticker bought yesterday has had no chance to get its
 *    first quote yet (a rate limit, an outage, a sync that ran first).
 *  - A shared asset the person set to MANUAL themselves is theirs: never moved,
 *    never priced.
 *
 * What it costs per sync: one holdings read for the account, which gives every
 * held asset's mode and price at once. A ticker the market prices costs nothing
 * more. Only a holding with no price gets an asset and quote read, and the
 * day's price is written only when it changed (a quote write starts a portfolio
 * recalculation on a server).
 *
 * A snapshot import on a MANUAL asset also writes the day's price, from the
 * position's average cost (Wealthfolio manual_snapshot_service.rs). The feed's
 * price is written AFTER the import, and a manual quote is one per asset and
 * day (last write wins), so the market value is what stays.
 *
 * A holding the feed sends without a cost keeps the cost Wealthfolio already has
 * for it, new shares added at the feed's price that day (shared/holdings.ts
 * `carriedCost`), from the same holdings read: a
 * snapshot without one is stored at cost 0, and Wealthfolio then shows no gain
 * for the account at all. The cost goes onto a shared asset the person prices by
 * hand only when it has a price to put back: the import writes the cost as that
 * day's price there, so the price from before the import (that day's, else the
 * latest) is written back after it (#83).
 *
 * A snapshot that matches what Wealthfolio already holds (the same assets, share
 * counts, the costs SimpleFin sent, and cash) is not written (#83,
 * shared/holdings.ts `sameAsHeld`): Wealthfolio sets the account's net
 * contribution to 0 on every snapshot it saves, and a write also resets a cost
 * basis entered by hand. The day's feed prices are still written.
 *
 * Nothing here fails the sync: a failed holdings read skips the account's
 * snapshot for this sync (writing it without knowing which holdings are on
 * per-account assets would move them back), and a failed price is logged.
 */
import { carriedCost, sameAsHeld, sameCurrency, scopedSymbol, type FeedPrice, type HoldingsSnapshot } from '../../shared/holdings';
import type { HoldingsSyncOutcome } from '../../shared/sync-host';

/** How long a MARKET asset must have had no quote before it is priced from the feed. */
export const UNPRICED_FOR_MS = 3 * 24 * 60 * 60 * 1000;

/** An account's holding, as much of it as this reads. Wealthfolio names the
 *  mode `pricingMode` here (`Instrument.pricing_mode`) and `symbol` is the
 *  asset's display code, which drops a known exchange suffix ("SHOP.TO" shows
 *  as "SHOP"): a holding is looked up by its asset id wherever one is known. */
export interface HeldAsset {
  instrument?: { id: string; symbol: string; pricingMode?: string | null } | null;
  price?: number | null;
  quantity?: number | string | null;
  costBasis?: { local?: number | null } | null;
  /** The currency `costBasis.local` and `price` are in. */
  localCurrency?: string | null;
  /** `cash` for a cash line, else `security` / `alternativeAsset`. */
  holdingType?: string | null;
}

const modeOf = (h: HeldAsset | undefined) => h?.instrument?.pricingMode ?? undefined;

/** The host calls this needs, as the SDK names them. */
export interface PricingApi {
  getHoldings(wfAccountId: string): Promise<HeldAsset[]>;
  getProfile(assetId: string): Promise<{ quoteMode?: string | null; createdAt?: string | null }>;
  updateQuoteMode(assetId: string, quoteMode: string): Promise<unknown>;
  getHistory(assetId: string): Promise<Array<{ timestamp?: string; close?: number | string | null; dataSource?: string | null; currency?: string | null; notes?: string | null }>>;
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

export function manualQuote(assetId: string, date: string, price: string, currency: string, now = new Date(), notes = FEED_PRICE_NOTE): ManualQuote {
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
    notes,
  };
}

type History = Awaited<ReturnType<PricingApi['getHistory']>>;

/** A quote from a provider: what makes an asset priced by the market. */
const hasMarketQuote = (history: History) =>
  history.some((q) => Number(q.close) > 0 && String(q.dataSource ?? '').toUpperCase() !== 'MANUAL');

const symbolKey = (symbol: string) => symbol.trim().toUpperCase();
const dayOf = (value: string | undefined) => String(value ?? '').slice(0, 10);

/** A price to write back after a snapshot import overwrote it. */
interface KeptPrice { close: number; currency?: string; notes: string }

/** The price an import is about to overwrite on `date`: a MANUAL quote dated
 *  that day, else any quote dated that day, else the latest before it. */
function priceToRestore(history: History, date: string): KeptPrice | undefined {
  const usable = history.filter((q) => Number(q.close) > 0);
  const manual = (q: History[number]) => String(q.dataSource ?? '').toUpperCase() === 'MANUAL';
  const q = usable.find((x) => dayOf(x.timestamp) === date && manual(x))
    ?? usable.find((x) => dayOf(x.timestamp) === date)
    ?? usable.filter((x) => dayOf(x.timestamp) < date).sort((a, b) => (dayOf(a.timestamp) < dayOf(b.timestamp) ? 1 : -1))[0];
  if (!q) return undefined;
  return { close: Number(q.close), ...(q.currency ? { currency: q.currency } : {}), notes: q.notes ?? '' };
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

/** Whether a shared asset has gone unpriced long enough to move a holding off
 *  it (see the header). `known` is what the account's holdings already say
 *  about it; without them the asset's profile is read. Any failed read says no. */
async function sharedIsUnpriced(
  api: PricingApi,
  assetId: string,
  now: Date,
  known?: { quoteMode?: string | null; price?: number | null },
): Promise<boolean> {
  if (known && Number(known.price) > 0) return false;
  if (known?.quoteMode && known.quoteMode.toUpperCase() !== 'MARKET') return false;
  try {
    const profile = await api.getProfile(assetId);
    const mode = known?.quoteMode ?? profile?.quoteMode;
    if (String(mode ?? '').toUpperCase() !== 'MARKET') return false;
    const created = Date.parse(String(profile?.createdAt ?? ''));
    if (!Number.isFinite(created) || now.getTime() - created < UNPRICED_FOR_MS) return false;
    return !hasMarketQuote(await api.getHistory(assetId));
  } catch {
    return false;
  }
}

/**
 * One account's positions for a date, with every holding that needs a price
 * from the feed on its per-account asset, priced there.
 *
 *  1. The account's holdings: which assets it holds, their mode and price.
 *  2. Which holdings are on, or move to, their per-account asset (header).
 *  3. One import check over the snapshot, with those holdings' per-account
 *     symbols added: the assets that exist, and their ids. A holding on its
 *     per-account asset whose shared asset now has a market quote moves back.
 *  4. The snapshot is written unless it says what Wealthfolio already holds, or
 *     the date already has one, except on the day a holding first moves: a snapshot is one row per account and date in
 *     Wealthfolio, so writing again replaces the day's positions. A move back
 *     shows from the next day's snapshot.
 *  5. The feed's price is written on each per-account asset when it changed.
 */
export async function syncHoldingsWithFeedPrices(
  io: SnapshotIo,
  pricing: PricingApi,
  wfAccountId: string,
  snapshot: HoldingsSnapshot,
  prices: readonly FeedPrice[],
  tag: string | undefined,
  log: (line: string) => void = (line) => console.warn(line),
  now = new Date(),
): Promise<HoldingsSyncOutcome> {
  // A symbol the feed sends in two currencies is left where it is: both lines
  // would land on one per-account asset, which has one price a day.
  const currencies = new Map<string, Set<string>>();
  for (const p of prices) currencies.set(symbolKey(p.symbol), (currencies.get(symbolKey(p.symbol)) ?? new Set()).add(p.currency));
  const priced = new Map(
    prices.filter((p) => Number(p.price) > 0 && currencies.get(symbolKey(p.symbol))!.size === 1)
      .map((p): [string, FeedPrice] => [symbolKey(p.symbol), p]),
  );
  const scoped = (symbol: string) => scopedSymbol(symbol, tag!);

  // 1–2. Without the holdings, a holding already on its per-account asset
  // would be written back onto the shared one, so the account waits a sync.
  const moving = new Set<string>();
  let held = new Map<string, HeldAsset>();
  let heldById = new Map<string, HeldAsset>();
  /** The asset each holding on its shared asset was judged by before the check:
   *  a shown code can be another listing's (SHOP.TO shows as SHOP), so the
   *  check's id decides whether the judgement stands. */
  const judgedBy = new Map<string, string>();
  /** Holdings already on their per-account asset that the feed sends no usable
   *  price for today: they stay there at their last price. Written back onto the
   *  shared asset, which nothing prices, they would be worth $0. */
  const kept = new Set<string>();
  /** The whole holdings read, cash lines included; null when none was made. */
  let read: HeldAsset[] | null = null;
  if (tag && snapshot.positions.length > 0) {
    let holdings: HeldAsset[];
    try {
      holdings = await pricing.getHoldings(wfAccountId);
    } catch (e: any) {
      throw new Error(`could not read the account's holdings: ${e?.message ?? e}`);
    }
    read = holdings ?? [];
    const usable = (holdings ?? []).filter((h) => h.instrument?.id && h.instrument.symbol);
    held = new Map(usable.map((h): [string, HeldAsset] => [symbolKey(h.instrument!.symbol), h]));
    heldById = new Map(usable.map((h): [string, HeldAsset] => [h.instrument!.id, h]));
    for (const p of snapshot.positions) {
      const key = symbolKey(p.symbol);
      const feed = priced.get(key);
      if (!feed) {
        if (held.has(symbolKey(scoped(p.symbol)))) kept.add(key);
        continue;
      }
      if (feed.fromDescription) moving.add(key);
      else if (held.has(symbolKey(scoped(p.symbol)))) moving.add(key); // may move back in step 3
      else if (held.has(key)) {
        const h = held.get(key)!;
        judgedBy.set(key, h.instrument!.id);
        if (await sharedIsUnpriced(pricing, h.instrument!.id, now, { quoteMode: modeOf(h), price: h.price })) moving.add(key);
      }
    }
  }

  // 3. A holding filed under its description is checked under its per-account
  // symbol only: its bare name is never a ticker, and checking it would send
  // Wealthfolio to its price provider on every sync.
  // A kept holding is checked under its per-account symbol only, for the same reason.
  const byDescription = (p: { symbol: string }) => (!!priced.get(symbolKey(p.symbol))?.fromDescription && moving.has(symbolKey(p.symbol)))
    || kept.has(symbolKey(p.symbol));
  const check = await io.checkImport(wfAccountId, [{
    ...snapshot,
    positions: [
      ...snapshot.positions.filter((p) => !byDescription(p)),
      ...snapshot.positions.filter((p) => moving.has(symbolKey(p.symbol)) || kept.has(symbolKey(p.symbol)))
        .map((p) => ({ ...p, symbol: scoped(p.symbol) })),
    ],
  }]);
  if (check.validationErrors.length > 0) {
    throw new Error(check.validationErrors.join('; '));
  }
  const ids = new Map(
    check.symbols.filter((s) => !!s.assetId).map((s): [string, string] => [symbolKey(s.symbol), s.assetId!]),
  );
  // For a bare symbol with no asset of exactly that code, the check searches
  // the assets' codes (Wealthfolio 3.12: any code that contains it), so it can
  // hand back the per-account asset this account holds the holding on. That is
  // not a shared asset: taken as one, the holding would be written under its
  // bare symbol, onto a new asset nothing prices, and the account would be
  // worth $0.
  for (const p of snapshot.positions) {
    const key = symbolKey(p.symbol);
    const own = tag ? held.get(symbolKey(scoped(p.symbol)))?.instrument?.id : undefined;
    if (own && ids.get(key) === own) ids.delete(key);
  }
  // A holding the account does not hold yet, under either symbol, whose shared
  // asset already exists (another account's, or from before): judged from that
  // asset, so it does not spend a sync valued at $0 first. A holding whose
  // symbol showed differently (an exchange suffix), or that was judged by
  // another listing's asset above, is found here by its id.
  if (tag) {
    for (const p of snapshot.positions) {
      const key = symbolKey(p.symbol);
      const sharedId = ids.get(key);
      if (!priced.has(key) || !sharedId) continue;
      if (judgedBy.has(key)) {
        if (judgedBy.get(key) === sharedId) continue;
        moving.delete(key);
      } else if (moving.has(key) || held.has(symbolKey(scoped(p.symbol)))) continue;
      const h = heldById.get(sharedId);
      if (await sharedIsUnpriced(pricing, sharedId, now, h && { quoteMode: modeOf(h), price: h.price })) moving.add(key);
    }
  }
  /** Holdings moving back to their shared asset today, which a market prices. */
  const movedBack = new Set<string>();
  for (const key of [...moving]) {
    const feed = priced.get(key)!;
    const sharedId = ids.get(key);
    const scopedId = ids.get(symbolKey(scoped(feed.symbol)));
    // A fuzzy match can hand back the shared asset for the per-account symbol:
    // pricing it would value every account's shares from this one.
    if (sharedId && scopedId === sharedId) {
      moving.delete(key);
      continue;
    }
    if (!feed.fromDescription && scopedId && sharedId) {
      try {
        if (hasMarketQuote(await pricing.getHistory(sharedId))) {
          moving.delete(key);
          movedBack.add(key);
        }
      } catch {
        // Unknown: it stays where it is.
      }
    }
  }

  // 4. (decided before the positions are built.) Only a real change of asset
  // forces a write: `moving` holds every holding on, or moving to, its
  // per-account asset, so one staying there must not.
  const firstMove = [...moving].some((k) => !ids.has(symbolKey(scoped(priced.get(k)!.symbol))));
  /** This holding lands on its own per-account asset (one place decides it, so
   *  the comparison below can never differ from what is written). */
  const onOwnAsset = (key: string) => moving.has(key) || kept.has(key);
  const unchanged = read !== null && sameAsHeld(
    snapshot.positions.map((p) => {
      const key = symbolKey(p.symbol);
      const own = onOwnAsset(key);
      return {
        assetId: ids.get(own ? symbolKey(scoped(p.symbol)) : key),
        quantity: p.quantity,
        currency: p.currency,
        ...(p.avgCost ? { sentAvgCost: p.avgCost } : {}),
      };
    }),
    snapshot.cashBalances,
    read,
  );
  const write = !unchanged && (firstMove || !check.existingDates.some((d) => dayOf(d) === snapshot.date));

  const costUnknown: string[] = [];
  // A holding moving back to its shared asset today: the account does not hold
  // that asset, so its mode comes from one profile read. Only on that day.
  const backModes = new Map<string, string | undefined>();
  for (const key of movedBack) {
    const sharedId = ids.get(key)!;
    backModes.set(key, await pricing.getProfile(sharedId).then((a) => a?.quoteMode ?? undefined, () => undefined));
  }
  /** The price an import on a MANUAL asset overwrites with the cost, read before
   *  it (only when a snapshot is written): undefined when there is none or
   *  nothing to read, null when the history could not be read. */
  const readPrice = async (assetId: string | undefined): Promise<KeptPrice | undefined | null> => {
    if (!write || !assetId) return undefined;
    try {
      return priceToRestore(await pricing.getHistory(assetId), snapshot.date);
    } catch {
      return null;
    }
  };
  /** Prices to write back after the import. */
  const restores: Array<{ assetId: string; symbol: string; currency: string; price: KeptPrice | null }> = [];
  const positions: HoldingsSnapshot['positions'] = [];
  for (const p of snapshot.positions) {
    const key = symbolKey(p.symbol);
    const own = onOwnAsset(key);
    let out = own ? { ...p, symbol: scoped(p.symbol), quoteMode: 'MANUAL' as const } : p;
    if (tag) {
      const sharedId = ids.get(key);
      // The shared asset's mode, as the read reports it. Only a reported MANUAL is
      // hand-priced: an unreported mode may be a market-priced asset, where a
      // MANUAL quote could replace the market's quote for the day.
      const sharedMode = modeOf(heldById.get(sharedId ?? '')) ?? backModes.get(key);
      const byHand = !own && sharedMode?.toUpperCase() === 'MANUAL';
      if (p.avgCost) {
        // A cost SimpleFin sent: the import still writes it as a hand-priced asset's price.
        if (byHand) {
          const price = await readPrice(sharedId);
          if (price !== undefined) restores.push({ assetId: sharedId!, symbol: p.symbol, currency: p.currency, price });
        }
      } else {
        // The holding as Wealthfolio has it now: on its per-account asset, or on
        // the shared one found by id (a shown code drops an exchange suffix, and
        // a bare code can be another listing's). One moving today is still held
        // on the shared asset.
        const h = held.get(symbolKey(scoped(p.symbol))) ?? heldById.get(sharedId ?? '');
        // Onto a shared asset only when the market prices it, or it is priced by
        // hand and has a price to put back. A mode the read does not report
        // counts as neither.
        const carryable = !!h && (own || sharedMode?.toUpperCase() === 'MARKET' || byHand);
        // A cost in another currency cannot be added to: carry nothing. Not an
        // ask: the mismatch stays, so every new day would ask again and write
        // over a cost entered by hand. Home lists the holding as without a cost.
        if (carryable && !(h!.localCurrency && p.currency && !sameCurrency(h!.localCurrency, p.currency))) {
          const carried = carriedCost(p.quantity, { quantity: h!.quantity, cost: h!.costBasis?.local }, priced.get(key)?.price);
          let price: KeptPrice | null | undefined;
          if (byHand && (carried.ask || carried.avgCost)) price = await readPrice(sharedId);
          // A hand-priced fund with no usable price: nothing carried, nothing asked.
          if (!byHand || price) {
            if (carried.ask) costUnknown.push(p.symbol);
            if (carried.avgCost) {
              out = { ...out, avgCost: carried.avgCost };
              if (price) restores.push({ assetId: sharedId!, symbol: p.symbol, currency: p.currency, price });
            }
          }
        }
      }
      // A kept holding's import writes the day's price from its average cost (a
      // MANUAL asset): put back the price it had.
      if (kept.has(key) && out.avgCost) {
        const ownId = ids.get(symbolKey(out.symbol));
        const price = await readPrice(ownId);
        if (price !== undefined) restores.push({ assetId: ownId!, symbol: p.symbol, currency: p.currency, price });
      }
    }
    positions.push(out);
  }
  const written: HoldingsSnapshot = { ...snapshot, positions };
  // A per-account symbol is priced here, never by a provider: not unresolved.
  const unresolvedKeys = new Set(
    snapshot.positions.map((p) => symbolKey(p.symbol)).filter((k) => !onOwnAsset(k)),
  );
  const unresolvedSymbols = check.symbols
    .filter((s) => !s.found && unresolvedKeys.has(symbolKey(s.symbol)))
    .map((s) => s.symbol);

  // 4.
  let imported = 0;
  let skipped = 0;
  if (!write) {
    skipped = 1;
  } else {
    const result = await io.importSnapshots(wfAccountId, [written]);
    if (result.errors.length > 0) {
      throw new Error(result.errors.join('; '));
    }
    imported = result.snapshotsImported;
  }
  // The import wrote each cost as the day's price of a MANUAL asset: put back
  // the price read before it. Twice before giving up.
  const priceNotRestored: string[] = [];
  if (imported > 0) {
    for (const r of restores) {
      let failure: unknown = r.price === null ? new Error('its price history could not be read') : undefined;
      if (r.price) {
        const quote = manualQuote(r.assetId, snapshot.date, String(r.price.close), r.price.currency ?? r.currency, now, r.price.notes);
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await pricing.updateQuote(r.assetId, quote);
            failure = undefined;
            break;
          } catch (e) {
            failure = e;
          }
        }
      }
      if (failure !== undefined) {
        log(`[simplefin-sync] could not put back the price of ${r.symbol}: ${(failure as any)?.message ?? failure}`);
        priceNotRestored.push(r.symbol);
      }
    }
  }
  // Asked for once, on the day the snapshot without a cost is written.
  const unknown = {
    ...(imported > 0 && costUnknown.length > 0 ? { costUnknown } : {}),
    ...(priceNotRestored.length > 0 ? { priceNotRestored } : {}),
  };
  if (moving.size === 0) return { imported, skipped, unresolvedSymbols, ...unknown };

  // 5. A per-account asset created just now has an id only after the import.
  // The snapshot is saved by now, so a failed read only skips today's prices.
  let scopedIds = ids;
  if (firstMove) {
    try {
      const after = await io.checkImport(wfAccountId, [written]);
      scopedIds = new Map(
        after.symbols.filter((s) => !!s.assetId).map((s): [string, string] => [symbolKey(s.symbol), s.assetId!]),
      );
    } catch (e: any) {
      log(`[simplefin-sync] could not find the new per-account assets to price: ${e?.message ?? e}`);
      return { imported, skipped, unresolvedSymbols, ...unknown };
    }
  }
  const pricedFromFeed: string[] = [];
  for (const key of moving) {
    const feed = priced.get(key)!;
    const symbol = scoped(feed.symbol);
    const assetId = scopedIds.get(symbolKey(symbol));
    if (!assetId || assetId === ids.get(key)) continue;
    try {
      const mode = modeOf(heldById.get(assetId)) ?? (await pricing.getProfile(assetId))?.quoteMode;
      if (String(mode ?? '').toUpperCase() !== 'MANUAL') {
        await pricing.updateQuoteMode(assetId, 'MANUAL');
      }
      const today = (await pricing.getHistory(assetId))
        .find((q) => dayOf(q.timestamp) === snapshot.date && String(q.dataSource ?? '').toUpperCase() === 'MANUAL');
      if (today && Math.abs(Number(today.close) - Number(feed.price)) < 1e-8) continue;
      await pricing.updateQuote(assetId, manualQuote(assetId, snapshot.date, feed.price, feed.currency));
      pricedFromFeed.push(symbol);
    } catch (e: any) {
      log(`[simplefin-sync] could not price ${symbol} from SimpleFin: ${e?.message ?? e}`);
    }
  }
  return { imported, skipped, unresolvedSymbols, pricedFromFeed, ...unknown };
}
