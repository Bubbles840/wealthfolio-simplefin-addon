import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SetupPage } from './SetupPage';
import { fetchAccounts } from '../utils/simplefin';

// Step 1's sample-data preview renders the Budget board: recharts and the host
// chart kit are stubbed to passthrough elements, as in BudgetTab.test.tsx.
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

vi.mock('../utils/simplefin', () => ({
  claimToken: vi.fn(async () => 'https://user:pass@bridge.simplefin.org/simplefin'),
  fetchAccounts: vi.fn(async () => ({ errors: [], accounts: [] })),
}));

const makeProps = () => ({
  ctx: {
    api: {
      secrets: { get: vi.fn(async () => null), set: vi.fn(), delete: vi.fn() },
      accounts: { getAll: vi.fn(async () => []) },
    },
  } as any,
  store: {
    getAccessUrl: vi.fn(async () => null),
    setAccessUrl: vi.fn(async () => {}),
    setAuthB64: vi.fn(async () => {}),
    getAuthB64Key: vi.fn(async () => 'simplefin_auth_b64'),
    setAccountNames: vi.fn(async () => {}),
    getAccountNames: vi.fn(async () => ({})),
    getAccountMapping: vi.fn(async () => null),
    setAccountMapping: vi.fn(async () => {}),
    getMappingRules: vi.fn(async () => []),
    setMappingRules: vi.fn(async () => {}),
    getSyncScheduleHours: vi.fn(async () => null),
    setSyncScheduleHours: vi.fn(async () => {}),
  } as any,
  onComplete: vi.fn(),
});

describe('SetupPage', () => {
  it('renders Step 1 of 2 with token input', () => {
    render(<SetupPage {...makeProps()} />);
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/setup token/i)).toBeInTheDocument();
  });

  it('calls claimToken and advances to Step 2 on connect', async () => {
    const props = makeProps();
    render(<SetupPage {...props} />);
    fireEvent.change(screen.getByPlaceholderText(/setup token/i), {
      target: { value: 'dGVzdA==' }, // base64 of "test" — mock ignores actual value
    });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    await waitFor(() => expect(screen.getByText(/step 2/i)).toBeInTheDocument());
    expect(props.store.setAccessUrl).toHaveBeenCalled();
  });

  it('finishes after the mapping, with auto-sync on every 6 hours', async () => {
    // Setup was four steps; the two it dropped (an empty rules editor, a
    // schedule that defaulted to OFF) live in Settings (1.57).
    vi.mocked(fetchAccounts).mockResolvedValueOnce({
      errors: [],
      accounts: [{ id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '10.00', 'balance-date': 1700000000 }],
    } as any);
    const props = makeProps();
    props.ctx.api.accounts.getAll = vi.fn(async () => [{ id: 'wf-a', name: 'Checking' }]);
    render(<SetupPage {...props} />);
    fireEvent.change(screen.getByPlaceholderText(/setup token/i), { target: { value: 'dGVzdA==' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(await screen.findByText('Step 2 of 2')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'Checking' }).length).toBeGreaterThan(0));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'wf-a' } });
    fireEvent.click(screen.getByRole('button', { name: /save mapping/i }));
    await waitFor(() => expect(props.onComplete).toHaveBeenCalled());
    expect(props.store.setAccountMapping).toHaveBeenCalledWith({ 'sfin-1': 'wf-a' });
    expect(props.store.setSyncScheduleHours).toHaveBeenCalledWith(6);
    expect(screen.queryByText(/step 3/i)).toBeNull();
  });

  it('shows the sample-data preview from step 1, writes nothing, and closes it', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 14, 12, 0));
    try {
      const props = makeProps();
      render(<SetupPage {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'See what it looks like' }));
      expect(screen.getByText('Sample data — not your money')).toBeTruthy();
      expect(document.querySelector('[data-bva="Groceries"]')).toBeTruthy();
      expect(screen.getByText('Step 1 of 2')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
      expect(screen.queryByText('Sample data — not your money')).toBeNull();
      for (const write of [
        props.store.setAccessUrl, props.store.setAuthB64, props.store.setAccountNames,
        props.store.setAccountMapping, props.store.setMappingRules, props.store.setSyncScheduleHours,
      ]) {
        expect(write).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
