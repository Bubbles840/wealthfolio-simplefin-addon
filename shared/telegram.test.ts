import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendTelegramMessage, formatDailySpendingDigest, formatMonthlyRemainingSummary, formatMonthlyWrapUp, formatSyncHealthFooter, escapeMarkdown, weeklyEnvelope, moneyWhole, formatLargeTransactionAlert, formatBalanceDriftAlert, formatStuckTransferAlert, formatDuplicatePruneAlert, formatImportNotice } from './telegram.js';

/**
 * Every expectation written before 1.7.0 was against the glyph style, which is no
 * longer the default. They now pass it EXPLICITLY rather than being rewritten to
 * the clean output, so both styles stay pinned: switching the toggle cannot
 * silently break the mode nobody is looking at.
 */
const GLYPHS = { mode: 'glyphs' as const, overrides: {} };
const dailyGlyphs = (c: Parameters<typeof formatDailySpendingDigest>[0], p: Parameters<typeof formatDailySpendingDigest>[1]) =>
  formatDailySpendingDigest(c, p, GLYPHS);
const weeklyGlyphs = (spent: number, budget: number, top?: Parameters<typeof formatMonthlyRemainingSummary>[2]) =>
  formatMonthlyRemainingSummary(spent, budget, top ?? [], GLYPHS);
const wrapUpGlyphs = (c: Parameters<typeof formatMonthlyWrapUp>[0], m: string) =>
  formatMonthlyWrapUp(c, m, GLYPHS);
import { buildDismissKeyboard, formatFeedLagNotice, CATEGORIZE_ENTRY_CALLBACK, RECATEGORIZE_ENTRY_CALLBACK } from './telegram.js';
import type { ImportNoticeTx, UncategorizedTx } from './telegram.js';
import { MENU_CALLBACK_PREFIX } from './categorize-menu.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => mockFetch.mockReset());

describe('formatImportNotice', () => {
  const tx = (over: Partial<ImportNoticeTx> = {}): ImportNoticeTx => ({
    description: 'TRADER JOE S #628',
    amountCents: 6774,
    currency: 'USD',
    accountName: 'Spend (4937)',
    pending: false,
    inTransit: false,
    ...over,
  });
  const uncat = (over: Partial<UncategorizedTx> = {}): UncategorizedTx => ({
    description: 'VENMO PAYMENT',
    amountCents: 4516,
    date: '2026-07-09',
    accountName: 'Spend (4937)',
    ...over,
  });

  it('lists each transaction with amount, description, and account', () => {
    const text = formatImportNotice([tx(), tx({ description: 'NETFLIX.COM', amountCents: 2258, accountName: 'Citi' })], []);
    expect(text).toContain('*2 new transactions*');
    expect(text).toContain('• $67.74  TRADER JOE S #628 — Spend (4937)');
    expect(text).toContain('• $22.58  NETFLIX.COM — Citi');
  });

  it('uses the singular for one transaction', () => {
    expect(formatImportNotice([tx()], [])).toContain('*1 new transaction*');
  });

  it('marks pending and in-transit rows', () => {
    const text = formatImportNotice(
      [tx({ pending: true }), tx({ description: 'XFER', inTransit: true })],
      [],
    );
    expect(text).toContain('TRADER JOE S #628 — Spend (4937) · pending');
    expect(text).toContain('XFER — Spend (4937) · in transit');
  });

  it('caps the list at 10 lines with a +N more tail', () => {
    const many = Array.from({ length: 13 }, (_, i) => tx({ description: `TX ${i}` }));
    const text = formatImportNotice(many, []);
    expect(text.match(/^• /gm)).toHaveLength(10);
    expect(text).toContain('+3 more');
  });

  it('omits the needs-a-category section entirely when there is nothing to nag about', () => {
    expect(formatImportNotice([tx()], [])).not.toContain('Needs a category');
  });

  it('lists uncategorized transactions with their date, capped at 5', () => {
    const six = Array.from({ length: 6 }, (_, i) => uncat({ description: `ROW ${i}`, date: `2026-07-0${i + 1}` }));
    const text = formatImportNotice([tx()], six);
    expect(text).toContain('🏷️ *Needs a category* (6):');
    expect(text).toContain('• $45.16  ROW 0 · Jul 1 — Spend (4937)');
    expect(text).toContain('+1 more');
  });

  it('escapes Markdown in every bank-supplied string, outside any entity', () => {
    const text = formatImportNotice(
      [tx({ description: 'AMAZON_MKTPL*X1', accountName: 'My_Spend' })],
      [uncat({ description: 'VENMO *DYLAN_W' })],
    );
    expect(text).toContain('AMAZON\\_MKTPL\\*X1');
    expect(text).toContain('My\\_Spend');
    expect(text).toContain('VENMO \\*DYLAN\\_W');
  });

  describe('where each import was filed', () => {
    it('appends the category a row was filed under, keyed by txId', () => {
      const text = formatImportNotice(
        [tx({ txId: 'tx-a' })],
        [],
        new Map([['tx-a', 'Groceries']]),
      );
      expect(text).toContain('• $67.74  TRADER JOE S #628 — Spend (4937) → filed under Groceries');
    });

    it('renders a row with no mapping byte-identically to a notice with no map at all', () => {
      // The whole point of the optional parameter: every caller and every notice
      // that predates this feature must be unchanged, and a row a rule did not
      // file must not grow a dangling "filed under" with nothing after it.
      const rows = [tx({ txId: 'tx-a' }), tx({ txId: 'tx-b', description: 'NETFLIX.COM' })];
      const uncategorized = [uncat()];
      const withMap = formatImportNotice(rows, uncategorized, new Map([['tx-zzz', 'Groceries']]));
      expect(withMap).toBe(formatImportNotice(rows, uncategorized));
      expect(withMap).not.toContain('filed under');
    });

    it('ignores a txId-less row rather than looking one up under undefined', () => {
      // `txId` is optional on the type; a caller that has not threaded it through
      // must get today's line, not a lookup on `undefined`.
      const text = formatImportNotice([tx()], [], new Map([['tx-a', 'Groceries']]));
      expect(text).not.toContain('filed under');
    });

    it('keeps the pending marker before the category, so the state reads first', () => {
      const text = formatImportNotice(
        [tx({ txId: 'tx-a', pending: true })],
        [],
        new Map([['tx-a', 'Groceries']]),
      );
      expect(text).toContain('— Spend (4937) · pending → filed under Groceries');
    });

    it('escapes the category name, which is user-typed like every other name here', () => {
      // A category called `Food_Dining` would otherwise open a Markdown entity
      // and get the WHOLE notice refused by Telegram — the notice is the message
      // that must arrive.
      const text = formatImportNotice([tx({ txId: 'tx-a' })], [], new Map([['tx-a', 'Food_Dining*']]));
      expect(text).toContain('→ filed under Food\\_Dining\\*');
    });
  });
});

describe('subcategory breakdown', () => {
  const period = { daysFromWeekStartToMonthEnd: 26, daysLeftInMonthInclusive: 20 };
  const withChildren = [{
    name: 'Transportation', budget: 300, monthSpent: 120, weekSpent: 40,
    children: [
      { name: 'Gas & Fuel', monthSpent: 71 },
      { name: 'Parking', monthSpent: 34 },
      { name: 'Car Maintenance', monthSpent: 15 },
    ],
  }];

  it('ignores children by default, so the long-standing rollup output is unchanged', () => {
    const text = formatDailySpendingDigest(withChildren, period);
    expect(text).toContain('Transportation');
    expect(text).not.toContain('Gas & Fuel');
  });

  it('lists children indented under the parent when asked to break down', () => {
    const text = formatDailySpendingDigest(withChildren, period, undefined, 'breakdown');
    // Parent keeps its envelope line; children are spend-only, because the budget
    // lives on the parent.
    expect(text).toContain('Transportation');
    expect(text).toMatch(/ {3}Gas & Fuel {2}\$71/);
    expect(text).toMatch(/ {3}Parking {2}\$34/);
  });

  it('orders children by spend, biggest first — the useful order for "where did it go"', () => {
    const text = formatDailySpendingDigest(withChildren, period, undefined, 'breakdown');
    expect(text.indexOf('Gas & Fuel')).toBeLessThan(text.indexOf('Parking'));
    expect(text.indexOf('Parking')).toBeLessThan(text.indexOf('Car Maintenance'));
  });

  it('omits a child that spent nothing, and the whole block when none did', () => {
    const text = formatDailySpendingDigest(
      [{ name: 'Transportation', budget: 300, monthSpent: 71, weekSpent: 0,
         children: [{ name: 'Gas & Fuel', monthSpent: 71 }, { name: 'Parking', monthSpent: 0 }] }],
      period, undefined, 'breakdown',
    );
    expect(text).toContain('Gas & Fuel');
    expect(text).not.toContain('Parking');
  });
});

describe('glyph style', () => {
  const period = { daysFromWeekStartToMonthEnd: 26, daysLeftInMonthInclusive: 20 };
  const cats = [
    { name: 'Groceries', budget: 300, monthSpent: 67, weekSpent: 20 },
    { name: 'Shopping', budget: 0, monthSpent: 40, weekSpent: 40 },
  ];

  /**
   * `clean` is the default because the decorative glyphs were the complaint:
   * a sun over a spending report, a moneybag on the summary, a label on every
   * category line. Glyphs that encode STATE survive — being over budget is
   * information, and stripping it would cost the reader something.
   */
  it('renders no decorative glyphs by default, keeping only the ones that mean something', () => {
    const over = formatDailySpendingDigest(
      [{ name: 'Bills', budget: 350, monthSpent: 400, weekSpent: 0 }], period,
    );
    expect(over).not.toContain('☀️');
    expect(over).not.toContain('💰');
    expect(over).not.toContain('📅');
    // State, not decoration.
    expect(over).toContain('🚨');
  });

  it('keeps every glyph when the style asks for them', () => {
    const text = formatDailySpendingDigest(cats, period, { mode: 'glyphs', overrides: {} });
    expect(text).toContain('☀️');
    expect(text).toContain('🛒'); // Groceries, from the keyword defaults
  });

  it('applies overrides only in glyphs mode, so clean means clean', () => {
    // Overrides used to apply in either mode. That made `clean` a lie — a report
    // could carry glyphs while the setting said none — and it made the addon
    // choose between showing a per-category input that does nothing in the
    // default mode, or hiding a setting that still had an effect. One rule is
    // simpler to hold: clean has no glyphs at all.
    const overrides = { Groceries: '🥕' };
    expect(formatDailySpendingDigest(cats, period, { mode: 'clean', overrides }))
      .not.toContain('🥕');
    const glyphs = formatDailySpendingDigest(cats, period, { mode: 'glyphs', overrides });
    expect(glyphs).toContain('🥕 Groceries');
    // The override replaces that category's default, and only that one.
    expect(glyphs).not.toContain('🛒');
    expect(glyphs).toContain('🛍️ Shopping');
  });

  it('applies the style to the weekly check-in and monthly wrap-up headers too', () => {
    expect(formatMonthlyRemainingSummary(40, 100)).not.toContain('📊');
    expect(formatMonthlyRemainingSummary(40, 100)).not.toContain('💰');
    expect(formatMonthlyRemainingSummary(40, 100, [], { mode: 'glyphs', overrides: {} }))
      .toContain('📊');

    const wrapCats = [{ name: 'Groceries', budget: 300, spent: 250 }];
    expect(formatMonthlyWrapUp(wrapCats, 'July')).not.toContain('📅');
    expect(formatMonthlyWrapUp(wrapCats, 'July', { mode: 'glyphs', overrides: {} }))
      .toContain('📅');
  });

  it('leaves alert messages alone — they are not reports', () => {
    // The drift/stuck/feed-lag alerts carry state glyphs only, so the style has
    // no business touching them.
    expect(formatFeedLagNotice({
      accountName: 'Spend', driftAmount: 490.75, currency: 'USD', bankBalance: 3965.98,
    })).toContain('⏳');
  });
});

