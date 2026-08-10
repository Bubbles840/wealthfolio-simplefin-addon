/**
 * shared/telegram-commands.ts
 *
 * Parsing and reply formatting for the bot's slash commands. Pure functions —
 * data in, string out — beside the report formatters in ./telegram.ts and for
 * the same reason: the companion owns transport and storage, and everything
 * testable without a network lives here.
 */

import { weeklyEnvelope, moneyWhole, escapeMarkdown } from './telegram.js';
import type { GlyphStyle } from './telegram.js';

export interface ParsedCommand {
  /** Lowercased, without the slash: 'report', 'left', … */
  command: string;
  /** Everything after the command, trimmed. Case preserved — category names matter. */
  args: string;
}

/** `/cmd`, `/cmd args`, `/cmd@BotName args` — Telegram appends the bot name in groups. */
export function parseCommand(text: string | null | undefined, botName?: string): ParsedCommand | null {
  const t = (text ?? '').trim();
  if (!t.startsWith('/') || t.length < 2) return null;
  const [head, ...rest] = t.split(/\s+/);
  let name = head.slice(1);
  const at = name.indexOf('@');
  if (at !== -1) {
    // Addressed to a specific bot. If it names a DIFFERENT bot, this message is
    // not for us — treat as non-command rather than answering someone else's mail.
    const addressed = name.slice(at + 1);
    if (botName && addressed.toLowerCase() !== botName.toLowerCase()) return null;
    name = name.slice(0, at);
  }
  if (!name) return null;
  return { command: name.toLowerCase(), args: rest.join(' ').trim() };
}

/** Registered via setMyCommands so Telegram's ☰ menu lists them. Order is display order. */
export const TELEGRAM_COMMAND_MENU = [
  { command: 'report', description: "Today's spending digest, fresh from the database" },
  { command: 'left', description: "What's left per category — /left groceries narrows it" },
  { command: 'afford', description: 'Can I afford it? — /afford 20 shopping' },
  { command: 'status', description: 'Last sync, balances, what needs attention' },
  { command: 'sync', description: 'Pull new bank transactions now' },
  { command: 'help', description: 'This list' },
] as const;

export function formatHelpReply(unknownCommand?: string): string {
  const lines = TELEGRAM_COMMAND_MENU.map((c) => `/${c.command} — ${c.description}`);
  const head = unknownCommand ? `Unknown command: /${unknownCommand}\n\n` : '';
  return `${head}${lines.join('\n')}`;
}

/** One category's budget-vs-spend state, as `/left` and `/afford` need it —
 *  the same shape the digest's `DailyDigestCategory` carries minus the
 *  `children` field neither command renders. `budget <= 0` means no budget
 *  row exists, matching the convention everywhere else in this project. */
export interface CategoryBudgetSnapshot {
  name: string;
  budget: number;
  monthSpent: number;
  weekSpent: number;
}

/** The calendar-window inputs `weeklyEnvelope` needs, named the same as
 *  `DailyDigestWindow` in ./telegram.js — a different type only because this
 *  module must not import a type named for the daily digest into a command
 *  that has nothing to do with it. `daysLeftInMonthInclusive` is carried for
 *  parity with the digest's window and for later tasks that may want a
 *  days-to-go footer; `/left` and `/afford` themselves only need
 *  `daysFromWeekStartToMonthEnd`. */
export interface BudgetPeriod {
  daysFromWeekStartToMonthEnd: number;
  daysLeftInMonthInclusive: number;
}

/** Result of resolving a user-typed category fragment (`/left grocer`)
 *  against the real category list. */
export type CategoryQueryResult =
  | { kind: 'one'; category: CategoryBudgetSnapshot }
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'none' };

/**
 * Resolves a user-typed fragment to a category by case-insensitive prefix.
 *
 * An EXACT match wins outright even when it also prefixes other categories —
 * "Home" must resolve to "Home" and not go ambiguous against "Home
 * Improvement", because the exact name is the one case a typing user is most
 * likely to hit and it must never require a longer query to disambiguate
 * against its own child-ish sibling.
 */
