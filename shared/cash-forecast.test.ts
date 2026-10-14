import { describe, it, expect } from 'vitest';
import {
  cashForecastView, companionPublishesForecast, failedForecast, forecastAccountLine, forecastAssumption, forecastBillLine,
  forecastCashLine, forecastHeadline, forecastMissingLine, forecastTelegramLine, forecastTileSub, forecastTileValue,
  forecastWarningLine, formatForecastReply, parseCashForecast, weeklyForecastLine,
  CASH_FORECAST_SINCE, FORECAST_CORRUPT, FORECAST_NOT_YET, FORECAST_REASONS, FORECAST_UPDATE_COMPANION,
  type CashForecastOk, type CashForecastRead,
} from './cash-forecast';
import { escapeMarkdown, type GlyphStyle } from './telegram';
import { isNewerVersion, SIMPLEFIN_SYNC_VERSION } from './version';

const CLEAN: GlyphStyle = { mode: 'clean', overrides: {} };
const GLYPHS: GlyphStyle = { mode: 'glyphs', overrides: {} };
/** The spec's example: $1,240 left on Nov 13, from a forecast made Oct 14. */
const FORECAST = (over: Partial<CashForecastOk> = {}): CashForecastOk => ({
  v: 1, at: '2026-10-14T18:00:00.000Z', ok: true, cashCents: 248107, lowCents: 124000, lowDate: '2026-11-13',
  days: 30, basedOnMonths: 3, dailySpendCents: 4210,
  accounts: [{ name: 'PNC Checking', cents: 248107, asOf: '2026-10-14' }],
  bills: [{ name: 'Netflix', date: '2026-10-20', cents: 1549 }, { name: 'Rent', date: '2026-11-01', cents: 120000 }],
  ...over,
});
const SHORT = (over: Partial<CashForecastOk> = {}) => FORECAST({ lowCents: -30000, shortDate: '2026-11-03', ...over });
const ok = (f: CashForecastOk | ReturnType<typeof failedForecast>): CashForecastRead => ({ kind: 'ok', forecast: f });
/** Local 2:00 PM, Oct 13 — the status lines are in the reader's own zone. */
const AT_LOCAL = new Date(2026, 9, 13, 14, 0);

describe('parseCashForecast', () => {
  it('reads a forecast and a forecast that could not be made', () => {
    expect(parseCashForecast(JSON.stringify(FORECAST()))).toEqual({ kind: 'ok', forecast: FORECAST() });
    const failed = failedForecast('noHistory', new Date('2026-10-14T18:00:00Z'));
    expect(failed).toEqual({ v: 1, at: '2026-10-14T18:00:00.000Z', ok: false, reason: FORECAST_REASONS.noHistory });
    expect(parseCashForecast(JSON.stringify(failed))).toEqual({ kind: 'ok', forecast: failed });
  });

  it('tells none published from one it cannot read', () => {
    expect(parseCashForecast(null)).toEqual({ kind: 'absent' });
    expect(parseCashForecast('')).toEqual({ kind: 'absent' });
    expect(parseCashForecast('{oops')).toEqual({ kind: 'corrupt' });
  });

  it.each<[string, unknown]>([
    ['another version', { ...FORECAST(), v: 2 }],
    ['no ok flag', { ...FORECAST(), ok: undefined }],
    ['a failure with no reason', { v: 1, at: '2026-10-14T18:00:00.000Z', ok: false, reason: ' ' }],
    ['cents with a fraction', { ...FORECAST(), lowCents: 12.5 }],
    ['a low date that is not a day', { ...FORECAST(), lowDate: 'Nov 13' }],
    ['a short date that is not a day', { ...FORECAST(), shortDate: '2026-13-01' }],
    ['no months of history', { ...FORECAST(), basedOnMonths: 0 }],
    ['four months of history', { ...FORECAST(), basedOnMonths: 4 }],
    ['an account without cents', { ...FORECAST(), accounts: [{ name: 'PNC', cents: '1', asOf: '2026-10-14' }] }],
    ['a bill without a date', { ...FORECAST(), bills: [{ name: 'Rent', cents: 100 }] }],
    ['a missing list that is not names', { ...FORECAST(), missing: [3] }],
    ['an unreadable time', { ...FORECAST(), at: 'yesterday' }],
  ])('is corrupt — never a number — for %s', (_what, value) => {
    expect(parseCashForecast(JSON.stringify(value))).toEqual({ kind: 'corrupt' });
  });

  // JSON has no NaN or Infinity: they arrive as null (JSON.stringify) or as an
  // overflowing literal (1e999 parses to Infinity). Neither may become a number.
  it.each(['cashCents', 'lowCents', 'dailySpendCents'])('is corrupt when %s is null, NaN or Infinity', (field) => {
    const base = JSON.stringify(FORECAST());
    const at = (literal: string) => base.replace(new RegExp(`"${field}":\\d+`), `"${field}":${literal}`);
    expect(at('1e999')).not.toBe(base);
    for (const literal of ['null', 'NaN', '1e999', '-1e999']) expect(parseCashForecast(at(literal))).toEqual({ kind: 'corrupt' });
    expect(parseCashForecast(JSON.stringify({ ...FORECAST(), [field]: Number.NaN }))).toEqual({ kind: 'corrupt' });
    expect(parseCashForecast(JSON.stringify({ ...FORECAST(), [field]: Number.POSITIVE_INFINITY }))).toEqual({ kind: 'corrupt' });
  });

  it.each([
    ['a bill', { bills: [{ name: 'Rent', date: '2026-11-01', cents: null }] }],
    ['a bill', { bills: [{ name: 'Rent', date: '2026-11-01', cents: Number.POSITIVE_INFINITY }] }],
    ['an account', { accounts: [{ name: 'PNC', cents: null, asOf: '2026-10-14' }] }],
    ['an account', { accounts: [{ name: 'PNC', cents: Number.NaN, asOf: '2026-10-14' }] }],
  ])('is corrupt when the cents of %s are not a finite number', (_what, over) => {
    expect(parseCashForecast(JSON.stringify({ ...FORECAST(), ...over }))).toEqual({ kind: 'corrupt' });
  });
});

