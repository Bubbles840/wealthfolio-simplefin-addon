/**
 * Bank-first payments (A): money out of a bank account that names another
 * connected account, in money-movement words, is a transfer from the moment
 * it posts.
 *
 * The live case, 2026-10-17: a $42.40 `*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR`
 * left PNC. PNC posted before Citi did, so the sync had only one half, and
 * the row asked for a category — a card payment showing up as spending to
 * categorize.
 *
 * Until now the sync knew a withdrawal was a transfer two ways: the mapper's
 * wording rules, or the other half arriving to pair with it. Neither helps
 * while the first half is alone and its text is not in the wording list.
 * This adds a third: the text names ANOTHER connected account (the same
 * signal `expiryHoldAccount` already trusts, built by `accountNameWords`),
 * AND it says money moved (payment, autopay, ACH, ...). Both are needed:
 * the account name alone would make `CITI TRENDS #1234` a transfer.
 *
 * A row typed here takes the existing in-transit path: a TRANSFER_OUT that
 * pairs with its other half when it posts, or ages out like any other.
 */
import type { MappedType } from './mapper.js';

/**
 * R3: the phrasings that say money moved, each as a whole word. `ach` is here
 * for PNC's pending `ACH DEBIT ROBINHOOD CCB`, which has no "payment" in it.
 * The lookarounds keep `ACHIEVE`, `PAYMENTUS`, `TRANSFERWISE` and `REPAY` out.
 */
export const MONEY_MOVEMENT_WORDS = /(?<![a-z0-9])(?:payment|pmt|autopay|auto-pmt|e-?pay|e-payment|transfer|ach)(?![a-z0-9])/i;

/**
 * R2: does the text contain, as a whole word, any word of any other connected
 * account? Splits on the same `/[^a-z0-9]+/` that `accountNameWords` uses, so
 * `CITIZENS` never matches `citi`, nor `DISCOVERY` `discover`.
 */
export function namesConnectedAccount(description: string, otherAccountWords: ReadonlyArray<readonly string[]>): boolean {
  const words = new Set(description.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return otherAccountWords.some((accountWords) => accountWords.some((w) => words.has(w)));
}

/**
 * True when a mapped row should be typed as TRANSFER_OUT right now, before
 * its other half is seen.
 *
 * R1: money out of a CASH account only (an unknown account type is no
 *     evidence of one; inflows and cards are handled elsewhere).
 * R2: the text names another connected account.
 * R3: the text has money-movement wording.
 * R4: a mapping rule always wins, and a row the mapper already called a
 *     transfer needs nothing from us — only a plain WITHDRAWAL is promoted.
 *
 * `otherAccountWords` must leave out the row's own account. `notTransfer`
 * is applied by the caller afterwards, so it still wins.
 */
export function bankFirstTransferOut(
  description: string,
  amount: number,
  accountType: string | undefined,
  mapped: MappedType,
  otherAccountWords: ReadonlyArray<readonly string[]>,
): boolean {
  if (accountType !== 'CASH' || !(amount < 0)) return false;
  if (mapped.fromRule || mapped.type !== 'WITHDRAWAL') return false;
  return MONEY_MOVEMENT_WORDS.test(description) && namesConnectedAccount(description, otherAccountWords);
}
