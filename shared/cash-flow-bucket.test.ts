import { describe, it, expect } from 'vitest';
import {
  bucketFor,
  taxonomyForBucket,
  assignabilityOf,
  SPENDING_TAXONOMY_ID,
  INCOME_TAXONOMY_ID,
  SAVINGS_TAXONOMY_ID,
  REIMBURSEMENT_SUBTYPE,
  REFUND_SUBTYPES,
} from './cash-flow-bucket';
import type { CashFlowBucket, BucketInput } from './cash-flow-bucket';

// The full matrix from `crates/spending/src/activity_classification.rs:97-130`
// (see docs/upstream-spending-buckets.md §2), one row per upstream match arm.
// Two rows are pinned explicitly because they cost this project a real user's
// category once: a bare/unrecognized-subtype CASH+CREDIT is `neutral`, NOT
// income, and a CREDIT_CARD+CREDIT stays `spending` even with a BONUS
// subtype — account type wins there, subtype does not.
const MATRIX: Array<{ name: string; input: BucketInput; expected: CashFlowBucket }> = [
  // CASH — income arm
  { name: 'CASH DEPOSIT', input: { accountType: 'CASH', activityType: 'DEPOSIT' }, expected: 'income' },
  { name: 'CASH TRANSFER_IN', input: { accountType: 'CASH', activityType: 'TRANSFER_IN' }, expected: 'income' },
  { name: 'CASH INTEREST', input: { accountType: 'CASH', activityType: 'INTEREST' }, expected: 'income' },
  // CASH — expense arm
  { name: 'CASH WITHDRAWAL', input: { accountType: 'CASH', activityType: 'WITHDRAWAL' }, expected: 'spending' },
  { name: 'CASH TRANSFER_OUT', input: { accountType: 'CASH', activityType: 'TRANSFER_OUT' }, expected: 'spending' },
  { name: 'CASH FEE', input: { accountType: 'CASH', activityType: 'FEE' }, expected: 'spending' },
  { name: 'CASH TAX', input: { accountType: 'CASH', activityType: 'TAX' }, expected: 'spending' },
  // CASH + CREDIT — the subtype-dependent arm
  {
    name: 'CASH CREDIT with no subtype is neutral, NOT income',
    input: { accountType: 'CASH', activityType: 'CREDIT' },
    expected: 'neutral',
  },
  {
    name: 'CASH CREDIT with an unrecognized subtype is neutral',
    input: { accountType: 'CASH', activityType: 'CREDIT', subtype: 'SOMETHING_ELSE' },
    expected: 'neutral',
  },
  {
    name: 'CASH CREDIT + BONUS is income',
    input: { accountType: 'CASH', activityType: 'CREDIT', subtype: 'BONUS' },
    expected: 'income',
  },
  {
    name: 'CASH CREDIT + REFUND is spending (expense refund)',
    input: { accountType: 'CASH', activityType: 'CREDIT', subtype: 'REFUND' },
    expected: 'spending',
  },
  {
    name: 'CASH CREDIT + REBATE is spending (expense refund)',
    input: { accountType: 'CASH', activityType: 'CREDIT', subtype: 'REBATE' },
    expected: 'spending',
  },
  {
    name: 'CASH CREDIT + REIMBURSEMENT is spending (expense refund)',
    input: { accountType: 'CASH', activityType: 'CREDIT', subtype: REIMBURSEMENT_SUBTYPE },
    expected: 'spending',
  },
  {
    name: 'CASH CREDIT + lower-case "reimbursement" is still spending (case-insensitive subtype)',
    input: { accountType: 'CASH', activityType: 'CREDIT', subtype: 'reimbursement' },
    expected: 'spending',
  },
  {
    name: 'CASH with an activity type outside every arm is neutral',
    input: { accountType: 'CASH', activityType: 'SPLIT' },
    expected: 'neutral',
  },
  // CREDIT_CARD — subtype is irrelevant here, account type wins
  { name: 'CREDIT_CARD WITHDRAWAL', input: { accountType: 'CREDIT_CARD', activityType: 'WITHDRAWAL' }, expected: 'spending' },
  { name: 'CREDIT_CARD FEE', input: { accountType: 'CREDIT_CARD', activityType: 'FEE' }, expected: 'spending' },
  { name: 'CREDIT_CARD INTEREST', input: { accountType: 'CREDIT_CARD', activityType: 'INTEREST' }, expected: 'spending' },
  {
    name: 'CREDIT_CARD CREDIT with no subtype is spending',
    input: { accountType: 'CREDIT_CARD', activityType: 'CREDIT' },
    expected: 'spending',
  },
  {
    name: 'CREDIT_CARD CREDIT + BONUS is STILL spending — account type wins, not income',
    input: { accountType: 'CREDIT_CARD', activityType: 'CREDIT', subtype: 'BONUS' },
    expected: 'spending',
  },
  {
    name: 'CREDIT_CARD with an activity type outside every arm is neutral',
    input: { accountType: 'CREDIT_CARD', activityType: 'SPLIT' },
    expected: 'neutral',
  },
  // Unrecognized account type — outer match's `_ => Ignored`
  {
    name: 'an unknown account type (SECURITIES) is neutral regardless of activity type',
    input: { accountType: 'SECURITIES', activityType: 'DEPOSIT' },
    expected: 'neutral',
  },
  // Case-insensitivity on accountType and activityType (subtype covered above)
  {
    name: 'lower-case accountType and activityType behave the same as upper-case',
    input: { accountType: 'cash', activityType: 'deposit' },
    expected: 'income',
  },
  {
    name: 'lower-case CREDIT + lower-case BONUS subtype is income',
    input: { accountType: 'cash', activityType: 'credit', subtype: 'bonus' },
    expected: 'income',
  },
];

