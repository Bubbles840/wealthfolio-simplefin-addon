import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendTelegramMessage, formatDailyReport, formatWeeklyReport } from './telegram.js';

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
    expect(text).toContain('• 🛒 *Groceries*: *$100.00/week*');
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
