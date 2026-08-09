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
 * The page's own behaviour: sync actions, the interval, the collapsible-card
 * contract, and the error surface.
 *
 * Everything about the Telegram cards — reports, alert amounts, the category
 * matrix, emoji styling — lives in NotificationsTab.test.tsx now, still rendered
 * through this page.
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

  it('changing the interval saves it and restarts the scheduler', async () => {
    const props = makeProps();
    render(<SyncPage {...props} />);
    await openSection(/^Auto-Sync/i);
    const select = await screen.findByLabelText(/auto-sync interval/i);
    fireEvent.change(select, { target: { value: '8' } });
    await waitFor(() => expect(props.store.setSyncScheduleHours).toHaveBeenCalledWith(8));
    expect(props.scheduler.start).toHaveBeenCalledWith(8, expect.any(Function), expect.any(Function));
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
    expect(screen.queryByLabelText(/Bot Token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Monthly Wrap-Up/i)).not.toBeInTheDocument();
    expect(screen.queryByText('+ Add rule')).not.toBeInTheDocument();
    expect(screen.queryByText(/docker-compose\.yml/)).not.toBeInTheDocument();
    // The Telegram card became three, so three headers here rather than one.
    for (const name of [
      /^Auto-Sync/i, /^Background sync/i, /^Telegram connection/i, /^Reports/i,
      /^Report content/i, /^Transaction Rules/i,
    ]) {
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

  it('reports each collapsed card’s state in its header summary, so collapsing hides chrome and not state', async () => {
    const props = makeProps();
    props.store.getSyncScheduleHours = vi.fn(async () => 4);
    props.store.getAutoHeal = vi.fn(async () => true);
    props.store.getMappingRules = vi.fn(async () => [
      { pattern: 'PAYROLL', matchType: 'contains', activityType: 'DEPOSIT' },
      { pattern: 'ATM', matchType: 'contains', activityType: 'WITHDRAWAL' },
    ]);
    props.store.getTelegramConfig = vi.fn(async () => ({ botToken: 't', chatId: 'c', enabled: true }));
    render(<SyncPage {...props} />);
    await screen.findByText('Every 4h · auto-heal on');
    expect(screen.getByText('2 rules')).toBeInTheDocument();
    // The credentials and the reports are now two cards, so the one summary that
    // said both is now one each: connection state, then which reports are on.
    // All three default to on for a config that predates them.
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('daily, weekly, monthly reports')).toBeInTheDocument();
  });

  it('summarises an off / unconfigured state distinguishably', async () => {
    const props = makeProps();
    props.store.getSyncScheduleHours = vi.fn(async () => null);
    props.store.getAutoAdjust = vi.fn(async () => true);
    render(<SyncPage {...props} />);
    // Interval off, but aggressive auto-heal on — the summary has to say both.
    await screen.findByText('Off · aggressive auto-heal');
    // No token/chat id in the default mock.
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.getByText(/using the \+\/− defaults/)).toBeInTheDocument();
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
    expect(screen.queryByLabelText(/Bot Token/i)).not.toBeInTheDocument();
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

});
