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
 * The page's own behaviour: sync actions, the interval-skip banner, and the
 * error surface.
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
    expect(screen.getByRole('button', { name: /reconcile & link/i })).toBeInTheDocument();
    expect(screen.getByText('Accounts synced')).toBeInTheDocument();
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
