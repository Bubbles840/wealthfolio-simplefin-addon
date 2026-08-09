import React, { useEffect, useState, useCallback } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { runSync, INTERVAL_SKIP_MESSAGE } from '../utils/sync';
import { SIMPLEFIN_SYNC_VERSION } from '../../shared/version';
import type { SyncResult } from '../utils/sync';
import { fetchAccounts } from '../utils/simplefin';
import { SyncStatus } from '../components/SyncStatus';
import { Button, ErrorBox } from '../components/ui';
import { TabBar, type TabId } from '../components/Tabs';
import { OverviewTab } from '../tabs/OverviewTab';
import { NotificationsTab } from '../tabs/NotificationsTab';
import { AdvancedTab } from '../tabs/AdvancedTab';
import type { SecretsStore, AccountBalanceInfo, CategoryCatalogEntry } from '../utils/secrets';
import type { Scheduler } from '../utils/scheduler';
import type { AccountMapping } from '../../shared/types';

/** Outside the component: a fresh literal each render would be a new `TabBar`
 *  prop identity for nothing. */
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'advanced', label: 'Advanced' },
];

/** The panel half of the tabs contract: `TabBar` points each button at
 *  `sfin-panel-<id>`, and an inactive tab renders NOTHING — not a hidden div. */
function TabPanel({ tab, active, children }: {
  tab: TabId; active: TabId; children: React.ReactNode;
}) {
  if (tab !== active) return null;
  return (
    <div role="tabpanel" id={`sfin-panel-${tab}`} aria-labelledby={`sfin-tab-${tab}`}>{children}</div>
  );
}

interface Props {
  ctx: AddonContext;
  store: SecretsStore;
  onReset: () => void;
  scheduler: Scheduler;
}

/**
 * The shell: header, the two page-wide surfaces (error box, interval callout),
 * the tab bar, and exactly ONE panel.
 *
 * Why tabs: this page mixed a daily glance — is it syncing, are the balances
 * right, what did the last run import — with setup done once and never again
 * (Docker, Telegram credentials, Amazon mail, reset). Scrolling past ten
 * collapsed config cards to read two numbers was the daily cost of one long
 * page. Tabs also UNMOUNT the inactive ones, so three things that quietly relied
 * on a sibling staying mounted now live here: `reportPruned`,
 * `refreshDerivedSignals`, `uncategorized`.
 */
