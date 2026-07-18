# Pending Transactions, Auto-Linking & Scheduler Retune — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Include and auto-reconcile SimpleFin pending transactions (category-safe), auto-link detected transfer pairs, retune the auto-sync scheduler, and drop the now-unnecessary patched image + `import()` workaround — all against Wealthfolio v3.6.2.

**Architecture:** The hard logic (deciding create / update-in-place / delete for pending reconciliation) lives in a new pure function `planReconciliation` in `shared/reconcile.ts`, fully unit-tested in isolation. The sync engine (`src/utils/sync.ts`) builds a feed (posted + pending), reads existing rows, calls `planReconciliation`, and executes the result in one atomic `activities.saveMany`. Auto-linking stamps a shared `sourceGroupId` on both sides of a detected pair in that same call. The scheduler already wall-clock-polls; we only retune constants and add an editable interval.

**Tech Stack:** TypeScript, Vitest, React (addon UI), Vite (bundle), Node (companion). Wealthfolio addon SDK 3.6.2.

## Global Constraints

- Wealthfolio target: **v3.6.2**. `manifest.json` `minWealthfolioVersion` and `sdkVersion` = `"3.6.2"`; `@wealthfolio/addon-sdk` dependency = `"^3.6.2"`.
- **Golden rule:** reconcile by **update-in-place (same activity id)**; never delete-and-reimport a transaction that is only changing state. Categories are keyed to the activity id outside the activity record.
- Wealthfolio stores activity `amount` as an **absolute** value; sign is carried by `activityType` (WITHDRAWAL/DEPOSIT etc.). Compare amounts as `Math.round(Math.abs(x) * 100)` cents.
- Imported-activity comment format: posted = `"{description} · {txId}"`; pending = `"{description} · {txId} · pending"`.
- Pending rows are excluded from starting-balance `windowDelta` and from transfer-pair detection.
- Auto-linking (Task 12) **ships only if the verification test passes** (see Task 12 gate). All other tasks ship regardless.
- TDD: write the failing test, watch it fail, implement, watch it pass, commit. Run addon tests with `npx vitest run <path>`; companion tests from `companion/` with `npx vitest run <path>`.

---

## Phase 0 — Platform cleanup & version bump (independent, do first)

### Task 1: Bump versions and add activity-mutation permissions

**Files:**
- Modify: `manifest.json`
- Modify: `package.json` (two `@wealthfolio/addon-sdk` entries: dependencies + peer/dev)

**Interfaces:**
- Produces: manifest permissions granting `activities.saveMany`, `activities.create`, `activities.update`, `activities.getAll` (consumed by Tasks 9 and 12).

- [ ] **Step 1: Bump manifest versions.** In `manifest.json` set `"sdkVersion": "3.6.2"` and `"minWealthfolioVersion": "3.6.2"`.

- [ ] **Step 2: Add activity permissions.** In `manifest.json`, replace the `activities` permission `functions` array with:

```json
"functions": ["checkImport", "import", "search", "getAll", "create", "update", "saveMany"],
```

Keep its `purpose` but extend it to: `"Import bank transactions, reconcile pending transactions (create/update/delete), and link transfer pairs"`.

- [ ] **Step 3: Bump the SDK dependency.** In `package.json`, change both `"@wealthfolio/addon-sdk": "^3.6.0"` occurrences to `"^3.6.2"`, then run:

```bash
npm install
```

Expected: `node_modules/@wealthfolio/addon-sdk/package.json` version is `3.6.2`.

- [ ] **Step 4: Verify typecheck still passes.**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit.**

```bash
git add manifest.json package.json package-lock.json
git commit -m "chore: target Wealthfolio 3.6.2 and grant activity mutation permissions"
```

---

### Task 2: Remove the `import()` sandbox workaround (Follow-up 2)

Wealthfolio 3.6.2 fixed the sandbox import-rewrite bug, so the bracket-notation transform is dead weight.

**Files:**
- Modify: `vite.config.ts` (remove `escapeImportPropertyCalls` plugin + its use)

- [ ] **Step 1: Delete the plugin.** In `vite.config.ts`, remove the entire `const escapeImportPropertyCalls = { ... };` block (the comment above it too) and remove `escapeImportPropertyCalls` from the `plugins: [react(), tailwindcss(), escapeImportPropertyCalls]` array so it reads `plugins: [react(), tailwindcss()]`.

- [ ] **Step 2: Rebuild.**

Run: `npm run build`
Expected: build succeeds, `dist/addon.js` emitted.