describe('bucketFor', () => {
  it.each(MATRIX)('$name', ({ input, expected }) => {
    expect(bucketFor(input)).toBe(expected);
  });
});

describe('REFUND_SUBTYPES', () => {
  it('is exactly REFUND, REBATE, REIMBURSEMENT', () => {
    expect(REFUND_SUBTYPES).toEqual(['REFUND', 'REBATE', 'REIMBURSEMENT']);
  });

  it('REIMBURSEMENT_SUBTYPE is the same string used in REFUND_SUBTYPES', () => {
    expect(REFUND_SUBTYPES).toContain(REIMBURSEMENT_SUBTYPE);
    expect(REIMBURSEMENT_SUBTYPE).toBe('REIMBURSEMENT');
  });
});

describe('taxonomy id constants', () => {
  // Byte-for-byte match required: companion/src/categorize.ts:81 declares its
  // own SPENDING_TAXONOMY_ID copy independently, and a later task deletes
  // that copy in favor of this one — if the strings ever drifted, that swap
  // would silently change which taxonomy every existing write targets.
  it('match the literal ids upstream seeds (docs/upstream-spending-buckets.md §3)', () => {
    expect(SPENDING_TAXONOMY_ID).toBe('spending_categories');
    expect(INCOME_TAXONOMY_ID).toBe('income_sources');
    expect(SAVINGS_TAXONOMY_ID).toBe('savings_categories');
  });
});

describe('taxonomyForBucket', () => {
  it('maps income to the income taxonomy', () => {
    expect(taxonomyForBucket('income')).toBe(INCOME_TAXONOMY_ID);
  });

  it('maps spending to the spending taxonomy', () => {
    expect(taxonomyForBucket('spending')).toBe(SPENDING_TAXONOMY_ID);
  });

  it('maps saving to the savings taxonomy', () => {
    expect(taxonomyForBucket('saving')).toBe(SAVINGS_TAXONOMY_ID);
  });

  it('maps neutral to null — nothing is assignable', () => {
    expect(taxonomyForBucket('neutral')).toBeNull();
  });
});

describe('assignabilityOf', () => {
  it('is ok when the taxonomy id matches the derived bucket', () => {
    const input: BucketInput = { accountType: 'CASH', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' };
    expect(assignabilityOf(input, SPENDING_TAXONOMY_ID)).toEqual({ ok: true });
  });

  it('reports "neutral" (not "wrong-bucket") when nothing is assignable at all', () => {
    const input: BucketInput = { accountType: 'CASH', activityType: 'CREDIT' };
    expect(assignabilityOf(input, SPENDING_TAXONOMY_ID)).toEqual({
      ok: false,
      reason: 'neutral',
      bucket: 'neutral',
      expected: null,
    });
  });

  it('reports "wrong-bucket" with the expected taxonomy when the id does not match', () => {
    const input: BucketInput = { accountType: 'CASH', activityType: 'CREDIT', subtype: 'BONUS' };
    expect(assignabilityOf(input, SPENDING_TAXONOMY_ID)).toEqual({
      ok: false,
      reason: 'wrong-bucket',
      bucket: 'income',
      expected: INCOME_TAXONOMY_ID,
    });
  });

  it('rejects income taxonomy for a plain CASH DEPOSIT-less spending activity', () => {
    const input: BucketInput = { accountType: 'CASH', activityType: 'WITHDRAWAL' };
    expect(assignabilityOf(input, INCOME_TAXONOMY_ID)).toEqual({
      ok: false,
      reason: 'wrong-bucket',
      bucket: 'spending',
      expected: SPENDING_TAXONOMY_ID,
    });
  });
});
