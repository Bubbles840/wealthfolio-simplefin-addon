import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runSyncCore, TRANSFER_GROUP_PREFIX, VALUATION_POLL } from './sync-core.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import type { HostActivity, SyncHost } from './sync-host.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { Relink } from './relink.js';

/**
 * A SimpleFin connection removed and added again: the same bank account comes
 * back under a new id, mapped to the same Wealthfolio account, with every
 * transaction under a new id too. The sync acts on it only once the person has
 * confirmed it; the shape alone is also two feeds deliberately mapped to one
 * account, one of them missing for a run.
 */
describe('a re-linked connection', () => {
  const NOW = new Date('2027-05-20T12:00:00Z');
  const nowSec = NOW.getTime() / 1000;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
  });
  afterEach(() => { vi.useRealTimers(); });

  // Noon UTC, so each is the same calendar day in every zone the suite runs in.
  const posted = (daysAgo: number) => nowSec - daysAgo * 86_400;
  const day = (daysAgo: number) => new Date(posted(daysAgo) * 1000).toISOString().slice(0, 10);

  const stored = (id: string, comment: string, amount: string, daysAgo: number, extra: Partial<HostActivity> = {}): HostActivity => ({
    id, accountId: 'wf-chk', activityType: parseFloat(amount) < 0 ? 'WITHDRAWAL' : 'DEPOSIT',
    date: day(daysAgo), amount: String(Math.abs(parseFloat(amount))), comment, ...extra,
  });

  const CONFIRMED: Relink = { wfAccountId: 'wf-chk', newId: 'sfin-new', oldIds: ['sfin-old'] };
  const confirmed = { relinkDecisions: { confirmed: [CONFIRMED], declined: [] } };

  const newFeed = () => ({
    id: 'sfin-new', name: 'Checking', currency: 'USD', balance: '1000.00', 'balance-date': posted(0),
    transactions: [
      { id: 'TRN-n1', posted: posted(5), amount: '-4.50', description: 'COFFEE SHOP' },
      { id: 'TRN-n2', posted: posted(4), amount: '2500.00', description: 'EMPLOYER PAYROLL' },
      { id: 'TRN-n3', posted: posted(1), amount: '-60.00', description: 'GROCERY STORE' },
    ],
  });

  /** The old connection imported the coffee and the paycheck; the new download
   *  reports both again under new ids, plus a purchase made since. */
  const reconnected = (existing: HostActivity[], extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
    accountSet: { errors: [], accounts: [newFeed()] },
    mapping: { 'sfin-old': 'wf-chk', 'sfin-new': 'wf-chk' },
    existing: new Map([['wf-chk', existing]]),
    ...extra,
  });

  const oldRows = () => [
    stored('a-coffee', 'COFFEE SHOP · TRN-o1', '-4.50', 5),
    stored('a-pay', 'EMPLOYER PAYROLL · TRN-o2', '2500.00', 4),
  ];
  const copy = (extra: Partial<HostActivity> = {}) => stored('b-coffee', 'COFFEE SHOP · TRN-n1', '-4.50', 5, extra);
  const comments = (rows: HostActivity[] | undefined) => (rows ?? []).map((r) => r.comment).sort();

  describe('confirmed', () => {
    it('does not import the overlap a second time, and leaves the old rows as they are', async () => {
      const { host, store, activities } = createFakeHost(reconnected(oldRows(), confirmed));
      await runSyncCore(host, store, { force: true });

      expect(comments(activities.get('wf-chk'))).toEqual([
        'COFFEE SHOP · TRN-o1', 'EMPLOYER PAYROLL · TRN-o2', 'GROCERY STORE · TRN-n3',
      ]);
    });

    it('never rewrites an adopted row, even when a rule retypes it', async () => {
      const seed = reconnected([stored('a-coffee', 'COFFEE SHOP · Dinner split · TRN-o1', '-4.50', 5)], {
        ...confirmed, mappingRules: [{ pattern: 'COFFEE', matchType: 'contains', activityType: 'FEE' }],
      });
      const { host, store, activities, saved } = createFakeHost(seed);
      await runSyncCore(host, store, { force: true });

      expect(activities.get('wf-chk')?.find((r) => r.id === 'a-coffee')).toMatchObject({ comment: 'COFFEE SHOP · Dinner split · TRN-o1', activityType: 'WITHDRAWAL' });
      expect(saved.flatMap((s) => (s.updates ?? []).map((u) => u.id))).not.toContain('a-coffee');
    });

    it('a Deep scan deletes a copy imported before, keeps the old row, and a second one writes nothing', async () => {
      const { host, store, activities, saved } = createFakeHost(reconnected([...oldRows(), copy()], confirmed));
      const result = await runSyncCore(host, store, { heal: true });

      expect(activities.get('wf-chk')?.map((r) => r.id)).not.toContain('b-coffee');
      expect(activities.get('wf-chk')?.map((r) => r.id)).toEqual(expect.arrayContaining(['a-coffee', 'a-pay']));
      expect(result.prunedDuplicates.map((d) => d.wfId)).toEqual(['b-coffee']);

      const before = saved.length;
      await runSyncCore(host, store, { heal: true });
      const writes = saved.slice(before).filter((s) => (s.creates?.length ?? 0) + (s.updates?.length ?? 0) + (s.deleteIds?.length ?? 0) > 0);
      expect(writes).toEqual([]);
    });

    it('deletes every copy of one transaction, so the duplicate prune never sees the old row', async () => {
      const seed = reconnected([...oldRows(), copy(), stored('c-coffee', 'COFFEE SHOP · TRN-n1', '-4.50', 5)], confirmed);
      const { host, store, activities } = createFakeHost(seed);
      const result = await runSyncCore(host, store, { heal: true });

      expect(result.prunedDuplicates.map((d) => d.wfId).sort()).toEqual(['b-coffee', 'c-coffee']);
      expect(activities.get('wf-chk')?.map((r) => r.id)).toContain('a-coffee');
    });

    it('a routine sync deletes nothing', async () => {
      const { host, store, activities } = createFakeHost(reconnected([...oldRows(), copy()], confirmed));
      const result = await runSyncCore(host, store, { force: true });

      expect(result.prunedDuplicates).toEqual([]);
      expect(activities.get('wf-chk')?.map((r) => r.id)).toContain('b-coffee');
    });

    it('keeps a linked new copy and deletes the unlinked old row, keyed under the old id for Undo', async () => {
      const { host, store, activities } = createFakeHost(reconnected([...oldRows(), copy({ sourceGroupId: 'g1' })], confirmed));
      const result = await runSyncCore(host, store, { heal: true });

      expect(activities.get('wf-chk')?.map((r) => r.id)).toContain('b-coffee');
      expect(activities.get('wf-chk')?.map((r) => r.id)).not.toContain('a-coffee');
      expect(result.prunedDuplicates).toEqual([expect.objectContaining({ wfId: 'a-coffee', sfinAccountId: 'sfin-old', txId: 'TRN-o1' })]);
    });

    it('reads links from the ledger on a host that cannot read groups (the add-on)', async () => {
      // The old row is linked, recorded under its OLD key; the copy is linked too.
      const fake = createFakeHost(reconnected([...oldRows(), copy()], confirmed));
      const host: SyncHost = { ...fake.host, capabilities: { readsSourceGroupId: false } };
      await fake.store.setLinkedGroups({ [accountTxKey('sfin-old', 'TRN-o1')]: `${TRANSFER_GROUP_PREFIX}1`, [accountTxKey('sfin-new', 'TRN-n1')]: `${TRANSFER_GROUP_PREFIX}2` });
      const result = await runSyncCore(host, fake.store, { heal: true });

      expect(result.prunedDuplicates).toEqual([]);
      expect(fake.activities.get('wf-chk')?.map((r) => r.id)).toEqual(expect.arrayContaining(['a-coffee', 'b-coffee']));
    });

    it('keeps a copy the ledger says is linked on the add-on, and deletes the old row', async () => {
      const fake = createFakeHost(reconnected([...oldRows(), copy()], confirmed));
      const host: SyncHost = { ...fake.host, capabilities: { readsSourceGroupId: false } };
      await fake.store.setLinkedGroups({ [accountTxKey('sfin-new', 'TRN-n1')]: `${TRANSFER_GROUP_PREFIX}1` });
      const result = await runSyncCore(host, fake.store, { heal: true });

      expect(result.prunedDuplicates.map((d) => d.wfId)).toEqual(['a-coffee']);
    });

    it('honours a kept duplicate (Undo) under the old key or the new one', async () => {
      for (const key of [accountTxKey('sfin-old', 'TRN-o1'), accountTxKey('sfin-new', 'TRN-n1')]) {
        const syncOverrides = setTxOverride(emptySyncOverrides(), key, 'keepDuplicate', NOW);
        const { host, store, activities } = createFakeHost(reconnected([...oldRows(), copy()], { ...confirmed, syncOverrides }));
        const result = await runSyncCore(host, store, { heal: true });

        expect(result.prunedDuplicates).toEqual([]);
        expect(activities.get('wf-chk')?.map((r) => r.id)).toEqual(expect.arrayContaining(['a-coffee', 'b-coffee']));
      }
    });

    it('leaves an old row it cannot key for Undo (two old ids) when the copy is the one kept', async () => {
      const seed = reconnected([...oldRows(), copy({ sourceGroupId: 'g1' })], {
        relinkDecisions: { confirmed: [{ ...CONFIRMED, oldIds: ['sfin-old', 'sfin-older'] }], declined: [] },
        mapping: { 'sfin-old': 'wf-chk', 'sfin-older': 'wf-chk', 'sfin-new': 'wf-chk' },
      });
      const { host, store } = createFakeHost(seed);
      const result = await runSyncCore(host, store, { heal: true });

      expect(result.prunedDuplicates).toEqual([]);
    });

    it('keeps the old id retired when it reports again: nothing is imported from it twice', async () => {
      const seed = reconnected(oldRows(), confirmed);
      seed.accountSet!.accounts.push({
        id: 'sfin-old', name: 'Checking', currency: 'USD', balance: '1000.00', 'balance-date': posted(0),
        transactions: [
          { id: 'TRN-o1', posted: posted(5), amount: '-4.50', description: 'COFFEE SHOP' },
          { id: 'TRN-o9', posted: posted(2), amount: '-12.00', description: 'BOOKSTORE' },
        ],
      });
      const { host, store, activities } = createFakeHost(seed);
      await runSyncCore(host, store, { force: true });

      expect(comments(activities.get('wf-chk'))).toEqual([
        'COFFEE SHOP · TRN-o1', 'EMPLOYER PAYROLL · TRN-o2', 'GROCERY STORE · TRN-n3',
      ]);
    });

    it('roles reversed (the new id misses a run, the old one reports): nothing deleted, nothing imported from the old id', async () => {
      const seed = reconnected([...oldRows(), copy(), stored('n-groc', 'GROCERY STORE · TRN-n3', '-60.00', 1)], confirmed);
      seed.accountSet!.accounts = [{
        id: 'sfin-old', name: 'Checking', currency: 'USD', balance: '1000.00', 'balance-date': posted(0),
        transactions: [{ id: 'TRN-o3', posted: posted(1), amount: '-60.00', description: 'GROCERY STORE' }],
      }];
      const { host, store, activities } = createFakeHost(seed);
      const result = await runSyncCore(host, store, { heal: true });

      expect(result.prunedDuplicates).toEqual([]);
      expect(activities.get('wf-chk')?.map((r) => r.id).sort()).toEqual(['a-coffee', 'a-pay', 'b-coffee', 'n-groc']);
    });

    it('pairs off two identical same-day charges, and deletes only their copies', async () => {
      const seed = reconnected([
        stored('a-1', 'PARKING · TRN-o1', '-3.00', 2), stored('a-2', 'PARKING · TRN-o2', '-3.00', 2),
        stored('b-1', 'PARKING · TRN-n1', '-3.00', 2),
      ], confirmed);
      seed.accountSet!.accounts[0].transactions = [
        { id: 'TRN-n1', posted: posted(2), amount: '-3.00', description: 'PARKING' },
        { id: 'TRN-n2', posted: posted(2), amount: '-3.00', description: 'PARKING' },
      ];
      const { host, store, activities } = createFakeHost(seed);
      const result = await runSyncCore(host, store, { heal: true });

      expect(result.prunedDuplicates.map((d) => d.wfId)).toEqual(['b-1']);
      expect(activities.get('wf-chk')?.map((r) => r.id).sort()).toEqual(['a-1', 'a-2']);
    });

    it('does not add a second starting balance under the new id', async () => {
      const seed = reconnected(oldRows(), { ...confirmed, valuations: new Map([['wf-chk', 0]]) });
      const { host, store, activities } = createFakeHost(seed);
      await store.addBalanceInitialized('sfin-old');
      await runSyncCore(host, store, { force: true });

      expect((activities.get('wf-chk') ?? []).filter((r) => r.comment?.startsWith('Starting balance'))).toEqual([]);
      expect(await store.getBalanceInitialized()).toContain('sfin-new');
    });
  });

  describe('not confirmed', () => {
    it('matches and removes nothing: the shape alone is only a question', async () => {
      const { host, store, activities } = createFakeHost(reconnected([...oldRows(), copy()]));
      const result = await runSyncCore(host, store, { heal: true });

      expect(result.prunedDuplicates).toEqual([]);
      expect(activities.get('wf-chk')?.map((r) => r.id)).toEqual(expect.arrayContaining(['a-coffee', 'a-pay', 'b-coffee']));
    });

    it('merged feeds with one missing for a run lose nothing, then or when it is back', async () => {
      // Checking and Savings both feed wf-chk on purpose; Savings misses a run.
      const savings = {
        id: 'sfin-old', name: 'Savings', currency: 'USD', balance: '50.00', 'balance-date': posted(0),
        transactions: [{ id: 'TRN-o1', posted: posted(5), amount: '-4.50', description: 'COFFEE SHOP' }],
      };
      const seed = reconnected(oldRows());
      const fake = createFakeHost(seed);
      await runSyncCore(fake.host, fake.store, { heal: true });
      expect(fake.activities.get('wf-chk')?.map((r) => r.id)).toEqual(expect.arrayContaining(['a-coffee', 'a-pay']));

      seed.accountSet!.accounts.push(savings);
      const result = await runSyncCore(fake.host, fake.store, { heal: true });
      expect(result.prunedDuplicates).toEqual([]);
      expect(fake.activities.get('wf-chk')?.find((r) => r.id === 'a-coffee')?.comment).toBe('COFFEE SHOP · TRN-o1');
    });

    it('a declined shape is left alone too', async () => {
      const seed = reconnected([...oldRows(), copy()], { relinkDecisions: { confirmed: [], declined: ['wf-chk|sfin-new|sfin-old'] } });
      const { host, store } = createFakeHost(seed);
      const result = await runSyncCore(host, store, { heal: true });

      expect(result.prunedDuplicates).toEqual([]);
    });
  });
});
