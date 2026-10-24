import { describe, it, expect } from 'vitest';
import { decideDividend, dividendTicker, heldSecuritiesOf, heldSecurityFor, type HeldSecurity } from './dividends.js';
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
