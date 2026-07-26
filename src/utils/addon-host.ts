import { fetchAccounts } from './simplefin';
import type {
  ActivityWrite,
  HostActivity,
  ImportRow,
  LinkLeg,
  LinkResult,
  SaveManyRequest,
  SaveManyResult,
  SyncHost,
} from '../../shared/sync-host';
import type { ActivityType, SimplefinAccountSet } from '../../shared/types';
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
  } as ActivityCreate & { id?: string };
}

/** Normalize an Activity echoed back by saveMany. The host names the comment
 *  field `notes` on the echo, and it is the only channel that reports the
 *  persisted `sourceGroupId` (ActivityDetails from search omits it). */
function fromSdkEcho(a: any): HostActivity {
  return {
    id: String(a?.id ?? ''),
    accountId: String(a?.accountId ?? ''),
    activityType: String(a?.activityType ?? ''),
    date: toIsoDate(a?.date ?? a?.activityDate),
    amount: a?.amount ?? null,
    comment: a?.notes ?? a?.comment ?? null,
    assetId: a?.assetId ? String(a.assetId) : undefined,
    sourceGroupId: a?.sourceGroupId ?? null,
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
    return (res.data ?? []).map((a: any) => ({
      id: String(a.id ?? ''),
      accountId: String(a.accountId ?? wfAccountId),
      activityType: String(a.activityType ?? ''),
      date: toIsoDate(a.date),
      amount: a.amount ?? null,
      comment: a.comment ?? null,
      assetId: a.assetId ? String(a.assetId) : undefined,
      sourceGroupId: a.sourceGroupId ?? null,
    }));
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
    // Every row this addon imports is SimpleFin-sourced; stamping it here keeps
    // the core host-agnostic while preserving the field the SDK path always sent.
    const activities = rows.map((r) => ({ ...r, sourceSystem: 'simplefin' as const }));
    await this.ctx.api.activities.import(activities as any);
  }

  async linkPair(_legs: [LinkLeg, LinkLeg]): Promise<LinkResult> {
    // The addon links transfers through the atomic saveMany flush inside the
    // core; a dedicated link endpoint arrives with Task 4.
    throw new Error('not implemented');
  }
}
