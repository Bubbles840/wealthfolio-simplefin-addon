import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChangeEntry, ChangeLogSink } from './change-entries.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
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

const notTransfer = (...keys: string[]): SyncOverrides =>
  keys.reduce((o, k) => setTxOverride(o, k, 'notTransfer', NOW), emptySyncOverrides());

/** A Citi payment: out of Checking, into the card, both in this run's feed. */
const twoAccounts = (extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-13T12:00:00Z'),
      transactions: [{ id: 'tx-out', posted: epoch('2026-10-08T12:00:00Z'), amount: '-464.60', description: 'CITI AUTOPAY PAYMENT' }] },
    { id: 'sfin-2', name: 'Citi', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-13T12:00:00Z'),
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
      why: 'You undid the transfer',
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
        'Left CITI AUTOPAY PAYMENT for the companion to unlink — it was linked by the companion.',
        'Left PAYMENT THANK YOU for the companion to unlink — it was linked by the companion.',
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
      expect(result.errors[0]).toContain('wf-a 2026-10-08 464.60 "CITI AUTOPAY PAYMENT · tx-out"');
      expect(result.errors[0]).toContain('wf-b 2026-10-09 464.60 "PAYMENT THANK YOU · tx-in"');
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
  });
});
