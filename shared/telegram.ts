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
 * Converts the month's remaining budget into a *pace* — a "roughly this much
 * per week keeps you inside the budget" figure — using the days actually left
 * rather than a whole-week count.
 *
 * `daysLeftInMonth` counts days AFTER today (0 on the last day of the month),
 * so the inclusive horizon is `daysLeftInMonth + 1`. Dividing by days rather
 * than `ceil(days / 7)` matters: the week-count version steps from 2 to 1 on
 * a single day boundary, doubling the displayed number overnight (in a 31-day
 * month, the 23rd showed `remaining / 2` and the 24th `remaining / 1`). The
 * day-proportional form moves by a few percent a day instead.
 *
 * Capped at `remaining`: with a week or less left in the month, `remaining
 * * 7 / horizon` exceeds the money that actually exists, and printing a pace
 * larger than the budget it comes from reads as permission to overspend. The
 * cap is continuous — it engages exactly where `horizon === 7` — so the
 * figure stays smooth through the end of the month, flattening out at the
 * true remaining rather than spiking.
 */
export function weeklyPace(remaining: number, daysLeftInMonth: number): number {
  const horizon = Math.max(1, daysLeftInMonth + 1);
  return Math.min(remaining, (remaining * 7) / horizon);
}

/**
 * Formats the daily spending check — one line per category.
 *
 * Every line shows the *true* month-to-date remaining as its headline number,
 * with the weekly pace (see `weeklyPace`) as a clearly-approximate secondary
 * figure. The earlier version printed only `remaining / weeksLeft` labelled
 * "left this week", which was a lie in a message people read daily: spending
 * $100 today moved that number by ~$20, so the label promised something the
 * arithmetic never delivered. Remaining-first fixes that — the headline drops
 * by exactly what was spent — and the `≈…/wk pace` suffix is hedged in both
 * wording and symbol so it can't be read as a spendable allowance.
 *
 * Three branches, because they are three different situations:
 *  - over budget for the month → 🚨, no pace (there is nothing left to pace)
 *  - spending with no budget set → report the spend and say no budget exists;
 *    "over budget" is meaningless for a budget that was never created
 *  - under budget → remaining + pace
 */
export function formatWeeklyRemainingDigest(
  categories: WeeklyDigestCategory[],
  daysLeftInMonth: number,
): string {
  let msg = `☀️ *Daily Spending Check*\n\n`;

  if (categories.length === 0) {
    // Two distinct causes land here — no budgets exist yet, or every category
    // was deselected in the addon's Report Categories list — so the text must
    // not assert either one.
    msg += `Nothing to report. Set up budgets in Wealthfolio, or check that categories are selected for the daily report in the SimpleFin Sync addon.`;
    return msg;
  }

  for (const c of categories) {
    const emoji = getCategoryEmoji(c.name);
    // Category names are Wealthfolio-user-controlled, not fully trusted display
    // text: a name like "Food_Drink" carries an odd (unmatched) underscore
    // count, which is enough to make Telegram reject the whole digest with a
    // 400. Escape before interpolating — and keep the escaped name OUTSIDE any
    // Markdown entity, because legacy Markdown does not honour a backslash
    // escape inside one (the entity has to be closed and reopened instead), so
    // `*Food\_Drink*` would still leave a live italic opener. The bold sits on
    // the figures, which contain no specials.
    const name = escapeMarkdown(c.name);
    const remaining = c.budget - c.spent;
    if (c.budget <= 0) {
      msg += `• ${emoji} ${name}: *${money(c.spent)} spent* · no budget set\n`;
    } else if (remaining < 0) {
      msg += `• ${emoji} ${name}: 🚨 *${money(remaining)} over budget* this month\n`;
    } else {
      msg += `• ${emoji} ${name}: *${money(remaining)} left this month* · ≈${money(weeklyPace(remaining, daysLeftInMonth))}/wk pace\n`;
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
 *
 * The zero-budget branch is load-bearing rather than defensive. This report is
 * a single number, so a wrong number IS the whole message — and `totalBudget
 * === 0` is genuinely reachable (deselect every weekly category in the addon,
 * or run before any budget has been created). Without the branch it emitted
 * `💰 *$0.00 remaining* this month (spent $0.00 of $0.00, 0%)`, which reads as
 * a real, calmly-reported result. It also distinguishes "no budget, but money
 * went out" from "nothing happened at all": with spending and no budget there
 * is a fact worth stating, just not one about "remaining".
 */
export function formatMonthlyRemainingSummary(totalSpent: number, totalBudget: number): string {
  const remaining = totalBudget - totalSpent;
  const pct = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;
  let msg = `📊 *Weekly Budget Check-In*\n\n`;
  if (totalBudget <= 0) {
    if (totalSpent > 0) {
      msg += `🏷️ *${money(totalSpent)} spent* this month, no budget set — there's nothing to measure it against yet. Add budgets in Wealthfolio, or check which categories are selected for the weekly report.`;
    } else {
      msg += `🏷️ No budgets set and no spending recorded this month for the selected categories. Add budgets in Wealthfolio, or check which categories are selected for the weekly report.`;
    }
    return msg;
  }
  if (remaining < 0) {
    msg += `🚨 *You're ${money(remaining)} over budget this month* (spent ${money(totalSpent)} of ${money(totalBudget)}, ${pct}%).`;
  } else {
    msg += `💰 *${money(remaining)} remaining* this month (spent ${money(totalSpent)} of ${money(totalBudget)}, ${pct}%).`;
  }
  return msg;
}
