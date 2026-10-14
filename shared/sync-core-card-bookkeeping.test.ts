import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import {
  EXTERNAL_BOOKKEEPING_METADATA, IN_TRANSIT_COMMENT_PREFIX, PENDING_SUFFIX, keepBookkeepingOutflow, neutralAdjustmentFields, runSyncCore,
  startingBalanceFields, VALUATION_POLL,
} from './sync-core.js';
import type { HostActivity } from './sync-host.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;

describe('a card\'s bookkeeping outflow, by what the host takes', () => {
  it('is a TRANSFER_OUT on Wealthfolio 3.10+ and a WITHDRAWAL before; nothing else moves', () => {
    expect(neutralAdjustmentFields('CREDIT_CARD', -12.5)).toEqual({ activityType: 'WITHDRAWAL', amount: 12.5, fee: 0 });
    expect(neutralAdjustmentFields('CREDIT_CARD', -12.5, { cardTransferOut: true })).toEqual({ activityType: 'TRANSFER_OUT', amount: 12.5, fee: 0 });
    expect(neutralAdjustmentFields('CREDIT_CARD', 12.5, { cardTransferOut: true }).activityType).toBe('TRANSFER_IN');
    expect(neutralAdjustmentFields('CASH', -12.5, { cardTransferOut: true }).activityType).toBe('TRANSFER_OUT');
    expect(neutralAdjustmentFields('CASH', -12.5).activityType).toBe('TRANSFER_OUT');
    expect(startingBalanceFields('CREDIT_CARD', -464.6, { cardTransferOut: true })).toEqual({ activityType: 'TRANSFER_OUT', amount: 464.6 });
    expect(startingBalanceFields('CREDIT_CARD', -464.6)).toEqual({ activityType: 'WITHDRAWAL', amount: 464.6 });
    expect(startingBalanceFields('CASH', -10, { cardTransferOut: true }).activityType).toBe('WITHDRAWAL');
  });

  it('keeps a stored WITHDRAWAL where a 3.10 writer would choose TRANSFER_OUT, and never writes TRANSFER_OUT back on an older host', () => {
    expect(keepBookkeepingOutflow('CREDIT_CARD', 'WITHDRAWAL', 'TRANSFER_OUT')).toBe('WITHDRAWAL');
    expect(keepBookkeepingOutflow('CREDIT_CARD', 'TRANSFER_OUT', 'WITHDRAWAL')).toBe('WITHDRAWAL');
    expect(keepBookkeepingOutflow('CREDIT_CARD', 'TRANSFER_OUT', 'TRANSFER_IN')).toBe('TRANSFER_IN');
    expect(keepBookkeepingOutflow('CASH', 'WITHDRAWAL', 'TRANSFER_OUT')).toBe('TRANSFER_OUT');
  });
});

