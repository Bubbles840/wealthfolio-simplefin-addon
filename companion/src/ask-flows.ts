/**
 * companion/src/ask-flows.ts
 *
 * The bot's question flows. Pure builders — the data they need (categories,
 * counts, budget rows) is passed in — so each can be driven through the shared
 * engine in a test without a database. index.ts registers them and owns what
 * happens on Save.
 *
 * The engine never escapes; anything user- or bank-supplied that a prompt or
 * summary prints goes through `escapeMarkdown` here.
 */
import type { AskFlow } from '../../shared/ask-flow.js';
import { categoryDisplayName } from '../../shared/categorize-menu.js';
import { escapeMarkdown, formatDollars, shortDate } from '../../shared/telegram.js';
import { type CategoryBudgetSnapshot, formatCategoryQueryMiss, NEWRULE_CATEGORY_LIST_HINT, nextOccurrence, parseAmountCents, parseDateInput, resolveCategoryQuery } from '../../shared/telegram-commands.js';
import type { NativeSpendingCategory } from './sqlite-native.js';

const AMOUNT_HINT = "Couldn't read that as an amount — try 16000 or $16,000.";
const DATE_HINT = "Couldn't read that date — try Dec 12 or 2026-12-12.";

export function buildPoolSetFlow(now: Date): AskFlow {
  const today = now.toISOString().slice(0, 10);
  return {
    id: 'pool-set',
    command: 'pool',
    title: 'Semester pool',
    steps: [
      {
        id: 'amount',
        kind: 'text',
        prompt: () => 'How much is the pool? (e.g. 16000)',
        parse: (input) => {
          const cents = parseAmountCents(input);
          return cents === null ? { ok: false, hint: AMOUNT_HINT } : { ok: true, value: cents };
        },
      },
      {
        id: 'until',
        kind: 'text',
        prompt: (a) => `${formatDollars((a.amount as number) / 100, 0)} has to last until when? (e.g. Dec 12)`,
        parse: (input) => {
          const date = parseDateInput(input, now);
          if (date === null) return { ok: false, hint: DATE_HINT };
          if (date.form === 'iso' && date.iso < today) return { ok: false, hint: 'That date has passed — pick one ahead of today.' };
          return { ok: true, value: date.form === 'month-day' ? nextOccurrence(date.iso, today) : date.iso };
        },
      },
    ],
    summary: (a) => `*${formatDollars((a.amount as number) / 100, 0)}* from today until *${shortDate(a.until as string)}*.`,
  };
}

export function buildPoolClearFlow(): AskFlow {
  return {
    id: 'pool-clear',
    command: 'pool',
    title: 'Clear the pool',
    steps: [{
      id: 'confirm',
      kind: 'choice',
      prompt: () => 'Clear the pool? Reports go back to budgets only.',
      options: () => [{ label: 'Yes, clear', value: true }],
    }],
  };
}

/** The spending categories filed most often in `rows`, most-used first —
 *  `/newrule`'s quick picks. Other taxonomies and deleted categories drop. */
export function mostUsedCategories(
  rows: ReadonlyArray<{ assignments: ReadonlyArray<{ taxonomyId: string; categoryId: string }> }>,
  categories: NativeSpendingCategory[],
  limit = 6,
): NativeSpendingCategory[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const a of row.assignments) {
      if (a.taxonomyId === 'spending_categories') counts.set(a.categoryId, (counts.get(a.categoryId) ?? 0) + 1);
    }
  }
  const byId = new Map(categories.map((c) => [c.id, c]));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => byId.get(id))
    .filter((c): c is NativeSpendingCategory => c !== undefined)
    .slice(0, limit);
}

export function buildNewRuleFlow(input: {
  categories: NativeSpendingCategory[];
  mostUsed: NativeSpendingCategory[];
  countMatches: (pattern: string) => number;
}): AskFlow {
  return {
    id: 'newrule',
    command: 'newrule',
    title: 'New rule',
    steps: [
      {
        id: 'pattern',
        kind: 'text',
        prompt: () => "Which words from the bank's description should the rule match? (e.g. trader joes)",
        parse: (text) => {
          // `=` and `→` are the one-liner's separator; here the category is the next question.
          if (/[=→]/.test(text)) return { ok: false, hint: "Just the words — I'll ask for the category next." };
          return /[a-z]/i.test(text)
            ? { ok: true, value: text.trim() }
            : { ok: false, hint: "Type a few words from the bank's description, e.g. trader joes." };
        },
      },
      {
        id: 'category',
        kind: 'text',
        prompt: (a) => {
          const pattern = a.pattern as string;
          const n = input.countMatches(pattern);
          const quoted = `"${escapeMarkdown(pattern)}"`;
          const head = n === 0
            ? `No transactions in the past year match ${quoted} yet — the rule will still file future ones.`
            : `${n} ${n === 1 ? 'transaction' : 'transactions'} in the past year match ${quoted}.`;
          return `${head}\nWhich category should they go to? Type a name or tap one.`;
        },
        parse: (text) => {
          const result = resolveCategoryQuery(input.categories, text);
          if (result.kind === 'one') return { ok: true, value: result.category.id };
          return { ok: false, hint: formatCategoryQueryMiss(result, text, NEWRULE_CATEGORY_LIST_HINT) ?? 'No category by that name.' };
        },
        quick: () => input.mostUsed.map((c) => ({ label: categoryDisplayName(c), value: c.id })),
      },
    ],
  };
}

const AFFORD_CATEGORY_HINT = 'Type one of your budget categories, or tap one.';

/** `categories` is the whole snapshot (what `formatAffordReply` resolves over);
 *  the quick picks are only the budgeted ones. */
export function buildAffordFlow(categories: CategoryBudgetSnapshot[]): AskFlow {
  return {
    id: 'afford',
    command: 'afford',
    title: 'Can I afford it?',
    steps: [
      {
        id: 'amount',
        kind: 'text',
        prompt: () => 'How much do you want to spend? (e.g. 20)',
        parse: (input) => {
          const cents = parseAmountCents(input);
          return cents === null ? { ok: false, hint: "Couldn't read that as an amount — try 20 or $20." } : { ok: true, value: cents };
        },
      },
      {
        id: 'query',
        kind: 'text',
        prompt: () => 'On what? Type a category or tap one.',
        // Resolved here, so a wrong answer re-asks only this question; the
        // done value is the resolved name, which formatAffordReply re-resolves.
        parse: (input) => {
          const result = resolveCategoryQuery(categories, input);
          if (result.kind === 'one') return { ok: true, value: result.category.name };
          return { ok: false, hint: formatCategoryQueryMiss(result, input, AFFORD_CATEGORY_HINT) ?? 'No category by that name.' };
        },
        quick: () => categories.filter((c) => c.budget > 0).slice(0, 8).map((c) => ({ label: c.name, value: c.name })),
      },
    ],
  };
}
