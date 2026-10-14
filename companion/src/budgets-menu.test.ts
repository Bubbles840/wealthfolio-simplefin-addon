import { describe, it, expect, vi } from 'vitest';
import { suggestBudgets, BUDGET_MAX_CANDIDATES, type BudgetSuggestions, type BudgetTarget } from '../../shared/budget-suggest.js';
import { ASK_CALLBACK_PREFIX } from '../../shared/ask-flow.js';
import { findingHandle } from '../../shared/handle.js';
import { CATEGORIZE_ENTRY_CALLBACK, escapeMarkdown, RECATEGORIZE_ENTRY_CALLBACK, WHY_CALLBACK_PREFIX } from '../../shared/telegram.js';
import { AUDIT_CALLBACK_PREFIX } from './audit-menu.js';
import type { BudgetReaders } from './budget-suggest-host.js';
import {
  budgetsData, budgetsFingerprint, budgetsMenuDeps, createBudgetsMenu, parseBudgetsData, renderBudgetList, shownMask,
  BUDGETS_ALL_SET, BUDGETS_CALLBACK_PREFIX, BUDGETS_CHANGED, BUDGETS_DATABASE, BUDGETS_NO_HISTORY, BUDGETS_NOT_ENOUGH_HISTORY, BUDGETS_BIGGEST_SET, BUDGETS_PICK_ONE,
  BUDGETS_SPENDING_OFF, BUDGETS_UNREADABLE, BUDGETS_UNREADABLE_SHOW, type BudgetsMenuDeps, type MenuScreen,
} from './budgets-menu.js';
import { CHANGES_CALLBACK_PREFIX } from './changes-menu.js';
import { FINDINGS_CALLBACK_PREFIX } from './findings-menu.js';
import { SUBSCRIPTIONS_CALLBACK_PREFIX } from './subscriptions-menu.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const ODD = "Joe's *Diner*_[1]";
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const allData = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
const labels = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.text);
const target = (over: Partial<BudgetTarget> = {}): BudgetTarget => ({
  id: 'bt', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amountCents: 1, ...over,
});

const CATEGORIES = [
  { id: 'cat-gro', name: 'Groceries', parentId: null }, { id: 'cat-odd', name: ODD, parentId: null },
  { id: 'cat-gas', name: 'Gas', parentId: null }, { id: 'cat-fun', name: 'Fun', parentId: null },
];
const SPEND = [
  { month: '2026-08', category: 'Groceries', accountId: 'a', amount: 1275 },
  { month: '2026-09', category: ODD, accountId: 'a', amount: 540 },
  { month: '2026-09', category: 'Gas', accountId: 'a', amount: 150 },
  { month: '2026-09', category: 'Fun', accountId: 'a', amount: 90 },
];

/** The menu over fake readers and the real host: Fun already has a budget. */
function setup(targets: BudgetTarget[] = [target({ id: 'bt-fun', categoryId: 'cat-fun' })]) {
  const state = { targets };
  const readers: BudgetReaders = {
    settings: vi.fn(() => ({ timezone: 'America/New_York', excludedCategoryIds: [], categoryParents: {}, spendingOn: true, spendingAccountIds: ['a'] })),
    spend: vi.fn(() => SPEND),
    historyStart: vi.fn(() => '2026-01-01'),
    categories: vi.fn(() => CATEGORIES),
    targets: vi.fn(async () => ({ enabled: true, targets: state.targets })),
    set: vi.fn(async (categoryId: string, amountCents: number) => target({ id: `bt-${categoryId}`, categoryId, amountCents })),
    record: vi.fn(async () => {}),
  };
  const deps: BudgetsMenuDeps = { ...budgetsMenuDeps(readers, vi.fn()), now: () => NOW };
  return { state, readers, deps, menu: createBudgetsMenu(deps) };
}
const suggestions = (targets: BudgetTarget[] = [target({ id: 'bt-fun', categoryId: 'cat-fun' })]): BudgetSuggestions => suggestBudgets({
  now: NOW, timezone: 'America/New_York', spend: SPEND, categories: CATEGORIES, excludedCategoryIds: [], categoryParents: {}, targets,
});
const ui = () => ({ edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) });
const edited = (u: ReturnType<typeof ui>) => u.edit.mock.calls.at(-1) as unknown as [string, MenuScreen['keyboard'] | undefined];

