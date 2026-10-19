import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { badgeVerdict, runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { SimplefinTransaction } from './types.js';

const NOW = new Date('2026-10-18T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const tx = (id: string, iso: string, amount: string, description: string, pending = false): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description, ...(pending ? { pending: true } : {}) });

/** The Citi card, with one charge already stored, and Spend (cash, valued). */
const citiSeed = (balance: string, feed: SimplefinTransaction[], extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-citi', name: 'Citi Double Cash® Card', currency: 'USD', balance, 'balance-date': epoch('2026-10-18T12:00:00Z'),
      transactions: [tx('c-0', '2026-10-01T12:00:00Z', '-100.00', 'GROCERY'), ...feed] },
    { id: 'sfin-spend', name: 'Spend', currency: 'USD', balance: '500.00', 'balance-date': epoch('2026-10-18T12:00:00Z'), transactions: [] },
  ] },
  mapping: { 'sfin-citi': 'wf-citi', 'sfin-spend': 'wf-spend' },
  accountTypes: { 'wf-citi': 'CREDIT_CARD', 'wf-spend': 'CASH' },
  valuations: new Map([['wf-spend', 500]]),
  existing: new Map([['wf-citi', [{ id: 'old-0', accountId: 'wf-citi', activityType: 'WITHDRAWAL', date: '2026-10-01', amount: 100,
    comment: 'GROCERY · c-0', sourceGroupId: null, assetId: '$CASH-USD' }]]]),
  ...extra,
});
const NEW_CHARGE = tx('c-1', '2026-10-17T12:00:00Z', '-61.20', 'HARDWARE STORE');
const badge = async (fh: ReturnType<typeof createFakeHost>, sf = 'sfin-citi') =>
  (await fh.store.getAccountBalances())[sf] as { drift: number | null; measured?: boolean };

describe('badgeVerdict', () => {
  it('is in sync within a dollar, else off by bank − Wealthfolio to the cent', () => {
    expect(badgeVerdict(-161.2, -161.2)).toEqual({ drift: null, measured: true });
    expect(badgeVerdict(-161.2, -160.5)).toEqual({ drift: null, measured: true });
    expect(badgeVerdict(-200, -161.2)).toEqual({ drift: -38.8, measured: true });
  });
});

describe('runSyncCore — a card gets a real verdict after the run\'s own saves (B2, B3)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('a Sync that imports a new Citi charge shows Citi in sync when the total matches', async () => {
    const fh = createFakeHost(citiSeed('-161.20', [NEW_CHARGE], { cardTotals: true }));
    const result = await runSyncCore(fh.host, fh.store, { manual: true });
    expect(result.imported).toBe(1);
    expect(await badge(fh)).toMatchObject({ measured: true, drift: null });
  });

  it('and off by $X when it does not — on the badge only: no alert, no correction (R15)', async () => {
    const fh = createFakeHost(citiSeed('-200.00', [NEW_CHARGE], { cardTotals: true, driftAlertThreshold: 10 }));
    const result = await runSyncCore(fh.host, fh.store, { manual: true });
    expect(await badge(fh)).toMatchObject({ measured: true, drift: -38.8 });
    expect(result.balanceDriftAlerts).toEqual([]);
    expect(await fh.store.getDriftAlerts()).toEqual({});
    expect(fh.imported.flat()).toEqual([]);
  });

  it('checks a card with pending charges (B3)', async () => {
    const fh = createFakeHost(citiSeed('-161.20', [NEW_CHARGE, tx('c-p', '2026-10-18T12:00:00Z', '-15.00', 'COFFEE', true)], { cardTotals: true }));
    await runSyncCore(fh.host, fh.store, { manual: true });
    expect(await badge(fh)).toMatchObject({ measured: true, drift: null });
  });

  it('leaves a card holding an in-flight transfer leg "not checked"', async () => {
    const fh = createFakeHost(citiSeed('-118.80', [NEW_CHARGE, tx('pay', '2026-10-17T12:00:00Z', '42.40', 'AUTOPAY 000000000000000RAUTOPAY AUTO-PMT')], { cardTotals: true }));
    await runSyncCore(fh.host, fh.store, { manual: true });
    expect(await badge(fh)).toMatchObject({ measured: false, drift: null });
  });

  it('leaves the card "not checked" without the read (a scheduled app run, R7), or when the read fails', async () => {
    const without = createFakeHost(citiSeed('-161.20', [NEW_CHARGE]));
    await runSyncCore(without.host, without.store, {});
    expect(await badge(without)).toMatchObject({ measured: false });

    const failing = createFakeHost(citiSeed('-161.20', [NEW_CHARGE], { cardTotals: true }));
    failing.host.postedLedgerTotals = async () => { throw new Error('offline'); };
    const result = await runSyncCore(failing.host, failing.store, { manual: true });
    expect(result.errors).toEqual([]);
    expect(await badge(failing)).toMatchObject({ measured: false });
  });

  it('asks only about unvalued accounts left unchecked; a verdict the run already measured stands', async () => {
    // The companion's shape: a ledger figure before the saves (here stale by
    // $11.20) and a live total after. Nothing was imported, so the before-save
    // figure was trusted, and the after-save read is not consulted.
    const fh = createFakeHost(citiSeed('-100.00', [], { cardTotals: true, ledgerBalances: new Map([['wf-citi', -88.8]]) }));
    const asked: string[][] = [];
    const read = fh.host.postedLedgerTotals!.bind(fh.host);
    fh.host.postedLedgerTotals = async (accounts) => { asked.push(accounts.map((a) => a.wfAccountId)); return read(accounts); };
    await runSyncCore(fh.host, fh.store, { manual: true });
    expect(await badge(fh)).toMatchObject({ measured: true, drift: -11.2 });
    expect(asked).toEqual([]);
  });
});
