/**
 * shared/forecast.ts
 *
 * The 30-day cash forecast's arithmetic (project 5 R1, spec A; rulings N1–N2):
 * cash today, minus each known bill on its date, minus a typical day of other
 * spending for every day after today. It assumes NO income — nothing in the
 * add-on detects paychecks — so what it says is "if nothing comes in", never a
 * promise. Pure: shared/forecast-inputs.ts gathers what goes in, and
 * shared/cash-forecast.ts is the published result and its words.
 *
 * Dates are YYYY-MM-DD strings, computed in UTC like the roster's, so a host's
 * zone can never shift a day; `today` is the caller's (Wealthfolio's) day.
 */
import { CASH_CARD_PAYMENT_KEYWORDS } from './mapper.js';
import { addDaysIso, addPeriod, localIsoDay, type Roster, type RosterEntry } from './subscription-roster.js';

/** How far the forecast looks: today, then 30 more days. */
export const FORECAST_DAYS = 30;

/** One bill charge inside the window. `name` is RAW bank or user text. */
export interface ForecastCharge { name: string; date: string; cents: number }

export interface CashProjection {
  /** The balance at the end of each day, today first: `days + 1` points. */
  series: Array<{ date: string; cents: number }>;
  /** The lowest balance, and the FIRST day it is reached. */
  lowCents: number;
  lowDate: string;
  /** The first day the balance is below $0, or null. */
  shortDate: string | null;
}

/**
 * The roster entries the forecast subtracts: subscriptions and bills with a
 * next date. Not maybes (unconfirmed), not hidden (`buildRoster` keeps them
 * out of both lists), not overdue or watched (`nextDate` is null: no date is
 * known). Not a card payment either: those are transfers, and card spending
 * reaches cash only through them, which the daily spending already stands in
 * for. A payment Wealthfolio linked is never a merchant row; one that never
 * linked (expired into a withdrawal) can be detected, so an entry whose bank
 * or given name reads like one — the sync's own CASH_CARD_PAYMENT_KEYWORDS —
 * is left out.
 */
export function forecastBills(roster: Pick<Roster, 'subscriptions' | 'bills'>): RosterEntry[] {
  return [...roster.subscriptions, ...roster.bills]
    .filter((e) => e.nextDate !== null && !isCardPayment(e));
}

function isCardPayment(e: RosterEntry): boolean {
  return [e.key, e.bankName ?? '', e.displayName].some((text) => CASH_CARD_PAYMENT_KEYWORDS.test(text));
}

/**
 * Every charge of `entries` from `today` through `today + days`, date order.
 * Each entry's later dates are `addPeriod(nextDate, cadence, n)` — counted
 * from its next date, so a 31st stays the 31st wherever a month has one
 * (Oct 31 → Nov 30 → Dec 31). A LATE entry (its date passed inside the
 * roster's grace, not charged yet) has not left the account: it is subtracted
 * today. An entry with no price subtracts nothing.
 */
export function expandBills(entries: readonly RosterEntry[], today: string, days: number): ForecastCharge[] {
  const end = addDaysIso(today, days);
  const out: ForecastCharge[] = [];
  for (const e of entries) {
    if (e.nextDate === null || !(e.cents > 0)) continue;
    for (let n = 0; ; n += 1) {
      const due = addPeriod(e.nextDate, e.cadence, n);
      if (due > end) break;
      if (due < today) {
        if (n === 0) out.push({ name: e.displayName, date: today, cents: e.cents });
        continue;
      }
      out.push({ name: e.displayName, date: due, cents: e.cents });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name) || b.cents - a.cents);
}

/**
 * The balance at the end of each day: `cashCents` today, less every bill
 * dated on or before that day, less `dailySpendCents` for each day after
 * today (today's spending is already in the bank's balance). A negative daily
 * figure counts as none. With no income the series never rises, so the low
 * point is where it ends — or the day of the last bill when nothing else is
 * spent.
 */
export function forecastCash(input: {
  cashCents: number; today: string; bills: readonly ForecastCharge[]; dailySpendCents: number; days: number;
}): CashProjection {
  const { cashCents, today, bills, days } = input;
  const daily = Math.max(0, Math.round(input.dailySpendCents));
  const series: CashProjection['series'] = [];
  let lowCents = Number.POSITIVE_INFINITY;
  let lowDate = today;
  let shortDate: string | null = null;
  for (let i = 0; i <= days; i += 1) {
    const date = addDaysIso(today, i);
    const billed = bills.reduce((sum, b) => (b.date <= date ? sum + b.cents : sum), 0);
    const cents = cashCents - daily * i - billed;
    series.push({ date, cents });
    if (cents < lowCents) {
      lowCents = cents;
      lowDate = date;
    }
    if (shortDate === null && cents < 0) shortDate = date;
  }
  return { series, lowCents, lowDate, shortDate };
}

/**
 * The calendar day `now` falls on in `timeZone` — Wealthfolio's own setting,
 * the zone its month boundaries use. Null, or a zone the runtime does not
 * know, uses the process's own zone (the companion's `TZ`), the same fallback
 * as `zonedMonthBounds` in shared/audit-headline.ts.
 */
export function zonedDay(now: Date, timeZone: string | null): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(now);
      const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day}`;
    } catch {
      /* an unknown zone: the process's own, below */
    }
  }
  return localIsoDay(now);
}
