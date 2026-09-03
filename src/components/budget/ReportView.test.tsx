import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
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
      { month: '2026-07', rate: 87.8 },
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

describe('second-wave reports and density', () => {
  const pooled = (): ReportCube => ({
    ...fresh(),
    asOf: '2026-08-27T12:00:00Z',
    pool: {
      config: { amountCents: 160_000, startDate: '2026-08-25', endDate: '2026-08-29' },
      daily: [
        { date: '2026-08-26', spentCents: 1000 },
        { date: '2026-08-27', spentCents: 1500 },
      ],
    },
  });

  it('category-donut: a pie of the last month, largest first', () => {
    view('category-donut');
    const data = JSON.parse(document.querySelector('[data-recharts="Pie"]')?.getAttribute('data-points') ?? 'null');
    expect(data[0]).toMatchObject({ name: 'Groceries', value: 25 });
  });

  it('mom-delta: bars of the change per category', () => {
    view('mom-delta');
    expect(points('BarChart')).toEqual([
      { category: 'Groceries', delta: -5 },
      { category: 'Dining', delta: -10 },
    ]);
  });

  it('spend-calendar: one cell per pool day with the spend in its title', () => {
    view('spend-calendar', pooled());
    const cells = document.querySelectorAll('[data-cal]');
    expect(cells.length).toBe(2);
    expect(Array.from(cells).some((c) => (c.getAttribute('title') ?? '').includes('$10'))).toBe(true);
  });

  it('pool-pace: both paces and the verdict color', () => {
    view('pool-pace', pooled());
    expect(screen.getByText('$35')).toBeInTheDocument();
    expect(screen.getByText('$1,585')).toBeInTheDocument();
    expect(document.querySelector('.sfin-pace--green')).toBeTruthy();
  });

  it('cumulative-flow: running income against running spending', () => {
    view('cumulative-flow');
    expect(points('AreaChart')).toEqual([
      { month: '2026-07', income: 500, spending: 61 },
      { month: '2026-08', income: 500, spending: 108 },
    ]);
  });

  it('uncat-trend: uncategorized spending per month', () => {
    view('uncat-trend');
    expect(points('LineChart')).toEqual([
      { month: '2026-07', uncategorized: 1 },
      { month: '2026-08', uncategorized: 2 },
    ]);
  });

  it('a one-row card budgets its list rows and says what it cut', () => {
    render(<ReportView id="budget-vs-actual" cube={fresh()} customReports={[]} density={1} />);
    // The fixture has two categories; a compact card caps at three, so both
    // fit — assert the cap machinery with merchants instead.
    const many = {
      ...fresh(),
      merchants: [[], Array.from({ length: 10 }, (_, i) => ({ name: `MERCHANT ${i}`, cents: (10 - i) * 1000, count: 1 }))],
    };
    render(<ReportView id="merchants" cube={many} customReports={[]} density={1} />);
    expect(screen.getAllByText(/^MERCHANT/)).toHaveLength(3);
    expect(screen.getByText(/\+ ?7 more/i)).toBeInTheDocument();
  });
});

describe('headline stats card', () => {
  it('renders the three chips in one unit system', () => {
    view('headline-stats');
    expect(screen.getByText('Spent this month')).toBeInTheDocument();
    expect(screen.getByText('$47')).toBeInTheDocument();   // Aug spend
    expect(screen.getByText('88%')).toBeInTheDocument();   // last non-null rate, PERCENT once
    expect(screen.getByText('75.9mo')).toBeInTheDocument();
  });
});

