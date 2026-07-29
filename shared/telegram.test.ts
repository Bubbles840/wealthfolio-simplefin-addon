import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendTelegramMessage, formatWeeklyRemainingDigest, formatMonthlyRemainingSummary, formatSyncHealthFooter, escapeMarkdown, weeklyPace } from './telegram.js';

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

describe('formatWeeklyRemainingDigest', () => {
  it('is titled unmistakably as a daily report, not a weekly one', () => {
    // The user's original complaint was a report that "looked like a weekly
    // summary going out on the wrong day". A daily message titled "Weekly
    // Spending Update" recreates exactly that confusion.
    const text = formatWeeklyRemainingDigest([{ name: 'Groceries', spent: 200, budget: 800 }], 14);
    expect(text).toContain('☀️ *Daily Spending Check*');
    expect(text).not.toContain('Weekly Spending Update');
  });

  it('leads with the true monthly remaining and offers the weekly figure only as a pace', () => {
    // 22 days after today -> horizon 23 -> 600 * 7 / 23 = 182.6
    const text = formatWeeklyRemainingDigest(
      [{ name: 'Groceries', spent: 200, budget: 800 }],
      22,
    );
    expect(text).toContain('• 🛒 Groceries: *$600.00 left this month* · ≈$182.61/wk pace');
    // "left this week" was the dishonest label: it was month-to-date remaining
    // spread over a week, so spending $100 today moved it by only ~$20.
    expect(text).not.toContain('left this week');
  });

  it('drops the headline figure by exactly what was spent', () => {
    const before = formatWeeklyRemainingDigest([{ name: 'Groceries', spent: 200, budget: 800 }], 22);
    const after = formatWeeklyRemainingDigest([{ name: 'Groceries', spent: 300, budget: 800 }], 22);
    expect(before).toContain('*$600.00 left this month*');
    expect(after).toContain('*$500.00 left this month*');
  });

  it('does not jump across a week boundary — day 23 vs day 24 of a 31-day month', () => {
    // The old `ceil(daysLeft / 7)` denominator stepped 2 -> 1 here, doubling
    // the displayed number overnight. Day 23 leaves 8 days after today, day 24
    // leaves 7.
    const cat = [{ name: 'Groceries', spent: 200, budget: 800 }];
    const day23 = weeklyPace(600, 8);
    const day24 = weeklyPace(600, 7);
    expect(day23).toBeCloseTo(466.67, 2);
    expect(day24).toBeCloseTo(525, 2);
    // Day-over-day movement stays well under the 2x jump the old formula made.
    expect(day24 / day23).toBeLessThan(1.2);
    expect(formatWeeklyRemainingDigest(cat, 8)).toContain('≈$466.67/wk pace');
    expect(formatWeeklyRemainingDigest(cat, 7)).toContain('≈$525.00/wk pace');
  });

  it('never advertises a pace larger than the money that actually remains', () => {
    // Last day of the month: 600 * 7 / 1 = 4200 uncapped, which would read as
    // permission to spend seven times the remaining budget.
    const text = formatWeeklyRemainingDigest([{ name: 'Groceries', spent: 200, budget: 800 }], 0);
    expect(text).toContain('*$600.00 left this month* · ≈$600.00/wk pace');
  });

  it('is not understated at the start of the month', () => {
    // Day 1 of a 31-day month: 30 days after today. The old formula divided by
    // ceil(30/7) = 5 weeks when ~4.4 weeks actually exist, understating the
    // pace; the day-proportional form gives 800 * 7 / 31.
    expect(weeklyPace(800, 30)).toBeCloseTo(180.65, 2);
    expect(weeklyPace(800, 30)).toBeGreaterThan(800 / 5);
  });

  it('flags a category that is over budget instead of showing a negative pace', () => {
    const text = formatWeeklyRemainingDigest(
      [{ name: 'Dining', spent: 550, budget: 500 }],
      10,
    );
    expect(text).toContain('• 🍽️ Dining: 🚨 *$50.00 over budget* this month');
    expect(text).not.toContain('pace');
  });

  it('reports spending with no budget as exactly that, not as "over budget"', () => {
    // You cannot be over a budget you never set — the old text claimed
    // "🚨 *$40.00 over budget!*" for a category with no budget row at all.
    const text = formatWeeklyRemainingDigest(
      [{ name: 'Shopping', spent: 40, budget: 0 }],
      10,
    );
    expect(text).toContain('• 🛍️ Shopping: *$40.00 spent* · no budget set');
    expect(text).not.toContain('over budget');
  });

  it('names both possible causes in the empty state', () => {
    // Reachable two ways — no budgets exist, or every category was deselected
    // in the addon — so the text must not blame only the first.
    const text = formatWeeklyRemainingDigest([], 10);
    expect(text).toContain('Set up budgets in Wealthfolio');
    expect(text).toContain('categories are selected');
  });

  it('escapes Markdown specials in a category name so the message can still send', () => {
    const text = formatWeeklyRemainingDigest(
      [{ name: 'Food_Drink', spent: 40, budget: 100 }],
      10,
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
    const text = formatWeeklyRemainingDigest(
      [{ name: 'Food_Drink', spent: 40, budget: 100 }],
      10,
    );
    expect(text).not.toContain('*Food\\_Drink*');
    // Bold sits on the figures, which never contain Markdown specials.
    expect(text).toContain('Food\\_Drink: *$60.00 left this month*');
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
  it('shows total remaining when under budget', () => {
    const text = formatMonthlyRemainingSummary(1200, 2000);
    expect(text).toContain('$800.00 remaining');
    expect(text).toContain('spent $1200.00 of $2000.00, 60%');
  });

  it('flags being over budget for the month', () => {
    const text = formatMonthlyRemainingSummary(2200, 2000);
    expect(text).toContain('🚨');
    expect(text).toContain('$200.00 over budget');
  });

  it('does not claim "$0.00 remaining" when no budget exists at all', () => {
    // Reachable by deselecting every weekly category, or before any budget is
    // created. This report is one number, so the old
    // "💰 *$0.00 remaining* this month (spent $0.00 of $0.00, 0%)" read as a
    // real, calmly-reported result.
    const text = formatMonthlyRemainingSummary(0, 0);
    expect(text).not.toContain('remaining');
    expect(text).not.toContain('of $0.00');
    expect(text).toContain('No budgets set and no spending recorded');
  });

  it('reports the spend, not a "remaining" figure, when money went out with no budget set', () => {
    const text = formatMonthlyRemainingSummary(40, 0);
    expect(text).toContain('$40.00 spent');
    expect(text).toContain('no budget set');
    expect(text).not.toContain('remaining');
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
});