describe('formatFeedLagNotice', () => {
  it('reads as informational — no alarm emoji, no instruction to adjust', () => {
    const text = formatFeedLagNotice({
      accountName: 'Spend (4937)',
      driftAmount: 490.75,
      currency: 'USD',
      bankBalance: 3965.98,
    });
    expect(text).toContain('⏳');
    expect(text).toContain('Spend (4937)');
    expect(text).toContain('$490.75');
    expect(text).toMatch(/clears? .* on its own|usually clears/i);
    expect(text).not.toContain('🚨');
    expect(text).not.toMatch(/adjust|add \$/i);
  });

  it('escapes Markdown in the account name, outside any entity', () => {
    const text = formatFeedLagNotice({
      accountName: 'My_Spend', driftAmount: -12.5, currency: 'USD', bankBalance: 100,
    });
    expect(text).toContain('My\\_Spend');
  });
});

describe('buildDismissKeyboard', () => {
  it('builds one button per row, keyed d:<activityId>, within the 64-byte callback limit', () => {
    const kb = buildDismissKeyboard([
      { activityId: 'a'.repeat(36), description: 'VENMO PAYMENT LONG DESCRIPTION HERE', amountCents: 4516 },
      { activityId: 'b-2', description: 'CHECK', amountCents: 2258 },
    ]);
    // Two dismiss rows plus the appended `Categorize these` row (below).
    expect(kb.inline_keyboard).toHaveLength(3);
    expect(kb.inline_keyboard[0][0].callback_data).toBe(`d:${'a'.repeat(36)}`);
    expect(Buffer.byteLength(kb.inline_keyboard[0][0].callback_data)).toBeLessThanOrEqual(64);
    expect(kb.inline_keyboard[1][0].text).toContain('CHECK');
    expect(kb.inline_keyboard[1][0].text).toContain('$22.58');
  });

  it('appends one full-width Categorize these row, after the dismiss buttons', () => {
    const kb = buildDismissKeyboard([
      { activityId: 'act-1', description: 'VENMO PAYMENT', amountCents: 4516 },
    ]);
    // The dismiss buttons and their payloads are frozen; this is an APPEND.
    expect(kb.inline_keyboard[0]).toEqual([
      { text: 'Dismiss: VENMO PAYMENT $45.16', callback_data: 'd:act-1' },
    ]);
    expect(kb.inline_keyboard.at(-1)).toEqual([
      { text: 'Categorize these', callback_data: CATEGORIZE_ENTRY_CALLBACK },
    ]);
    expect(kb.inline_keyboard).toHaveLength(2);
  });

  it('adds no Categorize these row when there is nothing to list', () => {
    // "Categorize these" with no `these` is a button that can only disappoint.
    expect(buildDismissKeyboard([])).toEqual({ inline_keyboard: [] });
  });

  it('uses a payload the listener routes to the menu controller', () => {
    // The listener sends `cz:`-prefixed callbacks to `onMenuCallback` and
    // everything else to the dismissal path; a payload that missed this prefix
    // would be a button that silently does nothing.
    expect(CATEGORIZE_ENTRY_CALLBACK.startsWith(MENU_CALLBACK_PREFIX)).toBe(true);
    expect(CATEGORIZE_ENTRY_CALLBACK).toBe('cz:open');
    expect(Buffer.byteLength(CATEGORIZE_ENTRY_CALLBACK)).toBeLessThanOrEqual(64);
  });

  it('appends a Recategorize row LAST when asked, leaving every frozen row where it was', () => {
    const rows = [{ activityId: 'act-1', description: 'VENMO PAYMENT', amountCents: 4516 }];
    const kb = buildDismissKeyboard(rows, true);
    expect(kb.inline_keyboard).toHaveLength(3);
    // Frozen: same dismiss button, same payload, same `Categorize these` row in
    // the same position it has always been in.
    expect(kb.inline_keyboard[0]).toEqual([
      { text: 'Dismiss: VENMO PAYMENT $45.16', callback_data: 'd:act-1' },
    ]);
    expect(kb.inline_keyboard[1]).toEqual([
      { text: 'Categorize these', callback_data: CATEGORIZE_ENTRY_CALLBACK },
    ]);
    expect(kb.inline_keyboard[2]).toEqual([
      { text: 'Recategorize', callback_data: RECATEGORIZE_ENTRY_CALLBACK },
    ]);
  });

  it('omits the Recategorize row unless asked, so today\'s notices are unchanged', () => {
    const rows = [{ activityId: 'act-1', description: 'VENMO PAYMENT', amountCents: 4516 }];
    expect(buildDismissKeyboard(rows)).toEqual(buildDismissKeyboard(rows, false));
    expect(JSON.stringify(buildDismissKeyboard(rows))).not.toContain('Recategorize');
  });

  it('offers Recategorize even with nothing to dismiss — the two conditions are independent', () => {
    // `Categorize these` needs `these`; `Recategorize` needs a row this import
    // FILED, which is a different question. An import that a rule filed
    // completely leaves nothing uncategorized and is exactly the case where
    // moving one of those filings is what the reader wants.
    expect(buildDismissKeyboard([], true)).toEqual({
      inline_keyboard: [[{ text: 'Recategorize', callback_data: RECATEGORIZE_ENTRY_CALLBACK }]],
    });
  });

  it('routes the Recategorize payload to the menu controller too', () => {
    expect(RECATEGORIZE_ENTRY_CALLBACK.startsWith(MENU_CALLBACK_PREFIX)).toBe(true);
    expect(RECATEGORIZE_ENTRY_CALLBACK).toBe('cz:recat');
    // Distinct from the entry payload, or one button would open the other's menu.
    expect(RECATEGORIZE_ENTRY_CALLBACK).not.toBe(CATEGORIZE_ENTRY_CALLBACK);
    expect(Buffer.byteLength(RECATEGORIZE_ENTRY_CALLBACK)).toBeLessThanOrEqual(64);
  });
});

describe('sendTelegramMessage', () => {
  it('sends reply_markup when a keyboard is supplied, and omits it otherwise', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    await sendTelegramMessage('123:TOKEN', '999', 'Hi', undefined, { inline_keyboard: [[{ text: 'Dismiss', callback_data: 'd:x' }]] });
    const withKb = JSON.parse(mockFetch.mock.calls.at(-1)![1].body);
    expect(withKb.reply_markup.inline_keyboard[0][0].callback_data).toBe('d:x');
    await sendTelegramMessage('123:TOKEN', '999', 'Hi');
    expect(JSON.parse(mockFetch.mock.calls.at(-1)![1].body)).not.toHaveProperty('reply_markup');
  });

  it('posts to Telegram bot API and returns ok: true on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });

    const res = await sendTelegramMessage('123:TOKEN', '999', 'Hello');
    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123:TOKEN/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          chat_id: '999',
          text: 'Hello',
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        }),
      }),
    );
  });

  it('returns error description when Telegram API returns ok: false', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: 'Bad Request: chat not found' }),
    });

    const res = await sendTelegramMessage('123:TOKEN', 'invalid', 'Test');
    expect(res.ok).toBe(false);
    expect(res.description).toBe('Bad Request: chat not found');
  });
});

