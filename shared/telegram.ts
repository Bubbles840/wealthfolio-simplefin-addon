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

/**
 * Escapes the characters Telegram's legacy Markdown `parse_mode` treats as
 * formatting specials (`_`, `*`, `` ` ``, `[`) so arbitrary text — an error
 * message, a bank transaction description, a user-entered category name —
 * can't be read as (possibly unbalanced) markup. An unbalanced special
 * anywhere in the message makes the Telegram API reject the *entire* send
 * with a 400, not just mangle the offending word, so every place arbitrary
 * text is interpolated into a message must run through this first.
 *
 * Scoped to legacy Markdown specifically: MarkdownV2 reserves a much larger
 * character set (adds `.`, `!`, `-`, `(`, `)`, `~`, `>`, `#`, `+`, `=`, `|`,
 * `{`, `}`), so switching `parse_mode` later must not assume this function
 * still covers it — it would under-escape.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([_*`[])/g, '\\$1');
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
  'fees & charges': '💳',
  fees: '💳',
  needs: '📌',
  wants: '⭐',
};

import type { CategoryRule } from './types.js';

export const DEFAULT_SPENDING_KEYWORDS: Record<string, string[]> = {
  'Housing': [
    'housing', 'rent', 'mortgage', 'lease', 'apartment', 'hoa', 'property',
    'landlord', 'realty', 'real estate', 'homes', 'residence', 'residential'
  ],
  'Transportation': [
    'parc', 'parking', 'uber', 'lyft', 'transit', 'metro', 'gas', 'shell', 'bp', 'exxon',
    'chevron', 'speedway', 'valero', 'toll', 'ezpass', 'auto'
  ],
  'Groceries': [
    'grocery', 'groceries', 'walmart', 'kroger', 'target', 'trader joe', 'whole foods', 'aldi',
    'publix', 'safeway', 'h-e-b', 'costco', 'sams club', 'supermarket', 'market', 'meijer'
  ],
  'Food & Dining': [
    'wnb factory', 'mcdonald', 'starbucks', 'doordash', 'ubereats', 'grubhub',
    'restaurant', 'dining', 'burger', 'pizza', 'cafe', 'coffee', 'taco', 'bar', 'grill', 'bakery'
  ],
  'Bills & Utilities': [
    'anthropic', 'claude', 'openai', 'chatgpt', 'netflix', 'spotify', 'apple.com', 'google',
    'electric', 'water', 'internet', 'verizon', 'att', 't-mobile', 'comcast', 'xfinity', 'utility', 'subscription'
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

export function categorizeActivity(comment?: string | null, customRules?: CategoryRule[]): string {
  if (!comment) return 'Other';
  const clean = comment.toLowerCase();

  if (Array.isArray(customRules)) {
    for (const rule of customRules) {
      if (Array.isArray(rule.keywords) && rule.keywords.length > 0) {
        if (rule.keywords.some((kw: string) => kw.trim() && clean.includes(kw.trim().toLowerCase()))) {
          return rule.categoryName;
        }
      }
    }
  }

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
      const weeksLeftInMonth = Math.max(1, Math.ceil(data.daysLeftInMonth / 7));
      const weeklyRemaining = Math.max(0, remaining / weeksLeftInMonth);
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

/**
 * Formats a native Wealthfolio Budget Breakdown message using exact native spending and budget target maps.
 */
export function formatNativeBudgetBreakdown(
  spentMap: Record<string, number>,
  budgetMap: Record<string, number>
): string {
  const customOrder = [
    'Housing', 'Transportation', 'Groceries', 'Food & Dining', 'Shopping',
    'Entertainment', 'Health & Wellness', 'Bills & Utilities', 'Fees & Charges', 'Education'
  ];

  const allCats = Array.from(new Set([...Object.keys(spentMap), ...Object.keys(budgetMap)]));
  allCats.sort((a, b) => {
    const idxA = customOrder.indexOf(a);
    const idxB = customOrder.indexOf(b);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.localeCompare(b);
  });

  let msg = `📊 *Wealthfolio Budget Breakdown*\n\n`;
  let totalSpent = 0;
  let totalBudget = 0;

  for (const cat of allCats) {
    const spent = spentMap[cat] || 0;
    const budget = budgetMap[cat] || 0;
    totalSpent += spent;
    totalBudget += budget;
    const pct = budget > 0 ? Math.round((spent / budget) * 100) : 0;
    const emoji = getCategoryEmoji(cat);
    const overAlert = spent > budget && budget > 0 ? ' 🚨 *OVER BUDGET!*' : '';
    msg += `${emoji} *${cat}*: ${money(spent)} / ${money(budget)} (${pct}%)${overAlert}\n`;
  }

  const totalPct = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;
  msg += `\n💰 *Total Spent*: ${money(totalSpent)} / ${money(totalBudget)} (${totalPct}%)`;

  return msg;
}

