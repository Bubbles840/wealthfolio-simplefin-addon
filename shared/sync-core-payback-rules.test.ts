import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { paybackMappingRule } from './mapper.js';
import { paybackRuleSince } from './payback.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import type { MappingRule } from './types.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const RULE = paybackMappingRule('VENMO CASHOUT', 'wf-a', '2026-10-01');
const flag = () => setTxOverride(emptySyncOverrides(), accountTxKey('sfin-1', 'tx-1'), 'asReimbursement', NOW, { label: 'VENMO CASHOUT · Checking' });

/** Checking (wf-a) and Savings (wf-b), one Venmo cash-out each, of `amount`. */
const seed = (amount: string, extra: Partial<FakeHostSeed> = {}, pending = false): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
      transactions: [{ id: 'tx-1', posted: epoch('2026-10-09T12:00:00Z'), amount, description: 'VENMO CASHOUT 1023', ...(pending ? { pending: true } : {}) }] },
    { id: 'sfin-2', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
      transactions: [{ id: 'tx-2', posted: epoch('2026-10-09T12:00:00Z'), amount, description: 'VENMO CASHOUT 1023' }] },
  ] },
  mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
  accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CASH' },
  mappingRules: [RULE as never],
  ...extra,
});
const rowOf = (fh: ReturnType<typeof createFakeHost>, account: string, tx: string) =>
  fh.activities.get(account)!.find((r) => r.comment?.includes(tx))!;
const writes = (fh: ReturnType<typeof createFakeHost>) => fh.saved.filter((r) => (r.updates ?? []).length > 0 || (r.creates ?? []).length > 0);

