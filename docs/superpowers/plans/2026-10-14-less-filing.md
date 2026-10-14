# Less filing — R1 (project 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Less filing by hand, with nothing new from the add-on SDK: a bank row for a Venmo payment carries the payment's note from Venmo's email (`VENMO PAYMENT 1023 · Venmo: Rent October`), a needs-a-category row you filed the same way before carries a guessed category (Telegram's `/categorize` offers it as one tap, the app shows "Probably Groceries"), and a Wealthfolio category rule made from Telegram can be for one account only.

**Architecture:** Four pure shared modules: `shared/venmo.ts` reads a Venmo email (`classifyVenmoEmail`, `isVenmoMessage`); `shared/venmo-ledger.ts` keeps the `venmo_ledger` secret and matches a bank row to one payment (`matchVenmoPayment`: the word VENMO, the exact amount, the same direction, ±5 days, exactly one record); `shared/category-guess.ts` counts the year's filings by `/categorize`'s rule pattern (and a Venmo note) into a guess (2 filings, 80%); the rule screens in `shared/categorize-menu.ts` gain the "All accounts ⇄ Only <account>" toggle. The companion reads Venmo's emails from the Amazon mailbox through one shared read (`shareMailSource`, `companion/src/venmo-mail.ts`); both syncers add the note at import or later exactly as an Amazon label is added (`shared/sync-core.ts`), logged as the new change kind `venmo-note`, whose Undo sets the new override `noVenmoNote`. The companion reads every spending filing of the last year (`companion/src/sqlite-guess.ts`, strict) to publish `uncategorized_status` rows with an optional `guess` and to put the guess first on `/categorize`; the app renders it as a hint. Scoped rules thread the row's Wealthfolio account id from the native reader to `createCategorizationRule` (`isGlobal: false` + `accountId`), the change log and Redo; `/newrule … in <account>` opens the preview for that account.

**Tech Stack:** TypeScript, React (add-on), vitest (root project: jsdom, `src/` + `shared/`; companion project: node, `companion/src/`), Telegram Bot API (legacy `Markdown`), Wealthfolio REST and read-only SQLite (companion), IMAP via `imapflow` (companion), add-on SDK 3.6.2 on Wealthfolio 3.8–3.10.

**Spec:** `docs/superpowers/specs/2026-10-14-less-filing-design.md` (commit d8e31bc on `feat/less-filing`, off main ece1902; rulings L1–L5; **designed overnight, not yet reviewed by Nick** — it ships as an open PR). This plan is **R1 only**: sections A, B, C and D. R2 (filing from the app, SDK 3.9's `spending` permission) is not planned.

**Verified facts this plan builds on (Z1, at d8e31bc and the upstream tags):**
- **(a) The Amazon pipeline is generic everywhere but two places, and only those two change.** `MailMessage`/`MailSource` (`companion/src/amazon-mail.ts:39-73`), the ledger pattern (`shared/amazon-ledger.ts`: merge by key, prune at 90 days, consume by `accountTxKey`), the late-label planner (`planAmazonLateLabels`, `shared/sync-core.ts:1236-1258`, takes any `txId → {bare, enriched}` map) and the overrides are not Amazon-specific. Amazon-only are (1) the IMAP adapter's sender check, which drops every message `isAmazonMessage` refuses (`amazon-mail.ts:339`) — so Venmo mail never reaches the companion today — and (2) `pollAmazonMail`, which hands that one source to `ingestAmazonMail` (`companion/src/index.ts:561-653`, `:590-591`). This plan gives `createImapSource` an `accept` predicate (default `isAmazonMessage`, so `amazon-check.ts:51` is unchanged), fetches once and hands each reader a filtered view (`shareMailSource`), and leaves `ingestAmazonMail`, `shared/amazon*.ts` and every Amazon test file untouched. A Venmo message given to Amazon's ingest would be counted unrecognised and kept as an Amazon sample, which is why each reader sees only its own messages. The sync hook mirrors Amazon's at each site: the ledger read (`sync-core.ts:1977-1983`), the match after typing (`:2063-2096`), the late pass (`:2612-2650`), the ledger write (`:3966-3970`); the late note IS `planAmazonLateLabels` (`planVenmoLateNotes` delegates).
- **(b) Venmo's email formats are UNVERIFIED.** No real Venmo email exists in this repository or on this machine, and Venmo appears in the code only in help text, fixtures and user mapping rules. The parser is built from Venmo's documented notification wording — "You paid <name> $X", "<name> paid you $X", "You completed <name>'s $X charge request" / "<name> paid your $X request", and "Your $X transfer to your bank" — reading the subject first (minus `Fwd:`/`Re:`), then each body copy, the note being the first non-boilerplate line after the payment's amount. Every fixture in `shared/venmo.test.ts` says it was built, not captured. Mail that looks like a payment and does not read is left unread, counted (`Venmo mail: … unrecognised`) and kept, redacted, in `venmo_mail_samples`. Nick's real emails are needed (follow-ups §13).
- **(c) Guess data.** Wealthfolio records who filed a row in `activity_taxonomy_assignments.source`, with `created_at` (`crates/storage-sqlite/src/schema.rs` v3.8.0:587-596, v3.10.0:596-605). Three values are ever stored: `manual` — the assign route `PUT /spending/activities/{id}/assignments` (`apps/server/src/api/spending.rs` v3.10.0:213-220, 757-758) writes it (`crates/spending/src/activity_assignments/service.rs:101,122`), so a filing in Wealthfolio, in `/categorize` and by the Amazon filer are all `manual`; `rule` — a rule run (`categorization_rules/service.rs:238`); and `migrated` — Wealthfolio's own conversion (`core/src/health/fixes/classification_migration.rs:192,250`). The same at v3.8.0. So the spec's "manual, and those the change log shows as yours, and rule filings" is exactly `source IN ('manual','rule')` — the change log adds nothing — read joined to `activities.notes` and keyed by `categoryRulePattern(descriptionFromComment(notes))` (`shared/rule-pattern.ts:34`, the function `/categorize` builds rules with, `categorize.ts` `createRule` case). `uncategorized_status` is built in `companion/src/uncategorized-status.ts:55-89` (rows: id, date, amount, description, account name, direction — no account id, no guess); `/categorize` builds its rows in `companion/src/categorize.ts` `load()` (`:737-818`) through `toTxn` (`:669-681`) and renders them in `shared/categorize-menu.ts` (`renderList` :462, `renderTxn` :516). The native row already carries the account id (`NativeUncategorizedTx.wfAccountId`, `companion/src/sqlite-native.ts:572,661`).
- **(d) Account-scoped rules.** Upstream `NewCategorizationRule` has `is_global` (serde default `true`) and `account_id` (`crates/spending/src/categorization_rules/model.rs:105-121`, identical at v3.8.0 and v3.10.0); `validate_rule_scope` (`service.rs:423-431`, both tags) refuses a global rule that names an account (`GlobalRuleHasAccount`) and a scoped one without an id ("Account-scoped rules require accountId"); the matcher skips other accounts' rows (`matcher.rs:80`). So a scoped rule sends `isGlobal: false, accountId` and a global one sends NO `accountId` key. The companion always sends `isGlobal: true` (`companion/src/wealthfolio.ts:340`). The rule screens are `rulePreview` / `freeRulePreview` (`categorize-menu.ts:702,723`) over `ruleCopy` (`:693`) with the count from `ruleCatchCount` (`:607`, over the session's own rows). `CategorizeTxn` has no account id (`:25-51`); this plan threads `wfAccountId` through `CategorizeSourceRow` → `toTxn` → `CategorizeTxn.accountId`. `countRulePatternMatches` (`sqlite-native.ts:1269`) is used only by the bare `/newrule` questions (`index.ts:3106`) and transfer learning (`:3595`), both before any account is known, so it is unchanged. `ruleMatchesRow` (`shared/tx-story.ts:247-248`) already honours `isGlobal: false`.
- **(e) The change log.** A new kind touches `ChangeKind`/`CHANGE_KINDS` (`shared/change-entries.ts:29-48`; `change-entries.test.ts:37` pins the count, 16 → 17), `SYNC_DECISION_KINDS` (`shared/change-undo.ts:29-31`; `UNDO_KINDS` spreads it), `GROUP_OF` (`shared/change-view.ts:28-45`) and `changeBeforeAfter` (`:120`), the planner (Amazon's case, `change-undo.ts:546-566`) and the runner's row read (`shared/change-undo-run.ts:205,246`). A new override touches `TX_OVERRIDE_FLAGS`/`TxOverride` (`shared/sync-overrides.ts:36-53`), `OVERRIDE_FLAG_WORDS` (`:298-305`, the app's overrides list) and the story's words (`shared/tx-story.ts:78-85`). **`parseSyncOverrides` treats an unknown key as corruption** (`sync-overrides.ts:115-126`), so a v1.60.0 add-on reads a document holding `noVenmoNote` as corrupt and its own sync then ignores every override (Global Constraints: update both halves). `category-rule-created` (`change-entries.ts:577-596`) gains an optional account; its Redo (`change-undo.ts:364-372`) re-creates the rule with it.

**Deviations from the spec (decided, do not "fix"):**
- **Undo takes a Venmo note off at once** — the override first, then the old note written back — exactly as an Amazon label's Undo does (`change-undo.ts:546-566`). The spec has the sync take it off; the sync only ever sees rows in its feed window, and `changed()` never compares notes (`sync-core.ts:1216-1222`), so a row older than the window would keep its note. The sync obeys `noVenmoNote`: no note at import, none later (pinned in Task 4).
- **A note added at import gets its own `venmo-note` entry**, beside the import's. Amazon's import-time label has none (`amazonLabelChange` is only called by the late pass, `sync-core.ts:2629`), so it can only be undone with the whole import; L2 promises "Undo removes it" for every Venmo note.
- **A transfer to your bank carries the note `Transfer to your bank`** (it has no note of its own; the spec does not say). Money you were paid and a transfer to your bank are both money in, so one of each at the same amount the same week is two candidates — no note (follow-ups §13).
- **Venmo's unreadable emails are kept in their own secret, `venmo_mail_samples`** (`{ asOf, unparsed, samples }`, Amazon's sample shape and redaction), replaced every completed scan, and shown nowhere yet; the log line counts them.
- **Guesses**: a money-in row that takes an INCOME category (`incomeEligible`) gets none — a guess is a spending category, which Wealthfolio refuses there (`categorize-menu.ts:522-528`); a Venmo row is tried by its note first, then by the bank text's pattern (the spec's "uses the note as well"); `/categorize`'s list shows ` · probably <category>` after the row (the spec gives no words); the guess button is offered only on the spending grid, only for a category the tree still has.
- **The toggle is one row of two buttons, the one in force ticked:** `✓ All accounts` | `Only <account>`, or `All accounts` | `✓ Only <account>`. It appears only when the row's account id and name are known (an older controller's rows render as before).
- **`/newrule … in <account>`** — the first ` in ` on the category side names the account (no preset category has one), resolved among the non-archived accounts by exact name, else the one name containing the words. Several: "Which account? <a>, <b>"; none: `No account matches "<q>". Your accounts: <a>, <b>.` The preview then opens scoped, its toggle able to widen it. **No account picker** on a `/newrule` preview without `in <account>` (the spec's "or pick an account on the preview"), and the bare `/newrule` questions have no account step (follow-ups §13).
- **Redo of a scoped rule re-creates it for its account** (the spec only says Undo is unchanged; a Redo that widened the rule would be wrong).
- **Gate commands** follow the rulings: `nice npm test`, `(cd companion && nice npx vitest run)`, `nice npm run type-check`, `nice npm --prefix companion run build`.

**Task order:** the Venmo parser (1) and its ledger and matcher (2); the change log's `venmo-note`, `noVenmoNote` and the story line (3); the note in both syncers (4); the companion's mail read (5); the guess (6), its read and publish (7), `/categorize`'s guess (8) and the app's hint (9); account-scoped rules (10); docs, the forced-date run and every gate (11).

## Global Constraints

- **No new SDK permission and no version bump.** R1 needs nothing from SDK 3.9. CHANGELOG goes under `[Unreleased]`; no tag or release.
- **Raw text in shared code.** Bank text, Venmo names and notes, category and account names are RAW in every shared module and change-log summary. Telegram escapes them with `escapeMarkdown` in message text and keeps them outside every `*…*`/`_…_`; button labels are plain text and are not escaped; the app renders text.
- **Copy (verbatim):** the note ` · Venmo: <note>` (`VENMO_NOTE_MARK`), at most 60 characters with `…` at a cut, newlines as spaces; a bank transfer's note `Transfer to your bank`; change summary `Added the Venmo note "<note>" to <bank text>`, why `Venmo email`; Undo `Undone — the note is off, and stays off.`, Redo `Redone — the next sync adds the note again.`; overrides list `No Venmo note: <label>`; story `Note from a Venmo email.` and `no Venmo note`; guess button `✓ <category> (like the last <n>)`; list suffix ` · probably <category>`; app hint `Probably <category>`; toggle `✓ All accounts` / `Only <account>` / `All accounts` / `✓ Only <account>`; scoped preview `Descriptions containing "<pattern>" in <account> → <category>` and `It will also file any other uncategorized transactions in <account> that match, now and on every future import. Already-categorized transactions are never touched.`; `Rule created — future matches in <account> will file automatically under <category>.`; summary `Created a rule: descriptions containing "<pattern>" in <account> go to <category>`; `/newrule` replies `Which account? <a>, <b>`, `No account matches "<q>". Your accounts: <a>, <b>.`, `Couldn't read your accounts just now — try again.` Every log line is spelled out in its task.
- **Telegram.** Legacy `Markdown`. No new callback prefix: the guess button and the toggle are ordinary `/categorize` session `MenuAction`s behind `cz:<generation>:<index>`, so the listener's routing order is untouched. Every `callback_data` ≤ 64 bytes; the longest these screens emit is 15 (`cz:4294967295:N`), pinned. Glyphs: `✓` only.
- **Mailbox.** Venmo is on whenever the Amazon mailbox is configured (L2); it reads the same mailbox in the same poll, after Amazon's status is published, under its own guard: a Venmo failure costs this run's Venmo notes, never Amazon's status, never the sync. Payments and ignored Venmo mail are flagged read; unreadable Venmo mail stays unread. Secrets: `venmo_ledger` (90 days), `venmo_mail_samples`.
- **Matching (A).** VENMO (word, any case) in the bank's own text; the exact amount in cents; the same direction (`out` for a negative SimpleFin amount); the email within ±5 days; exactly one candidate record — a record consumed by another row is not one, one consumed by this row is (idempotent). Consumed even when `noVenmoNote` keeps the note off.
- **Guesses (B).** Spending-taxonomy filings with `source` `manual` or `rule`, created within 365 days (`guessSinceDay`). At least 2 filings under the key and at least 80% in one category (integers: `count × 100 ≥ total × 80`). Amazon rows never. A failed read means no guesses at all, never a guess from part of the history. A guess never files anything (L4).
- **Scoped rules (C).** `isGlobal: false` + `accountId` for one account; a global rule sends no `accountId` key. The scoped preview's count counts only that account's rows. The change entry names the account (`account`, `after.accountId`). A refused rule says so and records nothing.
- **Compatibility.** Every new field is optional: `UncategorizedRow.guess`, `CategorizeTxn.accountId`/`guess`, `CategorizeSourceRow.wfAccountId`, `SyncStore.getVenmoLedger?`/`setVenmoLedger?`, `CategorizeDeps.readFilings?`. **Update the add-on with the companion**: a v1.60.0 add-on reads overrides holding `noVenmoNote` as corrupt (fact e). A row an older add-on renders keeps its old shape (the `guess` key is omitted when there is none).
- **App.** No emoji in app copy (`\p{Extended_Pictographic}`; `src/pages/copy-policy.test.tsx`). The one new class is `.sfin-uncat-guess`, defined once (`src/components/theme-styles.test.ts`).
- **Tests use a fixed `now`.** Shared and companion: fixed `Date`s and `now`/`nowMs` arguments; a test that needs the clock fakes `Date` (`vi.useFakeTimers({ toFake: ['Date'] })`) and the file restores it. Every new test also passes with the date forced to 2027-01-01 (Task 11).
- **Imports:** shared sources import siblings WITH `.js`; `src/` imports shared WITHOUT an extension; companion imports `'../../shared/x.js'` and `'./x.js'`. `companion/src/index.test.ts` mocks a new module the moment `index.ts` imports one that reads `sqlite-native.js` at import time (`./sqlite-guess.js`) or does mail work (`./venmo-mail.js`).
- **Run the companion suite from `companion/`** (`cd companion && npx vitest run …`), never with `--root`.
- **Gates before calling a task done:** the touched project's tests, plus `nice npm run type-check` when `src/` or `shared/` changed and `nice npm --prefix companion run build` when `companion/` or `shared/` changed. Final task: `nice npm test`, `(cd companion && nice npx vitest run)`, `nice npm run type-check`, `nice npm --prefix companion run build`. Run builds and full suites under `nice` — the Mac overheats.
- **Edits are exact.** Every "replace" block below is copied from the file as it stands after the previous tasks (and the earlier edits of the same file in the same task) and occurs exactly once; replace it verbatim (the Edit tool's `old_string` → `new_string`). Apply a file's numbered edits in order. Every "Create" block is the whole file.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git stash` (the stash stack is shared across worktrees).

## Review Focus

- **A Venmo name or note full of Markdown characters** (`J_D *Smith*`, `*Rent* _Oct_ [2]`) → kept raw by the parser and the change log, escaped in `/categorize`'s text, raw on its buttons; an account name likewise on the scoped preview. Pinned in Task 1 (`keeps Markdown characters in a name or note raw — Telegram escapes them, not the parser`), Task 3 (the `venmo-note` summary case), Task 8 (`escapes a Venmo note full of Markdown in the text and keeps it raw on the buttons`) and Task 10 (`escapes an account name full of Markdown in the text and keeps it raw on the button`).
- **Two Venmo payments of the same amount in the window** → no note. Pinned in Task 2 and Task 4 (`gives no note when two payments of the same amount fall in the window`).
- **A bank row moving money the other way** ($25.00 in against "You paid $25.00") → no note, the payment not consumed. Pinned in Task 2 (`gives no note when the direction does not match — a deposit is not a payment you made`) and Task 4 (`gives no note when the direction does not match — $25.00 in is not the $25.00 you paid`).
- **Undo of a Venmo note** → `noVenmoNote` first, then the old note back; a changed, linked or gone row is refused; the next sync adds it neither at import nor later. Pinned in Task 3 (`a Venmo note: noVenmoNote first, then the old note back; a changed, linked or gone row is refused`; `a Venmo note: noVenmoNote, then the old note back`) and Task 4 (`noVenmoNote: no note at import nor later, and the payment is still consumed`).
- **The guess thresholds** → exactly 2 filings guesses, 1 does not; exactly 80% (4 of 5) guesses, 75% does not. Pinned in Task 6 (`guesses from exactly 2 filings in one category, and not from 1`; `guesses at exactly 80% (4 of 5) and not below (3 of 4)`).
- **An Amazon row** → no guess, whatever its filings. Pinned in Task 6 (`never guesses an Amazon row — the Amazon pipeline files those`) and Task 7 (`gives an Amazon row no guess, nor a row that takes an income category`).
- **A failed read of the filings** → no hints anywhere, never a wrong one; the status and the menu work as before. Pinned in Task 7 (`a failed read of the filings publishes no guesses at all — never a wrong one — and the status as usual`; `throws — never answers "no filings" — when the database cannot be read`) and Task 8 (`a failed read of the filings shows no guesses, and the menu still works`).
- **A scoped rule's preview count** → only that account's rows. Pinned in Task 10 (`scoped: names the account in the copy, counts only its rows, and creates for it`: 2 rows globally, 1 scoped).
- **An older add-on and the `guess` field** → the published row reads exactly as before with the field riding along, a row without one renders as before, and the key is absent when there is no guess. Pinned in Task 9 (`reads a published row with a guess as before — the optional field rides along, nothing else changes`; `shows nothing for a row with no guess — what an older companion publishes — or one it cannot read`) and Task 7 (`puts the guess on a row whose merchant you filed the same way twice`).
- **The longest callback** → within 64 bytes; 15 at generation 4294967295. Pinned in Task 8 (`keeps every callback within 64 bytes with the guess at the widest generation — the longest is 15`) and Task 10 (`keeps every scoped screen’s callbacks within 64 bytes`).
- **Dates** → every test passes a fixed `now` or fakes `Date`; Task 11 runs every new and touched test file with the date forced to 2027-01-01, the setup file inside the clone and deleted after.

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/venmo.ts` (create) | `classifyVenmoEmail`, `isVenmoMessage`, `clipVenmoNote`, `toVenmoMailSample`; the record type. |
| `shared/venmo-ledger.ts` (create) | `VENMO_LEDGER_SECRET_KEY`, merge/prune/consume, `matchVenmoPayment`, `venmoDescription`, `VENMO_NOTE_MARK`. |
| `shared/category-guess.ts` (create) | `buildGuessIndex`, `guessCategory`, `guessKeys`, `guessSinceDay`, the thresholds. |
| `shared/change-entries.ts`, `change-undo.ts`, `change-undo-run.ts`, `change-view.ts`, `sync-overrides.ts`, `tx-story.ts` (modify) | `venmo-note` and `venmoNoteChange`; `noVenmoNote`; its Undo; the story line; a scoped rule's entry and Redo. |
| `shared/sync-core.ts`, `sync-host.ts`, `fake-host.ts` (modify) | The note at import and later; `planVenmoLateNotes`; the optional store methods. |
| `shared/status-keys.ts`, `shared/uncategorized.ts` (modify) | `venmo_mail_samples`; `UncategorizedRow.guess`. |
| `shared/categorize-menu.ts` (modify) | The guess on the list and first on the transaction screen; the scope toggle, scoped copy and count; `/newrule … in <account>` parsing and resolving. |
| `companion/src/venmo-mail.ts` (create) | `ingestVenmoMail`, `isVenmoMail`. |
| `companion/src/amazon-mail.ts` (modify) | `createImapSource(cfg, accept)`, `shareMailSource`, `mailBody` — the generic layer only. |
| `companion/src/sqlite-guess.ts` (create) | `getNativePastFilings`, strict. A focused file beside `sqlite-native.ts` (~1,950 lines). |
| `companion/src/uncategorized-status.ts`, `categorize.ts`, `wealthfolio.ts`, `rest-host.ts`, `index.ts` (modify) | The guess in the status and the menu; scoped rule writes; the Venmo store; the mail poll and `/newrule … in`. |
| `src/utils/secrets.ts`, `src/components/UncategorizedList.tsx`, `src/components/ui.tsx` (modify) | The Venmo ledger for an add-on sync, Reset's keys; the "Probably" hint and its style. |
| `CHANGELOG.md`, `README.md`, `docs/superpowers/follow-ups.md` (modify) | Docs and follow-ups §13. |

---

### Task 1: Read a Venmo email — direction, amount, the other person and the note

The pure parser (spec A "Reading emails"; Z1b). One function says what a Venmo message is — a payment (with its record), Venmo mail that moves no money (ignored), or something that looks like a payment and does not read (unrecognised) — the way `classifyAmazonEmail` does for Amazon. The formats are built from Venmo's documented wording, not captured emails; the test file says so. Also the sender check (a hand-forwarded copy counts), the 60-character clip, and the redacted sample an unreadable email becomes.

**Files:**
- Create: `shared/venmo.ts`, `shared/venmo.test.ts`

**Interfaces:**
- Consumes: `AmazonMailParts` (shared/amazon.ts — `{ subject?, plain?, html? }`, the generic three copies); `redactAmazonText` (shared/amazon-sample.ts); `AmazonMailSample` (shared/status-keys.ts).
- Produces:

```ts
export type VenmoDirection = 'out' | 'in';
export type VenmoKind = 'payment' | 'request' | 'bank-transfer';
export interface VenmoRecord { direction: VenmoDirection; kind: VenmoKind; amountCents: number; counterparty: string | null; note: string; paymentId?: string }
export type VenmoEmailStatus = 'payment' | 'ignored' | 'unrecognised';
export interface VenmoEmailClassification { status: VenmoEmailStatus; record?: VenmoRecord }
export const VENMO_NOTE_MAX: number;            // 60
export const VENMO_BANK_TRANSFER_NOTE: string;  // 'Transfer to your bank'
export function isVenmoMessage(from: string | undefined, body: string): boolean;
export function clipVenmoNote(raw: string): string;
export function classifyVenmoEmail(parts: AmazonMailParts): VenmoEmailClassification;
export function toVenmoMailSample(msg: { date: string; from?: string; parts: AmazonMailParts }): AmazonMailSample;
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/venmo.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import {
  classifyVenmoEmail, clipVenmoNote, isVenmoMessage, toVenmoMailSample, VENMO_BANK_TRANSFER_NOTE, VENMO_NOTE_MAX,
} from './venmo';

// Every fixture here is BUILT FROM VENMO'S DOCUMENTED NOTIFICATION WORDING, not
// copied from a real email — none has been seen yet. Replace them with Nick's
// real (redacted) emails when they arrive (follow-ups §13).

const PAID = {
  subject: 'You paid Jane Doe $25.00',
  plain: 'You paid Jane Doe\n$25.00\nRent October 🏠\nSee transaction\nPayment ID: 4123456789012345678\n',
};

describe('classifyVenmoEmail', () => {
  it('reads "You paid <name> $X": money out, the name, the amount and the note', () => {
    expect(classifyVenmoEmail(PAID)).toEqual({
      status: 'payment',
      record: {
        direction: 'out', kind: 'payment', amountCents: 2500, counterparty: 'Jane Doe', note: 'Rent October 🏠',
        paymentId: '4123456789012345678',
      },
    });
  });

  it('reads "<name> paid you $X" from the HTML copy, a signed amount and a quoted note', () => {
    const r = classifyVenmoEmail({
      subject: 'Sam Lee paid you $1,200.00',
      html: '\n\nSam Lee paid you\n\n\n+ $1,200.00\n\n"Utilities split"\n\nSee transaction\n',
    });
    expect(r).toEqual({
      status: 'payment',
      record: { direction: 'in', kind: 'payment', amountCents: 120000, counterparty: 'Sam Lee', note: 'Utilities split' },
    });
  });

  it('counts a charge request you completed as paid, and one completed for you as received', () => {
    expect(classifyVenmoEmail({
      subject: "You completed Alex Kim's $42.50 charge request",
      plain: "You completed Alex Kim's charge request\n- $42.50\nConcert tickets\n",
    }).record).toEqual({ direction: 'out', kind: 'request', amountCents: 4250, counterparty: 'Alex Kim', note: 'Concert tickets' });
    expect(classifyVenmoEmail({
      subject: 'Alex Kim paid your $18.00 request',
      plain: 'Alex Kim paid your request\n$18.00\nPizza night\n',
    }).record).toEqual({ direction: 'in', kind: 'request', amountCents: 1800, counterparty: 'Alex Kim', note: 'Pizza night' });
  });

  it('reads a transfer to your bank as money in, with a fixed note', () => {
    expect(classifyVenmoEmail({
      subject: 'Your $300.00 transfer to your bank has been initiated',
      plain: 'You transferred $300.00 to your bank account ending in 1234.\n',
    })).toEqual({
      status: 'payment',
      record: { direction: 'in', kind: 'bank-transfer', amountCents: 30000, counterparty: null, note: VENMO_BANK_TRANSFER_NOTE },
    });
    expect(VENMO_BANK_TRANSFER_NOTE).toBe('Transfer to your bank');
  });

  it('reads a message forwarded by hand: Fwd: off the subject, its header lines never the note', () => {
    const r = classifyVenmoEmail({
      subject: 'Fwd: You paid Jane Doe $25.00',
      plain: '---------- Forwarded message ---------\nFrom: Venmo <venmo@venmo.com>\nDate: Oct 3, 2026\n'
        + 'Subject: You paid Jane Doe $25.00\nTo: <nick@example.com>\n\nYou paid Jane Doe\n$25.00\nRent October\n',
    });
    expect(r.record).toEqual({ direction: 'out', kind: 'payment', amountCents: 2500, counterparty: 'Jane Doe', note: 'Rent October' });
  });

  it('reads the head from the body when the subject is not one', () => {
    const r = classifyVenmoEmail({ subject: 'Venmo', plain: 'Jane Doe paid you\n$7.00\nCoffee\n' });
    expect(r.record).toEqual({ direction: 'in', kind: 'payment', amountCents: 700, counterparty: 'Jane Doe', note: 'Coffee' });
  });

  it('keeps Markdown characters in a name or note raw — Telegram escapes them, not the parser', () => {
    const r = classifyVenmoEmail({ subject: 'You paid J_D *Smith* $9.99', plain: 'You paid J_D *Smith*\n$9.99\n*Rent* _Oct_ [2]\n' });
    expect(r.record).toMatchObject({ counterparty: 'J_D *Smith*', note: '*Rent* _Oct_ [2]' });
  });

  it('ignores Venmo mail that moves no money: a security code, a request, marketing', () => {
    expect(classifyVenmoEmail({ subject: 'Your Venmo security code', plain: 'Your code is 123456.' })).toEqual({ status: 'ignored' });
    expect(classifyVenmoEmail({ subject: 'Jane Doe requests $25.00', plain: 'Jane Doe requests\n$25.00\nRent' })).toEqual({ status: 'ignored' });
    expect(classifyVenmoEmail({ subject: 'Introducing Venmo Teen', plain: 'A debit card for teens.' })).toEqual({ status: 'ignored' });
  });

  it('calls a payment it cannot read unrecognised — no amount line, no note, or a shape it does not know', () => {
    expect(classifyVenmoEmail({ subject: 'You paid Jane Doe $25.00', plain: 'Something changed.\n' })).toEqual({ status: 'unrecognised' });
    expect(classifyVenmoEmail({ subject: 'You paid Jane Doe $25.00', plain: 'You paid Jane Doe\n$25.00\nSee transaction\n' }))
      .toEqual({ status: 'unrecognised' });
    expect(classifyVenmoEmail({ subject: 'Payment completed', plain: '$25.00 sent' })).toEqual({ status: 'unrecognised' });
    expect(classifyVenmoEmail({ subject: 'Your bank transfer is on its way', plain: 'Expect it in 1-3 business days.' }))
      .toEqual({ status: 'unrecognised' });
  });

  it('clips a long note to 60 characters and makes newlines spaces', () => {
    const long = 'Groceries for the whole apartment this week including the big Costco run';
    expect(clipVenmoNote(long)).toBe('Groceries for the whole apartment this week including the b…');
    expect([...clipVenmoNote(long)].length).toBe(VENMO_NOTE_MAX);
    expect(clipVenmoNote('Rent\nOctober\r\n  split')).toBe('Rent October split');
    expect(clipVenmoNote(`${'🍕'.repeat(70)}`)).toBe(`${'🍕'.repeat(59)}…`);
  });
});

describe('isVenmoMessage', () => {
  it('knows Venmo by its sender, or by the From: line of a hand-forwarded copy', () => {
    expect(isVenmoMessage('venmo@venmo.com', '')).toBe(true);
    expect(isVenmoMessage('nick@gmail.com', 'From: Venmo <venmo@venmo.com>\nYou paid Jane Doe')).toBe(true);
    expect(isVenmoMessage('nick@gmail.com', 'I paid Jane on venmo.com yesterday')).toBe(false);
    expect(isVenmoMessage('auto-confirm@amazon.com', 'Thanks for your order')).toBe(false);
    expect(isVenmoMessage(undefined, '')).toBe(false);
  });
});

describe('toVenmoMailSample', () => {
  it('redacts like Amazon’s samples and keeps Venmo’s own sender', () => {
    const s = toVenmoMailSample({
      date: '2026-10-03T12:00:00Z',
      from: 'venmo@venmo.com',
      parts: { subject: 'You paid Jane Doe $25.00', plain: 'Hello Nicholas,\nYou paid Jane Doe\n\n$25.00\nsent to nick@example.com\n' },
    });
    expect(s).toEqual({
      at: '2026-10-03T12:00:00Z', from: 'venmo@venmo.com', subject: 'You paid Jane Doe $25.00',
      plain: 'Hello Jordan,\nYou paid Jane Doe\n$25.00\nsent to <email>', html: '',
    });
    expect(toVenmoMailSample({ date: 'x', from: 'nick@gmail.com', parts: {} }).from).toBe('<email>');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/venmo.test.ts`
Expected: FAIL — `Failed to resolve import "./venmo"`; no tests run.

- [ ] **Step 3: Implement**

**Create `shared/venmo.ts`:**

```ts
/**
 * shared/venmo.ts
 *
 * Reading Venmo's payment emails (project 3, "Less filing"): which way the
 * money went, how much, the other person and the note — so a bank row that
 * says only `VENMO PAYMENT 1023` can carry what the payment was for.
 *
 * UNVERIFIED FORMATS. No real Venmo email has been seen by this code. The
 * patterns are built from the wording Venmo documents for its notifications —
 * "You paid <name> $X", "<name> paid you $X", a completed charge request, and a
 * transfer to your bank — and each fixture in ./venmo.test.ts says so. Anything
 * that looks like a payment and does not read is left unread and kept as a
 * sample, like Amazon's, so the first real email that breaks a pattern is
 * visible rather than silently noteless.
 *
 * Host-agnostic, like ./amazon.ts: the companion reads the mailbox, both
 * syncers read the ledger (./venmo-ledger.ts). Bank and user text stays RAW.
 */
import type { AmazonMailParts } from './amazon.js';
import { redactAmazonText } from './amazon-sample.js';
import type { AmazonMailSample } from './status-keys.js';

/** `out`: you paid. `in`: you were paid, or moved money to your bank. */
export type VenmoDirection = 'out' | 'in';
export type VenmoKind = 'payment' | 'request' | 'bank-transfer';

/** One payment as an email describes it. */
export interface VenmoRecord {
  direction: VenmoDirection;
  kind: VenmoKind;
  /** Integer cents — the figure a bank row must equal exactly. */
  amountCents: number;
  /** The other person, raw; null for a transfer to your bank. */
  counterparty: string | null;
  /** What the bank row gets: the payment's note, or `VENMO_BANK_TRANSFER_NOTE`.
   *  Newlines are spaces and it is at most `VENMO_NOTE_MAX` characters. Raw. */
  note: string;
  /** Venmo's own payment id, when the email shows one. */
  paymentId?: string;
}

/** What a message turned out to be. */
export type VenmoEmailStatus =
  /** Read: `record` is set. */
  | 'payment'
  /** Venmo, but not money that moved (a security code, a request, marketing). */
  | 'ignored'
  /** Looks like a payment and did not read — a possible format change. */
  | 'unrecognised';

export interface VenmoEmailClassification {
  status: VenmoEmailStatus;
  record?: VenmoRecord;
}

export const VENMO_NOTE_MAX = 60;
/** The note a transfer to your bank carries: it has no note of its own. */
export const VENMO_BANK_TRANSFER_NOTE = 'Transfer to your bank';

/** Whether a message came from Venmo — by sender, or by the `From:` line of a
 *  message forwarded by hand (Gmail does not forward old mail; see
 *  `isAmazonMessage`). */
export function isVenmoMessage(from: string | undefined, body: string): boolean {
  if (from && /@venmo\.com$/i.test(from)) return true;
  return /^\s*From:.*@venmo\.com\b/im.test(body);
}

/** Every run of whitespace a single space, then at most `VENMO_NOTE_MAX`
 *  characters (code points, so an emoji is never cut in half), `…` marking a cut. */
export function clipVenmoNote(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= VENMO_NOTE_MAX ? flat : `${chars.slice(0, VENMO_NOTE_MAX - 1).join('').trimEnd()}…`;
}

const MONEY = String.raw`\$\s?([\d,]+\.\d{2})`;
const cents = (s: string) => Math.round(parseFloat(s.replace(/,/g, '')) * 100);

interface Head { re: RegExp; direction: VenmoDirection; kind: VenmoKind }

/** A head line with its amount, in the subject or the body. Requests first:
 *  "You paid Jane's $25.00 request" must not read as a payment to "Jane's". */
const HEADS: Head[] = [
  { re: new RegExp(`^You (?:paid|completed) (.+?)'s ${MONEY} (?:charge )?request$`, 'i'), direction: 'out', kind: 'request' },
  { re: new RegExp(`^(.+?) (?:paid|completed) your ${MONEY} (?:charge )?request$`, 'i'), direction: 'in', kind: 'request' },
  { re: new RegExp(`^You paid (.+?) ${MONEY}$`, 'i'), direction: 'out', kind: 'payment' },
  { re: new RegExp(`^(.+?) paid you ${MONEY}$`, 'i'), direction: 'in', kind: 'payment' },
];

/** A head line without its amount; the amount is the next line of the body. */
const NAME_HEADS: Head[] = [
  { re: /^You (?:paid|completed) (.+?)'s (?:charge )?request$/i, direction: 'out', kind: 'request' },
  { re: /^(.+?) (?:paid|completed) your (?:charge )?request$/i, direction: 'in', kind: 'request' },
  { re: /^You paid (.+)$/i, direction: 'out', kind: 'payment' },
  { re: /^(.+?) paid you$/i, direction: 'in', kind: 'payment' },
];

/** `$25.00`, `+ $25.00`, `- $1,200.00` alone on a line. */
const AMOUNT_LINE = new RegExp(`^[-+−]?\\s*${MONEY}$`);
const ANY_AMOUNT = new RegExp(MONEY);
const BANK_TRANSFER = /\btransfer(?:red)?\b.*\bto your bank\b|\bbank transfer\b/i;
const LOOKS_LIKE_PAYMENT = /\b(?:paid|completed|transfer(?:red)?)\b/i;
const PAYMENT_ID = /\b(?:Payment|Transaction) ID:?\s*#?\s*(\d{6,})/i;
/** `Fwd: `, `FW: `, `Re: ` — however many. */
const REPLY_PREFIX = /^(?:\s*(?:re|fwd?)\s*:\s*)+/i;

/** Lines around a payment that are never its note. */
const NOT_A_NOTE: RegExp[] = [
  AMOUNT_LINE,
  /^(?:see|view) (?:transaction|payment|details|in app)\b/i,
  /^(?:like|comment)(?:\s*[·|]\s*(?:like|comment))?$/i,
  /^(?:transfer date|payment id|transaction id|payment method|funding source|completed via|money (?:credited|debited))\b/i,
  /^(?:private|friends|public|venmo|help center)$/i,
  /^(?:from|to|date|subject|sent|cc):/i,
  /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2},? \d{4}\b/i,
  /^[-–—_=·•*|\s]+$/,
];

const isNote = (line: string) => line !== '' && !NOT_A_NOTE.some((re) => re.test(line));
const unquote = (s: string) => s.replace(/^["“”']+|["“”']+$/g, '').trim();
const linesOf = (text: string | null | undefined) => (text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function matchHead(line: string, heads: Head[]): { head: Head; m: RegExpExecArray } | null {
  for (const head of heads) {
    const m = head.re.exec(line);
    if (m) return { head, m };
  }
  return null;
}

/**
 * The note: the first line after the payment's amount that is not boilerplate,
 * within a few lines of it. The anchor is a line holding exactly the amount, or
 * failing that the head line itself. No anchor, no note — a guess would put the
 * wrong words on a real transaction.
 */
function noteAfter(lines: string[], amountCents: number): string {
  let anchor = lines.findIndex((l) => {
    const m = AMOUNT_LINE.exec(l);
    return !!m && cents(m[1]) === amountCents;
  });
  if (anchor === -1) anchor = lines.findIndex((l) => matchHead(l, HEADS) !== null);
  if (anchor === -1) return '';
  for (const line of lines.slice(anchor + 1, anchor + 7)) {
    if (isNote(line)) return clipVenmoNote(unquote(line));
  }
  return '';
}

/** The head from the body: a line with its amount, or a name line with the
 *  amount alone on the next line. */
function headFromBody(lines: string[]): { direction: VenmoDirection; kind: VenmoKind; name: string; amountCents: number } | null {
  for (let i = 0; i < lines.length; i += 1) {
    const full = matchHead(lines[i], HEADS);
    if (full) return { ...full.head, name: full.m[1].trim(), amountCents: cents(full.m[2]) };
    const named = matchHead(lines[i], NAME_HEADS);
    const next = named ? AMOUNT_LINE.exec(lines[i + 1] ?? '') : null;
    if (named && next) return { ...named.head, name: named.m[1].trim(), amountCents: cents(next[1]) };
  }
  return null;
}

/**
 * THE single definition of what a Venmo message is (the poll and anything
 * diagnostic ask this, as `classifyAmazonEmail` is for Amazon).
 *
 * The subject is read first (minus `Fwd:`), then each copy of the body. A
 * payment needs its note: without one there is nothing to add to the bank row,
 * and a message that names a payment but shows no note is unrecognised, not
 * ignored, so it stays unread and becomes a sample.
 */
export function classifyVenmoEmail(parts: AmazonMailParts): VenmoEmailClassification {
  const subject = (parts.subject ?? '').replace(REPLY_PREFIX, '').trim();
  const copies = [linesOf(parts.plain), linesOf(parts.html)].filter((c) => c.length > 0);
  const all = [subject, ...copies.flat()].join('\n');
  const paymentId = PAYMENT_ID.exec(all)?.[1];
  const withId = (r: VenmoRecord): VenmoRecord => (paymentId ? { ...r, paymentId } : r);

  const fromSubject = matchHead(subject, HEADS);
  const head = fromSubject
    ? { ...fromSubject.head, name: fromSubject.m[1].trim(), amountCents: cents(fromSubject.m[2]) }
    : null;
  const found = head ?? (BANK_TRANSFER.test(subject) ? null : copies.map(headFromBody).find((h) => h !== null) ?? null);
  if (found) {
    for (const lines of copies) {
      const note = noteAfter(lines, found.amountCents);
      if (note) {
        return {
          status: 'payment',
          record: withId({ direction: found.direction, kind: found.kind, amountCents: found.amountCents, counterparty: found.name, note }),
        };
      }
    }
    return { status: 'unrecognised' };
  }

  const transferLine = [subject, ...copies.flat()].find((l) => BANK_TRANSFER.test(l));
  if (transferLine !== undefined) {
    const amount = ANY_AMOUNT.exec(transferLine) ?? ANY_AMOUNT.exec(subject) ?? ANY_AMOUNT.exec(copies.flat().join('\n'));
    if (!amount) return { status: 'unrecognised' };
    return {
      status: 'payment',
      record: withId({ direction: 'in', kind: 'bank-transfer', amountCents: cents(amount[1]), counterparty: null, note: VENMO_BANK_TRANSFER_NOTE }),
    };
  }

  return LOOKS_LIKE_PAYMENT.test(subject) && ANY_AMOUNT.test(all) ? { status: 'unrecognised' } : { status: 'ignored' };
}

/** A copy of an unreadable Venmo email, safe to keep: the same redaction as
 *  Amazon's samples (addresses, greeting, card digits, link codes), keeping
 *  Venmo's own sender. Names in a payment line stay — the parser needs them. */
export function toVenmoMailSample(msg: { date: string; from?: string; parts: AmazonMailParts }): AmazonMailSample {
  const copy = (t: string | null | undefined) => redactAmazonText(t ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '').slice(0, 80).join('\n').slice(0, 4000);
  return {
    at: msg.date,
    ...(msg.from ? { from: /@venmo\.com$/i.test(msg.from) ? msg.from : '<email>' } : {}),
    subject: redactAmazonText(msg.parts.subject ?? ''),
    plain: copy(msg.parts.plain),
    html: copy(msg.parts.html),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/venmo.test.ts`
Expected: PASS — 12 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/venmo.ts shared/venmo.test.ts
git commit -m "Venmo: read a payment email — direction, amount, the other person and the note

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The Venmo ledger and the match — VENMO, exact amount, same direction, ±5 days, one record

The `amazon-ledger.ts` pattern for Venmo (spec A "Matching" and "The note"): merge by key (Venmo's payment id when the email had one), prune at 90 days, consume by `accountTxKey`, and the match a bank row needs — the word VENMO, the exact amount, the same direction, the email within ±5 days, exactly one candidate. Plus the note's mark, ` · Venmo: `, and reading it back. Pure.

**Files:**
- Create: `shared/venmo-ledger.ts`, `shared/venmo-ledger.test.ts`

**Interfaces:**
- Consumes: Task 1 (`VenmoRecord`, `VenmoDirection`).
- Produces:

```ts
export interface VenmoLedgerRecord extends VenmoRecord { emailDate: string; consumedBy?: string }
export type VenmoLedger = Record<string, VenmoLedgerRecord>;
export const VENMO_LEDGER_SECRET_KEY: string;     // 'venmo_ledger'
export const VENMO_MATCH_WINDOW_DAYS: number;     // 5
export const VENMO_LEDGER_RETENTION_DAYS: number; // 90
export const VENMO_NOTE_MARK: string;             // ' · Venmo: '
export function isVenmoDescription(description: string | null | undefined): boolean;
export function venmoLedgerKey(r: VenmoRecord, emailDate: string): string;
export function mergeVenmoRecords(ledger: VenmoLedger, records: readonly VenmoRecord[], emailDate: string): { ledger: VenmoLedger; added: number };
export function pruneVenmoLedger(ledger: VenmoLedger, nowMs: number, days?: number): { ledger: VenmoLedger; removed: number };
export interface VenmoPaymentQuery { description: string; amountCents: number; direction: VenmoDirection; postedMs: number; txKey: string }
export interface VenmoMatch { key: string; note: string; counterparty: string | null }
export function matchVenmoPayment(ledger: VenmoLedger, query: VenmoPaymentQuery, windowDays?: number): VenmoMatch | null;
export function consumeVenmoMatch(ledger: VenmoLedger, match: VenmoMatch, txKey: string): VenmoLedger;
export function venmoDescription(description: string, note: string): string;
export function venmoNoteOf(bare: string, enriched: string): string;
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/venmo-ledger.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import {
  consumeVenmoMatch, isVenmoDescription, matchVenmoPayment, mergeVenmoRecords, pruneVenmoLedger, venmoDescription,
  venmoLedgerKey, venmoNoteOf, VENMO_LEDGER_SECRET_KEY, VENMO_NOTE_MARK, type VenmoLedger, type VenmoPaymentQuery,
} from './venmo-ledger';
import type { VenmoRecord } from './venmo';

const RENT: VenmoRecord = { direction: 'out', kind: 'payment', amountCents: 2500, counterparty: 'Jane Doe', note: 'Rent October' };
const at = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
const ledgerOf = (...recs: Array<VenmoRecord & { emailDate: string; consumedBy?: string }>): VenmoLedger =>
  Object.fromEntries(recs.map((r, i) => [`k${i}`, r]));
const query = (over: Partial<VenmoPaymentQuery> = {}): VenmoPaymentQuery => ({
  description: 'VENMO PAYMENT 1023', amountCents: 2500, direction: 'out', postedMs: at('2026-10-04'), txKey: 'sfin-1\u0000tx-v', ...over,
});

describe('matchVenmoPayment', () => {
  const one = ledgerOf({ ...RENT, emailDate: '2026-10-03' });

  it('matches the one payment with the same amount and direction within 5 days', () => {
    expect(matchVenmoPayment(one, query())).toEqual({ key: 'k0', note: 'Rent October', counterparty: 'Jane Doe' });
  });

  it('needs the word VENMO in the bank text, any case', () => {
    expect(isVenmoDescription('PAYPAL *VENMO 4029357733')).toBe(true);
    expect(isVenmoDescription('Venmo cashout')).toBe(true);
    expect(isVenmoDescription('VENMOX STORE')).toBe(false);
    expect(matchVenmoPayment(one, query({ description: 'ZELLE TO JANE DOE' }))).toBeNull();
  });

  it('gives no note when the direction does not match — a deposit is not a payment you made', () => {
    expect(matchVenmoPayment(one, query({ direction: 'in' }))).toBeNull();
  });

  it('needs the exact amount', () => {
    expect(matchVenmoPayment(one, query({ amountCents: 2501 }))).toBeNull();
  });

  it('allows 5 days either side of the email and not a moment more', () => {
    const email = Date.parse('2026-10-03');
    expect(matchVenmoPayment(one, query({ postedMs: email + 5 * 86_400_000 }))).not.toBeNull();
    expect(matchVenmoPayment(one, query({ postedMs: email - 5 * 86_400_000 }))).not.toBeNull();
    expect(matchVenmoPayment(one, query({ postedMs: email + 5 * 86_400_000 + 1 }))).toBeNull();
  });

  it('gives no note when two payments of the same amount fall in the window', () => {
    const two = ledgerOf({ ...RENT, emailDate: '2026-10-03' }, { ...RENT, note: 'Cable', emailDate: '2026-10-05' });
    expect(matchVenmoPayment(two, query())).toBeNull();
  });

  it('never offers a payment another row consumed; offers one this row consumed again', () => {
    expect(matchVenmoPayment(ledgerOf({ ...RENT, emailDate: '2026-10-03', consumedBy: 'sfin-1\u0000tx-other' }), query())).toBeNull();
    expect(matchVenmoPayment(ledgerOf({ ...RENT, emailDate: '2026-10-03', consumedBy: 'sfin-1\u0000tx-v' }), query())).not.toBeNull();
  });

  it('skips a record whose email date cannot be read', () => {
    expect(matchVenmoPayment(ledgerOf({ ...RENT, emailDate: 'not a date' }), query())).toBeNull();
  });
});

describe('the ledger', () => {
  it('lives in the venmo_ledger secret', () => {
    expect(VENMO_LEDGER_SECRET_KEY).toBe('venmo_ledger');
  });

  it('keys by Venmo’s payment id when there is one, else by every field and the day', () => {
    expect(venmoLedgerKey({ ...RENT, paymentId: '41234567' }, '2026-10-03')).toBe('id|41234567');
    expect(venmoLedgerKey(RENT, '2026-10-03')).toBe('out|2500|Jane Doe|Rent October|2026-10-03');
  });

  it('merges idempotently and never revives a consumed record', () => {
    const first = mergeVenmoRecords({}, [RENT], '2026-10-03');
    expect(first.added).toBe(1);
    const key = venmoLedgerKey(RENT, '2026-10-03');
    const consumed = consumeVenmoMatch(first.ledger, { key, note: 'Rent October', counterparty: 'Jane Doe' }, 'sfin-1\u0000tx-v');
    const again = mergeVenmoRecords(consumed, [RENT], '2026-10-03');
    expect(again.added).toBe(0);
    expect(again.ledger[key].consumedBy).toBe('sfin-1\u0000tx-v');
  });

  it('prunes records older than 90 days', () => {
    const ledger = ledgerOf({ ...RENT, emailDate: '2026-07-01' }, { ...RENT, note: 'Cable', emailDate: '2026-10-01' });
    const out = pruneVenmoLedger(ledger, at('2026-10-14'));
    expect(out.removed).toBe(1);
    expect(Object.values(out.ledger).map((r) => r.note)).toEqual(['Cable']);
  });

  it('consuming a key that is gone changes nothing', () => {
    const ledger = ledgerOf({ ...RENT, emailDate: '2026-10-03' });
    expect(consumeVenmoMatch(ledger, { key: 'missing', note: '', counterparty: null }, 'x')).toBe(ledger);
  });
});

describe('the note on the bank row', () => {
  it('appends " · Venmo: <note>" to the bank’s own words and reads it back', () => {
    expect(VENMO_NOTE_MARK).toBe(' · Venmo: ');
    expect(venmoDescription('VENMO PAYMENT 1023', 'Rent October')).toBe('VENMO PAYMENT 1023 · Venmo: Rent October');
    expect(venmoDescription('VENMO PAYMENT 1023', '')).toBe('VENMO PAYMENT 1023');
    expect(venmoNoteOf('VENMO PAYMENT 1023', 'VENMO PAYMENT 1023 · Venmo: Rent · split')).toBe('Rent · split');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/venmo-ledger.test.ts`
Expected: FAIL — `Failed to resolve import "./venmo-ledger"`; no tests run.

- [ ] **Step 3: Implement**

**Create `shared/venmo-ledger.ts`:**

```ts
/**
 * shared/venmo-ledger.ts
 *
 * Remembering parsed Venmo payments, and deciding which bank row each one is —
 * the `amazon-ledger.ts` pattern (merge by key, prune at 90 days, consume by
 * `accountTxKey`), with Venmo's own match: the word VENMO in the bank text, the
 * exact amount, the same direction, ±5 days of the email, and exactly one
 * record. Host-agnostic; the ledger is an add-on secret both syncers read and
 * the companion's mail poll writes.
 */
import type { VenmoDirection, VenmoRecord } from './venmo.js';

export interface VenmoLedgerRecord extends VenmoRecord {
  /** The EMAIL's date (YYYY-MM-DD), the anchor the ±window is measured from. */
  emailDate: string;
  /** The `accountTxKey` this payment was matched to — consumed, never deleted,
   *  so a re-read email cannot offer it to a second row. */
  consumedBy?: string;
}

export type VenmoLedger = Record<string, VenmoLedgerRecord>;

/** Written by the companion (it reads the mailbox), read by both syncers. */
export const VENMO_LEDGER_SECRET_KEY = 'venmo_ledger';
export const VENMO_MATCH_WINDOW_DAYS = 5;
export const VENMO_LEDGER_RETENTION_DAYS = 90;
/** What goes between the bank's text and the note: `VENMO PAYMENT 1023 · Venmo: Rent October`. */
export const VENMO_NOTE_MARK = ' · Venmo: ';

const DAY_MS = 86_400_000;

/** Whether a bank description is a Venmo row: the word VENMO, any case. */
export function isVenmoDescription(description: string | null | undefined): boolean {
  return /\bvenmo\b/i.test(description ?? '');
}

/** Ledger key: Venmo's payment id when the email had one; otherwise every field
 *  and the email's day, so re-reading the same message adds nothing. */
export function venmoLedgerKey(r: VenmoRecord, emailDate: string): string {
  return r.paymentId
    ? `id|${r.paymentId}`
    : `${r.direction}|${r.amountCents}|${r.counterparty ?? ''}|${r.note}|${emailDate}`;
}

/** Fold newly parsed payments in. Idempotent: a known key is left exactly as it
 *  is, so a consumed record is never revived as a fresh candidate. */
export function mergeVenmoRecords(
  ledger: VenmoLedger,
  records: readonly VenmoRecord[],
  emailDate: string,
): { ledger: VenmoLedger; added: number } {
  const next: VenmoLedger = { ...ledger };
  let added = 0;
  for (const r of records) {
    const key = venmoLedgerKey(r, emailDate);
    if (next[key]) continue;
    next[key] = { ...r, emailDate };
    added += 1;
  }
  return { ledger: next, added };
}

/** Drop records older than the retention window, matched or not. */
export function pruneVenmoLedger(
  ledger: VenmoLedger,
  nowMs: number,
  days = VENMO_LEDGER_RETENTION_DAYS,
): { ledger: VenmoLedger; removed: number } {
  const cutoff = nowMs - days * DAY_MS;
  const next: VenmoLedger = {};
  let removed = 0;
  for (const [key, rec] of Object.entries(ledger)) {
    const t = Date.parse(rec.emailDate);
    if (Number.isFinite(t) && t < cutoff) { removed += 1; continue; }
    next[key] = rec;
  }
  return { ledger: next, removed };
}

export interface VenmoPaymentQuery {
  /** The bank's own description. */
  description: string;
  /** Magnitude in cents. */
  amountCents: number;
  /** Which way the bank row moved money: `out` for a negative SimpleFin amount. */
  direction: VenmoDirection;
  /** When the row posted, epoch ms. */
  postedMs: number;
  /** `accountTxKey(sfAccountId, txId)`. */
  txKey: string;
}

export interface VenmoMatch {
  /** The ledger key, consumed by `consumeVenmoMatch`. */
  key: string;
  note: string;
  counterparty: string | null;
}

/**
 * The Venmo payment a bank row is, or null. Two candidates — two $25.00
 * payments the same week — is null: a wrong note on real money is invisible,
 * a missing one is merely a row without a note. A record consumed by another
 * row is not a candidate; one consumed by THIS row is, so a re-run is
 * idempotent.
 */
export function matchVenmoPayment(
  ledger: VenmoLedger,
  query: VenmoPaymentQuery,
  windowDays = VENMO_MATCH_WINDOW_DAYS,
): VenmoMatch | null {
  if (!isVenmoDescription(query.description)) return null;
  const window = windowDays * DAY_MS;
  const hits: Array<[string, VenmoLedgerRecord]> = [];
  for (const [key, rec] of Object.entries(ledger)) {
    if (rec.amountCents !== query.amountCents || rec.direction !== query.direction) continue;
    if (rec.consumedBy && rec.consumedBy !== query.txKey) continue;
    const emailMs = Date.parse(rec.emailDate);
    if (!Number.isFinite(emailMs) || Math.abs(query.postedMs - emailMs) > window) continue;
    hits.push([key, rec]);
  }
  if (hits.length !== 1) return null;
  const [key, rec] = hits[0];
  return { key, note: rec.note, counterparty: rec.counterparty };
}

/** Record that a payment's bank row was found. */
export function consumeVenmoMatch(ledger: VenmoLedger, match: VenmoMatch, txKey: string): VenmoLedger {
  return ledger[match.key] ? { ...ledger, [match.key]: { ...ledger[match.key], consumedBy: txKey } } : ledger;
}

/** The description to store: the bank's text, then ` · Venmo: <note>`.
 *  APPENDED, never substituted — the bank's words are what every mapping rule
 *  and the person recognise; Wealthfolio's category rules read the note too. */
export function venmoDescription(description: string, note: string): string {
  return note ? `${description}${VENMO_NOTE_MARK}${note}` : description;
}

/** The note `venmoDescription` added: the text after ` · Venmo: `. */
export function venmoNoteOf(bare: string, enriched: string): string {
  const head = `${bare}${VENMO_NOTE_MARK}`;
  return enriched.startsWith(head) ? enriched.slice(head.length) : enriched;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/venmo-ledger.test.ts`
Expected: PASS — 14 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/venmo-ledger.ts shared/venmo-ledger.test.ts
git commit -m "Venmo: the payment ledger and the match — VENMO, exact amount, same direction, ±5 days, one record

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The change log — `venmo-note`, `noVenmoNote`, its Undo and the story's line

A Venmo note is a sync decision (spec A "The note"; Z1e): the new kind `venmo-note` (actor auto, under Categories beside Amazon labels, before → after the two notes), the new override `noVenmoNote` (worded in the app's overrides list and the story), and its Undo — the override FIRST, then the old note written back, as an Amazon label's (Deviation: the note comes off at once). Its Redo clears the override and the next sync adds the note again. The story says "Note from a Venmo email." under where the row came from.

**Files:**
- Modify: `shared/sync-overrides.ts`, `shared/change-entries.ts`, `shared/change-view.ts`, `shared/change-undo.ts`, `shared/change-undo-run.ts`, `shared/tx-story.ts`
- Test: `shared/sync-overrides.test.ts`, `shared/change-entries.test.ts`, `shared/change-view.test.ts`, `shared/change-undo.test.ts`, `shared/change-undo-run.test.ts`, `shared/tx-story.test.ts`

**Interfaces:**
- Consumes: Task 2 (`VENMO_NOTE_MARK`).
- Produces:

```ts
// shared/sync-overrides.ts
export const TX_OVERRIDE_FLAGS: readonly ['notTransfer', 'keepDuplicate', 'noAutoFile', 'noAmazonLabel', 'noVenmoNote'];
// shared/change-entries.ts
export type ChangeKind = /* … */ | 'venmo-note';
export interface VenmoNoteFacts {
  account: ChangeAccount; txKey: string; activityId: string; description: string; amountCents: number; date: string;
  beforeNote: string; afterNote: string; note: string;
}
export function venmoNoteChange(f: VenmoNoteFacts): ChangeDraft;  // before: { comment }, after: { comment, note }
// shared/tx-story.ts
export const TX_STORY_VENMO_NOTE: string;  // 'Note from a Venmo email.'
```

- [ ] **Step 1: Write the failing tests**

Edit 1 of 1 in `shared/sync-overrides.test.ts` — replace:

```ts
    const next = removeOverrideRow(o, first);
    expect(overrideRows(next).map((r) => r.flag)).toEqual(['notTransfer']);
  });
});
```

with:

```ts
    const next = removeOverrideRow(o, first);
    expect(overrideRows(next).map((r) => r.flag)).toEqual(['notTransfer']);
  });

  it('lists a Venmo note override in words, and a document holding one reads back', () => {
    const o = setTxOverride(emptySyncOverrides(), OUT, 'noVenmoNote', NOW, { label: 'VENMO PAYMENT 1023 · Checking' });
    expect(overrideRows(o).map((r) => r.text)).toEqual(['No Venmo note: VENMO PAYMENT 1023 · Checking']);
    expect(parseSyncOverrides(JSON.stringify(o))).toEqual({ kind: 'ok', overrides: o });
    expect(hasTxOverride(o, OUT, 'noVenmoNote')).toBe(true);
  });
});
```

Edit 1 of 3 in `shared/change-entries.test.ts` — replace:

```ts
  accountCreatedChange, amazonLabelChange, amazonLabelOf, balanceCorrectionChange, bankUpdateChange, bookkeepingChange,
  categoryFiledChange, categoryRuleCreatedChange, CHANGE_KINDS, changeDay, changeMoney, duplicateRemovedChange,
  importChange, mappingRuleCreatedChange, newEntryId, newRunId, openingBalanceFiledChange, pendingRemovedChange,
  stampChange, startingBalanceChange, startingBalanceMovedChange, transferLinkChange, transferTypeChange,
  type ChangeDraft,
} from './change-entries.js';
import { accountTxKey } from './transfers.js';
```

with:

```ts
  accountCreatedChange, amazonLabelChange, amazonLabelOf, balanceCorrectionChange, bankUpdateChange, bookkeepingChange,
  categoryFiledChange, categoryRuleCreatedChange, CHANGE_KINDS, changeDay, changeMoney, duplicateRemovedChange,
  importChange, mappingRuleCreatedChange, newEntryId, newRunId, openingBalanceFiledChange, pendingRemovedChange,
  stampChange, startingBalanceChange, startingBalanceMovedChange, transferLinkChange, transferTypeChange, venmoNoteChange,
  type ChangeDraft,
} from './change-entries.js';
import { accountTxKey } from './transfers.js';
```

Edit 2 of 3 in `shared/change-entries.test.ts` — replace:

```ts
  });

  it('lists every kind once', () => {
    expect(new Set(CHANGE_KINDS).size).toBe(16);
  });
});

```

with:

```ts
  });

  it('lists every kind once', () => {
    expect(new Set(CHANGE_KINDS).size).toBe(17);
  });
});

