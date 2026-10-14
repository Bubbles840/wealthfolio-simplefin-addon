import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BudgetPreview, BudgetTab, SAMPLE_BANNER } from './BudgetTab';
import { emptySubscriptionPrefs } from '../../shared/subscription-prefs';

/**
 * The sample-data preview (project 4, G2): the Budget board over the built-in
 * sample cube, read-only, under a banner. Rendered directly with spies for
 * every write the board can make, so "writes nothing" is checked against the
 * real handlers' absence, not inferred from a missing button.
 *
 * recharts and the host chart kit are stubbed to passthrough elements, as in
 * BudgetTab.test.tsx.
 */
vi.mock('recharts', () => {
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

const EMOJI = /\p{Extended_Pictographic}/u;
const NOW = new Date(2026, 9, 14, 12, 0);

function emptyTab() {
  const spies = {
    onLayoutChange: vi.fn(),
    onLayoutReset: vi.fn(),
    onCustomReportsChange: vi.fn(),
    onSubscriptionEdit: vi.fn(),
    onOpenActivities: vi.fn(),
    setSemesterPool: vi.fn(async () => {}),
    setBudgetLayout: vi.fn(async () => {}),
    setCustomReports: vi.fn(async () => {}),
  };
  const store = { setSemesterPool: spies.setSemesterPool, setBudgetLayout: spies.setBudgetLayout, setCustomReports: spies.setCustomReports } as any;
  render(
    <BudgetTab
      cube={null}
      customReports={[]}
      layout={null}
      onLayoutChange={spies.onLayoutChange}
      onLayoutReset={spies.onLayoutReset}
      onCustomReportsChange={spies.onCustomReportsChange}
      store={store}
      subscriptionPrefs={{ prefs: emptySubscriptionPrefs(), unreadable: false }}
      onSubscriptionEdit={spies.onSubscriptionEdit}
      onOpenActivities={spies.onOpenActivities}
      onSetUpCompanion={vi.fn()}
    />,
  );
  return spies;
}
const reportIds = () =>
  Array.from(document.querySelectorAll('[data-report-id]')).map((n) => n.getAttribute('data-report-id'));

describe('the sample-data preview', () => {
  // The preview dates its sample from the clock it opens at.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is offered on the empty state, labelled, and leaving it restores the empty state', () => {
    emptyTab();
    expect(reportIds()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Preview with sample data' }));
    expect(screen.getByText(SAMPLE_BANNER)).toBeTruthy();
    expect(SAMPLE_BANNER).toBe('Sample data — not your money');
    // A fresh layout's six reports, over the sample's categories.
    expect(new Set(reportIds())).toEqual(new Set([
      'headline-stats', 'cash-flow', 'category-trends', 'budget-vs-actual', 'merchants', 'subscriptions',
    ]));
    expect(document.querySelector('[data-bva="Groceries"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByText(SAMPLE_BANNER)).toBeNull();
    expect(reportIds()).toEqual([]);
    expect(screen.getByText(/budget reports come from the background companion/i)).toBeTruthy();
  });

  it('writes nothing: no Customize, no Add report, no headline picker, no subscription edits, no pool edit', () => {
    const spies = emptyTab();
    fireEvent.click(screen.getByRole('button', { name: 'Preview with sample data' }));
    expect(screen.queryByRole('button', { name: 'Customize' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Add report' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Add subscription' })).toBeNull();
    // Every chip and every button on the board, pressed once.
    for (const label of ['Month', '3 months', '6 months', '12 months', 'All']) {
      fireEvent.click(screen.getByRole('button', { name: label }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Open Headline numbers' }));
    expect(screen.getByText(SAMPLE_BANNER)).toBeTruthy();
    expect(screen.queryByText('Choose up to five numbers:')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to all reports' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Subscriptions' }));
    expect(screen.queryByRole('button', { name: '+ Add subscription' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to all reports' }));
    // A budget row drills into the sample's own transactions, which open no story.
    fireEvent.click(screen.getByRole('button', { name: 'See Groceries transactions' }));
    expect(screen.getAllByText('Corner Grocer').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Open in Wealthfolio' })).toBeNull();
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  it('shows no emoji, and no stale-data warning however old the clock says it is', () => {
    render(<BudgetPreview store={{} as any} now={new Date(2020, 0, 15)} onExit={vi.fn()} />);
    expect(document.body.textContent).not.toMatch(EMOJI);
    expect(screen.queryByText(/hasn.t published since/)).toBeNull();
  });

  it('dates the sample from the moment it is given', () => {
    render(<BudgetPreview store={{} as any} now={new Date(2027, 0, 14)} onExit={vi.fn()} />);
    const months = JSON.parse(document.querySelector('[data-recharts="BarChart"][data-points]')!.getAttribute('data-points')!)
      .map((p: { month: string }) => p.month);
    expect(months.at(-1)).toBe('2027-01');
    expect(months[0]).toBe('2026-08');
  });
});
