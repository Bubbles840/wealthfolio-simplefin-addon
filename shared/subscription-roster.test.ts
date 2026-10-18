import { describe, it, expect } from 'vitest';
import {
  addDaysIso, addMonthsClamped, addPeriod, addYearsClamped, daysBetween, isManualKey, localIsoDay, manualKey,
  rollForward, normalizeDeclinedLink, normalizeRosterKey,
  aboutDollars, buildRoster, dueWithin, formatRosterTotal, monthDay, rosterAmount, rosterMoney, rosterPrice,
  rosterWhen, type RosterInput,
} from './subscription-roster.js';
import { findingHandle } from './handle.js';
import { emptySubscriptionPrefs, type SubscriptionPrefs } from './subscription-prefs.js';
import type { DetectedSubscription } from './subscriptions.js';

describe('addMonthsClamped', () => {
  it.each([
    ['2026-01-15', 1, '2026-02-15'],
    ['2026-01-31', 1, '2026-02-28'],
    ['2028-01-31', 1, '2028-02-29'],
    ['2026-03-31', 1, '2026-04-30'],
    ['2026-12-31', 1, '2027-01-31'],
    ['2026-01-31', 2, '2026-03-31'],
    ['2026-03-15', -3, '2025-12-15'],
    ['2026-03-31', -1, '2026-02-28'],
  ] as const)('%s plus %i months is %s', (iso, n, want) => {
    expect(addMonthsClamped(iso, n)).toBe(want);
  });
});

describe('addYearsClamped', () => {
  it.each([
    ['2028-02-29', 1, '2029-02-28'],
    ['2028-02-29', 4, '2032-02-29'],
    ['2026-10-20', -1, '2025-10-20'],
  ] as const)('%s plus %i years is %s', (iso, n, want) => {
    expect(addYearsClamped(iso, n)).toBe(want);
  });
});

