import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { SyncPage } from './SyncPage';
import { makeProps } from './test-props';
import type { CashForecastOk, CashForecastRead } from '../../shared/cash-forecast';

/**
 * Home's "Next 30 days" (project 5 R1, spec A), through the page that loads
 * the forecast: the tile in every state, and what it counted, opened in place.
 */
vi.mock('recharts', () => {
  const stub = (name: string) => (p: any) => React.createElement('div', { 'data-recharts': name }, p?.children ?? null);
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
  return { INTERVAL_SKIP_MESSAGE: actual.INTERVAL_SKIP_MESSAGE, runSync: vi.fn(async () => ({ imported: 0, skipped: 0, errors: [] })) };
});

const EMOJI = /\p{Extended_Pictographic}/u;
/** Local 2:00 PM, Oct 14: the status line is in the viewer's own zone. */
const AT = new Date(2026, 9, 14, 14, 0);
const LATER = new Date(2026, 9, 14, 18, 30);
const FORECAST = (over: Partial<CashForecastOk> = {}): CashForecastOk => ({
  v: 1, at: AT.toISOString(), ok: true, cashCents: 371849, lowCents: 124000, lowDate: '2026-11-13',
  days: 30, basedOnMonths: 3, dailySpendCents: 4210,
  accounts: [{ name: 'PNC Checking', cents: 321849, asOf: '2026-10-14' }, { name: 'Savings', cents: 50000, asOf: '2026-10-09' }],
  bills: [{ name: 'Netflix', date: '2026-10-20', cents: 1549 }, { name: 'Rent', date: '2026-11-01', cents: 120000 }],
  missing: ['Joint'],
  ...over,
});
const ok = (f: CashForecastOk | { v: 1; at: string; ok: false; reason: string }): CashForecastRead => ({ kind: 'ok', forecast: f });

const at = (when: Date) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(when);
  onTestFinished(() => { vi.useRealTimers(); });
};

function page(read: CashForecastRead, companion: string | null = '1.61.0') {
  const props = makeProps();
  props.store.getUiState = vi.fn(async () => ({ activeTab: 'home' }));
  props.store.getCompanionVersion = vi.fn(async () => companion);
  props.store.getCashForecast = vi.fn(async () => read);
  return { props, ...render(<SyncPage {...props} />) };
}
const strip = () => document.querySelector('.sfin-strip') as HTMLElement;

describe('Home’s "Next 30 days"', () => {
  it('shows the low point if nothing comes in, and opens what it counted in place', async () => {
    at(LATER);
    page(ok(FORECAST()));
    const tile = await screen.findByRole('button', { name: 'Next 30 days: If nothing comes in: $1,240 left on Nov 13' });
    expect(tile.textContent).toContain('$1,240');
    expect(tile.textContent).toContain('left on Nov 13 if nothing comes in');
    expect(tile.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(tile);
    await waitFor(() => expect(tile.getAttribute('aria-expanded')).toBe('true'));
    expect(tile.getAttribute('aria-controls')).toBe('cash-forecast');
    const panel = document.getElementById('cash-forecast')!;
    expect(panel).toBeTruthy();
    for (const line of [
      'If nothing comes in: $1,240 left on Nov 13',
      'Cash today: $3,718.49',
      'PNC Checking · $3,218.49',
      'Savings · $500 · Balance from Oct 9',
      "Joint · left out: the bank hasn't sent a balance",
      'Oct 20 · Netflix · $15.49',
      'Nov 1 · Rent · $1,200',
      'Assumes no income, your known bills on their dates, and about $42 a day of other spending (your last 3 months).',
      'As of the 2:00 PM sync.',
    ]) {
      expect(panel.textContent).toContain(line);
    }
    expect(`${strip().textContent}${panel.textContent}`).not.toMatch(EMOJI);
  });

  it('says when cash may run short', async () => {
    at(LATER);
    page(ok(FORECAST({ lowCents: -30000, shortDate: '2026-11-03' })));
    const tile = await screen.findByRole('button', { name: 'Next 30 days: If nothing comes in: short around Nov 3' });
    expect(tile.textContent).toContain('Short');
    expect(tile.textContent).toContain('around Nov 3 if nothing comes in');
  });

  it('shows a two-day-old forecast as out of date', async () => {
    at(new Date(2026, 9, 17, 9, 0));
    page(ok(FORECAST()));
    const tile = await screen.findByRole('button', { name: /^Next 30 days: If nothing comes in: \$1,240 left on Nov 13\. This forecast is from Oct 14/ });
    expect(tile.textContent).toContain("This forecast is from Oct 14 — the companion hasn't synced since.");
  });

  it.each<[string, CashForecastRead, string | null, string]>([
    ['an older companion', { kind: 'absent' }, '1.60.0', 'Update the companion to see this'],
    ['a companion that has not synced yet', { kind: 'absent' }, '1.61.0', "Arrives with the companion's next sync"],
    ['a forecast it cannot read', { kind: 'corrupt' }, '1.61.0', "Couldn't read the forecast"],
    ['no forecast, with the reason', ok({ v: 1, at: AT.toISOString(), ok: false, reason: "Couldn't read the bank balances." }), '1.61.0', "Couldn't read the bank balances."],
  ])('says so for %s — never a number', async (_what, read, companion, line) => {
    at(LATER);
    page(read, companion);
    expect(await screen.findByText(line)).toBeTruthy();
    const tile = screen.getByText(line).closest('.sfin-tile') as HTMLElement;
    expect(tile.tagName).toBe('DIV');
    expect(tile.textContent).not.toMatch(/\$\d/);
    expect(tile.textContent).not.toMatch(EMOJI);
  });

  it('is not there for an add-on-only install: nothing published, no companion', async () => {
    at(LATER);
    const { props } = page({ kind: 'absent' }, null);
    await waitFor(() => expect(props.store.getCashForecast).toHaveBeenCalled());
    await screen.findByText(/Last synced/);
    expect(screen.queryByText('Next 30 days')).toBeNull();
  });
});
