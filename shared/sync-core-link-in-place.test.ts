import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChangeEntry, ChangeLogSink } from './change-entries.js';
import { currentActivityId } from './change-view.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import type { UnlinkLeg } from './link-pair.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity, LinkLeg, LinkResult } from './sync-host.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-13T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const OUT = accountTxKey('sfin-1', 'tx-out');
const IN = accountTxKey('sfin-2', 'tx-in');

function capture(): ChangeLogSink & { entries: () => ChangeEntry[] } {
  const batches: ChangeEntry[][] = [];
  return {
    writer: 'addon', run: 'aRUN1',
    append: vi.fn(async (entries: ChangeEntry[]) => { batches.push(entries); }),
    entries: () => batches.flat(),
  };
}

/** Checking to Savings, both halves in this run's feed. */
const twoAccounts = (extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-13T12:00:00Z'),
      transactions: [{ id: 'tx-out', posted: epoch('2026-10-08T12:00:00Z'), amount: '-600.00', description: 'TO SAVINGS' }] },
    { id: 'sfin-2', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-13T12:00:00Z'),
      transactions: [{ id: 'tx-in', posted: epoch('2026-10-08T13:00:00Z'), amount: '600.00', description: 'FROM CHECKING' }] },
  ] },
  mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
  accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CASH' },
  accountNames: { 'wf-a': 'Checking', 'wf-b': 'Savings' },
  ...extra,
});

