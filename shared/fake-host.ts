import type { AccountMapping, MappingRule, SimplefinAccountSet } from './types.js';
import type { AmazonLedger } from './amazon-ledger.js';
import type {
  ActivityWrite,
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
} from './sync-host.js';

export interface FakeHostSeed {
  /** Stored SimpleFin access URL. Defaults to a configured-looking placeholder
   *  so a seeded run reaches the import path; pass `null` to exercise the
   *  "not configured" branch. `fetchSimplefin` ignores it and returns
   *  `accountSet`. */
  accessUrl?: string | null;
  accountSet?: SimplefinAccountSet;
  mapping?: AccountMapping;
  accountTypes?: Record<string, string>;
  /** Wealthfolio account display names, keyed by Wealthfolio account id. Absent
   *  entries make `listAccounts` report no name, which is what a host that
   *  cannot supply one looks like. */
  accountNames?: Record<string, string>;
  mappingRules?: MappingRule[];
  valuations?: Map<string, number>;
  autoHeal?: boolean;
  autoAdjust?: boolean;
  /** Pre-loaded activities, keyed by Wealthfolio account id. */
  existing?: Map<string, HostActivity[]>;
  /** Pre-loaded transfer-link failure ledger, keyed by the failing pair's
   *  OUT-leg txId. */
  transferLinkFailures?: Record<string, TransferLinkFailureEntry>;
  /** Configured large-transaction alert threshold in dollars. Absent (the
   *  default) is reported as `null` — "never configured", i.e. off. */
  largeTransactionThreshold?: number;
  /** Configured drift-alert threshold in dollars. Absent is reported as `null`,
   *  which runSyncCore turns into its $100 default. */
  driftAlertThreshold?: number;
  /** Pre-loaded drift-alert ledger, keyed by SimpleFin account id. */
  driftAlerts?: Record<string, DriftAlertEntry>;
  /** Amazon orders awaiting their charge. Empty means Amazon categorization is
   *  off, which is what every test that doesn't care about it wants. */
  amazonLedger?: AmazonLedger;
  /**
   * Called before every `saveMany`, so a test can make it THROW.
   *
   * Needed because the two hosts fail differently and the difference mattered: the
   * companion's REST adapter returns `{errors}`, while the addon's SDK adapter lets
   * `ctx.api.activities.saveMany` throw. Code that only handled the returned-errors
   * shape silently lost a whole account's batch on the SDK path.
   */
  saveManyHook?: (req: SaveManyRequest, callIndex: number) => void;
}

export interface FakeHost {
  host: SyncHost;
  store: SyncStore;
  /** Live activities per Wealthfolio account id. Mutated by saveMany/linkPair. */
  activities: Map<string, HostActivity[]>;
  /** Every saveMany request, in call order. */
  saved: SaveManyRequest[];
  /** Every linkPair call, in call order. */
  links: Array<[LinkLeg, LinkLeg]>;
  /** Every importActivities call, in call order. */
  imported: ImportRow[][];
  /** The Amazon ledger as the run left it, for asserting what got consumed. */
  amazon: () => AmazonLedger;
}

/** Rows a single `listActivities` page returns — mirrors the addon adapter's
 *  500-row search window so tests feel the same truncation the real host has. */
export const HOST_PAGE_LIMIT = 500;

/** Copy sorted by date; ties keep insertion order (Array#sort is stable). */
function byDate(rows: HostActivity[], ascending: boolean): HostActivity[] {
  return rows
    .map((r) => ({ ...r }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) * (ascending ? 1 : -1));
}

function cloneActivities(existing?: Map<string, HostActivity[]>): Map<string, HostActivity[]> {
  const map = new Map<string, HostActivity[]>();
  if (!existing) return map;
  for (const [accountId, rows] of existing) {
    map.set(accountId, rows.map((r) => ({ ...r })));
  }
  return map;
}

/**
 * Build an in-memory SyncHost + SyncStore double for core tests.
 *
 * Simplifications vs. the real Wealthfolio host (safe for test purposes, noted
 * so they don't get mistaken for a spec):
 * - `listAccounts` returns entries built from `accountTypes`/`mapping` rather than
 *   a real account table; a test must seed `accountTypes` for anything beyond the
 *   'CASH' default.
 * - ids are simple incrementing strings (`fh-1`, `fh-2`, ...), not UUIDs.
 * - `saveMany` does not validate activity shape beyond what's needed to store and
 *   echo it back (no currency/enum validation) — it will not catch a malformed
 *   write the way the real API might reject one.
 */
