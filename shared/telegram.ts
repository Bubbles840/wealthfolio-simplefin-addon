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
): Promise<TelegramSendResult> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
    });
    const json = (await res.json()) as { ok?: boolean; description?: string };
    if (!res.ok || !json.ok) {
      return { ok: false, description: json.description ?? `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, description: (err as Error).message };
  }
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
    const remaining = c.budget - c.spent;
    if (c.mode === 'daily') {
      const dailyLimit = data.daysLeftInMonth > 0 ? Math.max(0, remaining / data.daysLeftInMonth) : 0;
      msg += `• *${c.name}*: *${money(dailyLimit)}/day* (${money(remaining)} left in month)\n`;
    } else if (c.mode === 'weekly') {
      const weeklyRemaining = Math.max(0, remaining / 4);
      msg += `• *${c.name}*: *${money(weeklyRemaining)}/week* (${money(remaining)} left in month)\n`;
    } else {
      msg += `• *${c.name}*: *${money(remaining)} remaining* for the month\n`;
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
  msg += `💸 *Spent This Week*: ${money(data.weekSpent)}\n`;
  msg += `📈 *Month-to-Date Spend*: ${money(data.monthSpent)} / ${money(data.monthBudget)} (${percentUsed}% used)\n`;
  msg += `💰 *Remaining for Month*: ${monthRemaining >= 0 ? money(monthRemaining) : `-${money(monthRemaining)} (Over budget!)`}\n\n`;

  if (data.categories.length > 0) {
    msg += `*Top Categories Progress:*\n`;
    for (const c of data.categories) {
      const pct = c.budget > 0 ? Math.round((c.spent / c.budget) * 100) : 0;
      msg += `• *${c.name}*: ${money(c.spent)} / ${money(c.budget)} (${pct}%)\n`;
    }
  }

  return msg;
}
