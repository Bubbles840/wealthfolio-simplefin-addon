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
    // No pool in the CUBE fixture: cash flow leads the board; first-gap
    // packing may seat a small card beside it before the second big one.
    expect(ids[0]).toBe('cash-flow');
    expect(ids).not.toContain('pool-burndown');
    expect(ids).toContain('category-trends');
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

  it('pinning puts the card at the top-left of the board and persists', async () => {
    const props = freshProps();
    render(<SyncPage {...props} />);
    await enterCustomize();
    fireEvent.click(screen.getByRole('button', { name: /pin net worth/i }));
    await waitFor(() => expect(reportIds()[0]).toBe('net-worth'));
    const saved = (props.store as any).setBudgetLayout.mock.calls.at(-1)![0];
    expect(saved.pos['net-worth'].slice(0, 2)).toEqual([0, 0]);
  });

  it('move down swaps a card with the neighbor below it', async () => {
    const props = freshProps();
    render(<SyncPage {...props} />);
    await enterCustomize();
    const before = reportIds();
    const idx = before.indexOf('net-worth');
    fireEvent.click(screen.getByRole('button', { name: /move net worth down/i }));
    await waitFor(() => {
      expect(reportIds().indexOf('net-worth')).toBeGreaterThan(idx);
    });
    const saved = (props.store as any).setBudgetLayout.mock.calls.at(-1)![0];
    expect(saved.pos['net-worth'][1]).toBeGreaterThan(0);
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

describe('report builder wiring', () => {
  const freshProps = () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => ({ ...CUBE, asOf: new Date().toISOString() }));
    return props;
  };
  const FOOD = {
    id: 'cr-1', name: 'Food', chart: 'line', range: { kind: 'all' }, accounts: null,
    series: [{ label: 'Food', terms: [{ sign: 1, source: 'category', category: 'Dining' }] }],
  };

  it('opens from the New report card; a save joins the grid and persists', async () => {
    const props = freshProps();
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /new report/i }));
    fireEvent.change(screen.getByLabelText(/report name/i), { target: { value: 'Food' } });
    fireEvent.change(screen.getByLabelText(/series 1 label/i), { target: { value: 'Food' } });
    fireEvent.change(screen.getByLabelText(/add to series 1/i), { target: { value: 'category:Dining' } });
    fireEvent.click(screen.getByRole('button', { name: /save report/i }));

    await waitFor(() => expect(reportIds().some((id) => id?.startsWith('custom:cr-'))).toBe(true));
    const saved = (props.store as any).setCustomReports.mock.calls.at(-1)![0];
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('Food');
    expect(screen.queryByLabelText(/report name/i)).toBeNull(); // builder closed
  });

  it('edits an existing custom report in place', async () => {
    const props = freshProps();
    (props.store as any).getCustomReports = vi.fn(async () => [FOOD]);
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds()).toContain('custom:cr-1'));

    fireEvent.click(screen.getByRole('button', { name: /^customize$/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit food/i }));
    fireEvent.change(screen.getByLabelText(/report name/i), { target: { value: 'Meals' } });
    fireEvent.click(screen.getByRole('button', { name: /save report/i }));

    const saved = (props.store as any).setCustomReports.mock.calls.at(-1)![0];
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe('cr-1');
    expect(saved[0].name).toBe('Meals');
  });

  it('duplicates and deletes from customize mode', async () => {
    const props = freshProps();
    (props.store as any).getCustomReports = vi.fn(async () => [FOOD]);
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds()).toContain('custom:cr-1'));
    fireEvent.click(screen.getByRole('button', { name: /^customize$/i }));

    fireEvent.click(screen.getByRole('button', { name: /duplicate food/i }));
    let saved = (props.store as any).setCustomReports.mock.calls.at(-1)![0];
    expect(saved).toHaveLength(2);
    expect(saved[1].id).not.toBe('cr-1');
    expect(saved[1].name).toMatch(/food/i);

    fireEvent.click(screen.getAllByRole('button', { name: /delete food/i })[0]);
    saved = (props.store as any).setCustomReports.mock.calls.at(-1)![0];
    expect(saved.some((r: any) => r.id === 'cr-1')).toBe(false);
  });
});

