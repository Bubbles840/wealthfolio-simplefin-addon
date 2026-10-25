import { describe, it, expect } from 'vitest';
import { decideDividend, dividendTicker, heldSecuritiesOf, heldSecurityFor, isDividendRow, pastDividendSecurity, type HeldSecurity } from './dividends.js';
import type { MappedType } from './mapper.js';

describe('dividendTicker', () => {
  it('reads the ticker from Fidelity\'s dividend line', () => {
    expect(dividendTicker('DIVIDEND RECEIVED VANGUARD INDEX FUNDS S&P 500 ETF USD (VOO) (Cash)')).toBe('VOO');
    expect(dividendTicker('DIVIDEND RECEIVED META PLATFORMS INC CLASS A COMMON STOCK (META) (Cash)')).toBe('META');
    expect(dividendTicker('Dividend Received Fidelity Government Money Market (spaxx) (Cash)')).toBe('SPAXX');
  });

  it('reads nothing from a dividend that names no ticker, or from a line that is not a dividend', () => {
    expect(dividendTicker('Dividend Received')).toBeNull();
    expect(dividendTicker('REINVESTMENT VANGUARD INDEX FUNDS S&P 500 ETF USD (VOO) (Cash)')).toBeNull();
    expect(dividendTicker('YOU BOUGHT VANGUARD INDEX FUNDS S&P 500 ETF USD (VOO) (Cash)')).toBeNull();
    expect(dividendTicker('DIVIDEND RECEIVED (Cash)')).toBeNull();
  });
});

describe('the held security', () => {
  const held: HeldSecurity[] = [{ assetId: 'a-voo', symbol: 'VOO' }, { assetId: 'a-shop', symbol: 'SHOP' }, { assetId: 'a-shop-to', symbol: 'SHOP' }];

  it('is the one holding shown under the ticker, and none when two listings share it', () => {
    expect(heldSecurityFor('voo', held)).toEqual({ assetId: 'a-voo', symbol: 'VOO' });
    expect(heldSecurityFor('SHOP', held)).toBeNull();
    expect(heldSecurityFor('MSFT', held)).toBeNull();
  });

  it('is read from a holdings payload, skipping lines without an instrument id and code', () => {
    expect(heldSecuritiesOf([
      { instrument: { id: 'a-voo', symbol: 'VOO' } }, { instrument: null }, { instrument: { id: '', symbol: 'X' } }, 'junk',
    ])).toEqual([{ assetId: 'a-voo', symbol: 'VOO' }]);
    expect(heldSecuritiesOf(null)).toEqual([]);
  });
});

describe('decideDividend', () => {
  const FID = 'DIVIDEND RECEIVED VANGUARD INDEX FUNDS S&P 500 ETF USD (VOO) (Cash)';
  const deposit: MappedType = { type: 'DEPOSIT', fromRule: false };
  const ruled = (type: string): MappedType => ({ type: type as MappedType['type'], fromRule: true });
  const held = async () => [{ assetId: 'a-voo', symbol: 'VOO' }];
  const decide = (over: Partial<Parameters<typeof decideDividend>[0]>) =>
    decideDividend({ mapped: deposit, amount: 12.34, accountType: 'SECURITIES', description: FID, held, ...over });

  it('without a rule, books a known wording in an investment account on the held security', async () => {
    expect(await decide({})).toEqual({ type: 'DIVIDEND', assetId: 'a-voo' });
  });

  it('without a rule, leaves a ticker the account does not hold, a cash account, and money out alone', async () => {
    expect(await decide({ held: async () => [] })).toBeNull();
    expect(await decide({ held: async () => null })).toBeNull();
    expect(await decide({ accountType: 'CASH' })).toBeNull();
    expect(await decide({ accountType: undefined })).toBeNull();
    expect(await decide({ amount: -12.34 })).toBeNull();
  });

  it('a rule wins: one typing it INTEREST is left alone, even with a held ticker', async () => {
    expect(await decide({ mapped: ruled('INTEREST') })).toBeNull();
  });

  it('a DIVIDEND rule books the held security, else interest, which needs none', async () => {
    expect(await decide({ mapped: ruled('DIVIDEND') })).toEqual({ type: 'DIVIDEND', assetId: 'a-voo' });
    expect(await decide({ mapped: ruled('DIVIDEND'), description: 'Dividend Received' })).toEqual({ type: 'INTEREST' });
    expect(await decide({ mapped: ruled('DIVIDEND'), accountType: 'CASH' })).toEqual({ type: 'INTEREST' });
    expect(await decide({ mapped: ruled('DIVIDEND'), held: async () => [] })).toEqual({ type: 'INTEREST' });
  });

  it('reads the holdings only when a dividend names a ticker', async () => {
    let reads = 0;
    const counting = async () => { reads++; return []; };
    await decide({ description: 'Dividend Received', held: counting });
    await decide({ accountType: 'CASH', held: counting });
    expect(reads).toBe(0);
  });
});

