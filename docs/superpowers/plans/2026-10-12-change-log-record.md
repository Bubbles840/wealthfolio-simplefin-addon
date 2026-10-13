# Change log — Record (R1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every write the add-on, the companion and the person make to the books is recorded as one change entry — with what R2's Undo will need to reverse it — and shown read-only in Telegram (`/changes`) and in the app (Settings → Change log).

**Architecture:** `shared/change-entries.ts` owns the entry type, the ids and ONE builder per kind that also writes the plain-English summary. `shared/change-log.ts` owns storage — one bucket per writer per month in add-on secrets, the `.2` fallback for a corrupt bucket, the 200 KB cap, gaps, retention — plus the per-process writer (a promise queue that never rejects) and the merged reader. `shared/change-view.ts` holds what both surfaces show (groups, search, run rows, notes, before → after). `runSyncCore` takes an optional `changeLog` sink, collects an entry for every write that succeeded and appends them once at the end, best-effort. The add-on wires the sink through `SecretsStore`; the companion through `companion/src/change-log-host.ts`, which also stamps the after-sync filings with the sync's run and the Telegram actions with `actor: 'you'`. `/changes` is the stateless `cz:cl:` menu in `companion/src/changes-menu.ts`; the app card is `src/components/ChangeLogCard.tsx`.

**Tech Stack:** TypeScript, React (add-on), vitest (root project: jsdom, `src/` + `shared/`; companion project: node, `companion/src/`), Telegram Bot API (legacy `Markdown` parse mode), Wealthfolio REST (companion) and add-on SDK (add-on).

**Spec:** `docs/superpowers/specs/2026-10-12-change-log-and-undo-design.md` — Part A. Part B (Undo, R2) is a later plan; nothing here may block it. Binding rulings P1–P14 are folded into the tasks below.

**Verified facts this plan builds on (P5):**
- **The rule id IS returned.** Upstream `apps/server/src/api/spending.rs` `create_categorization_rule` returns `Json<CategorizationRule>` (`#[serde(rename_all = "camelCase")]`, `pub id: String`, `crates/spending/src/categorization_rules/model.rs`). Today `companion/src/wealthfolio.ts` `createCategorizationRule` discards the body (`Promise<void>`); Task 8 makes it resolve `id` (null when a reply carries none, so R2 can fall back to a lookup by name via `GET /api/v1/spending/rules`).
- **A DELETE rule endpoint exists upstream but nothing in this codebase uses it.** Routes `/spending/rules/{id}` → `put(update_categorization_rule).delete(delete_categorization_rule)` (spending.rs). The only `DELETE` the companion sends is `unassignActivityCategory`. R2 needs a new client method; recorded in follow-ups (Task 11).
- `importActivities` (starting balances, plugs) reports no ids: the core reads the new row back by its note (`rowIdByComment`), only when a sink is attached. `linkPairByRecreate` re-creates both legs; Task 5 makes it report the new ids from the save echo.

**Deviations from the spec (decided, do not "fix"):**
- **Kinds are the spec's sixteen, with these meanings refined to the code (P4):** `transfer-type` covers a leg held as a transfer in transit (undoable: R2 sets `notTransfer` on that leg) AND a placeholder that ran out of time and became ordinary money (not undoable — no "it is a transfer after all" override exists). A new row held in transit records TWO entries: its `import` and its `transfer-type`. `starting-balance-moved` covers the sync's netting/date move AND the person accepting the baseline fix (`actor: 'you'`). `category-filed` covers a first filing, a move (`/recategorize`), taking a category off (the `/categorize` ↩ Undo) and the Undo of a move. `bank-update` includes a rule adding a subtype (`marked REIMBURSEMENT`) and a pending row posting under a new tx id. `bookkeeping` carries `after.step`: `legacy-placeholder`, `external-marker`, `transfer-relink`, `opening-category` (the companion creating/excluding the "Opening balances" category).
- **The sink carries the writer and the run (P2/P3):** `changeLog?: ChangeLogSink` with `{ writer, run, append }`. Each host mints the run id (`newRunId`) so the companion's after-sync filings share the sync's run.
- **Lines read `HH:MM · <summary> · <amount> · <account>`** in Telegram; the app shows the same pieces as columns. The summary itself carries no amount or account, so neither surface repeats it.
- **Search covers the whole readable log (90 days), not just the 7-day list**, and skips bookkeeping; a search rides inside every button, cut to 30 UTF-8 bytes at a whole character.
- **The app card defaults to 30 days**; "All" hides bookkeeping and says how many it hid ("Background" lists them).
- **"First append of a month" is per writer process:** the in-memory writer clears its own four-months-back bucket (and its `.2`) on its first append each month after it starts. Clearing is idempotent, so a restart clearing again costs one write.
- **The transfer-learning menu's own ↩ Undo (removing the rule it wrote seconds earlier) is not logged**; the rule's creation is. Dismissals stay out (spec: own undo, no ledger data).
- **Reset's copy now names the change log** (it is cleared with everything else).

**Task order:** the three pure modules first (entries → storage → reader/view), then the sync core in two tasks (reconcile and its own repairs; then balances, links and the host return values), then the two hosts (add-on, then companion sync and after-sync filings, then companion user actions), then the two surfaces (Telegram, app), then docs and every gate.

## Global Constraints

- **Entry shape and kinds are spec A1 verbatim** (`ChangeEntry`, `ChangeKind`, `reverses` reserved for R2). Every entry is built by one builder in `shared/change-entries.ts`; no other code assembles an entry or writes a summary. Summaries hold RAW bank/user text.
- **Ids (verbatim):** run id `<a|c><base36 ms>` (`newRunId`); entry id `<a|c><base36 ms><base36 counter>` (`newEntryId`, process-wide counter); `a` = add-on, `c` = companion.
- **Keys (verbatim):** `change_log:<writer>:<YYYY-MM>` (UTC month of the entry's `at`), fallback `change_log:<writer>:<YYYY-MM>.2`; writers `addon` and `companion`. A writer only ever writes its own keys.
- **Limits (verbatim):** cap `200_000` UTF-8 bytes per bucket (`TextEncoder`), bookkeeping trimmed first (oldest first), then the oldest entries, counted in `trimmed`; readers read this month and the 3 before it and drop entries older than 90 days; a writer clears its own bucket (and `.2`) 4 months back on its first append of a month; Reset deletes both writers' keys and `.2` for this month and the 4 before it (20 keys); at most 50 gap records per bucket.
- **Corrupt is not absent.** `parseChangeBucket` returns `ok | absent | corrupt`; `''` (the companion's "cleared") is absent. A corrupt bucket is never written: append goes to `.2`; both corrupt → `ChangeLogPausedError`, recorded as a gap.
- **The log never costs the work.** `createChangeLogWriter().append` never rejects (a failure becomes a gap written on the next success). `runSyncCore` appends ONCE at the end inside try/catch; an entry exists only for a write that succeeded (a refused create, a failed update or delete records nothing). Telegram/app recorders swallow and log their own failures.
- **One writer per process (P8):** the add-on's `SecretsStore` owns one `createChangeLogWriter({ writer: 'addon' })`; the companion's `companionChangeLog` in `companion/src/change-log-host.ts` is the only companion writer. Both serialise appends through the writer's queue.
- **Telegram:** legacy `Markdown`. Bank and user text goes through `escapeMarkdown` AND stays outside every `*…*`/`_…_` entity (only the fixed title and the `_Oct 12_` day headings are entities). Prefix `cz:cl:`, routed in `onMenuCallback` before the categorize fallthrough; every `callback_data` ≤ 64 bytes; handles are `findingHandle` (8 hex) of the entry id, or of `run:<runId>` for a run row. Vanished entry → `That one is already sorted — refreshing.`; unreachable → `Couldn't reach Wealthfolio — try again.` List: 7 days, 8 rows a page, `‹ Older` / `Newer ›`, background behind `Show N background changes`.
- **App:** no emoji in chrome (`src/pages/copy-policy.test.tsx`); new CSS classes are `.sfin-log-*`, each column-0 selector defined once (`src/components/theme-styles.test.ts`); the card reads through `store.getChangeLog` (optional-called) and renders bank text as React text.
- **Tests use a fixed `now`.** Shared/app tests: `vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(...)` and `vi.useRealTimers()` after. Anything that renders a clock or a day builds its moments with the local `new Date(2026, 9, 12, h, m)` constructor so it holds in any TZ. Sync-core tests use `shared/fake-host.ts`.
- **Imports:** shared sources import siblings WITH `.js`; `src/` imports shared WITHOUT an extension; companion imports `'../../shared/x.js'` and `'./x.js'`.
- **Gates before calling a task done:** the touched project's tests, plus `npm run type-check` when `src/` or `shared/` changed and `npm --prefix companion run build` when `companion/` or `shared/` changed. Final task: `npm test`, `npm --prefix companion test`, `npm run type-check`, `npm --prefix companion run build`.
- **Edits are exact.** Every "Replace" block below is copied from the file as it stands after the previous tasks and occurs exactly once; replace it verbatim (the Edit tool's `old_string` → `new_string`). Apply a file's numbered edits in order.
- **No version bump, tag or release.** CHANGELOG goes under `[Unreleased]`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **An append that fails during a sync** → the sync's result is exactly what it would have been without a log, the sink is called once, and the writer records the failure as a gap that is written on its next successful append (and shown: "3 changes may be missing — couldn't save the log Oct 12."). Pinned in Task 4 (`a failing append changes nothing about the result`) and Task 2 (`never rejects, remembers a failed append, and writes it as a gap next time`); the note's words in Task 3 (`words gaps, trims and unreadable buckets`).
- **A bank name with Markdown characters in `/changes`** (`SQ *COFFEE_CLUB [2]`, account `Joe's *Visa*`) → escaped, and the only entities in the message are the fixed title and day headings. Pinned in Task 9 (`escapes a bank name with Markdown characters and keeps it out of bold and italics`).
- **Two writers appending in the same minute** → two keys, both entries present, merged newest first. Pinned in Task 2 (`two writers in the same minute write two keys and lose nothing`; `runs appends one after another, so near-simultaneous ones both land`) and Task 3 (`merges both writers newest first, two writes in the same minute both present`); the companion's sync and a tap in Task 7 (`a sync and a tap in the same moment both land`).
- **A bucket crossing 200 KB** → bookkeeping trimmed first, then the oldest entries, the count kept in `trimmed` and shown ("12 older changes were trimmed to keep the log small."). Pinned in Task 2 (`drops bookkeeping first, oldest first, then the oldest entries, and counts them`; `keeps a bucket under the cap as it grows`), Task 3 (`words gaps, trims and unreadable buckets`), Task 9 (`says so when nothing changed, and leads with gaps, trims and unreadable buckets`) and Task 10 (`heads the card with gaps, trims and unreadable buckets`).
- **A corrupt bucket** → never overwritten; appends go to `.2`; readers read both and report it; both corrupt pauses the month and the feed says so. Pinned in Task 2 (`never overwrites a corrupt bucket: it writes the .2 fallback instead`; `pauses when the fallback is corrupt too, writing nothing`; `counts a paused month as an unreadable gap`) and Task 3 (`reports a corrupt bucket, reads its fallback, and says when both are unreadable`).
- **Only successful writes are recorded.** A refused create (Task 4, `records nothing for a create Wealthfolio refused`), a refused filing (Tasks 7 and 8, `records nothing for a filing Wealthfolio refused`) and a refused rule (Task 8, `records nothing for a refused rule`) record nothing.

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/change-entries.ts` (create) | `ChangeEntry` and friends, ids, `stampChange`, money/day words, one builder per kind (summary + before/after). |
| `shared/change-log.ts` (create) | Keys, bucket parse/cap, `appendChanges`, `createChangeLogWriter` (queue, gaps, retention), `changeLogResetKeys`; `readChangeLog` (Task 3). |
| `shared/change-view.ts` (create) | Groups, account/amount/source words, before → after, search, run rows, notes. |
| `shared/sync-core.ts` (modify) | `SyncOptions.changeLog`; `runSyncCore` wrapper; entries at every write point; write helpers report what they wrote. |
| `shared/sync-host.ts`, `shared/link-pair.ts`, `shared/fake-host.ts` (modify) | `LinkResult.activityIds` — the re-created legs' ids. |
| `src/utils/secrets.ts` (modify) | The add-on's writer: `recordChanges`, `recordChange`, `changeLogSink`, `getChangeLog`; `clearAll` clears the log. |
| `src/utils/sync.ts` (modify) | `runSync` passes the sink; Add adjustment and the baseline fix record `actor: 'you'` entries. |
| `src/components/AccountMapper.tsx`, `src/tabs/SettingsTab.tsx`, `src/pages/SetupPage.tsx` (modify) | Account creation recorded. |
| `companion/src/change-log-host.ts` (create) | The companion's one writer, its sink, `recordCompanionChanges`, `readCompanionChangeLog`. |
| `companion/src/index.ts` (modify) | Sync sink; filings recorded with the sync's run; categorize/transfer-learning recorders; `/changes` and its routing. |
| `companion/src/amazon-filing.ts`, `companion/src/opening-balance-category.ts`, `companion/src/sqlite-native.ts` (modify) | Filings record drafts, with the category a rule had given. |
| `companion/src/categorize.ts`, `companion/src/transfer-learning.ts`, `companion/src/wealthfolio.ts` (modify) | Telegram filings, moves, Undos and rules recorded; the rule id kept. |
| `companion/src/changes-menu.ts` (create) | The stateless `cz:cl:` menu: list, search, run, detail. |
| `shared/telegram-commands.ts` (modify) | `/changes` in More commands. |
| `src/components/ChangeLogCard.tsx` (create), `src/components/ui.tsx` (modify) | The app card and its `.sfin-log-*` styles. |
| `CHANGELOG.md`, `README.md`, `docs/superpowers/follow-ups.md` (modify) | Docs and R2 follow-ups. |

---

### Task 1: The change entry

The entry every other task records and every surface shows, built by ONE function per kind. Each builder writes the entry's plain-English `summary` (raw bank text inside) and the `before`/`after` that R2's Undo needs (P1). Pure; no I/O.

**Files:**
- Create: `shared/change-entries.ts`
- Test: `shared/change-entries.test.ts`

**Interfaces:**
- Consumes: `accountTxKey` (`shared/transfers.ts`, tests only).
- Produces (`shared/change-entries.ts`):

```ts
export type ChangeWriter = 'addon' | 'companion';
export type ChangeActor = 'auto' | 'you';
export type ChangeKind =
  | 'import' | 'bank-update' | 'pending-removed' | 'transfer-link' | 'transfer-type' | 'duplicate-removed'
  | 'starting-balance' | 'starting-balance-moved' | 'balance-correction' | 'amazon-label' | 'category-filed'
  | 'opening-balance-filed' | 'category-rule-created' | 'mapping-rule-created' | 'account-created' | 'bookkeeping';
export const CHANGE_KINDS: readonly ChangeKind[];
export interface ChangeAccount { sfinId?: string; wfId?: string; name: string }
export interface ChangeSubject { txKeys?: string[]; activityIds?: string[]; description?: string; amountCents?: number; date?: string; ruleId?: string; rulePattern?: string; categoryName?: string }
export interface ChangeEntry {
  id: string; at: string; writer: ChangeWriter; actor: ChangeActor; run?: string; kind: ChangeKind;
  account?: ChangeAccount; subject: ChangeSubject; summary: string; why?: string;
  before?: Record<string, unknown>; after?: Record<string, unknown>; undoable: boolean;
  reverses?: { id: string; op: 'undo' | 'redo' };
}
export type ChangeDraft = Omit<ChangeEntry, 'id' | 'at' | 'writer' | 'run'>;
export interface ChangeLogSink { writer: ChangeWriter; run: string; append(entries: ChangeEntry[]): Promise<void> }
export function newRunId(writer: ChangeWriter, now: Date): string;
export function newEntryId(writer: ChangeWriter, now: Date): string;
export function stampChange(draft: ChangeDraft, writer: ChangeWriter, now: Date, run?: string): ChangeEntry;
export function changeMoney(cents: number): string;                 // '-$1,234.56'
export function changeDay(iso: string): string;                     // '2026-10-03' → 'Oct 3'
export interface StoredTxState { absCents: number; date: string; pending: boolean; activityType: string; subtype?: string | null }
export function bankUpdateParts(before: StoredTxState, after: StoredTxState): string[];
export interface BaselineState { amountCents: number; date: string; activityType: string }
export interface FiledCategory { categoryId: string; categoryName: string; taxonomyId?: string }
export interface LinkLegFacts { account: ChangeAccount; txKey: string; description: string; amountCents: number; date: string; oldActivityId: string; newActivityId?: string }
export type BookkeepingStep = 'legacy-placeholder' | 'external-marker' | 'transfer-relink' | 'opening-category';
export function amazonLabelOf(bare: string, enriched: string): string;
// One builder per kind (facts interfaces exported beside each: ImportFacts, BankUpdateFacts,
// PendingRemovedFacts, TransferTypeFacts, DuplicateRemovedFacts, BalanceRowFacts,
// StartingBalanceMovedFacts, BalanceCorrectionFacts, AmazonLabelFacts, CategoryFiledFacts,
// OpeningBalanceFiledFacts, CategoryRuleFacts, MappingRuleFacts, AccountCreatedFacts, BookkeepingFacts):
export function importChange(f: ImportFacts): ChangeDraft;
export function bankUpdateChange(f: BankUpdateFacts): ChangeDraft;
export function pendingRemovedChange(f: PendingRemovedFacts): ChangeDraft;
export function transferTypeChange(f: TransferTypeFacts): ChangeDraft;
export function transferLinkChange(out: LinkLegFacts, inLeg: LinkLegFacts): ChangeDraft;
export function duplicateRemovedChange(f: DuplicateRemovedFacts): ChangeDraft;
export function startingBalanceChange(f: BalanceRowFacts): ChangeDraft;
export function startingBalanceMovedChange(f: StartingBalanceMovedFacts): ChangeDraft;
export function balanceCorrectionChange(f: BalanceCorrectionFacts): ChangeDraft;
export function amazonLabelChange(f: AmazonLabelFacts): ChangeDraft;
export function categoryFiledChange(f: CategoryFiledFacts): ChangeDraft;
export function openingBalanceFiledChange(f: OpeningBalanceFiledFacts): ChangeDraft;
export function categoryRuleCreatedChange(f: CategoryRuleFacts): ChangeDraft;
export function mappingRuleCreatedChange(f: MappingRuleFacts): ChangeDraft;
export function accountCreatedChange(f: AccountCreatedFacts): ChangeDraft;
export function bookkeepingChange(f: BookkeepingFacts): ChangeDraft;
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/change-entries.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import {
  accountCreatedChange, amazonLabelChange, amazonLabelOf, balanceCorrectionChange, bankUpdateChange, bookkeepingChange,
  categoryFiledChange, categoryRuleCreatedChange, CHANGE_KINDS, changeDay, changeMoney, duplicateRemovedChange,
  importChange, mappingRuleCreatedChange, newEntryId, newRunId, openingBalanceFiledChange, pendingRemovedChange,
  stampChange, startingBalanceChange, startingBalanceMovedChange, transferLinkChange, transferTypeChange,
  type ChangeDraft,
} from './change-entries.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-12T14:05:00Z');
const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };
const CARD = { sfinId: 'ACT-9c8d', wfId: 'wf-citi', name: 'Citi Card' };
const KEY = accountTxKey('ACT-1f2e', 'TRN-a1b2');

describe('ids and stamps', () => {
  it('mints a run id from the writer and the millisecond', () => {
    expect(newRunId('companion', NOW)).toBe(`c${NOW.getTime().toString(36)}`);
    expect(newRunId('addon', NOW)).toBe(`a${NOW.getTime().toString(36)}`);
  });

  it('never mints the same entry id twice in one millisecond', () => {
    const ids = Array.from({ length: 50 }, () => newEntryId('addon', NOW));
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) expect(id).toMatch(new RegExp(`^a${NOW.getTime().toString(36)}[0-9a-z]+$`));
  });

  it('stamps id, time, writer and run onto a draft', () => {
    const draft = bookkeepingChange({ step: 'external-marker', activityIds: ['x'] });
    const entry = stampChange(draft, 'companion', NOW, 'cRUN');
    expect(entry).toMatchObject({ at: '2026-10-12T14:05:00.000Z', writer: 'companion', run: 'cRUN', kind: 'bookkeeping' });
    expect(entry.id.startsWith('c')).toBe(true);
    expect('run' in stampChange(draft, 'addon', NOW)).toBe(false);
  });

  it('lists every kind once', () => {
    expect(new Set(CHANGE_KINDS).size).toBe(16);
  });
});

describe('changeMoney / changeDay', () => {
  it.each([
    [-1234, '-$12.34'], [1250000, '$12,500.00'], [5, '$0.05'], [0, '$0.00'], [-123456789, '-$1,234,567.89'],
  ])('%i cents reads %s', (cents, want) => {
    expect(changeMoney(cents)).toBe(want);
  });

  it('reads a calendar day without shifting it', () => {
    expect(changeDay('2026-10-03')).toBe('Oct 3');
    expect(changeDay('2026-01-31T23:59:00Z')).toBe('Jan 31');
  });
});

describe('summaries — one per kind, bank text raw', () => {
  const cases: Array<[string, ChangeDraft, string]> = [
    ['import', importChange({
      account: CHECKING, txKey: KEY, activityId: 'act-1', description: 'SQ *BLUE_BOTTLE', amountCents: -650,
      date: '2026-10-11', pending: true, activityType: 'WITHDRAWAL',
    }), 'Imported SQ *BLUE_BOTTLE (pending)'],
    ['bank-update', bankUpdateChange({
      account: CHECKING, txKey: KEY, activityId: 'act-1', description: 'KROGER #123', amountCents: -1234,
      before: { absCents: 1200, date: '2026-10-03', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 1234, date: '2026-10-04', pending: false, activityType: 'WITHDRAWAL' },
    }), 'Updated KROGER #123 from the bank: $12.00 → $12.34, Oct 3 → Oct 4, posted'],
    ['pending-removed', pendingRemovedChange({
      account: CHECKING, txKey: KEY, activityId: 'act-2', description: 'UBER *TRIP', amountCents: -1810, date: '2026-10-10',
    }), 'Removed pending UBER *TRIP — the bank dropped it'],
    ['transfer-type held', transferTypeChange({
      account: CHECKING, txKey: KEY, activityId: 'act-3', description: 'TRANSFER TO SAV', amountCents: -50000,
      date: '2026-10-09', activityType: 'TRANSFER_OUT', previousType: null, held: true,
    }), 'Held TRANSFER TO SAV as a transfer in transit'],
    ['transfer-type expired', transferTypeChange({
      account: CHECKING, txKey: KEY, activityId: 'act-3', description: 'ZELLE FROM MOM', amountCents: 4000,
      date: '2026-09-28', activityType: 'DEPOSIT', previousType: 'CREDIT', held: false,
    }), 'Stopped waiting for the other half of ZELLE FROM MOM — now counted as money in'],
    ['transfer-link', transferLinkChange(
      { account: CHECKING, txKey: KEY, description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-10-08', oldActivityId: 'old-1', newActivityId: 'new-1' },
      { account: CARD, txKey: accountTxKey('ACT-9c8d', 'TRN-a1b2'), description: 'PAYMENT THANK YOU', amountCents: 46460, date: '2026-10-08', oldActivityId: 'old-2', newActivityId: 'new-2' },
    ), 'Linked CITI AUTOPAY (Checking) and PAYMENT THANK YOU (Citi Card) as one transfer'],
    ['duplicate-removed', duplicateRemovedChange({
      account: CHECKING, txKey: KEY, activityId: 'act-dup', description: 'TRADER JOE S #628', amountCents: -2120,
      date: '2026-08-06', payload: { accountId: 'wf-checking', activityType: 'WITHDRAWAL', activityDate: '2026-08-06', amount: 21.2, currency: 'USD', comment: 'TRADER JOE S #628 · TRN-a1b2' },
    }), 'Removed a duplicate copy of TRADER JOE S #628'],
    ['starting-balance', startingBalanceChange({
      account: CARD, activityId: 'sb-1', amountCents: -46460, date: '2026-06-18', activityType: 'WITHDRAWAL', comment: 'Starting balance · ACT-9c8d',
    }), "Set Citi Card's starting balance to -$464.60 on Jun 18"],
    ['starting-balance-moved (date)', startingBalanceMovedChange({
      account: CHECKING, actor: 'auto', activityId: 'sb-2',
      before: { amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' },
      after: { amountCents: 120000, date: '2026-04-22', activityType: 'CREDIT' },
    }), "Moved Checking's starting balance to Apr 22 (was Jun 19)"],
    ['starting-balance-moved (amount)', startingBalanceMovedChange({
      account: CHECKING, actor: 'you', activityId: 'sb-2',
      before: { amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' },
      after: { amountCents: 125000, date: '2026-06-19', activityType: 'CREDIT' },
    }), "Changed Checking's starting balance to $1,250.00 (was $1,200.00)"],
    ['starting-balance-moved (both)', startingBalanceMovedChange({
      account: CHECKING, actor: 'auto', activityId: 'sb-2',
      before: { amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' },
      after: { amountCents: 80000, date: '2026-04-22', activityType: 'CREDIT' },
    }), "Changed Checking's starting balance to $800.00 on Apr 22 (was $1,200.00 on Jun 19)"],
    ['balance-correction', balanceCorrectionChange({
      account: CHECKING, actor: 'auto', activityId: 'plug-1', amountCents: -215, date: '2026-10-12', activityType: 'TRANSFER_OUT',
      comment: 'Balance adjustment · ACT-1f2e · 2026-10-12',
    }), 'Added a -$2.15 balance correction to Checking'],
    ['amazon-label', amazonLabelChange({
      account: CARD, txKey: KEY, activityId: 'act-4', description: 'AMAZON MKTPL*2K4', amountCents: -1080, date: '2026-09-15',
      beforeNote: 'AMAZON MKTPL*2K4 · TRN-a1b2', afterNote: 'AMAZON MKTPL*2K4 · Amazon: Hair Care · TRN-a1b2', label: 'Hair Care',
    }), 'Added the Amazon label "Hair Care" to AMAZON MKTPL*2K4'],
    ['category-filed (first)', categoryFiledChange({
      actor: 'auto', account: CARD, activityId: 'act-4', description: 'AMAZON MKTPL*2K4',
      before: null, after: { categoryId: 'cat-hair', categoryName: 'Personal Care' }, why: 'Amazon: Hair Care',
    }), 'Filed AMAZON MKTPL*2K4 under Personal Care'],
    ['category-filed (move)', categoryFiledChange({
      actor: 'you', activityId: 'act-5', description: 'VENMO *J SMITH',
      before: { categoryId: 'cat-din', categoryName: 'Dining' }, after: { categoryId: 'cat-gro', categoryName: 'Groceries' },
    }), 'Moved VENMO *J SMITH from Dining to Groceries'],
    ['category-filed (off)', categoryFiledChange({
      actor: 'you', activityId: 'act-5', description: '',
      before: { categoryId: 'cat-gro', categoryName: 'Groceries' }, after: null,
    }), 'Took a transaction out of Groceries'],
    ['opening-balance-filed', openingBalanceFiledChange({
      account: CARD, activityId: 'sb-1', amountCents: -46460, date: '2026-06-18',
      category: { categoryId: 'cat-open', categoryName: 'Opening balances' },
    }), "Filed Citi Card's opening balance under Opening balances"],
    ['category-rule-created', categoryRuleCreatedChange({
      ruleId: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro', categoryName: 'Groceries',
    }), 'Created a rule: descriptions containing "TRADER JOE S" go to Groceries'],
    ['mapping-rule-created', mappingRuleCreatedChange({
      rule: { pattern: 'Payment to Ccb', matchType: 'contains', activityType: 'TRANSFER_OUT' }, description: 'Payment to Ccb Credit Card',
    }), 'Added a transaction rule: "Payment to Ccb" is a transfer out'],
    ['account-created', accountCreatedChange({ sfinId: 'ACT-9c8d', wfId: 'wf-citi', name: 'Citi Card', accountType: 'CREDIT_CARD' }),
      'Created the Wealthfolio account Citi Card'],
    ['bookkeeping', bookkeepingChange({ step: 'legacy-placeholder', account: CHECKING, activityIds: ['a', 'b'] }),
      'Restated 2 old placeholder rows with their real amounts'],
  ];

  it.each(cases)('%s', (_name, draft, summary) => {
    expect(draft.summary).toBe(summary);
  });

  it('covers every kind', () => {
    expect(new Set(cases.map(([, d]) => d.kind))).toEqual(new Set(CHANGE_KINDS));
  });

  it('words each bookkeeping step, singular and plural', () => {
    expect(bookkeepingChange({ step: 'legacy-placeholder', activityIds: ['a'] }).summary).toBe('Restated 1 old placeholder row with its real amount');
    expect(bookkeepingChange({ step: 'external-marker', activityIds: ['a'] }).summary).toBe("Marked 1 bookkeeping row as outside transfers for Wealthfolio's Health page");
    expect(bookkeepingChange({ step: 'transfer-relink', activityIds: ['a', 'b'] }).summary).toBe('Re-created 2 old transfer rows so they move cash');
    expect(bookkeepingChange({ step: 'opening-category', activityIds: [], categoryName: 'Opening balances' }).summary)
      .toBe('Set up the "Opening balances" category and kept it out of spending');
  });
});

describe('what R2 needs to undo it (P1)', () => {
  it('an import carries its activity id and tx key', () => {
    const d = importChange({
      account: CHECKING, txKey: KEY, activityId: 'act-1', description: 'X', amountCents: -100, date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
    });
    expect(d).toMatchObject({ undoable: true, actor: 'auto', after: { activityId: 'act-1', txKey: KEY } });
    expect(d.subject.txKeys).toEqual([KEY]);
  });

  it('a link carries both tx keys and both NEW activity ids', () => {
    const inKey = accountTxKey('ACT-9c8d', 'TRN-a1b2');
    const d = transferLinkChange(
      { account: CHECKING, txKey: KEY, description: 'A', amountCents: -100, date: '2026-10-08', oldActivityId: 'old-1', newActivityId: 'new-1' },
      { account: CARD, txKey: inKey, description: 'B', amountCents: 100, date: '2026-10-08', oldActivityId: 'old-2', newActivityId: 'new-2' },
    );
    expect(d.subject).toMatchObject({ txKeys: [KEY, inKey], activityIds: ['new-1', 'new-2'] });
    expect(d.before).toEqual({ activityIds: ['old-1', 'old-2'] });
    expect(d.after).toMatchObject({ activityIds: ['new-1', 'new-2'], legs: [{ txKey: KEY, accountName: 'Checking' }, { txKey: inKey, accountName: 'Citi Card' }] });
  });

  it('a link without new ids still carries the tx keys', () => {
    const d = transferLinkChange(
      { account: CHECKING, txKey: KEY, description: 'A', amountCents: -100, date: '2026-10-08', oldActivityId: 'old-1' },
      { account: CARD, txKey: 'k2', description: 'B', amountCents: 100, date: '2026-10-08', oldActivityId: 'old-2' },
    );
    expect(d.subject.activityIds).toBeUndefined();
    expect(d.subject.txKeys).toEqual([KEY, 'k2']);
  });

  it('a removed duplicate carries its full create payload', () => {
    const payload = { accountId: 'wf-checking', activityType: 'WITHDRAWAL', activityDate: '2026-08-06', amount: 21.2, currency: 'USD', comment: 'X · TRN-a1b2' };
    expect(duplicateRemovedChange({ account: CHECKING, txKey: KEY, activityId: 'dup', description: 'X', amountCents: -2120, date: '2026-08-06', payload }).before)
      .toEqual({ activityId: 'dup', activity: payload });
  });

  it('a moved baseline carries its prior amount and date', () => {
    const d = startingBalanceMovedChange({
      account: CHECKING, actor: 'auto', activityId: 'sb-2',
      before: { amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' },
      after: { amountCents: 120000, date: '2026-04-22', activityType: 'CREDIT' },
    });
    expect(d.before).toEqual({ activityId: 'sb-2', amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' });
  });

  it('a balance correction carries the row id, account and amount', () => {
    const d = balanceCorrectionChange({
      account: CHECKING, actor: 'you', activityId: 'plug-1', amountCents: 215, date: '2026-10-12', activityType: 'CREDIT', comment: 'Balance adjustment · ACT-1f2e · 2026-10-12',
    });
    expect(d.after).toMatchObject({ activityId: 'plug-1', accountId: 'wf-checking', amountCents: 215 });
    expect(d.why).toBeUndefined();
  });

  it('a filing carries the prior category id and name, or none', () => {
    const first = categoryFiledChange({ actor: 'auto', activityId: 'a', description: 'X', before: null, after: { categoryId: 'c1', categoryName: 'Groceries' } });
    expect(first.before).toEqual({ categoryId: null, categoryName: null });
    const move = categoryFiledChange({
      actor: 'you', activityId: 'a', description: 'X',
      before: { categoryId: 'c0', categoryName: 'Dining', taxonomyId: 'spending_categories' },
      after: { categoryId: 'c1', categoryName: 'Groceries' },
      restore: [{ taxonomyId: 'spending_categories', categoryId: 'c0' }, { taxonomyId: 'income_categories', categoryId: 'i1' }],
    });
    expect(move.before).toEqual({
      categoryId: 'c0', categoryName: 'Dining', taxonomyId: 'spending_categories',
      assignments: [{ taxonomyId: 'spending_categories', categoryId: 'c0' }, { taxonomyId: 'income_categories', categoryId: 'i1' }],
    });
  });

  it('a rule carries its id, pattern and category', () => {
    const d = categoryRuleCreatedChange({ ruleId: 'rule-7', name: 'Telegram: X', pattern: 'X', categoryId: 'c1', categoryName: 'Groceries' });
    expect(d.subject).toEqual({ ruleId: 'rule-7', rulePattern: 'X', categoryName: 'Groceries' });
    expect(d.after).toEqual({ ruleId: 'rule-7', name: 'Telegram: X', pattern: 'X', categoryId: 'c1', categoryName: 'Groceries' });
    expect(categoryRuleCreatedChange({ ruleId: null, name: 'n', pattern: 'X', categoryId: 'c1', categoryName: 'G' }).subject.ruleId).toBeUndefined();
  });

  it('a late label carries the label text and both notes', () => {
    expect(amazonLabelOf('AMAZON MKTPL', 'AMAZON MKTPL · Amazon: mixed — Books + Toys')).toBe('mixed — Books + Toys');
    const d = amazonLabelChange({
      account: CARD, txKey: KEY, activityId: 'a', description: 'AMAZON MKTPL', amountCents: -100, date: '2026-09-15',
      beforeNote: 'AMAZON MKTPL · TRN-1', afterNote: 'AMAZON MKTPL · Amazon: Books · TRN-1', label: 'Books',
    });
    expect(d.before).toEqual({ comment: 'AMAZON MKTPL · TRN-1' });
    expect(d.after).toEqual({ comment: 'AMAZON MKTPL · Amazon: Books · TRN-1', label: 'Books' });
  });

  it('bank changes and bookkeeping are never undoable', () => {
    const update = bankUpdateChange({
      account: CHECKING, txKey: KEY, activityId: 'a', description: 'X', amountCents: -1,
      before: { absCents: 1, date: '2026-10-01', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 1, date: '2026-10-01', pending: false, activityType: 'WITHDRAWAL' },
    });
    expect(update.undoable).toBe(false);
    expect(pendingRemovedChange({ account: CHECKING, txKey: KEY, activityId: 'a', description: 'X', amountCents: -1, date: '2026-10-01' }).undoable).toBe(false);
    expect(bookkeepingChange({ step: 'external-marker', activityIds: ['a'] }).undoable).toBe(false);
    expect(accountCreatedChange({ sfinId: 's', wfId: 'w', name: 'N', accountType: 'CASH' }).undoable).toBe(false);
    expect(transferTypeChange({
      account: CHECKING, txKey: KEY, activityId: 'a', description: 'X', amountCents: -1, date: '2026-10-01',
      activityType: 'WITHDRAWAL', previousType: 'TRANSFER_OUT', held: false,
    }).undoable).toBe(false);
  });

  it('a subtype-only update says what it was marked', () => {
    const d = bankUpdateChange({
      account: CHECKING, txKey: KEY, activityId: 'a', description: 'VENMO', amountCents: 500,
      before: { absCents: 500, date: '2026-10-01', pending: false, activityType: 'CREDIT', subtype: null },
      after: { absCents: 500, date: '2026-10-01', pending: false, activityType: 'CREDIT', subtype: 'REIMBURSEMENT' },
    });
    expect(d.summary).toBe('Updated VENMO from the bank: marked REIMBURSEMENT');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/change-entries.test.ts`
Expected: FAIL — the suite cannot import `./change-entries.js` (the file does not exist yet).

- [ ] **Step 3: Implement**

**Create `shared/change-entries.ts`:**

```ts
/**
 * shared/change-entries.ts
 *
 * One entry per write the add-on or the companion made to the books: what the
 * change log (shared/change-log.ts) stores, what `/changes` and the app's
 * Change log card show, and what Undo (release R2) will reverse. Pure — no I/O.
 *
 * Every entry is built by ONE function per kind below, and that function also
 * writes the entry's plain-English `summary`, so Telegram and the app read the
 * same words. Bank and user text inside a summary is RAW: Telegram escapes it
 * when it renders, the app renders it as text.
 *
 * `before`/`after` already carry what R2's undo needs, so nothing R1 writes
 * needs a migration later:
 *  - a filing: the previous and new category id + name (and, for a move, every
 *    assignment the row held);
 *  - a balance correction: the row's activity id, account and signed amount;
 *  - a removed duplicate: the full create payload of the row that was deleted;
 *  - a starting balance: its amount, date and type before and after;
 *  - a category rule: its id, name, pattern and category;
 *  - an import: the activity id and the account-scoped tx key;
 *  - a transfer link: both legs' tx keys and their new activity ids;
 *  - an Amazon label: the label text and the note before and after.
 */

export type ChangeWriter = 'addon' | 'companion';
export type ChangeActor = 'auto' | 'you';

export type ChangeKind =
  | 'import' | 'bank-update' | 'pending-removed'
  | 'transfer-link' | 'transfer-type'
  | 'duplicate-removed'
  | 'starting-balance' | 'starting-balance-moved' | 'balance-correction'
  | 'amazon-label' | 'category-filed' | 'opening-balance-filed'
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

export interface ChangeAccount { sfinId?: string; wfId?: string; name: string }

export interface ChangeSubject {
  /** `accountTxKey(sfinAccountId, txId)` — the identity that survives a re-link. */
  txKeys?: string[];
  activityIds?: string[];
  /** Bank text (`descriptionFromComment`), raw. */
  description?: string;
  /** Signed cents, money out negative. */
  amountCents?: number;
  /** YYYY-MM-DD. */
  date?: string;
  ruleId?: string;
  rulePattern?: string;
  categoryName?: string;
}

export interface ChangeEntry {
  /** `<a|c><base36 ms><base36 counter>`, unique per writer. */
  id: string;
  /** ISO timestamp of the write. */
  at: string;
  writer: ChangeWriter;
  /** An automatic decision, or a person's own Telegram/app action. */
  actor: ChangeActor;
  /** The sync run that wrote it; groups one run's entries. */
  run?: string;
  kind: ChangeKind;
  account?: ChangeAccount;
  subject: ChangeSubject;
  /** One plain-English line, built by this module. Raw text inside. */
  summary: string;
  /** Rule words, Amazon email label, keyword, "bank changed it". Raw. */
  why?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** False for bank-made changes and bookkeeping. */
  undoable: boolean;
  /** R2 only: an undo/redo entry points at the entry it reverses. */
  reverses?: { id: string; op: 'undo' | 'redo' };
}

/** What a builder returns: everything but the stamp (`stampChange` adds it). */
export type ChangeDraft = Omit<ChangeEntry, 'id' | 'at' | 'writer' | 'run'>;

/**
 * Where a sync run (and an after-sync step) sends its entries. `run` is the
 * run's id (`newRunId`), stamped on every entry of that run. `append` must
 * never reject — `createChangeLogWriter` keeps that promise — but every caller
 * still guards it, because a log must never cost the sync.
 */
export interface ChangeLogSink {
  writer: ChangeWriter;
  run: string;
  append(entries: ChangeEntry[]): Promise<void>;
}

const INITIAL: Record<ChangeWriter, string> = { addon: 'a', companion: 'c' };
/** Process-wide, so two stampers in one process (a sync and a Telegram tap in
 *  the same millisecond) can never mint the same id. */
let sequence = 0;

/** `<a|c><base36 ms>` — one per sync run. */
export function newRunId(writer: ChangeWriter, now: Date): string {
  return `${INITIAL[writer]}${now.getTime().toString(36)}`;
}

/** `<a|c><base36 ms><base36 counter>`. The millisecond part is a fixed 8
 *  characters until 2059, so the counter suffix can never make two ids equal. */
export function newEntryId(writer: ChangeWriter, now: Date): string {
  sequence += 1;
  return `${INITIAL[writer]}${now.getTime().toString(36)}${sequence.toString(36)}`;
}

export function stampChange(draft: ChangeDraft, writer: ChangeWriter, now: Date, run?: string): ChangeEntry {
  return { id: newEntryId(writer, now), at: now.toISOString(), writer, ...(run ? { run } : {}), ...draft };
}

/** `-$1,234.56` — always cents, ASCII minus. A log is a record, not a report. */
export function changeMoney(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${cents < 0 ? '-' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `2026-10-03` → `Oct 3`. Read as a calendar date, never shifted by a zone. */
export function changeDay(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${MONTHS[(m || 1) - 1]} ${d || 1}`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
/** The bank text a summary names; a blank description is legitimate. */
const what = (description: string | undefined) => (description && description.trim() ? description.trim() : 'a transaction');

// ── Bank feed ────────────────────────────────────────────────────────────

export interface ImportFacts {
  account: ChangeAccount;
  txKey: string;
  activityId: string;
  description: string;
  /** Signed, money out negative. */
  amountCents: number;
  date: string;
  pending: boolean;
  activityType: string;
}

/** A bank transaction the sync created. Undo (R2): skip list + remove the row. */
export function importChange(f: ImportFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'import',
    account: f.account,
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: `Imported ${what(f.description)}${f.pending ? ' (pending)' : ''}`,
    after: { activityId: f.activityId, txKey: f.txKey, activityType: f.activityType, pending: f.pending },
    undoable: true,
  };
}

/** A stored row as the reconcile step compares it. `absCents` is the
 *  magnitude; the type carries the direction, as Wealthfolio stores it. */
export interface StoredTxState {
  absCents: number;
  date: string;
  pending: boolean;
  activityType: string;
  subtype?: string | null;
}

export interface BankUpdateFacts {
  account: ChangeAccount;
  txKey: string;
  activityId: string;
  description: string;
  /** Signed, after the update. */
  amountCents: number;
  before: StoredTxState;
  after: StoredTxState;
}

/** What the bank changed, as short phrases: `$12.00 → $12.34`, `posted`. */
export function bankUpdateParts(before: StoredTxState, after: StoredTxState): string[] {
  const parts: string[] = [];
  if (before.absCents !== after.absCents) parts.push(`${changeMoney(before.absCents)} → ${changeMoney(after.absCents)}`);
  if (before.date !== after.date) parts.push(`${changeDay(before.date)} → ${changeDay(after.date)}`);
  if (before.pending && !after.pending) parts.push('posted');
  if (!before.pending && after.pending) parts.push('pending again');
  if (before.activityType !== after.activityType) parts.push(`${before.activityType} → ${after.activityType}`);
  const sub = (s: string | null | undefined) => (s ?? '').trim().toUpperCase();
  if (sub(after.subtype) && sub(before.subtype) !== sub(after.subtype)) parts.push(`marked ${sub(after.subtype)}`);
  return parts;
}

/** A reconcile update the bank drove. Not undoable: the bank is the source of truth. */
export function bankUpdateChange(f: BankUpdateFacts): ChangeDraft {
  const parts = bankUpdateParts(f.before, f.after);
  return {
    actor: 'auto',
    kind: 'bank-update',
    account: f.account,
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.after.date },
    summary: `Updated ${what(f.description)} from the bank${parts.length ? `: ${parts.join(', ')}` : ''}`,
    why: 'The bank changed it',
    before: { ...f.before },
    after: { ...f.after },
    undoable: false,
  };
}

export interface PendingRemovedFacts {
  account: ChangeAccount;
  txKey: string;
  activityId: string;
  description: string;
  amountCents: number;
  date: string;
}

export function pendingRemovedChange(f: PendingRemovedFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'pending-removed',
    account: f.account,
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: `Removed pending ${what(f.description)} — the bank dropped it`,
    why: 'The bank dropped a pending transaction',
    before: { activityId: f.activityId, txKey: f.txKey, amountCents: f.amountCents, date: f.date },
    undoable: false,
  };
}

// ── Transfers ────────────────────────────────────────────────────────────

export interface TransferTypeFacts {
  account: ChangeAccount;
  txKey: string;
  activityId: string;
  description: string;
  amountCents: number;
  date: string;
  /** The type it now has. */
  activityType: string;
  /** The type it had, or null for a row created as a placeholder. */
  previousType: string | null;
  /** true: held as a transfer in transit. false: the wait ran out. */
  held: boolean;
}

/**
 * The sync typing ONE leg as a transfer without a partner (held), or giving
 * up on one. Holding is undoable in R2 (`notTransfer` on this leg); giving up
 * is not — there is no "it is a transfer after all" override.
 */
export function transferTypeChange(f: TransferTypeFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'transfer-type',
    account: f.account,
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: f.held
      ? `Held ${what(f.description)} as a transfer in transit`
      : `Stopped waiting for the other half of ${what(f.description)} — now counted as ${f.amountCents < 0 ? 'spending' : 'money in'}`,
    why: f.held ? 'Looks like a transfer; waiting for the other half' : 'No other half arrived within 10 days',
    before: { activityType: f.previousType, inTransit: !f.held },
    after: { activityType: f.activityType, inTransit: f.held },
    undoable: f.held,
  };
}

export interface LinkLegFacts {
  account: ChangeAccount;
  txKey: string;
  description: string;
  amountCents: number;
  date: string;
  /** The row before linking (linking deletes and re-creates it). */
  oldActivityId: string;
  /** The re-created row, when the host reports it. */
  newActivityId?: string;
}

/** Two legs linked as one transfer. Undo (R2): `notTransfer` on both tx keys. */
export function transferLinkChange(out: LinkLegFacts, inLeg: LinkLegFacts): ChangeDraft {
  const fresh = [out.newActivityId, inLeg.newActivityId].filter((id): id is string => !!id);
  const leg = (l: LinkLegFacts) => ({
    txKey: l.txKey,
    accountName: l.account.name,
    ...(l.account.wfId ? { wfAccountId: l.account.wfId } : {}),
    ...(l.account.sfinId ? { sfinAccountId: l.account.sfinId } : {}),
    ...(l.newActivityId ? { activityId: l.newActivityId } : {}),
  });
  return {
    actor: 'auto',
    kind: 'transfer-link',
    account: out.account,
    subject: {
      txKeys: [out.txKey, inLeg.txKey],
      ...(fresh.length === 2 ? { activityIds: fresh } : {}),
      description: out.description,
      amountCents: out.amountCents,
      date: out.date,
    },
    summary: `Linked ${what(out.description)} (${out.account.name}) and ${what(inLeg.description)} (${inLeg.account.name}) as one transfer`,
    why: 'Same amount left one account and arrived in another',
    before: { activityIds: [out.oldActivityId, inLeg.oldActivityId] },
    after: { ...(fresh.length === 2 ? { activityIds: fresh } : {}), legs: [leg(out), leg(inLeg)] },
    undoable: true,
  };
}

// ── Corrections ──────────────────────────────────────────────────────────

export interface DuplicateRemovedFacts {
  account: ChangeAccount;
  txKey: string;
  activityId: string;
  description: string;
  amountCents: number;
  date: string;
  /** The deleted row as a create request (`ActivityWrite` shape). */
  payload: Record<string, unknown>;
}

export function duplicateRemovedChange(f: DuplicateRemovedFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'duplicate-removed',
    account: f.account,
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: `Removed a duplicate copy of ${what(f.description)}`,
    why: 'Wealthfolio held this transaction twice',
    before: { activityId: f.activityId, activity: f.payload },
    undoable: true,
  };
}

export interface BalanceRowFacts {
  account: ChangeAccount;
  /** Absent when the host could not report the new row's id. */
  activityId?: string;
  /** Signed. */
  amountCents: number;
  date: string;
  activityType: string;
  /** The row's note, which also finds it without the id. */
  comment: string;
}

/** The one-time opening balance the sync wrote. Undo (R2): remove the row. */
export function startingBalanceChange(f: BalanceRowFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'starting-balance',
    account: f.account,
    subject: { ...(f.activityId ? { activityIds: [f.activityId] } : {}), amountCents: f.amountCents, date: f.date },
    summary: `Set ${f.account.name}'s starting balance to ${changeMoney(f.amountCents)} on ${changeDay(f.date)}`,
    why: "Everything before the first sync, so the account matches the bank's balance",
    after: {
      ...(f.activityId ? { activityId: f.activityId } : {}),
      amountCents: f.amountCents, date: f.date, activityType: f.activityType, comment: f.comment,
    },
    undoable: true,
  };
}

export interface BaselineState { amountCents: number; date: string; activityType: string }

export interface StartingBalanceMovedFacts {
  account: ChangeAccount;
  actor: ChangeActor;
  activityId: string;
  before: BaselineState;
  after: BaselineState;
}

/** The starting balance changed in place — moved in front of older history by
 *  the sync, or corrected by the person accepting the baseline fix. */
export function startingBalanceMovedChange(f: StartingBalanceMovedFacts): ChangeDraft {
  const name = f.account.name;
  const sameAmount = f.before.amountCents === f.after.amountCents;
  const sameDate = f.before.date === f.after.date;
  const summary = sameAmount
    ? `Moved ${name}'s starting balance to ${changeDay(f.after.date)} (was ${changeDay(f.before.date)})`
    : sameDate
      ? `Changed ${name}'s starting balance to ${changeMoney(f.after.amountCents)} (was ${changeMoney(f.before.amountCents)})`
      : `Changed ${name}'s starting balance to ${changeMoney(f.after.amountCents)} on ${changeDay(f.after.date)} (was ${changeMoney(f.before.amountCents)} on ${changeDay(f.before.date)})`;
  return {
    actor: f.actor,
    kind: 'starting-balance-moved',
    account: f.account,
    subject: { activityIds: [f.activityId], amountCents: f.after.amountCents, date: f.after.date },
    summary,
    why: f.actor === 'you' ? 'You accepted the starting-balance fix' : 'Older transactions arrived from the bank',
    before: { activityId: f.activityId, ...f.before },
    after: { activityId: f.activityId, ...f.after },
    undoable: true,
  };
}

export interface BalanceCorrectionFacts extends BalanceRowFacts { actor: ChangeActor }

/** A `Balance adjustment` row: the aggressive re-scan's plug, or the Add
 *  adjustment button. Undo (R2): remove the row, `noAutoCorrect`. */
export function balanceCorrectionChange(f: BalanceCorrectionFacts): ChangeDraft {
  return {
    actor: f.actor,
    kind: 'balance-correction',
    account: f.account,
    subject: { ...(f.activityId ? { activityIds: [f.activityId] } : {}), amountCents: f.amountCents, date: f.date },
    summary: `Added a ${changeMoney(f.amountCents)} balance correction to ${f.account.name}`,
    ...(f.actor === 'auto' ? { why: "Aggressive auto re-scan: the account didn't match the bank" } : {}),
    after: {
      ...(f.activityId ? { activityId: f.activityId } : {}),
      accountId: f.account.wfId ?? null,
      amountCents: f.amountCents, date: f.date, activityType: f.activityType, comment: f.comment,
    },
    undoable: true,
  };
}

// ── Categories ───────────────────────────────────────────────────────────

export interface FiledCategory { categoryId: string; categoryName: string; taxonomyId?: string }

export interface AmazonLabelFacts {
  account: ChangeAccount;
  txKey: string;
  activityId: string;
  /** The bank's own text, without the label. */
  description: string;
  amountCents: number;
  date: string;
  beforeNote: string;
  afterNote: string;
  label: string;
}

/** The label `amazonDescription` adds: the text after ` · Amazon: `. */
export function amazonLabelOf(bare: string, enriched: string): string {
  const head = `${bare} · Amazon: `;
  return enriched.startsWith(head) ? enriched.slice(head.length) : enriched;
}

/** A late Amazon label added to a note. Undo (R2): put the old note back, `noAmazonLabel`. */
export function amazonLabelChange(f: AmazonLabelFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'amazon-label',
    account: f.account,
    subject: { txKeys: [f.txKey], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: `Added the Amazon label "${f.label}" to ${what(f.description)}`,
    why: 'Amazon order email',
    before: { comment: f.beforeNote },
    after: { comment: f.afterNote, label: f.label },
    undoable: true,
  };
}

export interface CategoryFiledFacts {
  actor: ChangeActor;
  account?: ChangeAccount;
  txKey?: string;
  activityId: string;
  description: string;
  amountCents?: number;
  date?: string;
  before: FiledCategory | null;
  after: FiledCategory | null;
  why?: string;
  /** A move's complete prior state: every taxonomy's assignment. */
  restore?: ReadonlyArray<{ taxonomyId: string; categoryId: string }>;
}

const filed = (c: FiledCategory | null) => (c
  ? { categoryId: c.categoryId, categoryName: c.categoryName, ...(c.taxonomyId ? { taxonomyId: c.taxonomyId } : {}) }
  : { categoryId: null, categoryName: null });

/** A category put on, moved, or taken off one transaction. Undo (R2): restore `before`. */
export function categoryFiledChange(f: CategoryFiledFacts): ChangeDraft {
  const desc = what(f.description);
  const summary = f.before && f.after
    ? `Moved ${desc} from ${f.before.categoryName} to ${f.after.categoryName}`
    : f.after
      ? `Filed ${desc} under ${f.after.categoryName}`
      : `Took ${desc} out of ${f.before?.categoryName ?? 'its category'}`;
  const categoryName = f.after?.categoryName ?? f.before?.categoryName;
  return {
    actor: f.actor,
    kind: 'category-filed',
    ...(f.account ? { account: f.account } : {}),
    subject: {
      ...(f.txKey ? { txKeys: [f.txKey] } : {}),
      activityIds: [f.activityId],
      description: f.description,
      ...(f.amountCents !== undefined ? { amountCents: f.amountCents } : {}),
      ...(f.date ? { date: f.date } : {}),
      ...(categoryName ? { categoryName } : {}),
    },
    summary,
    ...(f.why ? { why: f.why } : {}),
    before: { ...filed(f.before), ...(f.restore ? { assignments: f.restore.map((a) => ({ taxonomyId: a.taxonomyId, categoryId: a.categoryId })) } : {}) },
    after: filed(f.after),
    undoable: true,
  };
}

export interface OpeningBalanceFiledFacts {
  account: ChangeAccount;
  activityId: string;
  amountCents: number;
  date: string;
  category: FiledCategory;
}

export function openingBalanceFiledChange(f: OpeningBalanceFiledFacts): ChangeDraft {
  return {
    actor: 'auto',
    kind: 'opening-balance-filed',
    account: f.account,
    subject: { activityIds: [f.activityId], amountCents: f.amountCents, date: f.date, categoryName: f.category.categoryName },
    summary: `Filed ${f.account.name}'s opening balance under ${f.category.categoryName}`,
    why: "A card's opening debt is not a purchase",
    before: filed(null),
    after: filed(f.category),
    undoable: true,
  };
}

// ── Rules and accounts ───────────────────────────────────────────────────

export interface CategoryRuleFacts {
  /** Null when the server's reply carried no id (find it by name in R2). */
  ruleId: string | null;
  name: string;
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

export interface MappingRuleFacts {
  rule: { pattern: string; matchType: string; activityType: string; subtype?: string };
  /** The transaction it was taught from. */
  description?: string;
  account?: ChangeAccount;
}

/** A transaction rule added to `mapping_rules` (the transfer-learning menu). */
export function mappingRuleCreatedChange(f: MappingRuleFacts): ChangeDraft {
  const direction = f.rule.activityType === 'TRANSFER_IN' ? 'a transfer in'
    : f.rule.activityType === 'TRANSFER_OUT' ? 'a transfer out'
      : f.rule.activityType;
  return {
    actor: 'you',
    kind: 'mapping-rule-created',
    ...(f.account ? { account: f.account } : {}),
    subject: { rulePattern: f.rule.pattern, ...(f.description ? { description: f.description } : {}) },
    summary: `Added a transaction rule: "${f.rule.pattern}" is ${direction}`,
    after: { rule: { ...f.rule } },
    undoable: true,
  };
}

export interface AccountCreatedFacts { sfinId: string; wfId: string; name: string; accountType: string }

export function accountCreatedChange(f: AccountCreatedFacts): ChangeDraft {
  return {
    actor: 'you',
    kind: 'account-created',
    account: { sfinId: f.sfinId, wfId: f.wfId, name: f.name },
    subject: {},
    summary: `Created the Wealthfolio account ${f.name}`,
    after: { wfAccountId: f.wfId, sfinAccountId: f.sfinId, accountType: f.accountType },
    undoable: false,
  };
}

// ── Bookkeeping ──────────────────────────────────────────────────────────

export type BookkeepingStep = 'legacy-placeholder' | 'external-marker' | 'transfer-relink' | 'opening-category';

export interface BookkeepingFacts {
  step: BookkeepingStep;
  account?: ChangeAccount;
  activityIds: string[];
  /** `opening-category` only: the category it created or reused. */
  categoryName?: string;
}

/** Repairs the sync makes to its own rows. Shown behind a button; never undoable. */
export function bookkeepingChange(f: BookkeepingFacts): ChangeDraft {
  const n = f.activityIds.length;
  const summary = f.step === 'legacy-placeholder'
    ? `Restated ${n} old placeholder ${plural(n, 'row', 'rows')} with ${plural(n, 'its', 'their')} real ${plural(n, 'amount', 'amounts')}`
    : f.step === 'external-marker'
      ? `Marked ${n} bookkeeping ${plural(n, 'row', 'rows')} as outside transfers for Wealthfolio's Health page`
      : f.step === 'transfer-relink'
        ? `Re-created ${n} old transfer ${plural(n, 'row', 'rows')} so ${plural(n, 'it moves', 'they move')} cash`
        : `Set up the "${f.categoryName ?? 'Opening balances'}" category and kept it out of spending`;
  return {
    actor: 'auto',
    kind: 'bookkeeping',
    ...(f.account ? { account: f.account } : {}),
    subject: n > 0 ? { activityIds: [...f.activityIds] } : {},
    summary,
    after: { step: f.step, count: n, ...(f.categoryName ? { categoryName: f.categoryName } : {}) },
    undoable: false,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/change-entries.test.ts`
Expected: PASS — 44 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `npm --prefix companion run build`
Expected: Succeeds (the companion compiles `shared/`).

- [ ] **Step 5: Commit**

```bash
git add shared/change-entries.test.ts shared/change-entries.ts
git commit -m "Change log: the entry — ids, one builder and summary per kind, what R2 needs to undo it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Storage: buckets, cap, fallback, gaps, retention, Reset keys

Where entries live: one secret per writer per month. This task is the whole write side — parsing a bucket (corrupt is not absent), the 200 KB cap, the `.2` fallback, the pause, the per-process writer with its promise queue, gap records and the four-months-back clear — and the key list Reset deletes. Pure apart from the `get`/`set`/`clear` functions it is handed.

**Files:**
- Create: `shared/change-log.ts`
- Test: `shared/change-log.test.ts`

**Interfaces:**
- Consumes: Task 1 (`ChangeEntry`, `ChangeWriter`; tests use `stampChange`, `importChange`, `bookkeepingChange`); `SecretGet`, `SecretSet` (types, `shared/subscription-prefs.ts`); `accountTxKey` (tests).
- Produces (`shared/change-log.ts`):

```ts
export const CHANGE_LOG_KEY_PREFIX = 'change_log';
export const CHANGE_LOG_FALLBACK_SUFFIX = '.2';
export const CHANGE_LOG_CAP_BYTES = 200_000;
export const CHANGE_LOG_READ_MONTHS = 4;
export const CHANGE_LOG_CLEAR_MONTHS_BACK = 4;
export const CHANGE_LOG_RETENTION_DAYS = 90;
export const CHANGE_LOG_MAX_GAPS = 50;
export const CHANGE_LOG_WRITERS: readonly ChangeWriter[];        // ['addon', 'companion']
export const GAP_REASON_WRITE = "couldn't save the log";
export const GAP_REASON_UNREADABLE = "the log couldn't be read";
export interface ChangeGap { at: string; count: number; reason: string }
export interface ChangeBucket { v: 1; writer: ChangeWriter; month: string; entries: ChangeEntry[]; gaps: ChangeGap[]; trimmed?: number }
export type ParsedChangeBucket = { kind: 'ok'; bucket: ChangeBucket } | { kind: 'absent' } | { kind: 'corrupt' };
export class ChangeLogPausedError extends Error { constructor(writer: ChangeWriter, month: string) }
export function changeMonth(at: Date | string): string;          // UTC 'YYYY-MM'
export function shiftMonth(month: string, n: number): string;
export function changeLogKey(writer: ChangeWriter, month: string, fallback?: boolean): string;
export function changeLogResetKeys(now: Date): string[];         // 20 keys
export function emptyChangeBucket(writer: ChangeWriter, month: string): ChangeBucket;
export function parseChangeBucket(raw: string | null | undefined, writer: ChangeWriter, month: string): ParsedChangeBucket;
export function utf8Bytes(text: string): number;
export function enforceChangeCap(bucket: ChangeBucket, cap?: number): ChangeBucket;
export function appendChanges(get: SecretGet, set: SecretSet, writer: ChangeWriter, entries: ChangeEntry[], now: Date, gaps?: ChangeGap[]): Promise<void>;
export interface ChangeLogIo { get: SecretGet; set: SecretSet; clear(key: string): Promise<void> }
export interface ChangeLogWriter { readonly writer: ChangeWriter; append(io: ChangeLogIo, entries: ChangeEntry[]): Promise<void>; pendingGaps(): ChangeGap[] }
export function createChangeLogWriter(opts: { writer: ChangeWriter; now?: () => Date; log?: (msg: string) => void }): ChangeLogWriter;
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/change-log.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { bookkeepingChange, importChange, stampChange, type ChangeEntry, type ChangeWriter } from './change-entries.js';
import {
  appendChanges, CHANGE_LOG_CAP_BYTES, ChangeLogPausedError, changeLogKey, changeLogResetKeys, changeMonth,
  createChangeLogWriter, emptyChangeBucket, enforceChangeCap, GAP_REASON_UNREADABLE, GAP_REASON_WRITE,
  parseChangeBucket, shiftMonth, utf8Bytes, type ChangeBucket, type ChangeLogIo,
} from './change-log.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-12T14:05:00Z');
const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };

/** A Map behind get/set, exactly as both hosts' secrets behave: strings. */
const memory = (entries: Record<string, string> = {}) => {
  const data = new Map(Object.entries(entries));
  const io: ChangeLogIo & { data: Map<string, string> } = {
    data,
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { data.set(k, v); }),
    clear: vi.fn(async (k: string) => { data.set(k, ''); }),
  };
  return io;
};

const imported = (n: number, at = NOW, writer: ChangeWriter = 'companion'): ChangeEntry => stampChange(importChange({
  account: CHECKING, txKey: accountTxKey('ACT-1f2e', `TRN-${n}`), activityId: `act-${n}`, description: `KROGER #${n}`,
  amountCents: -100 * n, date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
}), writer, at, 'cRUN');
const background = (n: number, at = NOW): ChangeEntry =>
  stampChange(bookkeepingChange({ step: 'external-marker', account: CHECKING, activityIds: [`bk-${n}`] }), 'companion', at, 'cRUN');
const stored = (io: { data: Map<string, string> }, key: string): ChangeBucket => JSON.parse(io.data.get(key)!);

describe('keys and months', () => {
  it('keys a bucket by writer and UTC month, with a .2 fallback', () => {
    expect(changeLogKey('companion', '2026-10')).toBe('change_log:companion:2026-10');
    expect(changeLogKey('addon', '2026-10', true)).toBe('change_log:addon:2026-10.2');
    expect(changeMonth('2026-10-31T23:30:00-05:00')).toBe('2026-11');
  });

  it('steps months across a year end', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-10', -4)).toBe('2026-06');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
  });

  it('names every key Reset clears: both writers, both keys, this month and four back', () => {
    const keys = changeLogResetKeys(NOW);
    expect(keys).toHaveLength(20);
    expect(keys).toContain('change_log:addon:2026-10');
    expect(keys).toContain('change_log:companion:2026-06.2');
    expect(keys).not.toContain('change_log:addon:2026-05');
  });
});

describe('parseChangeBucket', () => {
  it('reads nothing and a cleared key as absent', () => {
    expect(parseChangeBucket(null, 'addon', '2026-10')).toEqual({ kind: 'absent' });
    expect(parseChangeBucket('', 'addon', '2026-10')).toEqual({ kind: 'absent' });
  });

  it('reads a well-formed bucket, tolerating a missing gaps list', () => {
    const raw = JSON.stringify({ v: 1, writer: 'addon', month: '2026-10', entries: [imported(1, NOW, 'addon')] });
    const parsed = parseChangeBucket(raw, 'addon', '2026-10');
    expect(parsed.kind).toBe('ok');
    expect(parsed.kind === 'ok' && parsed.bucket.gaps).toEqual([]);
  });

  it.each([
    ['not JSON', '{"v":1,'],
    ['another writer', JSON.stringify({ v: 1, writer: 'companion', month: '2026-10', entries: [], gaps: [] })],
    ['another month', JSON.stringify({ v: 1, writer: 'addon', month: '2026-09', entries: [], gaps: [] })],
    ['a newer version', JSON.stringify({ v: 2, writer: 'addon', month: '2026-10', entries: [], gaps: [] })],
    ['a broken entry', JSON.stringify({ v: 1, writer: 'addon', month: '2026-10', entries: [{ id: 'x' }], gaps: [] })],
    ['a broken gap', JSON.stringify({ v: 1, writer: 'addon', month: '2026-10', entries: [], gaps: [{ at: 1 }] })],
  ])('treats %s as corrupt', (_name, raw) => {
    expect(parseChangeBucket(raw, 'addon', '2026-10')).toEqual({ kind: 'corrupt' });
  });
});

describe('enforceChangeCap', () => {
  it('leaves a bucket under the cap alone', () => {
    const b = { ...emptyChangeBucket('companion', '2026-10'), entries: [imported(1)] };
    expect(enforceChangeCap(b)).toBe(b);
  });

  it('drops bookkeeping first, oldest first, then the oldest entries, and counts them', () => {
    const [bk1, imp1, bk2, imp2, imp3] = [background(1), imported(1), background(2), imported(2), imported(3)];
    const full = { ...emptyChangeBucket('companion', '2026-10'), entries: [bk1, imp1, bk2, imp2, imp3] };
    const sized = (entries: ChangeEntry[], trimmed: number) =>
      utf8Bytes(JSON.stringify({ ...emptyChangeBucket('companion', '2026-10'), entries, trimmed }));
    // Room for exactly the three imports: both bookkeeping rows go.
    const cut = enforceChangeCap(full, sized([imp1, imp2, imp3], 2));
    expect(cut.entries).toEqual([imp1, imp2, imp3]);
    expect(cut.trimmed).toBe(2);
    // Room for two: then the oldest import goes too.
    const tighter = enforceChangeCap(full, sized([imp2, imp3], 3));
    expect(tighter.entries).toEqual([imp2, imp3]);
    expect(tighter.trimmed).toBe(3);
    // A count already there is added to, never reset.
    expect(enforceChangeCap({ ...full, trimmed: 4 }, sized([imp1, imp2, imp3], 6)).trimmed).toBe(6);
  });

  it('measures UTF-8 bytes, not characters', () => {
    expect(utf8Bytes('café ↔️')).toBe(12);
  });
});

describe('appendChanges', () => {
  it('appends to this writer’s bucket for the entry’s month', async () => {
    const io = memory();
    await appendChanges(io.get, io.set, 'companion', [imported(1), imported(2)], NOW);
    const b = stored(io, 'change_log:companion:2026-10');
    expect(b).toMatchObject({ v: 1, writer: 'companion', month: '2026-10', gaps: [] });
    expect(b.entries.map((e) => e.subject.activityIds![0])).toEqual(['act-1', 'act-2']);
    await appendChanges(io.get, io.set, 'companion', [imported(3)], NOW);
    expect(stored(io, 'change_log:companion:2026-10').entries).toHaveLength(3);
  });

  it('puts a late entry from last month into last month’s bucket', async () => {
    const io = memory();
    await appendChanges(io.get, io.set, 'addon', [imported(1, new Date('2026-09-30T23:59:59Z'), 'addon'), imported(2, NOW, 'addon')], NOW);
    expect(stored(io, 'change_log:addon:2026-09').entries).toHaveLength(1);
    expect(stored(io, 'change_log:addon:2026-10').entries).toHaveLength(1);
  });

  it('never overwrites a corrupt bucket: it writes the .2 fallback instead', async () => {
    const io = memory({ 'change_log:companion:2026-10': '{"v":1,"writer":"companion"' });
    await appendChanges(io.get, io.set, 'companion', [imported(1)], NOW);
    expect(io.data.get('change_log:companion:2026-10')).toBe('{"v":1,"writer":"companion"');
    expect(stored(io, 'change_log:companion:2026-10.2').entries).toHaveLength(1);
  });

  it('pauses when the fallback is corrupt too, writing nothing', async () => {
    const io = memory({ 'change_log:companion:2026-10': 'x', 'change_log:companion:2026-10.2': 'y' });
    await expect(appendChanges(io.get, io.set, 'companion', [imported(1)], NOW)).rejects.toBeInstanceOf(ChangeLogPausedError);
    expect(io.set).not.toHaveBeenCalled();
  });

  it('keeps a bucket under the cap as it grows', async () => {
    const io = memory();
    const many = Array.from({ length: 700 }, (_, i) => imported(i));
    await appendChanges(io.get, io.set, 'companion', many, NOW);
    const raw = io.data.get('change_log:companion:2026-10')!;
    expect(utf8Bytes(raw)).toBeLessThanOrEqual(CHANGE_LOG_CAP_BYTES);
    const b = JSON.parse(raw) as ChangeBucket;
    expect(b.trimmed).toBeGreaterThan(0);
    expect(b.entries[b.entries.length - 1].subject.activityIds).toEqual(['act-699']);
  });
});

describe('createChangeLogWriter', () => {
  it('clears its own bucket from four months back on its first append of a month, once', async () => {
    const io = memory({ 'change_log:companion:2026-06': '{"old":true}' });
    const w = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    await w.append(io, [imported(1)]);
    await w.append(io, [imported(2)]);
    expect(io.clear).toHaveBeenCalledTimes(2);
    expect(io.clear).toHaveBeenCalledWith('change_log:companion:2026-06');
    expect(io.clear).toHaveBeenCalledWith('change_log:companion:2026-06.2');
    expect(io.data.get('change_log:companion:2026-06')).toBe('');
  });

  it('never rejects, remembers a failed append, and writes it as a gap next time', async () => {
    const io = memory();
    let fail = true;
    io.set = vi.fn(async (k: string, v: string) => {
      if (fail) throw new Error('500 from Wealthfolio');
      io.data.set(k, v);
    });
    const w = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    await expect(w.append(io, [imported(1), imported(2), imported(3)])).resolves.toBeUndefined();
    expect(w.pendingGaps()).toEqual([{ at: NOW.toISOString(), count: 3, reason: GAP_REASON_WRITE }]);
    fail = false;
    await w.append(io, [imported(4)]);
    const b = stored(io, 'change_log:companion:2026-10');
    expect(b.gaps).toEqual([{ at: NOW.toISOString(), count: 3, reason: GAP_REASON_WRITE }]);
    expect(b.entries).toHaveLength(1);
    expect(w.pendingGaps()).toEqual([]);
  });

  it('counts a paused month as an unreadable gap', async () => {
    const io = memory({ 'change_log:addon:2026-10': 'x', 'change_log:addon:2026-10.2': 'y' });
    const w = createChangeLogWriter({ writer: 'addon', now: () => NOW });
    await w.append(io, [imported(1, NOW, 'addon')]);
    expect(w.pendingGaps()).toEqual([{ at: NOW.toISOString(), count: 1, reason: GAP_REASON_UNREADABLE }]);
  });

  it('runs appends one after another, so near-simultaneous ones both land', async () => {
    const io = memory();
    const realGet = io.get;
    // A slow first read would let a second, unqueued append read the same empty bucket.
    io.get = vi.fn(async (k: string) => { await new Promise((r) => setTimeout(r, 5)); return realGet(k); });
    const w = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    await Promise.all([w.append(io, [imported(1)]), w.append(io, [imported(2)])]);
    expect(stored(io, 'change_log:companion:2026-10').entries.map((e) => e.subject.activityIds![0])).toEqual(['act-1', 'act-2']);
  });

  it('two writers in the same minute write two keys and lose nothing', async () => {
    const io = memory();
    const addon = createChangeLogWriter({ writer: 'addon', now: () => NOW });
    const companion = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    await Promise.all([addon.append(io, [imported(1, NOW, 'addon')]), companion.append(io, [imported(2)])]);
    expect(stored(io, 'change_log:addon:2026-10').entries).toHaveLength(1);
    expect(stored(io, 'change_log:companion:2026-10').entries).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/change-log.test.ts`
Expected: FAIL — the suite cannot import `./change-log.js`.

- [ ] **Step 3: Implement**

**Create `shared/change-log.ts`:**

```ts
/**
 * shared/change-log.ts
 *
 * Where change entries live: add-on settings, one bucket per writer per month
 * (`change_log:<writer>:<YYYY-MM>`), so the two writers — the add-on and the
 * companion — never write the same key. Secrets have no compare-and-swap and
 * no list operation; one key per writer is what makes a read-append-write safe
 * without either.
 *
 * - A CORRUPT bucket is never overwritten. The writer appends to the fallback
 *   `<key>.2` instead; readers read both. If the fallback is corrupt too,
 *   appends for that writer and month pause (the feed says so).
 * - The cap is 200,000 UTF-8 bytes per bucket. Over it, bookkeeping goes first
 *   (oldest first), then the oldest entries; the count lands in `trimmed`.
 * - Retention: readers read this month and the three before it and drop
 *   anything older than 90 days; a writer, on its first append of a month,
 *   clears its own bucket from four months back.
 * - A failed append is remembered in memory and written as a `gaps` record on
 *   the next successful one, so a missing stretch is visible, not silent.
 */
import type { ChangeEntry, ChangeWriter } from './change-entries.js';
import type { SecretGet, SecretSet } from './subscription-prefs.js';

export const CHANGE_LOG_KEY_PREFIX = 'change_log';
export const CHANGE_LOG_FALLBACK_SUFFIX = '.2';
export const CHANGE_LOG_CAP_BYTES = 200_000;
/** This month and the three before it. */
export const CHANGE_LOG_READ_MONTHS = 4;
/** A writer clears its own bucket this many months back. Reset clears through it. */
export const CHANGE_LOG_CLEAR_MONTHS_BACK = 4;
export const CHANGE_LOG_RETENTION_DAYS = 90;
/** Gap records kept per bucket, newest last. */
export const CHANGE_LOG_MAX_GAPS = 50;
export const CHANGE_LOG_WRITERS: readonly ChangeWriter[] = ['addon', 'companion'];

export const GAP_REASON_WRITE = "couldn't save the log";
export const GAP_REASON_UNREADABLE = "the log couldn't be read";

export interface ChangeGap { at: string; count: number; reason: string }

export interface ChangeBucket {
  v: 1;
  writer: ChangeWriter;
  month: string;
  entries: ChangeEntry[];
  gaps: ChangeGap[];
  trimmed?: number;
}

export type ParsedChangeBucket =
  | { kind: 'ok'; bucket: ChangeBucket }
  | { kind: 'absent' }
  | { kind: 'corrupt' };

/** Both the bucket and its fallback are unreadable: nothing can be appended. */
export class ChangeLogPausedError extends Error {
  constructor(readonly writer: ChangeWriter, readonly month: string) {
    super(`The ${writer} change log for ${month} cannot be read, so nothing was added to it`);
    this.name = 'ChangeLogPausedError';
  }
}

/** UTC `YYYY-MM` of a moment. */
export function changeMonth(at: Date | string): string {
  return (typeof at === 'string' ? new Date(at) : at).toISOString().slice(0, 7);
}

/** `YYYY-MM` plus `n` months (negative goes back). */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

export function changeLogKey(writer: ChangeWriter, month: string, fallback = false): string {
  return `${CHANGE_LOG_KEY_PREFIX}:${writer}:${month}${fallback ? CHANGE_LOG_FALLBACK_SUFFIX : ''}`;
}

/** Every key Reset must clear: both writers, both keys, this month and the
 *  four before it. Generated, because the secrets API cannot list keys. */
export function changeLogResetKeys(now: Date): string[] {
  const month = changeMonth(now);
  const keys: string[] = [];
  for (let back = 0; back <= CHANGE_LOG_CLEAR_MONTHS_BACK; back++) {
    for (const writer of CHANGE_LOG_WRITERS) {
      keys.push(changeLogKey(writer, shiftMonth(month, -back)), changeLogKey(writer, shiftMonth(month, -back), true));
    }
  }
  return keys;
}

export function emptyChangeBucket(writer: ChangeWriter, month: string): ChangeBucket {
  return { v: 1, writer, month, entries: [], gaps: [] };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function isEntry(v: unknown): v is ChangeEntry {
  return isRecord(v)
    && typeof v.id === 'string' && typeof v.at === 'string' && typeof v.kind === 'string'
    && typeof v.summary === 'string' && (v.writer === 'addon' || v.writer === 'companion')
    && (v.actor === 'auto' || v.actor === 'you') && isRecord(v.subject) && typeof v.undoable === 'boolean';
}

const isGap = (v: unknown): v is ChangeGap =>
  isRecord(v) && typeof v.at === 'string' && typeof v.count === 'number' && typeof v.reason === 'string';

/**
 * `absent` for nothing stored — including `''`, which is how the companion
 * clears a key. `corrupt` for anything that is not exactly this writer's
 * bucket for this month: a bucket another version or a hand edit mangled must
 * be left alone, never "repaired" by overwriting it. Unknown entry KINDS are
 * fine — a newer writer's entries still show their summary.
 */
export function parseChangeBucket(raw: string | null | undefined, writer: ChangeWriter, month: string): ParsedChangeBucket {
  if (raw === null || raw === undefined || raw === '') return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!isRecord(parsed) || parsed.v !== 1 || parsed.writer !== writer || parsed.month !== month) return { kind: 'corrupt' };
  if (!Array.isArray(parsed.entries) || !parsed.entries.every(isEntry)) return { kind: 'corrupt' };
  const gaps = parsed.gaps === undefined ? [] : parsed.gaps;
  if (!Array.isArray(gaps) || !gaps.every(isGap)) return { kind: 'corrupt' };
  if (parsed.trimmed !== undefined && typeof parsed.trimmed !== 'number') return { kind: 'corrupt' };
  return {
    kind: 'ok',
    bucket: {
      v: 1, writer, month, entries: parsed.entries as ChangeEntry[], gaps: gaps as ChangeGap[],
      ...(typeof parsed.trimmed === 'number' ? { trimmed: parsed.trimmed } : {}),
    },
  };
}

const encoder = new TextEncoder();
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/**
 * The bucket, cut to `cap` bytes of JSON. Bookkeeping goes first, oldest
 * first; then the oldest entries of any kind. Entries are stored in the order
 * they were appended, so index 0 is the oldest.
 */
export function enforceChangeCap(bucket: ChangeBucket, cap = CHANGE_LOG_CAP_BYTES): ChangeBucket {
  const size = (b: ChangeBucket) => utf8Bytes(JSON.stringify(b));
  if (size(bucket) <= cap) return bucket;
  const all = bucket.entries;
  const order = [
    ...all.map((e, i) => [e, i] as const).filter(([e]) => e.kind === 'bookkeeping').map(([, i]) => i),
    ...all.map((e, i) => [e, i] as const).filter(([e]) => e.kind !== 'bookkeeping').map(([, i]) => i),
  ];
  const dropped = new Set<number>();
  // Measured once per entry, then subtracted: re-serialising after every drop
  // is quadratic on a 200 KB bucket. Reserve room for the `trimmed` count.
  let over = size({ ...bucket, trimmed: (bucket.trimmed ?? 0) + all.length }) - cap;
  for (const i of order) {
    if (over <= 0) break;
    dropped.add(i);
    over -= utf8Bytes(JSON.stringify(all[i])) + 1;
  }
  let next: ChangeBucket = {
    ...bucket, entries: all.filter((_, i) => !dropped.has(i)), trimmed: (bucket.trimmed ?? 0) + dropped.size,
  };
  // The estimate is close; settle it exactly.
  while (size(next) > cap && next.entries.length > 0) {
    const at = next.entries.findIndex((e) => e.kind === 'bookkeeping');
    const cut = at === -1 ? 0 : at;
    next = { ...next, entries: next.entries.filter((_, i) => i !== cut), trimmed: (next.trimmed ?? 0) + 1 };
  }
  return next;
}

/** The key a writer may append to for a month, and what is in it. */
async function writableBucket(get: SecretGet, writer: ChangeWriter, month: string): Promise<{ key: string; bucket: ChangeBucket }> {
  const primary = changeLogKey(writer, month);
  const first = parseChangeBucket(await get(primary), writer, month);
  if (first.kind === 'ok') return { key: primary, bucket: first.bucket };
  if (first.kind === 'absent') return { key: primary, bucket: emptyChangeBucket(writer, month) };
  const fallback = changeLogKey(writer, month, true);
  const second = parseChangeBucket(await get(fallback), writer, month);
  if (second.kind === 'ok') return { key: fallback, bucket: second.bucket };
  if (second.kind === 'absent') return { key: fallback, bucket: emptyChangeBucket(writer, month) };
  throw new ChangeLogPausedError(writer, month);
}

/**
 * Re-read the bucket(s), append, enforce the cap, write once per month
 * touched. Entries go to the month of their own `at`; `gaps` ride along with
 * the first bucket written. Throws when the host does, or with
 * `ChangeLogPausedError` — the caller (`createChangeLogWriter`) turns either
 * into a gap.
 */
export async function appendChanges(
  get: SecretGet,
  set: SecretSet,
  writer: ChangeWriter,
  entries: ChangeEntry[],
  now: Date,
  gaps: ChangeGap[] = [],
): Promise<void> {
  if (entries.length === 0 && gaps.length === 0) return;
  const byMonth = new Map<string, ChangeEntry[]>();
  for (const e of entries) {
    const month = changeMonth(e.at);
    byMonth.set(month, [...(byMonth.get(month) ?? []), e]);
  }
  if (byMonth.size === 0) byMonth.set(changeMonth(now), []);
  let carry = gaps;
  for (const month of [...byMonth.keys()].sort()) {
    const { key, bucket } = await writableBucket(get, writer, month);
    const next = enforceChangeCap({
      ...bucket,
      entries: [...bucket.entries, ...(byMonth.get(month) ?? [])],
      gaps: [...bucket.gaps, ...carry].slice(-CHANGE_LOG_MAX_GAPS),
    });
    await set(key, JSON.stringify(next));
    carry = [];
  }
}

/** How a writer reaches its storage. `clear` removes a key: `set(key, '')` on
 *  the companion, `secrets.delete` on the add-on. */
export interface ChangeLogIo {
  get: SecretGet;
  set: SecretSet;
  clear(key: string): Promise<void>;
}

export interface ChangeLogWriter {
  readonly writer: ChangeWriter;
  /** Never rejects. Appends run one after another, in call order. */
  append(io: ChangeLogIo, entries: ChangeEntry[]): Promise<void>;
  /** Failed appends not yet written as a gap record. */
  pendingGaps(): ChangeGap[];
}

/**
 * One per process per writer: the companion's sync and a Telegram tap, or the
 * add-on's sync and a button, append through the SAME instance, so its queue
 * serialises their read-append-writes and no append overwrites another.
 */
export function createChangeLogWriter(opts: {
  writer: ChangeWriter;
  now?: () => Date;
  log?: (msg: string) => void;
}): ChangeLogWriter {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  let pending: ChangeGap[] = [];
  let clearedMonth: string | null = null;
  let tail: Promise<void> = Promise.resolve();

  async function clearOld(io: ChangeLogIo, month: string): Promise<void> {
    if (clearedMonth === month) return;
    const old = shiftMonth(month, -CHANGE_LOG_CLEAR_MONTHS_BACK);
    try {
      await io.clear(changeLogKey(opts.writer, old));
      await io.clear(changeLogKey(opts.writer, old, true));
      clearedMonth = month;
    } catch (err) {
      log(`Change log: could not clear ${old}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function run(io: ChangeLogIo, entries: ChangeEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const at = now();
    await clearOld(io, changeMonth(at));
    try {
      await appendChanges(io.get, io.set, opts.writer, entries, at, pending);
      pending = [];
    } catch (err) {
      const reason = err instanceof ChangeLogPausedError ? GAP_REASON_UNREADABLE : GAP_REASON_WRITE;
      const day = at.toISOString().slice(0, 10);
      const last = pending[pending.length - 1];
      if (last && last.reason === reason && last.at.slice(0, 10) === day) last.count += entries.length;
      else pending.push({ at: at.toISOString(), count: entries.length, reason });
      log(`Change log: ${entries.length} change(s) not saved (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  return {
    writer: opts.writer,
    append(io, entries) {
      const next = tail.then(() => run(io, entries)).catch(() => {});
      tail = next;
      return next;
    },
    pendingGaps: () => pending.map((g) => ({ ...g })),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/change-log.test.ts`
Expected: PASS — 24 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/change-log.test.ts shared/change-log.ts
git commit -m "Change log: per-writer monthly buckets — cap, corrupt-safe fallback, gaps, retention, Reset keys

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Reading the log, and the words both surfaces share

`readChangeLog` merges both writers' buckets (this month and three back, `.2` included), newest first, drops anything past 90 days, collects gaps/trims/unreadable buckets, and attaches R2's undo state from `reverses`. `shared/change-view.ts` is everything `/changes` and the app card must say the same way: the six kind groups, account and amount words, who did it, before → after, search, the run rows and the feed's notes.

**Files:**
- Modify: `shared/change-log.ts` (append the reader at the end)
- Create: `shared/change-view.ts`
- Test: `shared/change-log-read.test.ts`, `shared/change-view.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2; `localIsoDay` (`shared/subscription-roster.ts`).
- Produces, appended to `shared/change-log.ts`:

```ts
export interface ChangeLogItem extends ChangeEntry { undone?: { by: string; at: string } }
export interface ChangeLogRead {
  entries: ChangeLogItem[];                                         // newest first, last 90 days
  gaps: Array<ChangeGap & { writer: ChangeWriter }>;
  trimmed: number;
  unreadable: Array<{ writer: ChangeWriter; month: string; paused: boolean }>;
}
export function readChangeLog(get: SecretGet, now: Date): Promise<ChangeLogRead>;
```

- Produces (`shared/change-view.ts`):

```ts
export type ChangeGroup = 'categories' | 'transfers' | 'corrections' | 'imports' | 'rules' | 'background';
export const CHANGE_GROUPS: readonly ChangeGroup[];
export const CHANGE_GROUP_LABELS: Record<ChangeGroup, string>;
export function changeGroupOf(kind: string): ChangeGroup;
export const isBackground: (e: Pick<ChangeEntry, 'kind'>) => boolean;
export function changeAccountNames(e: ChangeEntry): string[];
export function changeAccountText(e: ChangeEntry): string;          // 'Checking → Citi Card'
export function changeAmountText(e: ChangeEntry): string;           // '' when none
export function changeSourceText(e: Pick<ChangeEntry, 'writer' | 'actor'>): string;
export function changeBeforeAfter(e: ChangeEntry): string | null;
export function changeSearchText(e: ChangeEntry): string;
export function matchesChangeSearch(e: ChangeEntry, query: string): boolean;
export function changesWithin<T extends Pick<ChangeEntry, 'at'>>(entries: readonly T[], now: Date, days: number): T[];
export function changeLocalDay(at: string): string;                 // local 'YYYY-MM-DD'
export function changeClock(at: string): string;                    // local 'HH:MM'
export type ChangeRow = { kind: 'entry'; entry: ChangeLogItem } | { kind: 'run'; run: string; entries: ChangeLogItem[] };
export function changeRows(entries: readonly ChangeLogItem[]): ChangeRow[];
export function changeRowAt(row: ChangeRow): string;
export function changeRowSummary(row: ChangeRow): string;           // run → 'Imported N transactions'
export function changeLogNotes(read: Pick<ChangeLogRead, 'gaps' | 'trimmed' | 'unreadable'>): string[];
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/change-log-read.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { categoryFiledChange, importChange, stampChange, type ChangeEntry, type ChangeWriter } from './change-entries.js';
import { readChangeLog, type ChangeBucket } from './change-log.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-12T14:05:00Z');
const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };

const entryAt = (writer: ChangeWriter, at: string, n: number): ChangeEntry => stampChange(importChange({
  account: CHECKING, txKey: accountTxKey('ACT-1f2e', `TRN-${n}`), activityId: `act-${n}`, description: `KROGER #${n}`,
  amountCents: -100, date: at.slice(0, 10), pending: false, activityType: 'WITHDRAWAL',
}), writer, new Date(at), 'r');

const bucket = (writer: ChangeWriter, month: string, entries: ChangeEntry[], extra: Partial<ChangeBucket> = {}) =>
  JSON.stringify({ v: 1, writer, month, entries, gaps: [], ...extra });

const reader = (data: Record<string, string>) => vi.fn(async (k: string) => data[k] ?? null);

describe('readChangeLog', () => {
  it('merges both writers newest first, two writes in the same minute both present', async () => {
    const a = entryAt('addon', '2026-10-12T14:01:10Z', 1);
    const c = entryAt('companion', '2026-10-12T14:01:40Z', 2);
    const older = entryAt('companion', '2026-10-12T09:00:00Z', 3);
    const read = await readChangeLog(reader({
      'change_log:addon:2026-10': bucket('addon', '2026-10', [a]),
      'change_log:companion:2026-10': bucket('companion', '2026-10', [older, c]),
    }), NOW);
    expect(read.entries.map((e) => e.id)).toEqual([c.id, a.id, older.id]);
    expect(read.unreadable).toEqual([]);
  });

  it('reads this month and the three before it, plus every .2 fallback', async () => {
    const get = reader({});
    await readChangeLog(get, NOW);
    const keys = get.mock.calls.map(([k]) => k);
    expect(keys).toHaveLength(16);
    expect(keys).toContain('change_log:addon:2026-07');
    expect(keys).toContain('change_log:companion:2026-10.2');
    expect(keys).not.toContain('change_log:addon:2026-06');
  });

  it('drops anything older than 90 days', async () => {
    const old = entryAt('companion', '2026-07-13T12:00:00Z', 1);
    const kept = entryAt('companion', '2026-07-15T12:00:00Z', 2);
    const read = await readChangeLog(reader({ 'change_log:companion:2026-07': bucket('companion', '2026-07', [old, kept]) }), NOW);
    expect(read.entries.map((e) => e.id)).toEqual([kept.id]);
  });

  it('reports a corrupt bucket, reads its fallback, and says when both are unreadable', async () => {
    const saved = entryAt('companion', '2026-10-11T10:00:00Z', 1);
    const read = await readChangeLog(reader({
      'change_log:companion:2026-10': '{broken',
      'change_log:companion:2026-10.2': bucket('companion', '2026-10', [saved]),
      'change_log:addon:2026-09': 'x',
      'change_log:addon:2026-09.2': 'y',
    }), NOW);
    expect(read.entries.map((e) => e.id)).toEqual([saved.id]);
    expect(read.unreadable).toEqual([
      { writer: 'companion', month: '2026-10', paused: false },
      { writer: 'addon', month: '2026-09', paused: true },
    ]);
  });

  it('collects gaps with their writer, and adds up trims', async () => {
    const read = await readChangeLog(reader({
      'change_log:addon:2026-10': bucket('addon', '2026-10', [], { gaps: [{ at: '2026-10-11T08:00:00Z', count: 3, reason: "couldn't save the log" }], trimmed: 4 }),
      'change_log:companion:2026-09': bucket('companion', '2026-09', [], { trimmed: 2 }),
    }), NOW);
    expect(read.gaps).toEqual([{ at: '2026-10-11T08:00:00Z', count: 3, reason: "couldn't save the log", writer: 'addon' }]);
    expect(read.trimmed).toBe(6);
  });

  it('marks an entry undone when the newest entry reversing it is an undo (R2)', async () => {
    const filed = stampChange(categoryFiledChange({
      actor: 'auto', activityId: 'a', description: 'X', before: null, after: { categoryId: 'c', categoryName: 'Groceries' },
    }), 'companion', new Date('2026-10-10T10:00:00Z'));
    const undo = { ...entryAt('companion', '2026-10-11T10:00:00Z', 9), reverses: { id: filed.id, op: 'undo' as const } };
    const redone = { ...entryAt('addon', '2026-10-12T10:00:00Z', 10), reverses: { id: filed.id, op: 'redo' as const } };
    const once = await readChangeLog(reader({ 'change_log:companion:2026-10': bucket('companion', '2026-10', [filed, undo]) }), NOW);
    expect(once.entries.find((e) => e.id === filed.id)?.undone).toEqual({ by: undo.id, at: undo.at });
    const twice = await readChangeLog(reader({
      'change_log:companion:2026-10': bucket('companion', '2026-10', [filed, undo]),
      'change_log:addon:2026-10': bucket('addon', '2026-10', [redone]),
    }), NOW);
    expect(twice.entries.find((e) => e.id === filed.id)?.undone).toBeUndefined();
  });

  it('rejects when the host read fails', async () => {
    await expect(readChangeLog(async () => { throw new Error('ECONNREFUSED'); }, NOW)).rejects.toThrow('ECONNREFUSED');
  });
});
```

**Create `shared/change-view.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import {
  amazonLabelChange, bankUpdateChange, bookkeepingChange, categoryFiledChange, CHANGE_KINDS, importChange,
  stampChange, startingBalanceMovedChange, transferLinkChange, transferTypeChange, type ChangeDraft,
} from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import {
  changeAccountNames, changeAccountText, changeAmountText, changeBeforeAfter, changeClock, changeGroupOf,
  changeLocalDay, changeLogNotes, changeRows, changeRowSummary, changeSourceText, changesWithin, matchesChangeSearch,
} from './change-view.js';
import { accountTxKey } from './transfers.js';

const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };
const CARD = { sfinId: 'ACT-9c8d', wfId: 'wf-citi', name: 'Citi Card' };
/** Local wall-clock moments, so the clock and day assertions hold in any TZ. */
const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m);
const item = (draft: ChangeDraft, when: Date, run?: string): ChangeLogItem => stampChange(draft, 'companion', when, run);
const imp = (n: number, when: Date, run?: string) => item(importChange({
  account: CHECKING, txKey: accountTxKey('ACT-1f2e', `TRN-${n}`), activityId: `act-${n}`, description: `KROGER #${n}`,
  amountCents: -1234, date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
}), when, run);

describe('groups', () => {
  it('puts every kind in one of the six groups', () => {
    for (const kind of CHANGE_KINDS) {
      expect(['categories', 'transfers', 'corrections', 'imports', 'rules', 'background']).toContain(changeGroupOf(kind));
    }
    expect(changeGroupOf('bookkeeping')).toBe('background');
    expect(changeGroupOf('import')).toBe('imports');
    expect(changeGroupOf('category-rule-created')).toBe('rules');
  });

  it('shows a kind from a newer version instead of hiding it', () => {
    expect(changeGroupOf('subscription-hidden')).toBe('corrections');
  });
});

describe('words for one entry', () => {
  it('names both accounts of a transfer link', () => {
    const link = item(transferLinkChange(
      { account: CHECKING, txKey: 'k1', description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-10-08', oldActivityId: 'o1', newActivityId: 'n1' },
      { account: CARD, txKey: 'k2', description: 'PAYMENT THANK YOU', amountCents: 46460, date: '2026-10-08', oldActivityId: 'o2', newActivityId: 'n2' },
    ), at(8, 9, 0));
    expect(changeAccountNames(link)).toEqual(['Checking', 'Citi Card']);
    expect(changeAccountText(link)).toBe('Checking → Citi Card');
    expect(changeAmountText(link)).toBe('-$464.60');
  });

  it('says who did it', () => {
    expect(changeSourceText({ writer: 'companion', actor: 'auto' })).toBe('Automatic — the background sync');
    expect(changeSourceText({ writer: 'addon', actor: 'auto' })).toBe('Automatic — a sync in the app');
    expect(changeSourceText({ writer: 'companion', actor: 'you' })).toBe('You, in Telegram');
    expect(changeSourceText({ writer: 'addon', actor: 'you' })).toBe('You, in the app');
  });

  it.each([
    ['a filing', categoryFiledChange({ actor: 'auto', activityId: 'a', description: 'X', before: null, after: { categoryId: 'c', categoryName: 'Groceries' } }),
      'No category → Groceries'],
    ['a move', categoryFiledChange({ actor: 'you', activityId: 'a', description: 'X', before: { categoryId: 'd', categoryName: 'Dining' }, after: { categoryId: 'c', categoryName: 'Groceries' } }),
      'Dining → Groceries'],
    ['a baseline move', startingBalanceMovedChange({
      account: CHECKING, actor: 'auto', activityId: 'sb',
      before: { amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' }, after: { amountCents: 80000, date: '2026-04-22', activityType: 'CREDIT' },
    }), '$1,200.00 on Jun 19 → $800.00 on Apr 22'],
    ['a bank update', bankUpdateChange({
      account: CHECKING, txKey: 'k', activityId: 'a', description: 'X', amountCents: -1234,
      before: { absCents: 1200, date: '2026-10-03', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 1234, date: '2026-10-03', pending: false, activityType: 'WITHDRAWAL' },
    }), '$12.00 → $12.34, posted'],
    ['a late label', amazonLabelChange({
      account: CARD, txKey: 'k', activityId: 'a', description: 'AMAZON', amountCents: -1, date: '2026-09-15',
      beforeNote: 'AMAZON · TRN-1', afterNote: 'AMAZON · Amazon: Books · TRN-1', label: 'Books',
    }), 'AMAZON · TRN-1 → AMAZON · Amazon: Books · TRN-1'],
    ['a held transfer', transferTypeChange({
      account: CHECKING, txKey: 'k', activityId: 'a', description: 'X', amountCents: -1, date: '2026-10-01',
      activityType: 'TRANSFER_OUT', previousType: null, held: true,
    }), 'New → TRANSFER_OUT (in transit)'],
  ])('before → after for %s', (_name, draft, want) => {
    expect(changeBeforeAfter(item(draft, at(12, 9, 0)))).toBe(want);
  });

  it('has no before → after for an import', () => {
    expect(changeBeforeAfter(imp(1, at(12, 9, 0)))).toBeNull();
  });
});

describe('search', () => {
  const filed = item(categoryFiledChange({
    actor: 'auto', account: CARD, activityId: 'a', description: 'AMAZON MKTPL*2K4', before: { categoryId: 'o', categoryName: 'Online Shopping' },
    after: { categoryId: 'p', categoryName: 'Personal Care' },
  }), at(12, 9, 0));

  it('matches description, account and either category, every word, any case', () => {
    expect(matchesChangeSearch(filed, 'amazon')).toBe(true);
    expect(matchesChangeSearch(filed, 'citi personal')).toBe(true);
    expect(matchesChangeSearch(filed, 'ONLINE')).toBe(true);
    expect(matchesChangeSearch(filed, 'amazon groceries')).toBe(false);
    expect(matchesChangeSearch(filed, '   ')).toBe(true);
  });

  it('does not match the summary’s own verbs', () => {
    expect(matchesChangeSearch(filed, 'filed')).toBe(false);
  });
});

describe('rows', () => {
  it('collapses one run’s imports into one row at the newest import’s place', () => {
    const entries = [
      imp(3, at(12, 14, 5), 'runA'),
      item(bookkeepingChange({ step: 'external-marker', activityIds: ['x'] }), at(12, 14, 5), 'runA'),
      imp(2, at(12, 14, 4), 'runA'),
      imp(9, at(12, 9, 0), 'runB'),
      imp(1, at(12, 8, 0), 'runA'),
    ];
    const rows = changeRows(entries);
    expect(rows.map((r) => r.kind)).toEqual(['run', 'entry', 'entry']);
    expect(rows[0].kind === 'run' && rows[0].entries.map((e) => e.subject.activityIds![0])).toEqual(['act-3', 'act-2', 'act-1']);
    expect(changeRowSummary(rows[0])).toBe('Imported 3 transactions');
    expect(changeRowSummary(rows[2])).toBe('Imported KROGER #9');
  });

  it('keeps the window and the local clock', () => {
    const now = at(12, 15, 0);
    const recent = imp(1, at(10, 7, 9));
    const old = imp(2, at(1, 7, 9));
    expect(changesWithin([recent, old], now, 7)).toEqual([recent]);
    expect(changeClock(recent.at)).toBe('07:09');
    expect(changeLocalDay(recent.at)).toBe('2026-10-10');
  });
});

describe('changeLogNotes', () => {
  it('words gaps, trims and unreadable buckets', () => {
    expect(changeLogNotes({
      gaps: [{ at: at(12, 10, 0).toISOString(), count: 3, reason: "couldn't save the log", writer: 'companion' }],
      trimmed: 12,
      unreadable: [{ writer: 'companion', month: '2026-10', paused: false }, { writer: 'addon', month: '2026-09', paused: true }],
    })).toEqual([
      "3 changes may be missing — couldn't save the log Oct 12.",
      '12 older changes were trimmed to keep the log small.',
      "Part of the companion's log for October 2026 can't be read — it was left as it was.",
      "The app's log for September 2026 can't be read, so its new changes aren't being saved.",
    ]);
    expect(changeLogNotes({ gaps: [{ at: at(12, 10, 0).toISOString(), count: 1, reason: 'x', writer: 'addon' }], trimmed: 1, unreadable: [] }))
      .toEqual(['1 change may be missing — x Oct 12.', '1 older change was trimmed to keep the log small.']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/change-log-read.test.ts shared/change-view.test.ts`
Expected: FAIL — `readChangeLog` is not exported and `./change-view.js` does not exist.

- [ ] **Step 3: Implement**

**Edit `shared/change-log.ts`** — 1 edit. Append the reader after `createChangeLogWriter` (the last block of the file).

Edit 1 of 1 in `shared/change-log.ts` — replace:

```ts
    pendingGaps: () => pending.map((g) => ({ ...g })),
  };
}
```

with:

```ts
    pendingGaps: () => pending.map((g) => ({ ...g })),
  };
}

// ── Reading ──────────────────────────────────────────────────────────────

export interface ChangeLogItem extends ChangeEntry {
  /** R2: set when the newest undo/redo entry reversing this one is an undo. */
  undone?: { by: string; at: string };
}

export interface ChangeLogRead {
  /** Both writers, newest first, the last 90 days. */
  entries: ChangeLogItem[];
  gaps: Array<ChangeGap & { writer: ChangeWriter }>;
  /** Entries dropped to the cap, across every bucket read. */
  trimmed: number;
  /** Buckets that could not be read (left untouched). `paused`: its fallback
   *  is unreadable too, so that writer's changes that month are not saved. */
  unreadable: Array<{ writer: ChangeWriter; month: string; paused: boolean }>;
}

/**
 * Both writers' buckets for this month and the three before it, `.2`
 * fallbacks included, merged newest first. Rejects only when the host read
 * itself fails; a corrupt bucket is reported in `unreadable`, never thrown.
 */
export async function readChangeLog(get: SecretGet, now: Date): Promise<ChangeLogRead> {
  const month = changeMonth(now);
  const months = Array.from({ length: CHANGE_LOG_READ_MONTHS }, (_, i) => shiftMonth(month, -i));
  const cutoff = now.getTime() - CHANGE_LOG_RETENTION_DAYS * 86_400_000;
  const reads = await Promise.all(months.flatMap((m) => CHANGE_LOG_WRITERS.map(async (writer) => {
    const [primary, fallback] = await Promise.all([get(changeLogKey(writer, m)), get(changeLogKey(writer, m, true))]);
    return { writer, month: m, primary: parseChangeBucket(primary, writer, m), fallback: parseChangeBucket(fallback, writer, m) };
  })));

  const entries: ChangeLogItem[] = [];
  const gaps: ChangeLogRead['gaps'] = [];
  const unreadable: ChangeLogRead['unreadable'] = [];
  let trimmed = 0;
  for (const r of reads) {
    if (r.primary.kind === 'corrupt' || r.fallback.kind === 'corrupt') {
      unreadable.push({ writer: r.writer, month: r.month, paused: r.primary.kind === 'corrupt' && r.fallback.kind === 'corrupt' });
    }
    for (const parsed of [r.primary, r.fallback]) {
      if (parsed.kind !== 'ok') continue;
      trimmed += parsed.bucket.trimmed ?? 0;
      for (const e of parsed.bucket.entries) if (Date.parse(e.at) >= cutoff) entries.push({ ...e });
      for (const g of parsed.bucket.gaps) if (Date.parse(g.at) >= cutoff) gaps.push({ ...g, writer: r.writer });
    }
  }
  entries.sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.at < b.at ? 1 : -1));
  gaps.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  // R2's undo state: the NEWEST reversing entry decides. Entries are newest
  // first, so the first one seen per target wins.
  const latest = new Map<string, ChangeEntry>();
  for (const e of entries) if (e.reverses && !latest.has(e.reverses.id)) latest.set(e.reverses.id, e);
  for (const e of entries) {
    const by = latest.get(e.id);
    if (by?.reverses?.op === 'undo') e.undone = { by: by.id, at: by.at };
  }
  return { entries, gaps, trimmed, unreadable };
}
```

**Create `shared/change-view.ts`:**

```ts
/**
 * shared/change-view.ts
 *
 * How a change log is SHOWN, shared by `/changes` (companion/src/changes-menu.ts)
 * and the app's Change log card (src/components/ChangeLogCard.tsx), so the two
 * group, search, word and number things the same way. Pure.
 *
 * Every string returned here is RAW: Telegram escapes it at render and keeps
 * it outside any bold or italic; the app renders it as text.
 */
import { bankUpdateParts, changeDay, changeMoney, type ChangeEntry, type StoredTxState } from './change-entries.js';
import type { ChangeLogItem, ChangeLogRead } from './change-log.js';
import { localIsoDay } from './subscription-roster.js';

export type ChangeGroup = 'categories' | 'transfers' | 'corrections' | 'imports' | 'rules' | 'background';

export const CHANGE_GROUPS: readonly ChangeGroup[] = ['categories', 'transfers', 'corrections', 'imports', 'rules', 'background'];

export const CHANGE_GROUP_LABELS: Record<ChangeGroup, string> = {
  categories: 'Categories',
  transfers: 'Transfers',
  corrections: 'Corrections',
  imports: 'Imports',
  rules: 'Rules',
  background: 'Background',
};

const GROUP_OF: Record<string, ChangeGroup> = {
  'category-filed': 'categories',
  'opening-balance-filed': 'categories',
  'amazon-label': 'categories',
  'transfer-link': 'transfers',
  'transfer-type': 'transfers',
  'duplicate-removed': 'corrections',
  'starting-balance': 'corrections',
  'starting-balance-moved': 'corrections',
  'balance-correction': 'corrections',
  import: 'imports',
  'bank-update': 'imports',
  'pending-removed': 'imports',
  'category-rule-created': 'rules',
  'mapping-rule-created': 'rules',
  'account-created': 'rules',
  bookkeeping: 'background',
};

/** A kind this build does not know (written by a newer one) still shows,
 *  under Corrections, rather than vanishing behind Background. */
export function changeGroupOf(kind: string): ChangeGroup {
  return GROUP_OF[kind] ?? 'corrections';
}

export const isBackground = (e: Pick<ChangeEntry, 'kind'>) => e.kind === 'bookkeeping';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The account(s) an entry touched: a transfer link names both legs. */
export function changeAccountNames(e: ChangeEntry): string[] {
  const names: string[] = [];
  if (e.account?.name) names.push(e.account.name);
  const legs = isRecord(e.after) && Array.isArray(e.after.legs) ? e.after.legs : [];
  for (const leg of legs) {
    const name = isRecord(leg) ? str(leg.accountName) : null;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function changeAccountText(e: ChangeEntry): string {
  return changeAccountNames(e).join(' → ');
}

export function changeAmountText(e: ChangeEntry): string {
  return e.subject.amountCents === undefined ? '' : changeMoney(e.subject.amountCents);
}

/** Who did it, in words. */
export function changeSourceText(e: Pick<ChangeEntry, 'writer' | 'actor'>): string {
  if (e.actor === 'you') return e.writer === 'companion' ? 'You, in Telegram' : 'You, in the app';
  return e.writer === 'companion' ? 'Automatic — the background sync' : 'Automatic — a sync in the app';
}

const categoryText = (side: unknown) => (isRecord(side) ? str(side.categoryName) : null) ?? 'No category';

function storedState(side: unknown): StoredTxState | null {
  if (!isRecord(side)) return null;
  const absCents = num(side.absCents);
  const date = str(side.date);
  const activityType = str(side.activityType);
  if (absCents === null || date === null || activityType === null || typeof side.pending !== 'boolean') return null;
  return { absCents, date, pending: side.pending, activityType, subtype: str(side.subtype) };
}

/** `before → after` in words, or null when the kind has nothing to compare. */
export function changeBeforeAfter(e: ChangeEntry): string | null {
  const before = e.before;
  const after = e.after;
  switch (e.kind) {
    case 'category-filed':
    case 'opening-balance-filed':
      return `${categoryText(before)} → ${categoryText(after)}`;
    case 'starting-balance-moved': {
      if (!isRecord(before) || !isRecord(after)) return null;
      const side = (s: Record<string, unknown>) => {
        const cents = num(s.amountCents);
        const date = str(s.date);
        return `${cents === null ? '?' : changeMoney(cents)} on ${date ? changeDay(date) : '?'}`;
      };
      return `${side(before)} → ${side(after)}`;
    }
    case 'bank-update': {
      const b = storedState(before);
      const a = storedState(after);
      if (!b || !a) return null;
      const parts = bankUpdateParts(b, a);
      return parts.length ? parts.join(', ') : null;
    }
    case 'amazon-label': {
      const b = isRecord(before) ? str(before.comment) : null;
      const a = isRecord(after) ? str(after.comment) : null;
      return b !== null && a !== null ? `${b} → ${a}` : null;
    }
    case 'transfer-type': {
      if (!isRecord(after)) return null;
      const from = isRecord(before) ? str(before.activityType) : null;
      const to = str(after.activityType) ?? '?';
      return `${from ?? 'New'} → ${to}${after.inTransit === true ? ' (in transit)' : ''}`;
    }
    default:
      return null;
  }
}

/** What `/changes <words>` and the card's search box look in: the bank
 *  text, the account(s), the categories and the rule words. */
export function changeSearchText(e: ChangeEntry): string {
  const parts = [
    e.subject.description, e.subject.categoryName, e.subject.rulePattern, ...changeAccountNames(e),
    isRecord(e.before) ? str(e.before.categoryName) : null,
    isRecord(e.after) ? str(e.after.categoryName) : null,
  ];
  return parts.filter((p): p is string => !!p).join(' ').toLowerCase();
}

/** Every word must appear. An empty query matches everything. */
export function matchesChangeSearch(e: ChangeEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = changeSearchText(e);
  return words.every((w) => hay.includes(w));
}

/** Entries from the last `days` days (by the moment they were written). */
export function changesWithin<T extends Pick<ChangeEntry, 'at'>>(entries: readonly T[], now: Date, days: number): T[] {
  const cutoff = now.getTime() - days * 86_400_000;
  return entries.filter((e) => Date.parse(e.at) >= cutoff);
}

/** The local calendar day an entry was written (the reader's zone). */
export function changeLocalDay(at: string): string {
  return localIsoDay(new Date(at));
}

/** `14:05`, local. */
export function changeClock(at: string): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export type ChangeRow =
  | { kind: 'entry'; entry: ChangeLogItem }
  | { kind: 'run'; run: string; entries: ChangeLogItem[] };

/**
 * Display rows, newest first: the imports of one sync run collapse into ONE
 * row ("Imported 4 transactions") at the place of the run's newest import.
 * A run with a single import stays an ordinary row.
 */
export function changeRows(entries: readonly ChangeLogItem[]): ChangeRow[] {
  const runImports = new Map<string, ChangeLogItem[]>();
  for (const e of entries) {
    if (e.kind !== 'import' || !e.run) continue;
    runImports.set(e.run, [...(runImports.get(e.run) ?? []), e]);
  }
  const rows: ChangeRow[] = [];
  const placed = new Set<string>();
  for (const e of entries) {
    const group = e.kind === 'import' && e.run ? runImports.get(e.run) : undefined;
    if (!group || group.length < 2) {
      rows.push({ kind: 'entry', entry: e });
      continue;
    }
    if (placed.has(e.run!)) continue;
    placed.add(e.run!);
    rows.push({ kind: 'run', run: e.run!, entries: group });
  }
  return rows;
}

export function changeRowAt(row: ChangeRow): string {
  return row.kind === 'entry' ? row.entry.at : row.entries[0].at;
}

export function changeRowSummary(row: ChangeRow): string {
  return row.kind === 'entry' ? row.entry.summary : `Imported ${row.entries.length} transactions`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${MONTH_NAMES[(m || 1) - 1]} ${y}`;
};
const writerLabel = (w: string) => (w === 'addon' ? "app's" : "companion's");

/** One sentence per gap, trim and unreadable bucket, for the top of the feed. */
export function changeLogNotes(read: Pick<ChangeLogRead, 'gaps' | 'trimmed' | 'unreadable'>): string[] {
  const notes: string[] = [];
  for (const g of read.gaps) {
    notes.push(`${g.count} ${g.count === 1 ? 'change' : 'changes'} may be missing — ${g.reason} ${changeDay(changeLocalDay(g.at))}.`);
  }
  if (read.trimmed > 0) {
    notes.push(`${read.trimmed} older ${read.trimmed === 1 ? 'change was' : 'changes were'} trimmed to keep the log small.`);
  }
  for (const u of read.unreadable) {
    notes.push(u.paused
      ? `The ${writerLabel(u.writer)} log for ${monthName(u.month)} can't be read, so its new changes aren't being saved.`
      : `Part of the ${writerLabel(u.writer)} log for ${monthName(u.month)} can't be read — it was left as it was.`);
  }
  return notes;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/change-log-read.test.ts shared/change-view.test.ts shared/change-log.test.ts`
Expected: PASS — 7 + 16 + 24 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/change-log-read.test.ts shared/change-log.ts shared/change-view.test.ts shared/change-view.ts
git commit -m "Change log: the merged reader, and the words /changes and the app share

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The sync core records reconcile writes and its own repairs

`runSyncCore` gains `opts.changeLog`. The old body becomes the private `runSyncPass(host, store, opts, logChange)`; the exported `runSyncCore` collects stamped entries and appends them ONCE in a `finally`, inside try/catch, so a failed append never changes the result (and a run that throws still logs what it wrote). This task records: creates (`import`, plus `transfer-type` for a row held in transit), updates (`bank-update`, or `transfer-type` when the sync held a row in transit or a placeholder ran out of time), deletes (`pending-removed`), the duplicate prune (`duplicate-removed` with the full create payload), the legacy placeholder rewrite and the external marker (`bookkeeping`), and the Amazon late label (`amazon-label`). Only confirmed writes: creates and updates off the host's echo, deletes only when their request came back clean — so `saveWithRowFallback` now also returns `deleted`.

**Files:**
- Modify: `shared/sync-core.ts`
- Test: `shared/sync-core-change-log.test.ts`

**Interfaces:**
- Consumes: Task 1 builders (`importChange`, `bankUpdateChange`, `pendingRemovedChange`, `transferTypeChange`, `duplicateRemovedChange`, `bookkeepingChange`, `amazonLabelChange`, `amazonLabelOf`, `stampChange`) and types (`ChangeAccount`, `ChangeDraft`, `ChangeEntry`, `ChangeLogSink`); `createFakeHost` (`shared/fake-host.ts`, tests).
- Produces (`shared/sync-core.ts`):

```ts
export interface SyncOptions { force?: boolean; heal?: boolean; changeLog?: ChangeLogSink }   // `changeLog` is new
// unchanged signature; now appends this run's entries once, at the end, best-effort:
export async function runSyncCore(host: SyncHost, store: SyncStore, opts?: SyncOptions): Promise<SyncResult>;
```

- Module-private: `type RecordChange = (draft: ChangeDraft) => void`; `runSyncPass(host, store, opts, logChange: RecordChange | null)` (the old body, unchanged apart from recording); `recreatePayload(row: StoredRow, currency: string): ActivityWrite`; `saveWithRowFallback` now returns `SaveManyResult & { deleted: string[] }`. Inside the per-account loop: `accountRef: ChangeAccount` and `signedCentsOf(txId, type, absCents)`.

- [ ] **Step 1: Write the failing tests**

**Create `shared/sync-core-change-log.test.ts`:**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChangeEntry, ChangeLogSink } from './change-entries.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { IN_TRANSIT_TIMEOUT_SECONDS, runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { SaveManyRequest } from './sync-host.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-12T14:05:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;

/** A sink that keeps what it was handed, one array per append. */
function capture(): ChangeLogSink & { batches: ChangeEntry[][] } {
  const batches: ChangeEntry[][] = [];
  return { writer: 'companion', run: 'cRUN1', batches, append: vi.fn(async (entries: ChangeEntry[]) => { batches.push(entries); }) };
}

const checking = (transactions: Array<{ id: string; posted: number; amount: string; description: string; pending?: boolean }>): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [{
    id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-12T12:00:00Z'), transactions,
  }] },
  mapping: { 'sfin-1': 'wf-a' },
  accountTypes: { 'wf-a': 'CASH' },
  accountNames: { 'wf-a': 'Everyday Checking' },
});

describe('runSyncCore — change log', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records each confirmed import once, at the end of the run, stamped with the run', async () => {
    const { host, store } = createFakeHost(checking([
      { id: 'tx-1', posted: epoch('2026-10-11T12:00:00Z'), amount: '-12.34', description: 'KROGER #123' },
      { id: 'tx-2', posted: epoch('2026-10-11T13:00:00Z'), amount: '1500.00', description: 'ACME PAYROLL' },
    ]));
    const log = capture();
    const result = await runSyncCore(host, store, { changeLog: log });
    expect(result.imported).toBe(2);
    expect(log.append).toHaveBeenCalledTimes(1);
    const entries = log.batches[0];
    expect(entries.map((e) => [e.kind, e.summary])).toEqual([
      ['import', 'Imported KROGER #123'],
      ['import', 'Imported ACME PAYROLL'],
    ]);
    expect(entries[0]).toMatchObject({
      writer: 'companion', run: 'cRUN1', actor: 'auto', at: NOW.toISOString(), undoable: true,
      account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Everyday Checking' },
      subject: { txKeys: [accountTxKey('sfin-1', 'tx-1')], activityIds: ['fh-1'], description: 'KROGER #123', amountCents: -1234, date: '2026-10-11' },
      after: { activityId: 'fh-1', txKey: accountTxKey('sfin-1', 'tx-1'), activityType: 'WITHDRAWAL', pending: false },
    });
    expect(entries[1].subject.amountCents).toBe(150000);
  });

  it('records nothing for a create Wealthfolio refused', async () => {
    const { host, store } = createFakeHost({
      ...checking([
        { id: 'tx-ok', posted: epoch('2026-10-11T12:00:00Z'), amount: '-5.00', description: 'COFFEE' },
        { id: 'tx-dup', posted: epoch('2026-10-11T12:00:00Z'), amount: '-12.50', description: 'LUNCH' },
      ]),
      saveManyHook: (req: SaveManyRequest) => {
        if ((req.creates ?? []).length > 1) throw new Error('bulk refused');
        const c = (req.creates ?? [])[0];
        if (c && String(c.comment).includes('tx-dup')) {
          throw new Error('Duplicate activity detected. A matching activity already exists (id: act-9).');
        }
      },
    });
    const log = capture();
    const result = await runSyncCore(host, store, { changeLog: log });
    expect(result.refusedCreates.map((r) => r.txId)).toEqual(['tx-dup']);
    expect(log.batches[0].map((e) => e.subject.txKeys)).toEqual([[accountTxKey('sfin-1', 'tx-ok')]]);
  });

  it('a failing append changes nothing about the result', async () => {
    const seed = () => checking([
      { id: 'tx-1', posted: epoch('2026-10-11T12:00:00Z'), amount: '-12.34', description: 'KROGER #123' },
    ]);
    const plain = createFakeHost(seed());
    const without = await runSyncCore(plain.host, plain.store, {});
    const failing = createFakeHost(seed());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sink: ChangeLogSink = { writer: 'addon', run: 'aRUN', append: vi.fn(async () => { throw new Error('secret write 500'); }) };
    try {
      const withBrokenLog = await runSyncCore(failing.host, failing.store, { changeLog: sink });
      expect(withBrokenLog).toEqual(without);
      expect(sink.append).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 change(s) not recorded'));
    } finally {
      warn.mockRestore();
    }
  });

  it('records nothing and never calls the sink on a run that wrote nothing', async () => {
    const { host, store } = createFakeHost(checking([]));
    const log = capture();
    await runSyncCore(host, store, { changeLog: log });
    expect(log.append).not.toHaveBeenCalled();
  });

  it('records a bank update with the row before and after', async () => {
    const { host, store } = createFakeHost({
      ...checking([{ id: 'tx-1', posted: epoch('2026-10-11T12:00:00Z'), amount: '-12.34', description: 'KROGER #123' }]),
      existing: new Map([['wf-a', [{
        id: 'act-7', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-10', amount: 12,
        comment: 'KROGER #123 · tx-1 · pending', sourceGroupId: null,
      }]]]),
    });
    const log = capture();
    await runSyncCore(host, store, { changeLog: log });
    expect(log.batches[0]).toHaveLength(1);
    expect(log.batches[0][0]).toMatchObject({
      kind: 'bank-update', undoable: false,
      summary: 'Updated KROGER #123 from the bank: $12.00 → $12.34, Oct 10 → Oct 11, posted',
      subject: { activityIds: ['act-7'], amountCents: -1234 },
      before: { absCents: 1200, date: '2026-10-10', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 1234, date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL' },
    });
  });

  it('records a pending row the bank dropped', async () => {
    const { host, store } = createFakeHost({
      ...checking([]),
      existing: new Map([['wf-a', [{
        id: 'act-8', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-10', amount: 18.1,
        comment: 'UBER *TRIP · tx-gone · pending', sourceGroupId: null,
      }]]]),
    });
    const log = capture();
    await runSyncCore(host, store, { changeLog: log });
    expect(log.batches[0]).toEqual([expect.objectContaining({
      kind: 'pending-removed', summary: 'Removed pending UBER *TRIP — the bank dropped it',
      subject: expect.objectContaining({ activityIds: ['act-8'], txKeys: [accountTxKey('sfin-1', 'tx-gone')], amountCents: -1810 }),
    })]);
  });

  it('records a new transfer leg held in transit as an import AND a transfer decision', async () => {
    const { host, store } = createFakeHost(checking([
      { id: 'tx-out', posted: epoch('2026-10-12T13:00:00Z'), amount: '-1300.00', description: 'Online Transfer to Savings' },
    ]));
    const log = capture();
    await runSyncCore(host, store, { changeLog: log });
    expect(log.batches[0].map((e) => [e.kind, e.summary, e.undoable])).toEqual([
      ['import', 'Imported Online Transfer to Savings', true],
      ['transfer-type', 'Held Online Transfer to Savings as a transfer in transit', true],
    ]);
    expect(log.batches[0][1].subject.txKeys).toEqual([accountTxKey('sfin-1', 'tx-out')]);
  });

  it('records a placeholder that ran out of time as a transfer decision it cannot undo', async () => {
    const stale = Math.floor(NOW.getTime() / 1000) - (IN_TRANSIT_TIMEOUT_SECONDS + 3600);
    const staleDate = new Date(stale * 1000).toISOString().slice(0, 10);
    const { host, store } = createFakeHost({
      ...checking([{ id: 'tx-out', posted: stale, amount: '-1300.00', description: 'Online Transfer to Savings' }]),
      existing: new Map([['wf-a', [{
        id: 'ph-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: staleDate, amount: 1300,
        comment: '↔️ In-transit transfer · Online Transfer to Savings · tx-out', sourceGroupId: null,
      }]]]),
    });
    const log = capture();
    await runSyncCore(host, store, { force: true, changeLog: log });
    const decision = log.batches[0].find((e) => e.kind === 'transfer-type')!;
    expect(decision).toMatchObject({
      undoable: false,
      summary: 'Stopped waiting for the other half of Online Transfer to Savings — now counted as spending',
      before: { activityType: 'TRANSFER_OUT', inTransit: true },
      after: { activityType: 'WITHDRAWAL', inTransit: false },
    });
  });

  it('records a pruned duplicate with the full payload to re-create it', async () => {
    const { host, store } = createFakeHost({
      ...checking([{ id: 'tx-1', posted: epoch('2026-10-01T12:00:00Z'), amount: '-25.00', description: 'NETFLIX.COM' }]),
      existing: new Map([['wf-a', [
        { id: 'act-2', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-01', amount: 25, comment: 'NETFLIX.COM · tx-1', sourceGroupId: null },
        { id: 'act-1', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-10-01', amount: 25, comment: 'NETFLIX.COM · tx-1', sourceGroupId: null },
      ]]]),
    });
    const log = capture();
    const result = await runSyncCore(host, store, { heal: true, changeLog: log });
    expect(result.prunedDuplicates.map((p) => p.wfId)).toEqual(['act-2']);
    expect(log.batches[0]).toEqual([expect.objectContaining({
      kind: 'duplicate-removed', undoable: true, summary: 'Removed a duplicate copy of NETFLIX.COM',
      subject: expect.objectContaining({ activityIds: ['act-2'], amountCents: -2500 }),
      before: {
        activityId: 'act-2',
        activity: {
          accountId: 'wf-a', activityType: 'WITHDRAWAL', activityDate: '2026-10-01', symbol: { symbol: '$CASH-USD' },
          amount: 25, currency: 'USD', comment: 'NETFLIX.COM · tx-1',
        },
      },
    })]);
  });

  it('records a late Amazon label with the label and both notes', async () => {
    const posted = epoch('2026-08-06T00:00:00Z');
    const { host, store } = createFakeHost({
      ...checking([{ id: 'tx-amz', posted, amount: '-21.18', description: 'AMAZON.COM*MB3T81' }]),
      existing: new Map([['wf-a', [{
        id: 'act-amz', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-08-06', amount: 21.18,
        comment: 'AMAZON.COM*MB3T81 · tx-amz', sourceGroupId: null,
      }]]]),
      amazonLedger: {
        '113-0728509-1925031|shipped|2118': {
          orderId: '113-0728509-1925031', kind: 'shipped', totalCents: 2118, itemCount: 1, labels: ['Lawn & Garden'], emailDate: '2026-08-04',
        },
      },
    });
    const log = capture();
    await runSyncCore(host, store, { changeLog: log });
    expect(log.batches[0]).toEqual([expect.objectContaining({
      kind: 'amazon-label', summary: 'Added the Amazon label "Lawn & Garden" to AMAZON.COM*MB3T81',
      before: { comment: 'AMAZON.COM*MB3T81 · tx-amz' },
      after: { comment: 'AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · tx-amz', label: 'Lawn & Garden' },
    })]);
  });

  it('records the legacy rewrite and the external marker as bookkeeping', async () => {
    const { host, store } = createFakeHost({
      ...checking([]),
      existing: new Map([['wf-a', [{
        id: 'plug-1', accountId: 'wf-a', activityType: 'CREDIT', date: '2026-06-12', amount: '0', fee: '80',
        comment: 'Balance adjustment · sfin-1 · 2026-06-12', sourceGroupId: null, subtype: null, metadata: null,
      }]]]),
    });
    const log = capture();
    await runSyncCore(host, store, { force: true, changeLog: log });
    expect(log.batches[0].map((e) => [e.kind, e.summary, e.subject.activityIds, e.undoable])).toEqual([
      ['bookkeeping', 'Restated 1 old placeholder row with its real amount', ['plug-1'], false],
      ['bookkeeping', "Marked 1 bookkeeping row as outside transfers for Wealthfolio's Health page", ['plug-1'], false],
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/sync-core-change-log.test.ts`
Expected: FAIL — no entries are recorded (`log.append` never called; `changeLog` is ignored).

- [ ] **Step 3: Implement**

**Edit `shared/sync-core.ts`** — 12 edits. In order: (1) import the builders; (2) `SyncOptions.changeLog`; (3–5) `saveWithRowFallback` returns `deleted` — the delete ids whose request came back clean; (6) the `runSyncCore` wrapper, `RecordChange`, `recreatePayload`, and the old body renamed `runSyncPass`; (7) `accountRef` and `signedCentsOf` at the top of the per-account `try`; (8) the prune records each deleted copy; (9) the legacy rewrite and (10) the external marker record one bookkeeping entry per account; (11) the late label records the label before it patches the note; (12) after the plan's save, the confirmed creates, updates and deletes.

Edit 1 of 12 in `shared/sync-core.ts` — replace:

```ts
import type { AmazonLedger } from './amazon-ledger.js';
import type { ActivityType, SimplefinTransaction, UnmappedAccount } from './types.js';
import type { ActivityWrite, HoldingsSyncOutcome, ImportRow, LinkLeg, LinkResult, SaveManyRequest, SaveManyResult, SyncHost, SyncStore } from './sync-host.js';

/**
 * A datable timestamp for a SimpleFin transaction: `posted` when present, else
```

with:

```ts
import type { AmazonLedger } from './amazon-ledger.js';
import type { ActivityType, SimplefinTransaction, UnmappedAccount } from './types.js';
import type { ActivityWrite, HoldingsSyncOutcome, ImportRow, LinkLeg, LinkResult, SaveManyRequest, SaveManyResult, SyncHost, SyncStore } from './sync-host.js';
import {
  amazonLabelChange, amazonLabelOf, bankUpdateChange, bookkeepingChange, duplicateRemovedChange, importChange,
  pendingRemovedChange, stampChange, transferTypeChange,
  type ChangeAccount, type ChangeDraft, type ChangeEntry, type ChangeLogSink,
} from './change-entries.js';

/**
 * A datable timestamp for a SimpleFin transaction: `posted` when present, else
```

Edit 2 of 12 in `shared/sync-core.ts` — replace:

```ts
   *  what this run imports) so the Sync page can offer a balance adjustment for
   *  anything SimpleFin can't supply. Implies force (bypasses the interval). */
  heal?: boolean;
}

/** Distinct marker so the UI can recognise an interval skip and offer to
```

with:

```ts
   *  what this run imports) so the Sync page can offer a balance adjustment for
   *  anything SimpleFin can't supply. Implies force (bypasses the interval). */
  heal?: boolean;
  /**
   * Where this run's change-log entries go (shared/change-log.ts). Absent —
   * an older host, a test that does not care — means nothing is recorded and
   * nothing about the run changes. The core collects an entry for every write
   * that SUCCEEDED and appends them once, at the end, best-effort: a failed
   * append is caught here and never alters the result.
   */
  changeLog?: ChangeLogSink;
}

/** Distinct marker so the UI can recognise an interval skip and offer to
```

Edit 3 of 12 in `shared/sync-core.ts` — replace:

```ts
async function saveWithRowFallback(
  host: SyncHost,
  req: SaveManyRequest,
): Promise<SaveManyResult> {
  const bulk = await attemptSave(host, req);
  if ((bulk.errors ?? []).length === 0) return bulk;

  const created = [...(bulk.created ?? [])];
  const updated = [...(bulk.updated ?? [])];
```

with:

```ts
async function saveWithRowFallback(
  host: SyncHost,
  req: SaveManyRequest,
): Promise<SaveManyResult & { deleted: string[] }> {
  const bulk = await attemptSave(host, req);
  // `deleted`: the delete ids whose request came back clean — the only deletes
  // the change log may claim. The error shape cannot say which id failed.
  if ((bulk.errors ?? []).length === 0) return { ...bulk, deleted: [...(req.deleteIds ?? [])] };

  const created = [...(bulk.created ?? [])];
  const updated = [...(bulk.updated ?? [])];
```

Edit 4 of 12 in `shared/sync-core.ts` — replace:

```ts
  );
  const landedUpdates = new Set(updated.map((a) => a.id).filter((id): id is string => !!id));

  if ((req.deleteIds ?? []).length > 0) {
    const del = await attemptSave(host, { deleteIds: req.deleteIds });
    for (const e of del.errors ?? []) errors.push(e);
  }

  for (const u of req.updates ?? []) {
```

with:

```ts
  );
  const landedUpdates = new Set(updated.map((a) => a.id).filter((id): id is string => !!id));

  let deleted: string[] = [];
  if ((req.deleteIds ?? []).length > 0) {
    const del = await attemptSave(host, { deleteIds: req.deleteIds });
    for (const e of del.errors ?? []) errors.push(e);
    if ((del.errors ?? []).length === 0) deleted = [...req.deleteIds!];
  }

  for (const u of req.updates ?? []) {
```

Edit 5 of 12 in `shared/sync-core.ts` — replace:

```ts
    }
  }

  return { created, updated, errors };
}

/**
```

with:

```ts
    }
  }

  return { created, updated, errors, deleted };
}

/**
```

Edit 6 of 12 in `shared/sync-core.ts` — replace:

```ts
  store: SyncStore,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const errors: string[] = [];
  const autoAdjust = await store.getAutoAdjust();
  const heal = opts.heal || autoAdjust || (await store.getAutoHeal());
```

with:

```ts
  store: SyncStore,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const sink = opts.changeLog;
  const changes: ChangeEntry[] = [];
  const logChange: RecordChange | null = sink
    ? (draft) => { changes.push(stampChange(draft, sink.writer, new Date(), sink.run)); }
    : null;
  try {
    return await runSyncPass(host, store, opts, logChange);
  } finally {
    // Once, at the end, whatever happened above — and never at the run's
    // expense: the sink is not supposed to reject, and if it does the result
    // the caller gets is exactly the one it would have got without a log.
    if (sink && changes.length > 0) {
      try {
        await sink.append(changes);
      } catch (e: any) {
        console.warn(`[simplefin-sync] change log: ${changes.length} change(s) not recorded: ${String(e?.message ?? e)}`);
      }
    }
  }
}

/** Records one change-log entry for a write that succeeded. */
type RecordChange = (draft: ChangeDraft) => void;

/**
 * A stored row as the create request that would make it again — what R2's
 * undo needs to put back a duplicate the prune removed.
 */
function recreatePayload(row: StoredRow, currency: string): ActivityWrite {
  return {
    accountId: row.wfAccountId,
    activityType: row.type,
    activityDate: row.date,
    ...(isTransferType(row.type) ? {} : { symbol: { symbol: `$CASH-${currency}` } }),
    amount: row.absCents / 100,
    ...(row.feeCents ? { fee: row.feeCents / 100 } : {}),
    currency,
    comment: row.comment ?? '',
    ...(row.subtype ? { subtype: row.subtype } : {}),
    ...(typeof row.flowExternal === 'boolean' ? { metadata: JSON.stringify({ flow: { is_external: row.flowExternal } }) } : {}),
  };
}

async function runSyncPass(
  host: SyncHost,
  store: SyncStore,
  opts: SyncOptions,
  logChange: RecordChange | null,
): Promise<SyncResult> {
  const errors: string[] = [];
  const autoAdjust = await store.getAutoAdjust();
  const heal = opts.heal || autoAdjust || (await store.getAutoHeal());
```

Edit 7 of 12 in `shared/sync-core.ts` — replace:

```ts

    try {
    const preparedAll = preparedByAccount.get(sfAccount.id) ?? [];

    // Build the feed for this account and reconcile it against the rows already
    // imported (matched by SimpleFin tx id, so a changed resolved type updates
```

with:

```ts

    try {
    const preparedAll = preparedByAccount.get(sfAccount.id) ?? [];
    /** This account, as change-log entries name it. */
    const accountRef: ChangeAccount = { sfinId: sfAccount.id, wfId: wfAccountId, name: wfNames.get(wfAccountId) || sfAccount.name };
    /** A row's signed amount in cents: the feed's when it has the row, else from the type. */
    const signedCentsOf = (txId: string, type: string, absCents: number): number => {
      const signed = signedByKey.get(accountTxKey(sfAccount.id, txId));
      return signed !== undefined ? Math.round(signed * 100) : OUTFLOW_TYPES.has(type) ? -absCents : absCents;
    };

    // Build the feed for this account and reconcile it against the rows already
    // imported (matched by SimpleFin tx id, so a changed resolved type updates
```

Edit 8 of 12 in `shared/sync-core.ts` — replace:

```ts
              `[simplefin-sync] ${DUPLICATE_PRUNE_LOG_TAG}: deleted activity ${row.wfId} — a surplus copy of transaction ${row.txId} in account ${sfAccount.id}`,
              entry,
            );
          }
        }
      }
```

with:

```ts
              `[simplefin-sync] ${DUPLICATE_PRUNE_LOG_TAG}: deleted activity ${row.wfId} — a surplus copy of transaction ${row.txId} in account ${sfAccount.id}`,
              entry,
            );
            logChange?.(duplicateRemovedChange({
              account: accountRef,
              txKey: accountTxKey(sfAccount.id, row.txId),
              activityId: row.wfId,
              description: entry.description,
              amountCents: signedCentsOf(row.txId, row.type, entry.amountCents),
              date: row.date,
              payload: { ...recreatePayload(row, sfAccount.currency) },
            }));
          }
        }
      }
```

Edit 9 of 12 in `shared/sync-core.ts` — replace:

```ts
            const row = existing.find((r) => r.wfId === u.id);
            if (row) { row.type = u.activityType; row.absCents = Math.round((u.amount ?? 0) * 100); row.feeCents = 0; }
          }
          console.info(
            `[simplefin-sync] ${LEGACY_PLACEHOLDER_REWRITE_LOG_TAG}: restated ${legacyRewrites.length} pre-v1.49 placeholder(s) in account ${sfAccount.id} as TRANSFER_OUT with their real amounts`,
          );
```

with:

```ts
            const row = existing.find((r) => r.wfId === u.id);
            if (row) { row.type = u.activityType; row.absCents = Math.round((u.amount ?? 0) * 100); row.feeCents = 0; }
          }
          logChange?.(bookkeepingChange({ step: 'legacy-placeholder', account: accountRef, activityIds: legacyRewrites.map((u) => u.id!) }));
          console.info(
            `[simplefin-sync] ${LEGACY_PLACEHOLDER_REWRITE_LOG_TAG}: restated ${legacyRewrites.length} pre-v1.49 placeholder(s) in account ${sfAccount.id} as TRANSFER_OUT with their real amounts`,
          );
```

Edit 10 of 12 in `shared/sync-core.ts` — replace:

```ts
            const row = existing.find((r) => r.wfId === u.id);
            if (row) row.flowExternal = true;
          }
          console.info(
            `[simplefin-sync] ${EXTERNAL_MARKER_STAMP_LOG_TAG}: marked ${stamps.length} opening-balance/plug/in-transit row(s) in account ${sfAccount.id} as external, so Wealthfolio stops reporting them as incomplete transfers`,
          );
```

with:

```ts
            const row = existing.find((r) => r.wfId === u.id);
            if (row) row.flowExternal = true;
          }
          logChange?.(bookkeepingChange({ step: 'external-marker', account: accountRef, activityIds: stamps.map((u) => u.id!) }));
          console.info(
            `[simplefin-sync] ${EXTERNAL_MARKER_STAMP_LOG_TAG}: marked ${stamps.length} opening-balance/plug/in-transit row(s) in account ${sfAccount.id} as external, so Wealthfolio stops reporting them as incomplete transfers`,
          );
```

Edit 11 of 12 in `shared/sync-core.ts` — replace:

```ts
        } else {
          for (const u of lateLabels) {
            const row = existing.find((r) => r.wfId === u.id);
            if (row) row.comment = u.comment;
          }
          console.info(
            `[simplefin-sync] ${AMAZON_LATE_LABEL_LOG_TAG}: added the Amazon category to ${lateLabels.length} charge(s) in account ${sfAccount.id} imported before their order email was read`,
```

with:

```ts
        } else {
          for (const u of lateLabels) {
            const row = existing.find((r) => r.wfId === u.id);
            if (!row) continue;
            const hit = amazonLabelled.get(sfAccount.id)?.get(row.txId);
            if (hit) {
              logChange?.(amazonLabelChange({
                account: accountRef,
                txKey: accountTxKey(sfAccount.id, row.txId),
                activityId: row.wfId,
                description: hit.bare,
                amountCents: signedCentsOf(row.txId, row.type, row.absCents),
                date: row.date,
                beforeNote: row.comment ?? '',
                afterNote: u.comment,
                label: amazonLabelOf(hit.bare, hit.enriched),
              }));
            }
            row.comment = u.comment;
          }
          console.info(
            `[simplefin-sync] ${AMAZON_LATE_LABEL_LOG_TAG}: added the Amazon category to ${lateLabels.length} charge(s) in account ${sfAccount.id} imported before their order email was read`,
```

Edit 12 of 12 in `shared/sync-core.ts` — replace:

```ts
          sfAccountId: sfAccount.id,
        });
      }
    }

    // Every run, not only one that imported: a baseline stranded after older
```

with:

```ts
          sfAccountId: sfAccount.id,
        });
      }

      // The change log: an entry per write the host CONFIRMED — a create or an
      // update off its echo, a delete only when its request came back clean.
      // A refused create is in none of these and records nothing (it is on
      // `refusedCreates` already).
      if (logChange) {
        for (const a of result.created ?? []) {
          const txId = txIdFromComment(a.comment);
          const t = txId ? createdFeedByTxId.get(txId) : undefined;
          if (!txId || !t || !a.id) continue;
          const key = accountTxKey(sfAccount.id, txId);
          const facts = {
            account: accountRef, txKey: key, activityId: a.id, description: descByKey.get(key) ?? '',
            amountCents: signedCentsOf(txId, t.type, t.absCents), date: t.date,
          };
          logChange(importChange({ ...facts, pending: !!t.pending, activityType: t.type }));
          // Held as a transfer that has not found its other half: a decision
          // of its own, undone in R2 with `notTransfer` on this leg.
          if (t.inTransit) logChange(transferTypeChange({ ...facts, activityType: t.type, previousType: null, held: true }));
        }
        const updateTo = new Map(plan.updates.map((u) => [u.wfId, u.to]));
        for (const a of result.updated ?? []) {
          const to = a.id ? updateTo.get(a.id) : undefined;
          const stored = to ? planExisting.find((r) => r.wfId === a.id) : undefined;
          if (!to || !stored) continue;
          const key = accountTxKey(sfAccount.id, to.txId);
          const facts = {
            account: accountRef, txKey: key, activityId: stored.wfId,
            description: descByKey.get(key) ?? descriptionFromComment(stored.comment),
            amountCents: signedCentsOf(to.txId, to.type, to.absCents), date: to.date,
          };
          // Two of these are the sync's own transfer decisions, not the bank's:
          // a row now held in transit, and a placeholder that ran out of time
          // (an unpaired leg always passes through the placeholder first).
          const wasInTransit = (stored.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX);
          if (to.inTransit && !wasInTransit) {
            logChange(transferTypeChange({ ...facts, activityType: to.type, previousType: stored.type, held: true }));
          } else if (wasInTransit && !to.inTransit && !isTransferType(to.type)) {
            logChange(transferTypeChange({ ...facts, activityType: to.type, previousType: stored.type, held: false }));
          } else {
            logChange(bankUpdateChange({
              ...facts,
              before: { absCents: stored.absCents, date: stored.date, pending: stored.pending, activityType: stored.type, subtype: stored.subtype ?? null },
              after: { absCents: to.absCents, date: to.date, pending: to.pending, activityType: to.type, subtype: to.subtype ?? null },
            }));
          }
        }
        for (const id of result.deleted) {
          const stored = planExisting.find((r) => r.wfId === id);
          if (!stored) continue;
          logChange(pendingRemovedChange({
            account: accountRef,
            txKey: accountTxKey(sfAccount.id, stored.txId),
            activityId: stored.wfId,
            description: descriptionFromComment(stored.comment),
            amountCents: signedCentsOf(stored.txId, stored.type, stored.absCents),
            date: stored.date,
          }));
        }
      }
    }

    // Every run, not only one that imported: a baseline stranded after older
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/sync-core-change-log.test.ts`
Expected: PASS — 11 tests.

Run: `npx vitest run shared`
Expected: PASS — every shared test, including the untouched `sync-core*.test.ts` (no behaviour changed without a sink).

Run: `npm --prefix companion test`
Expected: PASS.

Run: `npm run type-check`
Expected: No errors.

Run: `npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/sync-core-change-log.test.ts shared/sync-core.ts
git commit -m "Sync core: record confirmed imports, bank updates, dropped pendings, pruned duplicates, late labels and repairs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The sync core records balances, links and the relink sweep

The rest of the core's write points: the starting balance it creates (both passes), the baseline it moves in front of older history, the aggressive re-scan's balance correction, every confirmed transfer link, and the relink sweep (bookkeeping). Three write helpers start reporting what they wrote, without changing what they write: `importAdjustmentActivity` returns the row it imported (or null), `keepStartingBalanceOldest` returns the move (or null when the host refused it — before, its errors were silently ignored, and still are for the sync), and `applyBaselineFix` returns `change` (before/after) for Task 6. The import endpoint reports no ids, so `rowIdByComment` reads the new row back by its note — only when a sink is attached. `LinkResult` gains `activityIds`: `linkPairByRecreate` takes them from the save echo; the fake host (which keeps rows) reports the old ones.

**Files:**
- Modify: `shared/sync-core.ts`, `shared/sync-host.ts`, `shared/link-pair.ts`, `shared/fake-host.ts`
- Test: `shared/sync-core-change-log-balances.test.ts` (create); `shared/link-pair.test.ts`, `src/utils/sync.test.ts` (one expectation each now includes `activityIds`)

**Interfaces:**
- Consumes: Task 1 (`startingBalanceChange`, `startingBalanceMovedChange`, `balanceCorrectionChange`, `transferLinkChange`, `BaselineState`, `LinkLegFacts`); Task 4 (`logChange`, `accountRef`).
- Produces:

```ts
// shared/sync-host.ts
export interface LinkResult { linked: boolean; groupId?: string; activityIds?: [string, string]; problems?: string[] }
// shared/sync-core.ts
export interface BaselineMove { activityId: string; before: BaselineState; after: BaselineState }
export async function applyBaselineFix(host: SyncHost, args: { wfAccountId: string; sfAccountId: string; suggestedAmount: number; currency: string }):
  Promise<{ applied: boolean; error?: string; change?: BaselineMove }>;
export async function importAdjustmentActivity(host: SyncHost, args: { sfinAccountId: string; wfAccountId: string; currency: string; amount: number }):
  Promise<ImportRow | null>;                                       // was Promise<void>
async function rowIdByComment(read: () => Promise<HostActivity[]>, comment: string): Promise<string | undefined>;   // exported in Task 6
async function keepStartingBalanceOldest(host, args): Promise<BaselineMove | null>;                               // was Promise<number>
```

- [ ] **Step 1: Write the failing tests**

**Edit `shared/link-pair.test.ts`** — 1 edit.

Edit 1 of 1 in `shared/link-pair.test.ts` — replace:

```ts
      };
    };
    const res = await linkPairByRecreate(saveMany, [leg('a', 'wf-a', 'TRANSFER_OUT'), leg('b', 'wf-b', 'TRANSFER_IN')]);
    expect(res).toEqual({ linked: true, groupId: 'gid-the-host-chose' });
  });

  it('reports linked: false when the host silently drops the group', async () => {
```

with:

```ts
      };
    };
    const res = await linkPairByRecreate(saveMany, [leg('a', 'wf-a', 'TRANSFER_OUT'), leg('b', 'wf-b', 'TRANSFER_IN')]);
    expect(res).toEqual({ linked: true, groupId: 'gid-the-host-chose', activityIds: ['new-0', 'new-1'] });
  });

  it('reports linked: false when the host silently drops the group', async () => {
```

**Create `shared/sync-core-change-log-balances.test.ts`:**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChangeEntry, ChangeLogSink } from './change-entries.js';
import { createFakeHost } from './fake-host.js';
import { applyBaselineFix, importAdjustmentActivity, runSyncCore, VALUATION_POLL } from './sync-core.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-12T14:05:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;

function capture(): ChangeLogSink & { entries: () => ChangeEntry[] } {
  const batches: ChangeEntry[][] = [];
  return {
    writer: 'addon', run: 'aRUN1',
    append: vi.fn(async (entries: ChangeEntry[]) => { batches.push(entries); }),
    entries: () => batches.flat(),
  };
}

describe('runSyncCore — change log for balances, links and repairs', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a new starting balance with the id read back after the import', async () => {
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '100.00', 'balance-date': epoch('2026-10-12T12:00:00Z'),
        transactions: [{ id: 'tx-1', posted: epoch('2026-10-11T12:00:00Z'), amount: '-12.50', description: 'COFFEE' }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
      accountNames: { 'wf-a': 'Checking' },
      valuations: new Map([['wf-a', 0]]),
    });
    const log = capture();
    await runSyncCore(host, store, { changeLog: log });
    expect(log.entries().map((e) => e.kind)).toEqual(['import', 'starting-balance']);
    expect(log.entries()[1]).toMatchObject({
      summary: "Set Checking's starting balance to $112.50 on Oct 10",
      subject: { activityIds: ['fh-2'], amountCents: 11250, date: '2026-10-10' },
      after: { activityId: 'fh-2', amountCents: 11250, date: '2026-10-10', activityType: 'CREDIT', comment: 'Starting balance · sfin-1' },
      undoable: true,
    });
  });

  it('records a starting balance moved in front of older history, before and after', async () => {
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-12T12:00:00Z'), transactions: [],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountNames: { 'wf-a': 'Savings' },
      existing: new Map([['wf-a', [
        { id: 'sb-1', accountId: 'wf-a', activityType: 'CREDIT', date: '2026-06-19', amount: 1200, comment: 'Starting balance · sfin-1', sourceGroupId: null },
        { id: 'act-old', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-04-23', amount: 5, comment: 'COFFEE · tx-old', sourceGroupId: null },
      ]]]),
    });
    const log = capture();
    await runSyncCore(host, store, { force: true, changeLog: log });
    expect(log.entries()).toEqual([expect.objectContaining({
      kind: 'starting-balance-moved', actor: 'auto',
      summary: "Moved Savings's starting balance to Apr 22 (was Jun 19)",
      before: { activityId: 'sb-1', amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' },
      after: { activityId: 'sb-1', amountCents: 120000, date: '2026-04-22', activityType: 'CREDIT' },
    })]);
  });

  it('records the aggressive re-scan’s balance correction with its row id', async () => {
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'C', currency: 'USD', balance: '100.00', 'balance-date': epoch('2026-10-12T12:00:00Z'), transactions: [],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
      accountNames: { 'wf-a': 'Checking' },
      valuations: new Map([['wf-a', 0]]),
      autoHeal: true,
      autoAdjust: true,
    });
    const log = capture();
    await runSyncCore(host, store, { heal: true, changeLog: log });
    const plug = log.entries().find((e) => e.kind === 'balance-correction')!;
    expect(plug).toMatchObject({
      actor: 'auto', undoable: true,
      summary: 'Added a $100.00 balance correction to Checking',
      subject: { activityIds: ['fh-1'], amountCents: 10000, date: '2026-10-12' },
      after: { activityId: 'fh-1', accountId: 'wf-a', amountCents: 10000, activityType: 'CREDIT', comment: 'Balance adjustment · sfin-1 · 2026-10-12' },
    });
  });

  it('records a link with both tx keys and the ids the host reports', async () => {
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-12T12:00:00Z'),
          transactions: [{ id: 'tx-out', posted: epoch('2026-10-08T12:00:00Z'), amount: '-500.00', description: 'Payment to Card' }] },
        { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-12T12:00:00Z'),
          transactions: [{ id: 'tx-in', posted: epoch('2026-10-09T12:00:00Z'), amount: '500.00', description: 'PAYMENT THANK YOU' }] },
      ] },
      mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
      accountTypes: { 'wf-a': 'CASH', 'wf-b': 'CREDIT_CARD' },
      accountNames: { 'wf-a': 'Checking', 'wf-b': 'Citi Card' },
    });
    const log = capture();
    await runSyncCore(host, store, { changeLog: log });
    const link = log.entries().find((e) => e.kind === 'transfer-link')!;
    expect(link).toMatchObject({
      summary: 'Linked Payment to Card (Checking) and PAYMENT THANK YOU (Citi Card) as one transfer',
      account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' },
      subject: { txKeys: [accountTxKey('sfin-1', 'tx-out'), accountTxKey('sfin-2', 'tx-in')], activityIds: ['fh-1', 'fh-2'], amountCents: -50000 },
      before: { activityIds: ['fh-1', 'fh-2'] },
      undoable: true,
    });
  });

  it('records the relink sweep as bookkeeping', async () => {
    const { host, store } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Spend', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-12T12:00:00Z'), transactions: [],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      accountTypes: { 'wf-a': 'CASH' },
      existing: new Map([['wf-a', [
        { id: 'out-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-07-01', amount: 500, comment: 'Online Transfer to Savings · tx-a', assetId: '$CASH', sourceGroupId: null },
      ]]]),
    });
    const log = capture();
    await runSyncCore(host, store, { force: true, changeLog: log });
    expect(log.entries()).toEqual([expect.objectContaining({
      kind: 'bookkeeping', summary: 'Re-created 1 old transfer row so it moves cash', subject: { activityIds: ['fh-1'] }, undoable: false,
    })]);
  });
});

describe('the write helpers report what they wrote', () => {
  it('importAdjustmentActivity returns the row, or null when nothing was written', async () => {
    const { host } = createFakeHost({ mapping: { 'sfin-1': 'wf-a' }, accountTypes: { 'wf-a': 'CASH' } });
    const row = await importAdjustmentActivity(host, { sfinAccountId: 'sfin-1', wfAccountId: 'wf-a', currency: 'USD', amount: -2.15 });
    expect(row).toMatchObject({ accountId: 'wf-a', activityType: 'TRANSFER_OUT', amount: 2.15 });
    expect(row!.comment).toMatch(/^Balance adjustment · sfin-1 · \d{4}-\d{2}-\d{2}$/);
    expect(await importAdjustmentActivity(host, { sfinAccountId: 'sfin-1', wfAccountId: 'wf-a', currency: 'USD', amount: 0.004 })).toBeNull();
  });

  it('applyBaselineFix returns the row before and after', async () => {
    const { host } = createFakeHost({
      mapping: { 'sfin-1': 'wf-a' },
      existing: new Map([['wf-a', [
        { id: 'sb-wf-a', accountId: 'wf-a', activityType: 'DEPOSIT', date: '2023-11-01', amount: 11355.12, comment: 'Starting balance · sfin-1', sourceGroupId: null },
      ]]]),
    });
    const res = await applyBaselineFix(host, { wfAccountId: 'wf-a', sfAccountId: 'sfin-1', suggestedAmount: 10055.12, currency: 'USD' });
    expect(res).toEqual({
      applied: true,
      change: {
        activityId: 'sb-wf-a',
        before: { amountCents: 1135512, date: '2023-11-01', activityType: 'DEPOSIT' },
        after: { amountCents: 1005512, date: '2023-11-01', activityType: 'CREDIT' },
      },
    });
  });
});
```

**Edit `src/utils/sync.test.ts`** — 1 edit.

Edit 1 of 1 in `src/utils/sync.test.ts` — replace:

```ts
      expect(c.amount).toBe(500);
    }
    expect(creates[0].sourceGroupId).toBe(creates[1].sourceGroupId);
    expect(result).toEqual({ linked: true, groupId: creates[0].sourceGroupId });
  });

  it('reports linked:false when the host silently drops the group', async () => {
```

with:

```ts
      expect(c.amount).toBe(500);
    }
    expect(creates[0].sourceGroupId).toBe(creates[1].sourceGroupId);
    expect(result).toEqual({ linked: true, groupId: creates[0].sourceGroupId, activityIds: ['created-0', 'created-1'] });
  });

  it('reports linked:false when the host silently drops the group', async () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/sync-core-change-log-balances.test.ts shared/link-pair.test.ts`
Expected: FAIL — no balance/link entries; `importAdjustmentActivity` returns undefined; `applyBaselineFix` has no `change`; the link result has no `activityIds`.

- [ ] **Step 3: Implement**

**Edit `shared/fake-host.ts`** — 1 edit. The double keeps its rows, so it reports the legs' existing ids.

Edit 1 of 1 in `shared/fake-host.ts` — replace:

```ts
        const row = rows.find((r) => r.id === leg.wfId);
        if (row) row.sourceGroupId = groupId;
      }
      return { linked: true, groupId };
    },

    capabilities: {
```

with:

```ts
        const row = rows.find((r) => r.id === leg.wfId);
        if (row) row.sourceGroupId = groupId;
      }
      // This double keeps the rows (it only stamps the group), so the
      // "re-created" ids are the old ones.
      return { linked: true, groupId, activityIds: [legs[0].wfId, legs[1].wfId] };
    },

    capabilities: {
```

**Edit `shared/link-pair.ts`** — 1 edit. The echo map keeps each leg's id beside its group; a confirmed link reports both new ids.

Edit 1 of 1 in `shared/link-pair.ts` — replace:

```ts
  // ("both legs came back on the same gid") would then compare the second leg's
  // gid with itself and report `linked: true` even where one leg's group had been
  // silently dropped. Precisely the failure this echo exists to catch.
  const echoed = new Map<string, string | null | undefined>();
  for (const a of [...res.updated, ...res.created]) {
    const txId = txIdFromComment(a.comment);
    if (txId) echoed.set(accountTxKey(a.accountId, txId), a.sourceGroupId);
  }
  const stored = legs.map((l) => echoed.get(accountTxKey(l.accountId, l.txId)));
  const linked = !!stored[0] && stored[0] === stored[1];
  if (linked) return { linked: true, groupId: stored[0]! };
  // Both saves reported success and the group still isn't there — the silent
  // drop this echo exists to catch. Name it, or the caller has a failure with
  // no host error to explain it.
```

with:

```ts
  // ("both legs came back on the same gid") would then compare the second leg's
  // gid with itself and report `linked: true` even where one leg's group had been
  // silently dropped. Precisely the failure this echo exists to catch.
  const echoed = new Map<string, { group: string | null | undefined; id: string }>();
  for (const a of [...res.updated, ...res.created]) {
    const txId = txIdFromComment(a.comment);
    if (txId) echoed.set(accountTxKey(a.accountId, txId), { group: a.sourceGroupId, id: a.id });
  }
  const stored = legs.map((l) => echoed.get(accountTxKey(l.accountId, l.txId))?.group);
  const linked = !!stored[0] && stored[0] === stored[1];
  if (linked) {
    // The NEW ids: the re-created rows are what the change log points R2 at.
    const ids = legs.map((l) => echoed.get(accountTxKey(l.accountId, l.txId))?.id);
    return { linked: true, groupId: stored[0]!, ...(ids[0] && ids[1] ? { activityIds: [ids[0], ids[1]] as [string, string] } : {}) };
  }
  // Both saves reported success and the group still isn't there — the silent
  // drop this echo exists to catch. Name it, or the caller has a failure with
  // no host error to explain it.
```

**Edit `shared/sync-core.ts`** — 16 edits. In order: (1) imports (`HostActivity`, the four builders, `BaselineState`, `LinkLegFacts`); (2–3) `applyBaselineFix` returns `change`, and `BaselineMove` is declared after it; (4–6) `keepStartingBalanceOldest` returns the move only when the update came back clean; (7–8) `importAdjustmentActivity` returns the row and `rowIdByComment` follows it; (9) the plug records a correction; (10–11) the moved baseline is recorded; (12) the first-pass starting balance and (13) the second-pass one are recorded with the id read back; (14) `linkLegFacts` and (15) a confirmed link is recorded; (16) the relink sweep records one bookkeeping entry.

Edit 1 of 16 in `shared/sync-core.ts` — replace:

```ts
} from './amazon-ledger.js';
import type { AmazonLedger } from './amazon-ledger.js';
import type { ActivityType, SimplefinTransaction, UnmappedAccount } from './types.js';
import type { ActivityWrite, HoldingsSyncOutcome, ImportRow, LinkLeg, LinkResult, SaveManyRequest, SaveManyResult, SyncHost, SyncStore } from './sync-host.js';
import {
  amazonLabelChange, amazonLabelOf, bankUpdateChange, bookkeepingChange, duplicateRemovedChange, importChange,
  pendingRemovedChange, stampChange, transferTypeChange,
  type ChangeAccount, type ChangeDraft, type ChangeEntry, type ChangeLogSink,
} from './change-entries.js';

/**
```

with:

```ts
} from './amazon-ledger.js';
import type { AmazonLedger } from './amazon-ledger.js';
import type { ActivityType, SimplefinTransaction, UnmappedAccount } from './types.js';
import type { ActivityWrite, HoldingsSyncOutcome, HostActivity, ImportRow, LinkLeg, LinkResult, SaveManyRequest, SaveManyResult, SyncHost, SyncStore } from './sync-host.js';
import {
  amazonLabelChange, amazonLabelOf, balanceCorrectionChange, bankUpdateChange, bookkeepingChange, duplicateRemovedChange,
  importChange, pendingRemovedChange, stampChange, startingBalanceChange, startingBalanceMovedChange, transferLinkChange,
  transferTypeChange,
  type BaselineState, type ChangeAccount, type ChangeDraft, type ChangeEntry, type ChangeLogSink, type LinkLegFacts,
} from './change-entries.js';

/**
```

Edit 2 of 16 in `shared/sync-core.ts` — replace:

```ts
export async function applyBaselineFix(
  host: SyncHost,
  args: { wfAccountId: string; sfAccountId: string; suggestedAmount: number; currency: string },
): Promise<{ applied: boolean; error?: string }> {
  const { wfAccountId, sfAccountId, suggestedAmount, currency } = args;
  // Re-read instead of trusting the id the snapshot was built with: that
  // snapshot can be minutes old, and this writes to a financial row by id.
```

with:

```ts
export async function applyBaselineFix(
  host: SyncHost,
  args: { wfAccountId: string; sfAccountId: string; suggestedAmount: number; currency: string },
): Promise<{ applied: boolean; error?: string; change?: BaselineMove }> {
  const { wfAccountId, sfAccountId, suggestedAmount, currency } = args;
  // Re-read instead of trusting the id the snapshot was built with: that
  // snapshot can be minutes old, and this writes to a financial row by id.
```

Edit 3 of 16 in `shared/sync-core.ts` — replace:

```ts
  if (res.errors.length > 0) {
    return { applied: false, error: res.errors.map((e) => `${e.action}: ${e.message}`).join('; ') };
  }
  return { applied: true };
}

/**
 * Keep the starting-balance baseline in front of the history it stands for.
```

with:

```ts
  if (res.errors.length > 0) {
    return { applied: false, error: res.errors.map((e) => `${e.action}: ${e.message}`).join('; ') };
  }
  return {
    applied: true,
    // For the change log: what the row was and what it is now.
    change: {
      activityId: baseline.id,
      before: { amountCents: Math.round(baseline.signed * 100), date: baseline.date, activityType: baseline.activityType },
      after: { amountCents: Math.round(suggestedAmount * 100), date: baseline.date, activityType: shape.activityType },
    },
  };
}

/** A starting balance rewritten in place: the row, before and after. */
export interface BaselineMove { activityId: string; before: BaselineState; after: BaselineState }

/**
 * Keep the starting-balance baseline in front of the history it stands for.
```

Edit 4 of 16 in `shared/sync-core.ts` — replace:

```ts
    /** The account's already-read rows: the lookup's fallback. */
    recent?: ReadonlyArray<{ wfId: string; comment?: string; date: string; type: string; absCents: number }>;
  },
): Promise<number> {
  const { wfAccountId, sfinAccountId, currency, accountType, created } = args;
  const sb = await fetchStartingBalance(host, wfAccountId, sfinAccountId, args.recent);
  if (!sb) return 0;
  const older = created.filter((c) => c.date <= sb.date);
  const olderSum = older.reduce((sum, c) => sum + c.signed, 0);
  const netting = Number.isFinite(olderSum) && Math.abs(olderSum) >= 0.01;
```

with:

```ts
    /** The account's already-read rows: the lookup's fallback. */
    recent?: ReadonlyArray<{ wfId: string; comment?: string; date: string; type: string; absCents: number }>;
  },
): Promise<BaselineMove | null> {
  const { wfAccountId, sfinAccountId, currency, accountType, created } = args;
  const sb = await fetchStartingBalance(host, wfAccountId, sfinAccountId, args.recent);
  if (!sb) return null;
  const older = created.filter((c) => c.date <= sb.date);
  const olderSum = older.reduce((sum, c) => sum + c.signed, 0);
  const netting = Number.isFinite(olderSum) && Math.abs(olderSum) >= 0.01;
```

Edit 5 of 16 in `shared/sync-core.ts` — replace:

```ts
    .filter((d): d is string => !!d)
    .reduce<string | null>((a, b) => (a === null || b < a ? b : a), null);
  const nextDate = earliest !== null && earliest <= sb.date ? dayBefore(earliest) : sb.date;
  if (!netting && nextDate === sb.date) return 0;
  const nextSigned = netting ? Math.round((sb.signed - olderSum) * 100) / 100 : sb.signed;
  const activityType = netting
    // Through the same chooser that wrote the row, or an adjustment would
    // quietly flip a neutral baseline back into income.
    ? startingBalanceFields(accountType, nextSigned).activityType
    : sb.activityType;
  await host.saveMany({
    updates: [{
      id: sb.id,
      accountId: wfAccountId,
```

with:

```ts
    .filter((d): d is string => !!d)
    .reduce<string | null>((a, b) => (a === null || b < a ? b : a), null);
  const nextDate = earliest !== null && earliest <= sb.date ? dayBefore(earliest) : sb.date;
  if (!netting && nextDate === sb.date) return null;
  const nextSigned = netting ? Math.round((sb.signed - olderSum) * 100) / 100 : sb.signed;
  const activityType = netting
    // Through the same chooser that wrote the row, or an adjustment would
    // quietly flip a neutral baseline back into income.
    ? startingBalanceFields(accountType, nextSigned).activityType
    : sb.activityType;
  const res = await host.saveMany({
    updates: [{
      id: sb.id,
      accountId: wfAccountId,
```

Edit 6 of 16 in `shared/sync-core.ts` — replace:

```ts
      comment: `${STARTING_BALANCE_COMMENT_PREFIX}${sfinAccountId}`,
    }],
  });
  return netting ? olderSum : 0;
}

/**
```

with:

```ts
      comment: `${STARTING_BALANCE_COMMENT_PREFIX}${sfinAccountId}`,
    }],
  });
  // What moved, for the change log — only when the host took the update.
  if ((res.errors ?? []).length > 0) return null;
  return {
    activityId: sb.id,
    before: { amountCents: Math.round(sb.signed * 100), date: sb.date, activityType: sb.activityType },
    after: { amountCents: Math.round(nextSigned * 100), date: nextDate, activityType },
  };
}

/**
```

Edit 7 of 16 in `shared/sync-core.ts` — replace:

```ts
export async function importAdjustmentActivity(
  host: SyncHost,
  args: { sfinAccountId: string; wfAccountId: string; currency: string; amount: number },
): Promise<void> {
  const { sfinAccountId, wfAccountId, currency, amount } = args;
  if (!Number.isFinite(amount) || Math.abs(amount) < 0.01) return;
  const today = new Date().toISOString().split('T')[0];
  const wfAccounts = await host.listAccounts().catch(() => []);
  const accountType = String(
```

with:

```ts
export async function importAdjustmentActivity(
  host: SyncHost,
  args: { sfinAccountId: string; wfAccountId: string; currency: string; amount: number },
): Promise<ImportRow | null> {
  const { sfinAccountId, wfAccountId, currency, amount } = args;
  if (!Number.isFinite(amount) || Math.abs(amount) < 0.01) return null;
  const today = new Date().toISOString().split('T')[0];
  const wfAccounts = await host.listAccounts().catch(() => []);
  const accountType = String(
```

Edit 8 of 16 in `shared/sync-core.ts` — replace:

```ts
  };
  try {
    await host.importActivities([adjustment]);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!msg.toLowerCase().includes('duplicate')) {
      throw e;
    }
  }
}

```

with:

```ts
  };
  try {
    await host.importActivities([adjustment]);
    // The row written, for the change log. Null below: nothing was written.
    return adjustment;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (!msg.toLowerCase().includes('duplicate')) {
      throw e;
    }
    return null;
  }
}

/**
 * The id of the row carrying `comment`, read back after an import — the
 * import endpoint reports no ids. Undefined when the read fails or finds
 * nothing: the change entry still names the row by its note.
 */
async function rowIdByComment(read: () => Promise<HostActivity[]>, comment: string): Promise<string | undefined> {
  try {
    return (await read()).find((a) => (a.comment ?? '') === comment)?.id;
  } catch {
    return undefined;
  }
}

```

Edit 9 of 16 in `shared/sync-core.ts` — replace:

```ts
          );
          if (!alreadyToday) {
            try {
              await importAdjustmentActivity(host, {
                sfinAccountId: sfAccount.id,
                wfAccountId,
                currency: sfAccount.currency,
                amount: drift,
              });
              imported += 1;
            } catch (e: any) {
              const msg = String(e?.message ?? e);
              if (!msg.toLowerCase().includes('duplicate')) {
```

with:

```ts
          );
          if (!alreadyToday) {
            try {
              const plug = await importAdjustmentActivity(host, {
                sfinAccountId: sfAccount.id,
                wfAccountId,
                currency: sfAccount.currency,
                amount: drift,
              });
              imported += 1;
              if (plug && logChange) {
                logChange(balanceCorrectionChange({
                  account: accountRef,
                  actor: 'auto',
                  activityId: await rowIdByComment(() => host.listActivities(wfAccountId), plug.comment),
                  amountCents: Math.round(drift * 100),
                  date: plug.date,
                  activityType: plug.activityType,
                  comment: plug.comment,
                }));
              }
            } catch (e: any) {
              const msg = String(e?.message ?? e);
              if (!msg.toLowerCase().includes('duplicate')) {
```

Edit 10 of 16 in `shared/sync-core.ts` — replace:

```ts
    // Every run, not only one that imported: a baseline stranded after older
    // history by an earlier version has no new row to trigger its repair.
    try {
      await keepStartingBalanceOldest(host, {
        wfAccountId,
        sfinAccountId: sfAccount.id,
        currency: sfAccount.currency,
```

with:

```ts
    // Every run, not only one that imported: a baseline stranded after older
    // history by an earlier version has no new row to trigger its repair.
    try {
      const moved = await keepStartingBalanceOldest(host, {
        wfAccountId,
        sfinAccountId: sfAccount.id,
        currency: sfAccount.currency,
```

Edit 11 of 16 in `shared/sync-core.ts` — replace:

```ts
        created: baselineCreated,
        recent: existing,
      });
    } catch (e: any) {
      errors.push(`Account ${wfAccountId} starting-balance adjust failed: ${e?.message ?? e}`);
    }
```

with:

```ts
        created: baselineCreated,
        recent: existing,
      });
      if (moved) logChange?.(startingBalanceMovedChange({ account: accountRef, actor: 'auto', ...moved }));
    } catch (e: any) {
      errors.push(`Account ${wfAccountId} starting-balance adjust failed: ${e?.message ?? e}`);
    }
```

Edit 12 of 16 in `shared/sync-core.ts` — replace:

```ts
        try {
          await host.importActivities([correction]);
          imported += 1;
        } catch (importErr: any) {
          // If the starting balance already exists or failed gracefully, log/ignore duplicate
          const msg = String(importErr?.message ?? importErr);
```

with:

```ts
        try {
          await host.importActivities([correction]);
          imported += 1;
          if (logChange) {
            logChange(startingBalanceChange({
              account: accountRef,
              activityId: await rowIdByComment(() => host.listOldestActivities(wfAccountId, STARTING_BALANCE_SCAN), correction.comment),
              amountCents: Math.round(starting * 100),
              date: correction.date,
              activityType: correction.activityType,
              comment: correction.comment,
            }));
          }
        } catch (importErr: any) {
          // If the starting balance already exists or failed gracefully, log/ignore duplicate
          const msg = String(importErr?.message ?? importErr);
```

Edit 13 of 16 in `shared/sync-core.ts` — replace:

```ts
            };
            await host.importActivities([correction]);
            imported += 1;
          }
          await store.addBalanceInitialized(p.sfinAccountId);
        } catch {
```

with:

```ts
            };
            await host.importActivities([correction]);
            imported += 1;
            if (logChange) {
              logChange(startingBalanceChange({
                account: {
                  sfinId: p.sfinAccountId,
                  wfId: p.wfAccountId,
                  name: wfNames.get(p.wfAccountId) || (accountSet.accounts.find((a) => a.id === p.sfinAccountId)?.name ?? ''),
                },
                activityId: await rowIdByComment(() => host.listOldestActivities(p.wfAccountId, STARTING_BALANCE_SCAN), correction.comment),
                amountCents: Math.round(starting * 100),
                date: correction.date,
                activityType: correction.activityType,
                comment: correction.comment,
              }));
            }
          }
          await store.addBalanceInitialized(p.sfinAccountId);
        } catch {
```

Edit 14 of 16 in `shared/sync-core.ts` — replace:

```ts
  // reasons are the diagnosis; the `unlinkedLegs` count below is the scale.
  const LINK_PROBLEM_REPORT_LIMIT = 3;
  let pairsWithReportedProblems = 0;
  for (const { legs, keys } of pairsToLink) {
    let result: LinkResult;
    try {
```

with:

```ts
  // reasons are the diagnosis; the `unlinkedLegs` count below is the scale.
  const LINK_PROBLEM_REPORT_LIMIT = 3;
  let pairsWithReportedProblems = 0;
  /** One leg of a confirmed link, as the change log names it. */
  const linkLegFacts = (leg: LinkLeg, key: string, newActivityId?: string): LinkLegFacts => {
    const sfinId = linkRowByKey.get(key)?.sfAccountId;
    const signed = signedByKey.get(key);
    return {
      account: {
        ...(sfinId ? { sfinId } : {}),
        wfId: leg.accountId,
        name: wfNames.get(leg.accountId) || (accountSet.accounts.find((a) => a.id === sfinId)?.name ?? ''),
      },
      txKey: key,
      description: descByKey.get(key) ?? descriptionFromComment(leg.comment),
      amountCents: signed !== undefined ? Math.round(signed * 100) : OUTFLOW_TYPES.has(leg.activityType) ? -leg.absCents : leg.absCents,
      date: leg.date,
      oldActivityId: leg.wfId,
      ...(newActivityId ? { newActivityId } : {}),
    };
  };
  for (const { legs, keys } of pairsToLink) {
    let result: LinkResult;
    try {
```

Edit 15 of 16 in `shared/sync-core.ts` — replace:

```ts
    } catch (e: any) {
      errors.push(`Transfer-link failed (${legs[0].txId}/${legs[1].txId}): ${e?.message ?? e}`);
      continue; // leave the ledger untouched so the pair retries next run
    }
    if (!result.linked || !result.groupId) {
      unlinkedLegs += legs.length;
```

with:

```ts
    } catch (e: any) {
      errors.push(`Transfer-link failed (${legs[0].txId}/${legs[1].txId}): ${e?.message ?? e}`);
      continue; // leave the ledger untouched so the pair retries next run
    }
    if (result.linked && result.groupId) {
      logChange?.(transferLinkChange(
        linkLegFacts(legs[0], keys[0], result.activityIds?.[0]),
        linkLegFacts(legs[1], keys[1], result.activityIds?.[1]),
      ));
    }
    if (!result.linked || !result.groupId) {
      unlinkedLegs += legs.length;
```

Edit 16 of 16 in `shared/sync-core.ts` — replace:

```ts
    for (const err of result.errors ?? []) {
      errors.push(`Transfer-relink save error (${err.action}): ${err.message}`);
    }
  }

  if (ledgerChanged) await store.setLinkedGroups(ledger);
```

with:

```ts
    for (const err of result.errors ?? []) {
      errors.push(`Transfer-relink save error (${err.action}): ${err.message}`);
    }
    if ((del.errors ?? []).length === 0 && (result.errors ?? []).length === 0) {
      const fresh = (result.created ?? []).map((a) => a.id).filter((id): id is string => !!id);
      logChange?.(bookkeepingChange({
        step: 'transfer-relink',
        activityIds: fresh.length === relinkCreates.length ? fresh : staleLegIds,
      }));
    }
  }

  if (ledgerChanged) await store.setLinkedGroups(ledger);
```

**Edit `shared/sync-host.ts`** — 1 edit. `LinkResult.activityIds`.

Edit 1 of 1 in `shared/sync-host.ts` — replace:

```ts
export interface LinkResult {
  linked: boolean;
  groupId?: string;
  /** Why the link failed, when it did. Present only on `linked: false`.
   *
   *  Linking DELETES both rows before re-creating them, so a refused re-create
```

with:

```ts
export interface LinkResult {
  linked: boolean;
  groupId?: string;
  /** The two re-created rows' ids, in leg order, when the host's echo carried
   *  them. Linking deletes and re-creates both legs, so these are NEW ids —
   *  the change log records them for R2. Absent from an older host. */
  activityIds?: [string, string];
  /** Why the link failed, when it did. Present only on `linked: false`.
   *
   *  Linking DELETES both rows before re-creating them, so a refused re-create
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/sync-core-change-log-balances.test.ts shared/link-pair.test.ts src/utils/sync.test.ts`
Expected: PASS — 7 + 9 + 93 tests.

Run: `npm test`
Expected: PASS — 1990 tests.

Run: `npm --prefix companion test`
Expected: PASS — 854 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/fake-host.ts shared/link-pair.test.ts shared/link-pair.ts shared/sync-core-change-log-balances.test.ts shared/sync-core.ts shared/sync-host.ts src/utils/sync.test.ts
git commit -m "Sync core: record starting balances, baseline moves, corrections and links, with the ids read back

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The add-on keeps its log: syncs, adjustments, baseline fixes, new accounts, Reset

The add-on's writer lives on `SecretsStore` (one store per add-on load, so a sync and a button share one queue). `runSync` hands the core a sink; Add adjustment and the baseline fix record `actor: 'you'` entries with the account's Wealthfolio name; creating a Wealthfolio account in the mapper records `account-created`; `clearAll` also deletes the change-log keys. Every caller optional-calls the new store methods, so test doubles and an older store record nothing and break nothing.

**Files:**
- Modify: `src/utils/secrets.ts`, `src/utils/sync.ts`, `shared/sync-core.ts` (export `rowIdByComment`), `src/components/AccountMapper.tsx`, `src/tabs/SettingsTab.tsx`, `src/pages/SetupPage.tsx`
- Test: `src/utils/change-log-store.test.ts`, `src/components/AccountMapper.test.tsx` (create)

**Interfaces:**
- Consumes: Task 1 (`newRunId`, `stampChange`, `accountCreatedChange`, `balanceCorrectionChange`, `startingBalanceMovedChange`, `ChangeAccount`, `ChangeDraft`, `ChangeEntry`, `ChangeLogSink`); Task 2 (`createChangeLogWriter`, `changeLogResetKeys`, `ChangeLogIo`); Task 3 (`readChangeLog`, `ChangeLogRead`); Task 5 (`importAdjustmentActivity` → row, `applyBaselineFix` → `change`).
- Produces:

```ts
// src/utils/secrets.ts — class SecretsStore
recordChanges(entries: ChangeEntry[]): Promise<void>;              // never rejects
recordChange(draft: ChangeDraft): Promise<void>;                   // stamps writer 'addon', now, no run
changeLogSink(now?: Date): ChangeLogSink;                          // { writer: 'addon', run: newRunId('addon', now), append }
getChangeLog(): Promise<ChangeLogRead | null>;                     // null when the host read fails
clearAll(): Promise<void>;                                         // + changeLogResetKeys(new Date())
// shared/sync-core.ts
export async function rowIdByComment(read: () => Promise<HostActivity[]>, comment: string): Promise<string | undefined>;
// src/components/AccountMapper.tsx — Props
onAccountCreated?: (created: { sfinId: string; wfId: string; name: string; accountType: string }) => void;
```

- In `src/utils/sync.ts` (module-private): `changeAccountFor(host: AddonSyncHost, store: SecretsStore, sfinAccountId: string, wfAccountId: string): Promise<ChangeAccount>`.

- [ ] **Step 1: Write the failing tests**

**Create `src/components/AccountMapper.test.tsx`:**

```tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountMapper } from './AccountMapper';

describe('AccountMapper', () => {
  it('reports an account it created, for the change log', async () => {
    const ctx = {
      api: {
        accounts: {
          getAll: vi.fn(async () => []),
          create: vi.fn(async () => ({ id: 'wf-new', name: 'Citi Card' })),
        },
      },
    } as any;
    const onAccountCreated = vi.fn();
    render(
      <AccountMapper
        ctx={ctx}
        simplefinAccounts={[{ id: 'ACT-9c8d', name: 'Citi Card', currency: 'USD', balance: '-464.60', 'balance-date': 1, transactions: [] } as any]}
        initialMapping={{}}
        onSave={vi.fn()}
        onAccountCreated={onAccountCreated}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__create_new__' } });
    fireEvent.click(screen.getByRole('button', { name: 'Credit Card' }));
    await waitFor(() => expect(onAccountCreated).toHaveBeenCalledWith({
      sfinId: 'ACT-9c8d', wfId: 'wf-new', name: 'Citi Card', accountType: 'CREDIT_CARD',
    }));
  });

  it('reports nothing when the create fails', async () => {
    const ctx = {
      api: { accounts: { getAll: vi.fn(async () => []), create: vi.fn(async () => { throw new Error('nope'); }) } },
    } as any;
    const onAccountCreated = vi.fn();
    render(
      <AccountMapper
        ctx={ctx}
        simplefinAccounts={[{ id: 'ACT-1', name: 'Spend', currency: 'USD', balance: '1', 'balance-date': 1, transactions: [] } as any]}
        initialMapping={{}}
        onSave={vi.fn()}
        onAccountCreated={onAccountCreated}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__create_new__' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bank / Cash' }));
    await screen.findByText('nope');
    expect(onAccountCreated).not.toHaveBeenCalled();
  });
});
```

**Create `src/utils/change-log-store.test.ts`:**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { accountCreatedChange, importChange, stampChange } from '../../shared/change-entries';
import type { ChangeBucket } from '../../shared/change-log';
import { SecretsStore } from './secrets';

vi.mock('./simplefin', () => ({ fetchAccounts: vi.fn() }));
import { fetchAccounts } from './simplefin';
import { applyBalanceAdjustment, applyBaselineCorrection, runSync, VALUATION_POLL } from './sync';

const NOW = new Date('2026-10-12T14:05:00Z');

/** The add-on's secrets and activities, in memory: what SecretsStore and
 *  AddonSyncHost both talk to. Imports are stored so a read-back finds them. */
function makeCtx(seed: Record<string, string> = {}) {
  const data: Record<string, string> = { ...seed };
  const rows: any[] = [];
  let next = 1;
  const ctx = {
    api: {
      network: { request: vi.fn() },
      secrets: {
        get: vi.fn(async (k: string) => data[k] ?? null),
        set: vi.fn(async (k: string, v: string) => { data[k] = v; }),
        delete: vi.fn(async (k: string) => { delete data[k]; }),
      },
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-a', name: 'Everyday Checking', accountType: 'CASH' }]) },
      portfolio: { getLatestValuations: vi.fn(async () => [{ accountId: 'wf-a', totalValue: 0 }]) },
      activities: {
        search: vi.fn(async () => ({ data: rows })),
        import: vi.fn(async (acts: any[]) => {
          for (const a of acts) rows.push({ ...a, id: `imp-${next++}` });
          return acts;
        }),
        saveMany: vi.fn(async (req: any) => ({
          created: (req.creates ?? []).map((c: any) => ({ ...c, id: `new-${next++}`, notes: c.comment })),
          updated: (req.updates ?? []).map((u: any) => ({ ...u, notes: u.comment })),
          deleted: req.deleteIds ?? [], createdMappings: [], errors: [],
        })),
      },
    },
  } as any;
  return { ctx, data, rows };
}

const bucket = (data: Record<string, string>, key: string): ChangeBucket => JSON.parse(data[key]);

describe('SecretsStore — the change log', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records something you did under the add-on’s own key for this month', async () => {
    const { ctx, data } = makeCtx();
    await new SecretsStore(ctx).recordChange(accountCreatedChange({ sfinId: 'ACT-1', wfId: 'wf-a', name: 'Citi Card', accountType: 'CREDIT_CARD' }));
    const b = bucket(data, 'change_log:addon:2026-10');
    expect(b.entries).toEqual([expect.objectContaining({
      writer: 'addon', actor: 'you', kind: 'account-created', at: NOW.toISOString(), summary: 'Created the Wealthfolio account Citi Card',
    })]);
  });

  it('hands runSync a sink with a fresh add-on run id', () => {
    const sink = new SecretsStore(makeCtx().ctx).changeLogSink(NOW);
    expect(sink.writer).toBe('addon');
    expect(sink.run).toBe(`a${NOW.getTime().toString(36)}`);
  });

  it('reads both writers’ buckets, newest first', async () => {
    const mk = (writer: 'addon' | 'companion', iso: string, n: number) => stampChange(importChange({
      account: { name: 'Checking' }, txKey: `k${n}`, activityId: `a${n}`, description: `ROW ${n}`, amountCents: -100,
      date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
    }), writer, new Date(iso));
    const { ctx } = makeCtx({
      'change_log:addon:2026-10': JSON.stringify({ v: 1, writer: 'addon', month: '2026-10', entries: [mk('addon', '2026-10-12T10:00:00Z', 1)], gaps: [] }),
      'change_log:companion:2026-10': JSON.stringify({ v: 1, writer: 'companion', month: '2026-10', entries: [mk('companion', '2026-10-12T11:00:00Z', 2)], gaps: [] }),
    });
    const read = await new SecretsStore(ctx).getChangeLog();
    expect(read!.entries.map((e) => e.subject.description)).toEqual(['ROW 2', 'ROW 1']);
  });

  it('reads null, not an empty log, when the host read fails', async () => {
    const { ctx } = makeCtx();
    ctx.api.secrets.get.mockRejectedValue(new Error('host down'));
    expect(await new SecretsStore(ctx).getChangeLog()).toBeNull();
  });

  it('Reset deletes both writers’ buckets and fallbacks for this month and the four before it', async () => {
    const { ctx, data } = makeCtx({
      'change_log:addon:2026-10': '{}',
      'change_log:companion:2026-10.2': '{}',
      'change_log:companion:2026-06': '{}',
      'change_log:addon:2026-05': '{}',
    });
    await new SecretsStore(ctx).clearAll();
    expect(data['change_log:addon:2026-10']).toBeUndefined();
    expect(data['change_log:companion:2026-10.2']).toBeUndefined();
    expect(data['change_log:companion:2026-06']).toBeUndefined();
    // Five months back is past what any writer keeps; it was cleared long ago.
    expect(data['change_log:addon:2026-05']).toBe('{}');
  });
});

describe('the add-on records its own writes', () => {
  beforeEach(() => {
    vi.mocked(fetchAccounts).mockReset();
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a sync in the app records its imports under the add-on’s key', async () => {
    const { ctx, data } = makeCtx({
      simplefin_access_url: 'https://u:p@bridge.simplefin.org/simplefin',
      account_mapping: JSON.stringify({ 'sfin-1': 'wf-a' }),
      balance_initialized: JSON.stringify(['sfin-1']),
    });
    vi.mocked(fetchAccounts).mockResolvedValueOnce({
      errors: [],
      accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': NOW.getTime() / 1000,
        transactions: [{ id: 'tx-1', posted: Date.parse('2026-10-11T12:00:00Z') / 1000, amount: '-12.34', description: 'KROGER #123' }],
      }],
    } as any);
    const result = await runSync(ctx, new SecretsStore(ctx), { force: true });
    expect(result.imported).toBe(1);
    const entries = bucket(data, 'change_log:addon:2026-10').entries;
    expect(entries).toEqual([expect.objectContaining({
      kind: 'import', writer: 'addon', actor: 'auto', summary: 'Imported KROGER #123',
      run: `a${NOW.getTime().toString(36)}`,
    })]);
  });

  it('Add adjustment records a balance correction by you, with the row read back', async () => {
    const { ctx, data } = makeCtx({ account_balances: JSON.stringify({ 'sfin-1': { balance: 10, currency: 'USD', date: 1, drift: 2.15 } }) });
    await applyBalanceAdjustment(ctx, new SecretsStore(ctx), { sfinAccountId: 'sfin-1', wfAccountId: 'wf-a', currency: 'USD', amount: 2.15 });
    expect(bucket(data, 'change_log:addon:2026-10').entries).toEqual([expect.objectContaining({
      kind: 'balance-correction', actor: 'you', summary: 'Added a $2.15 balance correction to Everyday Checking',
      account: { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Everyday Checking' },
      subject: { activityIds: ['imp-1'], amountCents: 215, date: '2026-10-12' },
    })]);
  });

  it('accepting the baseline fix records the move by you, before and after', async () => {
    const { ctx, data, rows } = makeCtx();
    rows.push({ id: 'sb-1', accountId: 'wf-a', activityType: 'DEPOSIT', date: '2026-06-19', amount: '11355.12', comment: 'Starting balance · sfin-1' });
    await applyBaselineCorrection(ctx, new SecretsStore(ctx), { sfinAccountId: 'sfin-1', wfAccountId: 'wf-a', currency: 'USD', suggestedAmount: 10055.12 });
    expect(bucket(data, 'change_log:addon:2026-10').entries).toEqual([expect.objectContaining({
      kind: 'starting-balance-moved', actor: 'you',
      summary: "Changed Everyday Checking's starting balance to $10,055.12 (was $11,355.12)",
      before: { activityId: 'sb-1', amountCents: 1135512, date: '2026-06-19', activityType: 'DEPOSIT' },
      after: { activityId: 'sb-1', amountCents: 1005512, date: '2026-06-19', activityType: 'CREDIT' },
    })]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/utils/change-log-store.test.ts src/components/AccountMapper.test.tsx`
Expected: FAIL — `recordChange`/`changeLogSink`/`getChangeLog` do not exist, nothing is written under `change_log:addon:…`, Reset leaves the buckets, and the mapper never calls `onAccountCreated`.

- [ ] **Step 3: Implement**

**Edit `shared/sync-core.ts`** — 1 edit. Export the read-back helper for the Add adjustment button.

Edit 1 of 1 in `shared/sync-core.ts` — replace:

```ts
 * import endpoint reports no ids. Undefined when the read fails or finds
 * nothing: the change entry still names the row by its note.
 */
async function rowIdByComment(read: () => Promise<HostActivity[]>, comment: string): Promise<string | undefined> {
  try {
    return (await read()).find((a) => (a.comment ?? '') === comment)?.id;
  } catch {
```

with:

```ts
 * import endpoint reports no ids. Undefined when the read fails or finds
 * nothing: the change entry still names the row by its note.
 */
export async function rowIdByComment(read: () => Promise<HostActivity[]>, comment: string): Promise<string | undefined> {
  try {
    return (await read()).find((a) => (a.comment ?? '') === comment)?.id;
  } catch {
```

**Edit `src/components/AccountMapper.tsx`** — 3 edits. The optional `onAccountCreated` prop, called after a create that succeeded.

Edit 1 of 3 in `src/components/AccountMapper.tsx` — replace:

```tsx
  simplefinAccounts: SimplefinAccount[];
  initialMapping: AccountMapping;
  onSave: (mapping: AccountMapping) => void;
}

const CREATE_NEW_VALUE = '__create_new__';
```

with:

```tsx
  simplefinAccounts: SimplefinAccount[];
  initialMapping: AccountMapping;
  onSave: (mapping: AccountMapping) => void;
  /** After a Wealthfolio account is created here — for the change log. */
  onAccountCreated?: (created: { sfinId: string; wfId: string; name: string; accountType: string }) => void;
}

const CREATE_NEW_VALUE = '__create_new__';
```

Edit 2 of 3 in `src/components/AccountMapper.tsx` — replace:

```tsx

type CreatableAccountType = (typeof ACCOUNT_TYPE_OPTIONS)[number]['type'];

export function AccountMapper({ ctx, simplefinAccounts, initialMapping, onSave }: Props) {
  const [wfAccounts, setWfAccounts] = useState<Array<{ id: string; name: string }>>([]);
  const [mapping, setMapping] = useState<AccountMapping>(initialMapping);
  const [loadError, setLoadError] = useState('');
```

with:

```tsx

type CreatableAccountType = (typeof ACCOUNT_TYPE_OPTIONS)[number]['type'];

export function AccountMapper({ ctx, simplefinAccounts, initialMapping, onSave, onAccountCreated }: Props) {
  const [wfAccounts, setWfAccounts] = useState<Array<{ id: string; name: string }>>([]);
  const [mapping, setMapping] = useState<AccountMapping>(initialMapping);
  const [loadError, setLoadError] = useState('');
```

Edit 3 of 3 in `src/components/AccountMapper.tsx` — replace:

```tsx
      });
      setWfAccounts((prev) => [...prev, { id: created.id, name: created.name }]);
      setMapping((prev) => ({ ...prev, [sfin.id]: created.id }));
    } catch (e: any) {
      setCreateErrors((prev) => ({
        ...prev,
```

with:

```tsx
      });
      setWfAccounts((prev) => [...prev, { id: created.id, name: created.name }]);
      setMapping((prev) => ({ ...prev, [sfin.id]: created.id }));
      onAccountCreated?.({ sfinId: sfin.id, wfId: created.id, name: created.name, accountType });
    } catch (e: any) {
      setCreateErrors((prev) => ({
        ...prev,
```

**Edit `src/pages/SetupPage.tsx`** — 2 edits. The same for the setup wizard's mapper.

Edit 1 of 2 in `src/pages/SetupPage.tsx` — replace:

```tsx
import { AccountMapper } from '../components/AccountMapper';
import { Button, Card, ErrorBox, Input } from '../components/ui';
import type { SecretsStore } from '../utils/secrets';

/** Two steps since 1.57: connect, then map. Rules start empty and the schedule
 *  starts at every 6 hours; both are in Settings for anyone who wants them. */
```

with:

```tsx
import { AccountMapper } from '../components/AccountMapper';
import { Button, Card, ErrorBox, Input } from '../components/ui';
import type { SecretsStore } from '../utils/secrets';
import { accountCreatedChange } from '../../shared/change-entries';

/** Two steps since 1.57: connect, then map. Rules start empty and the schedule
 *  starts at every 6 hours; both are in Settings for anyone who wants them. */
```

Edit 2 of 2 in `src/pages/SetupPage.tsx` — replace:

```tsx
              simplefinAccounts={sfAccounts}
              initialMapping={mapping}
              onSave={handleSaveMapping}
            />
          </div>
        </Card>
```

with:

```tsx
              simplefinAccounts={sfAccounts}
              initialMapping={mapping}
              onSave={handleSaveMapping}
              onAccountCreated={(created) => { void store.recordChange?.(accountCreatedChange(created)); }}
            />
          </div>
        </Card>
```

**Edit `src/tabs/SettingsTab.tsx`** — 2 edits. Import the builder; pass `onAccountCreated` to the mapper.

Edit 1 of 2 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
import type { SecretsStore, CategoryCatalogEntry, AccountBalanceInfo } from '../utils/secrets';
import type { Scheduler } from '../utils/scheduler';
import type { MappingRule, SimplefinAccount, AccountMapping } from '../../shared/types';

/** Ids for this tab's collapsible cards. Doubles as the persisted key set (the
 *  page owns the open-card map), so these strings must not change — a rename
```

with:

```tsx
import type { SecretsStore, CategoryCatalogEntry, AccountBalanceInfo } from '../utils/secrets';
import type { Scheduler } from '../utils/scheduler';
import type { MappingRule, SimplefinAccount, AccountMapping } from '../../shared/types';
import { accountCreatedChange } from '../../shared/change-entries';

/** Ids for this tab's collapsible cards. Doubles as the persisted key set (the
 *  page owns the open-card map), so these strings must not change — a rename
```

Edit 2 of 2 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
              simplefinAccounts={sfAccounts}
              initialMapping={mapping}
              onSave={saveMapping}
            />
            <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button variant="ghost" onClick={() => void loadAccounts()} disabled={accountsLoading}>
```

with:

```tsx
              simplefinAccounts={sfAccounts}
              initialMapping={mapping}
              onSave={saveMapping}
              onAccountCreated={(created) => { void store.recordChange?.(accountCreatedChange(created)); }}
            />
            <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button variant="ghost" onClick={() => void loadAccounts()} disabled={accountsLoading}>
```

**Edit `src/utils/secrets.ts`** — 3 edits. (1) imports; (2) the writer and the four methods, directly after the constructor; (3) `clearAll` also deletes the generated change-log keys.

Edit 1 of 3 in `src/utils/secrets.ts` — replace:

```ts
  SUBSCRIPTION_PREFS_SECRET_KEY, editSubscriptionPrefs as editPrefsDocument, loadSubscriptionPrefs,
  type LoadedSubscriptionPrefs, type SubscriptionEdit, type SubscriptionPrefs,
} from '../../shared/subscription-prefs';

/** Per-account balance snapshot captured on each sync, for the Sync page. */
/** One spending category as the companion published it. Mirrors
```

with:

```ts
  SUBSCRIPTION_PREFS_SECRET_KEY, editSubscriptionPrefs as editPrefsDocument, loadSubscriptionPrefs,
  type LoadedSubscriptionPrefs, type SubscriptionEdit, type SubscriptionPrefs,
} from '../../shared/subscription-prefs';
import { newRunId, stampChange, type ChangeDraft, type ChangeEntry, type ChangeLogSink } from '../../shared/change-entries';
import {
  changeLogResetKeys, createChangeLogWriter, readChangeLog, type ChangeLogIo, type ChangeLogRead,
} from '../../shared/change-log';

/** Per-account balance snapshot captured on each sync, for the Sync page. */
/** One spending category as the companion published it. Mirrors
```

Edit 2 of 3 in `src/utils/secrets.ts` — replace:

```ts

export class SecretsStore {
  constructor(private ctx: AddonContext) {}

  /** Writes this build's version where the companion's self-check can read it,
   *  so a half-finished update (image pulled, zip not — or the reverse) shows
```

with:

```ts

export class SecretsStore {
  constructor(private ctx: AddonContext) {}

  /** The add-on's change-log writer: ONE per store, and the add-on makes one
   *  store per load, so a sync and a button append through the same queue. */
  private readonly changeLog = createChangeLogWriter({
    writer: 'addon',
    log: (msg) => console.warn(`[simplefin-sync] ${msg}`),
  });

  private changeLogIo(): ChangeLogIo {
    return {
      get: (k) => this.ctx.api.secrets.get(k),
      set: (k, v) => this.ctx.api.secrets.set(k, v),
      clear: (k) => this.ctx.api.secrets.delete(k),
    };
  }

  /** Appends stamped entries. Never rejects: a failed append becomes a gap
   *  record on the next one (shared/change-log.ts). */
  async recordChanges(entries: ChangeEntry[]): Promise<void> {
    await this.changeLog.append(this.changeLogIo(), entries);
  }

  /** One entry for something the person did in the app (`actor: 'you'`). */
  async recordChange(draft: ChangeDraft): Promise<void> {
    await this.recordChanges([stampChange(draft, 'addon', new Date())]);
  }

  /** What `runSync` hands the core: this writer, a fresh run id. */
  changeLogSink(now = new Date()): ChangeLogSink {
    return { writer: 'addon', run: newRunId('addon', now), append: (entries) => this.recordChanges(entries) };
  }

  /** Both writers' log, merged. Null when the host read itself fails; a
   *  corrupt bucket is reported inside the result, not as null. */
  async getChangeLog(): Promise<ChangeLogRead | null> {
    try {
      return await readChangeLog((k) => this.ctx.api.secrets.get(k), new Date());
    } catch {
      return null;
    }
  }

  /** Writes this build's version where the companion's self-check can read it,
   *  so a half-finished update (image pulled, zip not — or the reverse) shows
```

Edit 3 of 3 in `src/utils/secrets.ts` — replace:

```ts
  }

  async clearAll(): Promise<void> {
    await Promise.all(Object.values(KEYS).map((k) => this.ctx.api.secrets.delete(k)));
  }
}
```

with:

```ts
  }

  async clearAll(): Promise<void> {
    // The change log's buckets are keyed by month, so they cannot sit in KEYS:
    // both writers' keys (and `.2` fallbacks) for this month and the four
    // before it are generated, since the secrets API cannot list keys.
    await Promise.all([...Object.values(KEYS), ...changeLogResetKeys(new Date())].map((k) => this.ctx.api.secrets.delete(k)));
  }
}
```

**Edit `src/utils/sync.ts`** — 5 edits. (1) imports; (2) `runSync` passes `opts.changeLog ?? store.changeLogSink?.()`; (3) Add adjustment and (4) the baseline fix record `actor: 'you'` entries after a write that landed; (5) `changeAccountFor` at the end of the file.

Edit 1 of 5 in `src/utils/sync.ts` — replace:

```ts
import { AddonSyncHost } from './addon-host';
import { applyBaselineFix, importAdjustmentActivity, runSyncCore } from '../../shared/sync-core';
import type { SyncOptions, SyncResult } from '../../shared/sync-core';
import {
  sendTelegramMessage,
  formatStuckTransferAlert,
```

with:

```ts
import { AddonSyncHost } from './addon-host';
import { applyBaselineFix, importAdjustmentActivity, rowIdByComment, runSyncCore } from '../../shared/sync-core';
import { balanceCorrectionChange, startingBalanceMovedChange, type ChangeAccount } from '../../shared/change-entries';
import type { SyncOptions, SyncResult } from '../../shared/sync-core';
import {
  sendTelegramMessage,
  formatStuckTransferAlert,
```

Edit 2 of 5 in `src/utils/sync.ts` — replace:

```ts
  opts: SyncOptions = {},
): Promise<SyncResult> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    const result = await runSyncCore(new AddonSyncHost(ctx), store, opts);
    // Deliver INSIDE the single-flight lock and inside the returned promise, so
    // one run announces its own alerts exactly once and a caller that awaits the
    // sync has also awaited the sends. `deliverAddonAlerts` never rejects, so it
    // cannot turn a successful sync into a failed one; a core that throws skips
```

with:

```ts
  opts: SyncOptions = {},
): Promise<SyncResult> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    // The change log rides along when the store can keep one (an older store
    // or a test double cannot, and then nothing is recorded).
    const changeLog = opts.changeLog ?? store.changeLogSink?.();
    const result = await runSyncCore(new AddonSyncHost(ctx), store, { ...opts, ...(changeLog ? { changeLog } : {}) });
    // Deliver INSIDE the single-flight lock and inside the returned promise, so
    // one run announces its own alerts exactly once and a caller that awaits the
    // sync has also awaited the sends. `deliverAddonAlerts` never rejects, so it
    // cannot turn a successful sync into a failed one; a core that throws skips
```

Edit 3 of 5 in `src/utils/sync.ts` — replace:

```ts
  store: SecretsStore,
  args: { sfinAccountId: string; wfAccountId: string; currency: string; amount: number },
): Promise<void> {
  if (!Number.isFinite(args.amount) || Math.abs(args.amount) < 0.01) return;
  await importAdjustmentActivity(new AddonSyncHost(ctx), args);
  // Clear the stored drift so the Sync page reflects the fix immediately.
  const balances = await store.getAccountBalances();
  if (balances[args.sfinAccountId]) {
    balances[args.sfinAccountId] = { ...balances[args.sfinAccountId], drift: null };
```

with:

```ts
  store: SecretsStore,
  args: { sfinAccountId: string; wfAccountId: string; currency: string; amount: number },
): Promise<void> {
  if (!Number.isFinite(args.amount) || Math.abs(args.amount) < 0.01) return;
  const host = new AddonSyncHost(ctx);
  const row = await importAdjustmentActivity(host, args);
  if (row && store.recordChange) {
    await store.recordChange(balanceCorrectionChange({
      account: await changeAccountFor(host, store, args.sfinAccountId, args.wfAccountId),
      actor: 'you',
      activityId: await rowIdByComment(() => host.listActivities(args.wfAccountId), row.comment),
      amountCents: Math.round(args.amount * 100),
      date: row.date,
      activityType: row.activityType,
      comment: row.comment,
    }));
  }
  // Clear the stored drift so the Sync page reflects the fix immediately.
  const balances = await store.getAccountBalances();
  if (balances[args.sfinAccountId]) {
    balances[args.sfinAccountId] = { ...balances[args.sfinAccountId], drift: null };
```

Edit 4 of 5 in `src/utils/sync.ts` — replace:

```ts
  ctx: AddonContext,
  store: SecretsStore,
  args: { sfinAccountId: string; wfAccountId: string; currency: string; suggestedAmount: number },
): Promise<void> {
  const res = await applyBaselineFix(new AddonSyncHost(ctx), {
    wfAccountId: args.wfAccountId,
    sfAccountId: args.sfinAccountId,
    suggestedAmount: args.suggestedAmount,
    currency: args.currency,
  });
  if (!res.applied) throw new Error(res.error ?? 'Baseline correction failed');
  // Drop the drift AND the now-spent offer, so the page stops showing both
  // without waiting for the next sync to recompute them.
  const balances = await store.getAccountBalances();
  const snap = balances[args.sfinAccountId];
```

with:

```ts
  ctx: AddonContext,
  store: SecretsStore,
  args: { sfinAccountId: string; wfAccountId: string; currency: string; suggestedAmount: number },
): Promise<void> {
  const host = new AddonSyncHost(ctx);
  const res = await applyBaselineFix(host, {
    wfAccountId: args.wfAccountId,
    sfAccountId: args.sfinAccountId,
    suggestedAmount: args.suggestedAmount,
    currency: args.currency,
  });
  if (!res.applied) throw new Error(res.error ?? 'Baseline correction failed');
  if (res.change && store.recordChange) {
    await store.recordChange(startingBalanceMovedChange({
      account: await changeAccountFor(host, store, args.sfinAccountId, args.wfAccountId),
      actor: 'you',
      ...res.change,
    }));
  }
  // Drop the drift AND the now-spent offer, so the page stops showing both
  // without waiting for the next sync to recompute them.
  const balances = await store.getAccountBalances();
  const snap = balances[args.sfinAccountId];
```

Edit 5 of 5 in `src/utils/sync.ts` — replace:

```ts
    balances[args.sfinAccountId] = { ...rest, drift: null };
    await store.setAccountBalances(balances);
  }
}
```

with:

```ts
    balances[args.sfinAccountId] = { ...rest, drift: null };
    await store.setAccountBalances(balances);
  }
}

/** An account as a change entry names it: Wealthfolio's name, else the bank's,
 *  else the id. Best-effort — a failed read never costs the action. */
async function changeAccountFor(
  host: AddonSyncHost,
  store: SecretsStore,
  sfinAccountId: string,
  wfAccountId: string,
): Promise<ChangeAccount> {
  const wfName = (await host.listAccounts().catch(() => [])).find((a) => a.id === wfAccountId)?.name;
  const sfName = wfName ? undefined : (await store.getAccountNames().catch(() => ({} as Record<string, string>)))[sfinAccountId];
  return { sfinId: sfinAccountId, wfId: wfAccountId, name: wfName || sfName || wfAccountId };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/utils/change-log-store.test.ts src/components/AccountMapper.test.tsx`
Expected: PASS — 8 + 2 tests.

Run: `npm test`
Expected: PASS — 2000 tests.

Run: `npm run type-check`
Expected: No errors.

Run: `npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/sync-core.ts src/components/AccountMapper.test.tsx src/components/AccountMapper.tsx src/pages/SetupPage.tsx src/tabs/SettingsTab.tsx src/utils/change-log-store.test.ts src/utils/secrets.ts src/utils/sync.ts
git commit -m "Add-on: keep the change log — syncs, Add adjustment, baseline fix, new accounts; Reset clears it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The companion keeps its log: the sync and the filings after it

`companion/src/change-log-host.ts` holds the companion's ONE writer (module-level, so the sync and Telegram taps share its queue) over the add-on secrets (clear = write `''`). `runCompanionSync` mints the sink (and so the run id) before `runSyncCore`, and the two after-sync steps record with that same run: the Amazon filer records a `category-filed` for each filing that landed — with the category a RULE had given (the native reader now returns it) or none — and the opening-debt filer records `opening-balance-filed` per row plus one `bookkeeping` entry when it created or excluded the category. Both modules take an optional `record` dep, so their existing tests are untouched.

**Files:**
- Create: `companion/src/change-log-host.ts`
- Modify: `companion/src/index.ts`, `companion/src/amazon-filing.ts`, `companion/src/opening-balance-category.ts`, `companion/src/sqlite-native.ts`
- Test: `companion/src/change-log-host.test.ts` (create); `companion/src/amazon-filing.test.ts`, `companion/src/opening-balance-category.test.ts`, `companion/src/index.test.ts`, `companion/src/sqlite-native.test.ts` (modify)

**Interfaces:**
- Consumes: Task 1 (`newRunId`, `stampChange`, `categoryFiledChange`, `openingBalanceFiledChange`, `bookkeepingChange`, `ChangeDraft`, `ChangeLogSink`); Task 2 (`createChangeLogWriter`, `ChangeLogIo`, `ChangeLogWriter`); Task 3 (`readChangeLog`, `ChangeLogRead`); `descriptionFromComment`, `txIdFromComment`, `STARTING_BALANCE_COMMENT_PREFIX` (`shared/sync-core.ts`); `accountTxKey`.
- Produces (`companion/src/change-log-host.ts`):

```ts
export interface SecretClient {
  getAddonSecret(addonId: string, key: string): Promise<string | null>;
  setAddonSecret(addonId: string, key: string, value: string): Promise<void>;
}
export const companionChangeLog: ChangeLogWriter;
export function companionChangeLogIo(client: SecretClient): ChangeLogIo;
export function companionChangeSink(client: SecretClient, now?: Date, writer?: ChangeLogWriter): ChangeLogSink;
export async function recordCompanionChanges(client: SecretClient, drafts: ChangeDraft[], run?: string, now?: Date, writer?: ChangeLogWriter): Promise<void>;
export function readCompanionChangeLog(client: SecretClient, now: Date): Promise<ChangeLogRead>;
```

- Produces (filings):

```ts
// companion/src/amazon-filing.ts
export interface AmazonFilingRow { activityId: string; notes: string; wfAccountId?: string; accountName?: string; amountCents?: number; date?: string; direction?: 'in' | 'out'; categoryId?: string; categoryName?: string }
// AmazonFilingDeps: uncategorized(): Promise<AmazonFilingRow[]>; ruleCategorized?(): Promise<AmazonFilingRow[]>;
//   record?(draft: ChangeDraft): void; sfinAccountOf?(wfAccountId: string): string | undefined;
// companion/src/opening-balance-category.ts — OpeningBalanceFilingDeps: record?: (draft: ChangeDraft) => void;
// companion/src/sqlite-native.ts
export interface NativeRuleCategorizedAmazonRow { activityId: string; notes: string; wfAccountId: string; accountName: string; amountCents: number; date: string; direction: 'in' | 'out'; categoryId: string; categoryName: string }
export function getNativeRuleCategorizedAmazonRows(dbPath: string, startInclusive: string, endExclusive: string): NativeRuleCategorizedAmazonRow[];
// companion/src/index.ts (module-private): fileAmazonLabelledCharges(wfClient: WealthfolioClient, run?: string): Promise<void>
```

- [ ] **Step 1: Write the failing tests**

**Edit `companion/src/amazon-filing.test.ts`** — 1 edit.

Edit 1 of 1 in `companion/src/amazon-filing.test.ts` — replace:

```ts
    expect(assigned).toHaveLength(1);
  });
});
```

with:

```ts
    expect(assigned).toHaveLength(1);
  });
});

describe('fileAmazonCharges — change log', () => {
  it('records each filing that landed, with the category it had before', async () => {
    const drafts: unknown[] = [];
    const { deps } = make({
      uncategorized: vi.fn(async () => [{
        activityId: 'a1', notes: 'AMAZON MKTPL*2K4 · Amazon: Skincare · TRN-1', wfAccountId: 'wf-citi', accountName: 'Citi',
        amountCents: 1080, date: '2026-09-15', direction: 'out' as const,
      }]),
      ruleCategorized: vi.fn(async () => [{
        activityId: 'r1', notes: 'AMAZON MKTPL · Amazon: Tools · TRN-2', wfAccountId: 'wf-citi', accountName: 'Citi',
        amountCents: 2500, date: '2026-09-16', direction: 'out' as const, categoryId: 'cat-online', categoryName: 'Online Shopping',
      }]),
      record: (d: unknown) => drafts.push(d),
      sfinAccountOf: (wf: string) => (wf === 'wf-citi' ? 'ACT-9c8d' : undefined),
    } as any);
    await fileAmazonCharges(deps as any);
    expect(drafts).toEqual([
      expect.objectContaining({
        kind: 'category-filed', actor: 'auto', summary: 'Filed AMAZON MKTPL*2K4 under Personal Care',
        why: 'Amazon: Skincare',
        account: { sfinId: 'ACT-9c8d', wfId: 'wf-citi', name: 'Citi' },
        subject: expect.objectContaining({ txKeys: ['ACT-9c8d\u0000TRN-1'], activityIds: ['a1'], amountCents: -1080 }),
        before: { categoryId: null, categoryName: null },
        after: { categoryId: 'cat-personal', categoryName: 'Personal Care' },
      }),
      expect.objectContaining({
        summary: 'Moved AMAZON MKTPL from Online Shopping to Housing',
        before: { categoryId: 'cat-online', categoryName: 'Online Shopping' },
        after: { categoryId: 'cat-housing', categoryName: 'Housing' },
      }),
    ]);
  });

  it('records nothing for a filing Wealthfolio refused', async () => {
    const drafts: unknown[] = [];
    const { deps } = make({
      uncategorized: vi.fn(async () => [{ activityId: 'a1', notes: 'Amazon · Amazon: Skincare · TRN-1' }]),
      assign: vi.fn(async () => { throw new Error('400'); }),
      record: (d: unknown) => drafts.push(d),
    } as any);
    await fileAmazonCharges(deps as any);
    expect(drafts).toEqual([]);
  });
});
```

**Create `companion/src/change-log-host.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { categoryRuleCreatedChange } from '../../shared/change-entries.js';
import { createChangeLogWriter, type ChangeBucket } from '../../shared/change-log.js';
import { companionChangeSink, readCompanionChangeLog, recordCompanionChanges, type SecretClient } from './change-log-host.js';

const NOW = new Date('2026-10-12T14:05:00Z');

function client(seed: Record<string, string> = {}): SecretClient & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getAddonSecret: vi.fn(async (_addon: string, k: string) => data.get(k) ?? null),
    setAddonSecret: vi.fn(async (_addon: string, k: string, v: string) => { data.set(k, v); }),
  };
}
const rule = () => categoryRuleCreatedChange({ ruleId: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro', categoryName: 'Groceries' });

describe('the companion change log', () => {
  it('writes the companion’s own key through the add-on secrets, and clears by writing an empty string', async () => {
    const c = client({ 'change_log:companion:2026-06': '{"old":1}' });
    const writer = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    await recordCompanionChanges(c, [rule()], undefined, NOW, writer);
    const b = JSON.parse(c.data.get('change_log:companion:2026-10')!) as ChangeBucket;
    expect(b.entries).toEqual([expect.objectContaining({ writer: 'companion', actor: 'you', kind: 'category-rule-created' })]);
    expect('run' in b.entries[0]).toBe(false);
    expect(c.setAddonSecret).toHaveBeenCalledWith('simplefin-sync', 'change_log:companion:2026-06', '');
  });

  it('stamps an after-sync step with the sync’s run', async () => {
    const c = client();
    const writer = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    const sink = companionChangeSink(c, NOW, writer);
    expect(sink.run).toBe(`c${NOW.getTime().toString(36)}`);
    await recordCompanionChanges(c, [rule()], sink.run, NOW, writer);
    expect((JSON.parse(c.data.get('change_log:companion:2026-10')!) as ChangeBucket).entries[0].run).toBe(sink.run);
  });

  it('a sync and a tap in the same moment both land', async () => {
    const c = client();
    const slow = c.getAddonSecret;
    c.getAddonSecret = vi.fn(async (a: string, k: string) => { await new Promise((r) => setTimeout(r, 5)); return slow(a, k); });
    const writer = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    const sink = companionChangeSink(c, NOW, writer);
    await Promise.all([
      sink.append([{ ...rule(), id: 'c1', at: NOW.toISOString(), writer: 'companion' }]),
      recordCompanionChanges(c, [rule()], undefined, NOW, writer),
    ]);
    expect((JSON.parse(c.data.get('change_log:companion:2026-10')!) as ChangeBucket).entries).toHaveLength(2);
  });

  it('reads the merged log', async () => {
    const c = client();
    const writer = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    await recordCompanionChanges(c, [rule()], undefined, NOW, writer);
    const read = await readCompanionChangeLog(c, NOW);
    expect(read.entries.map((e) => e.summary)).toEqual(['Created a rule: descriptions containing "TRADER JOE S" go to Groceries']);
  });
});
```

**Edit `companion/src/index.test.ts`** — 1 edit.

Edit 1 of 1 in `companion/src/index.test.ts` — replace:

```ts
      expect(vi.mocked(runSyncCore).mock.calls[0][2]).toMatchObject({ force: true });
    } finally {
      delete process.env.MIN_SYNC_INTERVAL_HOURS;
    }
  });
});
```

with:

```ts
      expect(vi.mocked(runSyncCore).mock.calls[0][2]).toMatchObject({ force: true });
    } finally {
      delete process.env.MIN_SYNC_INTERVAL_HOURS;
    }
  });

  it('hands the sync a change-log sink, and logs the Amazon filing after it under the same run', async () => {
    const at = new Date(2026, 9, 12, 8, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    const { WealthfolioClient } = await import('./wealthfolio.js');
    const original = vi.mocked(WealthfolioClient).getMockImplementation();
    try {
      const secrets = new Map<string, string>([
        ['simplefin_access_url', 'https://user:pass@bridge.simplefin.org/simplefin'],
        ['account_mapping', JSON.stringify({ 'ACT-9c8d': 'wf-citi' })],
      ]);
      const client = new (WealthfolioClient as any)();
      client.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
      client.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
      client.assignActivityCategory = vi.fn(async () => {});
      vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);
      vi.mocked(getNativeUncategorizedSpending).mockReturnValue([{
        activityId: 'a1', wfAccountId: 'wf-citi', notes: 'AMAZON MKTPL*2K4 · Amazon: Skincare · TRN-1', amountCents: 1080,
        date: '2026-09-15', accountName: 'Citi', direction: 'out', incomeEligible: false,
      }]);
      vi.mocked(getNativeSpendingCategories).mockReturnValue([{ id: 'cat-personal', name: 'Personal Care', parentId: null, parentName: null }] as any);

      await runCompanionSync();

      const sink = vi.mocked(runSyncCore).mock.calls[0][2]!.changeLog!;
      expect(sink).toMatchObject({ writer: 'companion', run: `c${at.getTime().toString(36)}` });
      const bucket = JSON.parse(secrets.get('change_log:companion:2026-10')!);
      expect(bucket.entries).toEqual([expect.objectContaining({
        kind: 'category-filed', run: sink.run, summary: 'Filed AMAZON MKTPL*2K4 under Personal Care',
        subject: expect.objectContaining({ txKeys: ['ACT-9c8d\u0000TRN-1'] }),
      })]);
    } finally {
      vi.mocked(getNativeUncategorizedSpending).mockReturnValue([]);
      vi.mocked(getNativeSpendingCategories).mockReturnValue([]);
      vi.mocked(WealthfolioClient).mockImplementation(original!);
      vi.useRealTimers();
    }
  });
});
```

**Edit `companion/src/opening-balance-category.test.ts`** — 1 edit.

Edit 1 of 1 in `companion/src/opening-balance-category.test.ts` — replace:

```ts
    expect(d.assign).not.toHaveBeenCalled();
  });
});
```

with:

```ts
    expect(d.assign).not.toHaveBeenCalled();
  });
});

describe('fileCardOpeningDebts — change log', () => {
  it('records the set-up as bookkeeping and each filing with its account and debt', async () => {
    const drafts: any[] = [];
    const d = { ...deps(ledger(`
      INSERT INTO activities VALUES ('o','card','WITHDRAWAL','2026-04-20T00:00:00Z','464.6','Starting balance · sfc');
    `)), record: (x: any) => drafts.push(x) };
    await fileCardOpeningDebts(d);
    expect(drafts.map((x) => [x.kind, x.summary])).toEqual([
      ['bookkeeping', 'Set up the "Opening balances" category and kept it out of spending'],
      ['opening-balance-filed', "Filed Citi's opening balance under Opening balances"],
    ]);
    expect(drafts[1]).toMatchObject({
      account: { sfinId: 'sfc', wfId: 'card', name: 'Citi' },
      subject: { activityIds: ['o'], amountCents: -46460, date: '2026-04-20', categoryName: 'Opening balances' },
      before: { categoryId: null, categoryName: null },
      after: { categoryId: 'new-cat', categoryName: 'Opening balances', taxonomyId: 'spending_categories' },
    });
  });

  it('records no set-up when the category and exclusion already exist', async () => {
    const drafts: any[] = [];
    const d = { ...deps(ledger(`
      INSERT INTO taxonomy_categories VALUES ('ob','Opening balances',NULL,'spending_categories');
      INSERT INTO app_settings VALUES ('spending.excluded_category_ids','["ob"]');
      INSERT INTO activities VALUES ('o','card','WITHDRAWAL','2026-04-20','464.6','Starting balance · sfc');
    `)), record: (x: any) => drafts.push(x) };
    await fileCardOpeningDebts(d);
    expect(drafts.map((x) => x.kind)).toEqual(['opening-balance-filed']);
  });
});
```

**Edit `companion/src/sqlite-native.test.ts`** — 2 edits.

Edit 1 of 2 in `companion/src/sqlite-native.test.ts` — replace:

```ts
        const db = new DatabaseSync(path);
        db.exec(`
          ALTER TABLE activity_taxonomy_assignments ADD COLUMN source TEXT;
          INSERT INTO activities (id, amount, activity_date, activity_type, notes) VALUES
            ('rule', '10.80', '2026-09-15T00:00:00Z', 'WITHDRAWAL', 'AMAZON MKTPL · Amazon: Hair Care · TRN-1'),
            ('mine', '20.00', '2026-09-15T00:00:00Z', 'WITHDRAWAL', 'AMAZON MKTPL · Amazon: Books · TRN-2'),
```

with:

```ts
        const db = new DatabaseSync(path);
        db.exec(`
          ALTER TABLE activity_taxonomy_assignments ADD COLUMN source TEXT;
          INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('c', 'Online Shopping', NULL);
          INSERT INTO activities (id, amount, activity_date, activity_type, notes) VALUES
            ('rule', '10.80', '2026-09-15T00:00:00Z', 'WITHDRAWAL', 'AMAZON MKTPL · Amazon: Hair Care · TRN-1'),
            ('mine', '20.00', '2026-09-15T00:00:00Z', 'WITHDRAWAL', 'AMAZON MKTPL · Amazon: Books · TRN-2'),
```

Edit 2 of 2 in `companion/src/sqlite-native.test.ts` — replace:

```ts
            ('old',  'c', 'spending_categories', 'rule');
        `);
        db.close();
        expect(getNativeRuleCategorizedAmazonRows(path, '2026-08-01', '2026-10-01')).toEqual([
          { activityId: 'rule', notes: 'AMAZON MKTPL · Amazon: Hair Care · TRN-1' },
        ]);
      } finally {
        cleanup();
      }
```

with:

```ts
            ('old',  'c', 'spending_categories', 'rule');
        `);
        db.close();
        // With the rule's category: the change log's "before" when the label's
        // category replaces it.
        expect(getNativeRuleCategorizedAmazonRows(path, '2026-08-01', '2026-10-01')).toEqual([{
          activityId: 'rule', notes: 'AMAZON MKTPL · Amazon: Hair Care · TRN-1', wfAccountId: 'acct-cash', accountName: 'Spend',
          amountCents: 1080, date: '2026-09-15', direction: 'out', categoryId: 'c', categoryName: 'Online Shopping',
        }]);
      } finally {
        cleanup();
      }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix companion test -- src/change-log-host.test.ts src/amazon-filing.test.ts src/opening-balance-category.test.ts src/sqlite-native.test.ts src/index.test.ts`
Expected: FAIL — `./change-log-host.js` does not exist; the filers never call `record`; the rule-categorized rows lack their category; `runSyncCore` is called without `changeLog`.

- [ ] **Step 3: Implement**

**Edit `companion/src/amazon-filing.ts`** — 6 edits. (1) imports; (2) `AmazonFilingRow`; (3) the two optional deps; (4) `recordFiling` — the entry for a filing that landed; (5) the mixed-order and (6) the labelled filing call it after `assign` succeeds.

Edit 1 of 6 in `companion/src/amazon-filing.ts` — replace:

```ts
 * charge is only labelled on a later sync anyway.
 */
import { DEFAULT_AMAZON_CATEGORY, resolveAmazonCategory, type AmazonMailConfig } from '../../shared/amazon-config.js';

/** Pulls the label out of an enriched note. `amazonDescription` writes
 *  ` · Amazon: <label>` (single) or ` · Amazon: mixed — a + b` (several), and
```

with:

```ts
 * charge is only labelled on a later sync anyway.
 */
import { DEFAULT_AMAZON_CATEGORY, resolveAmazonCategory, type AmazonMailConfig } from '../../shared/amazon-config.js';
import { categoryFiledChange, type ChangeDraft } from '../../shared/change-entries.js';
import { descriptionFromComment, txIdFromComment } from '../../shared/sync-core.js';
import { accountTxKey } from '../../shared/transfers.js';

/** Pulls the label out of an enriched note. `amazonDescription` writes
 *  ` · Amazon: <label>` (single) or ` · Amazon: mixed — a + b` (several), and
```

Edit 2 of 6 in `companion/src/amazon-filing.ts` — replace:

```ts
  return label;
}

export interface AmazonFilingDeps {
  /** Uncategorised rows in the window, as the notice's sweep already reads. */
  uncategorized(): Promise<Array<{ activityId: string; notes: string }>>;
  /**
   * Labelled Amazon rows whose spending category came from a categorization
   * RULE (assignment source "rule"). A rule runs on import, before the order
```

with:

```ts
  return label;
}

/** A row the filer may file. The optional fields describe it for the change
 *  log; `categoryId`/`categoryName` are the category a rule had given it. */
export interface AmazonFilingRow {
  activityId: string;
  notes: string;
  wfAccountId?: string;
  accountName?: string;
  /** Magnitude; `direction` carries the sign. */
  amountCents?: number;
  date?: string;
  direction?: 'in' | 'out';
  categoryId?: string;
  categoryName?: string;
}

export interface AmazonFilingDeps {
  /** Uncategorised rows in the window, as the notice's sweep already reads. */
  uncategorized(): Promise<AmazonFilingRow[]>;
  /**
   * Labelled Amazon rows whose spending category came from a categorization
   * RULE (assignment source "rule"). A rule runs on import, before the order
```

Edit 3 of 6 in `companion/src/amazon-filing.ts` — replace:

```ts
   * rule re-runs never overwrite; a category the user chose is also "manual"
   * and never appears here.
   */
  ruleCategorized?(): Promise<Array<{ activityId: string; notes: string }>>;
  /** Every spending category, for name → id. */
  categories(): Promise<Array<{ id: string; name: string }>>;
  readConfig(): Promise<AmazonMailConfig | null>;
  assign(activityId: string, categoryId: string): Promise<void>;
  log(msg: string): void;
}

export interface AmazonFilingResult {
```

with:

```ts
   * rule re-runs never overwrite; a category the user chose is also "manual"
   * and never appears here.
   */
  ruleCategorized?(): Promise<AmazonFilingRow[]>;
  /** Every spending category, for name → id. */
  categories(): Promise<Array<{ id: string; name: string }>>;
  readConfig(): Promise<AmazonMailConfig | null>;
  assign(activityId: string, categoryId: string): Promise<void>;
  log(msg: string): void;
  /** The change log: one draft per filing Wealthfolio accepted. */
  record?(draft: ChangeDraft): void;
  /** The SimpleFin account behind a Wealthfolio one, for the entry's tx key. */
  sfinAccountOf?(wfAccountId: string): string | undefined;
}

export interface AmazonFilingResult {
```

Edit 4 of 6 in `companion/src/amazon-filing.ts` — replace:

```ts
    // hand, and "personal care" should find "Personal Care" rather than
    // silently file nothing.
    const byName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c.id]));

    for (const { row, label } of labelled) {
      // A MIXED order goes straight to the configured default: one charge
```

with:

```ts
    // hand, and "personal care" should find "Personal Care" rather than
    // silently file nothing.
    const byName = new Map(categories.map((c) => [c.name.trim().toLowerCase(), c.id]));
    const nameOf = new Map(categories.map((c) => [c.id, c.name]));
    /** The change-log entry for a filing that just landed: what it was filed
     *  under before (a rule's choice, or nothing) and what it is now. */
    const recordFiling = (row: AmazonFilingRow, label: string, categoryId: string) => {
      if (!deps.record) return;
      const sfinId = row.wfAccountId ? deps.sfinAccountOf?.(row.wfAccountId) : undefined;
      const txId = txIdFromComment(row.notes);
      deps.record(categoryFiledChange({
        actor: 'auto',
        ...(row.wfAccountId ? { account: { ...(sfinId ? { sfinId } : {}), wfId: row.wfAccountId, name: row.accountName ?? '' } } : {}),
        ...(sfinId && txId ? { txKey: accountTxKey(sfinId, txId) } : {}),
        activityId: row.activityId,
        // The bank's own words: the label is the entry's `why`.
        description: descriptionFromComment(row.notes).split(' · Amazon: ')[0],
        ...(row.amountCents !== undefined ? { amountCents: row.direction === 'in' ? row.amountCents : -row.amountCents } : {}),
        ...(row.date ? { date: row.date } : {}),
        before: row.categoryId ? { categoryId: row.categoryId, categoryName: row.categoryName ?? '' } : null,
        after: { categoryId, categoryName: nameOf.get(categoryId) ?? '' },
        why: `Amazon: ${label}`,
      }));
    };

    for (const { row, label } of labelled) {
      // A MIXED order goes straight to the configured default: one charge
```

Edit 5 of 6 in `companion/src/amazon-filing.ts` — replace:

```ts
        try {
          await deps.assign(row.activityId, fallbackId);
          result.filed += 1;
        } catch (err) {
          deps.log(`Amazon filing: could not file mixed order ${row.activityId} under ${fallback}: ${String(err)}`);
        }
```

with:

```ts
        try {
          await deps.assign(row.activityId, fallbackId);
          result.filed += 1;
          recordFiling(row, label, fallbackId);
        } catch (err) {
          deps.log(`Amazon filing: could not file mixed order ${row.activityId} under ${fallback}: ${String(err)}`);
        }
```

Edit 6 of 6 in `companion/src/amazon-filing.ts` — replace:

```ts
      try {
        await deps.assign(row.activityId, categoryId);
        result.filed += 1;
      } catch (err) {
        // Per row: one refusal must not abandon the rest of the batch.
        deps.log(`Amazon filing: could not file ${row.activityId} under ${category}: ${String(err)}`);
```

with:

```ts
      try {
        await deps.assign(row.activityId, categoryId);
        result.filed += 1;
        recordFiling(row, label, categoryId);
      } catch (err) {
        // Per row: one refusal must not abandon the rest of the batch.
        deps.log(`Amazon filing: could not file ${row.activityId} under ${category}: ${String(err)}`);
```

**Create `companion/src/change-log-host.ts`:**

```ts
/**
 * companion/src/change-log-host.ts
 *
 * The companion's half of the change log (shared/change-log.ts): ONE writer
 * for the whole process, so the sync and a Telegram tap that land in the same
 * moment append through one queue and never overwrite each other. Storage is
 * the add-on's secrets over REST, which has no delete: a key is cleared by
 * writing `''`, which the reader treats as absent.
 */
import { newRunId, stampChange, type ChangeDraft, type ChangeLogSink } from '../../shared/change-entries.js';
import {
  createChangeLogWriter, readChangeLog, type ChangeLogIo, type ChangeLogRead, type ChangeLogWriter,
} from '../../shared/change-log.js';

const ADDON_ID = 'simplefin-sync';

/** What the change log needs of a `WealthfolioClient`. */
export interface SecretClient {
  getAddonSecret(addonId: string, key: string): Promise<string | null>;
  setAddonSecret(addonId: string, key: string, value: string): Promise<void>;
}

/** The process's writer. Tests make their own with `createChangeLogWriter`. */
export const companionChangeLog: ChangeLogWriter = createChangeLogWriter({
  writer: 'companion',
  log: (msg) => console.log(`[simplefin-sync] ${msg}`),
});

export function companionChangeLogIo(client: SecretClient): ChangeLogIo {
  return {
    get: (k) => client.getAddonSecret(ADDON_ID, k),
    set: (k, v) => client.setAddonSecret(ADDON_ID, k, v),
    clear: (k) => client.setAddonSecret(ADDON_ID, k, ''),
  };
}

/** What a companion sync hands `runSyncCore`: a fresh run id, this writer. */
export function companionChangeSink(
  client: SecretClient,
  now = new Date(),
  writer: ChangeLogWriter = companionChangeLog,
): ChangeLogSink {
  return {
    writer: 'companion',
    run: newRunId('companion', now),
    append: (entries) => writer.append(companionChangeLogIo(client), entries),
  };
}

/**
 * Stamps and appends drafts: a Telegram action (no run), or an after-sync
 * step (the sync's run). Never rejects — a failed append is a gap record on
 * the next one.
 */
export async function recordCompanionChanges(
  client: SecretClient,
  drafts: ChangeDraft[],
  run?: string,
  now = new Date(),
  writer: ChangeLogWriter = companionChangeLog,
): Promise<void> {
  if (drafts.length === 0) return;
  await writer.append(companionChangeLogIo(client), drafts.map((d) => stampChange(d, 'companion', now, run)));
}

/** Both writers' log, merged. Rejects when Wealthfolio cannot be read. */
export function readCompanionChangeLog(client: SecretClient, now: Date): Promise<ChangeLogRead> {
  return readChangeLog((k) => client.getAddonSecret(ADDON_ID, k), now);
}
```

**Edit `companion/src/index.ts`** — 5 edits. (1) imports; (2–3) the Amazon filer records with the sync's run, naming each filing's SimpleFin account from `account_mapping`; (4) the sync gets its sink; (5) the run id is passed to both filings, the opening filings recorded after its own `.catch`.

Edit 1 of 5 in `companion/src/index.ts` — replace:

```ts
import { createCategorizeController, SPENDING_TAXONOMY_ID } from './categorize.js';
import { createAmazonLabelMenu, type AmazonLabelMenu } from './amazon-labels.js';
import { fileAmazonCharges } from './amazon-filing.js';
import { createTransferLearning, type TransferLearning } from './transfer-learning.js';
import type { CategorizeController, CategorizeDeps } from './categorize.js';
import { AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, UNCATEGORIZED_STATUS_SECRET_KEY, POOL_STATUS_SECRET_KEY, type AmazonMailStatus, type AmazonMailSamples } from '../../shared/status-keys.js';
```

with:

```ts
import { createCategorizeController, SPENDING_TAXONOMY_ID } from './categorize.js';
import { createAmazonLabelMenu, type AmazonLabelMenu } from './amazon-labels.js';
import { fileAmazonCharges } from './amazon-filing.js';
import { companionChangeSink, recordCompanionChanges } from './change-log-host.js';
import type { ChangeDraft } from '../../shared/change-entries.js';
import { createTransferLearning, type TransferLearning } from './transfer-learning.js';
import type { CategorizeController, CategorizeDeps } from './categorize.js';
import { AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, UNCATEGORIZED_STATUS_SECRET_KEY, POOL_STATUS_SECRET_KEY, type AmazonMailStatus, type AmazonMailSamples } from '../../shared/status-keys.js';
```

Edit 2 of 5 in `companion/src/index.ts` — replace:

```ts
 * behaviour is precisely what wants fixing, and an order email can arrive days
 * after the charge it belongs to.
 */
async function fileAmazonLabelledCharges(wfClient: WealthfolioClient): Promise<void> {
  const dbPath = wealthfolioDbPath();
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 60);
  const res = await fileAmazonCharges({
    uncategorized: async () => getNativeUncategorizedSpending(dbPath, toDateString(start), toDateString(new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1))),
    ruleCategorized: async () => getNativeRuleCategorizedAmazonRows(dbPath, toDateString(start), toDateString(new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1))),
```

with:

```ts
 * behaviour is precisely what wants fixing, and an order email can arrive days
 * after the charge it belongs to.
 */
async function fileAmazonLabelledCharges(wfClient: WealthfolioClient, run?: string): Promise<void> {
  const dbPath = wealthfolioDbPath();
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 60);
  // The change log names the SimpleFin account behind each filing (its tx key
  // is account-scoped); the mapping is sfin → wf, so it is turned around.
  const mapping = parseSecretJson<Record<string, string>>(
    await wfClient.getAddonSecret('simplefin-sync', 'account_mapping').catch(() => null),
    'account_mapping',
  ) ?? {};
  const sfinOf = new Map(Object.entries(mapping).map(([sfin, wf]) => [wf, sfin]));
  const changes: ChangeDraft[] = [];
  const res = await fileAmazonCharges({
    uncategorized: async () => getNativeUncategorizedSpending(dbPath, toDateString(start), toDateString(new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1))),
    ruleCategorized: async () => getNativeRuleCategorizedAmazonRows(dbPath, toDateString(start), toDateString(new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1))),
```

Edit 3 of 5 in `companion/src/index.ts` — replace:

```ts
    assign: (activityId, categoryId) =>
      wfClient.assignActivityCategory(activityId, SPENDING_TAXONOMY_ID, categoryId),
    log,
  });
  if (res.filed > 0) log(`Filed ${res.filed} Amazon charge(s) into their mapped category.`);
  if (res.needRule.length > 0) {
    // Visible, not filed: these are exactly the labels the Amazon card counts
```

with:

```ts
    assign: (activityId, categoryId) =>
      wfClient.assignActivityCategory(activityId, SPENDING_TAXONOMY_ID, categoryId),
    log,
    record: (draft) => changes.push(draft),
    sfinAccountOf: (wfAccountId) => sfinOf.get(wfAccountId),
  });
  await recordCompanionChanges(wfClient, changes, run);
  if (res.filed > 0) log(`Filed ${res.filed} Amazon charge(s) into their mapped category.`);
  if (res.needRule.length > 0) {
    // Visible, not filed: these are exactly the labels the Amazon card counts
```

Edit 4 of 5 in `companion/src/index.ts` — replace:

```ts
    const amazonNewLabels = await pollAmazonMail(store, wfClient);

    log(`Fetching SimpleFin transactions from ${maskUrl(accessUrl)}...`);
    const result = await runSyncCore(host, store, { force });

    for (const err of result.errors) {
      log(`Sync note: ${err}`);
```

with:

```ts
    const amazonNewLabels = await pollAmazonMail(store, wfClient);

    log(`Fetching SimpleFin transactions from ${maskUrl(accessUrl)}...`);
    // One run id for the sync and the filings after it, so the change log
    // groups them as one run.
    const changeLog = companionChangeSink(wfClient);
    const result = await runSyncCore(host, store, { force, changeLog });

    for (const err of result.errors) {
      log(`Sync note: ${err}`);
```

Edit 5 of 5 in `companion/src/index.ts` — replace:

```ts
    // BEFORE publishing the uncategorized status, so the count the addon shows
    // and the notice's sweep both reflect what was just filed rather than
    // listing rows that now have a category.
    await fileAmazonLabelledCharges(wfClient);

    // A card's opening DEBT has to be a WITHDRAWAL on Wealthfolio 3.8, which its
    // Spending page reads as a purchase; filed under an excluded category it
    // counts nowhere. Best-effort, like the Amazon filing above.
    await fileCardOpeningDebts({
      dbPath: wealthfolioDbPath(),
      createCategory: (name) => wfClient.createSpendingCategory(name),
      setExcluded: (ids) => wfClient.setExcludedSpendingCategories(ids),
      assign: (activityId, categoryId) => wfClient.assignActivityCategory(activityId, SPENDING_TAXONOMY_ID, categoryId),
      log,
    }).catch((e) => log(`Card opening balance filing skipped: ${formatError(e)}`));

    // The Reports tab's live editions, from the ledger this sync just updated.
    await publishLiveReports(wfClient).catch((e) => log(`Live reports skipped: ${formatError(e)}`));
```

with:

```ts
    // BEFORE publishing the uncategorized status, so the count the addon shows
    // and the notice's sweep both reflect what was just filed rather than
    // listing rows that now have a category.
    await fileAmazonLabelledCharges(wfClient, changeLog.run);

    // A card's opening DEBT has to be a WITHDRAWAL on Wealthfolio 3.8, which its
    // Spending page reads as a purchase; filed under an excluded category it
    // counts nowhere. Best-effort, like the Amazon filing above.
    const openingChanges: ChangeDraft[] = [];
    await fileCardOpeningDebts({
      dbPath: wealthfolioDbPath(),
      createCategory: (name) => wfClient.createSpendingCategory(name),
      setExcluded: (ids) => wfClient.setExcludedSpendingCategories(ids),
      assign: (activityId, categoryId) => wfClient.assignActivityCategory(activityId, SPENDING_TAXONOMY_ID, categoryId),
      log,
      record: (draft) => openingChanges.push(draft),
    }).catch((e) => log(`Card opening balance filing skipped: ${formatError(e)}`));
    // After the catch: a filing that stopped half-way still logs what landed.
    await recordCompanionChanges(wfClient, openingChanges, changeLog.run);

    // The Reports tab's live editions, from the ledger this sync just updated.
    await publishLiveReports(wfClient).catch((e) => log(`Live reports skipped: ${formatError(e)}`));
```

**Edit `companion/src/opening-balance-category.ts`** — 5 edits. (1) imports; (2) the `record` dep and the row type; (3–4) the query returns the account, amount, day and note; (5) one bookkeeping entry when the category was created or excluded, and one `opening-balance-filed` per row filed.

Edit 1 of 5 in `companion/src/opening-balance-category.ts` — replace:

```ts
 */
import { existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';

export const OPENING_BALANCES_CATEGORY = 'Opening balances';
const TAXONOMY = 'spending_categories';
```

with:

```ts
 */
import { existsSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { bookkeepingChange, openingBalanceFiledChange, type ChangeDraft } from '../../shared/change-entries.js';
import { STARTING_BALANCE_COMMENT_PREFIX } from '../../shared/sync-core.js';

export const OPENING_BALANCES_CATEGORY = 'Opening balances';
const TAXONOMY = 'spending_categories';
```

Edit 2 of 5 in `companion/src/opening-balance-category.ts` — replace:

```ts
  setExcluded: (categoryIds: string[]) => Promise<void>;
  assign: (activityId: string, categoryId: string) => Promise<void>;
  log: (message: string) => void;
}

function open(dbPath: string): DatabaseSync | null {
  if (!dbPath || !existsSync(dbPath)) return null;
```

with:

```ts
  setExcluded: (categoryIds: string[]) => Promise<void>;
  assign: (activityId: string, categoryId: string) => Promise<void>;
  log: (message: string) => void;
  /** The change log: one draft per write that succeeded. */
  record?: (draft: ChangeDraft) => void;
}

interface OpeningDebtRow { id: string; account_id: string; account_name: string; amount: string; day: string; notes: string }

function open(dbPath: string): DatabaseSync | null {
  if (!dbPath || !existsSync(dbPath)) return null;
```

Edit 3 of 5 in `companion/src/opening-balance-category.ts` — replace:

```ts
export async function fileCardOpeningDebts(deps: OpeningBalanceFilingDeps): Promise<{ filed: number }> {
  const db = open(deps.dbPath);
  if (!db) return { filed: 0 };
  let rows: Array<{ id: string }>;
  let categoryId: string | undefined;
  let excluded: string[] = [];
  try {
    rows = db
      .prepare(
        `SELECT a.id FROM activities a JOIN accounts acc ON a.account_id = acc.id
         WHERE UPPER(acc.account_type) = 'CREDIT_CARD'
           AND UPPER(a.activity_type) = 'WITHDRAWAL'
           AND COALESCE(a.notes,'') LIKE 'Starting balance · %'
```

with:

```ts
export async function fileCardOpeningDebts(deps: OpeningBalanceFilingDeps): Promise<{ filed: number }> {
  const db = open(deps.dbPath);
  if (!db) return { filed: 0 };
  let rows: OpeningDebtRow[];
  let categoryId: string | undefined;
  let excluded: string[] = [];
  try {
    rows = db
      .prepare(
        `SELECT a.id, COALESCE(a.account_id,'') account_id, COALESCE(acc.name,'') account_name, COALESCE(a.amount,'0') amount,
                substr(COALESCE(a.activity_date,''),1,10) day, COALESCE(a.notes,'') notes
         FROM activities a JOIN accounts acc ON a.account_id = acc.id
         WHERE UPPER(acc.account_type) = 'CREDIT_CARD'
           AND UPPER(a.activity_type) = 'WITHDRAWAL'
           AND COALESCE(a.notes,'') LIKE 'Starting balance · %'
```

Edit 4 of 5 in `companion/src/opening-balance-category.ts` — replace:

```ts
             JOIN taxonomy_categories tc ON ata.category_id = tc.id
             WHERE ata.activity_id = a.id AND tc.taxonomy_id = ?)`,
      )
      .all(TAXONOMY) as Array<{ id: string }>;
    if (rows.length === 0) return { filed: 0 };
    categoryId = (
      db.prepare(`SELECT id FROM taxonomy_categories WHERE taxonomy_id = ? AND name = ?`).get(TAXONOMY, OPENING_BALANCES_CATEGORY) as
```

with:

```ts
             JOIN taxonomy_categories tc ON ata.category_id = tc.id
             WHERE ata.activity_id = a.id AND tc.taxonomy_id = ?)`,
      )
      .all(TAXONOMY) as unknown as OpeningDebtRow[];
    if (rows.length === 0) return { filed: 0 };
    categoryId = (
      db.prepare(`SELECT id FROM taxonomy_categories WHERE taxonomy_id = ? AND name = ?`).get(TAXONOMY, OPENING_BALANCES_CATEGORY) as
```

Edit 5 of 5 in `companion/src/opening-balance-category.ts` — replace:

```ts
    db.close();
  }

  if (!categoryId) {
    categoryId = await deps.createCategory(OPENING_BALANCES_CATEGORY);
    deps.log(`Created the "${OPENING_BALANCES_CATEGORY}" spending category for card opening balances.`);
  }
  if (!excluded.includes(categoryId)) {
    // Appended to the user's own list, never replacing it.
    await deps.setExcluded([...excluded, categoryId]);
    deps.log(`Excluded "${OPENING_BALANCES_CATEGORY}" from spending, so an opening debt is not read as a purchase.`);
  }
  for (const row of rows) await deps.assign(row.id, categoryId);
  deps.log(`Filed ${rows.length} card opening balance(s) under "${OPENING_BALANCES_CATEGORY}".`);
  return { filed: rows.length };
}
```

with:

```ts
    db.close();
  }

  let setUp = false;
  if (!categoryId) {
    categoryId = await deps.createCategory(OPENING_BALANCES_CATEGORY);
    deps.log(`Created the "${OPENING_BALANCES_CATEGORY}" spending category for card opening balances.`);
    setUp = true;
  }
  if (!excluded.includes(categoryId)) {
    // Appended to the user's own list, never replacing it.
    await deps.setExcluded([...excluded, categoryId]);
    deps.log(`Excluded "${OPENING_BALANCES_CATEGORY}" from spending, so an opening debt is not read as a purchase.`);
    setUp = true;
  }
  if (setUp) deps.record?.(bookkeepingChange({ step: 'opening-category', activityIds: [], categoryName: OPENING_BALANCES_CATEGORY }));
  for (const row of rows) {
    await deps.assign(row.id, categoryId);
    deps.record?.(openingBalanceFiledChange({
      account: {
        ...(row.notes.startsWith(STARTING_BALANCE_COMMENT_PREFIX) ? { sfinId: row.notes.slice(STARTING_BALANCE_COMMENT_PREFIX.length) } : {}),
        wfId: row.account_id,
        name: row.account_name,
      },
      activityId: row.id,
      // A card's opening DEBT: money owed, so negative.
      amountCents: -Math.round(Math.abs(Number(row.amount) || 0) * 100),
      date: row.day,
      category: { categoryId, categoryName: OPENING_BALANCES_CATEGORY, taxonomyId: TAXONOMY },
    }));
  }
  deps.log(`Filed ${rows.length} card opening balance(s) under "${OPENING_BALANCES_CATEGORY}".`);
  return { filed: rows.length };
}
```

**Edit `companion/src/sqlite-native.ts`** — 3 edits. The rule-categorized reader also returns the row's account, amount, date, direction and the rule's category (id and name).

Edit 1 of 3 in `companion/src/sqlite-native.ts` — replace:

```ts
  });
}

/**
 * Amazon charges the order emails have labelled (`· Amazon: <label>` in the
 * note) whose spending category was set by a categorization RULE — the
```

with:

```ts
  });
}

/** A labelled Amazon charge a RULE filed, with the category the rule chose —
 *  the "before" the change log records when the label's category replaces it. */
export interface NativeRuleCategorizedAmazonRow {
  activityId: string;
  notes: string;
  wfAccountId: string;
  accountName: string;
  amountCents: number;
  /** ISO date (yyyy-mm-dd). */
  date: string;
  direction: 'in' | 'out';
  categoryId: string;
  /** '' when the category row is missing. */
  categoryName: string;
}

/**
 * Amazon charges the order emails have labelled (`· Amazon: <label>` in the
 * note) whose spending category was set by a categorization RULE — the
```

Edit 2 of 3 in `companion/src/sqlite-native.ts` — replace:

```ts
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): Array<{ activityId: string; notes: string }> {
  if (!dbPath || !existsSync(dbPath)) return [];
  if (!validDateBounds(startInclusive, endExclusive)) return [];
  const query = `
    SELECT a.id, COALESCE(a.notes, '')
    FROM activities a
    JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
    WHERE ata.taxonomy_id = 'spending_categories'
      AND LOWER(COALESCE(ata.source, '')) = 'rule'
      AND COALESCE(a.notes, '') LIKE '%· Amazon:%'
```

with:

```ts
  dbPath: string,
  startInclusive: string,
  endExclusive: string,
): NativeRuleCategorizedAmazonRow[] {
  if (!dbPath || !existsSync(dbPath)) return [];
  if (!validDateBounds(startInclusive, endExclusive)) return [];
  const query = `
    SELECT a.id AS activity_id, COALESCE(a.notes, '') AS notes, COALESCE(a.account_id, '') AS account_id,
           COALESCE(ac.name, '') AS account_name, ROUND(ABS(CAST(a.amount AS REAL)) * 100) AS amount_cents,
           substr(a.activity_date, 1, 10) AS activity_date,
           CASE WHEN UPPER(a.activity_type) IN ('WITHDRAWAL', 'FEE', 'TAX')
                  OR (UPPER(a.activity_type) = 'INTEREST' AND UPPER(COALESCE(ac.account_type, '')) = 'CREDIT_CARD')
                THEN 'out' ELSE 'in' END AS direction,
           COALESCE(ata.category_id, '') AS category_id, COALESCE(tc.name, '') AS category_name
    FROM activities a
    JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
    LEFT JOIN accounts ac ON a.account_id = ac.id
    LEFT JOIN taxonomy_categories tc ON tc.id = ata.category_id AND tc.taxonomy_id = ata.taxonomy_id
    WHERE ata.taxonomy_id = 'spending_categories'
      AND LOWER(COALESCE(ata.source, '')) = 'rule'
      AND COALESCE(a.notes, '') LIKE '%· Amazon:%'
```

Edit 3 of 3 in `companion/src/sqlite-native.ts` — replace:

```ts
    dbPath,
    'rule-categorized-amazon',
    query,
    (parts) => (parts.length === 2 ? { c0: parts[0], c1: parts[1] } : null),
  );
  return rows.map((r) => {
    const vals = Object.values(r);
    return { activityId: String(vals[0]), notes: String(vals[1]) };
  });
}

```

with:

```ts
    dbPath,
    'rule-categorized-amazon',
    query,
    (parts) => (parts.length === 9
      ? { c0: parts[0], c1: parts[1], c2: parts[2], c3: parts[3], c4: parseFloat(parts[4]) || 0, c5: parts[5], c6: parts[6], c7: parts[7], c8: parts[8] }
      : null),
  );
  return rows.map((r) => {
    // Column-named objects from node:sqlite, c0..c8 from the CLI: positional either way.
    const v = Object.values(r);
    return {
      activityId: String(v[0]),
      notes: String(v[1]),
      wfAccountId: String(v[2]),
      accountName: String(v[3]),
      amountCents: Math.round(Number(v[4]) || 0),
      date: String(v[5]).slice(0, 10),
      direction: (String(v[6]) === 'out' ? 'out' : 'in') as 'in' | 'out',
      categoryId: String(v[7]),
      categoryName: String(v[8]),
    };
  });
}

```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix companion test -- src/change-log-host.test.ts src/amazon-filing.test.ts src/opening-balance-category.test.ts src/sqlite-native.test.ts src/index.test.ts`
Expected: PASS — 4 + 19 + 6 + 92 + 271 tests.

Run: `npm --prefix companion test`
Expected: PASS — 863 tests.

Run: `npm --prefix companion run build`
Expected: Succeeds.

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add companion/src/amazon-filing.test.ts companion/src/amazon-filing.ts companion/src/change-log-host.test.ts companion/src/change-log-host.ts companion/src/index.test.ts companion/src/index.ts companion/src/opening-balance-category.test.ts companion/src/opening-balance-category.ts companion/src/sqlite-native.test.ts companion/src/sqlite-native.ts
git commit -m "Companion: keep the change log — the sync, and the Amazon and opening-balance filings under its run

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The companion records what you do in Telegram, and keeps the rule id

Every Telegram write that changes the books is recorded `actor: 'you'`: a `/categorize` filing and its ↩ Undo, a `/recategorize` move (with the whole prior assignment set) and its Undo, and a category rule from `Make this a rule` or `/newrule` (both go through `runCreateRule`). `createCategorizationRule` now resolves the id the server returns (P5), the controller's `createRule` dep passes it on, and the rule entry keeps it. The transfer-learning menu records the mapping rule it appends. Recorders are optional deps read at call time; a throw is logged and swallowed, so the user's flow always finishes.

**Files:**
- Modify: `companion/src/wealthfolio.ts`, `companion/src/categorize.ts`, `companion/src/transfer-learning.ts`, `companion/src/index.ts`
- Test: `companion/src/wealthfolio.test.ts`, `companion/src/categorize.test.ts`, `companion/src/transfer-learning.test.ts`, `companion/src/index.test.ts` (modify)

**Interfaces:**
- Consumes: Task 1 (`categoryFiledChange`, `categoryRuleCreatedChange`, `mappingRuleCreatedChange`, `ChangeDraft`, `FiledCategory`); Task 7 (`recordCompanionChanges`).
- Produces:

```ts
// companion/src/wealthfolio.ts — WealthfolioClient
createCategorizationRule(rule: { name: string; pattern: string; categoryId: string; taxonomyId: string; priority: number }): Promise<string | null>;   // was Promise<void>
// companion/src/categorize.ts — CategorizeDeps
createRule: (rule: { name: string; pattern: string; categoryId: string }) => Promise<string | null | void>;   // was Promise<void>
record?: (draft: ChangeDraft) => void;
// companion/src/transfer-learning.ts — TransferLearningDeps
record?(draft: ChangeDraft): void;
```

- Module-private in the controller: `record(draft)`, `categoryNameIn(sources, categoryId): string`, `rowFacts(row: CategorizeTxn | null)`, `filedAsCategory(a): FiledCategory`.

- [ ] **Step 1: Write the failing tests**

**Edit `companion/src/categorize.test.ts`** — 1 edit.

Edit 1 of 1 in `companion/src/categorize.test.ts` — replace:

```ts
    expect(lastCall(h.send)[0]).toMatch(/not in the category menu any more/);
  });
});
```

with:

```ts
    expect(lastCall(h.send)[0]).toMatch(/not in the category menu any more/);
  });
});

describe('change log', () => {
  /** The controller reads `deps.record` when it writes, so a test can attach it after setup. */
  const recording = (h: ReturnType<typeof setup>) => {
    const recorded: any[] = [];
    (h.deps as any).record = (d: unknown) => recorded.push(d);
    return recorded;
  };

  it('records a filing with no category before it', async () => {
    const h = setup();
    const recorded = recording(h);
    await openAtFiled(h);
    expect(recorded).toEqual([expect.objectContaining({
      kind: 'category-filed', actor: 'you', summary: 'Filed BOOK STORES a under Entertainment',
      account: { name: 'Citi Double Cash' },
      subject: expect.objectContaining({ activityIds: ['a'], description: 'BOOK STORES a', date: '2026-08-08', categoryName: 'Entertainment' }),
      before: { categoryId: null, categoryName: null },
      after: { categoryId: 'cat-fun', categoryName: 'Entertainment' },
    })]);
  });

  it('records the filing’s Undo as taking the category back off', async () => {
    const h = setup();
    const recorded = recording(h);
    const filed = await openAtFiled(h);
    await h.tap(dataFor(filed, '↩ Undo'));
    expect(recorded.map((d) => d.summary)).toEqual([
      'Filed BOOK STORES a under Entertainment',
      'Took BOOK STORES a out of Entertainment',
    ]);
    expect(recorded[1].before).toEqual({ categoryId: 'cat-fun', categoryName: 'Entertainment', taxonomyId: SPENDING_TAXONOMY_ID });
    expect(recorded[1].after).toEqual({ categoryId: null, categoryName: null });
  });

  it('records nothing for a filing Wealthfolio refused', async () => {
    const h = setup();
    const recorded = recording(h);
    const picker = await openAtTxn(h);
    h.deps.assign.mockRejectedValueOnce(new Error('500'));
    await h.tap(dataFor(picker, 'Entertainment'));
    expect(recorded).toEqual([]);
  });

  it('records a move with the whole prior state, and its Undo', async () => {
    const h = setup({ categorized: [GROCERIES] });
    const recorded = recording(h);
    const refiled = await openRecatAtRefiled(h, 'TRADER JOES b');
    await h.tap(dataFor(refiled, '↩ Undo'));
    expect(recorded.map((d) => d.summary)).toEqual([
      'Moved TRADER JOES b from Restaurants to Entertainment',
      'Moved TRADER JOES b from Entertainment to Restaurants',
    ]);
    expect(recorded[0].before).toEqual({
      categoryId: 'cat-rest', categoryName: 'Restaurants', taxonomyId: SPENDING_TAXONOMY_ID,
      assignments: [{ taxonomyId: SPENDING_TAXONOMY_ID, categoryId: 'cat-rest' }],
    });
  });

  it('records a rule with the id the server gave it', async () => {
    const h = setup();
    const recorded = recording(h);
    h.deps.createRule.mockResolvedValueOnce('rule-7' as never);
    await h.controller.openRulePreview('TRADER JOE*S', 'cat-fun', h.send);
    await h.tap(dataFor(keyboardOf(lastCall(h.send)), 'Create rule'));
    expect(recorded).toEqual([expect.objectContaining({
      kind: 'category-rule-created', actor: 'you',
      summary: 'Created a rule: descriptions containing "TRADER JOE*S" go to Entertainment',
      subject: { ruleId: 'rule-7', rulePattern: 'TRADER JOE*S', categoryName: 'Entertainment' },
      after: { ruleId: 'rule-7', name: 'Telegram: TRADER JOE*S', pattern: 'TRADER JOE*S', categoryId: 'cat-fun', categoryName: 'Entertainment' },
    })]);
  });

  it('records nothing for a refused rule', async () => {
    const h = setup();
    const recorded = recording(h);
    h.deps.createRule.mockRejectedValueOnce(new Error('422 duplicate rule'));
    await h.controller.openRulePreview('TRADER JOE*S', 'cat-fun', h.send);
    await h.tap(dataFor(keyboardOf(lastCall(h.send)), 'Create rule'));
    expect(recorded).toEqual([]);
  });

  it('finishes the filing when recording throws', async () => {
    const h = setup();
    (h.deps as any).record = () => { throw new Error('log down'); };
    const filed = await openAtFiled(h);
    expect(labels(filed)).toContain('↩ Undo');
    expect(h.logs.join('\n')).toContain('recording a change failed: log down');
  });
});
```

**Edit `companion/src/index.test.ts`** — 1 edit.

Edit 1 of 1 in `companion/src/index.test.ts` — replace:

```ts
    });
  });

  describe('writeLedgerMerged', () => {
    it('re-reads the ledger immediately before writing, so a third party\'s dismissal survives', async () => {
      // THE 1.10.1 bug, in the shape this dep can reintroduce it: passing the
```

with:

```ts
    });
  });

  it('logs a filing and the rule made from it in the companion’s change log, with the rule’s id', async () => {
    const { client, secrets } = clientFor();
    client.createCategorizationRule.mockResolvedValue('rule-7');
    const controller = buildCategorizeController(client);
    const { sent, reply } = collect();
    await buildTelegramCommandHandler(client, controller)({ command: 'categorize', args: '' }, reply);
    const ui = fakeUi();
    const cb = (data: string) => controller.onCallback({ data, chatId: 4242, messageId: 7 }, ui);
    await cb(dataFor(sent[0][1], 'BOOK STORES'));
    await cb(dataFor(lastOf(ui.edit)[1], 'Entertainment'));
    await cb(dataFor(lastOf(ui.edit)[1], 'Make this a rule'));
    await cb(dataFor(lastOf(ui.edit)[1], 'Create rule'));
    const logged = () => [...secrets.entries()]
      .filter(([k, v]) => /^change_log:companion:\d{4}-\d{2}$/.test(k) && v)
      .flatMap(([, v]) => JSON.parse(v).entries);
    await vi.waitFor(() => expect(logged()).toHaveLength(2));
    expect(logged().map((e: any) => [e.kind, e.actor, e.writer, e.summary])).toEqual([
      ['category-filed', 'you', 'companion', 'Filed BOOK STORES under Entertainment'],
      ['category-rule-created', 'you', 'companion', 'Created a rule: descriptions containing "BOOK STORES" go to Entertainment'],
    ]);
    expect(logged()[1].subject.ruleId).toBe('rule-7');
  });

  describe('writeLedgerMerged', () => {
    it('re-reads the ledger immediately before writing, so a third party\'s dismissal survives', async () => {
      // THE 1.10.1 bug, in the shape this dep can reintroduce it: passing the
```

**Edit `companion/src/transfer-learning.test.ts`** — 1 edit.

Edit 1 of 1 in `companion/src/transfer-learning.test.ts` — replace:

```ts
    expect(u.answer).toHaveBeenCalledWith(expect.stringMatching(/cannot become a transfer rule/));
    expect(deps.writeRules).not.toHaveBeenCalled();
  });
});
```

with:

```ts
    expect(u.answer).toHaveBeenCalledWith(expect.stringMatching(/cannot become a transfer rule/));
    expect(deps.writeRules).not.toHaveBeenCalled();
  });
});

describe('transfer learning — change log', () => {
  it('records the rule it wrote, and only that', async () => {
    const recorded: any[] = [];
    const state = { rules: [] as any[] };
    const menu = createTransferLearning({
      readRules: vi.fn(async () => state.rules),
      writeRules: vi.fn(async (r: any[]) => { state.rules = r; }),
      log: vi.fn(),
      record: (d) => recorded.push(d),
    });
    await teach(menu, [tx()]);
    expect(recorded).toEqual([expect.objectContaining({
      kind: 'mapping-rule-created', actor: 'you', undoable: true,
      summary: 'Added a transaction rule: "Payment to Ccb Credit Card Payments" is a transfer out',
      account: { name: 'Spend (4937)' },
      after: { rule: { pattern: 'Payment to Ccb Credit Card Payments', matchType: 'contains', activityType: 'TRANSFER_OUT' } },
    })]);
    // Taught again: the rule already exists, nothing new was written or recorded.
    await teach(menu, [tx()]);
    expect(recorded).toHaveLength(1);
  });

  it('keeps the rule even when recording it throws', async () => {
    const state = { rules: [] as any[] };
    const log = vi.fn();
    const menu = createTransferLearning({
      readRules: vi.fn(async () => state.rules),
      writeRules: vi.fn(async (r: any[]) => { state.rules = r; }),
      log,
      record: () => { throw new Error('log down'); },
    });
    const u = await teach(menu, [tx()]);
    expect(state.rules).toHaveLength(1);
    expect(u.answer).toHaveBeenCalledWith('Rule saved');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('log down'));
  });
});
```

**Edit `companion/src/wealthfolio.test.ts`** — 1 edit.

Edit 1 of 1 in `companion/src/wealthfolio.test.ts` — replace:

```ts
    expect(body).not.toHaveProperty('presetVersion');
  });

  it('createCategorizationRule throws through httpError on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'duplicate pattern' });
    const client = new WealthfolioClient('http://wf');
```

with:

```ts
    expect(body).not.toHaveProperty('presetVersion');
  });

  it('createCategorizationRule resolves the id of the rule the server stored', async () => {
    // Upstream answers with the stored rule (Json<CategorizationRule>, camelCase).
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '7c1f2a9e-rule', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', matchType: 'contains', priority: 50 }),
    });
    const client = new WealthfolioClient('http://wf');
    await expect(client.createCategorizationRule({
      name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-1', taxonomyId: 'spending_categories', priority: 50,
    })).resolves.toBe('7c1f2a9e-rule');
  });

  it('createCategorizationRule resolves null when the reply carries no id, or no JSON', async () => {
    const client = new WealthfolioClient('http://wf');
    const rule = { name: 'n', pattern: 'p', categoryId: 'c', taxonomyId: 'spending_categories', priority: 50 };
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await expect(client.createCategorizationRule(rule)).resolves.toBeNull();
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError('Unexpected end of JSON input'); } });
    await expect(client.createCategorizationRule(rule)).resolves.toBeNull();
  });

  it('createCategorizationRule throws through httpError on a non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'duplicate pattern' });
    const client = new WealthfolioClient('http://wf');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix companion test -- src/categorize.test.ts src/transfer-learning.test.ts src/wealthfolio.test.ts src/index.test.ts`
Expected: FAIL — nothing is recorded and `createCategorizationRule` resolves undefined.

- [ ] **Step 3: Implement**

**Edit `companion/src/categorize.ts`** — 8 edits. (1) imports; (2) the two deps; (3) the controller's `record`, `categoryNameIn`, `rowFacts`, `filedAsCategory` beside `safeLog`; (4) `runCreateRule` keeps the id and records the rule; (5) a filing, (6) its Undo, (7) a move and (8) a move's Undo are recorded after their writes land.

Edit 1 of 8 in `companion/src/categorize.ts` — replace:

```ts
import { categoryRulePattern } from '../../shared/rule-pattern.js';
import { visibleUncategorized, type DismissalLedger } from '../../shared/uncategorized.js';
import { descriptionFromComment, txIdFromComment } from '../../shared/sync-core.js';
import { uncategorizedWindow } from './uncategorized-status.js';

/**
```

with:

```ts
import { categoryRulePattern } from '../../shared/rule-pattern.js';
import { visibleUncategorized, type DismissalLedger } from '../../shared/uncategorized.js';
import { descriptionFromComment, txIdFromComment } from '../../shared/sync-core.js';
import { categoryFiledChange, categoryRuleCreatedChange, type ChangeDraft, type FiledCategory } from '../../shared/change-entries.js';
import { uncategorizedWindow } from './uncategorized-status.js';

/**
```

Edit 2 of 8 in `companion/src/categorize.ts` — replace:

```ts
   * be carrying, discovered from `readCategorized` at tap time.
   */
  unassignTaxonomy: (activityId: string, taxonomyId: string) => Promise<void>;
  /** Creates a contains-match rule (priority + taxonomy applied by the caller). */
  createRule: (rule: { name: string; pattern: string; categoryId: string }) => Promise<void>;
  /** Republishes the addon's needs-a-category status. May throw; a failure here
   *  costs a stale tile, never the flow the user is in (see `republishQuietly`). */
  republish: () => Promise<void>;
```

with:

```ts
   * be carrying, discovered from `readCategorized` at tap time.
   */
  unassignTaxonomy: (activityId: string, taxonomyId: string) => Promise<void>;
  /** Creates a contains-match rule (priority + taxonomy applied by the caller).
   *  Resolves the new rule's id when the server reports one — kept for the
   *  change log (R2 deletes the rule by it). */
  createRule: (rule: { name: string; pattern: string; categoryId: string }) => Promise<string | null | void>;
  /** The change log: one draft per write that succeeded. Optional (most tests
   *  leave it out); read at call time; a throw is logged and swallowed. */
  record?: (draft: ChangeDraft) => void;
  /** Republishes the addon's needs-a-category status. May throw; a failure here
   *  costs a stale tile, never the flow the user is in (see `republishQuietly`). */
  republish: () => Promise<void>;
```

Edit 3 of 8 in `companion/src/categorize.ts` — replace:

```ts
      /* a logger that throws cannot be told about it */
    }
  }

  /** A stored note carries ` · <txId>` and possibly ` · pending`; the menu shows
   *  this string, so the bookkeeping is stripped first. A blank strip result (a
```

with:

```ts
      /* a logger that throws cannot be told about it */
    }
  }

  /** Records a write that succeeded. The log must never cost the flow. */
  function record(draft: ChangeDraft): void {
    try {
      deps.record?.(draft);
    } catch (err) {
      safeLog(`Categorize menu: recording a change failed: ${formatError(err)}`);
    }
  }

  /** A category's name from whatever was read: a fresh sweep, the session. */
  function categoryNameIn(
    sources: ReadonlyArray<{ categories: SpendingCategory[]; incomeCategories?: SpendingCategory[] }>,
    categoryId: string,
  ): string {
    for (const source of sources) {
      const hit = source.categories.find((c) => c.id === categoryId) ?? source.incomeCategories?.find((c) => c.id === categoryId);
      if (hit) return hit.name;
    }
    return '';
  }

  /** The facts of a row the change log names: its account, text and day, and
   *  its signed amount when the row says which way the money moved. */
  function rowFacts(row: CategorizeTxn | null): { account?: { name: string }; description: string; amountCents?: number; date?: string } {
    if (!row) return { description: '' };
    return {
      account: { name: row.accountName },
      description: row.description,
      ...(row.direction ? { amountCents: row.direction === 'out' ? -Math.abs(row.amountCents) : Math.abs(row.amountCents) } : {}),
      date: row.date,
    };
  }

  const filedAsCategory = (a: { taxonomyId: string; categoryId: string; categoryName: string }): FiledCategory =>
    ({ categoryId: a.categoryId, categoryName: a.categoryName, taxonomyId: a.taxonomyId });

  /** A stored note carries ` · <txId>` and possibly ` · pending`; the menu shows
   *  this string, so the bookkeeping is stripped first. A blank strip result (a
```

Edit 4 of 8 in `companion/src/categorize.ts` — replace:

```ts
    pin: CategorizeTxn | null,
    ui: CategorizeUi,
  ): Promise<void> {
    try {
      await deps.createRule({
        name: `${RULE_NAME_PREFIX}${pattern}`.slice(0, RULE_NAME_MAX),
        pattern,
        categoryId,
      });
    } catch (err) {
      const message = formatError(err);
      safeLog(`Categorize menu: creating a rule for "${pattern}" failed: ${message}`);
      await showError(chat, `${RULE_FAILED_PREFIX}${escapeMarkdown(message)}`, ui);
      return;
    }
    // The rule EXISTS from here on, so the session leaves the preview screen
    // before anything else can fail. `showError` offers `« Back` to whatever
    // `chat.session.screen` still says, and a preview left standing there hands
```

with:

```ts
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
      safeLog(`Categorize menu: creating a rule for "${pattern}" failed: ${message}`);
      await showError(chat, `${RULE_FAILED_PREFIX}${escapeMarkdown(message)}`, ui);
      return;
    }
    record(categoryRuleCreatedChange({
      ruleId, name, pattern, categoryId,
      categoryName: categoryNameIn([chat.session], categoryId) || categoryId,
    }));
    // The rule EXISTS from here on, so the session leaves the preview screen
    // before anything else can fail. `showError` offers `« Back` to whatever
    // `chat.session.screen` still says, and a preview left standing there hands
```

Edit 5 of 8 in `companion/src/categorize.ts` — replace:

```ts
          await showError(chat, `${ASSIGN_FAILED_PREFIX}${escapeMarkdown(message)}`, ui);
          return;
        }
        await republishQuietly();
        await transition(
          chat,
```

with:

```ts
          await showError(chat, `${ASSIGN_FAILED_PREFIX}${escapeMarkdown(message)}`, ui);
          return;
        }
        record(categoryFiledChange({
          actor: 'you',
          ...rowFacts(row),
          activityId: action.activityId,
          before: null,
          after: {
            categoryId: action.categoryId,
            categoryName: categoryNameIn([loaded.fresh], action.categoryId),
            ...(action.taxonomyId ? { taxonomyId: action.taxonomyId } : {}),
          },
        }));
        await republishQuietly();
        await transition(
          chat,
```

Edit 6 of 8 in `companion/src/categorize.ts` — replace:

```ts
          await showError(chat, `${UNDO_FAILED_PREFIX}${escapeMarkdown(message)}`, ui);
          return;
        }
        await republishQuietly();
        await transition(
          chat,
```

with:

```ts
          await showError(chat, `${UNDO_FAILED_PREFIX}${escapeMarkdown(message)}`, ui);
          return;
        }
        record(categoryFiledChange({
          actor: 'you',
          ...rowFacts(row),
          activityId: action.activityId,
          before: filedAsCategory(filedAs),
          after: null,
        }));
        await republishQuietly();
        await transition(
          chat,
```

Edit 7 of 8 in `companion/src/categorize.ts` — replace:

```ts
            return;
          }
        }
        // Harmless when nothing UNcategorized changed, and necessary when the
        // clear left the row without a category for a moment.
        await republishQuietly();
```

with:

```ts
            return;
          }
        }
        record(categoryFiledChange({
          actor: 'you',
          ...rowFacts(row),
          activityId: action.activityId,
          before: { categoryId: shown.categoryId, categoryName: shown.name, taxonomyId: shown.taxonomyId },
          after: { categoryId: action.categoryId, categoryName: categoryNameIn([fresh], action.categoryId), taxonomyId: SPENDING_TAXONOMY_ID },
          restore: toRestore,
        }));
        // Harmless when nothing UNcategorized changed, and necessary when the
        // clear left the row without a category for a moment.
        await republishQuietly();
```

Edit 8 of 8 in `companion/src/categorize.ts` — replace:

```ts
          await showError(chat, `${UNDO_FAILED_PREFIX}${escapeMarkdown(message)}${suffix}`, ui);
          return;
        }
        await republishQuietly();
        await transition(chat, { ...screen, undone: true }, pin, ui);
        return;
```

with:

```ts
          await showError(chat, `${UNDO_FAILED_PREFIX}${escapeMarkdown(message)}${suffix}`, ui);
          return;
        }
        const back = replay[0];
        record(categoryFiledChange({
          actor: 'you',
          ...rowFacts(pin),
          activityId: action.activityId,
          before: filedAsCategory(filedAs),
          after: back
            ? { categoryId: back.categoryId, categoryName: categoryNameIn([loaded.fresh, chat.session], back.categoryId), taxonomyId: back.taxonomyId }
            : null,
          restore: action.toRestore,
        }));
        await republishQuietly();
        await transition(chat, { ...screen, undone: true }, pin, ui);
        return;
```

**Edit `companion/src/index.ts`** — 2 edits. (1) the categorize controller's and (2) the transfer-learning menu's `record`, fire-and-forget into `recordCompanionChanges`.

Edit 1 of 2 in `companion/src/index.ts` — replace:

```ts
      // outranking every rule Nick wrote by hand.
      priority: 50,
    }),
    // Exactly as the sync path publishes it, so the tile the addon renders cannot
    // disagree with itself depending on which host last wrote it. Wrapped so it
    // can never throw: the controller already swallows a failure here, and this
```

with:

```ts
      // outranking every rule Nick wrote by hand.
      priority: 50,
    }),
    // Every filing, move, Undo and rule this menu writes, as `actor: 'you'`.
    // Fire and forget: the append never rejects, and the menu must not wait on it.
    record: (draft) => { void recordCompanionChanges(wfClient, [draft]); },
    // Exactly as the sync path publishes it, so the tile the addon renders cannot
    // disagree with itself depending on which host last wrote it. Wrapped so it
    // can never throw: the controller already swallows a failure here, and this
```

Edit 2 of 2 in `companion/src/index.ts` — replace:

```ts
    readRules: () => new RestSyncStore(wfClient).getMappingRules(),
    writeRules: (rules) => new RestSyncStore(wfClient).setMappingRules(rules),
    log,
  });

  const amazonLabels: AmazonLabelMenu = sharedAmazonLabelMenu = createAmazonLabelMenu({
```

with:

```ts
    readRules: () => new RestSyncStore(wfClient).getMappingRules(),
    writeRules: (rules) => new RestSyncStore(wfClient).setMappingRules(rules),
    log,
    // Fire and forget: the append never rejects, and the reply must not wait on it.
    record: (draft) => { void recordCompanionChanges(wfClient, [draft]); },
  });

  const amazonLabels: AmazonLabelMenu = sharedAmazonLabelMenu = createAmazonLabelMenu({
```

**Edit `companion/src/transfer-learning.ts`** — 3 edits. (1–2) import and the `record` dep; (3) the confirm step records the rule it appended.

Edit 1 of 3 in `companion/src/transfer-learning.ts` — replace:

```ts
 * later change to those patterns.
 */
import { formatDollars, type InlineKeyboard } from '../../shared/telegram.js';
import { MENU_CALLBACK_PREFIX } from '../../shared/categorize-menu.js';
import type { MappingRule, ActivityType } from '../../shared/types.js';

```

with:

```ts
 * later change to those patterns.
 */
import { formatDollars, type InlineKeyboard } from '../../shared/telegram.js';
import { mappingRuleCreatedChange, type ChangeDraft } from '../../shared/change-entries.js';
import { MENU_CALLBACK_PREFIX } from '../../shared/categorize-menu.js';
import type { MappingRule, ActivityType } from '../../shared/types.js';

```

Edit 2 of 3 in `companion/src/transfer-learning.ts` — replace:

```ts
  /** MUST merge: the addon's Transaction Rules card owns this list. */
  writeRules(rules: MappingRule[]): Promise<void>;
  log(msg: string): void;
}

export interface TransferLearningUi {
```

with:

```ts
  /** MUST merge: the addon's Transaction Rules card owns this list. */
  writeRules(rules: MappingRule[]): Promise<void>;
  log(msg: string): void;
  /** The change log: the rule this menu wrote. Must not throw. */
  record?(draft: ChangeDraft): void;
}

export interface TransferLearningUi {
```

Edit 3 of 3 in `companion/src/transfer-learning.ts` — replace:

```ts
          // Appended, never replacing: the user's own rules live in this list,
          // and earlier rules keep their precedence.
          await deps.writeRules([...rules, { pattern, matchType: 'contains', activityType }]);
        }

        await ui.edit(
```

with:

```ts
          // Appended, never replacing: the user's own rules live in this list,
          // and earlier rules keep their precedence.
          await deps.writeRules([...rules, { pattern, matchType: 'contains', activityType }]);
          try {
            deps.record?.(mappingRuleCreatedChange({
              rule: { pattern, matchType: 'contains', activityType },
              description: chosen.description,
              account: { name: chosen.accountName },
            }));
          } catch (err) {
            deps.log(`Transfer-learning: recording the rule failed: ${String(err)}`);
          }
        }

        await ui.edit(
```

**Edit `companion/src/wealthfolio.ts`** — 3 edits. The doc comment states the upstream evidence; the method resolves `id` (null when the reply has none or is not JSON).

Edit 1 of 3 in `companion/src/wealthfolio.ts` — replace:

```ts
   * (`apps/server/src/api/spending.rs`) documents that user-facing rule
   * creation leaves them None, and it's the presence of the keys, not just
   * their value, that marks a rule as preset-derived to the server.
   */
  async createCategorizationRule(rule: {
    name: string;
```

with:

```ts
   * (`apps/server/src/api/spending.rs`) documents that user-facing rule
   * creation leaves them None, and it's the presence of the keys, not just
   * their value, that marks a rule as preset-derived to the server.
   *
   * Resolves the new rule's id: the server answers with the rule it stored
   * (`create_categorization_rule` returns `Json<CategorizationRule>`, camelCase,
   * `id: String` — upstream `apps/server/src/api/spending.rs`). The change log
   * keeps it so R2 can delete the rule (`DELETE /api/v1/spending/rules/{id}`).
   * Null when a server answers without one.
   */
  async createCategorizationRule(rule: {
    name: string;
```

Edit 2 of 3 in `companion/src/wealthfolio.ts` — replace:

```ts
    categoryId: string;
    taxonomyId: string;
    priority: number;
  }): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/spending/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
```

with:

```ts
    categoryId: string;
    taxonomyId: string;
    priority: number;
  }): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/api/v1/spending/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
```

Edit 3 of 3 in `companion/src/wealthfolio.ts` — replace:

```ts
      }),
    });
    if (!res.ok) throw await this.httpError('createCategorizationRule', res);
  }

  async saveMany(req: {
```

with:

```ts
      }),
    });
    if (!res.ok) throw await this.httpError('createCategorizationRule', res);
    try {
      const created = (await res.json()) as { id?: unknown } | null;
      return typeof created?.id === 'string' && created.id ? created.id : null;
    } catch {
      return null;
    }
  }

  async saveMany(req: {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix companion test -- src/categorize.test.ts src/transfer-learning.test.ts src/wealthfolio.test.ts src/index.test.ts`
Expected: PASS — 123 + 30 + 27 + 272 tests.

Run: `npm --prefix companion test`
Expected: PASS — 875 tests.

Run: `npm --prefix companion run build`
Expected: Succeeds.

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add companion/src/categorize.test.ts companion/src/categorize.ts companion/src/index.test.ts companion/src/index.ts companion/src/transfer-learning.test.ts companion/src/transfer-learning.ts companion/src/wealthfolio.test.ts companion/src/wealthfolio.ts
git commit -m "Bot: record Telegram filings, moves, Undos and rules — and keep the rule id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `/changes` — the stateless list, search, runs and detail

The change log in Telegram, read-only. `/changes` replies with the last 7 days; `/changes <words>` searches the whole log. Every button carries its view (list page, background on/off, search words, a run, an entry) and a `findingHandle`, so a tap after a restart re-reads the log and still lands; a vanished entry answers `That one is already sorted — refreshing.` and shows the list. `cz:cl:` is routed before the categorize fallthrough; `/changes` joins More commands (the ☰ menu stays at seven).

**Files:**
- Create: `companion/src/changes-menu.ts`
- Modify: `companion/src/index.ts`, `shared/telegram-commands.ts`
- Test: `companion/src/changes-menu.test.ts` (create); `companion/src/index.test.ts`, `shared/telegram-commands.test.ts` (modify)

**Interfaces:**
- Consumes: Task 1 (`changeDay`); Task 3 (`ChangeLogItem`, `ChangeLogRead`, and from `shared/change-view.ts`: `changeAccountText`, `changeAmountText`, `changeBeforeAfter`, `changeClock`, `changeLocalDay`, `changeLogNotes`, `changeRowAt`, `changeRows`, `changeRowSummary`, `changeSourceText`, `changesWithin`, `isBackground`, `matchesChangeSearch`, `ChangeRow`); Task 7 (`readCompanionChangeLog`); `findingHandle` (`shared/handle.ts`); `MENU_CALLBACK_PREFIX` (`shared/categorize-menu.ts`); `escapeMarkdown`, `shortDateTime`, `InlineKeyboard` (`shared/telegram.ts`).
- Produces (`companion/src/changes-menu.ts`):

```ts
export const CHANGES_CALLBACK_PREFIX = 'cz:cl:';
export const CHANGES_PAGE_SIZE = 8;
export const CHANGES_LIST_DAYS = 7;
export const CHANGES_QUERY_MAX_BYTES = 30;
export const CHANGES_GONE_ANSWER = 'That one is already sorted — refreshing.';
export const CHANGES_UNREACHABLE_REPLY = "Couldn't reach Wealthfolio — try again.";
export interface MenuScreen { text: string; keyboard: InlineKeyboard }
export type ChangesView =
  | { kind: 'list'; page: number; background: boolean }
  | { kind: 'search'; page: number; query: string }
  | { kind: 'run'; run: string; page: number; from: { page: number; background: boolean } }
  | { kind: 'detail'; entry: string; back: Exclude<ChangesView, { kind: 'detail' }> };
export function changesData(view: ChangesView): string;
export function parseChangesData(data: string): ChangesView | null;
export function normalizeChangesQuery(raw: string): string;
export function renderChangesList(read: ChangeLogRead, page: number, background: boolean, now: Date): MenuScreen;
export function renderChangesSearch(read: ChangeLogRead, page: number, query: string): MenuScreen;
export function renderChangeRun(entries: ChangeLogItem[], view: Extract<ChangesView, { kind: 'run' }>): MenuScreen;
export function renderChangeDetail(entry: ChangeLogItem, back: Exclude<ChangesView, { kind: 'detail' }>): MenuScreen;
export function renderChangesCommand(read: ChangeLogRead, args: string, now: Date): MenuScreen;
export interface ChangesMenuUi { edit(text: string, keyboard?: InlineKeyboard): Promise<void>; answer(text?: string): Promise<void> }
export interface ChangesMenuDeps { read(now: Date): Promise<ChangeLogRead>; now(): Date; log(msg: string): void }
export interface ChangesMenu { handles(data: string): boolean; onCallback(cb: { data: string; chatId: number }, ui: ChangesMenuUi): Promise<void> }
export function createChangesMenu(deps: ChangesMenuDeps): ChangesMenu;
```

**Callback data (after `cz:cl:`):** `l<page>` list · `b<page>` list with background · `s<page>:<words>` search · `r<page>:<runHandle>:<l|b><listPage>` a run · `d<entryHandle>:<view>` an entry, `<view>` being where Back goes. Longest: a search detail, ≤ 51 bytes.

- [ ] **Step 1: Write the failing tests**

**Create `companion/src/changes-menu.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  bookkeepingChange, categoryFiledChange, importChange, stampChange, transferLinkChange, type ChangeDraft,
} from '../../shared/change-entries.js';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log.js';
import { findingHandle } from '../../shared/handle.js';
import {
  changesData, CHANGES_GONE_ANSWER, CHANGES_UNREACHABLE_REPLY, createChangesMenu, normalizeChangesQuery,
  parseChangesData, renderChangeDetail, renderChangesCommand, renderChangesList, type MenuScreen,
} from './changes-menu.js';

/** Local wall-clock moments: the list's clock and day headings are local. */
const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m);
const NOW = at(12, 15, 0);
const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };
const item = (draft: ChangeDraft, when: Date, run?: string): ChangeLogItem => stampChange(draft, 'companion', when, run);
const imp = (n: number, when: Date, run?: string, description = `KROGER #${n}`) => item(importChange({
  account: CHECKING, txKey: `k${n}`, activityId: `act-${n}`, description, amountCents: -1234, date: '2026-10-11',
  pending: false, activityType: 'WITHDRAWAL',
}), when, run);
const filed = (desc: string, when: Date, account = CHECKING) => item(categoryFiledChange({
  actor: 'you', account, activityId: `f-${desc}`, description: desc, amountCents: -650,
  before: null, after: { categoryId: 'cat-din', categoryName: 'Dining' },
}), when);
const background = (when: Date) => item(bookkeepingChange({ step: 'external-marker', account: CHECKING, activityIds: ['x'] }), when);
const log = (entries: ChangeLogItem[], extra: Partial<ChangeLogRead> = {}): ChangeLogRead =>
  ({ entries: [...entries].sort((a, b) => (a.at < b.at ? 1 : -1)), gaps: [], trimmed: 0, unreadable: [], ...extra });

const allData = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
const button = (s: MenuScreen, text: string) => {
  const b = s.keyboard.inline_keyboard.flat().find((x) => x.text === text);
  if (!b) throw new Error(`no "${text}" among ${s.keyboard.inline_keyboard.flat().map((x) => x.text).join(' | ')}`);
  return b.callback_data;
};

describe('the /changes list', () => {
  it('shows the last 7 days newest first, by day, numbered, a run as one row, background behind a button', () => {
    const read = log([
      imp(1, at(12, 14, 5), 'runA'), imp(2, at(12, 14, 5), 'runA'),
      background(at(12, 14, 5)),
      filed('VENMO *J SMITH', at(11, 9, 12)),
      imp(3, at(1, 8, 0)), // 11 days old: not on the list
    ]);
    const s = renderChangesList(read, 0, false, NOW);
    expect(s.text).toBe([
      '*Changes — last 7 days*',
      '',
      '_Oct 12_',
      '1. 14:05 · Imported 2 transactions',
      '_Oct 11_',
      '2. 09:12 · Filed VENMO \\*J SMITH under Dining · -$6.50 · Checking',
    ].join('\n'));
    expect(s.keyboard.inline_keyboard.map((r) => r.map((b) => b.text))).toEqual([['1', '2'], ['Show 1 background change']]);
  });

  it('escapes a bank name with Markdown characters and keeps it out of bold and italics', () => {
    const read = log([filed('SQ *COFFEE_CLUB [2]', at(12, 9, 0), { sfinId: 's', wfId: 'w', name: "Joe's *Visa*" })]);
    const s = renderChangesList(read, 0, false, NOW);
    const line = s.text.split('\n').find((l) => l.startsWith('1. '))!;
    expect(line).toBe("1. 09:00 · Filed SQ \\*COFFEE\\_CLUB \\[2] under Dining · -$6.50 · Joe's \\*Visa\\*");
    // The only entities are the fixed title and the day heading.
    expect(s.text.split('\n').filter((l) => /^[*_]/.test(l))).toEqual(['*Changes — last 7 days*', '_Oct 12_']);
    const detail = renderChangeDetail(read.entries[0], { kind: 'list', page: 0, background: false });
    expect(detail.text.split('\n')[0]).toBe('Filed SQ \\*COFFEE\\_CLUB \\[2] under Dining');
  });

  it('pages by 8, older to the left, with a page count', () => {
    const read = log(Array.from({ length: 10 }, (_, i) => filed(`ROW ${i}`, at(12, 10, i))));
    const first = renderChangesList(read, 0, false, NOW);
    expect(first.text).toContain('Page 1 of 2');
    expect(first.text).toContain('1. 10:09 · Filed ROW 9');
    expect(first.keyboard.inline_keyboard.at(-1)!.map((b) => b.text)).toEqual(['‹ Older']);
    const second = renderChangesList(read, 1, false, NOW);
    expect(second.text).toContain('9. 10:01 · Filed ROW 1');
    expect(second.keyboard.inline_keyboard.at(-1)!.map((b) => b.text)).toEqual(['Newer ›']);
  });

  it('shows background changes when asked, with a way to hide them', () => {
    const read = log([background(at(12, 14, 5))]);
    const s = renderChangesList(read, 0, true, NOW);
    expect(s.text).toContain("1. 14:05 · Marked 1 bookkeeping row as outside transfers for Wealthfolio's Health page · Checking");
    expect(button(s, 'Hide background changes')).toBe('cz:cl:l0');
  });

  it('says so when nothing changed, and leads with gaps, trims and unreadable buckets', () => {
    const s = renderChangesList(log([], {
      gaps: [{ at: at(12, 8, 0).toISOString(), count: 3, reason: "couldn't save the log", writer: 'companion' }], trimmed: 2,
    }), 0, false, NOW);
    expect(s.text).toBe([
      '*Changes — last 7 days*',
      "⚠️ 3 changes may be missing — couldn't save the log Oct 12.",
      '⚠️ 2 older changes were trimmed to keep the log small.',
      '',
      'Nothing changed in the last 7 days.',
    ].join('\n'));
  });
});

describe('search', () => {
  it('searches the whole log by description, account and category', () => {
    const read = log([filed('VENMO *J SMITH', at(12, 9, 0)), filed('KROGER', at(1, 9, 0)), imp(4, new Date(2026, 8, 20, 9, 0), undefined, 'VENMO CASHOUT')]);
    const s = renderChangesCommand(read, '  venmo  ', NOW);
    expect(s.text.split('\n')[0]).toBe('*Changes matching* venmo');
    expect(s.text).toContain('Filed VENMO \\*J SMITH under Dining');
    expect(s.text).toContain('Imported VENMO CASHOUT');
    expect(s.text).not.toContain('KROGER');
    expect(renderChangesCommand(read, 'zelle', NOW).text).toContain('Nothing in the last 90 days matches zelle.');
  });

  it('cuts a long search to fit every button under 64 bytes, at a whole character', () => {
    const q = normalizeChangesQuery('ünïcödé ✓ words that go on and on');
    expect(Buffer.byteLength(q, 'utf8')).toBeLessThanOrEqual(30);
    expect(q).toBe('ünïcödé ✓ words that go');
  });
});

describe('callback data', () => {
  it('round-trips every view and stays within 64 bytes', () => {
    const views = [
      { kind: 'list', page: 12, background: true },
      { kind: 'search', page: 3, query: normalizeChangesQuery('ünïcödé ✓ words that go on and on') },
      { kind: 'run', run: 'abcdef01', page: 2, from: { page: 999, background: true } },
      { kind: 'detail', entry: '0123abcd', back: { kind: 'run', run: 'abcdef01', page: 999, from: { page: 999, background: true } } },
      { kind: 'detail', entry: '0123abcd', back: { kind: 'search', page: 999, query: normalizeChangesQuery('ünïcödé ✓ words that go on and on') } },
    ] as const;
    for (const v of views) {
      const data = changesData(v as any);
      expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
      expect(parseChangesData(data)).toEqual(v);
    }
    expect(parseChangesData('cz:cl:zz')).toBeNull();
    expect(parseChangesData('cz:cl:d0123abcd:d0123abcd:l0')).toBeNull();
  });
});

describe('createChangesMenu', () => {
  const ui = () => ({ edit: vi.fn(async (_t: string, _k?: unknown) => {}), answer: vi.fn(async (_t?: string) => {}) });
  const menuOver = (read: () => Promise<ChangeLogRead>) => createChangesMenu({ read, now: () => NOW, log: vi.fn() });

  it('opens an entry from a button minted before a restart, and goes back to its page', async () => {
    const entry = filed('VENMO *J SMITH', at(11, 9, 12));
    const read = log([entry]);
    const minted = button(renderChangesList(read, 0, false, NOW), '1');
    const u = ui();
    await menuOver(async () => read).onCallback({ data: minted, chatId: 1 }, u);
    const [text, keyboard] = u.edit.mock.calls[0] as [string, any];
    expect(text).toBe([
      'Filed VENMO \\*J SMITH under Dining',
      '-$6.50 · Checking',
      'Before → after: No category → Dining',
      `You, in Telegram · Oct 11, 9:12 AM`,
    ].join('\n'));
    expect(keyboard.inline_keyboard).toEqual([[{ text: '‹ Back', callback_data: 'cz:cl:l0' }]]);
  });

  it('opens a run’s imports, and an import from there goes back to the run', async () => {
    const read = log([imp(1, at(12, 14, 5), 'runA'), imp(2, at(12, 14, 6), 'runA')]);
    const u = ui();
    const menu = menuOver(async () => read);
    await menu.onCallback({ data: button(renderChangesList(read, 0, false, NOW), '1'), chatId: 1 }, u);
    const [runText, runKb] = u.edit.mock.calls[0] as [string, any];
    expect(runText.split('\n')[0]).toBe('*Imported 2 transactions*');
    expect(runText).toContain('1. 14:06 · Imported KROGER #2 · -$12.34 · Checking');
    const runScreen = { text: runText, keyboard: runKb } as MenuScreen;
    await menu.onCallback({ data: button(runScreen, '2'), chatId: 1 }, u);
    const [, detailKb] = u.edit.mock.calls[1] as [string, any];
    expect(parseChangesData(detailKb.inline_keyboard[0][0].callback_data)).toMatchObject({ kind: 'run' });
  });

  it('answers "already sorted" for an entry that has left the log, and shows the list', async () => {
    const gone = filed('OLD ONE', at(11, 9, 0));
    const data = changesData({ kind: 'detail', entry: findingHandle(gone.id), back: { kind: 'list', page: 0, background: false } });
    const u = ui();
    await menuOver(async () => log([])).onCallback({ data, chatId: 1 }, u);
    expect(u.answer).toHaveBeenCalledWith(CHANGES_GONE_ANSWER);
    expect((u.edit.mock.calls[0] as [string])[0]).toContain('Nothing changed in the last 7 days.');
  });

  it('says so when Wealthfolio cannot be reached', async () => {
    const u = ui();
    await menuOver(async () => { throw new Error('ECONNREFUSED'); }).onCallback({ data: 'cz:cl:l0', chatId: 1 }, u);
    expect(u.answer).toHaveBeenCalledWith(CHANGES_UNREACHABLE_REPLY);
    expect(u.edit).not.toHaveBeenCalled();
  });

  it('pages a search without losing the words', async () => {
    const read = log(Array.from({ length: 9 }, (_, i) => filed(`VENMO ${i}`, at(12, 10, i))));
    const first = renderChangesCommand(read, 'venmo', NOW);
    const u = ui();
    await menuOver(async () => read).onCallback({ data: button(first, '‹ Older'), chatId: 1 }, u);
    expect((u.edit.mock.calls[0] as [string])[0]).toContain('9. 10:00 · Filed VENMO 0 under Dining');
  });

  it('marks an entry R2 undid', () => {
    const e = { ...filed('VENMO', at(12, 9, 0)), undone: { by: 'c2', at: at(12, 10, 0).toISOString() } };
    expect(renderChangesList(log([e]), 0, false, NOW).text).toContain('1. 09:00 · Filed VENMO under Dining · -$6.50 · Checking ↩');
  });

  it('names both accounts of a link on its line', () => {
    const link = item(transferLinkChange(
      { account: CHECKING, txKey: 'k1', description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-10-08', oldActivityId: 'o1' },
      { account: { name: 'Citi Card' }, txKey: 'k2', description: 'PAYMENT THANK YOU', amountCents: 46460, date: '2026-10-08', oldActivityId: 'o2' },
    ), at(12, 9, 0));
    expect(renderChangesList(log([link]), 0, false, NOW).text).toContain('· -$464.60 · Checking → Citi Card');
  });

  it('ignores data it never minted', async () => {
    const u = ui();
    await menuOver(async () => log([])).onCallback({ data: 'cz:cl:nonsense', chatId: 1 }, u);
    expect(u.answer).toHaveBeenCalledWith();
    expect(u.edit).not.toHaveBeenCalled();
    expect(allData(renderChangesList(log([]), 0, false, NOW))).toEqual([]);
  });
});
```

**Edit `companion/src/index.test.ts`** — 2 edits.

Edit 1 of 2 in `companion/src/index.test.ts` — replace:

```ts
import { ingestAmazonMail } from './amazon-mail.js';
import { AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, UNCATEGORIZED_STATUS_SECRET_KEY } from '../../shared/status-keys.js';
import { CATEGORIZE_ENTRY_CALLBACK } from '../../shared/telegram.js';
import { existsSync } from 'fs';
import type { SyncResult } from '../../shared/sync-core.js';

```

with:

```ts
import { ingestAmazonMail } from './amazon-mail.js';
import { AMAZON_MAIL_STATUS_SECRET_KEY, AMAZON_MAIL_SAMPLES_SECRET_KEY, UNCATEGORIZED_STATUS_SECRET_KEY } from '../../shared/status-keys.js';
import { CATEGORIZE_ENTRY_CALLBACK } from '../../shared/telegram.js';
import { categoryFiledChange, stampChange } from '../../shared/change-entries.js';
import { existsSync } from 'fs';
import type { SyncResult } from '../../shared/sync-core.js';

```

Edit 2 of 2 in `companion/src/index.test.ts` — replace:

```ts
      const ui = { edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) };
      await deps.onMenuCallback!({ data: 'cz:sb:o', chatId: 1, messageId: 2 }, ui);
      expect((ui.send.mock.calls[0] as unknown as [string])[0]).toContain('💳 *Subscriptions*');
    });
  });

```

with:

```ts
      const ui = { edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) };
      await deps.onMenuCallback!({ data: 'cz:sb:o', chatId: 1, messageId: 2 }, ui);
      expect((ui.send.mock.calls[0] as unknown as [string])[0]).toContain('💳 *Subscriptions*');
    });
  });

  describe('/changes', () => {
    const AT = new Date(2026, 9, 12, 8, 0, 0);
    const venmo = () => stampChange(categoryFiledChange({
      actor: 'you', account: { name: 'Checking' }, activityId: 'a1', description: 'VENMO *J SMITH', amountCents: -650,
      before: null, after: { categoryId: 'cat-din', categoryName: 'Dining' },
    }), 'companion', new Date(2026, 9, 12, 7, 30, 0));
    const withLog = () => clientFor([[
      'change_log:companion:2026-10',
      JSON.stringify({ v: 1, writer: 'companion', month: '2026-10', entries: [venmo()], gaps: [] }),
    ]]);

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(AT);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('replies with the change log and a button per line', async () => {
      const { client } = withLog();
      const sent: Array<[string, any]> = [];
      await buildTelegramCommandHandler(client)({ command: 'changes', args: '' }, async (t, k) => { sent.push([t, k]); });
      expect(sent[0][0]).toBe('*Changes — last 7 days*\n\n_Oct 12_\n1. 07:30 · Filed VENMO \\*J SMITH under Dining · -$6.50 · Checking');
      expect(sent[0][1].inline_keyboard[0][0].callback_data).toMatch(/^cz:cl:d[0-9a-f]{8}:l0$/);
    });

    it('searches with the words after the command', async () => {
      const { client } = withLog();
      const sent: Array<[string, any]> = [];
      await buildTelegramCommandHandler(client)({ command: 'changes', args: 'zelle' }, async (t, k) => { sent.push([t, k]); });
      expect(sent[0][0]).toContain('Nothing in the last 90 days matches zelle.');
    });

    it("says so when Wealthfolio can't be reached", async () => {
      const client = { getAddonSecret: vi.fn(async () => { throw new Error('ECONNREFUSED'); }), setAddonSecret: vi.fn() } as any;
      const { sent, reply } = collector();
      await buildTelegramCommandHandler(client)({ command: 'changes', args: '' }, reply);
      expect(sent).toEqual(["Couldn't reach Wealthfolio — try again."]);
    });

    it('cz:cl: taps reach the changes menu, not the transaction menu', async () => {
      const { client } = withLog();
      const deps = buildTelegramListenerDeps(client);
      const ui = { edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) };
      await deps.onMenuCallback!({ data: 'cz:cl:l0', chatId: 1, messageId: 2 }, ui);
      expect((ui.edit.mock.calls[0] as unknown as [string])[0]).toContain('*Changes — last 7 days*');
    });
  });

```

**Edit `shared/telegram-commands.test.ts`** — 2 edits.

Edit 1 of 2 in `shared/telegram-commands.test.ts` — replace:

```ts
    expect(TELEGRAM_COMMAND_MENU.map((c) => c.command))
      .toEqual(['report', 'left', 'categorize', 'charts', 'status', 'sync', 'help']);
  });
  it('keeps the other six working, listed under "More commands" in /help', () => {
    expect(TELEGRAM_MORE_COMMANDS.map((c) => c.command))
      .toEqual(['afford', 'pool', 'recategorize', 'newrule', 'dismissed', 'subscriptions']);
    const help = formatHelpReply();
    const more = help.indexOf('*More commands*');
    expect(more).toBeGreaterThan(help.indexOf('/help'));
```

with:

```ts
    expect(TELEGRAM_COMMAND_MENU.map((c) => c.command))
      .toEqual(['report', 'left', 'categorize', 'charts', 'status', 'sync', 'help']);
  });
  it('keeps the other seven working, listed under "More commands" in /help', () => {
    expect(TELEGRAM_MORE_COMMANDS.map((c) => c.command))
      .toEqual(['afford', 'pool', 'recategorize', 'newrule', 'dismissed', 'subscriptions', 'changes']);
    const help = formatHelpReply();
    const more = help.indexOf('*More commands*');
    expect(more).toBeGreaterThan(help.indexOf('/help'));
```

Edit 2 of 2 in `shared/telegram-commands.test.ts` — replace:

```ts
    }
    // The optional query is invisible without an example.
    expect(help).toContain('/recategorize venmo');
  });
  it('says on /left that an amount asks whether it fits', () => {
    expect(TELEGRAM_COMMAND_MENU.find((c) => c.command === 'left')?.description).toContain('/left groceries 20');
```

with:

```ts
    }
    // The optional query is invisible without an example.
    expect(help).toContain('/recategorize venmo');
    expect(help).toContain('/changes venmo');
  });
  it('says on /left that an amount asks whether it fits', () => {
    expect(TELEGRAM_COMMAND_MENU.find((c) => c.command === 'left')?.description).toContain('/left groceries 20');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix companion test -- src/changes-menu.test.ts src/index.test.ts`
Expected: FAIL — `./changes-menu.js` does not exist and `/changes` falls through to the unknown-command reply.

- [ ] **Step 3: Implement**

**Create `companion/src/changes-menu.ts`:**

```ts
/**
 * companion/src/changes-menu.ts
 *
 * `/changes`: the change log in Telegram, read-only in R1 — the last 7 days
 * newest first, grouped by day, 8 rows a page; one sync run's imports as one
 * row that opens them; bookkeeping behind a button; one screen per entry.
 * `/changes <words>` searches the whole log (90 days).
 *
 * STATELESS, like subscriptions-menu.ts. Every tap re-reads the log, and every
 * button carries where it leads: a view (`l`/`b` list, `s` search, `r` run) and
 * an entry's or a run's handle (`findingHandle`, 8 hex). Nothing is remembered
 * between a message and its tap, so a button still works after a restart, and
 * one whose entry has gone answers "That one is already sorted — refreshing."
 *
 * Bank and user text (a summary, an account name, a search) is escaped AND
 * kept outside every `*…*`/`_…_`: legacy Markdown ignores a backslash inside
 * an entity, and one bank `*` would cost the whole message.
 */
import { MENU_CALLBACK_PREFIX } from '../../shared/categorize-menu.js';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log.js';
import { changeDay } from '../../shared/change-entries.js';
import {
  changeAccountText, changeAmountText, changeBeforeAfter, changeClock, changeLocalDay, changeLogNotes, changeRowAt,
  changeRows, changeRowSummary, changeSourceText, changesWithin, isBackground, matchesChangeSearch, type ChangeRow,
} from '../../shared/change-view.js';
import { findingHandle } from '../../shared/handle.js';
import { escapeMarkdown, shortDateTime, type InlineKeyboard } from '../../shared/telegram.js';

export const CHANGES_CALLBACK_PREFIX = `${MENU_CALLBACK_PREFIX}cl:`;
export const CHANGES_PAGE_SIZE = 8;
export const CHANGES_LIST_DAYS = 7;
/** A search rides inside every button of its screens, so it is cut to fit 64 bytes. */
export const CHANGES_QUERY_MAX_BYTES = 30;
export const CHANGES_GONE_ANSWER = 'That one is already sorted — refreshing.';
export const CHANGES_UNREACHABLE_REPLY = "Couldn't reach Wealthfolio — try again.";
const FAILED_ANSWER = 'Could not do that — check the companion logs.';

type Button = { text: string; callback_data: string };
export interface MenuScreen { text: string; keyboard: InlineKeyboard }

/** Where a screen is, and so where a button leads. */
export type ChangesView =
  | { kind: 'list'; page: number; background: boolean }
  | { kind: 'search'; page: number; query: string }
  | { kind: 'run'; run: string; page: number; from: { page: number; background: boolean } }
  | { kind: 'detail'; entry: string; back: Exclude<ChangesView, { kind: 'detail' }> };

const encodeList = (page: number, background: boolean) => `${background ? 'b' : 'l'}${page}`;

/** The `callback_data` for a view. */
export function changesData(view: ChangesView): string {
  return `${CHANGES_CALLBACK_PREFIX}${encodeView(view)}`;
}

function encodeView(view: ChangesView): string {
  switch (view.kind) {
    case 'list': return encodeList(view.page, view.background);
    case 'search': return `s${view.page}:${view.query}`;
    case 'run': return `r${view.page}:${view.run}:${encodeList(view.from.page, view.from.background)}`;
    case 'detail': return `d${view.entry}:${encodeView(view.back)}`;
  }
}

/** The view a button carries, or null for anything this menu never emitted. */
export function parseChangesData(data: string): ChangesView | null {
  if (!data.startsWith(CHANGES_CALLBACK_PREFIX)) return null;
  return decodeView(data.slice(CHANGES_CALLBACK_PREFIX.length), true);
}

function decodeView(s: string, allowDetail: boolean): ChangesView | null {
  let m = /^([lb])(\d{1,3})$/.exec(s);
  if (m) return { kind: 'list', page: Number(m[2]), background: m[1] === 'b' };
  m = /^s(\d{1,3}):(.+)$/s.exec(s);
  if (m) return { kind: 'search', page: Number(m[1]), query: m[2] };
  m = /^r(\d{1,3}):([0-9a-f]{8}):([lb])(\d{1,3})$/.exec(s);
  if (m) return { kind: 'run', page: Number(m[1]), run: m[2], from: { page: Number(m[4]), background: m[3] === 'b' } };
  m = /^d([0-9a-f]{8}):(.+)$/s.exec(s);
  if (m && allowDetail) {
    const back = decodeView(m[2], false);
    return back && back.kind !== 'detail' ? { kind: 'detail', entry: m[1], back } : null;
  }
  return null;
}

/** A search as it is kept: words, single-spaced, cut at a character to fit. */
export function normalizeChangesQuery(raw: string): string {
  let q = raw.trim().replace(/\s+/g, ' ');
  while (Buffer.byteLength(q, 'utf8') > CHANGES_QUERY_MAX_BYTES) q = Array.from(q).slice(0, -1).join('');
  return q.trim();
}

const runHandle = (run: string) => findingHandle(`run:${run}`);

/** One numbered line: `3. 14:05 · <summary> · -$12.34 · Checking`. */
function rowLine(n: number, row: ChangeRow): string {
  const at = changeRowAt(row);
  const tail = row.kind === 'entry'
    ? [changeAmountText(row.entry), changeAccountText(row.entry)].filter(Boolean).map(escapeMarkdown)
    : [];
  const undone = row.kind === 'entry' && row.entry.undone ? ' ↩' : '';
  return `${n}. ${changeClock(at)} · ${[escapeMarkdown(changeRowSummary(row)), ...tail].join(' · ')}${undone}`;
}

/** Day headings (`_Oct 12_`, fixed text) between numbered lines. */
function dayGrouped(rows: ChangeRow[], first: number): string[] {
  const lines: string[] = [];
  let day = '';
  rows.forEach((row, i) => {
    const d = changeLocalDay(changeRowAt(row));
    if (d !== day) {
      day = d;
      lines.push(`_${changeDay(d)}_`);
    }
    lines.push(rowLine(first + i + 1, row));
  });
  return lines;
}

function pageOf<T>(items: T[], page: number): { slice: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / CHANGES_PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { slice: items.slice(p * CHANGES_PAGE_SIZE, (p + 1) * CHANGES_PAGE_SIZE), page: p, pages };
}

/** Number buttons, four to a row, each opening its line. */
function numberRows(rows: ChangeRow[], first: number, back: Exclude<ChangesView, { kind: 'detail' }>): Button[][] {
  const buttons = rows.map((row, i): Button => ({
    text: String(first + i + 1),
    callback_data: row.kind === 'run' && back.kind === 'list'
      ? changesData({ kind: 'run', run: runHandle(row.run), page: 0, from: { page: back.page, background: back.background } })
      : changesData({ kind: 'detail', entry: findingHandle(row.kind === 'entry' ? row.entry.id : row.entries[0].id), back }),
  }));
  const out: Button[][] = [];
  for (let i = 0; i < buttons.length; i += 4) out.push(buttons.slice(i, i + 4));
  return out;
}

function navRow(page: number, pages: number, at: (page: number) => string): Button[] {
  const nav: Button[] = [];
  if (page < pages - 1) nav.push({ text: '‹ Older', callback_data: at(page + 1) });
  if (page > 0) nav.push({ text: 'Newer ›', callback_data: at(page - 1) });
  return nav;
}

const noteLines = (read: ChangeLogRead) => changeLogNotes(read).map((n) => `⚠️ ${escapeMarkdown(n)}`);

/** The list: the last 7 days, background hidden unless asked for. */
export function renderChangesList(read: ChangeLogRead, page: number, background: boolean, now: Date): MenuScreen {
  const recent = changesWithin(read.entries, now, CHANGES_LIST_DAYS);
  const hidden = recent.filter(isBackground).length;
  const rows = changeRows(background ? recent : recent.filter((e) => !isBackground(e)));
  const { slice, page: p, pages } = pageOf(rows, page);
  const first = p * CHANGES_PAGE_SIZE;
  const lines = [`*Changes — last ${CHANGES_LIST_DAYS} days*`, ...(p === 0 ? noteLines(read) : [])];
  if (rows.length === 0) lines.push('', `Nothing changed in the last ${CHANGES_LIST_DAYS} days.`);
  else lines.push('', ...dayGrouped(slice, first));
  if (pages > 1) lines.push('', `Page ${p + 1} of ${pages}`);
  const keyboard: Button[][] = numberRows(slice, first, { kind: 'list', page: p, background });
  const nav = navRow(p, pages, (n) => changesData({ kind: 'list', page: n, background }));
  if (nav.length) keyboard.push(nav);
  if (background) keyboard.push([{ text: 'Hide background changes', callback_data: changesData({ kind: 'list', page: 0, background: false }) }]);
  else if (hidden > 0) {
    keyboard.push([{
      text: `Show ${hidden} background ${hidden === 1 ? 'change' : 'changes'}`,
      callback_data: changesData({ kind: 'list', page: 0, background: true }),
    }]);
  }
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** `/changes <words>`: every entry in the log whose text matches, newest first. */
export function renderChangesSearch(read: ChangeLogRead, page: number, query: string): MenuScreen {
  const hits = read.entries.filter((e) => !isBackground(e) && matchesChangeSearch(e, query));
  const rows: ChangeRow[] = hits.map((entry) => ({ kind: 'entry', entry }));
  const { slice, page: p, pages } = pageOf(rows, page);
  const first = p * CHANGES_PAGE_SIZE;
  const lines = [`*Changes matching* ${escapeMarkdown(query)}`, ...(p === 0 ? noteLines(read) : [])];
  if (rows.length === 0) lines.push('', `Nothing in the last 90 days matches ${escapeMarkdown(query)}.`);
  else lines.push('', ...dayGrouped(slice, first));
  if (pages > 1) lines.push('', `Page ${p + 1} of ${pages}`);
  const keyboard = numberRows(slice, first, { kind: 'search', page: p, query });
  const nav = navRow(p, pages, (n) => changesData({ kind: 'search', page: n, query }));
  if (nav.length) keyboard.push(nav);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** One sync run's imports. */
export function renderChangeRun(entries: ChangeLogItem[], view: Extract<ChangesView, { kind: 'run' }>): MenuScreen {
  const rows: ChangeRow[] = entries.map((entry) => ({ kind: 'entry', entry }));
  const { slice, page: p, pages } = pageOf(rows, view.page);
  const first = p * CHANGES_PAGE_SIZE;
  const lines = [
    `*Imported ${entries.length} transactions*`,
    `_${shortDateTime(entries[0].at)}_`,
    '',
    ...slice.map((row, i) => rowLine(first + i + 1, row)),
  ];
  if (pages > 1) lines.push('', `Page ${p + 1} of ${pages}`);
  const here = { ...view, page: p };
  const keyboard = numberRows(slice, first, here);
  const nav = navRow(p, pages, (n) => changesData({ ...view, page: n }));
  if (nav.length) keyboard.push(nav);
  keyboard.push([{ text: '‹ Back', callback_data: changesData({ kind: 'list', page: view.from.page, background: view.from.background }) }]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: keyboard } };
}

/** One entry: what, why, before → after, who and when. */
export function renderChangeDetail(entry: ChangeLogItem, back: Exclude<ChangesView, { kind: 'detail' }>): MenuScreen {
  const lines = [escapeMarkdown(entry.summary)];
  const facts = [changeAmountText(entry), changeAccountText(entry)].filter(Boolean).map(escapeMarkdown);
  if (facts.length) lines.push(facts.join(' · '));
  if (entry.why) lines.push(`Why: ${escapeMarkdown(entry.why)}`);
  const beforeAfter = changeBeforeAfter(entry);
  if (beforeAfter) lines.push(`Before → after: ${escapeMarkdown(beforeAfter)}`);
  lines.push(`${changeSourceText(entry)} · ${shortDateTime(entry.at)}`);
  if (entry.undone) lines.push(`↩ Undone ${shortDateTime(entry.undone.at)}`);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: [[{ text: '‹ Back', callback_data: changesData(back) }]] } };
}

/** `/changes` and `/changes <words>`: the first screen, as a reply. */
export function renderChangesCommand(read: ChangeLogRead, args: string, now: Date): MenuScreen {
  const query = normalizeChangesQuery(args);
  return query ? renderChangesSearch(read, 0, query) : renderChangesList(read, 0, false, now);
}

export interface ChangesMenuUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
}

export interface ChangesMenuDeps {
  /** Re-read on every tap. Rejects when Wealthfolio cannot be reached. */
  read(now: Date): Promise<ChangeLogRead>;
  now(): Date;
  log(msg: string): void;
}

export interface ChangesMenu {
  handles(data: string): boolean;
  onCallback(cb: { data: string; chatId: number }, ui: ChangesMenuUi): Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createChangesMenu(deps: ChangesMenuDeps): ChangesMenu {
  const renderView = (read: ChangeLogRead, view: Exclude<ChangesView, { kind: 'detail' | 'run' }>, now: Date) =>
    (view.kind === 'list' ? renderChangesList(read, view.page, view.background, now) : renderChangesSearch(read, view.page, view.query));

  return {
    handles(data) {
      return data.startsWith(CHANGES_CALLBACK_PREFIX);
    },

    async onCallback(cb, ui) {
      try {
        const view = parseChangesData(cb.data);
        if (!view) return void await ui.answer();
        const now = deps.now();
        let read: ChangeLogRead;
        try {
          read = await deps.read(now);
        } catch (err) {
          deps.log(`Changes menu: reading failed: ${message(err)}`);
          return void await ui.answer(CHANGES_UNREACHABLE_REPLY);
        }
        const show = async (screen: MenuScreen, toast?: string) => {
          await ui.edit(screen.text, screen.keyboard);
          await ui.answer(toast);
        };
        const gone = () => show(renderChangesList(read, 0, false, now), CHANGES_GONE_ANSWER);
        const runEntries = (handle: string) =>
          read.entries.filter((e) => e.kind === 'import' && e.run && runHandle(e.run) === handle);

        switch (view.kind) {
          case 'list':
          case 'search':
            return void await show(renderView(read, view, now));
          case 'run': {
            const entries = runEntries(view.run);
            return void await (entries.length ? show(renderChangeRun(entries, view)) : gone());
          }
          case 'detail': {
            const entry = read.entries.find((e) => findingHandle(e.id) === view.entry);
            if (!entry) return void await gone();
            if (view.back.kind === 'run' && runEntries(view.back.run).length === 0) return void await gone();
            return void await show(renderChangeDetail(entry, view.back));
          }
        }
      } catch (err) {
        deps.log(`Changes menu: ${cb.data} failed: ${message(err)}`);
        await ui.answer(FAILED_ANSWER).catch(() => {});
      }
    },
  };
}
```

**Edit `companion/src/index.ts`** — 4 edits. (1) imports; (2) `case 'changes'` before `case 'status'` in `buildTelegramCommandHandler` — caught, answering `CHANGES_UNREACHABLE_REPLY` like `/subscriptions`; (3) the menu built beside the subscriptions menu in `buildTelegramListenerDeps`; (4) `cz:cl:` routed right after `cz:sb:` in `onMenuCallback`, before the transaction menu.

Edit 1 of 4 in `companion/src/index.ts` — replace:

```ts
import { createCategorizeController, SPENDING_TAXONOMY_ID } from './categorize.js';
import { createAmazonLabelMenu, type AmazonLabelMenu } from './amazon-labels.js';
import { fileAmazonCharges } from './amazon-filing.js';
import { companionChangeSink, recordCompanionChanges } from './change-log-host.js';
import type { ChangeDraft } from '../../shared/change-entries.js';
import { createTransferLearning, type TransferLearning } from './transfer-learning.js';
import type { CategorizeController, CategorizeDeps } from './categorize.js';
```

with:

```ts
import { createCategorizeController, SPENDING_TAXONOMY_ID } from './categorize.js';
import { createAmazonLabelMenu, type AmazonLabelMenu } from './amazon-labels.js';
import { fileAmazonCharges } from './amazon-filing.js';
import { companionChangeSink, readCompanionChangeLog, recordCompanionChanges } from './change-log-host.js';
import { createChangesMenu, renderChangesCommand, CHANGES_UNREACHABLE_REPLY, type ChangesMenu } from './changes-menu.js';
import type { ChangeLogRead } from '../../shared/change-log.js';
import type { ChangeDraft } from '../../shared/change-entries.js';
import { createTransferLearning, type TransferLearning } from './transfer-learning.js';
import type { CategorizeController, CategorizeDeps } from './categorize.js';
```

Edit 2 of 4 in `companion/src/index.ts` — replace:

```ts
        return;
      }

      case 'status':
        await reply(formatStatusReply(await readStatusReplyInput(wfClient), new Date()));
        return;
```

with:

```ts
        return;
      }

      case 'changes': {
        // Caught here, like /subscriptions: "Couldn't reach Wealthfolio" is the
        // answer, not the listener's generic apology.
        const now = new Date();
        let read: ChangeLogRead;
        try {
          read = await readCompanionChangeLog(wfClient, now);
        } catch (err) {
          log(`/changes: reading failed: ${formatError(err)}`);
          await reply(CHANGES_UNREACHABLE_REPLY);
          return;
        }
        const screen = renderChangesCommand(read, cmd.args, now);
        await reply(screen.text, screen.keyboard);
        return;
      }

      case 'status':
        await reply(formatStatusReply(await readStatusReplyInput(wfClient), new Date()));
        return;
```

Edit 3 of 4 in `companion/src/index.ts` — replace:

```ts
    log,
  });

  const ensureSession = async (): Promise<void> => {
    if (Date.now() - sessionEstablishedAt < LISTENER_SESSION_MAX_AGE_MS) return;
    const key = process.env.WEALTHFOLIO_API_KEY;
```

with:

```ts
    log,
  });

  // `/changes`. Stateless: every tap re-reads the log, so it survives restarts.
  const changes: ChangesMenu = createChangesMenu({
    read: (now) => readCompanionChangeLog(wfClient, now),
    now: () => new Date(),
    log,
  });

  const ensureSession = async (): Promise<void> => {
    if (Date.now() - sessionEstablishedAt < LISTENER_SESSION_MAX_AGE_MS) return;
    const key = process.env.WEALTHFOLIO_API_KEY;
```

Edit 4 of 4 in `companion/src/index.ts` — replace:

```ts
      // does not know as an expired session.
      if (subscriptions.handles(cb.data)) {
        await subscriptions.onCallback(cb, ui);
        return;
      }
      if (cb.data !== RECATEGORIZE_ENTRY_CALLBACK) {
```

with:

```ts
      // does not know as an expired session.
      if (subscriptions.handles(cb.data)) {
        await subscriptions.onCallback(cb, ui);
        return;
      }
      // `cz:cl:` likewise, before the transaction menu's fallthrough.
      if (changes.handles(cb.data)) {
        await changes.onCallback(cb, ui);
        return;
      }
      if (cb.data !== RECATEGORIZE_ENTRY_CALLBACK) {
```

**Edit `shared/telegram-commands.ts`** — 2 edits. One sentence in the comment; `/changes` appended to `TELEGRAM_MORE_COMMANDS` (the ☰ menu is unchanged).

Edit 1 of 2 in `shared/telegram-commands.ts` — replace:

```ts
 *  scrolls 90 days of history by hand.
 *  Since 1.60 the bare form of `/afford`, `/pool` and `/newrule` asks for what
 *  it needs; the example still shows the one-line shortcut.
 *  `/subscriptions` (1.60) takes no arguments; everything happens on its buttons. */
export const TELEGRAM_MORE_COMMANDS = [
  { command: 'afford', description: 'Can I afford it? — asks, or /afford 20 shopping' },
  { command: 'pool', description: 'Semester money pool — asks, or /pool 16000 Dec 12' },
```

with:

```ts
 *  scrolls 90 days of history by hand.
 *  Since 1.60 the bare form of `/afford`, `/pool` and `/newrule` asks for what
 *  it needs; the example still shows the one-line shortcut.
 *  `/subscriptions` (1.60) takes no arguments; everything happens on its buttons.
 *  `/changes` lists the change log; `/changes <words>` searches it. */
export const TELEGRAM_MORE_COMMANDS = [
  { command: 'afford', description: 'Can I afford it? — asks, or /afford 20 shopping' },
  { command: 'pool', description: 'Semester money pool — asks, or /pool 16000 Dec 12' },
```

Edit 2 of 2 in `shared/telegram-commands.ts` — replace:

```ts
  { command: 'newrule', description: 'Always file a match — asks, or /newrule trader joes = groceries' },
  { command: 'dismissed', description: 'What you dismissed lately, with Undo' },
  { command: 'subscriptions', description: 'Subscriptions and bills — remind, rename, hide, or add one' },
] as const;

export function formatHelpReply(unknownCommand?: string): string {
```

with:

```ts
  { command: 'newrule', description: 'Always file a match — asks, or /newrule trader joes = groceries' },
  { command: 'dismissed', description: 'What you dismissed lately, with Undo' },
  { command: 'subscriptions', description: 'Subscriptions and bills — remind, rename, hide, or add one' },
  { command: 'changes', description: 'What changed lately — /changes venmo searches' },
] as const;

export function formatHelpReply(unknownCommand?: string): string {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix companion test -- src/changes-menu.test.ts src/index.test.ts`
Expected: PASS — 16 + 276 tests.

Run: `npx vitest run shared/telegram-commands.test.ts`
Expected: PASS — 134 tests.

Run: `npm --prefix companion test`
Expected: PASS — 895 tests.

Run: `npm test`
Expected: PASS — 2000 tests.

Run: `npm --prefix companion run build`
Expected: Succeeds.

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add companion/src/changes-menu.test.ts companion/src/changes-menu.ts companion/src/index.test.ts companion/src/index.ts shared/telegram-commands.test.ts shared/telegram-commands.ts
git commit -m "Bot: /changes — the last 7 days, search, runs and detail, stateless

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The Change log card in Settings

The app's read-only view: a collapsible **Change log** card at the end of the Sync group (id `change-log`), loading when opened through `store.getChangeLog` (optional-called; a store without it reads as an empty log). Filters: account, kind group (All, the six groups), 7/30/90 days (30 by default), search. Rows by day: time, summary, account, amount; a row opens to why, before → after and who; a run row opens to its imports; notes for gaps, trims and unreadable buckets head the card. No emoji; `.sfin-log-*` classes only. Reset's copy names the change log.

**Files:**
- Create: `src/components/ChangeLogCard.tsx`
- Modify: `src/components/ui.tsx`, `src/tabs/SettingsTab.tsx`
- Test: `src/components/ChangeLogCard.test.tsx` (create); `src/tabs/SettingsTab.test.tsx` (modify)

**Interfaces:**
- Consumes: Task 1 (`changeDay`); Task 3 (`ChangeLogItem`, `ChangeLogRead`, and from `shared/change-view.ts`: `CHANGE_GROUP_LABELS`, `CHANGE_GROUPS`, `changeAccountNames`, `changeAccountText`, `changeAmountText`, `changeBeforeAfter`, `changeClock`, `changeGroupOf`, `changeLocalDay`, `changeLogNotes`, `changeRowAt`, `changeRows`, `changeRowSummary`, `changeSourceText`, `changesWithin`, `isBackground`, `matchesChangeSearch`, `ChangeGroup`, `ChangeRow`); Task 6 (`store.getChangeLog`); `shortDateTime` (`shared/telegram.ts`); `Button`, `Input`, `Select`, `CollapsibleCard` (`src/components/ui.tsx`).
- Produces (`src/components/ChangeLogCard.tsx`):

```ts
export const CHANGE_LOG_READ_FAILED = 'Could not read the change log — reload the page to try again.';
export const CHANGE_LOG_EMPTY = 'Nothing recorded yet. Changes show here after the next sync.';
export const CHANGE_LOG_NO_MATCH = 'Nothing matches these filters.';
export interface ChangeLogCardProps { load: () => Promise<ChangeLogRead | null>; now?: () => Date }
export function filterChanges(entries: readonly ChangeLogItem[], f: { account: string; group: 'all' | ChangeGroup; days: number; query: string }, now: Date): ChangeLogItem[];
export function ChangeLogCard(props: ChangeLogCardProps): JSX.Element;
```

- `src/tabs/SettingsTab.tsx`: `CARD` gains `changeLog: 'change-log'` (the open-card key).

- [ ] **Step 1: Write the failing tests**

**Create `src/components/ChangeLogCard.test.tsx`:**

```tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import {
  bookkeepingChange, categoryFiledChange, importChange, stampChange, transferLinkChange, type ChangeDraft,
} from '../../shared/change-entries';
import type { ChangeLogItem, ChangeLogRead } from '../../shared/change-log';
import { ChangeLogCard, CHANGE_LOG_EMPTY, CHANGE_LOG_NO_MATCH, CHANGE_LOG_READ_FAILED } from './ChangeLogCard';

/** Local wall-clock moments, so times and day headings hold in any TZ. */
const at = (month: number, day: number, h: number, m: number) => new Date(2026, month, day, h, m);
const NOW = at(9, 12, 15, 0);
const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };
const CARD = { sfinId: 'ACT-9c8d', wfId: 'wf-citi', name: 'Citi Card' };
const item = (draft: ChangeDraft, when: Date, run?: string): ChangeLogItem => stampChange(draft, 'companion', when, run);
const imp = (n: number, when: Date, run: string) => item(importChange({
  account: CHECKING, txKey: `k${n}`, activityId: `act-${n}`, description: `KROGER #${n}`, amountCents: -1234,
  date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
}), when, run);
const filed = (desc: string, when: Date, account = CARD) => item(categoryFiledChange({
  actor: 'auto', account, activityId: `f-${desc}`, description: desc, amountCents: -1080,
  before: { categoryId: 'cat-on', categoryName: 'Online Shopping' }, after: { categoryId: 'cat-pc', categoryName: 'Personal Care' },
  why: 'Amazon: Skincare',
}), when);
const log = (entries: ChangeLogItem[], extra: Partial<ChangeLogRead> = {}): ChangeLogRead =>
  ({ entries: [...entries].sort((a, b) => (a.at < b.at ? 1 : -1)), gaps: [], trimmed: 0, unreadable: [], ...extra });

const ENTRIES = () => [
  imp(1, at(9, 12, 14, 5), 'runA'), imp(2, at(9, 12, 14, 6), 'runA'),
  item(bookkeepingChange({ step: 'external-marker', account: CHECKING, activityIds: ['x'] }), at(9, 12, 14, 6), 'runA'),
  filed('AMAZON MKTPL*2K4', at(9, 11, 9, 12)),
  item(transferLinkChange(
    { account: CHECKING, txKey: 'k8', description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-09-20', oldActivityId: 'o1' },
    { account: CARD, txKey: 'k9', description: 'PAYMENT THANK YOU', amountCents: 46460, date: '2026-09-20', oldActivityId: 'o2' },
  ), at(8, 20, 8, 0)),
];

const mount = (read: ChangeLogRead | null) => {
  const load = vi.fn(async () => read);
  render(<ChangeLogCard load={load} now={() => NOW} />);
  return load;
};
const rowTexts = () => Array.from(document.querySelectorAll('.sfin-log-row')).map((r) => r.textContent);

describe('ChangeLogCard', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists the last 30 days by day — time, summary, account, amount — with a run as one row', async () => {
    mount(log(ENTRIES()));
    await screen.findByText('Oct 12');
    expect(Array.from(document.querySelectorAll('.sfin-log-day')).map((d) => d.textContent)).toEqual(['Oct 12', 'Oct 11', 'Sep 20']);
    expect(rowTexts()).toEqual([
      '14:06Imported 2 transactions',
      '09:12Moved AMAZON MKTPL*2K4 from Online Shopping to Personal CareCiti Card-$10.80',
      '08:00Linked CITI AUTOPAY (Checking) and PAYMENT THANK YOU (Citi Card) as one transferChecking → Citi Card-$464.60',
    ]);
    expect(screen.getByText('1 background change not shown — Background lists it.')).toBeInTheDocument();
  });

  it('opens a row to why, before → after and who', async () => {
    mount(log(ENTRIES()));
    fireEvent.click(await screen.findByRole('button', { name: /Moved AMAZON MKTPL\*2K4/ }));
    const detail = document.querySelector('.sfin-log-detail')!;
    expect(within(detail as HTMLElement).getByText('Why: Amazon: Skincare')).toBeInTheDocument();
    expect(within(detail as HTMLElement).getByText('Before → after: Online Shopping → Personal Care')).toBeInTheDocument();
    expect(detail.textContent).toContain('Automatic — the background sync · Oct 11, 9:12 AM');
  });

  it('opens a run to its transactions', async () => {
    mount(log(ENTRIES()));
    fireEvent.click(await screen.findByRole('button', { name: /Imported 2 transactions/ }));
    expect(Array.from(document.querySelectorAll('.sfin-log-run-line')).map((l) => l.textContent)).toEqual([
      '14:06Imported KROGER #2Checking-$12.34',
      '14:05Imported KROGER #1Checking-$12.34',
    ]);
  });

  it('filters by kind, account, period and words', async () => {
    mount(log(ENTRIES()));
    await screen.findByText('Oct 12');
    fireEvent.click(screen.getByRole('button', { name: 'Transfers' }));
    expect(rowTexts()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    expect(screen.getByText(CHANGE_LOG_NO_MATCH)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '90 days' }));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'Citi Card' } });
    expect(rowTexts()).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search changes'), { target: { value: 'personal care' } });
    expect(rowTexts()).toEqual([expect.stringContaining('Moved AMAZON MKTPL*2K4')]);
    fireEvent.click(screen.getByRole('button', { name: 'Background' }));
    fireEvent.change(screen.getByLabelText('Search changes'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: '' } });
    expect(rowTexts()).toEqual([expect.stringContaining('Marked 1 bookkeeping row')]);
  });

  it('heads the card with gaps, trims and unreadable buckets', async () => {
    mount(log([], {
      gaps: [{ at: at(9, 12, 8, 0).toISOString(), count: 3, reason: "couldn't save the log", writer: 'addon' }],
      trimmed: 5,
      unreadable: [{ writer: 'companion', month: '2026-10', paused: true }],
    }));
    expect(await screen.findByText("3 changes may be missing — couldn't save the log Oct 12.")).toBeInTheDocument();
    expect(screen.getByText('5 older changes were trimmed to keep the log small.')).toBeInTheDocument();
    expect(screen.getByText("The companion's log for October 2026 can't be read, so its new changes aren't being saved.")).toBeInTheDocument();
    expect(screen.getByText(CHANGE_LOG_EMPTY)).toBeInTheDocument();
  });

  it('says so when the log cannot be read', async () => {
    mount(null);
    expect(await screen.findByText(CHANGE_LOG_READ_FAILED)).toBeInTheDocument();
  });

  it('shows bank text as text, never as markup', async () => {
    mount(log([filed('<img src=x onerror=alert(1)>', at(9, 12, 9, 0))]));
    expect(await screen.findByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('marks an entry Undo reversed (R2)', async () => {
    const e = { ...filed('VENMO', at(9, 12, 9, 0)), undone: { by: 'c9', at: at(9, 12, 10, 0).toISOString() } };
    mount(log([e]));
    const row = await screen.findByRole('button', { name: /Moved VENMO/ });
    expect(row.className).toContain('sfin-log-row--undone');
    expect(row.textContent).toContain('(undone)');
  });
});
```

**Edit `src/tabs/SettingsTab.test.tsx`** — 1 edit.

Edit 1 of 1 in `src/tabs/SettingsTab.test.tsx` — replace:

```tsx
    // account mapping — since it undersells a destructive action otherwise.
    expect(card!.textContent).toContain(
      'Clears every SimpleFin Sync setting — the connection, account mapping, sync '
      + 'schedule, transaction rules, and any Telegram or Amazon setup. Transactions '
      + 'already imported into Wealthfolio stay.',
    );
  });

  it('reset requires an explicit confirmation step', async () => {
```

with:

```tsx
    // account mapping — since it undersells a destructive action otherwise.
    expect(card!.textContent).toContain(
      'Clears every SimpleFin Sync setting — the connection, account mapping, sync '
      + 'schedule, transaction rules, the change log, and any Telegram or Amazon setup. '
      + 'Transactions already imported into Wealthfolio stay.',
    );
  });

  it('offers the change log under Sync, collapsed, reading it only when opened', async () => {
    const props = makeProps();
    props.store.getChangeLog = vi.fn(async () => ({ entries: [], gaps: [], trimmed: 0, unreadable: [] }));
    render(<SyncPage {...props} />);
    await switchTab(/settings/i);
    const header = await screen.findByRole('button', { name: /^Change log/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(props.store.getChangeLog).not.toHaveBeenCalled();
    fireEvent.click(header);
    expect(await screen.findByText('Nothing recorded yet. Changes show here after the next sync.')).toBeInTheDocument();
    expect(props.store.getChangeLog).toHaveBeenCalledTimes(1);
  });

  it('reset requires an explicit confirmation step', async () => {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/ChangeLogCard.test.tsx src/tabs/SettingsTab.test.tsx`
Expected: FAIL — `./ChangeLogCard` does not exist; Settings has no Change log card; Reset's copy does not name the change log.

- [ ] **Step 3: Implement**

**Create `src/components/ChangeLogCard.tsx`:**

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
  CHANGE_GROUP_LABELS, CHANGE_GROUPS, changeAccountNames, changeAccountText, changeAmountText, changeBeforeAfter,
  changeClock, changeGroupOf, changeLocalDay, changeLogNotes, changeRowAt, changeRows, changeRowSummary,
  changeSourceText, changesWithin, isBackground, matchesChangeSearch, type ChangeGroup, type ChangeRow,
} from '../../shared/change-view';

export const CHANGE_LOG_READ_FAILED = 'Could not read the change log — reload the page to try again.';
export const CHANGE_LOG_EMPTY = 'Nothing recorded yet. Changes show here after the next sync.';
export const CHANGE_LOG_NO_MATCH = 'Nothing matches these filters.';
const DAY_CHOICES = [7, 30, 90] as const;
type Days = (typeof DAY_CHOICES)[number];
type GroupFilter = 'all' | ChangeGroup;

export interface ChangeLogCardProps {
  /** `store.getChangeLog` — null when the read failed. */
  load: () => Promise<ChangeLogRead | null>;
  now?: () => Date;
}

/** The entries the filters let through, newest first. */
export function filterChanges(
  entries: readonly ChangeLogItem[],
  f: { account: string; group: GroupFilter; days: number; query: string },
  now: Date,
): ChangeLogItem[] {
  return changesWithin(entries, now, f.days).filter((e) => {
    if (f.group === 'all' ? isBackground(e) : changeGroupOf(e.kind) !== f.group) return false;
    if (f.account && !changeAccountNames(e).includes(f.account)) return false;
    return matchesChangeSearch(e, f.query);
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
    <div className="sfin-log-item">
      <button
        type="button"
        className={`sfin-log-row${entry?.undone ? ' sfin-log-row--undone' : ''}`}
        aria-expanded={open}
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
            <div key={e.id} className="sfin-log-run-line">
              <span className="sfin-log-time">{changeClock(e.at)}</span>
              <span className="sfin-log-summary">{e.summary}</span>
              <span className="sfin-log-account">{changeAccountText(e)}</span>
              <span className="sfin-log-amount">{changeAmountText(e)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
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
  const accounts = useMemo(
    () => [...new Set(entries.flatMap((e) => changeAccountNames(e)))].sort((a, b) => a.localeCompare(b)),
    [entries],
  );
  const shown = filterChanges(entries, { account, group, days, query }, at);
  const hiddenBackground = group === 'all'
    ? filterChanges(entries, { account, group: 'background', days, query }, at).length
    : 0;
  const rows = changeRows(shown);

  if (read === 'loading') return <div className="sfin-subtle">Loading…</div>;
  if (read === null) return <div className="sfin-log-note">{CHANGE_LOG_READ_FAILED}</div>;

  const byDay: Array<{ day: string; rows: ChangeRow[] }> = [];
  for (const row of rows) {
    const day = changeLocalDay(changeRowAt(row));
    const last = byDay[byDay.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else byDay.push({ day, rows: [row] });
  }

  return (
    <div className="sfin-log">
      {changeLogNotes(read).map((n) => <div key={n} className="sfin-log-note">{n}</div>)}
      <div className="sfin-log-filters">
        <Select aria-label="Account" value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a} value={a}>{a}</option>)}
        </Select>
        <div className="sfin-range-chips" role="group" aria-label="Kind">
          {(['all', ...CHANGE_GROUPS] as GroupFilter[]).map((g) => (
            <Button key={g} variant="ghost" aria-pressed={group === g} onClick={() => setGroup(g)}>
              {g === 'all' ? 'All' : CHANGE_GROUP_LABELS[g]}
            </Button>
          ))}
        </div>
        <div className="sfin-range-chips" role="group" aria-label="Period">
          {DAY_CHOICES.map((d) => (
            <Button key={d} variant="ghost" aria-pressed={days === d} onClick={() => setDays(d)}>{d} days</Button>
          ))}
        </div>
        <div className="sfin-log-search">
          <Input
            type="search"
            aria-label="Search changes"
            placeholder="Search descriptions, accounts, categories"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      {entries.length === 0 ? (
        <div className="sfin-subtle">{CHANGE_LOG_EMPTY}</div>
      ) : rows.length === 0 ? (
        <div className="sfin-subtle">{CHANGE_LOG_NO_MATCH}</div>
      ) : (
        byDay.map(({ day, rows: dayRows }) => (
          <div key={day} className="sfin-log-group">
            <div className="sfin-log-day">{changeDay(day)}</div>
            {dayRows.map((row) => (
              <Row key={row.kind === 'entry' ? row.entry.id : `run:${row.run}`} row={row} />
            ))}
          </div>
        ))
      )}
      {hiddenBackground > 0 && (
        <div className="sfin-subtle sfin-log-hidden">
          {hiddenBackground} background {hiddenBackground === 1 ? 'change' : 'changes'} not shown — Background lists {hiddenBackground === 1 ? 'it' : 'them'}.
        </div>
      )}
    </div>
  );
}
```

**Edit `src/components/ui.tsx`** — 1 edit. The `.sfin-log-*` rules, after `.sfin-subs-form .sfin-range-chips`. Each selector appears once at column 0; the narrow-screen overrides are indented inside `@media`.

Edit 1 of 1 in `src/components/ui.tsx` — replace:

```tsx
.sfin-subs-form { display: flex; flex-direction: column; gap: 8px; padding: 8px 0; }
.sfin-subs-form label { display: flex; flex-direction: column; gap: 3px; font-size: var(--sfin-sz-sm); }
.sfin-subs-form .sfin-range-chips { margin: 0; }
@keyframes sfin-pop { from { transform: scale(.92); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.sfin-range-pin { position: absolute; bottom: 6px; right: 10px; font-size: var(--sfin-sz-2xs); color: var(--muted-foreground); background: color-mix(in srgb, var(--card) 80%, transparent); border-radius: var(--sfin-rad-xs); padding: 1px 6px; }
/* Drag feedback: the picked-up card lifts and fades while every other card
```

with:

```tsx
.sfin-subs-form { display: flex; flex-direction: column; gap: 8px; padding: 8px 0; }
.sfin-subs-form label { display: flex; flex-direction: column; gap: 3px; font-size: var(--sfin-sz-sm); }
.sfin-subs-form .sfin-range-chips { margin: 0; }
/* The Change log card (Settings → Sync). */
.sfin-log-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
.sfin-log-filters .sfin-range-chips { margin: 0; }
.sfin-log-search { flex: 1; min-width: 12em; }
.sfin-log-search .sfin-input { width: 100%; }
.sfin-log-note { font-size: var(--sfin-sz-sm); color: var(--sfin-warn); margin-bottom: 6px; }
.sfin-log-day { margin-top: 10px; font-size: var(--sfin-sz-xs); letter-spacing: .06em; text-transform: uppercase; color: var(--muted-foreground); }
.sfin-log-row { display: grid; grid-template-columns: 3.2em minmax(0, 1fr) auto auto; align-items: baseline; gap: 10px; width: 100%; padding: 4px 0; border: none; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); background: transparent; color: var(--foreground); font: inherit; text-align: left; cursor: pointer; }
.sfin-log-row:hover { background: color-mix(in srgb, var(--sfin-s0) 6%, transparent); }
.sfin-log-row--undone { opacity: .6; }
.sfin-log-run-line { display: grid; grid-template-columns: 3.2em minmax(0, 1fr) auto auto; align-items: baseline; gap: 10px; }
.sfin-log-time { font-size: var(--sfin-sz-xs); color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.sfin-log-summary { min-width: 0; overflow-wrap: anywhere; }
.sfin-log-account { font-size: var(--sfin-sz-xs); color: var(--muted-foreground); white-space: nowrap; }
.sfin-log-amount { white-space: nowrap; font-variant-numeric: tabular-nums; }
.sfin-log-detail { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 8px; padding: 6px 0 6px 12px; border-left: 2px solid var(--border); font-size: var(--sfin-sz-sm); }
.sfin-log-hidden { margin-top: 8px; }
@media (max-width: 560px) {
  .sfin-log-row { grid-template-columns: 3.2em minmax(0, 1fr); }
  .sfin-log-run-line { grid-template-columns: 3.2em minmax(0, 1fr); }
}
@keyframes sfin-pop { from { transform: scale(.92); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.sfin-range-pin { position: absolute; bottom: 6px; right: 10px; font-size: var(--sfin-sz-2xs); color: var(--muted-foreground); background: color-mix(in srgb, var(--card) 80%, transparent); border-radius: var(--sfin-rad-xs); padding: 1px 6px; }
/* Drag feedback: the picked-up card lifts and fades while every other card
```

**Edit `src/tabs/SettingsTab.tsx`** — 5 edits. (1) import; (2) `CARD.changeLog`; (3) a stable `loadChangeLog` (so the card reads once per opening); (4) the card after Background sync (Docker), before the Categorizing group; (5) Reset's copy names the change log.

Edit 1 of 5 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
import type { Scheduler } from '../utils/scheduler';
import type { MappingRule, SimplefinAccount, AccountMapping } from '../../shared/types';
import { accountCreatedChange } from '../../shared/change-entries';

/** Ids for this tab's collapsible cards. Doubles as the persisted key set (the
 *  page owns the open-card map), so these strings must not change — a rename
```

with:

```tsx
import type { Scheduler } from '../utils/scheduler';
import type { MappingRule, SimplefinAccount, AccountMapping } from '../../shared/types';
import { accountCreatedChange } from '../../shared/change-entries';
import { ChangeLogCard } from '../components/ChangeLogCard';

/** Ids for this tab's collapsible cards. Doubles as the persisted key set (the
 *  page owns the open-card map), so these strings must not change — a rename
```

Edit 2 of 5 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
  amazonGuide: 'amazon-guide',
  rules: 'rules',
  pool: 'pool',
} as const;

interface Props {
```

with:

```tsx
  amazonGuide: 'amazon-guide',
  rules: 'rules',
  pool: 'pool',
  changeLog: 'change-log',
} as const;

interface Props {
```

Edit 3 of 5 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
      scheduler.start(hours, () => store.getLastSyncAt(), () => runSync(ctx, store));
    }
  }, [ctx, store, scheduler]);

  const handleReset = useCallback(async () => {
    scheduler.stop();
```

with:

```tsx
      scheduler.start(hours, () => store.getLastSyncAt(), () => runSync(ctx, store));
    }
  }, [ctx, store, scheduler]);

  // Stable, so the card reads once each time it opens. Optional-called: an
  // older store (or a test double) has no change log, which reads as empty.
  const loadChangeLog = useCallback(
    async () => (store.getChangeLog ? store.getChangeLog() : { entries: [], gaps: [], trimmed: 0, unreadable: [] }),
    [store],
  );

  const handleReset = useCallback(async () => {
    scheduler.stop();
```

Edit 4 of 5 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
        </div>
      </CollapsibleCard>

      <h3 className="sfin-settings-group">Categorizing</h3>
      {/* The companion reads the mailbox, so this is only useful to someone
          who has set up background sync above. */}
```

with:

```tsx
        </div>
      </CollapsibleCard>

      {/* Read-only in this release: every change the sync and you made, the
          same entries /changes shows. Loads when opened. */}
      <CollapsibleCard
        id={CARD.changeLog}
        title="Change log"
        summary="What the sync and you changed, the last 90 days"
        open={isOpen(CARD.changeLog)}
        onToggle={() => toggleCard(CARD.changeLog)}
      >
        <ChangeLogCard load={loadChangeLog} />
      </CollapsibleCard>

      <h3 className="sfin-settings-group">Categorizing</h3>
      {/* The companion reads the mailbox, so this is only useful to someone
          who has set up background sync above. */}
```

Edit 5 of 5 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
        <b>Reset connection</b>
        <div className="sfin-subtle sfin-danger-note">
          Clears every SimpleFin Sync setting — the connection, account mapping, sync
          schedule, transaction rules, and any Telegram or Amazon setup. Transactions
          already imported into Wealthfolio stay.
        </div>
        <div className="sfin-danger-actions">
          {!confirmingReset ? (
```

with:

```tsx
        <b>Reset connection</b>
        <div className="sfin-subtle sfin-danger-note">
          Clears every SimpleFin Sync setting — the connection, account mapping, sync
          schedule, transaction rules, the change log, and any Telegram or Amazon setup.
          Transactions already imported into Wealthfolio stay.
        </div>
        <div className="sfin-danger-actions">
          {!confirmingReset ? (
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/ChangeLogCard.test.tsx src/tabs/SettingsTab.test.tsx src/pages/copy-policy.test.tsx src/components/theme-styles.test.ts`
Expected: PASS — 8 + 30 + 4 + 1 tests (the copy policy opens every Settings card, this one included).

Run: `npm test`
Expected: PASS — 2009 tests.

Run: `npm run type-check`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/ChangeLogCard.test.tsx src/components/ChangeLogCard.tsx src/components/ui.tsx src/tabs/SettingsTab.test.tsx src/tabs/SettingsTab.tsx
git commit -m "App: the Change log card in Settings — filters, days, runs, why and before → after

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Docs, follow-ups, every gate

The CHANGELOG under `[Unreleased]`, the README's feature list, and the R2 follow-ups (the DELETE rule endpoint, what R1 deliberately does not log). Then every gate on the whole tree.

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `docs/superpowers/follow-ups.md`

**Interfaces:**
- Consumes: everything above. Produces: no code.

- [ ] **Step 1: Write the docs**

**Edit `CHANGELOG.md`** — 1 edit. A new first bullet under `[Unreleased]` → `### Added`.

Edit 1 of 1 in `CHANGELOG.md` — replace:

```md
## [Unreleased]

### Added
- **The bot asks instead of making you remember argument order.** Send
  `/newrule` or `/afford` on its own, or tap **Set a new pool** under `/pool`,
  and it asks one question at a time — buttons where there is a choice, and
```

with:

```md
## [Unreleased]

### Added
- **A change log.** Every change the sync, the companion and you make to your
  books is recorded: each import, bank update and removed pending charge;
  transfer links and transfers held in transit; removed duplicates; starting
  balances and balance corrections; Amazon labels and filings; card
  opening-balance filings; categories you set, moved or took off in Telegram;
  rules you created; accounts you created. `/changes` in Telegram lists the
  last 7 days (`/changes venmo` searches), and **Settings → Change log** in the
  app shows the last 90 days with filters. Read-only for now — Undo comes in
  the next release. A change that could not be saved to the log is reported
  there as a gap rather than lost silently.
- **The bot asks instead of making you remember argument order.** Send
  `/newrule` or `/afford` on its own, or tap **Set a new pool** under `/pool`,
  and it asks one question at a time — buttons where there is a choice, and
```

**Edit `README.md`** — 1 edit. The Telegram bullet gains `/changes`; a Change log bullet follows it.

Edit 1 of 1 in `README.md` — replace:

```md
  `/subscriptions` lists your subscriptions and bills — set a reminder before
  a charge, rename one, hide one you cancelled, or add an annual plan by hand —
  and the daily report's "Coming up" lines say what charges soon. In a group chat, answer a question by
  replying to it.
- **Amazon categorization** (optional) — reads Amazon's order emails from a
  throwaway mailbox and files each `AMAZON.COM*…` charge under what you bought.
- **Rules** — map a description pattern to a category or activity type when a
```

with:

```md
  `/subscriptions` lists your subscriptions and bills — set a reminder before
  a charge, rename one, hide one you cancelled, or add an annual plan by hand —
  and the daily report's "Coming up" lines say what charges soon. In a group chat, answer a question by
  replying to it. `/changes` lists what changed in the last 7 days, and
  `/changes venmo` searches it.
- **Change log** — every change the sync and you made, the last 90 days, under
  **Settings → Change log**: imports, bank updates, transfer links, removed
  duplicates, starting balances, corrections, filings and rules, each with why
  and what it was before. Read-only in this release.
- **Amazon categorization** (optional) — reads Amazon's order emails from a
  throwaway mailbox and files each `AMAZON.COM*…` charge under what you bought.
- **Rules** — map a description pattern to a category or activity type when a
```

**Edit `docs/superpowers/follow-ups.md`** — 1 edit. Section 8, before the reference section.

Edit 1 of 1 in `docs/superpowers/follow-ups.md` — replace:

```md
  still says "reminder 3d"). It cannot fire without a date and resumes when one
  returns. Suggested fix: keep a single Off button while `remind` is set.

## Reference: name mismatches between the database, the REST API, and the SDK

Every one of these cost a diagnostic cycle against the live instance on
```

with:

```md
  still says "reminder 3d"). It cannot fire without a date and resumes when one
  returns. Suggested fix: keep a single Off button while `remind` is set.

## 8. Change log — Record (2026-10-12, plan `2026-10-12-change-log-record.md`)

- **Undo is release R2** (spec Part B). Every R1 entry already carries what its
  undo needs; deleting a category rule will need a new client method for
  upstream's `DELETE /api/v1/spending/rules/{id}` — nothing in this codebase
  calls it yet.
- **The transfer-learning menu's own ↩ Undo is not logged** (it removes the
  rule it wrote seconds earlier); the creation is. R2's state check finds the
  rule gone and refuses cleanly.
- **A Telegram filing has no account-scoped tx key** (the categorize rows carry
  no SimpleFin account id). R2 restores the category by activity id; only
  automatic filings need `noAutoFile`, and those carry the key.
- **A corrupt bucket stays until it ages out** (four months) or Reset clears it.
  A "repair" button would have to decide what in it is real; not worth it yet.
- **The read-back of a new starting balance or plug costs one activity read**,
  only when a change log is attached and only on the rare run that writes one.

## Reference: name mismatches between the database, the REST API, and the SDK

Every one of these cost a diagnostic cycle against the live instance on
```

- [ ] **Step 2: Run every gate**

Run: `npm test`
Expected: PASS — 2009 tests in 76 files.

Run: `npm --prefix companion test`
Expected: PASS — 895 tests in 30 files.

Run: `npm run type-check`
Expected: No errors.

Run: `npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md README.md docs/superpowers/follow-ups.md
git commit -m "Change log (R1): docs and follow-ups

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
