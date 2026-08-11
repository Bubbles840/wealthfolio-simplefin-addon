# /recategorize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/recategorize [text]` — a tappable menu over recent CATEGORIZED transactions that moves one to a different spending category (clearing an income-side assignment in the same act), with a verified-restore Undo; the import notice shows what each transaction was filed as and offers one Recategorize button; `/categorize`'s blind Undo becomes verified.

**Architecture:** One new native reader (rows WITH their per-taxonomy assignments) feeds everything: the list, the old→new confirmation, the cross-system clear, both commands' Undo verification, and the notice's read-back (matched by the stored note's txId suffix). The existing menu state machine gains a mode rather than a sibling; the controller gains the recategorize actions; the listener is untouched.

**Tech Stack:** TypeScript (companion NodeNext — `.js` imports), vitest, existing `WealthfolioClient` methods (`assignActivityCategory`, `unassignActivityCategory`), `node:sqlite` with the sqlite3-CLI fallback.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-11-telegram-recategorize-design.md`. Ships as **v1.13.0**, functionally companion-only.
- Baselines (must never drop): root `npx vitest run` **809**, `cd companion && npx vitest run` **339**.
- **The listener file is UNTOUCHED by this plan.** Its invariants stand: `deps.log`/`deps.sleep` referenced once each, `ui.*` never rejects, nothing exits the loop but `stop()`. All new behavior arrives through the deps the controller already implements.
- **Menu tap-safety invariants stand:** generation-stamped tokens (`cz:<gen>:<idx>`), `applyTap` rejecting a mismatched generation as `expired` BEFORE index resolution, every `callback_data` ≤ 64 BYTES (extend the existing byte-measured test to the new screens), every screen rendered from fresh reads, and every write preceded by a freshness check.
- **The dismissal-ledger machinery is NOT involved** — recategorize touches only category assignments. `mergeDismissals`/`pruneDismissals` keep exactly one call site each in `companion/src/index.ts`; do not add more.
- **Assignments are per-taxonomy** (verified against upstream: the DELETE endpoint is `/assignments/{taxonomy_id}`, and the assignments table keys on activity+taxonomy). Setting a spending category does NOT clear an income one — the cross-system clear is explicit: DELETE each non-`spending_categories` assignment the row carries, THEN `assignActivityCategory` with `SPENDING_TAXONOMY_ID`. Order matters and is test-pinned: delete-then-assign, so a failure between the two leaves the row uncategorized (visible in `/categorize`) rather than double-counted.
- **Row identity for the notice read-back is the stored note's txId suffix** (`txIdFromComment` from `shared/sync-core.js`) — never description matching.
- **SQL lessons from v1.12.0, both binding:** alias EVERY selected column (`node:sqlite` silently collapses duplicate keys — the unaliased `tc.name`/`parent.name` bug), and normalize the sqlite3-CLI fallback's empty-string-for-NULL (`(v ?? '') || null`) — the un-normalized `parentId: ''` bug shipped an empty picker on the CLI path.
- Frozen strings (never edited): every existing secret key, stored comment markers (`Starting balance · `, ` · pending`, `· Amazon: <label> ·`, …), log tags `duplicate-refused`/`duplicate-prune`, `Dismissed — dropped from future notices`, and the import notice's existing dismiss buttons/payloads (a `→ filed under` suffix on a LINE is new copy, not an edit of frozen copy).
- `shared/*.ts` stays host-agnostic: no Node imports, no `fetch`, no filesystem, no `new Date()`/`Date.now()` — dates render from the `YYYY-MM-DD` string.
- Import extensions: `shared/` ↔ `companion/src/` use `.js`; `src/**` extensionless. Both correct; never "fix" either.
- All user-supplied text (descriptions, category names, search input) goes through `escapeMarkdown` at message-text interpolation; keyboard button labels are plain text (Telegram does not parse them) per `buildDismissKeyboard` precedent.
- **Never `git add -A` / `git add .`** — stage files by name.

## File Structure

- **Modify** `shared/categorize-menu.ts` + test — session mode, current-category row labels, old→new confirmation with the offset line, recategorize screens; NO new sibling module.
- **Modify** `companion/src/sqlite-native.ts` + test — `getNativeCategorizedSpending`.
- **Modify** `companion/src/categorize.ts` + test — recategorize open/actions, verified Undo for BOTH commands, search filter, import-scope memory.
- **Modify** `companion/src/index.ts` + test — `/recategorize` dispatch, notice read-back + button, dep construction.
- **Modify** `shared/telegram.ts` + test — `formatImportNotice` gains optional per-tx category names; keyboard gains the Recategorize row.
- **Modify** `shared/telegram-commands.ts` + test — the command menu entry (set-pinning test updated once).
- **Modify (last task)** `manifest.json`, `package.json`, `shared/version.ts`, `CHANGELOG.md`.

---

### Task 1: The reader — categorized rows with their assignments

**Files:**
- Modify: `companion/src/sqlite-native.ts`, Test: `companion/src/sqlite-native.test.ts`

**Interfaces:**
- Produces:

```ts
export interface NativeAssignment { taxonomyId: string; categoryId: string; categoryName: string }
export interface NativeCategorizedTx {
  activityId: string;
  notes: string;          // RAW stored note — callers clean via descriptionFromComment
  amountCents: number;
  date: string;           // YYYY-MM-DD
  accountName: string;
  activityType: string;   // UPPERCASED
  assignments: NativeAssignment[];   // every taxonomy's assignment, 1+ entries
}
export function getNativeCategorizedSpending(
  dbPath: string, startInclusive: string, endExclusive: string,
): NativeCategorizedTx[]
```

- SQL shape (aliases mandatory; one row per assignment, folded in JS):

```sql
SELECT a.id            AS activity_id,
       COALESCE(a.notes, '')            AS notes,
       ROUND(ABS(CAST(a.amount AS REAL)) * 100) AS amount_cents,
       substr(a.activity_date, 1, 10)   AS activity_date,
       COALESCE(ac.name, '')            AS account_name,
       UPPER(COALESCE(a.activity_type,'')) AS activity_type,
       ata.taxonomy_id                  AS taxonomy_id,
       ata.category_id                  AS category_id,
       COALESCE(tc.name, '')            AS category_name
FROM activities a
JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
LEFT JOIN accounts ac ON a.account_id = ac.id
LEFT JOIN taxonomy_categories tc
       ON tc.id = ata.category_id AND tc.taxonomy_id = ata.taxonomy_id
WHERE a.activity_date >= '<start>' AND a.activity_date < '<end>'
  AND UPPER(a.activity_type) IN ('WITHDRAWAL','FEE','TAX','DEPOSIT','CREDIT','INTEREST','DIVIDEND','INCOME')
  AND COALESCE(a.notes, '') NOT LIKE 'Starting balance · %'
  AND COALESCE(a.notes, '') NOT LIKE 'Balance adjustment · %'
  AND COALESCE(a.notes, '') NOT LIKE '↔️ In-transit transfer · %'
ORDER BY a.activity_date DESC, a.id, ata.taxonomy_id;
```

  (Same type list and note-marker exclusions as `getNativeUncategorizedSpending` — the two readers partition the same universe. INNER JOIN on assignments is what makes this the categorized half.)
- Fold consecutive rows by `activity_id` into one `NativeCategorizedTx` with `assignments[]`. CLI-fallback mapper returns null on wrong column count; `(v ?? '')` normalization for the CLI path; missing/invalid dbPath or bounds → `[]`.
- The real `activity_taxonomy_assignments` table has a `taxonomy_id` column; the FIXTURE in `sqlite-native.test.ts` was created without one (`(activity_id TEXT, category_id TEXT)`). **Extend the fixture's CREATE TABLE to include `taxonomy_id TEXT`** and update the few existing INSERTs (they may pass 2 columns explicitly — check and keep them passing; the uncategorized reader ignores the column, so its tests are unaffected).

- [ ] **Step 1: failing tests** — a row with assignments in two taxonomies folds into ONE tx with both entries (names resolved, income's from its own taxonomy row); a row with one assignment; an uncategorized row absent; marker-note rows absent; date-bounds respected; missing db → `[]`; a NULL category name coalesces to `''` not a dropped row.
- [ ] **Step 2: RED.** **Step 3: implement.** **Step 4:** `cd companion && npx vitest run` (339 baseline + new), root untouched, `npx tsc --noEmit -p companion`. **Step 5:** commit `git commit -m "Read categorized spending with every taxonomy's assignment"`.

---

### Task 2: Menu screens for recategorize

**Files:**
- Modify: `shared/categorize-menu.ts`, `shared/categorize-menu.test.ts`

**Interfaces:**
- Consumes: everything the file already exports.
- Produces (additions; nothing existing changes shape):

```ts
export interface CategorizeTxn {
  // existing fields unchanged, plus:
  /** Present in recategorize mode: the current spending-or-income category shown
   *  in the row label and the old half of the confirmation. */
  currentCategory?: { taxonomyId: string; categoryId: string; name: string };
}
export interface MenuSession { /* existing fields, plus: */ mode: 'categorize' | 'recategorize' }
export type MenuScreen = /* existing members, plus: */
  | { kind: 'refiled'; activityId: string; fromName: string; toCategoryId: string; crossTaxonomy: boolean; undone: boolean };
