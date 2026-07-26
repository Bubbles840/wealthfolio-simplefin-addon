# Companion Parity via Shared Sync Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all sync orchestration into a single `runSyncCore` shared by the addon and the Docker companion, then bring the companion to full parity and publish it to GHCR.

**Architecture:** `src/utils/sync.ts` (982 lines) currently mixes deciding what to do, talking to Wealthfolio, and reading config. Extract the decisions into `shared/sync-core.ts` behind two interfaces — `SyncHost` (outside world) and `SyncStore` (config/state). The addon supplies an adapter over `ctx.api.*`; the companion supplies one over its REST client. Linking is a *host capability* because the hosts genuinely differ: the addon must delete-and-recreate both legs, while the companion can call `POST /api/v1/activities/link`.

**Tech Stack:** TypeScript, Vitest, Vite (addon bundle), Node 22 + node-cron (companion), Docker multi-stage, GitHub Actions → GHCR.

**Spec:** `docs/superpowers/specs/2026-07-26-companion-parity-shared-core-design.md`

## Global Constraints

- Addon behavior must not change in Phase 1. All **196** existing tests keep passing unmodified except where they assert internal structure.
- Cash-transfer legs (`TRANSFER_IN`/`TRANSFER_OUT`) are sent with **no** `symbol`/`asset`. All other types keep `$CASH-<ccy>`.
- Transfer group ids are prefixed `wf-transfer-`; link writes carry `metadata` as a **JSON string** (`{"flow":{"is_external":false}}`), never an object.
- Both legs of a pair must be written in a **single** `saveMany` call.
- Drift is measured only on settled accounts (no pending rows anywhere, create-only run).
- Balance plugs on CASH accounts are `CREDIT` (`amount` to add, `fee` to remove); other account types keep `DEPOSIT`/`WITHDRAWAL`.
- The companion must never persist the SimpleFin access URL to disk.
- Never log credentials; keep `maskUrl` in every log path.
- Commit after every task. Run `npm test -- --run` and `npm run type-check` before each commit.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `shared/sync-host.ts` | NEW. `SyncHost`, `SyncStore`, `HostActivity`, `LinkLeg`, `SaveManyRequest/Result` types. No logic. |
| `shared/sync-core.ts` | NEW. `runSyncCore(host, store, opts)` — all orchestration moved from `sync.ts`. |
| `shared/fake-host.ts` | NEW (test support). In-memory `SyncHost` + `SyncStore` for core tests. |
| `src/utils/addon-host.ts` | NEW. `AddonSyncHost` implementing `SyncHost` over `ctx.api.*`, including the recreate-both-legs `linkPair`. |
| `src/utils/sync.ts` | Shrinks to a wrapper: build adapter, call `runSyncCore`, keep `runSync`/`applyBalanceAdjustment` exports. |
| `companion/src/wealthfolio.ts` | Add `saveMany`, `deleteActivities`, `getAddonSecret`, `setAddonSecret`. |
| `companion/src/rest-host.ts` | NEW. `RestSyncHost` + `RestSyncStore` over the REST client. |
| `companion/src/index.ts` | `runCompanionSync` delegates to `runSyncCore`; drop `state.json` secret persistence. |
| `.github/workflows/docker.yml` | NEW. Build + push image to GHCR on tag. |

Phase 1 = Tasks 1–5 (refactor; addon unchanged, independently testable).
Phase 2 = Tasks 6–10 (companion parity + distribution).

---

## Task 1: Define the host and store interfaces

**Files:**
- Create: `shared/sync-host.ts`
- Test: none (types only; compile-checked by later tasks)

**Interfaces:**
- Produces: `SyncHost`, `SyncStore`, `HostActivity`, `LinkLeg`, `LinkResult`, `SaveManyRequest`, `SaveManyResult`, `ImportRow`.

- [ ] **Step 1: Write the interface file**

