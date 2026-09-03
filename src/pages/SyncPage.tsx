import React, { useEffect, useState, useCallback, useRef } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { runSync, INTERVAL_SKIP_MESSAGE } from '../utils/sync';
import { SIMPLEFIN_SYNC_VERSION } from '../../shared/version';
import type { SyncResult } from '../utils/sync';
import { fetchAccounts } from '../utils/simplefin';
import { SyncStatus } from '../components/SyncStatus';
import { Button, ErrorBox } from '../components/ui';
import { TabBar, type TabId } from '../components/Tabs';
import { BudgetTab } from '../tabs/BudgetTab';
import { OverviewTab } from '../tabs/OverviewTab';
import { NotificationsTab, useTelegramDraft } from '../tabs/NotificationsTab';
import { AdvancedTab } from '../tabs/AdvancedTab';
import { useAmazonDraft } from '../components/AmazonCard';
import type { SecretsStore, AccountBalanceInfo, CategoryCatalogEntry } from '../utils/secrets';
import type { Scheduler } from '../utils/scheduler';
import type { AccountMapping, UnmappedAccount } from '../../shared/types';
import { pruneDismissals, mergeDismissals, type DismissalLedger } from '../../shared/uncategorized';

/** Outside the component: a fresh literal each render would be a new `TabBar`
 *  prop identity for nothing. */
const TABS: Array<{ id: TabId; label: string }> = [
  // Budget leads: the reports are the daily-use surface, the rest is plumbing
  // you visit when something needs attention (decided with the user,
  // 2026-08-30 — see the Budget tab spec).
  { id: 'budget', label: 'Budget' },
  { id: 'overview', label: 'Overview' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'advanced', label: 'Advanced' },
];

/** Guards the hydration path. `ui_state` is an unvalidated stored blob (see
 *  `getUiState`) that now decides what renders, so a hand-edited secret — or a
 *  fourth tab written by a newer build the user then downgrades away from — would
 *  select no tab and mount no panel. A blank page with no way back is far worse
 *  than the wrong tab, so anything unrecognised falls back to Overview. */
function isKnownTab(id: unknown): id is TabId {
  return TABS.some((t) => t.id === id);
}

/** The panel half of the tabs contract: `TabBar` points each button at
 *  `sfin-panel-<id>`, and an inactive tab renders NOTHING — not a hidden div.
 *  `tabIndex={0}` because a panel whose content starts with plain text has
 *  nothing focusable in it, and tabbing off the tablist would skip the panel
 *  entirely rather than entering it (WAI-ARIA tabs pattern). */
