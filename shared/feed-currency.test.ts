import { describe, it, expect, beforeEach } from 'vitest';
import { fillFeedCurrencies } from './feed-currency.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import { createFakeHost } from './fake-host.js';
import { toHoldingsSnapshot } from './holdings.js';
import type { SimplefinAccount } from './types.js';

// Noon UTC: the same calendar day in every timezone the tests run in.
const NOON = 1789214400;

const account = (over: Partial<SimplefinAccount> = {}): SimplefinAccount => ({
  id: 'sfin-401k', name: 'Retirement Plan', currency: '', balance: '1000.00', 'balance-date': NOON, ...over,
});

describe('fillFeedCurrencies', () => {
  it('fills a blank currency from the mapped Wealthfolio account', () => {
    const { accounts, unresolved } = fillFeedCurrencies([account()], { 'sfin-401k': 'wf-401k' }, new Map([['wf-401k', 'USD']]));
    expect(accounts[0].currency).toBe('USD');
    expect(unresolved).toEqual([]);
  });

  it('treats spaces as blank', () => {
    const { accounts } = fillFeedCurrencies([account({ currency: '  ' })], { 'sfin-401k': 'wf-401k' }, new Map([['wf-401k', 'USD']]));
    expect(accounts[0].currency).toBe('USD');
  });

  it('leaves an account that has a currency alone, the same object', () => {
    const cad = account({ currency: 'CAD' });
    const { accounts } = fillFeedCurrencies([cad], { 'sfin-401k': 'wf-401k' }, new Map([['wf-401k', 'USD']]));
    expect(accounts[0]).toBe(cad);
  });

  it('falls back to the holdings when they agree on one currency', () => {
    const holdings = [
      { symbol: 'TR2060', shares: '10', currency: 'USD' },
      { symbol: 'BND', shares: '1', currency: 'USD' },
    ];
    const { accounts } = fillFeedCurrencies([account({ holdings })], { 'sfin-401k': 'wf-401k' }, new Map());
    expect(accounts[0].currency).toBe('USD');
  });

  it('never guesses: no Wealthfolio currency and mixed holdings stay blank, and a mapped account says so', () => {
    const holdings = [
      { symbol: 'A', shares: '1', currency: 'USD' },
      { symbol: 'B', shares: '1', currency: 'EUR' },
    ];
    const { accounts, unresolved } = fillFeedCurrencies(
      [account({ holdings }), account({ id: 'sfin-unmapped' })],
      { 'sfin-401k': 'wf-401k' },
      new Map(),
    );
    expect(accounts.map((a) => a.currency)).toEqual(['', '']);
    expect(unresolved.map((a) => a.id)).toEqual(['sfin-401k']);
  });
});

describe('a feed account with a blank currency', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
  });

  const posted = () => Math.floor(Date.now() / 1000) - 3600;

  it("imports its rows as $CASH-<the Wealthfolio account's currency>, never $CASH-", async () => {
    // Before the fix every row failed with "Invalid symbol '$CASH-'".
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [account({
        'balance-date': posted(),
        transactions: [
          { id: 'TRN-1', posted: posted(), amount: '-250.00', description: 'Target Date Fund' },
          { id: 'TRN-2', posted: posted(), amount: '500.00', description: 'Target Date Fund' },
        ],
      })] },
      mapping: { 'sfin-401k': 'wf-401k' },
      accountCurrencies: { 'wf-401k': 'USD' },
    });
    const result = await runSyncCore(host, store, { force: true });

    const creates = saved.flatMap((s) => s.creates ?? []);
    const rows = creates.filter((c) => (c.comment ?? '').includes('Target Date'));
    expect(rows).toHaveLength(2);
    for (const c of creates) {
      if (c.symbol) expect(c.symbol.symbol).not.toBe('$CASH-');
      expect(c.currency).toBe('USD');
    }
    expect(rows.map((c) => c.symbol?.symbol)).toEqual(['$CASH-USD', '$CASH-USD']);
    expect(result.errors.filter((e) => /currency/.test(e))).toEqual([]);
  });

  it('names the account once when its currency cannot be found anywhere', async () => {
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [account({ 'balance-date': posted(), transactions: [] })] },
      mapping: { 'sfin-401k': 'wf-401k' },
    });
    const result = await runSyncCore(host, store, { force: true });
    expect(result.errors.filter((e) => /no currency/.test(e))).toEqual([
      "SimpleFin: Retirement Plan reports no currency, and its Wealthfolio account has none either, so its transactions can't be imported.",
    ]);
  });
});

describe('toHoldingsSnapshot with a blank holding currency', () => {
  it("reads it as the account's currency, like an absent one", () => {
    const snap = toHoldingsSnapshot(account({
      currency: 'USD',
      holdings: [{ symbol: 'TR2060', shares: '10', currency: '', market_value: '1000.00' }],
    }), { now: new Date(NOON * 1000) });
    expect(snap?.positions[0].currency).toBe('USD');
    expect(snap?.cashBalances).toEqual({ USD: '0' });
  });
});
