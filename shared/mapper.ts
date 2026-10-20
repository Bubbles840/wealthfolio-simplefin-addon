import { REIMBURSEMENT_SUBTYPE } from './cash-flow-bucket.js';
import type { ActivityType, MappingRule } from './types';

/**
 * Payment-shaped descriptions on credit cards (incoming card payments).
 * Applied ONLY to positive amounts on CREDIT_CARD accounts — on cash accounts
 * "payment" is too generic (rent payment, utility payment are real expenses).
 */
export const CARD_PAYMENT_KEYWORDS = /payment|autopay|thank you|e-?pay/i;

/**
 * The paying-OUT side of a card payment, seen on a cash account.
 *
 * Only phrasings that cannot describe an ordinary bill. Every issuer words
 * these differently and no list will ever be complete — the escape hatch for
 * whatever this misses is a mapping rule (Advanced → Transaction Rules), which
 * takes precedence over everything here.
 */
export const CASH_CARD_PAYMENT_KEYWORDS = /credit\s*card\s*payment|card\s*payment/i;

export interface MappedType {
  type: ActivityType;
  /** True when a user mapping rule decided the type (never auto-overridden) */
  fromRule: boolean;
  subtype?: string;
  /** The deciding rule carries `since` (a payback rule, W10): it types only rows
   *  the sync CREATES — a row already stored keeps its type and subtype. */
  createOnly?: true;
  /** A TRANSFER_OUT whose type came ONLY from one of the four generic phrases
   *  (no rule, no card-payment phrase, no institution phrase); the sync core
   *  decides whether it stands. Issue #13: "WIRE TRANSFER TO ACME LLC", a wire
   *  to a third party, was held forever waiting for an other half. */
  genericTransferWording?: true;
}

/**
 * Whether one transaction rule decides this transaction. A payback rule
 * ("Make every … deposit a payback", 1.62 W10) carries two limits no older
 * rule has: `onlyMoneyIn` — it reads money in only, so a payment out that
 * shares the pattern is never typed a CREDIT (a rule's type is otherwise
 * direction-blind) — and `accountId`, the one Wealthfolio account it reads.
 */
export type MappingRuleProblem = 'empty' | 'matches-everything';

export const MAPPING_RULE_PROBLEM_TEXT: Record<MappingRuleProblem, string> = {
  empty: 'Enter a pattern. An empty rule is not saved: it would match every transaction.',
  'matches-everything': 'This pattern matches an empty description, so it would match every transaction. It is not saved.',
};

/**
 * Why a transaction rule must not be obeyed or saved, or null when it is fine.
 *
 * A rule matches by containment, and every description contains the empty
 * string: "+ Add rule" used to save `{ pattern: '', activityType: 'DEPOSIT' }`
 * at once, and that one blank row typed every transaction a deposit, money out
 * included, until a card account refused the whole sync. A regex that matches
 * the empty string (`.*`, `a*`) does the same. A bad regex is not listed: it
 * already matches nothing, and the editor says so.
 */
export function mappingRuleProblem(rule: { pattern: string; matchType: string }): MappingRuleProblem | null {
  if (rule.pattern.trim() === '') return 'empty';
  if (rule.matchType === 'regex') {
    try {
      if (new RegExp(rule.pattern, 'i').test('')) return 'matches-everything';
    } catch {
      return null;
    }
  }
  return null;
}

export function ruleApplies(rule: MappingRule, description: string, amount: number, wfAccountId?: string, txDay?: string): boolean {
  // A stored rule that would match everything is never obeyed (see above).
  if (mappingRuleProblem(rule) !== null) return false;
  if (rule.onlyMoneyIn && !(amount > 0)) return false;
  if (rule.accountId && rule.accountId !== wfAccountId) return false;
  // A rule with `since` reads only transactions dated on or after it; one whose
  // day is unknown is left alone.
  if (rule.since && !(txDay !== undefined && txDay >= rule.since)) return false;
  if (rule.matchType === 'contains') return description.toLowerCase().includes(rule.pattern.toLowerCase());
  // Skip rules with invalid regex rather than crashing a whole sync run.
  // RuleEditor surfaces the error at save/preview time so the user can fix it.
  try {
    return new RegExp(rule.pattern, 'i').test(description);
  } catch {
    return false;
  }
}

function matchRule(description: string, rules: MappingRule[], amount: number, wfAccountId?: string, txDay?: string): MappingRule | null {
  return rules.find((rule) => ruleApplies(rule, description, amount, wfAccountId, txDay)) ?? null;
}

/** The same transaction rule: pattern, match, type, subtype and the payback limits. */
export function sameMappingRule(a: MappingRule, b: MappingRule): boolean {
  return a.pattern === b.pattern && a.matchType === b.matchType && a.activityType === b.activityType
    && (a.subtype ?? '') === (b.subtype ?? '') && !!a.onlyMoneyIn === !!b.onlyMoneyIn && (a.accountId ?? '') === (b.accountId ?? '')
    && (a.since ?? '') === (b.since ?? '');
}

