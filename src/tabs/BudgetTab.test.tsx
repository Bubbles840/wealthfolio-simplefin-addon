import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SyncPage } from '../pages/SyncPage';
import { CUBE } from '../../shared/report-cube.test';

/**
 * Integration-level through SyncPage, like every other tab's suite: the page
 * owns the store and the tab list, and what could regress is the whole path
 * from a stored cube to rendered cards.
 *
 * recharts and the host chart kit are HOST-PROVIDED at runtime and heavyweight
 * under jsdom (ResizeObserver etc.), so both are stubbed to passthrough
 * elements — these tests assert which reports render and with what data
 * handed along, never chart pixels.
 */
vi.mock('recharts', () => {
  // Explicit exports, not a Proxy: vitest wraps factories in a static module
  // object, so dynamic gets cannot satisfy ReportView's named imports.
  const stub = (name: string) => (p: any) =>
    React.createElement(
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
vi.mock('../utils/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sync')>();
  return {
    INTERVAL_SKIP_MESSAGE: actual.INTERVAL_SKIP_MESSAGE,
    runSync: vi.fn(async () => ({ imported: 0, skipped: 0, errors: [] })),
    applyBalanceAdjustment: vi.fn(async () => {}),
    applyBaselineCorrection: vi.fn(async () => {}),
  };
});

const makeProps = () => ({
  ctx: {
    api: {
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-a', name: 'Checking' }]) },
      navigation: { navigate: vi.fn(async () => {}) },
    },
  } as any,
  store: {
    getLastSyncAt: vi.fn(async () => new Date('2026-08-01T10:00:00Z')),
    getIgnoredAccounts: vi.fn(async () => [] as string[]),
    setIgnoredAccounts: vi.fn(async () => {}),
    getAccountMapping: vi.fn(async () => ({ 'sfin-1': 'wf-a' })),
    getMappingRules: vi.fn(async () => []),
    getSyncScheduleHours: vi.fn(async () => 6),
    getAccessUrl: vi.fn(async () => 'https://u:p@bridge.simplefin.org/simplefin'),
    getAccountNames: vi.fn(async () => ({ 'sfin-1': 'Checking' })),
    setAccountNames: vi.fn(),
    getAccountBalances: vi.fn(async () => ({})),
    getAuthB64Key: vi.fn(async () => 'simplefin_auth_b64'),
    setLastSyncAt: vi.fn(),
    setSyncScheduleHours: vi.fn(),
    getAutoHeal: vi.fn(async () => false),
    setAutoHeal: vi.fn(),
    getAutoAdjust: vi.fn(async () => false),
    setAutoAdjust: vi.fn(),
    getTelegramConfig: vi.fn(async () => null),
    setTelegramConfig: vi.fn(),
    getAvailableReportCategories: vi.fn(async () => [] as string[]),
    getReportCategoryCatalog: vi.fn(async () => [] as any[]),
    getLastSyncImported: vi.fn(async () => null),
    setLastSyncImported: vi.fn(async () => {}),
    getAmazonConfig: vi.fn(async () => null),
    setAmazonConfig: vi.fn(async () => {}),
    getAmazonLabels: vi.fn(async () => ({})),
    getAmazonMailStatus: vi.fn(async () => null as any),
    getReportGlyphStyle: vi.fn(async () => ({ mode: 'clean' as const, overrides: {} })),
    setReportGlyphStyle: vi.fn(async () => {}),
    getCountOffBudget: vi.fn(async () => true),
    setCountOffBudget: vi.fn(async () => {}),
    getSubcategoryDisplay: vi.fn(async () => 'rollup' as const),
    setSubcategoryDisplay: vi.fn(async () => {}),
    getCompanionVersion: vi.fn(async () => null),
    getOpenCards: vi.fn(async () => ({}) as Record<string, boolean>),
    setOpenCards: vi.fn(async () => {}),
    getUiState: vi.fn(async () => ({}) as any),
    setUiState: vi.fn(async () => {}),
    getUncategorizedStatus: vi.fn(async () => null as any),
    getDismissals: vi.fn(async () => ({}) as any),
    setDismissals: vi.fn(async () => {}),
    getPoolStatus: vi.fn(async () => null as any),
    getSemesterPool: vi.fn(async () => null as any),
    setSemesterPool: vi.fn(async () => {}),
    getReportCube: vi.fn(async () => null as any),
    getCustomReports: vi.fn(async () => [] as any[]),
    setCustomReports: vi.fn(async () => {}),
    getBudgetLayout: vi.fn(async () => null as any),
    setBudgetLayout: vi.fn(async () => {}),
  } as any,
  onReset: vi.fn(),
  scheduler: { start: vi.fn(), stop: vi.fn(), isRunning: vi.fn(() => false) } as any,
});

const reportIds = () =>
  Array.from(document.querySelectorAll('[data-report-id]')).map((n) => n.getAttribute('data-report-id'));

describe('BudgetTab', () => {
  it('is the first tab and the default landing view', async () => {
    render(<SyncPage {...makeProps()} />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs[0]).toHaveAccessibleName(/budget/i);
    await waitFor(() => expect(tabs[0]).toHaveAttribute('aria-selected', 'true'));
  });

  it('renders one companion banner and no charts without a cube', async () => {
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => expect(screen.getByText(/reports need the companion/i)).toBeInTheDocument());
    expect(reportIds()).toEqual([]);
  });

  it('renders heroes then grid from the cube, pool absent without a pool', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => ({ ...CUBE, asOf: new Date().toISOString() }));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    const ids = reportIds();
    // No pool in the CUBE fixture: cash flow + category trends lead.
    expect(ids.slice(0, 2)).toEqual(['cash-flow', 'category-trends']);
    expect(ids).not.toContain('pool-burndown');
    expect(ids).toContain('net-worth');
    expect(ids).toContain('merchants');
  });

  it('warns about a stale cube but still renders the reports', async () => {
    const props = makeProps();
    const staleAsOf = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    (props.store as any).getReportCube = vi.fn(async () => ({ ...CUBE, asOf: staleAsOf }));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    expect(screen.getByText(/as of/i)).toBeInTheDocument();
  });
});

