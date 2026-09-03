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
  categorySeries, monthlyIncomeTotals, monthlySpendTotals, monthlyUncategorizedTotals, type ReportCube,
} from '../../../shared/report-cube';
import { computePoolStatus, computeRunwayMonths } from '../../../shared/pool';

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
  // PERCENT, one decimal — the chart's axis and the headline chip must speak
  // the same unit (the chart once plotted raw fractions next to a chip saying
  // "20%", live 2026-09-02).
  return cube.months.map((month, mi) => ({
    month,
    rate: income[mi] > 0
      ? Math.round(((income[mi] - spending[mi]) / income[mi]) * 1000) / 10
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

/** The last month's spend per category, largest slice first — top eight, the
 *  rest folded into 'Other' so the donut stays readable. */
export function categoryDonutData(cube: ReportCube): Array<{ name: string; value: number }> {
  const mi = cube.months.length - 1;
  if (mi < 0) return [];
  const rows = cube.categories
    .map((name, ci) => ({ name, cents: cube.spend[mi][ci].reduce((s, v) => s + v, 0) }))
    .filter((r) => r.cents > 0)
    .sort((a, b) => b.cents - a.cents);
  const top = rows.slice(0, 8);
  const rest = rows.slice(8).reduce((s, r) => s + r.cents, 0);
  const out = top.map((r) => ({ name: r.name, value: dollars(r.cents) }));
  if (rest > 0) out.push({ name: 'Other', value: dollars(rest) });
  return out;
}

/** This month vs last, per category — the "what changed" chart. Increases
 *  first: the jumps are what the reader came to find. */
export function momDeltaData(cube: ReportCube): Array<{ category: string; delta: number }> {
  const mi = cube.months.length - 1;
  if (mi < 1) return [];
  return cube.categories
    .map((category, ci) => ({
      category,
      delta: dollars(
        cube.spend[mi][ci].reduce((s, v) => s + v, 0)
        - cube.spend[mi - 1][ci].reduce((s, v) => s + v, 0),
      ),
    }))
    .filter((r) => r.delta !== 0)
    .sort((a, b) => b.delta - a.delta);
}

/** Per-day spend inside the pool window, un-cumulated from the pool's daily
 *  series. Empty without a pool — the calendar is a pool-window lens. */
export function spendCalendarData(cube: ReportCube): Array<{ date: string; cents: number }> {
  if (!cube.pool) return [];
  let prev = 0;
  return cube.pool.daily.map((d) => {
    const cents = d.spentCents - prev;
    prev = d.spentCents;
    return { date: d.date, cents };
  });
}

/** The pool's two paces and a verdict, for the gauge card. Null without a
 *  pool. Green under the sustainable pace, amber within 15% over, red past
 *  that — the gauge answers one question at a glance. */
export function poolPaceData(
  cube: ReportCube,
): { sustainableWeekly: number; actualWeekly: number; status: 'green' | 'amber' | 'red' } | null {
  if (!cube.pool) return null;
  const spent = cube.pool.daily.at(-1)?.spentCents ?? 0;
  const status = computePoolStatus(cube.pool.config, spent, new Date(cube.asOf));
  const verdict = status.actualWeeklyCents <= status.sustainableWeeklyCents ? 'green'
    : status.actualWeeklyCents <= status.sustainableWeeklyCents * 1.15 ? 'amber' : 'red';
  return {
    sustainableWeekly: dollars(status.sustainableWeeklyCents),
    actualWeekly: dollars(status.actualWeeklyCents),
    status: verdict,
  };
}

/** Running totals: income against spending across the window — the loan
 *  draining against the burn, viscerally. */
export function cumulativeFlowData(cube: ReportCube): MonthRow[] {
  const income = monthlyIncomeTotals(cube);
  const spending = monthlySpendTotals(cube);
  let inc = 0;
  let sp = 0;
  return cube.months.map((month, mi) => {
    inc += income[mi];
    sp += spending[mi];
    return { month, income: dollars(inc), spending: dollars(sp) };
  });
}

/** Uncategorized spending per month — is the filing habit winning? */
export function uncatTrendData(cube: ReportCube): MonthRow[] {
  const totals = monthlyUncategorizedTotals(cube);
  return cube.months.map((month, mi) => ({ month, uncategorized: dollars(totals[mi]) }));
}

/** One dollar of slack: both pipelines round per group before summing, so a
 *  few cents of float drift is arithmetic, not a data problem. */
const CHECK_TOLERANCE_CENTS = 100;

export interface DataCheckRow {
  label: string;
  cubeCents: number;
  ledgerCents: number;
  deltaCents: number;
}

/**
 * The data-check card's verdict: the cube's current-month totals against the
 * digest readers' (see CubeCheck). Null when the companion never published a
 * check — "could not verify" renders as its own state, never as a pass.
 */
export function dataCheckResult(
  cube: ReportCube,
): { month: string; status: 'match' | 'diverges'; rows: DataCheckRow[] } | null {
  const check = cube.check ?? null;
  if (!check) return null;
  const rows: DataCheckRow[] = [
    {
      label: 'Categorized spending',
      cubeCents: check.cubeSpendCents,
      ledgerCents: check.ledgerSpendCents,
      deltaCents: check.ledgerSpendCents - check.cubeSpendCents,
    },
    {
      label: 'Uncategorized spending',
      cubeCents: check.cubeUncatCents,
      ledgerCents: check.ledgerUncatCents,
      deltaCents: check.ledgerUncatCents - check.cubeUncatCents,
    },
  ];
  const status = rows.every((r) => Math.abs(r.deltaCents) <= CHECK_TOLERANCE_CENTS)
    ? 'match' as const
    : 'diverges' as const;
  return { month: check.month, status, rows };
}

/**
 * Subscriptions roster + monthly total. Null means the companion could not
 * look (no dated merchant rows yet); an EMPTY roster is a real answer and
 * renders as "none detected", not as an error.
 */
export function subscriptionSummary(
  cube: ReportCube,
): { totalCents: number; subs: NonNullable<ReportCube['subscriptions']> } | null {
  const subs = cube.subscriptions ?? null;
  if (!subs) return null;
  return { totalCents: subs.reduce((s, x) => s + x.monthlyCents, 0), subs };
}
