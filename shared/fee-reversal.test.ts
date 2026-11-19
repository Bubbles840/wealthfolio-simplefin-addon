import { describe, it, expect } from 'vitest';
import { isFeeReversalWording, isFeeWording, planFeeReversalFilings, type FeeReversalRow } from './fee-reversal';

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

  it('counts "credit" only directly after a fee word', () => {
    for (const t of ['LATE FEE CREDIT', 'SERVICE CHARGE CREDIT', 'ATM FEES CREDIT', 'late charge  credit']) {
      expect(isFeeReversalWording(t)).toBe(true);
      expect(isFeeWording(t)).toBe(false);
    }
    for (const t of ['CONSULTING FEE ACH CREDIT', 'ACH CREDIT PAYROLL FEE', 'CREDIT UNION TRANSFER FEE']) {
      expect(isFeeReversalWording(t)).toBe(false);
    }
  });
});

const TODAY = '2026-11-18';
const FEES = { categoryId: 'cat-fees', categoryName: 'Bank Fees' };
const refund = (id: string, date: string, over: Partial<FeeReversalRow> = {}): FeeReversalRow => ({
  activityId: id, wfAccountId: 'wf-chk', description: 'OVERDRAFT FEE REFUND', amountCents: 3500, date,
  direction: 'in', activityType: 'CREDIT', subtype: 'REFUND', spending: null, income: null, ...over,
});
const fee = (id: string, date: string, over: Partial<FeeReversalRow> = {}): FeeReversalRow => ({
  activityId: id, wfAccountId: 'wf-chk', description: 'OVERDRAFT FEE', amountCents: 3500, date,
  direction: 'out', activityType: 'WITHDRAWAL', subtype: null, spending: FEES, income: null, ...over,
});
const filed = (rows: FeeReversalRow[]) => planFeeReversalFilings(rows, TODAY).map((f) => [f.refund.activityId, f.fee.activityId, f.category.categoryId]);

describe('planFeeReversalFilings (#79)', () => {
  it('files a refund under the category of the closest same-amount fee before it, same account', () => {
    expect(filed([
      refund('r', '2026-11-10'),
      fee('near', '2026-11-07', { spending: { categoryId: 'cat-near', categoryName: 'Near' } }),
      fee('far', '2026-10-20'),
    ])).toEqual([['r', 'near', 'cat-near']]);
  });

  it('counts a fee from the same day to 30 days before, and none older', () => {
    expect(filed([refund('r', '2026-11-10'), fee('f', '2026-11-10')])).toEqual([['r', 'f', 'cat-fees']]);
    expect(filed([refund('r', '2026-11-10'), fee('f', '2026-10-11')])).toEqual([['r', 'f', 'cat-fees']]);
    expect(filed([refund('r', '2026-11-10'), fee('f', '2026-10-10')])).toEqual([]);
  });

  it.each<[string, Partial<FeeReversalRow>]>([
    ['in another account', { wfAccountId: 'wf-other' }],
    ['of another amount', { amountCents: 3501 }],
    ['dated after the refund', { date: '2026-11-11' }],
    ['worded as a reversal itself', { description: 'FEE REVERSAL' }],
    ['not a fee at all', { description: 'COFFEE' }],
    ['money in', { direction: 'in' }],
    ['with no spending category', { spending: null }],
  ])('copies nothing from a fee %s', (_name, over) => {
    expect(filed([refund('r', '2026-11-10'), fee('f', '2026-11-09', over)])).toEqual([]);
  });

  it('lets one fee reverse one refund, the closest first', () => {
    expect(filed([refund('r12', '2026-11-12'), refund('r10', '2026-11-10'), fee('f', '2026-11-09')])).toEqual([['r10', 'f', 'cat-fees']]);
  });

  it('never files a refund that has a spending category, though it still takes its fee', () => {
    expect(filed([
      refund('mine', '2026-11-10', { spending: { categoryId: 'cat-x', categoryName: 'X' } }),
      refund('r', '2026-11-11'),
      fee('f', '2026-11-09'),
    ])).toEqual([]);
  });

  it('treats an income category as none and hands it back for the change log', () => {
    const income = { categoryId: 'cat-inc', categoryName: 'Refunds' };
    const [f] = planFeeReversalFilings([refund('r', '2026-11-10', { income }), fee('f', '2026-11-09')], TODAY);
    expect(f.refund.income).toEqual(income);
    expect(f.category).toEqual(FEES);
  });

  it('files only refunds from the last 60 days, and only CREDIT/REFUND rows with fee-reversal wording', () => {
    expect(filed([refund('old', '2026-09-18'), fee('f', '2026-09-17')])).toEqual([]);
    expect(filed([refund('r', '2026-09-19'), fee('f', '2026-09-18')])).toEqual([['r', 'f', 'cat-fees']]);
    expect(filed([refund('dep', '2026-11-10', { activityType: 'DEPOSIT', subtype: null }), fee('f', '2026-11-09')])).toEqual([]);
    expect(filed([refund('tax', '2026-11-10', { description: 'TAX REFUND' }), fee('f', '2026-11-09')])).toEqual([]);
  });
});
