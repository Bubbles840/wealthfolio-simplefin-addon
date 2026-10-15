# Paybacks in the app (1.62.0, W11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deposit on Home's needs-a-category list, or in its story, gets **It's a payback…** — pick the spending it pays back, and the app files it as a payback, as Telegram's `/categorize` does — on Wealthfolio 3.9 and newer with a companion of 1.62.0 or newer; and, last, the integration review's five minor fixes and the release version, 1.62.0.

**Architecture:** Pure shared modules decide; the add-on lends its SDK calls. `shared/payback-app.ts` holds the one-off filing rule (its key, its name, the keys a sweep rebuilds), the gate, the category list and the story's offer. `shared/payback-app-file.ts` is `filePaybackInApp`, the add-on's sibling of the companion's reviewed `filePayback` (which stays untouched): gate → re-read and `planPayback`, then Wealthfolio's facts → sweep left-behind one-off rules, save this row's → the `asReimbursement` override → the re-type → `rerunRules(true)` → read the filing back → delete the rule → a strict `payback-filed` entry. `src/utils/app-payback.ts` lends the SDK (and the write lock); `src/components/PaybackAction.tsx` is the button and picker, under a list row and on a story; `SyncPage` holds the optimistic removal. The companion marks the rows the list may offer it on (`paybackEligible`), and `resolveFiler` tells a payback as yours. Task 7 folds in the integration review's fixes and bumps to 1.62.0.

**Tech Stack:** TypeScript, React (add-on), vitest (root project: jsdom, `src/` + `shared/`; companion project: node, `companion/src/`), add-on SDK 3.9.0 on Wealthfolio 3.8–3.10 (`spending.getCategories`, `getRules`, `saveRule`, `deleteRule`, `rerunRules`; `spending.searchCashActivities` behind `hostCan`), Wealthfolio REST (companion).

**Spec:** `docs/superpowers/specs/2026-10-14-line-up-and-paybacks-design.md` — ruling W11 (approved by Nick, 2026-10-14), with the controller's W11 rulings of 2026-10-14 (quoted below where they bind) and the integration review of `release/1.62.0` at 8505228 (Task 7). It consumes W6–W10's fixed interface (`asReimbursement`, `payback-filed`/`paybackFiledChange`, `PAYBACK_SINCE`/`companionUnderstandsPaybacks`, `planPayback`, `paybackRetype`) and U1/U3's `hostCan` and `readCashFacts`.

**Target tree:** the worktree `/Users/nawrig04/Personal Projects/wf-release`, branch `release/1.62.0` at 8505228 (feat/line-up, feat/platform and feat/paybacks merged). Every block below was applied, task by task, to a clone of that commit, and every RED and GREEN count was read off that replay. Run every command from the worktree root (`cd "/Users/nawrig04/Personal Projects/wf-release" && …`).

**The rulings this plan follows (controller, 2026-10-14):**
1. **The one-off rule is saved BEFORE the re-type**, in this order: gate; re-read the row and plan (`planPayback`); save the one-off rule (CREDIT only, the exact note, this account, priority 1,000,000, key `payback-once:<accountId>:<txId>`); write the override (corrupt-aware, re-read first); re-type the row (`paybackRetype`: the stored instant, a bare day at noon UTC); `rerunRules(true)`; confirm the filing by reading the row's facts back (`searchCashActivities`); delete the one-off rule; log `payback-filed` with the CONFIRMED category through a strict append. Every failure state gets honest words, modelled on `filePayback`. A rule left behind is named; the next app payback sweeps leftovers by key, from `getRules`, rebuilding the key.
2. **No companion → the action is hidden** (nothing could undo it). It needs a companion of 1.62.0 or newer (`companionUnderstandsPaybacks` with a non-null version); a 1.61 companion gets nothing.
3. **The companion publishes `paybackEligible: true`** on each needs-a-category row that is a posted DEPOSIT on a cash account (Telegram's switch's predicate); the list offers the action only there.
4. **A sibling runner** for the add-on reuses the pure pieces (`planPayback`, `paybackRetype`, the copy, the fingerprint); `filePayback` is not generalized or touched.
5. **A row already filed** in any taxonomy is refused: "It's filed under <X> already — take that off in Wealthfolio first."
6. **`resolveFiler`** recognizes a `payback-filed` entry for the row: "you, as a payback" — as `{ kind: 'you', at }` (integration review, Minor 2), and a payback's money line reads "A payback: it lowers your spending."
7. **Copy** (exact, no emoji): the button "It's a payback…"; the picker's line is `PAYBACK_PICK`; the one-off rule "Payback (one-off) — <bank words>"; the filed reply `paybackDone(…)` then "Undo it from Telegram: /changes."; the leftover and filed-first lines below. All in `shared/payback-copy.ts`.
8. **The row leaves the needs-a-category list at once**, as a dismissal does.
- Also: the manifest's `spending` gains `getRules`, `saveRule`, `deleteRule`, `rerunRules` (1.62.0 is an Install-from-File release already); the action is gated on `hostCan(ctx, 'spending.searchCashActivities')` (3.9+: the rule calls exist on 3.8 too, the confirming read does not).

