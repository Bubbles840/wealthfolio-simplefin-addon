import React, { useEffect, useState, useCallback } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { runSync, INTERVAL_SKIP_MESSAGE } from '../utils/sync';
import { SIMPLEFIN_SYNC_VERSION } from '../../shared/version';
import type { SyncResult } from '../utils/sync';
import { fetchAccounts } from '../utils/simplefin';
import { SyncStatus } from '../components/SyncStatus';
import { RuleEditor } from '../components/RuleEditor';
import { Button, CollapsibleCard, ErrorBox } from '../components/ui';
import { AmazonCard } from '../components/AmazonCard';
import { OverviewTab } from '../tabs/OverviewTab';
import { NotificationsTab } from '../tabs/NotificationsTab';
import type { SecretsStore, AccountBalanceInfo, CategoryCatalogEntry } from '../utils/secrets';
import type { Scheduler } from '../utils/scheduler';
import type { AccountMapping, MappingRule } from '../../shared/types';

interface Props {
  ctx: AddonContext;
  store: SecretsStore;
  onReset: () => void;
  scheduler: Scheduler;
}

/** Ids for the collapsible config cards. Doubles as the persisted key set, so
 *  renaming one silently forgets that card's last state — which is fine. The
 *  Telegram cards own their own ids; see `NOTIF_CARD` in NotificationsTab. */
const CARD = {
  autoSync: 'auto-sync',
  docker: 'docker',
  amazon: 'amazon',
  amazonGuide: 'amazon-guide',
  rules: 'rules',
} as const;

