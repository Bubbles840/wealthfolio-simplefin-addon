import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChangeEntry, ChangeLogSink } from './change-entries.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import { emptySyncOverrides, setAccountOverride, setTxOverride, type SyncOverrides } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-13T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;

function capture(): ChangeLogSink & { entries: () => ChangeEntry[] } {
  const batches: ChangeEntry[][] = [];
  return {
    writer: 'companion', run: 'cRUN1',
    append: vi.fn(async (entries: ChangeEntry[]) => { batches.push(entries); }),
    entries: () => batches.flat(),
  };
}

const checking = (transactions: Array<{ id: string; posted: number; amount: string; description: string }>, balance = '0'): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [{
    id: 'sfin-1', name: 'Checking', currency: 'USD', balance, 'balance-date': epoch('2026-10-13T12:00:00Z'), transactions,
  }] },
  mapping: { 'sfin-1': 'wf-a' },
  accountTypes: { 'wf-a': 'CASH' },
  accountNames: { 'wf-a': 'Checking' },
});

const with_ = (edit: (o: SyncOverrides) => SyncOverrides) => edit(emptySyncOverrides());

describe('runSyncCore — the overrides Undo leaves behind', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const duplicated = (syncOverrides?: SyncOverrides): FakeHostSeed => ({
    ...checking([{ id: 'tx-1', posted: epoch('2026-10-01T12:00:00Z'), amount: '-25.00', description: 'NETFLIX.COM' }]),
    existing: new Map([['wf-a', [
      { id: 'act-2', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-01', amount: 25, comment: 'NETFLIX.COM · tx-1', sourceGroupId: null },
      { id: 'act-1', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-01', amount: 25, comment: 'NETFLIX.COM · tx-1', sourceGroupId: null },
    ]]]),
    ...(syncOverrides ? { syncOverrides } : {}),
  });

  it('keepDuplicate: the prune leaves every copy of that transaction', async () => {
    const plain = createFakeHost(duplicated());
    expect((await runSyncCore(plain.host, plain.store, { heal: true })).prunedDuplicates.map((p) => p.wfId)).toEqual(['act-2']);

    const kept = createFakeHost(duplicated(with_((o) => setTxOverride(o, accountTxKey('sfin-1', 'tx-1'), 'keepDuplicate', NOW))));
    const log = capture();
    const result = await runSyncCore(kept.host, kept.store, { heal: true, changeLog: log });
    expect(result.prunedDuplicates).toEqual([]);
    expect(kept.activities.get('wf-a')!.map((r) => r.id).sort()).toEqual(['act-1', 'act-2']);
    expect(log.entries().filter((e) => e.kind === 'duplicate-removed')).toEqual([]);
  });

  it('keepDuplicate is per account: the same id in another account is still pruned', async () => {
    const seed = duplicated(with_((o) => setTxOverride(o, accountTxKey('sfin-OTHER', 'tx-1'), 'keepDuplicate', NOW)));
    const { host, store } = createFakeHost(seed);
    expect((await runSyncCore(host, store, { heal: true })).prunedDuplicates.map((p) => p.wfId)).toEqual(['act-2']);
  });

  const amazon = (syncOverrides?: SyncOverrides): FakeHostSeed => ({
    ...checking([{ id: 'tx-amz', posted: epoch('2026-08-06T00:00:00Z'), amount: '-21.18', description: 'AMAZON.COM*MB3T81' }]),
    existing: new Map([['wf-a', [{
      id: 'act-amz', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-08-06', amount: 21.18,
      comment: 'AMAZON.COM*MB3T81 · tx-amz', sourceGroupId: null,
    }]]]),
    amazonLedger: {
      '113-0728509-1925031|shipped|2118': {
        orderId: '113-0728509-1925031', kind: 'shipped', totalCents: 2118, itemCount: 1, labels: ['Lawn & Garden'], emailDate: '2026-08-04',
      },
    },
    ...(syncOverrides ? { syncOverrides } : {}),
  });

  it('noAmazonLabel: the late label leaves the note, and the order is still consumed', async () => {
    const plain = createFakeHost(amazon());
    await runSyncCore(plain.host, plain.store, {});
    expect(plain.activities.get('wf-a')![0].comment).toBe('AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · tx-amz');

    const off = createFakeHost(amazon(with_((o) => setTxOverride(o, accountTxKey('sfin-1', 'tx-amz'), 'noAmazonLabel', NOW))));
    const log = capture();
    await runSyncCore(off.host, off.store, { changeLog: log });
    expect(off.activities.get('wf-a')![0].comment).toBe('AMAZON.COM*MB3T81 · tx-amz');
    expect(log.entries()).toEqual([]);
    expect(off.amazon()['113-0728509-1925031|shipped|2118'].consumedBy).toBe(accountTxKey('sfin-1', 'tx-amz'));
  });

  it('noAmazonLabel: a new charge imports with the bank’s own words', async () => {
    const seed = amazon(with_((o) => setTxOverride(o, accountTxKey('sfin-1', 'tx-amz'), 'noAmazonLabel', NOW)));
    const { host, store, activities } = createFakeHost({ ...seed, existing: new Map() });
    await runSyncCore(host, store, {});
    expect(activities.get('wf-a')![0].comment).toBe('AMAZON.COM*MB3T81 · tx-amz');
  });

  const drifting = (syncOverrides?: SyncOverrides): FakeHostSeed => ({
    ...checking([], '100.00'),
    valuations: new Map([['wf-a', 0]]),
    autoHeal: true,
    autoAdjust: true,
    // Under the $100 alert threshold, so the plug is not held back as young.
    driftAlertThreshold: 500,
    ...(syncOverrides ? { syncOverrides } : {}),
  });

  it('noAutoCorrect: no plug, and the drift is still reported', async () => {
    const plain = createFakeHost(drifting());
    await runSyncCore(plain.host, plain.store, { heal: true });
    expect(plain.imported.flat().map((r) => r.comment)).toContain('Balance adjustment · sfin-1 · 2026-10-13');

    const off = createFakeHost(drifting(with_((o) => setAccountOverride(o, 'sfin-1', 'noAutoCorrect', NOW))));
    const log = capture();
    await runSyncCore(off.host, off.store, { heal: true, changeLog: log });
    expect(off.imported.flat().map((r) => r.comment)).not.toContain('Balance adjustment · sfin-1 · 2026-10-13');
    expect(log.entries().filter((e) => e.kind === 'balance-correction')).toEqual([]);
    const balances = await off.store.getAccountBalances() as Record<string, { drift: number | null; measured?: boolean }>;
    expect(balances['sfin-1']).toMatchObject({ drift: 100, measured: true });
  });

  it('an empty document changes nothing about a run', async () => {
    const plain = createFakeHost(duplicated());
    const withEmpty = createFakeHost(duplicated(emptySyncOverrides()));
    const a = await runSyncCore(plain.host, plain.store, { heal: true });
    const b = await runSyncCore(withEmpty.host, withEmpty.store, { heal: true });
    expect(b).toEqual(a);
    expect(withEmpty.saved).toEqual(plain.saved);
  });

  it('a store whose overrides read fails syncs as if there were none', async () => {
    const plain = createFakeHost(duplicated());
    const failing = createFakeHost(duplicated());
    failing.store.getSyncOverrides = async () => { throw new Error('ECONNRESET'); };
    const a = await runSyncCore(plain.host, plain.store, { heal: true });
    const b = await runSyncCore(failing.host, failing.store, { heal: true });
    expect(b).toEqual(a);
  });
});
