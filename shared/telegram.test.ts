import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendTelegramMessage, formatDailyReport, formatWeeklyReport, formatWeeklyRemainingDigest, formatMonthlyRemainingSummary } from './telegram.js';

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

describe('formatDailyReport', () => {
  it('formats daily category allowances correctly', () => {
    const text = formatDailyReport({
      dateStr: 'Jul 27, 2026',
      daysLeftInMonth: 10,
      categories: [
        { name: 'Dining', budget: 500, spent: 200, mode: 'daily' },
        { name: 'Groceries', budget: 800, spent: 400, mode: 'weekly' },
        { name: 'Housing', budget: 1500, spent: 1500, mode: 'monthly' },
      ],
    });

    expect(text).toContain('☀️ *Daily Budget Allowance*');
    expect(text).toContain('• 🍽️ *Dining*: *$30.00/day*');
    expect(text).toContain('• 🛒 *Groceries*: *$200.00/week*');
    expect(text).toContain('• 🏠 *Housing*: *$0.00 remaining*');
  });
});

describe('formatWeeklyReport', () => {
  it('formats weekly budget summary correctly', () => {
    const text = formatWeeklyReport({
      weekSpent: 350,
      monthSpent: 1200,
      monthBudget: 2000,
      categories: [
        { name: 'Dining', budget: 500, spent: 300, mode: 'daily' },
      ],
    });

    expect(text).toContain('📊 *Weekly Budget & Spending Summary*');
    expect(text).toContain('60% used');
    expect(text).toContain('🍽️ *Dining*: $300.00 / $500.00 (60%)');
  });
});

describe('formatWeeklyRemainingDigest', () => {
  it('shows remaining budget divided across the weeks left in the month', () => {
    const text = formatWeeklyRemainingDigest(
      [{ name: 'Groceries', spent: 200, budget: 800 }],
      3,
    );
    expect(text).toContain('🛒 *Groceries*: *$200.00 left this week*');
  });

  it('flags a category that is over budget instead of dividing a negative number', () => {
    const text = formatWeeklyRemainingDigest(
      [{ name: 'Dining', spent: 550, budget: 500 }],
      2,
    );
    expect(text).toContain('🍽️ *Dining*: 🚨 *$50.00 over budget!*');
  });

  it('flags spending in a category with no budget set', () => {
    const text = formatWeeklyRemainingDigest(
      [{ name: 'Shopping', spent: 40, budget: 0 }],
      2,
    );
    expect(text).toContain('🛍️ *Shopping*: 🚨 *$40.00 over budget!*');
  });

  it('shows a placeholder message with no categories', () => {
    const text = formatWeeklyRemainingDigest([], 2);
    expect(text).toContain('No budgeted categories to report');
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
});
