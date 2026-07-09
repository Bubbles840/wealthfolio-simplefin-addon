import { describe, it, expect } from 'vitest';
import { mapTransaction } from './mapper';
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

  it('throws on invalid regex pattern', () => {
    const rules: MappingRule[] = [
      { pattern: '[invalid', matchType: 'regex', activityType: 'INTEREST' },
    ];
    expect(() => mapTransaction('test', 1, rules)).toThrow();
  });
});
