import type { AddonContext } from '@wealthfolio/addon-sdk';
import { AMAZON_LEDGER_SECRET_KEY } from '../../shared/amazon-ledger';
import { AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY } from '../../shared/amazon-config';
import type { AmazonLabelCatalog, AmazonMailConfig } from '../../shared/amazon-config';
import type { AmazonLedger } from '../../shared/amazon-ledger';
import type { AccountMapping, MappingRule } from '../../shared/types';
import type { DriftAlertEntry, TransferLinkFailureEntry } from '../../shared/sync-host';
import type { SyncResult } from '../../shared/sync-core';
import { LARGE_TX_OUTBOX_SECRET_KEY } from '../../shared/telegram';

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
  accountBalances: 'account_balances',
  autoHeal: 'auto_heal',
  autoAdjust: 'auto_adjust',
  telegramConfig: 'telegram_config',
  availableReportCategories: 'available_report_categories',
  companionVersion: 'companion_version',
  reportCategoryCatalog: 'report_category_catalog',
  reportGlyphStyle: 'report_glyph_style',
  subcategoryDisplay: 'subcategory_display',
  openCards: 'ui_open_cards',
  pendingLargeTxAlerts: LARGE_TX_OUTBOX_SECRET_KEY,
} as const;

/** One entry in the shared large-transaction outbox. Derived from `SyncResult`
 *  rather than re-typed so the queued shape can never drift from the emitted one
 *  — a mismatch would only surface as an alert rendered with `undefined` in it. */
export type PendingLargeTxAlert = SyncResult['largeTransactionAlerts'][number];

export class SecretsStore {
  constructor(private ctx: AddonContext) {}

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

  async clearAll(): Promise<void> {
    await Promise.all(Object.values(KEYS).map((k) => this.ctx.api.secrets.delete(k)));
  }
}
