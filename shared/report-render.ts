/**
 * shared/report-render.ts
 *
 * Cube → SVG for one report: the dispatch both mobile surfaces share. The
 * mini app inlines these into its page; the Telegram /reports fallback
 * rasterizes them to PNG. Only the glanceable subset is rendered here — the
 * interactive builder-and-drill-down experience stays in the Budget tab.
 */
import {
  budgetVsActualAvgData, cashFlowData, categoryDonutData, netWorthData,
  poolBurndownData, savingsRateData, categoryTrendData,
} from './report-data.js';
import type { ReportCube } from './report-cube.js';
import { svgBarChart, svgDonut, svgLineChart } from './svg-charts.js';

/** The sage register, as the Budget tab draws it. */
const C = ['#5e9483', '#3e6f63', '#c9a86b', '#c17a63', '#7189a8', '#8aa864', '#9a7aa0', '#6b7f8f'];

export const RENDERABLE_REPORT_IDS = [
  'pool-burndown', 'cash-flow', 'net-worth', 'savings-rate',
  'category-donut', 'budget-vs-actual', 'category-trends',
] as const;

const TITLES: Record<string, string> = {
  'pool-burndown': 'Pool burn-down',
  'cash-flow': 'Cash flow',
  'net-worth': 'Net worth',
  'savings-rate': 'Savings rate',
  'category-donut': 'Where it went',
  'budget-vs-actual': 'Budget vs actual (monthly avg)',
  'category-trends': 'Category trends',
};

export function reportImageTitle(id: string): string {
  return TITLES[id] ?? id;
}

export function renderReportSvg(
  cube: ReportCube,
  id: string,
  size: { width: number; height: number },
): string | null {
  const { width, height } = size;
  switch (id) {
    case 'pool-burndown': {
      const rows = poolBurndownData(cube);
      if (rows.length === 0) return null;
      return svgLineChart({
        width, height,
        labels: rows.map((r) => String(r.date).slice(5)),
        series: [
          { name: 'ideal', color: C[2], dashed: true, values: rows.map((r) => (typeof r.ideal === 'number' ? r.ideal : null)) },
          { name: 'actual', color: C[0], values: rows.map((r) => (typeof r.actual === 'number' ? r.actual : null)) },
        ],
      });
    }
    case 'cash-flow': {
      const rows = cashFlowData(cube);
      return svgBarChart({
        width, height,
        labels: rows.map((r) => String(r.month).slice(2)),
        series: [
          { name: 'income', color: C[0], values: rows.map((r) => Number(r.income)) },
          { name: 'spending', color: C[3], values: rows.map((r) => Number(r.spending)) },
        ],
      });
    }
    case 'net-worth': {
      const rows = netWorthData(cube);
      return svgLineChart({
        width, height,
        labels: rows.map((r) => String(r.month).slice(2)),
        series: [{ name: 'net worth', color: C[0], values: rows.map((r) => (typeof r.netWorth === 'number' ? r.netWorth : null)) }],
      });
    }
    case 'savings-rate': {
      const rows = savingsRateData(cube);
      return svgLineChart({
        width, height,
        labels: rows.map((r) => String(r.month).slice(2)),
        series: [{ name: 'rate %', color: C[4], values: rows.map((r) => (typeof r.rate === 'number' ? r.rate : null)) }],
      });
    }
    case 'category-donut': {
      const slices = categoryDonutData(cube);
      if (slices.length === 0) return null;
      return svgDonut({
        width, height,
        slices: slices.slice(0, 8).map((s, i) => ({ name: s.name, value: s.value, color: C[i % C.length] })),
      });
    }
    case 'budget-vs-actual': {
      const rows = budgetVsActualAvgData(cube).slice(0, 8);
      if (rows.length === 0) return null;
      return svgBarChart({
        width, height,
        labels: rows.map((r) => r.category.slice(0, 9)),
        series: [
          { name: 'budget', color: C[7], values: rows.map((r) => r.budget) },
          { name: 'actual', color: C[0], values: rows.map((r) => r.actual) },
        ],
      });
    }
    case 'category-trends': {
      const top = categoryDonutData(cube).slice(0, 5).map((s) => s.name);
      const source = top.length > 0 ? top : cube.categories.slice(0, 5);
      const rows = categoryTrendData(cube, source);
      return svgLineChart({
        width, height,
        labels: rows.map((r) => String(r.month).slice(2)),
        series: source.map((name, i) => ({
          name, color: C[i % C.length],
          values: rows.map((r) => (typeof r[name] === 'number' ? (r[name] as number) : null)),
        })),
      });
    }
    default:
      return null;
  }
}
