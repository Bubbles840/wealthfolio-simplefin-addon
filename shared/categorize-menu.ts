/**
 * shared/categorize-menu.ts
 *
 * The pure state machine behind Telegram's `/categorize` menu: given a
 * session (the uncategorized transactions, the category tree, and which
 * screen is showing) it renders text + an inline keyboard, and it turns a
 * tapped button back into an action for the controller to perform. No I/O —
 * fetching fresh data, calling Wealthfolio's API, and sending the Telegram
 * message all belong to a later task. Mirrors ./telegram-commands.ts: data
 * in, string (and keyboard) out.
 */

import type { InlineKeyboard } from './telegram.js';
import { moneyWhole, escapeMarkdown } from './telegram.js';

/** One uncategorized spending transaction, as the menu needs it. `date` is
 *  the raw YYYY-MM-DD string — this module never constructs a `Date`, since
 *  it is compiled into both the addon's browser bundle and the companion's
 *  Node build and must stay host-agnostic either way. `description` is
 *  already cleaned (stripped of the stored note's tx id/markers) by the
 *  caller's `descriptionFromComment`. */
export interface CategorizeTxn {
  activityId: string;
  date: string;
  amountCents: number;
  description: string;
  accountName: string;
}

/** One node of Wealthfolio's spending category tree. `parentId === null`
 *  marks a top-level category; `parentName` rides along so a screen that
 *  only has a child in hand (never happens today, but cheaper to carry than
 *  to re-derive) doesn't need a second lookup. */
export interface SpendingCategory {
  id: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
}

export type MenuScreen =
  | { kind: 'list'; page: number }
  | { kind: 'txn'; activityId: string }
  | { kind: 'subcats'; activityId: string; parentId: string }
  | { kind: 'filed'; activityId: string; categoryId: string; undone: boolean }
  | { kind: 'dismissed'; activityId: string; undone: boolean }
  | { kind: 'rulePreview'; activityId: string; categoryId: string }
  | { kind: 'freeRulePreview'; pattern: string; categoryId: string }
  | { kind: 'ruleCreated'; activityId: string | null; categoryId: string }
  | { kind: 'closed' };

export interface MenuSession {
  /** Fresh read, already ledger-filtered — whatever the caller passes is
   *  taken as the truth for this render. A screen confirming an action just
   *  taken (`filed`, `dismissed`, `ruleCreated`) needs the acted-on row's
   *  data to still be present here even though a truly fresh sweep would no
   *  longer include it; supplying that is the controller's job, not this
   *  module's — see the `renderScreen` doc comment for the fallback that
   *  covers the case where it genuinely isn't. */
  txns: CategorizeTxn[];
  categories: SpendingCategory[];
  screen: MenuScreen;
  /** Buttons rendered LAST for this session, by token index. applyTap resolves
   *  tokens against this, so a tap on an outdated message can never act on the
   *  wrong row. */
  buttons: MenuAction[];
}

export type MenuAction =
  | { kind: 'goto'; screen: MenuScreen }
  | { kind: 'assign'; activityId: string; categoryId: string }
  | { kind: 'unassign'; activityId: string; categoryId: string }
  | { kind: 'dismiss'; activityId: string }
  | { kind: 'undismiss'; activityId: string }
  | { kind: 'createRule'; activityId: string; categoryId: string }
  | { kind: 'createFreeRule'; pattern: string; categoryId: string }
  | { kind: 'refresh' }
  | { kind: 'close' };

/**
 * Parses `/newrule <pattern> = <category>` (or `→` in place of `=`) — the
 * free-text counterpart to tapping "Make this a rule" off a specific
 * transaction. Splits on the FIRST separator only, so a category name that
 * itself contains "=" (unusual, but user-entered text is user-entered text)
 * cannot fracture the pattern side. Either side empty after trimming means
 * there was nothing usable on that side, so the whole thing is rejected
 * rather than guessed at — the handler's job, not this function's, is
 * turning that into the one-line usage reply.
 */
