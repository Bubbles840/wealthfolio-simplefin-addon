import { parseReportStore, reportsSecretKey, type ReportKind, type ReportStore } from '../../shared/reports-archive';
import { SIMPLEFIN_REQUESTS_SECRET_KEY } from '../../shared/simplefin-budget';
import { TRANSFER_NAMES_SECRET_KEY, parseTransferNames, type TransferNames } from '../../shared/transfer-names';
import { SKIPPED_TRANSACTIONS_SECRET_KEY, parseSkippedTransactions, parseSkippedTransactionsStrict, type ParsedSkippedTransactions, type SkippedTransaction } from '../../shared/skipped-transactions';
import { IGNORE_RULES_SECRET_KEY, IgnoreRulesUnreadableError, IGNORE_PROBLEM_TEXT, ignoreRuleProblem, normalizeIgnoreRules, parseIgnoreRules, parseIgnoreRulesStrict, type IgnoreRule, type ParsedIgnoreRules } from '../../shared/ignore-rules';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { AMAZON_LEDGER_SECRET_KEY } from '../../shared/amazon-ledger';
import { VENMO_LEDGER_SECRET_KEY, type VenmoLedger } from '../../shared/venmo-ledger';
import { AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY } from '../../shared/amazon-config';
import { UNCATEGORIZED_STATUS_SECRET_KEY, AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, POOL_STATUS_SECRET_KEY, VENMO_MAIL_SAMPLES_SECRET_KEY, type AmazonMailStatus, type AmazonMailSamples } from '../../shared/status-keys';
import { SEMESTER_POOL_SECRET_KEY, parsePoolConfig } from '../../shared/pool';
import type { SemesterPoolConfig, PoolStatus } from '../../shared/pool';
import { REPORT_CUBE_SECRET_KEY, parseReportCube } from '../../shared/report-cube';
import { AUDIT_SNAPSHOT_SECRET_KEY, parseAuditSnapshot, type AuditSnapshotRead } from '../../shared/audit-snapshot';
import { REPORTS_SEEN_SECRET_KEY, parseReportsSeen, type ReportsSeen, type ReportsSeenRead } from '../../shared/reports-seen';
import { CASH_FORECAST_SECRET_KEY, parseCashForecast, type CashForecastRead } from '../../shared/cash-forecast';
import type { ReportCube } from '../../shared/report-cube';
import { parseCustomReports } from '../../shared/report-eval';
import type { CustomReport } from '../../shared/report-eval';
import { parseBudgetLayout } from '../../shared/budget-layout';
import type { BudgetLayout } from '../../shared/budget-layout';
import type { AmazonLabelCatalog, AmazonMailConfig } from '../../shared/amazon-config';
import type { AmazonLedger } from '../../shared/amazon-ledger';
import type { AccountMapping, MappingRule, UnmappedAccount } from '../../shared/types';
import type { DismissalLedger, UncategorizedRow } from '../../shared/uncategorized';
import type { DriftAlertEntry, TransferLinkFailureEntry } from '../../shared/sync-host';
import type { SyncResult } from '../../shared/sync-core';
import { LARGE_TX_OUTBOX_SECRET_KEY, SUBSCRIPTION_NEWS_SECRET_KEY } from '../../shared/telegram';
import { ADDON_VERSION_SECRET_KEY, INSTALLED_ADDON_VERSION_SECRET_KEY, SIMPLEFIN_SYNC_VERSION, WEALTHFOLIO_VERSION_SECRET_KEY } from '../../shared/version';
import { REFUSED_ALERTED_SECRET_KEY } from '../../shared/refused-alerts';
import { HIDDEN_SUBSCRIPTIONS_SECRET_KEY, CONFIRMED_SUBSCRIPTIONS_SECRET_KEY } from '../../shared/subscriptions';
import {
  SUBSCRIPTION_PREFS_SECRET_KEY, editSubscriptionPrefs as editPrefsDocument, loadSubscriptionPrefs,
  type LoadedSubscriptionPrefs, type SubscriptionEdit, type SubscriptionPrefs,
} from '../../shared/subscription-prefs';
import { newRunId, stampChange, type ChangeDraft, type ChangeEntry, type ChangeLogSink } from '../../shared/change-entries';
import {
  editSyncOverrides as editOverridesDocument, loadSyncOverrides, SYNC_OVERRIDES_SECRET_KEY, syncOverridesIgnoredLog, syncOverridesOrEmpty,
  type LoadedSyncOverrides, type SyncOverrides, type SyncOverridesEdit,
} from '../../shared/sync-overrides';
import {
  changeLogResetKeys, createChangeLogWriter, readChangeLog, type ChangeLogIo, type ChangeLogRead,
} from '../../shared/change-log';

/** Per-account balance snapshot captured on each sync, for the Sync page. */
/** One spending category as the companion published it. Mirrors
 *  `NativeCategoryCatalogEntry`; kept structural rather than imported because the
 *  browser bundle must not pull in the companion's node:sqlite module. */
/** Mirrors `GlyphStyle` in shared/telegram; declared here so the store's public
 *  surface does not depend on the report module. */
export interface GlyphStylePref {
  mode: 'clean' | 'glyphs';
  overrides: Record<string, string>;
}

export interface UiState {
  /** As stored, from any version: 1.56 and earlier wrote five tab ids. Read
   *  through `resolveStoredTab`, never trusted as a current `TabId`. */
  activeTab?: string;
  checklistDismissed?: boolean;
}

export interface CategoryCatalogEntry {
  name: string;
  parent: string | null;
  /** lucide-react export name, straight from Wealthfolio. */
  icon: string | null;
  color: string | null;
  hasBudget: boolean;
  hasSpend: boolean;
  /** Wealthfolio's budget group (`Needs`, `Wants`, …), null when unassigned. */
  group?: string | null;
  groupIcon?: string | null;
  groupSort?: number | null;
}

