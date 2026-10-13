import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChangeEntry, ChangeLogSink } from './change-entries.js';
import { createFakeHost } from './fake-host.js';
import { applyBaselineFix, importAdjustmentActivity, runSyncCore, VALUATION_POLL } from './sync-core.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-12T14:05:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;

function capture(): ChangeLogSink & { entries: () => ChangeEntry[] } {
  const batches: ChangeEntry[][] = [];
  return {
    writer: 'addon', run: 'aRUN1',
    append: vi.fn(async (entries: ChangeEntry[]) => { batches.push(entries); }),
    entries: () => batches.flat(),
  };
}

describe('runSyncCore — change log for balances, links and repairs', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a new starting balance with the id read back after the import', async () => {
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '100.00', 'balance-date': epoch('2026-10-12T12:00:00Z'),
        transactions: [{ id: 'tx-1', posted: epoch('2026-10-11T12:00:00Z'), amount: '-12.50', description: 'COFFEE' }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
      accountNames: { 'wf-a': 'Checking' },
      valuations: new Map([['wf-a', 0]]),
    });
    const log = capture();
    await runSyncCore(host, store, { changeLog: log });
    expect(log.entries().map((e) => e.kind)).toEqual(['import', 'starting-balance']);
    expect(log.entries()[1]).toMatchObject({
      summary: 'Set the starting balance, dated Oct 10',
      account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' },
      subject: { activityIds: ['fh-2'], amountCents: 11250, date: '2026-10-10' },
      after: { activityId: 'fh-2', amountCents: 11250, date: '2026-10-10', activityType: 'CREDIT', comment: 'Starting balance · sfin-1' },
      undoable: true,
    });
  });

  it('records a starting balance moved in front of older history, before and after', async () => {
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-12T12:00:00Z'), transactions: [],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountNames: { 'wf-a': 'Savings' },
      existing: new Map([['wf-a', [
        { id: 'sb-1', accountId: 'wf-a', activityType: 'CREDIT', date: '2026-06-19', amount: 1200, comment: 'Starting balance · sfin-1', sourceGroupId: null },
        { id: 'act-old', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-04-23', amount: 5, comment: 'COFFEE · tx-old', sourceGroupId: null },
      ]]]),
    });
    const log = capture();
    await runSyncCore(host, store, { force: true, changeLog: log });
    expect(log.entries()).toEqual([expect.objectContaining({
      kind: 'starting-balance-moved', actor: 'auto',
      summary: 'Moved the starting balance to Apr 22 (was Jun 19)',
      before: { activityId: 'sb-1', amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' },
      after: { activityId: 'sb-1', amountCents: 120000, date: '2026-04-22', activityType: 'CREDIT' },
    })]);
  });

  it('records the aggressive re-scan’s balance correction with its row id', async () => {
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'C', currency: 'USD', balance: '100.00', 'balance-date': epoch('2026-10-12T12:00:00Z'), transactions: [],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
      accountNames: { 'wf-a': 'Checking' },
      valuations: new Map([['wf-a', 0]]),
      autoHeal: true,
      autoAdjust: true,
    });
    const log = capture();
    await runSyncCore(host, store, { heal: true, changeLog: log });
    const plug = log.entries().find((e) => e.kind === 'balance-correction')!;
    expect(plug).toMatchObject({
      actor: 'auto', undoable: true,
      summary: 'Added a balance correction',
      account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' },
      subject: { activityIds: ['fh-1'], amountCents: 10000, date: '2026-10-12' },
      after: { activityId: 'fh-1', accountId: 'wf-a', amountCents: 10000, activityType: 'CREDIT', comment: 'Balance adjustment · sfin-1 · 2026-10-12' },
    });
  });

  it('records a link with both tx keys and the ids the host reports', async () => {
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-12T12:00:00Z'),
          transactions: [{ id: 'tx-out', posted: epoch('2026-10-08T12:00:00Z'), amount: '-500.00', description: 'Payment to Card' }] },
        { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-12T12:00:00Z'),
          transactions: [{ id: 'tx-in', posted: epoch('2026-10-09T12:00:00Z'), amount: '500.00', description: 'PAYMENT THANK YOU' }] },
      ] },
      mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
      accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CREDIT_CARD' },
      accountNames: { 'wf-a': 'Checking', 'wf-b': 'Citi Card' },
    });
    const log = capture();
    await runSyncCore(host, store, { changeLog: log });
    const link = log.entries().find((e) => e.kind === 'transfer-link')!;
    expect(link).toMatchObject({
      summary: 'Linked Payment to Card and PAYMENT THANK YOU as one transfer',
      account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' },
      subject: { txKeys: [accountTxKey('sfin-1', 'tx-out'), accountTxKey('sfin-2', 'tx-in')], activityIds: ['fh-1', 'fh-2'], amountCents: -50000 },
      before: { activityIds: ['fh-1', 'fh-2'] },
      undoable: true,
    });
  });

  it('records the relink sweep as bookkeeping', async () => {
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Spend', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-12T12:00:00Z'), transactions: [],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
      existing: new Map([['wf-a', [
        { id: 'out-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-07-01', amount: 500, comment: 'Online Transfer to Savings · tx-a', assetId: '$CASH', sourceGroupId: null },
      ]]]),
    });
    const log = capture();
    await runSyncCore(host, store, { force: true, changeLog: log });
    expect(log.entries()).toEqual([expect.objectContaining({
      kind: 'bookkeeping', summary: 'Re-created 1 old transfer row so it moves cash', subject: { activityIds: ['fh-1'] }, undoable: false,
    })]);
  });
});

describe('the write helpers report what they wrote', () => {
  it('importAdjustmentActivity returns the row, or null when nothing was written', async () => {
    const { host } = createFakeHost({ mapping: { 'sfin-1': 'wf-a' }, accountTypes: { 'wf-a': 'CASH' } });
    const row = await importAdjustmentActivity(host, { sfinAccountId: 'sfin-1', wfAccountId: 'wf-a', currency: 'USD', amount: -2.15 });
    expect(row).toMatchObject({ accountId: 'wf-a', activityType: 'TRANSFER_OUT', amount: 2.15 });
    expect(row!.comment).toMatch(/^Balance adjustment · sfin-1 · \d{4}-\d{2}-\d{2}$/);
    expect(await importAdjustmentActivity(host, { sfinAccountId: 'sfin-1', wfAccountId: 'wf-a', currency: 'USD', amount: 0.004 })).toBeNull();
  });

  it('applyBaselineFix returns the row before and after', async () => {
    const { host } = createFakeHost({
      mapping: { 'sfin-1': 'wf-a' },
      existing: new Map([['wf-a', [
        { id: 'sb-wf-a', accountId: 'wf-a', activityType: 'DEPOSIT', date: '2023-11-01', amount: 11355.12, comment: 'Starting balance · sfin-1', sourceGroupId: null },
      ]]]),
    });
    const res = await applyBaselineFix(host, { wfAccountId: 'wf-a', sfAccountId: 'sfin-1', suggestedAmount: 10055.12, currency: 'USD' });
    expect(res).toEqual({
      applied: true,
      change: {
        activityId: 'sb-wf-a',
        before: { amountCents: 1135512, date: '2023-11-01', activityType: 'DEPOSIT' },
        after: { amountCents: 1005512, date: '2023-11-01', activityType: 'CREDIT' },
      },
    });
  });
});
