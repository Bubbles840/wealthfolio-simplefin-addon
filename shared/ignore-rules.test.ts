import { describe, it, expect } from 'vitest';
import {
  ignoreRuleProblem, normalizeIgnoreRules, parseIgnoreRules, parseIgnoreRulesStrict,
  ignoreRuleMatches, ignoreRuleFor, findIgnored, withIgnoreRule, withoutIgnoreRule,
  relinkedRuleAccount, ruleAccountOptions,
  IGNORE_PATTERN_MAX, type IgnoreRule,
} from './ignore-rules.js';
import type { SimplefinAccount } from './types.js';

const rule = (over: Partial<IgnoreRule> = {}): IgnoreRule => ({ pattern: 'SWEEP FROM CORE', matchType: 'contains', ...over });

describe('ignoreRuleProblem', () => {
  it('accepts a plain pattern and a regex that needs some text', () => {
    expect(ignoreRuleProblem(rule())).toBeNull();
    expect(ignoreRuleProblem({ pattern: '^SWEEP .* CORE', matchType: 'regex' })).toBeNull();
  });

  it('refuses an empty pattern, and one that is only spaces', () => {
    expect(ignoreRuleProblem(rule({ pattern: '' }))).toBe('empty');
    expect(ignoreRuleProblem(rule({ pattern: '   ' }))).toBe('empty');
  });

  it('refuses a regex that matches the empty string, because it matches every description', () => {
    for (const pattern of ['.*', 'a*', '(x|)', '^', '\\s*']) {
      expect(ignoreRuleProblem({ pattern, matchType: 'regex' })).toBe('matches-everything');
    }
  });

  it('refuses a regex that matches any single character, not only the empty string', () => {
    for (const pattern of ['.', '\\S', '.+', '[\\s\\S]', '^.', '[^]', '\\w', '[a-z0-9]']) {
      expect(ignoreRuleProblem({ pattern, matchType: 'regex' }), pattern).toBe('matches-everything');
    }
  });

  it('accepts realistic narrow regexes', () => {
    for (const pattern of ['SWEEP|CORE FUND', '^MONEY MARKET', '\\bSPAXX\\b', 'TRANSFER TO .* CORE']) {
      expect(ignoreRuleProblem({ pattern, matchType: 'regex' }), pattern).toBeNull();
    }
  });

  it('refuses a regex that does not compile', () => {
    expect(ignoreRuleProblem({ pattern: '(unclosed', matchType: 'regex' })).toBe('bad-regex');
  });

  it('refuses a pattern longer than the limit', () => {
    expect(ignoreRuleProblem(rule({ pattern: 'x'.repeat(IGNORE_PATTERN_MAX + 1) }))).toBe('too-long');
    expect(ignoreRuleProblem(rule({ pattern: 'x'.repeat(IGNORE_PATTERN_MAX) }))).toBeNull();
  });
});

describe('reading the stored list', () => {
  it('keeps good rules, trims them, and drops unusable ones one at a time', () => {
    const list = normalizeIgnoreRules([
      { pattern: '  SWEEP FROM CORE ', matchType: 'contains', account: 'sfin-1', note: ' sweep ' },
      { pattern: '', matchType: 'contains' },
      { pattern: '.*', matchType: 'regex' },
      { pattern: 'x', matchType: 'glob' },
      { matchType: 'contains' },
      'junk',
      null,
    ]);
    expect(list).toEqual([{ pattern: 'SWEEP FROM CORE', matchType: 'contains', account: 'sfin-1', note: 'sweep' }]);
  });

  it('reads nothing from garbage, which means: import as usual', () => {
    expect(parseIgnoreRules('not json')).toEqual([]);
    expect(parseIgnoreRules(null)).toEqual([]);
    expect(parseIgnoreRules('{"a":1}')).toEqual([]);
  });

  it('tells corrupt from absent for a writer', () => {
    expect(parseIgnoreRulesStrict(null)).toEqual({ kind: 'absent' });
    expect(parseIgnoreRulesStrict('  ')).toEqual({ kind: 'absent' });
    expect(parseIgnoreRulesStrict('not json')).toEqual({ kind: 'corrupt' });
    expect(parseIgnoreRulesStrict('{"a":1}')).toEqual({ kind: 'corrupt' });
    expect(parseIgnoreRulesStrict(JSON.stringify([{ pattern: 'a' }]))).toEqual({ kind: 'corrupt' });
  });

  it('reads a list with an empty-pattern entry as ok, minus that entry', () => {
    const raw = JSON.stringify([rule(), { pattern: '', matchType: 'contains' }]);
    expect(parseIgnoreRulesStrict(raw)).toEqual({ kind: 'ok', list: [rule()] });
  });
});