describe('the cz:bg: encoding', () => {
  it('round-trips each button and rejects anything this menu never emitted', () => {
    const fp = 'a1b2c3d4';
    const h = findingHandle('cat-gro');
    for (const view of [
      { kind: 'list' as const },
      { kind: 'toggle' as const, fp, handle: h, mask: 0x5 },
      { kind: 'apply' as const, fp, mask: 0xffffff },
    ]) expect(parseBudgetsData(budgetsData(view))).toEqual(view);
    for (const bad of ['cz:bg:', 'cz:bg:x', 'cz:bg:ta1b2c3d4', `cz:bg:s${fp}`, `cz:bg:s${fp}1234567`, 'cz:bg:sZZZZZZZZ1', 'cz:au:m', 'cz:7:1']) {
      expect(parseBudgetsData(bad)).toBeNull();
    }
  });

  it('is the only prefix starting cz:bg, and starts no other', () => {
    const others = [ASK_CALLBACK_PREFIX, WHY_CALLBACK_PREFIX, AUDIT_CALLBACK_PREFIX, CHANGES_CALLBACK_PREFIX, FINDINGS_CALLBACK_PREFIX,
      SUBSCRIPTIONS_CALLBACK_PREFIX, CATEGORIZE_ENTRY_CALLBACK, RECATEGORIZE_ENTRY_CALLBACK, 'cz:al:', 'cz:alc:', 'cz:tl:', 'cz:tlc:', 'cz:tlk:', 'cz:tlu:', 'cz:0:0'];
    expect(BUDGETS_CALLBACK_PREFIX).toBe('cz:bg:');
    expect(others.filter((p) => p.startsWith('cz:bg') || BUDGETS_CALLBACK_PREFIX.startsWith(p))).toEqual([]);
  });

  it(`keeps every button within 64 bytes — with ${BUDGET_MAX_CANDIDATES} suggestions the longest is 29`, () => {
    const many = Array.from({ length: BUDGET_MAX_CANDIDATES }, (_, i) => ({ id: `0f8fad5b-d9cb-469f-a165-7086772895${String(i).padStart(2, '0')}`, name: `${ODD} ${i}`, parentId: null }));
    const s = suggestBudgets({
      now: NOW, timezone: null, categories: many, excludedCategoryIds: [], categoryParents: {}, targets: [],
      spend: many.map((c, i) => ({ month: '2026-09', category: c.name, accountId: 'a', amount: 100 + i * 30 })),
    });
    const screen = renderBudgetList(s, shownMask(s));
    const lengths = allData(screen).map(bytes);
    expect(Math.max(...lengths)).toBe(29);
    expect(allData(screen)).toHaveLength(BUDGET_MAX_CANDIDATES + 1);
  });
});

describe('renderBudgetList', () => {
  it('lists the suggestions with the window, the names escaped in the text and raw on the buttons', () => {
    const s = suggestions();
    const screen = renderBudgetList(s, shownMask(s));
    expect(screen.text).toBe([
      '*Suggested budgets*',
      'Your average monthly spending for Jul–Sep, rounded up to the nearest $5, for each category with no budget yet. Each becomes a default monthly budget in Wealthfolio.',
      '',
      `Groceries $425 · ${escapeMarkdown(ODD)} $180 · Gas $50`,
      '',
      'Tap a category to leave it out.',
    ].join('\n'));
    expect(screen.text).not.toContain(ODD);
    expect(labels(screen)).toEqual(['✓ Groceries $425', `✓ ${ODD} $180`, '✓ Gas $50', 'Apply all (3)']);
  });

  it('marks one left out, and offers Apply selected beside Apply all', () => {
    const s = suggestions();
    const fp = budgetsFingerprint(s);
    const screen = renderBudgetList(s, shownMask(s) & ~0b10);
    expect(labels(screen)).toEqual(['✓ Groceries $425', `${ODD} $180 — left out`, '✓ Gas $50', 'Apply all (3)', 'Apply selected (2)']);
    expect(allData(screen)).toEqual([
      budgetsData({ kind: 'toggle', fp, handle: findingHandle('cat-gro'), mask: 0b101 }),
      budgetsData({ kind: 'toggle', fp, handle: findingHandle('cat-odd'), mask: 0b101 }),
      budgetsData({ kind: 'toggle', fp, handle: findingHandle('cat-gas'), mask: 0b101 }),
      budgetsData({ kind: 'apply', fp, mask: 0b111 }),
      budgetsData({ kind: 'apply', fp, mask: 0b101 }),
    ]);
  });

  it('says why there is nothing to suggest', () => {
    const allSet = suggestions(CATEGORIES.map((c) => target({ id: `bt-${c.id}`, categoryId: c.id })));
    expect(renderBudgetList(allSet, 0)).toEqual({ text: `*Suggested budgets*\n${BUDGETS_ALL_SET}`, keyboard: { inline_keyboard: [] } });
    const empty = suggestBudgets({ now: NOW, timezone: null, spend: [], categories: CATEGORIES, excludedCategoryIds: [], categoryParents: {}, targets: [] });
    expect(renderBudgetList(empty, 0).text).toBe(`*Suggested budgets*\n${BUDGETS_NO_HISTORY}`);
  });
});