describe('weeklyEnvelope', () => {
  // All four worked examples share a 31-day month and a $1,000 monthly budget.
  // `daysFromWeekStartToMonthEnd` is inclusive of both ends: for a week
  // starting on the 8th of a 31-day month it is 31 - 8 + 1 = 24.

  it('day 1 (Monday), nothing spent yet — a day-proportional slice of the whole budget', () => {
    // 1000 * 7 / 31 = 225.81. Dividing by whole weeks (ceil(31/7) = 5) would
    // give 200, understating the week by ~11% in a 31-day month.
    const e = weeklyEnvelope({ budget: 1000, monthSpent: 0, weekSpent: 0, daysFromWeekStartToMonthEnd: 31 });
    expect(e.weekEnvelope).toBeCloseTo(225.81, 2);
    expect(e.leftThisWeek).toBeCloseTo(225.81, 2);
    expect(e.remainingMonth).toBe(1000);
  });

  it('day 8 (Monday) after a $500 week 1 — the envelope re-derives from what is left', () => {
    // A blown week tightens every later week: (1000 - 500) * 7 / 24 = 145.83,
    // not the 225.81 the untouched budget would have allowed.
    const e = weeklyEnvelope({ budget: 1000, monthSpent: 500, weekSpent: 0, daysFromWeekStartToMonthEnd: 24 });
    expect(e.weekEnvelope).toBeCloseTo(145.83, 2);
    expect(e.leftThisWeek).toBeCloseTo(145.83, 2);
    expect(e.remainingMonth).toBe(500);
  });

  it('day 9 (Tuesday) — the envelope is unchanged and the remainder counts down', () => {
    // Same week as the previous case plus $50 spent today. Deriving the
    // envelope from the WEEK-START state (budget - spentBeforeWeek) is what
    // makes this count down; deriving it from today's remaining would reset it
    // to a fresh, larger allowance every morning.
    const e = weeklyEnvelope({ budget: 1000, monthSpent: 550, weekSpent: 50, daysFromWeekStartToMonthEnd: 24 });
    expect(e.weekEnvelope).toBeCloseTo(145.83, 2);
    expect(e.leftThisWeek).toBeCloseTo(95.83, 2);
    expect(e.remainingMonth).toBe(450);
  });

  it('day 29 (Monday) with 3 days left — capped at the money that actually exists', () => {
    // Uncapped this is 100 * 7 / 3 = 233.33, promising more than the whole
    // remaining budget over a stretch of the month that is only 3 days long.
    const e = weeklyEnvelope({ budget: 1000, monthSpent: 900, weekSpent: 0, daysFromWeekStartToMonthEnd: 3 });
    expect(e.weekEnvelope).toBeCloseTo(100, 2);
    expect(e.leftThisWeek).toBeCloseTo(100, 2);
    expect(e.remainingMonth).toBe(100);
  });

  it('counts down within the week: same envelope, more spent, less left', () => {
    const base = { budget: 1000, monthSpent: 500, daysFromWeekStartToMonthEnd: 24 };
    const mon = weeklyEnvelope({ ...base, monthSpent: 500, weekSpent: 0 });
    const tue = weeklyEnvelope({ ...base, monthSpent: 550, weekSpent: 50 });
    const wed = weeklyEnvelope({ ...base, monthSpent: 620, weekSpent: 120 });
    expect(tue.weekEnvelope).toBeCloseTo(mon.weekEnvelope, 6);
    expect(wed.weekEnvelope).toBeCloseTo(mon.weekEnvelope, 6);
    expect(tue.leftThisWeek).toBeLessThan(mon.leftThisWeek);
    expect(wed.leftThisWeek).toBeLessThan(tue.leftThisWeek);
    // The drop equals what was spent, exactly — the number is a real envelope,
    // not a pace that moves by a fraction of each purchase.
    expect(mon.leftThisWeek - tue.leftThisWeek).toBeCloseTo(50, 6);
    expect(tue.leftThisWeek - wed.leftThisWeek).toBeCloseTo(70, 6);
  });

  it('is continuous at the cap boundary — no jump where the two branches meet', () => {
    // At exactly 7 days from week start to month end, budgetAtWeekStart and
    // budgetAtWeekStart * 7 / 7 are the same number, so the cap engages without
    // a step.
    const at7 = weeklyEnvelope({ budget: 700, monthSpent: 0, weekSpent: 0, daysFromWeekStartToMonthEnd: 7 });
    const at8 = weeklyEnvelope({ budget: 700, monthSpent: 0, weekSpent: 0, daysFromWeekStartToMonthEnd: 8 });
    expect(at7.weekEnvelope).toBeCloseTo(700, 6);
    expect(at8.weekEnvelope).toBeCloseTo(612.5, 2);
  });

  it('never promises more than remains once the week is already overspent', () => {
    const e = weeklyEnvelope({ budget: 1000, monthSpent: 400, weekSpent: 300, daysFromWeekStartToMonthEnd: 24 });
    // budgetAtWeekStart 900 -> envelope 262.50 -> left -37.50, still $600 for
    // the month: over for the week but inside the month.
    expect(e.weekEnvelope).toBeCloseTo(262.5, 2);
    expect(e.leftThisWeek).toBeCloseTo(-37.5, 2);
    expect(e.remainingMonth).toBe(600);
  });
});

