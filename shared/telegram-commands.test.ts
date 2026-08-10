import { describe, it, expect } from 'vitest';
import {
  parseCommand,
  formatHelpReply,
  TELEGRAM_COMMAND_MENU,
  resolveCategoryQuery,
  parseAffordArgs,
  formatLeftReply,
  formatAffordReply,
  formatStatusReply,
  formatReportFooter,
  formatSyncReply,
} from './telegram-commands';
import type { CategoryBudgetSnapshot, BudgetPeriod, StatusReplyInput } from './telegram-commands';
import { DEFAULT_GLYPH_STYLE, formatRelativeTime } from './telegram.js';

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

// formatRelativeTime's real boundaries (shared/telegram.ts), verified against the
// live implementation rather than the task brief's illustrative "119s/121s" pair:
// Math.round on `diffMs / 60_000` means the just-now/minutes cutover actually
// lands at 90s (round(1.5) rounds up to 2), not at a clean 120s. These values
// are the ones formatStatusReply and formatReportFooter actually observe.
const now = new Date('2026-08-10T12:00:00.000Z');
function agoIso(deltaSeconds: number): string {
  return new Date(now.getTime() - deltaSeconds * 1000).toISOString();
}

describe('formatRelativeTime boundaries (sanity check for the reused formatter)', () => {
  it('89s reads just now, 91s reads 2m ago', () => {
    expect(formatRelativeTime(agoIso(89), now)).toBe('just now');
    expect(formatRelativeTime(agoIso(91), now)).toBe('2m ago');
  });
  it('59min reads Nm ago, 61min crosses into Nh ago', () => {
    expect(formatRelativeTime(agoIso(59 * 60), now)).toBe('59m ago');
    expect(formatRelativeTime(agoIso(61 * 60), now)).toBe('1h ago');
  });
  it('47h reads Nh ago, 49h crosses into Nd ago', () => {
    expect(formatRelativeTime(agoIso(47 * 3600), now)).toBe('47h ago');
    expect(formatRelativeTime(agoIso(49 * 3600), now)).toBe('2d ago');
  });
});

