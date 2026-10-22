import { describe, it, expect } from 'vitest';
import {
  confirmLoanBalance, decideLoanBalance, linkedLoansOf, loanBalanceOf, loanBalanceQuote, parseLoanLinks, toCents,
  LOAN_BALANCE_NOTES, LOAN_CLOSED_NOTES, type LinkedLoan, type LoanQuote,
} from './loan-balances.js';
import type { SimplefinAccount } from './types.js';

const NOW = new Date('2026-03-10T18:00:00Z');
const NOON = Date.parse('2026-03-10T12:00:00Z') / 1000;
const feed = (balance: string, at: number = NOON, currency = 'USD'): SimplefinAccount => ({
  id: 'sfin-loan', name: 'Home Loan', currency, balance, 'balance-date': at,
});
const LOAN: LinkedLoan = { id: 'LIAB-1', name: 'Home Loan', currency: 'USD', originationDate: '2020-01-15' };
const entry = (balance: string, date = '2026-03-10', currency = 'USD') => ({ date, balance, currency });
const ours = (close: string | number, date: string): LoanQuote => ({ date, close, dataSource: 'MANUAL', notes: LOAN_BALANCE_NOTES });

describe('parseLoanLinks', () => {
  it('keeps string-to-string entries and drops everything else', () => {
    expect(parseLoanLinks(JSON.stringify({ a: 'LIAB-1', b: '', c: 7, d: ' LIAB-2 ' }))).toEqual({ a: 'LIAB-1', d: 'LIAB-2' });
  });

  it('reads absent, corrupt and non-object documents as no links', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', 'null', '"x"']) expect(parseLoanLinks(raw)).toEqual({});
  });
});

describe('linkedLoansOf', () => {
  it('keeps liabilities, with their currency and origination date', () => {
    expect(linkedLoansOf([
      { id: 'LIAB-1', kind: 'liability', name: 'Home Loan', currency: 'USD', metadata: { origination_date: '2020-01-15' } },
      { id: 'LIAB-2', kind: 'liability', name: 'Car Loan', currency: ' CAD ', metadata: null },
      { id: 'PROP-1', kind: 'property', name: 'House', currency: 'USD' },
      { kind: 'liability', name: 'No id' },
    ])).toEqual([
      { id: 'LIAB-1', name: 'Home Loan', currency: 'USD', originationDate: '2020-01-15' },
      { id: 'LIAB-2', name: 'Car Loan', currency: 'CAD' },
    ]);
    expect(linkedLoansOf(null)).toEqual([]);
  });
});

describe('loanBalanceOf', () => {
  it('is what is owed, as a decimal size, on the balance date, with the feed\'s currency', () => {
    expect(loanBalanceOf(feed('-250000.50'), { timeZone: 'UTC', now: NOW })).toEqual(entry('250000.5'));
    expect(loanBalanceOf(feed('1200.00', NOON, ' '), { timeZone: 'UTC', now: NOW })).toEqual(entry('1200', '2026-03-10', ''));
    expect(loanBalanceOf(feed('-0.00'), { timeZone: 'UTC', now: NOW })?.balance).toBe('0');
  });

  it('never dates the balance after today', () => {
    const later = Date.parse('2026-03-12T12:00:00Z') / 1000;
    expect(loanBalanceOf(feed('-100', later), { timeZone: 'UTC', now: NOW })?.date).toBe('2026-03-10');
  });

  it('reads nothing from an unreadable balance or balance date, rather than throwing', () => {
    for (const b of ['', 'n/a']) expect(loanBalanceOf(feed(b), { timeZone: 'UTC', now: NOW })).toBeNull();
    const undated = { ...feed('-100') } as Partial<SimplefinAccount>;
    delete undated['balance-date'];
    expect(loanBalanceOf(undated as SimplefinAccount, { timeZone: 'UTC', now: NOW })).toBeNull();
  });
});

describe('toCents', () => {
  it('rounds half up to cents, as Confirm balance stores it', () => {
    expect(toCents('250000.905')).toBe('250000.91');
    expect(toCents('250000.904')).toBe('250000.9');
    expect(toCents('0.995')).toBe('1');
    expect(toCents('100')).toBe('100');
  });
});

