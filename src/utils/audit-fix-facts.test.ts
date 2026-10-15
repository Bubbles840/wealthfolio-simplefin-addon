import { describe, it, expect, vi } from 'vitest';
import type { HealthLeg } from '../../shared/audit-health';
import { LINK_CHANGED, LINK_DONE, type LinkPair } from '../../shared/audit-link';
import { emptySyncOverrides } from '../../shared/sync-overrides';
import { accountTxKey } from '../../shared/transfers';
import { removalFingerprint, REMOVE_DONE, REMOVE_UNLINK_FIRST } from '../../shared/tx-remove';
import { linkFromApp, removeFromApp, type FixStore } from './audit-fix';

const OUT_KEY = accountTxKey('sfin-chk', 'TRN-1');
const IN_KEY = accountTxKey('sfin-sav', 'TRN-2');
type Row = Record<string, unknown> & { id: string; accountId: string };
/** Wealthfolio's own link left `flow.is_external: false` on a row — what the old rule called "maybe linked". */
const OUT: Row = {
  id: 'out-1', accountId: 'wf-chk', accountName: 'Checking', activityType: 'TRANSFER_OUT', date: '2026-10-08T12:00:00.000Z', amount: '600',
  currency: 'USD', comment: 'TO SAVINGS · TRN-1', assetId: '', subtype: null, fee: '0', metadata: { flow: { is_external: false } },
};
const INTO: Row = { ...OUT, id: 'in-1', accountId: 'wf-sav', accountName: 'Savings', activityType: 'TRANSFER_IN', comment: 'FROM CHECKING · TRN-2' };
const leg = (r: Row, txKey: string): HealthLeg => ({
  activityId: r.id, accountId: r.accountId, accountName: String(r.accountName), txKey, date: '2026-10-08', absCents: 60000,
  type: String(r.activityType), currency: 'USD', description: String(r.comment).split(' · ')[0],
});
const PAIR: LinkPair = { key: 'leg:in-1', leg: leg(INTO, IN_KEY), counterpart: leg(OUT, OUT_KEY) };

/** Wealthfolio 3.9+: the exact-id search, the cash search's facts, and the SDK writes. */
function host39(rows: Row[], status: Record<string, { transferLinkStatus: string; sourceGroupId: string | null }>, secrets: Record<string, string> = {}) {
  const data = new Map(Object.entries(secrets));
  const ctx = {
    api: {
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', accountType: 'CASH' }, { id: 'wf-sav', accountType: 'CASH' }]) },
      spending: {
        searchCashActivities: vi.fn(async (req: { accountIds?: string[] }) => {
          const items = rows.filter((r) => (req.accountIds ?? []).includes(r.accountId) && status[r.id])
            .map((r) => ({ ...r, activityDate: r.date, cashFlowBucket: 'neutral', assignments: [], splits: [], ...status[r.id] }));
          return { items, totalCount: items.length };
        }),
      },
      activities: {
        search: vi.fn(async (_p: number, _s: number, f: { activityIds?: string[] }) => ({ data: rows.filter((r) => f.activityIds?.includes(r.id)), meta: { totalRowCount: 0 } })),
        saveMany: vi.fn(async () => ({ created: [], updated: [], errors: [] })),
        linkTransfer: vi.fn(async (a: string, b: string) => rows.filter((r) => [a, b].includes(r.id)).map((r) => ({ ...r, sourceGroupId: 'grp-new' }))),
      },
      secrets: {
        get: vi.fn(async (k: string) => data.get(k) ?? null),
        set: vi.fn(async (k: string, v: string) => { data.set(k, v); }),
      },
    },
  };
  return ctx as any;
}
const fakeStore = (): FixStore & Record<string, any> => ({
  readSyncOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: false })),
  getLinkedGroups: vi.fn(async () => ({})),
  setLinkedGroups: vi.fn(async () => {}),
  recordChange: vi.fn(async () => {}),
  getAccountMapping: vi.fn(async () => ({ 'sfin-chk': 'wf-chk', 'sfin-sav': 'wf-sav' })),
});
const unlinked = { transferLinkStatus: 'unlinked', sourceGroupId: null };
const linked = { transferLinkStatus: 'linked', sourceGroupId: 'grp-9' };

describe('the app decides "linked" from Wealthfolio\'s facts on 3.9 and newer', () => {
  it('links a pair Wealthfolio says is unlinked, which the old rule refused as "maybe"', async () => {
    const ctx = host39([{ ...OUT }, { ...INTO }], { 'out-1': unlinked, 'in-1': unlinked });
    expect((await linkFromApp(ctx, fakeStore(), [PAIR])).message).toBe(LINK_DONE);
    expect(ctx.api.activities.linkTransfer).toHaveBeenCalledTimes(1);
  });

  it('refuses a pair Wealthfolio says is linked, though the add-on\'s ledger knows nothing of it', async () => {
    const ctx = host39([{ ...OUT, metadata: null }, { ...INTO, metadata: null }], { 'out-1': linked, 'in-1': linked });
    expect((await linkFromApp(ctx, fakeStore(), [PAIR])).message).toBe(LINK_CHANGED);
    expect(ctx.api.activities.linkTransfer).not.toHaveBeenCalled();
  });

  it('removes a transfer leg Wealthfolio says is unlinked — and refuses one it says is linked', async () => {
    const shown = removalFingerprint({ activityId: 'out-1', note: 'TO SAVINGS · TRN-1', absCents: 60000, date: '2026-10-08', activityType: 'TRANSFER_OUT', accountName: 'Checking' });
    const lone = host39([{ ...OUT }], { 'out-1': unlinked });
    expect(await removeFromApp(lone, fakeStore(), 'out-1', shown)).toEqual({ ok: true, message: REMOVE_DONE });
    expect(lone.api.activities.saveMany).toHaveBeenCalledWith({ deleteIds: ['out-1'] });
    const half = host39([{ ...OUT }], { 'out-1': linked });
    expect(await removeFromApp(half, fakeStore(), 'out-1', shown)).toEqual({ ok: false, message: REMOVE_UNLINK_FIRST });
    expect(half.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it('keeps the old rule for a row Wealthfolio returns no fact for (an account outside Spending)', async () => {
    const shown = removalFingerprint({ activityId: 'out-1', note: 'TO SAVINGS · TRN-1', absCents: 60000, date: '2026-10-08', activityType: 'TRANSFER_OUT', accountName: 'Checking' });
    const ctx = host39([{ ...OUT }], {});
    expect(await removeFromApp(ctx, fakeStore(), 'out-1', shown)).toEqual({ ok: false, message: REMOVE_UNLINK_FIRST });
  });
});
