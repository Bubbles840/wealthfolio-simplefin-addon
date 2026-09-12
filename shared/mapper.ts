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
}

function matchRule(description: string, rules: MappingRule[]): MappingRule | null {
  for (const rule of rules) {
    if (rule.matchType === 'contains') {
      if (description.toLowerCase().includes(rule.pattern.toLowerCase())) {
        return rule;
      }
    } else {
      // Skip rules with invalid regex rather than crashing a whole sync run.
      // RuleEditor surfaces the error at save/preview time so the user can fix it.
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, 'i');
      } catch {
        continue;
      }
      if (re.test(description)) {
        return rule;
      }
    }
  }
  return null;
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

export function mapTransactionWithSource(
  description: string,
  amount: number,
  rules: MappingRule[],
  accountType?: string,
): MappedType {
  const ruled = matchRule(description, rules);
  if (ruled) return { type: ruled.activityType, fromRule: true, ...(ruled.subtype ? { subtype: ruled.subtype } : {}) };

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
