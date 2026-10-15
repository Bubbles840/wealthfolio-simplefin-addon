import { describe, it, expect, vi } from 'vitest';
import { categoryRuleCreatedChange, mappingRuleCreatedChange, stampChange, type ChangeDraft, type ChangeEntry } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import { MAPPING_RULES_SECRET_KEY, runChangeUndo, UNDO_MAPPING_RULES_UNREADABLE, type UndoIo } from './change-undo-run.js';
import { createFakeHost } from './fake-host.js';
import { mapTransactionWithSource, paybackMappingRule, ruleApplies, sameMappingRule } from './mapper.js';
import { makePaybackRules, paybackBreadth, paybackPatternRefusal, type PaybackRulesInput, type PaybackRulesIo } from './payback.js';
import {
  PAYBACK_CAT_RULE_REDONE, PAYBACK_CAT_RULE_UNDONE, PAYBACK_RULES_EXIST, PAYBACK_RULES_GENERIC, PAYBACK_RULES_REFUSED, PAYBACK_RULES_SAVE_FAILED,
  PAYBACK_RULES_SHADOWED, PAYBACK_TX_RULE_REDONE, PAYBACK_TX_RULE_UNDONE, PAYBACK_UNREACHABLE, PAYBACK_UPDATE_ADDON, paybackRulesConflict, paybackRulesStuck,
} from './payback-copy.js';
import { bankWords, categoryRulePattern, paybackRulePattern } from './rule-pattern.js';
import type { MappingRule } from './types.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const TODAY = '2026-10-14';
const RULE = paybackMappingRule('JANE DOE VENMO', 'wf-chk', TODAY);
const GLOBAL: MappingRule = { pattern: 'VENMO', matchType: 'contains', activityType: 'TRANSFER_IN' };
const INPUT: PaybackRulesInput = {
  pattern: 'JANE DOE VENMO', account: { id: 'wf-chk', name: 'PNC Checking' }, categoryId: 'cat-rest', categoryName: 'Restaurants',
  description: 'JANE DOE VENMO · Venmo: Dinner',
};

