/**
 * companion/src/budgets-menu.ts
 *
 * `/budgets` (project 4, G3–G5): suggested default monthly budgets for the
 * categories with none, from the last 3 full months, applied from Telegram —
 * the add-on cannot (its SDK has no budget API). STATELESS like audit-menu.ts:
 * every tap re-reads, and every button carries what it needs. After `cz:bg:`:
 *   m                         the list again, every suggestion picked
 *   t<fp><handle><mask>       toggle one category, in place
 *   s<fp><mask>               apply the categories in `mask`, in place
 * `<fp>` is `findingHandle` of this month and the candidates (id and amount):
 * a list whose spending changed since is shown again rather than applied.
 * `<handle>` is `findingHandle` of the category id. `<mask>` is lowercase hex,
 * one bit per candidate in `suggestBudgets` order (at most 24 bits), so the
 * longest button is 29 bytes. The mask indexes CANDIDATES, not what was
 * shown: a category that gained a budget between the list and Apply is still
 * chosen, re-read, and left alone ("Already has a budget — left alone.").
 * Nothing else may start with `cz:bg`.
 *
 * Category names and Wealthfolio's error text are escaped AND kept outside
 * every `*…*`; the only entities are the two fixed headings. Button labels are
 * plain text, not escaped. No emoji: ✓ marks what is picked or set.
 */
import {
  budgetDollars, suggestionLine, windowLabel, BUDGET_MAX_CANDIDATES,
  type BudgetSuggestion, type BudgetSuggestions,
} from '../../shared/budget-suggest.js';
import { findingHandle } from '../../shared/handle.js';
import { escapeMarkdown, type InlineKeyboard } from '../../shared/telegram.js';
import {
  applyBudgetSuggestions, readBudgetSuggestions, type BudgetApplyOutcome, type BudgetApplyResult, type BudgetReaders,
  type BudgetReadFailure, type BudgetSuggestRead,
} from './budget-suggest-host.js';

export const BUDGETS_CALLBACK_PREFIX = 'cz:bg:';
export const BUDGETS_TITLE = 'Suggested budgets';
export const BUDGETS_RESULT_TITLE = 'Budgets';
export const budgetsIntro = (window: readonly string[]) =>
  `Your average monthly spending for ${windowLabel(window)}, rounded up to the nearest $5, for each category with no budget yet. Each becomes a default monthly budget in Wealthfolio.`;
export const BUDGETS_HINT = 'Tap a category to leave it out.';
export const BUDGETS_ALL_SET = 'Every category you spend on already has a budget (a $0 budget counts) — nothing to suggest.';
export const BUDGETS_NOT_ENOUGH_HISTORY = "Your ledger doesn't cover a full month yet — send /budgets again next month.";
export const BUDGETS_NO_HISTORY = 'Nothing to suggest yet: no category averaged $10 or more a month over the full months your ledger covers (of the last 3).';
export const BUDGETS_DATABASE = "Couldn't read your spending from Wealthfolio's database — try again.";
export const BUDGETS_SPENDING_OFF = "Wealthfolio's Spending tracker is off, so it has no budgets — turn it on in Wealthfolio first.";
export const BUDGETS_UNREADABLE_SHOW = "Couldn't read your budgets — try again.";
export const BUDGETS_UNREADABLE = "Couldn't read your budgets — nothing was set.";
export const BUDGETS_ALREADY = 'Already has a budget — left alone.';
export const BUDGETS_CHANGED = 'Your spending changed since that list — here it is again.';
export const BUDGETS_PICK_ONE = 'Pick at least one first.';
export const BUDGETS_UNDO_HINT = 'Undo any of these from /changes.';
export const BUDGETS_RETRY_HINT = 'Send /budgets again to try the rest.';
const FAILED_ANSWER = 'Could not do that — check the companion logs.';

type Button = { text: string; callback_data: string };
export interface MenuScreen { text: string; keyboard: InlineKeyboard }

export type BudgetsView =
  | { kind: 'list' }
  | { kind: 'toggle'; fp: string; handle: string; mask: number }
  | { kind: 'apply'; fp: string; mask: number };

export function budgetsData(view: BudgetsView): string {
  switch (view.kind) {
    case 'list': return `${BUDGETS_CALLBACK_PREFIX}m`;
    case 'toggle': return `${BUDGETS_CALLBACK_PREFIX}t${view.fp}${view.handle}${view.mask.toString(16)}`;
    case 'apply': return `${BUDGETS_CALLBACK_PREFIX}s${view.fp}${view.mask.toString(16)}`;
  }
}

