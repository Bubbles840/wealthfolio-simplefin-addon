import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SyncPage } from '../pages/SyncPage';
import { sendTelegramMessage } from '../../shared/telegram';

/**
 * Integration-level, on purpose — and moved here wholesale from
 * SyncPage.test.tsx when the Telegram mega-card became this tab.
 *
 * These still render `<SyncPage/>`: the tab owns its draft but the page owns the
 * store, the open-card map and the catalog, so mounting the tab alone would
 * prove only that props render. What regressed historically was always the whole
 * path from a stored secret, through the controls, back to `setTelegramConfig` —
 * which is exactly what these assert, with the same payload expectations they
 * had before the split.
 */
vi.mock('../utils/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sync')>();
  return {
    INTERVAL_SKIP_MESSAGE: actual.INTERVAL_SKIP_MESSAGE,
    runSync: vi.fn(async () => ({ imported: 5, skipped: 1, errors: [] })),
  };
});

// The one network call this tab can make. Mocked so the status line's tone can be
// driven through every branch — success, refusal, throw, still-in-flight — from
// the real component rather than by calling the tone helper directly.
vi.mock('../../shared/telegram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/telegram')>();
  return { ...actual, sendTelegramMessage: vi.fn(async () => ({ ok: true })) };
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
    getLastSyncImported: vi.fn(async () => null),
    setLastSyncImported: vi.fn(async () => {}),
    // Amazon categorization unconfigured, which is every test here.
    getAmazonConfig: vi.fn(async () => null),
    setAmazonConfig: vi.fn(async () => {}),
    getAmazonLabels: vi.fn(async () => ({})),
    getAmazonMailStatus: vi.fn(async () => null as any),
    getReportGlyphStyle: vi.fn(async () => ({ mode: 'clean' as const, overrides: {} })),
    setReportGlyphStyle: vi.fn(async () => {}),
    getCountOffBudget: vi.fn(async () => true),
    getCapWeeklyToPool: vi.fn(async () => true),
    setCapWeeklyToPool: vi.fn(async () => {}),
    getOverBudgetSpent: vi.fn(async () => 'total'),
    setOverBudgetSpent: vi.fn(async () => {}),
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
  } as any,
  onReset: vi.fn(),
  scheduler: { start: vi.fn(), stop: vi.fn(), isRunning: vi.fn(() => false) } as any,
});

/**
 * The page is a tabbed shell and only the ACTIVE tab is mounted, so reaching
 * anything in this tab means selecting it first — exactly as the user does.
 * Idempotent, like `openSection` below.
 */
async function switchTab(name: RegExp) {
  const tab = await screen.findByRole('tab', { name });
  if (tab.getAttribute('aria-selected') !== 'true') fireEvent.click(tab);
  return tab;
}

/**
 * The config cards ship collapsed, and a collapsed panel is unmounted — so a
 * test that touches a control inside one has to open it first, exactly as the
 * user does. Matches the disclosure header by its accessible name, which is the
 * title plus its summary line, hence the anchored patterns. Idempotent.
 *
 * Switches to the Notifications tab on the way in: every card this file names
 * lives there, and these three helpers are the only route into any of them, so
 * the tab switch belongs here rather than repeated in forty tests.
 */
async function openSection(name: RegExp) {
  await switchTab(/notifications/i);
  const header = await screen.findByRole('button', { name });
  if (header.getAttribute('aria-expanded') !== 'true') fireEvent.click(header);
  return header;
}

/** Which reports get sent, and the alert amounts. */
async function openReports() {
  return openSection(/^Reports/i);
}

/** The category matrix sits behind two disclosures: its own, nested in the
 *  "Report content" card. */
async function openReportCategories() {
  await openSection(/^Report content/i);
  await openSection(/^Report categories/i);
  // Categories sit inside one collapsible section per budget group (Needs,
  // Wants, …), mirroring Wealthfolio's own Spending Tracker. Expand whatever
  // groups this test's catalog produced — their names vary by fixture, so this
  // opens every still-collapsed disclosure inside the panel rather than naming
  // them.
  //
  // Scoped to the panel: querying the whole document also opened every OTHER
  // card on the page, so any card that happened to render a category name — the
  // Amazon one lists them in a dropdown — turned a `findByText('Dining')` here
  // into "found multiple elements". A helper for one panel must not reach
  // outside it.
  const panel = document.querySelector<HTMLElement>('#report-categories-panel')
    ?? document.body;
  for (let pass = 0; pass < 3; pass++) {
    const collapsed = panel.querySelectorAll<HTMLElement>(
      '.sfin-disclosure[aria-expanded="false"]',
    );
    if (collapsed.length === 0) break;
    collapsed.forEach((el) => fireEvent.click(el));
  }
}

