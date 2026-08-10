import { describe, it, expect } from 'vitest';
import { parseCommand, formatHelpReply, TELEGRAM_COMMAND_MENU, resolveCategoryQuery, parseAffordArgs, formatLeftReply, formatAffordReply } from './telegram-commands';
import type { CategoryBudgetSnapshot, BudgetPeriod } from './telegram-commands';
import { DEFAULT_GLYPH_STYLE } from './telegram.js';

describe('parseCommand', () => {
  it('parses a bare command', () => {
    expect(parseCommand('/report')).toEqual({ command: 'report', args: '' });
  });
  it('parses arguments as one trimmed string', () => {
    expect(parseCommand('/afford  20 shopping ')).toEqual({ command: 'afford', args: '20 shopping' });
  });
  it('strips an @BotName suffix, which Telegram appends in groups', () => {
    expect(parseCommand('/left@SimplefinSyncBot groceries')).toEqual({ command: 'left', args: 'groceries' });
  });
  it('lowercases the command but never the arguments', () => {
    expect(parseCommand('/LEFT Groceries')).toEqual({ command: 'left', args: 'Groceries' });
  });
  it('returns null for plain text, empty, and null', () => {
    expect(parseCommand('what is left?')).toBeNull();
    expect(parseCommand('')).toBeNull();
    expect(parseCommand(null)).toBeNull();
  });
  it('returns null for a lone slash', () => {
    expect(parseCommand('/')).toBeNull();
  });
});

describe('formatHelpReply', () => {
  it('lists every command in the menu, one line each', () => {
    const help = formatHelpReply();
    for (const { command } of TELEGRAM_COMMAND_MENU) {
      expect(help).toContain(`/${command}`);
    }
  });
  it('menu covers exactly the six shipped commands', () => {
    expect(TELEGRAM_COMMAND_MENU.map((c) => c.command).sort())
      .toEqual(['afford', 'help', 'left', 'report', 'status', 'sync']);
  });
  it('prefixes with Unknown command when asked about junk', () => {
    const help = formatHelpReply('bogus');
    expect(help).toMatch(/^Unknown command/);
    expect(help).toContain('/bogus');
  });
});

describe('resolveCategoryQuery', () => {
  const cats: CategoryBudgetSnapshot[] = [
    { name: 'Home', budget: 100, monthSpent: 10, weekSpent: 5 },
    { name: 'Home Improvement', budget: 200, monthSpent: 20, weekSpent: 10 },
    { name: 'Groceries', budget: 50, monthSpent: 5, weekSpent: 2 },
  ];

  it('an exact match wins outright even when it prefixes another category', () => {
    const result = resolveCategoryQuery(cats, 'Home');
    expect(result).toEqual({ kind: 'one', category: cats[0] });
  });

  it('several prefix matches with no exact match are ambiguous', () => {
    const result = resolveCategoryQuery(cats, 'hom');
    expect(result).toEqual({ kind: 'ambiguous', names: ['Home', 'Home Improvement'] });
  });

  it('a single case-insensitive prefix match resolves to one', () => {
    const result = resolveCategoryQuery(cats, 'grocer');
    expect(result).toEqual({ kind: 'one', category: cats[2] });
  });

  it('no matching prefix resolves to none', () => {
    expect(resolveCategoryQuery(cats, 'xyz')).toEqual({ kind: 'none' });
  });
});

