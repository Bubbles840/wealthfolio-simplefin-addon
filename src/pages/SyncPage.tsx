import React, { useEffect, useState, useCallback } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { runSync, INTERVAL_SKIP_MESSAGE, applyBalanceAdjustment, applyBaselineCorrection } from '../utils/sync';
import { BASELINE_FIX_MIN_DRIFT_AGE_MS } from '../../shared/sync-core';
import { SIMPLEFIN_SYNC_VERSION } from '../../shared/version';

/** The offer a sync attaches to an account when it proved the drift belongs to
 *  the starting-balance baseline rather than to any transaction. */
type BaselineFixOffer = {
  activityId: string;
  currentAmount: number;
  suggestedAmount: number;
};
import type { SyncResult } from '../utils/sync';
import { fetchAccounts } from '../utils/simplefin';
import { SyncStatus } from '../components/SyncStatus';
import { CategoryIcon } from '../components/CategoryIcon';
import { GlyphPicker } from '../components/GlyphPicker';
import { RuleEditor } from '../components/RuleEditor';
import { Button, Card, CollapsibleCard, Disclosure, ErrorBox, SectionLabel } from '../components/ui';
import { sendTelegramMessage, getCategoryEmoji } from '../../shared/telegram';
// The real default the sync engine applies when driftAlertThreshold is absent,
// imported rather than re-typed so the field can never disagree with it.
import { DEFAULT_DRIFT_ALERT_THRESHOLD_DOLLARS } from '../../shared/sync-core';
import type { SecretsStore, AccountBalanceInfo, CategoryCatalogEntry } from '../utils/secrets';
import type { Scheduler } from '../utils/scheduler';
import type { AccountMapping, MappingRule } from '../../shared/types';

interface Props {
  ctx: AddonContext;
  store: SecretsStore;
  onReset: () => void;
  scheduler: Scheduler;
}

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 13l4 4L19 7" />
  </svg>
);
const AlertIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 8v5M12 16h.01" />
  </svg>
);

function money(amount: number, currency = 'USD'): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Two-character badge from an account name: "Spend (1234)" → "SP". */
function initials(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, '');
  return (clean.slice(0, 2) || '••').toUpperCase();
}

/** Tone class for the Telegram status line. Keyed off the ✅/❌ prefix the
 *  message already carries, so nothing is signalled by colour alone. */
function telegramStatusTone(status: string): string {
  if (status.startsWith('✅')) return 'sfin-status--ok';
  if (status.startsWith('❌')) return 'sfin-status--err';
  return 'sfin-status--busy';
}

function formatAsOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/** Amount the "Large transaction alerts" field is seeded with. Purely a UI
 *  suggestion: the stored default is OFF (see `largeTransactionThreshold`), so
 *  this number only ever reaches storage once the user ticks the box. */
const SUGGESTED_LARGE_TX_THRESHOLD = 500;

/** Mirrors the companion's `DEFAULT_WEEKLY_TOP_SPEND_COUNT`, which is module-
 *  private in companion/src/index.ts and so cannot be imported across the
 *  package boundary. Keep the two in step. */
const DEFAULT_WEEKLY_TOP_SPEND_COUNT = 5;

/**
 * The two dollar thresholds mean opposite things when absent — `largeTransaction`
 * is OFF, `driftAlert` is ON at $100 — so neither can be expressed by an empty
 * number field. Each gets an explicit checkbox instead, and saving always writes
 * a number: the amount when on, `0` (which both readers treat as off) when off.
 * That is what lets a user actually turn drift alerts off instead of clearing
 * the field and silently getting the $100 default back.
 */
