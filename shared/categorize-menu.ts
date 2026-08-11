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
  /** Present in recategorize mode: the category this transaction is CURRENTLY
   *  filed under, before any tap on this render. Serves two purposes — the
   *  ` · <name>` suffix on its list row, and the "old" half of the `refiled`
   *  confirmation's `undoReassign` action (`toRestore`) — which is why it
   *  carries the taxonomy/category ids and not just a display name: the name
   *  alone (as `refiled.fromName` is) is enough to render text, but undoing a
   *  reassignment needs somewhere real to put the transaction back. Absent in
   *  categorize mode, where nothing is filed yet. */
  currentCategory?: { taxonomyId: string; categoryId: string; name: string };
}

/** One node of Wealthfolio's spending category tree. `parentId === null`
 *  marks a top-level category — the menu's parent filter, so a reader that
 *  hands back `''` for a NULL parent (the sqlite3-CLI fallback does) empties
 *  the whole category picker. `parentName` is what `categoryDisplayName` shows
 *  on the rule screens, where two same-named children are otherwise
 *  indistinguishable. */
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
  | { kind: 'closed' }
  /** The recategorize confirmation. `fromName` (not an id) is what the row
   *  showed BEFORE the tap, because it may name an income-side category that
   *  never appears in `session.categories` (the spending tree) — the whole
   *  reason `crossTaxonomy` exists as its own flag rather than something
   *  derivable by looking the old category up. `toCategoryId` IS looked up,
   *  same as `filed.categoryId`, since the new category is always a spending
   *  category and always in that list. */
  | { kind: 'refiled'; activityId: string; fromName: string; toCategoryId: string; crossTaxonomy: boolean; undone: boolean };

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
  /**
   * Which render these `buttons` belong to. Every emitted `callback_data`
   * carries it (`cz:<generation>:<index>`), and `applyTap` refuses any token
   * whose generation is not the current one — BEFORE it resolves the index.
   *
   * Replacing `buttons` wholesale is NOT enough on its own, and that gap was a
   * real defect: two renders of the same SHAPE (two category pickers, say) have
   * identical button layouts and different `activityId`s, so an index from the
   * older message resolves position-for-position against the newer screen and
   * files a transaction the user never tapped — a wrong write to a financial
   * record, invisible to any freshness check, because the row it lands on
   * genuinely is uncategorized. Out-of-range indices were the only stale taps
   * the index alone could catch.
   *
   * Assigning it is the CONTROLLER's job (`companion/src/categorize.ts` stamps a
   * strictly increasing counter onto the session every time it emits a
   * keyboard, and that counter outlives any one session, so reopening the menu
   * cannot reissue a generation an older message still holds). This module only
   * reads it: it is pure, and a counter it incremented itself would make
   * rendering the same screen twice produce two different keyboards.
   */
  generation: number;
  /** `categorize` files an UNcategorized transaction (the long-standing
   *  behaviour); `recategorize` moves an ALREADY-filed one to a different
   *  category. The two share every screen and every code path down to the
   *  category picker itself — this flag is read at the handful of places
   *  that differ (the list's row label and header, the txn screen's "Keep
   *  uncategorized" button, and which MenuAction a category tap emits) rather
   *  than the controller building two parallel menus, so those two flows
   *  cannot drift apart the way a copy-pasted module would let them.
   *
   * Optional, and every read of it treats a missing value as `'categorize'`:
   * the controller's existing session-building call sites (this task does not
   * touch `companion/`, wiring is a later task) predate this field and do not
   * set it, so making it required would fail their build the moment this file
   * changed underneath them for a mode they never asked for. */
  mode?: 'categorize' | 'recategorize';
}

