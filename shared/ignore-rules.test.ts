import { describe, it, expect } from 'vitest';
import {
  ignoreRuleProblem, normalizeIgnoreRules, parseIgnoreRules, parseIgnoreRulesStrict,
  ignoreRuleMatches, ignoreRuleFor, findIgnored, withIgnoreRule, withoutIgnoreRule,
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
