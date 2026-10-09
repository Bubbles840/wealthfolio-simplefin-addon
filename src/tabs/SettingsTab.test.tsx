import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SyncPage } from '../pages/SyncPage';

/**
 * Integration-level, on purpose — moved here wholesale from SyncPage.test.tsx
 * when the Auto-sync/Docker/Amazon/Transaction-rules cards and the Reset flow
 * became this tab.
 *
 * These still render `<SyncPage/>`: the tab owns none of its data loading
 * independent of the page's open-card map and category catalog, so mounting
 * the tab alone would prove only that props render. What regressed
 * historically was always the whole path from a stored secret through the
 * controls and back — which is exactly what these assert, unchanged from
 * before the split.
 */
vi.mock('../utils/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sync')>();
  return {
    INTERVAL_SKIP_MESSAGE: actual.INTERVAL_SKIP_MESSAGE,
    runSync: vi.fn(async () => ({ imported: 5, skipped: 1, errors: [] })),
  };
});

/** The Accounts card re-reads the live account list from the bridge. Mocked at
 *  the module boundary so the tests exercise the card's own logic (fetch →
 *  mapper → save) without a network call. */
vi.mock('../utils/simplefin', () => ({
  fetchAccounts: vi.fn(async () => ({
    errors: [],
    accounts: [
      { id: 'sfin-1', name: 'Growth', currency: 'USD', balance: '10.00', 'balance-date': 1700000000 },
      { id: 'sfin-2', name: 'Spend', currency: 'USD', balance: '20.00', 'balance-date': 1700000000 },
      // The newly-linked account: present at SimpleFin, absent from the mapping.
      { id: 'sfin-new', name: 'Robinhood Gold Card', currency: 'USD', balance: '-25.00', 'balance-date': 1700000000 },
    ],
  })),
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
    getIgnoredAccounts: vi.fn(async () => [] as string[]),
    setIgnoredAccounts: vi.fn(async () => {}),
    getAccountMapping: vi.fn(async () => ({ 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' })),
    setAccountMapping: vi.fn(async () => {}),
    getUnmappedAccounts: vi.fn(async () => [] as any[]),
    getMappingRules: vi.fn(async () => []),
    setMappingRules: vi.fn(async () => {}),
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
    // Amazon categorization unconfigured, which is every test here except the
    // Amazon card ones.
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
    // async, like the real SecretsStore method — the page fires it and forgets,
    // so it has to be thenable
    setOpenCards: vi.fn(async () => {}),
    getUiState: vi.fn(async () => ({}) as any),
    setUiState: vi.fn(async () => {}),
    getUncategorizedStatus: vi.fn(async () => null as any),
    getDismissals: vi.fn(async () => ({}) as any),
    setDismissals: vi.fn(async () => {}),
    clearAll: vi.fn(async () => {}),
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

/**
 * The page is a tabbed shell and only the ACTIVE tab is mounted, so reaching
 * anything in this tab means selecting it first — exactly as the user does.
 * Overview is the tab a fresh install lands on. Idempotent, like `openSection`.
 */
async function switchTab(name: RegExp) {
  const tab = await screen.findByRole('tab', { name });
  if (tab.getAttribute('aria-selected') !== 'true') fireEvent.click(tab);
  return tab;
}

/** Settings → Accounts shows the balances on open; the bridge is only asked
 *  for the account list once "Edit mapping" is tapped. */
async function openMapper() {
  await openSection(/^Accounts/i);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit mapping' }));
}

describe('SettingsTab', () => {

  it('changing the interval saves it and restarts the scheduler', async () => {
    const props = makeProps();
    render(<SyncPage {...props} />);
    await switchTab(/settings/i);
    await openSection(/^Auto-sync/i);
    const select = await screen.findByLabelText(/auto-sync interval/i);
    fireEvent.change(select, { target: { value: '12' } });
    await waitFor(() => expect(props.store.setSyncScheduleHours).toHaveBeenCalledWith(12));
    expect(props.scheduler.start).toHaveBeenCalledWith(12, expect.any(Function), expect.any(Function));
  });

  it('offers the same intervals as setup, and still shows an older stored one', async () => {
    // Setup said more than four syncs a day gets no new data while this card
    // offered hourly (1.57 aligns the two).
    const props = makeProps();
    props.store.getSyncScheduleHours = vi.fn(async () => 8);
    render(<SyncPage {...props} />);
    await switchTab(/settings/i);
    await openSection(/^Auto-sync/i);
    const select = await screen.findByLabelText(/auto-sync interval/i);
    const values = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(values).toEqual(['0', '4', '6', '12', '24', '8']);
    await waitFor(() => expect(select).toHaveValue('8'));
  });

  // ── Collapsible config cards ───────────────────────────────────────────
  it('keeps every config card collapsed until asked for', async () => {
    const props = makeProps();
    render(<SyncPage {...props} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /sync now/i })).toBeInTheDocument());

    // Collapsed: the controls inside each config card are absent from the DOM,
    // not merely hidden. Asserted per tab, since a tab the user is not on is
    // unmounted outright — a stronger form of the same guarantee.
    await switchTab(/settings/i);
    expect(screen.queryByLabelText(/auto-sync interval/i)).not.toBeInTheDocument();
    expect(screen.queryByText('+ Add rule')).not.toBeInTheDocument();
    expect(screen.queryByText(/docker-compose\.yml/)).not.toBeInTheDocument();
    for (const name of [/^Auto-sync/i, /^Background sync/i, /^Transaction rules/i]) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-expanded')).toBe('false');
    }

    await switchTab(/settings/i);
    expect(screen.queryByLabelText(/Bot Token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Monthly Wrap-Up/i)).not.toBeInTheDocument();
    // The Telegram card became three, so three headers here rather than one.
    for (const name of [/^Telegram connection/i, /^Reports/i, /^Report content/i]) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('gives the companion everything it needs in the compose snippet, database included', async () => {
    // This snippet IS the setup instruction for most people, and it used to set
    // neither WEALTHFOLIO_DB_PATH nor any mount for the database. Following it
    // exactly produced a companion that synced fine and a "Needs a category" tile
    // that never appeared, with nothing on screen explaining why.
    render(<SyncPage {...makeProps()} />);
    await switchTab(/settings/i);
    await openSection(/^Background sync/i);
    const snippet = (await screen.findByText(/services:/)).textContent!;

    expect(snippet).toContain('WEALTHFOLIO_API_URL');
    expect(snippet).toContain('WEALTHFOLIO_PASSWORD');
    // The variable and a mount that actually satisfies it, agreeing with each
    // other: the path inside the container has to be under the mount point.
    expect(snippet).toContain('WEALTHFOLIO_DB_PATH=/mnt/wealthfolio/wealthfolio.db');
    expect(snippet).toMatch(/volumes:/);
    expect(snippet).toContain(':/mnt/wealthfolio:ro');
    // The DIRECTORY, never the bare .db file: the live read needs the -wal/-shm
    // files beside it, and a file-only mount silently serves whatever was last
    // checkpointed — observed two days stale. See companion/src/sqlite-native.ts.
    expect(snippet).not.toMatch(/wealthfolio\.db:\/mnt/);
  });

  it('gives every collapsible card one disclosure shape: a real button, whole-header hit target, aria-expanded', async () => {
    render(<SyncPage {...makeProps()} />);
    await switchTab(/settings/i);
    const header = await screen.findByRole('button', { name: /^Auto-sync/i });
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

  it('reports each collapsed card’s state in its header summary, so collapsing hides chrome and not state', async () => {
    const props = makeProps();
    props.store.getSyncScheduleHours = vi.fn(async () => 4);
    props.store.getAutoHeal = vi.fn(async () => true);
    props.store.getMappingRules = vi.fn(async () => [
      { pattern: 'PAYROLL', matchType: 'contains', activityType: 'DEPOSIT' },
      { pattern: 'ATM', matchType: 'contains', activityType: 'WITHDRAWAL' },
    ]);
    // Same page, so the Telegram card (NotificationsTab) reports its own
    // summary — asserted here too since the point of this test is that
    // collapsing hides chrome and not state, for every card type. One tab at a
    // time now, so its half is asserted after the switch.
    props.store.getTelegramConfig = vi.fn(async () => ({ botToken: 't', chatId: 'c', enabled: true }));
    render(<SyncPage {...props} />);
    await switchTab(/settings/i);
    await screen.findByText('Every 4h · auto re-scan on');
    expect(screen.getByText('2 rules')).toBeInTheDocument();

    await switchTab(/settings/i);
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('daily, weekly, monthly reports')).toBeInTheDocument();
  });

  it('summarises an off / unconfigured state distinguishably', async () => {
    const props = makeProps();
    props.store.getSyncScheduleHours = vi.fn(async () => null);
    props.store.getAutoAdjust = vi.fn(async () => true);
    render(<SyncPage {...props} />);
    await switchTab(/settings/i);
    // Interval off, but aggressive auto re-scan on — the summary has to say both.
    await screen.findByText('Off · aggressive auto re-scan');
    expect(screen.getByText(/using the \+\/− defaults/)).toBeInTheDocument();
    // No token/chat id in the default mock — same "collapsed still says its
    // state" contract, for the Telegram card.
    await switchTab(/settings/i);
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
  });

  it('sets a CREDIT rule\'s subtype through the real store, and hides the control for a non-CREDIT rule', async () => {
    // Integration, not unit: proves the subtype control reaches
    // `store.setMappingRules` through the tab's own onChange wiring
    // (`AdvancedTab.tsx`'s `RuleEditor` `onChange`), not just component state.
    // Component-level behaviour (options offered, round-trip shape, the
    // absent-for-non-CREDIT case) is covered in `RuleEditor.test.tsx`.
    const props = makeProps();
    props.store.getMappingRules = vi.fn(async () => [
      { pattern: 'VENMO', matchType: 'contains', activityType: 'CREDIT' },
      { pattern: 'ATM', matchType: 'contains', activityType: 'WITHDRAWAL' },
    ]);
    render(<SyncPage {...props} />);
    await switchTab(/settings/i);
    await openSection(/^Transaction rules/i);

    // Only the CREDIT row offers a subtype — the WITHDRAWAL row does not, since
    // Wealthfolio never reads subtype off it.
    const subtypeSelects = screen.getAllByLabelText(/subtype/i);
    expect(subtypeSelects).toHaveLength(1);

    fireEvent.change(subtypeSelects[0], { target: { value: 'REIMBURSEMENT' } });
    await waitFor(() => expect(props.store.setMappingRules).toHaveBeenCalledWith([
      { pattern: 'VENMO', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' },
      { pattern: 'ATM', matchType: 'contains', activityType: 'WITHDRAWAL' },
    ]));
  });

  it('renders and saves an existing subtype-less rule unchanged when an unrelated field is edited', async () => {
    const props = makeProps();
    props.store.getMappingRules = vi.fn(async () => [
      { pattern: 'PAYROLL', matchType: 'contains', activityType: 'DEPOSIT' },
    ]);
    render(<SyncPage {...props} />);
    await switchTab(/settings/i);
    await openSection(/^Transaction rules/i);

    fireEvent.change(screen.getByPlaceholderText('pattern'), { target: { value: 'PAYCHECK' } });
    await waitFor(() => expect(props.store.setMappingRules).toHaveBeenCalledWith([
      { pattern: 'PAYCHECK', matchType: 'contains', activityType: 'DEPOSIT' },
    ]));
  });

  it('persists which cards are open, and restores them on the next visit', async () => {
    const props = makeProps();
    const first = render(<SyncPage {...props} />);
    await switchTab(/settings/i);
    fireEvent.click(await screen.findByRole('button', { name: /^Transaction rules/i }));
    await waitFor(() =>
      expect(props.store.setOpenCards).toHaveBeenCalledWith(expect.objectContaining({ rules: true })),
    );
    // Unmounted before the revisit, so "the next visit" really is one page and
    // the counts below cannot be satisfied by the first render's DOM.
    first.unmount();

    // Next visit: the stored blob decides, so the page does not reset.
    const revisit = makeProps();
    revisit.store.getOpenCards = vi.fn(async () => ({ rules: true, 'auto-sync': true }));
    revisit.store.getUiState = vi.fn(async () => ({ activeTab: 'settings' }) as any);
    render(<SyncPage {...revisit} />);
    await waitFor(() => expect(screen.getAllByText('+ Add rule').length).toBe(1));
    expect(screen.getAllByLabelText(/auto-sync interval/i).length).toBe(1);
    // Cards absent from the blob stay closed.
    await switchTab(/settings/i);
    expect(screen.queryByLabelText(/Bot Token/i)).not.toBeInTheDocument();
  });

  // ── Amazon card mount ───────────────────────────────────────────────────
  it('mounts the Amazon card, renamed and wired to the shared category catalog', async () => {
    // AmazonCard itself is unit-tested in AmazonCard.test.tsx; this only proves
    // it is actually wired into the tab under its new title, with the page's
    // category catalog reaching it.
    const props = makeProps();
    props.store.getReportCategoryCatalog = vi.fn(async () => ([
      { name: 'Housing', parent: null, icon: null, color: null, hasBudget: true, hasSpend: false },
    ] as any));
    render(<SyncPage {...props} />);
    await switchTab(/settings/i);
    const header = await screen.findByRole('button', { name: /^Amazon categorization/i });
    fireEvent.click(header);
    expect(await screen.findByLabelText(/IMAP server/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Category for anything unrecognized/i)).toBeInTheDocument();
  });

  // ── Reset ───────────────────────────────────────────────────────────────
  it('gives the destructive reset flow a boundary card with the stated consequences', async () => {
    render(<SyncPage {...makeProps()} />);
    await switchTab(/settings/i);
    const card = (await screen.findByText('Reset connection')).closest('.sfin-danger-card');
    expect(card).toBeTruthy();
    // Has to name everything `clearAll` actually deletes — not just the
    // account mapping — since it undersells a destructive action otherwise.
    expect(card!.textContent).toContain(
      'Clears every SimpleFin Sync setting — the connection, account mapping, sync '
      + 'schedule, transaction rules, and any Telegram or Amazon setup. Transactions '
      + 'already imported into Wealthfolio stay.',
    );
  });

  it('reset requires an explicit confirmation step', async () => {
    const props = makeProps();
    render(<SyncPage {...props} />);
    await switchTab(/settings/i);
    fireEvent.click(await screen.findByRole('button', { name: /^Reset…$/ }));
    expect(props.onReset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /yes, reset/i }));
    await waitFor(() => expect(props.onReset).toHaveBeenCalled());
  });

  it('reset stops the scheduler and clears every stored secret before handing off', async () => {
    const props = makeProps();
    render(<SyncPage {...props} />);
    await switchTab(/settings/i);
    fireEvent.click(await screen.findByRole('button', { name: /^Reset…$/ }));
    fireEvent.click(screen.getByRole('button', { name: /yes, reset/i }));
    await waitFor(() => expect(props.onReset).toHaveBeenCalled());
    expect(props.scheduler.stop).toHaveBeenCalled();
    expect(props.store.clearAll).toHaveBeenCalled();
  });

  // ── Accounts card ────────────────────────────────────────────────────────
  // Mapping an account linked AFTER setup used to require Reset, which clears
  // every other setting. These cover the path that replaced it.
  describe('Accounts card', () => {
    it('does not touch the bridge until the card is opened', async () => {
      const { fetchAccounts } = await import('../utils/simplefin');
      const props = makeProps();
      render(<SyncPage {...props} />);
      await switchTab(/settings/i);
      await waitFor(() => expect(screen.getByRole('button', { name: /^Accounts/i })).toBeInTheDocument());
      expect(fetchAccounts).not.toHaveBeenCalled();
    });

    it('shows the balances when Accounts opens, and asks SimpleFin only for Edit mapping', async () => {
      // Opening Accounts is now mostly a look at the balances (they moved here
      // from Overview), so it must not cost a bridge round-trip every time.
      const { fetchAccounts } = await import('../utils/simplefin');
      vi.mocked(fetchAccounts).mockClear();
      render(<SyncPage {...makeProps()} />);
      await switchTab(/settings/i);
      await openSection(/^Accounts/i);
      expect(await screen.findByText('$1,234.56')).toBeInTheDocument();
      expect(fetchAccounts).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Edit mapping' }));
      await waitFor(() => expect(fetchAccounts).toHaveBeenCalledOnce());
    });

    it('summarises Accounts with the count and any difference', async () => {
      render(<SyncPage {...makeProps()} />);
      await switchTab(/settings/i);
      expect(await screen.findByText('2 accounts · 1 off by $15.22')).toBeInTheDocument();
    });

    it('lists an account that exists at SimpleFin but is not mapped', async () => {
      const props = makeProps();
      render(<SyncPage {...props} />);
      await switchTab(/settings/i);
      await openMapper();
      // The mapped two AND the newly-linked one, which is the point: the card
      // shows the live bridge list, not just what the mapping already knows.
      expect(await screen.findByText('Robinhood Gold Card')).toBeInTheDocument();
      // Twice since 1.57: once in the balance list above the mapper, once in it.
      expect(screen.getAllByText('Growth').length).toBeGreaterThan(0);
    });

    it('saves a new mapping alongside the existing ones, without disturbing them', async () => {
      const props = makeProps();
      render(<SyncPage {...props} />);
      await switchTab(/settings/i);
      await openMapper();
      const newRowLabel = await screen.findByText('Robinhood Gold Card');

      // Wait for the Wealthfolio account list to arrive before touching the
      // select: until its <option> exists, assigning that value is a no-op and
      // the row silently stays unmapped.
      await waitFor(() =>
        expect(screen.getAllByRole('option', { name: 'Checking' }).length).toBeGreaterThan(0),
      );

      // Target the select in the NEW account's own row rather than by index,
      // so the assertion cannot silently move to another account's row.
      const row = newRowLabel.closest('.sfin-row') as HTMLElement;
      fireEvent.change(within(row).getByRole('combobox'), { target: { value: 'wf-a' } });
      fireEvent.click(screen.getByRole('button', { name: /save mapping/i }));

      await waitFor(() => expect(props.store.setAccountMapping).toHaveBeenCalled());
      // The pre-existing entries survive: a save that dropped them would
      // silently stop syncing the accounts the user never touched.
      expect(props.store.setAccountMapping).toHaveBeenCalledWith({
        'sfin-1': 'wf-a', 'sfin-2': 'wf-b', 'sfin-new': 'wf-a',
      });
    });

    it('shows do-not-sync accounts by name and can undo the decision', async () => {
      // A stored preference with no visible off-switch is a trap: the Overview
      // banner writes this list, and the Accounts card is the only place it
      // can be reviewed or reversed.
      const props = makeProps();
      props.store.getIgnoredAccounts = vi.fn(async () => ['sfin-new']);
      render(<SyncPage {...props} />);
      await switchTab(/settings/i);
      await openMapper();

      // Named from the live feed, not shown as a raw SimpleFin id.
      expect(await screen.findByText(/1 account set not to sync/i)).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getAllByText('Robinhood Gold Card').length).toBeGreaterThan(0),
      );

      fireEvent.click(screen.getByRole('button', { name: /remind me about it again/i }));
      await waitFor(() => expect(props.store.setIgnoredAccounts).toHaveBeenCalledWith([]));
      await waitFor(() =>
        expect(screen.queryByText(/set not to sync/i)).not.toBeInTheDocument(),
      );
    });

    it('mapping an ignored account takes it off the do-not-sync list', async () => {
      // Mapping IS the decision to sync it. Leaving the id behind would go
      // wrong the moment the mapping is cleared again: the account would fall
      // silent with no reminder, which is the failure the banner exists for.
      const props = makeProps();
      props.store.getIgnoredAccounts = vi.fn(async () => ['sfin-new']);
      render(<SyncPage {...props} />);
      await switchTab(/settings/i);
      await openMapper();
      const newRowLabel = (await screen.findAllByText('Robinhood Gold Card'))
        .map((el) => el.closest('.sfin-row'))
        .find(Boolean) as HTMLElement;
      await waitFor(() =>
        expect(screen.getAllByRole('option', { name: 'Checking' }).length).toBeGreaterThan(0),
      );

      fireEvent.change(within(newRowLabel).getByRole('combobox'), { target: { value: 'wf-a' } });
      fireEvent.click(screen.getByRole('button', { name: /save mapping/i }));

      await waitFor(() => expect(props.store.setIgnoredAccounts).toHaveBeenCalledWith([]));
    });

    it('lists a just-mapped account by its name, in step with the page', async () => {
      // The list used the tab's fresh mapping but the page's names, read once
      // at startup — so an account mapped seconds ago appeared as its raw id
      // with "account no longer exists — reset & re-map", pointing at Reset.
      const props = makeProps();
      const stored: Record<string, any> = {
        mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
        names: { 'sfin-1': 'Growth', 'sfin-2': 'Spend' },
      };
      props.store.getAccountMapping = vi.fn(async () => stored.mapping);
      props.store.setAccountMapping = vi.fn(async (m: any) => { stored.mapping = m; });
      props.store.getAccountNames = vi.fn(async () => stored.names);
      props.store.setAccountNames = vi.fn(async (n: any) => { stored.names = n; });
      render(<SyncPage {...props} />);
      await switchTab(/settings/i);
      await openMapper();
      const newRowLabel = (await screen.findAllByText('Robinhood Gold Card'))
        .map((el) => el.closest('.sfin-row'))
        .find(Boolean) as HTMLElement;
      await waitFor(() =>
        expect(screen.getAllByRole('option', { name: 'Checking' }).length).toBeGreaterThan(0),
      );
      fireEvent.change(within(newRowLabel).getByRole('combobox'), { target: { value: 'wf-a' } });
      fireEvent.click(screen.getByRole('button', { name: /save mapping/i }));

      const list = document.querySelector('.sfin-accts--bare') as HTMLElement;
      const row = await waitFor(() => within(list).getByText('Robinhood Gold Card').closest('.sfin-acct-card') as HTMLElement);
      expect(row).toHaveTextContent('→ Checking');
      expect(row).not.toHaveTextContent('no longer exists');
      // The card's summary and the Home tile count the same mapping.
      expect(screen.getByRole('button', { name: /^Accounts/ })).toHaveTextContent('3 accounts');
    });

    it('reports a bridge failure instead of showing an empty mapper', async () => {
      // An empty mapper would read as "you have no accounts", and saving from
      // it could overwrite a good mapping.
      const { fetchAccounts } = await import('../utils/simplefin');
      vi.mocked(fetchAccounts).mockRejectedValueOnce(new Error('SimpleFin /accounts failed: 524'));
      const props = makeProps();
      render(<SyncPage {...props} />);
      await switchTab(/settings/i);
      await openMapper();
      expect(await screen.findByText(/524/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /save mapping/i })).not.toBeInTheDocument();
    });
  });


  it('groups the cards under plain headings, in the order of the spec', async () => {
    render(<SyncPage {...makeProps()} />);
    await switchTab(/settings/i);
    const headings = await screen.findAllByRole('heading', { level: 3 });
    expect(headings.map((h) => h.textContent)).toEqual(
      ['Accounts', 'Budget', 'Notifications', 'Sync', 'Categorizing', 'Reset'],
    );
  });

  it('keeps an unsaved Telegram edit across a trip to another tab', async () => {
    // The draft is page-owned; moving the Telegram cards into Settings must not
    // change that.
    const props = makeProps();
    props.store.getReports = vi.fn(async () => ({ live: null, archive: [] }));
    render(<SyncPage {...props} />);
    await switchTab(/settings/i);
    await openSection(/^Telegram connection/i);
    fireEvent.change(await screen.findByLabelText(/bot token/i), { target: { value: 'typed-token' } });
    await switchTab(/reports/i);
    await switchTab(/settings/i);
    expect(await screen.findByLabelText(/bot token/i)).toHaveValue('typed-token');
  });

  it('keeps an unsaved Telegram edit across a glance at Home', async () => {
    render(<SyncPage {...makeProps()} />);
    await switchTab(/settings/i);
    await openSection(/^Telegram connection/i);
    fireEvent.change(await screen.findByLabelText(/bot token/i), { target: { value: 'typed-token' } });
    await switchTab(/home/i);
    await switchTab(/settings/i);
    expect(await screen.findByLabelText(/bot token/i)).toHaveValue('typed-token');
  });

  it('summarises a set pool with its amount and a readable end date', async () => {
    // From the stored pool the card edits, not the companion's last publish —
    // which lags a Set or Clear until the next sync.
    const props = makeProps();
    (props.store as any).getSemesterPool = vi.fn(async () => ({ amountCents: 1_600_000, startDate: '2026-08-25', endDate: '2026-12-12' }));
    render(<SyncPage {...props} />);
    await switchTab(/settings/i);
    const header = await screen.findByRole('button', { name: /^Semester pool/i });
    await waitFor(() => expect(header).toHaveTextContent('$16,000 until Dec 12'));
  });

  it('updates the pool summary the moment a pool is set, without waiting for a sync', async () => {
    const props = makeProps();
    (props.store as any).getSemesterPool = vi.fn(async () => null);
    (props.store as any).setSemesterPool = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    await switchTab(/settings/i);
    await openSection(/^Semester pool/i);
    fireEvent.change(await screen.findByLabelText('Pool amount'), { target: { value: '16000' } });
    fireEvent.change(screen.getByLabelText('Must last until'), { target: { value: '2099-12-12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set pool' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Semester pool/i })).toHaveTextContent('$16,000 until Dec 12'),
    );
  });

  it('offers the semester pool as a Settings card, summarised when closed', async () => {
    render(<SyncPage {...makeProps()} />);
    await switchTab(/settings/i);
    const header = await screen.findByRole('button', { name: /^Semester pool/i });
    expect(header).toHaveTextContent('Not set');
    fireEvent.click(header);
    expect(await screen.findByLabelText('Pool amount')).toBeInTheDocument();
  });
});