function TabPanel({ tab, active, children }: {
  tab: TabId; active: TabId; children: React.ReactNode;
}) {
  if (tab !== active) return null;
  return (
    <div role="tabpanel" id={`sfin-panel-${tab}`} aria-labelledby={`sfin-tab-${tab}`} tabIndex={0}>
      {children}
    </div>
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
 * page. Tabs also UNMOUNT the inactive ones, so everything that cannot survive
 * its own panel disappearing lives here instead: `reportPruned`,
 * `refreshDerivedSignals`, `uncategorized`, and — because losing typed input is
 * in a different class of bad from losing a derived number — both config tabs'
 * unsaved drafts (`useTelegramDraft`, `useAmazonDraft`).
 */
export function SyncPage({ ctx, store, onReset, scheduler }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('budget');
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
  const [unmappedAccounts, setUnmappedAccounts] = useState<UnmappedAccount[]>([]);
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
  const [uncategorized, setUncategorized] = useState<
    Awaited<ReturnType<SecretsStore['getUncategorizedStatus']>>
  >(null);
  // The companion-published pool status behind the Overview tile — same
  // lifecycle as `uncategorized`: loaded here, refreshed on the same path.
  const [poolStatus, setPoolStatus] = useState<
    Awaited<ReturnType<SecretsStore['getPoolStatus']>>
  >(null);
  // The Budget tab's three inputs, loaded on the same refresh path.
  const [reportCube, setReportCube] = useState<
    Awaited<ReturnType<SecretsStore['getReportCube']>>
  >(null);
  const [customReports, setCustomReportsState] = useState<
    Awaited<ReturnType<SecretsStore['getCustomReports']>>
  >([]);
  const [budgetLayout, setBudgetLayoutState] = useState<
    Awaited<ReturnType<SecretsStore['getBudgetLayout']>>
  >(null);
  // Which uncategorized rows the user has dismissed. Lives HERE, not in
  // OverviewTab: `TabPanel` truly unmounts an inactive tab, and a dismissal held
  // in the tab would resurrect the moment someone came back from Advanced — the
  // same defect class that used to silently destroy typed Telegram/Amazon
  // credentials (see the drafts above).
  const [dismissals, setDismissals] = useState<DismissalLedger>({});

  /**
   * The two config tabs' UNSAVED DRAFTS, held here rather than inside the tabs
   * that edit them.
   *
   * `TabPanel` unmounts an inactive tab — that is the whole point of it — so a
   * draft owned by a tab dies on any tab switch, and re-reads storage on the way
   * back. What that cost in practice: a bot token or an IMAP app password typed,
   * the save bar saying "You have unsaved changes", one click on Overview to
   * check a balance, and back to an empty field with the bar now claiming
   * nothing was pending. Silent loss of something the user had typed, including
   * a credential they may have had to go and generate.
   *
   * Hoisting is the fix rather than a navigation guard: a guard has to be
   * remembered at every exit (the tab bar, the checklist deep links,
   * `reportPruned`), and the sandbox forbids the usual escape hatch —
   * `window.confirm` is silently suppressed here (iframe `sandbox="allow-scripts"`
   * with no `allow-modals`), so a "discard changes?" prompt would never appear
   * at all. Nothing is lost, so nothing needs to warn.
   */
  const telegramDraft = useTelegramDraft(store);
  const amazonDraft = useAmazonDraft(store);

  /**
   * Which hydrated fields the user has already acted on, so the mount load can
   * skip them.
   *
   * The load below is a `Promise.all` that includes an IPC round-trip
   * (`accounts.getAll`), so it can resolve hundreds of milliseconds after the
   * page is interactive — and it used to assign `activeTab`, `checklistDismissed`
   * and `openCards` unconditionally. Click Advanced, or the checklist's dismiss
   * button, inside that window and you were snapped back, with storage now
   * disagreeing with the screen.
   *
   * The dismissal was the case that could not recover: nothing else ever writes
   * `checklistDismissed`, so a dropped dismissal brings the checklist back on
   * every future session, permanently. A ref rather than state because it must
   * not re-render and must be readable from inside the resolved promise.
   */
  const hasUserActed = useRef({ tab: false, checklist: false, cards: false, dismissals: false });

  const loadBalances = useCallback(() => {
    store.getAccountBalances().then(setBalances).catch(() => {});
    // Read alongside the balances, and from the same secret every sync writes:
    // the run that finds a newly-linked account is usually the COMPANION's, so
    // this page has no return value to learn it from.
    //
    // Optional-called: a missing method throws SYNCHRONOUSLY, which `.catch`
    // does not see — it would take the balance refresh down with it. `?.`
    // short-circuits the whole chain instead, costing the banner and nothing
    // else.
    store.getUnmappedAccounts?.().then(setUnmappedAccounts).catch(() => {});
  }, [store]);

  /** The three values Overview DERIVES from storage rather than being told about
   *  by a sibling tab. Split out of `refreshLiveState` so returning to Overview
   *  re-reads exactly these, not the header's timestamp as well. */
  const refreshDerivedSignals = useCallback(() => {
    store.getTelegramConfig()
      .then((tg) => setTelegramConfigured(!!tg?.botToken && !!tg?.chatId))
      .catch(() => {});
    store.getAmazonConfig().then((a) => setAmazonConfigured(!!a)).catch(() => {});
    // Read TOGETHER and applied in one commit, not as two independent `.then`s:
    // the tile subtracts the ledger from the status, so a render that saw one
    // updated and the other not would show a count that disagrees with its own
    // list.
    //
    // Deliberately NOT guarded by `hasUserActed.dismissals`, unlike the mount
    // load: this is the only path that ever picks up a dismissal made somewhere
    // else — a Telegram button, another device — and freezing it after the first
    // in-addon dismissal would cost that for the whole session. The race it
    // leaves is a dismissal landing in the microtask between `setDismissals` and
    // its persist, which self-heals on the next refresh.
    Promise.all([
      store.getUncategorizedStatus(),
      store.getDismissals(),
      // Optional-called like the draft loads above: an older store without the
      // method must not take the whole refresh down.
      store.getPoolStatus?.() ?? null,
      store.getReportCube?.() ?? null,
      store.getCustomReports?.() ?? [],
      store.getBudgetLayout?.() ?? null,
    ])
      .then(([status, ledger, pool, cube, reports, layoutStored]) => {
        setUncategorized(status);
        setDismissals(ledger);
        setPoolStatus(pool ?? null);
        setReportCube(cube ?? null);
        setCustomReportsState(reports ?? []);
        setBudgetLayoutState(layoutStored ?? null);
      })
      .catch(() => {});
  }, [store]);

  const onDismissalsChange = useCallback((next: DismissalLedger) => {
    hasUserActed.current.dismissals = true;
    const base = dismissals;
    setDismissals(next);
    // Merged against what is persisted RIGHT NOW rather than written whole: the
    // companion writes this same secret, and there is no compare-and-swap, so a
    // whole-object write from this page's snapshot would erase a dismissal the
    // Telegram half made since the last refresh. Pruned on write so the secret
    // cannot grow without bound; both hosts prune through the same helper.
    store.getDismissals()
      .then((persisted) => store.setDismissals(
        pruneDismissals(mergeDismissals(persisted, base, next), new Date()),
      ))
      .catch(() => {});
  }, [store, dismissals]);

  // Budget-tab writers: optimistic state plus a guarded persist, like every
  // other setting on this page.
  const onBudgetLayoutChange = useCallback((next: NonNullable<Awaited<ReturnType<SecretsStore['getBudgetLayout']>>>) => {
    setBudgetLayoutState(next);
    store.setBudgetLayout?.(next)?.catch(() => {});
  }, [store]);
  const onBudgetLayoutReset = useCallback(() => {
    setBudgetLayoutState(null);
    // Optional-called like every store method added after 1.0: an older
    // SecretsStore simply has no stored layout worth deleting.
    store.clearBudgetLayout?.()?.catch(() => {});
  }, [store]);
  const onCustomReportsChange = useCallback((next: Awaited<ReturnType<SecretsStore['getCustomReports']>>) => {
    setCustomReportsState(next);
    store.setCustomReports?.(next)?.catch(() => {});
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
    // Belongs in THIS reader, not just the post-sync one: discovering a
    // newly-linked account is precisely something the companion does behind
    // this page's back, and a page that only learned it from its own sync
    // would stay silent for a user whose syncing is entirely the companion's.
    //
    // Optional-called: a missing method throws SYNCHRONOUSLY, which `.catch`
    // never sees — it would take the whole refresh down with it.
    store.getUnmappedAccounts?.().then(setUnmappedAccounts).catch(() => {});
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
    if (activeTab === 'overview' || activeTab === 'budget') refreshDerivedSignals();
  }, [activeTab, refreshDerivedSignals]);

  const clearError = useCallback(() => {
    setError('');
    setErrorDetail(undefined);
  }, []);

  /** Switch tabs and remember it. Read-modify-write, because `ui_state` also
   *  carries `checklistDismissed` and a blind overwrite would bring a dismissed
   *  checklist back every time a tab is clicked. */
  const navigate = useCallback((tab: TabId, openCardId?: string) => {
    // Before the state change, so a load that resolves later leaves it alone.
    hasUserActed.current.tab = true;
    setActiveTab(tab);
    // A banner that says "map it under Advanced → Accounts" has to LAND the
    // user on that card. Without this the CTA dropped them on a tab of five
    // collapsed cards with the relevant one shut — and since the card fetches
    // its account list on open, nothing loaded either.
    if (openCardId) {
      hasUserActed.current.cards = true;
      setOpenCards((prev) => {
        if (prev[openCardId]) return prev;
        const next = { ...prev, [openCardId]: true };
        store.setOpenCards(next).catch(() => {});
        return next;
      });
    }
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
      // The dismissal ledger, loaded once here and refreshed thereafter on the
      // same path as the status (`refreshDerivedSignals`) — see `dismissals`.
      store.getDismissals(),
    ]).then(([m, names, catalog, wfAccounts, cards, lastImported, ui, loadedDismissals]) => {
      // The four the user can beat to the punch — this waits on an IPC
      // round-trip, so "resolves after the first click" is ordinary, not a race
      // you have to try to hit. A stored value must never overwrite a deliberate
      // action; see `hasUserActed`. Everything below them is load-only data no
      // interaction can contradict, so it is assigned unconditionally.
      if (!hasUserActed.current.checklist) setChecklistDismissed(ui.checklistDismissed === true);
      if (!hasUserActed.current.tab && isKnownTab(ui.activeTab)) setActiveTab(ui.activeTab);
      if (!hasUserActed.current.cards) setOpenCards(cards);
      // Guarded for the same reason, one step further: a dismissal made while
      // this was in flight is already persisted, so letting the pre-dismissal
      // snapshot land would put the row and the count back for up to a minute
      // and read as the button not working.
      if (!hasUserActed.current.dismissals) setDismissals(loadedDismissals ?? {});
      // From storage, not just from a sync in this session: the tile says
      // "Imported last run", and the last run is usually the companion's.
      setImported(lastImported);
      setMapping(m ?? {});
      setSfinNames(names);
      setCategoryCatalog(catalog);
      setWfNames(Object.fromEntries(wfAccounts.map((a) => [a.id, a.name])));

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
    // Through `navigate`, so this also PERSISTS `activeTab: 'overview'`: it
    // overwrites the tab the user deliberately chose, and survives a reload.
    // Deliberate — the notice describes only the last run, so a reload that put
    // them back on Advanced would hide it again with no way to get it back. One
    // forgotten tab preference is the right price for not losing that record.
    //
    // And a forgotten tab preference is now the WHOLE price. `Sync now` sits in
    // the shell header and fires from any tab, so this can yank someone off a
    // half-filled form — which used to mean unmounting their draft and losing it.
    // It no longer can: both config drafts are held here in the shell (see
    // `useTelegramDraft` / `useAmazonDraft`), so the panel unmounting costs
    // nothing but the panel, and going back to the tab shows every field and the
    // unsaved-changes bar exactly as they were left.
    if (pruned.length > 0) navigate('overview');
  }, [navigate]);

  /**
   * Record that the user does not want these accounts synced, and drop the
   * banner immediately rather than waiting for a sync to re-derive it.
   *
   * Merged into whatever is already stored, never replacing it: two rounds of
   * ignoring (a new account appears, gets ignored too) must not un-ignore the
   * first. The local state update is what makes the button feel like it did
   * something — the persisted list only re-reads on the next sync.
   */
  const ignoreAccounts = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    setUnmappedAccounts((prev) => prev.filter((a) => !ids.includes(a.sfinAccountId)));
    try {
      const existing = (await store.getIgnoredAccounts?.()) ?? [];
      await store.setIgnoredAccounts?.([...new Set([...existing, ...ids])]);
    } catch (e: any) {
      // Put the banner back: a failed write means the next sync will report
      // these again anyway, and hiding them here would be a lie.
      showThrownError(e, 'Could not save that preference');
      store.getUnmappedAccounts?.().then(setUnmappedAccounts).catch(() => {});
    }
  }, [store, showThrownError]);

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
        // 4 hours ago" beside "Last sync was under an hour ago, so Sync now was
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
    hasUserActed.current.checklist = true;
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
    hasUserActed.current.cards = true;
    const next = { ...openCards, [id]: !openCards[id] };
    setOpenCards(next);
    store.setOpenCards(next).catch(() => {});
  };
  const isOpen = (id: string) => openCards[id] === true;

  return (
    <div className={`sfin-page${activeTab === 'budget' ? ' sfin-page--wide' : ''}`}>
      <div className="sfin-head">
        <div>
          <h2 className="sfin-title">SimpleFin Sync</h2>
          <SyncStatus lastSyncAt={lastSyncAt} imported={imported} syncing={syncing} />
        </div>
        <div className="sfin-head-actions">
          {/* Always-available reconcile: the drift banner's own "Deep scan" only
              appears on an off-balance account, so this keeps it reachable when
              everything reads "in sync". Same label in both places — one operation
              (one `healing` flag) must not have two names. Plain-language label;
              the title keeps the term the docs, the logs and the companion use. */}
          <Button variant="outline" onClick={doHeal} disabled={healing || syncing}
            title="Re-scans the last 90 days and re-links transfer pairs (reconcile & link)">
            {healing ? 'Deep scanning…' : 'Deep scan'}
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
          Last sync was under an hour ago, so Sync now was skipped to avoid
          hammering SimpleFin.{' '}
          <Button variant="ghost" className="sfin-callout-action" onClick={() => doSync(true)} disabled={syncing}>
            Sync anyway
          </Button>
        </div>
      )}

      <TabBar tabs={TABS} active={activeTab} onChange={navigate} />

      {/* Everything a daily visit is for — what needs attention, what is still
          unfinished, the headline numbers, the accounts. */}
      <TabPanel tab="budget" active={activeTab}>
        <BudgetTab
          cube={reportCube}
          customReports={customReports}
          layout={budgetLayout}
          onLayoutChange={onBudgetLayoutChange}
          onLayoutReset={onBudgetLayoutReset}
          onCustomReportsChange={onCustomReportsChange}
          store={store}
        />
      </TabPanel>

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
          unmappedAccounts={unmappedAccounts}
          onIgnoreAccounts={ignoreAccounts}
          uncategorized={uncategorized}
          poolStatus={poolStatus}
          dismissals={dismissals}
          onDismissalsChange={onDismissalsChange}
          isOpen={isOpen}
          toggleCard={toggleCard}
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
          draft={telegramDraft}
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
          amazon={amazonDraft}
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
