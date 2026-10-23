import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import { IN_TRANSIT_COMMENT_PREFIX } from './reconcile.js';
import type { HostActivity } from './sync-host.js';

const NOW = new Date('2027-03-15T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;

/** Savings is synced; Checking is not (closed, or kept by hand). */
const seed = (rows: Map<string, HostActivity[]>, extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-2', name: 'Savings', currency: 'USD', balance: '150.00', 'balance-date': epoch('2027-03-15T12:00:00Z'),
      transactions: [{ id: 'tx-chk', posted: epoch('2027-03-10T12:00:00Z'), amount: '150.00', description: 'CHECK RECEIVED' }] },
  ] },
  mapping: { 'sfin-2': 'wf-b' },
  accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CASH' },
  accountNames: { 'wf-a': 'Checking', 'wf-b': 'Savings' },
  upstreamWriteRules: true,
  existing: rows,
  ...extra,
});

/** The person typed the synced deposit as a transfer and linked it to a row they keep by hand. */
const linkedByHand = (): Map<string, HostActivity[]> => new Map([
  ['wf-a', [{ id: 'act-out', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2027-03-10', amount: 150,
    comment: 'Closing cheque to Savings', sourceGroupId: 'g-hand', metadata: null }]],
  ['wf-b', [{ id: 'act-in', accountId: 'wf-b', activityType: 'TRANSFER_IN', date: '2027-03-10', amount: 150,
    comment: 'CHECK RECEIVED · tx-chk', sourceGroupId: 'g-hand', metadata: null }]],
]);

const row = (fh: ReturnType<typeof createFakeHost>, account: string, id: string) =>
  fh.activities.get(account)!.find((r) => r.id === id)!;

describe('runSyncCore — a transfer the person linked themselves', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** An in-transit placeholder the sync was holding, typed and linked by hand to a row kept by hand. */
  const placeholderLinked = (): Map<string, HostActivity[]> => new Map([
    ['wf-a', [{ id: 'act-out', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2027-03-10', amount: 150,
      comment: 'Moved to Savings', sourceGroupId: 'g-hand', metadata: null }]],
    ['wf-b', [{ id: 'act-in', accountId: 'wf-b', activityType: 'TRANSFER_IN', date: '2027-03-10', amount: 150,
      comment: `${IN_TRANSIT_COMMENT_PREFIX}ONLINE TRANSFER FROM CHK · tx-chk`, sourceGroupId: 'g-hand', metadata: null }]],
  ]);

  for (const readsSourceGroupId of [true, false]) {
    const who = readsSourceGroupId ? 'companion' : 'add-on';

    it(`leaves a placeholder linked by hand as it is, in the download or not (${who})`, async () => {
      for (const inFeed of [true, false]) {
        const fh = createFakeHost(seed(placeholderLinked(), inFeed ? {} : { accountSet: { errors: [], accounts: [
          { id: 'sfin-2', name: 'Savings', currency: 'USD', balance: '150.00', 'balance-date': epoch('2027-03-15T12:00:00Z'), transactions: [] },
        ] } }));
        const host = { ...fh.host, capabilities: { ...fh.host.capabilities, readsSourceGroupId } };
        await runSyncCore(host, fh.store, {});
        await runSyncCore(host, fh.store, { force: true });
        expect(fh.activities.get('wf-b')).toEqual(placeholderLinked().get('wf-b'));
        expect(fh.activities.get('wf-a')).toEqual(placeholderLinked().get('wf-a'));
      }
    });

    it(`keeps the leg as a transfer and its partner's note (${who})`, async () => {
      const fh = createFakeHost(seed(linkedByHand()));
      const host = { ...fh.host, capabilities: { ...fh.host.capabilities, readsSourceGroupId } };
      await runSyncCore(host, fh.store, {});
      await runSyncCore(host, fh.store, { force: true });
      expect(row(fh, 'wf-b', 'act-in')).toMatchObject({ activityType: 'TRANSFER_IN', sourceGroupId: 'g-hand' });
      expect(row(fh, 'wf-a', 'act-out')).toMatchObject({ comment: 'Closing cheque to Savings', sourceGroupId: 'g-hand' });
    });
  }
});
