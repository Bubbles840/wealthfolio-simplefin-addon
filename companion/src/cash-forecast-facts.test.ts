import { describe, it, expect, vi } from 'vitest';
import { publishCashForecast, runCashForecast, type ForecastReaders } from './cash-forecast-facts.js';
import { FORECAST_REASONS } from '../../shared/cash-forecast.js';
import type { MerchantRow } from '../../shared/forecast-inputs.js';

const NOW = new Date('2026-10-14T18:00:00.000Z');
/** SimpleFin's balance-date for a UTC day, at noon. */
const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`) / 1000;
const MONTHS = ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
/** Food spending per month on [PNC Checking, Discover]; Jul–Sep total $7,519.67. */
const FOOD: Array<[number, number]> = [[100000, 0], [200000, 50000], [201967, 50000], [200000, 50000], [30000, 0]];
const det = (name: string, over: Record<string, unknown> = {}) => ({
  name, monthlyCents: 1549, count: 5, lastDate: '2026-09-20', lastCents: 1549, prevCents: 1549, creep: false,
  kind: 'subscription', recent: [{ date: '2026-09-20', cents: 1549 }], ...over,
});
const CUBE = JSON.stringify({
  version: 1, asOf: NOW.toISOString(), months: MONTHS, categories: ['Food'],
  accounts: [{ sfinId: 'sfin-chk', name: 'PNC Checking', type: 'CASH' }, { sfinId: 'sfin-card', name: 'Discover', type: 'CREDIT_CARD' }],
  spend: FOOD.map(([chk, card]) => [[chk, card]]), uncategorized: MONTHS.map(() => [0, 0]), income: MONTHS.map(() => [0, 0]),
  budgets: MONTHS.map(() => [0]), merchants: MONTHS.map(() => []), feesInterest: MONTHS.map(() => 0),
  netWorth: MONTHS.map(() => null), liquid: MONTHS.map(() => null), pool: null,
  subscriptions: [
    det('NETFLIX.COM'),
    det('RENT LLC', { kind: 'bill', monthlyCents: 120000, lastCents: 120000, lastDate: '2026-10-01', recent: [{ date: '2026-10-01', cents: 120000 }] }),
  ],
});
const ROWS: MerchantRow[] = [
  { month: '2026-07', notes: 'NETFLIX.COM 866-579 · TRN-1', amount: 15.49 },
  { month: '2026-08', notes: 'NETFLIX.COM 866-579 · TRN-2', amount: 15.49 },
  { month: '2026-09', notes: 'NETFLIX.COM 866-579 · TRN-3', amount: 15.49 },
  { month: '2026-07', notes: 'RENT LLC · TRN-5', amount: 1200 },
  { month: '2026-08', notes: 'RENT LLC · TRN-6', amount: 1200 },
  { month: '2026-09', notes: 'RENT LLC · TRN-7', amount: 1200 },
];
const secrets = (over: Array<[string, string]> = []) => new Map<string, string>([
  ['account_mapping', JSON.stringify({ 'sfin-chk': 'wf-chk', 'sfin-sav': 'wf-sav', 'sfin-card': 'wf-card' })],
  ['account_balances', JSON.stringify({
    'sfin-chk': { balance: 3218.49, currency: 'USD', date: day('2026-10-14'), drift: null },
    'sfin-sav': { balance: 500, currency: 'USD', date: day('2026-10-14'), drift: null },
    'sfin-card': { balance: -400, currency: 'USD', date: day('2026-10-14'), drift: null },
  })],
  ['account_names', JSON.stringify({ 'sfin-chk': 'PNC Checking', 'sfin-sav': 'Savings' })],
  ['report_cube', CUBE],
  ...over,
]);
const ACCOUNTS = [
  { id: 'wf-chk', name: 'Checking', accountType: 'CASH' },
  { id: 'wf-sav', name: 'Save', accountType: 'CASH' },
  { id: 'wf-card', name: 'Discover', accountType: 'CREDIT_CARD' },
];

function readers(opts: {
  secrets?: Map<string, string>; unreachable?: boolean; accounts?: () => Promise<typeof ACCOUNTS>;
  rows?: () => MerchantRow[]; timezone?: string | null;
} = {}) {
  const store = opts.secrets ?? secrets();
  const r: ForecastReaders = {
    secret: vi.fn(async (key: string) => {
      if (opts.unreachable) throw new Error('ECONNREFUSED');
      return store.get(key) ?? null;
    }),
    accounts: vi.fn(opts.accounts ?? (async () => ACCOUNTS)),
    merchantRows: vi.fn(opts.rows ?? (() => ROWS)),
    timezone: vi.fn(() => opts.timezone ?? null),
  };
  return r;
}

const EXPECTED = {
  v: 1, at: '2026-10-14T18:00:00.000Z', ok: true, cashCents: 371849, lowCents: 124000, lowDate: '2026-11-13',
  days: 30, basedOnMonths: 3, dailySpendCents: 4210,
  accounts: [{ name: 'PNC Checking', cents: 321849, asOf: '2026-10-14' }, { name: 'Savings', cents: 50000, asOf: '2026-10-14' }],
  bills: [{ name: 'NETFLIX.COM', date: '2026-10-20', cents: 1549 }, { name: 'RENT LLC', date: '2026-11-01', cents: 120000 }],
};

describe('runCashForecast', () => {
  it('forecasts from the balances, the accounts, the roster and the bills’ past charges', async () => {
    const r = readers({ timezone: 'America/New_York' });
    expect(await runCashForecast(r, NOW)).toEqual(EXPECTED);
    expect(r.merchantRows).toHaveBeenCalledWith('2026-07-01', '2026-10-01');
  });

  it("dates today in Wealthfolio's timezone", async () => {
    const instant = new Date('2026-11-01T02:00:00Z');
    const ny = readers({ timezone: 'America/New_York' });
    await runCashForecast(ny, instant);
    expect(ny.merchantRows).toHaveBeenCalledWith('2026-07-01', '2026-10-01');
    const berlin = readers({ timezone: 'Europe/Berlin' });
    await runCashForecast(berlin, instant);
    expect(berlin.merchantRows).toHaveBeenCalledWith('2026-08-01', '2026-11-01');
  });

  it("falls back to Wealthfolio's own account names when the bank's list is unreadable", async () => {
    const f = await runCashForecast(readers({ secrets: secrets([['account_names', '{oops']]) }), NOW);
    expect(f).toMatchObject({ ok: true, accounts: [{ name: 'Checking', cents: 321849 }, { name: 'Save', cents: 50000 }] });
  });

  it('says there is nothing to forecast without a counted cash account, before reading anything else', async () => {
    const cardOnly = readers({ secrets: secrets([['account_mapping', JSON.stringify({ 'sfin-card': 'wf-card' })]]) });
    expect(await runCashForecast(cardOnly, NOW)).toEqual({ v: 1, at: '2026-10-14T18:00:00.000Z', ok: false, reason: FORECAST_REASONS.noCash });
    expect(cardOnly.secret).not.toHaveBeenCalledWith('report_cube');
    const noBalance = readers({ secrets: secrets([['account_balances', JSON.stringify({})]]) });
    expect(await runCashForecast(noBalance, NOW)).toMatchObject({ ok: false, reason: FORECAST_REASONS.noBalance });
  });

  it.each<[string, Parameters<typeof readers>[0], string]>([
    ['the mapping', { secrets: secrets([['account_mapping', '{oops']]) }, FORECAST_REASONS.mapping],
    ['the balances', { secrets: secrets([['account_balances', '[1,2]']]) }, FORECAST_REASONS.balances],
    ["Wealthfolio's accounts", { accounts: async () => { throw new Error('500'); } }, FORECAST_REASONS.accounts],
    ['the spending history (none yet)', { secrets: secrets([['report_cube', '']]) }, FORECAST_REASONS.history],
    ['the spending history (corrupt)', { secrets: secrets([['report_cube', '{"version":9}']]) }, FORECAST_REASONS.history],
    ['the subscriptions and bills', { secrets: secrets([['subscription_prefs', '{oops']]) }, FORECAST_REASONS.bills],
    ['the database', { rows: () => { throw new Error('no database'); } }, FORECAST_REASONS.database],
  ])('a failed read of %s is a reason, never a number', async (_what, opts, reason) => {
    expect(await runCashForecast(readers(opts), NOW)).toEqual({ v: 1, at: '2026-10-14T18:00:00.000Z', ok: false, reason });
  });
});

describe('publishCashForecast', () => {
  it('writes the forecast to cash_forecast', async () => {
    const client = { setAddonSecret: vi.fn(async () => {}) } as any;
    expect(await publishCashForecast(client, '/db', NOW, readers())).toBe(true);
    expect(client.setAddonSecret).toHaveBeenCalledWith('simplefin-sync', 'cash_forecast', JSON.stringify(EXPECTED));
  });

  it('writes nothing when Wealthfolio cannot be reached, so the previous forecast stays', async () => {
    const client = { setAddonSecret: vi.fn(async () => {}) } as any;
    expect(await publishCashForecast(client, '/db', NOW, readers({ unreachable: true }))).toBe(false);
    expect(client.setAddonSecret).not.toHaveBeenCalled();
  });

  it('rejects when the write fails, for the sync to log', async () => {
    const client = { setAddonSecret: vi.fn(async () => { throw new Error('disk full'); }) } as any;
    await expect(publishCashForecast(client, '/db', NOW, readers())).rejects.toThrow('disk full');
  });
});