export interface AccountBalanceInfo {
  /** SimpleFin's reported balance, or null when SimpleFin didn't provide a
   *  numeric balance for the account (shown as "—" rather than a false $0.00). */
  balance: number | null;
  currency: string;
  /** SimpleFin balance-date (Unix seconds). */
  date: number;
  /** SimpleFin balance − Wealthfolio balance, set only when it was safely
   *  measurable (no imports that run) and exceeds the drift threshold; null
   *  means "in sync" (or not measurable this run). */
  drift: number | null;
  /** Whether the run obtained a trustworthy figure at all — the half `drift: null`
   *  cannot express, since it covers both "verified in sync" and "could not check".
   *  Absent means unmeasured (an older build's snapshot proves nothing either). */
  measured?: boolean;
  /**
   * Set ONLY by the after-save card check (1.64, B2) when it fills a verdict.
   * That figure is for the account-list BADGE alone (R15): it opened no drift
   * episode, so it has no `driftSince`, and the Home banner would otherwise
   * show it red with a one-click plug that skips the young-drift guard
   * (plugging feed lag double-counts the moment the feed catches up). Readers
   * that raise banners, plugs or report findings must ignore a tagged drift.
   */
  checkedAfterSave?: true;
  /** Epoch ms when the download behind `balance`/`date` was sent; absent on an older build's snapshot. */
  fetchedAt?: number;
}

const KEYS = {
  accessUrl: 'simplefin_access_url',
  authB64: 'simplefin_auth_b64',
  accountMapping: 'account_mapping',
  accountNames: 'account_names',
  balanceInitialized: 'balance_initialized',
  mappingRules: 'mapping_rules',
  syncScheduleHours: 'sync_schedule_hours',
  lastSyncAt: 'last_sync_at',
  linkedGroups: 'linked_groups',
  transferLinkFailures: 'transfer_link_failures',
  driftAlerts: 'drift_alerts',
  lastSyncImported: 'last_sync_imported',
  accountBalances: 'account_balances',
  unmappedAccounts: 'unmapped_accounts',
  ignoredAccounts: 'ignored_accounts',
  skippedTransactions: SKIPPED_TRANSACTIONS_SECRET_KEY,
  ignoreRules: IGNORE_RULES_SECRET_KEY,
  // Companion-published, add-on-read-only; the companion recomputes it, so Reset clears it.
  transferNames: TRANSFER_NAMES_SECRET_KEY,
  autoHeal: 'auto_heal',
  autoAdjust: 'auto_adjust',
  telegramConfig: 'telegram_config',
  availableReportCategories: 'available_report_categories',
  companionVersion: 'companion_version',
  reportCategoryCatalog: 'report_category_catalog',
  reportGlyphStyle: 'report_glyph_style',
  subcategoryDisplay: 'subcategory_display',
  countOffBudget: 'count_off_budget',
  capWeeklyToPool: 'cap_weekly_to_pool',
  overBudgetSpent: 'over_budget_spent',
  // Retired in 1.57 (both lines now only appear to warn). Kept here so Reset
  // still deletes a value an older version stored.
  monthProjection: 'month_projection',
  poolLine: 'pool_line',
  semesterPool: SEMESTER_POOL_SECRET_KEY,
  // Companion-published, addon-read-only, in KEYS for the same clearAll reason
  // as uncategorizedStatus above.
  poolStatus: POOL_STATUS_SECRET_KEY,
  // Companion-published like poolStatus; in KEYS for the same clearAll reason.
  reportCube: REPORT_CUBE_SECRET_KEY,
  // The audits' snapshot (2c): companion-published, addon-read-only, cleared on Reset.
  auditSnapshot: AUDIT_SNAPSHOT_SECRET_KEY,
  // The Reports tab's unread state (project 5): written by the add-on only,
  // cleared on Reset.
  reportsSeen: REPORTS_SEEN_SECRET_KEY,
  // The cash forecast (project 5): companion-published, add-on-read-only,
  // cleared on Reset.
  cashForecast: CASH_FORECAST_SECRET_KEY,
  customReports: 'custom_reports',
  budgetLayout: 'budget_layout',
  openCards: 'ui_open_cards',
  uiState: 'ui_state',
  pendingLargeTxAlerts: LARGE_TX_OUTBOX_SECRET_KEY,
  // Companion-published, addon-read-only (see `getUncategorizedStatus`) — but
  // still an addon secret, so a reset has to clear it too. Left out of KEYS,
  // clearAll skipped it and a reset account kept showing the stale "Needs a
  // category" count from before the reset.
  uncategorizedStatus: UNCATEGORIZED_STATUS_SECRET_KEY,
  // Same bug, same fix, for the Amazon "mail unparsed" warning: no SecretsStore
  // setter (the companion writes it directly), which is exactly the shape of
  // key that is easy to leave out of KEYS. Left out here, a reset account would
  // keep showing a stale "emails unread" warning from before the reset.
  amazonMailStatus: AMAZON_MAIL_STATUS_SECRET_KEY,
  // And the unreadable-email samples beside it: companion-written, the same
  // easy-to-forget shape, and they hold (redacted) receipt text.
  amazonMailSamples: AMAZON_MAIL_SAMPLES_SECRET_KEY,
  // Same bug, same fix, for the Amazon mailbox credentials: these three read
  // and write their key constants directly (see `getAmazonConfig` etc.) rather
  // than through KEYS, so they were also missing from `clearAll`. That meant
  // "Reset" — which now promises to clear "any Telegram or Amazon setup" —
  // left the Amazon app password sitting in storage. `amazonLedger` isn't
  // credentials, but it references the same reset mailbox and should not
  // survive one either.
  amazonConfig: AMAZON_CONFIG_SECRET_KEY,
  amazonLabels: AMAZON_LABELS_SECRET_KEY,
  amazonLedger: AMAZON_LEDGER_SECRET_KEY,
  // The Venmo payments (3): companion-written, read by an add-on sync; the
  // same mailbox as Amazon's, so Reset clears it with the rest.
  venmoLedger: VENMO_LEDGER_SECRET_KEY,
  // The unreadable Venmo emails beside it: companion-written, redacted text.
  venmoMailSamples: VENMO_MAIL_SAMPLES_SECRET_KEY,
  dismissals: 'uncategorized_dismissals',
  hiddenSubscriptions: HIDDEN_SUBSCRIPTIONS_SECRET_KEY,
  confirmedSubscriptions: CONFIRMED_SUBSCRIPTIONS_SECRET_KEY,
  // The subscription document (1.60) has no plain setter — it is only ever
  // edited through editSubscriptionPrefs — and the companion writes the news
  // memo beside it. Both are the easy-to-forget shape; Reset must clear them.
  subscriptionPrefs: SUBSCRIPTION_PREFS_SECRET_KEY,
  subscriptionNewsSent: SUBSCRIPTION_NEWS_SECRET_KEY,
  // R2's overrides document: edited only through editSyncOverrides, the
  // easy-to-forget shape; Reset must clear it.
  syncOverrides: SYNC_OVERRIDES_SECRET_KEY,
} as const;