describe('runSyncCore — a payback rule (W10: onlyMoneyIn + accountId)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('types money in for its own account a payback, and leaves another account as a deposit', async () => {
    const fh = createFakeHost(seed('14.00'));
    expect((await runSyncCore(fh.host, fh.store, {})).errors).toEqual([]);
    expect(rowOf(fh, 'wf-a', 'tx-1')).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
    expect(rowOf(fh, 'wf-b', 'tx-2')).toMatchObject({ activityType: 'DEPOSIT' });
  });

  it('never types a payment out with the same words', async () => {
    const fh = createFakeHost(seed('-14.00'));
    await runSyncCore(fh.host, fh.store, {});
    expect(rowOf(fh, 'wf-a', 'tx-1').activityType).toBe('WITHDRAWAL');
  });

  it('does not fight the asReimbursement flag: a row both mark is written once and left alone after', async () => {
    const fh = createFakeHost(seed('14.00', { syncOverrides: flag() }));
    await runSyncCore(fh.host, fh.store, {});
    expect(rowOf(fh, 'wf-a', 'tx-1')).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
    const first = writes(fh).length;
    await runSyncCore(fh.host, fh.store, { force: true });
    expect(writes(fh)).toHaveLength(first);
    expect(rowOf(fh, 'wf-a', 'tx-1')).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });

  it('handles a pending row it types like any rule-typed pending row: a payback now, replaced when it posts', async () => {
    const fh = createFakeHost(seed('14.00', {}, true));
    await runSyncCore(fh.host, fh.store, {});
    expect(rowOf(fh, 'wf-a', 'tx-1')).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
    const stored: HostActivity = rowOf(fh, 'wf-a', 'tx-1');
    expect(stored.comment).toContain('pending');
    const posted = createFakeHost(seed('14.00', { existing: new Map([['wf-a', [stored]]]) }));
    await runSyncCore(posted.host, posted.store, { force: true });
    const after = posted.activities.get('wf-a')!.filter((r) => r.comment?.includes('tx-1'));
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: stored.id, activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });

  it('leaves a stored deposit dated before the rule alone: last week’s payroll stays income (I1)', async () => {
    const payroll = { id: 'tx-pay', posted: epoch('2026-10-10T12:00:00Z'), amount: '2000.00', description: 'DIRECT DEPOSIT ACME CORP PAYROLL' };
    const accounts = (rule: MappingRule[]) => seed('14.00', {
      accountSet: { errors: [], accounts: [{ id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'), transactions: [payroll] }] },
      mappingRules: rule as never[],
    });
    const first = createFakeHost(accounts([]));
    await runSyncCore(first.host, first.store, {});
    // The payroll is stored as a deposit; a payback rule made today for "DEPOSIT" words arrives.
    const next = createFakeHost({ ...accounts([paybackMappingRule('ACME CORP PAYROLL', 'wf-a', '2026-10-14')]), existing: new Map([['wf-a', first.activities.get('wf-a')!.map((r) => ({ ...r }))]]) });
    await runSyncCore(next.host, next.store, { force: true });
    expect(rowOf(next, 'wf-a', 'tx-pay')).toMatchObject({ activityType: 'DEPOSIT' });
  });

  it('types a new matching deposit dated on or after the rule a payback (I1)', async () => {
    const feed = { id: 'tx-new', posted: epoch('2026-10-14T12:00:00Z'), amount: '14.00', description: 'VENMO CASHOUT 99' };
    const fh = createFakeHost(seed('14.00', {
      accountSet: { errors: [], accounts: [{ id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'), transactions: [feed] }] },
      mappingRules: [paybackMappingRule('VENMO CASHOUT', 'wf-a', '2026-10-14') as never],
    }));
    await runSyncCore(fh.host, fh.store, {});
    expect(rowOf(fh, 'wf-a', 'tx-new')).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });

  it('keeps a stored rule-typed pending row visible when the overrides cannot be read (not hidden, so no duplicate)', async () => {
    const fh = createFakeHost(seed('14.00', {}, true));
    await runSyncCore(fh.host, fh.store, {});
    const store = { ...fh.store, getSyncOverrides: async () => { throw new Error('down'); }, readSyncOverrides: async () => null };
    await runSyncCore(fh.host, store, { force: true });
    expect(fh.activities.get('wf-a')!.filter((r) => r.comment?.includes('tx-1'))).toHaveLength(1);
  });

  describe('a payback rule decides only rows the sync CREATES (PB-L I-1)', () => {
    type Tx = { id: string; posted: string; amount: string; description: string; pending?: boolean };
    const one = (txs: Tx[], extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
      accountSet: { errors: [], accounts: [{ id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
        transactions: txs.map((t) => ({ id: t.id, posted: t.pending ? 0 : epoch(t.posted), ...(t.pending ? { transacted_at: epoch(t.posted), pending: true } : {}), amount: t.amount, description: t.description })) }] },
      mapping: { 'sfin-1': 'wf-a' }, accountTypes: { 'wf-a': 'CASH' }, ...extra,
    });
    const kinds = (fh: ReturnType<typeof createFakeHost>) => fh.activities.get('wf-a')!.map((r) => [r.activityType, r.subtype ?? null]);
    /** Sync with no rule (the deposit is stored as income), then sync again with the rule. */
    async function storedThenRule(first: Tx[], rule: MappingRule, later?: Tx[]) {
      const a = createFakeHost(one(first));
      await runSyncCore(a.host, a.store, {});
      const b = createFakeHost(one(later ?? first, { existing: new Map([['wf-a', a.activities.get('wf-a')!.map((r) => ({ ...r }))]]), mappingRules: [rule as never] }));
      await runSyncCore(b.host, b.store, { force: true });
      return b;
    }
    const madeAt = (iso: string) => paybackMappingRule('ZELLE FROM JANE DOE', 'wf-a', paybackRuleSince(new Date(iso)));

    it('F2b: a deposit stored on the rule’s own day is NOT re-typed', async () => {
      const b = await storedThenRule([{ id: 'tx-am', posted: '2026-10-14T12:00:00Z', amount: '50.00', description: 'ZELLE FROM JANE DOE 8ZK1' }], madeAt('2026-10-14T15:00:00Z'));
      expect(kinds(b)).toEqual([['DEPOSIT', null]]);
    });

    it('F2c: a deposit created after 8 pm EDT (the next UTC day) IS caught', async () => {
      const fh = createFakeHost(one([{ id: 'tx-eve', posted: '2026-10-14T12:00:00Z', amount: '20.00', description: 'ZELLE FROM JANE DOE 9QQ1' }], { mappingRules: [madeAt('2026-10-15T01:00:00Z') as never] }));
      await runSyncCore(fh.host, fh.store, {});
      expect(kinds(fh)).toEqual([['CREDIT', 'REIMBURSEMENT']]);
    });

    it('F2e: rows stored while the rule was undone are NOT re-typed after a Redo puts it back', async () => {
      const b = await storedThenRule([{ id: 'tx-mid', posted: '2026-10-20T12:00:00Z', amount: '40.00', description: 'ZELLE FROM JANE DOE 77ZZ' }], madeAt('2026-10-14T15:00:00Z'));
      expect(kinds(b)).toEqual([['DEPOSIT', null]]);
    });

    it('a stored pending deposit that posts after the rule stays a DEPOSIT (same id)', async () => {
      const b = await storedThenRule(
        [{ id: 'tx-p', posted: '2026-10-13T12:00:00Z', amount: '30.00', description: 'ZELLE FROM JANE DOE 1AB2', pending: true }],
        madeAt('2026-10-14T15:00:00Z'),
        [{ id: 'tx-p', posted: '2026-10-15T12:00:00Z', amount: '30.00', description: 'ZELLE FROM JANE DOE 1AB2' }],
      );
      expect(kinds(b)).toEqual([['DEPOSIT', null]]);
    });

    it('a stored pending deposit that posts under a NEW id stays a DEPOSIT too', async () => {
      const b = await storedThenRule(
        [{ id: 'tx-p', posted: '2026-10-13T12:00:00Z', amount: '30.00', description: 'ZELLE FROM JANE DOE 1AB2', pending: true }],
        madeAt('2026-10-14T15:00:00Z'),
        [{ id: 'tx-posted', posted: '2026-10-15T12:00:00Z', amount: '30.00', description: 'ZELLE FROM JANE DOE 1AB2' }],
      );
      expect(kinds(b)).toEqual([['DEPOSIT', null]]);
    });

    it('still lets the asReimbursement flag re-type an unlanded retype (Task 5 path unaffected)', async () => {
      const tx: Tx = { id: 'tx-1', posted: '2026-10-09T12:00:00Z', amount: '14.00', description: 'ZELLE FROM JANE DOE 8ZK1' };
      const a = createFakeHost(one([tx]));
      await runSyncCore(a.host, a.store, {});
      const flag = setTxOverride(emptySyncOverrides(), accountTxKey('sfin-1', 'tx-1'), 'asReimbursement', NOW, { label: 'x' });
      const b = createFakeHost(one([tx], { existing: new Map([['wf-a', a.activities.get('wf-a')!.map((r) => ({ ...r }))]]), mappingRules: [madeAt('2026-10-14T15:00:00Z') as never], syncOverrides: flag }));
      await runSyncCore(b.host, b.store, { force: true });
      expect(kinds(b)).toEqual([['CREDIT', 'REIMBURSEMENT']]);
    });
  });
});
