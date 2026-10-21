import { describe, it, expect, beforeEach } from 'vitest';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import type { HostActivity } from './sync-host.js';

/**
 * A SimpleFin connection removed and added again: the same bank account comes
 * back under a new id, mapped to the same Wealthfolio account, with every
 * transaction under a new id too. The old id stays in the mapping and reports
 * nothing.
 */
describe('a re-linked connection', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
  });

  const posted = (daysAgo: number) => Math.floor(Date.now() / 1000) - daysAgo * 86_400;
  const day = (daysAgo: number) => new Date(posted(daysAgo) * 1000).toISOString().slice(0, 10);

  const stored = (id: string, comment: string, amount: string, daysAgo: number, extra: Partial<HostActivity> = {}): HostActivity => ({
    id, accountId: 'wf-chk', activityType: parseFloat(amount) < 0 ? 'WITHDRAWAL' : 'DEPOSIT',
    date: day(daysAgo), amount: String(Math.abs(parseFloat(amount))), comment, ...extra,
  });

  /** The old connection imported the coffee and the paycheck; the new download
   *  reports both again under new ids, plus a purchase made since. */
  const reconnected = (existing: HostActivity[], extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
    accountSet: { errors: [], accounts: [{
      id: 'sfin-new', name: 'Checking', currency: 'USD', balance: '1000.00', 'balance-date': posted(0),
      transactions: [
        { id: 'TRN-n1', posted: posted(5), amount: '-4.50', description: 'COFFEE SHOP' },
        { id: 'TRN-n2', posted: posted(4), amount: '2500.00', description: 'EMPLOYER PAYROLL' },
        { id: 'TRN-n3', posted: posted(1), amount: '-60.00', description: 'GROCERY STORE' },
      ],
    }] },
    mapping: { 'sfin-old': 'wf-chk', 'sfin-new': 'wf-chk' },
    existing: new Map([['wf-chk', existing]]),
    ...extra,
  });

  const oldRows = () => [
    stored('a-coffee', 'COFFEE SHOP · TRN-o1', '-4.50', 5),
    stored('a-pay', 'EMPLOYER PAYROLL · TRN-o2', '2500.00', 4),
  ];

  it('does not import the overlap a second time', async () => {
    const { host, store, activities } = createFakeHost(reconnected(oldRows()));
    await runSyncCore(host, store, { force: true });

    const rows = activities.get('wf-chk') ?? [];
    expect(rows.map((r) => r.comment).sort()).toEqual([
      'COFFEE SHOP · TRN-o1',
      'EMPLOYER PAYROLL · TRN-o2',
      'GROCERY STORE · TRN-n3',
    ]);
    // The old rows are the same activities, untouched.
    expect(rows.find((r) => r.id === 'a-coffee')?.comment).toBe('COFFEE SHOP · TRN-o1');
  });

  it('a Deep scan deletes a copy imported before this fix, and keeps the old row', async () => {
    const seed = reconnected([...oldRows(), stored('b-coffee', 'COFFEE SHOP · TRN-n1', '-4.50', 5)]);
    const { host, store, activities } = createFakeHost(seed);
    const result = await runSyncCore(host, store, { heal: true });

    const rows = activities.get('wf-chk') ?? [];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining(['a-coffee', 'a-pay']));
    expect(rows.some((r) => r.id === 'b-coffee')).toBe(false);
    expect(result.prunedDuplicates.map((d) => d.wfId)).toEqual(['b-coffee']);
    expect(rows.filter((r) => r.comment?.startsWith('COFFEE SHOP'))).toHaveLength(1);
  });

  it('a routine sync deletes nothing', async () => {
    const seed = reconnected([...oldRows(), stored('b-coffee', 'COFFEE SHOP · TRN-n1', '-4.50', 5)]);
    const { host, store, activities } = createFakeHost(seed);
    const result = await runSyncCore(host, store, { force: true });

    expect(result.prunedDuplicates).toEqual([]);
    expect((activities.get('wf-chk') ?? []).some((r) => r.id === 'b-coffee')).toBe(true);
  });

  it('keeps a linked new copy and deletes the unlinked old row', async () => {
    const seed = reconnected([...oldRows(), stored('b-coffee', 'COFFEE SHOP · TRN-n1', '-4.50', 5, { sourceGroupId: 'g1' })]);
    const { host, store, activities } = createFakeHost(seed);
    const result = await runSyncCore(host, store, { heal: true });

    const rows = activities.get('wf-chk') ?? [];
    expect(rows.some((r) => r.id === 'b-coffee')).toBe(true);
    expect(rows.some((r) => r.id === 'a-coffee')).toBe(false);
    expect(result.prunedDuplicates.map((d) => d.wfId)).toEqual(['a-coffee']);
  });

  it('two feeds deliberately mapped to one account are not a re-link', async () => {
    const seed = reconnected(oldRows());
    seed.accountSet!.accounts.push({ id: 'sfin-old', name: 'Old', currency: 'USD', balance: '0', 'balance-date': posted(0), transactions: [] });
    const { host, store, activities } = createFakeHost(seed);
    await runSyncCore(host, store, { force: true });

    // Nothing adopted: the coffee and the paycheck import under the new ids.
    expect(activities.get('wf-chk') ?? []).toHaveLength(5);
  });

  it('does not add a second starting balance under the new id', async () => {
    const seed = reconnected(oldRows(), { valuations: new Map([['wf-chk', 0]]) });
    const { host, store, activities } = createFakeHost(seed);
    await store.addBalanceInitialized('sfin-old');
    await runSyncCore(host, store, { force: true });

    expect((activities.get('wf-chk') ?? []).filter((r) => r.comment?.startsWith('Starting balance'))).toEqual([]);
    expect(await store.getBalanceInitialized()).toContain('sfin-new');
  });
});