export type MenuAction =
  | { kind: 'goto'; screen: MenuScreen }
  | { kind: 'assign'; activityId: string; categoryId: string }
  | { kind: 'unassign'; activityId: string; categoryId: string }
  | { kind: 'dismiss'; activityId: string }
  | { kind: 'undismiss'; activityId: string }
  | { kind: 'createRule'; activityId: string; categoryId: string }
  | { kind: 'createFreeRule'; pattern: string; categoryId: string }
  | { kind: 'close' }
  /** `assign`'s recategorize-mode counterpart: files onto a transaction that
   *  already has a category, rather than one with none. A separate kind
   *  (rather than reusing `assign`) is what lets the controller tell "first
   *  filing" and "moving an existing filing" apart without inspecting the
   *  session's mode itself — the action alone says which happened. */
  | { kind: 'reassign'; activityId: string; categoryId: string }
  /** Undo for `reassign`: puts the transaction back on the category it held
   *  before the tap. Carries the FULL old category (taxonomy + id), not just
   *  the new category's id the way `unassign` does, because the old category
   *  may be on the income side of the ledger — outside the spending tree
   *  `unassign` implicitly restores to "no category in this tree" — so there
   *  is no id space the controller could look the restore target up in on
   *  its own. */
  | { kind: 'undoReassign'; activityId: string; toRestore: { taxonomyId: string; categoryId: string } };

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

/**
 * How a category is NAMED wherever naming the wrong one would be expensive:
 * `Restaurants (Food & Dining)` for a child, plain `Home` for a top-level
 * category.
 *
 * Wealthfolio's own preset tree ships duplicate leaf names — an `Other` under
 * several parents, a `Gas` under both Transportation and Bills — and
 * `/newrule`'s resolver matches on NAME over the FLAT tree. So a bare name on a
 * rule preview can describe two different categories while looking perfectly
 * correct, and confirming it writes a rule that sweeps every matching
 * uncategorized row into whichever one the resolver happened to reach first.
 * The parent is the cheapest thing that tells them apart, and it is already
 * read from SQLite (`parentName`) for exactly this.
 *
 * Takes the minimal shape rather than `SpendingCategory` so the budget-shaped
 * rows in ./telegram-commands.ts — which have no parent at all — can share it
 * and come out unchanged.
 */
export function categoryDisplayName(cat: { name: string; parentName?: string | null }): string {
  return cat.parentName ? `${cat.name} (${cat.parentName})` : cat.name;
}

export const MENU_PAGE_SIZE = 8;

/**
 * Every button's `callback_data`, regardless of screen: `cz:<generation>:<index>`.
 *
 * Kept short and numeric on purpose: Telegram caps `callback_data` at 64 BYTES,
 * and a button that carried a real activity/category id (or two) would eat most
 * of that budget on its own — `MENU_PAGE_SIZE` rows of long bank descriptors
 * plus a decent-sized category tree would blow it instantly. Indexing into
 * `session.buttons` instead means the token's size is fixed by how many buttons
 * exist on ONE screen (never more than a few dozen) and by the render count,
 * not by the length of anything a user or a bank ever typed. Two numbers plus
 * two separators leave the cap barely touched (a pinned test proves it).
 *
 * The generation half is what makes an index safe to trust at all — see
 * `MenuSession.generation`.
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

/** `GONE_NOTE`'s recategorize counterpart. `GONE_NOTE` says "no longer
 *  uncategorized" — true for the categorize flow, where a row that vanished
 *  from the sweep did so BY BECOMING categorized. On a recategorize screen
 *  that sentence is simply false: the transaction was never uncategorized,
 *  it had a category and the user was moving it to a different one. Reusing
 *  `GONE_NOTE` there would flatly contradict what the reader was just doing,
 *  so this states the same underlying fact — the menu refreshed and this row
 *  isn't where it expected — without invoking "uncategorized" at all. */
const RECATEGORIZE_GONE_NOTE = 'That transaction is no longer available to recategorize.';

/** A keyboard button paired with the action it fires — the layout-neutral
 *  unit every screen builds, before `layout` turns it into an
 *  InlineKeyboard + a parallel MenuAction[] addressed by index. Exported for
 *  `layoutScreen`, so a caller adding a screen of its own (the controller's
 *  error screens) cannot end up hand-writing the token format. */
export interface MenuButton {
  text: string;
  action: MenuAction;
}

