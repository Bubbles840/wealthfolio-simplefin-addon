import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { INTERVAL_SKIP_MESSAGE, runSyncCore, VALUATION_POLL } from './sync-core.js';
import { clockTime } from './simplefin-budget.js';
import type { SimplefinTransaction } from './types.js';

const NOW = new Date('2026-10-18T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const at = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000);
const tx = (id: string, iso: string, amount: string, description: string): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description });
/** `n` requests, the newest `newestMinutesAgo` before NOW, one every 30 minutes before it. */
const logOf = (n: number, newestMinutesAgo = 60) =>
  JSON.stringify(Array.from({ length: n }, (_, i) => at(-(newestMinutesAgo + i * 30)).toISOString()));

const seedOf = (requestLog: { raw: string | null; failReads?: boolean }, extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-spend', name: 'Spend', currency: 'USD', balance: '500.00', 'balance-date': epoch('2026-10-18T12:00:00Z'),
      transactions: [tx('pay', '2026-10-17T12:00:00Z', '100.00', 'PAYROLL')] },
  ] },
  mapping: { 'sfin-spend': 'wf-spend' },
  accountTypes: { 'wf-spend': 'CASH' },
  valuations: new Map([['wf-spend', 500]]),
  requestLog,
  ...extra,
});
const fetchSpy = (fh: ReturnType<typeof createFakeHost>) => vi.spyOn(fh.host, 'fetchSimplefin');
const requests = (log: { raw: string | null }) => (JSON.parse(log.raw ?? '[]') as string[]);

describe('runSyncCore — SimpleFin is never asked more often than it allows (C)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('refuses the 21st download in 24 hours — manual, /sync and scheduled — with the one line, and writes nothing', async () => {
    const line = `SimpleFin's daily limit is used up — next sync at ${clockTime(at(-630 + 24 * 60))}.`;
    for (const opts of [{ manual: true }, { manual: true, force: true }, {}]) {
      const log = { raw: logOf(20) };
      const fh = createFakeHost(seedOf(log));
      const fetch = fetchSpy(fh);
      const result = await runSyncCore(fh.host, fh.store, opts);
      expect(fetch).not.toHaveBeenCalled();
      expect(result.download).toEqual({ kind: 'skipped', line });
      expect(result.errors).toEqual([]);
      expect(fh.saved).toEqual([]);
      expect(requests(log)).toHaveLength(20);
    }
  });

  it('records each download before sending it, and a failed one still counts', async () => {
    const log = { raw: null as string | null };
    const fh = createFakeHost(seedOf(log));
    await runSyncCore(fh.host, fh.store, { manual: true });
    expect(requests(log)).toEqual([NOW.toISOString()]);

    vi.setSystemTime(at(10));
    fh.host.fetchSimplefin = async () => { throw new Error('SimpleFin is unreachable'); };
    await expect(runSyncCore(fh.host, fh.store, { manual: true })).rejects.toThrow('unreachable');
    expect(requests(log)).toEqual([at(10).toISOString(), NOW.toISOString()]);
  });

  it('a Sync 2 minutes after a download does not call SimpleFin and still re-checks balances', async () => {
    const log = { raw: null as string | null };
    const fh = createFakeHost(seedOf(log));
    await runSyncCore(fh.host, fh.store, { manual: true });
    // The payroll deposit was imported this run, so Spend could not be checked.
    expect((await fh.store.getAccountBalances())['sfin-spend']).toMatchObject({ measured: false });

    vi.setSystemTime(at(2));
    const fetch = fetchSpy(fh);
    for (const opts of [{ manual: true }, { manual: true, heal: true }]) {
      const result = await runSyncCore(fh.host, fh.store, opts);
      expect(result.download).toEqual({ kind: 'checkOnly', line: 'Balances checked · bank data is from 2 min ago.' });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(requests(log)).toHaveLength(1);
    expect((await fh.store.getAccountBalances())['sfin-spend']).toMatchObject({ measured: true, drift: null });
  });

  it('both writers share one count: the other writer\'s scheduled run inside the gap is skipped quietly', async () => {
    const log = { raw: null as string | null };
    const app = createFakeHost(seedOf(log));
    await runSyncCore(app.host, app.store, { manual: true });
    vi.setSystemTime(at(3));
    const companion = createFakeHost(seedOf(log));
    const fetch = fetchSpy(companion);
    const result = await runSyncCore(companion.host, companion.store, {});
    expect(fetch).not.toHaveBeenCalled();
    expect(result.download).toEqual({ kind: 'skipped', line: 'SimpleFin was asked 3 min ago — this scheduled sync was skipped.' });
    expect(result.errors).toEqual([]);
  });

  it('an unreadable record blocks the download', async () => {
    const fh = createFakeHost(seedOf({ raw: null, failReads: true }));
    const fetch = fetchSpy(fh);
    const result = await runSyncCore(fh.host, fh.store, { manual: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.download).toEqual({ kind: 'skipped', line: "Couldn't read the SimpleFin request log — nothing was downloaded." });
  });

  it('the one-hour wall is gone for manual actions, and stays for scheduled runs (C6)', async () => {
    const log = { raw: logOf(1, 10) };
    const fh = createFakeHost(seedOf(log));
    await fh.store.setLastSyncAt(at(-10));
    const fetch = fetchSpy(fh);
    expect((await runSyncCore(fh.host, fh.store, {})).errors).toEqual([INTERVAL_SKIP_MESSAGE]);
    expect(fetch).not.toHaveBeenCalled();
    const manual = await runSyncCore(fh.host, fh.store, { manual: true });
    expect(manual.download).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a store with no record downloads as before', async () => {
    const seed = seedOf({ raw: null });
    delete seed.requestLog;
    const fh = createFakeHost(seed);
    const fetch = fetchSpy(fh);
    expect((await runSyncCore(fh.host, fh.store, { manual: true })).download).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
