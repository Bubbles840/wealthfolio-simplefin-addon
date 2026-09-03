/**
 * shared/telegram-commands.ts
 *
 * Parsing and reply formatting for the bot's slash commands. Pure functions —
 * data in, string out — beside the report formatters in ./telegram.ts and for
 * the same reason: the companion owns transport and storage, and everything
 * testable without a network lives here.
 */

import { weeklyEnvelope, moneyWhole, escapeMarkdown, formatRelativeTime } from './telegram.js';
import type { GlyphStyle } from './telegram.js';
// ONE way of naming a category where naming the wrong one is expensive. It lives
// with the menu because that is where the type carrying `parentName` lives; a
// second copy of the `Name (Parent)` rule is how the preview and the miss reply
// would come to disagree about which category they are talking about.
import { categoryDisplayName } from './categorize-menu.js';

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
  { command: 'reports', description: 'Charts on your phone — tap-through menu + the dashboard' },
  { command: 'left', description: "What's left per category — /left groceries narrows it" },
  { command: 'afford', description: 'Can I afford it? — /afford 20 shopping' },
  { command: 'pool', description: 'Semester money pool — /pool 16000 Dec 12' },
  { command: 'status', description: 'Last sync, balances, what needs attention' },
  { command: 'sync', description: 'Pull new bank transactions now' },
  { command: 'categorize', description: 'File uncategorized transactions, right from here' },
  // Directly after `/categorize`, because the two are one pair — file an unfiled
  // row, move a filed one — and this menu is the only place most readers will
  // ever see either name. The description carries an EXAMPLE like `/left`'s and
  // `/newrule`'s do: the optional query is invisible otherwise, and a reader who
  // does not know about it scrolls 90 days of history by hand.
  { command: 'recategorize', description: 'Move a filed transaction — /recategorize venmo narrows it' },
  { command: 'newrule', description: 'Always file a match — /newrule trader joes = groceries' },
  { command: 'dismissed', description: 'What you dismissed lately, with Undo' },
  { command: 'help', description: 'This list' },
] as const;

export function formatHelpReply(unknownCommand?: string): string {
  const lines = TELEGRAM_COMMAND_MENU.map((c) => `/${c.command} — ${c.description}`);
  // Escaped like every other caller-supplied string in this file: the "unknown
  // command" is whatever the user typed, so `/a*b` would leave an unbalanced
  // entity, Telegram would refuse the whole message (`ok: false`, 400) — and the
  // one person guaranteed to see this reply is the one who just made a typo.
  // Silence is the worst possible answer to that.
  const head = unknownCommand ? `Unknown command: /${escapeMarkdown(unknownCommand)}\n\n` : '';
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

/** The minimum a resolvable category has to carry. `parentName` is optional
 *  because `/left` and `/afford` resolve BUDGET rows, which have no parent at
 *  all; `/newrule` resolves the spending tree, whose rows do — and where two of
 *  its rows share a name, the parent is the only thing that tells them apart
 *  (see `categoryDisplayName`). */
export interface ResolvableCategory {
  name: string;
  parentName?: string | null;
}

/** Result of resolving a user-typed category fragment (`/left grocer`)
 *  against the real category list.
 *
 *  Generic over the row shape, defaulting to the budget snapshot `/left` and
 *  `/afford` pass: `/newrule` resolves the same way but needs the matched
 *  category's ID back (a rule is written against an id, not a name), and its
 *  tree includes CHILD categories, which carry no budget figures at all.
 *  Parameterising is what lets both use ONE resolver — a second prefix matcher
 *  for id-carrying categories would be the same semantics written twice. */
export type CategoryQueryResult<T extends ResolvableCategory = CategoryBudgetSnapshot> =
  | { kind: 'one'; category: T }
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
 *
 * But an exact match on a name TWO categories share is not a resolution, it is
 * a coin toss. Wealthfolio's preset tree ships duplicate leaf names (an `Other`
 * under several parents, a `Gas` under both Transportation and Bills), and
 * `/newrule` resolves over the FLAT tree, so `= other` would otherwise silently
 * take the first one and write a rule that sweeps every matching uncategorized
 * row into a category the user never picked. Duplicates are reported the same
 * way an ambiguous PREFIX is — the reader retypes, nothing is guessed. `/left`
 * and `/afford` are unaffected: their rows are budgeted parents, whose names are
 * unique, and a single match still resolves to `one` exactly as before.
 *
 * Only `name` and `parentName` are read, so the matched element is handed BACK
 * untouched: a caller passing categories with ids gets its id-carrying object
 * out again.
 */