type Btn = MenuButton;

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
function layout(generation: number, rows: Btn[][]): { keyboard: InlineKeyboard; buttons: MenuAction[] } {
  const buttons: MenuAction[] = [];
  const inline_keyboard = rows.map((row) =>
    row.map((btn) => {
      const index = buttons.length;
      buttons.push(btn.action);
      return { text: btn.text, callback_data: `${MENU_CALLBACK_PREFIX}${generation}:${index}` };
    }),
  );
  return { keyboard: { inline_keyboard }, buttons };
}

/**
 * The token format, for a caller that builds a screen this module does not know
 * about — today the controller's error screens, which the pure machine has no
 * notion of. Exported so that the `cz:<generation>:<index>` shape and the
 * `buttons` table it indexes into exist in exactly ONE place: a second
 * hand-rolled copy is how a change to the format (like adding the generation)
 * gets applied to some screens and not others.
 */
export function layoutScreen(
  generation: number,
  rows: MenuButton[][],
): { keyboard: InlineKeyboard; buttons: MenuAction[] } {
  return layout(generation, rows);
}

function finish(generation: number, text: string, rows: Btn[][]): RenderResult {
  const { keyboard, buttons } = layout(generation, rows);
  return { text, keyboard, buttons };
}

const DONE_BTN: Btn = { text: 'Done', action: { kind: 'close' } };
const BACK_TO_LIST_BTN: Btn = { text: 'Back to list', action: { kind: 'goto', screen: { kind: 'list', page: 0 } } };

function pairUp<T>(items: T[]): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
}

/**
 * The one place a category tap turns into an action, for BOTH modes. Called
 * from every spot that used to hand-write `{ kind: 'assign', ... }` — the txn
 * screen's childless-parent buttons, and the subcats screen's child and
 * "Just X itself" buttons. Keeping it here, branched on `mode`, is what a
 * copy of the whole category-picker block per mode would not give: the two
 * flows can add a category-tree feature (a new button shape, say) exactly
 * once and have it apply to both, instead of one of two copies quietly
 * falling behind.
 */
function assignAction(mode: MenuSession['mode'], activityId: string, categoryId: string): MenuAction {
  return mode === 'recategorize'
    ? { kind: 'reassign', activityId, categoryId }
    : { kind: 'assign', activityId, categoryId };
}

function renderList(session: MenuSession, page: number, note?: string): RenderResult {
  const prefix = note ? `${note}\n\n` : '';
  const { txns, mode } = session;

  if (txns.length === 0) {
    // Two different empty states for two different questions: "categorize"
    // asks whether anything is UNfiled (nothing needs attention), while
    // "recategorize" asks whether anything filed in the lookback window
    // MATCHES what was searched for — a filter can legitimately come up
    // empty even when plenty of transactions are categorized.
    const emptyText = mode === 'recategorize'
      ? 'Nothing categorized in the last 90 days matches.'
      : 'Nothing needs a category right now.';
    return finish(session.generation, `${prefix}${emptyText}`, [[DONE_BTN]]);
  }

  const start = page * MENU_PAGE_SIZE;
  const pageTxns = txns.slice(start, start + MENU_PAGE_SIZE);
  const hasPrev = page > 0;
  const hasNext = start + MENU_PAGE_SIZE < txns.length;

  const rows: Btn[][] = pageTxns.map((t) => {
    // Recategorize appends the current category so the list itself answers
    // "categorized as what" without a tap — label only, never Markdown-parsed
    // (see `layout`'s doc comment), so the raw name is fine unescaped here.
    const currentSuffix = mode === 'recategorize' && t.currentCategory ? ` · ${t.currentCategory.name}` : '';
    return [{
      // moneyWhole takes DOLLARS, so cents are divided down first, and it
      // keeps the sign deliberately (see its doc comment in ./telegram.ts) —
      // a spend reads as `-$10` here, not `$10`.
      text: `${shortDate(t.date)} · ${t.description} · ${moneyWhole(t.amountCents / 100)}${currentSuffix}`,
      action: { kind: 'goto', screen: { kind: 'txn', activityId: t.activityId } },
    }];
  });

  const navRow: Btn[] = [];
  if (hasPrev) navRow.push({ text: '« Prev', action: { kind: 'goto', screen: { kind: 'list', page: page - 1 } } });
  if (hasNext) navRow.push({ text: 'More »', action: { kind: 'goto', screen: { kind: 'list', page: page + 1 } } });
  if (navRow.length > 0) rows.push(navRow);

  rows.push([DONE_BTN]);

  const count = txns.length;
  // Recategorize has no natural count-based header — the caller already knows
  // roughly how much history it's searching, and "N transactions match" would
  // just repeat the row count sitting right below it — so it states the
  // screen's PURPOSE instead, fixed regardless of how many rows are showing.
  const text = mode === 'recategorize'
    ? `${prefix}Recategorize — tap a transaction`
    : `${prefix}${count} transaction${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} a category:`;
  return finish(session.generation, text, rows);
}

