/**
 * shared/subscription-roster.ts
 *
 * ONE roster every subscription surface renders from — the app card, the
 * mini app, `/subscriptions`, the weekly line and the daily "Coming up"
 * block — so the "what counts" filter cannot drift between hand copies again.
 * Pure: the cube, the stored document and `today` come in; nothing is read.
 *
 * This first section is the date and key arithmetic the stored document's
 * edits need as well (shared/subscription-prefs.ts imports it; this module
 * imports only TYPES from there, so there is no runtime cycle). Dates are
 * YYYY-MM-DD strings, computed in UTC so a host's zone can never shift a day;
 * `today` is always the caller's local calendar day.
 */

import { findingHandle } from './handle.js';
import type { CubeMerchant } from './report-cube.js';
import { aliasNames, detectionKeys, subscriptionKey, type DetectedSubscription } from './subscriptions.js';
import type { ManualSubscription, RemindDays, SubscriptionPrefs } from './subscription-prefs.js';

export type Cadence = 'monthly' | 'yearly';

const DAY_MS = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, '0');
const isoOf = (y: number, m1: number, d: number) => `${y}-${pad2(m1)}-${pad2(d)}`;
const ymd = (iso: string): [number, number, number] =>
  [Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10))];
/** Days in month `m1` (1–12): day 0 of the following month is this month's last. */
const daysInMonth = (y: number, m1: number) => new Date(Date.UTC(y, m1, 0)).getUTCDate();

/** `iso` plus `n` months (negative allowed), the day clamped to the target
 *  month: Jan 31 + 1 → Feb 28, or Feb 29 in a leap year. */
