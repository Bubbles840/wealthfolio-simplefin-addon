import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import { emptySyncOverrides, pruneTxOverrides, setTxOverride, type SyncOverrides } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const KEY = accountTxKey('sfin-1', 'tx-1');

const payback = (at: Date = NOW): SyncOverrides => setTxOverride(emptySyncOverrides(), KEY, 'asReimbursement', at, { label: 'VENMO CASHOUT · Checking' });

/** Checking (a cash account), whose feed carries one Venmo cash-out of `amount`. */
const seed = (amount: string, extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
      transactions: [{ id: 'tx-1', posted: epoch('2026-10-09T12:00:00Z'), amount, description: 'VENMO CASHOUT' }] },
  ] },
  mapping: { 'sfin-1': 'wf-a' },
  accountTypes: { 'wf-a': 'CASH' },
  accountNames: { 'wf-a': 'Checking' },
  ...extra,
});
const stored = (over: Partial<HostActivity> = {}): Map<string, HostActivity[]> => new Map([['wf-a', [{
  id: 'act-7', accountId: 'wf-a', activityType: 'CREDIT', subtype: 'REIMBURSEMENT', date: '2026-10-09', amount: 14,
  comment: 'VENMO CASHOUT · tx-1', sourceGroupId: null, ...over,
}]]]);
const row = (fh: ReturnType<typeof createFakeHost>) => fh.activities.get('wf-a')!.find((r) => r.comment?.endsWith('tx-1'))!;