/** One entry in the shared large-transaction outbox. Derived from `SyncResult`
 *  rather than re-typed so the queued shape can never drift from the emitted one
 *  — a mismatch would only surface as an alert rendered with `undefined` in it. */
export type PendingLargeTxAlert = SyncResult['largeTransactionAlerts'][number];

export class SecretsStore {
  constructor(private ctx: AddonContext) {}

  /** The add-on's change-log writer: ONE per store, and the add-on makes one
   *  store per load, so a sync and a button append through the same queue. */
  private readonly changeLog = createChangeLogWriter({
    writer: 'addon',
    log: (msg) => console.warn(`[simplefin-sync] ${msg}`),
  });

  private changeLogIo(): ChangeLogIo {
    return {
      get: (k) => this.ctx.api.secrets.get(k),
      set: (k, v) => this.ctx.api.secrets.set(k, v),
      clear: (k) => this.ctx.api.secrets.delete(k),
    };
  }

  /** Appends stamped entries. Never rejects: a failed append becomes a gap
   *  record on the next one (shared/change-log.ts). */
  async recordChanges(entries: ChangeEntry[]): Promise<void> {
    await this.changeLog.append(this.changeLogIo(), entries);
  }

  /** One entry for something the person did in the app (`actor: 'you'`). */
  async recordChange(draft: ChangeDraft): Promise<void> {
    await this.recordChanges([stampChange(draft, 'addon', new Date())]);
  }

  /** As `recordChange`, but says whether THIS entry was written (the same
   *  queue, the same gap record on a failure): for a caller that must not
   *  promise an Undo it cannot give (W11's payback). Never rejects. */
  async recordChangeStrict(draft: ChangeDraft): Promise<boolean> {
    const { saved } = await this.changeLog.appendStrict(this.changeLogIo(), [stampChange(draft, 'addon', new Date())]);
    return saved;
  }

  /** What `runSync` hands the core: this writer, a fresh run id. */
  changeLogSink(now = new Date()): ChangeLogSink {
    return { writer: 'addon', run: newRunId('addon', now), append: (entries) => this.recordChanges(entries) };
  }

  /** Both writers' log, merged. Null when the host read itself fails; a
   *  corrupt bucket is reported inside the result, not as null. */
  async getChangeLog(): Promise<ChangeLogRead | null> {
    try {
      return await readChangeLog((k) => this.ctx.api.secrets.get(k), new Date());
    } catch {
      return null;
    }
  }

  /** Writes this build's version where the companion's self-check can read it,
   *  so a half-finished update (image pulled, zip not — or the reverse) shows
   *  up in the daily report. Read-first: the value changes once per release,
   *  and every other app start would otherwise be a pointless secret write. */
  async publishAddonVersion(): Promise<void> {
    const current = await this.ctx.api.secrets.get(ADDON_VERSION_SECRET_KEY);
    if (current === SIMPLEFIN_SYNC_VERSION) return;
    await this.ctx.api.secrets.set(ADDON_VERSION_SECRET_KEY, SIMPLEFIN_SYNC_VERSION);
  }

  /** A report's live edition and archive, published by the companion. */
  async getReports(kind: ReportKind): Promise<ReportStore> {
    return parseReportStore(await this.ctx.api.secrets.get(reportsSecretKey(kind)));
  }

  /** Which sent editions this person has seen (project 5): ok, absent (the
   *  first run) or corrupt. Rejects when the host read itself fails, so the
   *  page can tell that apart and write nothing. */
  async getReportsSeen(): Promise<ReportsSeenRead> {
    return parseReportsSeen(await this.ctx.api.secrets.get(KEYS.reportsSeen));
  }

