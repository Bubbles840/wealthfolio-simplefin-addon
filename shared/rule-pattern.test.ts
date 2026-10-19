import { describe, it, expect } from 'vitest';
import { categoryRulePattern, paybackRulePattern, stripLeadingReference } from './rule-pattern.js';

describe('categoryRulePattern', () => {
  it('drops trailing reference tokens so the rule survives the next charge', () => {
    expect(categoryRulePattern('ACH WITHDRAWAL 0821 REF 99182')).toBe('ACH WITHDRAWAL');
    expect(categoryRulePattern('NETFLIX.COM 866-579-7172')).toBe('NETFLIX.COM');
  });

  it('always returns a verbatim substring of the description', () => {
    // Wealthfolio's rules are a `contains` match against the RAW description;
    // a normalizer that strips punctuation ("Amazon.com" -> "Amazon com")
    // builds a rule that never matches anything.
    for (const desc of ['Amazon.com*2W4TJ9', 'SQ *COFFEE  SHOP #42', 'Payment to Ccb Credit Card Payments']) {
      expect(desc).toContain(categoryRulePattern(desc));
    }
  });

  it('keeps a punctuated merchant name whole', () => {
    // A single-token descriptor is all merchant: stripping it would leave
    // nothing, so it stays as-is even with digits embedded.
    expect(categoryRulePattern('Amazon.com*2W4TJ9K')).toBe('Amazon.com*2W4TJ9K');
    expect(categoryRulePattern('SQ *COFFEE SHOP #42')).toBe('SQ *COFFEE SHOP');
  });

  it('caps the pattern at six tokens so one long descriptor stays matchable', () => {
    expect(categoryRulePattern('ONE TWO THREE FOUR FIVE SIX SEVEN EIGHT')).toBe('ONE TWO THREE FOUR FIVE SIX');
  });

  it('falls back to the whole description when stripping would leave nothing', () => {
    expect(categoryRulePattern('99182')).toBe('99182');
    expect(categoryRulePattern('')).toBe('');
  });
});

describe('mixed alphanumeric reference codes', () => {
  it('drops short uppercase code tokens that carry digits', () => {
    // "CLAUDE.AI *SUB 8ZK1" / "... 41XP": the per-charge reference is letters
    // AND digits, so the no-letters rule kept it and every charge looked like
    // a different merchant.
    expect(categoryRulePattern('CLAUDE.AI *SUB 8ZK1')).toBe('CLAUDE.AI *SUB');
    expect(categoryRulePattern('CLAUDE.AI *SUB 41XP')).toBe('CLAUDE.AI *SUB');
  });

  it('keeps ordinary words and digit-free tokens', () => {
    expect(categoryRulePattern('Payment to Ccb Credit Card Payments')).toBe('Payment to Ccb Credit Card Payments');
    expect(categoryRulePattern('SHELL OIL 5744')).toBe('SHELL OIL');
  });
});

describe('leading reference tokens (R5)', () => {
  it('strips a *NNNN reference, so two months of one bill share a pattern', () => {
    // PNC since 2026-09-22: a fresh reference first, the payee after it.
    expect(categoryRulePattern('*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT')).toBe('PAYMENT LOUISVILLE GAS & ACH');
    expect(categoryRulePattern('*9999 PAYMENT LOUISVILLE GAS & ACH DEBIT')).toBe('PAYMENT LOUISVILLE GAS & ACH');
  });

  it('strips a run of 3+ digits and a 6+ character code with 3+ digits', () => {
    expect(stripLeadingReference('4090 E-PAYMENT DISCOVER ACH WEB')).toBe('E-PAYMENT DISCOVER ACH WEB');
    expect(stripLeadingReference('RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT')).toBe('TRANSFER CAPITAL ONE ACH WEB PAYMENT');
    expect(stripLeadingReference('3447db1440b44a1 BILTRENT BILT PAYMENT ACH WEB')).toBe('BILTRENT BILT PAYMENT ACH WEB');
    expect(stripLeadingReference('XX9257 NETFLIX')).toBe('NETFLIX');
    expect(stripLeadingReference('*0082 #4471 PAYMENT CITI AUTOPAY')).toBe('PAYMENT CITI AUTOPAY');
  });

  it('keeps merchant names that merely start with a digit', () => {
    for (const desc of ['7-ELEVEN 35221', '1PASSWORD', '76 FUEL LOUISVILLE KY', 'SQ *COFFEE SHOP #42']) {
      expect(stripLeadingReference(desc)).toBe(desc);
    }
    expect(categoryRulePattern('7-ELEVEN 35221')).toBe('7-ELEVEN');
    expect(categoryRulePattern('76 FUEL LOUISVILLE KY')).toBe('76 FUEL LOUISVILLE KY');
  });

  it('never strips the last token that has a letter', () => {
    expect(stripLeadingReference('XX9257')).toBe('XX9257');
    expect(stripLeadingReference('*0082 4471')).toBe('*0082 4471');
    expect(stripLeadingReference('XX9257 4471')).toBe('XX9257 4471');
  });

  it('returns a verbatim suffix of the text', () => {
    for (const desc of ['*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR', '4090  E-PAYMENT DISCOVER', 'NETFLIX.COM']) {
      expect(desc.endsWith(stripLeadingReference(desc))).toBe(true);
    }
  });

  it('counts the reference inside the six-token cap, so a key stored before this change normalizes to the new key (R6)', () => {
    // The old pattern of this bill was "*8712 PAYMENT LOUISVILLE GAS & ACH" (six
    // tokens, reference included). Normalizing that stored key must land on
    // exactly the key the same charge gets today.
    expect(categoryRulePattern('*8712 PAYMENT LOUISVILLE GAS & ACH')).toBe(categoryRulePattern('*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT'));
    expect(categoryRulePattern('RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT')).toBe('TRANSFER CAPITAL ONE ACH WEB');
  });

  it('is idempotent, and the cap never ends the pattern on a junk token', () => {
    expect(categoryRulePattern('ONE TWO THREE FOUR FIVE 1234 SEVEN')).toBe('ONE TWO THREE FOUR FIVE');
    for (const desc of [
      '*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT', 'ONE TWO THREE FOUR FIVE 1234 SEVEN', 'CLAUDE.AI *SUB 8ZK1',
      'GOOGLE *G1AI101M MOUNTAIN VIEW CA', '99182', 'XX9257', '',
    ]) {
      expect(categoryRulePattern(categoryRulePattern(desc))).toBe(categoryRulePattern(desc));
    }
  });

  it('leaves descriptors with no leading reference exactly as before', () => {
    expect(categoryRulePattern('GOOGLE *Google One MOUNTAIN VIEW CA')).toBe('GOOGLE *Google One MOUNTAIN VIEW CA');
    expect(categoryRulePattern('PAYMENT ROBINHOOD CCB ACH DEBIT')).toBe('PAYMENT ROBINHOOD CCB ACH DEBIT');
  });

  it('paybackRulePattern strips every R5 reference, not only *NNNN', () => {
    expect(paybackRulePattern('4090 ZELLE FROM JANE DOE ON 10/09 REF # PNCAA0B1C2D3')).toBe('ZELLE FROM JANE DOE');
    expect(paybackRulePattern('*1234 CASHOUT VENMO ACH CREDIT')).toBe('CASHOUT VENMO ACH CREDIT');
  });
});
