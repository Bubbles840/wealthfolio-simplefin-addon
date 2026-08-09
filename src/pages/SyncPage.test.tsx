import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    // Amazon categorization unconfigured, which is every test here except the
    // Amazon card ones.
    getLastSyncImported: vi.fn(async () => null),
    setLastSyncImported: vi.fn(async () => {}),
    getAmazonConfig: vi.fn(async () => null),
    setAmazonConfig: vi.fn(async () => {}),
    getAmazonLabels: vi.fn(async () => ({})),
    getReportGlyphStyle: vi.fn(async () => ({ mode: 'clean' as const, overrides: {} })),
    setReportGlyphStyle: vi.fn(async () => {}),
    getSubcategoryDisplay: vi.fn(async () => 'rollup' as const),
    setSubcategoryDisplay: vi.fn(async () => {}),
    getCompanionVersion: vi.fn(async () => null),
    getOpenCards: vi.fn(async () => ({}) as Record<string, boolean>),
    // async, like the real SecretsStore method — the page fires it and forgets,
    // so it has to be thenable
    setOpenCards: vi.fn(async () => {}),
    // Page-level UI state (active tab, checklist dismissal) and the companion's
    // uncategorized count. Overview reads all three; see OverviewTab.test.tsx.
    getUiState: vi.fn(async () => ({}) as any),
    setUiState: vi.fn(async () => {}),
    getUncategorizedStatus: vi.fn(async () => null as any),
  } as any,
  onReset: vi.fn(),
  scheduler: { start: vi.fn(), stop: vi.fn(), isRunning: vi.fn(() => false) } as any,
});

/**
 * Only one tab panel is mounted at a time, so a test that touches content on
 * another tab has to switch to it first — exactly as the user does. Matched by
 * the tab's accessible name (its label).
 */
async function switchTab(name: RegExp) {
  fireEvent.click(await screen.findByRole('tab', { name }));
}

