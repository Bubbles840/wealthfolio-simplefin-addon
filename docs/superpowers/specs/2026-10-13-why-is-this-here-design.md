# "Why is this here?" — design

Nick approved this design section by section on 2026-10-13. It is piece **2b**
of project 2 ("Trust & control") of the roadmap approved on 2026-10-12. Piece
2a, the change log with undo, shipped in v1.60.0. This piece reads from that
log. Piece 2c, audits without SSH, gets its own spec.

Nick's goal, from the trust goals he picked: "Tap/click a transaction and see
its story: imported from which bank feed, paired with which transfer, filed by
which rule or Amazon email, any corrections applied."

Ships as **one release (1.61.0)**. It is read-only: the story explains, and any
change goes through the change log's existing Undo.

## Decisions

| Question | Decision |
|---|---|
| Where do you start from? | **All four:** <br>• Wealthfolio's Activities, by searching for the transaction <br>• Telegram messages, with a 🔎 Why? button <br>• The add-on's own lists: needs-a-category and the budget drill-down <br>• A number that looks wrong |
| "A number that looks wrong" | **Totals here, balances in 2c.** Budget drill-down rows open each transaction's story. A wrong account balance is 2c's audit. |
| Story shape | **Answer, then history.** A few plain lines answer "why". Below them, "What happened" lists the change-log entries, and each line opens its entry, where Undo lives. |
| App search | **Top of Home.** A "Why is this here?" search field. |
| Approach | **One shared story; each side tells what it can see.** The companion supplies the whole story. The app supplies what the add-on SDK can read. Budget drill-down rows carry "who filed it", so the totals path is complete in the app. There is no new stored document. |
| Confirmations or edits | **None.** Read-only. |

## What exists today (facts this design builds on)

- **The add-on cannot extend Wealthfolio's own Activities page.**
  - The SDK offers sidebar items and add-on-owned routes only (`AddonContext.sidebar.addItem`, `router.add`).
  - `navigation.navigate(route)` takes a bare route.
- **The add-on cannot read a transaction's spending category.** The SDK's taxonomy types cover investment holdings only. The change log's Undo design already relies on this: "the add-on cannot reach categories".
- **The add-on cannot read link groups.**
  - `ActivityDetails`, which `activities.search` returns, carries `comment`, `accountName` and `metadata`, but no `sourceGroupId`.
  - The add-on keeps its own `linked_groups` ledger of the pairs it linked.
- **The companion reads both.**
  - REST: `getActivityAssignments`, `listCategorizationRules`, `searchActivities`.
  - Read-only SQLite: `activities.source_group_id` and `activity_taxonomy_assignments.source`.
    - `source` is `'rule'` when a rule filed the activity and `'manual'` when a person did.
    - It does NOT record which rule. `getNativeRuleFiledActivityIds` already infers the rule by matching its pattern against the note.
- **The note** is `[↔️ In-transit transfer · ]<desc>[ · Amazon: <label>] · <txId>[ · pending]`. Two other row kinds carry their own notes:
  - `Starting balance · <acct>`
  - `Balance adjustment · <acct> · <date>`

  The note carries the transaction id, not the account. The account-scoped key is `accountTxKey(sfinAccountId, txId)`, and it needs `account_mapping` (sfinId → wfId) read backwards.
- **The change log** (`shared/change-log.ts`, `readChangeLog`) keeps 90 days, newest first.
  - Entries carry `subject.txKeys` and `subject.activityIds`.
  - A transfer link's entry also carries `before.activityIds`, the ids from before the re-create.
  - A bank update records the OLD tx key when a pending row posted under a new transaction id (`shared/change-entries.ts` `BankUpdateFacts`).
  - No reader filters by transaction today.
- **Transaction surfaces with no story today:**
  - **App:**
    - Needs-a-category rows (`UncategorizedList`, rows keyed by `activityId`, not clickable).
    - Budget drill-down rows (`DrillView`). Rows are `DrillTx {d, n, c, a}` with no id, from the companion's report cube. The cube is capped at `REPORT_CUBE_MAX_BYTES = 200_000`.
  - **Telegram:**
    - The `/categorize` transaction screen.
    - The large-transaction alert, which is sent through a retry outbox and has no keyboard today.
    - Import notices, which carry Dismiss buttons `d:<activityId>`.
- **There is no "find a transaction" search anywhere.**
  - `/changes <words>` searches change-log entries only.
  - `/recategorize <text>` searches filed rows only.

## A. What you see, and where

### A1. The story

The story is the same in both places. It has a **title**, the **answer**, and **What happened**.

**Title:** the description, the signed amount, the date, and the account below them.

**Answer.** Each line appears only when its fact is known:

1. **Where it came from.**
   - "From your PNC Checking bank feed." If the row is still pending, add "Still pending."
   - "Not from your bank feed — added in Wealthfolio by hand or from a file." This applies when the row has no transaction id, or is in an account the add-on doesn't sync.