describe('drill-in and range', () => {
  const freshCube = () => ({ ...CUBE, asOf: new Date().toISOString() });

  /** N copies of the CUBE's July column, so range slicing is observable. */
  const manyMonths = (n: number) => ({
    ...freshCube(),
    months: Array.from({ length: n }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`),
    spend: Array.from({ length: n }, () => CUBE.spend[0]),
    uncategorized: Array.from({ length: n }, () => CUBE.uncategorized[0]),
    income: Array.from({ length: n }, () => CUBE.income[0]),
    budgets: Array.from({ length: n }, () => CUBE.budgets[0]),
    merchants: Array.from({ length: n }, () => [] as any[]),
    feesInterest: Array.from({ length: n }, () => 0),
    netWorth: Array.from({ length: n }, () => null),
    liquid: Array.from({ length: n }, () => null),
  });

  it('opens a report full-screen from its card and comes back', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => freshCube());
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /open net worth/i }));
    expect(document.querySelector('[data-full-report="net-worth"]')).toBeTruthy();
    // The grid steps aside while a report is full-screen.
    expect(screen.queryByRole('button', { name: /open cash flow/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /back to all reports/i }));
    await waitFor(() => expect(document.querySelector('[data-full-report]')).toBeNull());
    expect(screen.getByRole('button', { name: /open cash flow/i })).toBeInTheDocument();
  });

  it('narrows the full-screen chart with the shared range control', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => manyMonths(8));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /open cash flow/i }));
    const chartData = () => JSON.parse(
      document.querySelector('[data-full-report] [data-recharts="BarChart"]')!
        .getAttribute('data-points') ?? '[]',
    );
    // Default range is 12 months — the whole 8-month cube.
    await waitFor(() => expect(chartData()).toHaveLength(8));

    fireEvent.click(screen.getByRole('button', { name: /^6 months$/i }));
    await waitFor(() => expect(chartData()).toHaveLength(6));

    fireEvent.click(screen.getByRole('button', { name: /^all$/i }));
    await waitFor(() => expect(chartData()).toHaveLength(8));
  });
});

describe('customize mode', () => {
  const freshProps = () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => ({ ...CUBE, asOf: new Date().toISOString() }));
    return props;
  };
  const enterCustomize = async () => {
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /^customize$/i }));
  };

  it('toggles per-card controls, and cards stop opening while editing', async () => {
    render(<SyncPage {...freshProps()} />);
    await enterCustomize();
    expect(screen.getByRole('button', { name: /pin cash flow/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /move net worth down/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hide merchants/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open cash flow/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /done customizing/i }));
    expect(screen.queryByRole('button', { name: /pin cash flow/i })).toBeNull();
    expect(screen.getByRole('button', { name: /open cash flow/i })).toBeInTheDocument();
  });

  it('pinning a third hero bumps the oldest to the grid front and persists', async () => {
    const props = freshProps();
    render(<SyncPage {...props} />);
    await enterCustomize();
    fireEvent.click(screen.getByRole('button', { name: /pin net worth/i }));
    await waitFor(() => {
      const ids = reportIds();
      expect(ids.slice(0, 2)).toEqual(['category-trends', 'net-worth']);
      expect(ids[2]).toBe('cash-flow'); // the bumped hero lands up front, visible
    });
    const saved = (props.store as any).setBudgetLayout.mock.calls.at(-1)![0];
    expect(saved.heroes).toEqual(['category-trends', 'net-worth']);
    expect(saved.order[0]).toBe('cash-flow');
  });

  it('move down swaps a card with its neighbor', async () => {
    const props = freshProps();
    render(<SyncPage {...props} />);
    await enterCustomize();
    // Grid starts net-worth, savings-rate (after the two heroes).
    fireEvent.click(screen.getByRole('button', { name: /move net worth down/i }));
    await waitFor(() => expect(reportIds()[2]).toBe('savings-rate'));
    expect((props.store as any).setBudgetLayout).toHaveBeenCalled();
  });

  it('hide collects the card in a recoverable hidden row', async () => {
    const props = freshProps();
    render(<SyncPage {...props} />);
    await enterCustomize();
    fireEvent.click(screen.getByRole('button', { name: /hide merchants/i }));
    await waitFor(() => expect(reportIds()).not.toContain('merchants'));
    expect(screen.getByText(/^hidden$/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /unhide merchants/i }));
    await waitFor(() => expect(reportIds()).toContain('merchants'));
    const saved = (props.store as any).setBudgetLayout.mock.calls.at(-1)![0];
    expect(saved.hidden).toEqual([]);
  });
});
