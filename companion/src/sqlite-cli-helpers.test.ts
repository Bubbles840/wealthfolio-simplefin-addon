import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CLI_SEPARATOR, isDay, isTrue, NOTES, shiftDay, tail } from './sqlite-cli-helpers.js';
import { DRILL_CLI_SEPARATOR } from './sqlite-native.js';

describe('sqlite-cli-helpers — the one place the reads share their small pieces (1.62)', () => {
  it('keeps the unit separator, the free text last, and the SQLite boolean', () => {
    expect(DRILL_CLI_SEPARATOR).toBe(CLI_SEPARATOR);
    expect(tail(['a', 'b', 'c', 'd'], 2)).toBe(`c${CLI_SEPARATOR}d`);
    expect([1, '1', 'true', 'TRUE'].map(isTrue)).toEqual([true, true, true, true]);
    expect([0, '0', 'false', '', null].map(isTrue)).toEqual([false, false, false, false, false]);
  });

  it('validates a day and shifts it across a month and a year', () => {
    expect(isDay('2026-10-01')).toBe(true);
    expect(isDay("2026-10-01' OR 1=1 --")).toBe(false);
    expect(shiftDay('2026-10-01', -1)).toBe('2026-09-30');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('makes a note one line', () => {
    expect(NOTES).toContain('char(13)');
    expect(NOTES).toContain('char(10)');
  });

  it('is imported, never copied, by the two files that read the database', () => {
    for (const file of ["sqlite-native.ts", "sqlite-audit.ts", "sqlite-guess.ts"]) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source, file).toContain("from './sqlite-cli-helpers.js'");
      expect(source, file).not.toMatch(/char\(13\)/);
      expect(source, file).not.toMatch(/const (tail|isTrue|isDay|shiftDay|NOTES|spendTail|spendTrue|isSpendDay|SPEND_NOTES)\b/);
    }
  });
});