describe('layout polish', () => {
  it('the page runs full-width on the Budget tab and narrow elsewhere', async () => {
    render(<SyncPage {...makeProps()} />);
    await screen.findAllByRole('tab');
    await waitFor(() => expect(document.querySelector('.sfin-page--wide')).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: /overview/i }));
    expect(document.querySelector('.sfin-page--wide')).toBeNull();
  });

  it('customize resizes a card through the shape cycle, persisted', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => ({ ...CUBE, asOf: new Date().toISOString() }));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /^customize$/i }));

    const cellOf = () => document.querySelector('[data-report-id="merchants"]')!.closest('.sfin-cell')!;
    expect(cellOf().className).toContain('sfin-cell--m');

    fireEvent.click(screen.getByRole('button', { name: /^resize merchants/i }));
    await waitFor(() => expect(cellOf().className).toContain('sfin-cell--w'));
    let saved = (props.store as any).setBudgetLayout.mock.calls.at(-1)![0];
    expect(saved.size).toEqual({ merchants: 'w' });

    fireEvent.click(screen.getByRole('button', { name: /^resize merchants/i }));
    await waitFor(() => expect(cellOf().className).toContain('sfin-cell--t'));
    saved = (props.store as any).setBudgetLayout.mock.calls.at(-1)![0];
    expect(saved.size).toEqual({ merchants: 't' });
  });
});

describe('second wave on the grid', () => {
  it('the new reports join the grid; pool-gated ones stay out without a pool', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => ({ ...CUBE, asOf: new Date().toISOString() }));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    const ids = reportIds();
    for (const id of ['category-donut', 'mom-delta', 'cumulative-flow', 'uncat-trend']) {
      expect(ids).toContain(id);
    }
    expect(ids).not.toContain('spend-calendar');
    expect(ids).not.toContain('pool-pace');
  });

  it('dragging the corner handle resizes to exact spans and persists', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => ({ ...CUBE, asOf: new Date().toISOString() }));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /^customize$/i }));

    const handle = screen.getByLabelText(/drag to resize merchants/i);
    // Pointer CAPTURE keeps move/up flowing to the handle itself. Fine units
    // since v1.35: fallback column unit 110px, row unit 43px — this drag is
    // "super thin and tall": 2 units left, 4 units down from the m default
    // of [4, 8].
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 400, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 180, clientY: 272 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 180, clientY: 272 });

    await waitFor(() => {
      const saved = (props.store as any).setBudgetLayout.mock.calls.at(-1)?.[0];
      expect(saved?.pos?.merchants?.slice(2)).toEqual([2, 12]);
    });
    const cell = document.querySelector('[data-report-id="merchants"]')!.closest('.sfin-cell') as HTMLElement;
    expect(cell.style.getPropertyValue('--sfin-c')).toBe('2');
    expect(cell.style.getPropertyValue('--sfin-r')).toBe('12');
  });

  it('dragging a card drops it at the exact cell under the cursor', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => ({ ...CUBE, asOf: new Date().toISOString() }));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /^customize$/i }));

    const cellOf = (id: string) =>
      document.querySelector(`[data-report-id="${id}"]`)!.closest('.sfin-cell') as HTMLElement;
    const before = reportIds();
    const dragged = before[4]!;
    // jsdom measures nothing, so the board geometry is stubbed on the grid:
    // 12 columns of (110 + 14gap) → unit 124px wide, 43px rows.
    const grid = document.querySelector('.sfin-budget-grid') as HTMLElement;
    grid.getBoundingClientRect = () => ({
      left: 0, top: 0, width: 1474, height: 4000, right: 1474, bottom: 4000, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const cell = cellOf(dragged);
    // Grab mid-board, drag to the very top-left cell.
    fireEvent.pointerDown(cell, { pointerId: 2, clientX: 600, clientY: 600 });
    fireEvent.pointerMove(cell, { pointerId: 2, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(cell, { pointerId: 2, clientX: 10, clientY: 10 });

    await waitFor(() => {
      const saved = (props.store as any).setBudgetLayout.mock.calls.at(-1)?.[0];
      expect(saved?.pos?.[dragged]?.slice(0, 2)).toEqual([0, 0]);
    });
    // The board renders it first — it landed exactly where it was dropped.
    expect(reportIds()[0]).toBe(dragged);
  });

  it('the dashboard carries the shared range chips', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => ({ ...CUBE, asOf: new Date().toISOString() }));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: /^12 months$/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^3 months$/i })).toBeInTheDocument();
  });
});

