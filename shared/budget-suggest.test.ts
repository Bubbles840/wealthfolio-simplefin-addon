import { describe, it, expect } from 'vitest';
import {
  budgetDollars, budgetWindow, hasBudget, planBudgetApply, roundUpToFiveDollars, suggestBudgets, suggestionLine,
  suggestionWhy, windowLabel, zonedMonth, BUDGET_MAX_CANDIDATES,
  type BudgetCategory, type BudgetSuggestFacts, type BudgetSuggestion, type BudgetTarget, type SpendMatrixRow,
} from './budget-suggest.js';

const NOW = new Date('2026-10-14T12:00:00Z');
const NY = 'America/New_York';

const cat = (id: string, name: string, parentId: string | null = null): BudgetCategory => ({ id, name, parentId });
const spent = (month: string, category: string, amount: number, accountId = 'wf-card'): SpendMatrixRow => ({ month, category, accountId, amount });
const target = (over: Partial<BudgetTarget>): BudgetTarget => ({
  id: 't', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amountCents: 40000, ...over,
});
const CATEGORIES = [
  cat('cat-gro', 'Groceries'), cat('cat-din', 'Dining out'), cat('cat-gas', 'Gas'), cat('cat-fun', 'Entertainment'),
  cat('cat-open', 'Opening balances'), cat('cat-tax', 'Taxes'), cat('cat-sub', 'Takeout', 'cat-din'),
];

function facts(over: Partial<BudgetSuggestFacts> = {}): BudgetSuggestFacts {
  return {
    now: NOW,
    timezone: NY,
    categories: CATEGORIES,
    excludedCategoryIds: [],
    categoryParents: Object.fromEntries(CATEGORIES.map((c) => [c.id, c.parentId])),
    targets: [],
    spend: [
      // Groceries: two accounts, a refund, $1,260.75 over three months.
      spent('2026-07', 'Groceries', 300, 'wf-chk'), spent('2026-07', 'Groceries', 120),
      spent('2026-08', 'Groceries', 410.5), spent('2026-09', 'Groceries', 450.25), spent('2026-09', 'Groceries', -20),
      // Outside the window: the month in progress and June.
      spent('2026-10', 'Groceries', 999), spent('2026-06', 'Groceries', 999),
      // Gas only in September: $150 / 3.
      spent('2026-09', 'Gas', 150),
      // Dining out: exactly $180 a month.
      spent('2026-07', 'Dining out', 180), spent('2026-08', 'Dining out', 180), spent('2026-09', 'Dining out', 180),
    ],
    ...over,
  };
}
const names = (list: BudgetSuggestion[]) => list.map((s) => `${s.name} ${budgetDollars(s.cents)}`);

describe('the window: the last 3 FULL months in Wealthfolio’s timezone', () => {
  it('is the three months before this one', () => {
    expect(budgetWindow(NOW, NY)).toEqual({
      month: '2026-10', window: ['2026-07', '2026-08', '2026-09'], start: '2026-07-01', endExclusive: '2026-10-01',
    });
  });

  it('crosses a year boundary', () => {
    expect(budgetWindow(new Date('2027-01-14T12:00:00Z'), NY)).toEqual({
      month: '2027-01', window: ['2026-10', '2026-11', '2026-12'], start: '2026-10-01', endExclusive: '2027-01-01',
    });
    expect(budgetWindow(new Date('2027-02-14T12:00:00Z'), NY).window).toEqual(['2026-11', '2026-12', '2027-01']);
  });

  it('places "this month" in Wealthfolio’s timezone, not UTC', () => {
    const newYearUtc = new Date('2027-01-01T03:00:00Z');
    expect(zonedMonth(newYearUtc, NY)).toBe('2026-12');
    expect(budgetWindow(newYearUtc, NY).window).toEqual(['2026-09', '2026-10', '2026-11']);
    expect(zonedMonth(newYearUtc, 'Europe/Berlin')).toBe('2027-01');
    expect(budgetWindow(newYearUtc, 'Europe/Berlin').window).toEqual(['2026-10', '2026-11', '2026-12']);
  });

  it('falls back to the companion’s own month for no zone or one the runtime does not know', () => {
    expect(zonedMonth(NOW, null)).toBe('2026-10');
    expect(zonedMonth(NOW, 'Mars/Olympus_Mons')).toBe('2026-10');
  });
});

