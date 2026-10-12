# Change log with undo — design

Nick approved this design section by section on 2026-10-12. It is piece **2a**
of project 2 ("Trust & control") of the roadmap approved that day. Pieces 2b
("why is this here?" per transaction) and 2c (audits without SSH) get their own
specs and read from the log this one creates.

Nick's goal, in his words: every automatic decision should be undoable, without
the add-on asking "do you want to do this?" every time — "there should be an
option to go in there and undo things if something happened wrong."

Ships as **two releases** from one spec:

- **R1 — Record.** Every write is logged; `/changes` and an app card show the
  log, read-only.
- **R2 — Undo.** An overrides document the sync obeys; Undo and Redo for every
  kind; a version gate; Sync now.

## Decisions

| Question | Decision |
|---|---|
| What can be undone? | **Every automatic decision**, plus your own Telegram/app filings. Changes the bank made (and bookkeeping) are shown but not undoable. |
| Confirmations? | **None.** The add-on works quietly; Undo acts immediately and reports the result. The only extra choice is "Undo rule" vs "Undo rule + un-file its N charges". |
| Where? | **Both**: `/changes` in Telegram and a "Change log" card in the app's Settings. |
| How far back? | **90 days.** |
| Storage | **Add-on settings, one bucket per writer per month** (approach A). |
| Making undo stick | An **overrides document** every sync reads. For sync decisions, Undo records the override and the sync applies it; filings and rules are reversed directly. |
| Notifications | **None.** No daily-report lines about changes. |

## What exists today (facts this design builds on)

- **No write log exists.** Ledgers record what was announced or decided
  (`refused_creates_alerted`, `linked_groups`, `transfer_link_failures`,
  `amazon_order_ledger`, …), not what was written. In-process `console.warn`
  tags (`duplicate-prune`, `amazon-late-label`, …) reach `docker logs` only.
- **Per-activity provenance is only the note**:
  `[↔️ In-transit transfer · ]<desc>[ · Amazon: <label>] · <txId>[ · pending]`,
  plus `Starting balance · <acct>` and `Balance adjustment · <acct> · <date>`
  rows; `sourceGroupId` `wf-transfer-<uuid>` on linked legs; `metadata`
  `{"flow":{"is_external":…}}`.
- **SimpleFin tx ids are not unique across accounts**: the account-scoped key
  is `accountTxKey(sfAccountId, txId)` (`shared/transfers.ts`).
- **Linking deletes and re-creates both legs** (`linkPairByRecreate`), so
  Wealthfolio activity ids change. Anything keyed by activity id must survive
  that; overrides are keyed by `accountTxKey`.
- **Wealthfolio fingerprints creates** (account, type, date, amount, note) and
  refuses a duplicate; in `/activities/bulk` one refusal aborts the batch.
  Updating one leg of a linked pair copies date/note/amount onto the partner;
  deleting one half of a linked pair removes the partner too.
- **Secrets have no compare-and-swap** and no list operation; the add-on and
  the companion both write them. The only documented cap in code is 200,000
  bytes per secret (`report_cube`, `reports_*`).
- **Existing undo**: dismiss/undismiss (ledger), Telegram categorize Undo
  (in-memory session; re-reads the assignment before clearing), recategorize
  Undo (restores the full prior assignment set), transfer-rule Undo
  (in-memory), subscription Undo (`subscription_prefs`). No undo for sync
  creates/updates/deletes, linking, baseline fix, balance plugs, Amazon
  filing, opening-debt filing, Telegram-created category rules (the rule id is
  discarded), or account creation.

### Every write path (what R1 must log)

**Sync core** (`shared/sync-core.ts`, both hosts):
1. Reconcile plan via `saveWithRowFallback` — creates (new bank txns),
   updates (type/date/amount/pending/in-transit/subtype/note rebuilt), deletes
   (vanished pending rows).
2. Duplicate prune (heal).
3. Legacy placeholder rewrite (bookkeeping).
4. External-marker stamp (bookkeeping).
5. Amazon late label (note update).
6. Starting-balance baseline create; 7. `keepStartingBalanceOldest` move.
8. Auto-heal balance plug.
9. Transfer link (`linkPair` → delete + re-create).
10. Stale-asset relink sweep (bookkeeping-like re-create).

**Companion after the sync** (`companion/src/index.ts` `runCompanionSync`):
11. Amazon filing (`PUT …/spending/activities/{id}/assignments`).
12. Card opening-debt filing (category create, spending settings, assignment).

