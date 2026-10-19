import { describe, it, expect } from 'vitest';
import { bankFirstTransferOut, genericTransferNeedsCorroboration, MONEY_MOVEMENT_WORDS, namesConnectedAccount } from './bank-first-payment.js';
import { accountNameWords } from './sync-core.js';
import type { MappedType } from './mapper.js';

/** The other connected accounts a PNC cash account sees, as the sync builds their words. */
const OTHERS = [
  accountNameWords('Citi Double Cash® Card', 'Citibank'),
  accountNameWords('Robinhood Credit Card'),
  accountNameWords('Robinhood individual'),
  accountNameWords('Discover it Card'),
  accountNameWords('Chase Freedom Unlimited'),
  accountNameWords('360 Performance Savings', 'Capital One'),
];
const WITHDRAWAL: MappedType = { type: 'WITHDRAWAL', fromRule: false };
const bankFirst = (description: string, over: { amount?: number; accountType?: string | undefined; mapped?: MappedType } = {}) =>
  bankFirstTransferOut(description, over.amount ?? -42.4, 'accountType' in over ? over.accountType : 'CASH', over.mapped ?? WITHDRAWAL, OTHERS);

describe('bankFirstTransferOut (A)', () => {
  it('types money out that names a connected account, in money-movement words, as a transfer', () => {
    for (const desc of [
      '*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR',
      'PAYMENT ROBINHOOD CCB ACH DEBIT',
      'ACH DEBIT ROBINHOOD CCB',
      '4090 E-PAYMENT DISCOVER ACH WEB',
      'RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT',
    ]) {
      expect(bankFirst(desc)).toBe(true);
    }
  });

  it('leaves a bill that names no connected account alone', () => {
    for (const desc of ['*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT', '*8768 PAYMENT VENMO ACH WEB', '3447db1440b44a1 BILTRENT BILT PAYMENT ACH WEB']) {
      expect(bankFirst(desc)).toBe(false);
    }
  });

  it('needs money-movement words: a purchase at a store sharing a word with an account is spending', () => {
    expect(bankFirst('CITI TRENDS #1234 LOUISVILLE KY')).toBe(false);
    expect(bankFirst('DISCOVER BOOKS LOUISVILLE')).toBe(false);
  });

  it('matches whole words only', () => {
    expect(bankFirst('CITIZENS UTILITY PAYMENT')).toBe(false);
    expect(bankFirst('CHASERS SPORTS BAR PAYMENT')).toBe(false);
    expect(namesConnectedAccount('PAYMENT TO DISCOVER', OTHERS)).toBe(true);
    expect(namesConnectedAccount('PAYMENT TO DISCOVERY KIDS', OTHERS)).toBe(false);
  });

  it('covers money out on a cash account only (R1)', () => {
    expect(bankFirst('Credit card cashback rewards of $12.67 transferred to Robinhood Brokerage account', { amount: 12.67 })).toBe(false);
    expect(bankFirst('PAYMENT ROBINHOOD CCB ACH DEBIT', { accountType: 'CREDIT_CARD' })).toBe(false);
    // listAccounts failed: an unknown type is not evidence of a cash account.
    expect(bankFirst('PAYMENT ROBINHOOD CCB ACH DEBIT', { accountType: undefined })).toBe(false);
  });

  it('never overrides a mapping rule, and has nothing to do once the mapper said transfer', () => {
    expect(bankFirst('PAYMENT ROBINHOOD CCB ACH DEBIT', { mapped: { type: 'WITHDRAWAL', fromRule: true } })).toBe(false);
    expect(bankFirst('PAYMENT ROBINHOOD CCB ACH DEBIT', { mapped: { type: 'TRANSFER_OUT', fromRule: false } })).toBe(false);
  });

  it('names nothing when there is no other connected account', () => {
    expect(bankFirstTransferOut('PAYMENT ROBINHOOD CCB ACH DEBIT', -50, 'CASH', WITHDRAWAL, [])).toBe(false);
  });
});

describe('MONEY_MOVEMENT_WORDS (R3)', () => {
  it('knows each phrasing as a whole word, in any case', () => {
    for (const word of ['payment', 'PMT', 'Autopay', 'AUTO-PMT', 'e-pay', 'EPAY', 'E-PAYMENT', 'transfer', 'ACH']) {
      expect(MONEY_MOVEMENT_WORDS.test(`X ${word} Y`)).toBe(true);
    }
  });

  it('does not find them inside other words', () => {
    for (const text of ['ACHIEVE FITNESS', 'PAYMENTUS UTILITIES', 'TRANSFERWISE', 'REPAY ME']) {
      expect(MONEY_MOVEMENT_WORDS.test(text)).toBe(false);
    }
  });

  it('loads on Safari before 16.4: no lookbehind, and no g flag to make .test stateful (F3)', () => {
    expect(MONEY_MOVEMENT_WORDS.source).not.toContain('(?<');
    expect(MONEY_MOVEMENT_WORDS.flags).not.toContain('g');
    // A word at the very start still counts, and a letter before it still blocks it.
    expect(MONEY_MOVEMENT_WORDS.test('ACH DEBIT ROBINHOOD CCB')).toBe(true);
    expect(MONEY_MOVEMENT_WORDS.test('XPAYMENT')).toBe(false);
    expect(MONEY_MOVEMENT_WORDS.test('9ACH')).toBe(false);
  });
});

describe('genericTransferNeedsCorroboration (1.65 B)', () => {
  const GENERIC: MappedType = { type: 'TRANSFER_OUT', fromRule: false, genericTransferWording: true };
  const needs = (description: string, over: { amount?: number; accountType?: string | undefined; mapped?: MappedType } = {}) =>
    genericTransferNeedsCorroboration(description, over.amount ?? -250, 'accountType' in over ? over.accountType : 'CASH', over.mapped ?? GENERIC, OTHERS);

  it('is true for generic money out of a cash account that names no other connected account', () => {
    expect(needs('WIRE TRANSFER TO ACME LLC')).toBe(true);
    expect(needs('ONLINE TRANSFERS TO 0000')).toBe(true);
  });

  it('is false when the text names another connected account, as a whole word', () => {
    expect(needs('ONLINE TRANSFER TO CITI CARD 0000')).toBe(false);
    expect(needs('WIRE TRANSFER TO ROBINHOOD')).toBe(false);
    expect(needs('WIRE TRANSFER TO CITIZENS LLC')).toBe(true);
  });

  it('is false for money in, a card or an unknown account type, a rule, and an unflagged type', () => {
    expect(needs('WIRE TRANSFER FROM ACME LLC', { amount: 250 })).toBe(false);
    expect(needs('WIRE TRANSFER TO ACME LLC', { accountType: 'CREDIT_CARD' })).toBe(false);
    expect(needs('WIRE TRANSFER TO ACME LLC', { accountType: undefined })).toBe(false);
    expect(needs('WIRE TRANSFER TO ACME LLC', { mapped: { type: 'TRANSFER_OUT', fromRule: true } })).toBe(false);
    expect(needs('WIRE TRANSFER TO ACME LLC', { mapped: { type: 'TRANSFER_OUT', fromRule: false } })).toBe(false);
  });
});
