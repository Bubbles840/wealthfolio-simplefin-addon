import { fetchAccountsNode } from './simplefin.js';
import { getNativeAccountBalances } from './sqlite-native.js';
import { AMAZON_LEDGER_SECRET_KEY } from '../../shared/amazon-ledger.js';
import { AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY } from './amazon-mail.js';
import type { AmazonLabelCatalog, AmazonMailConfig } from './amazon-mail.js';
import type { AmazonLedger } from '../../shared/amazon-ledger.js';
import { VENMO_LEDGER_SECRET_KEY, type VenmoLedger } from '../../shared/venmo-ledger.js';
import { linkPairPreferInPlace, unlinkPairPreferInPlace, type InPlaceIo } from '../../shared/link-in-place.js';
import type { UnlinkLeg, UnlinkResult } from '../../shared/link-pair.js';
import { SIMPLEFIN_REQUESTS_SECRET_KEY } from '../../shared/simplefin-budget.js';
import { TRANSFER_NAMES_SECRET_KEY, parseTransferNames, type TransferNames } from '../../shared/transfer-names.js';
import { SKIPPED_TRANSACTIONS_SECRET_KEY, parseSkippedTransactions, type SkippedTransaction } from '../../shared/skipped-transactions.js';
import { IGNORE_RULES_SECRET_KEY, parseIgnoreRules, type IgnoreRule } from '../../shared/ignore-rules.js';
import { confirmLoanBalance, LOAN_LINKS_SECRET_KEY, parseLoanLinks, type LoanBalance, type LoanBalanceDecision, type LoanLinks } from '../../shared/loan-balances.js';
import { loadSyncOverrides, syncOverridesIgnoredLog, syncOverridesOrEmpty, type LoadedSyncOverrides, type SyncOverrides } from '../../shared/sync-overrides.js';
import { hostTakesCardTransferOut, WEALTHFOLIO_VERSION_SECRET_KEY } from '../../shared/version.js';
import type { WealthfolioClient } from './wealthfolio.js';
import type {
  HostActivity,
  ImportRow,
  LinkLeg,
  LinkResult,
  SaveManyRequest,
  SaveManyResult,
  SyncHost,
  SyncStore,
  TransferLinkFailureEntry,
  DriftAlertEntry,
} from '../../shared/sync-host.js';
import type { AccountMapping, MappingRule, SimplefinAccountSet, TelegramConfig, UnmappedAccount } from '../../shared/types.js';

function toIsoDate(value: unknown): string {
  if (value === null || value === undefined) return '';
  const d = new Date(value as string | number | Date);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}

function fromSearchItem(a: any, wfAccountId = ''): HostActivity {
  return {
    id: String(a.id ?? ''),
    accountId: String(a.accountId ?? wfAccountId),
    activityType: String(a.activityType ?? ''),
    date: toIsoDate(a.date),
    amount: a.amount ?? null,
    fee: a.fee ?? null,
    comment: a.comment ?? a.notes ?? a.description ?? null,
    assetId: a.assetId ? String(a.assetId) : undefined,
    sourceGroupId: a.sourceGroupId ?? null,
    subtype: a.subtype ?? null,
    // Passed through as-is, and ABSENT (not null) when the response has no
    // such field: an older server that cannot report metadata must read as
    // "unknown", or the sync would re-stamp its rows on every run.
    ...('metadata' in a ? { metadata: a.metadata ?? null } : {}),
  };
}

/** Page size for the `listOldestActivities` sweep, and the number of pages it
 *  will pull before giving up. 20 × 500 = 10,000 activities on one account —
 *  far beyond a personal-finance dataset, but a finite bound so a server that
 *  never returns a short page cannot spin forever. */
const OLDEST_SWEEP_PAGE_SIZE = 500;
const OLDEST_SWEEP_MAX_PAGES = 20;

export class RestSyncHost implements SyncHost {
  /** `cardTransferOut`: Wealthfolio 3.10+ (see `syncHostFor`). */
  readonly capabilities: { readsSourceGroupId: boolean; cardTransferOut: boolean };

  private log?: (message: string) => void;

  /** `dbPath` is optional so every existing construction and test keeps
   *  working; without it the ledger-balance fallback simply stays unavailable,
   *  which is the behaviour that existed before it. `opts.log` is the
   *  companion's logger (Task 4); `opts.cardTransferOut` the 3.10 capability. */
  constructor(
    private client: WealthfolioClient,
    private dbPath?: string,
    opts: { cardTransferOut?: boolean; log?: (message: string) => void } = {},
  ) {
    this.log = opts.log;
    this.capabilities = { readsSourceGroupId: true, cardTransferOut: !!opts.cardTransferOut };
  }

