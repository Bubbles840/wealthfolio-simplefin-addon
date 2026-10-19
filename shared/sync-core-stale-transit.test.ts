import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { planBookkeepingFiling } from './bookkeeping-filing.js';
import type { ChangeEntry, ChangeLogSink } from './change-entries.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { EXTERNAL_BOOKKEEPING_METADATA, IN_TRANSIT_COMMENT_PREFIX, planStaleInTransit, runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { ActivityWrite, HostActivity } from './sync-host.js';
import { evaluateLedgerChecks, type LedgerFacts } from './ledger-checks.js';
import {
  editSyncOverrides, emptySyncOverrides, notTransferEdit, parseSyncOverrides, setTxOverride, SYNC_OVERRIDES_SECRET_KEY,
} from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { SimplefinAccount, SimplefinTransaction } from './types.js';

const NOW = new Date('2026-10-19T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const WIRE = 'WIRE TRANSFER TO ACME LLC';
const TO_HARBOR = 'ONLINE TRANSFER TO HARBOR SAVINGS 0000';

const tx = (id: string, iso: string, amount: string, description: string): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description });
const account = (id: string, name: string, aliveIso: string, transactions: SimplefinTransaction[]): SimplefinAccount => ({
  id, name, currency: 'USD', balance: '0', 'balance-date': epoch(aliveIso), transactions,
});
/** Checking and Harbor Savings, both cash. An incremental download: Checking
 *  carries only a coffee from yesterday; `savAlive` is Harbor's balance date. */
const seedOf = (stored: HostActivity[], extra: Partial<FakeHostSeed> = {}, savAlive = '2026-10-19T12:00:00Z', chkFeed?: SimplefinTransaction[]): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    account('sfin-chk', 'Checking', '2026-10-19T12:00:00Z', chkFeed ?? [tx('coffee', '2026-10-18T12:00:00Z', '-4.50', 'CORNER COFFEE')]),
    account('sfin-sav', 'Harbor Savings', savAlive, []),
  ] },
  mapping: { 'sfin-chk': 'wf-chk', 'sfin-sav': 'wf-sav' },
  accountTypes: { 'wf-chk': 'CASH', 'wf-sav': 'CASH' },
  existing: new Map([['wf-chk', stored]]),
  ...extra,
});
/** A placeholder the sync stored on `date` for SimpleFin transaction `txId`. */
const placeholder = (id: string, txId: string, date: string, over: Partial<HostActivity> = {}, description = WIRE): HostActivity => ({
  id, accountId: 'wf-chk', activityType: 'TRANSFER_OUT', date, amount: 250,
  comment: `${IN_TRANSIT_COMMENT_PREFIX}${description} · ${txId}`, sourceGroupId: null, metadata: EXTERNAL_BOOKKEEPING_METADATA, ...over,
});
const updatesFor = (saved: Array<{ updates?: ActivityWrite[] }>, id: string) => saved.flatMap((r) => r.updates ?? []).filter((u) => u.id === id);
const stored = (rows: HostActivity[] | undefined, id: string) => (rows ?? []).find((r) => r.id === id);

function capture(): ChangeLogSink & { entries: () => ChangeEntry[] } {
  const batches: ChangeEntry[][] = [];
  return {
    writer: 'companion', run: 'cRUN1',
    append: vi.fn(async (entries: ChangeEntry[]) => { batches.push(entries); }),
    entries: () => batches.flat(),
  };
}

