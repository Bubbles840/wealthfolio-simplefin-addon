# Reimbursement Offset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/recategorize` able to move a payback out of income and into a spending category — by setting the activity's `subtype` to `REIMBURSEMENT` first, so Wealthfolio accepts the spending assignment and counts the credit as an offset — while refusing, with zero writes, every move that still cannot work.

**Architecture:** A pure bucket predicate in `shared/` reproduces Wealthfolio's own account-type × activity-type × subtype → cash-flow-bucket rule, so legality is decided before any write. The controller gains a subtype write (ordered subtype → delete → assign) and a confirmation step for cross-bucket moves. The test double gains the real bucket rule, which is what makes the wrong-premise class of bug impossible to re-ship.

**Tech Stack:** TypeScript (companion NodeNext — `.js` imports), vitest, Wealthfolio REST (`PUT /api/v1/activities`, `PUT|DELETE /api/v1/spending/activities/{id}/assignments`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-11-reimbursement-offset-design.md`. Upstream evidence, with file paths and line numbers, is committed at `docs/upstream-spending-buckets.md` — **read it rather than re-deriving anything about Wealthfolio's rules.** Ships as **v1.14.0**, functionally companion-only.
- Baselines (must never drop): root `npx vitest run` **843**, `cd companion && npx vitest run` **408**.
- **The bucket rule, verbatim from upstream** (`activity_classification.rs:97-130`), is the authority for every predicate in this plan:
  - `CASH` + `DEPOSIT`/`TRANSFER_IN`/`INTEREST` → Income → `income_sources`
  - `CASH` + `WITHDRAWAL`/`TRANSFER_OUT`/`FEE`/`TAX` → Expense → `spending_categories`
  - `CASH` + `CREDIT` subtype `BONUS` → Income → `income_sources`
  - `CASH` + `CREDIT` subtype `REFUND`|`REBATE`|`REIMBURSEMENT` → ExpenseRefund → `spending_categories`
  - `CASH` + `CREDIT` any other/absent subtype → Ignored → **Neutral: no taxonomy assignable at all**
  - `CREDIT_CARD` + `WITHDRAWAL`/`FEE`/`INTEREST` → Expense → `spending_categories`
  - `CREDIT_CARD` + `CREDIT` (any subtype) → ExpenseRefund → `spending_categories`
  - every other account type → Ignored → Neutral
- Literal ids, exact strings: taxonomies `spending_categories`, `income_sources`, `savings_categories`; subtype value `REIMBURSEMENT` (upper case; upstream canonicalizes case-insensitively but send it canonical).
- **Write order is load-bearing and test-pinned: subtype → delete non-spending assignments → assign spending.** `update_activity` never touches assignments upstream, so an assignment attempted before the subtype write still 400s. The reverse of delete/assign would leave a window where a row carries two assignments and is counted twice.
- **Nothing is cleared unless the whole move is possible.** The legality check runs before the first write and refuses with ZERO calls to subtype-write, delete, assign, or republish.
- Every write path stays behind the existing freshness guard (the row must still be present and still carry the category the menu displayed).
- **The dismissal ledger is not involved.** `mergeDismissals`/`pruneDismissals` keep exactly ONE call site each in `companion/src/index.ts`.
- `companion/src/telegram-listener.ts` and everything under `src/**` must end this branch with ZERO diff.
- Menu invariants: `callback_data` emitted from exactly ONE place as `cz:<gen>:<idx>` and ≤ 64 BYTES; `applyTap` rejects a stale generation as `expired` BEFORE resolving the index; session-only data (like `restore`) never enters a token.
- `shared/*.ts` compiles into the addon's browser bundle: no Node imports or Node-only globals, no `fetch`, no filesystem, no `new Date()`/`Date.now()` — `now` is a parameter where needed.
- Frozen strings (never edited): every existing secret key; the stored comment markers `Starting balance · `, `Balance adjustment · `, `↔️ In-transit transfer · `, ` · pending`, `· Amazon: <label> ·`; log tags `duplicate-refused`/`duplicate-prune`; `Dismissed — dropped from future notices`; the import notice's `d:<activityId>` payloads and its `Categorize these` row.
- Import extensions: `shared/` ↔ `companion/src/` use `.js`; `src/**` extensionless. Both correct; never "fix" either.
- The 90-day window (`uncategorizedWindow`) is unchanged — one definition of "recent" across the project.
- **Never `git add -A` / `git add .`** — stage files by name.

## File Structure

- **Create** `shared/cash-flow-bucket.ts` + test — the pure predicate: `bucketFor`, `taxonomyForBucket`, `assignabilityOf`. Its own file because it is a faithful port of an upstream rule and must be readable beside that rule, not buried in menu code.
- **Modify** `companion/src/sqlite-native.ts` + test — `getNativeCategorizedSpending` gains `subtype` and `accountType` (the predicate's inputs).
- **Modify** `companion/src/wealthfolio.ts` + test — `updateActivitySubtype`.
- **Modify** `shared/categorize-menu.ts` + test — the cross-bucket confirmation screen, the refusal screen, `restore` gains the previous subtype.
- **Modify** `companion/src/categorize.ts` + test — legality gate, subtype write, ordering, Undo of both halves; **and the test double gains the real bucket rule**.
- **Modify** `companion/src/index.ts` + test — construct the two new deps.
- **Modify (last task)** `manifest.json`, `package.json`, `shared/version.ts`, `CHANGELOG.md`.

---

### Task 1: The bucket predicate

**Files:**
- Create: `shared/cash-flow-bucket.ts`, `shared/cash-flow-bucket.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export type CashFlowBucket = 'income' | 'spending' | 'saving' | 'neutral';
export const SPENDING_TAXONOMY_ID = 'spending_categories';
export const INCOME_TAXONOMY_ID = 'income_sources';
export const SAVINGS_TAXONOMY_ID = 'savings_categories';
export const REIMBURSEMENT_SUBTYPE = 'REIMBURSEMENT';
/** The three subtypes upstream treats as an expense refund. */
export const REFUND_SUBTYPES: readonly string[];   // ['REFUND','REBATE','REIMBURSEMENT']
export interface BucketInput { accountType: string; activityType: string; subtype?: string | null }
export function bucketFor(input: BucketInput): CashFlowBucket;
/** The one taxonomy a bucket accepts, or null for neutral (nothing assignable). */
export function taxonomyForBucket(bucket: CashFlowBucket): string | null;
/**
 * Can `taxonomyId` be assigned to this activity as it stands, and if not, why?
 * `reason` is a machine token the caller maps to copy — never user-facing text.
 */
export function assignabilityOf(input: BucketInput, taxonomyId: string):
  | { ok: true }
  | { ok: false; reason: 'neutral' | 'wrong-bucket'; bucket: CashFlowBucket; expected: string | null };
```

**Semantics (each a test):** the full matrix in Global Constraints, as a table test — including `CASH`+`CREDIT` with no subtype → `neutral`, `CASH`+`CREDIT`+`BONUS` → `income`, `CASH`+`CREDIT`+each of the three refund subtypes → `spending`, `CREDIT_CARD`+`CREDIT` with a `BONUS` subtype → still `spending` (account type wins there), and an unknown account type (`SECURITIES`) → `neutral`. Case-insensitive on `activityType` and `subtype` (upstream canonicalizes; be liberal on input, and pin `reimbursement` lower-case → `spending`). `assignabilityOf` returns `neutral` when nothing is assignable and `wrong-bucket` with `expected` otherwise.

The file's doc comment must name the upstream source (`crates/spending/src/activity_classification.rs:97-130` via `docs/upstream-spending-buckets.md`) and state that this is a PORT: if upstream changes, this silently disagrees, and the failure mode is a 400 the user sees. That is the honest cost of predicting instead of asking.

- [ ] **Step 1: write the failing table test.** **Step 2:** `npx vitest run shared/cash-flow-bucket.test.ts` → FAIL, module not found. **Step 3:** implement. **Step 4:** that file, then root `npx vitest run`, `npx tsc --noEmit -p .`, `npx tsc --noEmit -p companion`. **Step 5:** commit `git commit -m "Port Wealthfolio's cash-flow bucket rule as a predicate"`.

---

### Task 2: The predicate's inputs and the subtype write

**Files:**
- Modify: `companion/src/sqlite-native.ts`, `companion/src/sqlite-native.test.ts`
- Modify: `companion/src/wealthfolio.ts`, `companion/src/wealthfolio.test.ts`

**Interfaces:**
- Produces:

```ts
// sqlite-native.ts — NativeCategorizedTx gains two fields:
  /** Raw stored subtype, '' when absent. Feeds the bucket predicate. */
  subtype: string;
  /** The account's Wealthfolio type (CASH, CREDIT_CARD, …), '' when unknown. */
  accountType: string;
// wealthfolio.ts — on WealthfolioClient:
async updateActivitySubtype(activityId: string, subtype: string | null): Promise<void>
```

- **The reader:** add `COALESCE(a.subtype,'') AS subtype` and `COALESCE(ac.account_type,'') AS account_type` to `getNativeCategorizedSpending`'s SELECT (the `accounts` table is already LEFT JOINed as `ac`). Alias every column — an unaliased duplicate silently collapses in `node:sqlite`, which this file has shipped twice. Normalize the sqlite3-CLI fallback the way the neighbours do. The fixture's `accounts` table needs an `account_type TEXT` column and `activities` a `subtype TEXT` column; existing INSERTs name their columns, so add the columns and populate them only in new fixtures. **`activityType` is already on this type and currently unused — it stops being dead in Task 3, so leave it.**
- **The client method:** `PUT {base}/api/v1/activities`. The endpoint takes the WHOLE activity, not a patch, so the method must read the activity first and resend it with `subtype` replaced — check whether an existing method returns a full activity (`searchActivities` returns `ActivitySearchItem`); if none does, add the minimal GET the endpoint needs and say so in your report. Follow the file's shape exactly: `...this.authHeaders()`, `throw await this.httpError('updateActivitySubtype', res)` on non-ok. Passing `null` clears the subtype (needed by Undo).
- Tests pin the exact method, path and body for the subtype write (including the `null` case), that a non-2xx throws, and — for the reader — a fixture row carrying a subtype and an account type, plus one with both absent coming back as `''`.

- [ ] Steps: failing tests → RED → implement → `cd companion && npx vitest run`, root suite, both tsc, `cd companion && npm run build` → commit `git commit -m "Read subtype and account type; write an activity's subtype"`.

---

### Task 3: The confirmation and refusal screens

**Files:**
- Modify: `shared/categorize-menu.ts`, `shared/categorize-menu.test.ts`

**Interfaces:**
- Consumes: Task 1's `CashFlowBucket`, `assignabilityOf` shape (import from `'./cash-flow-bucket.js'`).
- Produces (additions only; existing shapes unchanged):

```ts
export type MenuScreen = /* existing members, plus: */
  | { kind: 'confirmCross'; activityId: string; categoryId: string }
  | { kind: 'refused'; activityId: string; reason: 'neutral' | 'wrong-bucket' | 'scope' };
export type MenuAction = /* existing members, plus: */
  | { kind: 'reassignCross'; activityId: string; categoryId: string };
export interface TaxonomyAssignment { /* existing fields, plus: */ }
/** What Undo must put back: assignments AND the subtype the row had before. */
export interface RestoreState { assignments: readonly TaxonomyAssignment[]; subtype: string | null }
```

`MenuScreen`'s `refiled` member's `restore` changes from `readonly TaxonomyAssignment[]` to `RestoreState`. Update its readers accordingly — this is a deliberate shape change, not a new field.

**Semantics (each a test):**
- `confirmCross` renders, with the transaction and target category named:
  `Mark as a reimbursement and file under ⟨toName⟩?` then `Your ⟨toName⟩ spend drops by ⟨money⟩ for that week and month.` then `It stops counting as income.` Buttons `Do it` (yields `reassignCross`) and `« Back`.
- `refused` renders one message per reason, each explaining the constraint without blaming the user and without promising anything: `neutral` — the transaction is not counted as spending or income at all, so no category can be attached to it as it stands; `wrong-bucket` — it is recorded as money in and can only take an income category while that is true; `scope` — its account is not set up for spending tracking. Buttons `« Back` / `Done` only. No screen may paste Wealthfolio's raw API sentence.
- A same-bucket tap still yields `reassign` directly, with no confirmation screen — pin this so the extra step cannot leak onto the ordinary path.
- `refiled` gains one extra line when the move set a subtype: `It now offsets ⟨toName⟩ instead of counting as income.` (the existing generic line stays for same-bucket moves).
- Extend the byte-measured 64-byte cap test to both new screens with long category names.
- Categorize-mode rendering stays byte-identical; every pre-existing test passes unedited.

- [ ] Steps: failing tests → RED → implement → that file, root suite, both tsc → commit `git commit -m "Confirmation and refusal screens for a cross-bucket move"`.

---

### Task 4: The controller — gate, subtype write, ordering, two-part Undo

**Files:**
- Modify: `companion/src/categorize.ts`, `companion/src/categorize.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces:

```ts
// CategorizeDeps additions:
  /** `updateActivitySubtype`. `null` clears it. */
  setSubtype: (activityId: string, subtype: string | null) => Promise<void>;
  /** Accounts opted into spending tracking, or null when it cannot be read. */
  spendingAccountIds: () => Promise<readonly string[] | null>;
```

**Behavior (each a test):**
1. **The gate, before any write.** On a category tap, compute
   `assignabilityOf({accountType, activityType, subtype: willSetReimbursement ? 'REIMBURSEMENT' : subtype}, SPENDING_TAXONOMY_ID)`, where `willSetReimbursement` is true only when the row is a `CREDIT` whose current bucket is not already `spending`. If not ok → render `refused` with the mapped reason and perform **zero** writes (assert `setSubtype`, `unassignTaxonomy`, `assign`, `republish` all uncalled).
2. **Scope check.** When `spendingAccountIds()` returns a list not containing the row's account, refuse with reason `scope`, zero writes. When it returns `null` (unreadable), proceed — refusing on an unreadable signal would block a working move on a missing answer.
3. **Cross-bucket taps go through the confirmation screen** (`confirmCross`), and only `reassignCross` writes. A `reassign` action on a cross-bucket row must NOT write — pin it, so a stale token cannot skip the confirmation.
4. **Ordering, pinned as a whole sequence:** `setSubtype` → each `unassignTaxonomy` → `assign`. Assert the full order log including taxonomy tags. A same-bucket move performs NO `setSubtype`.
5. **Each failure point, asserted for what it leaves and what it says:** subtype write throws → nothing else attempted, row untouched, message says the transaction was not changed; a delete throws → subtype already changed, old assignment still present, message says the category was not moved and offers Undo; assign throws → row uncategorized and subtype changed, message says both plainly and offers Undo.
6. **`CREDIT_CARD` rows skip the subtype write** and still assign (upstream classifies every card credit as a refund already).
7. **Undo restores both halves.** `restore` now carries `subtype`; Undo replays assignments AND calls `setSubtype` with the previous value (including `null`). If either half no longer matches what the menu set, decline with a message and write nothing — extend the existing verified-restore guard to cover subtype.
8. **The test double gains Wealthfolio's real rule.** Its `assign` must reject when the target taxonomy does not match the bucket derived from the row's CURRENT account type / activity type / subtype, and its `setSubtype` must mutate that subtype so a later `assign` legitimately succeeds. **Prove the double is honest:** point the pre-existing cross-taxonomy fixtures at it with the subtype step removed and watch them fail. Include that RED output in your report — it is the evidence that the wrong-premise bug can no longer be re-shipped.
9. The 16 pre-existing tests in `reassign — the cross-taxonomy move` and `undoing a reassignment` that assert the old always-succeeds behavior are **rewritten** to the confirm-then-subtype-then-assign flow. This is the plan's one sanctioned bulk test edit. Do not delete a case — every scenario keeps a test, asserting what now happens. Report each rewritten test by name and what changed about its expectation.

- [ ] Steps: failing tests → RED (report both the ordinary RED and the double-honesty RED from item 8) → implement → companion suite, root suite, both tsc, `cd companion && npm run build` → commit `git commit -m "Set the subtype so a payback can offset a spending category"`.

---

### Task 5: Wiring, version, changelog

**Files:**
- Modify: `companion/src/index.ts`, `companion/src/index.test.ts`
- Modify: `manifest.json`, `package.json`, `shared/version.ts`, `CHANGELOG.md`

**Wiring:** construct the two new deps in `buildCategorizeDeps` — `setSubtype: (id, st) => wfClient.updateActivitySubtype(id, st)` and `spendingAccountIds` reading Wealthfolio's spending settings (`GET /api/v1/spending/settings` per `docs/upstream-spending-buckets.md` §7; add the client method here if Task 2 did not, and guard it to return `null` on any failure rather than throwing).

- [ ] Bump all three version carriers `1.13.0`→`1.14.0` (verified current values: `manifest.json:4`, `package.json:3`, `shared/version.ts:19`); `shared/version.test.ts` pins them together.
- [ ] CHANGELOG between `## [Unreleased]` and the previous entry, dated 2026-08-11, matching the surrounding entries' voice:

```markdown
## [1.14.0] - 2026-08-11

### Fixed

- **Moving a payback out of income now works, instead of clearing its
  category and failing.** v1.13.0 assumed a category could move a
  transaction between "money in" and "money out". Wealthfolio does not work
  that way — a category labels which bucket a transaction is in, and what
  decides the bucket is the transaction's subtype. So a Venmo payback filed
  as income was un-filed and then rejected. `/recategorize` now sets the
  subtype to REIMBURSEMENT first, which is what makes the spending category
  legal and makes the amount count against that category instead of as
  income. Moves that still cannot work are refused up front with the reason,
  and nothing is cleared unless the whole move can complete.
- **Undo puts the subtype back too**, not just the category, and declines
  rather than half-reverting if either has changed since.

### Added

- A confirmation step before a cross-bucket move, because marking something a
  reimbursement changes how Wealthfolio counts it everywhere — not only in
  this addon. It names the category and the amount its spend will drop by.

Needs the companion rebuild; the addon zip changes only its version string.
```

- [ ] Full verification: root vitest, companion vitest, both `tsc --noEmit`, `npm run build`, `npm run package` (zip must be `dist/simplefin-sync-1.14.0.zip`), `cd companion && npm run build`.
- [ ] Commit `git commit -m "Wire the subtype write and bump to 1.14.0"`.

(Release — push, tag, GitHub release, store-listing bump — follows the established flow after live testing.)

## Plan Self-Review (performed)

- **Spec coverage:** subtype-first two writes (T2 client, T4 ordering), pre-flight legality with zero writes (T1 predicate, T4 gate), explicit confirmation naming category and amount (T3, T4 routing), Undo of both halves incl. decline (T3 `RestoreState`, T4 item 7), test double gaining the real rule with proof (T4 item 8), the 16 tests rewritten not deleted (T4 item 9), honest refusals per reason incl. scope (T3, T4 items 1-2), CREDIT_CARD skip (T4 item 6), failure ordering consequences (T4 item 5), 90-day window untouched (Global Constraints), version/changelog (T5). Gaps: none found.
- **Placeholder scan:** clean. Two deliberate CHECK instructions (whether a full-activity GET already exists; the current version numbers) both state what to do either way.
- **Type consistency:** `CashFlowBucket`/`assignabilityOf`/`SPENDING_TAXONOMY_ID`/`REIMBURSEMENT_SUBTYPE` (T1) consumed by name in T3/T4; `subtype`/`accountType` on `NativeCategorizedTx` (T2) read by T4's gate; `updateActivitySubtype` (T2) bound to `setSubtype` (T4 deps) in T5; `RestoreState` (T3) consumed by T4 item 7; `confirmCross`/`refused`/`reassignCross` named identically in T3 and T4. Note `SPENDING_TAXONOMY_ID` already exists in `companion/src/categorize.ts` — T1 introduces the canonical one in `shared/`; T4 must import from there and delete the local duplicate rather than keeping two.
