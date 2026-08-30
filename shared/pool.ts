/**
 * shared/pool.ts
 *
 * The semester-pool burn-down and the cash-runway figure: pure math, no I/O.
 *
 * Built for lump-sum funding — the user's income arrives as one loan
 * disbursement per semester, which makes "income − spending this month"
 * meaningless as a health signal. The honest lens is a POOL: this amount must
 * last until this date, so the questions are how fast it is burning, what pace
 * it can afford, and when it runs out at the current pace. With a steady
 * paycheck the classic monthly view works fine; nothing here replaces it — the
 * pool is a separate, additive lens (deliberate design decision, 2026-08-30).
 *
 * The companion computes a `PoolStatus` at report time and publishes it as the
 * `pool_status` secret for the addon's Overview tile; the Telegram formatters
 * render the same object. Keeping every consumer on this one function is what
 * keeps the tile and the reports from ever disagreeing.
 *
 * All dates are YYYY-MM-DD handled at UTC midnight, matching how activity
 * dates are stored and compared everywhere else in this codebase. Money is in
 * integer cents, floats appearing only transiently inside a computation.
 */

/** Where the user's pool config lives. Written by BOTH the addon's card and
 *  the companion's /pool command; a divergent key on either side would look
 *  like "the pool I set over there doesn't exist here". */
export const SEMESTER_POOL_SECRET_KEY = 'semester_pool';

export interface SemesterPoolConfig {
  /** Whole pool for the period, in cents. Editing this is also how a
   *  mid-semester top-up is handled — the amount is always the TOTAL. */
  amountCents: number;
  /** First day the pool covers (inclusive). */
  startDate: string;
  /** Last day the pool must survive (inclusive). */
  endDate: string;
}

/**
 * How long a finished pool keeps reporting before going quiet: the wrap-up
 * ("$412 unspent" / "$180 over") stays visible on the tile and gets one
 * mention in reports, then the feature is dormant until the next pool is set.
 */
export const POOL_ENDED_GRACE_DAYS = 7;

export interface PoolStatus {
  /** upcoming: before startDate. active: inside the window. ended: past
   *  endDate but within the grace window — report the outcome. gone: old
   *  news; render nothing. */
  phase: 'upcoming' | 'active' | 'ended' | 'gone';
  /** Copied from the config so a consumer of the published `pool_status`
   *  secret (the Overview tile, every formatter) renders dates without a
   *  second read of `semester_pool` — the two could be from different runs. */
  startDate: string;
  endDate: string;
  spentCents: number;
  /** amount − spent. Deliberately NOT clamped at zero: an overspent pool's
   *  negative remainder is the "$X over" figure the wrap-up prints. */
  remainingCents: number;
  /** Calendar days from startDate through today, inclusive — never 0, so it
   *  can always divide. */
  daysElapsed: number;
  /** Calendar days from today through endDate, exclusive of today; 0 on the
   *  final day. */
  daysLeft: number;
  /** What a week can afford from here: remaining ÷ days left × 7, capped at
   *  the remainder itself (on the last days, what's left IS the allowance)
   *  and floored at 0 for an overspent pool. */
  sustainableWeeklyCents: number;
  /** The observed pace: spent ÷ days elapsed × 7. */
  actualWeeklyCents: number;
  /** Date the pool hits zero at the observed pace, or null when nothing has
   *  been spent yet (no pace to project) or the pool is already out. */
  projectedRunOutDate: string | null;
  /** True when the money runs out before endDate at the observed pace —
   *  including the already-overspent case. */
  runsOutBeforeEnd: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC midnight for a YYYY-MM-DD string. */
function dayEpochMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function toDateString(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function computePoolStatus(
  cfg: SemesterPoolConfig,
  spentCents: number,
  now: Date,
): PoolStatus {
  const todayMs = dayEpochMs(now.toISOString().slice(0, 10));
  const startMs = dayEpochMs(cfg.startDate);
  const endMs = dayEpochMs(cfg.endDate);

  const phase: PoolStatus['phase'] =
    todayMs < startMs ? 'upcoming'
    : todayMs <= endMs ? 'active'
    : todayMs <= endMs + POOL_ENDED_GRACE_DAYS * DAY_MS ? 'ended'
    : 'gone';

  const remainingCents = cfg.amountCents - spentCents;
  const daysElapsed = Math.max(1, Math.round((todayMs - startMs) / DAY_MS) + 1);
  const daysLeft = Math.max(0, Math.round((endMs - todayMs) / DAY_MS));

  const sustainableWeeklyCents = Math.max(
    0,
    Math.min(remainingCents, Math.round((remainingCents / Math.max(1, daysLeft)) * 7)),
  );
  const actualWeeklyCents = Math.round((spentCents / daysElapsed) * 7);

  let projectedRunOutDate: string | null = null;
  if (spentCents > 0 && remainingCents > 0) {
    const dailyBurn = spentCents / daysElapsed;
    projectedRunOutDate = toDateString(
      todayMs + Math.floor(remainingCents / dailyBurn) * DAY_MS,
    );
  }
  const runsOutBeforeEnd =
    remainingCents <= 0 ||
    (projectedRunOutDate !== null && dayEpochMs(projectedRunOutDate) < endMs);

  return {
    phase,
    startDate: cfg.startDate,
    endDate: cfg.endDate,
    spentCents,
    remainingCents,
    daysElapsed,
    daysLeft,
    sustainableWeeklyCents,
    actualWeeklyCents,
    projectedRunOutDate,
    runsOutBeforeEnd,
  };
}

/**
 * Months of spending the liquid position covers: net liquid cash ÷ average
 * monthly spending, to one decimal. Null when there is no spending history to
 * divide by — "∞ months" and "unknown" must not render the same — and clamped
 * at 0 for a negative liquid position (owing more on cards than the cash held
 * is zero runway, not negative time).
 */
export function computeRunwayMonths(
  netLiquidCents: number,
  avgMonthlySpendCents: number,
): number | null {
  if (!(avgMonthlySpendCents > 0)) return null;
  if (netLiquidCents <= 0) return 0;
  return Math.round((netLiquidCents / avgMonthlySpendCents) * 10) / 10;
}

/**
 * The `semester_pool` secret, parsed defensively: this value is typed by hand
 * (settings card or /pool command), survives addon reinstalls, and is read by
 * two independent consumers — so a malformed one must read as "no pool set",
 * never as a crash or a plausible-looking wrong number. An end date before the
 * start can only mislead, so it is refused whole rather than repaired.
 */
export function parsePoolConfig(raw: string | null | undefined): SemesterPoolConfig | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const amountCents = o.amountCents;
  const startDate = o.startDate;
  const endDate = o.endDate;
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0) return null;
  if (typeof startDate !== 'string' || !DATE_RE.test(startDate) || Number.isNaN(dayEpochMs(startDate))) return null;
  if (typeof endDate !== 'string' || !DATE_RE.test(endDate) || Number.isNaN(dayEpochMs(endDate))) return null;
  if (dayEpochMs(endDate) < dayEpochMs(startDate)) return null;
  return { amountCents, startDate, endDate };
}
