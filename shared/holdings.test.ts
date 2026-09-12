import { describe, it, expect } from 'vitest';
import { toHoldingsSnapshot } from './holdings.js';
import type { SimplefinAccount } from './types.js';

const account = (over: Partial<SimplefinAccount> = {}): SimplefinAccount => ({
  id: 'sfin-b',
  name: 'Brokerage',
  currency: 'USD',
  balance: '512.34',
  'balance-date': 1789171200, // 2026-09-12
  ...over,
});

describe('toHoldingsSnapshot', () => {
  it('is null for an account that publishes no holdings', () => {
    // A cash account. Snapshots are for investment accounts, and a snapshot is
    // a FULL statement of what an account holds, so writing one for an account
    // whose holdings SimpleFin never reports would assert "holds nothing".
    expect(toHoldingsSnapshot(account())).toBeNull();
    expect(toHoldingsSnapshot(account({ holdings: [] }))).toBeNull();
  });

  it('carries symbol, share count, cost and currency onto a positions list', () => {
    const snapshot = toHoldingsSnapshot(
      account({
        holdings: [
          { symbol: 'VTI', shares: '2.5', purchase_price: '210.11', currency: 'USD' },
          { symbol: 'AAPL', shares: '1', purchase_price: '190.00' },
        ],
      }),
    );
    expect(snapshot).toEqual({
      // A bare calendar day, NOT an instant: a snapshot is a valuation bucket
      // for a date, and the host's idempotency signal is keyed the same way.
      date: '2026-09-12',
      positions: [
        { symbol: 'VTI', quantity: '2.5', avgCost: '210.11', currency: 'USD' },
        // Currency falls back to the ACCOUNT's, which is what SimpleFin means
        // by omitting it on a holding.
        { symbol: 'AAPL', quantity: '1', avgCost: '190.00', currency: 'USD' },
      ],
      cashBalances: { USD: '512.34' },
    });
  });

  it('drops a holding with no symbol or no share count', () => {
    // Either one is unresolvable to a Wealthfolio asset, and the host rejects
    // the WHOLE batch over one bad position — so an unusable holding must never
    // reach it.
    const snapshot = toHoldingsSnapshot(
      account({
        holdings: [
          { symbol: 'VTI', shares: '2' },
          { symbol: '', shares: '5' },
          { symbol: 'GOOG', shares: null },
          { symbol: 'MSFT' },
        ],
      }),
    );
    expect(snapshot?.positions).toEqual([{ symbol: 'VTI', quantity: '2', avgCost: undefined, currency: 'USD' }]);
  });

  it('is null when every holding is unusable, rather than an empty positions list', () => {
    // The dangerous case the filter creates: an account that DOES report
    // holdings, none of them usable, would otherwise produce a positions-free
    // snapshot — which tells Wealthfolio the account holds nothing and wipes
    // the day's positions. Refusing to write anything is the safe answer.
    expect(toHoldingsSnapshot(account({ holdings: [{ symbol: '', shares: null }] }))).toBeNull();
  });

  it('omits avgCost when SimpleFin gave no purchase price', () => {
    // `undefined` (the key absent) rather than a zero: a zero cost basis is a
    // claim about the position, and a wrong one shows up as fictional gains.
    const snapshot = toHoldingsSnapshot(account({ holdings: [{ symbol: 'BTC', shares: '0.01' }] }));
    expect(snapshot?.positions[0].avgCost).toBeUndefined();
  });

  it('dates the snapshot from the balance date, not from today', () => {
    const snapshot = toHoldingsSnapshot(
      account({ 'balance-date': 1735689600, holdings: [{ symbol: 'VTI', shares: '1' }] }),
    );
    expect(snapshot?.date).toBe('2025-01-01');
  });
});
