import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { IN_TRANSIT_COMMENT_PREFIX, runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { SimplefinTransaction } from './types.js';

const NOW = new Date('2026-10-18T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const CITI_PAYMENT = '*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR';

/** PNC "Spend" and the Citi card, both connected; the Citi feed refreshed now
 *  unless `citiAlive` says otherwise. */
const pncAndCiti = (spend: SimplefinTransaction[], citi: SimplefinTransaction[] = [], extra: Partial<FakeHostSeed> = {}, citiAlive = NOW.toISOString()): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-spend', name: 'Spend', org: { name: 'PNC Bank' }, currency: 'USD', balance: '0',
      'balance-date': epoch('2026-10-18T12:00:00Z'), transactions: spend },
    { id: 'sfin-citi', name: 'Citi Double Cash® Card', org: { name: 'Citibank' }, currency: 'USD', balance: '0',
      'balance-date': epoch(citiAlive), transactions: citi },
  ] },
  mapping: { 'sfin-spend': 'wf-spend', 'sfin-citi': 'wf-citi' },
  accountTypes: { 'wf-spend': 'CASH', 'wf-citi': 'CREDIT_CARD' },
  ...extra,
});
const tx = (id: string, iso: string, amount: string, description: string, pending = false): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description, ...(pending ? { pending: true } : {}) });
const rowOf = (rows: HostActivity[] | undefined, txId: string) => (rows ?? []).find((r) => (r.comment ?? '').includes(` · ${txId}`));
const inTransit = (r: HostActivity | undefined) => (r?.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX);