export type MenuAction = /* existing members, plus: */
  | { kind: 'reassign'; activityId: string; categoryId: string }
  | { kind: 'undoReassign'; activityId: string; toRestore: { taxonomyId: string; categoryId: string } };
```

**Semantics (each a test):**
- `mode: 'recategorize'` list rows append ` · ⟨currentCategory.name⟩` to the existing label; list header says what the menu is (`Recategorize — tap a transaction`); empty list: `Nothing categorized in the last 90 days matches.` with `Done`.
- The txn screen in recategorize mode shows the current category in its text, offers the SAME parent/subcategory picker, and has NO `Keep uncategorized` button. The current category's own button is still offered (re-filing to the same category is a no-op the controller handles, not a special screen).
- Category taps in recategorize mode yield `reassign` (not `assign`); the machine emits it wherever it emits `assign` in categorize mode — one code path, branched on `session.mode`, NOT a copied block.
- `refiled` screen: `⟨description⟩: ⟨fromName⟩ → ⟨toName⟩.` plus, when `crossTaxonomy`, the exact extra line `This payment now offsets ⟨toName⟩ instead of counting as income.` Buttons `Undo` / `Next` (goto list) / `Done`; `undone: true` mirrors the existing undo texts and yields `undoReassign` from the Undo button.
- All new interpolations escaped; existing categorize-mode rendering is byte-identical (pin with one regression assertion on a categorize-mode list label).
- Extend the 64-byte test to recategorize screens with long category names.

- [ ] Steps: failing tests → RED → implement → `npx vitest run shared/categorize-menu.test.ts`, root suite, both tsc → commit `git commit -m "Recategorize screens: current category shown, old-to-new confirmation"`.

---

### Task 3: Controller — reassign, verified Undo everywhere, search, import scope

**Files:**
- Modify: `companion/src/categorize.ts`, Test: `companion/src/categorize.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2's exports; existing deps.
- Produces (additions to `CategorizeDeps` and `CategorizeController`):

