import { describe, it, expect } from 'vitest';
import { expandBills, forecastBills, forecastCash, zonedDay, FORECAST_DAYS } from './forecast';
import { localIsoDay, type Roster, type RosterEntry } from './subscription-roster';

const entry = (over: Partial<RosterEntry> = {}): RosterEntry => ({
  key: 'NETFLIX', displayName: 'Netflix', group: 'subscription', source: 'detected', cents: 1549,
  cadence: 'monthly', nextDate: '2026-10-20', recent: [], handle: 'h0000000', ...over,
});
const roster = (over: Partial<Roster> = {}): Roster => ({
  subscriptions: [], bills: [], maybes: [], hidden: [], monthlyCents: 0, yearlyCents: 0, billsMonthlyCents: 0,
  linkSuggestions: [], detectionAvailable: true, ...over,
});
const RENT = entry({ key: 'RENT LLC', displayName: 'Rent', group: 'bill', cents: 120000, nextDate: '2026-11-01' });

describe('forecastBills', () => {
  it('counts subscriptions and bills with a date — not maybes, hidden, overdue or watched', () => {
    const r = roster({
      subscriptions: [
        entry(),
        entry({ key: 'ADOBE', displayName: 'Adobe', nextDate: null, overdueSince: '2026-10-01' }),
        entry({ key: 'GYM', displayName: 'Gym', source: 'watched', nextDate: null }),
      ],
      bills: [RENT],
      maybes: [entry({ key: 'MYSTERY', displayName: 'Mystery', group: 'maybe', nextDate: '2026-10-18' })],
      hidden: [entry({ key: 'HULU', displayName: 'Hulu', nextDate: '2026-10-19' })],
    });
    expect(forecastBills(r).map((e) => e.key)).toEqual(['NETFLIX', 'RENT LLC']);
  });

  it('leaves out a card payment, which daily spending already stands in for', () => {
    const r = roster({
      subscriptions: [
        entry({ key: 'ONLINE CREDIT CARD PAYMENT', displayName: 'Card', nextDate: '2026-10-21' }),
        entry({ key: 'm:abc12345', source: 'manual', displayName: 'Discover card payment', nextDate: '2026-10-22' }),
        entry(),
      ],
    });
    expect(forecastBills(r).map((e) => e.key)).toEqual(['NETFLIX']);
  });
});

describe('expandBills', () => {
  it('lists each bill on its date, in date order, through the 30th day and not past it', () => {
    const lastDay = entry({ key: 'GYM', displayName: 'Gym', cents: 3000, nextDate: '2026-11-13' });
    const after = entry({ key: 'ISP', displayName: 'Internet', cents: 6000, nextDate: '2026-11-14' });
    expect(expandBills([RENT, after, lastDay, entry()], '2026-10-14', FORECAST_DAYS)).toEqual([
      { name: 'Netflix', date: '2026-10-20', cents: 1549 },
      { name: 'Rent', date: '2026-11-01', cents: 120000 },
      { name: 'Gym', date: '2026-11-13', cents: 3000 },
    ]);
  });

  it('repeats a monthly bill due twice in the window — the 31st lands on the 30th of a 30-day month', () => {
    expect(expandBills([entry({ nextDate: '2026-10-31' })], '2026-10-31', FORECAST_DAYS)).toEqual([
      { name: 'Netflix', date: '2026-10-31', cents: 1549 },
      { name: 'Netflix', date: '2026-11-30', cents: 1549 },
    ]);
  });

  it('repeats a monthly bill inside a short February', () => {
    expect(expandBills([entry({ nextDate: '2027-02-01' })], '2027-02-01', FORECAST_DAYS).map((c) => c.date))
      .toEqual(['2027-02-01', '2027-03-01']);
  });

  it('crosses a year boundary', () => {
    const jan = entry({ key: 'ISP', displayName: 'Internet', cents: 6000, nextDate: '2027-01-05' });
    expect(expandBills([jan, entry({ nextDate: '2026-12-31' })], '2026-12-20', FORECAST_DAYS)).toEqual([
      { name: 'Netflix', date: '2026-12-31', cents: 1549 },
      { name: 'Internet', date: '2027-01-05', cents: 6000 },
    ]);
  });

  it('charges a yearly bill once', () => {
    expect(expandBills([entry({ cadence: 'yearly', cents: 9900, nextDate: '2026-10-30' })], '2026-10-14', FORECAST_DAYS))
      .toEqual([{ name: 'Netflix', date: '2026-10-30', cents: 9900 }]);
  });

  it('subtracts a late charge today, then its next date', () => {
    expect(expandBills([entry({ nextDate: '2026-10-28', late: true })], '2026-10-31', FORECAST_DAYS).map((c) => c.date))
      .toEqual(['2026-10-31', '2026-11-28']);
  });

  it('subtracts nothing for an entry with no price', () => {
    expect(expandBills([entry({ cents: 0 })], '2026-10-14', FORECAST_DAYS)).toEqual([]);
  });
});