describe('runSyncCore — a payment naming a connected account is a transfer from the moment it posts (A)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("holds PNC's Citi autopay as an in-transit placeholder, then links it when Citi's half posts", async () => {
    // Live, 2026-10-17: PNC posted first and the $42.40 asked for a category.
    // Both syncs run on ONE fake host (a second host restarts its ids at fh-1 and
    // would give the two linked legs the same id); the fake serves the seed's
    // accountSet by reference, so Citi's half is pushed into it between runs.
    const seed = pncAndCiti([tx('pnc-1', '2026-10-17T12:00:00Z', '-42.40', CITI_PAYMENT)]);
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, {});
    const held = rowOf(fh.activities.get('wf-spend'), 'pnc-1');
    expect(held).toMatchObject({ activityType: 'TRANSFER_OUT', amount: 42.4 });
    expect(inTransit(held)).toBe(true);
    expect(fh.links).toEqual([]);

    vi.setSystemTime(new Date('2026-10-19T15:00:00Z'));
    const citi = seed.accountSet!.accounts.find((a) => a.id === 'sfin-citi')!;
    citi.transactions!.push(tx('citi-1', '2026-10-19T12:00:00Z', '42.40', 'AUTOPAY 000000000000000RAUTOPAY AUTO-PMT'));
    citi['balance-date'] = epoch('2026-10-19T12:00:00Z');
    await runSyncCore(fh.host, fh.store, { force: true });
    expect(fh.links).toHaveLength(1);
    const out = rowOf(fh.activities.get('wf-spend'), 'pnc-1');
    const into = rowOf(fh.activities.get('wf-citi'), 'citi-1');
    expect([out?.activityType, into?.activityType]).toEqual(['TRANSFER_OUT', 'TRANSFER_IN']);
    expect(inTransit(out)).toBe(false);
    expect(fh.activities.get('wf-spend')).toHaveLength(1);
    expect(fh.activities.get('wf-citi')).toHaveLength(1);
    expect(out!.id).not.toBe(into!.id);
  });

  it("holds PNC's pending wording too: a pending row never pairs, but it is a placeholder", async () => {
    const seed = pncAndCiti([tx('pnc-p', '2026-10-17T12:00:00Z', '-55.00', 'ACH DEBIT ROBINHOOD CCB', true)]);
    seed.accountSet!.accounts.push({ id: 'sfin-rh', name: 'Robinhood Credit Card', currency: 'USD', balance: '0',
      'balance-date': epoch('2026-10-18T12:00:00Z'), transactions: [] });
    seed.mapping!['sfin-rh'] = 'wf-rh';
    seed.accountTypes!['wf-rh'] = 'CREDIT_CARD';
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, {});
    const held = rowOf(fh.activities.get('wf-spend'), 'pnc-p');
    expect(held?.activityType).toBe('TRANSFER_OUT');
    expect(inTransit(held)).toBe(true);
  });

  it('leaves alone: money in, bills naming no account, a card charge, a ruled row, an undone row, and a row naming only its own account', async () => {
    const seed = pncAndCiti([
      tx('gas', '2026-10-15T12:00:00Z', '-61.20', '*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT'),
      tx('venmo', '2026-10-15T12:00:00Z', '-25.00', '*8768 PAYMENT VENMO ACH WEB'),
      tx('ruled', '2026-10-16T12:00:00Z', '-42.40', CITI_PAYMENT),
      tx('undone', '2026-10-16T12:00:00Z', '-77.00', 'PAYMENT ROBINHOOD CCB ACH DEBIT'),
    ], [tx('card-neg', '2026-10-16T12:00:00Z', '-19.99', 'ROBINHOOD PAYMENT')], {
      mappingRules: [{ pattern: 'PAYMENT CITI AUTOPAY', matchType: 'contains', activityType: 'WITHDRAWAL' }],
      syncOverrides: setTxOverride(emptySyncOverrides(), accountTxKey('sfin-spend', 'undone'), 'notTransfer', NOW),
    });
    seed.accountSet!.accounts.push(
      { id: 'sfin-rh', name: 'Robinhood Credit Card', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-18T12:00:00Z'), transactions: [] },
      { id: 'sfin-rhi', name: 'Robinhood individual', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-18T12:00:00Z'),
        transactions: [tx('cashback', '2026-10-16T12:00:00Z', '12.67', 'Credit card cashback rewards of $12.67 transferred to Robinhood Brokerage account')] },
      { id: 'sfin-360', name: '360 Checking', org: { name: 'Capital One' }, currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-18T12:00:00Z'),
        transactions: [tx('own', '2026-10-16T12:00:00Z', '-100.00', 'RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT')] },
    );
    Object.assign(seed.mapping!, { 'sfin-rh': 'wf-rh', 'sfin-rhi': 'wf-rhi', 'sfin-360': 'wf-360' });
    Object.assign(seed.accountTypes!, { 'wf-rh': 'CREDIT_CARD', 'wf-rhi': 'CASH', 'wf-360': 'CASH' });
    const fh = createFakeHost(seed);
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(result.errors).toEqual([]);
    const typed = (wf: string, id: string) => {
      const r = rowOf(fh.activities.get(wf), id);
      return [r?.activityType, inTransit(r)];
    };
    expect(typed('wf-spend', 'gas')).toEqual(['WITHDRAWAL', false]);
    expect(typed('wf-spend', 'venmo')).toEqual(['WITHDRAWAL', false]);
    expect(typed('wf-spend', 'ruled')).toEqual(['WITHDRAWAL', false]);
    expect(typed('wf-spend', 'undone')).toEqual(['WITHDRAWAL', false]);
    expect(typed('wf-citi', 'card-neg')).toEqual(['WITHDRAWAL', false]);
    expect(typed('wf-rhi', 'cashback')).toEqual(['DEPOSIT', false]);
    expect(typed('wf-360', 'own')).toEqual(['WITHDRAWAL', false]);
  });

  it('past the 10 days it gives up: ordinary spending, marked Needs review', async () => {
    const fh = createFakeHost(pncAndCiti([tx('pnc-old', '2026-10-05T12:00:00Z', '-42.40', CITI_PAYMENT)]));
    await runSyncCore(fh.host, fh.store, {});
    const create = fh.saved.flatMap((r) => r.creates ?? []).find((c) => c.comment.includes('pnc-old'))!;
    expect(create).toMatchObject({ activityType: 'WITHDRAWAL', needsReview: true });
    expect(create.comment.startsWith(IN_TRANSIT_COMMENT_PREFIX)).toBe(false);
  });

  it("past the 10 days, a dead Citi feed still holds the payment that names it", async () => {
    const fh = createFakeHost(pncAndCiti([tx('pnc-old', '2026-10-05T12:00:00Z', '-42.40', CITI_PAYMENT)], [], {}, '2026-08-18T12:00:00Z'));
    await runSyncCore(fh.host, fh.store, {});
    const held = rowOf(fh.activities.get('wf-spend'), 'pnc-old');
    expect(held?.activityType).toBe('TRANSFER_OUT');
    expect(inTransit(held)).toBe(true);
  });

  it('a payment already stored as a WITHDRAWAL (before 1.63) becomes the placeholder within two syncs, as one row', async () => {
    // The first sync retypes it TRANSFER_OUT and the relink sweep re-creates it
    // asset-free from the comment it read, so the in-transit marker lands on
    // the second sync (follow-up: the sweep could carry the marker itself).
    const fh = createFakeHost(pncAndCiti([tx('pnc-1', '2026-10-17T12:00:00Z', '-42.40', CITI_PAYMENT)], [], {
      existing: new Map([['wf-spend', [{ id: 'old-1', accountId: 'wf-spend', activityType: 'WITHDRAWAL', date: '2026-10-17', amount: 42.4,
        comment: `${CITI_PAYMENT} · pnc-1`, sourceGroupId: null, assetId: '$CASH-USD' }]]]),
    }));
    for (let run = 0; run < 2; run += 1) {
      const r = await runSyncCore(fh.host, fh.store, { force: true });
      expect(r.errors).toEqual([]);
    }
    const rows = fh.activities.get('wf-spend')!;
    expect(rows).toHaveLength(1);
    expect(rows[0].activityType).toBe('TRANSFER_OUT');
    expect(inTransit(rows[0])).toBe(true);
  });
});
