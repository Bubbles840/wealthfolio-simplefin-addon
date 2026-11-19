import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConnectionProblemsRecord } from './connection-problems.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { normalizeAccountSet } from './simplefin-payload.js';
import { INTERVAL_SKIP_MESSAGE, runSyncCore, VALUATION_POLL } from './sync-core.js';

const NOW = new Date('2026-11-18T15:00:00.000Z');
const HOUR = 3_600_000;
const acct = (id: string, conn: string) => ({ id, name: id.toUpperCase(), currency: 'USD', balance: '0', 'balance-date': 1795046400, transactions: [], conn_id: conn });
const payload = (errlist: unknown[]) => normalizeAccountSet({
  errlist,
  connections: [{ conn_id: 'C1', name: 'Fidelity NetBenefits' }, { conn_id: 'C2', name: 'Old Bank' }],
  accounts: [acct('a1', 'C1'), acct('a2', 'C1'), acct('a9', 'C2')],
});
const SIGNIN = { code: 'con.auth', msg: 'Authentication required', conn_id: 'C1' };
const FAILED = { code: 'act.failed', msg: 'Failed to get account information', account_id: 'a2' };

/** a1 and a2 mapped; a9 (Old Bank) unmapped. The record lives in `saved`. */
function setup(errlist: unknown[], prev: ConnectionProblemsRecord | null = null, extra: Partial<FakeHostSeed> = {}) {
  const fh = createFakeHost({ accountSet: payload(errlist), mapping: { a1: 'wf-1', a2: 'wf-2' }, accountTypes: { 'wf-1': 'CASH', 'wf-2': 'CASH' }, ...extra });
  const saved: { record: ConnectionProblemsRecord | null } = { record: prev };
  Object.assign(fh.store, {
    getSimplefinProblems: vi.fn(async () => saved.record),
    setSimplefinProblems: vi.fn(async (r: ConnectionProblemsRecord) => { saved.record = r; }),
  });
  return { fh, saved };
}

describe('runSyncCore — SimpleFin connection problems are remembered (#81)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('records a sign-in problem, shows it at once, and still lists the error on the Sync page', async () => {
    const { fh, saved } = setup([SIGNIN, { code: 'con.auth', msg: 'Authentication required', conn_id: 'C2' }]);
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(saved.record).toEqual({ checkedAt: NOW.toISOString(), problems: [{
      key: 'con.auth:C1', code: 'con.auth', kind: 'signin', connectionName: 'Fidelity NetBenefits', sfinAccountIds: ['a1', 'a2'],
      message: 'Fidelity NetBenefits: Authentication required', firstSeenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(),
    }] });
    expect(result.connectionProblems?.map((p) => p.key)).toEqual(['con.auth:C1']);
    expect(result.errors).toContain('SimpleFin: Fidelity NetBenefits: Authentication required');
  });

  it('keeps the episode start, and shows an account problem once it has lasted a day', async () => {
    const start = new Date(NOW.getTime() - 30 * HOUR).toISOString();
    const prev = { checkedAt: start, problems: [{ key: 'act.failed:a2', code: 'act.failed', kind: 'other' as const, connectionName: 'Fidelity NetBenefits', sfinAccountIds: ['a2'], message: 'A2: Failed to get account information', firstSeenAt: start, lastSeenAt: start }] };
    const { fh, saved } = setup([FAILED], prev);
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(saved.record?.problems[0]).toMatchObject({ key: 'act.failed:a2', firstSeenAt: start, lastSeenAt: NOW.toISOString() });
    expect(result.connectionProblems?.map((p) => p.key)).toEqual(['act.failed:a2']);
  });

  it('drops a problem SimpleFin no longer reports', async () => {
    const { fh, saved } = setup([], { checkedAt: NOW.toISOString(), problems: [] });
    saved.record = { checkedAt: '2026-11-17T00:00:00.000Z', problems: [{ key: 'con.auth:C1', code: 'con.auth', kind: 'signin', sfinAccountIds: ['a1'], message: 'x', firstSeenAt: '2026-11-17T00:00:00.000Z', lastSeenAt: '2026-11-17T00:00:00.000Z' }] };
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(saved.record).toEqual({ checkedAt: NOW.toISOString(), problems: [] });
    expect(result.connectionProblems).toEqual([]);
  });

  it('leaves out a problem whose accounts are all ignored', async () => {
    const { fh, saved } = setup([SIGNIN]);
    (fh.store as any).getIgnoredAccounts = async () => ['a1', 'a2'];
    await runSyncCore(fh.host, fh.store, {});
    expect(saved.record?.problems).toEqual([]);
  });

  it('writes nothing, and says nothing, when the record cannot be read', async () => {
    const { fh } = setup([SIGNIN]);
    (fh.store as any).getSimplefinProblems = vi.fn(async () => { throw new Error('401'); });
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(fh.store.setSimplefinProblems).not.toHaveBeenCalled();
    expect(result.connectionProblems).toBeUndefined();
  });

  it('touches nothing on a run that downloaded nothing', async () => {
    const { fh } = setup([SIGNIN]);
    await runSyncCore(fh.host, fh.store, {});
    vi.mocked(fh.store.setSimplefinProblems!).mockClear();
    const skipped = await runSyncCore(fh.host, fh.store, {});
    expect(skipped.errors).toEqual([INTERVAL_SKIP_MESSAGE]);
    expect(skipped.connectionProblems).toBeUndefined();
    expect(fh.store.setSimplefinProblems).not.toHaveBeenCalled();
  });
});
