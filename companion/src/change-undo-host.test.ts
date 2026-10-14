import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { budgetSetChange, categoryFiledChange, categoryRuleCreatedChange, importChange, stampChange, venmoNoteChange } from '../../shared/change-entries.js';
import type { BudgetTarget } from '../../shared/budget-suggest.js';
import { UNDO_UPDATE_ADDON } from '../../shared/change-undo.js';
import { runChangeUndo } from '../../shared/change-undo-run.js';
import { createFakeHost } from '../../shared/fake-host.js';
import { companionRuleFiledCount, companionUndoIo, type UndoClient } from './change-undo-host.js';
import { WealthfolioClient } from './wealthfolio.js';
import { readCompanionChangeLog } from './change-log-host.js';

const NOW = new Date('2026-10-13T15:00:00Z');

function client(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const c = {
    data,
    getAddonSecret: vi.fn(async (_a: string, k: string) => data.get(k) ?? null),
    setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { data.set(k, v); }),
    getActivityAssignments: vi.fn(async () => [{ taxonomyId: 'spending_categories', categoryId: 'cat-din', source: 'manual' }]),
    assignActivityCategory: vi.fn(async () => {}),
    unassignActivityCategory: vi.fn(async () => {}),
    listCategorizationRules: vi.fn(async () => [] as Array<{ id: string; name: string; pattern: string; categoryId: string | null }>),
    createCategorizationRule: vi.fn(async () => 'rule-9'),
    deleteCategorizationRule: vi.fn(async () => {}),
    getBudgetTargets: vi.fn(async () => ({
      enabled: true,
      targets: [{ id: 'bt-gro', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amountCents: 42500 }],
    })),
    setDefaultBudgetTarget: vi.fn(async (categoryId: string, amountCents: number): Promise<BudgetTarget | null> => ({
      id: 'bt-gro', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId, amountCents,
    })),
    deleteBudgetTarget: vi.fn(async () => {}),
  };
  return c as typeof c & UndoClient;
}

