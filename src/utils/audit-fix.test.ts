import { describe, it, expect, vi } from 'vitest';
import type { HealthLeg } from '../../shared/audit-health';
import { LINK_CHANGED, LINK_DONE, LINK_UNREACHABLE, type LinkPair } from '../../shared/audit-link';
import { emptySyncOverrides } from '../../shared/sync-overrides';
import { accountTxKey } from '../../shared/transfers';
import { linkFromApp, type FixStore } from './audit-fix';
import { beginSync, LINK_SYNC_RUNNING } from './write-lock';

const OUT_KEY = accountTxKey('sfin-chk', 'TRN-1');
const IN_KEY = accountTxKey('sfin-card', 'TRN-2');
type Row = Record<string, unknown> & { id: string; accountId: string };
const detail = (over: Row): Row => ({
  activityType: 'WITHDRAWAL', date: '2026-10-08T00:00:00.000Z', amount: '464.60', currency: 'USD', accountName: 'PNC Checking', metadata: null, ...over,
});
const OUT = detail({ id: 'out-1', accountId: 'wf-chk', comment: 'CITI AUTOPAY · TRN-1' });
const INTO = detail({ id: 'in-1', accountId: 'wf-card', activityType: 'TRANSFER_IN', accountName: 'Citi Card', comment: 'PAYMENT THANK YOU · TRN-2' });
const leg = (r: Row, txKey: string): HealthLeg => ({
  activityId: r.id, accountId: r.accountId, accountName: String(r.accountName), txKey, date: '2026-10-08', absCents: 46460,
  type: String(r.activityType), currency: 'USD', description: String(r.comment).split(' · ')[0],
});
/** The snapshot's view: the card's payment is the leg, the checking withdrawal its other half. */
const PAIR: LinkPair = { key: 'leg:in-1', leg: leg(INTO, IN_KEY), counterpart: leg(OUT, OUT_KEY) };

/** The add-on SDK, in memory: the exact-id search, accounts and the bulk endpoint. */
function fakeCtx(rows: Row[]) {
  const saved: Array<Record<string, any>> = [];
  let next = 0;
  const ctx = {
    api: {
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', accountType: 'CASH' }, { id: 'wf-card', accountType: 'CREDIT_CARD' }]) },
      activities: {
        search: vi.fn(async (_page: number, _size: number, filters: { activityIds?: string[] }) => ({
          data: rows.filter((r) => filters.activityIds?.includes(r.id)), meta: { totalRowCount: 0 },
        })),
        saveMany: vi.fn(async (req: Record<string, any>) => {
          saved.push(req);
          for (const id of req.deleteIds ?? []) rows.splice(rows.findIndex((r) => r.id === id), 1);
          const created = (req.creates ?? []).map((w: Record<string, any>) => {
            next += 1;
            return { id: `new-${next}`, accountId: w.accountId, notes: w.comment, sourceGroupId: w.sourceGroupId ?? null };
          });
          return { created, updated: [], errors: [] };
        }),
      },
    },
  };
  return { ctx: ctx as any, saved };
}
const fakeStore = (over: FixStore = {}): FixStore & Record<string, any> => ({
  readSyncOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: false })),
  getLinkedGroups: vi.fn(async () => ({})),
  setLinkedGroups: vi.fn(async () => {}),
  recordChange: vi.fn(async () => {}),
  ...over,
});

