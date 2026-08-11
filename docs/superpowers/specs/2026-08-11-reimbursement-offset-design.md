# Making a payback offset the right category

Date: 2026-08-11. Approved by Nick (option C). Ships as v1.14.0,
companion-only. Supersedes the cross-taxonomy half of v1.13.0's
`/recategorize`.

## Why, and what v1.13.0 got wrong

`/recategorize` was built on the assumption that putting a spending category on
a credit makes that credit offset the category. Wealthfolio refuses it:

```
400 Invalid input: Income activities can only use income categories.
    Categories label the cash-flow bucket; they do not change it.
```

Because the assignment ran second, the income category had already been
deleted — so a real Venmo payback was left uncategorized (the deliberate
failure shape, but on a move that could never have succeeded). The premise was
never verified against upstream source before shipping.

Worse than the bug: **16 tests asserted that cross-taxonomy moves succeed**,
passing only because the test double accepted what the real API rejects. They
encoded the wrong premise instead of catching it.

## What actually governs this (verified in upstream source, 2026-08-11)

Every activity folds to a `CashFlowBucket`, and an assignment is accepted only
when its taxonomy matches that bucket
(`crates/spending/src/cash_activities/service.rs:674-732`):

```rust
if expected_taxonomy != taxonomy_id { reject }
```

The bucket comes from a derived classification that reads activity type,
**subtype**, and account type (`activity_classification.rs:97-130`):

| Account | Activity | Bucket | Assignable taxonomy |
|---|---|---|---|
| CASH | `CREDIT` subtype `REFUND`/`REBATE`/`REIMBURSEMENT` | **Spending** | `spending_categories` |
| CASH | `CREDIT` subtype `BONUS` | Income | `income_sources` |
| CASH | `CREDIT` no/other subtype | Neutral | **none at all** |
| CASH | `DEPOSIT`/`TRANSFER_IN`/`INTEREST` | Income | `income_sources` |
| CREDIT_CARD | `CREDIT` (any subtype) | **Spending** | `spending_categories` |

And an expense refund's amount is applied **negatively** against the category
the refund activity itself carries (`activity_allocations.rs:39-85`, with an
upstream test named `allocation_applies_negative_budget_sign_for_reimbursements`).
There is no link to an "original" expense — the refund's own assignment is the
whole mechanism.

So the feature Nick asked for is real, and the lever is `subtype`, which is
writable via `PUT /activities` (`ActivityUpdate.subtype`, canonicalized
case-insensitively against ten known constants).

**Order is load-bearing:** `update_activity` never touches assignments, so the
subtype must be set BEFORE the category assignment or the assignment still 400s.

## Decisions

1. **Two writes, subtype first.** For a CASH-account credit heading to a
   spending category: `PUT /activities` with `subtype: "REIMBURSEMENT"`, then
   `PUT …/assignments` with `spending_categories`. On a CREDIT_CARD account the
   subtype write is skipped — every credit there already qualifies.
2. **Nothing is cleared until the move is known to be possible.** The v1.13.0
   ordering (delete non-spending assignments, then assign) stays, but a
   pre-flight check runs first and refuses impossible moves with **zero**
   writes. Predicate: derive the post-change bucket the same way Wealthfolio
   does, from account type + activity type + the subtype we are about to set.
   If the target taxonomy would not match, refuse and explain.
3. **The user is told what the move does, in plain terms, before it happens.**
   A cross-bucket move now changes more than a label: it marks the transaction
   as a reimbursement and makes it reduce a category. The confirmation step
   says so — `Mark as a reimbursement and file under Food & Dining?` — with
   the consequence spelled out (`your Food & Dining spend drops by $24 for that
   week and month`).
4. **Undo restores both halves.** It replays every cleared assignment AND
   restores the previous `subtype` (including back to absent). The v1.13.0 Undo
   already replays assignments; subtype joins the same restore payload. If
   either half cannot be restored, Undo declines rather than half-reverting.
5. **The 16 wrong tests are rewritten to the behavior that genuinely works** —
   not deleted. Their fixtures gain the subtype step, and the test double gains
   Wealthfolio's real bucket rule so it can no longer accept an illegal
   assignment. That is the durable fix for how this bug survived review.