describe('matching', () => {
  it('contains is case-insensitive and literal: brackets and dots are not regex', () => {
    expect(ignoreRuleMatches(rule({ pattern: 'sweep from core' }), 'SWEEP FROM CORE FUND MONEY MARKET')).toBe(true);
    expect(ignoreRuleMatches(rule({ pattern: 'a.b (c)' }), 'xx A.B (C) yy')).toBe(true);
    expect(ignoreRuleMatches(rule({ pattern: 'a.b' }), 'AXB')).toBe(false);
  });

  it('regex reads as a regular expression', () => {
    expect(ignoreRuleMatches({ pattern: '^SWEEP (TO|FROM) CORE', matchType: 'regex' }, 'SWEEP TO CORE FUND')).toBe(true);
    expect(ignoreRuleMatches({ pattern: '^SWEEP (TO|FROM) CORE', matchType: 'regex' }, 'DIRECT DEBIT')).toBe(false);
  });

  it('a rule with a problem matches nothing, whatever it holds', () => {
    expect(ignoreRuleMatches(rule({ pattern: '' }), 'anything')).toBe(false);
    expect(ignoreRuleMatches({ pattern: '.*', matchType: 'regex' }, 'anything')).toBe(false);
    expect(ignoreRuleMatches(rule(), undefined)).toBe(false);
  });

  it('a rule limited to an account reads only that account', () => {
    const rules = [rule({ account: 'sfin-1' })];
    expect(ignoreRuleFor(rules, 'sfin-1', 'SWEEP FROM CORE X')).not.toBeNull();
    expect(ignoreRuleFor(rules, 'sfin-2', 'SWEEP FROM CORE X')).toBeNull();
    expect(ignoreRuleFor([rule()], 'sfin-2', 'SWEEP FROM CORE X')).not.toBeNull();
  });
});

describe('findIgnored', () => {
  const account = (id: string, descriptions: string[]): SimplefinAccount => ({
    id, name: id, currency: 'USD', balance: '0', 'balance-date': 1700000000,
    transactions: descriptions.map((description, i) => ({ id: `${id}-${i}`, posted: 1700000000, amount: '-1.00', description })),
  });

  it('finds the matching transactions in feed order, with the rule that matched', () => {
    const hits = findIgnored([rule()], [account('a', ['Coffee', 'SWEEP FROM CORE 1', 'SWEEP FROM CORE 2'])]);
    expect(hits.map((h) => h.tx.id)).toEqual(['a-1', 'a-2']);
    expect(hits[0].rule.pattern).toBe('SWEEP FROM CORE');
  });

  it('never reaches an account that is not mapped', () => {
    const hits = findIgnored([rule()], [account('a', ['SWEEP FROM CORE']), account('b', ['SWEEP FROM CORE'])], (id) => id === 'a');
    expect(hits.map((h) => h.account.id)).toEqual(['a']);
  });

  it('finds nothing without rules', () => {
    expect(findIgnored([], [account('a', ['SWEEP FROM CORE'])])).toEqual([]);
  });
});

describe('editing', () => {
  it('adds a rule, once', () => {
    const once = withIgnoreRule([], rule({ account: 'sfin-1' }));
    expect(once).toHaveLength(1);
    expect(withIgnoreRule(once, rule({ pattern: 'sweep from core ', account: 'sfin-1' }))).toHaveLength(1);
    expect(withIgnoreRule(once, rule({ account: 'sfin-2' }))).toHaveLength(2);
  });

  it('refuses to store a rule that would ignore everything', () => {
    expect(() => withIgnoreRule([], rule({ pattern: '' }))).toThrow();
    expect(() => withIgnoreRule([], { pattern: '.*', matchType: 'regex' })).toThrow();
  });

  it('removes a rule by position', () => {
    const list = [rule({ pattern: 'a' }), rule({ pattern: 'b' }), rule({ pattern: 'c' })];
    expect(withoutIgnoreRule(list, 1).map((r) => r.pattern)).toEqual(['a', 'c']);
  });
});

