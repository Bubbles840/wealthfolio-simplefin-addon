/**
 * Fee-reversal wording (issue #79). A bank fee that comes back ("Monthly
 * Maintenance Fee Waived") is not income: the mapper types it CREDIT/REFUND so
 * it nets against spending. Imports nothing, so every layer can share it.
 */

/** A fee word as a whole word, so "COFFEE" never matches. */
export const FEE_WORDS = /\bfees?\b|\bservice\s+charge\b|\blate\s+charge\b/i;

/** A word saying the fee came back. */
export const FEE_REVERSAL_WORDS = /\b(?:waived|waiver|reversal|reversed|refund|refunded|rebate|reimbursement|adjustment|adj|credit)\b/i;

/** The subtype a fee reversal carries. Never REIMBURSEMENT (that means "payback"). */
export const FEE_REVERSAL_SUBTYPE = 'REFUND';

/** A fee word and a reversal word. */
export function isFeeReversalWording(text: string): boolean {
  return FEE_WORDS.test(text) && FEE_REVERSAL_WORDS.test(text);
}

/** A fee word and no reversal word: the fee itself. */
export function isFeeWording(text: string): boolean {
  return FEE_WORDS.test(text) && !FEE_REVERSAL_WORDS.test(text);
}

/** Cash, card, or an account whose type is unknown (the mapper's cash path); never an investment account. */
export function feeReversalAccount(accountType: string | undefined): boolean {
  return accountType === undefined || accountType === '' || accountType === 'CASH' || accountType === 'CREDIT_CARD';
}
