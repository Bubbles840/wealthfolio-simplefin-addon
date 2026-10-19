# In-transit rows always settle; generic transfer wording needs corroboration — Implementation Plan (1.65.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix issue #13 three ways: money out worded only with a generic transfer phrase is ordinary spending unless something corroborates it (B); every sync settles stored in-transit placeholders the download no longer carries, exactly as the in-feed expiry would (A); and the "still in transit" finding says why, shows daily, and offers "Not a transfer" in Telegram and in Settings → Checks (C).

**Architecture:** B: the mapper marks a TRANSFER_OUT typed only by one of the four generic phrases (`genericTransferWording`); the sync core demotes it to WITHDRAWAL before 1.63's bank-first step unless its text names another connected account, and 1.64's learned step may promote it back. A: a new exported pure planner in shared/sync-core.ts, `planStaleInTransit`, turns stored placeholders outside this run's download into `FeedTx` rows the account's `planReconciliation` call already handles, so the write, the change-log entry and the companion's later "Sync bookkeeping" unfiling are the in-feed expiry's own. C: the sync stores how far each feed has proven itself alive (`aliveThrough`); a new shared module, shared/held-transfers.ts, judges a held placeholder (which feed holds it, which bank transaction it is) through the sync's own `expiryHoldAccount`; the daily finding (`evaluateLedgerChecks`) and the app's Checks (through the audit snapshot's new `held` list) both use it, and "Not a transfer" writes the existing `notTransfer` override through `editSyncOverrides`.

**Tech Stack:** TypeScript; vitest (root project: jsdom, `src/` + `shared/`; companion project: node, `companion/src/`); the sync core's fake host (`shared/fake-host.ts`); `node:sqlite` in companion tests; React Testing Library for the app.

**Spec:** `docs/superpowers/specs/2026-10-19-in-transit-expiry-and-generic-wording-design.md` (approved by Nick 2026-10-19, committed at 8813a13). Sections A, B, C, the Rulings R1–R8 and the Tests section bind this plan; read all of them before starting a task.

**Target tree:** this repo, branch `feat/1.65` at 8813a13 (main 85cc91f = v1.64.1, plus the spec). Every block below was applied task by task to a scratch clone of that commit; every FAIL/PASS count was read off that replay (each task's new tests run against the previous task's tree, then against its own).

**Execution:** subagent-driven development — one implementer per task, one reviewer per task, tasks in order (each consumes the ones before).

## Deviations and readings (decided — do not "fix")

The spec leaves these open, or the code forces them; each is the closest faithful version.

1. **A `notTransfer` placeholder outside the download is settled, not left alone.** The spec says A never touches a `notTransfer` row, but C's acceptance test says "Not a transfer" makes the next sync expire the row — and C shows only rows held past 14 days, which the incremental window (last sync − 14 days) no longer carries, so only A can reach them. A therefore gives such a placeholder exactly the in-feed `notTransfer` result: ordinary money in or out at once, no hold, no Needs review, the change-log entry "Counted … — you said it isn't a transfer". "Never touched" holds for a `notTransfer` row that is already ordinary (it is no placeholder), and that is tested.
2. **"With Undo" — the expiry entry has none, in-feed or out.** The in-feed expiry logs `transferTypeChange({ held: false })`, which is `undoable: false` (shared/change-entries.ts: there is no "it is a transfer after all" override). A logs that identical entry. The entry written when the row was first held keeps its Undo (`notTransfer`).
3. **"External metadata undone" — the in-feed expiry leaves `flow.is_external: true`.** Its update omits `metadata` (toActivityCreate adds it only to in-transit transfer rows) and Wealthfolio keeps an omitted metadata as stored. A writes the identical update (pinned by "writes exactly what the in-feed expiry writes"). The flag is read only on transfer-typed rows (Health, `maybeLinkedTransfer`, `planExternalMarkerStamp`) and never by the spending classifier, so on the expired WITHDRAWAL/DEPOSIT it is inert. The bookkeeping that keeps a row out of spending IS undone: the in-transit note prefix goes, so the companion's 1.62 pass (`planBookkeepingFiling`) takes the row back out of "Sync bookkeeping" — pinned in Task 2. Logged as a follow-up.
4. **Read source (R3): both writers read a 500-row recent page.** The companion's `RestSyncHost.listActivities` is `pageSize: 500` too, so "the companion's run covers it" holds only within its page. No new read is added; a placeholder older than its account's newest 500 rows is reached by neither writer (follow-up).
5. **The app never showed the held-transfer finding.** It lived only in Telegram's daily findings; Settings → Checks showed Health. 1.65 adds a "Still in transit" list to Settings → Checks, published by the companion in the audit snapshot (`held`, optional), with the "Not a transfer" button.
6. **The lagging feed's name comes from what the sync stored.** The sync now writes `aliveThrough` (its `feedAliveEpoch`: the later of the balance date and the newest transaction) into each `account_balances` entry; the companion runs the sync's own `expiryHoldAccount` (now exported) over `account_mapping`, `account_balances` (`aliveThrough`, else `date`) and `account_names`. Name words come from the stored name only (the sync also uses the institution), a known gap (follow-up). When nothing usable is stored the message gives no reason rather than guessing.
7. **A leaves three more kinds of row as stored:** a row on the skip list (the sync "only stops importing" those), a payback (`asReimbursement`: expiring it would book income, the expensive direction), and a row a link wrote (`sourceGroupId` set, or `flow.is_external === false` with the placeholder note still on it — a refused promotion).
8. **B is a flag, and the corroboration test is `namesConnectedAccount` itself.** Routing the demoted row through `bankFirstTransferOut` would also demand a whole-word "transfer", which `ONLINE TRANSFERS TO …` lacks. The flag is set only on money out typed by a generic phrase alone, so every existing `toEqual` on the mapper's output stands. RuleEditor (no account type) and the payback breadth check (money in) are unaffected.
9. **Existing tests rebuilt on generic wording.** Eight tests used `Online Transfer to …` as "a transfer-typed out leg"; they get a mapping rule typing that wording TRANSFER_OUT (a rule-typed transfer pairs and holds exactly as a keyword-typed one did). Two tests' "aged placeholder" fixtures would now be settled by A; they get a mapped account absent from the download, which holds every leg (the fixture's own premise: "its feed dead"). Four exact `account_balances` assertions gain `aliveThrough`.
10. **R7 replaces a test.** `shared/ledger-checks.test.ts` "mentions a long-held transfer once…" pinned the old `when: 'once'`; it is replaced by the daily version.
11. **"Not a transfer" in Telegram confirms before it writes** (the findings menu's rule: no one-tap write from a finding). Both the confirm screen and the confirm tap re-judge the findings, so a row that settled or linked meanwhile writes nothing.
12. **Copy the spec does not give** (UI lines ≤ ~80 characters): finding reason `— {account}'s feed is behind, so it stays on hold` / `— the next sync settles it`; Telegram buttons `✋ Not a transfer`, `✋ Yes, not a transfer`; confirm `Count {description} ({amount}) as {spending|money in} and stop waiting for its other half? The next sync makes the change.`; toast `Done — the next sync counts it as {spending|money in}`; app title `Still in transit`, button `Not a transfer`, status `Saved — the next sync counts it as {spending|money in}.`, failure `Couldn't save that — nothing was changed.` (no emoji in the app: src/pages/copy-policy.test.tsx).

## Global Constraints

- **Spec sections A, B, C, Rulings R1–R8 and the spec's Tests are binding.** Do not re-open them; the Deviations above are decided.
- **Machine load (the owner's laptop overheats):** every vitest run is `nice npx vitest run --maxWorkers=2 <files>` from the repo root, or `(cd companion && nice npx vitest run --maxWorkers=2 <files>)` — never `--root`. Run the task's files during its steps; run the FULL suites at most once per task (its last step). Never two suites at once.
- **Never `-t` on `shared/sync-core.test.ts`**: its later tests rely on an earlier one shrinking `VALUATION_POLL` and time out alone. Run the whole file.
- **Gates:** `npm test` (root), `(cd companion && npx vitest run)`, `npm run type-check`, `nice npm --prefix companion run build` — the test gates in the `nice … --maxWorkers=2` form above. Baseline at 8813a13, measured: root **3915 passed (178 files)**, companion **1541 passed (69 files)**, type-check and build clean.
- **Known flake:** `src/pages/audit-fix-app.test.tsx` "links the pair through the add-on…" can time out (5 s) under a full-suite load; rerun that one file alone — it passes.
- **Dates:** tests pin them — `now` passed explicitly to pure functions; sync tests `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(...)`. Anything about a local calendar day passes under BOTH `TZ=UTC` and `TZ=America/New_York` (Tasks 3 and 5 say which files).
- **Privacy (public repo):** no real account/card/reference numbers, names or amounts. Neutral ids (`sfin-chk`, `wf-sav`, `w-old`, …), invented descriptors (`WIRE TRANSFER TO ACME LLC` is the issue's own invented one; `Harbor Savings`, `Northwind Bank`, `CORNER COFFEE`), zeros for references (`XXXXXX0000`). Never copy anything from `~/Downloads` probe outputs.
- **Two writers:** every new store/host method is optional and optional-called. This plan adds none: it adds an optional field to an existing secret (`account_balances[*].aliveThrough`, `audit_snapshot.held`), and readers treat absence as "older writer".
- **Style:** match the surrounding code — long WHY comments with evidence (issue #13; the 14-day window, `SYNC_LOOKBACK_OVERLAP_MS`; the 500-row page), plain American English, small pure helpers exported for tests.
- **Commits:** `git add` explicit paths only (`node_modules` may be symlinks); every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **No version bump, no release** (R8). Docs go under CHANGELOG `## [Unreleased]` and a new follow-ups section (§21).

## Review Focus

The five inputs most likely to bite that the spec does not spell out, each pinned by a test in its owning task:

1. **A download missing one mapped account** (SimpleFin errored for one bank): a stored placeholder must stay held, never settle — no life is not evidence (Task 2, "a mapped account missing from this download holds it").
2. **A placeholder a link wrote** (Wealthfolio linked it in place after a refused promotion: `flow.is_external: false`, note still prefixed, and the add-on cannot read groups): neither writer may retype it (Task 2, "leaves alone", `ph-in-place`).
3. **A card's held payment** (a TRANSFER_IN placeholder on a card): it settles as CREDIT, the type a card accepts, flagged (Task 2).
4. **A stale "Not a transfer" tap** (the row settled or linked between the report and the tap): nothing is written (Task 4, "a confirm for a finding that has since cleared writes nothing").
5. **A corrupt overrides document:** "Not a transfer" says so and writes nothing, in Telegram (Task 4) and in the app (Task 5).

## File map

| File | Change |
| --- | --- |
| `shared/mapper.ts` | `MappedType.genericTransferWording`, `GENERIC_TRANSFER_KEYWORDS`, institution split (Task 1) |
| `shared/bank-first-payment.ts` | `genericTransferNeedsCorroboration` (Task 1) |
| `shared/sync-core.ts` | demote in the typing loop (Task 1); `expiryHoldAccount` exported, `planStaleInTransit`, wired before `planReconciliation` (Task 2); `AccountBalanceSnapshot.aliveThrough` (Task 3) |
| `shared/sync-core-generic-wording.test.ts` (new) | Task 1 |
| `shared/sync-core-stale-transit.test.ts` (new) | Task 2; `aliveThrough` (Task 3); acceptance (Task 4) |
| `shared/sync-core.test.ts`, `shared/sync-core-change-log.test.ts`, `shared/sync-core-payback.test.ts` | fixture edits (Tasks 1, 2, 3) |
| `shared/held-transfers.ts` (new) | `StoredFeeds`, `HeldRow`, `HeldTransfer`, `judgeHeldTransfer`, `heldTransferMessage` (Task 3); `heldAgeDays`, `heldFromLedger` (Task 5) |
| `shared/ledger-checks.ts` | held finding: reason, `always` (Task 3); `not-transfer` fix (Task 4) |
| `companion/src/ledger-facts.ts`, `companion/src/daily-findings.ts` | held facts' extra fields; feeds passed (Task 3) |
| `shared/self-check.ts`, `shared/sync-overrides.ts` | `FindingFix` `not-transfer`; `notTransferEdit` (Task 4) |
| `companion/src/findings-menu.ts`, `companion/src/index.ts` | confirm + write; wiring (Task 4) |
| `shared/audit-snapshot.ts`, `companion/src/audit-facts.ts` | `held` in results/snapshot/parse; computed in `runAudit` (Task 5) |
| `src/components/AuditViews.tsx`, `src/utils/audit-fix.ts`, `src/tabs/SettingsTab.tsx` | "Still in transit" + button; `notTransferFromApp`; wiring (Task 5) |
| `CHANGELOG.md`, `docs/superpowers/follow-ups.md` | Task 6 |

---

### Task 1: B — generic transfer wording needs corroboration for money going out

**Files:**
- Modify: `shared/mapper.ts` (`MappedType` 21-29; after `BANK_TRANSFER_KEYWORDS` 83; the bank-transfer branch 128-133)
- Modify: `shared/bank-first-payment.ts` (append)
- Modify: `shared/sync-core.ts` (imports 1-3; the `builtIn` call 2396-2399)
- Create: `shared/sync-core-generic-wording.test.ts`
- Test: `shared/mapper.test.ts`, `shared/bank-first-payment.test.ts` (append)
- Modify (fixtures): `shared/sync-core.test.ts`, `shared/sync-core-change-log.test.ts`, `shared/sync-core-payback.test.ts`

**Interfaces:**
- Produces: `MappedType.genericTransferWording?: true`; `export const GENERIC_TRANSFER_KEYWORDS = /online transfer|wire transfer|bank transfer|member transfer/i` (shared/mapper.ts; `BANK_TRANSFER_KEYWORDS` stays exactly as it is — shared/payback.ts reads it); `export function genericTransferNeedsCorroboration(description: string, amount: number, accountType: string | undefined, mapped: MappedType, otherAccountWords: ReadonlyArray<readonly string[]>): boolean` (shared/bank-first-payment.ts).

- [ ] **Step 1: Write the failing tests**

Append to `shared/mapper.test.ts`:

```ts
describe('the four generic transfer phrases (1.65 B)', () => {
  it('flags money out typed only by a generic phrase', () => {
    for (const d of ['WIRE TRANSFER TO ACME LLC', 'ONLINE TRANSFER TO 0000', 'BANK TRANSFER REF 12', 'MEMBER TRANSFER TO SHARE 01']) {
      expect(mapTransactionWithSource(d, -10, [], 'CASH')).toEqual({ type: 'TRANSFER_OUT', fromRule: false, genericTransferWording: true });
    }
  });

  it('does not flag money in, an institution phrase, a card-payment phrase or a rule', () => {
    expect(mapTransactionWithSource('WIRE TRANSFER FROM ACME LLC', 10, [], 'CASH')).toEqual({ type: 'TRANSFER_IN', fromRule: false });
    expect(mapTransactionWithSource('PNC BANK ONLINE TRANSFER', -10, [], 'CASH')).toEqual({ type: 'TRANSFER_OUT', fromRule: false });
    expect(mapTransactionWithSource('CAPITAL ONE TRANSFER WIRE TRANSFER', -10, [], 'CASH')).toEqual({ type: 'TRANSFER_OUT', fromRule: false });
    expect(mapTransactionWithSource('ONLINE TRANSFER CREDIT CARD PAYMENT', -10, [], 'CASH')).toEqual({ type: 'TRANSFER_OUT', fromRule: false });
    const rules = [{ pattern: 'WIRE TRANSFER', matchType: 'contains' as const, activityType: 'TRANSFER_OUT' as const }];
    expect(mapTransactionWithSource('WIRE TRANSFER TO ACME LLC', -10, rules, 'CASH')).toEqual({ type: 'TRANSFER_OUT', fromRule: true });
  });
});
```

In `shared/bank-first-payment.test.ts`, add `genericTransferNeedsCorroboration` to the `./bank-first-payment.js` import and append (it reuses the file's `OTHERS`):

```ts
describe('genericTransferNeedsCorroboration (1.65 B)', () => {
  const GENERIC: MappedType = { type: 'TRANSFER_OUT', fromRule: false, genericTransferWording: true };
  const needs = (description: string, over: { amount?: number; accountType?: string | undefined; mapped?: MappedType } = {}) =>
    genericTransferNeedsCorroboration(description, over.amount ?? -250, 'accountType' in over ? over.accountType : 'CASH', over.mapped ?? GENERIC, OTHERS);

  it('is true for generic money out of a cash account that names no other connected account', () => {
    expect(needs('WIRE TRANSFER TO ACME LLC')).toBe(true);
    expect(needs('ONLINE TRANSFERS TO 0000')).toBe(true);
  });

  it('is false when the text names another connected account, as a whole word', () => {
    expect(needs('ONLINE TRANSFER TO CITI CARD 0000')).toBe(false);
    expect(needs('WIRE TRANSFER TO ROBINHOOD')).toBe(false);
    expect(needs('WIRE TRANSFER TO CITIZENS LLC')).toBe(true);
  });

  it('is false for money in, a card or an unknown account type, a rule, and an unflagged type', () => {
    expect(needs('WIRE TRANSFER FROM ACME LLC', { amount: 250 })).toBe(false);
    expect(needs('WIRE TRANSFER TO ACME LLC', { accountType: 'CREDIT_CARD' })).toBe(false);
    expect(needs('WIRE TRANSFER TO ACME LLC', { accountType: undefined })).toBe(false);
    expect(needs('WIRE TRANSFER TO ACME LLC', { mapped: { type: 'TRANSFER_OUT', fromRule: true } })).toBe(false);
    expect(needs('WIRE TRANSFER TO ACME LLC', { mapped: { type: 'TRANSFER_OUT', fromRule: false } })).toBe(false);
  });
});
```

Create `shared/sync-core-generic-wording.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { IN_TRANSIT_COMMENT_PREFIX, runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import type { SimplefinAccount, SimplefinTransaction } from './types.js';

const NOW = new Date('2026-10-19T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const tx = (id: string, iso: string, amount: string, description: string): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description });
const account = (id: string, name: string, transactions: SimplefinTransaction[], org?: string): SimplefinAccount => ({
  id, name, currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-19T12:00:00Z'), transactions, ...(org ? { org: { name: org } } : {}),
});
/** Checking (Northwind Bank) and Harbor Savings, both cash, both feeds current. */
const seedOf = (chk: SimplefinTransaction[], sav: SimplefinTransaction[] = [], extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [account('sfin-chk', 'Checking', chk, 'Northwind Bank'), account('sfin-sav', 'Harbor Savings', sav)] },
  mapping: { 'sfin-chk': 'wf-chk', 'sfin-sav': 'wf-sav' },
  accountTypes: { 'wf-chk': 'CASH', 'wf-sav': 'CASH' },
  ...extra,
});
const rowOf = (rows: HostActivity[] | undefined, txId: string) => (rows ?? []).find((r) => (r.comment ?? '').includes(` · ${txId}`));
const typed = (rows: HostActivity[] | undefined, txId: string) => {
  const r = rowOf(rows, txId);
  return [r?.activityType, (r?.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX)];
};

describe('runSyncCore — generic transfer wording needs corroboration for money going out (1.65 B)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('books a wire to a third party as an ordinary withdrawal, never held (issue #13)', async () => {
    const fh = createFakeHost(seedOf([tx('w-1', '2026-10-17T12:00:00Z', '-250.00', 'WIRE TRANSFER TO ACME LLC')]));
    const r = await runSyncCore(fh.host, fh.store, {});
    expect(r.errors).toEqual([]);
    expect(typed(fh.activities.get('wf-chk'), 'w-1')).toEqual(['WITHDRAWAL', false]);
  });

  it('holds generic wording that names another connected account, or matches a learned out name', async () => {
    const fh = createFakeHost(seedOf([
      tx('o-1', '2026-10-17T12:00:00Z', '-300.00', 'ONLINE TRANSFER TO HARBOR SAVINGS XXXXXX0000'),
      tx('o-2', '2026-10-17T12:00:00Z', '-40.00', 'ONLINE TRANSFER TO SHARED POT'),
    ], [], {
      transferNames: { version: 1, computedAt: '2026-10-19T14:00:00.000Z', names: [
        { accountId: 'wf-chk', direction: 'out', signature: 'online transfer to shared pot' },
      ] },
    }));
    await runSyncCore(fh.host, fh.store, {});
    expect(typed(fh.activities.get('wf-chk'), 'o-1')).toEqual(['TRANSFER_OUT', true]);
    expect(typed(fh.activities.get('wf-chk'), 'o-2')).toEqual(['TRANSFER_OUT', true]);
  });

  it('leaves alone: money in, the institution phrases, and a rule', async () => {
    const fh = createFakeHost(seedOf([
      tx('in-1', '2026-10-17T12:00:00Z', '900.00', 'WIRE TRANSFER FROM ACME LLC'),
      tx('pnc-1', '2026-10-17T12:00:00Z', '-75.00', 'PNC BANK ONLINE TRANSFER 0000'),
      tx('ruled', '2026-10-17T12:00:00Z', '-500.00', 'WIRE TRANSFER TO PAYROLL CO'),
    ], [], {
      mappingRules: [{ pattern: 'WIRE TRANSFER TO PAYROLL CO', matchType: 'contains', activityType: 'TRANSFER_OUT' }],
    }));
    await runSyncCore(fh.host, fh.store, {});
    const rows = fh.activities.get('wf-chk');
    expect(typed(rows, 'in-1')[1]).toBe(true);
    expect(typed(rows, 'pnc-1')).toEqual(['TRANSFER_OUT', true]);
    expect(typed(rows, 'ruled')).toEqual(['TRANSFER_OUT', true]);
  });

  it('still links a generic out booked as a withdrawal when its other half posts within 5 days', async () => {
    // Both syncs on ONE fake host; the fake serves the seed's accountSet by reference.
    const seed = seedOf([tx('o-3', '2026-10-18T12:00:00Z', '-120.00', 'ONLINE TRANSFER 0000')]);
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, {});
    expect(typed(fh.activities.get('wf-chk'), 'o-3')).toEqual(['WITHDRAWAL', false]);

    vi.setSystemTime(new Date('2026-10-20T15:00:00Z'));
    seed.accountSet!.accounts.find((a) => a.id === 'sfin-sav')!.transactions!.push(
      tx('i-3', '2026-10-20T12:00:00Z', '120.00', 'DEPOSIT FROM CHECKING 0000'),
    );
    const r = await runSyncCore(fh.host, fh.store, { force: true });
    expect(r.errors).toEqual([]);
    expect(fh.links).toHaveLength(1);
    expect(typed(fh.activities.get('wf-chk'), 'o-3')).toEqual(['TRANSFER_OUT', false]);
    expect(typed(fh.activities.get('wf-sav'), 'i-3')).toEqual(['TRANSFER_IN', false]);
    expect(fh.activities.get('wf-chk')).toHaveLength(1);
    expect(fh.activities.get('wf-sav')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `nice npx vitest run --maxWorkers=2 shared/mapper.test.ts shared/bank-first-payment.test.ts shared/sync-core-generic-wording.test.ts`
Expected: `6 failed | 48 passed (54)` — `genericTransferNeedsCorroboration is not a function` (3), the mapper flag missing (1), and the wire / the withdrawal-then-link row arriving as `['TRANSFER_OUT', true]` (2). The "holds…" and "leaves alone…" sync tests already pass: they are guards.

- [ ] **Step 3: Implement**

- `shared/mapper.ts`: add to `MappedType`, with a doc comment (issue #13: a wire to a third party was held forever):
  `genericTransferWording?: true;` — "a TRANSFER_OUT whose type came ONLY from one of the four generic phrases (no rule, no card-payment phrase, no institution phrase); the sync core decides whether it stands". Below `BANK_TRANSFER_KEYWORDS` (unchanged) add a private `INSTITUTION_TRANSFER_KEYWORDS = /pnc bank|capital one transfer/i` (R5) and the exported `GENERIC_TRANSFER_KEYWORDS` above. In the `BANK_TRANSFER_KEYWORDS` branch, money out (`amount < 0`) that does NOT match `INSTITUTION_TRANSFER_KEYWORDS` also gets `genericTransferWording: true`; money in and `amount === 0` stay exactly as today (`amount >= 0 → TRANSFER_IN`, no flag).
- `shared/bank-first-payment.ts`: `genericTransferNeedsCorroboration` returns true only when `accountType === 'CASH'`, `amount < 0`, `!mapped.fromRule`, `mapped.genericTransferWording`, and `!namesConnectedAccount(description, otherAccountWords)`. Doc comment: R4's trade (a first own-account transfer worded only generically shows as spending until its other half pairs), and why `bankFirstTransferOut` is not reused (its whole-word "transfer" test misses `ONLINE TRANSFERS`).
- `shared/sync-core.ts`: import `genericTransferNeedsCorroboration` and `type MappedType`. Rename the mapper's result `worded` and keep the name `builtIn` for what follows:

```ts
      const builtIn: MappedType = genericTransferNeedsCorroboration(tx.description, amount, acctType, worded, otherAccountWords)
        ? { type: 'WITHDRAWAL', fromRule: false }
        : worded;
```

  `acctType` and `otherAccountWords` are already in scope there. Precedence is unchanged: rules (inside the mapper) → card-payment phrase → institution phrases → generic phrases (now needing corroboration) → bank-first (finds nothing new: the text named no account) → learned out name (can promote it to TRANSFER_OUT) → payback / `notTransfer`. Put a WHY comment above it (issue #13; `WIRE TRANSFER TO ACME LLC`; pairing by amount still links own-account transfers within 5 days).

- [ ] **Step 4: Run them to see them pass**

Run: `nice npx vitest run --maxWorkers=2 shared/mapper.test.ts shared/bank-first-payment.test.ts shared/sync-core-generic-wording.test.ts`
Expected: `54 passed (54)`.

- [ ] **Step 5: See which existing tests B changes**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core.test.ts shared/sync-core-change-log.test.ts shared/sync-core-payback.test.ts`
Expected: `8 failed | 223 passed (231)` — each uses `Online Transfer to …` / `ONLINE TRANSFER TO CHK` as its transfer-typed out leg: in sync-core.test.ts "imports a solo transfer-typed leg…", "promotes a placeholder…", "converts a solo transfer-typed leg to plain WITHDRAWAL…", "a placeholder still in the feed is rewritten once, not twice", "writes a new in-transit transfer placeholder with the marker already on"; in sync-core-change-log.test.ts "a held transfer that finds its other half…", "records a new transfer leg held in transit…"; in sync-core-payback.test.ts "keeps a stored payback out of pair detection…".

- [ ] **Step 6: Keep those legs transfer-typed with a rule**

Add, with the comment `// 1.65 B: generic wording alone no longer makes money out a transfer; the rule keeps this leg transfer-typed.`, a `mappingRules: [{ pattern: '<the wording>', matchType: 'contains' as const, activityType: 'TRANSFER_OUT' as const }]` entry to:
- `shared/sync-core.test.ts`: `soloOutLegSeed` (covers the first two tests) and the inline seed of "converts a solo transfer-typed leg…" — pattern `'Online Transfer to Savings'`; the two `seed(...)`-built tests ("rewritten once, not twice", "marker already on") as `s.mappingRules = [...]` after `s.accountSet!.accounts[0].transactions = …`.
- `shared/sync-core-change-log.test.ts`: the `accounts(withIn)` seed of "a held transfer that finds its other half…" — `'Online Transfer to Card'`; "records a new transfer leg held in transit…" becomes `createFakeHost({ ...checking([<the same tx>]), mappingRules: [...] })` with `'Online Transfer to Savings'`.
- `shared/sync-core-payback.test.ts`: the seed of "keeps a stored payback out of pair detection…" — `'ONLINE TRANSFER TO CHK'`.

No assertion changes.

- [ ] **Step 7: Verify, then the full gates once**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core.test.ts shared/sync-core-change-log.test.ts shared/sync-core-payback.test.ts` → `231 passed (231)`.
Then `npm run type-check` (clean), `nice npx vitest run --maxWorkers=2` → **3924 passed (179 files)**, `(cd companion && nice npx vitest run --maxWorkers=2)` → **1541 passed (69 files)**.

- [ ] **Step 8: Commit**

```bash
git add shared/mapper.ts shared/mapper.test.ts shared/bank-first-payment.ts shared/bank-first-payment.test.ts shared/sync-core.ts shared/sync-core-generic-wording.test.ts shared/sync-core.test.ts shared/sync-core-change-log.test.ts shared/sync-core-payback.test.ts
git commit -m "B: generic transfer wording out of a cash account needs corroboration (issue #13)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: A — in-transit rows outside the download settle like in-feed ones

**Files:**
- Modify: `shared/sync-core.ts` (`expiryHoldAccount` 1426-1450: export, readonly params; new `planStaleInTransit` before the `DEAD_FEED_SECONDS` doc at 1454; the per-account call before `const plan = planReconciliation(planFeed, …)` at 3267)
- Create: `shared/sync-core-stale-transit.test.ts`
- Modify (fixtures): `shared/sync-core.test.ts` (the legacy-placeholder `seed` ~3356 and the v1.54 external-marker `seed` ~3800)

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces (shared/sync-core.ts):
  - `export function expiryHoldAccount(legSfinAccountId: string, legPostedEpoch: number, mappedSfinIds: readonly string[], feedAliveEpoch: ReadonlyMap<string, number>, dead: { nowSec: number; legDescription: string; nameWords: ReadonlyMap<string, readonly string[]> }): string | null` — same body, now exported (Task 3 calls it).
  - `export interface StaleTransitContext { wfAccountId: string; sfinAccountId: string; accountType: string; feedTxIds: ReadonlySet<string>; nowSec: number; mappedSfinIds: readonly string[]; feedAliveEpoch: ReadonlyMap<string, number>; nameWords: ReadonlyMap<string, readonly string[]>; leaveAlone(row: ExistingRow & { sourceGroupId?: string | null; flowExternal?: boolean | null }): boolean; notTransfer(txId: string): boolean }`
  - `export function planStaleInTransit(rows: ReadonlyArray<ExistingRow & { sourceGroupId?: string | null; flowExternal?: boolean | null }>, ctx: StaleTransitContext): { settle: FeedTx[]; held: Array<{ txId: string; heldBy: string }> }`

- [ ] **Step 1: Write the failing tests**

Create `shared/sync-core-stale-transit.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { planBookkeepingFiling } from './bookkeeping-filing.js';
import type { ChangeEntry, ChangeLogSink } from './change-entries.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { EXTERNAL_BOOKKEEPING_METADATA, IN_TRANSIT_COMMENT_PREFIX, runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { ActivityWrite, HostActivity } from './sync-host.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { SimplefinAccount, SimplefinTransaction } from './types.js';

const NOW = new Date('2026-10-19T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const WIRE = 'WIRE TRANSFER TO ACME LLC';
const TO_HARBOR = 'ONLINE TRANSFER TO HARBOR SAVINGS 0000';

const tx = (id: string, iso: string, amount: string, description: string): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description });
const account = (id: string, name: string, aliveIso: string, transactions: SimplefinTransaction[]): SimplefinAccount => ({
  id, name, currency: 'USD', balance: '0', 'balance-date': epoch(aliveIso), transactions,
});
/** Checking and Harbor Savings, both cash. An incremental download: Checking
 *  carries only a coffee from yesterday; `savAlive` is Harbor's balance date. */
const seedOf = (stored: HostActivity[], extra: Partial<FakeHostSeed> = {}, savAlive = '2026-10-19T12:00:00Z', chkFeed?: SimplefinTransaction[]): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    account('sfin-chk', 'Checking', '2026-10-19T12:00:00Z', chkFeed ?? [tx('coffee', '2026-10-18T12:00:00Z', '-4.50', 'CORNER COFFEE')]),
    account('sfin-sav', 'Harbor Savings', savAlive, []),
  ] },
  mapping: { 'sfin-chk': 'wf-chk', 'sfin-sav': 'wf-sav' },
  accountTypes: { 'wf-chk': 'CASH', 'wf-sav': 'CASH' },
  existing: new Map([['wf-chk', stored]]),
  ...extra,
});
/** A placeholder the sync stored on `date` for SimpleFin transaction `txId`. */
const placeholder = (id: string, txId: string, date: string, over: Partial<HostActivity> = {}, description = WIRE): HostActivity => ({
  id, accountId: 'wf-chk', activityType: 'TRANSFER_OUT', date, amount: 250,
  comment: `${IN_TRANSIT_COMMENT_PREFIX}${description} · ${txId}`, sourceGroupId: null, metadata: EXTERNAL_BOOKKEEPING_METADATA, ...over,
});
const updatesFor = (saved: Array<{ updates?: ActivityWrite[] }>, id: string) => saved.flatMap((r) => r.updates ?? []).filter((u) => u.id === id);
const stored = (rows: HostActivity[] | undefined, id: string) => (rows ?? []).find((r) => r.id === id);

function capture(): ChangeLogSink & { entries: () => ChangeEntry[] } {
  const batches: ChangeEntry[][] = [];
  return {
    writer: 'companion', run: 'cRUN1',
    append: vi.fn(async (entries: ChangeEntry[]) => { batches.push(entries); }),
    entries: () => batches.flat(),
  };
}

describe('runSyncCore — in-transit rows outside the download settle like in-feed ones (1.65 A)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('expires a 20-day-old placeholder the download no longer carries: WITHDRAWAL, Needs review, prefix gone, logged', async () => {
    const fh = createFakeHost(seedOf([placeholder('ph-1', 'w-old', '2026-09-29')]));
    const log = capture();
    const r = await runSyncCore(fh.host, fh.store, { changeLog: log });
    expect(r.errors).toEqual([]);
    const [update, ...more] = updatesFor(fh.saved, 'ph-1');
    expect(more).toEqual([]);
    expect(update).toMatchObject({
      activityType: 'WITHDRAWAL', amount: 250, fee: 0, needsReview: true,
      comment: `${WIRE} · w-old`, symbol: { symbol: '$CASH-USD' },
    });
    expect(update).not.toHaveProperty('metadata');
    const row = stored(fh.activities.get('wf-chk'), 'ph-1')!;
    expect([row.activityType, row.comment]).toEqual(['WITHDRAWAL', `${WIRE} · w-old`]);
    expect(log.entries().filter((e) => e.kind === 'transfer-type')).toEqual([expect.objectContaining({
      undoable: false,
      summary: `Stopped waiting for the other half of ${WIRE} — now counted as spending`,
      subject: expect.objectContaining({ txKeys: [accountTxKey('sfin-chk', 'w-old')], activityIds: ['ph-1'], amountCents: -25000 }),
    })]);
    // R2: the 1.62 "Sync bookkeeping" filing comes back out on the companion's next pass.
    expect(planBookkeepingFiling([{
      id: 'ph-1', accountType: 'CASH', type: 'WITHDRAWAL', subtype: '', groupId: '', notes: row.comment!, spendingCategoryIds: ['cat-sync'],
    }], { categoryId: 'cat-sync', filedByPass: new Set(['ph-1']) })).toEqual({ file: [], unfile: ['ph-1'] });
  });

  it('writes exactly what the in-feed expiry writes for the same row', async () => {
    const row = () => placeholder('ph-1', 'w-old', '2026-09-29', {}, TO_HARBOR);
    const outside = createFakeHost(seedOf([row()]));
    await runSyncCore(outside.host, outside.store, {});
    const inside = createFakeHost(seedOf([row()], {}, undefined, [tx('w-old', '2026-09-29T12:00:00Z', '-250.00', TO_HARBOR)]));
    await runSyncCore(inside.host, inside.store, { force: true });
    expect(updatesFor(outside.saved, 'ph-1')).toEqual(updatesFor(inside.saved, 'ph-1'));
    expect(updatesFor(inside.saved, 'ph-1')).toHaveLength(1);
  });

  it('settles an inflow too: a cash placeholder in becomes a DEPOSIT, flagged', async () => {
    const fh = createFakeHost(seedOf([placeholder('ph-in', 'w-in', '2026-09-29', { activityType: 'CREDIT', amount: 900 }, 'WIRE TRANSFER FROM ACME LLC')]));
    await runSyncCore(fh.host, fh.store, {});
    expect(updatesFor(fh.saved, 'ph-in')).toEqual([expect.objectContaining({ activityType: 'DEPOSIT', amount: 900, needsReview: true })]);
  });

  it('keeps it held while another mapped feed has published nothing past its pairing window', async () => {
    // Harbor's newest data is Sep 30, before the leg's Oct 4 pairing deadline, and it is not dead (19 days).
    const fh = createFakeHost(seedOf([placeholder('ph-1', 'w-old', '2026-09-29')], {}, '2026-09-30T12:00:00Z'));
    await runSyncCore(fh.host, fh.store, {});
    expect(updatesFor(fh.saved, 'ph-1')).toEqual([]);
    expect(stored(fh.activities.get('wf-chk'), 'ph-1')!.comment!.startsWith(IN_TRANSIT_COMMENT_PREFIX)).toBe(true);
  });

  it('a mapped account missing from this download holds it: no life is not evidence', async () => {
    const seed = seedOf([placeholder('ph-1', 'w-old', '2026-09-29')]);
    seed.mapping!['sfin-gone'] = 'wf-gone';
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, {});
    expect(updatesFor(fh.saved, 'ph-1')).toEqual([]);
  });

  it("settles a card's held payment as the type a card accepts: CREDIT, flagged", async () => {
    const seed = seedOf([], {}, undefined);
    seed.existing = new Map([['wf-sav', [{ ...placeholder('ph-card', 'c-old', '2026-09-29', { activityType: 'TRANSFER_IN' }, 'PAYMENT THANK YOU'), accountId: 'wf-sav' }]]]);
    seed.accountTypes = { 'wf-chk': 'CASH', 'wf-sav': 'CREDIT_CARD' };
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, {});
    expect(updatesFor(fh.saved, 'ph-card')).toEqual([expect.objectContaining({ activityType: 'CREDIT', amount: 250, needsReview: true })]);
  });

  it('a feed silent over 21 days holds only the legs that name it', async () => {
    const fh = createFakeHost(seedOf([
      placeholder('ph-wire', 'w-old', '2026-09-29'),
      placeholder('ph-harbor', 'h-old', '2026-09-29', { amount: 300 }, TO_HARBOR),
    ], {}, '2026-09-20T12:00:00Z'));
    await runSyncCore(fh.host, fh.store, {});
    expect(updatesFor(fh.saved, 'ph-wire')).toEqual([expect.objectContaining({ activityType: 'WITHDRAWAL', needsReview: true })]);
    expect(updatesFor(fh.saved, 'ph-harbor')).toEqual([]);
  });

  it('leaves alone: a linked row, a pending row, a young row, a skipped row and a payback', async () => {
    const fh = createFakeHost(seedOf([
      placeholder('ph-linked', 'w-linked', '2026-09-29', { sourceGroupId: 'g-1' }),
      // Linked in place by Wealthfolio after a refused promotion: the note still has the prefix.
      placeholder('ph-in-place', 'w-in-place', '2026-09-29', { metadata: JSON.stringify({ flow: { is_external: false } }) }),
      placeholder('ph-pending', 'w-pending', '2026-09-29', { comment: `${IN_TRANSIT_COMMENT_PREFIX}${WIRE} · w-pending · pending` }),
      placeholder('ph-young', 'w-young', '2026-10-11'),
      placeholder('ph-skip', 'w-skip', '2026-09-29'),
      placeholder('ph-pay', 'w-pay', '2026-09-29', { activityType: 'CREDIT' }, 'ONLINE TRANSFER FROM A FRIEND'),
    ], {
      skippedTransactions: [{ account: 'sfin-chk', txId: 'w-skip' }],
      syncOverrides: setTxOverride(emptySyncOverrides(), accountTxKey('sfin-chk', 'w-pay'), 'asReimbursement', NOW),
    }));
    await runSyncCore(fh.host, fh.store, {});
    for (const id of ['ph-linked', 'ph-in-place', 'ph-pending', 'ph-young', 'ph-skip', 'ph-pay']) {
      expect(updatesFor(fh.saved, id)).toEqual([]);
    }
  });

  it('a placeholder still in the download takes the in-feed path: one write, not two', async () => {
    const fh = createFakeHost(seedOf([placeholder('ph-1', 'w-old', '2026-09-29', {}, TO_HARBOR)], {}, undefined,
      [tx('w-old', '2026-09-29T12:00:00Z', '-250.00', TO_HARBOR)]));
    await runSyncCore(fh.host, fh.store, { force: true });
    expect(updatesFor(fh.saved, 'ph-1')).toHaveLength(1);
  });

  it('"not a transfer": a placeholder outside the download becomes ordinary at once, even while a feed lags', async () => {
    const key = accountTxKey('sfin-chk', 'w-old');
    const fh = createFakeHost(seedOf([
      placeholder('ph-1', 'w-old', '2026-09-29'),
      { id: 'done', accountId: 'wf-chk', activityType: 'WITHDRAWAL', date: '2026-09-28', amount: 80, comment: 'WIRE TRANSFER TO ACME LLC · w-done', sourceGroupId: null },
    ], {
      syncOverrides: setTxOverride(setTxOverride(emptySyncOverrides(), key, 'notTransfer', NOW), accountTxKey('sfin-chk', 'w-done'), 'notTransfer', NOW),
    }, '2026-09-30T12:00:00Z'));
    const log = capture();
    await runSyncCore(fh.host, fh.store, { changeLog: log });
    const [update] = updatesFor(fh.saved, 'ph-1');
    expect(update).toMatchObject({ activityType: 'WITHDRAWAL', comment: `${WIRE} · w-old` });
    expect(update).not.toHaveProperty('needsReview');
    expect(updatesFor(fh.saved, 'done')).toEqual([]);
    expect(log.entries().filter((e) => e.kind === 'transfer-type').map((e) => e.summary)).toEqual([
      `Counted ${WIRE} as spending — you said it isn't a transfer`,
    ]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-stale-transit.test.ts`
Expected: `6 failed | 4 passed (10)` — every settling test finds no update for the row (`expected undefined to match object …` / `expected [] to deeply equal [ ObjectContaining{…} ]`). The four guards ("keeps it held…", "a mapped account missing…", "leaves alone…", "one write, not two") already pass.

- [ ] **Step 3: Implement `planStaleInTransit` and call it**

Export `expiryHoldAccount` with the readonly parameter types in Interfaces (body unchanged). Add `StaleTransitContext` and `planStaleInTransit` right after it, with a doc comment that tells the issue #13 story (the 10-day give-up ran only on rows in the download; an incremental sync re-downloads from the last sync minus `SYNC_LOOKBACK_OVERLAP_MS`, 14 days; a leg not re-evaluated between day 10 and 14 kept its shape forever) and R1–R3. For each row, in this order:
1. skip unless the note starts with `IN_TRANSIT_COMMENT_PREFIX`; skip a pending row; skip a row whose `txId` is in `ctx.feedTxIds` (the in-feed path owns it); skip `row.sourceGroupId`, `row.flowExternal === false` and `ctx.leaveAlone(row)`;
2. `signed = OUTFLOW_TYPES.has(row.type) ? -row.absCents : row.absCents`; base `FeedTx` = `{ txId, wfAccountId: ctx.wfAccountId, absCents: row.absCents, type: expiredTransferLegType(ctx.accountType, signed), date: row.date, pending: false }`;
3. `ctx.notTransfer(row.txId)` → push the base as is (the in-feed `notTransfer` result: no hold, no `needsReview`) — Deviation 1;
4. `posted = Date.parse(bankDayInstant(row.date)) / 1000`; skip unless `ctx.nowSec - posted > IN_TRANSIT_TIMEOUT_SECONDS`;
5. `heldBy = expiryHoldAccount(ctx.sfinAccountId, posted, ctx.mappedSfinIds, ctx.feedAliveEpoch, { nowSec, legDescription: descriptionFromComment(row.comment), nameWords })`; non-null → `held.push({ txId, heldBy })`; null → push `{ ...base, needsReview: true }`.

In the per-account loop, immediately before `const plan = planReconciliation(planFeed, planExisting.filter((r) => !unlinkingIds.has(r.wfId)));`, under a `// ── 1.65 A: in-transit rows outside this download ──` header:
- `const staleTransit = planStaleInTransit(planExisting.filter((r) => !unlinkingIds.has(r.wfId)), { wfAccountId, sfinAccountId: sfAccount.id, accountType: wfTypes.get(wfAccountId) ?? '', feedTxIds: new Set(feed.map((t) => t.txId)), nowSec, mappedSfinIds, feedAliveEpoch, nameWords, leaveAlone: (r) => isLinkedRow(r) || skippedTxKeys.has(accountTxKey(sfAccount.id, r.txId)) || hasTxOverride(overrides, accountTxKey(sfAccount.id, r.txId), 'asReimbursement'), notTransfer: (txId) => notTransferKey(accountTxKey(sfAccount.id, txId)) })` — every name is already in scope (`nowSec`, `mappedSfinIds`, `feedAliveEpoch`, `nameWords` come from the in-transit block before the loop; `feed`, not `liveFeed`, so a frozen key counts as "in the download").
- `console.info` each `held` entry, worded like the in-feed hold line (`… stored leg ${txId} (account ${sfAccount.id}) is past the timeout and outside this download, but account ${heldBy} has published nothing past its pairing window — keeping the placeholder`).
- For each `settle` row: `descByKey.set(accountTxKey(sfAccount.id, t.txId), descriptionFromComment(storedByTxId.get(t.txId)?.comment))` — the write builds the note `<description> · <txId>` from `descByKey`, so the stored description survives exactly and the prefix goes.
- Pass `[...planFeed, ...staleTransit.settle]` to `planReconciliation`. Nothing else changes: the update, the `fee: 0`, the omitted metadata, the change-log entry (`wasInTransit && !to.inTransit && !isTransferType(to.type)`, `undone` when `notTransfer`) and the signed amount (`signedCentsOf` falls back to the type) are the in-feed path's own; `skipped` is still counted off `feed`.

- [ ] **Step 4: Run them to see them pass**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-stale-transit.test.ts`
Expected: `10 passed (10)`.

- [ ] **Step 5: See which existing tests A changes**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core.test.ts`
Expected: `2 failed | 186 passed (188)` — "rewrites a drift plug and an aged placeholder to TRANSFER_OUT…" (`ph-1` now gets a second update, A's WITHDRAWAL) and "stamps an opening balance, a plug and an aged placeholder" (`ph` likewise): each fixture's single mapped account is current, so nothing holds its months-old placeholder.

- [ ] **Step 6: Hold those fixtures the way their comment says ("its feed dead")**

In both `seed` helpers (`describe('legacy fee-side placeholders …')` and `describe("the sync's own unlinked transfer rows are marked external (v1.54)")`) change `mapping: { 'sfin-1': 'wf-a' }` to `mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' }` with the comment `// 'sfin-2' is mapped but absent from the download: a feed with no life at all, so it holds the aged placeholder(s) below (1.65 A would otherwise settle them).` No assertion changes.

- [ ] **Step 7: Verify, then the full gates once**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core.test.ts` → `188 passed (188)`.
Then `npm run type-check` (clean), `nice npx vitest run --maxWorkers=2` → **3934 passed (180 files)**, `(cd companion && nice npx vitest run --maxWorkers=2)` → **1541 passed (69 files)**.

- [ ] **Step 8: Commit**

```bash
git add shared/sync-core.ts shared/sync-core-stale-transit.test.ts shared/sync-core.test.ts
git commit -m "A: in-transit rows outside the download settle like in-feed ones (issue #13)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: C — the held-transfer finding says why, every day

**Files:**
- Modify: `shared/sync-core.ts` (`AccountBalanceSnapshot` 632-700: `aliveThrough` after `checkedAfterSave`; the `accountBalances[sfAccount.id] = {…}` assignment, after `date: sfAccount['balance-date'],` at 3513)
- Create: `shared/held-transfers.ts`, `shared/held-transfers.test.ts`
- Modify: `shared/ledger-checks.ts` (import; `LedgerFacts.heldTransfers` 55; delete `HELD_MIN_AGE_DAYS` 94; `evaluateLedgerChecks` signature 119; the held loop 262-272)
- Modify: `companion/src/ledger-facts.ts` (`heldTransfers` query 177-180), `companion/src/daily-findings.ts` (`StoredAccountBalance` 42; `evaluateLedgerChecks(facts, seen, now)` 130)
- Test: `shared/ledger-checks.test.ts`, `shared/sync-core-stale-transit.test.ts` (append), `companion/src/ledger-facts.test.ts`, `companion/src/daily-findings.test.ts`
- Modify (fixtures): `shared/sync-core.test.ts` (4 exact `account_balances` lines, ~2260-2261 and ~2359-2360)

**Interfaces:**
- Consumes: `expiryHoldAccount` (Task 2); `accountNameWords`, `bankDayInstant`, `accountTxKey`, `formatDollars`.
- Produces (shared/held-transfers.ts):
  - `export const HELD_MIN_AGE_DAYS = 14;`
  - `export interface StoredFeeds { mapping: Readonly<Record<string, string>>; balances: Readonly<Record<string, { date?: unknown; aliveThrough?: unknown } | null | undefined>>; names: Readonly<Record<string, string>> }` — account_mapping (SimpleFin id → Wealthfolio id), account_balances, account_names (SimpleFin id → name); a stored figure that is not a finite number counts as no life.
  - `export interface HeldRow { id: string; description: string; amount: number; ageDays: number; wfAccountId?: string; date?: string; txId?: string | null; direction?: 'in' | 'out' }`
  - `export interface HeldTransfer { activityId: string; description: string; amount: number; ageDays: number; direction: 'in' | 'out'; heldBy?: string | null; txKey: string | null; label: string }` — `heldBy`: the holding account's name; `null` = no feed holds it (the next sync settles it); ABSENT = cannot tell.
  - `export function judgeHeldTransfer(row: HeldRow, feeds: StoredFeeds | undefined, now: Date): HeldTransfer`
  - `export function heldTransferMessage(h: HeldTransfer): string`
- Produces (shared/ledger-checks.ts): `LedgerFacts.heldTransfers: HeldRow[]`; `evaluateLedgerChecks(facts, seen, now, feeds?: StoredFeeds)`.
- Produces (shared/sync-core.ts): `AccountBalanceSnapshot.aliveThrough?: number` (Unix seconds).

- [ ] **Step 1: Write the failing tests**

Create `shared/held-transfers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { heldTransferMessage, judgeHeldTransfer, type HeldRow, type StoredFeeds } from './held-transfers.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-19T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const WIRE: HeldRow = {
  id: 'ph-1', description: 'WIRE TRANSFER TO ACME LLC', amount: 250, ageDays: 20,
  wfAccountId: 'wf-chk', date: '2026-09-29', txId: 'w-old', direction: 'out',
};
/** Checking current; Harbor Savings proven alive through `savAlive`. */
const feeds = (savAlive: string, over: Partial<StoredFeeds> = {}): StoredFeeds => ({
  mapping: { 'sfin-chk': 'wf-chk', 'sfin-sav': 'wf-sav' },
  balances: {
    'sfin-chk': { date: epoch('2026-10-19T12:00:00Z'), aliveThrough: epoch('2026-10-19T12:00:00Z') },
    'sfin-sav': { date: epoch(savAlive), aliveThrough: epoch(savAlive) },
  },
  names: { 'sfin-chk': 'Checking', 'sfin-sav': 'Harbor Savings' },
  ...over,
});

describe('judgeHeldTransfer (1.65 C)', () => {
  it('names the connected account whose feed holds the leg open, and the bank transaction to act on', () => {
    expect(judgeHeldTransfer(WIRE, feeds('2026-09-30T12:00:00Z'), NOW)).toEqual({
      activityId: 'ph-1', description: 'WIRE TRANSFER TO ACME LLC', amount: 250, ageDays: 20, direction: 'out',
      heldBy: 'Harbor Savings', txKey: accountTxKey('sfin-chk', 'w-old'), label: 'WIRE TRANSFER TO ACME LLC · Checking',
    });
  });

  it("reads the feed's balance date when an older writer stored no aliveThrough", () => {
    const f = feeds('2026-09-30T12:00:00Z');
    const old = { ...f, balances: { ...f.balances, 'sfin-sav': { date: epoch('2026-09-30T12:00:00Z') } } };
    expect(judgeHeldTransfer(WIRE, old, NOW).heldBy).toBe('Harbor Savings');
  });

  it('holds nothing when every feed is caught up, and a feed silent over 21 days holds only a leg that names it', () => {
    expect(judgeHeldTransfer(WIRE, feeds('2026-10-19T12:00:00Z'), NOW).heldBy).toBeNull();
    expect(judgeHeldTransfer(WIRE, feeds('2026-09-20T12:00:00Z'), NOW).heldBy).toBeNull();
    expect(judgeHeldTransfer({ ...WIRE, description: 'ONLINE TRANSFER TO HARBOR SAVINGS 0000' }, feeds('2026-09-20T12:00:00Z'), NOW).heldBy)
      .toBe('Harbor Savings');
  });

  it('cannot tell why, and has no transaction to act on, when the account is unmapped or nothing was stored', () => {
    const unmapped = judgeHeldTransfer({ ...WIRE, wfAccountId: 'wf-gone' }, feeds('2026-09-30T12:00:00Z'), NOW);
    expect(unmapped.txKey).toBeNull();
    expect(unmapped).not.toHaveProperty('heldBy');
    expect(judgeHeldTransfer({ ...WIRE, txId: null }, feeds('2026-09-30T12:00:00Z'), NOW).txKey).toBeNull();
    const blind = judgeHeldTransfer(WIRE, undefined, NOW);
    expect(blind).toMatchObject({ txKey: null, label: 'WIRE TRANSFER TO ACME LLC', direction: 'out' });
    expect(blind).not.toHaveProperty('heldBy');
  });
});

describe('heldTransferMessage (1.65 C)', () => {
  it('says why: the feed that is behind, that the next sync settles it, or nothing when it cannot tell', () => {
    const held = judgeHeldTransfer(WIRE, feeds('2026-09-30T12:00:00Z'), NOW);
    expect(heldTransferMessage(held)).toBe(
      "WIRE TRANSFER TO ACME LLC ($250.00) has waited 20 days for its other half — Harbor Savings's feed is behind, so it stays on hold",
    );
    expect(heldTransferMessage({ ...held, heldBy: null })).toBe(
      'WIRE TRANSFER TO ACME LLC ($250.00) has waited 20 days for its other half — the next sync settles it',
    );
    const { heldBy: _unknown, ...blind } = held;
    expect(heldTransferMessage(blind)).toBe('WIRE TRANSFER TO ACME LLC ($250.00) has waited 20 days for its other half');
  });
});
```

In `shared/ledger-checks.test.ts`, add below `daysAgo`:

```ts
/** Harbor Savings has published nothing since Sep 2, before an Aug 31 leg's Sep 5 pairing deadline. */
const HELD_FEEDS = {
  mapping: { 'sfin-chk': 'wf-chk', 'sfin-sav': 'wf-sav' },
  balances: { 'sfin-chk': { aliveThrough: NOW.getTime() / 1000 }, 'sfin-sav': { aliveThrough: Date.parse('2026-09-02T12:00:00Z') / 1000 } },
  names: { 'sfin-chk': 'Checking', 'sfin-sav': 'Harbor Savings' },
};
```

and REPLACE the test "mentions a long-held transfer once, not every day its counterpart stays missing" (R7, Deviation 10) with:

```ts
  it('shows a transfer held past 14 days every day it stays held, saying why (1.65 C, R7)', () => {
    const f = clean();
    f.heldTransfers = [{
      id: 'h1', description: 'WIRE TRANSFER TO ACME LLC', amount: 250, ageDays: 20,
      wfAccountId: 'wf-chk', date: '2026-08-31', txId: 'w-old', direction: 'out',
    }];
    const { findings } = evaluateLedgerChecks(f, { 'held-transfer:h1': daysAgo(5) }, NOW, HELD_FEEDS);
    expect(findings).toEqual([expect.objectContaining({
      key: 'held-transfer:h1',
      message: "WIRE TRANSFER TO ACME LLC ($250.00) has waited 20 days for its other half — Harbor Savings's feed is behind, so it stays on hold",
      label: 'WIRE TRANSFER TO … $250.00 still in transit',
    })]);
    // Without the stored feeds (an older caller) it cannot tell why, and does not guess.
    expect(evaluateLedgerChecks(f, {}, NOW).findings[0].message).toBe(
      'WIRE TRANSFER TO ACME LLC ($250.00) has waited 20 days for its other half',
    );
    // Young holds are the normal case and say nothing at all.
    f.heldTransfers[0].ageDays = 3;
    expect(evaluateLedgerChecks(f, {}, NOW, HELD_FEEDS).keys).toEqual([]);
  });
```

Append to `shared/sync-core-stale-transit.test.ts`:

```ts
describe('runSyncCore — each feed\'s proven-alive time is stored for the held-transfer finding (1.65 C)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('stores aliveThrough: the later of the balance date and the newest transaction', async () => {
    const seed = seedOf([], {}, '2026-09-30T12:00:00Z');
    seed.accountSet!.accounts[1].transactions = [tx('s-1', '2026-10-18T12:00:00Z', '5.00', 'INTEREST PAID')];
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, {});
    const balances = await fh.store.getAccountBalances() as Record<string, { date: number; aliveThrough?: number }>;
    expect(balances['sfin-sav']).toMatchObject({ date: epoch('2026-09-30T12:00:00Z'), aliveThrough: epoch('2026-10-18T12:00:00Z') });
    expect(balances['sfin-chk'].aliveThrough).toBe(epoch('2026-10-19T12:00:00Z'));
  });
});
```

In `companion/src/ledger-facts.test.ts` ("finds unlinked cash transfers…") change the `heldTransfers` expectation to:

```ts
    // 1.65 C: with what "Not a transfer" and the reason need — the account, the bank day, the tx id, the direction.
    expect(f.heldTransfers).toEqual([{
      id: 'u3', description: 'PNC BANK', amount: 600, ageDays: 2, wfAccountId: 'sav', date: '2026-09-18', txId: 't3', direction: 'out',
    }]);
```

In `companion/src/daily-findings.test.ts`, add before "names a non-card account that differs from the bank…":

```ts
  it('names the feed that holds a transfer open, from what the sync stored (1.65 C)', async () => {
    const facts = cleanFacts();
    facts.heldTransfers = [{
      id: 'h1', description: 'WIRE TRANSFER TO ACME LLC', amount: 250, ageDays: 20,
      wfAccountId: 'wf-chk', date: '2026-09-19', txId: 'w-old', direction: 'out',
    }];
    const { deps } = makeDeps({
      account_mapping: JSON.stringify({ 'sfin-chk': 'wf-chk', 'sfin-sav': 'wf-sav' }),
      account_balances: JSON.stringify({
        'sfin-chk': { balance: 10, date: unixDaysAgo(0), aliveThrough: unixDaysAgo(0) },
        // Balance date current, but no transaction since before the leg's pairing deadline.
        'sfin-sav': { balance: 10, date: unixDaysAgo(18), aliveThrough: unixDaysAgo(18) },
      }),
      account_names: JSON.stringify({ 'sfin-chk': 'Checking', 'sfin-sav': 'Harbor Savings' }),
    }, facts);
    const found = await gatherFindings(deps, NOW, { recordLedgerChecks: false, ...healthy });
    const held = found.visible.find((f) => f.key === 'held-transfer:h1')!;
    expect(held.message).toContain("Harbor Savings's feed is behind");
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `nice npx vitest run --maxWorkers=2 shared/held-transfers.test.ts shared/ledger-checks.test.ts shared/sync-core-stale-transit.test.ts`
Expected: `Test Files 3 failed`, `2 failed | 31 passed (33)` — `Failed to resolve import "./held-transfers.js"`, the finding still says "a silent bank feed is holding it open" and is `once` (`expected [] …`), and `aliveThrough` is absent.
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/ledger-facts.test.ts src/daily-findings.test.ts)`
Expected: `2 failed | 27 passed (29)` — the facts lack the new fields; the message lacks the feed's name.

- [ ] **Step 3: Implement**

- `shared/sync-core.ts`: `AccountBalanceSnapshot.aliveThrough?: number` with a doc comment (1.65 C: the epoch this account's feed has proven itself alive through — the later of `date` and its newest datable transaction, exactly what the in-transit hold reads; lets the companion name the feed that holds a transfer open without a download). In the assignment: `aliveThrough: feedAliveEpoch.get(sfAccount.id) ?? sfAccount['balance-date'],`. (`checkBalancesOnly` keeps other fields with `...rest`, so a check-only run keeps it.)
- `shared/held-transfers.ts` (new; module doc: 1.65 C, issue #13; one judgement for the daily finding and the app's Checks; must not be imported by sync-core.ts — it imports it):
  - `judgeHeldTransfer`: `sfinId` = the first key of `feeds.mapping` whose value is `row.wfAccountId`; `txKey = sfinId && row.txId ? accountTxKey(sfinId, row.txId) : null`; `label` = `${row.description} · ${feeds.names[sfinId]}` when that name exists, else the description; `direction = row.direction ?? 'out'`. With no `feeds`, no `sfinId` or no `row.date`, return WITHOUT a `heldBy` key. Otherwise build, over every mapped SimpleFin id, `alive` (`aliveThrough`, else `date`, else 0 — finite numbers only) and `nameWords` (`accountNameWords(feeds.names[id] ?? '')`), and call `expiryHoldAccount(sfinId, Date.parse(bankDayInstant(row.date)) / 1000, mappedIds, alive, { nowSec: Math.floor(now.getTime() / 1000), legDescription: row.description, nameWords })`; `heldBy` = the holder's name (else its id), or `null`.
  - `heldTransferMessage`: head `${description} (${formatDollars(Math.abs(amount), 2)}) has waited ${ageDays} days for its other half`; then nothing (heldBy absent), ` — the next sync settles it` (null), or ` — ${heldBy}'s feed is behind, so it stays on hold`.
- `shared/ledger-checks.ts`: import from `./held-transfers.js`; `heldTransfers: HeldRow[]` (doc: 1.65 adds what "Not a transfer" and the reason need); delete the local `HELD_MIN_AGE_DAYS`; add the optional `feeds?: StoredFeeds` parameter (doc: absent, a held transfer cannot say why); the loop becomes: skip `ageDays < HELD_MIN_AGE_DAYS`; `h = judgeHeldTransfer(row, feeds, now)`; candidate key `held-transfer:${row.id}` (unchanged), `when: 'always'` (R7, with a comment: shown while held, because it now has a way out), message `heldTransferMessage(h)`, label `${short(h.description)} ${money(h.amount)} still in transit` (unchanged).
- `companion/src/ledger-facts.ts`: select also `a.account_id`, `UPPER(a.activity_type) t`, `substr(a.activity_date,1,10) d`; map to `{ id, description, amount, ageDays, wfAccountId: account_id, date: d, txId: txIdFromComment(notes), direction: t === 'TRANSFER_OUT' || t === 'WITHDRAWAL' ? 'out' : 'in' }` (`txIdFromComment` is already imported).
- `companion/src/daily-findings.ts`: `StoredAccountBalance.aliveThrough?: number` (doc); call `evaluateLedgerChecks(facts, seen, now, { mapping, balances, names: accountNames })` — all three are already read above.

- [ ] **Step 4: Run them to see them pass**

Run: `nice npx vitest run --maxWorkers=2 shared/held-transfers.test.ts shared/ledger-checks.test.ts shared/sync-core-stale-transit.test.ts` → `38 passed (38)`.
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/ledger-facts.test.ts src/daily-findings.test.ts)` → `29 passed (29)`.
Both again under `TZ=UTC` and `TZ=America/New_York` (prefix the command) — same counts.

- [ ] **Step 5: The exact balance snapshots**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core.test.ts` → `4 failed | 184 passed (188)` ("leaves a correctly-typed live pair (TRN-…) completely untouched on a heal" ×3, "measures drift per account with each leg's own sign": `toEqual` on `getAccountBalances()`). Add `aliveThrough: expect.any(Number)` after `fetchedAt: expect.any(Number)` on those four lines; rerun → `188 passed (188)`.

- [ ] **Step 6: Full gates once**

`npm run type-check` (clean); `nice npm --prefix companion run build` (clean); `nice npx vitest run --maxWorkers=2` → **3940 passed (181 files)**; `(cd companion && nice npx vitest run --maxWorkers=2)` → **1542 passed (69 files)**.

- [ ] **Step 7: Commit**

```bash
git add shared/sync-core.ts shared/held-transfers.ts shared/held-transfers.test.ts shared/ledger-checks.ts shared/ledger-checks.test.ts shared/sync-core-stale-transit.test.ts shared/sync-core.test.ts companion/src/ledger-facts.ts companion/src/ledger-facts.test.ts companion/src/daily-findings.ts companion/src/daily-findings.test.ts
git commit -m "C: the held-transfer finding names the feed that holds it, every day (issue #13)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: C — "Not a transfer" in Telegram

**Files:**
- Modify: `shared/self-check.ts` (`FindingFix`, ~86-92), `shared/sync-overrides.ts` (before `clearTxOverride`), `shared/ledger-checks.ts` (the held candidate)
- Modify: `companion/src/findings-menu.ts` (imports; `FIX` 32; `FindingsMenuDeps` 55; `FIX_BUTTON_TEXT` 60-63; the callback 129-152), `companion/src/index.ts` (import line 85; `createFindingsMenu({…})` ~3989)
- Test: `shared/ledger-checks.test.ts`, `shared/sync-core-stale-transit.test.ts` (append), `companion/src/findings-menu.test.ts`, `companion/src/daily-findings.test.ts`

**Interfaces:**
- Consumes: `HeldTransfer.txKey`, `.label`, `.direction` (Task 3).
- Produces:
  - `FindingFix` gains `| { kind: 'not-transfer'; txKey: string; label: string; description: string; amount: number; direction: 'in' | 'out' }` (doc: records `notTransfer` for this bank transaction after a confirm — the override the change log's Undo writes).
  - `export const notTransferEdit = (txKey: string, label: string, now: Date): SyncOverridesEdit` = `(o) => setTxOverride(o, txKey, 'notTransfer', now, { label })` (shared/sync-overrides.ts).
  - `FindingsMenuDeps.markNotTransfer(fix: Extract<FindingFix, { kind: 'not-transfer' }>, now: Date): Promise<void>`; `export function renderNotTransferConfirm(fix, handle: string): { text: string; keyboard: InlineKeyboard }` (companion/src/findings-menu.ts).

- [ ] **Step 1: Write the failing tests**

In `shared/ledger-checks.test.ts` import `accountTxKey` from `./transfers.js` and add, before the Task 3 held test:

```ts
  it('offers "Not a transfer" for the bank transaction when the stored feeds name it (1.65 C)', () => {
    const f = clean();
    f.heldTransfers = [{
      id: 'h1', description: 'WIRE TRANSFER TO ACME LLC', amount: 250, ageDays: 20,
      wfAccountId: 'wf-chk', date: '2026-08-31', txId: 'w-old', direction: 'out',
    }];
    expect(evaluateLedgerChecks(f, {}, NOW, HELD_FEEDS).findings[0].fix).toEqual({
      kind: 'not-transfer', txKey: accountTxKey('sfin-chk', 'w-old'), label: 'WIRE TRANSFER TO ACME LLC · Checking',
      description: 'WIRE TRANSFER TO ACME LLC', amount: 250, direction: 'out',
    });
    // Without the stored feeds there is no transaction to name: no fix.
    expect(evaluateLedgerChecks(f, {}, NOW).findings[0].fix).toBeUndefined();
  });
```

In `companion/src/daily-findings.test.ts` import `accountTxKey` from `../../shared/transfers.js` and end Task 3's test with:

```ts
    expect(held.fix).toEqual({
      kind: 'not-transfer', txKey: accountTxKey('sfin-chk', 'w-old'), label: 'WIRE TRANSFER TO ACME LLC · Checking',
      description: 'WIRE TRANSFER TO ACME LLC', amount: 250, direction: 'out',
    });
```

In `companion/src/findings-menu.test.ts`: import `SYNC_OVERRIDES_UNREADABLE_MESSAGE, SyncOverridesUnreadableError` from `../../shared/sync-overrides.js` and `accountTxKey` from `../../shared/transfers.js`; add `markNotTransfer: vi.fn(async () => {}),` to `makeDeps`; add the fixture before `failing`:

```ts
const held: SelfCheckFinding = {
  kind: 'ledger',
  severity: 'warning',
  key: 'held-transfer:ph-1',
  label: 'WIRE TRANSFER TO … $250.00 still in transit',
  message: "WIRE TRANSFER TO ACME LLC ($250.00) has waited 20 days for its other half — Harbor Savings's feed is behind, so it stays on hold",
  fix: {
    kind: 'not-transfer', txKey: accountTxKey('sfin-chk', 'w-old'), label: 'WIRE TRANSFER TO ACME LLC · Checking',
    description: 'WIRE TRANSFER TO ACME LLC', amount: 250, direction: 'out',
  },
};
```

and, inside `describe('findings-menu')`, at its end:

```ts
  describe('"Not a transfer" on a held transfer (1.65 C)', () => {
    const handle = findingHandle(held.key!);

    it('the detail screen offers it', async () => {
      const { deps } = makeDeps({ visible: [held], snoozed: [] });
      const ui = makeUi();
      await createFindingsMenu(deps).onCallback({ data: `cz:fx:d:${handle}`, chatId: 42 }, ui);
      expect(ui.edit).toHaveBeenCalledWith(expect.stringContaining("Harbor Savings's feed is behind"), {
        inline_keyboard: [
          [{ text: '✋ Not a transfer', callback_data: `cz:fx:f:${handle}` }],
          [{ text: '💤 Snooze 30 days', callback_data: `cz:fx:s:${handle}` }],
          [{ text: '‹ Back', callback_data: 'cz:fx:l' }],
        ],
      });
    });

    it('asks before it writes: a confirm screen, nothing written yet', async () => {
      const { deps } = makeDeps({ visible: [held], snoozed: [] });
      const ui = makeUi();
      await createFindingsMenu(deps).onCallback({ data: `cz:fx:f:${handle}`, chatId: 42 }, ui);
      expect(ui.edit).toHaveBeenCalledWith(
        'Count WIRE TRANSFER TO ACME LLC ($250.00) as spending and stop waiting for its other half? The next sync makes the change.',
        { inline_keyboard: [
          [{ text: '✋ Yes, not a transfer', callback_data: `cz:fx:n:${handle}` }],
          [{ text: '‹ Back', callback_data: `cz:fx:d:${handle}` }],
        ] },
      );
      expect(deps.markNotTransfer).not.toHaveBeenCalled();
      expect(deps.makeTransfer).not.toHaveBeenCalled();
      expect(deps.pickCategory).not.toHaveBeenCalled();
    });

    it('the confirm writes notTransfer for that transaction and shows the list again', async () => {
      const { deps } = makeDeps({ visible: [held], snoozed: [] });
      const ui = makeUi();
      await createFindingsMenu(deps).onCallback({ data: `cz:fx:n:${handle}`, chatId: 42 }, ui);
      expect(deps.markNotTransfer).toHaveBeenCalledWith(held.fix, NOW);
      expect(ui.edit).toHaveBeenCalledTimes(1);
      expect(ui.answer).toHaveBeenCalledWith('Done — the next sync counts it as spending');
    });

    it('a confirm for a finding that has since cleared writes nothing', async () => {
      const { deps } = makeDeps({ visible: [], snoozed: [] });
      const ui = makeUi();
      await createFindingsMenu(deps).onCallback({ data: `cz:fx:n:${handle}`, chatId: 42 }, ui);
      expect(deps.markNotTransfer).not.toHaveBeenCalled();
      expect(ui.answer).toHaveBeenCalledWith('That one is already sorted — refreshing.');
    });

    it('says so when the overrides cannot be read', async () => {
      const { deps } = makeDeps({ visible: [held], snoozed: [] });
      deps.markNotTransfer = vi.fn().mockRejectedValue(new SyncOverridesUnreadableError());
      const ui = makeUi();
      await createFindingsMenu(deps).onCallback({ data: `cz:fx:n:${handle}`, chatId: 42 }, ui);
      expect(ui.answer).toHaveBeenCalledWith(SYNC_OVERRIDES_UNREADABLE_MESSAGE);
      expect(ui.edit).not.toHaveBeenCalled();
    });
  });
```

In `shared/sync-core-stale-transit.test.ts` replace the `./sync-overrides.js` import with

```ts
import { evaluateLedgerChecks, type LedgerFacts } from './ledger-checks.js';
import {
  editSyncOverrides, emptySyncOverrides, notTransferEdit, parseSyncOverrides, setTxOverride, SYNC_OVERRIDES_SECRET_KEY,
} from './sync-overrides.js';
```

and append the spec's C acceptance test:

```ts
describe('"Not a transfer" on the held-transfer finding (1.65 C acceptance)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('writes notTransfer for that transaction, and the next sync makes the held row an ordinary WITHDRAWAL', async () => {
    const facts: LedgerFacts = {
      month: '2026-10', cardBalances: [], idleRefunds: [], incomeReimbursements: [], unlinkedTransfers: [], groupedNonTransfers: [],
      heldTransfers: [{ id: 'ph-1', description: WIRE, amount: 250, ageDays: 20, wfAccountId: 'wf-chk', date: '2026-09-29', txId: 'w-old', direction: 'out' }],
      needsReview: 0, categories: [], chronicallyOver: [], missingLegs: [], cardsOpenedInCredit: [],
    };
    const LAGGING = '2026-09-30T12:00:00Z';
    const feeds = {
      mapping: { 'sfin-chk': 'wf-chk', 'sfin-sav': 'wf-sav' },
      balances: { 'sfin-chk': { aliveThrough: epoch('2026-10-19T12:00:00Z') }, 'sfin-sav': { aliveThrough: epoch(LAGGING) } },
      names: { 'sfin-chk': 'Checking', 'sfin-sav': 'Harbor Savings' },
    };
    const fix = evaluateLedgerChecks(facts, {}, NOW, feeds).findings[0].fix;
    if (fix?.kind !== 'not-transfer') throw new Error('expected a "Not a transfer" fix');
    const secrets = new Map<string, string>();
    await editSyncOverrides(async (k) => secrets.get(k) ?? null, async (k, v) => { secrets.set(k, v); }, notTransferEdit(fix.txKey, fix.label, NOW), NOW);
    const parsed = parseSyncOverrides(secrets.get(SYNC_OVERRIDES_SECRET_KEY));
    if (parsed.kind !== 'ok') throw new Error('overrides not written');
    // The very entry the change log's Undo writes for a held leg.
    expect(parsed.overrides.tx[fix.txKey]).toEqual({ notTransfer: true, at: NOW.toISOString(), label: 'WIRE TRANSFER TO ACME LLC · Checking' });

    // The same lagging feed that held it: "Not a transfer" is the way out.
    const fh = createFakeHost(seedOf([placeholder('ph-1', 'w-old', '2026-09-29')], { syncOverrides: parsed.overrides }, LAGGING));
    await runSyncCore(fh.host, fh.store, {});
    expect(updatesFor(fh.saved, 'ph-1')).toEqual([expect.objectContaining({ activityType: 'WITHDRAWAL', comment: `${WIRE} · w-old` })]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `nice npx vitest run --maxWorkers=2 shared/ledger-checks.test.ts shared/sync-core-stale-transit.test.ts` → `2 failed | 33 passed (35)` (no `fix` on the finding: `expected undefined to deeply equal { kind: 'not-transfer', … }`, `expected a "Not a transfer" fix`).
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/findings-menu.test.ts src/daily-findings.test.ts)` → `6 failed | 23 passed (29)`.

- [ ] **Step 3: Implement**

- `shared/self-check.ts`: the new `FindingFix` member (Interfaces). Extend the type's doc comment: `not-transfer` is the one fix that writes from the menu — only the overrides document, only after a confirm, and both taps re-judge the findings first.
- `shared/sync-overrides.ts`: `notTransferEdit` with a doc comment (1.65 C: the override the change log's Undo writes for a held leg; R6).
- `shared/ledger-checks.ts`: the held candidate's finding gets `h.txKey ? { kind: 'not-transfer', txKey: h.txKey, label: h.label, description: h.description, amount: h.amount, direction: h.direction } : undefined` as its fix.
- `companion/src/findings-menu.ts`:
  - import `isUnreadableOverridesError, SYNC_OVERRIDES_UNREADABLE_MESSAGE` (shared/sync-overrides.js) and `formatDollars` (shared/telegram.js); `const NOT_TRANSFER = \`${FINDINGS_CALLBACK_PREFIX}n:\`` (the confirm); `'not-transfer': '✋ Not a transfer'` in `FIX_BUTTON_TEXT`; `markNotTransfer` in `FindingsMenuDeps`.
  - `renderNotTransferConfirm(fix, handle)`: text `escapeFindingText(\`Count ${fix.description} (${formatDollars(Math.abs(fix.amount), 2)}) as ${spending|money in} and stop waiting for its other half? The next sync makes the change.\`)` (`out` → `spending`, `in` → `money in`); keyboard `[[{ text: '✋ Yes, not a transfer', callback_data: NOT_TRANSFER + handle }], [{ text: '‹ Back', callback_data: DETAIL + handle }]]`.
  - `onCallback`: add `NOT_TRANSFER` to the prefix list. After the finding is found (so a cleared one gets `GONE_ANSWER` as today) and `const fix = finding.fix` (none → `ui.answer()`): on `NOT_TRANSFER` — answer nothing unless `fix.kind === 'not-transfer'`; `await deps.markNotTransfer(fix, deps.now())`; an `isUnreadableOverridesError` → `ui.answer(SYNC_OVERRIDES_UNREADABLE_MESSAGE)` and return (anything else rethrows into the existing catch); then `showList(ui, 'edit', \`Done — the next sync counts it as ${spending|money in}\`)`. On `FIX` with `fix.kind === 'not-transfer'`: `ui.edit(renderNotTransferConfirm(fix, handle))`, `ui.answer()`. `make-transfer` and `pick-category` are unchanged.
- `companion/src/index.ts`: add `editSyncOverrides, notTransferEdit` to the `../../shared/sync-overrides.js` import; in `createFindingsMenu({...})`:

```ts
    // 1.65 C: the override the change log's Undo writes, through the one re-reading writer.
    markNotTransfer: async (fix, now) => {
      await editSyncOverrides(
        (k) => wfClient.getAddonSecret('simplefin-sync', k),
        (k, v) => wfClient.setAddonSecret('simplefin-sync', k, v),
        notTransferEdit(fix.txKey, fix.label, now),
        now,
      );
    },
```

- [ ] **Step 4: Run them to see them pass**

Run: `nice npx vitest run --maxWorkers=2 shared/ledger-checks.test.ts shared/sync-core-stale-transit.test.ts` → `35 passed (35)`.
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/findings-menu.test.ts src/daily-findings.test.ts)` → `29 passed (29)`.

- [ ] **Step 5: Full gates once**

`npm run type-check`; `nice npm --prefix companion run build` (both clean); `nice npx vitest run --maxWorkers=2` → **3942 passed (181 files)**; `(cd companion && nice npx vitest run --maxWorkers=2)` → **1547 passed (69 files)**.

- [ ] **Step 6: Commit**

```bash
git add shared/self-check.ts shared/sync-overrides.ts shared/ledger-checks.ts shared/ledger-checks.test.ts shared/sync-core-stale-transit.test.ts companion/src/findings-menu.ts companion/src/findings-menu.test.ts companion/src/index.ts companion/src/daily-findings.test.ts
git commit -m "C: \"Not a transfer\" on a held transfer in Telegram, after a confirm

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: C — "Still in transit" and "Not a transfer" in Settings → Checks

**Files:**
- Modify: `shared/held-transfers.ts` (append), `shared/audit-snapshot.ts` (`AuditSnapshot`, `AuditResults`, `buildAuditSnapshot`'s `make`, `parseAuditSnapshot`), `companion/src/audit-facts.ts` (`runAudit`)
- Modify: `src/components/AuditViews.tsx` (before `ChecksCard`; `ChecksCard`), `src/utils/audit-fix.ts` (append), `src/tabs/SettingsTab.tsx` (import line 28; after `linkChecks` 117; the `<ChecksCard …>` ~478)
- Test: `shared/held-transfers.test.ts`, `shared/audit-snapshot.test.ts`, `companion/src/audit-facts.test.ts`; Create: `src/pages/held-transfers-app.test.tsx`

**Interfaces:**
- Consumes: `judgeHeldTransfer`, `HeldTransfer`, `StoredFeeds`, `HELD_MIN_AGE_DAYS` (Task 3); `notTransferEdit` (Task 4).
- Produces:
  - shared/held-transfers.ts: `export function heldAgeDays(date: string, now: Date): number` (whole days from the bank day to `now`'s LOCAL day, ledger-facts' SQL count); `export function heldFromLedger(ledger: AuditLedger | undefined, feeds: StoredFeeds | undefined, now: Date): HeldTransfer[] | undefined`.
  - shared/audit-snapshot.ts: `AuditSnapshot.held?: HeldTransfer[]`, `AuditResults.held?: HeldTransfer[]`.
  - src/components/AuditViews.tsx: `export const HELD_TITLE = 'Still in transit'`, `export const NOT_TRANSFER_BUTTON = 'Not a transfer'`, `export function HeldTransfersView(props: { held: readonly HeldTransfer[]; notTransfer?: (h: HeldTransfer) => Promise<string> })`; `ChecksCard` gains `notTransfer?: (h: HeldTransfer) => Promise<string>`.
  - src/utils/audit-fix.ts: `export const NOT_TRANSFER_FAILED = "Couldn't save that — nothing was changed."`; `export async function notTransferFromApp(store: Partial<Pick<SecretsStore, 'editSyncOverrides'>>, h: HeldTransfer, now: Date = new Date()): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

In `shared/held-transfers.test.ts` add `heldFromLedger` to the import, add `import type { AuditLedgerRow } from './audit-ledger.js';` and `import { IN_TRANSIT_COMMENT_PREFIX } from './sync-core.js';`, and append:

```ts
describe('heldFromLedger (1.65 C, the app\'s Checks)', () => {
  /** Local noon, so the day count is the same in every time zone the suite runs in. */
  const LOCAL_NOON = new Date(2026, 9, 19, 12, 0);
  const row = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
    id: 'ph-1', accountId: 'wf-chk', date: '2026-09-29', currency: 'USD', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', status: 'POSTED',
    absCents: 25000, group: '', assetId: '', external: true, phantomCash: false,
    notes: `${IN_TRANSIT_COMMENT_PREFIX}WIRE TRANSFER TO ACME LLC · w-old`, ...over,
  });

  it('lists every placeholder held 14 days or more, judged like the daily finding', () => {
    const held = heldFromLedger({ accounts: [], rows: [
      row({}),
      row({ id: 'young', date: '2026-10-10' }),
      row({ id: 'pending', notes: `${IN_TRANSIT_COMMENT_PREFIX}WIRE TRANSFER TO ACME LLC · w-p · pending` }),
      row({ id: 'plain', notes: 'CORNER COFFEE · c-1', rawType: 'WITHDRAWAL', type: 'WITHDRAWAL' }),
      row({ id: 'ph-in', rawType: 'CREDIT', type: 'CREDIT', absCents: 90000, notes: `${IN_TRANSIT_COMMENT_PREFIX}WIRE TRANSFER FROM ACME LLC · w-in` }),
    ] }, feeds('2026-09-30T12:00:00Z'), LOCAL_NOON);
    expect(held).toEqual([
      judgeHeldTransfer(WIRE, feeds('2026-09-30T12:00:00Z'), LOCAL_NOON),
      expect.objectContaining({ activityId: 'ph-in', description: 'WIRE TRANSFER FROM ACME LLC', amount: 900, ageDays: 20, direction: 'in', txKey: accountTxKey('sfin-chk', 'w-in') }),
    ]);
  });

  it('is unknown, not empty, when the ledger could not be read', () => {
    expect(heldFromLedger(undefined, feeds('2026-09-30T12:00:00Z'), LOCAL_NOON)).toBeUndefined();
  });
});
```

In `shared/audit-snapshot.test.ts`, before `describe('auditSnapshotStatus')`:

```ts
describe('the held transfers in the snapshot (1.65 C)', () => {
  const HELD = {
    activityId: 'ph-1', description: 'WIRE TRANSFER TO ACME LLC', amount: 250, ageDays: 20, direction: 'out' as const,
    heldBy: 'Harbor Savings', txKey: 'sfin-chk\u0000w-old', label: 'WIRE TRANSFER TO ACME LLC · Checking',
  };
  const results = (held?: unknown): AuditResults => ({
    balances: { accounts: [], notes: [] },
    headline: { month: '2026-10', reportCents: null, wealthfolioCents: null, unexplainedCents: null, reasons: null, notes: [] },
    health: { issues: [], notes: [] },
    ...(held === undefined ? {} : { held: held as AuditResults['held'] }),
  });

  it('carries them to the app, and an older companion\'s snapshot simply has none', () => {
    const read = parseAuditSnapshot(JSON.stringify(buildAuditSnapshot(results([HELD, { ...HELD, activityId: 'ph-2', txKey: null, heldBy: null }]), NOW)));
    expect(read.kind === 'ok' && read.snapshot.held).toEqual([HELD, { ...HELD, activityId: 'ph-2', txKey: null, heldBy: null }]);
    const old = parseAuditSnapshot(JSON.stringify(buildAuditSnapshot(results(), NOW)));
    expect(old.kind === 'ok' && 'held' in old.snapshot).toBe(false);
  });

  it('is corrupt when a held transfer is malformed', () => {
    for (const bad of [{}, [{ ...HELD, amount: '250' }], [{ ...HELD, direction: 'sideways' }], [{ ...HELD, txKey: 7 }], [{ ...HELD, heldBy: 3 }]]) {
      const snapshot = { ...buildAuditSnapshot(results(), NOW)!, held: bad };
      expect(parseAuditSnapshot(JSON.stringify(snapshot)).kind).toBe('corrupt');
    }
  });
});
```

In `companion/src/audit-facts.test.ts` (`describe('runAudit')`), before "keeps cash compared when only the database is down…":

```ts
  it('lists the transfers held past 14 days for the app, with the feed that holds each (1.65 C)', async () => {
    const placeholder = row({
      id: 'ph-1', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', absCents: 25000, date: '2026-09-20', external: true,
      notes: '↔️ In-transit transfer · WIRE TRANSFER TO ACME LLC · w-old',
    });
    const out = await runAudit(readers({ ledger: () => ({ ...LEDGER, rows: [...LEDGER.rows, placeholder] }) }), NOW);
    expect(out.held).toEqual([expect.objectContaining({
      activityId: 'ph-1', description: 'WIRE TRANSFER TO ACME LLC', amount: 250, ageDays: 23, direction: 'out',
      txKey: 'sfin-chk\u0000w-old', label: 'WIRE TRANSFER TO ACME LLC · PNC Checking', heldBy: null,
    })]);
    expect((await runAudit(readers({ ledger: boom }), NOW)).held).toBeUndefined();
  });
```

Create `src/pages/held-transfers-app.test.tsx`: copy the three `vi.mock(...)` blocks (`recharts`, `@wealthfolio/ui/chart`, `../utils/sync`) verbatim from the top of `src/pages/audit-fix-app.test.tsx`, then:

```tsx
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SyncPage } from './SyncPage';
import { makeProps } from './test-props';
import { buildAuditSnapshot, parseAuditSnapshot } from '../../shared/audit-snapshot';
import type { HeldTransfer } from '../../shared/held-transfers';
import { emptySyncOverrides, SYNC_OVERRIDES_UNREADABLE_MESSAGE, SyncOverridesUnreadableError, type SyncOverridesEdit } from '../../shared/sync-overrides';
import { accountTxKey } from '../../shared/transfers';

// (the three vi.mock blocks from audit-fix-app.test.tsx go here)

const AT = new Date(2026, 9, 19, 10, 0);
const HELD: HeldTransfer = {
  activityId: 'ph-1', description: 'WIRE TRANSFER TO ACME LLC', amount: 250, ageDays: 20, direction: 'out',
  heldBy: 'Harbor Savings', txKey: accountTxKey('sfin-2', 'w-old'), label: 'WIRE TRANSFER TO ACME LLC · Spend',
};
const read = (held: HeldTransfer[]) => parseAuditSnapshot(JSON.stringify(buildAuditSnapshot({
  balances: { accounts: [], notes: [] },
  headline: { month: '2026-10', reportCents: null, wealthfolioCents: null, unexplainedCents: null, reasons: null, notes: [] },
  health: { issues: [], notes: [] },
  held,
}, AT)));

function settingsWith(held: HeldTransfer[]) {
  const props = makeProps();
  props.store.getUiState = vi.fn(async () => ({ activeTab: 'settings' }));
  props.store.getOpenCards = vi.fn(async () => ({ checks: true }));
  props.store.getCompanionVersion = vi.fn(async () => '1.65.0');
  props.store.getAuditSnapshot = vi.fn(async () => read(held));
  return props;
}

describe('Settings → Checks → Not a transfer (1.65 C)', () => {
  it('lists a transfer still in transit with why, and "Not a transfer" records notTransfer for it', async () => {
    const props = settingsWith([HELD]);
    let written = emptySyncOverrides();
    props.store.editSyncOverrides = vi.fn(async (edit: SyncOverridesEdit) => (written = edit(written)));
    render(<SyncPage {...props} />);
    expect(await screen.findByText('Still in transit')).toBeInTheDocument();
    expect(screen.getByText("WIRE TRANSFER TO ACME LLC ($250.00) has waited 20 days for its other half — Harbor Savings's feed is behind, so it stays on hold")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not a transfer' }));
    expect(await screen.findByText('Saved — the next sync counts it as spending.')).toBeInTheDocument();
    expect(written.tx[HELD.txKey!]).toMatchObject({ notTransfer: true, label: 'WIRE TRANSFER TO ACME LLC · Spend' });
    expect(screen.queryByRole('button', { name: 'Not a transfer' })).toBeNull();
  });

  it('says so when the overrides cannot be read', async () => {
    const props = settingsWith([HELD]);
    props.store.editSyncOverrides = vi.fn(async () => { throw new SyncOverridesUnreadableError(); });
    render(<SyncPage {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not a transfer' }));
    expect(await screen.findByText(SYNC_OVERRIDES_UNREADABLE_MESSAGE)).toBeInTheDocument();
  });

  it('offers no button for a row with no bank transaction to name, or on a store that cannot write overrides', async () => {
    const props = settingsWith([{ ...HELD, txKey: null }]);
    props.store.editSyncOverrides = vi.fn();
    const { unmount } = render(<SyncPage {...props} />);
    expect(await screen.findByText('Still in transit')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not a transfer' })).toBeNull();
    unmount();
    const older = settingsWith([HELD]);
    delete (older.store as { editSyncOverrides?: unknown }).editSyncOverrides;
    render(<SyncPage {...older} />);
    expect(await screen.findByText('Still in transit')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not a transfer' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `nice npx vitest run --maxWorkers=2 shared/held-transfers.test.ts shared/audit-snapshot.test.ts src/pages/held-transfers-app.test.tsx` → `Test Files 3 failed`, `7 failed | 24 passed (31)` (`heldFromLedger is not a function` ×2; `held` dropped / not validated ×2; no "Still in transit" ×3).
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/audit-facts.test.ts)` → `1 failed | 30 passed (31)`.

- [ ] **Step 3: Implement**

- `shared/held-transfers.ts`: import `isPendingNote, isPlaceholderNote, type AuditLedger` (./audit-ledger.js) and `descriptionFromComment, txIdFromComment` (./sync-core.js). `heldAgeDays`: `Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.parse(\`${date}T00:00:00Z\`)) / 86_400_000)`. `heldFromLedger`: undefined for no ledger; otherwise every row with a placeholder note that is not pending and whose `heldAgeDays` ≥ `HELD_MIN_AGE_DAYS`, through `judgeHeldTransfer({ id, description: descriptionFromComment(notes), amount: absCents / 100, ageDays, wfAccountId: accountId, date, txId: txIdFromComment(notes), direction: rawType === 'TRANSFER_OUT' || rawType === 'WITHDRAWAL' ? 'out' : 'in' }, feeds, now)`, in ledger order.
- `shared/audit-snapshot.ts`: import `type HeldTransfer`; the two optional fields (doc: 1.65 C; absent from an older companion or when the ledger could not be read); `make` spreads `...(results.held ? { held: results.held } : {})` (no trimming — personal scale; see follow-ups); `parseAuditSnapshot`: when `v.held !== undefined` it must be an array whose every entry passes `goodHeld` — an object with string `activityId`, `description`, `label`; numeric `amount`, `ageDays`; `direction` `'in'|'out'`; `txKey` string or null; `heldBy` absent, null or string — else `corrupt`.
- `companion/src/audit-facts.ts`: in `runAudit`, `const held = heldFromLedger(ledger, balanceFacts.mapping ? { mapping: balanceFacts.mapping, balances: balanceFacts.balances ?? {}, names: balanceFacts.names ?? {} } : undefined, now);` and `...(held ? { held } : {})` in the result.
- `src/utils/audit-fix.ts`: `notTransferFromApp` — `NOT_TRANSFER_FAILED` when `!h.txKey || !store.editSyncOverrides`; otherwise `await store.editSyncOverrides(notTransferEdit(h.txKey, h.label, now))` and return `Saved — the next sync counts it as ${h.direction === 'out' ? 'spending' : 'money in'}.`; a throw → `SYNC_OVERRIDES_UNREADABLE_MESSAGE` when `isUnreadableOverridesError(err)`, else `NOT_TRANSFER_FAILED`. No write lock: it writes the overrides document only, which the sync reads at its start (doc comment).
- `src/components/AuditViews.tsx`: `HeldTransfersView` — local state (busy, done ids, status); a `sfin-audit-body sfin-audit-held` block with `HELD_TITLE` as `sfin-audit-head`, a `sfin-audit-issues` list with one `sfin-audit-issue` per row showing `heldTransferMessage(h)` (in an element with `id={\`sfin-held-${h.activityId}\`}`), and — when `notTransfer` is given, `h.txKey` is set and the row is not done — a ghost `Button` `NOT_TRANSFER_BUTTON` (`disabled`/`aria-busy` while busy, `aria-describedby` the message). On click: await `notTransfer(h)`, show the returned line in a `role="status"` line (mounted whenever `notTransfer` is given), and mark the row done when the line starts with `Saved`. Text only, no emoji. `ChecksCard` takes `notTransfer` and renders `<HeldTransfersView held={…} notTransfer={notTransfer} />` after `HealthView` when the snapshot is ok and `held` is non-empty.
- `src/tabs/SettingsTab.tsx`: import `notTransferFromApp` (with `linkFromApp`) and `type HeldTransfer`; `const notTransfer = useCallback((h: HeldTransfer) => notTransferFromApp(store, h), [store]);` beside `linkChecks`; pass `notTransfer={typeof store.editSyncOverrides === 'function' ? notTransfer : undefined}` to `ChecksCard` (an older store gets no button — the same guard `removeOverride` uses).

- [ ] **Step 4: Run them to see them pass**

Run: `nice npx vitest run --maxWorkers=2 shared/held-transfers.test.ts shared/audit-snapshot.test.ts src/pages/held-transfers-app.test.tsx` → `31 passed (31)`.
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/audit-facts.test.ts)` → `31 passed (31)`.
Both again under `TZ=UTC` and `TZ=America/New_York` — same counts.

- [ ] **Step 5: Full gates once**

`npm run type-check`; `nice npm --prefix companion run build` (both clean); `nice npx vitest run --maxWorkers=2` → **3949 passed (182 files)** (includes src/pages/copy-policy.test.tsx); `(cd companion && nice npx vitest run --maxWorkers=2)` → **1548 passed (69 files)**.

- [ ] **Step 6: Commit**

```bash
git add shared/held-transfers.ts shared/held-transfers.test.ts shared/audit-snapshot.ts shared/audit-snapshot.test.ts companion/src/audit-facts.ts companion/src/audit-facts.test.ts src/components/AuditViews.tsx src/utils/audit-fix.ts src/tabs/SettingsTab.tsx src/pages/held-transfers-app.test.tsx
git commit -m "C: Settings → Checks lists transfers still in transit, with \"Not a transfer\"

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Docs — CHANGELOG and follow-ups §21

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`), `docs/superpowers/follow-ups.md` (new §21 before `## Reference: name mismatches…`)

**Interfaces:** none.

- [ ] **Step 1: CHANGELOG**

Under `## [Unreleased]` (no version heading — R8), in the file's voice:

```markdown
### Changed
- **A wire or online transfer to someone else counts as spending from the
  start** (issue #13). Money out of a bank account worded only "wire
  transfer", "online transfer", "bank transfer" or "member transfer" was held
  as a transfer waiting for an other half that never came. It is now an
  ordinary withdrawal unless its text names another connected account or
  matches a transfer wording the companion learned. A transfer between your
  own accounts still links when its other half arrives within 5 days. Money
  in, the "PNC Bank" and "Capital One transfer" wordings, cards and your
  rules are unchanged.
- **"Still in transit" says why, every day, and offers a way out.** A
  transfer held more than 14 days names the connected account whose feed is
  behind (or says the next sync settles it), shows in the daily findings
  every day until it settles, and offers **Not a transfer** — in Telegram
  after a confirm, and in Settings → Checks, which now lists these
  transfers. It writes the same override the change log's Undo writes.

### Fixed
- **A transfer still waiting after 10 days settles even when the bank no
  longer sends it** (issue #13). The give-up only ran on rows in the current
  download, so a leg a lagging feed held past the 14-day re-download window
  stayed "In-transit" forever. Every sync now settles stored placeholders
  outside the download exactly as it settles those inside: ordinary money in
  or out, marked Needs review, unless a connected feed that has not caught
  up still holds it.
```

- [ ] **Step 2: Follow-ups §21**

```markdown
## 21. In-transit rows always settle; generic wording needs corroboration (2026-10-19, plan `2026-10-19-in-transit-expiry-and-generic-wording.md`)

- **The expiry has no Undo.** A settled placeholder logs the in-feed expiry's
  own entry ("Stopped waiting for the other half…"), which is not undoable:
  there is no "it is a transfer after all" override. The entry written when
  the row was first held keeps its Undo (`notTransfer`).
- **An expired row keeps `flow.is_external: true`**, in-feed and out alike:
  an update that omits metadata leaves it. Nothing reads it on a
  non-transfer row; if one ever does, clear it in the expiry write (both
  paths at once).
- **A placeholder older than its account's newest 500 rows is reached by
  neither writer** — both read a 500-row recent page (R3).
- **The first 1.65 sync retypes a young generic-wording placeholder** to a
  withdrawal and logs it as "No other half arrived within 10 days" — a
  one-time, wrongly worded entry.
- **The finding's reason reads account names without the institution** (the
  sync also uses the org name), so under the 21-day dead-feed rule a leg
  that names only the institution can read "the next sync settles it" while
  the sync still holds it.
- **Home's "Checks: N to look at" counts Health only**; held transfers show
  once Checks is opened. The app's list is the companion's last snapshot, so
  a "Not a transfer" there shows after the next companion sync.
```

- [ ] **Step 3: The four gates, once, on the finished branch**

`nice npx vitest run --maxWorkers=2` → **3949 passed (182 files)**; `(cd companion && nice npx vitest run --maxWorkers=2)` → **1548 passed (69 files)**; `npm run type-check` → exit 0; `nice npm --prefix companion run build` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/superpowers/follow-ups.md
git commit -m "Docs: 1.65 in CHANGELOG [Unreleased] and follow-ups §21

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Verification record (scratch replay of this plan at 8813a13)

| After | Root (`npm test`) | Companion | type-check / build |
| --- | --- | --- | --- |
| baseline | 3915 (178 files) | 1541 (69) | clean / clean |
| Task 1 (B) | 3924 (179) | 1541 | clean |
| Task 2 (A) | 3934 (180) | 1541 | clean |
| Task 3 (C judgement) | 3940 (181) | 1542 | clean / clean |
| Task 4 (C Telegram) | 3942 (181) | 1547 | clean / clean |
| Task 5 (C app) | 3949 (182) | 1548 | clean / clean |
| Task 6 (docs) | 3949 (182) | 1548 | exit 0 / exit 0 |

The Task 3 and Task 5 files also passed under `TZ=UTC` and `TZ=America/New_York`; Tasks 1–2's sync files too.
