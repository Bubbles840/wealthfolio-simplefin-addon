/**
 * shared/forecast-inputs.ts
 *
 * What goes into the 30-day forecast (project 5 R1, spec A; rulings N1–N2),
 * pure — the companion does the reads (companion/src/cash-forecast-facts.ts):
 *
 *  - Cash today: the bank balances (`account_balances`, dollars, keyed by
 *    SimpleFin id) of the mapped accounts whose Wealthfolio account is CASH
 *    and neither archived nor hidden. Cards, investment accounts and unmapped
 *    accounts are left out. A counted account the bank sent no numeric balance
 *    for is left out BY NAME, never silently; a balance with no usable date
 *    still counts, its date unknown (`asOf: null`).
 *  - The bills: the roster's subscriptions and bills with a date
 *    (forecastBills in shared/forecast.ts).
 *  - Daily spending: the report's spending — the cube's `monthlySpendTotals`,
 *    the Budget tab's "Spent this month": every category, every mapped
 *    account, cards included, transfer-named categories and dismissed rows
 *    left out exactly as that headline leaves them out — over the last full
 *    months (up to three), less those months' charges of the counted bills so
 *    a bill is never subtracted twice, per calendar day, never below $0.
 */
import { failedForecast, type CashForecast, type ForecastAccount } from './cash-forecast.js';
import { expandBills, forecastBills, forecastCash, FORECAST_DAYS } from './forecast.js';
import { monthlyIncomeTotals, monthlySpendTotals, type ReportCube } from './report-cube.js';
import { detectionKeys, subscriptionKey, type DetectedSubscription } from './subscriptions.js';
import type { ManualSubscription } from './subscription-prefs.js';
import { manualKey, type Roster, type RosterEntry } from './subscription-roster.js';
import { descriptionFromComment } from './sync-core.js';

/** A Wealthfolio account as `GET /accounts` returns it. */
export interface WealthfolioAccountLike {
  id: string;
  name?: string;
  accountType?: string;
  isArchived?: boolean;
  isActive?: boolean;
}

export interface CashTodayInput {
  /** account_mapping: SimpleFin id → Wealthfolio id. */
  mapping: Record<string, string>;
  /** account_balances: the sync's snapshot, `balance` in dollars, `date` in Unix seconds. */
  balances: Record<string, { balance?: unknown; date?: unknown } | null | undefined>;
  /** account_names: SimpleFin id → the bank's name for it. */
  names: Record<string, string>;
  accounts: readonly WealthfolioAccountLike[];
}

export interface CashToday {
  cashCents: number;
  /** Counted, by name. */
  accounts: ForecastAccount[];
  /** CASH accounts with no numeric balance from the bank, by name. */
  missing: string[];
}

const own = (rec: object, key: string): boolean => Object.prototype.hasOwnProperty.call(rec, key);

