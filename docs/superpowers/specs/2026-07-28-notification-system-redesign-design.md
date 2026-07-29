# Notification system redesign

Date: 2026-07-28

## Problem

The companion's Telegram integration currently sends exactly one automated
message (`DAILY_REPORT_SCHEDULE`, default 8am daily), built from
`formatNativeBudgetBreakdown()`. The UI presents "daily" and "weekly" as two
separate, independently-toggleable report types, but only one ever actually
fires — `weeklyReportEnabled` is stored and never read. The two purpose-built
formatters that *do* implement daily/weekly content (`formatDailyReport`,
`formatWeeklyReport`) are wired only to manual "send sample" buttons in the
browser UI, never to any schedule. Separately, `getNativeWealthfolioBudgets()`
picks a category's budget row by "most recently edited" instead of
"month-specific first, default as fallback," which can silently swap in the
wrong number.

On top of the reporting gap, an in-transit internal transfer (one leg posted,
the other not yet) currently displays as spending in Wealthfolio's own
Spending Tracker for as long as it's unlinked — because SimpleFin transaction
descriptions can be typed `TRANSFER_OUT`/`TRANSFER_IN` by keyword match
(`BANK_TRANSFER_KEYWORDS`) before a matching pair is ever found, and
Wealthfolio only excludes a transfer from spending once it's actually linked,
not merely typed. There's also no persistent visibility if the two legs *do*
both exist but the link keeps failing (a real, previously-observed failure
mode — see `companion/upstream-pr.md` issue #5).

## Goals

1. Two real, independently-scheduled Telegram reports: a daily per-category
   "how much left to spend this week" digest, and a weekly (Saturday) total
   remaining-across-all-budgets summary — both sourced from Wealthfolio's own
   native category/budget tables, not a second keyword-guessing system.
2. Fix the budget-row selection bug.
3. In-transit transfers show as a distinct, spending-neutral state instead of
   inflating the Spending Tracker, and self-promote to a real linked transfer
   once the second leg posts.
4. A one-time alert when a transfer genuinely fails to link (both legs exist,
   linking keeps failing) — distinct from the ordinary "still in transit"
   case.
5. Visibility when sync itself starts failing, instead of silent staleness.
6. Remove the now-fully-superseded keyword-based category system.

## Non-goals

- Multi-channel notifications (Slack, email, etc.) — Telegram only, per
  explicit confirmation this is a single-user private chat.
- Retroactively fixing transfer pairs stuck from *before* this change (the
  existing "Reconcile & link" button and legacy-leg repair in `sync-core.ts`
  already handle that path; this spec only changes how *new* solo legs are
  imported going forward).

## Architecture overview

All new logic lives in `shared/` so both the addon and the companion syncer
pick it up identically (both call `runSyncCore`). The companion's `index.ts`
gains a second cron and reads/writes a couple of new fields on the existing
`telegram_config` / new addon-secret keys — no new services, no new
containers.

```
runSyncCore (shared/sync-core.ts)
  ├─ Phase A (tx typing)          → in-transit placeholder classification
  ├─ Transfer linking              → stuck-pair failure tracking
  └─ (unchanged) everything else

companion/index.ts
  ├─ SYNC_SCHEDULE       (unchanged) → runCompanionSync()
  ├─ DAILY_REPORT_SCHEDULE            → new "weekly remaining per category" digest
  └─ WEEKLY_REPORT_SCHEDULE (new)     → new "total remaining this month" summary
```

## Components

### 1. Budget-query fix (`companion/src/sqlite-native.ts`)

`getNativeWealthfolioBudgets()`'s `ranked_budgets` CTE currently orders each
category's candidate rows by `updated_at DESC` alone. Change the ordering to
prefer the month-specific row first, `updated_at` only as a tiebreaker:

```sql
ORDER BY (period_key = '${yearMonth}') DESC, updated_at DESC
```

`getNativeWealthfolioSpending()` also gets an explicit upper bound on the
date filter (`activity_date < '<next-month>-01'`) so a future-dated or
mis-dated row can never bleed into the wrong month's total. The function
computes the next-month boundary from `yearMonth` in TypeScript before
building the query string (no new parameters).

### 2. Report formatters (`shared/telegram.ts`)

Two new formatters replace `formatDailyReport`, `formatWeeklyReport`, and
`formatNativeBudgetBreakdown` (all three retired — see Removal section):

- `formatWeeklyRemainingDigest(categories: Array<{ name: string; spent: number; budget: number }>, weeksLeftInMonth: number): string`
  For each category: `remaining = budget - spent`. If `remaining < 0` and
  `budget > 0`, show the 🚨 over-budget alert line (existing style, amount
  over). Otherwise show `remaining / weeksLeftInMonth` as "$X left this
  week." No per-category mode — every category uses the same weekly-remaining
  math (the old per-category `daily`/`weekly`/`monthly` mode concept goes
  away with `CategoryRule`).

  > **CORRECTED after whole-branch review (finding W5).** The spec above was
  > wrong on both the formula and the label, and shipped as specified before
  > being fixed. `remaining / ceil(daysLeft / 7)` jumps discontinuously (in a
  > 31-day month it doubled overnight between the 23rd and the 24th) and is
  > understated early in the month; and the result is not "left this week" —
  > it is month-to-date remaining spread over a week, so spending $100 today
  > moved the displayed figure by only ~$20. The shipped signature is
  > `(categories, daysLeftInMonth)` — days AFTER today — and each line leads
  > with the true monthly remaining, with a day-proportional `weeklyPace()`
  > (`min(remaining, remaining * 7 / (daysLeftInMonth + 1))`) shown as a
  > hedged secondary figure. Three branches, not two: over budget, spending
  > with no budget set (you cannot be over a budget never created), and under
  > budget. The escaped category name sits OUTSIDE every Markdown entity —
  > legacy Markdown does not honour a backslash escape inside one.
- `formatMonthlyRemainingSummary(totalSpent: number, totalBudget: number): string`
  One line: total remaining this month across the included categories (🚨
  style if negative).

  > **CORRECTED after whole-branch review (finding W3).** Needs an explicit
  > `totalBudget <= 0` branch: this report is a single number, so the
  > `$0.00 remaining ... of $0.00, 0%` it otherwise emitted read as a real
  > result. Reachable by deselecting every weekly category, or before any
  > budget exists.

Both keep using `getCategoryEmoji`/`DEFAULT_CATEGORY_EMOJIS` and the existing
`money()` helper.

### 3. Two companion schedules (`companion/src/index.ts`)

- `DAILY_REPORT_SCHEDULE` (existing env var, default `0 8 * * *`) now builds
  its message from `formatWeeklyRemainingDigest`, filtered to
  `telegram_config.dailyReportCategories` (see below).
- New `WEEKLY_REPORT_SCHEDULE` env var, default `0 9 * * 6` (Saturday 9am),
  drives a new `sendWeeklyTelegramReport()` using
  `formatMonthlyRemainingSummary`, filtered to
  `telegram_config.weeklyReportCategories`.

Both read spend/budget from the same native DB call already used today
(`getNativeWealthfolioSpending` / `getNativeWealthfolioBudgets`), gated by
their respective `dailyReportEnabled` / `weeklyReportEnabled` flags (the
latter starts actually being read for the first time).

### 4. Per-report category selection

New fields on `TelegramConfig` (`shared/types.ts`):

```ts
dailyReportCategories?: string[] | 'all';   // default 'all'
weeklyReportCategories?: string[] | 'all';  // default 'all'
```

The addon's browser UI has no host-API access to Wealthfolio's real category
list (confirmed: no `categories`/`taxonomy` API is exposed to addons at all —
only the companion can see it, via direct SQLite access). So the category
checklist is populated from data the *companion* publishes, not something the
addon can query live:

- After each report send (daily or weekly — both already read the native DB),
  the companion writes the category names it saw to a new addon secret,
  `available_report_categories` (a simple JSON string array), via
  `setAddonSecret` — the same pattern already used for `linked_groups` /
  `account_balances`.
- `SyncPage.tsx` replaces the "Keywords" editor section with a "Report
  Categories" panel: two checklists (daily / weekly), reading
  `available_report_categories`. Before the companion's first run, the panel
  shows a "categories will appear here after the companion's first sync"
  placeholder and defaults both lists to `'all'`.

### 5. In-transit transfers (`shared/sync-core.ts`, Phase A)

Today, a transaction whose description matches `BANK_TRANSFER_KEYWORDS` gets
typed `TRANSFER_OUT`/`TRANSFER_IN` by `mapTransactionWithSource` regardless of
whether a matching leg exists yet; `detectTransferPairs` only *upgrades* a
type when it finds a cross-account match, it never downgrades one.

New rule: after `detectTransferPairs` runs, any prepared transaction whose
type is `TRANSFER_OUT`/`TRANSFER_IN` (from either the keyword match or the
detector) but whose `txId` is **not** in `detection.pairs` this run is
imported as a placeholder instead of the raw transfer type:

- Uses the existing `neutralAdjustmentFields`-style shape — a CREDIT with no
  subtype (spending-neutral, moves cash by `amount`/`fee` exactly like a
  transfer would since it's asset-free either way).
- Comment is tagged distinctly: `↔️ In-transit transfer · <description> · <txId>`
  (still ends in `· <txId>`, so `fetchExistingRows`/`txIdFromComment` keep
  matching it by identity across runs — this is a normal reconciled row, not
  a new activity type).
- On a later sync, once the matching leg posts and `detectTransferPairs`
  finds it, `planReconciliation` sees the same `txId` with a new resolved
  type (`TRANSFER_OUT`/`TRANSFER_IN`) and emits an **update** — the existing
  row flips from placeholder to real transfer in place, and (being now in
  `detection.pairs`) flows into the existing linking step in the same run.

**Timeout — the "never going to pair" case.** If a solo transfer-typed
transaction is still unpaired after `IN_TRANSIT_TIMEOUT_MS` (10 days — wider
than the 5-day `TRANSFER_MATCH_WINDOW_SECONDS`, so it never fires while a
normal pairing is still plausible), stop treating it as a transfer candidate:
import/update it as its plain `DEPOSIT`/`WITHDRAWAL` type instead (what
`mapTransactionWithSource` would have produced without the keyword match).
This covers a transfer-shaped description whose other leg is genuinely
external and untracked — it should count as normal spending, not sit
excluded forever.

### 6. Stuck-transfer alert

Distinct from the timeout above: this fires when **both** legs exist and are
correctly detected as a pair (`detection.pairs` contains them, both rows are
in `linkRowByTxId`), but `host.linkPair()` keeps reporting `linked: false` —
the actual failure mode chased at length in `progress.md` (poisoned/rejected
group ids).

New persisted state, following the existing `linked_groups`-style JSON-blob
pattern:

```ts
// SyncStore
getTransferLinkFailures(): Promise<Record<string, { count: number; firstFailedAt: string; alerted: boolean }>>;
setTransferLinkFailures(map: ...): Promise<void>;
```

keyed by `outTxId`. On each `linkPair` call: success → delete the entry;
failure → increment `count` (create with `count: 1, firstFailedAt: now,
alerted: false` if new). When `count >= 3` (three consecutive sync cycles —
roughly 18h at the default 6h `SYNC_SCHEDULE`) and `alerted === false`, send
one Telegram message identifying the pair (amount, accounts, dates) and set
`alerted: true`. Linking keeps being retried every run regardless (unchanged
behavior); a later success silently clears the entry, no "resolved" message.

Implemented in `shared/sync-core.ts` (host-agnostic) and both `SyncStore`
adapters — the companion's `RestSyncStore` (new addon-secret key
`transfer_link_failures`) and the addon's own store implementation, mirroring
however it currently implements `getLinkedGroups`/`setLinkedGroups`.

### 7. Sync health visibility

- The daily digest gets a footer line appended: `✅ synced <N>h ago` on
  success, or `⚠️ failing since <firstFailedAt> — <last error message>` when
  the most recent `runCompanionSync()` call errored. Tracked via a small
  `sync_health` addon secret (`{ lastSuccessAt, firstFailedAt, lastError,
  alerted }`), updated at the end of every `runCompanionSync()` call: success
  clears `firstFailedAt`/`lastError`/`alerted` and updates `lastSuccessAt`; a
  thrown error sets `firstFailedAt` (only if not already set — first failure
  in the current streak) and updates `lastError`.
- If `Date.now() - firstFailedAt > 24h` and `alerted === false`, send an
  immediate one-off Telegram message rather than waiting for the next daily
  digest, and set `alerted: true` (so it fires once per failure streak, not
  every sync). A later success clears the streak entirely, re-arming the
  alert for next time. Using elapsed wall-clock time (not a sync-count
  threshold) keeps this correct regardless of what `SYNC_SCHEDULE` is set to.

### 8. Removal — the keyword-based category system

Deleted: `categorizeActivity`, `DEFAULT_SPENDING_KEYWORDS`, the `CategoryRule`
type and its `TelegramConfig.categoryRules` field, `formatDailyReport`,
`formatWeeklyReport`, `formatNativeBudgetBreakdown`, `DailyReportData`,
`WeeklyReportData`, `CategoryReportItem`, and the "Keywords" editor section
+ `DEFAULT_CATEGORY_RULES` in `SyncPage.tsx` (replaced by the Report
Categories checklists from Component 4). `getCategoryEmoji` /
`DEFAULT_CATEGORY_EMOJIS` are kept — still used by the two new formatters.

### 9. Test harness fix

`companion/package.json` doesn't declare `vitest` itself and is currently
resolving an old `vitest@1.6.1` that can't load the `node:sqlite` import
(root's `4.1.10` handles it fine) — `sqlite-native.test.ts` and
`index.test.ts` silently fail to even load. Pin `vitest` as an explicit
companion devDependency matching the root version before adding tests for
any of the above.

### Minor / optional

- Bump `companion/package.json` version to match root (`1.0.1`).
- Add a `HEALTHCHECK` to `companion/Dockerfile` (low priority given Component
  7 already surfaces failures via Telegram; nice-to-have for `docker ps`
  visibility).

## Data flow summary

```
SimpleFin tx ──▶ mapTransactionWithSource ──▶ detectTransferPairs
                                                    │
                        paired this run? ──yes──▶ real TRANSFER_OUT/IN (existing linking flow)
                              │no
                              ▼
                    in-transit placeholder (CREDIT, spending-neutral)
                              │
                    still solo after 10 days?
                              │yes
                              ▼
                    plain DEPOSIT/WITHDRAWAL (counts as normal spending)

host.linkPair() fails 3x on a detected pair ──▶ transfer_link_failures[outTxId] ──▶ one-time alert

runCompanionSync() ──▶ sync_health ──▶ daily-digest footer, or immediate alert past 24h of failures

getNativeWealthfolioSpending/Budgets ──▶ formatWeeklyRemainingDigest (daily cron)
                                     └──▶ formatMonthlyRemainingSummary (weekly cron)
```

## Error handling

- All new Telegram sends reuse the existing `sendTelegramMessage` fire-and-log
  pattern (a failed send is logged, never throws into the cron handler).
- Placeholder/timeout reclassification and failure-count bookkeeping happen
  inside the existing per-account `try/catch` in `runSyncCore`'s main loop, so
  a bug in this logic for one account can't abort the whole sync (matches
  existing isolation).
- Reading `available_report_categories` / `sync_health` on the addon side
  treats a missing/unparseable secret as "no data yet," never a crash (same
  `getJson` pattern already used throughout `RestSyncStore`).

## Testing

- `sqlite-native.test.ts`: cases for the budget fix — a category with only a
  month-specific row, only a default row, both (month-specific must win
  regardless of `updated_at`), and the spending query's month upper bound.
- `sync-core.test.ts`: solo transfer-typed tx imports as placeholder; a
  second-run match promotes it to a real linked pair; a solo tx past the
  10-day timeout imports as plain DEPOSIT/WITHDRAWAL; a pair failing to link
  3x sets `alerted: true` and stops re-alerting; a pair that later succeeds
  clears its failure entry.
- `telegram.test.ts`: new formatters — normal/over-budget category lines,
  weeks-left-in-month math, empty-category-list edge case.
- `index.test.ts` (companion): the new `WEEKLY_REPORT_SCHEDULE` cron
  registration, `sync_health` update on success/failure.
- Companion test harness fix verified by `sqlite-native.test.ts` and
  `index.test.ts` actually executing (currently 0 tests collected from
  either file).
