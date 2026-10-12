import { describe, it, expect } from 'vitest';
import {
  addDaysIso, addMonthsClamped, addPeriod, addYearsClamped, daysBetween, isManualKey, localIsoDay, manualKey,
  rollForward,
} from './subscription-roster.js';

describe('addMonthsClamped', () => {
  it.each([
    ['2026-01-15', 1, '2026-02-15'],
    ['2026-01-31', 1, '2026-02-28'],
    ['2028-01-31', 1, '2028-02-29'],
    ['2026-03-31', 1, '2026-04-30'],
    ['2026-12-31', 1, '2027-01-31'],
    ['2026-01-31', 2, '2026-03-31'],
    ['2026-03-15', -3, '2025-12-15'],
    ['2026-03-31', -1, '2026-02-28'],
  ] as const)('%s plus %i months is %s', (iso, n, want) => {
    expect(addMonthsClamped(iso, n)).toBe(want);
  });
});

describe('addYearsClamped', () => {
  it.each([
    ['2028-02-29', 1, '2029-02-28'],
    ['2028-02-29', 4, '2032-02-29'],
    ['2026-10-20', -1, '2025-10-20'],
  ] as const)('%s plus %i years is %s', (iso, n, want) => {
    expect(addYearsClamped(iso, n)).toBe(want);
  });
});

describe('addDaysIso / daysBetween / addPeriod', () => {
  it('adds days across month and year ends', () => {
    expect(addDaysIso('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('counts whole days either way, unaffected by daylight saving', () => {
    expect(daysBetween('2026-10-03', '2026-10-12')).toBe(9);
    expect(daysBetween('2026-10-12', '2026-10-03')).toBe(-9);
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-10-12', '2026-10-12')).toBe(0);
  });

  it('steps by the cadence', () => {
    expect(addPeriod('2026-10-08', 'monthly')).toBe('2026-11-08');
    expect(addPeriod('2026-10-08', 'yearly')).toBe('2027-10-08');
    expect(addPeriod('2026-10-08', 'monthly', -1)).toBe('2026-09-08');
  });
});

describe('rollForward', () => {
  it('keeps a date that is today or later', () => {
    expect(rollForward('2026-10-12', 'monthly', '2026-10-12')).toBe('2026-10-12');
    expect(rollForward('2026-12-01', 'yearly', '2026-10-12')).toBe('2026-12-01');
  });

  it('rolls a past date by months or by years', () => {
    expect(rollForward('2026-10-03', 'monthly', '2026-10-12')).toBe('2026-11-03');
    expect(rollForward('2025-03-03', 'yearly', '2026-10-12')).toBe('2027-03-03');
  });

  it('counts from the anchor, so a 31st comes back after a short month', () => {
    expect(rollForward('2026-01-31', 'monthly', '2026-03-05')).toBe('2026-03-31');
  });

  it('lands a Feb 29 anchor on Feb 28 in a year without one', () => {
    expect(rollForward('2024-02-29', 'yearly', '2026-10-12')).toBe('2027-02-28');
  });

  it('returns to Feb 29 in the next leap year', () => {
    expect(rollForward('2024-02-29', 'yearly', '2028-01-01')).toBe('2028-02-29');
  });
});

describe('localIsoDay / manual keys', () => {
  it('reads the local calendar day', () => {
    expect(localIsoDay(new Date(2026, 9, 12, 23, 59))).toBe('2026-10-12');
    expect(localIsoDay(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05');
  });

  it('keys a hand-added entry as m:<id>', () => {
    expect(manualKey('ab12cd34')).toBe('m:ab12cd34');
    expect(isManualKey('m:ab12cd34')).toBe(true);
    expect(isManualKey('SPOTIFY')).toBe(false);
  });
});