```ts
import type { AccountMapping, MappingRule, SimplefinAccountSet } from './types.js';

/** A Wealthfolio activity row, normalized across the SDK and REST shapes. */
export interface HostActivity {
  id: string;
  accountId: string;
  activityType: string;
  date: string;          // YYYY-MM-DD
  amount: string | number | null;
  comment: string | null;
  assetId?: string;
  sourceGroupId?: string | null;
}

export interface ActivityWrite {
  id?: string;
  accountId: string;
  activityType: string;
  activityDate: string;
  symbol?: { symbol: string };
  amount?: number;
  fee?: number;
  currency: string;
  comment: string;
  metadata?: string;
  sourceGroupId?: string;
}

export interface SaveManyRequest {
  creates?: ActivityWrite[];
  updates?: ActivityWrite[];
  deleteIds?: string[];
}

export interface SaveManyResult {
  created: HostActivity[];
  updated: HostActivity[];
  errors: Array<{ action: string; message: string }>;
}

/** One side of a transfer pair, with everything a host needs to re-create it. */
export interface LinkLeg {
  wfId: string;
  accountId: string;
  txId: string;
  activityType: string;
  date: string;
  absCents: number;
  currency: string;
  comment: string;
}

export interface LinkResult {
  linked: boolean;
  groupId?: string;
}

/** A row for the relaxed import endpoint (starting balances, plugs). */
export interface ImportRow {
  accountId: string;
  activityType: string;
  date: string;
  symbol: string;
  amount: number;
  fee?: number;
  currency: string;
  comment: string;
  isValid: true;
  isDraft: false;
}

export interface SyncHost {
  fetchSimplefin(accessUrl: string, since: Date, authKey?: string | null): Promise<SimplefinAccountSet>;
  listAccounts(): Promise<Array<{ id: string; accountType: string; name?: string }>>;
  latestValuations(accountIds: string[]): Promise<Map<string, number>>;
  listActivities(wfAccountId: string): Promise<HostActivity[]>;
  saveMany(req: SaveManyRequest): Promise<SaveManyResult>;
  importActivities(rows: ImportRow[]): Promise<void>;
  /** Record that two activities are one internal transfer. */
  linkPair(legs: [LinkLeg, LinkLeg]): Promise<LinkResult>;
  readonly capabilities: {
    /** True when listActivities returns a trustworthy sourceGroupId. */
    readsSourceGroupId: boolean;
  };
}

/** Config and shared state. The addon's SecretsStore already satisfies this. */
export interface SyncStore {
  getAccessUrl(): Promise<string | null>;
  getAuthB64Key(): Promise<string | null>;
  getAccountMapping(): Promise<AccountMapping | null>;
  getMappingRules(): Promise<MappingRule[]>;
  getBalanceInitialized(): Promise<string[]>;
  addBalanceInitialized(sfinAccountId: string): Promise<void>;
  getLastSyncAt(): Promise<Date | null>;
  setLastSyncAt(date: Date): Promise<void>;
  getLinkedGroups(): Promise<Record<string, string>>;
  setLinkedGroups(map: Record<string, string>): Promise<void>;
  getAccountBalances(): Promise<Record<string, unknown>>;
  setAccountBalances(map: Record<string, unknown>): Promise<void>;
  getAutoHeal(): Promise<boolean>;
  getAutoAdjust(): Promise<boolean>;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run type-check`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add shared/sync-host.ts