describe('the version gate', () => {
  it('opens at the release that publishes the forecast', () => {
    expect(companionPublishesForecast(CASH_FORECAST_SINCE)).toBe(true);
    expect(companionPublishesForecast('9.0.0')).toBe(true);
    expect(companionPublishesForecast('1.60.0')).toBe(false);
    expect(companionPublishesForecast('garbage')).toBe(false);
  });

  it('is never above the version this build ships as, once it ships past 1.60.0', () => {
    // A release that ships the forecast below CASH_FORECAST_SINCE would tell
    // its own companion's users to update forever: lower the constant to it.
    if (isNewerVersion(SIMPLEFIN_SYNC_VERSION, '1.60.0')) {
      expect(isNewerVersion(CASH_FORECAST_SINCE, SIMPLEFIN_SYNC_VERSION)).toBe(false);
    }
  });
});

describe('cashForecastView', () => {
  const LATER = new Date(2026, 9, 13, 18, 30);

  it('is hidden before the read lands, and with nothing published and no companion', () => {
    expect(cashForecastView(null, '1.61.0', LATER)).toEqual({ state: 'hidden' });
    expect(cashForecastView({ kind: 'absent' }, null, LATER)).toEqual({ state: 'hidden' });
  });

  it('says to update an older companion, and that a new one has not synced yet', () => {
    expect(cashForecastView({ kind: 'absent' }, '1.60.0', LATER)).toEqual({ state: 'update', line: FORECAST_UPDATE_COMPANION });
    expect(cashForecastView({ kind: 'absent' }, '1.61.0', LATER)).toEqual({ state: 'not-yet', line: FORECAST_NOT_YET });
  });

  it('says it could not read the forecast, or why there is none', () => {
    expect(cashForecastView({ kind: 'corrupt' }, '1.61.0', LATER)).toEqual({ state: 'corrupt', line: FORECAST_CORRUPT });
    expect(cashForecastView(ok(failedForecast('balances', AT_LOCAL)), '1.61.0', LATER))
      .toEqual({ state: 'failed', line: "Couldn't read the bank balances." });
  });

  it('says when it was made, and that a two-day-old one is out of date', () => {
    const f = FORECAST({ at: AT_LOCAL.toISOString() });
    expect(cashForecastView(ok(f), '1.61.0', LATER)).toEqual({ state: 'ok', forecast: f, stale: false, status: 'As of the 2:00 PM sync.' });
    expect(cashForecastView(ok(f), '1.61.0', new Date(2026, 9, 14, 9, 0)))
      .toMatchObject({ stale: false, status: 'As of the Oct 13, 2:00 PM sync.' });
    expect(cashForecastView(ok(f), '1.61.0', new Date(2026, 9, 16, 9, 0)))
      .toMatchObject({ state: 'ok', stale: true, status: "This forecast is from Oct 13 — the companion hasn't synced since." });
  });
});