describe('runSyncCore — in-transit rows outside the download settle like in-feed ones (1.65 A)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('expires a 20-day-old placeholder the download no longer carries: WITHDRAWAL, Needs review, prefix gone, logged', async () => {
    const fh = createFakeHost(seedOf([placeholder('ph-1', 'w-old', '2026-09-29')]));
    const log = capture();
    const r = await runSyncCore(fh.host, fh.store, { changeLog: log });
    expect(r.errors).toEqual([]);
    const [update, ...more] = updatesFor(fh.saved, 'ph-1');
    expect(more).toEqual([]);
    expect(update).toMatchObject({
      activityType: 'WITHDRAWAL', amount: 250, fee: 0, needsReview: true,
      comment: `${WIRE} · w-old`, symbol: { symbol: '$CASH-USD' },
    });
    expect(update).not.toHaveProperty('metadata');
    const row = stored(fh.activities.get('wf-chk'), 'ph-1')!;
    expect([row.activityType, row.comment]).toEqual(['WITHDRAWAL', `${WIRE} · w-old`]);
    expect(log.entries().filter((e) => e.kind === 'transfer-type')).toEqual([expect.objectContaining({
      undoable: false,
      summary: `Stopped waiting for the other half of ${WIRE} — now counted as spending`,
      subject: expect.objectContaining({ txKeys: [accountTxKey('sfin-chk', 'w-old')], activityIds: ['ph-1'], amountCents: -25000 }),
    })]);
    // R2: the 1.62 "Sync bookkeeping" filing comes back out on the companion's next pass.
    expect(planBookkeepingFiling([{
      id: 'ph-1', accountType: 'CASH', type: 'WITHDRAWAL', subtype: '', groupId: '', notes: row.comment!, spendingCategoryIds: ['cat-sync'],
    }], { categoryId: 'cat-sync', filedByPass: new Set(['ph-1']) })).toEqual({ file: [], unfile: ['ph-1'] });
  });

  it('writes exactly what the in-feed expiry writes for the same row', async () => {
    const row = () => placeholder('ph-1', 'w-old', '2026-09-29', {}, TO_HARBOR);
    const outside = createFakeHost(seedOf([row()]));
    await runSyncCore(outside.host, outside.store, {});
    const inside = createFakeHost(seedOf([row()], {}, undefined, [tx('w-old', '2026-09-29T12:00:00Z', '-250.00', TO_HARBOR)]));
    await runSyncCore(inside.host, inside.store, { force: true });
    expect(updatesFor(outside.saved, 'ph-1')).toEqual(updatesFor(inside.saved, 'ph-1'));
    expect(updatesFor(inside.saved, 'ph-1')).toHaveLength(1);
  });

  it('settles an inflow too: a cash placeholder in becomes a DEPOSIT, flagged', async () => {
    const fh = createFakeHost(seedOf([placeholder('ph-in', 'w-in', '2026-09-29', { activityType: 'CREDIT', amount: 900 }, 'WIRE TRANSFER FROM ACME LLC')]));
    await runSyncCore(fh.host, fh.store, {});
    expect(updatesFor(fh.saved, 'ph-in')).toEqual([expect.objectContaining({ activityType: 'DEPOSIT', amount: 900, needsReview: true })]);
  });

  it('keeps it held while another mapped feed has published nothing past its pairing window', async () => {
    // Harbor's newest data is Sep 30, before the leg's Oct 4 pairing deadline, and it is not dead (19 days).
    const fh = createFakeHost(seedOf([placeholder('ph-1', 'w-old', '2026-09-29')], {}, '2026-09-30T12:00:00Z'));
    await runSyncCore(fh.host, fh.store, {});
    expect(updatesFor(fh.saved, 'ph-1')).toEqual([]);
    expect(stored(fh.activities.get('wf-chk'), 'ph-1')!.comment!.startsWith(IN_TRANSIT_COMMENT_PREFIX)).toBe(true);
  });

  it('a mapped account missing from this download holds it: no life is not evidence', async () => {
    const seed = seedOf([placeholder('ph-1', 'w-old', '2026-09-29')]);
    seed.mapping!['sfin-gone'] = 'wf-gone';
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, {});
    expect(updatesFor(fh.saved, 'ph-1')).toEqual([]);
  });

  it("settles a card's held payment as the type a card accepts: CREDIT, flagged", async () => {
    const seed = seedOf([], {}, undefined);
    seed.existing = new Map([['wf-sav', [{ ...placeholder('ph-card', 'c-old', '2026-09-29', { activityType: 'TRANSFER_IN' }, 'PAYMENT THANK YOU'), accountId: 'wf-sav' }]]]);
    seed.accountTypes = { 'wf-chk': 'CASH', 'wf-sav': 'CREDIT_CARD' };
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, {});
    expect(updatesFor(fh.saved, 'ph-card')).toEqual([expect.objectContaining({ activityType: 'CREDIT', amount: 250, needsReview: true })]);
  });

  it('a feed silent over 21 days holds only the legs that name it', async () => {
    const fh = createFakeHost(seedOf([
      placeholder('ph-wire', 'w-old', '2026-09-29'),
      placeholder('ph-harbor', 'h-old', '2026-09-29', { amount: 300 }, TO_HARBOR),
    ], {}, '2026-09-20T12:00:00Z'));
    await runSyncCore(fh.host, fh.store, {});
    expect(updatesFor(fh.saved, 'ph-wire')).toEqual([expect.objectContaining({ activityType: 'WITHDRAWAL', needsReview: true })]);
    expect(updatesFor(fh.saved, 'ph-harbor')).toEqual([]);
  });

  it('leaves alone: a linked row, a pending row, a young row, a skipped row and a payback', async () => {
    const fh = createFakeHost(seedOf([
      placeholder('ph-linked', 'w-linked', '2026-09-29', { sourceGroupId: 'g-1' }),
      // Linked in place by Wealthfolio after a refused promotion: the note still has the prefix.
      placeholder('ph-in-place', 'w-in-place', '2026-09-29', { metadata: JSON.stringify({ flow: { is_external: false } }) }),
      placeholder('ph-pending', 'w-pending', '2026-09-29', { comment: `${IN_TRANSIT_COMMENT_PREFIX}${WIRE} · w-pending · pending` }),
      placeholder('ph-young', 'w-young', '2026-10-11'),
      placeholder('ph-skip', 'w-skip', '2026-09-29'),
      placeholder('ph-pay', 'w-pay', '2026-09-29', { activityType: 'CREDIT' }, 'ONLINE TRANSFER FROM A FRIEND'),
    ], {
      skippedTransactions: [{ account: 'sfin-chk', txId: 'w-skip' }],
      syncOverrides: setTxOverride(emptySyncOverrides(), accountTxKey('sfin-chk', 'w-pay'), 'asReimbursement', NOW),
    }));
    await runSyncCore(fh.host, fh.store, {});
    for (const id of ['ph-linked', 'ph-in-place', 'ph-pending', 'ph-young', 'ph-skip', 'ph-pay']) {
      expect(updatesFor(fh.saved, id)).toEqual([]);
    }
  });

  it('a placeholder still in the download takes the in-feed path: one write, not two', async () => {
    const fh = createFakeHost(seedOf([placeholder('ph-1', 'w-old', '2026-09-29', {}, TO_HARBOR)], {}, undefined,
      [tx('w-old', '2026-09-29T12:00:00Z', '-250.00', TO_HARBOR)]));
    await runSyncCore(fh.host, fh.store, { force: true });
    expect(updatesFor(fh.saved, 'ph-1')).toHaveLength(1);
  });

  it('"not a transfer": a placeholder outside the download becomes ordinary at once, even while a feed lags', async () => {
    const key = accountTxKey('sfin-chk', 'w-old');
    const fh = createFakeHost(seedOf([
      placeholder('ph-1', 'w-old', '2026-09-29'),
      { id: 'done', accountId: 'wf-chk', activityType: 'WITHDRAWAL', date: '2026-09-28', amount: 80, comment: 'WIRE TRANSFER TO ACME LLC · w-done', sourceGroupId: null },
    ], {
      syncOverrides: setTxOverride(setTxOverride(emptySyncOverrides(), key, 'notTransfer', NOW), accountTxKey('sfin-chk', 'w-done'), 'notTransfer', NOW),
    }, '2026-09-30T12:00:00Z'));
    const log = capture();
    await runSyncCore(fh.host, fh.store, { changeLog: log });
    const [update] = updatesFor(fh.saved, 'ph-1');
    expect(update).toMatchObject({ activityType: 'WITHDRAWAL', comment: `${WIRE} · w-old` });
    expect(update).not.toHaveProperty('needsReview');
    expect(updatesFor(fh.saved, 'done')).toEqual([]);
    expect(log.entries().filter((e) => e.kind === 'transfer-type').map((e) => e.summary)).toEqual([
      `Counted ${WIRE} as spending — you said it isn't a transfer`,
    ]);
  });

  it('planStaleInTransit leaves a fee-side row (amount 0 or a fee) to the legacy rewrite', () => {
    const ctx = {
      wfAccountId: 'wf-chk', sfinAccountId: 'sfin-chk', accountType: 'CASH', feedTxIds: new Set<string>(),
      nowSec: epoch('2026-10-19T15:00:00Z'), mappedSfinIds: ['sfin-chk'], feedAliveEpoch: new Map<string, number>(),
      nameWords: new Map<string, string[]>(), leaveAlone: () => false, notTransfer: () => false,
    };
    const row = (txId: string, over: object) => ({
      wfId: txId, wfAccountId: 'wf-chk', txId, absCents: 25000, type: 'CREDIT', date: '2026-09-29', pending: false,
      comment: `${IN_TRANSIT_COMMENT_PREFIX}${WIRE} · ${txId}`, ...over,
    });
    expect(planStaleInTransit([row('zero', { absCents: 0 }), row('fee', { feeCents: 25000 })], ctx).settle).toEqual([]);
    expect(planStaleInTransit([row('ok', {})], ctx).settle).toHaveLength(1);
  });

  it('two prefixed copies of one tx id settle once: one update, one change-log entry', async () => {
    const fh = createFakeHost(seedOf([placeholder('ph-a', 'w-old', '2026-09-29'), placeholder('ph-b', 'w-old', '2026-09-29')]));
    const log = capture();
    await runSyncCore(fh.host, fh.store, { changeLog: log });
    expect(updatesFor(fh.saved, 'ph-a').length + updatesFor(fh.saved, 'ph-b').length).toBe(1);
    expect(log.entries().filter((e) => e.kind === 'transfer-type')).toHaveLength(1);
  });
});

