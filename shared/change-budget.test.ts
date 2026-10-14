import { describe, it, expect, vi } from 'vitest';
import type { BudgetTarget } from './budget-suggest.js';
import { budgetSetChange, CHANGE_KINDS, reversalChange, stampChange, type ChangeDraft, type ChangeEntry } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import { changeBeforeAfter, changeGroupOf, changeSearchText } from './change-view.js';
import {
  currentBudgetTargetId, planChangeUndo, undoAvailability, REDO_FROM_TELEGRAM, UNDO_FROM_TELEGRAM, UNDO_NOT_POSSIBLE,
  UNDO_UNREACHABLE, type UndoDecision, type UndoOp, type UndoPlan,
} from './change-undo.js';
import { runChangeUndo, type UndoIo } from './change-undo-run.js';
import { createFakeHost } from './fake-host.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const WHY = 'Your average for Jul–Sep, rounded up to the nearest $5';
const groceries = (): ChangeEntry => stampChange(budgetSetChange({
  targetId: 'bt-gro', categoryId: 'cat-gro', categoryName: 'Groceries', amountCents: 42500, why: WHY,
}), 'companion', new Date('2026-10-14T09:00:00Z'));
const target = (over: Partial<BudgetTarget> = {}): BudgetTarget => ({
  id: 'bt-gro', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amountCents: 42500, ...over,
});
const reversal = (e: ChangeEntry, op: UndoOp, extra: Record<string, unknown> = {}) => stampChange(reversalChange(e, op, extra), 'companion', NOW);
const ok = (d: UndoDecision): UndoPlan => {
  if (!d.ok) throw new Error(`refused: ${d.reason}`);
  return d.plan;
};
const reason = (d: UndoDecision) => (d.ok ? 'planned' : d.reason);

describe('budget-set: the entry', () => {
  it('says what was set, raw, and carries what Undo needs', () => {
    const odd = "Joe's *Diner*_[1]";
    expect(budgetSetChange({ targetId: 't', categoryId: 'c', categoryName: odd, amountCents: 2000 }).summary)
      .toBe(`Set a $20.00 monthly budget for ${odd}`);
    expect(groceries()).toMatchObject({
      actor: 'you', kind: 'budget-set', undoable: true, why: WHY,
      summary: 'Set a $425.00 monthly budget for Groceries',
      subject: { categoryName: 'Groceries' },
      before: { targetId: null },
      after: { targetId: 'bt-gro', categoryId: 'cat-gro', categoryName: 'Groceries', amountCents: 42500, periodKey: 'default', taxonomyId: 'spending_categories' },
    });
    expect(CHANGE_KINDS).toContain('budget-set');
  });

  it('files under Categories, reads "No budget → $425.00 a month", and is found by its category', () => {
    expect(changeGroupOf('budget-set')).toBe('categories');
    expect(changeBeforeAfter(groceries())).toBe('No budget → $425.00 a month');
    expect(changeSearchText(groceries())).toContain('groceries');
  });

  it('is undone from Telegram, not the app: the add-on has no budget API', () => {
    const app = { host: 'addon' as const, companionVersion: '1.61.0' };
    expect(undoAvailability(groceries(), app)).toEqual({ kind: 'telegram', op: 'undo', text: UNDO_FROM_TELEGRAM });
    expect(undoAvailability({ ...groceries(), undone: { by: 'c', at: NOW.toISOString() } }, app))
      .toEqual({ kind: 'telegram', op: 'redo', text: REDO_FROM_TELEGRAM });
    expect(undoAvailability(groceries(), { host: 'addon', companionVersion: null })).toEqual({ kind: 'none' });
    expect(undoAvailability(groceries(), { host: 'companion', companionVersion: '1.61.0' })).toEqual({ kind: 'ready', op: 'undo' });
  });
});

