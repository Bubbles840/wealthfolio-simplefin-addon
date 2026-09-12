import { fetchAccounts } from './simplefin';
import { linkPairByRecreate } from '../../shared/link-pair';
import type {
  ActivityWrite,
  HostActivity,
  ImportRow,
  LinkLeg,
  LinkResult,
  SaveManyRequest,
  SaveManyResult,
  SyncHost,
  HoldingsSyncOutcome,
} from '../../shared/sync-host';
import type { ActivityType, SimplefinAccountSet } from '../../shared/types';
import type { HoldingsSnapshot } from '../../shared/holdings';
import type { AddonContext, ActivityCreate, ActivityUpdate } from '@wealthfolio/addon-sdk';

/**
 * Normalize a host date to YYYY-MM-DD.
 *
 * The happy path is exactly `new Date(value).toISOString().slice(0, 10)` — the
 * normalization the reconciliation planner depends on. An unparseable value is
 * passed through verbatim instead of throwing, so callers that only read a row's
 * comment (the starting-balance and balance-adjustment guards) still see
 * malformed rows, while `fetchExistingRows` still fails on them exactly as it
 * did when it called `new Date(a.date).toISOString()` itself.
 */
function toIsoDate(value: unknown): string {
  if (value === null || value === undefined) return '';
  const d = new Date(value as string | number | Date);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 10);
}

/** Map an ActivityWrite to the SDK's create/update shape, preserving "key
 *  absent" (rather than `undefined`) for every optional field — a transfer leg
 *  must carry NO `symbol` key at all, and import writes carry no metadata or
 *  sourceGroupId. */
function toSdkWrite(w: ActivityWrite): ActivityCreate & { id?: string } {
  return {
    ...(w.id !== undefined ? { id: w.id } : {}),
    accountId: w.accountId,
    activityType: w.activityType as ActivityType,
    activityDate: w.activityDate,
    ...(w.symbol !== undefined ? { symbol: w.symbol } : {}),
    ...(w.amount !== undefined ? { amount: w.amount } : {}),
    ...(w.fee !== undefined ? { fee: w.fee } : {}),
    currency: w.currency,
    comment: w.comment,
    ...(w.metadata !== undefined ? { metadata: w.metadata } : {}),
    ...(w.sourceGroupId !== undefined ? { sourceGroupId: w.sourceGroupId } : {}),
    ...(w.subtype !== undefined ? { subtype: w.subtype } : {}),
    ...(w.needsReview !== undefined ? { needsReview: w.needsReview } : {}),
  } as ActivityCreate & { id?: string };
}

/** Normalize an ActivityDetails row returned by `activities.search`. Shared by
 *  both reads so the recent-first and oldest-first windows can never drift. */
function fromSearchRow(a: any, wfAccountId: string): HostActivity {
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
  };
}

/** Normalize an Activity echoed back by saveMany. The host names the comment
 *  field `notes` on the echo, and it is the only channel that reports the
 *  persisted `sourceGroupId` (ActivityDetails from search omits it). Also the
 *  only channel that confirms a just-written `subtype` actually persisted -
 *  worth copying here too so a caller inspecting a saveMany result sees the
 *  same truth `listActivities` would. */
function fromSdkEcho(a: any): HostActivity {
  return {
    id: String(a?.id ?? ''),
    accountId: String(a?.accountId ?? ''),
    activityType: String(a?.activityType ?? ''),
    date: toIsoDate(a?.date ?? a?.activityDate),
    amount: a?.amount ?? null,
    fee: a?.fee ?? null,
    comment: a?.notes ?? a?.comment ?? null,
    assetId: a?.assetId ? String(a.assetId) : undefined,
    sourceGroupId: a?.sourceGroupId ?? null,
    subtype: a?.subtype ?? null,
  };
}

/**
 * `SyncHost` backed by the Wealthfolio addon SDK — the in-app half of the shared
 * sync core. The Docker companion implements the same interface over REST.
 */
export class AddonSyncHost implements SyncHost {
  constructor(private ctx: AddonContext) {}

  /** ActivityDetails (what `activities.search` returns) has no sourceGroupId,
   *  so links can only be read back from a saveMany echo. */
  readonly capabilities = { readsSourceGroupId: false };

  async fetchSimplefin(
    accessUrl: string,
    since: Date,
    authKey?: string | null,
  ): Promise<SimplefinAccountSet> {
    return fetchAccounts(accessUrl, since, this.ctx.api.network, authKey ?? undefined);
  }

