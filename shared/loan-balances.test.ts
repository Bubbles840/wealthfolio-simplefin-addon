import { describe, it, expect } from 'vitest';
import {
  confirmLoanBalance, decideLoanBalance, loanBalanceOf, loanBalanceQuote, parseLoanLinks,
  LOAN_BALANCE_NOTES, type LoanQuote,
} from './loan-balances.js';
import type { SimplefinAccount } from './types.js';

const NOON = Date.parse('2026-03-10T12:00:00Z') / 1000;
const loan = (balance: string, at = NOON): SimplefinAccount => ({
  id: 'sfin-loan', name: 'Home Loan', currency: 'USD', balance, 'balance-date': at,
});

describe('parseLoanLinks', () => {
  it('keeps string-to-string entries and drops everything else', () => {
    expect(parseLoanLinks(JSON.stringify({ a: 'LIAB-1', b: '', c: 7, d: ' LIAB-2 ' }))).toEqual({ a: 'LIAB-1', d: 'LIAB-2' });
  });

  it('reads absent, corrupt and non-object documents as no links', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', 'null', '"x"']) expect(parseLoanLinks(raw)).toEqual({});
  });
});

describe('loanBalanceOf', () => {
  it('is what is owed, as a positive decimal, on the balance date', () => {
    expect(loanBalanceOf(loan('-250000.50'), { timeZone: 'UTC' })).toEqual({ date: '2026-03-10', balance: '250000.5', currency: 'USD' });
    expect(loanBalanceOf(loan('1200.00'), { timeZone: 'UTC' })).toEqual({ date: '2026-03-10', balance: '1200', currency: 'USD' });
  });

  it('never dates the balance after today', () => {
    const later = Date.parse('2026-03-12T12:00:00Z') / 1000;
    expect(loanBalanceOf(loan('-100', later), { timeZone: 'UTC', now: new Date('2026-03-11T08:00:00Z') })?.date).toBe('2026-03-11');
  });

  it('records nothing for a zero or unreadable balance', () => {
    for (const b of ['0', '-0.00', '', 'n/a']) expect(loanBalanceOf(loan(b), { timeZone: 'UTC' })).toBeNull();
  });
});

describe('decideLoanBalance', () => {
  const entry = { date: '2026-03-10', balance: '1000', currency: 'USD' };
  const ours = (close: string, date = '2026-03-10'): LoanQuote => ({ date, close, dataSource: 'MANUAL', notes: LOAN_BALANCE_NOTES });

  it('writes when the day has nothing, or only a market or other day\'s quote', () => {
    expect(decideLoanBalance([], entry)).toBe('write');
    expect(decideLoanBalance([ours('1000', '2026-03-09'), { date: '2026-03-10', close: '1000', dataSource: 'YAHOO' }], entry)).toBe('write');
  });

  it('leaves the same balance alone, and replaces its own different one', () => {
    expect(decideLoanBalance([ours('1000.00')], entry)).toBe('unchanged');
    expect(decideLoanBalance([{ ...ours('1000'), date: '2026-03-10T00:00:00Z' }], entry)).toBe('unchanged');
    expect(decideLoanBalance([ours('1100')], entry)).toBe('write');
  });

  it('keeps a balance the person recorded that day', () => {
    expect(decideLoanBalance([{ date: '2026-03-10', close: '990', dataSource: 'MANUAL', notes: 'loan_event|type=balance_correction' }], entry)).toBe('theirs');
    expect(decideLoanBalance([{ date: '2026-03-10', close: '1000', dataSource: 'MANUAL', notes: null }], entry)).toBe('theirs');
  });
});

describe('loanBalanceQuote', () => {
  it('is the manual quote Confirm balance saves, with the sync\'s note', () => {
    const q = loanBalanceQuote('LIAB-1', { date: '2026-03-10', balance: '1000', currency: 'USD' }, new Date('2026-03-10T15:00:00Z'));
    expect(q).toMatchObject({
      id: 'LIAB-1_2026-03-10_MANUAL', assetId: 'LIAB-1', timestamp: '2026-03-10T00:00:00Z',
      close: 1000, currency: 'USD', dataSource: 'MANUAL', notes: 'loan_event|type=balance_correction|note=SimpleFin',
    });
  });
});

describe('confirmLoanBalance', () => {
  it('writes only on a write decision', async () => {
    const writes: string[] = [];
    const io = (existing: LoanQuote[]) => ({ history: async () => existing, write: async (_id: string, q: { close: number }) => { writes.push(String(q.close)); } });
    const entry = { date: '2026-03-10', balance: '1000', currency: 'USD' };
    expect(await confirmLoanBalance(io([]), 'LIAB-1', entry)).toBe('write');
    expect(await confirmLoanBalance(io([{ date: '2026-03-10', close: '1000', dataSource: 'MANUAL', notes: LOAN_BALANCE_NOTES }]), 'LIAB-1', entry)).toBe('unchanged');
    expect(writes).toEqual(['1000']);
  });
});