describe('/budgets', () => {
  it('replies with the list, every suggestion picked', async () => {
    const { menu } = setup();
    const send = vi.fn(async () => {});
    await menu.reply(send);
    const [text, keyboard] = send.mock.calls[0] as unknown as [string, MenuScreen['keyboard']];
    expect(text.startsWith('*Suggested budgets*\n')).toBe(true);
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['✓ Groceries $425', `✓ ${ODD} $180`, '✓ Gas $50', 'Apply all (3)']);
  });

  it.each([
    ['database', { settings: vi.fn(() => { throw new Error('no database'); }) }, BUDGETS_DATABASE],
    ['spending-off', { targets: vi.fn(async () => ({ enabled: false, targets: [] })) }, BUDGETS_SPENDING_OFF],
    ['budgets', { targets: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) }, BUDGETS_UNREADABLE_SHOW],
  ])('says so when %s cannot be read', async (_why, over, text) => {
    const { readers, menu } = setup();
    Object.assign(readers, over);
    const send = vi.fn(async () => {});
    await menu.reply(send);
    expect(send.mock.calls[0]).toEqual([escapeMarkdown(text)]);
  });

  it('a tap toggles a category in place', async () => {
    const { menu } = setup();
    const s = suggestions();
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'toggle', fp: budgetsFingerprint(s), handle: findingHandle('cat-gas'), mask: 0b111 }) }, u);
    const [, keyboard] = edited(u);
    expect(keyboard!.inline_keyboard.flat().map((b) => b.text)).toEqual(['✓ Groceries $425', `✓ ${ODD} $180`, 'Gas $50 — left out', 'Apply all (3)', 'Apply selected (2)']);
    expect(u.answer).toHaveBeenCalled();
  });

  it('Apply selected sets only those, and says how each went', async () => {
    const { menu, readers } = setup();
    const s = suggestions();
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: 0b101 }) }, u);
    expect(readers.set).toHaveBeenCalledTimes(2);
    const [text, keyboard] = edited(u);
    expect(text).toBe(['*Budgets*', '✓ Groceries: $425 a month', '✓ Gas: $50 a month', '', 'Undo any of these from /changes.'].join('\n'));
    expect(keyboard).toBeUndefined();
  });

  it('never overwrites a budget added between the list and Apply: it is left alone and said so', async () => {
    const { menu, readers, state } = setup();
    const s = suggestions();
    state.targets = [...state.targets, target({ id: 'bt-new', categoryId: 'cat-odd', amountCents: 9900 })];
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: shownMask(s) }) }, u);
    expect((readers.set as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['cat-gro', 'cat-gas']);
    expect(edited(u)[0]).toBe([
      '*Budgets*', '✓ Groceries: $425 a month', '✓ Gas: $50 a month', `${escapeMarkdown(ODD)}: Already has a budget — left alone.`,
      '', 'Undo any of these from /changes.',
    ].join('\n'));
  });

  it('one failing category does not stop the rest', async () => {
    const { menu, readers } = setup();
    readers.set = vi.fn(async (categoryId: string, amountCents: number) => {
      if (categoryId === 'cat-gro') throw new Error('setBudgetTarget failed: 500 - *locked*');
      return target({ id: `bt-${categoryId}`, categoryId, amountCents });
    });
    const s = suggestions();
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: shownMask(s) }) }, u);
    expect(edited(u)[0]).toBe([
      '*Budgets*', `✓ ${escapeMarkdown(ODD)}: $180 a month`, '✓ Gas: $50 a month',
      `Groceries: couldn't set it — ${escapeMarkdown('setBudgetTarget failed: 500 - *locked*')}`,
      '', 'Undo any of these from /changes.', 'Send /budgets again to try the rest.',
    ].join('\n'));
  });

  it("sets nothing when the budget can't be re-read, and offers to try again", async () => {
    const { menu, readers } = setup();
    const s = suggestions();
    let reads = 0;
    readers.targets = vi.fn(async () => {
      reads += 1;
      if (reads > 1) throw new Error('ECONNREFUSED');
      return { enabled: true, targets: [] };
    });
    const data = budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: shownMask(s) });
    const u = ui();
    await menu.onCallback({ data }, u);
    expect(readers.set).not.toHaveBeenCalled();
    expect(edited(u)).toEqual([`*Suggested budgets*\n${escapeMarkdown(BUDGETS_UNREADABLE)}`, { inline_keyboard: [[{ text: 'Try again', callback_data: data }]] }]);
  });

  it('shows the list again when the spending behind it changed', async () => {
    const { menu, readers } = setup();
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'apply', fp: '00000000', mask: 0b1 }) }, u);
    expect(readers.set).not.toHaveBeenCalled();
    const [text, keyboard] = edited(u);
    expect(text.startsWith(`*Suggested budgets*\n${escapeMarkdown(BUDGETS_CHANGED)}\n`)).toBe(true);
    expect(keyboard!.inline_keyboard.flat().at(-1)!.text).toBe('Apply all (3)');
  });

  it('asks for at least one, and ignores a tap it never sent', async () => {
    const { menu } = setup();
    const s = suggestions();
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: 0 }) }, u);
    expect(u.answer).toHaveBeenCalledWith(BUDGETS_PICK_ONE);
    expect(u.edit).not.toHaveBeenCalled();
    const v = ui();
    await menu.onCallback({ data: 'cz:bg:zz' }, v);
    expect(v.answer).toHaveBeenCalledWith();
    expect(menu.handles('cz:bg:m')).toBe(true);
    expect(menu.handles('cz:au:m')).toBe(false);
  });
});

