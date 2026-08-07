import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SyncPage } from './SyncPage';
import { runSync, INTERVAL_SKIP_MESSAGE } from '../utils/sync';

// The real INTERVAL_SKIP_MESSAGE has to travel through the mock: SyncPage
// compares the sync's single error against it to tell "skipped, offer to force"
// from a genuine failure, and a mock that omitted it left that branch dead.
// Re-exported from the real module (not re-typed) so it cannot drift.
vi.mock('../utils/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sync')>();
  return {
    INTERVAL_SKIP_MESSAGE: actual.INTERVAL_SKIP_MESSAGE,
    runSync: vi.fn(async () => ({ imported: 5, skipped: 1, errors: [] })),
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
    getReportCategoryCatalog: vi.fn(async () => [] as any[]),
    getReportGlyphStyle: vi.fn(async () => ({ mode: 'clean' as const, overrides: {} })),
    setReportGlyphStyle: vi.fn(async () => {}),
    getSubcategoryDisplay: vi.fn(async () => 'rollup' as const),
    setSubcategoryDisplay: vi.fn(async () => {}),
    getCompanionVersion: vi.fn(async () => null),
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
  // Categories now sit inside one collapsible section per budget group (Needs,
  // Wants, …), mirroring Wealthfolio's own Spending Tracker. Expand whatever
  // groups this test's catalog produced — their names vary by fixture, so this
  // opens every still-collapsed disclosure inside the panel rather than naming
  // them.
  for (let pass = 0; pass < 3; pass++) {
    const collapsed = document.querySelectorAll<HTMLElement>(
      '.sfin-disclosure[aria-expanded="false"]',
    );
    if (collapsed.length === 0) break;
    collapsed.forEach((el) => fireEvent.click(el));
  }
}