export function parseNewRuleArgs(args: string): { pattern: string; categoryQuery: string } | null {
  const sepIndex = args.search(/[=→]/);
  if (sepIndex === -1) return null;
  const pattern = args.slice(0, sepIndex).trim();
  const categoryQuery = args.slice(sepIndex + 1).trim();
  if (!pattern || !categoryQuery) return null;
  return { pattern, categoryQuery };
}

export const MENU_PAGE_SIZE = 8;

/**
 * Every button's `callback_data`, regardless of screen. Kept short and
 * numeric on purpose: Telegram caps `callback_data` at 64 BYTES, and a
 * button that carried a real activity/category id (or two) would eat most
 * of that budget on its own — `MENU_PAGE_SIZE` rows of long bank
 * descriptors plus a decent-sized category tree would blow it instantly.
 * Indexing into `session.buttons` instead means the token's size is fixed
 * by how many buttons exist on ONE screen (never more than a few dozen),
 * not by the length of anything a user or a bank ever typed.
 */
export const MENU_CALLBACK_PREFIX = 'cz:';

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-08-08` → `Aug 8`. Pure string slicing — deliberately NOT
 *  `new Date(...)`, unlike ./telegram.ts's own `shortDate`: this module is
 *  the menu's pure core and must not depend on the host's clock or on
 *  timezone-sensitive `Date` parsing at all, only on the digits already in
 *  the string. */
function shortDate(isoDate: string): string {
  const [, monthStr, dayStr] = isoDate.slice(0, 10).split('-');
  const month = MONTHS_SHORT[Number(monthStr) - 1] ?? monthStr;
  return `${month} ${Number(dayStr)}`;
}

function findTxn(session: MenuSession, activityId: string): CategorizeTxn | undefined {
  return session.txns.find((t) => t.activityId === activityId);
}

function findCategory(session: MenuSession, categoryId: string): SpendingCategory | undefined {
  return session.categories.find((c) => c.id === categoryId);
}

/** Sentence shown when a screen refers to a transaction or category id that
 *  has since vanished from the session's fresh data — most commonly a row
 *  someone else finished categorizing (from another chat, or a rule import)
 *  while this one sat on screen. Rendering the list instead of throwing
 *  means a stale message can never crash the bot; the sentence tells the
 *  reader why they landed back at the top instead of where they tapped. */
const GONE_NOTE = 'That transaction is no longer uncategorized.';

// A keyboard button paired with the action it fires — the layout-neutral
// unit every screen builds, before `layout` turns it into an
// InlineKeyboard + a parallel MenuAction[] addressed by index.
interface Btn {
  text: string;
  action: MenuAction;
}

interface RenderResult {
  text: string;
  keyboard: InlineKeyboard;
  buttons: MenuAction[];
}

/** Turns rows of `Btn` into Telegram's keyboard shape plus the `buttons`
 *  array `applyTap` resolves indices against. Button LABELS are plain text —
 *  Telegram does not Markdown-parse them — so, matching `buildDismissKeyboard`
 *  in ./telegram.ts, they are not run through `escapeMarkdown`; only the
 *  message `text` (which IS Markdown-parsed) needs that treatment. */
function layout(rows: Btn[][]): { keyboard: InlineKeyboard; buttons: MenuAction[] } {
  const buttons: MenuAction[] = [];
  const inline_keyboard = rows.map((row) =>
    row.map((btn) => {
      const index = buttons.length;
      buttons.push(btn.action);
      return { text: btn.text, callback_data: `${MENU_CALLBACK_PREFIX}${index}` };
    }),
  );
  return { keyboard: { inline_keyboard }, buttons };
}

function finish(text: string, rows: Btn[][]): RenderResult {
  const { keyboard, buttons } = layout(rows);
  return { text, keyboard, buttons };
}

const DONE_BTN: Btn = { text: 'Done', action: { kind: 'close' } };
const BACK_TO_LIST_BTN: Btn = { text: 'Back to list', action: { kind: 'goto', screen: { kind: 'list', page: 0 } } };

function pairUp<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}

function renderList(session: MenuSession, page: number, note?: string): RenderResult {
  const prefix = note ? `${note}\n\n` : '';
  const { txns } = session;

  if (txns.length === 0) {
    return finish(`${prefix}Nothing needs a category right now.`, [[DONE_BTN]]);
  }

  const start = page * MENU_PAGE_SIZE;
  const pageTxns = txns.slice(start, start + MENU_PAGE_SIZE);
  const hasPrev = page > 0;
  const hasNext = start + MENU_PAGE_SIZE < txns.length;

  const rows: Btn[][] = pageTxns.map((t) => [{
    // Label only — never Markdown-parsed, so the raw description is fine here
    // (see `layout`'s doc comment). moneyWhole takes DOLLARS, so cents are
    // divided down first, and it keeps the sign deliberately (see its doc
    // comment in ./telegram.ts) — a spend reads as `-$10` here, not `$10`.
    text: `${shortDate(t.date)} · ${t.description} · ${moneyWhole(t.amountCents / 100)}`,
    action: { kind: 'goto', screen: { kind: 'txn', activityId: t.activityId } },
  }]);

  const navRow: Btn[] = [];
  if (hasPrev) navRow.push({ text: '« Prev', action: { kind: 'goto', screen: { kind: 'list', page: page - 1 } } });
  if (hasNext) navRow.push({ text: 'More »', action: { kind: 'goto', screen: { kind: 'list', page: page + 1 } } });
  if (navRow.length > 0) rows.push(navRow);

  rows.push([DONE_BTN]);

  const count = txns.length;
  const text = `${prefix}${count} transaction${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} a category:`;
  return finish(text, rows);
}

function renderTxn(session: MenuSession, activityId: string): RenderResult {
  const txn = findTxn(session, activityId);
  if (!txn) return renderList(session, 0, GONE_NOTE);

  const parents = session.categories.filter((c) => c.parentId === null);
  const catButtons: Btn[] = parents.map((c) => {
    const hasChildren = session.categories.some((k) => k.parentId === c.id);
    const action: MenuAction = hasChildren
      ? { kind: 'goto', screen: { kind: 'subcats', activityId, parentId: c.id } }
      : { kind: 'assign', activityId, categoryId: c.id };
    return { text: c.name, action };
  });

  const rows: Btn[][] = [
    ...pairUp(catButtons),
    [{ text: 'Keep uncategorized', action: { kind: 'dismiss', activityId } }],
    [{ text: '« Back', action: { kind: 'goto', screen: { kind: 'list', page: 0 } } }],
  ];

  // Text IS Markdown-parsed, unlike button labels, so every interpolated
  // field here goes through escapeMarkdown — card-network descriptors and
  // Wealthfolio account names both routinely carry `_`/`*`.
  const text = [
    escapeMarkdown(txn.description),
    `${moneyWhole(txn.amountCents / 100)} · ${shortDate(txn.date)} · ${escapeMarkdown(txn.accountName)}`,
  ].join('\n');

  return finish(text, rows);
}

function renderSubcats(session: MenuSession, activityId: string, parentId: string): RenderResult {
  const txn = findTxn(session, activityId);
  const parent = findCategory(session, parentId);
  if (!txn || !parent) return renderList(session, 0, GONE_NOTE);

  const children = session.categories.filter((c) => c.parentId === parentId);
  const childButtons: Btn[] = children.map((c) => ({
    text: c.name,
    action: { kind: 'assign', activityId, categoryId: c.id },
  }));

  const rows: Btn[][] = [
    ...childButtons.map((b) => [b]),
    [{ text: `Just ${parent.name} itself`, action: { kind: 'assign', activityId, categoryId: parent.id } }],
    [{ text: '« Back', action: { kind: 'goto', screen: { kind: 'txn', activityId } } }],
  ];

  const text = `Choose a subcategory of ${escapeMarkdown(parent.name)}:`;
  return finish(text, rows);
}

function renderFiled(
  session: MenuSession,
  screen: Extract<MenuScreen, { kind: 'filed' }>,
): RenderResult {
  const txn = findTxn(session, screen.activityId);
  const category = findCategory(session, screen.categoryId);
  if (!txn || !category) return renderList(session, 0, GONE_NOTE);

  if (screen.undone) {
    const text = `Filing undone — ${escapeMarkdown(txn.description)} is uncategorized again.`;
    return finish(text, [[BACK_TO_LIST_BTN], [DONE_BTN]]);
  }

  const text = `Filed ${escapeMarkdown(txn.description)} → ${escapeMarkdown(category.name)}.`;
  const rows: Btn[][] = [
    [{ text: 'Undo', action: { kind: 'unassign', activityId: screen.activityId, categoryId: screen.categoryId } }],
    [{
      text: 'Make this a rule',
      action: {
        kind: 'goto',
        screen: { kind: 'rulePreview', activityId: screen.activityId, categoryId: screen.categoryId },
      },
    }],
    [{ text: 'Next transaction', action: { kind: 'goto', screen: { kind: 'list', page: 0 } } }],
    [DONE_BTN],
  ];
  return finish(text, rows);
}

function renderDismissed(
  session: MenuSession,
  screen: Extract<MenuScreen, { kind: 'dismissed' }>,
): RenderResult {
  const txn = findTxn(session, screen.activityId);
  if (!txn) return renderList(session, 0, GONE_NOTE);

  if (screen.undone) {
    const text = `Dismissal undone — ${escapeMarkdown(txn.description)} is uncategorized again.`;
    return finish(text, [[BACK_TO_LIST_BTN], [DONE_BTN]]);
  }

  const text = `${escapeMarkdown(txn.description)} will stay uncategorized.`;
  const rows: Btn[][] = [
    [{ text: 'Undo', action: { kind: 'undismiss', activityId: screen.activityId } }],
    [BACK_TO_LIST_BTN],
    [DONE_BTN],
  ];
  return finish(text, rows);
}

/** Copy shared verbatim by `rulePreview` (a description-matched rule) and
 *  `freeRulePreview` (a typed pattern via `/newrule`) — the two differ only
 *  in what fills the quoted blank, so the sentence lives in one place to
 *  keep them from drifting apart. EXACT wording, locked by the spec. */
function ruleCopy(patternLabel: string, categoryName: string): string {
  return (
    'Create this rule?\n'
    + `Descriptions containing "${patternLabel}" → ${categoryName}\n`
    + 'It will also file any other uncategorized transactions that match, now and on every future import. '
    + 'Already-categorized transactions are never touched.'
  );
}

function renderRulePreview(session: MenuSession, activityId: string, categoryId: string): RenderResult {
  const txn = findTxn(session, activityId);
  const category = findCategory(session, categoryId);
  if (!txn || !category) return renderList(session, 0, GONE_NOTE);

  const text = ruleCopy(escapeMarkdown(txn.description), escapeMarkdown(category.name));
  const rows: Btn[][] = [
    [{ text: 'Create rule', action: { kind: 'createRule', activityId, categoryId } }],
    [{ text: '« Back', action: { kind: 'goto', screen: { kind: 'txn', activityId } } }],
  ];
  return finish(text, rows);
}

function renderFreeRulePreview(session: MenuSession, pattern: string, categoryId: string): RenderResult {
  const category = findCategory(session, categoryId);
  if (!category) return renderList(session, 0, GONE_NOTE);

  const text = ruleCopy(escapeMarkdown(pattern), escapeMarkdown(category.name));
  // No « Back: this screen is reachable only from /newrule, a free-standing
  // command with no prior menu screen to return to. Cancel closes instead.
  const rows: Btn[][] = [
    [{ text: 'Create rule', action: { kind: 'createFreeRule', pattern, categoryId } }],
    [{ text: 'Cancel', action: { kind: 'close' } }],
  ];
  return finish(text, rows);
}

function renderRuleCreated(session: MenuSession, activityId: string | null, categoryId: string): RenderResult {
  const category = findCategory(session, categoryId);
  if (!category) return renderList(session, 0, GONE_NOTE);

  const text = `Rule created — future matches will file automatically under ${escapeMarkdown(category.name)}.`;
  // Only Done from /newrule (activityId: null): there is no in-flight
  // transaction to return to the list FOR, since this path never showed one.
  const rows: Btn[][] = activityId !== null ? [[BACK_TO_LIST_BTN], [DONE_BTN]] : [[DONE_BTN]];
  return finish(text, rows);
}

function renderClosed(): RenderResult {
  return finish('Menu closed.', []);
}

/**
 * Renders the current screen to Telegram-ready text + keyboard, and returns
 * the `buttons` array the caller must store back onto `session.buttons`
 * before the next tap can be resolved (see `applyTap`).
 *
 * Every screen that names a transaction or category id looks it up in
 * `session.txns`/`session.categories` rather than trusting the id blindly —
 * see `GONE_NOTE`'s doc comment for why, and note this means a `filed` /
 * `dismissed` / `ruleCreated` confirmation screen needs its own row's data
 * to still be present in the session the caller passes in, even though a
 * genuinely fresh sweep would have already filtered it out.
 */
export function renderScreen(session: MenuSession): RenderResult {
  const screen = session.screen;
  switch (screen.kind) {
    case 'list':
      return renderList(session, screen.page);
    case 'txn':
      return renderTxn(session, screen.activityId);
    case 'subcats':
      return renderSubcats(session, screen.activityId, screen.parentId);
    case 'filed':
      return renderFiled(session, screen);
    case 'dismissed':
      return renderDismissed(session, screen);
    case 'rulePreview':
      return renderRulePreview(session, screen.activityId, screen.categoryId);
    case 'freeRulePreview':
      return renderFreeRulePreview(session, screen.pattern, screen.categoryId);
    case 'ruleCreated':
      return renderRuleCreated(session, screen.activityId, screen.categoryId);
    case 'closed':
      return renderClosed();
  }
}

/**
 * Resolves a tapped button's `callback_data` back to the `MenuAction` it
 * represents — but ONLY against `session.buttons`, the array `renderScreen`
 * produced for the CURRENT screen. That is what makes a tap on a stale
 * Telegram message safe: `session.buttons` is replaced wholesale on every
 * render, so an old message's index either falls outside the current array
 * (→ `expired`) or resolves to whatever now sits at that position on the
 * CURRENT screen — never to the row the old message actually showed. Callers
 * (the controller, a later task) are expected to re-read fresh data and
 * re-render rather than trust a tap's implied state, which is exactly why
 * this function's contract stops at "resolve the index or say why not".
 *
 * Two distinct failure reasons: `unknown` for anything that isn't even a
 * `cz:<digits>` token (wrong prefix, or garbage after it — not a menu tap at
 * all, e.g. the unrelated `d:<activityId>` dismiss buttons from the import
 * notice in ./telegram.ts), and `expired` for a well-formed token whose
 * index no longer exists in the current render (a stale message from a
 * screen that has since moved on).
 */
export function applyTap(
  session: MenuSession,
  callbackData: string,
): { ok: true; action: MenuAction } | { ok: false; reason: 'expired' | 'unknown' } {
  if (!callbackData.startsWith(MENU_CALLBACK_PREFIX)) return { ok: false, reason: 'unknown' };
  const indexPart = callbackData.slice(MENU_CALLBACK_PREFIX.length);
  if (!/^\d+$/.test(indexPart)) return { ok: false, reason: 'unknown' };
  const index = Number(indexPart);
  if (index >= session.buttons.length) return { ok: false, reason: 'expired' };
  return { ok: true, action: session.buttons[index] };
}
