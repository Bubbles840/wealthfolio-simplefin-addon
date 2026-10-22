import { afterEach, describe, it, expect, vi } from 'vitest';
import { accountTag, feedPrices, holdingSymbol, scopedSymbol, toHoldingsSnapshot } from './holdings.js';
import type { SimplefinAccount } from './types.js';

const account = (over: Partial<SimplefinAccount> = {}): SimplefinAccount => ({
  id: 'sfin-b',
  name: 'Brokerage',
  currency: 'USD',
  balance: '512.34',
  // Noon UTC: the same calendar day in every zone from UTC−11 to UTC+11, so
  // the snapshot's LOCAL day is 2026-09-12 wherever the suite runs.
  'balance-date': 1789214400, // 2026-09-12T12:00Z
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
      { timeZone: 'UTC' },
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

  it('divides a total cost_basis by the shares, even when purchase_price repeats the total', () => {
    const snapshot = toHoldingsSnapshot(account({ holdings: [
      // purchase_price per share, as the protocol says.
      { symbol: 'AAA', shares: '4', cost_basis: '1000.00', purchase_price: '250.00' },
      // A provider that sends the total in purchase_price too.
      { symbol: 'BBB', shares: '8', cost_basis: '1000.00', purchase_price: '1000.00' },
      // Fractional shares, rounded half up to 8 decimals.
      { symbol: 'CCC', shares: '3.5', cost_basis: '100' },
    ] }));
    expect(snapshot?.positions.map((p) => p.avgCost)).toEqual(['250', '125', '28.57142857']);
  });

  it('falls back to purchase_price without a total, and reads zero as unknown', () => {
    const snapshot = toHoldingsSnapshot(account({ holdings: [
      { symbol: 'AAA', shares: '2', cost_basis: '0.00', purchase_price: '101.25' },
      { symbol: 'BBB', shares: '2', cost_basis: '0.00', purchase_price: '0.00' },
      { symbol: 'CCC', shares: '2', purchase_price: 'n/a' },
    ] }));
    expect(snapshot?.positions.map((p) => p.avgCost)).toEqual(['101.25', undefined, undefined]);
  });

  it('dates the snapshot from the balance date, not from today', () => {
    const snapshot = toHoldingsSnapshot(
      account({ 'balance-date': 1735732800, holdings: [{ symbol: 'VTI', shares: '1' }] }),
      { timeZone: 'UTC' },
    );
    expect(snapshot?.date).toBe('2025-01-01');
  });

  describe('the date follows the local calendar, not UTC', () => {
    // 2026-10-19 05:08:42Z is 22:08 on Oct 18 in Los Angeles: the exact moment
    // that made every investment account fail with "Date 2026-10-19 can't be
    // imported. Use a date from 1970-01-01 to 2026-10-18."
    const evening = 1792386522;
    const now = new Date(evening * 1000);
    const held = [{ symbol: 'VTI', shares: '1' }];

    it('dates an evening-west-of-UTC balance on the local day', () => {
      const snapshot = toHoldingsSnapshot(
        account({ 'balance-date': evening, holdings: held }),
        { timeZone: 'America/Los_Angeles', now },
      );
      expect(snapshot?.date).toBe('2026-10-18');
    });

    it('still reads UTC as UTC when that is the zone asked for', () => {
      const snapshot = toHoldingsSnapshot(
        account({ 'balance-date': evening, holdings: held }),
        { timeZone: 'UTC', now },
      );
      expect(snapshot?.date).toBe('2026-10-19');
    });

    it('never dates a snapshot after the local today', () => {
      // A feed timestamp that runs ahead of the clock.
      const snapshot = toHoldingsSnapshot(
        account({ 'balance-date': evening + 3 * 86400, holdings: held }),
        { timeZone: 'America/Los_Angeles', now },
      );
      expect(snapshot?.date).toBe('2026-10-18');
    });

    it('falls back to the runtime zone for a zone name it does not know', () => {
      const input = account({ 'balance-date': 1789214400, holdings: held });
      const bad = toHoldingsSnapshot(input, { timeZone: 'Not/AZone', now });
      const runtime = toHoldingsSnapshot(input, { now });
      expect(bad?.date).toBe(runtime?.date);
    });
  });

  describe('the cash line is not the account total', () => {
    const fidelity = (balance: string, holdings: NonNullable<SimplefinAccount['holdings']>) =>
      toHoldingsSnapshot(account({ balance, holdings }));

    it('is zero when the balance is just the holdings added up (a total-value feed)', () => {
      // Fidelity: balance equals the sum of the positions, money-market core
      // included. Writing the balance as cash as well counted everything twice.
      const snapshot = fidelity('1000.00', [
        { symbol: 'VTI', shares: '2', market_value: '600.00' },
        { symbol: 'SPAXX', shares: '400', market_value: '400.00' },
      ]);
      expect(snapshot?.cashBalances).toEqual({ USD: '0' });
    });

    it('is the remainder when the balance exceeds the holdings', () => {
      const snapshot = fidelity('1250.50', [
        { symbol: 'VTI', shares: '2', market_value: '800.00' },
        { symbol: 'VXUS', shares: '4', market_value: '400.00' },
      ]);
      expect(snapshot?.cashBalances).toEqual({ USD: '50.50' });
    });

    it('absorbs a few cents of rounding between balance and positions', () => {
      const snapshot = fidelity('1000.37', [
        { symbol: 'VTI', shares: '2', market_value: '999.99' },
      ]);
      expect(snapshot?.cashBalances).toEqual({ USD: '0' });
    });

    it('counts a holding the snapshot drops, because its value is inside the balance', () => {
      const snapshot = fidelity('1000.00', [
        { symbol: 'VTI', shares: '2', market_value: '600.00' },
        { symbol: '', shares: '1', market_value: '400.00' }, // unusable as a position
      ]);
      expect(snapshot?.positions).toHaveLength(1);
      expect(snapshot?.cashBalances).toEqual({ USD: '0' });
    });

    it('keeps the balance as cash when it is smaller than the holdings (cash-only feed)', () => {
      const snapshot = fidelity('512.34', [
        { symbol: 'VTI', shares: '40', market_value: '10000.00' },
      ]);
      expect(snapshot?.cashBalances).toEqual({ USD: '512.34' });
    });

    it('keeps the balance when a holding has no market value to compare with', () => {
      // Nothing to settle which convention this broker uses, so nothing is
      // invented: the line is written as it was before the comparison existed.
      const snapshot = fidelity('512.34', [
        { symbol: 'VTI', shares: '2', market_value: '600.00' },
        { symbol: 'AAPL', shares: '1' },
      ]);
      expect(snapshot?.cashBalances).toEqual({ USD: '512.34' });
    });

    it('keeps the balance when a holding is priced in another currency', () => {
      const snapshot = fidelity('1000.00', [
        { symbol: 'VTI', shares: '2', market_value: '600.00' },
        { symbol: 'SHOP', shares: '1', market_value: '400.00', currency: 'CAD' },
      ]);
      expect(snapshot?.cashBalances).toEqual({ USD: '1000.00' });
    });

    it('does its arithmetic in integers, not floats', () => {
      // 0.1 + 0.2 style trouble: three 0.10 holdings must leave exactly 3.00
      // over, not 2.9999999999999996.
      const snapshot = fidelity('3.30', [
        { symbol: 'A', shares: '1', market_value: '0.10' },
        { symbol: 'B', shares: '1', market_value: '0.10' },
        { symbol: 'C', shares: '1', market_value: '0.10' },
      ]);
      expect(snapshot?.cashBalances).toEqual({ USD: '3.00' });
    });
  });
});

