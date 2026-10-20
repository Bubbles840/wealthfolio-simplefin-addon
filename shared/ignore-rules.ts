/**
 * shared/ignore-rules.ts
 *
 * Bank transactions the sync must not import, chosen by what the bank calls
 * them — "ignore every row whose description contains SWEEP FROM CORE".
 *
 * The sync already has a skip list (shared/skipped-transactions.ts): bank
 * transactions, named one by one, that it never imports. An ignore rule is the
 * same decision made once for a whole kind of row. The sync adds every
 * transaction a rule matches to that same set, so a rule-ignored row takes
 * exactly the path a skipped one does: it is dropped before anything is
 * planned, and a copy already stored is left for the person to delete —
 * removing money from a ledger stays a step a person takes. Transfer pairing
 * reads the filtered feed, so ignoring ONE leg of a real transfer leaves the
 * other as an in-transit placeholder that expires to spending or income once
 * the in-transit window passes. Rules should therefore target only rows that
 * move money inside a single account.
 *
 * What this is for. A brokerage's cash-management account reports the movement
 * INSIDE the account as ordinary rows: "SWEEP FROM CORE FUND" +$1,000
 * and, when the money is spent, "DIRECT DEBIT" −$1,000. In a Transactions-mode
 * account every row moves cash, so the two never cancel the way they did at the
 * bank, and the account's value drifts from the bank's balance. Rows that net
 * to zero inside the account are the safe thing to ignore. Ignoring a row that
 * is real money makes the ledger differ from the bank's balance by exactly that
 * row, which the balance-drift alert then reports — correctly.
 *
 * Safety. A rule that matches everything silently drops every transaction, so
 * an empty pattern (or a regular expression that matches the empty string, or
 * a letter and a digit alike) is never a rule: the editor refuses it, and the sync discards one it finds in
 * storage, so a hand-edited or corrupt list cannot hide an account.
 *
 * Both writers (companion and addon) read the same secret; only the addon's
 * UI writes it.
 */
import { ruleApplies } from './mapper.js';
import { IGNORE_RULES_SINCE } from './version.js';
import type { SimplefinAccount, SimplefinTransaction } from './types.js';

export const IGNORE_RULES_SECRET_KEY = 'ignore_rules';

/** Longer than any bank description is worth matching on, and short enough that
 *  a pasted paragraph is a mistake the editor can say so about. */
export const IGNORE_PATTERN_MAX = 200;

export interface IgnoreRule {
  /** What to look for in the bank's description. Case-insensitive. */
  pattern: string;
  matchType: 'contains' | 'regex';
  /** SimpleFin account id the rule is limited to. Absent: every mapped account.
   *  Per ACCOUNT because SimpleFin gives both sides of an internal transfer one
   *  id — a rule that reads every account could drop the other side of a real
   *  transfer. */
  account?: string;
  /** Why, in the person's words — shown beside the rule. */
  note?: string;
}

/** Descriptions a regex rule is tried against: a lowercase letter, a capital
 *  and a digit. A narrow pattern such as `SWEEP|CORE FUND` matches none of
 *  them, so a regex that matches ALL of them (`.`, `\S`, `\w`, `.+`,
 *  `[\s\S]`) is a match-everything rule in disguise. No space or symbol is
 *  tried: `\S` and `\w` each miss one, and would slip through. */
export const MATCH_EVERYTHING_PROBES = ['a', 'Z', '0'] as const;

/** Shown when a connected companion is older than `IGNORE_RULES_SINCE`. */
export const IGNORE_UPDATE_COMPANION = `Update the companion to ${IGNORE_RULES_SINCE} or newer first — an older one keeps importing the rows these rules ignore. Rules can't be added until then.`;

export type IgnoreRuleProblem = 'empty' | 'too-long' | 'bad-regex' | 'matches-everything';

export const IGNORE_PROBLEM_TEXT: Record<IgnoreRuleProblem, string> = {
  empty: 'Enter some text to match. An empty rule would ignore every transaction.',
  'too-long': `Keep the pattern under ${IGNORE_PATTERN_MAX} characters.`,
  'bad-regex': "That isn't a valid regular expression.",
  'matches-everything': 'That pattern matches any text at all, so it would ignore every transaction.',
};

/** Why a rule must not be saved or obeyed, or null when it is fine. */
export function ignoreRuleProblem(rule: { pattern: string; matchType: string }): IgnoreRuleProblem | null {
  const pattern = rule.pattern.trim();
  if (pattern === '') return 'empty';
  if (pattern.length > IGNORE_PATTERN_MAX) return 'too-long';
  if (rule.matchType === 'regex') {
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      return 'bad-regex';
    }
    // `.*`, `a*`, `(x|)` — anything that matches nothing at all matches every
    // description, and so does `.` or `\S`, which only need some character. A
    // pattern is allowed to be broad; it is not allowed to be everything.
    if (re.test('') || MATCH_EVERYTHING_PROBES.every((probe) => re.test(probe))) return 'matches-everything';
  }
  return null;
}

// ── Reading ──────────────────────────────────────────────────────────────

/** Shape only: strings where strings belong. Whether the PATTERN is usable is
 *  `ignoreRuleProblem`'s question, so that one bad rule is dropped on its own
 *  without making the whole list unreadable. */
