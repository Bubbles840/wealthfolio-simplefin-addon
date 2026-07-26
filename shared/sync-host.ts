import type { AccountMapping, MappingRule, SimplefinAccountSet } from './types.js';

/** A Wealthfolio activity row, normalized across the SDK and REST shapes. */
export interface HostActivity {
  id: string;
  accountId: string;
  activityType: string;
  date: string;          // YYYY-MM-DD
  amount: string | number | null;
  comment: string | null;
  assetId?: string;
  sourceGroupId?: string | null;
}

export interface ActivityWrite {
  id?: string;
  accountId: string;
  activityType: string;
  activityDate: string;
  symbol?: { symbol: string };
  amount?: number;
  fee?: number;
  currency: string;
  comment: string;
  metadata?: string;
  sourceGroupId?: string;
}

export interface SaveManyRequest {
  creates?: ActivityWrite[];
  updates?: ActivityWrite[];
  deleteIds?: string[];
}

export interface SaveManyResult {
  created: HostActivity[];
  updated: HostActivity[];
  errors: Array<{ action: string; message: string }>;
}

/** One side of a transfer pair, with everything a host needs to re-create it. */
export interface LinkLeg {
  wfId: string;
  accountId: string;
  txId: string;
  activityType: string;
  date: string;
  absCents: number;
  currency: string;
  comment: string;
}

export interface LinkResult {
  linked: boolean;
  groupId?: string;
}

/** A row for the relaxed import endpoint (starting balances, plugs). */
export interface ImportRow {
  accountId: string;
  activityType: string;
  date: string;
  symbol: string;
  amount: number;
  fee?: number;
  currency: string;
  comment: string;
  isValid: true;
  isDraft: false;
}

export interface SyncHost {
  fetchSimplefin(accessUrl: string, since: Date, authKey?: string | null): Promise<SimplefinAccountSet>;
  listAccounts(): Promise<Array<{ id: string; accountType: string; name?: string }>>;
  latestValuations(accountIds: string[]): Promise<Map<string, number>>;
  listActivities(wfAccountId: string): Promise<HostActivity[]>;
  saveMany(req: SaveManyRequest): Promise<SaveManyResult>;
  importActivities(rows: ImportRow[]): Promise<void>;
  /** Record that two activities are one internal transfer. */
  linkPair(legs: [LinkLeg, LinkLeg]): Promise<LinkResult>;
  readonly capabilities: {
    /** True when listActivities returns a trustworthy sourceGroupId. */
    readsSourceGroupId: boolean;
  };
}

/** Config and shared state. The addon's SecretsStore already satisfies this. */
export interface SyncStore {
  getAccessUrl(): Promise<string | null>;
  getAuthB64Key(): Promise<string | null>;
  getAccountMapping(): Promise<AccountMapping | null>;
  getMappingRules(): Promise<MappingRule[]>;
  getBalanceInitialized(): Promise<string[]>;
  addBalanceInitialized(sfinAccountId: string): Promise<void>;
  getLastSyncAt(): Promise<Date | null>;
  setLastSyncAt(date: Date): Promise<void>;
  getLinkedGroups(): Promise<Record<string, string>>;
  setLinkedGroups(map: Record<string, string>): Promise<void>;
  getAccountBalances(): Promise<Record<string, unknown>>;
  setAccountBalances(map: Record<string, unknown>): Promise<void>;
  getAutoHeal(): Promise<boolean>;
  getAutoAdjust(): Promise<boolean>;
}
