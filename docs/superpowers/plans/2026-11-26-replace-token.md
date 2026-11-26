# Replace the SimpleFIN token without Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let someone paste a new SimpleFIN setup token in Settings and keep syncing with every setting kept, and put a "Replace token" button wherever a refused connection (401/403) is reported.

**Architecture:** Pure helpers in `shared/simplefin-connection.ts` (both halves) decide what a refused connection is, name the provider and list missing mapped accounts. The add-on's `src/utils/connect.ts` holds the one claim helper (Setup moves onto it) and `replaceConnection`, which tests a claimed token under a temporary secret key and swaps the stored connection only after it lists accounts. A Settings card drives it; the sync error, the Accounts refresh error and a Home banner fed by the companion's `sync_health` link to that card. The companion stamps `lastFailedAt` on each failure and adds the fix line to its Telegram alert.

**Tech Stack:** TypeScript, React 19 (add-on, Wealthfolio add-on sandbox), Node (companion), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-26-replace-token-design.md` (approved; this plan does not redesign it).

## Global Constraints

- Work only in the worktree `/Users/nawrig04/Personal Projects/wf-replace-token`, branch `feat/replace-token`.
- Gates: `nice npx vitest run --maxWorkers=2` (add-on, = `npm test`), `(cd companion && nice npx vitest run --maxWorkers=2)` (never `--root`), `nice npm run type-check`, `nice npm --prefix companion run build`.
- Machine load: every vitest run is `nice … --maxWorkers=2`. In-task steps run only the touched test files; the full suites run once, at the end of each task.
- Tests pin dates: a fixed `NOW` with `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(NOW)`, restored with `vi.useRealTimers()` in `afterEach`/`finally`, or fixed ISO strings that never depend on the clock. They must pass with the clock forced into 2027 (Task 6, Step 8). No assertion relies on `new Date()`.
- Never put the access URL or its credentials in UI text, logs, change-log entries or test-asserted user copy. The card shows only `providerName(...)`.
- No manifest or permission changes.
- Shared modules import siblings with the `.js` suffix (`./simplefin-hosts.js`); add-on files import `../../shared/x` without it, as the repo does.
- New store methods are called through `?.` wherever a test double may lack them (`store.getSyncHealth?.()`, `store.getConnectionReplacedAt?.()`, `store.recordChange?.()`, `store.getLoanLinks?.()`).
- `src/utils/connect.ts` imports only `claimToken` and `fetchAccounts` from `./simplefin`. SetupPage.test and SettingsTab.test mock that module with a factory that lacks the other exports (`hostNotApprovedMessage` among them), and claimToken already applies `hostNotApprovedMessage`.
- Copy: no emoji in add-on chrome (`src/pages/copy-policy.test.tsx`); `✓` (U+2713) is allowed. New copy says "SimpleFIN", as the spec does; the product stays "SimpleFin Sync".
- Exact strings (shared constants, Task 1):
  - `REFUSED_CONNECTION_LINE` = `SimpleFIN no longer accepts this connection. Paste a new setup token in SimpleFin Sync → Settings → SimpleFIN connection; your mapping and rules stay.`
  - `REFUSED_CONNECTION_SHORT` (UI, beside a button, planner's call) = `SimpleFIN no longer accepts this connection. Replace the token to carry on; your mapping and rules stay.`
- Secret keys: `simplefin_auth_b64_next` (temporary test credentials) and `simplefin_connection_replaced_at` (ISO time). Both go in `KEYS` so `clearAll` deletes them.
- CHANGELOG: under `## [Unreleased]`, a new `### Added` placed above the existing `### Fixed`. README gets the how-to. No version bump (ships in 1.78.0).
- Commits: plain sentences in the repo's style (`git log --oneline -15`), body ending with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push, merge or tag.

## Planner's calls

