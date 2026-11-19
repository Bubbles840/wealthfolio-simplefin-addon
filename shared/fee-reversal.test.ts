import { describe, it, expect } from 'vitest';
import { isFeeReversalWording, isFeeWording } from './fee-reversal';

/** The design's fixture lists (#79), verbatim. */
const REVERSALS = [
  'Monthly Maintenance Fee Waived',
  'ADJUST FEE CHARGED ATM FEE REBATE',
  'LATE CHARGE ADJUSTMENT',
  'LATE PAYMENT FEE REVERSAL',
  'OVERDRAFT FEE REFUND',
  'ATM FEE REIMBURSEMENT',
  'SERVICE CHARGE REVERSAL',
];
const NOT_REVERSALS = ['TAX REFUND', 'COFFEE REFUND', 'AMAZON REFUND', 'MONTHLY MAINTENANCE FEE'];

describe('fee reversal wording (#79)', () => {
  it.each(REVERSALS)('reads "%s" as a fee coming back', (text) => {
    expect(isFeeReversalWording(text)).toBe(true);
    expect(isFeeWording(text)).toBe(false);
  });

  it.each(NOT_REVERSALS)('does not read "%s" as a fee coming back', (text) => {
    expect(isFeeReversalWording(text)).toBe(false);
  });

  it('reads a fee with no reversal word as the fee itself, and never COFFEE as a fee', () => {
    expect(isFeeWording('MONTHLY MAINTENANCE FEE')).toBe(true);
    expect(isFeeWording('OVERDRAFT FEES')).toBe(true);
    expect(isFeeWording('SERVICE CHARGE')).toBe(true);
    expect(isFeeWording('LATE CHARGE')).toBe(true);
    expect(isFeeWording('COFFEE SHOP')).toBe(false);
    expect(isFeeWording('FEEDBACK SURVEY')).toBe(false);
  });
});
