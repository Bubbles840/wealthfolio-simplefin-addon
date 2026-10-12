import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GLYPH_STYLE, formatComingUpBlock, formatNextWeekLine, formatSubscriptionList, formatSubscriptionNews,
  formatSubscriptionRow, parseNewsSent, pruneNewsSent, subscriptionListPage,
} from './telegram.js';
import { buildRoster, dueWithin, type RosterInput } from './subscription-roster.js';
import { emptySubscriptionPrefs, type SubscriptionPrefs } from './subscription-prefs.js';
import type { DetectedSubscription } from './subscriptions.js';

const TODAY = '2026-10-12';
const GLYPHS = { mode: 'glyphs' as const, overrides: {} };
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

/** A morning: a reminder 3 days out, a bill due in 4, a fresh price rise with a
 *  Markdown star in the bank's name, a charge missed 9 days ago, one far off. */
const morning = (today = TODAY, prefs: Partial<SubscriptionPrefs> = { remind: { SPOTIFY: 3 } }) => roster({
  today,
  detected: [
    det('SPOTIFY', { lastDate: '2026-09-15' }),
    det('RENT LLC', { kind: 'bill', monthlyCents: 80000, lastDate: '2026-09-16' }),
    det('PAYPAL *HULU', { monthlyCents: 999, lastCents: 1099, creep: true, lastDate: '2026-10-10' }),
    det('NETFLIX', { monthlyCents: 1549, lastDate: '2026-09-03' }),
    det('ADOBE', { monthlyCents: 5499, lastDate: '2026-09-25' }),
  ],
  prefs: prefsWith(prefs),
});

describe('formatComingUpBlock', () => {
  it('Full: reminders, the week ahead, the price rise, the missed charge — in that order', () => {
    expect(formatComingUpBlock(morning(), TODAY, 'full')?.text).toBe([
      '*Coming up*',
      '🔔 SPOTIFY charges in 3 days · $11.99',
      'RENT LLC Oct 16 · about $800',
      '📈 PAYPAL \\*HULU charged $10.99 — up from its usual $9.99.',
      "✓ NETFLIX didn't charge Oct 3 — cancelled?",
    ].join('\n'));
  });

  it('Brief leaves out the week ahead', () => {
    expect(formatComingUpBlock(morning(), TODAY, 'brief')?.text).toBe([
      '*Coming up*',
      '🔔 SPOTIFY charges in 3 days · $11.99',
      '📈 PAYPAL \\*HULU charged $10.99 — up from its usual $9.99.',
      "✓ NETFLIX didn't charge Oct 3 — cancelled?",
    ].join('\n'));
  });

  it('never repeats a 🔔 entry in the week ahead', () => {
    expect(formatComingUpBlock(morning(), TODAY, 'full')!.text.match(/SPOTIFY/g)).toHaveLength(1);
  });

  it('says tomorrow and today as the day comes, and nothing before the window opens', () => {
    expect(formatComingUpBlock(morning('2026-10-14'), '2026-10-14', 'brief')!.text).toContain('🔔 SPOTIFY charges tomorrow · $11.99');
    expect(formatComingUpBlock(morning('2026-10-15'), '2026-10-15', 'brief')!.text).toContain('🔔 SPOTIFY charges today · $11.99');
    expect(formatComingUpBlock(morning('2026-10-11'), '2026-10-11', 'brief')?.text ?? '').not.toContain('🔔');
  });

  it('the price-rise line lasts the charge day and the three after it', () => {
    const block = (today: string) => formatComingUpBlock(morning(today), today, 'brief')?.text ?? '';
    expect(block('2026-10-13')).toContain('📈');
    expect(block('2026-10-14')).not.toContain('📈');
  });

  it('asks "cancelled?" on the first three mornings an entry is overdue', () => {
    const asked = (today: string) => (formatComingUpBlock(morning(today), today, 'brief')?.text ?? '').includes('NETFLIX didn');
    expect(['2026-10-10', '2026-10-11', '2026-10-13', '2026-10-14'].map(asked)).toEqual([false, true, true, false]);
  });

  it('returns the entries behind the "cancelled?" lines, for their Hide buttons', () => {
    expect(formatComingUpBlock(morning(), TODAY, 'brief')!.cancelled.map((e) => e.key)).toEqual(['NETFLIX']);
  });

  it('is absent when it has nothing to say, and hidden entries say nothing', () => {
    expect(formatComingUpBlock(roster({ detected: [det('ADOBE', { lastDate: '2026-09-25' })] }), TODAY, 'full')).toBeNull();
    expect(formatComingUpBlock(morning(TODAY, {
      remind: { SPOTIFY: 3 }, hidden: ['SPOTIFY', 'RENT LLC', 'PAYPAL *HULU', 'NETFLIX'],
    }), TODAY, 'full')).toBeNull();
  });

  it('escapes renamed names too, and keeps them out of bold', () => {
    const r = roster({
      today: '2026-10-14',
      detected: [det('SPOTIFY', { lastDate: '2026-09-15' })],
      prefs: prefsWith({ remind: { SPOTIFY: 1 }, names: { SPOTIFY: 'Spotify_Family*' } }),
    });
    expect(formatComingUpBlock(r, '2026-10-14', 'brief')?.text).toBe('*Coming up*\n🔔 Spotify\\_Family\\* charges tomorrow · $11.99');
  });

  it('puts the calendar on the header only when the reports wear glyphs', () => {
    expect(formatComingUpBlock(morning(), TODAY, 'brief', GLYPHS)!.text.split('\n')[0]).toBe('📅 *Coming up*');
    expect(formatComingUpBlock(morning(), TODAY, 'brief', DEFAULT_GLYPH_STYLE)!.text.split('\n')[0]).toBe('*Coming up*');
  });
});

