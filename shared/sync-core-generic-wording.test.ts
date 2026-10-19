import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { IN_TRANSIT_COMMENT_PREFIX, runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import type { SimplefinAccount, SimplefinTransaction } from './types.js';

const NOW = new Date('2026-10-19T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const tx = (id: string, iso: string, amount: string, description: string): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description });
const account = (id: string, name: string, transactions: SimplefinTransaction[], org?: string): SimplefinAccount => ({
  id, name, currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-19T12:00:00Z'), transactions, ...(org ? { org: { name: org } } : {}),
});
/** Checking (Northwind Bank) and Harbor Savings, both cash, both feeds current. */
const seedOf = (chk: SimplefinTransaction[], sav: SimplefinTransaction[] = [], extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [account('sfin-chk', 'Checking', chk, 'Northwind Bank'), account('sfin-sav', 'Harbor Savings', sav)] },
  mapping: { 'sfin-chk': 'wf-chk', 'sfin-sav': 'wf-sav' },
  accountTypes: { 'wf-chk': 'CASH', 'wf-sav': 'CASH' },
  ...extra,
});
const rowOf = (rows: HostActivity[] | undefined, txId: string) => (rows ?? []).find((r) => (r.comment ?? '').includes(` · ${txId}`));
const typed = (rows: HostActivity[] | undefined, txId: string) => {
  const r = rowOf(rows, txId);
  return [r?.activityType, (r?.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX)];
};

describe('runSyncCore — generic transfer wording needs corroboration for money going out (1.65 B)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('books a wire to a third party as an ordinary withdrawal, never held (issue #13)', async () => {
    const fh = createFakeHost(seedOf([tx('w-1', '2026-10-17T12:00:00Z', '-250.00', 'WIRE TRANSFER TO ACME LLC')]));
    const r = await runSyncCore(fh.host, fh.store, {});
    expect(r.errors).toEqual([]);
    expect(typed(fh.activities.get('wf-chk'), 'w-1')).toEqual(['WITHDRAWAL', false]);
  });

  it('holds generic wording that names another connected account, or matches a learned out name', async () => {
    const fh = createFakeHost(seedOf([
      tx('o-1', '2026-10-17T12:00:00Z', '-300.00', 'ONLINE TRANSFER TO HARBOR SAVINGS XXXXXX0000'),
      tx('o-2', '2026-10-17T12:00:00Z', '-40.00', 'ONLINE TRANSFER TO SHARED POT'),
    ], [], {
      transferNames: { version: 1, computedAt: '2026-10-19T14:00:00.000Z', names: [
        { accountId: 'wf-chk', direction: 'out', signature: 'online transfer to shared pot' },
      ] },
    }));
    await runSyncCore(fh.host, fh.store, {});
    expect(typed(fh.activities.get('wf-chk'), 'o-1')).toEqual(['TRANSFER_OUT', true]);
    expect(typed(fh.activities.get('wf-chk'), 'o-2')).toEqual(['TRANSFER_OUT', true]);
  });

  it('leaves alone: money in, the institution phrases, and a rule', async () => {
    const fh = createFakeHost(seedOf([
      tx('in-1', '2026-10-17T12:00:00Z', '900.00', 'WIRE TRANSFER FROM ACME LLC'),
      tx('pnc-1', '2026-10-17T12:00:00Z', '-75.00', 'PNC BANK ONLINE TRANSFER 0000'),
      tx('ruled', '2026-10-17T12:00:00Z', '-500.00', 'WIRE TRANSFER TO PAYROLL CO'),
    ], [], {
      mappingRules: [{ pattern: 'WIRE TRANSFER TO PAYROLL CO', matchType: 'contains', activityType: 'TRANSFER_OUT' }],
    }));
    await runSyncCore(fh.host, fh.store, {});
    const rows = fh.activities.get('wf-chk');
    expect(typed(rows, 'in-1')[1]).toBe(true);
    expect(typed(rows, 'pnc-1')).toEqual(['TRANSFER_OUT', true]);
    expect(typed(rows, 'ruled')).toEqual(['TRANSFER_OUT', true]);
  });

  it('still links a generic out booked as a withdrawal when its other half posts within 5 days', async () => {
    // Both syncs on ONE fake host; the fake serves the seed's accountSet by reference.
    const seed = seedOf([tx('o-3', '2026-10-18T12:00:00Z', '-120.00', 'ONLINE TRANSFER 0000')]);
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, {});
    expect(typed(fh.activities.get('wf-chk'), 'o-3')).toEqual(['WITHDRAWAL', false]);

    vi.setSystemTime(new Date('2026-10-20T15:00:00Z'));
    seed.accountSet!.accounts.find((a) => a.id === 'sfin-sav')!.transactions!.push(
      tx('i-3', '2026-10-20T12:00:00Z', '120.00', 'DEPOSIT FROM CHECKING 0000'),
    );
    const r = await runSyncCore(fh.host, fh.store, { force: true });
    expect(r.errors).toEqual([]);
    expect(fh.links).toHaveLength(1);
    expect(typed(fh.activities.get('wf-chk'), 'o-3')).toEqual(['TRANSFER_OUT', false]);
    expect(typed(fh.activities.get('wf-sav'), 'i-3')).toEqual(['TRANSFER_IN', false]);
    expect(fh.activities.get('wf-chk')).toHaveLength(1);
    expect(fh.activities.get('wf-sav')).toHaveLength(1);
  });
});
