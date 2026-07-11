import { describe, it, expect } from 'vitest';
import { mapTransaction, mapTransactionWithSource, CARD_PAYMENT_KEYWORDS } from './mapper';
import type { MappingRule } from './types';

describe('mapTransaction', () => {
  const noRules: MappingRule[] = [];

  it('maps positive amount to DEPOSIT by default', () => {
    expect(mapTransaction('Coffee shop', 50.0, noRules)).toBe('DEPOSIT');
  });

  it('maps negative amount to WITHDRAWAL by default', () => {
    expect(mapTransaction('Coffee shop', -12.5, noRules)).toBe('WITHDRAWAL');
  });

  it('maps zero amount to DEPOSIT', () => {
    expect(mapTransaction('Zero tx', 0, noRules)).toBe('DEPOSIT');
  });

  it('applies contains rule before defaults (case-insensitive)', () => {
    const rules: MappingRule[] = [
      { pattern: 'dividend', matchType: 'contains', activityType: 'DIVIDEND' },
    ];
    expect(mapTransaction('AAPL DIVIDEND PAYMENT', -5.0, rules)).toBe('DIVIDEND');
  });

  it('applies regex rule', () => {
    const rules: MappingRule[] = [
      { pattern: '^INTEREST', matchType: 'regex', activityType: 'INTEREST' },
    ];
    expect(mapTransaction('INTEREST EARNED', 1.23, rules)).toBe('INTEREST');
  });

  it('first matching rule wins', () => {
    const rules: MappingRule[] = [
      { pattern: 'transfer', matchType: 'contains', activityType: 'TRANSFER_IN' },
      { pattern: 'transfer', matchType: 'contains', activityType: 'TRANSFER_OUT' },
    ];
    expect(mapTransaction('ACH TRANSFER', 100, rules)).toBe('TRANSFER_IN');
  });

  it('falls through to default when no rule matches', () => {
    const rules: MappingRule[] = [
      { pattern: 'dividend', matchType: 'contains', activityType: 'DIVIDEND' },
    ];
    expect(mapTransaction('Grocery store', -30, rules)).toBe('WITHDRAWAL');
  });

  it('skips invalid regex rules instead of throwing (protects sync runs)', () => {
    const rules: MappingRule[] = [
      { pattern: '[invalid', matchType: 'regex', activityType: 'INTEREST' },
    ];
    // Must not throw — falls through to amount-based default
    expect(mapTransaction('test', 1, rules)).toBe('DEPOSIT');
    expect(mapTransaction('test', -1, rules)).toBe('WITHDRAWAL');
  });
});

describe('mapTransactionWithSource', () => {
  it('reports fromRule=true when a rule matched', () => {
    const rules = [{ pattern: 'dividend', matchType: 'contains' as const, activityType: 'DIVIDEND' as const }];
    expect(mapTransactionWithSource('AAPL DIVIDEND', 5, rules)).toEqual({ type: 'DIVIDEND', fromRule: true });
  });

  it('defaults cash accounts by sign, fromRule=false', () => {
    expect(mapTransactionWithSource('Coffee', -4.5, [], 'CASH')).toEqual({ type: 'WITHDRAWAL', fromRule: false });
    expect(mapTransactionWithSource('Payroll', 100, [], 'CASH')).toEqual({ type: 'DEPOSIT', fromRule: false });
  });

  it('types positive credit-card amounts as CREDIT (refund) by default', () => {
    expect(mapTransactionWithSource('UNIQLO REFUND', 66.45, [], 'CREDIT_CARD'))
      .toEqual({ type: 'CREDIT', fromRule: false });
  });

  it('types payment-keyword credits on cards as TRANSFER_IN', () => {
    for (const desc of ['PAYMENT THANK YOU', 'AUTOPAY RECEIVED', 'ONLINE E-PAY', 'Payment to Citibank']) {
      expect(mapTransactionWithSource(desc, 1982.19, [], 'CREDIT_CARD').type).toBe('TRANSFER_IN');
    }
  });

  it('does NOT apply payment keywords on cash accounts (rent payment is an expense)', () => {
    expect(mapTransactionWithSource('RENT PAYMENT', -1200, [], 'CASH').type).toBe('WITHDRAWAL');
    expect(mapTransactionWithSource('REFUND PAYMENT', 25, [], 'CASH').type).toBe('DEPOSIT');
  });

  it('negative credit-card amounts stay WITHDRAWAL', () => {
    expect(mapTransactionWithSource('SP THERMALTAKE', -69.85, [], 'CREDIT_CARD').type).toBe('WITHDRAWAL');
  });

  it('rules beat card defaults', () => {
    const rules = [{ pattern: 'cashback', matchType: 'contains' as const, activityType: 'CREDIT' as const }];
    expect(mapTransactionWithSource('CASHBACK BONUS', 12, rules, 'CREDIT_CARD'))
      .toEqual({ type: 'CREDIT', fromRule: true });
  });
});
