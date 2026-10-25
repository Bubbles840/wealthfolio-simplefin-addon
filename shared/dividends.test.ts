import { describe, it, expect } from 'vitest';
import { decideDividend, dividendTicker, heldSecuritiesOf, heldSecurityFor, isDividendRow, pastSecurity, snapshotDatesToRead, snapshotDaysOf, type HeldSecurity } from './dividends.js';
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
    decideDividend({ mapped: deposit, amount: 12.34, accountType: 'SECURITIES', description: FID, date: '2027-03-10', held, ...over });

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
  const past = [{ type: 'DIVIDEND', description: FID, assetId: 'a-voo' }, { type: 'DIVIDEND', description: MSFT, assetId: 'a-msft' }];
  const decide = (over: Partial<Parameters<typeof decideDividend>[0]>) =>
    decideDividend({
      mapped: { type: 'DEPOSIT', fromRule: false }, amount: 12.34, accountType: 'SECURITIES', description: FID, date: '2027-03-10',
      held: async () => [], past: async () => past, ...over,
    });

  it('names the one security the account\'s earlier dividends under the ticker are booked on', () => {
    expect(pastSecurity('voo', past)).toBe('a-voo');
    expect(pastSecurity('VOO', [...past, { type: 'DIVIDEND', description: FID, assetId: 'a-voo-2' }])).toBeNull();
    expect(pastSecurity('SPAXX', past)).toBeNull();
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

describe('the cash line of a holdings read', () => {
  it('is not a security, so the ETF whose ticker is USD never lands on cash', () => {
    expect(heldSecuritiesOf([
      { holdingType: 'cash', instrument: { id: 'cash:USD', symbol: 'USD' } },
      { holdingType: 'security', instrument: { id: 'a-usd-etf', symbol: 'USD' } },
      { instrument: { id: '$CASH-USD', symbol: '$CASH-USD' } },
    ])).toEqual([{ assetId: 'a-usd-etf', symbol: 'USD' }]);
  });
});

describe('stored activity on a security', () => {
  const FID = 'DIVIDEND RECEIVED VANGUARD INDEX FUNDS S&P 500 ETF USD (VOO) (Cash)';

  it('names the security a trade or a dividend under the ticker is on, by its display code', () => {
    expect(pastSecurity('VOO', [{ type: 'BUY', description: 'YOU BOUGHT', assetId: 'a-voo', assetSymbol: 'VOO' }])).toBe('a-voo');
    expect(pastSecurity('VOO', [{ type: 'SELL', description: '', assetId: 'a-voo', assetSymbol: 'voo' }, { type: 'DIVIDEND', description: FID, assetId: 'a-voo' }])).toBe('a-voo');
    expect(pastSecurity('VOO', [{ type: 'BUY', description: '', assetId: 'a-voo', assetSymbol: 'VOO' }, { type: 'BUY', description: '', assetId: 'a-voo-2', assetSymbol: 'VOO' }])).toBeNull();
    expect(pastSecurity('VOO', [{ type: 'BUY', description: FID, assetId: 'a-x', assetSymbol: 'MSFT' }])).toBeNull();
  });
});

describe('a position bought and sold between two dividends', () => {
  const FID = 'DIVIDEND RECEIVED VANGUARD INDEX FUNDS S&P 500 ETF USD (VOO) (Cash)';
  const days = [
    { date: '2026-12-01', positionCount: 1 }, { date: '2027-01-20', positionCount: 2 },
    { date: '2027-02-10', positionCount: 2 }, { date: '2027-02-25', positionCount: 1 }, { date: '2027-03-12', positionCount: 1 },
  ];

  it('reads snapshots on or within 60 days before the dividend: the last before a sale first, then newest first', () => {
    expect(snapshotDatesToRead(days, '2027-03-10')).toEqual(['2027-02-10', '2027-02-25', '2027-01-20']);
    expect(snapshotDatesToRead(days, 'not a date')).toEqual([]);
  });

  it('reads at most eight', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ date: `2027-02-${String(i + 1).padStart(2, '0')}`, positionCount: 3 }));
    expect(snapshotDatesToRead(many, '2027-03-01')).toHaveLength(8);
  });

  it('lists snapshots from a snapshot listing, skipping malformed ones', () => {
    expect(snapshotDaysOf([{ snapshotDate: '2027-02-10', positionCount: 2, id: 'x' }, { snapshotDate: 5 }, null])).toEqual([{ date: '2027-02-10', positionCount: 2 }]);
    expect(snapshotDaysOf({})).toEqual([]);
  });

  const snapshotHoldings: Record<string, HeldSecurity[]> = {
    '2027-02-10': [{ assetId: 'a-voo', symbol: 'VOO' }, { assetId: 'a-msft', symbol: 'MSFT' }],
    '2027-02-25': [{ assetId: 'a-msft', symbol: 'MSFT' }],
    '2027-01-20': [{ assetId: 'a-voo-other', symbol: 'VOO' }, { assetId: 'a-msft', symbol: 'MSFT' }],
  };
  const reads: string[] = [];
  const decide = (over: Partial<Parameters<typeof decideDividend>[0]> = {}) =>
    decideDividend({
      mapped: { type: 'DEPOSIT', fromRule: false }, amount: 12.34, accountType: 'SECURITIES', description: FID, date: '2027-03-10',
      held: async () => [{ assetId: 'a-msft', symbol: 'MSFT' }], past: async () => [],
      snapshots: { days: async () => days, securities: async (d) => { reads.push(d); return snapshotHoldings[d] ?? null; } },
      ...over,
    });

  it('is booked on the security the first snapshot holding the ticker shows, and reads no further', async () => {
    reads.length = 0;
    expect(await decide()).toEqual({ type: 'DIVIDEND', assetId: 'a-voo' });
    expect(reads).toEqual(['2027-02-10']);
  });

  it('names none when that snapshot shows two securities under the ticker', async () => {
    const two = { days: async () => days, securities: async () => [{ assetId: 'a1', symbol: 'VOO' }, { assetId: 'a2', symbol: 'VOO' }] };
    expect(await decide({ snapshots: two })).toBeNull();
  });

  it('skips a snapshot that fails to read, and names none when no snapshot holds the ticker', async () => {
    const failing = { days: async () => days, securities: async (d: string) => (d === '2027-02-10' ? null : snapshotHoldings[d] ?? null) };
    expect(await decide({ snapshots: failing })).toEqual({ type: 'DIVIDEND', assetId: 'a-voo-other' });
    expect(await decide({ snapshots: { days: async () => days, securities: async () => [] } })).toBeNull();
    expect(await decide({ snapshots: { days: async () => null, securities: async () => [] } })).toBeNull();
  });

  it('asks the snapshots only when neither the holdings nor the stored activity show the ticker', async () => {
    reads.length = 0;
    await decide({ held: async () => [{ assetId: 'a-voo-now', symbol: 'VOO' }] });
    await decide({ past: async () => [{ type: 'BUY', description: '', assetId: 'a-voo', assetSymbol: 'VOO' }] });
    await decide({ past: async () => [{ type: 'BUY', description: '', assetId: 'a1', assetSymbol: 'VOO' }, { type: 'BUY', description: '', assetId: 'a2', assetSymbol: 'VOO' }] });
    expect(reads).toEqual([]);
  });
});

describe('a DIVIDEND rule with no reads (the other writer not new enough)', () => {
  it('is INTEREST, and a known wording without a rule is left alone', async () => {
    const base = { amount: 5, accountType: 'SECURITIES', description: 'DIVIDEND RECEIVED X (VOO) (Cash)', date: '2027-03-10', held: async () => null };
    expect(await decideDividend({ ...base, mapped: { type: 'DIVIDEND', fromRule: true } })).toEqual({ type: 'INTEREST' });
    expect(await decideDividend({ ...base, mapped: { type: 'DEPOSIT', fromRule: false } })).toBeNull();
  });
});

