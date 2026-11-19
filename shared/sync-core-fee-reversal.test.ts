import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { SimplefinTransaction } from './types.js';

const NOW = new Date('2026-11-18T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const REFUND = 'OVERDRAFT FEE REFUND';
const tx = (id: string, iso: string, amount: string, description: string): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description });

/** PNC checking (cash) and a Citi card; `other` is a second cash account. */
const seedOf = (feeds: { chk?: SimplefinTransaction[]; card?: SimplefinTransaction[]; other?: SimplefinTransaction[] }, extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-chk', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-11-18T12:00:00Z'), transactions: feeds.chk ?? [] },
    { id: 'sfin-card', name: 'Citi', currency: 'USD', balance: '0', 'balance-date': epoch('2026-11-18T12:00:00Z'), transactions: feeds.card ?? [] },
    { id: 'sfin-oth', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': epoch('2026-11-18T12:00:00Z'), transactions: feeds.other ?? [] },
  ] },
  mapping: { 'sfin-chk': 'wf-chk', 'sfin-card': 'wf-card', 'sfin-oth': 'wf-oth' },
  accountTypes: { 'wf-chk': 'CASH', 'wf-card': 'CREDIT_CARD', 'wf-oth': 'CASH' },
  ...extra,
});
const rowOf = (fh: ReturnType<typeof createFakeHost>, wf: string, txId: string): HostActivity | undefined =>
  (fh.activities.get(wf) ?? []).find((r) => (r.comment ?? '').includes(` · ${txId}`));
const carry = (fh: ReturnType<typeof createFakeHost>) => new Map([...fh.activities].map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));

describe('runSyncCore — fee reversals are refunds, never income or a transfer half (#79)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('imports a cash fee reversal as CREDIT/REFUND and a card one too', async () => {
    const fh = createFakeHost(seedOf({
      chk: [tx('t-1', '2026-11-10T12:00:00Z', '35.00', REFUND)],
      card: [tx('t-2', '2026-11-10T12:00:00Z', '40.00', 'LATE PAYMENT FEE REVERSAL')],
    }));
    await runSyncCore(fh.host, fh.store, {});
    expect(rowOf(fh, 'wf-chk', 't-1')).toMatchObject({ activityType: 'CREDIT', subtype: 'REFUND' });
    expect(rowOf(fh, 'wf-card', 't-2')).toMatchObject({ activityType: 'CREDIT', subtype: 'REFUND' });
  });

  it('retypes a fee reversal stored as a DEPOSIT', async () => {
    const a = createFakeHost(seedOf({ chk: [tx('t-1', '2026-11-10T12:00:00Z', '35.00', REFUND)] }));
    await runSyncCore(a.host, a.store, {});
    const old = carry(a);
    old.get('wf-chk')!.forEach((r) => { r.activityType = 'DEPOSIT'; r.subtype = null as never; });
    const b = createFakeHost(seedOf({ chk: [tx('t-1', '2026-11-10T12:00:00Z', '35.00', REFUND)] }, { existing: old }));
    await runSyncCore(b.host, b.store, { force: true });
    expect(rowOf(b, 'wf-chk', 't-1')).toMatchObject({ activityType: 'CREDIT', subtype: 'REFUND' });

    // The retype settles: a further sync plans no update for that row.
    const c = createFakeHost(seedOf({ chk: [tx('t-1', '2026-11-10T12:00:00Z', '35.00', REFUND)] }, { existing: carry(b) }));
    await runSyncCore(c.host, c.store, { force: true });
    const updates = c.saved.flatMap((req) => req.updates ?? []);
    expect(updates).toEqual([]);
  });

  it('is never paired with a same-amount outflow in another account', async () => {
    const fh = createFakeHost(seedOf({
      chk: [tx('t-in', '2026-11-10T12:00:00Z', '35.00', REFUND)],
      other: [tx('t-out', '2026-11-09T12:00:00Z', '-35.00', 'ZELLE TO JOE')],
    }));
    await runSyncCore(fh.host, fh.store, {});
    expect(rowOf(fh, 'wf-chk', 't-in')).toMatchObject({ activityType: 'CREDIT', subtype: 'REFUND' });
    expect(rowOf(fh, 'wf-oth', 't-out')?.activityType).toBe('WITHDRAWAL');
    expect(fh.links).toEqual([]);
  });

  it('is never typed a transfer by a learned name', async () => {
    const fh = createFakeHost(seedOf({ chk: [tx('t-1', '2026-11-10T12:00:00Z', '35.00', REFUND)] }, {
      transferNames: { version: 1, computedAt: '2026-11-18T14:00:00.000Z', names: [{ accountId: 'wf-chk', direction: 'in', signature: 'overdraft fee refund' }] },
    }));
    await runSyncCore(fh.host, fh.store, {});
    expect(rowOf(fh, 'wf-chk', 't-1')).toMatchObject({ activityType: 'CREDIT', subtype: 'REFUND' });
  });

  it('keeps a stored payback a payback (never REFUND)', async () => {
    const a = createFakeHost(seedOf({ chk: [tx('t-1', '2026-11-10T12:00:00Z', '35.00', REFUND)] }));
    await runSyncCore(a.host, a.store, {});
    const hand = carry(a);
    hand.get('wf-chk')!.forEach((r) => { r.activityType = 'CREDIT'; r.subtype = 'REIMBURSEMENT'; });
    const b = createFakeHost(seedOf({ chk: [tx('t-1', '2026-11-10T12:00:00Z', '35.00', REFUND)] }, { existing: hand }));
    await runSyncCore(b.host, b.store, { force: true });
    expect(rowOf(b, 'wf-chk', 't-1')).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });

  it('lets the payback override win', async () => {
    const overrides = setTxOverride(emptySyncOverrides(), accountTxKey('sfin-chk', 't-1'), 'asReimbursement', NOW, { label: REFUND });
    const fh = createFakeHost(seedOf({ chk: [tx('t-1', '2026-11-10T12:00:00Z', '35.00', REFUND)] }, { syncOverrides: overrides }));
    await runSyncCore(fh.host, fh.store, {});
    expect(rowOf(fh, 'wf-chk', 't-1')).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });
});
