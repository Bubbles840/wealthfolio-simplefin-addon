/**
 * src/components/budget/report-data.ts
 *
 * Pure chart-data preparation for the ten standard reports: cube in,
 * recharts-ready rows out, dollars out (charts and tables render dollars;
 * cents live inside the cube). No React, no chart imports — this is the layer
 * the tests pin, so the chart components stay thin enough to trust.
 *
 * Gap discipline, everywhere: a null in the cube stays a null here (recharts
 * renders it as a gap with connectNulls off), a month with no income has no
 * savings rate rather than a fake one, and the burn-down stops drawing
 * "actual" past the last day the companion has seen.
 */
import {
  categorySeries, monthlyIncomeTotals, monthlySpendTotals, type ReportCube,
} from '../../../shared/report-cube';
import { computeRunwayMonths } from '../../../shared/pool';

export interface MonthRow { month: string; [k: string]: number | string | null }

const dollars = (cents: number) => Math.round(cents) / 100;

export function cashFlowData(cube: ReportCube): MonthRow[] {
  const income = monthlyIncomeTotals(cube);
  const spending = monthlySpendTotals(cube);
  return cube.months.map((month, mi) => ({
    month,
    income: dollars(income[mi]),
    spending: dollars(spending[mi]),
    net: dollars(income[mi] - spending[mi]),
  }));
}

export function categoryTrendData(cube: ReportCube, categories: string[]): MonthRow[] {
  const series = categories
    .map((c) => ({ name: c, values: categorySeries(cube, c) }))
    .filter((s): s is { name: string; values: number[] } => s.values !== null);
  return cube.months.map((month, mi) => {
    const row: MonthRow = { month };
    for (const s of series) row[s.name] = dollars(s.values[mi]);
    return row;
  });
}

export function netWorthData(cube: ReportCube): MonthRow[] {
  return cube.months.map((month, mi) => ({
    month,
    netWorth: cube.netWorth[mi] === null ? null : dollars(cube.netWorth[mi]!),
  }));
}

export function savingsRateData(cube: ReportCube): MonthRow[] {
  const income = monthlyIncomeTotals(cube);
  const spending = monthlySpendTotals(cube);
  return cube.months.map((month, mi) => ({
    month,
    rate: income[mi] > 0
      ? Math.round(((income[mi] - spending[mi]) / income[mi]) * 1000) / 1000
      : null,
  }));
}

/**
 * Merchants aggregated over the last `monthCount` months, largest first.
 * `trend` compares the window's monthly average against the SAME merchant's
 * average over the three months before the window — null when that history
 * does not exist, because "no trend" and "flat trend" are different facts.
 */
export function merchantTable(
  cube: ReportCube,
  monthCount: number,
): Array<{ name: string; total: number; count: number; trend: number | null }> {
  const start = Math.max(0, cube.months.length - monthCount);
  const windowMonths = cube.months.length - start;
  const priorStart = Math.max(0, start - 3);
  const priorMonths = start - priorStart;

  const sum = (from: number, to: number) => {
    const totals = new Map<string, { cents: number; count: number }>();
    for (let mi = from; mi < to; mi += 1) {
      for (const m of cube.merchants[mi]) {
        const entry = totals.get(m.name) ?? { cents: 0, count: 0 };
        entry.cents += m.cents;
        entry.count += m.count;
        totals.set(m.name, entry);
      }
    }
    return totals;
  };

  const current = sum(start, cube.months.length);
  const prior = priorMonths >= 3 ? sum(priorStart, start) : null;

  return Array.from(current.entries())
    .map(([name, { cents, count }]) => {
      let trend: number | null = null;
      if (prior) {
        const before = prior.get(name);
        if (before && before.cents > 0) {
          const nowAvg = cents / windowMonths;
          const beforeAvg = before.cents / 3;
          trend = Math.round(((nowAvg - beforeAvg) / beforeAvg) * 100) / 100;
        }
      }
      return { name, total: dollars(cents), count, trend };
    })
    .sort((a, b) => b.total - a.total);
}

/** One month's categories, budget vs actual, worst overshoot first — the
 *  categories most over their line are what the report exists to surface. */
export function budgetVsActualData(
  cube: ReportCube,
  month: string,
): Array<{ category: string; budget: number; actual: number }> {
  const mi = cube.months.indexOf(month);
  if (mi === -1) return [];
  return cube.categories
    .map((category, ci) => {
      const budget = cube.budgets[mi][ci];
      const actual = cube.spend[mi][ci].reduce((s, v) => s + v, 0);
      return { category, budget, actual };
    })
    .filter((r) => r.budget !== 0 || r.actual !== 0)
    .sort((a, b) => (b.actual - b.budget) - (a.actual - a.budget))
    .map((r) => ({ category: r.category, budget: dollars(r.budget), actual: dollars(r.actual) }));
}

/** Category × month spend in CENTS — the heatmap scales colors itself and
 *  wants the raw magnitudes, not display strings. */
export function seasonalityGrid(cube: ReportCube): { categories: string[]; months: string[]; cells: number[][] } {
  return {
    categories: [...cube.categories],
    months: [...cube.months],
    cells: cube.categories.map((_, ci) =>
      cube.months.map((_, mi) => cube.spend[mi][ci].reduce((s, v) => s + v, 0))),
  };
}

export function feesInterestData(cube: ReportCube): MonthRow[] {
  return cube.months.map((month, mi) => ({ month, fees: dollars(cube.feesInterest[mi]) }));
}

/** Liquid position over the trailing (up to three months) average monthly
 *  spend — the weekly report's runway figure, charted. Null liquid months
 *  stay null. */
export function runwayTrendData(cube: ReportCube): MonthRow[] {
  const spending = monthlySpendTotals(cube);
  return cube.months.map((month, mi) => {
    const liquid = cube.liquid[mi];
    if (liquid === null) return { month, months: null };
    const from = Math.max(0, mi - 2);
    const window = spending.slice(from, mi + 1);
    const avg = Math.round(window.reduce((s, v) => s + v, 0) / window.length);
    return { month, months: computeRunwayMonths(liquid, avg) };
  });
}

/**
 * The pool as a picture: the ideal straight glide from the full amount on the
 * start date to zero on the end date, against the actual remainder from the
 * cube's cumulative daily burn. `actual` is null past the last day the
 * companion has data for — the line stops rather than promising a flat
 * tomorrow.
 */
export function poolBurndownData(
  cube: ReportCube,
): Array<{ date: string; ideal: number; actual: number | null }> {
  if (!cube.pool) return [];
  const { config, daily } = cube.pool;
  const DAY = 24 * 60 * 60 * 1000;
  const startMs = Date.parse(`${config.startDate}T00:00:00Z`);
  const endMs = Date.parse(`${config.endDate}T00:00:00Z`);
  if (!(endMs >= startMs)) return [];
  const days = Math.round((endMs - startMs) / DAY) + 1;
  const lastKnown = daily.length > 0 ? daily[daily.length - 1].date : config.startDate;
  const out: Array<{ date: string; ideal: number; actual: number | null }> = [];
  for (let i = 0; i < days; i += 1) {
    const date = new Date(startMs + i * DAY).toISOString().slice(0, 10);
    const ideal = dollars(days === 1 ? 0 : config.amountCents * (1 - i / (days - 1)));
    let actual: number | null = null;
    if (date <= lastKnown) {
      let spent = 0;
      for (const d of daily) {
        if (d.date <= date) spent = d.spentCents;
        else break;
      }
      actual = dollars(config.amountCents - spent);
    }
    out.push({ date, ideal, actual });
  }
  return out;
}