describe('project 4 rulings P4-E..P4-H', () => {
  it('labels the list with the months actually averaged, not the whole window', async () => {
    const { readers, menu } = setup();
    readers.historyStart = vi.fn(() => '2026-09-01');
    const send = vi.fn(async () => {});
    await menu.reply(send);
    const [text] = send.mock.calls[0] as unknown as [string];
    expect(text).toContain('Your average monthly spending for Sep, rounded up');
    expect(text).not.toContain('Jul');
  });

  it('records the months averaged, not the window, when it applies', async () => {
    const { readers, menu } = setup();
    readers.historyStart = vi.fn(() => '2026-09-01');
    const s = suggestBudgets({ now: NOW, timezone: 'America/New_York', spend: SPEND, categories: CATEGORIES, excludedCategoryIds: [], categoryParents: {}, targets: [target({ id: 'bt-fun', categoryId: 'cat-fun' })], historyStartDay: '2026-09-01' });
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: shownMask(s) }) }, u);
    expect(readers.set).toHaveBeenCalled();
    const drafts = (readers.record as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.stringify(c[0]));
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) {
      expect(d).toContain('Your average for Sep, rounded');
      expect(d).not.toContain('Jul');
    }
  });

  it('gives a ledger too young for one full month its own reply', async () => {
    const { readers, menu } = setup();
    readers.historyStart = vi.fn(() => '2026-10-02');
    const send = vi.fn(async () => {});
    await menu.reply(send);
    expect(send.mock.calls[0]).toEqual([`*Suggested budgets*\n${escapeMarkdown(BUDGETS_NOT_ENOUGH_HISTORY)}`]);
    expect(BUDGETS_NOT_ENOUGH_HISTORY).toBe("Your ledger doesn't cover a full month yet — send /budgets again once a full calendar month has synced.");
    const none = { ...suggestions(), notEnoughHistory: true, candidates: [], suggestions: [] };
    expect(renderBudgetList(none, 0).text).toBe(`*Suggested budgets*\n${BUDGETS_NOT_ENOUGH_HISTORY}`);
  });

  it('keeps the every-category-has-a-budget copy true when the budgets are this month’s $0 targets', () => {
    expect(BUDGETS_ALL_SET).not.toContain('$0');
    const zero = suggestions(CATEGORIES.map((c) => target({ id: `bt-${c.id}`, categoryId: c.id, amountCents: 0, periodKey: '2026-10' })));
    expect(renderBudgetList(zero, 0).text).toBe(`*Suggested budgets*\n${BUDGETS_ALL_SET}`);
  });

  it('a failed re-read sets nothing and offers Try again', async () => {
    const { menu, readers } = setup();
    const s = suggestions();
    let reads = 0;
    readers.targets = vi.fn(async () => {
      reads += 1;
      if (reads > 1) return { enabled: false, targets: [] };
      return { enabled: true, targets: [] };
    });
    const data = budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: shownMask(s) });
    const u = ui();
    await menu.onCallback({ data }, u);
    expect(readers.set).not.toHaveBeenCalled();
    expect(edited(u)).toEqual([`*Suggested budgets*\n${escapeMarkdown(BUDGETS_UNREADABLE)}`, { inline_keyboard: [[{ text: 'Try again', callback_data: data }]] }]);
    expect(BUDGETS_UNREADABLE).toBe("Couldn't read your budgets — nothing was set.");
  });

  it('renders a write whose reply named no target as set', async () => {
    const { menu, readers } = setup();
    readers.set = vi.fn(async () => null);
    const s = suggestions();
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: 0b1 }) }, u);
    expect(edited(u)[0]).toBe(['*Budgets*', '✓ Groceries: $425 a month', '', 'Undo any of these from /changes.'].join('\n'));
  });

  it('keeps `_` and `*` in names and errors outside every entity, raw on buttons', async () => {
    const { menu, readers } = setup();
    readers.set = vi.fn(async (categoryId: string, amountCents: number) => {
      if (categoryId === 'cat-odd') throw new Error('bad_thing *x*');
      return target({ id: `bt-${categoryId}`, categoryId, amountCents });
    });
    const s = suggestions();
    const list = renderBudgetList(s, shownMask(s));
    expect(list.text).toContain(`${escapeMarkdown(ODD)} $180`);
    expect(labels(list)).toContain(`✓ ${ODD} $180`);
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: shownMask(s) }) }, u);
    const text = edited(u)[0];
    expect(text).toContain(`${escapeMarkdown(ODD)}: couldn't set it — ${escapeMarkdown('bad_thing *x*')}`);
    // The only unescaped entity markers are the two heading asterisks.
    expect(text.replace(/\\./g, '').match(/[*_]/g)).toEqual(['*', '*']);
  });

  it('keeps the longest button, with a 24-bit mask, within 64 bytes', () => {
    const fp = 'a1b2c3d4';
    const h = findingHandle('x');
    const longest = Math.max(
      bytes(budgetsData({ kind: 'toggle', fp, handle: h, mask: 0xffffff })),
      bytes(budgetsData({ kind: 'apply', fp, mask: 0xffffff })),
    );
    expect(longest).toBe(29);
    expect(longest).toBeLessThanOrEqual(64);
  });
});