describe('companionUndoIo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('undoes your Telegram filing by activity id, and records it in the companion’s own bucket', async () => {
    const c = client();
    const filing = stampChange(categoryFiledChange({
      actor: 'you', activityId: 'act-5', description: 'VENMO *J SMITH',
      before: null, after: { categoryId: 'cat-din', categoryName: 'Dining', taxonomyId: 'spending_categories' },
    }), 'companion', new Date('2026-10-13T09:00:00Z'));
    const io = companionUndoIo(c, '/nope.db', createFakeHost().host);
    expect(await runChangeUndo(filing, [filing], 'undo', io, 'plain', NOW)).toEqual({ ok: true, message: 'Undone — no category.', needsSync: false });
    expect(c.unassignActivityCategory).toHaveBeenCalledWith('act-5', 'spending_categories');
    const bucket = JSON.parse(c.data.get('change_log:companion:2026-10')!);
    expect(bucket.entries).toEqual([expect.objectContaining({ writer: 'companion', actor: 'you', reverses: { id: filing.id, op: 'undo' } })]);
    // The merged read shows the original as undone (the original itself lives
    // in whichever bucket wrote it; here it is not stored, so only the undo shows).
    expect((await readCompanionChangeLog(c, NOW)).entries[0].summary).toBe('Undid: Filed VENMO *J SMITH under Dining');
  });

  it('re-creates a rule with the spending taxonomy and the losing priority /categorize uses', async () => {
    const c = client();
    const io = companionUndoIo(c, '/nope.db', createFakeHost().host);
    await io.rules!.create({ name: 'Telegram: X', pattern: 'X', categoryId: 'cat-gro' });
    expect(c.createCategorizationRule).toHaveBeenCalledWith({ name: 'Telegram: X', pattern: 'X', categoryId: 'cat-gro', taxonomyId: 'spending_categories', priority: 50 });
    expect(await io.categories!.assignments('act-5')).toEqual([{ taxonomyId: 'spending_categories', categoryId: 'cat-din' }]);
    expect(io.where).toEqual({ host: 'companion', companionVersion: expect.any(String) });
  });

  it('reads an import’s state through the host and the skip list through the add-on secrets', async () => {
    const c = client();
    const fh = createFakeHost({
      mapping: { 'sfin-1': 'wf-a' },
      existing: new Map([['wf-a', [{ id: 'act-1', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-11', amount: 6.5, comment: 'SQ *BLUE · tx-1', sourceGroupId: null }]]]),
    });
    const imported = stampChange(importChange({
      account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' }, txKey: 'sfin-1\u0000tx-1', activityId: 'act-1', description: 'SQ *BLUE',
      amountCents: -650, date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
    }), 'companion', NOW);
    expect(await runChangeUndo(imported, [imported], 'undo', companionUndoIo(c, '/nope.db', fh.host), 'plain', NOW)).toMatchObject({ ok: true });
    expect(JSON.parse(c.data.get('skipped_transactions')!)).toEqual([expect.objectContaining({ account: 'sfin-1', txId: 'tx-1' })]);
    expect(fh.activities.get('wf-a')).toEqual([]);
  });

  it('a Venmo note’s Undo waits for the installed add-on to read noVenmoNote (ruling P3-K), then goes through', async () => {
    const seed = () => ({
      mapping: { 'sfin-1': 'wf-a' },
      existing: new Map([['wf-a', [{ id: 'act-v', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-04', amount: 25, comment: 'VENMO PAYMENT 1023 · Venmo: Rent · tx-1', sourceGroupId: null }]]]),
    });
    const note = stampChange(venmoNoteChange({
      account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' }, txKey: 'sfin-1\u0000tx-1', activityId: 'act-v', description: 'VENMO PAYMENT 1023',
      amountCents: -2500, date: '2026-10-04', beforeNote: 'VENMO PAYMENT 1023 · tx-1', afterNote: 'VENMO PAYMENT 1023 · Venmo: Rent · tx-1', note: 'Rent',
    }), 'companion', NOW);
    const old = client({ installed_addon_version: '1.60.0' });
    const oldHost = createFakeHost(seed());
    expect(await runChangeUndo(note, [note], 'undo', companionUndoIo(old, '/nope.db', oldHost.host), 'plain', NOW))
      .toEqual({ ok: false, message: UNDO_UPDATE_ADDON });
    expect(UNDO_UPDATE_ADDON.startsWith('Update the add-on first — ')).toBe(true);
    expect(old.setAddonSecret).not.toHaveBeenCalled();
    expect(oldHost.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · Venmo: Rent · tx-1');
    const current = client({ installed_addon_version: '1.61.0' });
    const host = createFakeHost(seed());
    expect(await runChangeUndo(note, [note], 'undo', companionUndoIo(current, '/nope.db', host.host), 'plain', NOW)).toMatchObject({ ok: true });
    expect(host.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · tx-1');
  });

  it('undoes a rule the person already deleted in Wealthfolio (DELETE answers 404): succeeds and logs the undo', async () => {
    const c = client();
    c.listCategorizationRules.mockResolvedValue([{ id: 'rule-7', name: 'Telegram: X', pattern: 'X', categoryId: 'cat-gro' }]);
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, text: async () => 'Rule not found' }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const real = new WealthfolioClient('http://wf');
      c.deleteCategorizationRule.mockImplementation((id: string) => real.deleteCategorizationRule(id));
      const rule = stampChange(categoryRuleCreatedChange({ ruleId: 'rule-7', name: 'Telegram: X', pattern: 'X', categoryId: 'cat-gro', categoryName: 'Groceries' }), 'companion', NOW);
      const io = companionUndoIo(c, '/nope.db', createFakeHost().host);
      expect(await runChangeUndo(rule, [rule], 'undo', io, 'plain', NOW)).toMatchObject({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(c.data.get('change_log:companion:2026-10')!).entries).toEqual([expect.objectContaining({ reverses: { id: rule.id, op: 'undo' } })]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('undoes a budget set from /budgets by deleting its target, re-reading Wealthfolio first, and redoes it with the same POST', async () => {
    const c = client();
    const budget = stampChange(budgetSetChange({ targetId: 'bt-gro', categoryId: 'cat-gro', categoryName: 'Groceries', amountCents: 42500 }), 'companion', NOW);
    const io = companionUndoIo(c, '/nope.db', createFakeHost().host);
    expect(await runChangeUndo(budget, [budget], 'undo', io, 'plain', NOW)).toEqual({ ok: true, message: 'Undone — Groceries has no budget.', needsSync: false });
    expect(c.getBudgetTargets).toHaveBeenCalledTimes(1);
    expect(c.deleteBudgetTarget).toHaveBeenCalledWith('bt-gro');
    expect(await io.budgets!.set('cat-gro', 42500)).toBe('bt-gro');
    expect(c.setDefaultBudgetTarget).toHaveBeenCalledWith('cat-gro', 42500);
  });

  it('lends the runner null, not a throw, when the POST landed but the reply named no target', async () => {
    const c = client();
    c.setDefaultBudgetTarget.mockResolvedValueOnce(null);
    const io = companionUndoIo(c, '/nope.db', createFakeHost().host);
    expect(await io.budgets!.set('cat-gro', 42500)).toBeNull();
  });

  it("won't undo a budget while Wealthfolio's Spending tracker is off: an empty budget is not a deleted one", async () => {
    const c = client();
    c.getBudgetTargets.mockResolvedValueOnce({ enabled: false, targets: [] });
    const budget = stampChange(budgetSetChange({ targetId: 'bt-gro', categoryId: 'cat-gro', categoryName: 'Groceries', amountCents: 42500 }), 'companion', NOW);
    const io = companionUndoIo(c, '/nope.db', createFakeHost().host);
    expect(await runChangeUndo(budget, [budget], 'undo', io, 'plain', NOW)).toEqual({ ok: false, message: "Couldn't reach Wealthfolio — nothing undone." });
    expect(c.deleteBudgetTarget).not.toHaveBeenCalled();
  });

  it('counts a rule’s filings only for a rule entry, and says unknown without the database', () => {
    const rule = stampChange(categoryRuleCreatedChange({ ruleId: 'r', name: 'n', pattern: 'X', categoryId: 'c', categoryName: 'G' }), 'companion', NOW);
    expect(companionRuleFiledCount('/nope.db', rule)).toBeNull();
    const filing = stampChange(categoryFiledChange({ actor: 'you', activityId: 'a', description: 'X', before: null, after: { categoryId: 'c', categoryName: 'G' } }), 'companion', NOW);
    expect(companionRuleFiledCount('/nope.db', filing)).toBeNull();
  });
});