git commit -m "feat: define SyncHost and SyncStore interfaces for the shared sync core"
```

---

## Task 2: Build the in-memory fake host

**Files:**
- Create: `shared/fake-host.ts`
- Test: `shared/fake-host.test.ts`

**Interfaces:**
- Consumes: all types from Task 1.
- Produces: `createFakeHost(seed?)` returning
  `{ host, store, activities, saved, links, imported }`:
  - `activities: Map<string, HostActivity[]>` keyed by Wealthfolio account id
  - `saved: SaveManyRequest[]` — every `saveMany` call, in order
  - `links: Array<[LinkLeg, LinkLeg]>` — every `linkPair` call
  - `imported: ImportRow[][]` — every `importActivities` call
  `seed` accepts `{ accountSet?, mapping?, accountTypes?, valuations?, autoHeal?, autoAdjust?, existing? }`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { createFakeHost } from './fake-host.js';

describe('createFakeHost', () => {
  it('records saveMany calls and assigns ids to creates', async () => {
    const { host, saved } = createFakeHost();
    const res = await host.saveMany({
      creates: [{ accountId: 'a', activityType: 'WITHDRAWAL', activityDate: '2026-07-01',
                  amount: 5, currency: 'USD', comment: 'Coffee · tx-1' }],
    });
    expect(res.created).toHaveLength(1);
    expect(res.created[0].id).toBeTruthy();
    expect(res.errors).toEqual([]);
    expect(saved).toHaveLength(1);
  });

  it('links a pair and reports the group id', async () => {
    const { host } = createFakeHost();
    const leg = (wfId: string, accountId: string, type: string) => ({
      wfId, accountId, txId: wfId, activityType: type, date: '2026-07-01',
      absCents: 100, currency: 'USD', comment: `x · ${wfId}`,
    });
    const out = await host.linkPair([leg('o', 'a', 'TRANSFER_OUT'), leg('i', 'b', 'TRANSFER_IN')]);
    expect(out.linked).toBe(true);
    expect(out.groupId).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run shared/fake-host.test.ts`
Expected: FAIL — cannot resolve `./fake-host.js`.

- [ ] **Step 3: Implement the fake**

