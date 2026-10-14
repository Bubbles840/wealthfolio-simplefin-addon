import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChangeEntry, ChangeLogSink } from './change-entries.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { VenmoLedger } from './venmo-ledger.js';

const NOW = new Date('2026-10-13T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const KEY = accountTxKey('sfin-1', 'tx-v');
const RENT_KEY = 'out|2500|Jane Doe|Rent October|2026-10-03';

function capture(): ChangeLogSink & { entries: () => ChangeEntry[] } {
  const batches: ChangeEntry[][] = [];
  return {
    writer: 'companion', run: 'cRUN1',
    append: vi.fn(async (entries: ChangeEntry[]) => { batches.push(entries); }),
    entries: () => batches.flat(),
  };
}

const RENT: VenmoLedger = {
  [RENT_KEY]: { direction: 'out', kind: 'payment', amountCents: 2500, counterparty: 'Jane Doe', note: 'Rent October', emailDate: '2026-10-03' },
};

/** Checking with one Venmo row on Oct 4, the day after Jane's email. */
const seed = (over: Partial<FakeHostSeed> = {}, amount = '-25.00'): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [{
    id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-13T12:00:00Z'),
    transactions: [{ id: 'tx-v', posted: epoch('2026-10-04T12:00:00Z'), amount, description: 'VENMO PAYMENT 1023' }],
  }] },
  mapping: { 'sfin-1': 'wf-a' },
  accountTypes: { 'wf-a': 'CASH' },
  accountNames: { 'wf-a': 'Checking' },
  venmoLedger: RENT,
  ...over,
});

/** The same row, imported before the email was read. */
const imported = () => new Map([['wf-a', [{
  id: 'act-v', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-04', amount: 25,
  comment: 'VENMO PAYMENT 1023 · tx-v', sourceGroupId: null,
}]]]);

const venmoEntries = (log: { entries: () => ChangeEntry[] }) => log.entries().filter((e) => e.kind === 'venmo-note');