describe('formatStatusReply', () => {
  const baseInput: StatusReplyInput = {
    version: '1.10.1',
    lastSyncAt: agoIso(2 * 3600),
    lastSyncSummary: '0 imported, 105 skipped',
    accounts: [
      { name: 'Checking', balance: 1234, currency: 'USD', drift: null, measured: true }, // in sync
      { name: 'Savings', balance: 500, currency: 'USD', drift: -20, measured: true }, // $20 off
      { name: 'Credit Card', balance: -300, currency: 'USD', drift: null, measured: false }, // not checked
    ],
    uncategorizedCount: 7,
    amazonUnparsed: 2,
  };

  it('renders the header with the companion version', () => {
    const reply = formatStatusReply(baseInput, now);
    expect(reply).toContain('*SimpleFin Sync* — companion v1.10.1');
  });

  it('renders last sync as relative time plus the summary', () => {
    const reply = formatStatusReply(baseInput, now);
    expect(reply).toContain('Last sync: 2h ago — 0 imported, 105 skipped');
  });

  it('renders "Last sync: never" when lastSyncAt is null', () => {
    const reply = formatStatusReply({ ...baseInput, lastSyncAt: null }, now);
    expect(reply).toContain('Last sync: never');
  });

  it('measured with no drift renders "in sync"', () => {
    const reply = formatStatusReply(baseInput, now);
    expect(reply).toContain('Checking: $1,234 · in sync');
  });

  it('a non-null drift renders "$N off" using the absolute value, drift takes precedence over measured', () => {
    const reply = formatStatusReply(baseInput, now);
    // measured is true AND drift is set: drift !== null must win, per the addon's
    // own precedence (drift check happens before the measured check).
    expect(reply).toContain('Savings: $500 · $20 off');
  });

  it('drift null and measured false renders "not checked" — never claims a verification that never ran', () => {
    const reply = formatStatusReply(baseInput, now);
    expect(reply).toContain('Credit Card: -$300 · not checked');
  });

  it('a negative drift value still renders unsigned "$N off"', () => {
    const input: StatusReplyInput = {
      ...baseInput,
      accounts: [{ name: 'Odd', balance: 10, currency: 'USD', drift: -5, measured: true }],
    };
    expect(formatStatusReply(input, now)).toContain('Odd: $10 · $5 off');
  });

  it('escapes an account name that carries Markdown specials', () => {
    const input: StatusReplyInput = {
      ...baseInput,
      accounts: [{ name: 'Joint_Checking', balance: 10, currency: 'USD', drift: null, measured: true }],
    };
    expect(formatStatusReply(input, now)).toContain('Joint\\_Checking: $10 · in sync');
  });

  it('null uncategorizedCount omits the needs-a-category line entirely', () => {
    const reply = formatStatusReply({ ...baseInput, uncategorizedCount: null }, now);
    expect(reply).not.toContain('Needs a category');
  });

  it('zero uncategorizedCount also omits the line — 0 problems still reads as nothing to report', () => {
    const reply = formatStatusReply({ ...baseInput, uncategorizedCount: 0 }, now);
    expect(reply).not.toContain('Needs a category');
  });

  it('a positive uncategorizedCount renders the needs-a-category line', () => {
    const reply = formatStatusReply({ ...baseInput, uncategorizedCount: 7 }, now);
    expect(reply).toContain('Needs a category: 7');
  });

  it('null amazonUnparsed omits the Amazon warning line', () => {
    const reply = formatStatusReply({ ...baseInput, amazonUnparsed: null }, now);
    expect(reply).not.toContain('Amazon email');
  });

  it('zero amazonUnparsed omits the Amazon warning line', () => {
    const reply = formatStatusReply({ ...baseInput, amazonUnparsed: 0 }, now);
    expect(reply).not.toContain('Amazon email');
  });

  it('a positive amazonUnparsed renders the warning', () => {
    const reply = formatStatusReply({ ...baseInput, amazonUnparsed: 3 }, now);
    expect(reply).toContain('⚠️ 3 Amazon email(s) unread — format may have changed');
  });

  it('a full render with one of each account state assembles as one message', () => {
    const reply = formatStatusReply(baseInput, now);
    expect(reply).toBe(
      '*SimpleFin Sync* — companion v1.10.1\n'
      + 'Last sync: 2h ago — 0 imported, 105 skipped\n'
      + 'Checking: $1,234 · in sync\n'
      + 'Savings: $500 · $20 off\n'
      + 'Credit Card: -$300 · not checked\n'
      + 'Needs a category: 7\n'
      + '⚠️ 2 Amazon email(s) unread — format may have changed',
    );
  });
});

describe('formatReportFooter', () => {
  it('states relative time since the last sync', () => {
    expect(formatReportFooter(agoIso(2 * 3600), now)).toBe(
      'Data as of last sync, 2h ago — /sync to pull new charges.',
    );
  });

  it('null lastSyncAt reports no sync has ever run', () => {
    expect(formatReportFooter(null, now)).toBe('No sync has run yet — /sync to pull transactions.');
  });
});

describe('formatSyncReply', () => {
  it('a plain success reports imported and skipped counts', () => {
    const reply = formatSyncReply({ imported: 4, skipped: 12, driftAlerts: 0, errors: [] });
    expect(reply).toBe('Synced: 4 imported, 12 skipped.');
  });

  it('drift alerts append a warning line pointing at /status', () => {
    const reply = formatSyncReply({ imported: 4, skipped: 12, driftAlerts: 2, errors: [] });
    expect(reply).toBe(
      'Synced: 4 imported, 12 skipped.\n⚠️ 2 account(s) showed drift — check /status.',
    );
  });

  it('errors append only the first one — Telegram is not a log file', () => {
    const reply = formatSyncReply({
      imported: 0,
      skipped: 0,
      driftAlerts: 0,
      errors: ['timeout talking to SimpleFin', 'second error should not appear'],
    });
    expect(reply).toContain('Sync finished with errors: timeout talking to SimpleFin');
    expect(reply).not.toContain('second error should not appear');
  });
});