describe('decideLoanBalance', () => {
  it('writes when nothing is recorded, or the latest recorded balance differs', () => {
    expect(decideLoanBalance(LOAN, [], entry('1000'))).toBe('write');
    expect(decideLoanBalance(LOAN, [ours('1100', '2026-03-01')], entry('1000'))).toBe('write');
  });

  it('writes nothing new when the latest recorded balance on or before the day already says it', () => {
    expect(decideLoanBalance(LOAN, [ours('1000.00', '2026-03-01')], entry('1000'))).toBe('unchanged');
    expect(decideLoanBalance(LOAN, [ours(1000, '2026-03-10T00:00:00Z')], entry('1000'))).toBe('unchanged');
    // Rounded the way it would be written.
    expect(decideLoanBalance(LOAN, [ours(1000.01, '2026-03-01')], entry('1000.005'))).toBe('unchanged');
    // A later balance is not "latest on or before".
    expect(decideLoanBalance(LOAN, [ours('1000', '2026-03-01'), ours('900', '2026-03-20')], entry('1000'))).toBe('unchanged');
  });

  it('never reopens a closed loan, even when the feed lags', () => {
    const closed: LoanQuote = { date: '2026-03-09', close: 0, dataSource: 'MANUAL', notes: LOAN_CLOSED_NOTES };
    expect(decideLoanBalance(LOAN, [ours('1000', '2026-03-01'), closed], entry('1000'))).toBe('closed');
    expect(decideLoanBalance(LOAN, [closed], entry('0'))).toBe('closed');
    // A close AFTER the day does not stop that day's balance.
    expect(decideLoanBalance(LOAN, [{ ...closed, date: '2026-03-11' }], entry('1000'))).toBe('write');
  });

  it('reports a feed showing nothing owed on an open loan, and never writes it', () => {
    expect(decideLoanBalance(LOAN, [ours('1000', '2026-03-01')], entry('0'))).toBe('zero');
  });

  it('keeps a balance the person recorded that day', () => {
    expect(decideLoanBalance(LOAN, [{ date: '2026-03-10', close: 990, dataSource: 'MANUAL', notes: 'loan_event|type=balance_correction' }], entry('1000'))).toBe('theirs');
    expect(decideLoanBalance(LOAN, [{ date: '2026-03-10', close: 990, dataSource: 'MANUAL', notes: null }], entry('1000'))).toBe('theirs');
  });

  it('refuses a feed in another currency than the loan, and allows a blank one', () => {
    expect(decideLoanBalance(LOAN, [], entry('1000', '2026-03-10', 'CAD'))).toBe('currency');
    expect(decideLoanBalance(LOAN, [], entry('1000', '2026-03-10', 'usd'))).toBe('write');
    expect(decideLoanBalance(LOAN, [], entry('1000', '2026-03-10', ''))).toBe('write');
  });

  it('writes nothing dated before the loan began', () => {
    expect(decideLoanBalance(LOAN, [], entry('1000', '2019-12-31'))).toBe('early');
  });
});

describe('loanBalanceQuote', () => {
  it('is the manual quote Confirm balance saves: the loan\'s currency, cents, the sync\'s note', () => {
    const q = loanBalanceQuote(LOAN, entry('1000.005', '2026-03-10', ''), NOW);
    expect(q).toMatchObject({
      id: 'LIAB-1_2026-03-10_MANUAL', assetId: 'LIAB-1', timestamp: '2026-03-10T00:00:00Z',
      close: 1000.01, currency: 'USD', dataSource: 'MANUAL', notes: 'loan_event|type=balance_correction|note=SimpleFin',
    });
  });
});

describe('confirmLoanBalance', () => {
  it('writes only on a write decision', async () => {
    const writes: number[] = [];
    const io = (existing: LoanQuote[]) => ({ history: async () => existing, write: async (_id: string, q: { close: number }) => { writes.push(q.close); } });
    expect(await confirmLoanBalance(io([]), LOAN, entry('1000'))).toBe('write');
    expect(await confirmLoanBalance(io([ours('1000', '2026-03-09')]), LOAN, entry('1000'))).toBe('unchanged');
    expect(writes).toEqual([1000]);
  });
});
