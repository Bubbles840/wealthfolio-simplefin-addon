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
