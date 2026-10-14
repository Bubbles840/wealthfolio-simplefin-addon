/**
 * shared/month-review.ts
 *
 * The month-end review (project 5 R1, spec B; ruling N4): the monthly
 * wrap-up's Full-detail section, from the report cube, the subscription
 * roster and the change log. Pure.
 *
 *  - Biggest changes: the three categories whose spending moved most against
 *    the month before (by size, either way).
 *  - Top merchants: the month's three biggest (the cube's merchant list).
 *  - Subscriptions: new ones — an entry whose whole charge history is known
 *    (the detector keeps the newest three) began in this month or the one
 *    before AND charged this month: a subscription needs two charges to be in
 *    the roster, so one that starts in a month is rarely known by its end;
 *    ones no longer charging ("cancelled?") — overdue since a date in this
 *    month — which names only subscriptions found missing their charge near
 *    the month's end: the detector drops a subscription 45 days after its
 *    last charge (ACTIVE_WITHIN_DAYS) and an entry is overdue only 7 days
 *    after its predicted date, so ones that stopped earlier have already left
 *    the list (R2: the cube keeps recently silent ones); and price rises
 *    charged this month.
 *  - Net worth: the month-end change. Savings rate: (income − spent) ÷ income.
 *  - How many changes the change log shows (not background) for the month.
 *
 * Each line is left out when its data is missing or empty; a review with no
 * line at all is no section. Bank, merchant and category text is escaped in
 * the Telegram section and kept outside every entity.
 */
import type { ChangeLogRead } from './change-log.js';
import { changeLocalDay, isBackground, isChangeLogPartial } from './change-view.js';
import { savingsRateData } from './report-data.js';
import type { ReportCube } from './report-cube.js';
import { rosterMoney, rosterPrice, type Roster, type RosterEntry } from './subscription-roster.js';
import type { DetectedSubscription } from './subscriptions.js';
import { escapeMarkdown, moneyWhole, shortDate } from './telegram.js';

export const REVIEW_TOP = 3;
export const MONTH_REVIEW_HEADING = '*Month in review*';

export interface MonthReviewInput {
  /** The month reviewed, YYYY-MM. */
  month: string;
  cube: ReportCube | null;
  /** Built for the day the review is composed. */
  roster: Roster | null;
  changes: ChangeLogRead | null;
}

export interface MonthReview {
  month: string;
  changes: Array<{ category: string; deltaCents: number }> | null;
  merchants: Array<{ name: string; cents: number }> | null;
  newSubs: Array<{ entry: RosterEntry; since: string }> | null;
  gone: RosterEntry[] | null;
  rose: RosterEntry[] | null;
  netWorthDeltaCents: number | null;
  savingsRatePct: number | null;
  changeCount: number | null;
}