describe('toHoldingsSnapshot — dated by the local day (1.63.1)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('dates an evening balance by the local day, never the UTC day Wealthfolio would refuse as the future', () => {
    // Live, 2026-10-18 at 10:43 PM in Kentucky: Robinhood's balance-date was
    // 02:43 UTC on Oct 19, the snapshot was dated "2026-10-19", and Wealthfolio
    // refused it ("Use a date from 1970-01-01 to 2026-10-18").
    vi.stubEnv('TZ', 'America/New_York');
    const snapshot = toHoldingsSnapshot(account({
      'balance-date': Date.parse('2026-10-19T02:43:00Z') / 1000,
      holdings: [{ symbol: 'VTI', shares: '1' }],
    }));
    expect(snapshot?.date).toBe('2026-10-18');
  });
});

describe('feedPrices', () => {
  it('prices a holding at market value ÷ shares, to 8 places', () => {
    // A basket of stocks reported as one holding: Wealthfolio valued it at $0
    // while SimpleFin reported its market value.
    expect(feedPrices(account({
      holdings: [{ symbol: 'MODEL BASKET', shares: '400.5', market_value: '50000.00', description: 'Model Basket' }],
    }))).toEqual([{ symbol: 'MODEL BASKET', price: '124.84394507', currency: 'USD' }]);
  });

  it('keeps a round price readable, and reads a value written with commas', () => {
    expect(feedPrices(account({ holdings: [{ symbol: 'VTI', shares: '2', market_value: '1,000.00' }] })))
      .toEqual([{ symbol: 'VTI', price: '500.00', currency: 'USD' }]);
  });

  it("uses the holding's own currency when it names one", () => {
    expect(feedPrices(account({ holdings: [{ symbol: 'SHOP', shares: '1', market_value: '100', currency: 'CAD' }] }))[0].currency).toBe('CAD');
  });

  it('never guesses: no symbol, no or zero shares, or no market value gives no price', () => {
    expect(feedPrices(account({
      holdings: [
        { shares: '1', market_value: '5' },
        { symbol: 'A', market_value: '5' },
        { symbol: 'B', shares: '0', market_value: '5' },
        { symbol: 'C', shares: '1' },
        { symbol: 'D', shares: '1', market_value: 'n/a' },
      ],
    }))).toEqual([]);
    expect(feedPrices(account({ holdings: undefined }))).toEqual([]);
  });
});

