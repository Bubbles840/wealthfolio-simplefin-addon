import { describe, it, expect, vi } from 'vitest';
import type { HealthLeg } from '../../shared/audit-health';
import { LINK_DONE, type LinkPair } from '../../shared/audit-link';
import { emptySyncOverrides } from '../../shared/sync-overrides';
import { accountTxKey } from '../../shared/transfers';
import { linkFromApp, type FixStore } from './audit-fix';

const OUT_KEY = accountTxKey('sfin-chk', 'TRN-1');
const IN_KEY = accountTxKey('sfin-sav', 'TRN-2');
type Row = Record<string, unknown> & { id: string; accountId: string };
const OUT: Row = {
  id: 'out-1', accountId: 'wf-chk', accountName: 'Checking', activityType: 'TRANSFER_OUT', date: '2026-10-08T12:00:00.000Z', amount: '600',
  currency: 'USD', comment: 'TO SAVINGS · TRN-1', assetId: '', subtype: null, fee: '0', metadata: null,
};
const INTO: Row = { ...OUT, id: 'in-1', accountId: 'wf-sav', accountName: 'Savings', activityType: 'TRANSFER_IN', comment: 'FROM CHECKING · TRN-2' };
const leg = (r: Row, txKey: string): HealthLeg => ({
  activityId: r.id, accountId: r.accountId, accountName: String(r.accountName), txKey, date: '2026-10-08', absCents: 60000,
  type: String(r.activityType), currency: 'USD', description: String(r.comment).split(' · ')[0],
});
const PAIR: LinkPair = { key: 'leg:in-1', leg: leg(INTO, IN_KEY), counterpart: leg(OUT, OUT_KEY) };

/** A Wealthfolio 3.9+ host: the exact-id search, `linkTransfer`, and the cash search the feature check makes. */
function host39(rows: Row[]) {
  const ctx = {
    api: {
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', accountType: 'CASH' }, { id: 'wf-sav', accountType: 'CASH' }]) },
      spending: { searchCashActivities: vi.fn(async () => ({ items: [], totalCount: 0 })) },
      activities: {
        search: vi.fn(async (_p: number, _s: number, f: { activityIds?: string[] }) => ({ data: rows.filter((r) => f.activityIds?.includes(r.id)), meta: { totalRowCount: 0 } })),
        saveMany: vi.fn(async () => ({ created: [], updated: [], errors: [] })),
        linkTransfer: vi.fn(async (a: string, b: string) => rows.filter((r) => [a, b].includes(r.id)).map((r) => ({ ...r, sourceGroupId: 'b3f1c2d4-uuid' }))),
      },
    },
  };
  return ctx as any;
}
const recordChange = vi.fn(async (_draft: unknown) => {});
const fakeStore = (): FixStore & Record<string, any> => ({
  readSyncOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: false })),
  getLinkedGroups: vi.fn(async () => ({})),
  setLinkedGroups: vi.fn(async () => {}),
  recordChange,
});

describe('Link from the app, on Wealthfolio 3.9 and newer', () => {
  it('links the two rows in place: same ids, nothing deleted, remembered for the sync, recorded as yours', async () => {
    const ctx = host39([{ ...OUT }, { ...INTO }]);
    const store = fakeStore();
    expect((await linkFromApp(ctx, store, [PAIR])).message).toBe(LINK_DONE);
    expect(ctx.api.activities.linkTransfer).toHaveBeenCalledWith('out-1', 'in-1');
    expect(ctx.api.activities.saveMany).not.toHaveBeenCalled();
    expect(store.setLinkedGroups).toHaveBeenCalledWith({ [OUT_KEY]: 'wf-transfer-b3f1c2d4-uuid', [IN_KEY]: 'wf-transfer-b3f1c2d4-uuid' });
    const entry = recordChange.mock.calls[0][0];
    expect(entry).toMatchObject({ actor: 'you', kind: 'transfer-link', before: { activityIds: ['out-1', 'in-1'] }, after: { activityIds: ['out-1', 'in-1'] } });
  });

  it('falls back to re-creating when Wealthfolio refuses to link in place — and, when that re-create is refused too, writes both rows back and says so', async () => {
    const rows: Row[] = [{ ...OUT }, { ...INTO }];
    const ctx = host39(rows);
    ctx.api.activities.linkTransfer = vi.fn(async () => { throw new Error('Security transfer legs use different assets'); });
    let n = 0;
    ctx.api.activities.saveMany = vi.fn(async (req: { deleteIds?: string[]; creates?: Array<Record<string, unknown>> }) => {
      n += 1;
      if (req.deleteIds) rows.splice(0, rows.length, ...rows.filter((r) => !req.deleteIds!.includes(r.id)));
      if (n === 2) return { created: [], updated: [], errors: [{ action: 'create', message: 'Activity validation failed' }] };
      return { created: (req.creates ?? []).map((w, i) => ({ id: `back-${i}`, accountId: w.accountId, notes: w.comment })), updated: [], errors: [] };
    });
    const run = await linkFromApp(ctx, fakeStore(), [PAIR]);
    expect(ctx.api.activities.linkTransfer).toHaveBeenCalledTimes(1);
    expect(run.message).toBe('Wealthfolio refused the link (Activity validation failed). Both rows are back, with new ids. Their categories may need filing again.');
    expect(ctx.api.activities.saveMany.mock.calls.map(([r]: [Record<string, unknown>]) => Object.keys(r))).toEqual([['deleteIds'], ['creates'], ['creates']]);
  });
});
