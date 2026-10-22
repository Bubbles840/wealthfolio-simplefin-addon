import { describe, it, expect, vi } from 'vitest';
import { AddonSyncHost } from './addon-host';
import { LOAN_BALANCE_NOTES } from '../../shared/loan-balances';

const LOAN = { id: 'LIAB-1', name: 'Mortgage', currency: 'USD' };

/** The SDK's alternative-asset and quote calls, as a host offers them. */
function fakeCtx(history: Array<Record<string, unknown>> | undefined) {
  return {
    api: {
      alternativeAssets: { getAll: vi.fn(async () => [
        { id: 'LIAB-1', kind: 'liability', name: 'Mortgage', currency: 'USD' },
        { id: 'PROP-1', kind: 'property', name: 'House', currency: 'USD' },
      ]) },
      quotes: { getHistory: vi.fn(async () => history), update: vi.fn(async () => ({})) },
    },
  } as any;
}

describe('AddonSyncHost — loans', () => {
  it('listLoans keeps the liabilities', async () => {
    expect(await new AddonSyncHost(fakeCtx([])).listLoans()).toEqual([LOAN]);
  });

  it('confirmLoanBalance records the balance with quotes.update when it differs', async () => {
    const ctx = fakeCtx([{ timestamp: '2027-04-01T00:00:00Z', close: 240000, dataSource: 'MANUAL', notes: LOAN_BALANCE_NOTES }]);
    const decision = await new AddonSyncHost(ctx).confirmLoanBalance(LOAN, { date: '2027-04-14', balance: '250000', currency: 'USD' });
    expect(decision).toBe('write');
    expect(ctx.api.quotes.getHistory).toHaveBeenCalledWith('LIAB-1');
    expect(ctx.api.quotes.update).toHaveBeenCalledWith('LIAB-1', expect.objectContaining({
      id: 'LIAB-1_2027-04-14_MANUAL', timestamp: '2027-04-14T00:00:00Z', close: 250000, dataSource: 'MANUAL', notes: LOAN_BALANCE_NOTES,
    }));
  });

  it('confirmLoanBalance reads a loan with no history and writes nothing for a closed one', async () => {
    const fresh = fakeCtx(undefined);
    expect(await new AddonSyncHost(fresh).confirmLoanBalance(LOAN, { date: '2027-04-14', balance: '250000', currency: 'USD' })).toBe('write');
    const closed = fakeCtx([{ timestamp: '2027-04-13T00:00:00Z', close: 0, dataSource: 'MANUAL', notes: null }]);
    expect(await new AddonSyncHost(closed).confirmLoanBalance(LOAN, { date: '2027-04-14', balance: '250000', currency: 'USD' })).toBe('closed');
    expect(closed.api.quotes.update).not.toHaveBeenCalled();
  });
});