```

Edit 3 of 3 in `shared/change-entries.test.ts` — replace:

```ts
      account: CARD, txKey: KEY, activityId: 'act-4', description: 'AMAZON MKTPL*2K4', amountCents: -1080, date: '2026-09-15',
      beforeNote: 'AMAZON MKTPL*2K4 · TRN-a1b2', afterNote: 'AMAZON MKTPL*2K4 · Amazon: Hair Care · TRN-a1b2', label: 'Hair Care',
    }), 'Added the Amazon label "Hair Care" to AMAZON MKTPL*2K4'],
    ['category-filed (first)', categoryFiledChange({
      actor: 'auto', account: CARD, activityId: 'act-4', description: 'AMAZON MKTPL*2K4',
      before: null, after: { categoryId: 'cat-hair', categoryName: 'Personal Care' }, why: 'Amazon: Hair Care',
```

with:

```ts
      account: CARD, txKey: KEY, activityId: 'act-4', description: 'AMAZON MKTPL*2K4', amountCents: -1080, date: '2026-09-15',
      beforeNote: 'AMAZON MKTPL*2K4 · TRN-a1b2', afterNote: 'AMAZON MKTPL*2K4 · Amazon: Hair Care · TRN-a1b2', label: 'Hair Care',
    }), 'Added the Amazon label "Hair Care" to AMAZON MKTPL*2K4'],
    ['venmo-note', venmoNoteChange({
      account: CHECKING, txKey: KEY, activityId: 'act-6', description: 'VENMO PAYMENT 1023', amountCents: -2500, date: '2026-10-04',
      beforeNote: 'VENMO PAYMENT 1023 · TRN-a1b2', afterNote: 'VENMO PAYMENT 1023 · Venmo: *Rent* _Oct_ · TRN-a1b2', note: '*Rent* _Oct_',
    }), 'Added the Venmo note "*Rent* _Oct_" to VENMO PAYMENT 1023'],
    ['category-filed (first)', categoryFiledChange({
      actor: 'auto', account: CARD, activityId: 'act-4', description: 'AMAZON MKTPL*2K4',
      before: null, after: { categoryId: 'cat-hair', categoryName: 'Personal Care' }, why: 'Amazon: Hair Care',
```

Edit 1 of 3 in `shared/change-view.test.ts` — replace:

```ts
import { describe, it, expect } from 'vitest';
import {
  amazonLabelChange, bankUpdateChange, bookkeepingChange, categoryFiledChange, CHANGE_KINDS, importChange,
  stampChange, startingBalanceMovedChange, transferLinkChange, transferTypeChange, type ChangeDraft,
} from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import {
```

with:

```ts
import { describe, it, expect } from 'vitest';
import {
  amazonLabelChange, bankUpdateChange, bookkeepingChange, categoryFiledChange, CHANGE_KINDS, importChange,
  stampChange, startingBalanceMovedChange, transferLinkChange, transferTypeChange, venmoNoteChange, type ChangeDraft,
} from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import {
```

Edit 2 of 3 in `shared/change-view.test.ts` — replace:

```ts
    expect(changeGroupOf('bookkeeping')).toBe('background');
    expect(changeGroupOf('import')).toBe('imports');
    expect(changeGroupOf('category-rule-created')).toBe('rules');
  });

  it('shows a kind from a newer version instead of hiding it', () => {
```

with:

```ts
    expect(changeGroupOf('bookkeeping')).toBe('background');
    expect(changeGroupOf('import')).toBe('imports');
    expect(changeGroupOf('category-rule-created')).toBe('rules');
    expect(changeGroupOf('venmo-note')).toBe('categories');
  });

  it('shows a kind from a newer version instead of hiding it', () => {
```

Edit 3 of 3 in `shared/change-view.test.ts` — replace:

```ts
      account: CARD, txKey: 'k', activityId: 'a', description: 'AMAZON', amountCents: -1, date: '2026-09-15',
      beforeNote: 'AMAZON · TRN-1', afterNote: 'AMAZON · Amazon: Books · TRN-1', label: 'Books',
    }), 'AMAZON · TRN-1 → AMAZON · Amazon: Books · TRN-1'],
    ['a held transfer', transferTypeChange({
      account: CHECKING, txKey: 'k', activityId: 'a', description: 'X', amountCents: -1, date: '2026-10-01',
      activityType: 'TRANSFER_OUT', previousType: null, held: true,
```

with:

```ts
      account: CARD, txKey: 'k', activityId: 'a', description: 'AMAZON', amountCents: -1, date: '2026-09-15',
      beforeNote: 'AMAZON · TRN-1', afterNote: 'AMAZON · Amazon: Books · TRN-1', label: 'Books',
    }), 'AMAZON · TRN-1 → AMAZON · Amazon: Books · TRN-1'],
    ['a Venmo note', venmoNoteChange({
      account: CHECKING, txKey: 'k', activityId: 'a', description: 'VENMO', amountCents: -2500, date: '2026-10-04',
      beforeNote: 'VENMO · TRN-1', afterNote: 'VENMO · Venmo: Rent · TRN-1', note: 'Rent',
    }), 'VENMO · TRN-1 → VENMO · Venmo: Rent · TRN-1'],
    ['a held transfer', transferTypeChange({
      account: CHECKING, txKey: 'k', activityId: 'a', description: 'X', amountCents: -1, date: '2026-10-01',
      activityType: 'TRANSFER_OUT', previousType: null, held: true,
```

Edit 1 of 2 in `shared/change-undo.test.ts` — replace:

```ts
import {
  amazonLabelChange, balanceCorrectionChange, bankUpdateChange, categoryFiledChange, categoryRuleCreatedChange,
  duplicateRemovedChange, importChange, mappingRuleCreatedChange, openingBalanceFiledChange, reversalChange,
  stampChange, startingBalanceChange, startingBalanceMovedChange, transferLinkChange, transferTypeChange,
  type ChangeDraft, type ChangeEntry,
} from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
```

with:

```ts
import {
  amazonLabelChange, balanceCorrectionChange, bankUpdateChange, categoryFiledChange, categoryRuleCreatedChange,
  duplicateRemovedChange, importChange, mappingRuleCreatedChange, openingBalanceFiledChange, reversalChange,
  stampChange, startingBalanceChange, startingBalanceMovedChange, transferLinkChange, transferTypeChange, venmoNoteChange,
  type ChangeDraft, type ChangeEntry,
} from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
```

Edit 2 of 2 in `shared/change-undo.test.ts` — replace:

```ts
    });
  });

  const plug = entry(balanceCorrectionChange({
    account: CHECKING, actor: 'auto', activityId: 'plug-1', amountCents: -215, date: '2026-10-12', activityType: 'TRANSFER_OUT',
    comment: 'Balance adjustment · ACT-1f2e · 2026-10-12',
```

with:

```ts
    });
  });

  const venmo = entry(venmoNoteChange({
    account: CHECKING, txKey: KEY, activityId: 'act-6', description: 'VENMO PAYMENT 1023', amountCents: -2500, date: '2026-10-04',
    beforeNote: 'VENMO PAYMENT 1023 · TRN-a1b2', afterNote: 'VENMO PAYMENT 1023 · Venmo: Rent October · TRN-a1b2', note: 'Rent October',
  }));

  it('a Venmo note: noVenmoNote first, then the old note back; a changed, linked or gone row is refused', () => {
    const noted = row({ id: 'act-6', absCents: 2500, date: '2026-10-04', comment: 'VENMO PAYMENT 1023 · Venmo: Rent October · TRN-a1b2' });
    const plan = ok(planChangeUndo(venmo, 'undo', { row: noted, currency: 'USD' }, { latest: null }));
    expect(plan).toMatchObject({ needsSync: false, rowAfter: 'act-6', done: 'Undone — the note is off, and stays off.' });
    expect(plan.steps).toEqual([
      { do: 'set-tx', txKey: KEY, flag: 'noVenmoNote', label: 'VENMO PAYMENT 1023 · Checking' },
      { do: 'update', write: { id: 'act-6', accountId: 'wf-checking', activityType: 'WITHDRAWAL', activityDate: '2026-10-04', amount: 25, currency: 'USD', comment: 'VENMO PAYMENT 1023 · TRN-a1b2' } },
    ]);
    expect(reason(planChangeUndo(venmo, 'undo', { row: { ...noted, comment: 'edited by hand' } }, { latest: null }))).toBe('It has changed since — nothing was undone.');
    expect(reason(planChangeUndo(venmo, 'undo', { row: { ...noted, linked: 'confirmed' } }, { latest: null }))).toBe(UNDO_LINKED_REFUSAL);
    expect(reason(planChangeUndo(venmo, 'undo', { row: null }, { latest: null }))).toBe('That transaction is gone — nothing was undone.');
    expect(ok(planChangeUndo(venmo, 'redo', {}, { latest: undo(venmo, { activityId: 'act-6' }) }))).toMatchObject({
      needsSync: true, rowAfter: 'act-6', done: 'Redone — the next sync adds the note again.',
      steps: [{ do: 'clear-tx', txKey: KEY, flag: 'noVenmoNote' }],
    });
  });

  const plug = entry(balanceCorrectionChange({
    account: CHECKING, actor: 'auto', activityId: 'plug-1', amountCents: -215, date: '2026-10-12', activityType: 'TRANSFER_OUT',
    comment: 'Balance adjustment · ACT-1f2e · 2026-10-12',
```

Edit 1 of 2 in `shared/change-undo-run.test.ts` — replace:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  amazonLabelChange, balanceCorrectionChange, categoryFiledChange, categoryRuleCreatedChange, duplicateRemovedChange,
  importChange, mappingRuleCreatedChange, stampChange, transferLinkChange, type ChangeDraft, type ChangeEntry,
} from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import {
```

with:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  amazonLabelChange, balanceCorrectionChange, categoryFiledChange, categoryRuleCreatedChange, duplicateRemovedChange,
  importChange, mappingRuleCreatedChange, stampChange, transferLinkChange, venmoNoteChange, type ChangeDraft, type ChangeEntry,
} from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import {
```

Edit 2 of 2 in `shared/change-undo-run.test.ts` — replace:

```ts
    expect(hasTxOverride(h.overrides(), KEY, 'noAmazonLabel')).toBe(true);
  });

  it('a transaction rule leaves mapping_rules and comes back; an unreadable list is refused', async () => {
    const rule = { pattern: 'Payment to Ccb', matchType: 'contains' as const, activityType: 'TRANSFER_OUT' as const };
    const other = { pattern: 'ZELLE', matchType: 'contains' as const, activityType: 'TRANSFER_IN' as const };
```

with:

```ts
    expect(hasTxOverride(h.overrides(), KEY, 'noAmazonLabel')).toBe(true);
  });

  it('a Venmo note: noVenmoNote, then the old note back', async () => {
    const note = stampChange(venmoNoteChange({
      account: CHECKING, txKey: KEY, activityId: 'act-v', description: 'VENMO PAYMENT 1023', amountCents: -2500, date: '2026-10-04',
      beforeNote: 'VENMO PAYMENT 1023 · tx-1', afterNote: 'VENMO PAYMENT 1023 · Venmo: Rent October · tx-1', note: 'Rent October',
    }), 'companion', NOW);
    const h = harness(seedWith([{
      id: 'act-v', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-04', amount: 25,
      comment: 'VENMO PAYMENT 1023 · Venmo: Rent October · tx-1', sourceGroupId: null,
    }]));
    expect(await h.undo(note, 'undo')).toEqual({ ok: true, message: 'Undone — the note is off, and stays off.', needsSync: false });
    expect(h.fh.activities.get('wf-a')![0]).toMatchObject({ comment: 'VENMO PAYMENT 1023 · tx-1', activityType: 'WITHDRAWAL', amount: 25 });
    expect(hasTxOverride(h.overrides(), KEY, 'noVenmoNote')).toBe(true);
  });

  it('a transaction rule leaves mapping_rules and comes back; an unreadable list is refused', async () => {
    const rule = { pattern: 'Payment to Ccb', matchType: 'contains' as const, activityType: 'TRANSFER_OUT' as const };
    const other = { pattern: 'ZELLE', matchType: 'contains' as const, activityType: 'TRANSFER_IN' as const };
```

Edit 1 of 2 in `shared/tx-story.test.ts` — replace:

```ts
import {
  buildTxStory, decodeFiler, encodeFiler, inferFilingRule, resolveFiler, ruleMatchesRow, signedCents, splitAmazonLabel,
  TX_FACT_NOTES, TX_STORY_ASK_TELEGRAM, TX_STORY_MONEY_IN, TX_STORY_NOT_FILED, TX_STORY_NOT_FROM_FEED,
  TX_STORY_SET_IN_WEALTHFOLIO, TX_STORY_SPENDING, withFilingDay, type CategoryRuleLike, type TxFactName,
  type TxStoryFacts, type TxStoryRow,
} from './tx-story';

```

with:

```ts
import {
  buildTxStory, decodeFiler, encodeFiler, inferFilingRule, resolveFiler, ruleMatchesRow, signedCents, splitAmazonLabel,
  TX_FACT_NOTES, TX_STORY_ASK_TELEGRAM, TX_STORY_MONEY_IN, TX_STORY_NOT_FILED, TX_STORY_NOT_FROM_FEED,
  TX_STORY_SET_IN_WEALTHFOLIO, TX_STORY_SPENDING, TX_STORY_VENMO_NOTE, withFilingDay, type CategoryRuleLike, type TxFactName,
  type TxStoryFacts, type TxStoryRow,
} from './tx-story';

```

Edit 2 of 2 in `shared/tx-story.test.ts` — replace:

```ts
    );
  });

  it('a filing by you with no day says only "in Telegram"', () => {
    expect(story({ category: { name: 'Groceries', filer: { kind: 'you' } } }).answer[2]).toBe('Filed under Groceries by you, in Telegram.');
  });
