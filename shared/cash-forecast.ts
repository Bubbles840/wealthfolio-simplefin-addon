/**
 * shared/cash-forecast.ts
 *
 * The `cash_forecast` secret (project 5 R1, spec A): the 30-day forecast as
 * the companion last computed it, after each sync, for the app's Home tile,
 * the weekly check-in, `/forecast` and the daily report's warning. The
 * companion is its ONLY writer; a failed publish keeps the previous one.
 * Readers parse it strictly — ok / absent / corrupt — and a value that is not
 * exactly this shape is corrupt, never a number. `{ ok: false, reason }` is a
 * forecast the companion could not make, saying why.
 *
 * Small by construction (a few accounts and a month of bills: a few KB, far
 * inside the report cube's 200 KB), so nothing is trimmed.
 *
 * Every line both hosts show is built here. In the app's lines bank, merchant
 * and account text is RAW; the Telegram builders escape it and keep it
 * outside every entity.
 */
import type { ForecastCharge } from './forecast.js';
import { daysBetween, rosterMoney } from './subscription-roster.js';
import { escapeMarkdown, moneyWhole, shortDate, type GlyphStyle } from './telegram.js';
import { isNewerVersion } from './version.js';

export const CASH_FORECAST_SECRET_KEY = 'cash_forecast';
/** The first release whose companion publishes the forecast. Before it, the
 *  app says to update the companion; `shared/cash-forecast.test.ts` fails if
 *  a release ships below it. */
export const CASH_FORECAST_SINCE = '1.61.0';
/** Older than this, the forecast is out of date: the companion has not synced. */
export const CASH_FORECAST_STALE_MS = 2 * 86_400_000;
/** A bank balance older than this many days is still counted, with its date. */
export const BALANCE_STALE_DAYS = 3;
/** The daily report warns only when cash runs short this close to today. */
export const FORECAST_WARN_DAYS = 14;
/** `/forecast` lists at most this many bills, then "…and N more". */
export const FORECAST_REPLY_BILLS = 20;

/** One CASH account the forecast counted: its bank balance and that balance's (UTC) day. */
export interface ForecastAccount { name: string; cents: number; asOf: string }

export interface CashForecastOk {
  v: 1;
  at: string;
  ok: true;
  cashCents: number;
  lowCents: number;
  lowDate: string;
  /** The first day below $0; absent when cash lasts the window. */
  shortDate?: string;
  days: number;
  /** Full months the daily spending is averaged over: 1–3. */
  basedOnMonths: number;
  dailySpendCents: number;
  accounts: ForecastAccount[];
  bills: ForecastCharge[];
  /** CASH accounts left out because the bank sent no balance. Absent when none. */
  missing?: string[];
}

export interface CashForecastFailed { v: 1; at: string; ok: false; reason: string }

export type CashForecast = CashForecastOk | CashForecastFailed;

export type CashForecastRead =
  | { kind: 'ok'; forecast: CashForecast }
  | { kind: 'absent' }
  | { kind: 'corrupt' };

/** Why there is no forecast: one fixed sentence per cause. */
export const FORECAST_REASONS = {
  mapping: "Couldn't read your account mapping.",
  balances: "Couldn't read the bank balances.",
  accounts: "Couldn't read Wealthfolio's accounts.",
  history: "Couldn't read your spending history — it arrives with the companion's next sync.",
  bills: "Couldn't read your subscriptions and bills.",
  database: "Couldn't read Wealthfolio's database.",
  noCash: 'No cash account is mapped, so there is nothing to forecast.',
  noBalance: "The bank hasn't sent a balance for your cash accounts yet.",
  noHistory: 'Not enough history yet — the forecast needs one full month of spending.',
} as const;
export type ForecastReason = keyof typeof FORECAST_REASONS;

export function failedForecast(reason: ForecastReason, now: Date): CashForecastFailed {
  return { v: 1, at: now.toISOString(), ok: false, reason: FORECAST_REASONS[reason] };
}

const isObject = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const isInt = (x: unknown): x is number => Number.isInteger(x);
const isDay = (x: unknown): x is string =>
  typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(`${x}T00:00:00Z`));

/** The stored secret: absent when there is none, corrupt when it is not
 *  exactly a forecast this version can show — every field the views read —
 *  else the forecast. */