- [ ] **Step 3: Confirm the real `.import(` call now survives (proving 3.6.2 no longer needs the workaround is a runtime check; here just confirm the build contains the method call).**

Run: `grep -c '\.import(' dist/addon.js`
Expected: a number `>= 1` (the genuine `activities.import(` / `saveMany` calls are now plain). This replaces the old "must be 0" check.

- [ ] **Step 4: Commit.**

```bash
git add vite.config.ts
git commit -m "chore: drop import() sandbox workaround (fixed upstream in 3.6.2)"
```

---

### Task 3: Point docs at the official image (Follow-up 1) and update upstream tracker

**Files:**
- Modify: `README.md` (any `wealthfolio-patched` mention → official image)
- Modify: `docker-compose.example.yml` (if it references the patched image)
- Modify: `companion/build-wealthfolio.sh` (mark legacy)
- Modify: `companion/upstream-pr.md` (status table)

- [ ] **Step 1: Find patched-image references.**

Run: `grep -rn "wealthfolio-patched\|build-wealthfolio" README.md companion/ docker-compose.example.yml`

- [ ] **Step 2: Replace with the official image.** Wherever the patched image is named as the image to run, use `ghcr.io/wealthfolio/wealthfolio:3.6.2`. Add a one-line note: "Wealthfolio 3.6.2+ supports addon Basic auth natively — no patched build needed."

- [ ] **Step 3: Mark the build script legacy.** At the top of `companion/build-wealthfolio.sh`, add a comment block: `# LEGACY: no longer required as of Wealthfolio 3.6.2, which ships addon Basic auth. # Use the official image ghcr.io/wealthfolio/wealthfolio:3.6.2 instead.`

- [ ] **Step 4: Update the upstream tracker.** In `companion/upstream-pr.md` status table, set #1 and #2 to `**Shipped in v3.6.2**`. For #3, change the follow-up note to: `Being addressed via a self-assigned shared sourceGroupId (see 2026-07-18 plan, Task 12); the dedicated link() method is still not in 3.6.2.` Leave #4 as open.

- [ ] **Step 5: Commit.**

```bash
git add README.md docker-compose.example.yml companion/build-wealthfolio.sh companion/upstream-pr.md
git commit -m "docs: use official ghcr.io image; mark patched build legacy; update upstream tracker"
```

---

## Phase 1 — Scheduler retune

### Task 4: Retune poll cadence and default interval

**Files:**
- Modify: `src/utils/scheduler.ts` (`SCHEDULER_POLL_MS`)
- Modify: `src/utils/scheduler.test.ts` (adjust the constant reference; existing tests use `SCHEDULER_POLL_MS` symbolically so they stay valid)
- Modify: `src/pages/SetupPage.tsx:26` (default hours 6 → 4)

**Interfaces:**
- Consumes: existing `Scheduler.start(intervalHours, getLastSync, onDue)` from prior work.

- [ ] **Step 1: Change the poll constant.** In `src/utils/scheduler.ts`, set:

```ts
export const SCHEDULER_POLL_MS = 5 * 60 * 1000; // wall-clock check every 5 minutes
```

- [ ] **Step 2: Run scheduler tests (they reference `SCHEDULER_POLL_MS`, not a literal).**

Run: `npx vitest run src/utils/scheduler.test.ts`
Expected: PASS (the "catches up within one poll" test advances by `SCHEDULER_POLL_MS`, so it still holds).

- [ ] **Step 3: Change the setup default.** In `src/pages/SetupPage.tsx`, change `useState<number>(6)` to `useState<number>(4)`.

- [ ] **Step 4: Typecheck.**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit.**

```bash
git add src/utils/scheduler.ts src/pages/SetupPage.tsx
git commit -m "feat: 5-min scheduler poll and 4-hour default sync interval"
```

---

### Task 5: Editable sync interval on the Sync page

Today the interval is locked at setup. Add a small control so it can change without a full Reset. Restart the scheduler on change.

**Files:**
- Modify: `src/pages/SyncPage.tsx` (Auto-Sync card ~lines 157-160; scheduler prop already available)

**Interfaces:**
- Consumes: `store.setSyncScheduleHours(hours: number)`, `store.getSyncScheduleHours()`, `scheduler.start(hours, () => store.getLastSyncAt(), () => runSync(ctx, store))`, `scheduler.stop()`.

- [ ] **Step 1: Write a component test.** Create/extend `src/pages/SyncPage.test.tsx` (follow existing test setup in the repo; if none, mock `store` and `scheduler` as objects of `vi.fn()`):