describe('budget-set: the planner', () => {
  it('Undo deletes the target it created', () => {
    const plan = ok(planChangeUndo(groceries(), 'undo', { budgetTargets: [target(), target({ id: 'bt-din', categoryId: 'cat-din' })] }, { latest: null }));
    expect(plan).toEqual({
      op: 'undo', needsSync: false, budgetAfter: null, done: 'Undone — Groceries has no budget.',
      steps: [{ do: 'delete-budget', targetId: 'bt-gro' }],
    });
  });

  it('refuses when the target changed since: another amount, or no longer the default', () => {
    expect(reason(planChangeUndo(groceries(), 'undo', { budgetTargets: [target({ amountCents: 50000 })] }, { latest: null })))
      .toBe('It has changed since — nothing was undone.');
    expect(reason(planChangeUndo(groceries(), 'undo', { budgetTargets: [target({ periodKey: '2026-10' })] }, { latest: null })))
      .toBe('It has changed since — nothing was undone.');
  });

  it('refuses when the target is gone', () => {
    expect(reason(planChangeUndo(groceries(), 'undo', { budgetTargets: [target({ id: 'bt-other' })] }, { latest: null })))
      .toBe('That budget is already gone — nothing was undone.');
  });

  it('Redo puts it back, unless the category has a default budget again', () => {
    const e = groceries();
    const latest = reversal(e, 'undo', { targetId: null });
    expect(ok(planChangeUndo(e, 'redo', { budgetTargets: [target({ periodKey: '2026-10', id: 'bt-oct' })] }, { latest }))).toEqual({
      op: 'redo', needsSync: false, budgetAfter: 'created', done: 'Redone — Groceries has its $425.00 budget back.',
      steps: [{ do: 'set-budget', categoryId: 'cat-gro', amountCents: 42500 }],
    });
    expect(reason(planChangeUndo(e, 'redo', { budgetTargets: [target({ id: 'bt-new', amountCents: 10000 })] }, { latest })))
      .toBe('Groceries has a budget again — nothing was redone.');
  });

  it('Redo goes over a $0 default (the cleared state) but not a NaN one or a non-zero one', () => {
    const e = groceries();
    const latest = reversal(e, 'undo', { targetId: null });
    expect(ok(planChangeUndo(e, 'redo', { budgetTargets: [target({ id: 'bt-zero', amountCents: 0 })] }, { latest })).steps)
      .toEqual([{ do: 'set-budget', categoryId: 'cat-gro', amountCents: 42500 }]);
    expect(reason(planChangeUndo(e, 'redo', { budgetTargets: [target({ id: 'bt-nan', amountCents: NaN })] }, { latest })))
      .toBe('Groceries has a budget again — nothing was redone.');
    expect(reason(planChangeUndo(e, 'redo', { budgetTargets: [target({ id: 'bt-m', periodKey: '2026-10', amountCents: 0 })] }, { latest: null })))
      .not.toBe('Groceries has a budget again — nothing was redone.');
  });

  it('acts on the target the last Redo created', () => {
    const e = groceries();
    const redone = reversal(e, 'redo', { targetId: 'bt-again' });
    expect(currentBudgetTargetId(e, null)).toBe('bt-gro');
    expect(currentBudgetTargetId(e, redone)).toBe('bt-again');
    expect(ok(planChangeUndo(e, 'undo', { budgetTargets: [target({ id: 'bt-again' })] }, { latest: redone })).steps)
      .toEqual([{ do: 'delete-budget', targetId: 'bt-again' }]);
  });

  it('finds the default target by category when no id was recorded', () => {
    const e = groceries();
    const redone = reversal(e, 'redo', { targetId: null });
    const found = [target({ id: 'bt-found' }), target({ id: 'bt-oct', periodKey: '2026-10' })];
    expect(ok(planChangeUndo(e, 'undo', { budgetTargets: found }, { latest: redone })).steps)
      .toEqual([{ do: 'delete-budget', targetId: 'bt-found' }]);
    const bare = { ...groceries(), after: { ...groceries().after as object, targetId: null } } as ChangeEntry;
    expect(ok(planChangeUndo(bare, 'undo', { budgetTargets: found }, { latest: null })).steps)
      .toEqual([{ do: 'delete-budget', targetId: 'bt-found' }]);
    expect(reason(planChangeUndo(e, 'undo', { budgetTargets: [target({ id: 'bt-found', amountCents: 1 })] }, { latest: redone })))
      .toBe('It has changed since — nothing was undone.');
    expect(reason(planChangeUndo(e, 'undo', { budgetTargets: [] }, { latest: redone })))
      .toBe('That budget is already gone — nothing was undone.');
  });

  it("can't be undone without what it recorded", () => {
    const bare = { ...groceries(), after: { targetId: 'bt-gro' } };
    expect(reason(planChangeUndo(bare, 'undo', { budgetTargets: [target()] }, { latest: null }))).toBe(UNDO_NOT_POSSIBLE);
  });
});