describe('runSyncCore — a payback (asReimbursement)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is never reverted: a payback the feed calls a deposit stays a CREDIT marked REIMBURSEMENT, sync after sync', async () => {
    const fh = createFakeHost(seed('14.00', { existing: stored(), syncOverrides: payback() }));
    expect((await runSyncCore(fh.host, fh.store, {})).errors).toEqual([]);
    expect(fh.saved.filter((r) => (r.updates ?? []).length > 0 || (r.creates ?? []).length > 0)).toEqual([]);
    await runSyncCore(fh.host, fh.store, { force: true });
    expect(fh.saved.filter((r) => (r.updates ?? []).length > 0)).toEqual([]);
    expect(row(fh)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });

  it('makes a row whose re-type never landed a payback', async () => {
    const fh = createFakeHost(seed('14.00', { existing: stored({ activityType: 'DEPOSIT', subtype: null }), syncOverrides: payback() }));
    await runSyncCore(fh.host, fh.store, {});
    expect(row(fh)).toMatchObject({ id: 'act-7', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });

  it('imports a new row as a payback when the override came first', async () => {
    const fh = createFakeHost(seed('14.00', { syncOverrides: payback() }));
    await runSyncCore(fh.host, fh.store, {});
    expect(row(fh)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT', amount: 14 });
  });

  it('beats a keyword that would type it a transfer, and is never paired or linked', async () => {
    const fh = createFakeHost(seed('14.00', {
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
          transactions: [{ id: 'tx-1', posted: epoch('2026-10-09T12:00:00Z'), amount: '14.00', description: 'ONLINE TRANSFER FROM SAV' }] },
        { id: 'sfin-2', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
          transactions: [{ id: 'tx-2', posted: epoch('2026-10-09T12:00:00Z'), amount: '-14.00', description: 'ONLINE TRANSFER TO CHK' }] },
      ] },
      mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
      accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CASH' },
      syncOverrides: payback(),
    }));
    await runSyncCore(fh.host, fh.store, {});
    expect(row(fh)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT', sourceGroupId: null });
    expect(fh.links).toEqual([]);
  });

  it('yields when the bank turns it into money out: typed as usual', async () => {
    const fh = createFakeHost(seed('-14.00', { existing: stored(), syncOverrides: payback() }));
    await runSyncCore(fh.host, fh.store, {});
    expect(row(fh).activityType).toBe('WITHDRAWAL');
  });

  it('yields on an account that is not cash', async () => {
    const fh = createFakeHost(seed('14.00', { accountTypes: { 'wf-a': 'CREDIT_CARD' }, syncOverrides: payback() }));
    await runSyncCore(fh.host, fh.store, {});
    expect(row(fh)).toMatchObject({ activityType: 'CREDIT', subtype: null });
  });

  it('leaves the stored payback as it is once its year runs out and the next overrides write prunes the flag (I-1)', async () => {
    const lapsed = pruneTxOverrides(payback(new Date('2025-10-13T15:00:00Z')), NOW);
    expect(lapsed.tx).toEqual({});
    const fh = createFakeHost(seed('14.00', { existing: stored(), syncOverrides: lapsed }));
    await runSyncCore(fh.host, fh.store, {});
    expect(row(fh)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });
  const writes = (fh: ReturnType<typeof createFakeHost>) => fh.saved.filter((r) => (r.updates ?? []).length > 0 || (r.creates ?? []).length > 0);
  const NOTE = 'Couldn\u2019t read your sync overrides \u2014 paybacks were left as they are.';

  it('keeps a payback when the account types cannot be read (an unknown type does not yield)', async () => {
    const fh = createFakeHost(seed('14.00', { existing: stored(), syncOverrides: payback() }));
    const host = { ...fh.host, listAccounts: async () => { throw new Error('down'); } };
    await runSyncCore(host, fh.store, {});
    expect(writes(fh)).toEqual([]);
    expect(row(fh)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });

  it.each([
    ['a rejected read', async () => { throw new Error('ECONNREFUSED'); }],
    ['a corrupt document', async () => ({ overrides: emptySyncOverrides(), unreadable: true })],
  ])('leaves a stored payback exactly as stored after %s, with one note', async (_n, read) => {
    const fh = createFakeHost(seed('14.00', { existing: stored() }));
    const store = { ...fh.store, readSyncOverrides: read };
    const result = await runSyncCore(fh.host, store, {});
    expect(writes(fh)).toEqual([]);
    expect(row(fh)).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
    expect(result.errors.filter((e) => e.includes('sync overrides'))).toEqual([NOTE]);
  });

  it('keeps a stored payback whose date is the instant 2026-10-09T12:00:00Z', async () => {
    const fh = createFakeHost(seed('14.00', { existing: stored({ date: '2026-10-09T12:00:00Z' }), syncOverrides: payback() }));
    await runSyncCore(fh.host, fh.store, {});
    expect(writes(fh)).toEqual([]);
  });

  it('keeps a stored payback on a non-cash account (a subtype is only ever added)', async () => {
    const fh = createFakeHost(seed('14.00', { accountTypes: { 'wf-a': 'CREDIT_CARD' }, existing: stored(), syncOverrides: payback() }));
    await runSyncCore(fh.host, fh.store, {});
    expect(writes(fh)).toEqual([]);
  });

  it('still applies an override past its year until the next write prunes it (by design)', async () => {
    // Expiry is the next overrides WRITE\u2019s prune, not the sync\u2019s clock.
    const stale = payback(new Date('2025-10-13T15:00:00Z'));
    const fh = createFakeHost(seed('14.00', { existing: stored(), syncOverrides: stale }));
    await runSyncCore(fh.host, fh.store, {});
    expect(writes(fh)).toEqual([]);
  });

  it('leaves a transfer-typed leg under an asReimbursement key alone on a host that cannot read groups, with a note', async () => {
    const fh = createFakeHost(seed('14.00', { existing: stored({ activityType: 'TRANSFER_IN', subtype: null }), syncOverrides: payback() }));
    const host = { ...fh.host, capabilities: { readsSourceGroupId: false } };
    const result = await runSyncCore(host, fh.store, {});
    expect(writes(fh)).toEqual([]);
    expect(row(fh).activityType).toBe('TRANSFER_IN');
    expect(result.errors.some((e) => e.startsWith('Left ') && e.includes('as it is'))).toBe(true);
  });

  const yieldLines = async (sd: FakeHostSeed) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const fh = createFakeHost(sd);
      const result = await runSyncCore(fh.host, fh.store, {});
      return { result, lines: info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('payback yielded')) };
    } finally {
      info.mockRestore();
    }
  };

  it('logs one tagged line when the override yields on money out, naming account and transaction apart, without an errors note', async () => {
    const { result, lines } = await yieldLines(seed('-14.00', { existing: stored(), syncOverrides: payback() }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[simplefin-sync] payback yielded');
    expect(lines[0]).toContain('account sfin-1');
    expect(lines[0]).toContain('transaction tx-1');
    expect(lines[0]).not.toContain('\u0000');
    expect(result.errors).toEqual([]);
  });

  it('logs nothing when the override yields but the planned type is the stored one (a card CREDIT)', async () => {
    const { lines } = await yieldLines(seed('14.00', { accountTypes: { 'wf-a': 'CREDIT_CARD' }, existing: stored(), syncOverrides: payback() }));
    expect(lines).toEqual([]);
  });

  describe('when the overrides document cannot be read', () => {
    const failing = (fh: ReturnType<typeof createFakeHost>) => ({ ...fh.store,
      getSyncOverrides: async () => { throw new Error('ECONNRESET'); },
      readSyncOverrides: async () => { throw new Error('ECONNRESET'); } });
    const acct2 = (id: string, name: string, txs: Array<{ id: string; amount: string; description: string }>) => ({
      id, name, currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
      transactions: txs.map((t) => ({ ...t, posted: epoch('2026-10-09T12:00:00Z') })) });

    it('reads the document once: a first read that fails and a second that works cannot revert a payback', async () => {
      const fh = createFakeHost(seed('14.00', { existing: stored() }));
      let reads = 0;
      const store = { ...fh.store,
        getSyncOverrides: async () => { reads++; throw new Error('blip'); },
        readSyncOverrides: async () => { reads++; return { overrides: payback(), unreadable: false }; } };
      const result = await runSyncCore(fh.host, store, {});
      expect(writes(fh)).toEqual([]);
      expect(reads).toBe(1);
      expect(result.errors).toEqual([]);
    });

    it('does not hide a pending row: it posts under a new id and replaces the pending one, no duplicate', async () => {
      const fh = createFakeHost({
        accountSet: { errors: [], accounts: [acct2('sfin-1', 'Checking', [{ id: 'tx-q', amount: '14.00', description: 'VENMO CASHOUT' }])] },
        mapping: { 'sfin-1': 'wf-a' }, accountTypes: { 'wf-a': 'CASH' },
        mappingRules: [{ pattern: 'VENMO', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' } as never],
        existing: new Map([['wf-a', [{ id: 'act-9', accountId: 'wf-a', activityType: 'CREDIT', subtype: 'REIMBURSEMENT', date: '2026-10-08', amount: 14,
          comment: 'VENMO CASHOUT \u00b7 tx-p \u00b7 pending', sourceGroupId: null } as HostActivity]]]),
      });
      await runSyncCore(fh.host, failing(fh), { force: true });
      expect(fh.activities.get('wf-a')!).toHaveLength(1);
      await runSyncCore(fh.host, { ...fh.store, getSyncOverrides: async () => emptySyncOverrides(), readSyncOverrides: async () => ({ overrides: emptySyncOverrides(), unreadable: false }) }, { force: true });
      expect(fh.activities.get('wf-a')!).toHaveLength(1);
    });

    it('keeps a stored payback out of pair detection: a partner placeholder in another account is not rewritten', async () => {
      const partner: HostActivity = { id: 'act-8', accountId: 'wf-b', activityType: 'TRANSFER_OUT', subtype: null, date: '2026-10-09', amount: 14,
        comment: '\u2194\ufe0f In-transit transfer \u00b7 ONLINE TRANSFER TO CHK \u00b7 tx-2', sourceGroupId: null, metadata: '{"flow":{"is_external":true}}' } as HostActivity;
      const fh = createFakeHost({
        accountSet: { errors: [], accounts: [
          acct2('sfin-1', 'Checking', [{ id: 'tx-1', amount: '14.00', description: 'VENMO CASHOUT' }]),
          acct2('sfin-2', 'Savings', [{ id: 'tx-2', amount: '-14.00', description: 'ONLINE TRANSFER TO CHK' }]),
        ] },
        mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' }, accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CASH' },
        existing: new Map([['wf-a', stored().get('wf-a')!], ['wf-b', [partner]]]),
      });
      await runSyncCore(fh.host, failing(fh), { force: true });
      expect(writes(fh)).toEqual([]);
      expect(fh.links).toEqual([]);
    });
  });

  it('leaves BOTH legs alone on a host that cannot read groups: the flagged leg and its linked partner in another account', async () => {
    const fh = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
          transactions: [{ id: 'tx-1', posted: epoch('2026-10-09T12:00:00Z'), amount: '14.00', description: 'ONLINE TRANSFER FROM SAV' }] },
        { id: 'sfin-2', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
          transactions: [{ id: 'tx-1', posted: epoch('2026-10-09T12:00:00Z'), amount: '-14.00', description: 'ONLINE TRANSFER TO CHK' }] },
      ] },
      mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' }, accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CASH' },
      existing: new Map([
        ['wf-a', [{ id: 'act-7', accountId: 'wf-a', activityType: 'TRANSFER_IN', subtype: null, date: '2026-10-09', amount: 14, comment: 'ONLINE TRANSFER FROM SAV \u00b7 tx-1', sourceGroupId: 'g1' } as HostActivity]],
        ['wf-b', [{ id: 'act-8', accountId: 'wf-b', activityType: 'TRANSFER_OUT', subtype: null, date: '2026-10-09', amount: 14, comment: 'ONLINE TRANSFER TO CHK \u00b7 tx-1', sourceGroupId: 'g1' } as HostActivity]],
      ]),
      syncOverrides: payback(),
    });
    const host = { ...fh.host, capabilities: { readsSourceGroupId: false } };
    const result = await runSyncCore(host, fh.store, { force: true });
    expect(writes(fh)).toEqual([]);
    expect(result.errors.some((e) => e.includes('it is marked a payback but is now a transfer this app did not link'))).toBe(true);
  });

  describe('the foreign-payback partner prescan (PB-H)', () => {
    const two = (savAmount: string, wfB: HostActivity, overrides = payback(), extraAccount = false): FakeHostSeed => ({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
          transactions: [{ id: 'tx-1', posted: epoch('2026-10-09T12:00:00Z'), amount: '14.00', description: 'ONLINE TRANSFER FROM SAV' }] },
        { id: 'sfin-2', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
          transactions: [{ id: 'tx-1', posted: epoch('2026-10-09T12:00:00Z'), amount: savAmount, description: 'ONLINE TRANSFER TO CHK' }] },
        ...(extraAccount ? [{ id: 'sfin-3', name: 'Other', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-14T12:00:00Z'),
          transactions: [{ id: 'tx-9', posted: epoch('2026-10-09T12:00:00Z'), amount: '5.00', description: 'COFFEE REFUND' }] }] : []),
      ] },
      mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b', ...(extraAccount ? { 'sfin-3': 'wf-c' } : {}) },
      accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CASH', 'wf-c': 'CASH' },
      existing: new Map([
        ['wf-a', [{ id: 'act-7', accountId: 'wf-a', activityType: 'TRANSFER_IN', subtype: null, date: '2026-10-09', amount: 14, comment: 'ONLINE TRANSFER FROM SAV \u00b7 tx-1', sourceGroupId: 'g1' } as HostActivity]],
        ['wf-b', [wfB]],
      ]),
      syncOverrides: overrides,
    });
    const partner = (over: Partial<HostActivity> = {}): HostActivity => ({
      id: 'act-8', accountId: 'wf-b', activityType: 'TRANSFER_OUT', subtype: null, date: '2026-10-09', amount: 14,
      comment: 'ONLINE TRANSFER TO CHK \u00b7 tx-1', sourceGroupId: 'g1', ...over,
    });
    const readsOff = (fh: ReturnType<typeof createFakeHost>) => ({ ...fh.host, capabilities: { readsSourceGroupId: false } });

    it('m-a: an unrelated same-id row of ANOTHER AMOUNT in another account is not hidden with the payback', async () => {
      const fh = createFakeHost(two('-14.00', partner({ amount: 99 })));
      await runSyncCore(readsOff(fh), fh.store, { force: true });
      expect(fh.activities.get('wf-b')!.find((r) => r.id === 'act-8')!.amount).toBe(14);
    });

    it('m-a: nor one of the SAME direction (not the opposite transfer type)', async () => {
      const fh = createFakeHost(two('14.00', partner({ activityType: 'TRANSFER_IN', amount: 99 })));
      await runSyncCore(readsOff(fh), fh.store, { force: true });
      expect(fh.activities.get('wf-b')!.find((r) => r.id === 'act-8')!.amount).toBe(14);
    });

    it('m-a: the real partner (same amount, opposite type) is still left alone', async () => {
      const fh = createFakeHost(two('-14.00', partner({ amount: 14 })));
      await runSyncCore(readsOff(fh), fh.store, { force: true });
      expect(writes(fh)).toEqual([]);
    });

    it('m-b: reads only the flagged transaction’s accounts, and nothing extra when no flagged id is in this run’s feed', async () => {
      const readCount = async (overrides: SyncOverrides) => {
        const fh = createFakeHost(two('-14.00', partner(), overrides, true));
        const calls: string[] = [];
        const host = { ...readsOff(fh), listActivities: async (id: string) => { calls.push(id); return fh.host.listActivities(id); } };
        await runSyncCore(host, fh.store, { force: true });
        return (id: string) => calls.filter((c) => c === id).length;
      };
      const none = await readCount(emptySyncOverrides());
      const flaggedHere = await readCount(payback());
      const flaggedElsewhere = await readCount(setTxOverride(emptySyncOverrides(), accountTxKey('sfin-1', 'tx-gone'), 'asReimbursement', NOW));
      // The bystander account is never read for the prescan.
      expect(flaggedHere('wf-c')).toBe(none('wf-c'));
      // A flagged id that is not in the feed costs no extra read anywhere.
      for (const a of ['wf-a', 'wf-b', 'wf-c']) expect(flaggedElsewhere(a)).toBe(none(a));
    });
  });
});
