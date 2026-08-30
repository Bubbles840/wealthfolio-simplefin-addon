/**
 * shared/report-cube.ts
 *
 * The report cube: every number the Budget tab renders, in one versioned
 * object the companion publishes as the `report_cube` secret each sync.
 *
 * Why a published cube and not a query channel: the addon's browser sandbox
 * has no category data (the reason the companion exists), and a companion
 * HTTP endpoint for the iframe would add an auth/CORS/network surface for
 * v1's needs. So the companion aggregates once, and every report — the ten
 * standard ones and every user-built custom one — is a PURE FUNCTION of this
 * object, evaluated addon-side. That is also what makes the custom builder
 * instant: adding a term is arithmetic over arrays already in memory.
 *
 * Shape rules:
 *  - Dense, index-aligned arrays. `spend[month][category][account]` and the
 *    per-month arrays all share `months`' indexing; `parseReportCube` REJECTS
 *    any dimension mismatch rather than letting one ragged array misattribute
 *    money to the wrong month.
 *  - Cents everywhere, signed: refunds are negative spend, exactly as the
 *    classifier transcription counts them.
 *  - `null` means unknowable, never zero — netWorth/liquid months without
 *    valuation data must render as gaps, not as a crash to $0.
 *  - Versioned. An addon reading an unknown version treats it as "companion
 *    not ready" and says so in one banner; it never guesses at a shape.
 */
import type { SemesterPoolConfig } from './pool.js';

export const REPORT_CUBE_SECRET_KEY = 'report_cube';
/** Months published by default. */
export const REPORT_CUBE_TARGET_MONTHS = 24;
/** Hard cap, even when a caller asks for more. */
export const REPORT_CUBE_MAX_MONTHS = 36;
/** Serialized-size guard: past this the builder trims oldest months rather
 *  than failing the publish — a shorter history beats no reports. */
export const REPORT_CUBE_MAX_BYTES = 200_000;

export interface CubeAccount {
  sfinId: string;
  name: string;
  /** Wealthfolio account type ('CASH', 'CREDIT_CARD', …) — what decides
   *  which accounts count as liquid. */
  type: string;
}

export interface CubeMerchant { name: string; cents: number; count: number }

export interface CubePool {
  config: SemesterPoolConfig;
  /** Cumulative spend per day over the pool window, for the burn-down chart. */
  daily: Array<{ date: string; spentCents: number }>;
}

export interface ReportCube {
  version: 1;
  asOf: string;
  /** 'YYYY-MM', oldest first. Every per-month array below is index-aligned. */
  months: string[];
  /** Parent-level category names, alphabetical. */
  categories: string[];
  accounts: CubeAccount[];
  /** [month][category][account], signed cents (refunds negative). */
  spend: number[][][];
  /** [month][account] cents — spending with no category, dismissed excluded. */
  uncategorized: number[][];
  /** [month][account] cents — income as Wealthfolio classifies it (deposits
   *  and interest on cash), internal transfers and placeholders excluded. */
  income: number[][];
  /** [month][category] cents, `default` budget rows filled per month. */
  budgets: number[][];
  /** [month] top-20 by cents, descending. */
  merchants: CubeMerchant[][];
  /** [month] cents: fees everywhere plus interest charged on cards. */
  feesInterest: number[];
  /** [month] month-end cents across all accounts; null = unknowable. */
  netWorth: Array<number | null>;
  /** [month] month-end cents across CASH + CREDIT_CARD only. */
  liquid: Array<number | null>;
  pool: CubePool | null;
}

export function parseReportCube(raw: string | null | undefined): ReportCube | null {
  if (!raw) return null;
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || v.version !== 1) return null;
  const len = (x: unknown) => (Array.isArray(x) ? x.length : -1);
  const m = len(v.months);
  const c = len(v.categories);
  const a = len(v.accounts);
  if (m < 0 || c < 0 || a < 0) return null;
  if (
    len(v.spend) !== m || len(v.uncategorized) !== m || len(v.income) !== m
    || len(v.budgets) !== m || len(v.merchants) !== m || len(v.feesInterest) !== m
    || len(v.netWorth) !== m || len(v.liquid) !== m
  ) return null;
  for (const monthSlice of v.spend) {
    if (len(monthSlice) !== c) return null;
    for (const catSlice of monthSlice) if (len(catSlice) !== a) return null;
  }
  for (const perAccount of [...v.uncategorized, ...v.income]) if (len(perAccount) !== a) return null;
  for (const perCategory of v.budgets) if (len(perCategory) !== c) return null;
  return v as ReportCube;
}

