import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SyncPage } from './SyncPage';

vi.mock('../utils/sync', () => ({
  runSync: vi.fn(async () => ({ imported: 5, skipped: 1, errors: [] })),
}));

const makeProps = () => ({
  ctx: {
    api: {
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-a', name: 'Checking' }]) },
      navigation: { navigate: vi.fn(async () => {}) },
    },
  } as any,
  store: {
    getLastSyncAt: vi.fn(async () => new Date('2024-01-01T10:00:00Z')),
    getAccountMapping: vi.fn(async () => ({ 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' })),
    getMappingRules: vi.fn(async () => []),
    getSyncScheduleHours: vi.fn(async () => 6),
    getAccessUrl: vi.fn(async () => 'https://u:p@bridge.simplefin.org/simplefin'),
    getAccountNames: vi.fn(async () => ({ 'sfin-1': 'Growth', 'sfin-2': 'Spend' })),
    setAccountNames: vi.fn(),
    getAccountBalances: vi.fn(async () => ({
      'sfin-1': { balance: 1234.56, currency: 'USD', date: 1700000000, drift: null },
      'sfin-2': { balance: -420.1, currency: 'USD', date: 1700000000, drift: 15.22 },
    })),
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
  } as any,
  onReset: vi.fn(),
  scheduler: { start: vi.fn(), stop: vi.fn(), isRunning: vi.fn(() => false) } as any,
});

describe('SyncPage', () => {
  it('renders Sync Now button', async () => {
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /sync now/i })).toBeInTheDocument());
  });

  it('shows sync result after clicking Sync Now', async () => {
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => screen.getByRole('button', { name: /sync now/i }));
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(screen.getByText(/5 transactions/i)).toBeInTheDocument());
  });

  it('shows account names instead of raw IDs in the mapping list', async () => {
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => expect(screen.getByText(/Growth/)).toBeInTheDocument());
    expect(screen.getByText(/Checking/)).toBeInTheDocument();
    // The account row must show the name, not the raw SimpleFin ID
    const growthRow = screen.getByText(/Growth/).closest('.sfin-acct');
    expect(growthRow?.textContent).not.toContain('sfin-1');
  });

  it('navigates to the Wealthfolio account when a mapped row is clicked', async () => {
    const props = makeProps();
    render(<SyncPage {...props} />);
    await waitFor(() => expect(screen.getByText(/Growth/)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Growth/).closest('.sfin-acct')!);
    expect(props.ctx.api.navigation.navigate).toHaveBeenCalledWith('/accounts/wf-a');
  });

  it('changing the interval saves it and restarts the scheduler', async () => {
    const props = makeProps();
    render(<SyncPage {...props} />);
    const select = await screen.findByLabelText(/auto-sync interval/i);
    fireEvent.change(select, { target: { value: '8' } });
    await waitFor(() => expect(props.store.setSyncScheduleHours).toHaveBeenCalledWith(8));
    expect(props.scheduler.start).toHaveBeenCalledWith(8, expect.any(Function), expect.any(Function));
  });

  it('renders a Report Categories checklist populated from the companion-published list, defaulting to all selected', async () => {
    const props = makeProps();
    props.store.getAvailableReportCategories = vi.fn(async () => ['Dining', 'Groceries']);
    render(<SyncPage {...props} />);
    await screen.findByText('Dining');
    const dailyCheckbox = screen.getByLabelText(/Dining.*Daily/i) as HTMLInputElement;
    expect(dailyCheckbox.checked).toBe(true);
    const weeklyCheckbox = screen.getByLabelText(/Groceries.*Weekly/i) as HTMLInputElement;
    expect(weeklyCheckbox.checked).toBe(true);
  });

  it('shows a placeholder before the companion has published any categories', async () => {
    const props = makeProps();
    props.store.getAvailableReportCategories = vi.fn(async () => []);
    render(<SyncPage {...props} />);
    await screen.findByText(/categories will appear here/i);
  });

  it('saves the selected daily/weekly category lists in Telegram config', async () => {
    const props = makeProps();
    props.store.getAvailableReportCategories = vi.fn(async () => ['Dining', 'Groceries']);
    props.store.getTelegramConfig = vi.fn(async () => ({ botToken: 't', chatId: 'c', enabled: true }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await screen.findByText('Dining');
    fireEvent.click(screen.getByLabelText(/Dining.*Daily/i)); // uncheck
    fireEvent.click(screen.getByText('Save Telegram Settings'));
    await waitFor(() => {
      expect(props.store.setTelegramConfig).toHaveBeenCalledWith(
        expect.objectContaining({ dailyReportCategories: ['Groceries'] }),
      );
    });
  });

  it('unchecking every category saves an empty array, not the "all" sentinel', async () => {
    const props = makeProps();
    props.store.getAvailableReportCategories = vi.fn(async () => ['Dining']);
    props.store.getTelegramConfig = vi.fn(async () => ({ botToken: 't', chatId: 'c', enabled: true }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await screen.findByText('Dining');
    fireEvent.click(screen.getByLabelText(/Dining.*Daily/i)); // uncheck the only category
    fireEvent.click(screen.getByText('Save Telegram Settings'));
    await waitFor(() => {
      expect(props.store.setTelegramConfig).toHaveBeenCalledWith(
        expect.objectContaining({ dailyReportCategories: [] }),
      );
    });
  });

  it('preserves a saved subset selection when the published category list grows', async () => {
    const props = makeProps();
    props.store.getAvailableReportCategories = vi.fn(async () => ['Dining', 'Groceries', 'Travel']);
    props.store.getTelegramConfig = vi.fn(async () => ({
      botToken: 't',
      chatId: 'c',
      enabled: true,
      dailyReportCategories: ['Groceries'],
      weeklyReportCategories: 'all',
    }));
    render(<SyncPage {...props} />);
    await screen.findByText('Dining');
    const dailyDining = screen.getByLabelText(/Dining.*Daily/i) as HTMLInputElement;
    const dailyGroceries = screen.getByLabelText(/Groceries.*Daily/i) as HTMLInputElement;
    const dailyTravel = screen.getByLabelText(/Travel.*Daily/i) as HTMLInputElement;
    expect(dailyDining.checked).toBe(false);
    expect(dailyGroceries.checked).toBe(true);
    expect(dailyTravel.checked).toBe(false);
    const weeklyTravel = screen.getByLabelText(/Travel.*Weekly/i) as HTMLInputElement;
    expect(weeklyTravel.checked).toBe(true);
  });
});