export function addMonthsClamped(iso: string, n: number): string {
  const [y, m, d] = ymd(iso);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return isoOf(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** `iso` plus `n` years, Feb 29 clamped to Feb 28 in a year without one. */
export function addYearsClamped(iso: string, n: number): string {
  const [y, m, d] = ymd(iso);
  return isoOf(y + n, m, Math.min(d, daysInMonth(y + n, m)));
}

export function addDaysIso(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` — negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** `n` periods after `iso`: months or years by cadence, day clamped. */
export function addPeriod(iso: string, cadence: Cadence, n = 1): string {
  return cadence === 'yearly' ? addYearsClamped(iso, n) : addMonthsClamped(iso, n);
}

/** The first of `iso`, `iso` + 1 period, `iso` + 2 periods … that is today or
 *  later. Always counted from `iso` itself, so a 31st stays the 31st wherever
 *  the month allows (Jan 31 → Feb 28 → Mar 31) instead of drifting to the 28th. */
export function rollForward(iso: string, cadence: Cadence, today: string): string {
  if (iso >= today) return iso;
  for (let n = 1; ; n += 1) {
    const next = addPeriod(iso, cadence, n);
    if (next >= today) return next;
  }
}

/** The local calendar day of `d` — what "today" means to the person reading. */
export function localIsoDay(d: Date): string {
  return isoOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

const MANUAL_PREFIX = 'm:';

/** A hand-added entry's roster key — kept even after it is linked to a merchant. */
export function manualKey(id: string): string {
  return `${MANUAL_PREFIX}${id}`;
}

export function isManualKey(key: string): boolean {
  return key.startsWith(MANUAL_PREFIX);
}

/** A stored hide/confirm/rename key as the detector would spell it today (R6):
 *  `*8712 PAYMENT LOUISVILLE GAS & ACH` and `PAYMENT LOUISVILLE GAS & ACH` are
 *  one entry. A hand-added key is an id, not a merchant, and is left alone. */
export function normalizeRosterKey(key: string): string {
  return isManualKey(key) ? key : subscriptionKey(key);
}

/** A declined link is `manualId|merchant`; only the merchant part moves with
 *  the detector's key. The id may not contain `|`, so split at the first. */
export function normalizeDeclinedLink(entry: string): string {
  const bar = entry.indexOf('|');
  return bar < 0 ? entry : `${entry.slice(0, bar)}|${subscriptionKey(entry.slice(bar + 1))}`;
}

/** normalizeDeclinedLink, then a renamed charge's key read as the entry it was
 *  joined into (F1, `aliasOf` from aliasNames): a No said to `GOOGLE
 *  *G1AI101M …` still holds once it is offered as `GOOGLE *Google One …`. */
export function declinedLinkEntry(entry: string, aliasOf: ReadonlyMap<string, string>): string {
  const normalized = normalizeDeclinedLink(entry);
  const bar = normalized.indexOf('|');
  if (bar < 0) return normalized;
  const merchant = normalized.slice(bar + 1);
  return `${normalized.slice(0, bar)}|${aliasOf.get(merchant) ?? merchant}`;
}

// ── The roster ────────────────────────────────────────────────────────────

export type RosterGroup = 'subscription' | 'bill' | 'maybe';

export interface RosterEntry {
  key: string;
  /** Rename, else the hand-added name, else the detector's name. */
  displayName: string;
  /** The detector's (bank's) name, when it differs from displayName. */
  bankName?: string;
  group: RosterGroup;
  source: 'detected' | 'watched' | 'manual';
  /** Per charge; "about" for bills. */
  cents: number;
  cadence: Cadence;
  /** Null once overdue, and for watched names (no dates known). */
  nextDate: string | null;
  /** nextDate is past, inside the LATE_GRACE_DAYS grace. */
  late?: boolean;
  /** The predicted date passed more than LATE_GRACE_DAYS ago. */
  overdueSince?: string;
  creep?: { fromCents: number; toCents: number; chargedOn: string };
  remind?: RemindDays;
  /** Newest first, up to 3. */
  recent: Array<{ date: string; cents: number }>;
  /** findingHandle(key), for button data. */
  handle: string;
  /** A detected row's aliases (F1): the keys of renamed charges joined into
   *  it. A hide or Yes stored under one of them applies to this row, so
   *  Restore clears them along with `key`. Absent when nothing was joined. */
  aliases?: string[];
}

/** One cube link suggestion (shared/subscription-links.ts writes them). */
export interface CubeLink { manualId: string; merchant: string; date: string; cents: number }
export interface RosterLinkSuggestion extends CubeLink { manualName: string }

export interface Roster {
  subscriptions: RosterEntry[];
  bills: RosterEntry[];
  maybes: RosterEntry[];
  hidden: RosterEntry[];
  /** Subscriptions with a monthly cadence. */
  monthlyCents: number;
  /** Yearly ones — NOT divided by 12. */
  yearlyCents: number;
  billsMonthlyCents: number;
  linkSuggestions: RosterLinkSuggestion[];
  /** False without detection data (no cube, or `subscriptions: null`): hand-added only. */
  detectionAvailable: boolean;
}

export interface RosterInput {
  /** cube.subscriptions; null/undefined when there is no cube or the companion could not look. */
  detected: readonly DetectedSubscription[] | null | undefined;
  /** cube.merchants, oldest month first — prices watched names. */
  merchants: ReadonlyArray<readonly CubeMerchant[]> | null | undefined;
  /** cube.subscriptionLinks, UNVALIDATED (parseReportCube does not check optional fields). */
  links: readonly unknown[] | null | undefined;
  prefs: SubscriptionPrefs;
  /** YYYY-MM-DD, the reader's local day. */
  today: string;
}

/** Days a predicted charge may be missing before the entry counts as overdue. */
export const LATE_GRACE_DAYS = 7;

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isCubeLink(v: unknown): v is CubeLink {
  if (!v || typeof v !== 'object') return false;
  const l = v as Record<string, unknown>;
  return typeof l.manualId === 'string' && typeof l.merchant === 'string' && l.merchant !== ''
    && typeof l.date === 'string' && ISO_DAY_RE.test(l.date) && Number.isInteger(l.cents);
}

/** From the LAST CHARGE, never from an earlier prediction, so a bank that
 *  moves a billing day self-corrects the next month. */
function nextFromCharge(lastDate: string, cadence: Cadence, today: string): Pick<RosterEntry, 'nextDate' | 'late' | 'overdueSince'> {
  const predicted = addPeriod(lastDate, cadence);
  const past = daysBetween(predicted, today);
  if (past <= 0) return { nextDate: predicted };
  if (past <= LATE_GRACE_DAYS) return { nextDate: predicted, late: true };
  return { nextDate: null, overdueSince: predicted };
}

/** A stable subscription's rise is measured from its median. A plan change is
 *  priced at the newest charge already (monthlyCents === lastCents), so the
 *  price it rose FROM is the charge before it — Google One shows $5.29 → $21.19. */
function creepFromCents(d: DetectedSubscription): number {
  return d.lastCents === d.monthlyCents && d.prevCents !== undefined ? d.prevCents : d.monthlyCents;
}

function fromDetection(d: DetectedSubscription, cadence: Cadence, today: string) {
  return {
    // After a price rise the newest charge is the price going forward.
    cents: d.creep ? d.lastCents : d.monthlyCents,
    ...nextFromCharge(d.lastDate, cadence, today),
    ...(d.creep ? { creep: { fromCents: creepFromCents(d), toCents: d.lastCents, chargedOn: d.lastDate } } : {}),
    recent: d.recent && d.recent.length > 0
      ? d.recent.slice(0, 3).map(({ date, cents }) => ({ date, cents }))
      : [{ date: d.lastDate, cents: d.lastCents }],
  };
}

/** Per-charge price of each merchant over the newest three cube months,
 *  newest month first — on the 2nd of a month the current month is two days
 *  deep, and a mid-month charge must still price (the v1.39 Anthropic miss). */
function recentMerchantPrices(merchants: RosterInput['merchants']): Map<string, number> {
  const out = new Map<string, number>();
  for (const month of [...(merchants ?? [])].slice(-3).reverse()) {
    for (const m of month ?? []) {
      if (!out.has(m.name)) out.set(m.name, m.count > 0 ? Math.round(m.cents / m.count) : 0);
    }
  }
  return out;
}

/** Monthly before yearly, then the biggest money first, then by name. */
const rosterOrder = (a: RosterEntry, b: RosterEntry) =>
  (a.cadence === b.cadence ? 0 : a.cadence === 'monthly' ? -1 : 1)
  || b.cents - a.cents
  || a.displayName.localeCompare(b.displayName);

/** Own keys only: a bank merchant named `constructor` must not read Object.prototype. */
const own = (rec: object, key: string): boolean => Object.prototype.hasOwnProperty.call(rec, key);

export function buildRoster(input: RosterInput): Roster {
  const { prefs, today } = input;
  const detected = input.detected ?? null;
  // R6: choices saved before 1.63 are keyed by the bank's old spelling
  // (`*8712 PAYMENT LOUISVILLE GAS & ACH`); the detector now says `PAYMENT
  // LOUISVILLE GAS & ACH`. Every stored name is compared through one
  // normalizer so the old choice still finds its entry.
  // F1: a name that is a renamed charge's key (`GOOGLE *G1AI101M …`, joined
  // into `GOOGLE *Google One …`) is the entry it was joined into — a watch,
  // hide, Yes or link made under it before the join must not add a second
  // row. An older cube has no aliases, so nothing resolves there.
  const aliasOf = aliasNames(detected);
  const entryOf = (key: string) => aliasOf.get(key) ?? key;
  const storedKey = (key: string) => entryOf(normalizeRosterKey(key));
  const merchantKey = (merchant: string) => entryOf(subscriptionKey(merchant));
  const hidden = new Set(prefs.hidden.map(storedKey));
  const confirmed = new Set(prefs.confirmed.map(storedKey));
  const linkedManual = new Map<string, ManualSubscription>();
  for (const m of prefs.manual) if (m.merchant) linkedManual.set(merchantKey(m.merchant), m);
  const detectedByName = new Map((detected ?? []).map((d) => [d.name, d] as const));

  const naming = (key: string, fallback: string, bank: string | undefined) => {
    const displayName = own(prefs.names, key) ? prefs.names[key] : fallback;
    return bank && bank !== displayName ? { displayName, bankName: bank } : { displayName };
  };
  const reminder = (key: string): { remind?: RemindDays } => (own(prefs.remind, key) ? { remind: prefs.remind[key] } : {});

  const all: RosterEntry[] = [];
  for (const d of detected ?? []) {
    // A hand-added entry linked to this merchant IS this row (below).
    if (linkedManual.has(d.name)) continue;
    // Absent kind = a pre-1.36 cube's row, whose only meaning was "subscription".
    const kind = d.kind ?? 'subscription';
    const group: RosterGroup = confirmed.has(d.name) || kind === 'subscription' ? 'subscription'
      : kind === 'bill' ? 'bill' : 'maybe';
    const aliases = detectionKeys(d).slice(1);
    all.push({
      key: d.name, ...naming(d.name, d.name, d.name), group, source: 'detected', cadence: 'monthly',
      ...fromDetection(d, 'monthly', today), ...reminder(d.name), handle: findingHandle(d.name),
      ...(aliases.length > 0 ? { aliases } : {}),
    });
  }

  // Watched: confirmed, but the detector has no verdict (one charge so far).
  const prices = recentMerchantPrices(input.merchants);
  const watched = new Set<string>();
  for (const name of prefs.confirmed) {
    const norm = storedKey(name);
    if (watched.has(norm) || detectedByName.has(norm) || linkedManual.has(norm) || isManualKey(name)) continue;
    watched.add(norm);
    all.push({
      key: name, ...naming(name, name, name), group: 'subscription', source: 'watched',
      cents: prices.get(name) ?? 0, cadence: 'monthly', nextDate: null, recent: [],
      ...reminder(name), handle: findingHandle(name),
    });
  }

  for (const m of prefs.manual) {
    const key = manualKey(m.id);
    const d = m.merchant ? detectedByName.get(merchantKey(m.merchant)) : undefined;
    const base = {
      key, ...naming(key, m.name, m.merchant), group: 'subscription' as const, source: 'manual' as const,
      cadence: m.cadence, ...reminder(key), handle: findingHandle(key),
    };
    // Linked AND detected: dates, price, history and creep from detection;
    // otherwise the stored date rolled forward — no overdue without charge data.
    all.push(d
      ? { ...base, ...fromDetection(d, m.cadence, today) }
      : { ...base, cents: m.cents, nextDate: rollForward(m.nextDate, m.cadence, today), recent: [] });
  }

  const visible = all.filter((e) => !hidden.has(normalizeRosterKey(e.key)));
  const group = (g: RosterGroup) => visible.filter((e) => e.group === g).sort(rosterOrder);
  const subscriptions = group('subscription');
  const bills = group('bill');
  const sum = (list: RosterEntry[]) => list.reduce((s, e) => s + e.cents, 0);

  const declined = new Set(prefs.declinedLinks.map((l) => declinedLinkEntry(l, aliasOf)));
  const manualById = new Map(prefs.manual.map((m) => [m.id, m] as const));
  const linkSuggestions: RosterLinkSuggestion[] = [];
  for (const l of input.links ?? []) {
    if (!isCubeLink(l)) continue;
    const m = manualById.get(l.manualId);
    // Gone, already linked, answered No, or a merchant another entry claimed.
    if (!m || m.merchant || declined.has(`${l.manualId}|${l.merchant}`) || linkedManual.has(l.merchant)) continue;
    linkSuggestions.push({
      manualId: l.manualId, manualName: prefs.names[manualKey(m.id)] ?? m.name,
      merchant: l.merchant, date: l.date, cents: l.cents,
    });
  }

  return {
    subscriptions,
    bills,
    maybes: group('maybe'),
    hidden: all.filter((e) => hidden.has(normalizeRosterKey(e.key))).sort(rosterOrder),
    monthlyCents: sum(subscriptions.filter((e) => e.cadence === 'monthly')),
    yearlyCents: sum(subscriptions.filter((e) => e.cadence === 'yearly')),
    billsMonthlyCents: sum(bills),
    linkSuggestions,
    detectionAvailable: detected !== null,
  };
}

/** Subscriptions and bills charging in [today, today + days), date order.
 *  Late (past) and overdue entries are not "due"; maybes and hidden never are. */
export function dueWithin(roster: Roster, today: string, days: number): RosterEntry[] {
  const end = addDaysIso(today, days);
  return [...roster.subscriptions, ...roster.bills]
    .filter((e) => e.nextDate !== null && e.nextDate >= today && e.nextDate < end)
    .sort((a, b) => a.nextDate!.localeCompare(b.nextDate!) || a.displayName.localeCompare(b.displayName));
}

// ── Text every surface shares, so the card, the mini app and Telegram can
//    never print a different name, price or total for the same entry. ──────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-05" → "Oct 5" — shared/telegram.ts's `shortDate` shape, which this
 *  module cannot import (telegram.ts imports this one). */
export function monthDay(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** `$11.99`, `$99`, `$1,250.50` — cents kept unless they are zero. */
export function rosterMoney(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const frac = abs % 100;
  return `${cents < 0 ? '-' : ''}$${thousands(Math.floor(abs / 100))}${frac === 0 ? '' : `.${String(frac).padStart(2, '0')}`}`;
}

/** A bill's "about" figure: whole dollars. */
export function aboutDollars(cents: number): string {
  return `$${thousands(Math.round(cents / 100))}`;
}

export function rosterAmount(e: RosterEntry): string {
  if (e.group === 'bill') return `about ${aboutDollars(e.cents)}`;
  if (e.source === 'watched' && e.cents === 0) return 'no price yet';
  return e.cadence === 'yearly' ? `${rosterMoney(e.cents)}/yr` : rosterMoney(e.cents);
}

/** rosterAmount with "/mo" on a priced monthly entry — the app card's price column. */
export function rosterPrice(e: RosterEntry): string {
  const amount = rosterAmount(e);
  return e.cadence === 'monthly' && amount !== 'no price yet' ? `${amount}/mo` : amount;
}

export function rosterWhen(e: RosterEntry): string {
  if (e.overdueSince) return `expected ${monthDay(e.overdueSince)}, hasn't charged`;
  if (e.nextDate === null) return 'watching';
  return e.late ? `due ${monthDay(e.nextDate)}, not charged yet` : `next ${monthDay(e.nextDate)}`;
}

/** `$87.42/mo + $99/yr` — the yearly part only when there is one. */
export function formatRosterTotal(roster: Roster): string {
  return `${rosterMoney(roster.monthlyCents)}/mo${roster.yearlyCents > 0 ? ` + ${rosterMoney(roster.yearlyCents)}/yr` : ''}`;
}
