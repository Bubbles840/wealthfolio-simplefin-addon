# Reimbursement rules: fixing paybacks at the import, not per row

Date: 2026-08-11. Redirects the abandoned per-row design in
`2026-08-11-reimbursement-offset-design.md` (see "What this replaces"). Approved
by Nick. Ships as v1.14.0.

## The goal, unchanged

Nick's Venmo/Zelle paybacks are friends repaying him for dinner or a movie. He
does not want them counted as income; he wants them to reduce that category's
spending. Today they import as `DEPOSIT` and sit under `income_sources:
Reimbursements`.

## Why the previous design cannot work — three verified facts

1. **`CASH` + `DEPOSIT` is Income unconditionally.** Wealthfolio reads an
   activity's `subtype` ONLY on its `CREDIT` branch
   (`crates/spending/src/activity_classification.rs:97-130`, quoted in
   `docs/upstream-spending-buckets.md` §2). Marking a DEPOSIT
   `REIMBURSEMENT` changes nothing, so the per-row menu write would have
   refused all nine of Nick's rows.
2. **A category cannot move a transaction between buckets.** The acceptance
   check compares the assignment's taxonomy against the bucket derived from
   type + subtype + account type, and rejects a mismatch — the 400 Nick saw in
   production, after the old category had already been cleared.
3. **Flipping a stored row's type per-row is unstable.** `changed()`
   (`shared/reconcile.ts:78-90`) compares `row.type !== tx.type` and updates in
   place, and the mapper resolves a positive cash amount to `DEPOSIT`. So a row
   flipped to `CREDIT` would be reverted by the next sync, silently, leaving its
   spending assignment dangling.

## The redirect: change what the IMPORTER resolves

Fact 3 inverts into the fix. If a **mapping rule** resolves those descriptions
as `CREDIT` + subtype `REIMBURSEMENT`, then:

- future paybacks import correctly and permanently;
- the nine existing rows are **updated in place by the next sync**, because
  their resolved type now differs from what is stored — history backfills
  itself, with no per-row tapping and no new write path;
- nothing fights, because the mapper and the stored rows finally agree.

Mapping rules already exist (`shared/types.ts:6-10`:
`{pattern, matchType, activityType}`), already win over every default
(`shared/mapper.ts:47`, `fromRule: true`), and already have an addon editor.
They gain one optional field.

## Decisions

1. **`MappingRule` gains `subtype?: string`.** Applied only when the rule
   matches, only alongside its `activityType`. Absent on every existing rule,
   so stored rules keep working untouched.
2. **`MappedType` gains `subtype?: string`**, carried through
   `mapTransactionWithSource` into the created/updated activity. `mapTransaction`
   (the type-only helper) keeps its signature.
3. **The subtype participates in change detection.** `changed()` must compare
   subtype too, otherwise adding a subtype to an existing rule would never
   reach rows already imported — the backfill in the paragraph above depends on
   this. This is the one edit to reconciliation.
4. **The addon's Transaction Rules editor gains a subtype input**, offered only
   for the activity types where Wealthfolio reads one, with the refund values
   named plainly (`REFUND`, `REBATE`, `REIMBURSEMENT`) and a short line saying
   what marking a credit as a reimbursement does to spending totals.
5. **Credit-card refunds need nothing.** Nick treats them as generic
   reimbursements and deliberately does not file them against a category. On a
   card, every `CREDIT` is already an expense refund; with no spending category
   assigned it is simply not counted anywhere, which is the behaviour he wants.
   No rule, no category, no change.
6. **The per-row menu keeps only its GATE.** `/recategorize`'s cross-bucket
   move stays refused-by-prediction using the Task-1 predicate, with honest
   copy. Once a row is `CREDIT` + `REIMBURSEMENT` its bucket is Spending, so
   filing it under Food & Dining is an ordinary, legal spending assignment that
   the existing clear-and-assign path already performs.
7. **The menu does NOT write subtypes.** `updateActivitySubtype` (built in the
   abandoned plan's Task 2) becomes unused and is **deleted** with its tests —
   an unused write against real financial data is a liability, and rules are now
   the single way a subtype is set.

## The flow Nick follows once

```
Addon → Advanced → Transaction Rules → add
  pattern: Venmo Transfers     matchType: contains
  type: CREDIT                 subtype: REIMBURSEMENT
next sync (or /sync)
  → the 9 stored rows update in place: DEPOSIT → CREDIT + REIMBURSEMENT
  → each stops counting as income; its dangling income assignment stops matching
/recategorize venmo
  → file each under the category it actually offsets (Food & Dining, …)
```

## Known consequences, stated rather than discovered later

- After the type change, each row's existing `income_sources: Reimbursements`
  assignment no longer matches its bucket, so the row counts in NEITHER income
  nor spending until a spending category is assigned. That is strictly better
  than counting as false income, and `/recategorize` finishes the job.
- A rule is description-matched, so a Venmo transfer that is genuinely income
  (someone paying Nick for work) would also be marked a reimbursement. The
  editor's copy must say so; the fix is a narrower pattern.
- Adding a subtype to an existing rule rewrites matching rows on the next sync
  (by decision 3). That is the intended backfill, and it is the reason the
  editor's copy has to say what the rule will do to history, not just to future
  imports.
- Nothing here can produce the previous design's failure: no category is ever
  cleared in anticipation of a write that might be refused.

## Non-goals

- No per-row subtype editing from Telegram (decision 7).
- No automatic guess at which spending category a payback offsets — Nick
  chooses, per row, because dinner and a movie are different categories.
- No change to credit-card handling (decision 5).
- No retroactive rewrite of rows a rule does not match.

## Testing

- Mapper: a rule with a subtype yields it alongside its type; a rule without one
  yields no subtype; a non-matching rule leaves both defaults; regex and
  contains both carry it; `mapTransaction`'s signature unchanged.
- Reconcile: a stored row whose subtype differs from the feed's is updated in
  place; identical subtype is not; `undefined` vs absent are treated the same so
  existing rows do not churn on every sync (this is the regression risk of
  decision 3 and needs an explicit test).
- Sync-core: the subtype reaches the created activity and the updated one.
- Addon: the editor round-trips a subtype, offers it only for the types that
  read one, and an existing rule without a subtype is unaffected.
- Deletion: `updateActivitySubtype` and its tests are gone, and nothing
  references it.

## Ship

v1.14.0. Both halves change (`shared/` plus the addon's rule editor), so it is
a companion rebuild AND a zip reinstall.

## What this replaces

`docs/superpowers/specs/2026-08-11-reimbursement-offset-design.md` and its plan
are abandoned mid-execution. Kept from that branch: the bucket predicate
(`shared/cash-flow-bucket.ts`), the reader's `subtype`/`accountType` fields, and
the menu's refusal screens. Discarded: the per-row subtype write and the
cross-bucket confirmation screen it fronted.