describe('formatLeftReply — bare listing', () => {
  // horizon 20 (more days left than a week) is what makes an over-week ⚠️ state
  // reachable at all distinctly from over-month 🚨: at horizon<=7 the weekly
  // envelope collapses to exactly the remaining month budget, so leftThisWeek
  // and remainingMonth can never disagree — see weeklyEnvelope's cap comment.
  const period: BudgetPeriod = { daysFromWeekStartToMonthEnd: 20, daysLeftInMonthInclusive: 15 };
  const cats: CategoryBudgetSnapshot[] = [
    { name: 'Dining', budget: 100, monthSpent: 110, weekSpent: 20 }, // over month -> 🚨
    { name: 'Shopping', budget: 100, monthSpent: 50, weekSpent: 40 }, // over week only -> ⚠️
    { name: 'Fun', budget: 0, monthSpent: 30, weekSpent: 10 }, // no budget -> omitted
    { name: 'Travel', budget: 200, monthSpent: 50, weekSpent: 10 }, // healthy -> 🟢
  ];

  it('omits categories with no budget row', () => {
    const reply = formatLeftReply(cats, period, DEFAULT_GLYPH_STYLE);
    expect(reply).not.toContain('Fun');
  });

  it('marks an over-the-month category 🚨 with the overage, no week figure', () => {
    const reply = formatLeftReply(cats, period, DEFAULT_GLYPH_STYLE);
    expect(reply).toContain('🚨');
    expect(reply).toContain('Dining');
    expect(reply).toContain('over by $10 this month');
  });

  it('marks an over-the-week-but-not-month category ⚠️', () => {
    const reply = formatLeftReply(cats, period, DEFAULT_GLYPH_STYLE);
    expect(reply).toContain('⚠️');
    expect(reply).toContain('Shopping');
    expect(reply).toContain('week allowance spent');
    expect(reply).toContain('$50 left this month');
  });

  it('marks a healthy category 🟢 with both figures', () => {
    const reply = formatLeftReply(cats, period, DEFAULT_GLYPH_STYLE);
    expect(reply).toContain('🟢');
    expect(reply).toContain('Travel');
    expect(reply).toContain('$46 left this week');
    expect(reply).toContain('$150 left this month');
  });
});

describe('formatLeftReply — narrowed by query', () => {
  const period: BudgetPeriod = { daysFromWeekStartToMonthEnd: 20, daysLeftInMonthInclusive: 15 };
  const cats: CategoryBudgetSnapshot[] = [
    { name: 'Home', budget: 100, monthSpent: 10, weekSpent: 5 },
    { name: 'Home Improvement', budget: 200, monthSpent: 20, weekSpent: 10 },
    { name: 'Fun', budget: 0, monthSpent: 30, weekSpent: 10 },
    { name: 'Gym_Time', budget: 0, monthSpent: 12, weekSpent: 3 },
  ];

  it('a single resolved match renders that category line', () => {
    const reply = formatLeftReply(cats, period, DEFAULT_GLYPH_STYLE, 'Home');
    expect(reply).toContain('Home');
    expect(reply).not.toContain('Improvement');
  });

  it('a no-budget category reports its month spend and the no-budget sentence', () => {
    const reply = formatLeftReply(cats, period, DEFAULT_GLYPH_STYLE, 'Fun');
    expect(reply).toContain('$30 spent this month');
    expect(reply).toContain('No budget set for Fun — nothing to be over.');
  });

  it('escapes a category name interpolated into the no-budget sentence', () => {
    const reply = formatLeftReply(cats, period, DEFAULT_GLYPH_STYLE, 'Gym_Time');
    expect(reply).toContain('Gym\\_Time');
  });

  it('an ambiguous query lists the matching names verbatim', () => {
    const reply = formatLeftReply(cats, period, DEFAULT_GLYPH_STYLE, 'Hom');
    expect(reply).toBe('Which one? Home, Home Improvement');
  });

  it('no matching prefix names the query and points at bare /left', () => {
    const reply = formatLeftReply(cats, period, DEFAULT_GLYPH_STYLE, 'nonexistent');
    expect(reply).toBe('No category starts with "nonexistent". /left lists them all.');
  });
});