/**
 * Commit the draft.
 *
 * The Save button lives in a bar that exists only while what is on screen
 * differs from what is stored — that IS the feature — so committing is: change
 * something, wait for the bar, click Save. It replaces the old
 * "Save Telegram Settings" button at the bottom of the mega-card; every payload
 * assertion below is unchanged from when that button was what got clicked.
 */
async function save() {
  await screen.findByText(/unsaved changes/i);
  fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
}

/** Makes the draft differ from storage WITHOUT touching any field the caller
 *  asserts on, so a test about a DEFAULT value can still reach the save bar.
 *  Deliberately a control in the Reports card, so no second card need be open. */
function nudge() {
  fireEvent.click(screen.getByLabelText(/Transaction Import Alerts/i));
}

describe('NotificationsTab', () => {

  /** Catalog entries for the selector. `hasBudget: false, hasSpend: false` is the
   *  case the old name-array publisher could not express: a category the user can
   *  choose to report on even though nothing has touched it yet. */
  const catalog = (...names: string[]) =>
    names.map((name) => ({
      name, parent: null, icon: null, color: null, hasBudget: false, hasSpend: false,
    }));

  const savedConfig = (props: ReturnType<typeof makeProps>) =>
    (props.store.setTelegramConfig as any).mock.calls[0][0];

  /** A config that exists but predates all five fields. */
  const bareConfig = () => ({ botToken: 't', chatId: 'c', enabled: true });

  // ── The save bar ───────────────────────────────────────────────────────
  it('shows the save bar only when settings differ from stored config', async () => {
    render(<SyncPage {...makeProps()} />);
    await openSection(/^Telegram connection/i);
    expect(screen.queryByText(/unsaved changes/i)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Bot Token/i), { target: { value: 'tok' } });
    expect(await screen.findByText(/unsaved changes/i)).toBeTruthy();
  });

  it('hides the bar again once the change is saved', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => bareConfig());
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await openReports();
    nudge();
    await save();
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    // The bar disappearing IS the confirmation: nothing is pending any more.
    await waitFor(() => expect(screen.queryByText(/unsaved changes/i)).toBeNull());
  });

  it('says in the bar why Save is unavailable, not only in a tooltip', async () => {
    // A fresh install with no credentials can still change a report toggle, and
    // then the bar appears beside a Save that can never be clicked. A `title` on
    // a disabled button is invisible to keyboard and touch users, so the reason
    // is text.
    const props = makeProps();
    render(<SyncPage {...props} />);
    await openReports();
    nudge();
    expect(await screen.findByText(/unsaved changes/i)).toBeTruthy();
    expect(screen.getByText(/add a bot token and chat id first/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Save$/ }) as HTMLButtonElement).disabled)
      .toBe(true);
  });

  it('keeps the save bar live region mounted while there is nothing to say', async () => {
    // A role="status" inserted into the DOM already populated is announced
    // unreliably or not at all: the region has to exist BEFORE its content
    // changes. So the wrapper stays, empty, and only the message appears.
    render(<SyncPage {...makeProps()} />);
    await openReports();
    const region = document.querySelector('.sfin-savebar-msg[role="status"]');
    expect(region).toBeTruthy();
    expect(region!.textContent).toBe('');
    expect(screen.queryByText(/unsaved changes/i)).toBeNull();

    nudge();
    await waitFor(() => expect(region!.textContent).toMatch(/unsaved changes/i));
  });

  it('lets a token be tested before it is ever saved', async () => {
    // Otherwise the only way to find out a pasted token is wrong would be to
    // store the wrong one first.
    const props = makeProps();
    render(<SyncPage {...props} />);
    await openSection(/^Telegram connection/i);
    const send = screen.getByRole('button', { name: /send test message/i }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Bot Token/i), { target: { value: 'tok' } });
    fireEvent.change(screen.getByLabelText(/Chat ID/i), { target: { value: '42' } });
    expect(send.disabled).toBe(false);
    expect(props.store.setTelegramConfig).not.toHaveBeenCalled();
  });

  // ── The status line's tone ─────────────────────────────────────────────
  /**
   * The tone used to be recovered by SNIFFING a ✅/❌ prefix off the status
   * message's own text. That made those emoji load-bearing: removing them from
   * the copy — which is exactly what a "no emoji in chrome" pass does — would
   * have downgraded every failed send from destructive red to the neutral "busy"
   * grey, silently. Nothing caught it, because the string is gone, the class is
   * still applied and the page still renders.
   *
   * These drive the REAL components (a producer that forgets to pass a tone is
   * both a type error and a failure here), assert the CLASS rather than the
   * wording, and assert the wording carries no emoji — so the colour and the
   * words can never be re-coupled without one of these failing.
   */
  describe("the credentials status line's tone", () => {
    const EMOJI = /\p{Extended_Pictographic}/u;
    const statusLine = () =>
      document.querySelector('.sfin-status[role="status"]') as HTMLElement;

    /** Open the connection card with a token and chat id typed in, which is what
     *  enables Send test message. */
    async function readyToSend() {
      const props = makeProps();
      render(<SyncPage {...props} />);
      await openSection(/^Telegram connection/i);
      fireEvent.change(await screen.findByLabelText(/Bot token/i), { target: { value: 'tok' } });
      fireEvent.change(screen.getByLabelText(/Chat ID/i), { target: { value: '42' } });
      return props;
    }

    const send = () =>
      fireEvent.click(screen.getByRole('button', { name: /send test message/i }));

    it('paints a refused send as an error', async () => {
      vi.mocked(sendTelegramMessage).mockResolvedValueOnce({
        ok: false, description: 'chat not found',
      } as any);
      await readyToSend();
      send();

      await waitFor(() => expect(statusLine()).toBeTruthy());
      await waitFor(() => expect(statusLine().className).toContain('sfin-status--err'));
      expect(statusLine().className).not.toContain('sfin-status--ok');
      expect(statusLine().className).not.toContain('sfin-status--busy');
      // The reason survives, and it does so without an emoji carrying the colour.
      expect(statusLine().textContent).toContain('chat not found');
      expect(statusLine().textContent).not.toMatch(EMOJI);
    });

    it('paints a send that threw as an error', async () => {
      vi.mocked(sendTelegramMessage).mockRejectedValueOnce(new Error('network down'));
      await readyToSend();
      send();

      await waitFor(() => expect(statusLine()?.className).toContain('sfin-status--err'));
      expect(statusLine().textContent).toContain('network down');
      expect(statusLine().textContent).not.toMatch(EMOJI);
    });

    it('paints a successful send as ok', async () => {
      vi.mocked(sendTelegramMessage).mockResolvedValueOnce({ ok: true } as any);
      await readyToSend();
      send();

      await waitFor(() => expect(statusLine()?.className).toContain('sfin-status--ok'));
      expect(statusLine().className).not.toContain('sfin-status--err');
      expect(statusLine().textContent).not.toMatch(EMOJI);
    });

    it('paints the in-flight message as NEITHER ok nor error', async () => {
      // The whole reason the tone is three-valued: a send that has not finished
      // is not a failure, and the old code only got that right because "Sending…"
      // happened to start with neither prefix.
      let release: (v: any) => void = () => {};
      vi.mocked(sendTelegramMessage).mockImplementationOnce(
        () => new Promise((res) => { release = res; }),
      );
      await readyToSend();
      send();

      await waitFor(() => expect(statusLine()).toBeTruthy());
      expect(statusLine().className).toContain('sfin-status--busy');
      expect(statusLine().className).not.toContain('sfin-status--err');
      expect(statusLine().className).not.toContain('sfin-status--ok');
      expect(statusLine().textContent).not.toMatch(EMOJI);

      // ...and it resolves into a real tone rather than staying grey.
      await act(async () => { release({ ok: true }); });
      await waitFor(() => expect(statusLine().className).toContain('sfin-status--ok'));
    });

    it('paints a saved config as ok', async () => {
      // The other producer on this channel: the save bar reports through the same
      // status line, so it has to pass a tone too.
      await readyToSend();
      fireEvent.click(await screen.findByRole('button', { name: /^Save$/ }));

      await waitFor(() => expect(statusLine()?.className).toContain('sfin-status--ok'));
      expect(statusLine().className).not.toContain('sfin-status--err');
      expect(statusLine().textContent).toMatch(/saved/i);
      expect(statusLine().textContent).not.toMatch(EMOJI);
    });
  });

  // ── The category matrix ────────────────────────────────────────────────
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
    await openSection(/^Report content/i);
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
    await openSection(/^Report content/i);
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
    await save();
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
    await save();
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
    await save();
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    const saved = savedConfig(props);
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
    await save();
    await waitFor(() => {
      expect(props.store.setTelegramConfig).toHaveBeenCalledWith(
        expect.objectContaining({ dailyReportCategories: 'all' }),
      );
    });
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
    // Guards the functional-updater conversion: the handler derives both
    // membership and the next value from `prev` rather than from closed-over
    // state — which is why `onChange` accepts a function of the previous draft.
    // NOTE this cannot prove the batching case on its own — React flushes each
    // discrete DOM event, so two fireEvent clicks can't share a render snapshot.
    // It pins the composition result the updater must produce.
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
    await save();
    await waitFor(() => {
      expect(props.store.setTelegramConfig).toHaveBeenCalledWith(
        expect.objectContaining({ dailyReportCategories: ['Travel'] }),
      );
    });
  });

  // ── Emoji styling ──────────────────────────────────────────────────────
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

  it('keeps the icon style out of the save bar, because it is stored the moment it changes', async () => {
    // Glyph style and subcategory display are their own secrets, written on
    // change — so offering to "save" them would be offering to save what is
    // already saved.
    const props = makeProps();
    props.store.getReportCategoryCatalog = vi.fn(async () => catalog('Groceries'));
    render(<SyncPage {...props} />);
    await openReportCategories();
    fireEvent.change(await screen.findByLabelText(/telegram report icons/i), {
      target: { value: 'glyphs' },
    });
    await waitFor(() => expect(props.store.setReportGlyphStyle).toHaveBeenCalled());
    expect(screen.queryByText(/unsaved changes/i)).toBeNull();
    // ...and the card says so, because the seam falls inside a matrix row: the
    // emoji button is immediate, the three checkboxes beside it are not.
    expect(screen.getByText(/no need to save/i)).toBeTruthy();
    expect(await screen.findByText(/emoji choices apply immediately/i)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/subcategories/i), { target: { value: 'breakdown' } });
    await waitFor(() => expect(props.store.setSubcategoryDisplay).toHaveBeenCalledWith('breakdown'));
    expect(screen.queryByText(/unsaved changes/i)).toBeNull();
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

  // ── Settings that shipped without UI ───────────────────────────────────
  it('offers the monthly wrap-up, defaulting to on when the stored config predates it', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => bareConfig());
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await openReports();
    const monthly = screen.getByLabelText(/Monthly Wrap-Up/i) as HTMLInputElement;
    // Absent means ON, like its daily/weekly siblings.
    expect(monthly.checked).toBe(true);
    nudge();
    await save();
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).monthlyReportEnabled).toBe(true);

    // Unticking has to store an explicit false — the only value the companion
    // treats as "don't send this".
    props.store.setTelegramConfig = vi.fn(async () => {});
    fireEvent.click(monthly);
    await save();
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).monthlyReportEnabled).toBe(false);
  });

  it('round-trips an explicitly disabled monthly report', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => ({ ...bareConfig(), monthlyReportEnabled: false }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await openReports();
    const monthly = screen.getByLabelText(/Monthly Wrap-Up/i) as HTMLInputElement;
    expect(monthly.checked).toBe(false);
    fireEvent.click(monthly);
    await save();
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
    await save();
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
    await openReports();
    const toggle = screen.getByLabelText(/Biggest spends in the weekly report/i) as HTMLInputElement;
    const count = screen.getByLabelText(/how many biggest spends/i) as HTMLInputElement;
    expect(toggle.type).toBe('checkbox');
    // Absent → ON at the default of 5, which is what the companion already did.
    expect(toggle.checked).toBe(true);
    expect(count.disabled).toBe(false);
    expect(count.value).toBe('5');

    nudge();
    await save();
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).weeklyTopSpendCount).toBe(5);
  });

  it('unticking biggest spends stores 0 rather than omitting the field', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => bareConfig());
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await openReports();
    const toggle = screen.getByLabelText(/Biggest spends in the weekly report/i) as HTMLInputElement;

    fireEvent.click(toggle);
    expect((screen.getByLabelText(/how many biggest spends/i) as HTMLInputElement).disabled).toBe(true);
    await save();
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
    await openReports();
    expect((screen.getByLabelText(/Biggest spends in the weekly report/i) as HTMLInputElement).checked)
      .toBe(false);
    // The count keeps its default rather than showing the stored 0, exactly as
    // the drift row does: 0 is the checkbox's business, not the number field's.
    const count = screen.getByLabelText(/how many biggest spends/i) as HTMLInputElement;
    expect(count.value).toBe('5');
    expect(count.disabled).toBe(true);

    // ...and re-saving that reloaded state stores 0 again — a fixed point, not a
    // value that drifts back to 5 the moment the page is revisited.
    nudge();
    await save();
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).weeklyTopSpendCount).toBe(0);
  });

  it('stores the weekly top-spend count, treating 0 as "hide" and blank as the default', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => ({ ...bareConfig(), weeklyTopSpendCount: 3 }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await openReports();
    // Queried by the number field's own accessible name: the visible row label
    // belongs to the checkbox beside it, matching the two sibling rows.
    const field = screen.getByLabelText(/how many biggest spends/i) as HTMLInputElement;
    expect(field.value).toBe('3');

    // 0 is a value the user can mean, so it must survive as 0.
    fireEvent.change(field, { target: { value: '0' } });
    await save();
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).weeklyTopSpendCount).toBe(0);

    // Blank is not 0 — it means "I have no opinion", i.e. the default of 5.
    props.store.setTelegramConfig = vi.fn(async () => {});
    fireEvent.change(field, { target: { value: '' } });
    await save();
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).weeklyTopSpendCount).toBe(5);
  });

  it('large-transaction alerts: absent reads as off, and off stores 0 rather than a number', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => bareConfig());
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await openReports();
    const toggle = screen.getByLabelText(/Large transaction alerts/i) as HTMLInputElement;
    const amount = screen.getByLabelText(/Large transaction alert threshold/i) as HTMLInputElement;
    // Absent → OFF, and the amount is a disabled suggestion, not a stored value.
    expect(toggle.checked).toBe(false);
    expect(amount.disabled).toBe(true);

    nudge();
    await save();
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).largeTransactionThreshold).toBe(0);
  });

  it('large-transaction alerts: on with an amount stores that amount, and reloads showing it', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => ({ ...bareConfig(), largeTransactionThreshold: 750 }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await openReports();
    const toggle = screen.getByLabelText(/Large transaction alerts/i) as HTMLInputElement;
    const amount = screen.getByLabelText(/Large transaction alert threshold/i) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(amount.disabled).toBe(false);
    expect(amount.value).toBe('750');

    fireEvent.change(amount, { target: { value: '250' } });
    await save();
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    expect(savedConfig(props).largeTransactionThreshold).toBe(250);
  });

  it('drift alerts: absent reads as ON at the $100 default, and stores it explicitly', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => bareConfig());
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await openReports();
    const toggle = screen.getByLabelText(/Balance difference alerts/i) as HTMLInputElement;
    const amount = screen.getByLabelText(/Balance difference alert threshold/i) as HTMLInputElement;
    // The opposite default to large-tx, from the same "absent" state.
    expect(toggle.checked).toBe(true);
    expect(amount.value).toBe('100');

    nudge();
    await save();
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
    await openReports();
    const toggle = screen.getByLabelText(/Balance difference alerts/i) as HTMLInputElement;
    const amount = screen.getByLabelText(/Balance difference alert threshold/i) as HTMLInputElement;

    fireEvent.click(toggle);
    expect(amount.disabled).toBe(true);
    await save();
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
    await openReports();
    expect((screen.getByLabelText(/Balance difference alerts/i) as HTMLInputElement).checked).toBe(false);
    // Surfaced on the collapsed header too, since it is a non-default state.
    expect(screen.getByText(/balance alerts off/)).toBeInTheDocument();
  });

  it('clearing an enabled threshold falls back to its default instead of storing a contradictory 0', async () => {
    const props = makeProps();
    props.store.getTelegramConfig = vi.fn(async () => ({
      ...bareConfig(), largeTransactionThreshold: 750, driftAlertThreshold: 250,
    }));
    props.store.setTelegramConfig = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await openReports();
    fireEvent.change(screen.getByLabelText(/Large transaction alert threshold/i), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/Balance difference alert threshold/i), { target: { value: '' } });
    await save();
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());
    const saved = savedConfig(props);
    // Both boxes are still ticked, so storing 0 (= off) would contradict the UI.
    expect(saved.largeTransactionThreshold).toBe(500);
    expect(saved.driftAlertThreshold).toBe(100);
  });

});