describe('suggestBudgets', () => {
  it('averages each category over the 3 full months, every account summed and refunds netted, rounded up to $5', () => {
    const s = suggestBudgets(facts());
    expect(s.month).toBe('2026-10');
    expect(s.window).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(s.suggestions).toEqual([
      // $1,260.75 / 3 = $420.25 → $425.
      { categoryId: 'cat-gro', name: 'Groceries', averageCents: 42025, cents: 42500 },
      // Exactly $180 stays $180.
      { categoryId: 'cat-din', name: 'Dining out', averageCents: 18000, cents: 18000 },
      // A month with nothing counts as $0: $150 / 3 = $50.
      { categoryId: 'cat-gas', name: 'Gas', averageCents: 5000, cents: 5000 },
    ]);
    expect(s.candidates).toEqual(s.suggestions);
    expect(s.skipped).toEqual([]);
  });

  it('rounds up to the nearest $5 and never down', () => {
    expect(roundUpToFiveDollars(42000)).toBe(42000);
    expect(roundUpToFiveDollars(42001)).toBe(42500);
    expect(roundUpToFiveDollars(1)).toBe(500);
    expect(roundUpToFiveDollars(1000)).toBe(1000);
    const exact = suggestBudgets(facts({ spend: [spent('2026-07', 'Gas', 100), spent('2026-08', 'Gas', 100), spent('2026-09', 'Gas', 100.01)] }));
    expect(exact.suggestions).toEqual([{ categoryId: 'cat-gas', name: 'Gas', averageCents: 10000, cents: 10500 }]);
  });

  it('never suggests over an existing budget: a default target, or one for this month', () => {
    const s = suggestBudgets(facts({
      targets: [
        target({ id: 't1', categoryId: 'cat-gro', periodKey: 'default' }),
        target({ id: 't2', categoryId: 'cat-din', periodKey: '2026-10', amountCents: 0 }),
      ],
    }));
    expect(names(s.suggestions)).toEqual(['Gas $50']);
    // Still candidates: what a /budgets button's bits index.
    expect(names(s.candidates)).toEqual(['Groceries $425', 'Dining out $180', 'Gas $50']);
    expect(s.skipped).toEqual([{ name: 'Groceries', reason: 'has-budget' }, { name: 'Dining out', reason: 'has-budget' }]);
  });

  it('ignores targets that are not this category’s default or this month: another month, a group buffer, another taxonomy', () => {
    const s = suggestBudgets(facts({
      targets: [
        target({ id: 't1', categoryId: 'cat-gro', periodKey: '2026-09' }),
        target({ id: 't2', categoryId: null, targetType: 'group_buffer', taxonomyId: null }),
        target({ id: 't3', categoryId: 'cat-din', taxonomyId: 'income_sources' }),
      ],
    }));
    expect(names(s.suggestions)).toEqual(['Groceries $425', 'Dining out $180', 'Gas $50']);
  });

  it('skips excluded categories, Opening balances, categories under $10 a month, and names the catalog cannot place', () => {
    const s = suggestBudgets(facts({
      excludedCategoryIds: ['cat-tax', 'cat-open'],
      categories: [...CATEGORIES, cat('cat-twin-1', 'Twin'), cat('cat-twin-2', 'Twin')],
      spend: [
        ...facts().spend,
        spent('2026-08', 'Taxes', 900),
        spent('2026-08', 'Opening balances', 4646),
        // $29.99 / 3 is under $10; exactly $30 / 3 is $10 and stays.
        spent('2026-07', 'Entertainment', 29.99),
        spent('2026-09', 'Ghost', 300),
        spent('2026-09', 'Twin', 300),
      ],
    }));
    expect(names(s.suggestions)).toEqual(['Groceries $425', 'Dining out $180', 'Gas $50']);
    expect(s.skipped).toEqual([
      { name: 'Entertainment', reason: 'under-minimum' },
      { name: 'Ghost', reason: 'unknown-category' },
      { name: 'Opening balances', reason: 'opening-balances' },
      { name: 'Taxes', reason: 'excluded' },
      { name: 'Twin', reason: 'unknown-category' },
    ]);
    const ten = suggestBudgets(facts({ spend: [spent('2026-07', 'Entertainment', 30)] }));
    expect(ten.suggestions).toEqual([{ categoryId: 'cat-fun', name: 'Entertainment', averageCents: 1000, cents: 1000 }]);
  });

  it('skips Opening balances by name even on Wealthfolio 3.8, which has no exclusions', () => {
    const s = suggestBudgets(facts({ spend: [spent('2026-08', 'Opening balances', 4646)] }));
    expect(s.suggestions).toEqual([]);
    expect(s.skipped).toEqual([{ name: 'Opening balances', reason: 'opening-balances' }]);
  });

  it('skips a category whose refunds outweigh its spending', () => {
    const s = suggestBudgets(facts({ spend: [spent('2026-08', 'Gas', 40), spent('2026-09', 'Gas', -90)] }));
    expect(s.skipped).toEqual([{ name: 'Gas', reason: 'under-minimum' }]);
  });

  it(`offers at most ${BUDGET_MAX_CANDIDATES}, biggest first, ties by name`, () => {
    const many = Array.from({ length: 26 }, (_, i) => cat(`cat-${i}`, `Cat ${String(i).padStart(2, '0')}`));
    const s = suggestBudgets(facts({
      categories: many,
      categoryParents: {},
      spend: many.map((c, i) => spent('2026-08', c.name, i < 2 ? 300 : 600 + i * 15)),
    }));
    expect(s.candidates).toHaveLength(BUDGET_MAX_CANDIDATES);
    expect(s.candidates[0].name).toBe('Cat 25');
    expect(s.skipped).toEqual([{ name: 'Cat 00', reason: 'over-limit' }, { name: 'Cat 01', reason: 'over-limit' }]);
    const tied = suggestBudgets(facts({ spend: [spent('2026-08', 'Gas', 300), spent('2026-08', 'Dining out', 300)] }));
    expect(names(tied.suggestions)).toEqual(['Dining out $100', 'Gas $100']);
  });

  it('keeps category names raw — escaping is the renderer’s job', () => {
    const odd = "Joe's *Diner*_[1]";
    const s = suggestBudgets(facts({ categories: [cat('cat-odd', odd)], spend: [spent('2026-08', odd, 60)] }));
    expect(s.suggestions[0].name).toBe(odd);
    expect(suggestionLine(s.suggestions)).toBe(`${odd} $20`);
  });
});

