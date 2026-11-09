import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  automaticDownloadAllowed,
  HOLDINGS_CATCHUP_AFTER_MS,
  HOLDINGS_CATCHUP_QUIET_MS,
  HoldingsCatchUp,
  holdingsCatchUpDue,
  mapsInvestmentAccount,
  type HoldingsCatchUpDeps,
  type InvestmentAccounts,
} from './holdings-catchup';
import { SIMPLEFIN_AUTO_GAP_MS, SIMPLEFIN_AUTO_LIMIT, SIMPLEFIN_FUTURE_TOLERANCE_MS } from '../../shared/simplefin-budget';
import { SCHEDULER_POLL_MS } from './scheduler';

const NOW = new Date('2026-09-12T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const log = (...stamps: Date[]) => JSON.stringify(stamps.map((d) => d.toISOString()));

describe('holdingsCatchUpDue', () => {
  it('is due when no pass was ever recorded', () => {
    expect(holdingsCatchUpDue(null, NOW)).toBe(true);
  });

  it('is due from the threshold on, not a moment before', () => {
    expect(holdingsCatchUpDue(ago(HOLDINGS_CATCHUP_AFTER_MS - 1), NOW)).toBe(false);
    expect(holdingsCatchUpDue(ago(HOLDINGS_CATCHUP_AFTER_MS), NOW)).toBe(true);
  });

  it('is due when the stamp is further in the future than the tolerance (a clock far ahead)', () => {
    expect(holdingsCatchUpDue(ago(-SIMPLEFIN_FUTURE_TOLERANCE_MS - 1), NOW)).toBe(true);
    expect(holdingsCatchUpDue(ago(-SIMPLEFIN_FUTURE_TOLERANCE_MS), NOW)).toBe(false);
  });

  it('is due on an invalid date', () => {
    expect(holdingsCatchUpDue(new Date('nonsense'), NOW)).toBe(true);
  });
});

describe('automaticDownloadAllowed', () => {
  it('allows with no request recorded', () => {
    expect(automaticDownloadAllowed(null, NOW)).toBe(true);
    expect(automaticDownloadAllowed('[]', NOW)).toBe(true);
  });

  it("waits an hour after the newest request, any writer's", () => {
    expect(automaticDownloadAllowed(log(ago(SIMPLEFIN_AUTO_GAP_MS - 60_000)), NOW)).toBe(false);
    expect(automaticDownloadAllowed(log(ago(SIMPLEFIN_AUTO_GAP_MS)), NOW)).toBe(true);
  });

  it('stops at the automatic share of the daily budget', () => {
    const full = Array.from({ length: SIMPLEFIN_AUTO_LIMIT }, (_, i) => ago(2 * SIMPLEFIN_AUTO_GAP_MS + i * 60_000));
    expect(automaticDownloadAllowed(log(...full), NOW)).toBe(false);
    expect(automaticDownloadAllowed(log(...full.slice(1)), NOW)).toBe(true);
  });

  it('says no to a corrupt record (fail closed)', () => {
    expect(automaticDownloadAllowed('{not json', NOW)).toBe(false);
  });
});

describe('mapsInvestmentAccount', () => {
  const mapping = { 'sfin-1': 'wf-1', 'sfin-2': 'wf-2' };

  it('finds a mapped SECURITIES account, whatever its tracking mode', () => {
    expect(mapsInvestmentAccount(mapping, [{ id: 'wf-1', accountType: 'SECURITIES', trackingMode: 'TRANSACTIONS' }])).toBe(true);
  });

  it('finds a mapped crypto account', () => {
    expect(mapsInvestmentAccount(mapping, [{ id: 'wf-1', accountType: 'CRYPTOCURRENCY', trackingMode: 'TRANSACTIONS' }])).toBe(true);
  });

  it('finds a mapped account in Holdings mode, whatever its type', () => {
    expect(mapsInvestmentAccount(mapping, [{ id: 'wf-2', accountType: 'CASH', trackingMode: 'HOLDINGS' }])).toBe(true);
  });

  it('ignores investment accounts nobody mapped, and cash accounts', () => {
    expect(mapsInvestmentAccount(mapping, [
      { id: 'wf-9', accountType: 'SECURITIES' },
      { id: 'wf-1', accountType: 'CASH', trackingMode: 'TRANSACTIONS' },
    ])).toBe(false);
  });

  it('is false with no mapping', () => {
    expect(mapsInvestmentAccount(null, [{ id: 'wf-1', accountType: 'SECURITIES' }])).toBe(false);
  });
});

describe('HoldingsCatchUp', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const deps = (over: Partial<HoldingsCatchUpDeps> = {}): HoldingsCatchUpDeps & { runSync: ReturnType<typeof vi.fn> } => ({
    getHoldingsPassAt: async () => ago(HOLDINGS_CATCHUP_AFTER_MS),
    getRequestLog: async () => log(ago(SIMPLEFIN_AUTO_GAP_MS)),
    scheduleOn: async () => false,
    companionSyncing: async () => true,
    investmentAccounts: async () => 'mapped' as const,
    setupKey: async () => '{"sfin-a":"wf-a"}',
    now: () => NOW,
    ...over,
    runSync: vi.fn(over.runSync ?? (async () => undefined)),
  });

  const checkOnce = async (d: HoldingsCatchUpDeps) => {
    const c = new HoldingsCatchUp(d);
    await c.check();
    return c;
  };

  it('runs a sync when due, allowed by the budget and an investment account is mapped', async () => {
    const d = deps();
    await checkOnce(d);
    expect(d.runSync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not due yet', { getHoldingsPassAt: async () => ago(60_000) }],
    ['the budget says wait', { getRequestLog: async () => log(ago(60_000)) }],
    ['the budget record is unreadable', { getRequestLog: async () => { throw new Error('secret read failed'); } }],
    ['no investment account is mapped', { investmentAccounts: async () => 'none' as const }],
    ['setup is not finished', { investmentAccounts: async () => 'notSetUp' as const }],
    ['the schedule is off and no companion is syncing', { scheduleOn: async () => false, companionSyncing: async () => false }],
  ] as Array<[string, Partial<HoldingsCatchUpDeps>]>)('does not run when %s', async (_why, over) => {
    const d = deps(over);
    await checkOnce(d);
    expect(d.runSync).not.toHaveBeenCalled();
  });

  it('starts no sync once stopped, even from a check already under way', async () => {
    let release: ((v: InvestmentAccounts) => void) | null = null;
    const d = deps({ investmentAccounts: () => new Promise<InvestmentAccounts>((r) => { release = r; }) });
    const c = new HoldingsCatchUp(d);
    const pending = c.check();
    await vi.waitFor(() => expect(release).not.toBeNull());
    c.stop();
    release!('mapped');
    await pending;
    expect(d.runSync).not.toHaveBeenCalled();
  });

  it('stays quiet for a while after finding no investment account, then asks again', async () => {
    let now = NOW;
    const hasInvestmentAccounts = vi.fn(async (): Promise<InvestmentAccounts> => 'none');
    const d = deps({ investmentAccounts: hasInvestmentAccounts, now: () => now });
    const c = new HoldingsCatchUp(d);
    await c.check();
    now = new Date(NOW.getTime() + HOLDINGS_CATCHUP_QUIET_MS - 1);
    await c.check();
    expect(hasInvestmentAccounts).toHaveBeenCalledTimes(1);
    now = new Date(NOW.getTime() + HOLDINGS_CATCHUP_QUIET_MS);
    await c.check();
    expect(hasInvestmentAccounts).toHaveBeenCalledTimes(2);
  });

  it('ends the quiet as soon as the mapping changes', async () => {
    let key = '{"sfin-a":"wf-a"}';
    let state: InvestmentAccounts = 'none';
    const d = deps({ investmentAccounts: async () => state, setupKey: async () => key });
    const c = new HoldingsCatchUp(d);
    await c.check();
    await c.check();
    expect(d.runSync).not.toHaveBeenCalled();
    // A brokerage account mapped minutes later.
    key = '{"sfin-a":"wf-a","sfin-b":"wf-b"}';
    state = 'mapped';
    await c.check();
    expect(d.runSync).toHaveBeenCalledTimes(1);
  });

  it('with the schedule off and no companion, goes quiet reading only those two', async () => {
    let scheduleOn = false;
    const getHoldingsPassAt = vi.fn(async () => ago(HOLDINGS_CATCHUP_AFTER_MS));
    const getRequestLog = vi.fn(async () => log(ago(SIMPLEFIN_AUTO_GAP_MS)));
    const d = deps({ scheduleOn: async () => scheduleOn, companionSyncing: async () => false, getHoldingsPassAt, getRequestLog });
    const c = new HoldingsCatchUp(d);
    await c.check();
    await c.check();
    await c.check();
    expect(getHoldingsPassAt).toHaveBeenCalledTimes(1);
    expect(getRequestLog).toHaveBeenCalledTimes(1);
    expect(d.runSync).not.toHaveBeenCalled();
    // The schedule turned on: caught at the next poll.
    scheduleOn = true;
    await c.check();
    expect(d.runSync).toHaveBeenCalledTimes(1);
  });

  it('ends the schedule-off quiet when a companion starts syncing', async () => {
    let companion = false;
    const d = deps({ companionSyncing: async () => companion });
    const c = new HoldingsCatchUp(d);
    await c.check();
    companion = true;
    await c.check();
    expect(d.runSync).toHaveBeenCalledTimes(1);
  });

  it('asks the companion check about the poll\'s own time', async () => {
    const companionSyncing = vi.fn(async (_now: Date) => true);
    await checkOnce(deps({ companionSyncing }));
    expect(companionSyncing).toHaveBeenCalledWith(NOW);
  });

  it('stays quiet, without a sync, when the quiet check itself cannot read', async () => {
    let fail = false;
    const d = deps({ investmentAccounts: async () => 'none' as const, setupKey: async () => { if (fail) throw new Error('read failed'); return 'k'; } });
    const c = new HoldingsCatchUp(d);
    await c.check();
    fail = true;
    await expect(c.check()).resolves.toBeUndefined();
    expect(d.runSync).not.toHaveBeenCalled();
  });

  it('runs with the schedule on even when no companion is syncing', async () => {
    const d = deps({ scheduleOn: async () => true, companionSyncing: async () => false });
    await checkOnce(d);
    expect(d.runSync).toHaveBeenCalledTimes(1);
  });

  it('does not go quiet before setup is finished, so a setup minutes later is caught', async () => {
    let state: InvestmentAccounts = 'notSetUp';
    const d = deps({ investmentAccounts: async () => state });
    const c = new HoldingsCatchUp(d);
    await c.check();
    expect(d.runSync).not.toHaveBeenCalled();
    state = 'mapped';
    await c.check();
    expect(d.runSync).toHaveBeenCalledTimes(1);
  });

  it('checks the budget before reading accounts, so a wait costs no account read', async () => {
    const hasInvestmentAccounts = vi.fn(async (): Promise<InvestmentAccounts> => 'mapped');
    await checkOnce(deps({ getRequestLog: async () => log(ago(60_000)), investmentAccounts: hasInvestmentAccounts }));
    expect(hasInvestmentAccounts).not.toHaveBeenCalled();
  });

  it('never rejects when the sync throws, and polls again afterwards', async () => {
    const d = deps({ runSync: async () => { throw new Error('boom'); } });
    const c = await checkOnce(d);
    await expect(c.check()).resolves.toBeUndefined();
    expect(d.runSync).toHaveBeenCalledTimes(2);
  });

  it('does not start a second sync while one is still running', async () => {
    let finish: () => void = () => {};
    const d = deps({ runSync: () => new Promise<void>((r) => { finish = r; }) });
    const c = new HoldingsCatchUp(d);
    const first = c.check();
    await vi.waitFor(() => expect(d.runSync).toHaveBeenCalledTimes(1));
    await c.check();
    expect(d.runSync).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });

  it('checks right away on start, then on every poll, and not after stop', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const getHoldingsPassAt = vi.fn(async () => new Date(NOW));
    const c = new HoldingsCatchUp(deps({ getHoldingsPassAt }));
    c.start();
    expect(c.isRunning()).toBe(true);
    await vi.waitFor(() => expect(getHoldingsPassAt).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_MS);
    expect(getHoldingsPassAt).toHaveBeenCalledTimes(2);
    c.stop();
    expect(c.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(SCHEDULER_POLL_MS * 3);
    expect(getHoldingsPassAt).toHaveBeenCalledTimes(2);
  });
});