export interface WeeklyDigestCategory {
  name: string;
  spent: number;
  budget: number;
}

/**
 * Formats the daily "how much left to spend this week" digest — one line per
 * category, dividing the month's remaining budget across the weeks left in
 * the month. A category already over budget for the month gets the 🚨 alert
 * line instead of a (nonsensical, negative) per-week number.
 */
export function formatWeeklyRemainingDigest(
  categories: WeeklyDigestCategory[],
  weeksLeftInMonth: number,
): string {
  let msg = `🗓️ *Weekly Spending Update*\n\n`;

  if (categories.length === 0) {
    msg += `No budgeted categories to report. Set up budgets in Wealthfolio to see weekly allowances.`;
    return msg;
  }

  for (const c of categories) {
    const emoji = getCategoryEmoji(c.name);
    // Category names are Wealthfolio-user-controlled, not fully trusted display
    // text: a name like "Food_Drink" has an odd (unmatched) underscore count
    // once dropped into `*name*`, which is enough to make Telegram reject the
    // whole digest with a 400. Escape before interpolating.
    const name = escapeMarkdown(c.name);
    const remaining = c.budget - c.spent;
    if (remaining < 0) {
      msg += `• ${emoji} *${name}*: 🚨 *${money(remaining)} over budget!*\n`;
    } else {
      const perWeek = weeksLeftInMonth > 0 ? remaining / weeksLeftInMonth : remaining;
      msg += `• ${emoji} *${name}*: *${money(perWeek)} left this week*\n`;
    }
  }

  return msg;
}

/**
 * Persisted sync-health snapshot (companion writes this as an addon secret
 * keyed `sync_health`). A record with neither field set is not produced by
 * the companion, but callers should treat `null`/`undefined` — no record at
 * all, e.g. the very first run — as "say nothing" rather than guessing.
 */
export interface SyncHealth {
  lastSuccessAt?: string | null;
  firstFailedAt?: string;
  lastError?: string;
  alerted?: boolean;
}

/** "Nh ago"-style relative time. Uses minutes under an hour (so a 50-minute-old
 *  sync reads "50m ago", never a misleadingly-rounded "0h ago"), hours under two
 *  days, and whole days beyond that. Anything under two minutes reads "just now". */
function formatRelativeTime(fromIso: string, now: Date): string {
  const diffMs = Math.max(0, now.getTime() - new Date(fromIso).getTime());
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 2) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.round(diffMs / 3_600_000);
  if (diffHours < 48) return `${diffHours}h ago`;
  const diffDays = Math.round(diffMs / 86_400_000);
  return `${diffDays}d ago`;
}

/**
 * Formats the sync-health footer line appended to the daily digest: a short
 * "synced Nh ago" confirmation on success, or a "failing since ..." line
 * while a failure streak is active. Returns '' (append nothing) when there
 * is no health record yet — e.g. before the companion's first sync — rather
 * than printing something that could be misread as a real status.
 */
export function formatSyncHealthFooter(health: SyncHealth | null | undefined, now: Date = new Date()): string {
  if (!health) return '';
  if (health.firstFailedAt) {
    const since = new Date(health.firstFailedAt).toLocaleString();
    const lastError = escapeMarkdown(health.lastError ?? 'unknown error');
    return `⚠️ failing since ${since} — ${lastError}`;
  }
  if (health.lastSuccessAt) {
    return `✅ synced ${formatRelativeTime(health.lastSuccessAt, now)}`;
  }
  return '';
}

/**
 * Formats the weekly (Saturday) "one number" summary: total remaining across
 * every included category's budget for the month.
 */
export function formatMonthlyRemainingSummary(totalSpent: number, totalBudget: number): string {
  const remaining = totalBudget - totalSpent;
  const pct = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;
  let msg = `📊 *Weekly Budget Check-In*\n\n`;
  if (remaining < 0) {
    msg += `🚨 *You're ${money(remaining)} over budget this month* (spent ${money(totalSpent)} of ${money(totalBudget)}, ${pct}%).`;
  } else {
    msg += `💰 *${money(remaining)} remaining* this month (spent ${money(totalSpent)} of ${money(totalBudget)}, ${pct}%).`;
  }
  return msg;
}
