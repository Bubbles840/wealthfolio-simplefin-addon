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
    getOpenCards: vi.fn(async () => ({}) as Record<string, boolean>),
    // async, like the real SecretsStore method — the page fires it and forgets,
    // so it has to be thenable
    setOpenCards: vi.fn(async () => {}),
  } as any,
  onReset: vi.fn(),
  scheduler: { start: vi.fn(), stop: vi.fn(), isRunning: vi.fn(() => false) } as any,
});

/**
 * The config cards ship collapsed, and a collapsed panel is unmounted — so a
 * test that touches a control inside one has to open it first, exactly as the
 * user does. Matches the disclosure header by its accessible name, which is the
 * title plus its summary line, hence the anchored patterns. Idempotent.
 */
async function openSection(name: RegExp) {
  const header = await screen.findByRole('button', { name });
  if (header.getAttribute('aria-expanded') !== 'true') fireEvent.click(header);
  return header;
}

/** The category matrix sits behind two disclosures: its own, nested in the
 *  Telegram card (where its Save button lives). */
async function openReportCategories() {
  await openSection(/^Telegram Notifications/i);
  await openSection(/^Report categories/i);
}

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
    await openSection(/^Auto-Sync/i);
    const select = await screen.findByLabelText(/auto-sync interval/i);
    fireEvent.change(select, { target: { value: '8' } });
    await waitFor(() => expect(props.store.setSyncScheduleHours).toHaveBeenCalledWith(8));
    expect(props.scheduler.start).toHaveBeenCalledWith(8, expect.any(Function), expect.any(Function));
  });

  it('renders a Report Categories checklist populated from the companion-published list, defaulting to all selected', async () => {
    const props = makeProps();
    props.store.getAvailableReportCategories = vi.fn(async () => ['Dining', 'Groceries']);
    render(<SyncPage {...props} />);
    await openReportCategories();
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
    await openReportCategories();
    await screen.findByText(/categories will appear here/i);
  });

  it('saves the selected daily/weekly category lists in Telegram config', async () => {
    const props = makeProps();
    props.store.getAvailableReportCategories = vi.fn(async () => ['Dining', 'Groceries']);
    props.store.getTelegramConfig = vi.fn(async () => ({ botToken: 't', chatId: 'c', enabled: true }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await openReportCategories();
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
    await openReportCategories();
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
    await openReportCategories();
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
    await openReportCategories();
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
    await openReportCategories();
    await screen.findByText('Groceries');
    fireEvent.click(screen.getByLabelText(/Dining.*Daily/i)); // check the last missing one
    fireEvent.click(screen.getByText('Save Telegram Settings'));
    await waitFor(() => {
      expect(props.store.setTelegramConfig).toHaveBeenCalledWith(
        expect.objectContaining({ dailyReportCategories: 'all' }),
      );
    });
  });

  // ── Collapsible config cards ───────────────────────────────────────────
  it('keeps the daily-driver view visible and every config card collapsed', async () => {
    const props = makeProps();
    render(<SyncPage {...props} />);
    // Always visible: status, actions, stat tiles, accounts with balances.
    await waitFor(() => expect(screen.getByRole('button', { name: /sync now/i })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /reconcile & link/i })).toBeInTheDocument();
    expect(screen.getByText('Accounts synced')).toBeInTheDocument();
    expect(screen.getByText(/Growth/)).toBeInTheDocument();
    expect(screen.getByText('$1,234.56')).toBeInTheDocument();
    // The drift banner is a needs-attention signal, so it never collapses.
    expect(screen.getByText(/is off by/)).toBeInTheDocument();

    // Collapsed: the controls inside each config card are absent from the DOM,
    // not merely hidden.
    expect(screen.queryByLabelText(/auto-sync interval/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Save Telegram Settings')).not.toBeInTheDocument();
    expect(screen.queryByText('+ Add rule')).not.toBeInTheDocument();
    expect(screen.queryByText(/docker-compose\.yml/)).not.toBeInTheDocument();
    for (const name of [/^Auto-Sync/i, /^Background sync/i, /^Telegram Notifications/i, /^Transaction Rules/i]) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('gives every collapsible card one disclosure shape: a real button, whole-header hit target, aria-expanded', async () => {
    render(<SyncPage {...makeProps()} />);
    const header = await screen.findByRole('button', { name: /^Auto-Sync/i });
    // A native <button> is what makes the header keyboard-operable (focus +
    // Enter/Space) without any hand-rolled key handling, and the title AND the
    // summary line are both inside it, so the whole row is the hit target.
    expect(header.tagName).toBe('BUTTON');
    expect(header.querySelector('.sfin-disclosure-text')).toBeTruthy();
    expect(header).toHaveAttribute('aria-expanded', 'false');
    // Closed: no dangling aria-controls pointing at an unmounted panel.
    expect(header).not.toHaveAttribute('aria-controls');

    fireEvent.click(header);
    await waitFor(() => expect(header).toHaveAttribute('aria-expanded', 'true'));
    const panelId = header.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId!)).toBeTruthy();
    expect(screen.getByLabelText(/auto-sync interval/i)).toBeInTheDocument();

    fireEvent.click(header);
    await waitFor(() => expect(header).toHaveAttribute('aria-expanded', 'false'));
  });

  it('reports each collapsed card\u2019s state in its header summary, so collapsing hides chrome and not state', async () => {
    const props = makeProps();
    props.store.getSyncScheduleHours = vi.fn(async () => 4);
    props.store.getAutoHeal = vi.fn(async () => true);
    props.store.getMappingRules = vi.fn(async () => [
      { pattern: 'PAYROLL', matchType: 'contains', activityType: 'DEPOSIT' },
      { pattern: 'ATM', matchType: 'contains', activityType: 'WITHDRAWAL' },
    ]);
    props.store.getTelegramConfig = vi.fn(async () => ({ botToken: 't', chatId: 'c', enabled: true }));
    render(<SyncPage {...props} />);
    await screen.findByText('Every 4h \u00b7 auto-heal on');
    expect(screen.getByText('2 rules')).toBeInTheDocument();
    expect(screen.getByText('Connected \u00b7 daily, weekly reports')).toBeInTheDocument();
  });

  it('summarises an off / unconfigured state distinguishably', async () => {
    const props = makeProps();
    props.store.getSyncScheduleHours = vi.fn(async () => null);
    props.store.getAutoAdjust = vi.fn(async () => true);
    render(<SyncPage {...props} />);
    // Interval off, but aggressive auto-heal on — the summary has to say both.
    await screen.findByText('Off \u00b7 aggressive auto-heal');
    // No token/chat id in the default mock.
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.getByText(/using the \+\/\u2212 defaults/)).toBeInTheDocument();
  });

  it('persists which cards are open, and restores them on the next visit', async () => {
    const props = makeProps();
    render(<SyncPage {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: /^Transaction Rules/i }));
    await waitFor(() =>
      expect(props.store.setOpenCards).toHaveBeenCalledWith(expect.objectContaining({ rules: true })),
    );

    // Next visit: the stored blob decides, so the page does not reset.
    const revisit = makeProps();
    revisit.store.getOpenCards = vi.fn(async () => ({ rules: true, 'auto-sync': true }));
    render(<SyncPage {...revisit} />);
    await waitFor(() => expect(screen.getAllByText('+ Add rule').length).toBe(1));
    expect(screen.getAllByLabelText(/auto-sync interval/i).length).toBe(1);
    // Cards absent from the blob stay closed.
    expect(screen.queryByText('Save Telegram Settings')).not.toBeInTheDocument();
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
    await openReportCategories();
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