  async confirmLoanBalance(assetId: string, entry: LoanBalance): Promise<LoanBalanceDecision> {
    return confirmLoanBalance({
      history: async (id) => (await this.client.getQuoteHistory(id)).map((q) => ({
        date: String(q.timestamp).slice(0, 10), close: q.close, dataSource: q.dataSource, notes: q.notes ?? null,
      })),
      write: (id, quote) => this.client.updateQuote(id, quote),
    }, assetId, entry);
  }

  /**
   * Balances summed from each account's own activities, for the accounts
   * Wealthfolio's valuations API omits — in practice every credit card.
   *
   * Only the companion can answer this: it needs the whole ledger, and the
   * addon has no database. See `getNativeAccountBalances` for why the figure
   * excludes pending rows.
   */
  async ledgerBalances(accountIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.dbPath) return out;
    const all = getNativeAccountBalances(this.dbPath);
    for (const id of accountIds) {
      const balance = all.get(id);
      if (balance !== undefined) out.set(id, balance);
    }
    return out;
  }

  /**
   * Each requested account's posted total, read LIVE from the database after
   * the run's saves (1.64, B2). Only a live open is allowed: when just the
   * stale `immutable` snapshot opens, nothing is returned and every card stays
   * "not checked" rather than showing a verdict from days ago.
   */
  async postedLedgerTotals(accounts: Array<{ wfAccountId: string; accountType: string }>): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.dbPath) return out;
    const all = getNativeAccountBalances(this.dbPath, { liveOnly: true });
    for (const a of accounts) {
      const balance = all.get(a.wfAccountId);
      if (balance !== undefined) out.set(a.wfAccountId, balance);
    }
    return out;
  }

  async fetchSimplefin(
    accessUrl: string,
    since: Date,
    _authKey?: string | null,
  ): Promise<SimplefinAccountSet> {
    return fetchAccountsNode(accessUrl, since);
  }

  async listAccounts(): Promise<Array<{ id: string; accountType: string; name?: string; currency?: string }>> {
    const accounts = await this.client.getAccounts();
    return accounts.map((a: any) => ({
      id: a.id,
      accountType: String(a.accountType ?? ''),
      name: a.name,
      ...(a.currency ? { currency: String(a.currency) } : {}),
    }));
  }

  async latestValuations(accountIds: string[]): Promise<Map<string, number>> {
    const valuations = await this.client.getLatestValuations();
    const map = new Map<string, number>();
    for (const id of accountIds) {
      const v = valuations.find((val) => val.accountId === id);
      if (v !== undefined) {
        map.set(id, typeof v.totalValue === 'number' ? v.totalValue : parseFloat(String(v.totalValue)));
      }
    }
    return map;
  }

  /** The account's recent activities. `page` is 0-INDEXED on this endpoint (the
   *  SDK adapter's `activities.search` calls pass 0 too) — asking for page 1
   *  returned an empty list on every account with fewer than `pageSize` rows,
   *  which made the sync core plan a create for every transaction and get the
   *  whole batch rejected as duplicates. */
  async listActivities(wfAccountId: string): Promise<HostActivity[]> {
    const items = await this.client.searchActivities({
      page: 0,
      pageSize: 500,
      accountIdFilter: [wfAccountId],
    });
    return items.map((a) => fromSearchItem(a, wfAccountId));
  }

  /**
   * The account's `limit` OLDEST activities, date ascending — the ordering the
   * starting-balance marker lookup depends on (see `SyncHost`).
   *
   * The REST search endpoint's request body carries no sort field, so a single
   * page arrives in the server's default order, which is newest-first. This
   * adapter therefore does not trust the server's ordering at all: it sweeps
   * every page and sorts ascending itself. Sorting one page client-side would
   * NOT do — the newest N rows sorted ascending are still the newest N rows, and
   * the marker (by construction the oldest row) would still be missed.
   *
   * The only way this can now come back incomplete is the page cap, and hitting
   * it logs a warning naming this method.
   */
  async listOldestActivities(wfAccountId: string, limit: number): Promise<HostActivity[]> {
    const all: HostActivity[] = [];
    let page = 0;
    for (; page < OLDEST_SWEEP_MAX_PAGES; page++) {
      const items = await this.client.searchActivities({
        page,
        pageSize: OLDEST_SWEEP_PAGE_SIZE,
        accountIdFilter: [wfAccountId],
      });
      for (const a of items) all.push(fromSearchItem(a, wfAccountId));
      // A short (or empty) page is the last page.
      if (items.length < OLDEST_SWEEP_PAGE_SIZE) break;
    }
    if (page >= OLDEST_SWEEP_MAX_PAGES) {
      console.warn(
        `[simplefin-sync] listOldestActivities hit its ${OLDEST_SWEEP_MAX_PAGES}-page cap ` +
          `(${OLDEST_SWEEP_MAX_PAGES * OLDEST_SWEEP_PAGE_SIZE} rows) on account ${wfAccountId}; ` +
          'the oldest rows may be beyond the sweep, so the starting-balance marker could be missed.',
      );
    }
    all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return all.slice(0, limit);
  }

  async saveMany(req: SaveManyRequest): Promise<SaveManyResult> {
    const res = await this.client.saveMany({
      creates: req.creates,
      updates: req.updates,
      deleteIds: req.deleteIds,
    });
    return {
      created: (res.created ?? []).map((item) => fromSearchItem(item)),
      updated: (res.updated ?? []).map((item) => fromSearchItem(item)),
      errors: (res.errors ?? []).map((e: any) => ({
        action: String(e.action ?? ''),
        message: String(e.message ?? ''),
      })),
    };
  }

  async importActivities(rows: ImportRow[]): Promise<void> {
    await this.client.importActivities(rows);
  }

  /** Wealthfolio's own link and unlink (`POST /activities/link`, `/unlink`,
   *  3.8+), and the exact-id read right before each. */
  private inPlace(): InPlaceIo {
    return {
      read: (ids) => this.client.searchActivities({ page: 0, pageSize: 2, activityIdFilter: ids }),
      link: (a, b) => this.client.linkTransferActivities(a, b),
      unlink: (a, b) => this.client.unlinkTransferActivities(a, b),
      ...(this.log ? { log: this.log } : {}),
    };
  }

  async linkPair(legs: [LinkLeg, LinkLeg]): Promise<LinkResult> {
    return linkPairPreferInPlace(this.inPlace(), (req) => this.saveMany(req), legs);
  }

  async unlinkPair(legs: [UnlinkLeg, UnlinkLeg]): Promise<UnlinkResult> {
    return unlinkPairPreferInPlace(this.inPlace(), (req) => this.saveMany(req), legs);
  }
}

