/**
 * companion/src/budget-suggest-host.ts
 *
 * The companion's half of suggested budgets (project 4, G3–G5): it gathers
 * what the pure module (shared/budget-suggest.ts) decides from, and applies a
 * choice — re-reading the budget first, one POST per category, one change-log
 * entry per target written.
 *
 * Where each fact comes from:
 *  - Wealthfolio's timezone, its excluded categories and whether its Spending
 *    tracker is on: the database, strictly (`getNativeAuditSettings`) — a
 *    database that cannot be read is said, never read as "nothing spent";
 *  - the window's spend matrix: the database, strictly, over Wealthfolio's
 *    spending accounts only and without excluded categories' own rows
 *    (`getNativeBudgetSpend`); the earliest activity day on those accounts
 *    (`getNativeSpendingHistoryStart`), so months the ledger never covered are
 *    not averaged in; and the category catalog;
 *  - the budget targets: REST (`GET /spending/budget`), on every show and again
 *    right before any write, because Wealthfolio's POST is an upsert: a target
 *    added in between would otherwise be overwritten.
 */
import {
  budgetWindow, planBudgetApply, suggestBudgets, suggestionWhy,
  type BudgetCategory, type BudgetSuggestion, type BudgetSuggestions, type BudgetTarget, type SpendMatrixRow,
} from '../../shared/budget-suggest.js';
import { budgetSetChange, type ChangeDraft } from '../../shared/change-entries.js';
import { recordCompanionChanges, type SecretClient } from './change-log-host.js';
import { getNativeAuditSettings } from './sqlite-audit.js';
import { getNativeBudgetSpend, getNativeSpendingCategories, getNativeSpendingHistoryStart } from './sqlite-native.js';
import type { WealthfolioClient } from './wealthfolio.js';

/** Everything suggesting and applying reads or writes, so a test can fake each. */
export type BudgetSettings = {
  timezone: string | null; excludedCategoryIds: string[]; categoryParents: Record<string, string | null>; spendingOn: boolean;
  /** The accounts Wealthfolio's Spending reads (opted in, existing, not archived). */
  spendingAccountIds: string[];
};

export interface BudgetReaders {
  /** Throws when the database cannot be read. */
  settings(): BudgetSettings;
  /** The window's spend, spending accounts only, excluded categories' own rows dropped. Throws when unreadable. */
  spend(startInclusive: string, endExclusive: string, settings: BudgetSettings): SpendMatrixRow[];
  /** The earliest activity day (YYYY-MM-DD) on the spending accounts; null: no activity. Throws when unreadable. */
  historyStart(settings: BudgetSettings): string | null;
  categories(): BudgetCategory[];
  /** Rejects when Wealthfolio cannot be read. `enabled: false`: its Spending tracker is off. */
  targets(): Promise<{ enabled: boolean; targets: BudgetTarget[] }>;
  /** Sets a category's default monthly budget; resolves the stored target, or
   *  null when it was written but Wealthfolio's reply named none. */
  set(categoryId: string, amountCents: number): Promise<BudgetTarget | null>;
  /** Appends to the change log. */
  record(drafts: ChangeDraft[], now: Date): Promise<void>;
}

export type BudgetClient = SecretClient & Pick<WealthfolioClient, 'getBudgetTargets' | 'setDefaultBudgetTarget'>;

export function companionBudgetReaders(client: BudgetClient, dbPath: string): BudgetReaders {
  return {
    settings: () => getNativeAuditSettings(dbPath),
    spend: (start, endExclusive, settings) => getNativeBudgetSpend(dbPath, start, endExclusive, settings),
    historyStart: (settings) => getNativeSpendingHistoryStart(dbPath, settings.spendingAccountIds),
    categories: () => getNativeSpendingCategories(dbPath),
    targets: () => client.getBudgetTargets(),
    set: (categoryId, amountCents) => client.setDefaultBudgetTarget(categoryId, amountCents),
    record: (drafts, now) => recordCompanionChanges(client, drafts, undefined, now),
  };
}

/** Why there is nothing to show: the database, a Spending tracker that is off,
 *  or the budgets themselves could not be read. */