function thresholdToSave(on: boolean, raw: string, fallback: number): number {
  if (!on) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * `weeklyTopSpendCount` sits between the two: absent means ON at the default of
 * 5 (like the drift threshold), but `0` is also a value the user can legitimately
 * type, and it already means "hide the section" to every reader — so unticking
 * and "ticked, with 0 in the box" deliberately collapse onto the same stored `0`.
 *
 * That collapse is safe because the round trip is stable in one step: a stored 0
 * reloads UNTICKED with the number field back at its default (never showing the
 * 0, exactly as the drift row doesn't), and saving again from there stores 0. So
 * unticking, saving and reloading can never come back ticked.
 *
 * A BLANK field still falls back to the default rather than to 0 — blank is "I
 * have no opinion", which is a different statement from "none".
 */
function countToSave(on: boolean, raw: string, fallback: number): number {
  if (!on) return 0;
  if (raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Ids for the collapsible config cards. Doubles as the persisted key set, so
 *  renaming one silently forgets that card's last state — which is fine. */
const CARD = {
  autoSync: 'auto-sync',
  docker: 'docker',
  telegram: 'telegram',
  telegramGuide: 'telegram-guide',
  categories: 'report-categories',
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
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [autoHeal, setAutoHeal] = useState(false);
  const [autoAdjust, setAutoAdjust] = useState(false);
  const [fixingBaseline, setFixingBaseline] = useState<string | null>(null);
  // Which companion build last synced this instance. Null until one has run —
  // the addon works standalone, so no companion is a normal state, not an error.
  const [companionVersion, setCompanionVersion] = useState<string | null>(null);
  const [glyphMode, setGlyphMode] = useState<'clean' | 'glyphs'>('clean');
  const [glyphOverrides, setGlyphOverrides] = useState<Record<string, string>>({});
  const [subcategoryDisplay, setSubcategoryDisplay] = useState<'rollup' | 'breakdown'>('rollup');
  // Every collapsible section's open state in one map, replacing the three
  // one-off `show*` booleans this page used to carry.
  const [openCards, setOpenCards] = useState<Record<string, boolean>>({});

  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [notifyOnImport, setNotifyOnImport] = useState(true);
  const [dailyReportEnabled, setDailyReportEnabled] = useState(true);
  const [weeklyReportEnabled, setWeeklyReportEnabled] = useState(true);
  // Absent means ON, like its daily/weekly siblings: a config written before the
  // monthly report existed opts into it.
  const [monthlyReportEnabled, setMonthlyReportEnabled] = useState(true);
  const [dailyReportCategories, setDailyReportCategories] = useState<string[] | 'all'>('all');
  const [weeklyReportCategories, setWeeklyReportCategories] = useState<string[] | 'all'>('all');
  const [monthlyReportCategories, setMonthlyReportCategories] = useState<string[] | 'all'>('all');
  // The full catalog (all 52 spending categories) drives the SELECTOR; the
  // derived name list below drives selection bookkeeping and the 'all' collapse.
  const [categoryCatalog, setCategoryCatalog] = useState<CategoryCatalogEntry[]>([]);
  // Each threshold is a checkbox plus an amount, never an amount alone — see
  // `thresholdToSave`. The amounts are held as strings so a half-typed field
  // isn't coerced to 0 mid-keystroke.
  const [largeTxAlerts, setLargeTxAlerts] = useState(false);
  const [largeTxAmount, setLargeTxAmount] = useState(String(SUGGESTED_LARGE_TX_THRESHOLD));
  const [driftAlertsOn, setDriftAlertsOn] = useState(true);
  const [driftAmount, setDriftAmount] = useState(String(DEFAULT_DRIFT_ALERT_THRESHOLD_DOLLARS));
  // Absent means ON at the default of 5 — what the companion has always done —
  // so this starts true and only an explicit stored 0 unticks it.
  const [topSpendsOn, setTopSpendsOn] = useState(true);
  const [topSpendCount, setTopSpendCount] = useState(String(DEFAULT_WEEKLY_TOP_SPEND_COUNT));
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState<string | null>(null);

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
      store.getTelegramConfig(),
      store.getReportCategoryCatalog(),
      store.getReportGlyphStyle(),
      store.getSubcategoryDisplay(),
      ctx.api.accounts.getAll().catch(() => []),
      store.getOpenCards(),
    ]).then(([last, m, r, h, names, bal, ah, aa, tg, catalog, glyphStyle, subcatMode, wfAccounts, cards]) => {
      setLastSyncAt(last);
      setMapping(m ?? {});
      setRules(r);
      setScheduleHours(h);
      setSfinNames(names);
      setBalances(bal);
      setAutoHeal(ah);
      setAutoAdjust(aa);
      setCategoryCatalog(catalog);
      setGlyphMode(glyphStyle.mode);
      setGlyphOverrides(glyphStyle.overrides);
      setSubcategoryDisplay(subcatMode);
      if (tg) {
        setBotToken(tg.botToken ?? '');
        setChatId(tg.chatId ?? '');
        setNotifyOnImport(tg.notifyOnImport ?? true);
        setDailyReportEnabled(tg.dailyReportEnabled ?? true);
        setWeeklyReportEnabled(tg.weeklyReportEnabled ?? true);
        setMonthlyReportEnabled(tg.monthlyReportEnabled ?? true);
        setDailyReportCategories(tg.dailyReportCategories ?? 'all');
        setWeeklyReportCategories(tg.weeklyReportCategories ?? 'all');
        setMonthlyReportCategories(tg.monthlyReportCategories ?? 'all');

        // A stored number is authoritative; anything else (absent, null, a
        // string) reads as "never configured" and takes the field's default.
        const num = (v: unknown): number | null =>
          typeof v === 'number' && Number.isFinite(v) ? v : null;

        // Absent → off. Only a positive amount turns it on.
        const largeTx = num(tg.largeTransactionThreshold);
        setLargeTxAlerts(largeTx !== null && largeTx > 0);
        if (largeTx !== null && largeTx > 0) setLargeTxAmount(String(largeTx));

        // Absent → ON at the engine's default. Only an explicit 0-or-negative
        // is the user having turned it off, which is why the amount field keeps
        // its default rather than showing the stored 0.
        const drift = num(tg.driftAlertThreshold);
        setDriftAlertsOn(drift === null || drift > 0);
        if (drift !== null && drift > 0) setDriftAmount(String(drift));

        // Same shape as the drift threshold above: absent → ON at the default,
        // an explicit 0 (or negative) is the user having switched it off, which
        // is why the count field keeps its default rather than showing that 0.
        const top = num(tg.weeklyTopSpendCount);
        setTopSpendsOn(top === null || top > 0);
        if (top !== null && top > 0) setTopSpendCount(String(Math.floor(top)));
      }
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

  // Plug the residual: add a one-time balance-adjustment entry for an account.
  const doFixBaseline = useCallback(
    async (sfinId: string, wfId: string, currency: string, suggestedAmount: number) => {
      setFixingBaseline(sfinId);
      clearError();
      try {
        await applyBaselineCorrection(ctx, store, {
          sfinAccountId: sfinId,
          wfAccountId: wfId,
          currency,
          suggestedAmount,
        });
        loadBalances();
      } catch (e: any) {
        showThrownError(e, 'Baseline correction failed');
      } finally {
        setFixingBaseline(null);
      }
    },
    [ctx, store, loadBalances, clearError, showThrownError],
  );

  const doAdjust = useCallback(
    async (sfinId: string, wfId: string, currency: string, amount: number) => {
      setAdjusting(sfinId);
      clearError();
      try {
        await applyBalanceAdjustment(ctx, store, { sfinAccountId: sfinId, wfAccountId: wfId, currency, amount });
        loadBalances();
      } catch (e: any) {
        showThrownError(e, 'Adjustment failed');
      } finally {
        setAdjusting(null);
      }
    },
    [ctx, store, loadBalances, clearError, showThrownError],
  );

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

  const mappedEntries = Object.entries(mapping);
  const mappedCount = mappedEntries.length;
  const driftAccounts = mappedEntries.filter(([sfinId]) => balances[sfinId]?.drift != null);

  // PARENTS ONLY. Wealthfolio budgets at the parent level — its own Spending
  // Tracker has no subcategory amount field — and the reports aggregate children
  // into their parent, so a per-child checkbox selected nothing a report could act
  // on while making this list 52 rows long. Children still travel in the catalog:
  // the companion needs them for the `breakdown` report mode, which is where
  // subcategory detail belongs.
  const categoryRows = categoryCatalog
    .filter((c) => !c.parent)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({ entry, isChild: false }));
  const childCount = categoryCatalog.length - categoryRows.length;
  // Only what the selector offers, so the 'all' sentinel stays reachable.
  const availableCategories = categoryRows.map((r) => r.entry.name);
  const asOf = mappedEntries
    .map(([sfinId]) => balances[sfinId]?.date)
    .filter((d): d is number => typeof d === 'number')
    .sort((a, b) => b - a)[0];

  // ── Collapsed-header summaries ───────────────────────────────────────────
  // Each collapsible card reports its own configuration as text in its header,
  // so a closed card still answers "is this on, and set to what?". Without
  // these, collapsing would be hiding state rather than hiding chrome.
  const autoSyncSummary = `${scheduleHours ? `Every ${scheduleHours}h` : 'Off'} · ${
    autoAdjust ? 'aggressive auto-heal' : autoHeal ? 'auto-heal on' : 'auto-heal off'
  }`;

  const telegramConnected = !!botToken && !!chatId;
  const activeReports = [
    dailyReportEnabled && 'daily',
    weeklyReportEnabled && 'weekly',
    monthlyReportEnabled && 'monthly',
  ].filter((r): r is string => typeof r === 'string');
  const telegramSummary = !telegramConnected
    ? 'Not connected'
    : [
        'Connected',
        activeReports.length > 0 ? `${activeReports.join(', ')} reports` : 'no reports',
        // Only the non-default alert states earn a slot: large-tx alerts are off
        // unless asked for, drift alerts are on unless refused, so these two
        // segments are exactly the settings you would forget you had changed.
        largeTxAlerts
          ? `$${thresholdToSave(true, largeTxAmount, SUGGESTED_LARGE_TX_THRESHOLD)}+ alerts`
          : null,
        driftAlertsOn ? null : 'drift alerts off',
      ]
        .filter((s): s is string => typeof s === 'string')
        .join(' · ');

  // Count only names the companion still publishes: a saved selection can hold
  // categories that vanished at month rollover, and counting those would report
  // more checked boxes than the matrix actually shows.
  const catCount = (sel: string[] | 'all') =>
    sel === 'all' ? 'all' : String(sel.filter((n) => availableCategories.includes(n)).length);
  const categoriesSummary =
    `Daily ${catCount(dailyReportCategories)} · Weekly ${catCount(weeklyReportCategories)}` +
    ` · Monthly ${catCount(monthlyReportCategories)}`;

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

      {/* What the reconcile sweep deleted. A needs-to-be-seen notice rather than
          a collapsible detail: rows were removed from the user's ledger without
          being asked about, so each one is itemised with the figure, date,
          description and account — enough to go and verify in Wealthfolio. */}
      {prunedDuplicates.length > 0 && (
        <div className="sfin-banner-warn">
          <span aria-hidden>🧹</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>
              Removed {prunedDuplicates.length} duplicate{' '}
              {prunedDuplicates.length === 1 ? 'activity' : 'activities'} — each of these
              was stored twice, so the extra copy was deleted.
            </div>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {prunedDuplicates.map((p) => (
                <li key={p.wfId}>
                  <b>{money(p.amountCents / 100, p.currency)}</b> · {p.date}
                  {p.description ? ` · ${p.description}` : ''} · {p.accountName}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {driftAccounts.map(([sfinId, wfId]) => {
        const info = balances[sfinId];
        const drift = info.drift as number;
        // Offered only when a heal proved every transaction reconciles, which
        // makes the starting balance the only thing left that can be wrong. When
        // it's present the plug is demoted: it would date this correction today
        // and leave the wrong baseline in place.
        const baselineFix = (info as { baselineFix?: BaselineFixOffer }).baselineFix;
        // A YOUNG dated drift is usually the bank's balance running ahead of its
        // own transaction feed — posted activity SimpleFin hasn't published yet,
        // which resolves itself in days. It gets the calm banner with NO plug
        // button: the red banner's `Add $X` was a loaded gun, since plugging lag
        // double-counts the moment the feed catches up. An undatable drift
        // (under the alert threshold, so no episode) keeps the old treatment —
        // that's the small-divergence case the plug exists for.
        const driftSince = (info as { driftSince?: string | null }).driftSince;
        const waitingOnFeed =
          !!driftSince && Date.now() - Date.parse(driftSince) < BASELINE_FIX_MIN_DRIFT_AGE_MS;
        if (waitingOnFeed) {
          return (
            <div className="sfin-banner-wait" key={sfinId}>
              <span aria-hidden>⏳</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>
                  <b>{sfinNames[sfinId] ?? sfinId}</b> is ahead of SimpleFin&apos;s feed by{' '}
                  <b>{money(Math.abs(drift), info.currency)}</b> — the bank reports{' '}
                  <b>{money(info.balance ?? 0, info.currency)}</b>.
                </div>
                <div style={{ marginTop: 4, opacity: 0.85 }}>
                  The bank&apos;s balance usually includes recent activity its transaction list
                  hasn&apos;t published yet. This typically clears in a few days on its own.
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  <Button variant="outline" onClick={doHeal} disabled={healing || syncing}>
                    {healing ? 'Re-scanning…' : 'Re-scan 90 days'}
                  </Button>
                </div>
              </div>
            </div>
          );
        }
        return (
          <div className="sfin-banner-warn" key={sfinId}>
            <span aria-hidden>⚠</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div>
                <b>{sfinNames[sfinId] ?? sfinId}</b> is off by{' '}
                <b>{money(Math.abs(drift), info.currency)}</b> — SimpleFin reports{' '}
                <b>{money(info.balance ?? 0, info.currency)}</b>.
              </div>
              {baselineFix && (
                <div style={{ marginTop: 4, opacity: 0.85 }}>
                  Every transaction reconciles — the starting balance looks wrong, not your
                  history.
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <Button variant="outline" onClick={doHeal} disabled={healing || syncing}>
                  {healing ? 'Re-scanning…' : 'Re-scan 90 days'}
                </Button>
                {baselineFix && (
                  <Button
                    variant="outline"
                    title="Correct this account's starting balance, which stands for everything that happened before the first sync"
                    onClick={() =>
                      doFixBaseline(sfinId, wfId, info.currency, baselineFix.suggestedAmount)
                    }
                    disabled={fixingBaseline === sfinId || healing || syncing}
                  >
                    {fixingBaseline === sfinId
                      ? 'Fixing baseline…'
                      : `Fix baseline: ${money(baselineFix.currentAmount, info.currency)} → ${money(baselineFix.suggestedAmount, info.currency)}`}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  title={
                    baselineFix
                      ? 'Add a one-time adjustment dated today instead. Leaves the wrong starting balance in place.'
                      : 'Add a one-time balance adjustment so this account matches your bank'
                  }
                  onClick={() => doAdjust(sfinId, wfId, info.currency, drift)}
                  disabled={adjusting === sfinId || healing || fixingBaseline === sfinId}
                >
                  {adjusting === sfinId
                    ? 'Adjusting…'
                    : `${drift > 0 ? 'Add' : 'Subtract'} ${money(Math.abs(drift), info.currency)}${baselineFix ? ' (plug instead)' : ''}`}
                </Button>
              </div>
            </div>
          </div>
        );
      })}

      <div className="sfin-strip" style={{ marginTop: 16 }}>
        <div className="sfin-tile">
          <SectionLabel>Accounts synced</SectionLabel>
          <div className="sfin-tile-val">{mappedCount}</div>
        </div>
        <div className="sfin-tile">
          <SectionLabel>Imported last run</SectionLabel>
          <div className="sfin-tile-val">{imported ?? '—'}</div>
        </div>
        <div className="sfin-tile">
          <SectionLabel>Auto-sync</SectionLabel>
          <div className="sfin-tile-val" style={{ fontSize: 16 }}>
            {scheduleHours ? `Every ${scheduleHours}h` : 'Off'}
          </div>
        </div>
      </div>

      <Card>
        <div className="sfin-card-head">
          {/* Just "Accounts": the count is already the first stat tile, and
              printing it twice within 100px of itself read as clutter. */}
          <SectionLabel>Accounts</SectionLabel>
          {asOf && <span className="sfin-subtle" style={{ fontSize: 11.5 }}>balances as of {formatAsOf(asOf)}</span>}
        </div>
        {mappedEntries.map(([sfinId, wfId]) => {
          const info = balances[sfinId];
          const name = sfinNames[sfinId] ?? sfinId;
          const exists = !!wfNames[wfId];
          const open = () => { if (exists) ctx.api.navigation.navigate(`/accounts/${wfId}`).catch(() => {}); };
          return (
            <div
              className={`sfin-acct${exists ? ' sfin-acct--link' : ''}`}
              key={sfinId}
              {...(exists
                ? {
                    role: 'button',
                    tabIndex: 0,
                    title: 'Open this account in Wealthfolio',
                    onClick: open,
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
                    },
                  }
                : {})}
            >
              <div className="sfin-acct-left">
                <div className="sfin-avatar">{initials(name)}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="sfin-acct-name">{name}</div>
                  <div className="sfin-acct-map">
                    {exists ? (
                      `→ ${wfNames[wfId]}`
                    ) : (
                      <span style={{ color: 'var(--destructive)' }}>account no longer exists — reset &amp; re-map</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="sfin-acct-right">
                <div className="sfin-bal">{info && info.balance != null ? money(info.balance, info.currency) : '—'}</div>
                {info && info.balance != null && (info.drift == null ? (
                  <span className="sfin-chip"><CheckIcon /> in sync</span>
                ) : (
                  <span className="sfin-chip sfin-chip--off"><AlertIcon /> off by {money(Math.abs(info.drift), info.currency)}</span>
                ))}
              </div>
            </div>
          );
        })}
      </Card>

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

      <CollapsibleCard
        id={CARD.telegram}
        title="Telegram Notifications (Optional)"
        summary={telegramSummary}
        open={isOpen(CARD.telegram)}
        onToggle={() => toggleCard(CARD.telegram)}
      >
        <div className="sfin-subtle" style={{ marginBottom: 12 }}>
          Daily spending allowances and weekly budget summaries, sent by the companion container.
        </div>

        {/* Read once, ever — so it stays behind a disclosure rather than costing
            every later visit ~130px of scrolling. Same `Disclosure` primitive as
            the cards, in its nested flavour, so there is one pattern to learn. */}
        <div className="sfin-disc-inset" style={{ marginBottom: 12 }}>
          <Disclosure
            id={CARD.telegramGuide}
            variant="inline"
            title="📱 How to set up your Telegram bot"
            open={isOpen(CARD.telegramGuide)}
            onToggle={() => toggleCard(CARD.telegramGuide)}
          >
            <ol>
              <li>Open Telegram and search for <strong>@BotFather</strong>.</li>
              <li>Send <code>/newbot</code> to @BotFather and follow prompts to name your bot.</li>
              <li>Copy the HTTP API <strong>Token</strong> (e.g. <code>123456789:ABCdefGHI...</code>).</li>
              <li>Open Telegram and send a message <code>/start</code> to your new bot.</li>
              <li>Search Telegram for <strong>@userinfobot</strong> and send any message to get your numeric <strong>Chat ID</strong> (e.g. <code>987654321</code>).</li>
              <li>Paste your Bot Token and Chat ID below, then click <strong>Send Test Message</strong>!</li>
            </ol>
          </Disclosure>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Two short, related fields: side by side on a normal window, and the
              labels are now actually tied to their inputs. */}
          <div className="sfin-fields">
            <div>
              <label htmlFor="sfin-bot-token" className="sfin-subtle">Bot Token</label>
              <input
                id="sfin-bot-token"
                type="password"
                className="sfin-select"
                placeholder="e.g. 123456789:ABCdefGHI..."
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="sfin-chat-id" className="sfin-subtle">Chat ID</label>
              <input
                id="sfin-chat-id"
                type="text"
                className="sfin-select"
                placeholder="e.g. 987654321"
                value={chatId}
                onChange={(e) => setChatId(e.target.value)}
              />
            </div>
          </div>

          <div className="sfin-checks">
            <label className="sfin-check">
              <input
                type="checkbox"
                checked={notifyOnImport}
                onChange={(e) => setNotifyOnImport(e.target.checked)}
              />
              <span>Transaction Import Alerts (Instant when new transactions sync)</span>
            </label>
            <label className="sfin-check">
              <input
                type="checkbox"
                checked={dailyReportEnabled}
                onChange={(e) => setDailyReportEnabled(e.target.checked)}
              />
              <span>Daily Category Allowance Report (Morning)</span>
            </label>
            <label className="sfin-check">
              <input
                type="checkbox"
                checked={weeklyReportEnabled}
                onChange={(e) => setWeeklyReportEnabled(e.target.checked)}
              />
              <span>Weekly Budget &amp; Spending Summary</span>
            </label>
            <label className="sfin-check">
              <input
                type="checkbox"
                checked={monthlyReportEnabled}
                onChange={(e) => setMonthlyReportEnabled(e.target.checked)}
              />
              <span>Monthly Wrap-Up (on the 1st, for the month just ended)</span>
            </label>
          </div>

          <div className="sfin-divider" />
          <SectionLabel>Alerts &amp; amounts</SectionLabel>

          <div className="sfin-nums">
            <div className="sfin-thresh">
              {/* Its own checkbox, matching the two rows below. `0` still means
                  "hide the section" to every reader, so this control and typing 0
                  are two spellings of one stored value — but three sibling rows
                  where only one lacked the neighbours' control read as broken,
                  whatever the logic underneath said. */}
              <label className="sfin-check">
                <input
                  type="checkbox"
                  checked={topSpendsOn}
                  onChange={(e) => setTopSpendsOn(e.target.checked)}
                />
                <span className="sfin-check-name">Biggest spends in the weekly report</span>
              </label>
              <div className="sfin-thresh-amt">
                <input
                  id="sfin-top-spend"
                  type="number"
                  min={0}
                  step={1}
                  className="sfin-select sfin-num"
                  // Its own accessible name, for the same reason the two
                  // threshold fields have one: the visible row label now belongs
                  // to the checkbox beside it.
                  aria-label="How many biggest spends to list"
                  value={topSpendCount}
                  disabled={!topSpendsOn}
                  onChange={(e) => setTopSpendCount(e.target.value)}
                />
              </div>
            </div>
            <div className="sfin-num-hint sfin-subtle">
              How many individual charges the Saturday report lists. Untick to
              leave the section out — as does a count of 0; blank means the
              default of {DEFAULT_WEEKLY_TOP_SPEND_COUNT}.
            </div>

            <div className="sfin-thresh">
              <label className="sfin-check">
                <input
                  type="checkbox"
                  checked={largeTxAlerts}
                  onChange={(e) => setLargeTxAlerts(e.target.checked)}
                />
                <span className="sfin-check-name">Large transaction alerts</span>
              </label>
              <div className="sfin-thresh-amt">
                <span className="sfin-subtle" aria-hidden>over $</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  className="sfin-select sfin-num"
                  // A distinct aria-label: both threshold fields would otherwise
                  // share the visible "over $" and be indistinguishable by name.
                  aria-label="Large transaction alert threshold in dollars"
                  value={largeTxAmount}
                  disabled={!largeTxAlerts}
                  onChange={(e) => setLargeTxAmount(e.target.value)}
                />
              </div>
            </div>
            <div className="sfin-num-hint sfin-subtle">
              Announces a single newly-imported spend over this amount. Off until
              you turn it on.
            </div>

            <div className="sfin-thresh">
              <label className="sfin-check">
                <input
                  type="checkbox"
                  checked={driftAlertsOn}
                  onChange={(e) => setDriftAlertsOn(e.target.checked)}
                />
                <span className="sfin-check-name">Balance drift alerts</span>
              </label>
              <div className="sfin-thresh-amt">
                <span className="sfin-subtle" aria-hidden>over $</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  className="sfin-select sfin-num"
                  aria-label="Balance drift alert threshold in dollars"
                  value={driftAmount}
                  disabled={!driftAlertsOn}
                  onChange={(e) => setDriftAmount(e.target.value)}
                />
              </div>
            </div>
            <div className="sfin-num-hint sfin-subtle">
              Announces an account whose bank balance and Wealthfolio valuation
              differ by more than this. On at ${DEFAULT_DRIFT_ALERT_THRESHOLD_DOLLARS}{' '}
              unless you untick it — clearing the amount alone will not turn it off.
            </div>
          </div>

          {/* A matrix rather than a "Daily"/"Weekly" word beside every checkbox:
              the column heading says it once, the boxes line up, and each row
              loses ~10px of height. The per-checkbox aria-label still carries
              both the category and the report, so the accessible name never
              depends on reading the column heading.

              The matrix is the tallest thing in this card (one row per
              category), so it sits behind its own nested disclosure — inside
              the Telegram card rather than as a card of its own, because
              "Save Telegram Settings" is what commits these lists and splitting
              them apart would leave the selection with no save button. */}
          <div className="sfin-disc-inset">
            <Disclosure
              id={CARD.categories}
              variant="inline"
              title="Report categories"
              summary={categoriesSummary}
              open={isOpen(CARD.categories)}
              onToggle={() => toggleCard(CARD.categories)}
            >
              <div className="sfin-subtle" style={{ fontSize: 12, marginBottom: 8 }}>
                Every budgetable category is listed — Wealthfolio budgets at this level,
                so subcategories aren't selected individually. Reports still only print
                the ones with a budget or spending this month.
                {childCount > 0 && (
                  <> Set <em>Subcategories</em> to <em>Break down</em> to see the {childCount}{' '}
                  subcategories inside these in your reports.</>
                )}
              </div>

              <div className="sfin-field-row">
                <label htmlFor="sfin-glyph-mode">Telegram report icons</label>
                <select
                  id="sfin-glyph-mode"
                  value={glyphMode}
                  onChange={(e) => {
                    const mode = e.target.value as 'clean' | 'glyphs';
                    setGlyphMode(mode);
                    store.setReportGlyphStyle({ mode, overrides: glyphOverrides }).catch(() => {});
                  }}
                >
                  {/* Telegram renders neither colour nor Wealthfolio's own icons,
                      so a report can only be plain or carry an emoji. */}
                  <option value="clean">Clean — no icons</option>
                  <option value="glyphs">Emoji per category</option>
                </select>
              </div>

              <div className="sfin-field-row">
                <label htmlFor="sfin-subcat-mode">Subcategories</label>
                <select
                  id="sfin-subcat-mode"
                  value={subcategoryDisplay}
                  onChange={(e) => {
                    const mode = e.target.value as 'rollup' | 'breakdown';
                    setSubcategoryDisplay(mode);
                    store.setSubcategoryDisplay(mode).catch(() => {});
                  }}
                >
                  <option value="rollup">Roll up into the parent</option>
                  <option value="breakdown">Break down under the parent</option>
                </select>
              </div>

              <div className="sfin-cats">
            {availableCategories.length > 0 && (
              <>
                {/* Spacer holding grid column 1 so the captions sit above the
                    checkbox columns rather than sliding left one cell. */}
                <div aria-hidden />
                <div className="sfin-cats-col sfin-cats-head">Daily</div>
                <div className="sfin-cats-col sfin-cats-head">Weekly</div>
                <div className="sfin-cats-col sfin-cats-head">Monthly</div>
              </>
            )}
            {availableCategories.length === 0 ? (
              <div className="sfin-subtle" style={{ gridColumn: '1 / -1', fontSize: 12 }}>
                Categories will appear here after the companion's first sync.
              </div>
            ) : (
              categoryRows.map(({ entry, isChild }) => {
                const name = entry.name;
                const inDaily = dailyReportCategories === 'all' || dailyReportCategories.includes(name);
                const inWeekly = weeklyReportCategories === 'all' || weeklyReportCategories.includes(name);
                const inMonthly = monthlyReportCategories === 'all' || monthlyReportCategories.includes(name);
                // Functional updater, and membership read from `prev` rather
                // than the closed-over `inDaily`/`inWeekly`: two toggles
                // batched into one React tick would otherwise both start from
                // the same stale snapshot and the first would be dropped.
                const toggle = (
                  setCurrent: React.Dispatch<React.SetStateAction<string[] | 'all'>>,
                ) => {
                  setCurrent((prev) => {
                    const base = prev === 'all' ? availableCategories : prev;
                    const wasIncluded = prev === 'all' || prev.includes(name);
                    const next = wasIncluded ? base.filter((n) => n !== name) : [...base, name];
                    // Collapse to the 'all' sentinel only when the selection
                    // genuinely covers every published category — a SET test,
                    // not a length test. `availableCategories` is the union of
                    // *this month's* spending and budgets, so it legitimately
                    // shrinks (a category with spending but no budget vanishes
                    // at month rollover) while a saved selection still holds
                    // the older, longer list. Comparing lengths then matched
                    // by coincidence: with saved ['Groceries','Dining','Fun']
                    // and a published ['Groceries','Dining'], unchecking
                    // Groceries left a 2-element array whose length equalled
                    // the published list, stored 'all', and silently put every
                    // category back into the user's reports.
                    //
                    // Names no longer published are kept in `next` rather than
                    // pruned, so a category that reappears next month comes
                    // back with the user's original intent intact.
                    const chosen = new Set(next);
                    const coversEverything = availableCategories.every((n) => chosen.has(n));
                    return coversEverything ? 'all' : next;
                  });
                };
                return (
                  <React.Fragment key={name}>
                    <div
                      className="sfin-cat-name"
                      // Children indent under their parent. With 52 categories a
                      // flat list is unreadable, and the catalog carries `parent`
                      // precisely so the shape can match how they're thought of.
                      style={isChild ? { paddingLeft: 18 } : undefined}
                    >
                      <CategoryIcon name={entry.icon} color={entry.color} size={isChild ? 13 : 15} />
                      <span style={isChild ? undefined : { fontWeight: 600 }}>{name}</span>
                      {/* A palette, not a text field: the input this replaces
                          required knowing how to type an emoji on your platform.
                          Only shown in glyphs mode, where an override does
                          something — and where its placeholder no longer reads as
                          a missing amount. */}
                      {glyphMode === 'glyphs' && (
                        <GlyphPicker
                          label={`${name} — report emoji`}
                          value={glyphOverrides[name] ?? ''}
                          fallback={getCategoryEmoji(name)}
                          onChange={(glyph) => {
                            const next = { ...glyphOverrides };
                            if (glyph) next[name] = glyph; else delete next[name];
                            setGlyphOverrides(next);
                            store.setReportGlyphStyle({ mode: glyphMode, overrides: next }).catch(() => {});
                          }}
                        />
                      )}
                    </div>
                    <input
                      type="checkbox"
                      aria-label={`${name} — Daily`}
                      checked={inDaily}
                      onChange={() => toggle(setDailyReportCategories)}
                    />
                    <input
                      type="checkbox"
                      aria-label={`${name} — Weekly`}
                      checked={inWeekly}
                      onChange={() => toggle(setWeeklyReportCategories)}
                    />
                    <input
                      type="checkbox"
                      aria-label={`${name} — Monthly`}
                      checked={inMonthly}
                      onChange={() => toggle(setMonthlyReportCategories)}
                    />
                  </React.Fragment>
                );
              })
            )}
              </div>
            </Disclosure>
          </div>

          {/* role="status" so the send/save result is announced, and the ✅/❌
              prefix stays: the colour is a reinforcement, never the only signal.
              The in-flight "Sending…" message carries neither prefix and is no
              longer painted destructive-red for having failed no test yet. */}
          {telegramStatus && (
            <div role="status" className={`sfin-status ${telegramStatusTone(telegramStatus)}`}>
              {telegramStatus}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            <Button
              variant="outline"
              disabled={testingTelegram || !botToken || !chatId}
              onClick={async () => {
                setTestingTelegram(true);
                setTelegramStatus('Sending test message...');
                try {
                  const timeoutPromise = new Promise<{ ok: false; description: string }>((_, reject) =>
                    setTimeout(() => reject(new Error('Request timed out after 5 seconds')), 5000)
                  );

                  const sendPromise = sendTelegramMessage(
                    botToken,
                    chatId,
                    '🎉 *SimpleFin Sync Telegram Integration Connected!*\n\nYour Telegram bot is configured and ready to send daily category allowances and weekly budget reports.',
                    ctx.api.network,
                  );

                  const res = await Promise.race([sendPromise, timeoutPromise]);
                  if (res.ok) {
                    setTelegramStatus('✅ Test message sent successfully to Telegram!');
                  } else {
                    setTelegramStatus(`❌ Error sending message: ${res.description}`);
                  }
                } catch (err) {
                  console.error('[Telegram Debug Error]:', err);
                  setTelegramStatus(`❌ Error: ${(err as Error).message}`);
                } finally {
                  setTestingTelegram(false);
                }
              }}
            >
              {testingTelegram ? 'Sending...' : 'Send Test Message'}
            </Button>

            <Button
              variant="primary"
              disabled={!botToken || !chatId}
              onClick={async () => {
                await store.setTelegramConfig({
                  botToken,
                  chatId,
                  enabled: true,
                  notifyOnImport,
                  dailyReportEnabled,
                  weeklyReportEnabled,
                  monthlyReportEnabled,
                  dailyReportCategories,
                  weeklyReportCategories,
                  monthlyReportCategories,
                  weeklyTopSpendCount: countToSave(
                    topSpendsOn, topSpendCount, DEFAULT_WEEKLY_TOP_SPEND_COUNT,
                  ),
                  // Always an explicit number, never omitted: `0` is how both
                  // readers spell "off", and omitting driftAlertThreshold would
                  // hand the user back the $100 default they just switched off.
                  largeTransactionThreshold: thresholdToSave(
                    largeTxAlerts, largeTxAmount, SUGGESTED_LARGE_TX_THRESHOLD,
                  ),
                  driftAlertThreshold: thresholdToSave(
                    driftAlertsOn, driftAmount, DEFAULT_DRIFT_ALERT_THRESHOLD_DOLLARS,
                  ),
                });
                setTelegramStatus('✅ Telegram configuration saved!');
              }}
            >
              Save Telegram Settings
            </Button>
          </div>
        </div>
      </CollapsibleCard>

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