describe('a payback rule (W10)', () => {
  it('reads money in only, in its one account', () => {
    expect(RULE).toEqual({
      pattern: 'JANE DOE VENMO', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT', onlyMoneyIn: true, accountId: 'wf-chk', since: TODAY,
    });
    expect(ruleApplies(RULE, 'JANE DOE VENMO 1023', 25, 'wf-chk', TODAY)).toBe(true);
    expect(ruleApplies(RULE, 'JANE DOE VENMO 1023', -25, 'wf-chk', TODAY)).toBe(false);
    expect(ruleApplies(RULE, 'JANE DOE VENMO 1023', 0, 'wf-chk', TODAY)).toBe(false);
    expect(ruleApplies(RULE, 'JANE DOE VENMO 1023', 25, 'wf-sav', TODAY)).toBe(false);
    expect(ruleApplies(RULE, 'JANE DOE VENMO 1023', 25, undefined, TODAY)).toBe(false);
  });

  it('reads only transactions dated on or after the day it was made (I1)', () => {
    expect(ruleApplies(RULE, 'JANE DOE VENMO 1023', 25, 'wf-chk', '2026-10-13')).toBe(false);
    expect(ruleApplies(RULE, 'JANE DOE VENMO 1023', 25, 'wf-chk', '2026-10-15')).toBe(true);
    expect(ruleApplies(RULE, 'JANE DOE VENMO 1023', 25, 'wf-chk')).toBe(false);
    // A rule without `since` reads any day, as it always did.
    expect(ruleApplies({ ...RULE, since: undefined }, 'JANE DOE VENMO 1023', 25, 'wf-chk', '2020-01-01')).toBe(true);
  });

  it('types money in a payback, and leaves a payment out and another account as they were', () => {
    expect(mapTransactionWithSource('JANE DOE VENMO 1023', 25, [RULE], 'CASH', 'wf-chk', TODAY)).toEqual({ type: 'CREDIT', fromRule: true, subtype: 'REIMBURSEMENT' });
    expect(mapTransactionWithSource('JANE DOE VENMO 1023', -25, [RULE], 'CASH', 'wf-chk', TODAY)).toEqual({ type: 'WITHDRAWAL', fromRule: false });
    expect(mapTransactionWithSource('JANE DOE VENMO 1023', 25, [RULE], 'CASH', 'wf-sav', TODAY)).toEqual({ type: 'DEPOSIT', fromRule: false });
  });

  it('leaves every older rule as it always read: either way, any account', () => {
    expect(ruleApplies(GLOBAL, 'VENMO PAYMENT', -25)).toBe(true);
    expect(ruleApplies(GLOBAL, 'VENMO PAYMENT', 25, 'wf-any')).toBe(true);
    expect(ruleApplies({ pattern: '(', matchType: 'regex', activityType: 'DEPOSIT' }, 'x', 1)).toBe(false);
  });

  it('is a different rule from one with the same words but no limits', () => {
    const plain: MappingRule = { pattern: 'JANE DOE VENMO', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' };
    expect(sameMappingRule(RULE, { ...RULE })).toBe(true);
    expect(sameMappingRule(RULE, plain)).toBe(false);
    expect(sameMappingRule(RULE, { ...RULE, accountId: 'wf-sav' })).toBe(false);
    expect(sameMappingRule(RULE, { ...RULE, since: '2026-10-01' })).toBe(false);
  });

  it('is built from the bank’s words, not the note the sync added', () => {
    expect(bankWords('VENMO CASHOUT · Venmo: Dinner')).toBe('VENMO CASHOUT');
    expect(bankWords('AMAZON MKTPL*2K4 · Amazon: Lawn')).toBe('AMAZON MKTPL*2K4');
    expect(paybackRulePattern('ZELLE FROM JANE DOE 8ZK1 · Venmo: Rent')).toBe('ZELLE FROM JANE DOE');
  });

  it('drops a leading reference token and a trailing date with its reference, for paybacks only (M4)', () => {
    expect(paybackRulePattern('*1234 CASHOUT VENMO ACH CREDIT')).toBe('CASHOUT VENMO ACH CREDIT');
    expect(paybackRulePattern('ZELLE FROM JANE DOE ON 10/09 REF # PNCAA0B1C2D3')).toBe('ZELLE FROM JANE DOE');
    expect(categoryRulePattern('ZELLE FROM JANE DOE ON 10/09 REF # PNCAA0B1C2D3')).not.toBe('ZELLE FROM JANE DOE');
  });

  it('refuses a pattern made only of generic bank words (I1)', () => {
    expect(paybackPatternRefusal(paybackRulePattern('DEPOSIT 123456'))).toBe(PAYBACK_RULES_GENERIC);
    expect(paybackPatternRefusal('DIRECT DEPOSIT ACH')).toBe(PAYBACK_RULES_GENERIC);
    expect(paybackPatternRefusal('VENMO CASHOUT')).toBe(PAYBACK_RULES_GENERIC);
    expect(paybackPatternRefusal('ZELLE FROM JANE DOE')).toBeNull();
    expect(paybackPatternRefusal('ACME PAYROLL')).toBeNull();
  });
});

describe('the preview breadth (I1, M6)', () => {
  const row = (id: string, description: string, amount = 14) => ({ id, description, amount });
  const rows = [
    row('self', 'JANE DOE VENMO'),
    row('waiting', 'JANE DOE VENMO 7781'),
    row('filed', 'JANE DOE VENMO · Venmo: Rent'),
    row('filed2', 'JANE DOE VENMO 1'),
    row('out', 'JANE DOE VENMO REVERSAL', -14),
    row('payroll', 'DIRECT DEPOSIT ACME PAYROLL', 2000),
  ];
  const base = { pattern: 'JANE DOE VENMO', accountId: 'wf-chk', since: TODAY, source: { id: 'self', description: 'JANE DOE VENMO' }, rows, waitingIds: new Set(['waiting', 'self']) };

  it('counts stored money-in rows the new rule would decide, split filed and waiting, over the whole list', () => {
    expect(paybackBreadth({ ...base, list: [] })).toEqual({ ok: true, filed: 2, waiting: 1 });
  });

  it('is not shadowed by an earlier rule in the list: the new rule sits first and decides those rows', () => {
    const earlier: MappingRule = { pattern: 'VENMO', matchType: 'contains', activityType: 'TRANSFER_IN' };
    const broad: MappingRule = { pattern: 'JANE DOE', matchType: 'contains', activityType: 'DEPOSIT' };
    expect(paybackBreadth({ ...base, list: [earlier, broad] })).toEqual({ ok: true, filed: 2, waiting: 1 });
  });

  it('refuses a generic pattern in words', () => {
    expect(paybackBreadth({ ...base, pattern: 'DEPOSIT', source: { id: 'self', description: 'DEPOSIT 123456' }, list: [] }))
      .toEqual({ ok: false, message: PAYBACK_RULES_GENERIC });
  });
});

/** The add-on's secrets, Wealthfolio's rules, and the change log, in memory. */
function world(over: { mapping?: string | null; wfRules?: Array<Record<string, any>>; io?: Partial<PaybackRulesIo> } = {}) {
  const data = new Map<string, string>();
  if (over.mapping !== null) data.set(MAPPING_RULES_SECRET_KEY, over.mapping ?? JSON.stringify([GLOBAL]));
  const wfRules: Array<Record<string, any>> = [...(over.wfRules ?? [])];
  const logged: ChangeEntry[] = [];
  const io: PaybackRulesIo = {
    gate: async () => null,
    secrets: { get: async (k) => data.get(k) ?? null, set: vi.fn(async (k: string, v: string) => { data.set(k, v); }) },
    categoryRules: async () => wfRules.map((r) => ({ ...r })) as any,
    createCategoryRule: vi.fn(async (r) => { wfRules.push({ id: 'rule-9', ...r }); return 'rule-9'; }),
    record: vi.fn(async (d: ChangeDraft) => { logged.push(stampChange(d, 'companion', NOW)); }),
    log: vi.fn(),
    ...(over.io ?? {}),
  };
  const mapping = () => JSON.parse(data.get(MAPPING_RULES_SECRET_KEY) ?? '[]') as MappingRule[];
  return { io, data, wfRules, logged, mapping };
}

describe('makePaybackRules', () => {
  it('appends the transaction rule, makes Wealthfolio’s rule for paybacks in this account, and logs both', async () => {
    const w = world();
    expect(await makePaybackRules(INPUT, w.io, NOW)).toEqual({
      ok: true, message: 'Done — every JANE DOE VENMO deposit into PNC Checking is a payback under Restaurants from now on. Undo either rule from /changes.',
    });
    expect(w.mapping()).toEqual([RULE, GLOBAL]);
    expect(w.io.createCategoryRule).toHaveBeenCalledWith({
      name: 'Telegram payback: JANE DOE VENMO', pattern: 'JANE DOE VENMO', categoryId: 'cat-rest', accountId: 'wf-chk', activityType: 'CREDIT',
    });
    expect(w.logged.map((e) => [e.kind, e.summary])).toEqual([
      ['mapping-rule-created', 'Added a transaction rule: "JANE DOE VENMO" deposits into PNC Checking are paybacks'],
      ['category-rule-created', 'Created a rule: paybacks containing "JANE DOE VENMO" in PNC Checking go to Restaurants'],
    ]);
    expect(w.logged[0].after).toMatchObject({ index: 0, rule: { since: TODAY } });
    expect(w.logged[1].after).toMatchObject({ ruleId: 'rule-9', accountId: 'wf-chk', activityType: 'CREDIT' });
  });

  it('waits for an add-on that reads the rule’s limits, and writes nothing', async () => {
    const w = world({ io: { gate: async () => PAYBACK_UPDATE_ADDON } });
    expect(await makePaybackRules(INPUT, w.io, NOW)).toEqual({ ok: false, message: PAYBACK_UPDATE_ADDON });
    expect(w.io.secrets.set).not.toHaveBeenCalled();
    expect(w.io.createCategoryRule).not.toHaveBeenCalled();
  });

  it('says it couldn’t reach Wealthfolio, and logs why, when the gate cannot read the add-on’s version', async () => {
    const w = world({ io: { gate: async () => { throw new Error('secrets down'); } } });
    expect(await makePaybackRules(INPUT, w.io, NOW)).toEqual({ ok: false, message: PAYBACK_UNREACHABLE });
    expect(w.io.log).toHaveBeenCalledWith(expect.stringContaining('secrets down'));
    expect(w.io.secrets.set).not.toHaveBeenCalled();
    expect(w.io.createCategoryRule).not.toHaveBeenCalled();
  });

  it('refuses a pattern of only generic bank words, in plain words, and writes nothing (I1)', async () => {
    const w = world();
    const input = { ...INPUT, pattern: 'DEPOSIT', description: 'DEPOSIT 123456' };
    expect(await makePaybackRules(input, w.io, NOW)).toEqual({ ok: false, message: PAYBACK_RULES_GENERIC });
    expect(w.io.secrets.set).not.toHaveBeenCalled();
    expect(w.io.createCategoryRule).not.toHaveBeenCalled();
  });

  it('puts the rule FIRST, so the GLOBAL VENMO transfer rule cannot shadow it (I2)', async () => {
    const w = world();
    expect((await makePaybackRules(INPUT, w.io, NOW)).ok).toBe(true);
    expect(w.mapping()[0]).toEqual(RULE);
    expect(mapTransactionWithSource('JANE DOE VENMO 7781', 25, w.mapping(), 'CASH', 'wf-chk', TODAY))
      .toEqual({ type: 'CREDIT', fromRule: true, subtype: 'REIMBURSEMENT' });
    // Appended last, the same fixture would have typed it a transfer.
    expect(mapTransactionWithSource('JANE DOE VENMO 7781', 25, [GLOBAL, RULE], 'CASH', 'wf-chk', TODAY).type).toBe('TRANSFER_IN');
  });

  it('refuses in words when an earlier rule would still decide the source deposit (I2)', async () => {
    const broad: MappingRule = { pattern: 'JANE DOE', matchType: 'contains', activityType: 'TRANSFER_IN' };
    const w = world({ mapping: JSON.stringify([broad, RULE]) });
    expect(await makePaybackRules(INPUT, w.io, NOW)).toEqual({ ok: false, message: PAYBACK_RULES_SHADOWED });
    expect(w.io.secrets.set).not.toHaveBeenCalled();
    expect(w.io.createCategoryRule).not.toHaveBeenCalled();
  });

  it('counts a transaction-rule write that threw after it landed as done: logged and undoable (M1)', async () => {
    const w = world();
    const set = w.io.secrets.set;
    w.io.secrets.set = async (k, v) => { await set(k, v); throw new Error('timeout'); };
    expect((await makePaybackRules(INPUT, w.io, NOW)).ok).toBe(true);
    expect(w.mapping()[0]).toEqual(RULE);
    expect(w.logged.map((e) => e.kind)).toEqual(['mapping-rule-created', 'category-rule-created']);
  });

  it('counts a category-rule create that threw after it landed as done: kept, logged with its id (M1)', async () => {
    const w = world();
    w.io.createCategoryRule = vi.fn(async (r) => { w.wfRules.push({ id: 'rule-77', ...r }); throw new Error('timeout'); });
    expect((await makePaybackRules(INPUT, w.io, NOW)).ok).toBe(true);
    expect(w.mapping()[0]).toEqual(RULE);
    expect(w.logged.map((e) => e.kind)).toEqual(['mapping-rule-created', 'category-rule-created']);
    expect(w.logged[1].after).toMatchObject({ ruleId: 'rule-77' });
  });

  it('refuses a Wealthfolio rule for the same words, account and CREDIT under ANOTHER category, naming it (M2)', async () => {
    const w = world({ wfRules: [{ id: 'r1', pattern: 'JANE DOE VENMO', categoryId: 'cat-groc', accountId: 'wf-chk', activityType: 'CREDIT' }] });
    const out = await makePaybackRules({ ...INPUT, categories: [{ id: 'cat-groc', name: 'Groceries' }] }, w.io, NOW);
    expect(out).toEqual({ ok: false, message: paybackRulesConflict('JANE DOE VENMO', 'PNC Checking', 'Groceries') });
    expect(out.message).toContain('Groceries');
    expect(w.io.secrets.set).not.toHaveBeenCalled();
  });

  it('makes nothing twice', async () => {
    const both = world({
      mapping: JSON.stringify([RULE]),
      wfRules: [{ id: 'r1', pattern: 'JANE DOE VENMO', categoryId: 'cat-rest', accountId: 'wf-chk', activityType: 'CREDIT' }],
    });
    expect(await makePaybackRules(INPUT, both.io, NOW)).toEqual({ ok: false, message: PAYBACK_RULES_EXIST });
    expect(both.io.secrets.set).not.toHaveBeenCalled();
    const one = world({ mapping: JSON.stringify([RULE]) });
    expect((await makePaybackRules(INPUT, one.io, NOW)).ok).toBe(true);
    expect(one.mapping()).toEqual([RULE]);
    expect(one.logged.map((e) => e.kind)).toEqual(['category-rule-created']);
  });

  it('never rewrites a transaction-rule list it cannot read', async () => {
    const w = world({ mapping: '{"not":"a list"}' });
    expect(await makePaybackRules(INPUT, w.io, NOW)).toEqual({ ok: false, message: UNDO_MAPPING_RULES_UNREADABLE });
    expect(w.io.secrets.set).not.toHaveBeenCalled();
    expect(w.io.createCategoryRule).not.toHaveBeenCalled();
  });

  it('says it couldn’t reach Wealthfolio when its rules can’t be read, and writes nothing', async () => {
    const w = world({ io: { categoryRules: async () => { throw new Error('ECONNREFUSED'); } } });
    expect(await makePaybackRules(INPUT, w.io, NOW)).toEqual({ ok: false, message: PAYBACK_UNREACHABLE });
    expect(w.io.secrets.set).not.toHaveBeenCalled();
  });

  it('stops when the transaction rule can’t be saved', async () => {
    const w = world();
    w.io.secrets.set = async () => { throw new Error('500'); };
    expect(await makePaybackRules(INPUT, w.io, NOW)).toEqual({ ok: false, message: PAYBACK_RULES_SAVE_FAILED });
    expect(w.io.createCategoryRule).not.toHaveBeenCalled();
  });

  it('takes the transaction rule back out when Wealthfolio refuses the category rule, so neither is half made', async () => {
    const w = world({ io: { createCategoryRule: vi.fn(async () => { throw new Error('400 - accountId is required'); }) } });
    const out = await makePaybackRules(INPUT, w.io, NOW);
    expect(out).toEqual({ ok: false, message: PAYBACK_RULES_REFUSED });
    expect(out.message).not.toContain('accountId');
    expect(w.mapping()).toEqual([GLOBAL]);
    expect(w.logged).toEqual([]);
  });

  it('says so, and logs the transaction rule for Undo, when it cannot take it back out', async () => {
    const w = world({ io: { createCategoryRule: vi.fn(async () => { throw new Error('400'); }) } });
    let writes = 0;
    const set = w.io.secrets.set;
    w.io.secrets.set = async (k, v) => { writes += 1; if (writes > 1) throw new Error('500'); await set(k, v); };
    expect(await makePaybackRules(INPUT, w.io, NOW)).toEqual({ ok: false, message: paybackRulesStuck('JANE DOE VENMO') });
    expect(w.mapping()).toEqual([RULE, GLOBAL]);
    expect(w.logged.map((e) => e.kind)).toEqual(['mapping-rule-created']);
  });
});

describe('Undo and Redo of the two rules', () => {
  const NAME = 'Telegram payback: JANE DOE VENMO';
  /** The runner over the add-on's secrets and Wealthfolio's rules. */
  function undoWorld(mapping: MappingRule[], wfRules: Array<{ id: string; name: string; pattern: string }>) {
    const data = new Map([[MAPPING_RULES_SECRET_KEY, JSON.stringify(mapping)]]);
    const log: ChangeEntry[] = [];
    const create = vi.fn(async (_r: Record<string, unknown>) => 'rule-10');
    const io: UndoIo = {
      host: createFakeHost({}).host,
      secrets: { get: async (k) => data.get(k) ?? null, set: async (k, v) => { data.set(k, v); } },
      rules: {
        list: async () => wfRules,
        create,
        remove: vi.fn(async (id: string) => { wfRules.splice(wfRules.findIndex((r) => r.id === id), 1); }),
        filedBy: async () => [],
      },
      record: async (d) => { log.unshift(stampChange(d, 'companion', NOW)); },
      where: { host: 'companion', companionVersion: '1.62.0' },
    };
    const item = (e: ChangeEntry): ChangeLogItem => {
      const latest = log.find((x) => x.reverses?.id === e.id);
      return latest?.reverses?.op === 'undo' ? { ...e, undone: { by: latest.id, at: latest.at } } : { ...e };
    };
    const run = (e: ChangeEntry, op: 'undo' | 'redo') => runChangeUndo(item(e), [...log], op, io, 'plain', NOW);
    return { data, io, run, create, wfRules, mapping: () => JSON.parse(data.get(MAPPING_RULES_SECRET_KEY)!) as MappingRule[] };
  }

  it('Undo of the transaction rule takes out exactly it; Redo puts it back with its limits', async () => {
    const lookalike: MappingRule = { pattern: 'JANE DOE VENMO', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' };
    const w = undoWorld([RULE, GLOBAL, lookalike], []);
    const entry = stampChange(mappingRuleCreatedChange({ rule: RULE, description: 'JANE DOE VENMO', account: { wfId: 'wf-chk', name: 'PNC Checking' }, index: 0 }), 'companion', NOW);
    expect(await w.run(entry, 'undo')).toMatchObject({ ok: true, message: PAYBACK_TX_RULE_UNDONE });
    expect(w.mapping()).toEqual([GLOBAL, lookalike]);
    // Redo keeps the order: first again (I2).
    expect(await w.run(entry, 'redo')).toMatchObject({ ok: true, message: PAYBACK_TX_RULE_REDONE });
    expect(w.mapping()).toEqual([RULE, GLOBAL, lookalike]);
  });

  it('Redo puts the rule first when its logged index no longer fits the list (I2)', async () => {
    const w = undoWorld([RULE, GLOBAL], []);
    const entry = stampChange(mappingRuleCreatedChange({ rule: RULE, description: 'JANE DOE VENMO', account: { wfId: 'wf-chk', name: 'PNC Checking' }, index: 5 }), 'companion', NOW);
    expect(await w.run(entry, 'undo')).toMatchObject({ ok: true });
    expect(await w.run(entry, 'redo')).toMatchObject({ ok: true });
    expect(w.mapping()).toEqual([RULE, GLOBAL]);
  });

  it('a rule logged before the index existed is still put back at the end, and keeps `since` (I1)', async () => {
    const w = undoWorld([GLOBAL, RULE], []);
    const entry = stampChange(mappingRuleCreatedChange({ rule: RULE, description: 'JANE DOE VENMO' }), 'companion', NOW);
    expect(await w.run(entry, 'undo')).toMatchObject({ ok: true });
    expect(await w.run(entry, 'redo')).toMatchObject({ ok: true });
    expect(w.mapping()).toEqual([GLOBAL, RULE]);
    expect(w.mapping()[1].since).toBe(TODAY);
  });

  it('Undo of Wealthfolio’s rule deletes it; Redo makes it again for paybacks in that account', async () => {
    const w = undoWorld([], [{ id: 'rule-9', name: NAME, pattern: 'JANE DOE VENMO' }]);
    const entry = stampChange(categoryRuleCreatedChange({
      ruleId: 'rule-9', name: NAME, pattern: 'JANE DOE VENMO', categoryId: 'cat-rest', categoryName: 'Restaurants',
      account: { wfId: 'wf-chk', name: 'PNC Checking' }, activityType: 'CREDIT',
    }), 'companion', NOW);
    expect(await w.run(entry, 'undo')).toMatchObject({ ok: true, message: PAYBACK_CAT_RULE_UNDONE });
    expect(w.wfRules).toEqual([]);
    expect(await w.run(entry, 'redo')).toMatchObject({ ok: true, message: PAYBACK_CAT_RULE_REDONE });
    expect(w.create).toHaveBeenCalledWith({ name: NAME, pattern: 'JANE DOE VENMO', categoryId: 'cat-rest', accountId: 'wf-chk', activityType: 'CREDIT' });
  });
});