function asRule(e: unknown): IgnoreRule | null {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const r = e as Record<string, unknown>;
  if (typeof r.pattern !== 'string') return null;
  if (r.matchType !== 'contains' && r.matchType !== 'regex') return null;
  if (r.account !== undefined && typeof r.account !== 'string') return null;
  if (r.note !== undefined && typeof r.note !== 'string') return null;
  const account = (r.account as string | undefined)?.trim();
  const note = (r.note as string | undefined)?.trim();
  return {
    pattern: r.pattern.trim(),
    matchType: r.matchType,
    ...(account ? { account } : {}),
    ...(note ? { note } : {}),
  };
}

/** The rules a sync may obey: well-formed and with a usable pattern. */
export function normalizeIgnoreRules(list: unknown): IgnoreRule[] {
  if (!Array.isArray(list)) return [];
  const out: IgnoreRule[] = [];
  for (const entry of list) {
    const rule = asRule(entry);
    if (rule && ignoreRuleProblem(rule) === null) out.push(rule);
  }
  return out;
}

/** The stored list; anything unreadable reads as no rules (= import as usual). */
export function parseIgnoreRules(raw: string | null | undefined): IgnoreRule[] {
  if (!raw) return [];
  try {
    return normalizeIgnoreRules(JSON.parse(raw));
  } catch {
    return [];
  }
}

export type ParsedIgnoreRules =
  | { kind: 'ok'; list: IgnoreRule[] }
  | { kind: 'absent' }
  | { kind: 'corrupt' };

/** The stored list as a WRITER must see it: corrupt is not absent. Reading stays
 *  lenient (`parseIgnoreRules`); a write over a list this cannot read in full
 *  would drop the rules it did not understand. */
export function parseIgnoreRulesStrict(raw: string | null | undefined): ParsedIgnoreRules {
  if (raw === null || raw === undefined || raw.trim() === '') return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!Array.isArray(parsed) || !parsed.every((e) => asRule(e) !== null)) return { kind: 'corrupt' };
  return { kind: 'ok', list: normalizeIgnoreRules(parsed) };
}

export class IgnoreRulesUnreadableError extends Error {
  constructor() {
    super("The list of ignore rules can't be read, so nothing was changed.");
    this.name = 'IgnoreRulesUnreadableError';
  }
}

// ── Matching ─────────────────────────────────────────────────────────────

/** Whether a rule's PATTERN matches a description. The same matcher the
 *  transaction rules use (`ruleApplies`), so "contains" and "regex" mean one
 *  thing across the add-on: case-insensitive, and a regex that does not compile
 *  matches nothing rather than crashing a sync. */
export function ignoreRuleMatches(rule: IgnoreRule, description: string | undefined): boolean {
  if (ignoreRuleProblem(rule) !== null) return false;
  return ruleApplies(
    { pattern: rule.pattern.trim(), matchType: rule.matchType, activityType: 'UNKNOWN' },
    description ?? '',
    0,
  );
}

/** The first rule that ignores a transaction in this account, or null. */
export function ignoreRuleFor(
  rules: readonly IgnoreRule[],
  sfAccountId: string,
  description: string | undefined,
): IgnoreRule | null {
  for (const rule of rules) {
    if (rule.account && rule.account !== sfAccountId) continue;
    if (ignoreRuleMatches(rule, description)) return rule;
  }
  return null;
}

export interface IgnoredHit {
  account: SimplefinAccount;
  tx: SimplefinTransaction;
  rule: IgnoreRule;
}

/** Every transaction in the feed that a rule ignores, in feed order. `isMapped`
 *  limits it to accounts that are synced: a rule never reaches an account
 *  nothing is mapped to. Used by the sync to decide, and by the editor to show
 *  what a rule WOULD do before it is saved. */
export function findIgnored(
  rules: readonly IgnoreRule[],
  accounts: readonly SimplefinAccount[],
  isMapped: (sfAccountId: string) => boolean = () => true,
): IgnoredHit[] {
  if (rules.length === 0) return [];
  const hits: IgnoredHit[] = [];
  for (const account of accounts) {
    if (!isMapped(account.id)) continue;
    for (const tx of account.transactions ?? []) {
      const rule = ignoreRuleFor(rules, account.id, tx.description);
      if (rule) hits.push({ account, tx, rule });
    }
  }
  return hits;
}

// ── Editing ──────────────────────────────────────────────────────────────

export function sameIgnoreRule(a: IgnoreRule, b: IgnoreRule): boolean {
  return a.pattern.trim().toLowerCase() === b.pattern.trim().toLowerCase()
    && a.matchType === b.matchType
    && (a.account ?? '') === (b.account ?? '');
}

/** The list with a rule added; the same rule twice is one rule. Throws on a rule
 *  that must not be saved, so a caller that skipped the editor's check still
 *  cannot store one. */
export function withIgnoreRule(list: readonly IgnoreRule[], rule: IgnoreRule): IgnoreRule[] {
  const problem = ignoreRuleProblem(rule);
  if (problem) throw new Error(IGNORE_PROBLEM_TEXT[problem]);
  const clean = asRule(rule)!;
  return list.some((r) => sameIgnoreRule(r, clean)) ? [...list] : [...list, clean];
}

export function withoutIgnoreRule(list: readonly IgnoreRule[], index: number): IgnoreRule[] {
  return list.filter((_, i) => i !== index);
}
