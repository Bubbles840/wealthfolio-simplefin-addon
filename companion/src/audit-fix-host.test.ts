import { describe, it, expect, vi } from 'vitest';
import type { HealthLeg } from '../../shared/audit-health.js';
import { linkPairs, LINK_CHANGED, LINK_DONE, type LinkPair } from '../../shared/audit-link.js';
import type { ChangeBucket } from '../../shared/change-log.js';
import { SKIPPED_TRANSACTIONS_SECRET_KEY } from '../../shared/skipped-transactions.js';
import { accountTxKey } from '../../shared/transfers.js';
import { removalFingerprint, removeForGood, REMOVE_DONE, REMOVE_UNLINK_FIRST } from '../../shared/tx-remove.js';
import { companionLinkIo, companionRemoveIo, type FixClient } from './audit-fix-host.js';

const NOW = new Date('2026-10-14T15:00:00Z');

type Row = Record<string, unknown> & { id: string; accountId: string };

/** Wealthfolio over REST, in memory: the exact-id search, accounts, the bulk endpoint and the add-on's secrets. */
function fakeClient(rows: Row[], secrets: Record<string, string> = {}) {
  const data = new Map(Object.entries(secrets));
  const saved: Array<Record<string, any>> = [];
  let next = 0;
  const client = {
    getAddonSecret: vi.fn(async (_addon: string, k: string) => data.get(k) ?? null),
    setAddonSecret: vi.fn(async (_addon: string, k: string, v: string) => { data.set(k, v); }),
    getAccounts: vi.fn(async () => [{ id: 'wf-chk', accountType: 'CASH' }, { id: 'wf-card', accountType: 'CREDIT_CARD' }]),
    searchActivities: vi.fn(async (b: { activityIdFilter?: string[] }) => rows.filter((r) => b.activityIdFilter?.includes(r.id)) as any),
    saveMany: vi.fn(async (req: Record<string, any>) => {
      saved.push(req);
      for (const id of req.deleteIds ?? []) rows.splice(rows.findIndex((r) => r.id === id), 1);
      const created = (req.creates ?? []).map((w: Record<string, any>) => {
        next += 1;
        const r: Row = {
          id: `new-${next}`, accountId: w.accountId, activityType: w.activityType, date: `${w.activityDate}T00:00:00+00:00`,
          amount: String(w.amount), currency: w.currency, comment: w.comment, sourceGroupId: w.sourceGroupId ?? null, metadata: w.metadata ?? null,
        };
        rows.push(r);
        return r;
      });
      return { created, updated: [], errors: [] };
    }),
  };
  /** The companion's bucket of the change log, whatever month the clock says. */
  const logged = () => [...data].filter(([k, v]) => k.startsWith('change_log:companion:') && v).flatMap(([, v]) => (JSON.parse(v) as ChangeBucket).entries);
  return { client: client as unknown as FixClient & typeof client, data, rows, saved, logged };
}

const detail = (over: Row): Row => ({
  activityType: 'WITHDRAWAL', date: '2026-10-08T00:00:00+00:00', amount: '464.60', currency: 'USD', sourceGroupId: null, metadata: null,
  accountName: 'PNC Checking', ...over,
});
const OUT = detail({ id: 'out-1', accountId: 'wf-chk', comment: 'CITI AUTOPAY · TRN-1' });
const INTO = detail({ id: 'in-1', accountId: 'wf-card', activityType: 'TRANSFER_IN', accountName: 'Citi Card', comment: 'PAYMENT THANK YOU · TRN-2' });
const leg = (r: Row, txKey: string): HealthLeg => ({
  activityId: r.id, accountId: r.accountId, accountName: String(r.accountName), txKey, date: '2026-10-08', absCents: 46460,
  type: String(r.activityType), currency: 'USD', description: String(r.comment).split(' · ')[0],
});
/** Health's view: the card's payment is the leg, the checking withdrawal its other half. */
const PAIR: LinkPair = { key: 'leg:in-1', leg: leg(INTO, accountTxKey('sfin-card', 'TRN-2')), counterpart: leg(OUT, accountTxKey('sfin-chk', 'TRN-1')) };