**User-initiated**:
- Add-on "Add adjustment" (`applyBalanceAdjustment`), baseline correction
  (`applyBaselineFix`), account creation (`AccountMapper`).
- Telegram categorize: assign / unassign / recategorize; `createRule`
  (`POST /api/v1/spending/rules`); transfer-learning `mapping_rules`;
  `/newrule`.

Out of scope: the hand-run scripts in `companion/tools` and
`companion/scripts`, settings-only writes (layout, config), push
notifications, dismissals (they touch no ledger data and have their own undo).

---

## Part A — Record (R1)

### A1. The entry

```ts
export interface ChangeEntry {
  id: string;              // `<a|c><base36 ms><base36 counter>`, unique per writer
  at: string;              // ISO timestamp
  writer: 'addon' | 'companion';
  actor: 'auto' | 'you';   // automatic decision vs. a user's Telegram/app action
  run?: string;            // sync run id, groups one run's entries
  kind: ChangeKind;
  account?: { sfinId?: string; wfId?: string; name: string };
  subject: {               // the transaction(s) or object it touched
    txKeys?: string[];     // accountTxKey(sfinAccountId, txId)
    activityIds?: string[];
    description?: string;  // bank text (descriptionFromComment)
    amountCents?: number;  // signed, money out negative
    date?: string;         // YYYY-MM-DD
    ruleId?: string; rulePattern?: string; categoryName?: string;
  };
  summary: string;         // one plain-English line, built by a shared formatter
  why?: string;            // rule words, Amazon email label, keyword, "bank changed it"
  before?: Record<string, unknown>;  // minimal fields needed to reverse it
  after?: Record<string, unknown>;
  undoable: boolean;       // false for bank-made changes and bookkeeping
  // R2 only: an undo/redo entry points at the entry it reverses
  reverses?: { id: string; op: 'undo' | 'redo' };
}

export type ChangeKind =
  | 'import' | 'bank-update' | 'pending-removed'
  | 'transfer-link' | 'transfer-type'
  | 'duplicate-removed'
  | 'starting-balance' | 'starting-balance-moved' | 'balance-correction'
  | 'amazon-label' | 'category-filed' | 'opening-balance-filed'
  | 'category-rule-created' | 'mapping-rule-created'
  | 'account-created'
  | 'bookkeeping';
```

- `summary` is produced by one shared formatter per kind, so Telegram and the
  app read the same words.
