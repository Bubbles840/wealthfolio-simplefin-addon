import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ReportView } from './ReportView';
import { CUBE } from '../../../shared/report-cube.test';
import type { ReportCube } from '../../../shared/report-cube';
import type { CustomReport } from '../../../shared/report-eval';

/**
 * Component-level: charts are host-provided recharts, mocked here to
 * passthrough divs that SERIALIZE their `data` prop — so every assertion is
 * about the numbers handed to the chart (already pinned in report-data.test)
 * reaching the right chart, plus the real DOM the non-chart reports render.
 */
vi.mock('recharts', () => {
  // Vitest wraps mock factories in a static module object, so a Proxy with
  // dynamic gets cannot satisfy named imports — every component ReportView
  // imports must be an explicit export here.
  const stub = (name: string) => (p: any) => React.createElement(
    'div',
    { 'data-recharts': name, 'data-points': p?.data ? JSON.stringify(p.data) : undefined },
    p?.children ?? null,
  );
  return {
    Area: stub('Area'), AreaChart: stub('AreaChart'), Bar: stub('Bar'), BarChart: stub('BarChart'),
    CartesianGrid: stub('CartesianGrid'), Cell: stub('Cell'), Line: stub('Line'),
    LineChart: stub('LineChart'), Pie: stub('Pie'), PieChart: stub('PieChart'),
    XAxis: stub('XAxis'), YAxis: stub('YAxis'),
  };
});
vi.mock('@wealthfolio/ui/chart', () => ({
  ChartContainer: (p: any) => React.createElement('div', null, p.children),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
  ChartLegend: () => null,
  ChartLegendContent: () => null,
  ChartStyle: () => null,
}));

const fresh = (): ReportCube => ({ ...CUBE, asOf: new Date().toISOString() });
const points = (chart: string) =>
  JSON.parse(document.querySelector(`[data-recharts="${chart}"][data-points]`)?.getAttribute('data-points') ?? 'null');

const view = (id: string, cube: ReportCube = fresh(), customReports: CustomReport[] = []) =>
  render(<ReportView id={id} cube={cube} customReports={customReports} />);

describe('ReportView', () => {
  it('cash-flow: paired bars fed income/spending/net rows', () => {
    view('cash-flow');
    const data = points('BarChart') ?? points('ComposedChart');
    expect(data).toEqual([
      { month: '2026-07', income: 500, spending: 61, net: 439 },
      { month: '2026-08', income: 0, spending: 47, net: -47 },
    ]);
  });

  it('category-trends: every cube category rides the chart by default', () => {
    view('category-trends');
    const data = points('BarChart') ?? points('LineChart');
    expect(data[0].Dining).toBe(30);
    expect(data[0].Groceries).toBe(30);
  });

  it('net-worth: line data with the null gap preserved', () => {
    view('net-worth');
    expect(points('LineChart')).toEqual([
      { month: '2026-07', netWorth: 9000 },
      { month: '2026-08', netWorth: null },
    ]);
  });

  it('net-worth: an all-null series explains it is accruing instead of charting nothing', () => {
    const cube = { ...fresh(), netWorth: [null, null] };
    view('net-worth', cube);
    expect(screen.getByText(/accru/i)).toBeInTheDocument();
    expect(document.querySelector('[data-recharts="LineChart"]')).toBeNull();
  });

  it('savings-rate: rate rows with income-less months as gaps', () => {
    view('savings-rate');
    expect(points('LineChart')).toEqual([
      { month: '2026-07', rate: 0.878 },
      { month: '2026-08', rate: null },
    ]);
  });

  it('merchants: a real table with name, total, and count', () => {
    view('merchants');
    expect(screen.getByText('CHIPOTLE')).toBeInTheDocument();
    expect(screen.getByText('$15')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('merchants: the grid card previews the top six; the open view lists all', () => {
    const many = {
      ...fresh(),
      merchants: [
        [],
        Array.from({ length: 10 }, (_, i) => ({ name: `MERCHANT ${i}`, cents: (10 - i) * 1000, count: 1 })),
      ],
    };
    const { unmount } = render(<ReportView id="merchants" cube={many} customReports={[]} />);
    expect(screen.getAllByText(/^MERCHANT/)).toHaveLength(6);
    expect(screen.getByText(/\+ ?4 more/i)).toBeInTheDocument();
    unmount();
    render(<ReportView id="merchants" cube={many} customReports={[]} hero />);
    expect(screen.getAllByText(/^MERCHANT/)).toHaveLength(10);
  });

  it('budget-vs-actual: category rows, worst overshoot first', () => {
    view('budget-vs-actual');
    const rows = screen.getAllByText(/Groceries|Dining/).map((n) => n.textContent);
    expect(rows[0]).toContain('Groceries');
  });

  it('seasonality: a heatmap cell per category-month with the spend in its title', () => {
    view('seasonality');
    const cells = document.querySelectorAll('[data-heat]');
    expect(cells).toHaveLength(4); // 2 categories × 2 months
    expect(Array.from(cells).some((c) => (c.getAttribute('title') ?? '').includes('$30'))).toBe(true);
  });

  it('fees-interest: an all-zero history says so instead of charting nothing', () => {
    const cube = { ...fresh(), feesInterest: [0, 0] };
    view('fees-interest', cube);
    expect(screen.getByText(/nothing — as it should be/i)).toBeInTheDocument();
  });

  it('fees-interest: charts bars when fees exist', () => {
    view('fees-interest');
    expect(points('BarChart')).toEqual([
      { month: '2026-07', fees: 0 },
      { month: '2026-08', fees: 2.5 },
    ]);
  });

  it('pool-burndown: ideal and actual series from the pool window', () => {
    const cube: ReportCube = {
      ...fresh(),
      pool: {
        config: { amountCents: 160_000, startDate: '2026-08-25', endDate: '2026-08-29' },
        daily: [{ date: '2026-08-26', spentCents: 1000 }],
      },
    };
    view('pool-burndown', cube);
    const data = points('LineChart') ?? points('AreaChart') ?? points('ComposedChart');
    expect(data[0]).toEqual({ date: '2026-08-25', ideal: 1600, actual: 1600 });
    expect(data[1].actual).toBe(1590);
  });

  it('custom report: evaluates its definition and renders the chosen chart', () => {
    const custom: CustomReport = {
      id: 'cr-1', name: 'Food', chart: 'table', range: { kind: 'all' }, accounts: null,
      series: [{ label: 'Food', terms: [
        { sign: 1, source: 'category', category: 'Dining' },
        { sign: 1, source: 'category', category: 'Groceries' },
      ] }],
    };
    view('custom:cr-1', fresh(), [custom]);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('$60')).toBeInTheDocument(); // Jul: 30 + 30
  });

  it('custom report: an unknown category wears a warning chip, never crashes', () => {
    const custom: CustomReport = {
      id: 'cr-2', name: 'Ghosts', chart: 'line', range: { kind: 'all' }, accounts: null,
      series: [{ label: 'X', terms: [{ sign: 1, source: 'category', category: 'Ghost' }] }],
    };
    view('custom:cr-2', fresh(), [custom]);
    expect(screen.getByText(/unknown category: Ghost/i)).toBeInTheDocument();
  });
});