describe('runSyncCore — each feed\'s proven-alive time is stored for the held-transfer finding (1.65 C)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('stores aliveThrough: the later of the balance date and the newest transaction', async () => {
    const seed = seedOf([], {}, '2026-09-30T12:00:00Z');
    seed.accountSet!.accounts[1].transactions = [tx('s-1', '2026-10-18T12:00:00Z', '5.00', 'INTEREST PAID')];
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, {});
    const balances = await fh.store.getAccountBalances() as Record<string, { date: number; aliveThrough?: number }>;
    expect(balances['sfin-sav']).toMatchObject({ date: epoch('2026-09-30T12:00:00Z'), aliveThrough: epoch('2026-10-18T12:00:00Z') });
    expect(balances['sfin-chk'].aliveThrough).toBe(epoch('2026-10-19T12:00:00Z'));
  });
});

describe('"Not a transfer" on the held-transfer finding (1.65 C acceptance)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('writes notTransfer for that transaction, and the next sync makes the held row an ordinary WITHDRAWAL', async () => {
    const facts: LedgerFacts = {
      month: '2026-10', cardBalances: [], idleRefunds: [], incomeReimbursements: [], unlinkedTransfers: [], groupedNonTransfers: [],
      heldTransfers: [{ id: 'ph-1', description: WIRE, amount: 250, ageDays: 20, wfAccountId: 'wf-chk', date: '2026-09-29', txId: 'w-old', direction: 'out' }],
      needsReview: 0, categories: [], chronicallyOver: [], missingLegs: [], cardsOpenedInCredit: [],
    };
    const LAGGING = '2026-09-30T12:00:00Z';
    const feeds = {
      mapping: { 'sfin-chk': 'wf-chk', 'sfin-sav': 'wf-sav' },
      balances: { 'sfin-chk': { aliveThrough: epoch('2026-10-19T12:00:00Z') }, 'sfin-sav': { aliveThrough: epoch(LAGGING) } },
      names: { 'sfin-chk': 'Checking', 'sfin-sav': 'Harbor Savings' },
    };
    const fix = evaluateLedgerChecks(facts, {}, NOW, feeds).findings[0].fix;
    if (fix?.kind !== 'not-transfer') throw new Error('expected a "Not a transfer" fix');
    const secrets = new Map<string, string>();
    await editSyncOverrides(async (k) => secrets.get(k) ?? null, async (k, v) => { secrets.set(k, v); }, notTransferEdit(fix.txKey, fix.label, NOW), NOW);
    const parsed = parseSyncOverrides(secrets.get(SYNC_OVERRIDES_SECRET_KEY));
    if (parsed.kind !== 'ok') throw new Error('overrides not written');
    // The same flag and label the change log's Undo writes for a held leg.
    expect(parsed.overrides.tx[fix.txKey]).toEqual({ notTransfer: true, at: NOW.toISOString(), label: 'WIRE TRANSFER TO ACME LLC · Checking' });

    // The same lagging feed that held it: "Not a transfer" is the way out.
    const fh = createFakeHost(seedOf([placeholder('ph-1', 'w-old', '2026-09-29')], { syncOverrides: parsed.overrides }, LAGGING));
    await runSyncCore(fh.host, fh.store, {});
    expect(updatesFor(fh.saved, 'ph-1')).toEqual([expect.objectContaining({ activityType: 'WITHDRAWAL', comment: `${WIRE} · w-old` })]);
  });
});
