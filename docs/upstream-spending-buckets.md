# Wealthfolio: CREDIT-activity category-assignment validation — findings

Repo: `afadil/wealthfolio` @ `main`. All paths below are relative to repo root.
All line numbers verified against `main` as of 2026-08-11.

## 1. Where the validation lives

`crates/spending/src/cash_activities/service.rs`, method
`ensure_activity_assignment_allowed` (lines 674–732), called from:
- `assign_category` (line 507) — the single-assignment path, `enforce_bucket=true`
- `bulk_assign_categories` (line 525) — `enforce_bucket=true` for every item
- `unassign_category` (line 515) — `enforce_bucket=false` (bucket check skipped on unassign)

This is reached from the HTTP layer via
`apps/server/src/api/spending.rs::assign_activity_category` (lines 208–218),
routed at `PUT /spending/activities/{activity_id}/assignments` (line 740).

The exact predicate (lines 709–729):

```rust
let bucket = cash_flow_bucket_from_classification(classify_activity_for_aggregation(
    &activity,
    account_type,
    &transfer_groups,
));
let Some(expected_taxonomy) = taxonomy_for_bucket(bucket) else {
    return Err(SpendingError::InvalidInput {
        message: "Neutral transfers cannot be categorized. Change or unlink the transfer if it should count as spending.".to_string(),
    }
    .into());
};
if expected_taxonomy != taxonomy_id {
    return Err(SpendingError::InvalidInput {
        message: format!(
            "{} activities can only use {} categories. Categories label the cash-flow bucket; they do not change it.",
            bucket.label(),
            bucket.taxonomy_label(),
        ),
    }
    .into());
}
```

`bucket.label()` = `"Income"`/`"Spending"`/`"Saving"`/`"Neutral"`;
`bucket.taxonomy_label()` = `"income"`/`"spending"`/`"savings"`/`"no"` (lines 885–903).
`"Income" + "income"` reproduces the exact error text you saw.

Before this bucket check, the taxonomy id itself is validated against a
fixed allow-list (lines 680–688):

```rust
if taxonomy_id != SPENDING_TAXONOMY
    && taxonomy_id != INCOME_TAXONOMY
    && taxonomy_id != SAVINGS_TAXONOMY
{
    return Err(SpendingError::InvalidInput {
        message: "Taxonomy is not assignable to spending activities".to_string(),
    }.into());
}
```

So there are two independent 400s possible: an unknown `taxonomy_id`, or a
correct-but-mismatched `taxonomy_id` for the activity's derived bucket.

## 2. The activity side of the predicate

It is **not** the bare `activity_type` and **not** the account type alone — it's
a derived `SpendingClassification`, itself computed from `activity_type` +
`subtype` + account type + transfer-linkage, then folded down to a coarser
`CashFlowBucket`.

Call chain inside `ensure_activity_assignment_allowed` (lines 694–713):
1. `resolve_target_accounts` → resolves `account_type` for the activity's account
   (must be opted into spending settings AND `account_supports_purpose(account_type, AccountPurpose::Spending)`).
2. `within_spending_transfer_groups(&transfer_context_acts)` — builds the set of
   transfer `source_group_id`s that have both legs inside the spending account set.
3. `classify_activity_for_aggregation(&activity, account_type, &transfer_groups)`
   (`crates/spending/src/activity_classification.rs:77-95`) — this is the function
   that actually reads `activity.effective_type()` and `activity.subtype`.
4. `cash_flow_bucket_from_classification(...)` collapses the six-way
   `SpendingClassification` down to a four-way `CashFlowBucket`
   (`cash_activities/service.rs:839-850`):
   ```rust
   fn cash_flow_bucket_from_classification(classification: SpendingClassification) -> CashFlowBucket {
       match classification {
           SpendingClassification::Income => CashFlowBucket::Income,
           SpendingClassification::Expense | SpendingClassification::ExpenseRefund => {
               CashFlowBucket::Spending
           }
           SpendingClassification::Saving => CashFlowBucket::Saving,
           SpendingClassification::InternalTransfer | SpendingClassification::Ignored => {
               CashFlowBucket::Neutral
           }
       }
   }
   ```

`classify_activity` (`activity_classification.rs:97-130`), which
`classify_activity_for_aggregation` falls through to for non-transfer
activities, is where `subtype` is actually consulted:

```rust
account_types::CASH => match activity_type {
    "DEPOSIT" | "TRANSFER_IN" | "INTEREST" => SpendingClassification::Income,
    "WITHDRAWAL" | "TRANSFER_OUT" | "FEE" | "TAX" => SpendingClassification::Expense,
    "CREDIT" if activity.subtype.as_deref() == Some("BONUS") => {
        SpendingClassification::Income
    }
    "CREDIT"
        if matches!(
            activity.subtype.as_deref(),
            Some("REFUND") | Some("REBATE") | Some("REIMBURSEMENT")
        ) =>
    {
        SpendingClassification::ExpenseRefund
    }
    "CREDIT" => SpendingClassification::Ignored,
    _ => SpendingClassification::Ignored,
},
account_types::CREDIT_CARD => match activity_type {
    "WITHDRAWAL" | "FEE" | "INTEREST" => SpendingClassification::Expense,
    "CREDIT" => SpendingClassification::ExpenseRefund,   // subtype irrelevant here
    _ => SpendingClassification::Ignored,
},
_ => SpendingClassification::Ignored,
```

So: for a **CASH** account, a bare `CREDIT` (no matching subtype) is
`Ignored` → `CashFlowBucket::Neutral` → no taxonomy is assignable at all
(the "Neutral transfers cannot be categorized" error, despite not being a
transfer — that message is reused for any Neutral-bucket activity). For a
**CREDIT_CARD** account, *every* `CREDIT` is `ExpenseRefund` regardless of
subtype — subtype is irrelevant there.

## 3 / 3b. The category side — the taxonomy id, not a field on the category

`Category` (`crates/core/src/taxonomies/taxonomy_model.rs:61-75`) has **no**
kind/type/income-vs-expense column at all:

```rust
pub struct Category {
    pub id: String,
    pub taxonomy_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub key: String,
    pub color: String,
    pub description: Option<String>,
    pub sort_order: i32,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
    pub icon: Option<String>,
}
```

The income/spending/savings distinction lives **entirely in which
`taxonomy_id` bucket the category belongs to**. Three system taxonomies are
seeded in `crates/storage-sqlite/migrations/2026-05-25-000001_spending_module/up.sql`
(lines 305-336):

```sql
INSERT INTO taxonomies (id, name, color, description, is_system, is_single_select, sort_order, scope)
VALUES
  ('spending_categories', 'Spending Categories', '#B0552E', ...),
  ('income_sources',      'Income Sources',      '#5A7A3E', ...),
  ('savings_categories',  'Savings',              '#6B8E54', ...);
```

**The literal income taxonomy id is `income_sources`** (not
`income_categories` — the error message's word "income categories" is just
prose, generated from `bucket.taxonomy_label()`, and doesn't correspond to
any literal id string).

Seeded category ids per taxonomy (same file):
- `spending_categories`: `cat_housing`, `cat_groceries`, `cat_food`,
  `cat_transport`, `cat_shopping`, `cat_entertainment`, `cat_health`,
  `cat_bills`, `cat_personal`, `cat_education`, `cat_travel`, `cat_gifts`,
  `cat_fees`, `cat_other_expense`, plus many subcategories (lines 322-420).
- `savings_categories`: `cat_savings` + subcategories (lines 335, 424-429).
- `income_sources`: `cat_income_employment`, `cat_income_selfemploy`,
  `cat_income_investment`, `cat_income_other`, plus subcategories including
  **`cat_income_refunds`** and **`cat_income_reimbursements`**
  (lines 436-455) — note these exist under the *income* taxonomy for
  income-classified refund/reimbursement activities (e.g. a CASH `CREDIT`
  with `subtype = "BONUS"`, or an activity a user manually reclassified as
  income). They are a red herring for your Venmo case: they do **not** get
  auto-selected by the `REFUND`/`REBATE`/`REIMBURSEMENT` subtypes — those
  subtypes drive `ExpenseRefund`, which maps to the **spending** bucket, not
  income (see §2 and §4).

`ensure_activity_assignment_allowed` enforces the id string exactly (line
680-688: `taxonomy_id != SPENDING_TAXONOMY && ... != INCOME_TAXONOMY && ... !=
SAVINGS_TAXONOMY`), with constants at `cash_activities/service.rs:38-40`:
```rust
const SPENDING_TAXONOMY: &str = "spending_categories";
const INCOME_TAXONOMY: &str = "income_sources";
const SAVINGS_TAXONOMY: &str = "savings_categories";
```

## 4. The decisive question — YES

**Yes**, a CASH-account `CREDIT` activity whose `subtype` is `REIMBURSEMENT`
(or `REFUND`/`REBATE`) is allowed to carry a `spending_categories` category.

Trace: `classify_activity` → `SpendingClassification::ExpenseRefund` (subtype
matched) → `cash_flow_bucket_from_classification` → `CashFlowBucket::Spending`
(ExpenseRefund is explicitly folded into Spending, `service.rs:842-844`) →
`taxonomy_for_bucket(Spending)` → `Some(SPENDING_TAXONOMY)` ("spending_categories")
→ if the caller's `taxonomy_id` in the PUT body is `"spending_categories"`,
`expected_taxonomy == taxonomy_id` and the check passes.