export function parseCashForecast(raw: string | null | undefined): CashForecastRead {
  if (raw === null || raw === undefined || raw === '') return { kind: 'absent' };
  const corrupt = { kind: 'corrupt' } as const;
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    return corrupt;
  }
  if (!isObject(v) || v.v !== 1 || typeof v.at !== 'string' || Number.isNaN(Date.parse(v.at))) return corrupt;
  if (v.ok === false) {
    return typeof v.reason === 'string' && v.reason.trim() !== '' ? { kind: 'ok', forecast: v as CashForecastFailed } : corrupt;
  }
  if (v.ok !== true) return corrupt;
  if (!isInt(v.cashCents) || !isInt(v.lowCents) || !isInt(v.dailySpendCents)) return corrupt;
  if (!isDay(v.lowDate) || (v.shortDate !== undefined && !isDay(v.shortDate))) return corrupt;
  if (!isInt(v.days) || v.days < 1 || !isInt(v.basedOnMonths) || v.basedOnMonths < 1 || v.basedOnMonths > 3) return corrupt;
  if (!Array.isArray(v.accounts) || !v.accounts.every((a: unknown) => isObject(a) && typeof a.name === 'string' && isInt(a.cents) && isDay(a.asOf))) return corrupt;
  if (!Array.isArray(v.bills) || !v.bills.every((b: unknown) => isObject(b) && typeof b.name === 'string' && isInt(b.cents) && isDay(b.date))) return corrupt;
  if (v.missing !== undefined && !(Array.isArray(v.missing) && v.missing.every((m: unknown) => typeof m === 'string'))) return corrupt;
  return { kind: 'ok', forecast: v as CashForecastOk };
}

/** True when `companionVersion` publishes the forecast. */
export function companionPublishesForecast(companionVersion: string): boolean {
  return companionVersion === CASH_FORECAST_SINCE || isNewerVersion(companionVersion, CASH_FORECAST_SINCE);
}

