import { describe, it, expect, beforeEach } from 'vitest';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { LOAN_BALANCE_NOTES } from './loan-balances.js';

/**
 * A loan servicer's SimpleFin account linked to a Wealthfolio liability: its
 * balance is recorded on the liability, and it is neither imported nor reported
 * as unmapped.
 */
describe('loan balances', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
  });

  const at = () => Math.floor(Date.now() / 1000) - 3600;
  const today = () => {
    const d = new Date(at() * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const seed = (extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
    accountSet: { errors: [], accounts: [
      { id: 'sfin-chk', name: 'Checking', currency: 'USD', balance: '500.00', 'balance-date': at(), transactions: [] },
      { id: 'sfin-loan', name: 'Home Loan', currency: 'USD', balance: '-250000.00', 'balance-date': at(), transactions: [
        { id: 'TRN-pay', posted: at(), amount: '1500.00', description: 'PAYMENT RECEIVED' },
      ] },
    ] },
    mapping: { 'sfin-chk': 'wf-chk' },
    loanLinks: { 'sfin-loan': 'LIAB-1' },
    ...extra,
  });

  it('records the balance on the liability, and imports nothing from the loan account', async () => {
    const { host, store, loanQuotes, activities } = createFakeHost(seed());
    const result = await runSyncCore(host, store, { force: true });

    expect(result.loanBalancesRecorded).toBe(1);
    expect(loanQuotes.get('LIAB-1')).toEqual([{ date: today(), close: 250000, dataSource: 'MANUAL', notes: LOAN_BALANCE_NOTES }]);
    expect([...activities.values()].flat().some((r) => r.comment?.includes('TRN-pay'))).toBe(false);
    expect(result.unmappedAccounts).toEqual([]);
  });

  it('writes nothing again when the day already has that balance', async () => {
    const { host, store, loanQuotes } = createFakeHost(seed());
    await runSyncCore(host, store, { force: true });
    const second = await runSyncCore(host, store, { force: true });

    expect(second.loanBalancesRecorded).toBe(0);
    expect(loanQuotes.get('LIAB-1')).toHaveLength(1);
  });

  it('keeps a balance the person recorded that day', async () => {
    const mine = { date: today(), close: '249000', dataSource: 'MANUAL', notes: 'loan_event|type=balance_correction' };
    const { host, store, loanQuotes } = createFakeHost(seed({ loanQuotes: new Map([['LIAB-1', [mine]]]) }));
    const result = await runSyncCore(host, store, { force: true });

    expect(result.loanBalancesRecorded).toBe(0);
    expect(loanQuotes.get('LIAB-1')).toEqual([mine]);
  });

  it('reports a failed write without failing the sync', async () => {
    const { host, store } = createFakeHost(seed({ loanThrows: 'quote refused' }));
    const result = await runSyncCore(host, store, { force: true });

    expect(result.errors).toContain('Loan balance failed (Home Loan): quote refused');
    expect(result.loanBalancesRecorded).toBe(0);
  });

  it('reports an unlinked loan account as unmapped, as before', async () => {
    const { host, store, loanQuotes } = createFakeHost(seed({ loanLinks: {} }));
    const result = await runSyncCore(host, store, { force: true });

    expect(result.unmappedAccounts?.map((a) => a.sfinAccountId)).toEqual(['sfin-loan']);
    expect(loanQuotes.size).toBe(0);
  });
});
