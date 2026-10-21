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
function parseScaled(value: string | number | null | undefined): { n: bigint; scale: number } | null {
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
  const total = parseScaled(costBasis);
  const count = parseScaled(shares);
  if (total && total.n > 0n && count && count.n > 0n) {
    // total / count, rounded half up to AVG_COST_DECIMALS.
    const num = total.n * 10n ** BigInt(count.scale + AVG_COST_DECIMALS) * 2n;
    const den = count.n * 10n ** BigInt(total.scale);
    const q = (num / den + 1n) / 2n;
    const unit = 10n ** BigInt(AVG_COST_DECIMALS);
    const fraction = (q % unit).toString().padStart(AVG_COST_DECIMALS, '0').replace(/0+$/, '');
    return fraction ? `${q / unit}.${fraction}` : `${q / unit}`;
  }
  const price = parseScaled(purchasePrice);
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
 * A holding is unusable without a symbol (nothing to resolve an asset from) or
 * without a share count (nothing to value). Either one makes the host reject the
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
    const symbol = String(holding.symbol ?? '').trim();
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
    positions,
    cashBalances: { [account.currency]: cashFor(account, holdings) },
  };
}