```tsx
it('changing the interval saves it and restarts the scheduler', async () => {
  const store = makeStore({ syncScheduleHours: 4, accountMapping: { a: 'wf-a' } });
  const scheduler = { start: vi.fn(), stop: vi.fn(), isRunning: () => true } as any;
  render(<SyncPage ctx={makeCtx()} store={store} scheduler={scheduler} onReset={() => {}} />);
  const select = await screen.findByLabelText(/auto-sync interval/i);
  fireEvent.change(select, { target: { value: '8' } });
  await waitFor(() => expect(store.setSyncScheduleHours).toHaveBeenCalledWith(8));
  expect(scheduler.start).toHaveBeenCalledWith(8, expect.any(Function), expect.any(Function));
});
```

- [ ] **Step 2: Run it, expect fail (no control yet).**

Run: `npx vitest run src/pages/SyncPage.test.tsx`
Expected: FAIL (`Unable to find label /auto-sync interval/`).

- [ ] **Step 3: Implement the control.** In `src/pages/SyncPage.tsx`, replace the Auto-Sync card body with an editable select:

```tsx
<Card>
  <SectionLabel>Auto-Sync</SectionLabel>
  <label htmlFor="sfin-interval" className="sfin-subtle" style={{ display: 'block', marginBottom: 4 }}>
    Auto-Sync interval
  </label>
  <select
    id="sfin-interval"
    value={scheduleHours ?? 0}
    onChange={async (e) => {
      const hours = Number(e.target.value);
      setScheduleHours(hours);
      await store.setSyncScheduleHours(hours);
      scheduler.stop();
      if (hours > 0) {
        scheduler.start(hours, () => store.getLastSyncAt(), () => runSync(ctx, store));
      }
    }}
  >
    <option value={0}>Off</option>
    <option value={1}>Every 1 hour</option>
    <option value={4}>Every 4 hours</option>
    <option value={8}>Every 8 hours</option>
    <option value={24}>Every 24 hours</option>
  </select>
</Card>
```

Ensure `runSync` is imported (it already is) and `scheduleHours`/`setScheduleHours` state exists (it does, line 25).

- [ ] **Step 4: Run tests.**

Run: `npx vitest run src/pages/SyncPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/pages/SyncPage.tsx src/pages/SyncPage.test.tsx
git commit -m "feat: editable auto-sync interval on the Sync page"
```

---

## Phase 2 — Pending transactions

### Task 6: Extend transaction types

**Files:**
- Modify: `shared/types.ts:17-23` (`SimplefinTransaction`)

**Interfaces:**
- Produces: `SimplefinTransaction` with optional `transacted_at?: number` and existing `pending?: boolean` (consumed by Tasks 7-9, 11).

- [ ] **Step 1: Add the field.** In `shared/types.ts`, update the interface:

```ts
export interface SimplefinTransaction {
  id: string;
  posted: number;        // Unix timestamp (0 for some pending rows)
  amount: string;        // Numeric string e.g. "-12.50"
  description: string;
  pending?: boolean;
  transacted_at?: number; // Unix timestamp; used to date pending rows lacking `posted`
}
```

- [ ] **Step 2: Typecheck.**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit.**

```bash
git add shared/types.ts
git commit -m "feat: add transacted_at to SimplefinTransaction for dating pending rows"
```

---

### Task 7: Request pending transactions from SimpleFin

**Files:**
- Modify: `src/utils/simplefin.ts:56` (add `pending=1`)
- Modify: `src/utils/simplefin.test.ts` (assert the param)
- Modify: `companion/src/simplefin.ts:51` (add `pending=1`)
- Modify: `companion/src/simplefin.test.ts` (assert the param)

- [ ] **Step 1: Write the addon failing test.** In `src/utils/simplefin.test.ts`, add:

```ts
it('requests pending transactions', async () => {
  const network = { request: vi.fn(async () => ({ status: 200, body: '{"errors":[],"accounts":[]}' })) };
  await fetchAccounts('https://u:p@bridge.simplefin.org/simplefin', new Date(0), network as any);
  const calledUrl = (network.request as any).mock.calls[0][0].url;
  expect(calledUrl).toContain('pending=1');
});
```

- [ ] **Step 2: Run it, expect fail.**

Run: `npx vitest run src/utils/simplefin.test.ts`
Expected: FAIL (`expected '…' to contain 'pending=1'`).

- [ ] **Step 3: Implement (addon).** In `src/utils/simplefin.ts`, right after the `start-date` line add:

```ts
url.searchParams.set('pending', '1');
```

