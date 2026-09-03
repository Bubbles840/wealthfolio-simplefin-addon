import { describe, it, expect } from 'vitest';
import { categoryRulePattern } from './rule-pattern.js';

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
