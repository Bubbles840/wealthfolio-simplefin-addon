import { describe, it, expect, vi } from 'vitest';
import { buildReportCube, type CubeBuildDeps } from './report-cube-build.js';
import { parseReportCube, REPORT_CUBE_MAX_BYTES } from '../../shared/report-cube.js';

/** All-fake deps, like pool-report.test.ts: this module is DI end to end. */
const deps = (over: Partial<CubeBuildDeps> = {}): CubeBuildDeps => ({
  accountMeta: vi.fn(async () => [
    { sfinId: 'sfin-1', wfId: 'acct-cash', name: 'Checking', type: 'CASH' },
    { sfinId: 'sfin-2', wfId: 'acct-card', name: 'Card', type: 'CREDIT_CARD' },
    { sfinId: 'sfin-3', wfId: 'acct-inv', name: 'Brokerage', type: 'SECURITIES' },
  ]),
  dismissedIds: vi.fn(async () => ['dis-1']),
  poolConfig: vi.fn(async () => null),
  spendMatrix: vi.fn(() => [
    { month: '2026-07', category: 'Dining', accountId: 'acct-cash', amount: 25.5 },
    { month: '2026-08', category: 'Groceries', accountId: 'acct-card', amount: 40 },
    // A wf account nothing is mapped to must be ignored, not crash the fill.
    { month: '2026-08', category: 'Dining', accountId: 'acct-unmapped', amount: 99 },
  ]),
  incomeByMonthAccount: vi.fn(() => [{ month: '2026-07', accountId: 'acct-cash', amount: 500 }]),
  uncategorizedByMonthAccount: vi.fn(() => [{ month: '2026-08', accountId: 'acct-card', amount: 12 }]),
  budgetsForMonth: vi.fn(() => ({ Dining: 40 })),
  merchantRows: vi.fn(() => [
    { month: '2026-08', notes: 'CHIPOTLE 1234 · TRN-1', amount: 20 },
    { month: '2026-08', notes: 'CHIPOTLE 1234 · TRN-2', amount: 10 },
    { month: '2026-08', notes: '', amount: 5 }, // no description: not a merchant
  ]),
  feesInterestByMonth: vi.fn(() => [{ month: '2026-08', amount: 7.5 }]),
  spendDaily: vi.fn(() => [
    { date: '2026-08-26', amount: 10 },
    { date: '2026-08-27', amount: 5 },
  ]),
  valuationByMonth: vi.fn(() => [
    { month: '2026-07', accountId: 'acct-cash', amount: 3000 },
    { month: '2026-07', accountId: 'acct-card', amount: -500 },
    { month: '2026-07', accountId: 'acct-inv', amount: 10_000 },
  ]),
  ...over,
});

const NOW = new Date('2026-08-30T12:00:00Z');

describe('buildReportCube', () => {
  it('builds the requested month window and asks every reader for exactly that span', async () => {
    const d = deps();
    const cube = await buildReportCube(d, NOW, 2);
    expect(cube.months).toEqual(['2026-07', '2026-08']);
    expect(cube.asOf).toBe(NOW.toISOString());
    expect(d.spendMatrix).toHaveBeenCalledWith('2026-07-01', '2026-09-01');
    expect(d.uncategorizedByMonthAccount).toHaveBeenCalledWith('2026-07-01', '2026-09-01', ['dis-1']);
    expect(d.budgetsForMonth).toHaveBeenCalledWith('2026-07');
    expect(d.budgetsForMonth).toHaveBeenCalledWith('2026-08');
  });

  it('lands every series in cents at the right cell, unmapped accounts ignored', async () => {
    const cube = await buildReportCube(deps(), NOW, 2);
    expect(cube.categories).toEqual(['Dining', 'Groceries']);
    expect(cube.accounts.map((a) => a.sfinId)).toEqual(['sfin-1', 'sfin-2', 'sfin-3']);
    const [jul, aug] = [0, 1];
    const [din, gro] = [0, 1];
    const [cash, card] = [0, 1];
    expect(cube.spend[jul][din][cash]).toBe(2550);
    expect(cube.spend[aug][gro][card]).toBe(4000);
    expect(cube.spend[aug][din].every((v) => v === 0)).toBe(true); // unmapped row dropped
    expect(cube.income[jul][cash]).toBe(50_000);
    expect(cube.uncategorized[aug][card]).toBe(1200);
    expect(cube.budgets[jul][din]).toBe(4000);
    expect(cube.budgets[jul][gro]).toBe(0);
    expect(cube.feesInterest).toEqual([0, 750]);
  });

  it('normalizes and aggregates merchants, top list per month', async () => {
    const cube = await buildReportCube(deps(), NOW, 2);
    expect(cube.merchants[1]).toEqual([{ name: 'CHIPOTLE 1234', cents: 3000, count: 2 }]);
    expect(cube.merchants[0]).toEqual([]);
  });

  it('sums net worth across all accounts and liquid across cash and cards only', async () => {
    const cube = await buildReportCube(deps(), NOW, 2);
    expect(cube.netWorth).toEqual([1_250_000, null]); // 3000 − 500 + 10,000 dollars
    expect(cube.liquid).toEqual([250_000, null]);     // brokerage excluded
  });

  it('carries the pool config with cumulative daily burn', async () => {
    const cube = await buildReportCube(deps({
      poolConfig: vi.fn(async () => ({ amountCents: 160_000, startDate: '2026-08-25', endDate: '2026-12-12' })),
    }), NOW, 2);
    expect(cube.pool?.config.amountCents).toBe(160_000);
    expect(cube.pool?.daily).toEqual([
      { date: '2026-08-26', spentCents: 1000 },
      { date: '2026-08-27', spentCents: 1500 }, // cumulative
    ]);
  });

  it('trims oldest months rather than exceeding the size cap', async () => {
    const bloated = deps({
      merchantRows: vi.fn(() => {
        const rows: Array<{ month: string; notes: string; amount: number }> = [];
        for (let m = 0; m < 36; m += 1) {
          const month = `20${23 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, '0')}`;
          for (let i = 0; i < 20; i += 1) {
            rows.push({ month, notes: `${'M'.repeat(400)}-${m}-${i} · TRN-${m}-${i}`, amount: 10 + i });
          }
        }
        return rows;
      }),
    });
    const cube = await buildReportCube(bloated, NOW, 36);
    expect(cube.months.length).toBeLessThan(36);
    expect(JSON.stringify(cube).length).toBeLessThanOrEqual(REPORT_CUBE_MAX_BYTES);
  });

  it('round-trips through parseReportCube', async () => {
    const cube = await buildReportCube(deps(), NOW, 2);
    expect(parseReportCube(JSON.stringify(cube))).toEqual(cube);
  });
});
