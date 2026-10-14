import { describe, it, expect } from 'vitest';
import { monthlySpendTotals, parseReportCube, REPORT_CUBE_MAX_BYTES } from './report-cube.js';
import { sampleReportCube, SAMPLE_CATEGORIES, SAMPLE_MONTHS, SAMPLE_NET_WORTH_DRIFT_CENTS } from './sample-cube.js';

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

describe('sampleReportCube: every view agrees', () => {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it('newest-month merchant totals equal the sum of their drill rows', () => {
    const cube = sampleReportCube(NOW);
    const drillByName = new Map<string, { cents: number; count: number }>();
    for (const rows of Object.values(cube.drill ?? {})) {
      for (const row of rows) {
        const e = drillByName.get(row.n) ?? { cents: 0, count: 0 };
        e.cents += row.c;
        e.count += 1;
        drillByName.set(row.n, e);
      }
    }
    const newest = cube.merchants[SAMPLE_MONTHS - 1];
    expect(newest.length).toBe(drillByName.size);
    for (const m of newest) expect(drillByName.get(m.name)).toEqual({ cents: m.cents, count: m.count });
  });

  it('per-account drill sums equal the spend matrix, per category', () => {
    const cube = sampleReportCube(NOW);
    cube.categories.forEach((cat, ci) => {
      cube.accounts.forEach((acct, ai) => {
        const fromDrill = sum((cube.drill?.[cat] ?? []).filter((r) => r.a === acct.name).map((r) => r.c));
        expect(fromDrill).toBe(cube.spend[SAMPLE_MONTHS - 1][ci][ai]);
      });
    });
  });

  it('each month’s net-worth and liquid step is income minus spend (and fees), plus the drift for net worth', () => {
    const cube = sampleReportCube(NOW);
    const spent = monthlySpendTotals(cube);
    for (let mi = 1; mi < SAMPLE_MONTHS; mi++) {
      const net = sum(cube.income[mi]) - spent[mi] - cube.feesInterest[mi];
      expect((cube.liquid[mi] as number) - (cube.liquid[mi - 1] as number)).toBe(net);
      expect((cube.netWorth[mi] as number) - (cube.netWorth[mi - 1] as number)).toBe(net + SAMPLE_NET_WORTH_DRIFT_CENTS);
    }
  });

  it('keeps money non-negative, net worth at or above liquid, and the size within the cap', () => {
    const cube = sampleReportCube(NOW);
    const nonNegative = [
      ...cube.spend.flat(2), ...cube.uncategorized.flat(), ...cube.income.flat(), ...cube.budgets.flat(),
      ...cube.merchants.flat().map((x) => x.cents), ...cube.feesInterest,
      ...Object.values(cube.drill ?? {}).flat().map((r) => r.c),
    ];
    expect(nonNegative.every((n) => n >= 0)).toBe(true);
    cube.months.forEach((_, mi) => {
      expect(cube.liquid[mi]).toBeGreaterThan(0);
      expect(cube.netWorth[mi]).toBeGreaterThanOrEqual(cube.liquid[mi] as number);
    });
    expect(JSON.stringify(cube).length).toBeLessThan(REPORT_CUBE_MAX_BYTES);
  });

  it('only Shopping runs over its budget; the others fit', () => {
    const cube = sampleReportCube(NOW);
    const over: string[] = [];
    for (let mi = 0; mi < SAMPLE_MONTHS; mi++) {
      cube.categories.forEach((cat, ci) => {
        const budget = cube.budgets[mi][ci];
        if (budget > 0 && cube.spend[mi][ci].reduce((a, b) => a + b, 0) > budget) over.push(cat);
      });
    }
    expect(new Set(over)).toEqual(new Set(['Shopping']));
  });

  it('subscriptions charge a fixed amount on a fixed day, matching the merchants', () => {
    const cube = sampleReportCube(NOW);
    for (const sub of cube.subscriptions ?? []) {
      expect(sub.creep).toBe(false);
      const recent = sub.recent ?? [];
      expect(new Set(recent.map((r) => r.date.slice(8))).size).toBe(1);
      expect(recent.every((r) => r.cents === sub.monthlyCents)).toBe(true);
      expect(sub.lastCents).toBe(sub.monthlyCents);
      expect(sub.lastDate).toBe(recent[0].date);
      for (const month of cube.merchants) {
        const m = month.find((x) => x.name === sub.name);
        if (m) expect(m.cents).toBe(sub.monthlyCents);
      }
    }
  });

  it('dates nothing after now, even on the 1st, and stays right across a year boundary', () => {
    const jan1 = sampleReportCube(new Date(2027, 0, 1, 0, 30));
    expect(Object.values(jan1.drill ?? {}).flat().every((r) => r.d === '2027-01-01')).toBe(true);
    for (const sub of jan1.subscriptions ?? []) {
      expect(sub.lastDate.startsWith('2026-12-')).toBe(true);
      expect(sub.recent?.map((r) => r.date.slice(0, 7))).toEqual(['2026-12', '2026-11', '2026-10']);
    }
    const jan20 = sampleReportCube(new Date(2027, 0, 20, 12, 0));
    expect(jan20.subscriptions?.[0].lastDate).toBe('2027-01-06');
    expect(jan20.subscriptions?.[0].recent?.map((r) => r.date)).toEqual(['2027-01-06', '2026-12-06', '2026-11-06']);
    for (const row of Object.values(jan20.drill ?? {}).flat()) expect(row.d <= '2027-01-20').toBe(true);
    expect(parseReportCube(JSON.stringify(jan1))).toEqual(jan1);
  });

  it('a different now gives a different cube, and uses only generic merchant names', () => {
    expect(sampleReportCube(new Date(2026, 9, 20, 12, 0))).not.toEqual(sampleReportCube(NOW));
    expect(sampleReportCube(new Date(2026, 10, 14, 12, 0))).not.toEqual(sampleReportCube(NOW));
    const names = new Set(sampleReportCube(new Date(2026, 9, 28, 12, 0)).merchants.flat().map((x) => x.name));
    for (const brand of ['TRADER JOES', 'COSTCO WHSL', 'SHELL OIL', 'TARGET', 'CHIPOTLE', 'NETFLIX.COM', 'SPOTIFY USA']) {
      expect(names.has(brand)).toBe(false);
    }
  });
});
