/**
 * companion/src/categorize.ts
 *
 * The controller behind `/categorize` AND `/recategorize`: it holds the chat's
 * menu session, turns a
 * tapped button into a write against Wealthfolio, and renders the next screen.
 * `shared/categorize-menu.ts` is the pure machine (screens in, text + keyboard
 * out) and knows nothing about the world; the listener owns the transport and
 * hands over an `edit`/`answer`/`send` UI. This file is the only place where
 * those two meet, which is why it is also the only place that can get the
 * ordering wrong.
 *
 * WHY EVERY READ AND WRITE IS INJECTED. Two reasons, both structural. The menu's
 * data comes from a read-only SQLite file and its writes go over Wealthfolio's
 * REST API, and neither is reachable in a test; and the whole feature's safety
 * property is an ORDER — read fresh, decide, write, read fresh again, render —
 * which is only observable if the reads and writes are things a test can count.
 * So `dbPath`, the two native readers, the ledger read/write, the three writes
 * and the republish are all parameters. This module reads no environment
 * variable, names no secret key, opens no socket and touches no file itself.
 *
 * THE FRESHNESS RULE, which is the reason this file exists at all. Every screen
 * transition re-reads the rows, the dismissal ledger and the categories BEFORE
 * rendering, and any tap that would WRITE to a row first checks that the row is
 * still uncategorized. A menu is a message that sits on a phone for minutes: in
 * the meantime the addon, an import, or a categorization rule can file the very
 * row the buttons describe. A row filed elsewhere must simply disappear from the
 * next render (see `showGone`) rather than be written to a second time.
 *
 * THE TWO MODES, one machine. `categorize` files a row that has NO category;
 * `recategorize` moves one that already has one. They share every screen, every
 * token, every guard — the difference is which sweep a render re-reads
 * (`readRows` vs `readCategorized`) and which write a category tap performs. A
 * chat's `MenuMode` records that choice, plus the search/import scope a
 * `/recategorize` was opened with, so every later refresh reproduces the SAME
 * list the user is looking at instead of silently widening it.
 *
 * WHY A CROSS-TAXONOMY MOVE DELETES BEFORE IT ASSIGNS. Wealthfolio keeps one
 * assignment PER TAXONOMY per activity (its DELETE route is
 * `/assignments/{taxonomy_id}`), so a row can hold an income assignment and a
 * spending one at the same time, and setting the spending one does NOT clear the
 * income one. The move therefore deletes every non-spending assignment FIRST and
 * assigns the spending category SECOND. That order is deliberate, and it is
 * chosen for its failure mode: interrupted between the two steps, the row ends up
 * with NO category — visible in `/categorize`, one tap from fixed. The reverse
 * order would leave a window in which the row counts as income AND as a spending
 * offset at once, which is the silent double count this whole feature exists to
 * remove, invisible to every freshness check because both assignments are real.
 * A test pins the order; the error screen never claims the category was set when
 * only the delete succeeded.
 *
 * WHY NOTHING HERE CAN THROW AT THE LISTENER. A tap is dispatched from the
 * long-poll loop that also runs bank syncing; every `deps.*` call that can fail
 * is caught and rendered as a screen the user can act on, and `republish` — a
 * status tile, never worth a lost flow — is swallowed with a log. The `ui`
 * callbacks are guaranteed never to reject by the listener, so they are called
 * without `.catch` and their return values are ignored.
 */

import {
  applyTap,
  layoutScreen,
  renderScreen,
  type CategorizeTxn,
  type MenuAction,
  type MenuScreen,
  type MenuSession,
  type SpendingCategory,
} from '../../shared/categorize-menu.js';
import { escapeMarkdown, CATEGORIZE_ENTRY_CALLBACK, type InlineKeyboard } from '../../shared/telegram.js';
import { visibleUncategorized, type DismissalLedger } from '../../shared/uncategorized.js';
import { descriptionFromComment, txIdFromComment } from '../../shared/sync-core.js';
import { uncategorizedWindow } from './uncategorized-status.js';

/**
 * The taxonomy every write in this feature targets. Wealthfolio also has income
 * and savings taxonomies, and its API takes the id explicitly, so the constant
 * lives with the feature that owns it rather than being retyped at each of the
 * three call sites that bind it into `assign`/`unassign`/`createRule`.
 */
export const SPENDING_TAXONOMY_ID = 'spending_categories';

/**
 * What this feature CALLS the other side of the ledger, for the sentences and
 * comments that have to name it — deliberately not a taxonomy id, and never
 * compared against one.
 *
 * A Wealthfolio instance's income taxonomy is `income_categories`, there is a
 * savings one as well, and a future release can add more. So "the old category
 * is on the other side" is detected as `taxonomyId !== SPENDING_TAXONOMY_ID`,
 * which clears a taxonomy nobody anticipated rather than silently leaving it
 * behind next to a new spending assignment — the double count again. An exported
 * id would invite exactly the equality check that gets that wrong.
 */
export const INCOME_TAXONOMY_NOTE = 'income';

/** What the menu needs from one native uncategorized row. `NativeUncategorizedTx`
 *  from ./sqlite-native.js satisfies this structurally; this module deliberately
 *  does not import that reader (see the header — every read is injected), and
 *  mirrors how `publishUncategorizedStatusForDbPath` takes its own row reader. */
export interface CategorizeSourceRow {
  activityId: string;
  /** RAW stored note (`<description> · <txId>[ · pending]`), cleaned below. */
  notes: string;
  amountCents: number;
  date: string;
  accountName: string;
}

/** One taxonomy's assignment on a row — `NativeAssignment` from
 *  ./sqlite-native.js satisfies this structurally. A row can carry several, one
 *  per taxonomy, which is the fact the whole recategorize write is arranged
 *  around. */
export interface CategorizeAssignment {
  taxonomyId: string;
  categoryId: string;
  categoryName: string;
}

/** What the recategorize menu needs from one native CATEGORIZED row —
 *  `NativeCategorizedTx` satisfies this structurally, and is not imported here
 *  for the same reason `CategorizeSourceRow` is not: every read is injected. */
export interface CategorizedSourceRow {
  activityId: string;
  /** RAW stored note, cleaned for display and parsed for the tx id. */
  notes: string;
  amountCents: number;
  date: string;
  accountName: string;
  /** EVERY taxonomy's assignment on this activity. */
  assignments: CategorizeAssignment[];
}

/** The three transport calls the listener binds to one tap. NONE of them ever
 *  rejects — that is the listener's guarantee, and it is what makes them safe to
 *  call without a `.catch` from inside this controller's own catch blocks. */
export interface CategorizeUi {
  /** Replaces the tapped message's text and keyboard in place. */
  edit: (text: string, keyboard?: InlineKeyboard) => Promise<void>;
  /** Clears the tapped button's spinner, with an optional toast. */
  answer: (text?: string) => Promise<void>;
  /** A NEW message, for when replacing the tapped one is wrong. */
  send: (text: string, keyboard?: InlineKeyboard) => Promise<void>;
}

