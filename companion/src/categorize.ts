/**
 * companion/src/categorize.ts
 *
 * The controller behind `/categorize`: it holds the chat's menu session, turns a
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
 * WHY NOTHING HERE CAN THROW AT THE LISTENER. A tap is dispatched from the
 * long-poll loop that also runs bank syncing; every `deps.*` call that can fail
 * is caught and rendered as a screen the user can act on, and `republish` — a
 * status tile, never worth a lost flow — is swallowed with a log. The `ui`
 * callbacks are guaranteed never to reject by the listener, so they are called
 * without `.catch` and their return values are ignored.
 */

import {
  applyTap,
  renderScreen,
  MENU_CALLBACK_PREFIX,
  type CategorizeTxn,
  type MenuAction,
  type MenuScreen,
  type MenuSession,
  type SpendingCategory,
} from '../../shared/categorize-menu.js';
import { escapeMarkdown, type InlineKeyboard } from '../../shared/telegram.js';
import { visibleUncategorized, type DismissalLedger } from '../../shared/uncategorized.js';
import { descriptionFromComment } from '../../shared/sync-core.js';
import { uncategorizedWindow } from './uncategorized-status.js';

/**
 * The taxonomy every write in this feature targets. Wealthfolio also has income
 * and savings taxonomies, and its API takes the id explicitly, so the constant
 * lives with the feature that owns it rather than being retyped at each of the
 * three call sites that bind it into `assign`/`unassign`/`createRule`.
 */
export const SPENDING_TAXONOMY_ID = 'spending_categories';

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
  /** Files one activity under one category (taxonomy applied by the caller). */
  assign: (activityId: string, categoryId: string) => Promise<void>;
  /** Clears the spending assignment — the undo side of `assign`. */
  unassign: (activityId: string) => Promise<void>;
  /** Creates a contains-match rule (priority + taxonomy applied by the caller). */
  createRule: (rule: { name: string; pattern: string; categoryId: string }) => Promise<void>;
  /** Republishes the addon's needs-a-category status. May throw; a failure here
   *  costs a stale tile, never the flow the user is in (see `republishQuietly`). */
  republish: () => Promise<void>;
  log: (msg: string) => void;
}

