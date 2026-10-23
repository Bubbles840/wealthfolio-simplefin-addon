import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runSyncCore, TRANSFER_GROUP_PREFIX, VALUATION_POLL } from './sync-core.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import type { HostActivity, SyncHost } from './sync-host.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { Relink } from './relink.js';
import type { ChangeEntry, ChangeLogSink } from './change-entries.js';

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
  /** The books: every stored row, signed by its type. */
  const net = (rows: HostActivity[] | undefined) => Math.round((rows ?? [])
    .reduce((sum, r) => sum + (['WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX'].includes(String(r.activityType)) ? -1 : 1) * Number(r.amount), 0) * 100) / 100;
  /** A ledger that agrees with the bank: the old rows are 2495.50, and the bank
   *  is that less the grocery bought since. */
  const consistent = { valuations: new Map([['wf-chk', 2495.5]]) };
  const bankAt = (balance: string, transactions = newFeed().transactions) => ({ errors: [], accounts: [{ ...newFeed(), balance, transactions }] });

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

    it('does not add a second starting balance under the new id when the books already match the bank', async () => {
      const seed = reconnected(oldRows(), { ...confirmed, ...consistent, accountSet: bankAt('2435.50') });
      const { host, store, activities } = createFakeHost(seed);
      await store.addBalanceInitialized('sfin-old');
      await runSyncCore(host, store, { force: true });

      expect((activities.get('wf-chk') ?? []).filter((r) => r.comment?.startsWith('Starting balance'))).toEqual([]);
      expect(await store.getBalanceInitialized()).toContain('sfin-new');
      expect(net(activities.get('wf-chk'))).toBe(2435.5);
    });

    it('books a starting balance under the new id when the bank re-worded an overlap row, so the books match the bank', async () => {
      // The Yes came before the new id's first sync, but the bank re-worded the
      // coffee: no match, so it is imported again. Only the new id's own
      // starting balance cancels that copy.
      const reworded = newFeed().transactions.map((t) => (t.id === 'TRN-n1' ? { ...t, description: 'POS PURCHASE COFFEE SHOP 4411' } : t));
      const seed = reconnected(oldRows(), { ...confirmed, ...consistent, accountSet: bankAt('2435.50', reworded) });
      const { host, store, activities } = createFakeHost(seed);
      await store.addBalanceInitialized('sfin-old');
      await runSyncCore(host, store, { force: true });

      expect(comments(activities.get('wf-chk'))).toContain('POS PURCHASE COFFEE SHOP 4411 · TRN-n1');
      expect(net(activities.get('wf-chk'))).toBe(2435.5);
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

  describe('confirmed, the second review', () => {
    const capture = (): ChangeLogSink & { entries: () => ChangeEntry[] } => {
      const batches: ChangeEntry[][] = [];
      return { writer: 'addon', run: 'aRUN1', append: vi.fn(async (e: ChangeEntry[]) => { batches.push(e); }), entries: () => batches.flat() };
    };

    it('a late Yes: heal removes the new id\'s starting balance that cancelled the copies, with its own Undo', async () => {
      // Before the Yes, the new id's first sync imported the copy and booked a
      // starting balance cancelling it; the old id's starting balance stands.
      const rows = [
        stored('sb-old', 'Starting balance · sfin-old', '1000.00', 30, { activityType: 'CREDIT' }),
        ...oldRows(), copy(),
        stored('sb-new', 'Starting balance · sfin-new', '4.50', 6, { activityType: 'CREDIT' }),
      ];
      const log = capture();
      const { host, store, activities } = createFakeHost(reconnected(rows, confirmed));
      await runSyncCore(host, store, { heal: true, changeLog: log });

      expect(activities.get('wf-chk')?.map((r) => r.id)).not.toContain('b-coffee');
      expect(activities.get('wf-chk')?.map((r) => r.id)).not.toContain('sb-new');
      expect(activities.get('wf-chk')?.map((r) => r.id)).toContain('sb-old');
      // The old books exactly, plus the purchase made since: 1000 − 4.50 + 2500 − 60.
      expect(net(activities.get('wf-chk'))).toBe(3435.5);
      expect(log.entries().find((e) => e.kind === 'starting-balance-removed')).toMatchObject({
        subject: { activityIds: ['sb-new'], amountCents: 450 }, before: { comment: 'Starting balance · sfin-new' }, undoable: true,
      });
    });

    it('restates the new id\'s starting balance when the old id has none of its own, so the books keep their total', async () => {
      // 2495.50 stored, matching the bank before the grocery; the bank is 2435.50 after it.
      const rows = [...oldRows(), copy(), stored('sb-new', 'Starting balance · sfin-new', '4.50', 6, { activityType: 'CREDIT' })];
      expect(net(rows)).toBe(2495.5);
      const { host, store, activities } = createFakeHost(reconnected(rows, { ...confirmed, accountSet: bankAt('2435.50') }));
      await runSyncCore(host, store, { heal: true });
      expect(activities.get('wf-chk')?.map((r) => r.id)).not.toContain('b-coffee');
      expect(activities.get('wf-chk')?.map((r) => r.id)).not.toContain('sb-new');
      expect(net(activities.get('wf-chk'))).toBe(2435.5);
    });

    it('a restated starting balance stays restated on an account with more history than the oldest-rows read', async () => {
      // 60 rows older than the new id's starting balance: the later baseline check
      // reads only the oldest 50, so it finds the row in its own snapshot instead.
      const history = Array.from({ length: 60 }, (_, i) => stored(`h${i}`, `INTEREST · TRN-h${i}`, '1.00', 100 + i));
      const rows = [...history, ...oldRows(), copy(), stored('sb-new', 'Starting balance · sfin-new', '10.00', 6, { activityType: 'CREDIT' })];
      const before = net(rows);
      const { host, store, activities } = createFakeHost(reconnected(rows, { ...confirmed, accountSet: bankAt('2501.00') }));
      await runSyncCore(host, store, { heal: true });

      expect(activities.get('wf-chk')?.map((r) => r.id)).not.toContain('b-coffee');
      const sb = activities.get('wf-chk')?.find((r) => r.id === 'sb-new');
      expect(sb?.activityType).toBe('CREDIT');
      expect(Number(sb?.amount)).toBe(5.5);
      // The total kept, plus the grocery bought since.
      expect(net(activities.get('wf-chk'))).toBe(Math.round((before - 60) * 100) / 100);
    });

    it('a refused starting-balance fix removes nothing, says so, and the next Deep scan finishes it', async () => {
      // 4.50 is deleted outright, 10.00 restated to 5.50: one write each way.
      for (const [sbAmount, how] of [['4.50', 'errors'], ['10.00', 'errors'], ['4.50', 'throws']] as const) {
        const rows = [...oldRows(), copy(), stored('sb-new', 'Starting balance · sfin-new', sbAmount, 6, { activityType: 'CREDIT' })];
        const before = net(rows);
        let refuse = true;
        const fake = createFakeHost(reconnected(rows, { ...confirmed, accountSet: bankAt('2435.50') }));
        const touchesBaseline = (req: { deleteIds?: string[]; updates?: Array<{ id?: string }> }) =>
          (req.deleteIds ?? []).includes('sb-new') || (req.updates ?? []).some((u) => u.id === 'sb-new');
        const host: SyncHost = {
          ...fake.host,
          // Wealthfolio's bulk endpoint applies nothing when it refuses a row.
          saveMany: async (req) => {
            if (refuse && touchesBaseline(req)) {
              if (how === 'throws') throw new Error('Activity is locked');
              return { created: [], updated: [], errors: [{ action: 'update', message: 'Activity is locked' }] };
            }
            return fake.host.saveMany(req);
          },
        };
        const r1 = await runSyncCore(host, fake.store, { heal: true });
        expect(r1.errors.join(' ')).toMatch(/Activity is locked/);
        expect(r1.errors.join(' ')).toMatch(/Checking/);
        expect(fake.activities.get('wf-chk')?.map((r) => r.id)).toEqual(expect.arrayContaining(['b-coffee', 'sb-new']));
        expect(net(fake.activities.get('wf-chk'))).toBe(Math.round((before - 60) * 100) / 100);

        refuse = false;
        await runSyncCore(host, fake.store, { heal: true });
        expect(fake.activities.get('wf-chk')?.map((r) => r.id)).not.toContain('b-coffee');
        expect(net(fake.activities.get('wf-chk'))).toBe(Math.round((before - 60) * 100) / 100);
      }
    });

    it('matches a purchase and its refund by direction, never one for the other', async () => {
      const feed = { ...newFeed(), transactions: [
        { id: 'TRN-n5', posted: posted(3), amount: '-25.00', description: 'HARDWARE STORE' },
        { id: 'TRN-n6', posted: posted(3), amount: '25.00', description: 'HARDWARE STORE' },
      ] };
      const rows = [
        stored('z-buy', 'HARDWARE STORE · TRN-o5', '-25.00', 3),
        stored('a-refund', 'HARDWARE STORE · TRN-o6', '25.00', 3),
        stored('b-refund', 'HARDWARE STORE · TRN-n6', '25.00', 3, { activityType: 'TRANSFER_IN', sourceGroupId: 'g-1' }),
      ];
      const { host, store, activities } = createFakeHost(reconnected(rows, { ...confirmed, accountSet: { errors: [], accounts: [feed] } }));
      await runSyncCore(host, store, { heal: true });
      const ids = activities.get('wf-chk')?.map((r) => r.id);
      expect(ids).toEqual(expect.arrayContaining(['z-buy', 'b-refund']));
      expect(ids).not.toContain('a-refund');
      expect(net(activities.get('wf-chk'))).toBe(0);
    });

    it('keeps a copy linked by hand on the add-on, which reads the group off the row', async () => {
      const { host, store, activities } = createFakeHost(reconnected([...oldRows(), copy({ activityType: 'WITHDRAWAL', sourceGroupId: 'g-hand' })], confirmed));
      await runSyncCore({ ...host, capabilities: { ...host.capabilities, readsSourceGroupId: false } } as SyncHost, store, { heal: true });
      const ids = activities.get('wf-chk')?.map((r) => r.id);
      expect(ids).toContain('b-coffee');
      expect(ids).not.toContain('a-coffee');
    });

    it('imports an old id again once it is mapped to an account of its own', async () => {
      const old = { id: 'sfin-old', name: 'Savings', currency: 'USD', balance: '50.00', 'balance-date': posted(0),
        transactions: [{ id: 'TRN-s1', posted: posted(2), amount: '-10.00', description: 'ATM' }] };
      const seed = reconnected(oldRows(), { ...confirmed, accountSet: { errors: [], accounts: [newFeed(), old] },
        mapping: { 'sfin-old': 'wf-sav', 'sfin-new': 'wf-chk' } });
      const { host, store, activities } = createFakeHost(seed);
      const result = await runSyncCore(host, store, { force: true });
      expect(comments(activities.get('wf-sav'))).toEqual(['ATM · TRN-s1']);
      expect(result.errors.join(' ')).not.toMatch(/not imported/);
    });

    it('says so when a retired id reports again, and imports none of it', async () => {
      const old = { id: 'sfin-old', name: 'Old Checking', currency: 'USD', balance: '50.00', 'balance-date': posted(0),
        transactions: [{ id: 'TRN-o9', posted: posted(2), amount: '-10.00', description: 'ATM' }] };
      const { host, store, activities } = createFakeHost(reconnected(oldRows(), { ...confirmed, accountSet: { errors: [], accounts: [newFeed(), old] } }));
      const result = await runSyncCore(host, store, { force: true });
      expect(comments(activities.get('wf-chk'))).not.toContain('ATM · TRN-o9');
      expect(result.errors.join(' ')).toMatch(/Old Checking reported 1 transaction, which was not imported: you confirmed Checking replaces it/);
      // Undoing the Yes would import the overlap again: the same account's old
      // connection is removed at the Bridge instead.
      expect(result.errors.join(' ')).toMatch(/If it is the same account, remove the old connection at SimpleFin Bridge/);
    });

    it('says nothing about a retired id the person set not to sync', async () => {
      const old = { id: 'sfin-old', name: 'Old Checking', currency: 'USD', balance: '50.00', 'balance-date': posted(0),
        transactions: [{ id: 'TRN-o9', posted: posted(2), amount: '-10.00', description: 'ATM' }] };
      // Unmapped since, and on the do-not-sync list: still retired, so nothing is imported.
      const seed = reconnected(oldRows(), { ...confirmed, accountSet: { errors: [], accounts: [newFeed(), old] }, mapping: { 'sfin-new': 'wf-chk' } });
      const { host, store, activities } = createFakeHost(seed);
      store.getIgnoredAccounts = async () => ['sfin-old'];
      const result = await runSyncCore(host, store, { force: true });
      expect(comments(activities.get('wf-chk'))).not.toContain('ATM · TRN-o9');
      expect(result.errors.join(' ')).not.toMatch(/not imported/);
    });

    it('deletes nothing while another feed of the account is missing, or SimpleFin reported an error', async () => {
      const seed = reconnected([...oldRows(), copy(), stored('a-rent', 'ONLINE TRANSFER · Rent share · TRN-s1', '-100.00', 3)],
        { ...confirmed, mapping: { 'sfin-old': 'wf-chk', 'sfin-new': 'wf-chk', 'sfin-sav': 'wf-chk' } });
      const first = createFakeHost(seed);
      const r1 = await runSyncCore(first.host, first.store, { heal: true });
      expect(r1.prunedDuplicates).toEqual([]);
      expect(first.activities.get('wf-chk')?.map((r) => r.id)).toEqual(expect.arrayContaining(['a-rent', 'b-coffee']));

      const second = createFakeHost(reconnected([...oldRows(), copy()], { ...confirmed, accountSet: { errors: ['Connection to the bank failed'], accounts: [newFeed()] } }));
      const r2 = await runSyncCore(second.host, second.store, { heal: true });
      expect(r2.prunedDuplicates).toEqual([]);
    });

    /** One structured Bridge error naming `accountId`, as `normalizeAccountSet` builds it. */
    const bridgeError = (accountId: string, name: string) => ({
      error: `${name}: Connection to institution failed`,
      entry: { code: 'CONN_FAILED', msg: 'Connection to institution failed', connId: `c-${accountId}`, accountId, key: `CONN_FAILED:c-${accountId}` },
    });
    const withErrors = (accounts: ReturnType<typeof newFeed>[], ...errs: Array<ReturnType<typeof bridgeError>>) =>
      ({ accounts, errors: errs.map((e) => e.error), errorList: errs.map((e) => e.entry) });

    it('an error on another account\'s connection, or on the retired id, blocks nothing here', async () => {
      // A card that needs attention for weeks, and the old connection left at the Bridge.
      const seed = reconnected([...oldRows(), copy()], {
        ...confirmed,
        mapping: { 'sfin-old': 'wf-chk', 'sfin-new': 'wf-chk', 'sfin-card': 'wf-card' },
        accountSet: withErrors([newFeed()], bridgeError('sfin-card', 'Discover it Card'), bridgeError('sfin-old', 'Old Checking')),
      });
      const { host, store } = createFakeHost(seed);
      const result = await runSyncCore(host, store, { heal: true });
      expect(result.errors.join(' ')).toMatch(/Discover it Card: Connection to institution failed/);
      expect(result.prunedDuplicates.map((d) => d.wfId)).toEqual(['b-coffee']);
    });

    it('an error on another feed of the same account, or on the new id itself, still blocks', async () => {
      const savings = { ...newFeed(), id: 'sfin-sav', name: 'Savings', transactions: [] };
      for (const [failing, name] of [['sfin-sav', 'Savings'], ['sfin-new', 'Checking']] as const) {
        const seed = reconnected([...oldRows(), copy()], {
          ...confirmed,
          mapping: { 'sfin-old': 'wf-chk', 'sfin-new': 'wf-chk', 'sfin-sav': 'wf-chk' },
          accountSet: withErrors([newFeed(), savings], bridgeError(failing, name)),
        });
        const { host, store, activities } = createFakeHost(seed);
        const result = await runSyncCore(host, store, { heal: true });
        expect(result.prunedDuplicates).toEqual([]);
        expect(activities.get('wf-chk')?.map((r) => r.id)).toContain('b-coffee');
      }
    });

    it('counts the rows it matched', async () => {
      const { host, store } = createFakeHost(reconnected(oldRows(), confirmed));
      const result = await runSyncCore(host, store, { force: true });
      expect(result.relinkAdopted).toBe(2);
    });
  });
});