describe('formatDailySpendingDigest', () => {
  const period = { daysFromWeekStartToMonthEnd: 24, daysLeftInMonthInclusive: 23 };

  it('is titled unmistakably as a daily report, not a weekly one', () => {
    const text = dailyGlyphs(
      [{ name: 'Groceries', monthSpent: 200, weekSpent: 50, budget: 800 }],
      period,
    );
    expect(text).toContain('☀️ *Daily Spending Check*');
    expect(text).not.toContain('Weekly Spending Update');
  });

  it('leads every category line with what is left THIS WEEK', () => {
    // budgetAtWeekStart = 1000 - 500 = 500; envelope = 500 * 7 / 24 = 145.83;
    // 50 already spent this week leaves 95.83.
    const text = dailyGlyphs(
      [{ name: 'Groceries', monthSpent: 550, weekSpent: 50, budget: 1000 }],
      period,
    );
    expect(text).toContain('🛒 Groceries  *$95.83*');
  });

  it('states the unit once in the header instead of repeating it per line', () => {
    const text = dailyGlyphs(
      [
        { name: 'Groceries', monthSpent: 550, weekSpent: 50, budget: 1000 },
        { name: 'Dining', monthSpent: 100, weekSpent: 20, budget: 400 },
        { name: 'Entertainment', monthSpent: 10, weekSpent: 10, budget: 200 },
      ],
      period,
    );
    expect(text).toContain('_left to spend this week_');
    // Exactly one mention of the week across the whole digest — the header's.
    expect(text.match(/this week/g)).toHaveLength(1);
    // The `• ` bullet is gone; the category emoji reads as the bullet.
    expect(text).not.toContain('• ');
  });

  it('closes with a single month-context summary line rather than per-line month figures', () => {
    const text = dailyGlyphs(
      [
        { name: 'Groceries', monthSpent: 550, weekSpent: 50, budget: 1000 },
        { name: 'Dining', monthSpent: 100, weekSpent: 20, budget: 400 },
      ],
      period,
    );
    // Remaining for the month: (1000 - 550) + (400 - 100) = 750.
    expect(text).toContain('💰 $750 left this month · 23 days to go');
    expect(text.match(/left this month/g)).toHaveLength(1);
  });

  it('counts the day it is sent as one of the days to go', () => {
    const text = dailyGlyphs(
      [{ name: 'Groceries', monthSpent: 0, weekSpent: 0, budget: 100 }],
      { daysFromWeekStartToMonthEnd: 1, daysLeftInMonthInclusive: 1 },
    );
    expect(text).toContain('· 1 day to go');
  });

  it('flags a category over budget for the MONTH, which dominates the weekly view', () => {
    const text = dailyGlyphs(
      [{ name: 'Dining', monthSpent: 550, weekSpent: 100, budget: 500 }],
      period,
    );
    expect(text).toContain('🍽️ Dining  🚨 *$50 over* for the month');
  });

  it('lets the month-level overspend win when both the week and the month are blown', () => {
    // Once spentBeforeWeek exceeds the budget, budgetAtWeekStart goes negative
    // and the envelope arithmetic produces a meaningless figure (here about
    // -$29). The month branch must take precedence so that number never
    // reaches the screen.
    const text = dailyGlyphs(
      [{ name: 'Shopping', monthSpent: 315.5, weekSpent: 90, budget: 250 }],
      period,
    );
    expect(text).toContain('🛍️ Shopping  🚨 *$66 over* for the month');
    expect(text).not.toContain('this week ·');
  });

  it('distinguishes over-for-the-week from over-for-the-month', () => {
    // budgetAtWeekStart = 300 - 80 = 220; envelope = 220 * 7 / 24 = 64.17;
    // 120 spent this week leaves -55.83, yet $100 remains for the month.
    const text = dailyGlyphs(
      [{ name: 'Dining', monthSpent: 200, weekSpent: 120, budget: 300 }],
      period,
    );
    expect(text).toContain('🍽️ Dining  ⚠️ *$55.83 over* · $100 left mo');
    expect(text).not.toContain('🚨');
  });

  it('keeps the over-the-week line short enough not to wrap on a phone', () => {
    // Spelled out ("$55.83 over* this week · $100 left this month") this line
    // ran to ~66 characters and wrapped beside neighbours of ~25, which reads
    // as broken markup. The per-category month figure still has to survive the
    // trim — it is what says "you can absorb this, just slow down", and it is a
    // different number from the footer's cross-category total.
    const text = dailyGlyphs(
      [{ name: 'Food & Dining', monthSpent: 200, weekSpent: 120, budget: 300 }],
      period,
    );
    const line = text.split('\n').find((l: string) => l.includes('over'))!;
    expect(line).toContain('$100');
    // Measured as rendered: Telegram eats the bold markers, and a variation
    // selector is a zero-width modifier, not a column.
    const rendered = line.replace(/\*/g, '').replace(/\uFE0F/g, '');
    expect(rendered.length).toBeLessThanOrEqual(48);
    // The week is stated once, in the header — not repeated on the row.
    expect(text.match(/this week/g)).toHaveLength(1);
  });

  it('says a fully-used budget is used up rather than showing a bare $0', () => {
    // A fixed monthly bill paid before this week started: $350 of a $350 budget
    // is gone, so there is genuinely $0 of weekly allowance AND $0 left for the
    // month. Arithmetically right, but a bare "*$0*" beside real figures reads
    // as a failure rather than as a budget that is fully spent.
    const text = dailyGlyphs(
      [{ name: 'Bills & Utilities', monthSpent: 350, weekSpent: 0, budget: 350 }],
      period,
    );
    expect(text).toContain('📄 Bills & Utilities  *$0* · budget used up');
    // Not overspending: neither over-budget marker belongs on this state.
    expect(text).not.toContain('⚠️');
    expect(text).not.toContain('🚨');
    expect(text).not.toContain('over');
  });

  it('keeps "budget used up" distinct from being over budget', () => {
    // $0 left for the month with the week's allowance blown is a different
    // situation and keeps its own branch.
    const overWeek = dailyGlyphs(
      [{ name: 'Bills', monthSpent: 350, weekSpent: 350, budget: 350 }],
      period,
    );
    expect(overWeek).not.toContain('budget used up');
    expect(overWeek).toContain('over*');
    const overMonth = dailyGlyphs(
      [{ name: 'Bills', monthSpent: 400, weekSpent: 0, budget: 350 }],
      period,
    );
    expect(overMonth).not.toContain('budget used up');
    expect(overMonth).toContain('🚨 *$50 over* for the month');
  });

  it('reports spending with no budget under "Off budget", not as "over budget"', () => {
    // You cannot be over a budget you never set.
    const text = dailyGlyphs(
      [{ name: 'Shopping', monthSpent: 40, weekSpent: 40, budget: 0 }],
      period,
    );
    expect(text).toContain('Off budget:');
    expect(text).toContain('🛍️ Shopping  $40 spent');
    expect(text).not.toContain('over');
  });

  it('renders an unbudgeted category with no spend not at all', () => {
    // The live report printed `📄 Bills & Utilities  no budget · $0 spent` —
    // a category with a leftover zero-amount budget row in Wealthfolio. True,
    // and pure noise: nothing is budgeted and nothing happened.
    const text = dailyGlyphs(
      [
        { name: 'Groceries', monthSpent: 10, weekSpent: 10, budget: 300 },
        { name: 'Bills & Utilities', monthSpent: 0, weekSpent: 0, budget: 0 },
      ],
      period,
    );
    expect(text).not.toContain('Bills & Utilities');
    expect(text).not.toContain('Off budget');
  });

  it('lists budgeted categories first, then the Off budget block', () => {
    const text = dailyGlyphs(
      [
        { name: 'Fees', monthSpent: 3, weekSpent: 3, budget: 0 },
        { name: 'Groceries', monthSpent: 10, weekSpent: 10, budget: 300 },
      ],
      period,
    );
    expect(text.indexOf('Groceries')).toBeGreaterThan(-1);
    expect(text.indexOf('Groceries')).toBeLessThan(text.indexOf('Off budget:'));
    expect(text.indexOf('Off budget:')).toBeLessThan(text.indexOf('Fees'));
  });

  it('omits the money summary when nothing in the digest has a budget', () => {
    // Summing "remaining" across only-unbudgeted categories would report a
    // negative month remaining against a budget of zero.
    const text = dailyGlyphs(
      [{ name: 'Shopping', monthSpent: 40, weekSpent: 40, budget: 0 }],
      period,
    );
    expect(text).not.toContain('left this month');
    expect(text).toContain('📅 23 days left in the month');
  });

  it('takes unbudgeted spending off the month summary, and says that it did', () => {
    const cats = [
      { name: 'Groceries', monthSpent: 550, weekSpent: 50, budget: 1000 },
      { name: 'Shopping', monthSpent: 40, weekSpent: 40, budget: 0 },
    ];
    const text = dailyGlyphs(cats, period);
    // 410, not 450. This line used to report the budgeted sum alone, on the
    // reasoning that unbudgeted spend comes out of nobody's budget — true of
    // budget headroom, false of "left this month", which is read as money
    // still available. The $40 is gone either way.
    // Net of the $40, but the line does not say so — the block below does.
    expect(text).toContain('💰 $410 left this month');
    expect(text).not.toContain('after $');
    // And it is still itemised, so the subtraction can be reconciled.
    expect(text).toContain('Off budget:');
    expect(text).toContain('$40 spent');
  });

  it('restores the budgeted-only sum when off-budget spending is not counted', () => {
    const cats = [
      { name: 'Groceries', monthSpent: 550, weekSpent: 50, budget: 1000 },
      { name: 'Shopping', monthSpent: 40, weekSpent: 40, budget: 0 },
    ];
    const text = formatDailySpendingDigest(cats, period, GLYPHS, 'rollup', false);
    expect(text).toContain('💰 $450 left this month');
    // No parenthetical when nothing was subtracted — it would be noise.
    expect(text).not.toContain('off budget ·');
    expect(text).not.toContain('after $');
    // Still listed: the setting governs whether it COUNTS, never whether it shows.
    expect(text).toContain('Off budget:');
  });

  it('counts uncategorized spending and lists it separately', () => {
    // Wealthfolio shows an "Uncategorized" bucket and counts it against the
    // month; every reader here is per-category, so this spending could never
    // appear in a category line and was simply missing from the total.
    const text = formatDailySpendingDigest(
      [{ name: 'Groceries', monthSpent: 550, weekSpent: 50, budget: 1000 }],
      period, GLYPHS, 'rollup', true, { count: 2, total: 20.76 },
    );
    expect(text).toContain('Uncategorized');
    expect(text).toContain('2 charges with no category');
    // 450 - 20.76 = 429.24 -> $429, with no parenthetical explaining it.
    expect(text).toContain('💰 $429 left this month');
    expect(text).not.toContain('after $');
  });

  it('names both when off-budget and uncategorized are present', () => {
    const text = formatDailySpendingDigest(
      [
        { name: 'Groceries', monthSpent: 550, weekSpent: 50, budget: 1000 },
        { name: 'Education', monthSpent: 68, weekSpent: 0, budget: 0 },
      ],
      period, GLYPHS, 'rollup', true, { count: 1, total: 20.76 },
    );
    // Both are itemised below; the headline stays a single figure.
    expect(text).not.toContain('after $');
    expect(text).toContain('Off budget:');
    expect(text).toContain('Uncategorized');
  });

  it('leaves the total alone when off-budget counting is off', () => {
    const text = formatDailySpendingDigest(
      [{ name: 'Groceries', monthSpent: 550, weekSpent: 50, budget: 1000 }],
      period, GLYPHS, 'rollup', false, { count: 2, total: 20.76 },
    );
    expect(text).toContain('💰 $450 left this month');
    // Still SHOWN — the setting governs whether it counts, not whether it shows.
    expect(text).toContain('Uncategorized');
  });

  it('says nothing about uncategorized when there is none', () => {
    const text = formatDailySpendingDigest(
      [{ name: 'Groceries', monthSpent: 550, weekSpent: 50, budget: 1000 }],
      period, GLYPHS, 'rollup', true, { count: 0, total: 0 },
    );
    expect(text).not.toContain('Uncategorized');
    expect(text).toContain('💰 $450 left this month');
  });

  it('caps a category\'s weekly figure by what the month can actually afford', () => {
    // Two budgeting models were being printed in one message: the category
    // lines are envelopes, the headline is a pool. With one category far over,
    // every other envelope went on offering its full weekly allowance —
    // money that does not exist.
    const cats = [
      { name: 'Shopping', budget: 100, monthSpent: 429, weekSpent: 40 },
      { name: 'Groceries', budget: 300, monthSpent: 200, weekSpent: 21.15 },
    ];
    const text = dailyGlyphs(cats, period);
    // Overall is 400 - 629 = -229, so there is nothing to spend anywhere.
    expect(text).toContain('🛒 Groceries  *$0*');
    expect(text).toContain('the month is spent');
  });

  it('scales weekly figures proportionally when the pool is short but positive', () => {
    // Room for roughly half of what the envelopes promise.
    const cats = [
      { name: 'Shopping', budget: 100, monthSpent: 150, weekSpent: 10 },
      { name: 'Groceries', budget: 300, monthSpent: 100, weekSpent: 0 },
    ];
    const text = dailyGlyphs(cats, period);
    expect(text).toContain('reduced to fit what is left overall');
    // 350 - 250 = ... the pool is smaller than Groceries' own 200 envelope, so
    // its weekly figure must come out under the unscaled one.
    const shown = /🛒 Groceries  \*\$([\d,.]+)\*/.exec(text);
    expect(shown).not.toBeNull();
    expect(parseFloat(shown![1].replace(/,/g, ''))).toBeLessThan(58.33);
  });

  it('leaves the figures uncapped, and says so, when capping is switched off', () => {
    // The opposite answer to the same question, and equally defensible: this is
    // Wealthfolio's own envelope view, which stays readable when the pool is
    // tight. What it must never do is let the full envelope read as money in
    // hand — hence the subtitle naming the pool.
    const cats = [
      { name: 'Shopping', budget: 100, monthSpent: 150, weekSpent: 10 },
      { name: 'Groceries', budget: 300, monthSpent: 100, weekSpent: 0 },
    ];
    const capped = formatDailySpendingDigest(cats, period, GLYPHS, 'rollup', true, undefined, true);
    const full = formatDailySpendingDigest(cats, period, GLYPHS, 'rollup', false, undefined, false);

    expect(full).toContain('only $150 left overall');
    expect(full).not.toContain('reduced to fit');
    // Uncapped means the whole envelope: 200 remaining over the period.
    const shownFull = /🛒 Groceries  \*\$([\d,.]+)\*/.exec(full);
    const shownCapped = /🛒 Groceries  \*\$([\d,.]+)\*/.exec(capped);
    const num = (m: RegExpExecArray | null) => parseFloat(m![1].replace(/,/g, ''));
    expect(shownFull).not.toBeNull();
    expect(num(shownFull)).toBeGreaterThan(num(shownCapped));
    // The headline is the pool either way — the setting only moves the
    // per-category figures, which is exactly what its description promises.
    expect(full).toContain('💰 $150 left this month');
    expect(capped).toContain('💰 $150 left this month');
  });

  it('does not caveat uncapped figures when the month can afford them', () => {
    // Off + affordable is the ordinary case, and must read like the ordinary
    // case: no warning about a pool that is not actually short.
    const text = formatDailySpendingDigest(
      [{ name: 'Groceries', monthSpent: 100, weekSpent: 20, budget: 1000 }],
      period, GLYPHS, 'rollup', true, undefined, false,
    );
    expect(text).toContain('_left to spend this week_');
    expect(text).not.toContain('left overall');
  });

  it('never lets a line promise more than the pool holds, on any branch', () => {
    // The invariant 1.21.0 was supposed to establish, stated directly rather
    // than per-branch — which is how the `left mo` clause slipped through: the
    // cap scaled `leftThisWeek` and that clause prints the month figure. With
    // the month $93 OVER, a line reading "$36 left mo" contradicts the very
    // headline beneath it.
    const cats = [
      // Month room left, but the week's pace is blown -> the ⚠️ branch.
      { name: 'Food & Dining', budget: 200, monthSpent: 164, weekSpent: 120 },
      { name: 'Shopping', budget: 100, monthSpent: 429, weekSpent: 0 },
      { name: 'Groceries', budget: 300, monthSpent: 100, weekSpent: 0 },
    ];
    const text = dailyGlyphs(cats, period);
    expect(text).toContain('🚨 $93 over budget this month');
    expect(text).toContain('$0 left mo');
    expect(text).not.toContain('$36 left mo');
  });

  it('leaves the month figure on the warning line alone when the pool is healthy', () => {
    // The other half: capping must not touch a figure the month can honour, or
    // an ordinary "ahead of pace" week starts under-reporting real budget.
    const cats = [
      { name: 'Food & Dining', budget: 200, monthSpent: 164, weekSpent: 120 },
      { name: 'Groceries', budget: 300, monthSpent: 0, weekSpent: 0 },
    ];
    const text = dailyGlyphs(cats, period);
    expect(text).toContain('$36 left mo');
  });

  it('leaves the weekly figures alone when the month can afford them', () => {
    const text = dailyGlyphs(
      [{ name: 'Groceries', monthSpent: 100, weekSpent: 20, budget: 1000 }],
      period,
    );
    expect(text).toContain('_left to spend this week_');
    expect(text).not.toContain('reduced to fit');
  });

  it('says nothing about off-budget when there is none', () => {
    const text = dailyGlyphs(
      [{ name: 'Groceries', monthSpent: 550, weekSpent: 50, budget: 1000 }],
      period,
    );
    expect(text).toContain('💰 $450 left this month');
    expect(text).not.toContain('off budget');
  });

  it('keeps cents on the spendable weekly figure and drops them on month context', () => {
    // budgetAtWeekStart = 900 - 354 = 546; envelope = 546 * 7 / 24 = 159.25;
    // left = 159.25 - 65.4 = 93.85, a number the reader spends against, so the
    // cents stay. Month remaining 480.60 is context, so it rounds to $481.
    const text = dailyGlyphs(
      [{ name: 'Groceries', monthSpent: 419.4, weekSpent: 65.4, budget: 900 }],
      period,
    );
    expect(text).toContain('🛒 Groceries  *$93.85*');
    expect(text).toContain('💰 $481 left this month');
  });

  it('groups thousands so a big figure stays readable', () => {
    const text = dailyGlyphs(
      [{ name: 'Housing', monthSpent: 0, weekSpent: 0, budget: 12500 }],
      period,
    );
    expect(text).toContain('💰 $12,500 left this month');
  });

  // The real digest that exposed the summary-line bug: seven categories over
  // budget, three under, summing to exactly -$1,493.66 for the month.
  const overBudgetMonth = [
    { name: 'Groceries', budget: 800, monthSpent: 1100, weekSpent: 120 },
    { name: 'Food & Dining', budget: 400, monthSpent: 900, weekSpent: 210 },
    { name: 'Shopping', budget: 300, monthSpent: 600, weekSpent: 75 },
    { name: 'Transportation', budget: 250, monthSpent: 400, weekSpent: 40 },
    { name: 'Entertainment', budget: 150, monthSpent: 320.5, weekSpent: 60.5 },
    { name: 'Fees & Charges', budget: 50, monthSpent: 120.16, weekSpent: 12.16 },
    { name: 'Health & Wellness', budget: 100, monthSpent: 250, weekSpent: 0 },
    { name: 'Housing', budget: 1500, monthSpent: 1450, weekSpent: 0 },
    { name: 'Bills & Utilities', budget: 300, monthSpent: 250, weekSpent: 25 },
    { name: 'Education', budget: 100, monthSpent: 53, weekSpent: 53 },
  ];
  const endOfMonth = { daysFromWeekStartToMonthEnd: 3, daysLeftInMonthInclusive: 3 };

  it('says OVER BUDGET when the month total is negative — never "left this month"', () => {
    // The shipped digest printed "💰 $1,494 left this month · 3 days to go" for
    // a true remainder of -$1,493.66: the reader was told he had ~$1,500 to
    // spend while he was ~$1,500 past the line. For a budgeting tool that is the
    // worst possible direction to be wrong in, so the wording has to agree with
    // the sign, not just the magnitude.
    const text = dailyGlyphs(overBudgetMonth, endOfMonth);
    expect(text).not.toContain('left this month');
    expect(text).not.toContain('💰');
    expect(text).toContain('🚨 $1,494 over budget this month · 3 days to go');
  });

  it('keeps the days-to-go tail on the over-budget summary — it is useful either way', () => {
    const text = dailyGlyphs(
      [{ name: 'Dining', budget: 300, monthSpent: 500, weekSpent: 100 }],
      { daysFromWeekStartToMonthEnd: 1, daysLeftInMonthInclusive: 1 },
    );
    expect(text).toContain('🚨 $200 over budget this month · 1 day to go');
  });

  it('never says "left this month" for a total that is really negative', () => {
    // Guards the class of bug rather than the single instance that shipped: over
    // a matrix of budget/spend combinations, the summary's wording must agree
    // with the sign of the total it is describing.
    const budgets = [0, 100, 400, 1000];
    const spends = [0, 50, 399.99, 400, 1200.5];
    for (const b1 of budgets) {
      for (const s1 of spends) {
        for (const b2 of budgets) {
          for (const s2 of spends) {
            const cats = [
              { name: 'Groceries', budget: b1, monthSpent: s1, weekSpent: Math.min(s1, 25) },
              { name: 'Dining', budget: b2, monthSpent: s2, weekSpent: Math.min(s2, 25) },
            ];
            // Mirrors the headline the digest now reports: budgeted remainder
            // MINUS spend in categories with no budget. Off-budget only counts
            // when money actually moved, matching the line that lists it.
            const budgeted = (b1 > 0 ? b1 - s1 : 0) + (b2 > 0 ? b2 - s2 : 0);
            const offBudget = (b1 <= 0 && s1 > 0 ? s1 : 0) + (b2 <= 0 && s2 > 0 ? s2 : 0);
            const total = budgeted - offBudget;
            const text = dailyGlyphs(cats, period);
            const where = JSON.stringify(cats);
            // A minus sign must never reach the screen either: every figure in
            // the digest is either non-negative or carried by a word.
            expect(text, where).not.toContain('-$');
            if (b1 <= 0 && b2 <= 0) {
              expect(text, where).not.toContain('left this month');
              expect(text, where).not.toContain('over budget');
            } else if (total < 0 && Math.abs(total) >= 0.5) {
              expect(text, where).not.toContain('left this month');
              expect(text, where).toContain('over budget this month');
            } else {
              expect(text, where).not.toContain('over budget');
              expect(text, where).toContain('left this month');
            }
          }
        }
      }
    }
  });

  it('does not raise a $0 over-budget alarm on float noise or loose change', () => {
    // Summing 2-decimal budgets and spends leaves remainders like -1e-13, and a
    // real overspend of 30 cents still renders as "$0" in a whole-dollar
    // summary. "🚨 $0 over budget" is a false alarm where "$0 left" already
    // promises nothing, so the branch keys off the figure the reader sees.
    // (0.3 - 0.1) + (0.2 - 0.4) is -2.8e-17, not 0.
    const noise = dailyGlyphs(
      [
        { name: 'Groceries', budget: 0.3, monthSpent: 0.1, weekSpent: 0 },
        { name: 'Dining', budget: 0.2, monthSpent: 0.4, weekSpent: 0 },
      ],
      period,
    );
    expect(noise).toContain('💰 $0 left this month');
    expect(noise).not.toContain('over budget');

    const loose = dailyGlyphs(
      [{ name: 'Groceries', budget: 100, monthSpent: 100.3, weekSpent: 0 }],
      period,
    );
    expect(loose).toContain('💰 $0 left this month');
    expect(loose).not.toContain('over budget');

    // A dollar over is a real dollar over.
    const real = dailyGlyphs(
      [{ name: 'Groceries', budget: 100, monthSpent: 101, weekSpent: 0 }],
      period,
    );
    expect(real).toContain('🚨 $1 over budget this month');
  });

  it('groups thousands in the over-budget summary too', () => {
    const text = dailyGlyphs(
      [{ name: 'Housing', budget: 1000, monthSpent: 13500, weekSpent: 0 }],
      period,
    );
    expect(text).toContain('🚨 $12,500 over budget this month');
  });

  it('prints the per-category month overspend unsigned, with "over" carrying the sign', () => {
    // Line 303's branch: the word does the work, so the figure must not also
    // carry a minus — "-$2,500 over" reads as a double negative.
    const text = dailyGlyphs(
      [{ name: 'Shopping', budget: 1000, monthSpent: 3500.4, weekSpent: 200 }],
      period,
    );
    expect(text).toContain('🛍️ Shopping  🚨 *$2,500 over* for the month');
    expect(text).not.toContain('-$');
  });

  it('only ever prints a non-negative month figure beside the word "left mo"', () => {
    // The over-the-WEEK branch prints `remainingMonth` with the word "left", but
    // it is only reachable once the month-overspend branch above it has been
    // ruled out — so `remainingMonth >= 0` there by construction and there is no
    // negative case to render. Asserted as the reachable behaviour rather than a
    // test for a state that cannot occur.
    const text = dailyGlyphs(
      [{ name: 'Dining', budget: 300, monthSpent: 200, weekSpent: 120 }],
      period,
    );
    expect(text).toContain('⚠️ *$55.83 over* · $100 left mo');
    expect(text).not.toContain('-$');
    // The same input one dollar deeper into the month tips into the 🚨 branch,
    // which is what keeps the "left mo" figure non-negative.
    const over = dailyGlyphs(
      [{ name: 'Dining', budget: 300, monthSpent: 301, weekSpent: 120 }],
      period,
    );
    expect(over).not.toContain('left mo');
    expect(over).toContain('🚨 *$1 over* for the month');
  });

  it('reaches the bare weekly figure only with something left, so it needs no sign', () => {
    // Line 309 prints a figure with no qualifying words at all, which is exactly
    // where a dropped sign would be invisible. Every negative `leftThisWeek` is
    // caught by the ⚠️ branch above it, so the bare figure is non-negative by
    // construction — including at the boundary, where $0 is spelled out in words
    // rather than shown bare.
    const positive = dailyGlyphs(
      [{ name: 'Groceries', budget: 1000, monthSpent: 550, weekSpent: 50 }],
      period,
    );
    expect(positive).toContain('🛒 Groceries  *$95.83*');
    const atZero = dailyGlyphs(
      [{ name: 'Groceries', budget: 1000, monthSpent: 1000, weekSpent: 0 }],
      period,
    );
    expect(atZero).toContain('*$0* · budget used up');
    // One cent past the envelope ($1,200 × 7/24 = $350) and the ⚠️ branch takes
    // it, sign and all.
    const past = dailyGlyphs(
      [{ name: 'Groceries', budget: 1200, monthSpent: 350.01, weekSpent: 350.01 }],
      period,
    );
    expect(past).toContain('⚠️ *$0.01 over*');
    expect(past).not.toContain('-$');
  });

  it('reports an unbudgeted category\'s spend, which is never negative', () => {
    // Line 295 prints `monthSpent` beside the word "spent". The host reads it as
    // SUM(ABS(amount)) over withdrawals/fees/taxes, so it cannot arrive negative
    // — a refund reduces the sum toward zero, never past it.
    const text = dailyGlyphs(
      [{ name: 'Shopping', budget: 0, monthSpent: 40.6, weekSpent: 40.6 }],
      period,
    );
    expect(text).toContain('🛍️ Shopping  $41 spent');
    expect(text).not.toContain('-$');
  });

  it('names both possible causes in the empty state', () => {
    // Reachable two ways — no budgets exist, or every category was deselected
    // in the addon — so the text must not blame only the first.
    const text = dailyGlyphs([], period);
    expect(text).toContain('Set up budgets in Wealthfolio');
    expect(text).toContain('categories are selected');
    // No "left to spend this week" promise when there is nothing to show.
    expect(text).not.toContain('_left to spend this week_');
  });

  it('ends without trailing whitespace so an appended footer stays a separate block', () => {
    const text = dailyGlyphs(
      [{ name: 'Groceries', monthSpent: 550, weekSpent: 50, budget: 1000 }],
      period,
    );
    expect(text).toBe(text.trimEnd());
    // A blank line separates the category list from the summary line.
    expect(text).toMatch(/\n\n💰 /);
  });

  it('escapes Markdown specials in a category name so the message can still send', () => {
    const text = dailyGlyphs(
      [{ name: 'Food_Drink', monthSpent: 40, weekSpent: 10, budget: 100 }],
      period,
    );
    // A lone unescaped underscore would make Telegram's legacy Markdown
    // parser look for a matching closing `_` across the whole message and
    // reject the entire send with a 400 — the escaped form must show up
    // literally instead of being consumed as italic markup.
    expect(text).toContain('Food\\_Drink');
    expect(text).not.toMatch(/[^\\]_Drink/);
  });

  it('keeps the escaped category name outside every Markdown entity', () => {
    // Legacy Markdown does not honour a backslash escape *inside* an entity —
    // the entity must be closed and reopened — so `*Food\_Drink*` still leaves
    // a live italic opener with no closer and Telegram 400s the whole digest.
    const text = dailyGlyphs(
      [{ name: 'Food_Drink', monthSpent: 40, weekSpent: 10, budget: 100 }],
      period,
    );
    expect(text).not.toContain('*Food\\_Drink*');
    // Bold sits on the figures, which never contain Markdown specials.
    expect(text).toMatch(/Food\\_Drink {2}\*\$/);
  });

  it('is materially shorter than the one-line-per-unit format it replaces', () => {
    const text = dailyGlyphs(
      [
        { name: 'Groceries', monthSpent: 550, weekSpent: 50, budget: 1000 },
        { name: 'Dining', monthSpent: 200, weekSpent: 120, budget: 300 },
        { name: 'Shopping', monthSpent: 40, weekSpent: 40, budget: 0 },
      ],
      period,
    );
    // The old format spent ~62 chars per category line ("• 🛒 Groceries:
    // *$600.00 left this month* · ≈$200.00/wk pace"). Budget the normal line at
    // half that.
    const lines = text.split('\n').filter((l: string) => l.startsWith('🛒'));
    expect(lines[0].length).toBeLessThan(32);
  });
});

