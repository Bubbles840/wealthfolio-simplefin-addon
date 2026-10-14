import { describe, it, expect } from 'vitest';
import { buildMonthReview, formatMonthReview, type MonthReviewInput } from './month-review';
import { bookkeepingChange, categoryFiledChange, stampChange } from './change-entries';
import type { ChangeLogRead } from './change-log';
import type { ReportCube } from './report-cube';
import type { Roster, RosterEntry } from './subscription-roster';
import type { DetectedSubscription } from './subscriptions';

const MONTHS = ['2026-08', '2026-09', '2026-10'];
/** [month][category][PNC Checking, Discover]: Dining, Groceries, Shopping, Travel. */
const SPEND = [
  [[20000, 5000], [40000, 0], [10000, 0], [0, 0]],
  [[10000, 7000], [52000, 0], [10500, 0], [4500, 0]],
  [[0, 0], [0, 0], [0, 0], [0, 0]],
];
const det = (name: string, over: Partial<DetectedSubscription> = {}): DetectedSubscription => ({
  name, monthlyCents: 1549, count: 6, lastDate: '2026-09-05', lastCents: 1549, creep: false, kind: 'subscription',
  recent: [{ date: '2026-09-05', cents: 1549 }, { date: '2026-08-05', cents: 1549 }, { date: '2026-07-05', cents: 1549 }], ...over,
});
const cube = (over: Partial<ReportCube> = {}): ReportCube => ({
  version: 1, asOf: '2026-10-01T09:00:00.000Z', months: MONTHS, categories: ['Dining', 'Groceries', 'Shopping', 'Travel'],
  accounts: [{ sfinId: 'sfin-chk', name: 'PNC Checking', type: 'CASH' }, { sfinId: 'sfin-card', name: 'Discover', type: 'CREDIT_CARD' }],
  spend: SPEND, uncategorized: MONTHS.map(() => [0, 0]), income: [[90000, 0], [100000, 0], [0, 0]],
  budgets: MONTHS.map(() => [0, 0, 0, 0]),
  merchants: [[], [
    { name: 'SQ *COFFEE_CLUB', cents: 900, count: 2 }, { name: 'KROGER #415', cents: 41200, count: 4 },
    { name: 'AMAZON MKTP', cents: 23000, count: 3 }, { name: 'SHELL OIL', cents: 12000, count: 2 },
  ], []],
  feesInterest: [0, 0, 0], netWorth: [1000000, 1124000, null], liquid: [null, null, null], pool: null,
  subscriptions: [
    // Two charges, the first in August: new in September.
    det('NETFLIX', { count: 2, recent: [{ date: '2026-09-05', cents: 1549 }, { date: '2026-08-05', cents: 1549 }] }),
    det('SPOTIFY', { monthlyCents: 1099, lastCents: 1199, creep: true, lastDate: '2026-09-12' }),
    det('ADOBE', { monthlyCents: 5499, lastCents: 5499, lastDate: '2026-09-25' }),
  ],
  ...over,
});
const entry = (key: string, displayName: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
  key, displayName, group: 'subscription', source: 'detected', cents: 1549, cadence: 'monthly', nextDate: '2026-10-05',
  recent: [], handle: 'h0000000', ...over,
});
const roster = (): Roster => ({
  subscriptions: [
    entry('NETFLIX', 'Netflix'),
    entry('SPOTIFY', 'Spotify', { cents: 1199, creep: { fromCents: 1099, toCents: 1199, chargedOn: '2026-09-12' } }),
    entry('HULU', 'Hulu', { nextDate: null, overdueSince: '2026-09-20' }),
    entry('OLD GYM', 'Old Gym', { nextDate: null, overdueSince: '2026-08-25' }),
    // Overdue only after the month reviewed: not September's news.
    entry('PEACOCK', 'Peacock', { nextDate: null, overdueSince: '2026-10-03' }),
    entry('ADOBE', 'Adobe', { cents: 5499 }),
  ],
  bills: [], maybes: [], hidden: [], monthlyCents: 0, yearlyCents: 0, billsMonthlyCents: 0, linkSuggestions: [], detectionAvailable: true,
});
const filed = (at: Date, description = 'KROGER #415') => stampChange(categoryFiledChange({
  actor: 'you', account: { name: 'Checking' }, activityId: 'a1', description, amountCents: -5420,
  before: null, after: { categoryId: 'cat-gro', categoryName: 'Groceries' },
}), 'companion', at);
const log = (over: Partial<ChangeLogRead> = {}): ChangeLogRead => ({
  entries: [
    filed(new Date(2026, 9, 2, 9, 0)),
    filed(new Date(2026, 8, 20, 9, 0)),
    filed(new Date(2026, 8, 10, 9, 0)),
    // Background: not what the log shows by default.
    stampChange(bookkeepingChange({ step: 'external-marker', activityIds: ['x1'] }), 'companion', new Date(2026, 8, 11, 9, 0)),
  ],
  gaps: [], trimmed: 0, unreadable: [], ...over,
});
const input = (over: Partial<MonthReviewInput> = {}): MonthReviewInput => ({
  month: '2026-09', cube: cube(), roster: roster(), changes: log(), ...over,
});

