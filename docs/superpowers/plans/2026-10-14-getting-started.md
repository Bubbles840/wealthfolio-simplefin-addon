# Getting started (project 4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three things for someone who installs the add-on from Wealthfolio's store: ONE Docker Compose snippet (the Settings card, the README and `docker-compose.example.yml` agree, and a test keeps them so); a read-only sample-data preview of the Budget board before a bank is linked or the companion has synced; and budgets suggested from the last 3 full months, applied from Telegram's `/budgets`, each one a change-log entry with Undo.

**Architecture:** Three pure shared modules carry the decisions: `shared/compose-snippet.ts` (`composeSnippet`, the one service definition), `shared/sample-cube.ts` (`sampleReportCube(now)`, a plausible six-month cube that passes `parseReportCube`) and `shared/budget-suggest.ts` (`suggestBudgets`: the window in Wealthfolio's timezone, the average, the rounding, every skip rule; `planBudgetApply`: re-read before write). The app renders the snippet (`src/components/DockerSnippet.tsx`) and the preview (a `preview` prop on `BudgetTab` and `BudgetPreview`, opened from the empty Budget board and from setup step 1). The change log gains the kind `budget-set` (`shared/change-entries.ts`, `change-view.ts`, `change-undo.ts`, `change-undo-run.ts`), undone by deleting the target — on the companion only, because the add-on SDK has no budget API. The companion reads and writes Wealthfolio's budget targets over REST (`companion/src/wealthfolio.ts`), gathers the facts and applies a choice (`companion/src/budget-suggest-host.ts`), and serves `/budgets` as a stateless `cz:bg:` menu (`companion/src/budgets-menu.ts`) wired into `companion/src/index.ts`.

**Tech Stack:** TypeScript, React (add-on), vitest (root project: jsdom, `src/` + `shared/`; companion project: node, `companion/src/`), Telegram Bot API (legacy `Markdown`), Wealthfolio REST and read-only SQLite (companion), add-on SDK 3.6.2 on Wealthfolio 3.8–3.10.

**Spec:** `docs/superpowers/specs/2026-10-14-getting-started-design.md` (rulings G1–G5; designed overnight 2026-10-13/14 under Nick's standing instruction and NOT yet reviewed by him, so it ships as an open PR; commit 57e9a42 on `feat/getting-started`, off main ece1902). This plan implements all of it — sections A, B, C and D — faithfully; where the code forced a choice the spec does not make, it is listed under Deviations.

**Verified facts this plan builds on (Q1):**
- **(a) The three compose snippets, and the choice.** README.md:214-229 (bridge network, `WEALTHFOLIO_API_URL=http://wealthfolio:8088`, `WEALTHFOLIO_PASSWORD=your_wealthfolio_password`, `WEALTHFOLIO_DB_PATH=/mnt/wealthfolio/wealthfolio.db`, `TZ`, the read-only FOLDER mount); `docker-compose.example.yml:12-35` (the same, plus commented `build:` lines, `user: "1000:1000"` and an external `wealthfolio_default` network); `src/tabs/SettingsTab.tsx:559-573` (`container_name`, `restart: always`, `network_mode: host`, `http://127.0.0.1:8088`, `SYNC_SCHEDULE`, `MIN_SYNC_INTERVAL_HOURS`, and **no `TZ`**). What the companion reads: one of `WEALTHFOLIO_PASSWORD`, `WEALTHFOLIO_PASSWORD_FILE`, `WEALTHFOLIO_API_KEY` (`companion/src/index.ts:148-154`; the key is used as a bearer token, `:902-906`), a startup warning when `TZ` is unset (`:172-176`), the database default `/mnt/wealthfolio.db` (`:44`), `SYNC_SCHEDULE` defaulting to `0 */6 * * *` (`:3882`); the image already runs as `USER node` (`companion/Dockerfile`), so the example's `user:` line is redundant. **Choice: (i)** — `shared/compose-snippet.ts` builds the text; Task 1 commits README.md's yaml block and `docker-compose.example.yml` with its default output, byte for byte, and `shared/compose-snippet.test.ts` fails when the README's one yaml block naming `simplefin-sync`, or the example file, differs from `composeSnippet()` (plus the file's final newline). No build step and no second writer: a regeneration script would be one more thing to forget to run, and the failing test names the file that drifted. The Settings card renders `composeSnippet` itself, so it cannot drift. The card's timezone is `Intl.DateTimeFormat().resolvedOptions().timeZone` (`browserTimezone`, Task 2), accepted only when it looks like an IANA name; the snippet never carries a password value — the password comes from a Compose secret file — pinned in Tasks 1 and 2.
- **(b) The sample cube against `parseReportCube`** (`shared/report-cube.ts:132-158`): `version: 1`; `months`, `categories`, `accounts` arrays; `spend`, `uncategorized`, `income`, `budgets`, `merchants`, `feesInterest`, `netWorth`, `liquid` each the length of `months`; every `spend[m]` the length of `categories` and every `spend[m][c]` the length of `accounts`; every `uncategorized`/`income` row the length of `accounts`; every `budgets` row the length of `categories`. `merchants`' rows, `drill`, `subscriptions` and `pool` are not validated — the sample keeps them in their published shapes anyway (`CubeMerchant`, `DrillTx` without `i` so a drill row opens no story — `ReportView.tsx:389` — and `DetectedSubscription`). The months end on the month `now` falls in, in the browser's own time (the board's month), with `now` passed in so tests pin it. Task 3 pins every rule, the round-trip, and a year boundary.
- **(c) Preview mode on the Budget board.** `BudgetTab` (`src/tabs/BudgetTab.tsx`) is a pure function of `cube` plus props. Its writes: `onLayoutChange` (the headline picks `:216`, resize `:433`, move `:496`, the card menu `:563-629`, the palette swatches `:707`, the hide toast's Undo `:739`, the add-report list `:795`), `onLayoutReset` (`:718`), `onCustomReportsChange` (the builder `:231`, the card menu `:540-551`), `store.setSemesterPool` (the pool editor, `:275`/`:332`) and `onSubscriptionEdit` (handed to the Subscriptions card at `:209`; the card is read-only without it, `SubscriptionsCard.tsx:173-174`); plus `onOpenActivities` and `renderTxStory`, which leave the board. Every write control sits behind Customize (`:724-726`), "+ Add report" (`:772-779`), the pool editor, the headline picker (it renders only with `onPicksChange`, `ReportView.tsx:281`) or the subscription edit. The clean way: a `preview` prop that hides Customize, "+ Add report", the pool editor and the audit link, passes no edit handler into `ReportView` (so the picker and the subscription controls are read-only), and turns the stale strip (`:191`) off; `BudgetPreview` renders `BudgetTab` over `sampleReportCube(now)` with no-op layout handlers and that prop, and shows the banner where the stale strip sits (both the grid and the full view). The empty state (`:175-184`) opens it from local state, and closing it returns there. Setup step 1's anchor is the Connect button inside the step-1 card, `src/pages/SetupPage.tsx:103-106`.
- **(d) Budgets upstream** (`git show v3.10.0:` and `v3.8.0:` in wealthfolio-upstream). Routes, `apps/server/src/api/spending.rs`: `GET /spending/budget`, `POST /spending/budget/targets`, `DELETE /spending/budget/targets/{id}` (`:803-806` at v3.10.0, `:798-801` at v3.8.0), each taking `?periodKey=` (`BudgetQuery`, `:486` / `:481`) and each answering the whole `BudgetSnapshot` (`get_budget` `:490`, `upsert_budget_target` `:504`, `delete_budget_target` `:519` at v3.10.0) — the POST does **not** return the target. Request `NewBudgetTarget` (`crates/spending/src/budget/model.rs:128-136`, both tags, camelCase): `{ id?, periodKey, targetType, taxonomyId?, categoryId?, groupId?, amount }`, `targetType` snake_case `"category"`/`"group_buffer"` (`:97`), `amount` a decimal **string**. Response `BudgetSnapshot.state = { groups, groupAssignments, targets, rolloverSettings }` (`:236`), each `BudgetTarget` (`:114`) `{ id, periodKey, targetType, taxonomyId, categoryId, groupId, amount, createdAt, updatedAt }`. `validate_budget_target` (`service.rs:1293` at v3.10.0, `:1278` at v3.8.0): `amount` must parse as a `Decimal`; a category target needs a non-empty `taxonomyId` and `categoryId` and no `groupId`; the spending taxonomy is `spending_categories` (`:30`/`:31`). A `'default'` target is read by `TargetIndex::default_category` (`:1084`/`:1069`): the target whose `period_key` is `"default"`, used for any month that has no target of its own. `BudgetService::get` answers an EMPTY snapshot while the Spending tracker is off (`if !settings.enabled`, `:233`/`:234`) and otherwise first runs `ensure_system_groups` (`:237`/`:238`), so a live snapshot always has groups. The storage `upsert_target` (`crates/storage-sqlite/src/spending/budget.rs:649`, both tags) finds an existing target for the same (period, taxonomy, category) and **UPDATES its amount** (`:704`) — the POST overwrites — and otherwise inserts with a deterministic id; `delete_target` (`:730`) deletes by id and succeeds when nothing matched. All of this is identical at v3.8.0, v3.9.0 and v3.10.0.
- **(e) Spend history.** `getNativeSpendMatrix(dbPath, startInclusive, endExclusive)` (`companion/src/sqlite-native.ts:1314-1346`) sums SIGNED DOLLARS per `strftime('%Y-%m', activity_date)`, `COALESCE(parent.name, tc.name)` — the rolled-up NAME — and account, over the spending taxonomy only, bookkeeping rows and transfer-named categories excluded: the cube's own series. Name → id: `getNativeSpendingCategories` (`:1017-1057`, `{ id, name, parentId, parentName }`). Excluded categories and the timezone: `getNativeAuditSettings` (`companion/src/sqlite-audit.ts:176-240`, strict — it throws when the database cannot be read — returning `timezone`, `excludedCategoryIds` from `spending.excluded_category_ids`, `categoryParents`, `spendingOn`), with R1's `excludedWithDescendants` (`shared/audit-headline.ts:204-224`) for descendants. "Opening balances" is `OPENING_BALANCES_CATEGORY` (`shared/sync-core.ts:92`), the category `companion/src/opening-balance-category.ts` creates (excluded on 3.9+; 3.8 has no exclusions, so it is skipped by name). Wealthfolio's timezone is its `timezone` setting, as R1's `zonedMonthBounds` (`shared/audit-headline.ts:386`) reads it; the new `zonedMonth` uses `Intl` with the same fallback (the process's own zone).
- **(f) The change log.** `ChangeKind`/`CHANGE_KINDS` (`shared/change-entries.ts:31-48`); `UNDO_KINDS` = `SYNC_DECISION_KINDS` ∪ `COMPANION_ONLY_KINDS` ∪ the rest (`shared/change-undo.ts:29-38`); `budget-set` is not a sync decision (no override) — it joins `COMPANION_ONLY_KINDS`, which is exactly the 2a rule: `undoAvailability` answers the app with "Undo this from Telegram: /changes" (`:82-86`). `GROUP_OF` and `changeBeforeAfter` (`shared/change-view.ts:28-45`, `:97-134`); the planner's switch (`change-undo.ts:277-571`); the runner's `UndoIo`, `gather`, `performStep` and `reversalExtra` (`shared/change-undo-run.ts:50-71`, `:200-264`, `:301-368`, `:371-382`); the companion's `companionUndoIo` (`companion/src/change-undo-host.ts:29-57`). Two existing tests enumerate the kinds (`shared/change-entries.test.ts:37`, `:143`) and are updated in Task 7.
- **Telegram prefixes (Q3).** In use: `cz:<generation>:<index>` (`shared/categorize-menu.ts:312`, `:411`), `cz:ak:`, `cz:wy:`, `cz:sb:`, `cz:cl:`, `cz:fx:`, `cz:au:`, `cz:al:`, `cz:alc:`, `cz:tl:`, `cz:tlc:`, `cz:tlk:`, `cz:tlu:`, `cz:open`, `cz:recat`. New: **`cz:bg:`** — none of them starts with it and it starts with none (pinned in Task 9). `onMenuCallback` asks each `cz:` menu in turn and only then falls through to the categorize menu, which reads unknown `cz:` data as an expired session; `cz:bg:` goes right after `cz:au:` (`companion/src/index.ts:3841-3845`).
- **Baselines** at 57e9a42 (in a scratch clone): `npm test` 2518 tests in 98 files; `npm --prefix companion test` 1119 in 45. After this plan: 2574 and 1158.

**Deviations from the spec (decided, do not "fix"):**
- **The card does not fill in "the add-on's id"** (G1): the companion reads no variable for it — `simplefin-sync` is fixed in its code — and `composeSnippet`'s options (spec A) have no such field.
- **`docker-compose.example.yml` becomes exactly the snippet:** its header comment, the commented `build:` lines, `user: "1000:1000"` (the image already runs as `node`) and the external network go; the README's style — the service added to the compose file that runs Wealthfolio, sharing its default network — is the one kept (G1).
- **The password comes from a Compose secret**, as spec A says, where the README and card showed `WEALTHFOLIO_PASSWORD=your_wealthfolio_password`: `WEALTHFOLIO_PASSWORD_FILE=/run/secrets/wealthfolio_password`, a `secrets:` entry, and a top-level `secrets: wealthfolio_password: file: ./wealthfolio_password.txt`. The API key is a commented line; host networking is a commented `network_mode: host` with the `127.0.0.1` URL in its comment. `SYNC_SCHEDULE` and `MIN_SYNC_INTERVAL_HOURS` leave the snippet; the card and the README say "It syncs every 6 hours; add `SYNC_SCHEDULE` (a cron line) to change that."
- **A Wealthfolio whose Spending tracker is off has no budgets to suggest or undo.** `/budgets` says "Wealthfolio's Spending tracker is off, so it has no budgets — turn it on in Wealthfolio first." (from its settings, or from the empty snapshot Wealthfolio answers then); a budget Undo while it is off says it couldn't reach Wealthfolio and changes nothing — an empty snapshot is never read as "already gone".
- **Redo exists for `budget-set`.** The spec names only Undo; the change log offers Redo on every undone entry, so Redo sets the budget again — refusing, never overwriting, when the category has a default budget again.
- **Two skip rules the spec did not name:** a spending-matrix name the catalog cannot place on exactly ONE top-level category ("unknown-category"; the spec matches by id), and past the 24 biggest ("over-limit": one button each, a 24-bit mask).
- **The skip order is fixed:** Opening balances → unknown → excluded → under $10 → over the limit → has a budget; the first that applies is the reason.
- **The budget card's "no budgets" line** replaces "No budgets or spending this month." (which can no longer appear: a card with no rows has no budget either) and also sits above the spending rows whenever no category in the window has a budget.
- **The preview's chrome:** the banner "Sample data — not your money" with the line "Made-up accounts and spending, to show what these reports look like once the companion syncs. Nothing here is saved." and a **Close preview** button; the empty board's button reads **Preview with sample data** beside **Set up background sync**; setup step 1 opens it as a panel under the step card (not a modal); drill-down rows show the sample's transactions and open nothing.
- **`budget-set` files under the change log's Categories group** (a budget belongs to a category, beside its filings), and reads "No budget → $425.00 a month" as its before → after.
- **The window's "this month" is placed in Wealthfolio's timezone; rows are bucketed by their stored date**, as every report and the cube read them (follow-ups §14).
- **`/budgets` copy the spec did not spell out** is in Global Constraints; its heading is plain text with no glyph, ✓ marks a picked or set category.

**Task order:** the snippet (1) and its card (2); the sample cube (3), the preview (4) and its two pointers — setup step 1 and the budget card (5); the pure suggestions (6); the change log's `budget-set` (7); the companion's budget REST and the host that applies (8); `/budgets` (9) and its wiring (10); docs, the forced-date run and every gate (11).

## Global Constraints

- **Never overwrite a budget.** Wealthfolio's POST is an upsert: a category is written only after the budget is re-read and it has neither a `'default'` target nor one for this month; Undo deletes only a target whose id, period and amount are still what it recorded; Redo refuses when the category has a default target again.
- **Suggestions (G4, verbatim):** the average of the last 3 FULL months of a category's spending (all accounts, refunds net out, a month with nothing counts as $0), rounded UP to the nearest $5; categories averaging under $10 skipped; only categories with no budget (`'default'` or this month); excluded categories and "Opening balances" skipped; only `'default'` targets written (`periodKey: 'default'`, `targetType: 'category'`, `taxonomyId: 'spending_categories'`, `amount` a decimal string). Constants: `BUDGET_WINDOW_MONTHS = 3`, `BUDGET_MIN_AVERAGE_CENTS = 1000`, `BUDGET_ROUND_CENTS = 500`, `BUDGET_MAX_CANDIDATES = 24` (`shared/budget-suggest.ts`).
- **Copy (verbatim):** app — `Sample data — not your money` · `Made-up accounts and spending, to show what these reports look like once the companion syncs. Nothing here is saved.` · `Preview with sample data` · `Close preview` · `See what it looks like` · `No budgets yet — /budgets in Telegram suggests some from your last 3 months.` · `Copy` · `Copied.` · `Couldn't copy here — select the text above and copy it.`; Telegram — `Suggested budgets` (heading) · `Your average monthly spending for <Jul–Sep>, rounded up to the nearest $5, for each category with no budget yet. Each becomes a default monthly budget in Wealthfolio.` · `Tap a category to leave it out.` · `Apply all (N)` · `Apply selected (N)` · `<name> <$420> — left out` · `Budgets` (heading) · `✓ <name>: <$420> a month` · `<name>: Already has a budget — left alone.` · `<name>: couldn't set it — <error>` · `Undo any of these from /changes.` · `Send /budgets again to try the rest.` · `Couldn't read your budgets — nothing was set.` · `Couldn't read your budgets — try again.` · `Couldn't read your spending from Wealthfolio's database — try again.` · `Wealthfolio's Spending tracker is off, so it has no budgets — turn it on in Wealthfolio first.` · `Every category you spend on already has a budget — nothing to suggest.` · `Nothing to suggest yet: no category averaged $10 or more a month over the last 3 full months.` · `Your spending changed since that list — here it is again.` · `Pick at least one first.` · `Try again`; change log — `Set a <$425.00> monthly budget for <name>` · `Your average for <Jul–Sep>, rounded up to the nearest $5` · `No budget → <$425.00> a month` · `Undone — <name> has no budget.` · `That budget is already gone — nothing was undone.` · `Redone — <name> has its <$425.00> budget back.` · `<name> has a budget again — nothing was redone.`; `/help` — `/budgets — Suggested budgets from your last 3 months, for categories with none`.
- **Raw text in shared code.** Category names (and Wealthfolio's error text) are RAW in `shared/` and the host; Telegram escapes them with `escapeMarkdown` and keeps them outside every `*…*` — the only entities are the two fixed headings; button labels are plain text, not escaped; the app renders them as React text.
- **No emoji in the app** (`\p{Extended_Pictographic}`, `src/pages/copy-policy.test.tsx`); none in `/budgets` either — ✓ (a typographic mark) is allowed. New CSS classes are defined once at column 0 (`src/components/theme-styles.test.ts`). Copy never says "Budget tab" (`shared/tab-names.test.ts`).
- **Telegram.** `/budgets` joins `/help`'s More commands, NOT the seven-command ☰ menu. Prefix `cz:bg:` (`BUDGETS_CALLBACK_PREFIX`), routed in `onMenuCallback` right after `cz:au:` and before the categorize fallthrough; nothing else starts with `cz:bg`. Stateless: every tap re-reads; toggles carry the category's `findingHandle`, and every button carries the list's fingerprint and a selection mask. Every `callback_data` ≤ 64 bytes (the longest is 29).
- **Compose snippet.** Written once (`composeSnippet`); README.md's yaml block and `docker-compose.example.yml` are its default output, checked by a test; never a password value; the browser's timezone only when it is an IANA name.
- **Preview.** Budget board only; read-only — no Customize, no "+ Add report", no layout, report, pool or subscription edit; dated from when it opens; never "stale".
- **Tests use a fixed `now`.** Shared and companion: fixed `Date`s and a `now` argument; the app and the wiring tests: `now` props or `vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(...)` with `vi.useRealTimers()` after. Every new test file also passes with the date forced to 2027-01-01 (Task 11).
- **Imports:** shared sources import siblings WITH `.js`; `src/` imports shared WITHOUT an extension; companion imports `'../../shared/x.js'` and `'./x.js'`.
- **Run the companion suite from `companion/`** (`cd companion && npx vitest run …`), never with `--root`.
- **Gates before calling a task done:** the touched project's tests, plus `npm run type-check` when `src/` or `shared/` changed and `npm --prefix companion run build` when `companion/` or `shared/` changed. Final task: `npm test`, `npm --prefix companion test`, `npm run type-check`, `npm --prefix companion run build`. On the Mac, run builds and full suites under `nice` — it overheats.
- **Edits are exact.** Every "replace" block below is copied from the file as it stands after the previous tasks (and the earlier edits of the same file in the same step) and occurs exactly once; replace it verbatim (the Edit tool's `old_string` → `new_string`). A blank last line inside a block is a trailing newline that belongs to it. Apply a file's numbered edits in order. Every "Create" block is the whole file.
- **No version bump, tag or release.** CHANGELOG goes under `[Unreleased]`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A budget added between the list and Apply** (in Wealthfolio, or by a second `/budgets`) → left alone and said so ("Already has a budget — left alone."), never overwritten; the others still apply. Pinned in Task 6 (`leaves alone a category that gained a budget since the list was shown`), Task 8 (`never overwrites a budget added since the list was shown: re-reads, writes the rest, logs each`) and Task 9 (`never overwrites a budget added between the list and Apply: it is left alone and said so`).
- **One POST that fails** → that category says "couldn't set it — <error>", the rest are set and logged, and the reply says to send `/budgets` again. Pinned in Task 8 (`keeps going when one POST fails, and says which`) and Task 9 (`one failing category does not stop the rest`).
- **The 3-full-month window across a year boundary, and in Wealthfolio's timezone** → January's window is Oct–Dec; 03:00 UTC on Jan 1 is still December in New York. Pinned in Task 6 (`crosses a year boundary`; `places "this month" in Wealthfolio’s timezone, not UTC`).
- **Rounding** → up to the nearest $5, never down; an exact multiple stays. Pinned in Task 6 (`rounds up to the nearest $5 and never down`; `averages each category over the 3 full months, …`).
- **Every skip rule** → an existing default or this-month budget, excluded, Opening balances (also on 3.8), under $10 (and $10 exactly kept), refunds that outweigh spending, a name the catalog cannot place, past 24. Pinned in Task 6 (five tests from `never suggests over an existing budget` to `offers at most 24, biggest first, ties by name`).
- **The sample cube passes `parseReportCube`, and the preview writes nothing** → every dimension and the round-trip; no Customize, no Add report, no headline picker, no subscription or pool edit, every write spy uncalled, from the board and from setup step 1. Pinned in Task 3 (`passes parseReportCube, every dimension index-aligned, and round-trips unchanged`), Task 4 (`writes nothing: …`) and Task 5 (`shows the sample-data preview from step 1, writes nothing, and closes it`).
- **The snippet drifting** → README.md or `docker-compose.example.yml` differing from `composeSnippet()` fails a test that names the file. Pinned in Task 1 (`README.md shows exactly the default snippet, once`; `docker-compose.example.yml is exactly the default snippet`).
- **Undo of `budget-set`** → deletes the target; one whose amount (or period) changed since refuses; one that is gone refuses; while Spending is off it changes nothing. Pinned in Task 7 (`Undo deletes the target it created`; `refuses when the target changed since …`; the runner's undo → redo → undo) and Task 8 (`undoes a budget set from /budgets by deleting its target …`; `won't undo a budget while Wealthfolio's Spending tracker is off …`).
- **A category name full of Markdown characters** (`Joe's *Diner*_[1]`) → escaped in every `/budgets` message and outside every entity, raw on its button and in the change log. Pinned in Task 6 (`keeps category names raw`), Task 7 (`says what was set, raw, …`) and Task 9 (`lists the suggestions with the window, the names escaped in the text and raw on the buttons`).
- **The longest callback** → within 64 bytes; with 24 suggestions the longest is 29. Pinned in Task 9 (`keeps every button within 64 bytes — with 24 suggestions the longest is 29`).
- **A tap routed by prefix** → `cz:bg:` reaches the budgets menu, not the transaction menu's "expired" answer. Pinned in Task 10 (`cz:bg: taps reach the budgets menu, not the transaction menu: …`).
- **Dates** → every test passes a fixed `now`; Task 11 runs every new and changed test file with the date forced to 2027-01-01.

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/compose-snippet.ts` (create) | `composeSnippet({ timezone?, wealthfolioUrl? })`, the image, URL and timezone defaults: the one compose service. |
| `README.md`, `docker-compose.example.yml` (modify) | Carry `composeSnippet()` verbatim (Task 1); the README's `/budgets` and the preview (Task 11). |
| `src/components/DockerSnippet.tsx` (create) | The Settings card's body: the snippet with `browserTimezone()`, a Copy button. |
| `src/tabs/SettingsTab.tsx` (modify) | The Docker card renders `DockerSnippet`. |
| `shared/sample-cube.ts` (create) | `sampleReportCube(now)`, `SAMPLE_CATEGORIES`, `SAMPLE_MONTHS`. |
| `src/tabs/BudgetTab.tsx` (modify) | The `preview` prop, the banner, "Preview with sample data" on the empty board, `BudgetPreview`. |
| `src/pages/SetupPage.tsx` (modify) | Step 1's "See what it looks like" panel. |
| `src/components/budget/ReportView.tsx` (modify) | `NO_BUDGETS_YET` on the budget card. |
| `src/components/ui.tsx` (modify) | `.sfin-docker-copy`, `.sfin-budget-empty-actions`, `.sfin-preview-banner`, `.sfin-setup-preview`. |
| `shared/budget-suggest.ts` (create) | `BudgetTarget`, `zonedMonth`, `budgetWindow`, `suggestBudgets`, `planBudgetApply`, `hasBudget`, the words. Pure. |
| `shared/change-entries.ts`, `shared/change-view.ts`, `shared/change-undo.ts`, `shared/change-undo-run.ts` (modify) | The `budget-set` kind: its builder, group and before → after, its Undo/Redo plan, the runner's `budgets` io and steps. |
| `companion/src/wealthfolio.ts` (modify) | `parseBudgetSnapshot`, `getBudgetTargets`, `setDefaultBudgetTarget`, `deleteBudgetTarget`. |
| `companion/src/budget-suggest-host.ts` (create) | `BudgetReaders`, `companionBudgetReaders`, `readBudgetSuggestions`, `applyBudgetSuggestions`. |
| `companion/src/change-undo-host.ts` (modify) | `companionUndoIo` lends the runner the budget calls. |
| `companion/src/budgets-menu.ts` (create) | `/budgets`: the `cz:bg:` encoding, the list and result screens, `createBudgetsMenu`, `budgetsMenuDeps`. A focused file beside `audit-menu.ts`. |
| `companion/src/index.ts`, `shared/telegram-commands.ts` (modify) | `buildBudgetsMenu`, `/budgets`, `cz:bg:` routing; `/budgets` in More commands. |
| `CHANGELOG.md`, `docs/superpowers/follow-ups.md` (modify) | Docs and follow-ups §14. |

---

### Task 1: One compose snippet — written once, the README and the example file checked against it

The one companion service (spec A, G1; Q1a): `composeSnippet` builds it — the image, `restart: unless-stopped`, Wealthfolio's service name on a shared network (host networking as a comment), the password from a Compose secret (an API key as a comment), the database folder mounted read-only where `WEALTHFOLIO_DB_PATH` looks, and `TZ` (a given IANA zone, else America/New_York with a comment to change it). README.md's yaml block and `docker-compose.example.yml` are committed with its default output, and the test fails when either drifts.

**Files:**
- Create: `shared/compose-snippet.ts`, `shared/compose-snippet.test.ts`
- Modify: `README.md` (the "Background sync & Telegram notifications" yaml block and the sentence before it, `:210-229`), `docker-compose.example.yml` (the whole file)

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
// shared/compose-snippet.ts
export const COMPANION_IMAGE: string;          // 'ghcr.io/bubbles840/wealthfolio-simplefin-sync:latest'
export const DEFAULT_WEALTHFOLIO_URL: string;  // 'http://wealthfolio:8088'
export const DEFAULT_TIMEZONE: string;         // 'America/New_York'
export interface ComposeSnippetOptions { timezone?: string | null; wealthfolioUrl?: string | null }
export function composeSnippet(options?: ComposeSnippetOptions): string;   // no trailing newline
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/compose-snippet.test.ts`:**

````ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { composeSnippet, COMPANION_IMAGE, DEFAULT_TIMEZONE, DEFAULT_WEALTHFOLIO_URL } from './compose-snippet.js';

const root = join(__dirname, '..');
const DEFAULT_TZ_LINE = `      - TZ=${DEFAULT_TIMEZONE}   # change to your timezone, or every schedule runs on UTC\n`;

describe('composeSnippet', () => {
  it("is the service the README always described: the image, a restart policy, Wealthfolio's service name", () => {
    const s = composeSnippet();
    expect(s.split('\n').slice(0, 5)).toEqual([
      'services:', '  simplefin-sync:', `    image: ${COMPANION_IMAGE}`, '    restart: unless-stopped', '    environment:',
    ]);
    expect(s).toContain(`      - WEALTHFOLIO_API_URL=${DEFAULT_WEALTHFOLIO_URL}   # Wealthfolio's service name and port\n`);
    // Host networking only as a comment: the bridge style is the default.
    expect(s).toContain('    # network_mode: host\n');
    expect(s).not.toMatch(/^\s*network_mode:/m);
  });

  it('reads the password from a Compose secret and never carries one', () => {
    const s = composeSnippet({ timezone: 'Europe/Berlin' });
    expect(s).toContain('      - WEALTHFOLIO_PASSWORD_FILE=/run/secrets/wealthfolio_password\n');
    expect(s).toContain('    secrets:\n      - wealthfolio_password\n');
    expect(s.endsWith("secrets:\n  wealthfolio_password:\n    file: ./wealthfolio_password.txt   # Wealthfolio's password, on one line")).toBe(true);
    // The API key is the commented alternative.
    expect(s).toContain('      # - WEALTHFOLIO_API_KEY=your_api_key\n');
    expect(s).not.toMatch(/^\s*- WEALTHFOLIO_API_KEY=/m);
    expect(s).not.toMatch(/WEALTHFOLIO_PASSWORD=/);
  });

  it('mounts the database FOLDER read-only, where WEALTHFOLIO_DB_PATH looks', () => {
    const s = composeSnippet();
    expect(s).toContain('      - WEALTHFOLIO_DB_PATH=/mnt/wealthfolio/wealthfolio.db\n');
    expect(s).toContain('      - /path/to/wealthfolio:/mnt/wealthfolio:ro\n');
    // Never the bare .db file: a file-only mount hides the -wal/-shm files.
    expect(s).not.toMatch(/wealthfolio\.db:\/mnt/);
  });

  it('fills in a timezone it is given, and says to change the default otherwise', () => {
    expect(composeSnippet({ timezone: 'America/Argentina/Buenos_Aires' })).toContain('      - TZ=America/Argentina/Buenos_Aires\n');
    expect(composeSnippet({ timezone: 'Etc/GMT+5' })).toContain('      - TZ=Etc/GMT+5\n');
    expect(composeSnippet({ timezone: ' UTC ' })).toContain('      - TZ=UTC\n');
    for (const timezone of [undefined, null, '', '   ', 'not a zone', 'Europe/Berlin # x', 'a\nb', '/Berlin']) {
      expect(composeSnippet({ timezone })).toContain(DEFAULT_TZ_LINE);
    }
  });

  it('takes a Wealthfolio URL, keeping the default for anything that is not one', () => {
    expect(composeSnippet({ wealthfolioUrl: 'http://192.168.1.20:8088' })).toContain('      - WEALTHFOLIO_API_URL=http://192.168.1.20:8088\n');
    for (const wealthfolioUrl of [null, '', 'wealthfolio:8088', 'http://x y', 'ftp://x', 'http://x#y']) {
      expect(composeSnippet({ wealthfolioUrl })).toContain(`      - WEALTHFOLIO_API_URL=${DEFAULT_WEALTHFOLIO_URL}   #`);
    }
  });
});

describe('the committed copies (drift check)', () => {
  it('README.md shows exactly the default snippet, once', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    const blocks = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]).filter((b) => b.includes('simplefin-sync'));
    expect(blocks).toEqual([`${composeSnippet()}\n`]);
  });

  it('docker-compose.example.yml is exactly the default snippet', () => {
    expect(readFileSync(join(root, 'docker-compose.example.yml'), 'utf8')).toBe(`${composeSnippet()}\n`);
  });
});
````

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/compose-snippet.test.ts`
Expected: FAIL — `Failed to resolve import "./compose-snippet.js" from "shared/compose-snippet.test.ts"`; no tests run.

- [ ] **Step 3: Implement**

**Create `shared/compose-snippet.ts`:**

```ts
/**
 * shared/compose-snippet.ts
 *
 * The companion's Docker Compose service, written ONCE (project 4, G1). There
 * were three copies and they disagreed: the README's (bridge network, TZ), the
 * example file's (the same plus `user` and an external network) and the
 * Settings card's (host network, `127.0.0.1`, and no TZ — which the companion
 * warns about at startup). Now the Settings card "Background sync (Docker)"
 * renders this with the browser's timezone, and README.md and
 * docker-compose.example.yml carry its default output verbatim;
 * shared/compose-snippet.test.ts fails when either drifts.
 *
 * Never a password: the password is read from a Compose secret
 * (`WEALTHFOLIO_PASSWORD_FILE`), with an API key as the commented alternative.
 * The README's bridge style — Wealthfolio's service name resolves on the
 * shared Compose network — with host networking as a comment. The database
 * mount is the FOLDER, read-only: the live read needs the -wal/-shm files
 * beside wealthfolio.db (see companion/src/sqlite-native.ts), and a file-only
 * mount silently serves whatever was last checkpointed, observed two days
 * stale.
 */

export const COMPANION_IMAGE = 'ghcr.io/bubbles840/wealthfolio-simplefin-sync:latest';
/** Wealthfolio's service name and default port, on a shared Compose network. */
export const DEFAULT_WEALTHFOLIO_URL = 'http://wealthfolio:8088';
/** What the snippet carries when the browser's timezone is unknown. */
export const DEFAULT_TIMEZONE = 'America/New_York';

export interface ComposeSnippetOptions {
  /** An IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`).
   *  Absent, or not a zone name: America/New_York, with a comment to change it. */
  timezone?: string | null;
  /** Absent, or not an http(s) URL: http://wealthfolio:8088. */
  wealthfolioUrl?: string | null;
}

/** An IANA name (`Europe/Berlin`, `America/Argentina/Buenos_Aires`, `Etc/GMT+5`,
 *  `UTC`) — nothing a YAML line could choke on. */
const ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;
const WEB_URL = /^https?:\/\/[^\s#'"]+$/;

export function composeSnippet(options: ComposeSnippetOptions = {}): string {
  const zone = (options.timezone ?? '').trim();
  const url = (options.wealthfolioUrl ?? '').trim();
  return [
    'services:',
    '  simplefin-sync:',
    `    image: ${COMPANION_IMAGE}`,
    '    restart: unless-stopped',
    '    environment:',
    WEB_URL.test(url)
      ? `      - WEALTHFOLIO_API_URL=${url}`
      : `      - WEALTHFOLIO_API_URL=${DEFAULT_WEALTHFOLIO_URL}   # Wealthfolio's service name and port`,
    '      - WEALTHFOLIO_PASSWORD_FILE=/run/secrets/wealthfolio_password',
    '      # Or sign in with an API key instead of the password:',
    '      # - WEALTHFOLIO_API_KEY=your_api_key',
    '      - WEALTHFOLIO_DB_PATH=/mnt/wealthfolio/wealthfolio.db',
    ZONE.test(zone)
      ? `      - TZ=${zone}`
      : `      - TZ=${DEFAULT_TIMEZONE}   # change to your timezone, or every schedule runs on UTC`,
    '    secrets:',
    '      - wealthfolio_password',
    '    volumes:',
    '      # The FOLDER holding wealthfolio.db, read-only. A file-only mount hides',
    '      # the -wal/-shm files beside it, so the companion reads stale data.',
    '      - /path/to/wealthfolio:/mnt/wealthfolio:ro',
    '    # Wealthfolio on the host network instead? Uncomment the next line and',
    '    # set WEALTHFOLIO_API_URL=http://127.0.0.1:8088 above.',
    '    # network_mode: host',
    '',
    'secrets:',
    '  wealthfolio_password:',
    "    file: ./wealthfolio_password.txt   # Wealthfolio's password, on one line",
  ].join('\n');
}
```

Edit 1 of 1 in `README.md` — replace:

````markdown
The companion runs on the exact same shared sync core as the in-app addon. Account
mappings and credentials are configured directly in Wealthfolio via the addon UI,
so the companion container runs as a lightweight background daemon:

```yaml
services:
  simplefin-sync:
    image: ghcr.io/bubbles840/wealthfolio-simplefin-sync:latest
    restart: unless-stopped
    environment:
      - WEALTHFOLIO_API_URL=http://wealthfolio:8088   # Wealthfolio's default port
      - WEALTHFOLIO_PASSWORD=your_wealthfolio_password
      - WEALTHFOLIO_DB_PATH=/mnt/wealthfolio/wealthfolio.db
      - TZ=America/New_York          # Required, or schedules fire on UTC
    volumes:
      # Mount the FOLDER containing wealthfolio.db, not the .db file itself.
      # A file-only mount hides the -wal/-shm files beside it, so the companion
      # reads whatever was last checkpointed — observed two days stale.
      - /path/to/wealthfolio:/mnt/wealthfolio:ro
```
````

with:

````markdown
The companion runs on the exact same shared sync core as the in-app addon. Account
mappings and credentials are configured directly in Wealthfolio via the addon UI,
so the companion container runs as a lightweight background daemon. Add it to the
`docker-compose.yml` that runs Wealthfolio, put Wealthfolio's password in
`wealthfolio_password.txt` beside that file, and run `docker compose up -d`. The
addon's **Settings → Background sync (Docker)** card shows the same service with
your timezone filled in, and a Copy button:

```yaml
services:
  simplefin-sync:
    image: ghcr.io/bubbles840/wealthfolio-simplefin-sync:latest
    restart: unless-stopped
    environment:
      - WEALTHFOLIO_API_URL=http://wealthfolio:8088   # Wealthfolio's service name and port
      - WEALTHFOLIO_PASSWORD_FILE=/run/secrets/wealthfolio_password
      # Or sign in with an API key instead of the password:
      # - WEALTHFOLIO_API_KEY=your_api_key
      - WEALTHFOLIO_DB_PATH=/mnt/wealthfolio/wealthfolio.db
      - TZ=America/New_York   # change to your timezone, or every schedule runs on UTC
    secrets:
      - wealthfolio_password
    volumes:
      # The FOLDER holding wealthfolio.db, read-only. A file-only mount hides
      # the -wal/-shm files beside it, so the companion reads stale data.
      - /path/to/wealthfolio:/mnt/wealthfolio:ro
    # Wealthfolio on the host network instead? Uncomment the next line and
    # set WEALTHFOLIO_API_URL=http://127.0.0.1:8088 above.
    # network_mode: host

secrets:
  wealthfolio_password:
    file: ./wealthfolio_password.txt   # Wealthfolio's password, on one line
```

It syncs every 6 hours; add `SYNC_SCHEDULE` (a cron line, e.g. `0 */3 * * *`) to
the environment to change that. `docker-compose.example.yml` is the same service.
````

**Replace the whole of `docker-compose.example.yml` with:**

```yaml
services:
  simplefin-sync:
    image: ghcr.io/bubbles840/wealthfolio-simplefin-sync:latest
    restart: unless-stopped
    environment:
      - WEALTHFOLIO_API_URL=http://wealthfolio:8088   # Wealthfolio's service name and port
      - WEALTHFOLIO_PASSWORD_FILE=/run/secrets/wealthfolio_password
      # Or sign in with an API key instead of the password:
      # - WEALTHFOLIO_API_KEY=your_api_key
      - WEALTHFOLIO_DB_PATH=/mnt/wealthfolio/wealthfolio.db
      - TZ=America/New_York   # change to your timezone, or every schedule runs on UTC
    secrets:
      - wealthfolio_password
    volumes:
      # The FOLDER holding wealthfolio.db, read-only. A file-only mount hides
      # the -wal/-shm files beside it, so the companion reads stale data.
      - /path/to/wealthfolio:/mnt/wealthfolio:ro
    # Wealthfolio on the host network instead? Uncomment the next line and
    # set WEALTHFOLIO_API_URL=http://127.0.0.1:8088 above.
    # network_mode: host

secrets:
  wealthfolio_password:
    file: ./wealthfolio_password.txt   # Wealthfolio's password, on one line
```

(The file is `composeSnippet()` followed by one newline — exactly what the drift test compares.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/compose-snippet.test.ts`
Expected: PASS — 7 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/compose-snippet.ts shared/compose-snippet.test.ts README.md docker-compose.example.yml
git commit -m "Getting started: one compose snippet, the README's and the example file's copies checked against it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The Settings card renders the snippet — the browser's timezone, a Copy button

Settings → "Background sync (Docker)" (spec A; Q1a). `DockerSnippet` renders `composeSnippet` with `browserTimezone()` — `Intl.DateTimeFormat().resolvedOptions().timeZone`, or the commented default when Intl has none — a Copy button that says when the sandbox refuses the clipboard (the `<pre>` stays selectable, as the Amazon card's samples do), and the note on the database mount, now also naming `SYNC_SCHEDULE`. The card's own hand-written snippet (host network, no `TZ`) goes. The existing `gives the companion everything it needs in the compose snippet, database included` test (`src/tabs/SettingsTab.test.tsx`) keeps passing unchanged.

**Files:**
- Create: `src/components/DockerSnippet.tsx`, `src/components/DockerSnippet.test.tsx`
- Modify: `src/tabs/SettingsTab.tsx` (the Docker card, `:537-582`), `src/components/ui.tsx` (`.sfin-docker-copy`)

**Interfaces:**
- Consumes: Task 1 (`composeSnippet`).
- Produces:

```ts
// src/components/DockerSnippet.tsx
export function browserTimezone(): string | null;
export function DockerSnippet(props: { timezone?: string | null }): JSX.Element;   // timezone defaults to browserTimezone()
```

- [ ] **Step 1: Write the failing tests**

**Create `src/components/DockerSnippet.test.tsx`:**

```tsx
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { browserTimezone, DockerSnippet } from './DockerSnippet';
import { composeSnippet } from '../../shared/compose-snippet';

const EMOJI = /\p{Extended_Pictographic}/u;
const shown = () => document.querySelector('pre')!.textContent;

describe('DockerSnippet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('renders the shared snippet with the timezone filled in, and never a password', () => {
    render(<DockerSnippet timezone="Europe/Berlin" />);
    expect(shown()).toBe(composeSnippet({ timezone: 'Europe/Berlin' }));
    expect(shown()).toContain('      - TZ=Europe/Berlin\n');
    expect(shown()).not.toMatch(/WEALTHFOLIO_PASSWORD=/);
    expect(document.body.textContent).not.toMatch(EMOJI);
  });

  it("fills in this browser's own timezone by default", () => {
    const real = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), timeZone: 'Asia/Tokyo' };
    });
    expect(browserTimezone()).toBe('Asia/Tokyo');
    render(<DockerSnippet />);
    expect(shown()).toContain('      - TZ=Asia/Tokyo\n');
  });

  it('keeps the default zone, with its comment, when the browser has none', () => {
    render(<DockerSnippet timezone={null} />);
    expect(shown()).toBe(composeSnippet());
  });

  it('copies the snippet, and says so when the sandbox refuses the clipboard', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<DockerSnippet timezone="Europe/Berlin" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByText(/Copied\./)).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(composeSnippet({ timezone: 'Europe/Berlin' }));
    writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(screen.getByText(/Couldn.t copy here/)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/DockerSnippet.test.tsx`
Expected: FAIL — `Failed to resolve import "./DockerSnippet" from "src/components/DockerSnippet.test.tsx"`; no tests run.

- [ ] **Step 3: Implement**

**Create `src/components/DockerSnippet.tsx`:**

```tsx
import React, { useState } from 'react';
import { Button } from './ui';
import { composeSnippet } from '../../shared/compose-snippet';

/** This browser's IANA zone, or null where Intl cannot say. */
export function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * The body of Settings → "Background sync (Docker)" (project 4, G1): the ONE
 * compose service (shared/compose-snippet.ts) with this browser's timezone
 * filled in, and a Copy button. It is the only setup instruction most people
 * read, so it is complete — the database mount included. The `<pre>` stays
 * selectable: the add-on runs in a sandboxed iframe, where the clipboard API
 * may be refused.
 */
export function DockerSnippet({ timezone = browserTimezone() }: { timezone?: string | null }) {
  const snippet = composeSnippet({ timezone });
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <div>
      <div className="sfin-subtle sfin-docker-intro">
        Add this service to the <code>docker-compose.yml</code> that runs Wealthfolio, put
        Wealthfolio&apos;s password in <code>wealthfolio_password.txt</code> beside it, and
        run <code>docker compose up -d</code>.
      </div>
      <pre className="sfin-pre sfin-docker-pre">{snippet}</pre>
      <div className="sfin-docker-copy">
        <Button variant="outline" onClick={copy}>Copy</Button>
        {copied === 'ok' && <span className="sfin-subtle"> Copied.</span>}
        {copied === 'failed' && (
          <span className="sfin-subtle"> Couldn&apos;t copy here — select the text above and copy it.</span>
        )}
      </div>
      <div className="sfin-subtle sfin-docker-note">
        The database mount is what lets the companion count spending that still
        needs a category, and fill in category names and budgets in its reports.
        Point it at the folder that contains <code>wealthfolio.db</code>. It syncs
        every 6 hours; add <code>SYNC_SCHEDULE</code> (a cron line) to change that.
      </div>
    </div>
  );
}
```

Edit 1 of 2 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
import { AccountList, accountsSummary } from '../components/AccountList';
import { AccountAudit, ChecksCard, checksSummary } from '../components/AuditViews';
```

with:

```tsx
import { AccountList, accountsSummary } from '../components/AccountList';
import { AccountAudit, ChecksCard, checksSummary } from '../components/AuditViews';
import { DockerSnippet } from '../components/DockerSnippet';
```

Edit 2 of 2 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
        onToggle={() => toggleCard(CARD.docker)}
      >
        <div>
          <div className="sfin-subtle sfin-docker-intro">
            Add this service to your <code>docker-compose.yml</code>. You can customize the sync rate via <code>SYNC_SCHEDULE</code>:
          </div>
          {/* The snippet has to be COMPLETE, because it is the only setup
              instruction most people will ever read. It used to set neither
              WEALTHFOLIO_DB_PATH nor a mount for the database, so following it
              exactly produced a companion that synced fine and a "Needs a
              category" tile that never appeared, with nothing on screen to say
              why. The directory is mounted, not the .db file: reading live data
              needs the -wal/-shm files beside it — see the comment in
              companion/src/sqlite-native.ts — and a file-only mount silently
              serves whatever was last checkpointed, which has been observed two
              days stale. */}
          <pre className="sfin-pre sfin-docker-pre">
            {`services:
  simplefin-sync:
    image: ghcr.io/bubbles840/wealthfolio-simplefin-sync:latest
    container_name: simplefin-sync
    restart: always
    network_mode: host
    environment:
      - WEALTHFOLIO_API_URL=http://127.0.0.1:8088
      - WEALTHFOLIO_PASSWORD=your_wealthfolio_password
      - WEALTHFOLIO_DB_PATH=/mnt/wealthfolio/wealthfolio.db
      - SYNC_SCHEDULE=0 */6 * * *          # Change cron schedule here (e.g. 0 */3 * * * for every 3h)
      - MIN_SYNC_INTERVAL_HOURS=1          # Minimum interval cooldown between syncs
    volumes:
      # The FOLDER holding wealthfolio.db, read-only — not the .db file itself,
      # which hides the -wal file and serves stale data.
      - /path/to/wealthfolio:/mnt/wealthfolio:ro`}
          </pre>
          <div className="sfin-subtle sfin-docker-note">
            The database mount is what lets the companion count spending that still
            needs a category, and fill in category names and budgets in its reports.
            Point it at the folder that contains <code>wealthfolio.db</code>.
          </div>
        </div>
      </CollapsibleCard>
```

with:

```tsx
        onToggle={() => toggleCard(CARD.docker)}
      >
        {/* The ONE compose service (shared/compose-snippet.ts, project 4): the
            README and docker-compose.example.yml carry the same text, and a
            test fails if they drift. This card fills in the browser's
            timezone; it never fills in a password. */}
        <DockerSnippet />
      </CollapsibleCard>
```

Edit 1 of 1 in `src/components/ui.tsx` — replace:

```tsx
.sfin-docker-pre { margin: 0; }
```

with:

```tsx
.sfin-docker-pre { margin: 0; }
.sfin-docker-copy { margin-top: 8px; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/DockerSnippet.test.tsx src/tabs/SettingsTab.test.tsx src/components/theme-styles.test.ts src/pages/copy-policy.test.tsx`
Expected: PASS — 39 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/DockerSnippet.tsx src/components/DockerSnippet.test.tsx src/tabs/SettingsTab.tsx src/components/ui.tsx
git commit -m "Getting started: the Settings Docker card renders the shared snippet with the browser's timezone and a Copy button

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: A built-in sample report cube

The preview's data (spec B, G2; Q1b): six months ending on the month `now` falls in, eight categories (alphabetical, as published), three accounts (two cash, one card), default budgets on four categories (Shopping runs over), two paychecks a month, merchants per month biggest first, two subscriptions and a bill, one month of card interest, a rising net worth, and the newest month's transactions per category for the drill-down — with no activity id, so a row opens no story. The month in progress has spent about half a month (rent in full). Every number is whole cents; no emoji.

**Files:**
- Create: `shared/sample-cube.ts`, `shared/sample-cube.test.ts`

**Interfaces:**
- Consumes: `ReportCube`, `CubeAccount`, `CubeMerchant`, `DrillTx`, `parseReportCube`, `monthlySpendTotals` (shared/report-cube.ts); `DetectedSubscription` (shared/subscriptions.ts).
- Produces:

```ts
// shared/sample-cube.ts
export const SAMPLE_MONTHS: number;   // 6
export const SAMPLE_CATEGORIES: readonly ['Dining out', 'Entertainment', 'Gas', 'Groceries', 'Health', 'Housing', 'Shopping', 'Utilities'];
export function sampleReportCube(now: Date): ReportCube;
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/sample-cube.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import { monthlySpendTotals, parseReportCube } from './report-cube.js';
import { sampleReportCube, SAMPLE_CATEGORIES, SAMPLE_MONTHS } from './sample-cube.js';

const EMOJI = /\p{Extended_Pictographic}/u;
const NOW = new Date(2026, 9, 14, 12, 0);

describe('sampleReportCube', () => {
  it('passes parseReportCube, every dimension index-aligned, and round-trips unchanged', () => {
    const cube = sampleReportCube(NOW);
    const raw = JSON.stringify(cube);
    expect(parseReportCube(raw)).toEqual(cube);
    const m = cube.months.length;
    const c = cube.categories.length;
    const a = cube.accounts.length;
    expect([m, c, a]).toEqual([SAMPLE_MONTHS, 8, 3]);
    for (const series of [cube.spend, cube.uncategorized, cube.income, cube.budgets, cube.merchants, cube.feesInterest, cube.netWorth, cube.liquid]) {
      expect(series).toHaveLength(m);
    }
    for (const month of cube.spend) {
      expect(month).toHaveLength(c);
      for (const cat of month) expect(cat).toHaveLength(a);
    }
    for (const perAccount of [...cube.uncategorized, ...cube.income]) expect(perAccount).toHaveLength(a);
    for (const perCategory of cube.budgets) expect(perCategory).toHaveLength(c);
  });

  it('ends on the month it is given, six months back, across a year boundary', () => {
    expect(sampleReportCube(NOW).months).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(sampleReportCube(new Date(2027, 0, 1, 0, 30)).months).toEqual(['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01']);
    expect(sampleReportCube(NOW).asOf).toBe(NOW.toISOString());
  });

  it('is a plausible household: 8 categories, 3 accounts, a few budgets, income, merchants, recurring charges', () => {
    const cube = sampleReportCube(NOW);
    expect(cube.categories).toEqual([...SAMPLE_CATEGORIES]);
    expect([...cube.categories].sort()).toEqual(cube.categories);
    expect(cube.accounts.map((acct) => acct.type)).toEqual(['CASH', 'CASH', 'CREDIT_CARD']);
    const budgeted = cube.categories.filter((_, ci) => cube.budgets[0][ci] > 0);
    expect(budgeted).toEqual(['Dining out', 'Groceries', 'Housing', 'Shopping']);
    expect(cube.income.every((month) => month[0] > 0)).toBe(true);
    for (const month of cube.merchants) {
      expect(month.length).toBeGreaterThan(0);
      expect(month.length).toBeLessThanOrEqual(20);
      expect(month.map((x) => x.cents)).toEqual([...month.map((x) => x.cents)].sort((x, y) => y - x));
    }
    expect(cube.subscriptions?.map((s) => s.kind)).toEqual(['subscription', 'subscription', 'bill']);
    expect(cube.pool).toBeNull();
    // The month in progress has spent about half a month.
    const totals = monthlySpendTotals(cube);
    expect(totals[5]).toBeLessThan(totals[4]);
  });

  it('carries the newest month’s transactions per category, none of which open a story', () => {
    const cube = sampleReportCube(NOW);
    expect(Object.keys(cube.drill ?? {}).sort()).toEqual([...SAMPLE_CATEGORIES].sort());
    for (const rows of Object.values(cube.drill ?? {})) {
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.d.startsWith('2026-10-')).toBe(true);
        expect(row.i).toBeUndefined();
      }
    }
  });

  it('counts whole cents everywhere and carries no emoji', () => {
    const cube = sampleReportCube(NOW);
    const numbers = [
      ...cube.spend.flat(2), ...cube.uncategorized.flat(), ...cube.income.flat(), ...cube.budgets.flat(),
      ...cube.merchants.flat().map((x) => x.cents), ...cube.feesInterest,
    ];
    expect(numbers.every((n) => Number.isInteger(n))).toBe(true);
    expect(JSON.stringify(cube)).not.toMatch(EMOJI);
  });

  it('is the same cube for the same moment', () => {
    expect(sampleReportCube(new Date(NOW))).toEqual(sampleReportCube(new Date(NOW)));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/sample-cube.test.ts`
Expected: FAIL — `Failed to resolve import "./sample-cube.js" from "shared/sample-cube.test.ts"`; no tests run.

- [ ] **Step 3: Implement**

**Create `shared/sample-cube.ts`:**

```ts
/**
 * shared/sample-cube.ts
 *
 * A built-in, made-up report cube for the sample-data preview (project 4, G2):
 * what the Budget board looks like before a bank is linked or the companion
 * has synced. The board is a pure function of the cube (shared/report-cube.ts),
 * so a plausible cube is the whole preview — no other part of the app is faked.
 *
 * Six months, eight categories, three accounts, budgets on four categories,
 * two paychecks a month, merchants, two subscriptions and a bill. Its dates are
 * relative to `now`: the newest month is the one `now` falls in (the browser's
 * own month, as the board reads it), and it has spent about half a month.
 * Deterministic: the same `now` gives the same cube. Plain text only — no
 * emoji — and every number is whole cents, as the companion publishes them.
 */
import type { CubeAccount, CubeMerchant, DrillTx, ReportCube } from './report-cube.js';
import type { DetectedSubscription } from './subscriptions.js';

export const SAMPLE_MONTHS = 6;

/** Parent-level, alphabetical, as the companion publishes them. */
export const SAMPLE_CATEGORIES = [
  'Dining out', 'Entertainment', 'Gas', 'Groceries', 'Health', 'Housing', 'Shopping', 'Utilities',
] as const;

const ACCOUNTS: CubeAccount[] = [
  { sfinId: 'sample-checking', name: 'Everyday Checking', type: 'CASH' },
  { sfinId: 'sample-savings', name: 'Rainy Day Savings', type: 'CASH' },
  { sfinId: 'sample-card', name: 'Rewards Card', type: 'CREDIT_CARD' },
];

/** A typical month's spending, cents, per category: [checking, savings, card]. */
const TYPICAL: Record<(typeof SAMPLE_CATEGORIES)[number], [number, number, number]> = {
  'Dining out': [4_000, 0, 14_500],
  Entertainment: [0, 0, 5_200],
  Gas: [0, 0, 11_800],
  Groceries: [9_500, 0, 31_000],
  Health: [3_500, 0, 2_000],
  Housing: [140_000, 0, 0],
  Shopping: [0, 0, 16_500],
  Utilities: [17_800, 0, 0],
};

/** Each month against a typical one, oldest first. The newest is the month in
 *  progress; rent (Housing) is paid in full on the 1st of every month. */
const MONTH_FACTORS = [0.96, 1.04, 0.92, 1.11, 0.98, 0.52];

/** Default monthly budgets, cents. Shopping runs over most months. */
const BUDGETS: Partial<Record<(typeof SAMPLE_CATEGORIES)[number], number>> = {
  'Dining out': 15_000, Groceries: 40_000, Housing: 140_000, Shopping: 15_000,
};

/** A month's merchants: name, typical cents, charges. */
const MERCHANTS: Array<[string, number, number]> = [
  ['RIVERSIDE APARTMENTS', 140_000, 1],
  ['TRADER JOES', 18_400, 4],
  ['COSTCO WHSL', 12_100, 1],
  ['CITY POWER & LIGHT', 9_800, 1],
  ['SHELL OIL', 7_900, 3],
  ['TARGET', 6_200, 2],
  ['CHIPOTLE', 4_300, 3],
  ['CORNER PHARMACY', 3_100, 1],
  ['NETFLIX.COM', 1_549, 1],
  ['SPOTIFY USA', 1_199, 1],
];

/** The newest month's transactions per category: description, share of the
 *  category's spending, account index. */
const DRILL: Record<(typeof SAMPLE_CATEGORIES)[number], Array<[string, number, number]>> = {
  'Dining out': [['CHIPOTLE', 0.4, 2], ['BLUE DOOR CAFE', 0.6, 0]],
  Entertainment: [['NETFLIX.COM', 0.3, 2], ['CINEMA 8', 0.7, 2]],
  Gas: [['SHELL OIL', 1, 2]],
  Groceries: [['TRADER JOES', 0.65, 2], ['COSTCO WHSL', 0.35, 0]],
  Health: [['CORNER PHARMACY', 1, 0]],
  Housing: [['RIVERSIDE APARTMENTS', 1, 0]],
  Shopping: [['TARGET', 1, 2]],
  Utilities: [['CITY POWER & LIGHT', 0.55, 0], ['METRO WATER', 0.45, 0]],
};

const PAY_CENTS = 512_000;
const INTEREST_CENTS = 1_150;
const RENT = 'Housing';

const pad = (n: number) => String(n).padStart(2, '0');
/** `YYYY-MM` of the month `back` months before `now`'s own (local) month. */
function monthBefore(now: Date, back: number): string {
  const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

function recent(month: string, day: number, cents: number[]): Array<{ date: string; cents: number }> {
  const [y, m] = month.split('-').map(Number);
  return cents.map((c, i) => {
    const d = new Date(y, m - 1 - i, day);
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, cents: c };
  });
}

export function sampleReportCube(now: Date): ReportCube {
  const months = Array.from({ length: SAMPLE_MONTHS }, (_, i) => monthBefore(now, SAMPLE_MONTHS - 1 - i));
  const last = SAMPLE_MONTHS - 1;
  const factor = (mi: number, category: string) => (category === RENT ? 1 : MONTH_FACTORS[mi]);

  const spend = months.map((_, mi) => SAMPLE_CATEGORIES.map((cat) => TYPICAL[cat].map((cents) => Math.round(cents * factor(mi, cat)))));
  const merchants = months.map((_, mi): CubeMerchant[] => MERCHANTS
    .map(([name, cents, count]) => ({
      name,
      cents: name === 'RIVERSIDE APARTMENTS' ? cents : Math.round(cents * MONTH_FACTORS[mi]),
      count: mi === last ? Math.ceil(count / 2) : count,
    }))
    .sort((a, b) => b.cents - a.cents));

  const newest = months[last];
  const drill: Record<string, DrillTx[]> = {};
  SAMPLE_CATEGORIES.forEach((cat, ci) => {
    const total = spend[last][ci].reduce((s, v) => s + v, 0);
    drill[cat] = DRILL[cat].map(([n, share, ai], i) => ({
      d: `${newest}-${pad(Math.min(28, 1 + i * 3))}`,
      n,
      c: Math.round(total * share),
      a: ACCOUNTS[ai].name,
    })).reverse();
  });

  const previous = months[last - 1];
  const subscriptions: DetectedSubscription[] = [
    {
      name: 'NETFLIX.COM', monthlyCents: 1_549, count: 5, lastDate: `${previous}-06`, lastCents: 1_549, prevCents: 1_549,
      creep: false, kind: 'subscription', recent: recent(previous, 6, [1_549, 1_549, 1_549]),
    },
    {
      name: 'SPOTIFY USA', monthlyCents: 1_099, count: 5, lastDate: `${previous}-12`, lastCents: 1_199, prevCents: 1_099,
      creep: true, kind: 'subscription', recent: recent(previous, 12, [1_199, 1_099, 1_099]),
    },
    {
      name: 'CITY POWER & LIGHT', monthlyCents: 9_800, count: 5, lastDate: `${previous}-20`, lastCents: 10_420, prevCents: 9_650,
      creep: false, kind: 'bill', recent: recent(previous, 20, [10_420, 9_650, 9_800]),
    },
  ];

  return {
    version: 1,
    asOf: now.toISOString(),
    months,
    categories: [...SAMPLE_CATEGORIES],
    accounts: ACCOUNTS.map((a) => ({ ...a })),
    spend,
    uncategorized: months.map((_, mi) => [Math.round(1_600 * MONTH_FACTORS[mi]), 0, Math.round(2_300 * MONTH_FACTORS[mi])]),
    income: months.map((_, mi) => [mi === last ? PAY_CENTS / 2 : PAY_CENTS, INTEREST_CENTS, 0]),
    budgets: months.map(() => SAMPLE_CATEGORIES.map((cat) => BUDGETS[cat] ?? 0)),
    merchants,
    feesInterest: months.map((_, mi) => (mi === 2 ? 1_243 : 0)),
    netWorth: months.map((_, mi) => 1_840_000 + mi * 92_000),
    liquid: months.map((_, mi) => 1_120_000 + mi * 61_000),
    pool: null,
    subscriptions,
    drill,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/sample-cube.test.ts shared/report-cube.test.ts`
Expected: PASS — 15 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/sample-cube.ts shared/sample-cube.test.ts
git commit -m "Getting started: a built-in sample report cube

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The Budget board's sample-data preview — read-only, under a banner

Spec B (G2; Q1c). `BudgetTab` gains a `preview` prop: the banner ("Sample data — not your money", what it is, **Close preview**) where the stale strip sits, in the grid and the full view; no Customize, no "+ Add report", no pool editor, no audit link; no edit handed to the cards — so the headline picker and the Subscriptions card render read-only — and nothing that opens the real ledger (Wealthfolio's activities, a transaction's story). The sample is never stale. `BudgetPreview` is that board over `sampleReportCube(now)` with no-op layout handlers; the empty board offers **Preview with sample data** beside **Set up background sync**, and closing the preview returns to the empty state. The test renders `BudgetTab` directly with a spy for every write it can make.

**Files:**
- Create: `src/tabs/BudgetPreview.test.tsx`
- Modify: `src/tabs/BudgetTab.tsx`, `src/components/ui.tsx` (`.sfin-budget-empty-actions`, `.sfin-preview-banner`)

**Interfaces:**
- Consumes: Task 3 (`sampleReportCube`).
- Produces:

```ts
// src/tabs/BudgetTab.tsx
export const SAMPLE_BANNER: string;   // 'Sample data — not your money'
export const SAMPLE_NOTE: string;
BudgetTabProps['preview']?: { onExit: () => void };
export function BudgetPreview(props: { store: SecretsStore; onExit: () => void; now?: Date }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

**Create `src/tabs/BudgetPreview.test.tsx`:**

```tsx
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BudgetPreview, BudgetTab, SAMPLE_BANNER } from './BudgetTab';
import { emptySubscriptionPrefs } from '../../shared/subscription-prefs';

/**
 * The sample-data preview (project 4, G2): the Budget board over the built-in
 * sample cube, read-only, under a banner. Rendered directly with spies for
 * every write the board can make, so "writes nothing" is checked against the
 * real handlers' absence, not inferred from a missing button.
 *
 * recharts and the host chart kit are stubbed to passthrough elements, as in
 * BudgetTab.test.tsx.
 */
vi.mock('recharts', () => {
  const stub = (name: string) => (p: any) =>
    React.createElement(
      'div',
      { 'data-recharts': name, 'data-points': p?.data ? JSON.stringify(p.data) : undefined },
      p?.children ?? null,
    );
  return {
    Area: stub('Area'), AreaChart: stub('AreaChart'), Bar: stub('Bar'), BarChart: stub('BarChart'),
    CartesianGrid: stub('CartesianGrid'), Cell: stub('Cell'), Line: stub('Line'),
    LineChart: stub('LineChart'), Pie: stub('Pie'), PieChart: stub('PieChart'),
    XAxis: stub('XAxis'), YAxis: stub('YAxis'),
  };
});
vi.mock('@wealthfolio/ui/chart', () => ({
  ChartContainer: (p: any) => React.createElement('div', null, p.children),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
  ChartLegend: () => null,
  ChartLegendContent: () => null,
  ChartStyle: () => null,
}));

const EMOJI = /\p{Extended_Pictographic}/u;
const NOW = new Date(2026, 9, 14, 12, 0);

function emptyTab() {
  const spies = {
    onLayoutChange: vi.fn(),
    onLayoutReset: vi.fn(),
    onCustomReportsChange: vi.fn(),
    onSubscriptionEdit: vi.fn(),
    onOpenActivities: vi.fn(),
    setSemesterPool: vi.fn(async () => {}),
    setBudgetLayout: vi.fn(async () => {}),
    setCustomReports: vi.fn(async () => {}),
  };
  const store = { setSemesterPool: spies.setSemesterPool, setBudgetLayout: spies.setBudgetLayout, setCustomReports: spies.setCustomReports } as any;
  render(
    <BudgetTab
      cube={null}
      customReports={[]}
      layout={null}
      onLayoutChange={spies.onLayoutChange}
      onLayoutReset={spies.onLayoutReset}
      onCustomReportsChange={spies.onCustomReportsChange}
      store={store}
      subscriptionPrefs={{ prefs: emptySubscriptionPrefs(), unreadable: false }}
      onSubscriptionEdit={spies.onSubscriptionEdit}
      onOpenActivities={spies.onOpenActivities}
      onSetUpCompanion={vi.fn()}
    />,
  );
  return spies;
}
const reportIds = () =>
  Array.from(document.querySelectorAll('[data-report-id]')).map((n) => n.getAttribute('data-report-id'));

describe('the sample-data preview', () => {
  // The preview dates its sample from the clock it opens at.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is offered on the empty state, labelled, and leaving it restores the empty state', () => {
    emptyTab();
    expect(reportIds()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Preview with sample data' }));
    expect(screen.getByText(SAMPLE_BANNER)).toBeTruthy();
    expect(SAMPLE_BANNER).toBe('Sample data — not your money');
    // A fresh layout's six reports, over the sample's categories.
    expect(new Set(reportIds())).toEqual(new Set([
      'headline-stats', 'cash-flow', 'category-trends', 'budget-vs-actual', 'merchants', 'subscriptions',
    ]));
    expect(document.querySelector('[data-bva="Groceries"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByText(SAMPLE_BANNER)).toBeNull();
    expect(reportIds()).toEqual([]);
    expect(screen.getByText(/budget reports come from the background companion/i)).toBeTruthy();
  });

  it('writes nothing: no Customize, no Add report, no headline picker, no subscription edits, no pool edit', () => {
    const spies = emptyTab();
    fireEvent.click(screen.getByRole('button', { name: 'Preview with sample data' }));
    expect(screen.queryByRole('button', { name: 'Customize' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Add report' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Add subscription' })).toBeNull();
    // Every chip and every button on the board, pressed once.
    for (const label of ['Month', '3 months', '6 months', '12 months', 'All']) {
      fireEvent.click(screen.getByRole('button', { name: label }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Open Headline numbers' }));
    expect(screen.getByText(SAMPLE_BANNER)).toBeTruthy();
    expect(screen.queryByText('Choose up to five numbers:')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to all reports' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open Subscriptions' }));
    expect(screen.queryByRole('button', { name: '+ Add subscription' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back to all reports' }));
    // A budget row drills into the sample's own transactions, which open no story.
    fireEvent.click(screen.getByRole('button', { name: 'See Groceries transactions' }));
    expect(screen.getByText('TRADER JOES')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open in Wealthfolio' })).toBeNull();
    for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
  });

  it('shows no emoji, and no stale-data warning however old the clock says it is', () => {
    render(<BudgetPreview store={{} as any} now={new Date(2020, 0, 15)} onExit={vi.fn()} />);
    expect(document.body.textContent).not.toMatch(EMOJI);
    expect(screen.queryByText(/hasn.t published since/)).toBeNull();
  });

  it('dates the sample from the moment it is given', () => {
    render(<BudgetPreview store={{} as any} now={new Date(2027, 0, 14)} onExit={vi.fn()} />);
    const months = JSON.parse(document.querySelector('[data-recharts="BarChart"][data-points]')!.getAttribute('data-points')!)
      .map((p: { month: string }) => p.month);
    expect(months.at(-1)).toBe('2027-01');
    expect(months[0]).toBe('2026-08');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tabs/BudgetPreview.test.tsx`
Expected: FAIL — all 4: the two empty-state tests find no "Preview with sample data" button, and the two `BudgetPreview` renders throw "Element type is invalid … got: undefined" (`BudgetPreview` is not exported yet).

- [ ] **Step 3: Implement**

Edit 1 of 14 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
import { sliceCubeMonths, type ReportCube } from '../../shared/report-cube';
```

with:

```tsx
import { sliceCubeMonths, type ReportCube } from '../../shared/report-cube';
import { sampleReportCube } from '../../shared/sample-cube';
```

Edit 2 of 14 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
  audit?: AuditSource;
}

/** Two days: one missed nightly publish is routine, two is worth a strip. */
```

with:

```tsx
  audit?: AuditSource;
  /** The sample-data preview (project 4, G2): the board over the built-in
   *  sample cube, read-only — no Customize, no layout, report, pool or
   *  subscription edits — under a banner. `onExit` leaves it. Set by
   *  `BudgetPreview` below, never by the page. */
  preview?: { onExit: () => void };
}

/** The preview's banner and the line under it. */
export const SAMPLE_BANNER = 'Sample data — not your money';
export const SAMPLE_NOTE =
  'Made-up accounts and spending, to show what these reports look like once the companion syncs. Nothing here is saved.';

/** Two days: one missed nightly publish is routine, two is worth a strip. */
```

Edit 3 of 14 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
  onSetUpCompanion, renderTxStory, audit,
}: BudgetTabProps) {
```

with:

```tsx
  onSetUpCompanion, renderTxStory, audit, preview,
}: BudgetTabProps) {
```

Edit 4 of 14 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
  const [poolSaved, setPoolSaved] = useState(false);

```

with:

```tsx
  const [poolSaved, setPoolSaved] = useState(false);
  /** The empty state's "Preview with sample data", open (G2). */
  const [previewing, setPreviewing] = useState(false);

```

Edit 5 of 14 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
  if (!cube) {
    return (
      <div className="sfin-budget-empty">
        <p>Budget reports come from the background companion; once it syncs, they appear here.</p>
        {onSetUpCompanion && (
          <Button variant="outline" onClick={onSetUpCompanion}>Set up background sync</Button>
        )}
      </div>
    );
  }
```

with:

```tsx
  if (!cube) {
    // Leaving the preview comes back here, to the empty state.
    if (previewing) return <BudgetPreview store={store} onExit={() => setPreviewing(false)} />;
    return (
      <div className="sfin-budget-empty">
        <p>Budget reports come from the background companion; once it syncs, they appear here.</p>
        <div className="sfin-budget-empty-actions">
          {onSetUpCompanion && (
            <Button variant="outline" onClick={onSetUpCompanion}>Set up background sync</Button>
          )}
          <Button variant="ghost" onClick={() => setPreviewing(true)}>Preview with sample data</Button>
        </div>
      </div>
    );
  }
```

Edit 6 of 14 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
  const stale = Date.now() - Date.parse(cube.asOf) > STALE_MS;
```

with:

```tsx
  // The sample is never stale: it is dated from when the preview opened.
  const stale = !preview && Date.now() - Date.parse(cube.asOf) > STALE_MS;
```

Edit 7 of 14 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
  const subsProps = {
    subscriptionPrefs,
    onSubscriptionEdit,
    subscriptionsCube: cube,
    // The Remind control's "reminders are sent by the companion" hint uses the
    // stale strip's own two-day test.
    companionStale: stale,
    onSetUpCompanion,
    headlinePicks: layout?.headline,
    onHeadlinePicksChange: (ids: string[]) => onLayoutChange({ ...storedLayout, headline: ids }),
    onDrill: (category: string) => setFullId(`drill:${category}`),
    onOpenActivities,
    renderTxStory,
  };
```

with:

```tsx
  // The preview passes no edit, so the headline picker and the subscription
  // controls render read-only, and nothing opens the real ledger.
  const subsProps = {
    subscriptionPrefs,
    onSubscriptionEdit: preview ? undefined : onSubscriptionEdit,
    subscriptionsCube: cube,
    // The Remind control's "reminders are sent by the companion" hint uses the
    // stale strip's own two-day test.
    companionStale: stale,
    onSetUpCompanion,
    headlinePicks: layout?.headline,
    onHeadlinePicksChange: preview ? undefined : (ids: string[]) => onLayoutChange({ ...storedLayout, headline: ids }),
    onDrill: (category: string) => setFullId(`drill:${category}`),
    onOpenActivities: preview ? undefined : onOpenActivities,
    renderTxStory: preview ? undefined : renderTxStory,
  };
```

Edit 8 of 14 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
        Charts below render that last snapshot.
      </div>
    </div>
  );
```

with:

```tsx
        Charts below render that last snapshot.
      </div>
    </div>
  );

  /** The preview's banner (G2), where the stale strip would be. */
  const previewBanner = preview && (
    <div className="sfin-preview-banner" role="note">
      <div className="sfin-banner-body">
        <b>{SAMPLE_BANNER}</b>
        <div className="sfin-banner-note">{SAMPLE_NOTE}</div>
      </div>
      <Button variant="outline" onClick={preview.onExit}>Close preview</Button>
    </div>
  );
```

Edit 9 of 14 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
      <div data-full-report={fullId} style={layout?.palette ? paletteVars(layout.palette) : undefined}>
        {staleStrip}
```

with:

```tsx
      <div data-full-report={fullId} style={layout?.palette ? paletteVars(layout.palette) : undefined}>
        {staleStrip}
        {previewBanner}
```

Edit 10 of 14 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
        {fullId === 'pool-burndown' && cube.pool && (
```

with:

```tsx
        {fullId === 'pool-burndown' && cube.pool && !preview && (
```

Edit 11 of 14 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
    <>
      {staleStrip}

      <div className="sfin-budget-toolbar">
```

with:

```tsx
    <>
      {staleStrip}
      {previewBanner}

      <div className="sfin-budget-toolbar">
```

Edit 12 of 14 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
          <Button variant="ghost" onClick={() => { setCustomizing((c) => !c); setConfirmReset(false); }}>
            {customizing ? 'Done customizing' : 'Customize'}
          </Button>
        </div>
      </div>

      {audit && <HeadlineAuditLink {...audit} />}
```

with:

```tsx
          {!preview && (
            <Button variant="ghost" onClick={() => { setCustomizing((c) => !c); setConfirmReset(false); }}>
              {customizing ? 'Done customizing' : 'Customize'}
            </Button>
          )}
        </div>
      </div>

      {audit && !preview && <HeadlineAuditLink {...audit} />}
```

Edit 13 of 14 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
        {cells.map(({ id }) => card(id))}
        <button
          type="button"
          className="sfin-new-report-card"
          aria-expanded={adding}
          onClick={() => setAdding((a) => !a)}
        >
          + Add report
        </button>
      </div>
```

with:

```tsx
        {cells.map(({ id }) => card(id))}
        {!preview && (
          <button
            type="button"
            className="sfin-new-report-card"
            aria-expanded={adding}
            onClick={() => setAdding((a) => !a)}
          >
            + Add report
          </button>
        )}
      </div>
```

Edit 14 of 14 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
        </div>
      )}

    </>
  );
}
```

with:

```tsx
        </div>
      )}

    </>
  );
}

const NO_REPORTS: CustomReport[] = [];
const noop = () => {};

/**
 * The sample-data preview on its own (project 4, G2): the board over
 * `sampleReportCube`, read-only, under its banner. The empty state opens it,
 * and so does setup step 1's "See what it looks like". The sample is dated
 * from the moment it opens (`now` pins it in tests) and kept while it is open.
 * The store is only passed through: in preview the board writes nothing.
 */
export function BudgetPreview({ store, onExit, now }: { store: SecretsStore; onExit: () => void; now?: Date }) {
  const [cube] = useState(() => sampleReportCube(now ?? new Date()));
  return (
    <BudgetTab
      cube={cube}
      customReports={NO_REPORTS}
      layout={null}
      onLayoutChange={noop}
      onCustomReportsChange={noop}
      store={store}
      preview={{ onExit }}
    />
  );
}
```

Edit 1 of 1 in `src/components/ui.tsx` — replace:

```tsx
.sfin-budget-empty p { margin: 0; max-width: 46ch; font-size: var(--sfin-sz-md); }
```

with:

```tsx
.sfin-budget-empty p { margin: 0; max-width: 46ch; font-size: var(--sfin-sz-md); }
.sfin-budget-empty-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
/* The sample-data preview's banner (project 4): calm, like .sfin-banner-wait —
   nothing is wrong, and the board under it is made up. */
.sfin-preview-banner {
  display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
  background: color-mix(in srgb, var(--primary) 8%, var(--card, var(--background)));
  border: 1px solid color-mix(in srgb, var(--primary) 30%, transparent);
  border-radius: var(--sfin-rad);
  padding: 12px 14px; font-size: var(--sfin-sz-base); line-height: 1.5; margin-bottom: 12px;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tabs/BudgetPreview.test.tsx src/tabs/BudgetTab.test.tsx src/components/theme-styles.test.ts src/pages/copy-policy.test.tsx shared/tab-names.test.ts`
Expected: PASS — 60 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/tabs/BudgetTab.tsx src/tabs/BudgetPreview.test.tsx src/components/ui.tsx
git commit -m "Getting started: the Budget board's read-only sample-data preview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The preview from setup step 1, and the budget card's pointer to `/budgets`

Two ways the app points at what comes next (spec B and C; G2, G3). Setup step 1 gets **See what it looks like**, opening `BudgetPreview` as a panel under the step card (it writes nothing; **Close preview** closes it). The budget-vs-actual card, when no category in its window has a budget, says "No budgets yet — /budgets in Telegram suggests some from your last 3 months." — as the whole card when there is no spending either, and above the spending rows otherwise. It replaces "No budgets or spending this month.", which can no longer appear (a card with no rows has no budget). `SetupPage.test.tsx` gains the chart stubs `BudgetTab.test.tsx` uses.

**Files:**
- Modify: `src/pages/SetupPage.tsx`, `src/pages/SetupPage.test.tsx`, `src/components/budget/ReportView.tsx` (`BudgetVsActual`, `:193-208`), `src/components/budget/ReportView.test.tsx`, `src/components/ui.tsx` (`.sfin-setup-preview`)

**Interfaces:**
- Consumes: Task 4 (`BudgetPreview`).
- Produces:

```ts
// src/components/budget/ReportView.tsx
export const NO_BUDGETS_YET: string;   // 'No budgets yet — /budgets in Telegram suggests some from your last 3 months.'
```

- [ ] **Step 1: Write the failing tests**

Edit 1 of 2 in `src/pages/SetupPage.test.tsx` — replace:

```tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SetupPage } from './SetupPage';
import { fetchAccounts } from '../utils/simplefin';

```

with:

```tsx
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SetupPage } from './SetupPage';
import { fetchAccounts } from '../utils/simplefin';

// Step 1's sample-data preview renders the Budget board: recharts and the host
// chart kit are stubbed to passthrough elements, as in BudgetTab.test.tsx.
vi.mock('recharts', () => {
  const stub = (name: string) => (p: any) => React.createElement('div', { 'data-recharts': name }, p?.children ?? null);
  return {
    Area: stub('Area'), AreaChart: stub('AreaChart'), Bar: stub('Bar'), BarChart: stub('BarChart'),
    CartesianGrid: stub('CartesianGrid'), Cell: stub('Cell'), Line: stub('Line'),
    LineChart: stub('LineChart'), Pie: stub('Pie'), PieChart: stub('PieChart'),
    XAxis: stub('XAxis'), YAxis: stub('YAxis'),
  };
});
vi.mock('@wealthfolio/ui/chart', () => ({
  ChartContainer: (p: any) => React.createElement('div', null, p.children),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
  ChartLegend: () => null,
  ChartLegendContent: () => null,
  ChartStyle: () => null,
}));

```

Edit 2 of 2 in `src/pages/SetupPage.test.tsx` — replace:

```tsx
    expect(props.store.setSyncScheduleHours).toHaveBeenCalledWith(6);
    expect(screen.queryByText(/step 3/i)).toBeNull();
  });
});
```

with:

```tsx
    expect(props.store.setSyncScheduleHours).toHaveBeenCalledWith(6);
    expect(screen.queryByText(/step 3/i)).toBeNull();
  });

  it('shows the sample-data preview from step 1, writes nothing, and closes it', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 14, 12, 0));
    try {
      const props = makeProps();
      render(<SetupPage {...props} />);
      fireEvent.click(screen.getByRole('button', { name: 'See what it looks like' }));
      expect(screen.getByText('Sample data — not your money')).toBeTruthy();
      expect(document.querySelector('[data-bva="Groceries"]')).toBeTruthy();
      expect(screen.getByText('Step 1 of 2')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
      expect(screen.queryByText('Sample data — not your money')).toBeNull();
      for (const write of [
        props.store.setAccessUrl, props.store.setAuthB64, props.store.setAccountNames,
        props.store.setAccountMapping, props.store.setMappingRules, props.store.setSyncScheduleHours,
      ]) {
        expect(write).not.toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
```

Edit 1 of 2 in `src/components/budget/ReportView.test.tsx` — replace:

```tsx
import { ReportView } from './ReportView';
```

with:

```tsx
import { NO_BUDGETS_YET, ReportView } from './ReportView';
```

Edit 2 of 2 in `src/components/budget/ReportView.test.tsx` — replace:

```tsx
  it('says so when the companion has not published drill rows yet', () => {
    render(<ReportView id="drill:Dining" customReports={[]} cube={fresh()} hero />);
    expect(screen.getByText(/after the next sync/i)).toBeTruthy();
  });
});
```

with:

```tsx
  it('says so when the companion has not published drill rows yet', () => {
    render(<ReportView id="drill:Dining" customReports={[]} cube={fresh()} hero />);
    expect(screen.getByText(/after the next sync/i)).toBeTruthy();
  });
});