Implement `createFakeHost` with: an `activities` map, an incrementing id counter, `saveMany` applying creates/updates/deleteIds to the map and echoing rows back with `notes` mirroring `comment`, `linkPair` stamping a `wf-transfer-<n>` group id on both rows, `capabilities.readsSourceGroupId = true`, and an in-memory `store` whose getters return sensible defaults (`getAccountMapping` → `{}`, `getMappingRules` → `[]`, `getAutoHeal`/`getAutoAdjust` → `false`). `fetchSimplefin` returns a seedable `SimplefinAccountSet` (default `{ errors: [], accounts: [] }`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run shared/fake-host.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/fake-host.ts shared/fake-host.test.ts
git commit -m "test: add in-memory fake SyncHost for core tests"
```

---

## Task 3: Extract `runSyncCore` (import + reconcile path)

Move the import half of `runSyncOnce` into `shared/sync-core.ts`, leaving linking and healing behind for Tasks 4–5.

**Files:**
- Create: `shared/sync-core.ts`
- Create: `src/utils/addon-host.ts`
- Modify: `src/utils/sync.ts`
- Test: `shared/sync-core.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `createFakeHost` from Task 2, existing `mapTransactionWithSource`, `detectTransferPairs`, `planReconciliation`.
- Produces: `runSyncCore(host: SyncHost, store: SyncStore, opts: SyncOptions): Promise<SyncResult>`;
  `AddonSyncHost` class implementing `SyncHost`. `SyncOptions` (`{ force?: boolean; heal?: boolean }`)
  and `SyncResult` (`{ imported: number; skipped: number; errors: string[] }`) move to
  `shared/sync-core.ts` and are re-exported from `src/utils/sync.ts` so existing imports keep working.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { runSyncCore } from './sync-core.js';
import { createFakeHost } from './fake-host.js';

describe('runSyncCore', () => {
  it('imports a new transaction with the cash symbol and tx-id comment', async () => {
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '100.00',
        'balance-date': 1700000000,
        transactions: [{ id: 'tx-1', posted: 1700000000, amount: '-12.50', description: 'Coffee' }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
    });
    const result = await runSyncCore(host, store, {});
    expect(result.imported).toBe(1);
    const create = saved[0].creates![0];
    expect(create.symbol).toEqual({ symbol: '$CASH-USD' });
    expect(create.comment).toBe('Coffee · tx-1');
  });

  it('omits the asset on transfer legs', async () => {
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': 1,
          transactions: [{ id: 'tx-out', posted: 1700000000, amount: '-500.00', description: 'Payment to Card' }] },
        { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '0', 'balance-date': 1,
          transactions: [{ id: 'tx-in', posted: 1700086400, amount: '500.00', description: 'PAYMENT THANK YOU' }] },
      ] },
      mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
    });
    await runSyncCore(host, store, {});
    const creates = saved.flatMap((s) => s.creates ?? []);
    const out = creates.find((c) => c.comment.includes('tx-out'))!;
    expect(out.activityType).toBe('TRANSFER_OUT');
    expect(out.symbol).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run shared/sync-core.test.ts`
Expected: FAIL — cannot resolve `./sync-core.js`.

- [ ] **Step 3: Move the import path into the core**

Copy `runSyncOnce`'s body from `src/utils/sync.ts` into `runSyncCore`, replacing every `ctx.api.*` call with the matching `host.*` call and every `store.*` call unchanged. Keep the constants (`SYNC_LOOKBACK_OVERLAP_MS`, `HEAL_WINDOW_MS`, `AUTO_HEAL_WINDOW_MS`, `DRIFT_THRESHOLD_DOLLARS`, `PENDING_SUFFIX`, `TRANSFER_GROUP_PREFIX`, `INTERNAL_TRANSFER_METADATA`) and the helpers (`txEpoch`, `txIdFromComment`, `isTransferType`, `neutralAdjustmentFields`) by moving them into `sync-core.ts` and re-exporting from `sync.ts` so existing imports keep working. For this task, leave the link flush and heal blocks in place but calling `host.saveMany` — they move in Tasks 4–5.

- [ ] **Step 4: Implement `AddonSyncHost`**

`src/utils/addon-host.ts` wraps `ctx.api`: `listAccounts` → `accounts.getAll()`; `latestValuations` → `portfolio.getLatestValuations(ids)` reduced to a `Map`; `listActivities` → `activities.search(0, 500, { accountIds: [id] }, '', { id: 'date', desc: true })` mapped to `HostActivity` (date via `new Date(a.date).toISOString().slice(0,10)`); `saveMany` → `activities.saveMany`; `importActivities` → `activities.import`; `fetchSimplefin` → the existing `fetchAccounts(accessUrl, since, ctx.api.network, authKey)`. Set `capabilities.readsSourceGroupId = false`. Implement `linkPair` in Task 4 — for now `throw new Error('not implemented')`.

- [ ] **Step 5: Rewire `runSync`**

`src/utils/sync.ts` keeps `runSync`, `SyncOptions`, `applyBalanceAdjustment`, and the single-flight lock, but its body becomes: build `new AddonSyncHost(ctx)`, then `return runSyncCore(host, store, opts)`.

- [ ] **Step 6: Run the whole suite**

Run: `npm test -- --run && npm run type-check`
Expected: all existing tests plus the new core tests pass. Fix any test that asserted internals rather than behavior.

- [ ] **Step 7: Commit**

```bash
git add shared/sync-core.ts src/utils/addon-host.ts src/utils/sync.ts shared/sync-core.test.ts
git commit -m "refactor: extract the import path into shared runSyncCore behind SyncHost"
```

---

## Task 4: Move linking behind `host.linkPair`

**Files:**
- Modify: `shared/sync-core.ts`, `src/utils/addon-host.ts`
- Test: `shared/sync-core.test.ts`, `src/utils/sync.test.ts`

**Interfaces:**
- Consumes: `LinkLeg`, `LinkResult`, `capabilities.readsSourceGroupId`.
- Produces: core calls `host.linkPair` once per unlinked pair; ledger reconciliation is skipped when `readsSourceGroupId` is true.

- [ ] **Step 1: Write the failing test**

```ts
it('asks the host to link each detected pair exactly once', async () => {
  const { host, store, links } = createFakeHost({
    accountSet: { errors: [], accounts: [
      { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [{ id: 'tx-out', posted: 1700000000, amount: '-500.00', description: 'Payment to Card' }] },
      { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [{ id: 'tx-in', posted: 1700086400, amount: '500.00', description: 'PAYMENT THANK YOU' }] },
    ] },
    mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
  });
  await runSyncCore(host, store, {});
  expect(links).toHaveLength(1);
  const [a, b] = links[0];
  expect(new Set([a.activityType, b.activityType]))
    .toEqual(new Set(['TRANSFER_OUT', 'TRANSFER_IN']));
});

