import { describe, it, expect, vi } from 'vitest';
import { buildReportCube, type CubeBuildDeps } from './report-cube-build.js';
import { parseReportCube, REPORT_CUBE_MAX_BYTES } from '../../shared/report-cube.js';
import { emptySubscriptionPrefs } from '../../shared/subscription-prefs.js';
import { decodeFiler } from '../../shared/tx-story.js';
import { categoryFiledChange, stampChange } from '../../shared/change-entries.js';

/** All-fake deps, like pool-report.test.ts: this module is DI end to end. */
const deps = (over: Partial<CubeBuildDeps> = {}): CubeBuildDeps => ({
  accountMeta: vi.fn(async () => [
    { sfinId: 'sfin-1', wfId: 'acct-cash', name: 'Checking', type: 'CASH' },
    { sfinId: 'sfin-2', wfId: 'acct-card', name: 'Card', type: 'CREDIT_CARD' },
    { sfinId: 'sfin-3', wfId: 'acct-inv', name: 'Brokerage', type: 'SECURITIES' },
  ]),
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
  it('publishes each category\'s newest-month transactions for drill-down, capped and normalized', async () => {
    const cube = await buildReportCube(deps({
      drillRows: vi.fn(() => [
        { category: 'Dining', date: '2026-08-20', notes: 'CHIPOTLE 1234 \u00b7 TRN-9', amount: 12.5, account: 'Card' },
        { category: 'Dining', date: '2026-08-02', notes: 'SWEETGREEN \u00b7 TRN-8', amount: 9, account: 'Checking' },
        { category: 'Groceries', date: '2026-08-11', notes: 'TRADER JOES \u00b7 TRN-7', amount: 40, account: 'Card' },
      ]),
    }), NOW, 2);
    expect(cube.drill).toEqual({
      Dining: [
        { d: '2026-08-20', n: 'CHIPOTLE 1234', c: 1250, a: 'Card' },
        { d: '2026-08-02', n: 'SWEETGREEN', c: 900, a: 'Checking' },
      ],
      Groceries: [{ d: '2026-08-11', n: 'TRADER JOES', c: 4000, a: 'Card' }],
    });
  });

  it('caps drill rows per category so one busy month cannot blow the size guard', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      category: 'Dining', date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, notes: `ROW ${i}`, amount: 1, account: 'Card',
    }));
    const cube = await buildReportCube(deps({ drillRows: vi.fn(() => many) }), NOW, 2);
    expect(cube.drill!.Dining.length).toBeLessThanOrEqual(30);
  });

  it('carries each drill row’s activity id and a short code for who filed it (1.61)', async () => {
    const youFiled = stampChange(categoryFiledChange({
      actor: 'you', activityId: 'act-you', description: 'SWEETGREEN', before: null,
      after: { categoryId: 'cat-din', categoryName: 'Dining' },
    }), 'companion', new Date('2026-08-21T12:00:00Z'));
    const row = (activityId: string, notes: string, source: string, categoryId = 'cat-din') => ({
      category: 'Dining', date: '2026-08-20', notes, amount: 12.5, account: 'Card',
      activityId, accountId: 'acct-card', categoryId, source, activityType: 'WITHDRAWAL',
    });
    const cube = await buildReportCube(deps({
      drillRows: vi.fn(() => [
        row('act-rule', 'CHIPOTLE 1234 · TRN-1', 'rule'),
        row('act-you', 'SWEETGREEN · TRN-2', 'manual'),
        row('act-amz', 'AMAZON MKTPL · Amazon: Kitchen · TRN-3', 'manual'),
        row('act-hand', 'DINER · TRN-4', 'manual'),
        row('act-gone', 'TACO PLACE · TRN-5', 'rule'),
      ]),
      filingContext: vi.fn(async () => ({
        rules: [{ id: 'r1', pattern: 'CHIPOTLE', categoryId: 'cat-din', priority: 0 }],
        history: [youFiled],
      })),
    }), NOW, 2);
    expect(cube.drill!.Dining.map((r) => [r.i, r.f])).toEqual([
      ['act-rule', 'r:CHIPOTLE'],
      ['act-you', 'y'],
      ['act-amz', 'a:Kitchen'],
      ['act-hand', 'h'],
      ['act-gone', 'r'],
    ]);
  });

  it('round-trips a rule pattern and an Amazon label that contain colons, and caps long ones at 60 characters', async () => {
    const row = (activityId: string, notes: string, source: string) => ({
      category: 'Dining', date: '2026-08-20', notes, amount: 12.5, account: 'Card',
      activityId, accountId: 'acct-card', categoryId: 'cat-din', source, activityType: 'WITHDRAWAL',
    });
    const long = 'X'.repeat(80);
    const cube = await buildReportCube(deps({
      drillRows: vi.fn(() => [
        row('a1', 'A:B STORE · TRN-1', 'rule'),
        row('a2', 'AMAZON MKTPL · Amazon: X: Y · TRN-2', 'manual'),
        row('a3', `${long} · TRN-3`, 'rule'),
      ]),
      filingContext: vi.fn(async () => ({
        rules: [{ id: 'r1', pattern: 'A:B', categoryId: 'cat-din' }, { id: 'r2', pattern: long, categoryId: 'cat-din' }],
        history: [],
      })),
    }), NOW, 2);
    const f = cube.drill!.Dining.map((r) => r.f);
    expect(f[0]).toBe('r:A:B');
    expect(f[1]).toBe('a:X: Y');
    expect(f[2]).toBe(`r:${'X'.repeat(60)}…`);
    expect(decodeFiler(f[0])).toEqual({ kind: 'rule', pattern: 'A:B' });
    expect(decodeFiler(f[1])).toEqual({ kind: 'amazon', label: 'X: Y' });
  });

  it('an unreadable change log (history null) never says "by hand": no code, or the Amazon label from the note', async () => {
    const row = (activityId: string, notes: string) => ({
      category: 'Dining', date: '2026-08-20', notes, amount: 12.5, account: 'Card',
      activityId, accountId: 'acct-card', categoryId: 'cat-din', source: 'manual', activityType: 'WITHDRAWAL',
    });
    const cube = await buildReportCube(deps({
      drillRows: vi.fn(() => [row('m1', 'DINER · TRN-1'), row('m2', 'AMAZON MKTPL · Amazon: Kitchen · TRN-2')]),
      filingContext: vi.fn(async () => ({ rules: [], history: null })),
    }), NOW, 2);
    expect(cube.drill!.Dining.map((r) => [r.i, r.f])).toEqual([['m1', undefined], ['m2', 'a:Kitchen']]);
  });

  it('survives a filingContext that throws synchronously', async () => {
    const cube = await buildReportCube(deps({
      drillRows: vi.fn(() => [{
        category: 'Dining', date: '2026-08-20', notes: 'CHIPOTLE · TRN-1', amount: 12.5, account: 'Card',
        activityId: 'act-1', accountId: 'acct-card', categoryId: 'cat-din', source: 'rule', activityType: 'WITHDRAWAL',
      }]),
      filingContext: vi.fn(() => { throw new Error('sync boom'); }),
    }), NOW, 2);
    expect(cube.drill!.Dining[0]).toEqual({ d: '2026-08-20', n: 'CHIPOTLE', c: 1250, a: 'Card', i: 'act-1' });
  });

  it('says only "a rule" when the rules cannot be read, and builds the cube when nothing can', async () => {
    const drillRows = vi.fn(() => [{
      category: 'Dining', date: '2026-08-20', notes: 'CHIPOTLE · TRN-1', amount: 12.5, account: 'Card',
      activityId: 'act-1', accountId: 'acct-card', categoryId: 'cat-din', source: 'rule', activityType: 'WITHDRAWAL',
    }]);
    const unreadable = await buildReportCube(deps({ drillRows, filingContext: vi.fn(async () => ({ rules: null, history: null })) }), NOW, 2);
    expect(unreadable.drill!.Dining[0]).toMatchObject({ i: 'act-1', f: 'r?' });
    const failing = await buildReportCube(deps({ drillRows, filingContext: vi.fn(async () => { throw new Error('down'); }) }), NOW, 2);
    expect(failing.drill!.Dining[0]).toEqual({ d: '2026-08-20', n: 'CHIPOTLE', c: 1250, a: 'Card', i: 'act-1' });
  });

  it('an older reader’s rows carry neither field, so the app keeps them plain', async () => {
    const cube = await buildReportCube(deps({
      drillRows: vi.fn(() => [{ category: 'Dining', date: '2026-08-20', notes: 'CHIPOTLE · TRN-1', amount: 12.5, account: 'Card' }]),
      filingContext: vi.fn(async () => ({ rules: [], history: [] })),
    }), NOW, 2);
    expect(cube.drill!.Dining[0]).toEqual({ d: '2026-08-20', n: 'CHIPOTLE', c: 1250, a: 'Card' });
  });

  it('a heavy cube with every drill row carrying both fields stays under 80% of the size guard', async () => {
    // Measured for the plan: 24 months, 16 categories at the 30-row cap, six
    // accounts — 104,715 bytes without the two fields, 148,875 with these
    // (the longest) codes on every row: 74% of the guard.
    const categories = Array.from({ length: 16 }, (_, i) => `Category ${String.fromCharCode(65 + i)} & Co`);
    const accounts = Array.from({ length: 6 }, (_, i) => ({
      sfinId: `ACT-${i}f0b2c3d-4e5f-6071-8293-a4b5c6d7e8f9`, wfId: `wf-${i}`, name: `Account number ${i} (4937)`, type: i < 2 ? 'CASH' : 'CREDIT_CARD',
    }));
    const months = Array.from({ length: 24 }, (_, b) => new Date(Date.UTC(2026, 7 - 23 + b, 1)).toISOString().slice(0, 7));
    const heavy = deps({
      accountMeta: vi.fn(async () => accounts),
      spendMatrix: vi.fn(() => months.flatMap((month) => categories.flatMap((category, ci) => accounts.slice(0, 5).map((a, ai) => ({
        month, category, accountId: a.wfId, amount: 12.34 * (ci + ai + 1),
      }))))),
      incomeByMonthAccount: vi.fn(() => months.flatMap((month) => accounts.map((a) => ({ month, accountId: a.wfId, amount: 1234.56 })))),
      uncategorizedByMonthAccount: vi.fn(() => months.flatMap((month) => accounts.map((a) => ({ month, accountId: a.wfId, amount: 45.67 })))),
      budgetsForMonth: vi.fn(() => Object.fromEntries(categories.map((c) => [c, 250]))),
      merchantRows: vi.fn(() => months.flatMap((month) => Array.from({ length: 40 }, (_, i) => ({
        month, date: `${month}-${String((i % 27) + 1).padStart(2, '0')}`, notes: `POS PURCHASE SQ *HEINE BROTHERS COFF ${i} · TRN-${month}-${i}`, amount: 10 + i,
      })))),
      valuationByMonth: vi.fn(() => months.flatMap((month) => accounts.map((a) => ({ month, accountId: a.wfId, amount: 12345.67 })))),
      drillRows: vi.fn(() => categories.flatMap((category, ci) => Array.from({ length: 40 }, (_, i) => ({
        category, date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, notes: `POS PURCHASE CHIPOTLE 1234 LOUISVILLE KY · TRN-a1b2c3d4-${ci}-${i}`,
        amount: 12.34 + i, account: accounts[i % 5].name,
        activityId: `0f8fad5b-d9cb-469f-a165-7086772895${String(ci).padStart(2, '0')}`, accountId: accounts[i % 5].wfId,
        categoryId: `cat-${ci}`, source: 'rule', activityType: 'WITHDRAWAL',
      })))),
      filingContext: vi.fn(async () => ({
        rules: categories.map((_, ci) => ({ id: `r${ci}`, pattern: 'POS PURCHASE CHIPOTLE 1234 LOUISVILLE KY', categoryId: `cat-${ci}` })),
        history: [],
      })),
    });
    const cube = await buildReportCube(heavy, NOW);
    expect(cube.months).toHaveLength(24);
    expect(Object.values(cube.drill!).every((list) => list.length === 30 && list.every((r) => r.i && r.f))).toBe(true);
    expect(JSON.stringify(cube).length).toBeLessThanOrEqual(REPORT_CUBE_MAX_BYTES * 0.8);
  });

  it('detects subscriptions from dated merchant rows', async () => {
    const cube = await buildReportCube(deps({
      merchantRows: vi.fn(() => [
        { month: '2026-07', date: '2026-07-01', notes: 'NETFLIX.COM \u00b7 T1', amount: 15.49 },
        { month: '2026-07', date: '2026-07-29', notes: 'NETFLIX.COM \u00b7 T2', amount: 15.49 },
        { month: '2026-08', date: '2026-08-26', notes: 'NETFLIX.COM \u00b7 T3', amount: 15.49 },
        { month: '2026-08', date: '2026-08-26', notes: 'ONE-OFF STORE \u00b7 T4', amount: 80 },
      ]),
    }), NOW, 2);
    expect(cube.subscriptions).toEqual([{
      name: 'NETFLIX.COM', monthlyCents: 1549, count: 3,
      lastDate: '2026-08-26', lastCents: 1549, prevCents: 1549, creep: false, kind: 'subscription',
      recent: [
        { date: '2026-08-26', cents: 1549 }, { date: '2026-07-29', cents: 1549 }, { date: '2026-07-01', cents: 1549 },
      ],
    }]);
  });

  it('publishes null subscriptions when merchant rows carry no dates', async () => {
    // An older reader binding: "could not look" must stay distinguishable
    // from "looked and found none".
    const cube = await buildReportCube(deps(), NOW, 2);
    expect(cube.subscriptions ?? null).toBeNull();
  });

  it('pins the current month against the independent digest readers', async () => {
    // Two pipelines that must agree: the matrix fill above vs the single-shot
    // digest readers. The fixture's $99 unmapped Dining row is the one honest
    // divergence — the cube drops it, the digest counts it.
    const cube = await buildReportCube(deps({
      checkTotals: vi.fn((start: string, endEx: string) => {
        expect(start).toBe('2026-08-01');
        expect(endEx).toBe('2026-09-01');
        return { spendByCategory: { Groceries: 40, Dining: 99 }, uncategorized: 12 };
      }),
    }), NOW, 2);
    expect(cube.check).toEqual({
      month: '2026-08',
      cubeSpendCents: 4000,
      cubeUncatCents: 1200,
      ledgerSpendCents: 13900,
      ledgerUncatCents: 1200,
    });
  });

  it('publishes no check when the reader is not bound', async () => {
    // Optional-call every new dep: an older binding must keep building cubes.
    const cube = await buildReportCube(deps(), NOW, 2);
    expect(cube.check ?? null).toBeNull();
  });

  it('builds the requested month window and asks every reader for exactly that span', async () => {
    const d = deps();
    const cube = await buildReportCube(d, NOW, 2);
    expect(cube.months).toEqual(['2026-07', '2026-08']);
    expect(cube.asOf).toBe(NOW.toISOString());
    expect(d.spendMatrix).toHaveBeenCalledWith('2026-07-01', '2026-09-01');
    expect(d.uncategorizedByMonthAccount).toHaveBeenCalledWith('2026-07-01', '2026-09-01');
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

describe('link suggestions in the cube (1.60)', () => {
  const hulu = { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly' as const, nextDate: '2026-09-20' };
  const huluRows = () => [
    { month: '2026-08', date: '2026-08-19', notes: 'HULU 877-824-4858 · TRN-41', amount: 9.99 },
    { month: '2026-08', date: '2026-08-21', notes: 'CHIPOTLE 1234 · TRN-42', amount: 14.5 },
  ];

  it("publishes the hand-added entries' link suggestions from the dated charges", async () => {
    const cube = await buildReportCube(deps({
      merchantRows: vi.fn(huluRows),
      subscriptionPrefs: vi.fn(async () => ({ ...emptySubscriptionPrefs(), manual: [hulu] })),
    }), NOW, 2);
    expect(cube.subscriptionLinks).toEqual([{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-08-19', cents: 999 }]);
    expect(parseReportCube(JSON.stringify(cube))?.subscriptionLinks).toEqual(cube.subscriptionLinks);
  });

  it('publishes null without the binding or when reading the prefs fails — the cube still builds', async () => {
    expect((await buildReportCube(deps({ merchantRows: vi.fn(huluRows) }), NOW, 2)).subscriptionLinks).toBeNull();
    const failing = await buildReportCube(deps({
      merchantRows: vi.fn(huluRows),
      subscriptionPrefs: vi.fn(async () => { throw new Error('down'); }),
    }), NOW, 2);
    expect(failing.subscriptionLinks).toBeNull();
    expect(failing.months).toHaveLength(2);
  });
});

describe('subscriptions follow a renamed charge (1.63, C1)', () => {
  it("joins Google's renamed charge to its old name, because each row names its account", async () => {
    const row = (date: string, notes: string, amount: number) => ({ month: date.slice(0, 7), date, notes, amount, accountId: 'acct-card' });
    const cube = await buildReportCube(deps({
      merchantRows: vi.fn(() => [
        row('2026-06-06', 'GOOGLE *Google One MOUNTAIN VIEW CA · TRN-1', 5.29),
        row('2026-06-10', 'Google One Mountain View CA · TRN-2', 26.49),
        row('2026-07-06', 'GOOGLE *Google One MOUNTAIN VIEW CA · TRN-3', 5.29),
        row('2026-08-06', 'GOOGLE *Google One MOUNTAIN VIEW CA · TRN-4', 5.29),
        row('2026-09-06', 'GOOGLE *Google One MOUNTAIN VIEW CA · TRN-5', 21.19),
        row('2026-10-06', 'GOOGLE *G1AI101M MOUNTAIN VIEW CA · TRN-6', 21.19),
      ]),
    }), new Date('2026-10-22T12:00:00Z'), 2);
    expect(cube.subscriptions).toEqual([expect.objectContaining({
      name: 'GOOGLE *Google One MOUNTAIN VIEW CA', kind: 'subscription', monthlyCents: 2119, count: 5, lastDate: '2026-10-06',
    })]);
  });
});
