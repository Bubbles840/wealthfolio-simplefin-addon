/**
 * shared/cash-flow-bucket.ts
 *
 * PORT of Wealthfolio's own rule for which category TAXONOMY (spending /
 * income / savings / none) an activity may carry, ported from
 * `crates/spending/src/activity_classification.rs:97-130` — see
 * `docs/upstream-spending-buckets.md` §2 for the full upstream trace with
 * verified line numbers, and §1 for `ensure_activity_assignment_allowed`,
 * the acceptance check `assignabilityOf` below reproduces.
 *
 * This is a PORT, not a call to Wealthfolio: there is no endpoint that
 * answers "which bucket is this activity in" ahead of a write, so the only
 * way to decide legality before writing anything is to duplicate upstream's
 * Rust match arms here. If upstream's rule changes, this file silently
 * disagrees with it, and the failure mode is a 400 the user sees — exactly
 * the mismatch that shipped once already, when a guessed rule (put a
 * spending category on a credit and hope) was rejected by the real server
 * AFTER the code had already deleted the old category, leaving a real
 * transaction bare. Checking `assignabilityOf` before writing anything is
 * what prevents that specific failure; it does not remove the risk that
 * upstream moves and this port does not.
 */

export type CashFlowBucket = 'income' | 'spending' | 'saving' | 'neutral';

/** Literal taxonomy ids, as seeded by upstream's migration (see
 *  `docs/upstream-spending-buckets.md` §3) — not derived from any label, so
 *  the "income categories" wording in upstream's own error text does not
 *  mislead anyone reading this into typing `income_categories` here. */
export const SPENDING_TAXONOMY_ID = 'spending_categories';
export const INCOME_TAXONOMY_ID = 'income_sources';
export const SAVINGS_TAXONOMY_ID = 'savings_categories';

export const REIMBURSEMENT_SUBTYPE = 'REIMBURSEMENT';

/** The three subtypes upstream treats as an expense refund. A CASH-account
 *  CREDIT with one of these lands in the `spending` bucket, never `income`
 *  — it is booked as a negative against the spending category it is paying
 *  back, not counted as new money in. See `docs/upstream-spending-buckets.md`
 *  §2 and §4. */
export const REFUND_SUBTYPES: readonly string[] = ['REFUND', 'REBATE', REIMBURSEMENT_SUBTYPE];

export interface BucketInput {
  accountType: string;
  activityType: string;
  subtype?: string | null;
}

const CASH_INCOME_TYPES = new Set(['DEPOSIT', 'TRANSFER_IN', 'INTEREST']);
const CASH_EXPENSE_TYPES = new Set(['WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX']);
const CREDIT_CARD_EXPENSE_TYPES = new Set(['WITHDRAWAL', 'FEE', 'INTEREST']);

/**
 * Port of `classify_activity` (`activity_classification.rs:97-130`), folded
 * directly to the four-way `CashFlowBucket` upstream's own
 * `cash_flow_bucket_from_classification` collapses its six-way
 * `SpendingClassification` to (`cash_activities/service.rs:839-850`) — the
 * Income/Expense/ExpenseRefund/Saving/InternalTransfer/Ignored split is not
 * reproduced here because every caller of this predicate only ever asks
 * "which taxonomy, if any" and Expense/ExpenseRefund already collapse to the
 * same answer upstream-side.
 *
 * Case-insensitive on `activityType` and `subtype`: upstream canonicalizes
 * `subtype` server-side (`Activity::canonicalize_subtype`, a case-insensitive
 * match against ten known constants) before this classification ever runs,
 * so this predicate must land a lower-case `"reimbursement"` on exactly the
 * same bucket upstream would after its own canonicalization — `spending`,
 * never `neutral`.
 */
