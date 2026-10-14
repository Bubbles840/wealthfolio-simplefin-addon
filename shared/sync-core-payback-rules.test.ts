import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { paybackMappingRule } from './mapper.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const RULE = paybackMappingRule('VENMO CASHOUT', 'wf-a');
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
    expect(posted.activities.get('wf-a')!.filter((r) => r.comment?.includes('tx-1'))).toHaveLength(1);
  });

  it('keeps a stored rule-typed pending row visible when the overrides cannot be read (not hidden, so no duplicate)', async () => {
    const fh = createFakeHost(seed('14.00', {}, true));
    await runSyncCore(fh.host, fh.store, {});
    const store = { ...fh.store, getSyncOverrides: async () => { throw new Error('down'); }, readSyncOverrides: async () => null };
    await runSyncCore(fh.host, store, { force: true });
    expect(fh.activities.get('wf-a')!.filter((r) => r.comment?.includes('tx-1'))).toHaveLength(1);
  });
});
