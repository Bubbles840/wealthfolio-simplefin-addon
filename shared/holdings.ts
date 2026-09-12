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
export function toHoldingsSnapshot(account: SimplefinAccount): HoldingsSnapshot | null {
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
      // `undefined` (an absent key), never a zero: a zero cost basis is a
      // positive claim that the position was free, which shows up as fictional
      // gains on the holdings page.
      avgCost: holding.purchase_price ? String(holding.purchase_price) : undefined,
      // SimpleFin omits a holding's currency when it matches the account's,
      // which is the overwhelmingly common case.
      currency: String(holding.currency ?? account.currency),
    });
  }
  if (positions.length === 0) return null;

  return {
    // The BALANCE date, not today: a feed can be a day or more behind, and
    // dating a snapshot today would attribute yesterday's positions to a day
    // they were not held — then collide with the real snapshot for today.
    date: new Date(account['balance-date'] * 1000).toISOString().slice(0, 10),
    positions,
    cashBalances: { [account.currency]: account.balance },
  };
}
