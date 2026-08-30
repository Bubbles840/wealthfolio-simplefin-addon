import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
vi.mock('recharts', () => new Proxy({}, {
  get: (_t, name) => {
    if (name === 'default') return undefined;
    return (p: any) => React.createElement('div', { 'data-recharts': String(name) }, p?.children ?? null);
  },
}));
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