const orNull = <T>(list: T[]): T[] | null => (list.length > 0 ? list : null);
const monthBefore = (month: string): string => {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/** The first charge, known only when the newest three kept are all of them. */
function firstCharge(d: DetectedSubscription): string | null {
  const recent = d.recent ?? [];
  return recent.length > 0 && d.count <= recent.length ? recent[recent.length - 1].date : null;
}

export function buildMonthReview(input: MonthReviewInput): MonthReview {
  const { month, cube, roster, changes } = input;
  const previous = monthBefore(month);
  const mi = cube ? cube.months.indexOf(month) : -1;
  const pi = cube && mi >= 1 && cube.months[mi - 1] === previous ? mi - 1 : -1;

  let categoryChanges: MonthReview['changes'] = null;
  let merchants: MonthReview['merchants'] = null;
  let netWorthDeltaCents: number | null = null;
  let savingsRatePct: number | null = null;
  if (cube && mi >= 0) {
    const total = (m: number, ci: number) => cube.spend[m][ci].reduce((sum, v) => sum + v, 0);
    if (pi >= 0) {
      categoryChanges = orNull(cube.categories
        .map((category, ci) => ({ category, deltaCents: total(mi, ci) - total(pi, ci) }))
        .filter((c) => c.deltaCents !== 0)
        .sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents) || a.category.localeCompare(b.category))
        .slice(0, REVIEW_TOP));
      const now = cube.netWorth[mi];
      const before = cube.netWorth[pi];
      if (now !== null && before !== null) netWorthDeltaCents = now - before;
    }
    merchants = orNull([...cube.merchants[mi]]
      .filter((m) => m.cents > 0)
      .sort((a, b) => b.cents - a.cents || a.name.localeCompare(b.name))
      .slice(0, REVIEW_TOP)
      .map(({ name, cents }) => ({ name, cents })));
    // The Budget tab's own figure (one decimal, then the headline's round).
    const rate = savingsRateData(cube)[mi].rate;
    if (typeof rate === 'number') savingsRatePct = Math.round(rate);
  }

  let newSubs: MonthReview['newSubs'] = null;
  let gone: MonthReview['gone'] = null;
  let rose: MonthReview['rose'] = null;
  if (roster) {
    const entries = [...roster.subscriptions, ...roster.bills];
    if (cube?.subscriptions) {
      const detected = new Map(cube.subscriptions.map((d) => [d.name, d] as const));
      newSubs = orNull(entries.flatMap((entry) => {
        const d = detected.get(entry.source === 'detected' ? entry.key : entry.bankName ?? entry.displayName);
        const since = d ? firstCharge(d) : null;
        if (!d || !since || !(d.recent ?? []).some((c) => c.date.slice(0, 7) === month)) return [];
        return since.slice(0, 7) === month || since.slice(0, 7) === previous ? [{ entry, since }] : [];
      }));
    }
    gone = orNull(entries.filter((e) => !!e.overdueSince && e.overdueSince.slice(0, 7) === month));
    rose = orNull(entries.filter((e) => !!e.creep && e.creep.chargedOn.slice(0, 7) === month));
  }

  let changeCount: number | null = null;
  if (changes && !isChangeLogPartial(changes)) {
    const n = changes.entries.filter((e) => !isBackground(e) && changeLocalDay(e.at).slice(0, 7) === month).length;
    changeCount = n > 0 ? n : null;
  }

  return {
    month, changes: categoryChanges, merchants, newSubs, gone, rose, netWorthDeltaCents, savingsRatePct, changeCount,
  };
}

/** `+$120`, `-$80`; `$0` when it rounds away. */
function signed(cents: number): string {
  const text = moneyWhole(Math.abs(cents) / 100);
  return text === '$0' ? text : `${cents > 0 ? '+' : '-'}${text}`;
}

/** The review as the monthly report's section (legacy Markdown), or null
 *  when it has no line. */
export function formatMonthReview(r: MonthReview): string | null {
  const lines: string[] = [];
  if (r.changes) {
    lines.push(`Biggest changes: ${r.changes.map((c) => `${escapeMarkdown(c.category)} ${signed(c.deltaCents)}`).join(' · ')}`);
  }
  if (r.merchants) {
    lines.push(`Top merchants: ${r.merchants.map((m) => `${escapeMarkdown(m.name)} ${moneyWhole(m.cents / 100)}`).join(' · ')}`);
  }
  if (r.newSubs) {
    lines.push(`New: ${r.newSubs.map(({ entry, since }) => `${escapeMarkdown(entry.displayName)} ${rosterPrice(entry)} (since ${shortDate(since)})`).join(' · ')}`);
  }
  if (r.gone) lines.push(`No longer charging (cancelled?): ${r.gone.map((e) => escapeMarkdown(e.displayName)).join(' · ')}`);
  if (r.rose) {
    lines.push(`Rose in price: ${r.rose.map((e) => `${escapeMarkdown(e.displayName)} ${rosterMoney(e.creep!.fromCents)} → ${rosterMoney(e.creep!.toCents)}`).join(' · ')}`);
  }
  if (r.netWorthDeltaCents !== null) lines.push(`Net worth: ${signed(r.netWorthDeltaCents)} over the month`);
  if (r.savingsRatePct !== null) lines.push(`Savings rate: ${r.savingsRatePct}%`);
  if (r.changeCount !== null) {
    const n = r.changeCount;
    lines.push(`${n} ${n === 1 ? 'change was' : 'changes were'} made to your books (see /changes).`);
  }
  return lines.length > 0 ? `${MONTH_REVIEW_HEADING}\n${lines.join('\n')}` : null;
}