describe('runSyncCore — Venmo notes', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('appends the note at import, consumes the payment, and logs the note beside the import', async () => {
    const fh = createFakeHost(seed());
    const log = capture();
    await runSyncCore(fh.host, fh.store, { changeLog: log });
    expect(fh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · Venmo: Rent October · tx-v');
    expect(fh.venmo()[RENT_KEY].consumedBy).toBe(KEY);
    const [entry] = venmoEntries(log);
    expect(entry).toMatchObject({
      kind: 'venmo-note', actor: 'auto', undoable: true,
      summary: 'Added the Venmo note "Rent October" to VENMO PAYMENT 1023',
      subject: { txKeys: [KEY], activityIds: [fh.activities.get('wf-a')![0].id], amountCents: -2500, date: '2026-10-04' },
      before: { comment: 'VENMO PAYMENT 1023 · tx-v' },
      after: { comment: 'VENMO PAYMENT 1023 · Venmo: Rent October · tx-v', note: 'Rent October' },
    });
    expect(log.entries().filter((e) => e.kind === 'import').map((e) => e.summary)).toEqual(['Imported VENMO PAYMENT 1023 · Venmo: Rent October']);
  });

  it('adds the note later to a row imported before its email was read — once', async () => {
    const fh = createFakeHost(seed({ existing: imported() }));
    const log = capture();
    await runSyncCore(fh.host, fh.store, { changeLog: log });
    expect(fh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · Venmo: Rent October · tx-v');
    expect(venmoEntries(log)).toEqual([expect.objectContaining({
      summary: 'Added the Venmo note "Rent October" to VENMO PAYMENT 1023',
      subject: expect.objectContaining({ activityIds: ['act-v'] }),
      before: { comment: 'VENMO PAYMENT 1023 · tx-v' },
      after: { comment: 'VENMO PAYMENT 1023 · Venmo: Rent October · tx-v', note: 'Rent October' },
    })]);
    const again = capture();
    await runSyncCore(fh.host, fh.store, { changeLog: again });
    expect(venmoEntries(again)).toEqual([]);
    expect(fh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · Venmo: Rent October · tx-v');
  });

  it('noVenmoNote: no note at import nor later, and the payment is still consumed', async () => {
    const syncOverrides = setTxOverride(emptySyncOverrides(), KEY, 'noVenmoNote', NOW);
    const fresh = createFakeHost(seed({ syncOverrides }));
    await runSyncCore(fresh.host, fresh.store, {});
    expect(fresh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · tx-v');
    expect(fresh.venmo()[RENT_KEY].consumedBy).toBe(KEY);

    const later = createFakeHost(seed({ syncOverrides, existing: imported() }));
    const log = capture();
    await runSyncCore(later.host, later.store, { changeLog: log });
    expect(later.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · tx-v');
    expect(venmoEntries(log)).toEqual([]);
  });

  it('gives no note when the direction does not match — $25.00 in is not the $25.00 you paid', async () => {
    const fh = createFakeHost(seed({}, '25.00'));
    await runSyncCore(fh.host, fh.store, {});
    expect(fh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · tx-v');
    expect(fh.venmo()[RENT_KEY].consumedBy).toBeUndefined();
  });

  it('gives no note when two payments of the same amount fall in the window', async () => {
    const two: VenmoLedger = {
      ...RENT,
      'out|2500|Sam Lee|Cable|2026-10-05': { direction: 'out', kind: 'payment', amountCents: 2500, counterparty: 'Sam Lee', note: 'Cable', emailDate: '2026-10-05' },
    };
    const fh = createFakeHost(seed({ venmoLedger: two }));
    await runSyncCore(fh.host, fh.store, {});
    expect(fh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · tx-v');
  });

  it('an older store without the Venmo ledger syncs exactly as before', async () => {
    const fh = createFakeHost(seed({ noVenmoLedger: true }));
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(result.errors).toEqual([]);
    expect(fh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · tx-v');
  });

  // Ruling P3-G: a note goes on POSTED rows only. A pending row's note is rewritten
  // when it posts, which would make the note's Undo read "changed since".
  const pendingSeed = (id = 'tx-v', over: Partial<FakeHostSeed> = {}): FakeHostSeed => {
    const s = seed(over);
    const acct = s.accountSet!.accounts[0];
    acct.transactions = [{ id, posted: epoch('2026-10-04T12:00:00Z'), amount: '-25.00', description: 'VENMO PAYMENT 1023', pending: true }];
    return s;
  };

  it('gives a pending row no note and no entry, and does not consume the payment', async () => {
    const fh = createFakeHost(pendingSeed());
    const log = capture();
    await runSyncCore(fh.host, fh.store, { changeLog: log });
    expect(fh.activities.get('wf-a')![0].comment).not.toContain('Venmo:');
    expect(venmoEntries(log)).toEqual([]);
    expect(fh.venmo()[RENT_KEY].consumedBy).toBeUndefined();
  });

  it('the same transaction, once posted, gets its note and one entry — under the same tx id or a new one', async () => {
    for (const postedId of ['tx-v', 'tx-v2']) {
      const s = pendingSeed();
      const fh = createFakeHost(s);
      await runSyncCore(fh.host, fh.store, {});
      expect(fh.activities.get('wf-a')![0].comment).not.toContain('Venmo:');
      // The feed now reports it posted (a pending row's id often changes on posting).
      s.accountSet!.accounts[0].transactions = [{ id: postedId, posted: epoch('2026-10-04T12:00:00Z'), amount: '-25.00', description: 'VENMO PAYMENT 1023' }];
      const log = capture();
      await runSyncCore(fh.host, fh.store, { changeLog: log, force: true });
      expect(venmoEntries(log)).toHaveLength(1);
      expect(fh.activities.get('wf-a')!.some((r) => r.comment === `VENMO PAYMENT 1023 · Venmo: Rent October · ${postedId}`)).toBe(true);
      expect(fh.venmo()[RENT_KEY].consumedBy).toBe(accountTxKey('sfin-1', postedId));
    }
  });

  it('takes the direction from the sign alone — on a card account too', async () => {
    const out = createFakeHost(seed({ accountTypes: { 'wf-a': 'CREDIT_CARD' } }));
    await runSyncCore(out.host, out.store, {});
    expect(out.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · Venmo: Rent October · tx-v');
    const inn = createFakeHost(seed({ accountTypes: { 'wf-a': 'CREDIT_CARD' } }, '25.00'));
    await runSyncCore(inn.host, inn.store, {});
    expect(inn.activities.get('wf-a')![0].comment).not.toContain('Venmo:');
    expect(inn.venmo()[RENT_KEY].consumedBy).toBeUndefined();
  });

  it('a ledger with an unreadable entry adds no notes, throws nothing, and is never overwritten', async () => {
    const bad = { ...RENT, 'id|1': null, 'id|2': 'x' } as unknown as VenmoLedger;
    const fh = createFakeHost(seed({ venmoLedger: bad }));
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(result.errors).toEqual([]);
    expect(fh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · tx-v');
    expect(fh.venmo()).toBe(bad);
  });

  it('a ledger that cannot be read skips Venmo notes for the run', async () => {
    const fh = createFakeHost(seed());
    fh.store.getVenmoLedger = async () => { throw new Error('boom'); };
    const spy = vi.spyOn(fh.store, 'setVenmoLedger' as any);
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(result.errors).toEqual([]);
    expect(fh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · tx-v');
    expect(spy).not.toHaveBeenCalled();
  });
});