**Verified facts this plan builds on (Q1):**
- **(a) The SDK's rule calls** (packages/addon-sdk/src/host-api.ts:515-544, data-types.ts:600-664 at v3.9.0): `getRules()` lists only this add-on's rules and never their `ruleKey`; `saveRule(input)` upserts by `ruleKey`; `deleteRule(key)` is a no-op when absent; `rerunRules(onlyUncategorized = true)` returns the count of rows any rule MATCHED (skipped ones included), so it proves nothing — the filing is read back. `CategorizationRuleInput` takes `matchType` (`exact` upper-cases both sides), `kind: 'expense'`, `activityType`, `accountId`, `priority`; it cannot set an amount or `isGlobal`. `spending.getCategories(kind?)` returns `{ kind, taxonomyId, categoryId, key, name, path }`, `path` joined with " / " (upstream adapters/shared/spending.ts `buildCategoryPath`, v3.9.0). 3.8 offers every rule call too, so only `hostCan`'s cash-search probe tells 3.8 from 3.9 (src/utils/host-can.ts).
- **(b) What the rule run does** (crates/spending categorization_rules, v3.10.0): a rule scoped to another account is skipped; `activity_type` must equal the row's EFFECTIVE type; the highest priority wins, the oldest on a tie (matcher.rs:67-131); `rerun_all` loads every Spending-account activity and fills only an empty slot in the rule's taxonomy, recording `source: rule` (service.rs:162-247); it runs with no bucket check, which is why the one-off rule is CREDIT-only. Wealthfolio already reruns after every rule save and every activity write (spending.rs `spawn_auto_categorize`), so a re-type sets off a background run: the race the order in ruling 1 closes (W10's own Wealthfolio rule is CREDIT-only, account-scoped, priority 50: shared/payback.ts:350, :659 on this tree).
- **(c) The release tree:** `filePayback` is shared/payback.ts:219-346; its fingerprint is module-private, so the sibling builds the same one from `removalFingerprint` (shared/tx-remove.ts). `readCashFacts` (src/utils/wf-facts.ts:20-45) returns null both when the host cannot and when a read fails; after the gate, null means a failed read. The add-on's store had no strict change-log append (`recordChange` never rejects, src/utils/secrets.ts:212-215); `appendStrict` exists on the writer (shared/change-log.ts:240-242, :304-308), so Task 3 adds `recordChangeStrict`. The companion already reads `activityType` and `pending` for every needs-a-category row (`NativeUncategorizedTx`, companion/src/sqlite-native.ts:575-601) and dropped them on publish (companion/src/uncategorized-status.ts:81-97). The manifest's `spending` declared only `getCategories` (manifest.json:67-73). The story already returns a fingerprinted `removal` offer (src/utils/tx-story.ts:278-281); `useTxStoryActions` is built at src/pages/SyncPage.tsx:111. Telegram's own payback switch is `incomeEligible && activityType === 'DEPOSIT' && !pending` (shared/categorize-menu.ts:656-665).
- **(d) Undo:** `payback-filed` is companion-only (shared/change-undo.ts:40-42); the app shows "Undo this from Telegram: /changes" with a companion of 1.62.0+. Telegram's Undo merges both writers' buckets and un-files only when the current spending filing equals the entry's `after.categoryId` (change-undo.ts:773-816) — hence the CONFIRMED category, null when none.

**Deviations from the spec and the rulings (decided, do not "fix"):**
- **The sweep runs right before the one-off rule is saved** (after the plan passed), so a refusal writes nothing at all. A one-off rule is recognised by what it keeps — priority 1,000,000, CREDIT, an account, a tx id in its pattern — not by its name, so one renamed in Wealthfolio is still swept.
- **The story offers it only on Wealthfolio's own word that the row is filed nowhere** (a 3.9 fact), not from the needs-a-category list's flag: the filing needs that fact anyway.
- **The filer is `{ kind: 'you', at, payback: true }`** — `kind: 'you'` as the integration review asked, plus a flag, because `kind: 'you'` alone says "in Telegram". It is `resolveFiler`'s, so Telegram's `/why` says it too: a payback filed from `/categorize` used to read "set by hand". The report cube never sees `payback-filed` entries (companion/src/report-cube-build.ts filters its history), so its codes are unchanged.
- **The picker lists spending categories only, by path, without the add-on's own "Opening balances" and "Sync bookkeeping"** — a payback filed there would come off nothing.
- **A one-off rule is named for its tx id when the bank gave no words.** A refusal of the rule's save also deletes it (its answer can be lost after it landed) and names it only when that delete fails.
- **When another rule filed it first, the reply is `filed`** (it is a payback under a category: it leaves the list) and the entry logs THAT category, so Telegram's Undo un-files it.
- **"Couldn't tell" is a result of its own** (`paybackAppUnsure`): the read-back failed, or Wealthfolio no longer lists the row; it is logged with no category.
- **The write lock**: a payback refuses while a sync or another fix runs, with Remove for good's words (`writeRefusal('remove')`).
- **Copy the rulings did not spell out** is fixed in Global Constraints (File it, Cancel, the picker's names, the update-the-companion and not-in-Spending refusals, the app's stuck/unsure/unfiled lines).
- **No new CSS:** the action reuses `.sfin-why-remove` and `.sfin-audit-fix`, as Remove for good does.
- **Integration fixes (Task 7):** Link refuses a payback by the setting OR by its type (a cash CREDIT marked REIMBURSEMENT — W10's transaction rule types one with no setting); Health's finder skips only rows the setting is on (ledger rows carry no subtype), reading the overrides in `gatherHealthFacts`. W10's strict log covers the Done reply only (its "stuck" reply is a follow-up). The refused-id cap lives once, in `bookkeepingChange`, for both passes, with `refusedCount` beside every non-empty list. The release guard also pins `PAYBACK_SINCE`, unconditionally. The CHANGELOG keeps an empty `## [Unreleased]` above `## [1.62.0] - 2026-10-15`, as v1.61.0 did (71435fb).

**Task order:** the decisions and the words (1); the runner (2); the add-on's half — manifest, strict log, SDK adapter (3); the companion's flag and the stories (4); the UI and the optimistic removal (5); docs and the forced-date run (6); the integration fixes and the version, LAST (7). Tasks 1–6 run on 1.61.0, as verified.

## Global Constraints

- **Gates (W11):** the action exists only when `hostCan(ctx, 'spending.searchCashActivities')` is true AND the companion's published version is non-null and at least `PAYBACK_SINCE` (`'1.62.0'`). Otherwise it is hidden; a click that reaches the runner anyway is refused ("Paybacks aren't available here — nothing was changed." / "Update the companion to 1.62.0 or newer first — …"). `minWealthfolioVersion` stays `3.8.0`. The list offers it only on rows carrying `paybackEligible: true`.
- **The one-off rule, exactly:** `{ ruleKey: 'payback-once:<accountId>:<txId>', name: 'Payback (one-off) — <bank words>', pattern: <the row's note as re-read>, matchType: 'exact', kind: 'expense', categoryId, activityType: 'CREDIT', accountId, priority: 1_000_000 }`. Saved before the re-type, deleted after the read-back whatever it found. `rerunRules(true)` only — never `false` (it would overwrite rule, AI and import filings on every Spending account).
- **The companion's `filePayback`, `makePaybackRules`' order, and the change-undo planner are not changed** (Task 7 changes only how W10 logs).
- **Copy (verbatim; constants in `shared/payback-copy.ts`):** `It's a payback…` · `File it` · `Cancel` · `Spending category` (the picker's name) · `Choose a category` · `Loading categories…` · `Couldn't read your spending categories — try again.` · `Pick the spending it pays you back for.` (`PAYBACK_PICK`) · `Filed as a payback under <category> — it takes <$amount> off your <parent or category> spending.` (`paybackDone`) then `Undo it from Telegram: /changes.` · `Payback (one-off) — <bank words>` · `A one-off rule named "<name>" is still in Wealthfolio's rules; delete it there if it stays.` · `Wealthfolio filed it under <category> first — it's a payback there; move it in Wealthfolio if that's wrong.` · `It's filed under <category> already — take that off in Wealthfolio first.` · `Update the companion to 1.62.0 or newer first — an older one turns a payback back into a deposit on its next sync. Nothing was changed.` · `Couldn't check the companion's version — nothing was changed. Try again.` · `Wealthfolio's Spending doesn't track this account, so it can't take a payback — nothing was changed.` · `Wealthfolio didn't take the filing rule — nothing was changed.` · `Wealthfolio didn't take the change, so it's still a deposit — but the payback setting couldn't be taken back, so the next sync makes it a payback with no category.` · `Couldn't tell whether Wealthfolio took the change. The payback setting stays, so the next sync makes it a payback; if it has no category then, pick one in Wealthfolio.` · `To take the payback setting off, undo it from Telegram: /changes.` · `It's a payback now, but Wealthfolio didn't file it under <category> — pick its category in Wealthfolio.` · `It's a payback now, but couldn't tell whether Wealthfolio filed it under <category> — check it in Wealthfolio.` · in the stories (shared/tx-story.ts): `A payback: it lowers your spending.` and `Filed under <category> by you, as a payback[, <day>].` · Task 7 (shared/audit-link.ts): `One of these is a payback, not half of a transfer — nothing was linked.` Every other refusal reuses W6's words (`PAYBACK_*`). Messages are raw; a multi-line one is shown a line per block. No emoji anywhere in the app (src/pages/copy-policy.test.tsx).
- **Wealthfolio's error text never reaches a message**: it goes to the add-on's log (`console.warn`, `[simplefin-sync]`).
- **The change log never costs the payback,** and the app's entry goes through the strict append: when it was not written the reply says there is no Undo. Its `after.categoryId` is the category Wealthfolio CONFIRMED (null when none or unknown).
- **Tests use a fixed `now`** (`NOW` constants, fixed ISO instants). Every new test file also passes with the date forced to 2027-01-01 (Tasks 6 and 7).
- **Imports:** shared sources import siblings WITH `.js`; `src/` imports shared WITHOUT an extension; companion imports `'../../shared/x.js'` and `'./x.js'`. SDK imports in `src/` stay `import type`; every SDK call is made as a method on `ctx.api` (never `.call`).
- **Nick's Mac overheats: every vitest runs as `nice npx vitest run --maxWorkers=2 …`** (the companion's from `companion/`, never with `--root`); builds and packaging under `nice`. Each task runs its own files; the full suites run once, in Task 7.
- **Gates before calling a task done:** the touched project's tests, plus `nice npm run type-check` when `src/` or `shared/` changed and `nice npm --prefix companion run build` when `companion/` or `shared/` changed. Final (Task 7): `nice npx vitest run --maxWorkers=2`, `(cd companion && nice npx vitest run --maxWorkers=2)` (it includes the real-sqlite3 CLI test), `nice npm run type-check`, `nice npm --prefix companion run build`, `nice npm run package`.
- **Edits are exact.** Every "replace" block is copied from the file as it stands after the previous tasks (and the earlier edits of the same file in the same step) and occurs exactly once; replace it verbatim (the Edit tool's `old_string` → `new_string`). Apply a file's numbered edits in order. Every "Create" block is the whole file.
- **No version bump before Task 7**, which is the last task. **Never `git stash`.** **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Another rule files the row first** — W10's CREDIT rule at priority 50, or anything louder → the one-off rule is in place before the re-type and outranks W10's; a louder one is named and logged. Pinned in Task 2 (`wins the race with an older rule for CREDITs (W10's, at priority 50)…`, `files nothing while the row is still a deposit: the rule is for CREDITs`, `says so, and logs that category, when Wealthfolio filed it under another one first`).
- **A step that fails partway leaves an honest state and names it** → Task 2's `a step that fails partway says what stands` block (rule refused; rule refused and not deleted; override not saved; override landed despite an error; document turned unreadable; re-type refused; refused and the setting stuck; re-read failed; re-type landed but its answer lost; row gone; row gone and setting stuck; rule left beside a refused re-type) and its `filing` block (rule run failed; read-back failed; row no longer listed; Wealthfolio filed nothing; rule not deleted; log not written). Wealthfolio's text: `not.toContain(RAW)` there.
- **A gate the page cannot see** — no companion, a 1.61 companion, a 3.8 host, a row filed already, a category gone → Task 1 (`the gate (W11)` table), Task 2 (`refuses at the gate…`, `refuses a row filed under income already`, `refuses a category that is gone or not spending`), Task 3 (`the gate, read through the SDK`, `a 1.61 companion is refused before anything is read or written`, `whether the app offers…`), Task 5 (`is hidden with %s`).
- **A one-off rule left behind** → swept by the key it rebuilds, never blocking a payback. Task 1 (`the leftover sweep`), Task 2 (`one-off rules left behind`), Task 3 (`sweeps a one-off rule a failed run left behind…`).
- **The list and its count** → a filed row leaves both at once; a refused one stays with its reason; a publish made after the filing is the truth again. Task 5 (`a filed row leaves the list and the count at once…`, `a refused row stays…`, `a row filed as a payback leaves the needs-a-category list at once (W11)`).
- **Integration review** → Link never re-creates a payback (Task 7 `Link never takes a payback…`, `Health never offers a payback…`), W10 promises Undo only when logged, refused ids capped, the version gates never above the shipped version.
- **Dates** → a bare stored day is written back at noon UTC (Task 2 `writes a bare stored day back at noon UTC on it`); Tasks 6 and 7 run every new test file with the date forced to 2027-01-01.

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/payback-copy.ts` (modify) | The app's sentences (Task 1); W10's Done line without an Undo it cannot give (Task 7). |
| `shared/payback-app.ts` (create) | `paybackOnceRule`, `paybackOnceKey`, `leftoverPaybackKeys`, `appPaybackGate`, `paybackCategoriesOf`, `paybackPickList`, `paybackOfferedInStory`. Pure. |
| `shared/payback-app-file.ts` (create) | `filePaybackInApp`, `AppPaybackIo`, `AppPaybackChoice`, `AppPaybackOutcome`. Pure. |
| `manifest.json`, `src/utils/secrets.ts` (modify) | The rule permissions; `recordChangeStrict`. |
| `src/utils/app-payback.ts` (create) | `addonPaybackIo`, `paybackFromApp` (write lock), `appPaybacksOffered`, `readPaybackCategories`. |
| `shared/uncategorized.ts`, `companion/src/uncategorized-status.ts` (modify) | `paybackEligible` (Task 4); `PaidBackLedger`, `paidBackHidden` (Task 5). |
| `shared/tx-story.ts`, `src/utils/tx-story.ts`, `companion/src/tx-story-host.ts` (modify) | "by you, as a payback"; "A payback: it lowers your spending."; the row's subtype; the story's `payback` offer. |
| `src/components/PaybackAction.tsx` (create) | The button and the picker; `AppPaybackActions`; `MessageLines`. |
| `src/components/TxStory.tsx`, `src/components/UncategorizedList.tsx`, `src/tabs/HomeTab.tsx`, `src/pages/SyncPage.tsx` (modify) | The story's and the list's action; the optimistic removal, held by the page. |
| `CHANGELOG.md`, `README.md`, `docs/superpowers/follow-ups.md` (modify) | Docs; follow-ups §17 says W11 shipped and what it leaves. |
| `shared/audit-link.ts`, `shared/audit-health.ts`, `companion/src/audit-facts.ts`, `shared/payback.ts`, `companion/src/payback-host.ts`, `shared/change-entries.ts` (modify) | Task 7's integration fixes. |
| `shared/version.ts`, `manifest.json`, `package.json`, `package-lock.json` (modify) | Task 7: 1.62.0. |

---

### Task 1: The app's payback decisions and words

Ruling 7's copy and every pure decision the add-on's runner and UI need: the one-off rule that only this row can match once it is a CREDIT (its exact note, its account, priority 1,000,000) and its key, the keys a sweep rebuilds from what `getRules` lists (no key there), the gate (ruling 2 and the 3.9 check), the categories as the picker offers them, and whether a story offers the action.

**Files:**
- Create: `shared/payback-app.ts`
- Modify: `shared/payback-copy.ts` (append the app's section)
- Test: `shared/payback-app.test.ts`

**Interfaces:**
- Consumes: `PAYBACK_UNAVAILABLE` (payback-copy), `companionUnderstandsPaybacks` (shared/version.ts), `txIdFromComment`/`descriptionFromComment`/`OPENING_BALANCES_CATEGORY` (sync-core), `SYNC_BOOKKEEPING_CATEGORY` (bookkeeping-filing), `TxStoryFacts` (tx-story).
- Produces:

```ts
// shared/payback-app.ts
export const PAYBACK_ONCE_PRIORITY = 1_000_000;
export const paybackOnceKey: (accountId: string, txId: string) => string; // 'payback-once:<accountId>:<txId>'
export interface PaybackOnceRule { ruleKey: string; name: string; pattern: string; matchType: 'exact'; kind: 'expense'; categoryId: string; activityType: 'CREDIT'; accountId: string; priority: number }
export function paybackOnceRule(row: Pick<PaybackRow, 'accountId' | 'notes'>, categoryId: string): PaybackOnceRule | null;
export interface ListedRule { name?: string; pattern?: string; accountId?: string | null; activityType?: string | null; priority?: number }
export function leftoverPaybackKeys(rules: readonly ListedRule[]): string[];
export function appPaybackGate(f: { hostOffersFacts: boolean; companionVersion: string | null }): string | null;
export interface PaybackCategory { id: string; name: string; parentName: string | null; path: string; kind: string }
export function paybackCategoriesOf(raw: unknown): PaybackCategory[];
export function paybackPickList(categories: readonly PaybackCategory[]): PaybackCategory[];
export function paybackOfferedInStory(facts: TxStoryFacts): boolean;
// shared/payback-copy.ts — PAYBACK_APP_ACTION, PAYBACK_APP_FILE, PAYBACK_APP_CANCEL, PAYBACK_APP_CATEGORY_LABEL,
// PAYBACK_APP_CHOOSE, PAYBACK_APP_LOADING, PAYBACK_APP_CATEGORIES_FAILED, PAYBACK_APP_UNDO_HINT, paybackOnceName,
// paybackLeftoverRule, paybackFiledFirst, paybackAlreadyFiled, PAYBACK_UPDATE_COMPANION, PAYBACK_COMPANION_UNKNOWN,
// PAYBACK_NOT_IN_SPENDING, PAYBACK_RULE_REFUSED, PAYBACK_APP_UPDATE_STUCK, PAYBACK_APP_UPDATE_UNSURE,
// PAYBACK_APP_SETTING_HINT, paybackAppUnfiled, paybackAppUnsure
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/payback-app.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import * as copy from './payback-copy.js';
import {
  PAYBACK_APP_ACTION, PAYBACK_APP_UNDO_HINT, PAYBACK_PICK, PAYBACK_UNAVAILABLE, PAYBACK_UPDATE_COMPANION,
  paybackAlreadyFiled, paybackFiledFirst, paybackLeftoverRule, paybackOnceName,
} from './payback-copy.js';
import {
  appPaybackGate, leftoverPaybackKeys, PAYBACK_ONCE_PRIORITY, paybackCategoriesOf, paybackOfferedInStory, paybackOnceKey, paybackOnceRule,
  paybackPickList, type ListedRule,
} from './payback-app.js';
import type { TxStoryFacts } from './tx-story.js';

const EMOJI = /\p{Extended_Pictographic}/u;
const ONE_OFF: ListedRule = {
  name: 'Payback (one-off) — VENMO CASHOUT', pattern: 'VENMO CASHOUT · TRN-77', accountId: 'wf-chk', activityType: 'CREDIT', priority: 1_000_000,
};

describe('the one-off filing rule', () => {
  it('matches only this row once it is a CREDIT: its exact note, its account, far above every other rule', () => {
    expect(paybackOnceRule({ accountId: 'wf-chk', notes: 'VENMO CASHOUT · TRN-77' }, 'cat-rest')).toEqual({
      ruleKey: 'payback-once:wf-chk:TRN-77',
      name: 'Payback (one-off) — VENMO CASHOUT',
      pattern: 'VENMO CASHOUT · TRN-77',
      matchType: 'exact',
      kind: 'expense',
      categoryId: 'cat-rest',
      activityType: 'CREDIT',
      accountId: 'wf-chk',
      priority: 1_000_000,
    });
  });

  it('is named by its tx id when the bank gave no words', () => {
    expect(paybackOnceRule({ accountId: 'wf-chk', notes: ' · TRN-77' }, 'cat-rest')?.name).toBe('Payback (one-off) — TRN-77');
  });

  it('has none for a row whose note carries no tx id', () => {
    expect(paybackOnceRule({ accountId: 'wf-chk', notes: 'Cash deposit' }, 'cat-rest')).toBeNull();
  });

  it("outranks W10's rules (50) and stays within Wealthfolio's 32-bit priority", () => {
    expect(PAYBACK_ONCE_PRIORITY).toBeGreaterThan(50);
    expect(PAYBACK_ONCE_PRIORITY).toBeLessThanOrEqual(2 ** 31 - 1);
  });
});

describe('the leftover sweep', () => {
  it('rebuilds the key of each one-off rule left in Wealthfolio from its account and the tx id in its pattern, once', () => {
    expect(leftoverPaybackKeys([
      ONE_OFF,
      { ...ONE_OFF, name: 'Payback (one-off) — ZELLE FROM SAM', pattern: 'ZELLE FROM SAM · TRN-9', accountId: 'wf-sav' },
      { ...ONE_OFF, name: 'renamed in Wealthfolio' },
    ])).toEqual([paybackOnceKey('wf-chk', 'TRN-77'), paybackOnceKey('wf-sav', 'TRN-9')]);
  });

  it.each<[string, ListedRule]>([
    ['a rule at another priority', { ...ONE_OFF, priority: 50 }],
    ['a rule for another type', { ...ONE_OFF, activityType: 'WITHDRAWAL' }],
    ['a rule for every account', { ...ONE_OFF, accountId: null }],
    ['a pattern with no tx id', { ...ONE_OFF, pattern: 'VENMO' }],
    ['a rule with no pattern', { ...ONE_OFF, pattern: undefined }],
  ])('leaves %s alone', (_name, rule) => {
    expect(leftoverPaybackKeys([rule])).toEqual([]);
  });
});

describe('the gate (W11)', () => {
  it.each<[string, boolean, string | null, string | null]>([
    ['a 3.9 host and a 1.62 companion', true, '1.62.0', null],
    ['a newer companion', true, '1.70.1', null],
    ['no companion at all: nothing could undo it', true, null, PAYBACK_UNAVAILABLE],
    ['a 1.61 companion, which turns a payback back into a deposit', true, '1.61.0', PAYBACK_UPDATE_COMPANION],
    ['a companion version it cannot read', true, 'garbage', PAYBACK_UPDATE_COMPANION],
    ['a 3.8 host, which has no facts to confirm the filing', false, '1.62.0', PAYBACK_UNAVAILABLE],
  ])('%s', (_name, hostOffersFacts, companionVersion, expected) => {
    expect(appPaybackGate({ hostOffersFacts, companionVersion })).toBe(expected);
  });
});

describe('the categories', () => {
  const RAW: unknown[] = [
    { kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-rest', key: 'restaurants', name: 'Restaurants', path: 'Food & Dining / Restaurants' },
    { kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-food', key: 'food', name: 'Food & Dining', path: 'Food & Dining' },
    { kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-open', key: 'opening', name: 'Opening balances', path: 'Opening balances' },
    { kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-book', key: 'book', name: 'Sync bookkeeping', path: 'Sync bookkeeping' },
    { kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-auto', key: 'auto', name: 'Auto', path: '' },
    { kind: 'income', taxonomyId: 'income_categories', categoryId: 'cat-gift', key: 'gifts', name: 'Gifts', path: 'Gifts' },
    { kind: 'expense', categoryId: '', name: 'broken' },
    'nonsense',
  ];

  it('reads each with its parent, whose spending a payback comes off', () => {
    const cats = paybackCategoriesOf(RAW);
    expect(cats.map((c) => c.id)).toEqual(['cat-rest', 'cat-food', 'cat-open', 'cat-book', 'cat-auto', 'cat-gift']);
    expect(cats[0]).toEqual({ id: 'cat-rest', name: 'Restaurants', parentName: 'Food & Dining', path: 'Food & Dining / Restaurants', kind: 'expense' });
    expect(cats[1].parentName).toBeNull();
    expect(cats[4]).toMatchObject({ path: 'Auto', parentName: null });
  });

  it("offers only spending categories, by path, without the add-on's own bookkeeping ones", () => {
    expect(paybackPickList(paybackCategoriesOf(RAW)).map((c) => c.path)).toEqual(['Auto', 'Food & Dining', 'Food & Dining / Restaurants']);
  });

  it('reads nothing from something that is not a list', () => {
    expect(paybackCategoriesOf(null)).toEqual([]);
    expect(paybackCategoriesOf({ items: [] })).toEqual([]);
  });
});

describe("the story's offer", () => {
  const base: TxStoryFacts = {
    row: { activityId: 'act-7', note: 'VENMO CASHOUT · TRN-77', absCents: 1400, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking', accountType: 'CASH' },
    feed: { sfinAccountId: 'sfin-chk' },
    partner: null,
    category: null,
    overrides: [],
  };
  const row = (over: Partial<TxStoryFacts['row']>) => ({ ...base, row: { ...base.row, ...over } });

  it('is made on a posted deposit from the bank feed that Wealthfolio says is filed nowhere', () => {
    expect(paybackOfferedInStory(base)).toBe(true);
  });

  it("is not made without Wealthfolio's word that it is filed nowhere (a 3.8 host), even from the needs-a-category list", () => {
    const { category: _none, ...noFact } = base;
    expect(paybackOfferedInStory({ ...noFact, needsCategory: true })).toBe(false);
    expect(paybackOfferedInStory(noFact)).toBe(false);
  });

  it.each<[string, TxStoryFacts]>([
    ['a row filed already', { ...base, category: { name: 'Gifts' } }],
    ['a withdrawal', row({ activityType: 'WITHDRAWAL' })],
    ['a payback already', row({ activityType: 'CREDIT' })],
    ['a card', row({ accountType: 'CREDIT_CARD' })],
    ['an account of unknown type', row({ accountType: undefined })],
    ['a pending row', row({ note: 'VENMO CASHOUT · TRN-77 · pending' })],
    ['a row not from the bank feed', { ...base, feed: null }],
    ['a row the sync manages', row({ note: 'Starting balance · 2026-10-01' })],
    ['$0', row({ absCents: 0 })],
    ['half of a transfer', { ...base, partner: { accountName: 'Ally Savings' } }],
    ['a transfer it could not rule out', { ...base, partner: undefined }],
    ['a row the payback setting is on', { ...base, overrides: ['asReimbursement'] }],
    ['a story whose overrides could not be read', { ...base, failed: ['overrides'] }],
    ['a story whose mapping could not be read', { ...base, failed: ['mapping'] }],
  ])('is not made on %s', (_name, facts) => {
    expect(paybackOfferedInStory(facts)).toBe(false);
  });
});

describe("the app's words", () => {
  it('are the rulings’ own, and the picker reuses Telegram’s heading', () => {
    expect(PAYBACK_APP_ACTION).toBe("It's a payback…");
    expect(PAYBACK_PICK).toBe('Pick the spending it pays you back for.');
    expect(paybackOnceName('VENMO CASHOUT')).toBe('Payback (one-off) — VENMO CASHOUT');
    expect(PAYBACK_APP_UNDO_HINT).toBe('Undo it from Telegram: /changes.');
    expect(paybackLeftoverRule('Payback (one-off) — VENMO CASHOUT')).toBe(
      'A one-off rule named "Payback (one-off) — VENMO CASHOUT" is still in Wealthfolio\'s rules; delete it there if it stays.',
    );
    expect(paybackFiledFirst('Groceries')).toBe("Wealthfolio filed it under Groceries first — it's a payback there; move it in Wealthfolio if that's wrong.");
    expect(paybackAlreadyFiled('Gifts')).toBe("It's filed under Gifts already — take that off in Wealthfolio first.");
  });

  it('carry no emoji', () => {
    const said = [
      copy.PAYBACK_APP_ACTION, copy.PAYBACK_APP_FILE, copy.PAYBACK_APP_CANCEL, copy.PAYBACK_APP_CATEGORY_LABEL, copy.PAYBACK_APP_CHOOSE,
      copy.PAYBACK_APP_LOADING, copy.PAYBACK_APP_CATEGORIES_FAILED, copy.PAYBACK_APP_UNDO_HINT, copy.PAYBACK_UPDATE_COMPANION,
      copy.PAYBACK_COMPANION_UNKNOWN, copy.PAYBACK_NOT_IN_SPENDING, copy.PAYBACK_RULE_REFUSED, copy.PAYBACK_APP_UPDATE_STUCK,
      copy.PAYBACK_APP_UPDATE_UNSURE, copy.PAYBACK_APP_SETTING_HINT, copy.paybackOnceName('VENMO'), copy.paybackLeftoverRule('x'),
      copy.paybackFiledFirst('x'), copy.paybackAlreadyFiled('x'), copy.paybackAppUnfiled('x'), copy.paybackAppUnsure('x'),
    ];
    expect(said.filter((s) => EMOJI.test(s))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npx vitest run --maxWorkers=2 shared/payback-app.test.ts`
Expected: FAIL — the file does not load: `Error: Failed to resolve import "./payback-app.js" from "shared/payback-app.test.ts". Does the file exist?` (Test Files 1 failed (1), Tests no tests).

- [ ] **Step 3: Implement**

Edit 1 of 1 in `shared/payback-copy.ts` — replace:

```ts
export const paybackRulesStuck = (pattern: string): string =>
  `Wealthfolio didn't take the category rule, and the transaction rule couldn't be taken back — new ${pattern} deposits become paybacks with no category. Undo the transaction rule from /changes.`;
```

with:

```ts
export const paybackRulesStuck = (pattern: string): string =>
  `Wealthfolio didn't take the category rule, and the transaction rule couldn't be taken back — new ${pattern} deposits become paybacks with no category. Undo the transaction rule from /changes.`;

// ── In the app (W11) ─────────────────────────────────────────────────────
// No emoji: the app's copy policy (src/pages/copy-policy.test.tsx). The picker's
// heading is PAYBACK_PICK; the filed line is paybackDone, as in Telegram.
/** The action on a money-in row of the needs-a-category list, and on its story. */
export const PAYBACK_APP_ACTION = "It's a payback…";
/** Files it, once a category is chosen. */
export const PAYBACK_APP_FILE = 'File it';
export const PAYBACK_APP_CANCEL = 'Cancel';
/** The picker's accessible name, and its empty choice. */
export const PAYBACK_APP_CATEGORY_LABEL = 'Spending category';
export const PAYBACK_APP_CHOOSE = 'Choose a category';
export const PAYBACK_APP_LOADING = 'Loading categories…';
export const PAYBACK_APP_CATEGORIES_FAILED = "Couldn't read your spending categories — try again.";
/** The filed reply's last line in the app (Telegram's is PAYBACK_UNDO_HINT). */
export const PAYBACK_APP_UNDO_HINT = 'Undo it from Telegram: /changes.';
/** The one-off filing rule's name in Wealthfolio's rules list. */
export const paybackOnceName = (bankWords: string): string => `Payback (one-off) — ${bankWords}`;
/** The one-off rule could not be deleted (or may have landed when its save failed). */
export const paybackLeftoverRule = (ruleName: string): string =>
  `A one-off rule named "${ruleName}" is still in Wealthfolio's rules; delete it there if it stays.`;
/** Another rule filed the payback before the one-off rule could. */
export const paybackFiledFirst = (categoryName: string): string =>
  `Wealthfolio filed it under ${categoryName} first — it's a payback there; move it in Wealthfolio if that's wrong.`;
/** The row has a filing in some taxonomy already; the add-on SDK cannot take one off. */
export const paybackAlreadyFiled = (categoryName: string): string =>
  `It's filed under ${categoryName} already — take that off in Wealthfolio first.`;
/** The app, while the companion is older than PAYBACK_SINCE (W8, W11). */
export const PAYBACK_UPDATE_COMPANION = 'Update the companion to 1.62.0 or newer first — an older one turns a payback back into a deposit on its next sync. Nothing was changed.';
export const PAYBACK_COMPANION_UNKNOWN = "Couldn't check the companion's version — nothing was changed. Try again.";
export const PAYBACK_NOT_IN_SPENDING = "Wealthfolio's Spending doesn't track this account, so it can't take a payback — nothing was changed.";
export const PAYBACK_RULE_REFUSED = "Wealthfolio didn't take the filing rule — nothing was changed.";
export const PAYBACK_APP_UPDATE_STUCK = "Wealthfolio didn't take the change, so it's still a deposit — but the payback setting couldn't be taken back, so the next sync makes it a payback with no category.";
export const PAYBACK_APP_UPDATE_UNSURE = "Couldn't tell whether Wealthfolio took the change. The payback setting stays, so the next sync makes it a payback; if it has no category then, pick one in Wealthfolio.";
/** After the payback setting stays on a row that may not be a payback (logged, so Telegram's Undo takes it off). */
export const PAYBACK_APP_SETTING_HINT = 'To take the payback setting off, undo it from Telegram: /changes.';
export const paybackAppUnfiled = (categoryName: string): string =>
  `It's a payback now, but Wealthfolio didn't file it under ${categoryName} — pick its category in Wealthfolio.`;
export const paybackAppUnsure = (categoryName: string): string =>
  `It's a payback now, but couldn't tell whether Wealthfolio filed it under ${categoryName} — check it in Wealthfolio.`;
```

**Create `shared/payback-app.ts`:**

```ts
/**
 * shared/payback-app.ts
 *
 * Paybacks in the app (1.62.0, W11): what the add-on's "It's a payback…"
 * decides before it writes anything. Pure.
 *
 * The add-on SDK has no call that files one transaction, so the app files a
 * payback through a categorization rule of its own that only that row matches
 * — a one-off rule: the row's exact note, its account, CREDIT only, far above
 * every other rule — which Wealthfolio's rule run applies, and which is deleted
 * after (shared/payback-app-file.ts). Wealthfolio's matcher upper-cases both
 * sides of an exact match, skips a rule scoped to another account, and needs
 * the row's effective type to equal the rule's; the highest priority wins
 * (upstream categorization_rules/matcher.rs `match_compiled`). The rule's key
 * is rebuilt from what the rule itself keeps — its account and the tx id in its
 * pattern — because `getRules` lists no keys and `deleteRule` needs one: so a
 * rule a failed run left behind is swept by the next payback.
 *
 * The gate: a host that offers Wealthfolio's facts (3.9+, `hostCan`), since
 * the filing is confirmed by reading them back, and a companion of 1.62.0 or
 * newer (an older one turns a payback back into a deposit; with none at all,
 * nothing could undo it). The action is hidden otherwise.
 */
import { isCorrectionNote, isPendingNote, isPlaceholderNote, isStartingBalanceNote } from './audit-ledger.js';
import { SYNC_BOOKKEEPING_CATEGORY } from './bookkeeping-filing.js';
import { PAYBACK_UNAVAILABLE, PAYBACK_UPDATE_COMPANION, paybackOnceName } from './payback-copy.js';
import type { PaybackRow } from './payback-row.js';
import { descriptionFromComment, OPENING_BALANCES_CATEGORY, txIdFromComment } from './sync-core.js';
import type { TxStoryFacts } from './tx-story.js';
import { companionUnderstandsPaybacks } from './version.js';

/** The one-off rule's priority: far above any rule a person makes, and W10's
 *  (50) — Wealthfolio stores an i32 and checks no range. */
export const PAYBACK_ONCE_PRIORITY = 1_000_000;

/** The one-off rule's key, `payback-once:<accountId>:<txId>`. */
export const paybackOnceKey = (accountId: string, txId: string): string => `payback-once:${accountId}:${txId}`;

/** A one-off rule, as `spending.saveRule` takes it. */
export interface PaybackOnceRule {
  ruleKey: string;
  name: string;
  pattern: string;
  matchType: 'exact';
  kind: 'expense';
  categoryId: string;
  activityType: 'CREDIT';
  accountId: string;
  priority: number;
}

/** The rule that files exactly this row, once it is a CREDIT, under the
 *  category; null when its note carries no tx id. */
export function paybackOnceRule(row: Pick<PaybackRow, 'accountId' | 'notes'>, categoryId: string): PaybackOnceRule | null {
  const txId = txIdFromComment(row.notes);
  if (!txId) return null;
  return {
    ruleKey: paybackOnceKey(row.accountId, txId),
    name: paybackOnceName(descriptionFromComment(row.notes) || txId),
    pattern: row.notes,
    matchType: 'exact',
    kind: 'expense',
    categoryId,
    activityType: 'CREDIT',
    accountId: row.accountId,
    priority: PAYBACK_ONCE_PRIORITY,
  };
}

/** One of this add-on's rules as `spending.getRules` lists it: no key. */
export interface ListedRule {
  name?: string;
  pattern?: string;
  accountId?: string | null;
  activityType?: string | null;
  priority?: number;
}

/** The keys of one-off payback rules still in Wealthfolio: this add-on's
 *  rules at the one-off priority, CREDIT only, scoped to an account, whose
 *  pattern carries a tx id. */
export function leftoverPaybackKeys(rules: readonly ListedRule[]): string[] {
  const keys = new Set<string>();
  for (const r of rules) {
    if (r.priority !== PAYBACK_ONCE_PRIORITY || r.activityType !== 'CREDIT' || !r.accountId || typeof r.pattern !== 'string') continue;
    const txId = txIdFromComment(r.pattern);
    if (txId) keys.add(paybackOnceKey(r.accountId, txId));
  }
  return [...keys];
}

/** Why the app cannot file a payback now, or null. `hostOffersFacts`:
 *  `hostCan(ctx, 'spending.searchCashActivities')` (Wealthfolio 3.9+). */
export function appPaybackGate(f: { hostOffersFacts: boolean; companionVersion: string | null }): string | null {
  if (!f.hostOffersFacts || f.companionVersion === null) return PAYBACK_UNAVAILABLE;
  return companionUnderstandsPaybacks(f.companionVersion) ? null : PAYBACK_UPDATE_COMPANION;
}

/** A category as a payback reads it (`spending.getCategories`). */
export interface PaybackCategory {
  id: string;
  name: string;
  /** Its parent's name, whose spending a payback comes off ("Food & Dining"
   *  for Restaurants); null for a top-level category. */
  parentName: string | null;
  /** "Food & Dining / Restaurants": what the picker shows. */
  path: string;
  /** `expense` (spending), `income` or `saving`. */
  kind: string;
}

/** Upstream `buildCategoryPath` joins the names with this. */
const PATH_SEPARATOR = ' / ';
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `spending.getCategories()` as a payback reads it; an entry it cannot read is left out. */
export function paybackCategoriesOf(raw: unknown): PaybackCategory[] {
  if (!Array.isArray(raw)) return [];
  const out: PaybackCategory[] = [];
  for (const c of raw) {
    if (!isRecord(c) || typeof c.categoryId !== 'string' || !c.categoryId || typeof c.name !== 'string') continue;
    const path = typeof c.path === 'string' && c.path.trim() !== '' ? c.path : c.name;
    const parts = path.split(PATH_SEPARATOR);
    out.push({
      id: c.categoryId,
      name: c.name,
      parentName: parts.length > 1 ? parts[parts.length - 2] : null,
      path,
      kind: typeof c.kind === 'string' ? c.kind : '',
    });
  }
  return out;
}

/** What the picker offers: the spending categories by path, without the
 *  add-on's own bookkeeping ones (a payback filed there comes off nothing). */
export function paybackPickList(categories: readonly PaybackCategory[]): PaybackCategory[] {
  return categories
    .filter((c) => c.kind === 'expense' && c.name !== OPENING_BALANCES_CATEGORY && c.name !== SYNC_BOOKKEEPING_CATEGORY)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Whether a story offers "It's a payback…": a posted DEPOSIT on a cash
 * account, from the bank feed, not one the sync manages, not $0, in no
 * transfer as far as the story knows, filed nowhere on Wealthfolio's own word
 * (a 3.9 fact — the filing needs one anyway), and not a payback already.
 * Everything is checked again when it is filed.
 */
export function paybackOfferedInStory(facts: TxStoryFacts): boolean {
  const note = facts.row.note ?? '';
  const failed = new Set(facts.failed ?? []);
  if (!facts.feed || failed.has('mapping') || failed.has('partner') || failed.has('overrides') || failed.has('overridesUnreadable')) return false;
  if (facts.partner !== null) return false;
  if (facts.category !== null) return false;
  if (facts.row.activityType.toUpperCase() !== 'DEPOSIT' || (facts.row.accountType ?? '').toUpperCase() !== 'CASH') return false;
  if (!(facts.row.absCents > 0)) return false;
  if (!txIdFromComment(note) || isPendingNote(note) || isPlaceholderNote(note) || isStartingBalanceNote(note) || isCorrectionNote(note)) return false;
  return !(facts.overrides ?? []).includes('asReimbursement');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npx vitest run --maxWorkers=2 shared/payback-app.test.ts`
Expected: PASS — 37 tests (1 file).

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/payback-copy.ts shared/payback-app.ts shared/payback-app.test.ts
git commit -m "Paybacks in the app: the one-off rule, the gate, the categories and the app's words (W11)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Filing a payback from the app: the runner

`filePaybackInApp`, in ruling 1's order, with every failure state said plainly — the add-on's sibling of the companion's `filePayback`, which is not touched. Its test file stands in a small Wealthfolio of its own: a rule save, a re-type and `rerunRules` each run the rules over a row with no category, the highest priority winning (the oldest on a tie), as upstream's `match_compiled` does — so the race with W10's rule is tested, not assumed.

**Files:**
- Create: `shared/payback-app-file.ts`
- Test: `shared/payback-app-file.test.ts`

**Interfaces:**
- Consumes: Task 1's `paybackOnceRule`, `leftoverPaybackKeys`, `ListedRule`, `PaybackCategory`, `PaybackOnceRule` and the copy; W6's `planPayback`, `paybackRowOf` (shared/payback.ts), `isPaybackRow`, `PaybackRow` (payback-row), `paybackFiledChange` (change-entries), `editSyncOverrides` and friends (sync-overrides); `removalFingerprint`, `RemoveMappingUnreadableError` (tx-remove); `CashFact`, `filingOfFact`, `linkedOfFact` (wf-facts).
- Produces:

```ts
// shared/payback-app-file.ts
export interface AppPaybackIo {
  gate(): Promise<string | null>;
  read(activityId: string): Promise<PaybackRow | null>;
  feeds(wfAccountId: string): Promise<string[]>;
  secrets: { get: SecretGet; set: SecretSet };
  fact(row: PaybackRow): Promise<CashFact | null>;
  categories(): Promise<PaybackCategory[]>;
  rules(): Promise<ListedRule[]>;
  saveRule(rule: PaybackOnceRule): Promise<void>;
  deleteRule(ruleKey: string): Promise<void>;
  update(write: ActivityWrite): Promise<void>;
  rerunRules(): Promise<void>;
  record(draft: ChangeDraft): Promise<boolean>;
  log(msg: string): void;
}
export interface AppPaybackChoice { activityId: string; categoryId: string; shown?: string }
export type AppPaybackOutcome = { kind: 'filed' | 'partial' | 'refused'; message: string };
export function filePaybackInApp(choice: AppPaybackChoice, io: AppPaybackIo, now: Date): Promise<AppPaybackOutcome>;
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/payback-app-file.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { SPENDING_TAXONOMY_ID } from './cash-flow-bucket.js';
import { stampChange, type ChangeDraft, type ChangeEntry } from './change-entries.js';
import { paybackRowOf } from './payback.js';
import { paybackCategoriesOf, paybackOnceKey, type ListedRule, type PaybackOnceRule } from './payback-app.js';
import { filePaybackInApp, type AppPaybackChoice, type AppPaybackIo } from './payback-app-file.js';
import {
  PAYBACK_ALREADY, PAYBACK_APP_SETTING_HINT, PAYBACK_APP_UNDO_HINT, PAYBACK_APP_UPDATE_STUCK, PAYBACK_APP_UPDATE_UNSURE, PAYBACK_CATEGORY_GONE,
  PAYBACK_CHANGED, PAYBACK_COMPANION_UNKNOWN, PAYBACK_GONE, PAYBACK_GONE_STUCK, PAYBACK_LINKED, PAYBACK_MAPPING_UNREADABLE, PAYBACK_NO_UNDO,
  PAYBACK_NO_UNDO_SETTING, PAYBACK_NOT_IN_SPENDING, PAYBACK_OVERRIDE_FAILED, PAYBACK_PENDING, PAYBACK_RULE_REFUSED, PAYBACK_RUNNING,
  PAYBACK_UNAVAILABLE, PAYBACK_UNREACHABLE, PAYBACK_UPDATE_COMPANION, PAYBACK_UPDATE_REFUSED,
  paybackAlreadyFiled, paybackAppUnfiled, paybackAppUnsure, paybackFiledFirst, paybackLeftoverRule,
} from './payback-copy.js';
import type { PaybackRow } from './payback-row.js';
import {
  emptySyncOverrides, hasTxOverride, parseSyncOverrides, setTxOverride, SYNC_OVERRIDES_SECRET_KEY, SYNC_OVERRIDES_UNREADABLE_MESSAGE,
} from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import { removalFingerprint, RemoveMappingUnreadableError } from './tx-remove.js';
import type { CashFact } from './wf-facts.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const KEY = accountTxKey('sfin-chk', 'TRN-77');
const OTHER = accountTxKey('sfin-chk', 'TRN-1');
const ONCE = paybackOnceKey('wf-chk', 'TRN-77');
const RULE_NAME = 'Payback (one-off) — VENMO CASHOUT';
const RAW = '400 Bad Request: constraint failed: FOREIGN KEY';

const DETAILS = {
  id: 'act-7', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'DEPOSIT', date: '2026-10-09T12:00:00Z',
  amount: '14', currency: 'USD', comment: 'VENMO CASHOUT · TRN-77', subtype: null,
};
const CATEGORIES = paybackCategoriesOf([
  { kind: 'expense', categoryId: 'cat-rest', name: 'Restaurants', path: 'Food & Dining / Restaurants' },
  { kind: 'expense', categoryId: 'cat-groc', name: 'Groceries', path: 'Food & Dining / Groceries' },
  { kind: 'expense', categoryId: 'cat-auto', name: 'Auto', path: 'Auto' },
  { kind: 'income', categoryId: 'cat-gift', name: 'Gifts', path: 'Gifts' },
]);
const RESTAURANTS: AppPaybackChoice = { activityId: 'act-7', categoryId: 'cat-rest' };
const FILED = 'Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending.';

/** A rule Wealthfolio holds that is not this add-on's (a person's, or W10's). */
interface OtherRule { pattern: string; matchType: 'contains' | 'exact'; categoryId: string; activityType?: string; accountId?: string; priority: number }
type Stored = PaybackOnceRule & { seq: number };

/**
 * Wealthfolio, the add-on's secrets and its rules, in memory, every call in
 * order. Like Wealthfolio, a rule save and a re-type each set off a rule run
 * over the rows with no category, and so does `rerunRules`: the highest
 * priority wins, the oldest on a tie (upstream `match_compiled`).
 */
function world(over: {
  row?: Record<string, unknown> | null;
  secrets?: Record<string, string>;
  filing?: { taxonomyId: string; categoryId: string } | null;
  others?: OtherRule[];
  leftovers?: PaybackOnceRule[];
  inSpending?: boolean;
  grouped?: boolean;
  /** Wealthfolio's Spending is off: its rule runs file nothing. */
  rulesOff?: boolean;
  io?: Partial<AppPaybackIo>;
} = {}) {
  let row: PaybackRow | null = over.row === null ? null : paybackRowOf({ ...DETAILS, ...(over.row ?? {}) }, 'CASH');
  let filing = over.filing ? { ...over.filing, source: 'manual' } : null;
  const data = new Map(Object.entries(over.secrets ?? {}));
  const ours = new Map<string, Stored>();
  let seq = 0;
  for (const r of over.leftovers ?? []) ours.set(r.ruleKey, { ...r, seq: seq++ });
  const calls: string[] = [];
  const logged: ChangeEntry[] = [];
  const logs: string[] = [];
  const runRules = () => {
    if (over.rulesOff || !row || filing) return;
    const r = row;
    const all = [...(over.others ?? []).map((o, i) => ({ ...o, seq: -1000 + i })), ...ours.values()]
      .filter((x) => (!x.accountId || x.accountId === r.accountId) && (!x.activityType || x.activityType === r.type))
      .filter((x) => (x.matchType === 'exact' ? r.notes.toUpperCase() === x.pattern.toUpperCase() : r.notes.toUpperCase().includes(x.pattern.toUpperCase())))
      .sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    if (all[0]) filing = { taxonomyId: SPENDING_TAXONOMY_ID, categoryId: all[0].categoryId, source: 'rule' };
  };
  const factOf = (): CashFact | null => (row && over.inSpending !== false
    ? { activityId: row.id, accountId: row.accountId, link: null, grouped: !!over.grouped, bucket: row.type === 'CREDIT' ? 'spending' : 'income', filings: filing ? [{ ...filing }] : [] }
    : null);
  const io: AppPaybackIo = {
    gate: vi.fn(async () => null),
    read: vi.fn(async (id: string) => { calls.push(`read ${id}`); return row ? { ...row } : null; }),
    feeds: vi.fn(async (wf: string) => { calls.push(`feeds ${wf}`); return ['sfin-chk']; }),
    secrets: {
      get: async (k: string) => data.get(k) ?? null,
      set: vi.fn(async (k: string, v: string) => { calls.push(`set ${k}`); data.set(k, v); }),
    },
    fact: vi.fn(async (r: PaybackRow) => { calls.push(`fact ${r.id}`); return factOf(); }),
    categories: vi.fn(async () => { calls.push('categories'); return CATEGORIES; }),
    rules: vi.fn(async (): Promise<ListedRule[]> => {
      calls.push('rules');
      return [...ours.values()].map((r) => ({ name: r.name, pattern: r.pattern, accountId: r.accountId, activityType: r.activityType, priority: r.priority }));
    }),
    saveRule: vi.fn(async (rule: PaybackOnceRule) => { calls.push(`saveRule ${rule.ruleKey}`); ours.set(rule.ruleKey, { ...rule, seq: seq++ }); runRules(); }),
    deleteRule: vi.fn(async (key: string) => { calls.push(`deleteRule ${key}`); ours.delete(key); }),
    update: vi.fn(async (w) => {
      calls.push(`update ${w.activityType}/${w.subtype}`);
      row = paybackRowOf({ ...DETAILS, ...(over.row ?? {}), activityType: w.activityType, subtype: w.subtype || null, date: w.activityDate }, 'CASH');
      runRules();
    }),
    rerunRules: vi.fn(async () => { calls.push('rerun'); runRules(); }),
    record: vi.fn(async (d: ChangeDraft) => { calls.push(`record ${d.kind}`); logged.push(stampChange(d, 'addon', NOW)); return true; }),
    log: (m: string) => { logs.push(m); },
    ...(over.io ?? {}),
  };
  const overrides = () => {
    const p = parseSyncOverrides(data.get(SYNC_OVERRIDES_SECRET_KEY));
    return p.kind === 'ok' ? p.overrides : p.kind === 'absent' ? emptySyncOverrides() : null;
  };
  return { io, data, calls, logged, logs, overrides, ours, filing: () => filing, row: () => row };
}

describe('filePaybackInApp: filing', () => {
  it('saves the one-off rule BEFORE the re-type, lets Wealthfolio file it, reads the filing back, deletes the rule and logs it', async () => {
    const w = world();
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'filed', message: `${FILED}\n${PAYBACK_APP_UNDO_HINT}` });
    expect(w.calls).toEqual([
      'read act-7', 'feeds wf-chk', 'categories', 'fact act-7', 'rules', `saveRule ${ONCE}`, `set ${SYNC_OVERRIDES_SECRET_KEY}`,
      'update CREDIT/REIMBURSEMENT', 'rerun', 'fact act-7', `deleteRule ${ONCE}`, 'record payback-filed',
    ]);
    expect(w.io.saveRule).toHaveBeenCalledWith({
      ruleKey: ONCE, name: RULE_NAME, pattern: 'VENMO CASHOUT · TRN-77', matchType: 'exact', kind: 'expense', categoryId: 'cat-rest',
      activityType: 'CREDIT', accountId: 'wf-chk', priority: 1_000_000,
    });
    expect(w.io.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'act-7', activityType: 'CREDIT', subtype: 'REIMBURSEMENT', activityDate: '2026-10-09T12:00:00Z', amount: 14 }));
    expect(w.filing()).toEqual({ taxonomyId: SPENDING_TAXONOMY_ID, categoryId: 'cat-rest', source: 'rule' });
    expect(w.ours.size).toBe(0);
    expect(w.overrides()!.tx[KEY]).toEqual({ asReimbursement: true, at: NOW.toISOString(), label: 'VENMO CASHOUT · PNC Checking' });
    expect(w.logged[0]).toMatchObject({
      kind: 'payback-filed', actor: 'you', writer: 'addon', subject: { txKeys: [KEY], activityIds: ['act-7'] },
      before: { activityType: 'DEPOSIT', subtype: null, categoryId: null },
      after: { activityType: 'CREDIT', subtype: 'REIMBURSEMENT', categoryId: 'cat-rest', categoryName: 'Restaurants', accountId: 'wf-chk' },
    });
  });

  it("wins the race with an older rule for CREDITs (W10's, at priority 50): its rule is in place before the re-type", async () => {
    const w10: OtherRule = { pattern: 'VENMO CASHOUT', matchType: 'contains', categoryId: 'cat-groc', activityType: 'CREDIT', accountId: 'wf-chk', priority: 50 };
    const w = world({ others: [w10] });
    expect((await filePaybackInApp(RESTAURANTS, w.io, NOW)).kind).toBe('filed');
    expect(w.filing()?.categoryId).toBe('cat-rest');
  });

  it('files nothing while the row is still a deposit: the rule is for CREDITs', async () => {
    const w = world();
    let filedAtSave: unknown = 'unread';
    const save = w.io.saveRule;
    w.io.saveRule = vi.fn(async (rule: PaybackOnceRule) => {
      await save(rule);
      filedAtSave = w.filing();
    });
    await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(filedAtSave).toBeNull();
    expect(w.filing()?.categoryId).toBe('cat-rest');
  });

  it('says so, and logs that category, when Wealthfolio filed it under another one first', async () => {
    const louder: OtherRule = { pattern: 'VENMO', matchType: 'contains', categoryId: 'cat-groc', activityType: 'CREDIT', priority: 2_000_000 };
    const w = world({ others: [louder] });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({
      kind: 'filed', message: `${paybackFiledFirst('Groceries')}\n${PAYBACK_APP_UNDO_HINT}`,
    });
    expect(w.logged[0].after).toMatchObject({ categoryId: 'cat-groc', categoryName: 'Groceries' });
    expect(w.ours.size).toBe(0);
  });

  it('says it is a payback with no category, and logs none, when Wealthfolio filed nothing', async () => {
    const w = world({ rulesOff: true });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({
      kind: 'partial', message: `${paybackAppUnfiled('Restaurants')}\n${PAYBACK_APP_UNDO_HINT}`,
    });
    expect(w.logged[0].after).toMatchObject({ activityType: 'CREDIT', categoryId: null, categoryName: null });
    expect(w.io.deleteRule).toHaveBeenCalledWith(ONCE);
  });

  it("goes on to read the filing back when the rule run fails: the background runs may have filed it", async () => {
    const w = world();
    w.io.rerunRules = vi.fn(async () => { throw new Error(RAW); });
    const out = await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(out).toEqual({ kind: 'filed', message: `${FILED}\n${PAYBACK_APP_UNDO_HINT}` });
    expect(w.logs.join('\n')).toContain(RAW);
  });

  it("says it can't tell when the filing cannot be read back, and logs no category", async () => {
    const w = world();
    let reads = 0;
    const fact = w.io.fact;
    w.io.fact = vi.fn(async (r: PaybackRow) => { reads += 1; if (reads > 1) throw new Error(RAW); return fact(r); });
    const out = await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(out).toEqual({ kind: 'partial', message: `${paybackAppUnsure('Restaurants')}\n${PAYBACK_APP_UNDO_HINT}` });
    expect(out.message).not.toContain(RAW);
    expect(w.logged[0].after).toMatchObject({ categoryId: null });
    expect(w.ours.size).toBe(0);
  });

  it("says it can't tell when Wealthfolio no longer lists the row after the re-type", async () => {
    const w = world();
    let reads = 0;
    const fact = w.io.fact;
    w.io.fact = vi.fn(async (r: PaybackRow) => { reads += 1; return reads > 1 ? null : fact(r); });
    expect((await filePaybackInApp(RESTAURANTS, w.io, NOW)).message).toBe(`${paybackAppUnsure('Restaurants')}\n${PAYBACK_APP_UNDO_HINT}`);
  });

  it('names the one-off rule when it cannot be deleted; the filing stands', async () => {
    const w = world();
    w.io.deleteRule = vi.fn(async () => { throw new Error(RAW); });
    const out = await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(out).toEqual({ kind: 'filed', message: `${FILED}\n${PAYBACK_APP_UNDO_HINT}\n${paybackLeftoverRule(RULE_NAME)}` });
    expect(out.message).not.toContain(RAW);
  });

  it('says there is no Undo when the change log was not written', async () => {
    const w = world({ io: { record: vi.fn(async () => false) } });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'filed', message: `${FILED}\n${PAYBACK_NO_UNDO}` });
    const thrown = world({ io: { record: vi.fn(async () => { throw new Error('quota'); }) } });
    expect(await filePaybackInApp(RESTAURANTS, thrown.io, NOW)).toEqual({ kind: 'filed', message: `${FILED}\n${PAYBACK_NO_UNDO}` });
  });

  it('keeps every other override in the document', async () => {
    const w = world({ secrets: { [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(setTxOverride(emptySyncOverrides(), OTHER, 'notTransfer', NOW)) } });
    await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(hasTxOverride(w.overrides()!, OTHER, 'notTransfer')).toBe(true);
    expect(hasTxOverride(w.overrides()!, KEY, 'asReimbursement')).toBe(true);
  });

  it('writes a bare stored day back at noon UTC on it', async () => {
    const w = world({ row: { date: '2026-10-09' } });
    await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(w.io.update).toHaveBeenCalledWith(expect.objectContaining({ activityDate: '2026-10-09T12:00:00Z' }));
  });
});

describe('filePaybackInApp: one-off rules left behind', () => {
  const leftover = (txId: string, accountId = 'wf-chk'): PaybackOnceRule => ({
    ruleKey: paybackOnceKey(accountId, txId), name: `Payback (one-off) — ZELLE ${txId}`, pattern: `ZELLE ${txId} · ${txId}`, matchType: 'exact',
    kind: 'expense', categoryId: 'cat-auto', activityType: 'CREDIT', accountId, priority: 1_000_000,
  });

  it('sweeps each one by the key it rebuilds, before saving its own', async () => {
    const w = world({ leftovers: [leftover('TRN-9'), leftover('TRN-5', 'wf-sav')] });
    expect((await filePaybackInApp(RESTAURANTS, w.io, NOW)).kind).toBe('filed');
    const at = (c: string) => w.calls.indexOf(c);
    expect(at(`deleteRule ${paybackOnceKey('wf-chk', 'TRN-9')}`)).toBeLessThan(at(`saveRule ${ONCE}`));
    expect(at(`deleteRule ${paybackOnceKey('wf-sav', 'TRN-5')}`)).toBeLessThan(at(`saveRule ${ONCE}`));
    expect(w.ours.size).toBe(0);
  });

  it('carries on when the rules cannot be read, or one cannot be deleted', async () => {
    const unread = world({ io: { rules: vi.fn(async () => { throw new Error(RAW); }) } });
    expect((await filePaybackInApp(RESTAURANTS, unread.io, NOW)).kind).toBe('filed');
    expect(unread.logs.join('\n')).toContain(RAW);
    const stuck = world({ leftovers: [leftover('TRN-9')] });
    const del = stuck.io.deleteRule;
    stuck.io.deleteRule = vi.fn(async (key: string) => { if (key !== ONCE) throw new Error(RAW); return del(key); });
    expect(await filePaybackInApp(RESTAURANTS, stuck.io, NOW)).toEqual({ kind: 'filed', message: `${FILED}\n${PAYBACK_APP_UNDO_HINT}` });
  });

  it('sweeps nothing when it refuses', async () => {
    const w = world({ leftovers: [leftover('TRN-9')], row: { comment: 'VENMO CASHOUT · TRN-77 · pending' } });
    await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(w.io.rules).not.toHaveBeenCalled();
    expect(w.ours.size).toBe(1);
  });
});

describe('filePaybackInApp: refusals write nothing', () => {
  const nothingWritten = (w: ReturnType<typeof world>) => {
    expect(w.io.saveRule).not.toHaveBeenCalled();
    expect(w.io.secrets.set).not.toHaveBeenCalled();
    expect(w.io.update).not.toHaveBeenCalled();
    expect(w.io.record).not.toHaveBeenCalled();
  };

  it.each([PAYBACK_UNAVAILABLE, PAYBACK_UPDATE_COMPANION, PAYBACK_COMPANION_UNKNOWN])('refuses at the gate, in its words, reading nothing: %s', async (gate) => {
    const w = world({ io: { gate: vi.fn(async () => gate) } });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: gate });
    expect(w.calls).toEqual([]);
  });

  it("says it couldn't reach Wealthfolio when the gate itself fails", async () => {
    const w = world({ io: { gate: vi.fn(async () => { throw new Error(RAW); }) } });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_UNREACHABLE });
    expect(w.calls).toEqual([]);
  });

  it('refuses a second click on the same row while the first is filing', async () => {
    const w = world();
    let release!: () => void;
    w.io.gate = vi.fn(() => new Promise<null>((r) => { release = () => r(null); }));
    const first = filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_RUNNING });
    release();
    expect((await first).kind).toBe('filed');
  });

  it.each<[string, Parameters<typeof world>[0], string]>([
    ['a pending row', { row: { comment: 'VENMO CASHOUT · TRN-77 · pending' } }, PAYBACK_PENDING],
    ['a payback already', { row: { activityType: 'CREDIT', subtype: 'REIMBURSEMENT' } }, PAYBACK_ALREADY],
    ['a row that is gone', { row: null }, PAYBACK_GONE],
    ['an account Spending does not track', { inSpending: false }, PAYBACK_NOT_IN_SPENDING],
    ['half of a transfer Wealthfolio says is linked', { grouped: true }, PAYBACK_LINKED],
    ['a row filed under income already', { filing: { taxonomyId: 'income_categories', categoryId: 'cat-gift' } }, paybackAlreadyFiled('Gifts')],
    ['a row filed under a category it cannot name', { filing: { taxonomyId: SPENDING_TAXONOMY_ID, categoryId: 'cat-x' } }, paybackAlreadyFiled('another category')],
    ['an overrides document it cannot read', { secrets: { [SYNC_OVERRIDES_SECRET_KEY]: '{oops' } }, SYNC_OVERRIDES_UNREADABLE_MESSAGE],
  ])('refuses %s', async (_name, over, message) => {
    const w = world(over);
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message });
    nothingWritten(w);
  });

  it.each(['cat-gone', 'cat-gift'])('refuses a category that is gone or not spending (%s)', async (categoryId) => {
    const w = world();
    expect(await filePaybackInApp({ activityId: 'act-7', categoryId }, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_CATEGORY_GONE });
    nothingWritten(w);
    expect(w.io.fact).not.toHaveBeenCalled();
  });

  it('refuses a row that changed since the story showed it, and files one that did not', async () => {
    const w = world();
    expect(await filePaybackInApp({ ...RESTAURANTS, shown: 'deadbeef' }, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_CHANGED });
    nothingWritten(w);
    const shown = removalFingerprint({ activityId: 'act-7', note: 'VENMO CASHOUT · TRN-77', absCents: 1400, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking' });
    expect((await filePaybackInApp({ ...RESTAURANTS, shown }, world().io, NOW)).kind).toBe('filed');
  });

  it.each<[string, Partial<AppPaybackIo>, string]>([
    ['the row', { read: vi.fn(async () => { throw new Error(RAW); }) }, PAYBACK_UNREACHABLE],
    ['the categories', { categories: vi.fn(async () => { throw new Error(RAW); }) }, PAYBACK_UNREACHABLE],
    ["Wealthfolio's facts", { fact: vi.fn(async () => { throw new Error(RAW); }) }, PAYBACK_UNREACHABLE],
    ['the account mapping', { feeds: vi.fn(async () => { throw new RemoveMappingUnreadableError(); }) }, PAYBACK_MAPPING_UNREADABLE],
  ])('refuses when %s cannot be read', async (_name, io, message) => {
    const w = world({ io });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message });
    nothingWritten(w);
    expect(w.logs).not.toEqual([]);
  });
});

describe('filePaybackInApp: a step that fails partway says what stands', () => {
  it('stops at a rule Wealthfolio refuses, deleting it in case it landed: nothing changed', async () => {
    const w = world({ io: { saveRule: vi.fn(async () => { throw new Error(RAW); }) } });
    const out = await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(out).toEqual({ kind: 'refused', message: PAYBACK_RULE_REFUSED });
    expect(w.io.deleteRule).toHaveBeenCalledWith(ONCE);
    expect(w.io.secrets.set).not.toHaveBeenCalled();
    expect(w.io.update).not.toHaveBeenCalled();
    expect(w.logs.join('\n')).toContain(RAW);
  });

  it('names the rule when its save failed and it cannot be deleted either', async () => {
    const w = world({ io: { saveRule: vi.fn(async () => { throw new Error(RAW); }), deleteRule: vi.fn(async () => { throw new Error(RAW); }) } });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: `${PAYBACK_RULE_REFUSED}\n${paybackLeftoverRule(RULE_NAME)}` });
  });

  it('takes the rule back out when the override cannot be saved', async () => {
    const w = world();
    w.io.secrets.set = vi.fn(async () => { throw new Error(RAW); });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_OVERRIDE_FAILED });
    expect(w.ours.size).toBe(0);
    expect(w.io.update).not.toHaveBeenCalled();
  });

  it('carries on when the override write failed but landed', async () => {
    const w = world();
    const set = w.io.secrets.set;
    w.io.secrets.set = vi.fn(async (k: string, v: string) => { await set(k, v); throw new Error('response lost'); });
    expect((await filePaybackInApp(RESTAURANTS, w.io, NOW)).kind).toBe('filed');
  });

  it('never overwrites an overrides document that turned unreadable since it was read, and takes the rule back out', async () => {
    const w = world();
    let reads = 0;
    const get = w.io.secrets.get;
    w.io.secrets.get = async (k: string) => (k === SYNC_OVERRIDES_SECRET_KEY && ++reads > 1 ? '{oops' : get(k));
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: SYNC_OVERRIDES_UNREADABLE_MESSAGE });
    expect(w.io.secrets.set).not.toHaveBeenCalled();
    expect(w.ours.size).toBe(0);
  });

  it('takes the override and the rule back when Wealthfolio refuses the re-type: nothing changed', async () => {
    const w = world({ secrets: { [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(setTxOverride(emptySyncOverrides(), OTHER, 'notTransfer', NOW)) } });
    w.io.update = vi.fn(async () => { throw new Error(RAW); });
    const out = await filePaybackInApp(RESTAURANTS, w.io, NOW);
    expect(out).toEqual({ kind: 'refused', message: PAYBACK_UPDATE_REFUSED });
    expect(out.message).not.toContain(RAW);
    expect(hasTxOverride(w.overrides()!, KEY, 'asReimbursement')).toBe(false);
    expect(hasTxOverride(w.overrides()!, OTHER, 'notTransfer')).toBe(true);
    expect(w.ours.size).toBe(0);
    expect(w.io.rerunRules).not.toHaveBeenCalled();
    expect(w.io.record).not.toHaveBeenCalled();
  });

  it('says the setting stays, and logs it with no category so Undo can take it off, when the override cannot come back off', async () => {
    const w = world();
    w.io.update = vi.fn(async () => { throw new Error(RAW); });
    let sets = 0;
    const set = w.io.secrets.set;
    w.io.secrets.set = vi.fn(async (k: string, v: string) => { if (++sets > 1) throw new Error(RAW); return set(k, v); });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'partial', message: `${PAYBACK_APP_UPDATE_STUCK}\n${PAYBACK_APP_SETTING_HINT}` });
    expect(w.logged[0]).toMatchObject({ kind: 'payback-filed', after: { categoryId: null, categoryName: null } });
    expect(w.ours.size).toBe(0);
  });

  it("says it can't tell when the re-type failed and the row cannot be read again; the setting stays and is logged", async () => {
    const w = world();
    w.io.update = vi.fn(async () => { throw new Error(RAW); });
    let reads = 0;
    const read = w.io.read;
    w.io.read = vi.fn(async (id: string) => { if (++reads > 1) throw new Error(RAW); return read(id); });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'partial', message: `${PAYBACK_APP_UPDATE_UNSURE}\n${PAYBACK_APP_SETTING_HINT}` });
    expect(hasTxOverride(w.overrides()!, KEY, 'asReimbursement')).toBe(true);
    expect(w.logged[0].after).toMatchObject({ categoryId: null });
    expect(w.ours.size).toBe(0);
  });

  it('says the setting can only come off in the overrides list when that log is not written either', async () => {
    const w = world({ io: { record: vi.fn(async () => false) } });
    w.io.update = vi.fn(async () => { throw new Error(RAW); });
    let reads = 0;
    const read = w.io.read;
    w.io.read = vi.fn(async (id: string) => { if (++reads > 1) throw new Error(RAW); return read(id); });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'partial', message: `${PAYBACK_APP_UPDATE_UNSURE}\n${PAYBACK_NO_UNDO_SETTING}` });
  });

  it('carries on when the re-type landed but its answer was lost', async () => {
    const w = world();
    const update = w.io.update;
    w.io.update = vi.fn(async (write) => { await update(write); throw new Error('response lost'); });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'filed', message: `${FILED}\n${PAYBACK_APP_UNDO_HINT}` });
  });

  it('says the row is gone when it went while being re-typed, taking the setting and the rule back', async () => {
    const w = world();
    let gone = false;
    const read = w.io.read;
    w.io.update = vi.fn(async () => { gone = true; throw new Error(RAW); });
    w.io.read = vi.fn(async (id: string) => (gone ? null : read(id)));
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: PAYBACK_GONE });
    expect(hasTxOverride(w.overrides()!, KEY, 'asReimbursement')).toBe(false);
    expect(w.ours.size).toBe(0);
  });

  it('says the setting stays in the overrides list when the row is gone and it cannot come back off', async () => {
    const w = world();
    let gone = false;
    const read = w.io.read;
    w.io.update = vi.fn(async () => { gone = true; throw new Error(RAW); });
    w.io.read = vi.fn(async (id: string) => (gone ? null : read(id)));
    let sets = 0;
    const set = w.io.secrets.set;
    w.io.secrets.set = vi.fn(async (k: string, v: string) => { if (++sets > 1) throw new Error(RAW); return set(k, v); });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'partial', message: PAYBACK_GONE_STUCK });
  });

  it('names the one-off rule beside a refused re-type when it cannot be deleted', async () => {
    const w = world();
    w.io.update = vi.fn(async () => { throw new Error(RAW); });
    w.io.deleteRule = vi.fn(async () => { throw new Error(RAW); });
    expect(await filePaybackInApp(RESTAURANTS, w.io, NOW)).toEqual({ kind: 'refused', message: `${PAYBACK_UPDATE_REFUSED}\n${paybackLeftoverRule(RULE_NAME)}` });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npx vitest run --maxWorkers=2 shared/payback-app-file.test.ts`
Expected: FAIL — the file does not load: `Error: Failed to resolve import "./payback-app-file.js" from "shared/payback-app-file.test.ts". Does the file exist?` (Test Files 1 failed (1), Tests no tests).

- [ ] **Step 3: Implement**

**Create `shared/payback-app-file.ts`:**

```ts
/**
 * shared/payback-app-file.ts
 *
 * Filing a payback from the app (1.62.0, W11): the add-on's sibling of the
 * companion's `filePayback` (shared/payback.ts, which stays as it is). The
 * add-on SDK cannot file one row, so the category goes on through a one-off
 * rule (shared/payback-app.ts) — saved BEFORE the row is re-typed: the re-type
 * sets off Wealthfolio's own rule run in the background, and the one-off rule
 * must already be there to win it over an older rule for CREDITs (W10's
 * "Make every … deposit a payback" makes one at priority 50). While the row is
 * still a DEPOSIT the rule cannot match it (CREDIT only), so the run the rule
 * save sets off files nothing. In order:
 *
 *  1. the gate (`appPaybackGate`: Wealthfolio 3.9+, a companion of 1.62.0+);
 *  2. the row re-read by id and planned (`planPayback`), the category still
 *     listed, then Wealthfolio's facts for the row: tracked by Spending, in no
 *     transfer, filed nowhere (the SDK cannot take a filing off);
 *  3. one-off rules a failed run left behind are swept, then this row's is
 *     saved;
 *  4. the `asReimbursement` override, re-read right before it is written;
 *  5. the row re-typed (`paybackRetype`: the stored instant, a bare day at
 *     noon UTC);
 *  6. `rerunRules(true)`, uncategorized rows only — a failure is not final:
 *     the background runs may have filed it;
 *  7. the filing confirmed by reading the row's facts back;
 *  8. the one-off rule deleted, filed or not;
 *  9. `payback-filed` logged with the category Wealthfolio CONFIRMED (none
 *     when it did not), through the change log's strict append, so a log that
 *     was not written is said ("no Undo") — Telegram's Undo un-files exactly
 *     the logged category.
 *
 * What a failure leaves is said plainly, as `filePayback` says it; only the
 * overrides this run added are ever taken back; a rule that could not be
 * deleted is named. Wealthfolio's own error text goes to the log, never to the
 * message. Pure: src/utils/app-payback.ts lends the add-on's calls.
 */
import { SPENDING_TAXONOMY_ID } from './cash-flow-bucket.js';
import { paybackFiledChange, type ChangeDraft } from './change-entries.js';
import { planPayback, type PaybackPlan } from './payback.js';
import {
  leftoverPaybackKeys, paybackOnceRule, type ListedRule, type PaybackCategory, type PaybackOnceRule,
} from './payback-app.js';
import {
  PAYBACK_APP_SETTING_HINT, PAYBACK_APP_UNDO_HINT, PAYBACK_APP_UPDATE_STUCK, PAYBACK_APP_UPDATE_UNSURE, PAYBACK_CATEGORY_GONE, PAYBACK_CHANGED,
  PAYBACK_GONE, PAYBACK_GONE_STUCK, PAYBACK_LINKED, PAYBACK_MAPPING_UNREADABLE, PAYBACK_NO_UNDO, PAYBACK_NO_UNDO_SETTING, PAYBACK_NOT_IN_SPENDING,
  PAYBACK_OVERRIDE_FAILED, PAYBACK_RULE_REFUSED, PAYBACK_RUNNING, PAYBACK_UNREACHABLE, PAYBACK_UPDATE_REFUSED,
  paybackAlreadyFiled, paybackAppUnfiled, paybackAppUnsure, paybackDone, paybackFiledFirst, paybackLeftoverRule,
} from './payback-copy.js';
import { isPaybackRow, type PaybackRow } from './payback-row.js';
import type { SecretGet, SecretSet } from './subscription-prefs.js';
import type { ActivityWrite } from './sync-host.js';
import {
  clearTxOverride, editSyncOverrides, hasTxOverride, isUnreadableOverridesError, loadSyncOverrides, setTxOverride,
  SYNC_OVERRIDES_UNREADABLE_MESSAGE,
} from './sync-overrides.js';
import { removalFingerprint, RemoveMappingUnreadableError } from './tx-remove.js';
import { filingOfFact, linkedOfFact, type CashFact } from './wf-facts.js';

/** What the add-on lends `filePaybackInApp`. */
export interface AppPaybackIo {
  /** Why the app may not file a payback now (`appPaybackGate`), or null. */
  gate(): Promise<string | null>;
  /** The row by exact id, now; null when gone. Rejects when unreachable. */
  read(activityId: string): Promise<PaybackRow | null>;
  /** The SimpleFin accounts that sync into this Wealthfolio account. Rejects
   *  when the mapping cannot be read (`RemoveMappingUnreadableError` when it
   *  was read and is not a mapping). */
  feeds(wfAccountId: string): Promise<string[]>;
  secrets: { get: SecretGet; set: SecretSet };
  /** Wealthfolio's facts for the row (`searchCashActivities`); null when it
   *  lists none (an account its Spending does not track). Rejects when they
   *  cannot be read. */
  fact(row: PaybackRow): Promise<CashFact | null>;
  /** Every category, all kinds (`paybackCategoriesOf`). Rejects when unreadable. */
  categories(): Promise<PaybackCategory[]>;
  /** This add-on's own categorization rules (`getRules`). Rejects when unreadable. */
  rules(): Promise<ListedRule[]>;
  /** Saves a rule by its key (an upsert). Rejects when Wealthfolio refuses it. */
  saveRule(rule: PaybackOnceRule): Promise<void>;
  /** Deletes the rule with this key; nothing when it is absent. Rejects when Wealthfolio refuses. */
  deleteRule(ruleKey: string): Promise<void>;
  /** One update through the bulk endpoint. Rejects when Wealthfolio refuses it. */
  update(write: ActivityWrite): Promise<void>;
  /** Wealthfolio's rule run over the rows with no category (`rerunRules(true)`). */
  rerunRules(): Promise<void>;
  /** Appends to the change log: whether THIS entry was written. */
  record(draft: ChangeDraft): Promise<boolean>;
  log(msg: string): void;
}

/** The click: the row, and the spending category chosen. */
export interface AppPaybackChoice {
  activityId: string;
  categoryId: string;
  /** `removalFingerprint` of the row as the story showed it. Absent (the
   *  needs-a-category list has no note to show): no check. */
  shown?: string;
}

/** `filed`: it is a payback, filed under a category (the message says which).
 *  `partial`: something changed, not all of it — the message says what stands.
 *  `refused`: nothing was written to the row. */
export type AppPaybackOutcome =
  | { kind: 'filed'; message: string }
  | { kind: 'partial'; message: string }
  | { kind: 'refused'; message: string };

/** Activity ids being filed right now: a second click on the same row writes nothing. */
const inFlight = new Set<string>();
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const fingerprintOf = (r: PaybackRow): string => removalFingerprint({
  activityId: r.id, note: r.notes, absCents: r.absCents, date: r.date, activityType: r.type, accountName: r.accountName,
});
const lines = (...parts: Array<string | null>): string => parts.filter((p): p is string => !!p).join('\n');

/** File one deposit as a payback from the app. Never rejects. */
export async function filePaybackInApp(choice: AppPaybackChoice, io: AppPaybackIo, now: Date): Promise<AppPaybackOutcome> {
  if (inFlight.has(choice.activityId)) return { kind: 'refused', message: PAYBACK_RUNNING };
  inFlight.add(choice.activityId);
  try {
    return await fileOnce(choice, io, now);
  } finally {
    inFlight.delete(choice.activityId);
  }
}

async function fileOnce(choice: AppPaybackChoice, io: AppPaybackIo, now: Date): Promise<AppPaybackOutcome> {
  const refused = (message: string): AppPaybackOutcome => ({ kind: 'refused', message });
  const say = (msg: string) => io.log(`Payback ${choice.activityId}: ${msg}`);

  // 1. The gate.
  let gate: string | null;
  try {
    gate = await io.gate();
  } catch (err) {
    say(`the gate could not be read: ${errorText(err)}`);
    return refused(PAYBACK_UNREACHABLE);
  }
  if (gate) return refused(gate);

  // 2. The row, re-read and planned; the category; Wealthfolio's facts.
  let row: PaybackRow | null;
  let plan: PaybackPlan;
  let categories: PaybackCategory[] = [];
  let chosen: PaybackCategory | undefined;
  let fact: CashFact | null = null;
  try {
    row = await io.read(choice.activityId);
    if (row && choice.shown !== undefined && choice.shown !== fingerprintOf(row)) return refused(PAYBACK_CHANGED);
    const feeds = row ? await io.feeds(row.accountId) : [];
    const overrides = await loadSyncOverrides(io.secrets.get);
    categories = await io.categories();
    chosen = categories.find((c) => c.id === choice.categoryId && c.kind === 'expense');
    plan = planPayback({ row, feeds, overrides, category: { id: choice.categoryId, name: chosen?.name ?? '' } });
    if (plan.ok && chosen) fact = await io.fact(row!);
  } catch (err) {
    say(errorText(err));
    return refused(err instanceof RemoveMappingUnreadableError ? PAYBACK_MAPPING_UNREADABLE : PAYBACK_UNREACHABLE);
  }
  if (!plan.ok) return refused(plan.reason);
  if (!chosen) return refused(PAYBACK_CATEGORY_GONE);
  if (!fact) return refused(PAYBACK_NOT_IN_SPENDING);
  if (linkedOfFact(fact)) return refused(PAYBACK_LINKED);
  const nameOf = (id: string): string | null => categories.find((c) => c.id === id)?.name ?? null;
  const filing = filingOfFact(fact);
  if (filing) return refused(paybackAlreadyFiled(nameOf(filing.categoryId) ?? 'another category'));
  const r = row!;
  const w = plan.writes;
  // planPayback refused a row whose note carries no tx id.
  const once = paybackOnceRule(r, chosen.id)!;

  const dropRule = async (): Promise<boolean> => {
    try {
      await io.deleteRule(once.ruleKey);
      return true;
    } catch (err) {
      say(`the one-off rule ${once.ruleKey} could not be deleted: ${errorText(err)}`);
      return false;
    }
  };
  const left = (gone: boolean): string | null => (gone ? null : paybackLeftoverRule(once.name));
  const record = async (draft: ChangeDraft): Promise<boolean> => {
    try {
      return await io.record(draft);
    } catch (err) {
      say(`the change log was not written: ${errorText(err)}`);
      return false;
    }
  };
  // The payback setting stays on a row that may not be a payback: logged with no category, so Telegram's Undo takes it off.
  const unconfirmed = async (message: string, gone: boolean): Promise<AppPaybackOutcome> => {
    const saved = await record(paybackFiledChange({ ...w.entry, categoryId: null, categoryName: null }));
    return { kind: 'partial', message: lines(message, saved ? PAYBACK_APP_SETTING_HINT : PAYBACK_NO_UNDO_SETTING, left(gone)) };
  };

  // 3. One-off rules a failed run left behind, then this row's — before the re-type.
  try {
    for (const key of leftoverPaybackKeys(await io.rules())) {
      try {
        await io.deleteRule(key);
        say(`deleted the one-off rule ${key}, left behind by an earlier payback`);
      } catch (err) {
        say(`the one-off rule ${key}, left behind by an earlier payback, could not be deleted: ${errorText(err)}`);
      }
    }
  } catch (err) {
    say(`the add-on's rules could not be read for left-behind one-off rules: ${errorText(err)}`);
  }
  try {
    await io.saveRule(once);
  } catch (err) {
    say(`Wealthfolio refused the one-off rule: ${errorText(err)}`);
    // It may have landed before its answer was lost.
    return refused(lines(PAYBACK_RULE_REFUSED, left(await dropRule())));
  }

  // 4. The override, re-read right before it is written. Only what this run adds is ever taken back.
  let added: string[] = [];
  try {
    await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => {
      added = w.txKeys.filter((k) => !hasTxOverride(o, k, 'asReimbursement'));
      return w.txKeys.reduce((d, k) => setTxOverride(d, k, 'asReimbursement', now, { label: w.label }), o);
    }, now);
  } catch (err) {
    say(`the override was not saved: ${errorText(err)}`);
    const unreadable = isUnreadableOverridesError(err);
    // The write can fail after it landed (a lost response): read it again.
    let landed = false;
    if (!unreadable) {
      try {
        const again = await loadSyncOverrides(io.secrets.get);
        landed = !again.unreadable && w.txKeys.every((k) => hasTxOverride(again.overrides, k, 'asReimbursement'));
      } catch (readErr) {
        say(`could not read the overrides again: ${errorText(readErr)}`);
      }
    }
    if (!landed) return refused(lines(unreadable ? SYNC_OVERRIDES_UNREADABLE_MESSAGE : PAYBACK_OVERRIDE_FAILED, left(await dropRule())));
  }

  // 5. The re-type. A refused update is read again: its answer can be lost after it landed.
  try {
    await io.update(w.update);
  } catch (err) {
    say(`the update failed: ${errorText(err)}`);
    let again: PaybackRow | null;
    try {
      again = await io.read(choice.activityId);
    } catch (readErr) {
      say(`could not tell whether the update landed: ${errorText(readErr)}`);
      return unconfirmed(PAYBACK_APP_UPDATE_UNSURE, await dropRule());
    }
    if (!again || !isPaybackRow(again)) {
      const gone = await dropRule();
      try {
        if (added.length > 0) {
          await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => added.reduce((d, k) => clearTxOverride(d, k, 'asReimbursement'), o), now);
        }
      } catch (undoErr) {
        say(`taking the override back failed: ${errorText(undoErr)}`);
        if (!again) return { kind: 'partial', message: lines(PAYBACK_GONE_STUCK, left(gone)) };
        return unconfirmed(PAYBACK_APP_UPDATE_STUCK, gone);
      }
      return refused(lines(again ? PAYBACK_UPDATE_REFUSED : PAYBACK_GONE, left(gone)));
    }
  }

  // 6. Wealthfolio's rule run, now. A failure is not final: the background runs may have filed it.
  try {
    await io.rerunRules();
  } catch (err) {
    say(`the rule run failed: ${errorText(err)}`);
  }

  // 7. What Wealthfolio filed it under, read back. Undefined: couldn't tell.
  let filedAs: string | null | undefined;
  try {
    const after = await io.fact(r);
    if (!after) say('Wealthfolio did not list it after the re-type');
    filedAs = after ? (after.filings.find((f) => f.taxonomyId === SPENDING_TAXONOMY_ID)?.categoryId ?? null) : undefined;
  } catch (err) {
    say(`could not read back what it is filed under: ${errorText(err)}`);
    filedAs = undefined;
  }

  // 8. The one-off rule comes out, filed or not.
  const gone = await dropRule();

  // 9. The change log: the category Wealthfolio confirmed, else none.
  const confirmed = filedAs ?? null;
  const saved = await record(paybackFiledChange({ ...w.entry, categoryId: confirmed, categoryName: confirmed ? nameOf(confirmed) : null }));
  const tail = saved ? PAYBACK_APP_UNDO_HINT : PAYBACK_NO_UNDO;
  if (filedAs === chosen.id) {
    return { kind: 'filed', message: lines(paybackDone(chosen.name, chosen.parentName ?? chosen.name, r.absCents), tail, left(gone)) };
  }
  if (filedAs) return { kind: 'filed', message: lines(paybackFiledFirst(nameOf(filedAs) ?? 'another category'), tail, left(gone)) };
  return { kind: 'partial', message: lines(filedAs === null ? paybackAppUnfiled(chosen.name) : paybackAppUnsure(chosen.name), tail, left(gone)) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npx vitest run --maxWorkers=2 shared/payback-app-file.test.ts`
Expected: PASS — 48 tests (1 file).

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/payback-app-file.ts shared/payback-app-file.test.ts
git commit -m "Paybacks in the app: the runner — the one-off rule before the re-type, the filing read back, a strict log (W11)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: The add-on's half: the rule permissions, a strict log, the SDK adapter

What `filePaybackInApp` reads and writes through the add-on SDK, behind the add-on's write lock; the manifest's `spending` permissions the rule calls need (a call the manifest does not declare throws `AddonPermissionDenied`); and the store's strict append, so the reply can say "no Undo" honestly. `appPaybacksOffered` judges the companion first, so nothing is probed without one.

**Files:**
- Create: `src/utils/app-payback.ts`
- Modify: `manifest.json`, `src/utils/secrets.ts`
- Test: `src/utils/app-payback.test.ts`

**Interfaces:**
- Consumes: Task 1's `appPaybackGate`, `paybackCategoriesOf`, `paybackPickList`; Task 2's `filePaybackInApp`, `AppPaybackIo`, `AppPaybackChoice`, `AppPaybackOutcome`; `hostCan` (src/utils/host-can.ts), `readCashFacts` (src/utils/wf-facts.ts), `AddonSyncHost` (src/utils/addon-host.ts), `beginWrite`/`writeRefusal` (src/utils/write-lock.ts), `parseAccountMapping` (shared/tx-remove.ts), `ACCOUNT_MAPPING_SECRET_KEY` (shared/change-undo-run.ts).
- Produces:

```ts
// src/utils/secrets.ts
SecretsStore.recordChangeStrict(draft: ChangeDraft): Promise<boolean>; // never rejects
// src/utils/app-payback.ts
export type PaybackStore = Partial<Pick<SecretsStore, 'getCompanionVersion' | 'recordChangeStrict'>>;
export function appPaybacksOffered(ctx: AddonContext, companionVersion: string | null): Promise<boolean>;
export function readPaybackCategories(ctx: AddonContext): Promise<PaybackCategory[]>;
export function addonPaybackIo(ctx: AddonContext, store: PaybackStore, log?: (msg: string) => void): AppPaybackIo;
export function paybackFromApp(ctx: AddonContext, store: PaybackStore, choice: AppPaybackChoice): Promise<AppPaybackOutcome>;
```

- [ ] **Step 1: Write the failing tests**

**Create `src/utils/app-payback.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PERMISSION_CATEGORIES } from '@wealthfolio/addon-sdk';
import { paybackFiledChange } from '../../shared/change-entries';
import { paybackOnceKey } from '../../shared/payback-app';
import {
  PAYBACK_APP_UNDO_HINT, PAYBACK_COMPANION_UNKNOWN, PAYBACK_NO_UNDO, PAYBACK_UNAVAILABLE, PAYBACK_UPDATE_COMPANION,
} from '../../shared/payback-copy';
import { SYNC_OVERRIDES_SECRET_KEY } from '../../shared/sync-overrides';
import { addonPaybackIo, appPaybacksOffered, paybackFromApp, readPaybackCategories } from './app-payback';
import { SecretsStore } from './secrets';
import { beginSync, beginWrite, REMOVE_SYNC_RUNNING } from './write-lock';

const DETAILS = {
  id: 'act-7', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'DEPOSIT', date: '2026-10-09T12:00:00Z',
  amount: '14', currency: 'USD', comment: 'VENMO CASHOUT · TRN-77', subtype: null,
};
const CATEGORIES = [
  { kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-rest', key: 'restaurants', name: 'Restaurants', path: 'Food & Dining / Restaurants' },
  { kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-book', key: 'book', name: 'Sync bookkeeping', path: 'Sync bookkeeping' },
  { kind: 'income', taxonomyId: 'income_categories', categoryId: 'cat-gift', key: 'gifts', name: 'Gifts', path: 'Gifts' },
];
const ONCE = paybackOnceKey('wf-chk', 'TRN-77');
const UNKNOWN_38 = "Unknown addon host API method 'spending.searchCashActivities'";

/**
 * Wealthfolio through the add-on SDK, in memory: one cash deposit, the
 * add-on's secrets and its rules. A rule save, a re-type and `rerunRules`
 * each run the rules over a row with no category, as Wealthfolio does.
 * `v38`: the host refuses the 3.9 calls.
 */
function wealthfolio(opts: { v38?: boolean; companion?: string | null; failChangeLog?: boolean } = {}) {
  let row: Record<string, unknown> = { ...DETAILS };
  let filing: { taxonomyId: string; categoryId: string; source: string } | null = null;
  const rules = new Map<string, { ruleKey: string; name: string; pattern: string; accountId: string; activityType: string; priority: number; categoryId: string }>();
  const secrets = new Map<string, string>([['account_mapping', JSON.stringify({ 'sfin-chk': 'wf-chk' })]]);
  if (opts.companion !== null) secrets.set('companion_version', opts.companion ?? '1.62.0');
  const run = () => {
    if (filing) return;
    const hit = [...rules.values()].sort((a, b) => b.priority - a.priority)
      .find((r) => r.accountId === row.accountId && r.activityType === row.activityType && r.pattern.toUpperCase() === String(row.comment).toUpperCase());
    if (hit) filing = { taxonomyId: 'spending_categories', categoryId: hit.categoryId, source: 'rule' };
  };
  const api = {
    accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', name: 'PNC Checking', accountType: 'CASH' }]) },
    activities: {
      search: vi.fn(async (_page: number, _size: number, filters: { activityIds?: string[] }) => ({
        data: filters?.activityIds?.includes(String(row.id)) ? [{ ...row }] : [], meta: { totalRowCount: 1 },
      })),
      saveMany: vi.fn(async (req: { updates?: Array<Record<string, unknown>> }) => {
        for (const u of req.updates ?? []) row = { ...row, activityType: u.activityType, subtype: u.subtype, date: u.activityDate };
        run();
        return { created: [], updated: req.updates ?? [], errors: [] };
      }),
    },
    spending: {
      searchCashActivities: vi.fn(async (q: { accountIds?: string[] }) => {
        if (opts.v38) throw new Error(UNKNOWN_38);
        const items = q.accountIds?.includes(String(row.accountId))
          ? [{ id: row.id, accountId: row.accountId, activityType: row.activityType, activityDate: row.date, transferLinkStatus: null, sourceGroupId: null, cashFlowBucket: 'income', assignments: filing ? [filing] : [] }]
          : [];
        return { items, totalCount: items.length };
      }),
      getCategories: vi.fn(async (kind?: string) => CATEGORIES.filter((c) => !kind || c.kind === kind)),
      getRules: vi.fn(async () => [...rules.values()].map(({ ruleKey: _key, ...r }) => ({ id: 'rule-1', matchType: 'exact', kind: 'expense', createdAt: '', updatedAt: '', ...r }))),
      saveRule: vi.fn(async (r: { ruleKey: string; name: string; pattern: string; accountId: string; activityType: string; priority: number; categoryId: string }) => { rules.set(r.ruleKey, r); run(); return r; }),
      deleteRule: vi.fn(async (key: string) => { rules.delete(key); }),
      rerunRules: vi.fn(async () => { run(); return 1; }),
    },
    secrets: {
      get: vi.fn(async (k: string) => secrets.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        if (opts.failChangeLog && k.startsWith('change_log')) throw new Error('quota');
        secrets.set(k, v);
      }),
      delete: vi.fn(async (k: string) => { secrets.delete(k); }),
    },
  };
  const ctx = { api } as any;
  return { ctx, api, secrets, rules, store: new SecretsStore(ctx), filing: () => filing, row: () => row };
}

describe('a payback from the app, through the add-on SDK', () => {
  it('files it: the one-off rule, the override, the re-type, the rule run, the filing read back, the rule deleted, the entry logged', async () => {
    const w = wealthfolio();
    expect(await paybackFromApp(w.ctx, w.store, { activityId: 'act-7', categoryId: 'cat-rest' })).toEqual({
      kind: 'filed',
      message: `Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending.\n${PAYBACK_APP_UNDO_HINT}`,
    });
    expect(w.api.spending.saveRule).toHaveBeenCalledWith(expect.objectContaining({ ruleKey: ONCE, matchType: 'exact', activityType: 'CREDIT', accountId: 'wf-chk', priority: 1_000_000 }));
    expect(w.api.activities.saveMany).toHaveBeenCalledWith({ updates: [expect.objectContaining({ id: 'act-7', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' })] });
    expect(w.api.spending.rerunRules).toHaveBeenCalledWith(true);
    expect(w.api.spending.deleteRule).toHaveBeenCalledWith(ONCE);
    expect(w.rules.size).toBe(0);
    expect(w.filing()).toEqual({ taxonomyId: 'spending_categories', categoryId: 'cat-rest', source: 'rule' });
    expect(w.secrets.get(SYNC_OVERRIDES_SECRET_KEY)).toContain('asReimbursement');
    const log = await w.store.getChangeLog();
    expect(log?.entries[0]).toMatchObject({ kind: 'payback-filed', writer: 'addon', after: { categoryId: 'cat-rest' } });
  });

  it('sweeps a one-off rule a failed run left behind, rebuilding its key from what getRules lists', async () => {
    const w = wealthfolio();
    const left = paybackOnceKey('wf-chk', 'TRN-9');
    w.rules.set(left, { ruleKey: left, name: 'Payback (one-off) — ZELLE', pattern: 'ZELLE · TRN-9', accountId: 'wf-chk', activityType: 'CREDIT', priority: 1_000_000, categoryId: 'cat-rest' });
    await paybackFromApp(w.ctx, w.store, { activityId: 'act-7', categoryId: 'cat-rest' });
    expect(w.api.spending.deleteRule).toHaveBeenCalledWith(left);
    expect(w.rules.size).toBe(0);
  });

  it('says there is no Undo when the change log cannot be written', async () => {
    const w = wealthfolio({ failChangeLog: true });
    const out = await paybackFromApp(w.ctx, w.store, { activityId: 'act-7', categoryId: 'cat-rest' });
    expect(out.kind).toBe('filed');
    expect(out.message.split('\n')[1]).toBe(PAYBACK_NO_UNDO);
  });

  it('is refused while a sync holds the write lock, and touches nothing', async () => {
    const w = wealthfolio();
    const end = await beginSync();
    try {
      expect(await paybackFromApp(w.ctx, w.store, { activityId: 'act-7', categoryId: 'cat-rest' })).toEqual({ kind: 'refused', message: REMOVE_SYNC_RUNNING });
    } finally {
      end();
    }
    expect(w.api.spending.saveRule).not.toHaveBeenCalled();
    expect(w.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it('lets the lock go when it is done', async () => {
    const w = wealthfolio({ companion: '1.61.0' });
    await paybackFromApp(w.ctx, w.store, { activityId: 'act-7', categoryId: 'cat-rest' });
    const release = beginWrite();
    expect(release).not.toBeNull();
    release?.();
  });
});

describe('the gate, read through the SDK', () => {
  it.each<[string, Parameters<typeof wealthfolio>[0], string | null]>([
    ['a 3.9 host and a 1.62 companion', {}, null],
    ['no companion', { companion: null }, PAYBACK_UNAVAILABLE],
    ['a 1.61 companion', { companion: '1.61.0' }, PAYBACK_UPDATE_COMPANION],
    ['a 3.8 host', { v38: true }, PAYBACK_UNAVAILABLE],
  ])('%s', async (_name, opts, expected) => {
    const w = wealthfolio(opts);
    expect(await addonPaybackIo(w.ctx, w.store, () => {}).gate()).toBe(expected);
  });

  it("refuses when the companion's version cannot be read", async () => {
    const w = wealthfolio();
    const logs: string[] = [];
    const io = addonPaybackIo(w.ctx, { getCompanionVersion: vi.fn(async () => { throw new Error('secrets offline'); }) }, (m) => logs.push(m));
    expect(await io.gate()).toBe(PAYBACK_COMPANION_UNKNOWN);
    expect(logs.join('\n')).toContain('secrets offline');
  });

  it('a 1.61 companion is refused before anything is read or written', async () => {
    const w = wealthfolio({ companion: '1.61.0' });
    expect(await paybackFromApp(w.ctx, w.store, { activityId: 'act-7', categoryId: 'cat-rest' })).toEqual({ kind: 'refused', message: PAYBACK_UPDATE_COMPANION });
    expect(w.api.activities.search).not.toHaveBeenCalled();
    expect(w.api.spending.saveRule).not.toHaveBeenCalled();
  });
});

describe('whether the app offers "It\'s a payback…"', () => {
  it('only on a 3.9+ host with a companion of 1.62.0 or newer', async () => {
    const w = wealthfolio();
    expect(await appPaybacksOffered(w.ctx, '1.62.0')).toBe(true);
    expect(await appPaybacksOffered(wealthfolio({ v38: true }).ctx, '1.62.0')).toBe(false);
  });

  it.each<[string, string | null]>([['no companion', null], ['a 1.61 companion', '1.61.0']])('not with %s, and without asking the host', async (_name, version) => {
    const w = wealthfolio();
    expect(await appPaybacksOffered(w.ctx, version)).toBe(false);
    expect(w.api.spending.searchCashActivities).not.toHaveBeenCalled();
  });
});

describe('the reads a payback makes', () => {
  it('offers the spending categories by path, without the bookkeeping one', async () => {
    const w = wealthfolio();
    expect((await readPaybackCategories(w.ctx)).map((c) => c.path)).toEqual(['Food & Dining / Restaurants']);
    expect(w.api.spending.getCategories).toHaveBeenCalledWith('expense');
  });

  it("reads the row with its stored instant, and Wealthfolio's facts for it", async () => {
    const w = wealthfolio();
    const io = addonPaybackIo(w.ctx, w.store, () => {});
    const row = await io.read('act-7');
    expect(row).toMatchObject({ id: 'act-7', accountType: 'CASH', type: 'DEPOSIT', instant: '2026-10-09T12:00:00Z', absCents: 1400 });
    expect(await io.fact(row!)).toMatchObject({ activityId: 'act-7', filings: [] });
    expect(await io.read('act-missing')).toBeNull();
    expect(await io.feeds('wf-chk')).toEqual(['sfin-chk']);
  });

  it('says the facts could not be read rather than "not in Spending"', async () => {
    const w = wealthfolio();
    const io = addonPaybackIo(w.ctx, w.store, () => {});
    const row = (await io.read('act-7'))!;
    await io.gate();
    w.api.spending.searchCashActivities.mockRejectedValueOnce(new Error('Failed to fetch'));
    await expect(io.fact(row)).rejects.toThrow("Wealthfolio's facts could not be read");
  });

  it('a re-type Wealthfolio answers with errors is a refusal', async () => {
    const w = wealthfolio();
    w.api.activities.saveMany.mockResolvedValueOnce({ created: [], updated: [], errors: [{ action: 'update', message: 'nope' }] } as any);
    await expect(addonPaybackIo(w.ctx, w.store, () => {}).update({ id: 'act-7', accountId: 'wf-chk', activityType: 'CREDIT', activityDate: '2026-10-09T12:00:00Z', currency: 'USD', comment: 'x' })).rejects.toThrow('nope');
  });
});

describe('the store says whether a change-log entry was written', () => {
  const draft = paybackFiledChange({
    account: { sfinId: 'sfin-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKeys: ['k'], activityId: 'act-7', description: 'VENMO CASHOUT',
    amountCents: 1400, date: '2026-10-09', subtypeBefore: null, categoryId: 'cat-rest', categoryName: 'Restaurants',
  });

  it('true when it was', async () => {
    expect(await wealthfolio().store.recordChangeStrict(draft)).toBe(true);
  });

  it('false when it was not, without throwing', async () => {
    expect(await wealthfolio({ failChangeLog: true }).store.recordChangeStrict(draft)).toBe(false);
  });
});

describe('manifest.json declares the rule calls a payback makes', () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, '../../manifest.json'), 'utf8')) as {
    permissions: Array<{ category: string; functions: Array<string | { name: string }>; purpose: string }>;
  };
  const spending = manifest.permissions.find((p) => p.category === 'spending')!;
  const names = spending.functions.map((f) => (typeof f === 'string' ? f : f.name));

  it('getRules, saveRule, deleteRule and rerunRules, in the spending category, which the SDK lists', () => {
    expect(names).toEqual(expect.arrayContaining(['getCategories', 'getRules', 'saveRule', 'deleteRule', 'rerunRules']));
    const known = new Set(PERMISSION_CATEGORIES.find((c) => c.id === 'spending')!.functions);
    expect(names.filter((n) => !known.has(n))).toEqual([]);
  });

  it('says what they are for', () => {
    expect(spending.purpose).toContain('payback');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npx vitest run --maxWorkers=2 src/utils/app-payback.test.ts`
Expected: FAIL — the file does not load: `Error: Failed to resolve import "./app-payback" from "src/utils/app-payback.test.ts". Does the file exist?` (Test Files 1 failed (1), Tests no tests).

- [ ] **Step 3: Implement**

Edit 1 of 1 in `manifest.json` — replace:

```json
      "category": "spending",
      "functions": [
        "getCategories"
      ],
      "purpose": "Read your spending categories' names, to show what a transaction is filed under"
    },
    {
```

with:

```json
      "category": "spending",
      "functions": [
        "getCategories",
        "getRules",
        "saveRule",
        "deleteRule",
        "rerunRules"
      ],
      "purpose": "Read your spending categories' names, to show what a transaction is filed under. On Wealthfolio 3.9 and newer: file a deposit you mark as a payback under the spending it pays back, through a one-off filing rule the add-on makes, runs and deletes"
    },
    {
```

Edit 1 of 1 in `src/utils/secrets.ts` — replace:

```ts
  async recordChange(draft: ChangeDraft): Promise<void> {
    await this.recordChanges([stampChange(draft, 'addon', new Date())]);
  }

```

with:

```ts
  async recordChange(draft: ChangeDraft): Promise<void> {
    await this.recordChanges([stampChange(draft, 'addon', new Date())]);
  }

  /** As `recordChange`, but says whether THIS entry was written (the same
   *  queue, the same gap record on a failure): for a caller that must not
   *  promise an Undo it cannot give (W11's payback). Never rejects. */
  async recordChangeStrict(draft: ChangeDraft): Promise<boolean> {
    const { saved } = await this.changeLog.appendStrict(this.changeLogIo(), [stampChange(draft, 'addon', new Date())]);
    return saved;
  }

```

**Create `src/utils/app-payback.ts`:**

```ts
/**
 * src/utils/app-payback.ts
 *
 * The add-on's half of a payback (1.62.0, W11): what `filePaybackInApp`
 * (shared/payback-app-file.ts) reads and writes through the add-on SDK.
 *  - The row is re-read by exact id (Wealthfolio 3.8's `activityIds` filter,
 *    the read the story makes), with its account's type and stored instant.
 *  - Wealthfolio's facts come from `searchCashActivities`
 *    (src/utils/wf-facts.ts), behind `hostCan`.
 *  - The one-off rule goes through `spending.getRules`, `saveRule`,
 *    `deleteRule` and `rerunRules(true)` (manifest: `spending`; Wealthfolio
 *    offers them since 3.8, so `hostCan`'s 3.9 probe is what gates them).
 *  - The re-type goes through `AddonSyncHost.saveMany`; the entry through the
 *    store's strict append.
 * A payback holds the add-on's write lock, as Remove for good does. Every
 * call is made as a method on `ctx.api` (the sandbox's Proxy treats `.call`
 * as one more path).
 */
import type { ActivitySearchFilters, AddonContext } from '@wealthfolio/addon-sdk';
import { ACCOUNT_MAPPING_SECRET_KEY } from '../../shared/change-undo-run';
import { paybackRowOf } from '../../shared/payback';
import { appPaybackGate, paybackCategoriesOf, paybackPickList, type PaybackCategory } from '../../shared/payback-app';
import { filePaybackInApp, type AppPaybackChoice, type AppPaybackIo, type AppPaybackOutcome } from '../../shared/payback-app-file';
import { PAYBACK_COMPANION_UNKNOWN } from '../../shared/payback-copy';
import type { PaybackRow } from '../../shared/payback-row';
import { parseAccountMapping } from '../../shared/tx-remove';
import { sfinIdsFor } from '../../shared/tx-story';
import { AddonSyncHost } from './addon-host';
import { hostCan } from './host-can';
import type { SecretsStore } from './secrets';
import { readCashFacts } from './wf-facts';
import { beginWrite, writeRefusal } from './write-lock';

/** The store methods a payback uses, each optional-called. */
export type PaybackStore = Partial<Pick<SecretsStore, 'getCompanionVersion' | 'recordChangeStrict'>>;

const warn = (msg: string) => console.warn(`[simplefin-sync] ${msg}`);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Whether the app offers "It's a payback…" at all: a companion of 1.62.0 or
 *  newer, and a Wealthfolio that offers its facts (3.9+). The companion is
 *  judged first, so nothing is probed without one. Never rejects. */
export async function appPaybacksOffered(ctx: AddonContext, companionVersion: string | null): Promise<boolean> {
  if (appPaybackGate({ hostOffersFacts: true, companionVersion }) !== null) return false;
  return appPaybackGate({ hostOffersFacts: await hostCan(ctx, 'spending.searchCashActivities'), companionVersion }) === null;
}

/** The categories the picker offers (`paybackPickList`). Rejects when they cannot be read. */
export async function readPaybackCategories(ctx: AddonContext): Promise<PaybackCategory[]> {
  return paybackPickList(paybackCategoriesOf(await ctx.api.spending.getCategories('expense')));
}

/** One row by exact id, as a payback reads it; null when it is gone. Rejects when unreachable. */
async function readPaybackRow(ctx: AddonContext, activityId: string): Promise<PaybackRow | null> {
  const types = new Map((await ctx.api.accounts.getAll()).map((a) => [a.id, String(a.accountType ?? '')]));
  const filters = { activityIds: [activityId] } as ActivitySearchFilters;
  const res = await ctx.api.activities.search(0, 1, filters, '');
  const hit = (res.data ?? []).find((a) => a.id === activityId);
  return hit ? paybackRowOf(hit, types.get(hit.accountId) ?? '') : null;
}

export function addonPaybackIo(ctx: AddonContext, store: PaybackStore, log: (msg: string) => void = warn): AppPaybackIo {
  const host = new AddonSyncHost(ctx, { log });
  return {
    gate: async () => {
      let companionVersion: string | null;
      try {
        companionVersion = (await store.getCompanionVersion?.()) ?? null;
      } catch (err) {
        log(`Payback: could not read the companion's version: ${errorText(err)}`);
        return PAYBACK_COMPANION_UNKNOWN;
      }
      return appPaybackGate({ hostOffersFacts: await hostCan(ctx, 'spending.searchCashActivities'), companionVersion });
    },
    read: (activityId) => readPaybackRow(ctx, activityId),
    feeds: async (wfAccountId) => sfinIdsFor(parseAccountMapping(await ctx.api.secrets.get(ACCOUNT_MAPPING_SECRET_KEY)), wfAccountId),
    secrets: {
      get: (k) => ctx.api.secrets.get(k),
      set: (k, v) => ctx.api.secrets.set(k, v),
    },
    fact: async (row) => {
      const facts = await readCashFacts(ctx, [{ id: row.id, accountId: row.accountId, date: row.instant }]);
      if (!facts) throw new Error("Wealthfolio's facts could not be read");
      return facts.get(row.id) ?? null;
    },
    categories: async () => paybackCategoriesOf(await ctx.api.spending.getCategories()),
    rules: async () => (await ctx.api.spending.getRules()) ?? [],
    saveRule: async (rule) => {
      await ctx.api.spending.saveRule(rule);
    },
    deleteRule: async (ruleKey) => {
      await ctx.api.spending.deleteRule(ruleKey);
    },
    update: async (write) => {
      const res = await host.saveMany({ updates: [write] });
      if (res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join('; '));
    },
    rerunRules: async () => {
      await ctx.api.spending.rerunRules(true);
    },
    record: async (draft) => (store.recordChangeStrict ? store.recordChangeStrict(draft) : false),
    log,
  };
}

/** "It's a payback…" from the app. Holds the add-on's write lock
 *  (src/utils/write-lock.ts), like Remove for good: refused while a sync is
 *  running, and a sync that starts meanwhile waits. Never rejects. */
export async function paybackFromApp(ctx: AddonContext, store: PaybackStore, choice: AppPaybackChoice): Promise<AppPaybackOutcome> {
  const release = beginWrite();
  if (!release) return { kind: 'refused', message: writeRefusal('remove') };
  try {
    return await filePaybackInApp(choice, addonPaybackIo(ctx, store), new Date());
  } finally {
    release();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npx vitest run --maxWorkers=2 src/utils/app-payback.test.ts src/utils/host-can.test.ts`
Expected: PASS — 32 tests (2 files: the 22 new ones, and host-can's 10 — its manifest checks still pass with the four new functions).

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add manifest.json src/utils/secrets.ts src/utils/app-payback.ts src/utils/app-payback.test.ts
git commit -m "Paybacks in the app: the rule permissions, a strict change-log append, and the SDK adapter (W11)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: The companion marks payback rows; a story knows a payback

Ruling 3: the companion publishes `paybackEligible: true` on a needs-a-category row that is a posted DEPOSIT on a cash account — exactly Telegram's switch — from the type and pending flag it already reads. Ruling 6 with the integration review's Minor 2: `resolveFiler` (shared, so Telegram's `/why` too) tells a `payback-filed` entry for this row and category as `{ kind: 'you', at, payback: true }` — "Filed under Restaurants by you, as a payback, Oct 14." — before it looks at the source (the app's filing is a rule's), and a payback's money line says "A payback: it lowers your spending." (both hosts now pass the row's subtype). The app's story offers the action (`payback`, with the fingerprint the runner checks) on a row Wealthfolio says is filed nowhere.

**Files:**
- Modify: `shared/uncategorized.ts`, `companion/src/uncategorized-status.ts`, `shared/tx-story.ts`, `src/utils/tx-story.ts`, `companion/src/tx-story-host.ts`
- Test: `companion/src/uncategorized-status.test.ts`, `companion/src/tx-story-host.test.ts` (modify); `shared/tx-story-payback.test.ts`, `src/utils/tx-story-payback.test.ts` (create)

**Interfaces:**
- Consumes: Task 1's `paybackOfferedInStory`; `removalFingerprint` (tx-remove).
- Produces:

```ts
// shared/uncategorized.ts
UncategorizedRow.paybackEligible?: true;
// shared/tx-story.ts
export const TX_STORY_PAYBACK = 'A payback: it lowers your spending.';
TxStoryRow.subtype?: string;
TxFiler: { kind: 'you'; at?: string; payback?: true } | …;
export const isPaybackStoryRow: (row: Pick<TxStoryRow, 'activityType' | 'subtype' | 'accountType'>) => boolean;
// src/utils/tx-story.ts — AppStoryOutcome 'ok' gains:
payback?: { activityId: string; fingerprint: string };
```

- [ ] **Step 1: Write the failing tests**

Edit 1 of 1 in `companion/src/uncategorized-status.test.ts` — replace:

```ts
});

describe('uncategorizedWindow', () => {
  it('spans the last 90 days, end-exclusive tomorrow', () => {
```

with:

```ts
});

describe('payback rows (W11)', () => {
  const publish = async (rows: ReturnType<typeof native>[]) => {
    const writes: Record<string, string> = {};
    await publishUncategorizedStatus(async (k, v) => { writes[k] = v; }, () => rows, async () => ({}), new Date('2026-10-14T12:00:00Z'));
    return JSON.parse(writes['uncategorized_status']).rows as Array<{ activityId: string; paybackEligible?: true }>;
  };
  const deposit = { notes: 'VENMO CASHOUT · TRN-77', direction: 'in' as const, incomeEligible: true, activityType: 'DEPOSIT', pending: false };

  it("marks a posted deposit on a cash account: the rows Telegram offers \"It's a payback »\" on", async () => {
    const [row] = await publish([native('a', deposit)]);
    expect(row.paybackEligible).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ['interest', { ...deposit, activityType: 'INTEREST' }],
    ['a pending deposit', { ...deposit, pending: true }],
    ['a card credit', { ...deposit, incomeEligible: false, activityType: 'CREDIT' }],
    ['a withdrawal', { ...deposit, direction: 'out', incomeEligible: false, activityType: 'WITHDRAWAL' }],
    ['a row read without its type', { notes: 'VENMO CASHOUT · TRN-77', direction: 'in', incomeEligible: true }],
  ])('marks no %s', async (_name, over) => {
    const [row] = await publish([native('a', over)]);
    expect('paybackEligible' in row).toBe(false);
  });
});

describe('uncategorizedWindow', () => {
  it('spans the last 90 days, end-exclusive tomorrow', () => {
```

Edit 1 of 2 in `companion/src/tx-story-host.test.ts` — replace:

```ts
import { describe, it, expect, vi } from 'vitest';
import { categoryFiledChange, importChange, stampChange, transferLinkChange } from '../../shared/change-entries.js';
import type { ChangeLogRead } from '../../shared/change-log.js';
import { SYNC_OVERRIDES_SECRET_KEY } from '../../shared/sync-overrides.js';
import { SKIPPED_TRANSACTIONS_SECRET_KEY } from '../../shared/skipped-transactions.js';
import { OPENING_BALANCES_CATEGORY } from './opening-balance-category.js';
import { accountTxKey } from '../../shared/transfers.js';
import { TX_FACT_NOTES, TX_STORY_NO_HISTORY, TX_STORY_SPENDING } from '../../shared/tx-story.js';
import { parseTxQuery } from '../../shared/tx-search.js';
import { companionStoryReaders, companionTxSearch, companionTxStory, type StoryReaders } from './tx-story-host.js';
```

with:

```ts
import { describe, it, expect, vi } from 'vitest';
import { categoryFiledChange, importChange, paybackFiledChange, stampChange, transferLinkChange } from '../../shared/change-entries.js';
import type { ChangeLogRead } from '../../shared/change-log.js';
import { SYNC_OVERRIDES_SECRET_KEY } from '../../shared/sync-overrides.js';
import { SKIPPED_TRANSACTIONS_SECRET_KEY } from '../../shared/skipped-transactions.js';
import { OPENING_BALANCES_CATEGORY } from './opening-balance-category.js';
import { accountTxKey } from '../../shared/transfers.js';
import { TX_FACT_NOTES, TX_STORY_NO_HISTORY, TX_STORY_PAYBACK, TX_STORY_SPENDING } from '../../shared/tx-story.js';
import { parseTxQuery } from '../../shared/tx-search.js';
import { companionStoryReaders, companionTxSearch, companionTxStory, type StoryReaders } from './tx-story-host.js';
```

Edit 2 of 2 in `companion/src/tx-story-host.test.ts` — replace:

```ts
  };
}

describe('companionTxStory', () => {
```

with:

```ts
  };
}

describe("a payback in Telegram's story (1.62)", () => {
  it('says a payback lowers your spending, and that you filed it as a payback — not "set by hand"', async () => {
    const filedAsPayback = stampChange(paybackFiledChange({
      account: { sfinId: 'ACT-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKeys: [KEY], activityId: 'act-1', description: 'VENMO FROM ALEX',
      amountCents: 4000, date: '2026-10-03', subtypeBefore: null, categoryId: 'cat-food', categoryName: 'Food & Dining',
    }), 'companion', new Date('2026-10-13T12:00:00Z'));
    const r = readers({
      row: vi.fn(async () => restRow({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT', amount: '40', comment: 'VENMO FROM ALEX · TRN-1' })),
      details: vi.fn(() => ({ accountType: 'CASH', assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-food', categoryName: 'Food & Dining', source: 'manual' }] })),
      changeLog: vi.fn(async () => logOf(filedAsPayback)),
    });
    const out = await companionTxStory(r, 'act-1', NOW);
    expect(out.kind === 'ok' && out.story.answer.slice(0, 3)).toEqual([
      'From your PNC Checking bank feed.',
      TX_STORY_PAYBACK,
      'Filed under Food & Dining by you, as a payback, Oct 13.',
    ]);
  });
});

describe('companionTxStory', () => {
```

**Create `shared/tx-story-payback.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import { paybackFiledChange, stampChange } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import { buildTxStory, resolveFiler, TX_STORY_MONEY_IN, TX_STORY_PAYBACK, type FilerInput, type TxStoryFacts } from './tx-story.js';

const AT = '2026-10-14T12:00:00.000Z';
const filedAsPayback = (categoryId: string | null, over: Partial<ChangeLogItem> = {}): ChangeLogItem => ({
  ...stampChange(paybackFiledChange({
    account: { sfinId: 'sfin-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKeys: ['sfin-chk\u0000TRN-77'], activityId: 'act-7',
    description: 'VENMO CASHOUT', amountCents: 1400, date: '2026-10-09', subtypeBefore: null,
    categoryId, categoryName: categoryId ? 'Restaurants' : null,
  }), 'addon', new Date(AT)),
  ...over,
});
const input = (history: ChangeLogItem[] | null, over: Partial<FilerInput> = {}): FilerInput => ({
  activityId: 'act-7', source: 'rule', categoryId: 'cat-rest', categoryName: 'Restaurants',
  row: { note: 'VENMO CASHOUT · TRN-77', activityType: 'CREDIT', accountId: 'wf-chk', absCents: 1400 },
  history, rules: null, ...over,
});
const story = (over: Partial<TxStoryFacts> = {}, row: Partial<TxStoryFacts['row']> = {}) => buildTxStory({
  now: new Date(AT),
  row: { activityId: 'act-7', note: 'VENMO CASHOUT · TRN-77', absCents: 1400, date: '2026-10-09', activityType: 'CREDIT', subtype: 'REIMBURSEMENT', accountName: 'PNC Checking', accountType: 'CASH', ...row },
  feed: { sfinAccountId: 'sfin-chk' }, partner: null, ...over,
});

describe('who filed a payback', () => {
  it('is you, as a payback, though the app filed it through a rule (W11)', () => {
    expect(resolveFiler(input([filedAsPayback('cat-rest')]))).toEqual({ kind: 'you', at: AT, payback: true });
  });

  it("is you, as a payback, when Telegram's /categorize filed it by hand — not \"set by hand\"", () => {
    expect(resolveFiler(input([filedAsPayback('cat-rest')], { source: 'manual' }))).toEqual({ kind: 'you', at: AT, payback: true });
  });

  it.each<[string, ChangeLogItem]>([
    ['the payback was undone', filedAsPayback('cat-rest', { undone: { by: 'u1', at: AT } })],
    ['it is under another category than the payback chose', filedAsPayback('cat-groc')],
    ['the payback left it with no category', filedAsPayback(null)],
    ["the entry is another row's", filedAsPayback('cat-rest', { subject: { txKeys: [], activityIds: ['act-9'] } })],
  ])('is a rule, as before, when %s', (_name, entry) => {
    expect(resolveFiler(input([entry]))).toEqual({ kind: 'rule', pattern: null, unknown: true });
  });

  it('is named as a payback in the story, with the day when it is known', () => {
    expect(story({ category: { name: 'Restaurants', filer: { kind: 'you', at: AT, payback: true } } }).answer)
      .toContain('Filed under Restaurants by you, as a payback, Oct 14.');
    expect(story({ category: { name: 'Restaurants', filer: { kind: 'you', payback: true } } }).answer)
      .toContain('Filed under Restaurants by you, as a payback.');
    expect(story({ category: { name: 'Restaurants', filer: { kind: 'you', at: AT } } }).answer)
      .toContain('Filed under Restaurants by you, in Telegram, Oct 14.');
  });
});

describe("a payback's money line", () => {
  it('says a payback lowers your spending, not "Money in."', () => {
    const answer = story().answer;
    expect(answer).toContain(TX_STORY_PAYBACK);
    expect(TX_STORY_PAYBACK).toBe('A payback: it lowers your spending.');
    expect(answer).not.toContain(TX_STORY_MONEY_IN);
  });

  it.each<[string, Partial<TxStoryFacts['row']>]>([
    ['a deposit', { activityType: 'DEPOSIT', subtype: undefined }],
    ['a CREDIT with no subtype', { subtype: undefined }],
    ['a refund', { subtype: 'REFUND' }],
    ['an account of unknown type', { accountType: undefined }],
  ])('keeps "Money in." for %s', (_name, row) => {
    expect(story({}, row).answer).toContain(TX_STORY_MONEY_IN);
  });
});
```

**Create `src/utils/tx-story-payback.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { paybackFiledChange, stampChange } from '../../shared/change-entries';
import { emptySyncOverrides, setTxOverride } from '../../shared/sync-overrides';
import { accountTxKey } from '../../shared/transfers';
import { removalFingerprint } from '../../shared/tx-remove';
import { TX_STORY_PAYBACK } from '../../shared/tx-story';
import { appTxStory } from './tx-story';

const NOW = new Date('2026-10-14T15:00:00Z');
const KEY = accountTxKey('sfin-chk', 'TRN-77');
const detail = (over: Record<string, unknown> = {}) => ({
  id: 'act-7', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'DEPOSIT', date: '2026-10-09T12:00:00.000Z', amount: '14',
  currency: 'USD', comment: 'VENMO CASHOUT · TRN-77', ...over,
});
const SHOWN = removalFingerprint({ activityId: 'act-7', note: 'VENMO CASHOUT · TRN-77', absCents: 1400, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking' });

/** A 3.9+ host: the row, its fact from the cash search, and the category names. `accountType` for the row's account. */
function host39(row: Record<string, unknown>, fact: Record<string, unknown>, accountType = 'CASH') {
  return {
    api: {
      activities: { search: vi.fn(async () => ({ data: [row], meta: { totalRowCount: 1 } })), getTransferPair: vi.fn(async () => null) },
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', name: 'PNC Checking', accountType }]) },
      spending: {
        searchCashActivities: vi.fn(async () => ({ items: [{ ...row, activityDate: row.date, splits: [], transferLinkStatus: null, sourceGroupId: null, ...fact }], totalCount: 1 })),
        getCategories: vi.fn(async () => [{ kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-rest', key: 'r', name: 'Restaurants', path: 'Food & Dining / Restaurants' }]),
      },
    },
  } as any;
}
const store = (over: Record<string, unknown> = {}) => ({
  getAccountMapping: vi.fn(async () => ({ 'sfin-chk': 'wf-chk' })),
  readSyncOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: false })),
  ...over,
});
const income = { cashFlowBucket: 'income', assignments: [] };

describe('"It\'s a payback…" on a story in the app (W11)', () => {
  it('is offered on a posted deposit Wealthfolio says is filed nowhere, with the row as shown', async () => {
    const out = await appTxStory(host39(detail(), income), store(), { activityId: 'act-7' }, NOW);
    expect(out.kind === 'ok' && out.payback).toEqual({ activityId: 'act-7', fingerprint: SHOWN });
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, string?]>([
    ['a row Wealthfolio says is filed', detail(), { ...income, assignments: [{ taxonomyId: 'income_categories', categoryId: 'cat-gift', source: 'manual' }] }],
    ['a card', detail(), income, 'CREDIT_CARD'],
    ['a pending deposit', detail({ comment: 'VENMO CASHOUT · TRN-77 · pending' }), income],
    ['a withdrawal', detail({ activityType: 'WITHDRAWAL' }), { ...income, cashFlowBucket: 'spending' }],
  ])('is not offered on %s', async (_name, row, fact, accountType) => {
    const out = await appTxStory(host39(row, fact, accountType), store(), { activityId: 'act-7' }, NOW);
    expect(out.kind).toBe('ok');
    expect(out.kind === 'ok' && out.payback).toBeUndefined();
  });

  it('is not offered on a row the payback setting is already on', async () => {
    const overrides = setTxOverride(emptySyncOverrides(), KEY, 'asReimbursement', NOW);
    const out = await appTxStory(host39(detail(), income), store({ readSyncOverrides: vi.fn(async () => ({ overrides, unreadable: false })) }), { activityId: 'act-7' }, NOW);
    expect(out.kind === 'ok' && out.payback).toBeUndefined();
  });

  it('is not offered on a Wealthfolio 3.8 host, which has no facts', async () => {
    const ctx = host39(detail(), income);
    ctx.api.spending.searchCashActivities = vi.fn(async () => { throw new Error("Unknown addon host API method 'spending.searchCashActivities'"); });
    const status = { count: 1, asOf: '2026-10-14T00:00:00Z', rows: [{ activityId: 'act-7', date: '2026-10-09', amountCents: 1400, description: 'VENMO CASHOUT', accountName: 'PNC Checking', paybackEligible: true }] };
    const out = await appTxStory(ctx, store({ getUncategorizedStatus: vi.fn(async () => status) }), { activityId: 'act-7' }, NOW);
    expect(out.kind === 'ok' && out.story.answer).toContain("Not filed yet — it's on your needs-a-category list.");
    expect(out.kind === 'ok' && out.payback).toBeUndefined();
  });

  it('says a payback the app filed lowers your spending and was filed by you, as a payback, though Wealthfolio says a rule filed it', async () => {
    const entry = stampChange(paybackFiledChange({
      account: { sfinId: 'sfin-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKeys: [KEY], activityId: 'act-7', description: 'VENMO CASHOUT',
      amountCents: 1400, date: '2026-10-09', subtypeBefore: null, categoryId: 'cat-rest', categoryName: 'Restaurants',
    }), 'addon', new Date('2026-10-14T12:00:00Z'));
    const log = { entries: [entry], gaps: [], trimmed: 0, unreadable: [] };
    const credit = detail({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
    const out = await appTxStory(
      host39(credit, { cashFlowBucket: 'spending', assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-rest', source: 'rule' }] }),
      store({ getChangeLog: vi.fn(async () => log) }), { activityId: 'act-7' }, NOW,
    );
    expect(out.kind === 'ok' && out.story.answer).toContain(TX_STORY_PAYBACK);
    expect(out.kind === 'ok' && out.story.answer).toContain('Filed under Restaurants by you, as a payback, Oct 14.');
    expect(out.kind === 'ok' && out.payback).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npx vitest run --maxWorkers=2 shared/tx-story-payback.test.ts src/utils/tx-story-payback.test.ts`
Expected: FAIL — 6 failed, 14 passed (20): `is you, as a payback, though the app filed it through a rule (W11)`, `is you, as a payback, when Telegram's /categorize filed it by hand…`, `is named as a payback in the story…`, `says a payback lowers your spending, not "Money in."`, `is offered on a posted deposit Wealthfolio says is filed nowhere…` and `says a payback the app filed lowers your spending…`. The cases that keep today's behaviour already pass.

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && cd companion && nice npx vitest run --maxWorkers=2 src/uncategorized-status.test.ts src/tx-story-host.test.ts`
Expected: FAIL — 2 failed, 47 passed (49): `marks a posted deposit on a cash account…` and `says a payback lowers your spending, and that you filed it as a payback — not "set by hand"`.

- [ ] **Step 3: Implement**

Edit 1 of 1 in `shared/uncategorized.ts` — replace:

```ts
   *  sends it, and a row with no clear history has none. */
  guess?: { categoryId: string; name: string };
}

```

with:

```ts
   *  sends it, and a row with no clear history has none. */
  guess?: { categoryId: string; name: string };
  /** A posted DEPOSIT on a cash account (1.62, W11): the app offers "It's a
   *  payback…" on it — the rows Telegram's /categorize offers "It's a payback »"
   *  on. Optional: an older companion never sends it, so its rows offer none. */
  paybackEligible?: true;
}

```

Edit 1 of 2 in `companion/src/uncategorized-status.ts` — replace:

```ts
   *  spending category, which Wealthfolio refuses on it. */
  incomeEligible?: boolean;
}

/**
```

with:

```ts
   *  spending category, which Wealthfolio refuses on it. */
  incomeEligible?: boolean;
  /** The effective type, upper-cased, and whether the note marks it pending:
   *  with `incomeEligible`, what makes a row a payback candidate (W11). */
  activityType?: string;
  pending?: boolean;
}

/** A posted DEPOSIT on a cash account: what Telegram's "It's a payback »" is
 *  offered on (shared/categorize-menu.ts), and so the app's "It's a payback…". */
const paybackEligible = (r: UncategorizedSourceRow): boolean =>
  r.incomeEligible === true && (r.activityType ?? '').toUpperCase() === 'DEPOSIT' && r.pending !== true;

/**
```

Edit 2 of 2 in `companion/src/uncategorized-status.ts` — replace:

```ts
        ...(r.direction ? { direction: r.direction } : {}),
        ...(guess ? { guess: { categoryId: guess.categoryId, name: guess.name } } : {}),
      };
    });
```

with:

```ts
        ...(r.direction ? { direction: r.direction } : {}),
        ...(guess ? { guess: { categoryId: guess.categoryId, name: guess.name } } : {}),
        ...(paybackEligible(r) ? { paybackEligible: true as const } : {}),
      };
    });
```

Edit 1 of 8 in `shared/tx-story.ts` — replace:

```ts
export const TX_STORY_SPENDING = 'Spending.';
export const TX_STORY_MONEY_IN = 'Money in.';
/** A row whose note carries ` · Venmo: <note>` (3). */
export const TX_STORY_VENMO_NOTE = 'Note from a Venmo email.';
```

with:

```ts
export const TX_STORY_SPENDING = 'Spending.';
export const TX_STORY_MONEY_IN = 'Money in.';
/** A cash CREDIT marked REIMBURSEMENT (1.62): money in that Wealthfolio takes off spending. */
export const TX_STORY_PAYBACK = 'A payback: it lowers your spending.';
/** A row whose note carries ` · Venmo: <note>` (3). */
export const TX_STORY_VENMO_NOTE = 'Note from a Venmo email.';
```

Edit 2 of 8 in `shared/tx-story.ts` — replace:

```ts
  /** Wealthfolio account type (CASH, CREDIT_CARD, …); absent when unknown. */
  accountType?: string;
}

```

with:

```ts
  /** Wealthfolio account type (CASH, CREDIT_CARD, …); absent when unknown. */
  accountType?: string;
  /** The stored subtype (`REIMBURSEMENT` on a payback); absent when none. */
  subtype?: string;
}

```

Edit 3 of 8 in `shared/tx-story.ts` — replace:

```ts
export type TxFiler =
  | { kind: 'rule'; pattern: string | null; unknown?: true }
  | { kind: 'you'; at?: string }
  | { kind: 'amazon'; label: string }
  | { kind: 'opening' }
```

with:

```ts
export type TxFiler =
  | { kind: 'rule'; pattern: string | null; unknown?: true }
  /** `payback`: you filed it as a payback (1.62) — in Telegram by hand, or in
   *  the app through a one-off rule, so it is told by its log entry. */
  | { kind: 'you'; at?: string; payback?: true }
  | { kind: 'amazon'; label: string }
  | { kind: 'opening' }
```

Edit 4 of 8 in `shared/tx-story.ts` — replace:

```ts

export const isCashType = (activityType: string): boolean => CASH_TYPES.has(activityType.toUpperCase());

/** Money out: the spending types, and interest charged on a card. */
```

with:

```ts

export const isCashType = (activityType: string): boolean => CASH_TYPES.has(activityType.toUpperCase());

/** A payback: a CREDIT marked REIMBURSEMENT on a cash account (on a card every
 *  CREDIT comes off spending, payback or not). */
export const isPaybackStoryRow = (row: Pick<TxStoryRow, 'activityType' | 'subtype' | 'accountType'>): boolean =>
  row.activityType.toUpperCase() === 'CREDIT' && (row.subtype ?? '').trim().toUpperCase() === 'REIMBURSEMENT'
  && (row.accountType ?? '').toUpperCase() === 'CASH';

/** Money out: the spending types, and interest charged on a card. */
```

Edit 5 of 8 in `shared/tx-story.ts` — replace:

```ts

/**
 * Who filed it. A rule's filing names the rule (`inferFilingRule`). Anything
 * else is the newest log entry that set THIS category — you in Telegram, the
 * Amazon email, the opening-balance filing — then, for the add-on's own
 * starting balance, its category (the companion filed card opening balances
```

with:

```ts

/**
 * Who filed it. A payback you filed under this category comes first ("by you,
 * as a payback"), whatever the source says: the app files a payback through a
 * one-off rule it deletes after (W11). A rule's filing names the rule
 * (`inferFilingRule`). Anything else is the newest log entry that set THIS category — you in Telegram, the
 * Amazon email, the opening-balance filing — then, for the add-on's own
 * starting balance, its category (the companion filed card opening balances
```

Edit 6 of 8 in `shared/tx-story.ts` — replace:

```ts
 */
export function resolveFiler(f: FilerInput): TxFiler | null {
  if ((f.source ?? '').toLowerCase() === 'rule') {
    if (f.rules === null) return { kind: 'rule', pattern: null, unknown: true };
```

with:

```ts
 */
export function resolveFiler(f: FilerInput): TxFiler | null {
  const payback = [...(f.history ?? [])]
    .filter((e) => !e.undone && e.kind === 'payback-filed' && afterCategoryId(e) === f.categoryId
      && (f.activityId === undefined || (e.subject.activityIds ?? []).includes(f.activityId)))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
  if (payback) return { kind: 'you', at: payback.at, payback: true };
  if ((f.source ?? '').toLowerCase() === 'rule') {
    if (f.rules === null) return { kind: 'rule', pattern: null, unknown: true };
```

Edit 7 of 8 in `shared/tx-story.ts` — replace:

```ts
          ? `Filed under ${name} by a rule (none of your current rules matches it).`
          : `Filed under ${name} by a rule — '${filer.pattern}' matches it.`;
    case 'you':
      return filer.at ? `Filed under ${name} by you, in Telegram, ${changeDay(changeLocalDay(filer.at))}.` : `Filed under ${name} by you, in Telegram.`;
    case 'amazon': return `Filed under ${name} from an Amazon email.`;
    case 'opening': return `Filed under ${name} by the add-on — an opening balance isn't spending.`;
```

with:

```ts
          ? `Filed under ${name} by a rule (none of your current rules matches it).`
          : `Filed under ${name} by a rule — '${filer.pattern}' matches it.`;
    case 'you': {
      const how = filer.payback ? 'as a payback' : 'in Telegram';
      return filer.at ? `Filed under ${name} by you, ${how}, ${changeDay(changeLocalDay(filer.at))}.` : `Filed under ${name} by you, ${how}.`;
    }
    case 'amazon': return `Filed under ${name} from an Amazon email.`;
    case 'opening': return `Filed under ${name} by the add-on — an opening balance isn't spending.`;
```

Edit 8 of 8 in `shared/tx-story.ts` — replace:

```ts
    } else if (cash && (facts.partner === null || !isTransferType(row.activityType.toUpperCase()))) {
      // Only cash activity is spending or money in; a trade gets no line.
      answer.push(out ? TX_STORY_SPENDING : TX_STORY_MONEY_IN);
    }
  }
```

with:

```ts
    } else if (cash && (facts.partner === null || !isTransferType(row.activityType.toUpperCase()))) {
      // Only cash activity is spending or money in; a trade gets no line.
      answer.push(out ? TX_STORY_SPENDING : isPaybackStoryRow(row) ? TX_STORY_PAYBACK : TX_STORY_MONEY_IN);
    }
  }
```

Edit 1 of 4 in `src/utils/tx-story.ts` — replace:

```ts
import type { ChangeLogItem } from '../../shared/change-log';
import { changesForTransaction, currentActivityId, isChangeLogPartial } from '../../shared/change-view';
import { txIdFromComment, isTransferType } from '../../shared/sync-core';
import { hasTxOverride, TX_OVERRIDE_FLAGS, type TxOverrideFlag } from '../../shared/sync-overrides';
```

with:

```ts
import type { ChangeLogItem } from '../../shared/change-log';
import { changesForTransaction, currentActivityId, isChangeLogPartial } from '../../shared/change-view';
import { paybackOfferedInStory } from '../../shared/payback-app';
import { txIdFromComment, isTransferType } from '../../shared/sync-core';
import { hasTxOverride, TX_OVERRIDE_FLAGS, type TxOverrideFlag } from '../../shared/sync-overrides';
```

Edit 2 of 4 in `src/utils/tx-story.ts` — replace:

```ts
  /** `entries`: the whole change log as read (Undo needs it); [] when unread.
   *  `removal` (2c R2): the story offers "Remove for good…" for this row, as shown
   *  (its date is the UTC day the story shows, which is the one the remover checks). */
  | { kind: 'ok'; story: TxStory; entries: ChangeLogItem[]; removal?: { activityId: string; fingerprint: string } }
  | { kind: 'gone' }
  | { kind: 'unreachable' };
```

with:

```ts
  /** `entries`: the whole change log as read (Undo needs it); [] when unread.
   *  `removal` (2c R2): the story offers "Remove for good…" for this row, as shown
   *  (its date is the UTC day the story shows, which is the one the remover checks).
   *  `payback` (W11): the row qualifies for "It's a payback…", as shown — the app
   *  offers it only where the host and the companion allow (`appPaybacksOffered`). */
  | {
    kind: 'ok'; story: TxStory; entries: ChangeLogItem[];
    removal?: { activityId: string; fingerprint: string };
    payback?: { activityId: string; fingerprint: string };
  }
  | { kind: 'gone' }
  | { kind: 'unreachable' };
```

Edit 3 of 4 in `src/utils/tx-story.ts` — replace:

```ts
      accountName: row.accountName ?? '',
      ...(accountType ? { accountType: String(accountType) } : {}),
    },
    ...(sfinIds === undefined ? {} : { feed: sfinIds.length ? { sfinAccountId: feedOf(sfinIds, txId, history)! } : null }),
```

with:

```ts
      accountName: row.accountName ?? '',
      ...(accountType ? { accountType: String(accountType) } : {}),
      ...(row.subtype ? { subtype: String(row.subtype) } : {}),
    },
    ...(sfinIds === undefined ? {} : { feed: sfinIds.length ? { sfinAccountId: feedOf(sfinIds, txId, history)! } : null }),
```

Edit 4 of 4 in `src/utils/tx-story.ts` — replace:

```ts
    kind: 'ok', story: buildTxStory(facts), entries,
    ...(removalOffered(facts) ? { removal: { activityId: row.id, fingerprint: removalFingerprint(facts.row) } } : {}),
  };
}
```

with:

```ts
    kind: 'ok', story: buildTxStory(facts), entries,
    ...(removalOffered(facts) ? { removal: { activityId: row.id, fingerprint: removalFingerprint(facts.row) } } : {}),
    ...(paybackOfferedInStory(facts) ? { payback: { activityId: row.id, fingerprint: removalFingerprint(facts.row) } } : {}),
  };
}
```

Edit 1 of 1 in `companion/src/tx-story-host.ts` — replace:

```ts
    accountName: item.accountName ?? '',
    ...(details?.accountType ? { accountType: details.accountType } : {}),
  };

```

with:

```ts
    accountName: item.accountName ?? '',
    ...(details?.accountType ? { accountType: details.accountType } : {}),
    ...(item.subtype ? { subtype: String(item.subtype) } : {}),
  };

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npx vitest run --maxWorkers=2 shared/tx-story-payback.test.ts src/utils/tx-story-payback.test.ts shared/tx-story.test.ts src/utils/tx-story.test.ts src/utils/tx-story-facts.test.ts`
Expected: PASS — 109 tests (5 files).

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && cd companion && nice npx vitest run --maxWorkers=2 src/uncategorized-status.test.ts src/tx-story-host.test.ts src/report-cube-build.test.ts`
Expected: PASS — 71 tests (3 files).

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npm run type-check && nice npm --prefix companion run build`
Expected: Both succeed.

- [ ] **Step 5: Commit**

```bash
git add shared/uncategorized.ts companion/src/uncategorized-status.ts companion/src/uncategorized-status.test.ts shared/tx-story.ts src/utils/tx-story.ts companion/src/tx-story-host.ts companion/src/tx-story-host.test.ts shared/tx-story-payback.test.ts src/utils/tx-story-payback.test.ts
git commit -m "Paybacks in the app: the companion marks payback rows; a story says a payback is yours and lowers your spending (W11)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: It's a payback… in the list and the story, and the row leaves at once

`PaybackAction` is the button and the picker (`PAYBACK_PICK`, the spending categories by path, File it, Cancel; one action per click, busy while it runs). The story shows it where the outcome offers `payback` and the actions carry `payback`; the needs-a-category list shows it under each `paybackEligible` row. `useTxStoryActions` offers `payback` only when `appPaybacksOffered` says so, and tells the page when one was filed: `SyncPage` holds the filed rows (`PaidBackLedger`, the session's) and the last filed message, like the dismissal ledger, so the row and the count drop at once on any tab, and a publish made after the filing is the truth again (ruling 8). A refusal under a list row is said under it; a filed row's words are said at the top of the list, which outlives the row.

**Files:**
- Create: `src/components/PaybackAction.tsx`
- Modify: `shared/uncategorized.ts`, `src/components/TxStory.tsx`, `src/components/UncategorizedList.tsx`, `src/tabs/HomeTab.tsx`, `src/pages/SyncPage.tsx`
- Test: `shared/uncategorized-paidback.test.ts`, `src/components/PaybackAction.test.tsx`, `src/pages/payback-app.test.tsx`

**Interfaces:**
- Consumes: Task 3's `appPaybacksOffered`, `paybackFromApp`, `readPaybackCategories`; Task 2's `AppPaybackOutcome`; Task 1's `PaybackCategory` and copy; Task 4's `AppStoryOutcome.payback` and `UncategorizedRow.paybackEligible`.
- Produces:

```ts
// shared/uncategorized.ts
export interface PaidBackLedger { [activityId: string]: string }
export function paidBackHidden(rows: ReadonlyArray<{ activityId: string }>, paidBack: PaidBackLedger, asOf: string): Set<string>;
// src/components/PaybackAction.tsx
export interface AppPaybackActions { categories(): Promise<PaybackCategory[]>; file(activityId: string, categoryId: string, shown?: string): Promise<AppPaybackOutcome> }
export function MessageLines(p: { message: string | null | undefined }): JSX.Element;
export function PaybackAction(p: { activityId: string; shown?: string; label?: string; actions: AppPaybackActions; onOutcome?: (o: AppPaybackOutcome) => void; inlineStatus?: boolean }): JSX.Element;
// src/components/TxStory.tsx
TxStoryActions.payback?: AppPaybackActions;
useTxStoryActions(ctx, store, companionVersion, onPaidBack?: (activityId: string, message: string) => void): TxStoryActions;
TxStoryView props gain payback?: { activityId: string; fingerprint: string };
// UncategorizedList props gain payback?: AppPaybackActions; paybackNote?: string | null
// HomeTab props gain payback?: AppPaybackActions; paidBack?: PaidBackLedger; paybackNote?: string | null
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/uncategorized-paidback.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import { paidBackHidden } from './uncategorized.js';

const ROWS = [{ activityId: 'a' }, { activityId: 'b' }, { activityId: 'c' }];
const ASOF = '2026-10-14T12:00:00.000Z';

describe('a row filed as a payback leaves the needs-a-category list at once (W11)', () => {
  it('hides the rows filed since this publish, and only rows the publish lists', () => {
    expect([...paidBackHidden(ROWS, { a: '2026-10-14T12:05:00.000Z', z: '2026-10-14T12:05:00.000Z' }, ASOF)]).toEqual(['a']);
  });

  it('shows a row again once a publish made after the filing still lists it (a payback undone in Telegram)', () => {
    expect([...paidBackHidden(ROWS, { a: '2026-10-14T11:00:00.000Z' }, ASOF)]).toEqual([]);
  });

  it('hides it when either time cannot be read: the filing is the newer news', () => {
    expect([...paidBackHidden(ROWS, { a: 'garbage' }, ASOF)]).toEqual(['a']);
    expect([...paidBackHidden(ROWS, { b: '2026-10-14T11:00:00.000Z' }, '')]).toEqual(['b']);
  });

  it('hides nothing with nothing filed', () => {
    expect(paidBackHidden(ROWS, {}, ASOF).size).toBe(0);
  });
});
```

**Create `src/components/PaybackAction.test.tsx`:**

```tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { buildTxStory } from '../../shared/tx-story';
import type { PaybackCategory } from '../../shared/payback-app';
import type { AppPaybackOutcome } from '../../shared/payback-app-file';
import {
  PAYBACK_APP_CATEGORIES_FAILED, PAYBACK_NOT_IN_SPENDING, PAYBACK_PICK, PAYBACK_UNREACHABLE, paybackAppUnfiled,
} from '../../shared/payback-copy';
import { PaybackAction, type AppPaybackActions } from './PaybackAction';
import { TxStoryView } from './TxStory';

const EMOJI = /\p{Extended_Pictographic}/u;
const CATS: PaybackCategory[] = [
  { id: 'cat-rest', name: 'Restaurants', parentName: 'Food & Dining', path: 'Food & Dining / Restaurants', kind: 'expense' },
  { id: 'cat-auto', name: 'Auto', parentName: null, path: 'Auto', kind: 'expense' },
];
const FILED: AppPaybackOutcome = {
  kind: 'filed', message: 'Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending.\nUndo it from Telegram: /changes.',
};
const actions = (file: AppPaybackActions['file'] = vi.fn(async () => FILED), categories: AppPaybackActions['categories'] = vi.fn(async () => CATS)) => ({ file, categories });

async function pick(categoryId = 'cat-rest') {
  fireEvent.click(screen.getByRole('button', { name: /It's a payback…/ }));
  const select = await screen.findByRole('combobox', { name: 'Spending category' });
  fireEvent.change(select, { target: { value: categoryId } });
}

describe('PaybackAction', () => {
  it("opens the picker under Telegram's line, with the spending categories by path; nothing is filed until File it", async () => {
    const a = actions();
    const { container } = render(<PaybackAction activityId="act-7" actions={a} />);
    fireEvent.click(screen.getByRole('button', { name: "It's a payback…" }));
    expect(await screen.findByText(PAYBACK_PICK)).toBeInTheDocument();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a category', 'Food & Dining / Restaurants', 'Auto']);
    expect(screen.getByRole('button', { name: 'File it' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(PAYBACK_PICK)).toBeNull();
    expect(a.file).not.toHaveBeenCalled();
    expect(EMOJI.test(container.textContent ?? '')).toBe(false);
  });

  it('files once, busy while it runs, with the row as the story showed it, and hands the outcome up', async () => {
    let finish!: (o: AppPaybackOutcome) => void;
    const file = vi.fn(() => new Promise<AppPaybackOutcome>((r) => { finish = r; }));
    const onOutcome = vi.fn();
    render(<PaybackAction activityId="act-7" shown="abcd1234" actions={actions(file)} onOutcome={onOutcome} />);
    await pick();
    const go = screen.getByRole('button', { name: 'File it' });
    fireEvent.click(go);
    fireEvent.click(go);
    expect(file).toHaveBeenCalledTimes(1);
    expect(file).toHaveBeenCalledWith('act-7', 'cat-rest', 'abcd1234');
    expect(go).toBeDisabled();
    expect(go).toHaveAttribute('aria-busy', 'true');
    await act(async () => { finish(FILED); });
    expect(onOutcome).toHaveBeenCalledWith(FILED);
    expect(screen.queryByText(PAYBACK_PICK)).toBeNull();
  });

  it('says a refusal under the row in the list, line by line, and can be tried again', async () => {
    const message = `${paybackAppUnfiled('Restaurants')}\nUndo it from Telegram: /changes.`;
    render(<PaybackAction inlineStatus activityId="act-7" label="VENMO CASHOUT, $14.00 on 2026-10-09" actions={actions(vi.fn(async () => ({ kind: 'partial' as const, message })))} />);
    expect(screen.getByRole('button', { name: "It's a payback… VENMO CASHOUT, $14.00 on 2026-10-09" })).toBeInTheDocument();
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'File it' }));
    expect(await screen.findByText(paybackAppUnfiled('Restaurants'))).toBeInTheDocument();
    expect(screen.getByText('Undo it from Telegram: /changes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /It's a payback…/ })).toBeInTheDocument();
  });

  it("says it couldn't reach Wealthfolio when filing throws", async () => {
    render(<PaybackAction inlineStatus activityId="act-7" actions={actions(vi.fn(async () => { throw new Error('offline'); }))} />);
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'File it' }));
    expect(await screen.findByText(PAYBACK_UNREACHABLE)).toBeInTheDocument();
  });

  it('says so when the categories cannot be read, and offers the button again', async () => {
    render(<PaybackAction activityId="act-7" actions={actions(vi.fn(), vi.fn(async () => { throw new Error('offline'); }))} />);
    fireEvent.click(screen.getByRole('button', { name: "It's a payback…" }));
    expect(await screen.findByText(PAYBACK_APP_CATEGORIES_FAILED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "It's a payback…" })).toBeEnabled();
  });
});

describe('"It\'s a payback…" on a story in the app', () => {
  const story = buildTxStory({
    now: new Date('2026-10-14T15:00:00Z'),
    row: { activityId: 'act-7', note: 'VENMO CASHOUT · TRN-77', absCents: 1400, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking', accountType: 'CASH' },
    feed: { sfinAccountId: 'sfin-chk' }, partner: null, category: null, history: [],
  });
  const OFFER = { activityId: 'act-7', fingerprint: 'abcd1234' };

  it('is offered only with the actions and a row that qualifies', () => {
    const { unmount } = render(<TxStoryView story={story} entries={[]} actions={{ companionVersion: '1.62.0', payback: actions() }} onChanged={() => {}} payback={OFFER} />);
    expect(screen.getByRole('button', { name: "It's a payback…" })).toBeInTheDocument();
    unmount();
    const { unmount: again } = render(<TxStoryView story={story} entries={[]} actions={{ companionVersion: '1.62.0' }} onChanged={() => {}} payback={OFFER} />);
    expect(screen.queryByRole('button', { name: /It's a payback/ })).toBeNull();
    again();
    render(<TxStoryView story={story} entries={[]} actions={{ companionVersion: '1.62.0', payback: actions() }} onChanged={() => {}} />);
    expect(screen.queryByRole('button', { name: /It's a payback/ })).toBeNull();
  });

  it('says what happened, line by line, and reads the story again', async () => {
    const onChanged = vi.fn();
    const a = actions(vi.fn(async () => ({ kind: 'refused' as const, message: PAYBACK_NOT_IN_SPENDING })));
    render(<TxStoryView story={story} entries={[]} actions={{ companionVersion: '1.62.0', payback: a }} onChanged={onChanged} payback={OFFER} />);
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'File it' }));
    expect(await screen.findByText(PAYBACK_NOT_IN_SPENDING)).toBeInTheDocument();
    expect(a.file).toHaveBeenCalledWith('act-7', 'cat-rest', 'abcd1234');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps the filed words when the re-read story no longer offers it', async () => {
    const view = (payback?: typeof OFFER) => (
      <TxStoryView story={story} entries={[]} actions={{ companionVersion: '1.62.0', payback: a }} onChanged={() => {}} {...(payback ? { payback } : {})} />
    );
    const a = actions();
    const { rerender } = render(view(OFFER));
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'File it' }));
    expect(await screen.findByText('Undo it from Telegram: /changes.')).toBeInTheDocument();
    rerender(view());
    expect(screen.getByText('Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /It's a payback/ })).toBeNull();
  });
});
```

**Create `src/pages/payback-app.test.tsx`:**

```tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PAYBACK_NOT_IN_SPENDING } from '../../shared/payback-copy';
import { paybackFromApp } from '../utils/app-payback';
import { SyncPage } from './SyncPage';
import { makeProps } from './test-props';

vi.mock('../utils/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sync')>();
  return {
    INTERVAL_SKIP_MESSAGE: actual.INTERVAL_SKIP_MESSAGE,
    runSync: vi.fn(async () => ({ imported: 0, skipped: 0, errors: [] })),
    applyBalanceAdjustment: vi.fn(async () => {}),
    applyBaselineCorrection: vi.fn(async () => {}),
  };
});
// The runner is the add-on's own (src/utils/app-payback.test.ts); here, what the page does with its answer.
vi.mock('../utils/app-payback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/app-payback')>();
  return { ...actual, paybackFromApp: vi.fn() };
});

const FILED = 'Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending.';
const row = (id: string, over: Record<string, unknown> = {}) => ({
  activityId: id, date: '2026-10-09', amountCents: 1400, description: `Row ${id}`, accountName: 'PNC Checking', direction: 'in', ...over,
});

/** The page on a Wealthfolio 3.9 host (`v38`: one that refuses the 3.9 calls) with this companion. */
function page(opts: { companion?: string | null; v38?: boolean } = {}) {
  const props = makeProps();
  props.ctx.api.spending = {
    searchCashActivities: vi.fn(async () => {
      if (opts.v38) throw new Error("Unknown addon host API method 'spending.searchCashActivities'");
      return { items: [], totalCount: 0 };
    }),
    getCategories: vi.fn(async () => [{ kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-rest', key: 'r', name: 'Restaurants', path: 'Food & Dining / Restaurants' }]),
  };
  props.store.getCompanionVersion = vi.fn(async () => (opts.companion === undefined ? '1.62.0' : opts.companion));
  props.store.getUiState = vi.fn(async () => ({ activeTab: 'overview', checklistDismissed: true }));
  props.store.getUncategorizedStatus = vi.fn(async () => ({
    count: 2, asOf: '2026-10-14T12:00:00.000Z', rows: [row('a', { paybackEligible: true }), row('b')],
  }));
  render(<SyncPage {...props} />);
  return props;
}

async function openList() {
  fireEvent.click(await screen.findByRole('button', { name: /^2 need/i }));
  await screen.findByText('Row a');
  // Let the offer's check (one probe) settle.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function fileRowA() {
  fireEvent.click(await screen.findByRole('button', { name: /It's a payback… Row a/ }));
  fireEvent.change(await screen.findByRole('combobox', { name: 'Spending category' }), { target: { value: 'cat-rest' } });
  fireEvent.click(screen.getByRole('button', { name: 'File it' }));
}

describe("It's a payback… on the needs-a-category list (W11)", () => {
  it('is offered on the rows the companion marks, and only those', async () => {
    page();
    await openList();
    expect(await screen.findByRole('button', { name: /It's a payback… Row a, \$14\.00 on 2026-10-09/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /It's a payback… Row b/ })).toBeNull();
  });

  it.each<[string, Parameters<typeof page>[0]]>([
    ['no companion: nothing could undo it', { companion: null }],
    ['a 1.61 companion, which turns a payback back into a deposit', { companion: '1.61.0' }],
    ['a Wealthfolio 3.8 host, which cannot confirm the filing', { v38: true }],
  ])('is hidden with %s', async (_name, opts) => {
    page(opts);
    await openList();
    expect(screen.queryByRole('button', { name: /It's a payback/ })).toBeNull();
  });

  it('a filed row leaves the list and the count at once, and the list says what happened', async () => {
    vi.mocked(paybackFromApp).mockResolvedValueOnce({ kind: 'filed', message: `${FILED}\nUndo it from Telegram: /changes.` });
    const props = page();
    await openList();
    await fileRowA();
    expect(await screen.findByText(FILED)).toBeInTheDocument();
    expect(screen.getByText('Undo it from Telegram: /changes.')).toBeInTheDocument();
    expect(screen.queryByText('Row a')).toBeNull();
    expect(screen.getByText('Row b')).toBeInTheDocument();
    const tile = (await screen.findByText('Needs a category')).closest('.sfin-tile');
    expect(tile?.textContent).toContain('1');
    expect(paybackFromApp).toHaveBeenCalledWith(props.ctx, props.store, { activityId: 'a', categoryId: 'cat-rest' });
  });

  it('a refused row stays, with the reason under it', async () => {
    vi.mocked(paybackFromApp).mockResolvedValueOnce({ kind: 'refused', message: PAYBACK_NOT_IN_SPENDING });
    page();
    await openList();
    await fileRowA();
    expect(await screen.findByText(PAYBACK_NOT_IN_SPENDING)).toBeInTheDocument();
    expect(screen.getByText('Row a')).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByText('Needs a category').closest('.sfin-tile') as HTMLElement).getByText('2')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npx vitest run --maxWorkers=2 shared/uncategorized-paidback.test.ts src/components/PaybackAction.test.tsx src/pages/payback-app.test.tsx`
Expected: FAIL — `src/components/PaybackAction.test.tsx` does not load (`Failed to resolve import "./PaybackAction"`); in the other two files 7 failed, 3 passed (10): the four `paidBackHidden` tests, and `is offered on the rows the companion marks…`, `a filed row leaves the list and the count at once…`, `a refused row stays…`. The three `is hidden with…` cases already pass: nothing is offered yet.

- [ ] **Step 3: Implement**

Edit 1 of 1 in `shared/uncategorized.ts` — replace:

```ts
}

/**
 * The rows that still need a category: everything not dismissed.
```

with:

```ts
}

/** Rows filed as a payback from the app (1.62, W11) → when (ISO). Held for
 *  the session only: the companion's next publish leaves them out. */
export interface PaidBackLedger {
  [activityId: string]: string;
}

/**
 * The rows to hide at once because they were filed as a payback since this
 * publish (`asOf`) — as a dismissal hides its row: the companion's list only
 * changes when it next publishes. A publish made after the filing is the
 * truth again (a payback undone in Telegram comes back). Only ids in `rows`,
 * so the tile never subtracts a row the publish no longer counts.
 */
export function paidBackHidden(rows: ReadonlyArray<{ activityId: string }>, paidBack: PaidBackLedger, asOf: string): Set<string> {
  const publishedAt = Date.parse(asOf);
  return new Set(rows.map((r) => r.activityId).filter((id) => id in paidBack && !(Date.parse(paidBack[id]) <= publishedAt)));
}

/**
 * The rows that still need a category: everything not dismissed.
```

**Create `src/components/PaybackAction.tsx`:**

```tsx
/**
 * src/components/PaybackAction.tsx
 *
 * "It's a payback…" (1.62.0, W11), under a money-in row of the
 * needs-a-category list and on its story. The first click reads the spending
 * categories and shows the picker under Telegram's line ("Pick the spending it
 * pays you back for."); File it acts, one action per click, busy while it runs;
 * Cancel closes. The parent says what happened: the list in its status line
 * (a filed row leaves the list at once, as a dismissed one does), the story in
 * its own. This component says only what is its own — the categories could not
 * be read — and, with `inlineStatus` (the list, whose row stays), a refusal.
 * No emoji in app copy (src/pages/copy-policy.test.tsx).
 */
import React, { useEffect, useRef, useState } from 'react';
import type { PaybackCategory } from '../../shared/payback-app';
import type { AppPaybackOutcome } from '../../shared/payback-app-file';
import {
  PAYBACK_APP_ACTION, PAYBACK_APP_CANCEL, PAYBACK_APP_CATEGORIES_FAILED, PAYBACK_APP_CATEGORY_LABEL, PAYBACK_APP_CHOOSE, PAYBACK_APP_FILE,
  PAYBACK_APP_LOADING, PAYBACK_PICK, PAYBACK_UNREACHABLE,
} from '../../shared/payback-copy';
import { Button, Select } from './ui';

/** "It's a payback…" as the app's components call it. */
export interface AppPaybackActions {
  /** The categories to pick from (`readPaybackCategories`). Rejects when they cannot be read. */
  categories(): Promise<PaybackCategory[]>;
  /** Files it (`paybackFromApp`); `shown` is the story's fingerprint of the row. */
  file(activityId: string, categoryId: string, shown?: string): Promise<AppPaybackOutcome>;
}

/** A message's lines, each its own block: the runner joins them with "\n". */
export function MessageLines({ message }: { message: string | null | undefined }) {
  return <>{(message ?? '').split('\n').filter(Boolean).map((line, i) => <div key={`${i}:${line}`}>{line}</div>)}</>;
}

export function PaybackAction({ activityId, shown, label, actions, onOutcome, inlineStatus = false }: {
  activityId: string;
  /** The row as the story showed it (`removalFingerprint`); the list has none. */
  shown?: string;
  /** The row in words, for the button's accessible name; absent: its text. */
  label?: string;
  actions: AppPaybackActions;
  onOutcome?: (out: AppPaybackOutcome) => void;
  /** Say a refusal here, under the row (the list). */
  inlineStatus?: boolean;
}) {
  const [stage, setStage] = useState<'closed' | 'loading' | 'picking'>('closed');
  const [categories, setCategories] = useState<PaybackCategory[]>([]);
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // One action per click, even before the re-render that disables the buttons.
  const running = useRef(false);
  // No state updates once the row or story is gone.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const open = async () => {
    setNote(null);
    setStage('loading');
    try {
      const list = await actions.categories();
      if (!mounted.current) return;
      setCategories(list);
      setChosen('');
      setStage('picking');
    } catch {
      if (!mounted.current) return;
      setStage('closed');
      setNote(PAYBACK_APP_CATEGORIES_FAILED);
    }
  };

  const file = async () => {
    if (running.current || !chosen) return;
    running.current = true;
    setBusy(true);
    let out: AppPaybackOutcome;
    try {
      out = await actions.file(activityId, chosen, shown);
    } catch {
      out = { kind: 'refused', message: PAYBACK_UNREACHABLE };
    }
    running.current = false;
    if (!mounted.current) return;
    setBusy(false);
    setStage('closed');
    if (inlineStatus && out.kind !== 'filed') setNote(out.message);
    onOutcome?.(out);
  };

  return (
    <div className="sfin-why-remove">
      {/* Mounted from the first render, so what lands in it is announced. */}
      <div role="status" className="sfin-subtle"><MessageLines message={note} /></div>
      {stage === 'picking' ? (
        <>
          <div>{PAYBACK_PICK}</div>
          <div className="sfin-audit-fix">
            <Select aria-label={PAYBACK_APP_CATEGORY_LABEL} value={chosen} disabled={busy} onChange={(e) => setChosen(e.target.value)}>
              <option value="">{PAYBACK_APP_CHOOSE}</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.path}</option>)}
            </Select>
            <Button variant="ghost" disabled={busy || !chosen} aria-busy={busy} onClick={file}>{PAYBACK_APP_FILE}</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setStage('closed')}>{PAYBACK_APP_CANCEL}</Button>
          </div>
        </>
      ) : (
        <div className="sfin-audit-fix">
          <Button
            variant="ghost"
            disabled={stage === 'loading'}
            aria-busy={stage === 'loading'}
            onClick={open}
            {...(label ? { 'aria-label': `${PAYBACK_APP_ACTION} ${label}` } : {})}
          >
            {stage === 'loading' ? PAYBACK_APP_LOADING : PAYBACK_APP_ACTION}
          </Button>
        </div>
      )}
    </div>
  );
}
```

Edit 1 of 8 in `src/components/TxStory.tsx` — replace:

```tsx
 * a copy). Otherwise a story changes nothing — except "Remove for good…"
 * (2c R2), on a row from the bank feed: the first click explains, Remove
 * acts, one action at a time, and the result is said in a status line.
 *
 * `TxStoryPanel` loads a story and reads it again after an Undo; a re-read that
```

with:

```tsx
 * a copy). Otherwise a story changes nothing — except "Remove for good…"
 * (2c R2), on a row from the bank feed: the first click explains, Remove
 * acts, one action at a time, and the result is said in a status line; and
 * "It's a payback…" (1.62, W11) on a money-in row filed nowhere, where the
 * host and the companion allow it (PaybackAction.tsx).
 *
 * `TxStoryPanel` loads a story and reads it again after an Undo; a re-read that
```

Edit 2 of 8 in `src/components/TxStory.tsx` — replace:

```tsx
import type { UndoOp } from '../../shared/change-undo';
import type { UndoOutcome } from '../../shared/change-undo-run';
import {
  TX_STORY_GONE_APP, TX_STORY_NO_HISTORY, TX_STORY_UNREACHABLE, TX_STORY_WHAT_HAPPENED, type TxStory,
```

with:

```tsx
import type { UndoOp } from '../../shared/change-undo';
import type { UndoOutcome } from '../../shared/change-undo-run';
import type { AppPaybackOutcome } from '../../shared/payback-app-file';
import {
  TX_STORY_GONE_APP, TX_STORY_NO_HISTORY, TX_STORY_UNREACHABLE, TX_STORY_WHAT_HAPPENED, type TxStory,
```

Edit 3 of 8 in `src/components/TxStory.tsx` — replace:

```tsx
} from '../../shared/tx-remove';
import { EntryDetail, syncNowSentence, type RowActions } from './ChangeLogCard';
import { Button } from './ui';
import { removeFromApp } from '../utils/audit-fix';
import { undoFromApp } from '../utils/change-undo';
```

with:

```tsx
} from '../../shared/tx-remove';
import { EntryDetail, syncNowSentence, type RowActions } from './ChangeLogCard';
import { MessageLines, PaybackAction, type AppPaybackActions } from './PaybackAction';
import { Button } from './ui';
import { appPaybacksOffered, paybackFromApp, readPaybackCategories } from '../utils/app-payback';
import { removeFromApp } from '../utils/audit-fix';
import { undoFromApp } from '../utils/change-undo';
```

Edit 4 of 8 in `src/components/TxStory.tsx` — replace:

```tsx
  /** 2c R2: "Remove for good…" (`removeFromApp`). Absent: never offered. */
  remove?: (activityId: string, fingerprint: string) => Promise<RemoveOutcome>;
}

/** The add-on's own Undo, Sync now and Remove for good — Undo and Sync now are the ones Settings → Change log uses. */
export function useTxStoryActions(ctx: AddonContext, store: SecretsStore, companionVersion: string | null): TxStoryActions {
  const undo = useCallback(
    (entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp) => undoFromApp(ctx, store, entry, entries, op),
    [ctx, store],
  );
  const onSyncNow = useCallback(async () => syncNowSentence(await runSync(ctx, store, { force: true })), [ctx, store]);
  const remove = useCallback((activityId: string, fingerprint: string) => removeFromApp(ctx, store, activityId, fingerprint), [ctx, store]);
  return useMemo(() => ({ undo, companionVersion, onSyncNow, remove }), [undo, companionVersion, onSyncNow, remove]);
}

```

with:

```tsx
  /** 2c R2: "Remove for good…" (`removeFromApp`). Absent: never offered. */
  remove?: (activityId: string, fingerprint: string) => Promise<RemoveOutcome>;
  /** W11: "It's a payback…" (`paybackFromApp`). Absent — a Wealthfolio before
   *  3.9, no companion, or one older than 1.62.0 — it is never offered. */
  payback?: AppPaybackActions;
}

/** The add-on's own Undo, Sync now, Remove for good and "It's a payback…" —
 *  Undo and Sync now are the ones Settings → Change log uses. `onPaidBack`:
 *  a payback was filed (the needs-a-category list drops its row at once). */
export function useTxStoryActions(
  ctx: AddonContext, store: SecretsStore, companionVersion: string | null, onPaidBack?: (activityId: string, message: string) => void,
): TxStoryActions {
  const undo = useCallback(
    (entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp) => undoFromApp(ctx, store, entry, entries, op),
    [ctx, store],
  );
  const onSyncNow = useCallback(async () => syncNowSentence(await runSync(ctx, store, { force: true })), [ctx, store]);
  const remove = useCallback((activityId: string, fingerprint: string) => removeFromApp(ctx, store, activityId, fingerprint), [ctx, store]);
  // W11: offered only on a 3.9+ host with a companion of 1.62.0 or newer.
  const [paybacks, setPaybacks] = useState(false);
  useEffect(() => {
    let live = true;
    setPaybacks(false);
    appPaybacksOffered(ctx, companionVersion).then((yes) => { if (live) setPaybacks(yes); }, () => {});
    return () => { live = false; };
  }, [ctx, companionVersion]);
  const payback = useMemo<AppPaybackActions | undefined>(() => (paybacks
    ? {
      categories: () => readPaybackCategories(ctx),
      file: async (activityId, categoryId, shown) => {
        const out = await paybackFromApp(ctx, store, { activityId, categoryId, ...(shown ? { shown } : {}) });
        if (out.kind === 'filed') onPaidBack?.(activityId, out.message);
        return out;
      },
    }
    : undefined), [paybacks, ctx, store, onPaidBack]);
  return useMemo(
    () => ({ undo, companionVersion, onSyncNow, remove, ...(payback ? { payback } : {}) }),
    [undo, companionVersion, onSyncNow, remove, payback],
  );
}

```

Edit 5 of 8 in `src/components/TxStory.tsx` — replace:

```tsx
}

export function TxStoryView({ story, entries, actions, onChanged, removal }: {
  story: TxStory;
  /** The change log as read: a line's entry, and what Undo is decided against. */
```

with:

```tsx
}

export function TxStoryView({ story, entries, actions, onChanged, removal, payback }: {
  story: TxStory;
  /** The change log as read: a line's entry, and what Undo is decided against. */
```

Edit 6 of 8 in `src/components/TxStory.tsx` — replace:

```tsx
  /** 2c R2: the row as shown, when the story offers "Remove for good…". */
  removal?: { activityId: string; fingerprint: string };
}) {
  const rowActions: RowActions = {
    undo: actions.undo, companionVersion: actions.companionVersion, entries, onSyncNow: actions.onSyncNow, changed: onChanged,
  };
  const byId = new Map(entries.map((e) => [e.id, e]));
  const [removed, setRemoved] = useState<RemoveOutcome | null>(null);
  return (
    <div className="sfin-why-story">
```

with:

```tsx
  /** 2c R2: the row as shown, when the story offers "Remove for good…". */
  removal?: { activityId: string; fingerprint: string };
  /** W11: the row as shown, when it qualifies for "It's a payback…". */
  payback?: { activityId: string; fingerprint: string };
}) {
  const rowActions: RowActions = {
    undo: actions.undo, companionVersion: actions.companionVersion, entries, onSyncNow: actions.onSyncNow, changed: onChanged,
  };
  const byId = new Map(entries.map((e) => [e.id, e]));
  const [removed, setRemoved] = useState<RemoveOutcome | null>(null);
  const [paidBack, setPaidBack] = useState<AppPaybackOutcome | null>(null);
  return (
    <div className="sfin-why-story">
```

Edit 7 of 8 in `src/components/TxStory.tsx` — replace:

```tsx
              activityId={removal.activityId} fingerprint={removal.fingerprint} remove={actions.remove} onRefused={onChanged}
              result={removed} onResult={setRemoved}
            />
          )}
```

with:

```tsx
              activityId={removal.activityId} fingerprint={removal.fingerprint} remove={actions.remove} onRefused={onChanged}
              result={removed} onResult={setRemoved}
            />
          )}
        </div>
      )}
      {actions.payback && (
        <div className="sfin-why-remove">
          {/* Mounted from the first render, and kept when a re-read stops offering it. */}
          <div role="status" className="sfin-subtle"><MessageLines message={paidBack?.message} /></div>
          {payback && (
            <PaybackAction
              activityId={payback.activityId} shown={payback.fingerprint} actions={actions.payback}
              onOutcome={(out) => { setPaidBack(out); onChanged(); }}
            />
          )}
```

Edit 8 of 8 in `src/components/TxStory.tsx` — replace:

```tsx
      </div>
      {shown !== 'loading' && shown.kind === 'ok' && (
        <TxStoryView story={shown.story} entries={shown.entries} actions={actions} onChanged={changed} removal={shown.removal} />
      )}
    </>
```

with:

```tsx
      </div>
      {shown !== 'loading' && shown.kind === 'ok' && (
        <TxStoryView story={shown.story} entries={shown.entries} actions={actions} onChanged={changed} removal={shown.removal} payback={shown.payback} />
      )}
    </>
```

Edit 1 of 6 in `src/components/UncategorizedList.tsx` — replace:

```tsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from './ui';
import type { DismissalLedger, UncategorizedRow } from '../../shared/uncategorized';
```

with:

```tsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MessageLines, PaybackAction, type AppPaybackActions } from './PaybackAction';
import { Button } from './ui';
import type { DismissalLedger, UncategorizedRow } from '../../shared/uncategorized';
```

Edit 2 of 6 in `src/components/UncategorizedList.tsx` — replace:

```tsx
 */
export function UncategorizedList({
  rows, total, id, onDismiss, justDismissed, onUndo, onOpenActivities, renderStory,
}: {
  rows: UncategorizedRow[];
```

with:

```tsx
 */
export function UncategorizedList({
  rows, total, id, onDismiss, justDismissed, onUndo, onOpenActivities, renderStory, payback, paybackNote,
}: {
  rows: UncategorizedRow[];
```

Edit 3 of 6 in `src/components/UncategorizedList.tsx` — replace:

```tsx
   *  Absent: rows stay plain text, as before. */
  renderStory?: (target: AppStoryTarget) => React.ReactNode;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
```

with:

```tsx
   *  Absent: rows stay plain text, as before. */
  renderStory?: (target: AppStoryTarget) => React.ReactNode;
  /** W11: "It's a payback…" under each row the companion marks
   *  `paybackEligible`. Absent: never offered (a Wealthfolio before 3.9, no
   *  companion, or one older than 1.62.0). */
  payback?: AppPaybackActions;
  /** W11: what the last payback filed from the app said (its row has left the list). */
  paybackNote?: string | null;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
```

Edit 4 of 6 in `src/components/UncategorizedList.tsx` — replace:

```tsx
  // confirm` doesn't work in this sandbox, so the undo affordance IS the
  // confirmation; it cannot be allowed to vanish along with the row it's for.
  if (rows.length === 0 && !justDismissed) return null;
  const capped = rows.length < total;
  return (
```

with:

```tsx
  // confirm` doesn't work in this sandbox, so the undo affordance IS the
  // confirmation; it cannot be allowed to vanish along with the row it's for.
  if (rows.length === 0 && !justDismissed && !paybackNote) return null;
  const capped = rows.length < total;
  return (
```

Edit 5 of 6 in `src/components/UncategorizedList.tsx` — replace:

```tsx
        </div>
      )}
      {rows.map((r) => (
        <React.Fragment key={r.activityId}>
```

with:

```tsx
        </div>
      )}
      {/* Mounted while paybacks are offered, so a filing's words are announced. */}
      {payback && <div role="status" className="sfin-subtle"><MessageLines message={paybackNote} /></div>}
      {rows.map((r) => (
        <React.Fragment key={r.activityId}>
```

Edit 6 of 6 in `src/components/UncategorizedList.tsx` — replace:

```tsx
            </Button>
          </div>
          {renderStory && openId === r.activityId && (
            <div className="sfin-why-inline" id={`sfin-why-story-${r.activityId}`}>{renderStory({ activityId: r.activityId })}</div>
```

with:

```tsx
            </Button>
          </div>
          {payback && r.paybackEligible === true && (
            <PaybackAction
              inlineStatus activityId={r.activityId} actions={payback}
              label={`${r.description}, ${money(r.amountCents)} on ${r.date}`}
            />
          )}
          {renderStory && openId === r.activityId && (
            <div className="sfin-why-inline" id={`sfin-why-story-${r.activityId}`}>{renderStory({ activityId: r.activityId })}</div>
```

Edit 1 of 6 in `src/tabs/HomeTab.tsx` — replace:

```tsx
import { money, accountsSummary } from '../components/AccountList';
import { shortDate } from '../../shared/telegram';
import { visibleUncategorized, type DismissalLedger } from '../../shared/uncategorized';
import type { TabId } from '../components/Tabs';
// Card ids only — the banner's CTA has to name the card it opens, and the
```

with:

```tsx
import { money, accountsSummary } from '../components/AccountList';
import { shortDate } from '../../shared/telegram';
import { paidBackHidden, visibleUncategorized, type DismissalLedger, type PaidBackLedger } from '../../shared/uncategorized';
import type { AppPaybackActions } from '../components/PaybackAction';
import type { TabId } from '../components/Tabs';
// Card ids only — the banner's CTA has to name the card it opens, and the
```

Edit 2 of 6 in `src/tabs/HomeTab.tsx` — replace:

```tsx
   *  days" tile. Absent or null until read; cashForecastView decides. */
  cashForecast?: CashForecastRead | null;
}

```

with:

```tsx
   *  days" tile. Absent or null until read; cashForecastView decides. */
  cashForecast?: CashForecastRead | null;
  /** W11: "It's a payback…" on the needs-a-category list; absent: not offered. */
  payback?: AppPaybackActions;
  /** W11: rows filed as a payback since the companion's publish. Held by the
   *  SHELL, like `dismissals`: they leave the list at once, on any tab. */
  paidBack?: PaidBackLedger;
  /** W11: what the last payback filed from the app said. */
  paybackNote?: string | null;
}

```

Edit 3 of 6 in `src/tabs/HomeTab.tsx` — replace:

```tsx
  companionVersion, telegramConfigured, amazonConfigured, checklistDismissed,
  onDismissChecklist, onNavigate, poolStatus, onOpenPool, renderTxStory, auditSnapshot, cashForecast,
}: Props) {
  const checksToLook = healthIssueCount(auditSnapshot);
```

with:

```tsx
  companionVersion, telegramConfigured, amazonConfigured, checklistDismissed,
  onDismissChecklist, onNavigate, poolStatus, onOpenPool, renderTxStory, auditSnapshot, cashForecast,
  payback, paidBack, paybackNote,
}: Props) {
  const checksToLook = healthIssueCount(auditSnapshot);
```

Edit 4 of 6 in `src/tabs/HomeTab.tsx` — replace:

```tsx
  );

  const visibleRows = uncategorized
    ? visibleUncategorized(uncategorized.rows, dismissals)
    : [];
  // The tile subtracts locally-known dismissals so it can never disagree with
```

with:

```tsx
  );

  // W11: a row filed as a payback leaves at once, as a dismissed one does.
  const paidBackIds = uncategorized ? paidBackHidden(uncategorized.rows, paidBack ?? {}, uncategorized.asOf) : new Set<string>();
  const visibleRows = uncategorized
    ? visibleUncategorized(uncategorized.rows, dismissals).filter((r) => !paidBackIds.has(r.activityId))
    : [];
  // The tile subtracts locally-known dismissals so it can never disagree with
```

Edit 5 of 6 in `src/tabs/HomeTab.tsx` — replace:

```tsx
  const uncatCount = uncategorized
    ? Math.max(0, uncategorized.count - Object.keys(dismissals)
        .filter((id) => uncategorized.rows.some((r) => r.activityId === id)).length)
    : 0;

```

with:

```tsx
  const uncatCount = uncategorized
    ? Math.max(0, uncategorized.count - Object.keys(dismissals)
        .filter((id) => uncategorized.rows.some((r) => r.activityId === id)).length
        - [...paidBackIds].filter((id) => !(id in dismissals)).length)
    : 0;

```

Edit 6 of 6 in `src/tabs/HomeTab.tsx` — replace:

```tsx
          onOpenActivities={() => { ctx.api.navigation.navigate('/activities').catch(() => {}); }}
          renderStory={renderTxStory}
        />
      )}
```

with:

```tsx
          onOpenActivities={() => { ctx.api.navigation.navigate('/activities').catch(() => {}); }}
          renderStory={renderTxStory}
          payback={payback}
          paybackNote={paybackNote}
        />
      )}
```

Edit 1 of 3 in `src/pages/SyncPage.tsx` — replace:

```tsx
import type { Scheduler } from '../utils/scheduler';
import type { AccountMapping, UnmappedAccount } from '../../shared/types';
import { pruneDismissals, mergeDismissals, type DismissalLedger } from '../../shared/uncategorized';
import {
  emptySubscriptionPrefs, isUnreadablePrefsError, type LoadedSubscriptionPrefs, type SubscriptionEdit,
```

with:

```tsx
import type { Scheduler } from '../utils/scheduler';
import type { AccountMapping, UnmappedAccount } from '../../shared/types';
import { pruneDismissals, mergeDismissals, type DismissalLedger, type PaidBackLedger } from '../../shared/uncategorized';
import {
  emptySubscriptionPrefs, isUnreadablePrefsError, type LoadedSubscriptionPrefs, type SubscriptionEdit,
```

Edit 2 of 3 in `src/pages/SyncPage.tsx` — replace:

```tsx
  // addon works standalone, so no companion is normal, not an error.
  const [companionVersion, setCompanionVersion] = useState<string | null>(null);
  // "Why is this here?" (1.61): one story renderer for Home and the budget
  // drill-down, with the Change log card's own Undo and Sync now.
  const storyActions = useTxStoryActions(ctx, store, companionVersion);
  const loadStory = useCallback((target: AppStoryTarget) => appTxStory(ctx, store, target, new Date()), [ctx, store]);
  const renderTxStory = useCallback(
```

with:

```tsx
  // addon works standalone, so no companion is normal, not an error.
  const [companionVersion, setCompanionVersion] = useState<string | null>(null);
  // W11: rows filed as a payback from the app since the companion's last
  // publish, and what the last one said. Here, not in HomeTab: a payback filed
  // from a story on the budget must leave Home's list too, and tabs unmount.
  const [paidBack, setPaidBack] = useState<PaidBackLedger>({});
  const [paybackNote, setPaybackNote] = useState<string | null>(null);
  const onPaidBack = useCallback((activityId: string, message: string) => {
    setPaidBack((prev) => ({ ...prev, [activityId]: new Date().toISOString() }));
    setPaybackNote(message);
  }, []);
  // "Why is this here?" (1.61): one story renderer for Home and the budget
  // drill-down, with the Change log card's own Undo and Sync now.
  const storyActions = useTxStoryActions(ctx, store, companionVersion, onPaidBack);
  const loadStory = useCallback((target: AppStoryTarget) => appTxStory(ctx, store, target, new Date()), [ctx, store]);
  const renderTxStory = useCallback(
```

Edit 3 of 3 in `src/pages/SyncPage.tsx` — replace:

```tsx
          cashForecast={cashForecast}
          renderTxStory={renderTxStory}
        />
        <BudgetTab
```

with:

```tsx
          cashForecast={cashForecast}
          renderTxStory={renderTxStory}
          payback={storyActions.payback}
          paidBack={paidBack}
          paybackNote={paybackNote}
        />
        <BudgetTab
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npx vitest run --maxWorkers=2 shared/uncategorized-paidback.test.ts src/components/PaybackAction.test.tsx src/pages/payback-app.test.tsx src/components/TxStory.test.tsx src/components/TxStory-remove.test.tsx src/components/UncategorizedList.test.tsx src/tabs/HomeTab.test.tsx src/pages/SyncPage.test.tsx src/pages/copy-policy.test.tsx`
Expected: PASS — 148 tests (9 files).

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/uncategorized.ts src/components/PaybackAction.tsx src/components/TxStory.tsx src/components/UncategorizedList.tsx src/tabs/HomeTab.tsx src/pages/SyncPage.tsx shared/uncategorized-paidback.test.ts src/components/PaybackAction.test.tsx src/pages/payback-app.test.tsx
git commit -m "Paybacks in the app: It's a payback… on the needs-a-category list and on a story; a filed row leaves at once (W11)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Docs, and W11's forced-date run

The CHANGELOG under `[Unreleased]` (no version bump here), the README's Home paragraph, and follow-ups §17: W11 shipped, and what it leaves open. Then every W11 test file once more with the system date forced to 2027-01-01, through throwaway files inside the checkout, deleted after.

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `docs/superpowers/follow-ups.md`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: nothing.

- [ ] **Step 1: Write the docs**

Edit 1 of 1 in `CHANGELOG.md` — replace:

```markdown
  changed elsewhere — reload them first." — so the companion's payback rule is
  never silently dropped.

### Changed
- **Updating: Install from File, and the add-on zip first.**
  - **New permissions.** Wealthfolio's Update button refuses an update that
    adds permissions. Install 1.62.0 over the installed add-on with Install
    from File (don't remove it first) and approve: linking and unlinking
    transfers, reading how Wealthfolio files and links each transaction, and
    your spending categories' names.
  - **The add-on zip before the companion, or together with it.** The
    companion's two one-time passes, the date repair (under Fixed) and the
```

with:

```markdown
  changed elsewhere — reload them first." — so the companion's payback rule is
  never silently dropped.
- **Paybacks in the app** (Wealthfolio 3.9 and newer, with a companion of
  1.62.0 or newer). A posted deposit on Home's needs-a-category list, and its
  story, offers **It's a payback…**: pick the spending it pays back ("Pick the
  spending it pays you back for.") and **File it**. It becomes a payback as in
  Telegram — the `asReimbursement` override, then a `CREDIT` marked
  `REIMBURSEMENT` — and leaves the list at once: "Filed as a payback under
  Restaurants — it takes $14 off your Food & Dining spending. Undo it from
  Telegram: /changes." The add-on SDK cannot file one transaction, so the
  add-on makes a one-off Wealthfolio rule that matches only that row
  ("Payback (one-off) — <bank words>"), runs Wealthfolio's rules over the rows
  with no category, reads the filing back and deletes the rule; Wealthfolio
  records the filing as a rule's. The rule is made before the row is
  re-typed, so it wins over an older rule for paybacks; if another rule still
  filed it first, the reply names that category. A one-off rule that could
  not be deleted is named, and the next payback from the app deletes it.
  Refused in its own words, with nothing written: a row already filed under
  any category ("take that off in Wealthfolio first" — the add-on cannot take
  a filing off), an account Wealthfolio's Spending does not track, half of a
  linked transfer, a row that changed since its story showed it, and
  everything Telegram refuses. The change log names the category Wealthfolio
  confirmed, and when the entry could not be written the reply says there is
  no Undo. It is not offered on Wealthfolio 3.8, without a companion, or with
  a companion older than 1.62.0, which would turn the payback back into a
  deposit.
- **A payback's story says so**, in the app and in `/why`: "A payback: it
  lowers your spending." instead of "Money in.", and "Filed under Restaurants
  by you, as a payback" — a payback filed from `/categorize` used to read
  "set by hand".

### Changed
- **Updating: Install from File, and the add-on zip first.**
  - **New permissions.** Wealthfolio's Update button refuses an update that
    adds permissions. Install 1.62.0 over the installed add-on with Install
    from File (don't remove it first) and approve: linking and unlinking
    transfers, reading how Wealthfolio files and links each transaction,
    your spending categories' names, and making, running and deleting the
    one-off rule that files a payback from the app.
  - **The add-on zip before the companion, or together with it.** The
    companion's two one-time passes, the date repair (under Fixed) and the
```

Edit 1 of 1 in `README.md` — replace:

```markdown
  sync, accounts, anything that needs you; a needs-a-category row opens its
  story, and shows the category you probably meant when you filed the same
  merchant that way before; with the companion, **Next 30 days** — your cash
  if nothing comes in: cash today, minus your known bills on their dates and a
  typical day of other spending — which opens what it counted),
```

with:

```markdown
  sync, accounts, anything that needs you; a needs-a-category row opens its
  story, and shows the category you probably meant when you filed the same
  merchant that way before; a deposit there that pays you back — a friend's
  Venmo for dinner — offers **It's a payback…** (Wealthfolio 3.9 or newer,
  with the companion): pick the spending it pays back and it comes off that
  spending, with Undo in Telegram's `/changes`; with the companion, **Next 30 days** — your cash
  if nothing comes in: cash today, minus your known bills on their dates and a
  typical day of other spending — which opens what it counted),
```

Edit 1 of 1 in `docs/superpowers/follow-ups.md` — replace:

```markdown
branches.

- **W11 (paybacks in the app) is next**, its own small plan. It consumes the
  fixed interface this part ships: the `asReimbursement` override, the
  `payback-filed` change kind (`paybackFiledChange`), `PAYBACK_SINCE` /
  `companionUnderstandsPaybacks`, and the pure `planPayback`. Nothing of W11
  is in this part: the app cannot file or undo a payback yet.
- **Telegram's paybacks wait for an installed add-on of 1.62.0.** A companion
  that cannot see the add-ons directory reads it as unknown and refuses, as
```

with:

```markdown
branches.

- **W11 (paybacks in the app) shipped in this release** (plan
  `2026-10-14-w11-app-paybacks.md`): **It's a payback…** on the
  needs-a-category list and on a story, on Wealthfolio 3.9+ with a companion
  of 1.62.0+. What it leaves open:
  - **The filing is a rule's in Wealthfolio** (`source: rule`): the add-on
    SDK has no call that files one row, so a one-off rule (CREDIT only, the
    exact note, the account, priority 1,000,000, key
    `payback-once:<accountId>:<txId>`) files it and is deleted after. The
    stories tell "by you, as a payback" from the change log.
  - **A one-off rule left behind** is named in the reply and swept by the
    next payback from the app, its key rebuilt from the account and the tx
    id in its pattern. One edited in Wealthfolio to another priority, type or
    pattern is no longer recognised; delete it there.
  - **Two app windows filing at once**: one window's sweep can delete the
    other's rule before its rule run; that one then says Wealthfolio did not
    file it, and the row is a payback with no category — file it in
    Wealthfolio.
  - **Couldn't tell what it was filed under** (the read-back failed): the
    entry is logged with no category, so if Wealthfolio did file it,
    Telegram's Undo turns it back into a deposit but leaves that filing on —
    take it off in Wealthfolio.
  - **The list offers it only on rows a 1.62 companion marks**
    (`paybackEligible`): until the companion's first 1.62 publish, only the
    story offers it.
- **Telegram's paybacks wait for an installed add-on of 1.62.0.** A companion
  that cannot see the add-ons directory reads it as unknown and refuses, as
```

- [ ] **Step 2: Run every W11 test file with the date forced to 2027-01-01**

Nothing may depend on the real clock. A throwaway setup file fakes `Date` before every test; none of it is committed.

```sh
cd "/Users/nawrig04/Personal Projects/wf-release" && cat > zz-2027.setup.ts <<'EOF'
import { beforeEach, vi } from 'vitest';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-01-01T12:00:00Z')); });
EOF
cp zz-2027.setup.ts companion/zz-2027.setup.ts
cat > zz-2027.config.mts <<'EOF'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', globals: true, testTimeout: 15000, setupFiles: ['./src/test-setup.ts', './zz-2027.setup.ts'] } });
EOF
cat > companion/zz-2027.config.mts <<'EOF'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true, setupFiles: ['./zz-2027.setup.ts'] } });
EOF
nice npx vitest run --maxWorkers=2 --config zz-2027.config.mts shared/payback-app.test.ts shared/payback-app-file.test.ts src/utils/app-payback.test.ts shared/tx-story-payback.test.ts src/utils/tx-story-payback.test.ts shared/uncategorized-paidback.test.ts src/components/PaybackAction.test.tsx src/pages/payback-app.test.tsx
(cd companion && nice npx vitest run --maxWorkers=2 --config zz-2027.config.mts src/uncategorized-status.test.ts src/tx-story-host.test.ts)
rm zz-2027.setup.ts zz-2027.config.mts companion/zz-2027.setup.ts companion/zz-2027.config.mts
git status --short
```

Expected: PASS — 145 tests (root, 8 files) and 49 tests (companion, 2 files). `git status --short` lists only the three files Step 1 changed.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md README.md docs/superpowers/follow-ups.md
git commit -m "Paybacks in the app: docs — the CHANGELOG, the README, follow-ups §17 (W11)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Integration fixes, and the release version (LAST)

The integration review of `release/1.62.0` at 8505228 approved the merge with five minor findings; Minor 2 is Task 4's. This task closes the other four, each test first, then makes the release 1.62.0 — last, because a release guard (Minor 5) can only pass once the build ships as 1.62.0, and every earlier task was verified on 1.61.0.

- **Minor 1 — Link must refuse a payback.** Today Link re-creates a payback as a TRANSFER_IN (its probe: legs `TRANSFER_OUT` + `TRANSFER_IN` from a payback row) and loses its payback and its filing. `checkLinkPair` refuses a row the `asReimbursement` setting is on, or a cash CREDIT marked REIMBURSEMENT, in its own words; Health's counterpart finder skips a row the setting is on, from the overrides `gatherHealthFacts` now reads.
- **Minor 3 — W10 logs strictly.** `companionPaybackRulesIo.record` goes through `recordCompanionChangesStrict`; when an entry was not written, the Done reply drops "Undo either rule from /changes".
- **Minor 4 — the refused ids are capped.** A `card-transfer-out` or `date-repair` entry lists at most 200 refused ids (`BOOKKEEPING_REFUSED_IDS`), with `refusedCount` beside them; the summary counts them all.
- **Minor 5 — release guards.** `DATE_REPAIR_SINCE` (and `PAYBACK_SINCE`) in the root suite and `CARD_REWRITE_ADDON_SINCE` in the companion's are never above `SIMPLEFIN_SYNC_VERSION` — RED until the bump, which follows: `manifest.json`, `package.json`, `shared/version.ts`, the `package-lock.json` root (both places), and the CHANGELOG's `## [1.62.0] - 2026-10-15` under an empty `## [Unreleased]`.

**Files:**
- Modify: `shared/audit-link.ts`, `shared/audit-health.ts`, `companion/src/audit-facts.ts`, `shared/payback.ts`, `shared/payback-copy.ts`, `companion/src/payback-host.ts`, `shared/change-entries.ts`, `CHANGELOG.md`, `docs/superpowers/follow-ups.md`; then `shared/version.ts`, `manifest.json`, `package.json`, `package-lock.json`, `CHANGELOG.md`
- Test: `shared/link-payback.test.ts`, `companion/src/audit-facts-payback.test.ts`, `shared/bookkeeping-refused.test.ts`, `shared/release-guards.test.ts`, `companion/src/release-guards.test.ts` (create); `shared/payback-rules.test.ts`, `companion/src/payback-host.test.ts` (modify)

**Interfaces:**
- Consumes: `isPaybackRow` (shared/payback-row.ts), `loadSyncOverrides`/`hasTxOverride` (sync-overrides), `recordCompanionChangesStrict` (companion/src/change-log-host.ts), `isNewerVersion` (shared/version.ts).
- Produces:

```ts
// shared/audit-link.ts
export const LINK_PAYBACK = 'One of these is a payback, not half of a transfer — nothing was linked.';
// shared/audit-health.ts
HealthFacts.overrides?: SyncOverrides;
// shared/payback-copy.ts
paybackRulesDone(pattern, accountName, categoryName, undoable = true): string;
// shared/change-entries.ts
export const BOOKKEEPING_REFUSED_IDS = 200; // after: { refused: first 200, refusedCount: total }
// shared/version.ts
SIMPLEFIN_SYNC_VERSION === '1.62.0'
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/link-payback.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import { healthIssues, type HealthFacts, type HealthIssue, type HealthLeg } from './audit-health';
import type { AuditAccount, AuditLedgerRow } from './audit-ledger';
import { checkLinkPair, LINK_PAYBACK, type LinkPair, type ReadRow } from './audit-link';
import type { FixRow } from './fix-row';
import { emptySyncOverrides, setTxOverride } from './sync-overrides';
import { accountTxKey } from './transfers';

const NOW = new Date('2026-10-14T15:00:00Z');
const OUT_KEY = accountTxKey('sfin-ally', 'TRN-1');
const IN_KEY = accountTxKey('sfin-chk', 'TRN-77');
const OUT: HealthLeg = {
  activityId: 'out-1', accountId: 'wf-ally', accountName: 'Ally Savings', txKey: OUT_KEY, date: '2026-10-08', absCents: 1400,
  type: 'TRANSFER_OUT', currency: 'USD', description: 'TRANSFER TO PNC',
};
const PAYBACK: HealthLeg = {
  activityId: 'act-7', accountId: 'wf-chk', accountName: 'PNC Checking', txKey: IN_KEY, date: '2026-10-09', absCents: 1400,
  type: 'CREDIT', currency: 'USD', description: 'VENMO CASHOUT',
};
const PAIR: LinkPair = { key: 'leg:out-1', leg: OUT, counterpart: PAYBACK };
const row = (l: HealthLeg, over: Partial<FixRow> = {}): FixRow => ({
  id: l.activityId, accountId: l.accountId, accountName: l.accountName, accountType: 'CASH', type: l.type, date: l.date,
  absCents: l.absCents, feeCents: 0, currency: 'USD', notes: `${l.description} · ${l.txKey!.split('\u0000')[1]}`,
  subtype: null, flowExternal: null, grouped: false, ...over,
});
const read = (b: Partial<FixRow> = {}): [ReadRow, ReadRow] => [{ row: row(OUT), linked: false }, { row: row(PAYBACK, b), linked: false }];
const flagged = setTxOverride(emptySyncOverrides(), IN_KEY, 'asReimbursement', NOW, { label: 'VENMO CASHOUT · PNC Checking' });

describe('Link never takes a payback for half of a transfer (1.62)', () => {
  it('refuses a row the payback setting is on, in its own words', () => {
    expect(checkLinkPair(PAIR, read(), flagged)).toEqual({ ok: false, reason: LINK_PAYBACK });
    expect(LINK_PAYBACK).toBe('One of these is a payback, not half of a transfer — nothing was linked.');
  });

  it('refuses a cash CREDIT marked REIMBURSEMENT with no setting (a payback rule typed it)', () => {
    expect(checkLinkPair(PAIR, read({ subtype: 'REIMBURSEMENT' }), emptySyncOverrides())).toEqual({ ok: false, reason: LINK_PAYBACK });
  });

  it('still links a plain CREDIT, and a card credit marked REIMBURSEMENT', () => {
    expect(checkLinkPair(PAIR, read(), emptySyncOverrides()).ok).toBe(true);
    expect(checkLinkPair(PAIR, read({ subtype: 'REIMBURSEMENT', accountType: 'CREDIT_CARD' }), emptySyncOverrides()).ok).toBe(true);
  });
});

describe("Health never offers a payback as a transfer's other half (1.62)", () => {
  const acct = (id: string, name: string): AuditAccount => ({ id, name, type: 'CASH', archived: false, active: true });
  const ledgerRow = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
    id: 'r', accountId: 'wf-chk', date: '2026-10-08', currency: 'USD', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', status: 'POSTED',
    absCents: 1400, group: '', assetId: '', external: false, phantomCash: false, notes: '', ...over,
  });
  const facts = (over: Partial<HealthFacts> = {}): HealthFacts => ({
    ledger: {
      accounts: [acct('wf-chk', 'PNC Checking'), acct('wf-ally', 'Ally Savings')],
      rows: [
        ledgerRow({ id: 'out-1', accountId: 'wf-ally', notes: 'TRANSFER TO PNC · TRN-1' }),
        ledgerRow({ id: 'act-7', accountId: 'wf-chk', rawType: 'CREDIT', type: 'CREDIT', date: '2026-10-09', notes: 'VENMO CASHOUT · TRN-77' }),
      ],
    },
    mapping: { 'sfin-chk': 'wf-chk', 'sfin-ally': 'wf-ally' },
    ...over,
  });
  const leg = (issues: HealthIssue[] | null) => (issues ?? []).find((i) => i.kind === 'incomplete-leg' && i.leg.activityId === 'out-1');

  it('skips a row the payback setting is on', () => {
    expect(leg(healthIssues(facts()).issues)).toMatchObject({ match: 'one', counterpart: expect.objectContaining({ activityId: 'act-7' }) });
    expect(leg(healthIssues(facts({ overrides: flagged })).issues)).toMatchObject({ match: 'none', counterpart: null });
  });
});
```

**Create `companion/src/audit-facts-payback.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import { emptySyncOverrides, setTxOverride, SYNC_OVERRIDES_SECRET_KEY } from '../../shared/sync-overrides.js';
import { accountTxKey } from '../../shared/transfers.js';
import { gatherHealthFacts, type AuditReaders } from './audit-facts.js';

const KEY = accountTxKey('sfin-chk', 'TRN-77');
const FLAGGED = setTxOverride(emptySyncOverrides(), KEY, 'asReimbursement', new Date('2026-10-14T15:00:00Z'), { label: 'VENMO CASHOUT · PNC Checking' });
const readers = (secrets: Record<string, string | null>): AuditReaders => ({
  secret: async (k) => {
    if (secrets[k] === undefined) return null;
    if (secrets[k] === 'THROW') throw new Error('401');
    return secrets[k];
  },
  valuations: async () => [],
  accounts: async () => [],
  ledger: () => ({ accounts: [], rows: [] }),
  headlineRows: () => [],
  settings: () => ({ timezone: null, excludedCategoryIds: [], categoryParents: {}, spendingOn: true, spendingAccountIds: [] }),
  spendingSpent: async () => 0,
});

describe("Health's facts carry the payback setting (1.62)", () => {
  it('reads the overrides, so a payback is never offered as the other half of a transfer', async () => {
    const facts = await gatherHealthFacts(readers({ account_mapping: '{}', [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(FLAGGED) }), { accounts: [], rows: [] });
    expect(facts.overrides).toEqual(FLAGGED);
  });

  it.each<[string, string]>([['unreadable', '{oops'], ['unreachable', 'THROW']])('knows none when they are %s, and checks Health as before', async (_name, raw) => {
    const facts = await gatherHealthFacts(readers({ account_mapping: '{}', [SYNC_OVERRIDES_SECRET_KEY]: raw }), { accounts: [], rows: [] });
    expect(facts.overrides).toBeUndefined();
    expect(facts.failed).toBeUndefined();
  });
});
```

Edit 1 of 1 in `shared/payback-rules.test.ts` — replace:

```ts
    expect(w.logged[0].after).toMatchObject({ index: 0, rule: { since: TODAY } });
    expect(w.logged[1].after).toMatchObject({ ruleId: 'rule-9', accountId: 'wf-chk', activityType: 'CREDIT' });
  });

```

with:

```ts
    expect(w.logged[0].after).toMatchObject({ index: 0, rule: { since: TODAY } });
    expect(w.logged[1].after).toMatchObject({ ruleId: 'rule-9', accountId: 'wf-chk', activityType: 'CREDIT' });
  });

  it('promises no Undo when a change-log entry was not written; both rules stand', async () => {
    const w = world({ io: { record: vi.fn(async () => { throw new Error('the change log was not written'); }) } });
    expect(await makePaybackRules(INPUT, w.io, NOW)).toEqual({
      ok: true, message: 'Done — every JANE DOE VENMO deposit into PNC Checking is a payback under Restaurants from now on.',
    });
    expect(w.mapping()).toEqual([RULE, GLOBAL]);
    expect(w.io.createCategoryRule).toHaveBeenCalled();
    expect(w.io.log).toHaveBeenCalledWith(expect.stringContaining('the change log was not written'));
  });

```

Edit 1 of 1 in `companion/src/payback-host.test.ts` — replace:

```ts

describe('"Make every … deposit a payback" on the companion (W10)', () => {
  it('appends the transaction rule and asks Wealthfolio for a rule that files paybacks in that account only', async () => {
    const f = fakeClient();
```

with:

```ts

describe('"Make every … deposit a payback" on the companion (W10)', () => {
  it('logs both rules through the strict append: when the change log cannot be written, the reply promises no Undo', async () => {
    const f = fakeClient();
    f.client.setAddonSecret.mockImplementation(async (_a: string, k: string, v: string) => {
      if (k.startsWith('change_log:')) throw new Error('500 from Wealthfolio');
      f.data.set(k, v);
    });
    const client = Object.assign(f.client, {
      listCategorizationRules: vi.fn(async () => []),
      createCategorizationRule: vi.fn(async () => 'rule-9'),
    }) as unknown as PaybackRulesClient;
    const out = await makePaybackRules({
      pattern: 'ACME REFUND', account: { id: 'wf-chk', name: 'PNC Checking' }, categoryId: 'cat-rest', categoryName: 'Restaurants', description: 'ACME REFUND',
    }, companionPaybackRulesIo(client, vi.fn()), NOW);
    expect(out).toEqual({ ok: true, message: 'Done — every ACME REFUND deposit into PNC Checking is a payback under Restaurants from now on.' });
  });

  it('appends the transaction rule and asks Wealthfolio for a rule that files paybacks in that account only', async () => {
    const f = fakeClient();
```

**Create `shared/bookkeeping-refused.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import { bookkeepingChange, BOOKKEEPING_REFUSED_IDS } from './change-entries';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);

describe('a one-time pass names at most 200 rows Wealthfolio refused (1.62)', () => {
  it.each(['date-repair', 'card-transfer-out'] as const)('%s: lists the first 200, counts them all', (step) => {
    const entry = bookkeepingChange({ step, activityIds: ['a1'], refused: ids(250) });
    expect(BOOKKEEPING_REFUSED_IDS).toBe(200);
    expect(entry.after).toMatchObject({ refused: ids(200), refusedCount: 250 });
    expect(entry.summary).toContain('Wealthfolio refused 250 rows');
  });

  it('lists a short list whole, with its count', () => {
    expect(bookkeepingChange({ step: 'date-repair', activityIds: [], refused: ['x', 'y'] }).after).toMatchObject({ refused: ['x', 'y'], refusedCount: 2 });
  });
});
```

**Create `shared/release-guards.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import { DATE_REPAIR_SINCE } from './date-repair';
import { isNewerVersion, PAYBACK_SINCE, SIMPLEFIN_SYNC_VERSION } from './version';

/** A gate above the version this build ships as would wait for itself forever. */
describe('the 1.62 gates are never above the version this build ships as', () => {
  it.each<[string, string]>([['DATE_REPAIR_SINCE', DATE_REPAIR_SINCE], ['PAYBACK_SINCE', PAYBACK_SINCE]])('%s', (_name, since) => {
    expect(isNewerVersion(since, SIMPLEFIN_SYNC_VERSION)).toBe(false);
  });
});
```

**Create `companion/src/release-guards.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import { isNewerVersion, SIMPLEFIN_SYNC_VERSION } from '../../shared/version.js';
import { CARD_REWRITE_ADDON_SINCE } from './card-bookkeeping-rewrite.js';

/** A gate above the version this build ships as would wait for itself forever. */
describe("the card rewrite's add-on gate", () => {
  it('is never above the version this build ships as', () => {
    expect(isNewerVersion(CARD_REWRITE_ADDON_SINCE, SIMPLEFIN_SYNC_VERSION)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npx vitest run --maxWorkers=2 shared/link-payback.test.ts shared/bookkeeping-refused.test.ts shared/release-guards.test.ts shared/payback-rules.test.ts`
Expected: FAIL — 9 failed, 47 passed (56), in all four files: `link-payback` 3 (`refuses a row the payback setting is on…`, `refuses a cash CREDIT marked REIMBURSEMENT…`, `skips a row the payback setting is on`), `payback-rules` 1 (`promises no Undo when a change-log entry was not written…`), `bookkeeping-refused` 3, `release-guards` 2 (`DATE_REPAIR_SINCE`, `PAYBACK_SINCE`: 1.62.0 is above the 1.61.0 build).

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && cd companion && nice npx vitest run --maxWorkers=2 src/audit-facts-payback.test.ts src/release-guards.test.ts src/payback-host.test.ts`
Expected: FAIL — 3 failed, 18 passed (21): `reads the overrides, so a payback is never offered…`, `logs both rules through the strict append…`, and the card rewrite's `is never above the version this build ships as`.

- [ ] **Step 3: Implement the fixes**

Edit 1 of 4 in `shared/audit-link.ts` — replace:

```ts
 * written — "It has changed since — nothing was linked." — when either row
 * changed account, amount, date or type; is linked, or may be (the add-on);
 * carries a `notTransfer` override; is pending (the sync never pairs one); is
 * the add-on's own in-transit placeholder, opening balance or correction; or
 * no longer carries the tx id its Health leg named. Money leaving a card is
```

with:

```ts
 * written — "It has changed since — nothing was linked." — when either row
 * changed account, amount, date or type; is linked, or may be (the add-on);
 * carries a `notTransfer` override; is a payback — the `asReimbursement`
 * override, or a cash CREDIT marked REIMBURSEMENT (its own words: re-creating
 * it as a TRANSFER_IN would lose the payback and its filing); is pending (the sync never pairs one); is
 * the add-on's own in-transit placeholder, opening balance or correction; or
 * no longer carries the tx id its Health leg named. Money leaving a card is
```

Edit 2 of 4 in `shared/audit-link.ts` — replace:

```ts
import { HALF_OF_ANOTHER_TRANSFER, LINK_ANSWER_LOST } from './link-in-place.js';
import { describeLeg } from './link-pair.js';
import { descriptionFromComment, txIdFromComment } from './sync-core.js';
import type { ActivityWrite, LinkLeg, LinkResult, SaveManyResult } from './sync-host.js';
```

with:

```ts
import { HALF_OF_ANOTHER_TRANSFER, LINK_ANSWER_LOST } from './link-in-place.js';
import { describeLeg } from './link-pair.js';
import { isPaybackRow } from './payback-row.js';
import { descriptionFromComment, txIdFromComment } from './sync-core.js';
import type { ActivityWrite, LinkLeg, LinkResult, SaveManyResult } from './sync-host.js';
```

Edit 3 of 4 in `shared/audit-link.ts` — replace:

```ts
export const LINK_DROPPED = "Both rows were re-created as transfers, but Wealthfolio didn't link them.";
export const LINK_UNREACHABLE = "Couldn't reach Wealthfolio — nothing was linked.";

/** A Health leg and its one likely other half, as the list shows them. */
```

with:

```ts
export const LINK_DROPPED = "Both rows were re-created as transfers, but Wealthfolio didn't link them.";
export const LINK_UNREACHABLE = "Couldn't reach Wealthfolio — nothing was linked.";
/** One of the two is a payback (1.62): money in that comes off spending, never half of a transfer. */
export const LINK_PAYBACK = "One of these is a payback, not half of a transfer — nothing was linked.";

/** A Health leg and its one likely other half, as the list shows them. */
```

Edit 4 of 4 in `shared/audit-link.ts` — replace:

```ts
    if (!was.txKey || !txId || !was.txKey.endsWith(`\u0000${txId}`)) return changed;
    if (hasTxOverride(overrides, was.txKey, 'notTransfer')) return changed;
  }
  const outAt = pair.leg.type === 'TRANSFER_OUT' ? 0 : 1;
```

with:

```ts
    if (!was.txKey || !txId || !was.txKey.endsWith(`\u0000${txId}`)) return changed;
    if (hasTxOverride(overrides, was.txKey, 'notTransfer')) return changed;
    if (hasTxOverride(overrides, was.txKey, 'asReimbursement') || (isPaybackRow(row) && row.accountType === 'CASH')) {
      return { ok: false, reason: LINK_PAYBACK };
    }
  }
  const outAt = pair.leg.type === 'TRANSFER_OUT' ? 0 : 1;
```

Edit 1 of 4 in `shared/audit-health.ts` — replace:

```ts
 * DEPOSIT or CREDIT; a TRANSFER_IN a TRANSFER_OUT or WITHDRAWAL), POSTED and
 * not pending (the sync never pairs a ` · pending` row), within MATCH_DAYS, not already half of a valid pair, not the add-on's
 * opening balance or correction — and unique BOTH ways: the leg has exactly
 * one candidate and no other leg claims it. Anything else is "many" and is
 * never offered. The add-on's own rows (opening balances, corrections,
```

with:

```ts
 * DEPOSIT or CREDIT; a TRANSFER_IN a TRANSFER_OUT or WITHDRAWAL), POSTED and
 * not pending (the sync never pairs a ` · pending` row), within MATCH_DAYS, not already half of a valid pair, not the add-on's
 * opening balance or correction, not a row the payback setting is on (1.62:
 * Link refuses a payback) — and unique BOTH ways: the leg has exactly
 * one candidate and no other leg claims it. Anything else is "many" and is
 * never offered. The add-on's own rows (opening balances, corrections,
```

Edit 2 of 4 in `shared/audit-health.ts` — replace:

```ts
import { changeDay, changeMoney } from './change-entries.js';
import { descriptionFromComment, isTransferType, txIdFromComment } from './sync-core.js';
import { accountTxKey } from './transfers.js';
import {
```

with:

```ts
import { changeDay, changeMoney } from './change-entries.js';
import { descriptionFromComment, isTransferType, txIdFromComment } from './sync-core.js';
import { hasTxOverride, type SyncOverrides } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import {
```

Edit 3 of 4 in `shared/audit-health.ts` — replace:

```ts
  /** account_mapping: SimpleFin id → Wealthfolio id, for the rows' tx keys. */
  mapping?: Record<string, string>;
  failed?: HealthRead[];
}
```

with:

```ts
  /** account_mapping: SimpleFin id → Wealthfolio id, for the rows' tx keys. */
  mapping?: Record<string, string>;
  /** The overrides document: a row the payback setting is on is never offered
   *  as a transfer's other half. Absent: none known (Link still refuses one). */
  overrides?: SyncOverrides;
  failed?: HealthRead[];
}
```

Edit 4 of 4 in `shared/audit-health.ts` — replace:

```ts
    && !isBookkeeping(r) && !isPlaceholderNote(r.notes));
  const userIds = new Set(userLegs.map((l) => l.id));
  // A pending row (the sync's ` · pending` note) is never offered: the sync never pairs one.
  const counterparts = (leg: AuditLedgerRow) => live.filter((c) => c.id !== leg.id && c.accountId !== leg.accountId
    && c.currency === leg.currency && c.status === 'POSTED' && !isPendingNote(c.notes) && !isBookkeeping(c) && !inValidPair(c)
    && c.absCents === leg.absCents && Math.abs(dayMs(c.date) - dayMs(leg.date)) <= MATCH_DAYS * 86_400_000
    && (leg.type === 'TRANSFER_OUT' ? INFLOW.has(c.type) : OUTFLOW.has(c.type)));
```

with:

```ts
    && !isBookkeeping(r) && !isPlaceholderNote(r.notes));
  const userIds = new Set(userLegs.map((l) => l.id));
  // A row the payback setting is on is money in that comes off spending: Link refuses it.
  const paidBack = (r: AuditLedgerRow) => {
    const key = legOf(r).txKey;
    return !!key && !!facts.overrides && hasTxOverride(facts.overrides, key, 'asReimbursement');
  };
  // A pending row (the sync's ` · pending` note) is never offered: the sync never pairs one.
  const counterparts = (leg: AuditLedgerRow) => live.filter((c) => c.id !== leg.id && c.accountId !== leg.accountId
    && c.currency === leg.currency && c.status === 'POSTED' && !isPendingNote(c.notes) && !isBookkeeping(c) && !inValidPair(c) && !paidBack(c)
    && c.absCents === leg.absCents && Math.abs(dayMs(c.date) - dayMs(leg.date)) <= MATCH_DAYS * 86_400_000
    && (leg.type === 'TRANSFER_OUT' ? INFLOW.has(c.type) : OUTFLOW.has(c.type)));
```

Edit 1 of 2 in `companion/src/audit-facts.ts` — replace:

```ts
import { AUDIT_SNAPSHOT_SECRET_KEY, buildAuditSnapshot, type AuditResults } from '../../shared/audit-snapshot.js';
import { monthlySpendTotals, parseReportCube, REPORT_CUBE_SECRET_KEY } from '../../shared/report-cube.js';
import { getNativeAuditLedger, getNativeAuditSettings, getNativeHeadlineRows } from './sqlite-audit.js';
import type { WealthfolioClient } from './wealthfolio.js';
```

with:

```ts
import { AUDIT_SNAPSHOT_SECRET_KEY, buildAuditSnapshot, type AuditResults } from '../../shared/audit-snapshot.js';
import { monthlySpendTotals, parseReportCube, REPORT_CUBE_SECRET_KEY } from '../../shared/report-cube.js';
import { loadSyncOverrides } from '../../shared/sync-overrides.js';
import { getNativeAuditLedger, getNativeAuditSettings, getNativeHeadlineRows } from './sqlite-audit.js';
import type { WealthfolioClient } from './wealthfolio.js';
```

Edit 2 of 2 in `companion/src/audit-facts.ts` — replace:

```ts
  if (mapping.ok) facts.mapping = mapping.value ?? {};
  else failed.push('mapping');
  if (failed.length > 0) facts.failed = failed;
  return facts;
```

with:

```ts
  if (mapping.ok) facts.mapping = mapping.value ?? {};
  else failed.push('mapping');
  // A row the payback setting is on is never offered as a transfer's other half (1.62).
  // Unread or unreadable: none known, and Link's own re-read refuses one.
  try {
    const loaded = await loadSyncOverrides((k) => r.secret(k));
    if (!loaded.unreadable) facts.overrides = loaded.overrides;
  } catch {
    // Nothing more to say: the Health list is unchanged.
  }
  if (failed.length > 0) facts.failed = failed;
  return facts;
```

Edit 1 of 3 in `shared/payback.ts` — replace:

```ts
  /** Creates a contains rule for one account and one activity type; resolves its id (null when the reply named none). */
  createCategoryRule(rule: { name: string; pattern: string; categoryId: string; accountId: string; activityType: string }): Promise<string | null>;
  record(draft: ChangeDraft): Promise<void>;
  log(msg: string): void;
```

with:

```ts
  /** Creates a contains rule for one account and one activity type; resolves its id (null when the reply named none). */
  createCategoryRule(rule: { name: string; pattern: string; categoryId: string; accountId: string; activityType: string }): Promise<string | null>;
  /** Appends to the change log; rejects when THIS entry was not written (the reply then promises no Undo). */
  record(draft: ChangeDraft): Promise<void>;
  log(msg: string): void;
```

Edit 2 of 3 in `shared/payback.ts` — replace:

```ts
  if (!listMakesPayback(withRuleFirst(list, rule), rule, input.description)) return no(PAYBACK_RULES_SHADOWED);

  const log = async (draft: ChangeDraft) => {
    try {
      await io.record(draft);
    } catch (err) {
      io.log(`Payback rules for "${input.pattern}": the change log was not written: ${errorText(err)}`);
    }
  };
```

with:

```ts
  if (!listMakesPayback(withRuleFirst(list, rule), rule, input.description)) return no(PAYBACK_RULES_SHADOWED);

  /** Whether the entry was written: the reply promises an Undo only then. */
  const log = async (draft: ChangeDraft): Promise<boolean> => {
    try {
      await io.record(draft);
      return true;
    } catch (err) {
      io.log(`Payback rules for "${input.pattern}": the change log was not written: ${errorText(err)}`);
      return false;
    }
  };
```

Edit 3 of 3 in `shared/payback.ts` — replace:

```ts
  }

  // 3. The change log, which never costs the rules.
  if (added) await log(mappingEntry());
  if (madeCategoryRule) {
    await log(categoryRuleCreatedChange({
      ruleId, name, pattern: input.pattern, categoryId: input.categoryId, categoryName: input.categoryName,
      account: { wfId: input.account.id, name: input.account.name }, activityType: 'CREDIT',
    }));
  }
  return { ok: true, message: paybackRulesDone(input.pattern, input.account.name, input.categoryName) };
}
```

with:

```ts
  }

  // 3. The change log, which never costs the rules. "Undo either rule" only when both entries were written.
  let logged = true;
  if (added) logged = (await log(mappingEntry())) && logged;
  if (madeCategoryRule) {
    logged = (await log(categoryRuleCreatedChange({
      ruleId, name, pattern: input.pattern, categoryId: input.categoryId, categoryName: input.categoryName,
      account: { wfId: input.account.id, name: input.account.name }, activityType: 'CREDIT',
    }))) && logged;
  }
  return { ok: true, message: paybackRulesDone(input.pattern, input.account.name, input.categoryName, logged) };
}
```

Edit 1 of 1 in `shared/payback-copy.ts` — replace:

```ts
}
export const PAYBACK_RULES_CREATE = 'Create both rules';
export const paybackRulesDone = (pattern: string, accountName: string, categoryName: string): string =>
  `Done — every ${pattern} deposit into ${accountName} is a payback under ${categoryName} from now on. Undo either rule from /changes.`;
export const PAYBACK_RULES_EXIST = 'Both rules are already there — nothing was added.';
export const PAYBACK_RULES_GENERIC = "That description is only common bank words (like DEPOSIT or ACH), so a rule on it would catch things that aren't paybacks — nothing was changed.";
```

with:

```ts
}
export const PAYBACK_RULES_CREATE = 'Create both rules';
/** `undoable` false: a change-log entry was not written, so no Undo is promised. */
export const paybackRulesDone = (pattern: string, accountName: string, categoryName: string, undoable = true): string =>
  `Done — every ${pattern} deposit into ${accountName} is a payback under ${categoryName} from now on.${undoable ? ' Undo either rule from /changes.' : ''}`;
export const PAYBACK_RULES_EXIST = 'Both rules are already there — nothing was added.';
export const PAYBACK_RULES_GENERIC = "That description is only common bank words (like DEPOSIT or ACH), so a rule on it would catch things that aren't paybacks — nothing was changed.";
```

Edit 1 of 2 in `companion/src/payback-host.ts` — replace:

```ts
import { sfinIdsFor } from '../../shared/tx-story.js';
import { readActivityById } from './audit-fix-host.js';
import { recordCompanionChanges, recordCompanionChangesStrict, type SecretClient } from './change-log-host.js';
import type { WealthfolioClient } from './wealthfolio.js';

```

with:

```ts
import { sfinIdsFor } from '../../shared/tx-story.js';
import { readActivityById } from './audit-fix-host.js';
import { recordCompanionChangesStrict, type SecretClient } from './change-log-host.js';
import type { WealthfolioClient } from './wealthfolio.js';

```

Edit 2 of 2 in `companion/src/payback-host.ts` — replace:

```ts
    })),
    createCategoryRule: async (rule) => (await client.createCategorizationRule({ ...rule, taxonomyId: SPENDING_TAXONOMY_ID, priority: PAYBACK_RULE_PRIORITY })) ?? null,
    record: (draft) => recordCompanionChanges(client, [draft]),
    log,
  };
```

with:

```ts
    })),
    createCategoryRule: async (rule) => (await client.createCategorizationRule({ ...rule, taxonomyId: SPENDING_TAXONOMY_ID, priority: PAYBACK_RULE_PRIORITY })) ?? null,
    // Strict: the reply promises "Undo either rule" only when both entries were written.
    record: (draft) => recordCompanionChangesStrict(client, [draft]),
    log,
  };
```

Edit 1 of 2 in `shared/change-entries.ts` — replace:

```ts
}

/** Repairs the sync makes to its own rows. Shown behind a button; never undoable. */
export function bookkeepingChange(f: BookkeepingFacts): ChangeDraft {
```

with:

```ts
}

/** At most this many refused ids on a `card-transfer-out` or `date-repair`
 *  entry; `refusedCount` is the total (the summary counts them all). */
export const BOOKKEEPING_REFUSED_IDS = 200;

/** Repairs the sync makes to its own rows. Shown behind a button; never undoable. */
export function bookkeepingChange(f: BookkeepingFacts): ChangeDraft {
```

Edit 2 of 2 in `shared/change-entries.ts` — replace:

```ts
      ...(f.skipped !== undefined ? { skipped: f.skipped } : {}),
      ...(f.unfiledIds ? { unfiled: f.unfiledIds.length } : {}),
      ...(f.refused?.length ? { refused: [...f.refused] } : {}),
    },
    undoable: false,
```

with:

```ts
      ...(f.skipped !== undefined ? { skipped: f.skipped } : {}),
      ...(f.unfiledIds ? { unfiled: f.unfiledIds.length } : {}),
      ...(f.refused?.length ? { refused: f.refused.slice(0, BOOKKEEPING_REFUSED_IDS), refusedCount: f.refused.length } : {}),
    },
    undoable: false,