export function resolveCategoryQuery<T extends ResolvableCategory>(
  cats: T[],
  query: string,
): CategoryQueryResult<T> {
  const q = query.trim().toLowerCase();
  // The QUALIFIED name first — `other (home)`, exactly as an ambiguity reply
  // prints it. Without this the duplicate report below would be a question with
  // no typable answer: retyping either name resolves against the bare name and
  // goes ambiguous all over again. Rows with no parent display as their own name,
  // so for `/left` and `/afford` this is the same test as the one below and
  // changes nothing for them.
  const qualified = cats.filter((c) => categoryDisplayName(c).toLowerCase() === q);
  if (qualified.length === 1) return { kind: 'one', category: qualified[0] };
  if (qualified.length > 1) return { kind: 'ambiguous', names: qualified.map(categoryDisplayName) };
  const exact = cats.filter((c) => c.name.toLowerCase() === q);
  if (exact.length === 1) return { kind: 'one', category: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', names: exact.map(categoryDisplayName) };
  const matches = cats.filter((c) => c.name.toLowerCase().startsWith(q));
  if (matches.length === 1) return { kind: 'one', category: matches[0] };
  // Qualified by parent where there is one, so two `Other`s do not produce the
  // unanswerable question "Which one? Other, Other".
  if (matches.length > 1) return { kind: 'ambiguous', names: matches.map(categoryDisplayName) };
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

/** The default pointer: right for `/left` and `/afford`, whose queries are
 *  resolved against exactly the categories `/left` lists. */
const LEFT_CATEGORY_LIST_HINT = '/left lists them all.';

/** `/newrule`'s pointer. `/left` is the wrong place to send this reader twice
 *  over: it lists only BUDGETED PARENTS, while `/newrule` resolves over the whole
 *  tree — a mistyped SUBCATEGORY can never appear in `/left`'s output at all, so
 *  the default hint would have them checking a list that cannot contain what they
 *  are looking for. Wealthfolio's own category settings are the list that can. */
export const NEWRULE_CATEGORY_LIST_HINT =
  'Subcategories count too — Wealthfolio\'s category settings list them all.';

/** Shared by `/left`, `/afford` and `/newrule`: once a query resolves to
 *  `ambiguous` or `none`, every command says the same thing about the miss
 *  itself — the reader typed the same fragment either way. Only the POINTER at
 *  the end differs, because the commands resolve against different lists (see
 *  `listHint`). Returns `null` for `'one'`, leaving that case to the caller,
 *  which needs the resolved category for command-specific work.
 *
 *  Exported (unlike the rest of this file's private helpers) because
 *  `/newrule`'s handler lives in the companion: it resolves against
 *  id-carrying categories and then hands the match to the menu controller, so
 *  it has no formatter of its own here to hide behind. Typed against
 *  `ResolvableCategory` for the same reason `resolveCategoryQuery` is
 *  generic — a child category has no budget figures. */
export function formatCategoryQueryMiss(
  result: CategoryQueryResult<ResolvableCategory>,
  query: string,
  /** Where to go to see the real list. Defaults to `/left`'s own pointer, which
   *  is right for `/left` and `/afford` and wrong for `/newrule` — see
   *  `NEWRULE_CATEGORY_LIST_HINT`. */
  listHint: string = LEFT_CATEGORY_LIST_HINT,
): string | null {
  if (result.kind === 'ambiguous') {
    return `Which one? ${result.names.map((n) => escapeMarkdown(n)).join(', ')}`;
  }
  if (result.kind === 'none') {
    return `No category starts with "${escapeMarkdown(query)}". ${listHint}`;
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
    const miss = formatCategoryQueryMiss(result, query);
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
  const miss = formatCategoryQueryMiss(result, query);
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

/**
 * `/status`'s inputs — one snapshot of everything the bot can currently say
 * about sync health, assembled by the companion (Task 6) from the addon
 * secrets it already owns: `sync_health` for the timing fields, a live
 * balance/drift read per account, and whatever counts the categorizer and
 * Amazon-email parser last published.
 *
 * Every "count" field is nullable INDEPENDENTLY of being zero, and the two
 * must render differently: `null` means the companion has never published
 * that signal (an older companion build, or a check that has not run yet),
 * while `0` is a real, reported "nothing to do here". Collapsing null into 0
 * would make a companion that has simply never counted uncategorized
 * transactions read as "zero uncategorized transactions" — a clean bill of
 * health it never issued.
 */
export interface StatusReplyInput {
  version: string;
  /** ISO; null = never synced — but see `lastSyncUnreadable`, which is the
   *  difference between "no sync has run" and "we could not find out". */
  lastSyncAt: string | null;
  /**
   * The sync record itself could not be read (a 401, a dead session, a
   * connectivity blip), so `lastSyncAt: null` above carries NO information.
   *
   * Separate from `lastSyncAt: null` on purpose: "Last sync: never" is a
   * confident negative, and a signal that could not be read does not support
   * one. Optional so every existing caller keeps its current rendering.
   */
  lastSyncUnreadable?: boolean;
  /** e.g. '0 imported, 105 skipped'; null = no summary recorded for the last run. */
  lastSyncSummary: string | null;
  accounts: Array<{
    name: string;
    balance: number;
    currency: string;
    /** Signed difference from the bank's reported balance; null = not compared. */
    drift: number | null;
    /** Whether a comparison was actually attempted this run — see the chip
     *  precedence below for why this can't be inferred from `drift` alone. */
    measured: boolean;
  }>;
  /**
   * How many accounts the snapshot HAS but could not be priced — SimpleFin
   * reported no numeric balance for them, so they cannot appear in `accounts`
   * above (whose `balance` is a plain number, because inventing a `$0` for one
   * is the one thing here a reader could act on wrongly).
   *
   * Counted rather than dropped: the addon's own balance card renders those
   * accounts with a `—`, and a status list that is quietly SHORT is worse than
   * one that says what it could not price. Absent or `0` renders nothing.
   */
  accountsWithoutBalance?: number;
  /**
   * The balance snapshot could not be read at all, so `accounts` is empty for a
   * reason that has nothing to do with how many accounts exist.
   *
   * Without this, an unreadable snapshot renders as zero account lines AND
   * `accountsWithoutBalance: 0` — a list that is silently missing, with nothing
   * in the reply to explain the gap. Optional, same as above.
   */
  accountBalancesUnreadable?: boolean;
  /** null = the companion never published this signal. */
  uncategorizedCount: number | null;
  amazonUnparsed: number | null;
}

/**
 * One account's sync-state chip, in the exact precedence the addon's own
 * balance card uses (src/tabs/OverviewTab.tsx): drift beats measured beats
 * neither.
 *
 * `drift: null` is ambiguous on its own — it means BOTH "compared and it
 * matched" and "could not be compared at all" (no bank figure to diff
 * against). `measured` is the only field that tells them apart, which is why
 * it must be checked, and why a non-null drift must be checked FIRST: a
 * companion could in principle report both a stale `measured: true` and a
 * fresh `drift`, and the drift is the more current fact either way. Reporting
 * "in sync" for the "could not compare" case previously read as a verified
 * balance when nothing had actually been checked — the mistake behind two
 * phantom-drift incidents.
 */
function accountStateChip(account: StatusReplyInput['accounts'][number]): string {
  if (account.drift !== null) {
    // Math.abs explicitly: "off" states the direction, same rule as everywhere
    // else a bare moneyWhole figure sits next to a direction word.
    return `${moneyWhole(Math.abs(account.drift))} off`;
  }
  if (account.measured === true) return 'in sync';
  return 'not checked';
}

/**
 * Formats `/status`'s reply: version, last sync, one line per account, then
 * whatever attention-needed counts the companion has actually published.
 *
 * The two trailing lines (uncategorized count, unparsed Amazon emails) are
 * omitted rather than printed as zero/none when their source is `null` — see
 * `StatusReplyInput`'s doc comment for why that distinction matters.
 *
 * The two `*Unreadable` flags are the same idea one step further: a signal that
 * could not be READ gets a line saying so, instead of borrowing the wording for
 * "there is genuinely nothing here" (`Last sync: never`, an empty account list).
 */
export function formatStatusReply(input: StatusReplyInput, now: Date): string {
  const lines: string[] = [`*SimpleFin Sync* — companion v${input.version}`];

  if (input.lastSyncUnreadable === true) {
    // Checked BEFORE the null branch: a read that failed says nothing about
    // whether a sync ever ran, and "never" would be a claim derived from a
    // signal nobody managed to look at.
    lines.push('Last sync: unknown — the sync record could not be read.');
  } else if (input.lastSyncAt === null) {
    lines.push('Last sync: never');
  } else {
    const ago = formatRelativeTime(input.lastSyncAt, now);
    lines.push(
      input.lastSyncSummary !== null
        // Escaped like every other caller-supplied string in this file (see
        // `errors[0]` in formatSyncReply): a summary can carry a bank's or an
        // exception's own text, and Telegram refuses a message with unbalanced
        // Markdown entities outright — the reply would silently never arrive.
        ? `Last sync: ${ago} — ${escapeMarkdown(input.lastSyncSummary)}`
        : `Last sync: ${ago}`,
    );
  }

  for (const account of input.accounts) {
    // Account names are Wealthfolio-user-controlled text, not trusted display
    // strings — same reasoning as every other place a name is interpolated
    // into a Markdown message in this file.
    const name = escapeMarkdown(account.name);
    lines.push(`${name}: ${moneyWhole(account.balance)} · ${accountStateChip(account)}`);
  }

  // Directly beneath the account lines, because it is a statement ABOUT that
  // list — it explains why the list is shorter than the user's account count,
  // which is only obvious while the two are adjacent.
  const unpriced = input.accountsWithoutBalance ?? 0;
  if (unpriced > 0) {
    lines.push(`${unpriced} account(s) have no balance yet — SimpleFin did not report one.`);
  }

  // Same place, same reason, for the harder case: the snapshot could not be read
  // at all. Without this line the account list is simply absent and the reply
  // reads as "you have no accounts" — a claim nothing here can support.
  if (input.accountBalancesUnreadable === true) {
    lines.push('Account balances could not be read — this list is missing, not empty.');
  }

  if (input.uncategorizedCount !== null && input.uncategorizedCount > 0) {
    lines.push(`Needs a category: ${input.uncategorizedCount}`);
  }

  if (input.amazonUnparsed !== null && input.amazonUnparsed > 0) {
    lines.push(`⚠️ ${input.amazonUnparsed} Amazon email(s) unread — format may have changed`);
  }

  return lines.join('\n');
}

/**
 * The one-line footer `/report` appends below the digest, so a reply built
 * from cached/last-known data still tells the reader how fresh it is —
 * without this, a report sent hours after the last sync could be mistaken for
 * a live read.
 */
export function formatReportFooter(lastSyncAt: string | null, now: Date): string {
  if (lastSyncAt === null) return 'No sync has run yet — /sync to pull transactions.';
  return `Data as of last sync, ${formatRelativeTime(lastSyncAt, now)} — /sync to pull new charges.`;
}

/**
 * Formats `/sync`'s reply once a run completes. Lines are additive, in the
 * same "state the headline, then whatever needs attention" shape as
 * `formatStatusReply`: the import/skip counts always render, a drift warning
 * follows when any account drifted, and — last, and first-only — an error
 * line when the run hit one. Only the first error: Telegram is not a log
 * file, and a wall of stack-adjacent text in a chat message helps no one
 * decide what to do next; `/status` is where the fuller picture lives.
 */
export function formatSyncReply(r: { imported: number; skipped: number; driftAlerts: number; errors: string[] }): string {
  const lines = [`Synced: ${r.imported} imported, ${r.skipped} skipped.`];

  if (r.driftAlerts > 0) {
    lines.push(`⚠️ ${r.driftAlerts} account(s) showed drift — check /status.`);
  }

  if (r.errors.length > 0) {
    // Escaped like formatSyncHealthFooter's lastError: an error message can
    // originate from a bank API or an exception's own text, not from anything
    // this codebase controls, so it gets the same treatment as any other
    // untrusted string landing in a Markdown message.
    lines.push(`Sync finished with errors: ${escapeMarkdown(r.errors[0])}`);
  }

  return lines.join('\n');
}

/** What `/pool` replies when its arguments don't parse. The example is the
 *  fastest possible documentation, per the menu's own convention. */
export const POOL_USAGE_REPLY =
  'Set the pool: /pool 16000 Dec 12 — that amount has to last until that date.\n'
  + 'See it: /pool · Turn it off: /pool off';

export type PoolCommand =
  | { kind: 'show' }
  | { kind: 'clear' }
  | { kind: 'set'; amountCents: number; endDate: string };

const POOL_MONTH_PREFIXES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** YYYY-MM-DD for a UTC year/month/day — or null when the day overflows the
 *  month (Feb 31 must be a refusal, not a silent March 3). */
function poolDateString(year: number, monthIndex: number, day: number): string | null {
  const d = new Date(Date.UTC(year, monthIndex, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== monthIndex || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * `/pool` arguments. Three forms:
 *   ``            → show the current pool
 *   `off`         → clear it
 *   `<amount> <date>` → set it, e.g. `/pool 16000 Dec 12`, `/pool $16,000.50
 *                   until 2026-12-12`. A month-name date means its NEXT
 *                   occurrence — a semester end is always ahead of you — and a
 *                   past ISO date is refused rather than silently accepted as
 *                   an already-ended pool.
 *
 * The START date is deliberately not accepted here: it is set companion-side
 * to the day the command runs, which is when the disbursement is in hand.
 */
export function parsePoolArgs(args: string, now: Date): PoolCommand | null {
  const t = args.trim();
  if (t === '') return { kind: 'show' };
  if (/^off$/i.test(t)) return { kind: 'clear' };

  const tokens = t.split(/\s+/).filter((w) => !/^(until|till?|to)$/i.test(w));
  if (tokens.length < 2) return null;

  const amountRaw = tokens[0].replace(/[$,]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(amountRaw)) return null;
  const amountCents = Math.round(parseFloat(amountRaw) * 100);
  if (amountCents <= 0) return null;

  const today = now.toISOString().slice(0, 10);
  const dateTokens = tokens.slice(1);

  if (dateTokens.length === 1 && /^\d{4}-\d{2}-\d{2}$/.test(dateTokens[0])) {
    const iso = dateTokens[0];
    const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
    if (poolDateString(y, m - 1, d) !== iso) return null;
    if (iso < today) return null;
    return { kind: 'set', amountCents, endDate: iso };
  }

  if (dateTokens.length === 2 && /^\d{1,2}$/.test(dateTokens[1])) {
    const monthIndex = POOL_MONTH_PREFIXES.indexOf(dateTokens[0].slice(0, 3).toLowerCase());
    const day = parseInt(dateTokens[1], 10);
    if (monthIndex === -1) return null;
    const thisYear = poolDateString(now.getUTCFullYear(), monthIndex, day);
    if (thisYear === null) return null;
    return {
      kind: 'set',
      amountCents,
      endDate: thisYear >= today ? thisYear : poolDateString(now.getUTCFullYear() + 1, monthIndex, day)!,
    };
  }

  return null;
}