/**
 * The page's own behaviour: sync actions, the interval-skip banner, the error
 * surface, and the tabbed shell itself.
 *
 * Everything about the Telegram cards lives in NotificationsTab.test.tsx, and
 * everything about Auto-sync / Docker / Amazon / Transaction rules / Reset
 * lives in AdvancedTab.test.tsx — both still rendered through this page.
 */
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

  it('keeps the daily-driver view visible alongside the collapsed config cards', async () => {
    // The always-on half of the page: status, actions, stat tiles, accounts
    // with balances. (The account rows, balances and drift banner get their own
    // dedicated coverage in OverviewTab.test.tsx; this just proves the tab is
    // still wired into the page and the page's own controls render beside it.)
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /sync now/i })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /deep scan/i })).toBeInTheDocument();
    expect(screen.getByText('Accounts synced')).toBeInTheDocument();
  });

  it('keeps the technical meaning of the renamed reconcile button in its tooltip', async () => {
    // The label went plain-language, but "reconcile & link" is the name in the
    // logs, the docs and the companion — so it stays reachable on hover rather
    // than being deleted outright.
    render(<SyncPage {...makeProps()} />);
    const deepScan = await screen.findByRole('button', { name: /deep scan/i });
    expect(deepScan.getAttribute('title')).toBe(
      'Re-scans the last 90 days and re-links transfer pairs (reconcile & link)',
    );
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

  // ── The tabbed shell ───────────────────────────────────────────────────
  it('mounts only the active tab, with the header and both page-wide surfaces outside it', async () => {
    // The whole point of the shell: the page mixed a daily glance with
    // once-ever setup, so the setup half must be absent — not merely hidden —
    // while Overview is on screen.
    render(<SyncPage {...makeProps()} />);
    await screen.findByText('Accounts synced');
    expect(document.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);

    const panel = document.querySelector('#sfin-panel-overview')!;
    expect(panel.getAttribute('aria-labelledby')).toBe('sfin-tab-overview');
    expect(screen.getByRole('tab', { name: /overview/i }).getAttribute('aria-controls'))
      .toBe('sfin-panel-overview');
    // The other two tabs' content is unmounted.
    expect(screen.queryByRole('button', { name: /^Telegram connection/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Auto-sync/i })).toBeNull();
    // ...and the header/footer are the shell's, not the panel's.
    expect(panel.contains(screen.getByRole('button', { name: /sync now/i }))).toBe(false);
    expect(panel.contains(screen.getByRole('tablist'))).toBe(false);

    await switchTab(/advanced/i);
    expect(await screen.findByRole('button', { name: /^Auto-sync/i })).toBeTruthy();
    expect(document.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
    expect(document.querySelector('#sfin-panel-advanced')).toBeTruthy();
    expect(screen.queryByText('Accounts synced')).toBeNull();
    // The header buttons work from every tab, which is what makes hazard 1 below
    // possible in the first place.
    expect(screen.getByRole('button', { name: /sync now/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /deep scan/i })).toBeInTheDocument();
  });

  it('persists the active tab across mounts', async () => {
    const props = makeProps();
    let saved: any = {};
    props.store.getUiState = vi.fn(async () => saved) as any;
    props.store.setUiState = vi.fn(async (s: any) => { saved = s; }) as any;

    const { unmount } = render(<SyncPage {...props} />);
    await switchTab(/advanced/i);
    await waitFor(() => expect(saved.activeTab).toBe('advanced'));
    unmount();

    render(<SyncPage {...props} />);
    await waitFor(() => expect(
      screen.getByRole('tab', { name: /advanced/i }).getAttribute('aria-selected'),
    ).toBe('true'));
  });

  it('remembers the tab without forgetting the dismissed checklist', async () => {
    // Read-modify-write both ways: `ui_state` is one blob, so switching tabs
    // must not resurrect a checklist the user dismissed.
    const props = makeProps();
    props.store.getUiState = vi.fn(async () => ({ checklistDismissed: true })) as any;
    render(<SyncPage {...props} />);
    await switchTab(/notifications/i);
    await waitFor(() => expect(props.store.setUiState).toHaveBeenCalledWith(
      { checklistDismissed: true, activeTab: 'notifications' },
    ));
  });

  it('checklist deep-link lands on the right tab', async () => {
    // What `onNavigate` was built for — it was a no-op until the tab bar existed.
    render(<SyncPage {...makeProps()} />);
    const checklist = (await screen.findByText(/Finish setting up/i)).closest('.sfin-checklist')!;
    const telegramRow = Array.from(checklist.querySelectorAll('.sfin-checklist-row'))
      .find((row) => /Telegram/i.test(row.textContent ?? ''))!;
    fireEvent.click(telegramRow.querySelector('.sfin-checklist-link')!);

    expect(screen.getByRole('tab', { name: /notifications/i }).getAttribute('aria-selected'))
      .toBe('true');
    // Landed somewhere useful, not just on the right tab index.
    expect(await screen.findByRole('button', { name: /^Telegram connection/i })).toBeTruthy();
  });

  // ── Hazard 1: a notice that would have been reported into an unmounted tab ──
  it('brings the pruned-duplicates notice on screen when the sync ran from another tab', async () => {
    // `Sync now` fires from any tab, but the itemised list of what was DELETED
    // renders inside Overview. Without this, a run started from Advanced would
    // remove rows from the user's ledger and say so into a component that is not
    // mounted — silent data loss.
    vi.mocked(runSync).mockResolvedValueOnce({
      imported: 0, skipped: 2, errors: [],
      prunedDuplicates: [
        { sfinAccountId: 'sfin-1', accountName: 'Savings', txId: 'TRN-3917f117',
          description: 'PNC BANK 1234 Transfer', date: '2026-07-27', amountCents: 130000,
          currency: 'USD', wfId: 'act-2' },
      ],
    } as any);
    render(<SyncPage {...makeProps()} />);
    await switchTab(/advanced/i);
    await screen.findByRole('button', { name: /^Auto-sync/i });

    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));

    const banner = await screen.findByText(/Removed 1 duplicate activity/i);
    expect(banner.closest('.sfin-banner-warn')!.textContent).toContain('$1,300.00');
    expect(screen.getByRole('tab', { name: /overview/i }).getAttribute('aria-selected'))
      .toBe('true');
  });

  it('leaves the tab alone when a sync pruned nothing', async () => {
    // The forced switch is for something the user MUST see. A routine run from
    // the Advanced tab must not yank them off the card they were reading.
    render(<SyncPage {...makeProps()} />);
    await switchTab(/advanced/i);
    await screen.findByRole('button', { name: /^Auto-sync/i });
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));

    await waitFor(() => expect(screen.getByText(/5 transactions/i)).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: /advanced/i }).getAttribute('aria-selected'))
      .toBe('true');
  });

  // ── Hazard 2: a checklist signal that used to be reported by a mounted tab ──
  it('keeps the checklist Telegram row accurate after it is configured on another tab', async () => {
    // NotificationsTab used to report "configured" upward from an effect. Once
    // it unmounts that stops firing, so the checklist on Overview kept saying
    // "get a daily digest" for a user who had just connected a bot. The page
    // derives the row from the stored config instead.
    const props = makeProps();
    let stored: any = null;
    props.store.getTelegramConfig = vi.fn(async () => stored) as any;
    props.store.setTelegramConfig = vi.fn(async (c: any) => { stored = c; }) as any;
    render(<SyncPage {...props} />);
    expect(await screen.findByText(/Telegram reports — get a daily digest/)).toBeTruthy();

    await switchTab(/notifications/i);
    fireEvent.click(await screen.findByRole('button', { name: /^Telegram connection/i }));
    fireEvent.change(await screen.findByLabelText(/Bot Token/i), { target: { value: 'tok' } });
    fireEvent.change(screen.getByLabelText(/Chat ID/i), { target: { value: '42' } });
    fireEvent.click(await screen.findByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(props.store.setTelegramConfig).toHaveBeenCalled());

    await switchTab(/overview/i);
    expect(await screen.findByText(/Telegram reports — connected/)).toBeTruthy();
  });

  // ── Hazard 3: live data that only ever loaded once ─────────────────────
  it('refreshes the needs-a-category count with the rest of the live state', async () => {
    // The companion republishes this every sync, and the tile used to read it
    // once on mount — unlike the balances and the companion version beside it —
    // so it could sit stale for an entire session.
    const props = makeProps();
    let status: any = { count: 3, asOf: '2026-08-08T12:00:00Z' };
    props.store.getUncategorizedStatus = vi.fn(async () => status) as any;
    render(<SyncPage {...props} />);
    const tile = (await screen.findByText(/Needs a category/i)).closest('.sfin-tile')!;
    expect(tile.textContent).toContain('3');

    // What the companion published since. Focus is the refresh trigger the
    // balances already use.
    status = { count: 11, asOf: '2026-08-09T09:00:00Z' };
    fireEvent.focus(window);
    await waitFor(() => expect(tile.textContent).toContain('11'));
    expect(tile.getAttribute('title')).toContain('2026-08-09T09:00:00Z');
  });

});