```

Edit 1 of 1 in `CHANGELOG.md` — replace:

```markdown
  tracking off), with the reason in the log. Picking a spending category for a
  deposit used to end there, on Wealthfolio's raw refusal.

### Known limits
```

with:

```markdown
  tracking off), with the reason in the log. Picking a spending category for a
  deposit used to end there, on Wealthfolio's raw refusal.
- **Link never takes a payback for half of a transfer.** Health no longer
  offers a row the payback setting is on as a transfer's other half, and
  Link (Telegram's `/audit`, the app's Checks card) refuses a payback — the
  setting, or a cash `CREDIT` marked `REIMBURSEMENT` — in its own words: "One
  of these is a payback, not half of a transfer — nothing was linked."
  Re-creating it as a transfer would have lost the payback and its category.
- "Make every <pattern> deposit a payback" says "Undo either rule from
  /changes" only when both change-log entries were written.
- The date repair's and the card rewrite's change-log entries list at most 200
  rows Wealthfolio refused, with the full count beside them.

### Known limits
```

Edit 1 of 1 in `docs/superpowers/follow-ups.md` — replace:

```markdown
    (`paybackEligible`): until the companion's first 1.62 publish, only the
    story offers it.
- **Telegram's paybacks wait for an installed add-on of 1.62.0.** A companion
  that cannot see the add-ons directory reads it as unknown and refuses, as
