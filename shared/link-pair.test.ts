import { describe, it, expect } from 'vitest';
import { linkPairByRecreate } from './link-pair.js';
import { TRANSFER_GROUP_PREFIX } from './sync-core.js';
import type { LinkLeg, SaveManyRequest, SaveManyResult } from './sync-host.js';

const leg = (wfId: string, accountId: string, type: string): LinkLeg => ({
  wfId, accountId, txId: `tx-${wfId}`, activityType: type,
  date: '2026-07-20', absCents: 198219, currency: 'USD',
  comment: `Transfer · tx-${wfId}`,
});

/** Fake host: echoes creates back with the gid it was sent, like a host that accepts the group. */
function acceptingHost() {
  const requests: SaveManyRequest[] = [];
  const saveMany = async (req: SaveManyRequest): Promise<SaveManyResult> => {
    requests.push(req);
    return {
      created: (req.creates ?? []).map((c, i) => ({
        id: `new-${i}`, accountId: c.accountId, activityType: c.activityType,
        date: c.activityDate, amount: c.amount ?? null, comment: c.comment,
        sourceGroupId: c.sourceGroupId ?? null,
      })),
      updated: [], errors: [],
    };
  };
  return { requests, saveMany };
}

describe('linkPairByRecreate', () => {
  it('deletes both legs before re-creating them, so a stored asset cannot survive', async () => {
    const { requests, saveMany } = acceptingHost();
    await linkPairByRecreate(saveMany, [leg('a', 'wf-a', 'TRANSFER_OUT'), leg('b', 'wf-b', 'TRANSFER_IN')]);
    expect(requests[0].deleteIds).toEqual(['a', 'b']);
    expect(requests[1].creates).toHaveLength(2);
  });

  it('re-creates both legs with NO symbol, so they book cash and stay pairable', async () => {
    const { requests, saveMany } = acceptingHost();
    await linkPairByRecreate(saveMany, [leg('a', 'wf-a', 'TRANSFER_OUT'), leg('b', 'wf-b', 'TRANSFER_IN')]);
    for (const c of requests[1].creates!) {
      expect(c.symbol).toBeUndefined();
      expect(c.amount).toBe(1982.19);
    }
  });

  it('sends both legs in ONE saveMany carrying a shared wf-transfer- gid and the internal marker', async () => {
    const { requests, saveMany } = acceptingHost();
    await linkPairByRecreate(saveMany, [leg('a', 'wf-a', 'TRANSFER_OUT'), leg('b', 'wf-b', 'TRANSFER_IN')]);
    const creates = requests[1].creates!;
    expect(creates[0].sourceGroupId).toBe(creates[1].sourceGroupId);
    expect(creates[0].sourceGroupId!.startsWith(TRANSFER_GROUP_PREFIX)).toBe(true);
    // Must be the JSON *string*, not the object: the server 422s on an object
    // metadata, so every link would fail. `toBeTruthy()` passed either way, so
    // the clause was only pinned by INTERNAL_TRANSFER_METADATA's own
    // definition — assert the type here so a refactor there can't silently
    // break every link.
    for (const c of creates) {
      expect(typeof c.metadata).toBe('string');
      expect(JSON.parse(c.metadata as unknown as string)).toBeTruthy();
    }
  });

  it('reports the gid the host actually stored, not the one we sent', async () => {
    const requests: SaveManyRequest[] = [];
    const saveMany = async (req: SaveManyRequest): Promise<SaveManyResult> => {
      requests.push(req);
      return {
        created: (req.creates ?? []).map((c, i) => ({
          id: `new-${i}`, accountId: c.accountId, activityType: c.activityType,
          date: c.activityDate, amount: c.amount ?? null, comment: c.comment,
          sourceGroupId: 'gid-the-host-chose',
        })),
        updated: [], errors: [],
      };
    };
    const res = await linkPairByRecreate(saveMany, [leg('a', 'wf-a', 'TRANSFER_OUT'), leg('b', 'wf-b', 'TRANSFER_IN')]);
    expect(res).toEqual({ linked: true, groupId: 'gid-the-host-chose' });
  });

  it('reports linked: false when the host silently drops the group', async () => {
    const saveMany = async (req: SaveManyRequest): Promise<SaveManyResult> => ({
      created: (req.creates ?? []).map((c, i) => ({
        id: `new-${i}`, accountId: c.accountId, activityType: c.activityType,
        date: c.activityDate, amount: c.amount ?? null, comment: c.comment,
        sourceGroupId: null,
      })),
      updated: [], errors: [],
    });
    const res = await linkPairByRecreate(saveMany, [leg('a', 'wf-a', 'TRANSFER_OUT'), leg('b', 'wf-b', 'TRANSFER_IN')]);
    expect(res.linked).toBe(false);
  });

  /**
   * SimpleFin issues ONE transaction id for BOTH sides of a transfer between two
   * accounts it connects, so the echo cannot be keyed by tx id: the two legs
   * collapsed into one entry, and "both legs came back on the same gid" then
   * compared the surviving leg's gid with ITSELF and reported success. That is the
   * one failure this echo exists to catch, so it must not be blind to it exactly
   * where the bank is telling us outright that the two rows are one transfer.
   */
  it('still notices a dropped group when both legs share one transaction id', async () => {
    const shared = (wfId: string, accountId: string, type: string): LinkLeg => ({
      ...leg(wfId, accountId, type), txId: 'TRN-shared', comment: 'Transfer · TRN-shared',
    });
    const saveMany = async (req: SaveManyRequest): Promise<SaveManyResult> => ({
      // The FIRST leg's group is silently dropped and the second's lands. That
      // order matters: a tx-id-keyed echo is last-write-wins, so the surviving
      // second leg overwrote the first's `null` and the pair read as linked.
      created: (req.creates ?? []).map((c, i) => ({
        id: `new-${i}`, accountId: c.accountId, activityType: c.activityType,
        date: c.activityDate, amount: c.amount ?? null, comment: c.comment,
        sourceGroupId: i === 0 ? null : (c.sourceGroupId ?? null),
      })),
      updated: [], errors: [],
    });
    const res = await linkPairByRecreate(saveMany, [
      shared('a', 'wf-a', 'TRANSFER_OUT'),
      shared('b', 'wf-b', 'TRANSFER_IN'),
    ]);
    expect(res.linked).toBe(false);
  });

  it('reports linked: false when a save returns errors', async () => {
    const saveMany = async (): Promise<SaveManyResult> => ({
      created: [], updated: [], errors: [{ action: 'create', message: 'boom' }],
    });
    const res = await linkPairByRecreate(saveMany, [leg('a', 'wf-a', 'TRANSFER_OUT'), leg('b', 'wf-b', 'TRANSFER_IN')]);
    expect(res.linked).toBe(false);
  });

  /**
   * This function DELETES two financial rows before re-creating them. When the
   * re-create is refused the rows are already gone, which makes it the highest-
   * consequence failure in the whole sync — and it used to collect every host
   * error into a local `problems` array and then throw it away, returning a bare
   * `{ linked: false }`. The caller could report only "a leg could not be
   * linked", so the actual reason (a rejected duplicate, a validation error)
   * never reached a log, a UI banner, or Telegram.
   */
  it('returns the host errors that caused the failure, so the reason is not lost', async () => {
    const saveMany = async (req: SaveManyRequest): Promise<SaveManyResult> =>
      req.deleteIds
        ? { created: [], updated: [], errors: [] }
        : { created: [], updated: [], errors: [{ action: 'create', message: 'duplicate activity' }] };
    const res = await linkPairByRecreate(saveMany, [
      leg('a', 'wf-a', 'TRANSFER_OUT'),
      leg('b', 'wf-b', 'TRANSFER_IN'),
    ]);
    expect(res.linked).toBe(false);
    expect(res.problems).toEqual(['save (create): duplicate activity']);
  });

  it('explains a silently dropped group, so no failure is reasonless', async () => {
    const saveMany = async (req: SaveManyRequest): Promise<SaveManyResult> => ({
      created: (req.creates ?? []).map((c, i) => ({
        id: `new-${i}`, accountId: c.accountId, activityType: c.activityType,
        date: c.activityDate, amount: c.amount ?? null, comment: c.comment,
        sourceGroupId: null,
      })),
      updated: [], errors: [],
    });
    const res = await linkPairByRecreate(saveMany, [
      leg('a', 'wf-a', 'TRANSFER_OUT'),
      leg('b', 'wf-b', 'TRANSFER_IN'),
    ]);
    expect(res.linked).toBe(false);
    expect(res.problems?.join(' ')).toMatch(/group/i);
  });
});
