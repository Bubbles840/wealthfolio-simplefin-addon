/**
 * companion/src/pool-report.ts
 *
 * Assembles the semester pool's status and the cash-runway figure from the
 * companion's data sources (shared/pool.ts owns the math; this owns the
 * windows and the reads). Dependency-injected all the way down so the unit
 * tests need no module mocks — and so the three consumers (daily digest,
 * weekly check-in, `pool_status` publish) provably share one implementation.
 *
 * "Spending" here is the same figure the reports print: categorized spending
 * via the transcription SQL plus uncategorized spending with dismissed rows
 * excluded, exactly as the daily digest counts its headline. The pool must
 * never disagree with the digest about how much is gone.
 */
import {
  computePoolStatus,
  computeRunwayMonths,
  parsePoolConfig,
  SEMESTER_POOL_SECRET_KEY,
  type PoolStatus,
} from '../../shared/pool.js';

export interface PoolReportDeps {
  /** Addon-secret reader, key only — the caller binds the addon id. */
  getSecret(key: string): Promise<string | null>;
  /** `getNativeWealthfolioSpendingBetween`-shaped: dollars per parent
   *  category over `[startInclusive, endExclusive)`. */
  spendingBetween(startInclusive: string, endExclusive: string): Record<string, number>;
  /** `getNativeUncategorizedSpendingTotal`-shaped: dollars of spending with no
   *  category, the given activity ids excluded. */
  uncategorizedTotal(
    startInclusive: string,
    endExclusive: string,
    dismissedIds: string[],
  ): { count: number; total: number };
  /** Activity ids the user dismissed — excluded from the burn, like the digest. */
  dismissedIds(): Promise<string[]>;
  /** Wealthfolio account type per SIMPLEFIN account id, for the mapped accounts. */
  accountTypes(): Promise<Record<string, string>>;
  /** The `account_balances` snapshot, keyed by SimpleFin account id. */
  accountBalances(): Promise<Record<string, { balance: number | null }>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function dateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  return dateString(new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS));
}

function spentCentsBetween(
  deps: PoolReportDeps,
  startInclusive: string,
  endExclusive: string,
  dismissedIds: string[],
): number {
  const categorized = Object.values(deps.spendingBetween(startInclusive, endExclusive))
    .reduce((sum, v) => sum + v, 0);
  const uncategorized = deps.uncategorizedTotal(startInclusive, endExclusive, dismissedIds).total;
  return Math.round((categorized + uncategorized) * 100);
}

/**
 * The configured pool's live status, or null when no (valid) pool is set —
 * which every renderer treats as "this feature does not exist".
 *
 * The spend window is `[startDate, tomorrow)` while the pool runs, and stops
 * at `[startDate, endDate + 1)` once it is over: an ended pool's wrap-up
 * states how the SEMESTER finished, and next January's groceries must not
 * creep into it during the grace week.
 */
export async function readPoolStatus(deps: PoolReportDeps, now: Date): Promise<PoolStatus | null> {
  const cfg = parsePoolConfig(await deps.getSecret(SEMESTER_POOL_SECRET_KEY));
  if (!cfg) return null;
  const tomorrow = addDays(dateString(now), 1);
  const dayAfterEnd = addDays(cfg.endDate, 1);
  // Lexicographic min is date min for YYYY-MM-DD.
  const endExclusive = tomorrow < dayAfterEnd ? tomorrow : dayAfterEnd;
  const spentCents = spentCentsBetween(deps, cfg.startDate, endExclusive, await deps.dismissedIds());
  return computePoolStatus(cfg, spentCents, now);
}

/**
 * Months of cash runway: liquid position ÷ trailing-90-day average monthly
 * spending. Liquid = CASH balances net of CREDIT_CARD balances (a card's
 * SimpleFin balance is already negative when money is owed); investment-style
 * accounts are wealth, not runway, and are excluded.
 *
 * Null — rendered as nothing — whenever any input is unknowable: no readable
 * cash/card balance at all, no spending history, or a failed read. A guessed
 * runway is worse than none; this figure exists to gate "is money ready to
 * invest", where overstating is the expensive direction.
 */
export async function readRunwayMonths(deps: PoolReportDeps, now: Date): Promise<number | null> {
  try {
    const types = await deps.accountTypes();
    const balances = await deps.accountBalances();
    let liquidDollars: number | null = null;
    for (const [sfinId, info] of Object.entries(balances)) {
      const type = (types[sfinId] ?? '').toUpperCase();
      if (type !== 'CASH' && type !== 'CREDIT_CARD') continue;
      if (typeof info?.balance !== 'number') continue;
      liquidDollars = (liquidDollars ?? 0) + info.balance;
    }
    if (liquidDollars === null) return null;
    const today = dateString(now);
    const spentCents = spentCentsBetween(deps, addDays(today, -90), addDays(today, 1), await deps.dismissedIds());
    return computeRunwayMonths(Math.round(liquidDollars * 100), Math.round(spentCents / 3));
  } catch {
    return null;
  }
}
