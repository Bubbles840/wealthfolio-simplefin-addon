# Audits without SSH — R1 Explain (2c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three read-only checks that used to need SSH and the `companion/tools` scripts — why an account's balance is off from the bank, why the month's spending differs from Wealthfolio's, and what Wealthfolio's Health page flags — in Telegram (`/audit`, live on every tap, and a 🔎 on `/status` under each account that is off) and in the app (an "off by" chip that opens why in place, "Why is this different from Wealthfolio?" on the Budget tab, and Settings → Checks), the app reading a snapshot the companion publishes after each sync.

**Architecture:** Four pure shared modules hold the checks both hosts use: `shared/audit-ledger.ts` (the ledger row both read, the cash-effect table), `shared/audit-balance.ts` (`explainBalances`: the bank against Wealthfolio per mapped account, the named causes and the remainder), `shared/audit-headline.ts` (`explainHeadline`: the report's spent against Wealthfolio's, `audit-headline.mjs`'s six reasons) and `shared/audit-health.ts` (`healthIssues`: Health's transfer legs, late starting balances, `$CASH` rows, and `fix-transfers.mjs`'s unique-both-ways matcher); `shared/audit-snapshot.ts` builds the `audit_snapshot` secret within 100 KB and reads it ok / absent / corrupt. Each module also builds the RAW lines both surfaces show. The companion gathers each fact on its own (`companion/src/audit-facts.ts`) through strict read-only database readers (`companion/src/sqlite-audit.ts`) and REST (`/valuations/latest`, `/spending/insight`, the secrets), publishes the snapshot after each sync beside the report cube, and serves `/audit` as a stateless `cz:au:` menu (`companion/src/audit-menu.ts`). The add-on reads the snapshot corrupt-aware (`SecretsStore.getAuditSnapshot`) and renders it as text (`src/components/AuditViews.tsx`).

**Tech Stack:** TypeScript, React (add-on), vitest (root project: jsdom, `src/` + `shared/`; companion project: node, `companion/src/`), Telegram Bot API (legacy `Markdown`), Wealthfolio REST and read-only SQLite (companion), add-on SDK 3.6.2 on Wealthfolio 3.8–3.10 (add-on).

**Spec:** `docs/superpowers/specs/2026-10-13-audits-without-ssh-design.md` (approved section by section 2026-10-13; commit 4d52312 on `feat/audits`, off main at merge 6cf2648). This plan is **R1 only**: sections A and B, and the parts of D that apply. R2 (section C, Fix) is a later plan; R1 does not block it — every Health leg carries both rows' ids, account ids, tx keys, amounts and dates. Rulings X1–X10 and the coordinator's Wealthfolio 3.8→3.10 facts are folded into the tasks below.

**Verified facts this plan builds on (X1):**
- **(a) `audit-headline.mjs` compares no two figures; the check compares SPENT.** The script sizes six differences in what each side counts as spending and leaves the comparison to a person: "Compare these against the gap between the report's "$X left this month" and Wealthfolio's budget card. The one whose size matches is the cause." (`companion/tools/audit-headline.mjs:171-175`). Its header gives the reason: Wealthfolio's "left" is `max(0, plan − spent)`, "the same shape as the report — so the gap is in WHAT each side counts" (`:8-13`). So both figures are SPENT figures: **the report's** is "Spent this month" — the cube's current month, categorized plus uncategorized (`monthlySpendTotals`, `shared/report-cube.ts:170`; the Budget tab's default headline stat, `shared/report-data.ts:370,411`); **Wealthfolio's** is its Spending page's `headline.spent` (`POST /api/v1/spending/insight`, `apps/server/src/api/spending.rs:824` at v3.8.0; `SpendingInsight.headline.spent`, `crates/spending/src/insight/model.rs:103`), asked for exactly as the page asks for "This month": the full calendar month in Wealthfolio's timezone, RFC 3339, both ends inclusive (`apps/frontend/src/features/spending/pages/spending-insights-page.tsx:274-287`, `lib/reports-period.ts:48-63`). The six reasons, as the script computes each (every query over ALL accounts, the report's own sign `SIGN` at `:64-76`, rows with a zero spend dropped at `:87`, bookkeeping = notes starting `Starting balance · `, `Balance adjustment · ` or `↔️ In-transit transfer · ` at `:77-79`): (1) dated the 1st at `T00:00:00`, not bookkeeping (`:109-113`); (2) `substr(date,1,10) > today` within the month, only for the current month (`:115-119`); (3) bookkeeping rows in the month (`:121-123`); (4) not bookkeeping, filed under a category in `spending.excluded_category_ids` (`:125-136`); (5) not bookkeeping, filed under more than one SPENDING category (`:138-146`); (6) not bookkeeping, spend < 0, no assignment at all (`:148-155`). Each reason's share of report − Wealthfolio is signed in `shared/audit-headline.ts`'s header (bookkeeping and refunds subtract; a double filing counts `filings − 1` times). The copy says what is really compared (Deviations).
- **(b) Balance causes.** Wealthfolio's figure is `/valuations/latest` for every account but a card (`RestSyncHost.latestValuations`, `companion/src/rest-host.ts:102`) and, for a card, the WHOLE ledger with pending rows (`getNativeAccountBalances`, `companion/src/sqlite-native.ts:341`, excludes pending rows and skips accounts holding a placeholder, so it is not reused; the audit sums the rows itself with the same sign table). `offCents = bank − Wealthfolio`, the sync's drift (`shared/sync-core.ts:2829`, `d = sfBalance − adjustedWfValuation − windowDelta`), in Wealthfolio's sign: cash positive, a card's debt negative — SimpleFin reports a card the same way (`shared/ledger-checks.ts:184` compares `c.ledger − c.bank` directly). The causes, each a set of rows one figure has and the other does not: **pending** (note ends ` · pending`); **after-bank-date** (dated after the UTC day of `account_balances.date`, SimpleFin's `balance-date`, `sync-core.ts:2956` — rows are dated by the same UTC day, `:2416`); **not-booked** — the drift formula's `assetBackedTransferOut` (`:2824-2828`): a TRANSFER_OUT carrying an asset, which the valuation never took out ("LEGACY-ONLY, deliberately kept … rows … exist in production"), non-card accounts only; `windowDelta` is left out: it is a heal run's prediction of its own creates and zero at rest (`:2789`); **held / unlinked** — the other half of a transfer from ANOTHER account that never arrived here, matched as the daily missing-leg check does (`companion/src/ledger-facts.ts:263-289`: one unlinked TRANSFER_IN/OUT, not a starting balance or correction, whose amount in the direction the money went equals exactly one account's remaining gap) without its 7-day alarm gate; a held in-transit placeholder is "held", a plain leg is "still unlinked" ("card payment" on a card). `unexplainedCents = offCents − Σ causes`. A cash account whose only gap is two pending charges shows `$38.20 in 2 pending transactions …` and **no** "not explained" line: a zero remainder is left out (Task 1, pinned).
- **(c) Health.** `audit-health.mjs` parts 1–3 (`:104-212`) and `fix-transfers.mjs`'s matcher (`:112-176`: same currency and amount to the cent, opposite direction — an OUT wants TRANSFER_IN/DEPOSIT/CREDIT, an IN wants TRANSFER_OUT/WITHDRAWAL — another account, POSTED, within `MATCH_DAYS = 5`, not in a valid pair, not the add-on's opening balance or correction, unique both ways, contested when another leg claims the same row) are ported over ONE database read. Wealthfolio's own Health source refines part 1 in two places the script misses: it reports legs only in ACTIVE, NOT ARCHIVED accounts (`crates/core/src/health/service.rs:277,779,790,803` at v3.8.0) and also flags a leg of a VALID pair that is marked external ("conflicting_external_marker", `:813-825`); both are ported. `ledger-facts.ts` has no reusable Health query (`unlinkedTransfers` is CASH-only and 60 days back, `missingLegs` needs the bank gaps, and neither validates a group or matches a counterpart), so nothing is duplicated; its missing-leg rule is reused in (b).
- **(d) No size limit on an add-on secret is known.** `apps/server/src/api/secrets.rs` (v3.8.0, `set_addon_secret` at `:65`) checks none and `apps/server` sets no `DefaultBodyLimit`, leaving axum's default 2 MB request body. The report cube keeps itself under its own `REPORT_CUBE_MAX_BYTES = 200_000` by trimming history (`shared/report-cube.ts:36`, `companion/src/report-cube-build.ts:311`). The snapshot's budget is `AUDIT_SNAPSHOT_MAX_BYTES = 100_000` UTF-8 bytes, kept by trimming row lists first; the worst case (40 accounts, six reasons × 2,000 rows, 1,000 Health legs, every string at its longest in two-byte characters) is 6,450,153 bytes untrimmed and 71,616 trimmed (5 rows a reason, 20 issues) — pinned in Task 4.
- **(e) `/status` has no keyboard today:** `case 'status': await reply(formatStatusReply(await readStatusReplyInput(wfClient), new Date()));` (`companion/src/index.ts:3347-3349`). Task 8 adds one 🔎 row per account the reply shows "off" (drift non-null and a mapped Wealthfolio id), opening that account's explanation as a NEW message; with none, the reply keeps its one-argument shape, so every existing `/status` test is unchanged.
- **(f) App anchors.** AccountList's "off by" chip is the `<span className="sfin-chip sfin-chip--off">` at `src/components/AccountList.tsx:116`, inside a row that is itself a `role="button"` opening the account. The Budget tab has NO "$X left": its headline card shows "Spent this month" by default (`DEFAULT_HEADLINE_IDS`, `shared/report-data.ts:370`) and "$X left this month" exists only in Telegram's daily report (`shared/telegram.ts:1243`); grid cards clip their bodies (`.sfin-budget-grid .sfin-report-body { overflow: hidden; mask-image … }`, `src/components/ui.tsx:701-705`), so the link sits under the Budget toolbar (`src/tabs/BudgetTab.tsx:689`), above the board the headline card leads. Settings' card ids are `CARD` (`src/tabs/SettingsTab.tsx:32-41`) and its order is Accounts | Budget: pool | Notifications | Sync: Auto-sync, Docker, Change log | Categorizing: Amazon, Rules; the Checks card goes right after Accounts. Home's Accounts tile is the button at `src/tabs/HomeTab.tsx:416-434`, opening `SETTINGS_CARD.accounts` (`:420`).
- **Wealthfolio 3.8 → 3.10 (the coordinator's analysis, re-checked at the tags).** Every REST route, DTO and column used here is the same on 3.8, 3.9 and 3.10. (1) `spending.excluded_category_ids` arrived in 3.9 (a8143e59e, `crates/spending/src/settings/model.rs:10,18` at v3.10.0): the Spending page drops a row whose spending allocation — split lines first, else its EARLIEST spending assignment by `created_at`, id (`activity_allocations.rs:39-84` at v3.8.0) — lands on an excluded category or any descendant (`crates/spending/src/category_exclusions.rs:1-120`); 3.8 has no setting. Wealthfolio's figure here is its own (`/spending/insight`), so it already reflects that; the "excluded" reason now names exactly those rows, descendants included. (2) From 3.10 a date-only value entered in Wealthfolio is stored at the LOCAL midnight, normalized to UTC (98d6afbb7; `activities_service.rs:1343-1356`, `storage-sqlite/src/activities/model.rs:510-517`: New York's Oct 1 is `2026-10-01T04:00:00+00:00`), while synced and legacy rows stay at UTC midnight; `substr(date,1,10)` still gives the day, and the first-midnight reason counts only rows stored at exactly 00:00 UTC. (3) Health in 3.10 also checks rejected, oversold and amountless activities and a stale projection (`crates/core/src/health/checks/data_consistency.rs:843,857,871`), which this port does not, so the empty state says what the ADD-ON checks for; a `$CASH` row cannot be created on 3.10 (#1798), so the copy calls them older rows; a card may carry a TRANSFER_OUT from 3.10 (#1796, ec509088c), which every check here treats as a leg like any other (R1 does not port `audit-health.mjs` part 4, where a card TRANSFER_OUT into an investing account is Saving); an unlinked leg marked external is fine in Health on every version (`TransferLinkState::External`, `crates/core/src/activities/transfer_pairs.rs:61,183-193`), so it is skipped; a blank `activity_type_override` is read as none (`COALESCE(NULLIF(TRIM(…),''), activity_type)`). (4) R2 may link through SDK 3.9's `activities.linkTransfer` or `linkPairByRecreate`; either needs only what each Health leg already carries.

**Deviations from the spec (decided, do not "fix"):**
- **A2 compares spent, not "$X left"** — (a). Copy: "The report counts $1,240.18 spent this month; Wealthfolio's Spending page counts $1,301.40." (one figure alone when the other could not be read); the `/audit` entry is **Spent vs Wealthfolio**, not '"$X left"'.
- **The Budget tab's link sits under its toolbar, not inside a card next to "$X left"** — (f): there is no "$X left" there, and a card would cut the explanation off. X2's "in ReportView" became BudgetTab for the same reason.
- **A1 names a fifth cause**, the drift formula's `assetBackedTransferOut`: "$40.00 in 1 transfer out that Wealthfolio never took out of this balance (it carries an asset)" — non-card accounts only. `windowDelta` is not a cause (b).
- **"pending charges" is "pending transactions"**: a pending deposit is pending too. A cause that pulls against the gap is shown with a minus ("-$20.00 in 1 pending transaction …") so the lines add up to "Off by". The header's parts are joined with " · ".
- **"held" and "still unlinked" name one leg at a time** (count 1), and only when exactly one account's remaining gap equals it; on an account that is not a card, "still unlinked" reads "transfer still unlinked". Anything less certain stays in "not explained by anything the add-on knows".
- **"Not explained" and every cause line are left out at $0.00**; an account that matches shows only "Matches the bank." and what it includes.
- **Health ports Wealthfolio's own account rule and its conflicting-marker check** beyond the script (c): "Linked, but marked as money moving in or out of Wealthfolio, which contradicts the pair." / "Unlink the two and link them again in Wealthfolio — linking clears the mark."
- **Health copy:** nothing found is "Nothing the add-on checks for: no incomplete transfers, late starting balances or $CASH rows." (spec: "Wealthfolio's Health page has nothing to flag." — 3.10's page checks more); `$CASH` is "Older Wealthfolio versions filed these under a $CASH asset. Clean-up needs the server tool fix-transfers.mjs." (spec: "Wealthfolio files these …"). Lines the spec did not spell out: "Not linked to its other half.", "Linked, but Wealthfolio won't accept the pair: <its group has N transfer rows | both rows move money the same way | both rows are in one account | a row carries an asset>.", "One of the add-on's own rows — the sync marks these so Health skips them.", "It could pair with more than one row — link the right two in Wealthfolio.", "No likely other half within 5 days — if it has one, link the two in Wealthfolio.", and the late start's title "<Account>'s starting balance is dated <Aug 2>, after its earliest transaction (<Jul 28>)".
- **The "excluded" reason is Wealthfolio's rule** (3.9+: earliest spending filing on an excluded category or a descendant; 3.8: none), not the script's (any filing on a raw id). **The first-midnight reason counts only rows stored at exactly 00:00 UTC.** Split lines, which the add-on never writes, are not modelled.
- **App copy the spec did not spell out:** "These checks arrive with the companion's next sync." (no snapshot yet, companion present); "As of the 2:00 PM sync." / "As of the Oct 12, 2:00 PM sync." (fresh, the viewer's own time); "These checks don't cover this account yet — they arrive with the companion's next sync."; the Checks card summary ("1 to look at", "Nothing found", "Health not checked", "Need the companion", "Arrive with the next sync", "Couldn't read"); Home's tile line "Checks: 1 to look at". A host read of the snapshot that fails reads as corrupt ("Couldn't read the checks — run /audit in Telegram."). **Home's Accounts tile opens Settings on the Checks card** when there is something to look at (on the Accounts card otherwise), instead of a second link inside the tile (a button cannot hold a button).
- **The snapshot carries `balanceNotes`** beside `{ v: 1, at, balances, headline, health }`: the balance check's notes belong to no one account.
- **`/audit` gives each reason and each Health issue a button** (`cz:au:r<handle>`, `cz:au:x<handle>`) opening its rows or its detail — R2 puts Link there. Telegram lists stop at 20 lines with "…and N more"; the app shows what the snapshot kept, with "and N more".
- **B1's return shapes grow:** `explainBalances` explains every mapped account (`explainBalance(facts, id)` for one); a balance's bank figure is ok / none / unread; `HeadlineExplanation` adds `month` and `unexplainedCents`; `HealthReport.issues` is null when Health was not checked. Account names are SimpleFin's (`account_names`), as `/status` and the app's list show them, else Wealthfolio's.

**Task order:** the pure checks — balance (1), the month (2), Health (3), the snapshot (4); the companion's facts and readers (5) and the publish after each sync (6); `/audit` (7) and its wiring with `/status`'s buttons (8); the app's store and views with the account chip (9) and its three ways in (10); docs, the forced-date run and every gate (11).

## Global Constraints

- **Read-only.** R1 writes nothing to the ledger. The one write is the companion's `audit_snapshot` secret, after each sync.
- **Raw text in shared code.** Bank and user text in every explanation and line builder is RAW. Telegram escapes it with `escapeMarkdown` and keeps it outside every `*…*`/`_…_` (the only entities are fixed headings); the app renders it as React text. Button labels are plain text and are not escaped.
- **Copy (verbatim; constants in the shared modules and `audit-menu.ts`/`AuditViews.tsx`):** `The bank hasn't sent a balance for this account.` · `Matches the bank.` · `not explained by anything the add-on knows` · `The report and Wealthfolio agree this month.` · `Nothing the add-on checks for: no incomplete transfers, late starting balances or $CASH rows.` · `Older Wealthfolio versions filed these under a $CASH asset. Clean-up needs the server tool fix-transfers.mjs.` · `A deep scan moves it to the day before your earliest transaction.` · `Likely the other half: <leg>` · `Couldn't read the checks — run /audit in Telegram.` · `These checks need the companion.` · `These checks arrive with the companion's next sync.` · `These checks are from <Oct 11> — the companion hasn't synced since.` · `As of the <2:00 PM> sync.` · `Why is this different from Wealthfolio?` · `Couldn't reach Wealthfolio — try again.` Each read's note is in `BALANCE_READ_NOTES`, `HEADLINE_READ_NOTES`, `HEALTH_READ_NOTES`. Every other string is spelled out in its task.
- **Telegram.** Legacy `Markdown`. Prefix `cz:au:` (`AUDIT_CALLBACK_PREFIX`, `companion/src/audit-menu.ts`), routed in `onMenuCallback` right after `cz:wy:` and before the categorize fallthrough; nothing else starts with `cz:au`. Stateless: every tap re-reads; accounts, reasons and issues travel as 8-hex `findingHandle`s. Every `callback_data` ≤ 64 bytes (the longest is 15). `/audit` joins `/help`'s More commands, NOT the seven-command ☰ menu. Glyphs: 🔎 ⬅️ ⚠️ only. The menu itself unreachable (the account mapping cannot be read): "Couldn't reach Wealthfolio — try again."
- **Snapshot.** `AUDIT_SNAPSHOT_SECRET_KEY = 'audit_snapshot'`, `AUDIT_SNAPSHOT_MAX_BYTES = 100_000` UTF-8 bytes, `AUDIT_STALE_MS` = 2 days. The companion is its ONLY writer: after each sync, after the report cube, best-effort — it never fails or changes a sync, writes nothing when Wealthfolio cannot be reached, and a failed write keeps the previous snapshot. Trim rows first ("and N more"). The add-on reads it ok / absent / corrupt.
- **Honesty.** Every read is wrapped on its own; a failure adds its note and leaves out only its own part — never "nothing wrong". "Not checked" stays distinct from "in sync" and from "nothing found". A counterpart two rows could be is never offered.
- **Wealthfolio 3.8–3.10.** Only tables, columns and routes all three share. A blank `activity_type_override` is none; a missing `spending.excluded_category_ids` is no exclusions.
- **App.** No emoji in app copy (`\p{Extended_Pictographic}`, which `↔` matches; `src/pages/copy-policy.test.tsx`). New CSS classes are `.sfin-audit-*`, each column-0 selector defined once (`src/components/theme-styles.test.ts`). Every new store read is optional-called.
- **Tests use a fixed `now`.** Shared and companion: fixed `Date`s and a `now` argument everywhere — nothing reads the clock. App: `now` props, or `vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(...)` with `vi.useRealTimers()` after; local `new Date(2026, 9, …)` for anything rendering a time. Every new test file also passes with the date forced to 2027-01-01 (Task 11).
- **Imports:** shared sources import siblings WITH `.js`; `src/` imports shared WITHOUT an extension; companion imports `'../../shared/x.js'` and `'./x.js'`.
- **Run the companion suite from `companion/`** (`cd companion && npx vitest run …`), never with `--root`.
- **Gates before calling a task done:** the touched project's tests, plus `npm run type-check` when `src/` or `shared/` changed and `npm --prefix companion run build` when `companion/` or `shared/` changed. Final task: `npm test`, `npm --prefix companion test`, `npm run type-check`, `npm --prefix companion run build`. On the Mac, run builds and full suites under `nice` — it overheats.
- **Edits are exact.** Every "replace" block below is copied from the file as it stands after the previous tasks (and the earlier edits of the same file in the same task) and occurs exactly once; replace it verbatim (the Edit tool's `old_string` → `new_string`). Apply a file's numbered edits in order. Every "Create" block is the whole file.
- **No version bump, tag or release.** CHANGELOG goes under `[Unreleased]`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A bank name full of Markdown characters** (`Joe's *Visa*_[1]`, `SQ *COFFEE_CLUB [2]`) in `/audit` and in `/status`'s button-bearing reply → escaped in the text and never inside an entity, raw on the button. Pinned in Task 7 (`escapes a bank name full of Markdown characters and keeps it out of every entity`; `puts a 🔎 under each account /status shows off, with its raw name`), Task 8 (`/status puts a 🔎 under each account that is off: the bank name escaped in the text, raw on the button`), Tasks 1–3 (`keeps bank text raw…`) and Task 9 (`renders bank text as text, and no emoji in any state`).
- **Each read failing on its own** → its note, the rest of the check intact, never "nothing wrong". Pinned in Task 1 (`a failed %s read says so and leaves out only its own part`, five reads), Task 2 (the same, four reads), Task 3 (`says Health was not checked without the database — never "nothing to flag"`; `still checks without the mapping…`), Task 5 (`a failed read of %s becomes its note and costs only its own part`, nine reads), Task 7 (`shows a failed read as its note, never as "nothing to flag"`) and Task 8 (`the 🔎 opens why that account is off as a new message, a failed read saying so`).
- **A stale snapshot, a corrupt one, and no companion** → "These checks are from Oct 13 — the companion hasn't synced since." (content still shown), "Couldn't read the checks — run /audit in Telegram." (no content), "These checks need the companion.". Pinned in Task 4 (`auditSnapshotStatus` tests; `is corrupt — never empty — when it cannot be read`), Task 9 (`says a stale snapshot is old, and a corrupt or missing one cannot be shown`) and Task 10 (`says so when the snapshot is %s`, through the page).
- **A counterpart that matches two rows** → not offered ("It could pair with more than one row…"), and neither is one two legs both want. Pinned in Task 3 (`does not offer a counterpart that two rows could be`; `does not offer a row two legs both want`).
- **The longest callback** → within 64 bytes; every `cz:au:` button is 7 or 15 bytes. Pinned in Task 7 (`keeps every button within 64 bytes — the longest is 15`).
- **A worst-case snapshot** → within 100 KB, trimmed rows first, each list saying how many it left out. Pinned in Task 4 (`keeps a worst case within budget by trimming rows first, saying how many it left out`).
- **Dates** → every test passes a fixed `now`; Task 11 runs every new test file with the date forced to 2027-01-01.
- **Two pending charges that are the whole gap** → no "$0.00 not explained" line. Pinned in Task 1 (`leaves the "not explained" line out when two pending charges are the whole gap`).
- **A tap routed by prefix** → `cz:au:` reaches the audit menu, not the transaction menu's "expired" answer. Pinned in Task 8 (`cz:au: taps reach the audit menu, not the transaction menu`).
- **A publish that fails** → the sync returns its result unchanged and logs it; an unreachable Wealthfolio writes nothing. Pinned in Task 6 (`logs a publish that fails and returns the sync’s result unchanged`) and Task 5 (`writes nothing when Wealthfolio cannot be reached, so the previous snapshot stays`).
- **A Wealthfolio 3.10 host** → a local-midnight row is not a first-midnight row, an excluded category's descendants are excluded, a blank override is none, a card's TRANSFER_OUT is a leg like any other. Pinned in Task 2 (`counts only a row stored at 00:00 UTC on the 1st, not one at a local midnight (3.10)`; `excludes what Wealthfolio excludes (3.9+)…`; `excludes nothing on Wealthfolio 3.8…`), Task 3 (`treats a card’s TRANSFER_OUT (Wealthfolio 3.10)…`) and Task 5 (`reads every account and every row, the override type for Health (a blank one is none)…`).

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/audit-ledger.ts` (create) | `AuditAccount`, `AuditLedgerRow`, `AuditLedger`; `cashEffectCents`; the note markers. A small file both balance and Health read. |
| `shared/audit-balance.ts` (create) | `explainBalances`/`explainBalance`, the causes and the remainder; the header, cause, includes and short lines. |
| `shared/audit-headline.ts` (create) | `explainHeadline`, `reportSpendSign`, `excludedWithDescendants`, `zonedMonthBounds`; the summary, reason, remainder and row lines. |
| `shared/audit-health.ts` (create) | `healthIssues`, `fix-transfers.mjs`'s matcher, `healthCount`; the titles and what-to-do lines. |
| `shared/audit-snapshot.ts` (create) | `AuditSnapshot`, `buildAuditSnapshot` (trim to 100 KB), `parseAuditSnapshot` (ok / absent / corrupt), `auditSnapshotStatus`, the secret key. |
| `companion/src/sqlite-audit.ts` (create) | The strict database reads: the ledger, the month's rows, the settings and category parents. A focused file beside `sqlite-native.ts` (~1,900 lines). |
| `companion/src/sqlite-native.ts` (modify) | Exports `queryNativeDbStrict`. |
| `companion/src/wealthfolio.ts` (modify) | `getSpendingInsightSpent` (`POST /spending/insight`). |
| `companion/src/audit-facts.ts` (create) | `AuditReaders`, each read wrapped on its own (`gather*Facts`), `runAudit`, `publishAuditSnapshot`. |
| `companion/src/audit-menu.ts` (create) | `/audit`: the `cz:au:` encoding, screens, `createAuditMenu`, `auditMenuDeps`, `auditStatusKeyboard`. A focused new file beside `why-menu.ts`. |
| `companion/src/index.ts` (modify) | The publish after each sync; `buildAuditMenu`; `/audit`; `cz:au:` routing; `/status`'s 🔎 buttons. |
| `shared/telegram-commands.ts` (modify) | `/audit` in More commands; `StatusReplyInput.accounts[].wfAccountId?`. |
| `src/utils/secrets.ts` (modify) | `getAuditSnapshot()`; the key in `KEYS` so Reset clears it. |
| `src/components/AuditViews.tsx` (create) | The views: `AccountAudit`, `HeadlineAuditLink`, `ChecksCard`, `AuditStatusLine`, `checksSummary`, `healthIssueCount`. |
| `src/components/AccountList.tsx`, `src/components/ui.tsx` (modify) | The "off by" chip as a button opening why in place; the `.sfin-audit-*` styles. |
| `src/pages/SyncPage.tsx`, `src/tabs/SettingsTab.tsx`, `src/tabs/BudgetTab.tsx`, `src/tabs/HomeTab.tsx` (modify) | Load the snapshot once; Settings → Checks and the chips; the Budget link; Home's tile. |
| `CHANGELOG.md`, `README.md`, `docs/superpowers/follow-ups.md` (modify) | Docs and follow-ups §11. |

---

### Task 1: Why a balance is off — the bank against Wealthfolio, named causes and the rest

The ledger row both checks read (`shared/audit-ledger.ts`) and the pure balance check (spec A1, B1; X1b). For each mapped account: the bank's figure and its date; Wealthfolio's (the valuation for every account but a card, a card's whole ledger with pending rows); `offCents = bank − Wealthfolio`; the causes — pending, after the bank's date, a transfer out the valuation never booked, and the other half of a transfer elsewhere (held / still unlinked, matched one leg at a time as the daily missing-leg check does) — and `unexplainedCents`, the rest. Also what the balance includes: the starting balance and the corrections. Each failed read is its own note; without the database nothing is explained (`causes: null`), never "nothing explains it". The lines are RAW.

**Files:**
- Create: `shared/audit-ledger.ts`, `shared/audit-balance.ts`, `shared/audit-balance.test.ts`

**Interfaces:**
- Consumes: `changeDay(iso)`, `changeMoney(cents)` (shared/change-entries.ts); `isTransferType`, `PENDING_SUFFIX`, `IN_TRANSIT_COMMENT_PREFIX`, `STARTING_BALANCE_COMMENT_PREFIX`, `BALANCE_ADJUSTMENT_COMMENT_PREFIX` (shared/sync-core.ts).
- Produces:

```ts
// shared/audit-ledger.ts
export interface AuditAccount { id: string; name: string; type: string; archived: boolean; active?: boolean }
export interface AuditLedgerRow {
  id: string; accountId: string; date: string; currency: string; rawType: string; type: string; status: string;
  absCents: number; group: string; assetId: string; external: boolean; phantomCash: boolean; notes: string;
}
export interface AuditLedger { accounts: AuditAccount[]; rows: AuditLedgerRow[] }
export function cashEffectCents(row: Pick<AuditLedgerRow, 'rawType' | 'absCents'>, accountType: string): number;
export const isPendingNote: (notes: string) => boolean;
export const isPlaceholderNote: (notes: string) => boolean;
export const isStartingBalanceNote: (notes: string) => boolean;
export const isCorrectionNote: (notes: string) => boolean;

// shared/audit-balance.ts
export type BalanceRead = 'mapping' | 'balances' | 'names' | 'valuations' | 'ledger';
export const BALANCE_READ_NOTES: Record<BalanceRead, string>;
export const BALANCE_NO_BANK: string;      // "The bank hasn't sent a balance for this account."
export const BALANCE_MATCHES: string;      // 'Matches the bank.'
export const BALANCE_NOT_EXPLAINED: string;
export interface BalanceFacts {
  mapping?: Record<string, string>;
  balances?: Record<string, { balance?: unknown; date?: unknown } | null | undefined>;
  names?: Record<string, string>;
  valuations?: Record<string, number>;   // cents, by Wealthfolio id
  ledger?: AuditLedger;
  failed?: BalanceRead[];
}
export type BankFigure = { kind: 'ok'; cents: number; date: string | null } | { kind: 'none' } | { kind: 'unread' };
export type BalanceCauseKind = 'pending' | 'after-bank-date' | 'held' | 'unlinked' | 'not-booked';
export interface BalanceCause { kind: BalanceCauseKind; cents: number; count: number }
export interface BalanceIncludes { start: { cents: number; date: string } | null; corrections: { count: number; cents: number; latest: string } | null }
export interface BalanceExplanation {
  wfAccountId: string; name: string; accountType: string; bank: BankFigure; wealthfolioCents: number | null;
  offCents: number | null; causes: BalanceCause[] | null; unexplainedCents: number | null; includes: BalanceIncludes | null;
}
export interface BalanceReport { accounts: BalanceExplanation[]; notes: string[] }
export function explainBalances(facts: BalanceFacts): BalanceReport;
export function explainBalance(facts: BalanceFacts, wfAccountId: string): BalanceExplanation | null;
export function balanceHeaderLine(e: BalanceExplanation): string;
export function balanceCauseLines(e: BalanceExplanation): string[];
export function balanceIncludesLine(e: BalanceExplanation): string | null;
export function balanceShort(e: BalanceExplanation): string;
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/audit-balance.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import {
  balanceCauseLines, balanceHeaderLine, balanceIncludesLine, balanceShort, explainBalance, explainBalances,
  BALANCE_MATCHES, BALANCE_NO_BANK, BALANCE_READ_NOTES, type BalanceFacts, type BalanceRead,
} from './audit-balance';
import { cashEffectCents, type AuditAccount, type AuditLedgerRow } from './audit-ledger';

/** SimpleFin's balance-date for a UTC day, at noon. */
const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`) / 1000;

const acct = (id: string, name: string, type = 'CASH'): AuditAccount => ({ id, name, type, archived: false });
let seq = 0;
const row = (over: Partial<AuditLedgerRow> = {}): AuditLedgerRow => {
  seq += 1;
  return {
    id: `act-${seq}`, accountId: 'wf-chk', date: '2026-10-01', currency: 'USD', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL',
    status: 'POSTED', absCents: 0, group: '', assetId: '', external: false, phantomCash: false, notes: `ROW · TRN-${seq}`,
    ...over,
  };
};

/** PNC Checking, the spec's example: two pending charges and $11.80 nobody can name. */
function pncFacts(): BalanceFacts {
  return {
    mapping: { 'sfin-chk': 'wf-chk' },
    balances: { 'sfin-chk': { balance: 2481.07, date: day('2026-10-13') } },
    names: { 'sfin-chk': 'PNC Checking' },
    valuations: { 'wf-chk': 243107 },
    ledger: {
      accounts: [acct('wf-chk', 'Checking (Wealthfolio)')],
      rows: [
        row({ rawType: 'DEPOSIT', absCents: 120400, date: '2026-08-02', notes: 'Starting balance · ACT-1' }),
        row({ rawType: 'DEPOSIT', absCents: 1240, date: '2026-09-30', notes: 'Balance adjustment · ACT-1 · 2026-09-30' }),
        row({ rawType: 'WITHDRAWAL', absCents: 1910, date: '2026-10-12', notes: 'COFFEE · TRN-7 · pending' }),
        row({ rawType: 'WITHDRAWAL', absCents: 1910, date: '2026-10-12', notes: 'LUNCH · TRN-8 · pending' }),
      ],
    },
  };
}

describe('cashEffectCents', () => {
  it('signs by type, with a card’s interest as a charge', () => {
    expect(cashEffectCents({ rawType: 'DEPOSIT', absCents: 500 }, 'CASH')).toBe(500);
    expect(cashEffectCents({ rawType: 'TRANSFER_OUT', absCents: 500 }, 'CASH')).toBe(-500);
    expect(cashEffectCents({ rawType: 'INTEREST', absCents: 500 }, 'CASH')).toBe(500);
    expect(cashEffectCents({ rawType: 'INTEREST', absCents: 500 }, 'CREDIT_CARD')).toBe(-500);
    expect(cashEffectCents({ rawType: 'SPLIT', absCents: 500 }, 'CASH')).toBe(0);
  });
});

describe('explainBalances', () => {
  it('explains the spec’s example: pending charges, a remainder nobody knows, what the balance includes', () => {
    const e = explainBalance(pncFacts(), 'wf-chk')!;
    expect(e.offCents).toBe(5000);
    expect(e.causes).toEqual([{ kind: 'pending', cents: 3820, count: 2 }]);
    expect(e.unexplainedCents).toBe(1180);
    expect(balanceHeaderLine(e)).toBe('Bank: $2,481.07 (Oct 13) · Wealthfolio: $2,431.07 · Off by $50.00');
    expect(balanceCauseLines(e)).toEqual([
      "$38.20 in 2 pending transactions the bank hasn't posted",
      '$11.80 not explained by anything the add-on knows',
    ]);
    expect(balanceIncludesLine(e)).toBe('Includes: starting balance $1,204.00 (Aug 2) · 1 correction, +$12.40 (Sep 30)');
    expect(balanceShort(e)).toBe('off by $50.00');
  });

  it('leaves the "not explained" line out when two pending charges are the whole gap', () => {
    const facts = pncFacts();
    facts.valuations = { 'wf-chk': 244287 };
    const e = explainBalance(facts, 'wf-chk')!;
    expect(e.offCents).toBe(3820);
    expect(e.unexplainedCents).toBe(0);
    expect(balanceCauseLines(e)).toEqual(["$38.20 in 2 pending transactions the bank hasn't posted"]);
  });

  it('reads a card from its whole ledger, pending included, in the bank’s sign (debt is negative)', () => {
    const e = explainBalances({
      mapping: { 'sfin-card': 'wf-card' },
      balances: { 'sfin-card': { balance: -500, date: day('2026-10-13') } },
      names: { 'sfin-card': 'Discover It' },
      ledger: {
        accounts: [acct('wf-card', 'Discover', 'CREDIT_CARD')],
        rows: [
          row({ accountId: 'wf-card', rawType: 'WITHDRAWAL', absCents: 48000, date: '2026-09-01', notes: 'Starting balance · ACT-2' }),
          row({ accountId: 'wf-card', rawType: 'WITHDRAWAL', absCents: 2000, date: '2026-10-05' }),
          row({ accountId: 'wf-card', rawType: 'INTEREST', absCents: 0, date: '2026-10-06' }),
          row({ accountId: 'wf-card', rawType: 'WITHDRAWAL', absCents: 1500, date: '2026-10-12', notes: 'GAS · TRN-40 · pending' }),
        ],
      },
    }).accounts[0];
    expect(e.wealthfolioCents).toBe(-51500);
    expect(e.offCents).toBe(1500);
    expect(e.causes).toEqual([{ kind: 'pending', cents: 1500, count: 1 }]);
    expect(e.unexplainedCents).toBe(0);
    expect(balanceHeaderLine(e)).toBe('Bank: -$500.00 (Oct 13) · Wealthfolio: -$515.00 · Off by $15.00');
    expect(balanceIncludesLine(e)).toBe('Includes: starting balance -$480.00 (Sep 1)');
  });

  it('names rows dated after the bank’s balance date', () => {
    const e = explainBalances({
      mapping: { 'sfin-chk': 'wf-chk' },
      balances: { 'sfin-chk': { balance: 100, date: day('2026-10-10') } },
      valuations: { 'wf-chk': 7500 },
      ledger: { accounts: [acct('wf-chk', 'Checking')], rows: [row({ absCents: 2500, date: '2026-10-12' }), row({ absCents: 900, date: '2026-10-10' })] },
    }).accounts[0];
    expect(e.causes).toEqual([{ kind: 'after-bank-date', cents: 2500, count: 1 }]);
    expect(balanceCauseLines(e)).toEqual(["$25.00 in 1 transaction newer than the bank's figure, which is from Oct 10"]);
  });

  it('names a transfer out carrying an asset, which the valuation never took out (the sync’s assetBackedTransferOut)', () => {
    const e = explainBalances({
      mapping: { 'sfin-chk': 'wf-chk' },
      balances: { 'sfin-chk': { balance: 60, date: day('2026-10-13') } },
      valuations: { 'wf-chk': 10000 },
      ledger: { accounts: [acct('wf-chk', 'Checking')], rows: [row({ rawType: 'TRANSFER_OUT', absCents: 4000, assetId: '$CASH', date: '2026-07-01' })] },
    }).accounts[0];
    expect(e.offCents).toBe(-4000);
    expect(e.causes).toEqual([{ kind: 'not-booked', cents: -4000, count: 1 }]);
    expect(e.unexplainedCents).toBe(0);
    expect(balanceCauseLines(e)).toEqual(['$40.00 in 1 transfer out that Wealthfolio never took out of this balance (it carries an asset)']);
  });

  it('names a transfer held in another account waiting for its other half here', () => {
    const report = explainBalances({
      mapping: { 'sfin-spend': 'wf-spend', 'sfin-save': 'wf-save' },
      balances: {
        'sfin-spend': { balance: 1000, date: day('2026-10-13') },
        'sfin-save': { balance: 5000, date: day('2026-10-13') },
      },
      names: { 'sfin-spend': 'Spend', 'sfin-save': 'Savings' },
      valuations: { 'wf-spend': 100000, 'wf-save': 200000 },
      ledger: {
        accounts: [acct('wf-spend', 'Spend'), acct('wf-save', 'Savings')],
        rows: [row({ accountId: 'wf-spend', rawType: 'TRANSFER_OUT', absCents: 300000, date: '2026-08-10', notes: '↔️ In-transit transfer · ONLINE TRANSFER · TRN-9' })],
      },
    });
    const save = report.accounts.find((a) => a.wfAccountId === 'wf-save')!;
    expect(save.causes).toEqual([{ kind: 'held', cents: 300000, count: 1 }]);
    expect(save.unexplainedCents).toBe(0);
    expect(balanceCauseLines(save)).toEqual(['$3,000.00 in 1 transfer held waiting for its other half']);
    expect(report.accounts.find((a) => a.wfAccountId === 'wf-spend')!.offCents).toBe(0);
  });

  it('names a card payment still unlinked: it left checking and never reached the card', () => {
    const card = explainBalances({
      mapping: { 'sfin-chk': 'wf-chk', 'sfin-card': 'wf-card' },
      balances: { 'sfin-chk': { balance: 400, date: day('2026-10-13') }, 'sfin-card': { balance: -100, date: day('2026-10-13') } },
      valuations: { 'wf-chk': 40000 },
      ledger: {
        accounts: [acct('wf-chk', 'Checking'), acct('wf-card', 'Citi', 'CREDIT_CARD')],
        rows: [
          row({ accountId: 'wf-chk', rawType: 'TRANSFER_OUT', absCents: 60000, date: '2026-10-04', notes: 'CITI AUTOPAY · TRN-5' }),
          row({ accountId: 'wf-card', rawType: 'WITHDRAWAL', absCents: 70000, date: '2026-09-20' }),
        ],
      },
    }).accounts.find((a) => a.wfAccountId === 'wf-card')!;
    expect(card.offCents).toBe(60000);
    expect(card.causes).toEqual([{ kind: 'unlinked', cents: 60000, count: 1 }]);
    expect(balanceCauseLines(card)).toEqual(['$600.00 in 1 card payment still unlinked']);
  });

  it('names no other half when two accounts are off by the same amount', () => {
    const report = explainBalances({
      mapping: { 'sfin-a': 'wf-a', 'sfin-b': 'wf-b', 'sfin-c': 'wf-c' },
      balances: { 'sfin-a': { balance: 600, date: null }, 'sfin-b': { balance: 600, date: null }, 'sfin-c': { balance: 0, date: null } },
      valuations: { 'wf-a': 0, 'wf-b': 0, 'wf-c': 0 },
      ledger: {
        accounts: [acct('wf-a', 'A'), acct('wf-b', 'B'), acct('wf-c', 'C')],
        rows: [row({ accountId: 'wf-c', rawType: 'TRANSFER_OUT', absCents: 60000, notes: 'TO SAVINGS · TRN-6' })],
      },
    });
    for (const id of ['wf-a', 'wf-b']) {
      const e = report.accounts.find((a) => a.wfAccountId === id)!;
      expect(e.causes).toEqual([]);
      expect(e.unexplainedCents).toBe(60000);
    }
  });

  it('shows a cause that pulls against the gap with a minus, so the lines still add up', () => {
    const e = explainBalances({
      mapping: { 'sfin-chk': 'wf-chk' },
      balances: { 'sfin-chk': { balance: 110, date: day('2026-10-13') } },
      valuations: { 'wf-chk': 10000 },
      ledger: { accounts: [acct('wf-chk', 'Checking')], rows: [row({ rawType: 'DEPOSIT', absCents: 2000, notes: 'REFUND · TRN-3 · pending' })] },
    }).accounts[0];
    expect(e.offCents).toBe(1000);
    expect(e.causes).toEqual([{ kind: 'pending', cents: -2000, count: 1 }]);
    expect(balanceCauseLines(e)).toEqual([
      "-$20.00 in 1 pending transaction the bank hasn't posted",
      '$30.00 not explained by anything the add-on knows',
    ]);
  });

  it('says "Matches the bank." and lists nothing when the two agree', () => {
    const facts = pncFacts();
    facts.valuations = { 'wf-chk': 248107 };
    const e = explainBalance(facts, 'wf-chk')!;
    expect(balanceHeaderLine(e)).toBe(`Bank: $2,481.07 (Oct 13) · Wealthfolio: $2,481.07 · ${BALANCE_MATCHES}`);
    expect(balanceCauseLines(e)).toEqual([]);
    expect(balanceShort(e)).toBe('matches');
  });

  it('says the bank has not sent a balance, and lists only mapped accounts in mapping order', () => {
    const report = explainBalances({
      mapping: { 'sfin-b': 'wf-b', 'sfin-a': 'wf-a', 'sfin-gone': '' },
      balances: { 'sfin-a': { balance: null, date: null }, 'sfin-b': { balance: 1, date: null } },
      valuations: { 'wf-a': 0, 'wf-b': 100 },
      ledger: { accounts: [acct('wf-a', 'A'), acct('wf-b', 'B'), acct('wf-x', 'Not mapped')], rows: [] },
    });
    expect(report.accounts.map((a) => a.wfAccountId)).toEqual(['wf-b', 'wf-a']);
    const a = report.accounts[1];
    expect(balanceHeaderLine(a)).toBe(BALANCE_NO_BANK);
    expect(balanceShort(a)).toBe('no bank balance');
    expect(balanceHeaderLine(report.accounts[0])).toBe(`Bank: $1.00 · Wealthfolio: $1.00 · ${BALANCE_MATCHES}`);
  });

  it('keeps bank text raw — escaping is the renderer’s job', () => {
    const facts = pncFacts();
    facts.names = { 'sfin-chk': "Joe's *Visa*_[1]" };
    expect(explainBalance(facts, 'wf-chk')!.name).toBe("Joe's *Visa*_[1]");
  });

  it.each<BalanceRead>(['mapping', 'balances', 'names', 'valuations', 'ledger'])('a failed %s read says so and leaves out only its own part', (read) => {
    const facts = pncFacts();
    if (read === 'mapping') delete facts.mapping;
    if (read === 'balances') delete facts.balances;
    if (read === 'names') delete facts.names;
    if (read === 'valuations') delete facts.valuations;
    if (read === 'ledger') delete facts.ledger;
    facts.failed = [read];
    const report = explainBalances(facts);
    expect(report.notes).toEqual([BALANCE_READ_NOTES[read]]);
    if (read === 'mapping') return void expect(report.accounts).toEqual([]);
    const e = report.accounts[0];
    if (read === 'balances') {
      expect(e.bank).toEqual({ kind: 'unread' });
      expect(balanceHeaderLine(e)).toBe('Bank: — · Wealthfolio: $2,431.07');
      expect(e.causes).toEqual([{ kind: 'pending', cents: 3820, count: 2 }]);
      expect(e.unexplainedCents).toBeNull();
    }
    if (read === 'names') expect(e.name).toBe('Checking (Wealthfolio)');
    if (read === 'valuations') {
      expect(e.wealthfolioCents).toBeNull();
      expect(balanceShort(e)).toBe('not compared');
      expect(balanceCauseLines(e)).toEqual([]);
    }
    if (read === 'ledger') {
      // Never "nothing explains it": the reasons were not looked for.
      expect(e.causes).toBeNull();
      expect(e.unexplainedCents).toBeNull();
      expect(e.offCents).toBe(5000);
      expect(balanceCauseLines(e)).toEqual([]);
      expect(e.name).toBe('PNC Checking');
    }
  });

  it('reads no card without the database', () => {
    const e = explainBalances({
      mapping: { 'sfin-card': 'wf-card' },
      balances: { 'sfin-card': { balance: -10, date: null } },
      valuations: {},
      failed: ['ledger'],
    }).accounts[0];
    expect(e.wealthfolioCents).toBeNull();
    expect(e.offCents).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/audit-balance.test.ts`
Expected: FAIL — `Failed to resolve import "./audit-balance"`; no tests run.

- [ ] **Step 3: Implement**

**Create `shared/audit-ledger.ts`:**

```ts
/**
 * shared/audit-ledger.ts
 *
 * The ledger as the audits read it (2c): one row per Wealthfolio activity,
 * read by the companion straight from the database (companion/src/
 * sqlite-audit.ts) and judged here and in audit-balance.ts and
 * audit-health.ts. Pure.
 *
 * Two activity types on purpose. `rawType` is what moves cash — every
 * balance figure in this project signs by it (getNativeAccountBalances,
 * ledger-facts' CASH_EFFECT, the audit scripts). `type` is
 * `activity_type_override ?? activity_type`, which is what Wealthfolio's
 * Health page reads (companion/tools/audit-health.mjs part 1).
 */
import {
  BALANCE_ADJUSTMENT_COMMENT_PREFIX, IN_TRANSIT_COMMENT_PREFIX, PENDING_SUFFIX, STARTING_BALANCE_COMMENT_PREFIX,
} from './sync-core.js';

/** One Wealthfolio account. */
export interface AuditAccount {
  id: string;
  name: string;
  /** Upper-case: 'CASH', 'CREDIT_CARD', … ('' when unset). */
  type: string;
  archived: boolean;
  /** `is_active`; absent reads as active. Wealthfolio's Health looks only at
   *  active accounts that are not archived. */
  active?: boolean;
}

/** One activity. */
export interface AuditLedgerRow {
  id: string;
  accountId: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Upper-case. */
  currency: string;
  /** `activity_type`, upper-case: what moves cash. */
  rawType: string;
  /** `activity_type_override ?? activity_type`, upper-case: what Health reads. */
  type: string;
  /** Upper-case; 'POSTED' when unset. */
  status: string;
  absCents: number;
  /** `source_group_id`, '' when none. */
  group: string;
  /** `asset_id`, '' when none. */
  assetId: string;
  /** `metadata.flow.is_external` is JSON true. */
  external: boolean;
  /** `asset_id` names the phantom `$CASH` security. */
  phantomCash: boolean;
  /** The stored note, raw. */
  notes: string;
}

export interface AuditLedger {
  accounts: AuditAccount[];
  rows: AuditLedgerRow[];
}

const PLUS = new Set(['DEPOSIT', 'CREDIT', 'TRANSFER_IN', 'DIVIDEND', 'INTEREST', 'SELL']);
const MINUS = new Set(['WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX', 'BUY']);

/**
 * The row's signed effect on its account's cash, in cents: Wealthfolio 3.8's
 * `type_directed_cash_effect` with its one account-dependent exception (card
 * interest is a charge), the same table as getNativeAccountBalances.
 */
export function cashEffectCents(row: Pick<AuditLedgerRow, 'rawType' | 'absCents'>, accountType: string): number {
  if (accountType === 'CREDIT_CARD' && row.rawType === 'INTEREST') return -row.absCents;
  if (PLUS.has(row.rawType)) return row.absCents;
  if (MINUS.has(row.rawType)) return -row.absCents;
  return 0;
}

export const isPendingNote = (notes: string): boolean => notes.endsWith(PENDING_SUFFIX);
export const isPlaceholderNote = (notes: string): boolean => notes.startsWith(IN_TRANSIT_COMMENT_PREFIX);
export const isStartingBalanceNote = (notes: string): boolean => notes.startsWith(STARTING_BALANCE_COMMENT_PREFIX);
export const isCorrectionNote = (notes: string): boolean => notes.startsWith(BALANCE_ADJUSTMENT_COMMENT_PREFIX);
```

**Create `shared/audit-balance.ts`:**

```ts
/**
 * shared/audit-balance.ts
 *
 * "Why is this account off from the bank?" (2c R1, spec A1). Pure: the
 * companion gathers the facts (companion/src/audit-facts.ts); Telegram's
 * `/audit` and the app render the lines built here.
 *
 * Every amount is in cents, in Wealthfolio's sign: money in a cash account is
 * positive and a card's debt is negative, which is also how SimpleFin reports
 * a card's balance.
 *
 *  - The bank's figure is SimpleFin's posted balance (`account_balances`).
 *  - Wealthfolio's figure is `/valuations/latest` for every account but a
 *    card, and for a card the WHOLE ledger, pending rows included — what the
 *    card's page in Wealthfolio adds up to (getNativeAccountBalances leaves
 *    pending rows out; here they are a cause of their own).
 *  - offCents = bank − Wealthfolio: the sync's drift (shared/sync-core.ts,
 *    `d = sfBalance − adjustedWfValuation`).
 *  - A cause's cents is its share of offCents, so
 *    unexplainedCents = offCents − Σ causes. A cause whose sign differs from
 *    the gap's pulls the other way and is shown with a minus.
 *
 * The causes, each a set of rows the two figures disagree about:
 *  - pending: in Wealthfolio, not yet in the bank's posted balance;
 *  - after-bank-date: dated after the bank's balance date, so newer than the
 *    bank's figure;
 *  - not-booked: a TRANSFER_OUT carrying an asset, which Wealthfolio's
 *    valuation never takes out of the cash (the sync subtracts these too:
 *    `assetBackedTransferOut`) — non-card accounts only;
 *  - held / unlinked: the other half of a transfer that left (or reached)
 *    ANOTHER account and never arrived here — a held in-transit placeholder,
 *    or a plain unlinked transfer leg ("a card payment still unlinked" on a
 *    card). Matched as companion/src/ledger-facts.ts matches a missing leg:
 *    the leg's amount, in the direction the money went, equals what is left
 *    of exactly one account's gap, and only one such leg points at it.
 */
import { changeDay, changeMoney } from './change-entries.js';
import { isTransferType } from './sync-core.js';
import {
  cashEffectCents, isCorrectionNote, isPendingNote, isPlaceholderNote, isStartingBalanceNote,
  type AuditLedger, type AuditLedgerRow,
} from './audit-ledger.js';

export type BalanceRead = 'mapping' | 'balances' | 'names' | 'valuations' | 'ledger';

/** One note per failed read, in this order. */
export const BALANCE_READ_NOTES: Record<BalanceRead, string> = {
  mapping: "Couldn't read which accounts are mapped.",
  balances: "Couldn't read the bank balances.",
  names: "Couldn't read the account names — showing Wealthfolio's.",
  valuations: "Couldn't read Wealthfolio's balances, so cash accounts aren't compared.",
  ledger: "Couldn't read the Wealthfolio database, so cards aren't compared and nothing is explained.",
};
const READ_ORDER: BalanceRead[] = ['mapping', 'balances', 'names', 'valuations', 'ledger'];

export const BALANCE_NO_BANK = "The bank hasn't sent a balance for this account.";
export const BALANCE_MATCHES = 'Matches the bank.';
export const BALANCE_NOT_EXPLAINED = 'not explained by anything the add-on knows';

export interface BalanceFacts {
  /** account_mapping: SimpleFin account id → Wealthfolio account id. */
  mapping?: Record<string, string>;
  /** account_balances as stored, by SimpleFin account id. */
  balances?: Record<string, { balance?: unknown; date?: unknown } | null | undefined>;
  /** account_names: SimpleFin account id → name. */
  names?: Record<string, string>;
  /** `/valuations/latest`, in cents, by Wealthfolio account id. */
  valuations?: Record<string, number>;
  ledger?: AuditLedger;
  /** Reads that failed; each leaves out only its own part. */
  failed?: BalanceRead[];
}

export type BankFigure =
  /** `date`: the bank's balance date as YYYY-MM-DD (UTC, like every stored
   *  row date); null when SimpleFin sent none. */
  | { kind: 'ok'; cents: number; date: string | null }
  /** SimpleFin sent no numeric balance. */
  | { kind: 'none' }
  /** account_balances could not be read. */
  | { kind: 'unread' };

export type BalanceCauseKind = 'pending' | 'after-bank-date' | 'held' | 'unlinked' | 'not-booked';
export interface BalanceCause { kind: BalanceCauseKind; cents: number; count: number }

export interface BalanceIncludes {
  start: { cents: number; date: string } | null;
  corrections: { count: number; cents: number; latest: string } | null;
}

export interface BalanceExplanation {
  wfAccountId: string;
  /** Raw: escaped by Telegram, rendered as text by the app. */
  name: string;
  /** Upper-case; '' when the database could not say. */
  accountType: string;
  bank: BankFigure;
  /** null: Wealthfolio's figure could not be read. */
  wealthfolioCents: number | null;
  /** bank − Wealthfolio; null when either is unknown. */
  offCents: number | null;
  /** null: the database could not be read, so nothing is explained. */
  causes: BalanceCause[] | null;
  /** null when offCents or causes is. */
  unexplainedCents: number | null;
  includes: BalanceIncludes | null;
}

export interface BalanceReport {
  /** Mapped accounts, in mapping order. */
  accounts: BalanceExplanation[];
  notes: string[];
}

function bankFigure(facts: BalanceFacts, sfinId: string): BankFigure {
  if (!facts.balances) return { kind: 'unread' };
  const snap = facts.balances[sfinId];
  if (!snap || typeof snap.balance !== 'number' || !Number.isFinite(snap.balance)) return { kind: 'none' };
  const date = typeof snap.date === 'number' && snap.date > 0 ? new Date(snap.date * 1000).toISOString().slice(0, 10) : null;
  return { kind: 'ok', cents: Math.round(snap.balance * 100), date };
}

interface Draft { e: BalanceExplanation; residual: number | null }

function draft(sfinId: string, wfId: string, facts: BalanceFacts, rows: AuditLedgerRow[]): Draft {
  const account = facts.ledger?.accounts.find((a) => a.id === wfId);
  const accountType = account?.type ?? '';
  const isCard = accountType === 'CREDIT_CARD';
  const name = facts.names?.[sfinId] || account?.name || sfinId;
  const bank = bankFigure(facts, sfinId);
  const wealthfolioCents = isCard
    ? (facts.ledger ? rows.reduce((sum, r) => sum + cashEffectCents(r, accountType), 0) : null)
    : (facts.valuations ? (facts.valuations[wfId] ?? null) : null);
  const offCents = bank.kind === 'ok' && wealthfolioCents !== null ? bank.cents - wealthfolioCents : null;
  const e: BalanceExplanation = {
    wfAccountId: wfId, name, accountType, bank, wealthfolioCents, offCents,
    causes: null, unexplainedCents: null, includes: null,
  };
  if (!facts.ledger) return { e, residual: null };

  const bankDay = bank.kind === 'ok' ? bank.date : null;
  const sum = { pending: { cents: 0, count: 0 }, after: { cents: 0, count: 0 }, notBooked: { cents: 0, count: 0 } };
  for (const r of rows) {
    const effect = cashEffectCents(r, accountType);
    // In neither figure: the valuation never booked it, and the bank has not
    // posted it (pending) or not yet counted it (after its date).
    const unbooked = !isCard && r.rawType === 'TRANSFER_OUT' && r.assetId !== '';
    if (isPendingNote(r.notes)) {
      if (!unbooked) { sum.pending.cents -= effect; sum.pending.count += 1; }
    } else if (bankDay !== null && r.date > bankDay) {
      if (!unbooked) { sum.after.cents -= effect; sum.after.count += 1; }
    } else if (unbooked) {
      sum.notBooked.cents += effect;
      sum.notBooked.count += 1;
    }
  }
  const causes: BalanceCause[] = [];
  if (sum.pending.cents !== 0) causes.push({ kind: 'pending', ...sum.pending });
  if (sum.after.cents !== 0) causes.push({ kind: 'after-bank-date', ...sum.after });
  if (sum.notBooked.cents !== 0) causes.push({ kind: 'not-booked', ...sum.notBooked });
  e.causes = causes;

  const starts = rows.filter((r) => isStartingBalanceNote(r.notes)).sort((a, b) => a.date.localeCompare(b.date));
  const fixes = rows.filter((r) => isCorrectionNote(r.notes));
  e.includes = {
    start: starts[0] ? { cents: cashEffectCents(starts[0], accountType), date: starts[0].date } : null,
    corrections: fixes.length === 0 ? null : {
      count: fixes.length,
      cents: fixes.reduce((s, r) => s + cashEffectCents(r, accountType), 0),
      latest: fixes.map((r) => r.date).sort().at(-1)!,
    },
  };
  const residual = offCents === null ? null : offCents - causes.reduce((s, c) => s + c.cents, 0);
  return { e, residual };
}

/** Every mapped account, explained. */
export function explainBalances(facts: BalanceFacts): BalanceReport {
  const failed = new Set(facts.failed ?? []);
  const notes = READ_ORDER.filter((r) => failed.has(r)).map((r) => BALANCE_READ_NOTES[r]);
  if (!facts.mapping) return { accounts: [], notes };

  const rowsByAccount = new Map<string, AuditLedgerRow[]>();
  for (const r of facts.ledger?.rows ?? []) {
    const list = rowsByAccount.get(r.accountId) ?? [];
    list.push(r);
    rowsByAccount.set(r.accountId, list);
  }
  const drafts = Object.entries(facts.mapping)
    .filter(([, wfId]) => !!wfId)
    .map(([sfinId, wfId]) => draft(sfinId, wfId, facts, rowsByAccount.get(wfId) ?? []));

  // The other half of a transfer elsewhere: a leg that matches exactly one
  // account's remaining gap, and the only leg that matches it.
  const residuals = new Map(drafts.filter((d) => d.residual !== null && d.residual !== 0).map((d) => [d.e.wfAccountId, d.residual!]));
  const claimed = new Map<string, AuditLedgerRow[]>();
  for (const leg of facts.ledger?.rows ?? []) {
    if (!isTransferType(leg.rawType) || leg.group !== '' || isPendingNote(leg.notes)
      || isStartingBalanceNote(leg.notes) || isCorrectionNote(leg.notes)) continue;
    const want = leg.rawType === 'TRANSFER_OUT' ? leg.absCents : -leg.absCents;
    const hits = [...residuals].filter(([id, residual]) => id !== leg.accountId && residual === want);
    if (hits.length === 1) claimed.set(hits[0][0], [...(claimed.get(hits[0][0]) ?? []), leg]);
  }
  for (const d of drafts) {
    const legs = claimed.get(d.e.wfAccountId) ?? [];
    if (legs.length !== 1 || !d.e.causes) continue;
    const leg = legs[0];
    const cause: BalanceCause = {
      kind: isPlaceholderNote(leg.notes) ? 'held' : 'unlinked',
      cents: leg.rawType === 'TRANSFER_OUT' ? leg.absCents : -leg.absCents,
      count: 1,
    };
    const at = d.e.causes.findIndex((c) => c.kind === 'not-booked');
    d.e.causes.splice(at === -1 ? d.e.causes.length : at, 0, cause);
  }
  for (const d of drafts) {
    if (d.e.offCents !== null && d.e.causes) {
      d.e.unexplainedCents = d.e.offCents - d.e.causes.reduce((s, c) => s + c.cents, 0);
    }
  }
  return { accounts: drafts.map((d) => d.e), notes };
}

/** One account's explanation, or null when it is not mapped. */
export function explainBalance(facts: BalanceFacts, wfAccountId: string): BalanceExplanation | null {
  return explainBalances(facts).accounts.find((a) => a.wfAccountId === wfAccountId) ?? null;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const signed = (cents: number) => `${cents > 0 ? '+' : ''}${changeMoney(cents)}`;

/** "Bank: $2,481.07 (Oct 13) · Wealthfolio: $2,431.07 · Off by $50.00". Raw. */
export function balanceHeaderLine(e: BalanceExplanation): string {
  if (e.bank.kind === 'none') return BALANCE_NO_BANK;
  const bank = e.bank.kind === 'ok'
    ? `Bank: ${changeMoney(e.bank.cents)}${e.bank.date ? ` (${changeDay(e.bank.date)})` : ''}`
    : 'Bank: —';
  const wf = `Wealthfolio: ${e.wealthfolioCents === null ? '—' : changeMoney(e.wealthfolioCents)}`;
  const verdict = e.offCents === null ? null : e.offCents === 0 ? BALANCE_MATCHES : `Off by ${changeMoney(Math.abs(e.offCents))}`;
  return [bank, wf, verdict].filter((p): p is string => !!p).join(' · ');
}

function causePhrase(c: BalanceCause, e: BalanceExplanation): string {
  const n = c.count;
  switch (c.kind) {
    case 'pending':
      return `in ${n} pending ${plural(n, 'transaction', 'transactions')} the bank hasn't posted`;
    case 'after-bank-date': {
      const day = e.bank.kind === 'ok' && e.bank.date ? changeDay(e.bank.date) : '';
      return `in ${n} ${plural(n, 'transaction', 'transactions')} newer than the bank's figure, which is from ${day}`;
    }
    case 'held':
      return `in ${n} ${plural(n, 'transfer', 'transfers')} held waiting for ${plural(n, 'its', 'their')} other half`;
    case 'unlinked':
      return e.accountType === 'CREDIT_CARD'
        ? `in ${n} card ${plural(n, 'payment', 'payments')} still unlinked`
        : `in ${n} ${plural(n, 'transfer', 'transfers')} still unlinked`;
    case 'not-booked':
      return `in ${n} ${plural(n, 'transfer', 'transfers')} out that Wealthfolio never took out of this balance (${plural(n, 'it carries', 'they carry')} an asset)`;
  }
}

/** One line per cause, then what is left: shown only while the account is off. Raw. */
export function balanceCauseLines(e: BalanceExplanation): string[] {
  if (e.offCents === null || e.offCents === 0 || e.causes === null) return [];
  const off = e.offCents;
  const shown = (cents: number) => changeMoney(off < 0 ? -cents : cents);
  const lines = e.causes.map((c) => `${shown(c.cents)} ${causePhrase(c, e)}`);
  if (e.unexplainedCents) lines.push(`${shown(e.unexplainedCents)} ${BALANCE_NOT_EXPLAINED}`);
  return lines;
}

/** "Includes: starting balance $1,204.00 (Aug 2) · 1 correction, +$12.40 (Sep 30)", or null. Raw. */
export function balanceIncludesLine(e: BalanceExplanation): string | null {
  const inc = e.includes;
  if (!inc || (!inc.start && !inc.corrections)) return null;
  const parts: string[] = [];
  if (inc.start) parts.push(`starting balance ${changeMoney(inc.start.cents)} (${changeDay(inc.start.date)})`);
  if (inc.corrections) {
    const c = inc.corrections;
    parts.push(c.count === 1
      ? `1 correction, ${signed(c.cents)} (${changeDay(c.latest)})`
      : `${c.count} corrections, ${signed(c.cents)} (latest ${changeDay(c.latest)})`);
  }
  return `Includes: ${parts.join(' · ')}`;
}

/** The account's state in a few words, for a list: "off by $50.00". Raw. */
export function balanceShort(e: BalanceExplanation): string {
  if (e.bank.kind === 'none') return 'no bank balance';
  if (e.offCents === null) return 'not compared';
  return e.offCents === 0 ? 'matches' : `off by ${changeMoney(Math.abs(e.offCents))}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/audit-balance.test.ts`
Expected: PASS — 19 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/audit-ledger.ts shared/audit-balance.ts shared/audit-balance.test.ts
git commit -m "Audits: why a balance is off — the bank against Wealthfolio, named causes and the rest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Why the report's spending differs from Wealthfolio's — the script's six reasons

The pure month check (spec A2, B1; X1a). Two figures — the report's "Spent this month" and Wealthfolio's Spending page `headline.spent` — and `audit-headline.mjs`'s six reasons, each sized as its share of report − Wealthfolio with its rows (date, description, the row's spend, account), plus what none of them explains. Reasons with no rows are left out; when the two figures agree to the cent the check says so. Ported for Wealthfolio 3.8–3.10: the first-midnight reason counts only rows stored at exactly 00:00 UTC (3.10 stores a date entered in Wealthfolio at its local midnight), and the excluded reason is Wealthfolio's own rule from 3.9 — the earliest spending filing on an excluded category or any descendant (`excludedWithDescendants`, a transcription of `ExclusionIndex`); with no setting (3.8) nothing is excluded. `zonedMonthBounds` builds the window Wealthfolio's page asks for: the calendar month in its timezone, both ends inclusive.

**Files:**
- Create: `shared/audit-headline.ts`, `shared/audit-headline.test.ts`

**Interfaces:**
- Consumes: Task 1 (`isCorrectionNote`, `isPlaceholderNote`, `isStartingBalanceNote`); `changeDay`, `changeMoney` (shared/change-entries.ts); `descriptionFromComment` (shared/sync-core.ts).
- Produces:

```ts
// shared/audit-headline.ts
export type HeadlineRead = 'report' | 'wealthfolio' | 'ledger' | 'settings';
export const HEADLINE_READ_NOTES: Record<HeadlineRead, string>;
export const HEADLINE_AGREE: string;   // 'The report and Wealthfolio agree this month.'
export interface HeadlineDbRow {
  id: string; date: string /* as stored */; accountName: string; accountType: string; type: string; subtype: string;
  absCents: number; notes: string; spendingFilings: number; categoryIds: string[]; spendingCategoryId?: string | null;
}
export interface HeadlineFacts {
  month: string; today: string; reportCents?: number; wealthfolioCents?: number; rows?: HeadlineDbRow[];
  excludedCategoryIds?: string[]; categoryParents?: Record<string, string | null>; failed?: HeadlineRead[];
}
export type HeadlineReasonKind = 'first-midnight' | 'future' | 'bookkeeping' | 'excluded' | 'double-filed' | 'uncategorized-refund';
export const HEADLINE_REASON_KINDS: readonly HeadlineReasonKind[];
export interface HeadlineRow { date: string; description: string; cents: number; account: string }
export interface HeadlineReason { kind: HeadlineReasonKind; cents: number; rows: HeadlineRow[]; more?: number }
export interface HeadlineExplanation {
  month: string; reportCents: number | null; wealthfolioCents: number | null;
  reasons: HeadlineReason[] | null; unexplainedCents: number | null; notes: string[];
}
export function reportSpendSign(r: Pick<HeadlineDbRow, 'accountType' | 'type' | 'subtype'>): -1 | 0 | 1;
export function excludedWithDescendants(raw: readonly string[], parents: Readonly<Record<string, string | null>>): Set<string>;
export function explainHeadline(facts: HeadlineFacts): HeadlineExplanation;
export function headlineAgrees(h: HeadlineExplanation): boolean;
export function headlineSummaryLine(h: HeadlineExplanation): string | null;
export const HEADLINE_REASON_LABELS: Record<HeadlineReasonKind, string>;
export function headlineReasonLine(h: HeadlineExplanation, r: HeadlineReason): string;
export function headlineUnexplainedLine(h: HeadlineExplanation): string | null;
export function headlineRowLine(r: HeadlineRow): string;
export function zonedMonthBounds(month: string, timeZone: string | null): { start: string; end: string };
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/audit-headline.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import {
  explainHeadline, headlineAgrees, headlineReasonLine, headlineRowLine, headlineSummaryLine, headlineUnexplainedLine,
  reportSpendSign, zonedMonthBounds, HEADLINE_AGREE, HEADLINE_READ_NOTES,
  type HeadlineDbRow, type HeadlineFacts, type HeadlineRead,
} from './audit-headline';

let seq = 0;
const row = (over: Partial<HeadlineDbRow> = {}): HeadlineDbRow => {
  seq += 1;
  return {
    id: `act-${seq}`, date: '2026-10-05T00:00:00+00:00', accountName: 'PNC Checking', accountType: 'CASH',
    type: 'WITHDRAWAL', subtype: '', absCents: 1000, notes: `SHOP · TRN-${seq}`, spendingFilings: 1, categoryIds: ['cat-x'],
    ...over,
  };
};

/** One row for each of the script's six reasons, plus an ordinary purchase. */
function octoberFacts(): HeadlineFacts {
  return {
    month: '2026-10',
    today: '2026-10-13',
    reportCents: 130000,
    wealthfolioCents: 120000,
    excludedCategoryIds: ['cat-excluded'],
    rows: [
      row({ date: '2026-10-01T00:00:00+00:00', absCents: 2500, notes: 'RENT PORTAL · TRN-1' }),
      row({ date: '2026-10-20T00:00:00+00:00', absCents: 4000, notes: 'GYM · TRN-2' }),
      row({ type: 'TRANSFER_OUT', absCents: 600, categoryIds: [], notes: 'Balance adjustment · ACT-1 · 2026-10-02' }),
      row({ absCents: 1500, categoryIds: ['cat-excluded'], spendingCategoryId: 'cat-excluded', notes: 'TUITION · TRN-3' }),
      row({ absCents: 1200, spendingFilings: 2, categoryIds: ['cat-a', 'cat-b'], notes: 'SPLIT · TRN-4' }),
      row({ type: 'CREDIT', subtype: 'REFUND', absCents: 800, categoryIds: [], notes: 'RETURN · TRN-5' }),
      row({ absCents: 9999, notes: 'KROGER · TRN-6' }),
    ],
  };
}

describe('reportSpendSign', () => {
  it('is the report’s own sign: card credits refund, cash credits only with a refund subtype', () => {
    expect(reportSpendSign({ accountType: 'CREDIT_CARD', type: 'INTEREST', subtype: '' })).toBe(1);
    expect(reportSpendSign({ accountType: 'CREDIT_CARD', type: 'CREDIT', subtype: '' })).toBe(-1);
    expect(reportSpendSign({ accountType: 'CASH', type: 'TRANSFER_OUT', subtype: '' })).toBe(1);
    expect(reportSpendSign({ accountType: 'CASH', type: 'CREDIT', subtype: 'REIMBURSEMENT' })).toBe(-1);
    expect(reportSpendSign({ accountType: 'CASH', type: 'CREDIT', subtype: '' })).toBe(0);
    expect(reportSpendSign({ accountType: 'SECURITIES', type: 'WITHDRAWAL', subtype: '' })).toBe(0);
  });
});

describe('explainHeadline', () => {
  it('sizes each of the six reasons as its share of report − Wealthfolio', () => {
    const h = explainHeadline(octoberFacts());
    expect(h.reasons!.map((r) => [r.kind, r.cents, r.rows.length])).toEqual([
      ['first-midnight', 2500, 1],
      ['future', 4000, 1],
      ['bookkeeping', -600, 1],
      ['excluded', 1500, 1],
      ['double-filed', 1200, 1],
      ['uncategorized-refund', 800, 1],
    ]);
    // 1,300.00 − 1,200.00 − (25 + 40 − 6 + 15 + 12 + 8)
    expect(h.unexplainedCents).toBe(10000 - 9400);
    expect(h.reasons![0].rows[0]).toEqual({ date: '2026-10-01', description: 'RENT PORTAL', cents: 2500, account: 'PNC Checking' });
  });

  it('counts a row filed three times twice over, and keeps the sync’s own rows out of every other reason', () => {
    const h = explainHeadline({
      month: '2026-10', today: '2026-10-13', reportCents: 0, wealthfolioCents: 0, excludedCategoryIds: [],
      rows: [
        row({ absCents: 1000, spendingFilings: 3 }),
        row({ date: '2026-10-01T00:00:00+00:00', type: 'TRANSFER_OUT', absCents: 300, notes: '↔️ In-transit transfer · ZELLE · TRN-9' }),
      ],
    });
    expect(h.reasons!.map((r) => [r.kind, r.cents])).toEqual([['bookkeeping', -300], ['double-filed', 2000]]);
  });

  it('only finds rows dated after today in the current month', () => {
    const facts = octoberFacts();
    facts.today = '2026-11-02';
    expect(explainHeadline(facts).reasons!.map((r) => r.kind)).not.toContain('future');
  });

  it('says the two agree, and lists no reasons that have nothing in them', () => {
    const h = explainHeadline({ month: '2026-10', today: '2026-10-13', reportCents: 50000, wealthfolioCents: 50000, rows: [row()], excludedCategoryIds: [] });
    expect(headlineAgrees(h)).toBe(true);
    expect(h.reasons).toEqual([]);
    expect(HEADLINE_AGREE).toBe('The report and Wealthfolio agree this month.');
  });

  it('writes the lines: both figures, each reason, the rest, a row', () => {
    const h = explainHeadline(octoberFacts());
    expect(headlineSummaryLine(h)).toBe("The report counts $1,300.00 spent this month; Wealthfolio's Spending page counts $1,200.00.");
    expect(headlineReasonLine(h, h.reasons![0])).toBe("$25.00 — Dated the 1st at midnight UTC: Wealthfolio's month starts later west of UTC, so it counts these last month (1 row)");
    expect(headlineReasonLine(h, h.reasons![2])).toBe("-$6.00 — The add-on's own bookkeeping rows: Wealthfolio counts them; the report doesn't (1 row)");
    expect(headlineUnexplainedLine(h)).toBe('$6.00 not explained by these reasons');
    expect(headlineRowLine(h.reasons![5].rows[0])).toBe('Oct 5 · RETURN · -$8.00 · PNC Checking');
    expect(headlineReasonLine(h, { ...h.reasons![1], more: 4 })).toContain('(5 rows)');
  });

  it('shows the reasons against the gap’s direction when Wealthfolio counts more', () => {
    const facts = octoberFacts();
    facts.reportCents = 100000;
    facts.wealthfolioCents = 120000;
    const h = explainHeadline(facts);
    expect(headlineReasonLine(h, h.reasons![0]).startsWith('-$25.00 — ')).toBe(true);
    expect(headlineUnexplainedLine(h)).toBe('$294.00 not explained by these reasons');
  });

  it('keeps bank text raw', () => {
    const h = explainHeadline({
      month: '2026-10', today: '2026-10-13', excludedCategoryIds: [],
      rows: [row({ date: '2026-10-01T00:00:00+00:00', notes: 'SQ *COFFEE_CLUB [2] · TRN-1', accountName: "Joe's *Visa*" })],
    });
    expect(h.reasons![0].rows[0]).toMatchObject({ description: 'SQ *COFFEE_CLUB [2]', account: "Joe's *Visa*" });
  });

  it.each<HeadlineRead>(['report', 'wealthfolio', 'ledger', 'settings'])('a failed %s read says so and leaves out only its own part', (read) => {
    const facts = octoberFacts();
    if (read === 'report') delete facts.reportCents;
    if (read === 'wealthfolio') delete facts.wealthfolioCents;
    if (read === 'ledger') delete facts.rows;
    if (read === 'settings') delete facts.excludedCategoryIds;
    facts.failed = [read];
    const h = explainHeadline(facts);
    expect(h.notes).toEqual([HEADLINE_READ_NOTES[read]]);
    if (read === 'report') {
      expect(h.unexplainedCents).toBeNull();
      expect(headlineSummaryLine(h)).toBe("Wealthfolio's Spending page counts $1,200.00 spent this month.");
    }
    if (read === 'wealthfolio') expect(headlineSummaryLine(h)).toBe('The report counts $1,300.00 spent this month.');
    if (read === 'ledger') {
      // Never "nothing explains it": the reasons were not looked for.
      expect(h.reasons).toBeNull();
      expect(h.unexplainedCents).toBeNull();
      expect(headlineAgrees(h)).toBe(false);
    }
    if (read === 'settings') expect(h.reasons!.map((r) => r.kind)).not.toContain('excluded');
  });
});

describe('Wealthfolio 3.8 to 3.10', () => {
  it('counts only a row stored at 00:00 UTC on the 1st, not one at a local midnight (3.10)', () => {
    const h = explainHeadline({
      month: '2026-10', today: '2026-10-13', excludedCategoryIds: [],
      rows: [
        row({ id: 'utc', date: '2026-10-01T00:00:00+00:00' }),
        row({ id: 'utc-z', date: '2026-10-01T00:00:00Z' }),
        row({ id: 'ny', date: '2026-10-01T04:00:00+00:00' }),
        row({ id: 'offset', date: '2026-10-01T00:00:00-04:00' }),
      ],
    });
    expect(h.reasons).toEqual([{ kind: 'first-midnight', cents: 2000, rows: expect.any(Array) }]);
    expect(h.reasons![0].rows).toHaveLength(2);
  });

  it('excludes what Wealthfolio excludes (3.9+): the earliest spending filing, an excluded category or any descendant', () => {
    const h = explainHeadline({
      month: '2026-10', today: '2026-10-13', excludedCategoryIds: ['cat-edu', 'cat-gone'],
      categoryParents: { 'cat-edu': null, 'cat-books': 'cat-edu', 'cat-used-books': 'cat-books', 'cat-food': null, 'cat-loop-a': 'cat-loop-b', 'cat-loop-b': 'cat-loop-a' },
      rows: [
        row({ id: 'edu', absCents: 100, spendingCategoryId: 'cat-edu' }),
        row({ id: 'grandchild', absCents: 200, spendingCategoryId: 'cat-used-books' }),
        row({ id: 'deleted-category', absCents: 400, spendingCategoryId: 'cat-gone' }),
        row({ id: 'food', absCents: 800, spendingCategoryId: 'cat-food', categoryIds: ['cat-food', 'cat-edu'] }),
        row({ id: 'loop', absCents: 1600, spendingCategoryId: 'cat-loop-a' }),
      ],
    });
    expect(h.reasons).toMatchObject([{ kind: 'excluded', cents: 700 }]);
  });

  it('excludes nothing on Wealthfolio 3.8, which has no such setting', () => {
    const h = explainHeadline({
      month: '2026-10', today: '2026-10-13', excludedCategoryIds: [],
      rows: [row({ absCents: 100, spendingCategoryId: 'cat-edu' })],
    });
    expect(h.reasons).toEqual([]);
  });
});

describe('zonedMonthBounds', () => {
  it('is the calendar month in Wealthfolio’s timezone, as its Spending page asks for it', () => {
    expect(zonedMonthBounds('2026-10', 'America/New_York')).toEqual({ start: '2026-10-01T04:00:00.000Z', end: '2026-11-01T03:59:59.999Z' });
    expect(zonedMonthBounds('2027-01', 'America/Los_Angeles')).toEqual({ start: '2027-01-01T08:00:00.000Z', end: '2027-02-01T07:59:59.999Z' });
    expect(zonedMonthBounds('2026-10', 'UTC')).toEqual({ start: '2026-10-01T00:00:00.000Z', end: '2026-10-31T23:59:59.999Z' });
  });

  it('crosses a daylight-saving change inside the month', () => {
    expect(zonedMonthBounds('2026-03', 'America/New_York')).toEqual({ start: '2026-03-01T05:00:00.000Z', end: '2026-04-01T03:59:59.999Z' });
  });

  it('uses the process’s own zone with no setting, or one it does not know', () => {
    const local = { start: new Date(2026, 9, 1).toISOString(), end: new Date(2026, 9, 31, 23, 59, 59, 999).toISOString() };
    expect(zonedMonthBounds('2026-10', null)).toEqual(local);
    expect(zonedMonthBounds('2026-10', 'Mars/Olympus_Mons')).toEqual(local);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/audit-headline.test.ts`
Expected: FAIL — `Failed to resolve import "./audit-headline"`; no tests run.

- [ ] **Step 3: Implement**

**Create `shared/audit-headline.ts`:**

```ts
/**
 * shared/audit-headline.ts
 *
 * "Why is the report's spending different from Wealthfolio's?" (2c R1, spec
 * A2): companion/tools/audit-headline.mjs, judged here. Pure — the companion
 * reads the rows and both figures (companion/src/audit-facts.ts).
 *
 * WHAT IS COMPARED. The script itself compares no two figures: it sizes six
 * differences in what each side counts as spending and leaves a person to
 * match them against the gap between the daily report's "$X left this month"
 * and Wealthfolio's budget card. Both "left" figures are `plan − spent`, so
 * they differ exactly where the spent figures do. This check compares the two
 * SPENT figures:
 *  - the report's: "Spent this month" — the report cube's current month,
 *    categorized plus uncategorized (`monthlySpendTotals`), the Budget tab's
 *    headline number;
 *  - Wealthfolio's: its Spending page's `headline.spent` for this calendar
 *    month in Wealthfolio's timezone (`POST /spending/insight`, the request
 *    the page itself makes for "This month").
 *
 * Each reason's cents is its share of report − Wealthfolio, from the row's
 * spend in the report's own sign (SPENDING_SIGN, companion/src/
 * sqlite-native.ts; positive spends, negative refunds):
 *   first-midnight        +spend  stored at 00:00 UTC on the 1st: Wealthfolio, west of UTC, counts it last month
 *   future                +spend  dated after today: the report counts the whole month, Wealthfolio stops at today
 *   bookkeeping           −spend  the sync's own rows: Wealthfolio counts them, the report excludes them
 *   excluded              +spend  filed under a category Wealthfolio excludes from spending
 *   double-filed          +spend × (filings − 1)  the report counts every spending filing
 *   uncategorized-refund  −spend  a refund with no category: Wealthfolio nets it, the report ignores it
 * unexplainedCents = (report − Wealthfolio) − Σ reasons.
 *
 * Across Wealthfolio versions (3.8 to 3.10):
 *  - first-midnight: a date-only row is stored at UTC midnight on 3.8, and
 *    still is when the sync imports it; from 3.10 one entered in Wealthfolio
 *    west of UTC is stored at its LOCAL midnight (`2026-10-01T04:00:00+00:00`
 *    for New York), which both sides put in the same month. So only a row
 *    stored at exactly 00:00 UTC counts, whatever the rest of the ledger is.
 *  - excluded: `spending.excluded_category_ids` arrived in 3.9, where the
 *    Spending page drops a row whose spending allocation — its earliest
 *    spending filing — lands on an excluded category OR ANY DESCENDANT
 *    (crates/spending/src/category_exclusions.rs). With no setting (3.8)
 *    nothing is excluded and the reason is empty. Split lines, which the
 *    add-on never writes, are not modelled: their difference stays in the
 *    remainder.
 */
import { changeDay, changeMoney } from './change-entries.js';
import { descriptionFromComment } from './sync-core.js';
import { isCorrectionNote, isPlaceholderNote, isStartingBalanceNote } from './audit-ledger.js';

export type HeadlineRead = 'report' | 'wealthfolio' | 'ledger' | 'settings';
export const HEADLINE_READ_NOTES: Record<HeadlineRead, string> = {
  report: "Couldn't read the report's figure for this month.",
  wealthfolio: "Couldn't read Wealthfolio's Spending page figure.",
  ledger: "Couldn't read the Wealthfolio database, so the reasons are missing.",
  settings: "Couldn't read Wealthfolio's settings, so excluded categories aren't checked.",
};
const READ_ORDER: HeadlineRead[] = ['report', 'wealthfolio', 'ledger', 'settings'];

export const HEADLINE_AGREE = 'The report and Wealthfolio agree this month.';

/** One activity of the month, as companion/src/sqlite-audit.ts reads it. */
export interface HeadlineDbRow {
  id: string;
  /** `activity_date` as stored, e.g. `2026-10-01T00:00:00+00:00`. */
  date: string;
  accountName: string;
  /** Upper-case. */
  accountType: string;
  /** `activity_type`, upper-case. */
  type: string;
  /** Upper-case; '' when none. */
  subtype: string;
  absCents: number;
  notes: string;
  /** How many SPENDING categories it is filed under. */
  spendingFilings: number;
  /** Every category it is filed under, any taxonomy. */
  categoryIds: string[];
  /** Its earliest spending filing (by `created_at`, then id) — the one
   *  Wealthfolio allocates its spend to; absent or null when there is none. */
  spendingCategoryId?: string | null;
}

export interface HeadlineFacts {
  /** YYYY-MM. */
  month: string;
  /** YYYY-MM-DD, the companion's day (the script's TODAY). */
  today: string;
  /** The report's "Spent this month", cents. */
  reportCents?: number;
  /** Wealthfolio's Spending page `headline.spent`, cents. */
  wealthfolioCents?: number;
  /** The month's activities, every account. */
  rows?: HeadlineDbRow[];
  /** `spending.excluded_category_ids`; [] when unset (Wealthfolio 3.8). */
  excludedCategoryIds?: string[];
  /** Every spending category's parent (null at the top), so an excluded
   *  category's descendants are excluded too. */
  categoryParents?: Record<string, string | null>;
  failed?: HeadlineRead[];
}

export type HeadlineReasonKind =
  | 'first-midnight' | 'future' | 'bookkeeping' | 'excluded' | 'double-filed' | 'uncategorized-refund';
export const HEADLINE_REASON_KINDS: readonly HeadlineReasonKind[] = [
  'first-midnight', 'future', 'bookkeeping', 'excluded', 'double-filed', 'uncategorized-refund',
];

/** One row behind a reason. Raw text. */
export interface HeadlineRow {
  /** YYYY-MM-DD. */
  date: string;
  description: string;
  /** The row's spend in the report's sign: positive spends, negative refunds. */
  cents: number;
  account: string;
}

export interface HeadlineReason {
  kind: HeadlineReasonKind;
  /** Its share of report − Wealthfolio. */
  cents: number;
  rows: HeadlineRow[];
  /** Rows left out to fit the snapshot (audit-snapshot.ts). */
  more?: number;
}

export interface HeadlineExplanation {
  month: string;
  reportCents: number | null;
  wealthfolioCents: number | null;
  /** null: the database could not be read. Reasons with no rows are left out. */
  reasons: HeadlineReason[] | null;
  /** null when either figure or the reasons are unknown. */
  unexplainedCents: number | null;
  notes: string[];
}

const CARD_SPEND = new Set(['WITHDRAWAL', 'FEE', 'INTEREST']);
const CASH_SPEND = new Set(['WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX']);
const REFUND_SUBTYPES = new Set(['REFUND', 'REBATE', 'REIMBURSEMENT']);

/** The report's spending sign — kept in step with `SPENDING_SIGN` in
 *  companion/src/sqlite-native.ts, which transcribes Wealthfolio's classifier. */
export function reportSpendSign(r: Pick<HeadlineDbRow, 'accountType' | 'type' | 'subtype'>): -1 | 0 | 1 {
  if (r.accountType === 'CREDIT_CARD') return CARD_SPEND.has(r.type) ? 1 : r.type === 'CREDIT' ? -1 : 0;
  if (r.accountType === 'CASH') {
    if (CASH_SPEND.has(r.type)) return 1;
    return r.type === 'CREDIT' && REFUND_SUBTYPES.has(r.subtype) ? -1 : 0;
  }
  return 0;
}

const isBookkeeping = (notes: string) => isStartingBalanceNote(notes) || isCorrectionNote(notes) || isPlaceholderNote(notes);

/** Stored at exactly 00:00 UTC — the only midnight both sides read differently. */
const atUtcMidnight = (date: string) => /T00:00:00(?:\.0+)?(?:Z|\+00:00)?$/.test(date);

/**
 * The excluded categories and every descendant, as Wealthfolio's
 * ExclusionIndex builds them: the raw ids are kept even when the category no
 * longer exists, and the walk up each parent chain is bounded (32 steps), so
 * a cyclic taxonomy cannot hang it.
 */
export function excludedWithDescendants(raw: readonly string[], parents: Readonly<Record<string, string | null>>): Set<string> {
  const excluded = new Set(raw);
  if (excluded.size === 0) return excluded;
  const roots = new Set(raw);
  for (const id of Object.keys(parents)) {
    if (roots.has(id)) continue;
    const seen = new Set([id]);
    let current = id;
    for (let depth = 0; depth < 32; depth++) {
      const parent = parents[current];
      if (!parent || seen.has(parent)) break;
      if (roots.has(parent)) {
        excluded.add(id);
        break;
      }
      seen.add(parent);
      current = parent;
    }
  }
  return excluded;
}

export function explainHeadline(facts: HeadlineFacts): HeadlineExplanation {
  const failed = new Set(facts.failed ?? []);
  const notes = READ_ORDER.filter((r) => failed.has(r)).map((r) => HEADLINE_READ_NOTES[r]);
  const reportCents = facts.reportCents ?? null;
  const wealthfolioCents = facts.wealthfolioCents ?? null;
  let reasons: HeadlineReason[] | null = null;
  if (facts.rows) {
    const byKind = new Map<HeadlineReasonKind, HeadlineReason>(HEADLINE_REASON_KINDS.map((kind) => [kind, { kind, cents: 0, rows: [] }]));
    const add = (kind: HeadlineReasonKind, cents: number, row: HeadlineRow) => {
      const r = byKind.get(kind)!;
      r.cents += cents;
      r.rows.push(row);
    };
    const firstAtMidnight = `${facts.month}-01T`;
    const thisMonth = facts.today.slice(0, 7) === facts.month;
    const excluded = facts.excludedCategoryIds ? excludedWithDescendants(facts.excludedCategoryIds, facts.categoryParents ?? {}) : null;
    for (const r of facts.rows) {
      const spend = reportSpendSign(r) * r.absCents;
      if (spend === 0) continue;
      const row: HeadlineRow = { date: r.date.slice(0, 10), description: descriptionFromComment(r.notes), cents: spend, account: r.accountName };
      if (isBookkeeping(r.notes)) {
        add('bookkeeping', -spend, row);
        continue;
      }
      if (r.date.startsWith(firstAtMidnight) && atUtcMidnight(r.date)) add('first-midnight', spend, row);
      if (thisMonth && row.date > facts.today) add('future', spend, row);
      if (excluded && r.spendingCategoryId && excluded.has(r.spendingCategoryId)) add('excluded', spend, row);
      if (r.spendingFilings > 1) add('double-filed', spend * (r.spendingFilings - 1), row);
      if (spend < 0 && r.categoryIds.length === 0) add('uncategorized-refund', -spend, row);
    }
    reasons = HEADLINE_REASON_KINDS.map((k) => byKind.get(k)!).filter((r) => r.rows.length > 0);
  }
  const unexplainedCents = reportCents !== null && wealthfolioCents !== null && reasons !== null
    ? reportCents - wealthfolioCents - reasons.reduce((s, r) => s + r.cents, 0)
    : null;
  return { month: facts.month, reportCents, wealthfolioCents, reasons, unexplainedCents, notes };
}

/** True when both figures were read and are the same to the cent. */
export function headlineAgrees(h: HeadlineExplanation): boolean {
  return h.reportCents !== null && h.wealthfolioCents !== null && h.reportCents === h.wealthfolioCents;
}

/** "The report counts $1,240.18 spent this month; Wealthfolio's Spending page counts $1,301.40." Raw. */
export function headlineSummaryLine(h: HeadlineExplanation): string | null {
  const report = h.reportCents === null ? null : changeMoney(h.reportCents);
  const wf = h.wealthfolioCents === null ? null : changeMoney(h.wealthfolioCents);
  if (report && wf) return `The report counts ${report} spent this month; Wealthfolio's Spending page counts ${wf}.`;
  if (report) return `The report counts ${report} spent this month.`;
  if (wf) return `Wealthfolio's Spending page counts ${wf} spent this month.`;
  return null;
}

export const HEADLINE_REASON_LABELS: Record<HeadlineReasonKind, string> = {
  'first-midnight': 'Dated the 1st at midnight UTC',
  future: 'Dated after today',
  bookkeeping: "The add-on's own bookkeeping rows",
  excluded: 'In categories Wealthfolio excludes',
  'double-filed': 'Filed under two categories',
  'uncategorized-refund': 'Refunds with no category',
};
const REASON_WHY: Record<HeadlineReasonKind, string> = {
  'first-midnight': "Wealthfolio's month starts later west of UTC, so it counts these last month",
  future: 'the report counts the whole month; Wealthfolio stops at today',
  bookkeeping: "Wealthfolio counts them; the report doesn't",
  excluded: "Wealthfolio leaves these out; the report doesn't",
  'double-filed': 'the report counts them twice',
  'uncategorized-refund': "Wealthfolio subtracts them; the report doesn't",
};

const signFor = (h: HeadlineExplanation) =>
  (h.reportCents !== null && h.wealthfolioCents !== null && h.reportCents < h.wealthfolioCents ? -1 : 1);

/** "$12.00 — Dated the 1st at midnight UTC: Wealthfolio's month … (2 rows)". Raw. */
export function headlineReasonLine(h: HeadlineExplanation, r: HeadlineReason): string {
  const n = r.rows.length + (r.more ?? 0);
  return `${changeMoney(signFor(h) * r.cents)} — ${HEADLINE_REASON_LABELS[r.kind]}: ${REASON_WHY[r.kind]} (${n} ${n === 1 ? 'row' : 'rows'})`;
}

/** "$3.20 not explained by these reasons", or null. Raw. */
export function headlineUnexplainedLine(h: HeadlineExplanation): string | null {
  if (!h.unexplainedCents) return null;
  return `${changeMoney(signFor(h) * h.unexplainedCents)} not explained by these reasons`;
}

/** "Oct 1 · KROGER #415 · $54.20 · PNC Checking". Raw. */
export function headlineRowLine(r: HeadlineRow): string {
  return `${changeDay(r.date)} · ${r.description || 'A transaction'} · ${changeMoney(r.cents)} · ${r.account}`;
}

function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(instant / 1000) * 1000;
}

/** The instant a wall-clock time occurs in `timeZone` (two passes, for a DST change). */
function zonedInstant(y: number, m0: number, d: number, h: number, min: number, s: number, ms: number, timeZone: string): number {
  const wall = Date.UTC(y, m0, d, h, min, s, ms);
  const first = wall - offsetMs(wall, timeZone);
  return wall - offsetMs(first, timeZone);
}

/**
 * A calendar month in `timeZone`, as the RFC 3339 bounds Wealthfolio's
 * Spending page sends for "This month": the 1st at 00:00 to the last day at
 * 23:59:59.999. Null, or a zone the runtime does not know, uses the
 * process's own zone.
 */
export function zonedMonthBounds(month: string, timeZone: string | null): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (timeZone) {
    try {
      return {
        start: new Date(zonedInstant(y, m - 1, 1, 0, 0, 0, 0, timeZone)).toISOString(),
        end: new Date(zonedInstant(y, m - 1, lastDay, 23, 59, 59, 999, timeZone)).toISOString(),
      };
    } catch {
      /* an unknown zone: the process's own, below */
    }
  }
  return { start: new Date(y, m - 1, 1).toISOString(), end: new Date(y, m - 1, lastDay, 23, 59, 59, 999).toISOString() };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/audit-headline.test.ts`
Expected: PASS — 18 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/audit-headline.ts shared/audit-headline.test.ts
git commit -m "Audits: why the report's spending differs from Wealthfolio's — the script's six reasons

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: What Wealthfolio's Health page flags, with each leg's likely other half

The pure Health check (spec A3, B1; X1c). `audit-health.mjs` parts 1–3 over one ledger read, refined by Wealthfolio's own Health source: transfer legs in active, non-archived accounts that have no group, sit in a group Wealthfolio will not accept (with why), or belong to a valid pair but are marked external; starting balances dated on or after the account's earliest other row; rows on the phantom `$CASH` security. Each leg of yours gets its likely other half only as `fix-transfers.mjs` would link it — unique both ways; two candidates, or a candidate another leg also wants, are "many" and never offered. A pair of two unlinked legs is one issue, from the leg the money left. Each issue carries a `findingHandle` key and, for a leg, both rows' ids, account ids, tx keys, amounts and dates (R2's Link). Without the database Health is "not checked" (`issues: null`), never "nothing".

**Files:**
- Create: `shared/audit-health.ts`, `shared/audit-health.test.ts`

**Interfaces:**
- Consumes: Task 1 (`AuditLedger`, `AuditLedgerRow`, `isCorrectionNote`, `isPlaceholderNote`, `isStartingBalanceNote`); `accountTxKey` (shared/transfers.ts); `descriptionFromComment`, `isTransferType`, `txIdFromComment` (shared/sync-core.ts); `changeDay`, `changeMoney`.
- Produces:

```ts
// shared/audit-health.ts
export const MATCH_DAYS = 5;
export type HealthRead = 'ledger' | 'mapping';
export const HEALTH_READ_NOTES: Record<HealthRead, string>;
export const HEALTH_NONE: string;   // 'Nothing the add-on checks for: no incomplete transfers, late starting balances or $CASH rows.'
export interface HealthFacts { ledger?: AuditLedger; mapping?: Record<string, string>; failed?: HealthRead[] }
export interface HealthLeg {
  activityId: string; accountId: string; accountName: string; txKey: string | null; date: string;
  absCents: number; type: string; currency: string; description: string;
}
export type GroupProblem =
  | { kind: 'legs'; count: number } | { kind: 'same-direction' } | { kind: 'one-account' } | { kind: 'security' } | { kind: 'marked-external' };
export type HealthIssue =
  | { kind: 'incomplete-leg'; key: string; leg: HealthLeg; problem: GroupProblem | null; owner: 'you' | 'add-on';
      match: 'one' | 'many' | 'none' | 'skipped'; counterpart: HealthLeg | null }
  | { kind: 'phantom-cash'; key: string; rows: number; accounts: Array<{ name: string; rows: number }> }
  | { kind: 'late-start'; key: string; activityId: string; accountId: string; accountName: string; date: string; earliest: string; cents: number };
export interface HealthReport { issues: HealthIssue[] | null; more?: number; notes: string[] }
export function healthIssues(facts: HealthFacts): HealthReport;
export function healthCount(r: HealthReport): number | null;
export function healthLegLine(l: HealthLeg): string;
export function healthIssueTitle(i: HealthIssue): string;
export function healthIssueLines(i: HealthIssue): string[];
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/audit-health.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import {
  healthCount, healthIssueLines, healthIssues, healthIssueTitle, HEALTH_NONE, HEALTH_READ_NOTES, MATCH_DAYS,
  type HealthFacts, type HealthIssue,
} from './audit-health';
import type { AuditAccount, AuditLedgerRow } from './audit-ledger';
import { accountTxKey } from './transfers';

const acct = (id: string, name: string, archived = false, active = true): AuditAccount => ({ id, name, type: 'CASH', archived, active });
let seq = 0;
const row = (over: Partial<AuditLedgerRow> = {}): AuditLedgerRow => {
  seq += 1;
  return {
    id: `act-${seq}`, accountId: 'wf-chk', date: '2026-10-04', currency: 'USD', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT',
    status: 'POSTED', absCents: 60000, group: '', assetId: '', external: false, phantomCash: false, notes: `TRANSFER TO ALLY · TRN-${seq}`,
    ...over,
  };
};
const ACCOUNTS = [
  acct('wf-chk', 'PNC Checking'), acct('wf-ally', 'Ally Savings'), acct('wf-cap', 'Capital One'),
  acct('wf-old', 'Old Bank', true), acct('wf-off', 'Closed Card', false, false),
];
const facts = (rows: AuditLedgerRow[], over: Partial<HealthFacts> = {}): HealthFacts => ({
  ledger: { accounts: ACCOUNTS, rows },
  mapping: { 'sfin-chk': 'wf-chk', 'sfin-ally': 'wf-ally', 'sfin-cap': 'wf-cap' },
  ...over,
});
const legs = (issues: HealthIssue[] | null) =>
  (issues ?? []).flatMap((i) => (i.kind === 'incomplete-leg' ? [i] : []));

describe('healthIssues: incomplete transfer legs', () => {
  it('offers the one row that matches both ways, carrying both rows’ ids, accounts, tx keys, amounts and dates', () => {
    const out = row({ id: 'out', notes: 'TRANSFER TO ALLY · TRN-1' });
    const dep = row({ id: 'dep', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-06', notes: 'FROM PNC · TRN-2' });
    const [issue] = legs(healthIssues(facts([out, dep])).issues);
    expect(issue).toMatchObject({ key: 'leg:out', problem: null, owner: 'you', match: 'one' });
    expect(issue.leg).toEqual({
      activityId: 'out', accountId: 'wf-chk', accountName: 'PNC Checking', txKey: accountTxKey('sfin-chk', 'TRN-1'),
      date: '2026-10-04', absCents: 60000, type: 'TRANSFER_OUT', currency: 'USD', description: 'TRANSFER TO ALLY',
    });
    expect(issue.counterpart).toEqual({
      activityId: 'dep', accountId: 'wf-ally', accountName: 'Ally Savings', txKey: accountTxKey('sfin-ally', 'TRN-2'),
      date: '2026-10-06', absCents: 60000, type: 'DEPOSIT', currency: 'USD', description: 'FROM PNC',
    });
    expect(healthIssueTitle(issue)).toBe('TRANSFER TO ALLY · $600.00 · PNC Checking · Oct 4');
    expect(healthIssueLines(issue)).toEqual(['Not linked to its other half.', 'Likely the other half: FROM PNC · $600.00 · Ally Savings · Oct 6']);
  });

  it('does not offer a counterpart that two rows could be', () => {
    const out = row({ id: 'out' });
    const a = row({ accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-05' });
    const b = row({ accountId: 'wf-cap', rawType: 'TRANSFER_IN', type: 'TRANSFER_IN', date: '2026-10-05', notes: 'FROM PNC · TRN-77' });
    const issues = legs(healthIssues(facts([out, a, b])).issues);
    const mine = issues.find((i) => i.leg.activityId === 'out')!;
    expect(mine.match).toBe('many');
    expect(mine.counterpart).toBeNull();
    expect(healthIssueLines(mine)[1]).toBe('It could pair with more than one row — link the right two in Wealthfolio.');
  });

  it('does not offer a row two legs both want', () => {
    const one = row({ id: 'one', date: '2026-10-04' });
    const two = row({ id: 'two', accountId: 'wf-cap', date: '2026-10-05' });
    const dep = row({ id: 'dep', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-05' });
    const issues = legs(healthIssues(facts([one, two, dep])).issues);
    expect(issues.map((i) => [i.leg.activityId, i.match])).toEqual([['one', 'many'], ['two', 'many']]);
  });

  it('lists a pair of two unlinked legs once, from the leg the money left', () => {
    const out = row({ id: 'out' });
    const inn = row({ id: 'in', accountId: 'wf-ally', rawType: 'TRANSFER_IN', type: 'TRANSFER_IN', date: '2026-10-05', notes: 'FROM PNC · TRN-9' });
    const issues = legs(healthIssues(facts([inn, out])).issues);
    expect(issues).toHaveLength(1);
    expect(issues[0].leg.activityId).toBe('out');
    expect(issues[0].counterpart!.activityId).toBe('in');
  });

  it('finds nothing past MATCH_DAYS, in another currency, in the same account or moving the same way', () => {
    expect(MATCH_DAYS).toBe(5);
    const out = row({ id: 'out' });
    const late = row({ accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-10' });
    const cad = row({ accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', currency: 'CAD' });
    const same = row({ accountId: 'wf-chk', rawType: 'DEPOSIT', type: 'DEPOSIT' });
    const outflow = row({ accountId: 'wf-cap', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL' });
    const [issue] = legs(healthIssues(facts([out, late, cad, same, outflow])).issues);
    expect(issue.match).toBe('none');
    expect(healthIssueLines(issue)[1]).toBe('No likely other half within 5 days — if it has one, link the two in Wealthfolio.');
  });

  it('skips a valid pair, an external leg and a row that is not posted', () => {
    const issues = healthIssues(facts([
      row({ group: 'g1' }), row({ accountId: 'wf-ally', rawType: 'TRANSFER_IN', type: 'TRANSFER_IN', group: 'g1' }),
      row({ external: true }),
      row({ status: 'PENDING' }),
    ])).issues;
    expect(issues).toEqual([]);
  });

  it('says why Wealthfolio refuses a group', () => {
    const issues = legs(healthIssues(facts([
      row({ id: 'a1', group: 'three' }), row({ id: 'a2', group: 'three', type: 'TRANSFER_IN', accountId: 'wf-ally' }), row({ id: 'a3', group: 'three', accountId: 'wf-cap' }),
      row({ id: 'b1', group: 'same' }), row({ id: 'b2', group: 'same', accountId: 'wf-ally' }),
      row({ id: 'c1', group: 'one' }), row({ id: 'c2', group: 'one', type: 'TRANSFER_IN' }),
      row({ id: 'd1', group: 'sec', assetId: 'AAPL' }), row({ id: 'd2', group: 'sec', type: 'TRANSFER_IN', accountId: 'wf-ally' }),
    ])).issues);
    const said = (id: string) => healthIssueLines(issues.find((i) => i.leg.activityId === id)!)[0];
    expect(said('a1')).toBe("Linked, but Wealthfolio won't accept the pair: its group has 3 transfer rows.");
    expect(said('b1')).toBe("Linked, but Wealthfolio won't accept the pair: both rows move money the same way.");
    expect(said('c1')).toBe("Linked, but Wealthfolio won't accept the pair: both rows are in one account.");
    expect(said('d1')).toBe("Linked, but Wealthfolio won't accept the pair: a row carries an asset.");
  });

  it('flags the add-on’s own rows without matching them, and never offers an opening balance', () => {
    const placeholder = row({ id: 'ph', notes: '↔️ In-transit transfer · ZELLE · TRN-3' });
    const opening = row({ id: 'open', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', notes: 'Starting balance · ACT-1' });
    const mine = row({ id: 'mine', accountId: 'wf-cap', date: '2026-10-04' });
    const issues = legs(healthIssues(facts([placeholder, opening, mine])).issues);
    const byId = Object.fromEntries(issues.map((i) => [i.leg.activityId, i]));
    expect(byId.ph).toMatchObject({ owner: 'add-on', match: 'skipped', counterpart: null });
    expect(healthIssueLines(byId.ph)[1]).toBe("One of the add-on's own rows — the sync marks these so Health skips them.");
    expect(byId.mine.match).toBe('none');
  });

  it('looks only at active accounts that are not archived, as Health does, and never offers an archived row', () => {
    const archived = row({ id: 'arch', accountId: 'wf-old' });
    const inactive = row({ id: 'off', accountId: 'wf-off' });
    const mine = row({ id: 'mine', accountId: 'wf-cap' });
    const archivedDeposit = row({ id: 'old-dep', accountId: 'wf-old', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-05' });
    const issues = legs(healthIssues(facts([archived, inactive, mine, archivedDeposit])).issues);
    expect(issues.map((i) => [i.leg.activityId, i.match])).toEqual([['mine', 'none']]);
  });

  it('flags a leg of a valid pair that is marked external, which Health calls a conflicting marker', () => {
    const issues = legs(healthIssues(facts([
      row({ id: 'out', group: 'g1', external: true }),
      row({ id: 'in', accountId: 'wf-ally', rawType: 'TRANSFER_IN', type: 'TRANSFER_IN', group: 'g1' }),
    ])).issues);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ key: 'leg:out', problem: { kind: 'marked-external' }, match: 'skipped', counterpart: null });
    expect(healthIssueLines(issues[0])).toEqual([
      'Linked, but marked as money moving in or out of Wealthfolio, which contradicts the pair.',
      'Unlink the two and link them again in Wealthfolio — linking clears the mark.',
    ]);
  });

  it('treats a card’s TRANSFER_OUT (Wealthfolio 3.10) as a leg like any other, and never flags one marked external', () => {
    const cardOut = row({ id: 'card-out', accountId: 'wf-card', date: '2026-10-04' });
    const dep = row({ id: 'dep', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-05' });
    const external = row({ id: 'ext', accountId: 'wf-card', external: true, date: '2026-10-20' });
    const withCard = { ...facts([]), ledger: { accounts: [...ACCOUNTS, { id: 'wf-card', name: 'Citi', type: 'CREDIT_CARD', archived: false }], rows: [cardOut, dep, external] } };
    const issues = legs(healthIssues(withCard).issues);
    expect(issues.map((i) => [i.leg.activityId, i.match, i.counterpart?.activityId])).toEqual([['card-out', 'one', 'dep']]);
  });

  it('keeps bank text raw', () => {
    const [issue] = legs(healthIssues(facts([row({ notes: 'SQ *COFFEE_CLUB [2] · TRN-4' })])).issues);
    expect(issue.leg.description).toBe('SQ *COFFEE_CLUB [2]');
  });
});

describe('healthIssues: starting balances and $CASH', () => {
  it('flags a starting balance dated on or after the account’s earliest row', () => {
    const issues = healthIssues(facts([
      row({ id: 'sb', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 120400, date: '2026-08-02', notes: 'Starting balance · ACT-1' }),
      row({ accountId: 'wf-ally', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', date: '2026-07-28', notes: 'COFFEE · TRN-5' }),
      row({ accountId: 'wf-cap', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-07-01', notes: 'Starting balance · ACT-2' }),
      row({ accountId: 'wf-cap', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', date: '2026-07-02', notes: 'TEA · TRN-6' }),
    ])).issues!;
    expect(issues).toEqual([{
      kind: 'late-start', key: 'late-start:sb', activityId: 'sb', accountId: 'wf-ally', accountName: 'Ally Savings',
      date: '2026-08-02', earliest: '2026-07-28', cents: 120400,
    }]);
    expect(healthIssueTitle(issues[0])).toBe("Ally Savings's starting balance is dated Aug 2, after its earliest transaction (Jul 28)");
    expect(healthIssueLines(issues[0])).toEqual(['A deep scan moves it to the day before your earliest transaction.']);
  });

  it('counts rows pointing at the phantom $CASH security, by account', () => {
    const issues = healthIssues(facts([
      row({ rawType: 'DEPOSIT', type: 'DEPOSIT', phantomCash: true }),
      row({ rawType: 'DEPOSIT', type: 'DEPOSIT', phantomCash: true }),
      row({ accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', phantomCash: true }),
    ])).issues!;
    expect(issues).toEqual([{ kind: 'phantom-cash', key: 'phantom-cash', rows: 3, accounts: [{ name: 'Ally Savings', rows: 1 }, { name: 'PNC Checking', rows: 2 }] }]);
    expect(healthIssueTitle(issues[0])).toBe('3 rows point at a $CASH asset (Ally Savings: 1, PNC Checking: 2)');
    expect(healthIssueLines(issues[0])).toEqual(['Older Wealthfolio versions filed these under a $CASH asset. Clean-up needs the server tool fix-transfers.mjs.']);
  });

  it('has nothing to report on a clean ledger', () => {
    const r = healthIssues(facts([row({ rawType: 'WITHDRAWAL', type: 'WITHDRAWAL' })]));
    expect(r.issues).toEqual([]);
    expect(healthCount(r)).toBe(0);
    // Never "Wealthfolio's Health page has nothing": 3.10's checks more than this port.
    expect(HEALTH_NONE).toBe('Nothing the add-on checks for: no incomplete transfers, late starting balances or $CASH rows.');
  });
});

describe('healthIssues: failed reads', () => {
  it('says Health was not checked without the database — never "nothing to flag"', () => {
    const r = healthIssues({ mapping: {}, failed: ['ledger'] });
    expect(r.issues).toBeNull();
    expect(healthCount(r)).toBeNull();
    expect(r.notes).toEqual([HEALTH_READ_NOTES.ledger]);
  });

  it('still checks without the mapping, with no bank ids on the rows', () => {
    const r = healthIssues(facts([row()], { mapping: undefined, failed: ['mapping'] }));
    expect(legs(r.issues)[0].leg.txKey).toBeNull();
    expect(r.notes).toEqual([HEALTH_READ_NOTES.mapping]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/audit-health.test.ts`
Expected: FAIL — `Failed to resolve import "./audit-health"`; no tests run.

- [ ] **Step 3: Implement**

**Create `shared/audit-health.ts`:**

```ts
/**
 * shared/audit-health.ts
 *
 * What Wealthfolio's own Health page would flag (2c R1, spec A3), each with
 * what to do. Pure: companion/tools/audit-health.mjs parts 1–3 and
 * fix-transfers.mjs's matcher, ported over the rows audit-ledger.ts carries.
 *
 *  1. Transfer legs (Wealthfolio 3.8's `invalid_transfer_groups_from_activities`,
 *     crates/core/src/health/service.rs:771-825, the same in 3.10): every
 *     POSTED TRANSFER_IN/TRANSFER_OUT (by its override type) in an ACTIVE,
 *     NOT ARCHIVED account (service.rs:277, 779) that has no group, or whose
 *     group is not exactly one IN and one OUT in two accounts with no
 *     security on either — unless its metadata says `flow.is_external: true`;
 *     and every leg of a VALID pair that IS marked external (the
 *     "conflicting external marker", service.rs:813-825). The script checks
 *     neither the account nor the marker on a pair; Health's source does.
 *  2. Starting balances dated on or after the account's earliest other row.
 *  3. Rows pointing at the phantom `$CASH` security.
 *
 * A leg of yours gets its likely other half only as fix-transfers.mjs would
 * link it: another account (not archived), the same currency and amount to
 * the cent, the opposite direction (a TRANSFER_OUT wants a TRANSFER_IN,
 * DEPOSIT or CREDIT; a TRANSFER_IN a TRANSFER_OUT or WITHDRAWAL), POSTED,
 * within MATCH_DAYS, not already half of a valid pair, not the add-on's
 * opening balance or correction — and unique BOTH ways: the leg has exactly
 * one candidate and no other leg claims it. Anything else is "many" and is
 * never offered. The add-on's own rows (opening balances, corrections,
 * in-transit placeholders) are flagged but never matched: the sync marks
 * those itself. A leg of a valid pair marked external is never matched
 * either: it already has its other half.
 *
 * A counterpart carries both rows' ids, account ids, tx keys, amounts and
 * dates — what R2's Link re-reads before it writes, whichever linker it uses.
 *
 * Across Wealthfolio versions (3.8 to 3.10): a leg marked external is fine in
 * Health on every version (3.10's TransferLinkState::External), so it is
 * skipped here; a card may carry a TRANSFER_OUT from 3.10 (#1796), which is a
 * transfer leg like any other; a `$CASH` row cannot be created on 3.10
 * (#1798), so those are older rows. 3.10's Health also checks things this
 * port does not (rejected, oversold and amountless activities, a stale
 * projection), so "nothing to report" is worded as nothing the ADD-ON
 * checks for, never as Wealthfolio's whole Health page.
 */
import { changeDay, changeMoney } from './change-entries.js';
import { descriptionFromComment, isTransferType, txIdFromComment } from './sync-core.js';
import { accountTxKey } from './transfers.js';
import {
  isCorrectionNote, isPlaceholderNote, isStartingBalanceNote, type AuditLedger, type AuditLedgerRow,
} from './audit-ledger.js';

/** fix-transfers.mjs's MATCH_DAYS. */
export const MATCH_DAYS = 5;

export type HealthRead = 'ledger' | 'mapping';
export const HEALTH_READ_NOTES: Record<HealthRead, string> = {
  ledger: "Couldn't read the Wealthfolio database, so Health wasn't checked.",
  mapping: "Couldn't read which accounts are mapped, so the rows' bank ids are missing.",
};
const READ_ORDER: HealthRead[] = ['ledger', 'mapping'];

export const HEALTH_NONE = 'Nothing the add-on checks for: no incomplete transfers, late starting balances or $CASH rows.';

export interface HealthFacts {
  ledger?: AuditLedger;
  /** account_mapping: SimpleFin id → Wealthfolio id, for the rows' tx keys. */
  mapping?: Record<string, string>;
  failed?: HealthRead[];
}

/** One row as an issue names it. */
export interface HealthLeg {
  activityId: string;
  accountId: string;
  /** Raw. */
  accountName: string;
  /** accountTxKey(SimpleFin account id, SimpleFin tx id); null when the
   *  account is not mapped or the note carries no id. */
  txKey: string | null;
  /** YYYY-MM-DD. */
  date: string;
  absCents: number;
  /** The type Health reads (the override when there is one). */
  type: string;
  currency: string;
  /** Raw. */
  description: string;
}

export type GroupProblem =
  | { kind: 'legs'; count: number }
  | { kind: 'same-direction' }
  | { kind: 'one-account' }
  | { kind: 'security' }
  /** A valid pair, but this leg is marked as money in or out of Wealthfolio. */
  | { kind: 'marked-external' };

export type HealthIssue =
  | {
    kind: 'incomplete-leg';
    /** For `findingHandle`. */
    key: string;
    leg: HealthLeg;
    /** null: not linked at all. */
    problem: GroupProblem | null;
    owner: 'you' | 'add-on';
    /** 'skipped': the add-on's own row, or a pair already linked — never matched. */
    match: 'one' | 'many' | 'none' | 'skipped';
    /** Only for match 'one'. */
    counterpart: HealthLeg | null;
  }
  | { kind: 'phantom-cash'; key: string; rows: number; accounts: Array<{ name: string; rows: number }> }
  | { kind: 'late-start'; key: string; activityId: string; accountId: string; accountName: string; date: string; earliest: string; cents: number };

export interface HealthReport {
  /** null: not checked (the database could not be read). */
  issues: HealthIssue[] | null;
  /** Issues left out to fit the snapshot (audit-snapshot.ts). */
  more?: number;
  notes: string[];
}

const INFLOW = new Set(['TRANSFER_IN', 'DEPOSIT', 'CREDIT']);
const OUTFLOW = new Set(['TRANSFER_OUT', 'WITHDRAWAL']);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
/** non_cash_transfer_asset_key: a cash asset id starts with `$CASH`. */
const carriesSecurity = (r: AuditLedgerRow) => r.assetId !== '' && !r.assetId.toUpperCase().startsWith('$CASH');
const isBookkeeping = (r: AuditLedgerRow) => isStartingBalanceNote(r.notes) || isCorrectionNote(r.notes);

function groupsOf(rows: AuditLedgerRow[]): Map<string, AuditLedgerRow[]> {
  const groups = new Map<string, AuditLedgerRow[]>();
  for (const r of rows) {
    if (!isTransferType(r.type) || !r.group.trim()) continue;
    groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  }
  return groups;
}

function groupProblem(legs: AuditLedgerRow[]): GroupProblem | null {
  if (legs.length !== 2) return { kind: 'legs', count: legs.length };
  if (legs.filter((l) => l.type === 'TRANSFER_IN').length !== 1) return { kind: 'same-direction' };
  if (legs[0].accountId === legs[1].accountId) return { kind: 'one-account' };
  if (legs.some(carriesSecurity)) return { kind: 'security' };
  return null;
}

export function healthIssues(facts: HealthFacts): HealthReport {
  const failed = new Set(facts.failed ?? []);
  const notes = READ_ORDER.filter((r) => failed.has(r)).map((r) => HEALTH_READ_NOTES[r]);
  if (!facts.ledger) return { issues: null, notes };

  const accounts = new Map(facts.ledger.accounts.map((a) => [a.id, a]));
  const sfinOf = new Map(Object.entries(facts.mapping ?? {}).filter(([, wf]) => !!wf).map(([sfin, wf]) => [wf, sfin]));
  const legOf = (r: AuditLedgerRow): HealthLeg => {
    const sfin = sfinOf.get(r.accountId);
    const txId = txIdFromComment(r.notes);
    return {
      activityId: r.id, accountId: r.accountId, accountName: accounts.get(r.accountId)?.name ?? r.accountId,
      txKey: sfin && txId ? accountTxKey(sfin, txId) : null,
      date: r.date, absCents: r.absCents, type: r.type, currency: r.currency, description: descriptionFromComment(r.notes),
    };
  };
  const rows = [...facts.ledger.rows].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  // ── 1. transfer legs, as Health reads them: pairs from every row, legs
  //       reported only in active accounts that are not archived ──
  const groups = groupsOf(rows);
  const eligible = (r: AuditLedgerRow) => {
    const a = accounts.get(r.accountId);
    return !!a && !a.archived && a.active !== false;
  };
  const incomplete: Array<{ row: AuditLedgerRow; problem: GroupProblem | null }> = [];
  for (const r of rows) {
    if (!isTransferType(r.type) || r.status !== 'POSTED' || !eligible(r)) continue;
    const problem = r.group.trim() ? groupProblem(groups.get(r.group)!) : null;
    if (r.group.trim() && !problem) {
      if (r.external) incomplete.push({ row: r, problem: { kind: 'marked-external' } });
      continue;
    }
    if (!r.external) incomplete.push({ row: r, problem });
  }

  // ── fix-transfers.mjs's matcher, over accounts that are not archived ──
  const live = rows.filter((r) => !accounts.get(r.accountId)?.archived);
  const liveGroups = groupsOf(live);
  const inValidPair = (r: AuditLedgerRow) => isTransferType(r.type) && !!r.group && groupProblem(liveGroups.get(r.group) ?? []) === null;
  const userLegs = live.filter((r) => isTransferType(r.type) && r.status === 'POSTED' && !inValidPair(r) && !r.external
    && !isBookkeeping(r) && !isPlaceholderNote(r.notes));
  const userIds = new Set(userLegs.map((l) => l.id));
  const counterparts = (leg: AuditLedgerRow) => live.filter((c) => c.id !== leg.id && c.accountId !== leg.accountId
    && c.currency === leg.currency && c.status === 'POSTED' && !isBookkeeping(c) && !inValidPair(c)
    && c.absCents === leg.absCents && Math.abs(dayMs(c.date) - dayMs(leg.date)) <= MATCH_DAYS * 86_400_000
    && (leg.type === 'TRANSFER_OUT' ? INFLOW.has(c.type) : OUTFLOW.has(c.type)));
  const claims = new Map<string, number>();
  const proposals: Array<{ leg: AuditLedgerRow; other: AuditLedgerRow }> = [];
  const many = new Set<string>();
  for (const leg of userLegs) {
    const cs = counterparts(leg);
    if (cs.length === 1) {
      proposals.push({ leg, other: cs[0] });
      claims.set(cs[0].id, (claims.get(cs[0].id) ?? 0) + 1);
    } else if (cs.length > 1) many.add(leg.id);
  }
  // Unique both ways; a pair of two incomplete legs is found from both ends.
  const seen = new Set<string>();
  const pairs: Array<{ leg: AuditLedgerRow; other: AuditLedgerRow }> = [];
  for (const p of proposals) {
    const key = [p.leg.id, p.other.id].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const contested = ((claims.get(p.other.id) ?? 0) > 1 && !userIds.has(p.other.id)) || many.has(p.other.id);
    if (contested) many.add(p.leg.id);
    else pairs.push(p);
  }
  const listed = new Set(incomplete.map((i) => i.row.id));

  const issues: HealthIssue[] = [];
  for (const { row, problem } of incomplete) {
    const owner = isBookkeeping(row) || isPlaceholderNote(row.notes) ? 'add-on' as const : 'you' as const;
    const paired = problem?.kind === 'marked-external';
    let match: 'one' | 'many' | 'none' | 'skipped' = owner === 'you' && !paired ? 'none' : 'skipped';
    let counterpart: HealthLeg | null = null;
    if (match === 'none') {
      const pair = pairs.find((p) => p.leg.id === row.id || p.other.id === row.id);
      if (pair) {
        const other = pair.leg.id === row.id ? pair.other : pair.leg;
        // Both halves incomplete: one issue, from the leg the money left.
        if (listed.has(other.id) && row.type !== 'TRANSFER_OUT' && other.type === 'TRANSFER_OUT') continue;
        match = 'one';
        counterpart = legOf(other);
      } else if (many.has(row.id)) match = 'many';
    }
    issues.push({ kind: 'incomplete-leg', key: `leg:${row.id}`, leg: legOf(row), problem, owner, match, counterpart });
  }

  // ── 2. starting balances dated on or after the earliest other row ──
  const late = rows
    .filter((r) => isStartingBalanceNote(r.notes))
    .flatMap((r) => {
      const earliest = rows.filter((b) => b.accountId === r.accountId && !isStartingBalanceNote(b.notes)).map((b) => b.date).sort()[0];
      if (!earliest || r.date < earliest) return [];
      const account = accounts.get(r.accountId);
      return [{
        kind: 'late-start' as const, key: `late-start:${r.id}`, activityId: r.id, accountId: r.accountId,
        accountName: account?.name ?? r.accountId, date: r.date, earliest, cents: r.absCents,
      }];
    })
    .sort((a, b) => a.accountName.localeCompare(b.accountName) || a.date.localeCompare(b.date));
  issues.push(...late);

  // ── 3. the phantom $CASH security ──
  const phantom = rows.filter((r) => r.phantomCash);
  if (phantom.length > 0) {
    const byAccount = new Map<string, number>();
    for (const r of phantom) {
      const name = accounts.get(r.accountId)?.name ?? r.accountId;
      byAccount.set(name, (byAccount.get(name) ?? 0) + 1);
    }
    issues.push({
      kind: 'phantom-cash', key: 'phantom-cash', rows: phantom.length,
      accounts: [...byAccount].sort(([a], [b]) => a.localeCompare(b)).map(([name, n]) => ({ name, rows: n })),
    });
  }
  return { issues, notes };
}

/** How many issues, or null when Health was not checked. */
export function healthCount(r: HealthReport): number | null {
  return r.issues === null ? null : r.issues.length + (r.more ?? 0);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "TRANSFER TO ALLY · $600.00 · PNC Checking · Oct 4". Raw. */
export function healthLegLine(l: HealthLeg): string {
  return `${l.description || 'A transaction'} · ${changeMoney(l.absCents)} · ${l.accountName} · ${changeDay(l.date)}`;
}

/** The issue's one-line title. Raw. */
export function healthIssueTitle(i: HealthIssue): string {
  switch (i.kind) {
    case 'incomplete-leg': return healthLegLine(i.leg);
    case 'phantom-cash':
      return `${i.rows} ${plural(i.rows, 'row points', 'rows point')} at a $CASH asset (${i.accounts.map((a) => `${a.name}: ${a.rows}`).join(', ')})`;
    case 'late-start':
      return `${i.accountName}'s starting balance is dated ${changeDay(i.date)}, after its earliest transaction (${changeDay(i.earliest)})`;
  }
}

function problemText(p: GroupProblem): string {
  switch (p.kind) {
    case 'legs': return `its group has ${p.count} transfer rows`;
    case 'same-direction': return 'both rows move money the same way';
    case 'one-account': return 'both rows are in one account';
    case 'security': return 'a row carries an asset';
    case 'marked-external': return 'marked-external';
  }
}

/** What the issue is and what to do about it. Raw. */
export function healthIssueLines(i: HealthIssue): string[] {
  switch (i.kind) {
    case 'incomplete-leg': {
      if (i.problem?.kind === 'marked-external') {
        return [
          'Linked, but marked as money moving in or out of Wealthfolio, which contradicts the pair.',
          'Unlink the two and link them again in Wealthfolio — linking clears the mark.',
        ];
      }
      const what = i.problem === null ? 'Not linked to its other half.' : `Linked, but Wealthfolio won't accept the pair: ${problemText(i.problem)}.`;
      const todo = i.owner === 'add-on' ? "One of the add-on's own rows — the sync marks these so Health skips them."
        : i.match === 'one' && i.counterpart ? `Likely the other half: ${healthLegLine(i.counterpart)}`
            : i.match === 'many' ? 'It could pair with more than one row — link the right two in Wealthfolio.'
              : `No likely other half within ${MATCH_DAYS} days — if it has one, link the two in Wealthfolio.`;
      return [what, todo];
    }
    case 'phantom-cash':
      return ['Older Wealthfolio versions filed these under a $CASH asset. Clean-up needs the server tool fix-transfers.mjs.'];
    case 'late-start':
      return ['A deep scan moves it to the day before your earliest transaction.'];
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/audit-health.test.ts`
Expected: PASS — 17 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/audit-health.ts shared/audit-health.test.ts
git commit -m "Audits: what Wealthfolio's Health page flags, with each leg's likely other half

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The snapshot the app reads — built within 100 KB, read corrupt-aware

`shared/audit-snapshot.ts` (spec B2, B3, A5; X1d, X5). The three checks' results as one `audit_snapshot` secret, `{ v: 1, at, balances: { [wfAccountId]: … }, balanceNotes, headline, health }`, trimmed rows first — each reason's rows, then Health's issues, each saying how many it left out — until it fits 100,000 UTF-8 bytes; the worst case is pinned. The app's read is ok / absent / corrupt, never "empty" for a snapshot it could not read, and `auditSnapshotStatus` says where the checks came from, in the viewer's own time: fresh ("As of the 2:00 PM sync."), stale after two days, absent (with or without a companion) or corrupt.

**Files:**
- Create: `shared/audit-snapshot.ts`, `shared/audit-snapshot.test.ts`

**Interfaces:**
- Consumes: Task 1 (`BalanceExplanation`, `BalanceReport`); Task 2 (`HeadlineExplanation`, `HEADLINE_REASON_KINDS` in tests); Task 3 (`HealthReport`, `HealthIssue`, `HealthLeg` in tests).
- Produces:

```ts
// shared/audit-snapshot.ts
export const AUDIT_SNAPSHOT_SECRET_KEY = 'audit_snapshot';
export const AUDIT_SNAPSHOT_MAX_BYTES = 100_000;
export const AUDIT_STALE_MS: number;   // 2 days
export const AUDIT_CORRUPT: string;          // "Couldn't read the checks — run /audit in Telegram."
export const AUDIT_NEEDS_COMPANION: string;  // 'These checks need the companion.'
export const AUDIT_NOT_YET: string;          // "These checks arrive with the companion's next sync."
export interface AuditSnapshot {
  v: 1; at: string; balances: Record<string, BalanceExplanation>; balanceNotes: string[];
  headline: HeadlineExplanation; health: HealthReport;
}
export interface AuditResults { balances: BalanceReport; headline: HeadlineExplanation; health: HealthReport }
export function buildAuditSnapshot(results: AuditResults, now: Date): AuditSnapshot;
export type AuditSnapshotRead = { kind: 'ok'; snapshot: AuditSnapshot } | { kind: 'absent' } | { kind: 'corrupt' };
export function parseAuditSnapshot(raw: string | null | undefined): AuditSnapshotRead;
export function auditSnapshotStatus(read: AuditSnapshotRead, companionVersion: string | null, now: Date):
  { state: 'fresh' | 'stale' | 'absent' | 'corrupt'; line: string };
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/audit-snapshot.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import {
  auditSnapshotStatus, buildAuditSnapshot, parseAuditSnapshot, AUDIT_CORRUPT, AUDIT_NEEDS_COMPANION, AUDIT_NOT_YET,
  AUDIT_SNAPSHOT_MAX_BYTES, AUDIT_SNAPSHOT_SECRET_KEY, type AuditResults,
} from './audit-snapshot';
import { HEADLINE_REASON_KINDS, type HeadlineRow } from './audit-headline';
import type { BalanceExplanation } from './audit-balance';
import type { HealthIssue, HealthLeg } from './audit-health';

const bytes = (s: string) => new TextEncoder().encode(s).length;
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const NOW = new Date('2026-10-13T18:00:00Z');

function account(i: number): BalanceExplanation {
  return {
    wfAccountId: uuid(i), name: `${'Ü'.repeat(56)} ${i}`, accountType: 'CREDIT_CARD',
    bank: { kind: 'ok', cents: -123456789, date: '2026-10-13' }, wealthfolioCents: -123400000, offCents: -56789,
    causes: [
      { kind: 'pending', cents: -1, count: 99 }, { kind: 'after-bank-date', cents: -2, count: 99 }, { kind: 'held', cents: -3, count: 1 },
      { kind: 'unlinked', cents: -4, count: 1 }, { kind: 'not-booked', cents: -5, count: 99 },
    ],
    unexplainedCents: -56774,
    includes: { start: { cents: -99999999, date: '2024-01-01' }, corrections: { count: 99, cents: -9999999, latest: '2026-10-12' } },
  };
}
const headlineRow = (i: number): HeadlineRow => ({ date: '2026-10-01', description: `${'Ü'.repeat(110)} ${i}`, cents: -123456, account: 'Ü'.repeat(60) });
const leg = (i: number): HealthLeg => ({
  activityId: uuid(i), accountId: uuid(i + 1), accountName: 'Ü'.repeat(60), txKey: `${uuid(i + 2)}\u0000TRN-${'9'.repeat(40)}`,
  date: '2026-10-04', absCents: 123456789, type: 'TRANSFER_OUT', currency: 'USD', description: 'Ü'.repeat(110),
});

/** Every list as long as a bad year could make it, every string at its longest. */
function worstCase(): AuditResults {
  const issues: HealthIssue[] = Array.from({ length: 1000 }, (_, i) => ({
    kind: 'incomplete-leg', key: `leg:${uuid(i)}`, leg: leg(i), problem: { kind: 'legs', count: 3 }, owner: 'you', match: 'one', counterpart: leg(i + 5000),
  }));
  return {
    balances: { accounts: Array.from({ length: 40 }, (_, i) => account(i)), notes: ["Couldn't read the bank balances."] },
    headline: {
      month: '2026-10', reportCents: 999999999, wealthfolioCents: 1, unexplainedCents: 1, notes: ["Couldn't read Wealthfolio's settings."],
      reasons: HEADLINE_REASON_KINDS.map((kind) => ({ kind, cents: 999999, rows: Array.from({ length: 2000 }, (_, i) => headlineRow(i)) })),
    },
    health: { issues, notes: [] },
  };
}

function small(): AuditResults {
  return {
    balances: { accounts: [account(1)], notes: [] },
    headline: { month: '2026-10', reportCents: 100, wealthfolioCents: 90, unexplainedCents: 0, notes: [], reasons: [{ kind: 'future', cents: 10, rows: [headlineRow(1)] }] },
    health: { issues: [], notes: [] },
  };
}

describe('buildAuditSnapshot', () => {
  it('is the secret the companion writes and the app reads', () => {
    expect(AUDIT_SNAPSHOT_SECRET_KEY).toBe('audit_snapshot');
  });

  it('keeps a worst case within budget by trimming rows first, saying how many it left out', () => {
    const snap = buildAuditSnapshot(worstCase(), NOW);
    expect(bytes(JSON.stringify(snap))).toBeLessThanOrEqual(AUDIT_SNAPSHOT_MAX_BYTES);
    expect(Object.keys(snap.balances)).toHaveLength(40);
    for (const r of snap.headline.reasons!) {
      expect(r.more).toBeGreaterThan(0);
      expect(r.rows.length + r.more!).toBe(2000);
    }
    expect(snap.health.more).toBeGreaterThan(0);
    expect(snap.health.issues!.length + snap.health.more!).toBe(1000);
  });

  it('leaves a small snapshot whole, keyed by account in mapping order', () => {
    const snap = buildAuditSnapshot(small(), NOW);
    expect(snap).toEqual({
      v: 1, at: '2026-10-13T18:00:00.000Z', balances: { [uuid(1)]: account(1) }, balanceNotes: [],
      headline: small().headline, health: small().health,
    });
  });
});

describe('parseAuditSnapshot', () => {
  it('reads back what the companion wrote', () => {
    const snap = buildAuditSnapshot(small(), NOW);
    expect(parseAuditSnapshot(JSON.stringify(snap))).toEqual({ kind: 'ok', snapshot: snap });
  });

  it('is absent when nothing was published', () => {
    expect(parseAuditSnapshot(null)).toEqual({ kind: 'absent' });
    expect(parseAuditSnapshot(undefined)).toEqual({ kind: 'absent' });
    expect(parseAuditSnapshot('')).toEqual({ kind: 'absent' });
  });

  it('is corrupt — never empty — when it cannot be read', () => {
    const good = buildAuditSnapshot(small(), NOW);
    for (const raw of [
      '{not json',
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, at: 'yesterday' }),
      JSON.stringify({ ...good, balances: [] }),
      JSON.stringify({ ...good, balances: { x: { name: 'A' } } }),
      JSON.stringify({ ...good, headline: { ...good.headline, reasons: [{ kind: 'future', cents: 1 }] } }),
      JSON.stringify({ ...good, health: { issues: 'none', notes: [] } }),
      JSON.stringify({ ...good, health: { issues: [{ kind: 'late-start' }], notes: [] } }),
      'null',
    ]) {
      expect(parseAuditSnapshot(raw)).toEqual({ kind: 'corrupt' });
    }
  });
});

describe('auditSnapshotStatus', () => {
  const at = new Date(2026, 9, 13, 14, 0);
  const ok = parseAuditSnapshot(JSON.stringify(buildAuditSnapshot(small(), at)));

  it('says when a fresh snapshot was taken, in the viewer’s own time', () => {
    expect(auditSnapshotStatus(ok, '1.61.0', new Date(2026, 9, 13, 18, 30))).toEqual({ state: 'fresh', line: 'As of the 2:00 PM sync.' });
    expect(auditSnapshotStatus(ok, '1.61.0', new Date(2026, 9, 14, 9, 0))).toEqual({ state: 'fresh', line: 'As of the Oct 13, 2:00 PM sync.' });
  });

  it('says a snapshot older than two days is from that day', () => {
    expect(auditSnapshotStatus(ok, '1.61.0', new Date(2026, 9, 15, 14, 0, 1))).toEqual({
      state: 'stale', line: "These checks are from Oct 13 — the companion hasn't synced since.",
    });
  });

  it('tells a missing companion from one that has not published yet, and a corrupt snapshot from both', () => {
    expect(auditSnapshotStatus({ kind: 'absent' }, null, at)).toEqual({ state: 'absent', line: AUDIT_NEEDS_COMPANION });
    expect(auditSnapshotStatus({ kind: 'absent' }, '1.60.0', at)).toEqual({ state: 'absent', line: AUDIT_NOT_YET });
    expect(auditSnapshotStatus({ kind: 'corrupt' }, '1.61.0', at)).toEqual({ state: 'corrupt', line: AUDIT_CORRUPT });
    expect(AUDIT_CORRUPT).toBe("Couldn't read the checks — run /audit in Telegram.");
    expect(AUDIT_NEEDS_COMPANION).toBe('These checks need the companion.');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/audit-snapshot.test.ts`
Expected: FAIL — `Failed to resolve import "./audit-snapshot"`; no tests run.

- [ ] **Step 3: Implement**

**Create `shared/audit-snapshot.ts`:**

```ts
/**
 * shared/audit-snapshot.ts
 *
 * The `audit_snapshot` secret (2c R1, spec B2): the three checks as the
 * companion last ran them, for the app, which has no database and cannot run
 * them itself. The companion is its ONLY writer — after each sync,
 * best-effort; a failed publish keeps the previous snapshot. The app reads it
 * corrupt-aware: ok, absent or corrupt, never "empty" for a snapshot it
 * could not read.
 *
 * Size. No limit on an add-on secret is known: Wealthfolio's secrets routes
 * (apps/server/src/api/secrets.rs, v3.8.0) check none and the server sets no
 * body limit, leaving axum's default 2 MB request body as the only ceiling.
 * Like the report cube (REPORT_CUBE_MAX_BYTES = 200_000, kept by trimming
 * history), this keeps itself small on purpose: AUDIT_SNAPSHOT_MAX_BYTES of
 * UTF-8, kept by trimming row lists first — each reason's rows, then
 * Health's issues — and saying how many were left out (`more`).
 */
import type { BalanceExplanation, BalanceReport } from './audit-balance.js';
import type { HeadlineExplanation } from './audit-headline.js';
import type { HealthReport } from './audit-health.js';

export const AUDIT_SNAPSHOT_SECRET_KEY = 'audit_snapshot';
export const AUDIT_SNAPSHOT_MAX_BYTES = 100_000;
/** Older than this, the app says the companion has not synced since. */
export const AUDIT_STALE_MS = 2 * 86_400_000;

export const AUDIT_CORRUPT = "Couldn't read the checks — run /audit in Telegram.";
export const AUDIT_NEEDS_COMPANION = 'These checks need the companion.';
export const AUDIT_NOT_YET = "These checks arrive with the companion's next sync.";

export interface AuditSnapshot {
  v: 1;
  /** ISO: when the companion ran the checks. */
  at: string;
  /** By Wealthfolio account id, in mapping order. */
  balances: Record<string, BalanceExplanation>;
  balanceNotes: string[];
  headline: HeadlineExplanation;
  health: HealthReport;
}

/** What one run of the three checks produced. */
export interface AuditResults {
  balances: BalanceReport;
  headline: HeadlineExplanation;
  health: HealthReport;
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** [rows per reason, Health issues], tried in order until the snapshot fits. */
const CAPS: ReadonlyArray<readonly [number, number]> = [
  [Infinity, Infinity], [50, 200], [20, 100], [10, 50], [5, 20], [2, 10], [0, 5], [0, 0],
];

function trimHeadline(h: HeadlineExplanation, cap: number): HeadlineExplanation {
  if (!h.reasons) return h;
  return {
    ...h,
    reasons: h.reasons.map((r) => (r.rows.length <= cap ? r : { ...r, rows: r.rows.slice(0, cap), more: (r.more ?? 0) + r.rows.length - cap })),
  };
}

function trimHealth(h: HealthReport, cap: number): HealthReport {
  if (!h.issues || h.issues.length <= cap) return h;
  return { ...h, issues: h.issues.slice(0, cap), more: (h.more ?? 0) + h.issues.length - cap };
}

/** The snapshot for one run, trimmed until it fits AUDIT_SNAPSHOT_MAX_BYTES. */
export function buildAuditSnapshot(results: AuditResults, now: Date): AuditSnapshot {
  const balances: Record<string, BalanceExplanation> = {};
  for (const a of results.balances.accounts) balances[a.wfAccountId] = a;
  let snapshot: AuditSnapshot | null = null;
  for (const [rowCap, issueCap] of CAPS) {
    snapshot = {
      v: 1, at: now.toISOString(), balances, balanceNotes: results.balances.notes,
      headline: trimHeadline(results.headline, rowCap), health: trimHealth(results.health, issueCap),
    };
    if (utf8Bytes(JSON.stringify(snapshot)) <= AUDIT_SNAPSHOT_MAX_BYTES) break;
  }
  return snapshot!;
}

export type AuditSnapshotRead =
  | { kind: 'ok'; snapshot: AuditSnapshot }
  | { kind: 'absent' }
  | { kind: 'corrupt' };

const isObject = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const nullOrArray = (x: unknown) => x === null || Array.isArray(x);

/** The stored secret: absent when there is none, corrupt when it is not a
 *  snapshot this version can read, else the snapshot. */
export function parseAuditSnapshot(raw: string | null | undefined): AuditSnapshotRead {
  if (raw === null || raw === undefined || raw === '') return { kind: 'absent' };
  const corrupt = { kind: 'corrupt' } as const;
  let v: any;
  try {
    v = JSON.parse(raw);
  } catch {
    return corrupt;
  }
  if (!isObject(v) || v.v !== 1 || typeof v.at !== 'string' || Number.isNaN(Date.parse(v.at))) return corrupt;
  if (!isObject(v.balances) || !Array.isArray(v.balanceNotes)) return corrupt;
  for (const e of Object.values(v.balances)) {
    if (!isObject(e) || typeof e.wfAccountId !== 'string' || typeof e.name !== 'string' || !isObject(e.bank) || !nullOrArray(e.causes)) return corrupt;
  }
  const h = v.headline;
  if (!isObject(h) || typeof h.month !== 'string' || !nullOrArray(h.reasons) || !Array.isArray(h.notes)) return corrupt;
  for (const r of h.reasons ?? []) {
    if (!isObject(r) || typeof r.kind !== 'string' || typeof r.cents !== 'number' || !Array.isArray(r.rows)) return corrupt;
  }
  const health = v.health;
  if (!isObject(health) || !nullOrArray(health.issues) || !Array.isArray(health.notes)) return corrupt;
  for (const i of health.issues ?? []) {
    if (!isObject(i) || typeof i.kind !== 'string' || typeof i.key !== 'string') return corrupt;
  }
  return { kind: 'ok', snapshot: v as AuditSnapshot };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const localDay = (d: Date) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
const localClock = (d: Date) => {
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/** Where the app's checks came from, in one line, in the viewer's own zone. */
export function auditSnapshotStatus(
  read: AuditSnapshotRead, companionVersion: string | null, now: Date,
): { state: 'fresh' | 'stale' | 'absent' | 'corrupt'; line: string } {
  if (read.kind === 'corrupt') return { state: 'corrupt', line: AUDIT_CORRUPT };
  if (read.kind === 'absent') return { state: 'absent', line: companionVersion ? AUDIT_NOT_YET : AUDIT_NEEDS_COMPANION };
  const at = new Date(read.snapshot.at);
  if (now.getTime() - at.getTime() > AUDIT_STALE_MS) {
    return { state: 'stale', line: `These checks are from ${localDay(at)} — the companion hasn't synced since.` };
  }
  const sameDay = at.toDateString() === now.toDateString();
  return { state: 'fresh', line: `As of the ${sameDay ? '' : `${localDay(at)}, `}${localClock(at)} sync.` };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/audit-snapshot.test.ts`
Expected: PASS — 9 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/audit-snapshot.ts shared/audit-snapshot.test.ts
git commit -m "Audits: the snapshot the app reads — built within 100 KB, read corrupt-aware

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The companion gathers the facts — strict database reads, Wealthfolio's two figures, each read on its own

The companion's half of B2 (X1b, X1c, X5, X6). `companion/src/sqlite-audit.ts` holds three STRICT readers over the read-only database, each throwing `NativeDbUnreadableError` rather than answering `[]` for a database it could not read: the ledger (every account with its archived and active flags, every activity with Health's override type — a blank override is none — its raw type, status, amount, group, asset, whether its metadata says `flow.is_external: true`, and whether its asset is the phantom `$CASH`), the month's rows as `audit-headline.mjs` reads them (plus each row's earliest spending filing), and the settings the month needs (Wealthfolio's timezone, `spending.excluded_category_ids` — none when absent, as on 3.8 — and every spending category's parent). They need `queryNativeDbStrict`, now exported. `WealthfolioClient.getSpendingInsightSpent` reads Wealthfolio's Spending page figure. `companion/src/audit-facts.ts` wraps EVERY read on its own (`gather*Facts`, each failure named in `failed` for the shared module to word), shares one ledger read between the balance and Health checks (`runAudit`), and publishes the snapshot (`publishAuditSnapshot`) — writing nothing when not even the account mapping can be read, so the previous snapshot stays. All reads sit behind `AuditReaders`, so the tests fake each in its real shape.

**Files:**
- Create: `companion/src/sqlite-audit.ts`, `companion/src/sqlite-audit.test.ts`, `companion/src/audit-facts.ts`, `companion/src/audit-facts.test.ts`, `companion/src/wealthfolio-insight.test.ts`
- Modify: `companion/src/sqlite-native.ts`, `companion/src/wealthfolio.ts`

**Interfaces:**
- Consumes: Tasks 1–4 (`explainBalances`, `BalanceFacts`, `BalanceRead`; `explainHeadline`, `zonedMonthBounds`, `HeadlineDbRow`, `HeadlineFacts`, `HeadlineRead`; `healthIssues`, `HealthFacts`, `HealthRead`; `AuditLedger`; `AUDIT_SNAPSHOT_SECRET_KEY`, `buildAuditSnapshot`, `AuditResults`); `monthlySpendTotals`, `parseReportCube`, `REPORT_CUBE_SECRET_KEY` (shared/report-cube.ts); `DRILL_CLI_SEPARATOR`, `NativeDbUnreadableError` (sqlite-native.ts).
- Produces:

```ts
// companion/src/sqlite-native.ts
export function queryNativeDbStrict<Row>(dbPath: string, label: string, query: string, fromCliParts: (parts: string[]) => Row | null, separator?: string): Row[];
// companion/src/wealthfolio.ts
getSpendingInsightSpent(startDate: string, endDate: string): Promise<number>;   // dollars; rejects without headline.spent
// companion/src/sqlite-audit.ts
export const PHANTOM_CASH_ASSET_ID = '9231cb80-4223-4c04-98e3-dd3b1af60311';
export function getNativeAuditLedger(dbPath: string): AuditLedger;
export function getNativeHeadlineRows(dbPath: string, startInclusive: string, endExclusive: string): HeadlineDbRow[];
export function getNativeAuditSettings(dbPath: string): { timezone: string | null; excludedCategoryIds: string[]; categoryParents: Record<string, string | null> };
export function auditAccountFromCliParts(parts: string[]): Record<string, unknown> | null;
export function auditRowFromCliParts(parts: string[]): Record<string, unknown> | null;
export function headlineRowFromCliParts(parts: string[]): Record<string, unknown> | null;
// companion/src/audit-facts.ts
export interface AuditReaders {
  secret(key: string): Promise<string | null>;
  valuations(): Promise<Array<{ accountId: string; totalValue: string | number }>>;
  ledger(): AuditLedger;
  headlineRows(startInclusive: string, endExclusive: string): HeadlineDbRow[];
  settings(): { timezone: string | null; excludedCategoryIds: string[]; categoryParents: Record<string, string | null> };
  spendingSpent(startIso: string, endIso: string): Promise<number>;
}
export type AuditClient = Pick<WealthfolioClient, 'getAddonSecret' | 'getLatestValuations' | 'getSpendingInsightSpent'>;
export function companionAuditReaders(client: AuditClient, dbPath: string): AuditReaders;
export function readAuditLedger(r: AuditReaders): AuditLedger | undefined;
export function gatherBalanceFacts(r: AuditReaders, ledger: AuditLedger | undefined): Promise<BalanceFacts>;
export function gatherHeadlineFacts(r: AuditReaders, now: Date): Promise<HeadlineFacts>;
export function gatherHealthFacts(r: AuditReaders, ledger: AuditLedger | undefined): Promise<HealthFacts>;
export function runAudit(r: AuditReaders, now: Date): Promise<AuditResults & { reached: boolean }>;
export type AuditPublishClient = AuditClient & Pick<WealthfolioClient, 'setAddonSecret'>;
export function publishAuditSnapshot(client: AuditPublishClient, dbPath: string, now: Date, readers?: AuditReaders): Promise<boolean>;
```

- [ ] **Step 1: Write the failing tests**

**Create `companion/src/sqlite-audit.test.ts`:**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  auditAccountFromCliParts, auditRowFromCliParts, getNativeAuditLedger, getNativeAuditSettings, getNativeHeadlineRows,
  headlineRowFromCliParts, PHANTOM_CASH_ASSET_ID,
} from './sqlite-audit.js';
import { NativeDbUnreadableError } from './sqlite-native.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real tables and column names, only the columns these readers touch. */
function ledger(settings = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-audit-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT, is_archived BOOLEAN NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT 1);
    CREATE TABLE activities (id TEXT PRIMARY KEY, account_id TEXT, activity_type TEXT, activity_type_override TEXT, subtype TEXT,
      status TEXT, activity_date TEXT, amount TEXT, currency TEXT, asset_id TEXT, metadata TEXT, notes TEXT, source_group_id TEXT);
    CREATE TABLE assets (id TEXT PRIMARY KEY, display_code TEXT, instrument_symbol TEXT, name TEXT);
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, taxonomy_id TEXT, name TEXT, parent_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (id TEXT, activity_id TEXT, taxonomy_id TEXT, category_id TEXT, weight INTEGER, source TEXT, created_at TEXT);
    INSERT INTO accounts VALUES ('wf-chk', 'PNC Checking', 'cash', 0, 1), ('wf-ally', 'Ally Savings', 'CASH', 1, 0);
    INSERT INTO assets VALUES ('cash-by-code', '$CASH', NULL, 'Cash'), ('AAPL', 'AAPL', 'AAPL', 'Apple');
    INSERT INTO activities VALUES
      ('act-1', 'wf-chk', 'TRANSFER_OUT', NULL, NULL, NULL, '2026-10-04T00:00:00+00:00', '600', 'usd', NULL, '{"flow":{"is_external":true}}', 'TRANSFER TO ALLY · TRN-1', NULL),
      ('act-2', 'wf-chk', 'DEPOSIT', 'TRANSFER_IN', 'refund', 'posted', '2026-10-05T04:00:00+00:00', '12.35', 'USD', 'cash-by-code', '{"flow":{"is_external":false}}', 'A | B · TRN-2', 'g1'),
      ('act-3', 'wf-ally', 'WITHDRAWAL', NULL, NULL, 'PENDING', '2026-09-30T00:00:00+00:00', '-9.99', 'USD', '${PHANTOM_CASH_ASSET_ID}', 'not json', NULL, NULL),
      ('act-4', 'wf-chk', 'WITHDRAWAL', '  ', NULL, NULL, '2026-11-01T00:00:00+00:00', '5', 'USD', 'AAPL', '{"flow":{"is_external":"true"}}', 'LATE · TRN-4', NULL);
    INSERT INTO taxonomy_categories VALUES ('cat-a', 'spending_categories', 'Food', NULL), ('cat-b', 'spending_categories', 'Fun', 'cat-a'), ('inc', 'income_sources', 'Pay', NULL);
    INSERT INTO activity_taxonomy_assignments VALUES
      ('x1', 'act-2', 'spending_categories', 'cat-a', 10000, 'rule', '2026-10-06T00:00:00Z'),
      ('x2', 'act-2', 'spending_categories', 'cat-b', 10000, 'manual', '2026-10-05T09:00:00Z'),
      ('x3', 'act-2', 'income_sources', 'inc', 10000, 'manual', '2026-10-01T00:00:00Z');
  `);
  if (settings) {
    db.exec(`
      CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT);
      INSERT INTO app_settings VALUES ('timezone', 'America/New_York'), ('spending.excluded_category_ids', '["cat-a", 5, "cat-b"]'), ('theme', 'dark');
    `);
  }
  db.close();
  return path;
}

describe('getNativeAuditLedger', () => {
  it('reads every account and every row, the override type for Health (a blank one is none) and the raw type for cash', () => {
    const { accounts, rows } = getNativeAuditLedger(ledger());
    expect(accounts).toEqual([
      { id: 'wf-ally', type: 'CASH', archived: true, active: false, name: 'Ally Savings' },
      { id: 'wf-chk', type: 'CASH', archived: false, active: true, name: 'PNC Checking' },
    ]);
    expect(rows).toEqual([
      {
        id: 'act-3', accountId: 'wf-ally', date: '2026-09-30', currency: 'USD', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', status: 'PENDING',
        absCents: 999, group: '', assetId: PHANTOM_CASH_ASSET_ID, external: false, phantomCash: true, notes: '',
      },
      {
        id: 'act-1', accountId: 'wf-chk', date: '2026-10-04', currency: 'USD', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', status: 'POSTED',
        absCents: 60000, group: '', assetId: '', external: true, phantomCash: false, notes: 'TRANSFER TO ALLY · TRN-1',
      },
      {
        id: 'act-2', accountId: 'wf-chk', date: '2026-10-05', currency: 'USD', rawType: 'DEPOSIT', type: 'TRANSFER_IN', status: 'POSTED',
        absCents: 1235, group: 'g1', assetId: 'cash-by-code', external: false, phantomCash: true, notes: 'A | B · TRN-2',
      },
      {
        id: 'act-4', accountId: 'wf-chk', date: '2026-11-01', currency: 'USD', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', status: 'POSTED',
        absCents: 500, group: '', assetId: 'AAPL', external: false, phantomCash: false, notes: 'LATE · TRN-4',
      },
    ]);
  });

  it('throws — unknown, never "nothing" — when the database cannot be read', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => getNativeAuditLedger('/nope/wealthfolio.db')).toThrow(NativeDbUnreadableError);
      expect(() => getNativeAuditLedger('')).toThrow(NativeDbUnreadableError);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('getNativeHeadlineRows', () => {
  it('reads the month’s rows in every account, with their spending filings and every category', () => {
    const rows = getNativeHeadlineRows(ledger(), '2026-10-01', '2026-11-01');
    expect(rows.map((r) => r.id)).toEqual(['act-1', 'act-2']);
    const two = rows[1];
    expect({ ...two, categoryIds: [...two.categoryIds].sort() }).toEqual({
      id: 'act-2', date: '2026-10-05T04:00:00+00:00', accountType: 'CASH', type: 'DEPOSIT', subtype: 'REFUND', absCents: 1235,
      spendingFilings: 2, categoryIds: ['cat-a', 'cat-b', 'inc'], spendingCategoryId: 'cat-b', accountName: 'PNC Checking', notes: 'A | B · TRN-2',
    });
    expect(rows[0]).toMatchObject({ spendingFilings: 0, categoryIds: [], spendingCategoryId: null });
  });

  it('refuses malformed bounds, and throws when the database cannot be read', () => {
    expect(() => getNativeHeadlineRows(ledger(), "2026-10-01' OR 1=1 --", '2026-11-01')).toThrow(/malformed month bounds/);
    expect(() => getNativeHeadlineRows('/nope/wealthfolio.db', '2026-10-01', '2026-11-01')).toThrow(NativeDbUnreadableError);
  });
});

describe('getNativeAuditSettings', () => {
  it('reads Wealthfolio’s timezone, the categories it excludes and each spending category’s parent', () => {
    expect(getNativeAuditSettings(ledger())).toEqual({
      timezone: 'America/New_York', excludedCategoryIds: ['cat-a', 'cat-b'], categoryParents: { 'cat-a': null, 'cat-b': 'cat-a' },
    });
  });

  it('reads an unset or unparseable setting as none, and a missing table as unreadable', () => {
    const path = ledger();
    const db = new DatabaseSync(path);
    db.exec(`DELETE FROM app_settings WHERE setting_key = 'timezone'; UPDATE app_settings SET setting_value = '[oops' WHERE setting_key = 'spending.excluded_category_ids';`);
    db.close();
    expect(getNativeAuditSettings(path)).toMatchObject({ timezone: null, excludedCategoryIds: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => getNativeAuditSettings(ledger(false))).toThrow(NativeDbUnreadableError);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('the CLI fallback parsers split on the unit separator', () => {
  it('keeps a separator or a | inside the last column, and drops a shifted line', () => {
    const row = ['act-1', 'wf-chk', '2026-10-04', 'USD', 'TRANSFER_OUT', 'TRANSFER_OUT', 'POSTED', '60000', '', '', 'true', '0', 'A\x1fB | C'];
    expect(auditRowFromCliParts(row)).toMatchObject({ c0: 'act-1', c7: '60000', c12: 'A\x1fB | C' });
    expect(auditRowFromCliParts(['act-1', 'x'])).toBeNull();
    expect(auditRowFromCliParts([...row.slice(0, 7), 'oops', ...row.slice(8)])).toBeNull();
    expect(auditAccountFromCliParts(['wf-chk', 'CASH', '0', '1', 'Joe\x1fCo'])).toEqual({ c0: 'wf-chk', c1: 'CASH', c2: '0', c3: '1', c4: 'Joe\x1fCo' });
    const month = ['act-2', '2026-10-05', 'CASH', 'DEPOSIT', '', '1235', '2', 'cat-a,cat-b', 'cat-b', 'PNC', 'A | B'];
    expect(headlineRowFromCliParts(month)).toMatchObject({ c5: '1235', c8: 'cat-b', c10: 'A | B' });
    expect(headlineRowFromCliParts(month.slice(0, 5))).toBeNull();
  });
});
```

**Create `companion/src/audit-facts.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  gatherHeadlineFacts, publishAuditSnapshot, runAudit, type AuditPublishClient, type AuditReaders,
} from './audit-facts.js';
import { BALANCE_READ_NOTES } from '../../shared/audit-balance.js';
import { HEADLINE_READ_NOTES } from '../../shared/audit-headline.js';
import { HEALTH_READ_NOTES } from '../../shared/audit-health.js';
import type { AuditLedger, AuditLedgerRow } from '../../shared/audit-ledger.js';
import { AUDIT_SNAPSHOT_SECRET_KEY, parseAuditSnapshot } from '../../shared/audit-snapshot.js';
import type { ReportCube } from '../../shared/report-cube.js';

/** Midday, local: this month is October wherever the suite runs. */
const NOW = new Date(2026, 9, 13, 12, 0);

const row = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
  id: 'r', accountId: 'wf-chk', date: '2026-10-01', currency: 'USD', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', status: 'POSTED',
  absCents: 0, group: '', assetId: '', external: false, phantomCash: false, notes: 'ROW · TRN-0', ...over,
});
const LEDGER: AuditLedger = {
  accounts: [{ id: 'wf-chk', name: 'Checking', type: 'CASH', archived: false }, { id: 'wf-ally', name: 'Ally', type: 'CASH', archived: false }],
  rows: [
    row({ id: 'p1', absCents: 1910, notes: 'COFFEE · TRN-7 · pending' }),
    row({ id: 'p2', absCents: 1910, notes: 'LUNCH · TRN-8 · pending' }),
    row({ id: 'out', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', absCents: 60000, date: '2026-10-04', notes: 'TO ALLY · TRN-1' }),
  ],
};
const CUBE: ReportCube = {
  version: 1, asOf: NOW.toISOString(), months: ['2026-10'], categories: ['Food'],
  accounts: [{ sfinId: 'sfin-chk', name: 'PNC Checking', type: 'CASH' }],
  spend: [[[100000]]], uncategorized: [[30000]], income: [[0]], budgets: [[0]], merchants: [[]], feesInterest: [0],
  netWorth: [null], liquid: [null], pool: null,
};
const SECRETS: Record<string, string> = {
  account_mapping: JSON.stringify({ 'sfin-chk': 'wf-chk' }),
  account_balances: JSON.stringify({ 'sfin-chk': { balance: 2481.07, date: Date.parse('2026-10-13T12:00:00Z') / 1000 } }),
  account_names: JSON.stringify({ 'sfin-chk': 'PNC Checking' }),
  report_cube: JSON.stringify(CUBE),
};

function readers(over: Partial<AuditReaders> = {}): AuditReaders {
  return {
    secret: async (key) => SECRETS[key] ?? null,
    valuations: async () => [{ accountId: 'wf-chk', totalValue: '2431.07' }],
    ledger: () => LEDGER,
    headlineRows: () => [],
    settings: () => ({ timezone: 'America/New_York', excludedCategoryIds: [], categoryParents: {} }),
    spendingSpent: async () => 1200,
    ...over,
  };
}
const failingSecret = (key: string): Partial<AuditReaders> => ({
  secret: async (k) => { if (k === key) throw new Error('401'); return SECRETS[k] ?? null; },
});
const boom = () => { throw new Error('database is locked'); };

describe('runAudit', () => {
  it('explains the balances, the month and Health from one ledger read', async () => {
    const ledger = vi.fn(() => LEDGER);
    const out = await runAudit(readers({ ledger }), NOW);
    expect(ledger).toHaveBeenCalledTimes(1);
    expect(out.reached).toBe(true);
    expect(out.balances.accounts[0]).toMatchObject({ name: 'PNC Checking', offCents: 5000, causes: [{ kind: 'pending', cents: 3820, count: 2 }], unexplainedCents: 1180 });
    expect(out.headline).toMatchObject({ month: '2026-10', reportCents: 130000, wealthfolioCents: 120000, reasons: [], unexplainedCents: 10000 });
    expect(out.health.issues).toMatchObject([{ kind: 'incomplete-leg', key: 'leg:out', match: 'none' }]);
    expect([...out.balances.notes, ...out.headline.notes, ...out.health.notes]).toEqual([]);
  });

  it.each<[string, Partial<AuditReaders>, () => [string[], string[], string[]]]>([
    ['the account mapping', failingSecret('account_mapping'), () => [[BALANCE_READ_NOTES.mapping], [], [HEALTH_READ_NOTES.mapping]]],
    ['the bank balances', failingSecret('account_balances'), () => [[BALANCE_READ_NOTES.balances], [], []]],
    ['the account names', failingSecret('account_names'), () => [[BALANCE_READ_NOTES.names], [], []]],
    ['the report cube', failingSecret('report_cube'), () => [[], [HEADLINE_READ_NOTES.report], []]],
    ['the valuations', { valuations: async () => { throw new Error('502'); } }, () => [[BALANCE_READ_NOTES.valuations], [], []]],
    ['the ledger', { ledger: boom }, () => [[BALANCE_READ_NOTES.ledger], [], [HEALTH_READ_NOTES.ledger]]],
    ['the month’s rows', { headlineRows: boom }, () => [[], [HEADLINE_READ_NOTES.ledger], []]],
    ['the settings', { settings: boom }, () => [[], [HEADLINE_READ_NOTES.settings], []]],
    ['the Spending page', { spendingSpent: async () => { throw new Error('404'); } }, () => [[], [HEADLINE_READ_NOTES.wealthfolio], []]],
  ])('a failed read of %s becomes its note and costs only its own part', async (_what, over, notes) => {
    const out = await runAudit(readers(over), NOW);
    expect([out.balances.notes, out.headline.notes, out.health.notes]).toEqual(notes());
  });

  it('is unreachable when not even the account mapping can be read', async () => {
    expect((await runAudit(readers(failingSecret('account_mapping')), NOW)).reached).toBe(false);
  });
});

describe('gatherHeadlineFacts', () => {
  it('asks Wealthfolio for this calendar month in its own timezone, and reads the month’s rows', async () => {
    const spendingSpent = vi.fn(async () => 1301.4);
    const headlineRows = vi.fn(() => []);
    const facts = await gatherHeadlineFacts(readers({ spendingSpent, headlineRows }), NOW);
    expect(spendingSpent).toHaveBeenCalledWith('2026-10-01T04:00:00.000Z', '2026-11-01T03:59:59.999Z');
    expect(headlineRows).toHaveBeenCalledWith('2026-10-01', '2026-11-01');
    expect(facts).toMatchObject({ month: '2026-10', today: '2026-10-13', reportCents: 130000, wealthfolioCents: 130140, excludedCategoryIds: [] });
  });

  it('takes the report’s figure only from a cube built this month', async () => {
    const stale = { ...CUBE, months: ['2026-09'] };
    const facts = await gatherHeadlineFacts(readers({ secret: async (k) => (k === 'report_cube' ? JSON.stringify(stale) : SECRETS[k] ?? null) }), NOW);
    expect(facts.reportCents).toBeUndefined();
    expect(facts.failed).toEqual(['report']);
  });
});

describe('publishAuditSnapshot', () => {
  const client = (set = vi.fn(async () => {})) => ({ setAddonSecret: set } as unknown as AuditPublishClient);

  it('writes a snapshot the app can read', async () => {
    const set = vi.fn(async () => {});
    expect(await publishAuditSnapshot(client(set), '/db', NOW, readers())).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
    const [addon, key, value] = set.mock.calls[0] as unknown as [string, string, string];
    expect([addon, key]).toEqual(['simplefin-sync', AUDIT_SNAPSHOT_SECRET_KEY]);
    const read = parseAuditSnapshot(value);
    expect(read.kind).toBe('ok');
    if (read.kind === 'ok') {
      expect(read.snapshot.at).toBe(NOW.toISOString());
      expect(Object.keys(read.snapshot.balances)).toEqual(['wf-chk']);
    }
  });

  it('writes nothing when Wealthfolio cannot be reached, so the previous snapshot stays', async () => {
    const set = vi.fn(async () => {});
    expect(await publishAuditSnapshot(client(set), '/db', NOW, readers(failingSecret('account_mapping')))).toBe(false);
    expect(set).not.toHaveBeenCalled();
  });

  it('rejects when the write fails, for the sync to log', async () => {
    const set = vi.fn(async () => { throw new Error('500'); });
    await expect(publishAuditSnapshot(client(set), '/db', NOW, readers())).rejects.toThrow('500');
  });
});
```

**Create `companion/src/wealthfolio-insight.test.ts`:**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WealthfolioClient } from './wealthfolio.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
beforeEach(() => mockFetch.mockReset());

describe('WealthfolioClient.getSpendingInsightSpent', () => {
  it('POSTs the window to /spending/insight and returns the headline’s spent', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ headline: { spent: 1301.4, income: 9 } }) });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    expect(await client.getSpendingInsightSpent('2026-10-01T04:00:00.000Z', '2026-11-01T03:59:59.999Z')).toBe(1301.4);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/spending/insight');
    expect((opts as any).method).toBe('POST');
    expect(JSON.parse((opts as any).body)).toEqual({ startDate: '2026-10-01T04:00:00.000Z', endDate: '2026-11-01T03:59:59.999Z' });
  });

  it('rejects an error status or a reply without a figure, rather than reading it as $0', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found', text: async () => 'no route' });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    await expect(client.getSpendingInsightSpent('a', 'b')).rejects.toThrow();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ headline: {} }) });
    await expect(client.getSpendingInsightSpent('a', 'b')).rejects.toThrow(/headline.spent/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/sqlite-audit.test.ts src/audit-facts.test.ts src/wealthfolio-insight.test.ts`
Expected: FAIL — `Cannot find module './sqlite-audit.js'` and `'./audit-facts.js'`, and both insight tests fail (`client.getSpendingInsightSpent is not a function`).

- [ ] **Step 3: Implement**

Edit 1 of 1 in `companion/src/sqlite-native.ts` — replace:

```ts
}

/** `queryNativeDb`, except a database that is not there or that every path
 *  failed to read throws `NativeDbUnreadableError`. */
function queryNativeDbStrict<Row>(
  dbPath: string,
  label: string,
  query: string,
```

with:

```ts
}

/** `queryNativeDb`, except a database that is not there or that every path
 *  failed to read throws `NativeDbUnreadableError`. Exported for the audits'
 *  readers (sqlite-audit.ts, 2c). */
export function queryNativeDbStrict<Row>(
  dbPath: string,
  label: string,
  query: string,
```

Edit 1 of 1 in `companion/src/wealthfolio.ts` — replace:

```ts
    });
    if (!res.ok) throw await this.httpError('getLatestValuations', res);
    return res.json() as Promise<Array<{ accountId: string; totalValue: string | number }>>;
  }

  /** Marks two activities as one internal transfer (shared source_group_id). */
```

with:

```ts
    });
    if (!res.ok) throw await this.httpError('getLatestValuations', res);
    return res.json() as Promise<Array<{ accountId: string; totalValue: string | number }>>;
  }

  /**
   * What Wealthfolio's Spending page counts as spent between two instants
   * (`POST /spending/insight`, upstream `SpendingInsightRequest` →
   * `SpendingInsight.headline.spent`, Wealthfolio 3.8), in the base currency.
   * The page sends its "This month" as the calendar month in its timezone,
   * RFC 3339, both ends inclusive.
   */
  async getSpendingInsightSpent(startDate: string, endDate: string): Promise<number> {
    const res = await fetch(`${this.baseUrl}/api/v1/spending/insight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ startDate, endDate }),
    });
    if (!res.ok) throw await this.httpError('getSpendingInsight', res);
    const body = (await res.json()) as { headline?: { spent?: unknown } } | null;
    const spent = body?.headline?.spent;
    if (typeof spent !== 'number' || !Number.isFinite(spent)) throw new Error('getSpendingInsight: the reply carried no headline.spent');
    return spent;
  }

  /** Marks two activities as one internal transfer (shared source_group_id). */
```

**Create `companion/src/sqlite-audit.ts`:**

```ts
/**
 * companion/src/sqlite-audit.ts
 *
 * The audits' database reads (2c), in a focused file beside sqlite-native.ts
 * (already ~1,900 lines). Strict like the story readers: each throws
 * NativeDbUnreadableError rather than answering [] for a database it could
 * not read, because a check must say "couldn't read", never "nothing wrong".
 *
 * Ported from companion/tools: the row read is audit-health.mjs part 1's
 * (`activity_type_override`, `status`, `metadata`, `asset_id`) with
 * fix-transfers.mjs's archived flag and its `$CASH` asset test; the month
 * read and the settings are audit-headline.mjs's. Every table and column
 * read here is the same on Wealthfolio 3.8, 3.9 and 3.10; a blank override
 * reads as none, and the excluded-categories setting (3.9+) as none when it
 * is not there.
 *
 * The sqlite3 CLI fallback splits on the unit separator, with the free text
 * (a name, a note) last, so a separator inside it cannot shift the columns.
 */
import type { AuditAccount, AuditLedger, AuditLedgerRow } from '../../shared/audit-ledger.js';
import type { HeadlineDbRow } from '../../shared/audit-headline.js';
import { DRILL_CLI_SEPARATOR, queryNativeDbStrict } from './sqlite-native.js';

/** The `$CASH` security the July 2026 bulk import minted (audit-health.mjs). */
export const PHANTOM_CASH_ASSET_ID = '9231cb80-4223-4c04-98e3-dd3b1af60311';

const SEP = DRILL_CLI_SEPARATOR;
const tail = (parts: string[], from: number) => parts.slice(from).join(SEP);
const isTrue = (v: unknown) => String(v) === '1' || String(v).toLowerCase() === 'true';

/** CLI line → the account read's columns (the name last). */
export function auditAccountFromCliParts(parts: string[]): Record<string, unknown> | null {
  return parts.length >= 5 ? { c0: parts[0], c1: parts[1], c2: parts[2], c3: parts[3], c4: tail(parts, 4) } : null;
}

/** CLI line → the ledger read's thirteen columns (the note last). */
export function auditRowFromCliParts(parts: string[]): Record<string, unknown> | null {
  if (parts.length < 13 || !Number.isFinite(parseFloat(parts[7]))) return null;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < 12; i++) out[`c${i}`] = parts[i];
  out.c12 = tail(parts, 12);
  return out;
}

/** CLI line → the month read's eleven columns (the note last). */
export function headlineRowFromCliParts(parts: string[]): Record<string, unknown> | null {
  if (parts.length < 11 || !Number.isFinite(parseFloat(parts[5]))) return null;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < 10; i++) out[`c${i}`] = parts[i];
  out.c10 = tail(parts, 10);
  return out;
}

/** Every account and every activity, oldest first. */
export function getNativeAuditLedger(dbPath: string): AuditLedger {
  const accounts = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'audit accounts',
    `SELECT acc.id AS id, UPPER(COALESCE(acc.account_type, '')) AS account_type,
            COALESCE(acc.is_archived, 0) AS archived, COALESCE(acc.is_active, 1) AS active, COALESCE(acc.name, '') AS name
     FROM accounts acc ORDER BY acc.id;`,
    auditAccountFromCliParts,
    SEP,
  );
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'audit ledger',
    `SELECT a.id AS id, a.account_id AS account_id, substr(a.activity_date, 1, 10) AS d,
            UPPER(COALESCE(a.currency, '')) AS ccy,
            UPPER(COALESCE(a.activity_type, '')) AS raw_type,
            UPPER(COALESCE(NULLIF(TRIM(a.activity_type_override), ''), a.activity_type, '')) AS t,
            UPPER(COALESCE(a.status, 'POSTED')) AS status,
            ROUND(ABS(CAST(COALESCE(a.amount, '0') AS REAL)) * 100) AS abs_cents,
            COALESCE(a.source_group_id, '') AS g,
            COALESCE(a.asset_id, '') AS asset,
            CASE WHEN json_valid(COALESCE(a.metadata, ''))
                 THEN COALESCE(json_type(a.metadata, '$.flow.is_external'), '') ELSE '' END AS ext,
            CASE WHEN COALESCE(a.asset_id, '') <> '' AND (a.asset_id = '${PHANTOM_CASH_ASSET_ID}' OR a.asset_id IN (
                   SELECT id FROM assets WHERE UPPER(COALESCE(display_code, instrument_symbol, name, id)) = '$CASH'))
                 THEN 1 ELSE 0 END AS phantom,
            COALESCE(a.notes, '') AS notes
     FROM activities a
     ORDER BY a.activity_date, a.id;`,
    auditRowFromCliParts,
    SEP,
  );
  return {
    accounts: accounts.map((r): AuditAccount => {
      const v = Object.values(r);
      return { id: String(v[0]), type: String(v[1] ?? ''), archived: isTrue(v[2]), active: isTrue(v[3]), name: String(v[4] ?? '') };
    }),
    rows: rows.map((r): AuditLedgerRow => {
      const v = Object.values(r);
      return {
        id: String(v[0]), accountId: String(v[1]), date: String(v[2]), currency: String(v[3] ?? ''),
        rawType: String(v[4] ?? ''), type: String(v[5] ?? ''), status: String(v[6] ?? 'POSTED'),
        absCents: Math.round(Number(v[7]) || 0), group: String(v[8] ?? ''), assetId: String(v[9] ?? ''),
        external: String(v[10]) === 'true', phantomCash: isTrue(v[11]), notes: String(v[12] ?? ''),
      };
    }),
  };
}

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** The month's activities, every account, as audit-headline.mjs reads them:
 *  `[startInclusive, endExclusive)`, both YYYY-MM-DD. */
export function getNativeHeadlineRows(dbPath: string, startInclusive: string, endExclusive: string): HeadlineDbRow[] {
  // Interpolated (the CLI fallback cannot bind), so validated, never trusted.
  if (!isDay(startInclusive) || !isDay(endExclusive)) throw new Error(`malformed month bounds: ${startInclusive}..${endExclusive}`);
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'audit month',
    `SELECT a.id AS id, a.activity_date AS activity_date, UPPER(COALESCE(acc.account_type, '')) AS account_type,
            UPPER(COALESCE(a.activity_type, '')) AS activity_type, UPPER(COALESCE(a.subtype, '')) AS subtype,
            ROUND(ABS(CAST(COALESCE(a.amount, '0') AS REAL)) * 100) AS abs_cents,
            (SELECT COUNT(*) FROM activity_taxonomy_assignments ata JOIN taxonomy_categories tc ON ata.category_id = tc.id
              WHERE ata.activity_id = a.id AND tc.taxonomy_id = 'spending_categories') AS spending_filings,
            COALESCE((SELECT group_concat(ata.category_id, ',') FROM activity_taxonomy_assignments ata
              WHERE ata.activity_id = a.id), '') AS category_ids,
            COALESCE((SELECT ata.category_id FROM activity_taxonomy_assignments ata
              WHERE ata.activity_id = a.id AND ata.taxonomy_id = 'spending_categories'
              ORDER BY ata.created_at, ata.id LIMIT 1), '') AS spending_category,
            COALESCE(acc.name, '') AS account_name,
            COALESCE(a.notes, '') AS notes
     FROM activities a JOIN accounts acc ON a.account_id = acc.id
     WHERE a.activity_date >= '${startInclusive}' AND a.activity_date < '${endExclusive}'
     ORDER BY a.activity_date, a.id;`,
    headlineRowFromCliParts,
    SEP,
  );
  return rows.map((r) => {
    const v = Object.values(r);
    const ids = String(v[7] ?? '');
    return {
      id: String(v[0]), date: String(v[1]), accountType: String(v[2] ?? ''), type: String(v[3] ?? ''),
      subtype: String(v[4] ?? ''), absCents: Math.round(Number(v[5]) || 0), spendingFilings: Number(v[6]) || 0,
      categoryIds: ids ? ids.split(',') : [], spendingCategoryId: String(v[8] ?? '') || null,
      accountName: String(v[9] ?? ''), notes: String(v[10] ?? ''),
    };
  });
}

/** What the headline check needs besides the rows: Wealthfolio's timezone
 *  (null when unset), the categories it excludes from spending ([] when unset
 *  — Wealthfolio 3.8 has no such setting — or unparseable, as
 *  audit-headline.mjs reads it), and each spending category's parent, so an
 *  excluded category's descendants count too (3.9+). */
export function getNativeAuditSettings(dbPath: string): {
  timezone: string | null; excludedCategoryIds: string[]; categoryParents: Record<string, string | null>;
} {
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'audit settings',
    `SELECT setting_key AS k, COALESCE(setting_value, '') AS v FROM app_settings
     WHERE setting_key IN ('timezone', 'spending.excluded_category_ids') ORDER BY setting_key;`,
    (parts) => (parts.length >= 2 ? { c0: parts[0], c1: tail(parts, 1) } : null),
    SEP,
  );
  const value = new Map(rows.map((r) => {
    const v = Object.values(r);
    return [String(v[0]), String(v[1] ?? '')];
  }));
  let excludedCategoryIds: string[] = [];
  try {
    const parsed = JSON.parse(value.get('spending.excluded_category_ids') || '[]');
    if (Array.isArray(parsed)) excludedCategoryIds = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    /* unparseable: none, as the script reads it */
  }
  const parents = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'audit categories',
    `SELECT id AS id, COALESCE(parent_id, '') AS parent FROM taxonomy_categories
     WHERE taxonomy_id = 'spending_categories' ORDER BY id;`,
    (parts) => (parts.length >= 2 ? { c0: parts[0], c1: parts[1] } : null),
    SEP,
  );
  const categoryParents: Record<string, string | null> = {};
  for (const r of parents) {
    const v = Object.values(r);
    categoryParents[String(v[0])] = String(v[1] ?? '') || null;
  }
  return { timezone: value.get('timezone') || null, excludedCategoryIds, categoryParents };
}
```

**Create `companion/src/audit-facts.ts`:**

```ts
/**
 * companion/src/audit-facts.ts
 *
 * Gathers the three checks' facts (2c R1, spec B2) and publishes the
 * snapshot the app reads. Every read is wrapped on its own: a failure is
 * named in that check's `failed` (the shared module words the note) and
 * leaves out only its own part — never "nothing wrong".
 *
 * Where each fact comes from:
 *  - account_mapping, account_balances, account_names and the report cube:
 *    add-on secrets, over REST;
 *  - Wealthfolio's figures: `/valuations/latest` and `/spending/insight`;
 *  - the rows and two settings: the read-only database (sqlite-audit.ts).
 *
 * `/audit` re-runs these on every tap; the publish runs them after each sync.
 */
import { explainBalances, type BalanceFacts, type BalanceRead } from '../../shared/audit-balance.js';
import { explainHeadline, zonedMonthBounds, type HeadlineDbRow, type HeadlineFacts, type HeadlineRead } from '../../shared/audit-headline.js';
import { healthIssues, type HealthFacts, type HealthRead } from '../../shared/audit-health.js';
import type { AuditLedger } from '../../shared/audit-ledger.js';
import { AUDIT_SNAPSHOT_SECRET_KEY, buildAuditSnapshot, type AuditResults } from '../../shared/audit-snapshot.js';
import { monthlySpendTotals, parseReportCube, REPORT_CUBE_SECRET_KEY } from '../../shared/report-cube.js';
import { getNativeAuditLedger, getNativeAuditSettings, getNativeHeadlineRows } from './sqlite-audit.js';
import type { WealthfolioClient } from './wealthfolio.js';

const ADDON_ID = 'simplefin-sync';

/** Everything the checks read, so a test can fake each in its real shape. */
export interface AuditReaders {
  /** One add-on secret; rejects when Wealthfolio cannot be reached. */
  secret(key: string): Promise<string | null>;
  valuations(): Promise<Array<{ accountId: string; totalValue: string | number }>>;
  /** Throws when the database cannot be read. */
  ledger(): AuditLedger;
  /** Throws when the database cannot be read. */
  headlineRows(startInclusive: string, endExclusive: string): HeadlineDbRow[];
  /** Throws when the database cannot be read. */
  settings(): { timezone: string | null; excludedCategoryIds: string[]; categoryParents: Record<string, string | null> };
  /** Wealthfolio's Spending page `headline.spent`, in dollars. */
  spendingSpent(startIso: string, endIso: string): Promise<number>;
}

export type AuditClient = Pick<WealthfolioClient, 'getAddonSecret' | 'getLatestValuations' | 'getSpendingInsightSpent'>;

export function companionAuditReaders(client: AuditClient, dbPath: string): AuditReaders {
  return {
    secret: (key) => client.getAddonSecret(ADDON_ID, key),
    valuations: () => client.getLatestValuations(),
    ledger: () => getNativeAuditLedger(dbPath),
    headlineRows: (start, endEx) => getNativeHeadlineRows(dbPath, start, endEx),
    settings: () => getNativeAuditSettings(dbPath),
    spendingSpent: (start, end) => client.getSpendingInsightSpent(start, end),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The companion's own day, as audit-headline.mjs's TODAY. */
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nextMonthStart = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
};

/** A JSON secret on its own: `ok: false` when the read or the parse failed;
 *  a secret that is not there is `null`. */
async function readJson<T>(r: AuditReaders, key: string): Promise<{ ok: true; value: T | null } | { ok: false }> {
  try {
    const raw = await r.secret(key);
    return { ok: true, value: raw ? (JSON.parse(raw) as T) : null };
  } catch {
    return { ok: false };
  }
}

/** The ledger, read once and shared by the balance and Health checks;
 *  undefined when the database could not be read. */
export function readAuditLedger(r: AuditReaders): AuditLedger | undefined {
  try {
    return r.ledger();
  } catch {
    return undefined;
  }
}

export async function gatherBalanceFacts(r: AuditReaders, ledger: AuditLedger | undefined): Promise<BalanceFacts> {
  const facts: BalanceFacts = {};
  const failed: BalanceRead[] = [];
  const mapping = await readJson<Record<string, string>>(r, 'account_mapping');
  if (mapping.ok) facts.mapping = mapping.value ?? {};
  else failed.push('mapping');
  const balances = await readJson<NonNullable<BalanceFacts['balances']>>(r, 'account_balances');
  if (balances.ok) facts.balances = balances.value ?? {};
  else failed.push('balances');
  const names = await readJson<Record<string, string>>(r, 'account_names');
  if (names.ok) facts.names = names.value ?? {};
  else failed.push('names');
  try {
    const valuations: Record<string, number> = {};
    for (const v of await r.valuations()) {
      const dollars = typeof v.totalValue === 'number' ? v.totalValue : parseFloat(String(v.totalValue));
      if (Number.isFinite(dollars)) valuations[v.accountId] = Math.round(dollars * 100);
    }
    facts.valuations = valuations;
  } catch {
    failed.push('valuations');
  }
  if (ledger) facts.ledger = ledger;
  else failed.push('ledger');
  if (failed.length > 0) facts.failed = failed;
  return facts;
}

export async function gatherHeadlineFacts(r: AuditReaders, now: Date): Promise<HeadlineFacts> {
  const today = localDay(now);
  const month = today.slice(0, 7);
  const facts: HeadlineFacts = { month, today };
  const failed: HeadlineRead[] = [];
  try {
    // The report's "Spent this month": the cube's newest month, which must be this one.
    const cube = parseReportCube(await r.secret(REPORT_CUBE_SECRET_KEY));
    if (cube && cube.months.at(-1) === month) facts.reportCents = Math.round(monthlySpendTotals(cube).at(-1) ?? 0);
    else failed.push('report');
  } catch {
    failed.push('report');
  }
  let timezone: string | null = null;
  try {
    const settings = r.settings();
    timezone = settings.timezone;
    facts.excludedCategoryIds = settings.excludedCategoryIds;
    facts.categoryParents = settings.categoryParents;
  } catch {
    failed.push('settings');
  }
  try {
    const { start, end } = zonedMonthBounds(month, timezone);
    facts.wealthfolioCents = Math.round((await r.spendingSpent(start, end)) * 100);
  } catch {
    failed.push('wealthfolio');
  }
  try {
    facts.rows = r.headlineRows(`${month}-01`, nextMonthStart(month));
  } catch {
    failed.push('ledger');
  }
  if (failed.length > 0) facts.failed = failed;
  return facts;
}

export async function gatherHealthFacts(r: AuditReaders, ledger: AuditLedger | undefined): Promise<HealthFacts> {
  const facts: HealthFacts = {};
  const failed: HealthRead[] = [];
  if (ledger) facts.ledger = ledger;
  else failed.push('ledger');
  const mapping = await readJson<Record<string, string>>(r, 'account_mapping');
  if (mapping.ok) facts.mapping = mapping.value ?? {};
  else failed.push('mapping');
  if (failed.length > 0) facts.failed = failed;
  return facts;
}

/** All three checks over one ledger read. `reached` is false when not even
 *  the account mapping could be read: Wealthfolio is unreachable. */
export async function runAudit(r: AuditReaders, now: Date): Promise<AuditResults & { reached: boolean }> {
  const ledger = readAuditLedger(r);
  const balanceFacts = await gatherBalanceFacts(r, ledger);
  const headlineFacts = await gatherHeadlineFacts(r, now);
  const healthFacts = await gatherHealthFacts(r, ledger);
  return {
    balances: explainBalances(balanceFacts),
    headline: explainHeadline(headlineFacts),
    health: healthIssues(healthFacts),
    reached: !balanceFacts.failed?.includes('mapping'),
  };
}

export type AuditPublishClient = AuditClient & Pick<WealthfolioClient, 'setAddonSecret'>;

/**
 * Runs the checks and writes the snapshot (shared/audit-snapshot.ts). Writes
 * nothing when Wealthfolio could not be reached, so the previous snapshot
 * stays; rejects when the write fails. The sync's caller catches and logs
 * either way — a publish never fails or changes a sync.
 */
export async function publishAuditSnapshot(
  client: AuditPublishClient,
  dbPath: string,
  now: Date,
  readers: AuditReaders = companionAuditReaders(client, dbPath),
): Promise<boolean> {
  const { reached, ...results } = await runAudit(readers, now);
  if (!reached) return false;
  await client.setAddonSecret(ADDON_ID, AUDIT_SNAPSHOT_SECRET_KEY, JSON.stringify(buildAuditSnapshot(results, now)));
  return true;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run src/sqlite-audit.test.ts src/audit-facts.test.ts src/wealthfolio-insight.test.ts src/sqlite-native.test.ts src/sqlite-native-story.test.ts src/wealthfolio.test.ts`
Expected: PASS — 158 tests.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/sqlite-native.ts companion/src/wealthfolio.ts companion/src/sqlite-audit.ts companion/src/sqlite-audit.test.ts companion/src/audit-facts.ts companion/src/audit-facts.test.ts companion/src/wealthfolio-insight.test.ts
git commit -m "Companion: gather the audits' facts — strict database reads, Wealthfolio's two figures, each read on its own

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Publish the audit snapshot after each sync, best-effort

`runCompanionSync` publishes the snapshot right after the report cube — whose "Spent this month" the month check compares — guarded the same way: a failed run or write is logged, keeps the previous snapshot, and never fails or changes the sync's result (spec B2; X5). `index.test.ts` mocks `./sqlite-audit.js` as a module: `sqlite-audit.ts` reads its separator from `./sqlite-native.js`, which this file mocks without it, at import time.

**Files:**
- Modify: `companion/src/index.ts`, `companion/src/index.test.ts`

**Interfaces:**
- Consumes: Task 5 (`publishAuditSnapshot(client, dbPath, now)`).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

Edit 1 of 2 in `companion/src/index.test.ts` — replace:

```ts
  getNativeTxPartner: vi.fn(() => null),
  getNativeTxSearchRows: vi.fn(() => []),
  NativeDbUnreadableError: class NativeDbUnreadableError extends Error {},
}));

vi.mock('./amazon-mail.js', async (importOriginal) => ({
```

with:

```ts
  getNativeTxPartner: vi.fn(() => null),
  getNativeTxSearchRows: vi.fn(() => []),
  NativeDbUnreadableError: class NativeDbUnreadableError extends Error {},
}));

// The audits' strict readers (2c): mocked as a module, because sqlite-audit.ts
// reads its separator from the sqlite-native mock above at import time. An
// empty ledger is the "quiet database" every unrelated sync test wants.
vi.mock('./sqlite-audit.js', () => ({
  getNativeAuditLedger: vi.fn(() => ({ accounts: [], rows: [] })),
  getNativeHeadlineRows: vi.fn(() => []),
  getNativeAuditSettings: vi.fn(() => ({ timezone: null, excludedCategoryIds: [], categoryParents: {} })),
}));

vi.mock('./amazon-mail.js', async (importOriginal) => ({
```

Edit 2 of 2 in `companion/src/index.test.ts` — replace:

```ts
  });
});

describe('daily digest: version skew + update line', () => {
  const clientWith = (entries: Array<[string, string]> = []) => {
    const secrets = new Map<string, string>([
```

with:

```ts
  });
});

describe('audit_snapshot publish', () => {
  /** The full client shape, pinned for the same reason as report_cube's test. */
  const pinClient = async (setAddonSecret: (addon: string, key: string, value: string) => Promise<void>) => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    const { WealthfolioClient } = await import('./wealthfolio.js');
    vi.mocked(WealthfolioClient as any).mockClear();
    vi.mocked(WealthfolioClient as any).mockImplementation(function (this: any) {
      this.login = vi.fn(async () => {});
      this.getAddonSecret = vi.fn(async (_a: string, key: string) => (
        key === 'simplefin_access_url' ? 'https://user:pass@bridge.simplefin.org/simplefin' : null
      ));
      this.setAddonSecret = vi.fn(setAddonSecret);
      this.getAccounts = vi.fn(async () => []);
    });
    return () => (vi.mocked(WealthfolioClient as any).mock.instances.at(-1)) as any;
  };

  it('publishes the checks after a sync', async () => {
    const instance = await pinClient(async () => {});
    await runCompanionSync();
    const call = instance().setAddonSecret.mock.calls.find((c: any[]) => c[1] === 'audit_snapshot');
    expect(call).toBeTruthy();
    expect(JSON.parse(call[2]).v).toBe(1);
  });

  it('logs a publish that fails and returns the sync’s result unchanged', async () => {
    await pinClient(async (_a, key) => { if (key === 'audit_snapshot') throw new Error('disk full'); });
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await runCompanionSync();
      expect(result.imported).toBe(2);
      expect(result.errors).toEqual([]);
      expect(logs.mock.calls.flat().join('\n')).toContain('Audit snapshot publish failed');
    } finally {
      logs.mockRestore();
    }
  });
});

describe('daily digest: version skew + update line', () => {
  const clientWith = (entries: Array<[string, string]> = []) => {
    const secrets = new Map<string, string>([
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/index.test.ts`
Expected: FAIL — 2 tests: `publishes the checks after a sync` (no `audit_snapshot` write) and `logs a publish that fails and returns the sync’s result unchanged` (no "Audit snapshot publish failed" line).

- [ ] **Step 3: Implement**

Edit 1 of 2 in `companion/src/index.ts` — replace:

```ts
} from './subscriptions-menu.js';
import { addDaysIso, dueWithin, formatRosterTotal, manualKey, rosterMoney, type Cadence } from '../../shared/subscription-roster.js';
import { REPORT_CUBE_SECRET_KEY, parseReportCube } from '../../shared/report-cube.js';
import { addManual, editSubscriptionPrefs, emptySubscriptionPrefs, isUnreadablePrefsError, loadSubscriptionPrefs, newManualId, renameKey, setRemind, SubscriptionPrefsInvalidError, type ManualSubscription, type RemindDays, type SecretGet, type SecretSet, type SubscriptionEdit } from '../../shared/subscription-prefs.js';
import { renderReportSvg, reportImageTitle, reportImageCaption, RENDERABLE_REPORT_IDS } from '../../shared/report-render.js';
import { createAskSessions, CANCELLED, CANCELLED_EARLIER, NOT_WAITING, type AskSessions } from './ask-session.js';
```

with:

```ts
} from './subscriptions-menu.js';
import { addDaysIso, dueWithin, formatRosterTotal, manualKey, rosterMoney, type Cadence } from '../../shared/subscription-roster.js';
import { REPORT_CUBE_SECRET_KEY, parseReportCube } from '../../shared/report-cube.js';
import { publishAuditSnapshot } from './audit-facts.js';
import { addManual, editSubscriptionPrefs, emptySubscriptionPrefs, isUnreadablePrefsError, loadSubscriptionPrefs, newManualId, renameKey, setRemind, SubscriptionPrefsInvalidError, type ManualSubscription, type RemindDays, type SecretGet, type SecretSet, type SubscriptionEdit } from '../../shared/subscription-prefs.js';
import { renderReportSvg, reportImageTitle, reportImageCaption, RENDERABLE_REPORT_IDS } from '../../shared/report-render.js';
import { createAskSessions, CANCELLED, CANCELLED_EARLIER, NOT_WAITING, type AskSessions } from './ask-session.js';
```

Edit 2 of 2 in `companion/src/index.ts` — replace:

```ts
      }
    } catch (e) {
      log(`Report cube publish failed (the addon's budget reports may be stale): ${formatError(e)}`);
    }

    const undeliveredOutTxIds: string[] = [];
```

with:

```ts
      }
    } catch (e) {
      log(`Report cube publish failed (the addon's budget reports may be stale): ${formatError(e)}`);
    }

    // 2c: the checks behind the app's Checks card, its account chips and the
    // Budget tab's "different from Wealthfolio" link — after the cube, whose
    // figure they compare. Best-effort like the cube: a failed run or write
    // keeps the previous snapshot and never touches this sync's result.
    try {
      await publishAuditSnapshot(wfClient, wealthfolioDbPath(), new Date());
    } catch (e) {
      log(`Audit snapshot publish failed (the app's checks may be stale): ${formatError(e)}`);
    }

    const undeliveredOutTxIds: string[] = [];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run src/index.test.ts`
Expected: PASS — 284 tests.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/index.ts companion/src/index.test.ts
git commit -m "Companion: publish the audit snapshot after each sync, best-effort

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `/audit` — the three checks in a stateless `cz:au:` menu, live on every tap

`companion/src/audit-menu.ts` (spec A4; X4). `/audit` replies with a menu — **Balances**, **Spent vs Wealthfolio**, **Health (N)** — and every tap re-reads: the accounts (one button each, "name · off by $50.00"), one account's explanation (in place with ⬅️ Back, or as a NEW message from `/status`'s 🔎), the month's reasons (one button each, opening its rows), Health's issues (numbered buttons, each opening the issue with what to do and, later, R2's Link). Nothing is remembered: buttons carry `findingHandle`s of the account's Wealthfolio id, the reason or the issue key, and a tap re-judges and hashes to find it — a gone one says so instead of guessing. Bank and user text is escaped and kept outside every entity; button labels are raw. Each check's failed reads show as ⚠️ notes; the menu answers "Couldn't reach Wealthfolio — try again." only when not even the account mapping can be read. `auditMenuDeps` binds the live checks over Task 5's readers; `auditStatusKeyboard` builds `/status`'s 🔎 rows.

**Files:**
- Create: `companion/src/audit-menu.ts`, `companion/src/audit-menu.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 (the explain functions and line builders, `HEADLINE_AGREE`, `HEADLINE_REASON_LABELS`, `HEALTH_NONE`, `healthCount`); Task 5 (`AuditReaders`, `gatherBalanceFacts`, `gatherHeadlineFacts`, `gatherHealthFacts`, `readAuditLedger`); `findingHandle` (shared/handle.ts); `escapeMarkdown`, `InlineKeyboard` (shared/telegram.ts); `TX_STORY_UNREACHABLE` (shared/tx-story.ts).
- Produces:

```ts
// companion/src/audit-menu.ts
export const AUDIT_CALLBACK_PREFIX = 'cz:au:';
export const AUDIT_UNREACHABLE: string;     // "Couldn't reach Wealthfolio — try again."
export const AUDIT_ACCOUNT_GONE: string;    // "That account isn't mapped any more — send /audit again."
export const AUDIT_REASON_GONE: string;     // 'That reason has nothing in it now.'
export const AUDIT_ISSUE_GONE: string;      // 'Health has changed since — that one is gone.'
export const AUDIT_LIST_MAX = 20;
export interface MenuScreen { text: string; keyboard: InlineKeyboard }
export type AuditView =
  | { kind: 'menu' } | { kind: 'balances' } | { kind: 'account'; handle: string; fresh: boolean }
  | { kind: 'headline' } | { kind: 'reason'; handle: string } | { kind: 'health' } | { kind: 'issue'; handle: string };
export function auditData(view: AuditView): string;
export function parseAuditData(data: string): AuditView | null;
export const accountHandle: (wfAccountId: string) => string;
export function auditStatusKeyboard(accounts: ReadonlyArray<{ name: string; drift: number | null; wfAccountId?: string }>): InlineKeyboard | null;
export interface AuditMenuUi { edit(text: string, keyboard?: InlineKeyboard): Promise<void>; answer(text?: string): Promise<void>; send(text: string, keyboard?: InlineKeyboard): Promise<void> }
export interface AuditMenuDeps {
  balances(): Promise<BalanceReport & { reached: boolean }>;
  headline(now: Date): Promise<HeadlineExplanation>;
  health(): Promise<HealthReport & { reached: boolean }>;
  now(): Date;
  log(msg: string): void;
}
export function auditMenuDeps(readers: AuditReaders, log: (msg: string) => void): AuditMenuDeps;
export interface AuditMenu {
  handles(data: string): boolean;
  onCallback(cb: { data: string }, ui: AuditMenuUi): Promise<void>;
  reply(send: (text: string, keyboard?: InlineKeyboard) => Promise<void>): Promise<void>;
}
export function createAuditMenu(deps: AuditMenuDeps): AuditMenu;
```

- [ ] **Step 1: Write the failing tests**

**Create `companion/src/audit-menu.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { explainBalances, type BalanceReport } from '../../shared/audit-balance.js';
import { explainHeadline, HEADLINE_AGREE, type HeadlineExplanation } from '../../shared/audit-headline.js';
import { healthIssues, HEALTH_NONE, HEALTH_READ_NOTES, type HealthReport } from '../../shared/audit-health.js';
import type { AuditLedgerRow } from '../../shared/audit-ledger.js';
import { ASK_CALLBACK_PREFIX } from '../../shared/ask-flow.js';
import { CATEGORIZE_ENTRY_CALLBACK, escapeMarkdown, RECATEGORIZE_ENTRY_CALLBACK, WHY_CALLBACK_PREFIX } from '../../shared/telegram.js';
import { CHANGES_CALLBACK_PREFIX } from './changes-menu.js';
import { FINDINGS_CALLBACK_PREFIX } from './findings-menu.js';
import { SUBSCRIPTIONS_CALLBACK_PREFIX } from './subscriptions-menu.js';
import {
  accountHandle, auditData, auditStatusKeyboard, createAuditMenu, parseAuditData, renderAuditAccount, renderAuditBalances,
  renderAuditHeadline, renderAuditHealth, renderAuditIssue, renderAuditMenu, renderAuditReason,
  AUDIT_ACCOUNT_GONE, AUDIT_CALLBACK_PREFIX, AUDIT_ISSUE_GONE, AUDIT_UNREACHABLE, type AuditMenuDeps, type AuditView, type MenuScreen,
} from './audit-menu.js';

const NOW = new Date(2026, 9, 13, 12, 0);
const NAME = "Joe's *Visa*_[1]";
const BANK = 'SQ *COFFEE_CLUB [2]';
const VISA = '0f8fad5b-d9cb-469f-a165-708677289501';
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const allData = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
const labels = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.text);

const row = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
  id: 'r', accountId: 'wf-chk', date: '2026-10-04', currency: 'USD', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', status: 'POSTED',
  absCents: 0, group: '', assetId: '', external: false, phantomCash: false, notes: 'ROW · TRN-0', ...over,
});
const LEDGER = {
  accounts: [{ id: VISA, name: 'Visa', type: 'CREDIT_CARD', archived: false }, { id: 'wf-chk', name: 'Checking', type: 'CASH', archived: false }],
  rows: [
    row({ id: 'v1', accountId: VISA, absCents: 50000, date: '2026-09-01' }),
    row({ id: 'v2', accountId: VISA, absCents: 1910, notes: `${BANK} · TRN-7 · pending` }),
    row({ id: 'out', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', absCents: 60000, notes: `${BANK} · TRN-1` }),
    row({ id: 'dep', accountId: VISA, rawType: 'CREDIT', type: 'CREDIT', absCents: 60000, date: '2026-10-05', notes: 'PAYMENT · TRN-2' }),
  ],
};
const balances = (): BalanceReport & { reached: boolean } => ({
  ...explainBalances({
    mapping: { 'sfin-v': VISA, 'sfin-c': 'wf-chk' },
    balances: { 'sfin-v': { balance: 100, date: Date.parse('2026-10-13T12:00:00Z') / 1000 }, 'sfin-c': { balance: 1, date: null } },
    names: { 'sfin-v': NAME, 'sfin-c': 'PNC Checking' },
    valuations: { 'wf-chk': 100 },
    ledger: LEDGER,
  }),
  reached: true,
});
const headline = (): HeadlineExplanation => explainHeadline({
  month: '2026-10', today: '2026-10-13', reportCents: 130000, wealthfolioCents: 120000, excludedCategoryIds: [],
  rows: Array.from({ length: 23 }, (_, i) => ({
    id: `h${i}`, date: '2026-10-01T00:00:00+00:00', accountName: NAME, accountType: 'CASH', type: 'WITHDRAWAL', subtype: '',
    absCents: 100, notes: `${BANK} · TRN-${i}`, spendingFilings: 1, categoryIds: ['c'],
  })),
});
const health = (): HealthReport & { reached: boolean } => ({ ...healthIssues({ ledger: LEDGER, mapping: { 'sfin-v': VISA, 'sfin-c': 'wf-chk' } }), reached: true });

function deps(over: Partial<AuditMenuDeps> = {}): AuditMenuDeps {
  return {
    balances: vi.fn(async () => balances()),
    headline: vi.fn(async () => headline()),
    health: vi.fn(async () => health()),
    now: () => NOW,
    log: vi.fn(),
    ...over,
  };
}
const ui = () => ({ edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) });

describe('the cz:au: encoding', () => {
  it('parses back every view it writes, and nothing else', () => {
    const views: AuditView[] = [
      { kind: 'menu' }, { kind: 'balances' }, { kind: 'account', handle: 'abcdef01', fresh: false }, { kind: 'account', handle: 'abcdef01', fresh: true },
      { kind: 'headline' }, { kind: 'reason', handle: '0badc0de' }, { kind: 'health' }, { kind: 'issue', handle: '12345678' },
    ];
    for (const v of views) expect(parseAuditData(auditData(v))).toEqual(v);
    for (const bad of ['cz:au:', 'cz:au:z', 'cz:au:a123', 'cz:au:aZZZZZZZZ', 'cz:wy:m', 'cz:7:1']) expect(parseAuditData(bad)).toBeNull();
  });

  it('is the only prefix starting cz:au', () => {
    // amazon-labels.ts (cz:al:, cz:alc:) and transfer-learning.ts (cz:tl…) keep theirs private.
    const others = [ASK_CALLBACK_PREFIX, WHY_CALLBACK_PREFIX, CHANGES_CALLBACK_PREFIX, SUBSCRIPTIONS_CALLBACK_PREFIX, FINDINGS_CALLBACK_PREFIX,
      CATEGORIZE_ENTRY_CALLBACK, RECATEGORIZE_ENTRY_CALLBACK, 'cz:al:', 'cz:alc:', 'cz:tl:', 'cz:tlc:', 'cz:tlk:', 'cz:tlu:'];
    expect(AUDIT_CALLBACK_PREFIX).toBe('cz:au:');
    expect(others.filter((p) => p.startsWith('cz:au'))).toEqual([]);
  });

  it('keeps every button within 64 bytes — the longest is 15', () => {
    const h = headline();
    const hr = health();
    const screens = [
      renderAuditMenu(hr), renderAuditBalances(balances()), renderAuditAccount(balances().accounts[0], [], false),
      renderAuditHeadline(h), renderAuditReason(h.reasons![0]), renderAuditHealth(hr), renderAuditIssue(hr.issues![0]),
      { text: '', keyboard: auditStatusKeyboard([{ name: NAME, drift: 5, wfAccountId: VISA }])! },
    ];
    const data = screens.flatMap(allData);
    expect(data.every((d) => bytes(d) <= 64)).toBe(true);
    expect(Math.max(...data.map(bytes))).toBe(15);
  });
});

describe('/audit', () => {
  it('replies with the menu: balances, the month, and Health with its count', async () => {
    const send = vi.fn(async () => {});
    await createAuditMenu(deps()).reply(send);
    const [text, keyboard] = send.mock.calls[0] as unknown as [string, MenuScreen['keyboard']];
    expect(text.startsWith('🔎 *Audit*\n')).toBe(true);
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['Balances', 'Spent vs Wealthfolio', 'Health (1)']);
  });

  it('says so when it cannot reach Wealthfolio', async () => {
    const send = vi.fn(async () => {});
    await createAuditMenu(deps({ health: vi.fn(async () => ({ ...health(), reached: false })) })).reply(send);
    expect(send).toHaveBeenCalledWith(AUDIT_UNREACHABLE);
    const u = ui();
    await createAuditMenu(deps({ balances: vi.fn(async () => ({ ...balances(), reached: false })) })).onCallback({ data: auditData({ kind: 'balances' }) }, u);
    expect(u.answer).toHaveBeenCalledWith(AUDIT_UNREACHABLE);
    expect(u.edit).not.toHaveBeenCalled();
  });

  it('escapes a bank name full of Markdown characters and keeps it out of every entity', async () => {
    const list = renderAuditBalances(balances());
    expect(labels(list)[0]).toBe(`${NAME} · off by $19.10`);
    const u = ui();
    await createAuditMenu(deps()).onCallback({ data: allData(list)[0] }, u);
    const [text] = u.edit.mock.calls[0] as unknown as [string];
    const lines = text.split('\n');
    expect(lines[0]).toBe('🔎 *Balance*');
    expect(lines[1]).toBe(escapeMarkdown(NAME));
    expect(text).toContain(`• ${escapeMarkdown("$19.10 in 1 pending transaction the bank hasn't posted")}`);
    // The only entities are the fixed heading's.
    expect(text.replace('*Balance*', '').match(/(?<!\\)[*_]/g)).toBeNull();
    const reason = renderAuditReason(headline().reasons![0]);
    expect(reason.text).toContain(escapeMarkdown(`Oct 1 · ${BANK} · $1.00 · ${NAME}`));
  });

  it('opens an account in place with Back, and as a new message without one from /status', async () => {
    const inPlace = ui();
    await createAuditMenu(deps()).onCallback({ data: auditData({ kind: 'account', handle: accountHandle(VISA), fresh: false }) }, inPlace);
    expect(inPlace.send).not.toHaveBeenCalled();
    expect((inPlace.edit.mock.calls[0] as unknown as [string, MenuScreen['keyboard']])[1].inline_keyboard).toEqual([[{ text: '⬅️ Back', callback_data: 'cz:au:b' }]]);
    const fresh = ui();
    await createAuditMenu(deps()).onCallback({ data: auditData({ kind: 'account', handle: accountHandle(VISA), fresh: true }) }, fresh);
    expect(fresh.edit).not.toHaveBeenCalled();
    expect(fresh.send).toHaveBeenCalledTimes(1);
    expect((fresh.send.mock.calls[0] as unknown[]).length).toBe(1);
  });

  it('answers a tap from an older message: every tap re-reads, nothing is remembered', async () => {
    const buttons = allData(renderAuditBalances(balances()));
    const later = deps();
    const u = ui();
    await createAuditMenu(later).onCallback({ data: buttons[0] }, u);
    expect(later.balances).toHaveBeenCalledTimes(1);
    expect(u.edit).toHaveBeenCalledTimes(1);
  });

  it('says an account is no longer mapped, and Health has changed, instead of guessing', async () => {
    const u = ui();
    await createAuditMenu(deps()).onCallback({ data: auditData({ kind: 'account', handle: 'deadbeef', fresh: true }) }, u);
    expect(u.answer).toHaveBeenCalledWith(AUDIT_ACCOUNT_GONE);
    const v = ui();
    await createAuditMenu(deps()).onCallback({ data: auditData({ kind: 'issue', handle: 'deadbeef' }) }, v);
    expect(v.answer).toHaveBeenCalledWith(AUDIT_ISSUE_GONE);
  });

  it('shows a failed read as its note, never as "nothing to flag"', async () => {
    const notChecked = { ...healthIssues({ mapping: {}, failed: ['ledger'] }), reached: true };
    const screen = renderAuditHealth(notChecked);
    expect(screen.text).toContain(`⚠️ ${escapeMarkdown(HEALTH_READ_NOTES.ledger)}`);
    expect(screen.text).not.toContain(escapeMarkdown(HEALTH_NONE));
    expect(labels(renderAuditMenu(notChecked))).toContain('Health');
    expect(renderAuditHealth({ issues: [], notes: [] }).text).toContain(escapeMarkdown(HEALTH_NONE));
  });

  it('lists the month’s reasons with buttons, each opening its rows with Back', async () => {
    const h = headline();
    const screen = renderAuditHeadline(h);
    expect(screen.text).toContain(escapeMarkdown("The report counts $1,300.00 spent this month; Wealthfolio's Spending page counts $1,200.00."));
    expect(labels(screen)).toEqual(['Dated the 1st at midnight UTC (23)', '⬅️ Back']);
    const u = ui();
    await createAuditMenu(deps()).onCallback({ data: allData(screen)[0] }, u);
    const [text, kb] = u.edit.mock.calls[0] as unknown as [string, MenuScreen['keyboard']];
    expect(text).toContain('…and 3 more');
    expect(kb.inline_keyboard).toEqual([[{ text: '⬅️ Back', callback_data: 'cz:au:h' }]]);
    expect(renderAuditHeadline({ ...h, wealthfolioCents: 130000 }).text).toContain(escapeMarkdown(HEADLINE_AGREE));
  });

  it('opens a Health issue with its likely other half and Back', async () => {
    const screen = renderAuditHealth(health());
    const u = ui();
    await createAuditMenu(deps()).onCallback({ data: allData(screen)[0] }, u);
    const [text, kb] = u.edit.mock.calls[0] as unknown as [string, MenuScreen['keyboard']];
    expect(text).toContain(escapeMarkdown('Likely the other half: PAYMENT · $600.00 · Visa · Oct 5'));
    expect(kb.inline_keyboard).toEqual([[{ text: '⬅️ Back', callback_data: 'cz:au:i' }]]);
  });

  it('logs and answers when a read throws', async () => {
    const d = deps({ headline: vi.fn(async () => { throw new Error('boom'); }) });
    const u = ui();
    await createAuditMenu(d).onCallback({ data: 'cz:au:h' }, u);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('boom'));
    expect(u.answer).toHaveBeenCalledWith('Could not do that — check the companion logs.');
  });
});

describe('auditStatusKeyboard', () => {
  it('puts a 🔎 under each account /status shows off, with its raw name', () => {
    const kb = auditStatusKeyboard([
      { name: NAME, drift: 13, wfAccountId: VISA },
      { name: 'Save', drift: null, wfAccountId: 'wf-save' },
      { name: 'Unmapped', drift: 4 },
    ])!;
    expect(kb.inline_keyboard).toEqual([[{ text: `🔎 ${NAME}`, callback_data: `cz:au:s${accountHandle(VISA)}` }]]);
    expect(auditStatusKeyboard([{ name: 'Save', drift: null, wfAccountId: 'wf-save' }])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/audit-menu.test.ts`
Expected: FAIL — `Cannot find module './audit-menu.js'`; no tests run.

- [ ] **Step 3: Implement**

**Create `companion/src/audit-menu.ts`:**

```ts
/**
 * companion/src/audit-menu.ts
 *
 * `/audit` (2c R1, spec A4): the three checks in Telegram, run LIVE on every
 * tap, plus the 🔎 buttons `/status` puts under an account that is off.
 * STATELESS like why-menu.ts: every tap re-reads, and every button carries
 * where it leads. After `cz:au:`:
 *   m              the menu (Balances · Spent vs Wealthfolio · Health), in place
 *   b              the mapped accounts, one button each, in place
 *   a<handle>      one account's explanation, in place, Back to the accounts
 *   s<handle>      one account's explanation as a NEW message (/status's 🔎)
 *   h              the report's spending against Wealthfolio's, in place
 *   r<handle>      one reason's rows, in place, Back to the month
 *   i              what Health flags, in place
 *   x<handle>      one issue, in place, Back to Health
 * `<handle>` is `findingHandle` of the account's Wealthfolio id, of
 * `reason:<kind>`, or of the issue's key — 8 hex, so the longest button is
 * 15 bytes. Nothing else may start with `cz:au`.
 *
 * Bank and user text is escaped AND kept outside every `*…*`; the only
 * entities are fixed headings. Button labels are plain text, not escaped.
 */
import {
  balanceCauseLines, balanceHeaderLine, balanceIncludesLine, balanceShort, explainBalances, type BalanceExplanation,
  type BalanceReport,
} from '../../shared/audit-balance.js';
import {
  explainHeadline, headlineAgrees, headlineReasonLine, headlineRowLine, headlineSummaryLine, headlineUnexplainedLine,
  HEADLINE_AGREE, HEADLINE_REASON_LABELS, type HeadlineExplanation, type HeadlineReason,
} from '../../shared/audit-headline.js';
import {
  healthCount, healthIssueLines, healthIssues, healthIssueTitle, HEALTH_NONE, type HealthIssue, type HealthReport,
} from '../../shared/audit-health.js';
import { findingHandle } from '../../shared/handle.js';
import { escapeMarkdown, type InlineKeyboard } from '../../shared/telegram.js';
import { TX_STORY_UNREACHABLE } from '../../shared/tx-story.js';
import { gatherBalanceFacts, gatherHeadlineFacts, gatherHealthFacts, readAuditLedger, type AuditReaders } from './audit-facts.js';

export const AUDIT_CALLBACK_PREFIX = 'cz:au:';
export const AUDIT_TITLE = 'Audit';
export const AUDIT_INTRO = "Why a balance or this month's spending differs from Wealthfolio, and what its Health page flags. Every tap checks again.";
export const AUDIT_UNREACHABLE = TX_STORY_UNREACHABLE;
export const AUDIT_NO_ACCOUNTS = 'No accounts are mapped yet.';
export const AUDIT_TAP_ACCOUNT = 'Tap an account to see why.';
export const AUDIT_ACCOUNT_GONE = "That account isn't mapped any more — send /audit again.";
export const AUDIT_REASON_GONE = 'That reason has nothing in it now.';
export const AUDIT_ISSUE_GONE = 'Health has changed since — that one is gone.';
export const AUDIT_BALANCES_BUTTON = 'Balances';
export const AUDIT_HEADLINE_BUTTON = 'Spent vs Wealthfolio';
/** Lines one message lists before "…and N more". */
export const AUDIT_LIST_MAX = 20;
const BACK = '⬅️ Back';
const FAILED_ANSWER = 'Could not do that — check the companion logs.';

type Button = { text: string; callback_data: string };
export interface MenuScreen { text: string; keyboard: InlineKeyboard }

export type AuditView =
  | { kind: 'menu' }
  | { kind: 'balances' }
  /** `fresh`: from /status — a new message with no Back. */
  | { kind: 'account'; handle: string; fresh: boolean }
  | { kind: 'headline' }
  | { kind: 'reason'; handle: string }
  | { kind: 'health' }
  | { kind: 'issue'; handle: string };

export function auditData(view: AuditView): string {
  switch (view.kind) {
    case 'menu': return `${AUDIT_CALLBACK_PREFIX}m`;
    case 'balances': return `${AUDIT_CALLBACK_PREFIX}b`;
    case 'account': return `${AUDIT_CALLBACK_PREFIX}${view.fresh ? 's' : 'a'}${view.handle}`;
    case 'headline': return `${AUDIT_CALLBACK_PREFIX}h`;
    case 'reason': return `${AUDIT_CALLBACK_PREFIX}r${view.handle}`;
    case 'health': return `${AUDIT_CALLBACK_PREFIX}i`;
    case 'issue': return `${AUDIT_CALLBACK_PREFIX}x${view.handle}`;
  }
}

/** The view a button carries, or null for anything this menu never emitted. */
export function parseAuditData(data: string): AuditView | null {
  if (!data.startsWith(AUDIT_CALLBACK_PREFIX)) return null;
  const s = data.slice(AUDIT_CALLBACK_PREFIX.length);
  if (s === 'm') return { kind: 'menu' };
  if (s === 'b') return { kind: 'balances' };
  if (s === 'h') return { kind: 'headline' };
  if (s === 'i') return { kind: 'health' };
  const m = /^([asrx])([0-9a-f]{8})$/.exec(s);
  if (!m) return null;
  if (m[1] === 'a' || m[1] === 's') return { kind: 'account', handle: m[2], fresh: m[1] === 's' };
  return m[1] === 'r' ? { kind: 'reason', handle: m[2] } : { kind: 'issue', handle: m[2] };
}

export const accountHandle = (wfAccountId: string) => findingHandle(wfAccountId);
export const reasonHandle = (r: Pick<HeadlineReason, 'kind'>) => findingHandle(`reason:${r.kind}`);
export const issueHandle = (i: Pick<HealthIssue, 'key'>) => findingHandle(i.key);

const clip = (s: string, n: number) => {
  const chars = Array.from(s);
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s;
};
const back = (view: AuditView): Button[] => [{ text: BACK, callback_data: auditData(view) }];
const noteLines = (notes: readonly string[]) => (notes.length ? ['', ...notes.map((n) => `⚠️ ${escapeMarkdown(n)}`)] : []);
const listed = <T>(items: readonly T[], more = 0) => ({
  shown: items.slice(0, AUDIT_LIST_MAX),
  hidden: Math.max(0, items.length - AUDIT_LIST_MAX) + more,
});

export function renderAuditMenu(health: HealthReport): MenuScreen {
  const n = healthCount(health);
  return {
    text: `🔎 *${AUDIT_TITLE}*\n${escapeMarkdown(AUDIT_INTRO)}`,
    keyboard: {
      inline_keyboard: [
        [{ text: AUDIT_BALANCES_BUTTON, callback_data: auditData({ kind: 'balances' }) }],
        [{ text: AUDIT_HEADLINE_BUTTON, callback_data: auditData({ kind: 'headline' }) }],
        [{ text: n === null ? 'Health' : `Health (${n})`, callback_data: auditData({ kind: 'health' }) }],
      ],
    },
  };
}

export function renderAuditBalances(report: BalanceReport): MenuScreen {
  const lines = ['🔎 *Balances*', report.accounts.length ? AUDIT_TAP_ACCOUNT : AUDIT_NO_ACCOUNTS, ...noteLines(report.notes)];
  const rows: Button[][] = report.accounts.map((e) => [{
    text: `${clip(e.name, 32)} · ${balanceShort(e)}`,
    callback_data: auditData({ kind: 'account', handle: accountHandle(e.wfAccountId), fresh: false }),
  }]);
  rows.push(back({ kind: 'menu' }));
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

export function renderAuditAccount(e: BalanceExplanation, notes: readonly string[], fresh: boolean): MenuScreen {
  const lines = ['🔎 *Balance*', escapeMarkdown(e.name), escapeMarkdown(balanceHeaderLine(e))];
  lines.push(...balanceCauseLines(e).map((l) => `• ${escapeMarkdown(l)}`));
  const includes = balanceIncludesLine(e);
  if (includes) lines.push(escapeMarkdown(includes));
  lines.push(...noteLines(notes));
  return { text: lines.join('\n'), keyboard: { inline_keyboard: fresh ? [] : [back({ kind: 'balances' })] } };
}

export function renderAuditHeadline(h: HeadlineExplanation): MenuScreen {
  const lines = [`🔎 *${AUDIT_HEADLINE_BUTTON}*`];
  const summary = headlineSummaryLine(h);
  if (summary) lines.push(escapeMarkdown(summary));
  const rows: Button[][] = [];
  if (headlineAgrees(h)) lines.push(escapeMarkdown(HEADLINE_AGREE));
  else if (h.reasons) {
    lines.push(...h.reasons.map((r) => `• ${escapeMarkdown(headlineReasonLine(h, r))}`));
    const rest = headlineUnexplainedLine(h);
    if (rest) lines.push(`• ${escapeMarkdown(rest)}`);
    for (const r of h.reasons) {
      rows.push([{ text: `${HEADLINE_REASON_LABELS[r.kind]} (${r.rows.length + (r.more ?? 0)})`, callback_data: auditData({ kind: 'reason', handle: reasonHandle(r) }) }]);
    }
  }
  lines.push(...noteLines(h.notes));
  rows.push(back({ kind: 'menu' }));
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

export function renderAuditReason(r: HeadlineReason): MenuScreen {
  const { shown, hidden } = listed(r.rows, r.more);
  const lines = [`🔎 *${HEADLINE_REASON_LABELS[r.kind]}*`, ...shown.map((row) => escapeMarkdown(headlineRowLine(row)))];
  if (hidden > 0) lines.push(`…and ${hidden} more`);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: [back({ kind: 'headline' })] } };
}

export function renderAuditHealth(report: HealthReport): MenuScreen {
  const lines = ['🔎 *Health*'];
  const numbers: Button[] = [];
  if (report.issues && report.issues.length === 0 && !report.more) lines.push(escapeMarkdown(HEALTH_NONE));
  if (report.issues) {
    const { shown, hidden } = listed(report.issues, report.more);
    shown.forEach((issue, i) => {
      lines.push(`${i + 1}. ${escapeMarkdown(healthIssueTitle(issue))}`);
      numbers.push({ text: String(i + 1), callback_data: auditData({ kind: 'issue', handle: issueHandle(issue) }) });
    });
    if (hidden > 0) lines.push(`…and ${hidden} more`);
  }
  lines.push(...noteLines(report.notes));
  const rows: Button[][] = [];
  for (let i = 0; i < numbers.length; i += 4) rows.push(numbers.slice(i, i + 4));
  rows.push(back({ kind: 'menu' }));
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

export function renderAuditIssue(issue: HealthIssue): MenuScreen {
  const lines = ['🔎 *Health*', escapeMarkdown(healthIssueTitle(issue)), ...healthIssueLines(issue).map(escapeMarkdown)];
  return { text: lines.join('\n'), keyboard: { inline_keyboard: [back({ kind: 'health' })] } };
}

/**
 * `/status`'s buttons: a 🔎 for every account it shows "off by $X", opening
 * that account's explanation as a new message. Null when there are none (the
 * reply then goes without a keyboard, as it always did).
 */
export function auditStatusKeyboard(
  accounts: ReadonlyArray<{ name: string; drift: number | null; wfAccountId?: string }>,
): InlineKeyboard | null {
  const rows = accounts
    .filter((a) => a.drift !== null && !!a.wfAccountId)
    .map((a) => [{ text: `🔎 ${clip(a.name, 40)}`, callback_data: auditData({ kind: 'account', handle: accountHandle(a.wfAccountId!), fresh: true }) }]);
  return rows.length ? { inline_keyboard: rows } : null;
}

type Send = (text: string, keyboard?: InlineKeyboard) => Promise<void>;

export interface AuditMenuUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
  /** A NEW message. */
  send: Send;
}

/** What one tap reads, live. `reached`: the account mapping could be read. */
export interface AuditMenuDeps {
  balances(): Promise<BalanceReport & { reached: boolean }>;
  headline(now: Date): Promise<HeadlineExplanation>;
  health(): Promise<HealthReport & { reached: boolean }>;
  now(): Date;
  log(msg: string): void;
}

/** The deps over the companion's real readers (audit-facts.ts). */
export function auditMenuDeps(readers: AuditReaders, log: (msg: string) => void): AuditMenuDeps {
  return {
    balances: async () => {
      const facts = await gatherBalanceFacts(readers, readAuditLedger(readers));
      return { ...explainBalances(facts), reached: !facts.failed?.includes('mapping') };
    },
    headline: async (now) => explainHeadline(await gatherHeadlineFacts(readers, now)),
    health: async () => {
      const facts = await gatherHealthFacts(readers, readAuditLedger(readers));
      return { ...healthIssues(facts), reached: !facts.failed?.includes('mapping') };
    },
    now: () => new Date(),
    log,
  };
}

export interface AuditMenu {
  handles(data: string): boolean;
  onCallback(cb: { data: string }, ui: AuditMenuUi): Promise<void>;
  /** `/audit`: the menu, as a reply. */
  reply(send: Send): Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** An empty keyboard is sent as none. */
const sendScreen = (send: Send, s: MenuScreen) => (s.keyboard.inline_keyboard.length ? send(s.text, s.keyboard) : send(s.text));

export function createAuditMenu(deps: AuditMenuDeps): AuditMenu {
  return {
    handles(data) {
      return data.startsWith(AUDIT_CALLBACK_PREFIX);
    },

    async reply(send) {
      const health = await deps.health();
      if (!health.reached) return void await send(AUDIT_UNREACHABLE);
      await sendScreen(send, renderAuditMenu(health));
    },

    async onCallback(cb, ui) {
      try {
        const view = parseAuditData(cb.data);
        if (!view) return void await ui.answer();
        const show = async (screen: MenuScreen, fresh = false) => {
          if (fresh) await sendScreen(ui.send, screen);
          else await ui.edit(screen.text, screen.keyboard);
          await ui.answer();
        };
        switch (view.kind) {
          case 'menu': {
            const health = await deps.health();
            if (!health.reached) return void await ui.answer(AUDIT_UNREACHABLE);
            return void await show(renderAuditMenu(health));
          }
          case 'balances': {
            const report = await deps.balances();
            if (!report.reached) return void await ui.answer(AUDIT_UNREACHABLE);
            return void await show(renderAuditBalances(report));
          }
          case 'account': {
            const report = await deps.balances();
            if (!report.reached) return void await ui.answer(AUDIT_UNREACHABLE);
            const e = report.accounts.find((a) => accountHandle(a.wfAccountId) === view.handle);
            if (!e) return void await ui.answer(AUDIT_ACCOUNT_GONE);
            return void await show(renderAuditAccount(e, report.notes, view.fresh), view.fresh);
          }
          case 'headline':
            return void await show(renderAuditHeadline(await deps.headline(deps.now())));
          case 'reason': {
            const h = await deps.headline(deps.now());
            const r = h.reasons?.find((x) => reasonHandle(x) === view.handle);
            if (!r) return void await ui.answer(AUDIT_REASON_GONE);
            return void await show(renderAuditReason(r));
          }
          case 'health': {
            const report = await deps.health();
            return void await show(renderAuditHealth(report));
          }
          case 'issue': {
            const report = await deps.health();
            const issue = report.issues?.find((i) => issueHandle(i) === view.handle);
            if (!issue) return void await ui.answer(AUDIT_ISSUE_GONE);
            return void await show(renderAuditIssue(issue));
          }
        }
      } catch (err) {
        deps.log(`Audit menu: ${cb.data} failed: ${message(err)}`);
        await ui.answer(FAILED_ANSWER).catch(() => {});
      }
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run src/audit-menu.test.ts`
Expected: PASS — 14 tests.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/audit-menu.ts companion/src/audit-menu.test.ts
git commit -m "Companion: /audit — the three checks in a stateless cz:au: menu, live on every tap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `/audit` wired in — More commands, `cz:au:` routed before the transaction menu, a 🔎 on `/status`

The wiring (spec A4; X1e, X4). `/audit` joins `/help`'s More commands — not the registered seven-command ☰ menu. `buildAuditMenu` builds the menu over the companion's real readers; one instance serves commands and taps (`buildTelegramListenerDeps`), and `onMenuCallback` asks it right after `cz:wy:` and before the categorize fallthrough, which would read any `cz:` data it does not know as an expired menu. `/status` reads `account_mapping` too (unreadable: no buttons, the reply otherwise unchanged) and puts a 🔎 row under each account it shows off; with none it replies exactly as before, one argument.

**Files:**
- Modify: `companion/src/index.ts`, `companion/src/index.test.ts`, `shared/telegram-commands.ts`, `shared/telegram-commands.test.ts`

**Interfaces:**
- Consumes: Task 5 (`companionAuditReaders`); Task 7 (`auditMenuDeps`, `auditStatusKeyboard`, `createAuditMenu`, `AuditMenu`).
- Produces:

```ts
// companion/src/index.ts
export function buildAuditMenu(wfClient: WealthfolioClient): AuditMenu;
export function buildTelegramCommandHandler(wfClient, controller?, asks?, why?, audit?: AuditMenu): (cmd, reply) => Promise<void>;
// shared/telegram-commands.ts
StatusReplyInput['accounts'][number]['wfAccountId']?: string;
TELEGRAM_MORE_COMMANDS: [..., { command: 'audit', description: 'Why a balance or the month differs from Wealthfolio, and what its Health page flags' }];
```

- [ ] **Step 1: Write the failing tests**

Edit 1 of 2 in `companion/src/index.test.ts` — replace:

```ts
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending, getNativeCategorizedSpending, getNativeSpendingCategories, getNativeTxSearchRows } from './sqlite-native.js';
import { ingestAmazonMail } from './amazon-mail.js';
import { AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, UNCATEGORIZED_STATUS_SECRET_KEY } from '../../shared/status-keys.js';
import { CATEGORIZE_ENTRY_CALLBACK } from '../../shared/telegram.js';
import { categoryFiledChange, stampChange } from '../../shared/change-entries.js';
import { existsSync } from 'fs';
import type { SyncResult } from '../../shared/sync-core.js';
```

with:

```ts
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending, getNativeCategorizedSpending, getNativeSpendingCategories, getNativeTxSearchRows } from './sqlite-native.js';
import { ingestAmazonMail } from './amazon-mail.js';
import { AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, UNCATEGORIZED_STATUS_SECRET_KEY } from '../../shared/status-keys.js';
import { CATEGORIZE_ENTRY_CALLBACK, escapeMarkdown } from '../../shared/telegram.js';
import { categoryFiledChange, stampChange } from '../../shared/change-entries.js';
import { existsSync } from 'fs';
import type { SyncResult } from '../../shared/sync-core.js';
```

Edit 2 of 2 in `companion/src/index.test.ts` — replace:

```ts
      const ui = { edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) };
      await deps.onMenuCallback!({ data: 'cz:wy:s0:kroger', chatId: 1, messageId: 2 }, ui);
      expect((ui.edit.mock.calls[0] as unknown as [string])[0]).toBe('🔎 *Why is this here?* kroger\n\nTap one to see its story.');
    });
  });

```

with:

```ts
      const ui = { edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) };
      await deps.onMenuCallback!({ data: 'cz:wy:s0:kroger', chatId: 1, messageId: 2 }, ui);
      expect((ui.edit.mock.calls[0] as unknown as [string])[0]).toBe('🔎 *Why is this here?* kroger\n\nTap one to see its story.');
    });
  });

  describe('/audit', () => {
    const NAME = "Joe's *Visa*_[1]";
    const offAccount = (): Array<[string, string]> => [
      ['account_mapping', JSON.stringify({ 'sfin-1': 'wf-1', 'sfin-2': 'wf-2' })],
      ['account_balances', JSON.stringify({
        'sfin-1': { balance: 3475.23, currency: 'USD', date: 1_760_000_000, drift: 13, measured: true },
        'sfin-2': { balance: 100, currency: 'USD', date: 1_760_000_000, drift: null, measured: true },
      })],
      ['account_names', JSON.stringify({ 'sfin-1': NAME, 'sfin-2': 'Save' })],
    ];
    const ui = () => ({ edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) });

    it('replies with the menu, Health counted from the database', async () => {
      const { client } = clientFor();
      const sent: Array<[string, any]> = [];
      await buildTelegramCommandHandler(client)({ command: 'audit', args: '' }, async (t, k) => { sent.push([t, k]); });
      expect(sent[0][0].startsWith('🔎 *Audit*\n')).toBe(true);
      expect(sent[0][1].inline_keyboard.flat().map((b: any) => b.callback_data)).toEqual(['cz:au:b', 'cz:au:h', 'cz:au:i']);
      expect(sent[0][1].inline_keyboard[2][0].text).toBe('Health (0)');
    });

    it("says so when Wealthfolio can't be reached", async () => {
      const client = { getAddonSecret: vi.fn(async () => { throw new Error('ECONNREFUSED'); }), setAddonSecret: vi.fn() } as any;
      const { sent, reply } = collector();
      await buildTelegramCommandHandler(client)({ command: 'audit', args: '' }, reply);
      expect(sent).toEqual(["Couldn't reach Wealthfolio — try again."]);
    });

    it('cz:au: taps reach the audit menu, not the transaction menu', async () => {
      const { client } = clientFor();
      const deps = buildTelegramListenerDeps(client);
      const u = ui();
      await deps.onMenuCallback!({ data: 'cz:au:i', chatId: 1, messageId: 2 }, u);
      expect((u.edit.mock.calls[0] as unknown as [string])[0]).toBe('🔎 *Health*\nNothing the add-on checks for: no incomplete transfers, late starting balances or $CASH rows.');
    });

    it('/status puts a 🔎 under each account that is off: the bank name escaped in the text, raw on the button', async () => {
      const { client } = clientFor(offAccount());
      const sent: Array<[string, any]> = [];
      await buildTelegramCommandHandler(client)({ command: 'status', args: '' }, async (t, k) => { sent.push([t, k]); });
      expect(sent[0][0]).toContain(`${escapeMarkdown(NAME)}: $3,475 · $13 off`);
      expect(sent[0][0]).not.toContain(NAME);
      expect(sent[0][1]).toEqual({ inline_keyboard: [[{ text: `🔎 ${NAME}`, callback_data: `cz:au:s${findingHandle('wf-1')}` }]] });
    });

    it('/status with nothing off replies as it always did, without a keyboard', async () => {
      const { client } = clientFor(offAccount().filter(([k]) => k !== 'account_balances').concat([['account_balances', JSON.stringify({
        'sfin-1': { balance: 1, currency: 'USD', date: 1_760_000_000, drift: null, measured: true },
      })]]));
      const calls: unknown[][] = [];
      await buildTelegramCommandHandler(client)({ command: 'status', args: '' }, async (...args: unknown[]) => { calls.push(args); });
      expect(calls[0]).toHaveLength(1);
    });

    it('the 🔎 opens why that account is off as a new message, a failed read saying so', async () => {
      const { client } = clientFor(offAccount());
      const deps = buildTelegramListenerDeps(client);
      const u = ui();
      await deps.onMenuCallback!({ data: `cz:au:s${findingHandle('wf-1')}`, chatId: 1, messageId: 2 }, u);
      expect(u.edit).not.toHaveBeenCalled();
      const [text] = u.send.mock.calls[0] as unknown as [string];
      expect(text.startsWith(`🔎 *Balance*\n${escapeMarkdown(NAME)}\nBank: $3,475.23`)).toBe(true);
      // This fake client has no valuations: Wealthfolio's figure is unknown, and the reply says why.
      expect(text).toContain("⚠️ Couldn't read Wealthfolio's balances, so cash accounts aren't compared.");
    });
  });

```

Edit 1 of 1 in `shared/telegram-commands.test.ts` — replace:

```ts
    expect(TELEGRAM_COMMAND_MENU.map((c) => c.command))
      .toEqual(['report', 'left', 'categorize', 'charts', 'status', 'sync', 'help']);
  });
  it('keeps the other eight working, listed under "More commands" in /help', () => {
    expect(TELEGRAM_MORE_COMMANDS.map((c) => c.command))
      .toEqual(['afford', 'pool', 'recategorize', 'newrule', 'dismissed', 'subscriptions', 'changes', 'why']);
    const help = formatHelpReply();
    const more = help.indexOf('*More commands*');
    expect(more).toBeGreaterThan(help.indexOf('/help'));
```

with:

```ts
    expect(TELEGRAM_COMMAND_MENU.map((c) => c.command))
      .toEqual(['report', 'left', 'categorize', 'charts', 'status', 'sync', 'help']);
  });
  it('keeps the other nine working, listed under "More commands" in /help', () => {
    expect(TELEGRAM_MORE_COMMANDS.map((c) => c.command))
      .toEqual(['afford', 'pool', 'recategorize', 'newrule', 'dismissed', 'subscriptions', 'changes', 'why', 'audit']);
    const help = formatHelpReply();
    const more = help.indexOf('*More commands*');
    expect(more).toBeGreaterThan(help.indexOf('/help'));
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/index.test.ts`
Expected: FAIL — 5 of the 6 new `/audit` tests (the command answers with `/help`, `cz:au:` falls through to the transaction menu, `/status` sends no keyboard); `/status with nothing off replies as it always did, without a keyboard` already passes.

Run: `npx vitest run shared/telegram-commands.test.ts`
Expected: FAIL — `keeps the other nine working, listed under "More commands" in /help` (`audit` is not listed).

- [ ] **Step 3: Implement**

Edit 1 of 3 in `shared/telegram-commands.ts` — replace:

```ts
 *  `/subscriptions` (1.60) takes no arguments; everything happens on its buttons.
 *  `/changes` lists the change log; `/changes <words>` searches it.
 *  `/why <words or an amount>` (1.61) finds a transaction and tells its story;
 *  bare `/why` asks. */
export const TELEGRAM_MORE_COMMANDS = [
  { command: 'afford', description: 'Can I afford it? — asks, or /afford 20 shopping' },
  { command: 'pool', description: 'Semester money pool — asks, or /pool 16000 Dec 12' },
```

with:

```ts
 *  `/subscriptions` (1.60) takes no arguments; everything happens on its buttons.
 *  `/changes` lists the change log; `/changes <words>` searches it.
 *  `/why <words or an amount>` (1.61) finds a transaction and tells its story;
 *  bare `/why` asks.
 *  `/audit` (2c) takes no arguments; its buttons run each check. */
export const TELEGRAM_MORE_COMMANDS = [
  { command: 'afford', description: 'Can I afford it? — asks, or /afford 20 shopping' },
  { command: 'pool', description: 'Semester money pool — asks, or /pool 16000 Dec 12' },
```

Edit 2 of 3 in `shared/telegram-commands.ts` — replace:

```ts
  { command: 'subscriptions', description: 'Subscriptions and bills — remind, rename, hide, or add one' },
  { command: 'changes', description: 'What changed lately — /changes venmo searches' },
  { command: 'why', description: 'Why is this here? — /why kroger 54.20 finds a transaction and its story' },
] as const;

export function formatHelpReply(unknownCommand?: string): string {
```

with:

```ts
  { command: 'subscriptions', description: 'Subscriptions and bills — remind, rename, hide, or add one' },
  { command: 'changes', description: 'What changed lately — /changes venmo searches' },
  { command: 'why', description: 'Why is this here? — /why kroger 54.20 finds a transaction and its story' },
  { command: 'audit', description: 'Why a balance or the month differs from Wealthfolio, and what its Health page flags' },
] as const;

export function formatHelpReply(unknownCommand?: string): string {
```

Edit 3 of 3 in `shared/telegram-commands.ts` — replace:

```ts
    /** Whether a comparison was actually attempted this run — see the chip
     *  precedence below for why this can't be inferred from `drift` alone. */
    measured: boolean;
  }>;
  /**
   * How many accounts the snapshot HAS but could not be priced — SimpleFin
```

with:

```ts
    /** Whether a comparison was actually attempted this run — see the chip
     *  precedence below for why this can't be inferred from `drift` alone. */
    measured: boolean;
    /** The Wealthfolio account it maps to, when known: what `/status`'s 🔎
     *  button opens (2c). The text never shows it. */
    wfAccountId?: string;
  }>;
  /**
   * How many accounts the snapshot HAS but could not be priced — SimpleFin
```

Edit 1 of 8 in `companion/src/index.ts` — replace:

```ts
} from './subscriptions-menu.js';
import { addDaysIso, dueWithin, formatRosterTotal, manualKey, rosterMoney, type Cadence } from '../../shared/subscription-roster.js';
import { REPORT_CUBE_SECRET_KEY, parseReportCube } from '../../shared/report-cube.js';
import { publishAuditSnapshot } from './audit-facts.js';
import { addManual, editSubscriptionPrefs, emptySubscriptionPrefs, isUnreadablePrefsError, loadSubscriptionPrefs, newManualId, renameKey, setRemind, SubscriptionPrefsInvalidError, type ManualSubscription, type RemindDays, type SecretGet, type SecretSet, type SubscriptionEdit } from '../../shared/subscription-prefs.js';
import { renderReportSvg, reportImageTitle, reportImageCaption, RENDERABLE_REPORT_IDS } from '../../shared/report-render.js';
import { createAskSessions, CANCELLED, CANCELLED_EARLIER, NOT_WAITING, type AskSessions } from './ask-session.js';
```

with:

```ts
} from './subscriptions-menu.js';
import { addDaysIso, dueWithin, formatRosterTotal, manualKey, rosterMoney, type Cadence } from '../../shared/subscription-roster.js';
import { REPORT_CUBE_SECRET_KEY, parseReportCube } from '../../shared/report-cube.js';
import { companionAuditReaders, publishAuditSnapshot } from './audit-facts.js';
import { auditMenuDeps, auditStatusKeyboard, createAuditMenu, type AuditMenu } from './audit-menu.js';
import { addManual, editSubscriptionPrefs, emptySubscriptionPrefs, isUnreadablePrefsError, loadSubscriptionPrefs, newManualId, renameKey, setRemind, SubscriptionPrefsInvalidError, type ManualSubscription, type RemindDays, type SecretGet, type SecretSet, type SubscriptionEdit } from '../../shared/subscription-prefs.js';
import { renderReportSvg, reportImageTitle, reportImageCaption, RENDERABLE_REPORT_IDS } from '../../shared/report-render.js';
import { createAskSessions, CANCELLED, CANCELLED_EARLIER, NOT_WAITING, type AskSessions } from './ask-session.js';
```

Edit 2 of 8 in `companion/src/index.ts` — replace:

```ts
  const balances =
    parseSecretJson<Record<string, StoredAccountBalance>>(balancesRead.raw, 'account_balances') ?? {};
  const names = parseSecretJson<Record<string, string>>(await secret('account_names'), 'account_names') ?? {};
  const uncategorized = parseSecretJson<{ count?: number }>(
    await secret(UNCATEGORIZED_STATUS_SECRET_KEY),
    UNCATEGORIZED_STATUS_SECRET_KEY,
```

with:

```ts
  const balances =
    parseSecretJson<Record<string, StoredAccountBalance>>(balancesRead.raw, 'account_balances') ?? {};
  const names = parseSecretJson<Record<string, string>>(await secret('account_names'), 'account_names') ?? {};
  // Which Wealthfolio account each is, for its 🔎 button (2c). Unreadable:
  // no buttons, and the reply is otherwise unchanged.
  const mapping = parseSecretJson<Record<string, string>>(await secret('account_mapping'), 'account_mapping') ?? {};
  const uncategorized = parseSecretJson<{ count?: number }>(
    await secret(UNCATEGORIZED_STATUS_SECRET_KEY),
    UNCATEGORIZED_STATUS_SECRET_KEY,
```

Edit 3 of 8 in `companion/src/index.ts` — replace:

```ts
      // Absent reads as false: an older build's snapshot proves nothing about
      // whether a comparison actually happened.
      measured: info.measured === true,
    });
  }

```

with:

```ts
      // Absent reads as false: an older build's snapshot proves nothing about
      // whether a comparison actually happened.
      measured: info.measured === true,
      ...(mapping[sfinAccountId] ? { wfAccountId: mapping[sfinAccountId] } : {}),
    });
  }

```

Edit 4 of 8 in `companion/src/index.ts` — replace:

```ts
}

/**
 * The bot's question flows, registered on ONE session holder. Like the
 * categorize controller, one instance must serve `onCommand`, `onText` and
 * `onMenuCallback`, or a question asked through one could never be answered
```

with:

```ts
}

/**
 * `/audit` (2c): why a balance or the month differs from Wealthfolio, and what
 * its Health page flags. Stateless — every tap re-reads — so the listener and
 * `/status`'s 🔎 buttons can share one instance or build their own.
 */
export function buildAuditMenu(wfClient: WealthfolioClient): AuditMenu {
  return createAuditMenu(auditMenuDeps(companionAuditReaders(wfClient, wealthfolioDbPath()), log));
}

/**
 * The bot's question flows, registered on ONE session holder. Like the
 * categorize controller, one instance must serve `onCommand`, `onText` and
 * `onMenuCallback`, or a question asked through one could never be answered
```

Edit 5 of 8 in `companion/src/index.ts` — replace:

```ts
  controller: CategorizeController = buildCategorizeController(wfClient),
  asks: AskSessions = buildAskSessions(wfClient, controller),
  why: WhyMenu = buildWhyMenu(wfClient),
): (cmd: ParsedCommand, reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>) => Promise<void> {
  const budgetSnapshot = () => readBudgetSnapshotWithStyle(wfClient);

```

with:

```ts
  controller: CategorizeController = buildCategorizeController(wfClient),
  asks: AskSessions = buildAskSessions(wfClient, controller),
  why: WhyMenu = buildWhyMenu(wfClient),
  audit: AuditMenu = buildAuditMenu(wfClient),
): (cmd: ParsedCommand, reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>) => Promise<void> {
  const budgetSnapshot = () => readBudgetSnapshotWithStyle(wfClient);

```

Edit 6 of 8 in `companion/src/index.ts` — replace:

```ts
        return;
      }

      case 'status':
        await reply(formatStatusReply(await readStatusReplyInput(wfClient), new Date()));
        return;

      case 'dismissed': {
        const { readLedger } = dismissalLedgerAccess(wfClient);
```

with:

```ts
        return;
      }

      case 'audit':
        // 2c: checked live; "Couldn't reach Wealthfolio" is the answer when it can't be.
        await audit.reply(reply);
        return;

      case 'status': {
        const input = await readStatusReplyInput(wfClient);
        const text = formatStatusReply(input, new Date());
        // 2c: a 🔎 under each account that is off opens why, as a new message.
        // None off, none sent: the reply keeps its one-argument shape.
        const keyboard = auditStatusKeyboard(input.accounts);
        await (keyboard ? reply(text, keyboard) : reply(text));
        return;
      }

      case 'dismissed': {
        const { readLedger } = dismissalLedgerAccess(wfClient);
```

Edit 7 of 8 in `companion/src/index.ts` — replace:

```ts

  /** `/why`: stateless, but one instance serves commands, answers and taps. */
  const why = buildWhyMenu(wfClient);
  /** ONE question slot for commands, plain answers and taps alike. */
  const asks = buildAskSessions(wfClient, categorize, why);
  const runCommand = buildTelegramCommandHandler(wfClient, categorize, asks, why);

  /** The Amazon label picker. Shares the `cz:` callback prefix, so
   *  `onMenuCallback` below asks it first and only then falls through to the
```

with:

```ts

  /** `/why`: stateless, but one instance serves commands, answers and taps. */
  const why = buildWhyMenu(wfClient);
  /** `/audit` (2c) and `/status`'s 🔎 buttons: stateless too. */
  const audit = buildAuditMenu(wfClient);
  /** ONE question slot for commands, plain answers and taps alike. */
  const asks = buildAskSessions(wfClient, categorize, why);
  const runCommand = buildTelegramCommandHandler(wfClient, categorize, asks, why, audit);

  /** The Amazon label picker. Shares the `cz:` callback prefix, so
   *  `onMenuCallback` below asks it first and only then falls through to the
```

Edit 8 of 8 in `companion/src/index.ts` — replace:

```ts
        await why.onCallback(cb, ui);
        return;
      }
      if (cb.data !== RECATEGORIZE_ENTRY_CALLBACK) {
        await categorize.onCallback(cb, ui);
        return;
```

with:

```ts
        await why.onCallback(cb, ui);
        return;
      }
      // `cz:au:` (2c) likewise: /audit and /status's 🔎 buttons.
      if (audit.handles(cb.data)) {
        await audit.onCallback(cb, ui);
        return;
      }
      if (cb.data !== RECATEGORIZE_ENTRY_CALLBACK) {
        await categorize.onCallback(cb, ui);
        return;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run src/index.test.ts src/audit-menu.test.ts`
Expected: PASS — 304 tests.

Run: `npx vitest run shared/telegram-commands.test.ts`
Expected: PASS — 134 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/index.ts companion/src/index.test.ts shared/telegram-commands.ts shared/telegram-commands.test.ts
git commit -m "Companion: /audit in More commands, cz:au: routed before the transaction menu, a 🔎 on /status for each account that is off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The app reads the snapshot; the three checks as views; an "off by" chip that opens why in place

The add-on's half of B3 (spec A5; X3, X5). `SecretsStore.getAuditSnapshot()` reads the secret ok / absent / corrupt — a host read that fails reads as corrupt, never as "none" — and the key joins `KEYS`, so Reset clears it. `src/components/AuditViews.tsx` renders the shared lines as text: one account's explanation with where it came from (`AccountAudit`), the month's breakdown behind "Why is this different from Wealthfolio?" with each reason opening its rows (`HeadlineAuditLink`), Health's issues (`ChecksCard`), the status line (fresh, stale, absent, corrupt), the Checks card's summary and Home's count. `AccountList` takes an optional `renderExplanation`: given one, an "off by" chip is a button that opens it under the account — stopping its click and keys so the row does not open the account in Wealthfolio instead; without one it stays a label, as today. The styles are new `.sfin-audit-*` classes. No emoji, in any state.

**Files:**
- Create: `src/components/AuditViews.tsx`, `src/components/AuditViews.test.tsx`, `src/utils/secrets-audit.test.ts`
- Modify: `src/utils/secrets.ts`, `src/components/AccountList.tsx`, `src/components/AccountList.test.tsx`, `src/components/ui.tsx`

**Interfaces:**
- Consumes: Tasks 1–4 (the line builders, `HEADLINE_AGREE`, `HEALTH_NONE`, `healthCount`, `AUDIT_SNAPSHOT_SECRET_KEY`, `parseAuditSnapshot`, `auditSnapshotStatus`, `AuditSnapshotRead`).
- Produces:

```ts
// src/utils/secrets.ts
class SecretsStore { getAuditSnapshot(): Promise<AuditSnapshotRead> }
// src/components/AuditViews.tsx
export const AUDIT_HEADLINE_LINK = 'Why is this different from Wealthfolio?';
export const AUDIT_ACCOUNT_NOT_COVERED: string;
export interface AuditSource { read: AuditSnapshotRead; companionVersion: string | null; now: Date }
export function AuditStatusLine(props: AuditSource): JSX.Element;
export function BalanceExplanationView(props: { e: BalanceExplanation; notes?: readonly string[] }): JSX.Element;
export function AccountAudit(props: AuditSource & { wfAccountId: string }): JSX.Element;
export function HeadlineView(props: { h: HeadlineExplanation }): JSX.Element;
export function HealthView(props: { report: HealthReport }): JSX.Element;
export function ChecksCard(props: AuditSource): JSX.Element;
export function checksSummary(read: AuditSnapshotRead, companionVersion: string | null): string;
export function healthIssueCount(read: AuditSnapshotRead | null | undefined): number;
export function HeadlineAuditLink(props: AuditSource): JSX.Element;
// src/components/AccountList.tsx
AccountListProps.renderExplanation?: (wfAccountId: string) => React.ReactNode;
```

- [ ] **Step 1: Write the failing tests**

**Create `src/utils/secrets-audit.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { SecretsStore } from './secrets';
import { AUDIT_SNAPSHOT_SECRET_KEY } from '../../shared/audit-snapshot';

const ctxOver = (data: Record<string, string>, fail = false) => ({
  api: {
    secrets: {
      get: vi.fn(async (k: string) => { if (fail) throw new Error('host'); return data[k] ?? null; }),
      set: vi.fn(async (k: string, v: string) => { data[k] = v; }),
      delete: vi.fn(async (k: string) => { delete data[k]; }),
    },
  },
}) as any;

const SNAPSHOT = {
  v: 1, at: '2026-10-13T18:00:00.000Z', balances: {}, balanceNotes: [],
  headline: { month: '2026-10', reportCents: null, wealthfolioCents: null, reasons: null, unexplainedCents: null, notes: [] },
  health: { issues: [], notes: [] },
};

describe('SecretsStore — audit snapshot', () => {
  it('reads the snapshot the companion publishes', async () => {
    const read = await new SecretsStore(ctxOver({ [AUDIT_SNAPSHOT_SECRET_KEY]: JSON.stringify(SNAPSHOT) })).getAuditSnapshot();
    expect(read).toEqual({ kind: 'ok', snapshot: SNAPSHOT });
  });

  it('tells none published from one it cannot read — and a failed host read is never "none"', async () => {
    expect(await new SecretsStore(ctxOver({})).getAuditSnapshot()).toEqual({ kind: 'absent' });
    expect(await new SecretsStore(ctxOver({ [AUDIT_SNAPSHOT_SECRET_KEY]: '{oops' })).getAuditSnapshot()).toEqual({ kind: 'corrupt' });
    expect(await new SecretsStore(ctxOver({}, true)).getAuditSnapshot()).toEqual({ kind: 'corrupt' });
  });

  it('Reset clears it', async () => {
    const data = { [AUDIT_SNAPSHOT_SECRET_KEY]: JSON.stringify(SNAPSHOT) };
    await new SecretsStore(ctxOver(data)).clearAll();
    expect(data[AUDIT_SNAPSHOT_SECRET_KEY]).toBeUndefined();
  });
});
```

**Create `src/components/AuditViews.test.tsx`:**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import React from 'react';
import {
  AccountAudit, ChecksCard, checksSummary, HeadlineAuditLink, healthIssueCount, AUDIT_ACCOUNT_NOT_COVERED, AUDIT_HEADLINE_LINK,
} from './AuditViews';
import {
  buildAuditSnapshot, parseAuditSnapshot, AUDIT_CORRUPT, AUDIT_NEEDS_COMPANION, AUDIT_NOT_YET, type AuditResults, type AuditSnapshotRead,
} from '../../shared/audit-snapshot';
import { explainBalances } from '../../shared/audit-balance';
import { explainHeadline } from '../../shared/audit-headline';
import { healthIssues, HEALTH_NONE, HEALTH_READ_NOTES } from '../../shared/audit-health';
import type { AuditLedgerRow } from '../../shared/audit-ledger';

const EMOJI = /\p{Extended_Pictographic}/u;
const NAME = "Joe's *Visa*_[1]";
const BANK = 'SQ *COFFEE_CLUB [2]';
const AT = new Date(2026, 9, 13, 14, 0);
const LATER = new Date(2026, 9, 13, 18, 30);

const row = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
  id: 'r', accountId: 'wf-chk', date: '2026-10-04', currency: 'USD', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', status: 'POSTED',
  absCents: 0, group: '', assetId: '', external: false, phantomCash: false, notes: 'ROW · TRN-0', ...over,
});
const LEDGER = {
  accounts: [{ id: 'wf-visa', name: 'Visa', type: 'CREDIT_CARD', archived: false }, { id: 'wf-chk', name: 'Checking', type: 'CASH', archived: false }],
  rows: [
    row({ id: 'v1', accountId: 'wf-visa', absCents: 50000, date: '2026-09-01' }),
    row({ id: 'v2', accountId: 'wf-visa', absCents: 1910, notes: `${BANK} · TRN-7 · pending` }),
    row({ id: 'out', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', absCents: 60000, notes: `${BANK} · TRN-1` }),
    row({ id: 'dep', accountId: 'wf-visa', rawType: 'CREDIT', type: 'CREDIT', absCents: 60000, date: '2026-10-05', notes: 'PAYMENT · TRN-2' }),
  ],
};

function results(): AuditResults {
  const headline = explainHeadline({
    month: '2026-10', today: '2026-10-13', reportCents: 130000, wealthfolioCents: 120000, excludedCategoryIds: [],
    rows: [{ id: 'h', date: '2026-10-01T00:00:00+00:00', accountName: NAME, accountType: 'CASH', type: 'WITHDRAWAL', subtype: '', absCents: 2500, notes: `${BANK} · TRN-9`, spendingFilings: 1, categoryIds: ['c'] }],
  });
  headline.reasons![0].more = 5;
  return {
    balances: explainBalances({
      mapping: { 'sfin-v': 'wf-visa' },
      balances: { 'sfin-v': { balance: 100, date: Date.parse('2026-10-13T12:00:00Z') / 1000 } },
      names: { 'sfin-v': NAME },
      valuations: {},
      ledger: LEDGER,
    }),
    headline,
    health: healthIssues({ ledger: LEDGER, mapping: { 'sfin-v': 'wf-visa' } }),
  };
}
const ok = (r: AuditResults = results()): AuditSnapshotRead => parseAuditSnapshot(JSON.stringify(buildAuditSnapshot(r, AT)));

describe('AccountAudit', () => {
  it('explains an account in place, with the sync it came from', () => {
    render(<AccountAudit read={ok()} wfAccountId="wf-visa" companionVersion="1.61.0" now={LATER} />);
    expect(screen.getByText('Bank: $100.00 (Oct 13) · Wealthfolio: $80.90 · Off by $19.10')).toBeInTheDocument();
    expect(screen.getByText("$19.10 in 1 pending transaction the bank hasn't posted")).toBeInTheDocument();
    expect(screen.getByText('As of the 2:00 PM sync.')).toBeInTheDocument();
  });

  it('says when the snapshot does not cover the account', () => {
    render(<AccountAudit read={ok()} wfAccountId="wf-new" companionVersion="1.61.0" now={LATER} />);
    expect(screen.getByText(AUDIT_ACCOUNT_NOT_COVERED)).toBeInTheDocument();
  });

  it('says a stale snapshot is old, and a corrupt or missing one cannot be shown', () => {
    const { unmount } = render(<AccountAudit read={ok()} wfAccountId="wf-visa" companionVersion="1.61.0" now={new Date(2026, 9, 16, 9, 0)} />);
    expect(screen.getByText("These checks are from Oct 13 — the companion hasn't synced since.")).toBeInTheDocument();
    expect(screen.getByText(/Off by \$19\.10/)).toBeInTheDocument();
    unmount();
    const corrupt = render(<AccountAudit read={{ kind: 'corrupt' }} wfAccountId="wf-visa" companionVersion="1.61.0" now={LATER} />);
    expect(screen.getByText(AUDIT_CORRUPT)).toBeInTheDocument();
    expect(screen.queryByText(/Off by/)).toBeNull();
    corrupt.unmount();
    render(<AccountAudit read={{ kind: 'absent' }} wfAccountId="wf-visa" companionVersion={null} now={LATER} />);
    expect(screen.getByText(AUDIT_NEEDS_COMPANION)).toBeInTheDocument();
  });
});

describe('HeadlineAuditLink', () => {
  it('opens in place: both figures, each reason opening its rows, and how many were left out', () => {
    render(<HeadlineAuditLink read={ok()} companionVersion="1.61.0" now={LATER} />);
    expect(screen.queryByText(/The report counts/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: AUDIT_HEADLINE_LINK }));
    expect(screen.getByRole('button', { name: AUDIT_HEADLINE_LINK })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText("The report counts $1,300.00 spent this month; Wealthfolio's Spending page counts $1,200.00.")).toBeInTheDocument();
    expect(screen.getByText('$75.00 not explained by these reasons')).toBeInTheDocument();
    fireEvent.click(screen.getByText(/^\$25\.00 — Dated the 1st at midnight UTC/));
    expect(screen.getByText(`Oct 1 · ${BANK} · $25.00 · ${NAME}`)).toBeInTheDocument();
    expect(screen.getByText('and 5 more')).toBeInTheDocument();
  });
});

describe('ChecksCard', () => {
  it('lists what Health flags, each with what to do', () => {
    render(<ChecksCard read={ok()} companionVersion="1.61.0" now={LATER} />);
    expect(screen.getByText(`${BANK} · $600.00 · Checking · Oct 4`)).toBeInTheDocument();
    expect(screen.getByText('Likely the other half: PAYMENT · $600.00 · Visa · Oct 5')).toBeInTheDocument();
    expect(screen.getByText('As of the 2:00 PM sync.')).toBeInTheDocument();
  });

  it('says nothing is flagged only when Health was checked', () => {
    const clean = { ...results(), health: { issues: [], notes: [] } };
    const { unmount } = render(<ChecksCard read={ok(clean)} companionVersion="1.61.0" now={LATER} />);
    expect(screen.getByText(HEALTH_NONE)).toBeInTheDocument();
    unmount();
    const unchecked = { ...results(), health: healthIssues({ failed: ['ledger'] }) };
    render(<ChecksCard read={ok(unchecked)} companionVersion="1.61.0" now={LATER} />);
    expect(screen.getByText(HEALTH_READ_NOTES.ledger)).toBeInTheDocument();
    expect(screen.queryByText(HEALTH_NONE)).toBeNull();
  });

  it('sums itself up for the collapsed card and Home’s tile', () => {
    expect(checksSummary(ok(), '1.61.0')).toBe('1 to look at');
    expect(checksSummary(ok({ ...results(), health: { issues: [], notes: [] } }), '1.61.0')).toBe('Nothing found');
    expect(checksSummary(ok({ ...results(), health: { issues: null, notes: [] } }), '1.61.0')).toBe('Health not checked');
    expect(checksSummary({ kind: 'absent' }, null)).toBe('Need the companion');
    expect(checksSummary({ kind: 'absent' }, '1.60.0')).toBe('Arrive with the next sync');
    expect(checksSummary({ kind: 'corrupt' }, '1.61.0')).toBe("Couldn't read");
    expect(healthIssueCount(ok())).toBe(1);
    expect(healthIssueCount({ kind: 'corrupt' })).toBe(0);
    expect(healthIssueCount(null)).toBe(0);
  });
});

describe('copy', () => {
  it('renders bank text as text, and no emoji in any state', () => {
    const states: Array<[AuditSnapshotRead, string | null, Date]> = [
      [ok(), '1.61.0', LATER], [ok(), '1.61.0', new Date(2026, 9, 20)], [{ kind: 'absent' }, null, LATER],
      [{ kind: 'absent' }, '1.60.0', LATER], [{ kind: 'corrupt' }, '1.61.0', LATER],
    ];
    for (const [read, version, now] of states) {
      const { container, unmount } = render(
        <>
          <AccountAudit read={read} wfAccountId="wf-visa" companionVersion={version} now={now} />
          <HeadlineAuditLink read={read} companionVersion={version} now={now} />
          <ChecksCard read={read} companionVersion={version} now={now} />
        </>,
      );
      fireEvent.click(screen.getByRole('button', { name: AUDIT_HEADLINE_LINK }));
      expect(container.textContent).not.toMatch(EMOJI);
      unmount();
    }
    expect(AUDIT_NOT_YET).not.toMatch(EMOJI);
  });
});
```

Edit 1 of 1 in `src/components/AccountList.test.tsx` — replace:

```tsx
  });
});

describe('accountsSummary', () => {
  it('names the count, and the difference only when there is one', () => {
    expect(accountsSummary(mapping, balances)).toBe('2 accounts · 1 off by $36.10');
```

with:

```tsx
  });
});

describe('AccountList: why an account is off (2c)', () => {
  it('an "off by" chip opens the explanation in place, and never opens the account', () => {
    const onOpenAccount = vi.fn();
    const { container } = render(
      <AccountList mapping={mapping} balances={balances} sfinNames={sfinNames} wfNames={wfNames} onOpenAccount={onOpenAccount}
        renderExplanation={(wfId) => <div>why {wfId}</div>} />,
    );
    const chip = container.querySelector('button.sfin-audit-chip')!;
    expect(chip.textContent).toContain('off by $36.10');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(chip);
    expect(screen.getByText('why wf-b')).toBeInTheDocument();
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(chip).toHaveAttribute('aria-controls', 'sfin-audit-s2');
    fireEvent.keyDown(chip, { key: 'Enter' });
    expect(onOpenAccount).not.toHaveBeenCalled();
    fireEvent.click(chip);
    expect(screen.queryByText('why wf-b')).toBeNull();
  });

  it('keeps the chip a label without an explainer, and "in sync" is never a button', () => {
    const { container, unmount } = render(
      <AccountList mapping={mapping} balances={balances} sfinNames={sfinNames} wfNames={wfNames} onOpenAccount={() => {}} />,
    );
    expect(container.querySelector('button.sfin-audit-chip')).toBeNull();
    unmount();
    const explained = render(
      <AccountList mapping={mapping} balances={balances} sfinNames={sfinNames} wfNames={wfNames} onOpenAccount={() => {}}
        renderExplanation={() => null} />,
    );
    expect(explained.container.querySelectorAll('button.sfin-audit-chip')).toHaveLength(1);
  });
});

describe('accountsSummary', () => {
  it('names the count, and the difference only when there is one', () => {
    expect(accountsSummary(mapping, balances)).toBe('2 accounts · 1 off by $36.10');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/utils/secrets-audit.test.ts src/components/AuditViews.test.tsx src/components/AccountList.test.tsx`
Expected: FAIL — `Failed to resolve import "./AuditViews"`; the three store tests (`getAuditSnapshot is not a function`, and Reset leaves the secret) and the two new AccountList tests (no `button.sfin-audit-chip`) fail.

- [ ] **Step 3: Implement**

Edit 1 of 3 in `src/utils/secrets.ts` — replace:

```ts
import { SEMESTER_POOL_SECRET_KEY, parsePoolConfig } from '../../shared/pool';
import type { SemesterPoolConfig, PoolStatus } from '../../shared/pool';
import { REPORT_CUBE_SECRET_KEY, parseReportCube } from '../../shared/report-cube';
import type { ReportCube } from '../../shared/report-cube';
import { parseCustomReports } from '../../shared/report-eval';
import type { CustomReport } from '../../shared/report-eval';
```

with:

```ts
import { SEMESTER_POOL_SECRET_KEY, parsePoolConfig } from '../../shared/pool';
import type { SemesterPoolConfig, PoolStatus } from '../../shared/pool';
import { REPORT_CUBE_SECRET_KEY, parseReportCube } from '../../shared/report-cube';
import { AUDIT_SNAPSHOT_SECRET_KEY, parseAuditSnapshot, type AuditSnapshotRead } from '../../shared/audit-snapshot';
import type { ReportCube } from '../../shared/report-cube';
import { parseCustomReports } from '../../shared/report-eval';
import type { CustomReport } from '../../shared/report-eval';
```

Edit 2 of 3 in `src/utils/secrets.ts` — replace:

```ts
  poolStatus: POOL_STATUS_SECRET_KEY,
  // Companion-published like poolStatus; in KEYS for the same clearAll reason.
  reportCube: REPORT_CUBE_SECRET_KEY,
  customReports: 'custom_reports',
  budgetLayout: 'budget_layout',
  openCards: 'ui_open_cards',
```

with:

```ts
  poolStatus: POOL_STATUS_SECRET_KEY,
  // Companion-published like poolStatus; in KEYS for the same clearAll reason.
  reportCube: REPORT_CUBE_SECRET_KEY,
  // The audits' snapshot (2c): companion-published, addon-read-only, cleared on Reset.
  auditSnapshot: AUDIT_SNAPSHOT_SECRET_KEY,
  customReports: 'custom_reports',
  budgetLayout: 'budget_layout',
  openCards: 'ui_open_cards',
```

Edit 3 of 3 in `src/utils/secrets.ts` — replace:

```ts
    }
  }

  /** The user's saved custom reports. Malformed entries are dropped
   *  individually by the parser, so one bad row cannot cost the collection. */
  async getCustomReports(): Promise<CustomReport[]> {
```

with:

```ts
    }
  }

  /** The companion's audit snapshot (2c): ok, absent (none published yet)
   *  or corrupt. A host read that fails reads as corrupt too: the Checks card
   *  then says it could not read them, never that there are none. */
  async getAuditSnapshot(): Promise<AuditSnapshotRead> {
    try {
      return parseAuditSnapshot(await this.ctx.api.secrets.get(KEYS.auditSnapshot));
    } catch {
      return { kind: 'corrupt' };
    }
  }

  /** The user's saved custom reports. Malformed entries are dropped
   *  individually by the parser, so one bad row cannot cost the collection. */
  async getCustomReports(): Promise<CustomReport[]> {
```

**Create `src/components/AuditViews.tsx`:**

```tsx
import React, { useState } from 'react';
import { balanceCauseLines, balanceHeaderLine, balanceIncludesLine, type BalanceExplanation } from '../../shared/audit-balance';
import {
  headlineAgrees, headlineReasonLine, headlineRowLine, headlineSummaryLine, headlineUnexplainedLine, HEADLINE_AGREE,
  type HeadlineExplanation,
} from '../../shared/audit-headline';
import { healthCount, healthIssueLines, healthIssueTitle, HEALTH_NONE, type HealthReport } from '../../shared/audit-health';
import { auditSnapshotStatus, type AuditSnapshotRead } from '../../shared/audit-snapshot';

/**
 * The three checks as the app shows them (2c R1, spec A5), from the
 * companion's snapshot (shared/audit-snapshot.ts): why a balance is off
 * (inline under its account), why the month's spending differs from
 * Wealthfolio's (in place under the Budget tab's headline numbers), and what
 * Wealthfolio's Health page flags (Settings → Checks). Every line comes from
 * the shared builders — the words Telegram sends — and renders as text, so
 * bank text is never markup. No emoji (src/pages/copy-policy.test.tsx).
 */
export const AUDIT_HEADLINE_LINK = 'Why is this different from Wealthfolio?';
export const AUDIT_ACCOUNT_NOT_COVERED = "These checks don't cover this account yet — they arrive with the companion's next sync.";

export interface AuditSource {
  read: AuditSnapshotRead;
  companionVersion: string | null;
  now: Date;
}

/** Where the checks came from: "As of the 2:00 PM sync.", stale, absent or unreadable. */
export function AuditStatusLine({ read, companionVersion, now }: AuditSource) {
  const { state, line } = auditSnapshotStatus(read, companionVersion, now);
  return <div className={`sfin-subtle sfin-audit-status sfin-audit-status--${state}`}>{line}</div>;
}

function AuditNotes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return <ul className="sfin-audit-notes">{notes.map((n) => <li key={n}>{n}</li>)}</ul>;
}

export function BalanceExplanationView({ e, notes = [] }: { e: BalanceExplanation; notes?: readonly string[] }) {
  const causes = balanceCauseLines(e);
  const includes = balanceIncludesLine(e);
  return (
    <div className="sfin-audit-body">
      <div className="sfin-audit-head">{balanceHeaderLine(e)}</div>
      {causes.length > 0 && <ul className="sfin-audit-lines">{causes.map((l) => <li key={l}>{l}</li>)}</ul>}
      {includes && <div className="sfin-subtle">{includes}</div>}
      <AuditNotes notes={notes} />
    </div>
  );
}

/** One account's explanation from the snapshot, with where it came from. */
export function AccountAudit({ wfAccountId, ...source }: AuditSource & { wfAccountId: string }) {
  const e = source.read.kind === 'ok' ? source.read.snapshot.balances[wfAccountId] : undefined;
  return (
    <div className="sfin-audit-inline">
      {source.read.kind === 'ok' && (e
        ? <BalanceExplanationView e={e} notes={source.read.snapshot.balanceNotes} />
        : <div className="sfin-subtle">{AUDIT_ACCOUNT_NOT_COVERED}</div>)}
      <AuditStatusLine {...source} />
    </div>
  );
}

export function HeadlineView({ h }: { h: HeadlineExplanation }) {
  const summary = headlineSummaryLine(h);
  const rest = headlineUnexplainedLine(h);
  return (
    <div className="sfin-audit-body">
      {summary && <div className="sfin-audit-head">{summary}</div>}
      {headlineAgrees(h) ? <div>{HEADLINE_AGREE}</div> : h.reasons && (
        <ul className="sfin-audit-lines">
          {h.reasons.map((r) => (
            <li key={r.kind}>
              <details className="sfin-audit-reason">
                <summary>{headlineReasonLine(h, r)}</summary>
                <ul className="sfin-audit-rows">{r.rows.map((row, i) => <li key={i}>{headlineRowLine(row)}</li>)}</ul>
                {r.more ? <div className="sfin-subtle">and {r.more} more</div> : null}
              </details>
            </li>
          ))}
          {rest && <li>{rest}</li>}
        </ul>
      )}
      <AuditNotes notes={h.notes} />
    </div>
  );
}

export function HealthView({ report }: { report: HealthReport }) {
  return (
    <div className="sfin-audit-body">
      {report.issues && report.issues.length === 0 && !report.more && <div>{HEALTH_NONE}</div>}
      {report.issues && report.issues.length > 0 && (
        <ul className="sfin-audit-issues">
          {report.issues.map((i) => (
            <li key={i.key} className="sfin-audit-issue">
              <div className="sfin-audit-head">{healthIssueTitle(i)}</div>
              {healthIssueLines(i).map((l) => <div key={l} className="sfin-subtle">{l}</div>)}
            </li>
          ))}
        </ul>
      )}
      {report.more ? <div className="sfin-subtle">and {report.more} more</div> : null}
      <AuditNotes notes={report.notes} />
    </div>
  );
}

/** Settings → Checks: what Health flags, and where the checks came from. */
export function ChecksCard(source: AuditSource) {
  return (
    <div className="sfin-audit-checks">
      {source.read.kind === 'ok' && <HealthView report={source.read.snapshot.health} />}
      <AuditStatusLine {...source} />
    </div>
  );
}

/** The Checks card's collapsed summary. */
export function checksSummary(read: AuditSnapshotRead, companionVersion: string | null): string {
  if (read.kind === 'corrupt') return "Couldn't read";
  if (read.kind === 'absent') return companionVersion ? 'Arrive with the next sync' : 'Need the companion';
  const n = healthCount(read.snapshot.health);
  return n === null ? 'Health not checked' : n === 0 ? 'Nothing found' : `${n} to look at`;
}

/** How many things Health flags, for Home's Accounts tile; 0 when unknown. */
export function healthIssueCount(read: AuditSnapshotRead | null | undefined): number {
  return read?.kind === 'ok' ? healthCount(read.snapshot.health) ?? 0 : 0;
}

/** The Budget tab's "Why is this different from Wealthfolio?", opening in place. */
export function HeadlineAuditLink(source: AuditSource) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sfin-audit-headline">
      <button type="button" className="sfin-audit-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {AUDIT_HEADLINE_LINK}
      </button>
      {open && (
        <div className="sfin-audit-inline">
          {source.read.kind === 'ok' && <HeadlineView h={source.read.snapshot.headline} />}
          <AuditStatusLine {...source} />
        </div>
      )}
    </div>
  );
}
```

Edit 1 of 6 in `src/components/AccountList.tsx` — replace:

```tsx
import React from 'react';
import { CheckIcon, AlertIcon } from './ui';
import type { AccountBalanceInfo } from '../utils/secrets';
import type { AccountMapping } from '../../shared/types';
```

with:

```tsx
import React, { useState } from 'react';
import { CheckIcon, AlertIcon } from './ui';
import type { AccountBalanceInfo } from '../utils/secrets';
import type { AccountMapping } from '../../shared/types';
```

Edit 2 of 6 in `src/components/AccountList.tsx` — replace:

```tsx
   *  by their absence, that the target account no longer exists. */
  wfNames: Record<string, string>;
  onOpenAccount: (wfAccountId: string) => void;
}

/** "2 accounts · 1 off by $36.10": the collapsed Accounts card's summary and
```

with:

```tsx
   *  by their absence, that the target account no longer exists. */
  wfNames: Record<string, string>;
  onOpenAccount: (wfAccountId: string) => void;
  /** 2c: why an account is off, opened in place under it from its "off by"
   *  chip. Absent: the chip stays a plain label. */
  renderExplanation?: (wfAccountId: string) => React.ReactNode;
}

/** "2 accounts · 1 off by $36.10": the collapsed Accounts card's summary and
```

Edit 3 of 6 in `src/components/AccountList.tsx` — replace:

```tsx
 * against the bank. Moved out of the Overview tab (1.57) so Settings → Accounts
 * can show the same rows the mapping beneath them is about.
 */
export function AccountList({ mapping, balances, sfinNames, wfNames, onOpenAccount }: AccountListProps) {
  const entries = Object.entries(mapping).filter(([, wfId]) => !!wfId);
  const asOf = entries
    .map(([sfinId]) => balances[sfinId]?.date)
```

with:

```tsx
 * against the bank. Moved out of the Overview tab (1.57) so Settings → Accounts
 * can show the same rows the mapping beneath them is about.
 */
export function AccountList({ mapping, balances, sfinNames, wfNames, onOpenAccount, renderExplanation }: AccountListProps) {
  /** The account whose "off by" chip is open, by SimpleFin id. */
  const [explaining, setExplaining] = useState<string | null>(null);
  const entries = Object.entries(mapping).filter(([, wfId]) => !!wfId);
  const asOf = entries
    .map(([sfinId]) => balances[sfinId]?.date)
```

Edit 4 of 6 in `src/components/AccountList.tsx` — replace:

```tsx
      const exists = !!wfNames[wfId];
      const open = () => { if (exists) onOpenAccount(wfId); };
      return (
        // One full-width card per account, stacked. A grid of two columns
        // made the balance and its chip compete with the neighbouring
        // account's name; a row that spans the width does not.
        <div
          className={`sfin-card sfin-acct-card${exists ? ' sfin-acct-card--link' : ''}`}
          key={sfinId}
          {...(exists
            ? {
                role: 'button',
```

with:

```tsx
      const exists = !!wfNames[wfId];
      const open = () => { if (exists) onOpenAccount(wfId); };
      return (
        <React.Fragment key={sfinId}>
        {/* One full-width card per account, stacked. A grid of two columns
            made the balance and its chip compete with the neighbouring
            account's name; a row that spans the width does not. */}
        <div
          className={`sfin-card sfin-acct-card${exists ? ' sfin-acct-card--link' : ''}`}
          {...(exists
            ? {
                role: 'button',
```

Edit 5 of 6 in `src/components/AccountList.tsx` — replace:

```tsx
                means unmeasured, since a snapshot from an older build has
                proved nothing about the current state either. */}
            {info && info.balance != null && (info.drift != null ? (
              <span className="sfin-chip sfin-chip--off"><AlertIcon /> off by {money(Math.abs(info.drift), info.currency)}</span>
            ) : (info as { measured?: boolean }).measured ? (
              <span className="sfin-chip"><CheckIcon /> in sync</span>
            ) : (
```

with:

```tsx
                means unmeasured, since a snapshot from an older build has
                proved nothing about the current state either. */}
            {info && info.balance != null && (info.drift != null ? (
              renderExplanation ? (
                // A button inside the row's own button: it stops its click and
                // its keys here, or the row would open the account instead.
                <button
                  type="button"
                  className="sfin-chip sfin-chip--off sfin-audit-chip"
                  title="See why"
                  aria-expanded={explaining === sfinId}
                  {...(explaining === sfinId ? { 'aria-controls': `sfin-audit-${sfinId}` } : {})}
                  onClick={(ev) => { ev.stopPropagation(); setExplaining((cur) => (cur === sfinId ? null : sfinId)); }}
                  onKeyDown={(ev) => ev.stopPropagation()}
                >
                  <AlertIcon /> off by {money(Math.abs(info.drift), info.currency)}
                </button>
              ) : (
                <span className="sfin-chip sfin-chip--off"><AlertIcon /> off by {money(Math.abs(info.drift), info.currency)}</span>
              )
            ) : (info as { measured?: boolean }).measured ? (
              <span className="sfin-chip"><CheckIcon /> in sync</span>
            ) : (
```

Edit 6 of 6 in `src/components/AccountList.tsx` — replace:

```tsx
            ))}
          </div>
        </div>
      );
    });
  // No frame or heading of its own: it sits inside Settings' Accounts card,
```

with:

```tsx
            ))}
          </div>
        </div>
        {explaining === sfinId && renderExplanation && (
          <div className="sfin-audit-under" id={`sfin-audit-${sfinId}`}>{renderExplanation(wfId)}</div>
        )}
        </React.Fragment>
      );
    });
  // No frame or heading of its own: it sits inside Settings' Accounts card,
```

Edit 1 of 1 in `src/components/ui.tsx` — replace:

```tsx
  .sfin-why-open { grid-template-columns: 6.5em minmax(0, 1fr); }
  .sfin-why-amt { grid-column: 2; }
}
@keyframes sfin-pop { from { transform: scale(.92); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.sfin-range-pin { position: absolute; bottom: 6px; right: 10px; font-size: var(--sfin-sz-2xs); color: var(--muted-foreground); background: color-mix(in srgb, var(--card) 80%, transparent); border-radius: var(--sfin-rad-xs); padding: 1px 6px; }
/* Drag feedback: the picked-up card lifts and fades while every other card
```

with:

```tsx
  .sfin-why-open { grid-template-columns: 6.5em minmax(0, 1fr); }
  .sfin-why-amt { grid-column: 2; }
}
/* Audits (2c): why a balance is off (under its account), why the month differs
   from Wealthfolio (under the headline numbers), and what Health flags
   (Settings → Checks). */
.sfin-audit-chip { border: none; font-family: inherit; cursor: pointer; }
.sfin-audit-chip:hover { text-decoration: underline; text-underline-offset: 2px; }
.sfin-audit-under { margin: -4px 0 10px; }
.sfin-audit-inline { padding: 4px 0 8px 12px; border-left: 2px solid var(--border); display: flex; flex-direction: column; gap: 6px; font-size: var(--sfin-sz-sm); }
.sfin-audit-body { display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }
.sfin-audit-head { font-weight: 600; }
.sfin-audit-lines { margin: 2px 0; padding-left: 1.1em; display: flex; flex-direction: column; gap: 2px; }
.sfin-audit-reason > summary { cursor: pointer; }
.sfin-audit-rows { margin: 4px 0; padding-left: 1.1em; font-size: var(--sfin-sz-xs); color: var(--muted-foreground); }
.sfin-audit-issues { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.sfin-audit-issue { border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent); padding-top: 6px; }
.sfin-audit-issue:first-child { border-top: none; padding-top: 0; }
.sfin-audit-notes { margin: 4px 0 0; padding-left: 1.1em; color: var(--destructive); font-size: var(--sfin-sz-xs); }
.sfin-audit-status { font-size: var(--sfin-sz-xs); }
.sfin-audit-status--stale, .sfin-audit-status--corrupt { color: var(--destructive); }
.sfin-audit-checks { display: flex; flex-direction: column; gap: 8px; }
.sfin-audit-headline { margin-top: 8px; }
.sfin-audit-link { padding: 0; border: none; background: transparent; color: var(--primary); font: inherit; font-size: var(--sfin-sz-sm); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
@keyframes sfin-pop { from { transform: scale(.92); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.sfin-range-pin { position: absolute; bottom: 6px; right: 10px; font-size: var(--sfin-sz-2xs); color: var(--muted-foreground); background: color-mix(in srgb, var(--card) 80%, transparent); border-radius: var(--sfin-rad-xs); padding: 1px 6px; }
/* Drag feedback: the picked-up card lifts and fades while every other card
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/utils/secrets-audit.test.ts src/components/AuditViews.test.tsx src/components/AccountList.test.tsx src/utils/secrets.test.ts src/components/theme-styles.test.ts`
Expected: PASS — 63 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/utils/secrets.ts src/utils/secrets-audit.test.ts src/components/AuditViews.tsx src/components/AuditViews.test.tsx src/components/AccountList.tsx src/components/AccountList.test.tsx src/components/ui.tsx
git commit -m "App: read the audit snapshot corrupt-aware; the three checks as views; an off-by chip that opens why in place

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The app's three ways in — Settings → Checks and the chips, the Budget tab's link, Home's tile

The wiring (spec A5; X1f). `SyncPage` reads the snapshot once, on the same refresh path as the cube (on its own, optional-called, so it can never cost the other reads), and hands it on. **Settings:** a **Checks** card right after Accounts (`CARD.checks = 'checks'`), its summary "1 to look at" / "Nothing found" / … and its body Health's issues with the status line; the Accounts card's list gets `renderExplanation`, so an "off by" chip opens why under the account. **Budget tab:** "Why is this different from Wealthfolio?" under the toolbar, above the board the headline numbers lead — outside the grid, whose cards clip their bodies. **Home:** with something to look at, the Accounts tile adds "Checks: N to look at" and opens Settings on the Checks card; otherwise it opens Accounts, as today. Integration tests go through the page that loads the snapshot.

**Files:**
- Create: `src/pages/audit-app.test.tsx`
- Modify: `src/pages/SyncPage.tsx`, `src/tabs/SettingsTab.tsx`, `src/tabs/BudgetTab.tsx`, `src/tabs/HomeTab.tsx`

**Interfaces:**
- Consumes: Task 9 (`AccountAudit`, `ChecksCard`, `checksSummary`, `HeadlineAuditLink`, `healthIssueCount`, `AuditSource`, `SecretsStore.getAuditSnapshot`); Task 4 (`AuditSnapshotRead`).
- Produces:

```ts
// src/tabs/SettingsTab.tsx
export const CARD: { …; checks: 'checks' };
Props.auditSnapshot?: AuditSnapshotRead | null;
// src/tabs/BudgetTab.tsx
BudgetTabProps.audit?: AuditSource;
// src/tabs/HomeTab.tsx
Props.auditSnapshot?: AuditSnapshotRead | null;
```

- [ ] **Step 1: Write the failing tests**

**Create `src/pages/audit-app.test.tsx`:**

```tsx
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { SyncPage } from './SyncPage';
import { makeProps } from './test-props';
import { BudgetTab } from '../tabs/BudgetTab';
import type { ReportCube } from '../../shared/report-cube';
import { AUDIT_HEADLINE_LINK } from '../components/AuditViews';
import { explainBalances } from '../../shared/audit-balance';
import { explainHeadline } from '../../shared/audit-headline';
import { healthIssues } from '../../shared/audit-health';
import type { AuditLedgerRow } from '../../shared/audit-ledger';
import {
  buildAuditSnapshot, parseAuditSnapshot, AUDIT_CORRUPT, AUDIT_NEEDS_COMPANION, type AuditSnapshotRead,
} from '../../shared/audit-snapshot';

/**
 * The app's three ways into the audits (2c R1, spec A5), through the page
 * that loads the snapshot: Settings → Checks and the Accounts card's chips,
 * Home's Accounts tile, and the Budget tab's link.
 */
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
vi.mock('../utils/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sync')>();
  return { INTERVAL_SKIP_MESSAGE: actual.INTERVAL_SKIP_MESSAGE, runSync: vi.fn(async () => ({ imported: 0, skipped: 0, errors: [] })) };
});

const AT = new Date(2026, 9, 13, 14, 0);
const LATER = new Date(2026, 9, 13, 18, 30);
const ISSUE = 'TO SAVINGS · $600.00 · Spend · Oct 4';

const row = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
  id: 'r', accountId: 'wf-b', date: '2026-10-04', currency: 'USD', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL', status: 'POSTED',
  absCents: 0, group: '', assetId: '', external: false, phantomCash: false, notes: 'ROW · TRN-0', ...over,
});
/** test-props' Spend (sfin-2 → wf-b) is off by $15.22: a pending charge, and one unlinked transfer. */
function snapshot(): AuditSnapshotRead {
  const ledger = {
    accounts: [{ id: 'wf-b', name: 'Spend', type: 'CASH', archived: false }],
    rows: [
      row({ id: 'p', absCents: 1522, notes: 'COFFEE · TRN-5 · pending' }),
      row({ id: 'out', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', absCents: 60000, notes: 'TO SAVINGS · TRN-6' }),
    ],
  };
  return parseAuditSnapshot(JSON.stringify(buildAuditSnapshot({
    balances: explainBalances({
      mapping: { 'sfin-2': 'wf-b' }, balances: { 'sfin-2': { balance: -420.1, date: null } }, names: { 'sfin-2': 'Spend' },
      valuations: { 'wf-b': -43532 }, ledger,
    }),
    headline: explainHeadline({ month: '2026-10', today: '2026-10-13', reportCents: 130000, wealthfolioCents: 120000, rows: [], excludedCategoryIds: [] }),
    health: healthIssues({ ledger, mapping: { 'sfin-2': 'wf-b' } }),
  }, AT)));
}

const at = (when: Date) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(when);
  onTestFinished(() => { vi.useRealTimers(); });
};

function page(read: AuditSnapshotRead, opts: { tab?: string; cards?: Record<string, boolean>; companion?: string | null } = {}) {
  const props = makeProps();
  props.store.getUiState = vi.fn(async () => ({ activeTab: opts.tab ?? 'settings' }));
  props.store.getOpenCards = vi.fn(async () => opts.cards ?? {});
  props.store.getCompanionVersion = vi.fn(async () => (opts.companion === undefined ? '1.61.0' : opts.companion));
  props.store.getAuditSnapshot = vi.fn(async () => read);
  return { props, ...render(<SyncPage {...props} />) };
}

describe('Settings → Checks', () => {
  it('lists what Health flags, with when the checks were taken', async () => {
    at(LATER);
    page(snapshot(), { cards: { checks: true } });
    expect(await screen.findByText('1 to look at')).toBeInTheDocument();
    expect(screen.getByText(ISSUE)).toBeInTheDocument();
    expect(screen.getByText('No likely other half within 5 days — if it has one, link the two in Wealthfolio.')).toBeInTheDocument();
    expect(screen.getByText('As of the 2:00 PM sync.')).toBeInTheDocument();
  });

  it.each<[string, () => AuditSnapshotRead, string | null, Date, string, string]>([
    ['stale', snapshot, '1.61.0', new Date(2026, 9, 16, 9, 0), '1 to look at', "These checks are from Oct 13 — the companion hasn't synced since."],
    ['corrupt', () => ({ kind: 'corrupt' }), '1.61.0', LATER, "Couldn't read", AUDIT_CORRUPT],
    ['missing, with no companion', () => ({ kind: 'absent' }), null, LATER, 'Need the companion', AUDIT_NEEDS_COMPANION],
  ])('says so when the snapshot is %s', async (_what, read, companion, now, summary, line) => {
    at(now);
    page(read(), { cards: { checks: true }, companion });
    expect(await screen.findByText(summary)).toBeInTheDocument();
    expect(screen.getByText(line)).toBeInTheDocument();
  });

  it('an account’s "off by" chip opens why in place, under the account', async () => {
    at(LATER);
    const { container } = page(snapshot(), { cards: { accounts: true } });
    await waitFor(() => expect(container.querySelector('button.sfin-audit-chip')).toBeTruthy());
    fireEvent.click(container.querySelector('button.sfin-audit-chip')!);
    expect(screen.getByText('Bank: -$420.10 · Wealthfolio: -$435.32 · Off by $15.22')).toBeInTheDocument();
    expect(screen.getByText("$15.22 in 1 pending transaction the bank hasn't posted")).toBeInTheDocument();
  });
});

describe('Home’s Accounts tile', () => {
  it('says how many checks to look at, and opens Settings on the Checks card', async () => {
    at(LATER);
    page(snapshot(), { tab: 'home' });
    const tile = await screen.findByRole('button', { name: /^Accounts: .* · Checks: 1 to look at$/ });
    expect(screen.getByText('Checks: 1 to look at')).toBeInTheDocument();
    fireEvent.click(tile);
    expect(await screen.findByText(ISSUE)).toBeInTheDocument();
  });

  it('says nothing about checks with nothing to look at, and still opens Accounts', async () => {
    at(LATER);
    page({ kind: 'absent' }, { tab: 'home' });
    const tile = await screen.findByRole('button', { name: /^Accounts: / });
    expect(screen.queryByText(/Checks:/)).toBeNull();
    fireEvent.click(tile);
    await waitFor(() => expect(document.querySelector('#sfin-panel-settings')).toBeTruthy());
    expect(screen.queryByText(ISSUE)).toBeNull();
  });
});

describe('the Budget tab', () => {
  const CUBE: ReportCube = {
    version: 1, asOf: LATER.toISOString(), months: ['2026-10'], categories: ['Food'],
    accounts: [{ sfinId: 'sfin-2', name: 'Spend', type: 'CASH' }],
    spend: [[[100000]]], uncategorized: [[30000]], income: [[0]], budgets: [[0]], merchants: [[]], feesInterest: [0],
    netWorth: [null], liquid: [null], pool: null,
  };
  const tab = (audit?: React.ComponentProps<typeof BudgetTab>['audit']) => render(
    <BudgetTab cube={CUBE} customReports={[]} layout={null} onLayoutChange={() => {}} onCustomReportsChange={() => {}} store={{} as any} audit={audit} />,
  );

  it('opens "Why is this different from Wealthfolio?" in place', () => {
    tab({ read: snapshot(), companionVersion: '1.61.0', now: LATER });
    fireEvent.click(screen.getByRole('button', { name: AUDIT_HEADLINE_LINK }));
    expect(screen.getByText("The report counts $1,300.00 spent this month; Wealthfolio's Spending page counts $1,200.00.")).toBeInTheDocument();
    expect(screen.getByText('$100.00 not explained by these reasons')).toBeInTheDocument();
  });

  it('shows no link without the snapshot', () => {
    tab();
    expect(screen.queryByRole('button', { name: AUDIT_HEADLINE_LINK })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/pages/audit-app.test.tsx`
Expected: FAIL — 7 of 9: no Checks card ("1 to look at" not found), no chip button, no "Checks:" on Home's tile, no link on the Budget tab; `says nothing about checks with nothing to look at…` and `shows no link without the snapshot` already pass.

- [ ] **Step 3: Implement**

Edit 1 of 6 in `src/pages/SyncPage.tsx` — replace:

```tsx
import { SettingsTab, CARD as SETTINGS_CARD } from '../tabs/SettingsTab';
import { ReportsTab } from '../tabs/ReportsTab';
import { parseReportsLink } from '../../shared/reports-archive';
import { useAmazonDraft } from '../components/AmazonCard';
import type { SecretsStore, AccountBalanceInfo, CategoryCatalogEntry } from '../utils/secrets';
import type { Scheduler } from '../utils/scheduler';
```

with:

```tsx
import { SettingsTab, CARD as SETTINGS_CARD } from '../tabs/SettingsTab';
import { ReportsTab } from '../tabs/ReportsTab';
import { parseReportsLink } from '../../shared/reports-archive';
import type { AuditSnapshotRead } from '../../shared/audit-snapshot';
import { useAmazonDraft } from '../components/AmazonCard';
import type { SecretsStore, AccountBalanceInfo, CategoryCatalogEntry } from '../utils/secrets';
import type { Scheduler } from '../utils/scheduler';
```

Edit 2 of 6 in `src/pages/SyncPage.tsx` — replace:

```tsx
  const [reportCube, setReportCube] = useState<
    Awaited<ReturnType<SecretsStore['getReportCube']>>
  >(null);
  const [customReports, setCustomReportsState] = useState<
    Awaited<ReturnType<SecretsStore['getCustomReports']>>
  >([]);
```

with:

```tsx
  const [reportCube, setReportCube] = useState<
    Awaited<ReturnType<SecretsStore['getReportCube']>>
  >(null);
  // The companion's audit snapshot (2c): Settings → Checks and the account
  // chips, Home's Accounts tile, the Budget tab's link. Null until read.
  const [auditSnapshot, setAuditSnapshot] = useState<AuditSnapshotRead | null>(null);
  const [customReports, setCustomReportsState] = useState<
    Awaited<ReturnType<SecretsStore['getCustomReports']>>
  >([]);
```

Edit 3 of 6 in `src/pages/SyncPage.tsx` — replace:

```tsx
        setSubscriptionPrefs(subPrefs ?? null);
      })
      .catch(() => {});
  }, [store]);

  const onDismissalsChange = useCallback((next: DismissalLedger) => {
```

with:

```tsx
        setSubscriptionPrefs(subPrefs ?? null);
      })
      .catch(() => {});
    // On its own, so it can never cost the reads above: optional-called, and
    // the store answers ok / absent / corrupt rather than throwing.
    store.getAuditSnapshot?.().then(setAuditSnapshot).catch(() => {});
  }, [store]);

  const onDismissalsChange = useCallback((next: DismissalLedger) => {
```

Edit 4 of 6 in `src/pages/SyncPage.tsx` — replace:

```tsx
          // The pool tile opens the burn-down full-screen in the budget below,
          // which already carries the pool editor.
          onOpenPool={() => setBudgetOpen((prev) => ({ id: 'pool-burndown', seq: (prev?.seq ?? 0) + 1 }))}
          renderTxStory={renderTxStory}
        />
        <BudgetTab
```

with:

```tsx
          // The pool tile opens the burn-down full-screen in the budget below,
          // which already carries the pool editor.
          onOpenPool={() => setBudgetOpen((prev) => ({ id: 'pool-burndown', seq: (prev?.seq ?? 0) + 1 }))}
          auditSnapshot={auditSnapshot}
          renderTxStory={renderTxStory}
        />
        <BudgetTab
```

Edit 5 of 6 in `src/pages/SyncPage.tsx` — replace:

```tsx
          onSetUpCompanion={() => navigate('settings', SETTINGS_CARD.docker)}
          openRequest={budgetOpen}
          renderTxStory={renderTxStory}
        />
      </TabPanel>

```

with:

```tsx
          onSetUpCompanion={() => navigate('settings', SETTINGS_CARD.docker)}
          openRequest={budgetOpen}
          renderTxStory={renderTxStory}
          audit={auditSnapshot ? { read: auditSnapshot, companionVersion, now: new Date() } : undefined}
        />
      </TabPanel>

```

Edit 6 of 6 in `src/pages/SyncPage.tsx` — replace:

```tsx
          wfNames={wfNames}
          onAccountsChanged={reloadAccounts}
          telegramDraft={telegramDraft}
        />
      </TabPanel>

```

with:

```tsx
          wfNames={wfNames}
          onAccountsChanged={reloadAccounts}
          telegramDraft={telegramDraft}
          auditSnapshot={auditSnapshot}
        />
      </TabPanel>

```

Edit 1 of 6 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
import { AccountMapper } from '../components/AccountMapper';
import { RuleEditor } from '../components/RuleEditor';
import { AccountList, accountsSummary } from '../components/AccountList';
import { PoolCard } from '../components/PoolCard';
import { shortDate } from '../../shared/telegram';
import type { SemesterPoolConfig } from '../../shared/pool';
```

with:

```tsx
import { AccountMapper } from '../components/AccountMapper';
import { RuleEditor } from '../components/RuleEditor';
import { AccountList, accountsSummary } from '../components/AccountList';
import { AccountAudit, ChecksCard, checksSummary } from '../components/AuditViews';
import type { AuditSnapshotRead } from '../../shared/audit-snapshot';
import { PoolCard } from '../components/PoolCard';
import { shortDate } from '../../shared/telegram';
import type { SemesterPoolConfig } from '../../shared/pool';
```

Edit 2 of 6 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
  rules: 'rules',
  pool: 'pool',
  changeLog: 'change-log',
} as const;

interface Props {
```

with:

```tsx
  rules: 'rules',
  pool: 'pool',
  changeLog: 'change-log',
  checks: 'checks',
} as const;

interface Props {
```

Edit 3 of 6 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
   *  page re-reads both — otherwise a just-mapped account shows as its raw id
   *  with "account no longer exists". */
  onAccountsChanged?: () => void;
}

/**
```

with:

```tsx
   *  page re-reads both — otherwise a just-mapped account shows as its raw id
   *  with "account no longer exists". */
  onAccountsChanged?: () => void;
  /** 2c: the companion's audit snapshot, for the Checks card and the
   *  account chips. Absent (an older page): neither is shown. */
  auditSnapshot?: AuditSnapshotRead | null;
}

/**
```

Edit 4 of 6 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
 */
export function SettingsTab({
  ctx, store, scheduler, onReset, amazon, categories, isOpen, toggleCard,
  accountMapping, balances, sfinNames, wfNames, telegramDraft, onAccountsChanged,
}: Props) {
  // The stored pool, for the card's collapsed summary. Read here and updated by
  // the card itself on Set / Clear: the companion's published status would lag
```

with:

```tsx
 */
export function SettingsTab({
  ctx, store, scheduler, onReset, amazon, categories, isOpen, toggleCard,
  accountMapping, balances, sfinNames, wfNames, telegramDraft, onAccountsChanged, auditSnapshot,
}: Props) {
  // The stored pool, for the card's collapsed summary. Read here and updated by
  // the card itself on Set / Clear: the companion's published status would lag
```

Edit 5 of 6 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
          sfinNames={sfinNames}
          wfNames={wfNames}
          onOpenAccount={(id) => { ctx.api.navigation.navigate(`/accounts/${id}`).catch(() => {}); }}
        />}
        <div className="sfin-divider" />
        <div className="sfin-subtle" style={{ marginBottom: 12 }}>
```

with:

```tsx
          sfinNames={sfinNames}
          wfNames={wfNames}
          onOpenAccount={(id) => { ctx.api.navigation.navigate(`/accounts/${id}`).catch(() => {}); }}
          renderExplanation={auditSnapshot
            ? (wfId) => <AccountAudit read={auditSnapshot} wfAccountId={wfId} companionVersion={companionVersion} now={new Date()} />
            : undefined}
        />}
        <div className="sfin-divider" />
        <div className="sfin-subtle" style={{ marginBottom: 12 }}>
```

Edit 6 of 6 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
          </>
        )}
      </CollapsibleCard>

      <h3 className="sfin-settings-group">Budget</h3>
      <CollapsibleCard
```

with:

```tsx
          </>
        )}
      </CollapsibleCard>

      {/* 2c: what Wealthfolio's Health page flags, from the companion's
          snapshot. Beside Accounts: Home's Accounts tile opens it when there
          is something to look at. */}
      {auditSnapshot && (
        <CollapsibleCard
          id={CARD.checks}
          title="Checks"
          summary={checksSummary(auditSnapshot, companionVersion)}
          open={isOpen(CARD.checks)}
          onToggle={() => toggleCard(CARD.checks)}
        >
          <ChecksCard read={auditSnapshot} companionVersion={companionVersion} now={new Date()} />
        </CollapsibleCard>
      )}

      <h3 className="sfin-settings-group">Budget</h3>
      <CollapsibleCard
```

Edit 1 of 4 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
import type { SecretsStore } from '../utils/secrets';
import type { AppStoryTarget } from '../utils/tx-story';
import { PALETTES, paletteVars } from '../components/budget/palettes';
import type { LoadedSubscriptionPrefs, SubscriptionEdit } from '../../shared/subscription-prefs';

/**
```

with:

```tsx
import type { SecretsStore } from '../utils/secrets';
import type { AppStoryTarget } from '../utils/tx-story';
import { PALETTES, paletteVars } from '../components/budget/palettes';
import { HeadlineAuditLink, type AuditSource } from '../components/AuditViews';
import type { LoadedSubscriptionPrefs, SubscriptionEdit } from '../../shared/subscription-prefs';

/**
```

Edit 2 of 4 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
  onSetUpCompanion?: () => void;
  /** 1.61: a drill-down row's story, opened in place. */
  renderTxStory?: (target: AppStoryTarget) => React.ReactNode;
}

/** Two days: one missed nightly publish is routine, two is worth a strip. */
```

with:

```tsx
  onSetUpCompanion?: () => void;
  /** 1.61: a drill-down row's story, opened in place. */
  renderTxStory?: (target: AppStoryTarget) => React.ReactNode;
  /** 2c: "Why is this different from Wealthfolio?" under the toolbar, beside
   *  the headline numbers that lead the board — outside the grid, whose cards
   *  clip their bodies, so it opens in place uncut. Absent: no link. */
  audit?: AuditSource;
}

/** Two days: one missed nightly publish is routine, two is worth a strip. */
```

Edit 3 of 4 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
export function BudgetTab({
  cube, customReports, layout, onLayoutChange, onLayoutReset, onCustomReportsChange, store,
  subscriptionPrefs = null, onSubscriptionEdit, onOpenActivities, openRequest,
  onSetUpCompanion, renderTxStory,
}: BudgetTabProps) {
  const [fullId, setFullId] = useState<string | null>(null);
  // Acted on ONCE per request. Initialised to whatever request already exists
```

with:

```tsx
export function BudgetTab({
  cube, customReports, layout, onLayoutChange, onLayoutReset, onCustomReportsChange, store,
  subscriptionPrefs = null, onSubscriptionEdit, onOpenActivities, openRequest,
  onSetUpCompanion, renderTxStory, audit,
}: BudgetTabProps) {
  const [fullId, setFullId] = useState<string | null>(null);
  // Acted on ONCE per request. Initialised to whatever request already exists
```

Edit 4 of 4 in `src/tabs/BudgetTab.tsx` — replace:

```tsx
        </div>
      </div>

      {hiddenToast !== null && (
        <div className="sfin-toast" role="status">
          <span>Hidden {reportTitle(hiddenToast, customReports)}</span>
```

with:

```tsx
        </div>
      </div>

      {audit && <HeadlineAuditLink {...audit} />}

      {hiddenToast !== null && (
        <div className="sfin-toast" role="status">
          <span>Hidden {reportTitle(hiddenToast, customReports)}</span>
```

Edit 1 of 5 in `src/tabs/HomeTab.tsx` — replace:

```tsx
import { SetupChecklist } from '../components/SetupChecklist';
import { UncategorizedList, useDismissals } from '../components/UncategorizedList';
import { WhyCard } from '../components/WhyCard';
import { appTxSearch, type AppStoryTarget } from '../utils/tx-story';
import type { TxQuery } from '../../shared/tx-search';
import { money, accountsSummary } from '../components/AccountList';
```

with:

```tsx
import { SetupChecklist } from '../components/SetupChecklist';
import { UncategorizedList, useDismissals } from '../components/UncategorizedList';
import { WhyCard } from '../components/WhyCard';
import { healthIssueCount } from '../components/AuditViews';
import type { AuditSnapshotRead } from '../../shared/audit-snapshot';
import { appTxSearch, type AppStoryTarget } from '../utils/tx-story';
import type { TxQuery } from '../../shared/tx-search';
import { money, accountsSummary } from '../components/AccountList';
```

Edit 2 of 5 in `src/tabs/HomeTab.tsx` — replace:

```tsx
  /** 1.61: a transaction's story (TxStoryPanel). Present: "Why is this here?"
   *  heads the page and needs-a-category rows open their stories. */
  renderTxStory?: (target: AppStoryTarget) => React.ReactNode;
}

/**
```

with:

```tsx
  /** 1.61: a transaction's story (TxStoryPanel). Present: "Why is this here?"
   *  heads the page and needs-a-category rows open their stories. */
  renderTxStory?: (target: AppStoryTarget) => React.ReactNode;
  /** 2c: the companion's audit snapshot. With something Health flags, the
   *  Accounts tile says so and opens Settings on the Checks card. */
  auditSnapshot?: AuditSnapshotRead | null;
}

/**
```

Edit 3 of 5 in `src/tabs/HomeTab.tsx` — replace:

```tsx
  prunedDuplicates, unmappedAccounts, onIgnoreAccounts, uncategorized, dismissals, onDismissalsChange,
  isOpen, toggleCard, onBalancesChanged, onClearError, onError,
  companionVersion, telegramConfigured, amazonConfigured, checklistDismissed,
  onDismissChecklist, onNavigate, poolStatus, onOpenPool, renderTxStory,
}: Props) {
  const [fixingBaseline, setFixingBaseline] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const { justDismissed, dismiss, undo } = useDismissals(dismissals, onDismissalsChange);
```

with:

```tsx
  prunedDuplicates, unmappedAccounts, onIgnoreAccounts, uncategorized, dismissals, onDismissalsChange,
  isOpen, toggleCard, onBalancesChanged, onClearError, onError,
  companionVersion, telegramConfigured, amazonConfigured, checklistDismissed,
  onDismissChecklist, onNavigate, poolStatus, onOpenPool, renderTxStory, auditSnapshot,
}: Props) {
  const checksToLook = healthIssueCount(auditSnapshot);
  const [fixingBaseline, setFixingBaseline] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const { justDismissed, dismiss, undo } = useDismissals(dismissals, onDismissalsChange);
```

Edit 4 of 5 in `src/tabs/HomeTab.tsx` — replace:

```tsx
        <button
          type="button"
          className="sfin-tile sfin-tile--toggle"
          aria-label={`Accounts: ${accountsSummary(mapping, balances)}`}
          onClick={() => onNavigate('settings', SETTINGS_CARD.accounts)}
        >
          <SectionLabel>Accounts</SectionLabel>
          <div className="sfin-tile-val">{mappedCount}</div>
```

with:

```tsx
        <button
          type="button"
          className="sfin-tile sfin-tile--toggle"
          aria-label={`Accounts: ${accountsSummary(mapping, balances)}${checksToLook > 0 ? ` · Checks: ${checksToLook} to look at` : ''}`}
          onClick={() => onNavigate('settings', checksToLook > 0 ? SETTINGS_CARD.checks : SETTINGS_CARD.accounts)}
        >
          <SectionLabel>Accounts</SectionLabel>
          <div className="sfin-tile-val">{mappedCount}</div>
```

Edit 5 of 5 in `src/tabs/HomeTab.tsx` — replace:

```tsx
                ? 'all match the bank'
                : 'not all checked yet'}
          </div>
        </button>
        {/* Doubles as the disclosure trigger once there is a list to show — one
            surface for the number instead of the tile plus a separate bar
```

with:

```tsx
                ? 'all match the bank'
                : 'not all checked yet'}
          </div>
          {checksToLook > 0 && <div className="sfin-tile-sub">Checks: {checksToLook} to look at</div>}
        </button>
        {/* Doubles as the disclosure trigger once there is a list to show — one
            surface for the number instead of the tile plus a separate bar
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/pages/audit-app.test.tsx src/pages/SyncPage.test.tsx src/pages/copy-policy.test.tsx src/tabs/SettingsTab.test.tsx src/tabs/BudgetTab.test.tsx src/tabs/HomeTab.test.tsx`
Expected: PASS — 175 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/pages/SyncPage.tsx src/pages/audit-app.test.tsx src/tabs/SettingsTab.tsx src/tabs/BudgetTab.tsx src/tabs/HomeTab.tsx
git commit -m "App: Settings → Checks, why under each off account, the Budget tab's link, and Home's tile pointing at the checks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Docs, the forced-date run, every gate

The CHANGELOG under `[Unreleased]` (no version bump), the README's `/audit` and the app's Checks, and `docs/superpowers/follow-ups.md` §11 — what R1 deliberately leaves open (spec D3; X10). Then every new test file once more with the system date forced to 2027-01-01 through a throwaway config (X7, X9), and all four gates under `nice`.

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `docs/superpowers/follow-ups.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the docs**

Edit 1 of 1 in `CHANGELOG.md` — replace:

```markdown
- Budget drill-down rows carry their transaction and who filed it, so they
  open a story once the companion is updated; rows from an older companion
  stay as they were.

## [1.60.0] - 2026-10-13

```

with:

```markdown
- Budget drill-down rows carry their transaction and who filed it, so they
  open a story once the companion is updated; rows from an older companion
  stay as they were.
- **Audits without SSH — explain.** The checks that used to need the server's
  `companion/tools` scripts, read-only, in Telegram and the app:
  - **Why a balance is off.** The bank's figure against Wealthfolio's (a
    card's is its whole ledger, pending included), and what makes up the
    gap: pending transactions the bank hasn't posted, transactions newer than
    the bank's figure, a transfer held waiting for its other half, a card
    payment (or transfer) still unlinked, a transfer out Wealthfolio never
    took out of the balance — and whatever none of those explains. Plus the
    starting balance and corrections the balance includes.
  - **Why the month's spending differs from Wealthfolio's.** The report's
    "Spent this month" against Wealthfolio's Spending page, split into the
    six known reasons (rows at midnight UTC on the 1st, rows after today, the
    add-on's own bookkeeping rows, excluded categories, rows filed twice,
    refunds with no category), each with its rows, and the rest.
  - **What Wealthfolio's Health page flags** of the things the add-on checks:
    incomplete transfer legs (with the likely other half when exactly one row
    fits, both ways), starting balances dated after an account's first
    transaction, and older rows on a `$CASH` asset — each with what to do.
  - In Telegram, `/audit` runs them live on every tap; `/status` puts a 🔎
    under each account that is off. In the app, an account's "off by" chip
    opens why in place, the Budget tab has "Why is this different from
    Wealthfolio?", and **Settings → Checks** lists Health's issues — from a
    snapshot the companion publishes after each sync, which says when it was
    taken and when it is out of date or unreadable. Home's Accounts tile
    points at the checks when there is something to look at.

## [1.60.0] - 2026-10-13

```

Edit 1 of 1 in `README.md` — replace:

```markdown
  or Redo where an entry offers one, and `/changes venmo` searches it.
  `/why kroger 54.20` finds a transaction and tells its story; the 🔎 Why?
  buttons on large-transaction alerts, import notices and the `/categorize`
  screen do the same.
- **Change log** — every change the sync, the companion and you made, the last
  90 days, under **Settings → Change log**: imports, bank updates, transfer
  links, removed duplicates, starting balances, corrections, filings and rules,
```

with:

```markdown
  or Redo where an entry offers one, and `/changes venmo` searches it.
  `/why kroger 54.20` finds a transaction and tells its story; the 🔎 Why?
  buttons on large-transaction alerts, import notices and the `/categorize`
  screen do the same. `/audit` explains why a balance is off from the bank,
  why the month's spending differs from Wealthfolio's, and what Wealthfolio's
  Health page flags — checked live on every tap; `/status` puts a 🔎 under
  each account that is off.
- **Checks** (with the companion) — the same three explanations in the app:
  an account's "off by" chip in **Settings → Accounts** opens why in place,
  the Budget tab's "Why is this different from Wealthfolio?" breaks down the
  month, and **Settings → Checks** lists what Health flags, each with what to
  do. They come from a snapshot the companion publishes after each sync, and
  say when it was taken.
- **Change log** — every change the sync, the companion and you made, the last
  90 days, under **Settings → Change log**: imports, bank updates, transfer
  links, removed duplicates, starting balances, corrections, filings and rules,
```

Edit 1 of 1 in `docs/superpowers/follow-ups.md` — replace:

```markdown
- **`/why` is under /help's More commands**, not the seven-command ☰ menu
  (Telegram's registered list), which stays at seven.

## Reference: name mismatches between the database, the REST API, and the SDK

Every one of these cost a diagnostic cycle against the live instance on
```

with:

```markdown
- **`/why` is under /help's More commands**, not the seven-command ☰ menu
  (Telegram's registered list), which stays at seven.

## 11. Audits without SSH — R1 Explain (2026-10-13, plan `2026-10-13-audits-r1-explain.md`)

- **"$X left" compares SPENT figures.** `audit-headline.mjs` compares no two
  numbers: it sizes six differences in what each side counts and leaves a
  person to match them by eye. Both sides' "left" is plan − spent, so the
  check compares the report's "Spent this month" (the cube's current month)
  with Wealthfolio's Spending page `headline.spent` (`POST /spending/insight`
  for the calendar month in Wealthfolio's timezone). The copy says so; R2 or
  later could add the budgets' side if a gap ever comes from plans.
- **The other half of a transfer is matched one leg at a time.** A balance's
  "held" or "still unlinked" cause needs ONE unlinked leg elsewhere whose
  amount equals what is left of exactly one account's gap, as the daily
  missing-leg check matches. Two legs into one account, or two accounts off
  by the same amount, stay in "not explained".
- **Split lines are not modelled.** Wealthfolio allocates a split row by its
  lines; the add-on never writes splits, so a split row's difference stays in
  "not explained by these reasons".
- **Health is the add-on's three checks, not Wealthfolio's whole page.**
  Wealthfolio 3.10 also flags rejected, oversold and amountless activities and
  a stale projection; the empty state says "Nothing the add-on checks for".
- **The app's checks are as fresh as the last sync.** Telegram's `/audit`
  re-reads on every tap; the app shows the snapshot with when it was taken,
  "These checks are from … — the companion hasn't synced since." after two
  days, and lists at most what fits 100 KB (each list says how many it left
  out).
- **R2 (Fix) is next:** Link on a Health leg with a unique other half (the
  snapshot already carries both rows' ids, accounts, tx keys, amounts and
  dates), and "Remove for good…" on a transaction's story.

## Reference: name mismatches between the database, the REST API, and the SDK

Every one of these cost a diagnostic cycle against the live instance on
```

- [ ] **Step 2: Run every new test file with the date forced to 2027-01-01**

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
npx vitest run --config zz-2027.config.mts shared/audit-balance.test.ts shared/audit-headline.test.ts shared/audit-health.test.ts shared/audit-snapshot.test.ts src/utils/secrets-audit.test.ts src/components/AuditViews.test.tsx src/pages/audit-app.test.tsx
(cd companion && npx vitest run --config zz-2027.config.mts src/audit-facts.test.ts src/audit-menu.test.ts src/sqlite-audit.test.ts src/wealthfolio-insight.test.ts)
(cd companion && npx vitest run --config zz-2027.config.mts src/index.test.ts -t audit)
rm zz-2027.setup.ts zz-2027.config.mts companion/zz-2027.setup.ts companion/zz-2027.config.mts
git status --short
```

Expected: PASS — 83 tests (root), 39 tests (companion), and 8 passed with 282 skipped (`index.test.ts`'s audit tests); `git status --short` prints nothing. (`index.test.ts` as a whole is not run here: seven of its older dismissal tests compute a timestamp from the real clock at import and fail under a forced date on the base branch too.)

- [ ] **Step 3: Run every gate**

Run: `nice npm test`
Expected: PASS — 2474 tests.

Run: `nice npm --prefix companion test`
Expected: PASS — 1081 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md docs/superpowers/follow-ups.md
git commit -m "Audits R1: docs — the CHANGELOG, the README's /audit and Checks, follow-ups §11

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
