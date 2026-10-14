import { describe, it, expect } from 'vitest';
import { monthlySpendTotals, parseReportCube } from './report-cube.js';
import { sampleReportCube, SAMPLE_CATEGORIES, SAMPLE_MONTHS } from './sample-cube.js';

const EMOJI = /\p{Extended_Pictographic}/u;
const NOW = new Date(2026, 9, 14, 12, 0);

describe('sampleReportCube', () => {
  it('passes parseReportCube, every dimension index-aligned, and round-trips unchanged', () => {
    const cube = sampleReportCube(NOW);
    const raw = JSON.stringify(cube);
    expect(parseReportCube(raw)).toEqual(cube);
    const m = cube.months.length;
    const c = cube.categories.length;
    const a = cube.accounts.length;
    expect([m, c, a]).toEqual([SAMPLE_MONTHS, 8, 3]);
    for (const series of [cube.spend, cube.uncategorized, cube.income, cube.budgets, cube.merchants, cube.feesInterest, cube.netWorth, cube.liquid]) {
      expect(series).toHaveLength(m);
    }
    for (const month of cube.spend) {
      expect(month).toHaveLength(c);
      for (const cat of month) expect(cat).toHaveLength(a);
    }
    for (const perAccount of [...cube.uncategorized, ...cube.income]) expect(perAccount).toHaveLength(a);
    for (const perCategory of cube.budgets) expect(perCategory).toHaveLength(c);
  });

  it('ends on the month it is given, six months back, across a year boundary', () => {
    expect(sampleReportCube(NOW).months).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(sampleReportCube(new Date(2027, 0, 1, 0, 30)).months).toEqual(['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01']);
    expect(sampleReportCube(NOW).asOf).toBe(NOW.toISOString());
  });

  it('is a plausible household: 8 categories, 3 accounts, a few budgets, income, merchants, recurring charges', () => {
    const cube = sampleReportCube(NOW);
    expect(cube.categories).toEqual([...SAMPLE_CATEGORIES]);
    expect([...cube.categories].sort()).toEqual(cube.categories);
    expect(cube.accounts.map((acct) => acct.type)).toEqual(['CASH', 'CASH', 'CREDIT_CARD']);
    const budgeted = cube.categories.filter((_, ci) => cube.budgets[0][ci] > 0);
    expect(budgeted).toEqual(['Dining out', 'Groceries', 'Housing', 'Shopping']);
    expect(cube.income.every((month) => month[0] > 0)).toBe(true);
    for (const month of cube.merchants) {
      expect(month.length).toBeGreaterThan(0);
      expect(month.length).toBeLessThanOrEqual(20);
      expect(month.map((x) => x.cents)).toEqual([...month.map((x) => x.cents)].sort((x, y) => y - x));
    }
    expect(cube.subscriptions?.map((s) => s.kind)).toEqual(['subscription', 'subscription', 'bill']);
    expect(cube.pool).toBeNull();
    // The month in progress has spent about half a month.
    const totals = monthlySpendTotals(cube);
    expect(totals[5]).toBeLessThan(totals[4]);
  });

  it('carries the newest month’s transactions per category, none of which open a story', () => {
    const cube = sampleReportCube(NOW);
    expect(Object.keys(cube.drill ?? {}).sort()).toEqual([...SAMPLE_CATEGORIES].sort());
    for (const rows of Object.values(cube.drill ?? {})) {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.d.startsWith('2026-10-')).toBe(true);
        expect(row.i).toBeUndefined();
      }
    }
  });

  it('counts whole cents everywhere and carries no emoji', () => {
    const cube = sampleReportCube(NOW);
    const numbers = [
      ...cube.spend.flat(2), ...cube.uncategorized.flat(), ...cube.income.flat(), ...cube.budgets.flat(),
      ...cube.merchants.flat().map((x) => x.cents), ...cube.feesInterest,
    ];
    expect(numbers.every((n) => Number.isInteger(n))).toBe(true);
    expect(JSON.stringify(cube)).not.toMatch(EMOJI);
  });

  it('is the same cube for the same moment', () => {
    expect(sampleReportCube(new Date(NOW))).toEqual(sampleReportCube(new Date(NOW)));
  });
});
