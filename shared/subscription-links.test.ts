import { describe, it, expect } from 'vitest';
import { findLinkSuggestions } from './subscription-links.js';
import { acceptLink, emptySubscriptionPrefs, type ManualSubscription, type SubscriptionPrefs } from './subscription-prefs.js';
import { buildRoster } from './subscription-roster.js';
import { aliasNames, detectSubscriptions } from './subscriptions.js';

const NOW = new Date(2026, 9, 12, 9, 0, 0); // Oct 12, local morning
const HULU: ManualSubscription = { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' };
const prefsWith = (over: Partial<SubscriptionPrefs> = {}): SubscriptionPrefs => ({ ...emptySubscriptionPrefs(), manual: [HULU], ...over });
/** SubscriptionCharge as the cube builder makes it: description already through descriptionFromComment. */
const charge = (date: string, merchant: string, cents: number) => ({ date, merchant, cents });

describe('findLinkSuggestions', () => {
  it('suggests the one merchant whose charge lands near a due date at about the price', () => {
    expect(findLinkSuggestions([charge('2026-09-19', 'HULU 877-824-4858', 999), charge('2026-09-20', 'CHIPOTLE 1234', 1250)], prefsWith(), NOW))
      .toEqual([{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-09-19', cents: 999 }]);
  });

  it('two charges from the SAME merchant are one candidate — the newest is offered', () => {
    const manual = [{ ...HULU, nextDate: '2026-10-08' }];
    expect(findLinkSuggestions(
      [charge('2026-09-08', 'HULU 877-824-4858', 999), charge('2026-10-08', 'HULU 877-824-4858', 999)],
      prefsWith({ manual }), NOW,
    )).toEqual([{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-10-08', cents: 999 }]);
  });

  it('two merchants match: ambiguous, so none', () => {
    expect(findLinkSuggestions([charge('2026-09-19', 'HULU 877-824-4858', 999), charge('2026-09-21', 'DISNEY PLUS', 1029)], prefsWith(), NOW))
      .toEqual([]);
  });

  it.each([
    ['too far from the due date', charge('2026-09-16', 'HULU 877-824-4858', 999)],
    ['more than 15% off the price', charge('2026-09-20', 'HULU 877-824-4858', 1199)],
    ['older than 45 days', charge('2026-08-20', 'HULU 877-824-4858', 999)],
    ['dated after today', charge('2026-10-19', 'HULU 877-824-4858', 999)],
  ])('ignores a charge %s', (_why, c) => {
    expect(findLinkSuggestions([c], prefsWith(), NOW)).toEqual([]);
  });

  it('a No sticks, a linked entry is skipped, and a merchant another entry owns is not offered', () => {
    const hulu = charge('2026-09-19', 'HULU 877-824-4858', 999);
    expect(findLinkSuggestions([hulu], prefsWith({ declinedLinks: ['hulu0001|HULU'] }), NOW)).toEqual([]);
    expect(findLinkSuggestions([hulu], prefsWith({ manual: [{ ...HULU, merchant: 'HULU' }] }), NOW)).toEqual([]);
    const owner = { id: 'hulu0002', name: 'Hulu again', cents: 999, cadence: 'monthly' as const, nextDate: '2026-10-20', merchant: 'HULU' };
    expect(findLinkSuggestions([hulu], prefsWith({ manual: [HULU, owner] }), NOW)).toEqual([]);
  });

  it('never suggests a merchant already linked to another hand-added entry (R2-16)', () => {
    const a = { ...HULU, id: 'hulu000a', merchant: 'HULU' };
    const b = { ...HULU, id: 'hulu000b', name: 'Hulu B' };
    expect(findLinkSuggestions([charge('2026-09-19', 'HULU 877-824-4858', 999)], prefsWith({ manual: [a, b] }), NOW)).toEqual([]);
  });

  it('declining one merchant leaves the other as the single candidate', () => {
    expect(findLinkSuggestions(
      [charge('2026-09-19', 'HULU 877-824-4858', 999), charge('2026-09-21', 'DISNEY PLUS', 1029)],
      prefsWith({ declinedLinks: ['hulu0001|DISNEY PLUS'] }), NOW,
    )).toEqual([{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-09-19', cents: 999 }]);
  });

  it("matches a yearly entry against last year's due date", () => {
    const adobe = { id: 'adob0001', name: 'Adobe', cents: 9900, cadence: 'yearly' as const, nextDate: '2027-09-30' };
    expect(findLinkSuggestions([charge('2026-09-29', 'ADOBE CREATIVE 8ZK1', 9900)], prefsWith({ manual: [adobe] }), NOW))
      .toEqual([{ manualId: 'adob0001', merchant: 'ADOBE CREATIVE', date: '2026-09-29', cents: 9900 }]);
  });

  it('matches when the next date typed is after the charge it should link to', () => {
    expect(findLinkSuggestions([charge('2026-10-09', 'HULU 877-824-4858', 999)], prefsWith({ manual: [{ ...HULU, nextDate: '2026-11-10' }] }), NOW))
      .toEqual([{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-10-09', cents: 999 }]);
  });
});

describe('names stored under a key from before 1.63 (R6)', () => {
  const LGE: ManualSubscription = { id: 'lge00001', name: 'LG&E', cents: 6149, cadence: 'monthly', nextDate: '2026-10-19' };
  const bill = charge('2026-09-19', '*0937 PAYMENT LOUISVILLE GAS & ACH DEBIT', 6149);

  it('a merchant declined or linked under the old key is not offered again', () => {
    expect(findLinkSuggestions([bill], prefsWith({ manual: [LGE] }), NOW))
      .toEqual([{ manualId: 'lge00001', merchant: 'PAYMENT LOUISVILLE GAS & ACH', date: '2026-09-19', cents: 6149 }]);
    expect(findLinkSuggestions([bill], prefsWith({ manual: [LGE], declinedLinks: ['lge00001|*8712 PAYMENT LOUISVILLE GAS & ACH'] }), NOW))
      .toEqual([]);
    expect(findLinkSuggestions([bill], prefsWith({ manual: [LGE, { ...HULU, merchant: '*8712 PAYMENT LOUISVILLE GAS & ACH' }] }), NOW))
      .toEqual([]);
  });
});

describe('a renamed charge belongs to the entry it was joined into (F1)', () => {
  // Nick's Google One on the Citi card: renamed on Oct 6, joined by the
  // detector under the old name. On Oct 25 only the renamed charge is recent.
  const OLD = 'GOOGLE *Google One MOUNTAIN VIEW CA';
  const NEW = 'GOOGLE *G1AI101M MOUNTAIN VIEW CA';
  const NOW_25 = new Date(2026, 9, 25, 9, 0, 0);
  const g = (date: string, merchant: string, cents: number) => ({ date, merchant, cents, accountId: 'wf-citi' });
  const CHARGES = [
    g('2026-06-06', OLD, 529), g('2026-06-10', 'Google One Mountain View CA', 2649), g('2026-07-06', OLD, 529),
    g('2026-08-06', OLD, 529), g('2026-09-06', OLD, 2119), g('2026-10-06', NEW, 2119),
  ];
  const GOOGLE: ManualSubscription = { id: 'goog0001', name: 'Google One', cents: 2119, cadence: 'monthly', nextDate: '2026-11-06' };
  const detected = detectSubscriptions(CHARGES, NOW_25);

  it('offers the joined name, so Yes absorbs the detected row: ONE roster entry', () => {
    const prefs = prefsWith({ manual: [GOOGLE] });
    const links = findLinkSuggestions(CHARGES, prefs, NOW_25, aliasNames(detected));
    expect(links).toEqual([{ manualId: 'goog0001', merchant: OLD, date: '2026-10-06', cents: 2119 }]);
    const r = buildRoster({ detected, merchants: [], links, prefs: acceptLink(prefs, links[0]), today: '2026-10-25' });
    expect(r.subscriptions.map((e) => [e.key, e.cents])).toEqual([['m:goog0001', 2119]]);
    expect(r.monthlyCents).toBe(2119);
  });

  it('a link or a No stored under the renamed key is the same merchant', () => {
    const aliases = aliasNames(detected);
    const owner = { ...GOOGLE, id: 'goog0002', merchant: NEW };
    expect(findLinkSuggestions(CHARGES, prefsWith({ manual: [GOOGLE, owner] }), NOW_25, aliases)).toEqual([]);
    expect(findLinkSuggestions(CHARGES, prefsWith({ manual: [GOOGLE], declinedLinks: [`goog0001|${NEW}`] }), NOW_25, aliases)).toEqual([]);
  });

  it('without the joined names (an older caller) it offers the charge under its own key, as before', () => {
    expect(findLinkSuggestions(CHARGES, prefsWith({ manual: [GOOGLE] }), NOW_25))
      .toEqual([{ manualId: 'goog0001', merchant: NEW, date: '2026-10-06', cents: 2119 }]);
  });
});
