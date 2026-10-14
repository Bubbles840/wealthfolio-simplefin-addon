import { describe, it, expect, vi } from 'vitest';
import { categoryRuleCreatedChange, mappingRuleCreatedChange, stampChange, type ChangeDraft, type ChangeEntry } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import { MAPPING_RULES_SECRET_KEY, runChangeUndo, UNDO_MAPPING_RULES_UNREADABLE, type UndoIo } from './change-undo-run.js';
import { paybackRuleCatches, type CategorizeTxn } from './categorize-menu.js';
import { createFakeHost } from './fake-host.js';
import { mapTransactionWithSource, paybackMappingRule, ruleApplies, sameMappingRule } from './mapper.js';
import { makePaybackRules, type PaybackRulesInput, type PaybackRulesIo } from './payback.js';
import {
  PAYBACK_RULES_EXIST, PAYBACK_RULES_REFUSED, PAYBACK_RULES_SAVE_FAILED, PAYBACK_UNREACHABLE, PAYBACK_UPDATE_ADDON, paybackRulesStuck,
} from './payback-copy.js';
import { bankWords, paybackRulePattern } from './rule-pattern.js';
import type { MappingRule } from './types.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const RULE = paybackMappingRule('VENMO CASHOUT', 'wf-chk');
const GLOBAL: MappingRule = { pattern: 'VENMO', matchType: 'contains', activityType: 'TRANSFER_IN' };
const INPUT: PaybackRulesInput = {
  pattern: 'VENMO CASHOUT', account: { id: 'wf-chk', name: 'PNC Checking' }, categoryId: 'cat-rest', categoryName: 'Restaurants',
  description: 'VENMO CASHOUT · Venmo: Dinner',
};