describe('isDividendRow', () => {
  const FID = 'DIVIDEND RECEIVED VANGUARD INDEX FUNDS S&P 500 ETF USD (VOO) (Cash)';
  const row = (over: Partial<Parameters<typeof isDividendRow>[0]>) =>
    isDividendRow({ mapped: { type: 'DEPOSIT', fromRule: false }, amount: 12.34, accountType: 'SECURITIES', description: FID, ...over });

  it('is a known wording on a plain deposit in an investment account, or anything a rule typed DIVIDEND', () => {
    expect(row({})).toBe(true);
    expect(row({ mapped: { type: 'DIVIDEND', fromRule: true }, accountType: 'CASH', description: 'Dividend Received' })).toBe(true);
  });

  it('is not money out, a cash account, an unknown wording, or a row a rule typed otherwise', () => {
    expect(row({ amount: -12.34 })).toBe(false);
    expect(row({ accountType: 'CASH' })).toBe(false);
    expect(row({ description: 'Dividend Received' })).toBe(false);
    expect(row({ mapped: { type: 'DEPOSIT', fromRule: true } })).toBe(false);
    expect(row({ mapped: { type: 'INTEREST', fromRule: true } })).toBe(false);
  });
});

describe('a dividend paid after the position was sold', () => {
  const FID = 'DIVIDEND RECEIVED VANGUARD INDEX FUNDS S&P 500 ETF USD (VOO) (Cash)';
  const MSFT = 'DIVIDEND RECEIVED MICROSOFT CORP (MSFT) (Cash)';
  const past = [{ description: FID, assetId: 'a-voo' }, { description: MSFT, assetId: 'a-msft' }];
  const decide = (over: Partial<Parameters<typeof decideDividend>[0]>) =>
    decideDividend({
      mapped: { type: 'DEPOSIT', fromRule: false }, amount: 12.34, accountType: 'SECURITIES', description: FID,
      held: async () => [], past: async () => past, ...over,
    });

  it('names the one security the account\'s earlier dividends under the ticker are booked on', () => {
    expect(pastDividendSecurity('voo', past)).toBe('a-voo');
    expect(pastDividendSecurity('VOO', [...past, { description: FID, assetId: 'a-voo-2' }])).toBeNull();
    expect(pastDividendSecurity('SPAXX', past)).toBeNull();
  });

  it('books on it when nothing held carries the ticker, or the holdings read failed', async () => {
    expect(await decide({})).toEqual({ type: 'DIVIDEND', assetId: 'a-voo' });
    expect(await decide({ held: async () => null })).toEqual({ type: 'DIVIDEND', assetId: 'a-voo' });
    expect(await decide({ held: async () => [{ assetId: 'a-x', symbol: 'MSFT' }] })).toEqual({ type: 'DIVIDEND', assetId: 'a-voo' });
  });

  it('a holding wins over the history, and two holdings under the ticker name none', async () => {
    expect(await decide({ held: async () => [{ assetId: 'a-voo-now', symbol: 'VOO' }] })).toEqual({ type: 'DIVIDEND', assetId: 'a-voo-now' });
    expect(await decide({ held: async () => [{ assetId: 'a1', symbol: 'VOO' }, { assetId: 'a2', symbol: 'VOO' }] })).toBeNull();
  });

  it('leaves it a deposit with no history, or when the history read failed', async () => {
    expect(await decide({ past: async () => [] })).toBeNull();
    expect(await decide({ past: async () => null })).toBeNull();
    expect(await decide({ past: undefined })).toBeNull();
  });

  it('reads the history only when no holding carries the ticker', async () => {
    let reads = 0;
    await decide({ held: async () => [{ assetId: 'a-voo-now', symbol: 'VOO' }], past: async () => { reads++; return past; } });
    expect(reads).toBe(0);
  });
});
