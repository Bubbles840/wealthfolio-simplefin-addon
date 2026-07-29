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

function formatDollars(amount: number, decimals: number): string {
  const [whole, frac] = Math.abs(amount).toFixed(decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `$${grouped}.${frac}` : `$${grouped}`;
}

/**
 * A figure the reader might spend against: cents kept, because rounding a
 * spendable allowance up by as much as 50 cents would over-promise, which is
 * the one thing these messages must never do. Cents are still dropped where
 * they carry nothing — a whole amount, or anything from $1,000 up, where two
 * decimals are noise no one acts on.
 *
 * Always the absolute value; the surrounding words ("over", "left") carry the
 * sign, and a bare `-$23.16` next to the word "over" reads as a double
 * negative.
 */
function money(amount: number): string {
  const abs = Math.abs(amount);
  return formatDollars(abs, abs >= 1000 || Number.isInteger(abs) ? 0 : 2);
}

/**
 * A month-level context figure — a total, a month remainder, a month-to-date
 * spend. Always whole dollars: nobody acts on the cents of a monthly total, and
 * two decimals on every context number was a real part of the old format's
 * bulk. The actionable weekly figures keep their cents via `money`.
 */
function moneyWhole(amount: number): string {
  return formatDollars(amount, 0);
}

export interface DailyDigestCategory {
  name: string;
  /** Spend for the whole calendar month so far, for this category. */
  monthSpent: number;
  /** Spend since the current week's start (see `weeklyEnvelope`), a subset of
   *  `monthSpent`. */
  weekSpent: number;
  /** Monthly budget; `<= 0` means no budget row exists for this category. */
  budget: number;
}

export interface WeeklyEnvelopeInput {
  budget: number;
  monthSpent: number;
  weekSpent: number;
  /** Days from the current week's start through the last day of the month,
   *  inclusive of both ends. For a week starting on the 8th of a 31-day month
   *  that is `31 - 8 + 1 = 24`. */
  daysFromWeekStartToMonthEnd: number;
}

export interface WeeklyEnvelopeResult {
  /** The whole week's allowance, fixed for the duration of the week. */
  weekEnvelope: number;
  /** What is still spendable inside that allowance right now. Negative means
   *  the week's allowance is already blown. */
  leftThisWeek: number;
  /** Budget minus month-to-date spend. Negative means over budget outright. */
  remainingMonth: number;
}

/**
 * Turns a monthly budget into a real weekly envelope — money that counts down
 * as it is spent — rather than a pace.
 *
 * Two properties make this behave the way a spending envelope should:
 *
 * 1. It is derived from the budget as it stood at the START of the week
 *    (`budget - spentBeforeWeek`), not from what is left today. Deriving it
 *    from today's remaining would re-issue a fresh, larger allowance every
 *    morning: spend $100 on Monday and Tuesday's "left this week" would barely
 *    move, which is exactly the dishonesty the previous pace-based figure was
 *    hedged to avoid. Fixing the envelope at week start means `leftThisWeek`
 *    drops by exactly what was spent, and a blown week automatically tightens
 *    the weeks that follow, because the next week's `budgetAtWeekStart` is
 *    smaller.
 *
 * 2. It is day-proportional (`× 7 / daysFromWeekStartToMonthEnd`) rather than
 *    divided by a whole number of weeks. `ceil(days / 7)` overshoots a 31-day
 *    month by ~11% (four weeks of `budget / 4` spends the budget by day 28 with
 *    three days still to fund) and steps discontinuously as the week count
 *    ticks down.
 *
 * The `min(...)` cap is load-bearing in the final, short week of a month: with
 * 3 days to go, `× 7 / 3` would promise more than 2x the money that actually
 * exists. The cap is continuous — at `daysFromWeekStartToMonthEnd === 7` both
 * branches are equal — so nothing jumps when it engages.
 */
export function weeklyEnvelope(input: WeeklyEnvelopeInput): WeeklyEnvelopeResult {
  const { budget, monthSpent, weekSpent } = input;
  const horizon = Math.max(1, input.daysFromWeekStartToMonthEnd);
  const spentBeforeWeek = monthSpent - weekSpent;
  const budgetAtWeekStart = budget - spentBeforeWeek;
  const weekEnvelope = Math.min(budgetAtWeekStart, (budgetAtWeekStart * 7) / horizon);
  return {
    weekEnvelope,
    leftThisWeek: weekEnvelope - weekSpent,
    remainingMonth: budget - monthSpent,
  };
}

export interface DailyDigestWindow {
  /** See `WeeklyEnvelopeInput.daysFromWeekStartToMonthEnd`. */
  daysFromWeekStartToMonthEnd: number;
  /** Days left in the month COUNTING TODAY — 1 on the last day, since today is
   *  still a day money can be spent. */
  daysLeftInMonthInclusive: number;
}

/**
 * Formats the daily spending check: one short line per category carrying the
 * single actionable number — what is left to spend this week — plus one
 * month-context line at the end.
 *
 * The layout is built for a phone glance. The unit ("left to spend this week")
 * is stated once in the header instead of being repeated on every row, which is
 * where most of the previous format's bulk went; there is no `• ` bullet,
 * because the category emoji already reads as one; and month-level figures are
 * summarised once at the bottom rather than per line.
 *
 * Four branches, because these are four genuinely different situations:
 *  - no budget → report the spend and say so; you cannot be over a budget that
 *    was never created
 *  - over budget for the MONTH → 🚨. This dominates the weekly view: the
 *    week's allowance is moot once the month itself is blown
 *  - over the WEEK's allowance but still inside the monthly budget → ⚠️, with
 *    the month figure inline. This is the state worth acting on, so it must not
 *    be collapsed into the one above
 *  - otherwise → the plain figure
 */
export function formatDailySpendingDigest(
  categories: DailyDigestCategory[],
  // Not named `window`: this module also runs inside the addon's browser
  // bundle, where that shadows the DOM global.
  period: DailyDigestWindow,
): string {
  const { daysFromWeekStartToMonthEnd, daysLeftInMonthInclusive } = period;
  const days = Math.max(1, daysLeftInMonthInclusive);
  const dayWord = days === 1 ? 'day' : 'days';

  if (categories.length === 0) {
    // Two distinct causes land here — no budgets exist yet, or every category
    // was deselected in the addon's Report Categories list — so the text must
    // not assert either one. No "left to spend this week" subtitle either:
    // there is nothing to promise.
    return `☀️ *Daily Spending Check*\n\nNothing to report. Set up budgets in Wealthfolio, or check that categories are selected for the daily report in the SimpleFin Sync addon.`;
  }

  const lines: string[] = [];
  let budgetedRemaining = 0;
  let anyBudget = false;

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
    const { leftThisWeek, remainingMonth } = weeklyEnvelope({
      budget: c.budget,
      monthSpent: c.monthSpent,
      weekSpent: c.weekSpent,
      daysFromWeekStartToMonthEnd,
    });

    if (c.budget <= 0) {
      lines.push(`${emoji} ${name}  *no budget* · ${moneyWhole(c.monthSpent)} spent`);
      continue;
    }

    anyBudget = true;
    budgetedRemaining += remainingMonth;

    if (remainingMonth < 0) {
      lines.push(`${emoji} ${name}  🚨 *${moneyWhole(remainingMonth)} over* for the month`);
    } else if (leftThisWeek < 0) {
      lines.push(`${emoji} ${name}  ⚠️ *${money(leftThisWeek)} over* this week · ${moneyWhole(remainingMonth)} left this month`);
    } else {
      lines.push(`${emoji} ${name}  *${money(leftThisWeek)}*`);
    }
  }

  // Summed over budgeted categories only: an unbudgeted category's spend does
  // not come out of anyone's budget, so folding it in would understate what is
  // actually left.
  const summary = anyBudget
    ? `💰 ${moneyWhole(budgetedRemaining)} left this month · ${days} ${dayWord} to go`
    : `📅 ${days} ${dayWord} left in the month`;

  // No trailing newline: callers append the sync-health footer as its own
  // block, and a trailing blank line would leave that footer looking like part
  // of this summary line.
  return `☀️ *Daily Spending Check*\n_left to spend this week_\n\n${lines.join('\n')}\n\n${summary}`;
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
 * is a fact worth stating, just not one about what is left.
 *
 * Laid out to match the daily digest: an emoji-led bold figure on its own line,
 * with the supporting arithmetic on one quiet italic line beneath instead of a
 * parenthetical trailing the headline.
 */
export function formatMonthlyRemainingSummary(totalSpent: number, totalBudget: number): string {
  const remaining = totalBudget - totalSpent;
  const pct = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;
  const header = `📊 *Weekly Budget Check-In*\n\n`;
  const hint = `_Add budgets in Wealthfolio, or check which categories are selected for the weekly report._`;
  // Whole dollars throughout: every figure in this report is a month-level
  // total, and none of them is a number the reader spends against directly.
  if (totalBudget <= 0) {
    const headline = totalSpent > 0
      ? `🏷️ *${moneyWhole(totalSpent)} spent* · no budget set`
      : `🏷️ Nothing spent, no budgets set this month.`;
    return `${header}${headline}\n${hint}`;
  }
  const headline = remaining < 0
    ? `🚨 *${moneyWhole(remaining)} over budget* this month`
    : `💰 *${moneyWhole(remaining)} left* this month`;
  return `${header}${headline}\n_spent ${moneyWhole(totalSpent)} of ${moneyWhole(totalBudget)} · ${pct}%_`;
}