export function SyncPage({ ctx, store, onReset, scheduler }: Props) {
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [imported, setImported] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [mapping, setMapping] = useState<AccountMapping>({});
  const [rules, setRules] = useState<MappingRule[]>([]);
  const [scheduleHours, setScheduleHours] = useState<number | null>(null);
  const [error, setError] = useState('');
  // The raw underlying text behind a classified error (see
  // `SimplefinRequestError.detail`). Held separately so the box can show a
  // readable message WITHOUT the diagnosis being discarded.
  const [errorDetail, setErrorDetail] = useState<string | undefined>(undefined);
  const [intervalBlocked, setIntervalBlocked] = useState(false);
  // What the last run's reconcile sweep DELETED as duplicate copies. Shown
  // because the deletion is automatic and Telegram is optional: the page is the
  // one place a user is guaranteed to be able to see what vanished.
  const [prunedDuplicates, setPrunedDuplicates] = useState<SyncResult['prunedDuplicates']>([]);
  const [sfinNames, setSfinNames] = useState<Record<string, string>>({});
  const [wfNames, setWfNames] = useState<Record<string, string>>({});
  const [balances, setBalances] = useState<Record<string, AccountBalanceInfo>>({});
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [healing, setHealing] = useState(false);
  const [autoHeal, setAutoHeal] = useState(false);
  const [autoAdjust, setAutoAdjust] = useState(false);
  // Both only feed the Overview checklist, which self-completes from real
  // signals rather than from steps the user ticked off.
  const [amazonConfigured, setAmazonConfigured] = useState(false);
  const [checklistDismissed, setChecklistDismissed] = useState(false);
  // Which companion build last synced this instance. Null until one has run —
  // the addon works standalone, so no companion is a normal state, not an error.
  const [companionVersion, setCompanionVersion] = useState<string | null>(null);
  // Every collapsible section's open state in one map, replacing the three
  // one-off `show*` booleans this page used to carry. Shared with the
  // Notifications tab, whose cards persist their open state the same way.
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({});
  // The full catalog (all 52 spending categories). Read once here because two
  // things need it: the Amazon card's per-label pickers and the report matrix.
  const [categoryCatalog, setCategoryCatalog] = useState<CategoryCatalogEntry[]>([]);
  // Reported up by the Notifications tab, which owns the Telegram fields. Only
  // the Overview checklist consumes it.
  const [telegramConfigured, setTelegramConfigured] = useState(false);

  const loadBalances = useCallback(() => {
    store.getAccountBalances().then(setBalances).catch(() => {});
  }, [store]);

  /**
   * Re-read everything the COMPANION can change behind this page's back.
   *
   * The page used to render once, so a tab left open froze at whatever it read
   * on mount. On 2026-08-06 that produced a false alarm: `Last synced 1 day ago`
   * and a resolved error banner were still on screen while the companion had
   * synced 33 minutes earlier and cleared the error, which sent us through the
   * logs looking for a fault that no longer existed.
   *
   * Cheap by construction — these are local addon secrets, not SimpleFin calls,
   * so nothing here touches the network or the bank.
   */
  const refreshLiveState = useCallback(() => {
    store.getLastSyncAt().then((d) => { if (d) setLastSyncAt(d); }).catch(() => {});
    store.getAccountBalances().then(setBalances).catch(() => {});
    store.getCompanionVersion().then(setCompanionVersion).catch(() => {});
  }, [store]);

  useEffect(() => {
    // Focus is the high-value trigger: the stale-tab case is precisely someone
    // coming back to a window they left open. The interval covers a tab that
    // stays focused while the companion's cron fires.
    const onFocus = () => refreshLiveState();
    window.addEventListener('focus', onFocus);
    const timer = window.setInterval(refreshLiveState, 60_000);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
  }, [refreshLiveState]);

  const clearError = useCallback(() => {
    setError('');
    setErrorDetail(undefined);
  }, []);

  /**
   * Surfaces a thrown error: its (possibly classified) message as the headline,
   * and any raw underlying text as a collapsed detail.
   *
   * The case this exists for: a network-level SimpleFin failure used to put the
   * broker's own rejection straight in the box — `error sending request for url
   * (https://…/accounts?start-date=…&pending=1)` — which exposed an internal URL
   * and told the reader nothing they could act on. `fetchAccounts` now classifies
   * that into a sentence and hands the raw text over on `detail`; nothing is
   * swallowed, it is just no longer the headline. An error with no `detail` (every
   * other error in the app) renders exactly as before.
   */
  const showThrownError = useCallback((e: any, fallback: string) => {
    setError(e?.message ?? fallback);
    const detail = typeof e?.detail === 'string' ? e.detail.trim() : '';
    // Never repeat the message as its own "detail" — a disclosure that reveals
    // the line above it is pure noise.
    setErrorDetail(detail && detail !== e?.message ? detail : undefined);
  }, []);

  useEffect(() => {
    Promise.all([
      store.getLastSyncAt(),
      store.getAccountMapping(),
      store.getMappingRules(),
      store.getSyncScheduleHours(),
      store.getAccountNames(),
      store.getAccountBalances(),
      store.getAutoHeal(),
      store.getAutoAdjust(),
      store.getReportCategoryCatalog(),
      ctx.api.accounts.getAll().catch(() => []),
      store.getOpenCards(),
      store.getLastSyncImported(),
      // The first two answer a checklist row: "is Amazon categorization set up?"
      // and "has this checklist already been dismissed?". The companion version
      // was previously read ONLY by `refreshLiveState`, so for the first minute
      // after mount the footer said "companion not running" and the checklist
      // would have claimed background sync was unconfigured on a machine where
      // it has been running for months. Same state, read one moment earlier.
      store.getAmazonConfig(),
      store.getUiState(),
      store.getCompanionVersion(),
    ]).then(([last, m, r, h, names, bal, ah, aa, catalog, wfAccounts, cards, lastImported, amazon, ui, companion]) => {
      setLastSyncAt(last);
      setAmazonConfigured(!!amazon);
      setChecklistDismissed(ui.checklistDismissed === true);
      setCompanionVersion(companion);
      // From storage, not just from a sync in this page session: the tile says
      // "Imported last run", and the last run is usually the companion's.
      setImported(lastImported);
      setMapping(m ?? {});
      setRules(r);
      setScheduleHours(h);
      setSfinNames(names);
      setBalances(bal);
      setAutoHeal(ah);
      setAutoAdjust(aa);
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

  const doSync = useCallback(async (force = false) => {
    setSyncing(true);
    clearError();
    setIntervalBlocked(false);
    try {
      const result = await runSync(ctx, store, { force });
      // A pure interval skip isn't an error — offer to force instead
      if (result.errors.length === 1 && result.errors[0] === INTERVAL_SKIP_MESSAGE) {
        setIntervalBlocked(true);
        // ...and re-read the timestamp, because the skip is precisely the moment
        // we learn our copy of it is stale. The header and this callout both read
        // `last_sync_at`, so "Last synced 4 hours ago" beside "Last sync was under
        // an hour ago, so Sync Now was skipped" cannot both be current: the page
        // loaded a value, the COMPANION then synced against the same instance and
        // updated the secret, and nothing re-read it. Without this the two
        // statements on screen contradict each other.
        // Only on a real value: a failed read must not blank the header into
        // "Never synced", which would be a worse lie than a stale timestamp.
        const refreshed = await store.getLastSyncAt().catch(() => null);
        if (refreshed) setLastSyncAt(refreshed);
        return;
      }
      if (result.errors.length > 0) setError(result.errors.join('; '));
      setImported(result.imported);
      // Always assigned, never appended: the banner describes THIS run, so a
      // clean run has to clear a previous one's list rather than leave it on
      // screen looking current. (The sweep is heal-only, so a routine sync
      // legitimately clears it.)
      setPrunedDuplicates(result.prunedDuplicates ?? []);
      // runSync stamps lastSyncAt and the balances itself; mirror them
      const last = await store.getLastSyncAt();
      setLastSyncAt(last);
      loadBalances();
    } catch (e: any) {
      showThrownError(e, 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [ctx, store, loadBalances, clearError, showThrownError]);

  // Heal: re-scan a wide window to recover missing transactions, then re-measure
  // drift so any residual can be plugged.
  const doHeal = useCallback(async () => {
    setHealing(true);
    clearError();
    try {
      const result = await runSync(ctx, store, { heal: true });
      if (result.errors.length > 0) setError(result.errors.join('; '));
      setImported(result.imported);
      setPrunedDuplicates(result.prunedDuplicates ?? []);
      setLastSyncAt(await store.getLastSyncAt());
      loadBalances();
    } catch (e: any) {
      showThrownError(e, 'Reconcile failed');
    } finally {
      setHealing(false);
    }
  }, [ctx, store, loadBalances, clearError, showThrownError]);

  /** Read-modify-write: `ui_state` also holds the active tab, which a blind
   *  overwrite would reset to "overview" the moment a checklist is dismissed. */
  const dismissChecklist = useCallback(async () => {
    setChecklistDismissed(true);
    try {
      const prev = await store.getUiState();
      await store.setUiState({ ...prev, checklistDismissed: true });
    } catch {
      // Cosmetic state — a failed write costs the user one re-dismissal, and an
      // error box about it would be noisier than the checklist coming back.
    }
  }, [store]);

  // window.confirm is silently suppressed in the addon sandbox (iframe has
  // sandbox="allow-scripts" without allow-modals), so confirmation must be
  // rendered inline instead
  const handleReset = async () => {
    scheduler.stop();
    await store.clearAll();
    onReset();
  };

  const changeInterval = async (hours: number) => {
    setScheduleHours(hours);
    await store.setSyncScheduleHours(hours);
    scheduler.stop();
    if (hours > 0) {
      scheduler.start(hours, () => store.getLastSyncAt(), () => runSync(ctx, store));
    }
  };

  // Toggling persists, so the page doesn't reset every visit — the account rows
  // navigate away, so "come back and re-open the same three cards" was the
  // realistic cost of not storing this. `next` is computed outside the state
  // updater: writing a secret from inside one would fire twice under StrictMode.
  const toggleCard = (id: string) => {
    const next = { ...openCards, [id]: !openCards[id] };
    setOpenCards(next);
    store.setOpenCards(next).catch(() => {});
  };
  const isOpen = (id: string) => openCards[id] === true;

  // ── Collapsed-header summaries ───────────────────────────────────────────
  // Each collapsible card reports its own configuration as text in its header,
  // so a closed card still answers "is this on, and set to what?". Without
  // these, collapsing would be hiding state rather than hiding chrome.
  const autoSyncSummary = `${scheduleHours ? `Every ${scheduleHours}h` : 'Off'} · ${
    autoAdjust ? 'aggressive auto-heal' : autoHeal ? 'auto-heal on' : 'auto-heal off'
  }`;

  const rulesSummary =
    rules.length === 0
      ? 'None — using the +/− defaults'
      : `${rules.length} rule${rules.length === 1 ? '' : 's'}`;

  return (
    <div className="sfin-page">
      <div className="sfin-head">
        <div>
          <h2 className="sfin-title">SimpleFin Sync</h2>
          <SyncStatus lastSyncAt={lastSyncAt} imported={imported} syncing={syncing} />
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* Always-available reconcile: re-scans a wide window, re-links transfer
              pairs, and self-heals the link ledger. The "Re-scan 90 days" button
              in the drift banner only appears when an account is off-balance, so
              this keeps reconcile reachable when everything reads "in sync". */}
          <Button variant="outline" onClick={doHeal} disabled={healing || syncing}
            title="Re-scan a wide window and re-link internal transfer pairs">
            {healing ? 'Reconciling…' : '↻ Reconcile & link'}
          </Button>
          <Button onClick={() => doSync(false)} disabled={syncing}>
            {syncing ? 'Syncing…' : '↻ Sync Now'}
          </Button>
        </div>
      </div>

      {error && <ErrorBox detail={errorDetail}>{error}</ErrorBox>}

      {intervalBlocked && (
        <div className="sfin-callout" style={{ marginBottom: 16 }}>
          Last sync was under an hour ago, so Sync Now was skipped to avoid
          hammering SimpleFin.{' '}
          <Button variant="ghost" onClick={() => doSync(true)} disabled={syncing} style={{ marginLeft: 4 }}>
            Sync anyway
          </Button>
        </div>
      )}

      {/* Everything a daily visit is for — what needs attention, what is still
          unfinished, the headline numbers, the accounts — in one component.
          Rendered inline for now: the tab bar arrives in a later task, at which
          point `onNavigate` starts switching tabs instead of doing nothing. */}
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
        onBalancesChanged={loadBalances}
        onClearError={clearError}
        onError={showThrownError}
        companionVersion={companionVersion}
        telegramConfigured={telegramConfigured}
        amazonConfigured={amazonConfigured}
        checklistDismissed={checklistDismissed}
        onDismissChecklist={dismissChecklist}
        onNavigate={() => {}}
      />

      {/* Everything below here is configured once and then only checked, so it
          collapses. The header summary is the compensation: you can read the
          setting without opening the card. */}
      <CollapsibleCard
        id={CARD.autoSync}
        title="Auto-Sync"
        summary={autoSyncSummary}
        open={isOpen(CARD.autoSync)}
        onToggle={() => toggleCard(CARD.autoSync)}
      >
        <div className="sfin-field-row">
          <label htmlFor="sfin-interval" className="sfin-section-label">
            Auto-Sync interval
          </label>
          <select
            id="sfin-interval"
            className="sfin-select"
            value={scheduleHours ?? 0}
            onChange={(e) => changeInterval(Number(e.target.value))}
          >
            <option value={0}>Off</option>
            <option value={1}>Every 1 hour</option>
            <option value={4}>Every 4 hours</option>
            <option value={8}>Every 8 hours</option>
            <option value={24}>Every 24 hours</option>
          </select>
        </div>
        <div className="sfin-subtle" style={{ marginTop: 6 }}>
          Syncs when this page is open and it&apos;s been this long since the last run.
        </div>

        <div className="sfin-checks" style={{ marginTop: 14 }}>
          <label className="sfin-check">
            <input
              type="checkbox"
              checked={autoHeal}
              onChange={async (e) => {
                setAutoHeal(e.target.checked);
                await store.setAutoHeal(e.target.checked);
              }}
            />
            <span>
              <span className="sfin-check-name">Auto-heal</span>
              <span className="sfin-subtle">
                {' '}— re-scan ~45 days each sync to catch missing transactions and check
                balances. Balance adjustments stay manual.
              </span>
            </span>
          </label>

          <label className="sfin-check">
            <input
              type="checkbox"
              checked={autoAdjust}
              onChange={async (e) => {
                setAutoAdjust(e.target.checked);
                await store.setAutoAdjust(e.target.checked);
              }}
            />
            <span>
              <span className="sfin-check-name">Aggressively auto-heal</span>
              <span className="sfin-subtle">
                {' '}— also auto-insert balance adjustments for any residual, without asking
                (includes the re-scan). Forces balances to match your bank on every sync.
              </span>
            </span>
          </label>
        </div>
      </CollapsibleCard>

      {/* Its own card rather than a nested disclosure inside Auto-Sync: with
          both collapsed the two headers cost less than a card containing a
          second collapse control, and each gets a summary of its own. There is
          no state to report here — the addon cannot see whether the container
          is running — so the summary says what it is for. */}
      <CollapsibleCard
        id={CARD.docker}
        title="Background sync (Docker, optional)"
        summary="Keeps syncing even when Wealthfolio is closed"
        open={isOpen(CARD.docker)}
        onToggle={() => toggleCard(CARD.docker)}
      >
        <div>
          <div className="sfin-subtle" style={{ marginBottom: 6 }}>
            Add this service to your <code>docker-compose.yml</code>. You can customize the sync rate via <code>SYNC_SCHEDULE</code>:
          </div>
          <pre className="sfin-pre" style={{ margin: 0 }}>
            {`services:
  simplefin-sync:
    image: ghcr.io/bubbles840/wealthfolio-simplefin-sync:latest
    container_name: simplefin-sync
    restart: always
    network_mode: host
    environment:
      - WEALTHFOLIO_API_URL=http://127.0.0.1:8088
      - WEALTHFOLIO_PASSWORD=your_wealthfolio_password
      - SYNC_SCHEDULE=0 */6 * * *          # Change cron schedule here (e.g. 0 */3 * * * for every 3h)
      - MIN_SYNC_INTERVAL_HOURS=1          # Minimum interval cooldown between syncs`}
          </pre>
        </div>
      </CollapsibleCard>

      {/* Directly below the Docker card: it is the companion that reads the
          mailbox, so this is only useful to someone who has just set that up. */}
      <AmazonCard
        store={store}
        cardId={CARD.amazon}
        guideId={CARD.amazonGuide}
        open={isOpen(CARD.amazon)}
        guideOpen={isOpen(CARD.amazonGuide)}
        onToggle={() => toggleCard(CARD.amazon)}
        onToggleGuide={() => toggleCard(CARD.amazonGuide)}
        categories={categoryCatalog}
      />

      {/* Was ONE card called "Telegram Notifications (Optional)" holding six
          unrelated concerns and a Save button at the very bottom. Now three
          cards and a dirty-state save bar, inside a tab component. Rendered
          inline for now: the tab bar arrives in a later task. */}
      <NotificationsTab
        ctx={ctx}
        store={store}
        categories={categoryCatalog}
        isOpen={isOpen}
        toggleCard={toggleCard}
        onConfiguredChange={setTelegramConfigured}
      />

      {/* The card's own open state replaces the old "Edit"/"Done" toggle: this
          card had a read-only list AND a disclosure to reach the editor, which
          was two controls for one question. The header summary now answers "do
          I have rules?", and opening goes straight to the editor — which lists
          every rule and restates the +/− defaults itself, so nothing is lost. */}
      <CollapsibleCard
        id={CARD.rules}
        title="Transaction Rules"
        summary={rulesSummary}
        open={isOpen(CARD.rules)}
        onToggle={() => toggleCard(CARD.rules)}
      >
        <RuleEditor
          rules={rules}
          onChange={async (r) => {
            setRules(r);
            await store.setMappingRules(r);
          }}
        />
      </CollapsibleCard>

      <div className="sfin-callout" style={{ marginTop: 16, marginBottom: 0 }}>
        💡 Imported bank transactions appear under <strong>Activities</strong>. To see them in the{' '}
        <strong>Spending</strong> tab with categories and budgets, enable the Spending Tracker for
        your mapped accounts: <strong>Settings → Spending Tracker</strong>.
      </div>

      <div style={{ marginTop: 16 }}>
        {confirmingReset ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="sfin-subtle">Reset all SimpleFin Sync settings? You will need to reconnect.</span>
            <Button variant="destructive" onClick={handleReset}>Yes, reset everything</Button>
            <Button variant="ghost" onClick={() => setConfirmingReset(false)}>Cancel</Button>
          </div>
        ) : (
          <Button variant="destructive" onClick={() => setConfirmingReset(true)}>Reset Setup</Button>
        )}
      </div>

      {/* Both versions, because the two halves deploy separately and a mismatch
          is the first thing worth knowing when behaviour looks wrong. A missing
          companion is normal (the addon syncs on its own), so it reads "not
          running" rather than as a fault. */}
      <div className="sfin-subtle" style={{ marginTop: 20, fontSize: 11 }}>
        addon v{SIMPLEFIN_SYNC_VERSION}
        {' · '}
        companion {companionVersion ? `v${companionVersion}` : 'not running'}
        {companionVersion && companionVersion !== SIMPLEFIN_SYNC_VERSION && (
          <span style={{ marginLeft: 6, opacity: 0.9 }}>
            — versions differ; rebuild the companion to match
          </span>
        )}
      </div>
    </div>
  );
}
