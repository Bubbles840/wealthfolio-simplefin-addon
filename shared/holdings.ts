/**
 * shared/holdings.ts
 *
 * Turning SimpleFin's `holdings` array into the one snapshot Wealthfolio wants
 * for an investment account.
 *
 * Why this exists at all: until v1.50 the sync read `transactions` and ignored
 * `holdings` outright, so a brokerage account got its cash balance and its cash
 * activity and no positions — the account looked like a bank account that
 * happened to be at a broker. SimpleFin publishes the positions; nothing was
 * reading them.
 *
 * Why it is a pure function in `shared/`: the snapshot is a data transform with
 * a handful of load-bearing edge cases (below), and the two halves reach the
 * host differently — the addon calls the SDK's `snapshots` API, and the
 * companion CANNOT, because the self-hosted REST server exposes no snapshot
 * route (verified against Wealthfolio 3.8's router: `/snapshots/holdings` is a
 * read path only). Keeping the transform here means the edge cases are tested
 * once and the capability difference stays in the adapters.
 *
 * A snapshot is a FULL statement of what an account holds on a date, not a
 * delta. That single fact drives every decision in here: anything less than a
 * complete, usable positions list must produce NO snapshot rather than a
 * partial one, because a partial snapshot is indistinguishable from "I sold the
 * rest".
 */
import type { SimplefinAccount } from './types.js';

/** One line of a snapshot: a position, in the shape the host's snapshot import
 *  takes. Declared here rather than imported from the SDK so `shared/` stays
 *  SDK-free (the companion has no SDK); the addon adapter maps it across. */
export interface HoldingsPosition {
  symbol: string;
  /** Share count as a decimal STRING. Money and share counts never become
   *  floats in this codebase — the host takes strings and parses them with a
   *  decimal type, and routing through a JS number is how an 8-decimal crypto
   *  position loses its tail. */
  quantity: string;
  /** Per-share cost basis, absent when SimpleFin reported none. */
  avgCost?: string;
  currency: string;
  /** MANUAL creates the asset priced by hand (holdings-prices.ts sets it on a
   *  per-account asset). Absent: Wealthfolio's default, market pricing. */
  quoteMode?: 'MANUAL';
}

export interface HoldingsSnapshot {
  /** A bare `YYYY-MM-DD`, unlike an activity's date, which is a full instant. A
   *  snapshot is a valuation bucket for a calendar day, and the host's
   *  idempotency signal (`existingDates`) is keyed the same way. */
  date: string;
  positions: HoldingsPosition[];
  /** Currency → balance, as strings. SimpleFin reports one balance per account,
   *  so this map always has exactly one entry. */
  cashBalances: Record<string, string>;
}

/** A holding's price per share, from what the feed says it is worth. */
export interface FeedPrice {
  symbol: string;
  /** Decimal STRING, up to 8 places: market value ÷ shares. */
  price: string;
  currency: string;
  /** The symbol was made from the description (`holdingSymbol`): never a
   *  ticker, so it is priced from the feed on an asset of its own from the
   *  first sync, without waiting to see whether the market prices it. */
  fromDescription?: true;
}

/** Options for `toHoldingsSnapshot`. Both exist for determinism, not tuning. */
export interface HoldingsSnapshotOptions {
  /** IANA zone that names the snapshot's calendar day (Wealthfolio's own
   *  timezone setting, when the caller has it). Omitted, the runtime's zone is
   *  used: the browser's in the addon, `TZ` in the companion. */
  timeZone?: string | null;
  /** "Now", for the future-date clamp. Injectable so tests need no fake clock. */
  now?: Date;
}

