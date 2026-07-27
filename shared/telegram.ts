/**
 * shared/telegram.ts
 *
 * Lightweight Telegram Bot API client and message formatting utilities for
 * budget reports and daily spending allowances.
 */

export interface TelegramSendResult {
  ok: boolean;
  description?: string;
}

export interface CategoryReportItem {
  name: string;
  budget: number;
  spent: number;
  mode: 'daily' | 'weekly' | 'monthly';
}

export interface DailyReportData {
  dateStr: string;
  daysLeftInMonth: number;
  categories: CategoryReportItem[];
}

export interface WeeklyReportData {
  weekSpent: number;
  monthSpent: number;
  monthBudget: number;
  categories: CategoryReportItem[];
}

/**
 * Sends a message via the Telegram Bot API.
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  network?: { request: (opts: any) => Promise<{ status: number; body: string }> },
): Promise<TelegramSendResult> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });

  let json: any;

  if (network && typeof network.request === 'function') {
    try {
      const res = await network.request({
        url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      json = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
    } catch {
      // Fallback to direct fetch if network.request fails
    }
  }

  if (!json) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      json = await res.json();
    } catch (err) {
      return { ok: false, description: (err as Error).message };
    }
  }

  if (!json || json.ok === false) {
    return { ok: false, description: json?.description ?? 'Telegram API request failed' };
  }
  return { ok: true };
}

export const DEFAULT_CATEGORY_EMOJIS: Record<string, string> = {
  housing: '🏠',
  transportation: '🚗',
  groceries: '🛒',
  grocery: '🛒',
  'bills & utilities': '📄',
  bills: '📄',
  utilities: '📄',
  'health & wellness': '🏥',
  health: '🏥',
  wellness: '🏥',
  education: '🎓',
  shopping: '🛍️',
  'food & dining': '🍽️',
  dining: '🍽️',
  food: '🍽️',
  entertainment: '🎬',
  needs: '📌',
  wants: '⭐',
};

export const DEFAULT_SPENDING_KEYWORDS: Record<string, string[]> = {
  'Food & Dining': [
    'wnb factory', 'mcdonald', 'starbucks', 'doordash', 'ubereats', 'grubhub',
    'restaurant', 'dining', 'burger', 'pizza', 'cafe', 'coffee', 'taco', 'bar', 'grill', 'bakery'
  ],
  'Groceries': [
    'grocery', 'groceries', 'walmart', 'kroger', 'target', 'trader joe', 'whole foods', 'aldi',
    'publix', 'safeway', 'h-e-b', 'costco', 'sams club', 'supermarket', 'market'
  ],
  'Transportation': [
    'parc', 'parking', 'uber', 'lyft', 'transit', 'metro', 'gas', 'shell', 'bp', 'exxon',
    'chevron', 'speedway', 'valero', 'toll', 'ezpass'
  ],
  'Bills & Utilities': [
    'anthropic', 'claude', 'openai', 'chatgpt', 'netflix', 'spotify', 'apple.com', 'google',
    'electric', 'water', 'internet', 'verizon', 'att', 't-mobile', 'comcast', 'xfinity', 'utility', 'subscription'
  ],
  'Housing': [
    'rent', 'mortgage', 'lease', 'apartment', 'housing', 'hoa', 'property'
  ],
  'Shopping': [
    'amazon', 'ebay', 'best buy', 'nike', 'clothing', 'apparel', 'retail'
  ],
  'Health & Wellness': [
    'pharmacy', 'cvs', 'walgreens', 'doctor', 'hospital', 'dental', 'fitness', 'gym', 'health'
  ],
  'Entertainment': [
    'steam', 'playstation', 'xbox', 'cinema', 'movie', 'theater', 'event', 'ticket'
  ],
};

export function categorizeActivity(comment?: string | null): string {
  if (!comment) return 'Other';
  const clean = comment.toLowerCase();
  for (const [category, keywords] of Object.entries(DEFAULT_SPENDING_KEYWORDS)) {
    if (keywords.some((kw) => clean.includes(kw))) {
      return category;
    }
  }
  return 'Other';
}

export function getCategoryEmoji(name: string): string {
  const clean = name.toLowerCase();
  for (const [key, emoji] of Object.entries(DEFAULT_CATEGORY_EMOJIS)) {
    if (clean.includes(key)) return emoji;
  }
  return '🏷️';
}

function money(amount: number): string {
  return `$${Math.abs(amount).toFixed(2)}`;
}

/**
 * Formats the Daily Category Spending Allowance report message for Telegram.
 */
export function formatDailyReport(data: DailyReportData): string {
  let msg = `☀️ *Daily Budget Allowance* (${data.dateStr})\n`;
  msg += `📅 *${data.daysLeftInMonth} days remaining* in this month.\n\n`;

  if (data.categories.length === 0) {
    msg += `No active category budgets found. Set up categories in Wealthfolio to see daily limits.`;
    return msg;
  }

  msg += `*Category Allowances:*\n`;
  for (const c of data.categories) {
    const emoji = getCategoryEmoji(c.name);
    const remaining = c.budget - c.spent;
    if (c.budget > 0 && remaining < 0) {
      msg += `• ${emoji} *${c.name}*: 🚨 *${money(Math.abs(remaining))} over budget!*\n`;
    } else if (c.mode === 'daily') {
      const dailyLimit = data.daysLeftInMonth > 0 ? Math.max(0, remaining / data.daysLeftInMonth) : 0;
      msg += `• ${emoji} *${c.name}*: *${money(dailyLimit)}/day* (${money(remaining)} left in month)\n`;
    } else if (c.mode === 'weekly') {
      const weeklyRemaining = Math.max(0, remaining / 4);
      msg += `• ${emoji} *${c.name}*: *${money(weeklyRemaining)}/week* (${money(remaining)} left in month)\n`;
    } else {
      msg += `• ${emoji} *${c.name}*: *${money(remaining)} remaining* for month\n`;
    }
  }

  msg += `\n💡 _Tip: Check Wealthfolio for real-time category activity._`;
  return msg;
}

/**
 * Formats the Weekly Budget Summary report message for Telegram.
 */
export function formatWeeklyReport(data: WeeklyReportData): string {
  const percentUsed = data.monthBudget > 0 ? Math.round((data.monthSpent / data.monthBudget) * 100) : 0;
  const monthRemaining = data.monthBudget - data.monthSpent;

  let msg = `📊 *Weekly Budget & Spending Summary*\n\n`;
  msg += `💸 *Spent MTD*: ${money(data.monthSpent)}${data.monthBudget > 0 ? ` / ${money(data.monthBudget)} (${percentUsed}% used)` : ''}\n`;
  msg += `💰 *Status*: ${monthRemaining >= 0 ? `${money(monthRemaining)} remaining` : `🚨 ${money(Math.abs(monthRemaining))} OVER BUDGET!`}\n\n`;

  if (data.categories.length > 0) {
    msg += `*Category Breakdown:*\n`;
    for (const c of data.categories) {
      const emoji = getCategoryEmoji(c.name);
      const pct = c.budget > 0 ? Math.round((c.spent / c.budget) * 100) : 0;
      msg += `• ${emoji} *${c.name}*: ${money(c.spent)}${c.budget > 0 ? ` / ${money(c.budget)} (${pct}%)` : ''}\n`;
    }
  }

  return msg;
}
