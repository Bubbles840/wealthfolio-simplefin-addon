/**
 * shared/sample-cube.ts
 *
 * A built-in, made-up report cube for the sample-data preview (project 4, G2):
 * what the Budget board looks like before a bank is linked or the companion
 * has synced. The board is a pure function of the cube (shared/report-cube.ts),
 * so a plausible cube is the whole preview — no other part of the app is faked.
 *
 * Six months, eight categories, three accounts, budgets on four categories,
 * two paychecks a month, merchants, two subscriptions and a bill. Its dates are
 * relative to `now`: the newest month is the one `now` falls in (the browser's
 * own month, as the board reads it), and it has spent about half a month.
 * Deterministic: the same `now` gives the same cube. Plain text only — no
 * emoji — and every number is whole cents, as the companion publishes them.
 */
import type { CubeAccount, CubeMerchant, DrillTx, ReportCube } from './report-cube.js';
import type { DetectedSubscription } from './subscriptions.js';

export const SAMPLE_MONTHS = 6;

/** Parent-level, alphabetical, as the companion publishes them. */
export const SAMPLE_CATEGORIES = [
  'Dining out', 'Entertainment', 'Gas', 'Groceries', 'Health', 'Housing', 'Shopping', 'Utilities',
] as const;

const ACCOUNTS: CubeAccount[] = [
  { sfinId: 'sample-checking', name: 'Everyday Checking', type: 'CASH' },
  { sfinId: 'sample-savings', name: 'Rainy Day Savings', type: 'CASH' },
  { sfinId: 'sample-card', name: 'Rewards Card', type: 'CREDIT_CARD' },
];

/** A typical month's spending, cents, per category: [checking, savings, card]. */
const TYPICAL: Record<(typeof SAMPLE_CATEGORIES)[number], [number, number, number]> = {
  'Dining out': [4_000, 0, 14_500],
  Entertainment: [0, 0, 5_200],
  Gas: [0, 0, 11_800],
  Groceries: [9_500, 0, 31_000],
  Health: [3_500, 0, 2_000],
  Housing: [140_000, 0, 0],
  Shopping: [0, 0, 16_500],
  Utilities: [17_800, 0, 0],
};

/** Each month against a typical one, oldest first. The newest is the month in
 *  progress; rent (Housing) is paid in full on the 1st of every month. */
const MONTH_FACTORS = [0.96, 1.04, 0.92, 1.11, 0.98, 0.52];

/** Default monthly budgets, cents. Shopping runs over most months. */
const BUDGETS: Partial<Record<(typeof SAMPLE_CATEGORIES)[number], number>> = {
  'Dining out': 15_000, Groceries: 40_000, Housing: 140_000, Shopping: 15_000,
};

/** A month's merchants: name, typical cents, charges. */
const MERCHANTS: Array<[string, number, number]> = [
  ['RIVERSIDE APARTMENTS', 140_000, 1],
  ['TRADER JOES', 18_400, 4],
  ['COSTCO WHSL', 12_100, 1],
  ['CITY POWER & LIGHT', 9_800, 1],
  ['SHELL OIL', 7_900, 3],
  ['TARGET', 6_200, 2],
  ['CHIPOTLE', 4_300, 3],
  ['CORNER PHARMACY', 3_100, 1],
  ['NETFLIX.COM', 1_549, 1],
  ['SPOTIFY USA', 1_199, 1],
];

/** The newest month's transactions per category: description, share of the
 *  category's spending, account index. */
const DRILL: Record<(typeof SAMPLE_CATEGORIES)[number], Array<[string, number, number]>> = {
  'Dining out': [['CHIPOTLE', 0.4, 2], ['BLUE DOOR CAFE', 0.6, 0]],
  Entertainment: [['NETFLIX.COM', 0.3, 2], ['CINEMA 8', 0.7, 2]],
  Gas: [['SHELL OIL', 1, 2]],
  Groceries: [['TRADER JOES', 0.65, 2], ['COSTCO WHSL', 0.35, 0]],
  Health: [['CORNER PHARMACY', 1, 0]],
  Housing: [['RIVERSIDE APARTMENTS', 1, 0]],
  Shopping: [['TARGET', 1, 2]],
  Utilities: [['CITY POWER & LIGHT', 0.55, 0], ['METRO WATER', 0.45, 0]],
};

