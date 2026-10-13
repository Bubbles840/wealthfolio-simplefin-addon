import { INTERNAL_TRANSFER_METADATA, isTransferType, newTransferGroupId, txIdFromComment } from './sync-core.js';
import { accountTxKey } from './transfers.js';
import type { LinkLeg, LinkResult, SaveManyRequest, SaveManyResult } from './sync-host.js';

/**
 * Link two legs as one internal transfer by DELETING both rows and re-creating
 * them together under a shared marked group. Shared by both hosts so they
 * cannot drift.
 *
 * Every part of this is load-bearing, and each was established the hard way:
 *  • DELETE, don't update. An existing row's stored asset cannot be cleared by
 *    an update (the server's `asset` field is a plain Option, not the
 *    Option<Option<…>> patch shape its numeric fields use), and Wealthfolio
 *    refuses to move an already-grouped row into a different group. Deleting
 *    first clears both states, so the fresh group always forms — and the
 *    delete goes first so the re-creates can't collide with the originals on
 *    the host's dedup. This is also what clears the phantom `$CASH` asset an
 *    in-transit placeholder leaves behind when it is promoted to a real leg.
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
export async function linkPairByRecreate(
  saveMany: (req: SaveManyRequest) => Promise<SaveManyResult>,
  legs: [LinkLeg, LinkLeg],
): Promise<LinkResult> {
  const groupId = newTransferGroupId();
  const problems: string[] = [];

  const del = await saveMany({ deleteIds: legs.map((l) => l.wfId) });
  for (const e of del.errors) problems.push(`delete (${e.action}): ${e.message}`);

  const res = await saveMany({
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
  if (problems.length > 0) return { linked: false, problems };

  // Adopt the gid Wealthfolio actually stored — it keeps its own for rows that
  // were already grouped, and reports null when it dropped the group entirely.
  //
  // Keyed by (ACCOUNT, tx id), not tx id alone: SimpleFin issues one transaction
  // id for both sides of a transfer between two accounts it connects, so a
  // tx-id-keyed echo collapsed the two legs into one entry — and the check below
  // ("both legs came back on the same gid") would then compare the second leg's
  // gid with itself and report `linked: true` even where one leg's group had been
  // silently dropped. Precisely the failure this echo exists to catch.
  const echoed = new Map<string, { group: string | null | undefined; id: string }>();
  for (const a of [...res.updated, ...res.created]) {
    const txId = txIdFromComment(a.comment);
    if (txId) echoed.set(accountTxKey(a.accountId, txId), { group: a.sourceGroupId, id: a.id });
  }
  const stored = legs.map((l) => echoed.get(accountTxKey(l.accountId, l.txId))?.group);
  const linked = !!stored[0] && stored[0] === stored[1];
  if (linked) {
    // The NEW ids: the re-created rows are what the change log points R2 at.
    const ids = legs.map((l) => echoed.get(accountTxKey(l.accountId, l.txId))?.id);
    return { linked: true, groupId: stored[0]!, ...(ids[0] && ids[1] ? { activityIds: [ids[0], ids[1]] as [string, string] } : {}) };
  }
  // Both saves reported success and the group still isn't there — the silent
  // drop this echo exists to catch. Name it, or the caller has a failure with
  // no host error to explain it.
  problems.push(
    `the host stored no shared group for both legs (got ${stored[0] ?? 'none'} / ${stored[1] ?? 'none'})`,
  );
  return { linked: false, problems };
}

/** One leg of a linked pair to unlink, and the type it becomes. */
export interface UnlinkLeg extends LinkLeg {
  /** The account's display name, for messages (falls back to its id). */
  accountName?: string;
  /** Ordinary money in or out (`expiredTransferLegType`). */
  newType: string;
}

export interface UnlinkResult {
  unlinked: boolean;
  /** The new rows exist but the old linked pair could not be deleted. */
  stale?: boolean;
  /** The re-created rows' ids, in leg order, when the echo carried them. */
  activityIds?: [string, string];
  problems?: string[];
}

/** A row named the way a person would look for it: account, date, amount, note. */
const describeLeg = (l: UnlinkLeg) => `${l.accountName || l.accountId} ${l.date} ${(l.absCents / 100).toFixed(2)} "${l.comment}"`;

/**
 * Undo of a transfer link: re-create both legs as ordinary money in or out
 * (no group, no transfer marker), THEN delete the old linked pair.
 *
 * Why not an update: an update to one leg of a linked pair is copied onto its
 * partner (Wealthfolio 3.8, `build_counterpart_update`) and cannot take a row
 * out of its group. Why create first: the delete cannot be taken back, so it
 * happens only once both new rows exist. The new types differ from the old
 * ones, so their fingerprints never collide with the legs still standing.
 * Deleting both ids in ONE request is clean — the bulk endpoint expands a
 * linked leg's delete to the pair and de-duplicates the ids.
 *
 * Failure leaves no loss: a refused or thrown create deletes nothing (the pair
 * stays linked and is retried); a failed delete leaves the old pair next to the
 * new rows, which `stale` reports so the next sync deletes only the old pair.
 */
export async function unlinkPairByRecreate(
  saveMany: (req: SaveManyRequest) => Promise<SaveManyResult>,
  legs: [UnlinkLeg, UnlinkLeg],
): Promise<UnlinkResult> {
  const both = `${describeLeg(legs[0])} and ${describeLeg(legs[1])}`;
  let res: SaveManyResult;
  try {
    res = await saveMany({
      creates: legs.map((leg) => ({
        accountId: leg.accountId,
        activityType: leg.newType,
        activityDate: leg.date,
        // Ordinary money resolves the cash asset by symbol; only a transfer leg
        // must carry none (see `isTransferType`).
        ...(isTransferType(leg.newType) ? {} : { symbol: { symbol: `$CASH-${leg.currency}` } }),
        amount: leg.absCents / 100,
        currency: leg.currency,
        comment: leg.comment,
      })),
    });
  } catch (e: any) {
    return { unlinked: false, problems: [`could not re-create ${both}, nothing deleted: ${String(e?.message ?? e)}`] };
  }
  const ids = legs.map((l) => res.created.find((a) => a.accountId === l.accountId && txIdFromComment(a.comment) === l.txId)?.id);
  if (res.errors.length > 0 || res.created.length < legs.length) {
    const why = res.errors.length > 0 ? res.errors.map((e) => `${e.action}: ${e.message}`).join('; ') : 'the host created fewer rows than asked';
    return { unlinked: false, problems: [`could not re-create ${both}, nothing deleted (still linked): ${why}`] };
  }
  const activityIds = ids[0] && ids[1] ? { activityIds: [ids[0], ids[1]] as [string, string] } : {};
  let problem: string | null = null;
  try {
    const del = await saveMany({ deleteIds: legs.map((l) => l.wfId) });
    if (del.errors.length > 0) problem = del.errors.map((e) => `delete (${e.action}): ${e.message}`).join('; ');
  } catch (e: any) {
    problem = String(e?.message ?? e);
  }
  if (problem !== null) {
    return {
      unlinked: false, stale: true, ...activityIds,
      problems: [`re-created ${both} as ordinary rows, but the old linked pair is still there next to them (${problem}); a later sync deletes it once both new rows are confirmed`],
    };
  }
  return { unlinked: true, ...activityIds };
}
