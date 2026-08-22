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

  it('types bank transfer descriptions on cash accounts as TRANSFER_OUT / TRANSFER_IN', () => {
    expect(mapTransactionWithSource('PNC BANK, NATIONAL ASSOCIATION', -1300, [], 'CASH'))
      .toEqual({ type: 'TRANSFER_OUT', fromRule: false });
    expect(mapTransactionWithSource('ONLINE TRANSFER FROM CHECKING', 500, [], 'CASH'))
      .toEqual({ type: 'TRANSFER_IN', fromRule: false });
  });

  it('rules beat card defaults', () => {
    const rules = [{ pattern: 'cashback', matchType: 'contains' as const, activityType: 'CREDIT' as const }];
    expect(mapTransactionWithSource('CASHBACK BONUS', 12, rules, 'CREDIT_CARD'))
      .toEqual({ type: 'CREDIT', fromRule: true });
  });
});

describe('card payments leaving a cash account', () => {
  // Found live: payments to a Discover card and to "Ccb" (Coastal Community
  // Bank, the Robinhood card's issuer) imported as WITHDRAWAL and were counted
  // as $228 of spending. A card payment is a transfer between the user's own
  // accounts; typing it as one is also what lets the pair form and the leg show
  // as in-transit.
  const cases: Array<[string, number]> = [
    ['Payment to Ccb Credit Card Payments', -140.98],
    ['Payment to Discover Bank Credit Card Payments', -87.26],
    ['Payment to Citibank Credit Card Payments', -94.93],
    ['CREDIT CARD PAYMENT', -50],
    ['Card Payment - Thank You', -25],
  ];
  for (const [description, amount] of cases) {
    it(`types "${description}" as a transfer out`, () => {
      expect(mapTransaction(description, amount, [])).toBe('TRANSFER_OUT');
    });
  }

  /**
   * The ambiguity the card-side keywords were always kept away from cash for.
   * A bare "payment" describes rent, utilities and insurance, and typing those
   * as transfers would erase real spending from every report — a far worse
   * failure than missing a card payment, which a mapping rule can fix.
   */
  const stillSpending: Array<[string, number]> = [
    ['RENT PAYMENT', -1550],
    ['Utility payment - KY Power', -140],
    ['INSURANCE PAYMENT AUTOPAY', -88],
    ['AUTOPAY ELECTRIC COMPANY', -75],
    ['Payment to Landlord', -1200],
    ['DOORDASH*PAYMENT', -32],
  ];
  for (const [description, amount] of stillSpending) {
    it(`leaves "${description}" as spending`, () => {
      expect(mapTransaction(description, amount, [])).toBe('WITHDRAWAL');
    });
  }

  it('does not touch money coming IN that mentions a card payment', () => {
    // A positive amount on a cash account is not the paying side of anything.
    expect(mapTransaction('Credit card payment reversal', 94.93, [])).toBe('DEPOSIT');
  });

  it('still lets a user rule win', () => {
    // The escape hatch for every phrasing this list will never contain.
    expect(mapTransaction('Payment to Ccb Credit Card Payments', -140.98, [
      { pattern: 'Ccb', matchType: 'contains', activityType: 'WITHDRAWAL' },
    ])).toBe('WITHDRAWAL');
  });
});

describe('mapTransactionWithSource subtype', () => {
  it('rule match includes subtype when the rule specifies one (contains)', () => {
    const rules: MappingRule[] = [
      { pattern: 'venmo', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' },
    ];
    expect(mapTransactionWithSource('VENMO PAYMENT FROM JOE', 25, rules)).toEqual({
      type: 'CREDIT',
      fromRule: true,
      subtype: 'REIMBURSEMENT',
    });
  });

  it('rule match includes subtype when the rule specifies one (regex)', () => {
    const rules: MappingRule[] = [
      { pattern: '^VENMO', matchType: 'regex', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' },
    ];
    expect(mapTransactionWithSource('VENMO PAYMENT', 25, rules)).toEqual({
      type: 'CREDIT',
      fromRule: true,
      subtype: 'REIMBURSEMENT',
    });
  });

  it('rule match without a subtype omits the key entirely (not subtype: undefined)', () => {
    const rules: MappingRule[] = [
      { pattern: 'dividend', matchType: 'contains', activityType: 'DIVIDEND' },
    ];
    const result = mapTransactionWithSource('AAPL DIVIDEND', 5, rules);
    expect('subtype' in result).toBe(false);
  });

  it('skips invalid regex rule even when it carries a subtype', () => {
    const rules: MappingRule[] = [
      { pattern: '[invalid', matchType: 'regex', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' },
    ];
    const result = mapTransactionWithSource('test', 1, rules);
    expect(result).toEqual({ type: 'DEPOSIT', fromRule: false });
    expect('subtype' in result).toBe(false);
  });

  it('no-rule branches never include a subtype key', () => {
    expect('subtype' in mapTransactionWithSource('UNIQLO REFUND', 66.45, [], 'CREDIT_CARD')).toBe(false);
    expect('subtype' in mapTransactionWithSource('PAYMENT THANK YOU', 1982.19, [], 'CREDIT_CARD')).toBe(false);
    expect('subtype' in mapTransactionWithSource('PNC BANK, NATIONAL ASSOCIATION', -1300, [], 'CASH')).toBe(false);
    expect('subtype' in mapTransactionWithSource('Coffee', -4.5, [], 'CASH')).toBe(false);
  });

  it('returns bare ActivityType even when the matched rule carries a subtype', () => {
    const rules: MappingRule[] = [
      { pattern: 'venmo', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' },
    ];
    expect(mapTransaction('VENMO PAYMENT', 25, rules)).toBe('CREDIT');
  });
});
