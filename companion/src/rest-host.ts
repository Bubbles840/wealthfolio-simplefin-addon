import { fetchAccountsNode } from './simplefin.js';
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
} from '../../shared/sync-host.js';
import type { AccountMapping, MappingRule, SimplefinAccountSet } from '../../shared/types.js';

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

  async listActivities(wfAccountId: string): Promise<HostActivity[]> {
    const items = await this.client.searchActivities({
      page: 1,
      pageSize: 500,
      accountIdFilter: [wfAccountId],
    });
    return items.map((a) => fromSearchItem(a, wfAccountId));
  }

  async listOldestActivities(wfAccountId: string, limit: number): Promise<HostActivity[]> {
    const items = await this.client.searchActivities({
      page: 1,
      pageSize: limit,
      accountIdFilter: [wfAccountId],
    });
    return items.map((a) => fromSearchItem(a, wfAccountId));
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
    try {
      await this.client.linkTransferActivities(legs[0].wfId, legs[1].wfId);
      const items = await this.client.searchActivities({
        page: 1,
        pageSize: 10,
        accountIdFilter: [legs[0].accountId],
      });
      const match = items.find((i) => i.id === legs[0].wfId);
      if (match && match.sourceGroupId) {
        return { linked: true, groupId: match.sourceGroupId };
      }
      return { linked: true, groupId: `linked-${legs[0].wfId}` };
    } catch {
      return { linked: false };
    }
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

  async getAccountBalances(): Promise<Record<string, unknown>> {
    return (await this.getJson<Record<string, unknown>>('account_balances')) ?? {};
  }

  async setAccountBalances(map: Record<string, unknown>): Promise<void> {
    await this.setJson('account_balances', map);
  }

  async getAutoHeal(): Promise<boolean> {
    return (await this.getJson<boolean>('auto_heal')) ?? false;
  }

  async getAutoAdjust(): Promise<boolean> {
    return (await this.getJson<boolean>('auto_adjust')) ?? false;
  }
}