  async setReportsSeen(seen: ReportsSeen): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.reportsSeen, JSON.stringify(seen));
  }

  async getAccessUrl(): Promise<string | null> {
    return this.ctx.api.secrets.get(KEYS.accessUrl);
  }
  async setAccessUrl(url: string): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.accessUrl, url);
  }

  // The Wealthfolio SDK only supports Bearer auth for brokered requests.
  // We store the pre-computed base64(user:pass) so the backend injects
  // "Authorization: Bearer <base64>" which SimpleFin may accept.
  async getAuthB64Key(): Promise<string> {
    return KEYS.authB64;
  }
  async setAuthB64(credentialsB64: string): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.authB64, credentialsB64);
  }

  async getAccountMapping(): Promise<AccountMapping | null> {
    const raw = await this.ctx.api.secrets.get(KEYS.accountMapping);
    return raw ? (JSON.parse(raw) as AccountMapping) : null;
  }
  async setAccountMapping(mapping: AccountMapping): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.accountMapping, JSON.stringify(mapping));
  }

  /** Display names of SimpleFin accounts, keyed by SimpleFin account ID.
   *  Captured at setup so the sync page can show names instead of raw IDs. */
  async getAccountNames(): Promise<Record<string, string>> {
    const raw = await this.ctx.api.secrets.get(KEYS.accountNames);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  }
  async setAccountNames(names: Record<string, string>): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.accountNames, JSON.stringify(names));
  }

  /** SimpleFin account IDs that already received a starting-balance entry. */
  async getBalanceInitialized(): Promise<string[]> {
    const raw = await this.ctx.api.secrets.get(KEYS.balanceInitialized);
    return raw ? (JSON.parse(raw) as string[]) : [];
  }
  async addBalanceInitialized(sfinAccountId: string): Promise<void> {
    const current = await this.getBalanceInitialized();
    if (!current.includes(sfinAccountId)) {
      await this.ctx.api.secrets.set(
        KEYS.balanceInitialized,
        JSON.stringify([...current, sfinAccountId]),
      );
    }
  }

  async getMappingRules(): Promise<MappingRule[]> {
    const raw = await this.ctx.api.secrets.get(KEYS.mappingRules);
    return raw ? (JSON.parse(raw) as MappingRule[]) : [];
  }
  async setMappingRules(rules: MappingRule[]): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.mappingRules, JSON.stringify(rules));
  }

  async getSyncScheduleHours(): Promise<number | null> {
    const raw = await this.ctx.api.secrets.get(KEYS.syncScheduleHours);
    return raw ? Number(raw) : null;
  }
  async setSyncScheduleHours(hours: number): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.syncScheduleHours, String(hours));
  }

  /** When on, every sync runs in heal mode (wide 90-day re-scan to recover
   *  missing transactions + accurate drift). The residual plug stays manual. */
  async getAutoHeal(): Promise<boolean> {
    return (await this.ctx.api.secrets.get(KEYS.autoHeal)) === 'true';
  }
  async setAutoHeal(on: boolean): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.autoHeal, on ? 'true' : 'false');
  }

  /** Aggressive heal: on top of the re-scan, automatically insert a balance
   *  adjustment for any residual drift each sync (no prompt). Implies auto-heal. */
  async getAutoAdjust(): Promise<boolean> {
    return (await this.ctx.api.secrets.get(KEYS.autoAdjust)) === 'true';
  }
  async setAutoAdjust(on: boolean): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.autoAdjust, on ? 'true' : 'false');
  }

  async getLastSyncAt(): Promise<Date | null> {
    const raw = await this.ctx.api.secrets.get(KEYS.lastSyncAt);
    return raw ? new Date(raw) : null;
  }
  async setLastSyncAt(date: Date): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.lastSyncAt, date.toISOString());
  }

  /** Ledger of SimpleFin tx id → shared sourceGroupId for linked transfer
   *  pairs. `ActivityDetails` doesn't expose sourceGroupId, so we track which
   *  pairs we've already linked here to keep re-linking idempotent (no churn). */
  async getLinkedGroups(): Promise<Record<string, string>> {
    const raw = await this.ctx.api.secrets.get(KEYS.linkedGroups);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  }
  async setLinkedGroups(map: Record<string, string>): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.linkedGroups, JSON.stringify(map));
  }

  async getTransferLinkFailures(): Promise<Record<string, TransferLinkFailureEntry>> {
    const raw = await this.ctx.api.secrets.get(KEYS.transferLinkFailures);
    return raw ? (JSON.parse(raw) as Record<string, TransferLinkFailureEntry>) : {};
  }
  async setTransferLinkFailures(map: Record<string, TransferLinkFailureEntry>): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.transferLinkFailures, JSON.stringify(map));
  }

  /** Refused imports already announced, shared with the companion (see
   *  shared/refused-alerts.ts). Raw text: the shared module owns the parse. */
  async getAnnouncedRefusals(): Promise<string | null> {
    return this.ctx.api.secrets.get(REFUSED_ALERTED_SECRET_KEY);
  }
  async setAnnouncedRefusals(json: string): Promise<void> {
    await this.ctx.api.secrets.set(REFUSED_ALERTED_SECRET_KEY, json);
  }

  /** Category names the companion has seen while building its last report —
   *  read-only from the addon's side, published by the companion. */
  /**
   * Every spending category Wealthfolio knows, with its parent, icon, colour and
   * whether a budget or spending touched it this month.
   *
   * Falls back to the legacy `available_report_categories` string array — which
   * only ever held budgeted-or-spent names — so an addon running against a
   * companion that predates the catalog still lists something rather than
   * nothing. Those entries carry no parent or icon and are marked as having a
   * budget, because that is the only reason the old publisher would have
   * included them.
   */
  async getReportCategoryCatalog(): Promise<CategoryCatalogEntry[]> {
    const raw = await this.ctx.api.secrets.get(KEYS.reportCategoryCatalog);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as CategoryCatalogEntry[];
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      } catch {
        // Unreadable secret: fall through to the legacy list rather than
        // rendering an empty selector.
      }
    }
    const legacy = await this.getAvailableReportCategories();
    return legacy.map((name) => ({
      name, parent: null, icon: null, color: null, hasBudget: true, hasSpend: false,
    }));
  }

  /** Which companion build last synced this instance, or null when no companion
   *  has ever run. The two halves deploy separately and can legitimately differ,
   *  which is exactly why this is worth showing. */
  async getCompanionVersion(): Promise<string | null> {
    const raw = await this.ctx.api.secrets.get(KEYS.companionVersion);
    return raw && raw.trim() ? raw.trim() : null;
  }

  /** The installed zip's manifest version, as the companion read it off disk;
   *  null when no companion can see the addons directory. */
  async getInstalledAddonVersion(): Promise<string | null> {
    const raw = await this.ctx.api.secrets.get(INSTALLED_ADDON_VERSION_SECRET_KEY);
    return raw && raw.trim() ? raw.trim() : null;
  }

  /** The Wealthfolio version the companion last synced against (`GET
   *  /app/info`); null when no companion has published one. The SDK cannot ask. */
  async getWealthfolioVersion(): Promise<string | null> {
    const raw = await this.ctx.api.secrets.get(WEALTHFOLIO_VERSION_SECRET_KEY);
    return raw && raw.trim() ? raw.trim() : null;
  }

  async getAvailableReportCategories(): Promise<string[]> {
    const raw = await this.ctx.api.secrets.get(KEYS.availableReportCategories);
    return raw ? (JSON.parse(raw) as string[]) : [];
  }

  /** Reported verbatim from `telegram_config`; `runSyncCore` owns what an absent
   *  value means (see `SyncStore`). A non-numeric stored value reads as absent. */
  async getLargeTransactionThreshold(): Promise<number | null> {
    const tg = await this.getTelegramConfig();
    const raw = tg?.largeTransactionThreshold;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  }

  /** As `getLargeTransactionThreshold`: verbatim, no defaults applied here. */
  async getDriftAlertThreshold(): Promise<number | null> {
    const tg = await this.getTelegramConfig();
    const raw = tg?.driftAlertThreshold;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  }

  /** Open balance-drift episodes, keyed by SimpleFin account ID. An entry means
   *  the user has already been told; deleting it re-arms the alert. */
  async getDriftAlerts(): Promise<Record<string, DriftAlertEntry>> {
    const raw = await this.ctx.api.secrets.get(KEYS.driftAlerts);
    return raw ? (JSON.parse(raw) as Record<string, DriftAlertEntry>) : {};
  }
  async setDriftAlerts(map: Record<string, DriftAlertEntry>): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.driftAlerts, JSON.stringify(map));
  }

  /**
   * Large-transaction alerts nobody has managed to deliver yet — the SAME secret
   * the companion queues into, so whichever syncer imported the row, exactly one
   * of them ends up announcing it.
   *
   * A malformed value degrades to an empty queue rather than throwing: the only
   * writer is this codebase, so a parse failure means the secret was truncated or
   * hand-edited, and no amount of retrying fixes that. Throwing here would abort
   * alert delivery for the whole run (and, before the caller's guard, get recorded
   * as a sync failure) over a state that is already unrecoverable.
   */
  async getPendingLargeTxAlerts(): Promise<PendingLargeTxAlert[]> {
    const raw = await this.ctx.api.secrets.get(KEYS.pendingLargeTxAlerts);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as PendingLargeTxAlert[]) : [];
    } catch {
      return [];
    }
  }
  async setPendingLargeTxAlerts(alerts: PendingLargeTxAlert[]): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.pendingLargeTxAlerts, JSON.stringify(alerts));
  }

  /**
   * Amazon orders awaiting their charge. The COMPANION writes this (it reads the
   * mailbox); the addon reads it here so an addon-side sync enriches identically.
   *
   * A malformed value degrades to an empty ledger, which switches Amazon
   * categorization off for the run — the same failure mode as never having set it
   * up. Throwing would abort the whole sync over an optional nicety.
   */
  async getAmazonLedger(): Promise<AmazonLedger> {
    const raw = await this.ctx.api.secrets.get(AMAZON_LEDGER_SECRET_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as AmazonLedger)
        : {};
    } catch {
      return {};
    }
  }
  async setAmazonLedger(map: AmazonLedger): Promise<void> {
    await this.ctx.api.secrets.set(AMAZON_LEDGER_SECRET_KEY, JSON.stringify(map));
  }

  /** Venmo payments awaiting their bank row (3), so an add-on sync adds the
   *  same notes the companion's does. Absent reads as empty; a document that is
   *  present but unreadable THROWS, so the sync turns Venmo off (and says so)
   *  and nothing overwrites it. */
  async getVenmoLedger(): Promise<VenmoLedger> {
    const raw = await this.ctx.api.secrets.get(VENMO_LEDGER_SECRET_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the Venmo payments list is not an object');
    return parsed as VenmoLedger;
  }
  async setVenmoLedger(map: VenmoLedger): Promise<void> {
    await this.ctx.api.secrets.set(VENMO_LEDGER_SECRET_KEY, JSON.stringify(map));
  }

  /** How many activities the last completed run imported. Written by both syncers,
   *  so the Sync page's tile reports whichever ran last rather than only the runs
   *  the user triggered in the current page session. */
  async getLastSyncImported(): Promise<number | null> {
    const raw = await this.ctx.api.secrets.get(KEYS.lastSyncImported);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  async setLastSyncImported(count: number): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.lastSyncImported, String(count));
  }

  /**
   * Amazon forwarding-mailbox settings, written by the Sync page and read by the
   * companion (which is the only thing that connects to a mailbox).
   */
  async getAmazonConfig(): Promise<AmazonMailConfig | null> {
    const raw = await this.ctx.api.secrets.get(AMAZON_CONFIG_SECRET_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AmazonMailConfig;
    } catch {
      return null;
    }
  }
  async setAmazonConfig(cfg: AmazonMailConfig): Promise<void> {
    await this.ctx.api.secrets.set(AMAZON_CONFIG_SECRET_KEY, JSON.stringify(cfg));
  }

  /**
   * Every Amazon label the user has actually received, and where it was filed.
   *
   * Read-only here — the companion discovers these. Showing the user their OWN
   * label set matters more than any global list would: Amazon's vocabulary is
   * unpublished and probably hundreds long, but a given household sees a dozen.
   */
  async getAmazonLabels(): Promise<AmazonLabelCatalog> {
    const raw = await this.ctx.api.secrets.get(AMAZON_LABELS_SECRET_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** Latest per-account SimpleFin balance + drift, keyed by SimpleFin account
   *  ID. Captured each sync so the Sync page can show balances instantly. */
  async getAccountBalances(): Promise<Record<string, AccountBalanceInfo>> {
    const raw = await this.ctx.api.secrets.get(KEYS.accountBalances);
    return raw ? (JSON.parse(raw) as Record<string, AccountBalanceInfo>) : {};
  }
  async setAccountBalances(map: Record<string, AccountBalanceInfo>): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.accountBalances, JSON.stringify(map));
  }

  /**
   * SimpleFin accounts the last sync found no mapping for. Written by every
   * sync (including the companion's, through its own host), read by the
   * Overview to offer mapping them.
   *
   * A malformed value degrades to "none" rather than surfacing an error: the
   * cost is a missed prompt, and the next sync rewrites it.
   */
  async getUnmappedAccounts(): Promise<UnmappedAccount[]> {
    const raw = await this.ctx.api.secrets.get(KEYS.unmappedAccounts);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as UnmappedAccount[]) : [];
    } catch {
      return [];
    }
  }
  async setUnmappedAccounts(list: UnmappedAccount[]): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.unmappedAccounts, JSON.stringify(list));
  }

  /**
   * SimpleFin account ids the user has chosen not to sync. Filtered out of
   * `unmappedAccounts` by the sync core, which silences both the Overview
   * banner and the companion's Telegram notice for them.
   *
   * Malformed degrades to "none ignored": that over-reports (the banner comes
   * back) rather than hiding an account the user never meant to exclude.
   */
  async getIgnoredAccounts(): Promise<string[]> {
    const raw = await this.ctx.api.secrets.get(KEYS.ignoredAccounts);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }
  async setIgnoredAccounts(ids: string[]): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.ignoredAccounts, JSON.stringify(ids));
  }

  /** The learned transfer names the companion publishes (null when absent or unreadable). */
  async getTransferNames(): Promise<TransferNames | null> {
    return parseTransferNames(await this.ctx.api.secrets.get(KEYS.transferNames));
  }

  /**
   * The SimpleFin request record both writers share (shared/simplefin-budget.ts).
   * Deliberately NOT in `KEYS`: Reset must not erase a count SimpleFin keeps
   * making. A failed read rejects, so the budget fails closed.
   */
  async getSimplefinRequests(): Promise<string | null> {
    return (await this.ctx.api.secrets.get(SIMPLEFIN_REQUESTS_SECRET_KEY)) ?? null;
  }
  async setSimplefinRequests(raw: string): Promise<void> {
    await this.ctx.api.secrets.set(SIMPLEFIN_REQUESTS_SECRET_KEY, raw);
  }

  /** Bank transactions never to import (see shared/skipped-transactions.ts). */
  async getSkippedTransactions(): Promise<SkippedTransaction[]> {
    return parseSkippedTransactions(await this.ctx.api.secrets.get(KEYS.skippedTransactions));
  }

  /** The skip list with corrupt told apart from absent (a story must not say
   *  "none" for a list it cannot read). */
  async readSkippedTransactions(): Promise<ParsedSkippedTransactions> {
    return parseSkippedTransactionsStrict(await this.ctx.api.secrets.get(KEYS.skippedTransactions));
  }

  /** Rules for bank transactions never to import, by description
   *  (shared/ignore-rules.ts). What the sync obeys: unreadable reads as none. */
  async getIgnoreRules(): Promise<IgnoreRule[]> {
    return parseIgnoreRules(await this.ctx.api.secrets.get(KEYS.ignoreRules));
  }

  /** The rules with corrupt told apart from absent, for the editor: a list it
   *  cannot read must not show as "None" and then be saved over. */
  async readIgnoreRules(): Promise<ParsedIgnoreRules> {
    return parseIgnoreRulesStrict(await this.ctx.api.secrets.get(KEYS.ignoreRules));
  }

  /** Replace the rules. Refuses a rule that would ignore everything (the editor
   *  already does; this is the last line, because an empty Deposit rule once
   *  turned every card row into a deposit), and writes nothing over a stored
   *  list it cannot read, which would drop the rules it did not understand. */
  async setIgnoreRules(rules: IgnoreRule[]): Promise<void> {
    for (const rule of rules) {
      const problem = ignoreRuleProblem(rule);
      if (problem) throw new Error(IGNORE_PROBLEM_TEXT[problem]);
    }
    const current = parseIgnoreRulesStrict(await this.ctx.api.secrets.get(KEYS.ignoreRules));
    if (current.kind === 'corrupt') throw new IgnoreRulesUnreadableError();
    await this.ctx.api.secrets.set(KEYS.ignoreRules, JSON.stringify(normalizeIgnoreRules(rules)));
  }

  /** What the sync obeys (shared/sync-overrides.ts): corrupt, absent and a
   *  failed read all come back empty — the sync then behaves as it always did,
   *  and a corrupt or unread document gets one log line saying so. */
  async getSyncOverrides(): Promise<SyncOverrides> {
    return syncOverridesOrEmpty((k) => this.ctx.api.secrets.get(k), (why) => console.warn(syncOverridesIgnoredLog(why)));
  }

  /** The document for the Change log card's "Your overrides": `unreadable` when
   *  a stored one cannot be read (the list then turns read-only). Null when
   *  the host read itself fails. */
  async readSyncOverrides(): Promise<LoadedSyncOverrides | null> {
    try {
      return await loadSyncOverrides((k) => this.ctx.api.secrets.get(k));
    } catch {
      return null;
    }
  }

  /** One edit, re-read immediately before the write (the companion writes the
   *  same document). Rejects with SyncOverridesUnreadableError, writing
   *  nothing, when the stored document is corrupt. */
  async editSyncOverrides(edit: SyncOverridesEdit): Promise<SyncOverrides> {
    return editOverridesDocument(
      (k) => this.ctx.api.secrets.get(k),
      (k, v) => this.ctx.api.secrets.set(k, v),
      edit,
      new Date(),
    );
  }

  /** Which collapsible config cards the user left open, keyed by card id.
   *  Purely cosmetic, so a malformed value degrades to "everything closed"
   *  rather than surfacing an error — but it is worth storing: the account
   *  rows navigate away from the page, so without this every trip back to a
   *  half-configured card starts from collapsed. */
  async getOpenCards(): Promise<Record<string, boolean>> {
    const raw = await this.ctx.api.secrets.get(KEYS.openCards);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  async setOpenCards(open: Record<string, boolean>): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.openCards, JSON.stringify(open));
  }

  /** Page-level UI state (active tab, checklist dismissal). Separate from
   *  `open_cards`, which keeps per-disclosure open state inside tabs. */
  async getUiState(): Promise<UiState> {
    const raw = await this.ctx.api.secrets.get(KEYS.uiState);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  async setUiState(state: UiState): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.uiState, JSON.stringify(state));
  }

  /** Companion-published count of uncategorized spending (last 90 days).
   *  `null` (absent/corrupt) hides the Overview tile — the addon cannot compute
   *  this itself: the SDK exposes no category data. */
  /** The companion's sync-health record — written ONLY by the companion, so a
   *  recent `lastSuccessAt` is the evidence that one is running (and sending
   *  the daily report). Null when absent or unreadable. */
  async getSyncHealth(): Promise<{ lastSuccessAt?: string | null } | null> {
    const raw = await this.ctx.api.secrets.get('sync_health');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  async getUncategorizedStatus(): Promise<{ count: number; asOf: string; rows: UncategorizedRow[] } | null> {
    const raw = await this.ctx.api.secrets.get(UNCATEGORIZED_STATUS_SECRET_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed?.count === 'number' && Number.isFinite(parsed.count)
        ? {
            count: parsed.count,
            asOf: String(parsed.asOf ?? ''),
            // Absent on a v1.10.0 companion — an empty list, not a failure. The
            // tile renders from `count`; only the disclosure needs `rows`.
            rows: Array.isArray(parsed.rows) ? (parsed.rows as UncategorizedRow[]) : [],
          }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Companion-published count of Amazon order emails whose shape the parser
   * did not recognise on the last mail scan — the persistent signal that
   * Amazon changed its email format (see `AMAZON_MAIL_STATUS_SECRET_KEY`).
   *
   * `null` (absent/corrupt/non-numeric) hides the warning rather than
   * throwing: a companion that predates this key, or one whose Amazon mail
   * isn't configured, must look identical to "no problem" — never an error.
   */
  async getAmazonMailStatus(): Promise<AmazonMailStatus | null> {
    const raw = await this.ctx.api.secrets.get(AMAZON_MAIL_STATUS_SECRET_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed?.unparsed === 'number' && Number.isFinite(parsed.unparsed)
        ? {
          unparsed: parsed.unparsed,
          asOf: String(parsed.asOf ?? ''),
          ...(typeof parsed.lastMailAt === 'string' ? { lastMailAt: parsed.lastMailAt } : {}),
          ...(typeof parsed.error === 'string' && parsed.error ? { error: parsed.error } : {}),
        }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Companion-published copies of the Amazon emails the parser could not read
   * (see `AMAZON_MAIL_SAMPLES_SECRET_KEY`). `null` when absent or corrupt, and
   * malformed entries are dropped — like the status, an older companion that
   * never writes this must look identical to "nothing to show".
   */
  async getAmazonMailSamples(): Promise<AmazonMailSamples | null> {
    const raw = await this.ctx.api.secrets.get(AMAZON_MAIL_SAMPLES_SECRET_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.samples)) return null;
      const samples = parsed.samples.filter((s: any) => s
        && typeof s.subject === 'string' && typeof s.plain === 'string' && typeof s.html === 'string');
      return { asOf: String(parsed.asOf ?? ''), samples };
    } catch {
      return null;
    }
  }

  /** Transactions the user has chosen to leave uncategorized. The SAME secret
   *  the Telegram dismiss buttons write and the companion sweep filters on —
   *  two ledgers answering one question is the defect this shares it to avoid. */
  async getDismissals(): Promise<DismissalLedger> {
    const raw = await this.ctx.api.secrets.get(KEYS.dismissals);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  async setDismissals(ledger: DismissalLedger): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.dismissals, JSON.stringify(ledger));
  }

  async getTelegramConfig(): Promise<any | null> {
    const raw = await this.ctx.api.secrets.get(KEYS.telegramConfig);
    return raw ? JSON.parse(raw) : null;
  }
  async setTelegramConfig(config: any): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.telegramConfig, JSON.stringify(config));
  }

  /** How much decoration the Telegram reports carry. Own secret rather than a
   *  field on `telegram_config`, because it describes report PRESENTATION and is
   *  read by the companion on every report — mixing it into the credentials blob
   *  would mean a token edit and a style edit racing the same value. */
  async getReportGlyphStyle(): Promise<GlyphStylePref> {
    const raw = await this.ctx.api.secrets.get(KEYS.reportGlyphStyle);
    if (!raw) return { mode: 'clean', overrides: {} };
    try {
      const p = JSON.parse(raw) as Partial<GlyphStylePref>;
      return {
        mode: p.mode === 'glyphs' ? 'glyphs' : 'clean',
        overrides: p.overrides && typeof p.overrides === 'object' ? p.overrides : {},
      };
    } catch {
      return { mode: 'clean', overrides: {} };
    }
  }
  async setReportGlyphStyle(style: GlyphStylePref): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.reportGlyphStyle, JSON.stringify(style));
  }

  /** `rollup` sums subcategories into their parent (the long-standing behaviour);
   *  `breakdown` lists children under the parent's budget line. */
  async getSubcategoryDisplay(): Promise<'rollup' | 'breakdown'> {
    const raw = await this.ctx.api.secrets.get(KEYS.subcategoryDisplay);
    return raw === 'breakdown' ? 'breakdown' : 'rollup';
  }
  async setSubcategoryDisplay(mode: 'rollup' | 'breakdown'): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.subcategoryDisplay, mode);
  }

  /**
   * Whether spending in unbudgeted categories is subtracted from the daily
   * digest's "left this month" headline.
   *
   * Stored as the string `'off'` for disabled and anything else (including
   * absent) for enabled — so the DEFAULT is on, matching the weekly report,
   * which has always counted it. Storing the opt-out rather than the opt-in
   * keeps every existing install on the corrected behaviour without a
   * migration.
   */
  async getCountOffBudget(): Promise<boolean> {
    const raw = await this.ctx.api.secrets.get(KEYS.countOffBudget);
    return raw !== 'off';
  }
  async setCountOffBudget(on: boolean): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.countOffBudget, on ? 'on' : 'off');
  }

  /** Whether weekly category figures are capped by the month's remaining pool.
   *  Stores the opt-OUT, so the default is on. */
  async getCapWeeklyToPool(): Promise<boolean> {
    const raw = await this.ctx.api.secrets.get(KEYS.capWeeklyToPool);
    return raw !== 'off';
  }
  async setCapWeeklyToPool(on: boolean): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.capWeeklyToPool, on ? 'on' : 'off');
  }

  /** Which "spent" figures the daily report adds once over budget. Anything
   *  unrecognised reads as the default, so a future value never breaks an
   *  older build. */
  async getOverBudgetSpent(): Promise<'total' | 'all' | 'none'> {
    const raw = await this.ctx.api.secrets.get(KEYS.overBudgetSpent);
    return raw === 'all' || raw === 'none' ? raw : 'total';
  }
  async setOverBudgetSpent(mode: 'total' | 'all' | 'none'): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.overBudgetSpent, mode);
  }

  /** The user's semester-pool config, or null when none (or an invalid one) is
   *  stored. `parsePoolConfig` owns the validation on BOTH writers' behalf. */
  async getSemesterPool(): Promise<SemesterPoolConfig | null> {
    return parsePoolConfig(await this.ctx.api.secrets.get(KEYS.semesterPool));
  }
  /** Null clears — written as an empty string, the same off state the /pool
   *  command writes, because the secrets API has no delete for one key. */
  async setSemesterPool(cfg: SemesterPoolConfig | null): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.semesterPool, cfg ? JSON.stringify(cfg) : '');
  }

  /** The companion-computed pool status behind the Overview tile. Read-only
   *  here: the companion republishes it every sync, and the addon rendering
   *  the same object the reports render is what keeps the two agreeing. */
  async getPoolStatus(): Promise<PoolStatus | null> {
    try {
      const raw = await this.ctx.api.secrets.get(KEYS.poolStatus);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && typeof parsed.phase === 'string'
        ? (parsed as PoolStatus)
        : null;
    } catch {
      return null;
    }
  }

  /** The companion-published report cube behind the Budget tab. Read-only
   *  here; `parseReportCube` owns validation (unknown versions and ragged
   *  shapes read as "companion not ready", never as data). */
  async getReportCube(): Promise<ReportCube | null> {
    try {
      return parseReportCube(await this.ctx.api.secrets.get(KEYS.reportCube));
    } catch {
      return null;
    }
  }

  /** The companion's audit snapshot (2c): ok, absent (none published yet)
   *  or corrupt. A host read that fails reads as corrupt too: the Checks card
   *  then says it could not read them, never that there are none. */
  async getAuditSnapshot(): Promise<AuditSnapshotRead> {
    try {
      return parseAuditSnapshot(await this.ctx.api.secrets.get(KEYS.auditSnapshot));
    } catch {
      return { kind: 'corrupt' };
    }
  }

  /** The companion's cash forecast (project 5): ok, absent or corrupt. A
   *  host read that fails reads as corrupt, never as "none published". */
  async getCashForecast(): Promise<CashForecastRead> {
    try {
      return parseCashForecast(await this.ctx.api.secrets.get(KEYS.cashForecast));
    } catch {
      return { kind: 'corrupt' };
    }
  }

  /** The user's saved custom reports. Malformed entries are dropped
   *  individually by the parser, so one bad row cannot cost the collection. */
  async getCustomReports(): Promise<CustomReport[]> {
    try {
      return parseCustomReports(await this.ctx.api.secrets.get(KEYS.customReports));
    } catch {
      return [];
    }
  }
  async setCustomReports(reports: CustomReport[]): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.customReports, JSON.stringify(reports));
  }

  /** The Budget tab arrangement (heroes/order/hidden). Stored as a preference
   *  and resolved against the reports that exist at render time — see
   *  shared/budget-layout.ts. */
  async getBudgetLayout(): Promise<BudgetLayout | null> {
    try {
      return parseBudgetLayout(await this.ctx.api.secrets.get(KEYS.budgetLayout));
    } catch {
      return null;
    }
  }
  /** The subscription document (shared/subscription-prefs.ts), or the legacy
   *  lists while none exists. Null when the host read itself fails: the card
   *  then shows a read-only notice (a real empty document is not null). */
  async getSubscriptionPrefs(): Promise<LoadedSubscriptionPrefs | null> {
    try {
      return await loadSubscriptionPrefs((k) => this.ctx.api.secrets.get(k));
    } catch {
      return null;
    }
  }

  /** One edit, re-read immediately before the write so a change made from
   *  Telegram since this page loaded is kept; the legacy lists are mirrored.
   *  Rejects with SubscriptionPrefsUnreadableError, writing nothing, when the
   *  stored document is corrupt. */
  async editSubscriptionPrefs(edit: SubscriptionEdit): Promise<SubscriptionPrefs> {
    return editPrefsDocument(
      (k) => this.ctx.api.secrets.get(k),
      (k, v) => this.ctx.api.secrets.set(k, v),
      edit,
      new Date(),
    );
  }

  /** Deletes the stored layout so the defaults come back — the Budget tab's
   *  Reset button. Distinct from writing an "empty" layout, which would pin
   *  nothing and hide nothing but still count as customized. */
  async clearBudgetLayout(): Promise<void> {
    await this.ctx.api.secrets.delete(KEYS.budgetLayout);
  }
  async setBudgetLayout(layout: BudgetLayout): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.budgetLayout, JSON.stringify(layout));
  }

  async clearAll(): Promise<void> {
    // The change log's buckets are keyed by month, so they cannot sit in KEYS:
    // both writers' keys (and `.2` fallbacks) for this month and the four
    // before it are generated, since the secrets API cannot list keys.
    await Promise.all([...Object.values(KEYS), ...changeLogResetKeys(new Date())].map((k) => this.ctx.api.secrets.delete(k)));
  }
}
