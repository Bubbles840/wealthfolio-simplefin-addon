# Reimbursement Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A transaction rule can set an activity's `subtype` as well as its type, so `Venmo Transfers` imports as `CREDIT` + `REIMBURSEMENT` — which stops the payback counting as income and lets it offset a spending category. Existing rows backfill themselves because reconciliation already updates a row whose resolved type changed.

**Architecture:** `MappingRule` and `MappedType` gain an optional `subtype`; the mapper carries it; `subtype` is threaded through the host contract so `changed()` can compare it (the backfill depends on that comparison); the addon's rule editor gains an input. The abandoned per-row subtype write is deleted.

**Tech Stack:** TypeScript (companion NodeNext — `.js` imports; addon Vite — extensionless), vitest, React for the editor.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-11-reimbursement-rules-design.md`. Ships as **v1.14.0**. Both halves change → companion rebuild AND zip reinstall.
- Upstream facts are already investigated and committed in `docs/upstream-spending-buckets.md`. **Do not re-derive them and do not fetch anything from the network.** The two that bind this plan: Wealthfolio reads `subtype` ONLY on the `CREDIT` branch (so a `DEPOSIT` is income no matter what subtype it carries), and the refund subtypes are exactly `REFUND`, `REBATE`, `REIMBURSEMENT`.
- Baselines (must never drop): root `npx vitest run` **894**, `cd companion && npx vitest run` **413**.
- **Backward compatibility is the highest-stakes property.** Every stored rule today is `{pattern, matchType, activityType}` with no subtype, and every stored activity has whatever subtype Wealthfolio gave it. A rule without a subtype must behave EXACTLY as it does now, and a row whose feed carries no subtype must not be seen as "changed" — otherwise every sync rewrites every row forever. There is a mandated test for this.
- **`changed()` is the sync's write trigger.** Widening it is what makes the backfill work and is also the one way this plan could cause mass churn. Treat `undefined`, `null` and `''` as the same absent value on both sides.
- Frozen strings (data contracts — never edited): every existing secret key; the stored comment markers `Starting balance · `, `Balance adjustment · `, `↔️ In-transit transfer · `, ` · pending`, `· Amazon: <label> ·`; log tags `duplicate-refused` / `duplicate-prune`; `Dismissed — dropped from future notices`.
- `shared/*.ts` stays host-agnostic: no Node imports or Node-only globals, no `fetch`, no filesystem, no `new Date()` defaults where a caller can pass one.
- Import extensions: `shared/` ↔ `companion/src/` use `.js`; `src/**` extensionless. Both correct; never "fix" either.
- No emoji in addon UI copy; tone classes carry the signal (an existing test asserts this with `/\p{Extended_Pictographic}/u`).
- **Never `git add -A` / `git add .`** — stage files by name.

## File Structure

- **Modify** `shared/types.ts` — `MappingRule.subtype?: string`.
- **Modify** `shared/mapper.ts` + test — `matchRule` returns the whole rule; `MappedType.subtype?`.
- **Modify** `shared/sync-host.ts` — `HostActivity.subtype?: string | null`.
- **Modify** `companion/src/rest-host.ts`, `src/utils/addon-host.ts` (+ `companion/src/wealthfolio.ts`'s `ActivitySearchItem`) — carry `subtype` through both adapters, both directions.
- **Modify** `shared/reconcile.ts` + test — `ExistingRow.subtype?`, `FeedTx.subtype?`, `changed()` compares them.
- **Modify** `shared/sync-core.ts` + test — build the feed's subtype from the mapper, put it on creates/updates, read it onto `ExistingRow`.
- **Modify** `src/components/RuleEditor.tsx` (or wherever rules are edited — locate it) + test — the subtype input.
- **Delete** `updateActivitySubtype` from `companion/src/wealthfolio.ts` and its tests.
- **Modify (last task)** `manifest.json`, `package.json`, `shared/version.ts`, `CHANGELOG.md`.

---

### Task 1: The rule carries a subtype, and the mapper returns it

**Files:**
- Modify: `shared/types.ts`, `shared/mapper.ts`; Test: `shared/mapper.test.ts`

**Interfaces:**
- Produces:

```ts
// shared/types.ts
export interface MappingRule {
  pattern: string;
  matchType: 'contains' | 'regex';
  activityType: ActivityType;
  /** Optional Wealthfolio activity subtype applied when this rule matches.
   *  Only meaningful for CREDIT (see docs/upstream-spending-buckets.md): a
   *  DEPOSIT is income regardless of subtype. */
  subtype?: string;
}
// shared/mapper.ts
export interface MappedType {
  type: ActivityType;
  fromRule: boolean;
  subtype?: string;
}
```

- `matchRule` currently returns `ActivityType | null` (`shared/mapper.ts:16-38`). Change it to return `MappingRule | null` — the matched rule itself — so the caller can read both fields from one match. Keep both match arms' behavior identical, including the `try/catch` that skips an invalid regex rather than crashing a sync (its comment explains why; keep it).
- `mapTransactionWithSource` returns `{ type: ruled.activityType, fromRule: true, ...(ruled.subtype ? { subtype: ruled.subtype } : {}) }` on a rule match. Every non-rule branch is untouched and returns no subtype.
- `mapTransaction` keeps its exact signature (`ActivityType`) — it is the type-only helper and callers depend on that.

- [ ] **Step 1: failing tests** — a `contains` rule with a subtype yields both; a `regex` rule with a subtype yields both; a rule WITHOUT a subtype yields `subtype` absent (assert with `'subtype' in result === false`, not `toBeUndefined()`, so an explicit `undefined` key is caught); an invalid-regex rule is still skipped; no-rule branches (card, bank-transfer keywords, sign default) return no subtype; `mapTransaction` still returns a bare type.
- [ ] **Step 2: RED.** **Step 3: implement.** **Step 4:** `npx vitest run shared/mapper.test.ts`, root suite, both tsc. **Step 5:** commit `git commit -m "A transaction rule can set a subtype, not just a type"`.

---

### Task 2: Thread `subtype` through the host contract, both adapters

**Files:**
- Modify: `shared/sync-host.ts`, `companion/src/rest-host.ts`, `companion/src/wealthfolio.ts`, `src/utils/addon-host.ts`
- Test: `companion/src/rest-host.test.ts` (locate it; if absent, test through `companion/src/wealthfolio.test.ts`'s fake-fetch idiom), and the addon host's existing test file

**Interfaces:**
- Produces: `HostActivity.subtype?: string | null`, populated by both adapters when reading, and sent by both when writing.

**What to change, precisely:**
- `HostActivity` (`shared/sync-host.ts:5-14`) gains `subtype?: string | null`.
- `companion/src/wealthfolio.ts`'s `ActivitySearchItem` gains `subtype?: string | null`. The REST search endpoint already returns it (`ActivityDetails.subtype` upstream) — this is only a type widening plus carrying it in `fromSearchItem`.
- `companion/src/rest-host.ts`: `fromSearchItem` copies `subtype`. Its write path must SEND `subtype` on creates and updates.
- `src/utils/addon-host.ts`: `fromSearchRow` copies `subtype` (the SDK's activity type already declares it — `data-types.d.ts` has `subtype?: string | null`), and `toSdkWrite` sends it.
- **Both adapters must round-trip it**: a row read with `subtype: 'REIMBURSEMENT'` and written back unchanged must keep it. Test that per adapter.

- [ ] Steps: failing tests → RED → implement → `cd companion && npx vitest run`, root suite, both tsc, `npm run build`, `cd companion && npm run build` → commit `git commit -m "Carry activity subtype through both host adapters"`.

---

### Task 3: `changed()` compares subtype — the backfill, and the churn risk

**Files:**
- Modify: `shared/reconcile.ts`; Test: `shared/reconcile.test.ts`

**Interfaces:**
- Produces: `ExistingRow.subtype?: string | null`, `FeedTx.subtype?: string`, and `changed()` comparing them through one normalizer.

**The single most important detail in this plan.** `changed()` (`shared/reconcile.ts:78-90`) decides every update-in-place. Add the comparison via an explicit normalizer, not `!==` on the raw values:

```ts
/** `undefined` (feed carries no subtype), `null` (host reported none) and `''`
 *  are all "no subtype". Comparing raw values would report a difference on every
 *  row that never had one, and `changed()` is the write trigger — that would
 *  rewrite every activity on every sync, forever. */
