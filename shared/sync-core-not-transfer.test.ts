import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChangeEntry, ChangeLogSink } from './change-entries.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { IN_TRANSIT_COMMENT_PREFIX, runSyncCore, txIdFromComment, VALUATION_POLL } from './sync-core.js';
import type { HostActivity, SaveManyRequest, SaveManyResult } from './sync-host.js';
import { emptySyncOverrides, setTxOverride, type SyncOverrides } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-13T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const OUT = accountTxKey('sfin-1', 'tx-out');
const IN = accountTxKey('sfin-2', 'tx-in');

function capture(): ChangeLogSink & { entries: () => ChangeEntry[] } {
  const batches: ChangeEntry[][] = [];
  return {
    writer: 'companion', run: 'cRUN1',
    append: vi.fn(async (entries: ChangeEntry[]) => { batches.push(entries); }),
    entries: () => batches.flat(),
  };
}

/** The note a run gives when it could not read every account before an unlink. */
const HELD_FOR_A_READ = 'Could not read every account, so a transfer you undid was not unlinked or cleaned up this sync — nothing was deleted; the next sync tries again';

const notTransfer = (...keys: string[]): SyncOverrides =>
  keys.reduce((o, k) => setTxOverride(o, k, 'notTransfer', NOW), emptySyncOverrides());

/** A Citi payment: out of Checking, into the card, both in this run's feed.
 *  The card's name is generic on purpose: since 1.63 a cash leg whose text names a
 *  connected account is a transfer from the moment it posts (A), which would turn
 *  these unlink tests into tests of that typing; the naming case is pinned at the
 *  end of the file. */
const twoAccounts = (extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-13T12:00:00Z'),
      transactions: [{ id: 'tx-out', posted: epoch('2026-10-08T12:00:00Z'), amount: '-464.60', description: 'CITI AUTOPAY PAYMENT' }] },
    { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-13T12:00:00Z'),
      transactions: [{ id: 'tx-in', posted: epoch('2026-10-09T12:00:00Z'), amount: '464.60', description: 'PAYMENT THANK YOU' }] },
  ] },
  mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
  accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CREDIT_CARD' },
  accountNames: { 'wf-a': 'Checking', 'wf-b': 'Citi Card' },
  ...extra,
});

