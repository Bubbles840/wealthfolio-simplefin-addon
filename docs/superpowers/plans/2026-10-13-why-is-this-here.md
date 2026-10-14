# "Why is this here?" (2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tap or click any transaction — `/why` and the 🔎 Why? buttons in Telegram, Home's search, needs-a-category rows and budget drill-down rows in the app — and read its story: where it came from, what it is, who filed it, what you told the sync, and every change-log entry about it, each leading to the change log's existing Undo. Read-only.

**Architecture:** Two pure shared modules hold the logic both hosts use: `shared/tx-search.ts` (a query read as words and/or an amount, matching, paging) and `shared/tx-story.ts` (`TxStoryFacts` → `TxStory`, honest "who filed it" inference, the report cube's filer codes); `shared/change-view.ts` gains `changesForTransaction`. Each host gathers what IT can see: the companion (`companion/src/tx-story-host.ts`) reads the row and the rules over REST and the category, its `source`, the other half of a link and all-history search from the read-only database (new STRICT readers that throw instead of answering `[]`); the add-on (`src/utils/tx-story.ts`) reads the row by id and searches through `ctx.api.activities.search`, takes the partner from the change log's link entry or its own `linked_groups`, and the filer from a drill row, the cube or the needs-a-category list. Telegram's `/why` (`companion/src/why-menu.ts`) is a stateless `cz:wy:` menu routed beside `cz:cl:`; a history line opens `/changes`' entry view, whose Back now returns to the story. The 🔎 Why? buttons are a session `MenuAction` on the `/categorize` screen, `cz:wy:t<id>` on the large-transaction alert and `cz:wy:r<handle>` on the import notice. The cube's drill rows gain `i` (activity id) and `f` (who filed it). In the app, `TxStory` renders a story whose history lines open the Change log card's own `EntryDetail` (exported, not copied); `WhyCard` heads Home.

**Tech Stack:** TypeScript, React (add-on), vitest (root project: jsdom, `src/` + `shared/`; companion project: node, `companion/src/`), Telegram Bot API (legacy `Markdown`), Wealthfolio REST and read-only SQLite (companion), add-on SDK 3.6.2 on Wealthfolio 3.8 (add-on).

**Spec:** `docs/superpowers/specs/2026-10-13-why-is-this-here-design.md` (approved section by section 2026-10-13; commit 8463ee4 on `feat/why-is-this-here`, off main at v1.60.0). Rulings W1–W11 are folded into the tasks below.

**Verified facts this plan builds on (W1):**
- **(a) Wealthfolio's keyword search matches the note — as ONE substring, never the account name.** The SDK's `activities.search(page, pageSize, filters, searchKeyword, sort)` reaches the shared activities adapter, which trims the keyword into `assetIdKeyword` (`apps/frontend/src/adapters/shared/activities.ts:89-90`, `~/Personal Projects/wealthfolio-upstream` at tag v3.8.0); the repository turns it into `LIKE '%<keyword>%'` over asset id, asset name, display code, subtype and `activities.notes` (`crates/storage-sqlite/src/activities/repository.rs:448-456`), date-descending by default (`activities.ts:91-93`). So the app passes ONE word — the longest word no account name contains (`txSearchKeyword`) — and applies `matchesTxQuery` itself; with no such word (an amount alone, or words that may be an account's name) it reads the last 12 months, newest first, and filters. The page size is 500, the size the add-on's own sync reads with.
- **(b) The cube grows ~60 bytes a drill row; nothing needs lowering.** A 24-month cube with 16 categories at the 30-row drill cap and six accounts measured 99,851 bytes; `i` and realistic `f` codes added 60.2 bytes a row (128,747 bytes, 64% of `REPORT_CUBE_MAX_BYTES = 200_000`). The worst case, the longest codes on every row with long category names, is 148,875 bytes (74%) — pinned in Task 3's test at ≤ 80%. `DRILL_ROWS_PER_CATEGORY` stays 30. `f` codes are defined once (`encodeFiler`/`decodeFiler`, shared/tx-story.ts): `r:<pattern>`, `r` (no current rule matches), `r?` (rules unreadable), `y`, `a:<label>`, `o` (the opening-balance filing), `h`.
- **(c) Wealthfolio applies the highest-priority matching rule, the first-listed on a tie, and lists rules in that order.** `CategorizationRulesRepository::list` orders by `priority DESC, created_at ASC, id ASC` (`crates/storage-sqlite/src/spending/categorization_rules.rs:276-283`, v3.8.0); `match_compiled` keeps the first match and replaces it only on a strictly higher priority (`crates/spending/src/categorization_rules/matcher.rs:67-125`, `rule.priority > current.priority` at :125), after account scope, activity type and the amount condition; `GET /spending/rules` returns that list as is (`apps/server/src/api/spending.rs:288-291`). `inferFilingRule` transcribes the matcher (contains / starts_with / exact case-insensitively, regex as written) and ranks by priority with a stable sort over the server's order. `listCategorizationRules` keeps the fields it needs, in order.
- **(d) Neither message knew what its button needs; both are threaded through as optional fields.** The import notice: `runCompanionSync` mints the sync's run with `companionChangeSink(wfClient)` (`companion/src/index.ts:962`) and stamps every entry of the run with it, but `sendImportNotice` (`:1346`, called at `:1136`) never received it — Task 6 adds an optional `run` argument. The alert: the create echo's activity id is in hand where the alert is pushed (`shared/sync-core.ts:3186-3242`) but `SyncResult.largeTransactionAlerts` had no field for it — Task 6 adds an optional `activityId`. The outbox (`LARGE_TX_OUTBOX_SECRET_KEY = 'pending_large_tx_alerts'`) stores alert objects verbatim on both hosts, so a queued alert keeps its id and an older record without one still sends, without the button.
- **Also verified.** Wealthfolio 3.8 has an exact-id activity filter: the adapter passes `filters.activityIds` as `activityIdFilter` (`activities.ts:88,110`) and the REST route accepts `activityIdFilter` (`apps/server/src/api/activities.rs:58`) — the row is read by id on both hosts (the SDK's filter type omits it; the call casts, and checks the id it gets back). The REST row (`ActivityDetails`, camelCase) carries `accountName` and `sourceGroupId`. `/changes`' view encoding can carry a foreign back target within 64 bytes: `cz:cl:d<8 hex>:w<36-char id>` is 53 bytes and its Undo buttons `cz:cl:xu<8 hex>:w<id>` 54 (`companion/src/changes-menu.ts` `encodeView`/`decodeView`, lines 69-105), so **Back from a history line returns to the story**, in place. A bank update keeps the pending row's old key as `BankUpdateFacts.previousTxKey`, stored as `before.txKey`. The class names `.sfin-why` and `.sfin-why-body` already belong to the `Why` disclosure (`src/components/ui.tsx:328-335`), so the search card is `.sfin-why-card`. The ☰ menu is what `setMyCommands` registers — `TELEGRAM_COMMAND_MENU`, seven commands since 1.57 (`companion/src/telegram-listener.ts:658-666`); `/help`'s "More commands" is `TELEGRAM_MORE_COMMANDS`.

**Deviations from the spec (decided, do not "fix"):**
- **The app's keyword is one word, not "the query's words"** — (a): Wealthfolio's keyword is a single substring and never sees the account name.
- **`/why` joins `/help`'s More commands and the README, not Telegram's registered ☰ menu**, which stays at the seven commands 1.57 chose; every other occasional command (`/changes`, `/newrule`, …) lives there too.
- **Only the companion's messages carry 🔎 Why?.** The add-on's sync sends the same large-transaction alert and import notice text-only, as its notice already is (`src/utils/sync.ts`: "No inline keyboard"): no listener is guaranteed to answer. An alert it queues keeps its id, so the companion's retry carries the button.
- **Copy the spec did not spell out, or worded with the category:** "Filed under X — set by hand in Wealthfolio." (the spec's "Set by hand in Wealthfolio." never said what it is filed under); "Filed under X by the add-on — an opening balance isn't spending." (the companion's card opening-balance filing, which the spec's list omits); "Filed under X by a rule." (rules unreadable); "Filed under X." (who filed it cannot be told); the skip list in the overrides line ("don't import it"); one note per failed read; the amount-only "Nothing matches" line; the app's own "gone" and no-match lines; "Searched the last 12 months — the companion couldn't read the database."; Telegram shows the newest 20 history lines.
- **The story view carries its own Back**: `t<id>` (a 🔎 Why? button — a new message, no Back), `t<id>:c` (back from `/changes`, in place, no Back), `t<id>:s<page>:<query>`, `t<id>:r<handle>:<page>`; a sync's imports are `r<handle>` (the notice — a new message) and `r<handle>:<page>`. So a query is cut to **17 bytes** (`WHY_QUERY_MAX_BYTES`), not `/changes`' 30: the story's Back must fit 64 with a 36-character id. A cut drops words from the end, never the amount.
- **A row's category is its spending assignment, else its first other one** — what `sendImportNotice` already shows — so a paycheck filed under an income category is not "not filed yet".
- **The app names the other half of a transfer without its date** (the log's link entry carries one date for both legs) and leaves "what it is" out for a grouped or transfer-typed row whose partner it cannot see.
- **`TxStory.history` is null when the change log was not read**, so "No changes in the last 90 days." is said only when the log WAS read.

**Task order:** the pure search and history matching (1) and the story (2); the cube's `i`/`f` and the rule list they need (3); the companion's facts and search (4); `/why` (5); the three 🔎 Why? buttons (6); the add-on's facts and search (7); the story and the search card in the app (8); the app's three ways in (9); docs and every gate (10).

## Global Constraints

- **Read-only.** Nothing a story, a search or a 🔎 Why? does writes anything. Every change goes through the change log's existing Undo (`runChangeUndo` / `undoFromApp`) or `/categorize`.
- **Raw text in shared code.** Bank and user text in `TxStory` and in search rows is RAW. Telegram escapes it with `escapeMarkdown` and keeps it outside every `*…*`/`_…_`; the app renders it as React text. Button labels are plain text and are not escaped.
- **Copy (verbatim, the `TX_STORY_*` constants in shared/tx-story.ts, both surfaces):** `Not from your bank feed — added in Wealthfolio by hand or from a file.` · `Spending.` · `Money in.` · `Not filed yet — it's on your needs-a-category list.` · `Ask /why in Telegram to see who filed it.` · `Category set in Wealthfolio.` · `No changes in the last 90 days.` · `What happened` · `Couldn't reach Wealthfolio — try again.` · `That transaction has changed since — search again with /why.` (Telegram) · `That transaction has changed since — search for it again.` (app) · `Too many matches — add a word or an amount.` Dynamic lines are built in exactly one place, `buildTxStory`: `From your <account> bank feed.[ Still pending.]`, `Half of a transfer: ↔ <$600.00> into|from <account>[, <Oct 4>].`, `A transfer the sync is holding: it waits until <date> for its other half, then counts as spending|money in.`, `The starting balance the add-on set so <account> matches the bank from <date>.`, `A correction the add-on added on <date> so <account> matches the bank.`, `Filed under <cat> by a rule — '<pattern>' matches it.`, `Filed under <cat> by a rule (none of your current rules matches it).`, `Filed under <cat> by you, in Telegram, <Oct 4>.`, `Filed under <cat> from an Amazon email.`, `You told the sync: <not a transfer, keep this duplicate, don't file it automatically, no Amazon label, don't import it>.` Every other user-facing string is spelled out in its task.
- **Telegram.** Legacy `Markdown`. Prefix `cz:wy:` (`WHY_CALLBACK_PREFIX`, shared/telegram.ts), routed in `onMenuCallback` right after `cz:cl:` and before the categorize fallthrough. Stateless: every tap re-reads. Every `callback_data` ≤ 64 bytes. Buttons: `🔎 Why?`, `⬅️ Back`, `‹ Older` / `Newer ›`, numbered history lines. 🔎 Why? buttons send a NEW message and never edit the one they sit on; navigation inside `/why` edits in place.
- **Search.** Newest first, 8 a page (`TX_SEARCH_PAGE_SIZE`), up to 5 pages (40, `TX_SEARCH_MAX_RESULTS`). Telegram: the database, all history; the last 12 months over REST when it cannot be read. App: one keyword word across all history, else the last 12 months.
- **Facts.** Every read but the row's own is wrapped: a failure leaves its line out and adds its `TX_FACT_NOTES` note. An unparseable `sync_overrides` is reported (`overridesUnreadable`), never read as "none". Only the row failing is a full failure (`unreachable`); a row that no longer exists is `gone`.
- **Report cube.** `DrillTx` gains optional `i` and `f`; a row without `i` (an older companion) is never clickable. `DRILL_ROWS_PER_CATEGORY` stays 30.
- **App.** No emoji in app copy (`src/pages/copy-policy.test.tsx`). New CSS classes are `.sfin-why-*` (the card is `.sfin-why-card`), each column-0 selector defined once (`src/components/theme-styles.test.ts`). Every store read is optional-called. A history line's Undo keeps the Change log card's guards: disabled plus `aria-busy` while pending; a re-read that fails keeps the story on screen and says so.
- **Tests use a fixed `now`.** Shared and companion: fixed `Date`s, change-log moments at midday UTC so the local day is the same in every US zone. App: `vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(...)`, `vi.useRealTimers()` after, local `new Date(2026, 9, …)` for anything rendering a day.
- **Imports:** shared sources import siblings WITH `.js`; `src/` imports shared WITHOUT an extension; companion imports `'../../shared/x.js'` and `'./x.js'`.
- **Run the companion suite from `companion/`** (`cd companion && npx vitest run …`), never with `--root`.
- **Gates before calling a task done:** the touched project's tests, plus `npm run type-check` when `src/` or `shared/` changed and `npm --prefix companion run build` when `companion/` or `shared/` changed. Final task: `npm test`, `npm --prefix companion test`, `npm run type-check`, `npm --prefix companion run build`. On the Mac, run builds and full suites under `nice` — it overheats.
- **Edits are exact.** Every "Replace" block below is copied from the file as it stands after the previous tasks (and the earlier edits of the same file in the same task) and occurs exactly once; replace it verbatim (the Edit tool's `old_string` → `new_string`). Apply a file's numbered edits in order. Every "Create" block is the whole file.
- **No version bump, tag or release.** CHANGELOG goes under `[Unreleased]`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A bank name full of Markdown characters** (`SQ *COFFEE_CLUB [2]`, an account `Joe's *Visa*`) in `/why` results and in the story → escaped, and never inside an entity; the only entities are fixed headings. Pinned in Task 5 (`escapes a bank name full of Markdown characters and keeps it out of every entity`; `escapes bank text in the title, the account and the answer, and keeps it out of every entity`) and Task 2 (`keeps bank text raw — escaping is the renderer’s job`).
- **A stale story button after a transfer link re-created the rows** → "That transaction has changed since — search again with /why.", nothing edited or sent. Pinned in Task 5 (`a stale story button — the row was re-created by a transfer link — says so and changes nothing`) and Task 4 (`is "gone" when the row no longer exists, and "unreachable" when it cannot be read`).
- **A pending row that posted under a new tx id** → its story still shows "Imported … (pending)", oldest first, before the bank update. Pinned in Task 1 (`follows a pending row that posted under a new transaction id back to its pending import`) and Task 2 (`a pending row that posted under a new transaction id keeps its pending history, oldest first`).
- **Each fact read failing on its own** → the story still renders, title and all, with that read's note. Pinned in Task 2 (`a failed %s read still tells the story, with a note`, every fact), Task 4 (`a failed read of %s still tells the story, with a note`; `a secret read that fails reports the overrides and the skip list, never "none"`) and Task 7 (`a failed read of %s still tells the story, with a note`).
- **Drill rows from an older companion (no `i`)** → not clickable, shown as before. Pinned in Task 9 (`rows from an older companion, with no activity id, are not clickable`; the board test's `OLD ROW`) and Task 3 (`an older reader’s rows carry neither field, so the app keeps them plain`).
- **A search by amount only** → `54.20` exact, `54` the whole dollar, money in or out; the app reads the last 12 months for it. Pinned in Task 1 (`matches an amount alone, money out or money in`), Task 4 (`searches all of history in the database`) and Task 7 (`searches by amount alone over the last 12 months, newest first, stopping at older rows`).
- **The longest query still fitting in 64 bytes** → every results, story, run and Back button ≤ 64 bytes, the widest exactly 64. Pinned in Task 5 (`the longest query still fits Telegram’s 64 bytes on every button, story Back included`; `carries the story as its back, inside 64 bytes, and Back returns to the story in place`).
- **A 🔎 Why? never disturbs the message it sits on** → the story is a new message; the `/categorize` screen's session and buttons keep working. Pinned in Task 5 (`a result opens its story in place; a 🔎 Why? button sends it as a new message`) and Task 6 (`sends the story as a new message and leaves the screen as it is`).
- **Undo from a story, then the story re-reads** → the Change log card's guards (disabled, `aria-busy`) hold, and a failed re-read keeps the rows with a note. Pinned in Task 8 (`a history line opens the change log’s own entry detail, with its Undo — disabled and busy while it runs`; `reads again after an Undo; a re-read that fails keeps the story and says so`).

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/tx-search.ts` (create) | `parseTxQuery`, `matchesTxQuery`, `findTransactions`, paging, `txDescription`, the app's `txSearchKeyword`. |
| `shared/change-view.ts` (modify) | `changesForTransaction`: a transaction's entries by key, old pending key and activity ids, oldest first. |
| `shared/tx-story.ts` (create) | `TxStoryFacts` → `TxStory` (`buildTxStory`), rule inference, `resolveFiler`, the cube's filer codes, the copy. |
| `shared/report-cube.ts` (modify) | `DrillTx.i?`, `DrillTx.f?`. |
| `shared/telegram.ts` (modify) | `WHY_CALLBACK_PREFIX`, `WHY_BUTTON_TEXT`, `whyButton`. |
| `shared/telegram-commands.ts` (modify) | `/why` in More commands. |
| `shared/categorize-menu.ts` (modify) | `MenuSession.why?`, the `why` action and button. |
| `shared/sync-core.ts` (modify) | `largeTransactionAlerts[].activityId?`. |
| `companion/src/wealthfolio.ts` (modify) | `listCategorizationRules` keeps the matcher's fields; search takes `activityIdFilter`; rows carry `accountName`. |
| `companion/src/sqlite-native.ts` (modify) | Drill rows carry ids, leaf category, source, type; strict readers `getNativeTxDetails`, `getNativeTxPartner`, `getNativeTxSearchRows`. |
| `companion/src/report-cube-build.ts` (modify) | Fills `i` and `f` from a filing context read once. |
| `companion/src/tx-story-host.ts` (create) | The companion's fact-gathering (`companionTxStory`) and search (`companionTxSearch`). |
| `companion/src/why-menu.ts` (create) | `/why`: the menu, its screens, its encoding, the ask flow. A focused new file beside changes-menu.ts. |
| `companion/src/changes-menu.ts` (modify) | An entry opened from a story goes back to it (`w<id>`). |
| `companion/src/categorize.ts` (modify) | `CategorizeDeps.why?`: the screen's 🔎 Why?. |
| `companion/src/index.ts` (modify) | `/why`, its question, `buildWhyMenu`, routing, the alert's and notice's buttons, the cube's filing context. |
| `src/utils/tx-story.ts` (create) | The add-on's fact-gathering (`appTxStory`) and search (`appTxSearch`). |
| `src/components/TxStory.tsx` (create) | `TxStoryView`, `TxStoryPanel`, `useTxStoryActions`. |
| `src/components/WhyCard.tsx` (create) | Home's "Why is this here?" search. |
| `src/components/ChangeLogCard.tsx` (modify) | Exports `EntryDetail`, `RowActions`, `syncNowSentence` for the story (not copied). |
| `src/components/UncategorizedList.tsx`, `src/components/budget/ReportView.tsx`, `src/tabs/BudgetTab.tsx`, `src/tabs/HomeTab.tsx`, `src/pages/SyncPage.tsx`, `src/tabs/SettingsTab.tsx`, `src/components/ui.tsx` (modify) | The three ways in, the wiring, one Sync-now sentence, the `.sfin-why-*` styles. |
| `CHANGELOG.md`, `README.md`, `docs/superpowers/follow-ups.md` (modify) | Docs and follow-ups §10. |

---

### Task 1: Finding a transaction — the search and its history

The two pure pieces everything else stands on (spec B, C4, W7). `shared/tx-search.ts` reads what a person typed as words and/or an amount and decides whether a row matches: every word, ignoring case, in the description (the note without its markers and transaction id) or the account name; `54.20`/`$54.20` exactly, `54` the whole dollar, `1,250` thousand-separated (`parseAmountCents`), money in or out. It also pages (8, up to 40), names the add-on's own rows plainly, and picks the one word the app may hand Wealthfolio's keyword search (W1a). `changesForTransaction` (shared/change-view.ts) finds every change-log entry about ONE transaction, oldest first: by its account-scoped keys, by the OLD key a bank update recorded when a pending row posted under a new id (so a posted row keeps "Imported … (pending)"), and by activity ids current and replaced by a link — learning more of the identity as it goes, but only ever this leg's.

**Files:**
- Create: `shared/tx-search.ts`, `shared/tx-search.test.ts`, `shared/change-view-tx.test.ts`
- Modify: `shared/change-view.ts` (insert before `changesWithin`)

**Interfaces:**
- Consumes: `parseAmountCents(text): number | null` (shared/telegram-commands.ts); `descriptionFromComment`, `STARTING_BALANCE_COMMENT_PREFIX`, `BALANCE_ADJUSTMENT_COMMENT_PREFIX` (shared/sync-core.ts); `ChangeEntry` and the entry builders (shared/change-entries.ts, tests).
- Produces:

```ts
// shared/tx-search.ts
export const TX_SEARCH_PAGE_SIZE = 8;
export const TX_SEARCH_MAX_PAGES = 5;
export const TX_SEARCH_MAX_RESULTS: number;            // 40
export const TX_SEARCH_RECENT_DAYS = 365;
export const TX_SEARCH_TOO_MANY = 'Too many matches — add a word or an amount.';
export interface TxAmountQuery { minCents: number; maxCents: number; text: string }
export interface TxQuery { words: string[]; amount: TxAmountQuery | null }
export interface TxSearchRow { activityId: string; date: string; description: string; amountCents: number; accountName: string }
export interface TxSearchResult { rows: TxSearchRow[]; truncated: boolean }
export function parseTxQuery(text: string): TxQuery;
export function isEmptyTxQuery(q: TxQuery): boolean;
export function txQueryText(q: TxQuery): string;
export function matchesTxQuery(row: Pick<TxSearchRow, 'description' | 'accountName' | 'amountCents'>, q: TxQuery): boolean;
export function findTransactions(rows: readonly TxSearchRow[], q: TxQuery): TxSearchResult;
export function txSearchPage<T>(items: readonly T[], page: number): { slice: T[]; page: number; pages: number };
export function txDescription(note: string | null | undefined): string;
export function txSearchKeyword(q: TxQuery, accountNames: readonly string[]): string | null;

// shared/change-view.ts
export function changesForTransaction<T extends ChangeEntry>(
  entries: readonly T[], id: { txKeys?: readonly string[]; activityIds?: readonly string[] },
): T[];
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/tx-search.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import {
  findTransactions, isEmptyTxQuery, matchesTxQuery, parseTxQuery, txDescription, txQueryText, txSearchKeyword,
  txSearchPage, TX_SEARCH_MAX_RESULTS, type TxSearchRow,
} from './tx-search';

const row = (over: Partial<TxSearchRow> = {}): TxSearchRow => ({
  activityId: 'act-1', date: '2026-10-04', description: 'KROGER #415', amountCents: -5420, accountName: 'PNC Checking', ...over,
});

describe('parseTxQuery', () => {
  it('reads 54.20 and $54.20 as that exact amount', () => {
    expect(parseTxQuery('54.20')).toEqual({ words: [], amount: { minCents: 5420, maxCents: 5420, text: '54.20' } });
    expect(parseTxQuery('$54.20')).toEqual({ words: [], amount: { minCents: 5420, maxCents: 5420, text: '54.20' } });
  });

  it('reads a whole number as every amount in that dollar', () => {
    expect(parseTxQuery('54').amount).toEqual({ minCents: 5400, maxCents: 5499, text: '54' });
  });

  it('reads 1,250 as a thousand-separated amount', () => {
    expect(parseTxQuery('1,250').amount).toEqual({ minCents: 125000, maxCents: 125099, text: '1,250' });
  });

  it('splits words from the amount, lower-cased, whichever order they come in', () => {
    expect(parseTxQuery('Kroger 54.20')).toEqual({ words: ['kroger'], amount: { minCents: 5420, maxCents: 5420, text: '54.20' } });
    expect(parseTxQuery('$12  Heine   Brothers')).toEqual({ words: ['heine', 'brothers'], amount: { minCents: 1200, maxCents: 1299, text: '12' } });
  });

  it('reads words only, and keeps a second amount-looking token as a word', () => {
    expect(parseTxQuery('venmo jane')).toEqual({ words: ['venmo', 'jane'], amount: null });
    expect(parseTxQuery('20 30')).toEqual({ words: ['30'], amount: { minCents: 2000, maxCents: 2099, text: '20' } });
  });

  it('ignores a sign: an amount matches money in and money out', () => {
    expect(parseTxQuery('-54.20').amount).toEqual({ minCents: 5420, maxCents: 5420, text: '54.20' });
  });

  it('is empty for blank text', () => {
    expect(isEmptyTxQuery(parseTxQuery('   '))).toBe(true);
    expect(isEmptyTxQuery(parseTxQuery('54'))).toBe(false);
  });

  it('writes a query back as words then the amount', () => {
    expect(txQueryText(parseTxQuery('$54.20 Kroger'))).toBe('kroger 54.20');
  });
});

describe('matchesTxQuery', () => {
  it('matches every word, ignoring case, in the description or the account name', () => {
    expect(matchesTxQuery(row(), parseTxQuery('kroger pnc'))).toBe(true);
    expect(matchesTxQuery(row(), parseTxQuery('kroger ally'))).toBe(false);
  });

  it('matches an amount alone, money out or money in', () => {
    expect(matchesTxQuery(row(), parseTxQuery('54.20'))).toBe(true);
    expect(matchesTxQuery(row({ amountCents: 5420 }), parseTxQuery('$54.20'))).toBe(true);
    expect(matchesTxQuery(row(), parseTxQuery('54'))).toBe(true);
    expect(matchesTxQuery(row({ amountCents: -5500 }), parseTxQuery('54'))).toBe(false);
    expect(matchesTxQuery(row(), parseTxQuery('54.21'))).toBe(false);
  });

  it('matches words and an amount together', () => {
    expect(matchesTxQuery(row(), parseTxQuery('kroger 54'))).toBe(true);
    expect(matchesTxQuery(row(), parseTxQuery('kroger 12'))).toBe(false);
  });

  it('matches nothing for an empty query', () => {
    expect(matchesTxQuery(row(), parseTxQuery(''))).toBe(false);
  });
});

describe('findTransactions', () => {
  it('lists matches newest first and stops at 40, saying there were more', () => {
    const rows = Array.from({ length: 45 }, (_, i) => row({
      activityId: `a${String(i).padStart(2, '0')}`, date: `2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
    }));
    const found = findTransactions(rows, parseTxQuery('kroger'));
    expect(found.rows).toHaveLength(TX_SEARCH_MAX_RESULTS);
    expect(found.truncated).toBe(true);
    const dates = found.rows.map((r) => r.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('does not truncate a short list', () => {
    const found = findTransactions([row(), row({ activityId: 'b', description: 'TARGET' })], parseTxQuery('kroger'));
    expect(found).toEqual({ rows: [row()], truncated: false });
  });
});

describe('txSearchPage', () => {
  it('pages by 8 and clamps the page', () => {
    const items = Array.from({ length: 19 }, (_, i) => i);
    expect(txSearchPage(items, 0)).toEqual({ slice: [0, 1, 2, 3, 4, 5, 6, 7], page: 0, pages: 3 });
    expect(txSearchPage(items, 9).page).toBe(2);
    expect(txSearchPage([], 0)).toEqual({ slice: [], page: 0, pages: 1 });
  });
});

describe('txDescription', () => {
  it('drops the transaction id, the pending marker and the in-transit prefix', () => {
    expect(txDescription('KROGER #415 · TRN-1')).toBe('KROGER #415');
    expect(txDescription('KROGER #415 · TRN-1 · pending')).toBe('KROGER #415');
    expect(txDescription('↔️ In-transit transfer · ONLINE TRANSFER TO ALLY · TRN-2')).toBe('ONLINE TRANSFER TO ALLY');
  });

  it('names the add-on’s own rows plainly', () => {
    expect(txDescription('Starting balance · ACT-1')).toBe('Starting balance');
    expect(txDescription('Balance adjustment · ACT-1 · 2026-10-01')).toBe('Balance adjustment');
  });

  it('keeps a hand-entered note as it is', () => {
    expect(txDescription('Rent for October')).toBe('Rent for October');
  });
});

describe('txSearchKeyword', () => {
  it('picks the longest word no account name contains', () => {
    expect(txSearchKeyword(parseTxQuery('pnc heine cafe'), ['PNC Checking'])).toBe('heine');
  });

  it('is null when every word may be an account name, or there are no words', () => {
    expect(txSearchKeyword(parseTxQuery('checking'), ['PNC Checking'])).toBeNull();
    expect(txSearchKeyword(parseTxQuery('54.20'), ['PNC Checking'])).toBeNull();
  });

  it('skips a word with non-ASCII letters, which Wealthfolio matches by case', () => {
    expect(txSearchKeyword(parseTxQuery('café'), [])).toBeNull();
  });
});
```

**Create `shared/change-view-tx.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import {
  bankUpdateChange, categoryFiledChange, importChange, stampChange, transferLinkChange, type ChangeDraft,
} from './change-entries';
import type { ChangeLogItem } from './change-log';
import { changesForTransaction } from './change-view';

const CHECKING = { sfinId: 'ACT-chk', wfId: 'wf-chk', name: 'PNC Checking' };
const ALLY = { sfinId: 'ACT-ally', wfId: 'wf-ally', name: 'Ally Savings' };
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12, 0));
const item = (draft: ChangeDraft, day: number): ChangeLogItem => stampChange(draft, 'companion', at(day));

const imported = (txKey: string, activityId: string, day: number, pending = false) => item(importChange({
  account: CHECKING, txKey, activityId, description: 'KROGER #415', amountCents: -5420, date: '2026-10-01',
  pending, activityType: 'WITHDRAWAL',
}), day);
const posted = (newKey: string, oldKey: string, activityId: string, day: number) => item(bankUpdateChange({
  account: CHECKING, txKey: newKey, activityId, description: 'KROGER #415', amountCents: -5420,
  before: { absCents: 5420, date: '2026-10-01', pending: true, activityType: 'WITHDRAWAL' },
  after: { absCents: 5420, date: '2026-10-02', pending: false, activityType: 'WITHDRAWAL' },
  previousTxKey: oldKey,
}), day);
const filedOn = (activityId: string, day: number) => item(categoryFiledChange({
  actor: 'you', activityId, description: 'KROGER #415', before: null, after: { categoryId: 'cat-gro', categoryName: 'Groceries' },
}), day);
const link = (day: number) => item(transferLinkChange(
  { account: CHECKING, txKey: 'k-out', description: 'TRANSFER TO ALLY', amountCents: -60000, date: '2026-10-04', oldActivityId: 'old-out', newActivityId: 'new-out' },
  { account: ALLY, txKey: 'k-in', description: 'TRANSFER FROM PNC', amountCents: 60000, date: '2026-10-04', oldActivityId: 'old-in', newActivityId: 'new-in' },
), day);

describe('changesForTransaction', () => {
  it('finds entries by the transaction’s key, oldest first', () => {
    const log = [filedOn('act-9', 5), imported('k1', 'act-1', 3), imported('k2', 'act-2', 4)];
    expect(changesForTransaction(log, { txKeys: ['k1'] }).map((e) => e.summary)).toEqual(['Imported KROGER #415']);
  });

  it('follows a pending row that posted under a new transaction id back to its pending import', () => {
    const log = [posted('k-new', 'k-old', 'act-1', 6), imported('k-old', 'act-1', 2, true)];
    const found = changesForTransaction(log, { txKeys: ['k-new'] });
    expect(found.map((e) => e.summary)).toEqual([
      'Imported KROGER #415 (pending)',
      'Updated KROGER #415 from the bank: Oct 1 → Oct 2, posted',
    ]);
  });

  it('finds entries by activity id, the current one and the one a transfer link replaced', () => {
    const log = [filedOn('old-out', 2), link(4), filedOn('new-out', 6)];
    const found = changesForTransaction(log, { activityIds: ['new-out'] });
    expect(found.map((e) => e.at)).toEqual([at(2), at(4), at(6)].map((d) => d.toISOString()));
  });

  it('matches by before.activityIds alone', () => {
    const found = changesForTransaction([link(4)], { activityIds: ['old-in'] });
    expect(found).toHaveLength(1);
  });

  it('never pulls in the other half of a link', () => {
    const otherHalf = item(importChange({
      account: ALLY, txKey: 'k-in', activityId: 'old-in', description: 'TRANSFER FROM PNC', amountCents: 60000,
      date: '2026-10-04', pending: false, activityType: 'DEPOSIT',
    }), 3);
    const thisHalf = item(importChange({
      account: CHECKING, txKey: 'k-out', activityId: 'old-out', description: 'TRANSFER TO ALLY', amountCents: -60000,
      date: '2026-10-04', pending: false, activityType: 'WITHDRAWAL',
    }), 3);
    const found = changesForTransaction([otherHalf, thisHalf, link(4)], { txKeys: ['k-out'], activityIds: ['new-out'] });
    expect(found.map((e) => e.summary)).toEqual([
      'Imported TRANSFER TO ALLY',
      'Linked TRANSFER TO ALLY and TRANSFER FROM PNC as one transfer',
    ]);
  });

  it('finds nothing for a transaction with no identity', () => {
    expect(changesForTransaction([imported('k1', 'act-1', 3)], {})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/tx-search.test.ts shared/change-view-tx.test.ts`
Expected: FAIL — `./tx-search` cannot be resolved, and all 6 `changesForTransaction` tests fail with "changesForTransaction is not a function".

- [ ] **Step 3: Implement**

**Create `shared/tx-search.ts`:**

```ts
/**
 * shared/tx-search.ts
 *
 * Finding a transaction, for `/why` (companion/src/why-menu.ts) and the app's
 * "Why is this here?" box (src/components/WhyCard.tsx): what a person typed,
 * read as words and/or an amount, and whether a row matches it. Pure.
 *
 * Words must ALL appear, ignoring case, in the description (the note without
 * its markers and transaction id) or the account name. An amount matches
 * money in and money out alike: `54.20` and `$54.20` exactly, `54` anything
 * from $54.00 to $54.99, `1,250` thousand-separated (`parseAmountCents`).
 *
 * Text is compared RAW; nothing here escapes.
 */
import { BALANCE_ADJUSTMENT_COMMENT_PREFIX, STARTING_BALANCE_COMMENT_PREFIX, descriptionFromComment } from './sync-core.js';
import { parseAmountCents } from './telegram-commands.js';

export const TX_SEARCH_PAGE_SIZE = 8;
export const TX_SEARCH_MAX_PAGES = 5;
export const TX_SEARCH_MAX_RESULTS = TX_SEARCH_PAGE_SIZE * TX_SEARCH_MAX_PAGES;
/** How far back a search reaches when it cannot read all of history. */
export const TX_SEARCH_RECENT_DAYS = 365;
export const TX_SEARCH_TOO_MANY = 'Too many matches — add a word or an amount.';

export interface TxAmountQuery {
  /** Inclusive bounds on the amount's magnitude, in cents. */
  minCents: number;
  maxCents: number;
  /** As typed, without `$` or a sign. */
  text: string;
}

export interface TxQuery {
  /** Lower-cased. */
  words: string[];
  amount: TxAmountQuery | null;
}

/** One transaction as a search shows it. */
export interface TxSearchRow {
  activityId: string;
  /** YYYY-MM-DD. */
  date: string;
  /** `txDescription` of the stored note. */
  description: string;
  /** Signed cents, money out negative. */
  amountCents: number;
  accountName: string;
}

/** The first token that reads as an amount is the amount; everything else,
 *  including a second amount-looking token, is a word. */
export function parseTxQuery(text: string): TxQuery {
  const words: string[] = [];
  let amount: TxAmountQuery | null = null;
  for (const token of (text ?? '').trim().split(/\s+/).filter(Boolean)) {
    const read: TxAmountQuery | null = amount ? null : readAmount(token);
    if (read) amount = read;
    else words.push(token.toLowerCase());
  }
  return { words, amount };
}

function readAmount(token: string): TxAmountQuery | null {
  // A sign says nothing here: amounts match money in and money out.
  const unsigned = token.replace(/^[+\-−]/, '');
  const cents = parseAmountCents(unsigned);
  if (cents === null) return null;
  const text = unsigned.replace(/^\$/, '');
  return { minCents: cents, maxCents: text.includes('.') ? cents : cents + 99, text };
}

export function isEmptyTxQuery(q: TxQuery): boolean {
  return q.words.length === 0 && q.amount === null;
}

/** A query as one line of text: words, then the amount. */
export function txQueryText(q: TxQuery): string {
  return [...q.words, ...(q.amount ? [q.amount.text] : [])].join(' ');
}

export function matchesTxQuery(row: Pick<TxSearchRow, 'description' | 'accountName' | 'amountCents'>, q: TxQuery): boolean {
  if (isEmptyTxQuery(q)) return false;
  if (q.amount) {
    const abs = Math.abs(Math.round(row.amountCents));
    if (abs < q.amount.minCents || abs > q.amount.maxCents) return false;
  }
  // A newline between the two, so a word cannot match across them.
  const hay = `${row.description}\n${row.accountName}`.toLowerCase();
  return q.words.every((w) => hay.includes(w));
}

export interface TxSearchResult {
  /** Newest first, at most `TX_SEARCH_MAX_RESULTS`. */
  rows: TxSearchRow[];
  /** More matched than are listed. */
  truncated: boolean;
}

export function findTransactions(rows: readonly TxSearchRow[], q: TxQuery): TxSearchResult {
  const hits = rows
    .filter((r) => matchesTxQuery(r, q))
    .sort((a, b) => (a.date === b.date
      ? (a.activityId < b.activityId ? -1 : a.activityId > b.activityId ? 1 : 0)
      : a.date < b.date ? 1 : -1));
  return { rows: hits.slice(0, TX_SEARCH_MAX_RESULTS), truncated: hits.length > TX_SEARCH_MAX_RESULTS };
}

/** One page of a list, the page clamped into range. */
export function txSearchPage<T>(items: readonly T[], page: number): { slice: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / TX_SEARCH_PAGE_SIZE));
  const p = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1);
  return { slice: items.slice(p * TX_SEARCH_PAGE_SIZE, (p + 1) * TX_SEARCH_PAGE_SIZE), page: p, pages };
}

/**
 * The description a person recognises: the bank's text with the sync's
 * decorations off (`descriptionFromComment`), and the add-on's own two kinds
 * of row named plainly — their notes carry an account id, not a description.
 */
export function txDescription(note: string | null | undefined): string {
  const n = note ?? '';
  if (n.startsWith(STARTING_BALANCE_COMMENT_PREFIX)) return 'Starting balance';
  if (n.startsWith(BALANCE_ADJUSTMENT_COMMENT_PREFIX)) return 'Balance adjustment';
  return descriptionFromComment(n);
}

/**
 * The one word Wealthfolio's own activity search can narrow by. Its keyword
 * is a single `LIKE '%word%'` over the note (and asset fields), never the
 * account name — so only a word that no account name contains is safe: a row
 * can match that word through its description alone. ASCII only, because
 * SQLite's LIKE ignores case for ASCII letters and nothing else. The longest
 * such word narrows the most; null when there is none.
 */
export function txSearchKeyword(q: TxQuery, accountNames: readonly string[]): string | null {
  const names = accountNames.map((n) => n.toLowerCase());
  const safe = q.words
    .filter((w) => /^[\x20-\x7e]+$/.test(w))
    .filter((w) => !names.some((n) => n.includes(w)));
  if (safe.length === 0) return null;
  return safe.reduce((best, w) => (w.length > best.length ? w : best));
}
```

Edit 1 of 1 in `shared/change-view.ts` — `changesForTransaction`, after `matchesChangeSearch`. Replace:

```ts
/** Entries from the last `days` days (by the moment they were written). */
```

with:

```ts
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);

/** The identity one entry carries for its subject(s), aligned by position:
 *  a transfer link lists both legs, out first, in `subject.txKeys`,
 *  `subject.activityIds` and `before.activityIds` alike. */
function entryIdentity(e: ChangeEntry) {
  const before = isRecord(e.before) ? e.before : {};
  const after = isRecord(e.after) ? e.after : {};
  return {
    keys: strings(e.subject.txKeys),
    ids: strings(e.subject.activityIds),
    beforeIds: strings(before.activityIds),
    afterIds: strings(after.activityIds),
    oldKey: e.kind === 'bank-update' ? str(before.txKey) : null,
    leftBehind: str(after.activityId),
  };
}

function entryMatches(e: ChangeEntry, keys: Set<string>, ids: Set<string>): boolean {
  const x = entryIdentity(e);
  return x.keys.some((k) => keys.has(k))
    || (x.oldKey !== null && keys.has(x.oldKey))
    || x.ids.some((id) => ids.has(id))
    || x.beforeIds.some((id) => ids.has(id));
}

/** What a matched entry teaches about the same transaction: a bank update's
 *  old key, the row a reversal left behind, and — for a link — THIS leg's old
 *  and new ids and key, found by its position. Bookkeeping lists rows that do
 *  not line up by position, so it teaches nothing. */
function learnIdentity(e: ChangeEntry, keys: Set<string>, ids: Set<string>): void {
  if (e.kind === 'bookkeeping') return;
  const x = entryIdentity(e);
  if (x.oldKey) keys.add(x.oldKey);
  if (x.keys.length <= 1 && x.ids.length <= 1) {
    for (const k of x.keys) keys.add(k);
    for (const id of [...x.ids, ...x.beforeIds, ...(x.leftBehind ? [x.leftBehind] : [])]) ids.add(id);
    return;
  }
  const legs = Math.max(x.keys.length, x.ids.length, x.beforeIds.length);
  for (let i = 0; i < legs; i++) {
    const mine = (x.keys[i] !== undefined && keys.has(x.keys[i]))
      || (x.ids[i] !== undefined && ids.has(x.ids[i]))
      || (x.beforeIds[i] !== undefined && ids.has(x.beforeIds[i]));
    if (!mine) continue;
    if (x.keys[i]) keys.add(x.keys[i]);
    for (const id of [x.ids[i], x.beforeIds[i], x.afterIds[i]]) if (id) ids.add(id);
  }
}

/**
 * Every entry about ONE transaction, oldest first — the story's "What
 * happened". It matches, in this order: the transaction's account-scoped tx
 * keys; the OLD key a bank update records when a pending row posted under a
 * new transaction id (so the posted row keeps its pending history); its
 * activity ids, current and the ones a transfer link replaced
 * (`subject.activityIds`, `before.activityIds`). Every match can teach more of
 * the same transaction's identity, so the walk repeats until nothing new is
 * learned. Background bookkeeping about the transaction is included.
 */
export function changesForTransaction<T extends ChangeEntry>(
  entries: readonly T[],
  id: { txKeys?: readonly string[]; activityIds?: readonly string[] },
): T[] {
  const keys = new Set((id.txKeys ?? []).filter(Boolean));
  const ids = new Set((id.activityIds ?? []).filter(Boolean));
  for (let pass = 0; pass < 8; pass++) {
    const known = keys.size + ids.size;
    for (const e of entries) if (entryMatches(e, keys, ids)) learnIdentity(e, keys, ids);
    if (keys.size + ids.size === known) break;
  }
  return entries
    .filter((e) => entryMatches(e, keys, ids))
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at < b.at ? -1 : 1));
}

/** Entries from the last `days` days (by the moment they were written). */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/tx-search.test.ts shared/change-view-tx.test.ts shared/change-view.test.ts`
Expected: PASS — 44 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/tx-search.ts shared/tx-search.test.ts shared/change-view.ts shared/change-view-tx.test.ts
git commit -m "Shared: find a transaction by words or an amount, and every change-log entry about it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The story — facts in, a few plain lines out

`shared/tx-story.ts` (spec A1, B, C3, W2, W3): one function, `buildTxStory`, turns whatever a host could gather (`TxStoryFacts`) into the story both surfaces show — the title (`<description> · <signed amount> · <date>`) and account, then the answer: where it came from (the bank feed, still pending, or "not from your bank feed"), what it is (spending, money in, half of a transfer, a held transfer, a starting balance, a correction), its category and who filed it, and what you told the sync; then What happened, oldest first, and one note per failed read. Every fact is optional; only the row is required. It also owns the honest "who filed it": `resolveFiler` names a rule's filing by inferring the rule Wealthfolio applies first (W1c — `inferFilingRule` transcribes the upstream matcher and its order), and anything else by the newest log entry that set this category (you in Telegram, an Amazon email, the opening-balance filing), then the note's Amazon label, then "by hand"; `encodeFiler`/`decodeFiler` are the cube's short codes (W1b). Pure.

**Files:**
- Create: `shared/tx-story.ts`, `shared/tx-story.test.ts`

**Interfaces:**
- Consumes: Task 1 (`txDescription`); `amazonLabelOf`, `changeDay`, `changeMoney`, `ChangeEntry` (shared/change-entries.ts); `ChangeLogItem` (shared/change-log.ts); `changeLocalDay` (shared/change-view.ts); `IN_TRANSIT_COMMENT_PREFIX` (shared/reconcile.ts); `BALANCE_ADJUSTMENT_COMMENT_PREFIX`, `IN_TRANSIT_TIMEOUT_SECONDS`, `PENDING_SUFFIX`, `STARTING_BALANCE_COMMENT_PREFIX`, `isTransferType`, `txIdFromComment` (shared/sync-core.ts); `TxOverrideFlag` (shared/sync-overrides.ts).
- Produces:

```ts
export const TX_STORY_NOT_FROM_FEED, TX_STORY_SPENDING, TX_STORY_MONEY_IN, TX_STORY_NOT_FILED, TX_STORY_ASK_TELEGRAM,
  TX_STORY_SET_IN_WEALTHFOLIO, TX_STORY_NO_HISTORY, TX_STORY_WHAT_HAPPENED, TX_STORY_UNREACHABLE, TX_STORY_GONE,
  TX_STORY_GONE_APP: string;                       // the copy (Global Constraints)
export type TxFactName = 'mapping' | 'partner' | 'category' | 'rules' | 'changeLog' | 'overrides' | 'overridesUnreadable' | 'skipList';
export const TX_FACT_NOTES: Record<TxFactName, string>;
export const TX_OVERRIDE_WORDS: Record<TxOverrideFlag | 'skipped', string>;
export interface TxStoryRow { activityId: string; note: string; absCents: number; date: string; activityType: string; accountName: string; accountType?: string }
export interface TxPartner { accountName: string; date?: string }
export type TxFiler =
  | { kind: 'rule'; pattern: string | null; unknown?: true } | { kind: 'you'; at?: string }
  | { kind: 'amazon'; label: string } | { kind: 'opening' } | { kind: 'hand' };
export interface TxStoryFacts {
  row: TxStoryRow;
  feed?: { sfinAccountId: string } | null;
  partner?: TxPartner | null;
  category?: { name: string; filer?: TxFiler | null } | null;
  needsCategory?: boolean;
  filerHint?: 'telegram' | 'wealthfolio';
  overrides?: readonly TxOverrideFlag[];
  skipped?: boolean;
  history?: readonly ChangeLogItem[];
  failed?: readonly TxFactName[];
}
export interface TxStoryHistoryLine { entryId: string; line: string }
export interface TxStory { title: string; accountLine: string; answer: string[]; history: TxStoryHistoryLine[] | null; notes: string[] }
export function isOutflow(activityType: string, accountType?: string): boolean;
export function signedCents(row: Pick<TxStoryRow, 'absCents' | 'activityType' | 'accountType'>): number;
export function splitAmazonLabel(description: string): { bare: string; label: string | null };
export interface CategoryRuleLike { id: string; pattern: string; matchType?: string | null; taxonomyId?: string | null; categoryId: string | null;
  priority?: number | null; isGlobal?: boolean | null; accountId?: string | null; activityType?: string | null;
  amountOp?: string | null; amountValue?: number | string | null; amountValue2?: number | string | null }
export interface RuleRow { note: string; activityType: string; accountId: string; absCents: number }
export function ruleMatchesRow(rule: CategoryRuleLike, row: RuleRow): boolean;
export function inferFilingRule(rules: readonly CategoryRuleLike[], row: RuleRow, categoryId: string): CategoryRuleLike | null;
export interface FilerInput { source: string | null | undefined; categoryId: string; row: RuleRow;
  history: readonly ChangeEntry[] | null; rules: readonly CategoryRuleLike[] | null }
export function resolveFiler(f: FilerInput): TxFiler | null;
export function withFilingDay(filer: TxFiler, history: readonly ChangeEntry[] | null | undefined): TxFiler;
export function encodeFiler(filer: TxFiler | null | undefined): string | undefined;
export function decodeFiler(code: unknown): TxFiler | null;
export function buildTxStory(facts: TxStoryFacts): TxStory;
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/tx-story.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import {
  amazonLabelChange, bankUpdateChange, categoryFiledChange, importChange, openingBalanceFiledChange, stampChange,
  transferLinkChange, transferTypeChange, type ChangeDraft,
} from './change-entries';
import type { ChangeLogItem } from './change-log';
import {
  buildTxStory, decodeFiler, encodeFiler, inferFilingRule, resolveFiler, ruleMatchesRow, signedCents, splitAmazonLabel,
  TX_FACT_NOTES, TX_STORY_ASK_TELEGRAM, TX_STORY_MONEY_IN, TX_STORY_NOT_FILED, TX_STORY_NOT_FROM_FEED,
  TX_STORY_SET_IN_WEALTHFOLIO, TX_STORY_SPENDING, withFilingDay, type CategoryRuleLike, type TxFactName,
  type TxStoryFacts, type TxStoryRow,
} from './tx-story';

const CHECKING = { sfinId: 'ACT-chk', wfId: 'wf-chk', name: 'PNC Checking' };
const ALLY = { sfinId: 'ACT-ally', wfId: 'wf-ally', name: 'Ally Savings' };
/** Midday UTC: the same calendar day in every US zone. */
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12, 0));
const item = (draft: ChangeDraft, day: number, writer: 'addon' | 'companion' = 'companion'): ChangeLogItem => stampChange(draft, writer, at(day));

const row = (over: Partial<TxStoryRow> = {}): TxStoryRow => ({
  activityId: 'act-1', note: 'KROGER #415 · TRN-1', absCents: 5420, date: '2026-10-04',
  activityType: 'WITHDRAWAL', accountName: 'PNC Checking', accountType: 'CASH', ...over,
});
const story = (over: Partial<TxStoryFacts> = {}) => buildTxStory({ row: row(), feed: { sfinAccountId: 'ACT-chk' }, partner: null, history: [], ...over });

describe('buildTxStory — one fixture per row kind', () => {
  it('a bank import: the feed, spending, the rule that filed it, its history', () => {
    const imp = item(importChange({
      account: CHECKING, txKey: 'k1', activityId: 'act-1', description: 'KROGER #415', amountCents: -5420, date: '2026-10-04',
      pending: false, activityType: 'WITHDRAWAL',
    }), 4);
    const s = story({ category: { name: 'Groceries', filer: { kind: 'rule', pattern: 'KROGER' } }, history: [imp] });
    expect(s).toEqual({
      title: 'KROGER #415 · -$54.20 · Oct 4',
      accountLine: 'PNC Checking',
      answer: [
        'From your PNC Checking bank feed.',
        TX_STORY_SPENDING,
        "Filed under Groceries by a rule — 'KROGER' matches it.",
      ],
      history: [{ entryId: imp.id, line: 'Oct 4 · Imported KROGER #415' }],
      notes: [],
    });
  });

  it('a pending row says so', () => {
    expect(story({ row: row({ note: 'KROGER #415 · TRN-1 · pending' }) }).answer[0]).toBe('From your PNC Checking bank feed. Still pending.');
  });

  it('a pending row that posted under a new transaction id keeps its pending history, oldest first', () => {
    const imp = item(importChange({
      account: CHECKING, txKey: 'k-old', activityId: 'act-1', description: 'KROGER #415', amountCents: -5420, date: '2026-10-03',
      pending: true, activityType: 'WITHDRAWAL',
    }), 3);
    const upd = item(bankUpdateChange({
      account: CHECKING, txKey: 'k-new', activityId: 'act-1', description: 'KROGER #415', amountCents: -5420,
      before: { absCents: 5420, date: '2026-10-03', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 5420, date: '2026-10-04', pending: false, activityType: 'WITHDRAWAL' }, previousTxKey: 'k-old',
    }), 5);
    const s = story({ history: [upd, imp] });
    expect(s.answer[0]).toBe('From your PNC Checking bank feed.');
    expect(s.history!.map((h) => h.line)).toEqual([
      'Oct 3 · Imported KROGER #415 (pending)',
      'Oct 5 · Updated KROGER #415 from the bank: Oct 3 → Oct 4, posted',
    ]);
  });

  it('a linked transfer names the other account and day, and asks for no category', () => {
    const lnk = item(transferLinkChange(
      { account: CHECKING, txKey: 'k-out', description: 'TRANSFER TO ALLY', amountCents: -60000, date: '2026-10-04', oldActivityId: 'o1', newActivityId: 'act-1' },
      { account: ALLY, txKey: 'k-in', description: 'TRANSFER FROM PNC', amountCents: 60000, date: '2026-10-04', oldActivityId: 'o2', newActivityId: 'act-2' },
    ), 4);
    const s = story({
      row: row({ note: 'TRANSFER TO ALLY · TRN-9', absCents: 60000, activityType: 'TRANSFER_OUT' }),
      partner: { accountName: 'Ally Savings', date: '2026-10-04' }, category: null, history: [lnk],
    });
    expect(s.answer).toEqual(['From your PNC Checking bank feed.', 'Half of a transfer: ↔ $600.00 into Ally Savings, Oct 4.']);
    const incoming = story({
      row: row({ note: 'TRANSFER FROM PNC · TRN-8', absCents: 60000, activityType: 'TRANSFER_IN', accountName: 'Ally Savings' }),
      partner: { accountName: 'PNC Checking' }, category: null,
    });
    expect(incoming.answer[1]).toBe('Half of a transfer: ↔ $600.00 from PNC Checking.');
  });

  it('a held transfer says how long it waits and what it becomes', () => {
    const held = item(transferTypeChange({
      account: CHECKING, txKey: 'k1', activityId: 'act-1', description: 'ONLINE TRANSFER TO ALLY', amountCents: -60000,
      date: '2026-10-04', activityType: 'TRANSFER_OUT', previousType: null, held: true,
    }), 4);
    const s = story({
      row: row({ note: '↔️ In-transit transfer · ONLINE TRANSFER TO ALLY · TRN-9', absCents: 60000, activityType: 'TRANSFER_OUT' }),
      category: null, history: [held],
    });
    expect(s.title).toBe('ONLINE TRANSFER TO ALLY · -$600.00 · Oct 4');
    expect(s.answer).toEqual(['A transfer the sync is holding: it waits until Oct 14 for its other half, then counts as spending.']);
    const inflow = story({
      row: row({ note: '↔️ In-transit transfer · FROM PNC · TRN-8', absCents: 60000, activityType: 'TRANSFER_IN' }), category: null,
    });
    expect(inflow.answer).toEqual(['A transfer the sync is holding: it waits until Oct 14 for its other half, then counts as money in.']);
  });

  it('a starting balance, filed by the add-on so it is not spending', () => {
    const filed = item(openingBalanceFiledChange({
      account: CHECKING, activityId: 'act-1', amountCents: -23540, date: '2026-05-01',
      category: { categoryId: 'cat-open', categoryName: 'Opening balances' },
    }), 5);
    const s = story({
      row: row({ note: 'Starting balance · ACT-chk', absCents: 23540, date: '2026-05-01', accountType: 'CREDIT_CARD' }),
      category: { name: 'Opening balances', filer: { kind: 'opening' } }, history: [filed],
    });
    expect(s.title).toBe('Starting balance · -$235.40 · May 1');
    expect(s.answer).toEqual([
      'The starting balance the add-on set so PNC Checking matches the bank from May 1.',
      "Filed under Opening balances by the add-on — an opening balance isn't spending.",
    ]);
  });

  it('a correction names the day it was added', () => {
    const s = story({ row: row({ note: 'Balance adjustment · ACT-chk · 2026-10-02', absCents: 1522, activityType: 'DEPOSIT', date: '2026-10-02' }), category: null });
    expect(s.title).toBe('Balance adjustment · $15.22 · Oct 2');
    expect(s.answer).toEqual(['A correction the add-on added on Oct 2 so PNC Checking matches the bank.']);
  });

  it('a row with no transaction id, or in an account the add-on does not sync, is not from the bank', () => {
    expect(story({ row: row({ note: 'Rent for October' }) }).answer[0]).toBe(TX_STORY_NOT_FROM_FEED);
    expect(story({ feed: null }).answer[0]).toBe(TX_STORY_NOT_FROM_FEED);
  });

  it('a transaction older than 90 days has no history to show', () => {
    expect(story({ row: row({ date: '2026-03-01' }), history: [] }).history).toEqual([]);
  });

  it('money in on a card, and interest a card charged', () => {
    expect(story({ row: row({ activityType: 'CREDIT', accountType: 'CREDIT_CARD' }) }).answer[1]).toBe(TX_STORY_MONEY_IN);
    expect(story({ row: row({ activityType: 'INTEREST', accountType: 'CREDIT_CARD' }) }).title).toContain('-$54.20');
    expect(story({ row: row({ activityType: 'INTEREST', accountType: 'CASH' }) }).title).toContain('$54.20');
  });
});

describe('buildTxStory — the category line', () => {
  it('words each filer', () => {
    const line = (filer: Parameters<typeof encodeFiler>[0]) => story({ category: { name: 'Groceries', filer } }).answer[2];
    expect(line({ kind: 'rule', pattern: null })).toBe('Filed under Groceries by a rule (none of your current rules matches it).');
    expect(line({ kind: 'rule', pattern: null, unknown: true })).toBe('Filed under Groceries by a rule.');
    expect(line({ kind: 'you', at: at(4).toISOString() })).toBe('Filed under Groceries by you, in Telegram, Oct 4.');
    expect(line({ kind: 'amazon', label: 'Lawn & Garden' })).toBe('Filed under Groceries from an Amazon email.');
    expect(line({ kind: 'hand' })).toBe('Filed under Groceries — set by hand in Wealthfolio.');
    expect(line(null)).toBe('Filed under Groceries.');
  });

  it('says an unfiled row is on the needs-a-category list', () => {
    expect(story({ category: null }).answer[2]).toBe(TX_STORY_NOT_FILED);
    expect(story({ category: undefined, needsCategory: true }).answer[2]).toBe(TX_STORY_NOT_FILED);
  });

  it('in the app, points at Telegram only when a companion exists', () => {
    expect(story({ category: undefined, filerHint: 'telegram' }).answer[2]).toBe(TX_STORY_ASK_TELEGRAM);
    expect(story({ category: undefined, filerHint: 'wealthfolio' }).answer[2]).toBe(TX_STORY_SET_IN_WEALTHFOLIO);
  });

  it('lists what you told the sync, the skip list included', () => {
    const s = story({ overrides: ['noAutoFile', 'notTransfer'], skipped: true });
    expect(s.answer.at(-1)).toBe("You told the sync: not a transfer, don't file it automatically, don't import it.");
  });
});

describe('buildTxStory — missing and failed facts', () => {
  it('leaves out each line whose fact is missing', () => {
    const s = buildTxStory({ row: row() });
    expect(s.answer).toEqual([TX_STORY_SPENDING]);
    expect(s.history).toBeNull();
    expect(s.notes).toEqual([]);
  });

  const each: TxFactName[] = ['mapping', 'partner', 'category', 'rules', 'changeLog', 'overrides', 'overridesUnreadable', 'skipList'];
  it.each(each)('a failed %s read still tells the story, with a note', (fact) => {
    const s = story({ category: { name: 'Groceries', filer: { kind: 'hand' } }, failed: [fact] });
    expect(s.title).toBe('KROGER #415 · -$54.20 · Oct 4');
    expect(s.notes).toEqual([TX_FACT_NOTES[fact]]);
    if (fact === 'mapping') expect(s.answer).not.toContain('From your PNC Checking bank feed.');
    if (fact === 'partner') expect(s.answer).not.toContain(TX_STORY_SPENDING);
    if (fact === 'category') expect(s.answer.join(' ')).not.toContain('Filed under');
    if (fact === 'changeLog') expect(s.history).toBeNull();
    else expect(s.history).toEqual([]);
  });

  it('keeps bank text raw — escaping is the renderer’s job', () => {
    const s = story({ row: row({ note: 'SQ *COFFEE_CLUB [2] · TRN-1', accountName: "Joe's *Visa*" }) });
    expect(s.title).toBe('SQ *COFFEE_CLUB [2] · -$54.20 · Oct 4');
    expect(s.accountLine).toBe("Joe's *Visa*");
  });
});

describe('rule inference', () => {
  const r = (over: Partial<CategoryRuleLike>): CategoryRuleLike => ({ id: 'r', pattern: 'KROGER', categoryId: 'cat-gro', priority: 0, ...over });
  const target = { note: 'KROGER #415 · TRN-1', activityType: 'WITHDRAWAL', accountId: 'wf-chk', absCents: 5420 };

  it('names the one rule that matches', () => {
    expect(inferFilingRule([r({ id: 'a' })], target, 'cat-gro')?.id).toBe('a');
  });

  it('of several, names the one Wealthfolio applies first: highest priority, then the earlier-listed', () => {
    const rules = [r({ id: 'low', priority: 10 }), r({ id: 'high-1', pattern: 'kroger #', priority: 50 }), r({ id: 'high-2', priority: 50 })];
    expect(inferFilingRule(rules, target, 'cat-gro')?.id).toBe('high-1');
  });

  it('none when no current rule would file it under this category', () => {
    expect(inferFilingRule([r({ categoryId: 'cat-din' }), r({ pattern: 'TARGET' })], target, 'cat-gro')).toBeNull();
  });

  it('follows Wealthfolio’s matcher: account scope, type, amount, match kind', () => {
    expect(ruleMatchesRow(r({ isGlobal: false, accountId: 'wf-other' }), target)).toBe(false);
    expect(ruleMatchesRow(r({ activityType: 'DEPOSIT' }), target)).toBe(false);
    expect(ruleMatchesRow(r({ amountOp: 'gt', amountValue: '100' }), target)).toBe(false);
    expect(ruleMatchesRow(r({ amountOp: 'between', amountValue: 50, amountValue2: '60' }), target)).toBe(true);
    expect(ruleMatchesRow(r({ matchType: 'starts_with', pattern: 'kroger' }), target)).toBe(true);
    expect(ruleMatchesRow(r({ matchType: 'exact' }), target)).toBe(false);
    expect(ruleMatchesRow(r({ matchType: 'regex', pattern: '^KROGER #\\d+' }), target)).toBe(true);
    expect(ruleMatchesRow(r({ matchType: 'regex', pattern: '(' }), target)).toBe(false);
  });
});

describe('resolveFiler', () => {
  const rowFor = (note = 'KROGER #415 · TRN-1') => ({ note, activityType: 'WITHDRAWAL', accountId: 'wf-chk', absCents: 5420 });
  const filedBy = (actor: 'you' | 'auto', day: number, categoryId = 'cat-gro', why?: string) => item(categoryFiledChange({
    actor, activityId: 'act-1', description: 'KROGER #415', before: null,
    after: { categoryId, categoryName: 'Groceries' }, ...(why ? { why } : {}),
  }), day);

  it('a rule’s filing names the inferred rule, or says none matches, or that rules were unreadable', () => {
    const rules = [{ id: 'a', pattern: 'KROGER', categoryId: 'cat-gro' }];
    expect(resolveFiler({ source: 'rule', categoryId: 'cat-gro', row: rowFor(), history: [], rules })).toEqual({ kind: 'rule', pattern: 'KROGER' });
    expect(resolveFiler({ source: 'RULE', categoryId: 'cat-din', row: rowFor(), history: [], rules })).toEqual({ kind: 'rule', pattern: null });
    expect(resolveFiler({ source: 'rule', categoryId: 'cat-gro', row: rowFor(), history: [], rules: null })).toEqual({ kind: 'rule', pattern: null, unknown: true });
  });

  it('a person’s filing is the newest log entry that set this category', () => {
    const history = [filedBy('auto', 2, 'cat-gro', 'Amazon: Grocery'), filedBy('you', 6)];
    expect(resolveFiler({ source: 'manual', categoryId: 'cat-gro', row: rowFor(), history, rules: null }))
      .toEqual({ kind: 'you', at: at(6).toISOString() });
    expect(resolveFiler({ source: 'manual', categoryId: 'cat-gro', row: rowFor(), history: [filedBy('auto', 2, 'cat-gro', 'Amazon: Grocery')], rules: null }))
      .toEqual({ kind: 'amazon', label: 'Grocery' });
  });

  it('falls back to the note’s Amazon label, then to "by hand", and to nothing when the log was unreadable', () => {
    const labelled = rowFor('AMAZON MKTPL*2K4 · Amazon: Lawn & Garden · TRN-1');
    expect(resolveFiler({ source: 'manual', categoryId: 'cat-gro', row: labelled, history: [], rules: null })).toEqual({ kind: 'amazon', label: 'Lawn & Garden' });
    expect(resolveFiler({ source: 'manual', categoryId: 'cat-gro', row: rowFor(), history: [], rules: null })).toEqual({ kind: 'hand' });
    expect(resolveFiler({ source: 'manual', categoryId: 'cat-gro', row: rowFor(), history: null, rules: null })).toBeNull();
  });

  it('an opening balance the companion filed', () => {
    const opening = item(openingBalanceFiledChange({
      account: CHECKING, activityId: 'act-1', amountCents: -100, date: '2026-05-01',
      category: { categoryId: 'cat-open', categoryName: 'Opening balances' },
    }), 3);
    expect(resolveFiler({ source: 'manual', categoryId: 'cat-open', row: rowFor('Starting balance · ACT-chk'), history: [opening], rules: null }))
      .toEqual({ kind: 'opening' });
  });

  it('a cube "you" takes its day from the log', () => {
    expect(withFilingDay({ kind: 'you' }, [filedBy('you', 4)])).toEqual({ kind: 'you', at: at(4).toISOString() });
    expect(withFilingDay({ kind: 'you' }, [])).toEqual({ kind: 'you' });
    expect(withFilingDay({ kind: 'hand' }, [filedBy('you', 4)])).toEqual({ kind: 'hand' });
  });
});

describe('filer codes for the report cube', () => {
  it('round-trip, short', () => {
    const filers = [
      { kind: 'rule', pattern: 'KROGER' }, { kind: 'rule', pattern: null }, { kind: 'rule', pattern: null, unknown: true },
      { kind: 'you' }, { kind: 'amazon', label: 'Lawn & Garden' }, { kind: 'opening' }, { kind: 'hand' },
    ] as const;
    expect(filers.map((f) => encodeFiler(f))).toEqual(['r:KROGER', 'r', 'r?', 'y', 'a:Lawn & Garden', 'o', 'h']);
    for (const f of filers) expect(decodeFiler(encodeFiler(f))).toEqual(f);
  });

  it('decodes anything unknown, or nothing, as null', () => {
    expect(decodeFiler(undefined)).toBeNull();
    expect(decodeFiler('z')).toBeNull();
    expect(decodeFiler(7)).toBeNull();
    expect(encodeFiler(null)).toBeUndefined();
  });
});

describe('helpers', () => {
  it('splits the Amazon label off a description', () => {
    expect(splitAmazonLabel('AMAZON MKTPL*2K4 · Amazon: Lawn & Garden')).toEqual({ bare: 'AMAZON MKTPL*2K4', label: 'Lawn & Garden' });
    expect(splitAmazonLabel('KROGER')).toEqual({ bare: 'KROGER', label: null });
  });

  it('signs a row from its type', () => {
    expect(signedCents({ absCents: 100, activityType: 'WITHDRAWAL' })).toBe(-100);
    expect(signedCents({ absCents: 100, activityType: 'DEPOSIT' })).toBe(100);
    expect(signedCents({ absCents: 100, activityType: 'TRANSFER_OUT' })).toBe(-100);
  });

  it('an Amazon label change in the history reads as its summary', () => {
    const label = item(amazonLabelChange({
      account: CHECKING, txKey: 'k1', activityId: 'act-1', description: 'AMAZON MKTPL', amountCents: -5420, date: '2026-10-04',
      beforeNote: 'AMAZON MKTPL · TRN-1', afterNote: 'AMAZON MKTPL · Amazon: Toys · TRN-1', label: 'Toys',
    }), 5);
    expect(story({ history: [label] }).history).toEqual([{ entryId: label.id, line: 'Oct 5 · Added the Amazon label "Toys" to AMAZON MKTPL' }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/tx-story.test.ts`
Expected: FAIL — `./tx-story` cannot be resolved.

- [ ] **Step 3: Implement**

**Create `shared/tx-story.ts`:**

```ts
/**
 * shared/tx-story.ts
 *
 * "Why is this here?" — one transaction's story, told the same way in `/why`
 * and in the app: a title (description · signed amount · date, the account
 * below), a few plain lines that answer why — where it came from, what it is,
 * who filed it, what you told the sync — then "What happened", the change-log
 * entries about it, oldest first.
 *
 * Pure. Each host gathers what IT can see into `TxStoryFacts`
 * (companion/src/tx-story-host.ts, src/utils/tx-story.ts). Only the row is
 * required: a fact that is absent leaves its line out, and a read that FAILED
 * is named in `failed`, which leaves its line out and adds a note instead.
 *
 * Who filed a row is inferred honestly (`resolveFiler`): Wealthfolio records
 * THAT a rule filed it, not which rule, so the rule named is the one
 * Wealthfolio applies first among those that would file this row under this
 * category today — its rule list comes back highest priority first, and the
 * first wins a tie (upstream `match_compiled`, strict `>`).
 *
 * Every string returned is RAW. Telegram escapes bank and user text at render
 * and keeps it outside every `*…*`/`_…_`; the app renders it as text.
 */
import { amazonLabelOf, changeDay, changeMoney, type ChangeEntry } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import { changeLocalDay } from './change-view.js';
import { IN_TRANSIT_COMMENT_PREFIX } from './reconcile.js';
import {
  BALANCE_ADJUSTMENT_COMMENT_PREFIX, IN_TRANSIT_TIMEOUT_SECONDS, PENDING_SUFFIX, STARTING_BALANCE_COMMENT_PREFIX,
  isTransferType, txIdFromComment,
} from './sync-core.js';
import type { TxOverrideFlag } from './sync-overrides.js';
import { txDescription } from './tx-search.js';

// ── Copy ─────────────────────────────────────────────────────────────────

export const TX_STORY_NOT_FROM_FEED = 'Not from your bank feed — added in Wealthfolio by hand or from a file.';
export const TX_STORY_SPENDING = 'Spending.';
export const TX_STORY_MONEY_IN = 'Money in.';
export const TX_STORY_NOT_FILED = "Not filed yet — it's on your needs-a-category list.";
export const TX_STORY_ASK_TELEGRAM = 'Ask /why in Telegram to see who filed it.';
export const TX_STORY_SET_IN_WEALTHFOLIO = 'Category set in Wealthfolio.';
export const TX_STORY_NO_HISTORY = 'No changes in the last 90 days.';
export const TX_STORY_WHAT_HAPPENED = 'What happened';
export const TX_STORY_UNREACHABLE = "Couldn't reach Wealthfolio — try again.";
/** A Telegram button whose transaction no longer exists (a transfer link
 *  re-created it, or it was removed). */
export const TX_STORY_GONE = 'That transaction has changed since — search again with /why.';
/** The same, in the app, which has its own search box. */
export const TX_STORY_GONE_APP = 'That transaction has changed since — search for it again.';

/** Reads a host can fail, each with the note the story carries. */
export type TxFactName =
  | 'mapping' | 'partner' | 'category' | 'rules' | 'changeLog' | 'overrides' | 'overridesUnreadable' | 'skipList';

export const TX_FACT_NOTES: Record<TxFactName, string> = {
  mapping: "Couldn't read your account mapping just now, so where it came from is left out.",
  partner: "Couldn't read the other half of this transfer just now.",
  category: "Couldn't read its category just now.",
  rules: "Couldn't read your category rules just now, so the rule isn't named.",
  changeLog: "Couldn't read the change log just now.",
  overrides: "Couldn't read your overrides just now.",
  overridesUnreadable: "Your sync overrides can't be read, so any you set aren't shown.",
  skipList: "Couldn't read your skip list just now.",
};
const FACT_ORDER: readonly TxFactName[] = ['mapping', 'partner', 'category', 'rules', 'changeLog', 'overrides', 'overridesUnreadable', 'skipList'];

/** "You told the sync: …" — one phrase per override, and the skip list. */
export const TX_OVERRIDE_WORDS: Record<TxOverrideFlag | 'skipped', string> = {
  notTransfer: 'not a transfer',
  keepDuplicate: 'keep this duplicate',
  noAutoFile: "don't file it automatically",
  noAmazonLabel: 'no Amazon label',
  skipped: "don't import it",
};
const OVERRIDE_ORDER: ReadonlyArray<TxOverrideFlag | 'skipped'> = ['notTransfer', 'keepDuplicate', 'noAutoFile', 'noAmazonLabel', 'skipped'];

// ── Facts ────────────────────────────────────────────────────────────────

export interface TxStoryRow {
  activityId: string;
  /** The stored note, raw. */
  note: string;
  /** Unsigned cents: Wealthfolio's type carries the direction. */
  absCents: number;
  /** YYYY-MM-DD. */
  date: string;
  activityType: string;
  accountName: string;
  /** Wealthfolio account type (CASH, CREDIT_CARD, …); absent when unknown. */
  accountType?: string;
}

/** The other half of a linked transfer. */
export interface TxPartner {
  accountName: string;
  /** YYYY-MM-DD, when the host can see it. */
  date?: string;
}

/** Who put the category on. `rule.pattern` null: none of the current rules
 *  would file it; `unknown`: the rules could not be read. */
export type TxFiler =
  | { kind: 'rule'; pattern: string | null; unknown?: true }
  | { kind: 'you'; at?: string }
  | { kind: 'amazon'; label: string }
  | { kind: 'opening' }
  | { kind: 'hand' };

export interface TxStoryFacts {
  row: TxStoryRow;
  /** The SimpleFin account the row's account syncs from; null when the
   *  add-on does not sync that account. */
  feed?: { sfinAccountId: string } | null;
  /** The other half of a linked transfer; null when the row is not linked. */
  partner?: TxPartner | null;
  /** Its category; null when it has none. `filer` absent: can't be told. */
  category?: { name: string; filer?: TxFiler | null } | null;
  /** On the needs-a-category list — all the app knows of an unfiled row. */
  needsCategory?: boolean;
  /** The app cannot see a filing: where to send the reader. */
  filerHint?: 'telegram' | 'wealthfolio';
  /** What you told the sync about this transaction. */
  overrides?: readonly TxOverrideFlag[];
  /** On the skip list. */
  skipped?: boolean;
  /** Change-log entries about it (`changesForTransaction`), in any order. */
  history?: readonly ChangeLogItem[];
  /** Reads that failed. Each leaves its line out and adds a note. */
  failed?: readonly TxFactName[];
}

export interface TxStoryHistoryLine {
  entryId: string;
  /** `Oct 4 · <summary>`. */
  line: string;
}

export interface TxStory {
  /** `<description> · <signed amount> · <date>`. */
  title: string;
  accountLine: string;
  answer: string[];
  /** Oldest first. Null when the change log was not read. */
  history: TxStoryHistoryLine[] | null;
  notes: string[];
}

// ── Helpers both hosts use ───────────────────────────────────────────────

const OUTFLOW = new Set(['WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX']);

/** Money out: the spending types, and interest charged on a card. */
export function isOutflow(activityType: string, accountType?: string): boolean {
  const t = activityType.toUpperCase();
  return OUTFLOW.has(t) || (t === 'INTEREST' && (accountType ?? '').toUpperCase() === 'CREDIT_CARD');
}

/** Signed cents for a row: money out negative. */
export function signedCents(row: Pick<TxStoryRow, 'absCents' | 'activityType' | 'accountType'>): number {
  const abs = Math.abs(Math.round(row.absCents));
  return isOutflow(row.activityType, row.accountType) ? -abs : abs;
}

const AMAZON_MARK = ' · Amazon: ';

/** A description's own words and the Amazon label the sync appended. */
export function splitAmazonLabel(description: string): { bare: string; label: string | null } {
  const at = description.indexOf(AMAZON_MARK);
  if (at === -1) return { bare: description, label: null };
  const bare = description.slice(0, at);
  const label = amazonLabelOf(bare, description).trim();
  return { bare, label: label || null };
}

/** A Wealthfolio categorization rule, as much of it as decides a match. */
export interface CategoryRuleLike {
  id: string;
  pattern: string;
  /** `contains` (the default), `starts_with`, `exact`, `regex`. */
  matchType?: string | null;
  /** The taxonomy the rule files into (informational: category ids are
   *  unique across taxonomies, so inference compares the category). */
  taxonomyId?: string | null;
  categoryId: string | null;
  priority?: number | null;
  /** False: only `accountId`'s rows. */
  isGlobal?: boolean | null;
  accountId?: string | null;
  activityType?: string | null;
  /** On the unsigned amount: eq, gt, gte, lt, lte, between. */
  amountOp?: string | null;
  amountValue?: number | string | null;
  amountValue2?: number | string | null;
}

/** What a rule is matched against. */
export interface RuleRow {
  note: string;
  activityType: string;
  /** Wealthfolio account id. */
  accountId: string;
  absCents: number;
}

/** Wealthfolio's own matcher, transcribed (upstream `match_compiled`):
 *  account scope, activity type, the amount condition, then the pattern —
 *  case-insensitive except a regex, which a bad pattern never matches. */
export function ruleMatchesRow(rule: CategoryRuleLike, row: RuleRow): boolean {
  if (rule.isGlobal === false && rule.accountId !== row.accountId) return false;
  if (rule.activityType && rule.activityType.toUpperCase() !== row.activityType.toUpperCase()) return false;
  if (rule.amountOp) {
    const amount = Math.abs(row.absCents) / 100;
    const value = Number(rule.amountValue);
    if (rule.amountValue === null || rule.amountValue === undefined || !Number.isFinite(value)) return false;
    const upper = Number(rule.amountValue2);
    const ok = rule.amountOp === 'eq' ? amount === value
      : rule.amountOp === 'gt' ? amount > value
        : rule.amountOp === 'gte' ? amount >= value
          : rule.amountOp === 'lt' ? amount < value
            : rule.amountOp === 'lte' ? amount <= value
              : rule.amountOp === 'between' ? Number.isFinite(upper) && amount >= value && amount <= upper
                : false;
    if (!ok) return false;
  }
  const note = row.note;
  const pattern = rule.pattern ?? '';
  switch (rule.matchType ?? 'contains') {
    case 'starts_with': return note.toUpperCase().startsWith(pattern.toUpperCase());
    case 'exact': return note.toUpperCase() === pattern.toUpperCase();
    case 'regex':
      try {
        return new RegExp(pattern).test(note);
      } catch {
        return false;
      }
    default: return note.toUpperCase().includes(pattern.toUpperCase());
  }
}

/** The rule that would file this row under this category, the one Wealthfolio
 *  applies first: highest priority, the earlier-listed one on a tie (the list
 *  arrives priority-first, oldest-first). Null when none would. */
export function inferFilingRule(rules: readonly CategoryRuleLike[], row: RuleRow, categoryId: string): CategoryRuleLike | null {
  const ranked = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.categoryId === categoryId && ruleMatchesRow(rule, row))
    .sort((a, b) => ((b.rule.priority ?? 0) - (a.rule.priority ?? 0)) || a.index - b.index);
  return ranked[0]?.rule ?? null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const afterCategoryId = (e: ChangeEntry) => (isRecord(e.after) && typeof e.after.categoryId === 'string' ? e.after.categoryId : null);

export interface FilerInput {
  /** The assignment's `source` (`rule`, `manual`, …). */
  source: string | null | undefined;
  categoryId: string;
  row: RuleRow;
  /** Entries about this transaction; null when the log could not be read. */
  history: readonly ChangeEntry[] | null;
  /** The categorization rules, listed as Wealthfolio lists them; null when
   *  they could not be read. Only read for a rule's filing. */
  rules: readonly CategoryRuleLike[] | null;
}

/**
 * Who filed it. A rule's filing names the rule (`inferFilingRule`). Anything
 * else is the newest log entry that set THIS category — you in Telegram, the
 * Amazon email, the opening-balance filing — then the note's Amazon label;
 * failing all of those, a person set it in Wealthfolio. Null when that cannot
 * be told: the log was unreadable, and nothing else says.
 */
export function resolveFiler(f: FilerInput): TxFiler | null {
  if ((f.source ?? '').toLowerCase() === 'rule') {
    if (f.rules === null) return { kind: 'rule', pattern: null, unknown: true };
    const rule = inferFilingRule(f.rules, f.row, f.categoryId);
    return { kind: 'rule', pattern: rule ? rule.pattern : null };
  }
  const filing = [...(f.history ?? [])]
    .filter((e) => (e.kind === 'category-filed' || e.kind === 'opening-balance-filed') && afterCategoryId(e) === f.categoryId)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
  if (filing?.kind === 'opening-balance-filed') return { kind: 'opening' };
  if (filing?.actor === 'you') return { kind: 'you', at: filing.at };
  if (filing?.why?.startsWith('Amazon: ')) return { kind: 'amazon', label: filing.why.slice('Amazon: '.length) };
  const label = splitAmazonLabel(txDescription(f.row.note)).label;
  if (label) return { kind: 'amazon', label };
  if (f.history === null) return null;
  return { kind: 'hand' };
}

/** A filer from the report cube says "you" without a day: the day comes from
 *  the newest filing by you in the log, when there is one. */
export function withFilingDay(filer: TxFiler, history: readonly ChangeEntry[] | null | undefined): TxFiler {
  if (filer.kind !== 'you' || filer.at) return filer;
  const mine = [...(history ?? [])]
    .filter((e) => e.kind === 'category-filed' && e.actor === 'you' && afterCategoryId(e) !== null)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))[0];
  return mine ? { kind: 'you', at: mine.at } : filer;
}

/** The report cube's short code for a filer (`DrillTx.f`). */
export function encodeFiler(filer: TxFiler | null | undefined): string | undefined {
  if (!filer) return undefined;
  switch (filer.kind) {
    case 'rule': return filer.unknown ? 'r?' : filer.pattern === null ? 'r' : `r:${filer.pattern}`;
    case 'you': return 'y';
    case 'amazon': return `a:${filer.label}`;
    case 'opening': return 'o';
    case 'hand': return 'h';
  }
}

/** A cube code back to a filer; null for anything this build does not know. */
export function decodeFiler(code: unknown): TxFiler | null {
  if (typeof code !== 'string') return null;
  if (code === 'r?') return { kind: 'rule', pattern: null, unknown: true };
  if (code === 'r') return { kind: 'rule', pattern: null };
  if (code.startsWith('r:') && code.length > 2) return { kind: 'rule', pattern: code.slice(2) };
  if (code === 'y') return { kind: 'you' };
  if (code.startsWith('a:') && code.length > 2) return { kind: 'amazon', label: code.slice(2) };
  if (code === 'o') return { kind: 'opening' };
  if (code === 'h') return { kind: 'hand' };
  return null;
}

// ── The story ────────────────────────────────────────────────────────────

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function filedLine(name: string, filer: TxFiler | null | undefined): string {
  if (!filer) return `Filed under ${name}.`;
  switch (filer.kind) {
    case 'rule':
      return filer.unknown
        ? `Filed under ${name} by a rule.`
        : filer.pattern === null
          ? `Filed under ${name} by a rule (none of your current rules matches it).`
          : `Filed under ${name} by a rule — '${filer.pattern}' matches it.`;
    case 'you':
      return filer.at ? `Filed under ${name} by you, in Telegram, ${changeDay(changeLocalDay(filer.at))}.` : `Filed under ${name} by you, in Telegram.`;
    case 'amazon': return `Filed under ${name} from an Amazon email.`;
    case 'opening': return `Filed under ${name} by the add-on — an opening balance isn't spending.`;
    case 'hand': return `Filed under ${name} — set by hand in Wealthfolio.`;
  }
}

export function buildTxStory(facts: TxStoryFacts): TxStory {
  const { row } = facts;
  const failed = new Set(facts.failed ?? []);
  const note = row.note ?? '';
  const out = isOutflow(row.activityType, row.accountType);
  const description = txDescription(note) || 'A transaction';
  const held = note.startsWith(IN_TRANSIT_COMMENT_PREFIX);
  const starting = note.startsWith(STARTING_BALANCE_COMMENT_PREFIX);
  const correction = note.startsWith(BALANCE_ADJUSTMENT_COMMENT_PREFIX);
  const special = held || starting || correction;
  const linked = !!facts.partner;
  const answer: string[] = [];

  // 1. Where it came from.
  if (!special && !failed.has('mapping') && facts.feed !== undefined) {
    answer.push(facts.feed && txIdFromComment(note)
      ? `From your ${row.accountName} bank feed.${note.endsWith(PENDING_SUFFIX) ? ' Still pending.' : ''}`
      : TX_STORY_NOT_FROM_FEED);
  }

  // 2. What it is.
  if (held) {
    const until = changeDay(addDays(row.date, IN_TRANSIT_TIMEOUT_SECONDS / 86_400));
    answer.push(`A transfer the sync is holding: it waits until ${until} for its other half, then counts as ${out ? 'spending' : 'money in'}.`);
  } else if (starting) {
    answer.push(`The starting balance the add-on set so ${row.accountName} matches the bank from ${changeDay(row.date)}.`);
  } else if (correction) {
    const day = /(\d{4}-\d{2}-\d{2})$/.exec(note)?.[1] ?? row.date;
    answer.push(`A correction the add-on added on ${changeDay(day)} so ${row.accountName} matches the bank.`);
  } else if (!failed.has('partner')) {
    if (facts.partner) {
      const when = facts.partner.date ? `, ${changeDay(facts.partner.date)}` : '';
      answer.push(`Half of a transfer: ↔ ${changeMoney(Math.abs(row.absCents))} ${out ? 'into' : 'from'} ${facts.partner.accountName}${when}.`);
    } else if (facts.partner === null || !isTransferType(row.activityType.toUpperCase())) {
      answer.push(out ? TX_STORY_SPENDING : TX_STORY_MONEY_IN);
    }
  }

  // 3. Its category, and who filed it.
  if (!failed.has('category')) {
    const routine = !special && !linked && !isTransferType(row.activityType.toUpperCase());
    if (facts.category) answer.push(filedLine(facts.category.name, facts.category.filer));
    else if (facts.needsCategory || (facts.category === null && routine)) answer.push(TX_STORY_NOT_FILED);
    else if (facts.category === undefined && facts.filerHint && routine) {
      answer.push(facts.filerHint === 'telegram' ? TX_STORY_ASK_TELEGRAM : TX_STORY_SET_IN_WEALTHFOLIO);
    }
  }

  // 4. What you told the sync.
  const told = new Set<TxOverrideFlag | 'skipped'>([...(facts.overrides ?? []), ...(facts.skipped ? ['skipped' as const] : [])]);
  const words = OVERRIDE_ORDER.filter((w) => told.has(w)).map((w) => TX_OVERRIDE_WORDS[w]);
  if (words.length) answer.push(`You told the sync: ${words.join(', ')}.`);

  const history = failed.has('changeLog') || !facts.history
    ? null
    : [...facts.history]
      .sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at < b.at ? -1 : 1))
      .map((e) => ({ entryId: e.id, line: `${changeDay(changeLocalDay(e.at))} · ${e.summary}` }));

  return {
    title: `${description} · ${changeMoney(signedCents(row))} · ${changeDay(row.date)}`,
    accountLine: row.accountName,
    answer,
    history,
    notes: FACT_ORDER.filter((f) => failed.has(f)).map((f) => TX_FACT_NOTES[f]),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/tx-story.test.ts`
Expected: PASS — 38 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/tx-story.ts shared/tx-story.test.ts
git commit -m "Shared: a transaction's story — where it came from, what it is, who filed it, what happened

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The report cube says which transaction a drill row is, and who filed it

Budget drill-down rows become openable (spec B "Report cube", A3, W1b). The drill reader returns, beside what it did, the activity and account ids, the LEAF category id (a rule files into the leaf, not the rolled-up parent), the assignment's `source` and the activity type. The cube builder reads the categorization rules and the change log ONCE (a new optional `filingContext` dep — either may be null, and a rejecting one costs only the codes) and gives each kept row `i` (its activity id) and `f` (`encodeFiler(resolveFiler(…))`). A row without an id — an older reader — gets neither, so the app keeps it plain. `listCategorizationRules` now keeps every field Wealthfolio's matcher reads, in the server's order (W1c); its existing caller, Undo, reads only the fields it always did. The measured size (W1b) is pinned: a heavy cube with the longest codes on every row stays under 80% of the guard, so the drill cap stays 30. The shared test fixture's assignments table gains the real `source` column, which one Amazon test used to add by hand.

**Files:**
- Modify: `shared/report-cube.ts`, `companion/src/wealthfolio.ts`, `companion/src/sqlite-native.ts`, `companion/src/report-cube-build.ts`, `companion/src/index.ts`
- Test: `companion/src/report-cube-build.test.ts`, `companion/src/sqlite-native.test.ts`, `companion/src/wealthfolio-undo.test.ts`

**Interfaces:**
- Consumes: Task 1 (`changesForTransaction`); Task 2 (`encodeFiler`, `resolveFiler`, `CategoryRuleLike`); `txIdFromComment` (shared/sync-core.ts); `accountTxKey` (shared/transfers.ts); `readCompanionChangeLog` (companion/src/change-log-host.ts).
- Produces:

```ts
// shared/report-cube.ts
export interface DrillTx { d: string; n: string; c: number; a: string; i?: string; f?: string }
// companion/src/wealthfolio.ts
export interface WealthfolioRule extends CategoryRuleLike { name: string }
class WealthfolioClient { listCategorizationRules(): Promise<WealthfolioRule[]> }
// companion/src/sqlite-native.ts
export interface NativeDrillRow { category: string; date: string; notes: string; amount: number; account: string;
  activityId: string; accountId: string; categoryId: string; source: string; activityType: string }
export function getNativeDrillRows(dbPath: string, startInclusive: string, endExclusive: string): NativeDrillRow[];
// companion/src/report-cube-build.ts (CubeBuildDeps)
drillRows?(start: string, endEx: string): Array<{ category: string; date: string; notes: string; amount: number; account: string;
  activityId?: string; accountId?: string; categoryId?: string; source?: string; activityType?: string }>;
filingContext?(): Promise<{ rules: CategoryRuleLike[] | null; history: ChangeLogItem[] | null }>;
```

- [ ] **Step 1: Write the failing tests**

Edit 1 of 2 in `companion/src/report-cube-build.test.ts` — imports. Replace:

```ts
import { buildReportCube, type CubeBuildDeps } from './report-cube-build.js';
import { parseReportCube, REPORT_CUBE_MAX_BYTES } from '../../shared/report-cube.js';
import { emptySubscriptionPrefs } from '../../shared/subscription-prefs.js';
```

with:

```ts
import { buildReportCube, type CubeBuildDeps } from './report-cube-build.js';
import { parseReportCube, REPORT_CUBE_MAX_BYTES } from '../../shared/report-cube.js';
import { emptySubscriptionPrefs } from '../../shared/subscription-prefs.js';
import { categoryFiledChange, stampChange } from '../../shared/change-entries.js';
```

Edit 2 of 2 in `companion/src/report-cube-build.test.ts` — the who-filed-it tests, after the drill cap test. Replace:

```ts
    const cube = await buildReportCube(deps({ drillRows: vi.fn(() => many) }), NOW, 2);
    expect(cube.drill!.Dining.length).toBeLessThanOrEqual(30);
  });
```

with:

```ts
    const cube = await buildReportCube(deps({ drillRows: vi.fn(() => many) }), NOW, 2);
    expect(cube.drill!.Dining.length).toBeLessThanOrEqual(30);
  });

  it('carries each drill row’s activity id and a short code for who filed it (1.61)', async () => {
    const youFiled = stampChange(categoryFiledChange({
      actor: 'you', activityId: 'act-you', description: 'SWEETGREEN', before: null,
      after: { categoryId: 'cat-din', categoryName: 'Dining' },
    }), 'companion', new Date('2026-08-21T12:00:00Z'));
    const row = (activityId: string, notes: string, source: string, categoryId = 'cat-din') => ({
      category: 'Dining', date: '2026-08-20', notes, amount: 12.5, account: 'Card',
      activityId, accountId: 'acct-card', categoryId, source, activityType: 'WITHDRAWAL',
    });
    const cube = await buildReportCube(deps({
      drillRows: vi.fn(() => [
        row('act-rule', 'CHIPOTLE 1234 · TRN-1', 'rule'),
        row('act-you', 'SWEETGREEN · TRN-2', 'manual'),
        row('act-amz', 'AMAZON MKTPL · Amazon: Kitchen · TRN-3', 'manual'),
        row('act-hand', 'DINER · TRN-4', 'manual'),
        row('act-gone', 'TACO PLACE · TRN-5', 'rule'),
      ]),
      filingContext: vi.fn(async () => ({
        rules: [{ id: 'r1', pattern: 'CHIPOTLE', categoryId: 'cat-din', priority: 0 }],
        history: [youFiled],
      })),
    }), NOW, 2);
    expect(cube.drill!.Dining.map((r) => [r.i, r.f])).toEqual([
      ['act-rule', 'r:CHIPOTLE'],
      ['act-you', 'y'],
      ['act-amz', 'a:Kitchen'],
      ['act-hand', 'h'],
      ['act-gone', 'r'],
    ]);
  });

  it('says only "a rule" when the rules cannot be read, and builds the cube when nothing can', async () => {
    const drillRows = vi.fn(() => [{
      category: 'Dining', date: '2026-08-20', notes: 'CHIPOTLE · TRN-1', amount: 12.5, account: 'Card',
      activityId: 'act-1', accountId: 'acct-card', categoryId: 'cat-din', source: 'rule', activityType: 'WITHDRAWAL',
    }]);
    const unreadable = await buildReportCube(deps({ drillRows, filingContext: vi.fn(async () => ({ rules: null, history: null })) }), NOW, 2);
    expect(unreadable.drill!.Dining[0]).toMatchObject({ i: 'act-1', f: 'r?' });
    const failing = await buildReportCube(deps({ drillRows, filingContext: vi.fn(async () => { throw new Error('down'); }) }), NOW, 2);
    expect(failing.drill!.Dining[0]).toEqual({ d: '2026-08-20', n: 'CHIPOTLE', c: 1250, a: 'Card', i: 'act-1' });
  });

  it('an older reader’s rows carry neither field, so the app keeps them plain', async () => {
    const cube = await buildReportCube(deps({
      drillRows: vi.fn(() => [{ category: 'Dining', date: '2026-08-20', notes: 'CHIPOTLE · TRN-1', amount: 12.5, account: 'Card' }]),
      filingContext: vi.fn(async () => ({ rules: [], history: [] })),
    }), NOW, 2);
    expect(cube.drill!.Dining[0]).toEqual({ d: '2026-08-20', n: 'CHIPOTLE', c: 1250, a: 'Card' });
  });

  it('a heavy cube with every drill row carrying both fields stays under 80% of the size guard', async () => {
    // Measured for the plan: 24 months, 16 categories at the 30-row cap, six
    // accounts — 104,715 bytes without the two fields, 148,875 with these
    // (the longest) codes on every row: 74% of the guard.
    const categories = Array.from({ length: 16 }, (_, i) => `Category ${String.fromCharCode(65 + i)} & Co`);
    const accounts = Array.from({ length: 6 }, (_, i) => ({
      sfinId: `ACT-${i}f0b2c3d-4e5f-6071-8293-a4b5c6d7e8f9`, wfId: `wf-${i}`, name: `Account number ${i} (4937)`, type: i < 2 ? 'CASH' : 'CREDIT_CARD',
    }));
    const months = Array.from({ length: 24 }, (_, b) => new Date(Date.UTC(2026, 7 - 23 + b, 1)).toISOString().slice(0, 7));
    const heavy = deps({
      accountMeta: vi.fn(async () => accounts),
      spendMatrix: vi.fn(() => months.flatMap((month) => categories.flatMap((category, ci) => accounts.slice(0, 5).map((a, ai) => ({
        month, category, accountId: a.wfId, amount: 12.34 * (ci + ai + 1),
      }))))),
      incomeByMonthAccount: vi.fn(() => months.flatMap((month) => accounts.map((a) => ({ month, accountId: a.wfId, amount: 1234.56 })))),
      uncategorizedByMonthAccount: vi.fn(() => months.flatMap((month) => accounts.map((a) => ({ month, accountId: a.wfId, amount: 45.67 })))),
      budgetsForMonth: vi.fn(() => Object.fromEntries(categories.map((c) => [c, 250]))),
      merchantRows: vi.fn(() => months.flatMap((month) => Array.from({ length: 40 }, (_, i) => ({
        month, date: `${month}-${String((i % 27) + 1).padStart(2, '0')}`, notes: `POS PURCHASE SQ *HEINE BROTHERS COFF ${i} · TRN-${month}-${i}`, amount: 10 + i,
      })))),
      valuationByMonth: vi.fn(() => months.flatMap((month) => accounts.map((a) => ({ month, accountId: a.wfId, amount: 12345.67 })))),
      drillRows: vi.fn(() => categories.flatMap((category, ci) => Array.from({ length: 40 }, (_, i) => ({
        category, date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, notes: `POS PURCHASE CHIPOTLE 1234 LOUISVILLE KY · TRN-a1b2c3d4-${ci}-${i}`,
        amount: 12.34 + i, account: accounts[i % 5].name,
        activityId: `0f8fad5b-d9cb-469f-a165-7086772895${String(ci).padStart(2, '0')}`, accountId: accounts[i % 5].wfId,
        categoryId: `cat-${ci}`, source: 'rule', activityType: 'WITHDRAWAL',
      })))),
      filingContext: vi.fn(async () => ({
        rules: categories.map((_, ci) => ({ id: `r${ci}`, pattern: 'POS PURCHASE CHIPOTLE 1234 LOUISVILLE KY', categoryId: `cat-${ci}` })),
        history: [],
      })),
    });
    const cube = await buildReportCube(heavy, NOW);
    expect(cube.months).toHaveLength(24);
    expect(Object.values(cube.drill!).every((list) => list.length === 30 && list.every((r) => r.i && r.f))).toBe(true);
    expect(JSON.stringify(cube).length).toBeLessThanOrEqual(REPORT_CUBE_MAX_BYTES * 0.8);
  });
```

Edit 1 of 3 in `companion/src/sqlite-native.test.ts` — the fixture's assignments table gains the real `source` column. Replace:

```ts
    CREATE TABLE activity_taxonomy_assignments (activity_id TEXT, category_id TEXT, taxonomy_id TEXT);
```

with:

```ts
    CREATE TABLE activity_taxonomy_assignments (activity_id TEXT, category_id TEXT, taxonomy_id TEXT, source TEXT);
```

Edit 2 of 3 in `companion/src/sqlite-native.test.ts` — the Amazon test no longer adds the column the fixture now has. Replace:

```ts
          ALTER TABLE activity_taxonomy_assignments ADD COLUMN source TEXT;
          INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('c', 'Online Shopping', NULL);
```

with:

```ts
          INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('c', 'Online Shopping', NULL);
```

Edit 3 of 3 in `companion/src/sqlite-native.test.ts` — the drill reader's new fields. Replace:

```ts
      db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('d2', 'cat-shop')`);
      db.close();
      const rows = getNativeDrillRows(path, '2026-09-01', '2026-10-01');
      expect(rows.map((r) => r.category)).toEqual(['Shopping', 'Shopping']);
      expect(rows[0]).toMatchObject({ date: '2026-09-05', notes: 'TARGET · TRN-2', amount: 25 });
      expect(rows[1]).toMatchObject({ date: '2026-09-02', notes: 'ZARA 123 · TRN-1', amount: 40, account: 'Spend' });
```

with:

```ts
      db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id, source) VALUES ('d2', 'cat-shop', 'rule')`);
      db.close();
      const rows = getNativeDrillRows(path, '2026-09-01', '2026-10-01');
      expect(rows.map((r) => r.category)).toEqual(['Shopping', 'Shopping']);
      expect(rows[0]).toMatchObject({ date: '2026-09-05', notes: 'TARGET · TRN-2', amount: 25 });
      expect(rows[1]).toMatchObject({ date: '2026-09-02', notes: 'ZARA 123 · TRN-1', amount: 40, account: 'Spend' });
      // 1.61: what the cube needs to say who filed each row — the leaf
      // category, not the rolled-up one, and the assignment's source.
      expect(rows[0]).toMatchObject({
        activityId: 'd2', accountId: 'acct-card', categoryId: 'cat-shop', source: 'rule', activityType: 'WITHDRAWAL',
      });
      expect(rows[1]).toMatchObject({ activityId: 'd1', accountId: 'acct-cash', categoryId: 'cat-cloth', source: '' });
```

Edit 1 of 1 in `companion/src/wealthfolio-undo.test.ts` — the rule list now carries what rule inference reads. Replace:

```ts
    expect(await new WealthfolioClient('http://wf').listCategorizationRules()).toEqual([
      { id: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro' },
      { id: 'rule-8', name: 'Preset', pattern: 'X', categoryId: null },
    ]);
```

with:

```ts
    expect(await new WealthfolioClient('http://wf').listCategorizationRules()).toEqual([
      { id: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro', matchType: 'contains', priority: 50 },
      { id: 'rule-8', name: 'Preset', pattern: 'X', categoryId: null },
    ]);
  });

  it('keeps every field Wealthfolio’s matcher reads, in the order the server lists the rules', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([
        {
          id: 'r-1', name: 'Big rent', pattern: 'RENT', matchType: 'starts_with', taxonomyId: 'spending_categories',
          categoryId: 'cat-home', activityType: 'WITHDRAWAL', amountOp: 'between', amountValue: '900', amountValue2: '1500.50',
          priority: 90, isGlobal: false, accountId: 'wf-chk', presetModified: false,
        },
        { id: 'r-2', name: 'Older', pattern: 'X', categoryId: 'cat-x', priority: 90 },
      ]),
    });
    expect(await new WealthfolioClient('http://wf').listCategorizationRules()).toEqual([
      {
        id: 'r-1', name: 'Big rent', pattern: 'RENT', matchType: 'starts_with', taxonomyId: 'spending_categories',
        categoryId: 'cat-home', activityType: 'WITHDRAWAL', amountOp: 'between', amountValue: '900', amountValue2: '1500.50',
        priority: 90, isGlobal: false, accountId: 'wf-chk',
      },
      { id: 'r-2', name: 'Older', pattern: 'X', categoryId: 'cat-x', priority: 90 },
    ]);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/report-cube-build.test.ts src/sqlite-native.test.ts src/wealthfolio-undo.test.ts`
Expected: FAIL — 6 tests: the three new cube tests (no `i`/`f` on the rows), the drill reader's new fields, and both rule-list tests (`matchType`/`priority` dropped).

- [ ] **Step 3: Implement**

Edit 1 of 1 in `shared/report-cube.ts` — `DrillTx` gains `i` and `f`. Replace:

```ts
  /** Account name. */
  a: string;
}
```

with:

```ts
  /** Account name. */
  a: string;
  /** 1.61: the activity id — the row opens its story. Absent from an older
   *  companion's cube, whose rows then stay plain. */
  i?: string;
  /** 1.61: who filed it, as `encodeFiler` (shared/tx-story.ts) writes it:
   *  `r:<pattern>`, `r` (no current rule matches), `r?` (rules unreadable),
   *  `y` (you, in Telegram), `a:<label>` (an Amazon email), `o` (the
   *  opening-balance filing), `h` (by hand in Wealthfolio). */
  f?: string;
}
```

Edit 1 of 2 in `companion/src/wealthfolio.ts` — the import of the rule shape. Replace:

```ts
export interface ActivitySearchItem {
```

with:

```ts
import type { CategoryRuleLike } from '../../shared/tx-story.js';

/** A categorization rule as `GET /spending/rules` lists it (upstream
 *  `CategorizationRule`, camelCase): what Undo needs and what rule inference
 *  (shared/tx-story.ts) reads. Optional fields are absent when the server did
 *  not send them. */
export interface WealthfolioRule extends CategoryRuleLike {
  name: string;
}

export interface ActivitySearchItem {
```

Edit 2 of 2 in `companion/src/wealthfolio.ts` — `listCategorizationRules` keeps the matcher's fields. Replace:

```ts
  /** Every categorization rule (`GET /spending/rules`, `Vec<CategorizationRule>`):
   *  how an Undo finds a rule the log knows only by name. */
  async listCategorizationRules(): Promise<Array<{ id: string; name: string; pattern: string; categoryId: string | null }>> {
    const res = await fetch(`${this.baseUrl}/api/v1/spending/rules`, { headers: this.authHeaders() });
    if (!res.ok) throw await this.httpError('listCategorizationRules', res);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string')
      .map((r) => ({
        id: r.id as string,
        name: typeof r.name === 'string' ? r.name : '',
        pattern: typeof r.pattern === 'string' ? r.pattern : '',
        categoryId: typeof r.categoryId === 'string' ? r.categoryId : null,
      }));
  }
```

with:

```ts
  /** Every categorization rule (`GET /spending/rules`, `Vec<CategorizationRule>`):
   *  how an Undo finds a rule the log knows only by name, and what "which rule
   *  filed this" is inferred from. Kept in the server's order — priority
   *  first, then oldest first — which is the order Wealthfolio applies them in
   *  (upstream `CategorizationRulesRepository::list`). */
  async listCategorizationRules(): Promise<WealthfolioRule[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/spending/rules`, { headers: this.authHeaders() });
    if (!res.ok) throw await this.httpError('listCategorizationRules', res);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return [];
    const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string')
      .map((r) => {
        const rule: WealthfolioRule = {
          id: r.id as string,
          name: typeof r.name === 'string' ? r.name : '',
          pattern: typeof r.pattern === 'string' ? r.pattern : '',
          categoryId: typeof r.categoryId === 'string' ? r.categoryId : null,
        };
        if (text(r.matchType)) rule.matchType = text(r.matchType);
        if (text(r.taxonomyId)) rule.taxonomyId = text(r.taxonomyId);
        if (text(r.activityType)) rule.activityType = text(r.activityType);
        if (text(r.amountOp)) rule.amountOp = text(r.amountOp);
        if (typeof r.amountValue === 'string' || typeof r.amountValue === 'number') rule.amountValue = r.amountValue;
        if (typeof r.amountValue2 === 'string' || typeof r.amountValue2 === 'number') rule.amountValue2 = r.amountValue2;
        if (typeof r.priority === 'number') rule.priority = r.priority;
        if (typeof r.isGlobal === 'boolean') rule.isGlobal = r.isGlobal;
        if (text(r.accountId)) rule.accountId = text(r.accountId);
        return rule;
      });
  }
```

Edit 1 of 1 in `companion/src/sqlite-native.ts` — the drill reader returns what says who filed each row. Replace:

```ts
/**
 * Drill-down rows: every categorized spending transaction in the window under
 * its ROLLED-UP category — the same SPENDING_FROM / SPENDING_CATEGORY / sign
 * definition the spend matrix uses, so a category's list always sums to the
 * bar the user clicked. Newest first; the cube builder caps per category.
 */
export function getNativeDrillRows(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): Array<{ category: string; date: string; notes: string; amount: number; account: string }> {
  if (!dbPath || !existsSync(dbPath)) return [];
  if (!validDateBounds(startInclusive, endExclusive)) return [];
  const query = `
    SELECT ${SPENDING_CATEGORY} as category,
           date(a.activity_date) as date,
           COALESCE(acc.name, '') as account,
           ROUND(${SPENDING_SIGNED_AMOUNT}, 2) as amount,
           COALESCE(a.notes, '') as notes
    ${SPENDING_FROM}
    ${spendingWhere(startInclusive, endExclusive)}
    ORDER BY a.activity_date DESC, a.id;
  `;
  const rows = queryNativeDb<Record<string, unknown>>(
    dbPath,
    'drill rows',
    query,
    (parts) => (parts.length === 5
      ? { c0: parts[0], c1: parts[1], c2: parts[2], c3: parseFloat(parts[3]) || 0, c4: parts[4] }
      : null),
  );
  return rows.map((r) => {
    const v = Object.values(r) as [string, string, string, number | string, string];
    return {
      category: String(v[0]),
      date: String(v[1]),
      account: String(v[2]),
      amount: typeof v[3] === 'number' ? v[3] : parseFloat(String(v[3])) || 0,
      notes: String(v[4]),
    };
  }).filter((r) => r.category !== '');
}
```

with:

```ts
/** One drill-down row. Since 1.61 it carries what the cube needs to open the
 *  row's story and say who filed it: the activity and account ids, the LEAF
 *  category id (a rule files into it, not into the rolled-up parent), the
 *  assignment's source ('' when unrecorded) and the activity type. */
export interface NativeDrillRow {
  category: string;
  date: string;
  notes: string;
  amount: number;
  account: string;
  activityId: string;
  accountId: string;
  categoryId: string;
  source: string;
  activityType: string;
}

/**
 * Drill-down rows: every categorized spending transaction in the window under
 * its ROLLED-UP category — the same SPENDING_FROM / SPENDING_CATEGORY / sign
 * definition the spend matrix uses, so a category's list always sums to the
 * bar the user clicked. Newest first; the cube builder caps per category.
 */
export function getNativeDrillRows(
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): NativeDrillRow[] {
  if (!dbPath || !existsSync(dbPath)) return [];
  if (!validDateBounds(startInclusive, endExclusive)) return [];
  // Notes LAST: free text is the one column a stray `|` can split in the CLI
  // fallback, and only trailing columns are safe from it.
  const query = `
    SELECT ${SPENDING_CATEGORY} as category,
           date(a.activity_date) as date,
           COALESCE(acc.name, '') as account,
           ROUND(${SPENDING_SIGNED_AMOUNT}, 2) as amount,
           a.id as activity_id,
           COALESCE(a.account_id, '') as account_id,
           COALESCE(ata.category_id, '') as category_id,
           COALESCE(ata.source, '') as source,
           UPPER(COALESCE(a.activity_type, '')) as activity_type,
           COALESCE(a.notes, '') as notes
    ${SPENDING_FROM}
    ${spendingWhere(startInclusive, endExclusive)}
    ORDER BY a.activity_date DESC, a.id;
  `;
  const rows = queryNativeDb<Record<string, unknown>>(
    dbPath,
    'drill rows',
    query,
    (parts) => (parts.length >= 10
      ? {
          c0: parts[0], c1: parts[1], c2: parts[2], c3: parseFloat(parts[3]) || 0, c4: parts[4], c5: parts[5],
          c6: parts[6], c7: parts[7], c8: parts[8], c9: parts.slice(9).join('|'),
        }
      : null),
  );
  return rows.map((r) => {
    const v = Object.values(r) as Array<string | number>;
    return {
      category: String(v[0]),
      date: String(v[1]),
      account: String(v[2]),
      amount: typeof v[3] === 'number' ? v[3] : parseFloat(String(v[3])) || 0,
      activityId: String(v[4] ?? ''),
      accountId: String(v[5] ?? ''),
      categoryId: String(v[6] ?? ''),
      source: String(v[7] ?? ''),
      activityType: String(v[8] ?? ''),
      notes: String(v[9] ?? ''),
    };
  }).filter((r) => r.category !== '');
}
```

Edit 1 of 3 in `companion/src/report-cube-build.ts` — imports. Replace:

```ts
import { descriptionFromComment } from '../../shared/sync-core.js';
```

with:

```ts
import { descriptionFromComment, txIdFromComment } from '../../shared/sync-core.js';
import type { ChangeLogItem } from '../../shared/change-log.js';
import { changesForTransaction } from '../../shared/change-view.js';
import { accountTxKey } from '../../shared/transfers.js';
import { encodeFiler, resolveFiler, type CategoryRuleLike } from '../../shared/tx-story.js';
```

Edit 2 of 3 in `companion/src/report-cube-build.ts` — the drill rows' new fields and the filing context. Replace:

```ts
  /** Newest-month transactions per rolled-up category (getNativeDrillRows).
   *  Optional so an older binding keeps building cubes without drill-down. */
  drillRows?(start: string, endEx: string):
    Array<{ category: string; date: string; notes: string; amount: number; account: string }>;
```

with:

```ts
  /** Newest-month transactions per rolled-up category (getNativeDrillRows).
   *  Optional so an older binding keeps building cubes without drill-down. The
   *  ids, leaf category, source and type (1.61) are optional too: a row
   *  without an activity id gets neither `i` nor `f`. */
  drillRows?(start: string, endEx: string): Array<{
    category: string; date: string; notes: string; amount: number; account: string;
    activityId?: string; accountId?: string; categoryId?: string; source?: string; activityType?: string;
  }>;
  /** What says who filed a drill row (1.61): the categorization rules in the
   *  server's order, and the change log — each null when it could not be
   *  read. Optional; absent or rejecting, rows carry `i` but no `f`. */
  filingContext?(): Promise<{ rules: CategoryRuleLike[] | null; history: ChangeLogItem[] | null }>;
```

Edit 3 of 3 in `companion/src/report-cube-build.ts` — each drill row gets `i` and `f`. Replace:

```ts
  if (drillSource) {
    const byCat: Record<string, DrillTxLike[]> = {};
    for (const r of [...drillSource].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))) {
      const list = byCat[r.category] ?? (byCat[r.category] = []);
      if (list.length >= DRILL_ROWS_PER_CATEGORY) continue;
      list.push({ d: r.date, n: descriptionFromComment(r.notes) || r.notes, c: cents(r.amount), a: r.account });
    }
    drill = byCat;
  }
```

with:

```ts
  if (drillSource) {
    // Who filed each row: the rules and the log are read ONCE for the list.
    // A failed read costs the codes it feeds, never the cube.
    const filing = drillSource.some((r) => r.activityId && r.categoryId)
      ? await deps.filingContext?.().catch(() => null) ?? null
      : null;
    const filings = filing?.history
      ? filing.history.filter((e) => e.kind === 'category-filed' || e.kind === 'opening-balance-filed')
      : null;
    const sfinOf = new Map(meta.map((a) => [a.wfId, a.sfinId]));
    const filerCode = (r: (typeof drillSource)[number]): string | undefined => {
      if (!filing || !r.activityId || !r.categoryId) return undefined;
      const sfin = r.accountId ? sfinOf.get(r.accountId) : undefined;
      const txId = txIdFromComment(r.notes);
      return encodeFiler(resolveFiler({
        source: r.source ?? null,
        categoryId: r.categoryId,
        row: { note: r.notes, activityType: r.activityType ?? '', accountId: r.accountId ?? '', absCents: Math.abs(cents(r.amount)) },
        history: filings && changesForTransaction(filings, {
          activityIds: [r.activityId], txKeys: sfin && txId ? [accountTxKey(sfin, txId)] : [],
        }),
        rules: filing.rules,
      }));
    };
    const byCat: Record<string, DrillTxLike[]> = {};
    for (const r of [...drillSource].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))) {
      const list = byCat[r.category] ?? (byCat[r.category] = []);
      if (list.length >= DRILL_ROWS_PER_CATEGORY) continue;
      const f = filerCode(r);
      list.push({
        d: r.date, n: descriptionFromComment(r.notes) || r.notes, c: cents(r.amount), a: r.account,
        ...(r.activityId ? { i: r.activityId } : {}),
        ...(f ? { f } : {}),
      });
    }
    drill = byCat;
  }
```

Edit 1 of 1 in `companion/src/index.ts` — `cubeBuildDeps` binds the filing context. Replace:

```ts
    drillRows: (s, e) => getNativeDrillRows(dbPath, s, e),
```

with:

```ts
    drillRows: (s, e) => getNativeDrillRows(dbPath, s, e),
    // Who filed each drill row (1.61). Each read on its own: an unreadable
    // rule list still lets the log say "you", and the reverse.
    filingContext: async () => ({
      rules: await Promise.resolve().then(() => wfClient.listCategorizationRules()).catch(() => null),
      history: await readCompanionChangeLog(wfClient, new Date()).then((r) => r.entries).catch(() => null),
    }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run src/report-cube-build.test.ts src/sqlite-native.test.ts src/wealthfolio-undo.test.ts src/index.test.ts`
Expected: PASS — 391 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/report-cube.ts companion/src/wealthfolio.ts companion/src/sqlite-native.ts companion/src/report-cube-build.ts companion/src/index.ts companion/src/report-cube-build.test.ts companion/src/sqlite-native.test.ts companion/src/wealthfolio-undo.test.ts
git commit -m "Companion: budget drill-down rows carry their transaction and who filed it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The companion gathers a story's facts, and searches all of history

`companion/src/tx-story-host.ts` (spec B "Companion", C1, C2, C4, W5). `companionTxStory` reads the row by REST (`activityIdFilter`); the row failing is the only full failure, and a row that is not there is `gone`. Everything else is wrapped, each failure a note: the mapping (which SimpleFin account, so the account-scoped key), the category and its `source` with the account type (one strict database read — the spending assignment, else the first), the other half of a link (the other activity in the row's `source_group_id`), the rules (only for a rule's filing), the change log (`changesForTransaction`), the overrides (`loadSyncOverrides` — unparseable is `overridesUnreadable`, never "none") and the skip list. `companionTxSearch` searches every activity in the database; when the database cannot be read it reads the last 12 months over REST and says so (`recentOnly`). The database readers are STRICT: `queryNativeDb` keeps answering `[]` for its many callers, over a new `tryQueryNativeDb` that returns null when every path failed, and three new readers throw `NativeDbUnreadableError` instead. All reads sit behind `StoryReaders`, so the tests fake each in its real shape.

**Files:**
- Create: `companion/src/tx-story-host.ts`, `companion/src/tx-story-host.test.ts`, `companion/src/sqlite-native-story.test.ts`
- Modify: `companion/src/sqlite-native.ts`, `companion/src/wealthfolio.ts`

**Interfaces:**
- Consumes: Task 1 (`changesForTransaction`, `findTransactions`, `txDescription`, `TX_SEARCH_RECENT_DAYS`, `TxQuery`, `TxSearchResult`, `TxSearchRow`); Task 2 (`buildTxStory`, `isOutflow`, `resolveFiler`, `signedCents`, `CategoryRuleLike`, `TxFactName`, `TxStory`, `TxStoryFacts`, `TxStoryRow`); Task 3 (`WealthfolioRule`); `loadSyncOverrides`, `hasTxOverride`, `TX_OVERRIDE_FLAGS` (shared/sync-overrides.ts); `parseSkippedTransactions`, `SKIPPED_TRANSACTIONS_SECRET_KEY`; `readCompanionChangeLog`, `SecretClient` (change-log-host.ts).
- Produces:

```ts
// companion/src/sqlite-native.ts
export class NativeDbUnreadableError extends Error {}
export interface NativeTxAssignment { taxonomyId: string; categoryId: string; categoryName: string; source: string }
export function getNativeTxDetails(dbPath: string, activityId: string): { accountType: string; assignments: NativeTxAssignment[] };
export function getNativeTxPartner(dbPath: string, groupId: string, activityId: string): { activityId: string; accountName: string; date: string } | null;
export interface NativeTxSearchRow { activityId: string; date: string; absCents: number; activityType: string; accountName: string; accountType: string; notes: string }
export function getNativeTxSearchRows(dbPath: string): NativeTxSearchRow[];
// companion/src/wealthfolio.ts
interface ActivitySearchItem { /* … */ accountName?: string | null }
searchActivities(body: { /* … */ activityIdFilter?: string[] }): Promise<ActivitySearchItem[]>;
// companion/src/tx-story-host.ts
export interface StoryReaders {
  row(activityId: string): Promise<ActivitySearchItem | null>;
  details(activityId: string): { accountType: string; assignments: NativeTxAssignment[] };
  partner(groupId: string, activityId: string): { activityId: string; accountName: string; date: string } | null;
  rules(): Promise<CategoryRuleLike[]>;
  changeLog(now: Date): Promise<ChangeLogRead>;
  secret(key: string): Promise<string | null>;
  searchRows(): NativeTxSearchRow[];
  recentRows(dateFrom: string): Promise<ActivitySearchItem[]>;
}
export type StoryClient = SecretClient & Pick<WealthfolioClient, 'searchActivities' | 'listCategorizationRules'>;
export function companionStoryReaders(client: StoryClient, dbPath: string): StoryReaders;
export type StoryOutcome = { kind: 'ok'; story: TxStory; facts: TxStoryFacts } | { kind: 'gone' } | { kind: 'unreachable' };
export function companionTxStory(readers: StoryReaders, activityId: string, now: Date): Promise<StoryOutcome>;
export type SearchOutcome = { kind: 'ok'; result: TxSearchResult; recentOnly: boolean } | { kind: 'unreachable' };
export function companionTxSearch(readers: StoryReaders, query: TxQuery, now: Date): Promise<SearchOutcome>;
```

- [ ] **Step 1: Write the failing tests**

**Create `companion/src/sqlite-native-story.test.ts`:**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getNativeTxDetails, getNativeTxPartner, getNativeTxSearchRows, NativeDbUnreadableError } from './sqlite-native.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real tables and column names, only the columns these readers touch. */
function ledger(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-story-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT, is_archived BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE activities (id TEXT PRIMARY KEY, account_id TEXT, activity_type TEXT, activity_date TEXT, amount TEXT, notes TEXT, source_group_id TEXT);
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, taxonomy_id TEXT, name TEXT, parent_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (id TEXT, activity_id TEXT, taxonomy_id TEXT, category_id TEXT, weight INTEGER, source TEXT);
    INSERT INTO accounts VALUES ('wf-chk', 'PNC Checking', 'CASH', 0), ('wf-ally', 'Ally Savings', 'CASH', 0), ('wf-old', 'Closed card', 'CREDIT_CARD', 1);
    INSERT INTO activities VALUES
      ('act-1', 'wf-chk', 'WITHDRAWAL', '2026-10-04T04:00:00+00:00', '54.20', 'KROGER #415 · TRN-1', NULL),
      ('act-2', 'wf-chk', 'TRANSFER_OUT', '2026-10-05T04:00:00+00:00', '600', 'TRANSFER TO ALLY · TRN-2', 'wf-transfer-9'),
      ('act-3', 'wf-ally', 'TRANSFER_IN', '2026-10-06T04:00:00+00:00', '600', 'TRANSFER FROM PNC · TRN-3', 'wf-transfer-9'),
      ('act-4', 'wf-old', 'WITHDRAWAL', '2026-09-01T04:00:00+00:00', '9.99', 'OLD CARD THING · TRN-4', NULL);
    INSERT INTO taxonomy_categories VALUES ('cat-gro', 'spending_categories', 'Groceries', NULL), ('inc-sal', 'income_sources', 'Salary', NULL);
    INSERT INTO activity_taxonomy_assignments VALUES
      ('x1', 'act-1', 'income_sources', 'inc-sal', 10000, 'manual'),
      ('x2', 'act-1', 'spending_categories', 'cat-gro', 10000, 'rule');
  `);
  db.close();
  return path;
}

describe('getNativeTxDetails', () => {
  it('reads every assignment with its category name and source, and the account type', () => {
    expect(getNativeTxDetails(ledger(), 'act-1')).toEqual({
      accountType: 'CASH',
      assignments: [
        { taxonomyId: 'income_sources', categoryId: 'inc-sal', categoryName: 'Salary', source: 'manual' },
        { taxonomyId: 'spending_categories', categoryId: 'cat-gro', categoryName: 'Groceries', source: 'rule' },
      ],
    });
  });

  it('a row with no category has no assignments; quotes in an id are text', () => {
    expect(getNativeTxDetails(ledger(), 'act-2')).toEqual({ accountType: 'CASH', assignments: [] });
    expect(getNativeTxDetails(ledger(), "act-1' OR '1'='1")).toEqual({ accountType: '', assignments: [] });
  });

  it('throws — unknown, never "none" — without the database', () => {
    expect(() => getNativeTxDetails('/nope/wealthfolio.db', 'act-1')).toThrow(/Could not read the Wealthfolio database/);
  });
});

describe('getNativeTxPartner', () => {
  it('finds the other activity in the same group', () => {
    expect(getNativeTxPartner(ledger(), 'wf-transfer-9', 'act-2')).toEqual({ activityId: 'act-3', accountName: 'Ally Savings', date: '2026-10-06' });
  });

  it('is null when nothing else shares the group, and throws without the database', () => {
    expect(getNativeTxPartner(ledger(), 'wf-transfer-none', 'act-2')).toBeNull();
    expect(() => getNativeTxPartner('', 'wf-transfer-9', 'act-2')).toThrow(/Could not read the Wealthfolio database/);
  });
});

describe('getNativeTxSearchRows', () => {
  it('lists all of history, newest first, leaving out archived accounts', () => {
    expect(getNativeTxSearchRows(ledger())).toEqual([
      { activityId: 'act-3', date: '2026-10-06', absCents: 60000, activityType: 'TRANSFER_IN', accountName: 'Ally Savings', accountType: 'CASH', notes: 'TRANSFER FROM PNC · TRN-3' },
      { activityId: 'act-2', date: '2026-10-05', absCents: 60000, activityType: 'TRANSFER_OUT', accountName: 'PNC Checking', accountType: 'CASH', notes: 'TRANSFER TO ALLY · TRN-2' },
      { activityId: 'act-1', date: '2026-10-04', absCents: 5420, activityType: 'WITHDRAWAL', accountName: 'PNC Checking', accountType: 'CASH', notes: 'KROGER #415 · TRN-1' },
    ]);
  });

  it('throws when the database cannot be read', () => {
    expect(() => getNativeTxSearchRows('/nope/wealthfolio.db')).toThrow(/Could not read the Wealthfolio database/);
    expect(() => getNativeTxSearchRows('')).toThrow(NativeDbUnreadableError);
  });
});
```

**Create `companion/src/tx-story-host.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { categoryFiledChange, importChange, stampChange } from '../../shared/change-entries.js';
import type { ChangeLogRead } from '../../shared/change-log.js';
import { SYNC_OVERRIDES_SECRET_KEY } from '../../shared/sync-overrides.js';
import { SKIPPED_TRANSACTIONS_SECRET_KEY } from '../../shared/skipped-transactions.js';
import { accountTxKey } from '../../shared/transfers.js';
import { TX_FACT_NOTES, TX_STORY_SPENDING } from '../../shared/tx-story.js';
import { parseTxQuery } from '../../shared/tx-search.js';
import { companionStoryReaders, companionTxSearch, companionTxStory, type StoryReaders } from './tx-story-host.js';
import type { ActivitySearchItem } from './wealthfolio.js';

const NOW = new Date('2026-10-13T16:00:00Z');
const KEY = accountTxKey('ACT-chk', 'TRN-1');

/** The REST row as `POST /activities/search` returns it (camelCase). */
const restRow = (over: Partial<ActivitySearchItem> = {}): ActivitySearchItem => ({
  id: 'act-1', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'WITHDRAWAL',
  date: '2026-10-04T04:00:00+00:00', amount: '54.20', comment: 'KROGER #415 · TRN-1', sourceGroupId: null, subtype: null, ...over,
});

const logOf = (...entries: ChangeLogRead['entries']): ChangeLogRead => ({ entries, gaps: [], trimmed: 0, unreadable: [] });
const imported = stampChange(importChange({
  account: { sfinId: 'ACT-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKey: KEY, activityId: 'act-1',
  description: 'KROGER #415', amountCents: -5420, date: '2026-10-04', pending: false, activityType: 'WITHDRAWAL',
}), 'companion', new Date('2026-10-04T12:00:00Z'));
const filedByYou = stampChange(categoryFiledChange({
  actor: 'you', activityId: 'act-1', description: 'KROGER #415', before: null, after: { categoryId: 'cat-gro', categoryName: 'Groceries' },
}), 'companion', new Date('2026-10-05T12:00:00Z'));

function readers(over: Partial<StoryReaders> = {}, secrets: Record<string, string | null> = {}): StoryReaders {
  const stored: Record<string, string | null> = {
    account_mapping: JSON.stringify({ 'ACT-chk': 'wf-chk', 'ACT-ally': 'wf-ally' }),
    [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify({ v: 1, tx: { [KEY]: { noAutoFile: true, at: '2026-10-06T00:00:00Z' } }, accounts: {} }),
    [SKIPPED_TRANSACTIONS_SECRET_KEY]: null,
    ...secrets,
  };
  return {
    row: vi.fn(async (id: string) => (id === 'act-1' ? restRow() : null)),
    details: vi.fn(() => ({
      accountType: 'CASH',
      assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-gro', categoryName: 'Groceries', source: 'rule' }],
    })),
    partner: vi.fn(() => null),
    rules: vi.fn(async () => [{ id: 'r1', name: 'Kroger', pattern: 'KROGER', matchType: 'contains', categoryId: 'cat-gro', priority: 0 }]),
    changeLog: vi.fn(async () => logOf(imported)),
    secret: vi.fn(async (key: string) => stored[key] ?? null),
    searchRows: vi.fn(() => []),
    recentRows: vi.fn(async () => []),
    ...over,
  };
}

describe('companionTxStory', () => {
  it('tells the whole story from REST, the database, the rules, the log and the settings', async () => {
    const out = await companionTxStory(readers(), 'act-1', NOW);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.story.title).toBe('KROGER #415 · -$54.20 · Oct 4');
    expect(out.story.answer).toEqual([
      'From your PNC Checking bank feed.',
      TX_STORY_SPENDING,
      "Filed under Groceries by a rule — 'KROGER' matches it.",
      "You told the sync: don't file it automatically.",
    ]);
    expect(out.story.history!.map((h) => h.entryId)).toEqual([imported.id]);
    expect(out.story.notes).toEqual([]);
  });

  it('finds the other half of a link by its group', async () => {
    const r = readers({
      row: vi.fn(async () => restRow({ activityType: 'TRANSFER_OUT', amount: '600', comment: 'TRANSFER TO ALLY · TRN-2', sourceGroupId: 'wf-transfer-9' })),
      details: vi.fn(() => ({ accountType: 'CASH', assignments: [] })),
      partner: vi.fn(() => ({ activityId: 'act-3', accountName: 'Ally Savings', date: '2026-10-06' })),
    });
    const out = await companionTxStory(r, 'act-1', NOW);
    expect(r.partner).toHaveBeenCalledWith('wf-transfer-9', 'act-1');
    expect(out.kind === 'ok' && out.story.answer[1]).toBe('Half of a transfer: ↔ $600.00 into Ally Savings, Oct 6.');
  });

  it('a person’s filing says "by you, in Telegram" with the day, and rules are not read', async () => {
    const r = readers({
      details: vi.fn(() => ({ accountType: 'CASH', assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-gro', categoryName: 'Groceries', source: 'manual' }] })),
      changeLog: vi.fn(async () => logOf(filedByYou, imported)),
    });
    const out = await companionTxStory(r, 'act-1', NOW);
    expect(out.kind === 'ok' && out.story.answer[2]).toBe('Filed under Groceries by you, in Telegram, Oct 5.');
    expect(r.rules).not.toHaveBeenCalled();
  });

  it('is "gone" when the row no longer exists, and "unreachable" when it cannot be read', async () => {
    expect(await companionTxStory(readers(), 'act-old', NOW)).toEqual({ kind: 'gone' });
    expect(await companionTxStory(readers({ row: vi.fn(async () => { throw new Error('502'); }) }), 'act-1', NOW)).toEqual({ kind: 'unreachable' });
  });

  const failing: Array<[string, Partial<StoryReaders>, Record<string, string | null>, keyof typeof TX_FACT_NOTES]> = [
    ['the category', { details: vi.fn(() => { throw new Error('locked'); }) }, {}, 'category'],
    ['the partner', { row: vi.fn(async () => restRow({ sourceGroupId: 'g1' })), partner: vi.fn(() => { throw new Error('locked'); }) }, {}, 'partner'],
    ['the rules', { rules: vi.fn(async () => { throw new Error('500'); }) }, {}, 'rules'],
    ['the change log', { changeLog: vi.fn(async () => { throw new Error('500'); }) }, {}, 'changeLog'],
    ['the mapping', {}, { account_mapping: '{not json' }, 'mapping'],
    ['the overrides', {}, { [SYNC_OVERRIDES_SECRET_KEY]: '{"v":9}' }, 'overridesUnreadable'],
  ];
  it.each(failing)('a failed read of %s still tells the story, with a note', async (_what, over, secrets, fact) => {
    const out = await companionTxStory(readers(over, secrets), 'act-1', NOW);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.story.title).toBe('KROGER #415 · -$54.20 · Oct 4');
    expect(out.story.notes).toEqual([TX_FACT_NOTES[fact]]);
  });

  it('a secret read that fails reports the overrides and the skip list, never "none"', async () => {
    const r = readers({
      secret: vi.fn(async (key: string) => {
        if (key === 'account_mapping') return JSON.stringify({ 'ACT-chk': 'wf-chk' });
        throw new Error('timeout');
      }),
    });
    const out = await companionTxStory(r, 'act-1', NOW);
    expect(out.kind === 'ok' && out.story.notes).toEqual([TX_FACT_NOTES.overrides, TX_FACT_NOTES.skipList]);
  });

  it('a row on the skip list says so', async () => {
    const out = await companionTxStory(readers({}, {
      [SKIPPED_TRANSACTIONS_SECRET_KEY]: JSON.stringify([{ account: 'ACT-chk', txId: 'TRN-1' }]),
      [SYNC_OVERRIDES_SECRET_KEY]: null,
    }), 'act-1', NOW);
    expect(out.kind === 'ok' && out.story.answer.at(-1)).toBe("You told the sync: don't import it.");
  });
});

describe('companionTxSearch', () => {
  const dbRow = (activityId: string, date: string, notes: string, absCents: number, activityType = 'WITHDRAWAL') => ({
    activityId, date, absCents, activityType, accountName: 'PNC Checking', accountType: 'CASH', notes,
  });

  it('searches all of history in the database', async () => {
    const r = readers({ searchRows: vi.fn(() => [dbRow('a1', '2024-01-02', 'KROGER #415 · TRN-1', 5420), dbRow('a2', '2026-10-01', 'TARGET · TRN-2', 5420)]) });
    const out = await companionTxSearch(r, parseTxQuery('54.20'), NOW);
    expect(out).toEqual({
      kind: 'ok', recentOnly: false,
      result: {
        rows: [
          { activityId: 'a2', date: '2026-10-01', description: 'TARGET', amountCents: -5420, accountName: 'PNC Checking' },
          { activityId: 'a1', date: '2024-01-02', description: 'KROGER #415', amountCents: -5420, accountName: 'PNC Checking' },
        ],
        truncated: false,
      },
    });
    expect(r.recentRows).not.toHaveBeenCalled();
  });

  it('falls back to the last 12 months over REST when the database cannot be read', async () => {
    const r = readers({
      searchRows: vi.fn(() => { throw new Error('no database'); }),
      recentRows: vi.fn(async () => [restRow()]),
    });
    const out = await companionTxSearch(r, parseTxQuery('kroger'), NOW);
    expect(r.recentRows).toHaveBeenCalledWith('2025-10-13');
    expect(out).toEqual({
      kind: 'ok', recentOnly: true,
      result: { rows: [{ activityId: 'act-1', date: '2026-10-04', description: 'KROGER #415', amountCents: -5420, accountName: 'PNC Checking' }], truncated: false },
    });
  });

  it('is unreachable when neither can be read', async () => {
    const r = readers({
      searchRows: vi.fn(() => { throw new Error('no database'); }),
      recentRows: vi.fn(async () => { throw new Error('502'); }),
    });
    expect(await companionTxSearch(r, parseTxQuery('kroger'), NOW)).toEqual({ kind: 'unreachable' });
  });
});

describe('companionStoryReaders', () => {
  it('reads the row by id over REST, and pages the last year until a short page', async () => {
    const searchActivities = vi.fn(async (body: { page: number; pageSize: number; activityIdFilter?: string[]; dateFrom?: string }) => {
      if (body.activityIdFilter) return [restRow({ id: 'other' }), restRow()];
      return body.page === 0 ? Array.from({ length: 500 }, (_, i) => restRow({ id: `p${i}` })) : [restRow({ id: 'last' })];
    });
    const client = {
      searchActivities, listCategorizationRules: vi.fn(async () => []),
      getAddonSecret: vi.fn(async () => null), setAddonSecret: vi.fn(async () => {}),
    };
    const r = companionStoryReaders(client, '/nope/wealthfolio.db');
    expect((await r.row('act-1'))?.id).toBe('act-1');
    expect(searchActivities).toHaveBeenCalledWith({ page: 0, pageSize: 1, activityIdFilter: ['act-1'] });
    expect(await r.row('missing')).toBeNull();
    const recent = await r.recentRows('2025-10-13');
    expect(recent).toHaveLength(501);
    expect(searchActivities).toHaveBeenCalledWith({ page: 1, pageSize: 500, dateFrom: '2025-10-13' });
    expect(() => r.searchRows()).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/sqlite-native-story.test.ts src/tx-story-host.test.ts`
Expected: FAIL — `./tx-story-host.js` cannot be found, and all 7 reader tests fail ("getNativeTxDetails is not a function", …).

- [ ] **Step 3: Implement**

Edit 1 of 2 in `companion/src/wealthfolio.ts` — the REST row carries its account's name. Replace:

```ts
  sourceGroupId?: string | null;
  comment?: string | null;
  subtype?: string | null;
}
```

with:

```ts
  sourceGroupId?: string | null;
  comment?: string | null;
  subtype?: string | null;
  /** Upstream `ActivityDetails.accountName`. */
  accountName?: string | null;
}
```

Edit 2 of 2 in `companion/src/wealthfolio.ts` — the search takes an activity-id filter. Replace:

```ts
    accountIdFilter?: string[];
    activityTypeFilter?: string[];
    dateFrom?: string;
    dateTo?: string;
  }): Promise<ActivitySearchItem[]> {
```

with:

```ts
    accountIdFilter?: string[];
    activityTypeFilter?: string[];
    /** Exact ids (upstream `activityIdFilter`, Wealthfolio 3.8). */
    activityIdFilter?: string[];
    dateFrom?: string;
    dateTo?: string;
  }): Promise<ActivitySearchItem[]> {
```

Edit 1 of 3 in `companion/src/sqlite-native.ts` — `queryNativeDb` keeps its "[] on failure", over a reader that can say it failed. Replace:

```ts
function queryNativeDb<Row>(
  dbPath: string,
  label: string,
  query: string,
  fromCliParts: (parts: string[]) => Row | null,
): Row[] {
  // LIVE read first, snapshot only as a fallback. `immutable=1` reads the main
```

with:

```ts
function queryNativeDb<Row>(
  dbPath: string,
  label: string,
  query: string,
  fromCliParts: (parts: string[]) => Row | null,
): Row[] {
  return tryQueryNativeDb(dbPath, label, query, fromCliParts) ?? [];
}

/** Thrown by the story readers (1.61) when the database cannot be read: they
 *  must tell "could not look" from "nothing there", which `[]` cannot. */
export class NativeDbUnreadableError extends Error {
  constructor(what: string) {
    super(`Could not read the Wealthfolio database (${what})`);
    this.name = 'NativeDbUnreadableError';
  }
}

/** `queryNativeDb`, except a database that is not there or that every path
 *  failed to read throws `NativeDbUnreadableError`. */
function queryNativeDbStrict<Row>(
  dbPath: string,
  label: string,
  query: string,
  fromCliParts: (parts: string[]) => Row | null,
): Row[] {
  if (!dbPath || !existsSync(dbPath)) throw new NativeDbUnreadableError(`${label}: no database at ${dbPath || '(unset)'}`);
  const rows = tryQueryNativeDb(dbPath, label, query, fromCliParts);
  if (rows === null) throw new NativeDbUnreadableError(label);
  return rows;
}

/** The two-path read behind both: null — not [] — when every path failed. */
function tryQueryNativeDb<Row>(
  dbPath: string,
  label: string,
  query: string,
  fromCliParts: (parts: string[]) => Row | null,
): Row[] | null {
  // LIVE read first, snapshot only as a fallback. `immutable=1` reads the main
```

Edit 2 of 3 in `companion/src/sqlite-native.ts` — the shared read says it failed. Replace:

```ts
    console.error(`[simplefin-sync] Failed to read native sqlite ${label}:`, err);
    return [];
  }
}
```

with:

```ts
    console.error(`[simplefin-sync] Failed to read native sqlite ${label}:`, err);
    return null;
  }
}
```

Edit 3 of 3 in `companion/src/sqlite-native.ts` — the three story readers, at the end of the file. Replace:

```ts
    (parts) => (parts.length >= 1 && parts[0] ? { activity_id: parts[0] } : null),
  );
  return rows.map((r) => String(r.activity_id));
}
```

with:

```ts
    (parts) => (parts.length >= 1 && parts[0] ? { activity_id: parts[0] } : null),
  );
  return rows.map((r) => String(r.activity_id));
}

// ── "Why is this here?" (1.61) ───────────────────────────────────────────
// Strict readers: each throws NativeDbUnreadableError rather than answering
// [] for a database it could not read, because the story must say "couldn't
// read" there, never "none". Ids are interpolated like every bound in this
// file (the CLI fallback cannot bind): quotes doubled.

const sqlText = (s: string) => s.replace(/'/g, "''");

/** One taxonomy's assignment on an activity, with what the story says of it. */
export interface NativeTxAssignment {
  taxonomyId: string;
  categoryId: string;
  categoryName: string;
  /** 'rule', 'manual', … ('' when unrecorded). */
  source: string;
}

/** An activity's account type and every assignment it holds, spending or not. */
export function getNativeTxDetails(dbPath: string, activityId: string): { accountType: string; assignments: NativeTxAssignment[] } {
  const id = sqlText(activityId);
  const account = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'story account',
    `SELECT COALESCE(acc.account_type, '') AS account_type FROM activities a LEFT JOIN accounts acc ON acc.id = a.account_id WHERE a.id = '${id}';`,
    (parts) => ({ account_type: parts[0] ?? '' }),
  );
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'story assignments',
    `SELECT ata.taxonomy_id AS taxonomy_id, ata.category_id AS category_id, COALESCE(tc.name, '') AS category_name,
            COALESCE(ata.source, '') AS source
     FROM activity_taxonomy_assignments ata
     LEFT JOIN taxonomy_categories tc ON tc.id = ata.category_id
     WHERE ata.activity_id = '${id}'
     ORDER BY ata.taxonomy_id;`,
    (parts) => (parts.length >= 4 ? { c0: parts[0], c1: parts[1], c2: parts.slice(2, -1).join('|'), c3: parts[parts.length - 1] } : null),
  );
  return {
    accountType: String(Object.values(account[0] ?? {})[0] ?? ''),
    assignments: rows.map((r) => {
      const v = Object.values(r).map((x) => String(x ?? ''));
      return { taxonomyId: v[0], categoryId: v[1], categoryName: v[2], source: v[3] };
    }),
  };
}

/** The other activity in a transfer's group: its account and day. */
export function getNativeTxPartner(dbPath: string, groupId: string, activityId: string): { activityId: string; accountName: string; date: string } | null {
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'story partner',
    `SELECT b.id AS activity_id, substr(b.activity_date, 1, 10) AS activity_date, COALESCE(acc.name, '') AS account_name
     FROM activities b LEFT JOIN accounts acc ON acc.id = b.account_id
     WHERE b.source_group_id = '${sqlText(groupId)}' AND b.id <> '${sqlText(activityId)}'
     ORDER BY b.id LIMIT 1;`,
    (parts) => (parts.length >= 3 ? { c0: parts[0], c1: parts[1], c2: parts.slice(2).join('|') } : null),
  );
  if (rows.length === 0) return null;
  const v = Object.values(rows[0]).map((x) => String(x ?? ''));
  return { activityId: v[0], date: v[1], accountName: v[2] };
}

/** One activity as `/why` searches it. */
export interface NativeTxSearchRow {
  activityId: string;
  date: string;
  absCents: number;
  activityType: string;
  accountName: string;
  accountType: string;
  /** The stored note, raw. */
  notes: string;
}

/** Every activity in every account Wealthfolio has not archived — all of
 *  history, newest first. `/why` filters it in memory. */
export function getNativeTxSearchRows(dbPath: string): NativeTxSearchRow[] {
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath,
    'story search',
    `SELECT a.id AS activity_id, substr(a.activity_date, 1, 10) AS activity_date,
            ROUND(ABS(CAST(a.amount AS REAL)) * 100) AS abs_cents, UPPER(COALESCE(a.activity_type, '')) AS activity_type,
            COALESCE(acc.account_type, '') AS account_type, COALESCE(acc.name, '') AS account_name, COALESCE(a.notes, '') AS notes
     FROM activities a LEFT JOIN accounts acc ON acc.id = a.account_id
     WHERE COALESCE(acc.is_archived, 0) = 0
     ORDER BY a.activity_date DESC, a.id;`,
    // Account name and notes are free text; the name sits before the notes, so
    // a `|` inside it cannot be told apart — the CLI fallback is a last resort.
    (parts) => (parts.length >= 7
      ? { c0: parts[0], c1: parts[1], c2: parseFloat(parts[2]) || 0, c3: parts[3], c4: parts[4], c5: parts[5], c6: parts.slice(6).join('|') }
      : null),
  );
  return rows.map((r) => {
    const v = Object.values(r);
    return {
      activityId: String(v[0]),
      date: String(v[1]),
      absCents: Math.round(Number(v[2]) || 0),
      activityType: String(v[3]),
      accountType: String(v[4] ?? ''),
      accountName: String(v[5] ?? ''),
      notes: String(v[6] ?? ''),
    };
  });
}
```

**Create `companion/src/tx-story-host.ts`:**

```ts
/**
 * companion/src/tx-story-host.ts
 *
 * The companion's half of "Why is this here?": everything it can see about
 * one transaction, gathered into shared/tx-story.ts's facts, and the search
 * behind `/why`. It sees more than the add-on can — the row and the rules over
 * REST; the other half of a link, the category and who put it there from the
 * read-only database; the mapping, the overrides and the skip list from the
 * add-on's settings; and the change log — so its story is the whole story.
 *
 * Every read but the row's own is wrapped: a failure leaves that part of the
 * story out and adds a note (`failed`). An overrides document that cannot be
 * parsed is reported, never read as "none". Only the row failing is a full
 * failure ("Couldn't reach Wealthfolio — try again."), and a row that no
 * longer exists is `gone` — a transfer link re-created it, or it was removed.
 */
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log.js';
import { changesForTransaction } from '../../shared/change-view.js';
import { parseSkippedTransactions, SKIPPED_TRANSACTIONS_SECRET_KEY } from '../../shared/skipped-transactions.js';
import { txIdFromComment } from '../../shared/sync-core.js';
import { hasTxOverride, loadSyncOverrides, TX_OVERRIDE_FLAGS, type TxOverrideFlag } from '../../shared/sync-overrides.js';
import { accountTxKey } from '../../shared/transfers.js';
import { findTransactions, txDescription, TX_SEARCH_RECENT_DAYS, type TxQuery, type TxSearchResult, type TxSearchRow } from '../../shared/tx-search.js';
import {
  buildTxStory, isOutflow, resolveFiler, signedCents, type CategoryRuleLike, type TxFactName, type TxStory,
  type TxStoryFacts, type TxStoryRow,
} from '../../shared/tx-story.js';
import { readCompanionChangeLog, type SecretClient } from './change-log-host.js';
import {
  getNativeTxDetails, getNativeTxPartner, getNativeTxSearchRows, type NativeTxAssignment, type NativeTxSearchRow,
} from './sqlite-native.js';
import type { ActivitySearchItem, WealthfolioClient } from './wealthfolio.js';

const ADDON_ID = 'simplefin-sync';
const SPENDING_TAXONOMY_ID = 'spending_categories';
/** REST pages the 12-month fallback reads at most (500 rows each). */
const RECENT_PAGE_SIZE = 500;
const RECENT_MAX_PAGES = 20;

/** Everything the story and the search read, so a test can fake each one. */
export interface StoryReaders {
  /** The row by REST; null when it no longer exists. Rejects when Wealthfolio
   *  cannot be reached. */
  row(activityId: string): Promise<ActivitySearchItem | null>;
  /** Account type and every assignment (database). Throws when unreadable. */
  details(activityId: string): { accountType: string; assignments: NativeTxAssignment[] };
  /** The other activity in the group (database). Throws when unreadable. */
  partner(groupId: string, activityId: string): { activityId: string; accountName: string; date: string } | null;
  /** The categorization rules, in the server's order. */
  rules(): Promise<CategoryRuleLike[]>;
  changeLog(now: Date): Promise<ChangeLogRead>;
  /** An add-on setting. */
  secret(key: string): Promise<string | null>;
  /** All of history (database). Throws when unreadable. */
  searchRows(): NativeTxSearchRow[];
  /** REST, every activity dated `dateFrom` (YYYY-MM-DD) or later. */
  recentRows(dateFrom: string): Promise<ActivitySearchItem[]>;
}

export type StoryClient = SecretClient & Pick<WealthfolioClient, 'searchActivities' | 'listCategorizationRules'>;

export function companionStoryReaders(client: StoryClient, dbPath: string): StoryReaders {
  return {
    row: async (activityId) =>
      (await client.searchActivities({ page: 0, pageSize: 1, activityIdFilter: [activityId] })).find((a) => a.id === activityId) ?? null,
    details: (activityId) => getNativeTxDetails(dbPath, activityId),
    partner: (groupId, activityId) => getNativeTxPartner(dbPath, groupId, activityId),
    rules: () => client.listCategorizationRules(),
    changeLog: (now) => readCompanionChangeLog(client, now),
    secret: (key) => client.getAddonSecret(ADDON_ID, key),
    searchRows: () => getNativeTxSearchRows(dbPath),
    recentRows: async (dateFrom) => {
      const all: ActivitySearchItem[] = [];
      for (let page = 0; page < RECENT_MAX_PAGES; page++) {
        const items = await client.searchActivities({ page, pageSize: RECENT_PAGE_SIZE, dateFrom });
        all.push(...items);
        if (items.length < RECENT_PAGE_SIZE) break;
      }
      return all;
    },
  };
}

export type StoryOutcome =
  | { kind: 'ok'; story: TxStory; facts: TxStoryFacts }
  | { kind: 'gone' }
  | { kind: 'unreachable' };

const absCentsOf = (amount: unknown) => Math.round(Math.abs(Number(amount ?? 0)) * 100) || 0;

/** One transaction's story. Never rejects. */
export async function companionTxStory(readers: StoryReaders, activityId: string, now: Date): Promise<StoryOutcome> {
  let item: ActivitySearchItem | null;
  try {
    item = await readers.row(activityId);
  } catch {
    return { kind: 'unreachable' };
  }
  if (!item) return { kind: 'gone' };

  const failed: TxFactName[] = [];
  const note = item.comment ?? '';
  const txId = txIdFromComment(note);

  // The mapping: which SimpleFin account this row's account syncs from.
  let sfinId: string | null | undefined;
  try {
    const raw = await readers.secret('account_mapping');
    const mapping = raw ? JSON.parse(raw) as Record<string, string> : {};
    sfinId = Object.entries(mapping).find(([, wfId]) => wfId === item!.accountId)?.[0] ?? null;
  } catch {
    failed.push('mapping');
  }
  const txKey = sfinId && txId ? accountTxKey(sfinId, txId) : null;

  let details: { accountType: string; assignments: NativeTxAssignment[] } | null = null;
  try {
    details = readers.details(activityId);
  } catch {
    failed.push('category');
  }

  let partner: TxStoryFacts['partner'] = null;
  if (item.sourceGroupId) {
    try {
      const p = readers.partner(item.sourceGroupId, activityId);
      partner = p ? { accountName: p.accountName, date: p.date } : null;
    } catch {
      partner = undefined;
      failed.push('partner');
    }
  }

  let history: ChangeLogItem[] | null = null;
  try {
    history = changesForTransaction((await readers.changeLog(now)).entries, { txKeys: txKey ? [txKey] : [], activityIds: [activityId] });
  } catch {
    failed.push('changeLog');
  }

  let overrides: TxOverrideFlag[] = [];
  try {
    const loaded = await loadSyncOverrides(readers.secret);
    if (loaded.unreadable) failed.push('overridesUnreadable');
    else if (txKey) overrides = TX_OVERRIDE_FLAGS.filter((flag) => hasTxOverride(loaded.overrides, txKey, flag));
  } catch {
    failed.push('overrides');
  }

  let skipped = false;
  try {
    const list = parseSkippedTransactions(await readers.secret(SKIPPED_TRANSACTIONS_SECRET_KEY));
    skipped = !!sfinId && !!txId && list.some((s) => s.account === sfinId && s.txId === txId);
  } catch {
    failed.push('skipList');
  }

  const row: TxStoryRow = {
    activityId,
    note,
    absCents: absCentsOf(item.amount),
    date: String(item.date ?? '').slice(0, 10),
    activityType: String(item.activityType ?? '').toUpperCase(),
    accountName: item.accountName ?? '',
    ...(details?.accountType ? { accountType: details.accountType } : {}),
  };

  // Its category: the spending one when it has one, else whatever it has.
  let category: TxStoryFacts['category'];
  if (details) {
    const a = details.assignments.find((x) => x.taxonomyId === SPENDING_TAXONOMY_ID) ?? details.assignments[0];
    if (!a) category = null;
    else {
      let rules: CategoryRuleLike[] | null = null;
      if (a.source.toLowerCase() === 'rule') {
        try {
          rules = await readers.rules();
        } catch {
          failed.push('rules');
        }
      }
      const filer = resolveFiler({
        source: a.source,
        categoryId: a.categoryId,
        row: { note, activityType: row.activityType, accountId: item.accountId, absCents: row.absCents },
        history,
        rules,
      });
      category = { name: a.categoryName || 'a category', filer };
    }
  }

  const facts: TxStoryFacts = {
    row,
    ...(sfinId === undefined ? {} : { feed: sfinId ? { sfinAccountId: sfinId } : null }),
    partner,
    category,
    overrides,
    skipped,
    ...(history ? { history } : {}),
    failed,
  };
  return { kind: 'ok', story: buildTxStory(facts), facts };
}

export type SearchOutcome =
  | { kind: 'ok'; result: TxSearchResult; recentOnly: boolean }
  | { kind: 'unreachable' };

const isoDaysBefore = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);

/** `/why <words>`: all of history from the database; the last 12 months over
 *  REST when the database cannot be read. Never rejects. */
export async function companionTxSearch(readers: StoryReaders, query: TxQuery, now: Date): Promise<SearchOutcome> {
  let rows: TxSearchRow[];
  let recentOnly = false;
  try {
    rows = readers.searchRows().map((r) => ({
      activityId: r.activityId,
      date: r.date,
      description: txDescription(r.notes),
      amountCents: signedCents({ absCents: r.absCents, activityType: r.activityType, accountType: r.accountType }),
      accountName: r.accountName,
    }));
  } catch {
    try {
      recentOnly = true;
      rows = (await readers.recentRows(isoDaysBefore(now, TX_SEARCH_RECENT_DAYS))).map((a) => {
        const abs = absCentsOf(a.amount);
        return {
          activityId: a.id,
          date: String(a.date ?? '').slice(0, 10),
          description: txDescription(a.comment),
          amountCents: isOutflow(String(a.activityType ?? '')) ? -abs : abs,
          accountName: a.accountName ?? '',
        };
      });
    } catch {
      return { kind: 'unreachable' };
    }
  }
  return { kind: 'ok', result: findTransactions(rows, query), recentOnly };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run src/sqlite-native-story.test.ts src/tx-story-host.test.ts src/sqlite-native.test.ts src/sqlite-native-undo.test.ts src/wealthfolio.test.ts`
Expected: PASS — 145 tests.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/tx-story-host.ts companion/src/tx-story-host.test.ts companion/src/sqlite-native-story.test.ts companion/src/sqlite-native.ts companion/src/wealthfolio.ts
git commit -m "Companion: gather a transaction's story from REST, the database and the log; search all of history

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `/why` in Telegram

`companion/src/why-menu.ts` (spec A2, C5, W4). `/why <words and/or an amount>` replies with the results — buttons, newest first, 8 a page, `‹ Older`/`Newer ›`, "Page n of m", and "Too many matches…" past 40; bare `/why` asks one question through the R1 ask engine, like `/newrule`. A result opens the story IN PLACE with ⬅️ Back to its page. The story is escaped line by line, bank text outside every entity; each What-happened line is a numbered button into `/changes`' entry view (`cz:cl:d<handle>:w<id>`), whose ‹ Back now returns to the story in place (`cz:wy:t<id>:c`) — changes-menu.ts gains the `why` back. A run view lists one sync's imports from the change log (the import notice's button, Task 6). Stateless: every tap re-reads; a story whose row is gone answers "That transaction has changed since — search again with /why." and changes nothing. A query is cut to 17 bytes so the widest story button is exactly 64. `/why` joins `/help`'s More commands. The prefix, the button text and `whyButton` live in shared/telegram.ts beside the other shared `cz:` payloads, because both hosts' alerts carry the button.

**Files:**
- Create: `companion/src/why-menu.ts`, `companion/src/why-menu.test.ts`
- Modify: `shared/telegram.ts`, `shared/telegram-commands.ts`, `companion/src/changes-menu.ts`, `companion/src/index.ts`
- Test: `companion/src/changes-menu.test.ts`, `companion/src/index.test.ts`, `shared/telegram-commands.test.ts`

**Interfaces:**
- Consumes: Task 1 (`isEmptyTxQuery`, `parseTxQuery`, `txQueryText`, `txSearchPage`, `TX_SEARCH_TOO_MANY`, `TxQuery`, `TxSearchResult`); Task 2 (`TX_STORY_GONE`, `TX_STORY_NO_HISTORY`, `TX_STORY_UNREACHABLE`, `TX_STORY_WHAT_HAPPENED`, `TxStory`); Task 4 (`companionStoryReaders`, `companionTxSearch`, `companionTxStory`, `SearchOutcome`, `StoryOutcome`); `changesData`, `parseChangesData` (changes-menu.ts); `AskFlow` (shared/ask-flow.ts); `findingHandle`; `escapeMarkdown`, `shortDateTime`; `changeDay`, `changeMoney`; existing `createAskSessions` wiring in index.ts.
- Produces:

```ts
// shared/telegram.ts
export const WHY_CALLBACK_PREFIX = 'cz:wy:';
export const WHY_BUTTON_TEXT = '🔎 Why?';
export function whyButton(activityId: string): { text: string; callback_data: string };   // cz:wy:t<id>
// companion/src/why-menu.ts
export const WHY_QUERY_MAX_BYTES = 17;
export const WHY_TITLE = 'Why is this here?';
export const WHY_ASK_PROMPT = 'Which transaction? Send a few words or an amount.';
export const WHY_ASK_HINT = 'Send a few words from its description, an amount, or both.';
export const WHY_TAP_ONE = 'Tap one to see its story.';
export const WHY_RECENT_ONLY = "Searched the last 12 months — the companion couldn't read the database.";
export const WHY_RUN_TITLE = 'What this sync imported';
export const WHY_RUN_GONE = "That sync is past the change log's 90 days — search with /why.";
export const WHY_HISTORY_MAX = 20;
export interface MenuScreen { text: string; keyboard: InlineKeyboard }
export type StoryBack = { kind: 'none' } | { kind: 'changes' } | { kind: 'search'; page: number; query: string } | { kind: 'run'; run: string; page: number };
export type WhyView = { kind: 'search'; page: number; query: string } | { kind: 'story'; activityId: string; back: StoryBack }
  | { kind: 'run'; run: string; page: number; fresh: boolean };
export function whyData(view: WhyView): string;
export function parseWhyData(data: string): WhyView | null;
export function normalizeWhyQuery(raw: string): string;
export function whyNoMatch(q: TxQuery): string;
export function renderWhyResults(found: { result: TxSearchResult; recentOnly: boolean }, query: string, page: number): MenuScreen;
export function renderWhyStory(story: TxStory, activityId: string, back: StoryBack): MenuScreen;
export function renderWhyRun(entries: ChangeLogItem[], run: string, page: number): MenuScreen;
export function buildWhyFlow(): AskFlow;
export interface WhyMenuUi { edit(text: string, keyboard?: InlineKeyboard): Promise<void>; answer(text?: string): Promise<void>; send(text: string, keyboard?: InlineKeyboard): Promise<void> }
export interface WhyMenuDeps { search(query: TxQuery, now: Date): Promise<SearchOutcome>; story(activityId: string, now: Date): Promise<StoryOutcome>;
  read(now: Date): Promise<ChangeLogRead>; now(): Date; log(msg: string): void }
export interface WhyMenu { handles(data: string): boolean; onCallback(cb: { data: string }, ui: WhyMenuUi): Promise<void>;
  reply(text: string, send: Send): Promise<void>; sendStory(activityId: string, send: Send): Promise<void> }
export function createWhyMenu(deps: WhyMenuDeps): WhyMenu;
// companion/src/changes-menu.ts
export type ChangesView = /* … */ | { kind: 'why'; activityId: string };   // a back only
// companion/src/index.ts
export function buildWhyMenu(wfClient: WealthfolioClient): WhyMenu;
export function buildAskSessions(wfClient, controller, why?: WhyMenu): AskSessions;              // registers 'why'
export function buildTelegramCommandHandler(wfClient, controller?, asks?, why?: WhyMenu);         // case 'why'
```

- [ ] **Step 1: Write the failing tests**

**Create `companion/src/why-menu.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { importChange, stampChange } from '../../shared/change-entries.js';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log.js';
import { MENU_CALLBACK_PREFIX } from '../../shared/categorize-menu.js';
import { findingHandle } from '../../shared/handle.js';
import { WHY_CALLBACK_PREFIX } from '../../shared/telegram.js';
import { parseTxQuery, type TxSearchRow } from '../../shared/tx-search.js';
import { buildTxStory, TX_STORY_GONE, TX_STORY_UNREACHABLE, type TxStory } from '../../shared/tx-story.js';
import { answerText, startAsk } from '../../shared/ask-flow.js';
import { parseChangesData } from './changes-menu.js';
import {
  buildWhyFlow, createWhyMenu, normalizeWhyQuery, parseWhyData, renderWhyResults, renderWhyRun, renderWhyStory,
  whyData, WHY_QUERY_MAX_BYTES, WHY_RECENT_ONLY, WHY_RUN_GONE, type WhyMenuDeps, type MenuScreen,
} from './why-menu.js';

const ID = '0f8fad5b-d9cb-469f-a165-708677289501';
const NOW = new Date('2026-10-13T16:00:00Z');
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const allData = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
const labels = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.text);

const result = (n: number, over: Partial<TxSearchRow> = {}): TxSearchRow[] => Array.from({ length: n }, (_, i) => ({
  activityId: `act-${i}`, date: `2026-10-${String(20 - (i % 19)).padStart(2, '0')}`, description: 'KROGER #415',
  amountCents: -5420, accountName: 'PNC Checking', ...over,
}));

const imp = (activityId: string, run: string, description = 'KROGER #415'): ChangeLogItem => stampChange(importChange({
  account: { sfinId: 'ACT-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKey: `k-${activityId}`, activityId,
  description, amountCents: -5420, date: '2026-10-04', pending: false, activityType: 'WITHDRAWAL',
}), 'companion', new Date('2026-10-04T12:00:00Z'), run);

const storyFor = (over: Partial<TxStory> = {}): TxStory => ({
  ...buildTxStory({
    row: { activityId: ID, note: 'KROGER #415 · TRN-1', absCents: 5420, date: '2026-10-04', activityType: 'WITHDRAWAL', accountName: 'PNC Checking' },
    feed: { sfinAccountId: 'ACT-chk' }, partner: null, category: { name: 'Groceries', filer: { kind: 'rule', pattern: 'KROGER' } },
    history: [imp(ID, 'c1')],
  }),
  ...over,
});

describe('normalizeWhyQuery', () => {
  it('keeps a short query as words then the amount', () => {
    expect(normalizeWhyQuery('  $54.20   Kroger ')).toBe('kroger 54.20');
  });

  it('drops words from the end, keeping the amount, until it fits', () => {
    const q = normalizeWhyQuery('heine brothers coffee shop 12.50');
    expect(bytes(q)).toBeLessThanOrEqual(WHY_QUERY_MAX_BYTES);
    expect(q).toBe('heine 12.50');
  });

  it('cuts one long word at a character, never mid-byte', () => {
    const q = normalizeWhyQuery('ééééééééééééééééééé');
    expect(bytes(q)).toBeLessThanOrEqual(WHY_QUERY_MAX_BYTES);
    expect(q).toBe('éééééééé');
  });
});

describe('the results', () => {
  it('lists matches as buttons, newest first, with the date, description, amount and account', () => {
    const s = renderWhyResults({ result: { rows: result(2), truncated: false }, recentOnly: false }, 'kroger', 0);
    expect(s.text).toBe(['🔎 *Why is this here?* kroger', '', 'Tap one to see its story.'].join('\n'));
    expect(s.keyboard.inline_keyboard[0]).toEqual([{ text: 'Oct 20 · KROGER #415 · -$54.20 · PNC Checking', callback_data: 'cz:wy:tact-0:s0:kroger' }]);
  });

  it('pages by 8, with a page count, and says when there were too many', () => {
    const found = { result: { rows: result(40), truncated: true }, recentOnly: false };
    const first = renderWhyResults(found, '54', 0);
    expect(first.keyboard.inline_keyboard).toHaveLength(9);
    expect(first.text).toContain('Page 1 of 5');
    expect(first.text).toContain('Too many matches — add a word or an amount.');
    expect(labels(first).at(-1)).toBe('‹ Older');
    const last = renderWhyResults(found, '54', 4);
    expect(labels(last).at(-1)).toBe('Newer ›');
    expect(allData(last)).toContain('cz:wy:s3:54');
  });

  it('says when it could only search the last 12 months', () => {
    expect(renderWhyResults({ result: { rows: result(1), truncated: false }, recentOnly: true }, 'kroger', 0).text).toContain(WHY_RECENT_ONLY);
  });

  it('says nothing matches, pointing at /changes with the words', () => {
    const none = { result: { rows: [], truncated: false }, recentOnly: false };
    expect(renderWhyResults(none, 'venmo jane', 0).text).toBe('🔎 *Why is this here?* venmo jane\n\nNothing matches. If it was removed, try /changes venmo jane.');
    expect(renderWhyResults(none, '54.20', 0).text).toContain('Nothing matches. If it was removed, try /changes with a word from its description.');
    expect(renderWhyResults(none, '54.20', 0).keyboard.inline_keyboard).toEqual([]);
  });

  it('escapes a bank name full of Markdown characters and keeps it out of every entity', () => {
    const s = renderWhyResults({ result: { rows: result(1, { description: 'SQ *COFFEE_CLUB [2]' }), truncated: false }, recentOnly: false }, 'sq *coffee_', 0);
    expect(s.text.split('\n')[0]).toBe('🔎 *Why is this here?* sq \\*coffee\\_');
    // Button labels are not Markdown: they stay as the bank wrote them.
    expect(labels(s)[0]).toBe('Oct 20 · SQ *COFFEE_CLUB [2] · -$54.20 · PNC Checking');
  });
});

describe('the story', () => {
  it('answers, then lists what happened, each line a button into /changes that comes back here', () => {
    const story = storyFor();
    const s = renderWhyStory(story, ID, { kind: 'search', page: 1, query: 'kroger' });
    expect(s.text).toBe([
      '🔎 KROGER #415 · -$54.20 · Oct 4',
      'PNC Checking',
      '',
      'From your PNC Checking bank feed.',
      'Spending.',
      "Filed under Groceries by a rule — 'KROGER' matches it.",
      '',
      '*What happened*',
      '1. Oct 4 · Imported KROGER #415',
    ].join('\n'));
    const line = s.keyboard.inline_keyboard[0][0];
    expect(line.text).toBe('1');
    expect(parseChangesData(line.callback_data)).toEqual({
      kind: 'detail', entry: findingHandle(story.history![0].entryId), back: { kind: 'why', activityId: ID },
    });
    expect(s.keyboard.inline_keyboard.at(-1)).toEqual([{ text: '⬅️ Back', callback_data: 'cz:wy:s1:kroger' }]);
  });

  it('a story sent as a new message, or reached from /changes, has no Back', () => {
    expect(labels(renderWhyStory(storyFor(), ID, { kind: 'none' }))).toEqual(['1']);
    expect(labels(renderWhyStory(storyFor(), ID, { kind: 'changes' }))).toEqual(['1']);
    expect(renderWhyStory(storyFor(), ID, { kind: 'run', run: 'abcd1234', page: 2 }).keyboard.inline_keyboard.at(-1))
      .toEqual([{ text: '⬅️ Back', callback_data: 'cz:wy:rabcd1234:2' }]);
  });

  it('says when nothing happened in 90 days, and leaves the section out when the log was unreadable', () => {
    expect(renderWhyStory(storyFor({ history: [] }), ID, { kind: 'none' }).text).toContain('*What happened*\nNo changes in the last 90 days.');
    const unread = renderWhyStory(storyFor({ history: null, notes: ["Couldn't read the change log just now."] }), ID, { kind: 'none' });
    expect(unread.text).not.toContain('What happened');
    expect(unread.text.endsWith("\n\n⚠️ Couldn't read the change log just now.")).toBe(true);
  });

  it('escapes bank text in the title, the account and the answer, and keeps it out of every entity', () => {
    const story = buildTxStory({
      row: { activityId: ID, note: 'SQ *COFFEE_CLUB [2] · TRN-1', absCents: 500, date: '2026-10-04', activityType: 'WITHDRAWAL', accountName: "Joe's *Visa*" },
      feed: { sfinAccountId: 'x' }, partner: null, history: [],
    });
    const s = renderWhyStory(story, ID, { kind: 'none' });
    const lines = s.text.split('\n');
    expect(lines[0]).toBe('🔎 SQ \\*COFFEE\\_CLUB \\[2] · -$5.00 · Oct 4');
    expect(lines[1]).toBe("Joe's \\*Visa\\*");
    expect(lines[3]).toBe("From your Joe's \\*Visa\\* bank feed.");
    expect(lines.filter((l) => /^[*_]/.test(l))).toEqual(['*What happened*']);
  });

  it('shows the newest 20 lines of a long history', () => {
    const many = Array.from({ length: 23 }, (_, i) => ({ entryId: `e${i}`, line: `Oct 4 · step ${i}` }));
    const s = renderWhyStory(storyFor({ history: many }), ID, { kind: 'none' });
    expect(s.text).toContain('…and 3 earlier — /changes lists them.');
    expect(s.text).toContain('1. Oct 4 · step 3');
    expect(labels(s)).toHaveLength(20);
  });
});

describe('a sync’s imports', () => {
  it('lists them, each opening its story with Back to the list', () => {
    const s = renderWhyRun([imp('a1', 'c1'), imp('a2', 'c1', 'TARGET')], 'abcd1234', 0);
    expect(s.text.split('\n')[0]).toBe('🔎 *What this sync imported*');
    expect(s.keyboard.inline_keyboard[1]).toEqual([{ text: 'Oct 4 · TARGET · -$54.20 · PNC Checking', callback_data: 'cz:wy:ta2:rabcd1234:0' }]);
  });
});

describe('callback data', () => {
  it('round-trips every view', () => {
    const views = [
      { kind: 'search', page: 3, query: 'kroger 54.20' },
      { kind: 'story', activityId: ID, back: { kind: 'none' } },
      { kind: 'story', activityId: ID, back: { kind: 'changes' } },
      { kind: 'story', activityId: ID, back: { kind: 'search', page: 0, query: 'a:b c' } },
      { kind: 'story', activityId: ID, back: { kind: 'run', run: 'abcd1234', page: 4 } },
      { kind: 'run', run: 'abcd1234', page: 0, fresh: true },
      { kind: 'run', run: 'abcd1234', page: 2, fresh: false },
    ] as const;
    for (const v of views) expect(parseWhyData(whyData(v))).toEqual(v);
    expect(parseWhyData('cz:wy:nonsense')).toBeNull();
    expect(parseWhyData('cz:cl:l0')).toBeNull();
  });

  it('the longest query still fits Telegram’s 64 bytes on every button, story Back included', () => {
    const query = normalizeWhyQuery('éééé ééé ééé 1,234,567.89 trailing words here');
    const found = { result: { rows: result(8, { activityId: ID }), truncated: true }, recentOnly: false };
    const results = renderWhyResults(found, query, 1);
    const story = renderWhyStory(storyFor(), ID, { kind: 'search', page: 4, query });
    const run = renderWhyRun([imp(ID, 'c1')], 'abcd1234', 0);
    const fromRun = renderWhyStory(storyFor(), ID, { kind: 'run', run: 'abcd1234', page: 4 });
    for (const data of [...allData(results), ...allData(story), ...allData(run), ...allData(fromRun)]) {
      expect(bytes(data)).toBeLessThanOrEqual(64);
    }
    expect(Math.max(...allData(results).map(bytes))).toBe(64 - (WHY_QUERY_MAX_BYTES - bytes(query)));
  });

  it('shares the cz: prefix every menu tap rides on', () => {
    expect(WHY_CALLBACK_PREFIX.startsWith(MENU_CALLBACK_PREFIX)).toBe(true);
  });
});

describe('the menu', () => {
  const ui = () => ({ edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) });
  const deps = (over: Partial<WhyMenuDeps> = {}): WhyMenuDeps => ({
    search: vi.fn(async () => ({ kind: 'ok' as const, result: { rows: result(3), truncated: false }, recentOnly: false })),
    story: vi.fn(async (id: string) => (id === ID ? { kind: 'ok' as const, story: storyFor(), facts: {} as never } : { kind: 'gone' as const })),
    read: vi.fn(async (): Promise<ChangeLogRead> => ({ entries: [imp(ID, 'c1')], gaps: [], trimmed: 0, unreadable: [] })),
    now: () => NOW,
    log: vi.fn(),
    ...over,
  });

  it('/why <words> replies with the results', async () => {
    const d = deps();
    const send = vi.fn(async () => {});
    await createWhyMenu(d).reply('Kroger', send);
    expect(d.search).toHaveBeenCalledWith(parseTxQuery('kroger'), NOW);
    expect((send.mock.calls[0] as unknown as [string])[0]).toContain('🔎 *Why is this here?* kroger');
  });

  it('/why says so when Wealthfolio cannot be reached', async () => {
    const send = vi.fn(async () => {});
    await createWhyMenu(deps({ search: vi.fn(async () => ({ kind: 'unreachable' as const })) })).reply('kroger', send);
    expect(send).toHaveBeenCalledWith(TX_STORY_UNREACHABLE);
  });

  it('pages the results in place', async () => {
    const u = ui();
    await createWhyMenu(deps()).onCallback({ data: 'cz:wy:s0:kroger' }, u);
    expect(u.edit).toHaveBeenCalledTimes(1);
    expect(u.send).not.toHaveBeenCalled();
    expect(u.answer).toHaveBeenCalledWith();
  });

  it('a result opens its story in place; a 🔎 Why? button sends it as a new message', async () => {
    const inPlace = ui();
    await createWhyMenu(deps()).onCallback({ data: `cz:wy:t${ID}:s0:kroger` }, inPlace);
    expect(inPlace.edit).toHaveBeenCalledTimes(1);
    expect(inPlace.send).not.toHaveBeenCalled();
    const fresh = ui();
    await createWhyMenu(deps()).onCallback({ data: `cz:wy:t${ID}` }, fresh);
    expect(fresh.send).toHaveBeenCalledTimes(1);
    expect(fresh.edit).not.toHaveBeenCalled();
    expect((fresh.send.mock.calls[0] as unknown as [string])[0]).toContain('🔎 KROGER #415');
  });

  it('a stale story button — the row was re-created by a transfer link — says so and changes nothing', async () => {
    const u = ui();
    await createWhyMenu(deps()).onCallback({ data: 'cz:wy:tolder-row-id:s0:kroger' }, u);
    expect(u.answer).toHaveBeenCalledWith(TX_STORY_GONE);
    expect(u.edit).not.toHaveBeenCalled();
    expect(u.send).not.toHaveBeenCalled();
  });

  it('a sync’s imports come from the change log, by the run, sent as a new message', async () => {
    const u = ui();
    await createWhyMenu(deps()).onCallback({ data: `cz:wy:r${findingHandle('c1')}` }, u);
    expect((u.send.mock.calls[0] as unknown as [string])[0]).toContain('🔎 *What this sync imported*');
    const gone = ui();
    await createWhyMenu(deps()).onCallback({ data: `cz:wy:r${findingHandle('c-old')}` }, gone);
    expect(gone.answer).toHaveBeenCalledWith(WHY_RUN_GONE);
    expect(gone.send).not.toHaveBeenCalled();
  });

  it('sendStory sends the story, or the reason it cannot', async () => {
    const send = vi.fn(async () => {});
    await createWhyMenu(deps()).sendStory(ID, send);
    await createWhyMenu(deps()).sendStory('gone', send);
    expect((send.mock.calls[0] as unknown as [string])[0]).toContain('🔎 KROGER #415');
    expect(send.mock.calls[1]).toEqual([TX_STORY_GONE]);
  });

  it('ignores data it never emitted', async () => {
    const u = ui();
    await createWhyMenu(deps()).onCallback({ data: 'cz:wy:zz' }, u);
    expect(u.answer).toHaveBeenCalledWith();
  });
});

describe('the bare /why question', () => {
  it('asks for words or an amount, and will not take nothing', () => {
    const flow = buildWhyFlow();
    const { state, screen } = startAsk(flow, 's1');
    expect(screen.text).toBe('*Why is this here?*\nWhich transaction? Send a few words or an amount.');
    expect(answerText(flow, state, '!!').kind).toBe('done');
    const empty = answerText(flow, state, '   ');
    expect(empty.kind).toBe('retry');
  });
});
```

Edit 1 of 1 in `companion/src/changes-menu.test.ts` — an entry opened from a /why story goes back to it. Replace:

```ts
describe('the /changes list', () => {
```

with:

```ts
describe('an entry opened from a /why story (1.61)', () => {
  const ID = '0f8fad5b-d9cb-469f-a165-708677289501';
  it('carries the story as its back, inside 64 bytes, and Back returns to the story in place', () => {
    const entry = imp(1, at(12, 9, 0));
    const data = changesData({ kind: 'detail', entry: 'abcd1234', back: { kind: 'why', activityId: ID } });
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseChangesData(data)).toEqual({ kind: 'detail', entry: 'abcd1234', back: { kind: 'why', activityId: ID } });
    const s = renderChangeDetail(entry, { kind: 'why', activityId: ID });
    expect(button(s, '‹ Back')).toBe(`cz:wy:t${ID}:c`);
  });

  it('is only ever a back, never a screen of its own', () => {
    expect(parseChangesData(`cz:cl:w${'x'.repeat(36)}`)).toBeNull();
  });
});

describe('the /changes list', () => {
```

Edit 1 of 2 in `shared/telegram-commands.test.ts` — /why joins More commands. Replace:

```ts
  it('keeps the other seven working, listed under "More commands" in /help', () => {
    expect(TELEGRAM_MORE_COMMANDS.map((c) => c.command))
      .toEqual(['afford', 'pool', 'recategorize', 'newrule', 'dismissed', 'subscriptions', 'changes']);
```

with:

```ts
  it('keeps the other eight working, listed under "More commands" in /help', () => {
    expect(TELEGRAM_MORE_COMMANDS.map((c) => c.command))
      .toEqual(['afford', 'pool', 'recategorize', 'newrule', 'dismissed', 'subscriptions', 'changes', 'why']);
```

Edit 2 of 2 in `shared/telegram-commands.test.ts` — its example. Replace:

```ts
    expect(help).toContain('/changes venmo');
  });
```

with:

```ts
    expect(help).toContain('/changes venmo');
    expect(help).toContain('/why kroger 54.20');
  });
```

Edit 1 of 3 in `companion/src/index.test.ts` — the story reader the /why tests drive. Replace:

```ts
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending, getNativeCategorizedSpending, getNativeSpendingCategories } from './sqlite-native.js';
```

with:

```ts
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending, getNativeCategorizedSpending, getNativeSpendingCategories, getNativeTxSearchRows } from './sqlite-native.js';
```

Edit 2 of 3 in `companion/src/index.test.ts` — the mock factory lists the story readers index.ts now imports. Replace:

```ts
  getNativeIncomeCategories: vi.fn(() => []),
}));
```

with:

```ts
  getNativeIncomeCategories: vi.fn(() => []),
  // "Why is this here?" (1.61): tx-story-host.ts's readers.
  getNativeTxDetails: vi.fn(() => ({ accountType: '', assignments: [] })),
  getNativeTxPartner: vi.fn(() => null),
  getNativeTxSearchRows: vi.fn(() => []),
  NativeDbUnreadableError: class NativeDbUnreadableError extends Error {},
}));
```

Edit 3 of 3 in `companion/src/index.test.ts` — /why wiring, after /changes. Replace:

```ts
      await deps.onMenuCallback!({ data: 'cz:cl:l0', chatId: 1, messageId: 2 }, ui);
      expect((ui.edit.mock.calls[0] as unknown as [string])[0]).toContain('*Changes — last 7 days*');
    });
  });
```

with:

```ts
      await deps.onMenuCallback!({ data: 'cz:cl:l0', chatId: 1, messageId: 2 }, ui);
      expect((ui.edit.mock.calls[0] as unknown as [string])[0]).toContain('*Changes — last 7 days*');
    });
  });

  describe('/why', () => {
    const kroger = {
      activityId: 'act-1', date: '2026-10-04', absCents: 5420, activityType: 'WITHDRAWAL',
      accountName: 'PNC Checking', accountType: 'CASH', notes: 'KROGER #415 · TRN-1',
    };

    it('searches all of history with the words after the command, each match a button', async () => {
      vi.mocked(getNativeTxSearchRows).mockReturnValueOnce([kroger]);
      const { client } = clientFor();
      const sent: Array<[string, any]> = [];
      await buildTelegramCommandHandler(client)({ command: 'why', args: 'Kroger 54.20' }, async (t, k) => { sent.push([t, k]); });
      expect(sent[0][0]).toBe('🔎 *Why is this here?* kroger 54.20\n\nTap one to see its story.');
      expect(sent[0][1].inline_keyboard[0][0]).toEqual({
        text: 'Oct 4 · KROGER #415 · -$54.20 · PNC Checking', callback_data: 'cz:wy:tact-1:s0:kroger 54.20',
      });
    });

    it('asks which transaction when sent bare', async () => {
      const { client } = clientFor();
      const { sent, reply } = collector();
      await buildTelegramCommandHandler(client)({ command: 'why', args: '' }, reply);
      expect(sent[0]).toBe('*Why is this here?*\nWhich transaction? Send a few words or an amount.');
    });

    it('cz:wy: taps reach the why menu, not the transaction menu', async () => {
      vi.mocked(getNativeTxSearchRows).mockReturnValueOnce([kroger]);
      const { client } = clientFor();
      const deps = buildTelegramListenerDeps(client);
      const ui = { edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) };
      await deps.onMenuCallback!({ data: 'cz:wy:s0:kroger', chatId: 1, messageId: 2 }, ui);
      expect((ui.edit.mock.calls[0] as unknown as [string])[0]).toBe('🔎 *Why is this here?* kroger\n\nTap one to see its story.');
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/why-menu.test.ts src/changes-menu.test.ts src/index.test.ts`
Expected: FAIL — `./why-menu.js` cannot be loaded; the `/changes` back test (no `why` back yet) and the three `/why` wiring tests fail. (`is only ever a back, never a screen of its own` already passes — it pins that the new back stays one.)

Run: `npx vitest run shared/telegram-commands.test.ts`
Expected: FAIL — 1 test: More commands has no `why`.

- [ ] **Step 3: Implement**

Edit 1 of 1 in `shared/telegram.ts` — the /why prefix and its button, beside the other shared `cz:` payloads. Replace:

```ts
export const RECATEGORIZE_ENTRY_CALLBACK = 'cz:recat';
```

with:

```ts
export const RECATEGORIZE_ENTRY_CALLBACK = 'cz:recat';

/**
 * `/why`'s callback prefix (1.61; companion/src/why-menu.ts answers it). Here,
 * beside the other `cz:` payloads shared messages carry, because both syncers'
 * large-transaction alerts carry its 🔎 Why? button and `/changes` leads back
 * to a story through it. Written out for the reason `CATEGORIZE_ENTRY_CALLBACK`
 * is; a test asserts the two agree.
 */
export const WHY_CALLBACK_PREFIX = 'cz:wy:';
export const WHY_BUTTON_TEXT = '🔎 Why?';

/** A 🔎 Why? button: that transaction's story, sent as a NEW message so the
 *  message it sits on stays as it is. `cz:wy:t` plus a 36-character activity
 *  id is 43 bytes, inside Telegram's 64. */
export function whyButton(activityId: string): { text: string; callback_data: string } {
  return { text: WHY_BUTTON_TEXT, callback_data: `${WHY_CALLBACK_PREFIX}t${activityId}` };
}
```

Edit 1 of 2 in `shared/telegram-commands.ts` — /why joins More commands. Replace:

```ts
 *  `/changes` lists the change log; `/changes <words>` searches it. */
export const TELEGRAM_MORE_COMMANDS = [
```

with:

```ts
 *  `/changes` lists the change log; `/changes <words>` searches it.
 *  `/why <words or an amount>` (1.61) finds a transaction and tells its story;
 *  bare `/why` asks. */
export const TELEGRAM_MORE_COMMANDS = [
```

Edit 2 of 2 in `shared/telegram-commands.ts` — the /why line. Replace:

```ts
  { command: 'changes', description: 'What changed lately — /changes venmo searches' },
] as const;
```

with:

```ts
  { command: 'changes', description: 'What changed lately — /changes venmo searches' },
  { command: 'why', description: 'Why is this here? — /why kroger 54.20 finds a transaction and its story' },
] as const;
```

Edit 1 of 6 in `companion/src/changes-menu.ts` — imports. Replace:

```ts
import { escapeMarkdown, shortDateTime, type InlineKeyboard } from '../../shared/telegram.js';
```

with:

```ts
import { escapeMarkdown, shortDateTime, WHY_CALLBACK_PREFIX, type InlineKeyboard } from '../../shared/telegram.js';
```

Edit 2 of 6 in `companion/src/changes-menu.ts` — a /why story as a back. Replace:

```ts
  /** A button on an entry's screen: `u` undo, `r` redo, `f` undo rule + un-file, `s` sync now. */
  | { kind: 'act'; action: ChangeAction; entry: string; back: Exclude<ChangesView, { kind: 'detail' | 'act' }> };
```

with:

```ts
  /** A button on an entry's screen: `u` undo, `r` redo, `f` undo rule + un-file, `s` sync now. */
  | { kind: 'act'; action: ChangeAction; entry: string; back: Exclude<ChangesView, { kind: 'detail' | 'act' }> }
  /** 1.61: an entry opened from a `/why` story. Only ever a `back`: the entry's
   *  ‹ Back returns to that story, in place (`cz:wy:t<id>:c`, why-menu.ts).
   *  `cz:cl:d<handle>:w<36-char id>` is 53 bytes. */
  | { kind: 'why'; activityId: string };
```

Edit 3 of 6 in `companion/src/changes-menu.ts` — its encoding. Replace:

```ts
    case 'act': return `x${view.action}${view.entry}:${encodeView(view.back)}`;
  }
}
```

with:

```ts
    case 'act': return `x${view.action}${view.entry}:${encodeView(view.back)}`;
    case 'why': return `w${view.activityId}`;
  }
}
```

Edit 4 of 6 in `companion/src/changes-menu.ts` — its decoding: a back, never a screen. Replace:

```ts
  m = /^d([0-9a-f]{8}):(.+)$/s.exec(s);
  if (m && allowDetail) {
```

with:

```ts
  m = /^w([^:\s]{1,64})$/.exec(s);
  if (m) return allowDetail ? null : { kind: 'why', activityId: m[1] };
  m = /^d([0-9a-f]{8}):(.+)$/s.exec(s);
  if (m && allowDetail) {
```

Edit 5 of 6 in `companion/src/changes-menu.ts` — Back from an entry returns to the story. Replace:

```ts
  keyboard.push([{ text: '‹ Back', callback_data: changesData(back) }]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}
```

with:

```ts
  keyboard.push([{
    text: '‹ Back',
    callback_data: back.kind === 'why' ? `${WHY_CALLBACK_PREFIX}t${back.activityId}:c` : changesData(back),
  }]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}
```

Edit 6 of 6 in `companion/src/changes-menu.ts` — the list renderer takes only the two list views. Replace:

```ts
  const renderView = (read: ChangeLogRead, view: Exclude<ChangesView, { kind: 'detail' | 'run' | 'act' }>, now: Date) =>
```

with:

```ts
  const renderView = (read: ChangeLogRead, view: Extract<ChangesView, { kind: 'list' | 'search' }>, now: Date) =>
```

**Create `companion/src/why-menu.ts`:**

```ts
/**
 * companion/src/why-menu.ts
 *
 * `/why`: one transaction's story in Telegram (shared/tx-story.ts).
 * `/why <words and/or an amount>` searches every transaction; bare `/why`
 * asks for them (the R1 ask engine, like `/newrule`). Results are buttons,
 * 8 a page, newest first; a tap opens the story IN PLACE with ⬅️ Back to the
 * results. Each line of "What happened" is a numbered button into `/changes`'
 * entry view, where Undo lives; that view's ‹ Back returns to the story.
 *
 * A 🔎 Why? button elsewhere (the large-transaction alert, the `/categorize`
 * screen) sends the story as a NEW message, never editing the one it sits on;
 * so does the import notice's, which lists that sync's imports first.
 *
 * STATELESS, like changes-menu.ts: every tap re-reads, and every button
 * carries where it leads. After `cz:wy:`:
 *   s<page>:<query>            results, in place
 *   t<id>                      a story as a NEW message (a 🔎 Why? button)
 *   t<id>:c                    a story in place, back from /changes
 *   t<id>:s<page>:<query>      a story in place; Back to those results
 *   t<id>:r<handle>:<page>     a story in place; Back to a sync's imports
 *   r<handle>                  a sync's imports as a NEW message (the import notice)
 *   r<handle>:<page>           a sync's imports, in place
 * `<id>` is an activity id; `<handle>` is `findingHandle(runId)`. A query is
 * cut to WHY_QUERY_MAX_BYTES so the longest story button fits 64 bytes.
 *
 * Bank and user text is escaped AND kept outside every `*…*`/`_…_`; button
 * labels are plain text and are not escaped.
 */
import type { AskFlow } from '../../shared/ask-flow.js';
import { changeDay, changeMoney } from '../../shared/change-entries.js';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log.js';
import { findingHandle } from '../../shared/handle.js';
import { escapeMarkdown, shortDateTime, WHY_CALLBACK_PREFIX, type InlineKeyboard } from '../../shared/telegram.js';
import {
  isEmptyTxQuery, parseTxQuery, txQueryText, txSearchPage, TX_SEARCH_TOO_MANY, type TxQuery, type TxSearchResult,
} from '../../shared/tx-search.js';
import { TX_STORY_GONE, TX_STORY_NO_HISTORY, TX_STORY_UNREACHABLE, TX_STORY_WHAT_HAPPENED, type TxStory } from '../../shared/tx-story.js';
import { changesData } from './changes-menu.js';
import type { SearchOutcome, StoryOutcome } from './tx-story-host.js';

/** 64 − `cz:wy:t` (7) − a 36-character activity id − `:s0:` (4): the query
 *  every story button carries for its Back. */
export const WHY_QUERY_MAX_BYTES = 17;
export const WHY_TITLE = 'Why is this here?';
export const WHY_ASK_PROMPT = 'Which transaction? Send a few words or an amount.';
export const WHY_ASK_HINT = 'Send a few words from its description, an amount, or both.';
export const WHY_TAP_ONE = 'Tap one to see its story.';
export const WHY_RECENT_ONLY = "Searched the last 12 months — the companion couldn't read the database.";
export const WHY_RUN_TITLE = 'What this sync imported';
export const WHY_RUN_GONE = "That sync is past the change log's 90 days — search with /why.";
/** "What happened" lines one message shows: the newest ones. */
export const WHY_HISTORY_MAX = 20;
const FAILED_ANSWER = 'Could not do that — check the companion logs.';

type Button = { text: string; callback_data: string };
export interface MenuScreen { text: string; keyboard: InlineKeyboard }

/** Where a story's ⬅️ Back leads. `none`: a story sent as a new message;
 *  `changes`: reached from /changes' Back, in place, with no Back of its own. */
export type StoryBack =
  | { kind: 'none' }
  | { kind: 'changes' }
  | { kind: 'search'; page: number; query: string }
  | { kind: 'run'; run: string; page: number };

export type WhyView =
  | { kind: 'search'; page: number; query: string }
  | { kind: 'story'; activityId: string; back: StoryBack }
  /** `fresh`: from the import notice — sent as a new message. */
  | { kind: 'run'; run: string; page: number; fresh: boolean };

export function whyData(view: WhyView): string {
  switch (view.kind) {
    case 'search': return `${WHY_CALLBACK_PREFIX}s${view.page}:${view.query}`;
    case 'run': return `${WHY_CALLBACK_PREFIX}r${view.run}${view.fresh ? '' : `:${view.page}`}`;
    case 'story': {
      const b = view.back;
      const tail = b.kind === 'none' ? ''
        : b.kind === 'changes' ? ':c'
          : b.kind === 'search' ? `:s${b.page}:${b.query}`
            : `:r${b.run}:${b.page}`;
      return `${WHY_CALLBACK_PREFIX}t${view.activityId}${tail}`;
    }
  }
}

/** The view a button carries, or null for anything this menu never emitted. */
export function parseWhyData(data: string): WhyView | null {
  if (!data.startsWith(WHY_CALLBACK_PREFIX)) return null;
  const s = data.slice(WHY_CALLBACK_PREFIX.length);
  let m = /^s(\d):(.+)$/s.exec(s);
  if (m) return { kind: 'search', page: Number(m[1]), query: m[2] };
  m = /^r([0-9a-f]{8})$/.exec(s);
  if (m) return { kind: 'run', run: m[1], page: 0, fresh: true };
  m = /^r([0-9a-f]{8}):(\d)$/.exec(s);
  if (m) return { kind: 'run', run: m[1], page: Number(m[2]), fresh: false };
  m = /^t([^:\s]{1,64})$/.exec(s);
  if (m) return { kind: 'story', activityId: m[1], back: { kind: 'none' } };
  m = /^t([^:\s]{1,64}):c$/.exec(s);
  if (m) return { kind: 'story', activityId: m[1], back: { kind: 'changes' } };
  m = /^t([^:\s]{1,64}):s(\d):(.+)$/s.exec(s);
  if (m) return { kind: 'story', activityId: m[1], back: { kind: 'search', page: Number(m[2]), query: m[3] } };
  m = /^t([^:\s]{1,64}):r([0-9a-f]{8}):(\d)$/.exec(s);
  if (m) return { kind: 'story', activityId: m[1], back: { kind: 'run', run: m[2], page: Number(m[3]) } };
  return null;
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** A search as buttons carry it: words then the amount, single-spaced. Too
 *  long, it loses words from the end — never the amount — and a single word
 *  too long loses characters. Either way it only ever matches MORE. */
export function normalizeWhyQuery(raw: string): string {
  const q = parseTxQuery(raw);
  const words = [...q.words];
  const amount = q.amount ? [q.amount.text] : [];
  const text = () => [...words, ...amount].join(' ');
  while (bytes(text()) > WHY_QUERY_MAX_BYTES && words.length > (amount.length ? 0 : 1)) words.pop();
  let t = text();
  while (bytes(t) > WHY_QUERY_MAX_BYTES) t = Array.from(t).slice(0, -1).join('');
  return t.trim();
}

const clip = (s: string, n: number) => {
  const chars = Array.from(s);
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s;
};

/** A result's button: date · description · amount · account. */
function rowLabel(r: { date: string; description: string; amountCents: number; accountName: string }): string {
  return [changeDay(r.date), clip(r.description || 'A transaction', 28), changeMoney(r.amountCents), clip(r.accountName, 20)]
    .filter(Boolean).join(' · ');
}

function navRow(page: number, pages: number, at: (page: number) => string): Button[] {
  const nav: Button[] = [];
  if (page < pages - 1) nav.push({ text: '‹ Older', callback_data: at(page + 1) });
  if (page > 0) nav.push({ text: 'Newer ›', callback_data: at(page - 1) });
  return nav;
}

/** "Nothing matches", pointing at `/changes` for a removed transaction. Raw. */
export function whyNoMatch(q: TxQuery): string {
  return q.words.length
    ? `Nothing matches. If it was removed, try /changes ${q.words.join(' ')}.`
    : 'Nothing matches. If it was removed, try /changes with a word from its description.';
}

export function renderWhyResults(found: { result: TxSearchResult; recentOnly: boolean }, query: string, page: number): MenuScreen {
  const lines = [`🔎 *${WHY_TITLE}* ${escapeMarkdown(query)}`];
  if (found.recentOnly) lines.push(WHY_RECENT_ONLY);
  if (found.result.rows.length === 0) {
    lines.push('', escapeMarkdown(whyNoMatch(parseTxQuery(query))));
    return { text: lines.join('\n'), keyboard: { inline_keyboard: [] } };
  }
  const { slice, page: p, pages } = txSearchPage(found.result.rows, page);
  lines.push('', WHY_TAP_ONE);
  if (pages > 1) lines.push(`Page ${p + 1} of ${pages}`);
  if (found.result.truncated) lines.push(TX_SEARCH_TOO_MANY);
  const keyboard: Button[][] = slice.map((r) => [{
    text: rowLabel(r),
    callback_data: whyData({ kind: 'story', activityId: r.activityId, back: { kind: 'search', page: p, query } }),
  }]);
  const nav = navRow(p, pages, (n) => whyData({ kind: 'search', page: n, query }));
  if (nav.length) keyboard.push(nav);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

export function renderWhyStory(story: TxStory, activityId: string, back: StoryBack): MenuScreen {
  const lines = [`🔎 ${escapeMarkdown(story.title)}`];
  if (story.accountLine) lines.push(escapeMarkdown(story.accountLine));
  if (story.answer.length) lines.push('', ...story.answer.map(escapeMarkdown));
  const numbers: Button[] = [];
  if (story.history) {
    lines.push('', `*${TX_STORY_WHAT_HAPPENED}*`);
    if (story.history.length === 0) lines.push(TX_STORY_NO_HISTORY);
    const shown = story.history.slice(-WHY_HISTORY_MAX);
    const hidden = story.history.length - shown.length;
    if (hidden > 0) lines.push(`…and ${hidden} earlier — /changes lists them.`);
    shown.forEach((h, i) => {
      lines.push(`${i + 1}. ${escapeMarkdown(h.line)}`);
      numbers.push({
        text: String(i + 1),
        callback_data: changesData({ kind: 'detail', entry: findingHandle(h.entryId), back: { kind: 'why', activityId } }),
      });
    });
  }
  if (story.notes.length) lines.push('', ...story.notes.map((n) => `⚠️ ${escapeMarkdown(n)}`));
  const keyboard: Button[][] = [];
  for (let i = 0; i < numbers.length; i += 4) keyboard.push(numbers.slice(i, i + 4));
  if (back.kind === 'search') keyboard.push([{ text: '⬅️ Back', callback_data: whyData({ kind: 'search', page: back.page, query: back.query }) }]);
  if (back.kind === 'run') keyboard.push([{ text: '⬅️ Back', callback_data: whyData({ kind: 'run', run: back.run, page: back.page, fresh: false }) }]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** One sync's imports (its import entries in the log, newest first). */
export function renderWhyRun(entries: ChangeLogItem[], run: string, page: number): MenuScreen {
  const { slice, page: p, pages } = txSearchPage(entries, page);
  const lines = [`🔎 *${WHY_RUN_TITLE}*`, `_${shortDateTime(entries[0].at)}_`, '', WHY_TAP_ONE];
  if (pages > 1) lines.push(`Page ${p + 1} of ${pages}`);
  const keyboard: Button[][] = slice.map((e) => [{
    text: rowLabel({
      date: e.subject.date ?? e.at.slice(0, 10), description: e.subject.description ?? '',
      amountCents: e.subject.amountCents ?? 0, accountName: e.account?.name ?? '',
    }),
    callback_data: whyData({ kind: 'story', activityId: e.subject.activityIds![0], back: { kind: 'run', run, page: p } }),
  }]);
  const nav = navRow(p, pages, (n) => whyData({ kind: 'run', run, page: n, fresh: false }));
  if (nav.length) keyboard.push(nav);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** Bare `/why`: one question, then the results (index.ts registers it). */
export function buildWhyFlow(): AskFlow {
  return {
    id: 'why',
    command: 'why',
    title: WHY_TITLE,
    steps: [{
      id: 'query',
      kind: 'text',
      prompt: () => WHY_ASK_PROMPT,
      parse: (input) => (isEmptyTxQuery(parseTxQuery(input)) ? { ok: false, hint: WHY_ASK_HINT } : { ok: true, value: input }),
    }],
  };
}

type Send = (text: string, keyboard?: InlineKeyboard) => Promise<void>;

export interface WhyMenuUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
  /** A NEW message. */
  send: Send;
}

export interface WhyMenuDeps {
  search(query: TxQuery, now: Date): Promise<SearchOutcome>;
  story(activityId: string, now: Date): Promise<StoryOutcome>;
  /** The change log, for a sync's imports. Rejects when unreachable. */
  read(now: Date): Promise<ChangeLogRead>;
  now(): Date;
  log(msg: string): void;
}

export interface WhyMenu {
  handles(data: string): boolean;
  onCallback(cb: { data: string }, ui: WhyMenuUi): Promise<void>;
  /** `/why <text>` and the question's answer: the first page, as a reply. */
  reply(text: string, send: Send): Promise<void>;
  /** A 🔎 Why? from another menu: the story as a new message. */
  sendStory(activityId: string, send: Send): Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** An empty keyboard is sent as none. */
const sendScreen = (send: Send, s: MenuScreen) => (s.keyboard.inline_keyboard.length ? send(s.text, s.keyboard) : send(s.text));

export function createWhyMenu(deps: WhyMenuDeps): WhyMenu {
  const runImports = (read: ChangeLogRead, handle: string) =>
    read.entries.filter((e) => e.kind === 'import' && e.run && findingHandle(e.run) === handle && !!e.subject.activityIds?.[0]);

  return {
    handles(data) {
      return data.startsWith(WHY_CALLBACK_PREFIX);
    },

    async reply(text, send) {
      const query = normalizeWhyQuery(text);
      const q = parseTxQuery(query);
      if (isEmptyTxQuery(q)) return void await send(WHY_ASK_HINT);
      const out = await deps.search(q, deps.now());
      if (out.kind === 'unreachable') return void await send(TX_STORY_UNREACHABLE);
      await sendScreen(send, renderWhyResults(out, txQueryText(q), 0));
    },

    async sendStory(activityId, send) {
      const out = await deps.story(activityId, deps.now());
      if (out.kind === 'unreachable') return void await send(TX_STORY_UNREACHABLE);
      if (out.kind === 'gone') return void await send(TX_STORY_GONE);
      await sendScreen(send, renderWhyStory(out.story, activityId, { kind: 'none' }));
    },

    async onCallback(cb, ui) {
      try {
        const view = parseWhyData(cb.data);
        if (!view) return void await ui.answer();
        const now = deps.now();
        const show = async (screen: MenuScreen, fresh: boolean) => {
          if (fresh) await sendScreen(ui.send, screen);
          else await ui.edit(screen.text, screen.keyboard);
          await ui.answer();
        };
        switch (view.kind) {
          case 'search': {
            const out = await deps.search(parseTxQuery(view.query), now);
            if (out.kind === 'unreachable') return void await ui.answer(TX_STORY_UNREACHABLE);
            return void await show(renderWhyResults(out, view.query, view.page), false);
          }
          case 'story': {
            const out = await deps.story(view.activityId, now);
            if (out.kind === 'unreachable') return void await ui.answer(TX_STORY_UNREACHABLE);
            if (out.kind === 'gone') return void await ui.answer(TX_STORY_GONE);
            return void await show(renderWhyStory(out.story, view.activityId, view.back), view.back.kind === 'none');
          }
          case 'run': {
            let read: ChangeLogRead;
            try {
              read = await deps.read(now);
            } catch (err) {
              deps.log(`Why menu: reading the change log failed: ${message(err)}`);
              return void await ui.answer(TX_STORY_UNREACHABLE);
            }
            const entries = runImports(read, view.run);
            if (entries.length === 0) return void await ui.answer(WHY_RUN_GONE);
            return void await show(renderWhyRun(entries, view.run, view.page), view.fresh);
          }
        }
      } catch (err) {
        deps.log(`Why menu: ${cb.data} failed: ${message(err)}`);
        await ui.answer(FAILED_ANSWER).catch(() => {});
      }
    },
  };
}
```

Edit 1 of 8 in `companion/src/index.ts` — imports. Replace:

```ts
import { createChangesMenu, renderChangesCommand, CHANGES_UNREACHABLE_REPLY, type ChangesMenu } from './changes-menu.js';
```

with:

```ts
import { createChangesMenu, renderChangesCommand, CHANGES_UNREACHABLE_REPLY, type ChangesMenu } from './changes-menu.js';
import { buildWhyFlow, createWhyMenu, type WhyMenu } from './why-menu.js';
import { companionStoryReaders, companionTxSearch, companionTxStory } from './tx-story-host.js';
```

Edit 2 of 8 in `companion/src/index.ts` — `buildWhyMenu`, before the question flows. Replace:

```ts
/**
 * The bot's question flows, registered on ONE session holder. Like the
```

with:

```ts
/**
 * `/why` (1.61): one transaction's story. Stateless — every tap re-reads — so
 * any number of instances answer alike, and the categorize screen's 🔎 Why?
 * can build its own.
 */
export function buildWhyMenu(wfClient: WealthfolioClient): WhyMenu {
  const readers = () => companionStoryReaders(wfClient, wealthfolioDbPath());
  return createWhyMenu({
    search: (query, now) => companionTxSearch(readers(), query, now),
    story: (activityId, now) => companionTxStory(readers(), activityId, now),
    read: (now) => readCompanionChangeLog(wfClient, now),
    now: () => new Date(),
    log,
  });
}

/**
 * The bot's question flows, registered on ONE session holder. Like the
```

Edit 3 of 8 in `companion/src/index.ts` — `buildAskSessions` registers the /why question. Replace:

```ts
export function buildAskSessions(wfClient: WealthfolioClient, controller: CategorizeController): AskSessions {
```

with:

```ts
export function buildAskSessions(
  wfClient: WealthfolioClient,
  controller: CategorizeController,
  why: WhyMenu = buildWhyMenu(wfClient),
): AskSessions {
```

Edit 4 of 8 in `companion/src/index.ts` — the /why question, beside /afford's. Replace:

```ts
  asks.register('afford', async () => {
```

with:

```ts
  // Bare /why (1.61): one question, then the results as a new message.
  asks.register('why', async () => ({
    flow: buildWhyFlow(),
    onDone: (a, send) => why.reply(a.query as string, send),
  }));
  asks.register('afford', async () => {
```

Edit 5 of 8 in `companion/src/index.ts` — the command handler takes the menu. Replace:

```ts
  controller: CategorizeController = buildCategorizeController(wfClient),
  asks: AskSessions = buildAskSessions(wfClient, controller),
): (cmd: ParsedCommand, reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>) => Promise<void> {
```

with:

```ts
  controller: CategorizeController = buildCategorizeController(wfClient),
  asks: AskSessions = buildAskSessions(wfClient, controller),
  why: WhyMenu = buildWhyMenu(wfClient),
): (cmd: ParsedCommand, reply: (text: string, keyboard?: InlineKeyboard) => Promise<void>) => Promise<void> {
```

Edit 6 of 8 in `companion/src/index.ts` — the /why command. Replace:

```ts
        const screen = renderChangesCommand(read, cmd.args, now);
        await reply(screen.text, screen.keyboard);
        return;
      }
```

with:

```ts
        const screen = renderChangesCommand(read, cmd.args, now);
        await reply(screen.text, screen.keyboard);
        return;
      }

      case 'why': {
        // Bare /why asks (1.61), like /newrule; words or an amount search.
        if (cmd.args.trim() === '') {
          await asks.start('why', reply);
          return;
        }
        await why.reply(cmd.args, reply);
        return;
      }
```

Edit 7 of 8 in `companion/src/index.ts` — the listener builds one /why menu for commands, questions and taps. Replace:

```ts
  /** ONE question slot for commands, plain answers and taps alike. */
  const asks = buildAskSessions(wfClient, categorize);
  const runCommand = buildTelegramCommandHandler(wfClient, categorize, asks);
```

with:

```ts
  /** `/why`: stateless, but one instance serves commands, answers and taps. */
  const why = buildWhyMenu(wfClient);
  /** ONE question slot for commands, plain answers and taps alike. */
  const asks = buildAskSessions(wfClient, categorize, why);
  const runCommand = buildTelegramCommandHandler(wfClient, categorize, asks, why);
```

Edit 8 of 8 in `companion/src/index.ts` — `cz:wy:` taps, before the transaction menu's fallthrough. Replace:

```ts
      // `cz:cl:` likewise, before the transaction menu's fallthrough.
      if (changes.handles(cb.data)) {
        await changes.onCallback(cb, ui);
        return;
      }
```

with:

```ts
      // `cz:cl:` likewise, before the transaction menu's fallthrough.
      if (changes.handles(cb.data)) {
        await changes.onCallback(cb, ui);
        return;
      }
      // `cz:wy:` (1.61) likewise.
      if (why.handles(cb.data)) {
        await why.onCallback(cb, ui);
        return;
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run src/why-menu.test.ts src/changes-menu.test.ts src/changes-menu-undo.test.ts src/index.test.ts src/ask-session.test.ts`
Expected: PASS — 365 tests.

Run: `npx vitest run shared/telegram-commands.test.ts`
Expected: PASS — 134 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/why-menu.ts companion/src/why-menu.test.ts shared/telegram.ts shared/telegram-commands.ts shared/telegram-commands.test.ts companion/src/changes-menu.ts companion/src/changes-menu.test.ts companion/src/index.ts companion/src/index.test.ts
git commit -m "Bot: /why finds a transaction and tells its story; its history opens /changes and comes back

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 🔎 Why? on the `/categorize` screen, the large-transaction alert and the import notice

The three buttons (spec A2, W1d, W4). Each sends the story as a NEW message; none edits the message it sits on. **`/categorize` and `/recategorize`:** the transaction screen offers `🔎 Why?` when the controller can tell a story — a session flag (`MenuSession.why`) set from a new optional `CategorizeDeps.why`, so every existing session and test is unchanged — and the tap is a `MenuAction` (`{ kind: 'why', activityId }`) the controller answers with `deps.why(activityId, ui.send)`, leaving its session and buttons as they were. **The alert:** the sync core records the created row's id on each alert (optional `activityId`); the companion attaches `whyButton(id)` when it has one. The outbox stores alerts verbatim, so a queued alert keeps the id (its test already passes and pins that). **The import notice:** `sendImportNotice` takes the sync's run id (optional) and, with it, adds a last row `🔎 Why?` → `cz:wy:r<findingHandle(run)>`, which Task 5's menu answers with that run's imports from the log.

**Files:**
- Modify: `shared/categorize-menu.ts`, `shared/sync-core.ts`, `companion/src/categorize.ts`, `companion/src/index.ts`
- Test: `shared/categorize-menu.test.ts`, `shared/sync-core.test.ts`, `companion/src/categorize.test.ts`, `companion/src/index.test.ts`

**Interfaces:**
- Consumes: Task 5 (`WHY_BUTTON_TEXT`, `WHY_CALLBACK_PREFIX`, `whyButton`, `buildWhyMenu`, `WhyMenu.sendStory`); `findingHandle` (shared/handle.ts); existing `sendTelegramMessage(botToken, chatId, text, network?, replyMarkup?)`.
- Produces:

```ts
// shared/categorize-menu.ts
interface MenuSession { /* … */ why?: boolean }
type MenuAction = /* … */ | { kind: 'why'; activityId: string };
// companion/src/categorize.ts
interface CategorizeDeps { /* … */ why?: (activityId: string, send: (text: string, keyboard?: InlineKeyboard) => Promise<void>) => Promise<void> }
// shared/sync-core.ts
SyncResult['largeTransactionAlerts'][number]: { txId; description; amountCents; currency; accountName; activityId?: string }
// companion/src/index.ts
export async function sendImportNotice(wfClient, tg, result, transfers?: TransferLearning, run?: string): Promise<void>;
```

- [ ] **Step 1: Write the failing tests**

Edit 1 of 1 in `shared/categorize-menu.test.ts` — the transaction screen's 🔎 Why?, after the Back test. Replace:

```ts
  it('has a « Back button that returns to the list', () => {
    const s = session({ screen: { kind: 'txn', activityId: 'act-1' } });
    const { keyboard, buttons } = renderScreen(s);
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === '‹ Back');
    expect(buttons[idx]).toEqual({ kind: 'goto', screen: { kind: 'list', page: 0 } });
  });
```

with:

```ts
  it('has a « Back button that returns to the list', () => {
    const s = session({ screen: { kind: 'txn', activityId: 'act-1' } });
    const { keyboard, buttons } = renderScreen(s);
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === '‹ Back');
    expect(buttons[idx]).toEqual({ kind: 'goto', screen: { kind: 'list', page: 0 } });
  });

  it('offers 🔎 Why? for this transaction when the controller can tell its story (1.61)', () => {
    const { keyboard, buttons } = renderScreen(session({ why: true, screen: { kind: 'txn', activityId: 'act-1' } }));
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === '🔎 Why?');
    expect(buttons[idx]).toEqual({ kind: 'why', activityId: 'act-1' });
    const without = renderScreen(session({ screen: { kind: 'txn', activityId: 'act-1' } }));
    expect(without.keyboard.inline_keyboard.flat().map((b) => b.text)).not.toContain('🔎 Why?');
  });
```

Edit 1 of 1 in `companion/src/categorize.test.ts` — 🔎 Why? sends the story and leaves the screen, before the taxonomy tests. Replace:

```ts
describe('the taxonomy the whole feature writes into', () => {
```

with:

```ts
describe('🔎 Why? on the transaction screen (1.61)', () => {
  it('sends the story as a new message and leaves the screen as it is', async () => {
    const h = setup();
    const why = vi.fn(async () => {});
    const controller = createCategorizeController({ ...h.deps, why });
    const tap = (data: string) => controller.onCallback({ data, chatId: CHAT, messageId: 55 }, h.ui);
    await controller.open(h.send);
    await tap(dataFor(keyboardOf(lastCall(h.send)), 'BOOK STORES a'));
    const picker = keyboardOf(lastCall(h.ui.edit));
    const edits = h.ui.edit.mock.calls.length;
    await tap(dataFor(picker, '🔎 Why?'));
    expect(why).toHaveBeenCalledWith('a', h.ui.send);
    expect(h.ui.edit.mock.calls.length).toBe(edits);
    expect(h.ui.answer).toHaveBeenLastCalledWith();
    // The screen's own buttons still work afterwards.
    await tap(dataFor(picker, 'Entertainment'));
    expect(h.deps.assign).toHaveBeenCalledWith('a', 'cat-fun');
  });

  it('is offered on /recategorize’s screen too', async () => {
    const h = setup({ categorized: [catRow('a', [spendingAt('cat-fun', 'Entertainment')], REIMBURSED)] });
    const controller = createCategorizeController({ ...h.deps, why: vi.fn(async () => {}) });
    await controller.openRecategorize(undefined, h.send);
    await controller.onCallback({ data: dataFor(keyboardOf(lastCall(h.send)), 'VENMO PAYMENT a'), chatId: CHAT, messageId: 55 }, h.ui);
    expect(labels(keyboardOf(lastCall(h.ui.edit)))).toContain('🔎 Why?');
  });

  it('is not offered when nothing can tell the story', async () => {
    const picker = await openAtTxn(setup());
    expect(labels(picker)).not.toContain('🔎 Why?');
  });
});

describe('the taxonomy the whole feature writes into', () => {
```

Edit 1 of 1 in `shared/sync-core.test.ts` — the alert carries the row it created. Replace:

```ts
  it('reports a large-transaction alert for a newly-created spending row over the threshold', async () => {
    const { host, store } = createFakeHost(largeSpendSeed());
    const result = await runSyncCore(host, store, {});
    expect(result.largeTransactionAlerts).toEqual([{
      txId: 'tx-1',
      description: 'AMAZON *MKTPLACE',
      amountCents: 124000,
      currency: 'USD',
      accountName: 'Spend',
    }]);
  });
```

with:

```ts
  it('reports a large-transaction alert for a newly-created spending row over the threshold, with the row it created', async () => {
    const { host, store, activities } = createFakeHost(largeSpendSeed());
    const result = await runSyncCore(host, store, {});
    const created = activities.get('wf-a')!.find((a) => (a.comment ?? '').endsWith('tx-1'))!;
    expect(result.largeTransactionAlerts).toEqual([{
      txId: 'tx-1',
      description: 'AMAZON *MKTPLACE',
      amountCents: 124000,
      currency: 'USD',
      accountName: 'Spend',
      // 1.61: the alert's 🔎 Why? opens this row's story.
      activityId: created.id,
    }]);
  });
```

Edit 1 of 2 in `companion/src/index.test.ts` — the alert's 🔎 Why?, and the outbox keeps the id. Replace:

```ts
  it('keeps an undelivered alert queued and re-sends it on the next sync', async () => {
```

with:

```ts
  it('carries a 🔎 Why? button when the alert knows its row (1.61), and none on an older queued one', async () => {
    const older = { txId: 'tx-0', description: 'Roof repair', amountCents: 250099, currency: 'USD', accountName: 'Spend' };
    secrets.set('pending_large_tx_alerts', JSON.stringify([older]));
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], stuckTransferAlerts: [], balanceDriftAlerts: [],
      largeTransactionAlerts: [{
        txId: 'tx-1', description: 'DELTA AIR LINES', amountCents: 124000, currency: 'USD', accountName: 'Spend',
        activityId: '0f8fad5b-d9cb-469f-a165-708677289501',
      }],
    });
    await client();
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    const bodies = fetchMock.mock.calls.map((c: any[]) => JSON.parse(c[1].body));
    expect(bodies[0]).not.toHaveProperty('reply_markup');
    expect(bodies[1].reply_markup).toEqual({
      inline_keyboard: [[{ text: '🔎 Why?', callback_data: 'cz:wy:t0f8fad5b-d9cb-469f-a165-708677289501' }]],
    });
  });

  it('queues an undelivered alert with its activity id, so the retry still has the button', async () => {
    const alert = {
      txId: 'tx-1', description: 'DELTA AIR LINES', amountCents: 124000, currency: 'USD', accountName: 'Spend', activityId: 'act-1',
    };
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], prunedDuplicates: [], unmappedAccounts: [], refusedCreates: [], stuckTransferAlerts: [], balanceDriftAlerts: [],
      largeTransactionAlerts: [alert],
    });
    await client();
    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ ok: false, description: 'Too Many Requests' }) })));

    await runCompanionSync();

    expect(JSON.parse(secrets.get('pending_large_tx_alerts')!)).toEqual([alert]);
  });

  it('keeps an undelivered alert queued and re-sends it on the next sync', async () => {
```

Edit 2 of 2 in `companion/src/index.test.ts` — the import notice's 🔎 Why? lists that sync's imports. Replace:

```ts
  it('does not erase a dismissal the addon wrote after this run\'s first read', async () => {
```

with:

```ts
  it('offers 🔎 Why? for this sync’s imports when it knows the run (1.61), as the last row', async () => {
    vi.mocked(getNativeUncategorizedSpending).mockReturnValue([uncatRow('act-1', 'VENMO PAYMENT')]);
    const fetchMock = vi.fn((_url: any, _init?: any) => Promise.resolve({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    const client: any = { getAddonSecret: vi.fn(async () => null), setAddonSecret: vi.fn(async () => {}) };

    await sendImportNotice(client, { botToken: 'T', chatId: '9' }, {
      imported: 1, importedTransactions: [importedTx],
    } as any, undefined, 'c1a2b3c4d');

    const body = JSON.parse((fetchMock.mock.calls.find((c: any[]) => String(c[0]).includes('sendMessage'))![1] as any).body);
    expect(body.reply_markup.inline_keyboard.at(-1)).toEqual([
      { text: '🔎 Why?', callback_data: `cz:wy:r${findingHandle('c1a2b3c4d')}` },
    ]);
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('d:act-1');
  });

  it('does not erase a dismissal the addon wrote after this run\'s first read', async () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/categorize-menu.test.ts shared/sync-core.test.ts`
Expected: FAIL — 2 tests: no 🔎 Why? on the screen, and no `activityId` on the alert.

Run: `cd companion && npx vitest run src/categorize.test.ts src/index.test.ts`
Expected: FAIL — 4 tests: the two categorize ones, the alert's button, and the notice's button. (`queues an undelivered alert with its activity id…` passes already: the outbox stores the alert as given.)

- [ ] **Step 3: Implement**

Edit 1 of 2 in `shared/sync-core.ts` — the alert's type gains the created row's id. Replace:

```ts
    /** The Wealthfolio account the row landed in, by name (falling back to the
     *  SimpleFin account name on a host that reports no name). */
    accountName: string;
  }>;
  /** Accounts that opened a new drift episode this run — a TRUSTWORTHY drift
```

with:

```ts
    /** The Wealthfolio account the row landed in, by name (falling back to the
     *  SimpleFin account name on a host that reports no name). */
    accountName: string;
    /** 1.61: the row this run created — the alert's 🔎 Why? opens its story.
     *  Absent on an alert an older build queued in the outbox. */
    activityId?: string;
  }>;
  /** Accounts that opened a new drift episode this run — a TRUSTWORTHY drift
```

Edit 2 of 2 in `shared/sync-core.ts` — filled from the create echo. Replace:

```ts
            largeTransactionAlerts.push({
              txId,
              description: descByKey.get(accountTxKey(sfAccount.id, txId)) ?? '',
              amountCents: t.absCents,
              currency: sfAccount.currency,
              accountName: wfNames.get(t.wfAccountId) || sfAccount.name,
            });
```

with:

```ts
            largeTransactionAlerts.push({
              txId,
              description: descByKey.get(accountTxKey(sfAccount.id, txId)) ?? '',
              amountCents: t.absCents,
              currency: sfAccount.currency,
              accountName: wfNames.get(t.wfAccountId) || sfAccount.name,
              activityId: a.id,
            });
```

Edit 1 of 4 in `shared/categorize-menu.ts` — imports. Replace:

```ts
import { moneyWhole, escapeMarkdown } from './telegram.js';
```

with:

```ts
import { moneyWhole, escapeMarkdown, WHY_BUTTON_TEXT } from './telegram.js';
```

Edit 2 of 4 in `shared/categorize-menu.ts` — the session says whether a story can be told. Replace:

```ts
  mode?: 'categorize' | 'recategorize';
}
```

with:

```ts
  mode?: 'categorize' | 'recategorize';
  /** 1.61: the controller can send a transaction's story, so the transaction
   *  screen offers 🔎 Why?. Absent: no button, exactly as before. */
  why?: boolean;
}
```

Edit 3 of 4 in `shared/categorize-menu.ts` — the action. Replace:

```ts
  | { kind: 'undoReassign'; activityId: string; toRestore: readonly TaxonomyAssignment[] };
```

with:

```ts
  | { kind: 'undoReassign'; activityId: string; toRestore: readonly TaxonomyAssignment[] }
  /** 1.61: send this transaction's story as a NEW message; the screen stays. */
  | { kind: 'why'; activityId: string };
```

Edit 4 of 4 in `shared/categorize-menu.ts` — the button, above ‹ Back. Replace:

```ts
    ...(isRecategorize ? [] : [[{ text: 'Keep uncategorized', action: { kind: 'dismiss' as const, activityId } }]]),
    [{ text: '‹ Back', action: { kind: 'goto', screen: { kind: 'list', page: 0 } } }],
```

with:

```ts
    ...(isRecategorize ? [] : [[{ text: 'Keep uncategorized', action: { kind: 'dismiss' as const, activityId } }]]),
    ...(session.why ? [[{ text: WHY_BUTTON_TEXT, action: { kind: 'why' as const, activityId } }]] : []),
    [{ text: '‹ Back', action: { kind: 'goto', screen: { kind: 'list', page: 0 } } }],
```

Edit 1 of 3 in `companion/src/categorize.ts` — the dep. Replace:

```ts
  record?: (draft: ChangeDraft) => void;
```

with:

```ts
  record?: (draft: ChangeDraft) => void;
  /** 1.61: the transaction screen's 🔎 Why? — sends that transaction's story
   *  as a NEW message (companion/src/why-menu.ts). Optional: without it the
   *  button is not offered. */
  why?: (activityId: string, send: (text: string, keyboard?: InlineKeyboard) => Promise<void>) => Promise<void>;
```

Edit 2 of 3 in `companion/src/categorize.ts` — sessions offer the button when the dep exists. Replace:

```ts
      buttons: [],
      generation: nextGeneration(),
      mode,
    };
  }
```

with:

```ts
      buttons: [],
      generation: nextGeneration(),
      mode,
      ...(deps.why ? { why: true } : {}),
    };
  }
```

Edit 3 of 3 in `companion/src/categorize.ts` — the tap: a new message, the screen untouched. Replace:

```ts
      case 'goto':
        await transition(chat, action.screen, carryPin(chat, action.screen), ui);
        return;
```

with:

```ts
      case 'goto':
        await transition(chat, action.screen, carryPin(chat, action.screen), ui);
        return;

      case 'why':
        // A NEW message: the screen, its session and its buttons stay exactly
        // as they were, so the next tap on it still works.
        await deps.why?.(action.activityId, ui.send);
        return;
```

Edit 1 of 6 in `companion/src/index.ts` — imports. Replace:

```ts
import { buildWhyFlow, createWhyMenu, type WhyMenu } from './why-menu.js';
```

with:

```ts
import { buildWhyFlow, createWhyMenu, type WhyMenu } from './why-menu.js';
import { findingHandle } from '../../shared/handle.js';
import { whyButton, WHY_BUTTON_TEXT, WHY_CALLBACK_PREFIX } from '../../shared/telegram.js';
```

Edit 2 of 6 in `companion/src/index.ts` — the alert carries 🔎 Why? when it knows its row. Replace:

```ts
        const result = await sendTelegramMessage(
          tg.botToken,
          tg.chatId,
          formatLargeTransactionAlert(alert),
        );
```

with:

```ts
        const result = await sendTelegramMessage(
          tg.botToken,
          tg.chatId,
          formatLargeTransactionAlert(alert),
          undefined,
          // 1.61: the story, as a new message. An alert an older build queued
          // has no row id, and goes out as it always did.
          alert.activityId ? { inline_keyboard: [[whyButton(alert.activityId)]] } : undefined,
        );
```

Edit 3 of 6 in `companion/src/index.ts` — the notice takes the sync's run id. Replace:

```ts
  transfers?: TransferLearning,
): Promise<void> {
  // Read the ledger BEFORE the sweep, because it is what filters the notice.
```

with:

```ts
  transfers?: TransferLearning,
  /** 1.61: this sync's change-log run id — the notice's 🔎 Why? lists the
   *  run's imports from the log. Absent: no such button. */
  run?: string,
): Promise<void> {
  // Read the ledger BEFORE the sweep, because it is what filters the notice.
```

Edit 4 of 6 in `companion/src/index.ts` — the notice's 🔎 Why? row. Replace:

```ts
  if (transferRow) keyboard.inline_keyboard.push(transferRow);
```

with:

```ts
  if (transferRow) keyboard.inline_keyboard.push(transferRow);
  // Last: one button for the whole sync — it lists the run's imports (from the
  // change log), and each opens its story.
  if (run) keyboard.inline_keyboard.push([{ text: WHY_BUTTON_TEXT, callback_data: `${WHY_CALLBACK_PREFIX}r${findingHandle(run)}` }]);
```

Edit 5 of 6 in `companion/src/index.ts` — the sync hands the notice its run. Replace:

```ts
              await sendImportNotice(wfClient, tg, result, sharedTransferLearning ?? undefined);
```

with:

```ts
              await sendImportNotice(wfClient, tg, result, sharedTransferLearning ?? undefined, changeLog.run);
```

Edit 6 of 6 in `companion/src/index.ts` — the categorize screen's 🔎 Why? sends the story. Replace:

```ts
    readIncomeCategories: getNativeIncomeCategories,
```

with:

```ts
    readIncomeCategories: getNativeIncomeCategories,
    // 1.61: the transaction screen's 🔎 Why? — the story as a new message.
    why: (activityId, send) => buildWhyMenu(wfClient).sendStory(activityId, send),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/categorize-menu.test.ts shared/sync-core.test.ts shared/telegram.test.ts`
Expected: PASS — 489 tests.

Run: `cd companion && npx vitest run src/categorize.test.ts src/index.test.ts src/why-menu.test.ts`
Expected: PASS — 435 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/categorize-menu.ts shared/categorize-menu.test.ts shared/sync-core.ts shared/sync-core.test.ts companion/src/categorize.ts companion/src/categorize.test.ts companion/src/index.ts companion/src/index.test.ts
git commit -m "Bot: 🔎 Why? on the categorize screen, large-transaction alerts and import notices

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The add-on gathers what it can see, and searches through the SDK

`src/utils/tx-story.ts` (spec B "App", C4, W1a, W6). `appTxStory` reads the row by id (`activityIds` — W1a, checked against the id it gets back), the account type, the mapping, the change log, the overrides and the skip list, each optional-called and wrapped. The SDK has no categories and no groups, so: the partner is the newest not-undone `transfer-link` entry's other leg, else the add-on's own `linked_groups` (named through the mapping); a grouped or transfer-typed row whose partner it cannot see gets no "what it is" line. The filer comes from what the caller or the add-on can read — a drill row's category and `f` (`withFilingDay` adds the day of your Telegram filing from the log), the cube's drill-down, the companion's needs-a-category list — and otherwise the story points at Telegram when a companion has published a version, or says "Category set in Wealthfolio." `appTxSearch` hands Wealthfolio the one safe keyword and matches here, or reads the last 12 months and stops at older rows; it never reads more than it needs past 40 matches.

**Files:**
- Create: `src/utils/tx-story.ts`, `src/utils/tx-story.test.ts`

**Interfaces:**
- Consumes: Task 1 (`changesForTransaction`, `findTransactions`, `isEmptyTxQuery`, `matchesTxQuery`, `txDescription`, `txSearchKeyword`, `TX_SEARCH_MAX_RESULTS`, `TX_SEARCH_RECENT_DAYS`); Task 2 (`buildTxStory`, `decodeFiler`, `signedCents`, `withFilingDay`, `TxFactName`, `TxStory`, `TxStoryFacts`); Task 3 (`DrillTx.i`/`f` via `store.getReportCube`); `SecretsStore` methods `getAccountMapping`, `getChangeLog`, `readSyncOverrides`, `getSkippedTransactions`, `getLinkedGroups`, `getCompanionVersion`, `getUncategorizedStatus`, `getReportCube` (all existing, all optional-called); `hasTxOverride`, `TX_OVERRIDE_FLAGS`; `accountTxKey`; `txIdFromComment`, `isTransferType`.
- Produces:

```ts
export interface AppStoryTarget { activityId: string; categoryName?: string; filer?: string }
export type StoryStore = Partial<Pick<SecretsStore, 'getAccountMapping' | 'getChangeLog' | 'readSyncOverrides' | 'getSkippedTransactions'
  | 'getLinkedGroups' | 'getCompanionVersion' | 'getUncategorizedStatus' | 'getReportCube'>>;
export type AppStoryOutcome = { kind: 'ok'; story: TxStory; entries: ChangeLogItem[] } | { kind: 'gone' } | { kind: 'unreachable' };
export type AppSearchOutcome = { kind: 'ok'; result: TxSearchResult } | { kind: 'unreachable' };
export function appTxStory(ctx: AddonContext, store: StoryStore, target: AppStoryTarget, now: Date): Promise<AppStoryOutcome>;
export function appTxSearch(ctx: AddonContext, query: TxQuery, now: Date): Promise<AppSearchOutcome>;
```

- [ ] **Step 1: Write the failing tests**

**Create `src/utils/tx-story.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { categoryFiledChange, importChange, stampChange, transferLinkChange } from '../../shared/change-entries';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log';
import { emptySyncOverrides } from '../../shared/sync-overrides';
import { accountTxKey } from '../../shared/transfers';
import { parseTxQuery } from '../../shared/tx-search';
import {
  TX_FACT_NOTES, TX_STORY_ASK_TELEGRAM, TX_STORY_NOT_FILED, TX_STORY_SET_IN_WEALTHFOLIO, TX_STORY_SPENDING,
} from '../../shared/tx-story';
import { appTxSearch, appTxStory, type StoryStore } from './tx-story';

const NOW = new Date('2026-10-13T16:00:00Z');
const KEY = accountTxKey('ACT-chk', 'TRN-1');

/** `activities.search` rows as the SDK hands them back (`ActivityDetails`). */
const detail = (over: Record<string, unknown> = {}) => ({
  id: 'act-1', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'WITHDRAWAL',
  date: '2026-10-04T04:00:00.000Z', amount: '54.20', comment: 'KROGER #415 · TRN-1', ...over,
});

function ctxWith(search: (...args: any[]) => any) {
  return {
    api: {
      activities: { search: vi.fn(search) },
      accounts: { getAll: vi.fn(async () => [
        { id: 'wf-chk', name: 'PNC Checking', accountType: 'CASH' },
        { id: 'wf-ally', name: 'Ally Savings', accountType: 'CASH' },
      ]) },
    },
  } as any;
}

const logOf = (...entries: ChangeLogItem[]): ChangeLogRead => ({ entries, gaps: [], trimmed: 0, unreadable: [] });
const imported = stampChange(importChange({
  account: { sfinId: 'ACT-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKey: KEY, activityId: 'act-1',
  description: 'KROGER #415', amountCents: -5420, date: '2026-10-04', pending: false, activityType: 'WITHDRAWAL',
}), 'companion', new Date('2026-10-04T12:00:00Z'));

const store = (over: Partial<StoryStore> = {}): StoryStore => ({
  getAccountMapping: vi.fn(async () => ({ 'ACT-chk': 'wf-chk', 'ACT-ally': 'wf-ally' })),
  getChangeLog: vi.fn(async () => logOf(imported)),
  readSyncOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: false })),
  getSkippedTransactions: vi.fn(async () => []),
  getLinkedGroups: vi.fn(async () => ({})),
  getCompanionVersion: vi.fn(async () => '1.61.0'),
  getUncategorizedStatus: vi.fn(async () => null),
  getReportCube: vi.fn(async () => null),
  ...over,
});

const byId = (rows: any[]) => async (_p: number, _s: number, filters: any) =>
  ({ data: rows.filter((r) => r.id === filters.activityIds?.[0]), meta: { totalRowCount: 1 } });

describe('appTxStory', () => {
  it('reads the row by its id and tells what the add-on can see, pointing at Telegram for the filer', async () => {
    const ctx = ctxWith(byId([detail()]));
    const out = await appTxStory(ctx, store(), { activityId: 'act-1' }, NOW);
    expect(ctx.api.activities.search).toHaveBeenCalledWith(0, 1, { activityIds: ['act-1'] }, '');
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.story.title).toBe('KROGER #415 · -$54.20 · Oct 4');
    expect(out.story.answer).toEqual(['From your PNC Checking bank feed.', TX_STORY_SPENDING, TX_STORY_ASK_TELEGRAM]);
    expect(out.story.history).toEqual([{ entryId: imported.id, line: 'Oct 4 · Imported KROGER #415' }]);
    expect(out.entries).toEqual([imported]);
  });

  it('without a companion says the category was set in Wealthfolio', async () => {
    const out = await appTxStory(ctxWith(byId([detail()])), store({ getCompanionVersion: vi.fn(async () => null) }), { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.answer[2]).toBe(TX_STORY_SET_IN_WEALTHFOLIO);
  });

  it('a drill-down row brings its category and who filed it; "you" takes its day from the log', async () => {
    const filed = stampChange(categoryFiledChange({
      actor: 'you', activityId: 'act-1', description: 'KROGER #415', before: null, after: { categoryId: 'cat-gro', categoryName: 'Groceries' },
    }), 'companion', new Date('2026-10-05T12:00:00Z'));
    const out = await appTxStory(ctxWith(byId([detail()])), store({ getChangeLog: vi.fn(async () => logOf(imported, filed)) }),
      { activityId: 'act-1', categoryName: 'Food', filer: 'y' }, NOW);
    expect(out.kind === 'ok' && out.story.answer[2]).toBe('Filed under Food by you, in Telegram, Oct 5.');
  });

  it('finds the filer in the report cube when the row is in its drill-down', async () => {
    const cube = { drill: { Groceries: [{ d: '2026-10-04', n: 'KROGER #415', c: 5420, a: 'PNC Checking', i: 'act-1', f: 'r:KROGER' }] } };
    const out = await appTxStory(ctxWith(byId([detail()])), store({ getReportCube: vi.fn(async () => cube as any) }), { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.answer[2]).toBe("Filed under Groceries by a rule — 'KROGER' matches it.");
  });

  it('says a row on the companion’s needs-a-category list is not filed yet', async () => {
    const status = { count: 1, asOf: '', rows: [{ activityId: 'act-1', description: 'KROGER', amountCents: 5420, date: '2026-10-04', accountName: 'PNC Checking' }] };
    const out = await appTxStory(ctxWith(byId([detail()])), store({ getUncategorizedStatus: vi.fn(async () => status as any) }), { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.answer[2]).toBe(TX_STORY_NOT_FILED);
  });

  it('names the other half of a transfer from the change log’s link', async () => {
    const link = stampChange(transferLinkChange(
      { account: { sfinId: 'ACT-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKey: KEY, description: 'TRANSFER TO ALLY', amountCents: -60000, date: '2026-10-04', oldActivityId: 'o1', newActivityId: 'act-1' },
      { account: { sfinId: 'ACT-ally', wfId: 'wf-ally', name: 'Ally Savings' }, txKey: accountTxKey('ACT-ally', 'TRN-2'), description: 'FROM PNC', amountCents: 60000, date: '2026-10-04', oldActivityId: 'o2', newActivityId: 'act-2' },
    ), 'companion', new Date('2026-10-04T13:00:00Z'));
    const ctx = ctxWith(byId([detail({ activityType: 'TRANSFER_OUT', amount: '600', comment: 'TRANSFER TO ALLY · TRN-1' })]));
    const out = await appTxStory(ctx, store({ getChangeLog: vi.fn(async () => logOf(link)) }), { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.answer.slice(0, 2)).toEqual(['From your PNC Checking bank feed.', 'Half of a transfer: ↔ $600.00 into Ally Savings.']);
  });

  it('or from the add-on’s own linked groups', async () => {
    const ctx = ctxWith(byId([detail({ activityType: 'TRANSFER_OUT', amount: '600', comment: 'TRANSFER TO ALLY · TRN-1' })]));
    const groups = { [KEY]: 'wf-transfer-1', [accountTxKey('ACT-ally', 'TRN-2')]: 'wf-transfer-1' };
    const out = await appTxStory(ctx, store({ getChangeLog: vi.fn(async () => logOf()), getLinkedGroups: vi.fn(async () => groups) }), { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.answer[1]).toBe('Half of a transfer: ↔ $600.00 into Ally Savings.');
  });

  it('is "gone" for a row that no longer exists and "unreachable" when the read fails', async () => {
    expect(await appTxStory(ctxWith(byId([])), store(), { activityId: 'act-1' }, NOW)).toEqual({ kind: 'gone' });
    expect(await appTxStory(ctxWith(async () => { throw new Error('down'); }), store(), { activityId: 'act-1' }, NOW)).toEqual({ kind: 'unreachable' });
  });

  const failing: Array<[string, Partial<StoryStore>, keyof typeof TX_FACT_NOTES]> = [
    ['the mapping', { getAccountMapping: vi.fn(async () => { throw new SyntaxError('bad JSON'); }) }, 'mapping'],
    ['the change log', { getChangeLog: vi.fn(async () => null) }, 'changeLog'],
    ['the overrides', { readSyncOverrides: vi.fn(async () => null) }, 'overrides'],
    ['an unreadable overrides document', { readSyncOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: true })) }, 'overridesUnreadable'],
    ['the skip list', { getSkippedTransactions: vi.fn(async () => { throw new Error('down'); }) }, 'skipList'],
  ];
  it.each(failing)('a failed read of %s still tells the story, with a note', async (_what, over, fact) => {
    const out = await appTxStory(ctxWith(byId([detail()])), store(over), { activityId: 'act-1' }, NOW);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    expect(out.story.title).toBe('KROGER #415 · -$54.20 · Oct 4');
    expect(out.story.notes).toEqual([TX_FACT_NOTES[fact]]);
  });

  it('an older store without the newer reads still tells the story', async () => {
    const out = await appTxStory(ctxWith(byId([detail()])), { getAccountMapping: vi.fn(async () => ({ 'ACT-chk': 'wf-chk' })) }, { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.notes).toEqual([]);
  });
});

describe('appTxSearch', () => {
  it('asks Wealthfolio for the word no account name contains, then matches every word here', async () => {
    const rows = [detail(), detail({ id: 'act-2', comment: 'KROGER FUEL · TRN-2', accountName: 'Ally Savings' })];
    const ctx = ctxWith(async () => ({ data: rows, meta: { totalRowCount: 2 } }));
    const out = await appTxSearch(ctx, parseTxQuery('pnc kroger'), NOW);
    expect(ctx.api.activities.search).toHaveBeenCalledWith(0, 500, {}, 'kroger', { id: 'date', desc: true });
    expect(out).toEqual({
      kind: 'ok',
      result: { rows: [{ activityId: 'act-1', date: '2026-10-04', description: 'KROGER #415', amountCents: -5420, accountName: 'PNC Checking' }], truncated: false },
    });
  });

  it('searches by amount alone over the last 12 months, newest first, stopping at older rows', async () => {
    const page0 = [detail(), detail({ id: 'old', date: '2025-09-01T04:00:00.000Z' })];
    const ctx = ctxWith(async () => ({ data: page0, meta: { totalRowCount: 2 } }));
    const out = await appTxSearch(ctx, parseTxQuery('54.20'), NOW);
    expect(ctx.api.activities.search).toHaveBeenCalledTimes(1);
    expect(ctx.api.activities.search).toHaveBeenCalledWith(0, 500, {}, '', { id: 'date', desc: true });
    expect(out.kind === 'ok' && out.result.rows.map((r) => r.activityId)).toEqual(['act-1']);
  });

  it('pages until a short page', async () => {
    const full = Array.from({ length: 500 }, (_, i) => detail({ id: `p${i}`, comment: 'TARGET · TRN-x' }));
    const ctx = ctxWith(async (page: number) => ({ data: page === 0 ? full : [detail()], meta: { totalRowCount: 501 } }));
    const out = await appTxSearch(ctx, parseTxQuery('kroger'), NOW);
    expect(ctx.api.activities.search).toHaveBeenCalledTimes(2);
    expect(out.kind === 'ok' && out.result.rows.map((r) => r.activityId)).toEqual(['act-1']);
  });

  it('is unreachable when Wealthfolio cannot be read', async () => {
    expect(await appTxSearch(ctxWith(async () => { throw new Error('down'); }), parseTxQuery('kroger'), NOW)).toEqual({ kind: 'unreachable' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/utils/tx-story.test.ts`
Expected: FAIL — `./tx-story` cannot be resolved.

- [ ] **Step 3: Implement**

**Create `src/utils/tx-story.ts`:**

```ts
/**
 * src/utils/tx-story.ts
 *
 * The add-on's half of "Why is this here?": what the add-on SDK can see about
 * one transaction, gathered into shared/tx-story.ts's facts, and the search
 * behind Home's "Why is this here?" box.
 *
 * It sees less than the companion: the SDK has no categories and no link
 * groups. So who filed a row is told only when something the add-on CAN read
 * knows it — a budget drill-down row's `f` (the caller passes it), the report
 * cube's drill-down, the companion's needs-a-category list — and otherwise the
 * story points at Telegram (when a companion has published a version) or says
 * the category was set in Wealthfolio. The other half of a transfer comes from
 * the change log's link entry, else the add-on's own `linked_groups`.
 *
 * Search: Wealthfolio's keyword is one `LIKE '%…%'` over the note (upstream
 * activities repository, `search_activities_with_utc_bounds`), never the
 * account name. A word no account name contains goes to Wealthfolio across all
 * history; with none (an amount alone, or words that may be an account's), the
 * last 12 months are read and filtered here. Either way every word and the
 * amount are matched here (`matchesTxQuery`).
 *
 * Every store read is optional-called and wrapped: a failure leaves that part
 * of the story out with a note. Only the row failing is a full failure.
 */
import type { ActivityDetails, ActivitySearchFilters, AddonContext } from '@wealthfolio/addon-sdk';
import type { ChangeLogItem } from '../../shared/change-log';
import { changesForTransaction } from '../../shared/change-view';
import { txIdFromComment, isTransferType } from '../../shared/sync-core';
import { hasTxOverride, TX_OVERRIDE_FLAGS, type TxOverrideFlag } from '../../shared/sync-overrides';
import { accountTxKey } from '../../shared/transfers';
import {
  findTransactions, isEmptyTxQuery, matchesTxQuery, txDescription, txSearchKeyword, TX_SEARCH_MAX_RESULTS,
  TX_SEARCH_RECENT_DAYS, type TxQuery, type TxSearchResult, type TxSearchRow,
} from '../../shared/tx-search';
import {
  buildTxStory, decodeFiler, signedCents, withFilingDay, type TxFactName, type TxStory, type TxStoryFacts,
} from '../../shared/tx-story';
import type { SecretsStore } from './secrets';

/** What a story is opened for. A budget drill-down row also brings its
 *  (rolled-up) category and its `f` code. */
export interface AppStoryTarget {
  activityId: string;
  categoryName?: string;
  filer?: string;
}

/** The store reads a story makes, every one optional. */
export type StoryStore = Partial<Pick<SecretsStore,
  'getAccountMapping' | 'getChangeLog' | 'readSyncOverrides' | 'getSkippedTransactions' | 'getLinkedGroups'
  | 'getCompanionVersion' | 'getUncategorizedStatus' | 'getReportCube'>>;

export type AppStoryOutcome =
  /** `entries`: the whole change log as read (Undo needs it); [] when unread. */
  | { kind: 'ok'; story: TxStory; entries: ChangeLogItem[] }
  | { kind: 'gone' }
  | { kind: 'unreachable' };

export type AppSearchOutcome = { kind: 'ok'; result: TxSearchResult } | { kind: 'unreachable' };

const isoDay = (v: unknown) => {
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? String(v ?? '').slice(0, 10) : d.toISOString().slice(0, 10);
};
const absCentsOf = (amount: unknown) => Math.round(Math.abs(Number(amount ?? 0)) * 100) || 0;

/** One row by id. `activityIds` reaches Wealthfolio 3.8's exact-id filter (its
 *  activities adapter passes it through); the SDK's filter type does not list
 *  it, and an older host would ignore it — hence the id check. */
async function readRow(ctx: AddonContext, activityId: string): Promise<ActivityDetails | null> {
  const filters = { activityIds: [activityId] } as ActivitySearchFilters;
  const res = await ctx.api.activities.search(0, 1, filters, '');
  return (res.data ?? []).find((a) => a.id === activityId) ?? null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export async function appTxStory(ctx: AddonContext, store: StoryStore, target: AppStoryTarget, now: Date): Promise<AppStoryOutcome> {
  let item: ActivityDetails | null;
  try {
    item = await readRow(ctx, target.activityId);
  } catch {
    return { kind: 'unreachable' };
  }
  if (!item) return { kind: 'gone' };
  const row = item;
  const failed: TxFactName[] = [];
  const note = row.comment ?? '';
  const txId = txIdFromComment(note);

  const accounts = await ctx.api.accounts.getAll().catch(() => []);
  const accountType = accounts.find((a) => a.id === row.accountId)?.accountType;

  let mapping: Record<string, string> | null = null;
  try {
    mapping = (await store.getAccountMapping?.()) ?? {};
  } catch {
    failed.push('mapping');
  }
  const sfinId = mapping ? Object.entries(mapping).find(([, wfId]) => wfId === row.accountId)?.[0] ?? null : undefined;
  const txKey = sfinId && txId ? accountTxKey(sfinId, txId) : null;

  let entries: ChangeLogItem[] = [];
  let history: ChangeLogItem[] | undefined;
  if (store.getChangeLog) {
    const read = await store.getChangeLog().catch(() => null);
    if (read) {
      entries = read.entries;
      history = changesForTransaction(entries, { txKeys: txKey ? [txKey] : [], activityIds: [row.id] });
    } else failed.push('changeLog');
  }

  let overrides: TxOverrideFlag[] = [];
  if (store.readSyncOverrides) {
    const loaded = await store.readSyncOverrides().catch(() => null);
    if (!loaded) failed.push('overrides');
    else if (loaded.unreadable) failed.push('overridesUnreadable');
    else if (txKey) overrides = TX_OVERRIDE_FLAGS.filter((flag) => hasTxOverride(loaded.overrides, txKey, flag));
  }

  let skipped = false;
  try {
    const list = (await store.getSkippedTransactions?.()) ?? [];
    skipped = !!sfinId && !!txId && list.some((s) => s.account === sfinId && s.txId === txId);
  } catch {
    failed.push('skipList');
  }

  // The other half of a transfer: the newest link in the log that is not
  // undone, else the add-on's own ledger of pairs it linked.
  let partner: TxStoryFacts['partner'] = null;
  const link = [...(history ?? [])].reverse().find((e) => e.kind === 'transfer-link' && !e.reverses && !e.undone);
  const legs = link && isRecord(link.after) && Array.isArray(link.after.legs) ? link.after.legs.filter(isRecord) : [];
  const other = legs.find((l) => (txKey ? l.txKey !== txKey : l.activityId !== row.id));
  if (other && typeof other.accountName === 'string') {
    partner = { accountName: other.accountName };
  } else if (txKey) {
    const groups = await store.getLinkedGroups?.().catch(() => null);
    const gid = groups?.[txKey];
    const otherKey = gid ? Object.keys(groups!).find((k) => k !== txKey && groups![k] === gid) : undefined;
    const otherWf = otherKey && mapping ? mapping[otherKey.split('\u0000')[0]] : undefined;
    const name = otherWf ? accounts.find((a) => a.id === otherWf)?.name : undefined;
    if (name) partner = { accountName: name };
  }
  // A row that IS grouped (when the host reports it) or transfer-typed, with no
  // partner found, is not known to be ordinary money: leave that line out.
  const grouped = !!(row as { sourceGroupId?: string | null }).sourceGroupId;
  if (!partner && (grouped || isTransferType(String(row.activityType).toUpperCase()))) partner = undefined;

  // Who filed it, as far as the add-on can see.
  let category: TxStoryFacts['category'];
  let needsCategory = false;
  let filerHint: TxStoryFacts['filerHint'];
  const fromCode = (code: string | undefined) => {
    const f = decodeFiler(code);
    return f ? withFilingDay(f, history) : null;
  };
  if (target.categoryName) {
    category = { name: target.categoryName, filer: fromCode(target.filer) };
  } else {
    const cube = await store.getReportCube?.().catch(() => null);
    for (const [name, list] of Object.entries(cube?.drill ?? {})) {
      const hit = list.find((r) => r.i === row.id);
      if (hit) {
        category = { name, filer: fromCode(hit.f) };
        break;
      }
    }
    if (!category) {
      const status = await store.getUncategorizedStatus?.().catch(() => null);
      if (status?.rows.some((r) => r.activityId === row.id)) needsCategory = true;
      else filerHint = (await store.getCompanionVersion?.().catch(() => null)) ? 'telegram' : 'wealthfolio';
    }
  }

  const facts: TxStoryFacts = {
    row: {
      activityId: row.id,
      note,
      absCents: absCentsOf(row.amount),
      date: isoDay(row.date),
      activityType: String(row.activityType).toUpperCase(),
      accountName: row.accountName ?? '',
      ...(accountType ? { accountType: String(accountType) } : {}),
    },
    ...(sfinId === undefined ? {} : { feed: sfinId ? { sfinAccountId: sfinId } : null }),
    partner,
    ...(category ? { category } : {}),
    needsCategory,
    ...(filerHint ? { filerHint } : {}),
    overrides,
    skipped,
    ...(history ? { history } : {}),
    failed,
  };
  return { kind: 'ok', story: buildTxStory(facts), entries };
}

const PAGE_SIZE = 500;
const KEYWORD_MAX_PAGES = 10;
const RECENT_MAX_PAGES = 20;

export async function appTxSearch(ctx: AddonContext, query: TxQuery, now: Date): Promise<AppSearchOutcome> {
  if (isEmptyTxQuery(query)) return { kind: 'ok', result: { rows: [], truncated: false } };
  try {
    const accounts = await ctx.api.accounts.getAll();
    const typeOf = new Map(accounts.map((a) => [a.id, String(a.accountType ?? '')]));
    const keyword = txSearchKeyword(query, accounts.map((a) => a.name ?? ''));
    const cutoff = new Date(now.getTime() - TX_SEARCH_RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);
    const hits: TxSearchRow[] = [];
    for (let page = 0; page < (keyword ? KEYWORD_MAX_PAGES : RECENT_MAX_PAGES); page++) {
      const data = (await ctx.api.activities.search(page, PAGE_SIZE, {}, keyword ?? '', { id: 'date', desc: true })).data ?? [];
      let pastCutoff = false;
      for (const a of data) {
        const date = isoDay(a.date);
        if (!keyword && date < cutoff) {
          pastCutoff = true;
          continue;
        }
        const r: TxSearchRow = {
          activityId: a.id,
          date,
          description: txDescription(a.comment),
          amountCents: signedCents({ absCents: absCentsOf(a.amount), activityType: String(a.activityType), accountType: typeOf.get(a.accountId) }),
          accountName: a.accountName ?? '',
        };
        if (matchesTxQuery(r, query)) hits.push(r);
      }
      // One past the cap is enough to say there were too many.
      if (hits.length > TX_SEARCH_MAX_RESULTS || pastCutoff || data.length < PAGE_SIZE) break;
    }
    return { kind: 'ok', result: findTransactions(hits, query) };
  } catch {
    return { kind: 'unreachable' };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/utils/tx-story.test.ts`
Expected: PASS — 18 tests.

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/utils/tx-story.ts src/utils/tx-story.test.ts
git commit -m "Add-on: gather a transaction's story from what the SDK can see, and search through it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The story and the search card in the app

`src/components/TxStory.tsx` and `src/components/WhyCard.tsx` (spec A1, A3, W6). `TxStoryView` renders a story as text — title, account, the answer as a list, What happened, notes — and each history line is a button that opens, in place, the Change log card's own `EntryDetail` with its Undo, Redo and Sync now: `EntryDetail` and `RowActions` are exported from ChangeLogCard.tsx, not copied, so the card's guards (disabled plus `aria-busy` while pending) come with them. `TxStoryPanel` loads a story for a target, re-reads it after an Undo, and when that re-read fails keeps the story with a note (a "gone" after undoing an import says so). `useTxStoryActions` is the add-on's own `undoFromApp` and forced `runSync`, whose sentence (`syncNowSentence`) now lives once in ChangeLogCard.tsx for Settings and the story alike. `WhyCard` is Home's "Why is this here?": a search box, matches 8 at a time with More, a match's story under it. Styles are `.sfin-why-*` — the card is `.sfin-why-card`, because `.sfin-why` belongs to the `Why` disclosure.

**Files:**
- Create: `src/components/TxStory.tsx`, `src/components/TxStory.test.tsx`, `src/components/WhyCard.tsx`, `src/components/WhyCard.test.tsx`
- Modify: `src/components/ChangeLogCard.tsx`, `src/tabs/SettingsTab.tsx`, `src/components/ui.tsx`

**Interfaces:**
- Consumes: Task 1 (`isEmptyTxQuery`, `parseTxQuery`, `TX_SEARCH_PAGE_SIZE`, `TX_SEARCH_TOO_MANY`, `TxQuery`); Task 2 (`TX_STORY_GONE_APP`, `TX_STORY_NO_HISTORY`, `TX_STORY_UNREACHABLE`, `TX_STORY_WHAT_HAPPENED`, `TxStory`); Task 7 (`AppSearchOutcome`, `AppStoryOutcome`, `AppStoryTarget`); `undoFromApp` (src/utils/change-undo.ts); `runSync` (src/utils/sync.ts); `changeDay`, `changeMoney`; `Button`, `Input`, `SectionLabel`, `ThemeStyles` (ui.tsx).
- Produces:

```ts
// src/components/ChangeLogCard.tsx
export function syncNowSentence(r: { imported: number; errors: string[] }): string;
export interface RowActions { undo?; companionVersion: string | null; entries: ChangeLogItem[]; onSyncNow?; changed: () => void }
export function EntryDetail(props: { entry: ChangeLogItem; actions: RowActions }): JSX.Element;
// src/components/TxStory.tsx
export const TX_STORY_LOADING = 'Loading…';
export const TX_STORY_REREAD_FAILED = "Couldn't refresh this story — reload the page to try again.";
export interface TxStoryActions { undo?: (entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp) => Promise<UndoOutcome>;
  companionVersion: string | null; onSyncNow?: () => Promise<string> }
export function useTxStoryActions(ctx: AddonContext, store: SecretsStore, companionVersion: string | null): TxStoryActions;
export function TxStoryView(props: { story: TxStory; entries: ChangeLogItem[]; actions: TxStoryActions; onChanged: () => void }): JSX.Element;
export function TxStoryPanel(props: { target: AppStoryTarget; load: (target: AppStoryTarget) => Promise<AppStoryOutcome>; actions: TxStoryActions }): JSX.Element;
// src/components/WhyCard.tsx
export const WHY_CARD_TITLE = 'Why is this here?';
export const WHY_CARD_PLACEHOLDER = 'A few words or an amount';
export const WHY_CARD_SEARCHING = 'Searching…';
export const WHY_CARD_NO_MATCH = 'Nothing matches. If it was removed, search the Change log in Settings.';
export function WhyCard(props: { search: (query: TxQuery) => Promise<AppSearchOutcome>; renderStory: (target: AppStoryTarget) => React.ReactNode }): JSX.Element;
```

- [ ] **Step 1: Write the failing tests**

**Create `src/components/TxStory.test.tsx`:**

```tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { importChange, stampChange } from '../../shared/change-entries';
import type { ChangeLogItem } from '../../shared/change-log';
import type { UndoOutcome } from '../../shared/change-undo-run';
import { buildTxStory, TX_STORY_GONE_APP, TX_STORY_NO_HISTORY, TX_STORY_UNREACHABLE, type TxStory } from '../../shared/tx-story';
import { ThemeStyles } from './ui';
import { TxStoryPanel, TxStoryView, TX_STORY_REREAD_FAILED, type TxStoryActions } from './TxStory';
import type { AppStoryOutcome } from '../utils/tx-story';

const EMOJI = /\p{Extended_Pictographic}/u;
const NOW = new Date(2026, 9, 13, 15, 0);
const imported: ChangeLogItem = stampChange(importChange({
  account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' }, txKey: 'sfin-1\u0000tx-1', activityId: 'act-1',
  description: 'SQ *BLUE_BOTTLE <b>', amountCents: -650, date: '2026-10-12', pending: false, activityType: 'WITHDRAWAL',
}), 'companion', new Date(2026, 9, 12, 9, 0));
const story = (over: Partial<TxStory> = {}): TxStory => ({
  ...buildTxStory({
    row: { activityId: 'act-1', note: 'SQ *BLUE_BOTTLE <b> · tx-1', absCents: 650, date: '2026-10-12', activityType: 'WITHDRAWAL', accountName: 'Checking' },
    feed: { sfinAccountId: 'sfin-1' }, partner: null, filerHint: 'telegram', history: [imported],
  }),
  ...over,
});
const actions = (over: Partial<TxStoryActions> = {}): TxStoryActions => ({ companionVersion: '1.61.0', ...over });

describe('TxStoryView', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the title, the account, the answer and what happened — bank text as text, no emoji', () => {
    const { container } = render(<TxStoryView story={story()} entries={[imported]} actions={actions()} onChanged={() => {}} />);
    expect(screen.getByText('SQ *BLUE_BOTTLE <b> · -$6.50 · Oct 12')).toBeInTheDocument();
    expect(screen.getByText('Checking')).toBeInTheDocument();
    expect(screen.getByText('From your Checking bank feed.')).toBeInTheDocument();
    expect(screen.getByText('Ask /why in Telegram to see who filed it.')).toBeInTheDocument();
    expect(screen.getByText('What happened')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
    expect(EMOJI.test(container.textContent ?? '')).toBe(false);
  });

  it('says when nothing happened in 90 days, and shows no section when the log was not read', () => {
    const { rerender } = render(<TxStoryView story={story({ history: [] })} entries={[]} actions={actions()} onChanged={() => {}} />);
    expect(screen.getByText(TX_STORY_NO_HISTORY)).toBeInTheDocument();
    rerender(<TxStoryView story={story({ history: null, notes: ["Couldn't read the change log just now."] })} entries={[]} actions={actions()} onChanged={() => {}} />);
    expect(screen.queryByText('What happened')).toBeNull();
    expect(screen.getByText("Couldn't read the change log just now.")).toBeInTheDocument();
  });

  it('a history line opens the change log’s own entry detail, with its Undo — disabled and busy while it runs', async () => {
    let finish!: (o: UndoOutcome) => void;
    const undo = vi.fn(() => new Promise<UndoOutcome>((resolve) => { finish = resolve; }));
    const onChanged = vi.fn();
    render(<TxStoryView story={story()} entries={[imported]} actions={actions({ undo })} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /Imported SQ \*BLUE_BOTTLE/ }));
    const detail = document.querySelector('.sfin-log-detail') as HTMLElement;
    expect(within(detail).getByText(/Automatic — the background sync/)).toBeInTheDocument();
    fireEvent.click(within(detail).getByRole('button', { name: 'Undo' }));
    const busy = within(detail).getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    await act(async () => finish({ ok: true, message: "Undone — it's removed and won't be imported again.", needsSync: true }));
    expect(await within(detail).findByText(/Takes effect on the next sync\./)).toBeInTheDocument();
    expect(undo).toHaveBeenCalledWith(imported, [imported], 'undo');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

describe('TxStoryPanel', () => {
  const ok = (s = story()): AppStoryOutcome => ({ kind: 'ok', story: s, entries: [imported] });

  it('loads the story for its target', async () => {
    const load = vi.fn(async () => ok());
    render(<TxStoryPanel target={{ activityId: 'act-1', categoryName: 'Dining', filer: 'h' }} load={load} actions={actions()} />);
    expect(await screen.findByText('From your Checking bank feed.')).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith({ activityId: 'act-1', categoryName: 'Dining', filer: 'h' });
  });

  it('says so when the row cannot be read, or is gone', async () => {
    const { unmount } = render(<TxStoryPanel target={{ activityId: 'a' }} load={vi.fn(async () => ({ kind: 'unreachable' as const }))} actions={actions()} />);
    expect(await screen.findByText(TX_STORY_UNREACHABLE)).toBeInTheDocument();
    unmount();
    render(<TxStoryPanel target={{ activityId: 'a' }} load={vi.fn(async () => ({ kind: 'gone' as const }))} actions={actions()} />);
    expect(await screen.findByText(TX_STORY_GONE_APP)).toBeInTheDocument();
  });

  it('reads again after an Undo; a re-read that fails keeps the story and says so', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce({ kind: 'unreachable' })
      .mockResolvedValueOnce({ kind: 'gone' });
    const undo = vi.fn(async (): Promise<UndoOutcome> => ({ ok: true, message: 'Undone.', needsSync: false }));
    render(<TxStoryPanel target={{ activityId: 'act-1' }} load={load} actions={actions({ undo })} />);
    fireEvent.click(await screen.findByRole('button', { name: /Imported SQ \*BLUE_BOTTLE/ }));
    fireEvent.click(within(document.querySelector('.sfin-log-detail') as HTMLElement).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByText(TX_STORY_REREAD_FAILED)).toBeInTheDocument();
    expect(screen.getByText('From your Checking bank feed.')).toBeInTheDocument();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});

describe('the stylesheet', () => {
  it('defines the story’s classes once each, at column 0', () => {
    render(React.createElement(ThemeStyles));
    const css = Array.from(document.head.querySelectorAll('style')).map((el) => el.textContent ?? '').join('\n');
    for (const cls of ['.sfin-why-card', '.sfin-why-story', '.sfin-why-line-btn', '.sfin-why-result', '.sfin-why-inline']) {
      expect(css.match(new RegExp(`^\\${cls} \\{`, 'gm'))).toHaveLength(1);
    }
  });
});
```

**Create `src/components/WhyCard.test.tsx`:**

```tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { parseTxQuery, TX_SEARCH_TOO_MANY, type TxSearchRow } from '../../shared/tx-search';
import { TX_STORY_UNREACHABLE } from '../../shared/tx-story';
import type { AppSearchOutcome } from '../utils/tx-story';
import { WhyCard, WHY_CARD_NO_MATCH } from './WhyCard';

const EMOJI = /\p{Extended_Pictographic}/u;
const rows = (n: number): TxSearchRow[] => Array.from({ length: n }, (_, i) => ({
  activityId: `act-${i}`, date: '2026-10-04', description: `KROGER #${i}`, amountCents: -5420, accountName: 'PNC Checking',
}));
const found = (n: number, truncated = false): AppSearchOutcome => ({ kind: 'ok', result: { rows: rows(n), truncated } });

function mount(search: (q: ReturnType<typeof parseTxQuery>) => Promise<AppSearchOutcome>) {
  const renderStory = vi.fn((t: { activityId: string }) => <div>story of {t.activityId}</div>);
  const utils = render(<WhyCard search={search} renderStory={renderStory} />);
  const ask = (text: string) => {
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a transaction' }), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
  };
  return { ...utils, renderStory, ask };
}

describe('WhyCard', () => {
  it('searches what was typed and lists matches, 8 at a time, then More', async () => {
    const search = vi.fn(async () => found(12));
    const { ask, container } = mount(search);
    expect(screen.getByText('Why is this here?')).toBeInTheDocument();
    ask('Kroger 54');
    expect(await screen.findByText('KROGER #0')).toBeInTheDocument();
    expect(search).toHaveBeenCalledWith(parseTxQuery('Kroger 54'));
    expect(container.querySelectorAll('.sfin-why-result')).toHaveLength(8);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(container.querySelectorAll('.sfin-why-result')).toHaveLength(12);
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
    expect(EMOJI.test(container.textContent ?? '')).toBe(false);
  });

  it('opens a match’s story in place, and closes it again', async () => {
    const { ask, renderStory } = mount(vi.fn(async () => found(2)));
    ask('kroger');
    const row = await screen.findByRole('button', { name: /KROGER #1/ });
    fireEvent.click(row);
    expect(screen.getByText('story of act-1')).toBeInTheDocument();
    expect(renderStory).toHaveBeenCalledWith({ activityId: 'act-1' });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(row);
    expect(screen.queryByText('story of act-1')).toBeNull();
  });

  it('says when nothing matches, when there were too many, and when Wealthfolio cannot be reached', async () => {
    const outcomes: AppSearchOutcome[] = [found(0), found(40, true), { kind: 'unreachable' }];
    const { ask } = mount(vi.fn(async () => outcomes.shift()!));
    ask('zzz');
    expect(await screen.findByText(WHY_CARD_NO_MATCH)).toBeInTheDocument();
    ask('kroger');
    await screen.findByText('KROGER #0');
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByText(TX_SEARCH_TOO_MANY)).toBeInTheDocument();
    ask('kroger');
    expect(await screen.findByText(TX_STORY_UNREACHABLE)).toBeInTheDocument();
  });

  it('does nothing for an empty search', () => {
    const search = vi.fn(async () => found(1));
    const { ask } = mount(search);
    ask('   ');
    expect(search).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/TxStory.test.tsx src/components/WhyCard.test.tsx`
Expected: FAIL — `./TxStory` and `./WhyCard` cannot be resolved.

- [ ] **Step 3: Implement**

**Create `src/components/TxStory.tsx`:**

```tsx
/**
 * src/components/TxStory.tsx
 *
 * One transaction's story in the app (shared/tx-story.ts): the title and the
 * account, the few lines that answer "why", then What happened — each line a
 * button that opens, in place, the Change log card's own entry detail with its
 * Undo, Redo and Sync now (`EntryDetail`, exported from ChangeLogCard.tsx, not
 * a copy). Read-only otherwise: any change goes through that Undo.
 *
 * `TxStoryPanel` loads a story and reads it again after an Undo; a re-read that
 * fails keeps the story on screen and says so. Bank text renders as React
 * text. No emoji in app copy (src/pages/copy-policy.test.tsx).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { ChangeLogItem } from '../../shared/change-log';
import type { UndoOp } from '../../shared/change-undo';
import type { UndoOutcome } from '../../shared/change-undo-run';
import {
  TX_STORY_GONE_APP, TX_STORY_NO_HISTORY, TX_STORY_UNREACHABLE, TX_STORY_WHAT_HAPPENED, type TxStory,
} from '../../shared/tx-story';
import { EntryDetail, syncNowSentence, type RowActions } from './ChangeLogCard';
import { undoFromApp } from '../utils/change-undo';
import { runSync } from '../utils/sync';
import type { SecretsStore } from '../utils/secrets';
import type { AppStoryOutcome, AppStoryTarget } from '../utils/tx-story';

export const TX_STORY_LOADING = 'Loading…';
export const TX_STORY_REREAD_FAILED = "Couldn't refresh this story — reload the page to try again.";

/** What a story's history lines can do: the Change log card's Undo, Redo and
 *  Sync now. Without `undo` the lines open read-only. */
export interface TxStoryActions {
  undo?: (entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp) => Promise<UndoOutcome>;
  /** The companion's published version: the gate and the Telegram pointer. */
  companionVersion: string | null;
  onSyncNow?: () => Promise<string>;
}

/** The add-on's own Undo and Sync now — the same ones Settings → Change log uses. */
export function useTxStoryActions(ctx: AddonContext, store: SecretsStore, companionVersion: string | null): TxStoryActions {
  const undo = useCallback(
    (entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp) => undoFromApp(ctx, store, entry, entries, op),
    [ctx, store],
  );
  const onSyncNow = useCallback(async () => syncNowSentence(await runSync(ctx, store, { force: true })), [ctx, store]);
  return useMemo(() => ({ undo, companionVersion, onSyncNow }), [undo, companionVersion, onSyncNow]);
}

/** One line of What happened: opens its entry's detail in place. */
function HistoryLine({ line, entry, actions }: { line: string; entry: ChangeLogItem | undefined; actions: RowActions }) {
  const [open, setOpen] = useState(false);
  if (!entry) return <div className="sfin-why-line">{line}</div>;
  return (
    <div className="sfin-why-line">
      <button
        type="button"
        className={`sfin-why-line-btn${entry.undone ? ' sfin-log-row--undone' : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {line}
      </button>
      {open && <EntryDetail entry={entry} actions={actions} />}
    </div>
  );
}

export function TxStoryView({ story, entries, actions, onChanged }: {
  story: TxStory;
  /** The change log as read: a line's entry, and what Undo is decided against. */
  entries: ChangeLogItem[];
  actions: TxStoryActions;
  /** After an Undo or a Sync now: read the story again. */
  onChanged: () => void;
}) {
  const rowActions: RowActions = {
    undo: actions.undo, companionVersion: actions.companionVersion, entries, onSyncNow: actions.onSyncNow, changed: onChanged,
  };
  const byId = new Map(entries.map((e) => [e.id, e]));
  return (
    <div className="sfin-why-story">
      <div className="sfin-why-title">{story.title}</div>
      {story.accountLine && <div className="sfin-subtle">{story.accountLine}</div>}
      {story.answer.length > 0 && (
        <ul className="sfin-why-answer">
          {story.answer.map((line, i) => <li key={`${i}:${line}`}>{line}</li>)}
        </ul>
      )}
      {story.history && (
        <div className="sfin-why-history">
          <div className="sfin-why-heading">{TX_STORY_WHAT_HAPPENED}</div>
          {story.history.length === 0
            ? <div className="sfin-subtle">{TX_STORY_NO_HISTORY}</div>
            : story.history.map((h) => <HistoryLine key={h.entryId} line={h.line} entry={byId.get(h.entryId)} actions={rowActions} />)}
        </div>
      )}
      {story.notes.map((n) => <div key={n} className="sfin-log-note">{n}</div>)}
    </div>
  );
}

/** A story, loaded for its target and read again after every Undo. */
export function TxStoryPanel({ target, load, actions }: {
  target: AppStoryTarget;
  /** Stable (useCallback): a new function every render would reload forever. */
  load: (target: AppStoryTarget) => Promise<AppStoryOutcome>;
  actions: TxStoryActions;
}) {
  const [shown, setShown] = useState<AppStoryOutcome | 'loading'>('loading');
  const [staleNote, setStaleNote] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const hasStory = useRef(false);
  const { activityId, categoryName, filer } = target;

  useEffect(() => {
    let live = true;
    const settle = (out: AppStoryOutcome) => {
      if (!live) return;
      if (out.kind === 'ok') {
        hasStory.current = true;
        setShown(out);
        setStaleNote(null);
      } else if (hasStory.current) {
        // A re-read after an Undo: keep what is on screen and say why it may
        // be out of date (an Undo of an import removes the row itself).
        setStaleNote(out.kind === 'gone' ? TX_STORY_GONE_APP : TX_STORY_REREAD_FAILED);
      } else {
        setShown(out);
      }
    };
    load({ activityId, ...(categoryName ? { categoryName } : {}), ...(filer ? { filer } : {}) })
      .then(settle, () => settle({ kind: 'unreachable' }));
    return () => { live = false; };
  }, [load, activityId, categoryName, filer, version]);

  const changed = useCallback(() => setVersion((v) => v + 1), []);
  if (shown === 'loading') return <div className="sfin-subtle">{TX_STORY_LOADING}</div>;
  if (shown.kind === 'unreachable') return <div className="sfin-log-note">{TX_STORY_UNREACHABLE}</div>;
  if (shown.kind === 'gone') return <div className="sfin-log-note">{TX_STORY_GONE_APP}</div>;
  return (
    <>
      {staleNote && <div className="sfin-log-note">{staleNote}</div>}
      <TxStoryView story={shown.story} entries={shown.entries} actions={actions} onChanged={changed} />
    </>
  );
}
```

**Create `src/components/WhyCard.tsx`:**

```tsx
/**
 * src/components/WhyCard.tsx
 *
 * Home's "Why is this here?": find any transaction — a few words, an amount,
 * or both (shared/tx-search.ts) — and open its story in place
 * (src/components/TxStory.tsx). Matches are newest first, 8 at a time, More
 * for the next 8, at most 40. No emoji in app copy.
 */
import React, { useRef, useState } from 'react';
import { changeDay, changeMoney } from '../../shared/change-entries';
import { isEmptyTxQuery, parseTxQuery, TX_SEARCH_PAGE_SIZE, TX_SEARCH_TOO_MANY, type TxQuery } from '../../shared/tx-search';
import { TX_STORY_UNREACHABLE } from '../../shared/tx-story';
import { Button, Input, SectionLabel } from './ui';
import type { AppSearchOutcome, AppStoryTarget } from '../utils/tx-story';

export const WHY_CARD_TITLE = 'Why is this here?';
export const WHY_CARD_PLACEHOLDER = 'A few words or an amount';
export const WHY_CARD_SEARCHING = 'Searching…';
export const WHY_CARD_NO_MATCH = 'Nothing matches. If it was removed, search the Change log in Settings.';

export function WhyCard({ search, renderStory }: {
  search: (query: TxQuery) => Promise<AppSearchOutcome>;
  /** A match's story, opened under it. */
  renderStory: (target: AppStoryTarget) => React.ReactNode;
}) {
  const [text, setText] = useState('');
  const [state, setState] = useState<'idle' | 'searching' | AppSearchOutcome>('idle');
  const [shownCount, setShownCount] = useState(TX_SEARCH_PAGE_SIZE);
  const [openId, setOpenId] = useState<string | null>(null);
  // Only the newest search may land: an older one resolving late must not
  // replace its results.
  const latest = useRef(0);

  const find = async (e: React.FormEvent) => {
    e.preventDefault();
    const query = parseTxQuery(text);
    if (isEmptyTxQuery(query)) return;
    const mine = ++latest.current;
    setState('searching');
    setOpenId(null);
    setShownCount(TX_SEARCH_PAGE_SIZE);
    let out: AppSearchOutcome;
    try {
      out = await search(query);
    } catch {
      out = { kind: 'unreachable' };
    }
    if (mine === latest.current) setState(out);
  };

  const result = typeof state === 'object' && state.kind === 'ok' ? state.result : null;
  return (
    <div className="sfin-card sfin-why-card">
      <SectionLabel>{WHY_CARD_TITLE}</SectionLabel>
      <form className="sfin-why-form" role="search" onSubmit={find}>
        <Input
          type="search"
          aria-label="Find a transaction"
          placeholder={WHY_CARD_PLACEHOLDER}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" variant="outline">Find</Button>
      </form>
      {state === 'searching' && <div className="sfin-subtle">{WHY_CARD_SEARCHING}</div>}
      {typeof state === 'object' && state.kind === 'unreachable' && <div className="sfin-log-note">{TX_STORY_UNREACHABLE}</div>}
      {result && result.rows.length === 0 && <div className="sfin-subtle">{WHY_CARD_NO_MATCH}</div>}
      {result && result.rows.length > 0 && (
        <div className="sfin-why-results">
          {result.rows.slice(0, shownCount).map((r) => (
            <div key={r.activityId} className="sfin-why-result">
              <button
                type="button"
                className="sfin-why-open"
                aria-expanded={openId === r.activityId}
                onClick={() => setOpenId((id) => (id === r.activityId ? null : r.activityId))}
              >
                <span className="sfin-why-when">{changeDay(r.date)}</span>
                <span className="sfin-why-what">
                  {r.description || 'A transaction'}
                  <span className="sfin-subtle"> · {r.accountName}</span>
                </span>
                <span className="sfin-why-amt">{changeMoney(r.amountCents)}</span>
              </button>
              {openId === r.activityId && <div className="sfin-why-inline">{renderStory({ activityId: r.activityId })}</div>}
            </div>
          ))}
          {shownCount < result.rows.length && (
            <Button variant="ghost" onClick={() => setShownCount((n) => n + TX_SEARCH_PAGE_SIZE)}>More</Button>
          )}
          {result.truncated && shownCount >= result.rows.length && <div className="sfin-subtle">{TX_SEARCH_TOO_MANY}</div>}
        </div>
      )}
    </div>
  );
}
```

Edit 1 of 2 in `src/components/ChangeLogCard.tsx` — the sentence Sync now answers with, shared with the story. Replace:

```tsx
/** What the card can do with a row, from the card's props. */
interface RowActions {
```

with:

```tsx
/** What Sync now says once the run is over — here and in a transaction's story. */
export function syncNowSentence(r: { imported: number; errors: string[] }): string {
  return r.errors.length ? `Synced, with a problem: ${r.errors[0]}` : `Synced — ${r.imported} imported.`;
}

/** What the card can do with a row, from the card's props. Exported for a
 *  transaction's story (TxStory.tsx), whose history lines open `EntryDetail`. */
export interface RowActions {
```

Edit 2 of 2 in `src/components/ChangeLogCard.tsx` — the entry detail, with its Undo, is the story's too. Replace:

```tsx
function EntryDetail({ entry, actions }: { entry: ChangeLogItem; actions: RowActions }) {
```

with:

```tsx
export function EntryDetail({ entry, actions }: { entry: ChangeLogItem; actions: RowActions }) {
```

Edit 1 of 2 in `src/tabs/SettingsTab.tsx` — imports. Replace:

```tsx
import { ChangeLogCard } from '../components/ChangeLogCard';
```

with:

```tsx
import { ChangeLogCard, syncNowSentence } from '../components/ChangeLogCard';
```

Edit 2 of 2 in `src/tabs/SettingsTab.tsx` — Sync now's sentence comes from one place. Replace:

```tsx
  const syncNowForLog = useCallback(async () => {
    const r = await runSync(ctx, store, { force: true });
    return r.errors.length ? `Synced, with a problem: ${r.errors[0]}` : `Synced — ${r.imported} imported.`;
  }, [ctx, store]);
```

with:

```tsx
  const syncNowForLog = useCallback(async () => syncNowSentence(await runSync(ctx, store, { force: true })), [ctx, store]);
```

Edit 1 of 1 in `src/components/ui.tsx` — the `.sfin-why-*` block, after the Change log card's. Replace:

```tsx
@media (max-width: 560px) {
  .sfin-log-row { grid-template-columns: 3.2em minmax(0, 1fr); }
  .sfin-log-run-line { grid-template-columns: 3.2em minmax(0, 1fr); }
}
```

with:

```tsx
@media (max-width: 560px) {
  .sfin-log-row { grid-template-columns: 3.2em minmax(0, 1fr); }
  .sfin-log-run-line { grid-template-columns: 3.2em minmax(0, 1fr); }
}
/* "Why is this here?" (1.61): Home's search card, and a transaction's story
   wherever it opens (search results, needs-a-category, budget drill-down). */
.sfin-why-card { margin-bottom: 14px; }
.sfin-why-form { display: flex; gap: 8px; align-items: center; margin-top: 6px; }
.sfin-why-form .sfin-input { flex: 1; min-width: 0; }
.sfin-why-results { display: flex; flex-direction: column; margin-top: 8px; }
.sfin-why-result { border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.sfin-why-result:first-of-type { border-top: none; }
.sfin-why-open { display: grid; grid-template-columns: 4em minmax(0, 1fr) auto; align-items: baseline; gap: 10px; width: 100%; padding: 6px 0; border: none; background: transparent; color: var(--foreground); font: inherit; text-align: left; cursor: pointer; }
.sfin-why-open:hover { background: color-mix(in srgb, var(--sfin-s0) 6%, transparent); }
.sfin-why-when { font-size: var(--sfin-sz-xs); color: var(--muted-foreground); white-space: nowrap; }
.sfin-why-what { min-width: 0; overflow-wrap: anywhere; font-size: var(--sfin-sz-sm); }
.sfin-why-amt { white-space: nowrap; font-variant-numeric: tabular-nums; }
.sfin-why-inline { padding: 4px 0 10px 12px; border-left: 2px solid var(--border); margin: 2px 0 8px; }
.sfin-why-story { display: flex; flex-direction: column; gap: 4px; font-size: var(--sfin-sz-sm); }
.sfin-why-title { font-weight: 600; overflow-wrap: anywhere; }
.sfin-why-answer { margin: 4px 0; padding-left: 1.1em; display: flex; flex-direction: column; gap: 2px; }
.sfin-why-history { margin-top: 6px; }
.sfin-why-heading { font-size: var(--sfin-sz-xs); letter-spacing: .06em; text-transform: uppercase; color: var(--muted-foreground); margin-bottom: 2px; }
.sfin-why-line { display: flex; flex-direction: column; }
.sfin-why-line-btn { width: 100%; padding: 3px 0; border: none; border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent); background: transparent; color: var(--foreground); font: inherit; text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.sfin-why-line-btn:hover { background: color-mix(in srgb, var(--sfin-s0) 6%, transparent); }
@media (max-width: 560px) {
  .sfin-why-open { grid-template-columns: 4em minmax(0, 1fr); }
  .sfin-why-amt { grid-column: 2; }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/TxStory.test.tsx src/components/WhyCard.test.tsx src/components/ChangeLogCard.test.tsx src/components/ChangeLogCard-undo.test.tsx src/components/theme-styles.test.ts src/tabs/SettingsTab.test.tsx`
Expected: PASS — 76 tests.

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/TxStory.tsx src/components/TxStory.test.tsx src/components/WhyCard.tsx src/components/WhyCard.test.tsx src/components/ChangeLogCard.tsx src/tabs/SettingsTab.tsx src/components/ui.tsx
git commit -m "App: a transaction's story, with the change log's Undo on each line, and the Why is this here? card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The app's ways in — Home's search, needs-a-category rows, budget drill-down rows

Wiring (spec A3, W6). `SyncPage` builds ONE story renderer — `TxStoryPanel` over `appTxStory`, with `useTxStoryActions` — and hands it to Home and the budget. **Home** (`HomeTab`, with the prop) puts `WhyCard` first, above the banners and the tiles, searching through `appTxSearch`, and its needs-a-category rows (`UncategorizedList`) turn their descriptions into buttons that open the row's story under it; Dismiss is untouched. **The budget drill-down** (`ReportView`'s `DrillView`, through `BudgetTab`'s shared report props) makes a row a button only when it carries `i`, and opens its story with the drill's category and `f`; an older companion's rows stay plain. Without the renderer every component renders exactly as before, which keeps their existing tests unchanged.

**Files:**
- Modify: `src/components/UncategorizedList.tsx`, `src/components/budget/ReportView.tsx`, `src/tabs/BudgetTab.tsx`, `src/tabs/HomeTab.tsx`, `src/pages/SyncPage.tsx`, `src/components/ui.tsx`
- Test: `src/components/UncategorizedList.test.tsx`, `src/components/budget/ReportView.test.tsx`, `src/tabs/HomeTab.test.tsx`, `src/tabs/BudgetTab.test.tsx`

**Interfaces:**
- Consumes: Task 7 (`appTxSearch`, `appTxStory`, `AppStoryTarget`); Task 8 (`TxStoryPanel`, `useTxStoryActions`, `WhyCard`); Task 1 (`TxQuery`).
- Produces:

```ts
UncategorizedList props: { /* … */ renderStory?: (target: AppStoryTarget) => React.ReactNode }
ReportView props:        { /* … */ renderTxStory?: (target: AppStoryTarget) => React.ReactNode }   // → DrillView
BudgetTabProps:          { /* … */ renderTxStory?: (target: AppStoryTarget) => React.ReactNode }
HomeTab Props:           { /* … */ renderTxStory?: (target: AppStoryTarget) => React.ReactNode }
```

- [ ] **Step 1: Write the failing tests**

Edit 1 of 1 in `src/components/UncategorizedList.test.tsx` — a row opens its story. Replace:

```tsx
describe('useDismissals', () => {
```

with:

```tsx
describe('UncategorizedList — a row opens its story (1.61)', () => {
  it('turns each description into a button that opens the story under the row, and closes it again', () => {
    const renderStory = vi.fn((t: { activityId: string }) => <div>story of {t.activityId}</div>);
    render(<UncategorizedList {...base} renderStory={renderStory} />);
    const open = screen.getByRole('button', { name: /^Thankyou Points Redeemed/ });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(open);
    expect(screen.getByText('story of a')).toBeTruthy();
    expect(renderStory).toHaveBeenCalledWith({ activityId: 'a' });
    fireEvent.click(open);
    expect(screen.queryByText('story of a')).toBeNull();
  });

  it('keeps Dismiss working beside it', () => {
    const onDismiss = vi.fn();
    render(<UncategorizedList {...base} onDismiss={onDismiss} renderStory={() => null} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledWith('a');
  });

  it('without a story to tell, a row stays plain text', () => {
    render(<UncategorizedList {...base} />);
    expect(screen.queryByRole('button', { name: /^Thankyou Points Redeemed/ })).toBeNull();
  });
});

describe('useDismissals', () => {
```

Edit 1 of 1 in `src/components/budget/ReportView.test.tsx` — drill rows open their stories; an older companion's rows stay plain. Replace:

```tsx
  it('says so when the companion has not published drill rows yet', () => {
```

with:

```tsx
  it('a row carrying its activity id opens its story, with its category and who filed it (1.61)', () => {
    const renderTxStory = vi.fn((t: { activityId: string }) => <div>story of {t.activityId}</div>);
    const cube: ReportCube = {
      ...fresh(),
      drill: { Dining: [
        { d: '2026-08-20', n: 'CHIPOTLE 1234', c: 1250, a: 'Card', i: 'act-1', f: 'r:CHIPOTLE' },
        { d: '2026-08-19', n: 'SWEETGREEN', c: 900, a: 'Card', i: 'act-2' },
      ] },
    };
    render(<ReportView id="drill:Dining" customReports={[]} cube={cube} hero renderTxStory={renderTxStory} />);
    const row = screen.getByRole('button', { name: 'CHIPOTLE 1234' });
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('story of act-1')).toBeTruthy();
    expect(renderTxStory).toHaveBeenCalledWith({ activityId: 'act-1', categoryName: 'Dining', filer: 'r:CHIPOTLE' });
    fireEvent.click(screen.getByRole('button', { name: 'SWEETGREEN' }));
    expect(renderTxStory).toHaveBeenLastCalledWith({ activityId: 'act-2', categoryName: 'Dining' });
  });

  it('rows from an older companion, with no activity id, are not clickable', () => {
    render(<ReportView id="drill:Dining" customReports={[]} cube={withDrill()} hero renderTxStory={() => null} />);
    expect(screen.getByText('CHIPOTLE 1234')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'CHIPOTLE 1234' })).toBeNull();
  });

  it('says so when the companion has not published drill rows yet', () => {
```

Edit 1 of 1 in `src/tabs/HomeTab.test.tsx` — Why is this here? at the top of Home, and a needs-a-category row's story. Replace:

```tsx
      Element.prototype.scrollIntoView = original;
    }
  });
});
```

with:

```tsx
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe('Why is this here? (1.61)', () => {
  const kroger = {
    id: 'act-1', accountId: 'wf-a', accountName: 'Checking', activityType: 'WITHDRAWAL',
    date: '2026-10-04T04:00:00.000Z', amount: '54.20', comment: 'KROGER #415 · TRN-1',
  };
  const withActivities = () => {
    const props = makeProps();
    props.ctx.api.activities = {
      search: vi.fn(async (_page: number, _size: number, filters: any) => ({
        data: [kroger].filter((r) => !filters?.activityIds || filters.activityIds.includes(r.id)),
        meta: { totalRowCount: 1 },
      })),
    };
    return props;
  };

  it('sits at the top of Home: a search whose match opens its story in place', async () => {
    render(<SyncPage {...withActivities()} />);
    const box = await screen.findByRole('searchbox', { name: 'Find a transaction' });
    const card = box.closest('.sfin-why-card')!;
    // Above the banners and the tiles.
    for (const below of [document.querySelector('.sfin-banner-warn')!, document.querySelector('.sfin-strip')!]) {
      expect(card.compareDocumentPosition(below) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    fireEvent.change(box, { target: { value: 'kroger' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: /KROGER #415/ }));
    expect(await screen.findByText('From your Checking bank feed.')).toBeInTheDocument();
    // No companion published a version: the app says where the category was set.
    expect(screen.getByText('Category set in Wealthfolio.')).toBeInTheDocument();
  });

  it('a needs-a-category row opens its story', async () => {
    const props = withActivities();
    props.store.getUncategorizedStatus = vi.fn(async () => ({
      count: 1, asOf: '2026-10-04T12:00:00.000Z',
      rows: [{ activityId: 'act-1', date: '2026-10-04', amountCents: 5420, description: 'KROGER #415', accountName: 'Checking' }],
    })) as any;
    render(<SyncPage {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: /^1 needs/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^KROGER #415/ }));
    expect(await screen.findByText("Not filed yet — it's on your needs-a-category list.")).toBeInTheDocument();
  });
});
```

Edit 1 of 1 in `src/tabs/BudgetTab.test.tsx` — a drill-down row opens its story from the board. Replace:

```tsx
    fireEvent.click(screen.getByRole('button', { name: /back to all reports/i }));
    await waitFor(() => expect(screen.queryByText('TRADER JOES')).toBeNull());
  });
});
```

with:

```tsx
    fireEvent.click(screen.getByRole('button', { name: /back to all reports/i }));
    await waitFor(() => expect(screen.queryByText('TRADER JOES')).toBeNull());
  });

  it('a row opens its story in place, saying who filed it (1.61)', async () => {
    const props = makeProps();
    props.ctx.api.activities = {
      search: vi.fn(async () => ({
        data: [{
          id: 'act-9', accountId: 'wf-a', accountName: 'Checking', activityType: 'WITHDRAWAL',
          date: '2026-08-11T04:00:00.000Z', amount: '40', comment: 'TRADER JOES · TRN-9',
        }],
        meta: { totalRowCount: 1 },
      })),
    };
    (props.store as any).getReportCube = vi.fn(async () => ({
      ...CUBE, asOf: new Date().toISOString(),
      drill: { Groceries: [
        { d: '2026-08-11', n: 'TRADER JOES', c: 4000, a: 'Card', i: 'act-9', f: 'r:TRADER JOE' },
        { d: '2026-08-10', n: 'OLD ROW', c: 100, a: 'Card' },
      ] },
    }));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /see Groceries transactions/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'TRADER JOES' }));
    expect(await screen.findByText("Filed under Groceries by a rule — 'TRADER JOE' matches it.")).toBeInTheDocument();
    // An older companion's row has no id: plain text.
    expect(screen.getByText('OLD ROW')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'OLD ROW' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/UncategorizedList.test.tsx src/components/budget/ReportView.test.tsx src/tabs/HomeTab.test.tsx src/tabs/BudgetTab.test.tsx`
Expected: FAIL — 5 tests: a needs-a-category row opening its story, a drill row opening its story, both Home tests, and the board's drill test. (The "stays plain" tests already pass — they pin that nothing changes without an id or a renderer.)

- [ ] **Step 3: Implement**

Edit 1 of 4 in `src/components/UncategorizedList.tsx` — imports. Replace:

```tsx
import type { DismissalLedger, UncategorizedRow } from '../../shared/uncategorized';
```

with:

```tsx
import type { DismissalLedger, UncategorizedRow } from '../../shared/uncategorized';
import type { AppStoryTarget } from '../utils/tx-story';
```

Edit 2 of 4 in `src/components/UncategorizedList.tsx` — the prop. Replace:

```tsx
  rows, total, id, onDismiss, justDismissed, onUndo, onOpenActivities,
}: {
```

with:

```tsx
  rows, total, id, onDismiss, justDismissed, onUndo, onOpenActivities, renderStory,
}: {
```

Edit 3 of 4 in `src/components/UncategorizedList.tsx` — its type, and which row is open (before the early return: hooks run every render). Replace:

```tsx
  onOpenActivities?: () => void;
}) {
```

with:

```tsx
  onOpenActivities?: () => void;
  /** 1.61: a row's story, opened under it when its description is clicked.
   *  Absent: rows stay plain text, as before. */
  renderStory?: (target: AppStoryTarget) => React.ReactNode;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
```

Edit 4 of 4 in `src/components/UncategorizedList.tsx` — each row: its description opens its story under it. Replace:

```tsx
      {rows.map((r) => (
        <div className="sfin-uncat-row" key={r.activityId}>
          <span className="sfin-uncat-when">{r.date}</span>
          <span className="sfin-uncat-what">
            {r.description}
            <span className="sfin-subtle"> · {r.accountName}</span>
          </span>
          <span className={`sfin-uncat-amt${r.direction ? ` sfin-amt--${r.direction}` : ''}`}>
            {r.direction === 'out' ? '−' : r.direction === 'in' ? '+' : ''}{money(r.amountCents)}
          </span>
          <Button
            variant="ghost"
            onClick={() => onDismiss(r.activityId)}
            title="Stop counting this transaction as needing a category"
            // Nine rows otherwise announce nine identical "Dismiss, button"s to
            // assistive tech. Visible text stays "Dismiss" — only the accessible
            // name carries the distinguishing detail.
            aria-label={`Dismiss ${r.description}, ${money(r.amountCents)} on ${r.date}`}
          >
            Dismiss
          </Button>
        </div>
      ))}
```

with:

```tsx
      {rows.map((r) => (
        <React.Fragment key={r.activityId}>
          <div className="sfin-uncat-row">
            <span className="sfin-uncat-when">{r.date}</span>
            {renderStory ? (
              <button
                type="button"
                className="sfin-uncat-what sfin-why-row-btn"
                aria-expanded={openId === r.activityId}
                onClick={() => setOpenId((open) => (open === r.activityId ? null : r.activityId))}
              >
                {r.description}
                <span className="sfin-subtle"> · {r.accountName}</span>
              </button>
            ) : (
              <span className="sfin-uncat-what">
                {r.description}
                <span className="sfin-subtle"> · {r.accountName}</span>
              </span>
            )}
            <span className={`sfin-uncat-amt${r.direction ? ` sfin-amt--${r.direction}` : ''}`}>
              {r.direction === 'out' ? '−' : r.direction === 'in' ? '+' : ''}{money(r.amountCents)}
            </span>
            <Button
              variant="ghost"
              onClick={() => onDismiss(r.activityId)}
              title="Stop counting this transaction as needing a category"
              // Nine rows otherwise announce nine identical "Dismiss, button"s to
              // assistive tech. Visible text stays "Dismiss" — only the accessible
              // name carries the distinguishing detail.
              aria-label={`Dismiss ${r.description}, ${money(r.amountCents)} on ${r.date}`}
            >
              Dismiss
            </Button>
          </div>
          {renderStory && openId === r.activityId && (
            <div className="sfin-why-inline">{renderStory({ activityId: r.activityId })}</div>
          )}
        </React.Fragment>
      ))}
```

Edit 1 of 6 in `src/components/budget/ReportView.tsx` — imports. Replace:

```tsx
import { SubscriptionsCard } from './SubscriptionsCard';
```

with:

```tsx
import { SubscriptionsCard } from './SubscriptionsCard';
import type { AppStoryTarget } from '../../utils/tx-story';
```

Edit 2 of 6 in `src/components/budget/ReportView.tsx` — DrillView: a row with an activity id opens its story. Replace:

```tsx
function DrillView({ cube, category, onOpenActivities }: {
  cube: ReportCube; category: string; onOpenActivities?: () => void;
}) {
  const rows = cube.drill?.[category];
```

with:

```tsx
function DrillView({ cube, category, onOpenActivities, renderTxStory }: {
  cube: ReportCube; category: string; onOpenActivities?: () => void;
  /** 1.61: a row's story. Only rows carrying an activity id (`i`) open one —
   *  an older companion's cube has none, and its rows stay plain. */
  renderTxStory?: (target: AppStoryTarget) => React.ReactNode;
}) {
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const rows = cube.drill?.[category];
```

Edit 3 of 6 in `src/components/budget/ReportView.tsx` — the rows. Replace:

```tsx
          {rows.map((r, i) => (
            <tr key={`${r.d}-${i}`}>
              <td className="sfin-drill-date">{r.d.slice(5)}</td>
              <td>{r.n}</td>
              <td className="sfin-subtle">{r.a}</td>
              <td className={r.c < 0 ? 'sfin-refund' : undefined}>{fmt2(r.c / 100)}</td>
            </tr>
          ))}
```

with:

```tsx
          {rows.map((r, i) => {
            const key = `${r.d}-${i}`;
            const opens = !!(renderTxStory && r.i);
            return (
              <React.Fragment key={key}>
                <tr>
                  <td className="sfin-drill-date">{r.d.slice(5)}</td>
                  <td>
                    {opens ? (
                      <button
                        type="button"
                        className="sfin-why-row-btn"
                        aria-expanded={openKey === key}
                        onClick={() => setOpenKey((k) => (k === key ? null : key))}
                      >
                        {r.n}
                      </button>
                    ) : r.n}
                  </td>
                  <td className="sfin-subtle">{r.a}</td>
                  <td className={r.c < 0 ? 'sfin-refund' : undefined}>{fmt2(r.c / 100)}</td>
                </tr>
                {opens && openKey === key && (
                  <tr>
                    <td colSpan={4}>
                      <div className="sfin-why-inline">
                        {renderTxStory!({ activityId: r.i!, categoryName: category, ...(r.f ? { filer: r.f } : {}) })}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
```

Edit 4 of 6 in `src/components/budget/ReportView.tsx` — ReportView takes the renderer. Replace:

```tsx
  onDrill, onOpenActivities, subscriptionPrefs, onSubscriptionEdit, subscriptionsCube, companionStale, onSetUpCompanion,
}: {
```

with:

```tsx
  onDrill, onOpenActivities, subscriptionPrefs, onSubscriptionEdit, subscriptionsCube, companionStale, onSetUpCompanion,
  renderTxStory,
}: {
```

Edit 5 of 6 in `src/components/budget/ReportView.tsx` — its type. Replace:

```tsx
  /** The escape hatch out of a drill view into Wealthfolio's activities. */
  onOpenActivities?: () => void;
```

with:

```tsx
  /** The escape hatch out of a drill view into Wealthfolio's activities. */
  onOpenActivities?: () => void;
  /** 1.61: a drill row's story, opened in place. */
  renderTxStory?: (target: AppStoryTarget) => React.ReactNode;
```

Edit 6 of 6 in `src/components/budget/ReportView.tsx` — handed to the drill view. Replace:

```tsx
    body = <DrillView cube={cube} category={id.slice('drill:'.length)} onOpenActivities={onOpenActivities} />;
```

with:

```tsx
    body = <DrillView cube={cube} category={id.slice('drill:'.length)} onOpenActivities={onOpenActivities} renderTxStory={renderTxStory} />;
```

Edit 1 of 4 in `src/tabs/BudgetTab.tsx` — imports. Replace:

```tsx
import type { SecretsStore } from '../utils/secrets';
```

with:

```tsx
import type { SecretsStore } from '../utils/secrets';
import type { AppStoryTarget } from '../utils/tx-story';
```

Edit 2 of 4 in `src/tabs/BudgetTab.tsx` — the prop. Replace:

```tsx
  /** Opens Settings on the background-sync card — the empty state's way out. */
  onSetUpCompanion?: () => void;
}
```

with:

```tsx
  /** Opens Settings on the background-sync card — the empty state's way out. */
  onSetUpCompanion?: () => void;
  /** 1.61: a drill-down row's story, opened in place. */
  renderTxStory?: (target: AppStoryTarget) => React.ReactNode;
}
```

Edit 3 of 4 in `src/tabs/BudgetTab.tsx` — destructured. Replace:

```tsx
  subscriptionPrefs = null, onSubscriptionEdit, onOpenActivities, openRequest,
  onSetUpCompanion,
}: BudgetTabProps) {
```

with:

```tsx
  subscriptionPrefs = null, onSubscriptionEdit, onOpenActivities, openRequest,
  onSetUpCompanion, renderTxStory,
}: BudgetTabProps) {
```

Edit 4 of 4 in `src/tabs/BudgetTab.tsx` — every ReportView gets it, through the shared props. Replace:

```tsx
    onOpenActivities,
  };
```

with:

```tsx
    onOpenActivities,
    renderTxStory,
  };
```

Edit 1 of 6 in `src/tabs/HomeTab.tsx` — imports. Replace:

```tsx
import { UncategorizedList, useDismissals } from '../components/UncategorizedList';
```

with:

```tsx
import { UncategorizedList, useDismissals } from '../components/UncategorizedList';
import { WhyCard } from '../components/WhyCard';
import { appTxSearch, type AppStoryTarget } from '../utils/tx-story';
import type { TxQuery } from '../../shared/tx-search';
```

Edit 2 of 6 in `src/tabs/HomeTab.tsx` — the prop. Replace:

```tsx
  /** The pool tile's tap: opens the pool's burn-down in the budget below. */
  onOpenPool: () => void;
}
```

with:

```tsx
  /** The pool tile's tap: opens the pool's burn-down in the budget below. */
  onOpenPool: () => void;
  /** 1.61: a transaction's story (TxStoryPanel). Present: "Why is this here?"
   *  heads the page and needs-a-category rows open their stories. */
  renderTxStory?: (target: AppStoryTarget) => React.ReactNode;
}
```

Edit 3 of 6 in `src/tabs/HomeTab.tsx` — destructured. Replace:

```tsx
  onDismissChecklist, onNavigate, poolStatus, onOpenPool,
}: Props) {
```

with:

```tsx
  onDismissChecklist, onNavigate, poolStatus, onOpenPool, renderTxStory,
}: Props) {
```

Edit 4 of 6 in `src/tabs/HomeTab.tsx` — the search, over the SDK. Replace:

```tsx
  const { justDismissed, dismiss, undo } = useDismissals(dismissals, onDismissalsChange);
```

with:

```tsx
  const { justDismissed, dismiss, undo } = useDismissals(dismissals, onDismissalsChange);
  const searchTx = useCallback((query: TxQuery) => appTxSearch(ctx, query, new Date()), [ctx]);
```

Edit 5 of 6 in `src/tabs/HomeTab.tsx` — "Why is this here?" heads the page. Replace:

```tsx
  return (
    <>
      {/* An account SimpleFin is offering that nothing is mapped to. First
```

with:

```tsx
  return (
    <>
      {/* "Why is this here?" (1.61): find any transaction and read its story.
          First, because it is where a question about the numbers starts. */}
      {renderTxStory && <WhyCard search={searchTx} renderStory={renderTxStory} />}

      {/* An account SimpleFin is offering that nothing is mapped to. First
```

Edit 6 of 6 in `src/tabs/HomeTab.tsx` — needs-a-category rows open their stories. Replace:

```tsx
          onOpenActivities={() => { ctx.api.navigation.navigate('/activities').catch(() => {}); }}
        />
      )}
```

with:

```tsx
          onOpenActivities={() => { ctx.api.navigation.navigate('/activities').catch(() => {}); }}
          renderStory={renderTxStory}
        />
      )}
```

Edit 1 of 4 in `src/pages/SyncPage.tsx` — imports. Replace:

```tsx
import { BudgetTab } from '../tabs/BudgetTab';
```

with:

```tsx
import { BudgetTab } from '../tabs/BudgetTab';
import { TxStoryPanel, useTxStoryActions } from '../components/TxStory';
import { appTxStory, type AppStoryTarget } from '../utils/tx-story';
```

Edit 2 of 4 in `src/pages/SyncPage.tsx` — one story renderer for Home and the budget. Replace:

```tsx
  const [companionVersion, setCompanionVersion] = useState<string | null>(null);
```

with:

```tsx
  const [companionVersion, setCompanionVersion] = useState<string | null>(null);
  // "Why is this here?" (1.61): one story renderer for Home and the budget
  // drill-down, with the Change log card's own Undo and Sync now.
  const storyActions = useTxStoryActions(ctx, store, companionVersion);
  const loadStory = useCallback((target: AppStoryTarget) => appTxStory(ctx, store, target, new Date()), [ctx, store]);
  const renderTxStory = useCallback(
    (target: AppStoryTarget) => <TxStoryPanel target={target} load={loadStory} actions={storyActions} />,
    [loadStory, storyActions],
  );
```

Edit 3 of 4 in `src/pages/SyncPage.tsx` — Home gets it. Replace:

```tsx
          onOpenPool={() => setBudgetOpen((prev) => ({ id: 'pool-burndown', seq: (prev?.seq ?? 0) + 1 }))}
        />
```

with:

```tsx
          onOpenPool={() => setBudgetOpen((prev) => ({ id: 'pool-burndown', seq: (prev?.seq ?? 0) + 1 }))}
          renderTxStory={renderTxStory}
        />
```

Edit 4 of 4 in `src/pages/SyncPage.tsx` — and the budget. Replace:

```tsx
          openRequest={budgetOpen}
        />
```

with:

```tsx
          openRequest={budgetOpen}
          renderTxStory={renderTxStory}
        />
```

Edit 1 of 1 in `src/components/ui.tsx` — the row button's look. Replace:

```tsx
@media (max-width: 560px) {
  .sfin-why-open { grid-template-columns: 4em minmax(0, 1fr); }
```

with:

```tsx
/* A needs-a-category or drill-down row's description, as the button that opens its story. */
.sfin-why-row-btn { padding: 0; border: none; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; text-decoration: underline dotted color-mix(in srgb, var(--foreground) 35%, transparent); text-underline-offset: 3px; }
@media (max-width: 560px) {
  .sfin-why-open { grid-template-columns: 4em minmax(0, 1fr); }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/UncategorizedList.test.tsx src/components/budget/ReportView.test.tsx src/tabs/HomeTab.test.tsx src/tabs/BudgetTab.test.tsx src/pages/copy-policy.test.tsx src/pages/SyncPage.test.tsx src/components/theme-styles.test.ts`
Expected: PASS — 213 tests.

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/UncategorizedList.tsx src/components/UncategorizedList.test.tsx src/components/budget/ReportView.tsx src/components/budget/ReportView.test.tsx src/tabs/BudgetTab.tsx src/tabs/BudgetTab.test.tsx src/tabs/HomeTab.tsx src/tabs/HomeTab.test.tsx src/pages/SyncPage.tsx src/components/ui.tsx
git commit -m "App: Why is this here? heads Home; needs-a-category and drill-down rows open their story

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs, follow-ups, every gate

CHANGELOG under `[Unreleased]` (no version bump — W11), README (the `/why` line in the Telegram bullet and "Why is this here?" in the Home bullet), and follow-ups §10: what this piece deliberately leaves — the app's narrower view, inference limits, the 17-byte query, the add-on's text-only messages, the run button and a gap, the search limits, the More-commands placement. No code.

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `docs/superpowers/follow-ups.md`

**Interfaces:**
- Consumes: the copy and behaviour of Tasks 1–9.
- Produces: documentation only.

- [ ] **Step 1: Write the docs**

Edit 1 of 1 in `CHANGELOG.md` — the release notes, under [Unreleased]. Replace:

```markdown
## [Unreleased]

## [1.60.0] - 2026-10-13
```

with:

```markdown
## [Unreleased]

### Added
- **"Why is this here?" — one transaction's story.** In Telegram,
  `/why kroger 54.20` finds any transaction — words, an amount, or both; bare
  `/why` asks — and a tap tells its story: the bank feed it came from (or that
  it was added by hand), what it is (spending, money in, half of a transfer
  and with which account, a transfer the sync is holding, a starting balance
  or a correction), its category and who filed it (the rule that matches it,
  you in Telegram, an Amazon email, or by hand in Wealthfolio), anything you
  told the sync about it, and **What happened**: every change-log entry about
  it, oldest first, each opening its `/changes` entry, where Undo lives. A
  🔎 Why? button on the `/categorize` screen, on large-transaction alerts and
  on import notices (which list that sync's imports) sends the story as a new
  message. In the app, **Home** starts with a "Why is this here?" search, and
  needs-a-category rows and budget drill-down rows open their story in
  place, with the change log's Undo on each history line. Read-only: the
  story explains; changes still go through Undo or `/categorize`.
- Budget drill-down rows carry their transaction and who filed it, so they
  open a story once the companion is updated; rows from an older companion
  stay as they were.

## [1.60.0] - 2026-10-13
```

Edit 1 of 2 in `README.md` — the Home bullet. Replace:

```markdown
- **Home** — a status strip (last sync, accounts, anything that needs you),
```

with:

```markdown
- **Home** — "Why is this here?" at the top: find any transaction by a few
  words or an amount and read its story — where it came from, what it is, who
  filed it and every change made to it, with Undo. Then a status strip (last
  sync, accounts, anything that needs you; a needs-a-category row opens its
  story),
```

Edit 2 of 2 in `README.md` — the /why line. Replace:

```markdown
  replying to it. `/changes` lists what changed in the last 7 days, with Undo
  or Redo where an entry offers one, and `/changes venmo` searches it.
```

with:

```markdown
  replying to it. `/changes` lists what changed in the last 7 days, with Undo
  or Redo where an entry offers one, and `/changes venmo` searches it.
  `/why kroger 54.20` finds a transaction and tells its story; the 🔎 Why?
  buttons on large-transaction alerts, import notices and the `/categorize`
  screen do the same.
```

Edit 1 of 2 in `docs/superpowers/follow-ups.md` — the revision line. Replace:

```markdown
Last updated: 2026-10-13, after the change log Undo plan (new section 9).
Previous revision: 2026-10-12, after the subscriptions & bills plan (new
```

with:

```markdown
Last updated: 2026-10-13, after the "Why is this here?" plan (new section 10).
Previous revision: 2026-10-13, after the change log Undo plan (new section 9).
Previous revision: 2026-10-12, after the subscriptions & bills plan (new
```

Edit 2 of 2 in `docs/superpowers/follow-ups.md` — section 10, before the reference. Replace:

```markdown
## Reference: name mismatches between the database, the REST API, and the SDK
```

with:

```markdown
## 10. "Why is this here?" (2026-10-13, plan `2026-10-13-why-is-this-here.md`)

- **The app tells less than Telegram, on purpose.** The add-on SDK has no
  categories and no link groups. The app names a filer only when the cube's
  drill-down (this month's categorized spending) or the needs-a-category list
  knows it; otherwise it says "Ask /why in Telegram to see who filed it." (a
  companion has published a version) or "Category set in Wealthfolio." (none
  has). The other half of a transfer comes from the change log's link entry
  (90 days) or the add-on's own `linked_groups`; an older companion-linked
  transfer gets no "what it is" line in the app.
- **Rule inference names the rule that would file the row TODAY** — the
  highest-priority current rule for its category whose pattern matches
  (Wealthfolio's own order). A rule edited since the filing can be named in
  its place, or none ("none of your current rules matches it"). A `regex`
  rule is matched with JavaScript's `RegExp`, which differs from Rust's
  `regex` at the edges.
- **"By hand" is an inference too.** A manual filing with no Telegram or Amazon
  entry in the last 90 days, and no Amazon label in its note, reads "set by
  hand in Wealthfolio". With the log unreadable it says only "Filed under X."
- **`/why` queries are cut to 17 bytes**, so a story's Back button (the query
  rides in it) fits Telegram's 64: words drop from the end, never the amount,
  and a dropped word only widens the match. A story reached back from a
  `/changes` entry has no Back of its own.
- **Only the companion's messages carry 🔎 Why?.** The add-on's sync sends its
  large-transaction alert and import notice text-only, as its notice always
  was — no listener is guaranteed to answer. An alert the add-on queues keeps
  its activity id, so the companion's retry carries the button.
- **An import notice's 🔎 Why? reads the run's import entries from the log.**
  If that run's entries were never saved (a gap record), the button answers
  "That sync is past the change log's 90 days — search with /why."
- **Search limits.** Telegram searches all history in the database, or the
  last 12 months over REST when the database cannot be read (it says so). The
  app asks Wealthfolio for a word no account name contains across all history
  (up to 10 pages of 500) and otherwise reads the last 12 months (up to 20
  pages). Both stop at 40 matches: "Too many matches — add a word or an
  amount."
- **`/why` is under /help's More commands**, not the seven-command ☰ menu
  (Telegram's registered list), which stays at seven.

## Reference: name mismatches between the database, the REST API, and the SDK
```

- [ ] **Step 2: Run every gate**

Run: `nice npm test`
Expected: PASS — 2343 tests (91 files).

Run: `cd companion && nice npx vitest run` (the same suite `nice npm --prefix companion test` runs)
Expected: PASS — 993 tests (40 files).

Run: `npm run type-check`
Expected: No errors.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md README.md docs/superpowers/follow-ups.md
git commit -m "Why is this here?: docs and follow-ups

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