1. **Loan links count as mapped.** `LoanLinks` is keyed by SimpleFin account id (`shared/loan-balances.ts:22`, "SimpleFin account id → the Wealthfolio liability"), the same as `AccountMapping`, so `missingMappedAccounts` takes the loan links too. A mapping entry with an empty target is not mapped.
2. **"Map them below" becomes "in the Accounts card above".** The spec puts the card directly after Accounts, so the mapper is above it. The card opens the Accounts card but does not scroll away from its own result line.
3. **Running syncs.** SettingsTab cannot see a sync. SyncPage passes `syncing={syncing || healing}` to disable Connect. `replaceConnection` also takes the add-on write lock (`beginWrite`, `src/utils/write-lock.ts`) before the budget check and the claim, and holds it until the swap is written. A scheduled or startup sync then never reads a half-swapped connection: it waits. A Connect pressed while one runs is refused with `writeRefusal('remove')` ("A sync is running — try again when it finishes."), and nothing is spent. The companion's syncs are in another process and stay invisible.
4. **The temporary key is deleted on failure as well as on success.** Nothing but that key is ever written before the test passes.
5. **Wording edge cases:** one mapped account, none mapped, one missing (see `replacedMessage` in Task 3). The empty-list reason is `the account list was empty`. A reason's trailing period is dropped before it is quoted.
6. **The change-log kind `connection-replaced` groups under Rules**, beside `account-created`: a setup change. Its summary is exactly `Replaced the SimpleFIN connection`, with the provider names in `before`/`after`.
7. **Feed errors on a successful replace** show in the card (`SimpleFin: <errors>`), as Setup shows them, and set `sfAccountsHadErrors` for the mapper. The fetched list goes to the Accounts card on every success. The Accounts card opens only when mapped accounts are missing.
8. **The card's summary is blank until the access URL is read.** A transient "Not connected" would collide with the Telegram card's "Not connected" in existing `findByText` tests.
9. **SettingsTab gets `onNavigate`** (SyncPage's `navigate`), because the Accounts-error button must call `navigate('settings', CARD.connection)` like the others.
10. **Home Assistant is left alone.** Its failing-sync alert is built by `syncHealthEntry` (`shared/home-assistant.ts:425`), not from the Telegram text.

## Review Focus

1. **The access URL (or half a token) pasted into the token box.** The person should get claimToken's "does not look like a SimpleFin setup token", nothing should be stored, and the URL and its password must never come back in the message. Pinned in Task 3: `refuses an access URL pasted as a token, storing nothing and echoing nothing`.
2. **Lunch Flow hosts left unticked after an update.** Wealthfolio refuses the claim. The approval message should reach the card, the token should stay unspent, and pressing Connect again after ticking should claim exactly once. Pinned in Task 3: `passes on Wealthfolio's host-approval message and claims again on retry`.
3. **A scheduled or startup sync already running when Connect is pressed.** Nothing should be claimed or counted, and the person should be told to wait. Pinned in Task 3: `refuses while a sync holds the add-on write lock, claiming and counting nothing`.
4. **The companion fails again after a replace, or is an old companion without `lastFailedAt`.** The Home banner must come back for a failure after the replace. With an old companion it falls back to `firstFailedAt`. Clocks on two machines can also disagree, so an unreadable time never hides it. Pinned in Task 1: `companionConnectionRefused` cases `fails again after the replace`, `old companion` and `unreadable replace time`.
5. **402 (SimpleFIN's "payment required"), a 403 on the claim, and a bare `HTTP 403`.** A new token fixes none of them, so none may offer Replace token. Pinned in Task 1 (`is never true for 402, a claim's 403, or another host's 403`) and Task 5 (`offers nothing extra for a 402`).

---

### Task 1: Shared connection helpers

**Files:**
- Create: `shared/simplefin-connection.ts`
- Create: `shared/simplefin-connection.test.ts`
- Modify: `shared/telegram.ts:1359-1364` (`SyncHealth` gains `lastFailedAt?: string`)

**Interfaces:**
- Consumes: `isSimplefinBridgeHost` (`shared/simplefin-hosts.ts`), `type SyncHealth` (`shared/telegram.ts`).
- Produces:
  - `REFUSED_CONNECTION_LINE: string` and `REFUSED_CONNECTION_SHORT: string` (exact text in Global Constraints).
  - `isRefusedConnection(errOrMessage: unknown, status?: number): boolean`.
  - `providerName(accessUrl: string | null | undefined): string | null`.
  - `mappedAccountIds(mapping: Record<string, string>, loanLinks?: Record<string, string>): string[]`.
  - `missingMappedAccounts(mapping: Record<string, string>, accounts: readonly { id: string }[], loanLinks?: Record<string, string>): string[]`.
  - `companionConnectionRefused(health: Pick<SyncHealth, 'firstFailedAt' | 'lastFailedAt' | 'lastError'> | null | undefined, replacedAt: string | null | undefined): boolean`.
  - `SyncHealth.lastFailedAt?: string`.

- [ ] **Step 1: Write the failing tests** in `shared/simplefin-connection.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  REFUSED_CONNECTION_LINE, companionConnectionRefused, isRefusedConnection, mappedAccountIds, missingMappedAccounts, providerName,
} from './simplefin-connection.js';

describe('isRefusedConnection', () => {
  it('is true for a 401 or 403 status, which wins over the message', () => {
    expect(isRefusedConnection({ status: 403, message: 'x' })).toBe(true);
    expect(isRefusedConnection({ status: 401 })).toBe(true);
    expect(isRefusedConnection('anything', 403)).toBe(true);
    expect(isRefusedConnection('SimpleFin /accounts failed: 403', 500)).toBe(false);
    expect(isRefusedConnection({ status: 402, message: 'SimpleFin /accounts failed: 403' })).toBe(false);
  });
  it('reads the companion text when there is no status', () => {
    expect(isRefusedConnection('SimpleFin /accounts failed: 403')).toBe(true);
    expect(isRefusedConnection('SimpleFin /accounts failed: 401 — Unauthorized')).toBe(true);
    expect(isRefusedConnection(new Error('SimpleFin /accounts failed: 403 — Forbidden'))).toBe(true);
  });
  it("is never true for 402, a claim's 403, or another host's 403", () => {
    expect(isRefusedConnection('SimpleFin /accounts failed: 402 — Payment required')).toBe(false);
    expect(isRefusedConnection('SimpleFin /accounts failed: 4031')).toBe(false);
    expect(isRefusedConnection('SimpleFin /accounts failed: 524')).toBe(false);
    expect(isRefusedConnection('SimpleFin claim failed (403): this setup token was already used')).toBe(false);
    expect(isRefusedConnection('HTTP 403')).toBe(false);
    expect(isRefusedConnection(null)).toBe(false);
    expect(isRefusedConnection(undefined)).toBe(false);
  });
});

describe('providerName', () => {
  it('names the two providers and any other host, never the credentials', () => {
    expect(providerName('https://u:p@beta-bridge.simplefin.org/simplefin')).toBe('SimpleFIN Bridge');
    expect(providerName('https://u:p@www.lunchflow.app/simplefin')).toBe('Lunch Flow');
    expect(providerName('https://user:secret@example.com/simplefin')).toBe('example.com');
    expect(providerName('https://user:secret@example.com/simplefin')).not.toContain('secret');
  });
  it('is null for nothing, or for what does not parse', () => {
    expect(providerName(null)).toBeNull();
    expect(providerName('')).toBeNull();
    expect(providerName('not a url')).toBeNull();
  });
});

describe('mapped and missing accounts', () => {
  const mapping = { a: 'wf-1', b: 'wf-2', c: '' };
  const loans = { d: 'loan-1', a: 'loan-x' };
  it('counts a non-empty target and every loan link, once each, mapping order first', () => {
    expect(mappedAccountIds(mapping, loans)).toEqual(['a', 'b', 'd']);
    expect(mappedAccountIds(mapping)).toEqual(['a', 'b']);
  });
  it('lists the mapped ids the new list lacks, loans included', () => {
    expect(missingMappedAccounts(mapping, [{ id: 'a' }, { id: 'zzz' }], loans)).toEqual(['b', 'd']);
    expect(missingMappedAccounts(mapping, [{ id: 'a' }, { id: 'b' }, { id: 'd' }], loans)).toEqual([]);
  });
});

describe('companionConnectionRefused', () => {
  const refused = { firstFailedAt: '2026-11-20T10:00:00.000Z', lastFailedAt: '2026-11-25T10:00:00.000Z', lastError: 'SimpleFin /accounts failed: 403' };
  it.each([
    ['refused, never replaced', refused, null, true],
    ['replaced after the last failure', refused, '2026-11-25T11:00:00.000Z', false],
    ['fails again after the replace', refused, '2026-11-24T09:00:00.000Z', true],
    ['old companion: replaced after the first failure', { ...refused, lastFailedAt: undefined }, '2026-11-21T09:00:00.000Z', false],
    ['unreadable replace time', refused, 'garbage', true],
    ['another failure', { ...refused, lastError: 'SimpleFin /accounts failed: 524' }, null, false],
    ['a success', { lastSuccessAt: '2026-11-25T10:00:00.000Z' } as any, null, false],
    ['no record', null, null, false],
    ['a lastError that is not text', { ...refused, lastError: 403 as any }, null, false],
  ])('%s', (_name, health, replacedAt, shown) => {
    expect(companionConnectionRefused(health as any, replacedAt as any)).toBe(shown);
  });
});

it('the fix line is the one wording', () => {
  expect(REFUSED_CONNECTION_LINE).toBe('SimpleFIN no longer accepts this connection. Paste a new setup token in SimpleFin Sync → Settings → SimpleFIN connection; your mapping and rules stay.');
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `nice npx vitest run --maxWorkers=2 shared/simplefin-connection.test.ts`
Expected: FAIL, the module `./simplefin-connection.js` cannot be resolved.

- [ ] **Step 3: Implement `shared/simplefin-connection.ts`, and add `lastFailedAt?: string` to `SyncHealth`**

The file header says it is shared by both halves and imports nothing from either. `isRefusedConnection`: an explicit `status` argument decides. Otherwise a numeric `status` on an object decides. Otherwise the text decides (a string, or `.message` of an object), matched against `/\/accounts failed: 40[13]\b/`. `providerName`: `new URL(...)` inside try/catch. `isSimplefinBridgeHost(hostname)` gives `SimpleFIN Bridge`; `lunchflow.app` or a subdomain gives `Lunch Flow`; any other host gives its `hostname`. Never read `username` or `password`. `companionConnectionRefused`: true only when `firstFailedAt` and `lastError` are strings and `isRefusedConnection(lastError)` holds. It is false when `Date.parse(replacedAt)` is a number greater than `Date.parse(lastFailedAt ?? firstFailedAt)`.

- [ ] **Step 4: Run it to see it pass**

Run: `nice npx vitest run --maxWorkers=2 shared/simplefin-connection.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the gates once**

Run: `nice npx vitest run --maxWorkers=2`, then `nice npm run type-check`, `(cd companion && nice npx vitest run --maxWorkers=2)` and `nice npm --prefix companion run build`. `SyncHealth` is the companion's type too.
Expected: all PASS / succeed.

- [ ] **Step 6: Commit**

```bash
git add shared/simplefin-connection.ts shared/simplefin-connection.test.ts shared/telegram.ts
git commit -m "Shared SimpleFIN connection helpers: refused connections, provider names, missing mapped accounts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: One claim helper for Setup, and the store keys

**Files:**
- Create: `src/utils/connect.ts`
- Create: `src/utils/connect.test.ts`
- Modify: `src/pages/SetupPage.tsx:5,49-69` (the claim-reuse and base64 block moves onto the helper)
- Modify: `src/utils/secrets.ts:121-229` (KEYS), `:314-329` (beside the auth accessors), `:951` (`getSyncHealth` type)
- Test: `src/utils/secrets.test.ts` (uses its `makeCtxWithData`), `src/pages/SetupPage.test.tsx` (unchanged, must still pass)

**Interfaces:**
- Consumes: `claimToken(setupToken, network)` from `src/utils/simplefin.ts:89`; `SyncHealth` (Task 1).
- Produces:
  - `src/utils/connect.ts`:
    - `interface ClaimedToken { token: string; accessUrl: string }`;
    - `claimAccessUrl(pasted: string, network: NetworkAPI, previous: ClaimedToken | null): Promise<ClaimedToken>`. It trims `pasted`, returns `previous` unchanged when `previous?.token` equals the trimmed token, and otherwise claims;
    - `credentialsB64(accessUrl: string): string`, the exact computation now at SetupPage.tsx:61-67.
  - `src/utils/secrets.ts`:
    - `export const NEXT_AUTH_B64_SECRET_KEY = 'simplefin_auth_b64_next'`;
    - `export const CONNECTION_REPLACED_AT_SECRET_KEY = 'simplefin_connection_replaced_at'`;
    - KEYS entries `nextAuthB64` and `connectionReplacedAt`;
    - on `SecretsStore`:
      - `getNextAuthB64Key(): Promise<string>`;
      - `setNextAuthB64(credentialsB64: string): Promise<void>`;
      - `clearNextAuthB64(): Promise<void>`;
      - `getConnectionReplacedAt(): Promise<string | null>`;
      - `setConnectionReplacedAt(iso: string): Promise<void>`;
      - `getSyncHealth(): Promise<SyncHealth | null>` (type widened, body unchanged).

- [ ] **Step 1: Write the failing tests**

In `src/utils/connect.test.ts` (a `makeNetwork` like `src/utils/simplefin.test.ts:10`):

```ts
const CLAIM_URL = 'https://beta-bridge.simplefin.org/simplefin/claim/NEW';
const NEW_URL = 'https://new:secret2@beta-bridge.simplefin.org/simplefin';

describe('claimAccessUrl', () => {
  it('reuses the access URL a token already gave in this visit', async () => {
    const network = makeNetwork(async () => ({ status: 200, headers: {}, body: NEW_URL }));
    const first = await claimAccessUrl(`  ${btoa(CLAIM_URL)}\n`, network, null);
    expect(first).toEqual({ token: btoa(CLAIM_URL), accessUrl: NEW_URL });
    expect(await claimAccessUrl(btoa(CLAIM_URL), network, first)).toBe(first);
    expect(network.request).toHaveBeenCalledTimes(1);
  });
  it('claims a different token afresh', async () => {
    const network = makeNetwork(async () => ({ status: 200, headers: {}, body: NEW_URL }));
    await claimAccessUrl(btoa('https://bridge.simplefin.org/claim/OTHER'), network, { token: btoa(CLAIM_URL), accessUrl: NEW_URL });
    expect(network.request).toHaveBeenCalledWith({ url: 'https://bridge.simplefin.org/claim/OTHER', method: 'POST' });
  });
});

describe('credentialsB64', () => {
  it("is base64 of the URL's user:pass, as Setup always computed it", () => {
    expect(credentialsB64('https://user:pass@bridge.simplefin.org/simplefin')).toBe(btoa('user:pass'));
    // Percent-encoded as the URL holds it, not decoded: unchanged behaviour.
    expect(credentialsB64('https://u:p%2Bq@bridge.simplefin.org/simplefin')).toBe(btoa('u:p%2Bq'));
  });
});
```

In `src/utils/secrets.test.ts`, inside `describe('SecretsStore')`:

```ts
it("keeps a new token's test credentials apart from the working ones", async () => {
  const { ctx, data } = makeCtxWithData();
  const s = new SecretsStore(ctx);
  await s.setAuthB64('old');
  await s.setNextAuthB64('new');
  expect(await s.getNextAuthB64Key()).toBe('simplefin_auth_b64_next');
  expect(data.simplefin_auth_b64).toBe('old');
  expect(data.simplefin_auth_b64_next).toBe('new');
  await s.clearNextAuthB64();
  expect(data.simplefin_auth_b64_next).toBeUndefined();
  expect(data.simplefin_auth_b64).toBe('old');
});

it('clearAll deletes the test credentials and the replaced-at time', async () => {
  const { ctx, data } = makeCtxWithData();
  const s = new SecretsStore(ctx);
  await s.setNextAuthB64('new');
  await s.setConnectionReplacedAt('2026-11-26T15:00:00.000Z');
  expect(await s.getConnectionReplacedAt()).toBe('2026-11-26T15:00:00.000Z');
  await s.clearAll();
  expect(data.simplefin_auth_b64_next).toBeUndefined();
  expect(await s.getConnectionReplacedAt()).toBeNull();
});

it("reads the companion's lastFailedAt with the rest of sync_health", async () => {
  const { ctx, data } = makeCtxWithData();
  data.sync_health = JSON.stringify({ lastSuccessAt: null, firstFailedAt: '2026-11-20T10:00:00.000Z', lastFailedAt: '2026-11-25T10:00:00.000Z', lastError: 'SimpleFin /accounts failed: 403', alerted: true });
  expect(await new SecretsStore(ctx).getSyncHealth()).toMatchObject({ lastFailedAt: '2026-11-25T10:00:00.000Z', lastError: 'SimpleFin /accounts failed: 403' });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `nice npx vitest run --maxWorkers=2 src/utils/connect.test.ts src/utils/secrets.test.ts`
Expected: FAIL, `./connect` cannot be resolved and `setNextAuthB64` is not a function.

- [ ] **Step 3: Implement the helper and the store methods, then move Setup onto the helper**

In `handleConnect`, lines 51-55 become `const claim = await claimAccessUrl(token, ctx.api.network, claimed.current); claimed.current = claim;`, using `claim.accessUrl` below. Lines 61-67 become `const b64 = credentialsB64(claim.accessUrl);`. Keep Setup's order (setAccessUrl, setAuthB64, then fetch) and everything after line 68 as it is. The import on line 5 keeps `fetchAccounts` only.

- [ ] **Step 4: Run them to see them pass, Setup's included**

Run: `nice npx vitest run --maxWorkers=2 src/utils/connect.test.ts src/utils/secrets.test.ts src/pages/SetupPage.test.tsx`
Expected: PASS. SetupPage.test's `retries a failed first download with the access URL it claimed…` still counts `claimToken` once: its mock of `../utils/simplefin` reaches `connect.ts` too.

- [ ] **Step 5: Run the gates once**

Run: `nice npx vitest run --maxWorkers=2` and `nice npm run type-check`.
Expected: PASS / succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/utils/connect.ts src/utils/connect.test.ts src/pages/SetupPage.tsx src/utils/secrets.ts src/utils/secrets.test.ts
git commit -m "Setup claims through one shared helper; store keys for a replacement token" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Test the new token, then swap (`replaceConnection`) and its change-log kind

**Files:**
- Modify: `src/utils/connect.ts` (add the replace flow)
- Modify: `src/utils/connect.test.ts`
- Modify: `shared/change-entries.ts:35-56` (kind), after `accountCreatedChange` at `:779-790` (builder)
- Modify: `shared/change-view.ts:28-52` (`GROUP_OF`)
- Test: `shared/change-entries.test.ts:38` (count 21 → 22), the `cases` table near `:149`

**Interfaces:**
- Consumes:
  - Task 1: `providerName`, `mappedAccountIds`, `missingMappedAccounts`;
  - Task 2: `claimAccessUrl`, `credentialsB64`, the five store methods;
  - existing: `fetchAccounts` (`src/utils/simplefin.ts:135`), `directCallLine(store, 'setup')` (`shared/simplefin-budget.ts:228`), `beginWrite()` / `writeRefusal('remove')` (`src/utils/write-lock.ts`), `isSimplefinNotice` (`shared/simplefin-payload.ts:159`), `store.recordChange?.(draft)`.
- Produces:
  - `shared/change-entries.ts`:
    - kind `'connection-replaced'` in `ChangeKind` and `CHANGE_KINDS`;
    - `interface ConnectionReplacedFacts { fromProvider: string | null; toProvider: string }`;
    - `connectionReplacedChange(f: ConnectionReplacedFacts): ChangeDraft`, giving `{ actor: 'you', kind: 'connection-replaced', subject: {}, summary: 'Replaced the SimpleFIN connection', before: { provider: f.fromProvider }, after: { provider: f.toProvider }, undoable: false }`.
  - `shared/change-view.ts`: `'connection-replaced': 'rules'`.
  - `src/utils/connect.ts`:

```ts
export type ReplaceStore = Pick<SecretsStore,
  'getAccessUrl' | 'setAccessUrl' | 'setAuthB64' | 'getNextAuthB64Key' | 'setNextAuthB64' | 'clearNextAuthB64'
  | 'setConnectionReplacedAt' | 'getAccountNames' | 'setAccountNames' | 'getAccountMapping'>
  & Partial<Pick<SecretsStore, 'getLoanLinks' | 'recordChange' | 'getSimplefinRequests' | 'setSimplefinRequests'>>;

export interface ReplacedConnection {
  kind: 'replaced';
  provider: string;            // providerName(new access URL)
  message: string;             // replacedMessage(...)
  accounts: SimplefinAccount[];
  feedErrors: string[];        // set.errors, shown, never blocking
  hadErrors: boolean;          // set.errors.some((e) => !isSimplefinNotice(e)), as loadAccounts computes it
  missing: string[];           // SimpleFin ids, missingMappedAccounts order
}
export type ReplaceOutcome = ReplacedConnection | { kind: 'failed'; message: string };

export function notListedMessage(reason: string): string;
export function replacedMessage(provider: string, mappedCount: number, missingNames: string[]): string;
export function replaceConnection(
  pasted: string,
  claimed: { current: ClaimedToken | null },   // a React ref; kept across failed tests
  deps: { store: ReplaceStore; network: NetworkAPI },
): Promise<ReplaceOutcome>;
```

**The flow, in order.** The order is the anti-goal's guard, so the code must follow it exactly.

1. `const release = beginWrite()`. If it is null, return `failed(writeRefusal('remove'))`. Everything below runs in `try { … } finally { release() }`.
2. `directCallLine(store, 'setup')`. If it refuses, return `failed(line)`. No claim is made.
3. `claimAccessUrl(pasted, network, claimed.current)`. If it throws, return `failed(e.message)`, the claim's own text. On success, set `claimed.current` to the result.
4. Write `setNextAuthB64(credentialsB64(url))`, then call `fetchAccounts(url, new Date(Date.now() - 86_400_000), network, await store.getNextAuthB64Key())`.
5. If the fetch throws, or lists zero accounts: `clearNextAuthB64().catch(() => {})`, then return `failed(notListedMessage(reason))`. The reason is the error's message; for zero accounts it is `set.errors.join('; ')`, or `the account list was empty` when there are no errors. Nothing else is written.
6. Read the old provider, `getAccountNames`, `getAccountMapping` and `getLoanLinks?.()`, each failure-tolerant.
7. Write, in this order:
   1. `setAccessUrl(url)`;
   2. `setAuthB64(b64)`;
   3. `clearNextAuthB64()`, best-effort;
   4. `setConnectionReplacedAt(new Date().toISOString())`, best-effort;
   5. `setAccountNames({ ...existing, ...new names })`, best-effort, never a wholesale replace;
   6. `recordChange?.(connectionReplacedChange({ fromProvider, toProvider }))`.

   A throw from writes 1–2 is caught by the caller (Task 4) and shown.
8. Return `replaced`. The missing names are the stored names, falling back to the id.

**Copy** (`replacedMessage`; `p` = provider, `N` = count):

| case | text |
|---|---|
| none missing, 0 mapped | `✓ Connected through ${p}. The next sync uses it.` |
| none missing, 1 mapped | `✓ Connected through ${p}. Your mapped account is in this connection. The next sync uses it.` |
| none missing, N ≥ 2 | `✓ Connected through ${p}. All ${N} mapped accounts are in this connection. The next sync uses it.` |
| 1 missing | `✓ Connected through ${p}. 1 mapped account isn't in this connection: ${name}. If your bank lists it under a new name, map it in the Accounts card above.` |
| N ≥ 2 missing | `✓ Connected through ${p}. ${N} mapped accounts aren't in this connection: ${names.join(', ')}. If your bank lists them under new names, map them in the Accounts card above.` |

`notListedMessage(reason)`: `The token was accepted, but SimpleFIN didn't list any accounts: ${reason without one trailing period}. Your current connection is unchanged. Press Connect to try again: the same token works while this page stays open.`

- [ ] **Step 1: Write the failing change-entries tests**

In `shared/change-entries.test.ts`: change `toBe(21)` to `toBe(22)`, and add to `cases`:

```ts
['connection-replaced', connectionReplacedChange({ fromProvider: 'SimpleFIN Bridge', toProvider: 'Lunch Flow' }),
  'Replaced the SimpleFIN connection'],
```

- [ ] **Step 2: Write the failing `replaceConnection` tests** in `src/utils/connect.test.ts`

The harness is a real `SecretsStore` over a fake secrets map (copy `makeCtxWithData` from `src/utils/secrets.test.ts:14-27`, `requireWealthfolioSecretKey` included). Its network routes `POST` to the claim and `GET` to `/accounts`. `beforeEach`: `vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW)`; `afterEach`: `vi.useRealTimers()`.

```ts
const NOW = new Date('2026-11-26T15:00:00.000Z');
const OLD_URL = 'https://old:secret1@bridge.simplefin.org/simplefin';
const seed = () => ({
  simplefin_access_url: OLD_URL,
  simplefin_auth_b64: btoa('old:secret1'),
  account_mapping: JSON.stringify({ 'ACT-1': 'wf-check', 'ACT-2': 'wf-card' }),
  account_names: JSON.stringify({ 'ACT-1': 'Checking', 'ACT-2': 'Citi Card', 'ACT-9': 'Car Loan' }),
  loan_links: JSON.stringify({ 'ACT-9': 'loan-1' }),
});
const acct = (id: string, name: string) => ({ id, name, currency: 'USD', balance: '1.00', 'balance-date': 1764000000 });
// accounts(...) → a GET reply of { errors, accounts }; harness(seed, getReply, postReply?) → { store, data, network, claimed }
```

Tests and their assertions:

- `tests the new token under the temporary key, then swaps the connection and keeps everything else`
  - The GET request had `auth.secretKey === 'simplefin_auth_b64_next'`, and its URL host is `beta-bridge.simplefin.org`.
  - After it:
    - `data.simplefin_access_url === NEW_URL`;
    - `data.simplefin_auth_b64 === btoa('new:secret2')`;
    - `data.simplefin_auth_b64_next` is undefined;
    - `data.simplefin_connection_replaced_at === NOW.toISOString()`;
    - `data.account_mapping` and `data.loan_links` are byte-identical to the seed;
    - the names are `{ 'ACT-1': 'Checking', 'ACT-2': 'Citi Card', 'ACT-9': 'Car Loan', 'NEW-1': 'Checking 1234' }`.
- `says every mapped account is there when the new list has them all`
  - GET lists ACT-1, ACT-2, ACT-9.
  - `message === '✓ Connected through SimpleFIN Bridge. All 3 mapped accounts are in this connection. The next sync uses it.'`, and `missing` is `[]`.
- `names the mapped accounts the new connection lacks, loans included, by their stored names`
  - GET lists only `NEW-1`.
  - `missing` is `['ACT-1', 'ACT-2', 'ACT-9']`.
  - `message === "✓ Connected through SimpleFIN Bridge. 3 mapped accounts aren't in this connection: Checking, Citi Card, Car Loan. If your bank lists them under new names, map them in the Accounts card above."`
- `words one mapped account and none` (calls `replacedMessage` directly)
  - `replacedMessage('Lunch Flow', 1, [])` and `replacedMessage('Lunch Flow', 0, [])` give the table rows.
  - `replacedMessage('Lunch Flow', 2, ['Checking'])` gives the single-missing row.
- `leaves the working connection untouched when the new token lists no accounts`
  - GET returns `{ errors: [], accounts: [] }`.
  - Result: `{ kind: 'failed', message: "The token was accepted, but SimpleFIN didn't list any accounts: the account list was empty. Your current connection is unchanged. Press Connect to try again: the same token works while this page stays open." }`.
  - Afterwards the data equals `seed()` plus the `simplefin_requests` record and nothing else: no `_next`, no replaced-at, no change-log key.
- `leaves it untouched when the test download fails, and says why`
  - GET returns status 403 with body `Forbidden`.
  - The message contains `didn't list any accounts: SimpleFin /accounts failed: 403 — Forbidden. Your current connection is unchanged.`
  - The access URL and auth are the seed's.
- `quotes SimpleFIN's errors as the reason when they come with no accounts`
  - GET returns `{ errors: ['Chase: sign in again'], accounts: [] }`.
  - The message contains `didn't list any accounts: Chase: sign in again. Your current`.
- `retries with the access URL it already claimed while the page stays open`
  - The first GET fails and the second lists `NEW-1`, both with the same token and the same `claimed` ref.
  - POST was called once, and the second outcome is `replaced`.
- `shows SimpleFIN's errors beside a list that has accounts, without blocking`
  - GET returns `{ errors: ['Chase: sign in again'], accounts: [acct('NEW-1', 'Checking 1234')] }`.
  - The outcome is `replaced`, with `feedErrors: ['Chase: sign in again']` and `hadErrors: true`.
- `asks the budget first: refused at the Setup ceiling, no token claimed`
  - The seed's `simplefin_requests` holds 24 times, each `NOW - (60 + i) min`.
  - The message matches `/SimpleFin's daily limit is used up/`, `network.request` was never called, and the access URL is the seed's.
- `refuses while a sync holds the add-on write lock, claiming and counting nothing`
  - `const end = await beginSync()`, then replace, then `end()` in `finally`.
  - The message is `'A sync is running — try again when it finishes.'`, `network.request` was never called, and `data.simplefin_requests` is undefined.
- `records one change-log entry naming the providers, never the URL`
  - The claim returns `https://new:secret2@www.lunchflow.app/simplefin`, from claim URL `https://www.lunchflow.app/simplefin/claim/X`.
  - `(await store.getChangeLog())!.entries` has exactly one entry, matching `{ kind: 'connection-replaced', actor: 'you', undoable: false, summary: 'Replaced the SimpleFIN connection', before: { provider: 'SimpleFIN Bridge' }, after: { provider: 'Lunch Flow' } }`.
  - `JSON.stringify(entries)` contains none of `secret1`, `secret2`, `simplefin.org/simplefin`.
- `reports a spent token as the claim says, storing nothing`
  - POST returns 403.
  - The message matches `/already used/`, `claimed.current` is null, and the access URL and auth are the seed's.
- `refuses an access URL pasted as a token, storing nothing and echoing nothing` (Review Focus 1)
  - `pasted = OLD_URL`.
  - The message matches `/does not look like a SimpleFin setup token/` and does not contain `secret1`.
  - `network.request` was never called.
- `passes on Wealthfolio's host-approval message and claims again on retry` (Review Focus 2)
  - The first POST rejects with `new Error("host 'www.lunchflow.app' is not approved")`.
  - The message matches `/hasn't approved this add-on to connect to www.lunchflow.app/` and `/paste the same token again/`, and `claimed.current` is null.
  - The second call, which succeeds, POSTs once more and is `replaced`.

- [ ] **Step 3: Run them to see them fail**

Run: `nice npx vitest run --maxWorkers=2 src/utils/connect.test.ts shared/change-entries.test.ts shared/change-view.test.ts`
Expected: FAIL, `replaceConnection` and `connectionReplacedChange` are not exported, and the count is 21.

- [ ] **Step 4: Implement the kind, its group, the builder and `replaceConnection`** in the files listed above.

- [ ] **Step 5: Run them to see them pass**

Run: `nice npx vitest run --maxWorkers=2 src/utils/connect.test.ts shared/change-entries.test.ts shared/change-view.test.ts src/components/ChangeLogCard.test.tsx`
Expected: PASS. `change-view.test`'s `puts every kind in one of the six groups` covers the new kind.

- [ ] **Step 6: Run the gates once**

Run: `nice npx vitest run --maxWorkers=2`, `nice npm run type-check`, `(cd companion && nice npx vitest run --maxWorkers=2)` and `nice npm --prefix companion run build`. `/changes` renders the same kinds.
Expected: all PASS / succeed.

- [ ] **Step 7: Commit**

```bash
git add src/utils/connect.ts src/utils/connect.test.ts shared/change-entries.ts shared/change-entries.test.ts shared/change-view.ts
git commit -m "Replace the SimpleFIN connection: test the new token first, then swap" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The SimpleFIN connection card in Settings

**Files:**
- Create: `src/components/ConnectionCard.tsx`
- Modify: `src/tabs/SettingsTab.tsx`:
  - imports `:1-38`;
  - `CARD` `:51-62`, adding `connection: 'connection'`;
  - `Props` `:64-100` and the signature `:115-118`;
  - the Accounts state `:155-192`;
  - the new card goes between the Accounts card's `</CollapsibleCard>` (`:578`) and the Checks card (`:580`).
- Modify: `src/pages/SyncPage.tsx:819-837` (pass `syncing={syncing || healing}`)
- Test: `src/tabs/SettingsTab.test.tsx`. Its `vi.mock('../utils/simplefin', …)` factory at `:37-47` gains `claimToken: vi.fn(async () => NEW_URL)`, with `const NEW_URL = 'https://new:secret2@beta-bridge.simplefin.org/simplefin'` defined inside the factory (hoisting) and again at file scope.

**Interfaces:**
- Consumes: `replaceConnection`, `ReplacedConnection`, `ClaimedToken`, `ReplaceStore` (Tasks 2–3); `providerName` (Task 1); `CollapsibleCard`, `Button`, `Input`, `ErrorBox` (`src/components/ui.tsx`).
- Produces:
  - `src/components/ConnectionCard.tsx`: `ConnectionCard(props: { ctx: AddonContext; store: ReplaceStore; syncing: boolean; onReplaced: (r: ReplacedConnection) => void })`, the card's body.
    - Intro copy, verbatim: `Replace the token if SimpleFIN stopped accepting this connection, or you made a new token in SimpleFIN Bridge or Lunch Flow. Your mapping, rules and history stay.`
    - An `Input` with `aria-label="New setup token"` and `placeholder="Paste new setup token"`.
    - A `Button` labelled `Connect`, or `Connecting…` while running, disabled when `!token.trim() || connecting || syncing`.
    - A failure shows `<ErrorBox>{message}</ErrorBox>` and keeps the token. A thrown error is shown the same way.
    - A success shows `<div className="sfin-callout" role="status">{message}</div>`, plus `<ErrorBox>SimpleFin: {feedErrors.join('; ')}</ErrorBox>` when there are feed errors, clears the box, and calls `onReplaced`.
    - `claimed` is a `useRef<ClaimedToken | null>(null)`.
    - `onReplaced` is read through a ref updated every render, because Connect can take seconds and the page's `toggleCard` closes over its render's open-card map.
  - `SettingsTab` `CARD.connection = 'connection'`, and new optional props:
    - `syncing?: boolean`;
    - `connectionRefused?: boolean` (set in Task 5);
    - `onConnectionReplaced?: () => void` (set in Task 5);
    - `onNavigate?: (tab: TabId, openCardId?: string) => void` (set in Task 5).
  - SettingsTab state:
    - `provider: string | null | undefined`, where `undefined` means not read yet;
    - `accountsErrorRefused: boolean`, declared here (always false until Task 5 sets it).
  - The card's summary: `connectionRefused || accountsErrorRefused` → `Stopped accepting this connection`; `provider === undefined` → no summary; otherwise `provider ?? 'Not connected'`.

**On success, SettingsTab runs the card's `onReplaced` handler**, in this order:

1. `setProvider(r.provider)`;
2. `setAccountsError('')` and `setAccountsErrorRefused(false)`;
3. `setSfAccounts(r.accounts)`, `setSfAccountsHadErrors(r.hadErrors)` and `setMappingSaved(false)`;
4. only when `r.missing.length > 0` and the Accounts card is not open, `toggleCard(CARD.accounts)`;
5. `onAccountsChanged?.()`, then `onConnectionReplaced?.()`.

- [ ] **Step 1: Write the failing tests** in `src/tabs/SettingsTab.test.tsx`, a new `describe('SimpleFIN connection card')`

The `connectable(props)` helper adds these to `props.store`, all `vi.fn`:

- `setAccessUrl`, `setAuthB64`;
- `getNextAuthB64Key` (resolves `'simplefin_auth_b64_next'`), `setNextAuthB64`, `clearNextAuthB64`;
- `setConnectionReplacedAt`;
- `recordChange`.

`openConnection = () => openSection(/^SimpleFIN connection/)`.

Tests and their assertions:

- `sits after Accounts, collapsed, and names the provider, never the URL`
  - The header matching `/^SimpleFIN connection/` has `aria-expanded="false"`.
  - It shows the text `SimpleFIN Bridge` once loaded (`await waitFor`), and does not contain `u:p`.
  - The first two `[data-card-id]` ids are `['accounts', 'connection']`.
- `says Not connected when there is no connection`
  - With `getAccessUrl` resolving null, the header shows `Not connected`.
- `keeps Connect off until a token is pasted`
  - After `openConnection()`, `Connect` is disabled.
  - Typing into `getByLabelText('New setup token')` enables it.
- `swaps the connection and opens the mapper on the new list when mapped accounts are missing`
  - `fetchAccounts.mockClear()`, then `mockResolvedValueOnce({ errors: [], accounts: [NEW-1 'Growth', NEW-2 'Spend'] })`.
  - Paste and Connect. The status reads `✓ Connected through SimpleFIN Bridge. 2 mapped accounts aren't in this connection: Growth, Spend. If your bank lists them under new names, map them in the Accounts card above.`
  - `setAccessUrl` was called with `NEW_URL`, and `fetchAccounts.mock.calls[0]` has `[0] === NEW_URL` and `[3] === 'simplefin_auth_b64_next'`.
  - The `/^Accounts/` header is expanded, `Save mapping` is present, and `fetchAccounts` was called exactly once (no second download).
  - The token box is empty.
- `says every mapped account is there, and leaves Accounts closed`
  - The default mock lists sfin-1, sfin-2 and sfin-new.
  - The status reads `✓ Connected through SimpleFIN Bridge. All 2 mapped accounts are in this connection. The next sync uses it.`, and the `/^Accounts/` header stays `aria-expanded="false"`.
- `keeps the token and the working connection when the new one lists nothing`
  - The fetch returns `{ errors: [], accounts: [] }`.
  - The page shows the `notListedMessage` text for `the account list was empty`, `setAccessUrl` was never called, and the box still holds the token.
- `turns Connect off while a sync runs`
  - `runSync.mockImplementationOnce(() => new Promise(…))`, click `Sync now`, then open the card and paste.
  - `Connect` is disabled.

- [ ] **Step 2: Run them to see them fail**

Run: `nice npx vitest run --maxWorkers=2 src/tabs/SettingsTab.test.tsx -t "SimpleFIN connection card"`
Expected: FAIL, no `/^SimpleFIN connection/` header.

- [ ] **Step 3: Implement `ConnectionCard`, wire it into SettingsTab, and pass `syncing` from SyncPage**

The card is a `CollapsibleCard` with `id={CARD.connection}`, `title="SimpleFIN connection"`, `summary={connectionSummary}`, `open={isOpen(CARD.connection)}` and `onToggle={() => toggleCard(CARD.connection)}`. Read the provider on mount: `store.getAccessUrl().then((u) => setProvider(providerName(u))).catch(() => {})`.

- [ ] **Step 4: Run them to see them pass**

Run: `nice npx vitest run --maxWorkers=2 src/tabs/SettingsTab.test.tsx src/pages/copy-policy.test.tsx`
Expected: PASS, the existing SettingsTab tests and the copy policy included. The copy policy opens every card, this one too.

- [ ] **Step 5: Run the gates once**

Run: `nice npx vitest run --maxWorkers=2` and `nice npm run type-check`.
Expected: PASS / succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/components/ConnectionCard.tsx src/tabs/SettingsTab.tsx src/tabs/SettingsTab.test.tsx src/pages/SyncPage.tsx
git commit -m "Settings: a SimpleFIN connection card to paste a new token" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: "Replace token" where a refused connection is reported, and the docs

**Files:**
- Modify: `src/components/ui.tsx:1145-1157` (`ErrorBox` gains `action?: React.ReactNode`, rendered after `children`, before `details`, in `<div style={{ marginTop: 8 }}>`)
- Modify: `src/components/ConnectionCard.tsx` (add `RefusedConnectionNote`)
- Modify: `src/pages/SyncPage.tsx`:
  - state near `:99-102`;
  - `clearError` `:433-436`;
  - `showThrownError` `:497-503`;
  - `refreshLiveState` `:390-…`;
  - the ErrorBox `:733`;
  - `<HomeTab` `:753-793`;
  - `<SettingsTab` `:819-837`.
- Modify: `src/tabs/SettingsTab.tsx`:
  - `loadAccounts` `:246-285` (set `accountsErrorRefused`);
  - the ErrorBox `:525`.
- Modify: `src/tabs/HomeTab.tsx`:
  - `Props` `:43-120`;
  - the signature `:134-140`;
  - a banner right after `<ConnectionProblemBanners …/>` (`:224`).
- Modify: `README.md`, `CHANGELOG.md`
- Test: `src/pages/SyncPage.test.tsx`, `src/tabs/HomeTab.test.tsx`, `src/tabs/SettingsTab.test.tsx`

**Interfaces:**
- Consumes:
  - Task 1: `isRefusedConnection`, `companionConnectionRefused`, `REFUSED_CONNECTION_SHORT`;
  - Task 2: `store.getSyncHealth`, `store.getConnectionReplacedAt`;
  - Task 4: SettingsTab's `connectionRefused`, `onConnectionReplaced`, `onNavigate`, `accountsErrorRefused`, `CARD.connection`;
  - SyncPage's `navigate(tab, openCardId)` (`:458`).
- Produces:
  - `ErrorBox({ children, detail, action }: { children: React.ReactNode; detail?: string; action?: React.ReactNode })`.
  - `RefusedConnectionNote({ onReplace }: { onReplace: () => void })`: `<div>{REFUSED_CONNECTION_SHORT}</div>` and `<Button variant="outline" onClick={onReplace}>Replace token</Button>`.
  - HomeTab prop `companionConnectionRefused?: boolean`.
  - SyncPage state:
    - `errorRefused: boolean`: `showThrownError` sets `isRefusedConnection(e)`, and `clearError` sets false;
    - `companionRefused: boolean`, read in `refreshLiveState` via `Promise.all([store.getSyncHealth?.() ?? null, store.getConnectionReplacedAt?.() ?? null])` and the `mounted` guard.
  - SyncPage `onConnectionReplaced`: when `errorRefused`, call `clearError()`. Always `setCompanionRefused(false)`.

**Wiring:**
- SyncPage's ErrorBox gets `action={errorRefused ? <RefusedConnectionNote onReplace={() => navigate('settings', SETTINGS_CARD.connection)} /> : undefined}`.
- `<SettingsTab connectionRefused={errorRefused || companionRefused} onConnectionReplaced={onConnectionReplaced} onNavigate={navigate} …/>`.
- `<HomeTab companionConnectionRefused={companionRefused} …/>`.
- In SettingsTab, `loadAccounts` sets `setAccountsErrorRefused(false)` at its start and `setAccountsErrorRefused(isRefusedConnection(e))` in its `catch`. Line 525 becomes `<ErrorBox action={accountsErrorRefused && onNavigate ? <RefusedConnectionNote onReplace={() => onNavigate('settings', CARD.connection)} /> : undefined}>`.
- The Home banner is a `sfin-banner-warn` with a `sfin-banner-body`:
  - the line `Background sync stopped: SimpleFIN no longer accepts this connection.`;
  - a `sfin-banner-actions` holding `<Button variant="outline" onClick={() => onNavigate('settings', SETTINGS_CARD.connection)}>Replace token</Button>`.

- [ ] **Step 1: Write the failing tests**

In `src/pages/SyncPage.test.tsx`, after the existing sync-error tests:

```ts
const refused = () => Object.assign(new Error('SimpleFin /accounts failed: 403 — Forbidden'), { status: 403, detail: 'Forbidden' });

it('offers Replace token under a sync error SimpleFIN refused, and it opens Settings → SimpleFIN connection', async () => {
  vi.mocked(runSync).mockRejectedValueOnce(refused());
  render(<SyncPage {...makeProps()} />);
  fireEvent.click(await screen.findByRole('button', { name: /sync now/i }));
  const box = (await screen.findByText(/accounts failed: 403/)).closest('.sfin-error')!;
  expect(box).toHaveTextContent('SimpleFIN no longer accepts this connection. Replace the token to carry on; your mapping and rules stay.');
  fireEvent.click(within(box as HTMLElement).getByRole('button', { name: 'Replace token' }));
  expect(await screen.findByRole('tab', { name: 'Settings', selected: true })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^SimpleFIN connection/, expanded: true })).toBeInTheDocument();
});

it('offers nothing extra for a 402 or any other failure', async () => {
  vi.mocked(runSync).mockRejectedValueOnce(Object.assign(new Error('SimpleFin /accounts failed: 402 — Payment required'), { status: 402 }));
  render(<SyncPage {...makeProps()} />);
  fireEvent.click(await screen.findByRole('button', { name: /sync now/i }));
  await screen.findByText(/accounts failed: 402/);
  expect(screen.queryByRole('button', { name: 'Replace token' })).toBeNull();
});
```

In `src/tabs/HomeTab.test.tsx`, a new `describe('when the companion was refused')`. Its `health` helper sets `props.store.getSyncHealth` and `props.store.getConnectionReplacedAt` to the given values, as `vi.fn(async () => …)`.

```ts
const REFUSED = { lastSuccessAt: null, firstFailedAt: '2026-11-24T10:00:00.000Z', lastFailedAt: '2026-11-26T10:00:00.000Z', lastError: 'SimpleFin /accounts failed: 403', alerted: true };
const LINE = 'Background sync stopped: SimpleFIN no longer accepts this connection.';
```

Tests and their assertions:

- `shows a banner and opens the connection card from it`
  - With `REFUSED` and a replace time of null, `findByText(LINE)` finds the banner.
  - Clicking `Replace token` selects the `Settings` tab and expands the `/^SimpleFIN connection/` header.
- `hides once the connection was replaced after the last failure`
  - The replace time is `'2026-11-26T11:00:00.000Z'`.
  - After `waitFor(() => expect(store.getConnectionReplacedAt).toHaveBeenCalled())` and `await screen.findByText(/Last synced/)`, `queryByText(LINE)` is null.
- `stays away for another failure, and after a success`
  - `{ ...REFUSED, lastError: 'SimpleFin /accounts failed: 524' }` shows no banner.
  - `{ lastSuccessAt: '2026-11-26T10:00:00.000Z' }` shows no banner either. Use two renders with an `unmount` between them.

In `src/tabs/SettingsTab.test.tsx`, in `describe('SimpleFIN connection card')`:

- `a refused refresh offers Replace token beside the error, and says so in the card's summary`
  - `fetchAccounts.mockRejectedValueOnce(Object.assign(new Error('SimpleFin /accounts failed: 403 — Forbidden'), { status: 403 }))`, then `openMapper()`.
  - A `Replace token` button sits inside the `.sfin-error` holding `/accounts failed: 403/`.
  - The `/^SimpleFIN connection/` header shows `Stopped accepting this connection`.
  - Clicking the button expands that header.
- `clears the page's refused sync error once the token is replaced`
  - `runSync.mockRejectedValueOnce(<the 403 error>)`, `Sync now`, `Replace token`, paste and `Connect` (with `connectable`).
  - After `findByRole('status')` shows `✓ Connected through`, `queryByText(/accounts failed: 403/)` is null.

- [ ] **Step 2: Run them to see them fail**

Run: `nice npx vitest run --maxWorkers=2 src/pages/SyncPage.test.tsx src/tabs/HomeTab.test.tsx src/tabs/SettingsTab.test.tsx`
Expected: FAIL, there is no `Replace token` button and no banner.

- [ ] **Step 3: Implement the action slot, the note, the SyncPage state and wiring, the Accounts-error button and the Home banner**, as the Interfaces block says.

- [ ] **Step 4: Run them to see them pass**

Run: `nice npx vitest run --maxWorkers=2 src/pages/SyncPage.test.tsx src/tabs/HomeTab.test.tsx src/tabs/SettingsTab.test.tsx src/pages/copy-policy.test.tsx`
Expected: PASS. The existing error-box tests are unchanged: `renders an error with no underlying detail exactly as before` still finds no `details` and no `title`.

- [ ] **Step 5: Write the docs**

`CHANGELOG.md`: add `### Added` directly under `## [Unreleased]`, above `### Fixed`, wrapped at the file's width:

```markdown
### Added
- **Replace the SimpleFIN token without Reset.** Settings → SimpleFIN
  connection takes a new setup token (from SimpleFIN Bridge or Lunch Flow, or
  to move between them) and keeps the mapping, rules, change log and
  notifications. The new token is tested first: if it lists no accounts, the
  current connection stays as it was. Mapped accounts the new connection
  doesn't list are named, and the mapper opens on the new list, where the
  reconnection questions match them. When SimpleFIN refuses the connection
  (401 or 403), the sync error, the Accounts refresh error and a Home banner
  for the companion's failing sync each offer **Replace token**.
```

`README.md`:

1. Under "Set up in three steps", after the paragraph ending `the token itself is not kept.`, add one sentence: `A new token later (SimpleFIN stopped accepting the connection, or you moved to Lunch Flow) goes in **Settings → SimpleFIN connection**, with no Reset: see [Replacing the SimpleFIN token](#replacing-the-simplefin-token).`
2. A new `### Replacing the SimpleFIN token` right after `### Adding or removing accounts later`, saying:
   - when a new token is needed: Bridge disabled the token for over-use, the app was disconnected in Bridge or Lunch Flow, a new token cut the old one off, or the move between the two;
   - the steps: open the card, paste, press **Connect**; nothing else is reset;
   - the token is tested first: an empty list changes nothing, and the same token works again while the page stays open;
   - missing mapped accounts are named, and the Accounts card opens on the new list with its reconnection questions;
   - where **Replace token** appears.
3. In the **Change log** bullet, change `background bookkeeping and accounts created offer nothing` to `background bookkeeping, accounts created and replaced connections offer nothing`.

- [ ] **Step 6: Run the gates once**

Run: `nice npx vitest run --maxWorkers=2` and `nice npm run type-check`.
Expected: PASS / succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/components/ui.tsx src/components/ConnectionCard.tsx src/pages/SyncPage.tsx src/pages/SyncPage.test.tsx src/tabs/SettingsTab.tsx src/tabs/SettingsTab.test.tsx src/tabs/HomeTab.tsx src/tabs/HomeTab.test.tsx README.md CHANGELOG.md
git commit -m "Replace token where a refused connection is reported: the sync error, the Accounts refresh and a Home banner" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Companion: `lastFailedAt` and the Telegram hint, then the final gates

**Files:**
- Modify: `companion/src/index.ts:373-388` (`updateSyncHealth`), `:426-433` (`checkSyncHealthAlert`'s text), imports near `:175`
- Test: `companion/src/index.test.ts`, `describe('runCompanionSync sync health')` (`:606-850`), using its harness: `secrets` Map, the `WealthfolioClient` mock built with a `function`, `vi.mocked(runSyncCore).mockRejectedValueOnce`, and `vi.stubGlobal('fetch', …)`
- Modify: `CHANGELOG.md` (one sentence in Task 5's entry)

**Interfaces:**
- Consumes: `isRefusedConnection`, `REFUSED_CONNECTION_LINE` from `../../shared/simplefin-connection.js` (Task 1); `escapeMarkdown` (already imported, `:31`).
- Produces:
  - Failure records become `{ lastSuccessAt, firstFailedAt, lastFailedAt: now, lastError, alerted }`. Success stays `{ lastSuccessAt: now }`, with no `lastFailedAt`.
  - When `isRefusedConnection(health.lastError)`, the alert text is the existing text plus `\n${escapeMarkdown(REFUSED_CONNECTION_LINE)}`. Otherwise it is byte-identical to today's.
  - Home Assistant is untouched (planner's call 10).

- [ ] **Step 1: Write the failing tests**, inside `describe('runCompanionSync sync health')`

Each test pins the clock with `vi.useFakeTimers({ toFake: ['Date'] })` and restores it in `finally`, and builds the client as the neighbouring tests do.

```ts
it('stamps lastFailedAt on every failure, keeps firstFailedAt, and leaves it out on success', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date('2026-11-25T10:00:00.000Z'));
    vi.mocked(runSyncCore).mockRejectedValueOnce(new Error('SimpleFin /accounts failed: 403'));
    await expect(runCompanionSync()).rejects.toThrow('403');
    vi.setSystemTime(new Date('2026-11-25T16:00:00.000Z'));
    vi.mocked(runSyncCore).mockRejectedValueOnce(new Error('SimpleFin /accounts failed: 403'));
    await expect(runCompanionSync()).rejects.toThrow('403');
    expect(JSON.parse(secrets.get('sync_health')!)).toMatchObject({
      firstFailedAt: '2026-11-25T10:00:00.000Z', lastFailedAt: '2026-11-25T16:00:00.000Z', lastError: 'SimpleFin /accounts failed: 403',
    });
    vi.setSystemTime(new Date('2026-11-25T22:00:00.000Z'));
    await runCompanionSync();
    expect(JSON.parse(secrets.get('sync_health')!)).toEqual({ lastSuccessAt: '2026-11-25T22:00:00.000Z' });
  } finally { vi.useRealTimers(); }
});
```

- `adds the replace-token line to the 24h alert when SimpleFIN refused the connection`
  - Pin `2026-11-26T12:00:00.000Z`. Seed `telegram_config` as the neighbouring tests do, and `sync_health` with `{ lastSuccessAt: null, firstFailedAt: '2026-11-25T10:00:00.000Z', lastError: 'old error', alerted: false }`.
  - `runSyncCore` rejects with `SimpleFin /accounts failed: 403`.
  - The sent `text` contains `'Last error: SimpleFin /accounts failed: 403\nSimpleFIN no longer accepts this connection. Paste a new setup token in SimpleFin Sync → Settings → SimpleFIN connection; your mapping and rules stay.'`
- `leaves the 24h alert as it was for any other failure`
  - Same setup, but it rejects with `SimpleFin /accounts failed: 402`.
  - The text ends with `Last error: SimpleFin /accounts failed: 402`, and does not contain `no longer accepts`.

- [ ] **Step 2: Run them to see them fail**

Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/index.test.ts -t "sync health")`
Expected: FAIL, `lastFailedAt` is undefined and the line is missing.

- [ ] **Step 3: Implement** both changes in `companion/src/index.ts`, and update `updateSyncHealth`'s doc comment: `lastFailedAt` is what the add-on's Home banner compares against `simplefin_connection_replaced_at`.

- [ ] **Step 4: Run them to see them pass**

Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/index.test.ts -t "sync health")`
Expected: PASS, the existing sync-health tests included.

- [ ] **Step 5: Add to Task 5's CHANGELOG entry**, as its last sentence: `With this release's companion, its Telegram "failing since" alert says the same, and the Home banner stays away after a replace until the companion fails again.`

- [ ] **Step 6: Run every gate once**

Run: `nice npx vitest run --maxWorkers=2`, `(cd companion && nice npx vitest run --maxWorkers=2)`, `nice npm run type-check` and `nice npm --prefix companion run build`.
Expected: all PASS / succeed.

- [ ] **Step 7: Commit**

```bash
git add companion/src/index.ts companion/src/index.test.ts CHANGELOG.md
git commit -m "Companion: stamp each failure, and say how to fix a refused connection in the Telegram alert" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Run the changed test files with the clock forced to 2027** (the repo's throwaway recipe; nothing is committed)

```sh
cat > zz-2027.setup.ts <<'EOF2'
import { beforeEach, vi } from 'vitest';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-01-01T12:00:00Z')); });
EOF2
cp zz-2027.setup.ts companion/zz-2027.setup.ts
printf "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { environment: 'jsdom', globals: true, testTimeout: 15000, setupFiles: ['./src/test-setup.ts', './zz-2027.setup.ts'] } });\n" > zz-2027.config.mts
printf "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { globals: true, setupFiles: ['./zz-2027.setup.ts'] } });\n" > companion/zz-2027.config.mts
nice npx vitest run --maxWorkers=2 --config zz-2027.config.mts shared/simplefin-connection.test.ts src/utils/connect.test.ts src/utils/secrets.test.ts src/pages/SetupPage.test.tsx shared/change-entries.test.ts shared/change-view.test.ts src/tabs/SettingsTab.test.tsx src/pages/SyncPage.test.tsx src/tabs/HomeTab.test.tsx
(cd companion && nice npx vitest run --maxWorkers=2 --config zz-2027.config.mts src/index.test.ts -t "sync health")
rm zz-2027.setup.ts zz-2027.config.mts companion/zz-2027.setup.ts companion/zz-2027.config.mts
git status --short
```

Expected: PASS. A test that pins its own time overrides the 2027 one, as intended. `git status --short` shows nothing.

---

## Self-review

- **Spec coverage:**

  | Spec section | Where |
  |---|---|
  | Goals 1–2: card, test before swap | Tasks 3, 4 |
  | Goal 3: sync error | Task 5 |
  | Goal 3: Accounts refresh error | Task 5 |
  | Goal 3: Home banner, incl. `lastFailedAt` and `connection_replaced_at` | Tasks 1, 2, 5, 6 |
  | Goal 3: Telegram | Task 6 |
  | Goal 4: missing accounts named, mapper on the new list | Tasks 1, 3, 4 |
  | Shared module | Task 1 |
  | One claim helper, Setup unchanged | Task 2 |
  | Store keys in KEYS | Task 2 |
  | Replace-flow steps 1–6 | Task 3 |
  | Replace-flow step 7 | Task 5 |
  | Replace-flow step 8 | Tasks 4–5 |
  | Card placement, id, collapsed summary | Task 4 |
  | `hostNotApprovedMessage` through the helper | Task 3, Review Focus 2 |
  | Compatibility (no manifest change, additive `lastFailedAt`, `firstFailedAt` fallback) | Tasks 1, 6 |
  | Docs | Tasks 5, 6 |

  Non-goals are untouched: `shared/relink.ts`, `shared/simplefin-budget.ts` and the 24-hour delay do not change.

- **Step scan:** each test step gives names and the spec's exact copy. The code steps give signatures and the order that matters (the swap). Bodies are left out where a signature and its tests decide them.
- **Type consistency:** these names are used identically in every task:
  - `ClaimedToken`, `claimAccessUrl`, `credentialsB64`;
  - `ReplaceStore`, `ReplacedConnection`, `ReplaceOutcome`, `replaceConnection`, `replacedMessage`, `notListedMessage`;
  - `getNextAuthB64Key`, `setNextAuthB64`, `clearNextAuthB64`, `getConnectionReplacedAt`, `setConnectionReplacedAt`;
  - `CARD.connection`, `RefusedConnectionNote`, `companionConnectionRefused`, `connectionRefused`, `onConnectionReplaced`, `onNavigate`, `accountsErrorRefused`;
  - `'connection-replaced'`, `connectionReplacedChange`.
- **Review Focus:** each of the five lines has its test in the owning task (3, 3, 3, 1, and 1 with 5).
- **Proportion:** six tasks. The code blocks are tests and the one ordered flow.
