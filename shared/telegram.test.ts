import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendTelegramMessage, formatDailySpendingDigest, formatMonthlyRemainingSummary, formatSyncHealthFooter, escapeMarkdown, weeklyEnvelope, moneyWhole, formatLargeTransactionAlert, formatBalanceDriftAlert } from './telegram.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => mockFetch.mockReset());

describe('sendTelegramMessage', () => {
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
    const text = formatDailySpendingDigest(
      [{ name: 'Groceries', monthSpent: 200, weekSpent: 50, budget: 800 }],
      period,
    );
    expect(text).toContain('☀️ *Daily Spending Check*');
    expect(text).not.toContain('Weekly Spending Update');
  });

  it('leads every category line with what is left THIS WEEK', () => {
    // budgetAtWeekStart = 1000 - 500 = 500; envelope = 500 * 7 / 24 = 145.83;
    // 50 already spent this week leaves 95.83.
    const text = formatDailySpendingDigest(
      [{ name: 'Groceries', monthSpent: 550, weekSpent: 50, budget: 1000 }],
      period,
    );
    expect(text).toContain('🛒 Groceries  *$95.83*');
  });

  it('states the unit once in the header instead of repeating it per line', () => {
    const text = formatDailySpendingDigest(
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
    const text = formatDailySpendingDigest(
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
    const text = formatDailySpendingDigest(
      [{ name: 'Groceries', monthSpent: 0, weekSpent: 0, budget: 100 }],
      { daysFromWeekStartToMonthEnd: 1, daysLeftInMonthInclusive: 1 },
    );
    expect(text).toContain('· 1 day to go');
  });

  it('flags a category over budget for the MONTH, which dominates the weekly view', () => {
    const text = formatDailySpendingDigest(
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
    const text = formatDailySpendingDigest(
      [{ name: 'Shopping', monthSpent: 315.5, weekSpent: 90, budget: 250 }],
      period,
    );
    expect(text).toContain('🛍️ Shopping  🚨 *$66 over* for the month');
    expect(text).not.toContain('this week ·');
  });

  it('distinguishes over-for-the-week from over-for-the-month', () => {
    // budgetAtWeekStart = 300 - 80 = 220; envelope = 220 * 7 / 24 = 64.17;
    // 120 spent this week leaves -55.83, yet $100 remains for the month.
    const text = formatDailySpendingDigest(
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
    const text = formatDailySpendingDigest(
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
    const text = formatDailySpendingDigest(
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
    const overWeek = formatDailySpendingDigest(
      [{ name: 'Bills', monthSpent: 350, weekSpent: 350, budget: 350 }],
      period,
    );
    expect(overWeek).not.toContain('budget used up');
    expect(overWeek).toContain('over*');
    const overMonth = formatDailySpendingDigest(
      [{ name: 'Bills', monthSpent: 400, weekSpent: 0, budget: 350 }],
      period,
    );
    expect(overMonth).not.toContain('budget used up');
    expect(overMonth).toContain('🚨 *$50 over* for the month');
  });

  it('reports spending with no budget as exactly that, not as "over budget"', () => {
    // You cannot be over a budget you never set.
    const text = formatDailySpendingDigest(
      [{ name: 'Shopping', monthSpent: 40, weekSpent: 40, budget: 0 }],
      period,
    );
    expect(text).toContain('🛍️ Shopping  *no budget* · $40 spent');
    expect(text).not.toContain('over');
  });

  it('omits the money summary when nothing in the digest has a budget', () => {
    // Summing "remaining" across only-unbudgeted categories would report a
    // negative month remaining against a budget of zero.
    const text = formatDailySpendingDigest(
      [{ name: 'Shopping', monthSpent: 40, weekSpent: 40, budget: 0 }],
      period,
    );
    expect(text).not.toContain('left this month');
    expect(text).toContain('📅 23 days left in the month');
  });

  it('sums the month summary over budgeted categories only', () => {
    const text = formatDailySpendingDigest(
      [
        { name: 'Groceries', monthSpent: 550, weekSpent: 50, budget: 1000 },
        { name: 'Shopping', monthSpent: 40, weekSpent: 40, budget: 0 },
      ],
      period,
    );
    // 450, not 410 — the unbudgeted $40 is not spent out of anyone's budget.
    expect(text).toContain('💰 $450 left this month');
  });

  it('keeps cents on the spendable weekly figure and drops them on month context', () => {
    // budgetAtWeekStart = 900 - 354 = 546; envelope = 546 * 7 / 24 = 159.25;
    // left = 159.25 - 65.4 = 93.85, a number the reader spends against, so the
    // cents stay. Month remaining 480.60 is context, so it rounds to $481.
    const text = formatDailySpendingDigest(
      [{ name: 'Groceries', monthSpent: 419.4, weekSpent: 65.4, budget: 900 }],
      period,
    );
    expect(text).toContain('🛒 Groceries  *$93.85*');
    expect(text).toContain('💰 $481 left this month');
  });

  it('groups thousands so a big figure stays readable', () => {
    const text = formatDailySpendingDigest(
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
    const text = formatDailySpendingDigest(overBudgetMonth, endOfMonth);
    expect(text).not.toContain('left this month');
    expect(text).not.toContain('💰');
    expect(text).toContain('🚨 $1,494 over budget this month · 3 days to go');
  });

  it('keeps the days-to-go tail on the over-budget summary — it is useful either way', () => {
    const text = formatDailySpendingDigest(
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
            const total = (b1 > 0 ? b1 - s1 : 0) + (b2 > 0 ? b2 - s2 : 0);
            const text = formatDailySpendingDigest(cats, period);
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
    const noise = formatDailySpendingDigest(
      [
        { name: 'Groceries', budget: 0.3, monthSpent: 0.1, weekSpent: 0 },
        { name: 'Dining', budget: 0.2, monthSpent: 0.4, weekSpent: 0 },
      ],
      period,
    );
    expect(noise).toContain('💰 $0 left this month');
    expect(noise).not.toContain('over budget');

    const loose = formatDailySpendingDigest(
      [{ name: 'Groceries', budget: 100, monthSpent: 100.3, weekSpent: 0 }],
      period,
    );
    expect(loose).toContain('💰 $0 left this month');
    expect(loose).not.toContain('over budget');

    // A dollar over is a real dollar over.
    const real = formatDailySpendingDigest(
      [{ name: 'Groceries', budget: 100, monthSpent: 101, weekSpent: 0 }],
      period,
    );
    expect(real).toContain('🚨 $1 over budget this month');
  });

  it('groups thousands in the over-budget summary too', () => {
    const text = formatDailySpendingDigest(
      [{ name: 'Housing', budget: 1000, monthSpent: 13500, weekSpent: 0 }],
      period,
    );
    expect(text).toContain('🚨 $12,500 over budget this month');
  });

  it('prints the per-category month overspend unsigned, with "over" carrying the sign', () => {
    // Line 303's branch: the word does the work, so the figure must not also
    // carry a minus — "-$2,500 over" reads as a double negative.
    const text = formatDailySpendingDigest(
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
    const text = formatDailySpendingDigest(
      [{ name: 'Dining', budget: 300, monthSpent: 200, weekSpent: 120 }],
      period,
    );
    expect(text).toContain('⚠️ *$55.83 over* · $100 left mo');
    expect(text).not.toContain('-$');
    // The same input one dollar deeper into the month tips into the 🚨 branch,
    // which is what keeps the "left mo" figure non-negative.
    const over = formatDailySpendingDigest(
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
    const positive = formatDailySpendingDigest(
      [{ name: 'Groceries', budget: 1000, monthSpent: 550, weekSpent: 50 }],
      period,
    );
    expect(positive).toContain('🛒 Groceries  *$95.83*');
    const atZero = formatDailySpendingDigest(
      [{ name: 'Groceries', budget: 1000, monthSpent: 1000, weekSpent: 0 }],
      period,
    );
    expect(atZero).toContain('*$0* · budget used up');
    // One cent past the envelope ($1,200 × 7/24 = $350) and the ⚠️ branch takes
    // it, sign and all.
    const past = formatDailySpendingDigest(
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
    const text = formatDailySpendingDigest(
      [{ name: 'Shopping', budget: 0, monthSpent: 40.6, weekSpent: 40.6 }],
      period,
    );
    expect(text).toContain('🛍️ Shopping  *no budget* · $41 spent');
    expect(text).not.toContain('-$');
  });

  it('names both possible causes in the empty state', () => {
    // Reachable two ways — no budgets exist, or every category was deselected
    // in the addon — so the text must not blame only the first.
    const text = formatDailySpendingDigest([], period);
    expect(text).toContain('Set up budgets in Wealthfolio');
    expect(text).toContain('categories are selected');
    // No "left to spend this week" promise when there is nothing to show.
    expect(text).not.toContain('_left to spend this week_');
  });

  it('ends without trailing whitespace so an appended footer stays a separate block', () => {
    const text = formatDailySpendingDigest(
      [{ name: 'Groceries', monthSpent: 550, weekSpent: 50, budget: 1000 }],
      period,
    );
    expect(text).toBe(text.trimEnd());
    // A blank line separates the category list from the summary line.
    expect(text).toMatch(/\n\n💰 /);
  });

  it('escapes Markdown specials in a category name so the message can still send', () => {
    const text = formatDailySpendingDigest(
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
    const text = formatDailySpendingDigest(
      [{ name: 'Food_Drink', monthSpent: 40, weekSpent: 10, budget: 100 }],
      period,
    );
    expect(text).not.toContain('*Food\\_Drink*');
    // Bold sits on the figures, which never contain Markdown specials.
    expect(text).toMatch(/Food\\_Drink {2}\*\$/);
  });

  it('is materially shorter than the one-line-per-unit format it replaces', () => {
    const text = formatDailySpendingDigest(
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
    const text = formatMonthlyRemainingSummary(1200, 2000);
    expect(text).toContain('💰 *$800 left* this month');
    expect(text).toContain('_spent $1,200 of $2,000 · 60%_');
  });

  it('flags being over budget for the month', () => {
    const text = formatMonthlyRemainingSummary(2200, 2000);
    expect(text).toContain('🚨 *$200 over budget* this month');
    expect(text).toContain('_spent $2,200 of $2,000 · 110%_');
  });

  it('prints the overspend unsigned — "over budget" carries the sign', () => {
    // A minus on the figure as well would read as a double negative, and the
    // supporting line's two figures are both non-negative by construction:
    // `totalBudget <= 0` returns early above, and `totalSpent` is a SUM(ABS(..))
    // of outgoing activity.
    const text = formatMonthlyRemainingSummary(2200.4, 2000);
    expect(text).toContain('🚨 *$200 over budget* this month');
    expect(text).toContain('_spent $2,200 of $2,000 · 110%_');
    expect(text).not.toContain('-$');
  });

  it('only prints a non-negative figure beside the word "left"', () => {
    // The "left" branch is only reached once `remaining < 0` has been ruled out,
    // so it has no negative case to render; one dollar the other way is the 🚨
    // branch, which is what keeps that guarantee.
    expect(formatMonthlyRemainingSummary(2000, 2000)).toContain('💰 *$0 left* this month');
    const over = formatMonthlyRemainingSummary(2001, 2000);
    expect(over).not.toContain('left*');
    expect(over).toContain('🚨 *$1 over budget* this month');
  });

  it('reads as the same family as the daily digest\'s over-budget summary', () => {
    // Both reports lead an overspend with 🚨 and the words "over budget", so the
    // two never disagree about what a negative month looks like.
    const weekly = formatMonthlyRemainingSummary(2200, 2000);
    const daily = formatDailySpendingDigest(
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
    const text = formatMonthlyRemainingSummary(0, 0);
    expect(text).not.toContain('left* this month');
    expect(text).not.toContain('of $0');
    expect(text).toContain('Nothing spent, no budgets set');
  });

  it('reports the spend, not a "left" figure, when money went out with no budget set', () => {
    const text = formatMonthlyRemainingSummary(40, 0);
    expect(text).toContain('🏷️ *$40 spent* · no budget set');
    expect(text).not.toContain('left* this month');
    expect(text).not.toContain('over budget');
  });

  it('points at both possible causes of a zero budget', () => {
    for (const text of [formatMonthlyRemainingSummary(0, 0), formatMonthlyRemainingSummary(40, 0)]) {
      expect(text).toContain('Add budgets in Wealthfolio');
      expect(text).toContain('selected for the weekly report');
    }
  });

  it('keeps the weekly report clearly labelled as weekly', () => {
    expect(formatMonthlyRemainingSummary(1200, 2000)).toContain('📊 *Weekly Budget Check-In*');
  });

  it('rounds to whole dollars — every figure here is month-level context', () => {
    const text = formatMonthlyRemainingSummary(1550.75, 2400);
    expect(text).toContain('💰 *$849 left* this month');
    expect(text).toContain('_spent $1,551 of $2,400 · 65%_');
  });

  it('reads as the same family as the daily digest — emoji-led figure, no parenthetical', () => {
    const text = formatMonthlyRemainingSummary(1200, 2000);
    expect(text).not.toContain('(spent');
    expect(text).toBe(text.trimEnd());
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