export function cashToday(input: CashTodayInput): CashToday {
  const byId = new Map(input.accounts.map((a) => [a.id, a] as const));
  const accounts: ForecastAccount[] = [];
  const missing: string[] = [];
  for (const [sfinId, wfId] of Object.entries(input.mapping)) {
    const account = wfId ? byId.get(wfId) : undefined;
    if (!account || (account.accountType ?? '').trim().toUpperCase() !== 'CASH') continue;
    if (account.isArchived === true || account.isActive === false) continue;
    const name = (own(input.names, sfinId) && input.names[sfinId]) || account.name || sfinId;
    const b = own(input.balances, sfinId) ? input.balances[sfinId] : undefined;
    const balance = b && typeof b.balance === 'number' && Number.isFinite(b.balance) ? b.balance : null;
    // The bank's date is Unix seconds. Absent, zero, negative or off the
    // calendar means the date is UNKNOWN (asOf null) — the balance still counts.
    const date = b && typeof b.date === 'number' && Number.isFinite(b.date) && b.date > 0 ? b.date : null;
    // Every number handed on is finite: a balance too large to hold in cents
    // is a balance the bank didn't send.
    const cents = balance === null ? NaN : Math.round(balance * 100);
    const asOf = date === null || !Number.isFinite(new Date(date * 1000).getTime()) ? null : new Date(date * 1000).toISOString().slice(0, 10);
    if (!Number.isFinite(cents)) {
      missing.push(name);
      continue;
    }
    accounts.push({ name, cents, asOf });
  }
  accounts.sort((a, b) => a.name.localeCompare(b.name));
  missing.sort((a, b) => a.localeCompare(b));
  const cashCents = accounts.reduce((sum, a) => sum + a.cents, 0);
  // Several huge balances can still overflow the sum: leave the lot out, named.
  if (!Number.isFinite(cashCents)) return { cashCents: 0, accounts: [], missing: [...missing, ...accounts.map((a) => a.name)].sort((a, b) => a.localeCompare(b)) };
  return { cashCents, accounts, missing };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const shift = (month: string, n: number): string => {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
};
const daysInMonth = (month: string): number => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/**
 * The full months (up to three, oldest first) before `currentMonth` — today's
 * month in Wealthfolio's zone — that the cube has history for. The month the
 * history starts in is partial (the first import rarely starts on the 1st)
 * unless it is the cube's first month, whose history the cube trimmed.
 * Empty when there is no full month yet.
 */
export function historyMonths(cube: ReportCube, currentMonth: string): string[] {
  const spend = monthlySpendTotals(cube);
  const income = monthlyIncomeTotals(cube);
  const first = cube.months.findIndex((_, i) => spend[i] !== 0 || income[i] !== 0);
  if (first === -1) return [];
  const firstFull = first === 0 ? 0 : first + 1;
  const out: string[] = [];
  for (let back = 1; back <= 3; back += 1) {
    const month = shift(currentMonth, -back);
    const i = cube.months.indexOf(month);
    if (i < firstFull) break;
    out.unshift(month);
  }
  return out;
}

/** The date range `getNativeMerchantRows` takes for `months` (contiguous, oldest first). */
export function historyWindow(months: readonly string[]): { startInclusive: string; endExclusive: string } {
  return { startInclusive: `${months[0]}-01`, endExclusive: `${shift(months[months.length - 1], 1)}-01` };
}

/** One spending row as `getNativeMerchantRows` reads it: the stored note verbatim, dollars. */
export interface MerchantRow { month: string; notes: string; amount: number }

/** The name the subscription detector groups a row under (shared/subscriptions.ts):
 *  the note's description, trimmed to its rule pattern. '' for a row with none. */
export function detectorKey(notes: string): string {
  const name = descriptionFromComment(notes);
  return name ? subscriptionKey(name) : '';
}

/** The detector keys whose charges are the counted bills': a detected entry's
 *  own key, a hand-added entry's linked merchant. A hand-added entry with no
 *  link has no charges anyone can tell apart, so they stay in daily spending.
 *
 *  `detected` (cube.subscriptions) adds every key joined into an entry (F1):
 *  Google renamed its charge to `GOOGLE *G1AI101M …` on Oct 6, the detector
 *  joined it under the old name, and the rows below still carry each charge's
 *  own key — so the renamed charge stayed in daily spending while the bill was
 *  also scheduled, about $21 a month counted twice. */
export function billKeys(
  entries: readonly RosterEntry[],
  manual: readonly ManualSubscription[],
  detected?: readonly DetectedSubscription[] | null,
): Set<string> {
  const merchantOf = new Map(manual.map((m) => [manualKey(m.id), m.merchant] as const));
  const keysOf = new Map<string, string[]>();
  for (const d of detected ?? []) {
    const all = detectionKeys(d);
    for (const k of all) keysOf.set(k, all);
  }
  const keys = new Set<string>();
  const add = (key: string) => { for (const k of keysOf.get(key) ?? [key]) keys.add(k); };
  for (const e of entries) {
    if (e.source === 'detected') add(e.key);
    else if (e.source === 'manual') {
      const merchant = merchantOf.get(e.key);
      // A link saved before 1.63 keeps the bank's reference; today's key drops it.
      if (merchant) add(subscriptionKey(merchant));
    }
  }
  return keys;
}

/** What the counted bills charged in `months` (refunds subtract), in cents. */
export function billChargesCents(rows: readonly MerchantRow[], keys: ReadonlySet<string>, months: readonly string[]): number {
  if (keys.size === 0) return 0;
  const wanted = new Set(months);
  let cents = 0;
  for (const r of rows) {
    if (!wanted.has(r.month)) continue;
    const key = detectorKey(r.notes);
    if (key && keys.has(key)) cents += Math.round(r.amount * 100);
  }
  return cents;
}

/** (The months' spending − the bills' charges) ÷ the months' calendar days, never below 0. */
export function dailySpendCents(cube: ReportCube, months: readonly string[], billCents: number): number {
  if (months.length === 0) return 0;
  const spend = monthlySpendTotals(cube);
  let total = 0;
  let days = 0;
  for (const month of months) {
    const i = cube.months.indexOf(month);
    if (i >= 0) total += spend[i];
    days += daysInMonth(month);
  }
  return Math.max(0, Math.round((total - billCents) / days));
}

export interface ForecastBuildInput {
  now: Date;
  /** Today in Wealthfolio's zone (zonedDay). */
  today: string;
  cash: CashToday;
  roster: Roster;
  /** The subscription document's hand-added entries, for their linked merchants. */
  manual: readonly ManualSubscription[];
  cube: ReportCube;
  /** historyMonths(cube, today's month). */
  months: readonly string[];
  /** getNativeMerchantRows over historyWindow(months). */
  merchantRows: readonly MerchantRow[];
  days?: number;
}

/** The `cash_forecast` value: the forecast, or why there is none. */
export function buildCashForecast(input: ForecastBuildInput): CashForecast {
  const { now, today, cash, cube, months } = input;
  const days = input.days ?? FORECAST_DAYS;
  if (cash.accounts.length === 0) return failedForecast(cash.missing.length > 0 ? 'noBalance' : 'noCash', now);
  if (months.length === 0) return failedForecast('noHistory', now);
  // A number that is not finite is a read that failed, never a forecast.
  if (!Number.isFinite(cash.cashCents) || cash.accounts.some((a) => !Number.isFinite(a.cents))) return failedForecast('balances', now);
  const entries = forecastBills(input.roster);
  if (entries.some((e) => e.nextDate !== null && !Number.isFinite(e.cents))) return failedForecast('bills', now);
  const billCents = billChargesCents(input.merchantRows, billKeys(entries, input.manual, cube.subscriptions), months);
  const daily = dailySpendCents(cube, months, billCents);
  if (!Number.isFinite(billCents) || !Number.isFinite(daily)) return failedForecast('history', now);
  const bills = expandBills(entries, today, days);
  const p = forecastCash({ cashCents: cash.cashCents, today, bills, dailySpendCents: daily, days });
  return {
    v: 1,
    at: now.toISOString(),
    ok: true,
    cashCents: cash.cashCents,
    lowCents: p.lowCents,
    lowDate: p.lowDate,
    ...(p.shortDate ? { shortDate: p.shortDate } : {}),
    days,
    basedOnMonths: months.length,
    dailySpendCents: daily,
    accounts: cash.accounts,
    bills,
    ...(cash.missing.length > 0 ? { missing: cash.missing } : {}),
  };
}
