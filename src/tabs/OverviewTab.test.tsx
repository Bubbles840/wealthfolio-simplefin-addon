import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SyncPage } from '../pages/SyncPage';
import { ThemeStyles } from '../components/ui';
import { runSync } from '../utils/sync';

/**
 * Integration-level, on purpose: OverviewTab owns none of its data, so every
 * assertion here is about what the PAGE ends up showing — the same thing these
 * tests asserted before the extraction, from the same entry point. Mounting the
 * tab alone would prove only that props render, which is not what regressed.
 *
 * The real INTERVAL_SKIP_MESSAGE travels through the mock (SyncPage compares
 * against it), and the two balance-writing helpers are stubbed because the tab
 * imports them for its banner buttons.
 */
vi.mock('../utils/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sync')>();
  return {
    INTERVAL_SKIP_MESSAGE: actual.INTERVAL_SKIP_MESSAGE,
    runSync: vi.fn(async () => ({ imported: 5, skipped: 1, errors: [] })),
    applyBalanceAdjustment: vi.fn(async () => {}),
    applyBaselineCorrection: vi.fn(async () => {}),
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
    getLastSyncImported: vi.fn(async () => null),
    setLastSyncImported: vi.fn(async () => {}),
    // Amazon categorization unconfigured, which is the case for every test here
    // except the ones that say otherwise.
    getAmazonConfig: vi.fn(async () => null),
    setAmazonConfig: vi.fn(async () => {}),
    getAmazonLabels: vi.fn(async () => ({})),
    getReportGlyphStyle: vi.fn(async () => ({ mode: 'clean' as const, overrides: {} })),
    setReportGlyphStyle: vi.fn(async () => {}),
    getSubcategoryDisplay: vi.fn(async () => 'rollup' as const),
    setSubcategoryDisplay: vi.fn(async () => {}),
    getCompanionVersion: vi.fn(async () => null),
    getOpenCards: vi.fn(async () => ({}) as Record<string, boolean>),
    setOpenCards: vi.fn(async () => {}),
    // Page-level UI state, and the companion-published count behind the third
    // stat tile. `null` from the latter is the standalone-addon case.
    getUiState: vi.fn(async () => ({}) as any),
    setUiState: vi.fn(async () => {}),
    getUncategorizedStatus: vi.fn(async () => null as any),
  } as any,
  onReset: vi.fn(),
  scheduler: { start: vi.fn(), stop: vi.fn(), isRunning: vi.fn(() => false) } as any,
});

/**
 * Only one tab panel is mounted at a time. Overview is the default tab, so
 * almost nothing here needs this — the exception is a test whose stored
 * `ui_state` deliberately opens on another tab.
 */
async function switchTab(name: RegExp) {
  fireEvent.click(await screen.findByRole('tab', { name }));
}

