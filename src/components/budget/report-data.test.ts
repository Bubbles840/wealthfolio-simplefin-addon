import { describe, it, expect } from 'vitest';
import {
  cashFlowData, categoryTrendData, netWorthData, savingsRateData, merchantTable,
  budgetVsActualData, seasonalityGrid, feesInterestData, runwayTrendData, poolBurndownData,
} from './report-data';
import { CUBE } from '../../../shared/report-cube.test';
import type { ReportCube } from '../../../shared/report-cube';

describe('report-data prep', () => {
  it('cashFlowData: income vs spending vs net, dollars', () => {
    expect(cashFlowData(CUBE)).toEqual([
      { month: '2026-07', income: 500, spending: 61, net: 439 },
      { month: '2026-08', income: 0, spending: 47, net: -47 },
    ]);
  });

  it('categoryTrendData: one key per requested category', () => {
    expect(categoryTrendData(CUBE, ['Dining'])).toEqual([
      { month: '2026-07', Dining: 30 },
      { month: '2026-08', Dining: 20 },
    ]);
  });

  it('netWorthData: dollars with null gaps preserved', () => {
    expect(netWorthData(CUBE)).toEqual([
      { month: '2026-07', netWorth: 9000 },
      { month: '2026-08', netWorth: null },
    ]);
  });

  it('savingsRateData: rate 0..1, null when the month had no income', () => {
    expect(savingsRateData(CUBE)).toEqual([
      { month: '2026-07', rate: 87.8 },
      { month: '2026-08', rate: null },
    ]);
  });

  it('merchantTable aggregates the last N months; trend null without history', () => {
    expect(merchantTable(CUBE, 2)).toEqual([
      { name: 'CHIPOTLE', total: 15, count: 2, trend: null },
    ]);
  });

  it('budgetVsActualData: one month, sorted by worst overshoot first', () => {
    expect(budgetVsActualData(CUBE, '2026-08')).toEqual([
      { category: 'Groceries', budget: 35, actual: 25 },
      { category: 'Dining', budget: 40, actual: 20 },
    ]);
  });

  it('seasonalityGrid: category rows by month columns, cents', () => {
    expect(seasonalityGrid(CUBE)).toEqual({
      categories: ['Dining', 'Groceries'],
      months: ['2026-07', '2026-08'],
      cells: [[3000, 2000], [3000, 2500]],
    });
  });

  it('feesInterestData: dollars per month', () => {
    expect(feesInterestData(CUBE)).toEqual([
      { month: '2026-07', fees: 0 },
      { month: '2026-08', fees: 2.5 },
    ]);
  });

  it('runwayTrendData: liquid over trailing average spend, one decimal', () => {
    expect(runwayTrendData(CUBE)).toEqual([
      { month: '2026-07', months: 65.6 },  // 4000 / 61
      { month: '2026-08', months: 75.9 },  // 4100 / mean(61, 47)
    ]);
  });

  it('poolBurndownData: ideal glide vs actual remaining, null past known burn', () => {
    const pooled: ReportCube = {
      ...CUBE,
      pool: {
        config: { amountCents: 160_000, startDate: '2026-08-25', endDate: '2026-08-29' },
        daily: [
          { date: '2026-08-26', spentCents: 1000 },
          { date: '2026-08-27', spentCents: 1500 },
        ],
      },
    };
    expect(poolBurndownData(pooled)).toEqual([
      { date: '2026-08-25', ideal: 1600, actual: 1600 },
      { date: '2026-08-26', ideal: 1200, actual: 1590 },
      { date: '2026-08-27', ideal: 800, actual: 1585 },
      { date: '2026-08-28', ideal: 400, actual: null },
      { date: '2026-08-29', ideal: 0, actual: null },
    ]);
    expect(poolBurndownData(CUBE)).toEqual([]); // no pool, no rows
  });
});

describe('the second wave of reports', () => {
  it('categoryDonutData: last month by category, largest first', () => {
    expect(categoryDonutData(CUBE)).toEqual([
      { name: 'Groceries', value: 25 },
      { name: 'Dining', value: 20 },
    ]);
  });

  it('momDeltaData: this month vs last per category, increases first', () => {
    expect(momDeltaData(CUBE)).toEqual([
      { category: 'Groceries', delta: -5 },
      { category: 'Dining', delta: -10 },
    ]);
  });

  it('spendCalendarData: per-day spend from the pool cumulative series', () => {
    const pooled = {
      ...CUBE,
      pool: {
        config: { amountCents: 160_000, startDate: '2026-08-25', endDate: '2026-08-29' },
        daily: [
          { date: '2026-08-26', spentCents: 1000 },
          { date: '2026-08-27', spentCents: 1500 },
        ],
      },
    };
    expect(spendCalendarData(pooled)).toEqual([
      { date: '2026-08-26', cents: 1000 },
      { date: '2026-08-27', cents: 500 },
    ]);
    expect(spendCalendarData(CUBE)).toEqual([]);
  });

  it('poolPaceData: both paces and a verdict color', () => {
    const pooled = {
      ...CUBE,
      asOf: '2026-08-27T12:00:00Z',
      pool: {
        config: { amountCents: 160_000, startDate: '2026-08-25', endDate: '2026-08-29' },
        daily: [{ date: '2026-08-27', spentCents: 1500 }],
      },
    };
    expect(poolPaceData(pooled)).toEqual({
      sustainableWeekly: 1585,
      actualWeekly: 35,
      status: 'green',
    });
    expect(poolPaceData(CUBE)).toBeNull();
  });

  it('cumulativeFlowData: running income against running spending', () => {
    expect(cumulativeFlowData(CUBE)).toEqual([
      { month: '2026-07', income: 500, spending: 61 },
      { month: '2026-08', income: 500, spending: 108 },
    ]);
  });

  it('uncatTrendData: uncategorized spending per month', () => {
    expect(uncatTrendData(CUBE)).toEqual([
      { month: '2026-07', uncategorized: 1 },
      { month: '2026-08', uncategorized: 2 },
    ]);
  });
});

import {
  categoryDonutData, momDeltaData, spendCalendarData, poolPaceData,
  cumulativeFlowData, uncatTrendData,
} from './report-data';