describe('layout reset, hide undo, pool editing', () => {
  const freshCube = () => ({ ...CUBE, asOf: new Date().toISOString() });
  const poolCube = () => ({
    ...freshCube(),
    pool: {
      config: { amountCents: 160_000, startDate: '2026-07-01', endDate: '2026-12-15' },
      daily: [{ date: '2026-07-02', spentCents: 1000 }],
    },
  });

  it('reset asks for a second tap, then clears the stored layout', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => freshCube());
    (props.store as any).getBudgetLayout = vi.fn(async () => ({ heroes: ['net-worth'], order: ['net-worth'], hidden: [] }));
    (props.store as any).clearBudgetLayout = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    expect(reportIds()[0]).toBe('net-worth');

    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    fireEvent.click(screen.getByRole('button', { name: /reset layout/i }));
    // Nothing cleared yet: one mistap must not destroy an arranged board.
    expect((props.store as any).clearBudgetLayout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /really reset/i }));
    expect((props.store as any).clearBudgetLayout).toHaveBeenCalled();
    // Back to the default order immediately, not on next load.
    await waitFor(() => expect(reportIds()[0]).toBe('cash-flow'));
  });

  it('offers no reset when nothing was ever customized', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => freshCube());
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    expect(screen.queryByRole('button', { name: /reset layout/i })).toBeNull();
  });

  it('hiding a card offers an Undo that restores it', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => freshCube());
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide Net worth' }));
    expect(reportIds()).not.toContain('net-worth');
    expect(screen.getByText(/hidden net worth/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(reportIds()).toContain('net-worth');
    // The toast leaves with the undo.
    expect(screen.queryByText(/hidden net worth/i)).toBeNull();
  });

  it('edits the pool from the full-screen burn-down without Telegram', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => poolCube());
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: /open pool burn-down/i }));
    fireEvent.click(screen.getByRole('button', { name: /edit pool/i }));

    const amount = screen.getByLabelText('Pool amount') as HTMLInputElement;
    expect(amount.value).toBe('1600');
    fireEvent.change(amount, { target: { value: '2000' } });
    // The start date is editable too — a pool that actually began with the
    // semester should not be stuck at whenever /pool was first typed.
    const start = screen.getByLabelText('Pool start date') as HTMLInputElement;
    expect(start.value).toBe('2026-07-01');
    fireEvent.change(start, { target: { value: '2026-08-15' } });
    fireEvent.click(screen.getByRole('button', { name: /save pool/i }));

    expect((props.store as any).setSemesterPool).toHaveBeenCalledWith({
      amountCents: 200_000, startDate: '2026-08-15', endDate: '2026-12-15',
    });
    expect(screen.getByText(/next sync/i)).toBeInTheDocument();
  });
});

describe('subscription dismissals end to end', () => {
  it('dismissing on the card persists the name and drops the row', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => ({
      ...CUBE,
      asOf: new Date().toISOString(),
      subscriptions: [
        { name: 'SPOTIFY', monthlyCents: 1099, count: 5, lastDate: '2026-08-20', lastCents: 1099, creep: false },
        { name: 'QR LIBRARY', monthlyCents: 999, count: 4, lastDate: '2026-08-22', lastCents: 999, creep: false },
      ],
    }));
    (props.store as any).getHiddenSubscriptions = vi.fn(async () => []);
    (props.store as any).setHiddenSubscriptions = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss QR LIBRARY' }));
    expect((props.store as any).setHiddenSubscriptions).toHaveBeenCalledWith(['QR LIBRARY']);
    await waitFor(() => expect(screen.queryByText('QR LIBRARY')).toBeNull());
    expect(screen.getByText('SPOTIFY')).toBeInTheDocument();
  });
});

describe('drag ghost (v1.36)', () => {
  it('a picked-up card rides the cursor as a ghost and leaves a slot behind', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => ({ ...CUBE, asOf: new Date().toISOString() }));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /^customize$/i }));

    const id = reportIds()[3]!;
    const cell = document.querySelector(`[data-report-id="${id}"]`)!.closest('.sfin-cell') as HTMLElement;
    fireEvent.pointerDown(cell, { pointerId: 1, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(cell, { pointerId: 1, clientX: 340, clientY: 420 });

    // The ghost is the card itself, floating; the grid cell becomes the
    // dashed slot that shows where the drop will land.
    const ghost = document.querySelector('.sfin-drag-ghost') as HTMLElement;
    expect(ghost).toBeTruthy();
    expect(ghost.querySelector(`[data-report-id="${id}"]`)).toBeTruthy();
    expect(cell.className).toContain('sfin-cell--dragging');

    fireEvent.pointerUp(cell, { pointerId: 1, clientX: 340, clientY: 420 });
    expect(document.querySelector('.sfin-drag-ghost')).toBeNull();
  });
});

