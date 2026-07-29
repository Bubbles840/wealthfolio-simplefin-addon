import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

  it('does not re-enable every category when the saved selection is longer than the published list', async () => {
    // `availableCategories` is the union of *this month's* spending and
    // budgets, so it legitimately shrinks — a category with spending but no
    // budget vanishes at month rollover — while the saved selection still
    // holds the older, longer list. The old collapse-to-'all' test compared
    // lengths only: unchecking Groceries here left a 2-element array whose
    // length matched the published list, so it stored 'all' and silently put
    // every category back into the user's reports.
    const props = makeProps();
    props.store.getAvailableReportCategories = vi.fn(async () => ['Groceries', 'Dining']);
    props.store.getTelegramConfig = vi.fn(async () => ({
      botToken: 't',
      chatId: 'c',
      enabled: true,
      dailyReportCategories: ['Groceries', 'Dining', 'Fun'],
      weeklyReportCategories: 'all',
    }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByLabelText(/Groceries.*Daily/i)); // uncheck
    fireEvent.click(screen.getByText('Save Telegram Settings'));
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    const saved = (props.store.setTelegramConfig as any).mock.calls[0][0];
    expect(saved.dailyReportCategories).not.toBe('all');
    expect(Array.isArray(saved.dailyReportCategories)).toBe(true);
    expect(saved.dailyReportCategories).not.toContain('Groceries');
    expect(saved.dailyReportCategories).toContain('Dining');
    // The no-longer-published name is preserved, not pruned, so the user's
    // original intent survives the category reappearing next month.
    expect(saved.dailyReportCategories).toContain('Fun');
  });

  it('collapses to the "all" sentinel only when the selection really covers every published category', async () => {
    const props = makeProps();
    props.store.getAvailableReportCategories = vi.fn(async () => ['Groceries', 'Dining']);
    props.store.getTelegramConfig = vi.fn(async () => ({
      botToken: 't', chatId: 'c', enabled: true, dailyReportCategories: ['Groceries'],
    }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByLabelText(/Dining.*Daily/i)); // check the last missing one
    fireEvent.click(screen.getByText('Save Telegram Settings'));
    await waitFor(() => {
      expect(props.store.setTelegramConfig).toHaveBeenCalledWith(
        expect.objectContaining({ dailyReportCategories: 'all' }),
      );
    });
  });

  it('composes two successive toggles instead of dropping the first', async () => {
    // Guards the functional-updater conversion: the handler now derives both
    // membership and the next value from `prev` rather than from closed-over
    // state. NOTE this cannot prove the batching case on its own — React
    // flushes each discrete DOM event, so two fireEvent clicks can't share a
    // render snapshot. It pins the composition result the updater must produce.
    const props = makeProps();
    props.store.getAvailableReportCategories = vi.fn(async () => ['Groceries', 'Dining', 'Travel']);
    props.store.getTelegramConfig = vi.fn(async () => ({ botToken: 't', chatId: 'c', enabled: true }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await screen.findByText('Groceries');
    const groceries = screen.getByLabelText(/Groceries.*Daily/i);
    const dining = screen.getByLabelText(/Dining.*Daily/i);
    // One outer act() so both updates are dispatched off the SAME render —
    // bare consecutive fireEvent calls each flush, which hides the bug.
    act(() => {
      fireEvent.click(groceries);
      fireEvent.click(dining);
    });
    fireEvent.click(screen.getByText('Save Telegram Settings'));
    await waitFor(() => {
      expect(props.store.setTelegramConfig).toHaveBeenCalledWith(
        expect.objectContaining({ dailyReportCategories: ['Travel'] }),
      );
    });
  });
});