function renderTxn(session: MenuSession, activityId: string): RenderResult {
  const txn = findTxn(session, activityId);
  if (!txn) return renderList(session, 0, GONE_NOTE);

  const isRecategorize = session.mode === 'recategorize';

  const parents = session.categories.filter((c) => c.parentId === null);
  const catButtons: Btn[] = parents.map((c) => {
    const hasChildren = session.categories.some((k) => k.parentId === c.id);
    const action: MenuAction = hasChildren
      ? { kind: 'goto', screen: { kind: 'subcats', activityId, parentId: c.id } }
      : assignAction(session.mode, activityId, c.id);
    return { text: c.name, action };
  });

  const rows: Btn[][] = [
    ...pairUp(catButtons),
    // "Keep uncategorized" only makes sense before a first filing — a
    // recategorize is choosing among categories, not opting out of having
    // one, and the transaction already has one. The current category's OWN
    // button is deliberately still in the grid above, unfiltered: re-filing
    // to the same category is a harmless no-op for the controller to shrug
    // off, not a state this screen needs to special-case.
    ...(isRecategorize ? [] : [[{ text: 'Keep uncategorized', action: { kind: 'dismiss' as const, activityId } }]]),
    [{ text: '« Back', action: { kind: 'goto', screen: { kind: 'list', page: 0 } } }],
  ];

  // Text IS Markdown-parsed, unlike button labels, so every interpolated
  // field here goes through escapeMarkdown — card-network descriptors and
  // Wealthfolio account names both routinely carry `_`/`*`.
  const lines = [
    escapeMarkdown(txn.description),
    `${moneyWhole(txn.amountCents / 100)} · ${shortDate(txn.date)} · ${escapeMarkdown(txn.accountName)}`,
  ];
  if (isRecategorize && txn.currentCategory) {
    lines.push(`Currently: ${escapeMarkdown(txn.currentCategory.name)}`);
  }
  const text = lines.join('\n');

  return finish(session.generation, text, rows);
}

function renderSubcats(session: MenuSession, activityId: string, parentId: string): RenderResult {
  const txn = findTxn(session, activityId);
  const parent = findCategory(session, parentId);
  if (!txn || !parent) return renderList(session, 0, GONE_NOTE);

  const children = session.categories.filter((c) => c.parentId === parentId);
  const childButtons: Btn[] = children.map((c) => ({
    text: c.name,
    action: assignAction(session.mode, activityId, c.id),
  }));

  const rows: Btn[][] = [
    ...childButtons.map((b) => [b]),
    [{ text: `Just ${parent.name} itself`, action: assignAction(session.mode, activityId, parent.id) }],
    [{ text: '« Back', action: { kind: 'goto', screen: { kind: 'txn', activityId } } }],
  ];

  const text = `Choose a subcategory of ${escapeMarkdown(parent.name)}:`;
  return finish(session.generation, text, rows);
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
    return finish(session.generation, text, [[BACK_TO_LIST_BTN], [DONE_BTN]]);
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
  return finish(session.generation, text, rows);
}