describe('runSyncCore — a card\'s bookkeeping on Wealthfolio 3.10', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A balance transfer out of a card, typed a transfer by your rule, its other half not here. */
  const card = (extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
    accountSet: { errors: [], accounts: [{
      id: 'sfin-c', name: 'Citi', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
      transactions: [{ id: 'tx-bt', posted: epoch('2026-10-12T12:00:00Z'), amount: '-250.00', description: 'BALANCE TRANSFER' }],
    }] },
    mapping: { 'sfin-c': 'wf-c' },
    accountTypes: { 'wf-c': 'CREDIT_CARD' },
    accountNames: { 'wf-c': 'Citi Card' },
    mappingRules: [{ pattern: 'BALANCE TRANSFER', matchType: 'contains', activityType: 'TRANSFER_OUT' }],
    ...extra,
  });
  const caps = (cardTransferOut: boolean) => ({ readsSourceGroupId: true, cardTransferOut });
  /** The placeholder as its writer left it: a transfer-typed one is born external. */
  const held = (activityType: string): HostActivity => ({
    id: 'act-held', accountId: 'wf-c', activityType, date: '2026-10-12', amount: 250,
    comment: `${IN_TRANSIT_COMMENT_PREFIX}BALANCE TRANSFER · tx-bt`, sourceGroupId: null,
    metadata: activityType === 'TRANSFER_OUT' ? EXTERNAL_BOOKKEEPING_METADATA : null,
  });

  it('holds a card\'s unpaired outflow as a TRANSFER_OUT marked external on 3.10, as a WITHDRAWAL before', async () => {
    const ten = createFakeHost(card({ cardTransferOut: true }));
    const first = await runSyncCore({ ...ten.host, capabilities: caps(true) }, ten.store, {});
    expect(first.errors).toEqual([]);
    const write = ten.saved.flatMap((r) => r.creates ?? [])[0];
    expect(write).toMatchObject({ activityType: 'TRANSFER_OUT', amount: 250, metadata: EXTERNAL_BOOKKEEPING_METADATA });
    expect(write.symbol).toBeUndefined();
    expect(ten.activities.get('wf-c')).toEqual([expect.objectContaining({ activityType: 'TRANSFER_OUT', amount: 250 })]);
    const writesBefore = ten.saved.length;
    const second = await runSyncCore({ ...ten.host, capabilities: caps(true) }, ten.store, { force: true } as never);
    expect(second.errors).toEqual([]);
    expect(ten.saved.slice(writesBefore).flatMap((r) => [...(r.creates ?? []), ...(r.updates ?? []), ...(r.deleteIds ?? [])])).toEqual([]);
    const nine = createFakeHost(card());
    await runSyncCore({ ...nine.host, capabilities: caps(false) }, nine.store, {});
    expect(nine.saved.flatMap((r) => r.creates ?? [])[0]).toMatchObject({ activityType: 'WITHDRAWAL', amount: 250 });
  });

  it.each([
    ['a 3.10 writer leaves a held WITHDRAWAL as it is', 'WITHDRAWAL', true],
    ['an older writer leaves a held TRANSFER_OUT as it is', 'TRANSFER_OUT', false],
  ])('never flips a held card outflow between its two shapes: %s', async (_what, stored, cardTransferOut) => {
    const fh = createFakeHost(card({ cardTransferOut: true, existing: new Map([['wf-c', [held(stored)]]]) }));
    const res = await runSyncCore({ ...fh.host, capabilities: caps(cardTransferOut) }, fh.store, {});
    expect(res.errors).toEqual([]);
    expect(fh.saved.flatMap((r) => r.updates ?? []).filter((u) => u.id === 'act-held')).toEqual([]);
  });

  it('opens a card that owes money with a TRANSFER_OUT starting balance on 3.10', async () => {
    const fh = createFakeHost({
      accountSet: { errors: [], accounts: [{ id: 'sfin-c', name: 'Citi', currency: 'USD', balance: '-464.60', 'balance-date': epoch('2026-10-14T12:00:00Z'), transactions: [] }] },
      mapping: { 'sfin-c': 'wf-c' },
      accountTypes: { 'wf-c': 'CREDIT_CARD' },
      ledgerBalances: new Map([['wf-c', 0]]),
      cardTransferOut: true,
    });
    const res = await runSyncCore({ ...fh.host, capabilities: caps(true) }, fh.store, {});
    expect(res.errors).toEqual([]);
    expect(fh.imported.flat()).toEqual([expect.objectContaining({ activityType: 'TRANSFER_OUT', amount: 464.6, comment: 'Starting balance · sfin-c' })]);
  });

  // I1: an in-place update keeps a held card placeholder's stored shape.
  const pendingHeld = (type: string, extra: Partial<HostActivity> = {}): HostActivity => ({
    ...held(type), comment: `${IN_TRANSIT_COMMENT_PREFIX}BALANCE TRANSFER · tx-bt${PENDING_SUFFIX}`, ...extra,
  });
  const updatesOf = (saved: Array<{ updates?: Array<{ id?: string; activityType: string }> }>) =>
    saved.flatMap((r) => r.updates ?? []).filter((u) => u.id === 'act-held');

  it.each([[undefined], ['$CASH-USD'], ['9231cb80-phantom']])(
    'a held card WITHDRAWAL going pending to posted under cardTransferOut stays a WITHDRAWAL (stored asset %s)',
    async (assetId) => {
      const fh = createFakeHost(card({ cardTransferOut: true, existing: new Map([['wf-c', [pendingHeld('WITHDRAWAL', assetId ? { assetId } : {})]]]) }));
      const res = await runSyncCore({ ...fh.host, capabilities: caps(true) }, fh.store, {});
      expect(res.errors).toEqual([]);
      const ups = updatesOf(fh.saved);
      expect(ups.length).toBeGreaterThan(0);
      expect(ups.every((u) => u.activityType === 'WITHDRAWAL')).toBe(true);
      expect(fh.activities.get('wf-c')?.find((r) => r.id === 'act-held')?.activityType).toBe('WITHDRAWAL');
    },
  );

  it.each([
    ['the add-on (unknown version) writes first', [false, true, false, true, false, true], 0],
    ['the companion (3.10) writes first', [true, false, true, false, true, false], 1],
  ])('alternating writers with an amount change each run converge, with no further flip: %s', async (_what, order, maxFlips) => {
    const seed = card({ cardTransferOut: true });
    const fh = createFakeHost(seed);
    const tx = seed.accountSet!.accounts[0].transactions![0] as { amount: string };
    const types: string[] = [];
    for (const [i, k] of order.entries()) {
      tx.amount = `-${250 + i}.00`;
      const res = await runSyncCore({ ...fh.host, capabilities: caps(k) }, fh.store, { force: true } as never);
      expect(res.errors).toEqual([]);
      types.push(...(fh.activities.get('wf-c') ?? []).map((r) => r.activityType));
    }
    expect(types).toHaveLength(order.length);
    expect(types.filter((t, i) => i > 0 && t !== types[i - 1]).length).toBeLessThanOrEqual(maxFlips);
    expect(new Set(types.slice(2)).size).toBe(1);
  });
});
