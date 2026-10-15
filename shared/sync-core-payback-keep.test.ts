import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { paybackMappingRule } from './mapper.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import { emptySyncOverrides, setTxOverride, clearTxOverride } from './sync-overrides.js';
import type { MappingRule } from './types.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const KEY = accountTxKey('sfin-1', 'tx-1');
const flagged = () => setTxOverride(emptySyncOverrides(), KEY, 'asReimbursement', NOW, { label: 'VENMO CASHOUT · Checking' });

const seed = (amount: string, extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
      transactions: [{ id: 'tx-1', posted: epoch('2026-10-09T12:00:00Z'), amount, description: 'VENMO CASHOUT 1023' }] },
  ] },
  mapping: { 'sfin-1': 'wf-a' },
  accountTypes: { 'wf-a': 'CASH' },
  ...extra,
});
const row = (fh: ReturnType<typeof createFakeHost>) => fh.activities.get('wf-a')!.find((r) => r.comment?.includes('tx-1'))!;
const writes = (fh: ReturnType<typeof createFakeHost>) => fh.saved.filter((r) => (r.updates ?? []).length > 0 || (r.creates ?? []).length > 0);
const carry = (fh: ReturnType<typeof createFakeHost>) => new Map([['wf-a', fh.activities.get('wf-a')!.map((r) => ({ ...r }))]]);

/** A payback stored by an earlier sync (flag or rule), then a sync that has neither. */
async function storedPayback(first: Partial<FakeHostSeed>) {
  const a = createFakeHost(seed('14.00', first));
  await runSyncCore(a.host, a.store, {});
  expect(row(a)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  return a;
}

describe('runSyncCore — a stored payback nobody decides is left as stored (I-1, I-2)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('probe G: removing the asReimbursement override keeps the row CREDIT/REIMBURSEMENT', async () => {
    const a = await storedPayback({ syncOverrides: flagged() });
    const b = createFakeHost(seed('14.00', { existing: carry(a), syncOverrides: emptySyncOverrides() }));
    await runSyncCore(b.host, b.store, { force: true });
    expect(row(b)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
    expect(writes(b)).toHaveLength(0);
  });

  it('probe B4: undoing the W10 transaction rule keeps the paybacks the rule made', async () => {
    const rule = paybackMappingRule('VENMO CASHOUT', 'wf-a', '2026-10-01') as MappingRule;
    const a = await storedPayback({ mappingRules: [rule as never] });
    const b = createFakeHost(seed('14.00', { existing: carry(a), mappingRules: [] }));
    await runSyncCore(b.host, b.store, { force: true });
    expect(row(b)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
    expect(writes(b)).toHaveLength(0);
  });

  it('a payback Undo (retyped to DEPOSIT) stays a DEPOSIT at the next sync', async () => {
    const a = await storedPayback({ syncOverrides: flagged() });
    const undone = carry(a);
    undone.get('wf-a')!.forEach((r) => { r.activityType = 'DEPOSIT'; r.subtype = null as never; });
    const cleared = clearTxOverride(flagged(), KEY, 'asReimbursement');
    const b = createFakeHost(seed('14.00', { existing: undone, syncOverrides: cleared }));
    await runSyncCore(b.host, b.store, { force: true });
    expect(row(b).activityType).toBe('DEPOSIT');
    expect(writes(b)).toHaveLength(0);
  });

  it('a hand-made CREDIT/REIMBURSEMENT in Wealthfolio is kept', async () => {
    const plain = createFakeHost(seed('14.00'));
    await runSyncCore(plain.host, plain.store, {});
    const hand = carry(plain);
    hand.get('wf-a')!.forEach((r) => { r.activityType = 'CREDIT'; r.subtype = 'REIMBURSEMENT'; });
    const b = createFakeHost(seed('14.00', { existing: hand }));
    await runSyncCore(b.host, b.store, { force: true });
    expect(row(b)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });

  it('an unknown account type keeps it too (listAccounts failed)', async () => {
    const a = await storedPayback({ syncOverrides: flagged() });
    const b = createFakeHost(seed('14.00', { existing: carry(a) }));
    const host = { ...b.host, listAccounts: async () => { throw new Error('down'); } };
    await runSyncCore(host, b.store, { force: true });
    expect(row(b)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });

  it('money out still yields: the stored payback becomes a WITHDRAWAL', async () => {
    const a = await storedPayback({ syncOverrides: flagged() });
    const b = createFakeHost(seed('-14.00', { existing: carry(a) }));
    await runSyncCore(b.host, b.store, { force: true });
    expect(row(b).activityType).toBe('WITHDRAWAL');
  });

  it('a KNOWN non-cash account still yields: the stored payback becomes a DEPOSIT', async () => {
    const a = await storedPayback({ syncOverrides: flagged() });
    const b = createFakeHost(seed('14.00', { existing: carry(a), accountTypes: { 'wf-a': 'SECURITIES' } }));
    await runSyncCore(b.host, b.store, { force: true });
    expect(row(b).activityType).toBe('DEPOSIT');
  });

  it('a non-payback stored row is still re-typed when the plain mapping changes (an in-transit TRANSFER_IN that expires)', async () => {
    const a = createFakeHost(seed('14.00', { mappingRules: [{ pattern: 'VENMO CASHOUT', matchType: 'contains', activityType: 'INTEREST' } as never] }));
    await runSyncCore(a.host, a.store, {});
    expect(row(a).activityType).toBe('INTEREST');
    const b = createFakeHost(seed('14.00', { existing: carry(a) }));
    await runSyncCore(b.host, b.store, { force: true });
    expect(row(b).activityType).toBe('DEPOSIT');
  });
});
