import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { IN_TRANSIT_COMMENT_PREFIX, runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { LearnedTransferName } from './transfer-names.js';
import type { SimplefinAccount, SimplefinTransaction } from './types.js';

const NOW = new Date('2026-10-18T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const SAVINGS_TO_SPEND = 'RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT';
const TO_PERFORMANCE = 'Withdrawal to 360 Performance Savings XXXXXX1580';

const tx = (id: string, iso: string, amount: string, description: string, pending = false): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description, ...(pending ? { pending: true } : {}) });
const account = (id: string, name: string, transactions: SimplefinTransaction[], org?: string): SimplefinAccount => ({
  id, name, currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-18T12:00:00Z'), transactions, ...(org ? { org: { name: org } } : {}),
});
const names = (...list: LearnedTransferName[]) => ({ version: 1 as const, computedAt: '2026-10-18T14:00:00.000Z', names: list });
const SPEND_IN: LearnedTransferName = { accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' };
const CHECKING_OUT: LearnedTransferName = { accountId: 'wf-360', direction: 'out', signature: 'withdrawal to performance savings' };

/** Spend (PNC), Savings, 360 Checking and 360 Performance Savings, all cash. */
const seedOf = (feeds: Partial<Record<'spend' | 'sav' | '360' | 'perf', SimplefinTransaction[]>>, extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    account('sfin-spend', 'Spend', feeds.spend ?? [], 'PNC Bank'),
    account('sfin-sav', 'Savings', feeds.sav ?? []),
    account('sfin-360', '360 Checking', feeds['360'] ?? [], 'Capital One'),
    account('sfin-perf', '360 Performance Savings', feeds.perf ?? [], 'Capital One'),
  ] },
  mapping: { 'sfin-spend': 'wf-spend', 'sfin-sav': 'wf-sav', 'sfin-360': 'wf-360', 'sfin-perf': 'wf-perf' },
  accountTypes: { 'wf-spend': 'CASH', 'wf-sav': 'CASH', 'wf-360': 'CASH', 'wf-perf': 'CASH' },
  ...extra,
});
const rowOf = (rows: HostActivity[] | undefined, txId: string) => (rows ?? []).find((r) => (r.comment ?? '').includes(` · ${txId}`));
const inTransit = (r: HostActivity | undefined) => (r?.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX);