export interface CategorizeDeps {
  /**
   * Where the Wealthfolio database is, or `null` when the companion has no
   * usable database access at all (unset path, container mount missing, file
   * moved). `null` is a distinct answer from "nothing needs a category": the
   * native readers return `[]` for a path that is not there, so a menu built
   * anyway would state — confidently and falsely — that there is nothing to do.
   */
  dbPath: () => string | null;
  /** `getNativeUncategorizedSpending`, over `uncategorizedWindow(new Date())`. */
  readRows: (dbPath: string, startInclusive: string, endExclusive: string) => CategorizeSourceRow[];
  /**
   * `getNativeCategorizedSpending`, over the SAME window as `readRows` — the two
   * partition one universe, so a row is in exactly one of them.
   *
   * Read on three paths: the `/recategorize` list, the freshness check behind a
   * reassign, and (since it exists at all) both menus' Undo verifications. That
   * last one is why it is not optional: without it `/categorize`'s Undo is the
   * blind write it was until v1.13.0.
   */
  readCategorized: (dbPath: string, startInclusive: string, endExclusive: string) => CategorizedSourceRow[];
  /** `getNativeSpendingCategories`. */
  readCategories: (dbPath: string) => SpendingCategory[];
  readLedger: () => Promise<DismissalLedger>;
  /**
   * Persists a dismissal delta. `base` is the ledger THIS controller read a
   * moment ago; `next` is what it wants the ledger to become; the difference is
   * the intent (one id added, or one id removed).
   *
   * The implementation MUST re-read the ledger immediately before writing and
   * replay only that delta — `pruneDismissals(mergeDismissals(persisted, base,
   * next), now)`, the `applyTelegramDismissal` pattern in index.ts. TWO reads:
   * the addon writes this same secret and there is no compare-and-swap on it, so
   * passing `base` as `persisted` reduces the merge to a whole-object write that
   * silently erases whatever the other host recorded in between. That was the
   * 1.10.1 bug, and its symptom is a row the user already dismissed quietly
   * reappearing as needing a category.
   */
  writeLedgerMerged: (base: DismissalLedger, next: DismissalLedger) => Promise<void>;
  /**
   * Files one activity under one category.
   *
   * `taxonomyId` is OPTIONAL and defaults — in the IMPLEMENTATION, not here — to
   * the spending taxonomy, which is what every path but one passes nothing for.
   * The exception is undoing a reassignment that came from the income side:
   * restoring it means writing under that other taxonomy, and one dep that takes
   * the taxonomy is better than a second dep that only ever writes income,
   * because the two would be free to disagree about the order the surrounding
   * delete happens in.
   *
   * An implementation that ignores the third argument is a silent defect, not a
   * type error: it would file an income restore as a SPENDING assignment, which
   * is the very state the restore is undoing. The order log in the tests asserts
   * the taxonomy each call carried for that reason.
   */
  assign: (activityId: string, categoryId: string, taxonomyId?: string) => Promise<void>;
  /** Clears the spending assignment — the undo side of `assign`. */
  unassign: (activityId: string) => Promise<void>;
  /**
   * Clears ONE taxonomy's assignment (`unassignActivityCategory`, whose route is
   * per-taxonomy). Distinct from `unassign` — which is the spending-only undo of
   * a `/categorize` filing and is bound to that taxonomy by its caller — because
   * the taxonomies a recategorize has to clear are whatever the row turns out to
   * be carrying, discovered from `readCategorized` at tap time.
   */
  unassignTaxonomy: (activityId: string, taxonomyId: string) => Promise<void>;
  /** Creates a contains-match rule (priority + taxonomy applied by the caller). */
  createRule: (rule: { name: string; pattern: string; categoryId: string }) => Promise<void>;
  /** Republishes the addon's needs-a-category status. May throw; a failure here
   *  costs a stale tile, never the flow the user is in (see `republishQuietly`). */
  republish: () => Promise<void>;
  log: (msg: string) => void;
}

/** What both entry points send with: `reply` from the command handler, or the
 *  `ui.send` of the message a `cz:open` tap arrived on. Called with ONE argument
 *  when there is no keyboard to attach, so a caller can distinguish "no
 *  keyboard" from "an empty one". */
type MenuSend = (text: string, keyboard?: InlineKeyboard) => Promise<void>;

export interface CategorizeController {
  /** `/categorize`: builds a fresh session and sends the list screen. */
  open(send: MenuSend): Promise<void>;
  /**
   * `/newrule <pattern> = <category>`: builds a fresh session parked on the
   * free-rule confirmation screen and sends it. The category is already
   * RESOLVED to an id by the caller (`resolveCategoryQuery` over the same
   * native category read this controller uses), because the miss cases —
   * ambiguous, none — are plain replies with no menu behind them at all.
   *
   * The `Create rule` button flows through the same `deps.createRule` as the
   * tapped-off-a-transaction path, with the same name truncation and the same
   * disclosure copy: one rule write, two ways in.
   */
  openRulePreview(pattern: string, categoryId: string, send: MenuSend): Promise<void>;
  /**
   * `/recategorize [text]`: builds a fresh session over the CATEGORIZED sweep and
   * sends the list screen.
   *
   * `query` filters case-insensitively on the CLEANED description — the string
   * the buttons show, not the stored note, so the ` · <txId>` suffix every note
   * carries cannot make a search match everything. A blank or whitespace-only
   * argument is no filter at all rather than a filter nothing matches: the
   * command handler cannot tell `/recategorize` from `/recategorize ` , and
   * "nothing matches" for an empty search would be a lie.
   *
   * The scope is remembered for the whole session, so every later refresh
   * reproduces the same list instead of quietly widening to everything.
   */
  openRecategorize(query: string | undefined, send: MenuSend): Promise<void>;
  /**
   * The import notice's `Recategorize` button: the same menu, scoped to the
   * transactions THAT import brought in, matched by the stored note's tx id (the
   * sync's own identity mechanism — never by description).
   *
   * `null` means the scope is gone: the companion restarted and the memory of
   * which rows an old notice was about died with it. That degrades to the plain
   * recent list, which is honest and still useful, rather than to an empty screen
   * that would read as "that import filed nothing".
   */
  openRecategorizeForTxIds(txIds: string[] | null, send: MenuSend): Promise<void>;
  /** One `cz:` tap. */
  onCallback(cb: { data: string; chatId: number; messageId: number }, ui: CategorizeUi): Promise<void>;
}

/** Byte-identical to the listener's own notice, and imported by neither: the
 *  listener answers with this string when no controller is wired up at all, and
 *  the two must read the same to the user. Pinned by tests on both sides. */
const MENU_EXPIRED_ANSWER = 'That menu expired — send /categorize again.';

/** A `cz:` payload that is not a token this module ever emitted. Not an error to
 *  the user — the honest thing is to redraw the screen they are looking at. */
const STALE_TOKEN_ANSWER = 'That button is stale — refreshing.';

const NO_DATABASE_TEXT = 'The companion has no database access right now, so it can\'t tell what needs a category.';
const READ_FAILED_PREFIX = 'Couldn\'t check what needs a category — ';
/** The same two failures on the `/newrule` path, which shows NO list at all: it
 *  was handed a pattern and a category, and what it needs the database for is
 *  looking that category up. Telling its reader the companion "can't tell what
 *  needs a category" describes a screen they never asked for and cannot see.
 *  The no-database sentence is byte-identical to `NEWRULE_NO_DATABASE_REPLY` in
 *  index.ts — the command's own pre-check answers the same failure a moment
 *  earlier, and the two must read the same. Pinned by tests on both sides. */
const RULE_NO_DATABASE_TEXT = 'The companion has no database access right now, so it can\'t look up your categories.';
const RULE_READ_FAILED_PREFIX = 'Couldn\'t set that rule up — ';
/** The same two failures on the `/recategorize` path, where "what needs a
 *  category" names a question its reader did not ask: every row that menu lists
 *  already HAS a category. Same reason the two `/newrule` sentences exist above,
 *  and the same reason `RECATEGORIZE_GONE_NOTE` exists in the pure machine. */
const RECATEGORIZE_NO_DATABASE_TEXT = 'The companion has no database access right now, so it can\'t look up your transactions.';
const RECATEGORIZE_READ_FAILED_PREFIX = 'Couldn\'t look up your transactions — ';
const ASSIGN_FAILED_PREFIX = 'Couldn\'t file that — Wealthfolio said: ';
const UNDO_FAILED_PREFIX = 'Couldn\'t undo that — Wealthfolio said: ';
const DISMISS_FAILED_PREFIX = 'Couldn\'t save that — Wealthfolio said: ';
const RULE_FAILED_PREFIX = 'Couldn\'t create that rule — Wealthfolio said: ';
const REFILE_FAILED_PREFIX = 'Couldn\'t move that — Wealthfolio said: ';