export function createFakeHost(seed: FakeHostSeed = {}): FakeHost {
  const accessUrl = seed.accessUrl === undefined
    ? 'https://bridge.simplefin.org/simplefin'
    : seed.accessUrl;
  const accountSet: SimplefinAccountSet = seed.accountSet ?? { errors: [], accounts: [] };
  const mapping: AccountMapping = seed.mapping ?? {};
  const accountTypes: Record<string, string> = seed.accountTypes ?? {};
  const accountNames: Record<string, string> = seed.accountNames ?? {};
  const mappingRules: MappingRule[] = seed.mappingRules ?? [];
  const valuations: Map<string, number> = seed.valuations ?? new Map();
  const autoHeal = seed.autoHeal ?? false;
  const autoAdjust = seed.autoAdjust ?? false;
  const largeTransactionThreshold = seed.largeTransactionThreshold ?? null;
  const driftAlertThreshold = seed.driftAlertThreshold ?? null;

  const activities = cloneActivities(seed.existing);
  const saved: SaveManyRequest[] = [];
  const links: Array<[LinkLeg, LinkLeg]> = [];
  const imported: ImportRow[][] = [];

  let nextId = 1;
  let nextGroupId = 1;
  const freshId = () => `fh-${nextId++}`;

  function rowsFor(accountId: string): HostActivity[] {
    let rows = activities.get(accountId);
    if (!rows) {
      rows = [];
      activities.set(accountId, rows);
    }
    return rows;
  }

  function toHostActivity(id: string, w: ActivityWrite): HostActivity {
    return {
      id,
      accountId: w.accountId,
      activityType: w.activityType,
      date: w.activityDate,
      amount: w.amount ?? null,
      comment: w.comment ?? null,
      assetId: w.symbol?.symbol,
      sourceGroupId: w.sourceGroupId ?? null,
      // Matches both real adapters: an absent subtype reads back as `null`,
      // never dropped. Dropping it here used to mask the second churn path in
      // `changed()` — a subtype written on create would vanish on the next
      // sync's read-back, making a stable row look unruled and re-trigger the
      // exact same "backfill" update forever, which is invisible unless a test
      // reads a row back through this function rather than a hand-seeded one.
      subtype: w.subtype ?? null,
    };
  }

  /** Echo a row the way the real Wealthfolio API does: `comment` mirrored under `notes`. */
  function withNotes(row: HostActivity): HostActivity & { notes: string | null } {
    return { ...row, notes: row.comment };
  }

  // Track which account id an activity id lives under, so updates/deletes
  // by id don't require a linear scan of every account's rows.
  const accountOfId = new Map<string, string>();
  for (const [accountId, rows] of activities) {
    for (const row of rows) accountOfId.set(row.id, accountId);
  }

  let linkedGroups: Record<string, string> = {};
  let transferLinkFailures: Record<string, TransferLinkFailureEntry> =
    seed.transferLinkFailures ?? {};
  let driftAlerts: Record<string, DriftAlertEntry> = seed.driftAlerts ?? {};
  let amazonLedger: AmazonLedger = seed.amazonLedger ?? {};
  let accountBalances: Record<string, unknown> = {};
  let balanceInitialized: string[] = [];
  let lastSyncAt: Date | null = null;
  let lastSyncImported: number | null = null;

  const host: SyncHost = {
    async fetchSimplefin() {
      return accountSet;
    },

    async listAccounts() {
      const ids = new Set<string>([...Object.values(mapping), ...Object.keys(accountTypes)]);
      return Array.from(ids).map((id) => ({
        id,
        accountType: accountTypes[id] ?? 'CASH',
        // Key absent rather than `undefined` when unseeded, so an unnamed
        // account looks exactly like one the real host reports no name for.
        ...(accountNames[id] !== undefined ? { name: accountNames[id] } : {}),
      }));
    },

    async latestValuations(accountIds: string[]) {
      const out = new Map<string, number>();
      for (const id of accountIds) {
        if (valuations.has(id)) out.set(id, valuations.get(id)!);
      }
      return out;
    },

    async listActivities(wfAccountId: string) {
      // Bounded, most-recent-first — the same window the real hosts read. An
      // account with more rows than this loses its OLDEST ones off the page,
      // which is exactly why the starting-balance marker needs the ascending
      // read below rather than this one.
      return byDate(rowsFor(wfAccountId), false).slice(0, HOST_PAGE_LIMIT);
    },

    async listOldestActivities(wfAccountId: string, limit: number) {
      return byDate(rowsFor(wfAccountId), true).slice(0, limit);
    },

    async saveMany(req: SaveManyRequest): Promise<SaveManyResult> {
      saved.push(req);
      seed.saveManyHook?.(req, saved.length - 1);
      const created: HostActivity[] = [];
      const updated: HostActivity[] = [];

      for (const w of req.creates ?? []) {
        const id = freshId();
        const row = toHostActivity(id, w);
        rowsFor(w.accountId).push(row);
        accountOfId.set(id, w.accountId);
        created.push(withNotes(row));
      }

      for (const w of req.updates ?? []) {
        if (!w.id) continue;
        const accountId = accountOfId.get(w.id) ?? w.accountId;
        const rows = rowsFor(accountId);
        const idx = rows.findIndex((r) => r.id === w.id);
        const row = toHostActivity(w.id, w);
        if (idx >= 0) {
          rows[idx] = row;
        } else {
          rows.push(row);
          accountOfId.set(w.id, accountId);
        }
        updated.push(withNotes(row));
      }

      for (const id of req.deleteIds ?? []) {
        const accountId = accountOfId.get(id);
        if (!accountId) continue;
        const rows = rowsFor(accountId);
        const idx = rows.findIndex((r) => r.id === id);
        if (idx >= 0) rows.splice(idx, 1);
        accountOfId.delete(id);
      }

      return { created, updated, errors: [] };
    },

    async importActivities(rows: ImportRow[]) {
      imported.push(rows);
      for (const row of rows) {
        const id = freshId();
        const hostRow: HostActivity = {
          id,
          accountId: row.accountId,
          activityType: row.activityType,
          date: row.date,
          amount: row.amount,
          comment: row.comment,
          assetId: row.symbol || undefined,
          sourceGroupId: null,
        };
        rowsFor(row.accountId).push(hostRow);
        accountOfId.set(id, row.accountId);
      }
    },

    async linkPair(legs: [LinkLeg, LinkLeg]): Promise<LinkResult> {
      links.push(legs);
      const groupId = `wf-transfer-${nextGroupId++}`;
      for (const leg of legs) {
        const rows = rowsFor(leg.accountId);
        const row = rows.find((r) => r.id === leg.wfId);
        if (row) row.sourceGroupId = groupId;
      }
      return { linked: true, groupId };
    },

    capabilities: {
      readsSourceGroupId: true,
    },
  };

  const store: SyncStore = {
    async getAccessUrl() {
      return accessUrl;
    },
    async getAuthB64Key() {
      return null;
    },
    async getAccountMapping() {
      return mapping;
    },
    async getMappingRules(): Promise<MappingRule[]> {
      return mappingRules;
    },
    async getBalanceInitialized() {
      return balanceInitialized;
    },
    async addBalanceInitialized(sfinAccountId: string) {
      if (!balanceInitialized.includes(sfinAccountId)) {
        balanceInitialized = [...balanceInitialized, sfinAccountId];
      }
    },
    async getLastSyncAt() {
      return lastSyncAt;
    },
    async setLastSyncAt(date: Date) {
      lastSyncAt = date;
    },
    async getLinkedGroups() {
      return linkedGroups;
    },
    async setLinkedGroups(map: Record<string, string>) {
      linkedGroups = map;
    },
    async getTransferLinkFailures() {
      return transferLinkFailures;
    },
    async setTransferLinkFailures(map: Record<string, TransferLinkFailureEntry>) {
      transferLinkFailures = map;
    },
    async getLargeTransactionThreshold() {
      return largeTransactionThreshold;
    },
    async getDriftAlertThreshold() {
      return driftAlertThreshold;
    },
    async getDriftAlerts() {
      return driftAlerts;
    },
    async setDriftAlerts(map: Record<string, DriftAlertEntry>) {
      driftAlerts = map;
    },
    async getAccountBalances() {
      return accountBalances;
    },
    async setAccountBalances(map: Record<string, unknown>) {
      accountBalances = map;
    },
    async getLastSyncImported() {
      return lastSyncImported;
    },
    async setLastSyncImported(count: number) {
      lastSyncImported = count;
    },
    async getAmazonLedger() {
      return amazonLedger;
    },
    async setAmazonLedger(map: AmazonLedger) {
      amazonLedger = map;
    },
    async getAutoHeal() {
      return autoHeal;
    },
    async getAutoAdjust() {
      return autoAdjust;
    },
  };

  return { host, store, activities, saved, links, imported, amazon: () => amazonLedger };
}