2. **What it is.**
   - "Spending." / "Money in."
   - "Half of a transfer: $600.00 into Ally Savings, Oct 4."
   - Special rows:
     - **Held transfer:** "A transfer the sync is holding: it waits until <date> for its other half, then counts as spending." For an inflow, it counts as money in.
     - **Starting balance:** "The starting balance the add-on set so <account> matches the bank from <date>."
     - **Correction:** "A correction the add-on added on <date> so <account> matches the bank."
3. **Category and who filed it.**
   - "Filed under Groceries by a rule — 'KROGER' matches it."
   - "Filed under Groceries by you, in Telegram, Oct 4."
   - "Filed under Lawn & Garden from an Amazon email."
   - "Set by hand."
   - "Not filed yet — it's on your needs-a-category list."
   - In the app, when the filer can't be seen:
     - With a companion: "Ask /why in Telegram to see who filed it."
     - Without a companion: "Category set in Wealthfolio."
4. **Your overrides.** "You told the sync: not a transfer" (also: keep this duplicate, don't file it automatically, no Amazon label).

**What happened:**
- Every change-log entry about this transaction, oldest first, one line each: date and the entry's summary.
- Each line opens that entry. In Telegram this is the `/changes` entry view; in the app it is the change log's entry detail. Undo already lives there.
- A transaction with no entries in the last 90 days shows "No changes in the last 90 days."

### A2. Telegram

- **`/why <words and/or an amount>`** searches every transaction.
  - Results are newest first, 8 per page.
  - Each result is a button with the date, description, amount and account. A tap opens the story.
  - Navigation within `/why` edits the message in place. The story has ⬅️ Back to the results.
- **Bare `/why`** asks "Which transaction? Send a few words or an amount", using the R1 ask engine, like `/newrule`.
- **No match:** "Nothing matches. If it was removed, try /changes <words>."
- **🔎 Why? buttons** send the story as a NEW message, so the original stays put. They appear on:
  - the `/categorize` (and `/recategorize`) transaction screen;
  - the large-transaction alert;
  - import notices, where one button lists that sync's imports (from the change log, by the run) and a tap opens a story.
- **More commands.** `/why` joins the ☰ More commands menu and the command list.

### A3. App

- **Home:** a "Why is this here?" search field at the top.
  - Type words and/or an amount. Matches are listed (newest first, 8 per page, then "More").
  - Picking one opens its story in place.
- **Needs-a-category:** clicking a row opens its story.
- **Budget drill-down:** clicking a row opens its story.
  - The row's "who filed it" comes from the cube, so the category line is complete.
  - Rows from an older companion, which have no activity id, are not clickable.
- **A history line** expands in place with the change log's existing entry detail and Undo controls.
- **Copy:** no emoji in app copy, following the existing copy policy.

## B. How it's built

- **`shared/tx-story.ts`** (pure)
  - `buildTxStory(facts): TxStory` turns `TxStoryFacts` into `{ title, accountLine, answer: string[], history: { entryId, line }[], notes: string[] }`.
  - Every fact is optional. A fact that is missing leaves out its line. A fact that failed to read adds a note, e.g. "Couldn't read the change log just now."
  - Bank and user text is RAW. Telegram escapes it at render and keeps it outside every `*…*`/`_…_` entity. The app renders it as text.
- **`shared/tx-search.ts`** (pure)
  - `parseTxQuery(text)` splits the text into `{ words, amount }`.
  - `matchesTxQuery(row, query)` checks a row against the query.
  - Matching rules: see C4.
- **`shared/change-view.ts`** gains `changesForTransaction(entries, { txKeys, activityIds })`. It matches in this order:
  1. `subject.txKeys`;
  2. a bank update's old tx key, which links a posted row to its pending history;
  3. `subject.activityIds` and `before.activityIds`.
- **Companion**
  - **`companion/src/tx-story-host.ts`** gathers the facts:
    - the row, by REST;
    - the partner, by a second activity with the same `source_group_id`, read from SQLite;
    - the category and its `source`, from SQLite;
    - the inferred rule: `listCategorizationRules`, matched by pattern in Wealthfolio's priority order;
    - the Amazon label, from the note;
    - overrides, the skip list and `account_mapping`;
    - `readCompanionChangeLog`.
  - **`companion/src/why-menu.ts`**
    - The `/why` command and its ask flow.
    - A stateless menu with the new prefix `cz:wy:`, routed before the categorize fallthrough.
    - Results and story views re-read on every tap.
    - Buttons carry the activity id, or a `findingHandle` of a run id for an import notice.
    - A history line's button opens the `/changes` entry view (`cz:cl:`).
- **Report cube.** `DrillTx` gains two optional short fields, which the companion's builder fills:
  - `i`: the activity id;
  - `f`: who filed it, a short code for "rule '<pattern>'", "you", "Amazon '<label>'" or "by hand".

  Before planning, measure the added bytes against `REPORT_CUBE_MAX_BYTES`. If the fields push a real cube toward the cap, the plan lowers the per-category drill cap.
- **App**
  - **`src/utils/tx-story.ts`** gathers what the add-on can see:
    - the row, through `ctx.api.activities.search`;
    - account names and `account_mapping`;
    - its own `linked_groups`;
    - overrides and the skip list;
    - the change log, through the store;
    - the `companion_version` secret, for the Telegram pointer;
    - when opened from a drill row, that row's `f`.
  - **`TxStory`** renders a story. It is used by a new Home card (`WhyCard`), `UncategorizedList` rows and `DrillView` rows.
  - A history line reuses the change log card's entry detail and Undo controls.

## C. Edge cases, limits and failures

### C1. Identity

- A transaction is identified by its activity id, plus its account-scoped key when the note has a transaction id and the account is mapped.
- History matches by key first, so it survives a transfer link re-creating both rows.
- A button whose activity id no longer exists answers "That transaction has changed since — search again with /why." This happens after a link, or after it was removed.

### C2. Failures

- **The row itself can't be read:** "Couldn't reach Wealthfolio — try again."
- **Any other read fails** (change log, overrides, partner, category, rules): that part is left out and a note says so.
  - An unreadable overrides document is reported, never treated as "none".
  - A failed read never fails the whole story.

### C3. Honest inference

- Wealthfolio records THAT a rule filed a row, not WHICH rule. The story says "Filed by a rule — '<pattern>' matches it".
  - When several rules match, it names the one Wealthfolio applies first.
  - When none matches now (the rule was edited or deleted): "Filed by a rule (none of your current rules matches it)."
- A category set by a person:
  - "by you, in Telegram, <date>" when the change log has the filing;
  - otherwise "set by hand"

### C4. Search rules

- **Words:** all must appear, ignoring case, in the description (the note without its markers and transaction id) or the account name.
- **Amounts:**
  - `54.20` and `$54.20` match exactly, positive or negative.
  - `54` matches $54.00–$54.99.
  - `1,250` reads as a thousand-separated amount, as `parseAmountCents` already does.
- **Paging:** newest first, 8 per page, up to 5 pages. Past that: "Too many matches — add a word or an amount."
- **Telegram** searches all history through the read-only SQLite database. When the database is unreadable, it searches the last 12 months over REST.
- **App:**
  - It uses `activities.search` with the keyword when Wealthfolio's keyword search matches notes. Verify this during planning.
  - Otherwise it filters the last 12 months itself.

### C5. Telegram limits

- Callback data must be ≤ 64 bytes. `cz:wy:` plus a 36-character activity id fits. Search text is trimmed to fit, as `/changes` does.
- Escaping uses legacy Markdown (`escapeMarkdown`), with bank and user text outside every entity.

## D. Testing and release

### D1. Tests

**Story builder**
- One fixture per row kind:
  - bank import;
  - pending then posted under a new transaction id;
  - linked transfer;
  - held transfer;
  - starting balance;
  - correction;
  - not from the bank;
  - older than 90 days.
- One fixture per missing fact and per failed fact.
- Rule-inference wording for one match, several matches and no match.
- A bank name full of Markdown characters, escaped and kept outside bold in Telegram.

**Search parsing:** `54.20`, `$54.20`, `54`, `1,250`, words with an amount, and words only.

**`changesForTransaction`:** by key, by the old pending key, by activity id, and by `before.activityIds`.

**Companion fact-gathering**
- Use fake REST and SQLite results in their real shapes.
- Partner lookup by group.
- A failure of each read on its own.

**Telegram**
- `/why` bare, with words, with no matches, and across pages.
- A stale button.
- Every callback ≤ 64 bytes.
- Routing ahead of the categorize fallthrough.
- Each Why? button sends a new message.
- The import notice's list comes from its run.

**App**
- The Home search.
- A story opens, and a history line expands to the existing Undo.
- Needs-a-category rows and drill-down rows open their stories, including drill rows from an older companion (not clickable).
- The Telegram pointer appears only when a companion exists.
- No emoji, and each `.sfin-*` CSS rule once at column 0.

### D2. Release

- One release, 1.61.0. No version gate is needed: the feature is read-only, and an older companion only means drill rows aren't clickable.
- CHANGELOG under [Unreleased].
- README: the `/why` line and a Home bullet.
- `docs/superpowers/follow-ups.md` gets a new section 10.
- Gates:
  - `npm test`
  - `npm --prefix companion test`
  - `npm run type-check`
  - `npm --prefix companion run build`

## Out of scope

- Explaining an account balance. That is piece 2c (audits without SSH).
- Editing from the story. Changes go through the change log's existing Undo, or `/categorize`.
- A provenance index published by the companion for the app (rejected approach 2).
- Buttons on Wealthfolio's own Activities page (the SDK has no hook).
- Per-transaction buttons in the daily report (it is a summary).