describe('a payback rule (W10)', () => {
  it('reads money in only, in its one account', () => {
    expect(RULE).toEqual({
      pattern: 'VENMO CASHOUT', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT', onlyMoneyIn: true, accountId: 'wf-chk',
    });
    expect(ruleApplies(RULE, 'VENMO CASHOUT 1023', 25, 'wf-chk')).toBe(true);
    expect(ruleApplies(RULE, 'VENMO CASHOUT 1023', -25, 'wf-chk')).toBe(false);
    expect(ruleApplies(RULE, 'VENMO CASHOUT 1023', 0, 'wf-chk')).toBe(false);
    expect(ruleApplies(RULE, 'VENMO CASHOUT 1023', 25, 'wf-sav')).toBe(false);
    expect(ruleApplies(RULE, 'VENMO CASHOUT 1023', 25)).toBe(false);
  });

  it('types money in a payback, and leaves a payment out and another account as they were', () => {
    expect(mapTransactionWithSource('VENMO CASHOUT 1023', 25, [RULE], 'CASH', 'wf-chk')).toEqual({ type: 'CREDIT', fromRule: true, subtype: 'REIMBURSEMENT' });
    expect(mapTransactionWithSource('VENMO CASHOUT 1023', -25, [RULE], 'CASH', 'wf-chk')).toEqual({ type: 'WITHDRAWAL', fromRule: false });
    expect(mapTransactionWithSource('VENMO CASHOUT 1023', 25, [RULE], 'CASH', 'wf-sav')).toEqual({ type: 'DEPOSIT', fromRule: false });
  });

  it('leaves every older rule as it always read: either way, any account', () => {
    expect(ruleApplies(GLOBAL, 'VENMO PAYMENT', -25)).toBe(true);
    expect(ruleApplies(GLOBAL, 'VENMO PAYMENT', 25, 'wf-any')).toBe(true);
    expect(ruleApplies({ pattern: '(', matchType: 'regex', activityType: 'DEPOSIT' }, 'x', 1)).toBe(false);
  });

  it('is a different rule from one with the same words but no limits', () => {
    const plain: MappingRule = { pattern: 'VENMO CASHOUT', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' };
    expect(sameMappingRule(RULE, { ...RULE })).toBe(true);
    expect(sameMappingRule(RULE, plain)).toBe(false);
    expect(sameMappingRule(RULE, { ...RULE, accountId: 'wf-sav' })).toBe(false);
  });

  it('is built from the bank’s words, not the note the sync added', () => {
    expect(bankWords('VENMO CASHOUT · Venmo: Dinner')).toBe('VENMO CASHOUT');
    expect(bankWords('AMAZON MKTPL*2K4 · Amazon: Lawn')).toBe('AMAZON MKTPL*2K4');
    expect(paybackRulePattern('ZELLE FROM JANE DOE 8ZK1 · Venmo: Rent')).toBe('ZELLE FROM JANE DOE');
  });
});

describe('the preview count', () => {
  const txn = (activityId: string, description: string, over: Partial<CategorizeTxn> = {}): CategorizeTxn => ({
    activityId, date: '2026-10-09', amountCents: 1400, description, accountName: 'PNC Checking', accountId: 'wf-chk', direction: 'in', incomeEligible: true, ...over,
  });
  const rows = [
    txn('self', 'VENMO CASHOUT'),
    txn('a', 'VENMO CASHOUT 7781'),
    txn('b', 'VENMO CASHOUT · Venmo: Rent'),
    txn('out', 'VENMO CASHOUT REVERSAL', { direction: 'out' }),
    txn('other', 'VENMO CASHOUT', { accountId: 'wf-sav' }),
    txn('no', 'PAYROLL'),
  ];

  it('counts exactly the waiting deposits the transaction rule types a payback', () => {
    const signed = (t: CategorizeTxn) => (t.direction === 'out' ? -1 : 1) * t.amountCents / 100;
    const byRule = rows.filter((t) => t.activityId !== 'self'
      && mapTransactionWithSource(bankWords(t.description), signed(t), [RULE], 'CASH', t.accountId).subtype === 'REIMBURSEMENT');
    expect(byRule.map((t) => t.activityId)).toEqual(['a', 'b']);
    expect(paybackRuleCatches({ txns: rows }, rows[0], 'VENMO CASHOUT')).toBe(byRule.length);
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
    expect(await makePaybackRules(INPUT, w.io)).toEqual({
      ok: true, message: 'Done — every VENMO CASHOUT deposit into PNC Checking is a payback under Restaurants from now on. Undo either rule from /changes.',
    });
    expect(w.mapping()).toEqual([GLOBAL, RULE]);
    expect(w.io.createCategoryRule).toHaveBeenCalledWith({
      name: 'Telegram payback: VENMO CASHOUT', pattern: 'VENMO CASHOUT', categoryId: 'cat-rest', accountId: 'wf-chk', activityType: 'CREDIT',
    });
    expect(w.logged.map((e) => [e.kind, e.summary])).toEqual([
      ['mapping-rule-created', 'Added a transaction rule: "VENMO CASHOUT" deposits into PNC Checking are paybacks'],
      ['category-rule-created', 'Created a rule: paybacks containing "VENMO CASHOUT" in PNC Checking go to Restaurants'],
    ]);
    expect(w.logged[1].after).toMatchObject({ ruleId: 'rule-9', accountId: 'wf-chk', activityType: 'CREDIT' });
  });

  it('waits for an add-on that reads the rule’s limits, and writes nothing', async () => {
    const w = world({ io: { gate: async () => PAYBACK_UPDATE_ADDON } });
    expect(await makePaybackRules(INPUT, w.io)).toEqual({ ok: false, message: PAYBACK_UPDATE_ADDON });
    expect(w.io.secrets.set).not.toHaveBeenCalled();
    expect(w.io.createCategoryRule).not.toHaveBeenCalled();
  });

  it('says it couldn’t reach Wealthfolio, and logs why, when the gate cannot read the add-on’s version', async () => {
    const w = world({ io: { gate: async () => { throw new Error('secrets down'); } } });
    expect(await makePaybackRules(INPUT, w.io)).toEqual({ ok: false, message: PAYBACK_UNREACHABLE });
    expect(w.io.log).toHaveBeenCalledWith(expect.stringContaining('secrets down'));
    expect(w.io.secrets.set).not.toHaveBeenCalled();
    expect(w.io.createCategoryRule).not.toHaveBeenCalled();
  });

  it('makes nothing twice', async () => {
    const both = world({
      mapping: JSON.stringify([RULE]),
      wfRules: [{ id: 'r1', pattern: 'VENMO CASHOUT', categoryId: 'cat-rest', accountId: 'wf-chk', activityType: 'CREDIT' }],
    });
    expect(await makePaybackRules(INPUT, both.io)).toEqual({ ok: false, message: PAYBACK_RULES_EXIST });
    expect(both.io.secrets.set).not.toHaveBeenCalled();
    const one = world({ mapping: JSON.stringify([RULE]) });
    expect((await makePaybackRules(INPUT, one.io)).ok).toBe(true);
    expect(one.mapping()).toEqual([RULE]);
    expect(one.logged.map((e) => e.kind)).toEqual(['category-rule-created']);
  });

  it('never rewrites a transaction-rule list it cannot read', async () => {
    const w = world({ mapping: '{"not":"a list"}' });
    expect(await makePaybackRules(INPUT, w.io)).toEqual({ ok: false, message: UNDO_MAPPING_RULES_UNREADABLE });
    expect(w.io.secrets.set).not.toHaveBeenCalled();
    expect(w.io.createCategoryRule).not.toHaveBeenCalled();
  });

  it('says it couldn’t reach Wealthfolio when its rules can’t be read, and writes nothing', async () => {
    const w = world({ io: { categoryRules: async () => { throw new Error('ECONNREFUSED'); } } });
    expect(await makePaybackRules(INPUT, w.io)).toEqual({ ok: false, message: PAYBACK_UNREACHABLE });
    expect(w.io.secrets.set).not.toHaveBeenCalled();
  });

  it('stops when the transaction rule can’t be saved', async () => {
    const w = world();
    w.io.secrets.set = async () => { throw new Error('500'); };
    expect(await makePaybackRules(INPUT, w.io)).toEqual({ ok: false, message: PAYBACK_RULES_SAVE_FAILED });
    expect(w.io.createCategoryRule).not.toHaveBeenCalled();
  });

  it('takes the transaction rule back out when Wealthfolio refuses the category rule, so neither is half made', async () => {
    const w = world({ io: { createCategoryRule: vi.fn(async () => { throw new Error('400 - accountId is required'); }) } });
    const out = await makePaybackRules(INPUT, w.io);
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
    expect(await makePaybackRules(INPUT, w.io)).toEqual({ ok: false, message: paybackRulesStuck('VENMO CASHOUT') });
    expect(w.mapping()).toEqual([GLOBAL, RULE]);
    expect(w.logged.map((e) => e.kind)).toEqual(['mapping-rule-created']);
  });
});

describe('Undo and Redo of the two rules', () => {
  const NAME = 'Telegram payback: VENMO CASHOUT';
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
    const lookalike: MappingRule = { pattern: 'VENMO CASHOUT', matchType: 'contains', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' };
    const w = undoWorld([GLOBAL, lookalike, RULE], []);
    const entry = stampChange(mappingRuleCreatedChange({ rule: RULE, description: 'VENMO CASHOUT', account: { wfId: 'wf-chk', name: 'PNC Checking' } }), 'companion', NOW);
    expect(await w.run(entry, 'undo')).toMatchObject({ ok: true });
    expect(w.mapping()).toEqual([GLOBAL, lookalike]);
    expect(await w.run(entry, 'redo')).toMatchObject({ ok: true });
    expect(w.mapping()).toEqual([GLOBAL, lookalike, RULE]);
  });

  it('Undo of Wealthfolio’s rule deletes it; Redo makes it again for paybacks in that account', async () => {
    const w = undoWorld([], [{ id: 'rule-9', name: NAME, pattern: 'VENMO CASHOUT' }]);
    const entry = stampChange(categoryRuleCreatedChange({
      ruleId: 'rule-9', name: NAME, pattern: 'VENMO CASHOUT', categoryId: 'cat-rest', categoryName: 'Restaurants',
      account: { wfId: 'wf-chk', name: 'PNC Checking' }, activityType: 'CREDIT',
    }), 'companion', NOW);
    expect(await w.run(entry, 'undo')).toMatchObject({ ok: true, message: 'Undone — the rule is gone.' });
    expect(w.wfRules).toEqual([]);
    expect(await w.run(entry, 'redo')).toMatchObject({ ok: true, message: 'Redone — the rule is back.' });
    expect(w.create).toHaveBeenCalledWith({ name: NAME, pattern: 'VENMO CASHOUT', categoryId: 'cat-rest', accountId: 'wf-chk', activityType: 'CREDIT' });
  });
});
