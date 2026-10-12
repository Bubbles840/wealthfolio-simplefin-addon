import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChangeEntry, ChangeLogSink } from './change-entries.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { IN_TRANSIT_TIMEOUT_SECONDS, runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { SaveManyRequest } from './sync-host.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-12T14:05:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;

/** A sink that keeps what it was handed, one array per append. */
function capture(): ChangeLogSink & { batches: ChangeEntry[][] } {
  const batches: ChangeEntry[][] = [];
  return { writer: 'companion', run: 'cRUN1', batches, append: vi.fn(async (entries: ChangeEntry[]) => { batches.push(entries); }) };
}

const checking = (transactions: Array<{ id: string; posted: number; amount: string; description: string; pending?: boolean }>): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [{
    id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-12T12:00:00Z'), transactions,
  }] },
  mapping: { 'sfin-1': 'wf-a' },
  accountTypes: { 'wf-a': 'CASH' },
  accountNames: { 'wf-a': 'Everyday Checking' },
});

describe('runSyncCore — change log', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records each confirmed import once, at the end of the run, stamped with the run', async () => {
    const { host, store } = createFakeHost(checking([
      { id: 'tx-1', posted: epoch('2026-10-11T12:00:00Z'), amount: '-12.34', description: 'KROGER #123' },
      { id: 'tx-2', posted: epoch('2026-10-11T13:00:00Z'), amount: '1500.00', description: 'ACME PAYROLL' },
    ]));
    const log = capture();
    const result = await runSyncCore(host, store, { changeLog: log });
    expect(result.imported).toBe(2);
    expect(log.append).toHaveBeenCalledTimes(1);
    const entries = log.batches[0];
    expect(entries.map((e) => [e.kind, e.summary])).toEqual([
      ['import', 'Imported KROGER #123'],
      ['import', 'Imported ACME PAYROLL'],
    ]);
    expect(entries[0]).toMatchObject({
      writer: 'companion', run: 'cRUN1', actor: 'auto', at: NOW.toISOString(), undoable: true,
      account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Everyday Checking' },
      subject: { txKeys: [accountTxKey('sfin-1', 'tx-1')], activityIds: ['fh-1'], description: 'KROGER #123', amountCents: -1234, date: '2026-10-11' },
      after: { activityId: 'fh-1', txKey: accountTxKey('sfin-1', 'tx-1'), activityType: 'WITHDRAWAL', pending: false },
    });
    expect(entries[1].subject.amountCents).toBe(150000);
  });

  it('records nothing for a create Wealthfolio refused', async () => {
    const { host, store } = createFakeHost({
      ...checking([
        { id: 'tx-ok', posted: epoch('2026-10-11T12:00:00Z'), amount: '-5.00', description: 'COFFEE' },
        { id: 'tx-dup', posted: epoch('2026-10-11T12:00:00Z'), amount: '-12.50', description: 'LUNCH' },
      ]),
      saveManyHook: (req: SaveManyRequest) => {
        if ((req.creates ?? []).length > 1) throw new Error('bulk refused');
        const c = (req.creates ?? [])[0];
        if (c && String(c.comment).includes('tx-dup')) {
          throw new Error('Duplicate activity detected. A matching activity already exists (id: act-9).');
        }
      },
    });
    const log = capture();
    const result = await runSyncCore(host, store, { changeLog: log });
    expect(result.refusedCreates.map((r) => r.txId)).toEqual(['tx-dup']);
    expect(log.batches[0].map((e) => e.subject.txKeys)).toEqual([[accountTxKey('sfin-1', 'tx-ok')]]);
  });

  it('a failing append changes nothing about the result', async () => {
    const seed = () => checking([
      { id: 'tx-1', posted: epoch('2026-10-11T12:00:00Z'), amount: '-12.34', description: 'KROGER #123' },
    ]);
    const plain = createFakeHost(seed());
    const without = await runSyncCore(plain.host, plain.store, {});
    const failing = createFakeHost(seed());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink: ChangeLogSink = { writer: 'addon', run: 'aRUN', append: vi.fn(async () => { throw new Error('secret write 500'); }) };
    try {
      const withBrokenLog = await runSyncCore(failing.host, failing.store, { changeLog: sink });
      expect(withBrokenLog).toEqual(without);
      expect(sink.append).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 change(s) not recorded'));
    } finally {
      warn.mockRestore();
    }
  });

  it('records nothing and never calls the sink on a run that wrote nothing', async () => {
    const { host, store } = createFakeHost(checking([]));
    const log = capture();
    await runSyncCore(host, store, { changeLog: log });
    expect(log.append).not.toHaveBeenCalled();
  });

  it('records a bank update with the row before and after', async () => {
    const { host, store } = createFakeHost({
      ...checking([{ id: 'tx-1', posted: epoch('2026-10-11T12:00:00Z'), amount: '-12.34', description: 'KROGER #123' }]),
      existing: new Map([['wf-a', [{
        id: 'act-7', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-10', amount: 12,
        comment: 'KROGER #123 · tx-1 · pending', sourceGroupId: null,
      }]]]),
    });
    const log = capture();
    await runSyncCore(host, store, { changeLog: log });
    expect(log.batches[0]).toHaveLength(1);
    expect(log.batches[0][0]).toMatchObject({
      kind: 'bank-update', undoable: false,
      summary: 'Updated KROGER #123 from the bank: $12.00 → $12.34, Oct 10 → Oct 11, posted',
      subject: { activityIds: ['act-7'], amountCents: -1234 },
      before: { absCents: 1200, date: '2026-10-10', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 1234, date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL' },
    });
  });

  it('records a pending row the bank dropped', async () => {
    const { host, store } = createFakeHost({
      ...checking([]),
      existing: new Map([['wf-a', [{
        id: 'act-8', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-10', amount: 18.1,
        comment: 'UBER *TRIP · tx-gone · pending', sourceGroupId: null,
      }]]]),
    });
    const log = capture();
    await runSyncCore(host, store, { changeLog: log });
    expect(log.batches[0]).toEqual([expect.objectContaining({
      kind: 'pending-removed', summary: 'Removed pending UBER *TRIP — the bank dropped it',
      subject: expect.objectContaining({ activityIds: ['act-8'], txKeys: [accountTxKey('sfin-1', 'tx-gone')], amountCents: -1810 }),
    })]);
  });

  it('records a new transfer leg held in transit as an import AND a transfer decision', async () => {
    const { host, store } = createFakeHost(checking([
      { id: 'tx-out', posted: epoch('2026-10-12T13:00:00Z'), amount: '-1300.00', description: 'Online Transfer to Savings' },
    ]));
    const log = capture();
    await runSyncCore(host, store, { changeLog: log });
    expect(log.batches[0].map((e) => [e.kind, e.summary, e.undoable])).toEqual([
      ['import', 'Imported Online Transfer to Savings', true],
      ['transfer-type', 'Held Online Transfer to Savings as a transfer in transit', true],
    ]);
    expect(log.batches[0][1].subject.txKeys).toEqual([accountTxKey('sfin-1', 'tx-out')]);
  });

  it('records a placeholder that ran out of time as a transfer decision it cannot undo', async () => {
    const stale = Math.floor(NOW.getTime() / 1000) - (IN_TRANSIT_TIMEOUT_SECONDS + 3600);
    const staleDate = new Date(stale * 1000).toISOString().slice(0, 10);
    const { host, store } = createFakeHost({
      ...checking([{ id: 'tx-out', posted: stale, amount: '-1300.00', description: 'Online Transfer to Savings' }]),
      existing: new Map([['wf-a', [{
        id: 'ph-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: staleDate, amount: 1300,
        comment: '↔️ In-transit transfer · Online Transfer to Savings · tx-out', sourceGroupId: null,
      }]]]),
    });
    const log = capture();
    await runSyncCore(host, store, { force: true, changeLog: log });
    const decision = log.batches[0].find((e) => e.kind === 'transfer-type')!;
    expect(decision).toMatchObject({
      undoable: false,
      summary: 'Stopped waiting for the other half of Online Transfer to Savings — now counted as spending',
      before: { activityType: 'TRANSFER_OUT', inTransit: true },
      after: { activityType: 'WITHDRAWAL', inTransit: false },
    });
  });

  it('records a pruned duplicate with the full payload to re-create it', async () => {
    const { host, store } = createFakeHost({
      ...checking([{ id: 'tx-1', posted: epoch('2026-10-01T12:00:00Z'), amount: '-25.00', description: 'NETFLIX.COM' }]),
      existing: new Map([['wf-a', [
        { id: 'act-2', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-01', amount: 25, comment: 'NETFLIX.COM · tx-1', sourceGroupId: null },
        { id: 'act-1', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-01', amount: 25, comment: 'NETFLIX.COM · tx-1', sourceGroupId: null },
      ]]]),
    });
    const log = capture();
    const result = await runSyncCore(host, store, { heal: true, changeLog: log });
    expect(result.prunedDuplicates.map((p) => p.wfId)).toEqual(['act-2']);
    expect(log.batches[0]).toEqual([expect.objectContaining({
      kind: 'duplicate-removed', undoable: true, summary: 'Removed a duplicate copy of NETFLIX.COM',
      subject: expect.objectContaining({ activityIds: ['act-2'], amountCents: -2500 }),
      before: {
        activityId: 'act-2',
        activity: {
          accountId: 'wf-a', activityType: 'WITHDRAWAL', activityDate: '2026-10-01', symbol: { symbol: '$CASH-USD' },
          amount: 25, currency: 'USD', comment: 'NETFLIX.COM · tx-1',
        },
      },
    })]);
  });

  it('records a late Amazon label with the label and both notes', async () => {
    const posted = epoch('2026-08-06T00:00:00Z');
    const { host, store } = createFakeHost({
      ...checking([{ id: 'tx-amz', posted, amount: '-21.18', description: 'AMAZON.COM*MB3T81' }]),
      existing: new Map([['wf-a', [{
        id: 'act-amz', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-08-06', amount: 21.18,
        comment: 'AMAZON.COM*MB3T81 · tx-amz', sourceGroupId: null,
      }]]]),
      amazonLedger: {
        '113-0728509-1925031|shipped|2118': {
          orderId: '113-0728509-1925031', kind: 'shipped', totalCents: 2118, itemCount: 1, labels: ['Lawn & Garden'], emailDate: '2026-08-04',
        },
      },
    });
    const log = capture();
    await runSyncCore(host, store, { changeLog: log });
    expect(log.batches[0]).toEqual([expect.objectContaining({
      kind: 'amazon-label', summary: 'Added the Amazon label "Lawn & Garden" to AMAZON.COM*MB3T81',
      before: { comment: 'AMAZON.COM*MB3T81 · tx-amz' },
      after: { comment: 'AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · tx-amz', label: 'Lawn & Garden' },
    })]);
  });

  it('records the legacy rewrite and the external marker as bookkeeping', async () => {
    const { host, store } = createFakeHost({
      ...checking([]),
      existing: new Map([['wf-a', [{
        id: 'plug-1', accountId: 'wf-a', activityType: 'CREDIT', date: '2026-06-12', amount: '0', fee: '80',
        comment: 'Balance adjustment · sfin-1 · 2026-06-12', sourceGroupId: null, subtype: null, metadata: null,
      }]]]),
    });
    const log = capture();
    await runSyncCore(host, store, { force: true, changeLog: log });
    expect(log.batches[0].map((e) => [e.kind, e.summary, e.subject.activityIds, e.undoable])).toEqual([
      ['bookkeeping', 'Restated 1 old placeholder row with its real amount', ['plug-1'], false],
      ['bookkeeping', "Marked 1 bookkeeping row as outside transfers for Wealthfolio's Health page", ['plug-1'], false],
    ]);
  });
});