describe('the app’s words', () => {
  it('says the spec’s two headlines', () => {
    expect(forecastHeadline(FORECAST())).toBe('If nothing comes in: $1,240 left on Nov 13');
    expect(forecastHeadline(SHORT())).toBe('If nothing comes in: short around Nov 3');
    expect([forecastTileValue(FORECAST()), forecastTileSub(FORECAST())]).toEqual(['$1,240', 'left on Nov 13 if nothing comes in']);
    expect([forecastTileValue(SHORT()), forecastTileSub(SHORT())]).toEqual(['Short', 'around Nov 3 if nothing comes in']);
  });

  it('lists the cash it counted, dating a balance more than three days old, and what it left out', () => {
    const f = FORECAST();
    expect(forecastCashLine(f)).toBe('Cash today: $2,481.07');
    expect(forecastAccountLine({ name: 'PNC Checking', cents: 248107, asOf: '2026-10-11' }, f)).toBe('PNC Checking · $2,481.07');
    expect(forecastAccountLine({ name: 'Savings', cents: 50000, asOf: '2026-10-10' }, f)).toBe('Savings · $500 · Balance from Oct 10');
    expect(forecastMissingLine('Joint')).toBe("Joint · left out: the bank hasn't sent a balance");
    expect(forecastBillLine(f.bills[0])).toBe('Oct 20 · Netflix · $15.49');
  });

  it('keeps bank text raw', () => {
    expect(forecastAccountLine({ name: "Joe's *Visa*_[1]", cents: 100, asOf: '2026-10-14' }, FORECAST())).toBe("Joe's *Visa*_[1] · $1");
    expect(forecastBillLine({ name: 'SQ *COFFEE_CLUB', date: '2026-10-20', cents: 450 })).toBe('Oct 20 · SQ *COFFEE_CLUB · $4.50');
  });

  it('states the assumption, with "based on N months" while there are fewer than three', () => {
    expect(forecastAssumption(FORECAST()))
      .toBe('Assumes no income, your known bills on their dates, and about $42 a day of other spending (your last 3 months).');
    expect(forecastAssumption(FORECAST({ basedOnMonths: 2 }))).toMatch(/other spending \(based on 2 months\)\.$/);
    expect(forecastAssumption(FORECAST({ basedOnMonths: 1 }))).toMatch(/other spending \(based on 1 month\)\.$/);
  });
});

