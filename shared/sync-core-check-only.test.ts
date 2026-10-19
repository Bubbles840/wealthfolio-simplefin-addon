import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { checkBalancesOnly, runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { SimplefinTransaction } from './types.js';

const NOW = new Date('2026-10-18T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const tx = (id: string, iso: string, amount: string, description: string, pending = false): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description, ...(pending ? { pending: true } : {}) });

/** Spend (cash, valued at $500) and the Citi card (one charge stored), both with something new this run. */
const seedOf = (spend: SimplefinTransaction[] = [tx('pay', '2026-10-17T12:00:00Z', '100.00', 'PAYROLL')]): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-spend', name: 'Spend', currency: 'USD', balance: '500.00', 'balance-date': epoch('2026-10-18T12:00:00Z'), transactions: spend },
    { id: 'sfin-citi', name: 'Citi Double Cash® Card', currency: 'USD', balance: '-161.20', 'balance-date': epoch('2026-10-18T12:00:00Z'),
      transactions: [tx('c-0', '2026-10-01T12:00:00Z', '-100.00', 'GROCERY'), tx('c-1', '2026-10-17T12:00:00Z', '-61.20', 'HARDWARE STORE')] },
  ] },
  mapping: { 'sfin-spend': 'wf-spend', 'sfin-citi': 'wf-citi' },
  accountTypes: { 'wf-spend': 'CASH', 'wf-citi': 'CREDIT_CARD' },
  valuations: new Map([['wf-spend', 500]]),
  cardTotals: true,
});
type Snap = { balance: number | null; drift: number | null; measured?: boolean; fetchedAt?: number; baselineFix?: unknown };
const snaps = async (fh: ReturnType<typeof createFakeHost>) => (await fh.store.getAccountBalances()) as Record<string, Snap>;

describe('checkBalancesOnly — a Sync inside the gap re-checks against the last download (C3, R9, R16)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('stamps every bank figure a download keeps with when that download was sent', async () => {
    const fh = createFakeHost(seedOf());
    await runSyncCore(fh.host, fh.store, { manual: true });
    const s = await snaps(fh);
    expect([s['sfin-spend'].fetchedAt, s['sfin-citi'].fetchedAt]).toEqual([NOW.getTime(), NOW.getTime()]);
    // The cash account imported a row this run, so its valuation was not trusted.
    expect(s['sfin-spend'].measured).toBe(false);
  });

  it('checks every account without asking SimpleFin or writing a row, and says how old the bank data is', async () => {
    const fh = createFakeHost(seedOf());
    await runSyncCore(fh.host, fh.store, { manual: true });
    const fetch = vi.spyOn(fh.host, 'fetchSimplefin');
    const saves = fh.saved.length;
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 60_000));
    const { dataAt } = await checkBalancesOnly(fh.host, fh.store, { mapping: { 'sfin-spend': 'wf-spend', 'sfin-citi': 'wf-citi' }, newestRequestAt: NOW.getTime() });
    expect(dataAt).toBe(NOW.getTime());
    expect(fetch).not.toHaveBeenCalled();
    expect(fh.saved.length).toBe(saves);
    const s = await snaps(fh);
    expect(s['sfin-spend']).toMatchObject({ balance: 500, measured: true, drift: null, fetchedAt: NOW.getTime() });
    expect(s['sfin-citi']).toMatchObject({ balance: -161.2, measured: true, drift: null });
  });

  it('reports a cash account off by its difference from the valuation', async () => {
    const seed = seedOf();
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, { manual: true });
    seed.valuations!.set('wf-spend', 450);
    await checkBalancesOnly(fh.host, fh.store, { mapping: seed.mapping!, newestRequestAt: NOW.getTime() });
    expect((await snaps(fh))['sfin-spend']).toMatchObject({ measured: true, drift: 50 });
  });

  it('leaves a cash account with a pending row "not checked"', async () => {
    const seed = seedOf([tx('pend', '2026-10-18T12:00:00Z', '-20.00', 'COFFEE', true)]);
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, { manual: true });
    await checkBalancesOnly(fh.host, fh.store, { mapping: seed.mapping!, newestRequestAt: NOW.getTime() });
    expect((await snaps(fh))['sfin-spend']).toMatchObject({ measured: false, drift: null });
  });

  it('checks nothing while a newer download than the stored figures is in flight (R16)', async () => {
    const seed = seedOf();
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, { manual: true });
    const { dataAt } = await checkBalancesOnly(fh.host, fh.store, { mapping: seed.mapping!, newestRequestAt: NOW.getTime() + 60_000 });
    expect(dataAt).toBeNull();
    const s = await snaps(fh);
    expect([s['sfin-spend'].measured, s['sfin-citi'].measured]).toEqual([false, false]);
  });

  it('never calls a snapshot written without fetchedAt (an older writer) in sync', async () => {
    const seed = seedOf();
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, { manual: true });
    const s = await snaps(fh);
    const { fetchedAt: _old, ...olderWriter } = s['sfin-spend'];
    await fh.store.setAccountBalances({ ...s, 'sfin-spend': { ...olderWriter, measured: true, drift: null } });
    await checkBalancesOnly(fh.host, fh.store, { mapping: seed.mapping!, newestRequestAt: NOW.getTime() });
    expect((await snaps(fh))['sfin-spend']).toMatchObject({ measured: false, drift: null });
  });

  it('keeps every other snapshot and drops a stale baseline-fix offer', async () => {
    const seed = seedOf();
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, { manual: true });
    const s = await snaps(fh);
    await fh.store.setAccountBalances({
      ...s,
      'sfin-spend': { ...s['sfin-spend'], baselineFix: { activityId: 'sb-1', currentAmount: 10, suggestedAmount: 12 } },
      'sfin-old': { balance: 1, currency: 'USD', date: 0, drift: null },
    });
    await checkBalancesOnly(fh.host, fh.store, { mapping: seed.mapping!, newestRequestAt: NOW.getTime() });
    const after = await snaps(fh);
    expect(after['sfin-spend'].baselineFix).toBeUndefined();
    expect(after['sfin-old']).toEqual({ balance: 1, currency: 'USD', date: 0, drift: null });
  });

  it('tags every verdict it fills badge only, so a check-only drift never gets the Home plug (R15)', async () => {
    const seed = seedOf();
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, { manual: true });
    seed.valuations!.set('wf-spend', 450);
    await checkBalancesOnly(fh.host, fh.store, { mapping: seed.mapping!, newestRequestAt: NOW.getTime() });
    const s = (await snaps(fh)) as Record<string, Snap & { checkedAfterSave?: true }>;
    expect(s['sfin-spend']).toMatchObject({ measured: true, drift: 50, checkedAfterSave: true });
    expect(s['sfin-citi']).toMatchObject({ measured: true, checkedAfterSave: true });
  });
});