/** The transaction rule W10 adds: money into one account whose bank text
 *  contains the pattern is a CREDIT marked REIMBURSEMENT — a payback — from
 *  the day it was made (`since`) on. */
export function paybackMappingRule(pattern: string, wfAccountId: string, since: string): MappingRule {
  return { pattern, matchType: 'contains', activityType: 'CREDIT', subtype: REIMBURSEMENT_SUBTYPE, onlyMoneyIn: true, accountId: wfAccountId, since };
}

// `capital one transfer` earned its place the hard way (2026-09-12): two real
// savings→spending transfers arrived described `CAPITAL ONE TRANSFER ACH WEB
// PAYMENT`, matched nothing here, and so defaulted to DEPOSIT — income — while
// the savings side was typed TRANSFER_OUT by a user's mapping rule. Pair
// detection only considers transfer-typed legs, so the two halves never met and
// $1,900 counted as income for two months.
//
// This branch is the right home for it precisely because it is direction-aware.
// A mapping rule is not: `matchRule` returns its type whichever way the money
// moved, so a rule typing this CREDIT or TRANSFER_IN would mis-book an OUTGOING
// transfer of the same name.
export const BANK_TRANSFER_KEYWORDS = /pnc bank|online transfer|wire transfer|bank transfer|member transfer|capital one transfer/i;

/** The four generic phrases: they say "a transfer" but not to whom (1.65 B). */
export const GENERIC_TRANSFER_KEYWORDS = /online transfer|wire transfer|bank transfer|member transfer/i;
/** Institution phrases that name a known transfer counterparty on their own. */
export const INSTITUTION_TRANSFER_KEYWORDS = /pnc bank|capital one transfer/i;

export function mapTransactionWithSource(
  description: string,
  amount: number,
  rules: MappingRule[],
  accountType?: string,
  /** The Wealthfolio account, for a rule scoped to one (W10). */
  wfAccountId?: string,
  /** The transaction's bank day (YYYY-MM-DD), for a rule that reads only new ones (W10). */
  txDay?: string,
): MappedType {
  const ruled = matchRule(description, rules, amount, wfAccountId, txDay);
  if (ruled) return { type: ruled.activityType, fromRule: true, ...(ruled.subtype ? { subtype: ruled.subtype } : {}), ...(ruled.since ? { createOnly: true as const } : {}) };

  if (accountType === 'CREDIT_CARD') {
    if (amount < 0) return { type: 'WITHDRAWAL', fromRule: false };
    // Positive on a card: a payment (transfer) or a merchant refund (CREDIT,
    // which Wealthfolio nets against spending as an expense refund)
    return {
      type: CARD_PAYMENT_KEYWORDS.test(description) ? 'TRANSFER_IN' : 'CREDIT',
      fromRule: false,
    };
  }

  // Money LEAVING a cash account to pay a card is a transfer, not a purchase.
  // Deliberately narrower than `CARD_PAYMENT_KEYWORDS`, which is safe on a card
  // account but not here: a bare "payment" describes rent and utilities too,
  // and typing those as transfers would erase real spending from every report.
  // "Credit card payment" carries no such ambiguity — nothing but a card
  // payment is described that way.
  //
  // Left OUT on purpose: `autopay`. Utilities and insurers use it constantly
  // ("AUTOPAY ELECTRIC"), so it fails the same test "payment" fails.
  //
  // Found live 2026-08-21: payments to a Discover card and to Coastal Community
  // Bank ("Ccb", the Robinhood card's issuer) imported as WITHDRAWAL and counted
  // as $228 of spending, while the user's Citibank payments — which a hand-written
  // mapping rule already typed — paired correctly. Note the issuer name no
  // keyword list would ever have contained; this pattern matches the payment
  // phrasing instead, which is the part banks agree on.
  if (amount < 0 && CASH_CARD_PAYMENT_KEYWORDS.test(description)) {
    return { type: 'TRANSFER_OUT', fromRule: false };
  }

  if (BANK_TRANSFER_KEYWORDS.test(description)) {
    return {
      type: amount >= 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT',
      fromRule: false,
      ...(amount < 0 && GENERIC_TRANSFER_KEYWORDS.test(description) && !INSTITUTION_TRANSFER_KEYWORDS.test(description) ? { genericTransferWording: true as const } : {}),
    };
  }

  return { type: amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL', fromRule: false };
}

export function mapTransaction(
  description: string,
  amount: number,
  rules: MappingRule[],
): ActivityType {
  return mapTransactionWithSource(description, amount, rules).type;
}