export function bucketFor(input: BucketInput): CashFlowBucket {
  const accountType = input.accountType.toUpperCase();
  const activityType = input.activityType.toUpperCase();
  const subtype = input.subtype ? input.subtype.toUpperCase() : null;

  if (accountType === 'CASH') {
    if (CASH_INCOME_TYPES.has(activityType)) return 'income';
    if (CASH_EXPENSE_TYPES.has(activityType)) return 'spending';
    if (activityType === 'CREDIT') {
      if (subtype === 'BONUS') return 'income';
      if (subtype !== null && REFUND_SUBTYPES.includes(subtype)) return 'spending';
      // Bare CREDIT, or a subtype upstream doesn't recognize at all: this is
      // `Ignored` upstream, which folds to `neutral` — NOT `income`. This is
      // the exact case that cost a real user's category: a bare credit is
      // not automatically anything, and nothing may be assigned to it until
      // its subtype is set to one of the three refund values above.
      return 'neutral';
    }
    return 'neutral';
  }

  if (accountType === 'CREDIT_CARD') {
    if (CREDIT_CARD_EXPENSE_TYPES.has(activityType)) return 'spending';
    // Every CREDIT on a CREDIT_CARD account is ExpenseRefund → spending,
    // subtype irrelevant (activity_classification.rs:120-124) — account type
    // wins here. A BONUS subtype does NOT make this income the way it would
    // on a CASH account; do not "fix" this to match the CASH arm above.
    if (activityType === 'CREDIT') return 'spending';
    return 'neutral';
  }

  // Any other account type (e.g. SECURITIES): upstream's outer match falls
  // through to `_ => Ignored` for every activity type.
  return 'neutral';
}

/** The one taxonomy a bucket accepts, or null for neutral (nothing
 *  assignable) — port of `taxonomy_for_bucket`, referenced in
 *  `docs/upstream-spending-buckets.md` §1. */
export function taxonomyForBucket(bucket: CashFlowBucket): string | null {
  switch (bucket) {
    case 'income':
      return INCOME_TAXONOMY_ID;
    case 'spending':
      return SPENDING_TAXONOMY_ID;
    case 'saving':
      return SAVINGS_TAXONOMY_ID;
    case 'neutral':
      return null;
  }
}

/**
 * Port of `ensure_activity_assignment_allowed`'s bucket check
 * (`cash_activities/service.rs:709-729`, see
 * `docs/upstream-spending-buckets.md` §1) — decide BEFORE writing anything
 * whether `taxonomyId` may be assigned to this activity, instead of finding
 * out from the server's 400 after a previous category has already been
 * deleted client-side.
 *
 * `reason` is a machine token, never display text: upstream reuses one Rust
 * error string ("Neutral transfers cannot be categorized...") for both an
 * actual internal transfer AND a merely-Ignored/neutral activity
 * (`docs/upstream-spending-buckets.md` §2), which would be a misleading
 * message to surface verbatim for the latter. Callers map `'neutral'` and
 * `'wrong-bucket'` to their own copy instead of forwarding upstream's prose.
 */
export function assignabilityOf(
  input: BucketInput,
  taxonomyId: string,
):
  | { ok: true }
  | { ok: false; reason: 'neutral' | 'wrong-bucket'; bucket: CashFlowBucket; expected: string | null } {
  const bucket = bucketFor(input);
  const expected = taxonomyForBucket(bucket);
  if (expected === null) {
    return { ok: false, reason: 'neutral', bucket, expected: null };
  }
  if (expected !== taxonomyId) {
    return { ok: false, reason: 'wrong-bucket', bucket, expected };
  }
  return { ok: true };
}

/**
 * Would a refund subtype move THIS row into the spending bucket? Asked of a
 * row that has just been refused, to decide whether telling its reader about
 * the reimbursement route would help them or waste their time.
 *
 * `neutral` is a much wider answer than "a credit that has not been marked a
 * refund yet": it is also every activity on a SECURITIES account, every account
 * type this port does not know (including an EMPTY one, which is what the native
 * reader hands over when it cannot resolve the account), and every non-expense
 * type on a CREDIT_CARD. No subtype changes any of those — the account type
 * decides them — so a message offering the subtype fix there would send someone
 * to a setting that cannot move their transaction.
 *
 * Answered by asking `bucketFor` itself, with the subtype swapped, rather than
 * by re-listing the account/type arms above: a second copy of that table is
 * exactly how this file would come to disagree with itself. Only meaningful for
 * a row `assignabilityOf` has already refused — an ordinary card purchase
 * answers `true` here and needs no fix at all.
 */
export function refundSubtypeWouldMakeSpending(input: BucketInput): boolean {
  return bucketFor({ ...input, subtype: REIMBURSEMENT_SUBTYPE }) === 'spending';
}