```

with:

```markdown
    (`paybackEligible`): until the companion's first 1.62 publish, only the
    story offers it.
- **Link refuses a payback** (the integration review): the `asReimbursement`
  setting, or a cash `CREDIT` marked `REIMBURSEMENT`. Health skips only rows
  the setting is on (its ledger rows carry no subtype), so a payback the W10
  rule typed can still be offered as a counterpart; Link then refuses it.
- **W10's "stuck" reply** (the category rule refused, the transaction rule
  not taken back) still says to undo it from `/changes` when its entry was
  not written; only the Done reply waits for both entries.
- **Telegram's paybacks wait for an installed add-on of 1.62.0.** A companion
  that cannot see the add-ons directory reads it as unknown and refuses, as
```

- [ ] **Step 4: Run the tests: the fixes pass, the release guards still wait for the version**

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npx vitest run --maxWorkers=2 shared/link-payback.test.ts shared/bookkeeping-refused.test.ts shared/release-guards.test.ts shared/payback-rules.test.ts shared/audit-link.test.ts shared/audit-health.test.ts shared/change-entries.test.ts shared/date-repair.test.ts`
Expected: FAIL only in `shared/release-guards.test.ts` — 2 failed, 208 passed (210): `DATE_REPAIR_SINCE` and `PAYBACK_SINCE`, until Step 6.

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && cd companion && nice npx vitest run --maxWorkers=2 src/audit-facts-payback.test.ts src/release-guards.test.ts src/payback-host.test.ts src/audit-facts.test.ts src/audit-menu.test.ts src/date-repair.test.ts src/card-bookkeeping-rewrite.test.ts`
Expected: FAIL only in `src/release-guards.test.ts` — 1 failed, 119 passed (120): `is never above the version this build ships as`, until Step 6.

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npm run type-check && nice npm --prefix companion run build`
Expected: Both succeed.