The validation consults the **derived classification** (which itself reads
`subtype`), not the bare `activity_type` string — confirming subtype is
load-bearing, and confirming the classification (not just the raw type) is
what's authoritative.

Account-type dependency: for a **CREDIT_CARD** account, `subtype` doesn't
even matter — every `CREDIT` is `ExpenseRefund` → Spending bucket
unconditionally (`activity_classification.rs:123-127`). For a **CASH**
account, `subtype` is the deciding factor: `BONUS` → Income bucket (only
`income_sources` accepted); `REFUND`/`REBATE`/`REIMBURSEMENT` → Spending
bucket (only `spending_categories` accepted); anything else (including no
subtype) → Ignored → Neutral bucket (**no taxonomy accepted at all** — the
"Neutral transfers cannot be categorized" 400, reused verbatim for
non-transfer Ignored activities too).

## 5. How an ExpenseRefund's negative amount lands against a category

`crates/spending/src/activity_allocations.rs`, function
`allocations_for_taxonomy` (lines 39-85). It does **not** look at any link to
an "original" expense transaction — it resolves the category from the
**refund activity's own** taxonomy assignment (or split lines), and applies
the (already-signed) bucket amount to that category:

```rust
pub(crate) fn allocations_for_taxonomy(
    activity_id: &str,
    taxonomy_id: &str,
    bucket_amount: Decimal,
    assignments_by_activity: &AssignmentsByActivity,
    splits_by_activity: &SplitsByActivity,
) -> Vec<ActivityAllocation> {
    if bucket_amount == Decimal::ZERO {
        return Vec::new();
    }
    let split_allocations = splits_by_activity.get(activity_id).into_iter().flatten()
        .filter(|split| split.taxonomy_id == taxonomy_id)
        .map(|split| ActivityAllocation {
            category_id: split.category_id.clone(),
            amount: apply_bucket_sign(split.amount, bucket_amount),
        })
        .collect::<Vec<_>>();
    if !split_allocations.is_empty() { return split_allocations; }

    let mut assignments = assignments_by_activity.get(activity_id).into_iter().flatten()
        .filter(|assignment| assignment.taxonomy_id == taxonomy_id)
        .collect::<Vec<_>>();
    assignments.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.id.cmp(&b.id)));

    assignments.first()
        .map(|assignment| vec![ActivityAllocation {
            category_id: assignment.category_id.clone(),
            amount: bucket_amount,
        }])
        .unwrap_or_default()
}
```

Callers pass `bucket_amount = classification.spending_amount(activity_abs_amount(a))`,
which for `ExpenseRefund` is `-amount` (`activity_classification.rs:28-34`). So the
negative value is booked directly against whichever `spending_categories` category
the refund/CREDIT activity **itself** carries (via its own
`activity_taxonomy_assignments` row, or split lines if present — splits win over
a plain single assignment, first-created assignment wins if there are somehow
multiple). There's a dedicated unit test proving exactly this,
`allocation_applies_negative_budget_sign_for_reimbursements`
(`activity_allocations.rs:185-201`).

**Practical implication**: to make a Venmo-payback CREDIT reduce "Groceries",
you must assign the CREDIT activity itself to the `cat_groceries` category
under `spending_categories` — same taxonomy/category id you'd have used for
the original grocery expense. There is no automatic linkage to the original
debit transaction; it's purely "this activity's own category assignment,
with its amount sign flipped by the classification."

## 6. Is `subtype` API-writable, and what values are legal?

Yes. `apps/server/src/api/activities.rs:127-131`:
```rust
async fn update_activity(
    State(state): State<Arc<AppState>>,
    Json(activity): Json<ActivityUpdate>,
) -> ApiResult<Json<Activity>> {
    let updated = state.activity_service.update_activity(activity).await?;
    ...
```
routed at `PUT /activities` (line 444).

`ActivityUpdate.subtype` (`crates/core/src/activities/activities_model.rs:596-601`):
```rust
pub activity_type: String,
#[serde(
    default,
    deserialize_with = "subtype_patch_format::deserialize_patch_subtype"
)]
pub subtype: Option<String>, // Semantic variation (DRIP, STAKING_REWARD, etc.)
```