```

with:

```ts
    );
  });

  it('says a Venmo note came from a Venmo email, and words its override', () => {
    const s = story({ row: row({ note: 'VENMO PAYMENT 1023 · Venmo: Rent October · TRN-1' }), overrides: ['noVenmoNote', 'noAmazonLabel'] });
    expect(TX_STORY_VENMO_NOTE).toBe('Note from a Venmo email.');
    expect(s.answer.slice(0, 2)).toEqual(['From your PNC Checking bank feed.', TX_STORY_VENMO_NOTE]);
    expect(s.answer.at(-1)).toBe('You told the sync: no Amazon label, no Venmo note.');
    expect(s.title).toBe('VENMO PAYMENT 1023 · Venmo: Rent October · -$54.20 · Oct 4');
    expect(story().answer).not.toContain(TX_STORY_VENMO_NOTE);
  });

  it('a filing by you with no day says only "in Telegram"', () => {
    expect(story({ category: { name: 'Groceries', filer: { kind: 'you' } } }).answer[2]).toBe('Filed under Groceries by you, in Telegram.');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/sync-overrides.test.ts shared/change-entries.test.ts shared/change-view.test.ts shared/change-undo.test.ts shared/change-undo-run.test.ts shared/tx-story.test.ts`
Expected: FAIL — `change-entries.test.ts`, `change-view.test.ts` and `change-undo.test.ts` fail to load (`TypeError: venmoNoteChange is not a function`), and 3 tests fail: `lists a Venmo note override in words, and a document holding one reads back`, `a Venmo note: noVenmoNote, then the old note back`, `says a Venmo note came from a Venmo email, and words its override`.

- [ ] **Step 3: Implement**

Edit 1 of 4 in `shared/sync-overrides.ts` — replace:

```ts
 *  - `keepDuplicate` the duplicate prune leaves its copies.
 *  - `noAutoFile`    the Amazon filer leaves it.
 *  - `noAmazonLabel` no Amazon label is added to its note.
 * Per SimpleFin account (`accounts`):
 *  - `noAutoCorrect` no automatic balance correction (drift is still reported).
 *  - `noOpeningFile` the card opening-balance filer leaves its opening balance.
```

with:

```ts
 *  - `keepDuplicate` the duplicate prune leaves its copies.
 *  - `noAutoFile`    the Amazon filer leaves it.
 *  - `noAmazonLabel` no Amazon label is added to its note.
 *  - `noVenmoNote`   no Venmo note is added to its note (3).
 * Per SimpleFin account (`accounts`):
 *  - `noAutoCorrect` no automatic balance correction (drift is still reported).
 *  - `noOpeningFile` the card opening-balance filer leaves its opening balance.
```

Edit 2 of 4 in `shared/sync-overrides.ts` — replace:

```ts
/** Transaction overrides older than this are dropped on the next write. */
export const TX_OVERRIDE_KEEP_DAYS = 365;

export const TX_OVERRIDE_FLAGS = ['notTransfer', 'keepDuplicate', 'noAutoFile', 'noAmazonLabel'] as const;
export type TxOverrideFlag = (typeof TX_OVERRIDE_FLAGS)[number];
export const ACCOUNT_OVERRIDE_FLAGS = ['noAutoCorrect', 'noOpeningFile'] as const;
export type AccountOverrideFlag = (typeof ACCOUNT_OVERRIDE_FLAGS)[number];
```

with:

```ts
/** Transaction overrides older than this are dropped on the next write. */
export const TX_OVERRIDE_KEEP_DAYS = 365;

export const TX_OVERRIDE_FLAGS = ['notTransfer', 'keepDuplicate', 'noAutoFile', 'noAmazonLabel', 'noVenmoNote'] as const;
export type TxOverrideFlag = (typeof TX_OVERRIDE_FLAGS)[number];
export const ACCOUNT_OVERRIDE_FLAGS = ['noAutoCorrect', 'noOpeningFile'] as const;
export type AccountOverrideFlag = (typeof ACCOUNT_OVERRIDE_FLAGS)[number];
```

Edit 3 of 4 in `shared/sync-overrides.ts` — replace:

```ts
  keepDuplicate?: true;
  noAutoFile?: true;
  noAmazonLabel?: true;
  /** When it was last set (ISO). */
  at: string;
  /** The change-log entry whose undo set it. */
```

with:

```ts
  keepDuplicate?: true;
  noAutoFile?: true;
  noAmazonLabel?: true;
  noVenmoNote?: true;
  /** When it was last set (ISO). */
  at: string;
  /** The change-log entry whose undo set it. */
```

Edit 4 of 4 in `shared/sync-overrides.ts` — replace:

```ts
  keepDuplicate: 'Keep both copies',
  noAutoFile: "Don't file automatically",
  noAmazonLabel: 'No Amazon label',
  noAutoCorrect: 'No automatic balance corrections',
  noOpeningFile: "Don't file the opening balance",
};
```

with:

```ts
  keepDuplicate: 'Keep both copies',
  noAutoFile: "Don't file automatically",
  noAmazonLabel: 'No Amazon label',
  noVenmoNote: 'No Venmo note',
  noAutoCorrect: 'No automatic balance corrections',
  noOpeningFile: "Don't file the opening balance",
};
```

Edit 1 of 4 in `shared/change-entries.ts` — replace:

```ts
 *  - a category rule: its id, name, pattern and category;
 *  - an import: the activity id and the account-scoped tx key;
 *  - a transfer link: both legs' tx keys and their new activity ids;
 *  - an Amazon label: the label text and the note before and after.
 */

export type ChangeWriter = 'addon' | 'companion';
```

with:

```ts
 *  - a category rule: its id, name, pattern and category;
 *  - an import: the activity id and the account-scoped tx key;
 *  - a transfer link: both legs' tx keys and their new activity ids;
 *  - an Amazon label: the label text and the note before and after;
 *  - a Venmo note: the note text and the row's note before and after.
 */

export type ChangeWriter = 'addon' | 'companion';
```

Edit 2 of 4 in `shared/change-entries.ts` — replace:

```ts
  | 'transfer-link' | 'transfer-type'
  | 'duplicate-removed'
  | 'starting-balance' | 'starting-balance-moved' | 'balance-correction'
  | 'amazon-label' | 'category-filed' | 'opening-balance-filed'
  | 'category-rule-created' | 'mapping-rule-created'
  | 'account-created'
  | 'bookkeeping';
```

with:

```ts
  | 'transfer-link' | 'transfer-type'
  | 'duplicate-removed'
  | 'starting-balance' | 'starting-balance-moved' | 'balance-correction'
  | 'amazon-label' | 'venmo-note' | 'category-filed' | 'opening-balance-filed'
  | 'category-rule-created' | 'mapping-rule-created'
  | 'account-created'
  | 'bookkeeping';
```

Edit 3 of 4 in `shared/change-entries.ts` — replace:

```ts
  'transfer-link', 'transfer-type',
  'duplicate-removed',
  'starting-balance', 'starting-balance-moved', 'balance-correction',
  'amazon-label', 'category-filed', 'opening-balance-filed',
  'category-rule-created', 'mapping-rule-created',
  'account-created',
  'bookkeeping',
```

with:

```ts
  'transfer-link', 'transfer-type',
  'duplicate-removed',
  'starting-balance', 'starting-balance-moved', 'balance-correction',
  'amazon-label', 'venmo-note', 'category-filed', 'opening-balance-filed',
  'category-rule-created', 'mapping-rule-created',
  'account-created',
  'bookkeeping',
```

Edit 4 of 4 in `shared/change-entries.ts` — replace:

```ts
  };
}

export interface CategoryFiledFacts {
  actor: ChangeActor;
  account?: ChangeAccount;
```

with:

```ts
  };
}

export interface VenmoNoteFacts {
  account: ChangeAccount;
  txKey: string;
  activityId: string;
  /** The bank's own text, without the note. */
  description: string;
  amountCents: number;
  date: string;
  beforeNote: string;
  afterNote: string;
  /** The text after ` · Venmo: `. */
  note: string;
}

/** A Venmo note added to a row's note, at import or later (3). A sync decision:
 *  Undo puts the old note back and sets `noVenmoNote`. */
export function venmoNoteChange(f: VenmoNoteFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'venmo-note',
    account: f.account,
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: `Added the Venmo note "${f.note}" to ${what(f.description)}`,
    why: 'Venmo email',
    before: { comment: f.beforeNote },
    after: { comment: f.afterNote, note: f.note },
    undoable: true,
  };
}

export interface CategoryFiledFacts {
  actor: ChangeActor;
  account?: ChangeAccount;
```

Edit 1 of 2 in `shared/change-view.ts` — replace:

```ts
  'category-filed': 'categories',
  'opening-balance-filed': 'categories',
  'amazon-label': 'categories',
  'transfer-link': 'transfers',
  'transfer-type': 'transfers',
  'duplicate-removed': 'corrections',
```

with:

```ts
  'category-filed': 'categories',
  'opening-balance-filed': 'categories',
  'amazon-label': 'categories',
  'venmo-note': 'categories',
  'transfer-link': 'transfers',
  'transfer-type': 'transfers',
  'duplicate-removed': 'corrections',
```

Edit 2 of 2 in `shared/change-view.ts` — replace:

```ts
      const parts = bankUpdateParts(b, a);
      return parts.length ? parts.join(', ') : null;
    }
    case 'amazon-label': {
      const b = isRecord(before) ? str(before.comment) : null;
      const a = isRecord(after) ? str(after.comment) : null;
      return b !== null && a !== null ? `${b} → ${a}` : null;
```

with:

```ts
      const parts = bankUpdateParts(b, a);
      return parts.length ? parts.join(', ') : null;
    }
    case 'amazon-label':
    case 'venmo-note': {
      const b = isRecord(before) ? str(before.comment) : null;
      const a = isRecord(after) ? str(after.comment) : null;
      return b !== null && a !== null ? `${b} → ${a}` : null;
```

Edit 1 of 2 in `shared/change-undo.ts` — replace:

```ts

/** Kinds whose undo the SYNC carries out (an override): gated on the companion's version. */
export const SYNC_DECISION_KINDS: ReadonlySet<string> = new Set([
  'transfer-link', 'transfer-type', 'duplicate-removed', 'balance-correction', 'import', 'amazon-label',
]);
/** Kinds only the companion can reverse: the add-on SDK has no category or rule API. */
export const COMPANION_ONLY_KINDS: ReadonlySet<string> = new Set([
```

with:

```ts

/** Kinds whose undo the SYNC carries out (an override): gated on the companion's version. */
export const SYNC_DECISION_KINDS: ReadonlySet<string> = new Set([
  'transfer-link', 'transfer-type', 'duplicate-removed', 'balance-correction', 'import', 'amazon-label', 'venmo-note',
]);
/** Kinds only the companion can reverse: the add-on SDK has no category or rule API. */
export const COMPANION_ONLY_KINDS: ReadonlySet<string> = new Set([
```

Edit 2 of 2 in `shared/change-undo.ts` — replace:

```ts
      });
    }

    default:
      return refuse(UNDO_NOT_POSSIBLE);
  }
```

with:

```ts
      });
    }

    // A Venmo note (3): the override first, then the old note back — as an
    // Amazon label is undone. The sync then never adds it again.
    case 'venmo-note': {
      if (!key) return refuse(UNDO_NO_KEY);
      if (op === 'redo') {
        return plan({
          op, needsSync: true, rowAfter: rowNow, done: 'Redone — the next sync adds the note again.',
          steps: [{ do: 'clear-tx', txKey: key, flag: 'noVenmoNote' }],
        });
      }
      const row = state.row;
      const beforeNote = str(before.comment);
      if (!row) return refuse(undoGone(op));
      const linked = linkedRefusal(row);
      if (linked) return refuse(linked);
      if (!beforeNote || row.comment !== str(after.comment)) return refuse(undoChangedSince(op));
      return plan({
        op, needsSync: false, rowAfter: row.id, done: 'Undone — the note is off, and stays off.',
        steps: [
          { do: 'set-tx', txKey: key, flag: 'noVenmoNote', label: labelOf(entry) },
          { do: 'update', write: { id: row.id, accountId: row.accountId, activityType: row.type, activityDate: row.date, amount: row.absCents / 100, currency, comment: beforeNote } },
        ],
      });
    }

    default:
      return refuse(UNDO_NOT_POSSIBLE);
  }
```

Edit 1 of 2 in `shared/change-undo-run.ts` — replace:

```ts
  const key = entry.subject.txKeys?.[0] ?? null;
  const state: UndoState = {};
  const wf = entry.account?.wfId ?? str(after.accountId);
  const needsCurrency = ['balance-correction', 'starting-balance', 'starting-balance-moved', 'amazon-label'].includes(entry.kind);
  if (needsCurrency && wf) {
    state.currency = (await io.host.listAccounts()).find((a) => a.id === wf)?.currency ?? 'USD';
  }
```

with:

```ts
  const key = entry.subject.txKeys?.[0] ?? null;
  const state: UndoState = {};
  const wf = entry.account?.wfId ?? str(after.accountId);
  const needsCurrency = ['balance-correction', 'starting-balance', 'starting-balance-moved', 'amazon-label', 'venmo-note'].includes(entry.kind);
  if (needsCurrency && wf) {
    state.currency = (await io.host.listAccounts()).find((a) => a.id === wf)?.currency ?? 'USD';
  }
```

Edit 2 of 2 in `shared/change-undo-run.ts` — replace:

```ts
    case 'starting-balance-moved':
    case 'duplicate-removed':
    case 'amazon-label':
      state.row = await findRow(io, entry, latest, key);
      return state;
    case 'import': {
```

with:

```ts
    case 'starting-balance-moved':
    case 'duplicate-removed':
    case 'amazon-label':
    case 'venmo-note':
      state.row = await findRow(io, entry, latest, key);
      return state;
    case 'import': {
```

Edit 1 of 3 in `shared/tx-story.ts` — replace:

```ts
import type { TxOverrideFlag } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import { txDescription } from './tx-search.js';

// ── Copy ─────────────────────────────────────────────────────────────────

export const TX_STORY_NOT_FROM_FEED = 'Not from your bank feed — added in Wealthfolio by hand or from a file.';
export const TX_STORY_SPENDING = 'Spending.';
export const TX_STORY_MONEY_IN = 'Money in.';
export const TX_STORY_NOT_FILED = "Not filed yet — it's on your needs-a-category list.";
export const TX_STORY_ASK_TELEGRAM = 'Ask /why in Telegram to see who filed it.';
export const TX_STORY_SET_IN_WEALTHFOLIO = 'Category set in Wealthfolio.';
```

with:

```ts
import type { TxOverrideFlag } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import { txDescription } from './tx-search.js';
import { VENMO_NOTE_MARK } from './venmo-ledger.js';

// ── Copy ─────────────────────────────────────────────────────────────────

export const TX_STORY_NOT_FROM_FEED = 'Not from your bank feed — added in Wealthfolio by hand or from a file.';
export const TX_STORY_SPENDING = 'Spending.';
export const TX_STORY_MONEY_IN = 'Money in.';
/** A row whose note carries ` · Venmo: <note>` (3). */
export const TX_STORY_VENMO_NOTE = 'Note from a Venmo email.';
export const TX_STORY_NOT_FILED = "Not filed yet — it's on your needs-a-category list.";
export const TX_STORY_ASK_TELEGRAM = 'Ask /why in Telegram to see who filed it.';
export const TX_STORY_SET_IN_WEALTHFOLIO = 'Category set in Wealthfolio.';
```

Edit 2 of 3 in `shared/tx-story.ts` — replace:

```ts
  keepDuplicate: 'keep this duplicate',
  noAutoFile: "don't file it automatically",
  noAmazonLabel: 'no Amazon label',
  skipped: "don't import it",
};
const OVERRIDE_ORDER: ReadonlyArray<TxOverrideFlag | 'skipped'> = ['notTransfer', 'keepDuplicate', 'noAutoFile', 'noAmazonLabel', 'skipped'];

// ── Facts ────────────────────────────────────────────────────────────────

```

with:

```ts
  keepDuplicate: 'keep this duplicate',
  noAutoFile: "don't file it automatically",
  noAmazonLabel: 'no Amazon label',
  noVenmoNote: 'no Venmo note',
  skipped: "don't import it",
};
const OVERRIDE_ORDER: ReadonlyArray<TxOverrideFlag | 'skipped'> = ['notTransfer', 'keepDuplicate', 'noAutoFile', 'noAmazonLabel', 'noVenmoNote', 'skipped'];

// ── Facts ────────────────────────────────────────────────────────────────

```

Edit 3 of 3 in `shared/tx-story.ts` — replace:

```ts
      ? `From your ${row.accountName} bank feed.${note.endsWith(PENDING_SUFFIX) ? ' Still pending.' : ''}`
      : TX_STORY_NOT_FROM_FEED);
  }

  // 2. What it is.
  if (held) {
```

with:

```ts
      ? `From your ${row.accountName} bank feed.${note.endsWith(PENDING_SUFFIX) ? ' Still pending.' : ''}`
      : TX_STORY_NOT_FROM_FEED);
  }
  // The note the sync added from a Venmo email (3), right under where it came from.
  if (!special && note.includes(VENMO_NOTE_MARK)) answer.push(TX_STORY_VENMO_NOTE);

  // 2. What it is.
  if (held) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/sync-overrides.test.ts shared/change-entries.test.ts shared/change-view.test.ts shared/change-undo.test.ts shared/change-undo-run.test.ts shared/tx-story.test.ts`
Expected: PASS — 209 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/sync-overrides.ts shared/change-entries.ts shared/change-view.ts shared/change-undo.ts shared/change-undo-run.ts shared/tx-story.ts shared/sync-overrides.test.ts shared/change-entries.test.ts shared/change-view.test.ts shared/change-undo.test.ts shared/change-undo-run.test.ts shared/tx-story.test.ts
git commit -m "Change log: a Venmo note is a sync decision — venmo-note, noVenmoNote, its Undo and its story line

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The note in both syncers — at import or later, obeying `noVenmoNote`

The sync hook, site for site beside Amazon's (spec A "The note"; Z1a): read the Venmo ledger once (an optional store method — an older host or test double adds no notes); after typing, match each row on the bank's own text and append ` · Venmo: <note>` unless `noVenmoNote` is set, consuming the payment either way; log a `venmo-note` entry beside the import (Deviation: an import-time note is undoable on its own); add a late note to a row imported before its email was read with `planVenmoLateNotes` (Amazon's planner — same rules: the sync's own unedited note only, never a transfer-typed, grouped or pending row); write the ledger back when a match consumed something. Both hosts' stores gain the reader and writer; Reset clears the secret.

**Files:**
- Modify: `shared/sync-host.ts`, `shared/sync-core.ts`, `shared/fake-host.ts`, `companion/src/rest-host.ts`, `src/utils/secrets.ts`
- Create: `shared/sync-core-venmo.test.ts`
- Test: `src/utils/secrets.test.ts`, `companion/src/rest-host.test.ts`

**Interfaces:**
- Consumes: Task 2 (`matchVenmoPayment`, `consumeVenmoMatch`, `venmoDescription`, `VenmoLedger`, `VENMO_LEDGER_SECRET_KEY`); Task 3 (`venmoNoteChange`, the `noVenmoNote` flag).
- Produces:

```ts
// shared/sync-host.ts — SyncStore
getVenmoLedger?(): Promise<VenmoLedger>;
setVenmoLedger?(map: VenmoLedger): Promise<void>;
// shared/sync-core.ts
export const VENMO_LATE_NOTE_LOG_TAG: string;  // 'venmo-late-note'
export function planVenmoLateNotes(rows: ReadonlyArray<StoredRow>, noted: ReadonlyMap<string, { bare: string; enriched: string }>, currency: string): ActivityWrite[];
// shared/fake-host.ts — FakeHostSeed.venmoLedger?, FakeHostSeed.noVenmoLedger?, FakeHost.venmo(): VenmoLedger
// companion/src/rest-host.ts — RestSyncStore.getVenmoLedger(), setVenmoLedger(map)
// src/utils/secrets.ts — SecretsStore.getVenmoLedger(), setVenmoLedger(map); KEYS.venmoLedger
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/sync-core-venmo.test.ts`:**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChangeEntry, ChangeLogSink } from './change-entries.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { VenmoLedger } from './venmo-ledger.js';

const NOW = new Date('2026-10-13T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const KEY = accountTxKey('sfin-1', 'tx-v');
const RENT_KEY = 'out|2500|Jane Doe|Rent October|2026-10-03';

function capture(): ChangeLogSink & { entries: () => ChangeEntry[] } {
  const batches: ChangeEntry[][] = [];
  return {
    writer: 'companion', run: 'cRUN1',
    append: vi.fn(async (entries: ChangeEntry[]) => { batches.push(entries); }),
    entries: () => batches.flat(),
  };
}

const RENT: VenmoLedger = {
  [RENT_KEY]: { direction: 'out', kind: 'payment', amountCents: 2500, counterparty: 'Jane Doe', note: 'Rent October', emailDate: '2026-10-03' },
};

/** Checking with one Venmo row on Oct 4, the day after Jane's email. */
const seed = (over: Partial<FakeHostSeed> = {}, amount = '-25.00'): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [{
    id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-13T12:00:00Z'),
    transactions: [{ id: 'tx-v', posted: epoch('2026-10-04T12:00:00Z'), amount, description: 'VENMO PAYMENT 1023' }],
  }] },
  mapping: { 'sfin-1': 'wf-a' },
  accountTypes: { 'wf-a': 'CASH' },
  accountNames: { 'wf-a': 'Checking' },
  venmoLedger: RENT,
  ...over,
});

/** The same row, imported before the email was read. */
const imported = () => new Map([['wf-a', [{
  id: 'act-v', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-04', amount: 25,
  comment: 'VENMO PAYMENT 1023 · tx-v', sourceGroupId: null,
}]]]);

const venmoEntries = (log: { entries: () => ChangeEntry[] }) => log.entries().filter((e) => e.kind === 'venmo-note');

describe('runSyncCore — Venmo notes', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('appends the note at import, consumes the payment, and logs the note beside the import', async () => {
    const fh = createFakeHost(seed());
    const log = capture();
    await runSyncCore(fh.host, fh.store, { changeLog: log });
    expect(fh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · Venmo: Rent October · tx-v');
    expect(fh.venmo()[RENT_KEY].consumedBy).toBe(KEY);
    const [entry] = venmoEntries(log);
    expect(entry).toMatchObject({
      kind: 'venmo-note', actor: 'auto', undoable: true,
      summary: 'Added the Venmo note "Rent October" to VENMO PAYMENT 1023',
      subject: { txKeys: [KEY], activityIds: [fh.activities.get('wf-a')![0].id], amountCents: -2500, date: '2026-10-04' },
      before: { comment: 'VENMO PAYMENT 1023 · tx-v' },
      after: { comment: 'VENMO PAYMENT 1023 · Venmo: Rent October · tx-v', note: 'Rent October' },
    });
    expect(log.entries().filter((e) => e.kind === 'import').map((e) => e.summary)).toEqual(['Imported VENMO PAYMENT 1023 · Venmo: Rent October']);
  });

  it('adds the note later to a row imported before its email was read — once', async () => {
    const fh = createFakeHost(seed({ existing: imported() }));
    const log = capture();
    await runSyncCore(fh.host, fh.store, { changeLog: log });
    expect(fh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · Venmo: Rent October · tx-v');
    expect(venmoEntries(log)).toEqual([expect.objectContaining({
      summary: 'Added the Venmo note "Rent October" to VENMO PAYMENT 1023',
      subject: expect.objectContaining({ activityIds: ['act-v'] }),
      before: { comment: 'VENMO PAYMENT 1023 · tx-v' },
      after: { comment: 'VENMO PAYMENT 1023 · Venmo: Rent October · tx-v', note: 'Rent October' },
    })]);
    const again = capture();
    await runSyncCore(fh.host, fh.store, { changeLog: again });
    expect(venmoEntries(again)).toEqual([]);
    expect(fh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · Venmo: Rent October · tx-v');
  });

  it('noVenmoNote: no note at import nor later, and the payment is still consumed', async () => {
    const syncOverrides = setTxOverride(emptySyncOverrides(), KEY, 'noVenmoNote', NOW);
    const fresh = createFakeHost(seed({ syncOverrides }));
    await runSyncCore(fresh.host, fresh.store, {});
    expect(fresh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · tx-v');
    expect(fresh.venmo()[RENT_KEY].consumedBy).toBe(KEY);

    const later = createFakeHost(seed({ syncOverrides, existing: imported() }));
    const log = capture();
    await runSyncCore(later.host, later.store, { changeLog: log });
    expect(later.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · tx-v');
    expect(venmoEntries(log)).toEqual([]);
  });

  it('gives no note when the direction does not match — $25.00 in is not the $25.00 you paid', async () => {
    const fh = createFakeHost(seed({}, '25.00'));
    await runSyncCore(fh.host, fh.store, {});
    expect(fh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · tx-v');
    expect(fh.venmo()[RENT_KEY].consumedBy).toBeUndefined();
  });

  it('gives no note when two payments of the same amount fall in the window', async () => {
    const two: VenmoLedger = {
      ...RENT,
      'out|2500|Sam Lee|Cable|2026-10-05': { direction: 'out', kind: 'payment', amountCents: 2500, counterparty: 'Sam Lee', note: 'Cable', emailDate: '2026-10-05' },
    };
    const fh = createFakeHost(seed({ venmoLedger: two }));
    await runSyncCore(fh.host, fh.store, {});
    expect(fh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · tx-v');
  });

  it('an older store without the Venmo ledger syncs exactly as before', async () => {
    const fh = createFakeHost(seed({ noVenmoLedger: true }));
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(result.errors).toEqual([]);
    expect(fh.activities.get('wf-a')![0].comment).toBe('VENMO PAYMENT 1023 · tx-v');
  });
});
```

Edit 1 of 1 in `src/utils/secrets.test.ts` — replace:

```ts
    const ctx = makeCtx();
    await ctx.api.secrets.set(AMAZON_MAIL_SAMPLES_SECRET_KEY, '{not json');
    expect(await new SecretsStore(ctx).getAmazonMailSamples()).toBeNull();
  });
});

```

with:

```ts
    const ctx = makeCtx();
    await ctx.api.secrets.set(AMAZON_MAIL_SAMPLES_SECRET_KEY, '{not json');
    expect(await new SecretsStore(ctx).getAmazonMailSamples()).toBeNull();
  });

  it('reads and writes the Venmo payments under the key the companion writes, malformed as empty, and clearAll removes them', async () => {
    const { ctx, data } = makeCtxWithData();
    const s = new SecretsStore(ctx);
    expect(await s.getVenmoLedger()).toEqual({});
    const ledger = { 'id|41234567': { direction: 'out' as const, kind: 'payment' as const, amountCents: 2500, counterparty: 'Jane Doe', note: 'Rent', emailDate: '2026-10-03' } };
    await s.setVenmoLedger(ledger);
    expect(JSON.parse(data['venmo_ledger'])).toEqual(ledger);
    expect(await s.getVenmoLedger()).toEqual(ledger);
    data['venmo_ledger'] = '[1,2]';
    expect(await s.getVenmoLedger()).toEqual({});
    data['venmo_ledger'] = '{not json';
    expect(await s.getVenmoLedger()).toEqual({});
    await s.clearAll();
    expect(data['venmo_ledger']).toBeUndefined();
  });
});

```

Edit 1 of 1 in `companion/src/rest-host.test.ts` — replace:

```ts
    expect(await new RestSyncStore(client).getSkippedTransactions()).toEqual([{ account: 'sfin-1', txId: 'TRN-1' }]);
  });

  it('reads and writes transfer link failures as JSON', async () => {
    const secrets = new Map<string, string>();
    const client = {
```

with:

```ts
    expect(await new RestSyncStore(client).getSkippedTransactions()).toEqual([{ account: 'sfin-1', txId: 'TRN-1' }]);
  });

  it('reads and writes the Venmo payments under venmo_ledger, anything but an object as empty', async () => {
    const secrets = new Map<string, string>();
    const client = {
      getAddonSecret: vi.fn(async (_addonId: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_addonId: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;
    const store = new RestSyncStore(client);
    expect(await store.getVenmoLedger()).toEqual({});
    const ledger = { 'id|1': { direction: 'in' as const, kind: 'payment' as const, amountCents: 700, counterparty: 'Sam', note: 'Coffee', emailDate: '2026-10-03' } };
    await store.setVenmoLedger(ledger);
    expect(client.setAddonSecret).toHaveBeenCalledWith('simplefin-sync', 'venmo_ledger', JSON.stringify(ledger));
    expect(await store.getVenmoLedger()).toEqual(ledger);
    secrets.set('venmo_ledger', '[]');
    expect(await store.getVenmoLedger()).toEqual({});
  });

  it('reads and writes transfer link failures as JSON', async () => {
    const secrets = new Map<string, string>();
    const client = {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/sync-core-venmo.test.ts src/utils/secrets.test.ts`
Expected: FAIL — 5 tests: `appends the note at import, consumes the payment, and logs the note beside the import`, `adds the note later to a row imported before its email was read — once`, `noVenmoNote: no note at import nor later, and the payment is still consumed` and `gives no note when the direction does not match — $25.00 in is not the $25.00 you paid` (`fh.venmo is not a function`, or no note), and `reads and writes the Venmo payments under the key the companion writes, malformed as empty, and clearAll removes them` (`s.getVenmoLedger is not a function`). The two-payment and older-store tests already pass: nothing adds a note yet.

Run: `cd companion && npx vitest run src/rest-host.test.ts`
Expected: FAIL — 1 test: `reads and writes the Venmo payments under venmo_ledger, anything but an object as empty` (`store.getVenmoLedger is not a function`).

- [ ] **Step 3: Implement**

Edit 1 of 2 in `shared/sync-host.ts` — replace:

```ts
import type { AccountMapping, MappingRule, SimplefinAccountSet, UnmappedAccount } from './types.js';
import type { AmazonLedger } from './amazon-ledger.js';
import type { HoldingsSnapshot } from './holdings.js';
import type { SkippedTransaction } from './skipped-transactions.js';
import type { SyncOverrides } from './sync-overrides.js';
```

with:

```ts
import type { AccountMapping, MappingRule, SimplefinAccountSet, UnmappedAccount } from './types.js';
import type { AmazonLedger } from './amazon-ledger.js';
import type { VenmoLedger } from './venmo-ledger.js';
import type { HoldingsSnapshot } from './holdings.js';
import type { SkippedTransaction } from './skipped-transactions.js';
import type { SyncOverrides } from './sync-overrides.js';
```

Edit 2 of 2 in `shared/sync-host.ts` — replace:

```ts
  getAmazonLedger(): Promise<AmazonLedger>;
  setAmazonLedger(map: AmazonLedger): Promise<void>;
  /**
   * The SimpleFin accounts the last run found no mapping for (see
   * `SyncResult.unmappedAccounts`), persisted so the addon's UI can offer to
   * map them even though the sync that discovered them ran in the COMPANION —
```

with:

```ts
  getAmazonLedger(): Promise<AmazonLedger>;
  setAmazonLedger(map: AmazonLedger): Promise<void>;
  /**
   * Venmo payments parsed from forwarded Venmo emails, awaiting their bank row
   * (shared/venmo-ledger.ts, project 3). The same off-switch as Amazon's: an
   * empty ledger skips the matcher. Optional: an older host (or a test double)
   * without them simply adds no Venmo notes.
   */
  getVenmoLedger?(): Promise<VenmoLedger>;
  setVenmoLedger?(map: VenmoLedger): Promise<void>;
  /**
   * The SimpleFin accounts the last run found no mapping for (see
   * `SyncResult.unmappedAccounts`), persisted so the addon's UI can offer to
   * map them even though the sync that discovered them ran in the COMPANION —
```

Edit 1 of 7 in `shared/sync-core.ts` — replace:

```ts
  matchAmazonCharge, consumeAmazonMatch, amazonDescription,
} from './amazon-ledger.js';
import type { AmazonLedger } from './amazon-ledger.js';
import type { ActivityType, SimplefinTransaction, UnmappedAccount } from './types.js';
import type { ActivityWrite, HoldingsSyncOutcome, HostActivity, ImportRow, LinkLeg, LinkResult, SaveManyRequest, SaveManyResult, SyncHost, SyncStore } from './sync-host.js';
import { unlinkPairByRecreate, type UnlinkLeg, type UnlinkResult } from './link-pair.js';
import {
  amazonLabelChange, amazonLabelOf, balanceCorrectionChange, bankUpdateChange, bookkeepingChange, duplicateRemovedChange,
  importChange, pendingRemovedChange, stampChange, startingBalanceChange, startingBalanceMovedChange, transferLinkChange,
  transferTypeChange,
  type BaselineState, type ChangeAccount, type ChangeDraft, type ChangeEntry, type ChangeLogSink, type LinkLegFacts,
} from './change-entries.js';
import { emptySyncOverrides, hasAccountOverride, hasTxOverride } from './sync-overrides.js';
```

with:

```ts
  matchAmazonCharge, consumeAmazonMatch, amazonDescription,
} from './amazon-ledger.js';
import type { AmazonLedger } from './amazon-ledger.js';
import { consumeVenmoMatch, matchVenmoPayment, venmoDescription, type VenmoLedger } from './venmo-ledger.js';
import type { ActivityType, SimplefinTransaction, UnmappedAccount } from './types.js';
import type { ActivityWrite, HoldingsSyncOutcome, HostActivity, ImportRow, LinkLeg, LinkResult, SaveManyRequest, SaveManyResult, SyncHost, SyncStore } from './sync-host.js';
import { unlinkPairByRecreate, type UnlinkLeg, type UnlinkResult } from './link-pair.js';
import {
  amazonLabelChange, amazonLabelOf, balanceCorrectionChange, bankUpdateChange, bookkeepingChange, duplicateRemovedChange,
  importChange, pendingRemovedChange, stampChange, startingBalanceChange, startingBalanceMovedChange, transferLinkChange,
  transferTypeChange, venmoNoteChange,
  type BaselineState, type ChangeAccount, type ChangeDraft, type ChangeEntry, type ChangeLogSink, type LinkLegFacts,
} from './change-entries.js';
import { emptySyncOverrides, hasAccountOverride, hasTxOverride } from './sync-overrides.js';
```

Edit 2 of 7 in `shared/sync-core.ts` — replace:

```ts
  return updates;
}

export const LEGACY_PLACEHOLDER_REWRITE_LOG_TAG = 'legacy-placeholder-rewrite';

/**
```

with:

```ts
  return updates;
}

export const VENMO_LATE_NOTE_LOG_TAG = 'venmo-late-note';

/**
 * Existing rows whose Venmo email was read only after the row was imported,
 * as note-only updates (3). The very same rules as `planAmazonLateLabels` —
 * only a note in the sync's own unedited form, never a transfer-typed, grouped
 * or pending row, the note only ever added — so it is that planner, applied
 * to the rows a Venmo payment matched this run.
 */
export function planVenmoLateNotes(
  rows: ReadonlyArray<StoredRow>,
  noted: ReadonlyMap<string, { bare: string; enriched: string }>,
  currency: string,
): ActivityWrite[] {
  return planAmazonLateLabels(rows, noted, currency);
}

export const LEGACY_PLACEHOLDER_REWRITE_LOG_TAG = 'legacy-placeholder-rewrite';

/**
```

Edit 3 of 7 in `shared/sync-core.ts` — replace:

```ts
  const amazonLabelled = new Map<string, Map<string, { bare: string; enriched: string }>>();
  const amazonEnabled = Object.keys(amazonLedger).length > 0;

  /**
   * Accounts the feed offered that nothing is mapped to — reported, not
   * imported. Collected HERE rather than in the second pass below because this
```

with:

```ts
  const amazonLabelled = new Map<string, Map<string, { bare: string; enriched: string }>>();
  const amazonEnabled = Object.keys(amazonLedger).length > 0;

  // Venmo notes (3), the same shape: an empty ledger — no Venmo mail forwarded,
  // or an older host with no reader — costs one read and then nothing.
  let venmoLedger: VenmoLedger = (await store.getVenmoLedger?.().catch(() => null)) ?? {};
  let venmoLedgerChanged = false;
  /** Rows this run matched to a Venmo payment, per SimpleFin account then tx
   *  id: the bank's text, the text with the note, and the note. */
  const venmoNoted = new Map<string, Map<string, { bare: string; enriched: string; note: string }>>();
  const venmoEnabled = Object.keys(venmoLedger).length > 0;

  /**
   * Accounts the feed offered that nothing is mapped to — reported, not
   * imported. Collected HERE rather than in the second pass below because this
```

Edit 4 of 7 in `shared/sync-core.ts` — replace:

```ts
          // same amount.
          amazonLedger = consumeAmazonMatch(amazonLedger, hit, key);
          amazonLedgerChanged = true;
        }
      }
      descByKey.set(key, description);
```

with:

```ts
          // same amount.
          amazonLedger = consumeAmazonMatch(amazonLedger, hit, key);
          amazonLedgerChanged = true;
        }
      }
      // A Venmo note goes on after typing too, matched on the bank's own text,
      // and consumed whether or not the person undid it (`noVenmoNote`).
      if (venmoEnabled) {
        const hit = matchVenmoPayment(venmoLedger, {
          description: tx.description,
          amountCents: Math.round(Math.abs(amount) * 100),
          direction: amount < 0 ? 'out' : 'in',
          postedMs: txEpoch(tx)! * 1000,
          txKey: key,
        });
        if (hit && !hasTxOverride(overrides, key, 'noVenmoNote')) {
          const enriched = venmoDescription(description, hit.note);
          if (enriched !== description) {
            const forAccount = venmoNoted.get(sfAccount.id) ?? new Map<string, { bare: string; enriched: string; note: string }>();
            forAccount.set(tx.id, { bare: description, enriched, note: hit.note });
            venmoNoted.set(sfAccount.id, forAccount);
            description = enriched;
          }
        }
        if (hit) {
          venmoLedger = consumeVenmoMatch(venmoLedger, hit, key);
          venmoLedgerChanged = true;
        }
      }
      descByKey.set(key, description);
```

Edit 5 of 7 in `shared/sync-core.ts` — replace:

```ts
        }
      } catch (e: any) {
        errors.push(`Amazon late label (${sfAccount.name}): ${String(e?.message ?? e)}`);
      }
    }

```

with:

```ts
        }
      } catch (e: any) {
        errors.push(`Amazon late label (${sfAccount.name}): ${String(e?.message ?? e)}`);
      }
    }

    // ── Venmo late note (every mode) ─────────────────────────────────────────
    // The same pass for a row imported before its Venmo email was read (3).
    const lateNotes = planVenmoLateNotes(existing, venmoNoted.get(sfAccount.id) ?? new Map(), sfAccount.currency);
    if (lateNotes.length) {
      try {
        const res = await host.saveMany({ updates: lateNotes });
        if (res.errors.length) {
          errors.push(...res.errors.map((e) => `Venmo late note (${sfAccount.name}): ${e.message}`));
        } else {
          for (const u of lateNotes) {
            const row = existing.find((r) => r.wfId === u.id);
            if (!row) continue;
            const hit = venmoNoted.get(sfAccount.id)?.get(row.txId);
            if (hit) {
              logChange?.(() => venmoNoteChange({
                account: accountRef,
                txKey: accountTxKey(sfAccount.id, row.txId),
                activityId: row.wfId,
                description: hit.bare,
                amountCents: signedCentsOf(row.txId, row.type, row.absCents),
                date: row.date,
                beforeNote: row.comment ?? '',
                afterNote: u.comment,
                note: hit.note,
              }));
            }
            row.comment = u.comment;
          }
          console.info(
            `[simplefin-sync] ${VENMO_LATE_NOTE_LOG_TAG}: added the Venmo note to ${lateNotes.length} row(s) in account ${sfAccount.id} imported before their Venmo email was read`,
          );
        }
      } catch (e: any) {
        errors.push(`Venmo late note (${sfAccount.name}): ${String(e?.message ?? e)}`);
      }
    }

```

Edit 6 of 7 in `shared/sync-core.ts` — replace:

```ts
            amountCents: signedCentsOf(txId, t.type, t.absCents), date: t.date,
          });
          logChange(() => importChange({ ...facts(), pending: !!t.pending, activityType: t.type }));
          // Held as a transfer that has not found its other half: a decision
          // of its own, undone in R2 with `notTransfer` on this leg.
          if (t.inTransit) logChange(() => transferTypeChange({ ...facts(), activityType: t.type, previousType: null, held: true }));
```

with:

```ts
            amountCents: signedCentsOf(txId, t.type, t.absCents), date: t.date,
          });
          logChange(() => importChange({ ...facts(), pending: !!t.pending, activityType: t.type }));
          // A Venmo note added at import is its own decision (3), so Undo can
          // take the note off and leave the row.
          const noted = venmoNoted.get(sfAccount.id)?.get(txId);
          const written = a.comment ?? '';
          if (noted && written.includes(noted.enriched)) {
            logChange(() => venmoNoteChange({
              ...facts(), description: noted.bare, note: noted.note,
              beforeNote: written.replace(noted.enriched, () => noted.bare), afterNote: written,
            }));
          }
          // Held as a transfer that has not found its other half: a decision
          // of its own, undone in R2 with `notTransfer` on this leg.
          if (t.inTransit) logChange(() => transferTypeChange({ ...facts(), activityType: t.type, previousType: null, held: true }));
```

Edit 7 of 7 in `shared/sync-core.ts` — replace:

```ts
      errors.push(`Could not save Amazon order ledger: ${String(e?.message ?? e)}`);
    });
  }

  await store.setAccountBalances(accountBalances);
  // Persisted as well as returned: the sync that discovers a new account is
```

with:

```ts
      errors.push(`Could not save Amazon order ledger: ${String(e?.message ?? e)}`);
    });
  }
  if (venmoLedgerChanged && store.setVenmoLedger) {
    await store.setVenmoLedger(venmoLedger).catch((e) => {
      errors.push(`Could not save the Venmo payment ledger: ${String(e?.message ?? e)}`);
    });
  }

  await store.setAccountBalances(accountBalances);
  // Persisted as well as returned: the sync that discovers a new account is
```

Edit 1 of 6 in `shared/fake-host.ts` — replace:

```ts
import type { AccountMapping, MappingRule, SimplefinAccountSet } from './types.js';
import type { AmazonLedger } from './amazon-ledger.js';
import type { HoldingsSnapshot } from './holdings.js';
import type { SkippedTransaction } from './skipped-transactions.js';
import type { SyncOverrides } from './sync-overrides.js';
```

with:

```ts
import type { AccountMapping, MappingRule, SimplefinAccountSet } from './types.js';
import type { AmazonLedger } from './amazon-ledger.js';
import type { VenmoLedger } from './venmo-ledger.js';
import type { HoldingsSnapshot } from './holdings.js';
import type { SkippedTransaction } from './skipped-transactions.js';
import type { SyncOverrides } from './sync-overrides.js';
```

Edit 2 of 6 in `shared/fake-host.ts` — replace:

```ts
  /** Amazon orders awaiting their charge. Empty means Amazon categorization is
   *  off, which is what every test that doesn't care about it wants. */
  amazonLedger?: AmazonLedger;
  /**
   * Called before every `saveMany`, so a test can make it THROW.
   *
```

with:

```ts
  /** Amazon orders awaiting their charge. Empty means Amazon categorization is
   *  off, which is what every test that doesn't care about it wants. */
  amazonLedger?: AmazonLedger;
  /** Venmo payments awaiting their bank row (3). Absent: empty, Venmo notes off. */
  venmoLedger?: VenmoLedger;
  /** Leave the Venmo ledger reader and writer off the store — an older host. */
  noVenmoLedger?: boolean;
  /**
   * Called before every `saveMany`, so a test can make it THROW.
   *
```

Edit 3 of 6 in `shared/fake-host.ts` — replace:

```ts
  imported: ImportRow[][];
  /** The Amazon ledger as the run left it, for asserting what got consumed. */
  amazon: () => AmazonLedger;
}

/** Rows a single `listActivities` page returns — mirrors the addon adapter's
```

with:

```ts
  imported: ImportRow[][];
  /** The Amazon ledger as the run left it, for asserting what got consumed. */
  amazon: () => AmazonLedger;
  /** The Venmo ledger as the run left it. */
  venmo: () => VenmoLedger;
}

/** Rows a single `listActivities` page returns — mirrors the addon adapter's
```

Edit 4 of 6 in `shared/fake-host.ts` — replace:

```ts
    seed.transferLinkFailures ?? {};
  let driftAlerts: Record<string, DriftAlertEntry> = seed.driftAlerts ?? {};
  let amazonLedger: AmazonLedger = seed.amazonLedger ?? {};
  let accountBalances: Record<string, unknown> = {};
  let balanceInitialized: string[] = [];
  let lastSyncAt: Date | null = null;
```

with:

```ts
    seed.transferLinkFailures ?? {};
  let driftAlerts: Record<string, DriftAlertEntry> = seed.driftAlerts ?? {};
  let amazonLedger: AmazonLedger = seed.amazonLedger ?? {};
  let venmoLedger: VenmoLedger = seed.venmoLedger ?? {};
  let accountBalances: Record<string, unknown> = {};
  let balanceInitialized: string[] = [];
  let lastSyncAt: Date | null = null;
```

Edit 5 of 6 in `shared/fake-host.ts` — replace:

```ts
    async setAmazonLedger(map: AmazonLedger) {
      amazonLedger = map;
    },
    async getAutoHeal() {
      return autoHeal;
    },
```

with:

```ts
    async setAmazonLedger(map: AmazonLedger) {
      amazonLedger = map;
    },
    ...(seed.noVenmoLedger ? {} : {
      async getVenmoLedger() { return venmoLedger; },
      async setVenmoLedger(map: VenmoLedger) { venmoLedger = map; },
    }),
    async getAutoHeal() {
      return autoHeal;
    },
```

Edit 6 of 6 in `shared/fake-host.ts` — replace:

```ts
      : {}),
  };

  return { host, store, activities, saved, links, imported, holdings, amazon: () => amazonLedger };
}
```

with:

```ts
      : {}),
  };

  return { host, store, activities, saved, links, imported, holdings, amazon: () => amazonLedger, venmo: () => venmoLedger };
}
```

Edit 1 of 2 in `companion/src/rest-host.ts` — replace:

```ts
import { AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY } from './amazon-mail.js';
import type { AmazonLabelCatalog, AmazonMailConfig } from './amazon-mail.js';
import type { AmazonLedger } from '../../shared/amazon-ledger.js';
import { linkPairByRecreate } from '../../shared/link-pair.js';
import { SKIPPED_TRANSACTIONS_SECRET_KEY, parseSkippedTransactions, type SkippedTransaction } from '../../shared/skipped-transactions.js';
import { syncOverridesIgnoredLog, syncOverridesOrEmpty, type SyncOverrides } from '../../shared/sync-overrides.js';
```

with:

```ts
import { AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY } from './amazon-mail.js';
import type { AmazonLabelCatalog, AmazonMailConfig } from './amazon-mail.js';
import type { AmazonLedger } from '../../shared/amazon-ledger.js';
import { VENMO_LEDGER_SECRET_KEY, type VenmoLedger } from '../../shared/venmo-ledger.js';
import { linkPairByRecreate } from '../../shared/link-pair.js';
import { SKIPPED_TRANSACTIONS_SECRET_KEY, parseSkippedTransactions, type SkippedTransaction } from '../../shared/skipped-transactions.js';
import { syncOverridesIgnoredLog, syncOverridesOrEmpty, type SyncOverrides } from '../../shared/sync-overrides.js';
```

Edit 2 of 2 in `companion/src/rest-host.ts` — replace:

```ts
    await this.setJson(AMAZON_LEDGER_SECRET_KEY, map);
  }

  /** Every Amazon label ever received, and the category it resolved to. Read by
   *  the addon card so it can show the user their REAL label set. */
  async getLastSyncImported(): Promise<number | null> {
```

with:

```ts
    await this.setJson(AMAZON_LEDGER_SECRET_KEY, map);
  }

  /** Venmo payments (3): the mail poll merges into it, both syncers consume. */
  async getVenmoLedger(): Promise<VenmoLedger> {
    const ledger = await this.getJson<VenmoLedger>(VENMO_LEDGER_SECRET_KEY);
    return ledger && typeof ledger === 'object' && !Array.isArray(ledger) ? ledger : {};
  }

  async setVenmoLedger(map: VenmoLedger): Promise<void> {
    await this.setJson(VENMO_LEDGER_SECRET_KEY, map);
  }

  /** Every Amazon label ever received, and the category it resolved to. Read by
   *  the addon card so it can show the user their REAL label set. */
  async getLastSyncImported(): Promise<number | null> {
```

Edit 1 of 3 in `src/utils/secrets.ts` — replace:

```ts
import { SKIPPED_TRANSACTIONS_SECRET_KEY, parseSkippedTransactions, parseSkippedTransactionsStrict, type ParsedSkippedTransactions, type SkippedTransaction } from '../../shared/skipped-transactions';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { AMAZON_LEDGER_SECRET_KEY } from '../../shared/amazon-ledger';
import { AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY } from '../../shared/amazon-config';
import { UNCATEGORIZED_STATUS_SECRET_KEY, AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, POOL_STATUS_SECRET_KEY, type AmazonMailStatus, type AmazonMailSamples } from '../../shared/status-keys';
import { SEMESTER_POOL_SECRET_KEY, parsePoolConfig } from '../../shared/pool';
```

with:

```ts
import { SKIPPED_TRANSACTIONS_SECRET_KEY, parseSkippedTransactions, parseSkippedTransactionsStrict, type ParsedSkippedTransactions, type SkippedTransaction } from '../../shared/skipped-transactions';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { AMAZON_LEDGER_SECRET_KEY } from '../../shared/amazon-ledger';
import { VENMO_LEDGER_SECRET_KEY, type VenmoLedger } from '../../shared/venmo-ledger';
import { AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY } from '../../shared/amazon-config';
import { UNCATEGORIZED_STATUS_SECRET_KEY, AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, POOL_STATUS_SECRET_KEY, type AmazonMailStatus, type AmazonMailSamples } from '../../shared/status-keys';
import { SEMESTER_POOL_SECRET_KEY, parsePoolConfig } from '../../shared/pool';
```

Edit 2 of 3 in `src/utils/secrets.ts` — replace:

```ts
  amazonConfig: AMAZON_CONFIG_SECRET_KEY,
  amazonLabels: AMAZON_LABELS_SECRET_KEY,
  amazonLedger: AMAZON_LEDGER_SECRET_KEY,
  dismissals: 'uncategorized_dismissals',
  hiddenSubscriptions: HIDDEN_SUBSCRIPTIONS_SECRET_KEY,
  confirmedSubscriptions: CONFIRMED_SUBSCRIPTIONS_SECRET_KEY,
```

with:

```ts
  amazonConfig: AMAZON_CONFIG_SECRET_KEY,
  amazonLabels: AMAZON_LABELS_SECRET_KEY,
  amazonLedger: AMAZON_LEDGER_SECRET_KEY,
  // The Venmo payments (3): companion-written, read by an add-on sync; the
  // same mailbox as Amazon's, so Reset clears it with the rest.
  venmoLedger: VENMO_LEDGER_SECRET_KEY,
  dismissals: 'uncategorized_dismissals',
  hiddenSubscriptions: HIDDEN_SUBSCRIPTIONS_SECRET_KEY,
  confirmedSubscriptions: CONFIRMED_SUBSCRIPTIONS_SECRET_KEY,
```

Edit 3 of 3 in `src/utils/secrets.ts` — replace:

```ts
  }
  async setAmazonLedger(map: AmazonLedger): Promise<void> {
    await this.ctx.api.secrets.set(AMAZON_LEDGER_SECRET_KEY, JSON.stringify(map));
  }

  /** How many activities the last completed run imported. Written by both syncers,
```

with:

```ts
  }
  async setAmazonLedger(map: AmazonLedger): Promise<void> {
    await this.ctx.api.secrets.set(AMAZON_LEDGER_SECRET_KEY, JSON.stringify(map));
  }

  /** Venmo payments awaiting their bank row (3), so an add-on sync adds the
   *  same notes the companion's does. Malformed reads as empty: Venmo notes
   *  off for the run, never a failed sync. */
  async getVenmoLedger(): Promise<VenmoLedger> {
    const raw = await this.ctx.api.secrets.get(VENMO_LEDGER_SECRET_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as VenmoLedger) : {};
    } catch {
      return {};
    }
  }
  async setVenmoLedger(map: VenmoLedger): Promise<void> {
    await this.ctx.api.secrets.set(VENMO_LEDGER_SECRET_KEY, JSON.stringify(map));
  }

  /** How many activities the last completed run imported. Written by both syncers,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/sync-core-venmo.test.ts src/utils/secrets.test.ts`
Expected: PASS — 50 tests.

Run: `cd companion && npx vitest run src/rest-host.test.ts`
Expected: PASS — 19 tests.

Run: `nice npm test`
Expected: PASS — 2557 tests (every sync test still green: an empty ledger skips the matcher).

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/sync-host.ts shared/sync-core.ts shared/fake-host.ts shared/sync-core-venmo.test.ts companion/src/rest-host.ts companion/src/rest-host.test.ts src/utils/secrets.ts src/utils/secrets.test.ts
git commit -m "Sync: a Venmo note at import or later, obeying noVenmoNote; both hosts read the Venmo ledger

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The companion reads Venmo's emails from the Amazon mailbox

The mail side (spec A "Reading emails", "The one-mailbox rule"; L2; Z1a). The IMAP adapter keeps Amazon's OR Venmo's messages (`createImapSource(cfg, accept)` — the default is still `isAmazonMessage`, so the `amazon-check` diagnostic is unchanged); the poll fetches once and hands each reader only its own (`shareMailSource(source).view(pick)`), so `ingestAmazonMail` and every Amazon test are untouched and a Venmo email never reaches Amazon's parser. `ingestVenmoMail` merges payments into `venmo_ledger` and flags them read, flags other Venmo mail read as ignored, and leaves an unreadable one unread as a redacted sample. It runs after Amazon's status is published, under its own guard; the samples are published to `venmo_mail_samples` every completed scan.

**Files:**
- Create: `companion/src/venmo-mail.ts`, `companion/src/venmo-mail.test.ts`
- Modify: `companion/src/amazon-mail.ts`, `companion/src/index.ts`, `shared/status-keys.ts`, `src/utils/secrets.ts`
- Test: `companion/src/index.test.ts`, `src/utils/secrets.test.ts`

**Interfaces:**
- Consumes: Task 1 (`classifyVenmoEmail`, `isVenmoMessage`, `toVenmoMailSample`); Task 2 (`mergeVenmoRecords`, `pruneVenmoLedger`, `VenmoLedger`); Task 4 (`RestSyncStore.getVenmoLedger/setVenmoLedger`); `AMAZON_SAMPLE_LIMIT` (shared/amazon-sample.ts).
- Produces:

```ts
// companion/src/amazon-mail.ts
export function mailBody(m: Pick<MailMessage, 'parts'>): string;
export function shareMailSource(source: MailSource): { view(pick: (m: MailMessage) => boolean): MailSource };
export async function createImapSource(cfg: AmazonMailConfig, accept?: (from: string | undefined, body: string) => boolean): Promise<MailSource>;
// companion/src/venmo-mail.ts
export function isVenmoMail(m: MailMessage): boolean;
export interface VenmoIngestStore { getVenmoLedger(): Promise<VenmoLedger>; setVenmoLedger(map: VenmoLedger): Promise<void> }
export interface VenmoIngestResult { scanned: number; added: number; ignored: number; unparsed: number; pruned: number; samples: AmazonMailSample[] }
export async function ingestVenmoMail(source: MailSource, store: VenmoIngestStore, nowMs: number): Promise<VenmoIngestResult>;
// shared/status-keys.ts
export const VENMO_MAIL_SAMPLES_SECRET_KEY: string;  // 'venmo_mail_samples'
export interface VenmoMailSamples { asOf: string; unparsed: number; samples: AmazonMailSample[] }
```

Log lines (companion): `Venmo mail: <n> scanned, <m> payments added[, <k> other Venmo emails skipped][, <u> unrecognised][, <p> pruned]` (only when something was scanned) and `Venmo mail error (notes skipped this run): <error>`.

- [ ] **Step 1: Write the failing tests**

**Create `companion/src/venmo-mail.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { mailBody, shareMailSource, type MailMessage, type MailSource } from './amazon-mail.js';
import { ingestVenmoMail, isVenmoMail, type VenmoIngestStore } from './venmo-mail.js';
import type { VenmoLedger } from '../../shared/venmo-ledger.js';

// Built from Venmo's documented wording, not a real email (follow-ups §13).
const PAID: MailMessage = {
  uid: 11, mailbox: 'INBOX', date: '2026-10-03T18:22:00Z', from: 'venmo@venmo.com',
  parts: { subject: 'You paid Jane Doe $25.00', plain: 'You paid Jane Doe\n$25.00\nRent October\nSee transaction\n' },
};
const SECURITY: MailMessage = {
  uid: 12, mailbox: 'INBOX', date: '2026-10-03T19:00:00Z', from: 'venmo@venmo.com',
  parts: { subject: 'Your Venmo security code', plain: 'Your code is 123456.' },
};
const UNREADABLE: MailMessage = {
  uid: 13, mailbox: '[Gmail]/Spam', date: '2026-10-04T08:00:00Z', from: 'venmo@venmo.com',
  parts: { subject: 'You paid Sam Lee $9.00', plain: 'A layout nobody has seen.\n' },
};
const AMAZON: MailMessage = {
  uid: 14, mailbox: 'INBOX', date: '2026-10-04T09:00:00Z', from: 'auto-confirm@amazon.com',
  parts: { plain: 'Thanks for your order!' },
};
const NOW = Date.parse('2026-10-14T12:00:00Z');

function fakeSource(messages: MailMessage[]) {
  const seen: MailMessage[] = [];
  const source: MailSource = {
    fetch: vi.fn(async () => messages),
    async markSeen(msgs) { seen.push(...msgs); },
    async close() {},
  };
  return { source, seen: () => seen };
}

function fakeStore(ledger: VenmoLedger = {}) {
  const state = { ledger, writes: 0 };
  const store: VenmoIngestStore = {
    async getVenmoLedger() { return state.ledger; },
    async setVenmoLedger(map) { state.ledger = map; state.writes += 1; },
  };
  return { store, state };
}

describe('ingestVenmoMail', () => {
  it('merges a payment on the email’s day, flags it and ignored mail read, and keeps the unreadable one unread as a sample', async () => {
    const { source, seen } = fakeSource([PAID, SECURITY, UNREADABLE]);
    const { store, state } = fakeStore();
    const r = await ingestVenmoMail(source, store, NOW);
    expect(r).toMatchObject({ scanned: 3, added: 1, ignored: 1, unparsed: 1, pruned: 0 });
    expect(Object.values(state.ledger)).toEqual([{
      direction: 'out', kind: 'payment', amountCents: 2500, counterparty: 'Jane Doe', note: 'Rent October', emailDate: '2026-10-03',
    }]);
    expect(seen().map((m) => m.uid)).toEqual([11, 12]);
    expect(r.samples).toEqual([{ at: '2026-10-04T08:00:00Z', from: 'venmo@venmo.com', subject: 'You paid Sam Lee $9.00', plain: 'A layout nobody has seen.', html: '' }]);
  });

  it('adds nothing for an email it already read, and writes nothing when nothing changed', async () => {
    const first = fakeStore();
    await ingestVenmoMail(fakeSource([PAID]).source, first.store, NOW);
    const again = await ingestVenmoMail(fakeSource([PAID]).source, first.store, NOW);
    expect(again.added).toBe(0);
    expect(first.state.writes).toBe(1);
  });

  it('prunes payments older than 90 days', async () => {
    const { store, state } = fakeStore({
      old: { direction: 'out', kind: 'payment', amountCents: 100, counterparty: 'X', note: 'Old', emailDate: '2026-06-01' },
    });
    const r = await ingestVenmoMail(fakeSource([]).source, store, NOW);
    expect(r.pruned).toBe(1);
    expect(state.ledger).toEqual({});
  });
});

describe('one mailbox, two readers', () => {
  it('reads the mailbox once and gives each reader only its own messages', async () => {
    const { source, seen } = fakeSource([PAID, AMAZON]);
    const shared = shareMailSource(source);
    const amazon = await shared.view((m) => m.from === 'auto-confirm@amazon.com').fetch();
    const venmoView = shared.view(isVenmoMail);
    expect((await venmoView.fetch()).map((m) => m.uid)).toEqual([11]);
    expect(amazon.map((m) => m.uid)).toEqual([14]);
    expect(source.fetch).toHaveBeenCalledTimes(1);
    await venmoView.markSeen([PAID]);
    expect(seen().map((m) => m.uid)).toEqual([11]);
  });

  it('knows a hand-forwarded Venmo email by its From: line', () => {
    const forwarded: MailMessage = { ...PAID, from: 'nick@gmail.com', parts: { plain: 'From: Venmo <venmo@venmo.com>\nYou paid Jane Doe' } };
    expect(isVenmoMail(forwarded)).toBe(true);
    expect(isVenmoMail(AMAZON)).toBe(false);
    expect(mailBody({ parts: { plain: 'a', html: 'b' } })).toBe('a\nb');
  });
});
```

Edit 1 of 3 in `companion/src/index.test.ts` — replace:

```ts
import { runSyncCore } from '../../shared/sync-core.js';
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending, getNativeCategorizedSpending, getNativeSpendingCategories, getNativeTxSearchRows } from './sqlite-native.js';
import { ingestAmazonMail } from './amazon-mail.js';
import { AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, UNCATEGORIZED_STATUS_SECRET_KEY } from '../../shared/status-keys.js';
import { CATEGORIZE_ENTRY_CALLBACK, escapeMarkdown } from '../../shared/telegram.js';
import { categoryFiledChange, stampChange } from '../../shared/change-entries.js';
import { existsSync } from 'fs';
```

with:

```ts
import { runSyncCore } from '../../shared/sync-core.js';
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending, getNativeCategorizedSpending, getNativeSpendingCategories, getNativeTxSearchRows } from './sqlite-native.js';
import { ingestAmazonMail } from './amazon-mail.js';
import { ingestVenmoMail } from './venmo-mail.js';
import { AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, UNCATEGORIZED_STATUS_SECRET_KEY, VENMO_MAIL_SAMPLES_SECRET_KEY } from '../../shared/status-keys.js';
import { CATEGORIZE_ENTRY_CALLBACK, escapeMarkdown } from '../../shared/telegram.js';
import { categoryFiledChange, stampChange } from '../../shared/change-entries.js';
import { existsSync } from 'fs';
```

Edit 2 of 3 in `companion/src/index.test.ts` — replace:

```ts
  ingestAmazonMail: vi.fn(async () => ({
    scanned: 0, added: 0, unparsed: 0, ignored: 0, pruned: 0, newLabels: [], unparsedSenders: {}, cancelled: 0, samples: [],
  })),
}));

vi.mock('fs', async (importOriginal) => {
```

with:

```ts
  ingestAmazonMail: vi.fn(async () => ({
    scanned: 0, added: 0, unparsed: 0, ignored: 0, pruned: 0, newLabels: [], unparsedSenders: {}, cancelled: 0, samples: [],
  })),
}));

// Venmo's ingest (3) reads the same faked mailbox: a quiet result by default,
// so every Amazon test above keeps exactly the mailbox it had.
vi.mock('./venmo-mail.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ingestVenmoMail: vi.fn(async () => ({ scanned: 0, added: 0, ignored: 0, unparsed: 0, pruned: 0, samples: [] })),
}));

vi.mock('fs', async (importOriginal) => {
```

Edit 3 of 3 in `companion/src/index.test.ts` — replace:

```ts
    expect(result.imported).toBe(2); // the mocked runSyncCore's usual result
    expect(secrets.has(AMAZON_MAIL_STATUS_SECRET_KEY)).toBe(false);
  });
});

describe('the /categorize wiring', () => {
```

with:

```ts
    expect(result.imported).toBe(2); // the mocked runSyncCore's usual result
    expect(secrets.has(AMAZON_MAIL_STATUS_SECRET_KEY)).toBe(false);
  });

  it('reads the same mailbox for Venmo, and keeps the Venmo emails it could not read', async () => {
    const secrets = configuredSecrets();
    await clientFor(secrets);
    vi.mocked(ingestVenmoMail).mockClear();
    vi.mocked(ingestVenmoMail).mockResolvedValueOnce({
      scanned: 2, added: 1, ignored: 0, unparsed: 1, pruned: 0,
      samples: [{ at: '2026-10-03T12:00:00Z', from: 'venmo@venmo.com', subject: 'You paid Jane Doe $25.00', plain: 'x', html: '' }],
    });

    await runCompanionSync();

    expect(vi.mocked(ingestVenmoMail)).toHaveBeenCalledTimes(1);
    const kept = JSON.parse(secrets.get(VENMO_MAIL_SAMPLES_SECRET_KEY)!);
    expect(kept.unparsed).toBe(1);
    expect(kept.samples.map((s: { subject: string }) => s.subject)).toEqual(['You paid Jane Doe $25.00']);
  });

  it('a Venmo failure leaves Amazon’s scan a completed one and the sync untouched', async () => {
    const secrets = configuredSecrets();
    await clientFor(secrets);
    vi.mocked(ingestVenmoMail).mockRejectedValueOnce(new Error('venmo parser exploded'));

    const result = await runCompanionSync();

    expect(result.imported).toBe(2);
    expect(JSON.parse(secrets.get(AMAZON_MAIL_STATUS_SECRET_KEY)!).error).toBeUndefined();
    expect(secrets.has(VENMO_MAIL_SAMPLES_SECRET_KEY)).toBe(false);
  });
});

describe('the /categorize wiring', () => {
```

Edit 1 of 1 in `src/utils/secrets.test.ts` — replace:

```ts
    expect(await s.getVenmoLedger()).toEqual({});
    await s.clearAll();
    expect(data['venmo_ledger']).toBeUndefined();
  });
});

```

with:

```ts
    expect(await s.getVenmoLedger()).toEqual({});
    await s.clearAll();
    expect(data['venmo_ledger']).toBeUndefined();
  });

  it('clearAll removes the unreadable Venmo emails the companion keeps', async () => {
    const { ctx, data } = makeCtxWithData();
    data['venmo_mail_samples'] = JSON.stringify({ asOf: '2026-10-05', unparsed: 1, samples: [] });
    await new SecretsStore(ctx).clearAll();
    expect(data['venmo_mail_samples']).toBeUndefined();
  });
});

```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/venmo-mail.test.ts src/index.test.ts`
Expected: FAIL — both files fail to load (`Cannot find module './venmo-mail.js'`); no tests run.

Run: `npx vitest run src/utils/secrets.test.ts`
Expected: FAIL — 1 test: `clearAll removes the unreadable Venmo emails the companion keeps`.

- [ ] **Step 3: Implement**

Edit 1 of 1 in `shared/status-keys.ts` — replace:

```ts
}

/**
 * The semester pool's computed `PoolStatus` (shared/pool.ts), republished by
 * the companion on every sync — the Overview tile renders it verbatim, which
 * is what keeps the tile and the Telegram reports one implementation. Written
```

with:

```ts
}

/**
 * The Venmo emails the parser could not read (3), redacted like Amazon's —
 * kept because Venmo's formats are unverified, so the first real email that
 * breaks a pattern can be read without a shell on the server. Replaced on every
 * completed scan of the mailbox, so it clears once a fix reads the mail.
 */
export const VENMO_MAIL_SAMPLES_SECRET_KEY = 'venmo_mail_samples';

/** What the companion publishes under `VENMO_MAIL_SAMPLES_SECRET_KEY`. */
export interface VenmoMailSamples {
  asOf: string;
  /** Venmo emails left unread on that scan. */
  unparsed: number;
  samples: AmazonMailSample[];
}

/**
 * The semester pool's computed `PoolStatus` (shared/pool.ts), republished by
 * the companion on every sync — the Overview tile renders it verbatim, which
 * is what keeps the tile and the Telegram reports one implementation. Written
```

Edit 1 of 3 in `companion/src/amazon-mail.ts` — replace:

```ts
   *  rather than uids, because a uid means nothing without its mailbox. */
  markSeen(messages: MailMessage[]): Promise<void>;
  close(): Promise<void>;
}

/** What a poll found, for logging and for the daily digest. */
```

with:

```ts
   *  rather than uids, because a uid means nothing without its mailbox. */
  markSeen(messages: MailMessage[]): Promise<void>;
  close(): Promise<void>;
}

/** A message's two body copies as one text — what the sender checks
 *  (`isAmazonMessage`, `isVenmoMessage`) read for a hand-forwarded `From:`. */
export function mailBody(m: Pick<MailMessage, 'parts'>): string {
  return [m.parts.plain, m.parts.html].filter(Boolean).join('\n');
}

/**
 * One read of the mailbox shared by every reader of it — Amazon's ingest and
 * Venmo's (3) — so a poll connects and fetches once. Each view's `fetch` is
 * that one read filtered to its own messages; `markSeen` goes to the source,
 * and closing is the caller's, once, on the source itself.
 */
export function shareMailSource(source: MailSource): { view(pick: (m: MailMessage) => boolean): MailSource } {
  let all: Promise<MailMessage[]> | null = null;
  const read = () => {
    if (!all) all = source.fetch();
    return all;
  };
  return {
    view: (pick) => ({
      fetch: async () => (await read()).filter(pick),
      markSeen: (messages) => source.markSeen(messages),
      close: async () => {},
    }),
  };
}

/** What a poll found, for logging and for the daily digest. */
```

Edit 2 of 3 in `companion/src/amazon-mail.ts` — replace:

```ts
 * arrive as `=E2=80=AB` sequences and lines are broken with soft `=` continuations
 * — both of which silently corrupt the text the parser is looking at.
 */
