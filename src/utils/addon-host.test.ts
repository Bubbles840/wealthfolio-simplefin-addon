import { describe, it, expect, vi } from 'vitest';
import type { UnlinkLeg } from '../../shared/link-pair';
import type { LinkLeg } from '../../shared/sync-host';
import { AddonSyncHost } from './addon-host';

const OUT: LinkLeg = { wfId: 'out-1', accountId: 'wf-chk', txId: 'TRN-1', activityType: 'TRANSFER_OUT', date: '2026-10-08', absCents: 60000, currency: 'USD', comment: 'TO SAVINGS · TRN-1' };
const IN: LinkLeg = { wfId: 'in-1', accountId: 'wf-sav', txId: 'TRN-2', activityType: 'TRANSFER_IN', date: '2026-10-08', absCents: 60000, currency: 'USD', comment: 'FROM CHECKING · TRN-2' };
const detail = (l: LinkLeg, over: Record<string, unknown> = {}) => ({
  id: l.wfId, accountId: l.accountId, activityType: l.activityType, date: `${l.date}T12:00:00.000Z`, amount: '600', currency: 'USD',
  comment: l.comment, assetId: '', subtype: null, fee: '0', metadata: null, ...over,
});

/** The SDK as a host offers it: the cash search and Wealthfolio's link only from 3.9. */
function fakeCtx(rows: Array<Record<string, unknown>>, host: '3.8' | '3.9') {
  const activities: Record<string, unknown> = {
    search: vi.fn(async (_p: number, _s: number, f: { activityIds?: string[] }) => ({ data: rows.filter((r) => f.activityIds?.includes(String(r.id))), meta: { totalRowCount: 0 } })),
    saveMany: vi.fn(async (req: { creates?: Array<Record<string, unknown>> }) => ({
      created: (req.creates ?? []).map((w, i) => ({ id: `new-${i}`, accountId: w.accountId, notes: w.comment, sourceGroupId: w.sourceGroupId })),
      updated: [], errors: [],
    })),
  };
  const api: Record<string, unknown> = { activities };
  if (host === '3.9') {
    activities.linkTransfer = vi.fn(async (a: string, b: string) => rows.filter((r) => [a, b].includes(String(r.id))).map((r) => ({ ...r, sourceGroupId: 'grp-1' })));
    activities.unlinkTransfer = vi.fn(async () => []);
    api.spending = { searchCashActivities: vi.fn(async () => ({ items: [], totalCount: 0 })) };
  }
  return { api } as any;
}