describe('Link on the companion', () => {
  it('re-reads both rows live, links them through the sync’s linker, and logs it as yours in Telegram', async () => {
    const f = fakeClient([{ ...OUT }, { ...INTO }]);
    const log = vi.fn();
    expect((await linkPairs([PAIR], companionLinkIo(f.client, log))).message).toBe(LINK_DONE);
    expect(f.client.searchActivities).toHaveBeenCalledWith({ page: 0, pageSize: 1, activityIdFilter: ['in-1'] });
    expect(f.saved[0].deleteIds).toEqual(['out-1', 'in-1']);
    const creates = f.saved[1].creates as Array<Record<string, unknown>>;
    expect(creates.map((w) => [w.accountId, w.activityType, w.comment])).toEqual([
      ['wf-chk', 'TRANSFER_OUT', 'CITI AUTOPAY · TRN-1'], ['wf-card', 'TRANSFER_IN', 'PAYMENT THANK YOU · TRN-2'],
    ]);
    expect(creates[0].sourceGroupId).toBe(creates[1].sourceGroupId);
    expect(f.logged()).toEqual([expect.objectContaining({
      writer: 'companion', actor: 'you', kind: 'transfer-link', subject: expect.objectContaining({ activityIds: ['new-1', 'new-2'] }),
    })]);
    expect(log).not.toHaveBeenCalled();
  });

  it('reads a grouped row as linked, and writes nothing', async () => {
    const f = fakeClient([{ ...OUT, sourceGroupId: 'wf-transfer-x' }, { ...INTO }]);
    expect((await linkPairs([PAIR], companionLinkIo(f.client, vi.fn()))).message).toBe(LINK_CHANGED);
    expect(f.saved).toEqual([]);
  });
});

describe('Remove for good on the companion', () => {
  const DUP = detail({ id: 'dup-1', accountId: 'wf-chk', activityType: 'DEPOSIT', amount: '600', date: '2026-10-09T00:00:00+00:00', comment: 'MOBILE DEPOSIT · TRN-600' });
  const FP = removalFingerprint({ activityId: 'dup-1', note: 'MOBILE DEPOSIT · TRN-600', absCents: 60000, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking' });
  const mapping = { account_mapping: JSON.stringify({ 'sfin-chk': 'wf-chk' }) };

  it('skips it under its feed, deletes it over REST, and logs the removal as yours', async () => {
    const f = fakeClient([{ ...DUP }], mapping);
    expect(await removeForGood('dup-1', FP, companionRemoveIo(f.client, vi.fn()), NOW)).toEqual({ ok: true, message: REMOVE_DONE });
    expect(JSON.parse(f.data.get(SKIPPED_TRANSACTIONS_SECRET_KEY)!)).toEqual([
      { account: 'sfin-chk', txId: 'TRN-600', note: 'Removed for good', at: NOW.toISOString() },
    ]);
    expect(f.saved).toEqual([{ deleteIds: ['dup-1'] }]);
    expect(f.rows).toEqual([]);
    expect(f.logged()).toEqual([expect.objectContaining({ writer: 'companion', actor: 'you', kind: 'transaction-removed' })]);
  });

  it('refuses a linked leg read through REST (the search reports its group), and deletes nothing', async () => {
    const f = fakeClient([{ ...DUP, activityType: 'TRANSFER_OUT', sourceGroupId: 'wf-transfer-x' }], mapping);
    const io = companionRemoveIo(f.client, vi.fn());
    const row = await io.read('dup-1');
    expect(row?.grouped).toBe(true);
    expect(await io.linked(row!, ['sfin-chk:TRN-600'])).toBe('confirmed');
    const fp = removalFingerprint({ activityId: 'dup-1', note: 'MOBILE DEPOSIT · TRN-600', absCents: 60000, date: '2026-10-09', activityType: 'TRANSFER_OUT', accountName: 'PNC Checking' });
    expect(await removeForGood('dup-1', fp, io, NOW)).toEqual({ ok: false, message: REMOVE_UNLINK_FIRST });
    expect(f.saved).toEqual([]);
    expect(f.rows).toHaveLength(1);
  });

  it('refuses a grouped row', async () => {
    const f = fakeClient([{ ...DUP, sourceGroupId: 'wf-transfer-x' }], mapping);
    expect(await removeForGood('dup-1', FP, companionRemoveIo(f.client, vi.fn()), NOW)).toEqual({ ok: false, message: REMOVE_UNLINK_FIRST });
    expect(f.saved).toEqual([]);
  });
});