/** The pair as an earlier sync left it: linked under one group. */
const linkedRows = (): Map<string, HostActivity[]> => new Map([
  ['wf-a', [{ id: 'act-out', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-10-08', amount: 464.6, comment: 'CITI AUTOPAY PAYMENT · tx-out', sourceGroupId: 'wf-transfer-9', metadata: '{"flow":{"is_external":false}}' }]],
  ['wf-b', [{ id: 'act-in', accountId: 'wf-b', activityType: 'TRANSFER_IN', date: '2026-10-09', amount: 464.6, comment: 'PAYMENT THANK YOU · tx-in', sourceGroupId: 'wf-transfer-9', metadata: '{"flow":{"is_external":false}}' }]],
]);

const rows = (activities: Map<string, HostActivity[]>) =>
  [...activities.values()].flat().map((r) => ({ account: r.accountId, type: r.activityType, comment: r.comment, group: r.sourceGroupId ?? null }))
    .sort((a, b) => a.account.localeCompare(b.account));

describe('runSyncCore — notTransfer', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('unlinks an already-linked pair, retypes both halves, and the next sync does not re-link them', async () => {
    const first = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(OUT, IN), upstreamWriteRules: true }));
    const log = capture();
    const result = await runSyncCore(first.host, first.store, { changeLog: log });

    expect(result.errors).toEqual([]);
    expect(first.links).toEqual([]);
    // Never an update to a linked leg (it would be copied onto the partner):
    // one create of both (before anything is deleted), then one delete of both.
    expect(first.saved.filter((r) => (r.updates ?? []).length > 0)).toEqual([]);
    expect(first.saved.map((r) => [r.deleteIds ?? [], (r.creates ?? []).map((c) => c.activityType)])).toEqual([
      [[], ['WITHDRAWAL', 'CREDIT']],
      [['act-out', 'act-in'], []],
    ]);
    expect(rows(first.activities)).toEqual([
      { account: 'wf-a', type: 'WITHDRAWAL', comment: 'CITI AUTOPAY PAYMENT · tx-out', group: null },
      { account: 'wf-b', type: 'CREDIT', comment: 'PAYMENT THANK YOU · tx-in', group: null },
    ]);
    expect(log.entries()).toEqual([expect.objectContaining({
      kind: 'bookkeeping', undoable: false,
      summary: 'Unlinked a transfer you undid: re-created its 2 rows as spending or money in',
      after: expect.objectContaining({ step: 'transfer-unlink', count: 2 }),
    })]);

    const second = createFakeHost(twoAccounts({ existing: first.activities, syncOverrides: notTransfer(OUT, IN), upstreamWriteRules: true }));
    await runSyncCore(second.host, second.store, { force: true });
    expect(second.links).toEqual([]);
    expect(second.saved).toEqual([]);
    expect(rows(second.activities)).toEqual(rows(first.activities));
  });

  it('on a host that cannot read groups, finds the partner in the ledger and clears both legs from it', async () => {
    const fh = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(OUT, IN) }));
    const host = { ...fh.host, capabilities: { readsSourceGroupId: false } };
    await fh.store.setLinkedGroups({ [OUT]: 'wf-transfer-9', [IN]: 'wf-transfer-9', 'tx-unrelated': 'wf-transfer-1' });
    const result = await runSyncCore(host, fh.store, {});
    expect(result.errors).toEqual([]);
    expect(fh.links).toEqual([]);
    expect(rows(fh.activities).map((r) => r.type)).toEqual(['WITHDRAWAL', 'CREDIT']);
    expect(await fh.store.getLinkedGroups()).toEqual({ 'tx-unrelated': 'wf-transfer-1' });
    // A second sync finds nothing left to do.
    const writes = fh.saved.length;
    await runSyncCore(host, fh.store, { force: true });
    expect(fh.saved.length).toBe(writes);
    expect(fh.links).toEqual([]);
  });

  it('unlinks the pair when only one leg carries the override', async () => {
    const fh = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(IN) }));
    await runSyncCore(fh.host, fh.store, {});
    expect(rows(fh.activities).map((r) => [r.type, r.group])).toEqual([['WITHDRAWAL', null], ['CREDIT', null]]);
  });

  it('reports a linked leg whose other half is not in view, and leaves it alone', async () => {
    const existing = linkedRows();
    existing.set('wf-b', []);
    const fh = createFakeHost(twoAccounts({ existing, syncOverrides: notTransfer(OUT) }));
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(result.errors).toEqual(['Could not unlink CITI AUTOPAY PAYMENT: its other half is not in this sync — it stays linked for now']);
    expect(fh.saved.some((r) => (r.deleteIds ?? []).includes('act-out'))).toBe(false);
  });

  it('a new pair with a notTransfer leg is never paired: that leg imports as ordinary money', async () => {
    const fh = createFakeHost(twoAccounts({ syncOverrides: notTransfer(OUT) }));
    await runSyncCore(fh.host, fh.store, {});
    expect(fh.links).toEqual([]);
    const out = fh.activities.get('wf-a')!;
    expect(out.map((r) => [r.activityType, r.comment])).toEqual([['WITHDRAWAL', 'CITI AUTOPAY PAYMENT · tx-out']]);
  });

  it('a mapping rule that types the leg as a transfer is ignored for it', async () => {
    const seed = twoAccounts({
      syncOverrides: notTransfer(OUT),
      mappingRules: [{ pattern: 'CITI AUTOPAY', matchType: 'contains', activityType: 'TRANSFER_OUT' }],
    });
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, {});
    expect(fh.activities.get('wf-a')!.map((r) => r.activityType)).toEqual(['WITHDRAWAL']);
  });

  it('a held placeholder becomes ordinary spending, and says why', async () => {
    const fh = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-13T12:00:00Z'),
        transactions: [{ id: 'tx-out', posted: epoch('2026-10-11T12:00:00Z'), amount: '-1300.00', description: 'Online Transfer to Savings' }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
      accountNames: { 'wf-a': 'Checking' },
      existing: new Map([['wf-a', [{
        id: 'ph-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-10-11', amount: 1300,
        comment: '↔️ In-transit transfer · Online Transfer to Savings · tx-out', sourceGroupId: null,
      }]]]),
      syncOverrides: notTransfer(OUT),
    });
    const log = capture();
    await runSyncCore(fh.host, fh.store, { changeLog: log });
    expect(fh.activities.get('wf-a')!.map((r) => [r.activityType, r.comment])).toEqual([['WITHDRAWAL', 'Online Transfer to Savings · tx-out']]);
    expect(log.entries()).toEqual([expect.objectContaining({
      kind: 'transfer-type', undoable: false,
      summary: "Counted Online Transfer to Savings as spending — you said it isn't a transfer",
      why: "You said it isn't a transfer",
    })]);
  });

  describe('data safety', () => {
    const snapshot = (a: Map<string, HostActivity[]>) => JSON.parse(JSON.stringify([...a.entries()]));
    /** A host whose saveMany is wrapped: `around` may answer a request itself. */
    const wrapped = (fh: ReturnType<typeof createFakeHost>, around: (req: SaveManyRequest) => Promise<SaveManyResult> | null) => ({
      ...fh.host,
      saveMany: (req: SaveManyRequest) => around(req) ?? fh.host.saveMany(req),
    });

    it('a host that cannot read groups never touches a pair it cannot confirm: no write, a note', async () => {
      const fh = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(OUT, IN), upstreamWriteRules: true }));
      const host = { ...fh.host, capabilities: { readsSourceGroupId: false } };
      const before = snapshot(fh.activities);
      const result = await runSyncCore(host, fh.store, {});
      expect(fh.saved).toEqual([]);
      expect(snapshot(fh.activities)).toEqual(before);
      expect(result.errors).toEqual([
        "Left CITI AUTOPAY PAYMENT as it is: this app has no record of linking it; the companion will unlink it on its next sync.",
        "Left PAYMENT THANK YOU as it is: this app has no record of linking it; the companion will unlink it on its next sync.",
      ]);
    });

    it('a refused create deletes nothing, names both rows, and the pair is retried next sync', async () => {
      const fh = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(OUT, IN), upstreamWriteRules: true }));
      const host = wrapped(fh, (req) => req.creates
        ? Promise.resolve({ created: [], updated: [], errors: [{ action: 'create', message: 'refused' }] }) : null);
      const before = snapshot(fh.activities);
      const result = await runSyncCore(host, fh.store, {});
      expect(fh.saved.some((r) => (r.deleteIds ?? []).length > 0)).toBe(false);
      expect(snapshot(fh.activities)).toEqual(before);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Transfer-unlink failed (tx-out/tx-in)');
      expect(result.errors[0]).toContain('Checking 2026-10-08 464.60 "CITI AUTOPAY PAYMENT · tx-out"');
      expect(result.errors[0]).toContain('Citi Card 2026-10-09 464.60 "PAYMENT THANK YOU · tx-in"');
      const retry = await runSyncCore(fh.host, fh.store, { force: true });
      expect(retry.errors).toEqual([]);
      expect(rows(fh.activities).map((r) => r.type)).toEqual(['WITHDRAWAL', 'CREDIT']);
    });

    it('a create that throws deletes nothing', async () => {
      const fh = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(OUT, IN), upstreamWriteRules: true }));
      const host = wrapped(fh, (req) => req.creates ? Promise.reject(new Error('socket closed')) : null);
      const before = snapshot(fh.activities);
      const result = await runSyncCore(host, fh.store, {});
      expect(fh.saved.some((r) => (r.deleteIds ?? []).length > 0)).toBe(false);
      expect(snapshot(fh.activities)).toEqual(before);
      expect(result.errors.join('\n')).toContain('socket closed');
    });

    it('a failed delete is reported; the next sync deletes only the stale pair and creates nothing', async () => {
      const first = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(OUT, IN), upstreamWriteRules: true }));
      const host = wrapped(first, (req) => req.deleteIds
        ? Promise.resolve({ created: [], updated: [], errors: [{ action: 'delete', message: 'locked' }] }) : null);
      const log = capture();
      const r1 = await runSyncCore(host, first.store, { changeLog: log });
      expect(r1.errors).toHaveLength(1);
      expect(r1.errors[0]).toContain('Transfer-unlink incomplete');
      expect(r1.errors[0]).toContain('the old linked pair is still there next to them');
      expect(log.entries()).toEqual([]);
      expect(rows(first.activities).map((r) => r.type).sort()).toEqual(['CREDIT', 'TRANSFER_IN', 'TRANSFER_OUT', 'WITHDRAWAL']);

      const second = createFakeHost(twoAccounts({ existing: first.activities, syncOverrides: notTransfer(OUT, IN), upstreamWriteRules: true }));
      const log2 = capture();
      const r2 = await runSyncCore(second.host, second.store, { force: true, changeLog: log2 });
      expect(r2.errors).toEqual([]);
      expect(second.saved.map((r) => [r.deleteIds ?? [], r.creates ?? [], r.updates ?? []])).toEqual([[['act-out', 'act-in'], [], []]]);
      expect(rows(second.activities).map((r) => r.type)).toEqual(['WITHDRAWAL', 'CREDIT']);
      expect(log2.entries()).toEqual([expect.objectContaining({
        kind: 'bookkeeping',
        subject: expect.objectContaining({ txKeys: [OUT, IN], description: 'CITI AUTOPAY PAYMENT / PAYMENT THANK YOU' }),
      })]);
    });

    it('the unlink entry names both legs and the new rows', async () => {
      const fh = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(OUT, IN), upstreamWriteRules: true }));
      const log = capture();
      await runSyncCore(fh.host, fh.store, { changeLog: log });
      const ids = [...fh.activities.values()].flat().map((r) => r.id).sort();
      const [entry] = log.entries();
      expect(entry.subject).toEqual(expect.objectContaining({ txKeys: [OUT, IN], description: 'CITI AUTOPAY PAYMENT / PAYMENT THANK YOU' }));
      expect([...(entry.subject.activityIds ?? [])].sort()).toEqual(ids);
    });

    it('re-creates a leg missing from the feed with the sign its stored type implies: money out, not in', async () => {
      const seed = twoAccounts({ syncOverrides: notTransfer(IN), upstreamWriteRules: true });
      seed.accountSet!.accounts[0].transactions = [{ id: 'tx-other', posted: epoch('2026-10-01T12:00:00Z'), amount: '-5.00', description: 'COFFEE' }];
      const fh = createFakeHost({ ...seed, existing: linkedRows() });
      const res = await runSyncCore(fh.host, fh.store, {});
      expect(res.errors).toEqual([]);
      expect(rows(fh.activities).map((r) => [r.type, r.group])).toEqual([['WITHDRAWAL', null], ['WITHDRAWAL', null], ['CREDIT', null]]);
    });

    it('a half-typed pair whose cash leg already is ordinary money: the exact-copy create is refused, nothing is deleted', async () => {
      const seed = twoAccounts({ syncOverrides: notTransfer(IN), upstreamWriteRules: true });
      const existing = linkedRows();
      existing.get('wf-a')![0] = { ...existing.get('wf-a')![0], activityType: 'WITHDRAWAL' };
      const fh = createFakeHost({ ...seed, existing });
      const before = snapshot(fh.activities);
      const res = await runSyncCore(fh.host, fh.store, {});
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0]).toContain('nothing deleted (still linked)');
      expect(snapshot(fh.activities)).toEqual(before);
    });

    it('one override on a linked pair unlinks both; the next sync leaves the other half as spending, unlinked — pinned as it is today', async () => {
      const first = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(IN), upstreamWriteRules: true }));
      await runSyncCore(first.host, first.store, {});
      expect(rows(first.activities).map((r) => r.type)).toEqual(['WITHDRAWAL', 'CREDIT']);
      const second = createFakeHost(twoAccounts({ existing: first.activities, syncOverrides: notTransfer(IN), upstreamWriteRules: true }));
      await runSyncCore(second.host, second.store, { force: true });
      expect(second.links).toEqual([]);
      expect(second.activities.get('wf-b')!.map((r) => r.activityType)).toEqual(['CREDIT']);
      expect(second.activities.get('wf-a')!.map((r) => r.activityType)).toEqual(['WITHDRAWAL']);
      expect(second.saved).toEqual([]);
    });

    /** Real Wealthfolio: deleting one half of a linked pair removes the partner too. */
    const cascading = (fh: ReturnType<typeof createFakeHost>, failDelete = false) => ({
      ...fh.host,
      saveMany: async (req: SaveManyRequest): Promise<SaveManyResult> => {
        if (!req.deleteIds) return fh.host.saveMany(req);
        if (failDelete) {
          fh.saved.push(req);
          return { created: [], updated: [], errors: [{ action: 'delete', message: 'locked' }] };
        }
        const all = [...fh.activities.values()].flat();
        const ids = new Set<string>(req.deleteIds);
        for (const id of req.deleteIds) {
          const r = all.find((x) => x.id === id);
          if (r?.sourceGroupId) for (const o of all) if (o.sourceGroupId === r.sourceGroupId) ids.add(o.id);
        }
        return fh.host.saveMany({ ...req, deleteIds: [...ids] });
      },
    });
    const unluckyIds = (): Map<string, HostActivity[]> => {
      const m = linkedRows();
      m.get('wf-b')![0] = { ...m.get('wf-b')![0], id: 'zz-in' };
      return m;
    };

    it('a heal pass never prunes the stale pair against its replacements, whatever the ids', async () => {
      const fh = createFakeHost(twoAccounts({ existing: unluckyIds(), syncOverrides: notTransfer(OUT, IN), upstreamWriteRules: true }));
      const r1 = await runSyncCore(cascading(fh, true), fh.store, {});
      expect(r1.errors[0]).toContain('Transfer-unlink incomplete');
      const r2 = await runSyncCore(cascading(fh), fh.store, { force: true, heal: true });
      expect(r2.errors).toEqual([]);
      expect(r2.prunedDuplicates).toEqual([]);
      expect(rows(fh.activities).map((r) => [r.account, r.type])).toEqual([['wf-a', 'WITHDRAWAL'], ['wf-b', 'CREDIT']]);
    });

    it('cleaning up the stale pair opens no drift alert', async () => {
      const seed = twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(OUT, IN), upstreamWriteRules: true });
      seed.valuations = new Map();
      const fh = createFakeHost(seed);
      await runSyncCore(cascading(fh, true), fh.store, {});
      // The valuation still counts the stale rows (Wealthfolio would too).
      seed.valuations!.set('wf-a', 464.6);
      await runSyncCore(cascading(fh), fh.store, { force: true });
      expect(await fh.store.getDriftAlerts()).toEqual({});
    });

    it('cleaning up a stale pair on an add-on clears BOTH legs from the ledger (override on the IN leg)', async () => {
      const fh = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(IN), upstreamWriteRules: true }));
      await fh.store.setLinkedGroups({ [OUT]: 'wf-transfer-9', [IN]: 'wf-transfer-9', 'tx-unrelated': 'wf-transfer-1' });
      const addon = (h: typeof fh.host) => ({ ...h, capabilities: { readsSourceGroupId: false } });
      await runSyncCore(addon(cascading(fh, true)), fh.store, {});
      expect(await fh.store.getLinkedGroups()).toHaveProperty(OUT);
      await runSyncCore(addon(cascading(fh)), fh.store, { force: true });
      expect(await fh.store.getLinkedGroups()).toEqual({ 'tx-unrelated': 'wf-transfer-1' });
      expect(rows(fh.activities).map((r) => r.type)).toEqual(['WITHDRAWAL', 'CREDIT']);
    });

    it('one override on the OUT leg: both unlink, then the card leg (no override) is held and re-created by the relink sweep — pinned as it is today', async () => {
      const first = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(OUT), upstreamWriteRules: true }));
      await runSyncCore(first.host, first.store, {});
      expect(rows(first.activities).map((r) => r.type)).toEqual(['WITHDRAWAL', 'CREDIT']);
      const second = createFakeHost(twoAccounts({ existing: first.activities, syncOverrides: notTransfer(OUT), upstreamWriteRules: true }));
      const log = capture();
      await runSyncCore(second.host, second.store, { force: true, changeLog: log });
      expect(second.links).toEqual([]);
      expect(second.activities.get('wf-a')!.map((r) => r.activityType)).toEqual(['WITHDRAWAL']);
      expect(second.activities.get('wf-b')!.map((r) => r.activityType)).toEqual(['TRANSFER_IN']);
      expect(log.entries().map((e) => e.summary)).toEqual([
        expect.stringContaining('Held PAYMENT THANK YOU'),
        'Re-created 1 old transfer row so it moves cash',
      ]);
    });

    for (const which of ['IN', 'OUT'] as const) {
      for (const [outId, inId] of [['act-out', 'act-in'], ['zz-out', 'act-in'], ['act-out', 'zz-in'], ['zz-out', 'zz-in']]) {
        it(`a heal after a failed delete, override on the ${which} leg only (ids ${outId}/${inId}): no row lost, nothing pruned`, async () => {
          const existing = linkedRows();
          existing.get('wf-a')![0] = { ...existing.get('wf-a')![0], id: outId };
          existing.get('wf-b')![0] = { ...existing.get('wf-b')![0], id: inId };
          const fh = createFakeHost(twoAccounts({ existing, syncOverrides: notTransfer(which === 'IN' ? IN : OUT), upstreamWriteRules: true }));
          const r1 = await runSyncCore(cascading(fh, true), fh.store, {});
          expect(r1.errors[0]).toContain('Transfer-unlink incomplete');
          const log = capture();
          const r2 = await runSyncCore(cascading(fh), fh.store, { force: true, heal: true, changeLog: log });
          expect(r2.errors).toEqual([]);
          expect(r2.prunedDuplicates).toEqual([]);
          expect(log.entries().filter((e) => e.kind === 'duplicate-removed')).toEqual([]);
          expect(fh.activities.get('wf-a')!.map((r) => r.activityType)).toEqual(['WITHDRAWAL']);
          expect(fh.activities.get('wf-b')).toHaveLength(1);
          expect([...fh.activities.values()].flat().filter((r) => r.sourceGroupId)).toEqual([]);
        });
      }
    }

    it('one override on the IN leg: cleaning up opens no drift alert, and real drift alerts on the following run', async () => {
      const seed = twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(IN), upstreamWriteRules: true });
      seed.valuations = new Map();
      const fh = createFakeHost(seed);
      await runSyncCore(cascading(fh, true), fh.store, {});
      seed.valuations!.set('wf-a', 464.6);
      await runSyncCore(cascading(fh), fh.store, { force: true });
      expect(await fh.store.getDriftAlerts()).toEqual({});
      await runSyncCore(cascading(fh), fh.store, { force: true });
      expect(Object.keys(await fh.store.getDriftAlerts())).toEqual(['sfin-1']);
    });

    it('counts pairs, not legs: one pair, two pairs, and a pair with one override alongside a pair with two', async () => {
      const two = (n: number, both: boolean) => {
        const accounts = [
          { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-13T12:00:00Z'), transactions: [] as any[] },
          { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-13T12:00:00Z'), transactions: [] as any[] },
        ];
        const existing = new Map<string, HostActivity[]>([['wf-a', []], ['wf-b', []]]);
        let o = emptySyncOverrides();
        for (let i = 0; i < n; i++) {
          const amt = 100 + i;
          accounts[0].transactions.push({ id: `o${i}`, posted: epoch('2026-10-08T12:00:00Z'), amount: `-${amt}.00`, description: `PAY ${i}` });
          accounts[1].transactions.push({ id: `i${i}`, posted: epoch('2026-10-09T12:00:00Z'), amount: `${amt}.00`, description: `PAYMENT ${i}` });
          existing.get('wf-a')!.push({ id: `ao${i}`, accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-10-08', amount: amt, comment: `PAY ${i} · o${i}`, sourceGroupId: `g${i}`, metadata: '{"flow":{"is_external":false}}' });
          existing.get('wf-b')!.push({ id: `bi${i}`, accountId: 'wf-b', activityType: 'TRANSFER_IN', date: '2026-10-09', amount: amt, comment: `PAYMENT ${i} · i${i}`, sourceGroupId: `g${i}`, metadata: '{"flow":{"is_external":false}}' });
          o = setTxOverride(o, accountTxKey('sfin-2', `i${i}`), 'notTransfer', NOW);
          if (both || i === 0) o = setTxOverride(o, accountTxKey('sfin-1', `o${i}`), 'notTransfer', NOW);
        }
        return twoAccounts({ accountSet: { errors: [], accounts }, existing, syncOverrides: o, upstreamWriteRules: true });
      };
      const summaries = async (n: number, both: boolean) => {
        const fh = createFakeHost(two(n, both));
        await runSyncCore(cascading(fh, true), fh.store, {});
        const log = capture();
        await runSyncCore(cascading(fh), fh.store, { force: true, changeLog: log });
        return log.entries().map((e) => e.summary);
      };
      const one = 'Unlinked a transfer you undid: re-created its 2 rows as spending or money in';
      expect(await summaries(1, true)).toEqual([one]);
      expect(await summaries(2, true)).toEqual([one, one]);
      expect(await summaries(2, false)).toEqual([one, one]);
    });

    // The one rule the cleanup obeys: an old linked leg is deleted only when, in
    // that same run, EVERY leg of its pair has a confirmed ordinary replacement
    // row (by row, not by tx key); a held placeholder is never a member; any
    // uncertainty skips the delete, the duplicate prune and drift.
    describe('the cleanup deletes only what it has confirmed', () => {
      const addon = <H extends { capabilities: { readsSourceGroupId: boolean } }>(h: H): H => ({ ...h, capabilities: { readsSourceGroupId: false } });
      const deletedIds = (fh: ReturnType<typeof createFakeHost>) => fh.saved.flatMap((r) => r.deleteIds ?? []);
      /** Every row each account holds, as [tx id, type]. */
      const held = (fh: ReturnType<typeof createFakeHost>) => ['wf-a', 'wf-b'].map((wf) =>
        (fh.activities.get(wf) ?? []).map((r) => [txIdFromComment(r.comment), r.activityType]));
      const unlinked = [{ account: 'wf-a', type: 'WITHDRAWAL', group: null }, { account: 'wf-b', type: 'CREDIT', group: null }];
      const shape = (fh: ReturnType<typeof createFakeHost>) => rows(fh.activities).map(({ account, type, group }) => ({ account, type, group }));
      /** The add-on's ledger for the pair (fresh each time: the sync edits the object it reads). */
      const ledger9 = () => ({ [OUT]: 'wf-transfer-9', [IN]: 'wf-transfer-9' });

      it('add-on, override on the OUT leg only: a cleanup that fails twice deletes nothing but the old linked pair', async () => {
        const fh = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(OUT), upstreamWriteRules: true }));
        await fh.store.setLinkedGroups(ledger9());
        await runSyncCore(addon(cascading(fh, true)), fh.store, {});
        const stale = snapshot(fh.activities);

        const r2 = await runSyncCore(addon(cascading(fh, true)), fh.store, { force: true });
        expect(r2.errors).toEqual([expect.stringContaining('Transfer-unlink cleanup incomplete (tx-out/tx-in)')]);
        // Left exactly as it was: the card's ordinary row was not re-held as a
        // placeholder while the old pair still stands next to it.
        expect(snapshot(fh.activities)).toEqual(stale);

        const r3 = await runSyncCore(addon(cascading(fh)), fh.store, { force: true });
        expect(r3.errors).toEqual([]);
        expect(new Set(deletedIds(fh))).toEqual(new Set(['act-out', 'act-in']));
        expect(shape(fh)).toEqual(unlinked);
        expect(await fh.store.getLinkedGroups()).toEqual({});
      });

      for (const host of ['companion', 'add-on'] as const) {
        it(`${host}, override on the OUT leg only: the card leg ages out of the feed before the cleanup lands — no row lost`, async () => {
          const fh = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(OUT), upstreamWriteRules: true }));
          const wrap = <H extends { capabilities: { readsSourceGroupId: boolean } }>(h: H) => (host === 'add-on' ? addon(h) : h);
          if (host === 'add-on') await fh.store.setLinkedGroups(ledger9());
          await runSyncCore(wrap(cascading(fh, true)), fh.store, {});
          await runSyncCore(wrap(cascading(fh, true)), fh.store, { force: true });

          const seed = twoAccounts({ existing: fh.activities, syncOverrides: notTransfer(OUT), upstreamWriteRules: true });
          seed.accountSet!.accounts[1].transactions = [];
          const later = createFakeHost(seed);
          if (host === 'add-on') await later.store.setLinkedGroups(await fh.store.getLinkedGroups());
          const r3 = await runSyncCore(wrap(cascading(later)), later.store, { force: true });
          expect(r3.errors).toEqual([]);
          expect(new Set(deletedIds(later))).toEqual(new Set(['act-out', 'act-in']));
          expect(shape(later)).toEqual(unlinked);
        });

        it(`${host}: a held placeholder next to a stale pair is never deleted, and the cleanup waits for an ordinary row`, async () => {
          const existing = linkedRows();
          existing.get('wf-a')!.push({ id: 'new-out', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-08', amount: 464.6, comment: 'CITI AUTOPAY PAYMENT · tx-out', sourceGroupId: null, assetId: '$CASH-USD' });
          existing.get('wf-b')!.push({ id: 'ph-in', accountId: 'wf-b', activityType: 'TRANSFER_IN', date: '2026-10-09', amount: 464.6, comment: '↔️ In-transit transfer · PAYMENT THANK YOU · tx-in', sourceGroupId: null, assetId: '$CASH-USD' });
          const seed = twoAccounts({ existing, syncOverrides: notTransfer(OUT), upstreamWriteRules: true });
          seed.accountSet!.accounts[1].transactions = []; // the card leg has aged out of the feed
          const fh = createFakeHost(seed);
          if (host === 'add-on') await fh.store.setLinkedGroups(ledger9());
          const before = snapshot(fh.activities);
          const r = await runSyncCore(host === 'add-on' ? addon(cascading(fh)) : cascading(fh), fh.store, { force: true, heal: true });
          expect(deletedIds(fh)).toEqual([]);
          expect(r.prunedDuplicates).toEqual([]);
          expect(snapshot(fh.activities)).toEqual(before);
          expect(r.errors).toEqual([
            'Transfer-unlink cleanup waiting (tx-out/tx-in): PAYMENT THANK YOU has no ordinary row of its own yet — the old linked rows stay for now, nothing was deleted',
          ]);
        });
      }

      for (const host of ['companion', 'add-on'] as const) {
        it(`${host}: a waiting pair moves on once the card's placeholder expires into an ordinary row`, async () => {
          const existing = linkedRows();
          existing.get('wf-a')!.push({ id: 'new-out', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-08', amount: 464.6, comment: 'CITI AUTOPAY PAYMENT · tx-out', sourceGroupId: null, assetId: '$CASH-USD' });
          existing.get('wf-b')!.push({ id: 'ph-in', accountId: 'wf-b', activityType: 'TRANSFER_IN', date: '2026-10-09', amount: 464.6, comment: '↔️ In-transit transfer · PAYMENT THANK YOU · tx-in', sourceGroupId: null, assetId: '$CASH-USD' });
          const wrap = <H extends { capabilities: { readsSourceGroupId: boolean } }>(h: H) => (host === 'add-on' ? addon(h) : h);
          const fh = createFakeHost(twoAccounts({ existing, syncOverrides: notTransfer(OUT), upstreamWriteRules: true }));
          if (host === 'add-on') await fh.store.setLinkedGroups(ledger9());
          // Still inside its 10 days: the card leg stays held, untouched — it is
          // not the linked leg, even where the ledger only knows its tx key.
          const before = snapshot(fh.activities);
          const r1 = await runSyncCore(wrap(cascading(fh)), fh.store, { force: true });
          expect(snapshot(fh.activities)).toEqual(before);
          expect(r1.errors).toEqual([expect.stringContaining('Transfer-unlink cleanup waiting (tx-out/tx-in)')]);

          vi.setSystemTime(new Date('2026-10-25T15:00:00Z'));
          const seed = twoAccounts({ existing: fh.activities, syncOverrides: notTransfer(OUT), upstreamWriteRules: true });
          for (const a of seed.accountSet!.accounts) a['balance-date'] = epoch('2026-10-25T12:00:00Z');
          const later = createFakeHost(seed);
          if (host === 'add-on') await later.store.setLinkedGroups(await fh.store.getLinkedGroups());
          await runSyncCore(wrap(cascading(later)), later.store, { force: true });
          expect(deletedIds(later)).toEqual([]);
          expect(later.activities.get('wf-b')!.find((r) => r.id === 'ph-in')!.activityType).toBe('CREDIT');

          const r3 = await runSyncCore(wrap(cascading(later)), later.store, { force: true });
          expect(r3.errors).toEqual([]);
          expect(new Set(deletedIds(later))).toEqual(new Set(['act-out', 'act-in']));
          expect(shape(later)).toEqual(unlinked);
        });
      }

      it('an old linked leg is never deleted while its other half has no ordinary row', async () => {
        const existing = linkedRows();
        existing.get('wf-a')!.push({ id: 'dup-out', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-08', amount: 464.6, comment: 'CITI AUTOPAY PAYMENT · tx-out', sourceGroupId: null });
        const seed = twoAccounts({ existing, syncOverrides: notTransfer(OUT), upstreamWriteRules: true });
        seed.accountSet!.accounts[1].transactions = [];
        const fh = createFakeHost(seed);
        const before = snapshot(fh.activities);
        const r = await runSyncCore(cascading(fh), fh.store, { force: true });
        expect(deletedIds(fh)).toEqual([]);
        expect(snapshot(fh.activities)).toEqual(before);
        expect(r.errors).toEqual([expect.stringContaining('Transfer-unlink cleanup waiting (tx-out/tx-in)')]);
      });

      it('a read that fails with a notTransfer override but no pair to hold still says why the run held back', async () => {
        // The pair was unlinked by an earlier sync; the overrides stay (365 days).
        const first = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(OUT, IN), upstreamWriteRules: true }));
        await runSyncCore(first.host, first.store, {});
        expect(first.activities.get('wf-a')!.map((r) => r.activityType)).toEqual(['WITHDRAWAL']);
        const fh = createFakeHost(twoAccounts({ existing: first.activities, syncOverrides: notTransfer(OUT, IN), upstreamWriteRules: true }));
        let failed = false;
        const blipping = { ...fh.host, listActivities: async (id: string) => {
          if (id === 'wf-b' && !failed) { failed = true; throw new Error('blip'); }
          return fh.host.listActivities(id);
        } };
        const r = await runSyncCore(blipping, fh.store, {});
        expect(failed).toBe(true);
        // Prune, relink and drift were all skipped for every account: the note says why.
        expect(r.errors).toEqual([HELD_FOR_A_READ]);
        expect(fh.saved).toEqual([]);
      });

      it('a read that fails before an unlink holds it for the run; the next sync unlinks', async () => {
        const fh = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(OUT, IN), upstreamWriteRules: true }));
        const reads = new Map<string, number>();
        const flaky = { ...fh.host, listActivities: async (id: string) => {
          reads.set(id, (reads.get(id) ?? 0) + 1);
          if (reads.get(id) === 1) throw new Error('read down');
          return fh.host.listActivities(id);
        } };
        const before = snapshot(fh.activities);
        const r1 = await runSyncCore(flaky, fh.store, {});
        expect(fh.saved).toEqual([]);
        expect(snapshot(fh.activities)).toEqual(before);
        expect(r1.errors).toEqual([HELD_FOR_A_READ]);
        const r2 = await runSyncCore(fh.host, fh.store, { force: true });
        expect(r2.errors).toEqual([]);
        expect(shape(fh)).toEqual(unlinked);
      });

      // The reviewer's read-blip matrix: a stale pair (an unlink whose delete
      // failed), then a heal whose pre-pass read of one account fails once.
      for (const host of ['companion', 'add-on'] as const) {
        for (const which of ['IN', 'OUT'] as const) {
          for (const blip of ['wf-a', 'wf-b'] as const) {
            for (const [outId, inId] of [['act-out', 'act-in'], ['zz-out', 'act-in'], ['act-out', 'zz-in'], ['zz-out', 'zz-in']]) {
              it(`${host}, override on ${which}, ${blip} unreadable once (ids ${outId}/${inId}): nothing deleted or pruned that run; the next sync cleans up`, async () => {
                const existing = linkedRows();
                existing.get('wf-a')![0] = { ...existing.get('wf-a')![0], id: outId };
                existing.get('wf-b')![0] = { ...existing.get('wf-b')![0], id: inId };
                const fh = createFakeHost(twoAccounts({ existing, syncOverrides: notTransfer(which === 'IN' ? IN : OUT), upstreamWriteRules: true }));
                const wrap = <H extends { capabilities: { readsSourceGroupId: boolean } }>(h: H) => (host === 'add-on' ? addon(h) : h);
                if (host === 'add-on') await fh.store.setLinkedGroups(ledger9());
                const r1 = await runSyncCore(wrap(cascading(fh, true)), fh.store, {});
                expect(r1.errors[0]).toContain('Transfer-unlink incomplete');
                const stale = snapshot(fh.activities);
                fh.saved.length = 0;

                let failed = false;
                const base = wrap(cascading(fh));
                const blipping = { ...base, listActivities: async (id: string) => {
                  if (id === blip && !failed) { failed = true; throw new Error('blip'); }
                  return base.listActivities(id);
                } };
                const r2 = await runSyncCore(blipping, fh.store, { force: true, heal: true });
                expect(deletedIds(fh)).toEqual([]);
                expect(r2.prunedDuplicates).toEqual([]);
                expect(held(fh)).toEqual([[['tx-out', 'TRANSFER_OUT'], ['tx-out', 'WITHDRAWAL']], [['tx-in', 'TRANSFER_IN'], ['tx-in', 'CREDIT']]]);
                expect(snapshot(fh.activities)).toEqual(stale);
                expect(r2.errors).toEqual([HELD_FOR_A_READ]);

                const r3 = await runSyncCore(wrap(cascading(fh)), fh.store, { force: true });
                expect(r3.errors).toEqual([]);
                expect(shape(fh)).toEqual(unlinked);
                if (host === 'add-on') expect(await fh.store.getLinkedGroups()).toEqual({});
              });
            }
          }
        }
      }
    });
  });

  it('one override on the card leg, the cash leg naming the card: the cash leg stays a transfer and is held (1.63, A)', async () => {
    // Before 1.63 the cash leg became ordinary spending. Now its text names a
    // connected account ("CITI" and a card called "Citi"), so it is the paying
    // half of a transfer whose other half was undone: held, as the card leg is
    // when the override sits on the cash side. Undo marks BOTH legs, so this
    // takes a one-sided override. The first sync unlinks; the second retypes
    // the stored WITHDRAWAL (the relink sweep re-creates it asset-free, without
    // the in-transit marker); the third marks it.
    const seed = twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(IN), upstreamWriteRules: true });
    seed.accountSet!.accounts[1].name = 'Citi';
    const fh = createFakeHost(seed);
    for (let run = 0; run < 3; run += 1) {
      const r = await runSyncCore(fh.host, fh.store, run === 0 ? {} : { force: true });
      expect(r.errors).toEqual([]);
    }
    expect(fh.links).toEqual([]);
    expect(fh.activities.get('wf-b')!.map((r) => r.activityType)).toEqual(['CREDIT']);
    expect(fh.activities.get('wf-a')!.map((r) => [r.activityType, r.comment])).toEqual([
      ['TRANSFER_OUT', `${IN_TRANSIT_COMMENT_PREFIX}CITI AUTOPAY PAYMENT · tx-out`],
    ]);
  });
});