describe('Link from the app', () => {
  it('re-reads both rows by id, links them through the SDK, remembers the pair, and records it as yours', async () => {
    const f = fakeCtx([{ ...OUT }, { ...INTO }]);
    const store = fakeStore();
    expect((await linkFromApp(f.ctx, store, [PAIR])).message).toBe(LINK_DONE);
    expect(f.ctx.api.activities.search).toHaveBeenCalledWith(0, 1, { activityIds: ['in-1'] }, '');
    expect(f.saved[0].deleteIds).toEqual(['out-1', 'in-1']);
    const creates = f.saved[1].creates as Array<Record<string, unknown>>;
    expect(creates.map((w) => w.activityType)).toEqual(['TRANSFER_OUT', 'TRANSFER_IN']);
    expect(store.setLinkedGroups).toHaveBeenCalledWith({ [OUT_KEY]: creates[0].sourceGroupId, [IN_KEY]: creates[0].sourceGroupId });
    expect(store.recordChange).toHaveBeenCalledWith(expect.objectContaining({ actor: 'you', kind: 'transfer-link' }));
  });

  it('refuses a pair its ledger already knows, and a row a link has marked since the snapshot', async () => {
    const known = fakeCtx([{ ...OUT }, { ...INTO }]);
    expect((await linkFromApp(known.ctx, fakeStore({ getLinkedGroups: vi.fn(async () => ({ [IN_KEY]: 'wf-transfer-x' })) }), [PAIR])).message).toBe(LINK_CHANGED);
    expect(known.saved).toEqual([]);
    const marked = fakeCtx([{ ...OUT }, { ...INTO, metadata: { flow: { is_external: false } } }]);
    expect((await linkFromApp(marked.ctx, fakeStore(), [PAIR])).message).toBe(LINK_CHANGED);
    expect(marked.saved).toEqual([]);
  });

  it('refuses a row whose amount changed between the snapshot and the click, and writes nothing', async () => {
    const f = fakeCtx([{ ...OUT, amount: '464.70' }, { ...INTO }]);
    const store = fakeStore();
    expect((await linkFromApp(f.ctx, store, [PAIR])).message).toBe(LINK_CHANGED);
    expect(f.saved).toEqual([]);
    expect(store.recordChange).not.toHaveBeenCalled();
  });

  it('never overwrites a ledger it cannot read', async () => {
    const f = fakeCtx([{ ...OUT }, { ...INTO }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = fakeStore({ getLinkedGroups: vi.fn(async () => { throw new SyntaxError('Unexpected token'); }) });
    const run = await linkFromApp(f.ctx, store, [PAIR]);
    // It linked; only the add-on's note of it failed, and the status line says so.
    expect(run.linked).toBe(1);
    expect(run.message).toBe("Linked, but the add-on couldn't note it (Unexpected token) — check Health after the next sync.");
    expect(store.setLinkedGroups).not.toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain('linked_groups was not updated: Unexpected token');
    warn.mockRestore();
  });

  it.each([['an array', []], ['a string', 'oops'], ['null', null]])('treats a linked_groups that parses to %s as unreadable and never writes it', async (_n, parsed) => {
    const f = fakeCtx([{ ...OUT }, { ...INTO }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = fakeStore({ getLinkedGroups: vi.fn(async () => parsed as unknown as Record<string, string>) });
    const run = await linkFromApp(f.ctx, store, [PAIR]);
    expect(run.linked).toBe(1);
    expect(run.message).toContain("couldn't note it");
    expect(store.setLinkedGroups).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses while a sync is running, and a sync that starts during a Link waits for it', async () => {
    const f = fakeCtx([{ ...OUT }, { ...INTO }]);
    const endSync = await beginSync();
    const refused = await linkFromApp(f.ctx, fakeStore(), [PAIR]);
    expect(refused.message).toBe(LINK_SYNC_RUNNING);
    expect(refused.linked).toBe(0);
    expect(f.saved).toEqual([]);
    endSync();
    // Now hold Link inside its first write and start a sync.
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const original = f.ctx.api.activities.saveMany;
    f.ctx.api.activities.saveMany = vi.fn(async (req: unknown) => { await gate; return original(req); });
    const linking = linkFromApp(f.ctx, fakeStore(), [PAIR]);
    let syncStarted = false;
    const syncing = beginSync().then((end) => { syncStarted = true; return end; });
    await new Promise((r) => setTimeout(r, 10));
    expect(syncStarted).toBe(false);
    // A second Link is refused too: one writer at a time.
    expect((await linkFromApp(f.ctx, fakeStore(), [PAIR])).message).toBe(LINK_SYNC_RUNNING);
    open();
    expect((await linking).message).toBe(LINK_DONE);
    (await syncing)();
    expect(syncStarted).toBe(true);
  });

  it('links nothing when the overrides cannot be read', async () => {
    const f = fakeCtx([{ ...OUT }, { ...INTO }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await linkFromApp(f.ctx, fakeStore({ readSyncOverrides: undefined }), [PAIR])).message).toBe(LINK_UNREACHABLE);
    expect(f.saved).toEqual([]);
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).toContain("the overrides couldn't be read");
    warn.mockRestore();
  });
});
