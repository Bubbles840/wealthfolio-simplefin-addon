import { describe, it, expect, vi } from 'vitest';
import { suggestBudgets, type BudgetSuggestion, type BudgetTarget } from '../../shared/budget-suggest.js';
import { budgetSetChange, type ChangeDraft } from '../../shared/change-entries.js';
import {
  applyBudgetSuggestions, companionBudgetReaders, readBudgetSuggestions, type BudgetReaders,
} from './budget-suggest-host.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const AT = { month: '2026-10', window: ['2026-07', '2026-08', '2026-09'] };
const target = (over: Partial<BudgetTarget> = {}): BudgetTarget => ({
  id: 'bt-gro', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amountCents: 42500, ...over,
});
const CATEGORIES = [
  { id: 'cat-gro', name: 'Groceries', parentId: null }, { id: 'cat-din', name: 'Dining out', parentId: null }, { id: 'cat-gas', name: 'Gas', parentId: null },
];
const SPEND = [
  { month: '2026-07', category: 'Groceries', accountId: 'a', amount: 420 }, { month: '2026-08', category: 'Groceries', accountId: 'a', amount: 420 },
  { month: '2026-09', category: 'Groceries', accountId: 'a', amount: 420 },
  { month: '2026-08', category: 'Dining out', accountId: 'a', amount: 540 },
  { month: '2026-09', category: 'Gas', accountId: 'a', amount: 285 },
];

const SETTINGS = { timezone: 'America/New_York', excludedCategoryIds: ['cat-x'], categoryParents: {}, spendingOn: true, spendingAccountIds: ['a'] };

function readers(over: Partial<BudgetReaders> = {}) {
  const recorded: ChangeDraft[] = [];
  const r: BudgetReaders = {
    settings: vi.fn(() => SETTINGS),
    historyStart: vi.fn((): string | null => '2026-01-01'),
    spend: vi.fn(() => SPEND),
    categories: vi.fn(() => CATEGORIES),
    targets: vi.fn(async () => ({ enabled: true, targets: [] as BudgetTarget[] })),
    set: vi.fn(async (categoryId: string, amountCents: number) => target({ id: `bt-${categoryId}`, categoryId, amountCents })),
    record: vi.fn(async (drafts: ChangeDraft[]) => { recorded.push(...drafts); }),
    ...over,
  };
  return { r, recorded };
}
const chosen = (): BudgetSuggestion[] => suggestBudgets({
  now: NOW, timezone: 'America/New_York', spend: SPEND, categories: CATEGORIES, excludedCategoryIds: [], categoryParents: {}, targets: [],
}).suggestions;

