import { describe, it, expect } from 'vitest';
import { isDistinctiveSignature, learnedNameKeys, learnedTransferType, parseTransferNames, transferSignature } from './transfer-names.js';
import { noteSignature } from './learn-transfer-names.js';
import { IN_TRANSIT_COMMENT_PREFIX } from './sync-core.js';

describe('transferSignature (A2)', () => {
  it('gives the three signatures the spec quotes', () => {
    expect(transferSignature('RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT')).toBe('transfer capital one ach web payment');
    expect(transferSignature('*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR')).toBe('payment citi autopay ach web recur');
    expect(transferSignature('Withdrawal to 360 Performance Savings XXXXXX1580')).toBe('withdrawal to performance savings');
  });

  it('drops a whole token that holds a digit, before splitting it', () => {
    expect(transferSignature('ONLINE TRANSFER TO SAV-0000 REF#12AB')).toBe('online transfer to');
    expect(transferSignature('A1B2C3 ZELLE')).toBe('zelle');
    expect(transferSignature('  ')).toBe('');
  });
});

describe('noteSignature strips what the sync adds to a stored note (A2)', () => {
  it('the transaction id, the pending marker, the in-transit prefix, a Venmo note and an Amazon label', () => {
    expect(noteSignature('Withdrawal to 360 Performance Savings XXXXXX1580 · TRN-000')).toBe('withdrawal to performance savings');
    expect(noteSignature('RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT · TRN-000 · pending')).toBe('transfer capital one ach web payment');
    expect(noteSignature(`${IN_TRANSIT_COMMENT_PREFIX}*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR · TRN-000`)).toBe('payment citi autopay ach web recur');
    expect(noteSignature('VENMO PAYMENT ACH WEB · Venmo: rent split · TRN-000')).toBe('venmo payment ach web');
    expect(noteSignature('AMAZON MKTPL · Amazon: Kitchen · TRN-000')).toBe('amazon mktpl');
  });
});

describe('isDistinctiveSignature (A3, R3)', () => {
  it('needs one word that is neither a generic bank word nor to/from/at/for', () => {
    expect(isDistinctiveSignature('payment')).toBe(false);
    expect(isDistinctiveSignature('ach debit')).toBe(false);
    expect(isDistinctiveSignature('online transfer')).toBe(false);
    expect(isDistinctiveSignature('online transfer to')).toBe(false);
    expect(isDistinctiveSignature('')).toBe(false);
    expect(isDistinctiveSignature('withdrawal to performance savings')).toBe(true);
    expect(isDistinctiveSignature('transfer capital one ach web payment')).toBe(true);
  });
});

describe('parseTransferNames', () => {
  it('reads the document, dropping a malformed name', () => {
    const raw = JSON.stringify({ version: 1, computedAt: '2026-10-18T15:00:00.000Z', names: [
      { accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' },
      { accountId: 'wf-spend', direction: 'sideways', signature: 'x' },
      { accountId: 'wf-spend', direction: 'out', signature: '' },
      null,
    ] });
    expect(parseTransferNames(raw)).toEqual({ version: 1, computedAt: '2026-10-18T15:00:00.000Z', names: [
      { accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' },
    ] });
  });

  it('is null when absent, unreadable or another version', () => {
    expect(parseTransferNames(null)).toBeNull();
    expect(parseTransferNames('{nope')).toBeNull();
    expect(parseTransferNames(JSON.stringify({ version: 2, names: [] }))).toBeNull();
    expect(parseTransferNames(JSON.stringify({ version: 1 }))).toBeNull();
  });
});

describe('learnedTransferType (A5)', () => {
  const keys = learnedNameKeys({ version: 1, computedAt: '', names: [
    { accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' },
  ] });
  const row = (over: Partial<Parameters<typeof learnedTransferType>[1]> = {}) => ({
    wfAccountId: 'wf-spend', accountType: 'CASH' as string | undefined, amount: 600,
    mapped: { type: 'DEPOSIT' as const, fromRule: false }, description: 'RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT', ...over,
  });

  it('types a listed (account, direction, signature) a transfer', () => {
    expect(learnedTransferType(keys, row())).toBe('TRANSFER_IN');
  });

  it('needs a known CASH account, no rule, a plain built-in type in the listed direction, and the listed account', () => {
    expect(learnedTransferType(keys, row({ accountType: undefined }))).toBeNull();
    expect(learnedTransferType(keys, row({ accountType: 'CREDIT_CARD' }))).toBeNull();
    expect(learnedTransferType(keys, row({ mapped: { type: 'DEPOSIT', fromRule: true } }))).toBeNull();
    expect(learnedTransferType(keys, row({ mapped: { type: 'CREDIT', fromRule: false } }))).toBeNull();
    expect(learnedTransferType(keys, row({ amount: -600, mapped: { type: 'WITHDRAWAL', fromRule: false } }))).toBeNull();
    expect(learnedTransferType(keys, row({ wfAccountId: 'wf-other' }))).toBeNull();
    expect(learnedTransferType(learnedNameKeys(null), row())).toBeNull();
  });
});