function renderDismissed(
  session: MenuSession,
  screen: Extract<MenuScreen, { kind: 'dismissed' }>,
): RenderResult {
  const txn = findTxn(session, screen.activityId);
  if (!txn) return renderList(session, 0, GONE_NOTE);

  if (screen.undone) {
    const text = `Dismissal undone — ${escapeMarkdown(txn.description)} is uncategorized again.`;
    return finish(session.generation, text, [[BACK_TO_LIST_BTN], [DONE_BTN]]);
  }

  const text = `${escapeMarkdown(txn.description)} will stay uncategorized.`;
  const rows: Btn[][] = [
    [{ text: 'Undo', action: { kind: 'undismiss', activityId: screen.activityId } }],
    [BACK_TO_LIST_BTN],
    [DONE_BTN],
  ];
  return finish(session.generation, text, rows);
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

  const text = ruleCopy(escapeMarkdown(txn.description), escapeMarkdown(categoryDisplayName(category)));
  const rows: Btn[][] = [
    [{ text: 'Create rule', action: { kind: 'createRule', activityId, categoryId } }],
    [{ text: '« Back', action: { kind: 'goto', screen: { kind: 'txn', activityId } } }],
  ];
  return finish(session.generation, text, rows);
}

function renderFreeRulePreview(session: MenuSession, pattern: string, categoryId: string): RenderResult {
  const category = findCategory(session, categoryId);
  if (!category) return renderList(session, 0, GONE_NOTE);

  // `categoryDisplayName`, not the bare name: this screen is the ONLY thing
  // between a typed `/newrule x = other` and a rule against whichever `Other`
  // the flat-tree resolver reached first.
  const text = ruleCopy(escapeMarkdown(pattern), escapeMarkdown(categoryDisplayName(category)));
  // No « Back: this screen is reachable only from /newrule, a free-standing
  // command with no prior menu screen to return to. Cancel closes instead.
  const rows: Btn[][] = [
    [{ text: 'Create rule', action: { kind: 'createFreeRule', pattern, categoryId } }],
    [{ text: 'Cancel', action: { kind: 'close' } }],
  ];
  return finish(session.generation, text, rows);
}

function renderRuleCreated(session: MenuSession, activityId: string | null, categoryId: string): RenderResult {
  const category = findCategory(session, categoryId);
  if (!category) return renderList(session, 0, GONE_NOTE);

  const text = `Rule created — future matches will file automatically under ${escapeMarkdown(categoryDisplayName(category))}.`;
  // Only Done from /newrule (activityId: null): there is no in-flight
  // transaction to return to the list FOR, since this path never showed one.
  const rows: Btn[][] = activityId !== null ? [[BACK_TO_LIST_BTN], [DONE_BTN]] : [[DONE_BTN]];
  return finish(session.generation, text, rows);
}

/**
 * Confirms a `reassign`: `<description>: <old> → <new>.`, plus a warning line
 * when the move crosses taxonomies (spending ↔ income) — that crossing
 * changes what the number MEANS (an income entry stops counting as income and
 * starts offsetting a spending category instead), which is exactly the kind
 * of consequence a silent recategorize could leave the reader misreading
 * their own reports over.
 *
 * `txn.currentCategory` (not `screen.fromName` alone) has to still be present
 * for this to render: `fromName` is enough to WRITE the sentence, but the
 * Undo button needs somewhere with real ids to put the transaction back, and
 * `currentCategory` is the only place those ids live (see its doc comment).
 * Missing means the controller's fresh sweep no longer has this row at all —
 * the same staleness `GONE_NOTE`/`RECATEGORIZE_GONE_NOTE` exist for
 * everywhere else, with the recategorize-worded one used here since this
 * screen only ever renders mid-recategorize.
 */
