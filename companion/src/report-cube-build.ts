/**
 * companion/src/report-cube-build.ts
 *
 * Assembles the report cube (shared/report-cube.ts) from the native readers.
 * Dependency-injected end to end like pool-report.ts: the unit tests fake the
 * readers, and index.ts binds the real ones in ONE place, so the daily
 * publish and any future consumer provably aggregate the same way.
 *
 * Assembly rules worth stating:
 *  - The account dimension is the MAPPED accounts (sfin id order from
 *    `accountMeta`); a spend row against a Wealthfolio account nothing maps
 *    to is dropped, not mis-binned.
 *  - Categories are whatever spending or budgets actually mention, sorted —
 *    the cube never invents empty categories.
 *  - Merchant names come from `descriptionFromComment`, the same normalizer
 *    every report uses on stored notes; rows with no description left are not
 *    merchants and are skipped.
 *  - Net worth sums EVERY valuation row (an unmapped account's money is still
 *    the user's money); liquid sums only mapped CASH and CREDIT_CARD rows.
 *  - A month with no valuation rows is null — unknowable, never zero.
 *  - The size guard trims the OLDEST months until the serialized cube fits
 *    REPORT_CUBE_MAX_BYTES: shorter history beats a failed publish.
 */
import { descriptionFromComment } from '../../shared/sync-core.js';
import {
  REPORT_CUBE_MAX_BYTES, REPORT_CUBE_MAX_MONTHS, REPORT_CUBE_TARGET_MONTHS,
  type CubeMerchant, type ReportCube,
} from '../../shared/report-cube.js';
import type { SemesterPoolConfig } from '../../shared/pool.js';
import type {
  getNativeSpendMatrix, getNativeIncomeByMonthAccount, getNativeUncategorizedByMonthAccount,
  getNativeMerchantRows, getNativeFeesInterestByMonth, getNativeSpendDailyTotals,
  getNativeValuationByMonth,
} from './sqlite-native.js';

export interface CubeBuildDeps {
  accountMeta(): Promise<Array<{ sfinId: string; wfId: string; name: string; type: string }>>;
  dismissedIds(): Promise<string[]>;
  poolConfig(): Promise<SemesterPoolConfig | null>;
  spendMatrix(start: string, endEx: string): ReturnType<typeof getNativeSpendMatrix>;
  incomeByMonthAccount(start: string, endEx: string): ReturnType<typeof getNativeIncomeByMonthAccount>;
  uncategorizedByMonthAccount(start: string, endEx: string, excluded: string[]): ReturnType<typeof getNativeUncategorizedByMonthAccount>;
  budgetsForMonth(yearMonth: string): Record<string, number>;
  merchantRows(start: string, endEx: string): ReturnType<typeof getNativeMerchantRows>;
  feesInterestByMonth(start: string, endEx: string): ReturnType<typeof getNativeFeesInterestByMonth>;
  spendDaily(start: string, endEx: string, excluded: string[]): ReturnType<typeof getNativeSpendDailyTotals>;
  valuationByMonth(months: string[]): ReturnType<typeof getNativeValuationByMonth>;
}

const MERCHANTS_PER_MONTH = 20;
const MIN_MONTHS_AFTER_TRIM = 6;

const cents = (dollars: number) => Math.round(dollars * 100);