describe('readBudgetSuggestions', () => {
  it("reads the window's spending, the catalog and the budgets, and suggests", async () => {
    const { r } = readers({ targets: vi.fn(async () => ({ enabled: true, targets: [target({ categoryId: 'cat-din' })] })) });
    const read = await readBudgetSuggestions(r, NOW);
    expect(r.spend).toHaveBeenCalledWith('2026-07-01', '2026-10-01', SETTINGS);
    expect(r.historyStart).toHaveBeenCalledWith(SETTINGS);
    if (!read.ok) throw new Error(read.reason);
    expect(read.result.suggestions.map((s) => `${s.name} ${s.cents}`)).toEqual(['Groceries 42000', 'Gas 9500']);
    expect(read.result.candidates.map((s) => s.name)).toEqual(['Groceries', 'Dining out', 'Gas']);
  });

  it('says the database could not be read — never "nothing spent"', async () => {
    const { r } = readers({ settings: vi.fn(() => { throw new Error('Could not read the Wealthfolio database'); }) });
    expect(await readBudgetSuggestions(r, NOW)).toEqual({ ok: false, reason: 'database' });
  });

  it("says the Spending tracker is off, from Wealthfolio's settings or from its empty budget", async () => {
    const off = readers({ settings: vi.fn(() => ({ ...SETTINGS, spendingOn: false })) });
    expect(await readBudgetSuggestions(off.r, NOW)).toEqual({ ok: false, reason: 'spending-off' });
    const empty = readers({ targets: vi.fn(async () => ({ enabled: false, targets: [] })) });
    expect(await readBudgetSuggestions(empty.r, NOW)).toEqual({ ok: false, reason: 'spending-off' });
  });

  it('says the database could not be read when the spend or the history start cannot be', async () => {
    const spend = readers({ spend: vi.fn(() => { throw new Error('unreadable'); }) });
    expect(await readBudgetSuggestions(spend.r, NOW)).toEqual({ ok: false, reason: 'database' });
    const history = readers({ historyStart: vi.fn(() => { throw new Error('unreadable'); }) });
    expect(await readBudgetSuggestions(history.r, NOW)).toEqual({ ok: false, reason: 'database' });
  });

  it('passes the history start on: a ledger that began mid-August has only September, and a new install has not enough history', async () => {
    const aug = readers({ historyStart: vi.fn(() => '2026-08-15') });
    const read = await readBudgetSuggestions(aug.r, NOW);
    if (!read.ok) throw new Error(read.reason);
    expect(read.result.monthsUsed).toEqual(['2026-09']);
    expect(read.result.suggestions.map((s) => `${s.name} ${s.cents}`)).toEqual(['Groceries 42000', 'Gas 28500']);
    const fresh = readers({ historyStart: vi.fn(() => '2026-10-01') });
    const none = await readBudgetSuggestions(fresh.r, NOW);
    if (!none.ok) throw new Error(none.reason);
    expect(none.result).toMatchObject({ notEnoughHistory: true, suggestions: [] });
  });

  it('reads no activities at all as null history: not enough history', async () => {
    const { r } = readers({ historyStart: vi.fn(() => null) });
    const read = await readBudgetSuggestions(r, NOW);
    if (!read.ok) throw new Error(read.reason);
    expect(read.result).toMatchObject({ notEnoughHistory: true, suggestions: [] });
  });

  it("says so when the budgets can't be read", async () => {
    const { r } = readers({ targets: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    expect(await readBudgetSuggestions(r, NOW)).toEqual({ ok: false, reason: 'budgets' });
  });
});

describe('applyBudgetSuggestions', () => {
  it('never overwrites a budget added since the list was shown: re-reads, writes the rest, logs each', async () => {
    const { r, recorded } = readers({
      targets: vi.fn(async () => ({ enabled: true, targets: [target({ id: 'bt-new', categoryId: 'cat-din', amountCents: 20000 })] })),
    });
    const all = chosen();
    expect(all.map((s) => s.name)).toEqual(['Groceries', 'Dining out', 'Gas']);
    const result = await applyBudgetSuggestions(r, all, AT, NOW);
    if (!result.ok) throw new Error('refused');
    expect(r.set).toHaveBeenCalledTimes(2);
    expect(r.set).toHaveBeenCalledWith('cat-gro', 42000);
    expect(r.set).toHaveBeenCalledWith('cat-gas', 9500);
    expect(result.outcome.alreadySet.map((s) => s.name)).toEqual(['Dining out']);
    expect(result.outcome.set.map((x) => x.target.id)).toEqual(['bt-cat-gro', 'bt-cat-gas']);
    expect(result.outcome.failed).toEqual([]);
    expect(recorded).toEqual([
      expect.objectContaining({
        kind: 'budget-set', actor: 'you', summary: 'Set a $420.00 monthly budget for Groceries',
        why: 'Your average for Jul–Sep, rounded up to the nearest $5',
        after: expect.objectContaining({ targetId: 'bt-cat-gro', categoryId: 'cat-gro', amountCents: 42000 }),
      }),
      expect.objectContaining({ summary: 'Set a $95.00 monthly budget for Gas', after: expect.objectContaining({ targetId: 'bt-cat-gas' }) }),
    ]);
  });

  it('logs the amount Wealthfolio stored', async () => {
    const { r, recorded } = readers({ set: vi.fn(async (categoryId: string) => target({ id: 'bt-x', categoryId, amountCents: 41999 })) });
    await applyBudgetSuggestions(r, chosen().slice(0, 1), AT, NOW);
    expect(recorded[0].after).toMatchObject({ targetId: 'bt-x', amountCents: 41999 });
  });

  it('keeps going when one POST fails, and says which', async () => {
    const { r, recorded } = readers({
      set: vi.fn(async (categoryId: string, amountCents: number) => {
        if (categoryId === 'cat-din') throw new Error('setBudgetTarget failed: 500 - database is locked');
        return target({ id: `bt-${categoryId}`, categoryId, amountCents });
      }),
    });
    const result = await applyBudgetSuggestions(r, chosen(), AT, NOW);
    if (!result.ok) throw new Error('refused');
    expect(result.outcome.set.map((x) => x.suggestion.name)).toEqual(['Groceries', 'Gas']);
    expect(result.outcome.failed).toEqual([{ suggestion: expect.objectContaining({ name: 'Dining out' }), message: 'setBudgetTarget failed: 500 - database is locked' }]);
    expect(recorded.map((d) => d.subject.categoryName)).toEqual(['Groceries', 'Gas']);
  });

  it("writes nothing when the budget can't be re-read, or the Spending tracker went off", async () => {
    const down = readers({ targets: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    expect(await applyBudgetSuggestions(down.r, chosen(), AT, NOW)).toEqual({ ok: false });
    expect(down.r.set).not.toHaveBeenCalled();
    const off = readers({ targets: vi.fn(async () => ({ enabled: false, targets: [] })) });
    expect(await applyBudgetSuggestions(off.r, chosen(), AT, NOW)).toEqual({ ok: false });
    expect(off.r.set).not.toHaveBeenCalled();
  });

  it('still logs a budget whose POST landed but whose reply named no target, with a null id', async () => {
    const { r, recorded } = readers({ set: vi.fn(async () => null) });
    const result = await applyBudgetSuggestions(r, chosen().slice(0, 1), AT, NOW);
    expect(result).toMatchObject({ ok: true, outcome: { set: [{ target: null }], failed: [] } });
    expect(recorded).toEqual([expect.objectContaining({
      kind: 'budget-set', after: expect.objectContaining({ targetId: null, categoryId: 'cat-gro', amountCents: 42000 }),
    })]);
  });

  it('a log that cannot be written never costs the budget', async () => {
    const { r } = readers({ record: vi.fn(async () => { throw new Error('secret write failed'); }) });
    const result = await applyBudgetSuggestions(r, chosen().slice(0, 1), AT, NOW);
    expect(result).toMatchObject({ ok: true, outcome: { set: [expect.objectContaining({ target: expect.objectContaining({ id: 'bt-cat-gro' }) })] } });
  });
});

describe('companionBudgetReaders', () => {
  it('reads the settings strictly and records into the companion’s change log', async () => {
    const data = new Map<string, string>();
    const client = {
      getAddonSecret: vi.fn(async (_a: string, k: string) => data.get(k) ?? null),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { data.set(k, v); }),
      getBudgetTargets: vi.fn(async () => ({ enabled: true, targets: [] })),
      setDefaultBudgetTarget: vi.fn(async () => target()),
    };
    const r = companionBudgetReaders(client, '/nope/wealthfolio.db');
    expect(() => r.settings()).toThrow();
    expect(() => r.spend('2026-07-01', '2026-10-01', SETTINGS)).toThrow();
    expect(() => r.historyStart(SETTINGS)).toThrow();
    await r.set('cat-gro', 42500);
    expect(client.setDefaultBudgetTarget).toHaveBeenCalledWith('cat-gro', 42500);
    await r.record([budgetSetChange({ targetId: 't', categoryId: 'c', categoryName: 'G', amountCents: 500 })], NOW);
    const bucket = JSON.parse(data.get('change_log:companion:2026-10')!);
    expect(bucket.entries).toEqual([expect.objectContaining({ kind: 'budget-set', writer: 'companion' })]);
  });
});