/** The view a button carries, or null for anything this menu never emitted. */
export function parseBudgetsData(data: string): BudgetsView | null {
  if (!data.startsWith(BUDGETS_CALLBACK_PREFIX)) return null;
  const s = data.slice(BUDGETS_CALLBACK_PREFIX.length);
  if (s === 'm') return { kind: 'list' };
  const t = /^t([0-9a-f]{8})([0-9a-f]{8})([0-9a-f]{1,6})$/.exec(s);
  if (t) return { kind: 'toggle', fp: t[1], handle: t[2], mask: parseInt(t[3], 16) };
  const a = /^s([0-9a-f]{8})([0-9a-f]{1,6})$/.exec(s);
  if (a) return { kind: 'apply', fp: a[1], mask: parseInt(a[2], 16) };
  return null;
}

/** What a button's mask was drawn against: this month and every candidate's id and amount. */
export function budgetsFingerprint(s: BudgetSuggestions): string {
  return findingHandle(`${s.month}|${s.candidates.map((c) => `${c.categoryId}=${c.cents}`).join('|')}`);
}

const bit = (i: number) => 2 ** i;
const has = (mask: number, i: number) => Math.floor(mask / bit(i)) % 2 === 1;
/** The candidates offered (no budget yet), as bits. */
export function shownMask(s: BudgetSuggestions): number {
  const shown = new Set(s.suggestions.map((x) => x.categoryId));
  return s.candidates.reduce((m, c, i) => (shown.has(c.categoryId) ? m + bit(i) : m), 0);
}
const count = (mask: number, n: number) => Array.from({ length: n }, (_, i) => i).filter((i) => has(mask, i)).length;

const clip = (s: string, n: number) => {
  const chars = Array.from(s);
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s;
};

/** The list: every suggestion, a toggle each, Apply all and (when some are left out) Apply selected. */
export function renderBudgetList(s: BudgetSuggestions, selected: number, notice?: string): MenuScreen {
  const head = [`*${BUDGETS_TITLE}*`, ...(notice ? [escapeMarkdown(notice)] : [])];
  if (s.suggestions.length === 0) {
    const why = s.notEnoughHistory ? BUDGETS_NOT_ENOUGH_HISTORY : s.candidates.length ? BUDGETS_ALL_SET : BUDGETS_NO_HISTORY;
    return { text: [...head, why].join('\n'), keyboard: { inline_keyboard: [] } };
  }
  const shown = shownMask(s);
  const picked = selected % bit(BUDGET_MAX_CANDIDATES);
  const fp = budgetsFingerprint(s);
  const rows: Button[][] = [];
  s.candidates.forEach((c, i) => {
    if (!has(shown, i)) return;
    const on = has(picked, i);
    rows.push([{
      text: `${on ? '✓ ' : ''}${clip(c.name, 32)} ${budgetDollars(c.cents)}${on ? '' : ' — left out'}`,
      callback_data: budgetsData({ kind: 'toggle', fp, handle: findingHandle(c.categoryId), mask: picked }),
    }]);
  });
  const all = count(shown, s.candidates.length);
  const some = count(picked, s.candidates.length);
  const apply: Button[] = [{ text: `Apply all (${all})`, callback_data: budgetsData({ kind: 'apply', fp, mask: shown }) }];
  if (some > 0 && some < all) apply.push({ text: `Apply selected (${some})`, callback_data: budgetsData({ kind: 'apply', fp, mask: picked }) });
  rows.push(apply);
  const list = suggestionLine(s.suggestions.map((x) => ({ ...x, name: escapeMarkdown(x.name) })));
  return {
    text: [...head, escapeMarkdown(budgetsIntro(s.monthsUsed)), '', list, '', BUDGETS_HINT].join('\n'),
    keyboard: { inline_keyboard: rows },
  };
}

/** What Apply did, category by category. */
export function renderBudgetResult(o: BudgetApplyOutcome): string {
  const name = (x: BudgetSuggestion) => escapeMarkdown(x.name);
  const lines = [
    `*${BUDGETS_RESULT_TITLE}*`,
    // A null target (written, reply named none) or a non-finite amount shows what was sent.
    ...o.set.map(({ suggestion, target }) => `✓ ${name(suggestion)}: ${budgetDollars(target && Number.isFinite(target.amountCents) ? target.amountCents : suggestion.cents)} a month`),
    ...o.alreadySet.map((x) => `${name(x)}: ${BUDGETS_ALREADY}`),
    ...o.failed.map(({ suggestion, message }) => `${name(suggestion)}: couldn't set it — ${escapeMarkdown(message)}`),
  ];
  const tail = [...(o.set.length ? [BUDGETS_UNDO_HINT] : []), ...(o.failed.length ? [BUDGETS_RETRY_HINT] : [])];
  return (tail.length ? [...lines, '', ...tail] : lines).join('\n');
}

