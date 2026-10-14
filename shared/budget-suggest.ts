/**
 * shared/budget-suggest.ts
 *
 * Suggested budgets (project 4, G3–G5), decided purely: from the spend matrix,
 * the category catalog, Wealthfolio's settings and its budget targets, which
 * categories to offer a default monthly budget for, and how much. The
 * companion gathers the facts (companion/src/budget-suggest-host.ts) and
 * `/budgets` offers them (companion/src/budgets-menu.ts); nothing here reads
 * or writes.
 *
 * The rules (spec C):
 *  - The window is the last 3 FULL calendar months before "this month", and
 *    "this month" is placed in Wealthfolio's timezone (`timezone` in its
 *    settings), so a New Year's Eve evening in New York is still December.
 *    Rows are bucketed by their stored date, as every report reads them.
 *  - Each spending category's three months are summed across every account,
 *    refunds netting out, and divided by 3 — a month with nothing counts as
 *    $0 — then rounded UP to the nearest $5.
 *  - Skipped, in this order (the first that applies is the reason):
 *    "Opening balances" (by name — it is excluded on 3.9+, and 3.8 has no
 *    exclusions); a name the catalog cannot place on exactly one top-level
 *    category (the matrix is keyed by the rolled-up NAME; budgets by id);
 *    excluded categories (`spending.excluded_category_ids`, descendants
 *    included via `excludedWithDescendants`); an average under $10; past the 24
 *    biggest (a Telegram keyboard's worth); and last, a category that already
 *    has a budget — a non-zero `'default'` target (a $0 default is
 *    Wealthfolio's cleared state, `isClearedDefault`) or any target for this
 *    month. Any other existing target is never overwritten: Wealthfolio's POST
 *    is an upsert.
 *  - `candidates` is everything but the last rule, biggest first (ties by
 *    name): what a `/budgets` button's bits index. `suggestions` is the
 *    candidates with no budget yet — what is offered.
 *
 * Which rows reach `spend` is the matrix read's job (Task 8): it leaves out
 * excluded subcategories and keeps to the spending accounts. Months the ledger
 * never covered are left out here (`historyStartDay`): a new install's first
 * sync fetches only 30 days, and averaging over empty months would understate.
 *
 * Category names are RAW here: Telegram escapes them when it renders.
 */
import { excludedWithDescendants } from './audit-headline.js';
import { OPENING_BALANCES_CATEGORY } from './sync-core.js';

export const BUDGET_TAXONOMY = 'spending_categories';
export const DEFAULT_PERIOD_KEY = 'default';
export const BUDGET_WINDOW_MONTHS = 3;
/** Categories averaging under $10 a month are not worth a budget. */
export const BUDGET_MIN_AVERAGE_CENTS = 1000;
export const BUDGET_ROUND_CENTS = 500;
/** One toggle per candidate fits a Telegram keyboard and a 24-bit mask. */
export const BUDGET_MAX_CANDIDATES = 24;

/** A Wealthfolio budget target (`BudgetSnapshot.state.targets[]`), amount in cents. */
export interface BudgetTarget {
  id: string;
  /** `'default'` or `'YYYY-MM'`. */
  periodKey: string;
  /** `'category'` or `'group_buffer'`. */
  targetType: string;
  taxonomyId: string | null;
  categoryId: string | null;
  amountCents: number;
}

/** One `getNativeSpendMatrix` row: signed dollars per (month, rolled-up category, account). */
export interface SpendMatrixRow { month: string; category: string; accountId: string; amount: number }

/** One spending category (`getNativeSpendingCategories`). */
export interface BudgetCategory { id: string; name: string; parentId: string | null }

export interface BudgetSuggestFacts {
  now: Date;
  /** Wealthfolio's timezone; null: the companion's own. */
  timezone: string | null;
  /** The window's spend matrix (`budgetWindow`'s start and end). */
  spend: SpendMatrixRow[];
  categories: BudgetCategory[];
  /** `spending.excluded_category_ids` ([] on 3.8). */
  excludedCategoryIds: string[];
  /** Each spending category's parent, so an excluded one's descendants count too. */
  categoryParents: Record<string, string | null>;
  /** Every budget target now. */
  targets: BudgetTarget[];
  /** The earliest activity day ('YYYY-MM-DD') on the spending accounts. A window
   *  month counts only if its first day is on or after it; absent: all count. */
  historyStartDay?: string | null;
}