- [ ] **Step 4: Implement (companion).** In `companion/src/simplefin.ts`, after its `start-date` line add:

```ts
accountsUrl.searchParams.set('pending', '1');
```

- [ ] **Step 5: Add the companion test.** In `companion/src/simplefin.test.ts`, mirror Step 1 asserting the fetched URL contains `pending=1`.

- [ ] **Step 6: Run both suites.**

Run: `npx vitest run src/utils/simplefin.test.ts` and (from `companion/`) `npx vitest run src/simplefin.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/utils/simplefin.ts src/utils/simplefin.test.ts companion/src/simplefin.ts companion/src/simplefin.test.ts
git commit -m "feat: request pending transactions from SimpleFin"
```

---

### Task 8: Pure reconciliation planner (`shared/reconcile.ts`)

This is the core. A pure function deciding create / update-in-place / delete, including the vanished-pending → posted matcher that preserves categories when a bridge changes the id on clearing.

**Files:**
- Create: `shared/reconcile.ts`
- Test: `shared/reconcile.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface FeedTx { txId: string; wfAccountId: string; absCents: number; type: string; date: string; pending: boolean; }
  interface ExistingRow { wfId: string; wfAccountId: string; txId: string; absCents: number; type: string; date: string; pending: boolean; }
  interface ReconcilePlan { creates: FeedTx[]; updates: Array<{ wfId: string; to: FeedTx }>; deleteIds: string[]; }
  function planReconciliation(feed: FeedTx[], existing: ExistingRow[], opts?: { amountEpsilonCents?: number; dateWindowDays?: number }): ReconcilePlan
  ```
  Consumed by Task 9 (addon sync) and Task 11 (companion).

- [ ] **Step 1: Write the failing tests.** Create `shared/reconcile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { planReconciliation } from './reconcile';
import type { FeedTx, ExistingRow } from './reconcile';

const feed = (o: Partial<FeedTx>): FeedTx => ({
  txId: 't1', wfAccountId: 'A', absCents: 500, type: 'WITHDRAWAL', date: '2026-07-13', pending: false, ...o,
});
const row = (o: Partial<ExistingRow>): ExistingRow => ({
  wfId: 'w1', wfAccountId: 'A', txId: 't1', absCents: 500, type: 'WITHDRAWAL', date: '2026-07-13', pending: false, ...o,
});

describe('planReconciliation', () => {
  it('creates a transaction not already imported', () => {
    const plan = planReconciliation([feed({ txId: 'new', pending: true })], []);
    expect(plan.creates.map((c) => c.txId)).toEqual(['new']);
    expect(plan.updates).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
  });

  it('skips an unchanged already-imported transaction', () => {
    const plan = planReconciliation([feed({})], [row({})]);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
  });

  it('updates in place when a pending amount changes (same id, same wfId)', () => {
    const plan = planReconciliation([feed({ pending: true, absCents: 650 })], [row({ pending: true, absCents: 500 })]);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([{ wfId: 'w1', to: expect.objectContaining({ absCents: 650 }) }]);
    expect(plan.deleteIds).toEqual([]);
  });

  it('updates in place when a pending posts under the same id', () => {
    const plan = planReconciliation([feed({ pending: false, date: '2026-07-15' })], [row({ pending: true, date: '2026-07-13' })]);
    expect(plan.updates).toEqual([{ wfId: 'w1', to: expect.objectContaining({ pending: false, date: '2026-07-15' }) }]);
    expect(plan.deleteIds).toEqual([]);
  });

  it('matches a vanished pending to a new posted id and updates in place (no delete, no dup)', () => {
    // pending t1 gone from feed; a new posted t2 in same account, same amount, 1 day later
    const plan = planReconciliation(
      [feed({ txId: 't2', pending: false, date: '2026-07-14', absCents: 500 })],
      [row({ txId: 't1', pending: true, date: '2026-07-13', absCents: 500 })],
    );
    expect(plan.creates).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.updates).toEqual([{ wfId: 'w1', to: expect.objectContaining({ txId: 't2', pending: false }) }]);
  });

  it('deletes a vanished pending with no posted match', () => {
    const plan = planReconciliation([], [row({ txId: 't1', pending: true })]);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.deleteIds).toEqual(['w1']);
  });

  it('never deletes a posted row that merely aged out of the feed', () => {
    const plan = planReconciliation([], [row({ txId: 't1', pending: false })]);
    expect(plan.deleteIds).toEqual([]);
  });

  it('does not match a vanished pending to a posted row in a different account', () => {
    const plan = planReconciliation(
      [feed({ txId: 't2', wfAccountId: 'B', pending: false, absCents: 500 })],
      [row({ txId: 't1', wfAccountId: 'A', pending: true, absCents: 500 })],
    );
    expect(plan.deleteIds).toEqual(['w1']);
    expect(plan.creates.map((c) => c.txId)).toEqual(['t2']);
  });

  it('does not match when the posted date is outside the window', () => {
    const plan = planReconciliation(
      [feed({ txId: 't2', pending: false, date: '2026-07-20', absCents: 500 })],
      [row({ txId: 't1', pending: true, date: '2026-07-13', absCents: 500 })],
    );
    expect(plan.deleteIds).toEqual(['w1']);
    expect(plan.creates.map((c) => c.txId)).toEqual(['t2']);
  });
});
```