const READ_FAILURE: Record<BudgetReadFailure, string> = {
  database: BUDGETS_DATABASE,
  'spending-off': BUDGETS_SPENDING_OFF,
  budgets: BUDGETS_UNREADABLE_SHOW,
};

type Send = (text: string, keyboard?: InlineKeyboard) => Promise<void>;

export interface BudgetsMenuUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
  send: Send;
}

/** What one tap reads and writes, live. */
export interface BudgetsMenuDeps {
  read(now: Date): Promise<BudgetSuggestRead>;
  apply(chosen: BudgetSuggestion[], at: { month: string; monthsUsed: string[] }, now: Date): Promise<BudgetApplyResult>;
  now(): Date;
  log(msg: string): void;
}

/** The deps over the companion's real readers (budget-suggest-host.ts). */
export function budgetsMenuDeps(readers: BudgetReaders, log: (msg: string) => void): BudgetsMenuDeps {
  return {
    read: (now) => readBudgetSuggestions(readers, now),
    apply: (chosen, at, now) => applyBudgetSuggestions(readers, chosen, at, now),
    now: () => new Date(),
    log,
  };
}

export interface BudgetsMenu {
  handles(data: string): boolean;
  onCallback(cb: { data: string }, ui: BudgetsMenuUi): Promise<void>;
  /** `/budgets`: the list, as a reply. */
  reply(send: Send): Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** An empty keyboard is sent as none. */
const sendScreen = (send: Send, s: MenuScreen) => (s.keyboard.inline_keyboard.length ? send(s.text, s.keyboard) : send(s.text));
const editScreen = (ui: BudgetsMenuUi, s: MenuScreen) => (s.keyboard.inline_keyboard.length ? ui.edit(s.text, s.keyboard) : ui.edit(s.text));

export function createBudgetsMenu(deps: BudgetsMenuDeps): BudgetsMenu {
  return {
    handles(data) {
      return data.startsWith(BUDGETS_CALLBACK_PREFIX);
    },

    async reply(send) {
      const read = await deps.read(deps.now());
      if (!read.ok) return void await send(escapeMarkdown(READ_FAILURE[read.reason]));
      await sendScreen(send, renderBudgetList(read.result, shownMask(read.result)));
    },

    async onCallback(cb, ui) {
      try {
        const view = parseBudgetsData(cb.data);
        if (!view) return void await ui.answer();
        if (view.kind === 'apply' && view.mask === 0) return void await ui.answer(BUDGETS_PICK_ONE);
        const now = deps.now();
        const read = await deps.read(now);
        if (!read.ok) {
          // Before Apply has written anything: say so in place, with a way to retry.
          const text = view.kind === 'apply' && read.reason === 'budgets' ? BUDGETS_UNREADABLE : READ_FAILURE[read.reason];
          await ui.edit(`*${BUDGETS_TITLE}*\n${escapeMarkdown(text)}`, { inline_keyboard: [[{ text: 'Try again', callback_data: cb.data }]] });
          return void await ui.answer();
        }
        const s = read.result;
        if (view.kind === 'list') {
          await editScreen(ui, renderBudgetList(s, shownMask(s)));
          return void await ui.answer();
        }
        if (view.fp !== budgetsFingerprint(s)) {
          await editScreen(ui, renderBudgetList(s, shownMask(s), BUDGETS_CHANGED));
          return void await ui.answer();
        }
        if (view.kind === 'toggle') {
          const i = s.candidates.findIndex((c) => findingHandle(c.categoryId) === view.handle);
          const mask = i < 0 ? view.mask : has(view.mask, i) ? view.mask - bit(i) : view.mask + bit(i);
          await editScreen(ui, renderBudgetList(s, mask));
          return void await ui.answer();
        }
        const chosen = s.candidates.filter((_, i) => has(view.mask, i));
        const result = await deps.apply(chosen, { month: s.month, monthsUsed: s.monthsUsed }, now);
        if (!result.ok) {
          await ui.edit(`*${BUDGETS_TITLE}*\n${escapeMarkdown(BUDGETS_UNREADABLE)}`, { inline_keyboard: [[{ text: 'Try again', callback_data: cb.data }]] });
          return void await ui.answer();
        }
        await ui.edit(renderBudgetResult(result.outcome));
        await ui.answer();
      } catch (err) {
        deps.log(`Budgets menu: ${cb.data} failed: ${message(err)}`);
        await ui.answer(FAILED_ANSWER).catch(() => {});
      }
    },
  };
}