describe('OverviewTab', () => {
  describe('account list', () => {
    it('shows account names instead of raw IDs in the mapping list', async () => {
      render(<SyncPage {...makeProps()} />);
      await waitFor(() => expect(screen.getByText(/Growth/)).toBeInTheDocument());
      expect(screen.getByText(/Checking/)).toBeInTheDocument();
      // The account row must show the name, not the raw SimpleFin ID
      const growthRow = screen.getByText(/Growth/).closest('.sfin-acct-card');
      expect(growthRow?.textContent).not.toContain('sfin-1');
    });

    it('navigates to the Wealthfolio account when a mapped row is clicked', async () => {
      const props = makeProps();
      render(<SyncPage {...props} />);
      await waitFor(() => expect(screen.getByText(/Growth/)).toBeInTheDocument());
      fireEvent.click(screen.getByText(/Growth/).closest('.sfin-acct-card')!);
      expect(props.ctx.api.navigation.navigate).toHaveBeenCalledWith('/accounts/wf-a');
    });

    it('gives each account a full-width card of its own rather than a shared grid', async () => {
      // Stacked, one per row: the two-column treatment put a balance and its
      // chip directly beneath a different account's name.
      render(<SyncPage {...makeProps()} />);
      await waitFor(() => expect(screen.getByText(/Growth/)).toBeInTheDocument());
      const rows = document.querySelectorAll('.sfin-acct-card');
      expect(rows).toHaveLength(2);
      rows.forEach((row) => expect(row.classList.contains('sfin-card')).toBe(true));
      // The rows are siblings in a plain stack — nothing lays them out in columns.
      const container = rows[0].parentElement!;
      expect(container.className).toContain('sfin-accts');
      expect(container.className).not.toContain('sfin-strip');
    });
  });

  describe('account balance chips', () => {
    /**
     * Guards the `money()` formatter actually being used on the account row —
     * a raw `1234.56` slipping through unformatted (no currency symbol, no
     * thousands separator) is exactly the regression this catches.
     */
    it('formats the balance as currency, not as a raw number', async () => {
      render(<SyncPage {...makeProps()} />);
      expect(await screen.findByText('$1,234.56')).toBeInTheDocument();
    });

    /**
     * `drift: null` used to render a green "in sync" chip whichever reason it was
     * null for — and it is null both when the balances were compared and matched
     * AND when they could not be compared at all (a pending row, a run that
     * reconciled anything, a create the host refused). Claiming "in sync" for the
     * second case is asserting a verification that never happened, and it is how
     * two phantom drift episodes on one account got read as verified balances.
     */
    it('says "in sync" only when the run actually compared the balances', async () => {
      const props = makeProps();
      props.store.getAccountBalances = vi.fn(async () => ({
        'sfin-1': { balance: 1234.56, currency: 'USD', date: 1700000000, drift: null, measured: true },
        'sfin-2': { balance: 10, currency: 'USD', date: 1700000000, drift: null, measured: false },
      })) as any;
      render(<SyncPage {...props} />);

      expect(await screen.findByText('in sync')).toBeTruthy();
      expect(screen.getByText('not checked')).toBeTruthy();
      // One of each — the two states are not collapsed back together.
      expect(screen.getAllByText('in sync')).toHaveLength(1);
      expect(screen.getAllByText('not checked')).toHaveLength(1);
    });

    it('treats a snapshot with no `measured` field as not checked', async () => {
      // Written by an older build, which proves nothing about the current state
      // either. Absent must not read as verified.
      const props = makeProps();
      props.store.getAccountBalances = vi.fn(async () => ({
        'sfin-1': { balance: 1234.56, currency: 'USD', date: 1700000000, drift: null },
      })) as any;
      render(<SyncPage {...props} />);

      expect(await screen.findByText('not checked')).toBeTruthy();
      expect(screen.queryByText('in sync')).toBeNull();
    });

    it('still shows a real drift as off-by, whatever `measured` says', async () => {
      // A reported figure outranks the flag: it was measurable by definition, and
      // the amount is the actionable part.
      const props = makeProps();
      props.store.getAccountBalances = vi.fn(async () => ({
        'sfin-1': { balance: 100, currency: 'USD', date: 1700000000, drift: 15.22, measured: true },
      })) as any;
      render(<SyncPage {...props} />);

      // getAllBy, because the drift banner above the list says "off by" too — the
      // point here is the CHIP, and that it is not the muted one.
      expect((await screen.findAllByText(/off by/)).length).toBeGreaterThan(0);
      expect(screen.queryByText('not checked')).toBeNull();
      expect(screen.queryByText('in sync')).toBeNull();
    });
  });

  describe('banners', () => {
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
      // The header's button, specifically: the off-balance banner below now
      // offers the same operation under the same name, which is the point — one
      // `healing` flag must not have two labels.
      const header = await waitFor(
        () => document.querySelector('.sfin-head-actions') as HTMLElement,
      );
      fireEvent.click(within(header).getByRole('button', { name: /deep scan/i }));

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

    it('offers the re-scan on an off-balance account, above the tiles', async () => {
      // The drift banner is the needs-attention signal, so it is never collapsed
      // and never below the numbers it explains.
      render(<SyncPage {...makeProps()} />);
      const banner = (await screen.findByText(/is off by/)).closest('.sfin-banner-warn')!;
      expect(banner.querySelector('.sfin-banner-actions')).toBeTruthy();
      const strip = document.querySelector('.sfin-strip')!;
      expect(banner.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe('stat tiles', () => {
    it('shows the stored imported count on mount, without a sync in this session', async () => {
      // It used to be React state only, set when the user clicked Sync Now — so the
      // tile read "—" after every reload, and permanently for anyone whose syncing
      // is done by the companion. The label says "Imported last run", and the last
      // run is usually not one this page performed.
      const props = makeProps();
      props.store.getLastSyncImported = vi.fn(async () => 7) as any;
      render(<SyncPage {...props} />);

      const tile = (await screen.findByText(/Imported last run/i)).closest('.sfin-tile');
      expect(tile?.textContent).toContain('7');
    });

    it('shows a stored zero as 0, not as unknown', async () => {
      // "The last run imported nothing" is information, and distinct from "no run
      // has ever reported".
      const props = makeProps();
      props.store.getLastSyncImported = vi.fn(async () => 0) as any;
      render(<SyncPage {...props} />);

      const tile = (await screen.findByText(/Imported last run/i)).closest('.sfin-tile');
      expect(tile?.textContent).toContain('0');
      expect(tile?.textContent).not.toContain('—');
    });

    it('falls back to — when nothing has ever been recorded', async () => {
      const props = makeProps();
      props.store.getLastSyncImported = vi.fn(async () => null) as any;
      render(<SyncPage {...props} />);

      const tile = (await screen.findByText(/Imported last run/i)).closest('.sfin-tile');
      expect(tile?.textContent).toContain('—');
    });

    it('says the imported figure counts transactions, not dollars', async () => {
      const props = makeProps();
      props.store.getLastSyncImported = vi.fn(async () => 6) as any;
      render(<SyncPage {...props} />);

      const tile = (await screen.findByText(/Imported last run/i)).closest('.sfin-tile')!;
      expect(tile.querySelector('.sfin-tile-sub')?.textContent).toBe('transactions');
    });

    it('shows the needs-a-category tile only when the companion has published a count', async () => {
      const props = makeProps();
      props.store.getUncategorizedStatus = vi.fn(async () => (
        { count: 3, asOf: '2026-08-08T12:00:00Z' }
      )) as any;
      render(<SyncPage {...props} />);
      const tile = (await screen.findByText(/Needs a category/i)).closest('.sfin-tile');
      expect(tile?.textContent).toContain('3');
      expect(tile?.getAttribute('title')).toContain('2026-08-08T12:00:00Z');
    });

    it('hides the needs-a-category tile without the companion', async () => {
      // The addon cannot compute it: the SDK exposes no category data, so there
      // is nothing honest to put in the tile.
      render(<SyncPage {...makeProps()} />); // default mock returns null
      await screen.findByText(/Imported last run/i);
      expect(screen.queryByText(/Needs a category/i)).toBeNull();
    });

    it('drops the auto-sync schedule from the tiles', async () => {
      // Its home is the Auto-Sync card header, which already prints the interval;
      // a tile spent a third of the strip restating a setting.
      render(<SyncPage {...makeProps()} />);
      const strip = (await screen.findByText(/Imported last run/i)).closest('.sfin-strip')!;
      expect(strip.textContent).not.toMatch(/Every 6h/);
    });

    it('fills the row with two tiles instead of leaving a phantom third column', async () => {
      render(<SyncPage {...makeProps()} />); // no companion → two tiles
      const strip = (await screen.findByText(/Imported last run/i)).closest('.sfin-strip')!;
      expect(strip.querySelectorAll('.sfin-tile')).toHaveLength(2);

      // The column count is derived from the children, so two tiles cannot leave
      // an empty third column. Asserted against the stylesheet itself, because a
      // fixed template is exactly the regression: jsdom lays nothing out, so the
      // rule is the only evidence available.
      render(<ThemeStyles />);
      const css = document.getElementById('sfin-ui-styles')!.textContent!;
      const rule = css.match(/\.sfin-strip \{[^}]*\}/)![0];
      expect(rule).not.toMatch(/grid-template-columns/);
      expect(rule).toMatch(/grid-auto-flow:\s*column/);
      expect(rule).toMatch(/grid-auto-columns:\s*1fr/);
    });
  });

  describe('setup checklist', () => {
    it('checklist rows self-complete and deep-links exist', async () => {
      const props = makeProps();
      props.store.getCompanionVersion = vi.fn(async () => '1.9.0') as any;
      render(<SyncPage {...props} />);
      expect(await screen.findByText(/Finish setting up/i)).toBeTruthy();
      expect(screen.getByText(/companion v1\.9\.0 connected/i)).toBeTruthy();
      // The two unfinished rows still offer their way in. Scoped to the
      // checklist: the Amazon card's own header summary says "Not set up" too.
      const checklist = screen.getByText(/Finish setting up/i).closest('.sfin-checklist')!;
      expect(checklist.querySelectorAll('.sfin-checklist-link')).toHaveLength(2);
    });

    it('sits between the alerts and the tiles', async () => {
      render(<SyncPage {...makeProps()} />);
      const checklist = (await screen.findByText(/Finish setting up/i)).closest('.sfin-checklist')!;
      const banner = document.querySelector('.sfin-banner-warn')!;
      const strip = document.querySelector('.sfin-strip')!;
      expect(banner.compareDocumentPosition(checklist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(checklist.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('stays away once dismissed, without forgetting the active tab', async () => {
      // Read-modify-write: `ui_state` also carries the tab, and clobbering it
      // would silently send the user back to Overview on the next visit.
      const props = makeProps();
      props.store.getUiState = vi.fn(async () => ({ activeTab: 'advanced' })) as any;
      render(<SyncPage {...props} />);
      // The stored state opens on Advanced, so the checklist has to be reached
      // the way a user would.
      await switchTab(/overview/i);
      fireEvent.click(await screen.findByRole('button', { name: /Dismiss setup checklist/i }));

      await waitFor(() => expect(props.store.setUiState).toHaveBeenCalledWith(
        { activeTab: 'advanced', checklistDismissed: true },
      ));
      expect(screen.queryByText(/Finish setting up/i)).toBeNull();
    });

    it('is gone from the start when it was dismissed on an earlier visit', async () => {
      const props = makeProps();
      props.store.getUiState = vi.fn(async () => ({ checklistDismissed: true })) as any;
      render(<SyncPage {...props} />);
      await screen.findByText(/Imported last run/i);
      expect(screen.queryByText(/Finish setting up/i)).toBeNull();
    });
  });
});