- [ ] **Step 2: Run, expect fail.**

Run: `npx vitest run shared/reconcile.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `shared/reconcile.ts`.**

```ts
export interface FeedTx {
  txId: string;
  wfAccountId: string;
  absCents: number;
  type: string;
  date: string;      // YYYY-MM-DD
  pending: boolean;
}

export interface ExistingRow {
  wfId: string;
  wfAccountId: string;
  txId: string;
  absCents: number;
  type: string;
  date: string;      // YYYY-MM-DD
  pending: boolean;
}

export interface ReconcilePlan {
  creates: FeedTx[];
  updates: Array<{ wfId: string; to: FeedTx }>;
  deleteIds: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / DAY_MS;
}

function changed(row: ExistingRow, tx: FeedTx): boolean {
  return (
    row.absCents !== tx.absCents ||
    row.type !== tx.type ||
    row.date !== tx.date ||
    row.pending !== tx.pending
  );
}

/**
 * Decide create / update-in-place / delete for a sync run.
 *
 * - feed tx with no existing row (by tx id) -> create.
 * - feed tx with an existing row that changed -> update in place (same wfId).
 * - existing row marked pending, absent from the feed:
 *     - if an unmatched feed CREATE in the same account has an amount within
 *       epsilon and a date within the window, treat it as the same transaction
 *       that posted under a new id: update the pending row in place to the
 *       posted values (drops that create). Preserves the activity id/category.
 *     - otherwise the pending genuinely dropped off -> delete.
 * - existing posted row absent from the feed (aged out) -> untouched.
 */
export function planReconciliation(
  feed: FeedTx[],
  existing: ExistingRow[],
  opts: { amountEpsilonCents?: number; dateWindowDays?: number } = {},
): ReconcilePlan {
  const epsilon = opts.amountEpsilonCents ?? 0;
  const window = opts.dateWindowDays ?? 3;

  const existingByTxId = new Map(existing.map((r) => [r.txId, r]));
  const feedTxIds = new Set(feed.map((t) => t.txId));

  const creates: FeedTx[] = [];
  const updates: Array<{ wfId: string; to: FeedTx }> = [];
  const deleteIds: string[] = [];

  // Pass 1: creates and same-id updates.
  for (const tx of feed) {
    const row = existingByTxId.get(tx.txId);
    if (!row) {
      creates.push(tx);
    } else if (changed(row, tx)) {
      updates.push({ wfId: row.wfId, to: tx });
    }
  }

  // Pass 2: vanished pending -> match to an unmatched create, else delete.
  // A create is "available" for matching until claimed here.
  const claimed = new Set<string>();
  for (const row of existing) {
    if (!row.pending || feedTxIds.has(row.txId)) continue; // still present or not pending
    const match = creates.find(
      (c) =>
        !claimed.has(c.txId) &&
        c.wfAccountId === row.wfAccountId &&
        Math.abs(c.absCents - row.absCents) <= epsilon &&
        daysBetween(c.date, row.date) <= window,
    );
    if (match) {
      claimed.add(match.txId);
      updates.push({ wfId: row.wfId, to: match });
    } else {
      deleteIds.push(row.wfId);
    }
  }

  // Remove claimed creates (they became in-place updates of a pending row).
  const finalCreates = creates.filter((c) => !claimed.has(c.txId));

  return { creates: finalCreates, updates, deleteIds };
}
```

- [ ] **Step 4: Run, expect pass.**

Run: `npx vitest run shared/reconcile.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit.**

```bash
git add shared/reconcile.ts shared/reconcile.test.ts
git commit -m "feat: pure pending-reconciliation planner (create/update/delete + vanished-pending matcher)"
```

---

### Task 9: Wire reconciliation into the addon sync engine