/**
 * What a half-finished move left behind, appended to the failure above. Three
 * outcomes rather than one sentence, because which of them is TRUE depends on how
 * far the delete-then-assign sequence got, and a reader who is told "nothing
 * changed" about a row that is now uncategorized has been misinformed about their
 * own books.
 */
const REFILE_UNCHANGED_SUFFIX = '\n\nNothing changed — this transaction still has the category it had.';
const REFILE_CLEARED_SUFFIX = '\n\nThe new category was NOT set, and the old one is already cleared — this transaction is uncategorized now, so /categorize will offer it.';
const REFILE_PARTIAL_SUFFIX = '\n\nThe new category was NOT set. Some of the old assignments were already cleared — check this transaction in Wealthfolio.';

/**
 * The same three outcomes for a failed UNDO, in undo's own words. Not the three
 * above: on this path it is the OLD category that failed to be set and the NEW
 * one that got cleared, so reusing them would state the failure backwards. Only
 * the actionable half survives such a swap, which is exactly how inverted copy
 * lives for a release without anyone noticing.
 */
const UNDO_UNCHANGED_SUFFIX = '\n\nNothing was restored — this transaction is still under the category the move set.';
const UNDO_CLEARED_SUFFIX = '\n\nThe old category was NOT restored, and the one the move set is already cleared — this transaction is uncategorized now, so /categorize will offer it.';
const UNDO_PARTIAL_SUFFIX = '\n\nThe old category was only partly restored — check this transaction in Wealthfolio.';

/**
 * A write declined because the row is no longer in the state the button
 * described. Says what was NOT done and why, in one sentence, for all three
 * verified writes (a reassign, its undo, and `/categorize`'s undo): the
 * alternative — acting anyway — erases a category somebody else just set.
 *
 * Rendered as the message, not as a toast, matching `showGone`: a toast is gone
 * in three seconds, and the refreshed list underneath it is the part that
 * explains what the row's category actually is now.
 */
const CHANGED_ELSEWHERE_TEXT = 'That transaction changed elsewhere — leaving it as is.';

/** Rule names are shown in Wealthfolio's own rules list, which is not a place
 *  for a 200-character card descriptor. The PATTERN is never truncated — a
 *  clipped pattern silently matches the wrong transactions. */
const RULE_NAME_PREFIX = 'Telegram: ';
const RULE_NAME_MAX = 60;

/**
 * Where `open`'s session waits until the first tap tells us the chat id.
 *
 * Sessions are keyed by chat id, but `open` is called from the command handler,
 * whose reply callback is already bound to the configured chat and carries no id
 * — while a callback query DOES carry one. So `open` parks the session under
 * this key and the first tap re-keys it (see `takeSession`). Zero is never a
 * real Telegram chat id, and the listener honours exactly one chat, so the
 * adoption can only ever hand the session to the chat it was built for.
 */
const PENDING_CHAT_ID = 0;

/** Screens that NAME a row a fresh sweep no longer returns — the confirmations
 *  for something just done (filed, dismissed) and the rule screens reached from
 *  them. `renderScreen` looks every id up in the session it is given and falls
 *  back to the list when it misses, so the controller has to carry the acted-on
 *  row forward for exactly these (see `MenuSession`'s doc comment). Any other
 *  screen gets the fresh data alone — that is what makes a row filed elsewhere
 *  disappear instead of lingering. */
const PINNED_SCREEN_KINDS: ReadonlySet<MenuScreen['kind']> = new Set([
  'filed', 'dismissed', 'rulePreview', 'ruleCreated', 'refiled',
]);

function pinnedActivityId(screen: MenuScreen): string | null {
  if (!PINNED_SCREEN_KINDS.has(screen.kind)) return null;
  return 'activityId' in screen ? screen.activityId : null;
}

/**
 * The listener and index.ts each carry their own copy of this; a fourth is
 * cheaper than an import cycle between the daemon's entry point and its parts.
 *
 * Total by construction: an error value is dependency-supplied data, and
 * stringifying one whose `toString` throws would throw while BUILDING the log
 * message it was going to be passed to — outside every guard downstream of it.
 */
function formatError(err: unknown): string {
  try {
    if (err instanceof Error) {
      const cause = (err as { cause?: { message?: string } }).cause;
      return cause ? `${err.message} (${cause.message ?? cause})` : err.message;
    }
    return String(err);
  } catch {
    return 'an error that could not be stringified';
  }
}

/**
 * Which sweep a chat's every render re-reads, and — for `recategorize` — the
 * scope the menu was opened with.
 *
 * Held per CHAT rather than passed per call because it has to survive between
 * taps: a `/recategorize venmo` whose second render forgot the query would widen
 * to every categorized transaction under the reader's fingers, and one whose
 * second render forgot the MODE would show the uncategorized list instead. Both
 * halves are read-only once set — a new list means a new session.
 */
type MenuMode =
  | { kind: 'categorize' }
  | {
      kind: 'recategorize';
      /** Already lower-cased, matched against the CLEANED description. `null` is
       *  no filter (including for a blank argument). */
      query: string | null;
      /** Stored-note tx ids from one import; `null` is no scope. */
      txIds: ReadonlySet<string> | null;
    };

const CATEGORIZE_MODE: MenuMode = { kind: 'categorize' };

/** One chat's live menu. `session` is replaced wholesale on every render, which
 *  is what makes a tap on an outdated message safe (see `applyTap`); `pinned`
 *  survives across renders for as long as a screen still needs it. */
interface ChatSession {
  session: MenuSession;
  pinned: CategorizeTxn | null;
  mode: MenuMode;
}

/** One fresh sweep: the visible rows, the categories, and the ledger those rows
 *  were filtered with — the same object then serves as the merge `base`, so a
 *  dismissal cannot be based on a ledger older than the list it acted on. */
interface Fresh {
  txns: CategorizeTxn[];
  categories: SpendingCategory[];
  /** EMPTY in recategorize mode, where the ledger is not read at all: it records
   *  which rows the user stopped being nagged about, and every row this menu
   *  lists already has a category, so it has no say in what appears here. The
   *  actions that use it as a merge base are unreachable there (the pure machine
   *  renders no `Keep uncategorized` button in recategorize mode). */
  ledger: DismissalLedger;
  /** Recategorize only: every taxonomy's assignment per activity, from the SAME
   *  read the rows came from — so the deletes a move performs and the row that
   *  move was checked against cannot come from two different moments. Empty in
   *  categorize mode. */
  assignments: ReadonlyMap<string, CategorizeAssignment[]>;
}

const NO_ASSIGNMENTS: ReadonlyMap<string, CategorizeAssignment[]> = new Map();

/** The spending assignment among a row's assignments, which is the one both Undo
 *  verifications and the same-category check are about. */
function spendingAssignmentOf(
  assignments: readonly CategorizeAssignment[] | undefined,
): CategorizeAssignment | null {
  return assignments?.find((a) => a.taxonomyId === SPENDING_TAXONOMY_ID) ?? null;
}

/** Why a load failed, kept as a REASON rather than as finished text: which
 *  sentence says it depends on the screen the render was for (see
 *  `failureText`), and only the caller knows that. `detail` is raw — escaping
 *  belongs with the formatting. */
interface LoadFailure {
  kind: 'no-database' | 'read-failed';
  detail: string;
}

type Loaded = { ok: true; fresh: Fresh } | { ok: false; failure: LoadFailure };

/**
 * The sentence a failed load gets, chosen by the SCREEN the render was for and
 * the MODE it was in — three pairs of sentences for three questions the reader
 * could have asked.
 *
 * The two `/newrule` screens (`freeRulePreview`, and the `ruleCreated`
 * confirmation reached from it — the one with no activityId) list nothing, so
 * the menu's own copy would describe a list their reader never asked for; they
 * win over the mode because a `/newrule` is always a categorize-mode session.
 * `/recategorize` lists plenty, but not "what needs a category" — everything on
 * it has one. Everything else is `/categorize`, where "what needs a category" is
 * exactly what the failed read was for.
 *
 * `escapeMarkdown` is applied HERE because the reply is Markdown-parsed on its
 * way to Telegram, and an API error carrying an unbalanced `*` or `_` gets the
 * whole message refused — a screen that simply never appears.
 */
