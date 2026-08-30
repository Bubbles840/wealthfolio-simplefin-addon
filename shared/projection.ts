/**
 * shared/projection.ts
 *
 * Wealthfolio's own month-end forecast, transcribed so the daily report can
 * say the same number the app's budget page says.
 *
 * Source: apps/frontend/src/features/spending/components/reports/hero-strip.tsx
 * and spending-tab-content.tsx (`historicalDailyAvg`), read 2026-08-25:
 *
 *   dailyAvg = outflow over the previous THREE FULL calendar months
 *            ÷ the calendar days those months span
 *   forecast = dailyAvg × days in this month
 *   fallback (no history at all): spent ÷ day-of-month × days in this month
 *
 * Note what it does NOT do: when history exists, this month's spending plays
 * no part. "On pace for $3,120" means "at your recent average", not "at this
 * month's rate". Kept that way deliberately — the whole value of the line is
 * agreeing with the app, and a smarter number the app disagrees with would be
 * one more thing to reconcile.
 *
 * Pure, and separate from where the outflow comes from: the companion feeds
 * it the same spending total it feeds every other report, so the forecast is
 * built from the numbers already reconciled with the app.
 */

export interface MonthEndForecastInput {
  /** Total outflow across the previous three full calendar months. */
  historicalOutflow: number;
  /** Calendar days those three months span (89–92). */
  historyDays: number;
  /** This month's spend to date — used only when there is no history. */
  spentSoFar: number;
  /** 1-based day of the month, today. */
  dayOfMonth: number;
  daysInMonth: number;
}

export function monthEndForecast(input: MonthEndForecastInput): number {
  const { historicalOutflow, historyDays, spentSoFar, dayOfMonth, daysInMonth } = input;
  if (historicalOutflow > 0 && historyDays > 0) {
    return (historicalOutflow / historyDays) * daysInMonth;
  }
  if (spentSoFar > 0) {
    return (spentSoFar / Math.max(1, dayOfMonth)) * daysInMonth;
  }
  return 0;
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The history window: the three full calendar months before the one `now`
 * falls in, as the half-open date range the sqlite readers take, plus its
 * length in days.
 *
 * Local calendar arithmetic, like every other date in the reports — the
 * `Date(y, m - 3, 1)` form rolls the year back on its own for January through
 * March. The day count is rounded rather than truncated because a DST change
 * inside the window makes the span 23 or 25 hours off a whole number of days.
 */
export function previousThreeFullMonths(now: Date): {
  startInclusive: string;
  endExclusive: string;
  days: number;
} {
  const start = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  const endExclusive = new Date(now.getFullYear(), now.getMonth(), 1);
  const days = Math.round((endExclusive.getTime() - start.getTime()) / 86_400_000);
  return { startInclusive: ymd(start), endExclusive: ymd(endExclusive), days };
}

/** Days in the month `now` falls in. */
export function daysInMonthOf(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
}
