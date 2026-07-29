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

export interface TransferLinkFailureEntry {
  count: number;
  firstFailedAt: string;
  alerted: boolean;
}

/** One account's open balance-drift episode. Present means "currently drifting
 *  beyond the alert threshold"; the entry is DELETED once a trustworthy
 *  measurement comes back under it, which is what re-arms the alert for a
 *  recurrence. Shaped like `TransferLinkFailureEntry` on purpose: same
 *  `alerted`-only-once-delivered discipline, same rollback story. */
export interface DriftAlertEntry {
  /** The signed drift (bank − Wealthfolio, dollars) when the episode opened. */
  driftAmount: number;
  firstDetectedAt: string;
  alerted: boolean;
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
  /** Which syncer wrote the row. Carried on the row rather than stamped inside
   *  each host, so no adapter can silently drop it — Wealthfolio surfaces it,
   *  and both the addon and the companion have always sent 'simplefin'. */
  sourceSystem: 'simplefin';
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
  /** The account's most recent activities, newest first. Bounded by the host's
   *  page size, so it is NOT a way to reach an old row on a busy account. */
  listActivities(wfAccountId: string): Promise<HostActivity[]>;
  /**
   * The account's `limit` OLDEST activities, date ascending.
   *
   * Deliberately a separate method rather than an option on `listActivities`:
   * an optional argument is structurally invisible, so an adapter could ignore
   * it, still satisfy this interface, and silently hand back a recent-first
   * page. The starting-balance marker is by construction the oldest row on the
   * account, so reading it through the recent-first window would miss it once
   * the account outgrows one page — and a missed marker means a DUPLICATE
   * baseline, which is exactly what its guard exists to prevent.
   */
  listOldestActivities(wfAccountId: string, limit: number): Promise<HostActivity[]>;
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
  /** Per-pair (keyed by the OUT leg's txId) record of consecutive linkPair
   *  failures, so a persistently-rejected transfer group — not ordinary
   *  in-transit lag — can trigger a one-time alert. */
  getTransferLinkFailures(): Promise<Record<string, TransferLinkFailureEntry>>;
  setTransferLinkFailures(map: Record<string, TransferLinkFailureEntry>): Promise<void>;
  /**
   * Dollar amount a single newly-imported spending transaction must exceed to
   * be reported on `SyncResult.largeTransactionAlerts`, or `null` when the user
   * has never configured one.
   *
   * `null` and `0` both mean off here, but they are deliberately kept distinct
   * rather than collapsed in the adapters: the sibling drift threshold DOES
   * distinguish them (absent means "use the default", explicit `0` means off),
   * and an adapter that quietly turned one into the other would make the two
   * settings behave differently for the same stored value. Adapters report what
   * is stored; `runSyncCore` owns every default.
   */
  getLargeTransactionThreshold(): Promise<number | null>;
  /**
   * Dollar drift an account must exceed to be reported on
   * `SyncResult.balanceDriftAlerts`, or `null` when the user has never set one —
   * which `runSyncCore` turns into its $100 default. An explicit `0` or negative
   * means off, so the two must NOT be collapsed here.
   */
  getDriftAlertThreshold(): Promise<number | null>;
  /** Per-account (keyed by SimpleFin account id) record of the drift episode the
   *  user has already been told about, so a persistently-off account is announced
   *  once rather than every sync. An entry disappears when the account comes back
   *  under the threshold, re-arming the alert. */
  getDriftAlerts(): Promise<Record<string, DriftAlertEntry>>;
  setDriftAlerts(map: Record<string, DriftAlertEntry>): Promise<void>;
  getAccountBalances(): Promise<Record<string, unknown>>;
  setAccountBalances(map: Record<string, unknown>): Promise<void>;
  getAutoHeal(): Promise<boolean>;
  getAutoAdjust(): Promise<boolean>;
}
