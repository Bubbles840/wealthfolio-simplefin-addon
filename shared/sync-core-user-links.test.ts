import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import { IN_TRANSIT_COMMENT_PREFIX } from './reconcile.js';
import type { HostActivity } from './sync-host.js';

const NOW = new Date('2027-03-15T15:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const epoch = (iso: string) => Date.parse(iso) / 1000;
/** What Wealthfolio stores on both legs of a link made in its transfer dialog. */
const LINKED = '{"flow":{"is_external":false}}';

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
    comment: 'Closing cheque to Savings', sourceGroupId: 'g-hand', metadata: LINKED }]],
  ['wf-b', [{ id: 'act-in', accountId: 'wf-b', activityType: 'TRANSFER_IN', date: '2027-03-10', amount: 150,
    comment: 'CHECK RECEIVED · tx-chk', sourceGroupId: 'g-hand', metadata: LINKED }]],
]);

const row = (fh: ReturnType<typeof createFakeHost>, account: string, id: string) =>
  fh.activities.get(account)!.find((r) => r.id === id)!;
/** The updates written to one row, across every sync so far. */
const writesTo = (fh: ReturnType<typeof createFakeHost>, id: string) =>
  fh.saved.flatMap((req) => req.updates ?? []).filter((u) => u.id === id).length;

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
      comment: 'Moved to Savings', sourceGroupId: 'g-hand', metadata: LINKED }]],
    ['wf-b', [{ id: 'act-in', accountId: 'wf-b', activityType: 'TRANSFER_IN', date: '2027-03-10', amount: 150,
      comment: `${IN_TRANSIT_COMMENT_PREFIX}ONLINE TRANSFER FROM CHK · tx-chk`, sourceGroupId: 'g-hand', metadata: LINKED }]],
  ]);

  for (const readsSourceGroupId of [true, false]) {
    const who = readsSourceGroupId ? 'companion' : 'add-on';

    it(`keeps a placeholder linked by hand linked, and clears its in-transit note once (${who})`, async () => {
      // Kept, the note would leave the account "in flight" for good (no balance check). Clearing
      // it is one update, whose note Wealthfolio copies onto the partner once.
      const fh = createFakeHost(seed(placeholderLinked()));
      const host = { ...fh.host, capabilities: { ...fh.host.capabilities, readsSourceGroupId } };
      await runSyncCore(host, fh.store, {});
      expect(row(fh, 'wf-b', 'act-in')).toMatchObject({ activityType: 'TRANSFER_IN', sourceGroupId: 'g-hand', comment: 'CHECK RECEIVED · tx-chk' });
      expect(writesTo(fh, 'act-in')).toBe(1);
      for (const days of [6, 12]) {
        vi.setSystemTime(new Date(NOW.getTime() + days * DAY_MS));
        await runSyncCore(host, fh.store, { force: true });
      }
      expect(writesTo(fh, 'act-in')).toBe(1);
      expect(row(fh, 'wf-b', 'act-in')).toMatchObject({ activityType: 'TRANSFER_IN', sourceGroupId: 'g-hand' });
      expect(row(fh, 'wf-a', 'act-out')).toMatchObject({ activityType: 'TRANSFER_OUT', sourceGroupId: 'g-hand' });
    });

    it(`leaves a placeholder linked by hand alone outside the download (${who})`, async () => {
      const fh = createFakeHost(seed(placeholderLinked(), { accountSet: { errors: [], accounts: [
        { id: 'sfin-2', name: 'Savings', currency: 'USD', balance: '150.00', 'balance-date': epoch('2027-03-15T12:00:00Z'), transactions: [] },
      ] } }));
      const host = { ...fh.host, capabilities: { ...fh.host.capabilities, readsSourceGroupId } };
      await runSyncCore(host, fh.store, {});
      vi.setSystemTime(new Date(NOW.getTime() + 12 * DAY_MS));
      await runSyncCore(host, fh.store, { force: true });
      expect(fh.activities.get('wf-b')).toEqual(placeholderLinked().get('wf-b'));
      expect(fh.activities.get('wf-a')).toEqual(placeholderLinked().get('wf-a'));
    });

    it(`keeps a card payment linked by hand, and clears its in-transit note once (${who})`, async () => {
      // A card's inflow placeholder is a TRANSFER_IN, so it can be linked by hand to a bank kept by hand.
      const card = (): Map<string, HostActivity[]> => new Map([
        ['wf-a', [{ id: 'act-out', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2027-03-10', amount: 150,
          comment: 'Card payment', sourceGroupId: 'g-hand', metadata: LINKED }]],
        ['wf-c', [{ id: 'act-in', accountId: 'wf-c', activityType: 'TRANSFER_IN', date: '2027-03-10', amount: 150,
          comment: `${IN_TRANSIT_COMMENT_PREFIX}PAYMENT THANK YOU · tx-pay`, sourceGroupId: 'g-hand', metadata: LINKED }]],
      ]);
      const fh = createFakeHost(seed(card(), {
        accountSet: { errors: [], accounts: [
          { id: 'sfin-c', name: 'Card', currency: 'USD', balance: '-57.60', 'balance-date': epoch('2027-03-15T12:00:00Z'),
            transactions: [{ id: 'tx-pay', posted: epoch('2027-03-10T12:00:00Z'), amount: '150.00', description: 'PAYMENT THANK YOU' }] },
        ] },
        mapping: { 'sfin-c': 'wf-c' },
        accountTypes: { 'wf-a': 'CASH', 'wf-c': 'CREDIT_CARD' },
        accountNames: { 'wf-a': 'Checking', 'wf-c': 'Card' },
      }));
      const host = { ...fh.host, capabilities: { ...fh.host.capabilities, readsSourceGroupId } };
      await runSyncCore(host, fh.store, {});
      vi.setSystemTime(new Date(NOW.getTime() + 12 * DAY_MS));
      await runSyncCore(host, fh.store, { force: true });
      expect(row(fh, 'wf-c', 'act-in')).toMatchObject({ activityType: 'TRANSFER_IN', sourceGroupId: 'g-hand', comment: 'PAYMENT THANK YOU · tx-pay' });
      expect(writesTo(fh, 'act-in')).toBe(1);
    });

    it(`keeps the leg as a transfer and its partner's note, past the ten days too (${who})`, async () => {
      const fh = createFakeHost(seed(linkedByHand()));
      const host = { ...fh.host, capabilities: { ...fh.host.capabilities, readsSourceGroupId } };
      await runSyncCore(host, fh.store, {});
      await runSyncCore(host, fh.store, { force: true });
      vi.setSystemTime(new Date(NOW.getTime() + 12 * DAY_MS));
      await runSyncCore(host, fh.store, { force: true });
      expect(writesTo(fh, 'act-in')).toBe(0);
      expect(row(fh, 'wf-b', 'act-in')).toMatchObject({ activityType: 'TRANSFER_IN', sourceGroupId: 'g-hand' });
      expect(row(fh, 'wf-a', 'act-out')).toMatchObject({ comment: 'Closing cheque to Savings', sourceGroupId: 'g-hand' });
    });
  }
});
