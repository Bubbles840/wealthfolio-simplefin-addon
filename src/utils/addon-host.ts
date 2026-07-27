import { fetchAccounts } from './simplefin';
import {
  INTERNAL_TRANSFER_METADATA,
  newTransferGroupId,
  txIdFromComment,
} from '../../shared/sync-core';
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

/** Normalize an ActivityDetails row returned by `activities.search`. Shared by
 *  both reads so the recent-first and oldest-first windows can never drift. */
function fromSearchRow(a: any, wfAccountId: string): HostActivity {
  return {
    id: String(a.id ?? ''),
    accountId: String(a.accountId ?? wfAccountId),
    activityType: String(a.activityType ?? ''),
    date: toIsoDate(a.date),
    amount: a.amount ?? null,
    comment: a.comment ?? null,
    assetId: a.assetId ? String(a.assetId) : undefined,
    sourceGroupId: a.sourceGroupId ?? null,
  };
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
   * Link two legs as one internal transfer, the only way the addon SDK can:
   * delete both rows and re-create them together under a shared group.
   *
   * Every part of this is load-bearing, and each was established the hard way:
   *  • DELETE, don't update. An existing row's stored asset cannot be cleared by
   *    an update (the server's `asset` field is a plain Option, not the
   *    Option<Option<…>> patch shape its numeric fields use), and Wealthfolio
   *    refuses to move an already-grouped row into a different group. Deleting
   *    first clears both states, so the fresh group always forms — and the
   *    delete goes first so the re-creates can't collide with the originals on
   *    the host's dedup.
   *  • NO `symbol`. A transfer leg carrying any asset resolves to a literal
   *    "$CASH" security, which neither moves the cash balance nor passes
   *    `validate_asset_shape` — so it can never be paired.
   *  • The `metadata` marker AND the `wf-transfer-` prefix. A shared
   *    sourceGroupId alone does NOT classify a pair as internal; a marker is
   *    also required, and metadata must be the JSON *string* (an object 422s).
   *  • ONE saveMany carrying BOTH legs. A per-leg call looks like a lone leg and
   *    Wealthfolio silently drops the half-formed group.
   *
   * The echo is the only channel that reports the persisted `sourceGroupId`
   * (search's ActivityDetails omits it), so the return value is read from there
   * rather than assumed: a save can "succeed" with the group silently dropped.
   */
  async linkPair(legs: [LinkLeg, LinkLeg]): Promise<LinkResult> {
    const groupId = newTransferGroupId();
    const problems: string[] = [];

    const del = await this.saveMany({ deleteIds: legs.map((l) => l.wfId) });
    for (const e of del.errors) problems.push(`delete (${e.action}): ${e.message}`);

    const res = await this.saveMany({
      creates: legs.map((leg) => ({
        accountId: leg.accountId,
        activityType: leg.activityType,
        activityDate: leg.date,
        amount: leg.absCents / 100,
        currency: leg.currency,
        comment: leg.comment,
        metadata: INTERNAL_TRANSFER_METADATA,
        sourceGroupId: groupId,
      })),
    });
    for (const e of res.errors) problems.push(`save (${e.action}): ${e.message}`);
    // Thrown rather than returned as `linked: false`: an errored write says
    // nothing about whether the pair is linkable, and the core must surface the
    // message and retry rather than record anything about this pair.
    if (problems.length > 0) throw new Error(problems.join('; '));

    // Adopt the gid Wealthfolio actually stored — it keeps its own for rows that
    // were already grouped, and reports null when it dropped the group entirely.
    const echoed = new Map<string, string | null | undefined>();
    for (const a of [...res.updated, ...res.created]) {
      const txId = txIdFromComment(a.comment);
      if (txId) echoed.set(txId, a.sourceGroupId);
    }
    const stored = legs.map((l) => echoed.get(l.txId));
    const linked = !!stored[0] && stored[0] === stored[1];
    return linked ? { linked: true, groupId: stored[0]! } : { linked: false };
  }
}