describe('budget vs actual with no budgets (project 4)', () => {
  it('points to /budgets when no category has a budget, above the spending rows', () => {
    view('budget-vs-actual', { ...fresh(), budgets: [[0, 0], [0, 0]] });
    expect(NO_BUDGETS_YET).toBe('No budgets yet — /budgets in Telegram suggests some from your last 3 months.');
    expect(screen.getByText(NO_BUDGETS_YET)).toBeTruthy();
    expect(document.querySelector('[data-bva="Groceries"]')).toBeTruthy();
  });

  it('says only that when there is no spending either', () => {
    view('budget-vs-actual', { ...fresh(), budgets: [[0, 0], [0, 0]], spend: [[[0, 0], [0, 0]], [[0, 0], [0, 0]]] });
    expect(screen.getByText(NO_BUDGETS_YET)).toBeTruthy();
    expect(document.querySelector('[data-bva]')).toBeNull();
  });

  it('stays quiet once any category has a budget', () => {
    view('budget-vs-actual');
    expect(screen.queryByText(NO_BUDGETS_YET)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/pages/SetupPage.test.tsx src/components/budget/ReportView.test.tsx`
Expected: FAIL — 4 tests: `shows the sample-data preview from step 1, writes nothing, and closes it` (no "See what it looks like" button) and the three `budget vs actual with no budgets (project 4)` tests (`NO_BUDGETS_YET` is undefined).

- [ ] **Step 3: Implement**

Edit 1 of 3 in `src/pages/SetupPage.tsx` — replace:

```tsx
import type { SecretsStore } from '../utils/secrets';
import { accountCreatedChange } from '../../shared/change-entries';
```

with:

```tsx
import type { SecretsStore } from '../utils/secrets';
import { accountCreatedChange } from '../../shared/change-entries';
import { BudgetPreview } from '../tabs/BudgetTab';
```

Edit 2 of 3 in `src/pages/SetupPage.tsx` — replace:

```tsx
  const [mapping, setMapping] = useState<AccountMapping>({});

```

with:

```tsx
  const [mapping, setMapping] = useState<AccountMapping>({});
  /** Step 1's "See what it looks like": the sample-data preview (project 4). */
  const [preview, setPreview] = useState(false);

```

Edit 3 of 3 in `src/pages/SetupPage.tsx` — replace:

```tsx
            <Button onClick={handleConnect} disabled={!token || loading}>
              {loading ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        </Card>
      )}
```

with:

```tsx
            <Button onClick={handleConnect} disabled={!token || loading}>
              {loading ? 'Connecting…' : 'Connect'}
            </Button>
            <Button variant="ghost" aria-expanded={preview} onClick={() => setPreview((p) => !p)}>
              See what it looks like
            </Button>
          </div>
        </Card>
      )}

      {/* The Budget board over made-up data, read-only, under its banner — the
          same preview as the empty Budget board's. It writes nothing. */}
      {step === 1 && preview && (
        <div className="sfin-setup-preview">
          <BudgetPreview store={store} onExit={() => setPreview(false)} />
        </div>
      )}
```

Edit 1 of 1 in `src/components/ui.tsx` — replace:

```tsx
  padding: 12px 14px; font-size: var(--sfin-sz-base); line-height: 1.5; margin-bottom: 12px;
}
```

with:

```tsx
  padding: 12px 14px; font-size: var(--sfin-sz-base); line-height: 1.5; margin-bottom: 12px;
}
.sfin-setup-preview { margin-top: 16px; }
```

Edit 1 of 2 in `src/components/budget/ReportView.tsx` — replace:

```tsx
function BudgetVsActual({ cube, full, density, onDrill }: {
  cube: ReportCube; full: boolean; density: number; onDrill?: (category: string) => void;
}) {
  const rows = budgetVsActualAvgData(cube);
  if (rows.length === 0) return <div className="sfin-subtle">No budgets or spending this month.</div>;
```

with:

```tsx
/** The budget card with no budget in its window (project 4, G3): the add-on
 *  cannot write budgets (the SDK has none), so it points at the bot that can. */
export const NO_BUDGETS_YET = 'No budgets yet — /budgets in Telegram suggests some from your last 3 months.';

function BudgetVsActual({ cube, full, density, onDrill }: {
  cube: ReportCube; full: boolean; density: number; onDrill?: (category: string) => void;
}) {
  const rows = budgetVsActualAvgData(cube);
  const noBudgets = cube.budgets.every((month) => month.every((cents) => cents === 0));
  // No rows at all means no budget either: the pointer is the whole card.
  if (rows.length === 0) return <div className="sfin-subtle">{NO_BUDGETS_YET}</div>;
```

Edit 2 of 2 in `src/components/budget/ReportView.tsx` — replace:

```tsx
    <div data-bva-list data-bva-scale={scale}>
      {cube.months.length > 1 && (
```

with:

```tsx
    <div data-bva-list data-bva-scale={scale}>
      {noBudgets && <div className="sfin-subtle" style={{ marginBottom: 6 }}>{NO_BUDGETS_YET}</div>}
      {cube.months.length > 1 && (
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/pages/SetupPage.test.tsx src/components/budget/ReportView.test.tsx src/pages/copy-policy.test.tsx src/components/theme-styles.test.ts shared/tab-names.test.ts`
Expected: PASS — 75 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/pages/SetupPage.tsx src/pages/SetupPage.test.tsx src/components/budget/ReportView.tsx src/components/budget/ReportView.test.tsx src/components/ui.tsx
git commit -m "Getting started: setup step 1's 'See what it looks like', and the budget card's pointer to /budgets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Suggested budgets, decided purely — the window, the average, the rounding, every skip rule

Spec C's "Computing suggestions" (G3, G4; Q1e). From the window's spend matrix, the category catalog, Wealthfolio's settings and its budget targets: "this month" in Wealthfolio's timezone and the 3 full months before it; each category's three months summed across accounts (refunds net out) and divided by 3; rounded UP to the nearest $5; skipped, first reason wins — Opening balances (by name, so 3.8 too), a name the catalog cannot place on exactly one top-level category, excluded (descendants included), under $10, past the 24 biggest, and an existing `'default'` or this-month budget. `candidates` (everything but the last rule, biggest first, ties by name) is what `/budgets`' bits index; `suggestions` are the candidates with no budget. `planBudgetApply` is the re-read before write. Names stay raw.

**Files:**
- Create: `shared/budget-suggest.ts`, `shared/budget-suggest.test.ts`

**Interfaces:**
- Consumes: `excludedWithDescendants` (shared/audit-headline.ts); `OPENING_BALANCES_CATEGORY` (shared/sync-core.ts).
- Produces:

```ts
// shared/budget-suggest.ts
export const BUDGET_TAXONOMY = 'spending_categories';
export const DEFAULT_PERIOD_KEY = 'default';
export const BUDGET_WINDOW_MONTHS = 3;
export const BUDGET_MIN_AVERAGE_CENTS = 1000;
export const BUDGET_ROUND_CENTS = 500;
export const BUDGET_MAX_CANDIDATES = 24;
export interface BudgetTarget { id: string; periodKey: string; targetType: string; taxonomyId: string | null; categoryId: string | null; amountCents: number }
export interface SpendMatrixRow { month: string; category: string; accountId: string; amount: number }   // signed dollars
export interface BudgetCategory { id: string; name: string; parentId: string | null }
export interface BudgetSuggestFacts {
  now: Date; timezone: string | null; spend: SpendMatrixRow[]; categories: BudgetCategory[];
  excludedCategoryIds: string[]; categoryParents: Record<string, string | null>; targets: BudgetTarget[];
}
export interface BudgetSuggestion { categoryId: string; name: string; averageCents: number; cents: number }
export type BudgetSkipReason = 'opening-balances' | 'unknown-category' | 'excluded' | 'under-minimum' | 'over-limit' | 'has-budget';
export interface BudgetSuggestions {
  month: string; window: string[]; candidates: BudgetSuggestion[]; suggestions: BudgetSuggestion[];
  skipped: Array<{ name: string; reason: BudgetSkipReason }>;
}
export function zonedMonth(now: Date, timeZone: string | null): string;
export function budgetWindow(now: Date, timeZone: string | null): { month: string; window: string[]; start: string; endExclusive: string };
export function roundUpToFiveDollars(cents: number): number;
export function hasBudget(targets: readonly BudgetTarget[], categoryId: string, month: string): boolean;
export function suggestBudgets(f: BudgetSuggestFacts): BudgetSuggestions;
export function planBudgetApply(chosen: readonly BudgetSuggestion[], targetsNow: readonly BudgetTarget[], month: string): { write: BudgetSuggestion[]; alreadySet: BudgetSuggestion[] };
export function budgetDollars(cents: number): string;            // '$420', '$1,250'
export function windowLabel(window: readonly string[]): string;  // 'Jul–Sep'
export function suggestionWhy(window: readonly string[]): string;
export function suggestionLine(list: readonly BudgetSuggestion[]): string;   // 'Groceries $420 · Dining out $180'
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/budget-suggest.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import {
  budgetDollars, budgetWindow, hasBudget, planBudgetApply, roundUpToFiveDollars, suggestBudgets, suggestionLine,
  suggestionWhy, windowLabel, zonedMonth, BUDGET_MAX_CANDIDATES,
  type BudgetCategory, type BudgetSuggestFacts, type BudgetSuggestion, type BudgetTarget, type SpendMatrixRow,
} from './budget-suggest.js';

const NOW = new Date('2026-10-14T12:00:00Z');
const NY = 'America/New_York';

const cat = (id: string, name: string, parentId: string | null = null): BudgetCategory => ({ id, name, parentId });
const spent = (month: string, category: string, amount: number, accountId = 'wf-card'): SpendMatrixRow => ({ month, category, accountId, amount });
const target = (over: Partial<BudgetTarget>): BudgetTarget => ({
  id: 't', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amountCents: 40000, ...over,
});
const CATEGORIES = [
  cat('cat-gro', 'Groceries'), cat('cat-din', 'Dining out'), cat('cat-gas', 'Gas'), cat('cat-fun', 'Entertainment'),
  cat('cat-open', 'Opening balances'), cat('cat-tax', 'Taxes'), cat('cat-sub', 'Takeout', 'cat-din'),
];

function facts(over: Partial<BudgetSuggestFacts> = {}): BudgetSuggestFacts {
  return {
    now: NOW,
    timezone: NY,
    categories: CATEGORIES,
    excludedCategoryIds: [],
    categoryParents: Object.fromEntries(CATEGORIES.map((c) => [c.id, c.parentId])),
    targets: [],
    spend: [
      // Groceries: two accounts, a refund, $1,260.75 over three months.
      spent('2026-07', 'Groceries', 300, 'wf-chk'), spent('2026-07', 'Groceries', 120),
      spent('2026-08', 'Groceries', 410.5), spent('2026-09', 'Groceries', 450.25), spent('2026-09', 'Groceries', -20),
      // Outside the window: the month in progress and June.
      spent('2026-10', 'Groceries', 999), spent('2026-06', 'Groceries', 999),
      // Gas only in September: $150 / 3.
      spent('2026-09', 'Gas', 150),
      // Dining out: exactly $180 a month.
      spent('2026-07', 'Dining out', 180), spent('2026-08', 'Dining out', 180), spent('2026-09', 'Dining out', 180),
    ],
    ...over,
  };
}
const names = (list: BudgetSuggestion[]) => list.map((s) => `${s.name} ${budgetDollars(s.cents)}`);

describe('the window: the last 3 FULL months in Wealthfolio’s timezone', () => {
  it('is the three months before this one', () => {
    expect(budgetWindow(NOW, NY)).toEqual({
      month: '2026-10', window: ['2026-07', '2026-08', '2026-09'], start: '2026-07-01', endExclusive: '2026-10-01',
    });
  });

  it('crosses a year boundary', () => {
    expect(budgetWindow(new Date('2027-01-14T12:00:00Z'), NY)).toEqual({
      month: '2027-01', window: ['2026-10', '2026-11', '2026-12'], start: '2026-10-01', endExclusive: '2027-01-01',
    });
    expect(budgetWindow(new Date('2027-02-14T12:00:00Z'), NY).window).toEqual(['2026-11', '2026-12', '2027-01']);
  });

  it('places "this month" in Wealthfolio’s timezone, not UTC', () => {
    const newYearUtc = new Date('2027-01-01T03:00:00Z');
    expect(zonedMonth(newYearUtc, NY)).toBe('2026-12');
    expect(budgetWindow(newYearUtc, NY).window).toEqual(['2026-09', '2026-10', '2026-11']);
    expect(zonedMonth(newYearUtc, 'Europe/Berlin')).toBe('2027-01');
    expect(budgetWindow(newYearUtc, 'Europe/Berlin').window).toEqual(['2026-10', '2026-11', '2026-12']);
  });

  it('falls back to the companion’s own month for no zone or one the runtime does not know', () => {
    expect(zonedMonth(NOW, null)).toBe('2026-10');
    expect(zonedMonth(NOW, 'Mars/Olympus_Mons')).toBe('2026-10');
  });
});

describe('suggestBudgets', () => {
  it('averages each category over the 3 full months, every account summed and refunds netted, rounded up to $5', () => {
    const s = suggestBudgets(facts());
    expect(s.month).toBe('2026-10');
    expect(s.window).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(s.suggestions).toEqual([
      // $1,260.75 / 3 = $420.25 → $425.
      { categoryId: 'cat-gro', name: 'Groceries', averageCents: 42025, cents: 42500 },
      // Exactly $180 stays $180.
      { categoryId: 'cat-din', name: 'Dining out', averageCents: 18000, cents: 18000 },
      // A month with nothing counts as $0: $150 / 3 = $50.
      { categoryId: 'cat-gas', name: 'Gas', averageCents: 5000, cents: 5000 },
    ]);
    expect(s.candidates).toEqual(s.suggestions);
    expect(s.skipped).toEqual([]);
  });

  it('rounds up to the nearest $5 and never down', () => {
    expect(roundUpToFiveDollars(42000)).toBe(42000);
    expect(roundUpToFiveDollars(42001)).toBe(42500);
    expect(roundUpToFiveDollars(1)).toBe(500);
    expect(roundUpToFiveDollars(1000)).toBe(1000);
    const exact = suggestBudgets(facts({ spend: [spent('2026-07', 'Gas', 100), spent('2026-08', 'Gas', 100), spent('2026-09', 'Gas', 100.01)] }));
    expect(exact.suggestions).toEqual([{ categoryId: 'cat-gas', name: 'Gas', averageCents: 10000, cents: 10500 }]);
  });

  it('never suggests over an existing budget: a default target, or one for this month', () => {
    const s = suggestBudgets(facts({
      targets: [
        target({ id: 't1', categoryId: 'cat-gro', periodKey: 'default' }),
        target({ id: 't2', categoryId: 'cat-din', periodKey: '2026-10', amountCents: 0 }),
      ],
    }));
    expect(names(s.suggestions)).toEqual(['Gas $50']);
    // Still candidates: what a /budgets button's bits index.
    expect(names(s.candidates)).toEqual(['Groceries $425', 'Dining out $180', 'Gas $50']);
    expect(s.skipped).toEqual([{ name: 'Groceries', reason: 'has-budget' }, { name: 'Dining out', reason: 'has-budget' }]);
  });

  it('ignores targets that are not this category’s default or this month: another month, a group buffer, another taxonomy', () => {
    const s = suggestBudgets(facts({
      targets: [
        target({ id: 't1', categoryId: 'cat-gro', periodKey: '2026-09' }),
        target({ id: 't2', categoryId: null, targetType: 'group_buffer', taxonomyId: null }),
        target({ id: 't3', categoryId: 'cat-din', taxonomyId: 'income_sources' }),
      ],
    }));
    expect(names(s.suggestions)).toEqual(['Groceries $425', 'Dining out $180', 'Gas $50']);
  });

  it('skips excluded categories, Opening balances, categories under $10 a month, and names the catalog cannot place', () => {
    const s = suggestBudgets(facts({
      excludedCategoryIds: ['cat-tax', 'cat-open'],
      categories: [...CATEGORIES, cat('cat-twin-1', 'Twin'), cat('cat-twin-2', 'Twin')],
      spend: [
        ...facts().spend,
        spent('2026-08', 'Taxes', 900),
        spent('2026-08', 'Opening balances', 4646),
        // $29.99 / 3 is under $10; exactly $30 / 3 is $10 and stays.
        spent('2026-07', 'Entertainment', 29.99),
        spent('2026-09', 'Ghost', 300),
        spent('2026-09', 'Twin', 300),
      ],
    }));
    expect(names(s.suggestions)).toEqual(['Groceries $425', 'Dining out $180', 'Gas $50']);
    expect(s.skipped).toEqual([
      { name: 'Entertainment', reason: 'under-minimum' },
      { name: 'Ghost', reason: 'unknown-category' },
      { name: 'Opening balances', reason: 'opening-balances' },
      { name: 'Taxes', reason: 'excluded' },
      { name: 'Twin', reason: 'unknown-category' },
    ]);
    const ten = suggestBudgets(facts({ spend: [spent('2026-07', 'Entertainment', 30)] }));
    expect(ten.suggestions).toEqual([{ categoryId: 'cat-fun', name: 'Entertainment', averageCents: 1000, cents: 1000 }]);
  });

  it('skips Opening balances by name even on Wealthfolio 3.8, which has no exclusions', () => {
    const s = suggestBudgets(facts({ spend: [spent('2026-08', 'Opening balances', 4646)] }));
    expect(s.suggestions).toEqual([]);
    expect(s.skipped).toEqual([{ name: 'Opening balances', reason: 'opening-balances' }]);
  });

  it('skips a category whose refunds outweigh its spending', () => {
    const s = suggestBudgets(facts({ spend: [spent('2026-08', 'Gas', 40), spent('2026-09', 'Gas', -90)] }));
    expect(s.skipped).toEqual([{ name: 'Gas', reason: 'under-minimum' }]);
  });

  it(`offers at most ${BUDGET_MAX_CANDIDATES}, biggest first, ties by name`, () => {
    const many = Array.from({ length: 26 }, (_, i) => cat(`cat-${i}`, `Cat ${String(i).padStart(2, '0')}`));
    const s = suggestBudgets(facts({
      categories: many,
      categoryParents: {},
      spend: many.map((c, i) => spent('2026-08', c.name, i < 2 ? 300 : 600 + i * 15)),
    }));
    expect(s.candidates).toHaveLength(BUDGET_MAX_CANDIDATES);
    expect(s.candidates[0].name).toBe('Cat 25');
    expect(s.skipped).toEqual([{ name: 'Cat 00', reason: 'over-limit' }, { name: 'Cat 01', reason: 'over-limit' }]);
    const tied = suggestBudgets(facts({ spend: [spent('2026-08', 'Gas', 300), spent('2026-08', 'Dining out', 300)] }));
    expect(names(tied.suggestions)).toEqual(['Dining out $100', 'Gas $100']);
  });

  it('keeps category names raw — escaping is the renderer’s job', () => {
    const odd = "Joe's *Diner*_[1]";
    const s = suggestBudgets(facts({ categories: [cat('cat-odd', odd)], spend: [spent('2026-08', odd, 60)] }));
    expect(s.suggestions[0].name).toBe(odd);
    expect(suggestionLine(s.suggestions)).toBe(`${odd} $20`);
  });
});

describe('planBudgetApply: re-read before writing', () => {
  const chosen = suggestBudgets(facts()).suggestions;

  it('leaves alone a category that gained a budget since the list was shown', () => {
    const plan = planBudgetApply(chosen, [
      target({ id: 'new-1', categoryId: 'cat-din', periodKey: 'default' }),
      target({ id: 'new-2', categoryId: 'cat-gas', periodKey: '2026-10' }),
      target({ id: 'old', categoryId: 'cat-gro', periodKey: '2026-08' }),
    ], '2026-10');
    expect(names(plan.write)).toEqual(['Groceries $425']);
    expect(names(plan.alreadySet)).toEqual(['Dining out $180', 'Gas $50']);
  });

  it('writes everything when nothing changed', () => {
    expect(planBudgetApply(chosen, [], '2026-10')).toEqual({ write: chosen, alreadySet: [] });
  });

  it('reads a budget as this category’s default or this month’s target only', () => {
    expect(hasBudget([target({ periodKey: 'default' })], 'cat-gro', '2026-10')).toBe(true);
    expect(hasBudget([target({ periodKey: '2026-10' })], 'cat-gro', '2026-10')).toBe(true);
    expect(hasBudget([target({ periodKey: '2026-11' })], 'cat-gro', '2026-10')).toBe(false);
    expect(hasBudget([target({ categoryId: 'cat-din' })], 'cat-gro', '2026-10')).toBe(false);
  });
});

describe('the words', () => {
  it('writes whole dollars, the window and why', () => {
    expect(budgetDollars(42000)).toBe('$420');
    expect(budgetDollars(125000)).toBe('$1,250');
    expect(windowLabel(['2026-07', '2026-08', '2026-09'])).toBe('Jul–Sep');
    expect(windowLabel(['2026-11', '2026-12', '2027-01'])).toBe('Nov–Jan');
    expect(suggestionWhy(['2026-07', '2026-08', '2026-09'])).toBe('Your average for Jul–Sep, rounded up to the nearest $5');
    expect(suggestionLine(suggestBudgets(facts()).suggestions)).toBe('Groceries $425 · Dining out $180 · Gas $50');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/budget-suggest.test.ts`
Expected: FAIL — `Failed to resolve import "./budget-suggest.js" from "shared/budget-suggest.test.ts"`; no tests run.

- [ ] **Step 3: Implement**

**Create `shared/budget-suggest.ts`:**

```ts
/**
 * shared/budget-suggest.ts
 *
 * Suggested budgets (project 4, G3–G5), decided purely: from the spend matrix,
 * the category catalog, Wealthfolio's settings and its budget targets, which
 * categories to offer a default monthly budget for, and how much. The
 * companion gathers the facts (companion/src/budget-suggest-host.ts) and
 * `/budgets` offers them (companion/src/budgets-menu.ts); nothing here reads
 * or writes.
 *
 * The rules (spec C):
 *  - The window is the last 3 FULL calendar months before "this month", and
 *    "this month" is placed in Wealthfolio's timezone (`timezone` in its
 *    settings), so a New Year's Eve evening in New York is still December.
 *    Rows are bucketed by their stored date, as every report reads them.
 *  - Each spending category's three months are summed across every account,
 *    refunds netting out, and divided by 3 — a month with nothing counts as
 *    $0 — then rounded UP to the nearest $5.
 *  - Skipped, in this order (the first that applies is the reason):
 *    "Opening balances" (by name — it is excluded on 3.9+, and 3.8 has no
 *    exclusions); a name the catalog cannot place on exactly one top-level
 *    category (the matrix is keyed by the rolled-up NAME; budgets by id);
 *    excluded categories (`spending.excluded_category_ids`, descendants
 *    included, as Wealthfolio reads it); an average under $10; past the 24
 *    biggest (a Telegram keyboard's worth); and last, a category that already
 *    has a budget — a `'default'` target or one for this month. An existing
 *    target is never overwritten: Wealthfolio's POST is an upsert.
 *  - `candidates` is everything but the last rule, biggest first (ties by
 *    name): what a `/budgets` button's bits index. `suggestions` is the
 *    candidates with no budget yet — what is offered.
 *
 * Category names are RAW here: Telegram escapes them when it renders.
 */
import { excludedWithDescendants } from './audit-headline.js';
import { OPENING_BALANCES_CATEGORY } from './sync-core.js';

export const BUDGET_TAXONOMY = 'spending_categories';
export const DEFAULT_PERIOD_KEY = 'default';
export const BUDGET_WINDOW_MONTHS = 3;
/** Categories averaging under $10 a month are not worth a budget. */
export const BUDGET_MIN_AVERAGE_CENTS = 1000;
export const BUDGET_ROUND_CENTS = 500;
/** One toggle per candidate fits a Telegram keyboard and a 24-bit mask. */
export const BUDGET_MAX_CANDIDATES = 24;

/** A Wealthfolio budget target (`BudgetSnapshot.state.targets[]`), amount in cents. */
export interface BudgetTarget {
  id: string;
  /** `'default'` or `'YYYY-MM'`. */
  periodKey: string;
  /** `'category'` or `'group_buffer'`. */
  targetType: string;
  taxonomyId: string | null;
  categoryId: string | null;
  amountCents: number;
}

/** One `getNativeSpendMatrix` row: signed dollars per (month, rolled-up category, account). */
export interface SpendMatrixRow { month: string; category: string; accountId: string; amount: number }

/** One spending category (`getNativeSpendingCategories`). */
export interface BudgetCategory { id: string; name: string; parentId: string | null }

export interface BudgetSuggestFacts {
  now: Date;
  /** Wealthfolio's timezone; null: the companion's own. */
  timezone: string | null;
  /** The window's spend matrix (`budgetWindow`'s start and end). */
  spend: SpendMatrixRow[];
  categories: BudgetCategory[];
  /** `spending.excluded_category_ids` ([] on 3.8). */
  excludedCategoryIds: string[];
  /** Each spending category's parent, so an excluded one's descendants count too. */
  categoryParents: Record<string, string | null>;
  /** Every budget target now. */
  targets: BudgetTarget[];
}

export interface BudgetSuggestion {
  categoryId: string;
  name: string;
  /** The window's monthly average, cents. */
  averageCents: number;
  /** What is offered: the average rounded up to the nearest $5. */
  cents: number;
}

export type BudgetSkipReason = 'opening-balances' | 'unknown-category' | 'excluded' | 'under-minimum' | 'over-limit' | 'has-budget';

export interface BudgetSuggestions {
  /** This month, in Wealthfolio's timezone. */
  month: string;
  window: string[];
  candidates: BudgetSuggestion[];
  suggestions: BudgetSuggestion[];
  /** Spending-alone skips by name, then over-limit and has-budget biggest first. */
  skipped: Array<{ name: string; reason: BudgetSkipReason }>;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM` of `now` in `timeZone`; null or a zone the runtime does not know:
 *  the process's own (the same fallback as `zonedMonthBounds`). */
export function zonedMonth(now: Date, timeZone: string | null): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(now);
      const year = parts.find((p) => p.type === 'year')?.value;
      const month = parts.find((p) => p.type === 'month')?.value;
      if (year && month) return `${year}-${month}`;
    } catch {
      /* an unknown zone: the process's own, below */
    }
  }
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

/** The 3 full months before this one, and the spend matrix's date bounds for them. */
export function budgetWindow(now: Date, timeZone: string | null): { month: string; window: string[]; start: string; endExclusive: string } {
  const month = zonedMonth(now, timeZone);
  const window = Array.from({ length: BUDGET_WINDOW_MONTHS }, (_, i) => addMonths(month, i - BUDGET_WINDOW_MONTHS));
  return { month, window, start: `${window[0]}-01`, endExclusive: `${month}-01` };
}

export function roundUpToFiveDollars(cents: number): number {
  return Math.ceil(cents / BUDGET_ROUND_CENTS) * BUDGET_ROUND_CENTS;
}

/** Whether the category has a budget this month: its `'default'` target or this month's. */
export function hasBudget(targets: readonly BudgetTarget[], categoryId: string, month: string): boolean {
  return targets.some((t) => t.targetType === 'category' && t.taxonomyId === BUDGET_TAXONOMY && t.categoryId === categoryId
    && (t.periodKey === DEFAULT_PERIOD_KEY || t.periodKey === month));
}

const byNameAsc = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const biggestFirst = (a: BudgetSuggestion, b: BudgetSuggestion) => b.cents - a.cents || byNameAsc(a, b);

export function suggestBudgets(f: BudgetSuggestFacts): BudgetSuggestions {
  const { month, window } = budgetWindow(f.now, f.timezone);
  const inWindow = new Set(window);
  const totals = new Map<string, number>();
  for (const row of f.spend) {
    if (!inWindow.has(row.month)) continue;
    totals.set(row.category, (totals.get(row.category) ?? 0) + Math.round(row.amount * 100));
  }
  const topLevel = new Map<string, string[]>();
  for (const c of f.categories) {
    if (c.parentId !== null) continue;
    topLevel.set(c.name, [...(topLevel.get(c.name) ?? []), c.id]);
  }
  const excluded = excludedWithDescendants(f.excludedCategoryIds, f.categoryParents);

  const ruleSkips: Array<{ name: string; reason: BudgetSkipReason }> = [];
  const qualified: BudgetSuggestion[] = [];
  for (const [name, total] of totals) {
    const ids = topLevel.get(name) ?? [];
    let reason: BudgetSkipReason | null = null;
    if (name === OPENING_BALANCES_CATEGORY) reason = 'opening-balances';
    else if (ids.length !== 1) reason = 'unknown-category';
    else if (excluded.has(ids[0])) reason = 'excluded';
    else if (total < BUDGET_WINDOW_MONTHS * BUDGET_MIN_AVERAGE_CENTS) reason = 'under-minimum';
    if (reason) {
      ruleSkips.push({ name, reason });
      continue;
    }
    qualified.push({
      categoryId: ids[0],
      name,
      averageCents: Math.round(total / BUDGET_WINDOW_MONTHS),
      cents: Math.ceil(total / (BUDGET_WINDOW_MONTHS * BUDGET_ROUND_CENTS)) * BUDGET_ROUND_CENTS,
    });
  }
  qualified.sort(biggestFirst);
  const candidates = qualified.slice(0, BUDGET_MAX_CANDIDATES);
  const overLimit = qualified.slice(BUDGET_MAX_CANDIDATES).map((s) => ({ name: s.name, reason: 'over-limit' as const }));
  const suggestions = candidates.filter((s) => !hasBudget(f.targets, s.categoryId, month));
  const budgeted = candidates.filter((s) => hasBudget(f.targets, s.categoryId, month)).map((s) => ({ name: s.name, reason: 'has-budget' as const }));
  return { month, window, candidates, suggestions, skipped: [...ruleSkips.sort(byNameAsc), ...overLimit, ...budgeted] };
}

/**
 * Re-read before write: of the suggestions chosen when the list was shown,
 * which to write now, and which gained a budget since — those are left alone
 * and said so ("Already has a budget — left alone.").
 */
export function planBudgetApply(
  chosen: readonly BudgetSuggestion[],
  targetsNow: readonly BudgetTarget[],
  month: string,
): { write: BudgetSuggestion[]; alreadySet: BudgetSuggestion[] } {
  return {
    write: chosen.filter((s) => !hasBudget(targetsNow, s.categoryId, month)),
    alreadySet: chosen.filter((s) => hasBudget(targetsNow, s.categoryId, month)),
  };
}

// ── Words (raw; Telegram escapes) ────────────────────────────────────────

/** `$420`, `$1,250` — suggestions are whole dollars (multiples of $5). */
export function budgetDollars(cents: number): string {
  const dollars = Math.round(cents / 100);
  return `${dollars < 0 ? '-' : ''}$${String(Math.abs(dollars)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1] ?? month;

/** `Jul–Sep`. */
export function windowLabel(window: readonly string[]): string {
  return `${monthName(window[0])}–${monthName(window[window.length - 1])}`;
}

/** The change log's "why" for a budget set from a suggestion. */
export function suggestionWhy(window: readonly string[]): string {
  return `Your average for ${windowLabel(window)}, rounded up to the nearest $5`;
}

/** `Groceries $420 · Dining out $180`. */
export function suggestionLine(list: readonly BudgetSuggestion[]): string {
  return list.map((s) => `${s.name} ${budgetDollars(s.cents)}`).join(' · ');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/budget-suggest.test.ts`
Expected: PASS — 17 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/budget-suggest.ts shared/budget-suggest.test.ts
git commit -m "Getting started: suggested budgets, decided purely

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The change log's `budget-set` — the entry, its group, Undo and Redo

Spec C's "Applying" and G5 (Q1f). `budgetSetChange` records the target Wealthfolio stored — id, category, amount — with "Set a $425.00 monthly budget for Groceries" and why ("Your average for Jul–Sep, rounded up to the nearest $5"). It files under Categories and reads "No budget → $425.00 a month". `budget-set` joins `COMPANION_ONLY_KINDS` (not a sync decision: no override, reversed directly), so the app says "Undo this from Telegram: /changes", the 2a rule. The planner: Undo re-reads the targets, refuses when the target is gone or its amount (or period) changed, and deletes it; Redo refuses when the category has a default budget again and otherwise sets it again, the new id read back. The runner gains `UndoIo.budgets` and the `delete-budget`/`set-budget` steps; only the companion lends `budgets`, so a host without it refuses.

**Files:**
- Create: `shared/change-budget.test.ts`
- Modify: `shared/change-entries.ts`, `shared/change-entries.test.ts` (the kind count and the summary table), `shared/change-view.ts`, `shared/change-undo.ts`, `shared/change-undo-run.ts`

**Interfaces:**
- Consumes: Task 6 (`BudgetTarget`, `BUDGET_TAXONOMY`, `DEFAULT_PERIOD_KEY`); `changeMoney`, `reversalChange` (shared/change-entries.ts).
- Produces:

```ts
// shared/change-entries.ts
ChangeKind |= 'budget-set';   // CHANGE_KINDS gains it, before 'bookkeeping'
export interface BudgetSetFacts { targetId: string; categoryId: string; categoryName: string; amountCents: number; why?: string }
export function budgetSetChange(f: BudgetSetFacts): ChangeDraft;
//   after: { targetId, categoryId, categoryName, amountCents, periodKey: 'default', taxonomyId: 'spending_categories' }
// shared/change-undo.ts
COMPANION_ONLY_KINDS has 'budget-set';
export function currentBudgetTargetId(entry: ChangeEntry, latest: ChangeEntry | null): string | null;
UndoState['budgetTargets']?: BudgetTarget[];
UndoStep |= { do: 'delete-budget'; targetId: string } | { do: 'set-budget'; categoryId: string; amountCents: number };
UndoPlan['budgetAfter']?: null | 'created';
// shared/change-undo-run.ts
UndoIo['budgets']?: { targets(): Promise<BudgetTarget[]>; set(categoryId: string, amountCents: number): Promise<string>; remove(targetId: string): Promise<void> };
// a reversal's after.targetId: the target the next undo acts on (null after an Undo)
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/change-budget.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import type { BudgetTarget } from './budget-suggest.js';
import { budgetSetChange, CHANGE_KINDS, reversalChange, stampChange, type ChangeDraft, type ChangeEntry } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import { changeBeforeAfter, changeGroupOf, changeSearchText } from './change-view.js';
import {
  currentBudgetTargetId, planChangeUndo, undoAvailability, REDO_FROM_TELEGRAM, UNDO_FROM_TELEGRAM, UNDO_NOT_POSSIBLE,
  UNDO_UNREACHABLE, type UndoDecision, type UndoOp, type UndoPlan,
} from './change-undo.js';
import { runChangeUndo, type UndoIo } from './change-undo-run.js';
import { createFakeHost } from './fake-host.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const WHY = 'Your average for Jul–Sep, rounded up to the nearest $5';
const groceries = (): ChangeEntry => stampChange(budgetSetChange({
  targetId: 'bt-gro', categoryId: 'cat-gro', categoryName: 'Groceries', amountCents: 42500, why: WHY,
}), 'companion', new Date('2026-10-14T09:00:00Z'));
const target = (over: Partial<BudgetTarget> = {}): BudgetTarget => ({
  id: 'bt-gro', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amountCents: 42500, ...over,
});
const reversal = (e: ChangeEntry, op: UndoOp, extra: Record<string, unknown> = {}) => stampChange(reversalChange(e, op, extra), 'companion', NOW);
const ok = (d: UndoDecision): UndoPlan => {
  if (!d.ok) throw new Error(`refused: ${d.reason}`);
  return d.plan;
};
const reason = (d: UndoDecision) => (d.ok ? 'planned' : d.reason);

describe('budget-set: the entry', () => {
  it('says what was set, raw, and carries what Undo needs', () => {
    const odd = "Joe's *Diner*_[1]";
    expect(budgetSetChange({ targetId: 't', categoryId: 'c', categoryName: odd, amountCents: 2000 }).summary)
      .toBe(`Set a $20.00 monthly budget for ${odd}`);
    expect(groceries()).toMatchObject({
      actor: 'you', kind: 'budget-set', undoable: true, why: WHY,
      summary: 'Set a $425.00 monthly budget for Groceries',
      subject: { categoryName: 'Groceries' },
      before: { targetId: null },
      after: { targetId: 'bt-gro', categoryId: 'cat-gro', categoryName: 'Groceries', amountCents: 42500, periodKey: 'default', taxonomyId: 'spending_categories' },
    });
    expect(CHANGE_KINDS).toContain('budget-set');
  });

  it('files under Categories, reads "No budget → $425.00 a month", and is found by its category', () => {
    expect(changeGroupOf('budget-set')).toBe('categories');
    expect(changeBeforeAfter(groceries())).toBe('No budget → $425.00 a month');
    expect(changeSearchText(groceries())).toContain('groceries');
  });

  it('is undone from Telegram, not the app: the add-on has no budget API', () => {
    const app = { host: 'addon' as const, companionVersion: '1.61.0' };
    expect(undoAvailability(groceries(), app)).toEqual({ kind: 'telegram', op: 'undo', text: UNDO_FROM_TELEGRAM });
    expect(undoAvailability({ ...groceries(), undone: { by: 'c', at: NOW.toISOString() } }, app))
      .toEqual({ kind: 'telegram', op: 'redo', text: REDO_FROM_TELEGRAM });
    expect(undoAvailability(groceries(), { host: 'addon', companionVersion: null })).toEqual({ kind: 'none' });
    expect(undoAvailability(groceries(), { host: 'companion', companionVersion: '1.61.0' })).toEqual({ kind: 'ready', op: 'undo' });
  });
});

describe('budget-set: the planner', () => {
  it('Undo deletes the target it created', () => {
    const plan = ok(planChangeUndo(groceries(), 'undo', { budgetTargets: [target(), target({ id: 'bt-din', categoryId: 'cat-din' })] }, { latest: null }));
    expect(plan).toEqual({
      op: 'undo', needsSync: false, budgetAfter: null, done: 'Undone — Groceries has no budget.',
      steps: [{ do: 'delete-budget', targetId: 'bt-gro' }],
    });
  });

  it('refuses when the target changed since: another amount, or no longer the default', () => {
    expect(reason(planChangeUndo(groceries(), 'undo', { budgetTargets: [target({ amountCents: 50000 })] }, { latest: null })))
      .toBe('It has changed since — nothing was undone.');
    expect(reason(planChangeUndo(groceries(), 'undo', { budgetTargets: [target({ periodKey: '2026-10' })] }, { latest: null })))
      .toBe('It has changed since — nothing was undone.');
  });

  it('refuses when the target is gone', () => {
    expect(reason(planChangeUndo(groceries(), 'undo', { budgetTargets: [target({ id: 'bt-other' })] }, { latest: null })))
      .toBe('That budget is already gone — nothing was undone.');
  });

  it('Redo puts it back, unless the category has a default budget again', () => {
    const e = groceries();
    const latest = reversal(e, 'undo', { targetId: null });
    expect(ok(planChangeUndo(e, 'redo', { budgetTargets: [target({ periodKey: '2026-10', id: 'bt-oct' })] }, { latest }))).toEqual({
      op: 'redo', needsSync: false, budgetAfter: 'created', done: 'Redone — Groceries has its $425.00 budget back.',
      steps: [{ do: 'set-budget', categoryId: 'cat-gro', amountCents: 42500 }],
    });
    expect(reason(planChangeUndo(e, 'redo', { budgetTargets: [target({ id: 'bt-new', amountCents: 10000 })] }, { latest })))
      .toBe('Groceries has a budget again — nothing was redone.');
  });

  it('acts on the target the last Redo created', () => {
    const e = groceries();
    const redone = reversal(e, 'redo', { targetId: 'bt-again' });
    expect(currentBudgetTargetId(e, null)).toBe('bt-gro');
    expect(currentBudgetTargetId(e, redone)).toBe('bt-again');
    expect(ok(planChangeUndo(e, 'undo', { budgetTargets: [target({ id: 'bt-again' })] }, { latest: redone })).steps)
      .toEqual([{ do: 'delete-budget', targetId: 'bt-again' }]);
  });

  it("can't be undone without what it recorded", () => {
    const bare = { ...groceries(), after: { targetId: 'bt-gro' } };
    expect(reason(planChangeUndo(bare, 'undo', { budgetTargets: [target()] }, { latest: null }))).toBe(UNDO_NOT_POSSIBLE);
  });
});

describe('budget-set: the runner, on the companion', () => {
  function harness(targets: BudgetTarget[], budgets: Partial<NonNullable<UndoIo['budgets']>> = {}) {
    const store = [...targets];
    const log: ChangeEntry[] = [];
    const io: UndoIo = {
      host: createFakeHost().host,
      secrets: { get: async () => null, set: async () => {} },
      budgets: {
        targets: vi.fn(async () => store.map((t) => ({ ...t }))),
        set: vi.fn(async (categoryId: string, amountCents: number) => {
          store.push(target({ id: 'bt-again', categoryId, amountCents }));
          return 'bt-again';
        }),
        remove: vi.fn(async (id: string) => {
          const i = store.findIndex((t) => t.id === id);
          if (i >= 0) store.splice(i, 1);
        }),
        ...budgets,
      },
      record: vi.fn(async (d: ChangeDraft) => { log.unshift(stampChange(d, 'companion', NOW)); }),
      where: { host: 'companion', companionVersion: null },
    };
    const asItem = (e: ChangeEntry): ChangeLogItem => {
      const latest = log.find((x) => x.reverses?.id === e.id);
      return latest?.reverses?.op === 'undo' ? { ...e, undone: { by: latest.id, at: latest.at } } : { ...e };
    };
    const run = (e: ChangeEntry, op: UndoOp) => runChangeUndo(asItem(e), [...log, e], op, io, 'plain', NOW);
    return { store, log, io, run };
  }

  it('Undo deletes the target and records it; Redo re-creates it; the next Undo deletes the new one', async () => {
    const e = groceries();
    const h = harness([target(), target({ id: 'bt-din', categoryId: 'cat-din' })]);
    expect(await h.run(e, 'undo')).toEqual({ ok: true, message: 'Undone — Groceries has no budget.', needsSync: false });
    expect(h.io.budgets!.remove).toHaveBeenCalledWith('bt-gro');
    expect(h.store.map((t) => t.id)).toEqual(['bt-din']);
    expect(h.log[0]).toMatchObject({ kind: 'budget-set', reverses: { id: e.id, op: 'undo' }, after: { targetId: null } });

    expect(await h.run(e, 'redo')).toMatchObject({ ok: true, message: 'Redone — Groceries has its $425.00 budget back.' });
    expect(h.io.budgets!.set).toHaveBeenCalledWith('cat-gro', 42500);
    expect(h.log[0]).toMatchObject({ reverses: { id: e.id, op: 'redo' }, after: { targetId: 'bt-again' } });

    expect(await h.run(e, 'undo')).toMatchObject({ ok: true });
    expect(h.io.budgets!.remove).toHaveBeenLastCalledWith('bt-again');
    expect(h.store.map((t) => t.id)).toEqual(['bt-din']);
  });

  it('changes nothing when the amount was edited in Wealthfolio since', async () => {
    const h = harness([target({ amountCents: 50000 })]);
    expect(await h.run(groceries(), 'undo')).toEqual({ ok: false, message: 'It has changed since — nothing was undone.' });
    expect(h.io.budgets!.remove).not.toHaveBeenCalled();
    expect(h.log).toEqual([]);
  });

  it("says it couldn't reach Wealthfolio when the budgets can't be read, and changes nothing", async () => {
    const h = harness([target()], { targets: vi.fn(async () => { throw new Error('spending tracking is off'); }) });
    expect(await h.run(groceries(), 'undo')).toEqual({ ok: false, message: UNDO_UNREACHABLE });
    expect(h.io.budgets!.remove).not.toHaveBeenCalled();
  });

  it('refuses on a host with no budget API', async () => {
    const h = harness([target()]);
    delete h.io.budgets;
    expect(await h.run(groceries(), 'undo')).toEqual({ ok: false, message: UNDO_NOT_POSSIBLE });
  });
});
```

Edit 1 of 3 in `shared/change-entries.test.ts` — replace:

```ts
  accountCreatedChange, amazonLabelChange, amazonLabelOf, balanceCorrectionChange, bankUpdateChange, bookkeepingChange,
```

with:

```ts
  accountCreatedChange, amazonLabelChange, amazonLabelOf, balanceCorrectionChange, bankUpdateChange, bookkeepingChange, budgetSetChange,
```

Edit 2 of 3 in `shared/change-entries.test.ts` — replace:

```ts
    expect(new Set(CHANGE_KINDS).size).toBe(16);
```

with:

```ts
    expect(new Set(CHANGE_KINDS).size).toBe(17);
```

Edit 3 of 3 in `shared/change-entries.test.ts` — replace:

```ts
    ['account-created', accountCreatedChange({ sfinId: 'ACT-9c8d', wfId: 'wf-citi', name: 'Citi Card', accountType: 'CREDIT_CARD' }),
      'Created a Wealthfolio account'],
```

with:

```ts
    ['account-created', accountCreatedChange({ sfinId: 'ACT-9c8d', wfId: 'wf-citi', name: 'Citi Card', accountType: 'CREDIT_CARD' }),
      'Created a Wealthfolio account'],
    ['budget-set', budgetSetChange({ targetId: 'bt-1', categoryId: 'cat-gro', categoryName: 'Groceries', amountCents: 42500 }),
      'Set a $425.00 monthly budget for Groceries'],
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/change-budget.test.ts shared/change-entries.test.ts`
Expected: FAIL — `shared/change-entries.test.ts` fails to load (`budgetSetChange is not a function`: its summary table is built when the file is collected), and all 13 tests in `shared/change-budget.test.ts` fail.

- [ ] **Step 3: Implement**

Edit 1 of 3 in `shared/change-entries.ts` — replace:

```ts
 *  - an import: the activity id and the account-scoped tx key;
 *  - a transfer link: both legs' tx keys and their new activity ids;
 *  - an Amazon label: the label text and the note before and after.
 */
```

with:

```ts
 *  - an import: the activity id and the account-scoped tx key;
 *  - a transfer link: both legs' tx keys and their new activity ids;
 *  - an Amazon label: the label text and the note before and after;
 *  - a budget set from `/budgets` (project 4): the target's id, category and
 *    amount.
 */
```

Edit 2 of 3 in `shared/change-entries.ts` — replace:

```ts
  | 'category-rule-created' | 'mapping-rule-created'
  | 'account-created'
  | 'bookkeeping';

export const CHANGE_KINDS: readonly ChangeKind[] = [
  'import', 'bank-update', 'pending-removed',
  'transfer-link', 'transfer-type',
  'duplicate-removed',
  'starting-balance', 'starting-balance-moved', 'balance-correction',
  'amazon-label', 'category-filed', 'opening-balance-filed',
  'category-rule-created', 'mapping-rule-created',
  'account-created',
  'bookkeeping',
];
```

with:

```ts
  | 'category-rule-created' | 'mapping-rule-created'
  | 'account-created'
  | 'budget-set'
  | 'bookkeeping';

export const CHANGE_KINDS: readonly ChangeKind[] = [
  'import', 'bank-update', 'pending-removed',
  'transfer-link', 'transfer-type',
  'duplicate-removed',
  'starting-balance', 'starting-balance-moved', 'balance-correction',
  'amazon-label', 'category-filed', 'opening-balance-filed',
  'category-rule-created', 'mapping-rule-created',
  'account-created',
  'budget-set',
  'bookkeeping',
];
```

Edit 3 of 3 in `shared/change-entries.ts` — replace:

```ts
// ── Bookkeeping ──────────────────────────────────────────────────────────
```

with:

```ts
// ── Budgets (project 4) ──────────────────────────────────────────────────

export interface BudgetSetFacts {
  /** The target Wealthfolio stored (`BudgetTarget.id`): what Undo deletes. */
  targetId: string;
  categoryId: string;
  categoryName: string;
  /** What Wealthfolio stored, cents: what Undo checks is still there. */
  amountCents: number;
  /** Why this amount (`suggestionWhy`). Raw. */
  why?: string;
}

/**
 * A default monthly budget set from Telegram's `/budgets`. Only ever a
 * category that had none, so there is no "before" to put back: Undo deletes
 * the target (refusing if its amount changed since), Redo sets it again.
 */
export function budgetSetChange(f: BudgetSetFacts): ChangeDraft {
  return {
    actor: 'you',
    kind: 'budget-set',
    subject: { categoryName: f.categoryName },
    summary: `Set a ${changeMoney(f.amountCents)} monthly budget for ${f.categoryName}`,
    ...(f.why ? { why: f.why } : {}),
    before: { targetId: null },
    after: {
      targetId: f.targetId, categoryId: f.categoryId, categoryName: f.categoryName, amountCents: f.amountCents,
      periodKey: 'default', taxonomyId: 'spending_categories',
    },
    undoable: true,
  };
}

// ── Bookkeeping ──────────────────────────────────────────────────────────
```

Edit 1 of 2 in `shared/change-view.ts` — replace:

```ts
  'account-created': 'rules',
  bookkeeping: 'background',
};
```

with:

```ts
  'account-created': 'rules',
  // A budget is a category's: found where its filings are.
  'budget-set': 'categories',
  bookkeeping: 'background',
};
```

Edit 2 of 2 in `shared/change-view.ts` — replace:

```ts
    case 'transfer-type': {
      if (!isRecord(after)) return null;
      const from = isRecord(before) ? str(before.activityType) : null;
      const to = str(after.activityType) ?? '?';
      return `${from ?? 'New'} → ${to}${after.inTransit === true ? ' (in transit)' : ''}`;
    }
```

with:

```ts
    case 'transfer-type': {
      if (!isRecord(after)) return null;
      const from = isRecord(before) ? str(before.activityType) : null;
      const to = str(after.activityType) ?? '?';
      return `${from ?? 'New'} → ${to}${after.inTransit === true ? ' (in transit)' : ''}`;
    }
    case 'budget-set': {
      const cents = isRecord(after) ? num(after.amountCents) : null;
      return cents === null ? null : `No budget → ${changeMoney(cents)} a month`;
    }
```

Edit 1 of 7 in `shared/change-undo.ts` — replace:

```ts
import type { ChangeEntry } from './change-entries.js';
```

with:

```ts
import { BUDGET_TAXONOMY, DEFAULT_PERIOD_KEY, type BudgetTarget } from './budget-suggest.js';
import { changeMoney, type ChangeEntry } from './change-entries.js';
```

Edit 2 of 7 in `shared/change-undo.ts` — replace:

```ts
/** Kinds only the companion can reverse: the add-on SDK has no category or rule API. */
export const COMPANION_ONLY_KINDS: ReadonlySet<string> = new Set([
  'category-filed', 'opening-balance-filed', 'category-rule-created',
]);
```

with:

```ts
/** Kinds only the companion can reverse: the add-on SDK has no category, rule
 *  or budget API. */
export const COMPANION_ONLY_KINDS: ReadonlySet<string> = new Set([
  'category-filed', 'opening-balance-filed', 'category-rule-created', 'budget-set',
]);
```

Edit 3 of 7 in `shared/change-undo.ts` — replace:

```ts
/** The category rule the next undo or redo acts on (null: none known by id). */
export function currentRuleId(entry: ChangeEntry, latest: ChangeEntry | null): string | null {
  return latest ? str(rec(latest.after).ruleId) : str(rec(entry.after).ruleId);
}
```

with:

```ts
/** The category rule the next undo or redo acts on (null: none known by id). */
export function currentRuleId(entry: ChangeEntry, latest: ChangeEntry | null): string | null {
  return latest ? str(rec(latest.after).ruleId) : str(rec(entry.after).ruleId);
}

/** The budget target the next undo acts on: the entry's, or the one the last
 *  Redo created (null after an Undo). */
export function currentBudgetTargetId(entry: ChangeEntry, latest: ChangeEntry | null): string | null {
  return latest ? str(rec(latest.after).targetId) : str(rec(entry.after).targetId);
}
```

Edit 4 of 7 in `shared/change-undo.ts` — replace:

```ts
  /** The entry's tx key, or one derived from the row's note when it has none. */
  txKey?: string | null;
```

with:

```ts
  /** The entry's tx key, or one derived from the row's note when it has none. */
  txKey?: string | null;
  /** `budget-set`: every budget target now (`GET /spending/budget`). */
  budgetTargets?: BudgetTarget[];
```

Edit 5 of 7 in `shared/change-undo.ts` — replace:

```ts
  | { do: 'mapping-remove'; rule: MappingRule }
  | { do: 'mapping-add'; rule: MappingRule };
```

with:

```ts
  | { do: 'mapping-remove'; rule: MappingRule }
  | { do: 'mapping-add'; rule: MappingRule }
  | { do: 'delete-budget'; targetId: string }
  /** A category's default monthly budget; the id is read back from Wealthfolio's reply. */
  | { do: 'set-budget'; categoryId: string; amountCents: number };
```

Edit 6 of 7 in `shared/change-undo.ts` — replace:

```ts
  /** The rule after this plan, likewise. */
  ruleAfter?: null | 'created';
}
```

with:

```ts
  /** The rule after this plan, likewise. */
  ruleAfter?: null | 'created';
  /** The budget target after this plan, likewise. */
  budgetAfter?: null | 'created';
}
```

Edit 7 of 7 in `shared/change-undo.ts` — replace:

```ts
    case 'mapping-rule-created': {
      const rule = mappingRuleOf(entry);
```

with:

```ts
    case 'budget-set': {
      const categoryId = str(after.categoryId);
      const amountCents = num(after.amountCents);
      const name = str(after.categoryName) ?? 'That category';
      if (!categoryId || amountCents === null) return refuse(UNDO_NOT_POSSIBLE);
      const targets = state.budgetTargets ?? [];
      if (op === 'redo') {
        // Never over a budget set since: Wealthfolio's POST would overwrite it.
        const again = targets.some((t) => t.targetType === 'category' && t.taxonomyId === BUDGET_TAXONOMY
          && t.categoryId === categoryId && t.periodKey === DEFAULT_PERIOD_KEY);
        if (again) return refuse(`${name} has a budget again — nothing was redone.`);
        return plan({
          op, needsSync: false, budgetAfter: 'created', done: `Redone — ${name} has its ${changeMoney(amountCents)} budget back.`,
          steps: [{ do: 'set-budget', categoryId, amountCents }],
        });
      }
      const id = currentBudgetTargetId(entry, opts.latest);
      const now = id ? targets.find((t) => t.id === id) : undefined;
      if (!now) return refuse('That budget is already gone — nothing was undone.');
      if (now.amountCents !== amountCents || now.periodKey !== DEFAULT_PERIOD_KEY || now.categoryId !== categoryId) {
        return refuse(undoChangedSince(op));
      }
      return plan({
        op, needsSync: false, budgetAfter: null, done: `Undone — ${name} has no budget.`,
        steps: [{ do: 'delete-budget', targetId: now.id }],
      });
    }

    case 'mapping-rule-created': {
      const rule = mappingRuleOf(entry);
```

Edit 1 of 6 in `shared/change-undo-run.ts` — replace:

```ts
import type { ChangeLogItem } from './change-log.js';
import {
```

with:

```ts
import type { BudgetTarget } from './budget-suggest.js';
import type { ChangeLogItem } from './change-log.js';
import {
```

Edit 2 of 6 in `shared/change-undo-run.ts` — replace:

```ts
    filedBy(rule: { categoryId: string; pattern: string }): Promise<string[] | null>;
  };
```

with:

```ts
    filedBy(rule: { categoryId: string; pattern: string }): Promise<string[] | null>;
  };
  /** The companion only: Wealthfolio's budget targets (`/spending/budget`, project 4). */
  budgets?: {
    /** Every target now; rejects when they cannot be read. */
    targets(): Promise<BudgetTarget[]>;
    /** Sets a category's default monthly budget; resolves the target's id. */
    set(categoryId: string, amountCents: number): Promise<string>;
    remove(targetId: string): Promise<void>;
  };
```

Edit 3 of 6 in `shared/change-undo-run.ts` — replace:

```ts
  'mapping-add': 'added the transaction rule',
};
```

with:

```ts
  'mapping-add': 'added the transaction rule', 'delete-budget': 'deleted the budget', 'set-budget': 'set the budget',
};
```

Edit 4 of 6 in `shared/change-undo-run.ts` — replace:

```ts
    case 'mapping-rule-created':
      state.mappingRules = await readMappingRules(io.secrets.get);
      return state;
```

with:

```ts
    case 'mapping-rule-created':
      state.mappingRules = await readMappingRules(io.secrets.get);
      return state;
    case 'budget-set':
      if (!io.budgets) throw new Refusal(UNDO_NOT_POSSIBLE);
      state.budgetTargets = await io.budgets.targets();
      return state;
```

Edit 5 of 6 in `shared/change-undo-run.ts` — replace:

```ts
      case 'mapping-add': {
        const list = await readMappingRules(io.secrets.get);
        if (!list.some((r) => sameRule(r, s.rule))) await io.secrets.set(MAPPING_RULES_SECRET_KEY, JSON.stringify([...list, s.rule]));
        break;
      }
```

with:

```ts
      case 'mapping-add': {
        const list = await readMappingRules(io.secrets.get);
        if (!list.some((r) => sameRule(r, s.rule))) await io.secrets.set(MAPPING_RULES_SECRET_KEY, JSON.stringify([...list, s.rule]));
        break;
      }
      case 'delete-budget':
        await io.budgets!.remove(s.targetId);
        break;
      case 'set-budget':
        created = await io.budgets!.set(s.categoryId, s.amountCents);
        break;
```

Edit 6 of 6 in `shared/change-undo-run.ts` — replace:

```ts
  if (p.ruleAfter !== undefined) extra.ruleId = p.ruleAfter === 'created' ? created : null;
```

with:

```ts
  if (p.ruleAfter !== undefined) extra.ruleId = p.ruleAfter === 'created' ? created : null;
  if (p.budgetAfter !== undefined) extra.targetId = p.budgetAfter === 'created' ? created : null;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/change-budget.test.ts shared/change-entries.test.ts shared/change-view.test.ts shared/change-undo.test.ts shared/change-undo-run.test.ts`
Expected: PASS — 141 tests.

Run: `cd companion && npx vitest run src/changes-menu-undo.test.ts src/change-undo-host.test.ts src/changes-menu.test.ts`
Expected: PASS — 34 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/change-entries.ts shared/change-entries.test.ts shared/change-view.ts shared/change-undo.ts shared/change-undo-run.ts shared/change-budget.test.ts
git commit -m "Getting started: the change log's budget-set kind, with Undo and Redo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The companion reads and writes budget targets, and applies a choice — re-reading before every write

Spec C's "Applying" and "Failures" (G3–G5; Q1d, Q1e). Over REST: `getBudgetTargets` (`GET /spending/budget?periodKey=default`), `setDefaultBudgetTarget` (`POST /spending/budget/targets` with `NewBudgetTarget`, the stored target read back from the snapshot the reply carries) and `deleteBudgetTarget`; `parseBudgetSnapshot` reads amounts as cents and an empty snapshot — Wealthfolio's answer while its Spending tracker is off — as not enabled. `budget-suggest-host.ts` gathers the facts (the settings strictly from the database, the window's spend matrix, the catalog, the targets) and applies a choice: re-read the budget (unreadable or off: nothing is set), leave alone what gained a budget, POST the rest one at a time (a failure costs only its own category), and log each target as it lands. `companionUndoIo` lends the runner the same three calls — reading an empty snapshot as unreadable, never as "gone".

**Files:**
- Create: `companion/src/budget-suggest-host.ts`, `companion/src/budget-suggest-host.test.ts`, `companion/src/wealthfolio-budget.test.ts`
- Modify: `companion/src/wealthfolio.ts`, `companion/src/change-undo-host.ts`, `companion/src/change-undo-host.test.ts`

**Interfaces:**
- Consumes: Task 6 (`budgetWindow`, `suggestBudgets`, `planBudgetApply`, `suggestionWhy`, the types); Task 7 (`budgetSetChange`, `UndoIo['budgets']`); `getNativeAuditSettings` (sqlite-audit.ts); `getNativeSpendMatrix`, `getNativeSpendingCategories` (sqlite-native.ts); `recordCompanionChanges` (change-log-host.ts).
- Produces:

```ts
// companion/src/wealthfolio.ts
export function parseBudgetSnapshot(body: unknown): { enabled: boolean; targets: BudgetTarget[] };
WealthfolioClient.getBudgetTargets(): Promise<{ enabled: boolean; targets: BudgetTarget[] }>;
WealthfolioClient.setDefaultBudgetTarget(categoryId: string, amountCents: number): Promise<BudgetTarget>;
WealthfolioClient.deleteBudgetTarget(id: string): Promise<void>;
// companion/src/budget-suggest-host.ts
export interface BudgetReaders {
  settings(): { timezone: string | null; excludedCategoryIds: string[]; categoryParents: Record<string, string | null>; spendingOn: boolean };
  spend(startInclusive: string, endExclusive: string): SpendMatrixRow[];
  categories(): BudgetCategory[];
  targets(): Promise<{ enabled: boolean; targets: BudgetTarget[] }>;
  set(categoryId: string, amountCents: number): Promise<BudgetTarget>;
  record(drafts: ChangeDraft[], now: Date): Promise<void>;
}
export type BudgetClient = SecretClient & Pick<WealthfolioClient, 'getBudgetTargets' | 'setDefaultBudgetTarget'>;
export function companionBudgetReaders(client: BudgetClient, dbPath: string): BudgetReaders;
export type BudgetReadFailure = 'database' | 'spending-off' | 'budgets';
export type BudgetSuggestRead = { ok: true; result: BudgetSuggestions } | { ok: false; reason: BudgetReadFailure };
export function readBudgetSuggestions(r: BudgetReaders, now: Date): Promise<BudgetSuggestRead>;
export interface BudgetApplyOutcome {
  set: Array<{ suggestion: BudgetSuggestion; target: BudgetTarget }>;
  alreadySet: BudgetSuggestion[];
  failed: Array<{ suggestion: BudgetSuggestion; message: string }>;
}
export type BudgetApplyResult = { ok: true; outcome: BudgetApplyOutcome } | { ok: false };
export function applyBudgetSuggestions(r: BudgetReaders, chosen: readonly BudgetSuggestion[], at: { month: string; window: string[] }, now: Date): Promise<BudgetApplyResult>;
// companion/src/change-undo-host.ts
UndoClient adds 'getBudgetTargets' | 'setDefaultBudgetTarget' | 'deleteBudgetTarget'; companionUndoIo(...).budgets
```

- [ ] **Step 1: Write the failing tests**

**Create `companion/src/wealthfolio-budget.test.ts`:**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseBudgetSnapshot, WealthfolioClient } from './wealthfolio.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
beforeEach(() => mockFetch.mockReset());

/** A `BudgetSnapshot` as Wealthfolio 3.8–3.10 serializes it (camelCase), trimmed to what is read. */
const snapshot = (targets: unknown[], groups: unknown[] = [{ id: 'g-needs', name: 'Needs' }]) => ({
  state: { groups, groupAssignments: [], targets, rolloverSettings: [] },
  computed: { currency: 'USD', periodKey: 'default', groupRows: [], ungroupedRows: [], incomeRows: [], totals: {} },
});
const wire = (over: Record<string, unknown> = {}) => ({
  id: 'bt-gro', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro',
  groupId: null, amount: '425.00', createdAt: '2026-10-14T09:00:00', updatedAt: '2026-10-14T09:00:00', ...over,
});

describe('parseBudgetSnapshot', () => {
  it('reads every target, amounts in cents, and skips one it cannot read', () => {
    expect(parseBudgetSnapshot(snapshot([
      wire(),
      wire({ id: 'bt-oct', periodKey: '2026-10', amount: '15.5', categoryId: 'cat-din' }),
      wire({ id: 'bt-buf', targetType: 'group_buffer', taxonomyId: null, categoryId: null, groupId: 'g-needs', amount: 50 }),
      wire({ id: 7 }),
      wire({ id: 'bt-bad', amount: 'lots' }),
    ]))).toEqual({
      enabled: true,
      targets: [
        { id: 'bt-gro', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amountCents: 42500 },
        { id: 'bt-oct', periodKey: '2026-10', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-din', amountCents: 1550 },
        { id: 'bt-buf', periodKey: 'default', targetType: 'group_buffer', taxonomyId: null, categoryId: null, amountCents: 5000 },
      ],
    });
  });

  it('reads an empty snapshot — what Wealthfolio answers while its Spending tracker is off — as not enabled', () => {
    expect(parseBudgetSnapshot(snapshot([], []))).toEqual({ enabled: false, targets: [] });
  });

  it('rejects a reply that is not a snapshot rather than reading it as "no budgets"', () => {
    for (const body of [null, [], { state: {} }, { state: { targets: 'x' } }]) {
      expect(() => parseBudgetSnapshot(body)).toThrow(/no budget targets/);
    }
  });
});

describe('WealthfolioClient budgets', () => {
  it('reads the default view: GET /spending/budget?periodKey=default', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => snapshot([wire()]) });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    expect((await client.getBudgetTargets()).targets.map((t) => t.id)).toEqual(['bt-gro']);
    expect(mockFetch.mock.calls[0][0]).toBe('http://wealthfolio:8088/api/v1/spending/budget?periodKey=default');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    await expect(client.getBudgetTargets()).rejects.toThrow('getBudgetTargets failed: 500 - boom');
  });

  it("POSTs a category's default target, the amount a decimal string, and reads the stored one back", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => snapshot([wire({ id: 'bt-din', categoryId: 'cat-din', amount: '180.00' }), wire()]) });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    expect(await client.setDefaultBudgetTarget('cat-gro', 42500)).toEqual({
      id: 'bt-gro', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amountCents: 42500,
    });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/spending/budget/targets?periodKey=default');
    expect((opts as RequestInit).method).toBe('POST');
    expect(JSON.parse((opts as RequestInit).body as string)).toEqual({
      periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amount: '425.00',
    });
  });

  it('rejects a POST that fails, or whose reply does not carry the budget', async () => {
    const client = new WealthfolioClient('http://wealthfolio:8088');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'Category target requires taxonomyId and categoryId only' });
    await expect(client.setDefaultBudgetTarget('cat-gro', 42500)).rejects.toThrow('setBudgetTarget failed: 400 - Category target requires taxonomyId and categoryId only');
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => snapshot([], []) });
    await expect(client.setDefaultBudgetTarget('cat-gro', 42500)).rejects.toThrow("Wealthfolio's reply did not include the budget");
  });

  it('DELETEs a target by id', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => snapshot([]) });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    await client.deleteBudgetTarget('bt/gro');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/spending/budget/targets/bt%2Fgro?periodKey=default');
    expect((opts as RequestInit).method).toBe('DELETE');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' });
    await expect(client.deleteBudgetTarget('bt-gro')).rejects.toThrow('deleteBudgetTarget failed: 500 - boom');
  });
});
```

**Create `companion/src/budget-suggest-host.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { suggestBudgets, type BudgetSuggestion, type BudgetTarget } from '../../shared/budget-suggest.js';
import { budgetSetChange, type ChangeDraft } from '../../shared/change-entries.js';
import {
  applyBudgetSuggestions, companionBudgetReaders, readBudgetSuggestions, type BudgetReaders,
} from './budget-suggest-host.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const AT = { month: '2026-10', window: ['2026-07', '2026-08', '2026-09'] };
const target = (over: Partial<BudgetTarget> = {}): BudgetTarget => ({
  id: 'bt-gro', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amountCents: 42500, ...over,
});
const CATEGORIES = [
  { id: 'cat-gro', name: 'Groceries', parentId: null }, { id: 'cat-din', name: 'Dining out', parentId: null }, { id: 'cat-gas', name: 'Gas', parentId: null },
];
const SPEND = [
  { month: '2026-07', category: 'Groceries', accountId: 'a', amount: 420 }, { month: '2026-08', category: 'Groceries', accountId: 'a', amount: 420 },
  { month: '2026-09', category: 'Groceries', accountId: 'a', amount: 420 },
  { month: '2026-08', category: 'Dining out', accountId: 'a', amount: 540 },
  { month: '2026-09', category: 'Gas', accountId: 'a', amount: 285 },
];

function readers(over: Partial<BudgetReaders> = {}) {
  const recorded: ChangeDraft[] = [];
  const r: BudgetReaders = {
    settings: vi.fn(() => ({ timezone: 'America/New_York', excludedCategoryIds: [], categoryParents: {}, spendingOn: true })),
    spend: vi.fn(() => SPEND),
    categories: vi.fn(() => CATEGORIES),
    targets: vi.fn(async () => ({ enabled: true, targets: [] as BudgetTarget[] })),
    set: vi.fn(async (categoryId: string, amountCents: number) => target({ id: `bt-${categoryId}`, categoryId, amountCents })),
    record: vi.fn(async (drafts: ChangeDraft[]) => { recorded.push(...drafts); }),
    ...over,
  };
  return { r, recorded };
}
const chosen = (): BudgetSuggestion[] => suggestBudgets({
  now: NOW, timezone: 'America/New_York', spend: SPEND, categories: CATEGORIES, excludedCategoryIds: [], categoryParents: {}, targets: [],
}).suggestions;

describe('readBudgetSuggestions', () => {
  it("reads the window's spending, the catalog and the budgets, and suggests", async () => {
    const { r } = readers({ targets: vi.fn(async () => ({ enabled: true, targets: [target({ categoryId: 'cat-din' })] })) });
    const read = await readBudgetSuggestions(r, NOW);
    expect(r.spend).toHaveBeenCalledWith('2026-07-01', '2026-10-01');
    if (!read.ok) throw new Error(read.reason);
    expect(read.result.suggestions.map((s) => `${s.name} ${s.cents}`)).toEqual(['Groceries 42000', 'Gas 9500']);
    expect(read.result.candidates.map((s) => s.name)).toEqual(['Groceries', 'Dining out', 'Gas']);
  });

  it('says the database could not be read — never "nothing spent"', async () => {
    const { r } = readers({ settings: vi.fn(() => { throw new Error('Could not read the Wealthfolio database'); }) });
    expect(await readBudgetSuggestions(r, NOW)).toEqual({ ok: false, reason: 'database' });
  });

  it("says the Spending tracker is off, from Wealthfolio's settings or from its empty budget", async () => {
    const off = readers({ settings: vi.fn(() => ({ timezone: null, excludedCategoryIds: [], categoryParents: {}, spendingOn: false })) });
    expect(await readBudgetSuggestions(off.r, NOW)).toEqual({ ok: false, reason: 'spending-off' });
    const empty = readers({ targets: vi.fn(async () => ({ enabled: false, targets: [] })) });
    expect(await readBudgetSuggestions(empty.r, NOW)).toEqual({ ok: false, reason: 'spending-off' });
  });

  it("says so when the budgets can't be read", async () => {
    const { r } = readers({ targets: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    expect(await readBudgetSuggestions(r, NOW)).toEqual({ ok: false, reason: 'budgets' });
  });
});

describe('applyBudgetSuggestions', () => {
  it('never overwrites a budget added since the list was shown: re-reads, writes the rest, logs each', async () => {
    const { r, recorded } = readers({
      targets: vi.fn(async () => ({ enabled: true, targets: [target({ id: 'bt-new', categoryId: 'cat-din', amountCents: 20000 })] })),
    });
    const all = chosen();
    expect(all.map((s) => s.name)).toEqual(['Groceries', 'Dining out', 'Gas']);
    const result = await applyBudgetSuggestions(r, all, AT, NOW);
    if (!result.ok) throw new Error('refused');
    expect(r.set).toHaveBeenCalledTimes(2);
    expect(r.set).toHaveBeenCalledWith('cat-gro', 42000);
    expect(r.set).toHaveBeenCalledWith('cat-gas', 9500);
    expect(result.outcome.alreadySet.map((s) => s.name)).toEqual(['Dining out']);
    expect(result.outcome.set.map((x) => x.target.id)).toEqual(['bt-cat-gro', 'bt-cat-gas']);
    expect(result.outcome.failed).toEqual([]);
    expect(recorded).toEqual([
      expect.objectContaining({
        kind: 'budget-set', actor: 'you', summary: 'Set a $420.00 monthly budget for Groceries',
        why: 'Your average for Jul–Sep, rounded up to the nearest $5',
        after: expect.objectContaining({ targetId: 'bt-cat-gro', categoryId: 'cat-gro', amountCents: 42000 }),
      }),
      expect.objectContaining({ summary: 'Set a $95.00 monthly budget for Gas', after: expect.objectContaining({ targetId: 'bt-cat-gas' }) }),
    ]);
  });

  it('logs the amount Wealthfolio stored', async () => {
    const { r, recorded } = readers({ set: vi.fn(async (categoryId: string) => target({ id: 'bt-x', categoryId, amountCents: 41999 })) });
    await applyBudgetSuggestions(r, chosen().slice(0, 1), AT, NOW);
    expect(recorded[0].after).toMatchObject({ targetId: 'bt-x', amountCents: 41999 });
  });

  it('keeps going when one POST fails, and says which', async () => {
    const { r, recorded } = readers({
      set: vi.fn(async (categoryId: string, amountCents: number) => {
        if (categoryId === 'cat-din') throw new Error('setBudgetTarget failed: 500 - database is locked');
        return target({ id: `bt-${categoryId}`, categoryId, amountCents });
      }),
    });
    const result = await applyBudgetSuggestions(r, chosen(), AT, NOW);
    if (!result.ok) throw new Error('refused');
    expect(result.outcome.set.map((x) => x.suggestion.name)).toEqual(['Groceries', 'Gas']);
    expect(result.outcome.failed).toEqual([{ suggestion: expect.objectContaining({ name: 'Dining out' }), message: 'setBudgetTarget failed: 500 - database is locked' }]);
    expect(recorded.map((d) => d.subject.categoryName)).toEqual(['Groceries', 'Gas']);
  });

  it("writes nothing when the budget can't be re-read, or the Spending tracker went off", async () => {
    const down = readers({ targets: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    expect(await applyBudgetSuggestions(down.r, chosen(), AT, NOW)).toEqual({ ok: false });
    expect(down.r.set).not.toHaveBeenCalled();
    const off = readers({ targets: vi.fn(async () => ({ enabled: false, targets: [] })) });
    expect(await applyBudgetSuggestions(off.r, chosen(), AT, NOW)).toEqual({ ok: false });
    expect(off.r.set).not.toHaveBeenCalled();
  });

  it('a log that cannot be written never costs the budget', async () => {
    const { r } = readers({ record: vi.fn(async () => { throw new Error('secret write failed'); }) });
    const result = await applyBudgetSuggestions(r, chosen().slice(0, 1), AT, NOW);
    expect(result).toMatchObject({ ok: true, outcome: { set: [expect.objectContaining({ target: expect.objectContaining({ id: 'bt-cat-gro' }) })] } });
  });
});

describe('companionBudgetReaders', () => {
  it('reads the settings strictly and records into the companion’s change log', async () => {
    const data = new Map<string, string>();
    const client = {
      getAddonSecret: vi.fn(async (_a: string, k: string) => data.get(k) ?? null),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { data.set(k, v); }),
      getBudgetTargets: vi.fn(async () => ({ enabled: true, targets: [] })),
      setDefaultBudgetTarget: vi.fn(async () => target()),
    };
    const r = companionBudgetReaders(client, '/nope/wealthfolio.db');
    expect(() => r.settings()).toThrow();
    expect(r.spend('2026-07-01', '2026-10-01')).toEqual([]);
    await r.set('cat-gro', 42500);
    expect(client.setDefaultBudgetTarget).toHaveBeenCalledWith('cat-gro', 42500);
    await r.record([budgetSetChange({ targetId: 't', categoryId: 'c', categoryName: 'G', amountCents: 500 })], NOW);
    const bucket = JSON.parse(data.get('change_log:companion:2026-10')!);
    expect(bucket.entries).toEqual([expect.objectContaining({ kind: 'budget-set', writer: 'companion' })]);
  });
});
```

Edit 1 of 3 in `companion/src/change-undo-host.test.ts` — replace:

```ts
import { categoryFiledChange, categoryRuleCreatedChange, importChange, stampChange } from '../../shared/change-entries.js';
```

with:

```ts
import { budgetSetChange, categoryFiledChange, categoryRuleCreatedChange, importChange, stampChange } from '../../shared/change-entries.js';
```

Edit 2 of 3 in `companion/src/change-undo-host.test.ts` — replace:

```ts
    createCategorizationRule: vi.fn(async () => 'rule-9'),
    deleteCategorizationRule: vi.fn(async () => {}),
  };
```

with:

```ts
    createCategorizationRule: vi.fn(async () => 'rule-9'),
    deleteCategorizationRule: vi.fn(async () => {}),
    getBudgetTargets: vi.fn(async () => ({
      enabled: true,
      targets: [{ id: 'bt-gro', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amountCents: 42500 }],
    })),
    setDefaultBudgetTarget: vi.fn(async (categoryId: string, amountCents: number) => ({
      id: 'bt-gro', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId, amountCents,
    })),
    deleteBudgetTarget: vi.fn(async () => {}),
  };
```

Edit 3 of 3 in `companion/src/change-undo-host.test.ts` — replace:

```ts
  it('counts a rule’s filings only for a rule entry, and says unknown without the database', () => {
```

with:

```ts
  it('undoes a budget set from /budgets by deleting its target, re-reading Wealthfolio first, and redoes it with the same POST', async () => {
    const c = client();
    const budget = stampChange(budgetSetChange({ targetId: 'bt-gro', categoryId: 'cat-gro', categoryName: 'Groceries', amountCents: 42500 }), 'companion', NOW);
    const io = companionUndoIo(c, '/nope.db', createFakeHost().host);
    expect(await runChangeUndo(budget, [budget], 'undo', io, 'plain', NOW)).toEqual({ ok: true, message: 'Undone — Groceries has no budget.', needsSync: false });
    expect(c.getBudgetTargets).toHaveBeenCalledTimes(1);
    expect(c.deleteBudgetTarget).toHaveBeenCalledWith('bt-gro');
    expect(await io.budgets!.set('cat-gro', 42500)).toBe('bt-gro');
    expect(c.setDefaultBudgetTarget).toHaveBeenCalledWith('cat-gro', 42500);
  });

  it("won't undo a budget while Wealthfolio's Spending tracker is off: an empty budget is not a deleted one", async () => {
    const c = client();
    c.getBudgetTargets.mockResolvedValueOnce({ enabled: false, targets: [] });
    const budget = stampChange(budgetSetChange({ targetId: 'bt-gro', categoryId: 'cat-gro', categoryName: 'Groceries', amountCents: 42500 }), 'companion', NOW);
    const io = companionUndoIo(c, '/nope.db', createFakeHost().host);
    expect(await runChangeUndo(budget, [budget], 'undo', io, 'plain', NOW)).toEqual({ ok: false, message: "Couldn't reach Wealthfolio — nothing undone." });
    expect(c.deleteBudgetTarget).not.toHaveBeenCalled();
  });

  it('counts a rule’s filings only for a rule entry, and says unknown without the database', () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/wealthfolio-budget.test.ts src/budget-suggest-host.test.ts src/change-undo-host.test.ts`
Expected: FAIL — `src/budget-suggest-host.test.ts` cannot load (`Cannot find module './budget-suggest-host.js'`); all 7 tests in `src/wealthfolio-budget.test.ts` fail (`parseBudgetSnapshot is not a function`, and the client has no budget methods); the 2 new tests in `src/change-undo-host.test.ts` fail (the io lends no `budgets`, so the runner refuses).

- [ ] **Step 3: Implement**

**Create `companion/src/budget-suggest-host.ts`:**

```ts
/**
 * companion/src/budget-suggest-host.ts
 *
 * The companion's half of suggested budgets (project 4, G3–G5): it gathers
 * what the pure module (shared/budget-suggest.ts) decides from, and applies a
 * choice — re-reading the budget first, one POST per category, one change-log
 * entry per target written.
 *
 * Where each fact comes from:
 *  - Wealthfolio's timezone, its excluded categories and whether its Spending
 *    tracker is on: the database, strictly (`getNativeAuditSettings`) — a
 *    database that cannot be read is said, never read as "nothing spent";
 *  - the window's spend matrix and the category catalog: the database, through
 *    the readers the report cube uses;
 *  - the budget targets: REST (`GET /spending/budget`), on every show and again
 *    right before any write, because Wealthfolio's POST is an upsert: a target
 *    added in between would otherwise be overwritten.
 */
import {
  budgetWindow, planBudgetApply, suggestBudgets, suggestionWhy,
  type BudgetCategory, type BudgetSuggestion, type BudgetSuggestions, type BudgetTarget, type SpendMatrixRow,
} from '../../shared/budget-suggest.js';
import { budgetSetChange, type ChangeDraft } from '../../shared/change-entries.js';
import { recordCompanionChanges, type SecretClient } from './change-log-host.js';
import { getNativeAuditSettings } from './sqlite-audit.js';
import { getNativeSpendingCategories, getNativeSpendMatrix } from './sqlite-native.js';
import type { WealthfolioClient } from './wealthfolio.js';

/** Everything suggesting and applying reads or writes, so a test can fake each. */
export interface BudgetReaders {
  /** Throws when the database cannot be read. */
  settings(): { timezone: string | null; excludedCategoryIds: string[]; categoryParents: Record<string, string | null>; spendingOn: boolean };
  spend(startInclusive: string, endExclusive: string): SpendMatrixRow[];
  categories(): BudgetCategory[];
  /** Rejects when Wealthfolio cannot be read. `enabled: false`: its Spending tracker is off. */
  targets(): Promise<{ enabled: boolean; targets: BudgetTarget[] }>;
  /** Sets a category's default monthly budget; resolves the stored target. */
  set(categoryId: string, amountCents: number): Promise<BudgetTarget>;
  /** Appends to the change log. */
  record(drafts: ChangeDraft[], now: Date): Promise<void>;
}

export type BudgetClient = SecretClient & Pick<WealthfolioClient, 'getBudgetTargets' | 'setDefaultBudgetTarget'>;

export function companionBudgetReaders(client: BudgetClient, dbPath: string): BudgetReaders {
  return {
    settings: () => getNativeAuditSettings(dbPath),
    spend: (start, endExclusive) => getNativeSpendMatrix(dbPath, start, endExclusive),
    categories: () => getNativeSpendingCategories(dbPath),
    targets: () => client.getBudgetTargets(),
    set: (categoryId, amountCents) => client.setDefaultBudgetTarget(categoryId, amountCents),
    record: (drafts, now) => recordCompanionChanges(client, drafts, undefined, now),
  };
}

/** Why there is nothing to show: the database, a Spending tracker that is off,
 *  or the budgets themselves could not be read. */
export type BudgetReadFailure = 'database' | 'spending-off' | 'budgets';

export type BudgetSuggestRead = { ok: true; result: BudgetSuggestions } | { ok: false; reason: BudgetReadFailure };

export async function readBudgetSuggestions(r: BudgetReaders, now: Date): Promise<BudgetSuggestRead> {
  let settings: ReturnType<BudgetReaders['settings']>;
  let spend: SpendMatrixRow[];
  let categories: BudgetCategory[];
  try {
    settings = r.settings();
    if (!settings.spendingOn) return { ok: false, reason: 'spending-off' };
    const { start, endExclusive } = budgetWindow(now, settings.timezone);
    spend = r.spend(start, endExclusive);
    categories = r.categories();
  } catch {
    return { ok: false, reason: 'database' };
  }
  let targets: BudgetTarget[];
  try {
    const read = await r.targets();
    if (!read.enabled) return { ok: false, reason: 'spending-off' };
    targets = read.targets;
  } catch {
    return { ok: false, reason: 'budgets' };
  }
  return {
    ok: true,
    result: suggestBudgets({
      now, timezone: settings.timezone, spend, categories,
      excludedCategoryIds: settings.excludedCategoryIds, categoryParents: settings.categoryParents, targets,
    }),
  };
}

export interface BudgetApplyOutcome {
  set: Array<{ suggestion: BudgetSuggestion; target: BudgetTarget }>;
  /** Gained a budget since the list was shown: left alone. */
  alreadySet: BudgetSuggestion[];
  /** Its POST failed; the rest still applied. */
  failed: Array<{ suggestion: BudgetSuggestion; message: string }>;
}

/** `ok: false`: the budget could not be re-read (or the tracker went off), so nothing was set. */
export type BudgetApplyResult = { ok: true; outcome: BudgetApplyOutcome } | { ok: false };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Sets the chosen suggestions as default monthly budgets. Re-reads the budget
 * first and leaves alone any category that gained one since; writes the rest
 * one at a time, so a failed POST costs only its own category; logs each
 * target as it lands (`budget-set`, with the id and amount Wealthfolio
 * stored), so a crash part-way still leaves Undo for what was written.
 */
export async function applyBudgetSuggestions(
  r: BudgetReaders,
  chosen: readonly BudgetSuggestion[],
  at: { month: string; window: string[] },
  now: Date,
): Promise<BudgetApplyResult> {
  let targets: BudgetTarget[];
  try {
    const read = await r.targets();
    if (!read.enabled) return { ok: false };
    targets = read.targets;
  } catch {
    return { ok: false };
  }
  const { write, alreadySet } = planBudgetApply(chosen, targets, at.month);
  const outcome: BudgetApplyOutcome = { set: [], alreadySet, failed: [] };
  for (const suggestion of write) {
    let target: BudgetTarget;
    try {
      target = await r.set(suggestion.categoryId, suggestion.cents);
    } catch (err) {
      outcome.failed.push({ suggestion, message: message(err) });
      continue;
    }
    outcome.set.push({ suggestion, target });
    try {
      await r.record([budgetSetChange({
        targetId: target.id, categoryId: suggestion.categoryId, categoryName: suggestion.name,
        amountCents: target.amountCents, why: suggestionWhy(at.window),
      })], now);
    } catch {
      // A log must never cost the budget; the writer records gaps itself.
    }
  }
  return { ok: true, outcome };
}
```

Edit 1 of 3 in `companion/src/wealthfolio.ts` — replace:

```ts
import type { CategoryRuleLike } from '../../shared/tx-story.js';
```

with:

```ts
import type { BudgetTarget } from '../../shared/budget-suggest.js';
import type { CategoryRuleLike } from '../../shared/tx-story.js';
```

Edit 2 of 3 in `companion/src/wealthfolio.ts` — replace:

```ts
export class WealthfolioClient {
  private token: string | null = null;
```

with:

```ts
/**
 * The budget targets in a `BudgetSnapshot` (upstream crates/spending
 * budget/model.rs, camelCase; the same on 3.8, 3.9 and 3.10): `state.targets`,
 * each `{ id, periodKey, targetType, taxonomyId, categoryId, groupId, amount }`
 * with `amount` a decimal STRING — read here as cents. A target missing an id
 * or a readable amount is skipped. `enabled` is false when the snapshot has no
 * budget groups: Wealthfolio answers an EMPTY snapshot while its Spending
 * tracker is off (`BudgetService::get`), and otherwise always has its system
 * groups — so an empty list there is not "no budgets". A reply that is not a
 * snapshot throws.
 */
export function parseBudgetSnapshot(body: unknown): { enabled: boolean; targets: BudgetTarget[] } {
  const state = (body && typeof body === 'object' && !Array.isArray(body) ? (body as { state?: unknown }).state : null) as
    { groups?: unknown; targets?: unknown } | null | undefined;
  if (!state || typeof state !== 'object' || !Array.isArray(state.targets)) {
    throw new Error("Wealthfolio's budget reply carried no budget targets");
  }
  const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  const targets: BudgetTarget[] = [];
  for (const raw of state.targets as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    const amount = typeof t.amount === 'number' ? t.amount : typeof t.amount === 'string' ? Number(t.amount) : NaN;
    const id = text(t.id);
    const periodKey = text(t.periodKey);
    const targetType = text(t.targetType);
    if (!id || !periodKey || !targetType || !Number.isFinite(amount)) continue;
    targets.push({ id, periodKey, targetType, taxonomyId: text(t.taxonomyId), categoryId: text(t.categoryId), amountCents: Math.round(amount * 100) });
  }
  return { enabled: Array.isArray(state.groups) && state.groups.length > 0, targets };
}

export class WealthfolioClient {
  private token: string | null = null;
```

Edit 3 of 3 in `companion/src/wealthfolio.ts` — replace:

```ts
    if (typeof spent !== 'number' || !Number.isFinite(spent)) throw new Error('getSpendingInsight: the reply carried no headline.spent');
    return spent;
  }

```

with:

```ts
    if (typeof spent !== 'number' || !Number.isFinite(spent)) throw new Error('getSpendingInsight: the reply carried no headline.spent');
    return spent;
  }

  /**
   * Every budget target (`GET /spending/budget?periodKey=default`, upstream
   * `get_budget`; `state.targets` lists every period's targets, and the
   * `'default'` view skips the month's actuals). See `parseBudgetSnapshot`.
   */
  async getBudgetTargets(): Promise<{ enabled: boolean; targets: BudgetTarget[] }> {
    const res = await fetch(`${this.baseUrl}/api/v1/spending/budget?periodKey=default`, { headers: this.authHeaders() });
    if (!res.ok) throw await this.httpError('getBudgetTargets', res);
    return parseBudgetSnapshot(await res.json());
  }

  /**
   * Sets a category's default monthly budget (`POST /spending/budget/targets`,
   * upstream `NewBudgetTarget`: `periodKey: 'default'`, `targetType:
   * 'category'`, the spending taxonomy, the category, and `amount` as a
   * decimal string — `validate_budget_target` requires taxonomyId and
   * categoryId and no groupId). Upstream this is an UPSERT on (period,
   * taxonomy, category): an existing target is overwritten, so callers
   * re-read first. Resolves the stored target, read back from the snapshot
   * the reply carries.
   */
  async setDefaultBudgetTarget(categoryId: string, amountCents: number): Promise<BudgetTarget> {
    const res = await fetch(`${this.baseUrl}/api/v1/spending/budget/targets?periodKey=default`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({
        periodKey: 'default',
        targetType: 'category',
        taxonomyId: 'spending_categories',
        categoryId,
        amount: (amountCents / 100).toFixed(2),
      }),
    });
    if (!res.ok) throw await this.httpError('setBudgetTarget', res);
    const stored = parseBudgetSnapshot(await res.json()).targets.find((t) => t.periodKey === 'default'
      && t.targetType === 'category' && t.taxonomyId === 'spending_categories' && t.categoryId === categoryId);
    if (!stored) throw new Error("setBudgetTarget: Wealthfolio's reply did not include the budget");
    return stored;
  }

  /** Deletes a budget target (`DELETE /spending/budget/targets/{id}`). Upstream
   *  deleting one that is already gone succeeds; Undo re-reads first anyway. */
  async deleteBudgetTarget(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/spending/budget/targets/${encodeURIComponent(id)}?periodKey=default`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!res.ok) throw await this.httpError('deleteBudgetTarget', res);
  }

```

Edit 1 of 2 in `companion/src/change-undo-host.ts` — replace:

```ts
export type UndoClient = SecretClient & Pick<WealthfolioClient,
  'getActivityAssignments' | 'assignActivityCategory' | 'unassignActivityCategory'
  | 'listCategorizationRules' | 'createCategorizationRule' | 'deleteCategorizationRule'>;
```

with:

```ts
export type UndoClient = SecretClient & Pick<WealthfolioClient,
  'getActivityAssignments' | 'assignActivityCategory' | 'unassignActivityCategory'
  | 'listCategorizationRules' | 'createCategorizationRule' | 'deleteCategorizationRule'
  | 'getBudgetTargets' | 'setDefaultBudgetTarget' | 'deleteBudgetTarget'>;
```

Edit 2 of 2 in `companion/src/change-undo-host.ts` — replace:

```ts
      filedBy: async (rule) => getNativeRuleFiledActivityIds(dbPath, rule.categoryId, rule.pattern),
    },
```

with:

```ts
      filedBy: async (rule) => getNativeRuleFiledActivityIds(dbPath, rule.categoryId, rule.pattern),
    },
    // `budget-set` (project 4). An empty snapshot means Wealthfolio's Spending
    // tracker is off, not that the budget is gone: that is unreadable, so the
    // Undo says it couldn't reach Wealthfolio and changes nothing.
    budgets: {
      targets: async () => {
        const read = await client.getBudgetTargets();
        if (!read.enabled) throw new Error("Wealthfolio's Spending tracker is off");
        return read.targets;
      },
      set: async (categoryId, amountCents) => (await client.setDefaultBudgetTarget(categoryId, amountCents)).id,
      remove: (id) => client.deleteBudgetTarget(id),
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run src/wealthfolio-budget.test.ts src/budget-suggest-host.test.ts src/change-undo-host.test.ts src/wealthfolio.test.ts`
Expected: PASS — 54 tests.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/wealthfolio.ts companion/src/wealthfolio-budget.test.ts companion/src/budget-suggest-host.ts companion/src/budget-suggest-host.test.ts companion/src/change-undo-host.ts companion/src/change-undo-host.test.ts
git commit -m "Getting started: the companion reads and writes budget targets, re-reading before every write

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `/budgets` — a stateless `cz:bg:` menu

Spec C's `/budgets` (G3; Q2, Q3). The list — "Groceries $425 · Dining out $180 · Gas $50" under the window and what each becomes — with one toggle per suggestion (✓ picked, "— left out" not), **Apply all (N)** and, when some are left out, **Apply selected (M)**. Stateless: a button carries the list's fingerprint (this month and every candidate's id and amount), the category's `findingHandle` (toggles) and a 24-bit selection mask over the candidates; a tap re-reads, and a list whose spending changed is shown again rather than applied. Apply re-reads once more (through the host) and says, per category, "✓ Groceries: $425 a month", "Already has a budget — left alone." or "couldn't set it — <error>", then "Undo any of these from /changes." (and "Send /budgets again to try the rest." after a failure). A budget that cannot be re-read sets nothing and offers **Try again**. Names are escaped in the text and outside every entity; raw on the buttons.

**Files:**
- Create: `companion/src/budgets-menu.ts`, `companion/src/budgets-menu.test.ts`

**Interfaces:**
- Consumes: Task 6 (`budgetDollars`, `suggestionLine`, `windowLabel`, `BUDGET_MAX_CANDIDATES`, the types); Task 8 (`readBudgetSuggestions`, `applyBudgetSuggestions`, `BudgetReaders`, `BudgetApplyOutcome`, `BudgetApplyResult`, `BudgetReadFailure`, `BudgetSuggestRead`); `findingHandle` (shared/handle.ts); `escapeMarkdown` (shared/telegram.ts).
- Produces:

```ts
// companion/src/budgets-menu.ts
export const BUDGETS_CALLBACK_PREFIX = 'cz:bg:';
export const BUDGETS_ALL_SET, BUDGETS_NO_HISTORY, BUDGETS_DATABASE, BUDGETS_SPENDING_OFF, BUDGETS_UNREADABLE_SHOW,
  BUDGETS_UNREADABLE, BUDGETS_ALREADY, BUDGETS_CHANGED, BUDGETS_PICK_ONE, BUDGETS_UNDO_HINT, BUDGETS_RETRY_HINT: string;
export interface MenuScreen { text: string; keyboard: InlineKeyboard }
export type BudgetsView = { kind: 'list' } | { kind: 'toggle'; fp: string; handle: string; mask: number } | { kind: 'apply'; fp: string; mask: number };
export function budgetsData(view: BudgetsView): string;
export function parseBudgetsData(data: string): BudgetsView | null;
export function budgetsFingerprint(s: BudgetSuggestions): string;
export function shownMask(s: BudgetSuggestions): number;
export function renderBudgetList(s: BudgetSuggestions, selected: number, notice?: string): MenuScreen;
export function renderBudgetResult(o: BudgetApplyOutcome): string;
export interface BudgetsMenuDeps {
  read(now: Date): Promise<BudgetSuggestRead>;
  apply(chosen: BudgetSuggestion[], at: { month: string; window: string[] }, now: Date): Promise<BudgetApplyResult>;
  now(): Date; log(msg: string): void;
}
export function budgetsMenuDeps(readers: BudgetReaders, log: (msg: string) => void): BudgetsMenuDeps;
export interface BudgetsMenu { handles(data: string): boolean; onCallback(cb: { data: string }, ui: BudgetsMenuUi): Promise<void>; reply(send: Send): Promise<void> }
export function createBudgetsMenu(deps: BudgetsMenuDeps): BudgetsMenu;
```

- [ ] **Step 1: Write the failing tests**

**Create `companion/src/budgets-menu.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { suggestBudgets, BUDGET_MAX_CANDIDATES, type BudgetSuggestions, type BudgetTarget } from '../../shared/budget-suggest.js';
import { ASK_CALLBACK_PREFIX } from '../../shared/ask-flow.js';
import { findingHandle } from '../../shared/handle.js';
import { CATEGORIZE_ENTRY_CALLBACK, escapeMarkdown, RECATEGORIZE_ENTRY_CALLBACK, WHY_CALLBACK_PREFIX } from '../../shared/telegram.js';
import { AUDIT_CALLBACK_PREFIX } from './audit-menu.js';
import type { BudgetReaders } from './budget-suggest-host.js';
import {
  budgetsData, budgetsFingerprint, budgetsMenuDeps, createBudgetsMenu, parseBudgetsData, renderBudgetList, shownMask,
  BUDGETS_ALL_SET, BUDGETS_CALLBACK_PREFIX, BUDGETS_CHANGED, BUDGETS_DATABASE, BUDGETS_NO_HISTORY, BUDGETS_PICK_ONE,
  BUDGETS_SPENDING_OFF, BUDGETS_UNREADABLE, BUDGETS_UNREADABLE_SHOW, type BudgetsMenuDeps, type MenuScreen,
} from './budgets-menu.js';
import { CHANGES_CALLBACK_PREFIX } from './changes-menu.js';
import { FINDINGS_CALLBACK_PREFIX } from './findings-menu.js';
import { SUBSCRIPTIONS_CALLBACK_PREFIX } from './subscriptions-menu.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const ODD = "Joe's *Diner*_[1]";
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const allData = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
const labels = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.text);
const target = (over: Partial<BudgetTarget> = {}): BudgetTarget => ({
  id: 'bt', periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId: 'cat-gro', amountCents: 1, ...over,
});

const CATEGORIES = [
  { id: 'cat-gro', name: 'Groceries', parentId: null }, { id: 'cat-odd', name: ODD, parentId: null },
  { id: 'cat-gas', name: 'Gas', parentId: null }, { id: 'cat-fun', name: 'Fun', parentId: null },
];
const SPEND = [
  { month: '2026-08', category: 'Groceries', accountId: 'a', amount: 1275 },
  { month: '2026-09', category: ODD, accountId: 'a', amount: 540 },
  { month: '2026-09', category: 'Gas', accountId: 'a', amount: 150 },
  { month: '2026-09', category: 'Fun', accountId: 'a', amount: 90 },
];

/** The menu over fake readers and the real host: Fun already has a budget. */
function setup(targets: BudgetTarget[] = [target({ id: 'bt-fun', categoryId: 'cat-fun' })]) {
  const state = { targets };
  const readers: BudgetReaders = {
    settings: vi.fn(() => ({ timezone: 'America/New_York', excludedCategoryIds: [], categoryParents: {}, spendingOn: true })),
    spend: vi.fn(() => SPEND),
    categories: vi.fn(() => CATEGORIES),
    targets: vi.fn(async () => ({ enabled: true, targets: state.targets })),
    set: vi.fn(async (categoryId: string, amountCents: number) => target({ id: `bt-${categoryId}`, categoryId, amountCents })),
    record: vi.fn(async () => {}),
  };
  const deps: BudgetsMenuDeps = { ...budgetsMenuDeps(readers, vi.fn()), now: () => NOW };
  return { state, readers, deps, menu: createBudgetsMenu(deps) };
}
const suggestions = (targets: BudgetTarget[] = [target({ id: 'bt-fun', categoryId: 'cat-fun' })]): BudgetSuggestions => suggestBudgets({
  now: NOW, timezone: 'America/New_York', spend: SPEND, categories: CATEGORIES, excludedCategoryIds: [], categoryParents: {}, targets,
});
const ui = () => ({ edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) });
const edited = (u: ReturnType<typeof ui>) => u.edit.mock.calls.at(-1) as unknown as [string, MenuScreen['keyboard'] | undefined];

describe('the cz:bg: encoding', () => {
  it('round-trips each button and rejects anything this menu never emitted', () => {
    const fp = 'a1b2c3d4';
    const h = findingHandle('cat-gro');
    for (const view of [
      { kind: 'list' as const },
      { kind: 'toggle' as const, fp, handle: h, mask: 0x5 },
      { kind: 'apply' as const, fp, mask: 0xffffff },
    ]) expect(parseBudgetsData(budgetsData(view))).toEqual(view);
    for (const bad of ['cz:bg:', 'cz:bg:x', 'cz:bg:ta1b2c3d4', `cz:bg:s${fp}`, `cz:bg:s${fp}1234567`, 'cz:bg:sZZZZZZZZ1', 'cz:au:m', 'cz:7:1']) {
      expect(parseBudgetsData(bad)).toBeNull();
    }
  });

  it('is the only prefix starting cz:bg, and starts no other', () => {
    const others = [ASK_CALLBACK_PREFIX, WHY_CALLBACK_PREFIX, AUDIT_CALLBACK_PREFIX, CHANGES_CALLBACK_PREFIX, FINDINGS_CALLBACK_PREFIX,
      SUBSCRIPTIONS_CALLBACK_PREFIX, CATEGORIZE_ENTRY_CALLBACK, RECATEGORIZE_ENTRY_CALLBACK, 'cz:al:', 'cz:alc:', 'cz:tl:', 'cz:tlc:', 'cz:tlk:', 'cz:tlu:', 'cz:0:0'];
    expect(BUDGETS_CALLBACK_PREFIX).toBe('cz:bg:');
    expect(others.filter((p) => p.startsWith('cz:bg') || BUDGETS_CALLBACK_PREFIX.startsWith(p))).toEqual([]);
  });

  it(`keeps every button within 64 bytes — with ${BUDGET_MAX_CANDIDATES} suggestions the longest is 29`, () => {
    const many = Array.from({ length: BUDGET_MAX_CANDIDATES }, (_, i) => ({ id: `0f8fad5b-d9cb-469f-a165-7086772895${String(i).padStart(2, '0')}`, name: `${ODD} ${i}`, parentId: null }));
    const s = suggestBudgets({
      now: NOW, timezone: null, categories: many, excludedCategoryIds: [], categoryParents: {}, targets: [],
      spend: many.map((c, i) => ({ month: '2026-09', category: c.name, accountId: 'a', amount: 100 + i * 30 })),
    });
    const screen = renderBudgetList(s, shownMask(s));
    const lengths = allData(screen).map(bytes);
    expect(Math.max(...lengths)).toBe(29);
    expect(allData(screen)).toHaveLength(BUDGET_MAX_CANDIDATES + 1);
  });
});

describe('renderBudgetList', () => {
  it('lists the suggestions with the window, the names escaped in the text and raw on the buttons', () => {
    const s = suggestions();
    const screen = renderBudgetList(s, shownMask(s));
    expect(screen.text).toBe([
      '*Suggested budgets*',
      'Your average monthly spending for Jul–Sep, rounded up to the nearest $5, for each category with no budget yet. Each becomes a default monthly budget in Wealthfolio.',
      '',
      `Groceries $425 · ${escapeMarkdown(ODD)} $180 · Gas $50`,
      '',
      'Tap a category to leave it out.',
    ].join('\n'));
    expect(screen.text).not.toContain(ODD);
    expect(labels(screen)).toEqual(['✓ Groceries $425', `✓ ${ODD} $180`, '✓ Gas $50', 'Apply all (3)']);
  });

  it('marks one left out, and offers Apply selected beside Apply all', () => {
    const s = suggestions();
    const fp = budgetsFingerprint(s);
    const screen = renderBudgetList(s, shownMask(s) & ~0b10);
    expect(labels(screen)).toEqual(['✓ Groceries $425', `${ODD} $180 — left out`, '✓ Gas $50', 'Apply all (3)', 'Apply selected (2)']);
    expect(allData(screen)).toEqual([
      budgetsData({ kind: 'toggle', fp, handle: findingHandle('cat-gro'), mask: 0b101 }),
      budgetsData({ kind: 'toggle', fp, handle: findingHandle('cat-odd'), mask: 0b101 }),
      budgetsData({ kind: 'toggle', fp, handle: findingHandle('cat-gas'), mask: 0b101 }),
      budgetsData({ kind: 'apply', fp, mask: 0b111 }),
      budgetsData({ kind: 'apply', fp, mask: 0b101 }),
    ]);
  });

  it('says why there is nothing to suggest', () => {
    const allSet = suggestions(CATEGORIES.map((c) => target({ id: `bt-${c.id}`, categoryId: c.id })));
    expect(renderBudgetList(allSet, 0)).toEqual({ text: `*Suggested budgets*\n${BUDGETS_ALL_SET}`, keyboard: { inline_keyboard: [] } });
    const empty = suggestBudgets({ now: NOW, timezone: null, spend: [], categories: CATEGORIES, excludedCategoryIds: [], categoryParents: {}, targets: [] });
    expect(renderBudgetList(empty, 0).text).toBe(`*Suggested budgets*\n${BUDGETS_NO_HISTORY}`);
  });
});

describe('/budgets', () => {
  it('replies with the list, every suggestion picked', async () => {
    const { menu } = setup();
    const send = vi.fn(async () => {});
    await menu.reply(send);
    const [text, keyboard] = send.mock.calls[0] as unknown as [string, MenuScreen['keyboard']];
    expect(text.startsWith('*Suggested budgets*\n')).toBe(true);
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['✓ Groceries $425', `✓ ${ODD} $180`, '✓ Gas $50', 'Apply all (3)']);
  });

  it.each([
    ['database', { settings: vi.fn(() => { throw new Error('no database'); }) }, BUDGETS_DATABASE],
    ['spending-off', { targets: vi.fn(async () => ({ enabled: false, targets: [] })) }, BUDGETS_SPENDING_OFF],
    ['budgets', { targets: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) }, BUDGETS_UNREADABLE_SHOW],
  ])('says so when %s cannot be read', async (_why, over, text) => {
    const { readers, menu } = setup();
    Object.assign(readers, over);
    const send = vi.fn(async () => {});
    await menu.reply(send);
    expect(send.mock.calls[0]).toEqual([escapeMarkdown(text)]);
  });

  it('a tap toggles a category in place', async () => {
    const { menu } = setup();
    const s = suggestions();
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'toggle', fp: budgetsFingerprint(s), handle: findingHandle('cat-gas'), mask: 0b111 }) }, u);
    const [, keyboard] = edited(u);
    expect(keyboard!.inline_keyboard.flat().map((b) => b.text)).toEqual(['✓ Groceries $425', `✓ ${ODD} $180`, 'Gas $50 — left out', 'Apply all (3)', 'Apply selected (2)']);
    expect(u.answer).toHaveBeenCalled();
  });

  it('Apply selected sets only those, and says how each went', async () => {
    const { menu, readers } = setup();
    const s = suggestions();
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: 0b101 }) }, u);
    expect(readers.set).toHaveBeenCalledTimes(2);
    const [text, keyboard] = edited(u);
    expect(text).toBe(['*Budgets*', '✓ Groceries: $425 a month', '✓ Gas: $50 a month', '', 'Undo any of these from /changes.'].join('\n'));
    expect(keyboard).toBeUndefined();
  });

  it('never overwrites a budget added between the list and Apply: it is left alone and said so', async () => {
    const { menu, readers, state } = setup();
    const s = suggestions();
    state.targets = [...state.targets, target({ id: 'bt-new', categoryId: 'cat-odd', amountCents: 9900 })];
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: shownMask(s) }) }, u);
    expect((readers.set as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['cat-gro', 'cat-gas']);
    expect(edited(u)[0]).toBe([
      '*Budgets*', '✓ Groceries: $425 a month', '✓ Gas: $50 a month', `${escapeMarkdown(ODD)}: Already has a budget — left alone.`,
      '', 'Undo any of these from /changes.',
    ].join('\n'));
  });

  it('one failing category does not stop the rest', async () => {
    const { menu, readers } = setup();
    readers.set = vi.fn(async (categoryId: string, amountCents: number) => {
      if (categoryId === 'cat-gro') throw new Error('setBudgetTarget failed: 500 - *locked*');
      return target({ id: `bt-${categoryId}`, categoryId, amountCents });
    });
    const s = suggestions();
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: shownMask(s) }) }, u);
    expect(edited(u)[0]).toBe([
      '*Budgets*', `✓ ${escapeMarkdown(ODD)}: $180 a month`, '✓ Gas: $50 a month',
      `Groceries: couldn't set it — ${escapeMarkdown('setBudgetTarget failed: 500 - *locked*')}`,
      '', 'Undo any of these from /changes.', 'Send /budgets again to try the rest.',
    ].join('\n'));
  });

  it("sets nothing when the budget can't be re-read, and offers to try again", async () => {
    const { menu, readers } = setup();
    const s = suggestions();
    let reads = 0;
    readers.targets = vi.fn(async () => {
      reads += 1;
      if (reads > 1) throw new Error('ECONNREFUSED');
      return { enabled: true, targets: [] };
    });
    const data = budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: shownMask(s) });
    const u = ui();
    await menu.onCallback({ data }, u);
    expect(readers.set).not.toHaveBeenCalled();
    expect(edited(u)).toEqual([`*Suggested budgets*\n${escapeMarkdown(BUDGETS_UNREADABLE)}`, { inline_keyboard: [[{ text: 'Try again', callback_data: data }]] }]);
  });

  it('shows the list again when the spending behind it changed', async () => {
    const { menu, readers } = setup();
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'apply', fp: '00000000', mask: 0b1 }) }, u);
    expect(readers.set).not.toHaveBeenCalled();
    const [text, keyboard] = edited(u);
    expect(text.startsWith(`*Suggested budgets*\n${escapeMarkdown(BUDGETS_CHANGED)}\n`)).toBe(true);
    expect(keyboard!.inline_keyboard.flat().at(-1)!.text).toBe('Apply all (3)');
  });

  it('asks for at least one, and ignores a tap it never sent', async () => {
    const { menu } = setup();
    const s = suggestions();
    const u = ui();
    await menu.onCallback({ data: budgetsData({ kind: 'apply', fp: budgetsFingerprint(s), mask: 0 }) }, u);
    expect(u.answer).toHaveBeenCalledWith(BUDGETS_PICK_ONE);
    expect(u.edit).not.toHaveBeenCalled();
    const v = ui();
    await menu.onCallback({ data: 'cz:bg:zz' }, v);
    expect(v.answer).toHaveBeenCalledWith();
    expect(menu.handles('cz:bg:m')).toBe(true);
    expect(menu.handles('cz:au:m')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/budgets-menu.test.ts`
Expected: FAIL — `Cannot find module './budgets-menu.js'`; no tests run.

- [ ] **Step 3: Implement**

**Create `companion/src/budgets-menu.ts`:**

```ts
/**
 * companion/src/budgets-menu.ts
 *
 * `/budgets` (project 4, G3–G5): suggested default monthly budgets for the
 * categories with none, from the last 3 full months, applied from Telegram —
 * the add-on cannot (its SDK has no budget API). STATELESS like audit-menu.ts:
 * every tap re-reads, and every button carries what it needs. After `cz:bg:`:
 *   m                         the list again, every suggestion picked
 *   t<fp><handle><mask>       toggle one category, in place
 *   s<fp><mask>               apply the categories in `mask`, in place
 * `<fp>` is `findingHandle` of this month and the candidates (id and amount):
 * a list whose spending changed since is shown again rather than applied.
 * `<handle>` is `findingHandle` of the category id. `<mask>` is lowercase hex,
 * one bit per candidate in `suggestBudgets` order (at most 24 bits), so the
 * longest button is 29 bytes. The mask indexes CANDIDATES, not what was
 * shown: a category that gained a budget between the list and Apply is still
 * chosen, re-read, and left alone ("Already has a budget — left alone.").
 * Nothing else may start with `cz:bg`.
 *
 * Category names and Wealthfolio's error text are escaped AND kept outside
 * every `*…*`; the only entities are the two fixed headings. Button labels are
 * plain text, not escaped. No emoji: ✓ marks what is picked or set.
 */
import {
  budgetDollars, suggestionLine, windowLabel, BUDGET_MAX_CANDIDATES,
  type BudgetSuggestion, type BudgetSuggestions,
} from '../../shared/budget-suggest.js';
import { findingHandle } from '../../shared/handle.js';
import { escapeMarkdown, type InlineKeyboard } from '../../shared/telegram.js';
import {
  applyBudgetSuggestions, readBudgetSuggestions, type BudgetApplyOutcome, type BudgetApplyResult, type BudgetReaders,
  type BudgetReadFailure, type BudgetSuggestRead,
} from './budget-suggest-host.js';

export const BUDGETS_CALLBACK_PREFIX = 'cz:bg:';
export const BUDGETS_TITLE = 'Suggested budgets';
export const BUDGETS_RESULT_TITLE = 'Budgets';
export const budgetsIntro = (window: readonly string[]) =>
  `Your average monthly spending for ${windowLabel(window)}, rounded up to the nearest $5, for each category with no budget yet. Each becomes a default monthly budget in Wealthfolio.`;
export const BUDGETS_HINT = 'Tap a category to leave it out.';
export const BUDGETS_ALL_SET = 'Every category you spend on already has a budget — nothing to suggest.';
export const BUDGETS_NO_HISTORY = 'Nothing to suggest yet: no category averaged $10 or more a month over the last 3 full months.';
export const BUDGETS_DATABASE = "Couldn't read your spending from Wealthfolio's database — try again.";
export const BUDGETS_SPENDING_OFF = "Wealthfolio's Spending tracker is off, so it has no budgets — turn it on in Wealthfolio first.";
export const BUDGETS_UNREADABLE_SHOW = "Couldn't read your budgets — try again.";
export const BUDGETS_UNREADABLE = "Couldn't read your budgets — nothing was set.";
export const BUDGETS_ALREADY = 'Already has a budget — left alone.';
export const BUDGETS_CHANGED = 'Your spending changed since that list — here it is again.';
export const BUDGETS_PICK_ONE = 'Pick at least one first.';
export const BUDGETS_UNDO_HINT = 'Undo any of these from /changes.';
export const BUDGETS_RETRY_HINT = 'Send /budgets again to try the rest.';
const FAILED_ANSWER = 'Could not do that — check the companion logs.';

type Button = { text: string; callback_data: string };
export interface MenuScreen { text: string; keyboard: InlineKeyboard }

export type BudgetsView =
  | { kind: 'list' }
  | { kind: 'toggle'; fp: string; handle: string; mask: number }
  | { kind: 'apply'; fp: string; mask: number };

export function budgetsData(view: BudgetsView): string {
  switch (view.kind) {
    case 'list': return `${BUDGETS_CALLBACK_PREFIX}m`;
    case 'toggle': return `${BUDGETS_CALLBACK_PREFIX}t${view.fp}${view.handle}${view.mask.toString(16)}`;
    case 'apply': return `${BUDGETS_CALLBACK_PREFIX}s${view.fp}${view.mask.toString(16)}`;
  }
}

/** The view a button carries, or null for anything this menu never emitted. */
export function parseBudgetsData(data: string): BudgetsView | null {
  if (!data.startsWith(BUDGETS_CALLBACK_PREFIX)) return null;
  const s = data.slice(BUDGETS_CALLBACK_PREFIX.length);
  if (s === 'm') return { kind: 'list' };
  const t = /^t([0-9a-f]{8})([0-9a-f]{8})([0-9a-f]{1,6})$/.exec(s);
  if (t) return { kind: 'toggle', fp: t[1], handle: t[2], mask: parseInt(t[3], 16) };
  const a = /^s([0-9a-f]{8})([0-9a-f]{1,6})$/.exec(s);
  if (a) return { kind: 'apply', fp: a[1], mask: parseInt(a[2], 16) };
  return null;
}

/** What a button's mask was drawn against: this month and every candidate's id and amount. */
export function budgetsFingerprint(s: BudgetSuggestions): string {
  return findingHandle(`${s.month}|${s.candidates.map((c) => `${c.categoryId}=${c.cents}`).join('|')}`);
}

const bit = (i: number) => 2 ** i;
const has = (mask: number, i: number) => Math.floor(mask / bit(i)) % 2 === 1;
/** The candidates offered (no budget yet), as bits. */
export function shownMask(s: BudgetSuggestions): number {
  const shown = new Set(s.suggestions.map((x) => x.categoryId));
  return s.candidates.reduce((m, c, i) => (shown.has(c.categoryId) ? m + bit(i) : m), 0);
}
const count = (mask: number, n: number) => Array.from({ length: n }, (_, i) => i).filter((i) => has(mask, i)).length;

const clip = (s: string, n: number) => {
  const chars = Array.from(s);
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s;
};

/** The list: every suggestion, a toggle each, Apply all and (when some are left out) Apply selected. */
export function renderBudgetList(s: BudgetSuggestions, selected: number, notice?: string): MenuScreen {
  const head = [`*${BUDGETS_TITLE}*`, ...(notice ? [escapeMarkdown(notice)] : [])];
  if (s.suggestions.length === 0) {
    return { text: [...head, s.candidates.length ? BUDGETS_ALL_SET : BUDGETS_NO_HISTORY].join('\n'), keyboard: { inline_keyboard: [] } };
  }
  const shown = shownMask(s);
  const picked = selected % bit(BUDGET_MAX_CANDIDATES);
  const fp = budgetsFingerprint(s);
  const rows: Button[][] = [];
  s.candidates.forEach((c, i) => {
    if (!has(shown, i)) return;
    const on = has(picked, i);
    rows.push([{
      text: `${on ? '✓ ' : ''}${clip(c.name, 32)} ${budgetDollars(c.cents)}${on ? '' : ' — left out'}`,
      callback_data: budgetsData({ kind: 'toggle', fp, handle: findingHandle(c.categoryId), mask: picked }),
    }]);
  });
  const all = count(shown, s.candidates.length);
  const some = count(picked, s.candidates.length);
  const apply: Button[] = [{ text: `Apply all (${all})`, callback_data: budgetsData({ kind: 'apply', fp, mask: shown }) }];
  if (some > 0 && some < all) apply.push({ text: `Apply selected (${some})`, callback_data: budgetsData({ kind: 'apply', fp, mask: picked }) });
  rows.push(apply);
  const list = suggestionLine(s.suggestions.map((x) => ({ ...x, name: escapeMarkdown(x.name) })));
  return {
    text: [...head, escapeMarkdown(budgetsIntro(s.window)), '', list, '', BUDGETS_HINT].join('\n'),
    keyboard: { inline_keyboard: rows },
  };
}

/** What Apply did, category by category. */
export function renderBudgetResult(o: BudgetApplyOutcome): string {
  const name = (x: BudgetSuggestion) => escapeMarkdown(x.name);
  const lines = [
    `*${BUDGETS_RESULT_TITLE}*`,
    ...o.set.map(({ suggestion, target }) => `✓ ${name(suggestion)}: ${budgetDollars(target.amountCents)} a month`),
    ...o.alreadySet.map((x) => `${name(x)}: ${BUDGETS_ALREADY}`),
    ...o.failed.map(({ suggestion, message }) => `${name(suggestion)}: couldn't set it — ${escapeMarkdown(message)}`),
  ];
  const tail = [...(o.set.length ? [BUDGETS_UNDO_HINT] : []), ...(o.failed.length ? [BUDGETS_RETRY_HINT] : [])];
  return (tail.length ? [...lines, '', ...tail] : lines).join('\n');
}

const READ_FAILURE: Record<BudgetReadFailure, string> = {
  database: BUDGETS_DATABASE,
  'spending-off': BUDGETS_SPENDING_OFF,
  budgets: BUDGETS_UNREADABLE_SHOW,
};

type Send = (text: string, keyboard?: InlineKeyboard) => Promise<void>;

export interface BudgetsMenuUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
  send: Send;
}

/** What one tap reads and writes, live. */
export interface BudgetsMenuDeps {
  read(now: Date): Promise<BudgetSuggestRead>;
  apply(chosen: BudgetSuggestion[], at: { month: string; window: string[] }, now: Date): Promise<BudgetApplyResult>;
  now(): Date;
  log(msg: string): void;
}

/** The deps over the companion's real readers (budget-suggest-host.ts). */
export function budgetsMenuDeps(readers: BudgetReaders, log: (msg: string) => void): BudgetsMenuDeps {
  return {
    read: (now) => readBudgetSuggestions(readers, now),
    apply: (chosen, at, now) => applyBudgetSuggestions(readers, chosen, at, now),
    now: () => new Date(),
    log,
  };
}

export interface BudgetsMenu {
  handles(data: string): boolean;
  onCallback(cb: { data: string }, ui: BudgetsMenuUi): Promise<void>;
  /** `/budgets`: the list, as a reply. */
  reply(send: Send): Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** An empty keyboard is sent as none. */
const sendScreen = (send: Send, s: MenuScreen) => (s.keyboard.inline_keyboard.length ? send(s.text, s.keyboard) : send(s.text));
const editScreen = (ui: BudgetsMenuUi, s: MenuScreen) => (s.keyboard.inline_keyboard.length ? ui.edit(s.text, s.keyboard) : ui.edit(s.text));

export function createBudgetsMenu(deps: BudgetsMenuDeps): BudgetsMenu {
  return {
    handles(data) {
      return data.startsWith(BUDGETS_CALLBACK_PREFIX);
    },

    async reply(send) {
      const read = await deps.read(deps.now());
      if (!read.ok) return void await send(escapeMarkdown(READ_FAILURE[read.reason]));
      await sendScreen(send, renderBudgetList(read.result, shownMask(read.result)));
    },

    async onCallback(cb, ui) {
      try {
        const view = parseBudgetsData(cb.data);
        if (!view) return void await ui.answer();
        if (view.kind === 'apply' && view.mask === 0) return void await ui.answer(BUDGETS_PICK_ONE);
        const now = deps.now();
        const read = await deps.read(now);
        if (!read.ok) {
          // Before Apply has written anything: say so in place, with a way to retry.
          const text = view.kind === 'apply' && read.reason === 'budgets' ? BUDGETS_UNREADABLE : READ_FAILURE[read.reason];
          await ui.edit(`*${BUDGETS_TITLE}*\n${escapeMarkdown(text)}`, { inline_keyboard: [[{ text: 'Try again', callback_data: cb.data }]] });
          return void await ui.answer();
        }
        const s = read.result;
        if (view.kind === 'list') {
          await editScreen(ui, renderBudgetList(s, shownMask(s)));
          return void await ui.answer();
        }
        if (view.fp !== budgetsFingerprint(s)) {
          await editScreen(ui, renderBudgetList(s, shownMask(s), BUDGETS_CHANGED));
          return void await ui.answer();
        }
        if (view.kind === 'toggle') {
          const i = s.candidates.findIndex((c) => findingHandle(c.categoryId) === view.handle);
          const mask = i < 0 ? view.mask : has(view.mask, i) ? view.mask - bit(i) : view.mask + bit(i);
          await editScreen(ui, renderBudgetList(s, mask));
          return void await ui.answer();
        }
        const chosen = s.candidates.filter((_, i) => has(view.mask, i));
        const result = await deps.apply(chosen, { month: s.month, window: s.window }, now);
        if (!result.ok) {
          await ui.edit(`*${BUDGETS_TITLE}*\n${escapeMarkdown(BUDGETS_UNREADABLE)}`, { inline_keyboard: [[{ text: 'Try again', callback_data: cb.data }]] });
          return void await ui.answer();
        }
        await ui.edit(renderBudgetResult(result.outcome));
        await ui.answer();
      } catch (err) {
        deps.log(`Budgets menu: ${cb.data} failed: ${message(err)}`);
        await ui.answer(FAILED_ANSWER).catch(() => {});
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run src/budgets-menu.test.ts`
Expected: PASS — 17 tests.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/budgets-menu.ts companion/src/budgets-menu.test.ts
git commit -m "Getting started: /budgets — a stateless cz:bg: menu

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `/budgets` wired in — More commands, `cz:bg:` routed before the transaction menu

The wiring (spec C; Q3). `/budgets` joins `/help`'s More commands — not the registered seven-command ☰ menu. `buildBudgetsMenu` builds the menu over the companion's real readers; one instance serves the command and the taps (`buildTelegramListenerDeps`), and `onMenuCallback` asks it right after `cz:au:` and before the categorize fallthrough, which would read any `cz:` data it does not know as an expired menu. The wiring tests pin the clock and give the database mocks one read's worth of values at a time.

**Files:**
- Modify: `companion/src/index.ts`, `companion/src/index.test.ts`, `shared/telegram-commands.ts`, `shared/telegram-commands.test.ts`

**Interfaces:**
- Consumes: Task 8 (`companionBudgetReaders`); Task 9 (`budgetsMenuDeps`, `createBudgetsMenu`, `BudgetsMenu`).
- Produces:

```ts
// companion/src/index.ts
export function buildBudgetsMenu(wfClient: WealthfolioClient): BudgetsMenu;
export function buildTelegramCommandHandler(wfClient, controller?, asks?, why?, audit?, budgets?: BudgetsMenu): (cmd, reply) => Promise<void>;
// shared/telegram-commands.ts
TELEGRAM_MORE_COMMANDS: [..., { command: 'budgets', description: 'Suggested budgets from your last 3 months, for categories with none' }];
```

- [ ] **Step 1: Write the failing tests**

Edit 1 of 2 in `companion/src/index.test.ts` — replace:

```ts
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending, getNativeCategorizedSpending, getNativeSpendingCategories, getNativeTxSearchRows } from './sqlite-native.js';
```

with:

```ts
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending, getNativeCategorizedSpending, getNativeSpendingCategories, getNativeTxSearchRows, getNativeSpendMatrix } from './sqlite-native.js';
import { getNativeAuditSettings } from './sqlite-audit.js';
```

Edit 2 of 2 in `companion/src/index.test.ts` — replace:

```ts
      // This fake client has no valuations: Wealthfolio's figure is unknown, and the reply says why.
      expect(text).toContain("⚠️ Couldn't read Wealthfolio's balances, so cash accounts aren't compared.");
    });
  });

```

with:

```ts
      // This fake client has no valuations: Wealthfolio's figure is unknown, and the reply says why.
      expect(text).toContain("⚠️ Couldn't read Wealthfolio's balances, so cash accounts aren't compared.");
    });
  });

  describe('/budgets', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-14T15:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** One read's worth of the database: Spending on, $1,260 of groceries over Jul–Sep. */
    const spendingOnce = () => {
      vi.mocked(getNativeAuditSettings).mockReturnValueOnce({
        timezone: 'America/New_York', excludedCategoryIds: [], categoryParents: {}, spendingOn: true, spendingAccountIds: ['wf-1'],
      });
      vi.mocked(getNativeSpendMatrix).mockReturnValueOnce([{ month: '2026-09', category: 'Groceries', accountId: 'wf-1', amount: 1260 }]);
      vi.mocked(getNativeSpendingCategories).mockReturnValueOnce([{ id: 'cat-gro', name: 'Groceries', parentId: null, parentName: null }]);
    };
    const budgetClient = () => {
      const { client, secrets } = clientFor();
      client.getBudgetTargets = vi.fn(async () => ({ enabled: true, targets: [] }));
      client.setDefaultBudgetTarget = vi.fn(async (categoryId: string, amountCents: number) => ({
        id: `bt-${categoryId}`, periodKey: 'default', targetType: 'category', taxonomyId: 'spending_categories', categoryId, amountCents,
      }));
      return { client, secrets };
    };

    it('replies with the suggestions, every one picked', async () => {
      spendingOnce();
      const { client } = budgetClient();
      const sent: Array<[string, any]> = [];
      await buildTelegramCommandHandler(client)({ command: 'budgets', args: '' }, async (t, k) => { sent.push([t, k]); });
      expect(sent[0][0].startsWith('*Suggested budgets*\n')).toBe(true);
      expect(sent[0][0]).toContain('\nGroceries $420\n');
      expect(sent[0][1].inline_keyboard.flat().map((b: any) => b.text)).toEqual(['✓ Groceries $420', 'Apply all (1)']);
    });

    it("says so when Wealthfolio's Spending tracker is off", async () => {
      const { client } = budgetClient();
      const { sent, reply } = collector();
      await buildTelegramCommandHandler(client)({ command: 'budgets', args: '' }, reply);
      expect(sent).toEqual(["Wealthfolio's Spending tracker is off, so it has no budgets — turn it on in Wealthfolio first."]);
    });

    it('cz:bg: taps reach the budgets menu, not the transaction menu: Apply sets the budget and logs it for Undo', async () => {
      spendingOnce();
      spendingOnce();
      const { client, secrets } = budgetClient();
      const sent: Array<[string, any]> = [];
      await buildTelegramCommandHandler(client)({ command: 'budgets', args: '' }, async (t, k) => { sent.push([t, k]); });
      const applyAll = sent[0][1].inline_keyboard.flat().find((b: any) => b.text === 'Apply all (1)').callback_data;
      const deps = buildTelegramListenerDeps(client);
      const ui = { edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) };
      await deps.onMenuCallback!({ data: applyAll, chatId: 1, messageId: 2 }, ui);
      expect(client.setDefaultBudgetTarget).toHaveBeenCalledWith('cat-gro', 42000);
      expect((ui.edit.mock.calls[0] as unknown as [string])[0]).toBe('*Budgets*\n✓ Groceries: $420 a month\n\nUndo any of these from /changes.');
      const bucket = JSON.parse(secrets.get('change_log:companion:2026-10')!);
      expect(bucket.entries).toEqual([expect.objectContaining({
        kind: 'budget-set', actor: 'you', summary: 'Set a $420.00 monthly budget for Groceries', after: expect.objectContaining({ targetId: 'bt-cat-gro' }),
      })]);
    });
  });