describe('budget-set: the runner, on the companion', () => {
  function harness(targets: BudgetTarget[], budgets: Partial<NonNullable<UndoIo['budgets']>> = {}) {
    const store = [...targets];
    const log: ChangeEntry[] = [];
    const io: UndoIo = {
      host: createFakeHost().host,
      secrets: { get: async () => null, set: async () => {} },
      budgets: {
        targets: vi.fn(async () => store.map((t) => ({ ...t }))),
        set: vi.fn(async (categoryId: string, amountCents: number) => {
          store.push(target({ id: 'bt-again', categoryId, amountCents }));
          return 'bt-again';
        }),
        remove: vi.fn(async (id: string) => {
          const i = store.findIndex((t) => t.id === id);
          if (i >= 0) store.splice(i, 1);
        }),
        ...budgets,
      },
      record: vi.fn(async (d: ChangeDraft) => { log.unshift(stampChange(d, 'companion', NOW)); }),
      where: { host: 'companion', companionVersion: null },
    };
    const asItem = (e: ChangeEntry): ChangeLogItem => {
      const latest = log.find((x) => x.reverses?.id === e.id);
      return latest?.reverses?.op === 'undo' ? { ...e, undone: { by: latest.id, at: latest.at } } : { ...e };
    };
    const run = (e: ChangeEntry, op: UndoOp) => runChangeUndo(asItem(e), [...log, e], op, io, 'plain', NOW);
    return { store, log, io, run };
  }

  it('Undo deletes the target and records it; Redo re-creates it; the next Undo deletes the new one', async () => {
    const e = groceries();
    const h = harness([target(), target({ id: 'bt-din', categoryId: 'cat-din' })]);
    expect(await h.run(e, 'undo')).toEqual({ ok: true, message: 'Undone — Groceries has no budget.', needsSync: false });
    expect(h.io.budgets!.remove).toHaveBeenCalledWith('bt-gro');
    expect(h.store.map((t) => t.id)).toEqual(['bt-din']);
    expect(h.log[0]).toMatchObject({ kind: 'budget-set', reverses: { id: e.id, op: 'undo' }, after: { targetId: null } });

    expect(await h.run(e, 'redo')).toMatchObject({ ok: true, message: 'Redone — Groceries has its $425.00 budget back.' });
    expect(h.io.budgets!.set).toHaveBeenCalledWith('cat-gro', 42500);
    expect(h.log[0]).toMatchObject({ reverses: { id: e.id, op: 'redo' }, after: { targetId: 'bt-again' } });

    expect(await h.run(e, 'undo')).toMatchObject({ ok: true });
    expect(h.io.budgets!.remove).toHaveBeenLastCalledWith('bt-again');
    expect(h.store.map((t) => t.id)).toEqual(['bt-din']);
  });

  it('changes nothing when the amount was edited in Wealthfolio since', async () => {
    const h = harness([target({ amountCents: 50000 })]);
    expect(await h.run(groceries(), 'undo')).toEqual({ ok: false, message: 'It has changed since — nothing was undone.' });
    expect(h.io.budgets!.remove).not.toHaveBeenCalled();
    expect(h.log).toEqual([]);
  });

  it("says it couldn't reach Wealthfolio when the budgets can't be read, and changes nothing", async () => {
    const h = harness([target()], { targets: vi.fn(async () => { throw new Error('spending tracking is off'); }) });
    expect(await h.run(groceries(), 'undo')).toEqual({ ok: false, message: UNDO_UNREACHABLE });
    expect(h.io.budgets!.remove).not.toHaveBeenCalled();
  });

  it('a Redo whose reply names no target is still recorded, and Undo then finds the budget by category', async () => {
    const e = groceries();
    const h = harness([], { set: vi.fn(async () => null) });
    h.log.unshift(reversal(e, 'undo', { targetId: null }));
    expect(await h.run(e, 'redo')).toMatchObject({ ok: true });
    expect(h.log[0]).toMatchObject({ reverses: { id: e.id, op: 'redo' }, after: { targetId: null } });
    h.store.push(target({ id: 'bt-written' }));
    expect(await h.run(e, 'undo')).toMatchObject({ ok: true, message: 'Undone — Groceries has no budget.' });
    expect(h.io.budgets!.remove).toHaveBeenCalledWith('bt-written');
  });

  it('that fallback refuses when the found budget was edited by hand', async () => {
    const e = groceries();
    const h = harness([], { set: vi.fn(async () => null) });
    h.log.unshift(reversal(e, 'undo', { targetId: null }));
    await h.run(e, 'redo');
    h.store.push(target({ id: 'bt-written', amountCents: 99900 }));
    expect(await h.run(e, 'undo')).toEqual({ ok: false, message: 'It has changed since — nothing was undone.' });
    expect(h.io.budgets!.remove).not.toHaveBeenCalled();
  });

  it('a Redo whose POST throws is recorded when the default now holds exactly the amount, with the found id', async () => {
    const e = groceries();
    const h = harness([], { set: vi.fn(async () => { h.store.push(target({ id: 'bt-landed' })); throw new Error('socket hang up'); }) });
    h.log.unshift(reversal(e, 'undo', { targetId: null }));
    expect(await h.run(e, 'redo')).toMatchObject({ ok: true, message: 'Redone — Groceries has its $425.00 budget back.' });
    expect(h.log[0]).toMatchObject({ reverses: { id: e.id, op: 'redo' }, after: { targetId: 'bt-landed' } });
  });

  it('a Redo whose POST throws keeps the failure when nothing, or another amount, landed', async () => {
    for (const landed of [null, target({ id: 'bt-other', amountCents: 10000 })]) {
      const e = groceries();
      const h = harness([], { set: vi.fn(async () => { if (landed) h.store.push(landed); throw new Error('boom'); }) });
      h.log.unshift(reversal(e, 'undo', { targetId: null }));
      const n = h.log.length;
      expect(await h.run(e, 'redo')).toEqual({ ok: false, message: "Couldn't finish the redo: boom" });
      expect(h.log.length).toBe(n);
    }
  });

  it("a Redo that can't re-read the budgets refuses and makes no POST", async () => {
    const e = groceries();
    const h = harness([], { targets: vi.fn(async () => { throw new Error('down'); }) });
    h.log.unshift(reversal(e, 'undo', { targetId: null }));
    expect(await h.run(e, 'redo')).toEqual({ ok: false, message: UNDO_UNREACHABLE });
    expect(h.io.budgets!.set).not.toHaveBeenCalled();
  });

  it('refuses on a host with no budget API', async () => {
    const h = harness([target()]);
    delete h.io.budgets;
    expect(await h.run(groceries(), 'undo')).toEqual({ ok: false, message: UNDO_NOT_POSSIBLE });
  });
});