export function resolveCategoryQuery(cats: CategoryBudgetSnapshot[], query: string): CategoryQueryResult {
  const q = query.trim().toLowerCase();
  const exact = cats.find((c) => c.name.toLowerCase() === q);
  if (exact) return { kind: 'one', category: exact };
  const matches = cats.filter((c) => c.name.toLowerCase().startsWith(q));
  if (matches.length === 1) return { kind: 'one', category: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', names: matches.map((c) => c.name) };
  return { kind: 'none' };
}

/**
 * Parses `/afford <amount> <query...>` — `'20 shopping'`, `'$20 shopping'`,
 * `'20.50 dining out'`. The amount must lead (a bare number or `$`-prefixed
 * number), followed by at least one space and a non-empty query; everything
 * after the amount, including embedded spaces, is the query verbatim.
 *
 * Returns `null` for anything that doesn't parse AND for a non-positive or
 * non-finite amount — the handler sends one `Usage: /afford 20 shopping`
 * line for every rejection rather than a menu of distinct parse errors,
 * so this function does not need to distinguish "no amount" from "$0".
 */
export function parseAffordArgs(args: string): { amount: number; query: string } | null {
  const trimmed = (args ?? '').trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^\$?(-?\d+(?:\.\d+)?)\s+(.+)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const query = match[2].trim();
  if (!Number.isFinite(amount) || amount <= 0 || !query) return null;
  return { amount, query };
}

/**
 * One `/left` line for a single BUDGETED category — shared by the bare
 * listing and by `/left <query>` resolving to one category, so the two paths
 * can never drift into describing the same state two different ways.
 *
 * Three states, ordered the same as the daily digest's for the same reason
 * (over-month dominates: a blown month makes the week's allowance moot):
 *  - over the MONTH's budget → 🚨, the overage, and no week figure — the
 *    week's allowance is meaningless once the month itself is blown
 *  - over the WEEK's envelope but the month still has room → ⚠️ and "week
 *    allowance spent" instead of a (necessarily negative) week figure, since
 *    the specific number is a distraction next to the fact that it's gone
 *  - otherwise → 🟢 with both figures
 *
 * State glyphs render unconditionally — see `GlyphStyle`'s doc comment in
 * ./telegram.ts: 🚨/⚠️/🟢 encode information Telegram has no other way to
 * carry, so they are exempt from `clean` mode's glyph stripping.
 */
function categoryLeftLine(cat: CategoryBudgetSnapshot, period: BudgetPeriod): string {
  const name = escapeMarkdown(cat.name);
  const { leftThisWeek, remainingMonth } = weeklyEnvelope({
    budget: cat.budget,
    monthSpent: cat.monthSpent,
    weekSpent: cat.weekSpent,
    daysFromWeekStartToMonthEnd: period.daysFromWeekStartToMonthEnd,
  });
  if (remainingMonth < 0) {
    // Math.abs explicitly: "over by" states the direction.
    return `🚨 ${name} — over by ${moneyWhole(Math.abs(remainingMonth))} this month`;
  }
  if (leftThisWeek < 0) {
    return `⚠️ ${name} — week allowance spent · ${moneyWhole(remainingMonth)} left this month`;
  }
  return `🟢 ${name} — ${moneyWhole(leftThisWeek)} left this week · ${moneyWhole(remainingMonth)} left this month`;
}

/** The sentence both `/left <query>` and `/afford` send when the resolved
 *  category has no budget row: you cannot be over a target that was never
 *  set, so this states the plain spend and stops there. */
function noBudgetReply(cat: CategoryBudgetSnapshot): string {
  const name = escapeMarkdown(cat.name);
  return `${name}: ${moneyWhole(cat.monthSpent)} spent this month\nNo budget set for ${name} — nothing to be over.`;
}

/** Shared by `/left` and `/afford`: once a query resolves to `ambiguous` or
 *  `none`, both commands reply identically — the reader typed the same
 *  fragment either way and needs the same nudge regardless of which command
 *  they used. Returns `null` for `'one'`, leaving that case to the caller,
 *  which needs the resolved category for command-specific work. */
function queryMissReply(result: CategoryQueryResult, query: string): string | null {
  if (result.kind === 'ambiguous') {
    return `Which one? ${result.names.map((n) => escapeMarkdown(n)).join(', ')}`;
  }
  if (result.kind === 'none') {
    return `No category starts with "${escapeMarkdown(query)}". /left lists them all.`;
  }
  return null;
}

/**
 * Formats a reply to `/left` (bare) or `/left <query>`.
 *
 * Bare: one line per category WITH a budget (`budget > 0`), via
 * `categoryLeftLine`. Categories without a budget are omitted entirely —
 * this is the digest's own rule (`formatDailySpendingDigest`'s off-budget
 * categories render separately, but `/left`'s bare listing is the "what do I
 * still have" view, and a line reading "no budget · $40 spent" answers a
 * question nobody asked it).
 *
 * With a query: resolves via `resolveCategoryQuery` and answers the one
 * match, or the ambiguous/none nudge shared with `/afford`.
 *
 * `style` is accepted, not used: `/left`'s glyphs are the STATE glyphs
 * (🟢/⚠️/🚨), which — per `GlyphStyle`'s doc comment in ./telegram.ts —
 * render unconditionally in both `clean` and `glyphs` mode. The parameter
 * exists for signature parity with the digest formatters and because a later
 * task passes the user's real setting through; a formatter ignoring it here
 * is correct precisely because state glyphs are exempt.
 */
export function formatLeftReply(
  cats: CategoryBudgetSnapshot[],
  period: BudgetPeriod,
  _style: GlyphStyle,
  query?: string,
): string {
  if (query) {
    const result = resolveCategoryQuery(cats, query);
    const miss = queryMissReply(result, query);
    if (miss !== null) return miss;
    const cat = (result as { kind: 'one'; category: CategoryBudgetSnapshot }).category;
    if (cat.budget <= 0) return noBudgetReply(cat);
    return categoryLeftLine(cat, period);
  }

  const lines = cats.filter((c) => c.budget > 0).map((c) => categoryLeftLine(c, period));
  if (lines.length === 0) {
    return 'No budgets set. Set up budgets in Wealthfolio to see what is left to spend.';
  }
  return lines.join('\n');
}

/**
 * Formats a reply to `/afford <amount> <query>` — "if I spend $20 on
 * shopping, where does that put me?"
 *
 * Resolves the query exactly as `/left` does (same ambiguous/none nudge, same
 * no-budget sentence — the reader typed the same fragment and gets the same
 * answer regardless of which command exposed the miss).
 *
 * With a budget, calls `weeklyEnvelope` twice — once as-is, once with the
 * hypothetical purchase added to BOTH `weekSpent` and `monthSpent` — and
 * reports both the week and month figures as a before → after pair, so the
 * reader sees the purchase's actual effect rather than just its landing
 * state. The verdict is three-way and mirrors the digest's over-month-
 * dominates ordering:
 *  - after-week >= 0 → still fits the week outright → 🟢
 *  - after-week < 0 but after-month >= 0 → the week's envelope is blown but
 *    the month survives → ⚠️
 *  - after-month < 0 → the month itself goes negative → 🚨, with the overage
 *
 * `style` is unused for the same reason as `formatLeftReply`: these are all
 * STATE glyphs, exempt from `clean` mode's stripping.
 */
export function formatAffordReply(
  cats: CategoryBudgetSnapshot[],
  period: BudgetPeriod,
  _style: GlyphStyle,
  amount: number,
  query: string,
): string {
  const result = resolveCategoryQuery(cats, query);
  const miss = queryMissReply(result, query);
  if (miss !== null) return miss;
  const cat = (result as { kind: 'one'; category: CategoryBudgetSnapshot }).category;
  if (cat.budget <= 0) return noBudgetReply(cat);

  const before = weeklyEnvelope({
    budget: cat.budget,
    monthSpent: cat.monthSpent,
    weekSpent: cat.weekSpent,
    daysFromWeekStartToMonthEnd: period.daysFromWeekStartToMonthEnd,
  });
  const after = weeklyEnvelope({
    budget: cat.budget,
    monthSpent: cat.monthSpent + amount,
    weekSpent: cat.weekSpent + amount,
    daysFromWeekStartToMonthEnd: period.daysFromWeekStartToMonthEnd,
  });

  const verdict = after.leftThisWeek >= 0
    ? "🟢 Fits this week's allowance."
    : after.remainingMonth >= 0
      ? "⚠️ Blows this week's allowance but fits the month."
      // Math.abs explicitly: "Over ... by" states the direction.
      : `🚨 Over the month's budget by ${moneyWhole(Math.abs(after.remainingMonth))}.`;

  return (
    `This week: ${moneyWhole(before.leftThisWeek)} left → ${moneyWhole(after.leftThisWeek)} left\n`
    + `This month: ${moneyWhole(before.remainingMonth)} left → ${moneyWhole(after.remainingMonth)} left\n`
    + verdict
  );
}