function failureText(failure: LoadFailure, screen: MenuScreen, mode: MenuMode): string {
  const rulePath = screen.kind === 'freeRulePreview'
    || (screen.kind === 'ruleCreated' && screen.activityId === null);
  const [noDatabase, readFailedPrefix] = rulePath
    ? [RULE_NO_DATABASE_TEXT, RULE_READ_FAILED_PREFIX]
    : mode.kind === 'recategorize'
      ? [RECATEGORIZE_NO_DATABASE_TEXT, RECATEGORIZE_READ_FAILED_PREFIX]
      : [NO_DATABASE_TEXT, READ_FAILED_PREFIX];
  if (failure.kind === 'no-database') return noDatabase;
  return `${readFailedPrefix}${escapeMarkdown(failure.detail)}`;
}

export function createCategorizeController(deps: CategorizeDeps): CategorizeController {
  const sessions = new Map<number, ChatSession>();

  /**
   * Stamped onto every keyboard this controller emits, and never reset — not by
   * `close`, and deliberately not by a second `/categorize`. Per PROCESS, not
   * per session: a counter that restarted with each new session would reissue
   * generations that older messages still hold, which is exactly the confusion
   * it exists to prevent (see `MenuSession.generation`). A restart does reset
   * it, and that is safe because it also drops every session, so every
   * pre-restart button answers "that menu expired" from `takeSession` instead.
   */
  let generation = 0;
  const nextGeneration = (): number => ++generation;

  /**
   * The only way this module logs. `deps.log` is an injected dependency like any
   * other, so it is treated as hostile: every log call here sits in a catch
   * block that exists to stop something worse, and a throwing logger inside one
   * of those would re-create the exact failure the catch was written to prevent.
   * Mirrors the listener's `safeLog`, including the silent swallow — there is no
   * second channel on which to report a broken reporting channel.
   */
  function safeLog(msg: string): void {
    try {
      deps.log(msg);
    } catch {
      /* a logger that throws cannot be told about it */
    }
  }

  /** A stored note carries ` · <txId>` and possibly ` · pending`; the menu shows
   *  this string, so the bookkeeping is stripped first. A blank strip result (a
   *  legitimately empty SimpleFin description) falls back to the RAW note, the
   *  `uncategorized-status.ts` rule: the label template always carries the date
   *  and the amount, so the alternative is not a blank button but a button that
   *  reads `Aug 8 ·  · -$12` — one with a hole where the only identifying text
   *  it had should be. A visible ` · TRN-…` is the better of the two. */
  function toTxn(r: CategorizeSourceRow): CategorizeTxn {
    return {
      activityId: r.activityId,
      date: r.date,
      amountCents: r.amountCents,
      description: descriptionFromComment(r.notes) || r.notes,
      accountName: r.accountName,
    };
  }

  /**
   * The same mapping for a CATEGORIZED row, plus the category the menu shows and
   * undoes back to.
   *
   * `currentCategory` is the SPENDING assignment when there is one, and the first
   * assignment otherwise: the spending category is the name the reader recognises
   * (it is what their budgets and every `/left` figure are about), while a row
   * that has only an income assignment has nothing else to show. `null` for a row
   * with NO assignment at all — the native reader's inner join cannot produce
   * one, but a row with nothing to move FROM could not render the old → new
   * confirmation this menu is built on, and it belongs to `/categorize` anyway.
   */
  function toCategorizedTxn(r: CategorizedSourceRow): CategorizeTxn | null {
    const current = spendingAssignmentOf(r.assignments) ?? r.assignments[0];
    if (!current) return null;
    return {
      activityId: r.activityId,
      date: r.date,
      amountCents: r.amountCents,
      description: descriptionFromComment(r.notes) || r.notes,
      accountName: r.accountName,
      currentCategory: {
        taxonomyId: current.taxonomyId,
        categoryId: current.categoryId,
        name: current.categoryName,
      },
    };
  }

  /** The database path, or the reason there isn't one — shared by the two reads
   *  below so a missing mount is reported identically whichever of them needed
   *  it. */
  function resolvePath(): { ok: true; path: string } | { ok: false; failure: LoadFailure } {
    let path: string | null;
    try {
      path = deps.dbPath();
    } catch (err) {
      const detail = formatError(err);
      safeLog(`Categorize menu: could not locate the database: ${detail}`);
      return { ok: false, failure: { kind: 'no-database', detail } };
    }
    if (!path) return { ok: false, failure: { kind: 'no-database', detail: 'no database path' } };
    return { ok: true, path };
  }

  /**
   * One fresh sweep of everything a render needs. Called before EVERY render and
   * again before every write that has a precondition — never cached, because a
   * cached answer is the bug this whole file is arranged to avoid.
   *
   * A failure is returned as a REASON rather than thrown: the caller always has a
   * screen to put it on, and there is no path from here on which throwing would
   * be more informative than saying so on the phone. Turning the reason into a
   * sentence is `failureText`'s job, because which sentence is honest depends on
   * the screen the caller was rendering.
   */
  async function load(mode: MenuMode): Promise<Loaded> {
    const resolved = resolvePath();
    if (!resolved.ok) return resolved;
    const path = resolved.path;

    try {
      // The same 90-day window for both sweeps: they partition one universe, and
      // a row that moved between them must not be able to fall out of both.
      const { start, end } = uncategorizedWindow(new Date());
      if (mode.kind === 'recategorize') {
        const rows = deps.readCategorized(path, start, end);
        const categories = deps.readCategories(path);
        const assignments = new Map<string, CategorizeAssignment[]>();
        const txns: CategorizeTxn[] = [];
        for (const r of rows) {
          // Scope first, then the query, then the shape: all three are reasons a
          // row is not part of THIS list, and a row that is not in the list must
          // not leave its assignments behind for a write to find.
          if (mode.txIds && !mode.txIds.has(txIdFromComment(r.notes) ?? '')) continue;
          const txn = toCategorizedTxn(r);
          if (!txn) continue;
          // The CLEANED description, never the raw note: every note ends in
          // ` · <txId>`, so searching the raw string would make `trn` match the
          // entire history.
          if (mode.query && !txn.description.toLowerCase().includes(mode.query)) continue;
          assignments.set(r.activityId, r.assignments);
          txns.push(txn);
        }
        return { ok: true, fresh: { txns, categories, ledger: {}, assignments } };
      }
      const rows = deps.readRows(path, start, end);
      const ledger = await deps.readLedger();
      const categories = deps.readCategories(path);
      return {
        ok: true,
        // ONE definition of "needs a category", shared with the status tile and
        // the addon: the native rows minus whatever the ledger dismissed.
        fresh: {
          txns: visibleUncategorized(rows, ledger).map(toTxn),
          categories,
          ledger,
          assignments: NO_ASSIGNMENTS,
        },
      };
    } catch (err) {
      const detail = formatError(err);
      safeLog(`Categorize menu: could not read what needs a category: ${detail}`);
      return { ok: false, failure: { kind: 'read-failed', detail } };
    }
  }

  /**
   * JUST the current assignments, for a verification that has to know what a row
   * is filed under RIGHT NOW.
   *
   * Narrower than `load` on purpose: `/categorize`'s Undo runs in categorize mode,
   * whose sweep is the UNcategorized rows — which by definition cannot report the
   * category the row was just given. So that one guard reads the categorized side
   * directly, and reads nothing else: no ledger, no category tree, and no second
   * question it does not need answered before a write.
   *
   * A row outside the window is reported as having no assignments, which declines
   * the undo. That is the safe direction (no write on an unverifiable row), and it
   * is unreachable for a row this menu just filed, since the filing came from the
   * very same window.
   */
  async function loadAssignments(): Promise<
    { ok: true; byId: ReadonlyMap<string, CategorizeAssignment[]> } | { ok: false; failure: LoadFailure }
  > {
    const resolved = resolvePath();
    if (!resolved.ok) return resolved;
    try {
      const { start, end } = uncategorizedWindow(new Date());
      const byId = new Map<string, CategorizeAssignment[]>();
      for (const r of deps.readCategorized(resolved.path, start, end)) byId.set(r.activityId, r.assignments);
      return { ok: true, byId };
    } catch (err) {
      const detail = formatError(err);
      safeLog(`Categorize menu: could not read what a transaction is filed under: ${detail}`);
      return { ok: false, failure: { kind: 'read-failed', detail } };
    }
  }

  /** Republishing the addon's tile is a courtesy, never a step of the flow: a
   *  failure here would otherwise turn a completed filing into an error screen
   *  for something that already worked. */
  async function republishQuietly(): Promise<void> {
    try {
      await deps.republish();
    } catch (err) {
      safeLog(`Categorize menu: republishing the uncategorized status failed: ${formatError(err)}`);
    }
  }

  /**
   * Renders the session's current screen and stores the button table `applyTap`
   * will resolve the NEXT tap against — replaced wholesale every time, so an old
   * message's index can never address the row it used to show.
   *
   * A screen with no buttons yields NO keyboard rather than an empty one: on an
   * edit, an omitted `reply_markup` is how Telegram is told to leave the message
   * with no buttons at all, which is exactly what a final screen wants.
   */
  function present(chat: ChatSession): { text: string; keyboard: InlineKeyboard | undefined } {
    const rendered = renderScreen(chat.session);
    chat.session.buttons = rendered.buttons;
    return {
      text: rendered.text,
      keyboard: rendered.keyboard.inline_keyboard.length > 0 ? rendered.keyboard : undefined,
    };
  }

  /**
   * A session around a fresh sweep, at a NEW generation — every one of these is a
   * render about to happen, and a render is what invalidates the last one's
   * tokens.
   *
   * The pinned row TAKES PRECEDENCE over the fresh one, and is spliced in when the
   * sweep no longer returns it at all. Callers decide whether a pin applies — see
   * `PINNED_SCREEN_KINDS` — because splicing one into a LIST screen would show a
   * row that no longer needs a category.
   *
   * Precedence, not just splicing, because of `refiled`: a just-moved row is still
   * categorized, so the fresh sweep DOES return it — carrying its NEW category.
   * The confirmation's Undo button is built from `currentCategory`, and it has to
   * name the category the row held BEFORE the move or it "restores" the state it
   * was meant to reverse. For every other pinned screen the row has left the
   * visible set by definition, so precedence and splicing are the same thing.
   *
   * `mode` is set explicitly on every session, in both modes, rather than left to
   * `MenuSession.mode`'s `'categorize'` default: the default exists so that the
   * pure machine could gain the field without breaking callers that predate it,
   * and a controller relying on it would be one refactor away from rendering a
   * recategorize list as a needs-a-category one.
   */
  function buildSession(
    screen: MenuScreen,
    pin: CategorizeTxn | null,
    fresh: Fresh,
    mode: MenuMode['kind'],
  ): MenuSession {
    const txns = pin === null
      ? fresh.txns
      : fresh.txns.some((t) => t.activityId === pin.activityId)
        ? fresh.txns.map((t) => (t.activityId === pin.activityId ? pin : t))
        : [pin, ...fresh.txns];
    return {
      txns,
      categories: fresh.categories,
      screen,
      buttons: [],
      generation: nextGeneration(),
      mode,
    };
  }

  function show(
    chat: ChatSession,
    screen: MenuScreen,
    pin: CategorizeTxn | null,
    fresh: Fresh,
  ): { text: string; keyboard: InlineKeyboard | undefined } {
    chat.session = buildSession(screen, pin, fresh, chat.mode.kind);
    chat.pinned = pin;
    return present(chat);
  }

  /**
   * An error screen, with a keyboard this controller builds itself — the pure
   * machine has no failure screens, and a screen whose buttons were not stored
   * back onto the session would resolve the next tap against the PREVIOUS
   * screen's table.
   *
   * The session's `screen` is deliberately left alone: `« Back` returns to
   * wherever the failed tap came from, and nothing is retried on its own — a
   * second tap is the retry. The GENERATION does advance, because this is a
   * render like any other and the keyboard it replaces must stop resolving.
   *
   * The token format comes from `layoutScreen`, never from a local template: a
   * hand-rolled second copy is how a change to the format reaches some screens
   * and not others.
   */
  async function showError(chat: ChatSession, text: string, ui: CategorizeUi): Promise<void> {
    chat.session.generation = nextGeneration();
    const { keyboard, buttons } = layoutScreen(chat.session.generation, [
      [{ text: '« Back', action: { kind: 'goto', screen: chat.session.screen } }],
      [{ text: 'Done', action: { kind: 'close' } }],
    ]);
    chat.session.buttons = buttons;
    await ui.edit(text, keyboard);
  }

  /** The row a tap named is no longer uncategorized. Rendering ITS screen against
   *  fresh data is what makes the machine produce its own "no longer
   *  uncategorized" list — the same sentence a stale message gets anywhere else,
   *  written in exactly one place. No write happens on this path. */
  async function showGone(
    chat: ChatSession,
    activityId: string,
    fresh: Fresh,
    ui: CategorizeUi,
  ): Promise<void> {
    const { text, keyboard } = show(chat, { kind: 'txn', activityId }, null, fresh);
    await ui.edit(text, keyboard);
  }

  /**
   * A verified write declined: the row is no longer in the state the button
   * described, so nothing was written and the reader is put back on a list built
   * from the data that made that decision.
   *
   * The note goes in front of the LIST rather than of the screen the tap came
   * from, because the row's own screen would keep describing the move that is no
   * longer available. The `<note>\n\n<text>` shape is the pure machine's own note
   * format (see `renderList`'s `note` parameter), reproduced here because that
   * parameter is internal to the module and no screen kind carries a note.
   */
  async function showDeclined(chat: ChatSession, fresh: Fresh, ui: CategorizeUi): Promise<void> {
    const { text, keyboard } = show(chat, { kind: 'list', page: 0 }, null, fresh);
    await ui.edit(`${CHANGED_ELSEWHERE_TEXT}\n\n${text}`, keyboard);
  }

  /** Load fresh, then render `screen`. The freshness rule, in one function. */
  async function transition(
    chat: ChatSession,
    screen: MenuScreen,
    pin: CategorizeTxn | null,
    ui: CategorizeUi,
  ): Promise<void> {
    const loaded = await load(chat.mode);
    if (!loaded.ok) {
      // The TARGET screen names the copy: a render on its way to the typed-rule
      // confirmation must not report a failure in the menu's words.
      await showError(chat, failureText(loaded.failure, screen, chat.mode), ui);
      return;
    }
    const { text, keyboard } = show(chat, screen, pin, loaded.fresh);
    await ui.edit(text, keyboard);
  }

  /** The pin a `goto` should carry into its target screen: only for the screens
   *  that name a row, and only the row that screen is actually about. */
  function carryPin(chat: ChatSession, screen: MenuScreen): CategorizeTxn | null {
    const activityId = pinnedActivityId(screen);
    if (activityId === null) return null;
    return rowFor(chat, activityId);
  }

  /** The row a screen is about, from what the session already holds — the pin
   *  first, since a just-filed row has left the visible set by definition. */
  function rowFor(chat: ChatSession, activityId: string): CategorizeTxn | null {
    if (chat.pinned && chat.pinned.activityId === activityId) return chat.pinned;
    return chat.session.txns.find((t) => t.activityId === activityId) ?? null;
  }

  /** Shared by the two rule actions: `createRule` off a filed transaction and
   *  `createFreeRule` off a typed `/newrule` pattern. The pattern is used
   *  VERBATIM — it is a contains-match against the description, so escaping or
   *  clipping it would build a rule that matches nothing. */
  async function runCreateRule(
    chat: ChatSession,
    pattern: string,
    categoryId: string,
    done: MenuScreen,
    pin: CategorizeTxn | null,
    ui: CategorizeUi,
  ): Promise<void> {
    try {
      await deps.createRule({
        name: `${RULE_NAME_PREFIX}${pattern}`.slice(0, RULE_NAME_MAX),
        pattern,
        categoryId,
      });
    } catch (err) {
      const message = formatError(err);
      safeLog(`Categorize menu: creating a rule for "${pattern}" failed: ${message}`);
      await showError(chat, `${RULE_FAILED_PREFIX}${escapeMarkdown(message)}`, ui);
      return;
    }
    // The rule EXISTS from here on, so the session leaves the preview screen
    // before anything else can fail. `showError` offers `« Back` to whatever
    // `chat.session.screen` still says, and a preview left standing there hands
    // back a `Create rule` button for a rule already created — one lost
    // confirmation (a failed republish-then-render) and the obvious retry writes
    // an identical duplicate into Wealthfolio's rules list. The confirmation
    // screen itself offers no `Create rule` at all, which is the same guarantee
    // from the other side.
    chat.session.screen = done;
    // Creating a rule makes Wealthfolio file every other UNCATEGORIZED match at
    // once, so the published count is stale the moment this returns.
    await republishQuietly();
    await transition(chat, done, pin, ui);
  }

  async function perform(
    chatId: number,
    chat: ChatSession,
    action: MenuAction,
    ui: CategorizeUi,
  ): Promise<void> {
    switch (action.kind) {
      case 'goto':
        await transition(chat, action.screen, carryPin(chat, action.screen), ui);
        return;

      case 'close': {
        // No reads: closing must work even when the database has gone away, and
        // there is nothing left to be fresh about.
        sessions.delete(chatId);
        const closed: ChatSession = {
          session: buildSession(
            { kind: 'closed' },
            null,
            { txns: [], categories: [], ledger: {}, assignments: NO_ASSIGNMENTS },
            chat.mode.kind,
          ),
          pinned: null,
          mode: chat.mode,
        };
        const { text, keyboard } = present(closed);
        await ui.edit(text, keyboard);
        return;
      }

      case 'assign': {
        const loaded = await load(chat.mode);
        if (!loaded.ok) {
          await showError(chat, failureText(loaded.failure, chat.session.screen, chat.mode), ui);
          return;
        }
        const row = loaded.fresh.txns.find((t) => t.activityId === action.activityId) ?? null;
        // The precondition, checked against data read microseconds ago: a row
        // filed by a rule or by the addon while this menu sat on screen must not
        // be written to a second time.
        if (!row) {
          await showGone(chat, action.activityId, loaded.fresh, ui);
          return;
        }
        try {
          await deps.assign(action.activityId, action.categoryId);
        } catch (err) {
          const message = formatError(err);
          safeLog(`Categorize menu: filing ${action.activityId} failed: ${message}`);
          await showError(chat, `${ASSIGN_FAILED_PREFIX}${escapeMarkdown(message)}`, ui);
          return;
        }
        await republishQuietly();
        await transition(
          chat,
          { kind: 'filed', activityId: action.activityId, categoryId: action.categoryId, undone: false },
          row,
          ui,
        );
        return;
      }

      case 'unassign': {
        // NO visibility precondition, unlike `assign`: this row was just filed,
        // so a fresh sweep of what needs a category no longer lists it — that is
        // the state Undo is for. What IS checked is the assignment itself.
        //
        // This is the v1.12.0 hazard, closed. Until `readCategorized` existed,
        // nothing here could answer "what is this row filed under right now?":
        // `readRows` returns only UNCATEGORIZED rows and carries no category id,
        // and the REST client has no read-assignment call. So Undo wrote blind,
        // and if something else re-filed the row under a DIFFERENT category
        // between the filing and this tap, it cleared THAT assignment instead of
        // the one it was offered for — erasing a category somebody else had just
        // set. The reader closes it: the row's spending assignment must still be
        // the category this menu set, or the tap declines and refreshes.
        const verified = await loadAssignments();
        if (!verified.ok) {
          await showError(chat, failureText(verified.failure, chat.session.screen, chat.mode), ui);
          return;
        }
        const filedAs = spendingAssignmentOf(verified.byId.get(action.activityId));
        if (!filedAs || filedAs.categoryId !== action.categoryId) {
          // Also covers "already unfiled by someone else" (no assignment at all):
          // there is nothing this menu set left to undo, and clearing nothing
          // would report success for a no-op.
          const loaded = await load(chat.mode);
          if (!loaded.ok) {
            await showError(chat, failureText(loaded.failure, chat.session.screen, chat.mode), ui);
            return;
          }
          await showDeclined(chat, loaded.fresh, ui);
          return;
        }
        const row = rowFor(chat, action.activityId);
        try {
          await deps.unassign(action.activityId);
        } catch (err) {
          const message = formatError(err);
          safeLog(`Categorize menu: undoing the filing of ${action.activityId} failed: ${message}`);
          await showError(chat, `${UNDO_FAILED_PREFIX}${escapeMarkdown(message)}`, ui);
          return;
        }
        await republishQuietly();
        await transition(
          chat,
          { kind: 'filed', activityId: action.activityId, categoryId: action.categoryId, undone: true },
          row,
          ui,
        );
        return;
      }

      case 'dismiss': {
        // Categorize-only, as is `undismiss` below: the ledger records which rows
        // the user stopped being nagged about, and the pure machine renders no
        // `Keep uncategorized` button in recategorize mode, where every row
        // already has a category. Loading with `chat.mode` regardless keeps the
        // render coherent with the session it is drawn into.
        const loaded = await load(chat.mode);
        if (!loaded.ok) {
          await showError(chat, failureText(loaded.failure, chat.session.screen, chat.mode), ui);
          return;
        }
        const row = loaded.fresh.txns.find((t) => t.activityId === action.activityId) ?? null;
        if (!row) {
          await showGone(chat, action.activityId, loaded.fresh, ui);
          return;
        }
        // `base` is the ledger this very tap read, and `next` differs from it by
        // exactly one id: that difference is the whole intent, and it is what
        // survives another writer's concurrent entry (see `writeLedgerMerged`).
        const next: DismissalLedger = {
          ...loaded.fresh.ledger,
          [action.activityId]: new Date().toISOString(),
        };
        try {
          await deps.writeLedgerMerged(loaded.fresh.ledger, next);
        } catch (err) {
          const message = formatError(err);
          safeLog(`Categorize menu: dismissing ${action.activityId} failed: ${message}`);
          await showError(chat, `${DISMISS_FAILED_PREFIX}${escapeMarkdown(message)}`, ui);
          return;
        }
        await republishQuietly();
        await transition(chat, { kind: 'dismissed', activityId: action.activityId, undone: false }, row, ui);
        return;
      }

      case 'undismiss': {
        // Loaded for the ledger, which is the merge base — not for a visibility
        // check: a dismissed row is by definition absent from the visible set,
        // so requiring it there would make Undo impossible.
        const loaded = await load(chat.mode);
        if (!loaded.ok) {
          await showError(chat, failureText(loaded.failure, chat.session.screen, chat.mode), ui);
          return;
        }
        const row = rowFor(chat, action.activityId)
          ?? loaded.fresh.txns.find((t) => t.activityId === action.activityId)
          ?? null;
        const next: DismissalLedger = { ...loaded.fresh.ledger };
        delete next[action.activityId];
        try {
          await deps.writeLedgerMerged(loaded.fresh.ledger, next);
        } catch (err) {
          const message = formatError(err);
          safeLog(`Categorize menu: undoing the dismissal of ${action.activityId} failed: ${message}`);
          await showError(chat, `${UNDO_FAILED_PREFIX}${escapeMarkdown(message)}`, ui);
          return;
        }
        await republishQuietly();
        await transition(chat, { kind: 'dismissed', activityId: action.activityId, undone: true }, row, ui);
        return;
      }

      case 'createRule': {
        // The pattern IS the description, so without the row there is nothing to
        // create — and no reason to guess one.
        const row = rowFor(chat, action.activityId);
        if (!row) {
          const loaded = await load(chat.mode);
          if (!loaded.ok) {
            await showError(chat, failureText(loaded.failure, chat.session.screen, chat.mode), ui);
            return;
          }
          await showGone(chat, action.activityId, loaded.fresh, ui);
          return;
        }
        await runCreateRule(
          chat,
          row.description,
          action.categoryId,
          { kind: 'ruleCreated', activityId: action.activityId, categoryId: action.categoryId },
          row,
          ui,
        );
        return;
      }

      case 'createFreeRule':
        // Reachable once a `/newrule` entry point parks a session on the
        // `freeRulePreview` screen; the write and its copy are identical either
        // way, which is why both actions share `runCreateRule`.
        await runCreateRule(
          chat,
          action.pattern,
          action.categoryId,
          { kind: 'ruleCreated', activityId: null, categoryId: action.categoryId },
          null,
          ui,
        );
        return;

      case 'reassign': {
        const loaded = await load(chat.mode);
        if (!loaded.ok) {
          await showError(chat, failureText(loaded.failure, chat.session.screen, chat.mode), ui);
          return;
        }
        const fresh = loaded.fresh;
        const row = fresh.txns.find((t) => t.activityId === action.activityId) ?? null;
        // The row as the tapped KEYBOARD's session held it: what the screen said
        // it was filed under, and — carried forward as the pin below — the old
        // category the confirmation's Undo restores to.
        const pin = rowFor(chat, action.activityId);
        const shown = pin?.currentCategory ?? null;
        // THE precondition, and a stricter one than `assign`'s: not just "is the
        // row still there" but "is it still where the button said it was". A menu
        // sits on a phone for minutes; a rule or the addon can move the row inside
        // that window, and writing anyway would silently discard whatever category
        // that other writer chose — while the confirmation narrated a move FROM a
        // category the row had already left.
        if (!row || !row.currentCategory || !shown || row.currentCategory.categoryId !== shown.categoryId) {
          await showDeclined(chat, fresh, ui);
          return;
        }
        const assignments = fresh.assignments.get(action.activityId) ?? [];
        // Every taxonomy that is not the spending one, whatever it turns out to
        // be: an id-equality test against a known income taxonomy would leave a
        // taxonomy nobody anticipated in place next to the new spending
        // assignment, which is the double count itself (see INCOME_TAXONOMY_NOTE).
        const toClear = assignments.filter((a) => a.taxonomyId !== SPENDING_TAXONOMY_ID);
        const needsAssign = spendingAssignmentOf(assignments)?.categoryId !== action.categoryId;
        // Nothing to write means nothing to undo, and `refiled.restore` says so
        // with an empty list (the pure machine then renders no Undo button). A
        // button offered here could only rewrite the category the row already
        // carries and call it a restore.
        const writes = toClear.length > 0 || needsAssign;
        const refiled: MenuScreen = {
          kind: 'refiled',
          activityId: action.activityId,
          // The name the reader SAW, not the one just re-read: the sentence
          // narrates the move they asked for. The ids are equal by the check above.
          fromName: shown.name,
          toCategoryId: action.categoryId,
          crossTaxonomy: toClear.length > 0,
          undone: false,
          // EVERY assignment the row holds right now, spending included — the
          // complete state this move is about to replace, which is the only thing
          // an undo can faithfully replay. Read from the same sweep the checks
          // above used, and captured BEFORE the writes, because afterwards no
          // reader can report it any more.
          restore: writes
            ? assignments.map((a) => ({ taxonomyId: a.taxonomyId, categoryId: a.categoryId }))
            : [],
        };

        if (!writes) {
          // Already exactly where the tap asked for, with nothing on the other
          // side of the ledger to clear. A no-op write would be a lie in the
          // request log and an identical outcome; the confirmation still states
          // where the row sits, which is what was asked.
          await transition(chat, refiled, pin, ui);
          return;
        }

        let cleared = 0;
        try {
          // DELETE FIRST, ASSIGN SECOND. See the module header: interrupted here
          // the row ends up uncategorized (recoverable in one tap from
          // /categorize), where the other order would leave it counted as income
          // AND as a spending offset at once.
          for (const a of toClear) {
            await deps.unassignTaxonomy(action.activityId, a.taxonomyId);
            cleared += 1;
          }
        } catch (err) {
          const message = formatError(err);
          safeLog(`Categorize menu: clearing an assignment on ${action.activityId} failed: ${message}`);
          await showError(
            chat,
            `${REFILE_FAILED_PREFIX}${escapeMarkdown(message)}`
            + (cleared === 0 ? REFILE_UNCHANGED_SUFFIX : REFILE_PARTIAL_SUFFIX),
            ui,
          );
          return;
        }
        if (needsAssign) {
          try {
            await deps.assign(action.activityId, action.categoryId);
          } catch (err) {
            const message = formatError(err);
            safeLog(`Categorize menu: moving ${action.activityId} to ${action.categoryId} failed: ${message}`);
            // Never "filed": the new category is precisely what did NOT happen,
            // and when a delete did land the row has no category at all now.
            await showError(
              chat,
              `${REFILE_FAILED_PREFIX}${escapeMarkdown(message)}`
              + (cleared === 0 ? REFILE_UNCHANGED_SUFFIX : REFILE_CLEARED_SUFFIX),
              ui,
            );
            return;
          }
        }
        // Harmless when nothing UNcategorized changed, and necessary when the
        // clear left the row without a category for a moment.
        await republishQuietly();
        await transition(chat, refiled, pin, ui);
        return;
      }

      case 'undoReassign': {
        const loaded = await load(chat.mode);
        if (!loaded.ok) {
          await showError(chat, failureText(loaded.failure, chat.session.screen, chat.mode), ui);
          return;
        }
        // The screen the button was rendered on is where the category THIS menu
        // set is recorded — the action carries only where to put the row BACK.
        // The tap resolved at the current generation, so this is that screen.
        const screen = chat.session.screen;
        if (screen.kind !== 'refiled') {
          await showDeclined(chat, loaded.fresh, ui);
          return;
        }
        const filedAs = spendingAssignmentOf(loaded.fresh.assignments.get(action.activityId));
        // Same guarantee as `/categorize`'s Undo: only this menu's own write is
        // undone. Anything else — moved on again, or un-filed entirely — is left
        // alone rather than overwritten with a category that is now historical.
        if (!filedAs || filedAs.categoryId !== screen.toCategoryId) {
          await showDeclined(chat, loaded.fresh, ui);
          return;
        }
        const pin = rowFor(chat, action.activityId);
        // The whole previous state, replayed — not just the category the
        // confirmation displayed. A row can hold one assignment per taxonomy, so
        // restoring one of several would leave the user's data changed while this
        // menu reported the undo as done.
        //
        // Spending first, and only when the previous state HAD a spending
        // assignment: replacing it is a single PUT with no window at all. When it
        // had none (the Venmo-under-income case), the spending assignment the move
        // added has to GO, and that delete comes before the other PUTs for the same
        // reason it does on the way in — the interruptible moment leaves the row
        // uncategorized rather than counted twice.
        const keepsSpending = action.toRestore.some((a) => a.taxonomyId === SPENDING_TAXONOMY_ID);
        const replay = [
          ...action.toRestore.filter((a) => a.taxonomyId === SPENDING_TAXONOMY_ID),
          ...action.toRestore.filter((a) => a.taxonomyId !== SPENDING_TAXONOMY_ID),
        ];
        let cleared = false;
        let restored = 0;
        try {
          if (!keepsSpending) {
            await deps.unassignTaxonomy(action.activityId, SPENDING_TAXONOMY_ID);
            cleared = true;
          }
          for (const a of replay) {
            await deps.assign(action.activityId, a.categoryId, a.taxonomyId);
            restored += 1;
          }
        } catch (err) {
          const message = formatError(err);
          safeLog(`Categorize menu: restoring ${action.activityId} to its previous category failed: ${message}`);
          // Exactly what stands, in undo's own words: nothing restored and
          // nothing cleared is "unchanged"; nothing restored after the clear is an
          // uncategorized row; anything in between is a partial restore, and none
          // of the three may read as if the old category came back.
          const suffix = restored === 0
            ? (cleared ? UNDO_CLEARED_SUFFIX : UNDO_UNCHANGED_SUFFIX)
            : UNDO_PARTIAL_SUFFIX;
          await showError(chat, `${UNDO_FAILED_PREFIX}${escapeMarkdown(message)}${suffix}`, ui);
          return;
        }
        await republishQuietly();
        await transition(chat, { ...screen, undone: true }, pin, ui);
        return;
      }
    }
  }

  /** The session for a tap's chat, adopting `open`'s parked one the first time a
   *  chat id is known (see `PENDING_CHAT_ID`). */
  function takeSession(chatId: number): ChatSession | null {
    const own = sessions.get(chatId);
    if (own) return own;
    const pending = sessions.get(PENDING_CHAT_ID);
    if (!pending) return null;
    sessions.delete(PENDING_CHAT_ID);
    sessions.set(chatId, pending);
    return pending;
  }

  /**
   * Every entry point, in one function: load fresh, park a NEW session on
   * `screen` under `chatId`, and send it.
   *
   * A second entry REPLACES the menu rather than adding one. The listener
   * honours exactly one chat, so clearing the map is that replacement — and it
   * means an older message's buttons resolve against the NEW session, where the
   * index is either out of range (expired) or simply whatever now sits at that
   * position. Neither can act on the row the old message showed.
   * The older message's tokens carry an older GENERATION, which no session will
   * ever hold again, so every one of its buttons answers "that menu expired" —
   * including the ones whose index is still in range on the new screen (see
   * `MenuSession.generation`).
   *
   * On a failed load NO session is stored: there is nothing to tap, and a
   * keyboard that resolved against a session from a previous menu would be
   * worse. `send` is called with ONE argument there, so the caller can tell the
   * difference between "no keyboard" and "an empty keyboard".
   */
  async function openScreen(
    chatId: number,
    screen: MenuScreen,
    send: MenuSend,
    mode: MenuMode,
  ): Promise<void> {
    const loaded = await load(mode);
    if (!loaded.ok) {
      // In the words of the screen and mode that were being opened: `/newrule`
      // shows no list and `/recategorize` shows one of already-filed rows, so the
      // menu's "can't tell what needs a category" would name something neither
      // reader asked for (see `failureText`).
      await send(failureText(loaded.failure, screen, mode));
      return;
    }
    sessions.clear();
    const chat: ChatSession = {
      session: buildSession(screen, null, loaded.fresh, mode.kind),
      pinned: null,
      mode,
    };
    const { text, keyboard } = present(chat);
    sessions.set(chatId, chat);
    await send(text, keyboard);
  }

  return {
    /**
     * Deliberately NOT wrapped in a catch-all, unlike `onCallback`: a throw from
     * here lands in the listener's `onCommand` guard, which logs it AND replies
     * "Something went wrong running that command" — a better outcome than
     * anything this function could invent, and the reason the failures it CAN
     * anticipate are returned as text instead.
     *
     * The session is parked under `PENDING_CHAT_ID` because a command's `reply`
     * carries no chat id — the first tap adopts it (see `takeSession`).
     */
    async open(send): Promise<void> {
      await openScreen(PENDING_CHAT_ID, { kind: 'list', page: 0 }, send, CATEGORIZE_MODE);
    },

    /** Same parking as `open`, and uncaught for the same reason — this is a
     *  command path too (`/newrule`), reached with the category already
     *  resolved. */
    async openRulePreview(pattern, categoryId, send): Promise<void> {
      await openScreen(PENDING_CHAT_ID, { kind: 'freeRulePreview', pattern, categoryId }, send, CATEGORIZE_MODE);
    },

    /** Same parking and the same uncaught contract as `open` — `/recategorize` is
     *  a command path too. The query is lower-cased once, here, rather than at
     *  each render. */
    async openRecategorize(query, send): Promise<void> {
      const trimmed = (query ?? '').trim();
      await openScreen(
        PENDING_CHAT_ID,
        { kind: 'list', page: 0 },
        send,
        { kind: 'recategorize', query: trimmed ? trimmed.toLowerCase() : null, txIds: null },
      );
    },

    /** The import notice's button. Parked under `PENDING_CHAT_ID` like the command
     *  entries, so the first tap adopts it (see `takeSession`) — the notice hands
     *  over a `send`, not a chat id. */
    async openRecategorizeForTxIds(txIds, send): Promise<void> {
      await openScreen(
        PENDING_CHAT_ID,
        { kind: 'list', page: 0 },
        send,
        { kind: 'recategorize', query: null, txIds: txIds === null ? null : new Set(txIds) },
      );
    },

    /**
     * `cb.messageId` is never read: the `ui` handed in is already bound to the
     * message this tap came from. That is deliberate — the listener lifts the id
     * off an untrusted payload (`cq?.message?.message_id`), so a non-Telegram
     * response can supply `undefined` under its `number` type.
     */
    async onCallback(cb, ui): Promise<void> {
      // BEFORE any session lookup, and rendered with `send` rather than `edit`.
      // This payload is the import notice's `Categorize these` button, which
      // outlives every menu render and every restart, so it must never answer
      // "that menu expired" — and it sits on a message that LISTS what needs a
      // category and carries its own dismiss buttons. Editing the menu over it
      // would destroy the only record in the chat of what just imported.
      if (cb.data === CATEGORIZE_ENTRY_CALLBACK) {
        try {
          // `ui.send` verbatim, not a wrapper: `openScreen` calls it with one
          // argument when there is no keyboard, and that arity is observable.
          await openScreen(cb.chatId, { kind: 'list', page: 0 }, ui.send, CATEGORIZE_MODE);
        } catch (err) {
          // `openScreen` returns its anticipated failures as text, so reaching
          // here means something unforeseen threw. The spinner still has to
          // stop, or the tapped button spins until Telegram gives up on it.
          safeLog(`Categorize menu: opening from the import notice failed: ${formatError(err)}`);
        }
        // No toast: the new message IS the feedback, and a toast on top of it
        // would be a second notification for one tap.
        await ui.answer();
        return;
      }

      const chat = takeSession(cb.chatId);
      if (!chat) {
        // No session at all: a restart wiped it, or these buttons predate the
        // current menu. "Ask again" is both honest and actionable.
        await ui.answer(MENU_EXPIRED_ANSWER);
        return;
      }

      const tap = applyTap(chat.session, cb.data);
      if (!tap.ok) {
        if (tap.reason === 'expired') {
          await ui.answer(MENU_EXPIRED_ANSWER);
          return;
        }
        await ui.answer(STALE_TOKEN_ANSWER);
        await transition(chat, chat.session.screen, carryPin(chat, chat.session.screen), ui);
        return;
      }

      try {
        await perform(cb.chatId, chat, tap.action, ui);
        // Last, not first: the spinner on the tapped button is the only progress
        // indicator a slow write has, and clearing it early would report "done"
        // while the request is still out.
        await ui.answer();
      } catch (err) {
        // Every `deps.*` call above is already guarded individually, so this is
        // the belt to their braces — kept because the listener's own catch
        // deliberately sends nothing (it will not contradict a screen this
        // controller may have drawn), which would leave the tapped button
        // spinning forever. `ui.answer` cannot reject, by the listener's
        // contract, so this handler cannot fail either.
        safeLog(`Categorize menu: tap ${cb.data} could not be handled: ${formatError(err)}`);
        await ui.answer();
      }
    },
  };
}