describe('subscription confirmation end to end', () => {
  it('answering Yes persists the name and moves it into the roster', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => ({
      ...CUBE,
      asOf: new Date().toISOString(),
      subscriptions: [
        { name: 'RENT LLC', monthlyCents: 90000, count: 6, lastDate: '2026-08-25', lastCents: 90000, creep: false, kind: 'bill' },
      ],
    }));
    (props.store as any).getHiddenSubscriptions = vi.fn(async () => []);
    (props.store as any).setHiddenSubscriptions = vi.fn(async () => {});
    (props.store as any).getConfirmedSubscriptions = vi.fn(async () => []);
    (props.store as any).setConfirmedSubscriptions = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));

    expect(screen.getByText(/is this a subscription\?/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, RENT LLC is a subscription' }));
    expect((props.store as any).setConfirmedSubscriptions).toHaveBeenCalledWith(['RENT LLC']);
    await waitFor(() => expect(screen.queryByText(/is this a subscription\?/i)).toBeNull());
    expect(screen.getByText(/\$900\.00\/mo across 1/)).toBeInTheDocument();
  });
});

describe('per-card ranges, headline picks, palettes (v1.43)', () => {
  const manyMonthsCube = (n: number) => ({
    ...CUBE,
    asOf: new Date().toISOString(),
    months: Array.from({ length: n }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`),
    spend: Array.from({ length: n }, () => CUBE.spend[0]),
    uncategorized: Array.from({ length: n }, () => CUBE.uncategorized[0]),
    income: Array.from({ length: n }, () => CUBE.income[0]),
    budgets: Array.from({ length: n }, () => CUBE.budgets[0]),
    merchants: Array.from({ length: n }, () => [] as any[]),
    feesInterest: Array.from({ length: n }, () => 0),
    netWorth: Array.from({ length: n }, () => null),
    liquid: Array.from({ length: n }, () => null),
  });

  it('a pinned card keeps its own window while the chips drive the rest', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => manyMonthsCube(14));
    (props.store as any).getBudgetLayout = vi.fn(async () => ({
      heroes: [], order: [], hidden: [], ranges: { 'cash-flow': 3 },
    }));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    const chart = document.querySelector('[data-report-id="cash-flow"] [data-points]')!;
    expect(JSON.parse(chart.getAttribute('data-points')!)).toHaveLength(3);
    const unpinned = document.querySelector('[data-report-id="cumulative-flow"] [data-points]')!;
    expect(JSON.parse(unpinned.getAttribute('data-points')!)).toHaveLength(12);
  });

  it('the range button cycles and persists a pin', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => manyMonthsCube(14));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /^customize$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Range for Merchants' }));
    const saved = (props.store as any).setBudgetLayout.mock.calls.at(-1)![0];
    expect(saved.ranges?.merchants).toBe(1);
  });

  it('headline picks persist from the full-screen editor', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => ({ ...CUBE, asOf: new Date().toISOString() }));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /open headline numbers/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Show Net worth' }));
    const saved = (props.store as any).setBudgetLayout.mock.calls.at(-1)![0];
    expect(saved.headline).toEqual(['spent-month', 'cash-runway', 'savings-rate', 'net-worth']);
  });

  it('a global palette paints the grid; a per-card palette overrides its cell', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => ({ ...CUBE, asOf: new Date().toISOString() }));
    (props.store as any).getBudgetLayout = vi.fn(async () => ({
      heroes: [], order: [], hidden: [], palette: 'ocean', palettes: { merchants: 'sunset' },
    }));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    const grid = document.querySelector('.sfin-budget-grid') as HTMLElement;
    expect(grid.style.getPropertyValue('--sfin-s0')).not.toBe('');
    const cell = document.querySelector('[data-report-id="merchants"]')!.closest('.sfin-cell') as HTMLElement;
    expect(cell.style.getPropertyValue('--sfin-s0')).not.toBe('');
    expect(cell.style.getPropertyValue('--sfin-s0')).not.toBe(grid.style.getPropertyValue('--sfin-s0'));
  });

  it('the customize toolbar offers the palette swatches', async () => {
    const props = makeProps();
    (props.store as any).getReportCube = vi.fn(async () => ({ ...CUBE, asOf: new Date().toISOString() }));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /^customize$/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Palette Ocean' }));
    const saved = (props.store as any).setBudgetLayout.mock.calls.at(-1)![0];
    expect(saved.palette).toBe('ocean');
  });
});