it('skips the ledger when the host reads sourceGroupId back', async () => {
  const { host, store } = createFakeHost({
    accountSet: { errors: [], accounts: [
      { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [{ id: 'tx-out', posted: 1700000000, amount: '-500.00', description: 'Payment to Card' }] },
      { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [{ id: 'tx-in', posted: 1700086400, amount: '500.00', description: 'PAYMENT THANK YOU' }] },
    ] },
    mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
  });
  await runSyncCore(host, store, {});
  expect(await store.getLinkedGroups()).toEqual({});
});
```

Extend the fake to record `links: Array<[LinkLeg, LinkLeg]>`.

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run shared/sync-core.test.ts`
Expected: FAIL — `links` undefined / ledger written.

- [ ] **Step 3: Replace the inline flush with `host.linkPair`**

In `sync-core.ts`, replace the delete/recreate flush with: for each detected pair not already linked, build two `LinkLeg`s and `await host.linkPair(legs)`. When `capabilities.readsSourceGroupId` is true, decide "already linked" by comparing both rows' `sourceGroupId`; otherwise use the `linked_groups` ledger and update it from `LinkResult.groupId` (purging on `linked === false`).

- [ ] **Step 4: Implement the addon's `linkPair`**

Move the existing addon strategy into `AddonSyncHost.linkPair`: mint `wf-transfer-<uuid>`, `saveMany({ deleteIds: [both wfIds] })`, then one `saveMany({ creates: [both legs] })` with no `symbol`, `metadata: INTERNAL_TRANSFER_METADATA`, and the shared `sourceGroupId`; read the echo and return `{ linked, groupId }`.

- [ ] **Step 5: Run everything**

Run: `npm test -- --run && npm run type-check`
Expected: PASS. Update `src/utils/sync.test.ts` link assertions to go through the adapter.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: make transfer linking a SyncHost capability"
```

---

## Task 5: Move healing and baseline correction into the core

**Files:**
- Modify: `shared/sync-core.ts`, `src/utils/sync.ts`
- Test: `shared/sync-core.test.ts`

**Interfaces:**
- Produces: `neutralAdjustmentFields(accountType, signedAmount)` and `adjustStartingBalanceForOlderRows(...)` exported from `sync-core.ts`; `sync.ts` re-exports `neutralAdjustmentFields` for the existing tests.

- [ ] **Step 1: Write the failing test**

```ts
it('plugs CASH drift with a spending-neutral CREDIT', async () => {
  const { host, store, imported } = createFakeHost({
    accountSet: { errors: [], accounts: [{ id: 'sfin-1', name: 'C', currency: 'USD',
      balance: '100.00', 'balance-date': 1, transactions: [] }] },
    mapping: { 'sfin-1': 'wf-a' },
    accountTypes: { 'wf-a': 'CASH' },
    valuations: { 'wf-a': 0 },
    autoHeal: true, autoAdjust: true,
  });
  await runSyncCore(host, store, { heal: true });
  const plug = imported.flat().find((r) => r.comment.startsWith('Balance adjustment'))!;
  expect(plug.activityType).toBe('CREDIT');
  expect(plug.amount).toBe(100);
  expect(plug.fee).toBe(0);
});

