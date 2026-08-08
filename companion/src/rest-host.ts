import { fetchAccountsNode } from './simplefin.js';
import { AMAZON_LEDGER_SECRET_KEY } from '../../shared/amazon-ledger.js';
import { AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY } from './amazon-mail.js';
import type { AmazonLabelCatalog, AmazonMailConfig } from './amazon-mail.js';
import type { AmazonLedger } from '../../shared/amazon-ledger.js';
import { linkPairByRecreate } from '../../shared/link-pair.js';
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
import type { AccountMapping, MappingRule, SimplefinAccountSet, TelegramConfig } from '../../shared/types.js';

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
    comment: a.comment ?? a.notes ?? a.description ?? null,
    assetId: a.assetId ? String(a.assetId) : undefined,
    sourceGroupId: a.sourceGroupId ?? null,
  };
}

/** Page size for the `listOldestActivities` sweep, and the number of pages it
 *  will pull before giving up. 20 × 500 = 10,000 activities on one account —
 *  far beyond a personal-finance dataset, but a finite bound so a server that
 *  never returns a short page cannot spin forever. */
const OLDEST_SWEEP_PAGE_SIZE = 500;
const OLDEST_SWEEP_MAX_PAGES = 20;

export class RestSyncHost implements SyncHost {
  constructor(private client: WealthfolioClient) {}

  readonly capabilities = { readsSourceGroupId: true };

  async fetchSimplefin(
    accessUrl: string,
    since: Date,
    _authKey?: string | null,
  ): Promise<SimplefinAccountSet> {
    return fetchAccountsNode(accessUrl, since);
  }

  async listAccounts(): Promise<Array<{ id: string; accountType: string; name?: string }>> {
    const accounts = await this.client.getAccounts();
    return accounts.map((a: any) => ({
      id: a.id,
      accountType: String(a.accountType ?? ''),
      name: a.name,
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

  async linkPair(legs: [LinkLeg, LinkLeg]): Promise<LinkResult> {
    return linkPairByRecreate((req) => this.saveMany(req), legs);
  }
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

  async getAmazonLedger(): Promise<AmazonLedger> {
    return (await this.getJson<AmazonLedger>(AMAZON_LEDGER_SECRET_KEY)) ?? {};
  }

  async setAmazonLedger(map: AmazonLedger): Promise<void> {
    await this.setJson(AMAZON_LEDGER_SECRET_KEY, map);
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
