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
 * Every view is derived from ONE transaction table, so they agree by
 * construction: the spend matrix, the merchants, the drill-down and the
 * subscriptions are sums and lists of the same rows; net worth and liquid move
 * by income minus spend. Nothing is dated after `now`. Deterministic: the same
 * `now` gives the same cube. Plain text only — no emoji, generic merchant
 * names — and every number is whole cents, as the companion publishes them.
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

type Cat = (typeof SAMPLE_CATEGORIES)[number];
interface Tx { month: string; day: number; name: string; cat: Cat; account: number; cents: number }

/** Each month against a typical one, oldest first. Fixed charges (rent, bills,
 *  subscriptions) are not scaled. */
const MONTH_FACTORS = [0.96, 1.04, 0.92, 1.11, 0.98, 1.0];

/** Default monthly budgets, cents. Only Shopping runs over. */
const BUDGETS: Partial<Record<Cat, number>> = {
  'Dining out': 19_000, Groceries: 40_000, Housing: 140_000, Shopping: 15_000,
};

/** A month's spending: day of month, merchant, category, account, typical
 *  cents, fixed (not scaled by the month's factor). Accounts: 0 checking,
 *  1 savings, 2 card. */
const TEMPLATE: Array<[number, string, Cat, number, number, boolean]> = [
  [1, 'Apartment Rent', 'Housing', 0, 140_000, true],
  [2, 'Fuel Stop', 'Gas', 2, 5_800, false],
  [3, 'Corner Grocer', 'Groceries', 2, 12_000, false],
  [4, 'Burrito Bar', 'Dining out', 2, 4_300, false],
  [5, 'Big Box Store', 'Shopping', 2, 9_000, false],
  [6, 'StreamPlus', 'Entertainment', 2, 1_549, true],
  [7, 'Corner Pharmacy', 'Health', 0, 3_500, false],
  [8, 'Bulk Warehouse', 'Groceries', 0, 9_500, false],
  [9, 'Metro Water', 'Utilities', 0, 8_000, true],
  [9, 'Blue Door Cafe', 'Dining out', 0, 4_000, false],
  [11, 'Family Clinic', 'Health', 2, 2_000, false],
  [12, 'TuneBox', 'Entertainment', 2, 1_099, true],
  [13, 'Burrito Bar', 'Dining out', 2, 4_100, false],
  [15, 'Movie House', 'Entertainment', 2, 2_400, false],
  [16, 'Fuel Stop', 'Gas', 2, 6_000, false],
  [17, 'Corner Grocer', 'Groceries', 2, 11_000, false],
  [19, 'Big Box Store', 'Shopping', 2, 8_500, false],
  [20, 'City Power & Light', 'Utilities', 0, 9_800, true],
  [24, 'Blue Door Cafe', 'Dining out', 2, 4_100, false],
];

/** Recurring charges shown on the Subscriptions card, in its order. */
const RECURRING: Array<[string, 'subscription' | 'bill']> = [
  ['StreamPlus', 'subscription'], ['TuneBox', 'subscription'], ['City Power & Light', 'bill'],
];

/** Two paychecks a month into checking (the 1st and 15th), interest on savings. */
const PAYCHECKS: Array<[number, number]> = [[1, 256_000], [15, 256_000]];
const INTEREST_CENTS = 1_150;
const INTEREST_DAY = 28;
/** The card's interest in one month, and which one. */
const CARD_INTEREST_CENTS = 1_243;
const CARD_INTEREST_MONTH = 2;
/** What net worth gains each month beyond saving: a small, fixed investment drift. */
export const SAMPLE_NET_WORTH_DRIFT_CENTS = 15_000;
const START_LIQUID_CENTS = 1_120_000;
const START_INVESTED_CENTS = 720_000;