it('nets pre-baseline history out of the starting balance', async () => {
  const { host, store, saved } = createFakeHost({
    accountSet: { errors: [], accounts: [{ id: 'sfin-1', name: 'C', currency: 'USD',
      balance: '3200.38', 'balance-date': 1,
      transactions: [{ id: 'tx-old', posted: Date.parse('2026-04-23T12:00:00Z') / 1000,
                       amount: '-1300.00', description: 'ACH Withdrawal' }] }] },
    mapping: { 'sfin-1': 'wf-a' },
    existing: { 'wf-a': [{ id: 'act-start', accountId: 'wf-a', activityType: 'DEPOSIT',
                           date: '2026-06-18', amount: '4500.38', comment: 'Starting balance · sfin-1' }] },
  });
  await runSyncCore(host, store, {});
  const update = saved.flatMap((s) => s.updates ?? []).find((u) => u.id === 'act-start')!;
  expect(update.amount).toBeCloseTo(5800.38, 2);
  expect(update.activityType).toBe('DEPOSIT');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run shared/sync-core.test.ts`
Expected: FAIL.

- [ ] **Step 3: Move the heal, plug, and baseline blocks**

Move `neutralAdjustmentFields`, `importAdjustmentActivity`, `fetchStartingBalance`, `adjustStartingBalanceForOlderRows`, and the drift-measurement block into `sync-core.ts`, replacing `ctx.api.*` with `host.*`. `applyBalanceAdjustment` in `sync.ts` becomes a thin wrapper that builds the adapter and calls the core helper.

- [ ] **Step 4: Run everything**

Run: `npm test -- --run && npm run type-check`
Expected: all 196 original tests plus the new core tests pass.

- [ ] **Step 5: Verify `sync.ts` is now thin**

Run: `wc -l src/utils/sync.ts`
Expected: under 150 lines.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move drift healing and baseline correction into the shared core"
```

---

## Task 6: Extend the REST client

**Files:**
- Modify: `companion/src/wealthfolio.ts`
- Test: `companion/src/wealthfolio.test.ts`

**Interfaces:**
- Produces: `saveMany(req)`, `deleteActivities(ids)`, `getAddonSecret(addonId, key)`, `setAddonSecret(addonId, key, value)` on `WealthfolioClient`.

- [ ] **Step 1: Write the failing test**

```ts
it('reads an addon secret', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ value: 'https://u:p@bridge' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const c = new WealthfolioClient('http://wf');
  const v = await c.getAddonSecret('simplefin-sync', 'simplefin_access_url');
  expect(v).toBe('https://u:p@bridge');
  expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/addons/simplefin-sync/secrets?key=simplefin_access_url');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd companion && npx vitest run src/wealthfolio.test.ts`
Expected: FAIL — `getAddonSecret is not a function`.

- [ ] **Step 3: Implement the methods**

`getAddonSecret` → `GET /api/v1/addons/{addonId}/secrets?key={key}`, returning the value or `null` on 404. `setAddonSecret` → `POST` the same path with `{ key, value }`. `saveMany` → `POST /api/v1/activities/bulk`. `deleteActivities` → include `deleteIds` in the same bulk call. All use `authHeaders()`.

- [ ] **Step 4: Run tests**

Run: `cd companion && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add companion/src/wealthfolio.ts companion/src/wealthfolio.test.ts
git commit -m "feat: add bulk save and addon-secret access to the REST client"
```

---

## Task 7: Implement the companion adapters

**Files:**
- Create: `companion/src/rest-host.ts`
- Test: `companion/src/rest-host.test.ts`

**Interfaces:**
- Consumes: `SyncHost`/`SyncStore` from Task 1, `WealthfolioClient` from Task 6.
- Produces: `RestSyncHost`, `RestSyncStore` (constructed with a logged-in client and the addon id `simplefin-sync`).

- [ ] **Step 1: Write the failing test**

```ts
it('links a pair with one call to the link endpoint', async () => {
  const client = { linkTransferActivities: vi.fn(async () => {}),
                   searchActivities: vi.fn(async () => [{ id: 'o', sourceGroupId: 'g1' }]) } as any;
  const host = new RestSyncHost(client);
  const leg = (wfId: string) => ({ wfId, accountId: 'a', txId: wfId, activityType: 'TRANSFER_OUT',
                                   date: '2026-07-01', absCents: 100, currency: 'USD', comment: `x · ${wfId}` });
  const out = await host.linkPair([leg('o'), leg('i')]);
  expect(client.linkTransferActivities).toHaveBeenCalledWith('o', 'i');
  expect(out.linked).toBe(true);
});

it('reports readsSourceGroupId', () => {
  expect(new RestSyncHost({} as any).capabilities.readsSourceGroupId).toBe(true);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd companion && npx vitest run src/rest-host.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapters**

`RestSyncHost` maps each `SyncHost` method to the client, normalizing search rows into `HostActivity` (including `sourceGroupId` and `assetId`), and implements `linkPair` as a single `linkTransferActivities(a.wfId, b.wfId)` followed by a re-read to confirm and return the stored group id. `fetchSimplefin` delegates to the existing `fetchAccountsNode`. `RestSyncStore` implements every `SyncStore` method via `getAddonSecret`/`setAddonSecret` with the addon's existing key names (`simplefin_access_url`, `account_mapping`, `mapping_rules`, `balance_initialized`, `last_sync_at`, `linked_groups`, `account_balances`, `auto_heal`, `auto_adjust`), JSON-parsing values and defaulting on `null`.

- [ ] **Step 4: Run tests**

Run: `cd companion && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add companion/src/rest-host.ts companion/src/rest-host.test.ts
git commit -m "feat: add REST SyncHost and SyncStore adapters for the companion"
```

---

## Task 8: Run the companion on the shared core

**Files:**
- Modify: `companion/src/index.ts`
- Test: `companion/src/index.test.ts`

**Interfaces:**
- Consumes: `runSyncCore`, `RestSyncHost`, `RestSyncStore`.
- Produces: `runCompanionSync()` unchanged in signature; `ACCOUNT_MAPPING` and `SIMPLEFIN_*` env vars removed; `state.json` no longer stores the access URL.

- [ ] **Step 1: Write the failing test**

```ts
it('requires only the Wealthfolio URL and password', () => {
  process.env.WEALTHFOLIO_API_URL = 'http://wf';
  process.env.WEALTHFOLIO_PASSWORD = 'pw';
  delete process.env.ACCOUNT_MAPPING;
  delete process.env.SIMPLEFIN_ACCESS_URL;
  expect(() => validateStartupEnv()).not.toThrow();
});

it('never writes the access URL to the state file', async () => {
  const stateFile = `${tmpdir()}/companion-state-${Date.now()}.json`;
  process.env.STATE_FILE = stateFile;
  process.env.WEALTHFOLIO_API_URL = 'http://wf';
  process.env.WEALTHFOLIO_PASSWORD = 'pw';
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/auth/login')) {
      return new Response('{}', { status: 200, headers: { 'set-cookie': 'wf_session=jwt' } });
    }
    if (String(url).includes('simplefin_access_url')) {
      return new Response(JSON.stringify({ value: 'https://u:p@bridge.simplefin.org/simplefin' }), { status: 200 });
    }
    return new Response(JSON.stringify({ value: null }), { status: 200 });
  }));

  await runCompanionSync();

  const written = existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : '';
  expect(written).not.toContain('bridge.simplefin.org');
  expect(written).not.toContain('u:p@');
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd companion && npx vitest run src/index.test.ts`
Expected: FAIL — `validateStartupEnv` still demands `ACCOUNT_MAPPING`.

- [ ] **Step 3: Rewire the entrypoint**

`runCompanionSync` becomes: construct `WealthfolioClient`, `login(WEALTHFOLIO_PASSWORD)`, build `RestSyncStore`/`RestSyncHost`, call `runSyncCore(host, store, {})`, log the result with `maskUrl` applied to any URL. Delete `reconcileTransferLinks`, the local mapping parsing, and the access-URL persistence (`resolveAccessUrl` now reads from the store; if the addon has no access URL, log a clear "configure the addon first" error and exit non-zero). Support `WEALTHFOLIO_PASSWORD_FILE` as an alternative to the plain variable.

- [ ] **Step 4: Run tests**

Run: `cd companion && npx vitest run && cd .. && npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add companion/src/index.ts companion/src/index.test.ts
git commit -m "feat: run the companion on the shared sync core"
```

---

## Task 9: Harden and document the container

**Files:**
- Modify: `companion/Dockerfile`, `docker-compose.example.yml`, `README.md`

- [ ] **Step 1: Pin the base image by digest**

Replace both `FROM node:22-alpine` lines with a digest-pinned form (`node:22-alpine@sha256:<digest>`), obtained via `docker buildx imagetools inspect node:22-alpine`.

- [ ] **Step 2: Drop the state volume requirement**

Remove `/data` creation if the state file no longer holds anything; if `last_sync_at` still needs a local fallback, keep the volume but document that it contains no credentials.

- [ ] **Step 3: Update compose and README**

`docker-compose.example.yml` reduces to `WEALTHFOLIO_API_URL` and `WEALTHFOLIO_PASSWORD_FILE`, with a comment that the SimpleFin credential comes from the addon. Add a README "Security" subsection covering: the password grants full instance access, prefer an internal network or HTTPS, keep the env file mode-600 and untracked, and note that at-rest encryption is the host's responsibility.

- [ ] **Step 4: Build the image**

Run: `docker build -f companion/Dockerfile -t simplefin-sync:local .`
Expected: builds; `docker run --rm simplefin-sync:local node -e "console.log(process.getuid())"` prints a non-zero uid.

- [ ] **Step 5: Commit**

```bash
git add companion/Dockerfile docker-compose.example.yml README.md
git commit -m "chore: harden the companion image and document its security posture"
```

---

## Task 10: Publish to GHCR

**Files:**
- Create: `.github/workflows/docker.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Publish companion image
on:
  push:
    tags: ['v*']
  workflow_dispatch:

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/${{ github.repository_owner }}/wealthfolio-simplefin-sync
          tags: |
            type=semver,pattern={{version}}
            type=raw,value=latest
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: companion/Dockerfile
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