/** `YYYY-MM-DD` for an instant, read on the calendar of `timeZone`. */
function calendarDay(instant: Date, timeZone?: string | null): string {
  const build = (zone?: string | null) =>
    new Intl.DateTimeFormat('en-US', {
      ...(zone ? { timeZone: zone } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = build(timeZone);
  } catch {
    // An unknown zone name throws RangeError. A bad setting must not cost the
    // account its snapshot; the runtime's own zone is the honest fallback.
    formatter = build(null);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Cash arithmetic is done on integers (millionths), never on floats: balances
// and market values arrive as decimal strings, and the codebase keeps money out
// of floating point.
const MICROS = 1000000n;
/** Slack, in millionths ($1.00), when deciding whether the holdings account for
 *  the whole balance. A feed's balance and its positions are read at slightly
 *  different moments, and brokers round market values per line. */
const BALANCE_TOLERANCE = 1000000n;

function parseMicros(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(String(value).trim());
  if (!match) return null;
  const fraction = (match[3] ?? '').padEnd(6, '0').slice(0, 6);
  const micros = BigInt(match[2]) * MICROS + BigInt(fraction || '0');
  return match[1] === '-' ? -micros : micros;
}

/** A non-negative decimal string as an integer and its count of decimals. */
function parseDecimal(value: string | number | null | undefined): { n: bigint; scale: number } | null {
  if (value === null || value === undefined) return null;
  const match = /^\+?(\d+)(?:\.(\d*))?$/.exec(String(value).trim());
  if (!match) return null;
  const fraction = match[2] ?? '';
  return { n: BigInt(match[1] + fraction), scale: fraction.length };
}

const AVG_COST_DECIMALS = 8;

/**
 * Per-share cost, or `undefined` when SimpleFin gave none.
 *
 * `cost_basis` is the position's TOTAL cost, so it is divided by the shares.
 * `purchase_price` is meant to be per share, but some providers send the total
 * there as well (the same figure as `cost_basis`), so it is only used when
 * there is no total. Zero means unknown, never free: a zero cost basis shows
 * up as fictional gains on the holdings page.
 */
function averageCost(
  costBasis: string | null | undefined,
  purchasePrice: string | null | undefined,
  shares: string,
): string | undefined {
  const total = parseDecimal(costBasis);
  const count = parseDecimal(shares);
  if (total && total.n > 0n && count && count.n > 0n) {
    // total / count, rounded half up to AVG_COST_DECIMALS.
    const num = total.n * 10n ** BigInt(count.scale + AVG_COST_DECIMALS) * 2n;
    const den = count.n * 10n ** BigInt(total.scale);
    const q = (num / den + 1n) / 2n;
    const unit = 10n ** BigInt(AVG_COST_DECIMALS);
    const fraction = (q % unit).toString().padStart(AVG_COST_DECIMALS, '0').replace(/0+$/, '');
    return fraction ? `${q / unit}.${fraction}` : `${q / unit}`;
  }
  const price = parseDecimal(purchasePrice);
  return price && price.n > 0n ? String(purchasePrice).trim() : undefined;
}

function formatMicros(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  let fraction = (abs % MICROS).toString().padStart(6, '0').replace(/0+$/, '');
  if (fraction.length < 2) fraction = fraction.padEnd(2, '0');
  return `${negative ? '-' : ''}${abs / MICROS}.${fraction}`;
}

/**
 * The cash line of an investment account's snapshot.
 *
 * SimpleFin's `balance` means different things at different brokers. Fidelity
 * (and most others) report the TOTAL account value: the positions plus any
 * cash. Writing that figure as the cash line on top of the positions counts
 * every holding twice, which is exactly what a Holdings-mode account showed:
 * "cash" equal to the sum of the holdings, and a total about double the truth.
 *
 * The holdings' own `market_value`s settle which convention a given account
 * uses, so the answer comes from the data instead of an assumption:
 *
 *  - balance accounts for the holdings, within a dollar: balance IS the total,
 *    and the cash is whatever is left over, usually nothing.
 *  - balance is smaller than the holdings by more than that: it cannot be a
 *    total, so it is cash alone, and is written as before.
 *  - balance exceeds the holdings by more than a dollar: the remainder is cash.
 *
 * Every holding counts toward the sum, including the ones the snapshot drops
 * for lacking a symbol or share count: their value is still inside `balance`.
 *
 * When the comparison is impossible (a holding without a `market_value`, or in
 * a different currency than the account) this returns `balance` unchanged. That
 * is the behaviour before this function existed, and the only choice that
 * invents nothing.
 *
 * Not decidable from here: an account whose `balance` is cash alone, in an
 * amount larger than its holdings. It reads as a total with a cash remainder.
 */
function cashFor(account: SimplefinAccount, holdings: NonNullable<SimplefinAccount['holdings']>): string {
  const balance = parseMicros(account.balance);
  if (balance === null) return account.balance;

  let held = 0n;
  for (const holding of holdings) {
    if (holding.currency && holding.currency !== account.currency) return account.balance;
    const marketValue = parseMicros(holding.market_value);
    if (marketValue === null) return account.balance;
    held += marketValue;
  }

  const remainder = balance - held;
  if (remainder < -BALANCE_TOLERANCE) return account.balance;
  if (remainder <= BALANCE_TOLERANCE) return '0';
  return formatMicros(remainder);
}

/** Longest symbol made from a description: enough to tell funds apart. */
const DESCRIPTION_SYMBOL_MAX = 40;

/**
 * The symbol a holding is filed under: SimpleFin's own, or, when it sends
 * none, the holding's description in capitals ("Target Date Fund 2060" →
 * "TARGET DATE FUND 2060"). Some retirement plans report their funds with a
 * share count, a market value and a description but no symbol; dropping them
 * left the account with no holdings at all.
 */
export function holdingSymbol(holding: { symbol?: string | null; description?: string | null }): { symbol: string; fromDescription: boolean } {
  const own = String(holding.symbol ?? '').trim();
  if (own && own !== '-') return { symbol: own, fromDescription: false };
  const named = String(holding.description ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9.&/ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DESCRIPTION_SYMBOL_MAX)
    .trim();
  return { symbol: named, fromDescription: named !== '' };
}

/**
 * The snapshot for one SimpleFin account, or `null` when there is nothing
 * honest to write.
 *
 * `null` in three cases, all the same underlying reason — a snapshot states the
 * WHOLE position list, so an incomplete one is a false claim:
 *
 *  1. No `holdings` key. Every bank and card account, and the normal case. The
 *     account is not an investment account and never had positions to state.
 *  2. An empty `holdings` array. Same conclusion, and deliberately NOT read as
 *     "the account is empty": SimpleFin sends an empty array for accounts it has
 *     no holdings data for as readily as for a genuinely empty brokerage, and
 *     the two are indistinguishable from here. Writing a positions-free snapshot
 *     on that guess would zero a real portfolio for that date.
 *  3. Every holding unusable. The filter below drops holdings that cannot be
 *     resolved, and if it drops all of them the remainder is an empty list —
 *     case 2 again, reached by a different road.
 *
 * A holding is unusable without a symbol or a description to name it by
 * (`holdingSymbol`: nothing to resolve an asset from) or without a share count
 * (nothing to value). Either one makes the host reject the
 * ENTIRE batch, which is why they are filtered rather than passed through and
 * left to fail: one junk line would cost the account its whole snapshot.
 */
export function toHoldingsSnapshot(
  account: SimplefinAccount,
  options: HoldingsSnapshotOptions = {},
): HoldingsSnapshot | null {
  const holdings = account.holdings;
  if (!Array.isArray(holdings) || holdings.length === 0) return null;

  const positions: HoldingsPosition[] = [];
  for (const holding of holdings) {
    const { symbol } = holdingSymbol(holding);
    const shares = holding.shares === null || holding.shares === undefined
      ? ''
      : String(holding.shares).trim();
    if (!symbol || !shares) continue;
    positions.push({
      symbol,
      quantity: shares,
      avgCost: averageCost(holding.cost_basis, holding.purchase_price, shares),
      // SimpleFin omits a holding's currency when it matches the account's,
      // which is the overwhelmingly common case. Some providers send `""`
      // instead, which means the same thing.
      currency: holding.currency?.trim() || account.currency,
    });
  }
  if (positions.length === 0) return null;

  // The BALANCE date, not today: a feed can be a day or more behind, and
  // dating a snapshot today would attribute yesterday's positions to a day
  // they were not held — then collide with the real snapshot for today.
  //
  // Read on the LOCAL calendar, not UTC. Wealthfolio refuses a snapshot dated
  // after its own today, and a fresh balance timestamp in the evening west of
  // UTC is already tomorrow in UTC: 22:08 on Oct 18 in Los Angeles is Oct 19
  // 05:08Z, and `toISOString().slice(0, 10)` made every investment account fail
  // with "Date 2026-10-19 can't be imported" until local midnight. The clamp is
  // for a feed whose timestamp runs ahead of the clock; a snapshot is never
  // dated in the future.
  const day = calendarDay(new Date(account['balance-date'] * 1000), options.timeZone);
  const today = calendarDay(options.now ?? new Date(), options.timeZone);

  return {
    date: day > today ? today : day, // `YYYY-MM-DD` strings order lexically
    positions: mergePositions(positions),
    cashBalances: { [account.currency]: cashFor(account, holdings) },
  };
}

// Prices are carried to 8 places: a share count can have 8 (crypto), and a
// price rounded to cents would misvalue a large position by dollars.
const PRICE_PLACES = 8;
const PRICE_SCALE = 10n ** BigInt(PRICE_PLACES);

function parseScaled(value: string | number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const match = /^\+?(\d+)(?:\.(\d*))?$/.exec(String(value).replace(/,/g, '').trim());
  if (!match) return null;
  const fraction = (match[2] ?? '').padEnd(PRICE_PLACES, '0').slice(0, PRICE_PLACES);
  return BigInt(match[1]) * PRICE_SCALE + BigInt(fraction || '0');
}

/**
 * Each holding's price per share, as the feed values it: `market_value ÷
 * shares`. For a holding Wealthfolio cannot price itself (a basket of stocks
 * reported as one holding, rather than a ticker): the snapshot carries only
 * the share count, and with no market price Wealthfolio values it at $0.
 *
 * Left out: a holding without a symbol (or a description to name it by), a
 * positive share count or a market value. Never a guessed price: a missing one
 * leaves the holding as it was.
 */
export function feedPrices(account: SimplefinAccount): FeedPrice[] {
  // Holdings filed under one symbol are one position (see `mergePositions`),
  // so they get one price: their value over their shares.
  const groups = new Map<string, { symbol: string; currency: string; fromDescription: boolean; shares: bigint; value: bigint }>();
  for (const holding of account.holdings ?? []) {
    const { symbol, fromDescription } = holdingSymbol(holding);
    const shares = parseScaled(holding.shares);
    const value = parseScaled(holding.market_value);
    if (!symbol || shares === null || shares === 0n || value === null) continue;
    const currency = holding.currency?.trim() || account.currency;
    const key = `${symbol.toUpperCase()}|${currency}`;
    const group = groups.get(key);
    if (group) {
      group.shares += shares;
      group.value += value;
    } else {
      groups.set(key, { symbol, currency, fromDescription, shares, value });
    }
  }
  const prices: FeedPrice[] = [];
  for (const { symbol, currency, fromDescription, shares, value } of groups.values()) {
    prices.push({
      symbol,
      price: divideScaled(value, shares),
      currency,
      ...(fromDescription ? { fromDescription: true as const } : {}),
    });
  }
  return prices;
}

/** `a ÷ b`, both scaled by 10^8, to 8 places, rounded half up; at least two places. */
function divideScaled(a: bigint, b: bigint): string {
  const scaled = (a * PRICE_SCALE * 2n + b) / (b * 2n);
  return formatScaled(scaled);
}

function formatScaled(scaled: bigint): string {
  const whole = scaled / PRICE_SCALE;
  let fraction = (scaled % PRICE_SCALE).toString().padStart(PRICE_PLACES, '0').replace(/0+$/, '');
  if (fraction.length < 2) fraction = fraction.padEnd(2, '0');
  return `${whole}.${fraction}`;
}

/**
 * One position per symbol and currency. Wealthfolio keys a snapshot's positions
 * by asset, so two lines filed under one symbol kept only one of them: two
 * funds whose descriptions agree up to the cut (`DESCRIPTION_SYMBOL_MAX`), or a
 * ticker a bank reports as two lots. Their shares are added; the cost is their
 * share-weighted average, or left out when either line has none. A single line
 * is passed through exactly as it came.
 */
function mergePositions(positions: HoldingsPosition[]): HoldingsPosition[] {
  const byKey = new Map<string, HoldingsPosition[]>();
  for (const p of positions) {
    const key = `${p.symbol.trim().toUpperCase()}|${p.currency}`;
    byKey.set(key, [...(byKey.get(key) ?? []), p]);
  }
  const merged: HoldingsPosition[] = [];
  for (const group of byKey.values()) {
    const quantities = group.map((p) => parseScaled(p.quantity));
    if (group.length === 1 || quantities.some((q) => q === null)) {
      merged.push(...group);
      continue;
    }
    const total = quantities.reduce((sum, q) => sum! + q!, 0n)!;
    const costs = group.map((p) => (p.avgCost === undefined ? null : parseScaled(p.avgCost)));
    const avgCost = total > 0n && costs.every((c) => c !== null)
      ? divideScaled(costs.reduce((sum, c, i) => sum + (c! * quantities[i]!) / PRICE_SCALE, 0n), total)
      : undefined;
    merged.push({ ...group[0], quantity: formatScaled(total), avgCost });
  }
  return merged;
}

/**
 * The short name an account's per-account assets carry: the first eight
 * letters and digits of the WEALTHFOLIO account's id. Stable on purpose: a
 * name changes when the account is renamed or SimpleFin is reconnected (which
 * also changes the SimpleFin id), and that would leave the old asset orphaned.
 * Two accounts' tags are never the same in practice (eight hex digits of a
 * UUID), where the ends of their names can be ("Individual - Brokerage" and
 * "Joint - Brokerage").
 *
 * Why per account at all: Wealthfolio keeps ONE asset per symbol for every
 * account, and one price per asset per day. Two accounts can hold different
 * things under one symbol (two accounts at one robo-advisor, each holding its
 * own basket under the same name, worth different amounts a share), so a price
 * from one account's market value valued the other's shares. Only holdings
 * priced from the feed are scoped; a ticker the market prices is the same
 * thing in every account and stays shared.
 */
export function accountTag(wfAccountId: string): string {
  const compact = wfAccountId.replace(/[^A-Za-z0-9]/g, '');
  return (compact.slice(0, 8) || wfAccountId).toUpperCase();
}

/** The symbol of a holding's per-account asset. */
export const scopedSymbol = (symbol: string, tag: string): string => `${symbol.trim()} (${tag})`;