describe('months the ledger never covered', () => {
  const sepOnly = [spent('2026-09', 'Groceries', 600)];
  const run = (historyStartDay?: string | null, spend = sepOnly) => suggestBudgets(facts({ spend, historyStartDay }));

  it('counts only whole covered months, dividing by those', () => {
    const s = run('2026-09-01');
    expect(s.monthsUsed).toEqual(['2026-09']);
    expect(s.notEnoughHistory).toBe(false);
    expect(s.suggestions).toEqual([{ categoryId: 'cat-gro', name: 'Groceries', averageCents: 60000, cents: 60000 }]);
  });

  it('does not count a month the history only started part-way through', () => {
    const s = run('2026-08-15');
    expect(s.monthsUsed).toEqual(['2026-09']);
    expect(s.suggestions[0].cents).toBe(60000);
  });

  it('says there is not enough history when no window month is covered', () => {
    const s = run('2026-10-02');
    expect(s.notEnoughHistory).toBe(true);
    expect(s.monthsUsed).toEqual([]);
    expect(s.candidates).toEqual([]);
    expect(s.suggestions).toEqual([]);
  });

  it('counts all 3 when history starts by July 1, or is absent', () => {
    for (const h of ['2026-07-01', undefined, null]) {
      const s = run(h);
      expect(s.monthsUsed).toEqual(['2026-07', '2026-08', '2026-09']);
      expect(s.suggestions[0].cents).toBe(20000);
    }
  });

  it('scales the under-$10 rule to the counted months', () => {
    expect(run('2026-09-01', [spent('2026-09', 'Gas', 9.99)]).skipped).toEqual([{ name: 'Gas', reason: 'under-minimum' }]);
    expect(run('2026-09-01', [spent('2026-09', 'Gas', 10)]).suggestions).toHaveLength(1);
  });
});

describe('planBudgetApply: re-read before writing', () => {
  const chosen = suggestBudgets(facts()).suggestions;

  it('leaves alone a category that gained a budget since the list was shown', () => {
    const plan = planBudgetApply(chosen, [
      target({ id: 'new-1', categoryId: 'cat-din', periodKey: 'default' }),
      target({ id: 'new-2', categoryId: 'cat-gas', periodKey: '2026-10' }),
      target({ id: 'old', categoryId: 'cat-gro', periodKey: '2026-08' }),
    ], '2026-10');
    expect(names(plan.write)).toEqual(['Groceries $425']);
    expect(names(plan.alreadySet)).toEqual(['Dining out $180', 'Gas $50']);
  });

  it('writes everything when nothing changed', () => {
    expect(planBudgetApply(chosen, [], '2026-10')).toEqual({ write: chosen, alreadySet: [], unread: [] });
  });

  it('writes nothing and reports every choice unread when the re-read failed', () => {
    for (const none of [null, undefined]) {
      expect(planBudgetApply(chosen, none, '2026-10')).toEqual({ write: [], alreadySet: [], unread: chosen });
    }
  });

  it('reads a budget as this category’s default or this month’s target only', () => {
    expect(hasBudget([target({ periodKey: 'default' })], 'cat-gro', '2026-10')).toBe(true);
    expect(hasBudget([target({ periodKey: '2026-10' })], 'cat-gro', '2026-10')).toBe(true);
    expect(hasBudget([target({ periodKey: '2026-11' })], 'cat-gro', '2026-10')).toBe(false);
    expect(hasBudget([target({ categoryId: 'cat-din' })], 'cat-gro', '2026-10')).toBe(false);
  });
});

describe('the words', () => {
  it('writes whole dollars, the window and why', () => {
    expect(budgetDollars(42000)).toBe('$420');
    expect(budgetDollars(125000)).toBe('$1,250');
    expect(windowLabel(['2026-07', '2026-08', '2026-09'])).toBe('Jul–Sep');
    expect(windowLabel(['2026-11', '2026-12', '2027-01'])).toBe('Nov–Jan');
    expect(suggestionWhy(['2026-07', '2026-08', '2026-09'])).toBe('Your average for Jul–Sep, rounded up to the nearest $5');
    expect(suggestionLine(suggestBudgets(facts()).suggestions)).toBe('Groceries $425 · Dining out $180 · Gas $50');
  });
});
