import {
  decideSimplefinRequest,
  parseRequestLog,
  SIMPLEFIN_FUTURE_TOLERANCE_MS,
} from '../../shared/simplefin-budget';
import { SCHEDULER_POLL_MS } from './scheduler';

/**
 * Holdings catch-up: a sync the add-on starts on its own so investment
 * accounts get their daily snapshot.
 *
 * WHY THIS EXISTS. Only the add-on can write holdings snapshots (the
 * companion's host has no snapshot import), and both halves share one
 * `last_sync_at`. The companion runs around the clock, so it nearly always
 * syncs first; an add-on opened later finds a recent sync and does nothing.
 * Snapshots then appeared only on days someone pressed Sync, and Wealthfolio
 * valued holdings accounts from share counts days old.
 *
 * THE RULE. While Wealthfolio is open, every poll checks, cheapest first:
 *  1. no add-on sync has reached the holdings step for HOLDINGS_CATCHUP_AFTER_MS;
 *  2. the SimpleFin budget would let an automatic run download now (the hour
 *     since the newest request and the 16 a day, `decideSimplefinRequest`),
 *     so a wait never starts a sync that is then refused;
 *  3. the add-on's schedule is on, or a companion synced in the last two days.
 *     Someone with no companion who set the schedule to Off chose to sync by
 *     hand; the problem this solves is a companion syncing first;
 *  4. a mapped Wealthfolio account holds investments (SECURITIES,
 *     CRYPTOCURRENCY, or tracking mode HOLDINGS). Set up without one, there is
 *     nothing to catch up, and it stays quiet for HOLDINGS_CATCHUP_QUIET_MS
 *     before asking again, so such an install costs a few reads an hour. Not
 *     set up yet: no quiet, so a setup finished minutes later is caught.
 * Then it runs an ordinary scheduled sync past the one-hour interval
 * (`catchUp`: the usual download window, and the budget still applies inside
 * it).
 *
 * A run that fails before the holdings step leaves the pass time alone; the
 * request it recorded keeps the next try an hour away, so a failing feed is
 * asked at most once an hour, like any scheduled run.
 */

/** How long after the last holdings pass a catch-up is due. Under a day, so a
 *  daily habit of opening Wealthfolio is enough. */
export const HOLDINGS_CATCHUP_AFTER_MS = 20 * 60 * 60 * 1000;

/** How long to stay quiet after finding no investment account mapped. */
export const HOLDINGS_CATCHUP_QUIET_MS = 60 * 60 * 1000;

const INVESTMENT_ACCOUNT_TYPES = new Set(['SECURITIES', 'CRYPTOCURRENCY']);

/** Due when there was never a pass, the last one is old enough, or its stamp is
 *  more than the budget's tolerance in the future (written by a browser with a
 *  clock far ahead, which would otherwise hold the catch-up off until then). */
export function holdingsCatchUpDue(lastPassAt: Date | null, now: Date): boolean {
  if (!lastPassAt || !Number.isFinite(lastPassAt.getTime())) return true;
  const age = now.getTime() - lastPassAt.getTime();
  return age >= HOLDINGS_CATCHUP_AFTER_MS || age < -SIMPLEFIN_FUTURE_TOLERANCE_MS;
}

/** Whether the budget would let an automatic run download now. An unreadable
 *  or corrupt record is no, as it is inside the sync (fail closed). */
export function automaticDownloadAllowed(rawRequestLog: string | null, now: Date): boolean {
  const log = parseRequestLog(rawRequestLog);
  return log !== null && decideSimplefinRequest(log, 'scheduled', now).kind === 'go';
}

/** Whether any mapped account is one Wealthfolio values from holdings. */
export function mapsInvestmentAccount(
  mapping: Record<string, string> | null,
  accounts: ReadonlyArray<{ id: string; accountType?: string | null; trackingMode?: string | null }>,
): boolean {
  const mapped = new Set(Object.values(mapping ?? {}).filter(Boolean));
  return accounts.some((a) => mapped.has(a.id)
    && (INVESTMENT_ACCOUNT_TYPES.has(String(a.accountType ?? '')) || a.trackingMode === 'HOLDINGS'));
}

/** `notSetUp`: no access URL or mapping yet. `none`: set up, no investment
 *  account mapped. `mapped`: at least one. */
export type InvestmentAccounts = 'notSetUp' | 'none' | 'mapped';

export interface HoldingsCatchUpDeps {
  getHoldingsPassAt(): Promise<Date | null>;
  getRequestLog(): Promise<string | null>;
  /** The add-on's own schedule is on (an interval above zero). */
  scheduleOn(): Promise<boolean>;
  /** A companion's last successful sync is under two days old. */
  companionSyncing(): Promise<boolean>;
  investmentAccounts(): Promise<InvestmentAccounts>;
  /** Starts the sync; resolves when it is over. */
  runSync(): Promise<unknown>;
  now?: () => Date;
}

export class HoldingsCatchUp {
  private handle: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  /** Set by stop(): a check already past its first await must not start a sync. */
  private stopped = false;
  /** Epoch ms before which no check runs (no investment account was mapped). */
  private quietUntil = 0;

  constructor(private readonly deps: HoldingsCatchUpDeps) {}

  /** Polls on the scheduler's wall-clock cadence, and once right away. */
  start(): void {
    this.stop();
    this.stopped = false;
    this.handle = setInterval(() => void this.check(), SCHEDULER_POLL_MS);
    void this.check();
  }

  stop(): void {
    if (this.handle) clearInterval(this.handle);
    this.handle = null;
    this.stopped = true;
  }

  isRunning(): boolean {
    return this.handle !== null;
  }

  /** One poll. Exposed for tests; never rejects. */
  async check(): Promise<void> {
    const deps = this.deps;
    if (this.checking) return;
    this.checking = true;
    try {
      const now = deps.now?.() ?? new Date();
      if (now.getTime() < this.quietUntil) return;
      if (!holdingsCatchUpDue(await deps.getHoldingsPassAt(), now)) return;
      if (!automaticDownloadAllowed(await deps.getRequestLog(), now)) return;
      if (!(await deps.scheduleOn()) && !(await deps.companionSyncing())) return;
      const accounts = await deps.investmentAccounts();
      if (accounts === 'none') this.quietUntil = now.getTime() + HOLDINGS_CATCHUP_QUIET_MS;
      if (accounts !== 'mapped') return;
      if (this.stopped) return;
      await deps.runSync();
    } catch {
      // A failed read or sync: the next poll tries again, and the budget
      // bounds how often a sync can download.
    } finally {
      this.checking = false;
    }
  }
}