export async function createImapSource(cfg: AmazonMailConfig): Promise<MailSource> {
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');

```

with:

```ts
 * arrive as `=E2=80=AB` sequences and lines are broken with soft `=` continuations
 * — both of which silently corrupt the text the parser is looking at.
 */
export async function createImapSource(
  cfg: AmazonMailConfig,
  /** Which messages to read at all. Amazon's by default; the companion's poll
   *  passes Amazon's or Venmo's (3). Anything else stays unread. */
  accept: (from: string | undefined, body: string) => boolean = isAmazonMessage,
): Promise<MailSource> {
  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');

```

Edit 3 of 3 in `companion/src/amazon-mail.ts` — replace:

```ts
        // should contain nothing else, but "should" is not a reason to parse
        // whatever else lands in it. Needs the decoded body too, so a hand-forwarded
        // order — whose From: is the person who forwarded it — still counts.
        if (!isAmazonMessage(from[0], [parts.plain, parts.html].filter(Boolean).join('\n'))) continue;
        out.push({
          uid: msg.uid,
          mailbox,
```

with:

```ts
        // should contain nothing else, but "should" is not a reason to parse
        // whatever else lands in it. Needs the decoded body too, so a hand-forwarded
        // order — whose From: is the person who forwarded it — still counts.
        if (!accept(from[0], [parts.plain, parts.html].filter(Boolean).join('\n'))) continue;
        out.push({
          uid: msg.uid,
          mailbox,
```

**Create `companion/src/venmo-mail.ts`:**

```ts
/**
 * companion/src/venmo-mail.ts
 *
 * Filling the Venmo ledger from the same forwarding mailbox Amazon's orders
 * use (project 3): the person adds a second Gmail filter, `from:venmo@venmo.com`
 * → forward to that address. On whenever the Amazon mailbox is configured; it
 * only ever acts on Venmo mail that arrives there.
 *
 * The decisions live in `ingestVenmoMail` over a `MailSource` view (see
 * `shareMailSource` in ./amazon-mail.ts), exactly as `ingestAmazonMail`: a
 * payment is merged and its message flagged read, other Venmo mail is flagged
 * read and counted as ignored, and one that looks like a payment but does not
 * read stays UNREAD and becomes a sample.
 */
import { classifyVenmoEmail, isVenmoMessage, toVenmoMailSample } from '../../shared/venmo.js';
import { mergeVenmoRecords, pruneVenmoLedger, type VenmoLedger } from '../../shared/venmo-ledger.js';
import { AMAZON_SAMPLE_LIMIT } from '../../shared/amazon-sample.js';
import type { AmazonMailSample } from '../../shared/status-keys.js';
import { mailBody, type MailMessage, type MailSource } from './amazon-mail.js';

/** Whether a fetched message is Venmo's: its sender, or a hand-forwarded copy. */
export function isVenmoMail(m: MailMessage): boolean {
  return isVenmoMessage(m.from, mailBody(m));
}

export interface VenmoIngestStore {
  getVenmoLedger(): Promise<VenmoLedger>;
  setVenmoLedger(map: VenmoLedger): Promise<void>;
}

/** What a poll found, for the log line and the samples secret. */
export interface VenmoIngestResult {
  scanned: number;
  /** Payments added to the ledger this poll. */
  added: number;
  /** Venmo mail that moves no money: flagged read. */
  ignored: number;
  /** Looked like a payment and did not read: left unread. */
  unparsed: number;
  pruned: number;
  /** Redacted copies of the unread ones, newest `AMAZON_SAMPLE_LIMIT`. */
  samples: AmazonMailSample[];
}

/** Read the Venmo messages into the ledger. Only messages it understood are
 *  flagged read; the ledger is written only when something changed. */
export async function ingestVenmoMail(
  source: MailSource,
  store: VenmoIngestStore,
  nowMs: number,
): Promise<VenmoIngestResult> {
  const messages = await source.fetch();
  let ledger = await store.getVenmoLedger();
  const result: VenmoIngestResult = { scanned: messages.length, added: 0, ignored: 0, unparsed: 0, pruned: 0, samples: [] };
  const consumed: MailMessage[] = [];

  for (const msg of messages) {
    const { status, record } = classifyVenmoEmail(msg.parts);
    if (status === 'ignored') {
      result.ignored += 1;
      consumed.push(msg);
      continue;
    }
    if (status !== 'payment' || !record) {
      result.unparsed += 1;
      result.samples.push(toVenmoMailSample(msg));
      continue;
    }
    // The email's day: the ±5-day window is measured in days, as Amazon's is.
    const merged = mergeVenmoRecords(ledger, [record], new Date(msg.date).toISOString().slice(0, 10));
    ledger = merged.ledger;
    result.added += merged.added;
    consumed.push(msg);
  }

  result.samples = result.samples.slice(-AMAZON_SAMPLE_LIMIT);
  const pruned = pruneVenmoLedger(ledger, nowMs);
  result.pruned = pruned.removed;
  if (result.added > 0 || pruned.removed > 0) await store.setVenmoLedger(pruned.ledger);
  if (consumed.length > 0) await source.markSeen(consumed);
  return result;
}
```

Edit 1 of 5 in `companion/src/index.ts` — replace:

```ts
import { monthEndForecast, previousThreeFullMonths, daysInMonthOf } from '../../shared/projection.js';
import { startTelegramListener } from './telegram-listener.js';
import type { TelegramListenerDeps } from './telegram-listener.js';
import { createImapSource, ingestAmazonMail, amazonMailConfigured } from './amazon-mail.js';
import { AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY } from './amazon-mail.js';
import type { AmazonIngestResult, AmazonMailConfig, MailSource } from './amazon-mail.js';
import { DEFAULT_GLYPH_STYLE, money, whyButton, WHY_BUTTON_TEXT, WHY_CALLBACK_PREFIX } from '../../shared/telegram.js';
```

with:

```ts
import { monthEndForecast, previousThreeFullMonths, daysInMonthOf } from '../../shared/projection.js';
import { startTelegramListener } from './telegram-listener.js';
import type { TelegramListenerDeps } from './telegram-listener.js';
import { createImapSource, ingestAmazonMail, amazonMailConfigured, isAmazonMessage, mailBody, shareMailSource } from './amazon-mail.js';
import { ingestVenmoMail, isVenmoMail } from './venmo-mail.js';
import { isVenmoMessage } from '../../shared/venmo.js';
import { AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY } from './amazon-mail.js';
import type { AmazonIngestResult, AmazonMailConfig, MailSource } from './amazon-mail.js';
import { DEFAULT_GLYPH_STYLE, money, whyButton, WHY_BUTTON_TEXT, WHY_CALLBACK_PREFIX } from '../../shared/telegram.js';
```

Edit 2 of 5 in `companion/src/index.ts` — replace:

```ts
import type { ChangeDraft } from '../../shared/change-entries.js';
import { createTransferLearning, type TransferLearning } from './transfer-learning.js';
import type { CategorizeController, CategorizeDeps } from './categorize.js';
import { AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, UNCATEGORIZED_STATUS_SECRET_KEY, POOL_STATUS_SECRET_KEY, type AmazonMailStatus, type AmazonMailSamples } from '../../shared/status-keys.js';
import {
  formatHelpReply,
  formatLeftReply,
```

with:

```ts
import type { ChangeDraft } from '../../shared/change-entries.js';
import { createTransferLearning, type TransferLearning } from './transfer-learning.js';
import type { CategorizeController, CategorizeDeps } from './categorize.js';
import { AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, UNCATEGORIZED_STATUS_SECRET_KEY, POOL_STATUS_SECRET_KEY, VENMO_MAIL_SAMPLES_SECRET_KEY, type AmazonMailStatus, type AmazonMailSamples, type VenmoMailSamples } from '../../shared/status-keys.js';
import {
  formatHelpReply,
  formatLeftReply,
```

Edit 3 of 5 in `companion/src/index.ts` — replace:

```ts
  );
  let source: MailSource | null = null;
  try {
    source = await createImapSource(merged);
    const result = await ingestAmazonMail(source, store, merged, Date.now());
    log(
      `Amazon mail: ${result.scanned} scanned, ${result.added} orders added` +
      `${result.ignored ? `, ${result.ignored} delivery notices skipped` : ''}` +
```

with:

```ts
  );
  let source: MailSource | null = null;
  try {
    // Amazon's and Venmo's messages (3), one read shared between the two.
    source = await createImapSource(merged, (from, body) => isAmazonMessage(from, body) || isVenmoMessage(from, body));
    const mailbox = shareMailSource(source);
    const result = await ingestAmazonMail(mailbox.view((m) => isAmazonMessage(m.from, mailBody(m))), store, merged, Date.now());
    log(
      `Amazon mail: ${result.scanned} scanned, ${result.added} orders added` +
      `${result.ignored ? `, ${result.ignored} delivery notices skipped` : ''}` +
```

Edit 4 of 5 in `companion/src/index.ts` — replace:

```ts
    await wfClient
      .setAddonSecret('simplefin-sync', AMAZON_MAIL_SAMPLES_SECRET_KEY, JSON.stringify(samples))
      .catch(() => {});
    return result.newLabels;
  } catch (err) {
    log(`Amazon mail error (categorization skipped this run): ${formatError(err)}`);
```

with:

```ts
    await wfClient
      .setAddonSecret('simplefin-sync', AMAZON_MAIL_SAMPLES_SECRET_KEY, JSON.stringify(samples))
      .catch(() => {});
    await pollVenmoMail(mailbox.view(isVenmoMail), store, wfClient);
    return result.newLabels;
  } catch (err) {
    log(`Amazon mail error (categorization skipped this run): ${formatError(err)}`);
```

Edit 5 of 5 in `companion/src/index.ts` — replace:

```ts
    return [];
  } finally {
    await source?.close().catch(() => {});
  }
}

```

with:

```ts
    return [];
  } finally {
    await source?.close().catch(() => {});
  }
}

/**
 * The same mailbox's Venmo emails into the Venmo ledger (3). On whenever the
 * Amazon mailbox is: it only acts on Venmo mail that arrives. Its own guard —
 * a Venmo failure costs this run's Venmo notes, never Amazon's status or the
 * sync. The unreadable ones are published every completed scan, so the set
 * clears itself once a fix reads them.
 */
async function pollVenmoMail(source: MailSource, store: RestSyncStore, wfClient: WealthfolioClient): Promise<void> {
  try {
    const result = await ingestVenmoMail(source, store, Date.now());
    if (result.scanned > 0) {
      log(
        `Venmo mail: ${result.scanned} scanned, ${result.added} payments added` +
        `${result.ignored ? `, ${result.ignored} other Venmo emails skipped` : ''}` +
        `${result.unparsed ? `, ${result.unparsed} unrecognised` : ''}` +
        `${result.pruned ? `, ${result.pruned} pruned` : ''}`,
      );
    }
    const samples: VenmoMailSamples = { asOf: new Date().toISOString(), unparsed: result.unparsed, samples: result.samples };
    await wfClient
      .setAddonSecret('simplefin-sync', VENMO_MAIL_SAMPLES_SECRET_KEY, JSON.stringify(samples))
      .catch(() => {});
  } catch (err) {
    log(`Venmo mail error (notes skipped this run): ${formatError(err)}`);
  }
}

```

Edit 1 of 2 in `src/utils/secrets.ts` — replace:

```ts
import { AMAZON_LEDGER_SECRET_KEY } from '../../shared/amazon-ledger';
import { VENMO_LEDGER_SECRET_KEY, type VenmoLedger } from '../../shared/venmo-ledger';
import { AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY } from '../../shared/amazon-config';
import { UNCATEGORIZED_STATUS_SECRET_KEY, AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, POOL_STATUS_SECRET_KEY, type AmazonMailStatus, type AmazonMailSamples } from '../../shared/status-keys';
import { SEMESTER_POOL_SECRET_KEY, parsePoolConfig } from '../../shared/pool';
import type { SemesterPoolConfig, PoolStatus } from '../../shared/pool';
import { REPORT_CUBE_SECRET_KEY, parseReportCube } from '../../shared/report-cube';
```

with:

```ts
import { AMAZON_LEDGER_SECRET_KEY } from '../../shared/amazon-ledger';
import { VENMO_LEDGER_SECRET_KEY, type VenmoLedger } from '../../shared/venmo-ledger';
import { AMAZON_CONFIG_SECRET_KEY, AMAZON_LABELS_SECRET_KEY } from '../../shared/amazon-config';
import { UNCATEGORIZED_STATUS_SECRET_KEY, AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, POOL_STATUS_SECRET_KEY, VENMO_MAIL_SAMPLES_SECRET_KEY, type AmazonMailStatus, type AmazonMailSamples } from '../../shared/status-keys';
import { SEMESTER_POOL_SECRET_KEY, parsePoolConfig } from '../../shared/pool';
import type { SemesterPoolConfig, PoolStatus } from '../../shared/pool';
import { REPORT_CUBE_SECRET_KEY, parseReportCube } from '../../shared/report-cube';
```

Edit 2 of 2 in `src/utils/secrets.ts` — replace:

```ts
  // The Venmo payments (3): companion-written, read by an add-on sync; the
  // same mailbox as Amazon's, so Reset clears it with the rest.
  venmoLedger: VENMO_LEDGER_SECRET_KEY,
  dismissals: 'uncategorized_dismissals',
  hiddenSubscriptions: HIDDEN_SUBSCRIPTIONS_SECRET_KEY,
  confirmedSubscriptions: CONFIRMED_SUBSCRIPTIONS_SECRET_KEY,
```

with:

```ts
  // The Venmo payments (3): companion-written, read by an add-on sync; the
  // same mailbox as Amazon's, so Reset clears it with the rest.
  venmoLedger: VENMO_LEDGER_SECRET_KEY,
  // The unreadable Venmo emails beside it: companion-written, redacted text.
  venmoMailSamples: VENMO_MAIL_SAMPLES_SECRET_KEY,
  dismissals: 'uncategorized_dismissals',
  hiddenSubscriptions: HIDDEN_SUBSCRIPTIONS_SECRET_KEY,
  confirmedSubscriptions: CONFIRMED_SUBSCRIPTIONS_SECRET_KEY,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run src/venmo-mail.test.ts src/index.test.ts src/amazon-mail.test.ts`
Expected: PASS — 322 tests.

Run: `npx vitest run src/utils/secrets.test.ts`
Expected: PASS — 45 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/venmo-mail.ts companion/src/venmo-mail.test.ts companion/src/amazon-mail.ts companion/src/index.ts companion/src/index.test.ts shared/status-keys.ts src/utils/secrets.ts src/utils/secrets.test.ts
git commit -m "Companion: read Venmo emails from the Amazon mailbox into the Venmo ledger; keep the unreadable ones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The guess — how you filed the same merchant before (2 filings, 80%, a year)

The pure guess (spec B "How a guess is made"; L3; Z1c). Filings are keyed by `/categorize`'s own rule pattern (`categoryRulePattern`, compared without case), and a Venmo row with a note also by the note, which is tried first. A key with at least 2 filings and one category holding at least 80% of them is a guess; integers only, so exactly 80% counts. Amazon rows never get one. `guessSinceDay` is the year's first day.

**Files:**
- Create: `shared/category-guess.ts`, `shared/category-guess.test.ts`

**Interfaces:**
- Consumes: `categoryRulePattern` (shared/rule-pattern.ts); `isAmazonDescription` (shared/amazon-ledger.ts); Task 2 (`VENMO_NOTE_MARK`).
- Produces:

```ts
export const GUESS_LOOKBACK_DAYS: number;      // 365
export const GUESS_MIN_FILINGS: number;        // 2
export const GUESS_MIN_SHARE_PERCENT: number;  // 80
export interface PastFiling { description: string; categoryId: string; categoryName: string }
export interface CategoryGuess { categoryId: string; name: string; count: number }
export type GuessIndex;  // ReadonlyMap<key, tally>
export function guessKeys(description: string): string[];
export function buildGuessIndex(filings: readonly PastFiling[]): GuessIndex;
export function guessCategory(index: GuessIndex, description: string): CategoryGuess | null;
export function guessSinceDay(now: Date): string;
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/category-guess.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import {
  buildGuessIndex, guessCategory, guessKeys, guessSinceDay, GUESS_LOOKBACK_DAYS, GUESS_MIN_FILINGS, GUESS_MIN_SHARE_PERCENT,
  type PastFiling,
} from './category-guess';

const filed = (description: string, categoryId = 'cat-gro', categoryName = 'Groceries'): PastFiling => ({ description, categoryId, categoryName });
const guess = (filings: PastFiling[], description: string) => guessCategory(buildGuessIndex(filings), description);

describe('guessCategory — the thresholds', () => {
  it('is L3’s numbers: 2 filings, 80%, a year', () => {
    expect([GUESS_MIN_FILINGS, GUESS_MIN_SHARE_PERCENT, GUESS_LOOKBACK_DAYS]).toEqual([2, 80, 365]);
  });

  it('guesses from exactly 2 filings in one category, and not from 1', () => {
    expect(guess([filed('KROGER #415'), filed('KROGER #415')], 'KROGER #415')).toEqual({ categoryId: 'cat-gro', name: 'Groceries', count: 2 });
    expect(guess([filed('KROGER #415')], 'KROGER #415')).toBeNull();
  });

  it('guesses at exactly 80% (4 of 5) and not below (3 of 4)', () => {
    const four = [filed('KROGER'), filed('KROGER'), filed('KROGER'), filed('KROGER'), filed('KROGER', 'cat-home', 'Home')];
    expect(guess(four, 'KROGER')).toEqual({ categoryId: 'cat-gro', name: 'Groceries', count: 4 });
    const three = [filed('KROGER'), filed('KROGER'), filed('KROGER'), filed('KROGER', 'cat-home', 'Home')];
    expect(guess(three, 'KROGER')).toBeNull();
    expect(guess([filed('KROGER'), filed('KROGER', 'cat-home', 'Home')], 'KROGER')).toBeNull();
  });

  it('counts charges whose reference numbers differ as one merchant, without case', () => {
    const past = [filed('NETFLIX.COM 866-579-7172', 'cat-sub', 'Subscriptions'), filed('Netflix.com 866-000-1111', 'cat-sub', 'Subscriptions')];
    expect(guess(past, 'NETFLIX.COM')).toEqual({ categoryId: 'cat-sub', name: 'Subscriptions', count: 2 });
    expect(guess(past, 'HULU 877-824-4858')).toBeNull();
  });

  it('never guesses an Amazon row — the Amazon pipeline files those', () => {
    const past = [filed('AMAZON.COM*MB3T81'), filed('AMAZON.COM*MB3T81')];
    expect(guess(past, 'AMAZON.COM*MB3T81')).toBeNull();
  });

  it('skips a category with no name rather than guessing a blank', () => {
    expect(guess([filed('KROGER', 'cat-x', ''), filed('KROGER', 'cat-x', '')], 'KROGER')).toBeNull();
  });
});

describe('guessCategory — Venmo notes', () => {
  it('tries a Venmo row by its note first, any case', () => {
    const past = [
      filed('VENMO PAYMENT 1023 · Venmo: Rent October', 'cat-rent', 'Rent'),
      filed('VENMO PAYMENT 1188 · Venmo: rent october', 'cat-rent', 'Rent'),
    ];
    expect(guess(past, 'VENMO PAYMENT 2001 · Venmo: Rent October')).toEqual({ categoryId: 'cat-rent', name: 'Rent', count: 2 });
  });

  it('falls back to the bank’s own words when the note decides nothing', () => {
    const past = [
      filed('VENMO CASHOUT · Venmo: Transfer to your bank', 'cat-tr', 'Transfers'),
      filed('VENMO CASHOUT', 'cat-tr', 'Transfers'),
    ];
    expect(guess(past, 'VENMO CASHOUT · Venmo: Something new')).toEqual({ categoryId: 'cat-tr', name: 'Transfers', count: 2 });
  });

  it('files a note and its bank words under both keys', () => {
    expect(guessKeys('VENMO PAYMENT 1023 · Venmo: Rent  October')).toEqual(['venmo:rent october', 'pattern:venmo payment']);
    expect(guessKeys('KROGER #415 12/03')).toEqual(['pattern:kroger']);
  });
});

describe('guessSinceDay', () => {
  it('is a year back, as a UTC day', () => {
    expect(guessSinceDay(new Date('2026-10-14T12:00:00Z'))).toBe('2025-10-14');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/category-guess.test.ts`
Expected: FAIL — `Failed to resolve import "./category-guess"`; no tests run.

- [ ] **Step 3: Implement**

**Create `shared/category-guess.ts`:**

```ts
/**
 * shared/category-guess.ts
 *
 * The category a needs-a-category row was probably meant for (project 3, L3):
 * how you filed the same merchant before. Pure — the companion reads the
 * filings, this module only counts them.
 *
 * "The same merchant" is the rule pattern `/categorize` would build for the
 * row (`categoryRulePattern`, ./rule-pattern.ts), compared without case: two
 * Netflix charges with different reference numbers share it. A guess needs at
 * least `GUESS_MIN_FILINGS` filings under that key in the last
 * `GUESS_LOOKBACK_DAYS`, and at least `GUESS_MIN_SHARE_PERCENT` of them in one
 * category. A Venmo row with a note (` · Venmo: <note>`) is tried by its note
 * first — the same note usually means the same category — then by the bank's
 * own words. Amazon rows get no guess: the Amazon pipeline files them.
 *
 * A guess never files anything (L4): Telegram offers it as one tap, the app
 * shows it as a hint.
 */
import { isAmazonDescription } from './amazon-ledger.js';
import { categoryRulePattern } from './rule-pattern.js';
import { VENMO_NOTE_MARK } from './venmo-ledger.js';

export const GUESS_LOOKBACK_DAYS = 365;
export const GUESS_MIN_FILINGS = 2;
export const GUESS_MIN_SHARE_PERCENT = 80;

/** One past spending filing: the row's description (its note without the tx
 *  id — `descriptionFromComment`) and the category it was filed under. */
export interface PastFiling {
  description: string;
  categoryId: string;
  categoryName: string;
}

/** The guess: a category, its name, and how many past filings chose it. */
export interface CategoryGuess {
  categoryId: string;
  name: string;
  count: number;
}

interface Tally {
  total: number;
  byCategory: Map<string, { name: string; count: number }>;
}

export type GuessIndex = ReadonlyMap<string, Tally>;

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** The keys a description is filed and guessed under, most specific first:
 *  a Venmo note's own words, then the bank text's rule pattern. */
export function guessKeys(description: string): string[] {
  const at = description.indexOf(VENMO_NOTE_MARK);
  const bank = at === -1 ? description : description.slice(0, at);
  const note = at === -1 ? '' : norm(description.slice(at + VENMO_NOTE_MARK.length));
  const pattern = norm(categoryRulePattern(bank.trim()));
  return [...(note ? [`venmo:${note}`] : []), ...(pattern ? [`pattern:${pattern}`] : [])];
}

/** Count the filings once, by key and category. */
export function buildGuessIndex(filings: readonly PastFiling[]): GuessIndex {
  const index = new Map<string, Tally>();
  for (const f of filings) {
    if (!f.categoryId) continue;
    for (const key of guessKeys(f.description)) {
      const tally = index.get(key) ?? { total: 0, byCategory: new Map() };
      tally.total += 1;
      const hit = tally.byCategory.get(f.categoryId) ?? { name: f.categoryName, count: 0 };
      hit.count += 1;
      tally.byCategory.set(f.categoryId, hit);
      index.set(key, tally);
    }
  }
  return index;
}

/** The guess for a row's description, or null: too few filings, no category
 *  with 80% of them, a category with no name, or an Amazon row. */
export function guessCategory(index: GuessIndex, description: string): CategoryGuess | null {
  if (isAmazonDescription(description)) return null;
  for (const key of guessKeys(description)) {
    const tally = index.get(key);
    if (!tally || tally.total < GUESS_MIN_FILINGS) continue;
    for (const [categoryId, hit] of tally.byCategory) {
      if (hit.name && hit.count * 100 >= tally.total * GUESS_MIN_SHARE_PERCENT) {
        return { categoryId, name: hit.name, count: hit.count };
      }
    }
  }
  return null;
}

/** The first day (YYYY-MM-DD, UTC) whose filings count: a year back. */
export function guessSinceDay(now: Date): string {
  return new Date(now.getTime() - GUESS_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/category-guess.test.ts`
Expected: PASS — 10 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/category-guess.ts shared/category-guess.test.ts
git commit -m "Guesses: the category you filed the same merchant under before — 2 filings, 80%, a year

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The companion reads the year's filings and publishes each row's guess

The guess's one read and the published status (spec B "Where the guess appears — Published"; D "A failed guess read means no guesses"; Z1c). `getNativePastFilings` is strict (it throws `NativeDbUnreadableError` rather than answering `[]`): spending-taxonomy assignments with `source` `manual` or `rule`, created on or after the day, the add-on's bookkeeping rows left out, the note made a description. `publishUncategorizedStatus` takes an optional reader: each published row gains `guess: { categoryId, name }` when there is one — the key is absent otherwise, so an older add-on sees the shape it always did — never on a row that takes an income category; a reader that throws publishes no guesses at all and the status as usual. Both publish sites pass the reader.

**Files:**
- Create: `companion/src/sqlite-guess.ts`, `companion/src/sqlite-guess.test.ts`
- Modify: `shared/uncategorized.ts`, `companion/src/uncategorized-status.ts`, `companion/src/index.ts`
- Test: `companion/src/uncategorized-status.test.ts`, `companion/src/index.test.ts`

**Interfaces:**
- Consumes: Task 6 (`buildGuessIndex`, `guessCategory`, `guessSinceDay`, `PastFiling`, `GuessIndex`); `queryNativeDbStrict`, `DRILL_CLI_SEPARATOR` (companion/src/sqlite-native.ts); `SPENDING_TAXONOMY_ID` (shared/cash-flow-bucket.ts); `descriptionFromComment` (shared/sync-core.ts).
- Produces:

```ts
// shared/uncategorized.ts — UncategorizedRow
guess?: { categoryId: string; name: string };
// companion/src/sqlite-guess.ts
export function pastFilingFromCliParts(parts: string[]): Record<string, unknown> | null;
export function getNativePastFilings(dbPath: string, sinceDay: string): PastFiling[];  // throws when unreadable
// companion/src/uncategorized-status.ts
export async function publishUncategorizedStatus(setSecret, readRows, readLedger, now?: Date, readFilings?: () => PastFiling[]): Promise<void>;
export async function publishUncategorizedStatusForDbPath(dbPath, setSecret, readRows, readLedger, now?: Date,
  readFilings?: (dbPath: string, sinceDay: string) => PastFiling[]): Promise<void>;
// UncategorizedSourceRow gains incomeEligible?: boolean
```

- [ ] **Step 1: Write the failing tests**

**Create `companion/src/sqlite-guess.test.ts`:**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getNativePastFilings, pastFilingFromCliParts } from './sqlite-guess.js';
import { NativeDbUnreadableError } from './sqlite-native.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** The real tables and column names, only the columns this reader touches. */
function db(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-guess-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const d = new DatabaseSync(path);
  d.exec(`
    CREATE TABLE activities (id TEXT PRIMARY KEY, notes TEXT);
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, taxonomy_id TEXT, name TEXT, parent_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (id TEXT, activity_id TEXT, taxonomy_id TEXT, category_id TEXT, weight INTEGER, source TEXT, created_at TEXT);
    INSERT INTO taxonomy_categories VALUES ('cat-gro', 'spending_categories', 'Groceries', NULL), ('inc', 'income_sources', 'Pay', NULL);
    INSERT INTO activities VALUES
      ('a1', 'KROGER #415 · TRN-1'), ('a2', 'KROGER #415 · TRN-2 · pending'), ('a3', 'KROGER #9 · TRN-3'),
      ('a4', 'OLD KROGER · TRN-4'), ('a5', 'PAYROLL · TRN-5'), ('a6', 'Starting balance · ACT-1'),
      ('a7', 'VENMO' || char(10) || 'PAYMENT · Venmo: Rent · TRN-7'), ('a8', 'MIGRATED · TRN-8');
    INSERT INTO activity_taxonomy_assignments VALUES
      ('x1', 'a1', 'spending_categories', 'cat-gro', 10000, 'manual', '2026-10-01T09:00:00Z'),
      ('x2', 'a2', 'spending_categories', 'cat-gro', 10000, 'rule', '2026-09-01 12:00:00'),
      ('x3', 'a3', 'spending_categories', 'cat-gone', 10000, 'manual', '2026-08-01T00:00:00Z'),
      ('x4', 'a4', 'spending_categories', 'cat-gro', 10000, 'manual', '2025-10-13T23:59:59Z'),
      ('x5', 'a5', 'income_sources', 'inc', 10000, 'manual', '2026-10-01T00:00:00Z'),
      ('x6', 'a6', 'spending_categories', 'cat-gro', 10000, 'manual', '2026-10-01T00:00:00Z'),
      ('x7', 'a7', 'spending_categories', 'cat-gro', 10000, 'MANUAL', '2026-10-02T00:00:00Z'),
      ('x8', 'a8', 'spending_categories', 'cat-gro', 10000, 'migrated', '2026-10-02T00:00:00Z');
  `);
  d.close();
  return path;
}

describe('getNativePastFilings', () => {
  it('reads your spending filings and your rules’ since the day — not income, bookkeeping, migrated or older ones', () => {
    const rows = getNativePastFilings(db(), '2025-10-14');
    const byText = (a: { description: string }, b: { description: string }) => (a.description < b.description ? -1 : a.description > b.description ? 1 : 0);
    expect(rows.sort(byText)).toEqual([
      { categoryId: 'cat-gro', categoryName: 'Groceries', description: 'KROGER #415' },
      { categoryId: 'cat-gro', categoryName: 'Groceries', description: 'KROGER #415' },
      { categoryId: 'cat-gone', categoryName: '', description: 'KROGER #9' },
      { categoryId: 'cat-gro', categoryName: 'Groceries', description: 'VENMO PAYMENT · Venmo: Rent' },
    ]);
  });

  it('throws — never answers "no filings" — when the database cannot be read', () => {
    expect(() => getNativePastFilings(join(tmpdir(), 'no-such-dir', 'wealthfolio.db'), '2025-10-14')).toThrow(NativeDbUnreadableError);
    expect(() => getNativePastFilings(db(), "2025-10-14' OR 1=1 --")).toThrow(/malformed day/);
  });

  it('rebuilds a CLI line with the note last, a separator inside it kept', () => {
    expect(pastFilingFromCliParts(['cat-gro', 'Groceries', 'A', 'B · TRN-1'])).toEqual({ c0: 'cat-gro', c1: 'Groceries', c2: 'A\x1fB · TRN-1' });
    expect(pastFilingFromCliParts(['too', 'short'])).toBeNull();
  });
});
```

Edit 1 of 1 in `companion/src/uncategorized-status.test.ts` — replace:

```ts
  });
});

describe('uncategorizedWindow', () => {
  it('spans the last 90 days, end-exclusive tomorrow', () => {
    expect(uncategorizedWindow(new Date('2026-08-08T15:30:00Z'))).toEqual({
```

with:

```ts
  });
});

describe('guessed categories', () => {
  const NOW = new Date('2026-10-14T12:00:00Z');
  const filing = (description: string, categoryId = 'cat-gro', categoryName = 'Groceries') => ({ description, categoryId, categoryName });
  const publish = async (rows: ReturnType<typeof native>[], readFilings?: () => ReturnType<typeof filing>[]) => {
    const writes: Record<string, string> = {};
    await publishUncategorizedStatus(async (k, v) => { writes[k] = v; }, () => rows, async () => ({}), NOW, readFilings);
    return JSON.parse(writes['uncategorized_status']);
  };

  it('puts the guess on a row whose merchant you filed the same way twice', async () => {
    const payload = await publish(
      [native('a', { notes: 'KROGER #415 · TRN-a' }), native('b', { notes: 'TARGET 0042 · TRN-b' })],
      () => [filing('KROGER #415'), filing('KROGER #9')],
    );
    expect(payload.rows[0].guess).toEqual({ categoryId: 'cat-gro', name: 'Groceries' });
    expect('guess' in payload.rows[1]).toBe(false);
  });

  it('gives an Amazon row no guess, nor a row that takes an income category', async () => {
    const payload = await publish(
      [native('a', { notes: 'AMAZON.COM*MB3T81 · TRN-a' }), native('b', { notes: 'KROGER #415 · TRN-b', incomeEligible: true })],
      () => [filing('AMAZON.COM*MB3T81'), filing('AMAZON.COM*MB3T81'), filing('KROGER #415'), filing('KROGER #415')],
    );
    expect(payload.rows.map((r: { guess?: unknown }) => r.guess)).toEqual([undefined, undefined]);
  });

  it('a failed read of the filings publishes no guesses at all — never a wrong one — and the status as usual', async () => {
    const payload = await publish([native('a', { notes: 'KROGER #415 · TRN-a' })], () => { throw new Error('database is locked'); });
    expect(payload.count).toBe(1);
    expect(payload.rows[0].description).toBe('KROGER #415');
    expect('guess' in payload.rows[0]).toBe(false);
  });

  it('reads the filings from a year back, through the db-path entry point', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfin-uncategorized-guess-'));
    const dbPath = join(dir, 'wealthfolio.db');
    writeFileSync(dbPath, '');
    try {
      const readFilings = vi.fn(() => [filing('KROGER #415'), filing('KROGER #415')]);
      const writes: Record<string, string> = {};
      await publishUncategorizedStatusForDbPath(
        dbPath, async (k, v) => { writes[k] = v; }, () => [native('a', { notes: 'KROGER #415 · TRN-a' })], async () => ({}), NOW, readFilings,
      );
      expect(readFilings).toHaveBeenCalledWith(dbPath, '2025-10-14');
      expect(JSON.parse(writes['uncategorized_status']).rows[0].guess).toEqual({ categoryId: 'cat-gro', name: 'Groceries' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('uncategorizedWindow', () => {
  it('spans the last 90 days, end-exclusive tomorrow', () => {
    expect(uncategorizedWindow(new Date('2026-08-08T15:30:00Z'))).toEqual({
```

Edit 1 of 3 in `companion/src/index.test.ts` — replace:

```ts
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending, getNativeCategorizedSpending, getNativeSpendingCategories, getNativeTxSearchRows } from './sqlite-native.js';
import { ingestAmazonMail } from './amazon-mail.js';
import { ingestVenmoMail } from './venmo-mail.js';
import { AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, UNCATEGORIZED_STATUS_SECRET_KEY, VENMO_MAIL_SAMPLES_SECRET_KEY } from '../../shared/status-keys.js';
import { CATEGORIZE_ENTRY_CALLBACK, escapeMarkdown } from '../../shared/telegram.js';
import { categoryFiledChange, stampChange } from '../../shared/change-entries.js';
```

with:

```ts
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending, getNativeCategorizedSpending, getNativeSpendingCategories, getNativeTxSearchRows } from './sqlite-native.js';
import { ingestAmazonMail } from './amazon-mail.js';
import { ingestVenmoMail } from './venmo-mail.js';
import { getNativePastFilings } from './sqlite-guess.js';
import { AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, UNCATEGORIZED_STATUS_SECRET_KEY, VENMO_MAIL_SAMPLES_SECRET_KEY } from '../../shared/status-keys.js';
import { CATEGORIZE_ENTRY_CALLBACK, escapeMarkdown } from '../../shared/telegram.js';
import { categoryFiledChange, stampChange } from '../../shared/change-entries.js';
```

Edit 2 of 3 in `companion/src/index.test.ts` — replace:

```ts
  ingestAmazonMail: vi.fn(async () => ({
    scanned: 0, added: 0, unparsed: 0, ignored: 0, pruned: 0, newLabels: [], unparsedSenders: {}, cancelled: 0, samples: [],
  })),
}));

// Venmo's ingest (3) reads the same faked mailbox: a quiet result by default,
```

with:

```ts
  ingestAmazonMail: vi.fn(async () => ({
    scanned: 0, added: 0, unparsed: 0, ignored: 0, pruned: 0, newLabels: [], unparsedSenders: {}, cancelled: 0, samples: [],
  })),
}));

// Guessed categories' strict reader (3): mocked as a module for the same reason
// as sqlite-audit.js — it reads its separator from the sqlite-native mock.
vi.mock('./sqlite-guess.js', () => ({
  getNativePastFilings: vi.fn(() => []),
}));

// Venmo's ingest (3) reads the same faked mailbox: a quiet result by default,
```

Edit 3 of 3 in `companion/src/index.test.ts` — replace:

```ts
    expect(status.rows.map((r: any) => r.description)).toEqual(['BOOK STORES', 'VENMO PAYMENT']);
  });

  it('drills into subcategories and files the child id', async () => {
    const { client } = clientFor();
    const controller = buildCategorizeController(client);
```

with:

```ts
    expect(status.rows.map((r: any) => r.description)).toEqual(['BOOK STORES', 'VENMO PAYMENT']);
  });

  it('republishes each row’s guessed category from the year’s filings', async () => {
    vi.mocked(getNativePastFilings).mockReturnValueOnce([
      { description: 'BOOK STORES', categoryId: 'cat-fun', categoryName: 'Entertainment' },
      { description: 'BOOK STORES', categoryId: 'cat-fun', categoryName: 'Entertainment' },
    ]);
    const { client, secrets } = clientFor();
    await buildCategorizeDeps(client).republish();
    const status = JSON.parse(secrets.get(UNCATEGORIZED_STATUS_SECRET_KEY)!);
    expect(status.rows.map((r: any) => r.guess)).toEqual([{ categoryId: 'cat-fun', name: 'Entertainment' }, undefined]);
  });

  it('drills into subcategories and files the child id', async () => {
    const { client } = clientFor();
    const controller = buildCategorizeController(client);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/sqlite-guess.test.ts src/uncategorized-status.test.ts src/index.test.ts`
Expected: FAIL — `sqlite-guess.test.ts` and `index.test.ts` fail to load (`Cannot find module './sqlite-guess.js'`), and 2 tests fail: `puts the guess on a row whose merchant you filed the same way twice` and `reads the filings from a year back, through the db-path entry point`. The Amazon/income and failed-read tests already pass: nothing publishes a guess yet.

- [ ] **Step 3: Implement**

Edit 1 of 1 in `shared/uncategorized.ts` — replace:

```ts
  /** Which way the money moved. Optional — a status published by an older
   *  companion simply renders unsigned, as it always did. */
  direction?: 'in' | 'out';
}

/**
```

with:

```ts
  /** Which way the money moved. Optional — a status published by an older
   *  companion simply renders unsigned, as it always did. */
  direction?: 'in' | 'out';
  /** The category you filed the same merchant under before (3, L3), shown as a
   *  hint. Optional: an older add-on ignores it, an older companion never
   *  sends it, and a row with no clear history has none. */
  guess?: { categoryId: string; name: string };
}

/**
```

**Create `companion/src/sqlite-guess.ts`:**

```ts
/**
 * companion/src/sqlite-guess.ts
 *
 * The one read behind guessed categories (project 3): every spending filing
 * since a day, as the row's description and its category. Strict like the
 * audits' readers (./sqlite-audit.ts) — it throws NativeDbUnreadableError
 * rather than answering [] — because a failed read must mean "no guesses",
 * never a guess drawn from part of the history.
 *
 * Which filings: the spending taxonomy's assignments whose `source` is
 * `manual` (a person — in Wealthfolio, in Telegram, and the Amazon filer, all
 * of which go through the assign route that writes `manual`) or `rule` (your
 * rules), created on or after the day. `migrated` — older Wealthfolio's own
 * conversion of its categories — is left out. The add-on's own bookkeeping
 * rows are left out by their note markers. The same tables and columns on
 * Wealthfolio 3.8, 3.9 and 3.10.
 *
 * The sqlite3 CLI fallback splits on the unit separator with the note last,
 * newlines made spaces (it prints one row per line).
 */
import type { PastFiling } from '../../shared/category-guess.js';
import { SPENDING_TAXONOMY_ID } from '../../shared/cash-flow-bucket.js';
import { descriptionFromComment } from '../../shared/sync-core.js';
import { DRILL_CLI_SEPARATOR, queryNativeDbStrict } from './sqlite-native.js';

/** A year of filings is far past execFileSync's 1 MB default on the CLI path. */
const GUESS_CLI_MAX_BUFFER = 64 * 1024 * 1024;
const NOTES = `REPLACE(REPLACE(COALESCE(a.notes, ''), char(13), ' '), char(10), ' ')`;

/** CLI line → the three columns (the note last, whatever it holds). */
export function pastFilingFromCliParts(parts: string[]): Record<string, unknown> | null {
  return parts.length >= 3 ? { c0: parts[0], c1: parts[1], c2: parts.slice(2).join(DRILL_CLI_SEPARATOR) } : null;
}

/** Every spending filing made on or after `sinceDay` (YYYY-MM-DD). Throws when
 *  the database cannot be read, or for a malformed day. */
export function getNativePastFilings(dbPath: string, sinceDay: string): PastFiling[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDay)) throw new Error(`Refusing past filings since a malformed day: ${sinceDay}`);
  const query = `
    SELECT ata.category_id AS category_id,
           COALESCE(tc.name, '') AS category_name,
           ${NOTES} AS notes
    FROM activity_taxonomy_assignments ata
    JOIN activities a ON a.id = ata.activity_id
    LEFT JOIN taxonomy_categories tc ON tc.id = ata.category_id AND tc.taxonomy_id = ata.taxonomy_id
    WHERE ata.taxonomy_id = '${SPENDING_TAXONOMY_ID}'
      AND LOWER(COALESCE(ata.source, '')) IN ('manual', 'rule')
      AND substr(COALESCE(ata.created_at, ''), 1, 10) >= '${sinceDay}'
      AND COALESCE(a.notes, '') NOT LIKE 'Starting balance · %'
      AND COALESCE(a.notes, '') NOT LIKE 'Balance adjustment · %'
      AND COALESCE(a.notes, '') NOT LIKE '↔️ In-transit transfer · %';
  `;
  const rows = queryNativeDbStrict<Record<string, unknown>>(
    dbPath, 'past filings', query, pastFilingFromCliParts, DRILL_CLI_SEPARATOR, GUESS_CLI_MAX_BUFFER,
  );
  return rows.map((r) => {
    const v = Object.values(r);
    return {
      categoryId: String(v[0] ?? ''),
      categoryName: String(v[1] ?? ''),
      description: descriptionFromComment(String(v[2] ?? '')),
    };
  });
}
```

Edit 1 of 4 in `companion/src/uncategorized-status.ts` — replace:

```ts
  visibleUncategorized,
} from '../../shared/uncategorized.js';
import { descriptionFromComment } from '../../shared/sync-core.js';

/**
 * Last 90 days, end-exclusive tomorrow — half-open bounds like the
```

with:

```ts
  visibleUncategorized,
} from '../../shared/uncategorized.js';
import { descriptionFromComment } from '../../shared/sync-core.js';
import { buildGuessIndex, guessCategory, guessSinceDay, type GuessIndex, type PastFiling } from '../../shared/category-guess.js';

/**
 * Last 90 days, end-exclusive tomorrow — half-open bounds like the
```

Edit 2 of 4 in `companion/src/uncategorized-status.ts` — replace:

```ts
  accountName: string;
  /** See `UncategorizedRow.direction` — passed through untouched. */
  direction?: 'in' | 'out';
}

/**
```

with:

```ts
  accountName: string;
  /** See `UncategorizedRow.direction` — passed through untouched. */
  direction?: 'in' | 'out';
  /** A row whose filing is an INCOME category gets no guess: a guess is a
   *  spending category, which Wealthfolio refuses on it. */
  incomeEligible?: boolean;
}

/**
```

Edit 3 of 4 in `companion/src/uncategorized-status.ts` — replace:

```ts
  readRows: () => UncategorizedSourceRow[],
  readLedger: () => Promise<DismissalLedger>,
  now: Date = new Date(),
): Promise<void> {
  try {
    const ledger = await readLedger();
    const visible = visibleUncategorized(readRows(), ledger);
    const rows: UncategorizedRow[] = visible.slice(0, UNCATEGORIZED_ROWS_CAP).map((r) => ({
      activityId: r.activityId,
      date: r.date,
      amountCents: r.amountCents,
      // The stored note carries ` · <txId>` and possibly ` · pending`; the
      // addon renders this string, so strip the bookkeeping first. A blank
      // strip result (a legitimately empty SimpleFin description) falls back
      // to the raw note rather than publishing an empty field.
      description: descriptionFromComment(r.notes) || r.notes,
      accountName: r.accountName,
      ...(r.direction ? { direction: r.direction } : {}),
    }));
    const status = {
      // The true total AFTER dismissal filtering — NOT `rows.length`, which is
      // capped below. A truncated list must never make the tile understate
```

with:

```ts
  readRows: () => UncategorizedSourceRow[],
  readLedger: () => Promise<DismissalLedger>,
  now: Date = new Date(),
  /** The year's filings, for each row's guessed category (3). Absent: no
   *  guesses. A read that throws means no guesses at all — never a guess from
   *  part of the history — and the status is published as usual. */
  readFilings?: () => PastFiling[],
): Promise<void> {
  try {
    const ledger = await readLedger();
    const visible = visibleUncategorized(readRows(), ledger);
    let guesses: GuessIndex | null = null;
    try {
      guesses = readFilings ? buildGuessIndex(readFilings()) : null;
    } catch {
      guesses = null;
    }
    const rows: UncategorizedRow[] = visible.slice(0, UNCATEGORIZED_ROWS_CAP).map((r) => {
      // The stored note carries ` · <txId>` and possibly ` · pending`; the
      // addon renders this string, so strip the bookkeeping first. A blank
      // strip result (a legitimately empty SimpleFin description) falls back
      // to the raw note rather than publishing an empty field.
      const description = descriptionFromComment(r.notes) || r.notes;
      const guess = guesses && !r.incomeEligible ? guessCategory(guesses, description) : null;
      return {
        activityId: r.activityId,
        date: r.date,
        amountCents: r.amountCents,
        description,
        accountName: r.accountName,
        ...(r.direction ? { direction: r.direction } : {}),
        ...(guess ? { guess: { categoryId: guess.categoryId, name: guess.name } } : {}),
      };
    });
    const status = {
      // The true total AFTER dismissal filtering — NOT `rows.length`, which is
      // capped below. A truncated list must never make the tile understate
```

Edit 4 of 4 in `companion/src/uncategorized-status.ts` — replace:

```ts
  ) => UncategorizedSourceRow[],
  readLedger: () => Promise<DismissalLedger>,
  now: Date = new Date(),
): Promise<void> {
  if (!dbPath || !existsSync(dbPath)) return;
  const { start, end } = uncategorizedWindow(now);
  await publishUncategorizedStatus(setSecret, () => readRows(dbPath, start, end), readLedger, now);
}
```

with:

```ts
  ) => UncategorizedSourceRow[],
  readLedger: () => Promise<DismissalLedger>,
  now: Date = new Date(),
  /** `getNativePastFilings`, read from `guessSinceDay(now)`. Absent: no guesses. */
  readFilings?: (dbPath: string, sinceDay: string) => PastFiling[],
): Promise<void> {
  if (!dbPath || !existsSync(dbPath)) return;
  const { start, end } = uncategorizedWindow(now);
  await publishUncategorizedStatus(
    setSecret, () => readRows(dbPath, start, end), readLedger, now,
    readFilings ? () => readFilings(dbPath, guessSinceDay(now)) : undefined,
  );
}
```

Edit 1 of 3 in `companion/src/index.ts` — replace:

```ts
import { SIMPLEFIN_SYNC_VERSION, COMPANION_VERSION_SECRET_KEY, INSTALLED_ADDON_VERSION_SECRET_KEY, isNewerVersion } from '../../shared/version.js';
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending, getNativeRuleCategorizedAmazonRows, getNativeCategorizedSpending, getNativeSpendingCategories, getNativeCategoryCatalog, getNativeSubcategorySpending, getNativeUncategorizedSpendingTotal, countRulePatternMatches, getNativeSpendMatrix, getNativeIncomeByMonthAccount, getNativeUncategorizedByMonthAccount, getNativeMerchantRows, getNativeDrillRows, getNativeFeesInterestByMonth, getNativeSpendDailyTotals, getNativeValuationByMonth, getNativeIncomeCategories } from './sqlite-native.js';
import { publishUncategorizedStatusForDbPath } from './uncategorized-status.js';
import { createCategorizeController, SPENDING_TAXONOMY_ID } from './categorize.js';
import { createAmazonLabelMenu, type AmazonLabelMenu } from './amazon-labels.js';
import { fileAmazonCharges } from './amazon-filing.js';
```

with:

```ts
import { SIMPLEFIN_SYNC_VERSION, COMPANION_VERSION_SECRET_KEY, INSTALLED_ADDON_VERSION_SECRET_KEY, isNewerVersion } from '../../shared/version.js';
import { getNativeWealthfolioSpending, getNativeWealthfolioSpendingBetween, getNativeWealthfolioBudgets, getNativeWealthfolioTopSpending, getNativeUncategorizedSpending, getNativeRuleCategorizedAmazonRows, getNativeCategorizedSpending, getNativeSpendingCategories, getNativeCategoryCatalog, getNativeSubcategorySpending, getNativeUncategorizedSpendingTotal, countRulePatternMatches, getNativeSpendMatrix, getNativeIncomeByMonthAccount, getNativeUncategorizedByMonthAccount, getNativeMerchantRows, getNativeDrillRows, getNativeFeesInterestByMonth, getNativeSpendDailyTotals, getNativeValuationByMonth, getNativeIncomeCategories } from './sqlite-native.js';
import { publishUncategorizedStatusForDbPath } from './uncategorized-status.js';
import { getNativePastFilings } from './sqlite-guess.js';
import { createCategorizeController, SPENDING_TAXONOMY_ID } from './categorize.js';
import { createAmazonLabelMenu, type AmazonLabelMenu } from './amazon-labels.js';
import { fileAmazonCharges } from './amazon-filing.js';
```

Edit 2 of 3 in `companion/src/index.ts` — replace:

```ts
        await wfClient.getAddonSecret('simplefin-sync', 'uncategorized_dismissals'),
        'uncategorized_dismissals',
      ) ?? {},
    );

    // The Overview tile's copy of the semester pool. Republished every sync,
```

with:

```ts
        await wfClient.getAddonSecret('simplefin-sync', 'uncategorized_dismissals'),
        'uncategorized_dismissals',
      ) ?? {},
      new Date(),
      // Each row's guessed category (3): how you filed the same merchant before.
      getNativePastFilings,
    );

    // The Overview tile's copy of the semester pool. Republished every sync,
```

Edit 3 of 3 in `companion/src/index.ts` — replace:

```ts
          (key, value) => wfClient.setAddonSecret('simplefin-sync', key, value),
          (dbPath, start, end) => getNativeUncategorizedSpending(dbPath, start, end),
          readLedger,
        );
      } catch (err) {
        log(`Categorize menu: republishing the uncategorized status failed: ${formatError(err)}`);
```

with:

```ts
          (key, value) => wfClient.setAddonSecret('simplefin-sync', key, value),
          (dbPath, start, end) => getNativeUncategorizedSpending(dbPath, start, end),
          readLedger,
          new Date(),
          getNativePastFilings,
        );
      } catch (err) {
        log(`Categorize menu: republishing the uncategorized status failed: ${formatError(err)}`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run src/sqlite-guess.test.ts src/uncategorized-status.test.ts src/index.test.ts`
Expected: PASS — 312 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/uncategorized.ts companion/src/sqlite-guess.ts companion/src/sqlite-guess.test.ts companion/src/uncategorized-status.ts companion/src/uncategorized-status.test.ts companion/src/index.ts companion/src/index.test.ts
git commit -m "Companion: publish each needs-a-category row's guessed category; a failed read publishes none

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `/categorize` offers the guess first — one tap files it

The Telegram side of the guess (spec B "Telegram"; L4; Z3). `CategorizeTxn.guess` carries `{ categoryId, name, count }`; the list shows ` · probably <category>` after the row; the transaction screen's FIRST row is `✓ <category> (like the last <n>)`, whose action is the very `assign` the grid's own button makes — so it files, logs `category-filed` as `you`, offers Undo and the rule exactly as before. It is offered only in categorize mode, only on the spending grid, only for a category the tree still has. The controller reads the year's filings through the optional `readFilings` dep on every load; a read that throws is logged and costs only the guesses. No new callback prefix: the button is index `0` of `cz:<generation>:<index>`.

**Files:**
- Modify: `shared/categorize-menu.ts`, `companion/src/categorize.ts`, `companion/src/index.ts`
- Test: `shared/categorize-menu.test.ts`, `companion/src/categorize.test.ts`, `companion/src/index.test.ts`

**Interfaces:**
- Consumes: Task 6 (`buildGuessIndex`, `guessCategory`, `guessSinceDay`, `PastFiling`, `GuessIndex`); Task 7 (`getNativePastFilings`).
- Produces:

```ts
// shared/categorize-menu.ts — CategorizeTxn
guess?: { categoryId: string; name: string; count: number };
// companion/src/categorize.ts — CategorizeDeps
readFilings?: (dbPath: string, sinceDay: string) => PastFiling[];
```

Log line: `Categorize menu: could not read past filings, so no guesses: <error>`.

- [ ] **Step 1: Write the failing tests**

Edit 1 of 1 in `shared/categorize-menu.test.ts` — replace:

```ts
    expect(renderScreen(none).text).not.toContain('Right now that also files');
  });
});
```

with:

```ts
    expect(renderScreen(none).text).not.toContain('Right now that also files');
  });
});

describe('guessed categories (3)', () => {
  const GUESSED = txn({ guess: { categoryId: 'cat-groceries', name: 'Groceries', count: 3 } });

  it('the list shows the guess beside each row that has one', () => {
    const s = session({ txns: [GUESSED, txn({ activityId: 'act-2', description: 'NO HISTORY' })] });
    expect(renderScreen(s).keyboard.inline_keyboard.flat().map((b) => b.text).slice(0, 2)).toEqual([
      'Aug 8 · BOOK STORES · -$10 · probably Groceries',
      'Aug 8 · NO HISTORY · -$10',
    ]);
  });

  it('the transaction screen offers the guess first; its tap is the same assign the grid makes', () => {
    const s = session({ txns: [GUESSED], screen: { kind: 'txn', activityId: 'act-1' } });
    const { keyboard, buttons } = renderScreen(s);
    expect(keyboard.inline_keyboard[0]).toEqual([{ text: '✓ Groceries (like the last 3)', callback_data: `${MENU_CALLBACK_PREFIX}7:0` }]);
    expect(buttons[0]).toEqual({ kind: 'assign', activityId: 'act-1', categoryId: 'cat-groceries' });
    const grid = keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Groceries');
    expect(buttons[grid]).toEqual(buttons[0]);
  });

  it('offers no guess for a category the tree no longer has, on the income grid, or when recategorizing', () => {
    const gone = txn({ guess: { categoryId: 'cat-deleted', name: 'Old', count: 2 } });
    const first = (s: MenuSession) => renderScreen(s).keyboard.inline_keyboard[0][0].text;
    expect(first(session({ txns: [gone], screen: { kind: 'txn', activityId: 'act-1' } }))).toBe('Groceries');
    const income = txn({ direction: 'in', incomeEligible: true, guess: { categoryId: 'cat-groceries', name: 'Groceries', count: 2 } });
    const incomeCats: SpendingCategory[] = [{ id: 'inc-sal', name: 'Salary & Wages', parentId: null, parentName: null }];
    expect(first(session({ txns: [income], incomeCategories: incomeCats, screen: { kind: 'txn', activityId: 'act-1' } }))).toBe('Salary & Wages');
    const recat = session({ mode: 'recategorize', txns: [GUESSED], screen: { kind: 'txn', activityId: 'act-1' } });
    expect(first(recat)).toBe('Groceries');
    expect(renderScreen({ ...recat, screen: { kind: 'list', page: 0 } }).keyboard.inline_keyboard[0][0].text).not.toContain('probably');
  });

  it('escapes a Venmo note full of Markdown in the text and keeps it raw on the buttons', () => {
    const noted = txn({ description: 'VENMO PAYMENT 1023 · Venmo: *Rent* _Oct_ [2]', accountName: 'J_D Checking', guess: { categoryId: 'cat-groceries', name: 'Groceries', count: 2 } });
    const { text } = renderScreen(session({ txns: [noted], screen: { kind: 'txn', activityId: 'act-1' } }));
    expect(text.split('\n')[0]).toBe('VENMO PAYMENT 1023 · Venmo: \\*Rent\\* \\_Oct\\_ \\[2]');
    expect(text).toContain('J\\_D Checking');
    expect(renderScreen(session({ txns: [noted] })).keyboard.inline_keyboard[0][0].text)
      .toBe('Aug 8 · VENMO PAYMENT 1023 · Venmo: *Rent* _Oct_ [2] · -$10 · probably Groceries');
  });

  it('keeps every callback within 64 bytes with the guess at the widest generation — the longest is 15', () => {
    const s = session({ txns: [GUESSED], generation: 4294967295, screen: { kind: 'txn', activityId: 'act-1' } });
    const { keyboard } = renderScreen(s);
    assertCallbackBytesFit(keyboard);
    expect(Math.max(...keyboard.inline_keyboard.flat().map((b) => new TextEncoder().encode(b.callback_data).length))).toBe(15);
  });
});
```

Edit 1 of 1 in `companion/src/categorize.test.ts` — replace:

```ts
  it('is not offered when nothing can tell the story', async () => {
    const picker = await openAtTxn(setup());
    expect(labels(picker)).not.toContain('🔎 Why?');
  });
});

```

with:

```ts
  it('is not offered when nothing can tell the story', async () => {
    const picker = await openAtTxn(setup());
    expect(labels(picker)).not.toContain('🔎 Why?');
  });
});

describe('guessed categories (3)', () => {
  /** Two past filings of `BOOK STORES a` under Entertainment: a guess. */
  const withFilings = (h: ReturnType<typeof setup>, readFilings: CategorizeDeps['readFilings']) => {
    const controller = createCategorizeController({ ...h.deps, readFilings });
    const tap = (data: string) => controller.onCallback({ data, chatId: CHAT, messageId: 55 }, h.ui);
    return { controller, tap };
  };
  const FILINGS = () => [
    { description: 'BOOK STORES a', categoryId: 'cat-fun', categoryName: 'Entertainment' },
    { description: 'BOOK STORES a', categoryId: 'cat-fun', categoryName: 'Entertainment' },
  ];

  it('reads the year’s filings and shows the guess beside the row', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    const h = setup();
    const readFilings = vi.fn(FILINGS);
    const { controller } = withFilings(h, readFilings);
    await controller.open(h.send);
    expect(readFilings).toHaveBeenCalledWith(DB, '2025-10-14');
    expect(labels(keyboardOf(lastCall(h.send))).slice(0, 2)).toEqual([
      'Aug 8 · BOOK STORES a · -$12 · probably Entertainment',
      'Aug 8 · BOOK STORES b · -$12',
    ]);
  });

  it('files the guess with one tap — logged as yours, with Undo and the rule offer as usual', async () => {
    const h = setup();
    const recorded: any[] = [];
    (h.deps as any).record = (d: unknown) => recorded.push(d);
    const { controller, tap } = withFilings(h, FILINGS);
    await controller.open(h.send);
    await tap(dataFor(keyboardOf(lastCall(h.send)), 'BOOK STORES a'));
    const picker = keyboardOf(lastCall(h.ui.edit));
    expect(labels(picker)[0]).toBe('✓ Entertainment (like the last 2)');
    await tap(dataFor(picker, '✓ Entertainment'));
    expect(h.deps.assign).toHaveBeenCalledWith('a', 'cat-fun');
    const filed = lastCall(h.ui.edit);
    expect(filed[0]).toBe('Filed BOOK STORES a → Entertainment.');
    expect(labels(keyboardOf(filed))).toEqual(expect.arrayContaining(['↩ Undo', 'Make this a rule']));
    expect(recorded).toEqual([expect.objectContaining({ kind: 'category-filed', actor: 'you', summary: 'Filed BOOK STORES a under Entertainment' })]);
    await tap(dataFor(keyboardOf(filed), '↩ Undo'));
    expect(h.deps.unassign).toHaveBeenCalledWith('a');
    expect(lastCall(h.ui.edit)[0]).toBe('Filing undone — BOOK STORES a is uncategorized again.');
  });

  it('a failed read of the filings shows no guesses, and the menu still works', async () => {
    const h = setup();
    const { controller, tap } = withFilings(h, () => { throw new Error('database is locked'); });
    await controller.open(h.send);
    expect(labels(keyboardOf(lastCall(h.send))).join('\n')).not.toContain('probably');
    await tap(dataFor(keyboardOf(lastCall(h.send)), 'BOOK STORES a'));
    expect(labels(keyboardOf(lastCall(h.ui.edit)))[0]).not.toMatch(/^✓/);
    expect(h.logs.join('\n')).toContain('could not read past filings, so no guesses: database is locked');
  });
});

```

Edit 1 of 1 in `companion/src/index.test.ts` — replace:

```ts
    expect(status.rows.map((r: any) => r.guess)).toEqual([{ categoryId: 'cat-fun', name: 'Entertainment' }, undefined]);
  });

  it('drills into subcategories and files the child id', async () => {
    const { client } = clientFor();
    const controller = buildCategorizeController(client);
```

with:

```ts
    expect(status.rows.map((r: any) => r.guess)).toEqual([{ categoryId: 'cat-fun', name: 'Entertainment' }, undefined]);
  });

  it('/categorize shows each row’s guess, read from the year’s filings', async () => {
    vi.mocked(getNativePastFilings).mockReturnValueOnce([
      { description: 'BOOK STORES', categoryId: 'cat-fun', categoryName: 'Entertainment' },
      { description: 'BOOK STORES', categoryId: 'cat-fun', categoryName: 'Entertainment' },
    ]);
    const { client } = clientFor();
    const { sent, reply } = collect();
    await buildTelegramCommandHandler(client)({ command: 'categorize', args: '' }, reply);
    expect(labels(sent[0][1]).slice(0, 2)).toEqual(['Aug 8 · BOOK STORES · $12 · probably Entertainment', 'Aug 8 · VENMO PAYMENT · $12']);
  });

  it('drills into subcategories and files the child id', async () => {
    const { client } = clientFor();
    const controller = buildCategorizeController(client);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/categorize-menu.test.ts`
Expected: FAIL — 3 tests: `the list shows the guess beside each row that has one`, `the transaction screen offers the guess first; its tap is the same assign the grid makes`, `escapes a Venmo note full of Markdown in the text and keeps it raw on the buttons`.

Run: `cd companion && npx vitest run src/categorize.test.ts src/index.test.ts`
Expected: FAIL — 4 tests: `reads the year’s filings and shows the guess beside the row`, `files the guess with one tap — logged as yours, with Undo and the rule offer as usual`, `a failed read of the filings shows no guesses, and the menu still works` (no log line yet), `/categorize shows each row’s guess, read from the year’s filings`.

- [ ] **Step 3: Implement**

Edit 1 of 4 in `shared/categorize-menu.ts` — replace:

```ts
   *  assignment that happened to be shown while silently dropping the rest —
   *  see `refiled.restore`, which carries all of them. */
  currentCategory?: { taxonomyId: string; categoryId: string; name: string };
}

/** One taxonomy's assignment, as the ids a write needs and nothing else. No
```

with:

```ts
   *  assignment that happened to be shown while silently dropping the rest —
   *  see `refiled.restore`, which carries all of them. */
  currentCategory?: { taxonomyId: string; categoryId: string; name: string };
  /** The category you filed the same merchant under before (3, L3), and how
   *  many of those filings chose it. Categorize mode only. Shown beside the row
   *  on the list and as the transaction screen's first button — one tap files
   *  it, exactly as picking it from the grid would. Never filed on its own. */
  guess?: { categoryId: string; name: string; count: number };
}

/** One taxonomy's assignment, as the ids a write needs and nothing else. No
```

Edit 2 of 4 in `shared/categorize-menu.ts` — replace:

```ts
    // "categorized as what" without a tap — label only, never Markdown-parsed
    // (see `layout`'s doc comment), so the raw name is fine unescaped here.
    const currentSuffix = mode === 'recategorize' && t.currentCategory ? ` · ${t.currentCategory.name}` : '';
    return [{
      // moneyWhole takes DOLLARS, so cents are divided down first. Both native
      // readers ABS() the amount before it ever reaches this module, so the
      // sign comes from `direction`, not the figure — and stays absent for a
      // row whose direction an older controller never supplied.
      text: `${shortDate(t.date)} · ${t.description} · ${signedWhole(t)}${currentSuffix}`,
      action: { kind: 'goto', screen: { kind: 'txn', activityId: t.activityId } },
    }];
  });
```

with:

```ts
    // "categorized as what" without a tap — label only, never Markdown-parsed
    // (see `layout`'s doc comment), so the raw name is fine unescaped here.
    const currentSuffix = mode === 'recategorize' && t.currentCategory ? ` · ${t.currentCategory.name}` : '';
    // The guess (3), beside the row — a hint only; the tap still opens the row.
    const guessSuffix = mode !== 'recategorize' && t.guess ? ` · probably ${t.guess.name}` : '';
    return [{
      // moneyWhole takes DOLLARS, so cents are divided down first. Both native
      // readers ABS() the amount before it ever reaches this module, so the
      // sign comes from `direction`, not the figure — and stays absent for a
      // row whose direction an older controller never supplied.
      text: `${shortDate(t.date)} · ${t.description} · ${signedWhole(t)}${currentSuffix}${guessSuffix}`,
      action: { kind: 'goto', screen: { kind: 'txn', activityId: t.activityId } },
    }];
  });
```

Edit 3 of 4 in `shared/categorize-menu.ts` — replace:

```ts
      return { text: c.name, action };
    });

  const switchRows: Btn[][] = useIncomeGrid
    ? [[{ text: 'Spending categories »', action: { kind: 'goto', screen: { kind: 'txn', activityId, showSpending: true } } }]]
    : incomeGridAvailable
```

with:

```ts
      return { text: c.name, action };
    });

  // The guess (3) comes first, as one tap — the same `assign` the grid's own
  // button makes, so it files, logs and offers Undo and the rule identically.
  // Only on the spending grid (a guess is a spending category) and only for a
  // category the tree still has.
  const guessed = !isRecategorize && !useIncomeGrid && txn.guess ? findCategory(session, txn.guess.categoryId) : undefined;
  const guessRows: Btn[][] = guessed && txn.guess
    ? [[{ text: `✓ ${guessed.name} (like the last ${txn.guess.count})`, action: { kind: 'assign', activityId, categoryId: guessed.id } }]]
    : [];

  const switchRows: Btn[][] = useIncomeGrid
    ? [[{ text: 'Spending categories »', action: { kind: 'goto', screen: { kind: 'txn', activityId, showSpending: true } } }]]
    : incomeGridAvailable
```

Edit 4 of 4 in `shared/categorize-menu.ts` — replace:

```ts
      : [];

  const rows: Btn[][] = [
    ...pairUp(catButtons),
    ...switchRows,
    // "Keep uncategorized" only makes sense before a first filing — a
```

with:

```ts
      : [];

  const rows: Btn[][] = [
    ...guessRows,
    ...pairUp(catButtons),
    ...switchRows,
    // "Keep uncategorized" only makes sense before a first filing — a
```

Edit 1 of 3 in `companion/src/categorize.ts` — replace:

```ts
import { visibleUncategorized, type DismissalLedger } from '../../shared/uncategorized.js';
import { descriptionFromComment, txIdFromComment } from '../../shared/sync-core.js';
import { categoryFiledChange, categoryRuleCreatedChange, type ChangeDraft, type FiledCategory } from '../../shared/change-entries.js';
import { uncategorizedWindow } from './uncategorized-status.js';

/**
```

with:

```ts
import { visibleUncategorized, type DismissalLedger } from '../../shared/uncategorized.js';
import { descriptionFromComment, txIdFromComment } from '../../shared/sync-core.js';
import { categoryFiledChange, categoryRuleCreatedChange, type ChangeDraft, type FiledCategory } from '../../shared/change-entries.js';
import { buildGuessIndex, guessCategory, guessSinceDay, type GuessIndex, type PastFiling } from '../../shared/category-guess.js';
import { uncategorizedWindow } from './uncategorized-status.js';

/**
```

Edit 2 of 3 in `companion/src/categorize.ts` — replace:

```ts
   *  first filings. OPTIONAL: absent (older callers, most tests) means those
   *  rows keep the spending grid they always had. */
  readIncomeCategories?: (dbPath: string) => SpendingCategory[];
  readLedger: () => Promise<DismissalLedger>;
  /**
   * Persists a dismissal delta. `base` is the ledger THIS controller read a
```

with:

```ts
   *  first filings. OPTIONAL: absent (older callers, most tests) means those
   *  rows keep the spending grid they always had. */
  readIncomeCategories?: (dbPath: string) => SpendingCategory[];
  /** `getNativePastFilings` (./sqlite-guess.ts): the year's spending filings,
   *  each row's guessed category (3). OPTIONAL: absent means no guesses; a read
   *  that throws means no guesses this render, never a wrong one. */
  readFilings?: (dbPath: string, sinceDay: string) => PastFiling[];
  readLedger: () => Promise<DismissalLedger>;
  /**
   * Persists a dismissal delta. `base` is the ledger THIS controller read a
```

Edit 3 of 3 in `companion/src/categorize.ts` — replace:

```ts
      try {
        incomeCategories = deps.readIncomeCategories?.(path) ?? [];
      } catch { /* the spending grid still works */ }
      return {
        ok: true,
        // ONE definition of "needs a category", shared with the status tile and
        // the addon: the native rows minus whatever the ledger dismissed.
        fresh: {
          txns: visibleUncategorized(rows, ledger).map(toTxn),
          categories,
          incomeCategories,
          ledger,
```

with:

```ts
      try {
        incomeCategories = deps.readIncomeCategories?.(path) ?? [];
      } catch { /* the spending grid still works */ }
      // Guessed categories (3): one read of the year's filings. A failed read
      // costs the guesses, never the menu — and never offers a wrong one.
      let guesses: GuessIndex | null = null;
      try {
        guesses = deps.readFilings ? buildGuessIndex(deps.readFilings(path, guessSinceDay(new Date()))) : null;
      } catch (err) {
        safeLog(`Categorize menu: could not read past filings, so no guesses: ${formatError(err)}`);
      }
      const withGuess = (t: CategorizeTxn): CategorizeTxn => {
        // A money-in row that takes an income category gets none: a guess is a
        // spending category, which Wealthfolio refuses on it.
        const guess = guesses && !t.incomeEligible ? guessCategory(guesses, t.description) : null;
        return guess ? { ...t, guess } : t;
      };
      return {
        ok: true,
        // ONE definition of "needs a category", shared with the status tile and
        // the addon: the native rows minus whatever the ledger dismissed.
        fresh: {
          txns: visibleUncategorized(rows, ledger).map(toTxn).map(withGuess),
          categories,
          incomeCategories,
          ledger,
```

Edit 1 of 1 in `companion/src/index.ts` — replace:

```ts
    // The income taxonomy, for money-in rows' first filings (a grant check is
    // not spending, and upstream refuses a spending category on it).
    readIncomeCategories: getNativeIncomeCategories,
    // 1.61: the transaction screen's 🔎 Why? — the story as a new message.
    why: (activityId, send) => buildWhyMenu(wfClient).sendStory(activityId, send),
    readLedger,
```

with:

```ts
    // The income taxonomy, for money-in rows' first filings (a grant check is
    // not spending, and upstream refuses a spending category on it).
    readIncomeCategories: getNativeIncomeCategories,
    // Each row's guessed category (3): how you filed the same merchant before.
    readFilings: getNativePastFilings,
    // 1.61: the transaction screen's 🔎 Why? — the story as a new message.
    why: (activityId, send) => buildWhyMenu(wfClient).sendStory(activityId, send),
    readLedger,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/categorize-menu.test.ts`
Expected: PASS — 113 tests.

Run: `cd companion && npx vitest run src/categorize.test.ts src/index.test.ts`
Expected: PASS — 426 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/categorize-menu.ts shared/categorize-menu.test.ts companion/src/categorize.ts companion/src/categorize.test.ts companion/src/index.ts companion/src/index.test.ts
git commit -m "Telegram: /categorize offers the guess first — one tap files it, beside each row on the list

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The app shows "Probably <category>" under a guessed row

The app side of the guess (spec B "App"; L4). The needs-a-category list renders a published row's guess as a muted line, `Probably <category>`, under the description — inside the row's story button when it has one. A hint only: the app cannot file until R2. A row without a guess (what an older companion publishes) or with one this build cannot read shows nothing; the add-on's status reader already passes the optional field through unchanged, which is pinned so an older add-on is known to read the new status as before. One new class, `.sfin-uncat-guess`. No emoji.

**Files:**
- Modify: `src/components/UncategorizedList.tsx`, `src/components/ui.tsx`
- Test: `src/components/UncategorizedList.test.tsx`, `src/utils/secrets.test.ts`

**Interfaces:**
- Consumes: Task 7 (`UncategorizedRow.guess`).
- Produces: nothing for later tasks.

- [ ] **Step 1: Write the failing tests**

Edit 1 of 1 in `src/components/UncategorizedList.test.tsx` — replace:

```tsx
    clearSpy.mockRestore();
  });
});
```

with:

```tsx
    clearSpy.mockRestore();
  });
});

describe('UncategorizedList — the guessed category (3)', () => {
  const EMOJI = /\p{Extended_Pictographic}/u;
  const guessed = row({ guess: { categoryId: 'cat-gro', name: 'Groceries' } });

  it('shows the guess as a muted line under the description, with no emoji', () => {
    const { container } = render(<UncategorizedList {...base} rows={[guessed]} />);
    const hint = screen.getByText('Probably Groceries');
    expect(hint.className).toBe('sfin-uncat-guess');
    expect(hint.closest('.sfin-uncat-what')).not.toBeNull();
    expect(EMOJI.test(container.textContent ?? '')).toBe(false);
  });

  it('shows it inside a row that opens its story too', () => {
    render(<UncategorizedList {...base} rows={[guessed]} renderStory={() => <div>story</div>} />);
    expect(screen.getByRole('button', { name: /^Thankyou Points Redeemed/ }).textContent).toContain('Probably Groceries');
  });

  it('shows nothing for a row with no guess — what an older companion publishes — or one it cannot read', () => {
    render(<UncategorizedList {...base} rows={[row(), row({ activityId: 'b', guess: { categoryId: 'x' } as any })]} total={2} />);
    expect(screen.queryByText(/Probably/)).toBeNull();
  });
});
```

Edit 1 of 1 in `src/utils/secrets.test.ts` — replace:

```ts
    expect(await s.getUncategorizedStatus()).toEqual({ count: 4, asOf: '2026-08-08', rows: [] });
    await s.clearAll();
    expect(await s.getUncategorizedStatus()).toBeNull();
  });

  it('clearAll deletes the Amazon mailbox config, ledger and label catalog too', async () => {
```

with:

```ts
    expect(await s.getUncategorizedStatus()).toEqual({ count: 4, asOf: '2026-08-08', rows: [] });
    await s.clearAll();
    expect(await s.getUncategorizedStatus()).toBeNull();
  });

  it('reads a published row with a guess as before — the optional field rides along, nothing else changes', async () => {
    const ctx = makeCtx();
    const row = { activityId: 'a', date: '2026-10-04', amountCents: 2500, description: 'KROGER #415', accountName: 'Checking', direction: 'out' };
    const guessed = { ...row, activityId: 'b', guess: { categoryId: 'cat-gro', name: 'Groceries' } };
    await ctx.api.secrets.set(UNCATEGORIZED_STATUS_SECRET_KEY, JSON.stringify({ count: 2, asOf: '2026-10-14', rows: [row, guessed] }));
    expect(await new SecretsStore(ctx).getUncategorizedStatus()).toEqual({ count: 2, asOf: '2026-10-14', rows: [row, guessed] });
  });

  it('clearAll deletes the Amazon mailbox config, ledger and label catalog too', async () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/UncategorizedList.test.tsx src/utils/secrets.test.ts`
Expected: FAIL — 2 tests: `shows the guess as a muted line under the description, with no emoji` and `shows it inside a row that opens its story too`. The no-guess test and the secrets test already pass — the reader is unchanged, which is the point.

- [ ] **Step 3: Implement**

Edit 1 of 2 in `src/components/UncategorizedList.tsx` — replace:

```tsx
function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    .format(cents / 100);
}

/**
```

with:

```tsx
function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    .format(cents / 100);
}

/** The category the companion guessed (3), as a muted line under the
 *  description — a hint only: the app cannot file (R2). Nothing for a row
 *  without one, or a guess this build cannot read. */
function GuessHint({ row }: { row: UncategorizedRow }) {
  const name = row.guess && typeof row.guess.name === 'string' ? row.guess.name : '';
  return name ? <span className="sfin-uncat-guess">Probably {name}</span> : null;
}

/**
```

Edit 2 of 2 in `src/components/UncategorizedList.tsx` — replace:

```tsx
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
```

with:

```tsx
              >
                {r.description}
                <span className="sfin-subtle"> · {r.accountName}</span>
                <GuessHint row={r} />
              </button>
            ) : (
              <span className="sfin-uncat-what">
                {r.description}
                <span className="sfin-subtle"> · {r.accountName}</span>
                <GuessHint row={r} />
              </span>
            )}
            <span className={`sfin-uncat-amt${r.direction ? ` sfin-amt--${r.direction}` : ''}`}>
```

Edit 1 of 1 in `src/components/ui.tsx` — replace:

```tsx
.sfin-uncat-row:first-of-type { border-top: none; }
.sfin-uncat-when { flex: none; font-size: var(--sfin-sz-xs); color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.sfin-uncat-what { flex: 1; min-width: 0; font-size: var(--sfin-sz-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sfin-uncat-amt { flex: none; font-size: var(--sfin-sz-sm); font-weight: 600; font-variant-numeric: tabular-nums; }
.sfin-amt--in { color: var(--sfin-ok); }
.sfin-amt--out { color: var(--sfin-bad); }
```

with:

```tsx
.sfin-uncat-row:first-of-type { border-top: none; }
.sfin-uncat-when { flex: none; font-size: var(--sfin-sz-xs); color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.sfin-uncat-what { flex: 1; min-width: 0; font-size: var(--sfin-sz-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The companion's guessed category (3): its own muted line under the description. */
.sfin-uncat-guess { display: block; font-size: var(--sfin-sz-xs); color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; }
.sfin-uncat-amt { flex: none; font-size: var(--sfin-sz-sm); font-weight: 600; font-variant-numeric: tabular-nums; }
.sfin-amt--in { color: var(--sfin-ok); }
.sfin-amt--out { color: var(--sfin-bad); }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/UncategorizedList.test.tsx src/utils/secrets.test.ts src/components/theme-styles.test.ts src/pages/copy-policy.test.tsx`
Expected: PASS — 71 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/UncategorizedList.tsx src/components/UncategorizedList.test.tsx src/components/ui.tsx src/utils/secrets.test.ts
git commit -m "App: the needs-a-category list shows \"Probably <category>\" under a row the companion guessed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Rules for one account — the toggle, `/newrule … in <account>`, the log and Redo

Account-scoped category rules (spec C; L5; D "a refused scoped rule"; Z1d). The row's Wealthfolio account id rides from the native reader through `CategorizeSourceRow.wfAccountId` to `CategorizeTxn.accountId`. The filing's rule preview gains one row, `✓ All accounts` | `Only <account>` (ticked the other way when scoped), whose taps re-render the preview in that scope; scoped, the copy names the account, the count counts only its rows, and `Create rule` carries `{ id, name }`. The controller passes `accountId` to `deps.createRule`; the client sends `isGlobal: false` with it and, for a global rule, no `accountId` key (upstream refuses one, Z1d). The change entry names the account (`account`, `after.accountId`, "in <account>" in the summary) and its Redo re-creates the rule for that account; Undo is unchanged. `/newrule … in <account>` resolves the account among the non-archived ones and opens the preview scoped; an unclear name gets "Which account? …", none gets the list of accounts. A refused rule says so and records nothing, as before.

**Files:**
- Modify: `shared/categorize-menu.ts`, `shared/change-entries.ts`, `shared/change-undo.ts`, `shared/change-undo-run.ts`, `companion/src/categorize.ts`, `companion/src/wealthfolio.ts`, `companion/src/index.ts`
- Test: `shared/categorize-menu.test.ts`, `shared/change-entries.test.ts`, `shared/change-undo.test.ts`, `companion/src/categorize.test.ts`, `companion/src/wealthfolio.test.ts`, `companion/src/index.test.ts`

**Interfaces:**
- Consumes: Task 8 (`CategorizeTxn`, the menu's screens and actions).
- Produces:

```ts
// shared/categorize-menu.ts
export interface RuleAccount { id: string; name: string }
// CategorizeTxn.accountId?: string
// MenuScreen: rulePreview { …, onlyAccount?: boolean }; freeRulePreview { …, account?: RuleAccount; onlyAccount?: boolean }; ruleCreated { …, accountName?: string }
// MenuAction: createRule { …, account?: RuleAccount }; createFreeRule { …, account?: RuleAccount }
export function parseNewRuleArgs(args: string): { pattern: string; categoryQuery: string; accountQuery?: string } | null;
export function resolveAccountQuery(accounts: readonly RuleAccount[], query: string):
  { kind: 'one'; account: RuleAccount } | { kind: 'many'; accounts: RuleAccount[] } | { kind: 'none' };
export const NEWRULE_ACCOUNTS_UNREADABLE: string;
export function formatAccountQueryMiss(result: { kind: 'many'; accounts: RuleAccount[] } | { kind: 'none' }, query: string, all: readonly RuleAccount[]): string;
// shared/change-entries.ts — CategoryRuleFacts.account?: { wfId: string; name: string }
// shared/change-undo.ts — UndoStep create-rule: rule.accountId?; shared/change-undo-run.ts — UndoIo.rules.create(rule with accountId?)
// companion/src/categorize.ts — CategorizeSourceRow.wfAccountId?; CategorizeDeps.createRule(rule with accountId?);
//   CategorizeController.openRulePreview(pattern, categoryId, send, account?: RuleAccount)
// companion/src/wealthfolio.ts — createCategorizationRule(rule with accountId?)
```

Log line: `/newrule: reading accounts failed: <error>`.

- [ ] **Step 1: Write the failing tests**

Edit 1 of 2 in `shared/categorize-menu.test.ts` — replace:

```ts
  renderScreen,
  applyTap,
  parseNewRuleArgs,
  MENU_PAGE_SIZE,
  MENU_CALLBACK_PREFIX,
} from './categorize-menu';
```

with:

```ts
  renderScreen,
  applyTap,
  parseNewRuleArgs,
  resolveAccountQuery,
  formatAccountQueryMiss,
  NEWRULE_ACCOUNTS_UNREADABLE,
  MENU_PAGE_SIZE,
  MENU_CALLBACK_PREFIX,
} from './categorize-menu';
```

Edit 2 of 2 in `shared/categorize-menu.test.ts` — replace:

```ts
    expect(Math.max(...keyboard.inline_keyboard.flat().map((b) => new TextEncoder().encode(b.callback_data).length))).toBe(15);
  });
});
```

with:

```ts
    expect(Math.max(...keyboard.inline_keyboard.flat().map((b) => new TextEncoder().encode(b.callback_data).length))).toBe(15);
  });
});

describe('account-scoped rules (3)', () => {
  const CHK = { activityId: 'act-1', accountId: 'wf-chk', accountName: 'PNC Checking', description: 'VENMO PAYMENT 1023' };
  const rows = [
    txn(CHK),
    txn({ ...CHK, activityId: 'act-2' }),
    txn({ ...CHK, activityId: 'act-3', accountId: 'wf-card', accountName: 'Citi Card' }),
  ];
  const preview = (onlyAccount?: boolean): MenuScreen => ({ kind: 'rulePreview', activityId: 'act-1', categoryId: 'cat-groceries', ...(onlyAccount ? { onlyAccount } : {}) });
  const flat = (s: MenuSession) => {
    const { keyboard, buttons } = renderScreen(s);
    return keyboard.inline_keyboard.flat().map((b, i) => [b.text, buttons[i]] as const);
  };

  it('offers "All accounts ⇄ Only <account>" on a filing’s preview, all accounts ticked by default', () => {
    const s = session({ txns: rows, screen: preview() });
    expect(flat(s)).toEqual([
      ['Create rule', { kind: 'createRule', activityId: 'act-1', categoryId: 'cat-groceries' }],
      ['✓ All accounts', { kind: 'goto', screen: preview() }],
      ['Only PNC Checking', { kind: 'goto', screen: preview(true) }],
      ['‹ Back', { kind: 'goto', screen: { kind: 'txn', activityId: 'act-1' } }],
    ]);
    expect(renderScreen(s).text).toContain('Right now that also files 2 other uncategorized transactions.');
  });

  it('scoped: names the account in the copy, counts only its rows, and creates for it', () => {
    const s = session({ txns: rows, screen: preview(true) });
    expect(renderScreen(s).text).toBe(
      'Create this rule?\n'
      + 'Descriptions containing "VENMO PAYMENT" in PNC Checking → Groceries\n'
      + 'It will also file any other uncategorized transactions in PNC Checking that match, now and on every future import. '
      + 'Already-categorized transactions are never touched.\n'
      + 'Right now that also files 1 other uncategorized transaction.',
    );
    expect(flat(s).map(([t]) => t)).toEqual(['Create rule', 'All accounts', '✓ Only PNC Checking', '‹ Back']);
    expect(flat(s)[0][1]).toEqual({ kind: 'createRule', activityId: 'act-1', categoryId: 'cat-groceries', account: { id: 'wf-chk', name: 'PNC Checking' } });
  });

  it('a /newrule preview naming an account opens scoped, and can widen to all accounts', () => {
    const account = { id: 'wf-chk', name: 'PNC Checking' };
    const free: MenuScreen = { kind: 'freeRulePreview', pattern: 'venmo', categoryId: 'cat-groceries', account, onlyAccount: true };
    const s = session({ screen: free });
    expect(renderScreen(s).text.split('\n')[1]).toBe('Descriptions containing "venmo" in PNC Checking → Groceries');
    expect(flat(s)).toEqual([
      ['Create rule', { kind: 'createFreeRule', pattern: 'venmo', categoryId: 'cat-groceries', account }],
      ['All accounts', { kind: 'goto', screen: { kind: 'freeRulePreview', pattern: 'venmo', categoryId: 'cat-groceries', account } }],
      ['✓ Only PNC Checking', { kind: 'goto', screen: free }],
      ['Cancel', { kind: 'close' }],
    ]);
    const wide = session({ screen: { kind: 'freeRulePreview', pattern: 'venmo', categoryId: 'cat-groceries', account } });
    expect(flat(wide)[0][1]).toEqual({ kind: 'createFreeRule', pattern: 'venmo', categoryId: 'cat-groceries' });
  });

  it('says where a scoped rule will file once it exists', () => {
    const s = session({ screen: { kind: 'ruleCreated', activityId: null, categoryId: 'cat-groceries', accountName: 'J_D *Checking*' } });
    expect(renderScreen(s).text).toBe('Rule created — future matches in J\\_D \\*Checking\\* will file automatically under Groceries.');
  });

  it('escapes an account name full of Markdown in the text and keeps it raw on the button', () => {
    const odd = txn({ ...CHK, accountName: 'J_D *Checking* [1]' });
    const s = session({ txns: [odd], screen: preview(true) });
    expect(renderScreen(s).text.split('\n')[1]).toBe('Descriptions containing "VENMO PAYMENT" in J\\_D \\*Checking\\* \\[1] → Groceries');
    expect(flat(s)[2][0]).toBe('✓ Only J_D *Checking* [1]');
  });

  it('offers no scope for a row whose account has no name to show', () => {
    const s = session({ txns: [txn({ ...CHK, accountName: '' })], screen: preview() });
    expect(flat(s).map(([t]) => t)).toEqual(['Create rule', '‹ Back']);
  });

  it('keeps every scoped screen’s callbacks within 64 bytes', () => {
    const long = txn({ ...CHK, accountName: `A Very Long Household Account Name ${'Z'.repeat(80)}` });
    for (const screen of [preview(), preview(true)]) {
      assertCallbackBytesFit(renderScreen(session({ txns: [long], generation: 4294967295, screen })).keyboard);
    }
  });
});

describe('/newrule … in <account> (3)', () => {
  const ACCOUNTS = [{ id: 'wf-chk', name: 'PNC Checking' }, { id: 'wf-sav', name: 'PNC Savings' }, { id: 'wf-card', name: 'Citi Card' }];

  it('reads an account after " in " on the category side', () => {
    expect(parseNewRuleArgs('venmo = rent in pnc checking')).toEqual({ pattern: 'venmo', categoryQuery: 'rent', accountQuery: 'pnc checking' });
    expect(parseNewRuleArgs('venmo = rent in money in bank')).toEqual({ pattern: 'venmo', categoryQuery: 'rent', accountQuery: 'money in bank' });
    expect(parseNewRuleArgs('dine in = restaurants')).toEqual({ pattern: 'dine in', categoryQuery: 'restaurants' });
  });

  it('resolves the account: an exact name first, else the one name holding the words', () => {
    expect(resolveAccountQuery(ACCOUNTS, 'citi')).toEqual({ kind: 'one', account: ACCOUNTS[2] });
    expect(resolveAccountQuery(ACCOUNTS, 'PNC checking')).toEqual({ kind: 'one', account: ACCOUNTS[0] });
    expect(resolveAccountQuery(ACCOUNTS, 'pnc')).toEqual({ kind: 'many', accounts: [ACCOUNTS[0], ACCOUNTS[1]] });
    expect(resolveAccountQuery(ACCOUNTS, 'chase')).toEqual({ kind: 'none' });
  });

  it('asks which account, or names them all, escaped', () => {
    expect(formatAccountQueryMiss({ kind: 'many', accounts: [ACCOUNTS[0], ACCOUNTS[1]] }, 'pnc', ACCOUNTS)).toBe('Which account? PNC Checking, PNC Savings');
    expect(formatAccountQueryMiss({ kind: 'none' }, 'chase_1', [{ id: 'x', name: 'J_D Card' }])).toBe('No account matches "chase\\_1". Your accounts: J\\_D Card.');
    expect(NEWRULE_ACCOUNTS_UNREADABLE).toBe("Couldn't read your accounts just now — try again.");
  });
});
```

Edit 1 of 1 in `shared/change-entries.test.ts` — replace:

```ts
    expect(categoryRuleCreatedChange({ ruleId: null, name: 'n', pattern: 'X', categoryId: 'c1', categoryName: 'G' }).subject.ruleId).toBeUndefined();
  });

  it('a late label carries the label text and both notes', () => {
    expect(amazonLabelOf('AMAZON MKTPL', 'AMAZON MKTPL · Amazon: mixed — Books + Toys')).toBe('mixed — Books + Toys');
    const d = amazonLabelChange({
```

with:

```ts
    expect(categoryRuleCreatedChange({ ruleId: null, name: 'n', pattern: 'X', categoryId: 'c1', categoryName: 'G' }).subject.ruleId).toBeUndefined();
  });

  it('a rule for one account names it, in the summary and for its Redo (3)', () => {
    const d = categoryRuleCreatedChange({
      ruleId: 'rule-8', name: 'Telegram: VENMO PAYMENT', pattern: 'VENMO PAYMENT', categoryId: 'c1', categoryName: 'Rent',
      account: { wfId: 'wf-chk', name: 'PNC Checking' },
    });
    expect(d.summary).toBe('Created a rule: descriptions containing "VENMO PAYMENT" in PNC Checking go to Rent');
    expect(d.account).toEqual({ wfId: 'wf-chk', name: 'PNC Checking' });
    expect(d.after).toEqual({ ruleId: 'rule-8', name: 'Telegram: VENMO PAYMENT', pattern: 'VENMO PAYMENT', categoryId: 'c1', categoryName: 'Rent', accountId: 'wf-chk' });
    expect('account' in categoryRuleCreatedChange({ ruleId: null, name: 'n', pattern: 'X', categoryId: 'c1', categoryName: 'G' })).toBe(false);
  });

  it('a late label carries the label text and both notes', () => {
    expect(amazonLabelOf('AMAZON MKTPL', 'AMAZON MKTPL · Amazon: mixed — Books + Toys')).toBe('mixed — Books + Toys');
    const d = amazonLabelChange({
```

Edit 1 of 1 in `shared/change-undo.test.ts` — replace:

```ts
      .toEqual([{ do: 'create-rule', rule: { name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro' } }]);
  });

  it('a transaction rule comes out of mapping_rules and goes back, and the next sync retypes', () => {
    const mapping = entry(mappingRuleCreatedChange({ rule: { pattern: 'Payment to Ccb', matchType: 'contains', activityType: 'TRANSFER_OUT' } }));
    const r = { pattern: 'Payment to Ccb', matchType: 'contains' as const, activityType: 'TRANSFER_OUT' as const };
```

with:

```ts
      .toEqual([{ do: 'create-rule', rule: { name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro' } }]);
  });

  it('a rule for one account is deleted by id like any other, and comes back for that account (3)', () => {
    const scoped = entry(categoryRuleCreatedChange({
      ruleId: 'rule-8', name: 'Telegram: VENMO PAYMENT', pattern: 'VENMO PAYMENT', categoryId: 'cat-rent', categoryName: 'Rent',
      account: { wfId: 'wf-checking', name: 'Checking' },
    }));
    expect(ok(planChangeUndo(scoped, 'undo', { rule: { id: 'rule-8' } }, { latest: null })).steps).toEqual([{ do: 'delete-rule', ruleId: 'rule-8' }]);
    expect(ok(planChangeUndo(scoped, 'redo', { rule: null }, { latest: undo(scoped) })).steps)
      .toEqual([{ do: 'create-rule', rule: { name: 'Telegram: VENMO PAYMENT', pattern: 'VENMO PAYMENT', categoryId: 'cat-rent', accountId: 'wf-checking' } }]);
  });

  it('a transaction rule comes out of mapping_rules and goes back, and the next sync retypes', () => {
    const mapping = entry(mappingRuleCreatedChange({ rule: { pattern: 'Payment to Ccb', matchType: 'contains', activityType: 'TRANSFER_OUT' } }));
    const r = { pattern: 'Payment to Ccb', matchType: 'contains' as const, activityType: 'TRANSFER_OUT' as const };
```

Edit 1 of 1 in `companion/src/categorize.test.ts` — replace:

```ts
      + 'It will also file any other uncategorized transactions that match, now and on every future import. '
      + 'Already-categorized transactions are never touched.',
    );
    expect(labels(keyboardOf(lastCall(h.ui.edit)))).toEqual(['Create rule', '‹ Back']);
  });

  it('creates a contains-rule from the trimmed head of the description', async () => {
```

with:

```ts
      + 'It will also file any other uncategorized transactions that match, now and on every future import. '
      + 'Already-categorized transactions are never touched.',
    );
    // The row's account can scope the rule (3): every account until "Only" is tapped.
    expect(labels(keyboardOf(lastCall(h.ui.edit)))).toEqual(['Create rule', '✓ All accounts', 'Only Citi Double Cash', '‹ Back']);
  });

  it('creates a rule for the row’s account only, says so, and records the scope (3)', async () => {
    const h = setup({ rows: [ODD] });
    const recorded: any[] = [];
    (h.deps as any).record = (d: unknown) => recorded.push(d);
    h.deps.createRule.mockResolvedValueOnce('rule-8' as never);
    const filed = await openAtFiled(h, 'TRADER JOE*S');
    await h.tap(dataFor(filed, 'Make this a rule'));
    await h.tap(dataFor(keyboardOf(lastCall(h.ui.edit)), 'Only Citi Double Cash'));
    expect(lastCall(h.ui.edit)[0].split('\n')[1]).toBe('Descriptions containing "TRADER JOE\\*S" in Citi Double Cash → Entertainment');
    await h.tap(dataFor(keyboardOf(lastCall(h.ui.edit)), 'Create rule'));
    expect(h.deps.createRule).toHaveBeenCalledWith({ name: 'Telegram: TRADER JOE*S', pattern: 'TRADER JOE*S', categoryId: 'cat-fun', accountId: 'wf-1' });
    expect(lastCall(h.ui.edit)[0]).toBe('Rule created — future matches in Citi Double Cash will file automatically under Entertainment.');
    expect(recorded.at(-1)).toMatchObject({
      kind: 'category-rule-created', account: { wfId: 'wf-1', name: 'Citi Double Cash' },
      summary: 'Created a rule: descriptions containing "TRADER JOE*S" in Citi Double Cash go to Entertainment',
      after: expect.objectContaining({ accountId: 'wf-1' }),
    });
  });

  it('a scoped rule the server refuses says so and logs nothing (3)', async () => {
    const h = setup({ rows: [ODD] });
    const recorded: any[] = [];
    (h.deps as any).record = (d: unknown) => recorded.push(d);
    const filed = await openAtFiled(h, 'TRADER JOE*S');
    recorded.length = 0;
    h.deps.createRule.mockRejectedValueOnce(new Error('400 accountId is required when isGlobal is false'));
    await h.tap(dataFor(filed, 'Make this a rule'));
    await h.tap(dataFor(keyboardOf(lastCall(h.ui.edit)), 'Only Citi Double Cash'));
    await h.tap(dataFor(keyboardOf(lastCall(h.ui.edit)), 'Create rule'));
    expect(lastCall(h.ui.edit)[0]).toBe('Couldn\'t create that rule — Wealthfolio said: 400 accountId is required when isGlobal is false');
    expect(recorded).toEqual([]);
  });

  it('/newrule naming an account opens scoped to it (3)', async () => {
    const h = setup();
    await h.controller.openRulePreview('venmo', 'cat-fun', h.send, { id: 'wf-chk', name: 'PNC Checking' });
    expect(labels(keyboardOf(lastCall(h.send)))).toEqual(['Create rule', 'All accounts', '✓ Only PNC Checking', 'Cancel']);
    await h.tap(dataFor(keyboardOf(lastCall(h.send)), 'Create rule'));
    expect(h.deps.createRule).toHaveBeenCalledWith({ name: 'Telegram: venmo', pattern: 'venmo', categoryId: 'cat-fun', accountId: 'wf-chk' });
  });

  it('creates a contains-rule from the trimmed head of the description', async () => {
```

Edit 1 of 1 in `companion/src/wealthfolio.test.ts` — replace:

```ts
    expect(body).not.toHaveProperty('presetVersion');
  });

  it('createCategorizationRule resolves the id of the rule the server stored', async () => {
    // Upstream answers with the stored rule (Json<CategorizationRule>, camelCase).
    mockFetch.mockResolvedValueOnce({
```

with:

```ts
    expect(body).not.toHaveProperty('presetVersion');
  });

  it('createCategorizationRule scopes a rule to one account: isGlobal false and its id (3)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const client = new WealthfolioClient('http://wf');
    await client.createCategorizationRule({
      name: 'Telegram: VENMO PAYMENT', pattern: 'VENMO PAYMENT', categoryId: 'cat-1', taxonomyId: 'spending_categories', priority: 50,
      accountId: 'wf-chk',
    });
    expect(JSON.parse((mockFetch.mock.calls[0][1] as any).body)).toEqual({
      name: 'Telegram: VENMO PAYMENT', pattern: 'VENMO PAYMENT', matchType: 'contains', taxonomyId: 'spending_categories',
      categoryId: 'cat-1', priority: 50, isGlobal: false, accountId: 'wf-chk',
    });
  });

  it('createCategorizationRule resolves the id of the rule the server stored', async () => {
    // Upstream answers with the stored rule (Json<CategorizationRule>, camelCase).
    mockFetch.mockResolvedValueOnce({
```

Edit 1 of 1 in `companion/src/index.test.ts` — replace:

```ts
      );
    });

    it('pins the rule priority at 50 — higher wins upstream, so a tapped rule yields', async () => {
      // Verified against upstream source, not inferred:
      // `crates/spending/src/categorization_rules/matcher.rs` picks
```

with:

```ts
      );
    });

    describe('… in <account> (3)', () => {
      const ACCOUNTS = [
        { id: 'wf-chk', name: 'PNC Checking' }, { id: 'wf-sav', name: 'PNC Savings' },
        { id: 'wf-old', name: 'PNC Old', isArchived: true },
      ];
      const scoped = async (args: string, accounts: () => Promise<unknown[]>) => {
        const { client } = clientFor();
        client.getAccounts = vi.fn(accounts);
        const controller = buildCategorizeController(client);
        const { sent, reply } = collect();
        await buildTelegramCommandHandler(client, controller)({ command: 'newrule', args }, reply);
        return { client, controller, sent };
      };

      it('opens the preview for that account only, and creates the rule for it', async () => {
        const { client, controller, sent } = await scoped('trader joes = restaur in pnc checking', async () => ACCOUNTS);
        expect(sent[0][0].split('\n')[1]).toBe('Descriptions containing "trader joes" in PNC Checking → Restaurants (Food & Dining)');
        expect(labels(sent[0][1])).toEqual(['Create rule', 'All accounts', '✓ Only PNC Checking', 'Cancel']);
        await controller.onCallback({ data: dataFor(sent[0][1], 'Create rule'), chatId: 4242, messageId: 7 }, fakeUi());
        expect(client.createCategorizationRule).toHaveBeenCalledWith({
          name: 'Telegram: trader joes', pattern: 'trader joes', categoryId: 'cat-rest',
          taxonomyId: 'spending_categories', priority: 50, accountId: 'wf-chk',
        });
      });

      it('asks which account when the name fits several, never offering an archived one', async () => {
        const { sent, client } = await scoped('trader joes = restaur in pnc', async () => ACCOUNTS);
        expect(sent).toEqual([['Which account? PNC Checking, PNC Savings', undefined]]);
        expect(client.createCategorizationRule).not.toHaveBeenCalled();
      });

      it('names the accounts there are when none matches', async () => {
        const { sent } = await scoped('trader joes = restaur in chase', async () => ACCOUNTS);
        expect(sent[0][0]).toBe('No account matches "chase". Your accounts: PNC Checking, PNC Savings.');
      });

      it('says so when the accounts cannot be read', async () => {
        const { sent } = await scoped('trader joes = restaur in pnc', async () => { throw new Error('502'); });
        expect(sent[0][0]).toBe("Couldn't read your accounts just now — try again.");
      });
    });

    it('pins the rule priority at 50 — higher wins upstream, so a tapped rule yields', async () => {
      // Verified against upstream source, not inferred:
      // `crates/spending/src/categorization_rules/matcher.rs` picks
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/categorize-menu.test.ts shared/change-entries.test.ts shared/change-undo.test.ts`
Expected: FAIL — 10 tests: the five `account-scoped rules (3)` screen tests (`offers "All accounts ⇄ Only <account>" on a filing’s preview, all accounts ticked by default`, `scoped: names the account in the copy, counts only its rows, and creates for it`, `a /newrule preview naming an account opens scoped, and can widen to all accounts`, `says where a scoped rule will file once it exists`, `escapes an account name full of Markdown in the text and keeps it raw on the button`), the three `/newrule … in <account> (3)` tests, `a rule for one account names it, in the summary and for its Redo (3)` and `a rule for one account is deleted by id like any other, and comes back for that account (3)`.

Run: `cd companion && npx vitest run src/categorize.test.ts src/wealthfolio.test.ts src/index.test.ts`
Expected: FAIL — 9 tests: `previews the rule with the disclosure copy` (no toggle yet), `creates a rule for the row’s account only, says so, and records the scope (3)`, `a scoped rule the server refuses says so and logs nothing (3)`, `/newrule naming an account opens scoped to it (3)`, `createCategorizationRule scopes a rule to one account: isGlobal false and its id (3)`, and the four `… in <account> (3)` tests.

- [ ] **Step 3: Implement**

Edit 1 of 9 in `shared/categorize-menu.ts` — replace:

```ts
  amountCents: number;
  description: string;
  accountName: string;
  /** Which way the money moved. Optional so an older controller's rows render
   *  as they always did; when present it puts the +/− on every listed amount
   *  and decides whether a first filing offers income or spending categories. */
```

with:

```ts
  amountCents: number;
  description: string;
  accountName: string;
  /** The row's Wealthfolio account id. Optional: with it, the rule preview
   *  offers "Only <account>" (3, L5); without it (an older controller), the
   *  preview is as it always was. */
  accountId?: string;
  /** Which way the money moved. Optional so an older controller's rows render
   *  as they always did; when present it puts the +/− on every listed amount
   *  and decides whether a first filing offers income or spending categories. */
```

Edit 2 of 9 in `shared/categorize-menu.ts` — replace:

```ts
   *  (an income category), so Undo can clear the assignment it actually made. */
  | { kind: 'filed'; activityId: string; categoryId: string; undone: boolean; taxonomyId?: string }
  | { kind: 'dismissed'; activityId: string; undone: boolean }
  | { kind: 'rulePreview'; activityId: string; categoryId: string }
  | { kind: 'freeRulePreview'; pattern: string; categoryId: string }
  | { kind: 'ruleCreated'; activityId: string | null; categoryId: string }
  | { kind: 'closed' }
  /** Rendered instead of a category picker when a move cannot work at all.
   *  `reason` mirrors `assignabilityOf`'s own machine tokens
```

with:

```ts
   *  (an income category), so Undo can clear the assignment it actually made. */
  | { kind: 'filed'; activityId: string; categoryId: string; undone: boolean; taxonomyId?: string }
  | { kind: 'dismissed'; activityId: string; undone: boolean }
  /** `onlyAccount`: the rule is scoped to the row's account (3, L5). */
  | { kind: 'rulePreview'; activityId: string; categoryId: string; onlyAccount?: boolean }
  /** `account`: the one `/newrule … in <account>` named; `onlyAccount` whether
   *  the rule is scoped to it. Without `account` there is nothing to scope to. */
  | { kind: 'freeRulePreview'; pattern: string; categoryId: string; account?: RuleAccount; onlyAccount?: boolean }
  | { kind: 'ruleCreated'; activityId: string | null; categoryId: string; accountName?: string }
  | { kind: 'closed' }
  /** Rendered instead of a category picker when a move cannot work at all.
   *  `reason` mirrors `assignabilityOf`'s own machine tokens
```

Edit 3 of 9 in `shared/categorize-menu.ts` — replace:

```ts
  | { kind: 'unassign'; activityId: string; categoryId: string; taxonomyId?: string }
  | { kind: 'dismiss'; activityId: string }
  | { kind: 'undismiss'; activityId: string }
  | { kind: 'createRule'; activityId: string; categoryId: string }
  | { kind: 'createFreeRule'; pattern: string; categoryId: string }
  | { kind: 'close' }
  /** `assign`'s recategorize-mode counterpart: files onto a transaction that
   *  already has a category, rather than one with none. A separate kind
```

with:

```ts
  | { kind: 'unassign'; activityId: string; categoryId: string; taxonomyId?: string }
  | { kind: 'dismiss'; activityId: string }
  | { kind: 'undismiss'; activityId: string }
  /** `account` present: create the rule for that account only (3, L5). */
  | { kind: 'createRule'; activityId: string; categoryId: string; account?: RuleAccount }
  | { kind: 'createFreeRule'; pattern: string; categoryId: string; account?: RuleAccount }
  | { kind: 'close' }
  /** `assign`'s recategorize-mode counterpart: files onto a transaction that
   *  already has a category, rather than one with none. A separate kind
```

Edit 4 of 9 in `shared/categorize-menu.ts` — replace:

```ts
  /** 1.61: send this transaction's story as a NEW message; the screen stays. */
  | { kind: 'why'; activityId: string };

/**
 * Parses `/newrule <pattern> = <category>` (or `→` in place of `=`) — the
 * free-text counterpart to tapping "Make this a rule" off a specific
```

with:

```ts
  /** 1.61: send this transaction's story as a NEW message; the screen stays. */
  | { kind: 'why'; activityId: string };

/** A Wealthfolio account a category rule can be scoped to. */
export interface RuleAccount {
  id: string;
  name: string;
}

/**
 * Parses `/newrule <pattern> = <category>` (or `→` in place of `=`) — the
 * free-text counterpart to tapping "Make this a rule" off a specific
```

Edit 5 of 9 in `shared/categorize-menu.ts` — replace:

```ts
 * rather than guessed at — the handler's job, not this function's, is
 * turning that into the one-line usage reply.
 */
export function parseNewRuleArgs(args: string): { pattern: string; categoryQuery: string } | null {
  const sepIndex = args.search(/[=→]/);
  if (sepIndex === -1) return null;
  const pattern = args.slice(0, sepIndex).trim();
  const categoryQuery = args.slice(sepIndex + 1).trim();
  if (!pattern || !categoryQuery) return null;
  return { pattern, categoryQuery };
}

/**
```

with:

```ts
 * rather than guessed at — the handler's job, not this function's, is
 * turning that into the one-line usage reply.
 */
export function parseNewRuleArgs(args: string): { pattern: string; categoryQuery: string; accountQuery?: string } | null {
  const sepIndex = args.search(/[=→]/);
  if (sepIndex === -1) return null;
  const pattern = args.slice(0, sepIndex).trim();
  const categoryQuery = args.slice(sepIndex + 1).trim();
  if (!pattern || !categoryQuery) return null;
  // `… = groceries in checking` (3, L5): the first ` in ` on the category side
  // names an account. No preset category name has one in it.
  const scoped = /^(.*?\S)\s+in\s+(\S.*)$/i.exec(categoryQuery);
  return scoped ? { pattern, categoryQuery: scoped[1], accountQuery: scoped[2] } : { pattern, categoryQuery };
}

/**
 * The account `/newrule … in <account>` names: an exact name (any case) first,
 * else the one name containing the words. Several → `many` (the reply asks
 * "Which account?"); none → `none`.
 */
export function resolveAccountQuery(
  accounts: readonly RuleAccount[],
  query: string,
): { kind: 'one'; account: RuleAccount } | { kind: 'many'; accounts: RuleAccount[] } | { kind: 'none' } {
  const q = query.trim().toLowerCase();
  const exact = accounts.filter((a) => a.name.toLowerCase() === q);
  if (exact.length === 1) return { kind: 'one', account: exact[0] };
  const near = accounts.filter((a) => a.name.toLowerCase().includes(q));
  if (near.length === 1) return { kind: 'one', account: near[0] };
  return near.length > 1 ? { kind: 'many', accounts: near } : { kind: 'none' };
}

/** `/newrule … in <account>` when the accounts could not be read. */
export const NEWRULE_ACCOUNTS_UNREADABLE = "Couldn't read your accounts just now — try again.";

/** The reply when `in <account>` names no one account: which ones it could
 *  mean, or every account there is. Names escaped for Telegram's Markdown. */
export function formatAccountQueryMiss(
  result: { kind: 'many'; accounts: RuleAccount[] } | { kind: 'none' },
  query: string,
  all: readonly RuleAccount[],
): string {
  if (result.kind === 'many') return `Which account? ${result.accounts.map((a) => escapeMarkdown(a.name)).join(', ')}`;
  return `No account matches "${escapeMarkdown(query)}". Your accounts: ${all.map((a) => escapeMarkdown(a.name)).join(', ')}.`;
}

/**
```

Edit 6 of 9 in `shared/categorize-menu.ts` — replace:

```ts
 *  trimmed pattern would file immediately — the number that turns "Make this
 *  a rule" from a chore into a payoff. Counted over the session's own list:
 *  the same rows the user is looking at, no extra read. */
function ruleCatchCount(session: MenuSession, activityId: string, description: string): number {
  const pattern = categoryRulePattern(description).toLowerCase();
  if (!pattern) return 0;
  return session.txns.filter(
    (t) => t.activityId !== activityId && t.description.toLowerCase().includes(pattern),
  ).length;
}

```

with:

```ts
 *  trimmed pattern would file immediately — the number that turns "Make this
 *  a rule" from a chore into a payoff. Counted over the session's own list:
 *  the same rows the user is looking at, no extra read. */
function ruleCatchCount(session: MenuSession, activityId: string, description: string, accountId?: string): number {
  const pattern = categoryRulePattern(description).toLowerCase();
  if (!pattern) return 0;
  return session.txns.filter(
    (t) => t.activityId !== activityId && t.description.toLowerCase().includes(pattern)
      // A rule for one account only files that account's rows (3, L5).
      && (accountId === undefined || t.accountId === accountId),
  ).length;
}

```

Edit 7 of 9 in `shared/categorize-menu.ts` — replace:

```ts
 *  `freeRulePreview` (a typed pattern via `/newrule`) — the two differ only
 *  in what fills the quoted blank, so the sentence lives in one place to
 *  keep them from drifting apart. EXACT wording, locked by the spec. */
function ruleCopy(patternLabel: string, categoryName: string): string {
  return (
    'Create this rule?\n'
    + `Descriptions containing "${patternLabel}" → ${categoryName}\n`
```

with:

```ts
 *  `freeRulePreview` (a typed pattern via `/newrule`) — the two differ only
 *  in what fills the quoted blank, so the sentence lives in one place to
 *  keep them from drifting apart. EXACT wording, locked by the spec. */
function ruleCopy(patternLabel: string, categoryName: string, accountLabel?: string): string {
  if (accountLabel !== undefined) {
    // One account only (3, L5): the same sentences, each naming it.
    return (
      'Create this rule?\n'
      + `Descriptions containing "${patternLabel}" in ${accountLabel} → ${categoryName}\n`
      + `It will also file any other uncategorized transactions in ${accountLabel} that match, now and on every future import. `
      + 'Already-categorized transactions are never touched.'
    );
  }
  return (
    'Create this rule?\n'
    + `Descriptions containing "${patternLabel}" → ${categoryName}\n`
```

Edit 8 of 9 in `shared/categorize-menu.ts` — replace:

```ts
  );
}

function renderRulePreview(session: MenuSession, activityId: string, categoryId: string): RenderResult {
  const txn = findTxn(session, activityId);
  const category = findCategory(session, categoryId);
  if (!txn || !category) return renderList(session, 0, GONE_NOTE);

  // The TRIMMED pattern — what the rule is actually built from (the companion
  // trims identically before the write), so the preview never promises a
  // reference-number-specific rule while creating a broader one.
  const pattern = categoryRulePattern(txn.description);
  const catches = ruleCatchCount(session, activityId, txn.description);
  const catchLine = catches > 0
    ? `\nRight now that also files ${catches} other uncategorized transaction${catches === 1 ? '' : 's'}.`
    : '';
  const text = ruleCopy(escapeMarkdown(pattern), escapeMarkdown(categoryDisplayName(category))) + catchLine;
  const rows: Btn[][] = [
    [{ text: 'Create rule', action: { kind: 'createRule', activityId, categoryId } }],
    [{ text: '‹ Back', action: { kind: 'goto', screen: { kind: 'txn', activityId } } }],
  ];
  return finish(session.generation, text, rows);
}

function renderFreeRulePreview(session: MenuSession, pattern: string, categoryId: string): RenderResult {
  const category = findCategory(session, categoryId);
  if (!category) return renderList(session, 0, GONE_NOTE);

  // `categoryDisplayName`, not the bare name: this screen is the ONLY thing
  // between a typed `/newrule x = other` and a rule against whichever `Other`
  // the flat-tree resolver reached first.
  const text = ruleCopy(escapeMarkdown(pattern), escapeMarkdown(categoryDisplayName(category)));
  // No « Back: this screen is reachable only from /newrule, a free-standing
  // command with no prior menu screen to return to. Cancel closes instead.
  const rows: Btn[][] = [
    [{ text: 'Create rule', action: { kind: 'createFreeRule', pattern, categoryId } }],
    [{ text: 'Cancel', action: { kind: 'close' } }],
  ];
  return finish(session.generation, text, rows);
}

function renderRuleCreated(session: MenuSession, activityId: string | null, categoryId: string): RenderResult {
  const category = findCategory(session, categoryId);
  if (!category) return renderList(session, 0, GONE_NOTE);

  const text = `Rule created — future matches will file automatically under ${escapeMarkdown(categoryDisplayName(category))}.`;
  // Only Done from /newrule (activityId: null): there is no in-flight
  // transaction to return to the list FOR, since this path never showed one.
  const rows: Btn[][] = activityId !== null ? [[BACK_TO_LIST_BTN], [DONE_BTN]] : [[DONE_BTN]];
```

with:

```ts
  );
}

/** The "All accounts ⇄ Only <account>" toggle (3, L5): both choices, the one in
 *  force ticked; tapping either re-renders the preview in that scope. */
function scopeRow(account: RuleAccount, only: boolean, screenFor: (only: boolean) => MenuScreen): Btn[] {
  return [
    { text: only ? 'All accounts' : '✓ All accounts', action: { kind: 'goto', screen: screenFor(false) } },
    { text: only ? `✓ Only ${account.name}` : `Only ${account.name}`, action: { kind: 'goto', screen: screenFor(true) } },
  ];
}

function renderRulePreview(session: MenuSession, screen: Extract<MenuScreen, { kind: 'rulePreview' }>): RenderResult {
  const { activityId, categoryId } = screen;
  const txn = findTxn(session, activityId);
  const category = findCategory(session, categoryId);
  if (!txn || !category) return renderList(session, 0, GONE_NOTE);

  // The row's account, when the controller knows it: the rule can be scoped to it.
  const account: RuleAccount | null = txn.accountId && txn.accountName ? { id: txn.accountId, name: txn.accountName } : null;
  const only = !!account && screen.onlyAccount === true;
  // The TRIMMED pattern — what the rule is actually built from (the companion
  // trims identically before the write), so the preview never promises a
  // reference-number-specific rule while creating a broader one.
  const pattern = categoryRulePattern(txn.description);
  const catches = ruleCatchCount(session, activityId, txn.description, only ? account!.id : undefined);
  const catchLine = catches > 0
    ? `\nRight now that also files ${catches} other uncategorized transaction${catches === 1 ? '' : 's'}.`
    : '';
  const text = ruleCopy(
    escapeMarkdown(pattern), escapeMarkdown(categoryDisplayName(category)), only ? escapeMarkdown(account!.name) : undefined,
  ) + catchLine;
  const rows: Btn[][] = [
    [{ text: 'Create rule', action: { kind: 'createRule', activityId, categoryId, ...(only ? { account: account! } : {}) } }],
    ...(account ? [scopeRow(account, only, (o) => ({ kind: 'rulePreview', activityId, categoryId, ...(o ? { onlyAccount: true } : {}) }))] : []),
    [{ text: '‹ Back', action: { kind: 'goto', screen: { kind: 'txn', activityId } } }],
  ];
  return finish(session.generation, text, rows);
}

function renderFreeRulePreview(session: MenuSession, screen: Extract<MenuScreen, { kind: 'freeRulePreview' }>): RenderResult {
  const { pattern, categoryId, account } = screen;
  const category = findCategory(session, categoryId);
  if (!category) return renderList(session, 0, GONE_NOTE);

  const only = !!account && screen.onlyAccount === true;
  // `categoryDisplayName`, not the bare name: this screen is the ONLY thing
  // between a typed `/newrule x = other` and a rule against whichever `Other`
  // the flat-tree resolver reached first.
  const text = ruleCopy(escapeMarkdown(pattern), escapeMarkdown(categoryDisplayName(category)), only ? escapeMarkdown(account!.name) : undefined);
  // No « Back: this screen is reachable only from /newrule, a free-standing
  // command with no prior menu screen to return to. Cancel closes instead.
  const rows: Btn[][] = [
    [{ text: 'Create rule', action: { kind: 'createFreeRule', pattern, categoryId, ...(only ? { account: account! } : {}) } }],
    ...(account ? [scopeRow(account, only, (o) => ({ kind: 'freeRulePreview', pattern, categoryId, account, ...(o ? { onlyAccount: true } : {}) }))] : []),
    [{ text: 'Cancel', action: { kind: 'close' } }],
  ];
  return finish(session.generation, text, rows);
}

function renderRuleCreated(session: MenuSession, activityId: string | null, categoryId: string, accountName?: string): RenderResult {
  const category = findCategory(session, categoryId);
  if (!category) return renderList(session, 0, GONE_NOTE);

  const where = accountName !== undefined ? ` in ${escapeMarkdown(accountName)}` : '';
  const text = `Rule created — future matches${where} will file automatically under ${escapeMarkdown(categoryDisplayName(category))}.`;
  // Only Done from /newrule (activityId: null): there is no in-flight
  // transaction to return to the list FOR, since this path never showed one.
  const rows: Btn[][] = activityId !== null ? [[BACK_TO_LIST_BTN], [DONE_BTN]] : [[DONE_BTN]];
```

Edit 9 of 9 in `shared/categorize-menu.ts` — replace:

```ts
    case 'dismissed':
      return renderDismissed(session, screen);
    case 'rulePreview':
      return renderRulePreview(session, screen.activityId, screen.categoryId);
    case 'freeRulePreview':
      return renderFreeRulePreview(session, screen.pattern, screen.categoryId);
    case 'ruleCreated':
      return renderRuleCreated(session, screen.activityId, screen.categoryId);
    case 'refiled':
      return renderRefiled(session, screen);
    case 'refused':
```

with:

```ts
    case 'dismissed':
      return renderDismissed(session, screen);
    case 'rulePreview':
      return renderRulePreview(session, screen);
    case 'freeRulePreview':
      return renderFreeRulePreview(session, screen);
    case 'ruleCreated':
      return renderRuleCreated(session, screen.activityId, screen.categoryId, screen.accountName);
    case 'refiled':
      return renderRefiled(session, screen);
    case 'refused':
```

Edit 1 of 1 in `shared/change-entries.ts` — replace:

```ts
  pattern: string;
  categoryId: string;
  categoryName: string;
}

/** A Wealthfolio categorization rule created from Telegram. Undo (R2): delete it. */
export function categoryRuleCreatedChange(f: CategoryRuleFacts): ChangeDraft {
  return {
    actor: 'you',
    kind: 'category-rule-created',
    subject: { ...(f.ruleId ? { ruleId: f.ruleId } : {}), rulePattern: f.pattern, categoryName: f.categoryName },
    summary: `Created a rule: descriptions containing "${f.pattern}" go to ${f.categoryName}`,
    after: { ruleId: f.ruleId, name: f.name, pattern: f.pattern, categoryId: f.categoryId, categoryName: f.categoryName },
    undoable: true,
  };
}
```

with:

```ts
  pattern: string;
  categoryId: string;
  categoryName: string;
  /** The one account the rule is scoped to (3, L5); absent, every account. */
  account?: { wfId: string; name: string };
}

/** A Wealthfolio categorization rule created from Telegram. Undo (R2): delete it.
 *  A scoped one names its account, and its Redo re-creates it scoped. */
export function categoryRuleCreatedChange(f: CategoryRuleFacts): ChangeDraft {
  const where = f.account ? ` in ${f.account.name}` : '';
  return {
    actor: 'you',
    kind: 'category-rule-created',
    ...(f.account ? { account: { wfId: f.account.wfId, name: f.account.name } } : {}),
    subject: { ...(f.ruleId ? { ruleId: f.ruleId } : {}), rulePattern: f.pattern, categoryName: f.categoryName },
    summary: `Created a rule: descriptions containing "${f.pattern}"${where} go to ${f.categoryName}`,
    after: {
      ruleId: f.ruleId, name: f.name, pattern: f.pattern, categoryId: f.categoryId, categoryName: f.categoryName,
      ...(f.account ? { accountId: f.account.wfId } : {}),
    },
    undoable: true,
  };
}
```

Edit 1 of 2 in `shared/change-undo.ts` — replace:

```ts
  | { do: 'assign'; activityId: string; taxonomyId: string; categoryId: string }
  | { do: 'unassign'; activityId: string; taxonomyId: string }
  | { do: 'delete-rule'; ruleId: string }
  | { do: 'create-rule'; rule: { name: string; pattern: string; categoryId: string } }
  | { do: 'mapping-remove'; rule: MappingRule }
  | { do: 'mapping-add'; rule: MappingRule };

```

with:

```ts
  | { do: 'assign'; activityId: string; taxonomyId: string; categoryId: string }
  | { do: 'unassign'; activityId: string; taxonomyId: string }
  | { do: 'delete-rule'; ruleId: string }
  | { do: 'create-rule'; rule: { name: string; pattern: string; categoryId: string; accountId?: string } }
  | { do: 'mapping-remove'; rule: MappingRule }
  | { do: 'mapping-add'; rule: MappingRule };

```

Edit 2 of 2 in `shared/change-undo.ts` — replace:

```ts
      const name = str(after.name);
      const pattern = str(after.pattern);
      const categoryId = str(after.categoryId);
      if (!name || !pattern || !categoryId) return refuse(UNDO_NOT_POSSIBLE);
      if (op === 'redo') {
        if (state.rule) return refuse('That rule is already there.');
        return plan({ op, needsSync: false, ruleAfter: 'created', done: 'Redone — the rule is back.', steps: [{ do: 'create-rule', rule: { name, pattern, categoryId } }] });
      }
      if (!state.rule) return refuse('That rule is already gone.');
      const steps: UndoStep[] = [{ do: 'delete-rule', ruleId: state.rule.id }];
```

with:

```ts
      const name = str(after.name);
      const pattern = str(after.pattern);
      const categoryId = str(after.categoryId);
      // A rule scoped to one account (3, L5) comes back scoped.
      const accountId = str(after.accountId);
      if (!name || !pattern || !categoryId) return refuse(UNDO_NOT_POSSIBLE);
      if (op === 'redo') {
        if (state.rule) return refuse('That rule is already there.');
        return plan({
          op, needsSync: false, ruleAfter: 'created', done: 'Redone — the rule is back.',
          steps: [{ do: 'create-rule', rule: { name, pattern, categoryId, ...(accountId ? { accountId } : {}) } }],
        });
      }
      if (!state.rule) return refuse('That rule is already gone.');
      const steps: UndoStep[] = [{ do: 'delete-rule', ruleId: state.rule.id }];
```

Edit 1 of 1 in `shared/change-undo-run.ts` — replace:

```ts
  /** The companion only: Wealthfolio's categorization rules. */
  rules?: {
    list(): Promise<Array<{ id: string; name: string; pattern: string }>>;
    create(rule: { name: string; pattern: string; categoryId: string }): Promise<string | null>;
    remove(id: string): Promise<void>;
    /** The charges the rule filed (assignment source "rule", its category, a note
     *  containing its words), by activity id. Null when that cannot be read. */
```

with:

```ts
  /** The companion only: Wealthfolio's categorization rules. */
  rules?: {
    list(): Promise<Array<{ id: string; name: string; pattern: string }>>;
    create(rule: { name: string; pattern: string; categoryId: string; accountId?: string }): Promise<string | null>;
    remove(id: string): Promise<void>;
    /** The charges the rule filed (assignment source "rule", its category, a note
     *  containing its words), by activity id. Null when that cannot be read. */
```

Edit 1 of 10 in `companion/src/categorize.ts` — replace:

```ts
  type MenuAction,
  type MenuScreen,
  type MenuSession,
  type SpendingCategory,
  type TaxonomyAssignment,
} from '../../shared/categorize-menu.js';
```

with:

```ts
  type MenuAction,
  type MenuScreen,
  type MenuSession,
  type RuleAccount,
  type SpendingCategory,
  type TaxonomyAssignment,
} from '../../shared/categorize-menu.js';
```

Edit 2 of 10 in `companion/src/categorize.ts` — replace:

```ts
 *  mirrors how `publishUncategorizedStatusForDbPath` takes its own row reader. */
export interface CategorizeSourceRow {
  activityId: string;
  /** RAW stored note (`<description> · <txId>[ · pending]`), cleaned below. */
  notes: string;
  amountCents: number;
```

with:

```ts
 *  mirrors how `publishUncategorizedStatusForDbPath` takes its own row reader. */
export interface CategorizeSourceRow {
  activityId: string;
  /** The row's Wealthfolio account: what a rule from it can be scoped to (3, L5). */
  wfAccountId?: string;
  /** RAW stored note (`<description> · <txId>[ · pending]`), cleaned below. */
  notes: string;
  amountCents: number;
```

Edit 3 of 10 in `companion/src/categorize.ts` — replace:

```ts
  unassignTaxonomy: (activityId: string, taxonomyId: string) => Promise<void>;
  /** Creates a contains-match rule (priority + taxonomy applied by the caller).
   *  Resolves the new rule's id when the server reports one — kept for the
   *  change log (R2 deletes the rule by it). */
  createRule: (rule: { name: string; pattern: string; categoryId: string }) => Promise<string | null | void>;
  /** The change log: one draft per write that succeeded. Optional (most tests
   *  leave it out); read at call time; a throw is logged and swallowed. */
  record?: (draft: ChangeDraft) => void;
```

with:

```ts
  unassignTaxonomy: (activityId: string, taxonomyId: string) => Promise<void>;
  /** Creates a contains-match rule (priority + taxonomy applied by the caller).
   *  Resolves the new rule's id when the server reports one — kept for the
   *  change log (R2 deletes the rule by it). `accountId`: for that account
   *  only (3, L5); absent, every account, as before. */
  createRule: (rule: { name: string; pattern: string; categoryId: string; accountId?: string }) => Promise<string | null | void>;
  /** The change log: one draft per write that succeeded. Optional (most tests
   *  leave it out); read at call time; a throw is logged and swallowed. */
  record?: (draft: ChangeDraft) => void;
```

Edit 4 of 10 in `companion/src/categorize.ts` — replace:

```ts
   * tapped-off-a-transaction path, with the same name truncation and the same
   * disclosure copy: one rule write, two ways in.
   */
  openRulePreview(pattern: string, categoryId: string, send: MenuSend): Promise<void>;
  /**
   * `/recategorize [text]`: builds a fresh session over the CATEGORIZED sweep and
   * sends the list screen.
```

with:

```ts
   * tapped-off-a-transaction path, with the same name truncation and the same
   * disclosure copy: one rule write, two ways in.
   */
  openRulePreview(pattern: string, categoryId: string, send: MenuSend, account?: RuleAccount): Promise<void>;
  /**
   * `/recategorize [text]`: builds a fresh session over the CATEGORIZED sweep and
   * sends the list screen.
```

Edit 5 of 10 in `companion/src/categorize.ts` — replace:

```ts
      amountCents: r.amountCents,
      description: descriptionFromComment(r.notes) || r.notes,
      accountName: r.accountName,
      ...(r.direction ? { direction: r.direction } : {}),
      ...(r.incomeEligible !== undefined ? { incomeEligible: r.incomeEligible } : {}),
    };
```

with:

```ts
      amountCents: r.amountCents,
      description: descriptionFromComment(r.notes) || r.notes,
      accountName: r.accountName,
      ...(r.wfAccountId ? { accountId: r.wfAccountId } : {}),
      ...(r.direction ? { direction: r.direction } : {}),
      ...(r.incomeEligible !== undefined ? { incomeEligible: r.incomeEligible } : {}),
    };
```

Edit 6 of 10 in `companion/src/categorize.ts` — replace:

```ts
    done: MenuScreen,
    pin: CategorizeTxn | null,
    ui: CategorizeUi,
  ): Promise<void> {
    const name = `${RULE_NAME_PREFIX}${pattern}`.slice(0, RULE_NAME_MAX);
    let ruleId: string | null = null;
    try {
      const created = await deps.createRule({ name, pattern, categoryId });
      ruleId = typeof created === 'string' && created ? created : null;
    } catch (err) {
      const message = formatError(err);
```

with:

```ts
    done: MenuScreen,
    pin: CategorizeTxn | null,
    ui: CategorizeUi,
    /** One account only (3, L5). A scoped rule the server refuses says so, like any other. */
    account?: RuleAccount,
  ): Promise<void> {
    const name = `${RULE_NAME_PREFIX}${pattern}`.slice(0, RULE_NAME_MAX);
    let ruleId: string | null = null;
    try {
      const created = await deps.createRule({ name, pattern, categoryId, ...(account ? { accountId: account.id } : {}) });
      ruleId = typeof created === 'string' && created ? created : null;
    } catch (err) {
      const message = formatError(err);
```

Edit 7 of 10 in `companion/src/categorize.ts` — replace:

```ts
    record(() => categoryRuleCreatedChange({
      ruleId, name, pattern, categoryId,
      categoryName: categoryNameIn([chat.session], categoryId) || categoryId,
    }));
    // The rule EXISTS from here on, so the session leaves the preview screen
    // before anything else can fail. `showError` offers `« Back` to whatever
```

with:

```ts
    record(() => categoryRuleCreatedChange({
      ruleId, name, pattern, categoryId,
      categoryName: categoryNameIn([chat.session], categoryId) || categoryId,
      ...(account ? { account: { wfId: account.id, name: account.name } } : {}),
    }));
    // The rule EXISTS from here on, so the session leaves the preview screen
    // before anything else can fail. `showError` offers `« Back` to whatever
```

Edit 8 of 10 in `companion/src/categorize.ts` — replace:

```ts
          // the write must never be broader or narrower than what was shown.
          categoryRulePattern(row.description),
          action.categoryId,
          { kind: 'ruleCreated', activityId: action.activityId, categoryId: action.categoryId },
          row,
          ui,
        );
        return;
      }
```

with:

```ts
          // the write must never be broader or narrower than what was shown.
          categoryRulePattern(row.description),
          action.categoryId,
          {
            kind: 'ruleCreated', activityId: action.activityId, categoryId: action.categoryId,
            ...(action.account ? { accountName: action.account.name } : {}),
          },
          row,
          ui,
          action.account,
        );
        return;
      }
```

Edit 9 of 10 in `companion/src/categorize.ts` — replace:

```ts
          chat,
          action.pattern,
          action.categoryId,
          { kind: 'ruleCreated', activityId: null, categoryId: action.categoryId },
          null,
          ui,
        );
        return;

```

with:

```ts
          chat,
          action.pattern,
          action.categoryId,
          {
            kind: 'ruleCreated', activityId: null, categoryId: action.categoryId,
            ...(action.account ? { accountName: action.account.name } : {}),
          },
          null,
          ui,
          action.account,
        );
        return;

```

Edit 10 of 10 in `companion/src/categorize.ts` — replace:

```ts
    /** Same parking as `open`, and uncaught for the same reason — this is a
     *  command path too (`/newrule`), reached with the category already
     *  resolved. */
    async openRulePreview(pattern, categoryId, send): Promise<void> {
      await openScreen(PENDING_CHAT_ID, { kind: 'freeRulePreview', pattern, categoryId }, send, CATEGORIZE_MODE);
    },

    /** Same parking and the same uncaught contract as `open` — `/recategorize` is
```

with:

```ts
    /** Same parking as `open`, and uncaught for the same reason — this is a
     *  command path too (`/newrule`), reached with the category already
     *  resolved. */
    async openRulePreview(pattern, categoryId, send, account): Promise<void> {
      // `/newrule … in <account>` opens scoped to it; the toggle can widen it.
      await openScreen(
        PENDING_CHAT_ID,
        { kind: 'freeRulePreview', pattern, categoryId, ...(account ? { account, onlyAccount: true } : {}) },
        send,
        CATEGORIZE_MODE,
      );
    },

    /** Same parking and the same uncaught contract as `open` — `/recategorize` is
```

Edit 1 of 2 in `companion/src/wealthfolio.ts` — replace:

```ts
    categoryId: string;
    taxonomyId: string;
    priority: number;
  }): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/api/v1/spending/rules`, {
      method: 'POST',
```

with:

```ts
    categoryId: string;
    taxonomyId: string;
    priority: number;
    /** For one account only (3, L5): `isGlobal: false` with its id. Absent:
     *  every account, and no `accountId` key — upstream refuses a global rule
     *  that names an account (`validate_rule_scope`, 3.8–3.10). */
    accountId?: string;
  }): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/api/v1/spending/rules`, {
      method: 'POST',
```

Edit 2 of 2 in `companion/src/wealthfolio.ts` — replace:

```ts
        taxonomyId: rule.taxonomyId,
        categoryId: rule.categoryId,
        priority: rule.priority,
        isGlobal: true,
      }),
    });
    if (!res.ok) throw await this.httpError('createCategorizationRule', res);
```

with:

```ts
        taxonomyId: rule.taxonomyId,
        categoryId: rule.categoryId,
        priority: rule.priority,
        isGlobal: !rule.accountId,
        ...(rule.accountId ? { accountId: rule.accountId } : {}),
      }),
    });
    if (!res.ok) throw await this.httpError('createCategorizationRule', res);
```

Edit 1 of 2 in `companion/src/index.ts` — replace:

```ts
  formatCategoryQueryMiss,
  NEWRULE_CATEGORY_LIST_HINT,
} from '../../shared/telegram-commands.js';
import { parseNewRuleArgs } from '../../shared/categorize-menu.js';
import type { CategoryBudgetSnapshot, BudgetPeriod, ParsedCommand, StatusReplyInput } from '../../shared/telegram-commands.js';
import { parsePoolArgs, POOL_USAGE_REPLY } from '../../shared/telegram-commands.js';
import { SEMESTER_POOL_SECRET_KEY, parsePoolConfig } from '../../shared/pool.js';
```

with:

```ts
  formatCategoryQueryMiss,
  NEWRULE_CATEGORY_LIST_HINT,
} from '../../shared/telegram-commands.js';
import { formatAccountQueryMiss, NEWRULE_ACCOUNTS_UNREADABLE, parseNewRuleArgs, resolveAccountQuery, type RuleAccount } from '../../shared/categorize-menu.js';
import type { CategoryBudgetSnapshot, BudgetPeriod, ParsedCommand, StatusReplyInput } from '../../shared/telegram-commands.js';
import { parsePoolArgs, POOL_USAGE_REPLY } from '../../shared/telegram-commands.js';
import { SEMESTER_POOL_SECRET_KEY, parsePoolConfig } from '../../shared/pool.js';
```

Edit 2 of 2 in `companion/src/index.ts` — replace:

```ts
          return;
        }
        const category = (result as { kind: 'one'; category: { id: string } }).category;
        // Never creates the rule outright: a rule files every uncategorized
        // match now AND on every future import, so the confirmation screen is
        // where that gets disclosed before anything is written.
        await controller.openRulePreview(parsed.pattern, category.id, (text, keyboard) => reply(text, keyboard));
        return;
      }

```

with:

```ts
          return;
        }
        const category = (result as { kind: 'one'; category: { id: string } }).category;
        // `… in <account>` (3, L5): the preview opens for that account only.
        // Archived accounts are not offered.
        let account: RuleAccount | undefined;
        if (parsed.accountQuery) {
          let accounts: RuleAccount[];
          try {
            accounts = (await wfClient.getAccounts())
              .filter((a) => a.isArchived !== true)
              .map((a) => ({ id: a.id, name: String((a as { name?: unknown }).name ?? '') }))
              .filter((a) => a.name !== '');
          } catch (err) {
            log(`/newrule: reading accounts failed: ${formatError(err)}`);
            await reply(NEWRULE_ACCOUNTS_UNREADABLE);
            return;
          }
          const found = resolveAccountQuery(accounts, parsed.accountQuery);
          if (found.kind !== 'one') {
            await reply(formatAccountQueryMiss(found, parsed.accountQuery, accounts));
            return;
          }
          account = found.account;
        }
        // Never creates the rule outright: a rule files every uncategorized
        // match now AND on every future import, so the confirmation screen is
        // where that gets disclosed before anything is written.
        await controller.openRulePreview(parsed.pattern, category.id, (text, keyboard) => reply(text, keyboard), account);
        return;
      }

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/categorize-menu.test.ts shared/change-entries.test.ts shared/change-undo.test.ts`
Expected: PASS — 205 tests.

Run: `cd companion && npx vitest run src/categorize.test.ts src/wealthfolio.test.ts src/index.test.ts`
Expected: PASS — 464 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/categorize-menu.ts shared/categorize-menu.test.ts shared/change-entries.ts shared/change-entries.test.ts shared/change-undo.ts shared/change-undo.test.ts shared/change-undo-run.ts companion/src/categorize.ts companion/src/categorize.test.ts companion/src/wealthfolio.ts companion/src/wealthfolio.test.ts companion/src/index.ts companion/src/index.test.ts
git commit -m "Rules: \"All accounts ⇄ Only <account>\" on the rule preview; /newrule … in <account>; the scope logged and kept on Redo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Docs, the forced-date run, every gate

The CHANGELOG under `[Unreleased]` (no version bump), the README's Venmo setup (a second Gmail filter, `from:venmo@venmo.com`, forwarding to the same mailbox), the guess and the one-account toggle, and `docs/superpowers/follow-ups.md` §13 — what R1 leaves open, the unverified Venmo formats first (Z1b, Z7). Then every new and touched test file once more with the system date forced to 2027-01-01 through a throwaway setup file inside the clone, and all four gates under `nice`.

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `docs/superpowers/follow-ups.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the docs**

Edit 1 of 1 in `CHANGELOG.md` — replace:

```markdown
    snapshot the companion publishes after each sync, which says when it was
    taken and when it is out of date or unreadable. Home's Accounts tile
    points at the checks when there is something to look at.

### Fixed
- **The "Opening balances" spending exclusion is re-applied.** It was only set
```

with:

```markdown
    snapshot the companion publishes after each sync, which says when it was
    taken and when it is out of date or unreadable. Home's Accounts tile
    points at the checks when there is something to look at.
- **Less filing (R1).**
  - **Venmo notes.** Forward Venmo's emails to the Amazon mailbox (a second
    Gmail filter, `from:venmo@venmo.com`) and a bank row for a Venmo payment
    gets the payment's note: `VENMO PAYMENT 1023 · Venmo: Rent October`. A
    note goes on only when exactly one payment has the same amount and
    direction with its email within 5 days, and is clipped to 60 characters.
    Each note is in the change log; Undo takes it off and keeps it off. Your
    rules can match on the note. Venmo's email formats are built from its
    documented wording and not yet checked against real emails: one that does
    not read is left unread and kept.
  - **Guessed categories.** A needs-a-category row whose merchant you filed
    the same way before (at least 2 filings in the last year, 80% of them in
    one category) gets a guess. `/categorize` offers it as the first button —
    "✓ Groceries (like the last 3)", one tap files it exactly as the grid
    would — and shows it beside the row on the list; the app shows "Probably
    Groceries" under the row. A guess never files anything on its own; Amazon
    rows get none.
  - **Rules for one account.** The rule preview after a filing offers "All
    accounts ⇄ Only <account>", and `/newrule trader joes = groceries in
    checking` opens it for that account. The change log names the account,
    and Redo brings the rule back for it.
  - Update the add-on along with the companion: an add-on older than this
    release cannot read your overrides once a Venmo note has been undone.

### Fixed
- **The "Opening balances" spending exclusion is re-applied.** It was only set
```

Edit 1 of 4 in `README.md` — replace:

```markdown
  words or an amount and read its story — where it came from, what it is, who
  filed it and every change made to it, with Undo. Then a status strip (last
  sync, accounts, anything that needs you; a needs-a-category row opens its
  story),
  then your budget: six reports to start (headline numbers, cash flow or the
  semester-pool burn-down, budget vs actual, top merchants, subscriptions & bills (remind, rename, hide, add by hand)),
  with more a tap away under **+ Add report**, or build your own.
```

with:

```markdown
  words or an amount and read its story — where it came from, what it is, who
  filed it and every change made to it, with Undo. Then a status strip (last
  sync, accounts, anything that needs you; a needs-a-category row opens its
  story, and shows the category you probably meant when you filed the same
  merchant that way before),
  then your budget: six reports to start (headline numbers, cash flow or the
  semester-pool burn-down, budget vs actual, top merchants, subscriptions & bills (remind, rename, hide, add by hand)),
  with more a tap away under **+ Add report**, or build your own.
```

Edit 2 of 4 in `README.md` — replace:

```markdown
- **Telegram bot** (with the companion) — one short daily report: what you
  spent, what's left, and a single "🧹 N things to fix" line with buttons.
  File transactions, check what you can afford and pull charts from the chat.
  Commands that need details — `/pool`, `/newrule`, `/afford` — ask for them
  one question at a time; the one-line forms still work. Bare `/pool` shows
  the pool with Set and Clear buttons.
```

with:

```markdown
- **Telegram bot** (with the companion) — one short daily report: what you
  spent, what's left, and a single "🧹 N things to fix" line with buttons.
  File transactions, check what you can afford and pull charts from the chat.
  `/categorize` offers the category you filed the same merchant under before
  as the first, one-tap choice ("✓ Groceries (like the last 3)"), and a rule
  made from a filing can be for one account only ("Only <account>" on its
  preview; `/newrule trader joes = groceries in checking` does the same).
  Commands that need details — `/pool`, `/newrule`, `/afford` — ask for them
  one question at a time; the one-line forms still work. Bare `/pool` shows
  the pool with Set and Clear buttons.
```

Edit 3 of 4 in `README.md` — replace:

```markdown
  and rule changes are undone from Telegram's `/changes`.
- **Amazon categorization** (optional) — reads Amazon's order emails from a
  throwaway mailbox and files each `AMAZON.COM*…` charge under what you bought.
- **Rules** — map a description pattern to a category or activity type when a
  bank's wording needs help. Your rules always win.

```

with:

```markdown
  and rule changes are undone from Telegram's `/changes`.
- **Amazon categorization** (optional) — reads Amazon's order emails from a
  throwaway mailbox and files each `AMAZON.COM*…` charge under what you bought.
- **Venmo notes** (optional, the same mailbox) — a bank row for a Venmo
  payment gets the payment's note from Venmo's email.
- **Rules** — map a description pattern to a category or activity type when a
  bank's wording needs help. Your rules always win.

```

Edit 4 of 4 in `README.md` — replace:

```markdown
If the companion cannot sign in to the mailbox, the card shows the error itself
(before 1.57.0 it was only in `docker logs`).

**Proton Mail does not work for this**, for two reasons. An alias delivers into the
same mailbox, so credentials for it reach everything in the account — no isolation
at all. And Proton has no plain IMAP: it requires Proton Mail Bridge, which is a
```

with:

````markdown
If the companion cannot sign in to the mailbox, the card shows the error itself
(before 1.57.0 it was only in `docker logs`).

#### Venmo notes

The same mailbox reads Venmo's emails. Add a second Gmail filter — _From_
`venmo@venmo.com`, _To_ empty, **Forward it to** the same address — and a bank
row for a Venmo payment gets the payment's note:

```
Email:  You paid Jane Doe $25.00 · Rent October
Bank:   VENMO PAYMENT 1023 · -$25.00
   →    comment becomes "VENMO PAYMENT 1023 · Venmo: Rent October · TRN-…"
```

A note goes on only when exactly one Venmo payment has the same amount, the
same direction and its email within 5 days; two payments of the same amount
that week mean no note. Money you were paid counts when it reaches the bank,
and so does a transfer to your bank ("Transfer to your bank"). Each note is in
the change log, where Undo takes it off and keeps it off. Wealthfolio's rules
read the note, so a rule on `Venmo: Rent` works. With no Venmo mail forwarded,
nothing happens.

Venmo's email formats are built from its documented wording and have not yet
been checked against real emails. One that does not read stays unread in the
mailbox, and the companion's log counts it (`Venmo mail: … unrecognised`).

**Proton Mail does not work for this**, for two reasons. An alias delivers into the
same mailbox, so credentials for it reach everything in the account — no isolation
at all. And Proton has no plain IMAP: it requires Proton Mail Bridge, which is a
````

Edit 1 of 1 in `docs/superpowers/follow-ups.md` — replace:

```markdown
  snapshot already carries both rows' ids, accounts, tx keys, amounts and
  dates), and "Remove for good…" on a transaction's story.

## Reference: name mismatches between the database, the REST API, and the SDK

Every one of these cost a diagnostic cycle against the live instance on
```

with:

```markdown
  snapshot already carries both rows' ids, accounts, tx keys, amounts and
  dates), and "Remove for good…" on a transaction's story.

## 13. Less filing — R1 (2026-10-14, plan `2026-10-14-less-filing.md`)

- **Venmo's email formats are unverified.** `shared/venmo.ts` reads the
  wording Venmo documents ("You paid <name> $X", "<name> paid you $X", a
  completed charge request, a transfer to your bank); no real email has been
  seen. Needed from Nick: one real email of each kind (redacted is fine) to
  replace the built fixtures in `shared/venmo.test.ts`. Until then a Venmo
  email that does not read stays unread, is counted in the log
  (`Venmo mail: … unrecognised`) and kept in the `venmo_mail_samples` secret.
- **The Venmo samples are not shown anywhere yet.** Amazon's are on its card
  with Copy; Venmo's sit in `venmo_mail_samples`. Show them on the same card
  once the formats are known to drift.
- **A cash-out of exactly one payment gets no note.** "Sam paid you $40" and
  "Transfer to your bank $40" in the same week are two records of the same
  amount and direction, so the $40 bank deposit gets neither (the two-record
  rule). Preferring the payment's note there is a later refinement.
- **Undo takes a Venmo note off at once**, as an Amazon label's Undo does,
  rather than leaving it for the next sync; the sync then never adds it again.
- **Overrides and older add-ons.** `parseSyncOverrides` treats an unknown flag
  as corruption, so an add-on older than this release reads a document holding
  `noVenmoNote` as corrupt — its sync then ignores every override until it is
  updated. Only an Undo of a Venmo note writes the flag. Later: let the parser
  keep flags it does not know instead of refusing the document.
- **Guesses skip money-in rows that take an income category** (a guess is a
  spending category, which Wealthfolio refuses there), and come only from
  filings by a person or a rule (`source` `manual` or `rule`), never
  `migrated`. Filing a guess from the app waits for R2 (SDK 3.9 `spending`).
- **Scoped rules, what stays global:** the bare `/newrule` questions have no
  account step; the add-on's `mapping_rules` have no scope (L5); a scoped
  rule's Wealthfolio name does not mention its account; "Undo rule + un-file N"
  counts by pattern and category, not account.

## Reference: name mismatches between the database, the REST API, and the SDK

Every one of these cost a diagnostic cycle against the live instance on
```

- [ ] **Step 2: Run every new and touched test file with the date forced to 2027-01-01**

Nothing may depend on the real clock. A throwaway setup file fakes `Date` before every test; delete it afterwards — none of it is committed.

```sh
cat > zz-2027.setup.ts <<'EOF2'
import { beforeEach, vi } from 'vitest';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-01-01T12:00:00Z')); });
EOF2
cp zz-2027.setup.ts companion/zz-2027.setup.ts
cat > zz-2027.config.mts <<'EOF2'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts', './zz-2027.setup.ts'] } });
EOF2
cat > companion/zz-2027.config.mts <<'EOF2'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true, setupFiles: ['./zz-2027.setup.ts'] } });
EOF2
npx vitest run --config zz-2027.config.mts shared/venmo.test.ts shared/venmo-ledger.test.ts shared/sync-core-venmo.test.ts shared/category-guess.test.ts shared/categorize-menu.test.ts shared/sync-overrides.test.ts shared/change-entries.test.ts shared/change-view.test.ts shared/change-undo.test.ts shared/change-undo-run.test.ts shared/tx-story.test.ts src/utils/secrets.test.ts src/components/UncategorizedList.test.tsx
(cd companion && npx vitest run --config zz-2027.config.mts src/venmo-mail.test.ts src/sqlite-guess.test.ts src/uncategorized-status.test.ts src/categorize.test.ts src/rest-host.test.ts src/wealthfolio.test.ts)
(cd companion && npx vitest run --config zz-2027.config.mts src/index.test.ts -t "Venmo|guess|in <account>")
rm zz-2027.setup.ts zz-2027.config.mts companion/zz-2027.setup.ts companion/zz-2027.config.mts
git status --short
```

Expected: PASS — 442 tests (root), 205 tests (companion), and 8 passed with 292 skipped (`index.test.ts`'s new Venmo, guess and account tests); `git status --short` lists only the three docs from Step 1 (` M CHANGELOG.md`, ` M README.md`, ` M docs/superpowers/follow-ups.md`) — the throwaway files are gone. (`index.test.ts` as a whole is not run here: seven of its older dismissal tests compute a timestamp from the real clock at import and fail under a forced date on the base branch too.)

- [ ] **Step 3: Run every gate**

Run: `nice npm test`
Expected: PASS — 2589 tests.

Run: `cd companion && nice npx vitest run`
Expected: PASS — 1147 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md docs/superpowers/follow-ups.md
git commit -m "Less filing R1: docs — the CHANGELOG, the README's Venmo setup, guesses and one-account rules, follow-ups §13

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
