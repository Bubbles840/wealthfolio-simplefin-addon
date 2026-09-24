import { describe, it, expect } from 'vitest';
import { normalizeAppPassword, ruleCatchesAmazonCharges } from './amazon-config.js';

describe('normalizeAppPassword', () => {
  // Google shows an app password as four groups of four letters. Pasted with
  // the spaces, IMAP login fails with nothing to say why (live, 2026-08-07).
  it('strips the spaces from a Google-format app password', () => {
    expect(normalizeAppPassword('abcd efgh ijkl mnop')).toBe('abcdefghijklmnop');
    expect(normalizeAppPassword('  abcd  efgh ijkl mnop ')).toBe('abcdefghijklmnop');
  });

  it('leaves any other password exactly as typed, spaces included', () => {
    expect(normalizeAppPassword('my pass phrase')).toBe('my pass phrase');
    expect(normalizeAppPassword('abcdefghijklmnop')).toBe('abcdefghijklmnop');
    expect(normalizeAppPassword('')).toBe('');
  });
});

describe('ruleCatchesAmazonCharges', () => {
  // A Wealthfolio rule that files every Amazon charge runs first, so the order
  // emails never get to label anything (live, 2026-08-07).
  it('flags a broad contains or starts-with rule on Amazon', () => {
    expect(ruleCatchesAmazonCharges({ pattern: 'Amazon', matchType: 'CONTAINS' })).toBe(true);
    expect(ruleCatchesAmazonCharges({ pattern: 'AMZN', matchType: 'contains' })).toBe(true);
    expect(ruleCatchesAmazonCharges({ pattern: 'AMAZON MKTPL', matchType: 'STARTS_WITH' })).toBe(true);
    expect(ruleCatchesAmazonCharges({ pattern: 'amazon', matchType: 'REGEX' })).toBe(true);
  });

  it('leaves narrow, unrelated or exact rules alone', () => {
    expect(ruleCatchesAmazonCharges({ pattern: 'Kindle Svcs', matchType: 'CONTAINS' })).toBe(false);
    expect(ruleCatchesAmazonCharges({ pattern: 'Kroger', matchType: 'CONTAINS' })).toBe(false);
    expect(ruleCatchesAmazonCharges({ pattern: 'Amazon', matchType: 'EXACT' })).toBe(false);
    expect(ruleCatchesAmazonCharges({ pattern: 'am', matchType: 'CONTAINS' })).toBe(false);
    expect(ruleCatchesAmazonCharges({ pattern: '(', matchType: 'REGEX' })).toBe(false);
  });
});
