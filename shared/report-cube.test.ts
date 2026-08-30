import { describe, it, expect } from 'vitest';
import {
  parseReportCube, monthlySpendTotals, monthlyIncomeTotals,
  monthlyUncategorizedTotals, categorySeries, type ReportCube,
} from './report-cube.js';

/** Two months × two categories × two accounts. sfin-1 CASH, sfin-2
 *  CREDIT_CARD. Exported: report-eval.test.ts and the addon's report-data
 *  tests evaluate against this same cube, which is what keeps every layer
 *  agreeing about what these numbers mean. */
export const CUBE: ReportCube = {
  version: 1, asOf: '2026-08-30T12:00:00Z',
  months: ['2026-07', '2026-08'],
  categories: ['Dining', 'Groceries'],
  accounts: [
    { sfinId: 'sfin-1', name: 'Checking', type: 'CASH' },
    { sfinId: 'sfin-2', name: 'Card', type: 'CREDIT_CARD' },
  ],
  spend: [
    [[1000, 2000], [3000, 0]],   // Jul: Dining 10+20, Groceries 30+0 (dollars ×100)
    [[1500, 500], [0, 2500]],    // Aug
  ],
  uncategorized: [[100, 0], [0, 200]],
  income: [[50_000, 0], [0, 0]],
  budgets: [[4000, 3500], [4000, 3500]],
  merchants: [[{ name: 'CHIPOTLE', cents: 1500, count: 2 }], []],
  feesInterest: [0, 250],
  netWorth: [900_000, null],
  liquid: [400_000, 410_000],
  pool: null,
};

describe('selectors', () => {
  it('totals spend across categories and accounts, uncategorized included', () => {
    expect(monthlySpendTotals(CUBE)).toEqual([6100, 4700]);
  });
  it('filters totals to the named accounts', () => {
    expect(monthlySpendTotals(CUBE, ['sfin-2'])).toEqual([2000, 3200]);
  });
  it('reads one category series, account-filtered, null for unknown categories', () => {
    expect(categorySeries(CUBE, 'Dining')).toEqual([3000, 2000]);
    expect(categorySeries(CUBE, 'Dining', ['sfin-1'])).toEqual([1000, 1500]);
    expect(categorySeries(CUBE, 'Nope')).toBeNull();
  });
  it('totals income and uncategorized the same way', () => {
    expect(monthlyIncomeTotals(CUBE)).toEqual([50_000, 0]);
    expect(monthlyUncategorizedTotals(CUBE, ['sfin-2'])).toEqual([0, 200]);
  });
});

describe('parseReportCube', () => {
  it('round-trips a valid cube', () => {
    expect(parseReportCube(JSON.stringify(CUBE))).toEqual(CUBE);
  });
  it('rejects null, garbage, wrong version, and dimension mismatches', () => {
    expect(parseReportCube(null)).toBeNull();
    expect(parseReportCube('nope')).toBeNull();
    expect(parseReportCube(JSON.stringify({ ...CUBE, version: 2 }))).toBeNull();
    // spend outer length must equal months length
    expect(parseReportCube(JSON.stringify({ ...CUBE, spend: [CUBE.spend[0]] }))).toBeNull();
  });
});

// Hoisted beside the tests it serves, matching the suite's mid-file pattern.
import { sliceCubeMonths } from './report-cube.js';

describe('sliceCubeMonths', () => {
  it('keeps the last N months across every month-indexed series', () => {
    const s = sliceCubeMonths(CUBE, 1);
    expect(s.months).toEqual(['2026-08']);
    expect(s.spend).toEqual([CUBE.spend[1]]);
    expect(s.uncategorized).toEqual([CUBE.uncategorized[1]]);
    expect(s.income).toEqual([CUBE.income[1]]);
    expect(s.budgets).toEqual([CUBE.budgets[1]]);
    expect(s.merchants).toEqual([[]]);
    expect(s.feesInterest).toEqual([250]);
    expect(s.netWorth).toEqual([null]);
    expect(s.liquid).toEqual([410_000]);
  });

  it("'all' is the identity, and an oversized N is too", () => {
    expect(sliceCubeMonths(CUBE, 'all')).toEqual(CUBE);
    expect(sliceCubeMonths(CUBE, 24)).toEqual(CUBE);
  });

  it("'pool' keeps the pool's months, and the whole cube without a pool", () => {
    expect(sliceCubeMonths(CUBE, 'pool')).toEqual(CUBE);
    const pooled = {
      ...CUBE,
      pool: {
        config: { amountCents: 1, startDate: '2026-08-01', endDate: '2026-08-31' },
        daily: [],
      },
    };
    expect(sliceCubeMonths(pooled, 'pool').months).toEqual(['2026-08']);
  });
});