describe('moneyWhole', () => {
  // The tripwire for the bug class. Every caller in the repo currently lands on
  // a branch where the amount is non-negative, so no rendered message would
  // change if this went back to `Math.abs()`-ing its input — which is exactly
  // how "$1,494 left this month" came to describe a $1,493.66 overspend. These
  // assertions fail the moment the sign is absorbed again.
  it('keeps the sign, so a bare figure can never read as its own opposite', () => {
    expect(moneyWhole(-1493.66)).toBe('-$1,494');
    expect(moneyWhole(-1)).toBe('-$1');
  });

  it('formats a positive figure exactly as before', () => {
    expect(moneyWhole(1493.66)).toBe('$1,494');
    expect(moneyWhole(0)).toBe('$0');
    expect(moneyWhole(12500)).toBe('$12,500');
  });

  it('does not print "-$0" for an amount that rounds to nothing', () => {
    // A minus on a zero is noise dressed up as information, and float noise from
    // summing 2-decimal figures produces exactly this.
    expect(moneyWhole(-0.004)).toBe('$0');
    expect(moneyWhole(-2.7755575615628914e-17)).toBe('$0');
    expect(moneyWhole(-0.4)).toBe('$0');
  });
});

describe('escapeMarkdown', () => {
  it('escapes each legacy-Markdown special character with a backslash', () => {
    expect(escapeMarkdown('a_b*c`d[e')).toBe('a\\_b\\*c\\`d\\[e');
  });

  it('leaves text with no specials untouched', () => {
    expect(escapeMarkdown('plain text 123')).toBe('plain text 123');
  });

  it('escapes repeated specials, not just the first occurrence', () => {
    expect(escapeMarkdown('__bold__ *italic*')).toBe('\\_\\_bold\\_\\_ \\*italic\\*');
  });
});