/** Both halves as an earlier sync left them: stored, not yet linked. */
const unlinkedRows = (): Map<string, HostActivity[]> => new Map([
  ['wf-a', [{ id: 'act-out', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-10-08', amount: 600, comment: 'TO SAVINGS · tx-out', sourceGroupId: null, metadata: null }]],
  ['wf-b', [{ id: 'act-in', accountId: 'wf-b', activityType: 'TRANSFER_IN', date: '2026-10-08', amount: 600, comment: 'FROM CHECKING · tx-in', sourceGroupId: null, metadata: null }]],
]);

/** Wealthfolio's own link mints a bare uuid group and keeps both rows. */
const inPlace = vi.fn(async (legs: [LinkLeg, LinkLeg]): Promise<LinkResult> => ({
  linked: true, groupId: '3f6c0f2e-aaaa-4bbb-8ccc-000000000001', activityIds: [legs[0].wfId, legs[1].wfId], inPlace: true,
}));

describe('runSyncCore — links and unlinks in place', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    inPlace.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('on the add-on, remembers a pair linked in place so the next sync leaves it alone', async () => {
    const fh = createFakeHost(twoAccounts({ existing: unlinkedRows() }));
    const host = { ...fh.host, capabilities: { readsSourceGroupId: false }, linkPair: inPlace };
    await runSyncCore(host, fh.store, {});
    expect(inPlace).toHaveBeenCalledTimes(1);
    expect(await fh.store.getLinkedGroups()).toEqual({
      [OUT]: 'wf-transfer-3f6c0f2e-aaaa-4bbb-8ccc-000000000001',
      [IN]: 'wf-transfer-3f6c0f2e-aaaa-4bbb-8ccc-000000000001',
    });
    await runSyncCore(host, fh.store, { force: true });
    expect(inPlace).toHaveBeenCalledTimes(1);
  });

  it('records the link with the same ids before and after, which every later lookup follows to itself', async () => {
    const fh = createFakeHost(twoAccounts({ existing: unlinkedRows() }));
    const log = capture();
    await runSyncCore({ ...fh.host, linkPair: inPlace }, fh.store, { changeLog: log });
    const link = log.entries().find((e) => e.kind === 'transfer-link')!;
    expect(link.before).toEqual({ activityIds: ['act-out', 'act-in'] });
    expect(link.after).toMatchObject({ activityIds: ['act-out', 'act-in'] });
    expect(link.subject.activityIds).toEqual(['act-out', 'act-in']);
    expect(currentActivityId(log.entries(), 'act-out')).toBe('act-out');
  });

  it('undoes a link through the host\'s unlink in place: nothing created or deleted, and the log says so', async () => {
    const linked = unlinkedRows();
    for (const rows of linked.values()) for (const r of rows) Object.assign(r, { sourceGroupId: 'grp-9', metadata: '{"flow":{"is_external":false}}' });
    const overrides = [OUT, IN].reduce((o, k) => setTxOverride(o, k, 'notTransfer', NOW), emptySyncOverrides());
    const fh = createFakeHost(twoAccounts({ existing: linked, syncOverrides: overrides }));
    const unlinkPair = vi.fn(async (legs: [UnlinkLeg, UnlinkLeg]) => ({ unlinked: true, inPlace: true as const, activityIds: [legs[0].wfId, legs[1].wfId] as [string, string] }));
    const log = capture();
    const result = await runSyncCore({ ...fh.host, unlinkPair }, fh.store, { changeLog: log });
    expect(result.errors).toEqual([]);
    expect(unlinkPair).toHaveBeenCalledTimes(1);
    expect(unlinkPair.mock.calls[0][0].map((l) => [l.wfId, l.newType])).toEqual([['act-out', 'WITHDRAWAL'], ['act-in', 'DEPOSIT']]);
    expect(fh.saved.filter((r) => (r.creates ?? []).length > 0 || (r.deleteIds ?? []).length > 0)).toEqual([]);
    expect(log.entries()).toEqual([expect.objectContaining({
      kind: 'bookkeeping', subject: expect.objectContaining({ activityIds: ['act-out', 'act-in'] }),
      summary: 'Unlinked a transfer you undid: both rows now count as spending or money in',
    })]);
  });

  it('says what is left when the pair unlinked in place but its retype was refused', async () => {
    const linked = unlinkedRows();
    for (const rows of linked.values()) for (const r of rows) Object.assign(r, { sourceGroupId: 'grp-9' });
    const overrides = [OUT, IN].reduce((o, k) => setTxOverride(o, k, 'notTransfer', NOW), emptySyncOverrides());
    const fh = createFakeHost(twoAccounts({ existing: linked, syncOverrides: overrides }));
    const unlinkPair = vi.fn(async () => ({
      unlinked: true, inPlace: true as const, activityIds: ['act-out', 'act-in'] as [string, string],
      problems: ['unlinked … in place, but they are still typed as transfers (update: refused); a later sync retypes each while the bank feed still sends it'],
    }));
    const result = await runSyncCore({ ...fh.host, unlinkPair }, fh.store, {});
    expect(result.errors).toEqual([
      'Transfer-unlink incomplete (tx-out/tx-in): unlinked … in place, but they are still typed as transfers (update: refused); a later sync retypes each while the bank feed still sends it',
    ]);
  });

  it('keeps the ledger records of a pair whose in-place unlink was incomplete, so the next sync retries the retype', async () => {
    const linked = unlinkedRows();
    for (const rows of linked.values()) for (const r of rows) Object.assign(r, { sourceGroupId: 'grp-9' });
    const overrides = [OUT, IN].reduce((o, k) => setTxOverride(o, k, 'notTransfer', NOW), emptySyncOverrides());
    const fh = createFakeHost(twoAccounts({ existing: linked, syncOverrides: overrides }));
    await fh.store.setLinkedGroups({ [OUT]: 'wf-transfer-grp-9', [IN]: 'wf-transfer-grp-9' });
    const unlinkPair = vi.fn(async () => ({
      unlinked: true, inPlace: true as const, activityIds: ['act-out', 'act-in'] as [string, string],
      problems: ['unlinked … in place, but they are still typed as transfers (update: refused)'],
    }));
    const log = capture();
    await runSyncCore({ ...fh.host, capabilities: { readsSourceGroupId: false }, unlinkPair }, fh.store, { changeLog: log });
    expect(await fh.store.getLinkedGroups()).toEqual({ [OUT]: 'wf-transfer-grp-9', [IN]: 'wf-transfer-grp-9' });
    expect(log.entries().filter((e) => e.kind === 'bookkeeping')).toEqual([]);
  });

  it('drops the ledger records of a pair whose in-place unlink was complete', async () => {
    const linked = unlinkedRows();
    for (const rows of linked.values()) for (const r of rows) Object.assign(r, { sourceGroupId: 'grp-9' });
    const overrides = [OUT, IN].reduce((o, k) => setTxOverride(o, k, 'notTransfer', NOW), emptySyncOverrides());
    const fh = createFakeHost(twoAccounts({ existing: linked, syncOverrides: overrides }));
    await fh.store.setLinkedGroups({ [OUT]: 'wf-transfer-grp-9', [IN]: 'wf-transfer-grp-9' });
    const unlinkPair = vi.fn(async () => ({ unlinked: true, inPlace: true as const, activityIds: ['act-out', 'act-in'] as [string, string] }));
    await runSyncCore({ ...fh.host, capabilities: { readsSourceGroupId: false }, unlinkPair }, fh.store, {});
    expect(await fh.store.getLinkedGroups()).toEqual({});
  });
});