It is **not a hard enum** — the JSON field accepts any string (or `null`).
On the server side it's normalized by `Activity::canonicalize_subtype`
(same file, lines 378-403): it does a case-insensitive match against ten
known constants (`ACTIVITY_SUBTYPE_DRIP`, `..._DIVIDEND_IN_KIND`,
`..._STAKING_REWARD`, `..._BONUS`, `..._REBATE`, `..._REFUND`,
`..._REIMBURSEMENT`, `..._OPTION_EXPIRY`, `..._POSITION_OPEN`,
`..._POSITION_CLOSE` — values in `crates/core/src/activities/activities_constants.rs:227-267`,
all upper-snake-case strings) — matched values get canonicalized to the
constant's exact casing; anything that doesn't match one of those ten is
passed through **unchanged** (line 402: `subtype` returned verbatim as the
fallback arm). So `"REIMBURSEMENT"` (any case) is legal and canonicalizes
correctly; an arbitrary string like `"Venmo"` would also be accepted and
stored as-is (it just wouldn't match any classification rule, so it would
classify as `Ignored`).

## 7. Other constraints that would block this

From `ensure_activity_assignment_allowed`'s prerequisite,
`ensure_activity_in_spending_scope` (`cash_activities/service.rs:774-808`),
called for every assignment operation:

1. **Spending tracking must be globally enabled** (`SpendingSettings.enabled`),
   else `"Spending tracking is disabled"`.
2. **The activity's account must be in the opted-in account list**
   (`SpendingSettings.account_ids`), else `"Activity account is not opted
   into spending tracking"`.
3. **The account must not be archived, and must be `CASH` or `CREDIT_CARD`**
   — `account_supports_purpose(account_type, AccountPurpose::Spending)`
   returns true only for those two types
   (`crates/core/src/accounts/accounts_constants.rs:56-63`), else
   `"Activity account does not support spending tracking"`.
4. **No linkage requirement to an original expense** — confirmed by §5, this
   does not exist; the refund is a standalone category assignment.
5. **Subtype changes are not reconciled automatically.** `update_activity`
   in `crates/core/src/activities/activities_service.rs` (method starting
   line 3815) never touches `activity_taxonomy_assignments` — no code there
   references "assignment" or "category". This means **order of operations
   matters**: if you `PUT /spending/activities/{id}/assignments` for a CASH
   `CREDIT` activity *before* its `subtype` is set to
   `REFUND`/`REBATE`/`REIMBURSEMENT`, it's still classified `Ignored` →
   Neutral bucket → the assignment call is rejected. You must first `PUT
   /activities` to set `subtype`, *then* assign the `spending_categories`
   category. (Conversely, if you later change `subtype` back off one of
   those three values, or off `BONUS`, any existing assignment record is
   left dangling under a taxonomy_id that no longer matches the freshly
   recomputed bucket — it will just silently stop being picked up by
   `allocations_for_taxonomy`'s live-recomputed bucket_amount, since
   `spending_amount()` returns `Decimal::ZERO` for `Ignored`, short-circuiting
   `allocations_for_taxonomy` at line 46-48 before the stale assignment is
   even read.)
6. The account itself must be resolvable in `resolve_target_accounts`
   (`cash_activities/service.rs:633-664`), which additionally filters
   accounts by `account_supports_purpose(..., AccountPurpose::Spending)` a
   second time — consistent with #3, not an extra hurdle in practice.

## What this means for a caller (no trial-and-error needed)

To make a Venmo-payback `CREDIT` activity on a CASH account reduce a
spending category (e.g. Groceries) via the REST API, in order:

1. Confirm the account is `CASH` or `CREDIT_CARD`, not archived, and is in
   `SpendingSettings.account_ids` (`GET /spending/settings`).
2. `PUT /activities` with `activity_type: "CREDIT"` and
   `subtype: "REIMBURSEMENT"` (or `"REFUND"`/`"REBATE"` — all three behave
   identically) — only needed for CASH accounts; on CREDIT_CARD accounts any
   `CREDIT` already qualifies regardless of subtype.
3. `PUT /spending/activities/{activity_id}/assignments` with
   `{"taxonomyId": "spending_categories", "categoryId": "cat_groceries"}`
   (or whichever spending category should be reduced). This will now
   succeed — `expected_taxonomy` resolves to `spending_categories` because
   the classification is `ExpenseRefund` → `CashFlowBucket::Spending`.
4. Do **not** attempt `taxonomyId: "income_sources"` for this activity — it
   will 400, because `ExpenseRefund` never maps to the Income bucket
   regardless of subtype wording ("Reimbursements" existing as a category
   name under `income_sources` is a naming coincidence for a different use
   case — income-classified reimbursements like employer travel
   reimbursements deposited as `DEPOSIT`/`BONUS`-subtype `CREDIT`s — not
   this one).
5. The refund's amount will land against `cat_groceries` with a negative
   sign in aggregation (reducing that category's total), independent of
   which original transaction it's "paying back" — there is no
   original-transaction link in this system, only the refund's own category
   assignment.