const normSubtype = (v: string | null | undefined): string => (v ?? '').trim().toUpperCase();
```

and compare `normSubtype(row.subtype) !== normSubtype(tx.subtype)`. Upper-casing matches upstream, which canonicalizes subtype case-insensitively.

- [ ] **Step 1: failing tests** — a stored row with no subtype and a feed with no subtype is NOT changed (the churn regression; assert for `undefined`, `null` AND `''` on the row side); stored none + feed `REIMBURSEMENT` IS changed (the backfill); stored `REIMBURSEMENT` + feed `REIMBURSEMENT` is NOT changed; case difference is NOT changed; stored `REIMBURSEMENT` + feed none IS changed (removing a rule's subtype takes effect); and every pre-existing `changed()` test still passes untouched.
- [ ] **Step 2: RED.** **Step 3: implement.** **Step 4:** `npx vitest run shared/reconcile.test.ts`, root suite, both tsc. **Step 5:** commit `git commit -m "Reconcile on subtype so a rule change reaches rows already imported"`.

---

### Task 4: Sync-core carries the subtype end to end

**Files:**
- Modify: `shared/sync-core.ts`; Test: `shared/sync-core.test.ts`

**What to change:**
- The `ExistingRow` builder (`shared/sync-core.ts:848-858`) copies `subtype: a.subtype ?? undefined` from the `HostActivity`.
- The feed builder (`shared/sync-core.ts:1339-1350`) carries the mapper's subtype onto each `FeedTx`. Find where `mapTransactionWithSource`'s result is consumed to produce `preparedByAccount` (`{ tx, type, feeCents, inTransit }`) and widen that tuple with the subtype — one place, not two.
- Creates and updates include `subtype` when present. Do NOT send an empty string on rows that have none: absent means "leave alone" for an update, and an explicit `''` would clear a subtype Wealthfolio set for its own reasons.
- `neutralAdjustmentFields` (`shared/sync-core.ts:877`) is untouched — its subtype-less CREDIT plug is deliberate and documented; a rule must never apply to a balance-adjustment row. Verify with a test that a plug row still carries no subtype.

- [ ] Steps: failing tests (a ruled tx reaches the create payload with its subtype; an unruled one carries none; an existing row's stored subtype reaches `ExistingRow`; a subtype change produces an update-in-place through the real planner; a balance-adjustment plug still has no subtype) → RED → implement → root suite, companion suite, both tsc, both builds → commit `git commit -m "Thread the rule's subtype through import and reconciliation"`.

---

### Task 5: The rule editor, and deleting the unused write

**Files:**
- Modify: `src/components/RuleEditor.tsx` + `src/components/RuleEditor.test.tsx` if present, plus `src/tabs/AdvancedTab.test.tsx` for the integration assertions
- Modify: `companion/src/wealthfolio.ts`, `companion/src/wealthfolio.test.ts` — DELETE `updateActivitySubtype` and its tests
- Modify: `companion/src/sqlite-native.ts` if `activityDateRaw` becomes unused after that deletion — check, and remove it only if nothing reads it

**The editor:**
- A subtype field per rule, offered only when the chosen `activityType` is one Wealthfolio reads a subtype for. Per `docs/upstream-spending-buckets.md` that is `CREDIT`; if the doc names others, follow the doc.
- Offer the three refund values by name (`REFUND`, `REBATE`, `REIMBURSEMENT`) plus an empty/none option. A select, not a free text field — a typo'd subtype silently does nothing, which is the failure mode this whole feature exists to eliminate.
- One line of copy stating what it does, in the addon's plain-first voice: that marking a credit as a reimbursement makes it reduce the category you file it under instead of counting as money in, and that the rule also applies to transactions already imported on the next sync. Both halves matter — the second is the backfill, and a user who does not expect history to change deserves to be told.
- Existing rules render and save unchanged with no subtype.

**The deletion:** `updateActivitySubtype` was built for the abandoned per-row design (spec decision 7). Remove it and its tests so an unused write against real financial data cannot be called by mistake.

- [ ] Steps: failing tests (editor round-trips a subtype; the input is absent for a non-CREDIT type; an existing subtype-less rule is untouched; no emoji in the new copy; nothing references `updateActivitySubtype`) → RED → implement → **full verification**: root suite, companion suite, both tsc, `npm run build`, `cd companion && npm run build` → commit `git commit -m "Rule editor sets a subtype; drop the unused per-row subtype write"`.

---

### Task 6: v1.14.0, changelog, package

**Files:** `manifest.json`, `package.json`, `shared/version.ts` (all → `1.14.0`), `CHANGELOG.md`

- [ ] Bump all three carriers (`shared/version.test.ts` pins them together).
- [ ] CHANGELOG between `## [Unreleased]` and the 1.13.1 entry, dated 2026-08-11:

```markdown
## [1.14.0] - 2026-08-11

### Added

- **Transaction rules can mark a payback as a reimbursement.** A rule now sets
  an activity's subtype as well as its type, so "Venmo Transfers" can import as
  a CREDIT marked REIMBURSEMENT. Wealthfolio then treats it as money that
  reduces whatever category you file it under, instead of income — which is what
  a friend paying you back for dinner actually is. Set it in Advanced →
  Transaction Rules.
- **The rule applies to transactions already imported**, not just future ones:
  the next sync updates matching rows in place, so you fix a recurring payback
  once instead of per transaction.

### Changed

- `/recategorize` now refuses a move Wealthfolio would reject, and says why,
  instead of clearing the old category first and failing afterwards.

Needs the companion rebuild AND the addon zip, since both halves change.
```

- [ ] Full verification: root vitest, companion vitest, both `tsc --noEmit`, `npm run build`, `npm run package` (zip must be `dist/simplefin-sync-1.14.0.zip`), `cd companion && npm run build`.
- [ ] Commit `git commit -m "Bump to 1.14.0 with the reimbursement-rules changelog"`.

## Plan Self-Review (performed)

- **Spec coverage:** rule+mapper subtype (T1), host round-trip (T2), `changed()` and the churn guard (T3), import/reconcile threading and the untouched plug (T4), editor + deletion (T5), version/changelog (T6). Spec decision 5 (credit cards need nothing) requires no task by construction. Spec decision 6 (the menu keeps its gate) is already on the branch from the abandoned plan's Tasks 1-3 — no task needed, but the final review should confirm the gate is present and the abandoned confirmation screen is either used or removed.
- **Placeholder scan:** two deliberate "locate it" instructions (the rule editor's path, and whether `activityDateRaw` becomes unused), both with the grep to run and both outcomes specified.
- **Type consistency:** `MappingRule.subtype?` / `MappedType.subtype?` (T1) consumed in T4/T5; `HostActivity.subtype?: string | null` (T2) read by T4's `ExistingRow` builder; `ExistingRow.subtype?` / `FeedTx.subtype?` (T3) written by T4; `normSubtype` lives only in `reconcile.ts`.
