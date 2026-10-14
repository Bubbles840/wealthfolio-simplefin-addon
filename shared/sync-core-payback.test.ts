import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import { emptySyncOverrides, pruneTxOverrides, setTxOverride, type SyncOverrides } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const KEY = accountTxKey('sfin-1', 'tx-1');

const payback = (at: Date = NOW): SyncOverrides => setTxOverride(emptySyncOverrides(), KEY, 'asReimbursement', at, { label: 'VENMO CASHOUT · Checking' });

/** Checking (a cash account), whose feed carries one Venmo cash-out of `amount`. */
const seed = (amount: string, extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
      transactions: [{ id: 'tx-1', posted: epoch('2026-10-09T12:00:00Z'), amount, description: 'VENMO CASHOUT' }] },
  ] },
  mapping: { 'sfin-1': 'wf-a' },
  accountTypes: { 'wf-a': 'CASH' },
  accountNames: { 'wf-a': 'Checking' },
  ...extra,
});
const stored = (over: Partial<HostActivity> = {}): Map<string, HostActivity[]> => new Map([['wf-a', [{
  id: 'act-7', accountId: 'wf-a', activityType: 'CREDIT', subtype: 'REIMBURSEMENT', date: '2026-10-09', amount: 14,
  comment: 'VENMO CASHOUT · tx-1', sourceGroupId: null, ...over,
}]]]);
const row = (fh: ReturnType<typeof createFakeHost>) => fh.activities.get('wf-a')!.find((r) => r.comment?.endsWith('tx-1'))!;