- [ ] **Step 2: Trigger it**

Run: `gh workflow run "Publish companion image"` (or push a `v1.1.0` tag).
Expected: the run succeeds and the package appears under the repo's Packages.

- [ ] **Step 3: Make the package public**

In GitHub → Packages → the image → Package settings → change visibility to Public, so users can pull without authenticating.

- [ ] **Step 4: Document the pull command**

Add to the README: `docker pull ghcr.io/bubbles840/wealthfolio-simplefin-sync:latest`, and switch `docker-compose.example.yml` from `build:` to `image:` with a commented-out `build:` for local development.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/docker.yml README.md docker-compose.example.yml
git commit -m "ci: publish the companion image to GHCR on tag"
```

---

## Verification

End-to-end, after Task 10:

1. `npm test -- --run` — all addon and core tests pass; `cd companion && npx vitest run` — companion tests pass.
2. `npm run type-check` clean at the repo root.
3. Reinstall the addon zip and press **Sync Now** and **Reconcile & link** — behavior identical to v1.0.0, accounts still in sync.
4. Start the container against the live instance with only `WEALTHFOLIO_API_URL` and `WEALTHFOLIO_PASSWORD_FILE` set. Confirm the log shows a successful sync, no credential appears in the log, and the state file contains no `bridge.simplefin.org` string.
5. Make a change in the addon UI (add a mapping rule), then run the container again and confirm the rule takes effect without touching the container's configuration — this proves the single-source-of-truth design.
6. Introduce a new internal transfer between two mapped accounts and confirm the companion links it, that it drops out of Spending, and that both balances move.
