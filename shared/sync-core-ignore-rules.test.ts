import { describe, it, expect, beforeEach } from 'vitest';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import type { IgnoreRule } from './ignore-rules.js';
import { linkPairByRecreate } from './link-pair.js';
import type { SyncHost } from './sync-host.js';

/**
 * A brokerage cash-management account reports the movement INSIDE the account
 * as ordinary rows (sweeps into and out of its core fund). They never cancel
 * in a Transactions-mode ledger, so the account's value drifts far above the
 * bank's balance. Ignore rules let the person say "never import these".
 */
describe('ignore rules', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
  });

  const posted = () => Math.floor(Date.now() / 1000) - 3600;

  // The shape of the real feed: one payroll deposit and one bill, each shadowed
  // by the sweep rows that moved the same money inside the account.
  const brokerageCash = (extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
    accountSet: { errors: [], accounts: [{
      id: 'sfin-cash', name: 'Cash Account', currency: 'USD', balance: '5000.00', 'balance-date': posted(),
      transactions: [
        { id: 'TRN-pay', posted: posted(), amount: '2500.00', description: 'DIRECT DEPOSIT EMPLOYER PAYROLL' },
        { id: 'TRN-into', posted: posted(), amount: '-2500.00', description: 'SWEEP TO CORE FUND MONEY MARKET' },
        { id: 'TRN-bill', posted: posted(), amount: '-400.00', description: 'DIRECT DEBIT CARD AUTOPAY' },
        { id: 'TRN-out', posted: posted(), amount: '400.00', description: 'SWEEP FROM CORE FUND MONEY MARKET' },
        { id: 'TRN-buy', posted: posted(), amount: '-1000.00', description: 'SCHEDULED BUY MONEY MARKET' },
      ],
    }] },
    mapping: { 'sfin-cash': 'wf-cash' },
    ...extra,
  });

  const sweeps = (account?: string): IgnoreRule[] => [
    { pattern: 'SWEEP TO CORE FUND', matchType: 'contains', ...(account ? { account } : {}) },
    { pattern: 'SWEEP FROM CORE FUND', matchType: 'contains', ...(account ? { account } : {}) },
    { pattern: 'SCHEDULED BUY', matchType: 'contains', ...(account ? { account } : {}) },
  ];

  it('imports the real flows and leaves the sweep rows out', async () => {
    const { host, store, activities } = createFakeHost(brokerageCash({ ignoreRules: sweeps('sfin-cash') }));
    const result = await runSyncCore(host, store, { force: true });

    expect(result.ignoredByRules).toBe(3);
    expect((activities.get('wf-cash') ?? []).map((r) => r.comment).sort()).toEqual([
      'DIRECT DEBIT CARD AUTOPAY · TRN-bill',
      'DIRECT DEPOSIT EMPLOYER PAYROLL · TRN-pay',
    ]);
  });

  it('imports everything when there are no rules', async () => {
    const { host, store, activities } = createFakeHost(brokerageCash());
    const result = await runSyncCore(host, store, { force: true });

    expect(result.ignoredByRules).toBe(0);
    expect(activities.get('wf-cash') ?? []).toHaveLength(5);
  });

  it('a rule limited to another account ignores nothing here', async () => {
    const { host, store, activities } = createFakeHost(brokerageCash({ ignoreRules: sweeps('sfin-elsewhere') }));
    const result = await runSyncCore(host, store, { force: true });

    expect(result.ignoredByRules).toBe(0);
    expect(activities.get('wf-cash') ?? []).toHaveLength(5);
  });

  it('a rule with no account reads every mapped account, and only mapped ones', async () => {
    const seed = brokerageCash({ ignoreRules: [{ pattern: 'SWEEP FROM CORE', matchType: 'contains' }] });
    seed.accountSet!.accounts.push({
      id: 'sfin-other', name: 'Other', currency: 'USD', balance: '0', 'balance-date': posted(),
      transactions: [{ id: 'TRN-x', posted: posted(), amount: '5.00', description: 'SWEEP FROM CORE ELSEWHERE' }],
    });
    const { host, store, activities } = createFakeHost(seed);
    const result = await runSyncCore(host, store, { force: true });

    // 'sfin-other' is not mapped: its row is not this sync's business, so it is
    // neither imported nor counted as ignored.
    expect(result.ignoredByRules).toBe(1);
    expect(activities.get('wf-cash') ?? []).toHaveLength(4);
  });

  it('ignores a pending row the same way', async () => {
    const seed = brokerageCash({ ignoreRules: [{ pattern: 'SCHEDULED BUY', matchType: 'contains', account: 'sfin-cash' }] });
    seed.accountSet!.accounts[0].transactions!.push(
      { id: 'TRN-pending', posted: posted(), amount: '-1000.00', description: 'SCHEDULED BUY MONEY MARKET', pending: true },
    );
    const { host, store, activities } = createFakeHost(seed);
    const result = await runSyncCore(host, store, { force: true });

    expect(result.ignoredByRules).toBe(2);
    expect((activities.get('wf-cash') ?? []).filter((r) => r.comment?.includes('SCHEDULED BUY'))).toEqual([]);
    expect(activities.get('wf-cash') ?? []).toHaveLength(4);
  });

  it('obeys a regex rule', async () => {
    const { host, store, activities } = createFakeHost(brokerageCash({
      ignoreRules: [{ pattern: '^SWEEP (TO|FROM) CORE', matchType: 'regex', account: 'sfin-cash' }],
    }));
    const result = await runSyncCore(host, store, { force: true });

    expect(result.ignoredByRules).toBe(2);
    expect((activities.get('wf-cash') ?? []).map((r) => r.comment).sort()).toEqual([
      'DIRECT DEBIT CARD AUTOPAY · TRN-bill',
      'DIRECT DEPOSIT EMPLOYER PAYROLL · TRN-pay',
      'SCHEDULED BUY MONEY MARKET · TRN-buy',
    ]);
  });

  it('never lets an empty or match-everything rule hide the account', async () => {
    const { host, store, activities } = createFakeHost(brokerageCash({
      ignoreRules: [
        { pattern: '', matchType: 'contains' },
        { pattern: '   ', matchType: 'contains', account: 'sfin-cash' },
        { pattern: '.*', matchType: 'regex' },
      ],
    }));
    const result = await runSyncCore(host, store, { force: true });

    expect(result.ignoredByRules).toBe(0);
    expect(activities.get('wf-cash') ?? []).toHaveLength(5);
  });

  it('imports everything when the rules cannot be read', async () => {
    const { host, store, activities } = createFakeHost(brokerageCash());
    store.getIgnoreRules = async () => { throw new Error('secret store unavailable'); };
    const result = await runSyncCore(host, store, { force: true });

    expect(result.ignoredByRules).toBe(0);
    expect(activities.get('wf-cash') ?? []).toHaveLength(5);
  });

  it('leaves an already-stored copy for the user to delete', async () => {
    const day = new Date(posted() * 1000).toISOString().slice(0, 10);
    const { host, store, saved } = createFakeHost(brokerageCash({
      ignoreRules: sweeps('sfin-cash'),
      existing: new Map([['wf-cash', [{
        id: 'row-1', accountId: 'wf-cash', activityType: 'DEPOSIT', date: day, amount: 400,
        comment: 'SWEEP FROM CORE FUND MONEY MARKET · TRN-out', sourceGroupId: null,
      }]]]),
    }));

    await runSyncCore(host, store, { force: true });

    expect(saved.flatMap((s) => [...(s.deleteIds ?? []), ...(s.updates ?? []).map((u) => u.id)])).toEqual([]);
  });

  it('counts a row on the skip list once, not twice', async () => {
    const { host, store, activities } = createFakeHost(brokerageCash({
      ignoreRules: sweeps('sfin-cash'),
      skippedTransactions: [{ account: 'sfin-cash', txId: 'TRN-into' }],
    }));
    const result = await runSyncCore(host, store, { force: true });

    expect(result.ignoredByRules).toBe(2);
    expect(activities.get('wf-cash') ?? []).toHaveLength(2);
  });

  // SimpleFin gives both sides of a same-institution transfer one id, so the
  // ignored leg's id is still in the OTHER account's raw feed. Adoption treats a
  // stored linked row whose id is missing from this account's feed as an
  // overwritten leg; a rule-ignored row is missing for that reason only.
  it('does not adopt a stored transfer leg a rule ignores into an unrelated new row', async () => {
    const DAY = 86_400;
    const now = Math.floor(Date.now() / 1000);
    const xAt = now - 3 * DAY;
    const yAt = now - DAY;
    const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);
    const fake = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-chk', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': now, transactions: [
          { id: 'TRN-X', posted: xAt, amount: '-100.00', description: 'ONLINE TRANSFER TO SAVINGS' },
          { id: 'TRN-Y', posted: yAt, amount: '-100.00', description: 'ATM WITHDRAWAL 4471 MAIN ST' },
        ] },
        { id: 'sfin-sav', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': now, transactions: [
          { id: 'TRN-X', posted: xAt, amount: '100.00', description: 'ONLINE TRANSFER FROM CHECKING' },
        ] },
      ] },
      mapping: { 'sfin-chk': 'wf-chk', 'sfin-sav': 'wf-sav' },
      accountTypes: { 'wf-chk': 'CASH', 'wf-sav': 'CASH' },
      existing: new Map([
        ['wf-chk', [{ id: 'chk-x', accountId: 'wf-chk', activityType: 'TRANSFER_OUT', date: iso(xAt), amount: 100,
          comment: 'ONLINE TRANSFER TO SAVINGS · TRN-X', sourceGroupId: 'g1' } as any]],
        ['wf-sav', [{ id: 'sav-x', accountId: 'wf-sav', activityType: 'TRANSFER_IN', date: iso(xAt), amount: 100,
          comment: 'ONLINE TRANSFER FROM CHECKING · TRN-X', sourceGroupId: 'g1' } as any]],
      ]),
      ignoreRules: [{ pattern: 'TRANSFER TO SAVINGS', matchType: 'contains', account: 'sfin-chk' }],
      upstreamWriteRules: true,
    });
    const host: SyncHost = { ...fake.host, linkPair: (legs) => linkPairByRecreate((req) => fake.host.saveMany(req), legs) };
    await runSyncCore(host, fake.store, { force: true });

    const rows = fake.activities.get('wf-chk') ?? [];
    const stored = rows.find((r) => r.id === 'chk-x');
    expect(stored).toMatchObject({
      activityType: 'TRANSFER_OUT', comment: 'ONLINE TRANSFER TO SAVINGS · TRN-X', sourceGroupId: 'g1',
    });
    const atm = rows.find((r) => r.comment?.includes('TRN-Y'));
    // What matters here is that it is a NEW row, not the stored transfer leg
    // rewritten. It is not a plain withdrawal: with Checking's leg ignored, the
    // Savings leg has no partner in the feed and pairs with this same-amount
    // row instead. That is what ignoring one side of a real transfer does, and
    // why ignore rules are only for rows that move money inside one account.
    expect(atm).toBeDefined();
    expect(atm!.id).not.toBe('chk-x');
    expect(atm!.sourceGroupId).not.toBe('g1');
  });
});