Build the feed (posted + pending), read existing rows with pending markers, call `planReconciliation`, and execute with `saveMany`. Exclude pending from starting-balance and transfer detection.

**Files:**
- Modify: `src/utils/sync.ts` (prepared-tx filter ~170-172; comment build ~240; existing-id read ~50-61 and ~214-221; the import/checkImport block ~245-253; starting-balance windowDelta; transfer candidate build ~180-184)
- Modify: `src/utils/sync.test.ts` (add pending/reconcile integration tests)

**Interfaces:**
- Consumes: `planReconciliation`, `FeedTx`, `ExistingRow` from `shared/reconcile.ts`; `ctx.api.activities.saveMany`, `ctx.api.activities.search`.

- [ ] **Step 1: Stop skipping pending; date from `transacted_at`.** In `src/utils/sync.ts`, replace the prepared-tx filter (currently `.filter((tx) => !tx.pending && tx.posted > 0)`) with a helper that keeps pending and computes a date:

```ts
// A datable timestamp: posted when present, else transacted_at (pending rows).
function txEpoch(tx: SimplefinTransaction): number | null {
  if (tx.posted && tx.posted > 0) return tx.posted;
  if (tx.transacted_at && tx.transacted_at > 0) return tx.transacted_at;
  return null;
}
```

Change the filter to drop only undatable rows: `const transactions = (sfAccount.transactions ?? []).filter((tx) => txEpoch(tx) !== null);` and everywhere the code used `tx.posted * 1000` for the date, use `txEpoch(tx)! * 1000`.

- [ ] **Step 2: Build pending-aware comments.** In the activity mapping, set the comment to include the pending suffix:

```ts
comment: `${tx.description} · ${tx.id}${tx.pending ? ' · pending' : ''}`,
```

- [ ] **Step 3: Parse tx id + pending from existing comments.** Replace `fetchExistingTxIds` with a richer reader `fetchExistingRows(ctx, wfAccountId): Promise<ExistingRow[]>` that returns one `ExistingRow` per matched activity. Parse the comment as: strip a trailing ` · pending` (set `pending=true`), then take the segment after the last ` · ` as `txId`. Map `absCents = Math.round(Math.abs(parseFloat(amount)) * 100)`, `type = activityType`, `date = date.slice(0,10)`.

```ts
async function fetchExistingRows(ctx: AddonContext, wfAccountId: string): Promise<ExistingRow[]> {
  const res = await ctx.api.activities.search(0, 500, { accountIds: [wfAccountId] }, '', { id: 'date', desc: true });
  const rows: ExistingRow[] = [];
  for (const a of res.data) {
    let comment = a.comment ?? '';
    let pending = false;
    if (comment.endsWith(' · pending')) { pending = true; comment = comment.slice(0, -' · pending'.length); }
    const sep = comment.lastIndexOf(' · ');
    if (sep === -1) continue;
    const txId = comment.slice(sep + 3);
    rows.push({
      wfId: a.id,
      wfAccountId,
      txId,
      absCents: Math.round(Math.abs(parseFloat(String(a.amount ?? '0'))) * 100),
      type: String(a.activityType),
      date: String(a.date).slice(0, 10),
      pending,
    });
  }
  return rows;
}
```

- [ ] **Step 4: Build the feed and execute the plan with `saveMany`.** Replace the per-account `checkImport`/`import` block with: build `FeedTx[]` for the account from `prepared` (using `absCents`, `type`, `date`, `pending`, `txId`, `wfAccountId`), read `existing = await fetchExistingRows(ctx, wfAccountId)`, `const plan = planReconciliation(feed, existing)`, then translate to a `saveMany` request:

```ts
const toActivityCreate = (t: FeedTx) => ({
  accountId: t.wfAccountId,
  activityType: t.type,
  activityDate: t.date,
  symbol: `$CASH-${sfAccount.currency}`,
  amount: t.absCents / 100,
  currency: sfAccount.currency,
  comment: `${descByTxId.get(t.txId)} · ${t.txId}${t.pending ? ' · pending' : ''}`,
  sourceSystem: 'simplefin' as const,
  isDraft: false,
  isValid: true,
});
const toActivityUpdate = (wfId: string, t: FeedTx) => ({ id: wfId, ...toActivityCreate(t) });

if (plan.creates.length || plan.updates.length || plan.deleteIds.length) {
  const res = await ctx.api.activities.saveMany({
    creates: plan.creates.map(toActivityCreate),
    updates: plan.updates.map((u) => toActivityUpdate(u.wfId, u.to)),
    deleteIds: plan.deleteIds,
  });
  imported += res.created.length;
  // (updated/deleted are reconciliation, not new imports)
}
```