describe('formatSubscriptionNews (daily report off)', () => {
  it('says each event once: what was sent stays out, and there is no week-ahead list', () => {
    const news = formatSubscriptionNews(morning(), TODAY, { 'SPOTIFY|remind|2026-10-15': '2026-10-11' })!;
    expect(news.text).toBe([
      '*Coming up*',
      '📈 PAYPAL \\*HULU charged $10.99 — up from its usual $9.99.',
      "✓ NETFLIX didn't charge Oct 3 — cancelled?",
    ].join('\n'));
    expect(news.events).toEqual(['PAYPAL *HULU|creep|2026-10-10', 'NETFLIX|cancel|2026-10-03']);
    expect(news.cancelled.map((e) => e.key)).toEqual(['NETFLIX']);
  });

  it('is null once everything has been said', () => {
    expect(formatSubscriptionNews(morning(), TODAY, {
      'SPOTIFY|remind|2026-10-15': '2026-10-12',
      'PAYPAL *HULU|creep|2026-10-10': '2026-10-12',
      'NETFLIX|cancel|2026-10-03': '2026-10-12',
    })).toBeNull();
  });
});

describe('news bookkeeping', () => {
  it('reads the sent map leniently — it is the companion\'s own memo, not a user choice', () => {
    expect(parseNewsSent(null)).toEqual({});
    expect(parseNewsSent('oops')).toEqual({});
    expect(parseNewsSent('{"a|remind|2026-10-15":"2026-10-12","b":3}')).toEqual({ 'a|remind|2026-10-15': '2026-10-12' });
  });

  it('forgets events sent more than 60 days ago', () => {
    expect(pruneNewsSent({ old: '2026-08-12', edge: '2026-08-13', fresh: '2026-10-01' }, TODAY))
      .toEqual({ edge: '2026-08-13', fresh: '2026-10-01' });
  });
});

describe('formatNextWeekLine', () => {
  it('counts and totals the week; the calendar only with glyphs', () => {
    const due = dueWithin(morning(), '2026-10-13', 7);
    expect(formatNextWeekLine(due, GLYPHS)).toBe('📅 Next week: 2 charges · $811.99');
    expect(formatNextWeekLine(due.slice(0, 1))).toBe('Next week: 1 charge · $11.99');
    expect(formatNextWeekLine([])).toBeNull();
  });
});

describe('formatSubscriptionList', () => {
  const list = () => roster({
    detected: [
      det('SPOTIFY', { lastDate: '2026-09-15' }),
      det('NETFLIX', { monthlyCents: 1549, lastCents: 1799, creep: true, lastDate: '2026-09-22' }),
      det('LG&E', { kind: 'bill', monthlyCents: 6149, lastDate: '2026-09-28' }),
    ],
    prefs: prefsWith({
      names: { SPOTIFY: 'Spotify' },
      remind: { SPOTIFY: 3 },
      manual: [
        { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' },
        { id: 'dom00001', name: 'Domain', cents: 9900, cadence: 'yearly', nextDate: '2027-03-03' },
      ],
    }),
  });

  it('renders the groups with their totals, the way the spec draws them', () => {
    expect(formatSubscriptionList(list(), 0)).toBe([
      '💳 *Subscriptions* · $39.97/mo + $99/yr',
      'NETFLIX — $17.99 · next Oct 22 · ⬆ was $15.49',
      'Spotify — $11.99 · next Oct 15 🔔',
      'Hulu ✍️ — $9.99 · next Oct 20',
      'Domain ✍️ — $99/yr · next Mar 3',
      '📄 *Bills* · about $61/mo',
      'LG&E — about $61 · next Oct 28',
    ].join('\n'));
  });

  it('leads with an unreadable-settings note and a link suggestion', () => {
    const r = roster({
      prefs: prefsWith({ manual: [{ id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' }] }),
      links: [{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-09-19', cents: 999 }],
    });
    const lines = formatSubscriptionList(r, 0, { unreadable: true }).split('\n');
    expect(lines[0]).toBe("⚠️ Couldn't read your subscription settings — changes are paused, and this list shows your older choices.");
    expect(lines[2]).toBe('Is HULU your Hulu? ($9.99 on Sep 19)');
  });

  it('says what to do when the list is empty', () => {
    expect(formatSubscriptionList(roster(), 0))
      .toBe('💳 *Subscriptions* · $0/mo\nNothing recurring found yet — tap ➕ Add to track one by hand.');
    expect(formatSubscriptionList(roster({ detected: null }), 0))
      .toContain("The companion hasn't looked for recurring charges yet — tap ➕ Add to track one by hand.");
  });

  it('pages at ten rows', () => {
    const many = roster({ detected: Array.from({ length: 12 }, (_, i) => det(`SUB ${String(i).padStart(2, '0')}`, { monthlyCents: 1000 + i })) });
    expect(subscriptionListPage(many, 0).entries).toHaveLength(10);
    expect(subscriptionListPage(many, 1)).toMatchObject({ page: 1, pages: 2 });
    expect(subscriptionListPage(many, 9).page).toBe(1);
    expect(formatSubscriptionList(many, 1)).toContain('_Page 2 of 2_');
  });

  it('escapes bank names and marks reminded rows', () => {
    const r = roster({ detected: [det('SQ *COFFEE_CLUB', { lastDate: '2026-09-15' })], prefs: prefsWith({ remind: { 'SQ *COFFEE_CLUB': 1 } }) });
    expect(formatSubscriptionRow(r.subscriptions[0])).toBe('SQ \\*COFFEE\\_CLUB — $11.99 · next Oct 15 🔔');
  });
});