describe('runSyncCore — learned transfer names hold a transfer whichever half posts first (A5)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('holds the savings → Spend deposit as an in-transit TRANSFER_IN, then links it when the savings half posts', async () => {
    // Both syncs on ONE fake host (a second host restarts its ids at fh-1).
    const seed = seedOf({ spend: [tx('in-1', '2026-10-17T12:00:00Z', '600.00', SAVINGS_TO_SPEND)] }, { transferNames: names(SPEND_IN) });
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, {});
    const held = rowOf(fh.activities.get('wf-spend'), 'in-1');
    // A cash inflow placeholder is a bare CREDIT: neither income nor spending.
    expect(held?.activityType).toBe('CREDIT');
    expect(inTransit(held)).toBe(true);

    vi.setSystemTime(new Date('2026-10-19T15:00:00Z'));
    seed.accountSet!.accounts.find((a) => a.id === 'sfin-sav')!.transactions!.push(
      tx('out-1', '2026-10-18T12:00:00Z', '-600.00', 'Withdrawal to PNC Bank XXXXXX0000'),
    );
    await runSyncCore(fh.host, fh.store, { force: true });
    expect(fh.links).toHaveLength(1);
    const into = rowOf(fh.activities.get('wf-spend'), 'in-1');
    const out = rowOf(fh.activities.get('wf-sav'), 'out-1');
    expect([out?.activityType, into?.activityType]).toEqual(['TRANSFER_OUT', 'TRANSFER_IN']);
    expect(inTransit(into)).toBe(false);
    expect(fh.activities.get('wf-spend')).toHaveLength(1);
  });

  it('with no partner, past 10 days it becomes an ordinary deposit marked Needs review', async () => {
    const fh = createFakeHost(seedOf({ spend: [tx('in-old', '2026-10-05T12:00:00Z', '600.00', SAVINGS_TO_SPEND)] }, { transferNames: names(SPEND_IN) }));
    await runSyncCore(fh.host, fh.store, {});
    const create = fh.saved.flatMap((r) => r.creates ?? []).find((c) => c.comment.includes('in-old'))!;
    expect(create).toMatchObject({ activityType: 'DEPOSIT', needsReview: true });
    expect(create.comment.startsWith(IN_TRANSIT_COMMENT_PREFIX)).toBe(false);
  });

  it("holds 360 Checking's withdrawal to Performance Savings from a past link, and a pending one too", async () => {
    const fh = createFakeHost(seedOf({ '360': [
      tx('w-1', '2026-10-17T12:00:00Z', '-500.00', TO_PERFORMANCE),
      tx('w-p', '2026-10-18T12:00:00Z', '-25.00', TO_PERFORMANCE, true),
    ] }, { transferNames: names(CHECKING_OUT) }));
    await runSyncCore(fh.host, fh.store, {});
    for (const id of ['w-1', 'w-p']) {
      const held = rowOf(fh.activities.get('wf-360'), id);
      expect([id, held?.activityType, inTransit(held)]).toEqual([id, 'TRANSFER_OUT', true]);
    }
  });

  it('without the list, every one of those rows is typed exactly as before (R6)', async () => {
    const fh = createFakeHost(seedOf({
      spend: [tx('in-1', '2026-10-17T12:00:00Z', '600.00', SAVINGS_TO_SPEND)],
      '360': [tx('w-1', '2026-10-17T12:00:00Z', '-500.00', TO_PERFORMANCE)],
    }));
    await runSyncCore(fh.host, fh.store, {});
    expect(rowOf(fh.activities.get('wf-spend'), 'in-1')?.activityType).toBe('DEPOSIT');
    expect(rowOf(fh.activities.get('wf-360'), 'w-1')?.activityType).toBe('WITHDRAWAL');
  });

  it('leaves alone: a bill, cashback never linked, the other direction, a card, and a row the person undid', async () => {
    const seed = seedOf({
      spend: [
        tx('gas', '2026-10-15T12:00:00Z', '-61.20', '*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT'),
        tx('undone', '2026-10-16T12:00:00Z', '80.00', SAVINGS_TO_SPEND),
      ],
      '360': [tx('dir', '2026-10-16T12:00:00Z', '500.00', TO_PERFORMANCE)],
    }, {
      transferNames: names(SPEND_IN, CHECKING_OUT, { accountId: 'wf-citi', direction: 'out', signature: 'amazon mktpl' }),
      syncOverrides: setTxOverride(emptySyncOverrides(), accountTxKey('sfin-spend', 'undone'), 'notTransfer', NOW),
    });
    seed.accountSet!.accounts.push(
      account('sfin-citi', 'Citi Double Cash® Card', [tx('card', '2026-10-16T12:00:00Z', '-19.99', 'AMAZON MKTPL')]),
      account('sfin-rhi', 'Robinhood individual', [tx('cashback', '2026-10-16T12:00:00Z', '12.67', 'Credit card cashback rewards of $12.67 transferred to Robinhood Brokerage account')]),
    );
    Object.assign(seed.mapping!, { 'sfin-citi': 'wf-citi', 'sfin-rhi': 'wf-rhi' });
    Object.assign(seed.accountTypes!, { 'wf-citi': 'CREDIT_CARD', 'wf-rhi': 'CASH' });
    const fh = createFakeHost(seed);
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(result.errors).toEqual([]);
    const typed = (wf: string, id: string) => {
      const r = rowOf(fh.activities.get(wf), id);
      return [id, r?.activityType, inTransit(r)];
    };
    expect(typed('wf-spend', 'gas')).toEqual(['gas', 'WITHDRAWAL', false]);
    expect(typed('wf-spend', 'undone')).toEqual(['undone', 'DEPOSIT', false]);
    expect(typed('wf-360', 'dir')).toEqual(['dir', 'DEPOSIT', false]);
    expect(typed('wf-citi', 'card')).toEqual(['card', 'WITHDRAWAL', false]);
    expect(typed('wf-rhi', 'cashback')).toEqual(['cashback', 'DEPOSIT', false]);
  });

  it('never overrides a rule', async () => {
    const fh = createFakeHost(seedOf({ sav: [tx('ruled', '2026-10-16T12:00:00Z', '75.00', 'Deposit from PNC Bank XXXXXX0000')] }, {
      transferNames: names({ accountId: 'wf-sav', direction: 'in', signature: 'deposit from pnc bank' }),
      mappingRules: [{ pattern: 'Deposit from PNC', matchType: 'contains', activityType: 'DEPOSIT' }],
    }));
    await runSyncCore(fh.host, fh.store, {});
    const r = rowOf(fh.activities.get('wf-sav'), 'ruled');
    expect([r?.activityType, inTransit(r)]).toEqual(['DEPOSIT', false]);
  });

  it('a payback the person filed (asReimbursement) stays a payback when its wording is a learned name', async () => {
    const fh = createFakeHost(seedOf({ spend: [tx('pb-f', '2026-10-16T12:00:00Z', '600.00', SAVINGS_TO_SPEND)] }, {
      transferNames: names(SPEND_IN),
      syncOverrides: setTxOverride(emptySyncOverrides(), accountTxKey('sfin-spend', 'pb-f'), 'asReimbursement', NOW),
    }));
    await runSyncCore(fh.host, fh.store, {});
    const r = rowOf(fh.activities.get('wf-spend'), 'pb-f');
    expect([r?.activityType, r?.subtype, inTransit(r)]).toEqual(['CREDIT', 'REIMBURSEMENT', false]);
  });

  it('leaves a stored payback as it is, and out of pairing, even when its bank text is a learned name (R13)', async () => {
    const fh = createFakeHost(seedOf({
      spend: [tx('pb-1', '2026-10-16T12:00:00Z', '600.00', SAVINGS_TO_SPEND)],
      sav: [tx('out-1', '2026-10-16T12:00:00Z', '-600.00', 'Withdrawal to PNC Bank XXXXXX0000')],
    }, {
      transferNames: names(SPEND_IN),
      existing: new Map([['wf-spend', [{ id: 'stored-pb', accountId: 'wf-spend', activityType: 'CREDIT', subtype: 'REIMBURSEMENT',
        date: '2026-10-16', amount: 600, comment: `${SAVINGS_TO_SPEND} · pb-1`, sourceGroupId: null }]]]),
    }));
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(result.errors).toEqual([]);
    expect(fh.links).toEqual([]);
    expect(fh.activities.get('wf-spend')).toEqual([expect.objectContaining({ id: 'stored-pb', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' })]);
    // "PNC BANK" is a wording rule, so the savings half is a transfer on its own
    // — and, with no partner to pair with, a placeholder.
    expect(inTransit(rowOf(fh.activities.get('wf-sav'), 'out-1'))).toBe(true);
  });
});