describe('forecastCash', () => {
  const BILLS = [
    { name: 'Netflix', date: '2026-10-20', cents: 1549 },
    { name: 'Rent', date: '2026-11-01', cents: 120000 },
  ];

  it('is cash today, less each bill on its date and a day of spending for each day after today', () => {
    const f = forecastCash({ cashCents: 300000, today: '2026-10-14', bills: BILLS, dailySpendCents: 4000, days: FORECAST_DAYS });
    expect(f.series).toHaveLength(31);
    expect(f.series[0]).toEqual({ date: '2026-10-14', cents: 300000 });
    expect(f.series[6]).toEqual({ date: '2026-10-20', cents: 274451 });
    expect(f.series[30]).toEqual({ date: '2026-11-13', cents: 58451 });
    expect(f.lowCents).toBe(58451);
    expect(f.lowDate).toBe('2026-11-13');
    expect(f.shortDate).toBeNull();
  });

  it('names the first day the balance goes below $0', () => {
    const f = forecastCash({
      cashCents: 50000, today: '2026-10-14', bills: [{ name: 'Rent', date: '2026-10-20', cents: 60000 }], dailySpendCents: 2000, days: FORECAST_DAYS,
    });
    expect(f.series[5]).toEqual({ date: '2026-10-19', cents: 40000 });
    expect(f.shortDate).toBe('2026-10-20');
    expect(f.lowCents).toBe(-70000);
    expect(f.lowDate).toBe('2026-11-13');
  });

  it('is short today when cash is already below $0', () => {
    const f = forecastCash({ cashCents: -1000, today: '2026-10-14', bills: [], dailySpendCents: 0, days: FORECAST_DAYS });
    expect(f.shortDate).toBe('2026-10-14');
    expect(f.lowCents).toBe(-1000);
    expect(f.lowDate).toBe('2026-10-14');
  });

  it('is short today when a bill due today takes it below $0', () => {
    const f = forecastCash({
      cashCents: 1000, today: '2026-10-14', bills: [{ name: 'Gym', date: '2026-10-14', cents: 1500 }], dailySpendCents: 0, days: FORECAST_DAYS,
    });
    expect(f.series[0].cents).toBe(-500);
    expect(f.shortDate).toBe('2026-10-14');
  });

  it('bills only, with daily spending at 0: the low point is the day of the last bill', () => {
    const f = forecastCash({ cashCents: 200000, today: '2026-10-14', bills: BILLS, dailySpendCents: 0, days: FORECAST_DAYS });
    expect(f.lowCents).toBe(78451);
    expect(f.lowDate).toBe('2026-11-01');
    expect(f.series[30].cents).toBe(78451);
    expect(f.shortDate).toBeNull();
  });

  it('with no bills and nothing spent, the low point is today', () => {
    const f = forecastCash({ cashCents: 5000, today: '2026-10-14', bills: [], dailySpendCents: -500, days: FORECAST_DAYS });
    expect(f.series.every((p) => p.cents === 5000)).toBe(true);
    expect(f.lowCents).toBe(5000);
    expect(f.lowDate).toBe('2026-10-14');
  });
});

describe('zonedDay', () => {
  it("is the day in Wealthfolio's timezone", () => {
    expect(zonedDay(new Date('2026-11-01T02:00:00Z'), 'America/New_York')).toBe('2026-10-31');
    expect(zonedDay(new Date('2026-10-31T23:30:00Z'), 'Europe/Berlin')).toBe('2026-11-01');
  });

  it("falls back to the process's own day with no zone, or one the runtime does not know", () => {
    const d = new Date(2026, 9, 14, 12, 0);
    expect(zonedDay(d, null)).toBe(localIsoDay(d));
    expect(zonedDay(d, 'Mars/Olympus_Mons')).toBe(localIsoDay(d));
  });
});
