import { describe, it, expect } from 'vitest';
import { normalizeAppPassword } from './amazon-config.js';

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