  async listAccounts(): Promise<Array<{ id: string; accountType: string; name?: string }>> {
    const accounts = await this.ctx.api.accounts.getAll();
    return accounts.map((a) => ({
      id: a.id,
      accountType: String(a.accountType ?? ''),
      name: a.name,
    }));
  }

  async latestValuations(accountIds: string[]): Promise<Map<string, number>> {
    const valuations = await this.ctx.api.portfolio.getLatestValuations(accountIds);
    return new Map(valuations.map((v): [string, number] => [v.accountId, v.totalValue ?? 0]));
  }

  async listActivities(wfAccountId: string): Promise<HostActivity[]> {
    const res = await this.ctx.api.activities.search(
      0, 500, { accountIds: [wfAccountId] }, '', { id: 'date', desc: true },
    );
    return (res.data ?? []).map((a: any) => fromSearchRow(a, wfAccountId));
  }

  /** Bounded ascending read for the starting-balance marker — the oldest row on
   *  the account, which the 500-row recent-first page above would miss entirely
   *  once the account has more than 500 activities. */
  async listOldestActivities(wfAccountId: string, limit: number): Promise<HostActivity[]> {
    const res = await this.ctx.api.activities.search(
      0, limit, { accountIds: [wfAccountId] }, '', { id: 'date', desc: false },
    );
    return (res.data ?? []).map((a: any) => fromSearchRow(a, wfAccountId));
  }

  async saveMany(req: SaveManyRequest): Promise<SaveManyResult> {
    const res: any = await this.ctx.api.activities.saveMany({
      ...(req.creates !== undefined ? { creates: req.creates.map(toSdkWrite) as ActivityCreate[] } : {}),
      ...(req.updates !== undefined ? { updates: req.updates.map(toSdkWrite) as ActivityUpdate[] } : {}),
      ...(req.deleteIds !== undefined ? { deleteIds: req.deleteIds } : {}),
    });
    return {
      created: (res?.created ?? []).map(fromSdkEcho),
      updated: (res?.updated ?? []).map(fromSdkEcho),
      errors: (res?.errors ?? []).map((e: any) => ({
        action: String(e?.action ?? ''),
        message: String(e?.message ?? ''),
      })),
    };
  }

  async importActivities(rows: ImportRow[]): Promise<void> {
    // `sourceSystem` rides on ImportRow itself, so the payload carries it
    // without this adapter (or the companion's) having to remember to stamp it.
    await this.ctx.api.activities.import(rows as any);
  }

  /**
   * Writes one account's positions for a date. The companion has no counterpart
   * — the self-hosted REST server exposes no snapshot write route — so this
   * capability exists on the addon half alone (see `SyncHost.syncHoldings`).
   *
   * `checkImport` does double duty: it validates the batch before anything is
   * written, and its `existingDates` is the idempotency signal, which is better
   * than anything this side could persist because it describes what the host
   * actually holds. Dates are normalised on both sides before comparing — the
   * host types them as plain strings without pinning a format, and it returns
   * full ISO instants elsewhere, so a raw equality check would silently never
   * match and re-import the same snapshot on every sync.
   */
  async syncHoldings(wfAccountId: string, snapshot: HoldingsSnapshot): Promise<HoldingsSyncOutcome> {
    const check = await this.ctx.api.snapshots.checkImport(wfAccountId, [snapshot]);
    if (check.validationErrors.length > 0) {
      throw new Error(check.validationErrors.join('; '));
    }
    const unresolvedSymbols = check.symbols.filter((s) => !s.found).map((s) => s.symbol);
    const dayOf = (value: string) => String(value).slice(0, 10);
    if (check.existingDates.some((d) => dayOf(d) === snapshot.date)) {
      return { imported: 0, skipped: 1, unresolvedSymbols };
    }
    const result = await this.ctx.api.snapshots.importSnapshots(wfAccountId, [snapshot]);
    if (result.errors.length > 0) {
      throw new Error(result.errors.join('; '));
    }
    return { imported: result.snapshotsImported, skipped: 0, unresolvedSymbols };
  }

  async linkPair(legs: [LinkLeg, LinkLeg]): Promise<LinkResult> {
    return linkPairByRecreate((req) => this.saveMany(req), legs);
  }
}
