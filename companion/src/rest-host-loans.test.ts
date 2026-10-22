import { describe, it, expect, vi } from 'vitest';
import { RestSyncHost, RestSyncStore } from './rest-host.js';
import { LOAN_BALANCE_NOTES, LOAN_LINKS_SECRET_KEY } from '../../shared/loan-balances.js';

const LOAN = { id: 'LIAB/1', name: 'Mortgage', currency: 'USD' };

describe('RestSyncHost — loans', () => {
  it('listLoans keeps the liabilities among the alternative holdings', async () => {
    const client = { getAlternativeHoldings: vi.fn(async () => [
      { id: 'LIAB/1', kind: 'liability', name: 'Mortgage', currency: 'USD' },
      { id: 'PROP-1', kind: 'property', name: 'House', currency: 'USD' },
    ]) };
    expect(await new RestSyncHost(client as any).listLoans()).toEqual([LOAN]);
  });

  it('confirmLoanBalance reads the loan\'s quotes by date and writes the new balance through updateQuote', async () => {
    const client = {
      getQuoteHistory: vi.fn(async () => [
        { timestamp: '2027-04-01T00:00:00Z', close: 240000, dataSource: 'MANUAL', notes: LOAN_BALANCE_NOTES },
      ]),
      updateQuote: vi.fn(async () => {}),
    };
    const decision = await new RestSyncHost(client as any).confirmLoanBalance(LOAN, { date: '2027-04-14', balance: '250000', currency: 'USD' });
    expect(decision).toBe('write');
    expect(client.getQuoteHistory).toHaveBeenCalledWith('LIAB/1');
    expect(client.updateQuote).toHaveBeenCalledTimes(1);
    const [assetId, quote] = client.updateQuote.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(assetId).toBe('LIAB/1');
    expect(quote).toMatchObject({ id: 'LIAB/1_2027-04-14_MANUAL', timestamp: '2027-04-14T00:00:00Z', close: 250000, dataSource: 'MANUAL', notes: LOAN_BALANCE_NOTES });
  });

  it('confirmLoanBalance writes nothing when the latest recorded balance already says so', async () => {
    const client = {
      getQuoteHistory: vi.fn(async () => [{ timestamp: '2027-04-01T00:00:00Z', close: '250000', dataSource: 'MANUAL' }]),
      updateQuote: vi.fn(),
    };
    const decision = await new RestSyncHost(client as any).confirmLoanBalance(LOAN, { date: '2027-04-14', balance: '250000', currency: 'USD' });
    expect(decision).toBe('unchanged');
    expect(client.updateQuote).not.toHaveBeenCalled();
  });
});

describe('RestSyncStore — loan links', () => {
  const storeWith = (value: string | null) => {
    const getAddonSecret = vi.fn(async () => value);
    return { store: new RestSyncStore({ getAddonSecret } as any), getAddonSecret };
  };

  it('reads the links the add-on stores, under the same key', async () => {
    const { store, getAddonSecret } = storeWith(JSON.stringify({ 'sfin-loan': 'LIAB-1', bad: 7 }));
    expect(await store.getLoanLinks()).toEqual({ 'sfin-loan': 'LIAB-1' });
    expect(getAddonSecret).toHaveBeenCalledWith(expect.any(String), LOAN_LINKS_SECRET_KEY);
  });

  it('reads absent or corrupt links as none', async () => {
    expect(await storeWith(null).store.getLoanLinks()).toEqual({});
    expect(await storeWith('not json').store.getLoanLinks()).toEqual({});
  });
});