```ts
// CategorizeDeps additions:
  readCategorized: (dbPath: string, start: string, end: string) => NativeCategorizedTx[];
  /** DELETE one taxonomy's assignment. Already exists on the client; threaded here. */
  unassignTaxonomy: (activityId: string, taxonomyId: string) => Promise<void>;
// CategorizeController additions:
  openRecategorize(query: string | undefined, send: (text: string, keyboard?: InlineKeyboard) => Promise<void>): Promise<void>;
  /** The import notice's button: recategorize scoped to the given txIds when
   *  provided; plain recent list when the memory is gone (restart). */
  openRecategorizeForTxIds(txIds: string[] | null, send: ...): Promise<void>;
export const INCOME_TAXONOMY_NOTE = 'income'; // not exported as an id — detection is “taxonomyId !== SPENDING_TAXONOMY_ID”
```

**Behavior (each a test):**
1. `openRecategorize`: fresh `readCategorized` over `uncategorizedWindow(new Date())`, descriptions cleaned (`descriptionFromComment(notes) || notes`), optional query filtering case-insensitively on the CLEANED description, rows mapped with `currentCategory` = the SPENDING assignment if present else the first assignment (its name is what the user recognizes), session `mode: 'recategorize'`, list sent.
2. `reassign` action: freshness re-read; the row must still be present with the SAME `currentCategory.categoryId` the session showed — otherwise decline + refresh (never write). Then: for every assignment whose `taxonomyId !== SPENDING_TAXONOMY_ID`, `unassignTaxonomy` it; then `assign` (existing dep). Then republish (harmless if nothing uncategorized changed), fresh re-read, `refiled` screen with `crossTaxonomy` = whether any non-spending assignment was cleared. Re-filing to the identical category: no deletes, no assign, straight to the `refiled` screen (no-op, honest).
3. Failure ordering pinned: a delete that succeeds followed by an assign that throws leaves the row visible in `/categorize` (uncategorized), and the error screen says the category was NOT set. No path can leave the income assignment gone AND the spending one unset silently.
4. `undoReassign`: fresh re-read; only when the row's current spending assignment is STILL `toCategoryId` (this menu's write) does it restore: assign `toRestore.categoryId` back under `toRestore.taxonomyId` — via `assign` when spending, else `unassignTaxonomy(SPENDING)` + a NEW generic assign-with-taxonomy path threaded through the same dep (extend `assign` dep signature to `(activityId, categoryId, taxonomyId?)` defaulting spending — one dep, not two). Otherwise decline: `That transaction changed elsewhere — leaving it as is.` + refresh.
5. **`/categorize`'s Undo upgraded:** before `unassign`, re-read and verify the row's spending assignment is still the category this menu just set; decline with the same sentence otherwise. The v1.12.0 hazard comment is replaced by the verification; the old pinning test is UPDATED to assert the new guard (this is the one sanctioned edit of an existing test, it strengthens).
6. `openRecategorizeForTxIds`: with ids, filter `readCategorized` rows to those whose `txIdFromComment(notes)` is in the set; with `null`, identical to bare `openRecategorize`. Sent as a fresh message (the notice is never edited).
7. Session bookkeeping identical to categorize (cleared on open, generation-stamped, one session per chat).

