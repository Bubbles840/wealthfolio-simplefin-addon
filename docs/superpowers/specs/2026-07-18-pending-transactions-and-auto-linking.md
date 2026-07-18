# Pending Transactions, Auto-Linking & Scheduler Retune — Design

**Date:** 2026-07-18
**Status:** Approved pending spec review

## Context

Wealthfolio **v3.6.2** (2026-07-13) shipped both upstream fixes we filed:

- **Issue #1** — Basic auth for brokered addon network requests
  (`auth: { type: 'basic' }`). The addon no longer needs the patched image.
- **Issue #2** — safe module-import rewriting (via `es-module-lexer`), so
  `ctx.api.activities.import(...)` is no longer mangled. The `vite.config.ts`
  `["import"]` workaround is now dead weight.

The 3.6.x SDK also exposes richer activity mutation — `create`, `update`,
`saveMany` ({ creates, updates, deleteIds }) — and `ActivityCreate` /
`ActivityUpdate` carry a **`sourceGroupId`** field. Neither
`activities.link/unlink` (Issue #3) nor a `spending` API (Issue #4) exists
even in the 3.6.2 SDK.

Three user-reported problems motivate this work:

1. **Missing recent spend.** Wealthfolio shows ~$100–200 less this month than
   Credit Karma, and a July-13 purchase never appeared. Root cause: the addon
   skips **pending** transactions (they have no posted date), so anything not
   yet cleared is invisible.
2. **Transfers still count as spending** until linked by hand in the Spending
   tab — the addon can type transfer pairs but couldn't link them.
3. **No background/startup sync.** Wealthfolio **lazily activates** addons:
   the host draws the sidebar route from `contributes.routes` *without running
   addon code*; `enable()` runs only when the user opens the addon page. True
   background sync is therefore impossible from inside the addon.

## Decisions (user-approved)

- Pending transactions: **include and auto-reconcile** (match Credit Karma),
  category-safe.
- Auto-linking: **do it now** via a self-assigned shared `sourceGroupId`,
  **gated on a one-pair verification test**.
- Background sync: **accept in-addon behavior** (lazy activation is a host
  constraint); retune the scheduler instead of fighting it.
- Spending auto-enroll (Issue #4): **out of scope** — no SDK surface; keep the
  upstream issue open.

## Golden rule

**Reconcile by updating in place (same activity ID); never
delete-and-reimport a transaction that is merely changing state.** Spending
categories are stored by Wealthfolio *outside* the activity record, keyed by
activity ID (neither `ActivityCreate` nor `ActivityUpdate` has a category
field). Keeping the ID stable keeps the user's category assignment.

---

## A. Pending transactions

### A.1 Fetch

- Add `pending=1` to the SimpleFin `/accounts` request (`simplefin.ts`, both
  the addon and the companion).
- A transaction is pending when `tx.pending === true`. Pending rows frequently
  have `posted === 0`; date them from `tx.transacted_at` (Unix seconds) when
  `posted` is absent/zero. Drop a pending row only if it has *neither* a
  `posted` nor a `transacted_at` timestamp (cannot be dated).
- Pending rows are typed by the existing mapper, same as posted rows.

### A.2 Marking pending rows

Imported pending activities must be distinguishable from posted ones so a
*vanished pending* can be told apart from a *posted row that merely aged out
of the fetch window*.

- **Primary mechanism:** a ` · pending` suffix on the activity comment, after
  the tx id: `"{description} · {txId} · pending"`. Posted rows keep the
  existing `"{description} · {txId}"`. The suffix is stripped when the row
  posts.
- **Refinement to verify during implementation:** if `metadata` round-trips
  through `activities.search` results, store the pending flag there instead so
  it does not appear in the activity title. Confirm empirically before relying
  on it; the comment suffix is the guaranteed-readable fallback.

The tx-id parse used by dedup (`comment.lastIndexOf(' · ')`) must be updated so
the pending suffix does not corrupt id extraction (parse the id as the segment
*before* an optional trailing ` · pending`).

### A.3 Reconciliation (one atomic `saveMany` per run)

Inputs each run: the feed (posted + pending) over the overlap window, and the
existing mapped-account activities indexed by SimpleFin tx id (parsed from the
comment), each carrying `{ wfId, amount, date, type, isPending }`.

For each **feed** transaction:

- **Not in existing** → **create** (pending or posted).
- **In existing, unchanged** → skip.
- **In existing, changed** (amount differs, or pending→posted, i.e. the stored
  row is pending and the feed row is posted, or date changed) → **update in
  place** (same `wfId`): new amount, new date, corrected type, and comment with
  the ` · pending` suffix removed when it has posted. Category preserved.

For **vanished pending** — an existing row marked pending, still inside the
current fetch window, absent from the current feed:

- If it can be matched to a new posted feed row in the **same account** with
  **amount within a small tolerance** (exact cents preferred; a configurable
  epsilon covers tip/hold firm-ups) and **posted date within 3 days** →
  treat as the same transaction: **update the pending row in place** to the
  posted values (new tx id in the comment, new amount/date, suffix removed).
  This is the fallback for bridges that assign a **new id** when a pending
  clears, and it is what preserves the category in that case.
- Otherwise → the pending genuinely dropped off → **delete** (`deleteIds`).

Posted rows that are simply older than the window are never deleted.

### A.4 Interaction with existing logic

- **Starting-balance correction** computes against **posted only** — pending
  are excluded from `windowDelta` so the one-time anchor still matches
  SimpleFin's posted balance; pending then ride on top as additional spend.
- **Transfer detection** excludes pending candidates (they are volatile;
  linking a pending pair risks churn). A transfer links only once both sides
  are posted.
- **Idempotency / dedup** stays keyed on tx id from the comment (see A.2 parse
  change).

---

## B. Auto-linking transfers

### B.1 Mechanism

When `detectTransferPairs` returns a pair (both sides **posted**), generate one
`sourceGroupId` (UUID) and set it on **both** activities in the same
`saveMany` — on create for a newly imported pair, or via update for an existing
unlinked pair. A shared `sourceGroupId` is how Wealthfolio marks an internal
transfer; linked pairs classify as `InternalTransfer` and drop out of spending
and income.

### B.2 Verification gate (must pass before shipping B)

On the target instance, import (or update) two `TRANSFER_OUT` / `TRANSFER_IN`
activities in different accounts carrying the **same self-assigned
`sourceGroupId`**, then confirm in the Spending view that they are treated as a
linked internal transfer (excluded from spending), the same as a pair linked
through the `/activities/link` endpoint.

- **Pass** → ship B as designed.
- **Fail** (the classifier needs the `/link` endpoint's own bookkeeping) →
  drop B from this work, keep the manual Spending-tab linking step, and keep
  upstream Issue #3 (`activities.link`) open. A/C/D ship regardless.

### B.3 Reconciliation sweep (companion parity)

The companion's existing reconciliation sweep continues to link addon-imported
or manually-typed unlinked pairs; where it currently calls `/activities/link`,
it may instead stamp a shared `sourceGroupId` for parity — but the companion
already has the working `/link` endpoint, so it keeps using it. B is primarily
an **addon** change.

---

## C. Scheduler retune

The wall-clock poller (`Scheduler`) already checks `now − lastSyncAt` against
an interval and runs an immediate check on `start()` (activation). Retune:

- **Poll cadence:** `SCHEDULER_POLL_MS = 5 * 60 * 1000` (was 60 s). A poll is a
  cheap timestamp read; only a *due* poll hits the network.
- **Idle threshold:** the effective auto-sync interval becomes **4 hours**
  (`getSyncScheduleHours` default 6 → 4). The 1-hour `MIN_SYNC_INTERVAL_MS`
  floor in `runSync` is unchanged (4 h > 1 h).
- **Editable interval:** add a control on the Sync page to change the interval
  post-setup (today it is locked at setup; changing it requires a full Reset).
  Writes `setSyncScheduleHours` and restarts the scheduler.
- **Startup behavior:** unchanged mechanism — the immediate check on activation
  means opening the addon page after ≥ 4 h triggers an instant catch-up. This
  is the best achievable under lazy activation; document the limitation in the
  README (no sync before the page is opened at least once per session).

---

## D. Platform cleanup (v3.6.2 unblocks)

- `manifest.json`: bump `minWealthfolioVersion` (and `sdkVersion`) to `3.6.2`;
  bump the addon-sdk dependency to `3.6.2`.
- **Follow-up 1:** stop using the patched image. Update README / deployment
  docs to the official `ghcr.io/wealthfolio/wealthfolio:3.6.2`. Mark
  `companion/build-wealthfolio.sh` legacy (or remove).
- **Follow-up 2:** remove the post-minify `["import"]` transform
  (`escapeImportPropertyCalls`) from `vite.config.ts`; drop the
  `grep -c '\.import('` build check once removed.
- Update `companion/upstream-pr.md`: mark #1 and #2 shipped in 3.6.2; note #3
  is being addressed via the `sourceGroupId` approach (pending the B.2 test);
  keep #4 open.

---

## Error handling

- `saveMany` is one call per account-run; on failure, log per-account and count
  non-fatal (do **not** advance `lastSyncAt` on a hard failure, matching
  existing behavior). Reconciliation math is pure; only the network call fails.
- Deletes are conservative: only rows affirmatively identified as vanished
  pending (marked pending, in-window, absent from feed, unmatched) are deleted.
  A failure to read existing rows skips reconciliation for that account (no
  deletes) rather than guessing.
- Pending dating falls back `posted` → `transacted_at`; a row with neither is
  dropped (unchanged behavior for undateable rows).

## Testing

- **Mapper / fetch:** pending row (`pending: true`, `posted: 0`) is dated from
  `transacted_at`; a row with neither timestamp is dropped; `pending=1` is sent
  in the request.
- **Comment parse:** tx id extracted correctly with and without the
  ` · pending` suffix.
- **Reconciliation (unit, pure):**
  - new pending → create with suffix;
  - pending amount change → update in place, same id, category untouched;
  - pending → posted, **same tx id** → update in place, suffix stripped;
  - pending → posted, **new tx id**, amount+date within tolerance → pending row
    updated in place to posted values (no delete, no dup);
  - pending vanished, no match → delete;
  - posted row aged out of window → untouched (never deleted).
- **Starting balance:** excludes pending from `windowDelta`.
- **Transfer detection:** pending excluded from candidates.
- **Auto-linking:** a detected posted pair is written with a shared
  `sourceGroupId` on both sides in one `saveMany`.
- **Scheduler:** poll cadence 5 min; sync fires when idle ≥ interval; immediate
  check on start; editable interval restarts the scheduler.
- Companion parity tests for the pending-fetch and reconciliation changes.

## Known limitations (accepted)

- No sync before the addon page is opened at least once per session (lazy
  activation).
- Cross-currency transfers still unmatched.
- A pending that changes amount will briefly show its old amount until the next
  poll reconciles it.
- The vanished-pending matcher can, in rare amount+date collisions, update a
  pending row into an unrelated posted transaction — the same collision risk
  the transfer matcher already accepts, bounded to the same account and 3 days.
- Auto-linking ships only if the B.2 verification test passes.