- `before`/`after` carry only what a later undo needs (e.g. prior category id
  and name; the plug's activity id and amount; the removed duplicate's full
  create payload; the baseline's prior amount and date; the rule id).
- **Imports from one sync run** are one entry each (each is separately
  undoable in R2) and are grouped by `run` for display.

### A2. Storage — `shared/change-log.ts`

- **Key**: `change_log:<writer>:<YYYY-MM>` (month of `at`, UTC).
- **Bucket**: `{ v: 1, writer, month, entries: ChangeEntry[], gaps: Array<{ at, count, reason }>, trimmed?: number }`.
- **Append**: `appendChanges(get, set, writer, entries, now)` — re-read the
  current bucket, append, enforce the cap, write once. A sync run appends its
  entries in one call at the end of the run; a Telegram/app action appends one.
- **Corrupt bucket**: never overwritten. The writer appends to the fallback key
  `change_log:<writer>:<YYYY-MM>.2`; readers read both. If the fallback is also
  corrupt, appends pause for that writer and month and the feed says so.
- **Gaps**: a failed append is remembered by the writer in memory and written
  as a `gaps` record on its next successful append ("3 changes may be missing
  — couldn't save the log Oct 12").
- **Cap**: 200,000 bytes per bucket (UTF-8, `TextEncoder`). Over the cap,
  drop `bookkeeping` entries oldest first, then the oldest entries; count
  drops in `trimmed`.
- **Retention**: readers read the current month's bucket and the three before
  it, and drop entries older than 90 days; a writer, on its first append of a
  month, clears its own bucket from four months back (`set(key, '')` on the
  companion, `delete` on the add-on).
- **Read**: `readChangeLog(get, now)` probes both writers' keys for the
  current month and the three before it (plus `.2` fallbacks), merges entries newest first, attaches
  undo/redo state from `reverses` entries (R2), and returns gaps, trims and
  unreadable buckets for display.
- **Reset**: `clearAll` in `src/utils/secrets.ts` also deletes both writers'
  keys (and `.2` fallbacks) for the current month and the four before it,
  generated by a helper, since the secrets API cannot list keys.

### A3. Recording points

- **Sync core**: `runSyncCore` collects entries as it plans and performs each
  write in the list above (only writes that succeeded produce an entry; a
  refused create produces none — it is already alerted). The host passes an
  optional `changeLog` sink; the core calls `sink.append(entries)` once at the
  end of the run, best-effort.
- **Companion after-sync steps**: Amazon filing and opening-debt filing
  append their entries (prior category captured before the PUT).
- **User actions**: the categorize controller, `/newrule`, transfer learning,
  the add-on's adjustment and baseline buttons, and account creation append
  `actor: 'you'` entries. `createRule` must keep the returned rule id (verify
  the response carries it; otherwise look the rule up by name right after
  creating it).
- **Never cost the real work**: an append failure is caught, logged, and
  recorded as a gap; the sync result and the user's action are unchanged.

### A4. Telegram — `/changes` (read-only in R1)

- In `/help`'s More commands (☰ menu stays at 7).
- **List**: last 7 days, newest first, grouped by day, 8 per page; numbered
  lines `HH:MM · <summary>`; `↩` marks undone (R2); `[‹ Older] [Newer ›]`;
  bookkeeping hidden behind `[Show N background changes]`.
- **Detail**: summary, why, before → after, writer, actor, time; `[‹ Back]`.
  An "Imported N transactions" run row opens its entries.
- **Search**: `/changes <words>` narrows by description, account or category
  text.
- **Stateless** like the 🧹 menu: buttons carry a short handle of the entry
  id; a vanished entry answers "That one is already sorted — refreshing."
- Bank and user text escaped and kept outside bold (legacy Markdown).
- Prefix `cz:cl:`, routed before the categorize fallthrough; callback data ≤
  64 bytes.

### A5. App — "Change log" card in Settings (read-only in R1)

- Filters: account; kind group (Categories, Transfers, Corrections, Imports,
  Rules, Background); 7 / 30 / 90 days; search.
- Rows grouped by day: time, summary, account, amount; click to expand why and
  before → after.
- Header notes for gaps, trims and unreadable buckets.
- No emoji in app copy (copy-policy test).

---

## Part B — Undo (R2)

### B1. Overrides — `shared/sync-overrides.ts`

Setting key `sync_overrides`:

```ts
export interface SyncOverrides {
  v: 1;
  tx: Record<string, {          // accountTxKey
    notTransfer?: true;
    keepDuplicate?: true;
    noAutoFile?: true;
    noAmazonLabel?: true;
    at: string;                 // when set
    entryId?: string;           // the change-log entry whose undo set it
  }>;
  accounts: Record<string, {    // SimpleFin account id
    noAutoCorrect?: true;
    at: string;
  }>;
}
```

- **One shared edit path**, the same safety as `subscription_prefs`:
  re-read before write, a corrupt document is never overwritten, a document
  the parser would reject is never written.
- **The sync obeys them**:
  - `notTransfer`: never pairs or links the leg; card-payment keywords and
    mapping rules do not type it as a transfer; an already-linked pair with a
    `notTransfer` leg is unlinked on the next sync and each half retyped as
    spending/income.
  - `keepDuplicate`: duplicate prune leaves it.
  - `noAutoFile`: Amazon filing and opening-debt filing skip it.
  - `noAmazonLabel`: the late-label step skips it.
  - `accounts[x].noAutoCorrect`: no automatic balance plug; drift is still
    reported in the 🧹 list.
  - The existing **skip list** (`skipped_transactions`) is reused for undoing
    an import.
- **Visible and removable**: "Your overrides" list at the bottom of the app's
  Change log card, each with Remove; removing lets the next sync decide again.
- **Pruning**: `tx` entries older than one year are dropped on write; account
  switches stay until changed.

### B2. Undo and Redo per kind

**Principle: the sync owns the books.** For sync decisions, Undo records the
override and offers **Sync now**; filings and rules are reversed directly.

| Kind | Undo | Redo |
|---|---|---|
| `category-filed`, `opening-balance-filed` (auto) and your filings | Restore the previous category (or none). Automatic filings also set `noAutoFile`. | Re-apply the category; clear `noAutoFile`. |
| `category-rule-created` | **Undo rule** (delete the rule) or **Undo rule + un-file its N charges** (remove assignments filed by a rule with that category whose note contains the rule's words; N shown). Un-filed charges return to the needs-a-category list. | Re-create the rule. |
| `mapping-rule-created` | Remove the rule from `mapping_rules`; the next sync retypes. | Re-add it. |
| `transfer-link`, `transfer-type` | `notTransfer` on both legs (or the one leg), then sync. | Clear the overrides, then sync. |
| `balance-correction` | Remove the correction row; set `noAutoCorrect` on the account. | Re-add the correction at the same amount; clear `noAutoCorrect`. |
| `starting-balance`, `starting-balance-moved` | Restore the previous amount and date (warns the account will no longer match the bank). | Re-apply. |
| `duplicate-removed` | Re-create the removed copy from `before`, then `keepDuplicate`. If Wealthfolio refuses it as an exact copy, nothing changes and the entry says why. | Clear `keepDuplicate`, then sync. |
| `import` | Add to the skip list and remove the row. | Remove from the skip list, then sync. |
| `amazon-label` | Remove the label from the note; `noAmazonLabel`. | Clear the override, then sync. |
| `bank-update`, `pending-removed`, `bookkeeping`, `account-created` | Not undoable (bank is the source of truth / bookkeeping / outside scope). | — |

**Safety checks before every undo/redo:**
1. **Still as we left it?** Re-read the current state; if it changed since
   (re-filed, row gone, amount moved), refuse with the reason and write
   nothing.
2. **Linked pairs**: removing an import or editing a note on one half of a
   linked pair is refused — "Undo the transfer link first."
3. **Override first, reversal second.** A leftover override after a failed
   reversal is harmless; the failure is reported.
4. **Every undo/redo is logged** as an entry with `reverses`, in the undoer's
   own bucket.
5. **Version gate**: undo for sync decisions (`transfer-*`,
   `duplicate-removed`, `balance-correction`, `import`, `amazon-label`) is
   disabled with "Update the companion first" until the companion publishes a
   version that understands overrides. Category and rule undo do not depend on
   it.

**To verify during planning**: whether Wealthfolio's REST API can delete a
category rule (if not: disable it, or explain it must be removed in
Wealthfolio's rule settings); whether `POST /spending/rules` returns the id.

### B3. Interfaces

- **Telegram**: the `/changes` detail gains `[↩ Undo]` / `[Redo]` (rule
  entries: `[↩ Undo rule] [↩ Undo rule + un-file N]`); after a sync-decision
  undo, `[🔄 Sync now]`. Undone entries show `↩` in the list.
- **App**: expanded rows gain Undo / Redo; undone rows are muted "Undone by
  you <date>"; after a sync-decision undo the row says "Takes effect on the
  next sync" beside the existing Sync now button; "Your overrides" list.
- **No confirmations**; results and refusals are reported inline.

---

## Error handling

| Situation | Behaviour |
|---|---|
| Log append fails | The sync or action completes; a gap is recorded and shown. |
| Corrupt bucket | Never overwritten; fallback `.2` bucket; then pause with a note. |
| Bucket over 200 KB | Trim bookkeeping first, then oldest; "older entries trimmed". |
| Corrupt `sync_overrides` | Reads treat it as empty (the sync behaves as today); every override write is refused with a clear message; nothing overwritten. |
| Undo state check fails | Refused with the reason; nothing written. |
| Wealthfolio unreachable | "Couldn't reach Wealthfolio — nothing undone." |
| Outdated add-on tab | Its writes go unlogged; the existing reload banner covers it. |
| Outdated companion | Sync-decision undo disabled with "Update the companion first." |

## Testing

- **Pure, table-driven**: entry formatters (one summary per kind), bucket
  append / cap / trim / retention / gaps / fallback, the merged reader (two
  writers, newest first, undo state from `reverses`), overrides parse/edit
  (corrupt-safe), every undo planner (state check → plan, every refusal).
- **Sync core** (fake host): every write point produces its entry and only on
  success; each override is obeyed (including unlinking an already-linked pair
  with a `notTransfer` leg, and drift still reported under `noAutoCorrect`).
- **Companion**: Amazon/opening filing entries carry the prior category;
  `/changes` stateless after a restart; undo/redo per kind; version gate;
  Telegram Markdown safety.
- **App**: the card (filters, gaps, trims, undone rows, overrides list).
- **Fixed dates and real data shapes** everywhere.
- **Gates**: `npm test`, `npm --prefix companion test`, `npm run type-check`,
  `npm --prefix companion run build`.

## Out of scope

- The hand-run repair scripts; settings changes; push notifications about
  changes; undo older than 90 days.
- Per-transaction "why is this here?" (piece 2b) and audits without SSH
  (piece 2c).