describe('formatSyncHealthFooter', () => {
  it('returns an empty string when there is no health record yet', () => {
    expect(formatSyncHealthFooter(null)).toBe('');
    expect(formatSyncHealthFooter(undefined)).toBe('');
  });

  it('shows a success line in hours-ago form for a sync a few hours back', () => {
    const now = new Date('2026-07-28T12:00:00.000Z');
    const health = { lastSuccessAt: '2026-07-28T10:00:00.000Z' };
    expect(formatSyncHealthFooter(health, now)).toBe('✅ synced 2h ago');
  });

  it('uses minutes, not "0h ago", for a sync less than an hour old', () => {
    const now = new Date('2026-07-28T12:00:00.000Z');
    const health = { lastSuccessAt: '2026-07-28T11:10:00.000Z' }; // 50 minutes ago
    expect(formatSyncHealthFooter(health, now)).toBe('✅ synced 50m ago');
  });

  it('shows "just now" for a very recent success', () => {
    const now = new Date('2026-07-28T12:00:00.000Z');
    const health = { lastSuccessAt: '2026-07-28T11:59:30.000Z' };
    expect(formatSyncHealthFooter(health, now)).toBe('✅ synced just now');
  });

  it('shows days-ago form for a long gap since the last success', () => {
    const now = new Date('2026-07-28T12:00:00.000Z');
    const health = { lastSuccessAt: '2026-07-25T12:00:00.000Z' }; // 3 days ago
    expect(formatSyncHealthFooter(health, now)).toBe('✅ synced 3d ago');
  });

  it('shows a failing-since line with the last error during an active failure streak', () => {
    const now = new Date('2026-07-28T12:00:00.000Z');
    const health = {
      lastSuccessAt: '2026-07-26T08:00:00.000Z',
      firstFailedAt: '2026-07-27T09:15:00.000Z',
      lastError: 'SimpleFin: token revoked',
      alerted: true,
    };
    const text = formatSyncHealthFooter(health, now);
    expect(text).toContain('⚠️ failing since');
    expect(text).toContain(new Date(health.firstFailedAt).toLocaleString());
    expect(text).toContain('SimpleFin: token revoked');
  });

  it('escapes Markdown specials in lastError so the digest send cannot fail on them', () => {
    const now = new Date('2026-07-28T12:00:00.000Z');
    const health = {
      lastSuccessAt: null,
      firstFailedAt: '2026-07-27T09:15:00.000Z',
      lastError: 'invalid_grant: access_denied for *user*',
      alerted: false,
    };
    const text = formatSyncHealthFooter(health, now);
    expect(text).toContain('invalid\\_grant: access\\_denied for \\*user\\*');
  });
});

describe('formatMonthlyRemainingSummary', () => {
  it('leads with the one number and puts the arithmetic on a single quiet line', () => {
    const text = weeklyGlyphs(1200, 2000);
    expect(text).toContain('💰 *$800 left* this month');
    expect(text).toContain('_spent $1,200 of $2,000 · 60%_');
  });

  it('flags being over budget for the month', () => {
    const text = weeklyGlyphs(2200, 2000);
    expect(text).toContain('🚨 *$200 over budget* this month');
    expect(text).toContain('_spent $2,200 of $2,000 · 110%_');
  });

  it('prints the overspend unsigned — "over budget" carries the sign', () => {
    // A minus on the figure as well would read as a double negative, and the
    // supporting line's two figures are both non-negative by construction:
    // `totalBudget <= 0` returns early above, and `totalSpent` is a SUM(ABS(..))
    // of outgoing activity.
    const text = weeklyGlyphs(2200.4, 2000);
    expect(text).toContain('🚨 *$200 over budget* this month');
    expect(text).toContain('_spent $2,200 of $2,000 · 110%_');
    expect(text).not.toContain('-$');
  });

  it('only prints a non-negative figure beside the word "left"', () => {
    // The "left" branch is only reached once `remaining < 0` has been ruled out,
    // so it has no negative case to render; one dollar the other way is the 🚨
    // branch, which is what keeps that guarantee.
    expect(weeklyGlyphs(2000, 2000)).toContain('💰 *$0 left* this month');
    const over = weeklyGlyphs(2001, 2000);
    expect(over).not.toContain('left*');
    expect(over).toContain('🚨 *$1 over budget* this month');
  });

  it('reads as the same family as the daily digest\'s over-budget summary', () => {
    // Both reports lead an overspend with 🚨 and the words "over budget", so the
    // two never disagree about what a negative month looks like.
    const weekly = weeklyGlyphs(2200, 2000);
    const daily = dailyGlyphs(
      [{ name: 'Groceries', budget: 2000, monthSpent: 2200, weekSpent: 0 }],
      { daysFromWeekStartToMonthEnd: 7, daysLeftInMonthInclusive: 7 },
    );
    expect(weekly).toContain('🚨');
    expect(weekly).toContain('over budget');
    expect(daily).toContain('🚨');
    expect(daily).toContain('over budget');
  });

  it('does not claim "$0 left" when no budget exists at all', () => {
    // Reachable by deselecting every weekly category, or before any budget is
    // created. This report is one number, so the old
    // "💰 *$0.00 remaining* this month (spent $0.00 of $0.00, 0%)" read as a
    // real, calmly-reported result.
    const text = weeklyGlyphs(0, 0);
    expect(text).not.toContain('left* this month');
    expect(text).not.toContain('of $0');
    expect(text).toContain('Nothing spent, no budgets set');
  });

  it('reports the spend, not a "left" figure, when money went out with no budget set', () => {
    const text = weeklyGlyphs(40, 0);
    expect(text).toContain('🏷️ *$40 spent* · no budget set');
    expect(text).not.toContain('left* this month');
    expect(text).not.toContain('over budget');
  });

  it('points at both possible causes of a zero budget', () => {
    for (const text of [weeklyGlyphs(0, 0), weeklyGlyphs(40, 0)]) {
      expect(text).toContain('Add budgets in Wealthfolio');
      expect(text).toContain('selected for the weekly report');
    }
  });

  it('keeps the weekly report clearly labelled as weekly', () => {
    expect(weeklyGlyphs(1200, 2000)).toContain('📊 *Weekly Budget Check-In*');
  });

  it('rounds to whole dollars — every figure here is month-level context', () => {
    const text = weeklyGlyphs(1550.75, 2400);
    expect(text).toContain('💰 *$849 left* this month');
    expect(text).toContain('_spent $1,551 of $2,400 · 65%_');
  });

  it('reads as the same family as the daily digest — emoji-led figure, no parenthetical', () => {
    const text = weeklyGlyphs(1200, 2000);
    expect(text).not.toContain('(spent');
    expect(text).toBe(text.trimEnd());
  });
});

