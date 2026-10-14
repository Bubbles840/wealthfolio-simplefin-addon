import { describe, it, expect } from 'vitest';
import {
  billChargesCents, billKeys, buildCashForecast, cashToday, dailySpendCents, detectorKey, historyMonths, historyWindow,
  type CashToday, type MerchantRow,
} from './forecast-inputs';
import { FORECAST_REASONS } from './cash-forecast';
import type { ReportCube } from './report-cube';
import type { ManualSubscription } from './subscription-prefs';
import type { Roster, RosterEntry } from './subscription-roster';

/** SimpleFin's balance-date for a UTC day, at noon. */
const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`) / 1000;
const NOW = new Date('2026-10-14T18:00:00.000Z');

/** Food spending per month on [PNC Checking, Discover]: the card counts too. */
function cubeOf(months: string[], food: Array<[number, number]>, over: Partial<ReportCube> = {}): ReportCube {
  return {
    version: 1, asOf: NOW.toISOString(), months, categories: ['Food'],
    accounts: [{ sfinId: 'sfin-chk', name: 'PNC Checking', type: 'CASH' }, { sfinId: 'sfin-card', name: 'Discover', type: 'CREDIT_CARD' }],
    spend: food.map(([chk, card]) => [[chk, card]]), uncategorized: months.map(() => [0, 0]), income: months.map(() => [0, 0]),
    budgets: months.map(() => [0]), merchants: months.map(() => []), feesInterest: months.map(() => 0),
    netWorth: months.map(() => null), liquid: months.map(() => null), pool: null, ...over,
  };
}
const MONTHS = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
/** Jul–Sep: $7,519.67 spent, $3,646.47 of it Netflix and rent. */
const CUBE = cubeOf(MONTHS, [[100000, 0], [200000, 50000], [201967, 50000], [200000, 50000], [30000, 0]]);
const HISTORY = ['2026-07', '2026-08', '2026-09'];
const ROWS: MerchantRow[] = [
  { month: '2026-07', notes: 'NETFLIX.COM 866-579 · TRN-1', amount: 15.49 },
  { month: '2026-08', notes: 'NETFLIX.COM 866-579 · TRN-2', amount: 15.49 },
  { month: '2026-09', notes: 'NETFLIX.COM 866-579 · TRN-3', amount: 15.49 },
  // This month is not history.
  { month: '2026-10', notes: 'NETFLIX.COM 866-579 · TRN-4', amount: 15.49 },
  { month: '2026-07', notes: 'RENT LLC · TRN-5', amount: 1200 },
  { month: '2026-08', notes: 'RENT LLC · TRN-6', amount: 1200 },
  { month: '2026-09', notes: 'RENT LLC · TRN-7', amount: 1200 },
  { month: '2026-08', notes: 'KROGER #415 · TRN-8', amount: 54.2 },
];

const entry = (over: Partial<RosterEntry> = {}): RosterEntry => ({
  key: 'NETFLIX.COM', displayName: 'Netflix', group: 'subscription', source: 'detected', cents: 1549,
  cadence: 'monthly', nextDate: '2026-10-20', recent: [], handle: 'h0000000', ...over,
});
const RENT = entry({ key: 'RENT LLC', displayName: 'Rent', group: 'bill', cents: 120000, nextDate: '2026-11-01' });
const roster = (over: Partial<Roster> = {}): Roster => ({
  subscriptions: [entry()], bills: [RENT], maybes: [], hidden: [], monthlyCents: 0, yearlyCents: 0, billsMonthlyCents: 0,
  linkSuggestions: [], detectionAvailable: true, ...over,
});
const manual = (over: Partial<ManualSubscription> = {}): ManualSubscription => ({
  id: 'abc12345', name: 'Streaming', cents: 1549, cadence: 'monthly', nextDate: '2026-10-20', ...over,
});

describe('cashToday', () => {
  const ACCOUNTS = [
    { id: 'wf-chk', name: 'Checking', accountType: 'CASH', isArchived: false, isActive: true },
    { id: 'wf-sav', name: 'Savings', accountType: 'cash' },
    { id: 'wf-card', name: 'Discover', accountType: 'CREDIT_CARD' },
    { id: 'wf-inv', name: 'Robinhood', accountType: 'SECURITIES' },
    { id: 'wf-old', name: 'Old', accountType: 'CASH', isArchived: true },
    { id: 'wf-hid', name: 'Hidden', accountType: 'CASH', isActive: false },
    { id: 'wf-joint', name: 'Joint', accountType: 'CASH' },
    { id: 'wf-undated', name: 'Undated', accountType: 'CASH' },
  ];
  const MAPPING = {
    'sfin-chk': 'wf-chk', 'sfin-sav': 'wf-sav', 'sfin-card': 'wf-card', 'sfin-inv': 'wf-inv', 'sfin-old': 'wf-old',
    'sfin-hid': 'wf-hid', 'sfin-joint': 'wf-joint', 'sfin-undated': 'wf-undated', 'sfin-gone': 'wf-deleted',
  };
  const BALANCES = {
    'sfin-chk': { balance: 3218.49, date: day('2026-10-14') },
    'sfin-sav': { balance: 500, date: day('2026-10-09') },
    'sfin-card': { balance: -400, date: day('2026-10-14') },
    'sfin-inv': { balance: 9000, date: day('2026-10-14') },
    'sfin-old': { balance: 10, date: day('2026-10-14') },
    'sfin-hid': { balance: 10, date: day('2026-10-14') },
    'sfin-joint': { balance: null, date: day('2026-10-14') },
    'sfin-undated': { balance: 75 },
    'sfin-gone': { balance: 5, date: day('2026-10-14') },
  };

  it('sums the bank balances of mapped CASH accounts — not cards, investments, archived or hidden ones', () => {
    expect(cashToday({ mapping: MAPPING, balances: BALANCES, names: { 'sfin-chk': 'PNC Checking' }, accounts: ACCOUNTS })).toEqual({
      cashCents: 371849,
      accounts: [
        { name: 'PNC Checking', cents: 321849, asOf: '2026-10-14' },
        { name: 'Savings', cents: 50000, asOf: '2026-10-09' },
      ],
      // Never a silent wrong total: no balance, or no date for it, is named.
      missing: ['Joint', 'Undated'],
    });
  });

  it.each<[string, unknown, unknown]>([
    ['NaN', Number.NaN, day('2026-10-14')],
    ['Infinity', Number.POSITIVE_INFINITY, day('2026-10-14')],
    ['-Infinity', Number.NEGATIVE_INFINITY, day('2026-10-14')],
    ['a number too large to hold in cents', 1e308, day('2026-10-14')],
    ['a string', '3218.49', day('2026-10-14')],
    ['a date NaN', 100, Number.NaN],
    ['a date outside what a calendar holds', 100, 1e15],
  ])('leaves out an account whose balance is malformed (%s), named in missing, never in the total', (_what, balance, date) => {
    const got = cashToday({
      mapping: { 'sfin-chk': 'wf-chk', 'sfin-sav': 'wf-sav' },
      balances: { 'sfin-chk': { balance, date }, 'sfin-sav': { balance: 500, date: day('2026-10-09') } },
      names: { 'sfin-chk': 'PNC Checking' },
      accounts: ACCOUNTS,
    });
    expect(got).toEqual({ cashCents: 50000, accounts: [{ name: 'Savings', cents: 50000, asOf: '2026-10-09' }], missing: ['PNC Checking'] });
  });

  it('counts nothing without a mapping or the accounts', () => {
    expect(cashToday({ mapping: {}, balances: BALANCES, names: {}, accounts: ACCOUNTS }))
      .toEqual({ cashCents: 0, accounts: [], missing: [] });
    expect(cashToday({ mapping: MAPPING, balances: BALANCES, names: {}, accounts: [] }))
      .toEqual({ cashCents: 0, accounts: [], missing: [] });
  });
});

describe('historyMonths', () => {
  const months = (food: Array<[number, number]>, all = MONTHS) => cubeOf(all, food);

  it('is the three full months before this one', () => {
    expect(historyMonths(CUBE, '2026-10')).toEqual(HISTORY);
    expect(historyWindow(HISTORY)).toEqual({ startInclusive: '2026-07-01', endExclusive: '2026-10-01' });
  });

  it('treats the month history starts in as partial, so a new install has fewer', () => {
    expect(historyMonths(months([[0, 0], [0, 0], [5000, 0], [9000, 0], [100, 0]]), '2026-10')).toEqual(['2026-09']);
    expect(historyMonths(months([[0, 0], [0, 0], [0, 0], [9000, 0], [100, 0]]), '2026-10')).toEqual([]);
    expect(historyMonths(months([[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]), '2026-10')).toEqual([]);
  });

  it('counts the cube’s first month as full, and crosses a year boundary', () => {
    const cube = cubeOf(['2026-09', '2026-10', '2026-11', '2026-12', '2027-01'], [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]);
    expect(historyMonths(cube, '2027-01')).toEqual(['2026-10', '2026-11', '2026-12']);
    expect(historyMonths(cubeOf(['2026-09', '2026-10'], [[1, 0], [2, 0]]), '2026-10')).toEqual(['2026-09']);
    expect(historyWindow(['2026-10', '2026-11', '2026-12'])).toEqual({ startInclusive: '2026-10-01', endExclusive: '2027-01-01' });
  });
});

describe('the bills’ past charges', () => {
  it('groups a row the way the subscription detector does', () => {
    expect(detectorKey('NETFLIX.COM 866-579 · TRN-1')).toBe('NETFLIX.COM');
    expect(detectorKey('PAYPAL *HULU 402-935 · TRN-2 · pending')).toBe('PAYPAL *HULU');
    expect(detectorKey(' · TRN-3')).toBe('');
  });

  it('is a detected entry’s key, or a hand-added entry’s linked merchant', () => {
    const linked = entry({ key: 'm:abc12345', source: 'manual', displayName: 'Streaming' });
    const unlinked = entry({ key: 'm:zzz99999', source: 'manual', displayName: 'Rent by check' });
    expect([...billKeys([RENT, linked, unlinked], [manual({ merchant: 'NETFLIX.COM' }), manual({ id: 'zzz99999' })])])
      .toEqual(['RENT LLC', 'NETFLIX.COM']);
  });

  it('sums what they charged in the history months, refunds subtracting', () => {
    const keys = new Set(['NETFLIX.COM', 'RENT LLC']);
    expect(billChargesCents(ROWS, keys, HISTORY)).toBe(364647);
    expect(billChargesCents([...ROWS, { month: '2026-08', notes: 'NETFLIX.COM 866-579 · TRN-9', amount: -15.49 }], keys, HISTORY)).toBe(363098);
    expect(billChargesCents(ROWS, new Set(), HISTORY)).toBe(0);
  });
});

describe('dailySpendCents', () => {
  it('is the months’ spending, cards and uncategorized included, less the bills’ charges, per calendar day', () => {
    expect(dailySpendCents(CUBE, HISTORY, 364647)).toBe(4210);
    expect(dailySpendCents(CUBE, HISTORY, 0)).toBe(8174);
    const uncategorized = MONTHS.map((m) => (m === '2026-08' ? [9200, 0] : [0, 0]));
    expect(dailySpendCents({ ...CUBE, uncategorized }, HISTORY, 364647)).toBe(4310);
    expect(dailySpendCents(cubeOf(['2027-02'], [[28000, 0]]), ['2027-02'], 0)).toBe(1000);
  });

  it('is never below $0', () => {
    expect(dailySpendCents(CUBE, HISTORY, 9_999_999)).toBe(0);
    expect(dailySpendCents(CUBE, [], 0)).toBe(0);
  });
});

describe('buildCashForecast', () => {
  const CASH: CashToday = {
    cashCents: 371849,
    accounts: [{ name: 'PNC Checking', cents: 321849, asOf: '2026-10-14' }, { name: 'Savings', cents: 50000, asOf: '2026-10-14' }],
    missing: [],
  };
  const build = (over: Partial<Parameters<typeof buildCashForecast>[0]> = {}) => buildCashForecast({
    now: NOW, today: '2026-10-14', cash: CASH, roster: roster(), manual: [], cube: CUBE, months: HISTORY, merchantRows: ROWS, ...over,
  });

  it('is the spec’s example: $1,240 left on Nov 13, the bills never counted twice', () => {
    expect(build()).toEqual({
      v: 1, at: '2026-10-14T18:00:00.000Z', ok: true, cashCents: 371849, lowCents: 124000, lowDate: '2026-11-13',
      days: 30, basedOnMonths: 3, dailySpendCents: 4210,
      accounts: CASH.accounts,
      bills: [{ name: 'Netflix', date: '2026-10-20', cents: 1549 }, { name: 'Rent', date: '2026-11-01', cents: 120000 }],
    });
  });

  it('names the first short day, and the cash accounts it had to leave out', () => {
    const f = build({ cash: { cashCents: 150000, accounts: [{ name: 'PNC Checking', cents: 150000, asOf: '2026-10-14' }], missing: ['Joint'] } });
    expect(f).toMatchObject({ ok: true, shortDate: '2026-11-01', missing: ['Joint'] });
  });

  it('says it is based on fewer months while there are fewer', () => {
    expect(build({ months: ['2026-09'] })).toMatchObject({ ok: true, basedOnMonths: 1 });
  });

  it.each<[string, Partial<Parameters<typeof buildCashForecast>[0]>, string]>([
    ['no cash account is mapped', { cash: { cashCents: 0, accounts: [], missing: [] } }, FORECAST_REASONS.noCash],
    ['the bank sent no balance', { cash: { cashCents: 0, accounts: [], missing: ['Joint'] } }, FORECAST_REASONS.noBalance],
    ['there is no full month yet', { months: [] }, FORECAST_REASONS.noHistory],
  ])('makes no forecast when %s, and says why', (_what, over, reason) => {
    expect(build(over)).toEqual({ v: 1, at: '2026-10-14T18:00:00.000Z', ok: false, reason });
  });

  it.each<[string, Partial<Parameters<typeof buildCashForecast>[0]>, string]>([
    ['today’s cash is not a finite number', { cash: { ...CASH, cashCents: Number.NaN } }, FORECAST_REASONS.balances],
    ['a past charge of a bill is not finite', { merchantRows: [{ month: '2026-08', notes: 'NETFLIX.COM 866-579 · TRN-1', amount: Number.NaN }] }, FORECAST_REASONS.history],
    ['the cube’s spending is not finite', { cube: cubeOf(MONTHS, [[1, 0], [Number.NaN, 0], [1, 0], [1, 0], [1, 0]]) }, FORECAST_REASONS.history],
    ['a bill’s price is not finite', { roster: roster({ subscriptions: [entry({ cents: Number.POSITIVE_INFINITY })] }) }, FORECAST_REASONS.bills],
  ])('makes no forecast, never a number, when %s', (_what, over, reason) => {
    expect(build(over)).toEqual({ v: 1, at: '2026-10-14T18:00:00.000Z', ok: false, reason });
  });
});