```

Edit 1 of 1 in `shared/telegram-commands.test.ts` — replace:

```ts
  it('keeps the other nine working, listed under "More commands" in /help', () => {
    expect(TELEGRAM_MORE_COMMANDS.map((c) => c.command))
      .toEqual(['afford', 'pool', 'recategorize', 'newrule', 'dismissed', 'subscriptions', 'changes', 'why', 'audit']);
```

with:

```ts
  it('keeps the other ten working, listed under "More commands" in /help', () => {
    expect(TELEGRAM_MORE_COMMANDS.map((c) => c.command))
      .toEqual(['afford', 'pool', 'recategorize', 'newrule', 'dismissed', 'subscriptions', 'changes', 'why', 'audit', 'budgets']);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/index.test.ts`
Expected: FAIL — the 3 new `/budgets` tests: the command gets `/help`'s unknown-command reply, so there is no list, no off-tracker message and no Apply button to tap.

Run: `npx vitest run shared/telegram-commands.test.ts`
Expected: FAIL — `keeps the other ten working, listed under "More commands" in /help` (`budgets` is not listed).

- [ ] **Step 3: Implement**

Edit 1 of 2 in `shared/telegram-commands.ts` — replace:

```ts
 *  `/audit` (2c) takes no arguments; its buttons run each check. */
```

with:

```ts
 *  `/audit` (2c) takes no arguments; its buttons run each check.
 *  `/budgets` (project 4) takes no arguments; its buttons pick and apply. */
```

Edit 2 of 2 in `shared/telegram-commands.ts` — replace:

```ts
  { command: 'audit', description: 'Why a balance or the month differs from Wealthfolio, and what its Health page flags' },
] as const;
```

with:

```ts
  { command: 'audit', description: 'Why a balance or the month differs from Wealthfolio, and what its Health page flags' },
  { command: 'budgets', description: 'Suggested budgets from your last 3 months, for categories with none' },
] as const;
```

Edit 1 of 6 in `companion/src/index.ts` — replace:

```ts
import { auditMenuDeps, auditStatusKeyboard, createAuditMenu, type AuditMenu } from './audit-menu.js';
```

with:

```ts
import { auditMenuDeps, auditStatusKeyboard, createAuditMenu, type AuditMenu } from './audit-menu.js';
import { companionBudgetReaders } from './budget-suggest-host.js';
import { budgetsMenuDeps, createBudgetsMenu, type BudgetsMenu } from './budgets-menu.js';
```

Edit 2 of 6 in `companion/src/index.ts` — replace:

```ts
export function buildAuditMenu(wfClient: WealthfolioClient): AuditMenu {
  return createAuditMenu(auditMenuDeps(companionAuditReaders(wfClient, wealthfolioDbPath()), log));
}
```

with:

```ts
export function buildAuditMenu(wfClient: WealthfolioClient): AuditMenu {
  return createAuditMenu(auditMenuDeps(companionAuditReaders(wfClient, wealthfolioDbPath()), log));
}

/**
 * `/budgets` (project 4): default monthly budgets suggested from the last 3
 * full months, for categories with none, applied over REST. Stateless — every
 * tap re-reads, and Apply re-reads the budget once more right before writing.
 */
export function buildBudgetsMenu(wfClient: WealthfolioClient): BudgetsMenu {
  return createBudgetsMenu(budgetsMenuDeps(companionBudgetReaders(wfClient, wealthfolioDbPath()), log));
}
```

Edit 3 of 6 in `companion/src/index.ts` — replace:

```ts
  audit: AuditMenu = buildAuditMenu(wfClient),
): (cmd: ParsedCommand, reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>) => Promise<void> {
```

with:

```ts
  audit: AuditMenu = buildAuditMenu(wfClient),
  budgets: BudgetsMenu = buildBudgetsMenu(wfClient),
): (cmd: ParsedCommand, reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>) => Promise<void> {
```

Edit 4 of 6 in `companion/src/index.ts` — replace:

```ts
      case 'audit':
        // 2c: checked live; "Couldn't reach Wealthfolio" is the answer when it can't be.
        await audit.reply(reply);
        return;

```

with:

```ts
      case 'audit':
        // 2c: checked live; "Couldn't reach Wealthfolio" is the answer when it can't be.
        await audit.reply(reply);
        return;

      case 'budgets':
        // Project 4: the suggestions, or why there are none to show.
        await budgets.reply(reply);
        return;

```

Edit 5 of 6 in `companion/src/index.ts` — replace:

```ts
  /** `/audit` (2c) and `/status`'s 🔎 buttons: stateless too. */
  const audit = buildAuditMenu(wfClient);
  /** ONE question slot for commands, plain answers and taps alike. */
  const asks = buildAskSessions(wfClient, categorize, why);
  const runCommand = buildTelegramCommandHandler(wfClient, categorize, asks, why, audit);
```

with:

```ts
  /** `/audit` (2c) and `/status`'s 🔎 buttons: stateless too. */
  const audit = buildAuditMenu(wfClient);
  /** `/budgets` (project 4): stateless too. */
  const budgets = buildBudgetsMenu(wfClient);
  /** ONE question slot for commands, plain answers and taps alike. */
  const asks = buildAskSessions(wfClient, categorize, why);
  const runCommand = buildTelegramCommandHandler(wfClient, categorize, asks, why, audit, budgets);
```

Edit 6 of 6 in `companion/src/index.ts` — replace:

```ts
      // `cz:au:` (2c) likewise: /audit and /status's 🔎 buttons.
      if (audit.handles(cb.data)) {
        await audit.onCallback(cb, ui);
        return;
      }
```

with:

```ts
      // `cz:au:` (2c) likewise: /audit and /status's 🔎 buttons.
      if (audit.handles(cb.data)) {
        await audit.onCallback(cb, ui);
        return;
      }
      // `cz:bg:` (project 4) likewise: /budgets.
      if (budgets.handles(cb.data)) {
        await budgets.onCallback(cb, ui);
        return;
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run src/index.test.ts src/budgets-menu.test.ts`
Expected: PASS — 312 tests.

Run: `npx vitest run shared/telegram-commands.test.ts`
Expected: PASS — 134 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/index.ts companion/src/index.test.ts shared/telegram-commands.ts shared/telegram-commands.test.ts
git commit -m "Getting started: /budgets wired in — More commands, cz:bg: routed before the transaction menu

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Docs, the forced-date run, every gate

The CHANGELOG under `[Unreleased]` (no version bump): the two additions under Added and the one snippet under Changed; the README's `/budgets`, the preview, and budget Undo from Telegram (the snippet itself landed in Task 1); `docs/superpowers/follow-ups.md` §14 — what this deliberately leaves open (Q7). Then every new and changed test file once more with the system date forced to 2027-01-01 through a throwaway setup file INSIDE the checkout, deleted after, and all four gates under `nice`.

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `docs/superpowers/follow-ups.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the docs**

Edit 1 of 2 in `CHANGELOG.md` — replace:

```markdown
    taken and when it is out of date or unreadable. Home's Accounts tile
    points at the checks when there is something to look at.

### Fixed
```

with:

```markdown
    taken and when it is out of date or unreadable. Home's Accounts tile
    points at the checks when there is something to look at.
- **Getting started.**
  - **Suggested budgets — `/budgets` in Telegram.** For each spending
    category with no budget, the average of the last 3 full months (every
    account, refunds netted out) rounded up to the nearest $5; categories
    under $10 a month, excluded categories and "Opening balances" are left
    out. Tap a category to leave it out, then **Apply all** or **Apply
    selected**: each becomes a default monthly budget in Wealthfolio. An
    existing budget is never overwritten — the budget is read again right
    before writing, and a category that gained one since is left alone and
    said so — and one that fails to save doesn't stop the rest. Each budget
    set is in the change log, and Undo (from `/changes`) deletes it. In the
    app, the budget card with no budgets says where to get some.
  - **A sample-data preview.** Before the companion has synced, the Budget
    board offers **Preview with sample data** — six months of made-up
    accounts and spending, under a "Sample data — not your money" banner,
    read-only — and setup's first step has **See what it looks like**.

### Fixed
```

Edit 2 of 2 in `CHANGELOG.md` — replace:

```markdown
- The companion reports a Wealthfolio HTTP 423 as a clear "profile is locked or
  there is more than one profile" error.
```

with:

```markdown
- The companion reports a Wealthfolio HTTP 423 as a clear "profile is locked or
  there is more than one profile" error.
- **One Docker Compose snippet.** Settings → Background sync (Docker), the
  README and `docker-compose.example.yml` now show the same service, written
  once: Wealthfolio's service name on a shared network (host networking as a
  comment), the password from a Compose secret file (an API key as the
  alternative) — never a password in the snippet — the database folder
  mounted read-only, `restart: unless-stopped`, and `TZ`. The card fills in
  your browser's timezone and has a Copy button. The card's old snippet used
  host networking and set no `TZ`; a working install needs no change.
```

Edit 1 of 3 in `README.md` — replace:

```markdown
  semester-pool burn-down, budget vs actual, top merchants, subscriptions & bills (remind, rename, hide, add by hand)),
  with more a tap away under **+ Add report**, or build your own.
```

with:

```markdown
  semester-pool burn-down, budget vs actual, top merchants, subscriptions & bills (remind, rename, hide, add by hand)),
  with more a tap away under **+ Add report**, or build your own. Until the
  companion has synced, **Preview with sample data** shows the board over
  made-up numbers, read-only (setup's first step has it too: **See what it
  looks like**).
```

Edit 2 of 3 in `README.md` — replace:

```markdown
  Health page flags — checked live on every tap; `/status` puts a 🔎 under
  each account that is off.
```

with:

```markdown
  Health page flags — checked live on every tap; `/status` puts a 🔎 under
  each account that is off. `/budgets` suggests a monthly budget for each
  category that has none — your average over the last 3 full months, rounded
  up to the nearest $5 — and sets the ones you pick in Wealthfolio, never
  over a budget you already have; Undo any of them from `/changes`.
```

Edit 3 of 3 in `README.md` — replace:

```markdown
  duplicate, take effect on the next sync — Sync now is right there. Category
  and rule changes are undone from Telegram's `/changes`.
```

with:

```markdown
  duplicate, take effect on the next sync — Sync now is right there. Category,
  rule and budget changes are undone from Telegram's `/changes`.
```

Edit 1 of 1 in `docs/superpowers/follow-ups.md` — replace:

```markdown
- **R2 (Fix) is next:** Link on a Health leg with a unique other half (the
  snapshot already carries both rows' ids, accounts, tx keys, amounts and
  dates), and "Remove for good…" on a transaction's story.

```

with:

```markdown
- **R2 (Fix) is next:** Link on a Health leg with a unique other half (the
  snapshot already carries both rows' ids, accounts, tx keys, amounts and
  dates), and "Remove for good…" on a transaction's story.

## 14. Getting started (2026-10-14, plan `2026-10-14-getting-started.md`)

Designed overnight under Nick's standing instruction; the spec and this plan
await his review, so the PR stays open.

- **Budgets are set from Telegram only.** The add-on SDK has no budget API;
  applying from the app needs one (or an upstream PR). Only `'default'`
  targets are suggested — never month-specific ones.
- **Re-read before write narrows the race; it cannot close it.** Wealthfolio's
  `POST /spending/budget/targets` is an upsert on (period, taxonomy, category)
  with no create-only form, so a budget added in the instant between the
  re-read and the POST would be overwritten. Undo then refuses (the amount
  differs), so nothing is silently lost twice.
- **The window is placed in Wealthfolio's timezone; rows are bucketed by their
  stored date,** as the cube and the digest read them. Wealthfolio's own budget
  actuals place a row by its local date, so a row stored at an east-of-UTC
  local midnight at a month's end (3.10) can count in the neighboring month.
- **An excluded CHILD category still counts in its parent's suggestion.** The
  spend matrix is keyed by the rolled-up parent name; only a top-level
  category that is excluded (or descends from one) is skipped.
- **At most 24 suggestions** (one `/budgets` button each, a 24-bit mask); past
  that, the smallest are left out.
- **The preview covers the Budget board only.** Home's other cards and the
  Reports tab keep their empty states; drill-down rows open no story.
- **The compose snippet does not fill in the add-on's id** (G1 named it): the
  companion reads no variable for it (`simplefin-sync` is fixed in the code).
  The password file must be readable by the container's `node` user.

```

- [ ] **Step 2: Run every new and changed test file with the date forced to 2027-01-01**

Nothing may depend on the real clock. A throwaway setup file fakes `Date` before every test; delete it afterwards — none of it is committed.

```sh
cat > zz-2027.setup.ts <<'EOF'
import { beforeEach, vi } from 'vitest';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-01-01T12:00:00Z')); });
EOF
cp zz-2027.setup.ts companion/zz-2027.setup.ts
cat > zz-2027.config.mts <<'EOF'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts', './zz-2027.setup.ts'] } });
EOF
cat > companion/zz-2027.config.mts <<'EOF'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true, setupFiles: ['./zz-2027.setup.ts'] } });
EOF
npx vitest run --config zz-2027.config.mts shared/compose-snippet.test.ts src/components/DockerSnippet.test.tsx shared/sample-cube.test.ts src/tabs/BudgetPreview.test.tsx src/pages/SetupPage.test.tsx src/components/budget/ReportView.test.tsx shared/budget-suggest.test.ts shared/change-budget.test.ts shared/change-entries.test.ts
(cd companion && npx vitest run --config zz-2027.config.mts src/wealthfolio-budget.test.ts src/budget-suggest-host.test.ts src/budgets-menu.test.ts src/change-undo-host.test.ts)
(cd companion && npx vitest run --config zz-2027.config.mts src/index.test.ts -t budgets)
rm zz-2027.setup.ts zz-2027.config.mts companion/zz-2027.setup.ts companion/zz-2027.config.mts
git status --short
```

Expected: PASS — 169 tests (root, 9 files), 41 tests (companion, 4 files), and 3 passed with 292 skipped (`index.test.ts`'s `/budgets` tests); `git status --short` lists only the three docs files from Step 1 — no `zz-2027` file is left. (`index.test.ts` as a whole is not run here: seven of its older dismissal tests compute a timestamp from the real clock at import and fail under a forced date on the base branch too — 7 failed, 285 passed at 57e9a42.)

- [ ] **Step 3: Run every gate**

Run: `nice npm test`
Expected: PASS — 2574 tests (104 files).

Run: `nice npm --prefix companion test`
Expected: PASS — 1158 tests (48 files).

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md docs/superpowers/follow-ups.md
git commit -m "Getting started: docs — the CHANGELOG, the README's /budgets and preview, follow-ups §14

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
