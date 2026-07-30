import { INTERNAL_TRANSFER_METADATA, newTransferGroupId, txIdFromComment } from './sync-core.js';
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
  if (problems.length > 0) return { linked: false };

  // Adopt the gid Wealthfolio actually stored — it keeps its own for rows that
  // were already grouped, and reports null when it dropped the group entirely.
  //
  // Keyed by (ACCOUNT, tx id), not tx id alone: SimpleFin issues one transaction
  // id for both sides of a transfer between two accounts it connects, so a
  // tx-id-keyed echo collapsed the two legs into one entry — and the check below
  // ("both legs came back on the same gid") would then compare the second leg's
  // gid with itself and report `linked: true` even where one leg's group had been
  // silently dropped. Precisely the failure this echo exists to catch.
  const echoed = new Map<string, string | null | undefined>();
  for (const a of [...res.updated, ...res.created]) {
    const txId = txIdFromComment(a.comment);
    if (txId) echoed.set(accountTxKey(a.accountId, txId), a.sourceGroupId);
  }
  const stored = legs.map((l) => echoed.get(accountTxKey(l.accountId, l.txId)));
  const linked = !!stored[0] && stored[0] === stored[1];
  return linked ? { linked: true, groupId: stored[0]! } : { linked: false };
}