const pad = (n: number) => String(n).padStart(2, '0');
/** `YYYY-MM` of the month `back` months before `now`'s own (local) month. */
function monthBefore(now: Date, back: number): string {
  const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
const dateOf = (t: Tx) => `${t.month}-${pad(t.day)}`;

export function sampleReportCube(now: Date): ReportCube {
  const months = Array.from({ length: SAMPLE_MONTHS }, (_, i) => monthBefore(now, SAMPLE_MONTHS - 1 - i));
  const last = SAMPLE_MONTHS - 1;
  const today = now.getDate();
  const inMonth = (mi: number, day: number) => mi !== last || day <= today;

  // The one transaction table.
  const txs: Tx[] = months.flatMap((month, mi) => TEMPLATE
    .filter(([day]) => inMonth(mi, day))
    .map(([day, name, cat, account, base, fixed]): Tx => ({
      month, day, name, cat, account, cents: fixed ? base : Math.round(base * MONTH_FACTORS[mi]),
    })));

  const spend = months.map((m) => SAMPLE_CATEGORIES.map((cat) => ACCOUNTS.map((_, ai) => txs
    .filter((t) => t.month === m && t.cat === cat && t.account === ai)
    .reduce((s, t) => s + t.cents, 0))));

  const merchants = months.map((m): CubeMerchant[] => {
    const byName = new Map<string, CubeMerchant>();
    for (const t of txs) {
      if (t.month !== m) continue;
      const row = byName.get(t.name) ?? { name: t.name, cents: 0, count: 0 };
      row.cents += t.cents;
      row.count += 1;
      byName.set(t.name, row);
    }
    return [...byName.values()].sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name)).slice(0, 20);
  });

  const drill: Record<string, DrillTx[]> = {};
  for (const t of txs) {
    if (t.month !== months[last]) continue;
    (drill[t.cat] ??= []).push({ d: dateOf(t), n: t.name, c: t.cents, a: ACCOUNTS[t.account].name });
  }
  for (const rows of Object.values(drill)) rows.sort((a, b) => b.d.localeCompare(a.d) || a.n.localeCompare(b.n));

  const income = months.map((_, mi) => [
    PAYCHECKS.filter(([day]) => inMonth(mi, day)).reduce((s, [, c]) => s + c, 0),
    inMonth(mi, INTEREST_DAY) ? INTEREST_CENTS : 0,
    0,
  ]);
  const feesInterest = months.map((_, mi) => (mi === CARD_INTEREST_MONTH ? CARD_INTEREST_CENTS : 0));

  // Net worth and liquid move by what came in minus what went out.
  const net = months.map((_, mi) => income[mi].reduce((s, v) => s + v, 0)
    - spend[mi].flat().reduce((s, v) => s + v, 0) - feesInterest[mi]);
  const liquid: number[] = [];
  const netWorth: number[] = [];
  months.forEach((_, mi) => {
    liquid.push(mi === 0 ? START_LIQUID_CENTS + net[0] : liquid[mi - 1] + net[mi]);
    netWorth.push(mi === 0 ? START_LIQUID_CENTS + START_INVESTED_CENTS + net[0] + SAMPLE_NET_WORTH_DRIFT_CENTS
      : netWorth[mi - 1] + net[mi] + SAMPLE_NET_WORTH_DRIFT_CENTS);
  });

  const subscriptions: DetectedSubscription[] = RECURRING.map(([name, kind]) => {
    const charges = txs.filter((t) => t.name === name).sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
    return {
      name,
      monthlyCents: charges[0].cents,
      count: charges.length,
      lastDate: dateOf(charges[0]),
      lastCents: charges[0].cents,
      prevCents: charges[1]?.cents,
      creep: false,
      kind,
      recent: charges.slice(0, 3).map((t) => ({ date: dateOf(t), cents: t.cents })),
    };
  });

  return {
    version: 1,
    asOf: now.toISOString(),
    months,
    categories: [...SAMPLE_CATEGORIES],
    accounts: ACCOUNTS.map((a) => ({ ...a })),
    spend,
    uncategorized: months.map(() => ACCOUNTS.map(() => 0)),
    income,
    budgets: months.map(() => SAMPLE_CATEGORIES.map((cat) => BUDGETS[cat] ?? 0)),
    merchants,
    feesInterest,
    netWorth,
    liquid,
    pool: null,
    subscriptions,
    drill,
  };
}