describe('parseAffordArgs', () => {
  it('accepts a plain amount and query', () => {
    expect(parseAffordArgs('20 shopping')).toEqual({ amount: 20, query: 'shopping' });
  });
  it('accepts a dollar-sign-prefixed amount', () => {
    expect(parseAffordArgs('$20 shopping')).toEqual({ amount: 20, query: 'shopping' });
  });
  it('accepts a decimal amount', () => {
    expect(parseAffordArgs('20.50 x')).toEqual({ amount: 20.5, query: 'x' });
  });
  it('rejects empty input', () => {
    expect(parseAffordArgs('')).toBeNull();
  });
  it('rejects a missing amount (query first)', () => {
    expect(parseAffordArgs('shopping 20')).toBeNull();
  });
  it('rejects an amount with no query', () => {
    expect(parseAffordArgs('20')).toBeNull();
  });
  it('rejects a zero amount', () => {
    expect(parseAffordArgs('0 shopping')).toBeNull();
  });
  it('rejects a negative amount', () => {
    expect(parseAffordArgs('-5 x')).toBeNull();
  });
});

describe('formatAffordReply', () => {
  const period: BudgetPeriod = { daysFromWeekStartToMonthEnd: 14, daysLeftInMonthInclusive: 10 };
  const cats: CategoryBudgetSnapshot[] = [
    { name: 'Shopping', budget: 100, monthSpent: 30, weekSpent: 10 },
    { name: 'NoBudget', budget: 0, monthSpent: 25, weekSpent: 5 },
    { name: 'Home', budget: 100, monthSpent: 10, weekSpent: 5 },
    { name: 'Home Improvement', budget: 200, monthSpent: 20, weekSpent: 10 },
  ];

  it('a purchase that still fits the week renders 🟢 with before/after figures', () => {
    const reply = formatAffordReply(cats, period, DEFAULT_GLYPH_STYLE, 20, 'Shopping');
    expect(reply).toContain('This week: $30 left → $10 left');
    expect(reply).toContain('This month: $70 left → $50 left');
    expect(reply).toContain("🟢 Fits this week's allowance.");
  });

  it('after-week exactly zero still counts as fitting (boundary)', () => {
    const boundaryCats: CategoryBudgetSnapshot[] = [
      { name: 'Boundary', budget: 100, monthSpent: 40, weekSpent: 40 },
    ];
    const boundaryPeriod: BudgetPeriod = { daysFromWeekStartToMonthEnd: 7, daysLeftInMonthInclusive: 7 };
    const reply = formatAffordReply(boundaryCats, boundaryPeriod, DEFAULT_GLYPH_STYLE, 60, 'Boundary');
    expect(reply).toContain('This week: $60 left → $0 left');
    expect(reply).toContain("🟢 Fits this week's allowance.");
  });

  it('a purchase that blows the week but not the month renders ⚠️', () => {
    const reply = formatAffordReply(cats, period, DEFAULT_GLYPH_STYLE, 35, 'Shopping');
    expect(reply).toContain('This week: $30 left → -$5 left');
    expect(reply).toContain('This month: $70 left → $35 left');
    expect(reply).toContain("⚠️ Blows this week's allowance but fits the month.");
  });

  it('a purchase that blows the month renders 🚨 with the overage', () => {
    const reply = formatAffordReply(cats, period, DEFAULT_GLYPH_STYLE, 90, 'Shopping');
    expect(reply).toContain('This month: $70 left → -$20 left');
    expect(reply).toContain("🚨 Over the month's budget by $20.");
  });

  it('a no-budget category reports its month spend and the no-budget sentence', () => {
    const reply = formatAffordReply(cats, period, DEFAULT_GLYPH_STYLE, 10, 'NoBudget');
    expect(reply).toContain('$25 spent this month');
    expect(reply).toContain('No budget set for NoBudget — nothing to be over.');
  });

  it('an ambiguous query lists the matching names, same as /left', () => {
    const reply = formatAffordReply(cats, period, DEFAULT_GLYPH_STYLE, 10, 'Hom');
    expect(reply).toBe('Which one? Home, Home Improvement');
  });

  it('no matching prefix names the query, same as /left', () => {
    const reply = formatAffordReply(cats, period, DEFAULT_GLYPH_STYLE, 10, 'zzz');
    expect(reply).toBe('No category starts with "zzz". /left lists them all.');
  });
});
