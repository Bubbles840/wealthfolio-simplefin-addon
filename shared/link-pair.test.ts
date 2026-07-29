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

  it('reports linked: false when a save returns errors', async () => {
    const saveMany = async (): Promise<SaveManyResult> => ({
      created: [], updated: [], errors: [{ action: 'create', message: 'boom' }],
    });
    const res = await linkPairByRecreate(saveMany, [leg('a', 'wf-a', 'TRANSFER_OUT'), leg('b', 'wf-b', 'TRANSFER_IN')]);
    expect(res.linked).toBe(false);
  });
});