describe('formatMonthlyRemainingSummary — biggest spends this week', () => {
  const spends = [
    { amount: 412.37, description: 'WHOLE FOODS', category: 'Food & Dining' },
    { amount: 180, description: 'DELTA AIR LINES', category: 'Transportation' },
    { amount: 95.5, description: 'TARGET', category: 'Shopping' },
  ];

  it('appends the section below the headline, one scannable line per transaction', () => {
    expect(weeklyGlyphs(1850, 2400, spends)).toBe(
      '📊 *Weekly Budget Check-In*\n'
      + '\n'
      + '💰 *$550 left* this month\n'
      + '_spent $1,850 of $2,400 · 77%_\n'
      + '\n'
      + '*Biggest this week*\n'
      + '$412 · WHOLE FOODS · Food & Dining\n'
      + '$180 · DELTA AIR LINES · Transportation\n'
      + '$96 · TARGET · Shopping',
    );
  });

  it('omits the section entirely when nothing was spent this week', () => {
    // An empty heading is noise: it states a fact ("here are the biggest") and
    // then fails to deliver it.
    const text = weeklyGlyphs(1850, 2400, []);
    expect(text).not.toContain('Biggest');
    expect(text).toBe(weeklyGlyphs(1850, 2400));
    // No trailing blank line left behind where the section would have gone —
    // callers may append a block of their own.
    expect(text).toBe(text.trimEnd());
  });

  it('shows however many there are — fewer than five is normal', () => {
    const text = weeklyGlyphs(1850, 2400, spends.slice(0, 1));
    expect(text).toContain('*Biggest this week*\n$412 · WHOLE FOODS · Food & Dining');
    expect(text).not.toContain('DELTA');
  });

  it('still lists the week\'s biggest spends when no budget is set', () => {
    // The zero-budget branch returns early, so this is the one that regresses if
    // the section is appended in only one place. "What did I spend" is a fact
    // that does not depend on a budget existing.
    const text = weeklyGlyphs(507.87, 0, spends);
    expect(text).toContain('🏷️ *$508 spent* · no budget set');
    expect(text).toContain('*Biggest this week*');
    expect(text).toContain('$412 · WHOLE FOODS · Food & Dining');
  });

  it('escapes a `*`-laden card descriptor and leaves the whole message balanced', () => {
    // The single most dangerous input in this system. Legacy Markdown does NOT
    // honour a backslash escape inside an entity, so a bolded `*SQ \*BLUE
    // BOTTLE*` would still leave an unbalanced entity and Telegram would reject
    // the ENTIRE message with a 400 — the report would simply never arrive.
    // Hence: escaped, and outside every entity.
    const text = weeklyGlyphs(1850, 2400, [
      { amount: 42, description: 'SQ *BLUE BOTTLE **COFFEE*', category: 'Food_Dining' },
      { amount: 12, description: 'PAYPAL *WIKIPEDIA', category: 'Charity' },
    ]);
    expect(text).toContain('$42 · SQ \\*BLUE BOTTLE \\*\\*COFFEE\\* · Food\\_Dining');
    expect(text).toContain('$12 · PAYPAL \\*WIKIPEDIA · Charity');

    // Strip the escapes, then count what Telegram would actually parse: only the
    // report's own deliberate entities survive — the header, the headline figure
    // and the section heading make three balanced bold pairs — and no stray `_`
    // from the category name.
    const unescaped = text.replace(/\\[_*`[]/g, '');
    expect((unescaped.match(/\*/g) ?? [])).toHaveLength(6);
    expect((unescaped.match(/_/g) ?? [])).toHaveLength(2); // the italic arithmetic line
  });

  it('renders the amount unsigned and in whole dollars, with no bold on the rows', () => {
    // Unsigned: these are spends, which the heading already says. Whole dollars:
    // the rest of this report is whole-dollar context and cents on a 3-field row
    // wrap on a phone. No bold: five bold figures would fight the one figure the
    // report is actually about.
    const text = weeklyGlyphs(1850, 2400, [
      { amount: -412.37, description: 'WHOLE FOODS', category: 'Food & Dining' },
    ]);
    expect(text).toContain('\n$412 · WHOLE FOODS · Food & Dining');
    expect(text).not.toContain('-$412');
    expect(text).not.toContain('*$412');
  });

  it('falls back to the category alone when the bank sent no description', () => {
    // A SimpleFin transaction can carry an empty description, which leaves the
    // stored note as nothing but the tx id. ` ·  · Shopping` would read as a
    // rendering bug.
    const text = weeklyGlyphs(1850, 2400, [
      { amount: 30, description: '', category: 'Shopping' },
    ]);
    expect(text).toContain('\n$30 · Shopping');
    expect(text).not.toContain('·  ·');
  });
});

describe('formatLargeTransactionAlert', () => {
  it('renders the figure in bold with the description and account beside it', () => {
    expect(formatLargeTransactionAlert({
      description: 'DELTA AIR LINES',
      amountCents: 124000,
      currency: 'USD',
      accountName: 'Spend',
    })).toBe('💸 *$1,240.00* USD — DELTA AIR LINES · Spend');
  });

  it('keeps the cents — this is one exact transaction, not a rounded total', () => {
    expect(formatLargeTransactionAlert({
      description: 'Roof repair', amountCents: 250099, currency: 'USD', accountName: 'Spend',
    })).toContain('*$2,500.99*');
  });

  it('escapes a `*`/`_`-laden card descriptor and keeps it out of every entity', () => {
    // The exact failure mode this guards: legacy Markdown ignores a backslash
    // escape INSIDE an entity, so `*AMAZON \*MKTPLACE*` still leaves a live
    // opener and Telegram rejects the whole message with a 400.
    const text = formatLargeTransactionAlert({
      description: 'AMAZON *MKTPLACE_2',
      amountCents: 124000,
      currency: 'USD',
      accountName: 'Joint_Spend',
    });
    expect(text).toBe('💸 *$1,240.00* USD — AMAZON \\*MKTPLACE\\_2 · Joint\\_Spend');
    // Every `*`/`_` that is not part of the bold entity is backslash-escaped, and
    // the entity itself is balanced: exactly two unescaped `*`, no unescaped `_`.
    const unescaped = text.replace(/\\[_*`[]/g, '');
    expect((unescaped.match(/\*/g) ?? [])).toHaveLength(2);
    expect(unescaped.match(/_/g)).toBeNull();
    // ...and the bold entity wraps only the figure, which has no specials in it.
    expect(unescaped.slice(unescaped.indexOf('*'), unescaped.lastIndexOf('*') + 1))
      .toBe('*$1,240.00*');
  });
});

describe('formatStuckTransferAlert', () => {
  // Lives here rather than in either host because BOTH syncers send it now (the
  // addon delivers the alerts it consumes), and two copies of a message builder
  // is exactly how the two would drift in what they say.
  it('names the pair, the amount and the next step', () => {
    expect(formatStuckTransferAlert({
      description: 'Payment ↔ Payment',
      amountCents: 130000,
      currency: 'USD',
    })).toBe(
      "⚠️ *Transfer stuck — couldn't auto-link after 3 tries*\n"
      + 'Payment ↔ Payment\n'
      + 'Amount: $1300.00 USD\n'
      + 'Try "Deep scan" in the addon, or check for a duplicate/mismatched leg.',
    );
  });

  it('escapes a `*`/`_`-laden pair description and keeps it out of every entity', () => {
    // Moved from companion/src/index.test.ts's end-to-end send test, which still
    // pins the same escaping through the companion's actual delivery path. The
    // failure mode: legacy Markdown ignores a backslash escape INSIDE an entity,
    // and card-network descriptors ("AMAZON *MKTPLACE") reach this string.
    const text = formatStuckTransferAlert({
      description: 'AMAZON *MKTPLACE ↔ Payment_Refund',
      amountCents: 500,
      currency: 'USD',
    });
    expect(text).toContain('AMAZON \\*MKTPLACE ↔ Payment\\_Refund');
    // Exactly one balanced bold pair (the fixed heading), and no stray `_`.
    const unescaped = text.replace(/\\[_*`[]/g, '');
    expect((unescaped.match(/\*/g) ?? [])).toHaveLength(2);
    expect(unescaped.match(/_/g)).toBeNull();
  });

  it('escapes the currency too — it is bank-supplied, not a literal', () => {
    const text = formatStuckTransferAlert({
      description: 'Payment ↔ Payment', amountCents: 500, currency: 'US_D',
    });
    expect(text).toContain('Amount: $5.00 US\\_D');
  });
});

describe('formatBalanceDriftAlert', () => {
  it('states the direction in words and gives the bank figure to compare against', () => {
    expect(formatBalanceDriftAlert({
      accountName: 'Spend',
      driftAmount: 1300,
      currency: 'USD',
      bankBalance: 3475.23,
    })).toBe(
      '⚠️ *Balance drift* — Spend\n'
      + "Wealthfolio is *$1,300.00* below the bank's *$3,475.23* USD\n"
      + 'Run "Reconcile balances" in the addon to line them up.',
    );
  });

  it('says "above" when Wealthfolio is the higher of the two', () => {
    // drift is SimpleFin − Wealthfolio, so a negative figure means Wealthfolio
    // is holding MORE than the bank. "off by -$1,300" would read as a double
    // negative, so the direction goes in the words and the figure stays positive.
    const text = formatBalanceDriftAlert({
      accountName: 'Spend', driftAmount: -1300, currency: 'USD', bankBalance: 3475.23,
    });
    expect(text).toContain("Wealthfolio is *$1,300.00* above the bank's *$3,475.23* USD");
    expect(text).not.toContain('-$');
  });

  it('keeps the bank balance NEGATIVE when the bank reports one', () => {
    // An overdrawn account (or a card) genuinely reports a negative balance.
    // The drift magnitude drops its sign because a word carries the direction;
    // this figure has no such word, and showing -$85.10 as $85.10 would misstate
    // the one number the reader is asked to check against.
    expect(formatBalanceDriftAlert({
      accountName: 'Spend', driftAmount: 200, currency: 'USD', bankBalance: -85.1,
    })).toContain("*$200.00* below the bank's *-$85.10* USD");
  });

  it('keeps the cents on both figures', () => {
    expect(formatBalanceDriftAlert({
      accountName: 'Savings', driftAmount: 1297.5, currency: 'USD', bankBalance: 610.65,
    })).toContain("*$1,297.50* below the bank's *$610.65*");
  });

  it('escapes a `_`/`*`-bearing account name and keeps it out of every entity', () => {
    const text = formatBalanceDriftAlert({
      accountName: 'Joint_Spend *Main*', driftAmount: 1300, currency: 'USD', bankBalance: 3475.23,
    });
    expect(text.split('\n')[0]).toBe('⚠️ *Balance drift* — Joint\\_Spend \\*Main\\*');
    // Only the deliberate entities survive unescaped: "Balance drift", the drift
    // figure and the bank figure — three balanced pairs, and no stray `_`.
    const unescaped = text.replace(/\\[_*`[]/g, '');
    expect((unescaped.match(/\*/g) ?? [])).toHaveLength(6);
    expect(unescaped.match(/_/g)).toBeNull();
  });
});

describe('formatDuplicatePruneAlert', () => {
  /** The two rows the sweep removed from the user's live savings account. */
  const liveRows = [
    {
      accountName: 'Savings', description: 'PNC BANK 1234 Transfer',
      date: '2026-07-27', amountCents: 130000, currency: 'USD',
    },
    {
      accountName: 'Savings', description: 'Monthly Interest Paid',
      date: '2026-06-30', amountCents: 250, currency: 'USD',
    },
  ];

  it('lists every removed row with its figure, date, description and account', () => {
    expect(formatDuplicatePruneAlert(liveRows)).toBe(
      '🧹 *Duplicate activities removed* — 2 rows\n'
      + 'Each of these was stored twice, so the extra copy was deleted during reconcile:\n'
      + '• *$1,300.00* USD · 2026-07-27 · PNC BANK 1234 Transfer · Savings\n'
      + '• *$2.50* USD · 2026-06-30 · Monthly Interest Paid · Savings\n'
      + 'Nothing to do — your balances should line up again.',
    );
  });

  it('says "1 row" for a single removal', () => {
    expect(formatDuplicatePruneAlert([liveRows[1]])).toContain(
      '🧹 *Duplicate activities removed* — 1 row\n',
    );
  });

  it('renders a row whose bank description is empty without an empty field', () => {
    const text = formatDuplicatePruneAlert([{ ...liveRows[1], description: '' }]);
    expect(text).toContain('• *$2.50* USD · 2026-06-30 · Savings');
  });

  it('escapes a `*`/`_`-bearing description and account name, outside every entity', () => {
    // Card-network descriptors are full of `*`, and legacy Markdown ignores a
    // backslash escape INSIDE an entity — so an unescaped one would leave a live
    // opener and Telegram would reject the whole message with a 400.
    const text = formatDuplicatePruneAlert([{
      accountName: 'Joint_Savings', description: 'AMAZON *MKTPLACE_US',
      date: '2026-07-27', amountCents: 130000, currency: 'USD',
    }]);
    expect(text).toContain('• *$1,300.00* USD · 2026-07-27 · AMAZON \\*MKTPLACE\\_US · Joint\\_Savings');
    // Two deliberate entities only: the fixed heading and the figure.
    const unescaped = text.replace(/\\[_*`[]/g, '');
    expect(unescaped.match(/\*/g) ?? []).toHaveLength(4);
    expect(unescaped.match(/_/g)).toBeNull();
  });

  it('caps the list so a big sweep cannot blow the message length limit', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      ...liveRows[1], description: `Row ${i}`,
    }));
    const text = formatDuplicatePruneAlert(many);
    expect(text).toContain('— 14 rows');
    expect((text.match(/^• /gm) ?? [])).toHaveLength(10);
    expect(text).toContain('…and 4 more');
  });

  it('renders nothing for an empty list — there is no news to send', () => {
    expect(formatDuplicatePruneAlert([])).toBe('');
  });
});

describe('formatMonthlyWrapUp', () => {
  const mixed = [
    { name: 'Groceries', spent: 280, budget: 300 },
    { name: 'Food & Dining', spent: 412, budget: 300 },
    { name: 'Transportation', spent: 45, budget: 50 },
    { name: 'Education', spent: 6, budget: 0 },
  ];

  it('renders a mixed month: under, over, and no-budget, with a total line', () => {
    // Budgeted only: spent 280 + 412 + 45 = 737 of 300 + 300 + 50 = 650, so the
    // month finished 87 over. Education's 6 is deliberately outside both totals
    // (see the "does not fold unbudgeted spend" test below).
    expect(wrapUpGlyphs(mixed, 'July')).toBe(
      '📅 *July wrap-up*\n'
      + '\n'
      + '✅ 🛒 Groceries  *$280* of $300\n'
      + '🚨 🍽️ Food & Dining  $412 of $300 · *$112 over*\n'
      + '✅ 🚗 Transportation  *$45* of $50\n'
      + '🏷️ 🎓 Education  *$6* · no budget\n'
      + '\n'
      + '🚨 Finished *$87 over budget* · spent $737 of $650',
    );
  });

  it('names the month it is reporting in the header', () => {
    expect(wrapUpGlyphs(mixed, 'December')).toContain('📅 *December wrap-up*');
  });

  it('says "under budget" and never "over" when the month came in under', () => {
    const text = wrapUpGlyphs(
      [{ name: 'Groceries', spent: 2312, budget: 2400 }],
      'July',
    );
    expect(text).toContain('💰 Finished *$88 under budget* · spent $2,312 of $2,400');
    expect(text).not.toContain('over budget');
  });

  it('states the DIRECTION on an over-budget total — never a bare figure that reads as headroom', () => {
    // The bug this pins shipped for real: a shared formatter absorbed the sign and
    // the summary line printed "$1,494 left" to a reader who was $1,494 OVER. A
    // total line for a finished month has exactly two directions and the words
    // must pick one, so the assertions here are as much about what must NOT
    // appear as what must.
    const text = wrapUpGlyphs(
      [{ name: 'Groceries', spent: 3894, budget: 2400 }],
      'July',
    );
    expect(text).toContain('🚨 Finished *$1,494 over budget* · spent $3,894 of $2,400');
    expect(text).not.toContain('under budget');
    expect(text).not.toContain('left');
    expect(text).not.toContain('💰');
  });

  it('does not fold unbudgeted spend into the under/over verdict', () => {
    // An unbudgeted category's spend comes out of nobody's budget, so counting it
    // against the total would turn a month that finished under into one that
    // finished over. Same reasoning, and the same choice, as the daily digest's
    // month-context line.
    const text = wrapUpGlyphs(
      [
        { name: 'Groceries', spent: 200, budget: 300 },
        { name: 'Education', spent: 5000, budget: 0 },
      ],
      'July',
    );
    expect(text).toContain('💰 Finished *$100 under budget* · spent $200 of $300');
  });

  it('never calls an unbudgeted category "over" — there is nothing to be over', () => {
    const text = wrapUpGlyphs([{ name: 'Education', spent: 6, budget: 0 }], 'July');
    expect(text).toContain('🏷️ 🎓 Education  *$6* · no budget');
    expect(text).not.toContain('over');
    expect(text).not.toContain('🚨');
  });

  it('reads "right on budget" rather than "$0 under" when the month landed level', () => {
    const text = wrapUpGlyphs([{ name: 'Groceries', spent: 300, budget: 300 }], 'July');
    expect(text).toContain('💰 Finished *right on budget* · spent $300 of $300');
    expect(text).not.toContain('$0 under');
  });

  it('does not raise 🚨 for an overspend that rounds to $0', () => {
    // Keyed off the RENDERED magnitude, like the daily digest's summary: summing
    // 2-decimal budgets leaves remainders like -2.8e-17, and "$0 over budget" is
    // a false alarm dressed up as a result.
    const text = wrapUpGlyphs([{ name: 'Groceries', spent: 300.4, budget: 300 }], 'July');
    expect(text).not.toContain('🚨');
    expect(text).not.toContain('$0 over');
    expect(text).toContain('✅ 🛒 Groceries  *$300* of $300');
    expect(text).toContain('💰 Finished *right on budget*');
  });

  it('reports the spend, not a verdict, when nothing was budgeted all month', () => {
    const text = wrapUpGlyphs(
      [{ name: 'Education', spent: 40, budget: 0 }],
      'July',
    );
    expect(text).toContain('🏷️ *$40 spent* · no budgets set');
    expect(text).not.toContain('under budget');
    expect(text).not.toContain('over budget');
    expect(text).toContain('selected for the monthly report');
  });

  it('does not claim a verdict for a month with no budgets and no spending', () => {
    const text = wrapUpGlyphs([{ name: 'Education', spent: 0, budget: 0 }], 'July');
    expect(text).toContain('Nothing spent, no budgets set in July.');
    expect(text).not.toContain('of $0');
    expect(text).not.toContain('budget*');
  });

  it('says nothing to report — pointing at both causes — when no categories are included', () => {
    // Two distinct causes: no budgets and no spending exist for that month, or
    // every category was deselected for this report. The text must not assert
    // either one, matching the daily digest's empty branch.
    const text = wrapUpGlyphs([], 'July');
    expect(text).toBe(
      '📅 *July wrap-up*\n'
      + '\n'
      + 'Nothing to report. Set up budgets in Wealthfolio, or check that categories are selected for the monthly report in the SimpleFin Sync addon.',
    );
  });

  it('escapes `_`/`*`-bearing category names and keeps them OUTSIDE every entity', () => {
    // Legacy Markdown does not honour a backslash escape inside an entity, so
    // `*Food\_Drink*` still leaves a live italic opener and Telegram rejects the
    // WHOLE message with a 400. The bold therefore sits only on the figures.
    const text = wrapUpGlyphs(
      [
        { name: 'Food_Drink', spent: 412, budget: 300 },
        { name: 'Wants *only*', spent: 6, budget: 0 },
      ],
      'July',
    );
    expect(text).toContain('🚨 🍽️ Food\\_Drink  $412 of $300 · *$112 over*');
    expect(text).toContain('🏷️ ⭐ Wants \\*only\\*  *$6* · no budget');
    expect(text).not.toContain('*Food\\_Drink*');
    // Every surviving `*` belongs to a deliberate entity, and no `_` survives at
    // all: header (2), the over figure (2), the no-budget figure (2), the total
    // verdict (2).
    const unescaped = text.replace(/\\[_*`[]/g, '');
    expect((unescaped.match(/\*/g) ?? [])).toHaveLength(8);
    expect(unescaped.match(/_/g)).toBeNull();
  });

  it('is host-agnostic: the month is data, never derived from the clock', () => {
    // `shared/*` must not call `new Date()`; the companion passes the month it is
    // reporting so the header can name a month that is not the current one.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2027, 0, 1, 9, 0, 0));
    try {
      expect(wrapUpGlyphs([{ name: 'Groceries', spent: 10, budget: 20 }], 'December'))
        .toContain('📅 *December wrap-up*');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves no trailing whitespace, so a caller can append a block cleanly', () => {
    const text = wrapUpGlyphs(mixed, 'July');
    expect(text).toBe(text.trimEnd());
  });
});