const FULL = [
  '*Month in review*',
  'Biggest changes: Groceries +$120 · Dining -$80 · Travel +$45',
  'Top merchants: KROGER #415 $412 · AMAZON MKTP $230 · SHELL OIL $120',
  'New: Netflix $15.49/mo (since Aug 5)',
  'No longer charging (cancelled?): Hulu · Old Gym',
  'Rose in price: Spotify $10.99 → $11.99',
  'Net worth: +$1,240 over the month',
  'Savings rate: 16%',
  '2 changes were made to your books (see /changes).',
].join('\n');

describe('the month in review', () => {
  it('says what changed, where the money went, the subscriptions, net worth, savings and the books', () => {
    expect(formatMonthReview(buildMonthReview(input()))).toBe(FULL);
  });

  it('calls a subscription new only while its history is known and it began this month or last', () => {
    const subs = cube().subscriptions!.map((d) => (d.name === 'NETFLIX' ? { ...d, count: 3 } : d));
    expect(buildMonthReview(input({ cube: cube({ subscriptions: subs }) })).newSubs).toBeNull();
    // Reviewed a month later, September's new subscription is not new again.
    expect(buildMonthReview(input({ month: '2026-10' })).newSubs).toBeNull();
  });

  it.each<[string, Partial<MonthReviewInput>, string[]]>([
    ['there is no cube', { cube: null }, ['Biggest changes', 'Top merchants', 'New:', 'Net worth', 'Savings rate']],
    ['the cube does not have the month', { month: '2026-11' }, ['Biggest changes', 'Top merchants', 'Net worth', 'Savings rate']],
    ['the month before is not in the cube', { cube: cube({ months: ['2026-09', '2026-10', '2026-11'], netWorth: [1124000, null, null] }) }, ['Biggest changes', 'Net worth']],
    ['a month-end net worth is unknown', { cube: cube({ netWorth: [null, 1124000, null] }) }, ['Net worth']],
    ['nothing came in', { cube: cube({ income: [[0, 0], [0, 0], [0, 0]] }) }, ['Savings rate']],
    ['no merchant charged', { cube: cube({ merchants: [[], [], []] }) }, ['Top merchants']],
    ['there is no roster', { roster: null }, ['New:', 'No longer charging', 'Rose in price']],
    ['the change log cannot be read', { changes: null }, ['changes were made']],
    ['the change log has a gap', { changes: log({ gaps: [{ at: '2026-09-15T00:00:00.000Z', count: 2, reason: "couldn't save the log", writer: 'addon' }] }) }, ['changes were made']],
    ['nothing changed in the books', { changes: log({ entries: [] }) }, ['changes were made']],
  ])('leaves a line out when %s', (_what, over, missing) => {
    const text = formatMonthReview(buildMonthReview(input(over)));
    for (const line of missing) expect(text).not.toContain(line);
    expect(text).toContain('*Month in review*');
  });

  it('is no section at all with nothing to say', () => {
    expect(formatMonthReview(buildMonthReview({ month: '2026-09', cube: null, roster: null, changes: null }))).toBeNull();
  });

  it('says one change, and a net worth that did not move', () => {
    const text = formatMonthReview(buildMonthReview(input({
      cube: cube({ netWorth: [1000000, 1000020, null] }), changes: log({ entries: [filed(new Date(2026, 8, 10, 9, 0))] }),
    })));
    expect(text).toContain('\nNet worth: $0 over the month\n');
    expect(text).toContain('\n1 change was made to your books (see /changes).');
  });

  it('escapes bank and category text and keeps it out of every entity', () => {
    const odd = cube({
      categories: ['Food_Drink', 'Groceries', 'Shopping', 'Travel'],
      merchants: [[], [{ name: 'SQ *COFFEE_CLUB', cents: 90000, count: 2 }], []],
    });
    const r = roster();
    r.subscriptions[2] = entry('HULU', 'Hulu_Plus *', { nextDate: null, overdueSince: '2026-09-20' });
    const text = formatMonthReview(buildMonthReview(input({ cube: odd, roster: r })))!;
    expect(text).toContain('Food\\_Drink -$80');
    expect(text).toContain('Top merchants: SQ \\*COFFEE\\_CLUB $900');
    expect(text).toContain('Hulu\\_Plus \\*');
    expect(text.replace('*Month in review*', '').replace(/\\[_*`[]/g, '')).not.toMatch(/[_*`[]/);
  });
});