function renderRefiled(
  session: MenuSession,
  screen: Extract<MenuScreen, { kind: 'refiled' }>,
): RenderResult {
  const txn = findTxn(session, screen.activityId);
  const toCategory = findCategory(session, screen.toCategoryId);
  if (!txn || !toCategory || !txn.currentCategory) {
    const note = session.mode === 'recategorize' ? RECATEGORIZE_GONE_NOTE : GONE_NOTE;
    return renderList(session, 0, note);
  }

  const toName = escapeMarkdown(toCategory.name);
  const fromName = escapeMarkdown(screen.fromName);

  if (screen.undone) {
    // Mirrors `filed`/`dismissed`'s "<X> undone — ..." shape, but the state
    // undoing returns to is the OLD category, not "uncategorized" — this
    // transaction was already filed before the reassign, so "uncategorized
    // again" would misstate what undo just did.
    const text = `Refiling undone — ${escapeMarkdown(txn.description)} is back under ${fromName}.`;
    return finish(session.generation, text, [[BACK_TO_LIST_BTN], [DONE_BTN]]);
  }

  const lines = [`${escapeMarkdown(txn.description)}: ${fromName} → ${toName}.`];
  if (screen.crossTaxonomy) {
    lines.push(`This payment now offsets ${toName} instead of counting as income.`);
  }

  const rows: Btn[][] = [
    [{
      text: 'Undo',
      action: {
        kind: 'undoReassign',
        activityId: screen.activityId,
        toRestore: { taxonomyId: txn.currentCategory.taxonomyId, categoryId: txn.currentCategory.categoryId },
      },
    }],
    // Same label as `filed`'s identical goto-list button — same action, same
    // position, no reason for the two screens to say it differently.
    [{ text: 'Next transaction', action: { kind: 'goto', screen: { kind: 'list', page: 0 } } }],
    [DONE_BTN],
  ];
  return finish(session.generation, lines.join('\n'), rows);
}

function renderClosed(generation: number): RenderResult {
  return finish(generation, 'Menu closed.', []);
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
    case 'refiled':
      return renderRefiled(session, screen);
    case 'closed':
      return renderClosed(session.generation);
  }
}

/**
 * Resolves a tapped button's `callback_data` back to the `MenuAction` it
 * represents — but ONLY when the token was minted by the session's CURRENT
 * render, and then only against `session.buttons`, the array that render
 * produced.
 *
 * The generation is checked FIRST, before the index is looked at, and that
 * order is the safety property. `session.buttons` is replaced wholesale on
 * every render, which catches a stale index that falls outside the new array —
 * but two renders of the same SHAPE (two category pickers, two pages of the
 * list) have arrays of the same LENGTH holding different ids, so an in-range
 * index from an older message would otherwise resolve position-for-position
 * against the current screen and act on a row the user never tapped. With the
 * generation, an old message's every button is `expired` no matter what now
 * sits at its index. See `MenuSession.generation`.
 *
 * Two distinct failure reasons, because the controller answers them
 * differently — "that menu expired, ask again" versus "that isn't a button I
 * issued, here is your screen again":
 *  - `expired`: a well-formed token from a render that has been superseded.
 *  - `unknown`: not a `cz:<generation>:<index>` token at all (a wrong prefix,
 *    e.g. the unrelated `d:<activityId>` dismiss buttons from the import notice
 *    in ./telegram.ts; the older single-number form; anything non-numeric), or
 *    an index the CURRENT render does not have — which nothing this module
 *    emitted can produce, so it is a payload from somewhere else rather than a
 *    menu that moved on.
 */
export function applyTap(
  session: MenuSession,
  callbackData: string,
): { ok: true; action: MenuAction } | { ok: false; reason: 'expired' | 'unknown' } {
  if (!callbackData.startsWith(MENU_CALLBACK_PREFIX)) return { ok: false, reason: 'unknown' };
  const token = /^(\d+):(\d+)$/.exec(callbackData.slice(MENU_CALLBACK_PREFIX.length));
  if (!token) return { ok: false, reason: 'unknown' };
  if (Number(token[1]) !== session.generation) return { ok: false, reason: 'expired' };
  const index = Number(token[2]);
  if (index >= session.buttons.length) return { ok: false, reason: 'unknown' };
  return { ok: true, action: session.buttons[index] };
}
