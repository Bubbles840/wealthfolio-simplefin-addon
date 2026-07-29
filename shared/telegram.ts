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