describe('Telegram', () => {
  const NOW = new Date('2026-10-14T19:00:00Z');

  it('says the forecast in one line: 🔮 with glyphs, ⚠️ always when cash runs short', () => {
    expect(forecastTelegramLine(FORECAST(), CLEAN)).toBe('Next 30 days: $1,240 left at the low point (Nov 13) if nothing comes in.');
    expect(forecastTelegramLine(FORECAST(), GLYPHS)).toBe('🔮 Next 30 days: $1,240 left at the low point (Nov 13) if nothing comes in.');
    expect(forecastTelegramLine(SHORT(), CLEAN)).toBe('⚠️ Next 30 days: cash may run short around Nov 3 if nothing comes in.');
  });

  it('gives the weekly check-in a line only from a fresh forecast', () => {
    expect(weeklyForecastLine(ok(FORECAST()), NOW, GLYPHS)).toBe(forecastTelegramLine(FORECAST(), GLYPHS));
    expect(weeklyForecastLine(ok(FORECAST()), new Date('2026-10-17T19:00:00Z'), GLYPHS)).toBeNull();
    expect(weeklyForecastLine(ok(failedForecast('noCash', NOW)), NOW, GLYPHS)).toBeNull();
    expect(weeklyForecastLine({ kind: 'absent' }, NOW, GLYPHS)).toBeNull();
    expect(weeklyForecastLine({ kind: 'corrupt' }, NOW, GLYPHS)).toBeNull();
    expect(weeklyForecastLine(null, NOW, GLYPHS)).toBeNull();
  });

  it('warns the daily report at exactly 14 days before cash runs short, not at 15', () => {
    const read = ok(SHORT({ shortDate: '2026-10-28' }));
    expect(forecastWarningLine(read, '2026-10-14', NOW)).toBe('⚠️ Cash may run short around Oct 28 if nothing comes in.');
    expect(forecastWarningLine(ok(SHORT({ shortDate: '2026-10-29' })), '2026-10-14', NOW)).toBeNull();
    expect(forecastWarningLine(ok(SHORT({ shortDate: '2026-10-14' })), '2026-10-14', NOW)).toBe('⚠️ Cash may run short around Oct 14 if nothing comes in.');
  });

  it('does not warn without a short date, from an old forecast, or about a day already past', () => {
    expect(forecastWarningLine(ok(FORECAST()), '2026-10-14', NOW)).toBeNull();
    expect(forecastWarningLine(ok(SHORT({ shortDate: '2026-10-20' })), '2026-10-14', new Date('2026-10-17T19:00:00Z'))).toBeNull();
    expect(forecastWarningLine(ok(SHORT({ shortDate: '2026-10-13' })), '2026-10-14', NOW)).toBeNull();
    expect(forecastWarningLine({ kind: 'corrupt' }, '2026-10-14', NOW)).toBeNull();
  });

  it('/forecast: the line, the cash counted, the bills and the assumption', () => {
    expect(formatForecastReply(ok(FORECAST()), NOW, CLEAN)).toBe([
      'Next 30 days: $1,240 left at the low point (Nov 13) if nothing comes in.',
      '',
      'Cash today: $2,481.07',
      'PNC Checking · $2,481.07',
      '',
      '*Bills it counts*',
      'Oct 20 · Netflix · $15.49',
      'Nov 1 · Rent · $1,200',
      '',
      'Assumes no income, your known bills on their dates, and about $42 a day of other spending (your last 3 months).',
    ].join('\n'));
  });

  it('/forecast escapes bank text and keeps it out of every entity', () => {
    const f = FORECAST({
      accounts: [{ name: "Joe's *Visa*_[1]", cents: 248107, asOf: '2026-10-14' }],
      bills: [{ name: 'SQ *COFFEE_CLUB', date: '2026-10-20', cents: 450 }],
      missing: ['Joint_2'],
    });
    const text = formatForecastReply(ok(f), NOW, CLEAN);
    expect(text).toContain(`\n${escapeMarkdown("Joe's *Visa*_[1]")} · $2,481.07\n`);
    expect(text).toContain("\nJoint\\_2 · left out: the bank hasn't sent a balance\n");
    expect(text).toContain('\nOct 20 · SQ \\*COFFEE\\_CLUB · $4.50\n');
    // Only the fixed heading is an entity; every special left is escaped.
    expect(text.replace('*Bills it counts*', '').replace(/\\[_*`[]/g, '')).not.toMatch(/[_*`[]/);
  });

  it('/forecast lists twenty bills, then how many more', () => {
    const bills = Array.from({ length: 23 }, (_, i) => ({ name: `Bill ${i + 1}`, date: '2026-10-20', cents: 100 }));
    const text = formatForecastReply(ok(FORECAST({ bills })), NOW, CLEAN);
    expect(text).toContain('Oct 20 · Bill 20 · $1\n…and 3 more');
    expect(text).not.toContain('Bill 21');
  });

  it('/forecast says why there is none, that one is coming, that it cannot be read, and when it is old', () => {
    expect(formatForecastReply(ok(failedForecast('noCash', NOW)), NOW, CLEAN))
      .toBe('No forecast right now: No cash account is mapped, so there is nothing to forecast.');
    expect(formatForecastReply({ kind: 'absent' }, NOW, CLEAN)).toBe("The forecast arrives with the companion's next sync.");
    expect(formatForecastReply({ kind: 'corrupt' }, NOW, CLEAN))
      .toBe("Couldn't read the forecast — the companion writes a new one after its next sync.");
    const old = formatForecastReply(ok(FORECAST({ at: AT_LOCAL.toISOString() })), new Date(2026, 9, 16, 9, 0), CLEAN);
    expect(old.endsWith("\n\n⚠️ This forecast is from Oct 13 — the companion hasn't synced since.")).toBe(true);
  });
});