Keep a `descByTxId: Map<string,string>` built alongside the feed so the comment can be reconstructed (search results' comments already contain the description, but for creates we have it from the SimpleFin tx). Where `saveMany` is unavailable/errors, catch per-account and push to `errors` (existing per-account try/catch already wraps this).

- [ ] **Step 5: Exclude pending from starting balance and transfer detection.** In the transfer candidate build, add `if (tx.pending) continue;` before `candidates.push(...)`. In the starting-balance `windowDelta` computation, count only non-pending about-to-create activities (filter `plan.creates` to `!t.pending` when summing the delta).

- [ ] **Step 6: Write integration tests.** In `src/utils/sync.test.ts` add tests using the existing `makeCtx`/`makeStore` helpers and a mocked `ctx.api.activities.saveMany`:
  - a pending tx (`pending:true, posted:0, transacted_at: <epoch>`) is created with a ` · pending` comment;
  - re-syncing the same tx now posted (`pending:false`) issues an `updates` entry (same wfId from a mocked `search` row) and no new create;
  - a previously-imported pending absent from the feed with no match issues a `deleteIds` entry;
  - a pending tx is excluded from transfer detection (no TRANSFER_* typing).

Mock `ctx.api.activities.search` to return the "existing" rows for the update/delete cases; mock `saveMany` to echo `{ created: request.creates, updated: request.updates, deleted: request.deleteIds }` shaped as `Activity[]`.

- [ ] **Step 7: Run the suite.**

Run: `npx vitest run src/utils/sync.test.ts`
Expected: PASS (existing + new tests).

- [ ] **Step 8: Typecheck + commit.**

Run: `npx tsc --noEmit` (expect exit 0)

```bash
git add src/utils/sync.ts src/utils/sync.test.ts
git commit -m "feat: reconcile pending transactions via saveMany (create/update/delete)"
```

---

### Task 10: Companion parity for pending reconciliation

Mirror Task 9 in the companion so the two syncers stay behaviorally identical.

**Files:**
- Modify: `companion/src/index.ts` (prepared-tx filter, comment build, existing-row read, save/import block, starting-balance/transfer exclusion)
- Modify: `companion/src/wealthfolio.ts` (add `saveMany` + `searchActivities` already exists; add an `saveManyActivities` HTTP call to `POST /activities/save-many` or the batch endpoint — confirm the route name from the server; fall back to per-op create/update/delete endpoints if no batch route)
- Modify: `companion/src/index.test.ts`, `companion/src/wealthfolio.test.ts`

**Interfaces:**
- Consumes: `planReconciliation` from `shared/reconcile.ts` (companion imports from `../../shared/reconcile` per existing shared imports).

- [ ] **Step 1: Confirm the batch route.** Check the Wealthfolio server for the activities bulk-mutation endpoint (the SDK's `saveMany` maps to a REST route). Search the running server's API or the SDK network layer for the path (likely `POST /api/v1/activities/save-many`). Record the exact path.

- [ ] **Step 2: Add the client method (test-first).** In `companion/src/wealthfolio.test.ts`:

```ts
it('saveManyActivities POSTs creates/updates/deleteIds to the batch route', async () => {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ created: [], updated: [], deleted: [] }) });
  const client = new WealthfolioClient('http://wealthfolio:8088');
  await client.saveManyActivities({ creates: [], updates: [], deleteIds: ['x'] });
  const [url, opts] = mockFetch.mock.calls[0];
  expect(url).toBe('http://wealthfolio:8088/api/v1/activities/save-many'); // adjust to confirmed path
  expect(JSON.parse((opts as any).body).deleteIds).toEqual(['x']);
});
```

Run it (expect fail), implement `saveManyActivities(request)` in `companion/src/wealthfolio.ts` mirroring the existing `searchActivities`/`linkTransferActivities` methods, run again (expect pass).

- [ ] **Step 3: Port the reconciliation.** In `companion/src/index.ts`, apply the same changes as Task 9 Steps 1-5, using `planReconciliation` and `saveManyActivities`. Reuse the existing `searchActivities` to build `ExistingRow[]` (parse comment identically).

- [ ] **Step 4: Add companion integration tests** mirroring Task 9 Step 6 (pending create, pending→posted update, vanished-pending delete), using the existing companion test harness.

- [ ] **Step 5: Run companion suite.**

Run (from `companion/`): `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add companion/src/index.ts companion/src/wealthfolio.ts companion/src/index.test.ts companion/src/wealthfolio.test.ts
git commit -m "feat: companion parity for pending reconciliation"
```

---

## Phase 3 — Auto-linking (gated)

### Task 11: Verify shared sourceGroupId links transfers (GATE)

Before writing linking code, prove the mechanism on the target instance.

**Files:** none (manual verification, recorded in the plan checkboxes).

- [ ] **Step 1:** In Wealthfolio (dev/test data), create two activities in different mapped accounts — one `TRANSFER_OUT`, one `TRANSFER_IN`, equal amount — both with the same self-chosen `sourceGroupId` (e.g. via a one-off `activities.saveMany` call or the companion's `saveManyActivities`).

- [ ] **Step 2:** Open the Spending view and confirm the pair is treated as an internal transfer (excluded from spending/income), identical to a pair linked via the `/activities/link` endpoint.

- [ ] **Step 3: Record the result.**
  - **PASS** → proceed to Task 12.
  - **FAIL** → skip Task 12; keep manual linking; leave upstream Issue #3 open; note the result in `companion/upstream-pr.md`. The rest of this plan is already shipped.

---

### Task 12: Auto-link detected transfer pairs (only if Task 11 passed)

**Files:**
- Modify: `src/utils/sync.ts` (after `detectTransferPairs`, assign a shared `sourceGroupId` per pair and carry it into the `saveMany` creates/updates)
- Modify: `src/utils/sync.test.ts`

**Interfaces:**
- Consumes: `detection.pairs: Array<{ outTxId, inTxId }>` from `detectTransferPairs`; `crypto.randomUUID()` for the group id.

- [ ] **Step 1: Write the failing test.** In `src/utils/sync.test.ts`: two posted transactions in two mapped accounts, equal amount, opposite signs, within 3 days → assert the `saveMany` creates for both carry the **same** non-empty `sourceGroupId`.

- [ ] **Step 2: Run, expect fail.**

Run: `npx vitest run src/utils/sync.test.ts -t sourceGroupId`
Expected: FAIL.

- [ ] **Step 3: Implement.** After computing `detection`, build a map `groupByTxId: Map<string,string>`:

```ts
const groupByTxId = new Map<string, string>();
for (const pair of detection.pairs) {
  const gid = crypto.randomUUID();
  groupByTxId.set(pair.outTxId, gid);
  groupByTxId.set(pair.inTxId, gid);
}
```

In `toActivityCreate`/`toActivityUpdate` (Task 9), add `sourceGroupId: groupByTxId.get(t.txId)` (undefined when not part of a pair — omit the field if undefined).

- [ ] **Step 4: Run, expect pass.**

Run: `npx vitest run src/utils/sync.test.ts -t sourceGroupId`
Expected: PASS.

- [ ] **Step 5: Update docs.** In `README.md`, remove the "link transfers manually in the Spending tab" step. In `companion/upstream-pr.md`, mark Issue #3 addressed via sourceGroupId.

- [ ] **Step 6: Commit.**

```bash
git add src/utils/sync.ts src/utils/sync.test.ts README.md companion/upstream-pr.md
git commit -m "feat: auto-link transfer pairs via shared sourceGroupId"
```

---

## Final verification

- [ ] **Full addon suite:** `npx vitest run` → all pass.
- [ ] **Full companion suite:** from `companion/`, `npx vitest run` → all pass.
- [ ] **Typecheck:** `npx tsc --noEmit` (root and `companion/`) → exit 0.
- [ ] **Bundle:** `npm run bundle` → `dist/simplefin-sync-1.0.0.zip` produced.
- [ ] **Manual smoke (on the 3.6.2 stock image):** install the zip, force-sync, confirm (a) a known pending charge appears with a "pending" marker, (b) it updates in place when it posts (category retained), (c) a transfer pair links automatically (if Task 12 shipped).

---

## Self-review notes

- **Spec coverage:** A (Tasks 6-10), B (Tasks 11-12), C (Tasks 4-5), D (Tasks 1-3). All spec sections mapped.
- **Category safety:** enforced by update-in-place (Task 8 planner + Task 9 `toActivityUpdate` keyed by `wfId`) and the vanished-pending matcher (never delete+create when a same-account amount/date match exists).
- **Gate:** Task 11 gates Task 12; every other task is independent of the gate.
- **Open confirmations flagged in-task:** the `saveMany` REST route name (Task 10 Step 1) and whether `metadata` round-trips for a cleaner pending marker (spec A.2 — comment suffix is the committed fallback used throughout this plan).