export type BudgetReadFailure = 'database' | 'spending-off' | 'budgets';

export type BudgetSuggestRead = { ok: true; result: BudgetSuggestions } | { ok: false; reason: BudgetReadFailure };

export async function readBudgetSuggestions(r: BudgetReaders, now: Date): Promise<BudgetSuggestRead> {
  let settings: BudgetSettings;
  let spend: SpendMatrixRow[];
  let historyStartDay: string | null;
  let categories: BudgetCategory[];
  try {
    settings = r.settings();
    if (!settings.spendingOn) return { ok: false, reason: 'spending-off' };
    const { start, endExclusive } = budgetWindow(now, settings.timezone);
    spend = r.spend(start, endExclusive, settings);
    historyStartDay = r.historyStart(settings);
    categories = r.categories();
  } catch {
    return { ok: false, reason: 'database' };
  }
  let targets: BudgetTarget[];
  try {
    const read = await r.targets();
    if (!read.enabled) return { ok: false, reason: 'spending-off' };
    targets = read.targets;
  } catch {
    return { ok: false, reason: 'budgets' };
  }
  // No activity at all is no history (the pure module reads null as "absent: all count").
  if (historyStartDay === null) {
    const { month, window } = budgetWindow(now, settings.timezone);
    return { ok: true, result: { month, window, monthsUsed: [], notEnoughHistory: true, candidates: [], suggestions: [], skipped: [] } };
  }
  return {
    ok: true,
    result: suggestBudgets({
      now, timezone: settings.timezone, spend, categories,
      excludedCategoryIds: settings.excludedCategoryIds, categoryParents: settings.categoryParents, targets, historyStartDay,
    }),
  };
}

export interface BudgetApplyOutcome {
  /** `target` null: written, but Wealthfolio's reply named no target (logged with a null id). */
  set: Array<{ suggestion: BudgetSuggestion; target: BudgetTarget | null }>;
  /** Gained a budget since the list was shown: left alone. */
  alreadySet: BudgetSuggestion[];
  /** Its POST failed; the rest still applied. */
  failed: Array<{ suggestion: BudgetSuggestion; message: string }>;
}

/** `ok: false`: the budget could not be re-read (or the tracker went off), so nothing was set. */
export type BudgetApplyResult = { ok: true; outcome: BudgetApplyOutcome } | { ok: false };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Sets the chosen suggestions as default monthly budgets. Re-reads the budget
 * first and leaves alone any category that gained one since; writes the rest
 * one at a time, so a failed POST costs only its own category; logs each
 * target as it lands (`budget-set`, with the id and amount Wealthfolio
 * stored), so a crash part-way still leaves Undo for what was written.
 */
export async function applyBudgetSuggestions(
  r: BudgetReaders,
  chosen: readonly BudgetSuggestion[],
  at: { month: string; window: string[] },
  now: Date,
): Promise<BudgetApplyResult> {
  // A failed re-read, or a Spending tracker that went off, is `null`: the plan
  // then writes nothing and reports every choice `unread`.
  let targets: BudgetTarget[] | null;
  try {
    const read = await r.targets();
    targets = read.enabled ? read.targets : null;
  } catch {
    targets = null;
  }
  const { write, alreadySet, unread } = planBudgetApply(chosen, targets, at.month);
  if (unread.length > 0) return { ok: false };
  const outcome: BudgetApplyOutcome = { set: [], alreadySet, failed: [] };
  for (const suggestion of write) {
    let target: BudgetTarget | null;
    try {
      target = await r.set(suggestion.categoryId, suggestion.cents);
    } catch (err) {
      outcome.failed.push({ suggestion, message: message(err) });
      continue;
    }
    outcome.set.push({ suggestion, target });
    try {
      await r.record([budgetSetChange({
        targetId: target?.id ?? null, categoryId: suggestion.categoryId, categoryName: suggestion.name,
        amountCents: target?.amountCents ?? suggestion.cents, why: suggestionWhy(at.window),
      })], now);
    } catch {
      // A log must never cost the budget; the writer records gaps itself.
    }
  }
  return { ok: true, outcome };
}