describe('SyncPage', () => {

  /** Catalog entries for the selector. `hasBudget: false, hasSpend: false` is the
   *  case the old name-array publisher could not express: a category the user can
   *  choose to report on even though nothing has touched it yet. */
  const catalog = (...names: string[]) =>
    names.map((name) => ({
      name, parent: null, icon: null, color: null, hasBudget: false, hasSpend: false,
    }));


  it('groups categories the way Wealthfolio does, one collapsible section per budget group', async () => {
    const props = makeProps();
    props.store.getReportCategoryCatalog = vi.fn(async () => ([
      { name: 'Housing', parent: null, icon: 'Home', color: null, hasBudget: true, hasSpend: true,
        group: 'Needs', groupIcon: 'Home', groupSort: 1 },
      { name: 'Entertainment', parent: null, icon: 'Film', color: null, hasBudget: false, hasSpend: true,
        group: 'Wants', groupIcon: 'Tag', groupSort: 2 },
      // Wealthfolio permits an unassigned category, so it must land somewhere
      // rather than disappearing from the selector.
      { name: 'Orphan', parent: null, icon: null, color: null, hasBudget: false, hasSpend: false,
        group: null, groupIcon: null, groupSort: null },
    ] as any));
    render(<SyncPage {...props} />);
    await openSection(/^Telegram Notifications/i);
    await openSection(/^Report categories/i);

    // Group headers exist and are collapsed until asked for — the point of the
    // change, since a flat list of every category was the complaint.
    const needs = await screen.findByRole('button', { name: /^Needs/ });
    expect(needs.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Housing — Daily')).toBeNull();

    fireEvent.click(needs);
    expect(await screen.findByLabelText('Housing — Daily')).toBeTruthy();
    // Opening Needs does not reveal another group's categories.
    expect(screen.queryByLabelText('Entertainment — Daily')).toBeNull();

    await screen.findByRole('button', { name: /^Wants/ });
    await screen.findByRole('button', { name: /^Ungrouped/ });
  });

  it('orders groups by Wealthfolio own sort order, not alphabetically', async () => {
    const props = makeProps();
    props.store.getReportCategoryCatalog = vi.fn(async () => ([
      { name: 'Zebra', parent: null, icon: null, color: null, hasBudget: true, hasSpend: false,
        group: 'Needs', groupIcon: null, groupSort: 1 },
      { name: 'Apple', parent: null, icon: null, color: null, hasBudget: true, hasSpend: false,
        group: 'Wants', groupIcon: null, groupSort: 2 },
    ] as any));
    render(<SyncPage {...props} />);
    await openSection(/^Telegram Notifications/i);
    await openSection(/^Report categories/i);
    const html = document.body.innerHTML;
    // Needs before Wants because sort_order says so, even though W < N is false
    // alphabetically — the ordering has to be Wealthfolio's, not ours.
    expect(html.indexOf('Needs')).toBeLessThan(html.indexOf('Wants'));
  });

  it('lists a category with no budget and no spending, which the old name list could not', async () => {
    // The live gap: "Personal Care" existed in Wealthfolio but could not be
    // selected, because the published list was budget-or-spend only.
    const props = makeProps();
    props.store.getReportCategoryCatalog = vi.fn(async () => ([
      { name: 'Transportation', parent: null, icon: 'Car', color: '#24837B', hasBudget: true, hasSpend: true },
      { name: 'Personal Care', parent: null, icon: 'Sparkles', color: '#B0552E', hasBudget: false, hasSpend: false },
    ] as any));
    render(<SyncPage {...props} />);
    await openReportCategories();
    expect(await screen.findByLabelText('Personal Care — Daily')).toBeTruthy();
  });

  it('offers parents only, because Wealthfolio budgets at the parent level', async () => {
    // Was 'indents a subcategory under its parent'. Wealthfolio's own Spending
    // Tracker has no subcategory budget field, and the reports aggregate children
    // into their parent — so a per-child checkbox controlled nothing a report
    // could act on, while making the list 52 rows long. Subcategory detail moved
    // to the `breakdown` report mode instead.
    const props = makeProps();
    props.store.getReportCategoryCatalog = vi.fn(async () => ([
      { name: 'Transportation', parent: null, icon: 'Car', color: null, hasBudget: true, hasSpend: false },
      { name: 'Gas & Fuel', parent: 'Transportation', icon: 'Fuel', color: null, hasBudget: false, hasSpend: true },
    ] as any));
    render(<SyncPage {...props} />);
    await openReportCategories();
    expect(await screen.findByLabelText('Transportation — Daily')).toBeTruthy();
    expect(screen.queryByLabelText('Gas & Fuel — Daily')).toBeNull();
    // The children still exist in the catalog, and the hint says where they went.
    expect(await screen.findByText(/1 subcategor/i)).toBeTruthy();
  });

  it('shows the emoji override only when Telegram reports actually use emoji', async () => {
    // In clean mode the input's placeholder read as a missing amount, and an
    // override does nothing there — overrides apply in glyphs mode only.
    const props = makeProps();
    props.store.getReportCategoryCatalog = vi.fn(async () => ([
      { name: 'Groceries', parent: null, icon: 'ShoppingCart', color: null, hasBudget: true, hasSpend: true },
    ] as any));
    render(<SyncPage {...props} />);
    await openReportCategories();
    expect(screen.queryByLabelText('Groceries — report emoji')).toBeNull();

    fireEvent.change(await screen.findByLabelText(/telegram report icons/i), {
      target: { value: 'glyphs' },
    });
    const trigger = await screen.findByLabelText('Groceries — report emoji');
    expect(trigger).toBeTruthy();
    // It opens a palette rather than asking the user to type an emoji, which is
    // the whole reason it stopped being a text field.
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByLabelText('🥕'));
    await waitFor(() => expect(props.store.setReportGlyphStyle).toHaveBeenCalledWith(
      { mode: 'glyphs', overrides: { Groceries: '🥕' } },
    ));
  });

  it('positions the emoji panel in viewport coordinates, so clipping ancestors cannot hide it', async () => {
    // The live symptom: clicking the emoji button did nothing visible. The panel
    // WAS rendering — it was clipped out of existence by two ancestors that set
    // `overflow: hidden` for their rounded corners (.sfin-disc-inset and
    // .sfin-card--collapsible). jsdom has no layout, so this asserts the escape
    // hatch rather than the pixels: a fixed-position panel carrying explicit
    // coordinates cannot be clipped by an ancestor's overflow.
    const props = makeProps();
    props.store.getReportGlyphStyle = vi.fn(async () => ({ mode: 'glyphs' as const, overrides: {} }));
    props.store.getReportCategoryCatalog = vi.fn(async () => ([
      { name: 'Groceries', parent: null, icon: 'ShoppingCart', color: null,
        hasBudget: true, hasSpend: true, group: 'Needs', groupIcon: 'Home', groupSort: 1 },
    ] as any));
    render(<SyncPage {...props} />);
    await openReportCategories();

    fireEvent.click(await screen.findByLabelText('Groceries — report emoji'));
    const panel = await screen.findByRole('dialog', { name: 'Groceries — report emoji' });
    // jsdom does not compute class-based CSS, so the assertion is on what the
    // component controls: the class that carries `position: fixed`, and the inline
    // coordinates it derives from the button's rect. Together those are the escape
    // from ancestor clipping; neither alone would be.
    expect(panel.className).toContain('sfin-glyph-pop');
    expect(panel.style.top).not.toBe('');
    expect(panel.style.left).not.toBe('');
  });

  it('stays open while the emoji panel itself is scrolled', async () => {
    // The scroll listener is CAPTURING (page scroll must close the panel, since
    // its coordinates are fixed and would drift from the button). That also made
    // it see the panel's own scroll, so the picker closed the moment the user
    // scrolled to reach an emoji further down — including by dragging its
    // scrollbar. Scrolls from inside the panel are not the page moving.
    const props = makeProps();
    props.store.getReportGlyphStyle = vi.fn(async () => ({ mode: 'glyphs' as const, overrides: {} }));
    props.store.getReportCategoryCatalog = vi.fn(async () => ([
      { name: 'Groceries', parent: null, icon: 'ShoppingCart', color: null,
        hasBudget: true, hasSpend: true, group: 'Needs', groupIcon: 'Home', groupSort: 1 },
    ] as any));
    render(<SyncPage {...props} />);
    await openReportCategories();
    fireEvent.click(await screen.findByLabelText('Groceries — report emoji'));

    const panel = await screen.findByRole('dialog', { name: 'Groceries — report emoji' });
    fireEvent.scroll(panel);
    expect(screen.queryByRole('dialog', { name: 'Groceries — report emoji' })).toBeTruthy();

    // A scroll anywhere else still closes it: the button has moved under it.
    fireEvent.scroll(document.body);
    await waitFor(() => expect(
      screen.queryByRole('dialog', { name: 'Groceries — report emoji' }),
    ).toBeNull());
  });

  it('clears an override back to the category default', async () => {
    const props = makeProps();
    props.store.getReportGlyphStyle = vi.fn(async () => ({
      mode: 'glyphs' as const, overrides: { Groceries: '🥕' },
    }));
    props.store.getReportCategoryCatalog = vi.fn(async () => ([
      { name: 'Groceries', parent: null, icon: 'ShoppingCart', color: null, hasBudget: true, hasSpend: true },
    ] as any));
    render(<SyncPage {...props} />);
    await openReportCategories();
    fireEvent.click(await screen.findByLabelText('Groceries — report emoji'));
    fireEvent.click(await screen.findByText(/^Default/));
    await waitFor(() => expect(props.store.setReportGlyphStyle).toHaveBeenCalledWith(
      { mode: 'glyphs', overrides: {} },
    ));
  });

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
    props.store.getReportCategoryCatalog = vi.fn(async () => catalog('Dining', 'Groceries'));
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
    props.store.getReportCategoryCatalog = vi.fn(async () => []);
    render(<SyncPage {...props} />);
    await openReportCategories();
    await screen.findByText(/categories will appear here/i);
  });

  it('saves the selected daily/weekly category lists in Telegram config', async () => {
    const props = makeProps();
    props.store.getReportCategoryCatalog = vi.fn(async () => catalog('Dining', 'Groceries'));
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
    props.store.getReportCategoryCatalog = vi.fn(async () => catalog('Dining'));
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
    props.store.getReportCategoryCatalog = vi.fn(async () => catalog('Dining', 'Groceries', 'Travel'));
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
    props.store.getReportCategoryCatalog = vi.fn(async () => catalog('Groceries', 'Dining'));
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
    props.store.getReportCategoryCatalog = vi.fn(async () => catalog('Groceries', 'Dining'));
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

  // ── Pruned duplicates ──────────────────────────────────────────────────
  it('reports the duplicate rows a reconcile deleted, with what each one was', async () => {
    // Automatic deletion of financial records must not be silent, and Telegram
    // is optional — so the page itself has to say what vanished.
    vi.mocked(runSync).mockResolvedValueOnce({
      imported: 0, skipped: 2, errors: [],
      prunedDuplicates: [
        { sfinAccountId: 'sfin-1', accountName: 'Savings', txId: 'TRN-3917f117',
          description: 'PNC BANK 1234 Transfer', date: '2026-07-27', amountCents: 130000,
          currency: 'USD', wfId: 'act-2' },
        { sfinAccountId: 'sfin-1', accountName: 'Savings', txId: 'TRN-ce426394',
          description: 'Monthly Interest Paid', date: '2026-06-30', amountCents: 250,
          currency: 'USD', wfId: 'act-4' },
      ],
    } as any);
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => screen.getByRole('button', { name: /reconcile & link/i }));
    fireEvent.click(screen.getByRole('button', { name: /reconcile & link/i }));

    const banner = await screen.findByText(/Removed 2 duplicate activities/i);
    const box = banner.closest('.sfin-banner-warn')!;
    expect(box.textContent).toContain('$1,300.00');
    expect(box.textContent).toContain('PNC BANK 1234 Transfer');
    expect(box.textContent).toContain('2026-07-27');
    expect(box.textContent).toContain('$2.50');
    expect(box.textContent).toContain('Monthly Interest Paid');
    expect(box.textContent).toContain('Savings');
  });

  it('says nothing about duplicates when a sync pruned none', async () => {
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => screen.getByRole('button', { name: /sync now/i }));
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(screen.getByText(/5 transactions/i)).toBeInTheDocument());
    expect(screen.queryByText(/duplicate activit/i)).not.toBeInTheDocument();
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
    // All three reports default to on for a config that predates them.
    expect(screen.getByText('Connected \u00b7 daily, weekly, monthly reports')).toBeInTheDocument();
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

  // ── Settings that shipped without UI ───────────────────────────────────
  /** Opens the Telegram card and returns the Save button, which commits every
   *  field in it. */
  async function openTelegram() {
    await openSection(/^Telegram Notifications/i);
    return screen.getByText('Save Telegram Settings');
  }

  const savedConfig = (props: ReturnType<typeof makeProps>) =>
    (props.store.setTelegramConfig as any).mock.calls[0][0];

  /** A config that exists but predates all five fields. */
  const bareConfig = () => ({ botToken: 't', chatId: 'c', enabled: true });

  it('offers the monthly wrap-up, defaulting to on when the stored config predates it', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => bareConfig());
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    const save = await openTelegram();
    const monthly = screen.getByLabelText(/Monthly Wrap-Up/i) as HTMLInputElement;
    // Absent means ON, like its daily/weekly siblings.
    expect(monthly.checked).toBe(true);
    fireEvent.click(save);
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).monthlyReportEnabled).toBe(true);

    // Unticking has to store an explicit false — the only value the companion
    // treats as "don't send this".
    props.store.setTelegramConfig = vi.fn(async () => {});
    fireEvent.click(monthly);
    fireEvent.click(save);
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).monthlyReportEnabled).toBe(false);
  });

  it('round-trips an explicitly disabled monthly report', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => ({ ...bareConfig(), monthlyReportEnabled: false }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    const save = await openTelegram();
    const monthly = screen.getByLabelText(/Monthly Wrap-Up/i) as HTMLInputElement;
    expect(monthly.checked).toBe(false);
    fireEvent.click(monthly);
    fireEvent.click(save);
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).monthlyReportEnabled).toBe(true);
  });

  it('adds a Monthly column to the category matrix without disturbing Daily or Weekly', async () => {
    const props = makeProps();
    props.store.getReportCategoryCatalog = vi.fn(async () => catalog('Dining', 'Groceries'));
    props.store.getTelegramConfig = vi.fn(async () => ({
      ...bareConfig(), monthlyReportCategories: ['Groceries'],
    }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await openReportCategories();
    await screen.findByText('Dining');
    // The pre-existing Daily/Weekly labels still resolve, and still default to all.
    expect((screen.getByLabelText(/Dining.*Daily/i) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Dining.*Weekly/i) as HTMLInputElement).checked).toBe(true);
    // Monthly reads its own saved subset.
    expect((screen.getByLabelText(/Dining.*Monthly/i) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText(/Groceries.*Monthly/i) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByLabelText(/Dining.*Monthly/i)); // now covers everything
    fireEvent.click(screen.getByText('Save Telegram Settings'));
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    const saved = savedConfig(props);
    expect(saved.monthlyReportCategories).toBe('all');
    expect(saved.dailyReportCategories).toBe('all');
    expect(saved.weeklyReportCategories).toBe('all');
  });

  it('gives the biggest-spends row the same checkbox its two siblings have', async () => {
    // Three sibling rows in ALERTS & AMOUNTS where one lacked the control its
    // neighbours had. `0` being a meaningful value made that defensible, but a
    // missing control reads as a defect regardless of the logic behind it.
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => bareConfig());
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    const save = await openTelegram();
    const toggle = screen.getByLabelText(/Biggest spends in the weekly report/i) as HTMLInputElement;
    const count = screen.getByLabelText(/how many biggest spends/i) as HTMLInputElement;
    expect(toggle.type).toBe('checkbox');
    // Absent → ON at the default of 5, which is what the companion already did.
    expect(toggle.checked).toBe(true);
    expect(count.disabled).toBe(false);
    expect(count.value).toBe('5');

    fireEvent.click(save);
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).weeklyTopSpendCount).toBe(5);
  });

  it('unticking biggest spends stores 0 rather than omitting the field', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => bareConfig());
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    const save = await openTelegram();
    const toggle = screen.getByLabelText(/Biggest spends in the weekly report/i) as HTMLInputElement;

    fireEvent.click(toggle);
    expect((screen.getByLabelText(/how many biggest spends/i) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(save);
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    const saved = savedConfig(props);
    expect(saved.weeklyTopSpendCount).toBe(0);
    // Never simply omitted: absent reads as ON at the default of 5, so omitting
    // it would hand back the section the user just switched off.
    expect('weeklyTopSpendCount' in saved).toBe(true);
  });

  it('a stored 0 reloads as unticked, not as the default', async () => {
    // The other half of the round trip, and the reason the collapse of "unticked"
    // onto "0" is safe: unticking, saving and reloading must not come back ticked.
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => ({ ...bareConfig(), weeklyTopSpendCount: 0 }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    const save = await openTelegram();
    expect((screen.getByLabelText(/Biggest spends in the weekly report/i) as HTMLInputElement).checked)
      .toBe(false);
    // The count keeps its default rather than showing the stored 0, exactly as
    // the drift row does: 0 is the checkbox's business, not the number field's.
    const count = screen.getByLabelText(/how many biggest spends/i) as HTMLInputElement;
    expect(count.value).toBe('5');
    expect(count.disabled).toBe(true);

    // ...and re-saving that reloaded state stores 0 again — a fixed point, not a
    // value that drifts back to 5 the moment the page is revisited.
    fireEvent.click(save);
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).weeklyTopSpendCount).toBe(0);
  });

  it('stores the weekly top-spend count, treating 0 as "hide" and blank as the default', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => ({ ...bareConfig(), weeklyTopSpendCount: 3 }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    const save = await openTelegram();
    // Queried by the number field's own accessible name: the visible row label
    // now belongs to the checkbox beside it, matching the two sibling rows.
    const field = screen.getByLabelText(/how many biggest spends/i) as HTMLInputElement;
    expect(field.value).toBe('3');

    // 0 is a value the user can mean, so it must survive as 0.
    fireEvent.change(field, { target: { value: '0' } });
    fireEvent.click(save);
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).weeklyTopSpendCount).toBe(0);

    // Blank is not 0 — it means "I have no opinion", i.e. the default of 5.
    props.store.setTelegramConfig = vi.fn(async () => {});
    fireEvent.change(field, { target: { value: '' } });
    fireEvent.click(save);
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).weeklyTopSpendCount).toBe(5);
  });

  it('large-transaction alerts: absent reads as off, and off stores 0 rather than a number', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => bareConfig());
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    const save = await openTelegram();
    const toggle = screen.getByLabelText(/Large transaction alerts/i) as HTMLInputElement;
    const amount = screen.getByLabelText(/Large transaction alert threshold/i) as HTMLInputElement;
    // Absent → OFF, and the amount is a disabled suggestion, not a stored value.
    expect(toggle.checked).toBe(false);
    expect(amount.disabled).toBe(true);

    fireEvent.click(save);
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).largeTransactionThreshold).toBe(0);
  });

  it('large-transaction alerts: on with an amount stores that amount, and reloads showing it', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => ({ ...bareConfig(), largeTransactionThreshold: 750 }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    const save = await openTelegram();
    const toggle = screen.getByLabelText(/Large transaction alerts/i) as HTMLInputElement;
    const amount = screen.getByLabelText(/Large transaction alert threshold/i) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(amount.disabled).toBe(false);
    expect(amount.value).toBe('750');

    fireEvent.change(amount, { target: { value: '250' } });
    fireEvent.click(save);
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).largeTransactionThreshold).toBe(250);
  });

  it('drift alerts: absent reads as ON at the $100 default, and stores it explicitly', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => bareConfig());
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    const save = await openTelegram();
    const toggle = screen.getByLabelText(/Balance drift alerts/i) as HTMLInputElement;
    const amount = screen.getByLabelText(/Balance drift alert threshold/i) as HTMLInputElement;
    // The opposite default to large-tx, from the same "absent" state.
    expect(toggle.checked).toBe(true);
    expect(amount.value).toBe('100');

    fireEvent.click(save);
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).driftAlertThreshold).toBe(100);
  });

  it('drift alerts: unticking really turns them off, storing 0 rather than the default', async () => {
    // The trap this guards: absent ALSO means "on at 100", so a UI that
    // expressed off by clearing the number would hand the $100 default straight
    // back and the user could never switch drift alerts off at all.
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => bareConfig());
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    const save = await openTelegram();
    const toggle = screen.getByLabelText(/Balance drift alerts/i) as HTMLInputElement;
    const amount = screen.getByLabelText(/Balance drift alert threshold/i) as HTMLInputElement;

    fireEvent.click(toggle);
    expect(amount.disabled).toBe(true);
    fireEvent.click(save);
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    const saved = savedConfig(props);
    expect(saved.driftAlertThreshold).toBe(0);
    // "Off" and "default" must be distinguishable in what gets stored, and the
    // field must never be simply omitted (absent would read as ON at 100).
    expect(saved.driftAlertThreshold).not.toBe(100);
    expect('driftAlertThreshold' in saved).toBe(true);
  });

  it('drift alerts: a stored 0 reloads as off, not as the default', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => ({ ...bareConfig(), driftAlertThreshold: 0 }));
    render(<SyncPage {...props} />);
    await openTelegram();
    expect((screen.getByLabelText(/Balance drift alerts/i) as HTMLInputElement).checked).toBe(false);
    // Surfaced on the collapsed header too, since it is a non-default state.
    expect(screen.getByText(/drift alerts off/)).toBeInTheDocument();
  });

  it('clearing an enabled threshold falls back to its default instead of storing a contradictory 0', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => ({
      ...bareConfig(), largeTransactionThreshold: 750, driftAlertThreshold: 250,
    }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    const save = await openTelegram();
    fireEvent.change(screen.getByLabelText(/Large transaction alert threshold/i), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/Balance drift alert threshold/i), { target: { value: '' } });
    fireEvent.click(save);
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    const saved = savedConfig(props);
    // Both boxes are still ticked, so storing 0 (= off) would contradict the UI.
    expect(saved.largeTransactionThreshold).toBe(500);
    expect(saved.driftAlertThreshold).toBe(100);
  });

  // ── The sync error path ────────────────────────────────────────────────
  it('shows the classified sync error and keeps the raw text as a collapsed detail', async () => {
    // What the user actually saw was the broker's raw rejection, URL and query
    // params included. The friendly line goes in the box; the raw text stays
    // reachable, because the last few days of debugging depended on it.
    const raw = 'error sending request for url (https://beta-bridge.simplefin.org/simplefin/accounts?start-date=1777688539&pending=1)';
    const err: any = new Error("Couldn't reach SimpleFin — usually temporary");
    err.detail = raw;
    vi.mocked(runSync).mockRejectedValueOnce(err);

    render(<SyncPage {...makeProps()} />);
    await waitFor(() => screen.getByRole('button', { name: /sync now/i }));
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));

    const box = (await screen.findByText(/Couldn't reach SimpleFin/)).closest('.sfin-error')!;
    // The URL is NOT the headline...
    expect(box.querySelector('details')).not.toBeNull();
    // ...but it is still on the page, and still copyable.
    expect(box.querySelector('details')!.textContent).toContain(raw);
  });

  it('renders an error with no underlying detail exactly as before', async () => {
    // Every other error in the app is a plain Error. It must not grow an empty
    // "Technical details" disclosure that reveals nothing.
    vi.mocked(runSync).mockRejectedValueOnce(new Error('Not configured: no account mapping'));
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => screen.getByRole('button', { name: /sync now/i }));
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));

    const box = (await screen.findByText(/no account mapping/)).closest('.sfin-error')!;
    expect(box.querySelector('details')).toBeNull();
    expect(box.getAttribute('title')).toBeNull();
  });

  it('refreshes the displayed last-synced time when a sync reports the interval skip', async () => {
    // Both statements read the same `last_sync_at`, so "Last synced 4 hours ago"
    // beside "Last sync was under an hour ago, so Sync Now was skipped" cannot
    // both be current: the page loaded a value and the COMPANION then synced.
    // The skip is the moment we learn our copy is stale.
    const props = makeProps();
    const stale = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const fresh = new Date(Date.now() - 10 * 60 * 1000);
    props.store.getLastSyncAt = vi.fn()
      .mockResolvedValueOnce(stale)   // initial page load
      .mockResolvedValue(fresh);      // what the companion has since written
    vi.mocked(runSync).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [INTERVAL_SKIP_MESSAGE],
    } as any);

    render(<SyncPage {...props} />);
    await waitFor(() => expect(screen.getByText(/Last synced 4 hours ago/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));

    await waitFor(() => expect(screen.getByText(/so Sync Now was skipped/)).toBeInTheDocument());
    // The two statements now agree.
    expect(screen.getByText(/Last synced 10 minutes ago/)).toBeInTheDocument();
    expect(screen.queryByText(/Last synced 4 hours ago/)).not.toBeInTheDocument();
  });

  it('explains an empty matrix, and that the list is broader than the reports', async () => {
    const props = makeProps();
    props.store.getReportCategoryCatalog = vi.fn(async () => []);
    render(<SyncPage {...props} />);
    await openReportCategories();
    // The hint has to carry the distinction the catalog introduced: everything is
    // selectable here, but a report still only prints budgeted-or-spent ones.
    await screen.findByText(/budget or spending this month/i);
    await screen.findByText(/categories will appear here/i);
  });

  it('composes two successive toggles instead of dropping the first', async () => {
    // Guards the functional-updater conversion: the handler now derives both
    // membership and the next value from `prev` rather than from closed-over
    // state. NOTE this cannot prove the batching case on its own — React
    // flushes each discrete DOM event, so two fireEvent clicks can't share a
    // render snapshot. It pins the composition result the updater must produce.
    const props = makeProps();
    props.store.getReportCategoryCatalog = vi.fn(async () => catalog('Groceries', 'Dining', 'Travel'));
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