6. **Refuse honestly where even this cannot work.** A CASH credit that must
   stay income (`BONUS` subtype), a Neutral-bucket row, an account not opted
   into spending tracking, an archived account, or a non-CASH/CREDIT_CARD
   account: refuse with the specific reason. `/categorize` remains the way to
   put a category back on anything left bare.

## The flow

```
/recategorize venmo
  ─ "Aug 9 · VENMO PAYMENT · $24.00 · Reimbursements"
tap it
  ─ current category + spending-category picker
tap "Food & Dining"
  ─ CROSS-BUCKET, so a confirmation step first:
    "Mark as a reimbursement and file under Food & Dining?
     Your Food & Dining spend drops by $24 for that week and month.
     It stops counting as income."      [ Do it ]  [ « Back ]
tap "Do it"
  ─ PUT /activities  subtype=REIMBURSEMENT
  ─ delete income_sources assignment
  ─ PUT assignments   spending_categories / cat_food
  ─ "VENMO PAYMENT: Reimbursements → Food & Dining (now offsets it)"
    [ Undo ] [ Next transaction ] [ Done ]
```

A same-bucket move (spending → spending) keeps v1.13.0's single-tap behavior
with no extra confirmation — nothing about the transaction's meaning changes.

## Failure ordering, stated deliberately

Three writes can each fail. The order is chosen so no failure leaves a
double-count:

1. **subtype write fails** → nothing else attempted. Row unchanged, still
   correctly categorized. Report it.
2. **delete fails** → subtype is already changed but no category moved. The row
   keeps its old assignment, which is now under a taxonomy that no longer
   matches its bucket — upstream simply stops counting it (`spending_amount`
   returns zero for a mismatch, short-circuiting before the stale assignment is
   read), so it is invisible in reports rather than wrong. Report it and offer
   Undo, which restores the subtype.
3. **assign fails** → row is uncategorized (visible in `/categorize`), subtype
   changed. Report both facts plainly and offer Undo.

Never the reverse order: assigning before clearing would leave a window where
the row carries two assignments and is counted twice.

## Known consequences

- A reimbursement reduces the category it is filed under, regardless of which
  purchase it repays — there is no original-transaction link in Wealthfolio.
  Filing a dinner payback under Food & Dining is therefore correct; filing it
  under Groceries would silently reduce the wrong budget.
- Changing subtype changes how the transaction is counted everywhere in
  Wealthfolio, not just in this addon's reports. That is why decision 3 makes
  the confirmation explicit.
- `income_sources` contains categories literally named "Reimbursements" and
  "Refunds". They are for genuinely-income reimbursements (an employer
  repaying travel as a DEPOSIT) and are NOT what these subtypes select. Naming
  coincidence; recorded so nobody re-conflates them.
- Nick's Venmo row and any others stripped by v1.13.0 need a category put back
  via `/categorize` before this can move them.

## Non-goals

- No bulk "mark every Venmo payback as a reimbursement" — one tap per row, as
  with everything else that writes category data.
- No new command. This is `/recategorize` doing what it always claimed.
- No income-category picker, no splits (upstream supports splits; the menu does
  not).
- No attempt to link a refund to the purchase it repays. Wealthfolio has no
  such concept.

## Testing

- Bucket predicate: a table test over account type × activity type × subtype
  reproducing the upstream matrix above, including the Neutral case where no
  taxonomy is assignable.
- **The test double gains the real rule** — it must reject an assignment whose
  taxonomy mismatches the row's derived bucket. Prove it by pointing the
  v1.13.0-era cross-taxonomy fixtures at it and watching them fail before the
  subtype step is added.
- Ordering: subtype→delete→assign pinned as a whole-sequence assertion; each of
  the three failure points asserted for what it leaves behind and what it says.
- Undo: restores assignments AND subtype (including to absent); declines when
  either half no longer matches what the menu set.
- Refusals: each reason in decision 6 produces its own message and zero writes.
- CREDIT_CARD path: no subtype write attempted, assignment succeeds.
- Same-bucket move: unchanged from v1.13.0, no confirmation step, no subtype
  write.

## Ship

v1.14.0, companion-only: rsync + docker build + one-service restart. The addon
zip changes only its version string. v1.13.0's `/recategorize` stays installed
meanwhile; its cross-bucket path fails safely (clears, then reports) until this
ships.