describe('addDaysIso / daysBetween / addPeriod', () => {
  it('adds days across month and year ends', () => {
    expect(addDaysIso('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('counts whole days either way, unaffected by daylight saving', () => {
    expect(daysBetween('2026-10-03', '2026-10-12')).toBe(9);
    expect(daysBetween('2026-10-12', '2026-10-03')).toBe(-9);
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-10-12', '2026-10-12')).toBe(0);
  });

  it('steps by the cadence', () => {
    expect(addPeriod('2026-10-08', 'monthly')).toBe('2026-11-08');
    expect(addPeriod('2026-10-08', 'yearly')).toBe('2027-10-08');
    expect(addPeriod('2026-10-08', 'monthly', -1)).toBe('2026-09-08');
  });
});

describe('rollForward', () => {
  it('keeps a date that is today or later', () => {
    expect(rollForward('2026-10-12', 'monthly', '2026-10-12')).toBe('2026-10-12');
    expect(rollForward('2026-12-01', 'yearly', '2026-10-12')).toBe('2026-12-01');
  });

  it('rolls a past date by months or by years', () => {
    expect(rollForward('2026-10-03', 'monthly', '2026-10-12')).toBe('2026-11-03');
    expect(rollForward('2025-03-03', 'yearly', '2026-10-12')).toBe('2027-03-03');
  });

  it('counts from the anchor, so a 31st comes back after a short month', () => {
    expect(rollForward('2026-01-31', 'monthly', '2026-03-05')).toBe('2026-03-31');
  });

  it('lands a Feb 29 anchor on Feb 28 in a year without one', () => {
    expect(rollForward('2024-02-29', 'yearly', '2026-10-12')).toBe('2027-02-28');
  });

  it('returns to Feb 29 in the next leap year', () => {
    expect(rollForward('2024-02-29', 'yearly', '2028-01-01')).toBe('2028-02-29');
  });
});

describe('localIsoDay / manual keys', () => {
  it('reads the local calendar day', () => {
    expect(localIsoDay(new Date(2026, 9, 12, 23, 59))).toBe('2026-10-12');
    expect(localIsoDay(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05');
  });

  it('keys a hand-added entry as m:<id>', () => {
    expect(manualKey('ab12cd34')).toBe('m:ab12cd34');
    expect(isManualKey('m:ab12cd34')).toBe(true);
    expect(isManualKey('SPOTIFY')).toBe(false);
  });
});

const TODAY = '2026-10-12';
/** DetectedSubscription exactly as a 1.60 companion publishes it in the cube. */
const det = (name: string, over: Partial<DetectedSubscription> = {}): DetectedSubscription => {
  const lastDate = over.lastDate ?? '2026-09-15';
  const lastCents = over.lastCents ?? over.monthlyCents ?? 1199;
  return {
    name, monthlyCents: 1199, count: 4, lastDate, lastCents, prevCents: lastCents, creep: false, kind: 'subscription',
    recent: [{ date: lastDate, cents: lastCents }], ...over,
  };
};
const prefsWith = (over: Partial<SubscriptionPrefs> = {}): SubscriptionPrefs => ({ ...emptySubscriptionPrefs(), ...over });
const roster = (over: Partial<RosterInput> = {}) =>
  buildRoster({ detected: [], merchants: [[], []], links: [], prefs: prefsWith(), today: TODAY, ...over });
const names = (list: Array<{ displayName: string }>) => list.map((e) => e.displayName);

describe('buildRoster — groups', () => {
  it('sorts detections into subscriptions, bills and maybes; a kindless row is a subscription', () => {
    const r = roster({ detected: [
      det('SPOTIFY'),
      det('LG&E', { kind: 'bill', monthlyCents: 6149 }),
      det('MYSTERY BOX', { kind: 'possible', monthlyCents: 1500, count: 2 }),
      det('OLD CUBE ROW', { kind: undefined, monthlyCents: 499 }),
    ] });
    expect(names(r.subscriptions)).toEqual(['SPOTIFY', 'OLD CUBE ROW']);
    expect(names(r.bills)).toEqual(['LG&E']);
    expect(names(r.maybes)).toEqual(['MYSTERY BOX']);
    expect(r.detectionAvailable).toBe(true);
  });

  it('a confirmed bill or maybe counts as a subscription', () => {
    const r = roster({
      detected: [det('RENT LLC', { kind: 'bill', monthlyCents: 90000 }), det('MYSTERY BOX', { kind: 'possible' })],
      prefs: prefsWith({ confirmed: ['RENT LLC', 'MYSTERY BOX'] }),
    });
    expect(names(r.subscriptions)).toEqual(['RENT LLC', 'MYSTERY BOX']);
    expect(r.bills).toEqual([]);
    expect(r.maybes).toEqual([]);
  });

  it('hidden entries leave their group and every total', () => {
    const r = roster({
      detected: [det('SPOTIFY'), det('QR LIBRARY', { monthlyCents: 499 }), det('LG&E', { kind: 'bill', monthlyCents: 6149 })],
      prefs: prefsWith({ hidden: ['QR LIBRARY', 'LG&E'] }),
    });
    expect(names(r.subscriptions)).toEqual(['SPOTIFY']);
    expect(names(r.hidden)).toEqual(['LG&E', 'QR LIBRARY']);
    expect(r.monthlyCents).toBe(1199);
    expect(r.billsMonthlyCents).toBe(0);
  });

  it('shows a rename, keeping the bank name beside it', () => {
    const r = roster({ detected: [det('SPOTIFY')], prefs: prefsWith({ names: { SPOTIFY: 'Spotify' } }) });
    expect(r.subscriptions[0]).toMatchObject({ key: 'SPOTIFY', displayName: 'Spotify', bankName: 'SPOTIFY' });
    expect(roster({ detected: [det('SPOTIFY')] }).subscriptions[0].bankName).toBeUndefined();
  });

  it('a bank name that is an Object.prototype key is an ordinary name', () => {
    const r = roster({ detected: [det('constructor')], prefs: prefsWith({ names: {}, remind: {} }) });
    expect(r.subscriptions[0]).toMatchObject({ displayName: 'constructor' });
    expect(r.subscriptions[0].remind).toBeUndefined();
  });

  it('prices a watched name from its newest month among the last three', () => {
    const r = roster({
      merchants: [
        [{ name: 'ANTHROPIC* CLAUDE SUB', cents: 1800, count: 1 }],
        [{ name: 'ANTHROPIC* CLAUDE SUB', cents: 2000, count: 1 }],
        [],
      ],
      prefs: prefsWith({ confirmed: ['ANTHROPIC* CLAUDE SUB', 'NEVER SEEN'] }),
    });
    expect(r.subscriptions.map((e) => [e.displayName, e.source, e.cents, e.nextDate])).toEqual([
      ['ANTHROPIC* CLAUDE SUB', 'watched', 2000, null],
      ['NEVER SEEN', 'watched', 0, null],
    ]);
    expect(rosterAmount(r.subscriptions[1])).toBe('no price yet');
    expect(rosterWhen(r.subscriptions[0])).toBe('watching');
  });
});

describe('buildRoster — next charge date', () => {
  it('is the last charge plus a month', () => {
    expect(roster({ detected: [det('SPOTIFY', { lastDate: '2026-09-15' })] }).subscriptions[0].nextDate).toBe('2026-10-15');
  });

  // Review Focus: a charge on the 31st.
  it('clamps a 31st to the month end, Feb 29 included', () => {
    expect(roster({ today: '2026-02-10', detected: [det('GYM', { lastDate: '2026-01-31' })] }).subscriptions[0].nextDate).toBe('2026-02-28');
    expect(roster({ today: '2028-02-10', detected: [det('GYM', { lastDate: '2028-01-31' })] }).subscriptions[0].nextDate).toBe('2028-02-29');
    expect(roster({ today: '2026-04-01', detected: [det('GYM', { lastDate: '2026-03-31' })] }).subscriptions[0].nextDate).toBe('2026-04-30');
  });

  // Review Focus: a charge on the 31st.
  it('a hand-added 31st comes back as the 31st after a short month', () => {
    const r = roster({
      today: '2026-03-05',
      prefs: prefsWith({ manual: [{ id: 'gym00001', name: 'Gym', cents: 4000, cadence: 'monthly', nextDate: '2026-01-31' }] }),
    });
    expect(r.subscriptions[0].nextDate).toBe('2026-03-31');
  });

  it('up to 7 days past: still listed, marked late', () => {
    expect(roster({ detected: [det('SPOTIFY', { lastDate: '2026-09-08' })] }).subscriptions[0]).toMatchObject({ nextDate: '2026-10-08', late: true });
    expect(roster({ detected: [det('SPOTIFY', { lastDate: '2026-09-05' })] }).subscriptions[0]).toMatchObject({ nextDate: '2026-10-05', late: true });
  });

  it('more than 7 days past: no next date, overdue since the missed one', () => {
    const e = roster({ detected: [det('NETFLIX', { lastDate: '2026-09-03' })] }).subscriptions[0];
    expect(e.nextDate).toBeNull();
    expect(e.overdueSince).toBe('2026-10-03');
    expect(e.late).toBeUndefined();
    expect(rosterWhen(e)).toBe("expected Oct 3, hasn't charged");
  });

  it('a hand-added entry rolls forward by its cadence and is never late or overdue', () => {
    const r = roster({ prefs: prefsWith({ manual: [
      { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-03' },
      { id: 'dom00001', name: 'Domain', cents: 1500, cadence: 'yearly', nextDate: '2025-03-03' },
    ] }) });
    expect(r.subscriptions.map((e) => [e.key, e.nextDate, e.late ?? false, e.overdueSince ?? null])).toEqual([
      ['m:hulu0001', '2026-11-03', false, null],
      ['m:dom00001', '2027-03-03', false, null],
    ]);
  });
});

describe('buildRoster — what detection adds', () => {
  it('a price rise shows the new price, the old one kept for the creep line', () => {
    const e = roster({ detected: [det('NETFLIX', { monthlyCents: 1549, lastCents: 1799, creep: true, lastDate: '2026-10-10' })] }).subscriptions[0];
    expect(e.cents).toBe(1799);
    expect(e.creep).toEqual({ fromCents: 1549, toCents: 1799, chargedOn: '2026-10-10' });
  });

  it('lists the newest three charges, falling back to the last charge on older cubes', () => {
    const recent = [{ date: '2026-09-15', cents: 1199 }, { date: '2026-08-15', cents: 1199 }, { date: '2026-07-15', cents: 1099 }];
    expect(roster({ detected: [det('SPOTIFY', { recent })] }).subscriptions[0].recent).toEqual(recent);
    expect(roster({ detected: [det('SPOTIFY', { recent: undefined, lastDate: '2026-09-15', lastCents: 1199 })] }).subscriptions[0].recent)
      .toEqual([{ date: '2026-09-15', cents: 1199 }]);
  });

  it('hands each entry the short hash of its key for button data, and its reminder', () => {
    const e = roster({ detected: [det('SPOTIFY')], prefs: prefsWith({ remind: { SPOTIFY: 3 } }) }).subscriptions[0];
    expect(e.handle).toBe(findingHandle('SPOTIFY'));
    expect(e.remind).toBe(3);
  });
});

describe('buildRoster — hand-added and linked', () => {
  const HULU = { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly' as const, nextDate: '2026-11-08', merchant: 'HULU' };

  it("a linked entry absorbs its detection into ONE row: its own name, key and reminder; detection's dates and price", () => {
    const r = roster({
      detected: [det('HULU', { monthlyCents: 1099, lastDate: '2026-10-08' }), det('SPOTIFY')],
      prefs: prefsWith({ manual: [HULU], remind: { 'm:hulu0001': 1 } }),
    });
    expect(names(r.subscriptions)).toEqual(['SPOTIFY', 'Hulu']);
    expect(r.subscriptions[1]).toMatchObject({
      key: 'm:hulu0001', source: 'manual', bankName: 'HULU', cents: 1099, nextDate: '2026-11-08', remind: 1,
      handle: findingHandle('m:hulu0001'),
    });
  });

  it('linked but not detected yet: the next date written at link time, rolled', () => {
    expect(roster({ today: '2026-11-20', prefs: prefsWith({ manual: [HULU] }) }).subscriptions[0])
      .toMatchObject({ key: 'm:hulu0001', nextDate: '2026-12-08', cents: 999, recent: [] });
  });

  it("offers the cube's link suggestions minus declined, linked, unknown and malformed ones", () => {
    const r = roster({
      prefs: prefsWith({
        manual: [
          { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' },
          { id: 'disn0001', name: 'Disney', cents: 1399, cadence: 'monthly', nextDate: '2026-10-21' },
          { id: 'linked01', name: 'Max', cents: 1699, cadence: 'monthly', nextDate: '2026-10-25', merchant: 'MAX.COM' },
        ],
        names: { 'm:hulu0001': 'Hulu (family)' },
        declinedLinks: ['disn0001|DISNEY PLUS'],
      }),
      links: [
        { manualId: 'hulu0001', merchant: 'HULU', date: '2026-09-19', cents: 999 },
        { manualId: 'disn0001', merchant: 'DISNEY PLUS', date: '2026-09-21', cents: 1399 },
        { manualId: 'linked01', merchant: 'MAX.COM', date: '2026-09-25', cents: 1699 },
        { manualId: 'gone0001', merchant: 'PEACOCK', date: '2026-09-25', cents: 799 },
        { manualId: 'hulu0001', merchant: 42 },
        'garbage',
      ],
    });
    expect(r.linkSuggestions).toEqual([
      { manualId: 'hulu0001', manualName: 'Hulu (family)', merchant: 'HULU', date: '2026-09-19', cents: 999 },
    ]);
  });
});

describe('buildRoster — totals', () => {
  it('monthly and yearly subscriptions total apart; bills have their own', () => {
    const r = roster({
      detected: [
        det('SPOTIFY'),
        det('NETFLIX', { monthlyCents: 1549, lastCents: 1799, creep: true, lastDate: '2026-09-22' }),
        det('LG&E', { kind: 'bill', monthlyCents: 6149, lastDate: '2026-09-28' }),
      ],
      prefs: prefsWith({ manual: [
        { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' },
        { id: 'dom00001', name: 'Domain', cents: 9900, cadence: 'yearly', nextDate: '2027-03-03' },
      ] }),
    });
    expect(r.monthlyCents).toBe(1199 + 1799 + 999);
    expect(r.yearlyCents).toBe(9900);
    expect(r.billsMonthlyCents).toBe(6149);
    expect(formatRosterTotal(r)).toBe('$39.97/mo + $99/yr');
    expect(names(r.subscriptions)).toEqual(['NETFLIX', 'SPOTIFY', 'Hulu', 'Domain']);
  });

  it('leaves the yearly part out when there is none', () => {
    expect(formatRosterTotal(roster({ detected: [det('SPOTIFY')] }))).toBe('$11.99/mo');
  });

  it('without a cube: hand-added and watched only, detection unavailable', () => {
    const r = roster({
      detected: null, merchants: null, links: null,
      prefs: prefsWith({ manual: [{ id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' }], confirmed: ['RENT LLC'] }),
    });
    expect(r.detectionAvailable).toBe(false);
    expect(names(r.subscriptions)).toEqual(['Hulu', 'RENT LLC']);
  });
});

describe('dueWithin', () => {
  it('lists subscriptions and bills due in the window, in date order — never maybes, hidden, late or watched', () => {
    const r = roster({
      detected: [
        det('SPOTIFY', { lastDate: '2026-09-15' }),
        det('RENT LLC', { kind: 'bill', monthlyCents: 80000, lastDate: '2026-09-13' }),
        det('LATE ONE', { lastDate: '2026-09-10' }),
        det('MYSTERY BOX', { kind: 'possible', lastDate: '2026-09-14' }),
        det('QR LIBRARY', { lastDate: '2026-09-16' }),
        det('ADOBE', { lastDate: '2026-09-19' }),
      ],
      prefs: prefsWith({ hidden: ['QR LIBRARY'], confirmed: ['WATCHED'] }),
    });
    expect(names(dueWithin(r, TODAY, 7))).toEqual(['RENT LLC', 'SPOTIFY']);
    expect(names(dueWithin(r, TODAY, 8))).toEqual(['RENT LLC', 'SPOTIFY', 'ADOBE']);
  });
});

describe('roster text helpers', () => {
  it('money drops .00 and keeps cents otherwise', () => {
    expect([1199, 9900, 125050, 0, 100000].map(rosterMoney)).toEqual(['$11.99', '$99', '$1,250.50', '$0', '$1,000']);
  });

  it('about-dollars rounds to whole dollars', () => {
    expect([6149, 14050, 80000].map(aboutDollars)).toEqual(['$61', '$141', '$800']);
  });

  it('amounts and prices per kind', () => {
    const r = roster({
      detected: [det('SPOTIFY'), det('LG&E', { kind: 'bill', monthlyCents: 6149 })],
      prefs: prefsWith({
        manual: [{ id: 'dom00001', name: 'Domain', cents: 9900, cadence: 'yearly', nextDate: '2027-03-03' }],
        confirmed: ['NEVER SEEN'],
      }),
    });
    const by = (n: string) => [...r.subscriptions, ...r.bills].find((e) => e.displayName === n)!;
    expect([rosterAmount(by('SPOTIFY')), rosterPrice(by('SPOTIFY'))]).toEqual(['$11.99', '$11.99/mo']);
    expect([rosterAmount(by('LG&E')), rosterPrice(by('LG&E'))]).toEqual(['about $61', 'about $61/mo']);
    expect([rosterAmount(by('Domain')), rosterPrice(by('Domain'))]).toEqual(['$99/yr', '$99/yr']);
    expect([rosterAmount(by('NEVER SEEN')), rosterPrice(by('NEVER SEEN'))]).toEqual(['no price yet', 'no price yet']);
  });

  it('says when, in words', () => {
    expect(monthDay('2026-10-05')).toBe('Oct 5');
    const r = roster({ detected: [det('A', { lastDate: '2026-09-15' }), det('B', { lastDate: '2026-09-08' })] });
    expect(r.subscriptions.map(rosterWhen)).toEqual(['next Oct 15', 'due Oct 8, not charged yet']);
  });
});

describe('buildRoster — choices stored under a key from before 1.63 (R6)', () => {
  // 1.63 strips a leading bank reference from the detector's key, so a choice
  // saved under the old key must still find the entry under the new one.
  const OLD = '*8712 PAYMENT LOUISVILLE GAS & ACH';
  const NEW = 'PAYMENT LOUISVILLE GAS & ACH';

  it('normalizes a stored key, leaving hand-added keys and the manual id of a declined link alone', () => {
    expect(normalizeRosterKey(OLD)).toBe(NEW);
    expect(normalizeRosterKey(NEW)).toBe(NEW);
    expect(normalizeRosterKey('m:lge00001')).toBe('m:lge00001');
    expect(normalizeDeclinedLink(`lge00001|${OLD}`)).toBe(`lge00001|${NEW}`);
  });

  it('a hidden name stored under the old key still hides the new key', () => {
    const r = roster({ detected: [det(NEW, { kind: 'bill', monthlyCents: 6149 })], prefs: prefsWith({ hidden: [OLD] }) });
    expect(r.bills).toEqual([]);
    expect(names(r.hidden)).toEqual([NEW]);
    expect(r.billsMonthlyCents).toBe(0);
  });

  it('a confirmed name stored under the old key still counts, with no second watched row', () => {
    const r = roster({
      detected: [det('PAYMENT VENMO ACH WEB', { kind: 'possible', count: 2 })],
      prefs: prefsWith({ confirmed: ['*8768 PAYMENT VENMO ACH WEB'] }),
    });
    expect(r.subscriptions.map((e) => [e.key, e.source])).toEqual([['PAYMENT VENMO ACH WEB', 'detected']]);
    expect(r.maybes).toEqual([]);
  });

  it('a watched bank name is the same entry as its detection', () => {
    const r = roster({ detected: [det('HULU', { kind: 'possible', count: 2, monthlyCents: 999 })], prefs: prefsWith({ confirmed: ['HULU 877-824-4858'] }) });
    expect(r.subscriptions.map((e) => [e.key, e.source])).toEqual([['HULU', 'detected']]);
  });

  it('a hand-added entry linked under the old key still absorbs the detection', () => {
    const lge = { id: 'lge00001', name: 'LG&E', cents: 6000, cadence: 'monthly' as const, nextDate: '2026-10-20', merchant: OLD };
    const r = roster({ detected: [det(NEW, { kind: 'bill', monthlyCents: 6149, lastDate: '2026-10-08' })], prefs: prefsWith({ manual: [lge] }) });
    expect(r.bills).toEqual([]);
    expect(r.subscriptions.map((e) => [e.key, e.cents, e.nextDate])).toEqual([['m:lge00001', 6149, '2026-11-08']]);
  });

  it('a No to a link, stored under the old key, still holds', () => {
    const r = roster({
      prefs: prefsWith({
        manual: [{ id: 'lge00001', name: 'LG&E', cents: 6000, cadence: 'monthly', nextDate: '2026-10-20' }],
        declinedLinks: [`lge00001|${OLD}`],
      }),
      links: [{ manualId: 'lge00001', merchant: NEW, date: '2026-09-19', cents: 6149 }],
    });
    expect(r.linkSuggestions).toEqual([]);
  });
});