export function SyncPage({ ctx, store, onReset, scheduler }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [imported, setImported] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [mapping, setMapping] = useState<AccountMapping>({});
  const [error, setError] = useState('');
  // The raw text behind a classified error (`SimplefinRequestError.detail`), held
  // separately so the box can show a readable message WITHOUT losing the diagnosis.
  const [errorDetail, setErrorDetail] = useState<string | undefined>(undefined);
  const [intervalBlocked, setIntervalBlocked] = useState(false);
  // What the last run's reconcile sweep DELETED as duplicate copies: the deletion
  // is automatic and Telegram optional, so the page is the one place a user is
  // guaranteed to see what vanished. See `reportPruned`.
  const [prunedDuplicates, setPrunedDuplicates] = useState<SyncResult['prunedDuplicates']>([]);
  const [sfinNames, setSfinNames] = useState<Record<string, string>>({});
  const [wfNames, setWfNames] = useState<Record<string, string>>({});
  const [balances, setBalances] = useState<Record<string, AccountBalanceInfo>>({});
  const [healing, setHealing] = useState(false);
  const [checklistDismissed, setChecklistDismissed] = useState(false);
  // Which companion build last synced this instance. Null until one has run — the
  // addon works standalone, so no companion is normal, not an error.
  const [companionVersion, setCompanionVersion] = useState<string | null>(null);
  // Every collapsible section's open state in one map, replacing the one-off
  // `show*` booleans this page used to carry. Shared by both config tabs.
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({});
  // The full catalog (all 52 spending categories). Read once here because two
  // things need it: the Amazon card's per-label pickers and the report matrix.
  const [categoryCatalog, setCategoryCatalog] = useState<CategoryCatalogEntry[]>([]);
  // The next three only feed Overview, which self-completes its checklist and
  // third tile from real signals. All READ FROM STORAGE here rather than reported
  // up by the tab that owns the setting: those tabs are unmounted precisely when
  // Overview is on screen, so a callback from their effects would freeze at
  // whatever it last said. See `refreshDerivedSignals`.
  const [telegramConfigured, setTelegramConfigured] = useState(false);
  const [amazonConfigured, setAmazonConfigured] = useState(false);
  const [uncategorized, setUncategorized] = useState<{ count: number; asOf: string } | null>(null);

  const loadBalances = useCallback(() => {
    store.getAccountBalances().then(setBalances).catch(() => {});
  }, [store]);

  /** The three values Overview DERIVES from storage rather than being told about
   *  by a sibling tab. Split out of `refreshLiveState` so returning to Overview
   *  re-reads exactly these, not the header's timestamp as well. */
  const refreshDerivedSignals = useCallback(() => {
    store.getTelegramConfig()
      .then((tg) => setTelegramConfigured(!!tg?.botToken && !!tg?.chatId))
      .catch(() => {});
    store.getAmazonConfig().then((a) => setAmazonConfigured(!!a)).catch(() => {});
    store.getUncategorizedStatus().then(setUncategorized).catch(() => {});
  }, [store]);

  /** Re-read everything the COMPANION can change behind this page's back. The
   *  page used to render once, so a tab left open froze at what it read on mount.
   *  On 2026-08-06 that produced a false alarm: `Last synced 1 day ago` and a
   *  resolved error banner still on screen while the companion had synced 33
   *  minutes earlier and cleared the error, sending us through the logs after a
   *  fault that no longer existed. Cheap by construction — local addon secrets,
   *  so nothing here touches the network or the bank. */
  const refreshLiveState = useCallback(() => {
    store.getLastSyncAt().then((d) => { if (d) setLastSyncAt(d); }).catch(() => {});
    store.getAccountBalances().then(setBalances).catch(() => {});
    store.getCompanionVersion().then(setCompanionVersion).catch(() => {});
    refreshDerivedSignals();
  }, [store, refreshDerivedSignals]);

  useEffect(() => {
    // The mount read too, so each live value has ONE reader rather than being
    // duplicated into the one-shot load below. Focus is the high-value trigger —
    // the stale-tab case is someone returning to a window they left open — and
    // the interval covers a focused tab while the companion's cron fires.
    refreshLiveState();
    const onFocus = () => refreshLiveState();
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(refreshLiveState, 60_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [refreshLiveState]);

  // Returning to Overview is the moment its derived signals can be wrong: the tab
  // that changes them (Notifications saving a token, Advanced saving Amazon
  // credentials) has just unmounted, so nothing reported the change.
  useEffect(() => {
    if (activeTab === 'overview') refreshDerivedSignals();
  }, [activeTab, refreshDerivedSignals]);

  const clearError = useCallback(() => {
    setError('');
    setErrorDetail(undefined);
  }, []);

  /** Switch tabs and remember it. Read-modify-write, because `ui_state` also
   *  carries `checklistDismissed` and a blind overwrite would bring a dismissed
   *  checklist back every time a tab is clicked. */
  const navigate = useCallback((tab: TabId) => {
    setActiveTab(tab);
    store.getUiState()
      .then((prev) => store.setUiState({ ...prev, activeTab: tab }))
      // Cosmetic — a failed write costs one remembered tab, not an error box.
      .catch(() => {});
  }, [store]);

  /** Surfaces a thrown error: its (possibly classified) message as the headline,
   *  any raw underlying text as a collapsed detail. The case this exists for: a
   *  network-level SimpleFin failure used to put the broker's own rejection
   *  straight in the box — `error sending request for url (https://…/accounts?
   *  start-date=…&pending=1)` — exposing an internal URL and telling the reader
   *  nothing actionable. `fetchAccounts` classifies that into a sentence and
   *  hands the raw text over on `detail`: nothing is swallowed, it is just no
   *  longer the headline. */
  const showThrownError = useCallback((e: any, fallback: string) => {
    setError(e?.message ?? fallback);
    const detail = typeof e?.detail === 'string' ? e.detail.trim() : '';
    // Never the message as its own "detail" — a disclosure that reveals the line
    // above it is pure noise.
    setErrorDetail(detail && detail !== e?.message ? detail : undefined);
  }, []);

  useEffect(() => {
    Promise.all([
      store.getAccountMapping(),
      store.getAccountNames(),
      store.getReportCategoryCatalog(),
      ctx.api.accounts.getAll().catch(() => []),
      store.getOpenCards(),
      store.getLastSyncImported(),
      // Which tab was last open, and whether the checklist was dismissed. One-shot:
      // nothing outside this page writes `ui_state`, so it cannot go stale.
      store.getUiState(),
    ]).then(([m, names, catalog, wfAccounts, cards, lastImported, ui]) => {
      setChecklistDismissed(ui.checklistDismissed === true);
      if (ui.activeTab) setActiveTab(ui.activeTab);
      // From storage, not just from a sync in this session: the tile says
      // "Imported last run", and the last run is usually the companion's.
      setImported(lastImported);
      setMapping(m ?? {});
      setSfinNames(names);
      setCategoryCatalog(catalog);
      setWfNames(Object.fromEntries(wfAccounts.map((a) => [a.id, a.name])));
      setOpenCards(cards);

      // Backfill for installs set up before account names were captured
      if (Object.keys(names).length === 0 && m && Object.keys(m).length > 0) {
        backfillNames();
      }
    });

    async function backfillNames() {
      try {
        const accessUrl = await store.getAccessUrl();
        if (!accessUrl) return;
        const authKey = await store.getAuthB64Key();
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const accountSet = await fetchAccounts(accessUrl, yesterday, ctx.api.network, authKey);
        const fetched = Object.fromEntries(accountSet.accounts.map((a) => [a.id, a.name]));
        await store.setAccountNames(fetched);
        setSfinNames(fetched);
      } catch {
        // Names are cosmetic — leave IDs visible rather than surface an error
      }
    }
  }, [store, ctx]);

  /** Record what a run deleted, and make sure the user can actually SEE it.
   *  `Sync now`/`Deep scan` are in the shell header and fire from any tab, but the
   *  itemised notice renders inside Overview — unmounted while another tab is
   *  active. Deleting rows from someone's ledger and reporting it into an
   *  unmounted component is silent data loss, so a non-empty list forces the tab
   *  that shows it. An empty one changes nothing: a routine run must not yank the
   *  user off the card they were reading. */
  const reportPruned = useCallback((pruned: SyncResult['prunedDuplicates']) => {
    // Always assigned, never appended: the banner describes THIS run, so a clean
    // run clears a previous one's list rather than leave it looking current.
    setPrunedDuplicates(pruned);
    if (pruned.length > 0) navigate('overview');
  }, [navigate]);

  const doSync = useCallback(async (force = false) => {
    setSyncing(true);
    clearError();
    setIntervalBlocked(false);
    try {
      const result = await runSync(ctx, store, { force });
      // A pure interval skip isn't an error — offer to force instead
      if (result.errors.length === 1 && result.errors[0] === INTERVAL_SKIP_MESSAGE) {
        setIntervalBlocked(true);
        // ...and re-read the timestamp: the skip is the moment we learn our copy
        // is stale. Header and callout both read `last_sync_at`, so "Last synced
        // 4 hours ago" beside "Last sync was under an hour ago, so Sync Now was
        // skipped" cannot both be current — the COMPANION synced against the same
        // instance and nothing re-read the secret. Only on a real value: a failed
        // read must not blank the header into "Never synced".
        const refreshed = await store.getLastSyncAt().catch(() => null);
        if (refreshed) setLastSyncAt(refreshed);
        return;
      }
      if (result.errors.length > 0) setError(result.errors.join('; '));
      setImported(result.imported);
      reportPruned(result.prunedDuplicates ?? []);
      // runSync stamps lastSyncAt and the balances itself; mirror them
      const last = await store.getLastSyncAt();
      setLastSyncAt(last);
      loadBalances();
    } catch (e: any) {
      showThrownError(e, 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [ctx, store, loadBalances, clearError, showThrownError, reportPruned]);

  // Heal: re-scan a wide window to recover missing transactions, then re-measure
  // drift so any residual can be plugged.
  const doHeal = useCallback(async () => {
    setHealing(true);
    clearError();
    try {
      const result = await runSync(ctx, store, { heal: true });
      if (result.errors.length > 0) setError(result.errors.join('; '));
      setImported(result.imported);
      reportPruned(result.prunedDuplicates ?? []);
      setLastSyncAt(await store.getLastSyncAt());
      loadBalances();
    } catch (e: any) {
      showThrownError(e, 'Reconcile failed');
    } finally {
      setHealing(false);
    }
  }, [ctx, store, loadBalances, clearError, showThrownError, reportPruned]);

  /** Read-modify-write, like `navigate`: `ui_state` also holds the active tab,
   *  which a blind overwrite would reset the moment a checklist is dismissed. */
  const dismissChecklist = useCallback(async () => {
    setChecklistDismissed(true);
    try {
      const prev = await store.getUiState();
      await store.setUiState({ ...prev, checklistDismissed: true });
    } catch {
      // Cosmetic — a failed write costs one re-dismissal, not an error box.
    }
  }, [store]);

  // Toggling persists, so the page doesn't reset every visit — the account rows
  // navigate away, so "come back and re-open the same three cards" was the real
  // cost of not storing it. `next` is computed outside the state updater: writing
  // a secret from inside one would fire twice under StrictMode.
  const toggleCard = (id: string) => {
    const next = { ...openCards, [id]: !openCards[id] };
    setOpenCards(next);
    store.setOpenCards(next).catch(() => {});
  };
  const isOpen = (id: string) => openCards[id] === true;

  return (
    <div className="sfin-page">
      <div className="sfin-head">
        <div>
          <h2 className="sfin-title">SimpleFin Sync</h2>
          <SyncStatus lastSyncAt={lastSyncAt} imported={imported} syncing={syncing} />
        </div>
        <div className="sfin-head-actions">
          {/* Always-available reconcile: the drift banner's "Re-scan 90 days" only
              appears on an off-balance account, so this keeps it reachable when
              everything reads "in sync". Plain-language label; the title keeps the
              term the docs, the logs and the companion use. */}
          <Button variant="outline" onClick={doHeal} disabled={healing || syncing}
            title="Re-scans the last 90 days and re-links transfer pairs (reconcile & link)">
            {healing ? 'Reconciling…' : 'Deep scan'}
          </Button>
          <Button onClick={() => doSync(false)} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync now'}
          </Button>
        </div>
      </div>

      {/* Both surfaces sit ABOVE the tab bar, outside every panel: they describe
          the page's last action, which can be started from any tab. */}
      {error && <ErrorBox detail={errorDetail}>{error}</ErrorBox>}

      {intervalBlocked && (
        <div className="sfin-callout">
          Last sync was under an hour ago, so Sync Now was skipped to avoid
          hammering SimpleFin.{' '}
          <Button variant="ghost" className="sfin-callout-action" onClick={() => doSync(true)} disabled={syncing}>
            Sync anyway
          </Button>
        </div>
      )}

      <TabBar tabs={TABS} active={activeTab} onChange={navigate} />

      {/* Everything a daily visit is for — what needs attention, what is still
          unfinished, the headline numbers, the accounts. */}
      <TabPanel tab="overview" active={activeTab}>
        <OverviewTab
          ctx={ctx}
          store={store}
          mapping={mapping}
          sfinNames={sfinNames}
          wfNames={wfNames}
          balances={balances}
          syncing={syncing}
          healing={healing}
          doHeal={doHeal}
          imported={imported}
          prunedDuplicates={prunedDuplicates}
          uncategorized={uncategorized}
          onBalancesChanged={loadBalances}
          onClearError={clearError}
          onError={showThrownError}
          companionVersion={companionVersion}
          telegramConfigured={telegramConfigured}
          amazonConfigured={amazonConfigured}
          checklistDismissed={checklistDismissed}
          onDismissChecklist={dismissChecklist}
          onNavigate={navigate}
        />
      </TabPanel>

      {/* Was ONE card called "Telegram Notifications (Optional)" holding six
          unrelated concerns and a Save button at the very bottom. */}
      <TabPanel tab="notifications" active={activeTab}>
        <NotificationsTab
          ctx={ctx}
          store={store}
          categories={categoryCatalog}
          isOpen={isOpen}
          toggleCard={toggleCard}
        />
      </TabPanel>

      {/* Configured once and then only checked, plus the destructive reset. */}
      <TabPanel tab="advanced" active={activeTab}>
        <AdvancedTab
          ctx={ctx}
          store={store}
          scheduler={scheduler}
          onReset={onReset}
          categories={categoryCatalog}
          isOpen={isOpen}
          toggleCard={toggleCard}
        />
      </TabPanel>

      {/* Both versions, because the halves deploy separately and a mismatch is the
          first thing worth knowing when behaviour looks wrong. A missing companion
          is normal (the addon syncs on its own), so it reads "not running" rather
          than as a fault. Outside every panel: it describes the install. */}
      <div className="sfin-subtle sfin-foot">
        addon v{SIMPLEFIN_SYNC_VERSION}
        {' · '}
        companion {companionVersion ? `v${companionVersion}` : 'not running'}
        {companionVersion && companionVersion !== SIMPLEFIN_SYNC_VERSION && (
          <span className="sfin-foot-warn">
            — versions differ; rebuild the companion to match
          </span>
        )}
      </div>
    </div>
  );
}
