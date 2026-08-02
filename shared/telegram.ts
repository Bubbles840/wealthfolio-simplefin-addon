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
/** Telegram inline keyboard, as the Bot API expects it under `reply_markup`. */
export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  network?: { request: (opts: any) => Promise<{ status: number; body: string }> },
  replyMarkup?: InlineKeyboard,
): Promise<TelegramSendResult> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
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

/**
 * Renders a signed dollar figure: `-$1,494`, not `$1,494`.
 *
 * Keeping the sign is the safe default and deliberately not negotiable here.
 * This used to `Math.abs()` unconditionally, which was correct for `money()` —
 * whose call sites all supply a sign-carrying word — and silently wrong for
 * every bare figure. The daily digest's summary line shipped
 * `💰 $1,494 left this month` for a remainder of -$1,493.66: it told the reader
 * he had ~$1,500 to spend while he was ~$1,500 past the line. A formatter that
 * absorbs the sign can only fail in that direction, so the abs now lives in
 * `money()`, where the surrounding words justify it, and nowhere else.
 *
 * Rule for new call sites: reach for `moneyWhole`/`formatDollars` unless the
 * literal text next to the figure states the direction ("over", "spent"), in
 * which case pass `Math.abs(...)` explicitly so the choice is visible.
 */
function formatDollars(amount: number, decimals: number): string {
  const [whole, frac] = Math.abs(amount).toFixed(decimals).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = frac ? `$${grouped}.${frac}` : `$${grouped}`;
  // Tested against the ROUNDED magnitude, not the raw input: -$0.004 rendered in
  // whole dollars is `$0`, and `-$0` is noise dressed up as information.
  const negative = amount < 0 && /[1-9]/.test(grouped + (frac ?? ''));
  return negative ? `-${body}` : body;
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
 *
 * SIGNED, unlike `money`: this is the formatter for bare figures, where nothing
 * in the surrounding text tells the reader which side of zero they are on. A
 * caller that does supply that word passes `Math.abs(...)` itself.
 *
 * Exported only so that signedness is directly testable. Every in-repo caller
 * lands on a branch where the value happens to be non-negative, so nothing in
 * the rendered messages would fail if this quietly went back to absorbing the
 * sign — and that absorbing is precisely what shipped a $1,494 overspend as
 * $1,494 of headroom. The test on this function is the tripwire.
 */
export function moneyWhole(amount: number): string {
  return formatDollars(amount, 0);
}

/**
 * Addon-secret key holding large-transaction alerts a run could not deliver.
 *
 * Defined here, host-agnostically, because both syncers queue into and drain the
 * SAME secret on the one Wealthfolio instance — that shared queue is what makes
 * "sent exactly once" hold when either syncer can be the one that imported the
 * row. Two private copies of the string in two packages is one typo away from
 * two independent outboxes, and the symptom would be a duplicate alert rather
 * than an error.
 *
 * Why an outbox rather than the `alerted`-flag rollback the other two alerts use:
 * a stuck transfer and a drift episode are re-detected on every sync, so clearing
 * a flag is enough to rebuild the alert. A large transaction is announced only
 * because its row was CREATED this run, and `planReconciliation` creates a given
 * SimpleFin tx id exactly once — by the next sync nothing can re-derive it.
 */
export const LARGE_TX_OUTBOX_SECRET_KEY = 'pending_large_tx_alerts';

/**
 * One-line notice for a single large newly-imported spending transaction.
 *
 * Every piece of untrusted text — the bank's description and the Wealthfolio
 * account name — is escaped AND kept outside every Markdown entity. That is not
 * belt-and-braces: legacy Markdown does not honour a backslash escape inside an
 * entity, so `*AMAZON \*MKTPLACE*` still leaves a live opener and Telegram
 * rejects the WHOLE message with a 400. Card-network descriptors are full of
 * `*`, which makes this the likeliest input in the whole system to break a send.
 * The bold therefore sits only on the figure, which contains no specials.
 *
 * Cents are always kept: this is one exact transaction the reader will go and
 * look at, not a rounded month-level total, so `money()`'s cents-dropping rules
 * (which would render $1,240.00 as `$1,240`) are deliberately not used.
 */
export function formatLargeTransactionAlert(alert: {
  description: string;
  amountCents: number;
  currency: string;
  accountName: string;
}): string {
  const figure = formatDollars(Math.abs(alert.amountCents) / 100, 2);
  return `💸 *${figure}* ${escapeMarkdown(alert.currency)} — ${escapeMarkdown(alert.description)} · ${escapeMarkdown(alert.accountName)}`;
}

/**
 * Notice that a transfer pair has failed to auto-link three runs in a row.
 *
 * Lives here, beside the other two sync alerts, because BOTH hosts send it: the
 * companion from its cron cycle and the addon from `runSync`. A message builder
 * duplicated per host is precisely how the two syncers would come to say
 * different things about the same episode, so the formatting is shared and only
 * the sending and the ledger bookkeeping differ.
 *
 * `description` is `"<out leg comment> ↔ <in leg comment>"`, built from bank
 * transaction comments — card-network descriptors routinely carry `*` and `_` —
 * and the currency comes from SimpleFin, so neither is a trusted literal. Both
 * are escaped AND kept outside every Markdown entity: legacy Markdown does not
 * honour a backslash escape inside one, so `*AMAZON \*MKTPLACE*` would still
 * leave a live opener and Telegram would reject the WHOLE message with a 400.
 * The only entity here wraps the fixed heading, which contains no specials.
 *
 * The amount is deliberately `toFixed(2)` rather than `formatDollars` — no
 * thousands separator — because that is the string this alert has always sent
 * and the figure is a diagnostic to match against a row in Wealthfolio, not a
 * headline figure.
 */
export function formatStuckTransferAlert(alert: {
  description: string;
  amountCents: number;
  currency: string;
}): string {
  const amount = (alert.amountCents / 100).toFixed(2);
  return (
    "⚠️ *Transfer stuck — couldn't auto-link after 3 tries*\n"
    + `${escapeMarkdown(alert.description)}\n`
    + `Amount: $${amount} ${escapeMarkdown(alert.currency)}\n`
    + 'Try "Reconcile & link" in the addon, or check for a duplicate/mismatched leg.'
  );
}

/**
 * Notice that one account's balance has drifted from its bank's.
 *
 * The direction goes in WORDS ("below"/"above") with the figure kept positive,
 * following the same rule the digest uses for overspend: `off by -$1,300.00`
 * reads as a double negative, and the sign carries no information the sentence
 * doesn't already state. `driftAmount` is bank − Wealthfolio, so a positive
 * figure means Wealthfolio is the LOWER of the two.
 *
 * The bank's balance is quoted alongside because that is what makes the message
 * actionable rather than merely alarming — the reader can compare it to what
 * Wealthfolio shows without opening anything.
 *
 * The account name is user-entered, so it is escaped and sits outside every
 * entity; the bold is on "Balance drift" (a fixed literal) and the two figures.
 */
export function formatBalanceDriftAlert(alert: {
  accountName: string;
  driftAmount: number;
  currency: string;
  bankBalance: number;
}): string {
  // `Math.abs` on the DRIFT only, and explicitly so the choice is visible: the
  // direction word beside it is what justifies dropping the sign. The bank
  // balance keeps its sign — an overdrawn account or a card genuinely reports a
  // negative balance, and rendering that as a positive would misstate the one
  // figure the reader is meant to check against.
  const magnitude = formatDollars(Math.abs(alert.driftAmount), 2);
  const bank = formatDollars(alert.bankBalance, 2);
  const direction = alert.driftAmount >= 0 ? 'below' : 'above';
  return (
    `⚠️ *Balance drift* — ${escapeMarkdown(alert.accountName)}\n`
    + `Wealthfolio is *${magnitude}* ${direction} the bank's *${bank}* ${escapeMarkdown(alert.currency)}\n`
    + 'Run "Reconcile balances" in the addon to line them up.'
  );
}

/** One activity the reconcile sweep deleted. Structurally the display half of
 *  `SyncResult.prunedDuplicates` — the ids stay behind in the log. */
export interface PrunedDuplicateRow {
  accountName: string;
  description: string;
  /** YYYY-MM-DD, quoted verbatim so it matches what Wealthfolio shows. */
  date: string;
  amountCents: number;
  currency: string;
}

/** How many removed rows the message itemises before summarising the rest.
 *  Telegram rejects a message over 4096 characters outright, and a sweep over a
 *  long-neglected account could in principle find dozens. */
export const DUPLICATE_PRUNE_LIST_LIMIT = 10;

/**
 * Notice that the reconcile sweep DELETED activities as surplus copies of
 * transactions the account already held.
 *
 * This message exists because the deletion is automatic. Removing a financial
 * record without saying so is not acceptable even when the removal is correct, so
 * every swept row is itemised with the figure, date, description and account —
 * enough for the reader to go and confirm that what is gone is what they expected
 * to be gone.
 *
 * Sent by BOTH hosts (the companion from its cron cycle, the addon from
 * `runSync`), which is why it is built here rather than in either one.
 *
 * Bank descriptions and account names are escaped AND kept outside every Markdown
 * entity. Legacy Markdown does not honour a backslash escape inside one, so
 * `*AMAZON \*MKTPLACE*` still leaves a live opener and Telegram rejects the WHOLE
 * message with a 400 — the descriptions here come from card-network descriptors,
 * which are the likeliest text in the system to carry a stray `*`. Bold sits only
 * on the fixed heading and on the figures, which contain no specials.
 *
 * An empty list renders the empty string: there is no news, and a caller must not
 * send it (Telegram 400s on empty text). Both delivery paths guard on length.
 */
export function formatDuplicatePruneAlert(rows: PrunedDuplicateRow[]): string {
  if (rows.length === 0) return '';
  const shown = rows.slice(0, DUPLICATE_PRUNE_LIST_LIMIT);
  const lines = shown.map((r) => {
    // Cents always kept: these are exact rows the reader may go and look for, the
    // same reasoning as formatLargeTransactionAlert.
    const figure = formatDollars(Math.abs(r.amountCents) / 100, 2);
    const fields = [
      escapeMarkdown(r.currency),
      escapeMarkdown(r.date),
      // A SimpleFin description can legitimately be empty — render the row
      // without the field rather than with a blank one.
      escapeMarkdown(r.description),
      escapeMarkdown(r.accountName),
    ].filter((f) => f !== '');
    return `• *${figure}* ${fields.join(' · ')}`;
  });
  const overflow = rows.length - shown.length;
  if (overflow > 0) lines.push(`…and ${overflow} more`);
  return (
    `🧹 *Duplicate activities removed* — ${rows.length} row${rows.length === 1 ? '' : 's'}\n`
    + 'Each of these was stored twice, so the extra copy was deleted during reconcile:\n'
    + `${lines.join('\n')}\n`
    + 'Nothing to do — your balances should line up again.'
  );
}

/** One confirmed create for the import notice — SyncResult.importedTransactions
 *  minus the fields the notice does not render. */
export interface ImportNoticeTx {
  description: string;
  amountCents: number;
  currency: string;
  accountName: string;
  pending: boolean;
  inTransit: boolean;
}

/** One row of the needs-a-category sweep: any spending transaction from the
 *  last 30 days with no taxonomy assignment, minus dismissed ones. */
export interface UncategorizedTx {
  description: string;
  amountCents: number;
  /** ISO date (yyyy-mm-dd). */
  date: string;
  accountName: string;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-07-09` → `Jul 9`. Parsed as UTC so the label can't shift a day on a
 *  host west of UTC. */
function shortDate(isoDate: string): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

const IMPORT_NOTICE_TX_CAP = 10;
/** Exported so the companion builds dismiss buttons for exactly the rows the
 *  notice SHOWS — a button for a `+N more` row would dismiss something the
 *  user never saw. */
export const IMPORT_NOTICE_UNCATEGORIZED_CAP = 5;

/**
 * The per-sync import notice: what this run imported, and what — new or weeks
 * old — still has no category in Wealthfolio's spending tracker.
 *
 * The category block is a SWEEP over the last 30 days, deliberately not a flag
 * on this run's rows: the companion's DB snapshot can lag the rows it just
 * imported, so a per-row flag at send time would misreport, while a sweep just
 * catches the row in the next notice. It also covers addon-imported
 * transactions, which produce no notice of their own.
 */
export function formatImportNotice(
  txs: ImportNoticeTx[],
  uncategorized: UncategorizedTx[],
): string {
  const head = `🔔 *${txs.length} new transaction${txs.length === 1 ? '' : 's'}*`;

  // Escaped text stays OUTSIDE every Markdown entity (legacy Markdown ignores
  // backslash escapes inside one); the bold sits on counts, which have none.
  const txLine = (t: ImportNoticeTx) => {
    const tail = t.inTransit ? ' · in transit' : t.pending ? ' · pending' : '';
    return `• ${money(t.amountCents / 100)}  ${escapeMarkdown(t.description)} — ${escapeMarkdown(t.accountName)}${tail}`;
  };
  const shown = txs.slice(0, IMPORT_NOTICE_TX_CAP).map(txLine);
  if (txs.length > IMPORT_NOTICE_TX_CAP) shown.push(`  +${txs.length - IMPORT_NOTICE_TX_CAP} more`);

  const blocks = [head, shown.join('\n')];

  if (uncategorized.length > 0) {
    const rows = uncategorized
      .slice(0, IMPORT_NOTICE_UNCATEGORIZED_CAP)
      .map((u) => `• ${money(u.amountCents / 100)}  ${escapeMarkdown(u.description)} · ${shortDate(u.date)} — ${escapeMarkdown(u.accountName)}`);
    if (uncategorized.length > IMPORT_NOTICE_UNCATEGORIZED_CAP) {
      rows.push(`  +${uncategorized.length - IMPORT_NOTICE_UNCATEGORIZED_CAP} more`);
    }
    blocks.push(`🏷️ *Needs a category* (${uncategorized.length}):\n${rows.join('\n')}`);
  }

  return blocks.filter(Boolean).join('\n\n');
}

/**
 * One dismiss button per needs-a-category row shown in the import notice.
 *
 * Keyed by ACTIVITY id, not `(account, txId)`: Telegram caps `callback_data`
 * at 64 BYTES, and two uuids plus a prefix run ~85. The activity id is unique,
 * fits, and is what the dismissal ledger stores. Button labels are plain text
 * (no Markdown parsing there), so descriptions go in unescaped, truncated.
 */
export function buildDismissKeyboard(
  rows: Array<{ activityId: string; description: string; amountCents: number }>,
): InlineKeyboard {
  return {
    inline_keyboard: rows.map((r) => [{
      text: `Dismiss: ${r.description.slice(0, 24)} ${money(r.amountCents / 100)}`,
      callback_data: `d:${r.activityId}`,
    }]),
  };
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
 * Five branches, because these are five genuinely different situations:
 *  - no budget → report the spend and say so; you cannot be over a budget that
 *    was never created
 *  - over budget for the MONTH → 🚨. This dominates the weekly view: the
 *    week's allowance is moot once the month itself is blown
 *  - over the WEEK's allowance but still inside the monthly budget → ⚠️, with
 *    the month figure inline. This is the state worth acting on, so it must not
 *    be collapsed into the one above. The month figure is abbreviated ("left
 *    mo") and the week is left implicit — the header already states the unit
 *    once — because the spelled-out form ran to ~66 characters and wrapped on a
 *    phone, next to neighbours of ~25
 *  - budget exactly used up (nothing left for the week AND nothing left for the
 *    month, e.g. a fixed monthly bill paid early in the month) → the figure is
 *    correct but a bare `*$0*` beside real figures reads as a failure, so this
 *    state says so in words. Kept distinct from both over-budget branches: this
 *    is not overspending
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
  // Unbudgeted categories render separately, after every budgeted one, and only
  // when money actually moved: a category with a leftover zero-amount budget row
  // and no spend used to print `no budget · $0 spent` — true, and pure noise.
  const offBudgetLines: string[] = [];
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
      if (c.monthSpent > 0) {
        offBudgetLines.push(`${emoji} ${name}  ${moneyWhole(c.monthSpent)} spent`);
      }
      continue;
    }

    anyBudget = true;
    budgetedRemaining += remainingMonth;

    if (remainingMonth < 0) {
      // `Math.abs` explicitly: the word "over" states the direction, and
      // `-$50 over` would read as a double negative.
      lines.push(`${emoji} ${name}  🚨 *${moneyWhole(Math.abs(remainingMonth))} over* for the month`);
    } else if (leftThisWeek < 0) {
      lines.push(`${emoji} ${name}  ⚠️ *${money(leftThisWeek)} over* · ${moneyWhole(remainingMonth)} left mo`);
    } else if (leftThisWeek === 0 && remainingMonth === 0) {
      lines.push(`${emoji} ${name}  *${money(0)}* · budget used up`);
    } else {
      lines.push(`${emoji} ${name}  *${money(leftThisWeek)}*`);
    }
  }

  // Summed over budgeted categories only: an unbudgeted category's spend does
  // not come out of anyone's budget, so folding it in would understate what is
  // actually left.
  //
  // The over-budget branch is the whole point of this line existing in two
  // forms. Without it the summary printed `💰 $1,494 left this month` for a
  // remainder of -$1,493.66 — a phrase with no room for a negative in it, fed an
  // unsigned figure. Worded and marked like the weekly report's overspend so the
  // two read as one family; the days-to-go tail stays either way, since "how
  // long until this resets" is exactly as useful when you are over.
  //
  // Keyed off the RENDERED magnitude rather than `budgetedRemaining < 0`:
  // summing 2-decimal budgets and spends leaves remainders like -2.8e-17, and
  // even a real 30-cent overspend renders as `$0` in a whole-dollar summary.
  // `🚨 $0 over budget` is a false alarm where `$0 left` already promises
  // nothing.
  const overBudget = budgetedRemaining < 0 && moneyWhole(Math.abs(budgetedRemaining)) !== '$0';
  const summary = !anyBudget
    ? `📅 ${days} ${dayWord} left in the month`
    : overBudget
      ? `🚨 ${moneyWhole(Math.abs(budgetedRemaining))} over budget this month · ${days} ${dayWord} to go`
      : `💰 ${moneyWhole(budgetedRemaining)} left this month · ${days} ${dayWord} to go`;

  // An empty budgeted block can happen while off-budget lines exist (every
  // budget deleted, spending continues); joining blocks that exist avoids a
  // stray blank gap in that case.
  const blocks = [lines.join('\n')];
  if (offBudgetLines.length > 0) blocks.push(`Off budget:\n${offBudgetLines.join('\n')}`);
  // No trailing newline: callers append the sync-health footer as its own
  // block, and a trailing blank line would leave that footer looking like part
  // of this summary line.
  return `☀️ *Daily Spending Check*\n_left to spend this week_\n\n${blocks.filter(Boolean).join('\n\n')}\n\n${summary}`;
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
export function formatMonthlyRemainingSummary(
  totalSpent: number,
  totalBudget: number,
  topSpends: WeeklyTopSpend[] = [],
): string {
  const remaining = totalBudget - totalSpent;
  const pct = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;
  const header = `📊 *Weekly Budget Check-In*\n\n`;
  const hint = `_Add budgets in Wealthfolio, or check which categories are selected for the weekly report._`;
  // Appended to BOTH branches below: "what were my biggest spends" is a fact
  // that does not depend on a budget existing, and the zero-budget branch —
  // reachable by deselecting every weekly category, or before any budget is
  // created — is exactly where the reader has least else to go on.
  const biggest = formatBiggestThisWeek(topSpends);
  // Whole dollars throughout: every figure in this report is a month-level
  // total, and none of them is a number the reader spends against directly.
  if (totalBudget <= 0) {
    const headline = totalSpent > 0
      ? `🏷️ *${moneyWhole(totalSpent)} spent* · no budget set`
      : `🏷️ Nothing spent, no budgets set this month.`;
    return `${header}${headline}\n${hint}${biggest}`;
  }
  const headline = remaining < 0
    // `Math.abs` explicitly: "over budget" states the direction.
    ? `🚨 *${moneyWhole(Math.abs(remaining))} over budget* this month`
    : `💰 *${moneyWhole(remaining)} left* this month`;
  return `${header}${headline}\n_spent ${moneyWhole(totalSpent)} of ${moneyWhole(totalBudget)} · ${pct}%_${biggest}`;
}

/** One individual spending transaction for the weekly report's "biggest this
 *  week" section. Plain data: the caller decides the window and does the date
 *  arithmetic, this module only renders. */
export interface WeeklyTopSpend {
  /** Dollars. Rendered unsigned — the heading already says these are spends — so
   *  a caller may pass either sign. */
  amount: number;
  /** Display-ready bank description, already stripped of the stored note's tx id
   *  and markers. UNTRUSTED: card-network descriptors routinely contain `*` and
   *  `_`. May be empty when the bank sent no description. */
  description: string;
  /** Rolled-up category label, matching the names used everywhere else in the
   *  reports. User-entered, so equally untrusted. */
  category: string;
}

/**
 * The weekly report's supporting section: the few biggest individual spends of
 * the current week, which is what gives the one headline number its "why".
 *
 * Returns '' — appended to nothing — when the week held no spending. A heading
 * with no rows under it announces a fact and then fails to deliver it, and an
 * empty week is a real state (a holiday, a fresh install, a card not yet linked).
 *
 * Layout notes, all in service of one glance on a phone:
 *  - `amount · merchant · category`, three fields, no bullet and no per-row
 *    emoji: at five rows the emoji column reads as decoration rather than
 *    information, and the section heading already groups them.
 *  - whole dollars, like every other figure in this report. These are
 *    retrospective context, not an allowance anyone spends against, so `money`'s
 *    cents (kept precisely because an allowance must never be rounded UP) would
 *    add a ragged decimal column for nothing.
 *  - no bold on the rows. Bold is reserved for the single figure the report is
 *    about; five more bold figures would compete with it.
 *  - a row whose description is empty renders as `amount · category` rather than
 *    leaving a hollow ` ·  · ` where the merchant should be.
 *
 * SAFETY, and the reason the bold placement above is not merely taste: both the
 * description and the category are escaped AND kept outside every Markdown
 * entity. Legacy Markdown does not honour a backslash escape inside an entity,
 * so `*SQ \*BLUE BOTTLE*` still leaves an unbalanced entity and Telegram rejects
 * the ENTIRE message with a 400 — the whole report silently fails to arrive.
 * Card descriptors are the likeliest text in this system to contain a `*`, and
 * this section prints five of them.
 */
function formatBiggestThisWeek(spends: WeeklyTopSpend[]): string {
  if (spends.length === 0) return '';
  const lines = spends.map((s) => {
    // `Math.abs` explicitly, per the rule in `formatDollars`' comment: the
    // heading is what states the direction.
    const figure = moneyWhole(Math.abs(s.amount));
    const fields = [figure, escapeMarkdown(s.description), escapeMarkdown(s.category)].filter((f) => f !== '');
    return fields.join(' · ');
  });
  return `\n\n*Biggest this week*\n${lines.join('\n')}`;
}

export interface MonthlyWrapUpCategory {
  name: string;
  /** Total spend for the whole month being reported. */
  spent: number;
  /** Monthly budget for that month; `<= 0` means no budget row existed. */
  budget: number;
}

/**
 * Formats the monthly wrap-up (sent on the 1st, about the month that just
 * ended): one line per category stating what was budgeted and what was
 * actually spent, then one verdict line for the month as a whole.
 *
 * This is the retrospective of the three reports, so unlike the daily digest
 * (one actionable figure per category) and the weekly check-in (one figure,
 * full stop) it carries budget AND spend per row. Whole dollars throughout:
 * nothing here is a number anyone spends against — the month is closed.
 *
 * `monthName` is a PARAMETER, not derived from the clock. This module also runs
 * inside the addon's browser bundle and must stay host-agnostic, and more
 * importantly the caller runs on the 1st reporting the PREVIOUS month, so a
 * `new Date()` in here would name the wrong month every single time.
 *
 * Three per-category states, because they are three genuinely different facts:
 *  - no budget → report the spend and say so. A category cannot be "over"
 *    something that was never set, and calling it over would invent a target the
 *    user never agreed to
 *  - over budget → 🚨 plus the overage, which is the number worth reading
 *  - otherwise → ✅ and the plain spend-of-budget
 *
 * The verdict line has three, for the same reason plus one:
 *  - nothing budgeted anywhere → no verdict is possible, so it states the spend
 *    (or that there wasn't any) and points at both causes, exactly as
 *    `formatMonthlyRemainingSummary` does for its zero-budget month
 *  - finished level → "right on budget". `$0 under budget` is a verdict-shaped
 *    non-verdict, and this branch also absorbs float noise and sub-dollar
 *    overspends (see the rounding note below)
 *  - otherwise → *under* or *over*, in WORDS
 *
 * That last point is the one non-negotiable. A shared formatter that absorbed
 * the sign once shipped `💰 $1,494 left this month` to a reader who was $1,494
 * OVER: a phrase with no room for a negative, handed an unsigned figure. Here
 * the direction is chosen by branch and stated in words, so the figure beside
 * it is deliberately `Math.abs` — visible at the call site, per the rule in
 * `formatDollars`' comment — and there is no path on which an overspend can
 * render as headroom.
 */
export function formatMonthlyWrapUp(categories: MonthlyWrapUpCategory[], monthName: string): string {
  const header = `📅 *${escapeMarkdown(monthName)} wrap-up*`;

  if (categories.length === 0) {
    // Two distinct causes land here — that month had no budgets and no spending,
    // or every category was deselected for the monthly report — so the text must
    // not assert either one.
    return `${header}\n\nNothing to report. Set up budgets in Wealthfolio, or check that categories are selected for the monthly report in the SimpleFin Sync addon.`;
  }

  const lines: string[] = [];
  let budgetedSpent = 0;
  let budgetedBudget = 0;
  let allSpent = 0;

  for (const c of categories) {
    const emoji = getCategoryEmoji(c.name);
    // Category names are Wealthfolio-user-controlled. Escaped AND kept outside
    // every Markdown entity: legacy Markdown does not honour a backslash escape
    // inside one, so `*Food\_Drink*` would still leave a live italic opener and
    // Telegram would reject the WHOLE message with a 400. The bold sits on the
    // figures, which contain no specials.
    const name = escapeMarkdown(c.name);
    allSpent += c.spent;

    if (c.budget <= 0) {
      lines.push(`🏷️ ${emoji} ${name}  *${moneyWhole(c.spent)}* · no budget`);
      continue;
    }

    budgetedSpent += c.spent;
    budgetedBudget += c.budget;
    const over = c.spent - c.budget;
    // Keyed off the RENDERED overage, not `over > 0`: a 40-cent overspend shown
    // in whole dollars is `$0 over`, which is a false alarm beside real figures.
    if (over > 0 && moneyWhole(over) !== '$0') {
      // `Math.abs` is unnecessary here (`over > 0`) but the figure is deliberately
      // rendered from the positive difference and labelled "over" — the word is
      // what carries the direction.
      lines.push(`🚨 ${emoji} ${name}  ${moneyWhole(c.spent)} of ${moneyWhole(c.budget)} · *${moneyWhole(over)} over*`);
    } else {
      lines.push(`✅ ${emoji} ${name}  *${moneyWhole(c.spent)}* of ${moneyWhole(c.budget)}`);
    }
  }

  let verdict: string;
  if (budgetedBudget <= 0) {
    // No budget anywhere: there is no line to be under or over. Uses the
    // all-category spend, since the budgeted subset is empty by definition.
    verdict = allSpent > 0
      ? `🏷️ *${moneyWhole(allSpent)} spent* · no budgets set\n_Add budgets in Wealthfolio, or check which categories are selected for the monthly report._`
      : `🏷️ Nothing spent, no budgets set in ${escapeMarkdown(monthName)}.\n_Add budgets in Wealthfolio, or check which categories are selected for the monthly report._`;
  } else {
    // Budgeted categories only. An unbudgeted category's spend comes out of
    // nobody's budget, so folding it in could flip a month that finished under
    // into one that reads as over — the same choice, for the same reason, as the
    // daily digest's month-context line.
    const remaining = budgetedBudget - budgetedSpent;
    const magnitude = moneyWhole(Math.abs(remaining));
    const arithmetic = `spent ${moneyWhole(budgetedSpent)} of ${moneyWhole(budgetedBudget)}`;
    verdict = magnitude === '$0'
      ? `💰 Finished *right on budget* · ${arithmetic}`
      : remaining < 0
        ? `🚨 Finished *${magnitude} over budget* · ${arithmetic}`
        : `💰 Finished *${magnitude} under budget* · ${arithmetic}`;
  }

  return `${header}\n\n${lines.join('\n')}\n\n${verdict}`;
}