export interface BudgetSuggestion {
  categoryId: string;
  name: string;
  /** The window's monthly average, cents. */
  averageCents: number;
  /** What is offered: the average rounded up to the nearest $5. */
  cents: number;
}

export type BudgetSkipReason = 'opening-balances' | 'unknown-category' | 'excluded' | 'under-minimum' | 'over-limit' | 'has-budget';

export interface BudgetSuggestions {
  /** This month, in Wealthfolio's timezone. */
  month: string;
  window: string[];
  /** The window months actually averaged (the ledger covers them whole). */
  monthsUsed: string[];
  /** True when no window month is covered: nothing is suggested. */
  notEnoughHistory: boolean;
  candidates: BudgetSuggestion[];
  suggestions: BudgetSuggestion[];
  /** Spending-alone skips by name, then over-limit and has-budget biggest first. */
  skipped: Array<{ name: string; reason: BudgetSkipReason }>;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM` of `now` in `timeZone`; null or a zone the runtime does not know:
 *  the process's own (the same fallback as `zonedMonthBounds`). */
export function zonedMonth(now: Date, timeZone: string | null): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(now);
      const year = parts.find((p) => p.type === 'year')?.value;
      const month = parts.find((p) => p.type === 'month')?.value;
      if (year && month) return `${year}-${month}`;
    } catch {
      /* an unknown zone: the process's own, below */
    }
  }
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

/** The 3 full months before this one, and the spend matrix's date bounds for them. */
export function budgetWindow(now: Date, timeZone: string | null): { month: string; window: string[]; start: string; endExclusive: string } {
  const month = zonedMonth(now, timeZone);
  const window = Array.from({ length: BUDGET_WINDOW_MONTHS }, (_, i) => addMonths(month, i - BUDGET_WINDOW_MONTHS));
  return { month, window, start: `${window[0]}-01`, endExclusive: `${month}-01` };
}

/** Takes UNROUNDED cents (an exact total ÷ months); never round before calling. */
export function roundUpToFiveDollars(cents: number): number {
  return Math.ceil(cents / BUDGET_ROUND_CENTS) * BUDGET_ROUND_CENTS;
}

/**
 * A `'default'` target of exactly $0 is Wealthfolio's cleared state (its editor saves a
 * cleared amount as "0" and cannot delete a default), so it counts as NO budget. An
 * unparseable amount (NaN) is not zero: it blocks.
 */
export function isClearedDefault(t: BudgetTarget): boolean {
  return t.periodKey === DEFAULT_PERIOD_KEY && t.amountCents === 0;
}

/** Whether the category has a budget this month: a non-zero `'default'` target or this month's (even $0). */
export function hasBudget(targets: readonly BudgetTarget[], categoryId: string, month: string): boolean {
  return targets.some((t) => t.targetType === 'category' && t.taxonomyId === BUDGET_TAXONOMY && t.categoryId === categoryId
    && ((t.periodKey === DEFAULT_PERIOD_KEY && !isClearedDefault(t)) || t.periodKey === month));
}

const byNameAsc = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const biggestFirst = (a: BudgetSuggestion, b: BudgetSuggestion) => b.cents - a.cents || byNameAsc(a, b);

export function suggestBudgets(f: BudgetSuggestFacts): BudgetSuggestions {
  const { month, window } = budgetWindow(f.now, f.timezone);
  const start = f.historyStartDay ?? null;
  const monthsUsed = window.filter((m) => start === null || `${m}-01` >= start);
  const n = monthsUsed.length;
  const inWindow = new Set(monthsUsed);
  const totals = new Map<string, number>();
  for (const row of f.spend) {
    if (!inWindow.has(row.month)) continue;
    totals.set(row.category, (totals.get(row.category) ?? 0) + Math.round(row.amount * 100));
  }
  const topLevel = new Map<string, string[]>();
  for (const c of f.categories) {
    if (c.parentId !== null) continue;
    topLevel.set(c.name, [...(topLevel.get(c.name) ?? []), c.id]);
  }
  const excluded = excludedWithDescendants(f.excludedCategoryIds, f.categoryParents);

  if (n === 0) return { month, window, monthsUsed, notEnoughHistory: true, candidates: [], suggestions: [], skipped: [] };

  const ruleSkips: Array<{ name: string; reason: BudgetSkipReason }> = [];
  const qualified: BudgetSuggestion[] = [];
  for (const [name, total] of totals) {
    const ids = topLevel.get(name) ?? [];
    let reason: BudgetSkipReason | null = null;
    if (name === OPENING_BALANCES_CATEGORY) reason = 'opening-balances';
    else if (ids.length !== 1) reason = 'unknown-category';
    else if (excluded.has(ids[0])) reason = 'excluded';
    else if (total < n * BUDGET_MIN_AVERAGE_CENTS) reason = 'under-minimum';
    if (reason) {
      ruleSkips.push({ name, reason });
      continue;
    }
    qualified.push({
      categoryId: ids[0],
      name,
      averageCents: Math.round(total / n),
      cents: roundUpToFiveDollars(total / n),
    });
  }
  qualified.sort(biggestFirst);
  const candidates = qualified.slice(0, BUDGET_MAX_CANDIDATES);
  const overLimit = qualified.slice(BUDGET_MAX_CANDIDATES).map((s) => ({ name: s.name, reason: 'over-limit' as const }));
  const suggestions = candidates.filter((s) => !hasBudget(f.targets, s.categoryId, month));
  const budgeted = candidates.filter((s) => hasBudget(f.targets, s.categoryId, month)).map((s) => ({ name: s.name, reason: 'has-budget' as const }));
  return { month, window, monthsUsed, notEnoughHistory: false, candidates, suggestions, skipped: [...ruleSkips.sort(byNameAsc), ...overLimit, ...budgeted] };
}

/**
 * Re-read before write: of the suggestions chosen when the list was shown,
 * which to write now, and which gained a budget since — those are left alone
 * and said so ("Already has a budget — left alone."). `targetsNow` null or
 * undefined means the re-read failed: nothing is written, all are `unread`.
 */
export function planBudgetApply(
  chosen: readonly BudgetSuggestion[],
  targetsNow: readonly BudgetTarget[] | null | undefined,
  month: string,
): { write: BudgetSuggestion[]; alreadySet: BudgetSuggestion[]; unread: BudgetSuggestion[] } {
  // The re-read failed: write nothing and report every choice as `unread`.
  if (!targetsNow) return { write: [], alreadySet: [], unread: [...chosen] };
  return {
    unread: [],
    write: chosen.filter((s) => !hasBudget(targetsNow, s.categoryId, month)),
    alreadySet: chosen.filter((s) => hasBudget(targetsNow, s.categoryId, month)),
  };
}

// ── Words (raw; Telegram escapes) ────────────────────────────────────────

/** `$420`, `$1,250` — suggestions are whole dollars (multiples of $5). */
export function budgetDollars(cents: number): string {
  const dollars = Math.round(cents / 100);
  return `${dollars < 0 ? '-' : ''}$${String(Math.abs(dollars)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1] ?? month;

/** `Jul–Sep`; a single month is just `Sep`. */
export function windowLabel(window: readonly string[]): string {
  const first = monthName(window[0]);
  const last = monthName(window[window.length - 1]);
  return first === last && window.length === 1 ? first : `${first}–${last}`;
}

/** The change log's "why" for a budget set from a suggestion. */
export function suggestionWhy(window: readonly string[]): string {
  return `Your average for ${windowLabel(window)}, rounded up to the nearest $5`;
}

/** `Groceries $420 · Dining out $180`. */
export function suggestionLine(list: readonly BudgetSuggestion[]): string {
  return list.map((s) => `${s.name} ${budgetDollars(s.cents)}`).join(' · ');
}