- [ ] **Step 5: Commit the fixes**

```bash
git add shared/link-payback.test.ts companion/src/audit-facts-payback.test.ts shared/payback-rules.test.ts companion/src/payback-host.test.ts shared/bookkeeping-refused.test.ts shared/release-guards.test.ts companion/src/release-guards.test.ts shared/audit-link.ts shared/audit-health.ts companion/src/audit-facts.ts shared/payback.ts shared/payback-copy.ts companion/src/payback-host.ts shared/change-entries.ts CHANGELOG.md docs/superpowers/follow-ups.md
git commit -m "Integration fixes for 1.62.0: Link refuses a payback; W10 logs strictly; refused ids capped; release guards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Make the release 1.62.0**

Edit 1 of 1 in `shared/version.ts` — replace:

```ts
 * shipping a lie.
 */
export const SIMPLEFIN_SYNC_VERSION = '1.61.0';

/** Addon secret the companion writes its version to, so the Sync page can show
```

with:

```ts
 * shipping a lie.
 */
export const SIMPLEFIN_SYNC_VERSION = '1.62.0';

/** Addon secret the companion writes its version to, so the Sync page can show
```

Edit 1 of 1 in `manifest.json` — replace:

```json
  "id": "simplefin-sync",
  "name": "SimpleFin Sync",
  "version": "1.61.0",
  "description": "Sync bank transactions from SimpleFin into Wealthfolio automatically.",
  "author": "Bubbles840",
```

with:

```json
  "id": "simplefin-sync",
  "name": "SimpleFin Sync",
  "version": "1.62.0",
  "description": "Sync bank transactions from SimpleFin into Wealthfolio automatically.",
  "author": "Bubbles840",
```

Edit 1 of 1 in `package.json` — replace:

```json
{
  "name": "simplefin-sync",
  "version": "1.61.0",
  "description": "A Wealthfolio addon for wealthfolio-simplefin-addon",
  "type": "module",
```

with:

```json
{
  "name": "simplefin-sync",
  "version": "1.62.0",
  "description": "A Wealthfolio addon for wealthfolio-simplefin-addon",
  "type": "module",
```

Edit 1 of 1 in `package-lock.json` — replace:

```json
{
  "name": "simplefin-sync",
  "version": "1.61.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "simplefin-sync",
      "version": "1.61.0",
      "license": "MIT",
      "devDependencies": {
```

with:

```json
{
  "name": "simplefin-sync",
  "version": "1.62.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "simplefin-sync",
      "version": "1.62.0",
      "license": "MIT",
      "devDependencies": {
```

Edit 1 of 1 in `CHANGELOG.md` — replace:

```markdown

## [Unreleased]

### Added
```

with:

```markdown

## [Unreleased]

## [1.62.0] - 2026-10-15

### Added
```

- [ ] **Step 7: Run the release guards and the version pins**

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npx vitest run --maxWorkers=2 shared/release-guards.test.ts shared/version.test.ts shared/payback-gate.test.ts`
Expected: PASS — 20 tests (3 files).

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && cd companion && nice npx vitest run --maxWorkers=2 src/release-guards.test.ts`
Expected: PASS — 1 test (1 file).

- [ ] **Step 8: Run this task's new test files with the date forced to 2027-01-01**

```sh
cd "/Users/nawrig04/Personal Projects/wf-release" && cat > zz-2027.setup.ts <<'EOF'
import { beforeEach, vi } from 'vitest';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-01-01T12:00:00Z')); });
EOF
cp zz-2027.setup.ts companion/zz-2027.setup.ts
cat > zz-2027.config.mts <<'EOF'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', globals: true, testTimeout: 15000, setupFiles: ['./src/test-setup.ts', './zz-2027.setup.ts'] } });
EOF
cat > companion/zz-2027.config.mts <<'EOF'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true, setupFiles: ['./zz-2027.setup.ts'] } });
EOF
nice npx vitest run --maxWorkers=2 --config zz-2027.config.mts shared/link-payback.test.ts shared/bookkeeping-refused.test.ts shared/release-guards.test.ts shared/payback-rules.test.ts
(cd companion && nice npx vitest run --maxWorkers=2 --config zz-2027.config.mts src/audit-facts-payback.test.ts src/release-guards.test.ts src/payback-host.test.ts)
rm zz-2027.setup.ts zz-2027.config.mts companion/zz-2027.setup.ts companion/zz-2027.config.mts
git status --short
```

Expected: PASS — 56 tests (root, 4 files) and 21 tests (companion, 3 files). `git status --short` lists only the five files Step 6 changed.

- [ ] **Step 9: Run every gate**

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npx vitest run --maxWorkers=2`
Expected: PASS — 3692 tests (168 files).

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && cd companion && nice npx vitest run --maxWorkers=2`
Expected: PASS — 1520 tests (67 files). It includes the real-sqlite3 CLI test (`src/sqlite-native-real-cli.test.ts`).

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npm run type-check`
Expected: Succeeds.

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npm --prefix companion run build`
Expected: Succeeds.

Run: `cd "/Users/nawrig04/Personal Projects/wf-release" && nice npm run package`
Expected: Succeeds, printing `✓ dist/addon.js is v1.62.0`.

- [ ] **Step 10: Commit the release version**

```bash
git add shared/version.ts manifest.json package.json package-lock.json CHANGELOG.md
git commit -m "v1.62.0: the version, and the CHANGELOG section

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