describe('data check card', () => {
  it('says it cannot verify when the companion published no check', () => {
    view('data-check');
    expect(screen.getByText(/companion hasn't published a check/i)).toBeTruthy();
  });

  it('renders the green verdict when the pipelines agree', () => {
    view('data-check', { ...fresh(), check: {
      month: '2026-08', cubeSpendCents: 4700, cubeUncatCents: 200,
      ledgerSpendCents: 4700, ledgerUncatCents: 200,
    } });
    expect(screen.getByText(/matches the ledger/i)).toBeTruthy();
  });

  it('renders each divergent measure with both sides and the delta', () => {
    view('data-check', { ...fresh(), check: {
      month: '2026-08', cubeSpendCents: 4700, cubeUncatCents: 200,
      ledgerSpendCents: 14600, ledgerUncatCents: 200,
    } });
    expect(screen.getByText('Categorized spending')).toBeTruthy();
    expect(screen.getByText(/\$47\.00 here/)).toBeTruthy();
    expect(screen.getByText(/\$146\.00 in the ledger/)).toBeTruthy();
    expect(screen.getByText(/\+\$99\.00/)).toBeTruthy();
    expect(screen.getByText(/accounts this addon doesn't sync/i)).toBeTruthy();
  });
});

describe('subscriptions card', () => {
  const SUB = { name: 'SPOTIFY', monthlyCents: 1099, count: 5, lastDate: '2026-08-20', lastCents: 1099, creep: false };

  it('waits politely while the companion has not looked yet', () => {
    view('subscriptions');
    expect(screen.getByText(/after the next sync/i)).toBeTruthy();
  });

  it('lists each subscription with its monthly price and totals them', () => {
    view('subscriptions', { ...fresh(), subscriptions: [SUB, { ...SUB, name: 'ADOBE', monthlyCents: 5499, lastCents: 5499 }] });
    expect(screen.getByText('SPOTIFY')).toBeTruthy();
    expect(screen.getByText('ADOBE')).toBeTruthy();
    expect(screen.getByText(/\$65\.98\/mo across 2/)).toBeTruthy();
  });

  it('marks price creep with the old and new price', () => {
    view('subscriptions', { ...fresh(), subscriptions: [{ ...SUB, lastCents: 1199, creep: true }] });
    expect(screen.getByText(/\$11\.99/)).toBeTruthy();
    expect(screen.getByText(/was \$10\.99/)).toBeTruthy();
  });

  it('an empty roster reads as a clean bill, not an error', () => {
    view('subscriptions', { ...fresh(), subscriptions: [] });
    expect(screen.getByText(/no monthly subscriptions detected/i)).toBeTruthy();
  });
});

describe('subscriptions card: dismissals', () => {
  const SUB = { name: 'SPOTIFY', monthlyCents: 1099, count: 5, lastDate: '2026-08-20', lastCents: 1099, creep: false };
  const QR = { ...SUB, name: 'QR LIBRARY', monthlyCents: 999 };

  it('each row offers a dismiss, for the subscription that was cancelled', () => {
    const onHide = vi.fn();
    render(<ReportView
      id="subscriptions"
      cube={{ ...fresh(), subscriptions: [SUB, QR] }}
      customReports={[]}
      hiddenSubscriptions={[]}
      onHideSubscription={onHide}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss QR LIBRARY' }));
    expect(onHide).toHaveBeenCalledWith('QR LIBRARY');
  });

  it('hidden names leave the roster and the total, with a way back', () => {
    const onRestore = vi.fn();
    render(<ReportView
      id="subscriptions"
      cube={{ ...fresh(), subscriptions: [SUB, QR] }}
      customReports={[]}
      hiddenSubscriptions={['QR LIBRARY']}
      onRestoreSubscriptions={onRestore}
    />);
    expect(screen.queryByText('QR LIBRARY')).toBeNull();
    expect(screen.getByText(/\$10\.99\/mo across 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /1 dismissed — restore/i }));
    expect(onRestore).toHaveBeenCalled();
  });

  it('without handlers the card renders read-only, as in older hosts', () => {
    render(<ReportView id="subscriptions" cube={{ ...fresh(), subscriptions: [SUB] }} customReports={[]} />);
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
  });
});

describe('subscriptions card: confirm/ignore (v1.37)', () => {
  const sub = (over: any = {}) => ({
    name: 'SPOTIFY', monthlyCents: 1099, count: 5, lastDate: '2026-08-20',
    lastCents: 1099, creep: false, kind: 'subscription', ...over,
  });

  it('bills and possibles become a question, not a line item', () => {
    // The user's general approach: anything on a monthly cadence gets ASKED
    // about — rent and utilities included — and only answers count as money.
    const onConfirm = vi.fn();
    const onHide = vi.fn();
    render(<ReportView id="subscriptions" customReports={[]} cube={{ ...fresh(), subscriptions: [
      sub(),
      sub({ name: 'DUKE ENERGY', monthlyCents: 9900, lastCents: 9900, prevCents: 5420, kind: 'bill' }),
      sub({ name: 'MYSTERY BOX CLUB', monthlyCents: 1500, lastCents: 1500, prevCents: 1500, kind: 'possible' }),
    ] }} hiddenSubscriptions={[]} confirmedSubscriptions={[]} onConfirmSubscription={onConfirm} onHideSubscription={onHide} />);
    expect(screen.getByText(/is this a subscription\?/i)).toBeTruthy();
    // No mute "varies": the change itself is the information.
    expect(screen.getByText(/\$54\.20 → \$99\.00\/mo/)).toBeTruthy();
    // Only the sure subscription counts.
    expect(screen.getByText(/\$10\.99\/mo across 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, DUKE ENERGY is a subscription' }));
    expect(onConfirm).toHaveBeenCalledWith('DUKE ENERGY');
    fireEvent.click(screen.getByRole('button', { name: 'No, ignore MYSTERY BOX CLUB' }));
    expect(onHide).toHaveBeenCalledWith('MYSTERY BOX CLUB');
  });

  it('a confirmed candidate joins the roster and the total for good', () => {
    render(<ReportView id="subscriptions" customReports={[]} cube={{ ...fresh(), subscriptions: [
      sub(),
      sub({ name: 'DUKE ENERGY', monthlyCents: 9900, kind: 'bill' }),
    ] }} hiddenSubscriptions={[]} confirmedSubscriptions={['DUKE ENERGY']} />);
    expect(screen.queryByText(/is this a subscription\?/i)).toBeNull();
    expect(screen.getByText(/\$109\.99\/mo across 2/)).toBeTruthy();
  });

  it('rows without a kind (older companion) count as subscriptions', () => {
    render(<ReportView id="subscriptions" customReports={[]} cube={{ ...fresh(), subscriptions: [
      sub({ kind: undefined }),
    ] }} />);
    expect(screen.getByText(/\$10\.99\/mo across 1/)).toBeTruthy();
    expect(screen.queryByText(/is this a subscription\?/i)).toBeNull();
  });
});

describe('subscriptions card: watch + per-item restore (v1.38)', () => {
  const SUB = { name: 'SPOTIFY', monthlyCents: 1099, count: 5, lastDate: '2026-08-20', lastCents: 1099, creep: false, kind: 'subscription' as const };
  const cubeWithMerchants = () => ({
    ...fresh(),
    subscriptions: [SUB],
    merchants: [[], [
      { name: 'ANTHROPIC* CLAUDE SUB', cents: 2000, count: 1 },
      { name: 'CHIPOTLE', cents: 4500, count: 3 },
    ]],
  });

  it('a confirmed name with no detection yet shows as watching, priced by its charges', () => {
    render(<ReportView id="subscriptions" customReports={[]} cube={cubeWithMerchants()}
      confirmedSubscriptions={['ANTHROPIC* CLAUDE SUB']} hiddenSubscriptions={[]} />);
    expect(screen.getByText('ANTHROPIC* CLAUDE SUB')).toBeTruthy();
    expect(screen.getByText(/\$20\.00\/mo · watching/)).toBeTruthy();
    // It counts: a watched subscription is money leaving monthly.
    expect(screen.getByText(/\$30\.99\/mo across 2/)).toBeTruthy();
  });

  it('the open view offers this month’s merchants to watch', () => {
    const onConfirm = vi.fn();
    render(<ReportView id="subscriptions" customReports={[]} cube={cubeWithMerchants()} hero
      confirmedSubscriptions={[]} hiddenSubscriptions={[]} onConfirmSubscription={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Watch ANTHROPIC* CLAUDE SUB' }));
    expect(onConfirm).toHaveBeenCalledWith('ANTHROPIC* CLAUDE SUB');
  });

  it('the grid card does not carry the watch list — it is drill-in furniture', () => {
    render(<ReportView id="subscriptions" customReports={[]} cube={cubeWithMerchants()}
      confirmedSubscriptions={[]} hiddenSubscriptions={[]} onConfirmSubscription={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /watch anthropic/i })).toBeNull();
  });

  it('the open view restores dismissed names one at a time', () => {
    const onUnhide = vi.fn();
    render(<ReportView id="subscriptions" customReports={[]} cube={cubeWithMerchants()} hero
      confirmedSubscriptions={[]} hiddenSubscriptions={['QR LIBRARY']} onUnhideSubscription={onUnhide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore QR LIBRARY' }));
    expect(onUnhide).toHaveBeenCalledWith('QR LIBRARY');
  });
});

describe('subscriptions card: recent months (v1.39)', () => {
  it('an unchanged question row shows one price, not an arrow, not varies', () => {
    render(<ReportView id="subscriptions" customReports={[]} cube={{ ...fresh(), subscriptions: [
      { name: 'RENT LLC', monthlyCents: 90000, count: 4, lastDate: '2026-08-25', lastCents: 90000, prevCents: 90000, creep: false, kind: 'bill' as const },
    ] }} hiddenSubscriptions={[]} confirmedSubscriptions={[]} onConfirmSubscription={vi.fn()} />);
    expect(screen.getByText('$900.00/mo')).toBeTruthy();
    expect(screen.queryByText(/varies/)).toBeNull();
    expect(screen.queryByText(/→/)).toBeNull();
  });

  it('watch list and watched pricing look back past the current month', () => {
    // Live miss: a mid-August charge was unwatchable on September 2nd because
    // only the newest month's merchants were offered.
    const cube = {
      ...fresh(),
      subscriptions: [],
      merchants: [
        [{ name: 'ANTHROPIC* CLAUDE SUB', cents: 2000, count: 1 }],
        [{ name: 'CHIPOTLE', cents: 4500, count: 3 }],
      ],
    };
    const onConfirm = vi.fn();
    const { unmount } = render(<ReportView id="subscriptions" customReports={[]} cube={cube} hero
      confirmedSubscriptions={[]} hiddenSubscriptions={[]} onConfirmSubscription={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Watch ANTHROPIC* CLAUDE SUB' }));
    expect(onConfirm).toHaveBeenCalledWith('ANTHROPIC* CLAUDE SUB');
    unmount();
    render(<ReportView id="subscriptions" customReports={[]} cube={cube}
      confirmedSubscriptions={['ANTHROPIC* CLAUDE SUB']} hiddenSubscriptions={[]} />);
    expect(screen.getByText(/\$20\.00\/mo · watching/)).toBeTruthy();
  });
});

describe('budget vs actual: per-row fill and averaging (v1.40)', () => {
  it('an overspent category fills its whole bar; every bar scales to its own row', () => {
    // Live: Shopping at $174 of $100 showed a sliver because every bar was
    // scaled by the BIGGEST row's budget (Housing), not its own.
    const overspent = { ...fresh(), budgets: [[4000, 2000], [4000, 2000]] as number[][] };
    view('budget-vs-actual', overspent);
    const over = document.querySelector('[data-bva="Groceries"] [data-bva-fill]') as HTMLElement;
    expect(over.style.width).toBe('100%'); // $27.50 avg of a $20 budget
    expect(document.querySelector('[data-bva="Groceries"] [data-bva-budget-tick]')).toBeTruthy();
    const under = document.querySelector('[data-bva="Dining"] [data-bva-fill]') as HTMLElement;
    expect(under.style.width).toBe('62.5%'); // 25 of 40, scaled to ITS row
  });

  it('says it is a monthly average when the window is longer than a month', () => {
    view('budget-vs-actual');
    expect(screen.getByText(/monthly average across 2 months/i)).toBeTruthy();
  });
});

describe('headline picks (v1.43)', () => {
  it('renders the chosen stats in order, up to five', () => {
    render(<ReportView id="headline-stats" customReports={[]} cube={fresh()}
      headlinePicks={['net-worth', 'liquid', 'spent-month', 'income-month', 'net-flow']} />);
    expect(screen.getByText('Net worth')).toBeTruthy();
    expect(screen.getByText('Liquid cash')).toBeTruthy();
    expect(screen.getByText('Net this month')).toBeTruthy();
    expect(screen.queryByText('Savings rate')).toBeNull();
  });

  it('a single pick renders one big number', () => {
    render(<ReportView id="headline-stats" customReports={[]} cube={fresh()} headlinePicks={['net-worth']} />);
    expect(screen.getByText('$9,000')).toBeTruthy();
    expect(document.querySelectorAll('.sfin-tile')).toHaveLength(1);
  });

  it('the open view offers the catalog as toggles, capped at five', () => {
    const onChange = vi.fn();
    render(<ReportView id="headline-stats" customReports={[]} cube={fresh()} hero
      headlinePicks={['spent-month', 'cash-runway', 'savings-rate', 'net-worth', 'liquid']}
      onHeadlinePicksChange={onChange} />);
    // Adding a sixth is refused; removing one works.
    fireEvent.click(screen.getByRole('button', { name: 'Show Uncategorized' }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Savings rate' }));
    expect(onChange).toHaveBeenCalledWith(['spent-month', 'cash-runway', 'net-worth', 'liquid']);
  });
});

describe('budget vs actual compresses to fit (v1.43)', () => {
  it('renders EVERY category and picks a scale tier from count vs card height', () => {
    const many = {
      ...fresh(),
      categories: Array.from({ length: 11 }, (_, i) => `Cat ${String.fromCharCode(65 + i)}`),
      spend: fresh().months.map(() => Array.from({ length: 11 }, () => [1000, 0])),
      budgets: fresh().months.map(() => Array.from({ length: 11 }, () => 2000)),
    };
    render(<ReportView id="budget-vs-actual" customReports={[]} cube={many} density={2} />);
    // No "+ N more" hiding — the card compresses instead.
    expect(screen.queryByText(/more — open the card/i)).toBeNull();
    expect(document.querySelectorAll('[data-bva]')).toHaveLength(11);
    expect((document.querySelector('[data-bva-list]') as HTMLElement).getAttribute('data-bva-scale')).toBe('tiny');
  });

  it('a short list at full size stays at the normal scale', () => {
    render(<ReportView id="budget-vs-actual" customReports={[]} cube={fresh()} density={4} />);
    expect((document.querySelector('[data-bva-list]') as HTMLElement).getAttribute('data-bva-scale')).toBe('normal');
  });
});

describe('subscription dismissal feels like a win (v1.43)', () => {
  it('cancelling celebrates the money freed', () => {
    const onHide = vi.fn();
    render(<ReportView id="subscriptions" customReports={[]} cube={{ ...fresh(), subscriptions: [
      { name: 'QR LIBRARY', monthlyCents: 499, count: 4, lastDate: '2026-08-22', lastCents: 499, creep: false, kind: 'subscription' as const },
    ] }} hiddenSubscriptions={[]} onHideSubscription={onHide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss QR LIBRARY' }));
    expect(onHide).toHaveBeenCalledWith('QR LIBRARY');
    expect(screen.getByText(/\$4\.99\/mo back in your pocket/i)).toBeTruthy();
  });
});
