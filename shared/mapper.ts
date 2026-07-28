import type { ActivityType, MappingRule } from './types';

/**
 * Payment-shaped descriptions on credit cards (incoming card payments).
 * Applied ONLY to positive amounts on CREDIT_CARD accounts — on cash accounts
 * "payment" is too generic (rent payment, utility payment are real expenses).
 */
export const CARD_PAYMENT_KEYWORDS = /payment|autopay|thank you|e-?pay/i;

export interface MappedType {
  type: ActivityType;
  /** True when a user mapping rule decided the type (never auto-overridden) */
  fromRule: boolean;
}

function matchRule(description: string, rules: MappingRule[]): ActivityType | null {
  for (const rule of rules) {
    if (rule.matchType === 'contains') {
      if (description.toLowerCase().includes(rule.pattern.toLowerCase())) {
        return rule.activityType;
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
        return rule.activityType;
      }
    }
  }
  return null;
}

export const BANK_TRANSFER_KEYWORDS = /pnc bank|online transfer|wire transfer|bank transfer|member transfer/i;

export function mapTransactionWithSource(
  description: string,
  amount: number,
  rules: MappingRule[],
  accountType?: string,
): MappedType {
  const ruled = matchRule(description, rules);
  if (ruled) return { type: ruled, fromRule: true };

  if (accountType === 'CREDIT_CARD') {
    if (amount < 0) return { type: 'WITHDRAWAL', fromRule: false };
    // Positive on a card: a payment (transfer) or a merchant refund (CREDIT,
    // which Wealthfolio nets against spending as an expense refund)
    return {
      type: CARD_PAYMENT_KEYWORDS.test(description) ? 'TRANSFER_IN' : 'CREDIT',
      fromRule: false,
    };
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