- [ ] Steps: failing tests → RED → implement → companion suite + root + both tsc + `cd companion && npm run build` → commit `git commit -m "Recategorize: cross-taxonomy clear, verified undo for both menus"`.

---

### Task 4: Wiring — command, notice read-back, button

**Files:**
- Modify: `companion/src/index.ts`, `companion/src/index.test.ts`, `shared/telegram.ts`, `shared/telegram.test.ts`, `shared/telegram-commands.ts`, `shared/telegram-commands.test.ts`

**Wiring:**
- `TELEGRAM_COMMAND_MENU` gains `{ command: 'recategorize', description: 'Move a filed transaction — /recategorize venmo narrows it' }`; update the set-pinning test (the ONE existing-test edit).
- `case 'recategorize'`: db-null guard reusing the existing honest sentence; then `controller.openRecategorize(args || undefined, (t, k) => reply(t, k))`.
- Dep construction: `readCategorized: getNativeCategorizedSpending`, `unassignTaxonomy: (id, tax) => wfClient.unassignActivityCategory(id, tax)`; `assign` widened per Task 3.
- **Notice read-back:** in `sendImportNotice`, after the sync's rows land, read `getNativeCategorizedSpending` over the notice's date window, build `Map<txId, categoryName>` via `txIdFromComment`, and pass into `formatImportNotice`.
- `formatImportNotice` gains an OPTIONAL final parameter `categoriesByTxId?: Map<string, string>`; `ImportNoticeTx` gains `txId: string` (the caller already has it — thread it through). A tx with a mapped name renders its line with ` → filed under ⟨name⟩` appended; unmapped renders exactly as today. Existing tests pass unchanged (parameter optional); new tests pin both renderings.
- Keyboard: when at least one imported tx has a mapped category, append `[{ text: 'Recategorize', callback_data: 'cz:recat' }]` as its own row (after the dismiss rows and the existing `Categorize these` row, whose text/payloads are frozen).
- `cz:recat` handling: special-cased in `onCallback` beside `cz:open`, BEFORE session lookup, calling `openRecategorizeForTxIds(lastImportTxIds, ui.send)`. `lastImportTxIds: string[] | null` is module state in `index.ts`, set by `sendImportNotice` from `result.importedTransactions` txIds, `null` on boot. Companion restart → `null` → recent-list fallback (spec decision 3).
- The v1.12.0 deferred minor "cz:open falls to unknown with no session" pattern applies to `cz:recat` too: same fresh-message treatment.