describe('accountTag', () => {
  it("is the first eight letters and digits of the Wealthfolio account id", () => {
    expect(accountTag('3f2a9c1e-77b0-4d2e-9a1b-0c5e6f7a8b9c')).toBe('3F2A9C1E');
  });

  it('tells apart accounts whose names end alike', () => {
    // Names like "Individual - Brokerage" and "Joint - Brokerage" used to give one tag.
    expect(accountTag('aaaa1111-0000-4000-8000-000000000001')).not.toBe(accountTag('bbbb2222-0000-4000-8000-000000000001'));
  });

  it('keeps a short or odd id whole', () => {
    expect(accountTag('wf-1')).toBe('WF1');
    expect(accountTag('---')).toBe('---');
  });

  it('names the per-account symbol after it', () => {
    expect(scopedSymbol(' MODEL BASKET ', 'ABCD')).toBe('MODEL BASKET (ABCD)');
  });
});

describe('holdings filed under one symbol', () => {
  it('are one position: shares added, cost share-weighted', () => {
    const snapshot = toHoldingsSnapshot(account({ holdings: [
      { symbol: 'VTI', shares: '2', purchase_price: '100' },
      { symbol: 'vti', shares: '1.5', purchase_price: '200' },
      { symbol: 'AAPL', shares: '1' },
    ] }));
    expect(snapshot?.positions).toEqual([
      { symbol: 'VTI', quantity: '3.50', avgCost: '142.85714286', currency: 'USD' },
      { symbol: 'AAPL', quantity: '1', avgCost: undefined, currency: 'USD' },
    ]);
  });

  it('leave the cost out when either line has none', () => {
    const snapshot = toHoldingsSnapshot(account({ holdings: [
      { symbol: 'VTI', shares: '2', purchase_price: '100' },
      { symbol: 'VTI', shares: '1' },
    ] }));
    expect(snapshot?.positions).toEqual([{ symbol: 'VTI', quantity: '3.00', avgCost: undefined, currency: 'USD' }]);
  });

  it('stay apart in different currencies', () => {
    const snapshot = toHoldingsSnapshot(account({ holdings: [
      { symbol: 'X', shares: '1' },
      { symbol: 'X', shares: '1', currency: 'CAD' },
    ] }));
    expect(snapshot?.positions.map((p) => p.currency)).toEqual(['USD', 'CAD']);
  });

  it('two funds whose descriptions agree up to the cut keep both their shares and value', () => {
    const name = 'Example LifePath Index 2060 Non-Lendable Fund';
    const holdings = [
      { description: `${name} F`, shares: '10', market_value: '1000.00' },
      { description: `${name} M`, shares: '30', market_value: '2000.00' },
    ];
    const snapshot = toHoldingsSnapshot(account({ holdings }));
    expect(snapshot?.positions).toHaveLength(1);
    expect(snapshot?.positions[0].quantity).toBe('40.00');
    // One price for the merged position: total value over total shares.
    expect(feedPrices(account({ holdings }))).toEqual([
      { symbol: snapshot!.positions[0].symbol, price: '75.00', currency: 'USD', fromDescription: true },
    ]);
  });
});

describe('a holding SimpleFin sends without a symbol', () => {
  // Some retirement plans report a fund with shares, a market value and a
  // description, but no symbol: the account then had no holdings at all.
  const plan = (holdings: NonNullable<SimplefinAccount['holdings']>) =>
    account({ name: 'Example Co 401(K) Plan - 123456', balance: '10000.00', holdings });

  it('is filed under its description, in capitals', () => {
    expect(holdingSymbol({ description: '  Target Date Fund 2060 ' })).toEqual({ symbol: 'TARGET DATE FUND 2060', fromDescription: true });
    expect(holdingSymbol({ symbol: '-', description: 'Stable Value Fund' })).toEqual({ symbol: 'STABLE VALUE FUND', fromDescription: true });
    expect(holdingSymbol({ symbol: 'VTI', description: 'Total Market' })).toEqual({ symbol: 'VTI', fromDescription: false });
    expect(holdingSymbol({})).toEqual({ symbol: '', fromDescription: false });
  });

  it('makes a snapshot of it, with the balance read as its value and no cash on top', () => {
    const snapshot = toHoldingsSnapshot(plan([{ shares: '40', market_value: '10000.00', description: 'Target Date Fund 2060' }]));
    expect(snapshot?.positions).toEqual([{ symbol: 'TARGET DATE FUND 2060', quantity: '40', currency: 'USD' }]);
    expect(snapshot?.cashBalances).toEqual({ USD: '0' });
  });

  it('prices it from its market value, marked as a symbol made from the description', () => {
    expect(feedPrices(plan([{ shares: '40', market_value: '10000.00', description: 'Target Date Fund 2060' }]))).toEqual([
      { symbol: 'TARGET DATE FUND 2060', price: '250.00', currency: 'USD', fromDescription: true },
    ]);
  });

});