describe('project 4 ruling P4-I (fix round 1)', () => {
  it('I1: a re-drawn list drops mask bits for categories no longer shown', async () => {
    const { menu, state } = setup();
    const s = suggestions();
    state.targets = [...state.targets, target({ id: 'bt-gas', categoryId: 'cat-gas' })];
    const fp = budgetsFingerprint(s);
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'toggle', fp, handle: findingHandle('cat-gro'), mask: 0b111 }) }, u);
    const [, keyboard] = edited(u);
    const buttons = keyboard!.inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(['Groceries $425 — left out', `✓ ${ODD} $180`, 'Apply all (2)', 'Apply selected (1)']);
    expect(parseBudgetsData(buttons.at(-1)!.callback_data!)).toEqual({ kind: 'apply', fp, mask: 0b010 });
    const v = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'toggle', fp, handle: findingHandle('cat-odd'), mask: 0b110 }) }, v);
    expect(edited(v)[1]!.inline_keyboard.flat().map((b) => b.text)).toEqual(['Groceries $425 — left out', `${ODD} $180 — left out`, 'Apply all (2)']);
  });

  it('I2: a double tap on Apply POSTs once per category and the second screen says already set', async () => {
    const { menu, readers, state } = setup();
    readers.set = vi.fn(async (categoryId: string, amountCents: number) => {
      const t = target({ id: `bt-${categoryId}`, categoryId, amountCents });
      state.targets = [...state.targets, t];
      return t;
    });
    const s = suggestions();
    const data = budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: shownMask(s) });
    const u = ui();
    await menu.onCallback({ data }, u);
    expect(u.edit.mock.calls[0]).toEqual(['Setting 3 budgets…']);
    expect(u.answer).toHaveBeenCalledTimes(1);
    expect(u.answer.mock.invocationCallOrder[0]).toBeLessThan((readers.set as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]);
    const v = ui();
    await menu.onCallback({ data }, v);
    expect(readers.set).toHaveBeenCalledTimes(3);
    expect(edited(v)[0]).toBe([
      '*Budgets*', '✓ Groceries: $425 a month (already set)', `✓ ${escapeMarkdown(ODD)}: $180 a month (already set)`, '✓ Gas: $50 a month (already set)',
      '', 'Undo any of these from /changes.',
    ].join('\n'));
    const one = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: 0b1 }) }, one);
    expect(one.edit.mock.calls[0]).toEqual(['Setting 1 budget…']);
  });

  it('M2: when only over-limit categories are unbudgeted, it is not "every category"', () => {
    const many = Array.from({ length: BUDGET_MAX_CANDIDATES + 2 }, (_, i) => ({ id: `c${i}`, name: `Cat${String(i).padStart(2, '0')}`, parentId: null }));
    const facts = {
      now: NOW, timezone: null, categories: many, excludedCategoryIds: [], categoryParents: {},
      spend: many.map((c, i) => ({ month: '2026-09', category: c.name, accountId: 'a', amount: 1000 - i * 10 })),
    };
    const first = suggestBudgets({ ...facts, targets: [] });
    const targets = first.suggestions.map((x) => target({ id: `t-${x.categoryId}`, categoryId: x.categoryId }));
    const s = suggestBudgets({ ...facts, targets });
    expect(s.suggestions).toEqual([]);
    expect(s.skipped.some((k) => k.reason === 'over-limit')).toBe(true);
    expect(BUDGETS_BIGGEST_SET).toBe('Your biggest categories already have a budget — nothing to suggest.');
    expect(renderBudgetList(s, 0).text).toBe(`*Suggested budgets*\n${BUDGETS_BIGGEST_SET}`);
  });

  it('M3: 12 long failures stay under Telegram\'s 4096 characters', async () => {
    const { menu, readers } = setup();
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `A fairly long category name number ${i}_*`, parentId: null }));
    readers.categories = vi.fn(() => many);
    readers.spend = vi.fn(() => many.map((c) => ({ month: '2026-09', category: c.name, accountId: 'a', amount: 5000 })));
    readers.targets = vi.fn(async () => ({ enabled: true, targets: [] }));
    readers.set = vi.fn(async () => { throw new Error('x_*'.repeat(400)); });
    const read = await deps(readers).read(NOW);
    if (!read.ok) throw new Error('unreadable');
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'apply', fp: budgetsFingerprint(read.result), mask: shownMask(read.result) }) }, u);
    const text = edited(u)[0];
    expect(text.split('\n').filter((l) => l.includes("couldn't set it"))).toHaveLength(12);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain('…');
  });

  it('M4: the changed-list notice', () => {
    expect(BUDGETS_CHANGED).toBe('That list is out of date — here it is again.');
  });
});

const deps = (readers: BudgetReaders) => ({ ...budgetsMenuDeps(readers, vi.fn()), now: () => NOW });
