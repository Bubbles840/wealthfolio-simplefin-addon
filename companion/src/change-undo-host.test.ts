import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { categoryFiledChange, categoryRuleCreatedChange, importChange, stampChange } from '../../shared/change-entries.js';
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

  it('counts a rule’s filings only for a rule entry, and says unknown without the database', () => {
    const rule = stampChange(categoryRuleCreatedChange({ ruleId: 'r', name: 'n', pattern: 'X', categoryId: 'c', categoryName: 'G' }), 'companion', NOW);
    expect(companionRuleFiledCount('/nope.db', rule)).toBeNull();
    const filing = stampChange(categoryFiledChange({ actor: 'you', activityId: 'a', description: 'X', before: null, after: { categoryId: 'c', categoryName: 'G' } }), 'companion', NOW);
    expect(companionRuleFiledCount('/nope.db', filing)).toBeNull();
  });
});
