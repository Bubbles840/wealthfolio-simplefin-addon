import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { LOAN_BALANCE_NOTES, LOAN_CLOSED_NOTES } from './loan-balances.js';
import type { SimplefinAccount } from './types.js';

/**
 * A loan servicer's SimpleFin account linked to a Wealthfolio liability: its
 * balance is recorded on the liability when it changes, and it is neither
 * imported nor reported as unmapped.
 */
describe('loan balances', () => {
  // Noon UTC, so the balance date is the same calendar day in every zone the
  // suite might run in.
  const NOW = new Date('2027-04-14T12:00:00Z');
  const AT = Date.parse('2027-04-14T11:00:00Z') / 1000;
  const DAY = '2027-04-14';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
  });
  afterEach(() => { vi.useRealTimers(); });

  const loanAccount = (over: Partial<SimplefinAccount> = {}): SimplefinAccount => ({
    id: 'sfin-loan', name: 'Home Loan', currency: 'USD', balance: '-250000.00', 'balance-date': AT, transactions: [
      { id: 'TRN-pay', posted: AT, amount: '1500.00', description: 'PAYMENT RECEIVED' },
    ],
    ...over,
  });
  const seed = (extra: Partial<FakeHostSeed> = {}, loan: Partial<SimplefinAccount> = {}): FakeHostSeed => ({
    accountSet: { errors: [], accounts: [
      { id: 'sfin-chk', name: 'Checking', currency: 'USD', balance: '500.00', 'balance-date': AT, transactions: [] },
      loanAccount(loan),
    ] },
    mapping: { 'sfin-chk': 'wf-chk' },
    loanLinks: { 'sfin-loan': 'LIAB-1' },
    loans: [{ id: 'LIAB-1', name: 'Mortgage', currency: 'USD' }],
    ...extra,
  });
  const ours = (close: number, date: string) => ({ date, close, dataSource: 'MANUAL', notes: LOAN_BALANCE_NOTES });

  it('records the balance on the liability, and imports nothing from the loan account', async () => {
    const { host, store, loanQuotes, activities } = createFakeHost(seed());
    const result = await runSyncCore(host, store, { force: true });

    expect(result.loanBalancesRecorded).toBe(1);
    expect(loanQuotes.get('LIAB-1')).toEqual([{ date: DAY, close: 250000, dataSource: 'MANUAL', notes: LOAN_BALANCE_NOTES }]);
    expect([...activities.values()].flat().some((r) => r.comment?.includes('TRN-pay'))).toBe(false);
    expect(result.unmappedAccounts).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('writes nothing on a later day when the balance has not changed', async () => {
    const { host, store, loanQuotes } = createFakeHost(seed({ loanQuotes: new Map([['LIAB-1', [ours(250000, '2027-04-01')]]]) }));
    const result = await runSyncCore(host, store, { force: true });

    expect(result.loanBalancesRecorded).toBe(0);
    expect(loanQuotes.get('LIAB-1')).toHaveLength(1);
  });

  it('a second sync writes nothing', async () => {
    const { host, store, loanQuotes } = createFakeHost(seed());
    await runSyncCore(host, store, { force: true });
    const second = await runSyncCore(host, store, { force: true });

    expect(second.loanBalancesRecorded).toBe(0);
    expect(loanQuotes.get('LIAB-1')).toHaveLength(1);
  });

  it('never reopens a loan closed while the feed lags', async () => {
    const closed = { date: '2027-04-13', close: 0, dataSource: 'MANUAL', notes: LOAN_CLOSED_NOTES };
    const { host, store, loanQuotes } = createFakeHost(seed({ loanQuotes: new Map([['LIAB-1', [closed]]]) }));
    const result = await runSyncCore(host, store, { force: true });

    expect(result.loanBalancesRecorded).toBe(0);
    expect(loanQuotes.get('LIAB-1')).toEqual([closed]);
    expect(result.errors).toEqual([]);
  });

  it('reports a feed showing nothing owed, and writes nothing', async () => {
    const { host, store, loanQuotes } = createFakeHost(seed({}, { balance: '0.00' }));
    const result = await runSyncCore(host, store, { force: true });

    expect(result.errors).toEqual(['Home Loan shows nothing owed on Mortgage: if the loan is paid off, close it in Wealthfolio']);
    expect(loanQuotes.size).toBe(0);
  });

  it('keeps a balance the person recorded that day', async () => {
    const mine = { date: DAY, close: 249000, dataSource: 'MANUAL', notes: 'loan_event|type=balance_correction' };
    const { host, store, loanQuotes } = createFakeHost(seed({ loanQuotes: new Map([['LIAB-1', [mine]]]) }));
    const result = await runSyncCore(host, store, { force: true });

    expect(result.loanBalancesRecorded).toBe(0);
    expect(loanQuotes.get('LIAB-1')).toEqual([mine]);
  });

  it('writes in the loan\'s currency when the feed sends none, and refuses another one', async () => {
    const blank = createFakeHost(seed({}, { currency: '' }));
    await runSyncCore(blank.host, blank.store, { force: true });
    expect(blank.loanQuotes.get('LIAB-1')).toHaveLength(1);

    const cad = createFakeHost(seed({}, { currency: 'CAD' }));
    const result = await runSyncCore(cad.host, cad.store, { force: true });
    expect(result.errors).toEqual(['Loan balance not recorded (Home Loan): the bank reports CAD, Mortgage is in USD']);
    expect(cad.loanQuotes.size).toBe(0);
  });

  it('does not crash the sync on a feed with no balance date', async () => {
    const undated = seed();
    delete (undated.accountSet!.accounts[1] as Partial<SimplefinAccount>)['balance-date'];
    const { host, store, loanQuotes } = createFakeHost(undated);
    const result = await runSyncCore(host, store, { force: true });

    expect(result.errors).toEqual([]);
    expect(loanQuotes.size).toBe(0);
  });

  it('treats a link to a deleted loan as no link: unmapped again, and no error every sync', async () => {
    const { host, store, loanQuotes } = createFakeHost(seed({ loans: [] }));
    const result = await runSyncCore(host, store, { force: true });

    expect(result.unmappedAccounts?.map((a) => a.sfinAccountId)).toEqual(['sfin-loan']);
    expect(result.errors).toEqual([]);
    expect(loanQuotes.size).toBe(0);
  });

  it('trusts the links but writes nothing when the loans cannot be read', async () => {
    const { host, store, loanQuotes } = createFakeHost(seed({ loansThrow: true }));
    const result = await runSyncCore(host, store, { force: true });

    expect(result.unmappedAccounts).toEqual([]);
    expect(result.errors).toEqual(['Loan balances skipped: the loans could not be read (loans unavailable)']);
    expect(loanQuotes.size).toBe(0);
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