export interface CategorizeController {
  /** `/categorize`: builds a fresh session and sends the list screen. */
  open(send: (text: string, keyboard?: InlineKeyboard) => Promise<void>): Promise<void>;
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
const ASSIGN_FAILED_PREFIX = 'Couldn\'t file that — Wealthfolio said: ';
const UNDO_FAILED_PREFIX = 'Couldn\'t undo that — Wealthfolio said: ';
const DISMISS_FAILED_PREFIX = 'Couldn\'t save that — Wealthfolio said: ';
const RULE_FAILED_PREFIX = 'Couldn\'t create that rule — Wealthfolio said: ';

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
  'filed', 'dismissed', 'rulePreview', 'ruleCreated',
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

/** One chat's live menu. `session` is replaced wholesale on every render, which
 *  is what makes a tap on an outdated message safe (see `applyTap`); `pinned`
 *  survives across renders for as long as a screen still needs it. */
interface ChatSession {
  session: MenuSession;
  pinned: CategorizeTxn | null;
}

/** One fresh sweep: the visible rows, the categories, and the ledger those rows
 *  were filtered with — the same object then serves as the merge `base`, so a
 *  dismissal cannot be based on a ledger older than the list it acted on. */
interface Fresh {
  txns: CategorizeTxn[];
  categories: SpendingCategory[];
  ledger: DismissalLedger;
}

type Loaded = { ok: true; fresh: Fresh } | { ok: false; text: string };

export function createCategorizeController(deps: CategorizeDeps): CategorizeController {
  const sessions = new Map<number, ChatSession>();

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
   *  legitimately empty SimpleFin description) falls back to the raw note rather
   *  than rendering an empty button — the `uncategorized-status.ts` rule. */
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
   * One fresh sweep of everything a render needs. Called before EVERY render and
   * again before every write that has a precondition — never cached, because a
   * cached answer is the bug this whole file is arranged to avoid.
   *
   * A failure is returned as ready-to-render TEXT rather than thrown: the caller
   * always has a screen to put it on, and there is no path from here on which
   * throwing would be more informative than saying so on the phone.
   */
  async function load(): Promise<Loaded> {
    let path: string | null;
    try {
      path = deps.dbPath();
    } catch (err) {
      safeLog(`Categorize menu: could not locate the database: ${formatError(err)}`);
      return { ok: false, text: NO_DATABASE_TEXT };
    }
    if (!path) return { ok: false, text: NO_DATABASE_TEXT };

    try {
      const { start, end } = uncategorizedWindow(new Date());
      const rows = deps.readRows(path, start, end);
      const ledger = await deps.readLedger();
      const categories = deps.readCategories(path);
      return {
        ok: true,
        // ONE definition of "needs a category", shared with the status tile and
        // the addon: the native rows minus whatever the ledger dismissed.
        fresh: { txns: visibleUncategorized(rows, ledger).map(toTxn), categories, ledger },
      };
    } catch (err) {
      const message = formatError(err);
      safeLog(`Categorize menu: could not read what needs a category: ${message}`);
      // Escaped because the message is Markdown-parsed on its way to Telegram,
      // and an API body carrying an unbalanced `*` or `_` gets the whole edit
      // refused — a screen that simply never appears.
      return { ok: false, text: `${READ_FAILED_PREFIX}${escapeMarkdown(message)}` };
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

  /** Rebuilds the session around a fresh sweep, splicing the pinned row back in
   *  when the screen names a row the sweep no longer returns (a confirmation for
   *  something just filed or dismissed). Callers decide whether a pin applies —
   *  see `PINNED_SCREEN_KINDS` — because splicing one into a LIST screen would
   *  show a row that no longer needs a category. */
  function show(
    chat: ChatSession,
    screen: MenuScreen,
    pin: CategorizeTxn | null,
    fresh: Fresh,
  ): { text: string; keyboard: InlineKeyboard | undefined } {
    const missing = pin !== null && !fresh.txns.some((t) => t.activityId === pin.activityId);
    chat.session = {
      txns: missing && pin !== null ? [pin, ...fresh.txns] : fresh.txns,
      categories: fresh.categories,
      screen,
      buttons: [],
    };
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
   * second tap is the retry.
   */
  async function showError(chat: ChatSession, text: string, ui: CategorizeUi): Promise<void> {
    const buttons: MenuAction[] = [];
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    const add = (label: string, action: MenuAction): void => {
      rows.push([{ text: label, callback_data: `${MENU_CALLBACK_PREFIX}${buttons.length}` }]);
      buttons.push(action);
    };
    add('« Back', { kind: 'goto', screen: chat.session.screen });
    add('Done', { kind: 'close' });
    chat.session.buttons = buttons;
    await ui.edit(text, { inline_keyboard: rows });
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

  /** Load fresh, then render `screen`. The freshness rule, in one function. */
  async function transition(
    chat: ChatSession,
    screen: MenuScreen,
    pin: CategorizeTxn | null,
    ui: CategorizeUi,
  ): Promise<void> {
    const loaded = await load();
    if (!loaded.ok) {
      await showError(chat, loaded.text, ui);
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

      case 'refresh':
        await transition(chat, chat.session.screen, carryPin(chat, chat.session.screen), ui);
        return;

      case 'close': {
        // No reads: closing must work even when the database has gone away, and
        // there is nothing left to be fresh about.
        sessions.delete(chatId);
        const closed: ChatSession = {
          session: { txns: [], categories: [], screen: { kind: 'closed' }, buttons: [] },
          pinned: null,
        };
        const { text, keyboard } = present(closed);
        await ui.edit(text, keyboard);
        return;
      }

      case 'assign': {
        const loaded = await load();
        if (!loaded.ok) {
          await showError(chat, loaded.text, ui);
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
        // so a fresh sweep no longer lists it — that is the state Undo is for.
        // The tap can only have come from the `filed` screen's own button table.
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
        const loaded = await load();
        if (!loaded.ok) {
          await showError(chat, loaded.text, ui);
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
        const loaded = await load();
        if (!loaded.ok) {
          await showError(chat, loaded.text, ui);
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
          const loaded = await load();
          if (!loaded.ok) {
            await showError(chat, loaded.text, ui);
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

  return {
    /**
     * Deliberately NOT wrapped in a catch-all, unlike `onCallback`: a throw from
     * here lands in the listener's `onCommand` guard, which logs it AND replies
     * "Something went wrong running that command" — a better outcome than
     * anything this function could invent, and the reason the failures it CAN
     * anticipate are returned as text instead.
     */
    async open(send): Promise<void> {
      const loaded = await load();
      if (!loaded.ok) {
        // No session is stored: there is nothing to tap, and a keyboard that
        // resolved against a session from a previous menu would be worse.
        await send(loaded.text);
        return;
      }
      // A second `/categorize` REPLACES the menu rather than adding one. The
      // listener honours exactly one chat, so clearing the map is that
      // replacement — and it means the older message's buttons resolve against
      // the NEW session, where the index is either out of range (expired) or
      // simply whatever now sits at that position. Neither can act on the row
      // the old message showed.
      sessions.clear();
      const chat: ChatSession = {
        session: { txns: [], categories: [], screen: { kind: 'list', page: 0 }, buttons: [] },
        pinned: null,
      };
      const { text, keyboard } = show(chat, { kind: 'list', page: 0 }, null, loaded.fresh);
      sessions.set(PENDING_CHAT_ID, chat);
      await send(text, keyboard);
    },

    /**
     * `cb.messageId` is never read: the `ui` handed in is already bound to the
     * message this tap came from. That is deliberate — the listener lifts the id
     * off an untrusted payload (`cq?.message?.message_id`), so a non-Telegram
     * response can supply `undefined` under its `number` type.
     */
    async onCallback(cb, ui): Promise<void> {
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