/**
 * The companion's host for a sync, told what this Wealthfolio takes: a card's
 * bookkeeping outflow is a TRANSFER_OUT from 3.10 (`GET /app/info`; unknown
 * is older). Neither reading the version nor publishing it for the add-on,
 * whose SDK cannot ask, ever stops a sync: a failure is an unknown version.
 */
export async function syncHostFor(
  client: Pick<WealthfolioClient, 'getAppVersion' | 'setAddonSecret'>,
  dbPath?: string,
  log?: (message: string) => void,
): Promise<{ host: RestSyncHost; wealthfolioVersion: string | null }> {
  const wealthfolioVersion = await Promise.resolve().then(() => client.getAppVersion()).catch(() => null);
  if (!wealthfolioVersion) log?.('Wealthfolio version unknown: card bookkeeping stays WITHDRAWAL');
  if (wealthfolioVersion) await client.setAddonSecret('simplefin-sync', WEALTHFOLIO_VERSION_SECRET_KEY, wealthfolioVersion).catch(() => {});
  const host = new RestSyncHost(client as WealthfolioClient, dbPath, {
    cardTransferOut: hostTakesCardTransferOut(wealthfolioVersion),
    ...(log ? { log } : {}),
  });
  return { host, wealthfolioVersion };
}

export class RestSyncStore implements SyncStore {
  private addonId = 'simplefin-sync';

  constructor(private client: WealthfolioClient) {}

