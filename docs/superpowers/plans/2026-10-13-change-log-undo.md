# Change log — Undo (R2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every automatic decision and every filing in the change log can be undone — and redone — from `/changes` and from the app's Change log card, with no "are you sure?". An overrides document every sync obeys makes an undone sync decision stick; a version gate keeps the app's sync-decision undos off until the companion obeys overrides; Sync now applies an undo at once.

**Architecture:** `shared/sync-overrides.ts` owns the `sync_overrides` document — corrupt-aware parse, ONE re-read-before-write edit (`editSyncOverrides`), the pure edits both writers share, year-old pruning, and the rows "Your overrides" lists. `runSyncCore` reads it once per run through the optional `SyncStore.getSyncOverrides` and obeys every flag on both hosts; a linked pair with a `notTransfer` leg is unlinked by `unlinkPairByRecreate` (`shared/link-pair.ts`). `shared/change-undo.ts` decides an undo or redo purely, per kind — (entry, what is there now) → plan | refusal — plus `undoAvailability` (buttons, the Telegram pointer, the version gate). `shared/change-undo-run.ts` runs a decision on a host through a host-neutral `UndoIo`: gather the state, plan, write the overrides first in one edit, reverse, record a `reverses` entry (`reversalChange`) in the undoer's own bucket. The companion's `UndoIo` (`companion/src/change-undo-host.ts`) adds categories and rules over REST and "what did this rule file" over SQLite; the add-on's (`src/utils/change-undo.ts`) is activities and settings only. `/changes` gains `↩ Undo` / `Redo` / `🔄 Sync now`; the app card gains Undo / Redo, Sync now and "Your overrides".

**Tech Stack:** TypeScript, React (add-on), vitest (root project: jsdom, `src/` + `shared/`; companion project: node, `companion/src/`), Telegram Bot API (legacy `Markdown`), Wealthfolio REST (companion) and add-on SDK 3.6.2 (add-on).

**Spec:** `docs/superpowers/specs/2026-10-12-change-log-and-undo-design.md` — Part B. Part A (R1) is built (`docs/superpowers/plans/2026-10-12-change-log-record.md`, follow-ups §8). Binding rulings L2 and U1–U10 are folded into the tasks below.

**Verified facts this plan builds on (U1):**
- **What the add-on SDK can do.** `@wealthfolio/addon-sdk` 3.6.2 (`node_modules/@wealthfolio/addon-sdk/dist/src/host-api.d.ts`, `HostAPI`): `activities.getAll/search/create/update/saveMany` (`ActivityBulkMutationRequest` has `creates`, `updates`, `deleteIds`), `activities.import`, `accounts.getAll` (an `Account` carries `currency`), `secrets.get/set/delete`. There is NO taxonomy/category-assignment API and NO categorization-rule API anywhere in `HostAPI`. So the add-on undoes `transfer-link`, `transfer-type`, `duplicate-removed`, `balance-correction`, `import`, `amazon-label`, `starting-balance`, `starting-balance-moved` (activities + the `sync_overrides` / `skipped_transactions` settings) and `mapping-rule-created` (the `mapping_rules` setting). It cannot undo `category-filed`, `opening-balance-filed` or `category-rule-created`: the app shows "Undo this from Telegram: /changes" there, only when a companion has published a version (U1's default; no request queue — nothing simpler is correct, since only the companion can reach those routes).
- **What the companion's REST client needs** (upstream `apps/server/src/api/spending.rs` router, checked in `~/Personal Projects/wealthfolio-upstream` at d7a0299d1): `GET`/`PUT /api/v1/spending/activities/{id}/assignments` (`Vec<ActivityTaxonomyAssignment>`, camelCase: `taxonomyId`, `categoryId`, `source` = `"manual"|"rule"|"import"`), `DELETE …/assignments/{taxonomyId}`, `GET`/`POST /api/v1/spending/rules` (list; create returns the stored `CategorizationRule` with `id`), `PUT`/`DELETE /api/v1/spending/rules/{id}` (`delete_categorization_rule`, empty 200). A rule's own filings carry `source = "rule"` (`crates/spending/src/categorization_rules/service.rs`). Task 6 adds `getActivityAssignments`, `listCategorizationRules`, `deleteCategorizationRule`; assign/unassign and `createCategorizationRule` (returns the id) exist.
- **Unlinking.** Deleting both legs of a linked pair in ONE bulk request is clean: `bulk_mutate_activities` expands a linked leg's delete to its pair and de-duplicates the ids (`crates/core/src/activities/activities_service.rs`, the `delete_ids` loop). An UPDATE to one leg is copied onto its partner (`build_counterpart_update`) and cannot take a row out of its group. So the unlink is delete-both then re-create-both as ordinary money, never an update.
- **The companion's version** is published as the add-on secret `companion_version` (`COMPANION_VERSION_SECRET_KEY`, written after every sync in `runCompanionSync`); the add-on reads it with `SecretsStore.getCompanionVersion()`.

**Deviations from the spec (decided, do not "fix"):**
- **Override entries carry an optional `label`** (`"<bank text> · <account>"`, or the account name) so "Your overrides" can name an entry after it leaves the 90-day log. The account switches are `noAutoCorrect` and `noOpeningFile` (L2: an opening-balance filing has no bank tx id, so its "don't file it again" is per SimpleFin account). An unknown key anywhere in the document reads as corrupt (a new field needs `v: 2`).
- **The version gate (`SYNC_OVERRIDES_SINCE = '1.61.0'`) applies, in the app, to the Undo of an AUTOMATIC sync decision only.** A Redo only clears overrides, and the undo of your own Add adjustment sets none. With no companion at all (no published version) nothing else syncs, so the gate is open. Telegram never gates: it runs in the companion.
- **`noAutoCorrect` is set only by undoing an automatic correction**; undoing your own Add adjustment just removes the row.
- **An Amazon filing without a tx key** (R1's transient mapping-read failure) gets it re-derived at undo time from the row's note and `account_mapping`; when that fails the undo is refused ("Couldn't tell which bank transaction this is — nothing was changed.").
- **Undo/redo entries** keep the original's kind, account and subject; summary `Undid: <summary>` / `Redid: <summary>`; `before`/`after` swapped for an undo; `after.activityId` / `after.ruleId` name the row or rule the reversal left behind (a re-created row has a new id), which the next undo or redo acts on. They are never undoable themselves.
- **The sync's unlink records a `bookkeeping` entry** (new step `transfer-unlink`); a held placeholder retyped by `notTransfer` records `transfer-type` ending "— you said it isn't a transfer" (new `undone` fact).
- **A held transfer's undo takes effect when its leg is next in a sync's window** (the routine 14-day overlap, or a re-scan); a LINKED pair is unlinked from the stored rows whatever the window. A linked leg whose other half is not in view is reported and left linked (deleting one leg deletes both).
- **Undoing an automatic starting-balance move** restores amount and date; the next sync may move the date back in front of older rows (no money moves). There is no override for it.
- **Rule undo finds the rule by id; by name (+ pattern) only when the log never had an id.** `↩ Undo rule + un-file N` shows only when N > 0 could be read.
- **`/sync`'s run is shared with 🔄 Sync now** through a new `startTelegramSync()` in `companion/src/index.ts`; the app's Sync now is the existing `runSync(ctx, store, { force: true })`.

**Task order:** the pure overrides document (1); the sync obeying the simple flags (2) and `notTransfer` with the unlink path (3); the pure planners and the gate (4); the shared runner (5); the companion's REST/SQLite pieces and the after-sync filers (6); the companion's undo host and `/changes` (7); the add-on's host (8); the app card (9); docs and every gate (10).

## Global Constraints

- **The document (verbatim):** setting key `sync_overrides`; shape `{ v: 1, tx: Record<accountTxKey, { notTransfer?: true; keepDuplicate?: true; noAutoFile?: true; noAmazonLabel?: true; at: string; entryId?: string; label?: string }>, accounts: Record<sfinAccountId, { noAutoCorrect?: true; noOpeningFile?: true; at: string; label?: string }> }`; `tx` entries older than 365 days (`TX_OVERRIDE_KEEP_DAYS`) are dropped on write; account entries stay until changed.
- **Corrupt is not absent.** `parseSyncOverrides` returns `ok | absent | corrupt` (`''` is absent). A corrupt stored document is never overwritten: every write throws `SyncOverridesUnreadableError` ("Your sync overrides can't be read, so nothing was changed.") before calling `set`; a document the parser would refuse is never written. Every SYNC reads corrupt, absent and a failed read as EMPTY (`syncOverridesOrEmpty`) — it then behaves exactly as before overrides existed.
- **One edit path, two writers.** Every override write is `editSyncOverrides(get, set, edit, now)` with the pure edits from `shared/sync-overrides.ts`; the skip list's writes are `editSkippedTransactions`; `mapping_rules` is re-read strictly before an undo writes it. Nothing writes a whole-document snapshot.
- **Every override is honoured on both hosts** by the shared core: `runSyncCore` reads the document ONCE per run via the optional `store.getSyncOverrides?.()`; the companion's after-sync filers (Amazon, card opening balances) read it once after the sync.
- **Undo safety order (spec B2):** re-read and check the state — a refusal writes nothing; then ALL override steps in ONE `editSyncOverrides`; then the reversal; then ONE `reverses` entry (`reversalChange`) in the undoer's own bucket, only when it worked. A reversal that fails after its override leaves the override (harmless) and says what failed; a re-created duplicate refused as an exact copy takes its override back out.
- **Copy (verbatim, both surfaces):** `Update the companion first` · `Undo this from Telegram: /changes` · `Redo this from Telegram: /changes` · `Takes effect on the next sync.` · `Undo the transfer link first.` · `Couldn't reach Wealthfolio — nothing undone.` · `It has changed since — nothing was undone.` (`redone` for a redo) · `That one is already undone.` · `Wealthfolio refused it as an exact copy of a transaction it already has — nothing changed.` Every other user-facing string is spelled out in its task.
- **Kinds (verbatim):** sync decisions (gated, override-backed) `transfer-link`, `transfer-type`, `duplicate-removed`, `balance-correction`, `import`, `amazon-label`; companion-only `category-filed`, `opening-balance-filed`, `category-rule-created`; also undoable `mapping-rule-created`, `starting-balance`, `starting-balance-moved`. `bank-update`, `pending-removed`, `bookkeeping`, `account-created` and any entry carrying `reverses` offer nothing.
- **Telegram:** legacy `Markdown`; bank and user text (summaries, category names in results) through `escapeMarkdown` AND outside every `*…*`/`_…_`. Prefix `cz:cl:`; a button on an entry's screen is `cz:cl:x<u|r|f|s><8-hex handle>:<back view>` (`u` undo, `r` redo, `f` undo rule + un-file, `s` sync now), always ≤ 64 bytes. Buttons: `↩ Undo`, `Redo`, `↩ Undo rule`, `↩ Undo rule + un-file N`, `🔄 Sync now`, `‹ Back`. Results: `✅ <message>` / `⚠️ <message>`, then `Takes effect on the next sync.` when a sync applies it. Toasts: `Syncing…` / `Already syncing — hang on.`
- **App:** no emoji in app copy (`src/pages/copy-policy.test.tsx`); buttons `Undo`, `Redo`, `Sync now`, `Remove`; an undone row reads `· Undone by you <Mon D>`; new CSS classes are `.sfin-log-*`, each column-0 selector defined once (`src/components/theme-styles.test.ts`); bank text renders as React text.
- **Tests use a fixed `now`.** Shared/app: `vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(...)`, `vi.useRealTimers()` after; anything rendering a clock or a day uses the local `new Date(2026, 9, 13, h, m)` constructor. Sync-core and runner tests use `shared/fake-host.ts` (`upstreamWriteRules: true` where Wealthfolio's linked-pair and fingerprint rules matter).
- **Imports:** shared sources import siblings WITH `.js`; `src/` imports shared WITHOUT an extension; companion imports `'../../shared/x.js'` and `'./x.js'`.
- **Gates before calling a task done:** the touched project's tests, plus `npm run type-check` when `src/` or `shared/` changed and `npm --prefix companion run build` when `companion/` or `shared/` changed. Final task: `npm test`, `npm --prefix companion test`, `npm run type-check`, `npm --prefix companion run build`.
- **Edits are exact.** Every "Replace" block below is copied from the file as it stands after the previous tasks (and the earlier edits of the same file in the same task) and occurs exactly once; replace it verbatim (the Edit tool's `old_string` → `new_string`). Apply a file's numbered edits in order. Every "Create" block is the whole file.
- **No version bump, tag or release.** CHANGELOG goes under `[Unreleased]`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **Undo a filing after the person re-filed it** → refused with "It has changed since — nothing was undone.", nothing written (no assign/unassign, no setting, no log entry). Pinned in Task 4 (`refuses an undo of a filing the person re-filed since, and plans nothing`) and Task 5 (`refuses to undo a filing the person re-filed since, and writes nothing`).
- **Undo a transfer link** → `notTransfer` on both legs; the next sync deletes both rows in one request and re-creates them as ordinary money (`WITHDRAWAL` + `CREDIT` for a Citi payment), never updating a linked leg; the sync after that writes nothing and pairing never links them again. Pinned in Task 3 (`unlinks an already-linked pair, retypes both halves, and the next sync does not re-link them`; `on a host that cannot read groups, finds the partner in the ledger and clears both legs from it`) and Task 4 (`a link: notTransfer on both legs, then a sync; a redo clears both`).
- **A corrupt `sync_overrides`** → every sync behaves as today, every override write is refused with the clear message and the stored text stays byte-identical. Pinned in Task 1 (`never overwrites a corrupt document: refused with a clear message, the stored text byte-identical`; `gives the sync an empty document for corrupt, absent and unreadable alike`), Task 2 (`reads a corrupt document, an absent one and a failed read as empty, so the sync behaves as today`; `an empty document changes nothing about a run`), Task 5 (`a corrupt sync_overrides refuses the undo with a clear message, nothing overwritten or written`), Task 8 (`flags a corrupt document, and refuses to overwrite it`) and Task 9 (`an unreadable document: the notice, no Remove`).
- **An old companion version** → in the app, a sync decision's Undo is disabled with exactly "Update the companion first"; Redo and non-sync kinds are not gated. Pinned in Task 4 (`an old companion disables a sync decision’s Undo in the app, with the exact copy`; `a Redo, and an undo that sets no override, never wait for the companion`), Task 5 (`the app: a category entry points at Telegram; an old companion blocks a sync decision`) and Task 9 (`an old companion disables a sync decision’s Undo: "Update the companion first"`).
- **Undo → redo → undo on one entry** → the row, the override and the log stay consistent: the redo re-creates the row under a new id, the second undo removes THAT row, three `reverses` entries alternate, a fourth (stale) Undo is refused writing nothing. Pinned in Task 5 (`undo → redo → undo on one entry: the row, the override and the log stay consistent`; `deletes by id, re-creates on a redo, and the next undo deletes the new one`).
- **Undoing a duplicate removal Wealthfolio refuses as an exact copy** → nothing changes (no row, `keepDuplicate` taken back out, no log entry) and the answer says why. Pinned in Task 5 (`a duplicate Wealthfolio refuses as an exact copy: nothing changes, and it says why`) and Task 4 (the copy).

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/sync-overrides.ts` (create) | The `sync_overrides` document: types, parse, load, `syncOverridesOrEmpty`, `editSyncOverrides`, the pure edits, pruning, `overrideRows`/`removeOverrideRow`. |
| `shared/skipped-transactions.ts` (modify) | Strict parse and `editSkippedTransactions` for Undo of an import. |
| `shared/sync-host.ts` (modify) | `SyncStore.getSyncOverrides?`; `listAccounts` may carry `currency`. |
| `shared/sync-core.ts` (modify) | Obeys every override; the unlink step. |
| `shared/link-pair.ts` (modify) | `unlinkPairByRecreate`. |
| `shared/change-entries.ts` (modify) | `transfer-unlink` bookkeeping, the `undone` transfer-type fact, `reversalChange`. |
| `shared/version.ts` (modify) | `SYNC_OVERRIDES_SINCE`, `companionUnderstandsOverrides`. |
| `shared/change-undo.ts` (create) | Pure planners per kind, `undoAvailability`, `latestReversal`, `currentRowId`/`currentRuleId`, the copy. |
| `shared/change-undo-run.ts` (create) | `UndoIo`, `runChangeUndo`: gather, plan, overrides first, reverse, record. |
| `shared/fake-host.ts` (modify) | `syncOverrides` seed. |
| `src/utils/secrets.ts` (modify) | `getSyncOverrides`, `readSyncOverrides`, `editSyncOverrides`; Reset clears `sync_overrides`. |
| `src/utils/addon-host.ts`, `companion/src/rest-host.ts` (modify) | `currency` on `listAccounts`; `RestSyncStore.getSyncOverrides`. |
| `src/utils/change-undo.ts` (create) | The add-on's `UndoIo` and `undoFromApp`. |
| `companion/src/wealthfolio.ts` (modify) | `getActivityAssignments`, `listCategorizationRules`, `deleteCategorizationRule`. |
| `companion/src/sqlite-native.ts` (modify) | `getNativeRuleFiledActivityIds`. |
| `companion/src/amazon-filing.ts`, `companion/src/opening-balance-category.ts` (modify) | Skip `noAutoFile` / `noOpeningFile`. |
| `companion/src/change-undo-host.ts` (create) | The companion's `UndoIo`; N for "un-file N". |
| `companion/src/changes-menu.ts` (modify) | Undo / Redo / Sync now on an entry's screen. |
| `companion/src/index.ts` (modify) | Overrides into the filers; `startTelegramSync`; the menu's undo deps. |
| `src/components/ChangeLogCard.tsx`, `src/components/ui.tsx`, `src/tabs/SettingsTab.tsx` (modify) | Undo/Redo, "Undone by you", Sync now, "Your overrides". |
| `CHANGELOG.md`, `README.md`, `docs/superpowers/follow-ups.md` (modify) | Docs and follow-ups §9. |

---

### Task 1: The overrides document, and a skip list that is safe to write

The document every sync reads and every Undo of a sync decision writes (spec B1, rulings U2 and L2): corrupt-aware parse, ONE re-read-before-write edit, the pure edits both writers share, year-old pruning, and the words "Your overrides" lists. The skip list (`skipped_transactions`, honoured by the sync since 1.58 but only ever written by a hand-run tool) gains a strict parse and one edit path, because Undo of an import is the first app or bot code to WRITE it — and its existing reader drops malformed entries silently, so a write built on that reader would delete them. Pure; no host.

**Files:**
- Create: `shared/sync-overrides.ts`
- Create: `shared/sync-overrides.test.ts`
- Modify: `shared/skipped-transactions.ts` (append the write path)
- Create: `shared/skipped-transactions.test.ts`

**Interfaces:**
- Consumes: `SecretGet = (key: string) => Promise<string | null>` and `SecretSet = (key: string, value: string) => Promise<void>` (`shared/subscription-prefs.ts`); `SkippedTransaction { account: string; txId: string; note?: string; at?: string }`, `SKIPPED_TRANSACTIONS_SECRET_KEY = 'skipped_transactions'`, `parseSkippedTransactions` (existing, `shared/skipped-transactions.ts`); `accountTxKey(accountId, txId)` (`shared/transfers.ts`, tests only).
- Produces (`shared/sync-overrides.ts`):

```ts
export const SYNC_OVERRIDES_SECRET_KEY = 'sync_overrides';
export const TX_OVERRIDE_KEEP_DAYS = 365;
export const TX_OVERRIDE_FLAGS: readonly ['notTransfer', 'keepDuplicate', 'noAutoFile', 'noAmazonLabel'];
export type TxOverrideFlag = 'notTransfer' | 'keepDuplicate' | 'noAutoFile' | 'noAmazonLabel';
export const ACCOUNT_OVERRIDE_FLAGS: readonly ['noAutoCorrect', 'noOpeningFile'];
export type AccountOverrideFlag = 'noAutoCorrect' | 'noOpeningFile';
export interface TxOverride { notTransfer?: true; keepDuplicate?: true; noAutoFile?: true; noAmazonLabel?: true; at: string; entryId?: string; label?: string }
export interface AccountOverride { noAutoCorrect?: true; noOpeningFile?: true; at: string; label?: string }
export interface SyncOverrides { v: 1; tx: Record<string, TxOverride>; accounts: Record<string, AccountOverride> }
export type ParsedSyncOverrides = { kind: 'ok'; overrides: SyncOverrides } | { kind: 'absent' } | { kind: 'corrupt' };
export interface LoadedSyncOverrides { overrides: SyncOverrides; unreadable: boolean }
export type SyncOverridesEdit = (o: SyncOverrides) => SyncOverrides;
export const SYNC_OVERRIDES_UNREADABLE_MESSAGE = "Your sync overrides can't be read, so nothing was changed.";
export class SyncOverridesUnreadableError extends Error {}   // name 'SyncOverridesUnreadableError'
export class SyncOverridesInvalidError extends Error {}
export function isUnreadableOverridesError(err: unknown): boolean;
export function emptySyncOverrides(): SyncOverrides;
export function parseSyncOverrides(raw: string | null | undefined): ParsedSyncOverrides;
export async function loadSyncOverrides(get: SecretGet): Promise<LoadedSyncOverrides>;   // rejects when the read fails
export async function syncOverridesOrEmpty(get: SecretGet): Promise<SyncOverrides>;      // never rejects
export async function editSyncOverrides(get: SecretGet, set: SecretSet, edit: SyncOverridesEdit, now?: Date): Promise<SyncOverrides>;
export function setTxOverride(o: SyncOverrides, txKey: string, flag: TxOverrideFlag, now: Date, extra?: { entryId?: string; label?: string }): SyncOverrides;
export function clearTxOverride(o: SyncOverrides, txKey: string, flag: TxOverrideFlag): SyncOverrides;
export function setAccountOverride(o: SyncOverrides, sfinId: string, flag: AccountOverrideFlag, now: Date, extra?: { label?: string }): SyncOverrides;
export function clearAccountOverride(o: SyncOverrides, sfinId: string, flag: AccountOverrideFlag): SyncOverrides;
export function pruneTxOverrides(o: SyncOverrides, now: Date): SyncOverrides;
export function hasTxOverride(o: SyncOverrides, txKey: string, flag: TxOverrideFlag): boolean;
export function hasAccountOverride(o: SyncOverrides, sfinId: string, flag: AccountOverrideFlag): boolean;
export const OVERRIDE_FLAG_WORDS: Record<TxOverrideFlag | AccountOverrideFlag, string>;
export interface OverrideRow { scope: 'tx' | 'account'; key: string; flag: TxOverrideFlag | AccountOverrideFlag; text: string; at: string }
export function overrideRows(o: SyncOverrides): OverrideRow[];
export function removeOverrideRow(o: SyncOverrides, row: Pick<OverrideRow, 'scope' | 'key' | 'flag'>): SyncOverrides;
```

- Produces (`shared/skipped-transactions.ts`, appended):

```ts
export type ParsedSkippedTransactions = { kind: 'ok'; list: SkippedTransaction[] } | { kind: 'absent' } | { kind: 'corrupt' };
export function parseSkippedTransactionsStrict(raw: string | null | undefined): ParsedSkippedTransactions;
export class SkippedTransactionsUnreadableError extends Error {}
export async function editSkippedTransactions(get, set, edit: (list: SkippedTransaction[]) => SkippedTransaction[]): Promise<SkippedTransaction[]>;
export function withSkipped(list: SkippedTransaction[], entry: SkippedTransaction): SkippedTransaction[];   // once per (account, txId)
export function withoutSkipped(list: SkippedTransaction[], account: string, txId: string): SkippedTransaction[];
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/sync-overrides.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  clearAccountOverride, clearTxOverride, editSyncOverrides, emptySyncOverrides, hasAccountOverride, hasTxOverride,
  isUnreadableOverridesError, loadSyncOverrides, overrideRows, parseSyncOverrides, pruneTxOverrides, removeOverrideRow,
  setAccountOverride, setTxOverride, SYNC_OVERRIDES_SECRET_KEY, SYNC_OVERRIDES_UNREADABLE_MESSAGE, syncOverridesOrEmpty,
  SyncOverridesInvalidError, type SyncOverrides,
} from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-13T15:00:00Z');
const OUT = accountTxKey('ACT-1f2e', 'TRN-a1b2');
const IN = accountTxKey('ACT-9c8d', 'TRN-a1b2');

/** A secrets map behind the two functions the edit path takes. */
function secrets(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
  };
}

describe('parseSyncOverrides', () => {
  it('reads nothing stored, and the companion\'s cleared value, as absent', () => {
    expect(parseSyncOverrides(null)).toEqual({ kind: 'absent' });
    expect(parseSyncOverrides('')).toEqual({ kind: 'absent' });
    expect(parseSyncOverrides('  ')).toEqual({ kind: 'absent' });
  });

  it('reads a well-formed document, keys with the NUL separator included', () => {
    const doc: SyncOverrides = {
      v: 1,
      tx: { [OUT]: { notTransfer: true, at: '2026-10-12T09:00:00.000Z', entryId: 'c1', label: 'CITI AUTOPAY · Checking' } },
      accounts: { 'ACT-9c8d': { noOpeningFile: true, at: '2026-10-12T09:00:00.000Z', label: 'Citi Card' } },
    };
    expect(parseSyncOverrides(JSON.stringify(doc))).toEqual({ kind: 'ok', overrides: doc });
    expect(parseSyncOverrides('{"v":1}')).toEqual({ kind: 'ok', overrides: emptySyncOverrides() });
  });

  it.each([
    ['not JSON', '{v:1'],
    ['a list', '[]'],
    ['another version', '{"v":2,"tx":{},"accounts":{}}'],
    ['an unknown top-level field', '{"v":1,"tx":{},"accounts":{},"extra":1}'],
    ['a flag that is not true', `{"v":1,"tx":{"k":{"notTransfer":false,"at":"2026-10-12T09:00:00Z"}},"accounts":{}}`],
    ['an unknown flag', `{"v":1,"tx":{"k":{"noSync":true,"at":"2026-10-12T09:00:00Z"}},"accounts":{}}`],
    ['an account flag on a transaction', `{"v":1,"tx":{"k":{"noAutoCorrect":true,"at":"2026-10-12T09:00:00Z"}},"accounts":{}}`],
    ['a missing time', `{"v":1,"tx":{"k":{"notTransfer":true}},"accounts":{}}`],
    ['a time that is not a time', `{"v":1,"tx":{},"accounts":{"a":{"noAutoCorrect":true,"at":"yesterday"}}}`],
    ['tx as a list', '{"v":1,"tx":[],"accounts":{}}'],
  ])('reads %s as corrupt', (_name, raw) => {
    expect(parseSyncOverrides(raw)).toEqual({ kind: 'corrupt' });
  });
});

describe('loading', () => {
  it('flags a corrupt document as unreadable and hands back an empty one', async () => {
    const s = secrets({ [SYNC_OVERRIDES_SECRET_KEY]: '{not json' });
    expect(await loadSyncOverrides(s.get)).toEqual({ overrides: emptySyncOverrides(), unreadable: true });
  });

  it('rejects when the read itself fails, so unreachable never reads as "no overrides"', async () => {
    await expect(loadSyncOverrides(async () => { throw new Error('ECONNREFUSED'); })).rejects.toThrow('ECONNREFUSED');
  });

  it('gives the sync an empty document for corrupt, absent and unreadable alike', async () => {
    expect(await syncOverridesOrEmpty(secrets({ [SYNC_OVERRIDES_SECRET_KEY]: 'garbage' }).get)).toEqual(emptySyncOverrides());
    expect(await syncOverridesOrEmpty(secrets().get)).toEqual(emptySyncOverrides());
    expect(await syncOverridesOrEmpty(async () => { throw new Error('down'); })).toEqual(emptySyncOverrides());
  });
});

describe('editSyncOverrides', () => {
  it('re-reads before writing, so an override another writer just saved is kept', async () => {
    const s = secrets();
    const edit = (o: SyncOverrides) => setTxOverride(o, OUT, 'notTransfer', NOW);
    // The other writer lands between this tab's load and its edit.
    s.store.set(SYNC_OVERRIDES_SECRET_KEY, JSON.stringify(setAccountOverride(emptySyncOverrides(), 'ACT-9c8d', 'noAutoCorrect', NOW)));
    const next = await editSyncOverrides(s.get, s.set, edit, NOW);
    expect(hasTxOverride(next, OUT, 'notTransfer')).toBe(true);
    expect(hasAccountOverride(next, 'ACT-9c8d', 'noAutoCorrect')).toBe(true);
    expect(JSON.parse(s.store.get(SYNC_OVERRIDES_SECRET_KEY)!)).toEqual(next);
  });

  it('never overwrites a corrupt document: refused with a clear message, the stored text byte-identical', async () => {
    const corrupt = '{"v":1,"tx":{"k":{"notTransfer":"yes"}}}';
    const s = secrets({ [SYNC_OVERRIDES_SECRET_KEY]: corrupt });
    const err = await editSyncOverrides(s.get, s.set, (o) => setTxOverride(o, OUT, 'notTransfer', NOW), NOW).catch((e) => e);
    expect(isUnreadableOverridesError(err)).toBe(true);
    expect(err.message).toBe(SYNC_OVERRIDES_UNREADABLE_MESSAGE);
    expect(s.set).not.toHaveBeenCalled();
    expect(s.store.get(SYNC_OVERRIDES_SECRET_KEY)).toBe(corrupt);
  });

  it('never writes a document the parser would refuse', async () => {
    const s = secrets();
    const bad = (o: SyncOverrides) => ({ ...o, tx: { k: { notTransfer: true, at: NOW.toISOString(), label: 5 } } } as unknown as SyncOverrides);
    await expect(editSyncOverrides(s.get, s.set, bad, NOW)).rejects.toBeInstanceOf(SyncOverridesInvalidError);
    expect(s.set).not.toHaveBeenCalled();
  });

  it('drops transaction overrides older than a year on write, and keeps account switches', async () => {
    const old = new Date('2025-10-12T14:59:00Z');
    const start = setAccountOverride(setTxOverride(emptySyncOverrides(), IN, 'keepDuplicate', old), 'ACT-1f2e', 'noAutoCorrect', old);
    const s = secrets({ [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(start) });
    const next = await editSyncOverrides(s.get, s.set, (o) => setTxOverride(o, OUT, 'noAutoFile', NOW), NOW);
    expect(Object.keys(next.tx)).toEqual([OUT]);
    expect(hasAccountOverride(next, 'ACT-1f2e', 'noAutoCorrect')).toBe(true);
  });
});

describe('the pure edits', () => {
  it('sets and clears transaction flags, dropping an entry with none left', () => {
    let o = setTxOverride(emptySyncOverrides(), OUT, 'notTransfer', NOW, { entryId: 'c1', label: 'CITI AUTOPAY · Checking' });
    o = setTxOverride(o, OUT, 'noAutoFile', NOW);
    expect(o.tx[OUT]).toEqual({ notTransfer: true, noAutoFile: true, at: NOW.toISOString(), entryId: 'c1', label: 'CITI AUTOPAY · Checking' });
    o = clearTxOverride(o, OUT, 'notTransfer');
    expect(hasTxOverride(o, OUT, 'notTransfer')).toBe(false);
    expect(hasTxOverride(o, OUT, 'noAutoFile')).toBe(true);
    o = clearTxOverride(o, OUT, 'noAutoFile');
    expect(o.tx).toEqual({});
    expect(clearTxOverride(o, 'missing', 'notTransfer')).toBe(o);
  });

  it('keeps the two legs of one shared transaction id apart', () => {
    const o = setTxOverride(emptySyncOverrides(), OUT, 'notTransfer', NOW);
    expect(hasTxOverride(o, OUT, 'notTransfer')).toBe(true);
    expect(hasTxOverride(o, IN, 'notTransfer')).toBe(false);
  });

  it('sets and clears account flags', () => {
    let o = setAccountOverride(emptySyncOverrides(), 'ACT-9c8d', 'noOpeningFile', NOW, { label: 'Citi Card' });
    expect(hasAccountOverride(o, 'ACT-9c8d', 'noOpeningFile')).toBe(true);
    expect(hasAccountOverride(o, 'ACT-9c8d', 'noAutoCorrect')).toBe(false);
    o = clearAccountOverride(o, 'ACT-9c8d', 'noOpeningFile');
    expect(o.accounts).toEqual({});
  });

  it('never reads a key named after an Object method as an override', () => {
    expect(hasTxOverride(emptySyncOverrides(), 'constructor', 'notTransfer')).toBe(false);
    expect(hasAccountOverride(emptySyncOverrides(), '__proto__', 'noAutoCorrect')).toBe(false);
  });

  it('prunes by the time each entry was set', () => {
    const o = setTxOverride(setTxOverride(emptySyncOverrides(), OUT, 'notTransfer', new Date('2025-10-01T00:00:00Z')), IN, 'notTransfer', NOW);
    expect(Object.keys(pruneTxOverrides(o, NOW).tx)).toEqual([IN]);
    const fresh = setTxOverride(emptySyncOverrides(), IN, 'notTransfer', NOW);
    expect(pruneTxOverrides(fresh, NOW)).toBe(fresh);
  });
});

describe('overrideRows', () => {
  it('lists one row per flag, newest first, in words', () => {
    let o = setTxOverride(emptySyncOverrides(), OUT, 'notTransfer', new Date('2026-10-12T09:00:00Z'), { label: 'CITI AUTOPAY · Checking' });
    o = setTxOverride(o, IN, 'keepDuplicate', new Date('2026-10-11T09:00:00Z'));
    o = setAccountOverride(o, 'ACT-9c8d', 'noAutoCorrect', NOW, { label: 'Citi Card' });
    expect(overrideRows(o).map((r) => r.text)).toEqual([
      'No automatic balance corrections: Citi Card',
      'Not a transfer: CITI AUTOPAY · Checking',
      'Keep both copies: TRN-a1b2',
    ]);
  });

  it('removes exactly the row asked for', () => {
    let o = setTxOverride(emptySyncOverrides(), OUT, 'notTransfer', NOW);
    o = setTxOverride(o, OUT, 'noAmazonLabel', NOW);
    const [first] = overrideRows(o).filter((r) => r.flag === 'noAmazonLabel');
    const next = removeOverrideRow(o, first);
    expect(overrideRows(next).map((r) => r.flag)).toEqual(['notTransfer']);
  });
});
```

**Create `shared/skipped-transactions.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  editSkippedTransactions, parseSkippedTransactions, parseSkippedTransactionsStrict, SKIPPED_TRANSACTIONS_SECRET_KEY,
  SkippedTransactionsUnreadableError, withoutSkipped, withSkipped,
} from './skipped-transactions.js';

function secrets(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
  };
}

const PNC = { account: 'ACT-1f2e', txId: 'TRN-600', note: 'reported twice by the bank feed', at: '2026-10-09T12:00:00Z' };

describe('parseSkippedTransactionsStrict', () => {
  it('tells absent, ok and corrupt apart, where the lenient reader cannot', () => {
    expect(parseSkippedTransactionsStrict(null)).toEqual({ kind: 'absent' });
    expect(parseSkippedTransactionsStrict('')).toEqual({ kind: 'absent' });
    expect(parseSkippedTransactionsStrict(JSON.stringify([PNC]))).toEqual({ kind: 'ok', list: [PNC] });
    const half = JSON.stringify([PNC, { account: 'x' }]);
    expect(parseSkippedTransactionsStrict(half)).toEqual({ kind: 'corrupt' });
    expect(parseSkippedTransactions(half)).toEqual([PNC]);
    expect(parseSkippedTransactionsStrict('{"account":"x"}')).toEqual({ kind: 'corrupt' });
    expect(parseSkippedTransactionsStrict('[')).toEqual({ kind: 'corrupt' });
  });
});

describe('editSkippedTransactions', () => {
  it('adds once per account and transaction, and removes', async () => {
    const s = secrets({ [SKIPPED_TRANSACTIONS_SECRET_KEY]: JSON.stringify([PNC]) });
    const entry = { account: 'ACT-9c8d', txId: 'TRN-600', note: 'Undone in the change log', at: '2026-10-13T15:00:00.000Z' };
    await editSkippedTransactions(s.get, s.set, (l) => withSkipped(l, entry));
    await editSkippedTransactions(s.get, s.set, (l) => withSkipped(l, entry));
    expect(JSON.parse(s.store.get(SKIPPED_TRANSACTIONS_SECRET_KEY)!)).toEqual([PNC, entry]);
    await editSkippedTransactions(s.get, s.set, (l) => withoutSkipped(l, 'ACT-9c8d', 'TRN-600'));
    expect(JSON.parse(s.store.get(SKIPPED_TRANSACTIONS_SECRET_KEY)!)).toEqual([PNC]);
  });

  it('never overwrites a list it cannot read in full', async () => {
    const raw = JSON.stringify([PNC, { txId: 'no account' }]);
    const s = secrets({ [SKIPPED_TRANSACTIONS_SECRET_KEY]: raw });
    await expect(editSkippedTransactions(s.get, s.set, (l) => l)).rejects.toBeInstanceOf(SkippedTransactionsUnreadableError);
    expect(s.set).not.toHaveBeenCalled();
    expect(s.store.get(SKIPPED_TRANSACTIONS_SECRET_KEY)).toBe(raw);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/sync-overrides.test.ts shared/skipped-transactions.test.ts`
Expected: FAIL — `./sync-overrides.js` does not exist yet, and `parseSkippedTransactionsStrict` / `editSkippedTransactions` are not exported.

- [ ] **Step 3: Implement**

**Create `shared/sync-overrides.ts`:**

```ts
/**
 * shared/sync-overrides.ts
 *
 * What the person told the sync NOT to do again: the document an Undo of a
 * sync decision writes, and every sync — the add-on's and the companion's —
 * reads before it decides anything. Undo records the override; the sync
 * applies it. Without it, the next sync would simply make the same decision
 * again.
 *
 * Per transaction (`tx`, keyed by `accountTxKey`, so a shared SimpleFin id in
 * two accounts stays two entries):
 *  - `notTransfer`   never paired or linked; keywords and mapping rules do not
 *                    type it as a transfer; a linked pair with such a leg is
 *                    unlinked on the next sync.
 *  - `keepDuplicate` the duplicate prune leaves its copies.
 *  - `noAutoFile`    the Amazon filer leaves it.
 *  - `noAmazonLabel` no Amazon label is added to its note.
 * Per SimpleFin account (`accounts`):
 *  - `noAutoCorrect` no automatic balance correction (drift is still reported).
 *  - `noOpeningFile` the card opening-balance filer leaves its opening balance.
 *
 * Two writers share it (the app and the bot), so every write goes through
 * `editSyncOverrides`, which re-reads immediately before writing and applies
 * one of the pure edits below — the same safety as `subscription_prefs`.
 *
 * Corrupt is not absent. A stored document that cannot be read is never
 * overwritten (every write is refused) and the sync treats it as empty, which
 * is exactly how it behaved before overrides existed.
 */
import type { SecretGet, SecretSet } from './subscription-prefs.js';

export const SYNC_OVERRIDES_SECRET_KEY = 'sync_overrides';
/** Transaction overrides older than this are dropped on the next write. */
export const TX_OVERRIDE_KEEP_DAYS = 365;

export const TX_OVERRIDE_FLAGS = ['notTransfer', 'keepDuplicate', 'noAutoFile', 'noAmazonLabel'] as const;
export type TxOverrideFlag = (typeof TX_OVERRIDE_FLAGS)[number];
export const ACCOUNT_OVERRIDE_FLAGS = ['noAutoCorrect', 'noOpeningFile'] as const;
export type AccountOverrideFlag = (typeof ACCOUNT_OVERRIDE_FLAGS)[number];

export interface TxOverride {
  notTransfer?: true;
  keepDuplicate?: true;
  noAutoFile?: true;
  noAmazonLabel?: true;
  /** When it was last set (ISO). */
  at: string;
  /** The change-log entry whose undo set it. */
  entryId?: string;
  /** What it is, in words ("CITI AUTOPAY · Checking"), for the overrides list —
   *  the change log keeps 90 days, an override a year. */
  label?: string;
}

export interface AccountOverride {
  noAutoCorrect?: true;
  noOpeningFile?: true;
  at: string;
  /** The account's name, for the overrides list. */
  label?: string;
}

export interface SyncOverrides {
  v: 1;
  tx: Record<string, TxOverride>;
  accounts: Record<string, AccountOverride>;
}

export type ParsedSyncOverrides =
  | { kind: 'ok'; overrides: SyncOverrides }
  | { kind: 'absent' }
  | { kind: 'corrupt' };

export interface LoadedSyncOverrides {
  overrides: SyncOverrides;
  /** A stored document exists but cannot be read: `overrides` is empty and
   *  every write is refused. */
  unreadable: boolean;
}

export type SyncOverridesEdit = (o: SyncOverrides) => SyncOverrides;

export const SYNC_OVERRIDES_UNREADABLE_MESSAGE = "Your sync overrides can't be read, so nothing was changed.";

export class SyncOverridesUnreadableError extends Error {
  constructor() {
    super(SYNC_OVERRIDES_UNREADABLE_MESSAGE);
    this.name = 'SyncOverridesUnreadableError';
  }
}

/** The edit produced a document this module could not read back. Nothing is saved. */
export class SyncOverridesInvalidError extends Error {
  constructor() {
    super('That override was invalid — nothing was saved.');
    this.name = 'SyncOverridesInvalidError';
  }
}

/** By name as well as by class: a bundle or a test double can carry its own copy of the class. */
export function isUnreadableOverridesError(err: unknown): boolean {
  return err instanceof SyncOverridesUnreadableError
    || (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'SyncOverridesUnreadableError');
}

export function emptySyncOverrides(): SyncOverrides {
  return { v: 1, tx: {}, accounts: {} };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Own-property lookup: `in` and bare indexing see the prototype. */
const own = (rec: object, key: string): boolean => Object.prototype.hasOwnProperty.call(rec, key);
const isIso = (x: unknown): x is string => typeof x === 'string' && !Number.isNaN(Date.parse(x));

/** Every key known and well-shaped; a flag is only ever `true`. An unknown key
 *  is corruption: a newer document shape needs `v: 2`, or an older writer would
 *  drop what it does not know on its next write. */
function isEntry(v: unknown, flags: readonly string[]): boolean {
  if (!isRecord(v) || !isIso(v.at)) return false;
  return Object.entries(v).every(([k, x]) => {
    if (flags.includes(k)) return x === true;
    if (k === 'at') return true;
    if (k === 'entryId' || k === 'label') return typeof x === 'string';
    return false;
  });
}

export function parseSyncOverrides(raw: string | null | undefined): ParsedSyncOverrides {
  // '' is how the companion clears a secret: its API has no delete.
  if (raw === null || raw === undefined || raw.trim() === '') return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!isRecord(parsed) || parsed.v !== 1) return { kind: 'corrupt' };
  if (Object.keys(parsed).some((k) => k !== 'v' && k !== 'tx' && k !== 'accounts')) return { kind: 'corrupt' };
  const tx = parsed.tx === undefined ? {} : parsed.tx;
  const accounts = parsed.accounts === undefined ? {} : parsed.accounts;
  if (!isRecord(tx) || !Object.values(tx).every((e) => isEntry(e, TX_OVERRIDE_FLAGS))) return { kind: 'corrupt' };
  if (!isRecord(accounts) || !Object.values(accounts).every((e) => isEntry(e, ACCOUNT_OVERRIDE_FLAGS))) return { kind: 'corrupt' };
  return {
    kind: 'ok',
    overrides: {
      v: 1,
      tx: Object.fromEntries(Object.entries(tx)) as Record<string, TxOverride>,
      accounts: Object.fromEntries(Object.entries(accounts)) as Record<string, AccountOverride>,
    },
  };
}

/** The document for a screen that edits it. A failed read rejects: unreachable
 *  must never read as "no overrides". */
export async function loadSyncOverrides(get: SecretGet): Promise<LoadedSyncOverrides> {
  const parsed = parseSyncOverrides(await get(SYNC_OVERRIDES_SECRET_KEY));
  if (parsed.kind === 'ok') return { overrides: parsed.overrides, unreadable: false };
  return { overrides: emptySyncOverrides(), unreadable: parsed.kind === 'corrupt' };
}

/** What a sync obeys. Absent, corrupt and unreadable all read as empty — the
 *  sync then behaves exactly as it did before overrides existed. */
export async function syncOverridesOrEmpty(get: SecretGet): Promise<SyncOverrides> {
  try {
    return (await loadSyncOverrides(get)).overrides;
  } catch {
    return emptySyncOverrides();
  }
}

/**
 * The only write. Re-reads immediately before writing (two writers, no
 * compare-and-swap; taps are human-paced, so the residual race is accepted),
 * applies `edit`, drops year-old transaction entries, and refuses to write a
 * document the parser would reject.
 */
export async function editSyncOverrides(
  get: SecretGet,
  set: SecretSet,
  edit: SyncOverridesEdit,
  now: Date = new Date(),
): Promise<SyncOverrides> {
  const parsed = parseSyncOverrides(await get(SYNC_OVERRIDES_SECRET_KEY));
  if (parsed.kind === 'corrupt') throw new SyncOverridesUnreadableError();
  const base = parsed.kind === 'ok' ? parsed.overrides : emptySyncOverrides();
  const next = pruneTxOverrides(edit(base), now);
  const body = JSON.stringify(next);
  if (parseSyncOverrides(body).kind !== 'ok') throw new SyncOverridesInvalidError();
  await set(SYNC_OVERRIDES_SECRET_KEY, body);
  return next;
}

/** A record with one key replaced or removed, built with `Object.fromEntries`
 *  so no key — however odd — can reach the prototype. */
function withKey<T>(rec: Record<string, T>, key: string, value: T | null): Record<string, T> {
  const rest = Object.entries(rec).filter(([k]) => k !== key);
  return Object.fromEntries(value === null ? rest : [...rest, [key, value]]);
}

const hasAnyFlag = (entry: object, flags: readonly string[]) => flags.some((f) => own(entry, f));

export function setTxOverride(
  o: SyncOverrides,
  txKey: string,
  flag: TxOverrideFlag,
  now: Date,
  extra: { entryId?: string; label?: string } = {},
): SyncOverrides {
  const prev = own(o.tx, txKey) ? o.tx[txKey] : undefined;
  const entry: TxOverride = {
    ...(prev ?? {}),
    [flag]: true,
    at: now.toISOString(),
    ...(extra.entryId ? { entryId: extra.entryId } : {}),
    ...(extra.label ? { label: extra.label } : {}),
  };
  return { ...o, tx: withKey(o.tx, txKey, entry) };
}

/** Clears one flag; the entry goes when no flag is left. */
export function clearTxOverride(o: SyncOverrides, txKey: string, flag: TxOverrideFlag): SyncOverrides {
  if (!own(o.tx, txKey)) return o;
  const { [flag]: _gone, ...rest } = o.tx[txKey];
  return { ...o, tx: withKey(o.tx, txKey, hasAnyFlag(rest, TX_OVERRIDE_FLAGS) ? (rest as TxOverride) : null) };
}

export function setAccountOverride(
  o: SyncOverrides,
  sfinId: string,
  flag: AccountOverrideFlag,
  now: Date,
  extra: { label?: string } = {},
): SyncOverrides {
  const prev = own(o.accounts, sfinId) ? o.accounts[sfinId] : undefined;
  const entry: AccountOverride = {
    ...(prev ?? {}),
    [flag]: true,
    at: now.toISOString(),
    ...(extra.label ? { label: extra.label } : {}),
  };
  return { ...o, accounts: withKey(o.accounts, sfinId, entry) };
}

export function clearAccountOverride(o: SyncOverrides, sfinId: string, flag: AccountOverrideFlag): SyncOverrides {
  if (!own(o.accounts, sfinId)) return o;
  const { [flag]: _gone, ...rest } = o.accounts[sfinId];
  return { ...o, accounts: withKey(o.accounts, sfinId, hasAnyFlag(rest, ACCOUNT_OVERRIDE_FLAGS) ? (rest as AccountOverride) : null) };
}

/** Drops transaction entries set more than a year ago. Account switches stay
 *  until they are changed. */
export function pruneTxOverrides(o: SyncOverrides, now: Date): SyncOverrides {
  const cutoff = now.getTime() - TX_OVERRIDE_KEEP_DAYS * 86_400_000;
  const kept = Object.entries(o.tx).filter(([, e]) => Date.parse(e.at) >= cutoff);
  if (kept.length === Object.keys(o.tx).length) return o;
  return { ...o, tx: Object.fromEntries(kept) };
}

export function hasTxOverride(o: SyncOverrides, txKey: string, flag: TxOverrideFlag): boolean {
  return own(o.tx, txKey) && o.tx[txKey][flag] === true;
}

export function hasAccountOverride(o: SyncOverrides, sfinId: string, flag: AccountOverrideFlag): boolean {
  return own(o.accounts, sfinId) && o.accounts[sfinId][flag] === true;
}

/** What each override means, in the words the overrides list uses. */
export const OVERRIDE_FLAG_WORDS: Record<TxOverrideFlag | AccountOverrideFlag, string> = {
  notTransfer: 'Not a transfer',
  keepDuplicate: 'Keep both copies',
  noAutoFile: "Don't file automatically",
  noAmazonLabel: 'No Amazon label',
  noAutoCorrect: 'No automatic balance corrections',
  noOpeningFile: "Don't file the opening balance",
};

export interface OverrideRow {
  scope: 'tx' | 'account';
  /** The `tx` key or the SimpleFin account id. */
  key: string;
  flag: TxOverrideFlag | AccountOverrideFlag;
  /** `Not a transfer: CITI AUTOPAY · Checking`. Raw text. */
  text: string;
  at: string;
}

/** One row per flag, newest first — what the app's "Your overrides" lists. An
 *  entry without a label names its transaction id (the part of the key after
 *  the account) or its account id. */
export function overrideRows(o: SyncOverrides): OverrideRow[] {
  const rows: OverrideRow[] = [];
  for (const [key, e] of Object.entries(o.tx)) {
    const name = e.label ?? key.slice(key.indexOf('\u0000') + 1);
    for (const flag of TX_OVERRIDE_FLAGS) {
      if (e[flag]) rows.push({ scope: 'tx', key, flag, text: `${OVERRIDE_FLAG_WORDS[flag]}: ${name}`, at: e.at });
    }
  }
  for (const [key, e] of Object.entries(o.accounts)) {
    const name = e.label ?? key;
    for (const flag of ACCOUNT_OVERRIDE_FLAGS) {
      if (e[flag]) rows.push({ scope: 'account', key, flag, text: `${OVERRIDE_FLAG_WORDS[flag]}: ${name}`, at: e.at });
    }
  }
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.text.localeCompare(b.text)));
}

/** The edit that removes one listed override (the list's Remove button). */
export function removeOverrideRow(o: SyncOverrides, row: Pick<OverrideRow, 'scope' | 'key' | 'flag'>): SyncOverrides {
  return row.scope === 'tx'
    ? clearTxOverride(o, row.key, row.flag as TxOverrideFlag)
    : clearAccountOverride(o, row.key, row.flag as AccountOverrideFlag);
}
```

**Edit `shared/skipped-transactions.ts`** — one edit: append the write path after `parseSkippedTransactions`.

Edit 1 of 1 in `shared/skipped-transactions.ts` — replace:

```ts
    && typeof (e as SkippedTransaction).account === 'string'
    && typeof (e as SkippedTransaction).txId === 'string');
}
```

with:

```ts
    && typeof (e as SkippedTransaction).account === 'string'
    && typeof (e as SkippedTransaction).txId === 'string');
}

// ── Writing (R2: Undo of an import) ──────────────────────────────────────

export type ParsedSkippedTransactions =
  | { kind: 'ok'; list: SkippedTransaction[] }
  | { kind: 'absent' }
  | { kind: 'corrupt' };

const isSkipEntry = (e: unknown): e is SkippedTransaction => {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const s = e as Record<string, unknown>;
  return typeof s.account === 'string' && typeof s.txId === 'string'
    && (s.note === undefined || typeof s.note === 'string')
    && (s.at === undefined || typeof s.at === 'string');
};

/** The stored list as a writer must see it: corrupt is NOT absent. Reading
 *  stays lenient (`parseSkippedTransactions`); a write over a list this cannot
 *  read in full would drop the entries it skipped. */
export function parseSkippedTransactionsStrict(raw: string | null | undefined): ParsedSkippedTransactions {
  if (raw === null || raw === undefined || raw.trim() === '') return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  return Array.isArray(parsed) && parsed.every(isSkipEntry) ? { kind: 'ok', list: parsed } : { kind: 'corrupt' };
}

export class SkippedTransactionsUnreadableError extends Error {
  constructor() {
    super("The list of transactions not to import can't be read, so nothing was changed.");
    this.name = 'SkippedTransactionsUnreadableError';
  }
}

/** The only write: re-read, edit, write. A stored list that cannot be read is
 *  never overwritten. */
export async function editSkippedTransactions(
  get: (key: string) => Promise<string | null>,
  set: (key: string, value: string) => Promise<void>,
  edit: (list: SkippedTransaction[]) => SkippedTransaction[],
): Promise<SkippedTransaction[]> {
  const parsed = parseSkippedTransactionsStrict(await get(SKIPPED_TRANSACTIONS_SECRET_KEY));
  if (parsed.kind === 'corrupt') throw new SkippedTransactionsUnreadableError();
  const next = edit(parsed.kind === 'ok' ? parsed.list : []);
  await set(SKIPPED_TRANSACTIONS_SECRET_KEY, JSON.stringify(next));
  return next;
}

export function withSkipped(list: SkippedTransaction[], entry: SkippedTransaction): SkippedTransaction[] {
  return list.some((s) => s.account === entry.account && s.txId === entry.txId) ? list : [...list, entry];
}

export function withoutSkipped(list: SkippedTransaction[], account: string, txId: string): SkippedTransaction[] {
  return list.filter((s) => !(s.account === account && s.txId === txId));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/sync-overrides.test.ts shared/skipped-transactions.test.ts`
Expected: PASS — 29 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `npm --prefix companion run build`
Expected: Succeeds (the companion compiles `shared/`).

- [ ] **Step 5: Commit**

```bash
git add shared/sync-overrides.ts shared/sync-overrides.test.ts shared/skipped-transactions.ts shared/skipped-transactions.test.ts
git commit -m "Undo: the sync overrides document, and a skip list that is safe to write

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The sync obeys keepDuplicate, noAmazonLabel and noAutoCorrect

`runSyncCore` reads the overrides ONCE per run through a new optional `SyncStore.getSyncOverrides` and obeys the three flags that change a single step (spec B1, U3): the duplicate prune leaves every copy of a `keepDuplicate` transaction; a `noAmazonLabel` charge gets no label — not from the late-label pass and not on a later create or update, though its order record is still consumed so it cannot be offered to the next charge of that amount; an account with `noAutoCorrect` gets no automatic plug while its drift is still measured and reported (Sync page, alert, the morning 🧹 list read the same snapshot). Both stores implement the getter over `syncOverridesOrEmpty`, so a corrupt document, an absent one and a failed read all mean "behave as today". `notTransfer` is Task 3.

**Files:**
- Modify: `shared/sync-host.ts`, `shared/sync-core.ts`, `shared/fake-host.ts`, `src/utils/secrets.ts`, `companion/src/rest-host.ts`
- Test: `shared/sync-core-overrides.test.ts`, `src/utils/secrets-overrides.test.ts`, `companion/src/rest-host-overrides.test.ts`

**Interfaces:**
- Consumes (Task 1, `shared/sync-overrides.ts`): `SyncOverrides`, `emptySyncOverrides()`, `hasTxOverride(o, txKey, flag)`, `hasAccountOverride(o, sfinId, flag)`, `syncOverridesOrEmpty(get)`, `setTxOverride`, `setAccountOverride`, `SYNC_OVERRIDES_SECRET_KEY`; `accountTxKey` (`shared/transfers.ts`); `createFakeHost`, `FakeHostSeed` (`shared/fake-host.ts`).
- Produces:

```ts
// shared/sync-host.ts — SyncStore gains (optional, like getSkippedTransactions):
getSyncOverrides?(): Promise<SyncOverrides>;   // corrupt / absent / failed read → empty
// shared/fake-host.ts — FakeHostSeed gains:
syncOverrides?: SyncOverrides;                 // absent: the store has no getSyncOverrides
// src/utils/secrets.ts — SecretsStore gains:
async getSyncOverrides(): Promise<SyncOverrides>;   // and KEYS.syncOverrides = SYNC_OVERRIDES_SECRET_KEY (Reset clears it)
// companion/src/rest-host.ts — RestSyncStore gains:
async getSyncOverrides(): Promise<SyncOverrides>;
```

- Inside `runSyncPass` (module-private): `const overrides: SyncOverrides`, read once next to the skip list.

- [ ] **Step 1: Write the failing tests**

**Create `shared/sync-core-overrides.test.ts`:**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChangeEntry, ChangeLogSink } from './change-entries.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import { emptySyncOverrides, setAccountOverride, setTxOverride, type SyncOverrides } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-13T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;

function capture(): ChangeLogSink & { entries: () => ChangeEntry[] } {
  const batches: ChangeEntry[][] = [];
  return {
    writer: 'companion', run: 'cRUN1',
    append: vi.fn(async (entries: ChangeEntry[]) => { batches.push(entries); }),
    entries: () => batches.flat(),
  };
}

const checking = (transactions: Array<{ id: string; posted: number; amount: string; description: string }>, balance = '0'): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [{
    id: 'sfin-1', name: 'Checking', currency: 'USD', balance, 'balance-date': epoch('2026-10-13T12:00:00Z'), transactions,
  }] },
  mapping: { 'sfin-1': 'wf-a' },
  accountTypes: { 'wf-a': 'CASH' },
  accountNames: { 'wf-a': 'Checking' },
});

const with_ = (edit: (o: SyncOverrides) => SyncOverrides) => edit(emptySyncOverrides());

describe('runSyncCore — the overrides Undo leaves behind', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const duplicated = (syncOverrides?: SyncOverrides): FakeHostSeed => ({
    ...checking([{ id: 'tx-1', posted: epoch('2026-10-01T12:00:00Z'), amount: '-25.00', description: 'NETFLIX.COM' }]),
    existing: new Map([['wf-a', [
      { id: 'act-2', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-01', amount: 25, comment: 'NETFLIX.COM · tx-1', sourceGroupId: null },
      { id: 'act-1', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-01', amount: 25, comment: 'NETFLIX.COM · tx-1', sourceGroupId: null },
    ]]]),
    ...(syncOverrides ? { syncOverrides } : {}),
  });

  it('keepDuplicate: the prune leaves every copy of that transaction', async () => {
    const plain = createFakeHost(duplicated());
    expect((await runSyncCore(plain.host, plain.store, { heal: true })).prunedDuplicates.map((p) => p.wfId)).toEqual(['act-2']);

    const kept = createFakeHost(duplicated(with_((o) => setTxOverride(o, accountTxKey('sfin-1', 'tx-1'), 'keepDuplicate', NOW))));
    const log = capture();
    const result = await runSyncCore(kept.host, kept.store, { heal: true, changeLog: log });
    expect(result.prunedDuplicates).toEqual([]);
    expect(kept.activities.get('wf-a')!.map((r) => r.id).sort()).toEqual(['act-1', 'act-2']);
    expect(log.entries().filter((e) => e.kind === 'duplicate-removed')).toEqual([]);
  });

  it('keepDuplicate is per account: the same id in another account is still pruned', async () => {
    const seed = duplicated(with_((o) => setTxOverride(o, accountTxKey('sfin-OTHER', 'tx-1'), 'keepDuplicate', NOW)));
    const { host, store } = createFakeHost(seed);
    expect((await runSyncCore(host, store, { heal: true })).prunedDuplicates.map((p) => p.wfId)).toEqual(['act-2']);
  });

  const amazon = (syncOverrides?: SyncOverrides): FakeHostSeed => ({
    ...checking([{ id: 'tx-amz', posted: epoch('2026-08-06T00:00:00Z'), amount: '-21.18', description: 'AMAZON.COM*MB3T81' }]),
    existing: new Map([['wf-a', [{
      id: 'act-amz', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-08-06', amount: 21.18,
      comment: 'AMAZON.COM*MB3T81 · tx-amz', sourceGroupId: null,
    }]]]),
    amazonLedger: {
      '113-0728509-1925031|shipped|2118': {
        orderId: '113-0728509-1925031', kind: 'shipped', totalCents: 2118, itemCount: 1, labels: ['Lawn & Garden'], emailDate: '2026-08-04',
      },
    },
    ...(syncOverrides ? { syncOverrides } : {}),
  });

  it('noAmazonLabel: the late label leaves the note, and the order is still consumed', async () => {
    const plain = createFakeHost(amazon());
    await runSyncCore(plain.host, plain.store, {});
    expect(plain.activities.get('wf-a')![0].comment).toBe('AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · tx-amz');

    const off = createFakeHost(amazon(with_((o) => setTxOverride(o, accountTxKey('sfin-1', 'tx-amz'), 'noAmazonLabel', NOW))));
    const log = capture();
    await runSyncCore(off.host, off.store, { changeLog: log });
    expect(off.activities.get('wf-a')![0].comment).toBe('AMAZON.COM*MB3T81 · tx-amz');
    expect(log.entries()).toEqual([]);
    expect(off.amazon()['113-0728509-1925031|shipped|2118'].consumedBy).toBe(accountTxKey('sfin-1', 'tx-amz'));
  });

  it('noAmazonLabel: a new charge imports with the bank’s own words', async () => {
    const seed = amazon(with_((o) => setTxOverride(o, accountTxKey('sfin-1', 'tx-amz'), 'noAmazonLabel', NOW)));
    const { host, store, activities } = createFakeHost({ ...seed, existing: new Map() });
    await runSyncCore(host, store, {});
    expect(activities.get('wf-a')![0].comment).toBe('AMAZON.COM*MB3T81 · tx-amz');
  });

  const drifting = (syncOverrides?: SyncOverrides): FakeHostSeed => ({
    ...checking([], '100.00'),
    valuations: new Map([['wf-a', 0]]),
    autoHeal: true,
    autoAdjust: true,
    // Under the $100 alert threshold, so the plug is not held back as young.
    driftAlertThreshold: 500,
    ...(syncOverrides ? { syncOverrides } : {}),
  });

  it('noAutoCorrect: no plug, and the drift is still reported', async () => {
    const plain = createFakeHost(drifting());
    await runSyncCore(plain.host, plain.store, { heal: true });
    expect(plain.imported.flat().map((r) => r.comment)).toContain('Balance adjustment · sfin-1 · 2026-10-13');

    const off = createFakeHost(drifting(with_((o) => setAccountOverride(o, 'sfin-1', 'noAutoCorrect', NOW))));
    const log = capture();
    await runSyncCore(off.host, off.store, { heal: true, changeLog: log });
    expect(off.imported.flat().map((r) => r.comment)).not.toContain('Balance adjustment · sfin-1 · 2026-10-13');
    expect(log.entries().filter((e) => e.kind === 'balance-correction')).toEqual([]);
    const balances = await off.store.getAccountBalances() as Record<string, { drift: number | null; measured?: boolean }>;
    expect(balances['sfin-1']).toMatchObject({ drift: 100, measured: true });
  });

  it('an empty document changes nothing about a run', async () => {
    const plain = createFakeHost(duplicated());
    const withEmpty = createFakeHost(duplicated(emptySyncOverrides()));
    const a = await runSyncCore(plain.host, plain.store, { heal: true });
    const b = await runSyncCore(withEmpty.host, withEmpty.store, { heal: true });
    expect(b).toEqual(a);
    expect(withEmpty.saved).toEqual(plain.saved);
  });

  it('a store whose overrides read fails syncs as if there were none', async () => {
    const plain = createFakeHost(duplicated());
    const failing = createFakeHost(duplicated());
    failing.store.getSyncOverrides = async () => { throw new Error('ECONNRESET'); };
    const a = await runSyncCore(plain.host, plain.store, { heal: true });
    const b = await runSyncCore(failing.host, failing.store, { heal: true });
    expect(b).toEqual(a);
  });
});
```

**Create `src/utils/secrets-overrides.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { SecretsStore } from './secrets';
import { emptySyncOverrides, setAccountOverride, SYNC_OVERRIDES_SECRET_KEY } from '../../shared/sync-overrides';

const ctxOver = (data: Record<string, string>) => ({
  api: {
    secrets: {
      get: vi.fn(async (k: string) => data[k] ?? null),
      set: vi.fn(async (k: string, v: string) => { data[k] = v; }),
      delete: vi.fn(async (k: string) => { delete data[k]; }),
    },
  },
}) as any;

describe('SecretsStore — sync overrides', () => {
  it('reads the document under the key the companion reads too', async () => {
    const doc = setAccountOverride(emptySyncOverrides(), 'sfin-1', 'noAutoCorrect', new Date('2026-10-13T15:00:00Z'));
    expect(await new SecretsStore(ctxOver({ [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(doc) })).getSyncOverrides()).toEqual(doc);
  });

  it('reads a corrupt document as empty, so the sync behaves as today', async () => {
    expect(await new SecretsStore(ctxOver({ [SYNC_OVERRIDES_SECRET_KEY]: 'not json' })).getSyncOverrides()).toEqual(emptySyncOverrides());
  });

  it('Reset clears it', async () => {
    const data = { [SYNC_OVERRIDES_SECRET_KEY]: '{"v":1}' };
    await new SecretsStore(ctxOver(data)).clearAll();
    expect(data[SYNC_OVERRIDES_SECRET_KEY]).toBeUndefined();
  });
});
```

**Create `companion/src/rest-host-overrides.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { RestSyncStore } from './rest-host.js';
import { emptySyncOverrides, setTxOverride, SYNC_OVERRIDES_SECRET_KEY } from '../../shared/sync-overrides.js';

const store = (secrets: Map<string, string>) => new RestSyncStore({
  getAddonSecret: vi.fn(async (_id: string, key: string) => secrets.get(key) ?? null),
  setAddonSecret: vi.fn(),
} as any);

describe('RestSyncStore — sync overrides', () => {
  it('reads the document the add-on writes, under the same key', async () => {
    const doc = setTxOverride(emptySyncOverrides(), 'sfin-1\u0000TRN-1', 'notTransfer', new Date('2026-10-13T15:00:00Z'));
    const read = await store(new Map([[SYNC_OVERRIDES_SECRET_KEY, JSON.stringify(doc)]])).getSyncOverrides();
    expect(read).toEqual(doc);
  });

  it('reads a corrupt document, an absent one and a failed read as empty, so the sync behaves as today', async () => {
    expect(await store(new Map([[SYNC_OVERRIDES_SECRET_KEY, '{"v":1,"tx":7}']])).getSyncOverrides()).toEqual(emptySyncOverrides());
    expect(await store(new Map()).getSyncOverrides()).toEqual(emptySyncOverrides());
    const failing = new RestSyncStore({ getAddonSecret: vi.fn(async () => { throw new Error('502'); }), setAddonSecret: vi.fn() } as any);
    expect(await failing.getSyncOverrides()).toEqual(emptySyncOverrides());
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/sync-core-overrides.test.ts src/utils/secrets-overrides.test.ts`
Expected: FAIL — the prune still removes the kept copy, the late label is still added, the plug is still written, and `store.getSyncOverrides` is not a function.

Run: `npm --prefix companion test -- src/rest-host-overrides.test.ts`
Expected: FAIL — `getSyncOverrides` is not a function.

- [ ] **Step 3: Implement**

**Edit `shared/sync-host.ts`** — two edits: import the type; the optional getter on `SyncStore`.

Edit 1 of 2 in `shared/sync-host.ts` — replace:

```ts
import type { AmazonLedger } from './amazon-ledger.js';
import type { HoldingsSnapshot } from './holdings.js';
import type { SkippedTransaction } from './skipped-transactions.js';

/** A Wealthfolio activity row, normalized across the SDK and REST shapes. */
export interface HostActivity {
```

with:

```ts
import type { AmazonLedger } from './amazon-ledger.js';
import type { HoldingsSnapshot } from './holdings.js';
import type { SkippedTransaction } from './skipped-transactions.js';
import type { SyncOverrides } from './sync-overrides.js';

/** A Wealthfolio activity row, normalized across the SDK and REST shapes. */
export interface HostActivity {
```

Edit 2 of 2 in `shared/sync-host.ts` — replace:

```ts
   * is what it did before the list existed.
   */
  getSkippedTransactions?(): Promise<SkippedTransaction[]>;
}
```

with:

```ts
   * is what it did before the list existed.
   */
  getSkippedTransactions?(): Promise<SkippedTransaction[]>;
  /**
   * What the person told the sync not to do again (shared/sync-overrides.ts),
   * set by an Undo in the change log. A stored document that cannot be read —
   * or a failed read — comes back EMPTY, so the sync behaves exactly as it did
   * before overrides existed.
   *
   * Optional like the getters above; a host without it obeys no overrides.
   */
  getSyncOverrides?(): Promise<SyncOverrides>;
}
```

**Edit `shared/sync-core.ts`** — five edits, in order: (1) import the override helpers; (2) read the document once, after the skip list; (3) the Amazon match still consumes the order but adds no label under `noAmazonLabel`; (4) the prune skips `keepDuplicate` rows; (5) no plug under `noAutoCorrect`.

Edit 1 of 5 in `shared/sync-core.ts` — replace:

```ts
  transferTypeChange,
  type BaselineState, type ChangeAccount, type ChangeDraft, type ChangeEntry, type ChangeLogSink, type LinkLegFacts,
} from './change-entries.js';

/**
 * A datable timestamp for a SimpleFin transaction: `posted` when present, else
```

with:

```ts
  transferTypeChange,
  type BaselineState, type ChangeAccount, type ChangeDraft, type ChangeEntry, type ChangeLogSink, type LinkLegFacts,
} from './change-entries.js';
import { emptySyncOverrides, hasAccountOverride, hasTxOverride } from './sync-overrides.js';

/**
 * A datable timestamp for a SimpleFin transaction: `posted` when present, else
```

Edit 2 of 5 in `shared/sync-core.ts` — replace:

```ts
    ((await store.getSkippedTransactions?.().catch(() => [])) ?? [])
      .map((s) => accountTxKey(s.account, s.txId)),
  );

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
```

with:

```ts
    ((await store.getSkippedTransactions?.().catch(() => [])) ?? [])
      .map((s) => accountTxKey(s.account, s.txId)),
  );
  /** What Undo told the sync not to do again (shared/sync-overrides.ts). A
   *  failed or corrupt read is empty: the sync then behaves as it always did. */
  const overrides = (await store.getSyncOverrides?.().catch(() => null)) ?? emptySyncOverrides();

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
```

Edit 3 of 5 in `shared/sync-core.ts` — replace:

```ts
          postedMs: txEpoch(tx)! * 1000,
          txKey: key,
        });
        if (hit) {
          description = amazonDescription(description, hit.labels, hit.partial);
          if (description !== tx.description) {
            const forAccount = amazonLabelled.get(sfAccount.id) ?? new Map<string, { bare: string; enriched: string }>();
            forAccount.set(tx.id, { bare: tx.description, enriched: description });
            amazonLabelled.set(sfAccount.id, forAccount);
          }
          // Consumed even when this row already exists in Wealthfolio and so
          // won't be re-written: the charge for that order HAS been found, and
          // leaving the record live would offer it to the next charge of the
```

with:

```ts
          postedMs: txEpoch(tx)! * 1000,
          txKey: key,
        });
        // Still matched and consumed when the person undid this charge's
        // label: the order HAS been found, and a live record would be offered
        // to the next charge of the same amount. Only the label stays off.
        if (hit && !hasTxOverride(overrides, key, 'noAmazonLabel')) {
          description = amazonDescription(description, hit.labels, hit.partial);
          if (description !== tx.description) {
            const forAccount = amazonLabelled.get(sfAccount.id) ?? new Map<string, { bare: string; enriched: string }>();
            forAccount.set(tx.id, { bare: tx.description, enriched: description });
            amazonLabelled.set(sfAccount.id, forAccount);
          }
        }
        if (hit) {
          // Consumed even when this row already exists in Wealthfolio and so
          // won't be re-written: the charge for that order HAS been found, and
          // leaving the record live would offer it to the next charge of the
```

Edit 4 of 5 in `shared/sync-core.ts` — replace:

```ts
    let prunedThisAccount = 0;
    if (heal) {
      const feedByTxId = new Map(feed.map((t) => [t.txId, t]));
      const surplus = planDuplicatePrune(existing, new Set(feedByTxId.keys()));
      if (surplus.length > 0) {
        const surplusIds = new Set(surplus.map((r) => r.wfId));
        // Drop them from the snapshot even if the delete below fails: a row we
```

with:

```ts
    let prunedThisAccount = 0;
    if (heal) {
      const feedByTxId = new Map(feed.map((t) => [t.txId, t]));
      // Copies the person chose to keep (Undo of a removed duplicate) are left
      // out of the sweep entirely — every copy shares the one tx key.
      const surplus = planDuplicatePrune(
        existing.filter((r) => !hasTxOverride(overrides, accountTxKey(sfAccount.id, r.txId), 'keepDuplicate')),
        new Set(feedByTxId.keys()),
      );
      if (surplus.length > 0) {
        const surplusIds = new Set(surplus.map((r) => r.wfId));
        // Drop them from the snapshot even if the delete below fails: a row we
```

Edit 5 of 5 in `shared/sync-core.ts` — replace:

```ts
          ? Date.now() - Date.parse(openEpisode.firstDetectedAt) < BASELINE_FIX_MIN_DRIFT_AGE_MS
          : driftAlertThresholdCents > 0 &&
            Math.abs(Math.round((drift ?? 0) * 100)) > driftAlertThresholdCents;
        if (heal && autoAdjust && drift != null && !youngEpisode) {
          const alreadyToday = await hasAdjustmentToday(host, wfAccountId, sfAccount.id).catch(
            () => false,
          );
```

with:

```ts
          ? Date.now() - Date.parse(openEpisode.firstDetectedAt) < BASELINE_FIX_MIN_DRIFT_AGE_MS
          : driftAlertThresholdCents > 0 &&
            Math.abs(Math.round((drift ?? 0) * 100)) > driftAlertThresholdCents;
        // The person undid an automatic correction on this account: no plug, but
        // `drift` and `measuredDrift` stay as measured, so the account is still
        // reported (Sync page, alert, the morning 🧹 list).
        const noAutoCorrect = hasAccountOverride(overrides, sfAccount.id, 'noAutoCorrect');
        if (heal && autoAdjust && drift != null && !youngEpisode && !noAutoCorrect) {
          const alreadyToday = await hasAdjustmentToday(host, wfAccountId, sfAccount.id).catch(
            () => false,
          );
```

**Edit `shared/fake-host.ts`** — three edits: import the type; the seed field; the store getter, present only when seeded.

Edit 1 of 3 in `shared/fake-host.ts` — replace:

```ts
import type { AmazonLedger } from './amazon-ledger.js';
import type { HoldingsSnapshot } from './holdings.js';
import type { SkippedTransaction } from './skipped-transactions.js';
import type {
  ActivityWrite,
  HostActivity,
```

with:

```ts
import type { AmazonLedger } from './amazon-ledger.js';
import type { HoldingsSnapshot } from './holdings.js';
import type { SkippedTransaction } from './skipped-transactions.js';
import type { SyncOverrides } from './sync-overrides.js';
import type {
  ActivityWrite,
  HostActivity,
```

Edit 2 of 3 in `shared/fake-host.ts` — replace:

```ts
  upstreamWriteRules?: boolean;
  /** The user's skip list (see shared/skipped-transactions.ts). */
  skippedTransactions?: SkippedTransaction[];
}

export interface FakeHost {
```

with:

```ts
  upstreamWriteRules?: boolean;
  /** The user's skip list (see shared/skipped-transactions.ts). */
  skippedTransactions?: SkippedTransaction[];
  /** What Undo told the sync not to do (shared/sync-overrides.ts). Absent
   *  leaves `getSyncOverrides` off the store, the shape of an older host. */
  syncOverrides?: SyncOverrides;
}

export interface FakeHost {
```

Edit 3 of 3 in `shared/fake-host.ts` — replace:

```ts
    async getSkippedTransactions() {
      return seed.skippedTransactions ?? [];
    },
  };

  return { host, store, activities, saved, links, imported, holdings, amazon: () => amazonLedger };
```

with:

```ts
    async getSkippedTransactions() {
      return seed.skippedTransactions ?? [];
    },
    ...(seed.syncOverrides
      ? { async getSyncOverrides() { return seed.syncOverrides!; } }
      : {}),
  };

  return { host, store, activities, saved, links, imported, holdings, amazon: () => amazonLedger };
```

**Edit `src/utils/secrets.ts`** — three edits: import; `KEYS.syncOverrides` (so Reset clears it); the getter.

Edit 1 of 3 in `src/utils/secrets.ts` — replace:

```ts
  type LoadedSubscriptionPrefs, type SubscriptionEdit, type SubscriptionPrefs,
} from '../../shared/subscription-prefs';
import { newRunId, stampChange, type ChangeDraft, type ChangeEntry, type ChangeLogSink } from '../../shared/change-entries';
import {
  changeLogResetKeys, createChangeLogWriter, readChangeLog, type ChangeLogIo, type ChangeLogRead,
} from '../../shared/change-log';
```

with:

```ts
  type LoadedSubscriptionPrefs, type SubscriptionEdit, type SubscriptionPrefs,
} from '../../shared/subscription-prefs';
import { newRunId, stampChange, type ChangeDraft, type ChangeEntry, type ChangeLogSink } from '../../shared/change-entries';
import { SYNC_OVERRIDES_SECRET_KEY, syncOverridesOrEmpty, type SyncOverrides } from '../../shared/sync-overrides';
import {
  changeLogResetKeys, createChangeLogWriter, readChangeLog, type ChangeLogIo, type ChangeLogRead,
} from '../../shared/change-log';
```

Edit 2 of 3 in `src/utils/secrets.ts` — replace:

```ts
  // memo beside it. Both are the easy-to-forget shape; Reset must clear them.
  subscriptionPrefs: SUBSCRIPTION_PREFS_SECRET_KEY,
  subscriptionNewsSent: SUBSCRIPTION_NEWS_SECRET_KEY,
} as const;

/** One entry in the shared large-transaction outbox. Derived from `SyncResult`
```

with:

```ts
  // memo beside it. Both are the easy-to-forget shape; Reset must clear them.
  subscriptionPrefs: SUBSCRIPTION_PREFS_SECRET_KEY,
  subscriptionNewsSent: SUBSCRIPTION_NEWS_SECRET_KEY,
  // R2's overrides document: edited only through editSyncOverrides, the
  // easy-to-forget shape; Reset must clear it.
  syncOverrides: SYNC_OVERRIDES_SECRET_KEY,
} as const;

/** One entry in the shared large-transaction outbox. Derived from `SyncResult`
```

Edit 3 of 3 in `src/utils/secrets.ts` — replace:

```ts
    return parseSkippedTransactions(await this.ctx.api.secrets.get(KEYS.skippedTransactions));
  }

  /** Which collapsible config cards the user left open, keyed by card id.
   *  Purely cosmetic, so a malformed value degrades to "everything closed"
   *  rather than surfacing an error — but it is worth storing: the account
```

with:

```ts
    return parseSkippedTransactions(await this.ctx.api.secrets.get(KEYS.skippedTransactions));
  }

  /** What the sync obeys (shared/sync-overrides.ts): corrupt, absent and a
   *  failed read all come back empty — the sync then behaves as it always did. */
  async getSyncOverrides(): Promise<SyncOverrides> {
    return syncOverridesOrEmpty((k) => this.ctx.api.secrets.get(k));
  }

  /** Which collapsible config cards the user left open, keyed by card id.
   *  Purely cosmetic, so a malformed value degrades to "everything closed"
   *  rather than surfacing an error — but it is worth storing: the account
```

**Edit `companion/src/rest-host.ts`** — two edits: import; the getter.

Edit 1 of 2 in `companion/src/rest-host.ts` — replace:

```ts
import type { AmazonLedger } from '../../shared/amazon-ledger.js';
import { linkPairByRecreate } from '../../shared/link-pair.js';
import { SKIPPED_TRANSACTIONS_SECRET_KEY, parseSkippedTransactions, type SkippedTransaction } from '../../shared/skipped-transactions.js';
import type { WealthfolioClient } from './wealthfolio.js';
import type {
  HostActivity,
```

with:

```ts
import type { AmazonLedger } from '../../shared/amazon-ledger.js';
import { linkPairByRecreate } from '../../shared/link-pair.js';
import { SKIPPED_TRANSACTIONS_SECRET_KEY, parseSkippedTransactions, type SkippedTransaction } from '../../shared/skipped-transactions.js';
import { syncOverridesOrEmpty, type SyncOverrides } from '../../shared/sync-overrides.js';
import type { WealthfolioClient } from './wealthfolio.js';
import type {
  HostActivity,
```

Edit 2 of 2 in `companion/src/rest-host.ts` — replace:

```ts
    return parseSkippedTransactions(await this.client.getAddonSecret(this.addonId, SKIPPED_TRANSACTIONS_SECRET_KEY));
  }

  async getAmazonLedger(): Promise<AmazonLedger> {
    return (await this.getJson<AmazonLedger>(AMAZON_LEDGER_SECRET_KEY)) ?? {};
  }
```

with:

```ts
    return parseSkippedTransactions(await this.client.getAddonSecret(this.addonId, SKIPPED_TRANSACTIONS_SECRET_KEY));
  }

  /** The same document the add-on reads (shared/sync-overrides.ts); corrupt,
   *  absent and a failed read are empty, so the sync behaves as it always did. */
  async getSyncOverrides(): Promise<SyncOverrides> {
    return syncOverridesOrEmpty((k) => this.client.getAddonSecret(this.addonId, k));
  }

  async getAmazonLedger(): Promise<AmazonLedger> {
    return (await this.getJson<AmazonLedger>(AMAZON_LEDGER_SECRET_KEY)) ?? {};
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/sync-core-overrides.test.ts src/utils/secrets-overrides.test.ts shared/sync-core.test.ts shared/sync-core-change-log.test.ts src/utils/secrets.test.ts`
Expected: PASS — 260 tests.

Run: `npm --prefix companion test -- src/rest-host-overrides.test.ts src/rest-host.test.ts`
Expected: PASS — 20 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/sync-host.ts shared/sync-core.ts shared/fake-host.ts src/utils/secrets.ts companion/src/rest-host.ts shared/sync-core-overrides.test.ts src/utils/secrets-overrides.test.ts companion/src/rest-host-overrides.test.ts
git commit -m "Sync: obey keepDuplicate, noAmazonLabel and noAutoCorrect; corrupt overrides read as none

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: notTransfer — never paired again, and an already-linked pair unlinked

The undo of `transfer-link` and `transfer-type` records `notTransfer` on the leg(s); this task makes the sync obey it everywhere (spec B1, U3):
- **Typing.** A card-payment keyword or a mapping rule that would type the leg as a transfer is ignored: it becomes ordinary money in or out — `expiredTransferLegType`, the type a leg whose other half never arrived takes (a card's money in is `CREDIT`) — and the rule's subtype goes with it.
- **Pairing.** The leg is never a pairing candidate, so it is never typed a transfer by pairing, never held in transit, never linked. The overwritten-leg repair never re-links it either.
- **An already-LINKED pair** with a `notTransfer` leg (either one) is kept out of its account's reconcile plan — an update to one leg of a linked pair is copied onto the other — and unlinked after the account loop: `unlinkPairByRecreate` deletes BOTH legs in one request and re-creates each as ordinary money, no group, no marker. The partner is found the way "already linked?" is answered: the rows' shared `sourceGroupId` on the companion, the `linked_groups` ledger on the add-on (whose entries for both legs are then removed). A leg whose other half is not in this sync is left linked and reported: deleting one leg deletes both, and the unseen half could not be re-created. A failed delete re-creates nothing (the rows are still there, still linked).
- **A held placeholder** in the feed is updated to ordinary money by the normal reconcile path; its `transfer-type` entry says "— you said it isn't a transfer". The unlink records one `bookkeeping` entry (new step `transfer-unlink`).

**Files:**
- Modify: `shared/change-entries.ts`, `shared/link-pair.ts`, `shared/sync-core.ts`
- Test: `shared/sync-core-not-transfer.test.ts`

**Interfaces:**
- Consumes (Task 1): `hasTxOverride`, `setTxOverride`, `emptySyncOverrides`, `SyncOverrides`; (Task 2) `overrides` read once in `runSyncPass`, `FakeHostSeed.syncOverrides`; existing: `expiredTransferLegType(accountType, signedAmount)`, `toLinkLeg` (in `runSyncPass`), `LinkLeg`, `SaveManyRequest`, `SaveManyResult`, `isTransferType`, `txIdFromComment`, `descriptionFromComment`, `bookkeepingChange`, `transferTypeChange`.
- Produces:

```ts
// shared/change-entries.ts
export interface TransferTypeFacts { /* … */ held: boolean; undone?: boolean }   // undone: retyped by `notTransfer`
export type BookkeepingStep = 'legacy-placeholder' | 'external-marker' | 'transfer-relink' | 'opening-category' | 'transfer-unlink';
// transferTypeChange, held: false + undone: summary `Counted <desc> as spending — you said it isn't a transfer`
//   (`money in` for a positive amount), why `You undid the transfer`, undoable false.
// bookkeepingChange 'transfer-unlink': `Unlinked a transfer you undid: re-created its 2 rows as spending or money in`.

// shared/link-pair.ts
export interface UnlinkLeg extends LinkLeg { newType: string }
export interface UnlinkResult { unlinked: boolean; activityIds?: [string, string]; problems?: string[] }
export async function unlinkPairByRecreate(
  saveMany: (req: SaveManyRequest) => Promise<SaveManyResult>,
  legs: [UnlinkLeg, UnlinkLeg],
): Promise<UnlinkResult>;
```

- Inside `runSyncPass` (module-private): `unlinkKeys: Set<string>` (filled in the account loop), `unlinkedKeys: Set<string>` and `partnerKeyOf(key, row)` (after `toLinkLeg`). Error text for a partner not in view (verbatim): ``Could not unlink ${description}: its other half is not in this sync — it stays linked for now``; a failed unlink: ``Transfer-unlink failed (${txId}/${partnerTxId}): ${problem}``.

- [ ] **Step 1: Write the failing tests**

**Create `shared/sync-core-not-transfer.test.ts`:**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChangeEntry, ChangeLogSink } from './change-entries.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import { emptySyncOverrides, setTxOverride, type SyncOverrides } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-13T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const OUT = accountTxKey('sfin-1', 'tx-out');
const IN = accountTxKey('sfin-2', 'tx-in');

function capture(): ChangeLogSink & { entries: () => ChangeEntry[] } {
  const batches: ChangeEntry[][] = [];
  return {
    writer: 'companion', run: 'cRUN1',
    append: vi.fn(async (entries: ChangeEntry[]) => { batches.push(entries); }),
    entries: () => batches.flat(),
  };
}

const notTransfer = (...keys: string[]): SyncOverrides =>
  keys.reduce((o, k) => setTxOverride(o, k, 'notTransfer', NOW), emptySyncOverrides());

/** A Citi payment: out of Checking, into the card, both in this run's feed. */
const twoAccounts = (extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-13T12:00:00Z'),
      transactions: [{ id: 'tx-out', posted: epoch('2026-10-08T12:00:00Z'), amount: '-464.60', description: 'CITI AUTOPAY PAYMENT' }] },
    { id: 'sfin-2', name: 'Citi', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-13T12:00:00Z'),
      transactions: [{ id: 'tx-in', posted: epoch('2026-10-09T12:00:00Z'), amount: '464.60', description: 'PAYMENT THANK YOU' }] },
  ] },
  mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
  accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CREDIT_CARD' },
  accountNames: { 'wf-a': 'Checking', 'wf-b': 'Citi Card' },
  ...extra,
});

/** The pair as an earlier sync left it: linked under one group. */
const linkedRows = (): Map<string, HostActivity[]> => new Map([
  ['wf-a', [{ id: 'act-out', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-10-08', amount: 464.6, comment: 'CITI AUTOPAY PAYMENT · tx-out', sourceGroupId: 'wf-transfer-9', metadata: '{"flow":{"is_external":false}}' }]],
  ['wf-b', [{ id: 'act-in', accountId: 'wf-b', activityType: 'TRANSFER_IN', date: '2026-10-09', amount: 464.6, comment: 'PAYMENT THANK YOU · tx-in', sourceGroupId: 'wf-transfer-9', metadata: '{"flow":{"is_external":false}}' }]],
]);

const rows = (activities: Map<string, HostActivity[]>) =>
  [...activities.values()].flat().map((r) => ({ account: r.accountId, type: r.activityType, comment: r.comment, group: r.sourceGroupId ?? null }))
    .sort((a, b) => a.account.localeCompare(b.account));

describe('runSyncCore — notTransfer', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('unlinks an already-linked pair, retypes both halves, and the next sync does not re-link them', async () => {
    const first = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(OUT, IN), upstreamWriteRules: true }));
    const log = capture();
    const result = await runSyncCore(first.host, first.store, { changeLog: log });

    expect(result.errors).toEqual([]);
    expect(first.links).toEqual([]);
    // Never an update to a linked leg (it would be copied onto the partner):
    // one delete of both, then one create of both.
    expect(first.saved.filter((r) => (r.updates ?? []).length > 0)).toEqual([]);
    expect(first.saved.map((r) => [r.deleteIds ?? [], (r.creates ?? []).map((c) => c.activityType)])).toEqual([
      [['act-out', 'act-in'], []],
      [[], ['WITHDRAWAL', 'CREDIT']],
    ]);
    expect(rows(first.activities)).toEqual([
      { account: 'wf-a', type: 'WITHDRAWAL', comment: 'CITI AUTOPAY PAYMENT · tx-out', group: null },
      { account: 'wf-b', type: 'CREDIT', comment: 'PAYMENT THANK YOU · tx-in', group: null },
    ]);
    expect(log.entries()).toEqual([expect.objectContaining({
      kind: 'bookkeeping', undoable: false,
      summary: 'Unlinked a transfer you undid: re-created its 2 rows as spending or money in',
      after: expect.objectContaining({ step: 'transfer-unlink', count: 2 }),
    })]);

    const second = createFakeHost(twoAccounts({ existing: first.activities, syncOverrides: notTransfer(OUT, IN), upstreamWriteRules: true }));
    await runSyncCore(second.host, second.store, { force: true });
    expect(second.links).toEqual([]);
    expect(second.saved).toEqual([]);
    expect(rows(second.activities)).toEqual(rows(first.activities));
  });

  it('on a host that cannot read groups, finds the partner in the ledger and clears both legs from it', async () => {
    const fh = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(OUT, IN) }));
    const host = { ...fh.host, capabilities: { readsSourceGroupId: false } };
    await fh.store.setLinkedGroups({ [OUT]: 'wf-transfer-9', [IN]: 'wf-transfer-9', 'tx-unrelated': 'wf-transfer-1' });
    const result = await runSyncCore(host, fh.store, {});
    expect(result.errors).toEqual([]);
    expect(fh.links).toEqual([]);
    expect(rows(fh.activities).map((r) => r.type)).toEqual(['WITHDRAWAL', 'CREDIT']);
    expect(await fh.store.getLinkedGroups()).toEqual({ 'tx-unrelated': 'wf-transfer-1' });
  });

  it('unlinks the pair when only one leg carries the override', async () => {
    const fh = createFakeHost(twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(IN) }));
    await runSyncCore(fh.host, fh.store, {});
    expect(rows(fh.activities).map((r) => [r.type, r.group])).toEqual([['WITHDRAWAL', null], ['CREDIT', null]]);
  });

  it('reports a linked leg whose other half is not in view, and leaves it alone', async () => {
    const existing = linkedRows();
    existing.set('wf-b', []);
    const fh = createFakeHost(twoAccounts({ existing, syncOverrides: notTransfer(OUT) }));
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(result.errors).toEqual(['Could not unlink CITI AUTOPAY PAYMENT: its other half is not in this sync — it stays linked for now']);
    expect(fh.saved.some((r) => (r.deleteIds ?? []).includes('act-out'))).toBe(false);
  });

  it('a new pair with a notTransfer leg is never paired: that leg imports as ordinary money', async () => {
    const fh = createFakeHost(twoAccounts({ syncOverrides: notTransfer(OUT) }));
    await runSyncCore(fh.host, fh.store, {});
    expect(fh.links).toEqual([]);
    const out = fh.activities.get('wf-a')!;
    expect(out.map((r) => [r.activityType, r.comment])).toEqual([['WITHDRAWAL', 'CITI AUTOPAY PAYMENT · tx-out']]);
  });

  it('a mapping rule that types the leg as a transfer is ignored for it', async () => {
    const seed = twoAccounts({
      syncOverrides: notTransfer(OUT),
      mappingRules: [{ pattern: 'CITI AUTOPAY', matchType: 'contains', activityType: 'TRANSFER_OUT' }],
    });
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, {});
    expect(fh.activities.get('wf-a')!.map((r) => r.activityType)).toEqual(['WITHDRAWAL']);
  });

  it('a held placeholder becomes ordinary spending, and says why', async () => {
    const fh = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-13T12:00:00Z'),
        transactions: [{ id: 'tx-out', posted: epoch('2026-10-11T12:00:00Z'), amount: '-1300.00', description: 'Online Transfer to Savings' }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
      accountNames: { 'wf-a': 'Checking' },
      existing: new Map([['wf-a', [{
        id: 'ph-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-10-11', amount: 1300,
        comment: '↔️ In-transit transfer · Online Transfer to Savings · tx-out', sourceGroupId: null,
      }]]]),
      syncOverrides: notTransfer(OUT),
    });
    const log = capture();
    await runSyncCore(fh.host, fh.store, { changeLog: log });
    expect(fh.activities.get('wf-a')!.map((r) => [r.activityType, r.comment])).toEqual([['WITHDRAWAL', 'Online Transfer to Savings · tx-out']]);
    expect(log.entries()).toEqual([expect.objectContaining({
      kind: 'transfer-type', undoable: false,
      summary: "Counted Online Transfer to Savings as spending — you said it isn't a transfer",
      why: 'You undid the transfer',
    })]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/sync-core-not-transfer.test.ts`
Expected: FAIL — the linked pair stays linked (nothing deleted), the new pair is linked, the mapping rule's `TRANSFER_OUT` stands, and the held placeholder keeps its in-transit note.

- [ ] **Step 3: Implement**

**Edit `shared/change-entries.ts`** — four edits: the `undone` fact and its words; the `transfer-unlink` step and its words.

Edit 1 of 4 in `shared/change-entries.ts` — replace:

```ts
  previousType: string | null;
  /** true: held as a transfer in transit. false: the wait ran out. */
  held: boolean;
}

/**
```

with:

```ts
  previousType: string | null;
  /** true: held as a transfer in transit. false: the wait ran out. */
  held: boolean;
  /** With `held: false`: retyped because the person undid the transfer
   *  decision (a `notTransfer` override), not because the wait ran out. */
  undone?: boolean;
}

/**
```

Edit 2 of 4 in `shared/change-entries.ts` — replace:

```ts
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: f.held
      ? `Held ${what(f.description)} as a transfer in transit`
      : `Stopped waiting for the other half of ${what(f.description)} — now counted as ${f.amountCents < 0 ? 'spending' : 'money in'}`,
    why: f.held ? 'Looks like a transfer; waiting for the other half' : 'No other half arrived within 10 days',
    before: { activityType: f.previousType, inTransit: !f.held },
    after: { activityType: f.activityType, inTransit: f.held },
    undoable: f.held,
```

with:

```ts
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: f.held
      ? `Held ${what(f.description)} as a transfer in transit`
      : f.undone
        ? `Counted ${what(f.description)} as ${f.amountCents < 0 ? 'spending' : 'money in'} — you said it isn't a transfer`
        : `Stopped waiting for the other half of ${what(f.description)} — now counted as ${f.amountCents < 0 ? 'spending' : 'money in'}`,
    why: f.held ? 'Looks like a transfer; waiting for the other half' : f.undone ? 'You undid the transfer' : 'No other half arrived within 10 days',
    before: { activityType: f.previousType, inTransit: !f.held },
    after: { activityType: f.activityType, inTransit: f.held },
    undoable: f.held,
```

Edit 3 of 4 in `shared/change-entries.ts` — replace:

```ts

// ── Bookkeeping ──────────────────────────────────────────────────────────

export type BookkeepingStep = 'legacy-placeholder' | 'external-marker' | 'transfer-relink' | 'opening-category';

export interface BookkeepingFacts {
  step: BookkeepingStep;
```

with:

```ts

// ── Bookkeeping ──────────────────────────────────────────────────────────

export type BookkeepingStep = 'legacy-placeholder' | 'external-marker' | 'transfer-relink' | 'opening-category' | 'transfer-unlink';

export interface BookkeepingFacts {
  step: BookkeepingStep;
```

Edit 4 of 4 in `shared/change-entries.ts` — replace:

```ts
      ? `Marked ${n} bookkeeping ${plural(n, 'row', 'rows')} as outside transfers for Wealthfolio's Health page`
      : f.step === 'transfer-relink'
        ? `Re-created ${n} old transfer ${plural(n, 'row', 'rows')} so ${plural(n, 'it moves', 'they move')} cash`
        : `Set up the "${f.categoryName ?? 'Opening balances'}" category and kept it out of spending`;
  return {
    actor: 'auto',
    kind: 'bookkeeping',
```

with:

```ts
      ? `Marked ${n} bookkeeping ${plural(n, 'row', 'rows')} as outside transfers for Wealthfolio's Health page`
      : f.step === 'transfer-relink'
        ? `Re-created ${n} old transfer ${plural(n, 'row', 'rows')} so ${plural(n, 'it moves', 'they move')} cash`
        : f.step === 'transfer-unlink'
          ? `Unlinked a transfer you undid: re-created ${plural(n, 'its row', 'its 2 rows')} as spending or money in`
          : `Set up the "${f.categoryName ?? 'Opening balances'}" category and kept it out of spending`;
  return {
    actor: 'auto',
    kind: 'bookkeeping',
```

**Edit `shared/link-pair.ts`** — two edits: import `isTransferType`; append `unlinkPairByRecreate`. (`sync-core.ts` and `link-pair.ts` import each other; both only reference the other's exports inside functions, so the cycle is safe in Node's ESM loader and in vitest.)

Edit 1 of 2 in `shared/link-pair.ts` — replace:

```ts
import { INTERNAL_TRANSFER_METADATA, newTransferGroupId, txIdFromComment } from './sync-core.js';
import { accountTxKey } from './transfers.js';
import type { LinkLeg, LinkResult, SaveManyRequest, SaveManyResult } from './sync-host.js';

```

with:

```ts
import { INTERNAL_TRANSFER_METADATA, isTransferType, newTransferGroupId, txIdFromComment } from './sync-core.js';
import { accountTxKey } from './transfers.js';
import type { LinkLeg, LinkResult, SaveManyRequest, SaveManyResult } from './sync-host.js';

```

Edit 2 of 2 in `shared/link-pair.ts` — replace:

```ts
  );
  return { linked: false, problems };
}
```

with:

```ts
  );
  return { linked: false, problems };
}

/** One leg of a linked pair to unlink, and the type it becomes. */
export interface UnlinkLeg extends LinkLeg {
  /** Ordinary money in or out (`expiredTransferLegType`). */
  newType: string;
}

export interface UnlinkResult {
  unlinked: boolean;
  /** The re-created rows' ids, in leg order, when the echo carried them. */
  activityIds?: [string, string];
  problems?: string[];
}

/**
 * Undo of a transfer link: delete BOTH legs in one call and re-create each as
 * ordinary money in or out, with no group and no transfer marker.
 *
 * Why delete-and-re-create, as linking does: an update to one leg of a linked
 * pair is copied onto its partner (Wealthfolio 3.8, `build_counterpart_update`)
 * and an update cannot take a row out of its group. Deleting both in ONE
 * request is clean — the bulk endpoint expands a linked leg's delete to the
 * pair and de-duplicates the ids. The new types differ from the old ones, so
 * the re-creates never collide with the deleted rows' fingerprints.
 *
 * Unlike `linkPairByRecreate`, a failed delete stops here: the rows are still
 * there, still linked, and re-creating them would leave a second copy.
 */
export async function unlinkPairByRecreate(
  saveMany: (req: SaveManyRequest) => Promise<SaveManyResult>,
  legs: [UnlinkLeg, UnlinkLeg],
): Promise<UnlinkResult> {
  const del = await saveMany({ deleteIds: legs.map((l) => l.wfId) });
  if (del.errors.length > 0) {
    return { unlinked: false, problems: del.errors.map((e) => `delete (${e.action}): ${e.message}`) };
  }
  const res = await saveMany({
    creates: legs.map((leg) => ({
      accountId: leg.accountId,
      activityType: leg.newType,
      activityDate: leg.date,
      // Ordinary money resolves the cash asset by symbol; only a transfer leg
      // must carry none (see `isTransferType`).
      ...(isTransferType(leg.newType) ? {} : { symbol: { symbol: `$CASH-${leg.currency}` } }),
      amount: leg.absCents / 100,
      currency: leg.currency,
      comment: leg.comment,
    })),
  });
  if (res.errors.length > 0) {
    return { unlinked: false, problems: res.errors.map((e) => `save (${e.action}): ${e.message}`) };
  }
  const ids = legs.map((l) => res.created.find((a) => a.accountId === l.accountId && txIdFromComment(a.comment) === l.txId)?.id);
  return { unlinked: true, ...(ids[0] && ids[1] ? { activityIds: [ids[0], ids[1]] as [string, string] } : {}) };
}
```

**Edit `shared/sync-core.ts`** — nine edits, in order: (1) import the unlink; (2) type the leg: `notTransfer` overrides a transfer type; (3) never a pairing candidate; (4) `unlinkKeys` beside `overwrittenLegs`; (5) a linked `notTransfer` leg leaves its account's plan; (6) the held placeholder's entry says why; (7) the unlink step, right after `toLinkLeg`; (8) the overwritten-leg repair never re-links such a leg; (9) the relink sweep leaves the unlinked rows alone.

Edit 1 of 9 in `shared/sync-core.ts` — replace:

```ts
import type { AmazonLedger } from './amazon-ledger.js';
import type { ActivityType, SimplefinTransaction, UnmappedAccount } from './types.js';
import type { ActivityWrite, HoldingsSyncOutcome, HostActivity, ImportRow, LinkLeg, LinkResult, SaveManyRequest, SaveManyResult, SyncHost, SyncStore } from './sync-host.js';
import {
  amazonLabelChange, amazonLabelOf, balanceCorrectionChange, bankUpdateChange, bookkeepingChange, duplicateRemovedChange,
  importChange, pendingRemovedChange, stampChange, startingBalanceChange, startingBalanceMovedChange, transferLinkChange,
```

with:

```ts
import type { AmazonLedger } from './amazon-ledger.js';
import type { ActivityType, SimplefinTransaction, UnmappedAccount } from './types.js';
import type { ActivityWrite, HoldingsSyncOutcome, HostActivity, ImportRow, LinkLeg, LinkResult, SaveManyRequest, SaveManyResult, SyncHost, SyncStore } from './sync-host.js';
import { unlinkPairByRecreate, type UnlinkLeg, type UnlinkResult } from './link-pair.js';
import {
  amazonLabelChange, amazonLabelOf, balanceCorrectionChange, bankUpdateChange, bookkeepingChange, duplicateRemovedChange,
  importChange, pendingRemovedChange, stampChange, startingBalanceChange, startingBalanceMovedChange, transferLinkChange,
```

Edit 2 of 9 in `shared/sync-core.ts` — replace:

```ts
    const prepared: PreparedTx[] = [];
    for (const tx of transactions) {
      const amount = parseFloat(tx.amount);
      const { type, fromRule, subtype } = mapTransactionWithSource(
        tx.description, amount, rules, wfTypes.get(wfAccountId),
      );
      prepared.push({
        sfAccountId: sfAccount.id, tx, type,
        ...(subtype ? { subtype } : {}),
      });
      const key = accountTxKey(sfAccount.id, tx.id);
      // Amazon categories go on AFTER typing: `mapTransactionWithSource` above
      // matches the user's merchant rules against the bank's own text, and
      // enriching first would change what those rules see.
```

with:

```ts
    const prepared: PreparedTx[] = [];
    for (const tx of transactions) {
      const amount = parseFloat(tx.amount);
      const key = accountTxKey(sfAccount.id, tx.id);
      // The person undid a transfer decision on this leg (`notTransfer`):
      // neither a card-payment keyword nor a mapping rule may type it as a
      // transfer. It becomes ordinary money in or out, the type a leg whose
      // other half never arrived takes, and the rule's subtype goes with it.
      const notTransfer = hasTxOverride(overrides, key, 'notTransfer');
      const mapped = mapTransactionWithSource(tx.description, amount, rules, wfTypes.get(wfAccountId));
      const { type, fromRule, subtype } = notTransfer && isTransferType(mapped.type)
        ? { type: expiredTransferLegType(wfTypes.get(wfAccountId) ?? '', amount), fromRule: false, subtype: undefined }
        : mapped;
      prepared.push({
        sfAccountId: sfAccount.id, tx, type,
        ...(subtype ? { subtype } : {}),
      });
      // Amazon categories go on AFTER typing: `mapTransactionWithSource` above
      // matches the user's merchant rules against the bank's own text, and
      // enriching first would change what those rules see.
```

Edit 3 of 9 in `shared/sync-core.ts` — replace:

```ts
      // Pending transactions are provisional — exclude them from transfer
      // pairing so a not-yet-settled row can't lock in a TRANSFER typing.
      if (tx.pending) continue;
      // A rule's type is never overridden by pair detection, which is why ruled
      // rows sit out of it — except a rule that already says "transfer, this way".
      // Pairing assigns that very type, so all it adds is the link; leaving such a
```

with:

```ts
      // Pending transactions are provisional — exclude them from transfer
      // pairing so a not-yet-settled row can't lock in a TRANSFER typing.
      if (tx.pending) continue;
      // Never paired: pairing would type it a transfer and link it again.
      if (notTransfer) continue;
      // A rule's type is never overridden by pair detection, which is why ruled
      // rows sit out of it — except a rule that already says "transfer, this way".
      // Pairing assigns that very type, so all it adds is the link; leaving such a
```

Edit 4 of 9 in `shared/sync-core.ts` — replace:

```ts
  }
  /** Overwritten legs this run adopted, re-linked under their own identity after the loop. */
  const overwrittenLegs: Array<{ aliasKey: string; partnerTxId: string; sfAccountId: string }> = [];

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
```

with:

```ts
  }
  /** Overwritten legs this run adopted, re-linked under their own identity after the loop. */
  const overwrittenLegs: Array<{ aliasKey: string; partnerTxId: string; sfAccountId: string }> = [];
  /** Linked legs carrying `notTransfer`, kept out of their account's plan and
   *  unlinked — with their partner — after the loop. */
  const unlinkKeys = new Set<string>();

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
```

Edit 5 of 9 in `shared/sync-core.ts` — replace:

```ts
    const isLinkedRow = (row: ExistingRow & { sourceGroupId?: string | null }) => readsGroups
      ? !!row.sourceGroupId
      : ledger[accountTxKey(sfAccount.id, row.txId)] !== undefined || ledger[row.txId] !== undefined;
    const storedByTxId = new Map(planExisting.map((r) => [r.txId, r]));
    const planFeed = feed
      .filter((t) => !adoptedTxIds.has(t.txId))
      .map((t) => {
        const row = storedByTxId.get(t.txId);
        return keepLinkedLegAsStored(t, row, !!row && isLinkedRow(row));
      });
    const plan = planReconciliation(planFeed, planExisting);

    // State the post-save drift correction needs (see "windowDelta assumed" below).
    // Captured BEFORE the measurement so a rollback can put the episode ledger back
```

with:

```ts
    const isLinkedRow = (row: ExistingRow & { sourceGroupId?: string | null }) => readsGroups
      ? !!row.sourceGroupId
      : ledger[accountTxKey(sfAccount.id, row.txId)] !== undefined || ledger[row.txId] !== undefined;
    // A LINKED leg the person said is not a transfer is unlinked after the
    // loop, both halves together, and kept out of this plan meanwhile: an
    // update to one leg of a linked pair is copied onto the other.
    const unlinking = planExisting.filter((r) => isTransferType(r.type) && isLinkedRow(r)
      && hasTxOverride(overrides, accountTxKey(sfAccount.id, r.txId), 'notTransfer'));
    for (const r of unlinking) unlinkKeys.add(accountTxKey(sfAccount.id, r.txId));
    const unlinkingIds = new Set(unlinking.map((r) => r.wfId));
    const unlinkingTxIds = new Set(unlinking.map((r) => r.txId));
    const storedByTxId = new Map(planExisting.map((r) => [r.txId, r]));
    const planFeed = feed
      .filter((t) => !adoptedTxIds.has(t.txId) && !unlinkingTxIds.has(t.txId))
      .map((t) => {
        const row = storedByTxId.get(t.txId);
        return keepLinkedLegAsStored(t, row, !!row && isLinkedRow(row));
      });
    const plan = planReconciliation(planFeed, planExisting.filter((r) => !unlinkingIds.has(r.wfId)));

    // State the post-save drift correction needs (see "windowDelta assumed" below).
    // Captured BEFORE the measurement so a rollback can put the episode ledger back
```

Edit 6 of 9 in `shared/sync-core.ts` — replace:

```ts
          if (to.inTransit && !wasInTransit) {
            logChange(() => transferTypeChange({ ...facts(), activityType: to.type, previousType: stored.type, held: true }));
          } else if (wasInTransit && !to.inTransit && !isTransferType(to.type)) {
            logChange(() => transferTypeChange({ ...facts(), activityType: to.type, previousType: stored.type, held: false }));
          } else if (wasInTransit && !to.inTransit) {
            // A held leg found its other half: the `transfer-link` entry that
            // follows is the record of this (and carries the undo). The row
```

with:

```ts
          if (to.inTransit && !wasInTransit) {
            logChange(() => transferTypeChange({ ...facts(), activityType: to.type, previousType: stored.type, held: true }));
          } else if (wasInTransit && !to.inTransit && !isTransferType(to.type)) {
            logChange(() => transferTypeChange({
              ...facts(), activityType: to.type, previousType: stored.type, held: false,
              ...(hasTxOverride(overrides, key, 'notTransfer') ? { undone: true } : {}),
            }));
          } else if (wasInTransit && !to.inTransit) {
            // A held leg found its other half: the `transfer-link` entry that
            // follows is the record of this (and carries the undo). The row
```

Edit 7 of 9 in `shared/sync-core.ts` — replace:

```ts
      comment,
    };
  };
  for (const { out, in: inLeg } of detection.pairs) {
    // Resolved per (account, tx id). When SimpleFin gave both sides of the
    // transfer ONE id these two keys still differ — by account — which is what
```

with:

```ts
      comment,
    };
  };

  // ── Unlink: a linked pair with a leg the person said is not a transfer ──
  //
  // Both legs are deleted together and re-created as ordinary money in or out
  // (`unlinkPairByRecreate`), and every later step this run leaves them alone.
  // The partner is found the way "already linked?" is answered: the rows'
  // shared group where the host reads it, the ledger where it cannot. A leg
  // whose other half is not in view is left linked and reported — deleting one
  // leg of a pair deletes both, and the unseen half could not be re-created.
  const unlinkedKeys = new Set<string>();
  const partnerKeyOf = (key: string, row: LinkableRow): string | null => {
    const gid = readsGroups ? row.sourceGroupId : (ledger[key] ?? ledger[row.txId]);
    if (!gid) return null;
    for (const [k, r] of linkRowByKey) {
      if (k === key || r.sfAccountId === row.sfAccountId) continue;
      const same = readsGroups
        ? r.sourceGroupId === gid
        : ledger[k] === gid || (r.txId !== row.txId && ledger[r.txId] === gid);
      if (same) return k;
    }
    return null;
  };
  for (const key of unlinkKeys) {
    if (unlinkedKeys.has(key)) continue;
    const row = linkRowByKey.get(key);
    if (!row) continue;
    const partnerKey = partnerKeyOf(key, row);
    const partner = partnerKey ? linkRowByKey.get(partnerKey) : undefined;
    unlinkedKeys.add(key);
    if (!partner || !partnerKey) {
      errors.push(`Could not unlink ${descByKey.get(key) || descriptionFromComment(row.comment) || row.txId}: its other half is not in this sync — it stays linked for now`);
      continue;
    }
    unlinkedKeys.add(partnerKey);
    const leg = (r: LinkableRow): UnlinkLeg => {
      const base = toLinkLeg(r);
      const signed = r.type === 'TRANSFER_OUT' ? -r.absCents : r.absCents;
      return { ...base, newType: expiredTransferLegType(wfTypes.get(r.wfAccountId) ?? '', signed) };
    };
    let result: UnlinkResult;
    try {
      result = await unlinkPairByRecreate((req) => host.saveMany(req), [leg(row), leg(partner)]);
    } catch (e: any) {
      result = { unlinked: false, problems: [String(e?.message ?? e)] };
    }
    if (!result.unlinked) {
      for (const p of result.problems ?? []) errors.push(`Transfer-unlink failed (${row.txId}/${partner.txId}): ${p}`);
      continue;
    }
    if (!readsGroups) {
      const gid = ledger[key] ?? ledger[row.txId];
      for (const [k, r] of [[key, row], [partnerKey, partner]] as const) {
        if (k in ledger) { delete ledger[k]; ledgerChanged = true; }
        if (r.txId in ledger && ledger[r.txId] === gid) { delete ledger[r.txId]; ledgerChanged = true; }
      }
    }
    logChange?.(() => bookkeepingChange({ step: 'transfer-unlink', activityIds: result.activityIds ?? [row.wfId, partner.wfId] }));
  }

  for (const { out, in: inLeg } of detection.pairs) {
    // Resolved per (account, tx id). When SimpleFin gave both sides of the
    // transfer ONE id these two keys still differ — by account — which is what
```

Edit 8 of 9 in `shared/sync-core.ts` — replace:

```ts
      .find((key) => linkRowByKey.has(key));
    const partner = partnerKey ? linkRowByKey.get(partnerKey) : undefined;
    if (!alias || !partner || !partnerKey || queuedKeys.has(aliasKey) || queuedKeys.has(partnerKey)) continue;
    const opposite = new Set([alias.type, partner.type]);
    if (!opposite.has('TRANSFER_IN') || !opposite.has('TRANSFER_OUT')) continue;
    if (alias.absCents !== partner.absCents || alias.wfAccountId === partner.wfAccountId) continue;
```

with:

```ts
      .find((key) => linkRowByKey.has(key));
    const partner = partnerKey ? linkRowByKey.get(partnerKey) : undefined;
    if (!alias || !partner || !partnerKey || queuedKeys.has(aliasKey) || queuedKeys.has(partnerKey)) continue;
    // A leg the person said is not a transfer is never linked again.
    if ([aliasKey, partnerKey].some((k) => unlinkedKeys.has(k) || hasTxOverride(overrides, k, 'notTransfer'))) continue;
    const opposite = new Set([alias.type, partner.type]);
    if (!opposite.has('TRANSFER_IN') || !opposite.has('TRANSFER_OUT')) continue;
    if (alias.absCents !== partner.absCents || alias.wfAccountId === partner.wfAccountId) continue;
```

Edit 9 of 9 in `shared/sync-core.ts` — replace:

```ts
  const relinkCreates: ActivityWrite[] = [];
  const staleLegIds: string[] = [];
  for (const [key, row] of linkRowByKey) {
    if (!isTransferType(row.type) || !row.assetId || linkedKeys.has(key)) continue;
    staleLegIds.push(row.wfId);
    relinkCreates.push({
      accountId: row.wfAccountId,
```

with:

```ts
  const relinkCreates: ActivityWrite[] = [];
  const staleLegIds: string[] = [];
  for (const [key, row] of linkRowByKey) {
    if (!isTransferType(row.type) || !row.assetId || linkedKeys.has(key) || unlinkedKeys.has(key)) continue;
    staleLegIds.push(row.wfId);
    relinkCreates.push({
      accountId: row.wfAccountId,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/sync-core-not-transfer.test.ts shared/sync-core.test.ts shared/sync-core-change-log.test.ts shared/sync-core-change-log-balances.test.ts shared/sync-core-pair-identity.test.ts shared/link-pair.test.ts shared/change-entries.test.ts`
Expected: PASS — 288 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/change-entries.ts shared/link-pair.ts shared/sync-core.ts shared/sync-core-not-transfer.test.ts
git commit -m "Sync: notTransfer — never paired again; an already-linked pair is unlinked and each half retyped

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Undo and Redo, decided purely — planners, availability, the version gate

One function decides every undo and redo (spec B2, U4): `planChangeUndo(entry, op, state, { latest, variant })` → a plan of steps, or a refusal that says why. It reads nothing; the runner (Task 5) gathers `state` and performs the steps. Every plan puts its override steps first. The state check is per kind (a filing's category now; the row's amount, date and note; the rule's presence; the transaction rule's presence), and an entry undone twice, or redone when it is not undone, is refused. `latest` — the newest undo/redo of the entry (`latestReversal`) — says whether it is undone now and which row or rule a previous reversal left behind (`currentRowId`, `currentRuleId`): a redo that re-creates a row gives it a new id, and the next undo must remove THAT row.

`undoAvailability` is what both surfaces render from: `ready` (Undo or Redo), `telegram` (the app, for a category or rule entry, only while a companion has published a version), `update-companion` (the app, for the UNDO of an automatic sync decision while the companion is older than `SYNC_OVERRIDES_SINCE`), or `none`. `reversalChange` builds the entry an undo or redo writes.

Per kind (undo → redo): `category-filed` restores `before` (a move's `before.assignments` is the complete prior state; an automatic filing also sets/clears `noAutoFile` on its tx key) → re-applies `after`; `opening-balance-filed` sets `accounts[sfinId].noOpeningFile` and takes the category off → clears it and files again; `category-rule-created` deletes the rule (variant `unfile`: also takes off what it filed) → re-creates it; `mapping-rule-created` removes/re-adds the rule in `mapping_rules` (a sync retypes); `transfer-link`/`transfer-type` set/clear `notTransfer` on the leg(s) (a sync acts); `balance-correction` sets `noAutoCorrect` (automatic only) and removes the row → clears it and re-imports the row at the same amount; `starting-balance` removes the row → re-imports it; `starting-balance-moved` updates the row back → forward; `duplicate-removed` sets `keepDuplicate` and re-creates the copy (only `keepDuplicate` when a copy an earlier undo put back is still there) → clears `keepDuplicate` (the next re-scan prunes); `import` adds to the skip list and removes the row → takes it off the skip list (the next sync imports it); `amazon-label` sets `noAmazonLabel` and puts the old note back → clears it (the next sync labels again). Removing an import or editing a note on one half of a linked pair is refused: "Undo the transfer link first."

**Files:**
- Modify: `shared/version.ts` (the gate), `shared/change-entries.ts` (append `reversalChange`)
- Create: `shared/change-undo.ts`
- Test: `shared/change-undo.test.ts`

**Interfaces:**
- Consumes: `ChangeEntry`, `ChangeDraft` and the builders (`shared/change-entries.ts`); `ChangeLogItem` (`shared/change-log.ts`: a `ChangeEntry` plus `undone?: { by: string; at: string }`, set when the newest reversing entry is an undo); `ActivityWrite`, `ImportRow` (`shared/sync-host.ts`); `TxOverrideFlag`, `AccountOverrideFlag` (Task 1); `MappingRule` (`shared/types.ts`); `isNewerVersion`, `SIMPLEFIN_SYNC_VERSION` (`shared/version.ts`); `accountTxKey` (tests).
- Produces:

```ts
// shared/version.ts
export const SYNC_OVERRIDES_SINCE = '1.61.0';
export function companionUnderstandsOverrides(companionVersion: string | null): boolean;   // null → true

// shared/change-entries.ts
export function reversalChange(original: ChangeEntry, op: 'undo' | 'redo', extra?: Record<string, unknown>): ChangeDraft;
// actor 'you', same kind/account/subject, summary `Undid: …` / `Redid: …`, before/after swapped for an undo,
// `extra` merged onto `after`, undoable false, reverses { id: original.id, op }.

// shared/change-undo.ts
export type UndoOp = 'undo' | 'redo';
export type UndoVariant = 'plain' | 'unfile';
export const SYNC_DECISION_KINDS: ReadonlySet<string>;     // transfer-link, transfer-type, duplicate-removed, balance-correction, import, amazon-label
export const COMPANION_ONLY_KINDS: ReadonlySet<string>;    // category-filed, opening-balance-filed, category-rule-created
export const UNDO_KINDS: ReadonlySet<string>;              // both, plus mapping-rule-created, starting-balance, starting-balance-moved
export const SPENDING_TAXONOMY = 'spending_categories';
export const UNDO_UPDATE_COMPANION = 'Update the companion first';
export const UNDO_FROM_TELEGRAM = 'Undo this from Telegram: /changes';
export const REDO_FROM_TELEGRAM = 'Redo this from Telegram: /changes';
export const UNDO_TAKES_EFFECT = 'Takes effect on the next sync.';
export const UNDO_LINKED_REFUSAL = 'Undo the transfer link first.';
export const UNDO_UNREACHABLE = "Couldn't reach Wealthfolio — nothing undone.";
export const UNDO_ALREADY_UNDONE = 'That one is already undone.';
export const UNDO_NOT_UNDONE = "That one isn't undone — nothing to redo.";
export const UNDO_NOT_POSSIBLE = "This change can't be undone.";
export const UNDO_NO_KEY = "Couldn't tell which bank transaction this is — nothing was changed.";
export const UNDO_NO_ACCOUNT = "Couldn't tell which account this is — nothing was changed.";
export const UNDO_EXACT_COPY = 'Wealthfolio refused it as an exact copy of a transaction it already has — nothing changed.';
export const undoChangedSince: (op: UndoOp) => string;   // 'It has changed since — nothing was undone.' / '… redone.'
export const undoGone: (op: UndoOp) => string;           // 'That transaction is gone — nothing was undone.' / '… redone.'
export type UndoAvailability =
  | { kind: 'ready'; op: UndoOp }
  | { kind: 'telegram'; op: UndoOp; text: string }
  | { kind: 'update-companion'; op: UndoOp; text: string }
  | { kind: 'none' };
export function undoAvailability(entry: ChangeLogItem, where: { host: 'addon' | 'companion'; companionVersion: string | null }): UndoAvailability;
export function needsOverrideSupport(entry: Pick<ChangeEntry, 'kind' | 'actor'>): boolean;
export function latestReversal(entries: readonly ChangeEntry[], id: string): ChangeEntry | null;   // entries newest first
export function currentRowId(entry: ChangeEntry, latest: ChangeEntry | null): string | null;
export function currentRuleId(entry: ChangeEntry, latest: ChangeEntry | null): string | null;
export interface UndoRow { id: string; accountId: string; type: string; date: string; absCents: number; comment: string; linked: boolean }
export interface UndoState {
  row?: UndoRow | null;
  assignments?: Array<{ taxonomyId: string; categoryId: string }>;
  rule?: { id: string } | null;
  ruleFiled?: string[];
  mappingRules?: MappingRule[];
  startingBalanceId?: string | null;
  txKey?: string | null;
  currency?: string;
}
export type UndoStep =
  | { do: 'set-tx'; txKey: string; flag: TxOverrideFlag; label: string }
  | { do: 'clear-tx'; txKey: string; flag: TxOverrideFlag }
  | { do: 'set-account'; sfinId: string; flag: AccountOverrideFlag; label: string }
  | { do: 'clear-account'; sfinId: string; flag: AccountOverrideFlag }
  | { do: 'skip'; account: string; txId: string }
  | { do: 'unskip'; account: string; txId: string }
  | { do: 'delete'; activityId: string }
  | { do: 'create'; write: ActivityWrite }
  | { do: 'import'; row: ImportRow }
  | { do: 'update'; write: ActivityWrite }
  | { do: 'assign'; activityId: string; taxonomyId: string; categoryId: string }
  | { do: 'unassign'; activityId: string; taxonomyId: string }
  | { do: 'delete-rule'; ruleId: string }
  | { do: 'create-rule'; rule: { name: string; pattern: string; categoryId: string } }
  | { do: 'mapping-remove'; rule: MappingRule }
  | { do: 'mapping-add'; rule: MappingRule };
export interface UndoPlan { op: UndoOp; steps: UndoStep[]; needsSync: boolean; done: string; rowAfter?: string | null | 'created'; ruleAfter?: null | 'created' }
export type UndoDecision = { ok: true; plan: UndoPlan } | { ok: false; reason: string };
export function planChangeUndo(entry: ChangeEntry, op: UndoOp, state: UndoState, opts: { latest: ChangeEntry | null; variant?: UndoVariant }): UndoDecision;
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/change-undo.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import {
  amazonLabelChange, balanceCorrectionChange, bankUpdateChange, categoryFiledChange, categoryRuleCreatedChange,
  duplicateRemovedChange, importChange, mappingRuleCreatedChange, openingBalanceFiledChange, reversalChange,
  stampChange, startingBalanceChange, startingBalanceMovedChange, transferLinkChange, transferTypeChange,
  type ChangeDraft, type ChangeEntry,
} from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import {
  currentRowId, currentRuleId, latestReversal, planChangeUndo, REDO_FROM_TELEGRAM, undoAvailability, undoChangedSince,
  UNDO_ALREADY_UNDONE, UNDO_EXACT_COPY, UNDO_FROM_TELEGRAM, UNDO_LINKED_REFUSAL, UNDO_NO_KEY, UNDO_NOT_POSSIBLE,
  UNDO_NOT_UNDONE, UNDO_UPDATE_COMPANION, type UndoDecision, type UndoPlan, type UndoRow, type UndoState,
} from './change-undo.js';
import { accountTxKey } from './transfers.js';
import { companionUnderstandsOverrides, isNewerVersion, SIMPLEFIN_SYNC_VERSION, SYNC_OVERRIDES_SINCE } from './version.js';

const NOW = new Date('2026-10-13T15:00:00Z');
const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };
const CARD = { sfinId: 'ACT-9c8d', wfId: 'wf-citi', name: 'Citi Card' };
const KEY = accountTxKey('ACT-1f2e', 'TRN-a1b2');
const CARD_KEY = accountTxKey('ACT-9c8d', 'TRN-a1b2');
const entry = (draft: ChangeDraft, writer: 'addon' | 'companion' = 'companion'): ChangeEntry => stampChange(draft, writer, NOW);
const undo = (e: ChangeEntry, extra: Record<string, unknown> = {}) => entry(reversalChange(e, 'undo', extra), 'addon');
const redo = (e: ChangeEntry, extra: Record<string, unknown> = {}) => entry(reversalChange(e, 'redo', extra), 'addon');
const ok = (d: UndoDecision): UndoPlan => {
  if (!d.ok) throw new Error(`refused: ${d.reason}`);
  return d.plan;
};
const reason = (d: UndoDecision) => (d.ok ? 'planned' : d.reason);
const row = (over: Partial<UndoRow> = {}): UndoRow => ({
  id: 'act-1', accountId: 'wf-checking', type: 'WITHDRAWAL', date: '2026-10-11', absCents: 650, comment: 'SQ *BLUE_BOTTLE · TRN-a1b2', linked: false, ...over,
});

const amazonFiling = entry(categoryFiledChange({
  actor: 'auto', account: CARD, txKey: CARD_KEY, activityId: 'act-amz', description: 'AMAZON MKTPL*2K4', amountCents: -1080,
  before: { categoryId: 'cat-on', categoryName: 'Online Shopping', taxonomyId: 'spending_categories' },
  after: { categoryId: 'cat-pc', categoryName: 'Personal Care', taxonomyId: 'spending_categories' },
  why: 'Amazon: Hair Care',
}));
const telegramFiling = entry(categoryFiledChange({
  actor: 'you', activityId: 'act-5', description: 'VENMO *J SMITH',
  before: null, after: { categoryId: 'cat-din', categoryName: 'Dining', taxonomyId: 'spending_categories' },
}));

describe('the version gate', () => {
  it('opens at the release that obeys overrides, and with no companion at all', () => {
    expect(companionUnderstandsOverrides(SYNC_OVERRIDES_SINCE)).toBe(true);
    expect(companionUnderstandsOverrides('9.0.0')).toBe(true);
    expect(companionUnderstandsOverrides('1.59.2')).toBe(false);
    expect(companionUnderstandsOverrides('garbage')).toBe(false);
    expect(companionUnderstandsOverrides(null)).toBe(true);
  });

  it('is never above the version this build ships as, once it ships past 1.59.2', () => {
    // A release that ships Undo below SYNC_OVERRIDES_SINCE would keep its own
    // companion's undos disabled forever: lower the constant to that release.
    if (isNewerVersion(SIMPLEFIN_SYNC_VERSION, '1.59.2')) {
      expect(isNewerVersion(SYNC_OVERRIDES_SINCE, SIMPLEFIN_SYNC_VERSION)).toBe(false);
    }
  });
});

describe('undoAvailability', () => {
  const link = entry(transferLinkChange(
    { account: CHECKING, txKey: KEY, description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-10-08', oldActivityId: 'o1', newActivityId: 'n1' },
    { account: CARD, txKey: CARD_KEY, description: 'PAYMENT THANK YOU', amountCents: 46460, date: '2026-10-08', oldActivityId: 'o2', newActivityId: 'n2' },
  ));
  const app = (companionVersion: string | null) => ({ host: 'addon' as const, companionVersion });

  it('an old companion disables a sync decision’s Undo in the app, with the exact copy', () => {
    expect(undoAvailability(link, app('1.59.2'))).toEqual({ kind: 'update-companion', op: 'undo', text: 'Update the companion first' });
    expect(UNDO_UPDATE_COMPANION).toBe('Update the companion first');
    expect(undoAvailability(link, app(SYNC_OVERRIDES_SINCE))).toEqual({ kind: 'ready', op: 'undo' });
    // Telegram runs in the companion, which is new by definition.
    expect(undoAvailability(link, { host: 'companion', companionVersion: '1.59.2' })).toEqual({ kind: 'ready', op: 'undo' });
  });

  it('a Redo, and an undo that sets no override, never wait for the companion', () => {
    const undone: ChangeLogItem = { ...link, undone: { by: 'a1', at: NOW.toISOString() } };
    expect(undoAvailability(undone, app('1.59.2'))).toEqual({ kind: 'ready', op: 'redo' });
    const yours = entry(balanceCorrectionChange({
      account: CHECKING, actor: 'you', activityId: 'plug-1', amountCents: 215, date: '2026-10-12', activityType: 'CREDIT', comment: 'Balance adjustment · ACT-1f2e · 2026-10-12',
    }));
    expect(undoAvailability(yours, app('1.59.2'))).toEqual({ kind: 'ready', op: 'undo' });
  });

  it('points category and rule entries at Telegram in the app, only when a companion runs', () => {
    expect(undoAvailability(telegramFiling, app('1.61.0'))).toEqual({ kind: 'telegram', op: 'undo', text: UNDO_FROM_TELEGRAM });
    expect(undoAvailability({ ...telegramFiling, undone: { by: 'c', at: NOW.toISOString() } }, app('1.61.0')))
      .toEqual({ kind: 'telegram', op: 'redo', text: REDO_FROM_TELEGRAM });
    expect(undoAvailability(telegramFiling, app(null))).toEqual({ kind: 'none' });
    expect(undoAvailability(telegramFiling, { host: 'companion', companionVersion: null })).toEqual({ kind: 'ready', op: 'undo' });
  });

  it('offers nothing for bank changes, bookkeeping, or an undo entry itself', () => {
    const update = entry(bankUpdateChange({
      account: CHECKING, txKey: KEY, activityId: 'a', description: 'X', amountCents: -1,
      before: { absCents: 1, date: '2026-10-01', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 1, date: '2026-10-01', pending: false, activityType: 'WITHDRAWAL' },
    }));
    expect(undoAvailability(update, app(null))).toEqual({ kind: 'none' });
    expect(undoAvailability(undo(telegramFiling), { host: 'companion', companionVersion: null })).toEqual({ kind: 'none' });
  });
});

describe('the reversal entry and what it leaves behind', () => {
  it('points back at the entry, swaps before and after on an undo, and carries the row it left', () => {
    const plug = entry(balanceCorrectionChange({
      account: CHECKING, actor: 'auto', activityId: 'plug-1', amountCents: -215, date: '2026-10-12', activityType: 'TRANSFER_OUT',
      comment: 'Balance adjustment · ACT-1f2e · 2026-10-12',
    }));
    const u = reversalChange(plug, 'undo', { activityId: undefined });
    expect(u).toMatchObject({ actor: 'you', kind: 'balance-correction', reverses: { id: plug.id, op: 'undo' }, undoable: false, summary: 'Undid: Added a balance correction' });
    expect(u.before).toEqual(plug.after);
    const r = reversalChange(plug, 'redo', { activityId: 'plug-2' });
    expect(r.after).toMatchObject({ activityId: 'plug-2', amountCents: -215 });
    expect(r.summary).toBe('Redid: Added a balance correction');
  });

  it('finds the newest reversal and the row and rule it left', () => {
    const plug = entry(balanceCorrectionChange({
      account: CHECKING, actor: 'auto', activityId: 'plug-1', amountCents: -215, date: '2026-10-12', activityType: 'TRANSFER_OUT', comment: 'c',
    }));
    const u = undo(plug, { activityId: undefined });
    const r = redo(plug, { activityId: 'plug-2' });
    expect(latestReversal([r, u, plug], plug.id)).toBe(r);
    expect(latestReversal([plug], plug.id)).toBeNull();
    expect(currentRowId(plug, null)).toBe('plug-1');
    expect(currentRowId(plug, u)).toBeNull();
    expect(currentRowId(plug, r)).toBe('plug-2');
    const rule = entry(categoryRuleCreatedChange({ ruleId: 'rule-7', name: 'Telegram: X', pattern: 'X', categoryId: 'c', categoryName: 'G' }));
    expect(currentRuleId(rule, null)).toBe('rule-7');
    expect(currentRuleId(rule, undo(rule, { ruleId: null }))).toBeNull();
    expect(currentRuleId(rule, redo(rule, { ruleId: 'rule-8' }))).toBe('rule-8');
  });
});

describe('planChangeUndo — state checks first', () => {
  it('refuses an undo of a filing the person re-filed since, and plans nothing', () => {
    const d = planChangeUndo(amazonFiling, 'undo', { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-gro' }] }, { latest: null });
    expect(d).toEqual({ ok: false, reason: 'It has changed since — nothing was undone.' });
    expect(undoChangedSince('redo')).toBe('It has changed since — nothing was redone.');
  });

  it('refuses to undo twice, or to redo what was never undone', () => {
    expect(reason(planChangeUndo(telegramFiling, 'undo', {}, { latest: undo(telegramFiling) }))).toBe(UNDO_ALREADY_UNDONE);
    expect(reason(planChangeUndo(telegramFiling, 'redo', {}, { latest: null }))).toBe(UNDO_NOT_UNDONE);
    expect(reason(planChangeUndo(telegramFiling, 'redo', {}, { latest: redo(telegramFiling) }))).toBe(UNDO_NOT_UNDONE);
  });

  it('refuses what is not undoable', () => {
    const update = entry(bankUpdateChange({
      account: CHECKING, txKey: KEY, activityId: 'a', description: 'X', amountCents: -1,
      before: { absCents: 1, date: '2026-10-01', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 1, date: '2026-10-01', pending: false, activityType: 'WITHDRAWAL' },
    }));
    expect(reason(planChangeUndo(update, 'undo', {}, { latest: null }))).toBe(UNDO_NOT_POSSIBLE);
  });
});

describe('planChangeUndo — categories', () => {
  it('an automatic filing: noAutoFile first, then the rule’s category back', () => {
    const p = ok(planChangeUndo(amazonFiling, 'undo', { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-pc' }] }, { latest: null }));
    expect(p.steps).toEqual([
      { do: 'set-tx', txKey: CARD_KEY, flag: 'noAutoFile', label: 'AMAZON MKTPL*2K4 · Citi Card' },
      { do: 'unassign', activityId: 'act-amz', taxonomyId: 'spending_categories' },
      { do: 'assign', activityId: 'act-amz', taxonomyId: 'spending_categories', categoryId: 'cat-on' },
    ]);
    expect(p).toMatchObject({ needsSync: false, rowAfter: 'act-amz', done: 'Undone — filed under Online Shopping.' });
    const r = ok(planChangeUndo(amazonFiling, 'redo', { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-on' }] }, { latest: undo(amazonFiling) }));
    expect(r.steps).toEqual([
      { do: 'clear-tx', txKey: CARD_KEY, flag: 'noAutoFile' },
      { do: 'unassign', activityId: 'act-amz', taxonomyId: 'spending_categories' },
      { do: 'assign', activityId: 'act-amz', taxonomyId: 'spending_categories', categoryId: 'cat-pc' },
    ]);
  });

  it('an automatic filing with no tx key uses one the runner derived, or refuses', () => {
    const keyless = entry({ ...categoryFiledChange({
      actor: 'auto', activityId: 'act-amz', description: 'AMAZON', before: null, after: { categoryId: 'cat-pc', categoryName: 'Personal Care' },
    }) });
    const filed = { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-pc' }] };
    expect(reason(planChangeUndo(keyless, 'undo', filed, { latest: null }))).toBe(UNDO_NO_KEY);
    expect(ok(planChangeUndo(keyless, 'undo', { ...filed, txKey: CARD_KEY }, { latest: null })).steps[0]).toMatchObject({ do: 'set-tx', txKey: CARD_KEY });
  });

  it('your filing has no override, and takes the category off', () => {
    const p = ok(planChangeUndo(telegramFiling, 'undo', { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-din' }] }, { latest: null }));
    expect(p.steps).toEqual([{ do: 'unassign', activityId: 'act-5', taxonomyId: 'spending_categories' }]);
    expect(p.done).toBe('Undone — no category.');
    expect(reason(planChangeUndo(telegramFiling, 'redo', { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-x' }] }, { latest: undo(telegramFiling) })))
      .toBe('It has changed since — nothing was redone.');
  });

  it('the undo of a move restores the complete prior state, every taxonomy', () => {
    const move = entry(categoryFiledChange({
      actor: 'you', activityId: 'act-6', description: 'GRANT',
      before: { categoryId: 'inc-1', categoryName: 'Grants', taxonomyId: 'income_categories' },
      after: { categoryId: 'cat-gro', categoryName: 'Groceries', taxonomyId: 'spending_categories' },
      restore: [{ taxonomyId: 'income_categories', categoryId: 'inc-1' }],
    }));
    const p = ok(planChangeUndo(move, 'undo', { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-gro' }] }, { latest: null }));
    expect(p.steps).toEqual([
      { do: 'unassign', activityId: 'act-6', taxonomyId: 'spending_categories' },
      { do: 'assign', activityId: 'act-6', taxonomyId: 'income_categories', categoryId: 'inc-1' },
    ]);
  });

  it('an opening-balance filing: the account’s noOpeningFile, then the category off', () => {
    const opening = entry(openingBalanceFiledChange({
      account: CARD, activityId: 'sb-1', amountCents: -46460, date: '2026-06-18',
      category: { categoryId: 'cat-open', categoryName: 'Opening balances', taxonomyId: 'spending_categories' },
    }));
    const p = ok(planChangeUndo(opening, 'undo', { assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-open' }] }, { latest: null }));
    expect(p.steps).toEqual([
      { do: 'set-account', sfinId: 'ACT-9c8d', flag: 'noOpeningFile', label: 'Citi Card' },
      { do: 'unassign', activityId: 'sb-1', taxonomyId: 'spending_categories' },
    ]);
    const r = ok(planChangeUndo(opening, 'redo', { assignments: [] }, { latest: undo(opening) }));
    expect(r.steps).toEqual([
      { do: 'clear-account', sfinId: 'ACT-9c8d', flag: 'noOpeningFile' },
      { do: 'assign', activityId: 'sb-1', taxonomyId: 'spending_categories', categoryId: 'cat-open' },
    ]);
  });
});

describe('planChangeUndo — rules', () => {
  const rule = entry(categoryRuleCreatedChange({ ruleId: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro', categoryName: 'Groceries' }));

  it('Undo rule deletes it; Undo rule + un-file also takes its charges out', () => {
    expect(ok(planChangeUndo(rule, 'undo', { rule: { id: 'rule-7' } }, { latest: null })).steps).toEqual([{ do: 'delete-rule', ruleId: 'rule-7' }]);
    const p = ok(planChangeUndo(rule, 'undo', { rule: { id: 'rule-7' }, ruleFiled: ['a1', 'a2'] }, { latest: null, variant: 'unfile' }));
    expect(p.steps).toEqual([
      { do: 'delete-rule', ruleId: 'rule-7' },
      { do: 'unassign', activityId: 'a1', taxonomyId: 'spending_categories' },
      { do: 'unassign', activityId: 'a2', taxonomyId: 'spending_categories' },
    ]);
    expect(p).toMatchObject({ ruleAfter: null, done: 'Undone — the rule is gone and 2 charges are back in the needs-a-category list.' });
  });

  it('refuses a rule already gone, and a redo of a rule already back', () => {
    expect(reason(planChangeUndo(rule, 'undo', { rule: null }, { latest: null }))).toBe('That rule is already gone.');
    expect(reason(planChangeUndo(rule, 'redo', { rule: { id: 'rule-9' } }, { latest: undo(rule) }))).toBe('That rule is already there.');
    expect(ok(planChangeUndo(rule, 'redo', { rule: null }, { latest: undo(rule) })).steps)
      .toEqual([{ do: 'create-rule', rule: { name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro' } }]);
  });

  it('a transaction rule comes out of mapping_rules and goes back, and the next sync retypes', () => {
    const mapping = entry(mappingRuleCreatedChange({ rule: { pattern: 'Payment to Ccb', matchType: 'contains', activityType: 'TRANSFER_OUT' } }));
    const r = { pattern: 'Payment to Ccb', matchType: 'contains' as const, activityType: 'TRANSFER_OUT' as const };
    expect(ok(planChangeUndo(mapping, 'undo', { mappingRules: [r] }, { latest: null }))).toMatchObject({ needsSync: true, steps: [{ do: 'mapping-remove', rule: r }] });
    expect(reason(planChangeUndo(mapping, 'undo', { mappingRules: [] }, { latest: null }))).toBe('That transaction rule is already gone.');
    expect(ok(planChangeUndo(mapping, 'redo', { mappingRules: [] }, { latest: undo(mapping) })).steps).toEqual([{ do: 'mapping-add', rule: r }]);
    expect(reason(planChangeUndo(mapping, 'redo', { mappingRules: [r] }, { latest: undo(mapping) }))).toBe('That transaction rule is already there.');
  });
});

describe('planChangeUndo — sync decisions', () => {
  const link = entry(transferLinkChange(
    { account: CHECKING, txKey: KEY, description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-10-08', oldActivityId: 'o1', newActivityId: 'n1' },
    { account: CARD, txKey: CARD_KEY, description: 'PAYMENT THANK YOU', amountCents: 46460, date: '2026-10-08', oldActivityId: 'o2', newActivityId: 'n2' },
  ));

  it('a link: notTransfer on both legs, then a sync; a redo clears both', () => {
    const p = ok(planChangeUndo(link, 'undo', {}, { latest: null }));
    expect(p.steps).toEqual([
      { do: 'set-tx', txKey: KEY, flag: 'notTransfer', label: 'CITI AUTOPAY · Checking' },
      { do: 'set-tx', txKey: CARD_KEY, flag: 'notTransfer', label: 'CITI AUTOPAY · Citi Card' },
    ]);
    expect(p).toMatchObject({ needsSync: true, done: 'Undone — the next sync counts each half as spending or money in.' });
    expect(ok(planChangeUndo(link, 'redo', {}, { latest: undo(link) })).steps).toEqual([
      { do: 'clear-tx', txKey: KEY, flag: 'notTransfer' },
      { do: 'clear-tx', txKey: CARD_KEY, flag: 'notTransfer' },
    ]);
  });

  it('a held transfer: notTransfer on that one leg', () => {
    const held = entry(transferTypeChange({
      account: CHECKING, txKey: KEY, activityId: 'ph-1', description: 'Online Transfer to Savings', amountCents: -130000, date: '2026-10-11',
      activityType: 'TRANSFER_OUT', previousType: null, held: true,
    }));
    expect(ok(planChangeUndo(held, 'undo', {}, { latest: null }))).toMatchObject({
      needsSync: true, done: 'Undone — the next sync counts it as spending or money in.',
      steps: [{ do: 'set-tx', txKey: KEY, flag: 'notTransfer', label: 'Online Transfer to Savings · Checking' }],
    });
  });

  const dup = entry(duplicateRemovedChange({
    account: CHECKING, txKey: KEY, activityId: 'act-dup', description: 'TRADER JOE S #628', amountCents: -2120, date: '2026-08-06',
    payload: { accountId: 'wf-checking', activityType: 'WITHDRAWAL', activityDate: '2026-08-06', symbol: { symbol: '$CASH-USD' }, amount: 21.2, currency: 'USD', comment: 'TRADER JOE S #628 · TRN-a1b2' },
  }));

  it('a removed duplicate: keepDuplicate first, then the copy back; a copy already back is only kept', () => {
    const p = ok(planChangeUndo(dup, 'undo', { row: null }, { latest: null }));
    expect(p.steps.map((s) => s.do)).toEqual(['set-tx', 'create']);
    expect(p).toMatchObject({ rowAfter: 'created', needsSync: false });
    const again = ok(planChangeUndo(dup, 'undo', { row: row({ id: 'copy-1' }) }, { latest: redo(dup, { activityId: 'copy-1' }) }));
    expect(again.steps).toEqual([{ do: 'set-tx', txKey: KEY, flag: 'keepDuplicate', label: 'TRADER JOE S #628 · Checking' }]);
    expect(again.rowAfter).toBe('copy-1');
    expect(ok(planChangeUndo(dup, 'redo', {}, { latest: undo(dup, { activityId: 'copy-1' }) }))).toMatchObject({
      needsSync: true, rowAfter: 'copy-1', steps: [{ do: 'clear-tx', txKey: KEY, flag: 'keepDuplicate' }],
    });
    expect(UNDO_EXACT_COPY).toBe('Wealthfolio refused it as an exact copy of a transaction it already has — nothing changed.');
  });

  const imported = entry(importChange({
    account: CHECKING, txKey: KEY, activityId: 'act-1', description: 'SQ *BLUE_BOTTLE', amountCents: -650, date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
  }));

  it('an import: onto the skip list, then the row removed; a linked row is refused', () => {
    expect(ok(planChangeUndo(imported, 'undo', { row: row() }, { latest: null })).steps).toEqual([
      { do: 'skip', account: 'ACT-1f2e', txId: 'TRN-a1b2' },
      { do: 'delete', activityId: 'act-1' },
    ]);
    expect(reason(planChangeUndo(imported, 'undo', { row: row({ linked: true }) }, { latest: null }))).toBe(UNDO_LINKED_REFUSAL);
    expect(UNDO_LINKED_REFUSAL).toBe('Undo the transfer link first.');
    expect(ok(planChangeUndo(imported, 'undo', { row: null }, { latest: null })).steps).toEqual([{ do: 'skip', account: 'ACT-1f2e', txId: 'TRN-a1b2' }]);
    expect(ok(planChangeUndo(imported, 'redo', {}, { latest: undo(imported) }))).toMatchObject({
      needsSync: true, steps: [{ do: 'unskip', account: 'ACT-1f2e', txId: 'TRN-a1b2' }],
    });
  });

  const label = entry(amazonLabelChange({
    account: CARD, txKey: CARD_KEY, activityId: 'act-4', description: 'AMAZON MKTPL*2K4', amountCents: -1080, date: '2026-09-15',
    beforeNote: 'AMAZON MKTPL*2K4 · TRN-a1b2', afterNote: 'AMAZON MKTPL*2K4 · Amazon: Hair Care · TRN-a1b2', label: 'Hair Care',
  }));

  it('an Amazon label: noAmazonLabel, then the old note back; a changed or linked note is refused', () => {
    const labelled = row({ id: 'act-4', accountId: 'wf-citi', absCents: 1080, date: '2026-09-15', comment: 'AMAZON MKTPL*2K4 · Amazon: Hair Care · TRN-a1b2' });
    expect(ok(planChangeUndo(label, 'undo', { row: labelled, currency: 'USD' }, { latest: null })).steps).toEqual([
      { do: 'set-tx', txKey: CARD_KEY, flag: 'noAmazonLabel', label: 'AMAZON MKTPL*2K4 · Citi Card' },
      { do: 'update', write: { id: 'act-4', accountId: 'wf-citi', activityType: 'WITHDRAWAL', activityDate: '2026-09-15', amount: 10.8, currency: 'USD', comment: 'AMAZON MKTPL*2K4 · TRN-a1b2' } },
    ]);
    expect(reason(planChangeUndo(label, 'undo', { row: { ...labelled, comment: 'edited by hand' } }, { latest: null }))).toBe('It has changed since — nothing was undone.');
    expect(reason(planChangeUndo(label, 'undo', { row: { ...labelled, linked: true } }, { latest: null }))).toBe(UNDO_LINKED_REFUSAL);
    expect(reason(planChangeUndo(label, 'undo', { row: null }, { latest: null }))).toBe('That transaction is gone — nothing was undone.');
    expect(ok(planChangeUndo(label, 'redo', {}, { latest: undo(label, { activityId: 'act-4' }) }))).toMatchObject({
      needsSync: true, rowAfter: 'act-4', steps: [{ do: 'clear-tx', txKey: CARD_KEY, flag: 'noAmazonLabel' }],
    });
  });

  const plug = entry(balanceCorrectionChange({
    account: CHECKING, actor: 'auto', activityId: 'plug-1', amountCents: -215, date: '2026-10-12', activityType: 'TRANSFER_OUT',
    comment: 'Balance adjustment · ACT-1f2e · 2026-10-12',
  }));

  it('an automatic correction: noAutoCorrect first, then the row removed; a redo puts it back at the same amount', () => {
    const there = row({ id: 'plug-1', absCents: 215, comment: 'Balance adjustment · ACT-1f2e · 2026-10-12' });
    expect(ok(planChangeUndo(plug, 'undo', { row: there }, { latest: null })).steps).toEqual([
      { do: 'set-account', sfinId: 'ACT-1f2e', flag: 'noAutoCorrect', label: 'Checking' },
      { do: 'delete', activityId: 'plug-1' },
    ]);
    expect(reason(planChangeUndo(plug, 'undo', { row: { ...there, absCents: 300 } }, { latest: null }))).toBe('It has changed since — nothing was undone.');
    expect(reason(planChangeUndo(plug, 'undo', { row: null }, { latest: null }))).toBe('That correction is gone — nothing was undone.');
    const r = ok(planChangeUndo(plug, 'redo', { row: null, currency: 'USD' }, { latest: undo(plug, { activityId: undefined }) }));
    expect(r.steps).toEqual([
      { do: 'clear-account', sfinId: 'ACT-1f2e', flag: 'noAutoCorrect' },
      { do: 'import', row: {
        accountId: 'wf-checking', sourceSystem: 'simplefin', activityType: 'TRANSFER_OUT', date: '2026-10-12', symbol: '$CASH-USD',
        amount: 2.15, fee: 0, currency: 'USD', comment: 'Balance adjustment · ACT-1f2e · 2026-10-12', isValid: true, isDraft: false,
      } },
    ]);
    expect(r.rowAfter).toBe('created');
  });
});

describe('planChangeUndo — starting balances', () => {
  const sb = entry(startingBalanceChange({
    account: CARD, activityId: 'sb-1', amountCents: -46460, date: '2026-06-18', activityType: 'WITHDRAWAL', comment: 'Starting balance · ACT-9c8d',
  }));

  it('a new starting balance comes out, and goes back in, warning about the bank', () => {
    const there = row({ id: 'sb-1', accountId: 'wf-citi', absCents: 46460, date: '2026-06-18', comment: 'Starting balance · ACT-9c8d' });
    const p = ok(planChangeUndo(sb, 'undo', { row: there }, { latest: null }));
    expect(p.steps).toEqual([{ do: 'delete', activityId: 'sb-1' }]);
    expect(p.done).toBe("Undone — the starting balance is gone, so the account may no longer match the bank's balance.");
    expect(reason(planChangeUndo(sb, 'redo', { startingBalanceId: 'sb-9' }, { latest: undo(sb) }))).toBe('This account has a starting balance again.');
    expect(ok(planChangeUndo(sb, 'redo', { startingBalanceId: null, currency: 'USD' }, { latest: undo(sb) })).steps[0]).toMatchObject({
      do: 'import', row: { accountId: 'wf-citi', activityType: 'WITHDRAWAL', date: '2026-06-18', amount: 464.6, comment: 'Starting balance · ACT-9c8d' },
    });
  });

  it('a moved starting balance goes back to its old amount and date, only if it still reads as moved', () => {
    const moved = entry(startingBalanceMovedChange({
      account: CHECKING, actor: 'auto', activityId: 'sb-2',
      before: { amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' },
      after: { amountCents: 80000, date: '2026-04-22', activityType: 'CREDIT' },
    }));
    const now = row({ id: 'sb-2', type: 'CREDIT', absCents: 80000, date: '2026-04-22', comment: 'Starting balance · ACT-1f2e' });
    expect(ok(planChangeUndo(moved, 'undo', { row: now, currency: 'USD' }, { latest: null })).steps).toEqual([{
      do: 'update',
      write: { id: 'sb-2', accountId: 'wf-checking', activityType: 'CREDIT', activityDate: '2026-06-19', amount: 1200, currency: 'USD', comment: 'Starting balance · ACT-1f2e' },
    }]);
    expect(reason(planChangeUndo(moved, 'undo', { row: { ...now, date: '2026-04-01' } }, { latest: null }))).toBe('It has changed since — nothing was undone.');
    expect(ok(planChangeUndo(moved, 'redo', { row: { ...now, absCents: 120000, date: '2026-06-19' }, currency: 'USD' }, { latest: undo(moved, { activityId: 'sb-2' }) })).steps[0])
      .toMatchObject({ do: 'update', write: { activityDate: '2026-04-22', amount: 800 } });
  });
});

describe('every undoable kind has a planner', () => {
  it('no kind marked undoable falls through to "can\'t be undone"', () => {
    const state: UndoState = {
      row: row(), assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-pc' }], rule: { id: 'rule-7' },
      mappingRules: [{ pattern: 'P', matchType: 'contains', activityType: 'TRANSFER_OUT' }], currency: 'USD',
    };
    const entries: ChangeEntry[] = [
      amazonFiling,
      entry(categoryRuleCreatedChange({ ruleId: 'rule-7', name: 'n', pattern: 'p', categoryId: 'c', categoryName: 'G' })),
      entry(mappingRuleCreatedChange({ rule: { pattern: 'P', matchType: 'contains', activityType: 'TRANSFER_OUT' } })),
    ];
    for (const e of entries) expect(reason(planChangeUndo(e, 'undo', state, { latest: null }))).not.toBe(UNDO_NOT_POSSIBLE);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/change-undo.test.ts`
Expected: FAIL — `./change-undo.js` does not exist, and `reversalChange`, `SYNC_OVERRIDES_SINCE` and `companionUnderstandsOverrides` are not exported.

- [ ] **Step 3: Implement**

**Edit `shared/version.ts`** — one edit: the gate, before `INSTALLED_ADDON_VERSION_SECRET_KEY`.

Edit 1 of 1 in `shared/version.ts` — replace:

```ts
  return false;
}

/** The companion writes the version in the INSTALLED addon's manifest here
 *  (read off disk), so a browser tab can tell "I am an old bundle — reload me"
 *  apart from "the old zip is still installed — upload the new one". */
```

with:

```ts
  return false;
}

/**
 * The first release whose companion obeys `sync_overrides` (the change log's
 * Undo, R2). Undo of a SYNC decision only records an override and lets the
 * next sync act on it, so an older companion — which ignores the document —
 * would simply redo the decision. Until the companion publishes this version
 * or newer, the app disables those undos ("Update the companion first").
 * `shared/change-undo.test.ts` fails if a release ships below it.
 */
export const SYNC_OVERRIDES_SINCE = '1.61.0';

/** True when `companionVersion` obeys overrides. No companion at all (null)
 *  is true: nothing else is syncing that could ignore them. */
export function companionUnderstandsOverrides(companionVersion: string | null): boolean {
  if (companionVersion === null) return true;
  return companionVersion === SYNC_OVERRIDES_SINCE || isNewerVersion(companionVersion, SYNC_OVERRIDES_SINCE);
}

/** The companion writes the version in the INSTALLED addon's manifest here
 *  (read off disk), so a browser tab can tell "I am an old bundle — reload me"
 *  apart from "the old zip is still installed — upload the new one". */
```

**Edit `shared/change-entries.ts`** — one edit: append `reversalChange` at the end of the file.

Edit 1 of 1 in `shared/change-entries.ts` — replace:

```ts
    summary,
    after: { step: f.step, count: n, ...(f.categoryName ? { categoryName: f.categoryName } : {}) },
    undoable: false,
  };
}
```

with:

```ts
    summary,
    after: { step: f.step, count: n, ...(f.categoryName ? { categoryName: f.categoryName } : {}) },
    undoable: false,
  };
}

// ── Undo and Redo (R2) ───────────────────────────────────────────────────

/**
 * The entry an Undo or a Redo writes, in the undoer's own bucket. Same kind,
 * account and subject as the entry it reverses (so it files under the same
 * filter), `reverses` pointing back at it, and `before`/`after` the other way
 * round for an undo. `extra` lands on `after`: the row or rule id the reversal
 * left behind (`activityId`, `ruleId`), which the next undo or redo of the same
 * entry acts on — a re-created row has a new id. Never itself undoable: you
 * undo or redo the original.
 */
export function reversalChange(
  original: ChangeEntry,
  op: 'undo' | 'redo',
  extra: Record<string, unknown> = {},
): ChangeDraft {
  const [before, after] = op === 'undo' ? [original.after, original.before] : [original.before, original.after];
  return {
    actor: 'you',
    kind: original.kind,
    ...(original.account ? { account: { ...original.account } } : {}),
    subject: { ...original.subject },
    summary: `${op === 'undo' ? 'Undid' : 'Redid'}: ${original.summary}`,
    ...(before ? { before: { ...before } } : {}),
    after: { ...(after ?? {}), ...extra },
    undoable: false,
    reverses: { id: original.id, op },
  };
}
```

**Create `shared/change-undo.ts`:**

```ts
/**
 * shared/change-undo.ts
 *
 * Undo and Redo of a change-log entry, decided purely: (entry, what is there
 * now) → a plan of steps, or a refusal that says why. Nothing here reads or
 * writes; `shared/change-undo-run.ts` gathers the state, runs the plan on a
 * host and records the result. Both surfaces — `/changes` and the app's Change
 * log card — go through the same planner, so an Undo means one thing.
 *
 * The principle (spec B2): the sync owns the books. Undo of a SYNC decision
 * records an override (shared/sync-overrides.ts) and the next sync acts on it;
 * filings, rules and the sync's own correction rows are reversed directly.
 *
 * Every plan puts its override steps FIRST: an override left behind by a
 * reversal that then failed is harmless, and the failure is reported.
 */
import type { ChangeEntry } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import type { ActivityWrite, ImportRow } from './sync-host.js';
import type { AccountOverrideFlag, TxOverrideFlag } from './sync-overrides.js';
import type { MappingRule } from './types.js';
import { companionUnderstandsOverrides } from './version.js';

export type UndoOp = 'undo' | 'redo';
/** A rule's Undo comes in two: the rule alone, or the rule and the charges it filed. */
export type UndoVariant = 'plain' | 'unfile';

/** Kinds whose undo the SYNC carries out (an override): gated on the companion's version. */
export const SYNC_DECISION_KINDS: ReadonlySet<string> = new Set([
  'transfer-link', 'transfer-type', 'duplicate-removed', 'balance-correction', 'import', 'amazon-label',
]);
/** Kinds only the companion can reverse: the add-on SDK has no category or rule API. */
export const COMPANION_ONLY_KINDS: ReadonlySet<string> = new Set([
  'category-filed', 'opening-balance-filed', 'category-rule-created',
]);
export const UNDO_KINDS: ReadonlySet<string> = new Set([
  ...SYNC_DECISION_KINDS, ...COMPANION_ONLY_KINDS, 'mapping-rule-created', 'starting-balance', 'starting-balance-moved',
]);

export const SPENDING_TAXONOMY = 'spending_categories';

// ── Copy (both surfaces) ─────────────────────────────────────────────────
export const UNDO_UPDATE_COMPANION = 'Update the companion first';
export const UNDO_FROM_TELEGRAM = 'Undo this from Telegram: /changes';
export const REDO_FROM_TELEGRAM = 'Redo this from Telegram: /changes';
export const UNDO_TAKES_EFFECT = 'Takes effect on the next sync.';
export const UNDO_LINKED_REFUSAL = 'Undo the transfer link first.';
export const UNDO_UNREACHABLE = "Couldn't reach Wealthfolio — nothing undone.";
export const UNDO_ALREADY_UNDONE = 'That one is already undone.';
export const UNDO_NOT_UNDONE = "That one isn't undone — nothing to redo.";
export const UNDO_NOT_POSSIBLE = "This change can't be undone.";
export const UNDO_NO_KEY = "Couldn't tell which bank transaction this is — nothing was changed.";
export const UNDO_NO_ACCOUNT = "Couldn't tell which account this is — nothing was changed.";
export const UNDO_EXACT_COPY = 'Wealthfolio refused it as an exact copy of a transaction it already has — nothing changed.';
export const undoChangedSince = (op: UndoOp) => `It has changed since — nothing was ${op === 'undo' ? 'undone' : 'redone'}.`;
export const undoGone = (op: UndoOp) => `That transaction is gone — nothing was ${op === 'undo' ? 'undone' : 'redone'}.`;

export type UndoAvailability =
  | { kind: 'ready'; op: UndoOp }
  /** The app, for a kind only the companion can undo. */
  | { kind: 'telegram'; op: UndoOp; text: string }
  /** The app, for a sync decision while the companion is too old to obey overrides. */
  | { kind: 'update-companion'; op: UndoOp; text: string }
  | { kind: 'none' };

/**
 * What an entry offers, where. Never for an entry that is itself an undo or a
 * redo (you reverse the original). In the app, a category or rule entry points
 * at Telegram — only when a companion runs — and a sync decision's Undo waits
 * for a companion that obeys overrides. The companion is new by definition.
 */
export function undoAvailability(
  entry: ChangeLogItem,
  where: { host: 'addon' | 'companion'; companionVersion: string | null },
): UndoAvailability {
  if (!entry.undoable || entry.reverses || !UNDO_KINDS.has(entry.kind)) return { kind: 'none' };
  const op: UndoOp = entry.undone ? 'redo' : 'undo';
  if (where.host === 'addon' && COMPANION_ONLY_KINDS.has(entry.kind)) {
    return where.companionVersion
      ? { kind: 'telegram', op, text: op === 'undo' ? UNDO_FROM_TELEGRAM : REDO_FROM_TELEGRAM }
      : { kind: 'none' };
  }
  if (where.host === 'addon' && op === 'undo' && needsOverrideSupport(entry)
    && !companionUnderstandsOverrides(where.companionVersion)) {
    return { kind: 'update-companion', op, text: UNDO_UPDATE_COMPANION };
  }
  return { kind: 'ready', op };
}

/** An automatic sync decision: its undo is an override the sync must obey. */
export function needsOverrideSupport(entry: Pick<ChangeEntry, 'kind' | 'actor'>): boolean {
  return SYNC_DECISION_KINDS.has(entry.kind) && entry.actor === 'auto';
}

/** The newest undo or redo of `id` in a newest-first list, or null. */
export function latestReversal(entries: readonly ChangeEntry[], id: string): ChangeEntry | null {
  return entries.find((e) => e.reverses?.id === id) ?? null;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The row the entry's next undo or redo acts on. A reversal records the row it
 * left behind (`after.activityId`, absent when it removed the row), so after
 * the first one THAT is the answer; before it, the entry's own row.
 */
export function currentRowId(entry: ChangeEntry, latest: ChangeEntry | null): string | null {
  if (latest) return str(rec(latest.after).activityId);
  switch (entry.kind) {
    case 'balance-correction':
    case 'starting-balance':
      return str(rec(entry.after).activityId) ?? entry.subject.activityIds?.[0] ?? null;
    case 'starting-balance-moved':
      return str(rec(entry.before).activityId) ?? entry.subject.activityIds?.[0] ?? null;
    case 'duplicate-removed':
      // The copy was removed; there is no row until an undo puts one back.
      return null;
    default:
      return entry.subject.activityIds?.[0] ?? null;
  }
}

/** The category rule the next undo or redo acts on (null: none known by id). */
export function currentRuleId(entry: ChangeEntry, latest: ChangeEntry | null): string | null {
  return latest ? str(rec(latest.after).ruleId) : str(rec(entry.after).ruleId);
}

/** A row as the planner needs it, re-read by the runner. */
export interface UndoRow {
  id: string;
  accountId: string;
  type: string;
  date: string;
  absCents: number;
  comment: string;
  /** One half of a linked transfer. */
  linked: boolean;
}

/** What is there now, read by the runner — each kind reads only what it needs. */
export interface UndoState {
  /** The row (`currentRowId`, or found by its tx key); null: gone. */
  row?: UndoRow | null;
  /** Category kinds: every taxonomy's assignment on the row now. */
  assignments?: Array<{ taxonomyId: string; categoryId: string }>;
  /** Rule kinds: the rule now, found by id or by name; null: none. */
  rule?: { id: string } | null;
  /** The un-file variant: what the rule filed (activity ids). */
  ruleFiled?: string[];
  mappingRules?: MappingRule[];
  /** Starting-balance redo: the account's starting-balance row now, or null. */
  startingBalanceId?: string | null;
  /** The entry's tx key, or one derived from the row's note when it has none. */
  txKey?: string | null;
  /** The account's currency, for a row written back. */
  currency?: string;
}

export type UndoStep =
  | { do: 'set-tx'; txKey: string; flag: TxOverrideFlag; label: string }
  | { do: 'clear-tx'; txKey: string; flag: TxOverrideFlag }
  | { do: 'set-account'; sfinId: string; flag: AccountOverrideFlag; label: string }
  | { do: 'clear-account'; sfinId: string; flag: AccountOverrideFlag }
  | { do: 'skip'; account: string; txId: string }
  | { do: 'unskip'; account: string; txId: string }
  | { do: 'delete'; activityId: string }
  /** Re-create a removed duplicate. A refusal as an exact copy rolls back the plan's overrides. */
  | { do: 'create'; write: ActivityWrite }
  /** Put a starting balance or a correction back (the import endpoint); the id is read back by note. */
  | { do: 'import'; row: ImportRow }
  | { do: 'update'; write: ActivityWrite }
  | { do: 'assign'; activityId: string; taxonomyId: string; categoryId: string }
  | { do: 'unassign'; activityId: string; taxonomyId: string }
  | { do: 'delete-rule'; ruleId: string }
  | { do: 'create-rule'; rule: { name: string; pattern: string; categoryId: string } }
  | { do: 'mapping-remove'; rule: MappingRule }
  | { do: 'mapping-add'; rule: MappingRule };

export interface UndoPlan {
  op: UndoOp;
  steps: UndoStep[];
  /** A sync carries it out: the surface says "Takes effect on the next sync." and offers Sync now. */
  needsSync: boolean;
  /** What to say when it worked. */
  done: string;
  /** The row after this plan: its id, null when it removes the row, 'created'
   *  when a `create`/`import` step makes it, undefined for kinds without one. */
  rowAfter?: string | null | 'created';
  /** The rule after this plan, likewise. */
  ruleAfter?: null | 'created';
}

export type UndoDecision = { ok: true; plan: UndoPlan } | { ok: false; reason: string };

const refuse = (reason: string): UndoDecision => ({ ok: false, reason });
const plan = (p: UndoPlan): UndoDecision => ({ ok: true, plan: p });

/** What an override is called in the overrides list: the bank text and the account. */
function labelOf(entry: ChangeEntry, accountName?: string): string {
  const what = entry.subject.description?.trim() || 'a transaction';
  const where = accountName ?? entry.account?.name;
  return where ? `${what} · ${where}` : what;
}

const sameRule = (a: MappingRule, b: MappingRule) =>
  a.pattern === b.pattern && a.matchType === b.matchType && a.activityType === b.activityType && (a.subtype ?? '') === (b.subtype ?? '');

function mappingRuleOf(entry: ChangeEntry): MappingRule | null {
  const r = rec(rec(entry.after).rule);
  const pattern = str(r.pattern);
  const matchType = r.matchType === 'contains' || r.matchType === 'regex' ? r.matchType : null;
  const activityType = str(r.activityType);
  if (!pattern || !matchType || !activityType) return null;
  return { pattern, matchType, activityType: activityType as MappingRule['activityType'], ...(str(r.subtype) ? { subtype: str(r.subtype)! } : {}) };
}

/**
 * Decide an undo or a redo. `latest` is the newest undo/redo of this entry
 * (`latestReversal`): it says whether the entry is undone now and which row or
 * rule the reversal left behind.
 */
export function planChangeUndo(
  entry: ChangeEntry,
  op: UndoOp,
  state: UndoState,
  opts: { latest: ChangeEntry | null; variant?: UndoVariant },
): UndoDecision {
  if (!entry.undoable || entry.reverses || !UNDO_KINDS.has(entry.kind)) return refuse(UNDO_NOT_POSSIBLE);
  const undone = opts.latest?.reverses?.op === 'undo';
  if (op === 'undo' && undone) return refuse(UNDO_ALREADY_UNDONE);
  if (op === 'redo' && !undone) return refuse(UNDO_NOT_UNDONE);
  const before = rec(entry.before);
  const after = rec(entry.after);
  const rowNow = currentRowId(entry, opts.latest);
  const currency = state.currency ?? 'USD';
  const key = state.txKey ?? entry.subject.txKeys?.[0] ?? null;
  const sfinId = entry.account?.sfinId ?? null;

  switch (entry.kind) {
    case 'category-filed': {
      const taxonomy = str(after.taxonomyId) ?? str(before.taxonomyId) ?? SPENDING_TAXONOMY;
      const current = state.assignments ?? [];
      const now = current.find((a) => a.taxonomyId === taxonomy)?.categoryId ?? null;
      const [expected, target] = op === 'undo'
        ? [str(after.categoryId), str(before.categoryId)]
        : [str(before.categoryId), str(after.categoryId)];
      if (now !== expected) return refuse(undoChangedSince(op));
      const activityId = entry.subject.activityIds?.[0];
      if (!activityId) return refuse(UNDO_NOT_POSSIBLE);
      const steps: UndoStep[] = [];
      // An automatic filing would be made again by the next sync's filer.
      if (entry.actor === 'auto') {
        if (!key) return refuse(UNDO_NO_KEY);
        steps.push(op === 'undo'
          ? { do: 'set-tx', txKey: key, flag: 'noAutoFile', label: labelOf(entry) }
          : { do: 'clear-tx', txKey: key, flag: 'noAutoFile' });
      }
      const prior = Array.isArray(before.assignments)
        ? (before.assignments as unknown[]).map(rec).map((a) => ({ taxonomyId: str(a.taxonomyId), categoryId: str(a.categoryId) }))
          .filter((a): a is { taxonomyId: string; categoryId: string } => !!a.taxonomyId && !!a.categoryId)
        : null;
      if (op === 'undo' && prior) {
        // A move's complete prior state: every taxonomy as it was.
        for (const a of current) {
          if (!prior.some((p) => p.taxonomyId === a.taxonomyId)) steps.push({ do: 'unassign', activityId, taxonomyId: a.taxonomyId });
        }
        for (const p of prior) {
          const cur = current.find((a) => a.taxonomyId === p.taxonomyId);
          if (cur?.categoryId === p.categoryId) continue;
          if (cur) steps.push({ do: 'unassign', activityId, taxonomyId: p.taxonomyId });
          steps.push({ do: 'assign', activityId, taxonomyId: p.taxonomyId, categoryId: p.categoryId });
        }
      } else if (target === null) {
        steps.push({ do: 'unassign', activityId, taxonomyId: taxonomy });
      } else {
        if (now !== null) steps.push({ do: 'unassign', activityId, taxonomyId: taxonomy });
        steps.push({ do: 'assign', activityId, taxonomyId: taxonomy, categoryId: target });
      }
      const name = str(op === 'undo' ? before.categoryName : after.categoryName);
      return plan({
        op, steps, needsSync: false, rowAfter: activityId,
        done: `${op === 'undo' ? 'Undone' : 'Redone'} — ${name ? `filed under ${name}` : 'no category'}.`,
      });
    }

    case 'opening-balance-filed': {
      if (!sfinId) return refuse(UNDO_NO_ACCOUNT);
      const activityId = entry.subject.activityIds?.[0];
      const categoryId = str(after.categoryId);
      if (!activityId || !categoryId) return refuse(UNDO_NOT_POSSIBLE);
      const now = (state.assignments ?? []).find((a) => a.taxonomyId === SPENDING_TAXONOMY)?.categoryId ?? null;
      if (now !== (op === 'undo' ? categoryId : null)) return refuse(undoChangedSince(op));
      return plan(op === 'undo'
        ? {
          op, needsSync: false, rowAfter: activityId, done: 'Undone — the opening balance has no category, and stays that way.',
          steps: [
            { do: 'set-account', sfinId, flag: 'noOpeningFile', label: entry.account?.name ?? sfinId },
            { do: 'unassign', activityId, taxonomyId: SPENDING_TAXONOMY },
          ],
        }
        : {
          op, needsSync: false, rowAfter: activityId, done: `Redone — filed under ${str(after.categoryName) ?? 'its category'}.`,
          steps: [
            { do: 'clear-account', sfinId, flag: 'noOpeningFile' },
            { do: 'assign', activityId, taxonomyId: SPENDING_TAXONOMY, categoryId },
          ],
        });
    }

    case 'category-rule-created': {
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
      if (opts.variant === 'unfile') {
        for (const id of state.ruleFiled ?? []) steps.push({ do: 'unassign', activityId: id, taxonomyId: SPENDING_TAXONOMY });
      }
      const n = opts.variant === 'unfile' ? (state.ruleFiled ?? []).length : 0;
      return plan({
        op, steps, needsSync: false, ruleAfter: null,
        done: opts.variant === 'unfile'
          ? `Undone — the rule is gone and ${n} ${n === 1 ? 'charge is' : 'charges are'} back in the needs-a-category list.`
          : 'Undone — the rule is gone.',
      });
    }

    case 'mapping-rule-created': {
      const rule = mappingRuleOf(entry);
      if (!rule) return refuse(UNDO_NOT_POSSIBLE);
      const present = (state.mappingRules ?? []).some((r) => sameRule(r, rule));
      if (op === 'undo' && !present) return refuse('That transaction rule is already gone.');
      if (op === 'redo' && present) return refuse('That transaction rule is already there.');
      return plan({
        op, needsSync: true, done: op === 'undo' ? 'Undone — the rule is gone.' : 'Redone — the rule is back.',
        steps: [op === 'undo' ? { do: 'mapping-remove', rule } : { do: 'mapping-add', rule }],
      });
    }

    case 'transfer-link':
    case 'transfer-type': {
      const keys = entry.subject.txKeys ?? [];
      if (keys.length === 0) return refuse(UNDO_NO_KEY);
      const legs = Array.isArray(after.legs) ? (after.legs as unknown[]).map(rec) : [];
      const steps: UndoStep[] = keys.map((txKey, i) => (op === 'undo'
        ? { do: 'set-tx', txKey, flag: 'notTransfer', label: labelOf(entry, str(legs[i]?.accountName) ?? undefined) } as const
        : { do: 'clear-tx', txKey, flag: 'notTransfer' } as const));
      return plan({
        op, steps, needsSync: true,
        done: op === 'undo'
          ? `Undone — the next sync counts ${keys.length === 2 ? 'each half' : 'it'} as spending or money in.`
          : `Redone — the next sync can treat ${keys.length === 2 ? 'them' : 'it'} as a transfer again.`,
      });
    }

    case 'balance-correction': {
      const auto = entry.actor === 'auto';
      if (auto && !sfinId) return refuse(UNDO_NO_ACCOUNT);
      const amountCents = num(after.amountCents);
      const comment = str(after.comment);
      const accountId = str(after.accountId) ?? entry.account?.wfId ?? null;
      if (amountCents === null || !comment || !accountId) return refuse(UNDO_NOT_POSSIBLE);
      if (op === 'undo') {
        const row = state.row;
        if (!row) return refuse(`That correction is gone — nothing was undone.`);
        if (row.absCents !== Math.abs(amountCents) || row.comment !== comment) return refuse(undoChangedSince(op));
        return plan({
          op, needsSync: false, rowAfter: null, done: 'Undone — the correction is gone.',
          steps: [
            ...(auto ? [{ do: 'set-account', sfinId: sfinId!, flag: 'noAutoCorrect', label: entry.account?.name ?? sfinId! } as const] : []),
            { do: 'delete', activityId: row.id },
          ],
        });
      }
      if (state.row) return refuse('That correction is already there.');
      const activityType = str(after.activityType);
      const date = str(after.date);
      if (!activityType || !date) return refuse(UNDO_NOT_POSSIBLE);
      return plan({
        op, needsSync: false, rowAfter: 'created', done: 'Redone — the correction is back.',
        steps: [
          ...(auto ? [{ do: 'clear-account', sfinId: sfinId!, flag: 'noAutoCorrect' } as const] : []),
          {
            do: 'import',
            row: {
              accountId, sourceSystem: 'simplefin', activityType, date, symbol: `$CASH-${currency}`,
              amount: Math.abs(amountCents) / 100, fee: 0, currency, comment, isValid: true, isDraft: false,
            },
          },
        ],
      });
    }

    case 'starting-balance': {
      const amountCents = num(after.amountCents);
      const date = str(after.date);
      const comment = str(after.comment);
      const activityType = str(after.activityType);
      const accountId = entry.account?.wfId ?? null;
      if (amountCents === null || !date || !comment || !activityType || !accountId) return refuse(UNDO_NOT_POSSIBLE);
      if (op === 'undo') {
        const row = state.row;
        if (!row) return refuse('That starting balance is gone — nothing was undone.');
        if (row.absCents !== Math.abs(amountCents) || row.date !== date) return refuse(undoChangedSince(op));
        return plan({
          op, needsSync: false, rowAfter: null, steps: [{ do: 'delete', activityId: row.id }],
          done: "Undone — the starting balance is gone, so the account may no longer match the bank's balance.",
        });
      }
      if (state.startingBalanceId) return refuse('This account has a starting balance again.');
      return plan({
        op, needsSync: false, rowAfter: 'created', done: 'Redone — the starting balance is back.',
        steps: [{
          do: 'import',
          row: {
            accountId, sourceSystem: 'simplefin', activityType, date, symbol: `$CASH-${currency}`,
            amount: Math.abs(amountCents) / 100, currency, comment, isValid: true, isDraft: false,
          },
        }],
      });
    }

    case 'starting-balance-moved': {
      const [from, to] = op === 'undo' ? [after, before] : [before, after];
      const fromCents = num(from.amountCents);
      const toCents = num(to.amountCents);
      const toDate = str(to.date);
      const toType = str(to.activityType);
      if (fromCents === null || toCents === null || !toDate || !toType) return refuse(UNDO_NOT_POSSIBLE);
      const row = state.row;
      if (!row) return refuse('That starting balance is gone — nothing was changed.');
      if (row.absCents !== Math.abs(fromCents) || row.date !== str(from.date)) return refuse(undoChangedSince(op));
      return plan({
        op, needsSync: false, rowAfter: row.id,
        steps: [{
          do: 'update',
          write: { id: row.id, accountId: row.accountId, activityType: toType, activityDate: toDate, amount: Math.abs(toCents) / 100, currency, comment: row.comment },
        }],
        done: op === 'undo'
          ? "Undone — the starting balance is back as it was, so the account may no longer match the bank's balance."
          : 'Redone.',
      });
    }

    case 'duplicate-removed': {
      if (!key) return refuse(UNDO_NO_KEY);
      if (op === 'redo') {
        return plan({
          op, needsSync: true, rowAfter: rowNow, done: 'Redone — the next re-scan removes the copy again.',
          steps: [{ do: 'clear-tx', txKey: key, flag: 'keepDuplicate' }],
        });
      }
      const payload = rec(before.activity);
      const write = (str(payload.accountId) && str(payload.activityType) && str(payload.activityDate) && typeof payload.comment === 'string')
        ? payload as unknown as ActivityWrite
        : null;
      // A copy an earlier undo put back is still there: keeping it is all that is left to do.
      const steps: UndoStep[] = [{ do: 'set-tx', txKey: key, flag: 'keepDuplicate', label: labelOf(entry) }];
      if (!state.row) {
        if (!write) return refuse(UNDO_NOT_POSSIBLE);
        steps.push({ do: 'create', write });
      }
      return plan({ op, steps, needsSync: false, rowAfter: state.row ? state.row.id : 'created', done: 'Undone — both copies stay.' });
    }

    case 'import': {
      if (!key || !sfinId || !key.startsWith(`${sfinId}\u0000`)) return refuse(UNDO_NO_KEY);
      const txId = key.slice(sfinId.length + 1);
      if (op === 'redo') {
        return plan({
          op, needsSync: true, rowAfter: null, done: 'Redone — the next sync imports it again.',
          steps: [{ do: 'unskip', account: sfinId, txId }],
        });
      }
      const row = state.row ?? null;
      if (row?.linked) return refuse(UNDO_LINKED_REFUSAL);
      return plan({
        op, needsSync: false, rowAfter: null, done: "Undone — it's removed and won't be imported again.",
        steps: [{ do: 'skip', account: sfinId, txId }, ...(row ? [{ do: 'delete', activityId: row.id } as const] : [])],
      });
    }

    case 'amazon-label': {
      if (!key) return refuse(UNDO_NO_KEY);
      if (op === 'redo') {
        return plan({
          op, needsSync: true, rowAfter: rowNow, done: 'Redone — the next sync adds the label again.',
          steps: [{ do: 'clear-tx', txKey: key, flag: 'noAmazonLabel' }],
        });
      }
      const row = state.row;
      const beforeNote = str(before.comment);
      if (!row) return refuse(undoGone(op));
      if (row.linked) return refuse(UNDO_LINKED_REFUSAL);
      if (!beforeNote || row.comment !== str(after.comment)) return refuse(undoChangedSince(op));
      return plan({
        op, needsSync: false, rowAfter: row.id, done: 'Undone — the label is off, and stays off.',
        steps: [
          { do: 'set-tx', txKey: key, flag: 'noAmazonLabel', label: labelOf(entry) },
          { do: 'update', write: { id: row.id, accountId: row.accountId, activityType: row.type, activityDate: row.date, amount: row.absCents / 100, currency, comment: beforeNote } },
        ],
      });
    }

    default:
      return refuse(UNDO_NOT_POSSIBLE);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/change-undo.test.ts shared/change-entries.test.ts shared/version.test.ts`
Expected: PASS — 85 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/version.ts shared/change-entries.ts shared/change-undo.ts shared/change-undo.test.ts
git commit -m "Undo: pure planners per kind, availability and the companion version gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The undo runner, shared by both hosts

`runChangeUndo(entry, entries, op, io, variant, now)` does one undo or redo the way spec B2 orders it: availability (a stale button cannot slip past the gate), re-read the state through `io` — a failed read is "Couldn't reach Wealthfolio — nothing undone." — plan (Task 4), then ALL override steps in ONE `editSyncOverrides` (a corrupt document refuses it, nothing else is written), then the reversal (activities through the host's `SyncHost`; the skip list through `editSkippedTransactions`; `mapping_rules` re-read strictly; categories and rules through the companion-only parts of `io`), then one `reversalChange` entry recorded through `io.record` with `after.activityId` / `after.ruleId` naming what the reversal left. A reversal that fails after its override leaves the override and says what failed ("Couldn't finish the undo: …"); a re-created duplicate refused as an exact copy takes its override back out and answers `UNDO_EXACT_COPY`.

State, per kind: a filing's assignments (`io.categories.assignments`), and — for an automatic filing with no tx key — the key re-derived from the row's note and `account_mapping`; a rule found by its current id (by name + pattern only when the log never had one) and, for "+ un-file", what it filed (`io.rules.filedBy`; unknown refuses); `mapping_rules` (unreadable refuses); the row by `currentRowId` (an import also by its tx id, an id-less R1 starting balance or correction by its note and amount), with `linked` from `sourceGroupId` where the host reads it and from `linked_groups` where it cannot; the account's currency (`listAccounts`, which now carries it). The host's `listAccounts` gains `currency` on both adapters.

**Files:**
- Create: `shared/change-undo-run.ts`
- Modify: `shared/sync-host.ts` (`listAccounts` may carry `currency`), `src/utils/addon-host.ts`, `companion/src/rest-host.ts` (pass it through)
- Test: `shared/change-undo-run.test.ts`

**Interfaces:**
- Consumes: Task 4 (`currentRowId`, `currentRuleId`, `latestReversal`, `planChangeUndo`, `undoAvailability`, `UNDO_EXACT_COPY`, `UNDO_NOT_POSSIBLE`, `UNDO_UNREACHABLE`, `UndoOp`, `UndoPlan`, `UndoRow`, `UndoState`, `UndoStep`, `UndoVariant`; `reversalChange`); Task 1 (`editSyncOverrides`, `isUnreadableOverridesError`, `setTxOverride`, `clearTxOverride`, `setAccountOverride`, `clearAccountOverride`, `SyncOverrides`, `editSkippedTransactions`, `withSkipped`, `withoutSkipped`); `rowIdByComment(read, comment, money?)` and `txIdFromComment` (`shared/sync-core.ts`); `SyncHost`, `HostActivity`; `accountTxKey`; `SecretGet`, `SecretSet`; `MappingRule`; `ChangeLogItem`; `createFakeHost` (tests).
- Produces (`shared/change-undo-run.ts`):

```ts
export const MAPPING_RULES_SECRET_KEY = 'mapping_rules';
export const LINKED_GROUPS_SECRET_KEY = 'linked_groups';
export const ACCOUNT_MAPPING_SECRET_KEY = 'account_mapping';
export const UNDO_SKIP_NOTE = 'Undone in the change log';
export const UNDO_RULE_FILED_UNREADABLE = "Couldn't read which charges the rule filed — nothing was undone.";
export const UNDO_MAPPING_RULES_UNREADABLE = "Your transaction rules can't be read — nothing was changed.";
export interface UndoIo {
  host: SyncHost;
  secrets: { get: SecretGet; set: SecretSet };
  categories?: {
    assignments(activityId: string): Promise<Array<{ taxonomyId: string; categoryId: string }>>;
    assign(activityId: string, taxonomyId: string, categoryId: string): Promise<void>;
    unassign(activityId: string, taxonomyId: string): Promise<void>;
  };
  rules?: {
    list(): Promise<Array<{ id: string; name: string; pattern: string }>>;
    create(rule: { name: string; pattern: string; categoryId: string }): Promise<string | null>;
    remove(id: string): Promise<void>;
    filedBy(rule: { categoryId: string; pattern: string }): Promise<string[] | null>;
  };
  record(draft: ChangeDraft): Promise<void>;
  where: { host: 'addon' | 'companion'; companionVersion: string | null };
}
export type UndoOutcome = { ok: true; message: string; needsSync: boolean } | { ok: false; message: string };
export async function runChangeUndo(
  entry: ChangeLogItem, entries: readonly ChangeEntry[], op: UndoOp, io: UndoIo, variant?: UndoVariant, now?: Date,
): Promise<UndoOutcome>;
// shared/sync-host.ts — SyncHost.listAccounts(): Promise<Array<{ id: string; accountType: string; name?: string; currency?: string }>>
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/change-undo-run.test.ts`:**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  amazonLabelChange, balanceCorrectionChange, categoryFiledChange, categoryRuleCreatedChange, duplicateRemovedChange,
  importChange, mappingRuleCreatedChange, stampChange, transferLinkChange, type ChangeDraft, type ChangeEntry,
} from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import {
  UNDO_EXACT_COPY, UNDO_FROM_TELEGRAM, UNDO_LINKED_REFUSAL, UNDO_UNREACHABLE, UNDO_UPDATE_COMPANION, type UndoOp, type UndoVariant,
} from './change-undo.js';
import {
  runChangeUndo, UNDO_MAPPING_RULES_UNREADABLE, UNDO_RULE_FILED_UNREADABLE, UNDO_SKIP_NOTE, type UndoIo,
} from './change-undo-run.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { SKIPPED_TRANSACTIONS_SECRET_KEY } from './skipped-transactions.js';
import type { HostActivity } from './sync-host.js';
import {
  hasAccountOverride, hasTxOverride, parseSyncOverrides, SYNC_OVERRIDES_SECRET_KEY, SYNC_OVERRIDES_UNREADABLE_MESSAGE,
} from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-13T15:00:00Z');
const CHECKING = { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' };
const KEY = accountTxKey('sfin-1', 'tx-1');

const seedWith = (rows: HostActivity[], extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  mapping: { 'sfin-1': 'wf-a' },
  accountTypes: { 'wf-a': 'CASH' },
  accountNames: { 'wf-a': 'Checking' },
  existing: new Map([['wf-a', rows]]),
  ...extra,
});

/**
 * A host, its secrets and a change log in memory. `undo` runs one Undo/Redo
 * the way a surface does: off the log as it stands, recording into it.
 */
function harness(seed: FakeHostSeed, secrets: Record<string, string> = {}, more: Partial<UndoIo> = {}) {
  const fh = createFakeHost(seed);
  const data = new Map(Object.entries(secrets));
  const log: ChangeEntry[] = [];
  const set = vi.fn(async (k: string, v: string) => { data.set(k, v); });
  const io: UndoIo = {
    host: fh.host,
    secrets: { get: async (k) => data.get(k) ?? null, set },
    record: vi.fn(async (d: ChangeDraft) => { log.unshift(stampChange(d, 'companion', NOW)); }),
    where: { host: 'companion', companionVersion: null },
    ...more,
  };
  const asItem = (e: ChangeEntry): ChangeLogItem => {
    const latest = log.find((x) => x.reverses?.id === e.id);
    return latest?.reverses?.op === 'undo' ? { ...e, undone: { by: latest.id, at: latest.at } } : { ...e };
  };
  const undo = (e: ChangeEntry, op: UndoOp, variant: UndoVariant = 'plain') => runChangeUndo(asItem(e), [...log, e], op, io, variant, NOW);
  const overrides = () => {
    const p = parseSyncOverrides(data.get(SYNC_OVERRIDES_SECRET_KEY));
    if (p.kind !== 'ok') throw new Error(`overrides ${p.kind}`);
    return p.overrides;
  };
  return { fh, data, set, io, log, undo, asItem, overrides };
}

describe('runChangeUndo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const plugRow: HostActivity = {
    id: 'plug-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-10-12', amount: 2.15,
    comment: 'Balance adjustment · sfin-1 · 2026-10-12', sourceGroupId: null,
  };
  const plug = stampChange(balanceCorrectionChange({
    account: CHECKING, actor: 'auto', activityId: 'plug-1', amountCents: -215, date: '2026-10-12', activityType: 'TRANSFER_OUT',
    comment: 'Balance adjustment · sfin-1 · 2026-10-12',
  }), 'companion', new Date('2026-10-12T10:00:00Z'));

  it('undo → redo → undo on one entry: the row, the override and the log stay consistent', async () => {
    const h = harness(seedWith([plugRow]));
    expect(await h.undo(plug, 'undo')).toEqual({ ok: true, message: 'Undone — the correction is gone.', needsSync: false });
    expect(h.fh.activities.get('wf-a')).toEqual([]);
    expect(hasAccountOverride(h.overrides(), 'sfin-1', 'noAutoCorrect')).toBe(true);

    expect(await h.undo(plug, 'redo')).toMatchObject({ ok: true, message: 'Redone — the correction is back.' });
    const back = h.fh.activities.get('wf-a')!;
    expect(back.map((r) => [r.activityType, r.amount, r.comment])).toEqual([['TRANSFER_OUT', 2.15, 'Balance adjustment · sfin-1 · 2026-10-12']]);
    expect(hasAccountOverride(h.overrides(), 'sfin-1', 'noAutoCorrect')).toBe(false);
    expect(h.log[0].after).toMatchObject({ activityId: back[0].id });

    expect(await h.undo(plug, 'undo')).toMatchObject({ ok: true });
    expect(h.fh.activities.get('wf-a')).toEqual([]);
    expect(hasAccountOverride(h.overrides(), 'sfin-1', 'noAutoCorrect')).toBe(true);
    expect(h.log.map((e) => e.reverses)).toEqual([
      { id: plug.id, op: 'undo' }, { id: plug.id, op: 'redo' }, { id: plug.id, op: 'undo' },
    ]);
    expect(h.asItem(plug).undone).toBeDefined();
    // And a fourth tap on a stale Undo button is refused, writing nothing.
    h.set.mockClear();
    expect(await runChangeUndo({ ...plug }, [...h.log, plug], 'undo', h.io, 'plain', NOW)).toEqual({ ok: false, message: 'That one is already undone.' });
    expect(h.set).not.toHaveBeenCalled();
  });

  it('refuses to undo a filing the person re-filed since, and writes nothing', async () => {
    const assign = vi.fn(async () => {});
    const unassign = vi.fn(async () => {});
    const filing = stampChange(categoryFiledChange({
      actor: 'auto', account: CHECKING, txKey: KEY, activityId: 'act-amz', description: 'AMAZON MKTPL*2K4',
      before: null, after: { categoryId: 'cat-pc', categoryName: 'Personal Care', taxonomyId: 'spending_categories' },
    }), 'companion', NOW);
    const h = harness(seedWith([]), {}, {
      categories: { assignments: async () => [{ taxonomyId: 'spending_categories', categoryId: 'cat-gro' }], assign, unassign },
    });
    expect(await h.undo(filing, 'undo')).toEqual({ ok: false, message: 'It has changed since — nothing was undone.' });
    expect(assign).not.toHaveBeenCalled();
    expect(unassign).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
    expect(h.io.record).not.toHaveBeenCalled();
  });

  it('an automatic filing undone: noAutoFile first, then the category off', async () => {
    const calls: string[] = [];
    const filing = stampChange(categoryFiledChange({
      actor: 'auto', account: CHECKING, txKey: KEY, activityId: 'act-amz', description: 'AMAZON MKTPL*2K4',
      before: null, after: { categoryId: 'cat-pc', categoryName: 'Personal Care', taxonomyId: 'spending_categories' },
    }), 'companion', NOW);
    const h = harness(seedWith([]), {}, {
      categories: {
        assignments: async () => [{ taxonomyId: 'spending_categories', categoryId: 'cat-pc' }],
        assign: async () => { calls.push('assign'); },
        unassign: async (id, tax) => { calls.push(`unassign ${id} ${tax}`); },
      },
    });
    h.set.mockImplementation(async (k: string, v: string) => { calls.push(`set ${k}`); h.data.set(k, v); });
    expect(await h.undo(filing, 'undo')).toMatchObject({ ok: true, message: 'Undone — no category.' });
    expect(calls).toEqual([`set ${SYNC_OVERRIDES_SECRET_KEY}`, 'unassign act-amz spending_categories']);
    expect(hasTxOverride(h.overrides(), KEY, 'noAutoFile')).toBe(true);
    expect(h.overrides().tx[KEY]).toMatchObject({ entryId: filing.id, label: 'AMAZON MKTPL*2K4 · Checking' });
  });

  it('a corrupt sync_overrides refuses the undo with a clear message, nothing overwritten or written', async () => {
    const link = stampChange(transferLinkChange(
      { account: CHECKING, txKey: KEY, description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-10-08', oldActivityId: 'o1' },
      { account: { sfinId: 'sfin-2', wfId: 'wf-b', name: 'Citi' }, txKey: accountTxKey('sfin-2', 'tx-1'), description: 'PAYMENT', amountCents: 46460, date: '2026-10-08', oldActivityId: 'o2' },
    ), 'companion', NOW);
    const h = harness(seedWith([]), { [SYNC_OVERRIDES_SECRET_KEY]: '{"v":1,"tx":"broken"}' });
    expect(await h.undo(link, 'undo')).toEqual({ ok: false, message: SYNC_OVERRIDES_UNREADABLE_MESSAGE });
    expect(h.data.get(SYNC_OVERRIDES_SECRET_KEY)).toBe('{"v":1,"tx":"broken"}');
    expect(h.set).not.toHaveBeenCalled();
    expect(h.io.record).not.toHaveBeenCalled();
  });

  it('a duplicate Wealthfolio refuses as an exact copy: nothing changes, and it says why', async () => {
    const survivor: HostActivity = {
      id: 'act-1', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-08-06', amount: 21.2, comment: 'TRADER JOE S #628 · tx-1', sourceGroupId: null,
    };
    const dup = stampChange(duplicateRemovedChange({
      account: CHECKING, txKey: KEY, activityId: 'act-2', description: 'TRADER JOE S #628', amountCents: -2120, date: '2026-08-06',
      payload: { accountId: 'wf-a', activityType: 'WITHDRAWAL', activityDate: '2026-08-06', symbol: { symbol: '$CASH-USD' }, amount: 21.2, currency: 'USD', comment: 'TRADER JOE S #628 · tx-1' },
    }), 'companion', NOW);
    const h = harness(seedWith([survivor], { upstreamWriteRules: true }));
    expect(await h.undo(dup, 'undo')).toEqual({ ok: false, message: UNDO_EXACT_COPY });
    expect(h.fh.activities.get('wf-a')!.map((r) => r.id)).toEqual(['act-1']);
    expect(hasTxOverride(h.overrides(), KEY, 'keepDuplicate')).toBe(false);
    expect(h.io.record).not.toHaveBeenCalled();
  });

  it('a duplicate that differs is put back and kept', async () => {
    const dup = stampChange(duplicateRemovedChange({
      account: CHECKING, txKey: KEY, activityId: 'act-2', description: 'TRADER JOE S #628', amountCents: -2120, date: '2026-08-06',
      payload: { accountId: 'wf-a', activityType: 'WITHDRAWAL', activityDate: '2026-08-07', symbol: { symbol: '$CASH-USD' }, amount: 21.2, currency: 'USD', comment: 'TRADER JOE S #628 · tx-1' },
    }), 'companion', NOW);
    const h = harness(seedWith([], { upstreamWriteRules: true }));
    expect(await h.undo(dup, 'undo')).toEqual({ ok: true, message: 'Undone — both copies stay.', needsSync: false });
    const copy = h.fh.activities.get('wf-a')![0];
    expect(hasTxOverride(h.overrides(), KEY, 'keepDuplicate')).toBe(true);
    expect(h.log[0].after).toMatchObject({ activityId: copy.id });
  });

  const imported = stampChange(importChange({
    account: CHECKING, txKey: KEY, activityId: 'act-1', description: 'SQ *BLUE_BOTTLE', amountCents: -650, date: '2026-10-11',
    pending: false, activityType: 'WITHDRAWAL',
  }), 'companion', NOW);
  const importedRow = (group: string | null = null): HostActivity => ({
    id: 'act-1', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-11', amount: 6.5, comment: 'SQ *BLUE_BOTTLE · tx-1', sourceGroupId: group,
  });

  it('an import: on the skip list, and removed; a redo takes it off the list for the next sync', async () => {
    const h = harness(seedWith([importedRow()]));
    expect(await h.undo(imported, 'undo')).toMatchObject({ ok: true, needsSync: false });
    expect(h.fh.activities.get('wf-a')).toEqual([]);
    expect(JSON.parse(h.data.get(SKIPPED_TRANSACTIONS_SECRET_KEY)!)).toEqual([{ account: 'sfin-1', txId: 'tx-1', note: UNDO_SKIP_NOTE, at: NOW.toISOString() }]);
    expect(await h.undo(imported, 'redo')).toEqual({ ok: true, message: 'Redone — the next sync imports it again.', needsSync: true });
    expect(JSON.parse(h.data.get(SKIPPED_TRANSACTIONS_SECRET_KEY)!)).toEqual([]);
  });

  it('refuses to remove one half of a linked pair, on either host', async () => {
    const companion = harness(seedWith([importedRow('wf-transfer-1')]));
    expect(await companion.undo(imported, 'undo')).toEqual({ ok: false, message: UNDO_LINKED_REFUSAL });
    expect(companion.set).not.toHaveBeenCalled();
    const addon = harness(seedWith([importedRow()]), { linked_groups: JSON.stringify({ [KEY]: 'wf-transfer-1' }) });
    addon.io.host = { ...addon.fh.host, capabilities: { readsSourceGroupId: false } };
    expect(await addon.undo(imported, 'undo')).toEqual({ ok: false, message: UNDO_LINKED_REFUSAL });
    expect(addon.fh.activities.get('wf-a')).toHaveLength(1);
  });

  it('an Amazon label: noAmazonLabel, then the old note back', async () => {
    const label = stampChange(amazonLabelChange({
      account: CHECKING, txKey: KEY, activityId: 'act-amz', description: 'AMAZON.COM*MB3T81', amountCents: -2118, date: '2026-08-06',
      beforeNote: 'AMAZON.COM*MB3T81 · tx-1', afterNote: 'AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · tx-1', label: 'Lawn & Garden',
    }), 'companion', NOW);
    const h = harness(seedWith([{
      id: 'act-amz', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-08-06', amount: 21.18,
      comment: 'AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · tx-1', sourceGroupId: null,
    }]));
    expect(await h.undo(label, 'undo')).toMatchObject({ ok: true });
    expect(h.fh.activities.get('wf-a')![0]).toMatchObject({ comment: 'AMAZON.COM*MB3T81 · tx-1', activityType: 'WITHDRAWAL', amount: 21.18 });
    expect(hasTxOverride(h.overrides(), KEY, 'noAmazonLabel')).toBe(true);
  });

  it('a transaction rule leaves mapping_rules and comes back; an unreadable list is refused', async () => {
    const rule = { pattern: 'Payment to Ccb', matchType: 'contains' as const, activityType: 'TRANSFER_OUT' as const };
    const other = { pattern: 'ZELLE', matchType: 'contains' as const, activityType: 'TRANSFER_IN' as const };
    const mapping = stampChange(mappingRuleCreatedChange({ rule }), 'companion', NOW);
    const h = harness(seedWith([]), { mapping_rules: JSON.stringify([rule, other]) });
    expect(await h.undo(mapping, 'undo')).toEqual({ ok: true, message: 'Undone — the rule is gone.', needsSync: true });
    expect(JSON.parse(h.data.get('mapping_rules')!)).toEqual([other]);
    expect(await h.undo(mapping, 'redo')).toMatchObject({ ok: true, needsSync: true });
    expect(JSON.parse(h.data.get('mapping_rules')!)).toEqual([other, rule]);
    const broken = harness(seedWith([]), { mapping_rules: '[{' });
    expect(await broken.undo(mapping, 'undo')).toEqual({ ok: false, message: UNDO_MAPPING_RULES_UNREADABLE });
    expect(broken.set).not.toHaveBeenCalled();
  });

  describe('category rules', () => {
    const made = (ruleId: string | null) => stampChange(categoryRuleCreatedChange({
      ruleId, name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro', categoryName: 'Groceries',
    }), 'companion', NOW);
    const rulesOver = (list: Array<{ id: string; name: string; pattern: string }>, filed: string[] | null = []) => {
      const unassign = vi.fn(async () => {});
      const io: Partial<UndoIo> = {
        categories: { assignments: async () => [], assign: vi.fn(async () => {}), unassign },
        rules: {
          list: async () => list,
          create: vi.fn(async (r) => { list.push({ id: `rule-${list.length + 8}`, name: r.name, pattern: r.pattern }); return `rule-${list.length + 7}`; }),
          remove: vi.fn(async (id: string) => { list.splice(list.findIndex((r) => r.id === id), 1); }),
          filedBy: async () => filed,
        },
      };
      return { io, unassign, list };
    };

    it('deletes by id, re-creates on a redo, and the next undo deletes the new one', async () => {
      const entry = made('rule-7');
      const r = rulesOver([{ id: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S' }]);
      const h = harness(seedWith([]), {}, r.io);
      expect(await h.undo(entry, 'undo')).toMatchObject({ ok: true, message: 'Undone — the rule is gone.' });
      expect(r.list).toEqual([]);
      expect(await h.undo(entry, 'redo')).toMatchObject({ ok: true });
      expect(h.log[0].after).toMatchObject({ ruleId: 'rule-8' });
      expect(await h.undo(entry, 'undo')).toMatchObject({ ok: true });
      expect(h.io.rules!.remove).toHaveBeenLastCalledWith('rule-8');
    });

    it('finds a rule by name when the log has no id', async () => {
      const r = rulesOver([{ id: 'rule-x', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S' }]);
      const h = harness(seedWith([]), {}, r.io);
      expect(await h.undo(made(null), 'undo')).toMatchObject({ ok: true });
      expect(h.io.rules!.remove).toHaveBeenCalledWith('rule-x');
    });

    it('Undo rule + un-file takes its charges out too, or refuses when it cannot tell which', async () => {
      const r = rulesOver([{ id: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S' }], ['a1', 'a2']);
      const h = harness(seedWith([]), {}, r.io);
      expect(await h.undo(made('rule-7'), 'undo', 'unfile')).toMatchObject({ ok: true, message: 'Undone — the rule is gone and 2 charges are back in the needs-a-category list.' });
      expect(r.unassign.mock.calls).toEqual([['a1', 'spending_categories'], ['a2', 'spending_categories']]);
      expect(h.log[0].after).toMatchObject({ unfiledActivityIds: ['a1', 'a2'] });
      const unknown = rulesOver([{ id: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S' }], null);
      const h2 = harness(seedWith([]), {}, unknown.io);
      expect(await h2.undo(made('rule-7'), 'undo', 'unfile')).toEqual({ ok: false, message: UNDO_RULE_FILED_UNREADABLE });
      expect(unknown.io.rules!.remove).not.toHaveBeenCalled();
    });
  });

  it('the app: a category entry points at Telegram; an old companion blocks a sync decision', async () => {
    const filing = stampChange(categoryFiledChange({
      actor: 'you', activityId: 'act-5', description: 'VENMO', before: null, after: { categoryId: 'c', categoryName: 'Dining' },
    }), 'addon', NOW);
    const app = harness(seedWith([importedRow()]), {}, { where: { host: 'addon', companionVersion: '1.59.2' } });
    expect(await app.undo(filing, 'undo')).toEqual({ ok: false, message: UNDO_FROM_TELEGRAM });
    expect(await app.undo(imported, 'undo')).toEqual({ ok: false, message: UNDO_UPDATE_COMPANION });
    expect(app.fh.activities.get('wf-a')).toHaveLength(1);
    expect(app.set).not.toHaveBeenCalled();
  });

  it('says Wealthfolio could not be reached when the re-read fails, and writes nothing', async () => {
    const h = harness(seedWith([importedRow()]));
    h.io.host = { ...h.fh.host, listActivities: async () => { throw new Error('ECONNREFUSED'); } };
    expect(await h.undo(imported, 'undo')).toEqual({ ok: false, message: UNDO_UNREACHABLE });
    expect(h.set).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/change-undo-run.test.ts`
Expected: FAIL — `./change-undo-run.js` does not exist.

- [ ] **Step 3: Implement**

**Edit `shared/sync-host.ts`** — one edit: `currency` on `listAccounts`.

Edit 1 of 1 in `shared/sync-host.ts` — replace:

```ts

export interface SyncHost {
  fetchSimplefin(accessUrl: string, since: Date, authKey?: string | null): Promise<SimplefinAccountSet>;
  listAccounts(): Promise<Array<{ id: string; accountType: string; name?: string }>>;
  latestValuations(accountIds: string[]): Promise<Map<string, number>>;
  /** The account's most recent activities, newest first. Bounded by the host's
   *  page size, so it is NOT a way to reach an old row on a busy account. */
```

with:

```ts

export interface SyncHost {
  fetchSimplefin(accessUrl: string, since: Date, authKey?: string | null): Promise<SimplefinAccountSet>;
  /** `currency` is the account's own (Undo writes a row back in it); absent
   *  when the host does not say. */
  listAccounts(): Promise<Array<{ id: string; accountType: string; name?: string; currency?: string }>>;
  latestValuations(accountIds: string[]): Promise<Map<string, number>>;
  /** The account's most recent activities, newest first. Bounded by the host's
   *  page size, so it is NOT a way to reach an old row on a busy account. */
```

**Edit `src/utils/addon-host.ts`** — one edit.

Edit 1 of 1 in `src/utils/addon-host.ts` — replace:

```ts
    return fetchAccounts(accessUrl, since, this.ctx.api.network, authKey ?? undefined);
  }

  async listAccounts(): Promise<Array<{ id: string; accountType: string; name?: string }>> {
    const accounts = await this.ctx.api.accounts.getAll();
    return accounts.map((a) => ({
      id: a.id,
      accountType: String(a.accountType ?? ''),
      name: a.name,
    }));
  }

```

with:

```ts
    return fetchAccounts(accessUrl, since, this.ctx.api.network, authKey ?? undefined);
  }

  async listAccounts(): Promise<Array<{ id: string; accountType: string; name?: string; currency?: string }>> {
    const accounts = await this.ctx.api.accounts.getAll();
    return accounts.map((a) => ({
      id: a.id,
      accountType: String(a.accountType ?? ''),
      name: a.name,
      ...(a.currency ? { currency: String(a.currency) } : {}),
    }));
  }

```

**Edit `companion/src/rest-host.ts`** — one edit.

Edit 1 of 1 in `companion/src/rest-host.ts` — replace:

```ts
    return fetchAccountsNode(accessUrl, since);
  }

  async listAccounts(): Promise<Array<{ id: string; accountType: string; name?: string }>> {
    const accounts = await this.client.getAccounts();
    return accounts.map((a: any) => ({
      id: a.id,
      accountType: String(a.accountType ?? ''),
      name: a.name,
    }));
  }

```

with:

```ts
    return fetchAccountsNode(accessUrl, since);
  }

  async listAccounts(): Promise<Array<{ id: string; accountType: string; name?: string; currency?: string }>> {
    const accounts = await this.client.getAccounts();
    return accounts.map((a: any) => ({
      id: a.id,
      accountType: String(a.accountType ?? ''),
      name: a.name,
      ...(a.currency ? { currency: String(a.currency) } : {}),
    }));
  }

```

**Create `shared/change-undo-run.ts`:**

```ts
/**
 * shared/change-undo-run.ts
 *
 * Runs an Undo or a Redo on a host: re-reads what is there now, asks the pure
 * planner (shared/change-undo.ts), performs the plan, and records the result
 * as an entry with `reverses` in the undoer's own bucket. Both hosts call it —
 * the companion behind `/changes`, the add-on behind the Change log card —
 * with their own `UndoIo`; only the companion supplies categories and rules,
 * which the add-on SDK cannot reach.
 *
 * Safety, in order (spec B2):
 *  1. Nothing is written until the state check passes. A failed read is
 *     "Couldn't reach Wealthfolio — nothing undone."
 *  2. Overrides are written first, in ONE edit of the document; a corrupt
 *     document refuses the edit and nothing else is written.
 *  3. A reversal that fails afterwards leaves its override (harmless) and says
 *     what failed. A re-created duplicate Wealthfolio refuses as an exact copy
 *     takes its override back out, so nothing changes.
 *  4. Only a reversal that worked is recorded.
 */
import { reversalChange, type ChangeDraft, type ChangeEntry } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import {
  currentRowId, currentRuleId, latestReversal, planChangeUndo, undoAvailability, UNDO_EXACT_COPY, UNDO_NOT_POSSIBLE,
  UNDO_UNREACHABLE, type UndoOp, type UndoPlan, type UndoRow, type UndoState, type UndoStep, type UndoVariant,
} from './change-undo.js';
import { editSkippedTransactions, withoutSkipped, withSkipped } from './skipped-transactions.js';
import type { SecretGet, SecretSet } from './subscription-prefs.js';
import { rowIdByComment, txIdFromComment } from './sync-core.js';
import type { HostActivity, SyncHost } from './sync-host.js';
import {
  clearAccountOverride, clearTxOverride, editSyncOverrides, isUnreadableOverridesError, setAccountOverride, setTxOverride,
  type SyncOverrides,
} from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { MappingRule } from './types.js';

export const MAPPING_RULES_SECRET_KEY = 'mapping_rules';
export const LINKED_GROUPS_SECRET_KEY = 'linked_groups';
export const ACCOUNT_MAPPING_SECRET_KEY = 'account_mapping';
/** The note a skip-list entry written by Undo carries. */
export const UNDO_SKIP_NOTE = 'Undone in the change log';

export const UNDO_RULE_FILED_UNREADABLE = "Couldn't read which charges the rule filed — nothing was undone.";
export const UNDO_MAPPING_RULES_UNREADABLE = "Your transaction rules can't be read — nothing was changed.";

/** What a host lends the runner. */
export interface UndoIo {
  host: SyncHost;
  secrets: { get: SecretGet; set: SecretSet };
  /** The companion only: every taxonomy's assignment, and the two writes. */
  categories?: {
    assignments(activityId: string): Promise<Array<{ taxonomyId: string; categoryId: string }>>;
    assign(activityId: string, taxonomyId: string, categoryId: string): Promise<void>;
    unassign(activityId: string, taxonomyId: string): Promise<void>;
  };
  /** The companion only: Wealthfolio's categorization rules. */
  rules?: {
    list(): Promise<Array<{ id: string; name: string; pattern: string }>>;
    create(rule: { name: string; pattern: string; categoryId: string }): Promise<string | null>;
    remove(id: string): Promise<void>;
    /** The charges the rule filed (assignment source "rule", its category, a note
     *  containing its words), by activity id. Null when that cannot be read. */
    filedBy(rule: { categoryId: string; pattern: string }): Promise<string[] | null>;
  };
  /** Appends the reversal entry to this writer's bucket. Never rejects. */
  record(draft: ChangeDraft): Promise<void>;
  where: { host: 'addon' | 'companion'; companionVersion: string | null };
}

export type UndoOutcome =
  | { ok: true; message: string; needsSync: boolean }
  | { ok: false; message: string };

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const cents = (v: unknown) => Math.round(Math.abs(Number(v ?? 0)) * 100);
const isDuplicateRefusal = (msg: string) => /duplicate|already exists/i.test(msg);

class Refusal extends Error {}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** mapping_rules, read strictly: a list this cannot read is never rewritten. */
async function readMappingRules(get: SecretGet): Promise<MappingRule[]> {
  const raw = await get(MAPPING_RULES_SECRET_KEY);
  if (raw === null || raw.trim() === '') return [];
  const parsed = parseJson<unknown>(raw);
  if (!Array.isArray(parsed)) throw new Refusal(UNDO_MAPPING_RULES_UNREADABLE);
  return parsed as MappingRule[];
}

const sameRule = (a: MappingRule, b: MappingRule) =>
  a.pattern === b.pattern && a.matchType === b.matchType && a.activityType === b.activityType && (a.subtype ?? '') === (b.subtype ?? '');

/** The row as the planner sees it, with "is it one half of a linked transfer". */
async function toUndoRow(io: UndoIo, a: HostActivity, txKey: string | null): Promise<UndoRow> {
  let linked: boolean;
  if (io.host.capabilities.readsSourceGroupId) {
    linked = !!a.sourceGroupId;
  } else {
    // The add-on cannot read groups back; the ledger the sync keeps stands in.
    const ledger = parseJson<Record<string, string>>(await io.secrets.get(LINKED_GROUPS_SECRET_KEY)) ?? {};
    const txId = txIdFromComment(a.comment);
    linked = (!!txKey && ledger[txKey] !== undefined) || (!!txId && ledger[txId] !== undefined);
  }
  return {
    id: a.id, accountId: a.accountId, type: a.activityType, date: a.date.slice(0, 10),
    absCents: cents(a.amount), comment: a.comment ?? '', linked,
  };
}

/** The entry's row as it stands now, or null. */
async function findRow(io: UndoIo, entry: ChangeEntry, latest: ChangeEntry | null, key: string | null): Promise<UndoRow | null> {
  const after = rec(entry.after);
  const wf = entry.account?.wfId ?? str(after.accountId);
  if (!wf) return null;
  const id = currentRowId(entry, latest);
  const baseline = entry.kind === 'starting-balance' || entry.kind === 'starting-balance-moved';
  const rows = [
    ...(baseline ? await io.host.listOldestActivities(wf, 50) : []),
    ...await io.host.listActivities(wf),
  ];
  let hit = id ? rows.find((r) => r.id === id) : undefined;
  if (!hit && !latest && !id && (entry.kind === 'starting-balance' || entry.kind === 'balance-correction')) {
    // R1 could not always read a new row's id back; its note (and amount) find it.
    hit = rows.find((r) => r.comment === str(after.comment) && cents(r.amount) === Math.abs(Number(after.amountCents ?? 0)));
  }
  if (!hit && entry.kind === 'import' && key && entry.account?.sfinId) {
    // Re-imported after a Redo: a new row id, the same bank transaction.
    const txId = key.slice(entry.account.sfinId.length + 1);
    hit = rows.find((r) => txIdFromComment(r.comment) === txId);
  }
  return hit ? toUndoRow(io, hit, key) : null;
}

/** An Amazon filing whose mapping read failed has no tx key: the row's note and
 *  the account mapping give it back. */
async function deriveTxKey(io: UndoIo, entry: ChangeEntry): Promise<string | null> {
  const wf = entry.account?.wfId;
  const id = entry.subject.activityIds?.[0];
  if (!wf || !id) return null;
  const row = (await io.host.listActivities(wf)).find((r) => r.id === id);
  const txId = txIdFromComment(row?.comment);
  const mapping = parseJson<Record<string, string>>(await io.secrets.get(ACCOUNT_MAPPING_SECRET_KEY)) ?? {};
  const sfin = Object.entries(mapping).find(([, w]) => w === wf)?.[0];
  return txId && sfin ? accountTxKey(sfin, txId) : null;
}

async function gather(io: UndoIo, entry: ChangeEntry, op: UndoOp, latest: ChangeEntry | null, variant: UndoVariant): Promise<UndoState> {
  const after = rec(entry.after);
  const key = entry.subject.txKeys?.[0] ?? null;
  const state: UndoState = {};
  const wf = entry.account?.wfId ?? str(after.accountId);
  const needsCurrency = ['balance-correction', 'starting-balance', 'starting-balance-moved', 'amazon-label'].includes(entry.kind);
  if (needsCurrency && wf) {
    state.currency = (await io.host.listAccounts()).find((a) => a.id === wf)?.currency ?? 'USD';
  }
  switch (entry.kind) {
    case 'category-filed':
    case 'opening-balance-filed': {
      const id = entry.subject.activityIds?.[0];
      if (!io.categories || !id) throw new Refusal(UNDO_NOT_POSSIBLE);
      state.assignments = await io.categories.assignments(id);
      if (entry.kind === 'category-filed' && entry.actor === 'auto' && !key) state.txKey = await deriveTxKey(io, entry);
      return state;
    }
    case 'category-rule-created': {
      if (!io.rules) throw new Refusal(UNDO_NOT_POSSIBLE);
      const rules = await io.rules.list();
      const id = currentRuleId(entry, latest);
      const byId = id ? rules.find((r) => r.id === id) : undefined;
      const byName = rules.find((r) => r.name === str(after.name) && r.pattern === str(after.pattern));
      // Undo deletes the rule by its id; by name only when the log has no id
      // (the create reply carried none). Redo only asks whether it is back.
      state.rule = (op === 'undo' ? (id ? byId : byName) : (byId ?? byName)) ?? null;
      if (op === 'undo' && variant === 'unfile') {
        const filed = await io.rules.filedBy({ categoryId: String(after.categoryId ?? ''), pattern: String(after.pattern ?? '') });
        if (filed === null) throw new Refusal(UNDO_RULE_FILED_UNREADABLE);
        state.ruleFiled = filed;
      }
      return state;
    }
    case 'mapping-rule-created':
      state.mappingRules = await readMappingRules(io.secrets.get);
      return state;
    case 'starting-balance':
      state.row = await findRow(io, entry, latest, key);
      if (op === 'redo' && wf) {
        state.startingBalanceId = (await io.host.listOldestActivities(wf, 50)).find((r) => r.comment === str(after.comment))?.id ?? null;
      }
      return state;
    case 'balance-correction':
    case 'starting-balance-moved':
    case 'duplicate-removed':
    case 'import':
    case 'amazon-label':
      state.row = await findRow(io, entry, latest, key);
      return state;
    default:
      return state;
  }
}

const isOverrideStep = (s: UndoStep) => s.do === 'set-tx' || s.do === 'clear-tx' || s.do === 'set-account' || s.do === 'clear-account';

function applyOverride(o: SyncOverrides, s: UndoStep, now: Date, entryId: string): SyncOverrides {
  switch (s.do) {
    case 'set-tx': return setTxOverride(o, s.txKey, s.flag, now, { entryId, label: s.label });
    case 'clear-tx': return clearTxOverride(o, s.txKey, s.flag);
    case 'set-account': return setAccountOverride(o, s.sfinId, s.flag, now, { label: s.label });
    case 'clear-account': return clearAccountOverride(o, s.sfinId, s.flag);
    default: return o;
  }
}

/** Undoes what `applyOverride` set (only `set-*` steps are ever rolled back). */
function rollbackOverride(o: SyncOverrides, s: UndoStep): SyncOverrides {
  if (s.do === 'set-tx') return clearTxOverride(o, s.txKey, s.flag);
  if (s.do === 'set-account') return clearAccountOverride(o, s.sfinId, s.flag);
  return o;
}

/** Performs the reversal steps; resolves the id of a row a step created. */
async function perform(io: UndoIo, steps: UndoStep[], now: Date): Promise<string | null> {
  let created: string | null = null;
  for (const s of steps) {
    switch (s.do) {
      case 'skip':
        await editSkippedTransactions(io.secrets.get, io.secrets.set, (l) => withSkipped(l, {
          account: s.account, txId: s.txId, note: UNDO_SKIP_NOTE, at: now.toISOString(),
        }));
        break;
      case 'unskip':
        await editSkippedTransactions(io.secrets.get, io.secrets.set, (l) => withoutSkipped(l, s.account, s.txId));
        break;
      case 'delete': {
        const res = await io.host.saveMany({ deleteIds: [s.activityId] });
        if (res.errors.length) throw new Error(res.errors.map((e) => e.message).join('; '));
        break;
      }
      case 'create': {
        const res = await io.host.saveMany({ creates: [s.write] });
        const errs = res.errors.map((e) => e.message).join('; ');
        if (errs && isDuplicateRefusal(errs)) throw new Refusal(UNDO_EXACT_COPY);
        if (errs || !res.created[0]) throw new Error(errs || 'Wealthfolio stored nothing');
        created = res.created[0].id;
        break;
      }
      case 'import': {
        await io.host.importActivities([s.row]);
        const read = async () => [
          ...await io.host.listOldestActivities(s.row.accountId, 50),
          ...await io.host.listActivities(s.row.accountId),
        ];
        created = (await rowIdByComment(read, s.row.comment, { amount: s.row.amount, fee: s.row.fee ?? 0 })) ?? null;
        break;
      }
      case 'update': {
        const res = await io.host.saveMany({ updates: [s.write] });
        if (res.errors.length) throw new Error(res.errors.map((e) => e.message).join('; '));
        break;
      }
      case 'assign':
        await io.categories!.assign(s.activityId, s.taxonomyId, s.categoryId);
        break;
      case 'unassign':
        await io.categories!.unassign(s.activityId, s.taxonomyId);
        break;
      case 'delete-rule':
        await io.rules!.remove(s.ruleId);
        break;
      case 'create-rule':
        created = (await io.rules!.create(s.rule)) ?? null;
        break;
      case 'mapping-remove': {
        const rule = s.rule;
        const list = await readMappingRules(io.secrets.get);
        await io.secrets.set(MAPPING_RULES_SECRET_KEY, JSON.stringify(list.filter((r) => !sameRule(r, rule))));
        break;
      }
      case 'mapping-add': {
        const list = await readMappingRules(io.secrets.get);
        if (!list.some((r) => sameRule(r, s.rule))) await io.secrets.set(MAPPING_RULES_SECRET_KEY, JSON.stringify([...list, s.rule]));
        break;
      }
      default:
        break;
    }
  }
  return created;
}

/** The `after` fields a reversal entry carries for the next undo or redo. */
function reversalExtra(p: UndoPlan, created: string | null, state: UndoState): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  if (p.rowAfter !== undefined) {
    const id = p.rowAfter === 'created' ? created : p.rowAfter;
    if (id) extra.activityId = id;
    else extra.activityId = undefined;
  }
  if (p.ruleAfter !== undefined) extra.ruleId = p.ruleAfter === 'created' ? created : null;
  if (state.ruleFiled && p.steps.some((s) => s.do === 'unassign')) extra.unfiledActivityIds = [...state.ruleFiled];
  return extra;
}

/**
 * Undo or redo one entry. `entries` is the log as just read (newest first):
 * it says whether the entry is undone and what an earlier reversal left.
 */
export async function runChangeUndo(
  entry: ChangeLogItem,
  entries: readonly ChangeEntry[],
  op: UndoOp,
  io: UndoIo,
  variant: UndoVariant = 'plain',
  now: Date = new Date(),
): Promise<UndoOutcome> {
  const available = undoAvailability(entry, io.where);
  if (available.kind === 'none') return { ok: false, message: UNDO_NOT_POSSIBLE };
  if (available.kind !== 'ready') return { ok: false, message: available.text };
  const latest = latestReversal(entries, entry.id);

  let state: UndoState;
  try {
    state = await gather(io, entry, op, latest, variant);
  } catch (err) {
    return { ok: false, message: err instanceof Refusal ? err.message : UNDO_UNREACHABLE };
  }
  const decision = planChangeUndo(entry, op, state, { latest, variant });
  if (!decision.ok) return { ok: false, message: decision.reason };
  const p = decision.plan;

  const overrideSteps = p.steps.filter(isOverrideStep);
  const rest = p.steps.filter((s) => !isOverrideStep(s));
  if (overrideSteps.length > 0) {
    try {
      await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => overrideSteps.reduce((d, s) => applyOverride(d, s, now, entry.id), o), now);
    } catch (err) {
      return { ok: false, message: isUnreadableOverridesError(err) ? message(err) : UNDO_UNREACHABLE };
    }
  }

  let created: string | null;
  try {
    created = await perform(io, rest, now);
  } catch (err) {
    if (err instanceof Refusal) {
      // Refused as an exact copy: take the override back out, so nothing changed.
      if (overrideSteps.length > 0) {
        await editSyncOverrides(io.secrets.get, io.secrets.set, (o) => overrideSteps.reduce(rollbackOverride, o), now).catch(() => {});
      }
      return { ok: false, message: err.message };
    }
    const what = op === 'undo' ? 'undo' : 'redo';
    return { ok: false, message: `Couldn't finish the ${what}: ${message(err)}` };
  }

  try {
    await io.record(reversalChange(entry, op, reversalExtra(p, created, state)));
  } catch {
    // Never costs the undo: the writer records a gap instead.
  }
  return { ok: true, message: p.done, needsSync: p.needsSync };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/change-undo-run.test.ts shared/sync-core.test.ts`
Expected: PASS — 203 tests.

Run: `npm --prefix companion test -- src/rest-host.test.ts`
Expected: PASS — 18 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/change-undo-run.ts shared/change-undo-run.test.ts shared/sync-host.ts src/utils/addon-host.ts companion/src/rest-host.ts
git commit -m "Undo: one runner for both hosts — state check, overrides first, reversal, the log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The companion — rule and assignment client, what a rule filed, and the filers obey overrides

Three companion pieces the undo host (Task 7) needs, and the two after-sync filers obeying their overrides (U3, U6, L2):
- **REST** (`companion/src/wealthfolio.ts`): `getActivityAssignments(activityId)` (`GET /api/v1/spending/activities/{id}/assignments` — the state check before a filing is changed), `listCategorizationRules()` (`GET /api/v1/spending/rules` — finding a rule the log knows only by name), `deleteCategorizationRule(id)` (`DELETE /api/v1/spending/rules/{id}`).
- **SQLite** (`companion/src/sqlite-native.ts`): `getNativeRuleFiledActivityIds(dbPath, categoryId, pattern)` — spending assignments with source `rule` in the rule's category on rows whose note contains the rule's words (case-insensitive, like the rule's own `contains` match), newest first; null without the database ("unknown", never "none"). This is N in "Undo rule + un-file N", computed when the entry is shown.
- **The filers.** `fileAmazonCharges` takes `noAutoFile(txKey)` and leaves such a charge exactly as the person put it back; `fileCardOpeningDebts` takes `noOpeningFile(sfinAccountId)` (the note names the account: `Starting balance · <sfinId>`) and leaves that account's opening balance — and creates no category when that was the only one. `runCompanionSync` reads the overrides ONCE after the sync (`syncOverridesOrEmpty`) and hands both filers their predicate.

**Files:**
- Modify: `companion/src/wealthfolio.ts`, `companion/src/sqlite-native.ts`, `companion/src/amazon-filing.ts`, `companion/src/opening-balance-category.ts`, `companion/src/index.ts`
- Test: `companion/src/wealthfolio-undo.test.ts`, `companion/src/sqlite-native-undo.test.ts`, `companion/src/amazon-filing-overrides.test.ts`, `companion/src/opening-balance-overrides.test.ts`

**Interfaces:**
- Consumes (Task 1): `syncOverridesOrEmpty`, `emptySyncOverrides`, `hasTxOverride`, `hasAccountOverride`, `SyncOverrides`; existing: `queryNativeDb` (module-private in `sqlite-native.ts`), `existsSync`, `accountTxKey`, `txIdFromComment`, `STARTING_BALANCE_COMMENT_PREFIX`, `fileAmazonLabelledCharges(wfClient, run?)` and `runCompanionSync` in `index.ts`.
- Produces:

```ts
// companion/src/wealthfolio.ts — WealthfolioClient gains:
async getActivityAssignments(activityId: string): Promise<Array<{ taxonomyId: string; categoryId: string; source?: string }>>;
async listCategorizationRules(): Promise<Array<{ id: string; name: string; pattern: string; categoryId: string | null }>>;
async deleteCategorizationRule(id: string): Promise<void>;   // throws through httpError('deleteCategorizationRule', res)
// companion/src/sqlite-native.ts
export function getNativeRuleFiledActivityIds(dbPath: string, categoryId: string, pattern: string): string[] | null;
// companion/src/amazon-filing.ts — AmazonFilingDeps gains:
noAutoFile?(txKey: string): boolean;
// companion/src/opening-balance-category.ts — OpeningBalanceFilingDeps gains:
noOpeningFile?: (sfinAccountId: string) => boolean;
// companion/src/index.ts — fileAmazonLabelledCharges(wfClient, run?, overrides: SyncOverrides = emptySyncOverrides())
```

- [ ] **Step 1: Write the failing tests**

**Create `companion/src/wealthfolio-undo.test.ts`:**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WealthfolioClient } from './wealthfolio';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);
beforeEach(() => mockFetch.mockReset());

describe('WealthfolioClient — what Undo needs', () => {
  it('reads an activity’s assignments, every taxonomy, camelCase as upstream sends them', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([
        { id: 'x1', activityId: 'act 1', taxonomyId: 'spending_categories', categoryId: 'cat-gro', weight: 10000, source: 'rule', createdAt: '', updatedAt: '' },
        { id: 'x2', activityId: 'act 1', taxonomyId: 'income_categories', categoryId: 'inc-1', weight: 10000, source: 'manual' },
        { junk: true },
      ]),
    });
    const client = new WealthfolioClient('http://wf');
    expect(await client.getActivityAssignments('act 1')).toEqual([
      { taxonomyId: 'spending_categories', categoryId: 'cat-gro', source: 'rule' },
      { taxonomyId: 'income_categories', categoryId: 'inc-1', source: 'manual' },
    ]);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wf/api/v1/spending/activities/act%201/assignments');
    expect((opts as any).method).toBeUndefined();
  });

  it('lists the categorization rules', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ([
        { id: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', matchType: 'contains', categoryId: 'cat-gro', priority: 50 },
        { id: 'rule-8', name: 'Preset', pattern: 'X', categoryId: null },
      ]),
    });
    expect(await new WealthfolioClient('http://wf').listCategorizationRules()).toEqual([
      { id: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro' },
      { id: 'rule-8', name: 'Preset', pattern: 'X', categoryId: null },
    ]);
    expect(mockFetch.mock.calls[0][0]).toBe('http://wf/api/v1/spending/rules');
  });

  it('deletes a rule by id, and says why it could not', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '' });
    const client = new WealthfolioClient('http://wf');
    await client.deleteCategorizationRule('rule/7');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wf/api/v1/spending/rules/rule%2F7');
    expect((opts as any).method).toBe('DELETE');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Rule not found' });
    await expect(client.deleteCategorizationRule('gone')).rejects.toThrow('deleteCategorizationRule failed: 404 - Rule not found');
  });
});
```

**Create `companion/src/sqlite-native-undo.test.ts`:**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getNativeRuleFiledActivityIds } from './sqlite-native.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

function ledger(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-undo-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE activities (id TEXT PRIMARY KEY, activity_date TEXT, notes TEXT);
    CREATE TABLE activity_taxonomy_assignments (activity_id TEXT, taxonomy_id TEXT, category_id TEXT, source TEXT);
    INSERT INTO activities VALUES
      ('a1','2026-10-01','TRADER JOE S #628 · TRN-1'),
      ('a2','2026-10-05','trader joe s #91 · TRN-2'),
      ('a3','2026-10-06','TRADER JOE S #628 · TRN-3'),
      ('a4','2026-10-07','TRADER JOE S #628 · TRN-4'),
      ('a5','2026-10-08','KROGER · TRN-5');
    INSERT INTO activity_taxonomy_assignments VALUES
      ('a1','spending_categories','cat-gro','rule'),
      ('a2','spending_categories','cat-gro','RULE'),
      ('a3','spending_categories','cat-gro','manual'),
      ('a4','spending_categories','cat-din','rule'),
      ('a5','spending_categories','cat-gro','rule');
  `);
  db.close();
  return path;
}

describe('getNativeRuleFiledActivityIds', () => {
  it('lists what a rule filed: source rule, its category, a note with its words — newest first', () => {
    expect(getNativeRuleFiledActivityIds(ledger(), 'cat-gro', 'TRADER JOE S')).toEqual(['a2', 'a1']);
  });

  it('treats quotes and LIKE wildcards in the words as text', () => {
    expect(getNativeRuleFiledActivityIds(ledger(), "cat-gro' OR '1'='1", 'TRADER')).toEqual([]);
    expect(getNativeRuleFiledActivityIds(ledger(), 'cat-gro', '%')).toEqual([]);
  });

  it('is null — unknown, not none — without the database', () => {
    expect(getNativeRuleFiledActivityIds('/nope/wealthfolio.db', 'cat-gro', 'TRADER')).toBeNull();
    expect(getNativeRuleFiledActivityIds('', 'cat-gro', 'TRADER')).toBeNull();
  });
});
```

**Create `companion/src/amazon-filing-overrides.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { fileAmazonCharges } from './amazon-filing.js';
import { accountTxKey } from '../../shared/transfers.js';

describe('fileAmazonCharges — noAutoFile', () => {
  it('leaves a charge whose automatic filing the person undid, and files the rest', async () => {
    const assigned: Array<[string, string]> = [];
    const res = await fileAmazonCharges({
      uncategorized: vi.fn(async () => [
        { activityId: 'a1', notes: 'Amazon · Amazon: Skincare · TRN-1', wfAccountId: 'wf-card' },
        { activityId: 'a2', notes: 'Amazon · Amazon: Skincare · TRN-2', wfAccountId: 'wf-card' },
      ]),
      categories: vi.fn(async () => [{ id: 'cat-personal', name: 'Personal Care' }]),
      readConfig: vi.fn(async () => ({})),
      assign: vi.fn(async (a: string, c: string) => { assigned.push([a, c]); }),
      log: vi.fn(),
      sfinAccountOf: (wf) => (wf === 'wf-card' ? 'sfin-card' : undefined),
      noAutoFile: (key) => key === accountTxKey('sfin-card', 'TRN-1'),
    });
    expect(assigned).toEqual([['a2', 'cat-personal']]);
    expect(res.filed).toBe(1);
  });
});
```

**Create `companion/src/opening-balance-overrides.test.ts`:**

```ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileCardOpeningDebts } from './opening-balance-category.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

function ledger(rows: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-open-ov-'));
  made.push(dir);
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT);
    CREATE TABLE activities (id TEXT PRIMARY KEY, account_id TEXT, activity_type TEXT, activity_date TEXT, amount TEXT, notes TEXT);
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, name TEXT, parent_id TEXT, taxonomy_id TEXT);
    CREATE TABLE activity_taxonomy_assignments (activity_id TEXT, category_id TEXT);
    CREATE TABLE app_settings (setting_key TEXT, setting_value TEXT);
    INSERT INTO accounts VALUES ('card','Citi','CREDIT_CARD'),('card2','Discover','CREDIT_CARD');
    ${rows}
  `);
  db.close();
  return path;
}

describe('fileCardOpeningDebts — noOpeningFile', () => {
  it('leaves the opening balance of an account whose filing the person undid', async () => {
    const d = {
      dbPath: ledger(`
        INSERT INTO taxonomy_categories VALUES ('ob','Opening balances',NULL,'spending_categories');
        INSERT INTO app_settings VALUES ('spending.excluded_category_ids','["ob"]');
        INSERT INTO activities VALUES ('o','card','WITHDRAWAL','2026-04-20','464.6','Starting balance · sfc');
        INSERT INTO activities VALUES ('p','card2','WITHDRAWAL','2026-05-20','10','Starting balance · sfd');
      `),
      createCategory: vi.fn(async () => 'new-cat'),
      setExcluded: vi.fn(async () => {}),
      assign: vi.fn(async () => {}),
      log: vi.fn(),
      noOpeningFile: (sfin: string) => sfin === 'sfc',
    };
    expect(await fileCardOpeningDebts(d)).toEqual({ filed: 1 });
    expect(d.assign).toHaveBeenCalledWith('p', 'ob');
    expect(d.assign).not.toHaveBeenCalledWith('o', 'ob');
  });

  it('creates nothing when the only opening debt is one the person undid', async () => {
    const d = {
      dbPath: ledger(`INSERT INTO activities VALUES ('o','card','WITHDRAWAL','2026-04-20','464.6','Starting balance · sfc');`),
      createCategory: vi.fn(async () => 'new-cat'),
      setExcluded: vi.fn(async () => {}),
      assign: vi.fn(async () => {}),
      log: vi.fn(),
      noOpeningFile: () => true,
    };
    expect(await fileCardOpeningDebts(d)).toEqual({ filed: 0 });
    expect(d.createCategory).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix companion test -- src/wealthfolio-undo.test.ts src/sqlite-native-undo.test.ts src/amazon-filing-overrides.test.ts src/opening-balance-overrides.test.ts`
Expected: FAIL — the three client methods and `getNativeRuleFiledActivityIds` do not exist; the undone Amazon charge and the undone opening balance are still filed.

- [ ] **Step 3: Implement**

**Edit `companion/src/wealthfolio.ts`** — one edit: the three methods, before `saveMany`.

Edit 1 of 1 in `companion/src/wealthfolio.ts` — replace:

```ts
    }
  }

  async saveMany(req: {
    creates?: unknown[];
    updates?: unknown[];
```

with:

```ts
    }
  }

  /** Every taxonomy's category on one activity, as the server stores it now —
   *  what an Undo checks before it changes a filing. Upstream route
   *  `GET /spending/activities/{id}/assignments` (`Vec<ActivityTaxonomyAssignment>`,
   *  camelCase). An activity with none, or one that is gone, answers `[]`. */
  async getActivityAssignments(activityId: string): Promise<Array<{ taxonomyId: string; categoryId: string; source?: string }>> {
    const res = await fetch(
      `${this.baseUrl}/api/v1/spending/activities/${encodeURIComponent(activityId)}/assignments`,
      { headers: this.authHeaders() },
    );
    if (!res.ok) throw await this.httpError('getActivityAssignments', res);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .filter((r) => typeof r.taxonomyId === 'string' && typeof r.categoryId === 'string')
      .map((r) => ({
        taxonomyId: r.taxonomyId as string,
        categoryId: r.categoryId as string,
        ...(typeof r.source === 'string' ? { source: r.source } : {}),
      }));
  }

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

  /** Deletes a categorization rule (`DELETE /spending/rules/{id}`, upstream
   *  `delete_categorization_rule`). Filings the rule already made stay. */
  async deleteCategorizationRule(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/spending/rules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (!res.ok) throw await this.httpError('deleteCategorizationRule', res);
  }

  async saveMany(req: {
    creates?: unknown[];
    updates?: unknown[];
```

**Edit `companion/src/sqlite-native.ts`** — one edit: append the reader at the end of the file.

Edit 1 of 1 in `companion/src/sqlite-native.ts` — replace:

```ts
      : null),
  );

  return rows.map((r) => {
    const v = Object.values(r) as Array<string | null>;
    return {
      id: String(v[0]),
      name: String(v[1]),
      parentId: String(v[2] ?? '') || null,
      parentName: String(v[3] ?? '') || null,
    };
  });
}
```

with:

```ts
      : null),
  );

  return rows.map((r) => {
    const v = Object.values(r) as Array<string | null>;
    return {
      id: String(v[0]),
      name: String(v[1]),
      parentId: String(v[2] ?? '') || null,
      parentName: String(v[3] ?? '') || null,
    };
  });
}

/**
 * The charges a categorization rule filed: spending assignments with source
 * "rule" in the rule's category, on rows whose note contains the rule's words
 * (case-insensitive, like the rule's own `contains` match). What "Undo rule +
 * un-file its N charges" counts and takes out. A category the person chose is
 * "manual" and is never in this list.
 *
 * Null when the database is not there — "unknown", never "none".
 */
export function getNativeRuleFiledActivityIds(dbPath: string, categoryId: string, pattern: string): string[] | null {
  if (!dbPath || !existsSync(dbPath)) return null;
  // Interpolated like every bound in this file (the CLI fallback cannot bind):
  // quotes doubled, LIKE wildcards neutralised.
  const cat = categoryId.replace(/'/g, "''");
  const safe = pattern.replace(/'/g, "''").replace(/[%_]/g, ' ');
  if (!cat || !safe.trim()) return [];
  const query = `
    SELECT a.id AS activity_id
    FROM activities a
    JOIN activity_taxonomy_assignments ata ON ata.activity_id = a.id
    WHERE ata.taxonomy_id = 'spending_categories'
      AND LOWER(COALESCE(ata.source, '')) = 'rule'
      AND ata.category_id = '${cat}'
      AND LOWER(COALESCE(a.notes, '')) LIKE '%' || LOWER('${safe}') || '%'
    ORDER BY a.activity_date DESC, a.id;
  `;
  const rows = queryNativeDb<{ activity_id: string }>(
    dbPath,
    'rule-filed activities',
    query,
    (parts) => (parts.length >= 1 && parts[0] ? { activity_id: parts[0] } : null),
  );
  return rows.map((r) => String(r.activity_id));
}
```

**Edit `companion/src/amazon-filing.ts`** — two edits: the dep; the skip at the top of the filing loop.

Edit 1 of 2 in `companion/src/amazon-filing.ts` — replace:

```ts
  record?(draft: ChangeDraft): void;
  /** The SimpleFin account behind a Wealthfolio one, for the entry's tx key. */
  sfinAccountOf?(wfAccountId: string): string | undefined;
}

export interface AmazonFilingResult {
```

with:

```ts
  record?(draft: ChangeDraft): void;
  /** The SimpleFin account behind a Wealthfolio one, for the entry's tx key. */
  sfinAccountOf?(wfAccountId: string): string | undefined;
  /** True when the person undid an automatic filing of this transaction
   *  (`noAutoFile`, shared/sync-overrides.ts): it is never filed again. */
  noAutoFile?(txKey: string): boolean;
}

export interface AmazonFilingResult {
```

Edit 2 of 2 in `companion/src/amazon-filing.ts` — replace:

```ts
    };

    for (const { row, label } of labelled) {
      // A MIXED order goes straight to the configured default: one charge
      // covering several categories has no honest single label, no rule can
      // ever match it (so `needRule` nagging would be permanent), and leaving
```

with:

```ts
    };

    for (const { row, label } of labelled) {
      // Undone by the person: left exactly as they put it back.
      const sfinId = row.wfAccountId ? deps.sfinAccountOf?.(row.wfAccountId) : undefined;
      const txId = txIdFromComment(row.notes);
      if (sfinId && txId && deps.noAutoFile?.(accountTxKey(sfinId, txId))) continue;
      // A MIXED order goes straight to the configured default: one charge
      // covering several categories has no honest single label, no rule can
      // ever match it (so `needRule` nagging would be permanent), and leaving
```

**Edit `companion/src/opening-balance-category.ts`** — two edits: the dep; the rows filtered before anything is created.

Edit 1 of 2 in `companion/src/opening-balance-category.ts` — replace:

```ts
  log: (message: string) => void;
  /** The change log: one draft per write that succeeded. */
  record?: (draft: ChangeDraft) => void;
}

interface OpeningDebtRow { id: string; account_id: string; account_name: string; amount: string; day: string; notes: string }
```

with:

```ts
  log: (message: string) => void;
  /** The change log: one draft per write that succeeded. */
  record?: (draft: ChangeDraft) => void;
  /** True for a SimpleFin account whose opening-balance filing the person
   *  undid (`noOpeningFile`, shared/sync-overrides.ts): never filed again. */
  noOpeningFile?: (sfinAccountId: string) => boolean;
}

interface OpeningDebtRow { id: string; account_id: string; account_name: string; amount: string; day: string; notes: string }
```

Edit 2 of 2 in `companion/src/opening-balance-category.ts` — replace:

```ts
             WHERE ata.activity_id = a.id AND tc.taxonomy_id = ?)`,
      )
      .all(TAXONOMY) as unknown as OpeningDebtRow[];
    if (rows.length === 0) return { filed: 0 };
    categoryId = (
      db.prepare(`SELECT id FROM taxonomy_categories WHERE taxonomy_id = ? AND name = ?`).get(TAXONOMY, OPENING_BALANCES_CATEGORY) as
```

with:

```ts
             WHERE ata.activity_id = a.id AND tc.taxonomy_id = ?)`,
      )
      .all(TAXONOMY) as unknown as OpeningDebtRow[];
    // The note names the SimpleFin account: `Starting balance · <sfinId>`.
    rows = rows.filter((r) => !(r.notes.startsWith(STARTING_BALANCE_COMMENT_PREFIX)
      && deps.noOpeningFile?.(r.notes.slice(STARTING_BALANCE_COMMENT_PREFIX.length))));
    if (rows.length === 0) return { filed: 0 };
    categoryId = (
      db.prepare(`SELECT id FROM taxonomy_categories WHERE taxonomy_id = ? AND name = ?`).get(TAXONOMY, OPENING_BALANCES_CATEGORY) as
```

**Edit `companion/src/index.ts`** — five edits: import; `fileAmazonLabelledCharges` takes the overrides; its `noAutoFile`; read the overrides once after the sync; the opening filer's `noOpeningFile`.

Edit 1 of 5 in `companion/src/index.ts` — replace:

```ts
import { createAmazonLabelMenu, type AmazonLabelMenu } from './amazon-labels.js';
import { fileAmazonCharges } from './amazon-filing.js';
import { companionChangeSink, readCompanionChangeLog, recordCompanionChanges } from './change-log-host.js';
import { createChangesMenu, renderChangesCommand, CHANGES_UNREACHABLE_REPLY, type ChangesMenu } from './changes-menu.js';
import type { ChangeLogRead } from '../../shared/change-log.js';
import type { ChangeDraft } from '../../shared/change-entries.js';
```

with:

```ts
import { createAmazonLabelMenu, type AmazonLabelMenu } from './amazon-labels.js';
import { fileAmazonCharges } from './amazon-filing.js';
import { companionChangeSink, readCompanionChangeLog, recordCompanionChanges } from './change-log-host.js';
import { emptySyncOverrides, hasAccountOverride, hasTxOverride, syncOverridesOrEmpty, type SyncOverrides } from '../../shared/sync-overrides.js';
import { createChangesMenu, renderChangesCommand, CHANGES_UNREACHABLE_REPLY, type ChangesMenu } from './changes-menu.js';
import type { ChangeLogRead } from '../../shared/change-log.js';
import type { ChangeDraft } from '../../shared/change-entries.js';
```

Edit 2 of 5 in `companion/src/index.ts` — replace:

```ts
 * behaviour is precisely what wants fixing, and an order email can arrive days
 * after the charge it belongs to.
 */
async function fileAmazonLabelledCharges(wfClient: WealthfolioClient, run?: string): Promise<void> {
  const dbPath = wealthfolioDbPath();
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 60);
```

with:

```ts
 * behaviour is precisely what wants fixing, and an order email can arrive days
 * after the charge it belongs to.
 */
async function fileAmazonLabelledCharges(wfClient: WealthfolioClient, run?: string, overrides: SyncOverrides = emptySyncOverrides()): Promise<void> {
  const dbPath = wealthfolioDbPath();
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 60);
```

Edit 3 of 5 in `companion/src/index.ts` — replace:

```ts
    log,
    record: (draft) => changes.push(draft),
    sfinAccountOf: (wfAccountId) => sfinOf.get(wfAccountId),
  });
  // Never rejects in practice; a failed recording must not fail the filing.
  await recordCompanionChanges(wfClient, changes, run).catch((e) => log(`Change log skipped: ${formatError(e)}`));
```

with:

```ts
    log,
    record: (draft) => changes.push(draft),
    sfinAccountOf: (wfAccountId) => sfinOf.get(wfAccountId),
    noAutoFile: (txKey) => hasTxOverride(overrides, txKey, 'noAutoFile'),
  });
  // Never rejects in practice; a failed recording must not fail the filing.
  await recordCompanionChanges(wfClient, changes, run).catch((e) => log(`Change log skipped: ${formatError(e)}`));
```

Edit 4 of 5 in `companion/src/index.ts` — replace:

```ts
    // BEFORE publishing the uncategorized status, so the count the addon shows
    // and the notice's sweep both reflect what was just filed rather than
    // listing rows that now have a category.
    await fileAmazonLabelledCharges(wfClient, changeLog.run);

    // A card's opening DEBT has to be a WITHDRAWAL on Wealthfolio 3.8, which its
    // Spending page reads as a purchase; filed under an excluded category it
```

with:

```ts
    // BEFORE publishing the uncategorized status, so the count the addon shows
    // and the notice's sweep both reflect what was just filed rather than
    // listing rows that now have a category.
    // What Undo told the after-sync filers not to do again — read once, after
    // the sync. Unreadable is empty: the filers then behave as they always did.
    const overrides = await syncOverridesOrEmpty((k) => wfClient.getAddonSecret('simplefin-sync', k));
    await fileAmazonLabelledCharges(wfClient, changeLog.run, overrides);

    // A card's opening DEBT has to be a WITHDRAWAL on Wealthfolio 3.8, which its
    // Spending page reads as a purchase; filed under an excluded category it
```

Edit 5 of 5 in `companion/src/index.ts` — replace:

```ts
      assign: (activityId, categoryId) => wfClient.assignActivityCategory(activityId, SPENDING_TAXONOMY_ID, categoryId),
      log,
      record: (draft) => openingChanges.push(draft),
    }).catch((e) => log(`Card opening balance filing skipped: ${formatError(e)}`));
    // After the catch: a filing that stopped half-way still logs what landed.
    await recordCompanionChanges(wfClient, openingChanges, changeLog.run).catch((e) => log(`Change log skipped: ${formatError(e)}`));
```

with:

```ts
      assign: (activityId, categoryId) => wfClient.assignActivityCategory(activityId, SPENDING_TAXONOMY_ID, categoryId),
      log,
      record: (draft) => openingChanges.push(draft),
      noOpeningFile: (sfinId) => hasAccountOverride(overrides, sfinId, 'noOpeningFile'),
    }).catch((e) => log(`Card opening balance filing skipped: ${formatError(e)}`));
    // After the catch: a filing that stopped half-way still logs what landed.
    await recordCompanionChanges(wfClient, openingChanges, changeLog.run).catch((e) => log(`Change log skipped: ${formatError(e)}`));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix companion test -- src/wealthfolio-undo.test.ts src/sqlite-native-undo.test.ts src/amazon-filing-overrides.test.ts src/opening-balance-overrides.test.ts src/wealthfolio.test.ts src/sqlite-native.test.ts src/amazon-filing.test.ts src/opening-balance-category.test.ts src/index.test.ts`
Expected: PASS — 431 tests.

Run: `npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/wealthfolio.ts companion/src/sqlite-native.ts companion/src/amazon-filing.ts companion/src/opening-balance-category.ts companion/src/index.ts companion/src/wealthfolio-undo.test.ts companion/src/sqlite-native-undo.test.ts companion/src/amazon-filing-overrides.test.ts companion/src/opening-balance-overrides.test.ts
git commit -m "Companion: rule and assignment client, what a rule filed, filers obey noAutoFile and noOpeningFile

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The companion undoes — its UndoIo, and Undo / Redo / Sync now in `/changes`

The companion can undo every kind (U1). `companionUndoIo(client, dbPath, host?)` binds the runner to one Wealthfolio client: activities through `RestSyncHost`, the add-on settings over REST, categories through the assignment routes, rules through the rule routes (a redo re-creates a rule exactly as `/categorize` does — spending taxonomy, priority 50), "what did the rule file" through Task 6's reader, and the reversal entry through the companion's one log writer. `companionRuleFiledCount(dbPath, entry)` is N for the "+ un-file" button.

`/changes` (spec B3, U7): an entry's screen offers `↩ Undo` or `Redo` (a rule: `↩ Undo rule` and, when N > 0 is known, `↩ Undo rule + un-file N`) — from `undoAvailability(entry, { host: 'companion', companionVersion: null })`, so Telegram never gates. A tap runs the undo at once (no confirmation), re-reads the log, and redraws the entry: `✅ <result>` or `⚠️ <refusal>` (escaped, outside entities), `Takes effect on the next sync.` and `🔄 Sync now` after a sync decision, and the button flipped (Undo ↔ Redo). `🔄 Sync now` is `/sync`'s own run — `startTelegramSync()`, extracted from the `/sync` command so both share the lock — answering `Syncing…` / `Already syncing — hang on.` and sending the summary as a new message. Buttons stay stateless: `cz:cl:x<u|r|f|s><handle>:<back>`, ≤ 64 bytes; an entry gone from the log answers "That one is already sorted — refreshing.". A menu built without `undo` stays read-only exactly as in R1.

**Files:**
- Create: `companion/src/change-undo-host.ts`
- Modify: `companion/src/changes-menu.ts`, `companion/src/index.ts`
- Test: `companion/src/change-undo-host.test.ts`, `companion/src/changes-menu-undo.test.ts`

**Interfaces:**
- Consumes: Task 5 (`UndoIo`, `UndoOutcome`, `runChangeUndo`); Task 4 (`undoAvailability`, `UNDO_TAKES_EFFECT`, `SPENDING_TAXONOMY`, `UndoOp`, `UndoVariant`; `reversalChange` in tests); Task 6 (`getActivityAssignments`, `listCategorizationRules`, `deleteCategorizationRule`, `getNativeRuleFiledActivityIds`); existing: `recordCompanionChanges`, `readCompanionChangeLog`, `SecretClient` (`change-log-host.ts`), `RestSyncHost`, `WealthfolioClient.assignActivityCategory/unassignActivityCategory/createCategorizationRule`, `SIMPLEFIN_SYNC_VERSION`, `findingHandle`, `escapeMarkdown`, `shortDateTime`, `runCompanionSyncExclusive`, `runCompanionSync`, `formatSyncReply`, `formatError`, `wealthfolioDbPath`, `createFakeHost` (tests).
- Produces:

```ts
// companion/src/change-undo-host.ts
export type UndoClient = SecretClient & Pick<WealthfolioClient,
  'getActivityAssignments' | 'assignActivityCategory' | 'unassignActivityCategory'
  | 'listCategorizationRules' | 'createCategorizationRule' | 'deleteCategorizationRule'>;
export function companionUndoIo(client: UndoClient, dbPath: string, host?: SyncHost): UndoIo;
export function companionRuleFiledCount(dbPath: string, entry: ChangeEntry): number | null;

// companion/src/changes-menu.ts
export const CHANGES_SYNC_STARTED = 'Syncing…';
export const CHANGES_SYNC_RUNNING = 'Already syncing — hang on.';
export type ChangeAction = 'u' | 'r' | 'f' | 's';
export type ChangesView = /* list | search | run | detail, and: */
  | { kind: 'act'; action: ChangeAction; entry: string; back: Exclude<ChangesView, { kind: 'detail' | 'act' }> };
export interface DetailExtras { op?: UndoOp; unfileCount?: number | null; result?: { ok: boolean; message: string; needsSync?: boolean } }
export function renderChangeDetail(entry: ChangeLogItem, back: Exclude<ChangesView, { kind: 'detail' | 'act' }>, extras?: DetailExtras): MenuScreen;
export interface ChangesMenuUi { edit(…); answer(…); send?(text: string, keyboard?: InlineKeyboard): Promise<void> }
export interface ChangesMenuDeps {
  read(now: Date): Promise<ChangeLogRead>; now(): Date; log(msg: string): void;
  undo?(entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp, variant: UndoVariant): Promise<UndoOutcome>;
  ruleFiledCount?(entry: ChangeLogItem): Promise<number | null>;
  syncNow?(): { started: boolean; summary: Promise<string> };
}

// companion/src/index.ts
export function startTelegramSync(): { started: boolean; summary: Promise<string> };   // `/sync` and 🔄 Sync now
```

- [ ] **Step 1: Write the failing tests**

**Create `companion/src/change-undo-host.test.ts`:**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { categoryFiledChange, categoryRuleCreatedChange, importChange, stampChange } from '../../shared/change-entries.js';
import { runChangeUndo } from '../../shared/change-undo-run.js';
import { createFakeHost } from '../../shared/fake-host.js';
import { companionRuleFiledCount, companionUndoIo, type UndoClient } from './change-undo-host.js';
import { readCompanionChangeLog } from './change-log-host.js';

const NOW = new Date('2026-10-13T15:00:00Z');

function client(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const c = {
    data,
    getAddonSecret: vi.fn(async (_a: string, k: string) => data.get(k) ?? null),
    setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { data.set(k, v); }),
    getActivityAssignments: vi.fn(async () => [{ taxonomyId: 'spending_categories', categoryId: 'cat-din', source: 'manual' }]),
    assignActivityCategory: vi.fn(async () => {}),
    unassignActivityCategory: vi.fn(async () => {}),
    listCategorizationRules: vi.fn(async () => [] as Array<{ id: string; name: string; pattern: string; categoryId: string | null }>),
    createCategorizationRule: vi.fn(async () => 'rule-9'),
    deleteCategorizationRule: vi.fn(async () => {}),
  };
  return c as typeof c & UndoClient;
}

describe('companionUndoIo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('undoes your Telegram filing by activity id, and records it in the companion’s own bucket', async () => {
    const c = client();
    const filing = stampChange(categoryFiledChange({
      actor: 'you', activityId: 'act-5', description: 'VENMO *J SMITH',
      before: null, after: { categoryId: 'cat-din', categoryName: 'Dining', taxonomyId: 'spending_categories' },
    }), 'companion', new Date('2026-10-13T09:00:00Z'));
    const io = companionUndoIo(c, '/nope.db', createFakeHost().host);
    expect(await runChangeUndo(filing, [filing], 'undo', io, 'plain', NOW)).toEqual({ ok: true, message: 'Undone — no category.', needsSync: false });
    expect(c.unassignActivityCategory).toHaveBeenCalledWith('act-5', 'spending_categories');
    const bucket = JSON.parse(c.data.get('change_log:companion:2026-10')!);
    expect(bucket.entries).toEqual([expect.objectContaining({ writer: 'companion', actor: 'you', reverses: { id: filing.id, op: 'undo' } })]);
    // The merged read shows the original as undone (the original itself lives
    // in whichever bucket wrote it; here it is not stored, so only the undo shows).
    expect((await readCompanionChangeLog(c, NOW)).entries[0].summary).toBe('Undid: Filed VENMO *J SMITH under Dining');
  });

  it('re-creates a rule with the spending taxonomy and the losing priority /categorize uses', async () => {
    const c = client();
    const io = companionUndoIo(c, '/nope.db', createFakeHost().host);
    await io.rules!.create({ name: 'Telegram: X', pattern: 'X', categoryId: 'cat-gro' });
    expect(c.createCategorizationRule).toHaveBeenCalledWith({ name: 'Telegram: X', pattern: 'X', categoryId: 'cat-gro', taxonomyId: 'spending_categories', priority: 50 });
    expect(await io.categories!.assignments('act-5')).toEqual([{ taxonomyId: 'spending_categories', categoryId: 'cat-din' }]);
    expect(io.where).toEqual({ host: 'companion', companionVersion: expect.any(String) });
  });

  it('reads an import’s state through the host and the skip list through the add-on secrets', async () => {
    const c = client();
    const fh = createFakeHost({
      mapping: { 'sfin-1': 'wf-a' },
      existing: new Map([['wf-a', [{ id: 'act-1', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-11', amount: 6.5, comment: 'SQ *BLUE · tx-1', sourceGroupId: null }]]]),
    });
    const imported = stampChange(importChange({
      account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' }, txKey: 'sfin-1\u0000tx-1', activityId: 'act-1', description: 'SQ *BLUE',
      amountCents: -650, date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
    }), 'companion', NOW);
    expect(await runChangeUndo(imported, [imported], 'undo', companionUndoIo(c, '/nope.db', fh.host), 'plain', NOW)).toMatchObject({ ok: true });
    expect(JSON.parse(c.data.get('skipped_transactions')!)).toEqual([expect.objectContaining({ account: 'sfin-1', txId: 'tx-1' })]);
    expect(fh.activities.get('wf-a')).toEqual([]);
  });

  it('counts a rule’s filings only for a rule entry, and says unknown without the database', () => {
    const rule = stampChange(categoryRuleCreatedChange({ ruleId: 'r', name: 'n', pattern: 'X', categoryId: 'c', categoryName: 'G' }), 'companion', NOW);
    expect(companionRuleFiledCount('/nope.db', rule)).toBeNull();
    const filing = stampChange(categoryFiledChange({ actor: 'you', activityId: 'a', description: 'X', before: null, after: { categoryId: 'c', categoryName: 'G' } }), 'companion', NOW);
    expect(companionRuleFiledCount('/nope.db', filing)).toBeNull();
  });
});
```

**Create `companion/src/changes-menu-undo.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  bankUpdateChange, categoryFiledChange, categoryRuleCreatedChange, reversalChange, stampChange, transferLinkChange,
  type ChangeDraft,
} from '../../shared/change-entries.js';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log.js';
import type { UndoOutcome } from '../../shared/change-undo-run.js';
import { findingHandle } from '../../shared/handle.js';
import { normalizeChangesQuery } from './changes-menu.js';
import {
  changesData, CHANGES_GONE_ANSWER, CHANGES_SYNC_RUNNING, CHANGES_SYNC_STARTED, createChangesMenu, parseChangesData,
  renderChangeDetail, type ChangesMenuDeps, type MenuScreen,
} from './changes-menu.js';

const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m);
const NOW = at(13, 15, 0);
const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };
const item = (draft: ChangeDraft, when: Date): ChangeLogItem => stampChange(draft, 'companion', when);
const filed = (desc: string, category = 'Dining') => item(categoryFiledChange({
  actor: 'you', account: CHECKING, activityId: `f-${desc}`, description: desc, amountCents: -650,
  before: null, after: { categoryId: 'cat-din', categoryName: category },
}), at(12, 9, 0));
const link = () => item(transferLinkChange(
  { account: CHECKING, txKey: 'k1', description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-10-08', oldActivityId: 'o1' },
  { account: { name: 'Citi Card', sfinId: 'ACT-9c8d' }, txKey: 'k2', description: 'PAYMENT THANK YOU', amountCents: 46460, date: '2026-10-08', oldActivityId: 'o2' },
), at(12, 10, 0));
const rule = () => item(categoryRuleCreatedChange({ ruleId: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro', categoryName: 'Groceries' }), at(12, 11, 0));
const log = (entries: ChangeLogItem[]): ChangeLogRead =>
  ({ entries: [...entries].sort((a, b) => (a.at < b.at ? 1 : -1)), gaps: [], trimmed: 0, unreadable: [] });
const back = { kind: 'list', page: 0, background: false } as const;
const texts = (s: MenuScreen) => s.keyboard.inline_keyboard.map((r) => r.map((b) => b.text));
const button = (s: MenuScreen, text: string) => {
  const b = s.keyboard.inline_keyboard.flat().find((x) => x.text === text);
  if (!b) throw new Error(`no "${text}" among ${s.keyboard.inline_keyboard.flat().map((x) => x.text).join(' | ')}`);
  return b.callback_data;
};
const ui = () => ({
  edit: vi.fn(async (_t: string, _k?: unknown) => {}),
  answer: vi.fn(async (_t?: string) => {}),
  send: vi.fn(async (_t: string) => {}),
});
const lastScreen = (u: ReturnType<typeof ui>): MenuScreen => {
  const [text, keyboard] = u.edit.mock.calls.at(-1) as [string, MenuScreen['keyboard']];
  return { text, keyboard };
};

function menu(reads: ChangeLogRead[], extra: Partial<ChangesMenuDeps> = {}) {
  let i = 0;
  const deps: ChangesMenuDeps = {
    read: vi.fn(async () => reads[Math.min(i++, reads.length - 1)]),
    now: () => NOW,
    log: vi.fn(),
    undo: vi.fn(async (): Promise<UndoOutcome> => ({ ok: true, message: 'Undone — no category.', needsSync: false })),
    ruleFiledCount: vi.fn(async () => 3),
    ...extra,
  };
  return { deps, menu: createChangesMenu(deps) };
}

describe('/changes — Undo and Redo', () => {
  it('an entry’s screen offers ↩ Undo; an undone one offers Redo; a bank change offers neither', async () => {
    const e = filed('VENMO');
    const { menu: m } = menu([log([e])]);
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'detail', entry: findingHandle(e.id), back }), chatId: 1 }, u);
    expect(texts(lastScreen(u))).toEqual([['↩ Undo'], ['‹ Back']]);

    const undone = { ...e, undone: { by: 'c9', at: at(12, 10, 0).toISOString() } };
    const r = renderChangeDetail(undone, back, { op: 'redo' });
    expect(texts(r)).toEqual([['Redo'], ['‹ Back']]);

    const update = item(bankUpdateChange({
      account: CHECKING, txKey: 'k', activityId: 'a', description: 'X', amountCents: -1,
      before: { absCents: 1, date: '2026-10-01', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 2, date: '2026-10-01', pending: false, activityType: 'WITHDRAWAL' },
    }), at(12, 8, 0));
    const u2 = ui();
    await menu([log([update])]).menu.onCallback({ data: changesData({ kind: 'detail', entry: findingHandle(update.id), back }), chatId: 1 }, u2);
    expect(texts(lastScreen(u2))).toEqual([['‹ Back']]);
  });

  it('a rule offers two undos, with N read when the screen is shown', async () => {
    const r = rule();
    const { menu: m, deps } = menu([log([r])]);
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'detail', entry: findingHandle(r.id), back }), chatId: 1 }, u);
    expect(texts(lastScreen(u))).toEqual([['↩ Undo rule', '↩ Undo rule + un-file 3'], ['‹ Back']]);
    expect(deps.ruleFiledCount).toHaveBeenCalledWith(r);
    const none = menu([log([r])], { ruleFiledCount: vi.fn(async () => null) });
    const u2 = ui();
    await none.menu.onCallback({ data: changesData({ kind: 'detail', entry: findingHandle(r.id), back }), chatId: 1 }, u2);
    expect(texts(lastScreen(u2))).toEqual([['↩ Undo rule'], ['‹ Back']]);
  });

  it('a tap undoes at once — no confirmation — and the screen says so, now offering Redo', async () => {
    const e = filed('VENMO');
    const undoEntry = stampChange(reversalChange(e, 'undo'), 'companion', at(13, 14, 0));
    const after: ChangeLogRead = { ...log([e, undoEntry]), entries: log([e, undoEntry]).entries.map((x) => (x.id === e.id ? { ...x, undone: { by: undoEntry.id, at: undoEntry.at } } : x)) };
    const { menu: m, deps } = menu([log([e]), after]);
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'act', action: 'u', entry: findingHandle(e.id), back }), chatId: 1 }, u);
    expect(deps.undo).toHaveBeenCalledWith(expect.objectContaining({ id: e.id }), expect.any(Array), 'undo', 'plain');
    const s = lastScreen(u);
    expect(s.text.split('\n').slice(-2)).toEqual(['', '✅ Undone — no category.']);
    expect(texts(s)).toEqual([['Redo'], ['‹ Back']]);
  });

  it('after a sync decision: "Takes effect on the next sync." and 🔄 Sync now, which runs /sync', async () => {
    const e = link();
    let resolve!: (s: string) => void;
    const summary = new Promise<string>((r) => { resolve = r; });
    const { menu: m, deps } = menu([log([e])], {
      undo: vi.fn(async () => ({ ok: true as const, message: 'Undone — the next sync counts each half as spending or money in.', needsSync: true })),
      syncNow: vi.fn(() => ({ started: true, summary })),
    });
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'act', action: 'u', entry: findingHandle(e.id), back }), chatId: 1 }, u);
    const s = lastScreen(u);
    expect(s.text).toContain('Takes effect on the next sync.');
    expect(texts(s)).toContainEqual(['🔄 Sync now']);
    await m.onCallback({ data: button(s, '🔄 Sync now'), chatId: 1 }, u);
    expect(deps.syncNow).toHaveBeenCalledTimes(1);
    expect(u.answer).toHaveBeenLastCalledWith(CHANGES_SYNC_STARTED);
    resolve('✅ Synced: 2 imported');
    await summary;
    await Promise.resolve();
    expect(u.send).toHaveBeenCalledWith('✅ Synced: 2 imported');
    const joined = menu([log([e])], { syncNow: vi.fn(() => ({ started: false, summary: Promise.resolve('x') })) });
    const u2 = ui();
    await joined.menu.onCallback({ data: button(s, '🔄 Sync now'), chatId: 1 }, u2);
    expect(u2.answer).toHaveBeenCalledWith(CHANGES_SYNC_RUNNING);
  });

  it('Undo rule + un-file passes the un-file choice', async () => {
    const r = rule();
    const { menu: m, deps } = menu([log([r])]);
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'act', action: 'f', entry: findingHandle(r.id), back }), chatId: 1 }, u);
    expect(deps.undo).toHaveBeenCalledWith(expect.anything(), expect.any(Array), 'undo', 'unfile');
  });

  it('a refusal is said on the screen, with no Sync now, and a category with Markdown characters stays escaped', async () => {
    const e = filed('SQ *COFFEE_CLUB', 'Food_&_Drink*');
    const { menu: m } = menu([log([e])], {
      undo: vi.fn(async () => ({ ok: false as const, message: 'It has changed since — nothing was undone.' })),
    });
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'act', action: 'u', entry: findingHandle(e.id), back }), chatId: 1 }, u);
    const s = lastScreen(u);
    expect(s.text).toContain('⚠️ It has changed since — nothing was undone.');
    expect(texts(s)).toEqual([['↩ Undo'], ['‹ Back']]);
    const ok = renderChangeDetail(e, back, { result: { ok: true, message: 'Undone — filed under Food_&_Drink*.' } });
    expect(ok.text).toContain('✅ Undone — filed under Food\\_&\\_Drink\\*.');
    expect(ok.text.split('\n').filter((l) => /^[*_]/.test(l))).toEqual([]);
  });

  it('an entry gone from the log answers "already sorted"', async () => {
    const e = filed('GONE');
    const { menu: m, deps } = menu([log([])]);
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'act', action: 'u', entry: findingHandle(e.id), back }), chatId: 1 }, u);
    expect(u.answer).toHaveBeenCalledWith(CHANGES_GONE_ANSWER);
    expect(deps.undo).not.toHaveBeenCalled();
  });

  it('a menu built without undo stays read-only, as in R1', async () => {
    const e = filed('VENMO');
    const m = createChangesMenu({ read: async () => log([e]), now: () => NOW, log: vi.fn() });
    const u = ui();
    await m.onCallback({ data: changesData({ kind: 'detail', entry: findingHandle(e.id), back }), chatId: 1 }, u);
    expect(texts(lastScreen(u))).toEqual([['‹ Back']]);
    await m.onCallback({ data: changesData({ kind: 'act', action: 'u', entry: findingHandle(e.id), back }), chatId: 1 }, u);
    expect(u.answer).toHaveBeenLastCalledWith();
  });

  it('every action button round-trips and fits in 64 bytes, behind the longest back', () => {
    const longest = [
      { kind: 'search', page: 999, query: normalizeChangesQuery('ünïcödé ✓ words that go on and on') },
      { kind: 'run', run: 'abcdef01', page: 999, from: { page: 999, background: true } },
    ] as const;
    for (const b of longest) {
      for (const action of ['u', 'r', 'f', 's'] as const) {
        const v = { kind: 'act', action, entry: '0123abcd', back: b } as const;
        const data = changesData(v as any);
        expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
        expect(parseChangesData(data)).toEqual(v);
      }
    }
    expect(parseChangesData('cz:cl:xu0123abcd:d0123abcd:l0')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix companion test -- src/change-undo-host.test.ts src/changes-menu-undo.test.ts`
Expected: FAIL — `./change-undo-host.js` does not exist, and the menu has no `act` view, no Undo buttons and no `CHANGES_SYNC_STARTED`.

- [ ] **Step 3: Implement**

**Create `companion/src/change-undo-host.ts`:**

```ts
/**
 * companion/src/change-undo-host.ts
 *
 * The companion's half of Undo (shared/change-undo-run.ts): everything the
 * runner may touch, bound to one Wealthfolio client. The companion can do
 * every kind — it has the REST routes for categories and rules the add-on SDK
 * lacks, and the database for "which charges did this rule file".
 *
 * Its reversal entries land in the companion's own bucket, through the one
 * process-wide writer (change-log-host.ts).
 */
import type { ChangeEntry } from '../../shared/change-entries.js';
import type { UndoIo } from '../../shared/change-undo-run.js';
import { SPENDING_TAXONOMY } from '../../shared/change-undo.js';
import type { SyncHost } from '../../shared/sync-host.js';
import { SIMPLEFIN_SYNC_VERSION } from '../../shared/version.js';
import { recordCompanionChanges, type SecretClient } from './change-log-host.js';
import { RestSyncHost } from './rest-host.js';
import { getNativeRuleFiledActivityIds } from './sqlite-native.js';
import type { WealthfolioClient } from './wealthfolio.js';

const ADDON_ID = 'simplefin-sync';

/** What Undo needs of a `WealthfolioClient`. */
export type UndoClient = SecretClient & Pick<WealthfolioClient,
  'getActivityAssignments' | 'assignActivityCategory' | 'unassignActivityCategory'
  | 'listCategorizationRules' | 'createCategorizationRule' | 'deleteCategorizationRule'>;

export function companionUndoIo(
  client: UndoClient,
  dbPath: string,
  host: SyncHost = new RestSyncHost(client as unknown as WealthfolioClient, dbPath),
): UndoIo {
  return {
    host,
    secrets: {
      get: (k) => client.getAddonSecret(ADDON_ID, k),
      set: (k, v) => client.setAddonSecret(ADDON_ID, k, v),
    },
    categories: {
      assignments: async (activityId) => (await client.getActivityAssignments(activityId))
        .map(({ taxonomyId, categoryId }) => ({ taxonomyId, categoryId })),
      assign: (activityId, taxonomyId, categoryId) => client.assignActivityCategory(activityId, taxonomyId, categoryId),
      unassign: (activityId, taxonomyId) => client.unassignActivityCategory(activityId, taxonomyId),
    },
    rules: {
      list: () => client.listCategorizationRules(),
      // The same shape and LOSING priority /categorize's rules are created
      // with (see `buildCategorizeDeps`): a redo puts back what was there.
      create: (rule) => client.createCategorizationRule({ ...rule, taxonomyId: SPENDING_TAXONOMY, priority: 50 }),
      remove: (id) => client.deleteCategorizationRule(id),
      filedBy: async (rule) => getNativeRuleFiledActivityIds(dbPath, rule.categoryId, rule.pattern),
    },
    record: (draft) => recordCompanionChanges(client, [draft]),
    where: { host: 'companion', companionVersion: SIMPLEFIN_SYNC_VERSION },
  };
}

/** N for "↩ Undo rule + un-file N": what the rule filed, read when the entry
 *  is shown. Null when that cannot be read (no database), and for any other
 *  kind. */
export function companionRuleFiledCount(dbPath: string, entry: ChangeEntry): number | null {
  if (entry.kind !== 'category-rule-created') return null;
  const after = (entry.after ?? {}) as Record<string, unknown>;
  if (typeof after.categoryId !== 'string' || typeof after.pattern !== 'string') return null;
  return getNativeRuleFiledActivityIds(dbPath, after.categoryId, after.pattern)?.length ?? null;
}
```

**Edit `companion/src/changes-menu.ts`** — thirteen edits, in order: (1) the header note; (2) imports; (3) the toast strings; (4) the `act` view and `ChangeAction`; (5) its encoding; (6) its decoding (an `act` never nests, like `detail`); (7) `numberRows`'s back type; (8–9) `DetailExtras`, and the result lines and buttons on `renderChangeDetail`; (10–11) `ChangesMenuUi.send` and the three optional deps; (12) `detailScreen` inside `createChangesMenu`; (13) the `detail` case renders through it, and the new `act` case runs Undo / Redo / Sync now.

Edit 1 of 13 in `companion/src/changes-menu.ts` — replace:

```ts
 * Bank and user text (a summary, an account name, a search) is escaped AND
 * kept outside every `*…*`/`_…_`: legacy Markdown ignores a backslash inside
 * an entity, and one bank `*` would cost the whole message.
 */
import { MENU_CALLBACK_PREFIX } from '../../shared/categorize-menu.js';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log.js';
```

with:

```ts
 * Bank and user text (a summary, an account name, a search) is escaped AND
 * kept outside every `*…*`/`_…_`: legacy Markdown ignores a backslash inside
 * an entity, and one bank `*` would cost the whole message.
 *
 * R2: an entry's screen offers `↩ Undo` or `Redo` (a rule: `↩ Undo rule` and
 * `↩ Undo rule + un-file N`). The tap runs the shared runner
 * (shared/change-undo-run.ts) — no confirmation — and the screen says what
 * happened; after a sync decision it adds `🔄 Sync now`, the same forced run
 * as `/sync`.
 */
import { MENU_CALLBACK_PREFIX } from '../../shared/categorize-menu.js';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log.js';
```

Edit 2 of 13 in `companion/src/changes-menu.ts` — replace:

```ts
} from '../../shared/change-view.js';
import { findingHandle } from '../../shared/handle.js';
import { escapeMarkdown, shortDateTime, type InlineKeyboard } from '../../shared/telegram.js';

export const CHANGES_CALLBACK_PREFIX = `${MENU_CALLBACK_PREFIX}cl:`;
export const CHANGES_PAGE_SIZE = 8;
```

with:

```ts
} from '../../shared/change-view.js';
import { findingHandle } from '../../shared/handle.js';
import { escapeMarkdown, shortDateTime, type InlineKeyboard } from '../../shared/telegram.js';
import { undoAvailability, UNDO_TAKES_EFFECT, type UndoOp, type UndoVariant } from '../../shared/change-undo.js';
import type { UndoOutcome } from '../../shared/change-undo-run.js';

export const CHANGES_CALLBACK_PREFIX = `${MENU_CALLBACK_PREFIX}cl:`;
export const CHANGES_PAGE_SIZE = 8;
```

Edit 3 of 13 in `companion/src/changes-menu.ts` — replace:

```ts
export const CHANGES_QUERY_MAX_BYTES = 30;
export const CHANGES_GONE_ANSWER = 'That one is already sorted — refreshing.';
export const CHANGES_UNREACHABLE_REPLY = "Couldn't reach Wealthfolio — try again.";
const FAILED_ANSWER = 'Could not do that — check the companion logs.';

type Button = { text: string; callback_data: string };
```

with:

```ts
export const CHANGES_QUERY_MAX_BYTES = 30;
export const CHANGES_GONE_ANSWER = 'That one is already sorted — refreshing.';
export const CHANGES_UNREACHABLE_REPLY = "Couldn't reach Wealthfolio — try again.";
export const CHANGES_SYNC_STARTED = 'Syncing…';
export const CHANGES_SYNC_RUNNING = 'Already syncing — hang on.';
const FAILED_ANSWER = 'Could not do that — check the companion logs.';

type Button = { text: string; callback_data: string };
```

Edit 4 of 13 in `companion/src/changes-menu.ts` — replace:

```ts
  | { kind: 'list'; page: number; background: boolean }
  | { kind: 'search'; page: number; query: string }
  | { kind: 'run'; run: string; page: number; from: { page: number; background: boolean } }
  | { kind: 'detail'; entry: string; back: Exclude<ChangesView, { kind: 'detail' }> };

const encodeList = (page: number, background: boolean) => `${background ? 'b' : 'l'}${page}`;

```

with:

```ts
  | { kind: 'list'; page: number; background: boolean }
  | { kind: 'search'; page: number; query: string }
  | { kind: 'run'; run: string; page: number; from: { page: number; background: boolean } }
  | { kind: 'detail'; entry: string; back: Exclude<ChangesView, { kind: 'detail' | 'act' }> }
  /** A button on an entry's screen: `u` undo, `r` redo, `f` undo rule + un-file, `s` sync now. */
  | { kind: 'act'; action: ChangeAction; entry: string; back: Exclude<ChangesView, { kind: 'detail' | 'act' }> };

export type ChangeAction = 'u' | 'r' | 'f' | 's';

const encodeList = (page: number, background: boolean) => `${background ? 'b' : 'l'}${page}`;

```

Edit 5 of 13 in `companion/src/changes-menu.ts` — replace:

```ts
    case 'search': return `s${view.page}:${view.query}`;
    case 'run': return `r${view.page}:${view.run}:${encodeList(view.from.page, view.from.background)}`;
    case 'detail': return `d${view.entry}:${encodeView(view.back)}`;
  }
}

```

with:

```ts
    case 'search': return `s${view.page}:${view.query}`;
    case 'run': return `r${view.page}:${view.run}:${encodeList(view.from.page, view.from.background)}`;
    case 'detail': return `d${view.entry}:${encodeView(view.back)}`;
    case 'act': return `x${view.action}${view.entry}:${encodeView(view.back)}`;
  }
}

```

Edit 6 of 13 in `companion/src/changes-menu.ts` — replace:

```ts
  m = /^d([0-9a-f]{8}):(.+)$/s.exec(s);
  if (m && allowDetail) {
    const back = decodeView(m[2], false);
    return back && back.kind !== 'detail' ? { kind: 'detail', entry: m[1], back } : null;
  }
  return null;
}
```

with:

```ts
  m = /^d([0-9a-f]{8}):(.+)$/s.exec(s);
  if (m && allowDetail) {
    const back = decodeView(m[2], false);
    return back && back.kind !== 'detail' && back.kind !== 'act' ? { kind: 'detail', entry: m[1], back } : null;
  }
  m = /^x([urfs])([0-9a-f]{8}):(.+)$/s.exec(s);
  if (m && allowDetail) {
    const back = decodeView(m[3], false);
    return back && back.kind !== 'detail' && back.kind !== 'act'
      ? { kind: 'act', action: m[1] as ChangeAction, entry: m[2], back }
      : null;
  }
  return null;
}
```

Edit 7 of 13 in `companion/src/changes-menu.ts` — replace:

```ts
}

/** Number buttons, four to a row, each opening its line. */
function numberRows(rows: ChangeRow[], first: number, back: Exclude<ChangesView, { kind: 'detail' }>): Button[][] {
  const buttons = rows.map((row, i): Button => ({
    text: String(first + i + 1),
    callback_data: row.kind === 'run' && back.kind === 'list'
```

with:

```ts
}

/** Number buttons, four to a row, each opening its line. */
function numberRows(rows: ChangeRow[], first: number, back: Exclude<ChangesView, { kind: 'detail' | 'act' }>): Button[][] {
  const buttons = rows.map((row, i): Button => ({
    text: String(first + i + 1),
    callback_data: row.kind === 'run' && back.kind === 'list'
```

Edit 8 of 13 in `companion/src/changes-menu.ts` — replace:

```ts
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** One entry: what, why, before → after, who and when. */
export function renderChangeDetail(entry: ChangeLogItem, back: Exclude<ChangesView, { kind: 'detail' }>): MenuScreen {
  const lines = [escapeMarkdown(entry.summary)];
  const facts = [changeAmountText(entry), changeAccountText(entry)].filter(Boolean).map(escapeMarkdown);
  if (facts.length) lines.push(facts.join(' · '));
```

with:

```ts
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** What an entry's screen offers (R2). Absent: an R1 screen, no buttons. */
export interface DetailExtras {
  /** Undo or Redo is possible here. */
  op?: UndoOp;
  /** A rule's undo: how many charges it filed (null: unknown — no un-file button). */
  unfileCount?: number | null;
  /** What the last tap did, said once. */
  result?: { ok: boolean; message: string; needsSync?: boolean };
}

/** One entry: what, why, before → after, who and when — and, in R2, Undo/Redo. */
export function renderChangeDetail(
  entry: ChangeLogItem,
  back: Exclude<ChangesView, { kind: 'detail' | 'act' }>,
  extras: DetailExtras = {},
): MenuScreen {
  const lines = [escapeMarkdown(entry.summary)];
  const facts = [changeAmountText(entry), changeAccountText(entry)].filter(Boolean).map(escapeMarkdown);
  if (facts.length) lines.push(facts.join(' · '));
```

Edit 9 of 13 in `companion/src/changes-menu.ts` — replace:

```ts
  if (beforeAfter) lines.push(`Before → after: ${escapeMarkdown(beforeAfter)}`);
  lines.push(`${changeSourceText(entry)} · ${shortDateTime(entry.at)}`);
  if (entry.undone) lines.push(`↩ Undone ${shortDateTime(entry.undone.at)}`);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: [[{ text: '‹ Back', callback_data: changesData(back) }]] } };
}

/** `/changes` and `/changes <words>`: the first screen, as a reply. */
```

with:

```ts
  if (beforeAfter) lines.push(`Before → after: ${escapeMarkdown(beforeAfter)}`);
  lines.push(`${changeSourceText(entry)} · ${shortDateTime(entry.at)}`);
  if (entry.undone) lines.push(`↩ Undone ${shortDateTime(entry.undone.at)}`);
  const r = extras.result;
  if (r) {
    lines.push('', `${r.ok ? '✅' : '⚠️'} ${escapeMarkdown(r.message)}`);
    if (r.ok && r.needsSync) lines.push(UNDO_TAKES_EFFECT);
  }
  const handle = findingHandle(entry.id);
  const act = (action: ChangeAction) => changesData({ kind: 'act', action, entry: handle, back });
  const keyboard: Button[][] = [];
  if (extras.op === 'redo') keyboard.push([{ text: 'Redo', callback_data: act('r') }]);
  else if (extras.op === 'undo' && entry.kind === 'category-rule-created') {
    const n = extras.unfileCount;
    keyboard.push([
      { text: '↩ Undo rule', callback_data: act('u') },
      ...(n ? [{ text: `↩ Undo rule + un-file ${n}`, callback_data: act('f') }] : []),
    ]);
  } else if (extras.op === 'undo') keyboard.push([{ text: '↩ Undo', callback_data: act('u') }]);
  if (r?.ok && r.needsSync) keyboard.push([{ text: '🔄 Sync now', callback_data: act('s') }]);
  keyboard.push([{ text: '‹ Back', callback_data: changesData(back) }]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** `/changes` and `/changes <words>`: the first screen, as a reply. */
```

Edit 10 of 13 in `companion/src/changes-menu.ts` — replace:

```ts
export interface ChangesMenuUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
}

export interface ChangesMenuDeps {
```

with:

```ts
export interface ChangesMenuUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
  /** A NEW message — where Sync now's summary goes. */
  send?(text: string, keyboard?: InlineKeyboard): Promise<void>;
}

export interface ChangesMenuDeps {
```

Edit 11 of 13 in `companion/src/changes-menu.ts` — replace:

```ts
  read(now: Date): Promise<ChangeLogRead>;
  now(): Date;
  log(msg: string): void;
}

export interface ChangesMenu {
```

with:

```ts
  read(now: Date): Promise<ChangeLogRead>;
  now(): Date;
  log(msg: string): void;
  /** R2: undo or redo one entry (shared/change-undo-run.ts). Absent: read-only. */
  undo?(entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp, variant: UndoVariant): Promise<UndoOutcome>;
  /** N for a rule's "Undo rule + un-file N", read when its screen is shown. */
  ruleFiledCount?(entry: ChangeLogItem): Promise<number | null>;
  /** The `/sync` run: started, or joined; the summary never rejects. */
  syncNow?(): { started: boolean; summary: Promise<string> };
}

export interface ChangesMenu {
```

Edit 12 of 13 in `companion/src/changes-menu.ts` — replace:

```ts
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createChangesMenu(deps: ChangesMenuDeps): ChangesMenu {
  const renderView = (read: ChangeLogRead, view: Exclude<ChangesView, { kind: 'detail' | 'run' }>, now: Date) =>
    (view.kind === 'list' ? renderChangesList(read, view.page, view.background, now) : renderChangesSearch(read, view.page, view.query));

  return {
    handles(data) {
```

with:

```ts
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createChangesMenu(deps: ChangesMenuDeps): ChangesMenu {
  const renderView = (read: ChangeLogRead, view: Exclude<ChangesView, { kind: 'detail' | 'run' | 'act' }>, now: Date) =>
    (view.kind === 'list' ? renderChangesList(read, view.page, view.background, now) : renderChangesSearch(read, view.page, view.query));

  /** The entry's screen, with its Undo/Redo buttons when this menu can undo. */
  const detailScreen = async (entry: ChangeLogItem, back: Exclude<ChangesView, { kind: 'detail' | 'act' }>, result?: DetailExtras['result']) => {
    if (!deps.undo) return renderChangeDetail(entry, back, result ? { result } : {});
    const available = undoAvailability(entry, { host: 'companion', companionVersion: null });
    const op = available.kind === 'ready' ? available.op : undefined;
    const unfileCount = op === 'undo' && entry.kind === 'category-rule-created'
      ? await deps.ruleFiledCount?.(entry).catch(() => null) ?? null
      : null;
    return renderChangeDetail(entry, back, { ...(op ? { op } : {}), unfileCount, ...(result ? { result } : {}) });
  };

  return {
    handles(data) {
```

Edit 13 of 13 in `companion/src/changes-menu.ts` — replace:

```ts
            const entry = read.entries.find((e) => findingHandle(e.id) === view.entry);
            if (!entry) return void await gone();
            if (view.back.kind === 'run' && runEntries(view.back.run).length === 0) return void await gone();
            return void await show(renderChangeDetail(entry, view.back));
          }
        }
      } catch (err) {
```

with:

```ts
            const entry = read.entries.find((e) => findingHandle(e.id) === view.entry);
            if (!entry) return void await gone();
            if (view.back.kind === 'run' && runEntries(view.back.run).length === 0) return void await gone();
            return void await show(await detailScreen(entry, view.back));
          }
          case 'act': {
            const entry = read.entries.find((e) => findingHandle(e.id) === view.entry);
            if (!entry) return void await gone();
            if (view.action === 's') {
              if (!deps.syncNow) return void await ui.answer();
              const { started, summary } = deps.syncNow();
              await ui.answer(started ? CHANGES_SYNC_STARTED : CHANGES_SYNC_RUNNING);
              // Not awaited: a sync takes tens of seconds, and the summary
              // promise cannot reject.
              void summary.then((text) => ui.send?.(text)).catch((err) => deps.log(`Changes menu: sync summary not sent: ${message(err)}`));
              return;
            }
            if (!deps.undo) return void await ui.answer();
            const op: UndoOp = view.action === 'r' ? 'redo' : 'undo';
            const outcome = await deps.undo(entry, read.entries, op, view.action === 'f' ? 'unfile' : 'plain');
            // Re-read so the screen shows the entry as it now stands (Undone,
            // and Redo offered); the old read stands in if that fails.
            const fresh = outcome.ok ? await deps.read(deps.now()).catch(() => read) : read;
            const now2 = fresh.entries.find((e) => e.id === entry.id) ?? entry;
            return void await show(await detailScreen(now2, view.back, {
              ok: outcome.ok, message: outcome.message, ...(outcome.ok ? { needsSync: outcome.needsSync } : {}),
            }));
          }
        }
      } catch (err) {
```

**Edit `companion/src/index.ts`** — four edits: imports; `startTelegramSync` beside the `/sync` replies; the `/sync` command uses it (its comment about awaiting the reply stays); the menu's `undo`, `ruleFiledCount` and `syncNow`.

Edit 1 of 4 in `companion/src/index.ts` — replace:

```ts
import { companionChangeSink, readCompanionChangeLog, recordCompanionChanges } from './change-log-host.js';
import { emptySyncOverrides, hasAccountOverride, hasTxOverride, syncOverridesOrEmpty, type SyncOverrides } from '../../shared/sync-overrides.js';
import { createChangesMenu, renderChangesCommand, CHANGES_UNREACHABLE_REPLY, type ChangesMenu } from './changes-menu.js';
import type { ChangeLogRead } from '../../shared/change-log.js';
import type { ChangeDraft } from '../../shared/change-entries.js';
import { createTransferLearning, type TransferLearning } from './transfer-learning.js';
```

with:

```ts
import { companionChangeSink, readCompanionChangeLog, recordCompanionChanges } from './change-log-host.js';
import { emptySyncOverrides, hasAccountOverride, hasTxOverride, syncOverridesOrEmpty, type SyncOverrides } from '../../shared/sync-overrides.js';
import { createChangesMenu, renderChangesCommand, CHANGES_UNREACHABLE_REPLY, type ChangesMenu } from './changes-menu.js';
import { companionRuleFiledCount, companionUndoIo } from './change-undo-host.js';
import { runChangeUndo } from '../../shared/change-undo-run.js';
import type { ChangeLogRead } from '../../shared/change-log.js';
import type { ChangeDraft } from '../../shared/change-entries.js';
import { createTransferLearning, type TransferLearning } from './transfer-learning.js';
```

Edit 2 of 4 in `companion/src/index.ts` — replace:

```ts
const SYNC_STARTED_REPLY = 'Syncing…';
const SYNC_ALREADY_RUNNING_REPLY = 'Already syncing — hang on.';

/** One line for every way `/newrule`'s arguments can fail to parse — see
 *  `parseNewRuleArgs`, which deliberately does not distinguish them. */
const NEWRULE_USAGE_REPLY = 'Usage: /newrule trader joes = groceries';
```

with:

```ts
const SYNC_STARTED_REPLY = 'Syncing…';
const SYNC_ALREADY_RUNNING_REPLY = 'Already syncing — hang on.';

/**
 * `/sync` and the change log's 🔄 Sync now: one FORCED run through the shared
 * lock, joined when one is already running.
 *
 * Both handlers are attached to the run synchronously, BEFORE any caller
 * awaits, and in BOTH branches. That ordering is the point: a sync that
 * rejects while a caller is suspended would otherwise be an unhandled
 * rejection, which kills the daemon and stops bank syncing — the same hazard
 * the cron callbacks' `.catch` guards. It also makes `summary` a promise that
 * can only ever FULFIL, with a string.
 */
export function startTelegramSync(): { started: boolean; summary: Promise<string> } {
  const { started, result } = runCompanionSyncExclusive(() => runCompanionSync({ force: true }));
  const summary = result.then(
    (r) => formatSyncReply({
      imported: r.imported,
      skipped: r.skipped,
      driftAlerts: r.balanceDriftAlerts.length,
      errors: r.errors,
    }),
    // RAW error text: `formatSyncReply` escapes it itself.
    (err) => formatSyncReply({ imported: 0, skipped: 0, driftAlerts: 0, errors: [formatError(err)] }),
  );
  return { started, summary };
}

/** One line for every way `/newrule`'s arguments can fail to parse — see
 *  `parseNewRuleArgs`, which deliberately does not distinguish them. */
const NEWRULE_USAGE_REPLY = 'Usage: /newrule trader joes = groceries';
```

Edit 3 of 4 in `companion/src/index.ts` — replace:

```ts
        // not yet elapsed". The addon's Sync Now answers that with a "Sync
        // anyway" button; a chat command has no second click, so an explicit
        // request forces — which is what the design and the changelog promise.
        const { started, result } = runCompanionSyncExclusive(() => runCompanionSync({ force: true }));
        // Both handlers are attached to `result` synchronously, BEFORE the first
        // `await`, and in BOTH branches. That ordering is the point: a sync that
        // rejects while this function is suspended would otherwise be an
        // unhandled rejection, which kills the daemon and stops bank syncing —
        // the same hazard the cron callbacks' `.catch` guards. It also makes
        // `summary` a promise that can only ever FULFIL, with a string.
        const summary = result.then(
          (r) => formatSyncReply({
            imported: r.imported,
            skipped: r.skipped,
            driftAlerts: r.balanceDriftAlerts.length,
            errors: r.errors,
          }),
          // RAW error text: `formatSyncReply` escapes it itself.
          (err) => formatSyncReply({ imported: 0, skipped: 0, driftAlerts: 0, errors: [formatError(err)] }),
        );

        await reply(started ? SYNC_STARTED_REPLY : SYNC_ALREADY_RUNNING_REPLY);

```

with:

```ts
        // not yet elapsed". The addon's Sync Now answers that with a "Sync
        // anyway" button; a chat command has no second click, so an explicit
        // request forces — which is what the design and the changelog promise.
        const { started, summary } = startTelegramSync();

        await reply(started ? SYNC_STARTED_REPLY : SYNC_ALREADY_RUNNING_REPLY);

```

Edit 4 of 4 in `companion/src/index.ts` — replace:

```ts
  });

  // `/changes`. Stateless: every tap re-reads the log, so it survives restarts.
  const changes: ChangesMenu = createChangesMenu({
    read: (now) => readCompanionChangeLog(wfClient, now),
    now: () => new Date(),
    log,
  });
```

with:

```ts
  });

  // `/changes`. Stateless: every tap re-reads the log, so it survives restarts.
  // Undo and Redo run here (R2) through the shared runner; Sync now is /sync.
  const changes: ChangesMenu = createChangesMenu({
    read: (now) => readCompanionChangeLog(wfClient, now),
    undo: (entry, entries, op, variant) => runChangeUndo(entry, entries, op, companionUndoIo(wfClient, wealthfolioDbPath()), variant),
    ruleFiledCount: async (entry) => companionRuleFiledCount(wealthfolioDbPath(), entry),
    syncNow: () => startTelegramSync(),
    now: () => new Date(),
    log,
  });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix companion test -- src/change-undo-host.test.ts src/changes-menu-undo.test.ts src/changes-menu.test.ts src/index.test.ts`
Expected: PASS — 307 tests.

Run: `npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/change-undo-host.ts companion/src/changes-menu.ts companion/src/index.ts companion/src/change-undo-host.test.ts companion/src/changes-menu-undo.test.ts
git commit -m "Bot: /changes undoes and redoes — no confirmation — with Sync now after a sync decision

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The add-on undoes — its UndoIo, and the overrides list's store methods

The add-on's half of the runner (U1): activities through `AddonSyncHost` (which cannot read `sourceGroupId`, so "is it linked?" comes from `linked_groups`), the settings through `ctx.api.secrets`, the reversal entry through the store's one change-log writer, and NO categories or rules — the runner then answers a category or rule entry with "Undo this from Telegram: /changes". `undoFromApp` reads the companion's published version for the gate on every tap (a companion updated meanwhile opens it). `SecretsStore` gains the two methods "Your overrides" needs: `readSyncOverrides` (with the unreadable flag; null when the read fails) and `editSyncOverrides` (the shared edit, refusing a corrupt document).

**Files:**
- Create: `src/utils/change-undo.ts`
- Modify: `src/utils/secrets.ts`
- Test: `src/utils/change-undo.test.ts`

**Interfaces:**
- Consumes: Task 5 (`runChangeUndo`, `UndoIo`, `UndoOutcome`); Task 4 (`UndoOp`, `UNDO_FROM_TELEGRAM`, `UNDO_UPDATE_COMPANION` in tests); Task 1 (`loadSyncOverrides`, `editSyncOverrides`, `LoadedSyncOverrides`, `SyncOverridesEdit`, `SyncOverrides`, `SYNC_OVERRIDES_SECRET_KEY`, `syncOverridesOrEmpty`); existing: `AddonSyncHost`, `SecretsStore.recordChange(draft)`, `SecretsStore.getCompanionVersion()`, `ChangeLogItem`.
- Produces:

```ts
// src/utils/change-undo.ts
export function addonUndoIo(ctx: AddonContext, store: SecretsStore, companionVersion: string | null): UndoIo;
export async function undoFromApp(ctx: AddonContext, store: SecretsStore, entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp): Promise<UndoOutcome>;
// src/utils/secrets.ts — SecretsStore gains:
async readSyncOverrides(): Promise<LoadedSyncOverrides | null>;
async editSyncOverrides(edit: SyncOverridesEdit): Promise<SyncOverrides>;   // rejects SyncOverridesUnreadableError, writing nothing
```

- [ ] **Step 1: Write the failing tests**

**Create `src/utils/change-undo.test.ts`:**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { categoryFiledChange, importChange, stampChange, transferLinkChange } from '../../shared/change-entries';
import type { ChangeBucket } from '../../shared/change-log';
import { UNDO_FROM_TELEGRAM, UNDO_UPDATE_COMPANION } from '../../shared/change-undo';
import { emptySyncOverrides, setTxOverride, SYNC_OVERRIDES_SECRET_KEY } from '../../shared/sync-overrides';
import { accountTxKey } from '../../shared/transfers';
import { SecretsStore } from './secrets';
import { undoFromApp } from './change-undo';

const NOW = new Date('2026-10-13T15:00:00Z');
const CHECKING = { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' };

/** The add-on's secrets and activities in memory, deletes included. */
function makeCtx(seed: Record<string, string> = {}, rows: any[] = []) {
  const data: Record<string, string> = { ...seed };
  const ctx = {
    api: {
      secrets: {
        get: vi.fn(async (k: string) => data[k] ?? null),
        set: vi.fn(async (k: string, v: string) => { data[k] = v; }),
        delete: vi.fn(async (k: string) => { delete data[k]; }),
      },
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-a', name: 'Checking', accountType: 'CASH', currency: 'USD' }]) },
      activities: {
        search: vi.fn(async () => ({ data: rows })),
        saveMany: vi.fn(async (req: any) => {
          for (const id of req.deleteIds ?? []) rows.splice(rows.findIndex((r) => r.id === id), 1);
          return { created: [], updated: [], deleted: [], createdMappings: [], errors: [] };
        }),
      },
    },
  } as any;
  return { ctx, data, rows };
}

const imported = () => stampChange(importChange({
  account: CHECKING, txKey: accountTxKey('sfin-1', 'tx-1'), activityId: 'act-1', description: 'SQ *BLUE_BOTTLE', amountCents: -650,
  date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
}), 'companion', new Date('2026-10-12T09:00:00Z'));
const row = () => ({ id: 'act-1', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-11', amount: 6.5, comment: 'SQ *BLUE_BOTTLE · tx-1' });

describe('undoFromApp', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('undoes an import through the SDK and records it in the add-on’s own bucket', async () => {
    const { ctx, data, rows } = makeCtx({ companion_version: '1.61.0' }, [row()]);
    const store = new SecretsStore(ctx);
    const e = imported();
    expect(await undoFromApp(ctx, store, e, [e], 'undo')).toMatchObject({ ok: true, needsSync: false });
    expect(rows).toEqual([]);
    expect(JSON.parse(data.skipped_transactions)).toEqual([expect.objectContaining({ account: 'sfin-1', txId: 'tx-1' })]);
    const bucket = JSON.parse(data['change_log:addon:2026-10']) as ChangeBucket;
    expect(bucket.entries).toEqual([expect.objectContaining({ writer: 'addon', actor: 'you', reverses: { id: e.id, op: 'undo' } })]);
  });

  it('refuses a linked import from the ledger the add-on keeps, since it cannot read groups', async () => {
    const { ctx, rows } = makeCtx({ linked_groups: JSON.stringify({ [accountTxKey('sfin-1', 'tx-1')]: 'wf-transfer-1' }) }, [row()]);
    const e = imported();
    expect(await undoFromApp(ctx, new SecretsStore(ctx), e, [e], 'undo')).toEqual({ ok: false, message: 'Undo the transfer link first.' });
    expect(rows).toHaveLength(1);
  });

  it('a category entry is undone from Telegram, and an old companion blocks a sync decision', async () => {
    const { ctx, data } = makeCtx({ companion_version: '1.59.2' });
    const store = new SecretsStore(ctx);
    const filing = stampChange(categoryFiledChange({
      actor: 'you', activityId: 'act-5', description: 'VENMO', before: null, after: { categoryId: 'c', categoryName: 'Dining' },
    }), 'companion', NOW);
    expect(await undoFromApp(ctx, store, filing, [filing], 'undo')).toEqual({ ok: false, message: UNDO_FROM_TELEGRAM });
    const link = stampChange(transferLinkChange(
      { account: CHECKING, txKey: 'k1', description: 'A', amountCents: -100, date: '2026-10-08', oldActivityId: 'o1' },
      { account: { name: 'Card' }, txKey: 'k2', description: 'B', amountCents: 100, date: '2026-10-08', oldActivityId: 'o2' },
    ), 'companion', NOW);
    expect(await undoFromApp(ctx, store, link, [link], 'undo')).toEqual({ ok: false, message: UNDO_UPDATE_COMPANION });
    expect(data[SYNC_OVERRIDES_SECRET_KEY]).toBeUndefined();
  });
});

describe('SecretsStore — the overrides list', () => {
  it('reads it with an unreadable flag, and edits it re-reading first', async () => {
    const doc = setTxOverride(emptySyncOverrides(), 'k1', 'notTransfer', NOW);
    const { ctx, data } = makeCtx({ [SYNC_OVERRIDES_SECRET_KEY]: JSON.stringify(doc) });
    const store = new SecretsStore(ctx);
    expect(await store.readSyncOverrides()).toEqual({ overrides: doc, unreadable: false });
    await store.editSyncOverrides((o) => setTxOverride(o, 'k2', 'keepDuplicate', NOW));
    expect(Object.keys(JSON.parse(data[SYNC_OVERRIDES_SECRET_KEY]).tx)).toEqual(['k1', 'k2']);
  });

  it('flags a corrupt document, and refuses to overwrite it', async () => {
    const { ctx, data } = makeCtx({ [SYNC_OVERRIDES_SECRET_KEY]: '{oops' });
    const store = new SecretsStore(ctx);
    expect(await store.readSyncOverrides()).toEqual({ overrides: emptySyncOverrides(), unreadable: true });
    await expect(store.editSyncOverrides((o) => o)).rejects.toMatchObject({ name: 'SyncOverridesUnreadableError' });
    expect(data[SYNC_OVERRIDES_SECRET_KEY]).toBe('{oops');
  });

  it('is null when the read itself fails', async () => {
    const { ctx } = makeCtx();
    ctx.api.secrets.get = vi.fn(async () => { throw new Error('host gone'); });
    expect(await new SecretsStore(ctx).readSyncOverrides()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/utils/change-undo.test.ts`
Expected: FAIL — `./change-undo` does not exist, and `readSyncOverrides` / `editSyncOverrides` are not functions.

- [ ] **Step 3: Implement**

**Edit `src/utils/secrets.ts`** — two edits: the imports; the two methods after `getSyncOverrides`.

Edit 1 of 2 in `src/utils/secrets.ts` — replace:

```ts
  type LoadedSubscriptionPrefs, type SubscriptionEdit, type SubscriptionPrefs,
} from '../../shared/subscription-prefs';
import { newRunId, stampChange, type ChangeDraft, type ChangeEntry, type ChangeLogSink } from '../../shared/change-entries';
import { SYNC_OVERRIDES_SECRET_KEY, syncOverridesOrEmpty, type SyncOverrides } from '../../shared/sync-overrides';
import {
  changeLogResetKeys, createChangeLogWriter, readChangeLog, type ChangeLogIo, type ChangeLogRead,
} from '../../shared/change-log';
```

with:

```ts
  type LoadedSubscriptionPrefs, type SubscriptionEdit, type SubscriptionPrefs,
} from '../../shared/subscription-prefs';
import { newRunId, stampChange, type ChangeDraft, type ChangeEntry, type ChangeLogSink } from '../../shared/change-entries';
import {
  editSyncOverrides as editOverridesDocument, loadSyncOverrides, SYNC_OVERRIDES_SECRET_KEY, syncOverridesOrEmpty,
  type LoadedSyncOverrides, type SyncOverrides, type SyncOverridesEdit,
} from '../../shared/sync-overrides';
import {
  changeLogResetKeys, createChangeLogWriter, readChangeLog, type ChangeLogIo, type ChangeLogRead,
} from '../../shared/change-log';
```

Edit 2 of 2 in `src/utils/secrets.ts` — replace:

```ts
    return syncOverridesOrEmpty((k) => this.ctx.api.secrets.get(k));
  }

  /** Which collapsible config cards the user left open, keyed by card id.
   *  Purely cosmetic, so a malformed value degrades to "everything closed"
   *  rather than surfacing an error — but it is worth storing: the account
```

with:

```ts
    return syncOverridesOrEmpty((k) => this.ctx.api.secrets.get(k));
  }

  /** The document for the Change log card's "Your overrides": `unreadable` when
   *  a stored one cannot be read (the list then turns read-only). Null when
   *  the host read itself fails. */
  async readSyncOverrides(): Promise<LoadedSyncOverrides | null> {
    try {
      return await loadSyncOverrides((k) => this.ctx.api.secrets.get(k));
    } catch {
      return null;
    }
  }

  /** One edit, re-read immediately before the write (the companion writes the
   *  same document). Rejects with SyncOverridesUnreadableError, writing
   *  nothing, when the stored document is corrupt. */
  async editSyncOverrides(edit: SyncOverridesEdit): Promise<SyncOverrides> {
    return editOverridesDocument(
      (k) => this.ctx.api.secrets.get(k),
      (k, v) => this.ctx.api.secrets.set(k, v),
      edit,
      new Date(),
    );
  }

  /** Which collapsible config cards the user left open, keyed by card id.
   *  Purely cosmetic, so a malformed value degrades to "everything closed"
   *  rather than surfacing an error — but it is worth storing: the account
```

**Create `src/utils/change-undo.ts`:**

```ts
/**
 * src/utils/change-undo.ts
 *
 * Undo and Redo from the app's Change log card, through the shared runner
 * (shared/change-undo-run.ts). The add-on reaches activities and settings
 * only: a category or a rule entry is undone from Telegram (`/changes`), and
 * the card says so. A sync decision's Undo waits for a companion that obeys
 * overrides — the version it publishes decides (`companion_version`).
 *
 * The reversal entry is recorded in the add-on's own bucket through the
 * store's one writer.
 */
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { ChangeLogItem } from '../../shared/change-log';
import type { UndoOp } from '../../shared/change-undo';
import { runChangeUndo, type UndoIo, type UndoOutcome } from '../../shared/change-undo-run';
import { AddonSyncHost } from './addon-host';
import type { SecretsStore } from './secrets';

export function addonUndoIo(ctx: AddonContext, store: SecretsStore, companionVersion: string | null): UndoIo {
  return {
    host: new AddonSyncHost(ctx),
    secrets: {
      get: (k) => ctx.api.secrets.get(k),
      set: (k, v) => ctx.api.secrets.set(k, v),
    },
    record: (draft) => store.recordChange(draft),
    where: { host: 'addon', companionVersion },
  };
}

/** One Undo or Redo, decided against the log as the card last read it. */
export async function undoFromApp(
  ctx: AddonContext,
  store: SecretsStore,
  entry: ChangeLogItem,
  entries: ChangeLogItem[],
  op: UndoOp,
): Promise<UndoOutcome> {
  const companionVersion = await (store.getCompanionVersion?.() ?? Promise.resolve(null)).catch(() => null);
  return runChangeUndo(entry, entries, op, addonUndoIo(ctx, store, companionVersion));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/utils/change-undo.test.ts src/utils/secrets.test.ts src/utils/secrets-overrides.test.ts`
Expected: PASS — 52 tests.

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/utils/change-undo.ts src/utils/change-undo.test.ts src/utils/secrets.ts
git commit -m "Add-on: undo through the shared runner; the overrides document for the card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The Change log card — Undo, Redo, Sync now, Your overrides

The app side of spec B3 (U7). An opened row shows, from `undoAvailability(entry, { host: 'addon', companionVersion })`: an `Undo` or `Redo` button; or, for a sync decision while the companion is old, a disabled `Undo` beside "Update the companion first"; or, for a category or rule entry while a companion runs, "Undo this from Telegram: /changes" (nothing at all without a companion). A click acts at once — no confirmation — and says the result under the row (a refusal in the warning colour); after a sync decision it adds "Takes effect on the next sync." beside `Sync now` (the Settings tab's `runSync(ctx, store, { force: true })`, whose one-line result is shown). After an undo, a redo or a sync the card re-reads the log and the overrides. An undone row is muted and reads `· Undone by you <Mon D>` (R1's `(undone)` goes; its test is updated). At the bottom, "Your overrides" lists `overrideRows` newest first, each with `Remove` (the shared edit); an unreadable document shows "Your sync overrides can't be read, so they can't be changed here." and no Remove. The card without `undo` stays read-only exactly as in R1. No emoji anywhere in its copy.

**Files:**
- Modify: `src/components/ChangeLogCard.tsx`, `src/components/ui.tsx`, `src/tabs/SettingsTab.tsx`
- Modify (test): `src/components/ChangeLogCard.test.tsx` (R1's undone-row assertion)
- Test: `src/components/ChangeLogCard-undo.test.tsx`

**Interfaces:**
- Consumes: Task 4 (`undoAvailability`, `UNDO_TAKES_EFFECT`, `UNDO_UNREACHABLE`, `UndoOp`); Task 5 (`UndoOutcome`); Task 1 (`overrideRows`, `removeOverrideRow`, `emptySyncOverrides`, `LoadedSyncOverrides`, `OverrideRow`, `setTxOverride`/`setAccountOverride` in tests); Task 8 (`undoFromApp`, `SecretsStore.readSyncOverrides`, `SecretsStore.editSyncOverrides`); existing: `SecretsStore.getCompanionVersion`, `runSync`, `changeDay`, `changeLocalDay`, `Button`.
- Produces (`src/components/ChangeLogCard.tsx`):

```ts
export const OVERRIDES_TITLE = 'Your overrides';
export const OVERRIDES_EMPTY = 'None. The sync decides everything.';
export const OVERRIDES_UNREADABLE = "Your sync overrides can't be read, so they can't be changed here.";
export const OVERRIDES_READ_FAILED = 'Could not read your overrides — reload the page to try again.';
export const OVERRIDE_REMOVED = 'Removed. The next sync decides again.';
export interface ChangeLogCardProps {
  load: () => Promise<ChangeLogRead | null>;
  now?: () => Date;
  undo?: (entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp) => Promise<UndoOutcome>;
  companionVersion?: string | null;
  onSyncNow?: () => Promise<string>;
  loadOverrides?: () => Promise<LoadedSyncOverrides | null>;
  removeOverride?: (row: OverrideRow) => Promise<void>;
}
```

- New classes (column 0, once each): `.sfin-log-undone`, `.sfin-log-undo`, `.sfin-log-result`, `.sfin-log-result--refused`, `.sfin-log-overrides`, `.sfin-log-overrides-title`, `.sfin-log-override`. Sync now's sentence (SettingsTab): `Synced — <n> imported.` or `Synced, with a problem: <first error>`; a thrown sync: `The sync failed: <message>`.

- [ ] **Step 1: Write the failing tests**

**Edit `src/components/ChangeLogCard.test.tsx`** — one edit: an undone row now reads "Undone by you".

Edit 1 of 1 in `src/components/ChangeLogCard.test.tsx` — replace:

```tsx
    mount(log([e]));
    const row = await screen.findByRole('button', { name: /Moved VENMO/ });
    expect(row.className).toContain('sfin-log-row--undone');
    expect(row.textContent).toContain('(undone)');
  });
});
```

with:

```tsx
    mount(log([e]));
    const row = await screen.findByRole('button', { name: /Moved VENMO/ });
    expect(row.className).toContain('sfin-log-row--undone');
    expect(row.textContent).toContain('· Undone by you Oct 12');
  });
});
```

**Create `src/components/ChangeLogCard-undo.test.tsx`:**

```tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  balanceCorrectionChange, categoryFiledChange, importChange, stampChange, type ChangeDraft,
} from '../../shared/change-entries';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log';
import type { UndoOutcome } from '../../shared/change-undo-run';
import {
  emptySyncOverrides, setAccountOverride, setTxOverride, type LoadedSyncOverrides,
} from '../../shared/sync-overrides';
import { ChangeLogCard, OVERRIDES_EMPTY, OVERRIDES_UNREADABLE, OVERRIDE_REMOVED, type ChangeLogCardProps } from './ChangeLogCard';

const at = (month: number, day: number, h: number, m: number) => new Date(2026, month, day, h, m);
const NOW = at(9, 13, 15, 0);
const CHECKING = { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' };
const item = (draft: ChangeDraft, when: Date): ChangeLogItem => stampChange(draft, 'companion', when);
const imported = () => item(importChange({
  account: CHECKING, txKey: 'sfin-1\u0000tx-1', activityId: 'act-1', description: 'SQ *BLUE_BOTTLE', amountCents: -650,
  date: '2026-10-12', pending: false, activityType: 'WITHDRAWAL',
}), at(9, 13, 9, 0));
const yourCorrection = () => item(balanceCorrectionChange({
  account: CHECKING, actor: 'you', activityId: 'plug-1', amountCents: 215, date: '2026-10-13', activityType: 'CREDIT', comment: 'Balance adjustment · sfin-1 · 2026-10-13',
}), at(9, 13, 10, 0));
const filing = () => item(categoryFiledChange({
  actor: 'you', activityId: 'act-5', description: 'VENMO *J SMITH', before: null, after: { categoryId: 'c', categoryName: 'Dining' },
}), at(9, 13, 11, 0));
const log = (entries: ChangeLogItem[]): ChangeLogRead =>
  ({ entries: [...entries].sort((a, b) => (a.at < b.at ? 1 : -1)), gaps: [], trimmed: 0, unreadable: [] });
const EMOJI = /\p{Extended_Pictographic}/u;

function mount(entries: ChangeLogItem[], props: Partial<ChangeLogCardProps> = {}) {
  const load = vi.fn(async () => log(entries));
  render(<ChangeLogCard load={load} now={() => NOW} companionVersion="1.61.0" {...props} />);
  return load;
}
const open = async (name: RegExp) => fireEvent.click(await screen.findByRole('button', { name }));
const detail = () => document.querySelector('.sfin-log-detail') as HTMLElement;

describe('ChangeLogCard — Undo and Redo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('undoes at once — no confirmation — says what happened, and reads the log again', async () => {
    const e = yourCorrection();
    const undo = vi.fn(async (): Promise<UndoOutcome> => ({ ok: true, message: 'Undone — the correction is gone.', needsSync: false }));
    const load = mount([e], { undo });
    await open(/Added a balance correction/);
    fireEvent.click(within(detail()).getByRole('button', { name: 'Undo' }));
    expect(await within(detail()).findByText('Undone — the correction is gone.')).toBeInTheDocument();
    expect(undo).toHaveBeenCalledWith(expect.objectContaining({ id: e.id }), [e], 'undo');
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('after a sync decision: "Takes effect on the next sync." beside Sync now', async () => {
    const onSyncNow = vi.fn(async () => 'Synced — 0 imported.');
    mount([imported()], {
      undo: vi.fn(async () => ({ ok: true as const, message: "Undone — it's removed and won't be imported again.", needsSync: true })),
      onSyncNow,
    });
    await open(/Imported SQ \*BLUE_BOTTLE/);
    fireEvent.click(within(detail()).getByRole('button', { name: 'Undo' }));
    expect(await within(detail()).findByText(/Takes effect on the next sync\./)).toBeInTheDocument();
    fireEvent.click(within(detail()).getByRole('button', { name: 'Sync now' }));
    expect(await within(detail()).findByText('Synced — 0 imported.')).toBeInTheDocument();
    expect(onSyncNow).toHaveBeenCalledTimes(1);
  });

  it('an old companion disables a sync decision’s Undo: "Update the companion first"', async () => {
    const undo = vi.fn();
    mount([imported()], { undo, companionVersion: '1.59.2' });
    await open(/Imported SQ \*BLUE_BOTTLE/);
    const button = within(detail()).getByRole('button', { name: 'Undo' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(within(detail()).getByText('Update the companion first')).toBeInTheDocument();
    fireEvent.click(button);
    expect(undo).not.toHaveBeenCalled();
  });

  it('a category entry points at Telegram while a companion runs, and offers nothing without one', async () => {
    mount([filing()], { undo: vi.fn() });
    await open(/Filed VENMO/);
    expect(within(detail()).getByText('Undo this from Telegram: /changes')).toBeInTheDocument();
    expect(within(detail()).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('a category entry with no companion shows no undo line at all', async () => {
    mount([filing()], { undo: vi.fn(), companionVersion: null });
    await open(/Filed VENMO/);
    expect(within(detail()).queryByText(/from Telegram/)).toBeNull();
    expect(document.querySelector('.sfin-log-undo')).toBeNull();
  });

  it('an undone row is muted, says "Undone by you", and offers Redo', async () => {
    const e = { ...yourCorrection(), undone: { by: 'a9', at: at(9, 13, 12, 0).toISOString() } };
    const undo = vi.fn(async (): Promise<UndoOutcome> => ({ ok: true, message: 'Redone — the correction is back.', needsSync: false }));
    mount([e], { undo });
    const row = await screen.findByRole('button', { name: /Added a balance correction/ });
    expect(row.className).toContain('sfin-log-row--undone');
    expect(row.textContent).toContain('· Undone by you Oct 13');
    fireEvent.click(row);
    fireEvent.click(within(detail()).getByRole('button', { name: 'Redo' }));
    await within(detail()).findByText('Redone — the correction is back.');
    expect(undo).toHaveBeenCalledWith(expect.anything(), expect.any(Array), 'redo');
  });

  it('says a refusal under the row', async () => {
    mount([yourCorrection()], { undo: vi.fn(async () => ({ ok: false as const, message: 'It has changed since — nothing was undone.' })) });
    await open(/Added a balance correction/);
    fireEvent.click(within(detail()).getByRole('button', { name: 'Undo' }));
    expect(await within(detail()).findByText('It has changed since — nothing was undone.')).toBeInTheDocument();
    expect(within(detail()).queryByText(/Takes effect/)).toBeNull();
  });

  it('stays read-only without the undo prop, as in R1', async () => {
    mount([yourCorrection()]);
    await open(/Added a balance correction/);
    expect(within(detail()).queryByRole('button')).toBeNull();
  });
});

describe('ChangeLogCard — Your overrides', () => {
  const doc = (): LoadedSyncOverrides => ({
    overrides: setAccountOverride(
      setTxOverride(emptySyncOverrides(), 'sfin-1\u0000tx-1', 'notTransfer', new Date('2026-10-12T09:00:00Z'), { label: 'CITI AUTOPAY · Checking' }),
      'sfin-1', 'noAutoCorrect', new Date('2026-10-13T09:00:00Z'), { label: 'Checking' },
    ),
    unreadable: false,
  });

  it('lists each override in words, newest first, and Remove takes one out', async () => {
    let current = doc();
    const loadOverrides = vi.fn(async () => current);
    const removeOverride = vi.fn(async () => { current = { overrides: setTxOverride(emptySyncOverrides(), 'x', 'notTransfer', new Date('2026-10-12T09:00:00Z'), { label: 'CITI AUTOPAY · Checking' }), unreadable: false }; });
    mount([], { loadOverrides, removeOverride });
    expect(await screen.findByText('Your overrides')).toBeInTheDocument();
    const rows = () => Array.from(document.querySelectorAll('.sfin-log-override')).map((r) => r.querySelector('.sfin-log-summary')!.textContent);
    expect(rows()).toEqual(['No automatic balance corrections: Checking', 'Not a transfer: CITI AUTOPAY · Checking']);
    fireEvent.click(within(document.querySelectorAll('.sfin-log-override')[0] as HTMLElement).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(OVERRIDE_REMOVED)).toBeInTheDocument();
    expect(removeOverride).toHaveBeenCalledWith(expect.objectContaining({ scope: 'account', key: 'sfin-1', flag: 'noAutoCorrect' }));
    await waitFor(() => expect(rows()).toEqual(['Not a transfer: CITI AUTOPAY · Checking']));
  });

  it('says when there are none, and turns read-only over an unreadable document', async () => {
    mount([], { loadOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: false })) });
    expect(await screen.findByText(OVERRIDES_EMPTY)).toBeInTheDocument();
  });

  it('an unreadable document: the notice, no Remove', async () => {
    mount([], { loadOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: true })), removeOverride: vi.fn() });
    expect(await screen.findByText(OVERRIDES_UNREADABLE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('carries no emoji in its copy', async () => {
    mount([imported(), filing()], { undo: vi.fn(), loadOverrides: vi.fn(async () => doc()), companionVersion: '1.59.2' });
    await screen.findByText('Your overrides');
    await open(/Imported SQ/);
    await open(/Filed VENMO/);
    const chrome = Array.from(document.querySelectorAll('button, .sfin-subtle, .sfin-log-overrides-title, .sfin-log-result'))
      .map((el) => el.textContent ?? '').join('\n');
    expect(chrome).not.toMatch(EMOJI);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/ChangeLogCard-undo.test.tsx src/components/ChangeLogCard.test.tsx`
Expected: FAIL — no Undo/Redo controls, no "Your overrides", and the undone row still reads `(undone)`.

- [ ] **Step 3: Implement**

**Edit `src/components/ChangeLogCard.tsx`** — nine edits, in order: (1) the header note and imports; (2) the overrides copy; (3) the new props and `RowActions`; (4) `UndoControls`, and `EntryDetail`/`Row` taking `actions` ("Undone by you" in the detail); (5) the muted row's `· Undone by you <day>`, and `EntryDetail` getting `actions`; (6) `OverridesList`, and the card re-reading on `version`; (7) `actions` built once the log is read; (8) rows get `actions`; (9) the overrides list at the bottom.

Edit 1 of 9 in `src/components/ChangeLogCard.tsx` — replace:

```tsx
/**
 * src/components/ChangeLogCard.tsx
 *
 * The change log in the app (Settings → Sync), read-only in R1: every write
 * the sync, the companion and you made, the same entries `/changes` shows —
 * the words come from the entries' own summaries and shared/change-view.ts.
 *
 * Filters: account, kind group, 7 / 30 / 90 days, search. Rows by day: time,
 * summary, account, amount; a row opens to why, before → after, and who. One
 * sync run's imports are one row that opens to its transactions. Bookkeeping
 * shows only under Background.
 *
 * Bank text is rendered as React text, never as markup. No emoji in app copy
 * (src/pages/copy-policy.test.tsx).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Button, Input, Select } from './ui';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log';
import { changeDay } from '../../shared/change-entries';
import { shortDateTime } from '../../shared/telegram';
import {
```

with:

```tsx
/**
 * src/components/ChangeLogCard.tsx
 *
 * The change log in the app (Settings → Sync): every write the sync, the
 * companion and you made, the same entries `/changes` shows — the words come
 * from the entries' own summaries and shared/change-view.ts.
 *
 * Filters: account, kind group, 7 / 30 / 90 days, search. Rows by day: time,
 * summary, account, amount; a row opens to why, before → after, and who. One
 * sync run's imports are one row that opens to its transactions. Bookkeeping
 * shows only under Background.
 *
 * R2: an opened row offers Undo or Redo — no confirmation; the result is said
 * under it, and after a sync decision "Takes effect on the next sync." beside
 * Sync now. A category or rule entry says to undo it from Telegram (the add-on
 * cannot reach categories). An undone row is muted, "Undone by you <date>".
 * "Your overrides" at the bottom lists what Undo told the sync not to do, each
 * with Remove.
 *
 * Bank text is rendered as React text, never as markup. No emoji in app copy
 * (src/pages/copy-policy.test.tsx).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Select } from './ui';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log';
import { undoAvailability, UNDO_TAKES_EFFECT, UNDO_UNREACHABLE, type UndoOp } from '../../shared/change-undo';
import type { UndoOutcome } from '../../shared/change-undo-run';
import { overrideRows, type LoadedSyncOverrides, type OverrideRow } from '../../shared/sync-overrides';
import { changeDay } from '../../shared/change-entries';
import { shortDateTime } from '../../shared/telegram';
import {
```

Edit 2 of 9 in `src/components/ChangeLogCard.tsx` — replace:

```tsx
export const CHANGE_LOG_READ_FAILED = 'Could not read the change log — reload the page to try again.';
export const CHANGE_LOG_EMPTY = 'Nothing recorded yet. Changes show here after the next sync.';
export const CHANGE_LOG_NO_MATCH = 'Nothing matches these filters.';
const DAY_CHOICES = [7, 30, 90] as const;
type Days = (typeof DAY_CHOICES)[number];
type GroupFilter = 'all' | ChangeGroup;
```

with:

```tsx
export const CHANGE_LOG_READ_FAILED = 'Could not read the change log — reload the page to try again.';
export const CHANGE_LOG_EMPTY = 'Nothing recorded yet. Changes show here after the next sync.';
export const CHANGE_LOG_NO_MATCH = 'Nothing matches these filters.';
export const OVERRIDES_TITLE = 'Your overrides';
export const OVERRIDES_EMPTY = 'None. The sync decides everything.';
export const OVERRIDES_UNREADABLE = "Your sync overrides can't be read, so they can't be changed here.";
export const OVERRIDES_READ_FAILED = 'Could not read your overrides — reload the page to try again.';
export const OVERRIDE_REMOVED = 'Removed. The next sync decides again.';
const DAY_CHOICES = [7, 30, 90] as const;
type Days = (typeof DAY_CHOICES)[number];
type GroupFilter = 'all' | ChangeGroup;
```

Edit 3 of 9 in `src/components/ChangeLogCard.tsx` — replace:

```tsx
  /** `store.getChangeLog` — null when the read failed. */
  load: () => Promise<ChangeLogRead | null>;
  now?: () => Date;
}

/** The entries the filters let through, newest first. */
```

with:

```tsx
  /** `store.getChangeLog` — null when the read failed. */
  load: () => Promise<ChangeLogRead | null>;
  now?: () => Date;
  /** R2: undo or redo one entry (`undoFromApp`). Absent: read-only. */
  undo?: (entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp) => Promise<UndoOutcome>;
  /** The companion's published version: null when none runs. */
  companionVersion?: string | null;
  /** Sync now, the Sync page's own run; resolves the sentence to show. */
  onSyncNow?: () => Promise<string>;
  /** "Your overrides": `store.readSyncOverrides` (null when the read failed). */
  loadOverrides?: () => Promise<LoadedSyncOverrides | null>;
  removeOverride?: (row: OverrideRow) => Promise<void>;
}

/** What the card can do with a row, from the card's props. */
interface RowActions {
  undo?: ChangeLogCardProps['undo'];
  companionVersion: string | null;
  entries: ChangeLogItem[];
  onSyncNow?: () => Promise<string>;
  /** After an undo: re-read the log and the overrides. */
  changed: () => void;
}

/** The entries the filters let through, newest first. */
```

Edit 4 of 9 in `src/components/ChangeLogCard.tsx` — replace:

```tsx
  });
}

function EntryDetail({ entry }: { entry: ChangeLogItem }) {
  const beforeAfter = changeBeforeAfter(entry);
  return (
    <div className="sfin-log-detail">
      {entry.why && <div>Why: {entry.why}</div>}
      {beforeAfter && <div>Before → after: {beforeAfter}</div>}
      <div className="sfin-subtle">{changeSourceText(entry)} · {shortDateTime(entry.at)}</div>
      {entry.undone && <div className="sfin-subtle">Undone {shortDateTime(entry.undone.at)}</div>}
    </div>
  );
}

function Row({ row }: { row: ChangeRow }) {
  const [open, setOpen] = useState(false);
  const entry = row.kind === 'entry' ? row.entry : null;
  return (
```

with:

```tsx
  });
}

/** The Undo/Redo line under an opened row (R2). */
function UndoControls({ entry, actions }: { entry: ChangeLogItem; actions: RowActions }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UndoOutcome | null>(null);
  const [synced, setSynced] = useState<string | null>(null);
  if (!actions.undo) return null;
  const available = undoAvailability(entry, { host: 'addon', companionVersion: actions.companionVersion });
  if (available.kind === 'none' && !result) return null;
  const run = async (op: UndoOp) => {
    setBusy(true);
    setSynced(null);
    try {
      setResult(await actions.undo!(entry, actions.entries, op));
    } catch {
      setResult({ ok: false, message: UNDO_UNREACHABLE });
    } finally {
      setBusy(false);
      actions.changed();
    }
  };
  const syncNow = async () => {
    if (!actions.onSyncNow) return;
    setBusy(true);
    try {
      setSynced(await actions.onSyncNow());
    } catch (e: any) {
      setSynced(`The sync failed: ${String(e?.message ?? e)}`);
    } finally {
      setBusy(false);
      actions.changed();
    }
  };
  return (
    <div className="sfin-log-undo">
      {available.kind === 'ready' && (
        <Button variant="ghost" disabled={busy} onClick={() => run(available.op)}>
          {available.op === 'undo' ? 'Undo' : 'Redo'}
        </Button>
      )}
      {available.kind === 'update-companion' && (
        <>
          <Button variant="ghost" disabled>Undo</Button>
          <span className="sfin-subtle">{available.text}</span>
        </>
      )}
      {available.kind === 'telegram' && <span className="sfin-subtle">{available.text}</span>}
      {result && <div className={result.ok ? 'sfin-log-result' : 'sfin-log-result sfin-log-result--refused'}>{result.message}</div>}
      {result?.ok && result.needsSync && (
        <div className="sfin-log-result">
          {UNDO_TAKES_EFFECT}{' '}
          {actions.onSyncNow && <Button variant="ghost" disabled={busy} onClick={syncNow}>Sync now</Button>}
        </div>
      )}
      {synced && <div className="sfin-subtle">{synced}</div>}
    </div>
  );
}

function EntryDetail({ entry, actions }: { entry: ChangeLogItem; actions: RowActions }) {
  const beforeAfter = changeBeforeAfter(entry);
  return (
    <div className="sfin-log-detail">
      {entry.why && <div>Why: {entry.why}</div>}
      {beforeAfter && <div>Before → after: {beforeAfter}</div>}
      <div className="sfin-subtle">{changeSourceText(entry)} · {shortDateTime(entry.at)}</div>
      {entry.undone && <div className="sfin-subtle">Undone by you {shortDateTime(entry.undone.at)}</div>}
      <UndoControls entry={entry} actions={actions} />
    </div>
  );
}

function Row({ row, actions }: { row: ChangeRow; actions: RowActions }) {
  const [open, setOpen] = useState(false);
  const entry = row.kind === 'entry' ? row.entry : null;
  return (
```

Edit 5 of 9 in `src/components/ChangeLogCard.tsx` — replace:

```tsx
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sfin-log-time">{changeClock(changeRowAt(row))}</span>
        <span className="sfin-log-summary">{changeRowSummary(row)}{entry?.undone ? ' (undone)' : ''}</span>
        <span className="sfin-log-account">{entry ? changeAccountText(entry) : ''}</span>
        <span className="sfin-log-amount">{entry ? changeAmountText(entry) : ''}</span>
      </button>
      {open && entry && <EntryDetail entry={entry} />}
      {open && row.kind === 'run' && (
        <div className="sfin-log-detail">
          {row.entries.map((e) => (
```

with:

```tsx
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sfin-log-time">{changeClock(changeRowAt(row))}</span>
        <span className="sfin-log-summary">
          {changeRowSummary(row)}
          {entry?.undone && <span className="sfin-log-undone"> · Undone by you {changeDay(changeLocalDay(entry.undone.at))}</span>}
        </span>
        <span className="sfin-log-account">{entry ? changeAccountText(entry) : ''}</span>
        <span className="sfin-log-amount">{entry ? changeAmountText(entry) : ''}</span>
      </button>
      {open && entry && <EntryDetail entry={entry} actions={actions} />}
      {open && row.kind === 'run' && (
        <div className="sfin-log-detail">
          {row.entries.map((e) => (
```

Edit 6 of 9 in `src/components/ChangeLogCard.tsx` — replace:

```tsx
  );
}

export function ChangeLogCard({ load, now = () => new Date() }: ChangeLogCardProps) {
  const [read, setRead] = useState<ChangeLogRead | null | 'loading'>('loading');
  const [account, setAccount] = useState('');
  const [group, setGroup] = useState<GroupFilter>('all');
  const [days, setDays] = useState<Days>(30);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let live = true;
    load().then((r) => { if (live) setRead(r); }).catch(() => { if (live) setRead(null); });
    return () => { live = false; };
  }, [load]);

  const at = now();
  const entries = read && read !== 'loading' ? read.entries : [];
```

with:

```tsx
  );
}

/** "Your overrides": what Undo told the sync not to do, each with Remove. */
function OverridesList({ load, remove, version }: {
  load: () => Promise<LoadedSyncOverrides | null>;
  remove?: (row: OverrideRow) => Promise<void>;
  version: number;
}) {
  const [doc, setDoc] = useState<LoadedSyncOverrides | null | 'loading'>('loading');
  const [note, setNote] = useState<string | null>(null);
  const [mine, setMine] = useState(0);
  useEffect(() => {
    let live = true;
    load().then((d) => { if (live) setDoc(d); }).catch(() => { if (live) setDoc(null); });
    return () => { live = false; };
  }, [load, version, mine]);
  if (doc === 'loading') return null;
  const rows = doc ? overrideRows(doc.overrides) : [];
  const onRemove = async (row: OverrideRow) => {
    try {
      await remove!(row);
      setNote(OVERRIDE_REMOVED);
    } catch (e: any) {
      setNote(String(e?.message ?? e));
    }
    setMine((n) => n + 1);
  };
  return (
    <div className="sfin-log-overrides">
      <div className="sfin-log-overrides-title">{OVERRIDES_TITLE}</div>
      {doc === null ? (
        <div className="sfin-subtle">{OVERRIDES_READ_FAILED}</div>
      ) : doc.unreadable ? (
        <div className="sfin-log-note">{OVERRIDES_UNREADABLE}</div>
      ) : rows.length === 0 ? (
        <div className="sfin-subtle">{OVERRIDES_EMPTY}</div>
      ) : (
        rows.map((r) => (
          <div key={`${r.scope}:${r.key}:${r.flag}`} className="sfin-log-override">
            <span className="sfin-log-summary">{r.text}</span>
            {remove && <Button variant="ghost" onClick={() => onRemove(r)}>Remove</Button>}
          </div>
        ))
      )}
      {note && <div className="sfin-subtle">{note}</div>}
    </div>
  );
}

export function ChangeLogCard({
  load, now = () => new Date(), undo, companionVersion = null, onSyncNow, loadOverrides, removeOverride,
}: ChangeLogCardProps) {
  const [read, setRead] = useState<ChangeLogRead | null | 'loading'>('loading');
  const [account, setAccount] = useState('');
  const [group, setGroup] = useState<GroupFilter>('all');
  const [days, setDays] = useState<Days>(30);
  const [query, setQuery] = useState('');
  // Bumped after an undo, a redo or a sync: the log and the overrides re-read.
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let live = true;
    load().then((r) => { if (live) setRead(r); }).catch(() => { if (live) setRead(null); });
    return () => { live = false; };
  }, [load, version]);

  const at = now();
  const entries = read && read !== 'loading' ? read.entries : [];
```

Edit 7 of 9 in `src/components/ChangeLogCard.tsx` — replace:

```tsx

  if (read === 'loading') return <div className="sfin-subtle">Loading…</div>;
  if (read === null) return <div className="sfin-log-note">{CHANGE_LOG_READ_FAILED}</div>;

  const byDay: Array<{ day: string; rows: ChangeRow[] }> = [];
  for (const row of rows) {
```

with:

```tsx

  if (read === 'loading') return <div className="sfin-subtle">Loading…</div>;
  if (read === null) return <div className="sfin-log-note">{CHANGE_LOG_READ_FAILED}</div>;
  const actions: RowActions = { undo, companionVersion, entries, onSyncNow, changed };

  const byDay: Array<{ day: string; rows: ChangeRow[] }> = [];
  for (const row of rows) {
```

Edit 8 of 9 in `src/components/ChangeLogCard.tsx` — replace:

```tsx
          <div key={day} className="sfin-log-group">
            <div className="sfin-log-day">{changeDay(day)}</div>
            {dayRows.map((row) => (
              <Row key={row.kind === 'entry' ? row.entry.id : `run:${row.run}`} row={row} />
            ))}
          </div>
        ))
```

with:

```tsx
          <div key={day} className="sfin-log-group">
            <div className="sfin-log-day">{changeDay(day)}</div>
            {dayRows.map((row) => (
              <Row key={row.kind === 'entry' ? row.entry.id : `run:${row.run}`} row={row} actions={actions} />
            ))}
          </div>
        ))
```

Edit 9 of 9 in `src/components/ChangeLogCard.tsx` — replace:

```tsx
          {hiddenBackground} background {hiddenBackground === 1 ? 'change' : 'changes'} not shown — Background lists {hiddenBackground === 1 ? 'it' : 'them'}.
        </div>
      )}
    </div>
  );
}
```

with:

```tsx
          {hiddenBackground} background {hiddenBackground === 1 ? 'change' : 'changes'} not shown — Background lists {hiddenBackground === 1 ? 'it' : 'them'}.
        </div>
      )}
      {loadOverrides && <OverridesList load={loadOverrides} remove={removeOverride} version={version} />}
    </div>
  );
}
```

**Edit `src/components/ui.tsx`** — one edit: the new `.sfin-log-*` rules after `.sfin-log-hidden`.

Edit 1 of 1 in `src/components/ui.tsx` — replace:

```tsx
.sfin-log-amount { white-space: nowrap; font-variant-numeric: tabular-nums; }
.sfin-log-detail { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 8px; padding: 6px 0 6px 12px; border-left: 2px solid var(--border); font-size: var(--sfin-sz-sm); }
.sfin-log-hidden { margin-top: 8px; }
@media (max-width: 560px) {
  .sfin-log-row { grid-template-columns: 3.2em minmax(0, 1fr); }
  .sfin-log-run-line { grid-template-columns: 3.2em minmax(0, 1fr); }
```

with:

```tsx
.sfin-log-amount { white-space: nowrap; font-variant-numeric: tabular-nums; }
.sfin-log-detail { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 8px; padding: 6px 0 6px 12px; border-left: 2px solid var(--border); font-size: var(--sfin-sz-sm); }
.sfin-log-hidden { margin-top: 8px; }
.sfin-log-undone { color: var(--muted-foreground); font-size: var(--sfin-sz-xs); }
.sfin-log-undo { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.sfin-log-result { flex-basis: 100%; }
.sfin-log-result--refused { color: var(--sfin-warn); }
.sfin-log-overrides { margin-top: 14px; padding-top: 8px; border-top: 1px solid var(--border); }
.sfin-log-overrides-title { font-size: var(--sfin-sz-xs); letter-spacing: .06em; text-transform: uppercase; color: var(--muted-foreground); margin-bottom: 4px; }
.sfin-log-override { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 2px 0; }
@media (max-width: 560px) {
  .sfin-log-row { grid-template-columns: 3.2em minmax(0, 1fr); }
  .sfin-log-run-line { grid-template-columns: 3.2em minmax(0, 1fr); }
```

**Edit `src/tabs/SettingsTab.tsx`** — four edits: imports; the companion version, `undoChange`, `syncNowForLog`, `loadOverrides` and `removeOverride` beside `loadChangeLog` (optional-called where a test double may lack the method); the card's comment; the card's props.

Edit 1 of 4 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
import type { MappingRule, SimplefinAccount, AccountMapping } from '../../shared/types';
import { accountCreatedChange } from '../../shared/change-entries';
import { ChangeLogCard } from '../components/ChangeLogCard';

/** Ids for this tab's collapsible cards. Doubles as the persisted key set (the
 *  page owns the open-card map), so these strings must not change — a rename
```

with:

```tsx
import type { MappingRule, SimplefinAccount, AccountMapping } from '../../shared/types';
import { accountCreatedChange } from '../../shared/change-entries';
import { ChangeLogCard } from '../components/ChangeLogCard';
import { emptySyncOverrides, removeOverrideRow, type OverrideRow } from '../../shared/sync-overrides';
import type { ChangeLogItem } from '../../shared/change-log';
import type { UndoOp } from '../../shared/change-undo';
import { undoFromApp } from '../utils/change-undo';

/** Ids for this tab's collapsible cards. Doubles as the persisted key set (the
 *  page owns the open-card map), so these strings must not change — a rename
```

Edit 2 of 4 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
    async () => (store.getChangeLog ? store.getChangeLog() : { entries: [], gaps: [], trimmed: 0, unreadable: [] }),
    [store],
  );

  const handleReset = useCallback(async () => {
    scheduler.stop();
```

with:

```tsx
    async () => (store.getChangeLog ? store.getChangeLog() : { entries: [], gaps: [], trimmed: 0, unreadable: [] }),
    [store],
  );
  // R2: Undo and Redo, the companion's version (the gate and the Telegram
  // pointer), Sync now (the Sync page's own forced run) and "Your overrides".
  const [companionVersion, setCompanionVersion] = useState<string | null>(null);
  useEffect(() => {
    store.getCompanionVersion?.().then((v) => setCompanionVersion(v ?? null)).catch(() => {});
  }, [store]);
  const undoChange = useCallback(
    (entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp) => undoFromApp(ctx, store, entry, entries, op),
    [ctx, store],
  );
  const syncNowForLog = useCallback(async () => {
    const r = await runSync(ctx, store, { force: true });
    return r.errors.length ? `Synced, with a problem: ${r.errors[0]}` : `Synced — ${r.imported} imported.`;
  }, [ctx, store]);
  const loadOverrides = useCallback(
    async () => (store.readSyncOverrides ? store.readSyncOverrides() : { overrides: emptySyncOverrides(), unreadable: false }),
    [store],
  );
  const removeOverride = useCallback(async (row: OverrideRow) => {
    await store.editSyncOverrides((o) => removeOverrideRow(o, row));
  }, [store]);

  const handleReset = useCallback(async () => {
    scheduler.stop();
```

Edit 3 of 4 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
        </div>
      </CollapsibleCard>

      {/* Read-only in this release: every change the sync and you made, the
          same entries /changes shows. Loads when opened. */}
      <CollapsibleCard
        id={CARD.changeLog}
        title="Change log"
```

with:

```tsx
        </div>
      </CollapsibleCard>

      {/* Every change the sync and you made, the same entries /changes shows,
          with Undo and Redo. Loads when opened. */}
      <CollapsibleCard
        id={CARD.changeLog}
        title="Change log"
```

Edit 4 of 4 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
        open={isOpen(CARD.changeLog)}
        onToggle={() => toggleCard(CARD.changeLog)}
      >
        <ChangeLogCard load={loadChangeLog} />
      </CollapsibleCard>

      <h3 className="sfin-settings-group">Categorizing</h3>
```

with:

```tsx
        open={isOpen(CARD.changeLog)}
        onToggle={() => toggleCard(CARD.changeLog)}
      >
        <ChangeLogCard
          load={loadChangeLog}
          undo={undoChange}
          companionVersion={companionVersion}
          onSyncNow={syncNowForLog}
          loadOverrides={loadOverrides}
          removeOverride={removeOverride}
        />
      </CollapsibleCard>

      <h3 className="sfin-settings-group">Categorizing</h3>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/ChangeLogCard-undo.test.tsx src/components/ChangeLogCard.test.tsx src/components/theme-styles.test.ts src/tabs/SettingsTab.test.tsx src/pages/copy-policy.test.tsx`
Expected: PASS — 56 tests.

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/ChangeLogCard.tsx src/components/ui.tsx src/tabs/SettingsTab.tsx src/components/ChangeLogCard.test.tsx src/components/ChangeLogCard-undo.test.tsx
git commit -m "App: Undo and Redo on the Change log card, Sync now, and Your overrides

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs, follow-ups, every gate

CHANGELOG (under `[Unreleased]`: R1's "Read-only for now" goes; Undo and Redo, and an upgrade-order note for the gate), README (the `/changes` line and the Change log bullet), and follow-ups §9 (what this release deliberately leaves, and §8's R2 notes settled). No code.

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `docs/superpowers/follow-ups.md`

**Interfaces:**
- Consumes: the copy and behaviour of Tasks 1–9 (`SYNC_OVERRIDES_SINCE = '1.61.0'`, "Update the companion first", `↩ Undo` / `Redo` / `↩ Undo rule + un-file N` / Sync now, "Your overrides").
- Produces: documentation only.

- [ ] **Step 1: Write the docs**

**Edit `CHANGELOG.md`** — two edits.

Edit 1 of 2 in `CHANGELOG.md` — replace:

```markdown
  rules you created; accounts you created. `/changes` in Telegram lists the
  last 7 days (`/changes venmo` searches the last 90 days; background
  bookkeeping is never matched), and **Settings → Change log** in the app shows
  the last 90 days (30 by default) with filters. Read-only for now — Undo comes
  in the next release. Recording can never fail or alter a sync or something
  you did. When a change could not be saved to the log, a note says so ("3
  changes may be missing"); the add-on keeps such gaps only in that tab's
  memory until the next successful save.
- **The bot asks instead of making you remember argument order.** Send
  `/newrule` or `/afford` on its own, or tap **Set a new pool** under `/pool`,
  and it asks one question at a time — buttons where there is a choice, and
```

with:

```markdown
  rules you created; accounts you created. `/changes` in Telegram lists the
  last 7 days (`/changes venmo` searches the last 90 days; background
  bookkeeping is never matched), and **Settings → Change log** in the app shows
  the last 90 days (30 by default) with filters. Recording can never fail or
  alter a sync or something you did. When a change could not be saved to the
  log, a note says so ("3 changes may be missing"); the add-on keeps such gaps
  only in that tab's memory until the next successful save.
- **Undo and Redo in the change log.** Every automatic decision and every
  filing you made can be undone from its entry — in `/changes` (`↩ Undo`,
  `Redo`) or on the app card (Undo, Redo) — with no "are you sure?". The
  result is said right there. Undoing a decision the sync makes (a transfer
  link or a transfer held in transit, a removed duplicate, an automatic
  balance correction, an import, an Amazon label) also tells the sync not to
  make it again: an undone transfer link is unlinked on the next sync and each
  half counts as spending or money in, an undone import is removed and never
  imported again. Those take effect on the next sync, and both surfaces offer
  **Sync now**. Filings, rules and starting balances are reversed at once. A
  rule you created offers `↩ Undo rule` or `↩ Undo rule + un-file N` (the N
  charges it filed go back to the needs-a-category list). Nothing is undone
  over a change made since: "It has changed since — nothing was undone."
  **Your overrides**, at the bottom of the app card, lists what the sync now
  leaves alone; Remove lets it decide again. Category and rule entries are
  undone from Telegram (the add-on cannot reach categories); the app says so.
- **The bot asks instead of making you remember argument order.** Send
  `/newrule` or `/afford` on its own, or tap **Set a new pool** under `/pool`,
  and it asks one question at a time — buttons where there is a choice, and
```

Edit 2 of 2 in `CHANGELOG.md` — replace:

```markdown
  that — nothing was changed."); in the app, nothing changes. A document that
  is already unreadable is never overwritten: the app card turns read-only
  with a notice.
- **Upgrade order:** update the addon (upload the zip and reload the tab)
  before using `/subscriptions` from Telegram. Hides made in a not-yet-updated
  addon after the companion has created the new document are not carried over.
```

with:

```markdown
  that — nothing was changed."); in the app, nothing changes. A document that
  is already unreadable is never overwritten: the app card turns read-only
  with a notice.
- **Upgrade order (Undo):** update the companion before undoing a sync
  decision in the app — until a companion that obeys overrides is running,
  those Undo buttons stay off with "Update the companion first". Undo from
  Telegram needs nothing more.
- **Upgrade order:** update the addon (upload the zip and reload the tab)
  before using `/subscriptions` from Telegram. Hides made in a not-yet-updated
  addon after the companion has created the new document are not carried over.
```

**Edit `README.md`** — one edit.

Edit 1 of 1 in `README.md` — replace:

```markdown
  `/subscriptions` lists your subscriptions and bills — set a reminder before
  a charge, rename one, hide one you cancelled, or add an annual plan by hand —
  and the daily report's "Coming up" lines say what charges soon. In a group chat, answer a question by
  replying to it. `/changes` lists what changed in the last 7 days, and
  `/changes venmo` searches it.
- **Change log** — every change the sync, the companion and you made, the last
  90 days, under **Settings → Change log**: imports, bank updates, transfer
  links, removed duplicates, starting balances, corrections, filings and rules,
  each with why and, where there is one, what it was before. Read-only in this
  release.
- **Amazon categorization** (optional) — reads Amazon's order emails from a
  throwaway mailbox and files each `AMAZON.COM*…` charge under what you bought.
- **Rules** — map a description pattern to a category or activity type when a
```

with:

```markdown
  `/subscriptions` lists your subscriptions and bills — set a reminder before
  a charge, rename one, hide one you cancelled, or add an annual plan by hand —
  and the daily report's "Coming up" lines say what charges soon. In a group chat, answer a question by
  replying to it. `/changes` lists what changed in the last 7 days, each with
  Undo or Redo, and `/changes venmo` searches it.
- **Change log** — every change the sync, the companion and you made, the last
  90 days, under **Settings → Change log**: imports, bank updates, transfer
  links, removed duplicates, starting balances, corrections, filings and rules,
  each with why and, where there is one, what it was before. Undo or Redo any
  of it from the entry — no confirmation. Undoing something the sync decided
  also tells the sync not to decide it again (the card's **Your overrides**
  lists those, each with Remove), and takes effect on the next sync — Sync now
  is right there. Category and rule changes are undone from Telegram's
  `/changes`.
- **Amazon categorization** (optional) — reads Amazon's order emails from a
  throwaway mailbox and files each `AMAZON.COM*…` charge under what you bought.
- **Rules** — map a description pattern to a category or activity type when a
```

**Edit `docs/superpowers/follow-ups.md`** — two edits: the revision line; section 9 before the name-mismatch reference.

Edit 1 of 2 in `docs/superpowers/follow-ups.md` — replace:

```markdown
to act on them later. Each says why it was deferred, so a future reader can
tell "decided against" from "not got to yet".

Last updated: 2026-10-12, after the subscriptions & bills plan (new section 7).
Previous revision: 2026-07-30, after fixing the shared-transaction-id collision
(former item 1, now under "Fixed"; former items 2-6 are now 1-5). Previous
revision: 2026-07-29, after fixing the duplicate-transaction import
(then-new item 1, which pushed former items 1-5 down to 2-6, plus three new
```

with:

```markdown
to act on them later. Each says why it was deferred, so a future reader can
tell "decided against" from "not got to yet".

Last updated: 2026-10-13, after the change log Undo plan (new section 9).
Previous revision: 2026-10-12, after the subscriptions & bills plan (new
section 7). Previous revision: 2026-07-30, after fixing the shared-transaction-id collision
(former item 1, now under "Fixed"; former items 2-6 are now 1-5). Previous
revision: 2026-07-29, after fixing the duplicate-transaction import
(then-new item 1, which pushed former items 1-5 down to 2-6, plus three new
```

Edit 2 of 2 in `docs/superpowers/follow-ups.md` — replace:

```markdown
- **The read-back of a new starting balance or plug costs one activity read**,
  only when a change log is attached and only on the rare run that writes one.

## Reference: name mismatches between the database, the REST API, and the SDK

Every one of these cost a diagnostic cycle against the live instance on
```

with:

```markdown
- **The read-back of a new starting balance or plug costs one activity read**,
  only when a change log is attached and only on the rare run that writes one.

## 9. Change log — Undo (2026-10-13, plan `2026-10-13-change-log-undo.md`)

- **`SYNC_OVERRIDES_SINCE` is `1.61.0`** (shared/version.ts) — the release
  after R1's. If Undo ships in the SAME release as R1, lower it to that
  version at release time; `shared/change-undo.test.ts` fails a release that
  ships BELOW it, but cannot catch one shipped above it.
- **A held transfer's Undo waits for the leg to be in a sync's window.** The
  sync applies `notTransfer` to a feed transaction (14-day routine overlap,
  44/89 days on a re-scan). A placeholder held past that by a dead feed stays
  a placeholder until a re-scan reaches it. A linked pair is different: it is
  unlinked from the stored rows, in or out of the feed.
- **A linked leg whose other half is not in view stays linked** and the sync
  says so ("its other half is not in this sync"): deleting one leg of a pair
  deletes both, and the unseen half could not be re-created. Reached when the
  partner's account is unmapped or the row is past the 500-row read.
- **Undoing an automatic starting-balance MOVE** restores the amount and the
  date, but the next sync moves the DATE back in front of older rows (it moves
  no money); the restored amount stays. No override exists for the date.
- **Undoing a removed duplicate is almost always refused** as an exact copy —
  the prune removes copies, and copies share a fingerprint. Working as the
  spec says ("nothing changes and the entry says why"); the override is taken
  back out.
- **An automatic balance correction's Undo sets `noAutoCorrect`; your own
  Add adjustment's does not** (you added it; auto-correction may be off).
- **A redone category rule comes back at priority 50**, as `/categorize`
  creates it, even if it had been edited in Wealthfolio since.
- **The Rules card writes `mapping_rules` from its own snapshot** (pre-existing
  whole-list write). Undoing a transaction rule while that card is open and
  then saving the card puts the rule back. Same race the card already has with
  the transfer-learning menu.
- **On the add-on, "is it linked?" is the `linked_groups` ledger.** A ledger
  that lost a pair lets a `notTransfer` leg be retyped by an ordinary update,
  which Wealthfolio copies onto its partner. Not seen; the companion reads
  groups off the rows.
- **Telegram lists no overrides** — only the app card does (spec B3).
- **Section 8's R2 notes are settled:** the DELETE rule client exists
  (`deleteCategorizationRule`), a rule without an id is found by name, an
  Amazon filing without a tx key has it re-derived from the row's note and the
  account mapping (refused when that fails).

## Reference: name mismatches between the database, the REST API, and the SDK

Every one of these cost a diagnostic cycle against the live instance on
```

- [ ] **Step 2: Run every gate**

Run: `npm test`
Expected: PASS — 2131 tests.

Run: `npm --prefix companion test`
Expected: PASS — 924 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md README.md docs/superpowers/follow-ups.md
git commit -m "Change log Undo: docs and follow-ups

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
