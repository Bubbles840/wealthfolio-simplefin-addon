import { describe, it, expect } from 'vitest';
import {
  bucketFor,
  taxonomyForBucket,
  assignabilityOf,
  refundSubtypeWouldMakeSpending,
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

describe('bucketFor never returns "saving" — pins an assumption REFUSED_TEXT relies on', () => {
  // `REFUSED_TEXT['wrong-bucket']` (shared/categorize-menu.ts) hardcodes "It
  // is recorded as money in" instead of branching on the bucket, because the
  // only caller that reaches that reason always asks about
  // SPENDING_TAXONOMY_ID, and — per docs/upstream-spending-buckets.md §2 —
  // `classify_activity` (activity_classification.rs:97-130, what `bucketFor`
  // ports) has exactly three outer arms: CASH, CREDIT_CARD, and a wildcard
  // that falls to `Ignored`/neutral. None of the three ever constructs
  // `SpendingClassification::Saving`, so `taxonomyForBucket('saving')` — which
  // does exist, and maps to SAVINGS_TAXONOMY_ID — is dead code from
  // `bucketFor`'s side: nothing this port can classify ever reaches it, for
  // ANY account type, activity type, or subtype.
  //
  // 'SAVINGS' is the most literal guess for what an eventual Saving arm would
  // key its account type off of; `bucketFor` has none, so this exercises the
  // same `_ => neutral` fallback as any other account type this port does not
  // recognize (SECURITIES, tested above). The day upstream's rule — and this
  // port of it — grows an arm that actually returns 'saving', this test
  // starts failing, which is the signal that REFUSED_TEXT['wrong-bucket']
  // needs to branch on `bucket` instead of assuming 'income'.
  it('an account type named for savings still falls through to neutral, not saving', () => {
    expect(bucketFor({ accountType: 'SAVINGS', activityType: 'DEPOSIT' })).toBe('neutral');
    expect(bucketFor({ accountType: 'SAVINGS', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' })).toBe('neutral');
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

describe('refundSubtypeWouldMakeSpending — is the refusal one a subtype can lift?', () => {
  it('yes for a CASH credit, the one row a refund subtype moves', () => {
    // Bare, and with a subtype upstream does not recognize: both are `neutral`
    // today and both become `spending` the moment the subtype is a refund one.
    expect(refundSubtypeWouldMakeSpending({ accountType: 'CASH', activityType: 'CREDIT' })).toBe(true);
    expect(refundSubtypeWouldMakeSpending({
      accountType: 'CASH', activityType: 'CREDIT', subtype: 'Venmo',
    })).toBe(true);
    // Case-insensitive, like every other read of these fields.
    expect(refundSubtypeWouldMakeSpending({ accountType: 'cash', activityType: 'credit' })).toBe(true);
  });

  it('no when the ACCOUNT TYPE is what decides, so no subtype could ever help', () => {
    // The reason this predicate exists: `neutral` covers all of these, and a
    // message offering the reimbursement fix would send their reader to a
    // setting that cannot move the transaction.
    for (const accountType of ['SECURITIES', 'CRYPTOCURRENCY', 'SOMETHING_NEW', '']) {
      expect(refundSubtypeWouldMakeSpending({ accountType, activityType: 'CREDIT' })).toBe(false);
      expect(refundSubtypeWouldMakeSpending({ accountType, activityType: 'DEPOSIT' })).toBe(false);
    }
    // A CREDIT_CARD non-expense type is neutral for the same kind of reason.
    expect(refundSubtypeWouldMakeSpending({ accountType: 'CREDIT_CARD', activityType: 'DEPOSIT' })).toBe(false);
  });

  it('no for money IN on a cash account — a subtype does not turn a deposit into a spend', () => {
    // A CASH DEPOSIT is income even carrying REIMBURSEMENT: the income arm is
    // matched before the subtype is ever read. This is why the rule sets the
    // activity TYPE as well, and why the wrong-bucket copy names the rule rather
    // than the subtype on its own.
    expect(refundSubtypeWouldMakeSpending({ accountType: 'CASH', activityType: 'DEPOSIT' })).toBe(false);
    expect(refundSubtypeWouldMakeSpending({
      accountType: 'CASH', activityType: 'DEPOSIT', subtype: REIMBURSEMENT_SUBTYPE,
    })).toBe(false);
  });
});