  private async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.getAddonSecret(this.addonId, key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  private async setJson(key: string, value: unknown): Promise<void> {
    await this.client.setAddonSecret(this.addonId, key, JSON.stringify(value));
  }

  async getAccessUrl(): Promise<string | null> {
    return this.client.getAddonSecret(this.addonId, 'simplefin_access_url');
  }

  async getAuthB64Key(): Promise<string | null> {
    return null;
  }

  async getAccountMapping(): Promise<AccountMapping | null> {
    return this.getJson<AccountMapping>('account_mapping');
  }

  /** Read-modify-write only: the addon's Transaction Rules card owns this
   *  list, and a whole-object write from a stale snapshot would drop rules the
   *  user wrote by hand. */
  async setMappingRules(rules: MappingRule[]): Promise<void> {
    await this.setJson('mapping_rules', rules);
  }

  async getMappingRules(): Promise<MappingRule[]> {
    return (await this.getJson<MappingRule[]>('mapping_rules')) ?? [];
  }

  async getBalanceInitialized(): Promise<string[]> {
    return (await this.getJson<string[]>('balance_initialized')) ?? [];
  }

  async addBalanceInitialized(sfinAccountId: string): Promise<void> {
    const list = await this.getBalanceInitialized();
    if (!list.includes(sfinAccountId)) {
      list.push(sfinAccountId);
      await this.setJson('balance_initialized', list);
    }
  }

  async getLastSyncAt(): Promise<Date | null> {
    const raw = await this.client.getAddonSecret(this.addonId, 'last_sync_at');
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  async setLastSyncAt(date: Date): Promise<void> {
    await this.client.setAddonSecret(this.addonId, 'last_sync_at', date.toISOString());
  }

  async getLinkedGroups(): Promise<Record<string, string>> {
    return (await this.getJson<Record<string, string>>('linked_groups')) ?? {};
  }

  async setLinkedGroups(map: Record<string, string>): Promise<void> {
    await this.setJson('linked_groups', map);
  }

  async getTransferLinkFailures(): Promise<Record<string, TransferLinkFailureEntry>> {
    return (await this.getJson<Record<string, TransferLinkFailureEntry>>('transfer_link_failures')) ?? {};
  }

  async setTransferLinkFailures(map: Record<string, TransferLinkFailureEntry>): Promise<void> {
    await this.setJson('transfer_link_failures', map);
  }

  /** Reported verbatim from `telegram_config`, defaults included nowhere here —
   *  `runSyncCore` owns what an absent value means (see `SyncStore`). A
   *  non-numeric stored value is treated as absent. */
  async getLargeTransactionThreshold(): Promise<number | null> {
    const tg = await this.getJson<TelegramConfig>('telegram_config');
    const raw = tg?.largeTransactionThreshold;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  }

  /** As `getLargeTransactionThreshold`: verbatim, no defaults applied here. */
  async getDriftAlertThreshold(): Promise<number | null> {
    const tg = await this.getJson<TelegramConfig>('telegram_config');
    const raw = tg?.driftAlertThreshold;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  }

  async getDriftAlerts(): Promise<Record<string, DriftAlertEntry>> {
    return (await this.getJson<Record<string, DriftAlertEntry>>('drift_alerts')) ?? {};
  }

  async setDriftAlerts(map: Record<string, DriftAlertEntry>): Promise<void> {
    await this.setJson('drift_alerts', map);
  }

  async getAccountBalances(): Promise<Record<string, unknown>> {
    return (await this.getJson<Record<string, unknown>>('account_balances')) ?? {};
  }

  async setAccountBalances(map: Record<string, unknown>): Promise<void> {
    await this.setJson('account_balances', map);
  }

  /** Same secret the addon reads (`unmapped_accounts`) — the companion is
   *  normally the side that DISCOVERS a newly-linked account, and the addon UI
   *  is the only side that can offer to map it. */
  async setUnmappedAccounts(list: UnmappedAccount[]): Promise<void> {
    await this.setJson('unmapped_accounts', list);
  }

  /** Read-only here: the companion never sets this, it only honours what the
   *  addon's UI recorded (see `SyncStore.getIgnoredAccounts`). */
  async getIgnoredAccounts(): Promise<string[]> {
    const list = await this.getJson<unknown>('ignored_accounts');
    return Array.isArray(list) ? (list as string[]) : [];
  }

  /** The learned transfer names this companion publishes (shared/transfer-names.ts); null when absent or unreadable. */
  async getTransferNames(): Promise<TransferNames | null> {
    return parseTransferNames(await this.client.getAddonSecret(this.addonId, TRANSFER_NAMES_SECRET_KEY));
  }

  /** The request record both writers share; a failed read rejects (fail closed). */
  async getSimplefinRequests(): Promise<string | null> {
    return (await this.client.getAddonSecret(this.addonId, SIMPLEFIN_REQUESTS_SECRET_KEY)) ?? null;
  }
  async setSimplefinRequests(raw: string): Promise<void> {
    await this.client.setAddonSecret(this.addonId, SIMPLEFIN_REQUESTS_SECRET_KEY, raw);
  }

  /** Read-only, like the ignored accounts: the list is written by the addon or a
   *  companion tool, and honoured here (see shared/skipped-transactions.ts). */
  async getSkippedTransactions(): Promise<SkippedTransaction[]> {
    return parseSkippedTransactions(await this.client.getAddonSecret(this.addonId, SKIPPED_TRANSACTIONS_SECRET_KEY));
  }

  /** The add-on's ignore rules (shared/ignore-rules.ts). Without this a
   *  companion sync would import every row the add-on's sync leaves out. */
  async getLoanLinks(): Promise<LoanLinks> {
    return parseLoanLinks(await this.client.getAddonSecret(this.addonId, LOAN_LINKS_SECRET_KEY));
  }

  async getIgnoreRules(): Promise<IgnoreRule[]> {
    return parseIgnoreRules(await this.client.getAddonSecret(this.addonId, IGNORE_RULES_SECRET_KEY));
  }

  /** The same document the add-on reads (shared/sync-overrides.ts); corrupt,
   *  absent and a failed read are empty, so the sync behaves as it always did,
   *  and a corrupt or unread document gets one log line saying so. */
  async getSyncOverrides(): Promise<SyncOverrides> {
    return syncOverridesOrEmpty((k) => this.client.getAddonSecret(this.addonId, k), (why) => console.warn(syncOverridesIgnoredLog(why)));
  }

  /** The same document with its read state (null on a failed read), so the sync
   *  can tell an unreadable document from an empty one. */
  async readSyncOverrides(): Promise<LoadedSyncOverrides | null> {
    try {
      return await loadSyncOverrides((k) => this.client.getAddonSecret(this.addonId, k));
    } catch {
      return null;
    }
  }

  async getAmazonLedger(): Promise<AmazonLedger> {
    return (await this.getJson<AmazonLedger>(AMAZON_LEDGER_SECRET_KEY)) ?? {};
  }

  async setAmazonLedger(map: AmazonLedger): Promise<void> {
    await this.setJson(AMAZON_LEDGER_SECRET_KEY, map);
  }

  /** Venmo payments (3): the mail poll merges into it, both syncers consume. */
  async getVenmoLedger(): Promise<VenmoLedger> {
    // Absent reads as empty; a document that is present but unreadable THROWS, so
    // a sync turns Venmo off and nothing ever overwrites it.
    const raw = await this.client.getAddonSecret(this.addonId, VENMO_LEDGER_SECRET_KEY);
    if (!raw) return {};
    const ledger = JSON.parse(raw);
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) throw new Error('the Venmo payments list is not an object');
    return ledger as VenmoLedger;
  }

  async setVenmoLedger(map: VenmoLedger): Promise<void> {
    await this.setJson(VENMO_LEDGER_SECRET_KEY, map);
  }

  /** Every Amazon label ever received, and the category it resolved to. Read by
   *  the addon card so it can show the user their REAL label set. */
  async getLastSyncImported(): Promise<number | null> {
    const n = await this.getJson<number>('last_sync_imported');
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  }

  async setLastSyncImported(count: number): Promise<void> {
    await this.setJson('last_sync_imported', count);
  }

  async getAmazonLabels(): Promise<AmazonLabelCatalog> {
    return (await this.getJson<AmazonLabelCatalog>(AMAZON_LABELS_SECRET_KEY)) ?? {};
  }

  async setAmazonLabels(map: AmazonLabelCatalog): Promise<void> {
    await this.setJson(AMAZON_LABELS_SECRET_KEY, map);
  }

  /** Mailbox credentials and label overrides, written by the addon card. */
  async getAmazonConfig(): Promise<AmazonMailConfig | null> {
    return (await this.getJson<AmazonMailConfig>(AMAZON_CONFIG_SECRET_KEY)) ?? null;
  }

  async getAutoHeal(): Promise<boolean> {
    return (await this.getJson<boolean>('auto_heal')) ?? false;
  }

  async getAutoAdjust(): Promise<boolean> {
    return (await this.getJson<boolean>('auto_adjust')) ?? false;
  }
}
