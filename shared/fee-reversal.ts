/**
 * Fee-reversal wording (issue #79). A bank fee that comes back ("Monthly
 * Maintenance Fee Waived") is not income: the mapper types it CREDIT/REFUND so
 * it nets against spending. Imports nothing, so every layer can share it.
 */

/** A fee word as a whole word, so "COFFEE" never matches. */
export const FEE_WORDS = /\bfees?\b|\bservice\s+charge\b|\blate\s+charge\b/i;

/** A word saying the fee came back. "credit" counts only directly after a fee
 *  word ("FEE CREDIT", "SERVICE CHARGE CREDIT"): "ACH CREDIT" prefixes ordinary
 *  incoming deposits, so a bare "credit" is not evidence. */
export const FEE_REVERSAL_WORDS = /\b(?:waived|waiver|reversal|reversed|refund|refunded|rebate|reimbursement|adjustment|adj)\b|(?:\bfees?|\bservice\s+charge|\blate\s+charge)\s+credit\b/i;

/** The subtype a fee reversal carries. Never REIMBURSEMENT (that means "payback"). */
export const FEE_REVERSAL_SUBTYPE = 'REFUND';

/** The `why` on the change entry the companion writes when it files a fee reversal under its fee's category (the story reads it). */
export const FEE_REVERSAL_FILING_WHY = 'Same category as the fee it reverses';

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

/** A refund is filed only when it is dated within this many days of today. */
export const FEE_REVERSAL_FILING_DAYS = 60;
/** A fee counts as the one a refund reverses from the refund's day back this many days. */
export const FEE_REVERSAL_FEE_WINDOW_DAYS = 30;

export interface FiledCategoryRef {
  categoryId: string;
  categoryName: string;
}

/** One cash or card activity as the matcher reads it. */
export interface FeeReversalRow {
  activityId: string;
  wfAccountId: string;
  /** The bank's words. */
  description: string;
  /** Magnitude, in cents. */
  amountCents: number;
  /** YYYY-MM-DD. */
  date: string;
  direction: 'in' | 'out';
  /** The effective activity type, upper case. */
  activityType: string;
  subtype: string | null;
  spending: FiledCategoryRef | null;
  income: FiledCategoryRef | null;
}

export interface FeeReversalFiling<R extends FeeReversalRow = FeeReversalRow> {
  refund: R;
  fee: R;
  /** The fee's spending category. */
  category: FiledCategoryRef;
}

const DAY_MS = 86_400_000;
const dayNumber = (date: string): number => Math.floor(Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / DAY_MS);

/**
 * Which refund reverses which fee. Every fee-reversal refund takes part in the
 * matching, filed or not, so one that is already filed, undone, or too old still
 * keeps its fee. Only refunds with no spending category, dated within the last
 * 60 days, are returned; an income category counts as none.
 */
export function planFeeReversalFilings<R extends FeeReversalRow>(rows: readonly R[], today: string): Array<FeeReversalFiling<R>> {
  const refunds = rows.filter(
    (r) => r.direction === 'in' && r.activityType === 'CREDIT' && (r.subtype ?? '').trim().toUpperCase() === FEE_REVERSAL_SUBTYPE && isFeeReversalWording(r.description),
  );
  const fees = rows.filter((r) => r.direction === 'out' && isFeeWording(r.description));
  const pairs: Array<{ refund: R; fee: R; gap: number }> = [];
  for (const refund of refunds) {
    for (const fee of fees) {
      if (fee.wfAccountId !== refund.wfAccountId || fee.amountCents !== refund.amountCents) continue;
      const gap = dayNumber(refund.date) - dayNumber(fee.date);
      if (gap >= 0 && gap <= FEE_REVERSAL_FEE_WINDOW_DAYS) pairs.push({ refund, fee, gap });
    }
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  pairs.sort((a, b) => a.gap - b.gap || cmp(a.refund.date, b.refund.date) || cmp(a.refund.activityId, b.refund.activityId) || cmp(a.fee.activityId, b.fee.activityId));
  const usedRefunds = new Set<R>();
  const usedFees = new Set<R>();
  const earliest = dayNumber(today) - FEE_REVERSAL_FILING_DAYS;
  const out: Array<FeeReversalFiling<R>> = [];
  for (const { refund, fee } of pairs) {
    if (usedRefunds.has(refund) || usedFees.has(fee)) continue;
    usedRefunds.add(refund);
    usedFees.add(fee);
    if (refund.spending || !fee.spending || dayNumber(refund.date) < earliest) continue;
    out.push({ refund, fee, category: fee.spending });
  }
  return out;
}