function monthString(year: number, monthIndex0: number): string {
  const d = new Date(Date.UTC(year, monthIndex0, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthsEndingAt(now: Date, count: number): string[] {
  const out: string[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    out.push(monthString(now.getUTCFullYear(), now.getUTCMonth() - back));
  }
  return out;
}

/** First day of the month AFTER a YYYY-MM. */
function nextMonthFirst(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  return `${monthString(y, m)}-01`;
}

export async function buildReportCube(
  deps: CubeBuildDeps,
  now: Date,
  monthsWanted: number = REPORT_CUBE_TARGET_MONTHS,
): Promise<ReportCube> {
  const months = monthsEndingAt(now, Math.min(Math.max(1, monthsWanted), REPORT_CUBE_MAX_MONTHS));
  const start = `${months[0]}-01`;
  const endEx = nextMonthFirst(months[months.length - 1]);

  const meta = await deps.accountMeta();
  const dismissed = await deps.dismissedIds();
  const poolCfg = await deps.poolConfig();

  const spendRows = deps.spendMatrix(start, endEx);
  const incomeRows = deps.incomeByMonthAccount(start, endEx);
  const uncatRows = deps.uncategorizedByMonthAccount(start, endEx, dismissed);
  const merchantRows = deps.merchantRows(start, endEx);
  const feeRows = deps.feesInterestByMonth(start, endEx);
  const budgetsByMonth = months.map((m) => deps.budgetsForMonth(m));
  const valuationRows = deps.valuationByMonth(months);

  const categorySet = new Set<string>();
  for (const r of spendRows) categorySet.add(r.category);
  for (const b of budgetsByMonth) for (const name of Object.keys(b)) categorySet.add(name);
  const categories = Array.from(categorySet).sort();

  const monthIdx = new Map(months.map((m, i) => [m, i]));
  const catIdx = new Map(categories.map((c, i) => [c, i]));
  const acctIdxByWfId = new Map(meta.map((a, i) => [a.wfId, i]));

  const spend = months.map(() => categories.map(() => meta.map(() => 0)));
  for (const r of spendRows) {
    const mi = monthIdx.get(r.month);
    const ci = catIdx.get(r.category);
    const ai = acctIdxByWfId.get(r.accountId);
    if (mi === undefined || ci === undefined || ai === undefined) continue;
    spend[mi][ci][ai] += cents(r.amount);
  }

  const perAccount = (rows: Array<{ month: string; accountId: string; amount: number }>) => {
    const grid = months.map(() => meta.map(() => 0));
    for (const r of rows) {
      const mi = monthIdx.get(r.month);
      const ai = acctIdxByWfId.get(r.accountId);
      if (mi === undefined || ai === undefined) continue;
      grid[mi][ai] += cents(r.amount);
    }
    return grid;
  };
  const income = perAccount(incomeRows);
  const uncategorized = perAccount(uncatRows);

  const budgets = months.map((_, mi) => categories.map((c) => cents(budgetsByMonth[mi][c] ?? 0)));

  const merchants: CubeMerchant[][] = months.map(() => []);
  {
    const perMonth = new Map<number, Map<string, CubeMerchant>>();
    for (const r of merchantRows) {
      const mi = monthIdx.get(r.month);
      if (mi === undefined) continue;
      const name = descriptionFromComment(r.notes);
      if (!name) continue;
      const bucket = perMonth.get(mi) ?? new Map<string, CubeMerchant>();
      const entry = bucket.get(name) ?? { name, cents: 0, count: 0 };
      entry.cents += cents(r.amount);
      entry.count += 1;
      bucket.set(name, entry);
      perMonth.set(mi, bucket);
    }
    for (const [mi, bucket] of perMonth) {
      merchants[mi] = Array.from(bucket.values())
        .sort((a, b) => b.cents - a.cents)
        .slice(0, MERCHANTS_PER_MONTH);
    }
  }

  const feesInterest = months.map(() => 0);
  for (const r of feeRows) {
    const mi = monthIdx.get(r.month);
    if (mi !== undefined) feesInterest[mi] += cents(r.amount);
  }

  const liquidTypes = new Set(['CASH', 'CREDIT_CARD']);
  const netWorth: Array<number | null> = months.map(() => null);
  const liquid: Array<number | null> = months.map(() => null);
  for (const r of valuationRows) {
    const mi = monthIdx.get(r.month);
    if (mi === undefined) continue;
    netWorth[mi] = (netWorth[mi] ?? 0) + cents(r.amount);
    const acct = acctIdxByWfId.has(r.accountId) ? meta[acctIdxByWfId.get(r.accountId)!] : null;
    if (acct && liquidTypes.has(acct.type.toUpperCase())) {
      liquid[mi] = (liquid[mi] ?? 0) + cents(r.amount);
    }
  }

  let pool: ReportCube['pool'] = null;
  if (poolCfg) {
    const dayAfterEnd = new Date(Date.parse(`${poolCfg.endDate}T00:00:00Z`) + 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const poolEndEx = tomorrow < dayAfterEnd ? tomorrow : dayAfterEnd;
    const dailyRows = [...deps.spendDaily(poolCfg.startDate, poolEndEx, dismissed)]
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    let running = 0;
    pool = {
      config: poolCfg,
      daily: dailyRows.map((r) => {
        running += cents(r.amount);
        return { date: r.date, spentCents: running };
      }),
    };
  }

  let cube: ReportCube = {
    version: 1, asOf: now.toISOString(),
    months, categories,
    accounts: meta.map(({ sfinId, name, type }) => ({ sfinId, name, type })),
    spend, uncategorized, income, budgets, merchants, feesInterest, netWorth, liquid, pool,
  };

  while (JSON.stringify(cube).length > REPORT_CUBE_MAX_BYTES && cube.months.length > MIN_MONTHS_AFTER_TRIM) {
    cube = {
      ...cube,
      months: cube.months.slice(1),
      spend: cube.spend.slice(1),
      uncategorized: cube.uncategorized.slice(1),
      income: cube.income.slice(1),
      budgets: cube.budgets.slice(1),
      merchants: cube.merchants.slice(1),
      feesInterest: cube.feesInterest.slice(1),
      netWorth: cube.netWorth.slice(1),
      liquid: cube.liquid.slice(1),
    };
  }
  return cube;
}
