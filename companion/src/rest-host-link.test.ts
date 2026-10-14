import { describe, it, expect, vi } from 'vitest';
import type { LinkLeg } from '../../shared/sync-host.js';
import type { UnlinkLeg } from '../../shared/link-pair.js';
import { RestSyncHost } from './rest-host.js';

const OUT: LinkLeg = { wfId: 'out-1', accountId: 'wf-chk', txId: 'TRN-1', activityType: 'TRANSFER_OUT', date: '2026-10-08', absCents: 60000, currency: 'USD', comment: 'TO SAVINGS · TRN-1' };
const IN: LinkLeg = { wfId: 'in-1', accountId: 'wf-sav', txId: 'TRN-2', activityType: 'TRANSFER_IN', date: '2026-10-08', absCents: 60000, currency: 'USD', comment: 'FROM CHECKING · TRN-2' };
const item = (l: LinkLeg, over: Record<string, unknown> = {}) => ({
  id: l.wfId, accountId: l.accountId, activityType: l.activityType, date: `${l.date}T12:00:00+00:00`, amount: '600', currency: 'USD',
  comment: l.comment, assetId: '', subtype: null, fee: '0', sourceGroupId: null, metadata: null, ...over,
});

function client(rows: Array<Record<string, unknown>>) {
  return {
    searchActivities: vi.fn(async (body: { activityIdFilter?: string[] }) => rows.filter((r) => body.activityIdFilter?.includes(String(r.id)))),
    linkTransferActivities: vi.fn(async (a: string, b: string) => rows.filter((r) => [a, b].includes(String(r.id))).map((r) => ({ ...r, sourceGroupId: 'grp-1' }))),
    unlinkTransferActivities: vi.fn(async () => []),
    saveMany: vi.fn(async (req: { creates?: Array<Record<string, unknown>> }) => ({
      created: (req.creates ?? []).map((w, i) => ({ id: `new-${i}`, accountId: w.accountId, comment: w.comment, sourceGroupId: w.sourceGroupId })),
      updated: [], errors: [],
    })),
  };
}

describe('RestSyncHost links in place through POST /activities/link', () => {
  it('reads both rows by id, links them, and keeps their ids — nothing deleted or created', async () => {
    const c = client([item(OUT), item(IN)]);
    const result = await new RestSyncHost(c as any).linkPair([OUT, IN]);
    expect(result).toEqual({ linked: true, groupId: 'grp-1', activityIds: ['out-1', 'in-1'], inPlace: true });
    expect(c.searchActivities).toHaveBeenCalledWith({ page: 0, pageSize: 2, activityIdFilter: ['out-1', 'in-1'] });
    expect(c.linkTransferActivities).toHaveBeenCalledWith('out-1', 'in-1');
    expect(c.saveMany).not.toHaveBeenCalled();
  });

  it('re-creates a pair whose stored row in place would not keep (a leg stored as a deposit), as before', async () => {
    const c = client([item(OUT), item(IN, { activityType: 'DEPOSIT' })]);
    const result = await new RestSyncHost(c as any).linkPair([OUT, IN]);
    expect(c.linkTransferActivities).not.toHaveBeenCalled();
    expect(c.saveMany.mock.calls.map(([req]) => Object.keys(req as object).filter((k) => (req as any)[k] !== undefined))).toEqual([['deleteIds'], ['creates']]);
    expect(result.inPlace).toBeUndefined();
  });

  it('unlinks in place and retypes both rows in one update', async () => {
    const legs: [UnlinkLeg, UnlinkLeg] = [{ ...OUT, newType: 'WITHDRAWAL' }, { ...IN, newType: 'DEPOSIT' }];
    const rows = [item(OUT, { sourceGroupId: 'grp-1' }), item(IN, { sourceGroupId: 'grp-1' })];
    const c = client(rows);
    const result = await new RestSyncHost(c as any).unlinkPair(legs);
    expect(result).toEqual({ unlinked: true, inPlace: true, activityIds: ['out-1', 'in-1'] });
    expect(c.unlinkTransferActivities).toHaveBeenCalledWith('out-1', 'in-1');
    expect(c.saveMany).toHaveBeenCalledTimes(1);
    const updates = (c.saveMany.mock.calls[0][0] as { updates: Array<Record<string, unknown>> }).updates;
    expect(updates.map((u) => [u.id, u.activityType, u.activityDate, u.symbol])).toEqual([
      ['out-1', 'WITHDRAWAL', '2026-10-08T12:00:00+00:00', { symbol: '$CASH-USD' }],
      ['in-1', 'DEPOSIT', '2026-10-08T12:00:00+00:00', { symbol: '$CASH-USD' }],
    ]);
  });
});

describe('RestSyncHost passes its log to the in-place linker', () => {
  it('a fallback reason reaches the logger', async () => {
    const c = client([item(OUT), item(IN, { activityType: 'DEPOSIT' })]);
    const log = vi.fn();
    await new RestSyncHost(c as any, undefined, log).linkPair([OUT, IN]);
    expect(log).toHaveBeenCalledWith('link out-1/in-1: re-creating instead of linking in place (in-1 is stored as DEPOSIT and links as TRANSFER_IN)');
  });
});