describe('runSyncCore — a payback (asReimbursement)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is never reverted: a payback the feed calls a deposit stays a CREDIT marked REIMBURSEMENT, sync after sync', async () => {
    const fh = createFakeHost(seed('14.00', { existing: stored(), syncOverrides: payback() }));
    expect((await runSyncCore(fh.host, fh.store, {})).errors).toEqual([]);
    expect(fh.saved.filter((r) => (r.updates ?? []).length > 0 || (r.creates ?? []).length > 0)).toEqual([]);
    await runSyncCore(fh.host, fh.store, { force: true });
    expect(fh.saved.filter((r) => (r.updates ?? []).length > 0)).toEqual([]);
    expect(row(fh)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });

  it('makes a row whose re-type never landed a payback', async () => {
    const fh = createFakeHost(seed('14.00', { existing: stored({ activityType: 'DEPOSIT', subtype: null }), syncOverrides: payback() }));
    await runSyncCore(fh.host, fh.store, {});
    expect(row(fh)).toMatchObject({ id: 'act-7', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });

  it('imports a new row as a payback when the override came first', async () => {
    const fh = createFakeHost(seed('14.00', { syncOverrides: payback() }));
    await runSyncCore(fh.host, fh.store, {});
    expect(row(fh)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT', amount: 14 });
  });

  it('beats a keyword that would type it a transfer, and is never paired or linked', async () => {
    const fh = createFakeHost(seed('14.00', {
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
          transactions: [{ id: 'tx-1', posted: epoch('2026-10-09T12:00:00Z'), amount: '14.00', description: 'ONLINE TRANSFER FROM SAV' }] },
        { id: 'sfin-2', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
          transactions: [{ id: 'tx-2', posted: epoch('2026-10-09T12:00:00Z'), amount: '-14.00', description: 'ONLINE TRANSFER TO CHK' }] },
      ] },
      mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
      accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CASH' },
      syncOverrides: payback(),
    }));
    await runSyncCore(fh.host, fh.store, {});
    expect(row(fh)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT', sourceGroupId: null });
    expect(fh.links).toEqual([]);
  });

  it('yields when the bank turns it into money out: typed as usual', async () => {
    const fh = createFakeHost(seed('-14.00', { existing: stored(), syncOverrides: payback() }));
    await runSyncCore(fh.host, fh.store, {});
    expect(row(fh).activityType).toBe('WITHDRAWAL');
  });

  it('yields on an account that is not cash', async () => {
    const fh = createFakeHost(seed('14.00', { accountTypes: { 'wf-a': 'CREDIT_CARD' }, syncOverrides: payback() }));
    await runSyncCore(fh.host, fh.store, {});
    expect(row(fh)).toMatchObject({ activityType: 'CREDIT', subtype: null });
  });

  it('yields once its year runs out and the next overrides write prunes it', async () => {
    const lapsed = pruneTxOverrides(payback(new Date('2025-10-13T15:00:00Z')), NOW);
    expect(lapsed.tx).toEqual({});
    const fh = createFakeHost(seed('14.00', { existing: stored(), syncOverrides: lapsed }));
    await runSyncCore(fh.host, fh.store, {});
    expect(row(fh).activityType).toBe('DEPOSIT');
  });
  const writes = (fh: ReturnType<typeof createFakeHost>) => fh.saved.filter((r) => (r.updates ?? []).length > 0 || (r.creates ?? []).length > 0);
  const NOTE = 'Couldn\u2019t read your sync overrides \u2014 paybacks were left as they are.';

  it('keeps a payback when the account types cannot be read (an unknown type does not yield)', async () => {
    const fh = createFakeHost(seed('14.00', { existing: stored(), syncOverrides: payback() }));
    const host = { ...fh.host, listAccounts: async () => { throw new Error('down'); } };
    await runSyncCore(host, fh.store, {});
    expect(writes(fh)).toEqual([]);
    expect(row(fh)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });

  it.each([
    ['a rejected read', async () => { throw new Error('ECONNREFUSED'); }],
    ['a corrupt document', async () => ({ overrides: emptySyncOverrides(), unreadable: true })],
  ])('leaves a stored payback exactly as stored after %s, with one note', async (_n, read) => {
    const fh = createFakeHost(seed('14.00', { existing: stored() }));
    const store = { ...fh.store, readSyncOverrides: read };
    const result = await runSyncCore(fh.host, store, {});
    expect(writes(fh)).toEqual([]);
    expect(row(fh)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
    expect(result.errors.filter((e) => e.includes('sync overrides'))).toEqual([NOTE]);
  });

  it('keeps a stored payback whose date is the instant 2026-10-09T12:00:00Z', async () => {
    const fh = createFakeHost(seed('14.00', { existing: stored({ date: '2026-10-09T12:00:00Z' }), syncOverrides: payback() }));
    await runSyncCore(fh.host, fh.store, {});
    expect(writes(fh)).toEqual([]);
  });

  it('keeps a stored payback on a non-cash account (a subtype is only ever added)', async () => {
    const fh = createFakeHost(seed('14.00', { accountTypes: { 'wf-a': 'CREDIT_CARD' }, existing: stored(), syncOverrides: payback() }));
    await runSyncCore(fh.host, fh.store, {});
    expect(writes(fh)).toEqual([]);
  });

  it('still applies an override past its year until the next write prunes it (by design)', async () => {
    // Expiry is the next overrides WRITE\u2019s prune, not the sync\u2019s clock.
    const stale = payback(new Date('2025-10-13T15:00:00Z'));
    const fh = createFakeHost(seed('14.00', { existing: stored(), syncOverrides: stale }));
    await runSyncCore(fh.host, fh.store, {});
    expect(writes(fh)).toEqual([]);
  });

  it('leaves a transfer-typed leg under an asReimbursement key alone on a host that cannot read groups, with a note', async () => {
    const fh = createFakeHost(seed('14.00', { existing: stored({ activityType: 'TRANSFER_IN', subtype: null }), syncOverrides: payback() }));
    const host = { ...fh.host, capabilities: { readsSourceGroupId: false } };
    const result = await runSyncCore(host, fh.store, {});
    expect(writes(fh)).toEqual([]);
    expect(row(fh).activityType).toBe('TRANSFER_IN');
    expect(result.errors.some((e) => e.startsWith('Left ') && e.includes('as it is'))).toBe(true);
  });

  it.each([
    ['money out', seed('-14.00', { existing: stored(), syncOverrides: payback() })],
    ['a known non-cash account', seed('14.00', { accountTypes: { 'wf-a': 'CREDIT_CARD' }, existing: stored(), syncOverrides: payback() })],
  ])('logs one tagged line when the override yields on %s, without an errors note', async (_n, sd) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const fh = createFakeHost(sd);
      const result = await runSyncCore(fh.host, fh.store, {});
      const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('payback yielded'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('[simplefin-sync] payback yielded');
      expect(result.errors).toEqual([]);
    } finally {
      info.mockRestore();
    }
  });
});