const PAY_CENTS = 512_000;
const INTEREST_CENTS = 1_150;
const RENT = 'Housing';

const pad = (n: number) => String(n).padStart(2, '0');
/** `YYYY-MM` of the month `back` months before `now`'s own (local) month. */
function monthBefore(now: Date, back: number): string {
  const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function recent(month: string, day: number, cents: number[]): Array<{ date: string; cents: number }> {
  const [y, m] = month.split('-').map(Number);
  return cents.map((c, i) => {
    const d = new Date(y, m - 1 - i, day);
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, cents: c };
  });
}

export function sampleReportCube(now: Date): ReportCube {
  const months = Array.from({ length: SAMPLE_MONTHS }, (_, i) => monthBefore(now, SAMPLE_MONTHS - 1 - i));
  const last = SAMPLE_MONTHS - 1;
  const factor = (mi: number, category: string) => (category === RENT ? 1 : MONTH_FACTORS[mi]);

  const spend = months.map((_, mi) => SAMPLE_CATEGORIES.map((cat) => TYPICAL[cat].map((cents) => Math.round(cents * factor(mi, cat)))));
  const merchants = months.map((_, mi): CubeMerchant[] => MERCHANTS
    .map(([name, cents, count]) => ({
      name,
      cents: name === 'RIVERSIDE APARTMENTS' ? cents : Math.round(cents * MONTH_FACTORS[mi]),
      count: mi === last ? Math.ceil(count / 2) : count,
    }))
    .sort((a, b) => b.cents - a.cents));

  const newest = months[last];
  const drill: Record<string, DrillTx[]> = {};
  SAMPLE_CATEGORIES.forEach((cat, ci) => {
    const total = spend[last][ci].reduce((s, v) => s + v, 0);
    drill[cat] = DRILL[cat].map(([n, share, ai], i) => ({
      d: `${newest}-${pad(Math.min(28, 1 + i * 3))}`,
      n,
      c: Math.round(total * share),
      a: ACCOUNTS[ai].name,
    })).reverse();
  });

  const previous = months[last - 1];
  const subscriptions: DetectedSubscription[] = [
    {
      name: 'NETFLIX.COM', monthlyCents: 1_549, count: 5, lastDate: `${previous}-06`, lastCents: 1_549, prevCents: 1_549,
      creep: false, kind: 'subscription', recent: recent(previous, 6, [1_549, 1_549, 1_549]),
    },
    {
      name: 'SPOTIFY USA', monthlyCents: 1_099, count: 5, lastDate: `${previous}-12`, lastCents: 1_199, prevCents: 1_099,
      creep: true, kind: 'subscription', recent: recent(previous, 12, [1_199, 1_099, 1_099]),
    },
    {
      name: 'CITY POWER & LIGHT', monthlyCents: 9_800, count: 5, lastDate: `${previous}-20`, lastCents: 10_420, prevCents: 9_650,
      creep: false, kind: 'bill', recent: recent(previous, 20, [10_420, 9_650, 9_800]),
    },
  ];

  return {
    version: 1,
    asOf: now.toISOString(),
    months,
    categories: [...SAMPLE_CATEGORIES],
    accounts: ACCOUNTS.map((a) => ({ ...a })),
    spend,
    uncategorized: months.map((_, mi) => [Math.round(1_600 * MONTH_FACTORS[mi]), 0, Math.round(2_300 * MONTH_FACTORS[mi])]),
    income: months.map((_, mi) => [mi === last ? PAY_CENTS / 2 : PAY_CENTS, INTEREST_CENTS, 0]),
    budgets: months.map(() => SAMPLE_CATEGORIES.map((cat) => BUDGETS[cat] ?? 0)),
    merchants,
    feesInterest: months.map((_, mi) => (mi === 2 ? 1_243 : 0)),
    netWorth: months.map((_, mi) => 1_840_000 + mi * 92_000),
    liquid: months.map((_, mi) => 1_120_000 + mi * 61_000),
    pool: null,
    subscriptions,
    drill,
  };
}