describe('AddonSyncHost links in place on a 3.9+ host', () => {
  it('through the SDK\'s linkTransfer, keeping both ids', async () => {
    const ctx = fakeCtx([detail(OUT), detail(IN)], '3.9');
    const result = await new AddonSyncHost(ctx).linkPair([OUT, IN]);
    expect(result).toEqual({ linked: true, groupId: 'grp-1', activityIds: ['out-1', 'in-1'], inPlace: true });
    expect(ctx.api.activities.search).toHaveBeenCalledWith(0, 2, { activityIds: ['out-1', 'in-1'] }, '');
    expect(ctx.api.activities.linkTransfer).toHaveBeenCalledWith('out-1', 'in-1');
    expect(ctx.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it('and re-creates the pair on a 3.8 host, which has no linkTransfer, exactly as before', async () => {
    const ctx = fakeCtx([detail(OUT), detail(IN)], '3.8');
    const result = await new AddonSyncHost(ctx).linkPair([OUT, IN]);
    expect(ctx.api.activities.search).not.toHaveBeenCalled();
    expect(ctx.api.activities.saveMany.mock.calls.map(([r]: [Record<string, unknown>]) => Object.keys(r))).toEqual([['deleteIds'], ['creates']]);
    expect(result.linked).toBe(true);
    expect(result.inPlace).toBeUndefined();
  });

  it('unlinks in place through unlinkTransfer, then retypes both rows in one update', async () => {
    const ctx = fakeCtx([detail(OUT, { sourceGroupId: 'grp-1' }), detail(IN, { sourceGroupId: 'grp-1' })], '3.9');
    const legs: [UnlinkLeg, UnlinkLeg] = [{ ...OUT, newType: 'WITHDRAWAL' }, { ...IN, newType: 'DEPOSIT' }];
    const result = await new AddonSyncHost(ctx).unlinkPair(legs);
    expect(result).toEqual({ unlinked: true, inPlace: true, activityIds: ['out-1', 'in-1'] });
    expect(ctx.api.activities.unlinkTransfer).toHaveBeenCalledWith('out-1', 'in-1');
    expect(ctx.api.activities.saveMany).toHaveBeenCalledTimes(1);
    expect(Object.keys(ctx.api.activities.saveMany.mock.calls[0][0])).toEqual(['updates']);
  });
});

describe('AddonSyncHost passes its log to the in-place linker', () => {
  it('a fallback reason reaches the logger', async () => {
    const ctx = fakeCtx([detail(OUT), detail(IN, { activityType: 'DEPOSIT' })], '3.9');
    const log = vi.fn();
    await new AddonSyncHost(ctx, { log }).linkPair([OUT, IN]);
    expect(log).toHaveBeenCalledWith('link out-1/in-1: re-creating instead of linking in place (in-1 is stored as DEPOSIT and links as TRANSFER_IN)');
  });
});

describe('AddonSyncHost totals a card from its whole history on a manual run (1.64, B1)', () => {
  /** A card with `n` posted $1 charges, served 500 to a page, newest first. */
  const cardCtx = (n: number, extra: Array<Record<string, unknown>> = []) => {
    const rows = [
      ...extra,
      ...Array.from({ length: n }, (_, i) => ({ id: `c${i}`, accountId: 'wf-citi', activityType: 'WITHDRAWAL', date: '2026-10-01', amount: '1', comment: `CHARGE · t${i}` })),
    ];
    const search = vi.fn(async (page: number, size: number, _filter?: unknown) => ({ data: rows.slice(page * size, (page + 1) * size), meta: { totalRowCount: rows.length } }));
    return { ctx: { api: { activities: { search } } } as any, search };
  };

  it('pages 500 at a time until a short page, and signs what search reports', async () => {
    const { ctx, search } = cardCtx(1001, [
      { id: 'pay', accountId: 'wf-citi', activityType: 'TRANSFER_IN', date: '2026-10-02', amount: '500', comment: 'AUTOPAY · p1' },
      { id: 'pend', accountId: 'wf-citi', activityType: 'WITHDRAWAL', date: '2026-10-03', amount: '40', comment: 'NOT YET · p2 · pending' },
    ]);
    const host = new AddonSyncHost(ctx, { fullCardHistory: true });
    const totals = await host.postedLedgerTotals([{ wfAccountId: 'wf-citi', accountType: 'CREDIT_CARD' }]);
    expect(totals.get('wf-citi')).toBe(-501);
    expect(search.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      [0, 500, { accountIds: ['wf-citi'] }], [1, 500, { accountIds: ['wf-citi'] }], [2, 500, { accountIds: ['wf-citi'] }],
    ]);
  });

  it('reads nothing on a scheduled run (R7)', async () => {
    const { ctx, search } = cardCtx(3);
    const totals = await new AddonSyncHost(ctx).postedLedgerTotals([{ wfAccountId: 'wf-citi', accountType: 'CREDIT_CARD' }]);
    expect(totals.size).toBe(0);
    expect(search).not.toHaveBeenCalled();
  });

  it('omits a card holding an in-transit placeholder, and one whose read fails', async () => {
    const { ctx } = cardCtx(2, [
      { id: 'held', accountId: 'wf-citi', activityType: 'TRANSFER_IN', date: '2026-10-02', amount: '42.40', comment: '↔️ In-transit transfer · AUTOPAY · p1' },
    ]);
    const host = new AddonSyncHost(ctx, { fullCardHistory: true });
    expect((await host.postedLedgerTotals([{ wfAccountId: 'wf-citi', accountType: 'CREDIT_CARD' }])).has('wf-citi')).toBe(false);

    const failing = { api: { activities: { search: vi.fn(async () => { throw new Error('offline'); }) } } } as any;
    const log = vi.fn();
    const broken = new AddonSyncHost(failing, { fullCardHistory: true, log });
    expect((await broken.postedLedgerTotals([{ wfAccountId: 'wf-citi', accountType: 'CREDIT_CARD' }])).size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });
});