- [ ] Steps: failing tests (command dispatch; notice line with and without mapping; keyboard row presence/absence; `cz:recat` scoped and fallback paths; frozen strings untouched) → RED → implement → **full verification**: companion suite, root suite, both tsc, `npm run build`, `cd companion && npm run build` → commit `git commit -m "Wire /recategorize: command, notice read-back, Recategorize button"`.

---

### Task 5: v1.13.0, changelog, package

**Files:** `manifest.json`, `package.json`, `shared/version.ts` (all `1.12.0` → `1.13.0`), `CHANGELOG.md`

- [ ] Bump all three carriers (`shared/version.test.ts` pins them together).
- [ ] CHANGELOG between `## [Unreleased]` and the 1.12.0 entry, dated 2026-08-11:

```markdown
## [1.13.0] - 2026-08-11

### Added

- **/recategorize — fix a filed transaction from Telegram.** Lists recent
  transactions with their current categories; /recategorize venmo narrows to
  matching ones. Tap a transaction, tap the right category, done — with an
  Undo that restores exactly the previous category. Moving a payment out of an
  income category (a Venmo payback filed under Reimbursements, say) into a
  spending category clears the income side in the same act, so it offsets that
  category's budget instead of counting as income — the confirmation says so.
- **The import notice now shows where each transaction was filed** ("→ filed
  under Groceries"), read back from the database after the import so rules are
  reflected, plus a Recategorize button scoped to just that import.

### Fixed

- **Undo after filing verifies before it un-files.** Both menus now check that
  a transaction's category is still the one they set before undoing, so an
  Undo can no longer erase a category someone set elsewhere in between — a
  known blind spot since 1.12.0.

Needs the companion rebuild; the addon zip changes only its version string.
```

- [ ] Full verification: root vitest, companion vitest, both `tsc --noEmit`, `npm run build`, `npm run package` (zip must be `dist/simplefin-sync-1.13.0.zip`), `cd companion && npm run build`.
- [ ] Commit `git commit -m "Bump to 1.13.0 with the /recategorize changelog"` (files staged by name).

(Release — push, tag, GitHub release, store-listing bump, rsync + rebuild — follows the established flow after live testing.)

## Plan Self-Review (performed)

- **Spec coverage:** list+search (T3 §1, T4 dispatch), current-category labels and old→new confirmation with the offset line (T2), cross-system clear with pinned delete-then-assign ordering (T3 §2-3), verified Undo both menus incl. the closed v1.12.0 debt (T3 §4-5), notice read-back by txId + button + restart fallback (T3 §6, T4), reader with per-taxonomy assignments and both v1.12.0 SQL lessons (T1), non-goals honored (no income picker, no bulk), version/changelog (T5). Gaps: none found.
- **Placeholder scan:** clean.
- **Type consistency:** `NativeCategorizedTx`/`NativeAssignment` (T1) consumed by T3/T4 by name; `currentCategory`/`mode`/`refiled`/`reassign`/`undoReassign` (T2) consumed by T3; `readCategorized`/`unassignTaxonomy`/widened `assign` (T3) constructed in T4; `categoriesByTxId` optional param + `ImportNoticeTx.txId` (T4) internally consistent; `cz:recat` named identically in T3 §6 and T4.