export function forecastIsStale(f: CashForecast, now: Date): boolean {
  return now.getTime() - Date.parse(f.at) > CASH_FORECAST_STALE_MS;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const localDay = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
const localClock = (d: Date) => {
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

// ── The app's words ─────────────────────────────────────────────────────────

export const FORECAST_TITLE = 'Next 30 days';
export const FORECAST_UPDATE_COMPANION = 'Update the companion to see this';
export const FORECAST_NOT_YET = "Arrives with the companion's next sync";
export const FORECAST_CORRUPT = "Couldn't read the forecast";
export const FORECAST_NO_BILLS = 'No known bills in the next 30 days.';
export const FORECAST_BILLS_LABEL = 'Bills it counts';
export const FORECAST_UNREACHABLE_REPLY = "Couldn't reach Wealthfolio — try again.";

/** "This forecast is from Oct 11 — the companion hasn't synced since." — the
 *  audits' stale wording, in the reader's own zone. */
export function forecastStaleLine(f: CashForecast): string {
  return `This forecast is from ${localDay(new Date(f.at))} — the companion hasn't synced since.`;
}

export type ForecastView =
  | { state: 'hidden' }
  | { state: 'update' | 'not-yet' | 'corrupt' | 'failed'; line: string }
  | { state: 'ok'; forecast: CashForecastOk; stale: boolean; status: string };

/**
 * What the Home tile shows. Hidden before the read lands and for an add-on-only
 * install (nothing published, no companion); "Update the companion to see
 * this" while the companion predates CASH_FORECAST_SINCE — the same gate as
 * the change log's Undo; otherwise the forecast, the reason there is none, or
 * that it could not be read. A stale forecast still shows, saying so.
 */
export function cashForecastView(read: CashForecastRead | null, companionVersion: string | null, now: Date): ForecastView {
  if (read === null) return { state: 'hidden' };
  if (read.kind === 'corrupt') return { state: 'corrupt', line: FORECAST_CORRUPT };
  if (read.kind === 'absent') {
    if (!companionVersion) return { state: 'hidden' };
    return companionPublishesForecast(companionVersion)
      ? { state: 'not-yet', line: FORECAST_NOT_YET }
      : { state: 'update', line: FORECAST_UPDATE_COMPANION };
  }
  const f = read.forecast;
  if (!f.ok) return { state: 'failed', line: f.reason };
  if (forecastIsStale(f, now)) return { state: 'ok', forecast: f, stale: true, status: forecastStaleLine(f) };
  const at = new Date(f.at);
  const sameDay = at.toDateString() === now.toDateString();
  return { state: 'ok', forecast: f, stale: false, status: `As of the ${sameDay ? '' : `${localDay(at)}, `}${localClock(at)} sync.` };
}

/** "If nothing comes in: $1,240 left on Nov 13" / "If nothing comes in: short around Nov 3". */
export function forecastHeadline(f: CashForecastOk): string {
  return f.shortDate
    ? `If nothing comes in: short around ${shortDate(f.shortDate)}`
    : `If nothing comes in: ${moneyWhole(f.lowCents / 100)} left on ${shortDate(f.lowDate)}`;
}

/** The tile's figure: the low point, or "Short". */
export function forecastTileValue(f: CashForecastOk): string {
  return f.shortDate ? 'Short' : moneyWhole(f.lowCents / 100);
}

/** The tile's line under the figure. */
export function forecastTileSub(f: CashForecastOk): string {
  return f.shortDate
    ? `around ${shortDate(f.shortDate)} if nothing comes in`
    : `left on ${shortDate(f.lowDate)} if nothing comes in`;
}

export function forecastCashLine(f: CashForecastOk): string {
  return `Cash today: ${rosterMoney(f.cashCents)}`;
}

/** "PNC Checking · $2,481.07", plus " · Balance from Oct 9" when the bank's
 *  balance is more than BALANCE_STALE_DAYS older than the forecast. Raw. */
export function forecastAccountLine(a: ForecastAccount, f: CashForecastOk): string {
  const old = daysBetween(a.asOf, f.at.slice(0, 10)) > BALANCE_STALE_DAYS;
  return `${a.name} · ${rosterMoney(a.cents)}${old ? ` · Balance from ${shortDate(a.asOf)}` : ''}`;
}

/** A CASH account the forecast had to leave out. Raw. */
export function forecastMissingLine(name: string): string {
  return `${name} · left out: the bank hasn't sent a balance`;
}

/** "Oct 20 · Netflix · $15.49". Raw. */
export function forecastBillLine(b: ForecastCharge): string {
  return `${shortDate(b.date)} · ${b.name} · ${rosterMoney(b.cents)}`;
}

/** The assumption, stated: no income, the bills, and the daily figure with
 *  the months it comes from — "based on N months" while there are fewer
 *  than three. */
export function forecastAssumption(f: CashForecastOk): string {
  const n = f.basedOnMonths;
  const basis = n >= 3 ? `your last ${n} months` : `based on ${n} ${n === 1 ? 'month' : 'months'}`;
  return `Assumes no income, your known bills on their dates, and about ${moneyWhole(f.dailySpendCents / 100)} a day of other spending (${basis}).`;
}

// ── Telegram ────────────────────────────────────────────────────────────────

/** A report header's glyph: shown in `glyphs` mode only, like every report's. */
const glyph = (g: string, style: GlyphStyle) => (style.mode === 'glyphs' ? `${g} ` : '');

/** The one-line forecast: the weekly check-in's line and `/forecast`'s first.
 *  The 🔮 follows the report glyph style; ⚠️ is an alarm and always shows. */
export function forecastTelegramLine(f: CashForecastOk, style: GlyphStyle): string {
  return f.shortDate
    ? `⚠️ Next 30 days: cash may run short around ${shortDate(f.shortDate)} if nothing comes in.`
    : `${glyph('🔮', style)}Next 30 days: ${moneyWhole(f.lowCents / 100)} left at the low point (${shortDate(f.lowDate)}) if nothing comes in.`;
}

/** The weekly check-in's line (Full detail): from a fresh forecast only. */
export function weeklyForecastLine(read: CashForecastRead | null, now: Date, style: GlyphStyle): string | null {
  if (read?.kind !== 'ok' || !read.forecast.ok || forecastIsStale(read.forecast, now)) return null;
  return forecastTelegramLine(read.forecast, style);
}

/** The daily report's warning, Brief and Full alike: only when a fresh
 *  forecast runs short within FORECAST_WARN_DAYS of `today`. */
export function forecastWarningLine(read: CashForecastRead | null, today: string, now: Date): string | null {
  if (read?.kind !== 'ok' || !read.forecast.ok || forecastIsStale(read.forecast, now)) return null;
  const short = read.forecast.shortDate;
  if (!short) return null;
  const days = daysBetween(today, short);
  if (days < 0 || days > FORECAST_WARN_DAYS) return null;
  return `⚠️ Cash may run short around ${shortDate(short)} if nothing comes in.`;
}

/** `/forecast`'s reply: the line, the cash it counted, the bills (escaped,
 *  outside every entity) and the assumption. */
export function formatForecastReply(read: CashForecastRead, now: Date, style: GlyphStyle): string {
  if (read.kind === 'corrupt') return "Couldn't read the forecast — the companion writes a new one after its next sync.";
  if (read.kind === 'absent') return "The forecast arrives with the companion's next sync.";
  const f = read.forecast;
  if (!f.ok) return `No forecast right now: ${escapeMarkdown(f.reason)}`;
  const lines = [forecastTelegramLine(f, style), '', escapeMarkdown(forecastCashLine(f))];
  for (const a of f.accounts) lines.push(escapeMarkdown(forecastAccountLine(a, f)));
  for (const name of f.missing ?? []) lines.push(escapeMarkdown(forecastMissingLine(name)));
  lines.push('', `*${FORECAST_BILLS_LABEL}*`);
  if (f.bills.length === 0) lines.push(FORECAST_NO_BILLS);
  for (const b of f.bills.slice(0, FORECAST_REPLY_BILLS)) lines.push(escapeMarkdown(forecastBillLine(b)));
  const more = f.bills.length - FORECAST_REPLY_BILLS;
  if (more > 0) lines.push(`…and ${more} more`);
  lines.push('', forecastAssumption(f));
  if (forecastIsStale(f, now)) lines.push('', `⚠️ ${forecastStaleLine(f)}`);
  return lines.join('\n');
}