/** Indices of the requested accounts — all of them for null/undefined, which
 *  is what "no account filter" means everywhere in the Budget tab. */
function accountIdx(cube: ReportCube, accounts: string[] | null | undefined): number[] {
  if (!accounts) return cube.accounts.map((_, i) => i);
  const wanted = new Set(accounts);
  return cube.accounts.map((acc, i) => (wanted.has(acc.sfinId) ? i : -1)).filter((i) => i >= 0);
}

/** Total spending per month — categorized PLUS uncategorized, because "what
 *  did I spend" must not shrink when a charge merely lacks a category. */
export function monthlySpendTotals(cube: ReportCube, accounts: string[] | null = null): number[] {
  const idx = accountIdx(cube, accounts);
  return cube.months.map((_, mi) => {
    let sum = 0;
    for (const catSlice of cube.spend[mi]) for (const ai of idx) sum += catSlice[ai];
    for (const ai of idx) sum += cube.uncategorized[mi][ai];
    return sum;
  });
}

export function monthlyIncomeTotals(cube: ReportCube, accounts: string[] | null = null): number[] {
  const idx = accountIdx(cube, accounts);
  return cube.months.map((_, mi) => idx.reduce((s, ai) => s + cube.income[mi][ai], 0));
}

export function monthlyUncategorizedTotals(cube: ReportCube, accounts: string[] | null = null): number[] {
  const idx = accountIdx(cube, accounts);
  return cube.months.map((_, mi) => idx.reduce((s, ai) => s + cube.uncategorized[mi][ai], 0));
}

/** One category's monthly series, or null for a category the cube does not
 *  know — the CALLER decides whether that is a warning chip (custom reports)
 *  or simply an absent line. */
export function categorySeries(
  cube: ReportCube,
  category: string,
  accounts: string[] | null = null,
): number[] | null {
  const ci = cube.categories.indexOf(category);
  if (ci === -1) return null;
  const idx = accountIdx(cube, accounts);
  return cube.months.map((_, mi) => idx.reduce((s, ai) => s + cube.spend[mi][ci][ai], 0));
}

/**
 * A cube narrowed to a month window — the Budget tab's shared range control.
 * `'all'` (and any N covering the whole cube) is the identity; `'pool'` keeps
 * the months the pool window touches and deliberately degrades to the whole
 * cube when no pool is set, the same rule the custom evaluator's pool range
 * follows. Slices every month-indexed series together so a sliced cube is
 * still a valid cube (dimension checks and all).
 */
export function sliceCubeMonths(cube: ReportCube, range: number | 'all' | 'pool'): ReportCube {
  let from: number;
  if (range === 'all') {
    from = 0;
  } else if (range === 'pool') {
    if (!cube.pool) return cube;
    const start = cube.pool.config.startDate.slice(0, 7);
    const end = cube.pool.config.endDate.slice(0, 7);
    const first = cube.months.findIndex((m) => m >= start && m <= end);
    if (first === -1) return cube;
    const keep = cube.months.filter((m) => m >= start && m <= end).length;
    from = first;
    const to = first + keep;
    return sliceRows(cube, from, to);
  } else {
    from = Math.max(0, cube.months.length - range);
  }
  if (from === 0) return cube;
  return sliceRows(cube, from, cube.months.length);
}

function sliceRows(cube: ReportCube, from: number, to: number): ReportCube {
  return {
    ...cube,
    months: cube.months.slice(from, to),
    spend: cube.spend.slice(from, to),
    uncategorized: cube.uncategorized.slice(from, to),
    income: cube.income.slice(from, to),
    budgets: cube.budgets.slice(from, to),
    merchants: cube.merchants.slice(from, to),
    feesInterest: cube.feesInterest.slice(from, to),
    netWorth: cube.netWorth.slice(from, to),
    liquid: cube.liquid.slice(from, to),
  };
}
