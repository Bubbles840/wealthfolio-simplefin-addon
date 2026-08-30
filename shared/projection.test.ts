import { describe, it, expect } from 'vitest';
import {
  monthEndForecast,
  previousThreeFullMonths,
  daysInMonthOf,
} from './projection.js';

describe('monthEndForecast', () => {
  it('forecasts from historical daily average and ignores current month spending', () => {
    // Wealthfolio intentionally forecasts from the 3-month run-rate, not this month's velocity;
    // matching the app's budget screen requires spentSoFar to have zero impact when history exists.
    const baseline = monthEndForecast({
      historicalOutflow: 2700, historyDays: 92, spentSoFar: 0, dayOfMonth: 15, daysInMonth: 31,
    });
    const withSpending = monthEndForecast({
      historicalOutflow: 2700, historyDays: 92, spentSoFar: 1500, dayOfMonth: 15, daysInMonth: 31,
    });
    expect(baseline).toBeCloseTo(909.78, 2);
    expect(withSpending).toBe(baseline);
  });

  it('falls back to current month run-rate when no history exists', () => {
    // Fresh accounts or first-time installs have no prior months to average, so extrapolating
    // current spending is the only way to give the user an early estimate.
    expect(monthEndForecast({
      historicalOutflow: 0, historyDays: 90, spentSoFar: 300, dayOfMonth: 10, daysInMonth: 30,
    })).toBe(900);
  });

  it('guards against division by zero when dayOfMonth is zero or negative', () => {
    // Clock skew or edge-of-midnight timezone shifts might pass dayOfMonth <= 0;
    // clamping to 1 prevents NaN or Infinity from propagating into the report.
    expect(monthEndForecast({
      historicalOutflow: 0, historyDays: 0, spentSoFar: 50, dayOfMonth: 0, daysInMonth: 30,
    })).toBe(1500);
    expect(monthEndForecast({
      historicalOutflow: 0, historyDays: 0, spentSoFar: 50, dayOfMonth: -5, daysInMonth: 30,
    })).toBe(1500);
  });

  it('returns zero when there is no historical outflow and no current spend', () => {
    // An untouched account or brand new month with zero spend should project $0
    // rather than an empty or undefined result.
    expect(monthEndForecast({
      historicalOutflow: 0, historyDays: 0, spentSoFar: 0, dayOfMonth: 1, daysInMonth: 31,
    })).toBe(0);
  });

  it('falls through to the current month fallback if historyDays is zero', () => {
    // Malformed database ranges with 0 days must not divide by zero; falling through
    // to current month pacing keeps the daily summary robust.
    expect(monthEndForecast({
      historicalOutflow: 1000, historyDays: 0, spentSoFar: 200, dayOfMonth: 10, daysInMonth: 30,
    })).toBe(600);
    expect(monthEndForecast({
      historicalOutflow: 1000, historyDays: 0, spentSoFar: 0, dayOfMonth: 10, daysInMonth: 30,
    })).toBe(0);
  });
});

describe('previousThreeFullMonths', () => {
  it.each([
    { now: new Date(2026, 7, 25), startInclusive: '2026-05-01', endExclusive: '2026-08-01', days: 92, scenario: 'standard mid-year span (May-Jul: 31+30+31)' },
    { now: new Date(2026, 1, 10), startInclusive: '2025-11-01', endExclusive: '2026-02-01', days: 92, scenario: 'year boundary wrap backwards (Nov-Jan: 30+31+31)' },
    { now: new Date(2026, 2, 15), startInclusive: '2025-12-01', endExclusive: '2026-03-01', days: 90, scenario: 'non-leap February window (Dec-Feb: 31+31+28)' },
    { now: new Date(2024, 4, 1), startInclusive: '2024-02-01', endExclusive: '2024-05-01', days: 90, scenario: 'leap-year February window (Feb-Apr 2024: 29+31+30)' },
    { now: new Date(2026, 0, 1), startInclusive: '2025-10-01', endExclusive: '2026-01-01', days: 92, scenario: 'first day of year wrapping across Q4 (Oct-Dec: 31+30+31)' },
  ])('calculates the 3-month window for $scenario', ({ now, startInclusive, endExclusive, days }) => {
    // SQLite reader queries require exact half-open [startInclusive, endExclusive) date ranges;
    // off-by-one errors across year wraps or variable-length months distort historical averages.
    expect(previousThreeFullMonths(now)).toEqual({ startInclusive, endExclusive, days });
  });

  it('accurately counts calendar days across a Daylight Saving Time transition', () => {
    // Spring DST shifts local clocks by 1 hour, making ms differences slightly non-integer in days;
    // Math.round ensures calendar day counts match the true UTC date diff instead of truncating.
    const result = previousThreeFullMonths(new Date(2026, 5, 15)); // history spans Mar–May
    const expectedDaysUtc = (Date.UTC(2026, 5, 1) - Date.UTC(2026, 2, 1)) / 86_400_000;
    expect(result.startInclusive).toBe('2026-03-01');
    expect(result.endExclusive).toBe('2026-06-01');
    expect(result.days).toBe(92);
    expect(result.days).toBe(expectedDaysUtc);
  });
});

describe('daysInMonthOf', () => {
  it.each([
    { date: new Date(2026, 1, 1), expected: 28, desc: 'non-leap February' },
    { date: new Date(2024, 1, 1), expected: 29, desc: 'leap February' },
    { date: new Date(2026, 7, 5), expected: 31, desc: '31-day month' },
    { date: new Date(2026, 3, 30), expected: 30, desc: '30-day month' },
  ])('returns $expected days for $desc', ({ date, expected }) => {
    // Forecast extrapolation multiplies the daily run-rate by the full month length;
    // an inaccurate month length (especially February) biases the month-end total.
    expect(daysInMonthOf(date)).toBe(expected);
  });
});