describe('a re-linked connection', () => {
  // The connection was added again: the same bank account came back as
  // 'sfin-new', mapped to the same Wealthfolio account as 'sfin-old', and the
  // person confirmed it. 'sfin-sav' is a second account merged into wf-cash on purpose.
  const mapping = { 'sfin-old': 'wf-cash', 'sfin-new': 'wf-cash', 'sfin-sav': 'wf-cash', 'sfin-chk': 'wf-chk' };
  const relinks = [{ wfAccountId: 'wf-cash', newId: 'sfin-new', oldIds: ['sfin-old'] }];
  const sweeps = (id: string): SimplefinAccount => ({
    id, name: 'Cash Account', currency: 'USD', balance: '0', 'balance-date': 1,
    transactions: [{ id: `${id}-1`, posted: 1, amount: '-5.00', description: 'SWEEP FROM CORE' }],
  });

  it('reaches from a retired id to the one that replaced it, and nowhere else', () => {
    const same = relinkedRuleAccount(relinks);
    expect(same('sfin-old', 'sfin-new')).toBe(true);
    expect(same('sfin-new', 'sfin-old')).toBe(false);
    expect(same('sfin-old', 'sfin-sav')).toBe(false);
    expect(same('sfin-x', 'sfin-x')).toBe(true);
  });

  it('a rule saved on the old id keeps reaching the account through the new one', () => {
    const r = rule({ account: 'sfin-old' });
    expect(findIgnored([r], [sweeps('sfin-new')], () => true, relinkedRuleAccount(relinks))).toHaveLength(1);
    expect(findIgnored([r], [sweeps('sfin-chk')], () => true, relinkedRuleAccount(relinks))).toEqual([]);
    expect(ignoreRuleFor([r], 'sfin-new', 'SWEEP FROM CORE')).toBeNull();
  });

  it('a rule limited to one of two accounts merged on purpose does not reach the other', () => {
    const r = rule({ account: 'sfin-new' });
    expect(findIgnored([r], [sweeps('sfin-new'), sweeps('sfin-sav')], () => true, relinkedRuleAccount(relinks)).map((h) => h.account.id))
      .toEqual(['sfin-new']);
    // Without a confirmed re-link nothing is aliased at all.
    expect(findIgnored([rule({ account: 'sfin-old' })], [sweeps('sfin-new')], () => true, relinkedRuleAccount([]))).toEqual([]);
  });

  it('offers every mapped account, folding only a retired id into the one that replaced it', () => {
    const names = { 'sfin-old': 'Cash Account', 'sfin-new': 'Cash Account', 'sfin-sav': 'Savings', 'sfin-chk': 'Checking' };
    expect(ruleAccountOptions(mapping, names, relinks)).toEqual([
      { id: 'sfin-chk', name: 'Checking', aliases: [] },
      { id: 'sfin-new', name: 'Cash Account', aliases: ['sfin-old'] },
      { id: 'sfin-sav', name: 'Savings', aliases: [] },
    ]);
  });

  it('merges nothing without a confirmed re-link, whatever is or is not in the download', () => {
    const names = { 'sfin-old': 'Cash Account', 'sfin-new': 'Cash Account' };
    expect(ruleAccountOptions({ 'sfin-old': 'wf-cash', 'sfin-new': 'wf-cash' }, names, [], { 'wf-cash': 'Cash' }).map((o) => o.id))
      .toEqual(['sfin-new', 'sfin-old']);
  });

  it('tells accounts with one name apart: by Wealthfolio name when it differs, else by the end of the id', () => {
    expect(ruleAccountOptions({ a: 'wf-1', b: 'wf-2' }, { a: 'Brokerage', b: 'Brokerage' }, [], { 'wf-1': 'Taxable', 'wf-2': 'Roth' })
      .map((o) => o.name)).toEqual(['Brokerage · Taxable', 'Brokerage · Roth']);
    // An account auto-created from the bank's name: no "X · X".
    expect(ruleAccountOptions({ 'ACT-1111': 'wf-1', 'ACT-2222': 'wf-2' }, { 'ACT-1111': 'Card', 'ACT-2222': 'Card' }, [], { 'wf-1': 'Card', 'wf-2': 'Card' })
      .map((o) => o.name)).toEqual(['Card · …1111', 'Card · …2222']);
  });
});

