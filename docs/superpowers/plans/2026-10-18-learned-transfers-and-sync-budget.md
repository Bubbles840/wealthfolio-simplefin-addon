# Learned transfer names, every account checked on Sync, a SimpleFin budget — Implementation Plan (1.64.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A transfer between Nick's own accounts is held as a transfer whichever half posts first once its bank wording has been seen linked (A); a manual Sync gives every account, cards included, a real verdict (B); and SimpleFin is never asked more than 20 times a day or twice within 5 minutes, by anyone (C).

**Architecture:** One sign table (`typeCashSign`, shared/audit-ledger.ts) signs both card totals: the app's (`postedLedgerTotal` over a card's whole `activities.search` history) and the companion's SQL (`cashSignSql`). The companion learns transfer names from the database (`learnTransferNames` over `getNativeAuditLedger`) and publishes `transfer_names`; the sync core types a matching cash row TRANSFER_IN/OUT (`learnedTransferType`) where 1.63's bank-first rule is decided, and the existing in-transit path does the rest. After its saves, the core asks the new optional `host.postedLedgerTotals` for every account the valuations did not cover and fills a "not checked" badge (`badgeVerdict`). A new shared module, shared/simplefin-budget.ts, keeps the `simplefin_requests` record and decides every SimpleFin call before it is sent; inside the 5-minute gap a manual run calls `checkBalancesOnly` instead of downloading.

**Tech Stack:** TypeScript; vitest (root project: jsdom, `src/` + `shared/`; companion project: node, `companion/src/`); the sync core's fake host (`shared/fake-host.ts`); `node:sqlite` in companion tests.

**Spec:** `docs/superpowers/specs/2026-10-18-learned-transfers-and-sync-budget-design.md` (approved by Nick 2026-10-18, committed at 70d8e8a). Sections A, B, C (with C5, C6), the Rulings table R1–R18 and the Tests section bind this plan; read all of them before starting a task.

**Target tree:** this repo, branch `feat/1.64` at 70d8e8a (9d194d6, the holdings local-day fix, is already on it — do not redo it). Every block below was applied task by task to a scratch clone of that commit; every FAIL/PASS count was read off that replay (each task's tests run against the previous task's commit, then against its own).

**Execution:** subagent-driven development — one implementer per task, one reviewer per task, tasks in order (each consumes the ones before).

## Deviations and readings (decided — do not "fix")

The spec leaves these open, or the code forces them; each is the closest faithful version.

1. **The baseline was not green.** 9d194d6 moved the holdings snapshot to the local day and fixed `shared/holdings.test.ts`, but `shared/sync-core.test.ts`'s `brokerageSeed` still stamps midnight UTC, so that file has 1 failure west of UTC (it passes under `TZ=UTC`). Task 1 fixes the test only.
2. **Task order.** The sign table comes before learning (Task 2), because learning reads each leg's direction from `typeCashSign`.
3. **"Once at startup" (A4)** is the startup sync's own call: `runCompanionSync` publishes the names before `runSyncCore`, interval skip or not, and the companion runs a sync at startup. No second call.
4. **Learning reads the whole ledger** through `getNativeAuditLedger` (effective type, group, notes), filtered to 365 days in TypeScript. It publishes nothing — the previous list stays — when the database or the overrides document cannot be read.
5. **A `notTransfer` block covers both directions** of that signature on that account (A3: "any row with that signature on that account").
6. **R13 in code:** `keepPayback` is decided from `builtIn` (the bank text alone). Whether a row's STORED form is a payback (`CREDIT` + `REIMBURSEMENT`) is read lazily (`fetchExistingRows`, once per account) only when a learned name matches a money-in row; such a row is not learned-typed and not a pairing candidate. When that read fails the row is simply not learned-typed (today's typing) and pairs as today.
7. **Who reads card totals.** The core asks any host that has `postedLedgerTotals`. The add-on host answers only when built with `fullCardHistory` (runSync passes `!!opts.manual`, R7); the companion always answers, live-only.
8. **The after-save total fills only a badge the run left unchecked** (`measured !== true`), for accounts the valuations read did not cover (in practice cards), and only when that read worked. A before-save verdict that was measured stands.
9. **B3 applies to the after-save total and to check-only runs**, not to the before-save drift gate: R15 keeps alerts and writes on "today's conditions".
10. **The bank figures a check-only run needs** are the existing `account_balances` snapshot (`balance`, `date`), plus a new `fetchedAt` (ms the producing request was sent). R16 per account: compared only when `fetchedAt ≥` the newest recorded request. A snapshot without `fetchedAt` (an older writer) is "not checked".
11. **A check-only run is badge-only** like B2 (no alert, no correction, no episode change), keeps the cash rules of the main path (no stored pending row; legacy asset-backed TRANSFER_OUT legs netted out) and drops a stale baseline-fix offer.
12. **Copy the spec does not give** (all ≤ 80 characters): `Couldn't read the SimpleFin request log — nothing was downloaded.`; `SimpleFin was asked 3 min ago — this scheduled sync was skipped.`; `Balances not checked — the last download is still being saved.` (check-only with nothing comparable, R16).
13. **Fail closed, both ways.** A record that cannot be read OR written blocks the call. A corrupt record blocks that one call and is reset to `[]` (R8: "one blocked sync").
14. **Budget before gap.** A manual action with the day's 20 used is refused even inside the 5-minute gap (Nick: "block it outright").
15. **A scheduled run inside the gap** is skipped with a status line (the spec's C3 table is silent on it). Setup and Refresh accounts ignore the gap (rare, deliberate); the automatic backfill obeys it.
16. **"Next sync at"** is when the request holding the window at the limit leaves it — the spec's "oldest counted request" at exactly 20, later when Setup used the headroom.
17. **A request stamped in the future counts** (the other writer's clock may run ahead); only requests older than 24 hours drop out.
18. **`/sync` stays forced** (its 30-day fetch window is a non-goal to change) and becomes `manual`.
19. **Setup asks the budget before claiming the one-time token**, so a refusal costs nothing.
20. **Reset clears `transfer_names`** (the companion recomputes it) **but not `simplefin_requests`** (SimpleFin keeps counting).
21. **`badgeVerdict` compares the cent-rounded difference with $1** (the main path compares the unrounded one); the two can differ only within half a cent of $1.00.
22. **"Sync anyway" no longer exists (C6),** so the spec's "21st download refused for … 'Sync anyway'" case is the manual one; `/sync` is covered as manual + forced.

## Global Constraints

- **Rulings R1–R18 and the spec's Tests section are binding.** Do not re-open them.
- **Machine load (the owner's laptop overheats):** every vitest run is `nice npx vitest run --maxWorkers=2 <files>` from the repo root, or `(cd companion && nice npx vitest run --maxWorkers=2 <files>)` — never `--root`. Run the task's files during its steps; run the FULL suites at most once per task (its last step). Never two suites at once.
- **Gates:** `npm test` (root), `(cd companion && npx vitest run)`, `npm run type-check`, `nice npm --prefix companion run build` — the test gates in the `nice … --maxWorkers=2` form above.
- **Dates:** tests pin them — `now` passed explicitly to pure functions; sync tests `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(...)`. Anything about a local calendar day or a clock time must pass in any time zone: run those files under BOTH `TZ=UTC` and `TZ=America/New_York` (Tasks 1, 7, 9 say which).
- **Privacy (the repo is public):** no real account numbers, card numbers, reference numbers, real names or real amounts beyond what the spec quotes. Neutral ids (`sfin-spend`, `wf-citi`, …), account names without numbers, descriptors only as the spec quotes them (zeros where a reference is needed: `XXXXXX0000`, `TRN-000`).
- **Style:** match the surrounding code — long WHY comments with live evidence (dates, descriptors), plain American English, small pure helpers exported for tests. UI one-liners ≤ ~80 characters, plain words.
- **Commits:** `git add` explicit paths only (`node_modules` may be symlinks); every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **No version bump, no release** (R11). Docs go under CHANGELOG `## [Unreleased]` and a new follow-ups section (§20).
- **Two writers:** every new store method is optional on `SyncStore`/`SyncHost` and optional-called, so an older host or a test double keeps working.

## Review Focus

The five inputs most likely to bite that the spec does not spell out, each pinned by a test in its owning task:

1. **Mixed versions during the upgrade** (a 1.64 app beside a 1.63 companion, or the reverse): a balance snapshot written without `fetchedAt` must read "not checked" on a check-only Sync, never "in sync" (Task 6, "never calls a snapshot written without fetchedAt … in sync").
2. **A payback Nick filed (`asReimbursement`) whose wording is also a learned name** stays a CREDIT marked REIMBURSEMENT, never a held transfer (Task 4, "a payback the person filed …").
3. **A card with more than 500 activities** is totalled over every page, not the recent one (Task 2, "pages 500 at a time until a short page").
4. **The other writer's clock runs a minute ahead:** its request still counts toward the 20 and the gap (Task 7, "counts one the other writer stamped a little ahead").
5. **Sync pressed while the other writer's download is mid-run:** "not checked", never a comparison against a half-updated ledger (Task 6, R16 test).

## File map

| File | Change |
| --- | --- |
| `shared/sync-core.test.ts` | noon `balance-date` in `brokerageSeed` (Task 1); `fetchedAt` in two exact-shape snapshot assertions (Task 6) |
| `shared/audit-ledger.ts` | `typeCashSign`, `cashSignSql`; `cashEffectCents` delegates (Task 2) |
| `shared/ledger-total.ts` (new) | `postedLedgerTotal` (Task 2) |
| `shared/sync-host.ts` | `SyncHost.postedLedgerTotals?` (Task 2); `SyncStore.getTransferNames?` (Task 4); `getSimplefinRequests?`/`setSimplefinRequests?` (Task 7) |
| `src/utils/addon-host.ts` | `fullCardHistory` option, `postedLedgerTotals` paging (Task 2) |
| `companion/src/sqlite-native.ts` | effective type in `getNativeAccountBalances` (Task 2); `nativeDbUris`, `liveOnly` (Task 5) |
| `shared/transfer-names.ts` (new) | key, types, `transferSignature`, `isDistinctiveSignature`, `parseTransferNames` (Task 3); `learnedNameKeys`, `learnedTransferType` (Task 4) |
| `shared/learn-transfer-names.ts` (new) | `noteSignature`, `learnTransferNames` (Task 3) |
| `companion/src/transfer-names.ts` (new) | `publishTransferNames` (Task 3) |
| `companion/src/index.ts` | publish before the sync (Task 3); `manual`, `/sync` one-liner, `/status` count (Task 8) |
| `shared/sync-core.ts` | learned typing + R13 (Task 4); `manual`, `badgeVerdict`, after-save badge (Task 5); `fetchedAt`, `checkBalancesOnly` (Task 6); budget gate, `download`, interval for scheduled only (Task 7) |
| `shared/fake-host.ts` | `transferNames` (Task 4), `cardTotals` (Task 5), `requestLog` (Task 7) seeds |
| `src/utils/secrets.ts`, `companion/src/rest-host.ts` | store getters (Tasks 4, 7); `RestSyncHost.postedLedgerTotals` (Task 5); `AccountBalanceInfo.fetchedAt` (Task 6) |
| `src/utils/sync.ts`, `src/pages/SyncPage.tsx` | `manual` → `fullCardHistory` (Task 5); notices, count, no "Sync anyway", backfill gate (Task 9) |
| `shared/simplefin-budget.ts` (new) | record, decision, lines (Task 7); `directCallLine` (Task 9) |
| `shared/telegram-commands.ts` | `formatSyncSkipReply`, `/status` count (Task 8) |
| `src/pages/SetupPage.tsx`, `src/tabs/SettingsTab.tsx`, `src/components/SyncStatus.tsx`, `src/components/ui.tsx` | Task 9 |
| `CHANGELOG.md`, `docs/superpowers/follow-ups.md` | Task 10 |

---

### Task 1: Baseline — the holdings test the local-day fix missed

**Files:**
- Modify: `shared/sync-core.test.ts` (`brokerageSeed`, inside `describe('holdings snapshots for investment accounts')`)

**Interfaces:** none.

- [ ] **Step 1: See it fail west of UTC**

Run: `TZ=America/New_York nice npx vitest run --maxWorkers=2 shared/sync-core.test.ts`
Expected: `1 failed | 187 passed (188)` — "hands the mapped account one snapshot…" receives `date: '2026-09-11'`. (Do not use `-t` on this file: the holdings tests rely on an earlier test shrinking `VALUATION_POLL` and time out alone.)

- [ ] **Step 2: Pin a noon timestamp**

Replace `'balance-date': 1789171200,` in `brokerageSeed` with:

```ts
      // Noon UTC: the snapshot takes the LOCAL day of this instant (9d194d6),
      // and noon is 2026-09-12 in every zone from UTC−11 to UTC+11. Midnight
      // UTC was the 11th anywhere west of Greenwich.
      'balance-date': 1789214400, // 2026-09-12T12:00Z
```

- [ ] **Step 3: Verify in both zones**

Run: `TZ=America/New_York nice npx vitest run --maxWorkers=2 shared/sync-core.test.ts` and the same with `TZ=UTC`.
Expected: `188 passed (188)` both times.

- [ ] **Step 4: Full suites**

Run the root suite. Expected: `170 passed (170)` files, `3794 passed (3794)` tests. (Companion untouched: `67` files, `1526` tests.)

- [ ] **Step 5: Commit**

```bash
git add shared/sync-core.test.ts
git commit -m "Tests: the holdings snapshot test pins a noon timestamp, so it passes west of UTC

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: One sign table for both card totals; the app totals a card from its whole history (B1, R14)

**Files:**
- Modify: `shared/audit-ledger.ts` (around `cashEffectCents`, ~line 64–78)
- Create: `shared/ledger-total.ts`
- Modify: `shared/sync-host.ts` (`SyncHost`, after `ledgerBalances?`)
- Modify: `src/utils/addon-host.ts` (constructor, new method, two constants above the class)
- Modify: `companion/src/sqlite-native.ts` (`getNativeAccountBalances`, ~line 264–335, and its doc comment)
- Test: `shared/ledger-total.test.ts` (new), `src/utils/addon-host.test.ts`, `companion/src/ledger-sign-agreement.test.ts` (new), `companion/src/sqlite-native.test.ts`

**Interfaces:**
- Consumes: `PLUS`/`MINUS` sets in shared/audit-ledger.ts; `IN_TRANSIT_COMMENT_PREFIX` (shared/reconcile.ts); `PENDING_SUFFIX` (shared/sync-core.ts); `fromSearchRow` (src/utils/addon-host.ts); `hasActivityTypeOverride` (companion/src/sqlite-native.ts, file-local).
- Produces:
  - `export function typeCashSign(type: string, accountType: string): -1 | 0 | 1` — case-insensitive; card INTEREST is −1.
  - `export function cashSignSql(typeExpr: string, accountTypeExpr: string): string` — the same table as a SQL `CASE`, over already upper-cased expressions.
  - `cashEffectCents` unchanged in behavior (`typeCashSign(row.rawType, accountType) * row.absCents`, `0` for sign 0).
  - `export interface LedgerTotalRow { activityType: string; amount: unknown; comment?: string | null }` and `export function postedLedgerTotal(rows: ReadonlyArray<LedgerTotalRow>, accountType: string): number | null` — dollars; pending (`comment` ends with `PENDING_SUFFIX`) skipped; non-numeric amount skipped; `null` when any comment starts with `IN_TRANSIT_COMMENT_PREFIX`. `HostActivity` satisfies `LedgerTotalRow`.
  - `SyncHost.postedLedgerTotals?(accounts: ReadonlyArray<{ wfAccountId: string; accountType: string }>): Promise<Map<string, number>>` — omitted account = "not checked".
  - `new AddonSyncHost(ctx, { cardTransferOut?, log?, fullCardHistory?: boolean })`; its `postedLedgerTotals` returns an empty map unless `fullCardHistory`.

- [ ] **Step 1: Write the failing tests**

Create `shared/ledger-total.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { cashEffectCents, typeCashSign } from './audit-ledger.js';
import { postedLedgerTotal } from './ledger-total.js';
import { IN_TRANSIT_COMMENT_PREFIX, PENDING_SUFFIX } from './sync-core.js';

describe('typeCashSign — the one sign table (R14)', () => {
  it('signs money in, money out and the types that move no cash', () => {
    for (const t of ['DEPOSIT', 'CREDIT', 'TRANSFER_IN', 'DIVIDEND', 'INTEREST', 'SELL']) expect(typeCashSign(t, 'CASH')).toBe(1);
    for (const t of ['WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX', 'BUY']) expect(typeCashSign(t, 'CASH')).toBe(-1);
    for (const t of ['SPLIT', 'ADJUSTMENT', 'UNKNOWN', '']) expect(typeCashSign(t, 'CASH')).toBe(0);
  });

  it('reads card interest as a charge, and is case-blind', () => {
    expect(typeCashSign('INTEREST', 'CREDIT_CARD')).toBe(-1);
    expect(typeCashSign('interest', 'credit_card')).toBe(-1);
    expect(typeCashSign('withdrawal', 'CREDIT_CARD')).toBe(-1);
  });

  it('leaves the audits\' raw-type figure exactly as it was', () => {
    expect(cashEffectCents({ rawType: 'WITHDRAWAL', absCents: 4240 }, 'CASH')).toBe(-4240);
    expect(cashEffectCents({ rawType: 'INTEREST', absCents: 100 }, 'CREDIT_CARD')).toBe(-100);
    expect(cashEffectCents({ rawType: 'SPLIT', absCents: 100 }, 'CASH')).toBe(0);
  });
});

describe('postedLedgerTotal — a card total the app can compute (B1)', () => {
  it('adds the effective types up in dollars, pending rows left out', () => {
    expect(postedLedgerTotal([
      { activityType: 'WITHDRAWAL', amount: '100', comment: 'COFFEE · t1' },
      { activityType: 'WITHDRAWAL', amount: 30, comment: 'LUNCH · t2' },
      { activityType: 'TRANSFER_IN', amount: '50', comment: 'PAYMENT · t3' },
      { activityType: 'CREDIT', amount: '5', comment: 'REFUND · t4' },
      { activityType: 'WITHDRAWAL', amount: '40', comment: `NOT YET · t5${PENDING_SUFFIX}` },
      { activityType: 'INTEREST', amount: '1.25', comment: 'INTEREST CHARGE · t6' },
    ], 'CREDIT_CARD')).toBe(-76.25);
  });

  it('has no figure for an account holding an in-transit placeholder', () => {
    expect(postedLedgerTotal([
      { activityType: 'WITHDRAWAL', amount: '100', comment: 'COFFEE · t1' },
      { activityType: 'TRANSFER_IN', amount: '42.40', comment: `${IN_TRANSIT_COMMENT_PREFIX}PAYMENT · t2` },
    ], 'CREDIT_CARD')).toBeNull();
  });

  it('is zero for no rows, and skips an amount that is not a number', () => {
    expect(postedLedgerTotal([], 'CREDIT_CARD')).toBe(0);
    expect(postedLedgerTotal([{ activityType: 'WITHDRAWAL', amount: 'n/a', comment: null }], 'CREDIT_CARD')).toBe(0);
  });
});
```

Append to `src/utils/addon-host.test.ts`:

```ts
describe('AddonSyncHost totals a card from its whole history on a manual run (1.64, B1)', () => {
  /** A card with `n` posted $1 charges, served 500 to a page, newest first. */
  const cardCtx = (n: number, extra: Array<Record<string, unknown>> = []) => {
    const rows = [
      ...extra,
      ...Array.from({ length: n }, (_, i) => ({ id: `c${i}`, accountId: 'wf-citi', activityType: 'WITHDRAWAL', date: '2026-10-01', amount: '1', comment: `CHARGE · t${i}` })),
    ];
    const search = vi.fn(async (page: number, size: number, _filter?: unknown) => ({ data: rows.slice(page * size, (page + 1) * size), meta: { totalRowCount: rows.length } }));
    return { ctx: { api: { activities: { search } } } as any, search };
  };

  it('pages 500 at a time until a short page, and signs what search reports', async () => {
    const { ctx, search } = cardCtx(1001, [
      { id: 'pay', accountId: 'wf-citi', activityType: 'TRANSFER_IN', date: '2026-10-02', amount: '500', comment: 'AUTOPAY · p1' },
      { id: 'pend', accountId: 'wf-citi', activityType: 'WITHDRAWAL', date: '2026-10-03', amount: '40', comment: 'NOT YET · p2 · pending' },
    ]);
    const host = new AddonSyncHost(ctx, { fullCardHistory: true });
    const totals = await host.postedLedgerTotals([{ wfAccountId: 'wf-citi', accountType: 'CREDIT_CARD' }]);
    expect(totals.get('wf-citi')).toBe(-501);
    expect(search.mock.calls.map((c) => [c[0], c[1], c[2]])).toEqual([
      [0, 500, { accountIds: ['wf-citi'] }], [1, 500, { accountIds: ['wf-citi'] }], [2, 500, { accountIds: ['wf-citi'] }],
    ]);
  });

  it('reads nothing on a scheduled run (R7)', async () => {
    const { ctx, search } = cardCtx(3);
    const totals = await new AddonSyncHost(ctx).postedLedgerTotals([{ wfAccountId: 'wf-citi', accountType: 'CREDIT_CARD' }]);
    expect(totals.size).toBe(0);
    expect(search).not.toHaveBeenCalled();
  });

  it('omits a card holding an in-transit placeholder, and one whose read fails', async () => {
    const { ctx } = cardCtx(2, [
      { id: 'held', accountId: 'wf-citi', activityType: 'TRANSFER_IN', date: '2026-10-02', amount: '42.40', comment: '↔️ In-transit transfer · AUTOPAY · p1' },
    ]);
    const host = new AddonSyncHost(ctx, { fullCardHistory: true });
    expect((await host.postedLedgerTotals([{ wfAccountId: 'wf-citi', accountType: 'CREDIT_CARD' }])).has('wf-citi')).toBe(false);

    const failing = { api: { activities: { search: vi.fn(async () => { throw new Error('offline'); }) } } } as any;
    const log = vi.fn();
    const broken = new AddonSyncHost(failing, { fullCardHistory: true, log });
    expect((await broken.postedLedgerTotals([{ wfAccountId: 'wf-citi', accountType: 'CREDIT_CARD' }])).size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });
});
```

Create `companion/src/ledger-sign-agreement.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect } from 'vitest';
import { getNativeAccountBalances } from './sqlite-native.js';
import { typeCashSign } from '../../shared/audit-ledger.js';
import { postedLedgerTotal } from '../../shared/ledger-total.js';

/**
 * 1.64 (B1, R14): the app totals a card from `activities.search` with the
 * TypeScript sign table; the companion totals it in SQL. Both must agree on
 * the same rows, overrides included — on every type, account type and
 * direction — or the badge would say "in sync" from one side and "off by $X"
 * from the other.
 */
const TYPES = ['DEPOSIT', 'CREDIT', 'TRANSFER_IN', 'DIVIDEND', 'INTEREST', 'SELL',
  'WITHDRAWAL', 'TRANSFER_OUT', 'FEE', 'TAX', 'BUY', 'SPLIT', 'ADJUSTMENT', 'UNKNOWN'];
const ACCOUNT_TYPES = ['CASH', 'CREDIT_CARD', 'SECURITIES'];

function ledgerDb(): { path: string; db: DatabaseSync; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-sign-'));
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT);
    CREATE TABLE activities (id TEXT PRIMARY KEY, account_id TEXT, activity_type TEXT, activity_type_override TEXT,
      amount TEXT, activity_date TEXT, notes TEXT);
  `);
  return { path, db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe('the TypeScript sign table and the SQL one agree (R14)', () => {
  it('on every type × account type, stored raw', () => {
    const { path, db, cleanup } = ledgerDb();
    try {
      for (const acct of ACCOUNT_TYPES) {
        for (const type of TYPES) {
          const id = `${acct}-${type}`;
          db.prepare('INSERT INTO accounts VALUES (?, ?, ?)').run(id, id, acct);
          db.prepare("INSERT INTO activities VALUES (?, ?, ?, NULL, '10', '2026-10-01', 'ROW · t1')").run(`a-${id}`, id, type);
        }
      }
      const sql = getNativeAccountBalances(path);
      for (const acct of ACCOUNT_TYPES) {
        for (const type of TYPES) expect([acct, type, sql.get(`${acct}-${type}`)]).toEqual([acct, type, typeCashSign(type, acct) * 10]);
      }
    } finally { cleanup(); }
  });

  it('on every override over a row of the opposite direction', () => {
    const { path, db, cleanup } = ledgerDb();
    try {
      for (const acct of ACCOUNT_TYPES) {
        for (const type of TYPES) {
          const id = `${acct}-${type}`;
          const raw = typeCashSign(type, acct) > 0 ? 'WITHDRAWAL' : 'DEPOSIT';
          db.prepare('INSERT INTO accounts VALUES (?, ?, ?)').run(id, id, acct);
          db.prepare("INSERT INTO activities VALUES (?, ?, ?, ?, '10', '2026-10-01', 'ROW · t1')").run(`a-${id}`, id, raw, type);
        }
      }
      const sql = getNativeAccountBalances(path);
      for (const acct of ACCOUNT_TYPES) {
        for (const type of TYPES) expect([acct, type, sql.get(`${acct}-${type}`)]).toEqual([acct, type, typeCashSign(type, acct) * 10]);
      }
    } finally { cleanup(); }
  });

  it('so the app total equals the companion total on the same card, overrides and pending rows included', () => {
    const { path, db, cleanup } = ledgerDb();
    try {
      db.exec(`
        INSERT INTO accounts VALUES ('wf-citi', 'Citi Double Cash® Card', 'CREDIT_CARD');
        INSERT INTO activities VALUES
          ('c1', 'wf-citi', 'WITHDRAWAL', NULL, '61.20', '2026-10-01', 'GROCERY · t1'),
          ('c2', 'wf-citi', 'WITHDRAWAL', 'TRANSFER_IN', '42.40', '2026-10-02', 'AUTOPAY · t2'),
          ('c3', 'wf-citi', 'DEPOSIT', 'WITHDRAWAL', '9.99', '2026-10-03', 'STREAMING · t3'),
          ('c4', 'wf-citi', 'INTEREST', NULL, '1.25', '2026-10-04', 'INTEREST · t4'),
          ('c5', 'wf-citi', 'WITHDRAWAL', NULL, '15.00', '2026-10-05', 'PENDING CHARGE · t5 · pending');
      `);
      // What `activities.search` hands the app: COALESCE(override, type).
      const searched = [
        { activityType: 'WITHDRAWAL', amount: '61.20', comment: 'GROCERY · t1' },
        { activityType: 'TRANSFER_IN', amount: '42.40', comment: 'AUTOPAY · t2' },
        { activityType: 'WITHDRAWAL', amount: '9.99', comment: 'STREAMING · t3' },
        { activityType: 'INTEREST', amount: '1.25', comment: 'INTEREST · t4' },
        { activityType: 'WITHDRAWAL', amount: '15.00', comment: 'PENDING CHARGE · t5 · pending' },
      ];
      const app = postedLedgerTotal(searched, 'CREDIT_CARD');
      expect(app).toBe(-30.04);
      expect(getNativeAccountBalances(path).get('wf-citi')).toBeCloseTo(app!, 2);
    } finally { cleanup(); }
  });
});
```

Append to `companion/src/sqlite-native.test.ts`:

```ts
describe('getNativeAccountBalances signs the effective type (1.64, R14)', () => {
  it('reads an overridden row by its override, as Wealthfolio and the app do', () => {
    const { path, cleanup } = makeTestDb();
    try {
      const db = new DatabaseSync(path);
      db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type, activity_type_override, account_id, notes)
               VALUES ('o1', '100', '2026-08-01', 'WITHDRAWAL', NULL,          'acct-card', 'Coffee · t1'),
                      ('o2', '42.40', '2026-08-02', 'WITHDRAWAL', 'TRANSFER_IN', 'acct-card', 'Autopay · t2'),
                      ('o3', '5', '2026-08-03', 'CREDIT', '', 'acct-card', 'Refund · t3')`);
      db.close();
      // −100 +42.40 (the override, not the raw WITHDRAWAL) +5 (a blank override is none)
      expect(getNativeAccountBalances(path).get('acct-card')).toBeCloseTo(-52.6, 2);
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 shared/ledger-total.test.ts src/utils/addon-host.test.ts`
Expected: `shared/ledger-total.test.ts` fails to load ("Failed to resolve import ./ledger-total.js"); `3 failed | 4 passed (7)` — "host.postedLedgerTotals is not a function".
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/ledger-sign-agreement.test.ts src/sqlite-native.test.ts)`
Expected: the agreement file fails to load ("Cannot find module '../../shared/ledger-total.js'"); `1 failed | 104 passed (105)` — "expected -137.4 to be close to -52.6" (the raw type is signed).

- [ ] **Step 3: Implement**

- `shared/audit-ledger.ts`: add `typeCashSign` and `cashSignSql` beside `PLUS`/`MINUS` (doc: the one sign table — the app's total, the audits through `cashEffectCents`, and the companion's SQL through `cashSignSql`); make `cashEffectCents` delegate. `cashSignSql` body:

  ```ts
  const list = (set: Set<string>) => [...set].map((t) => `'${t}'`).join(',');
  return `CASE WHEN ${accountTypeExpr} = 'CREDIT_CARD' AND ${typeExpr} = 'INTEREST' THEN -1`
    + ` WHEN ${typeExpr} IN (${list(PLUS)}) THEN 1`
    + ` WHEN ${typeExpr} IN (${list(MINUS)}) THEN -1 ELSE 0 END`;
  ```
- `shared/ledger-total.ts`: `postedLedgerTotal` as specified, summing in cents (`typeCashSign(r.activityType, accountType) * Math.round(abs * 100)`), returning `cents / 100`. Header comment: why the app must add it up itself (valuations are cash-only, so every card said "not checked" after an in-app Sync) and the three rules it shares with the companion's reader.
- `shared/sync-host.ts`: the optional method with a doc comment saying: read after this run's writes; signed by the effective type; pending left out; an account holding an in-transit placeholder, or one the host could not read reliably, is omitted; asked only for accounts the valuations did not report; drives the badge only (R15); the companion reads live on every run, the add-on pages its history on a manual run and answers empty on a scheduled one (R7).
- `src/utils/addon-host.ts`: `const CARD_HISTORY_PAGE_SIZE = 500; const CARD_HISTORY_MAX_PAGES = 40;` above the class; store `fullCardHistory` from the constructor option; `postedLedgerTotals` loops the accounts, and per account (inside its own try/catch, logging `Card total for ${wfAccountId} not read: ${message}` through `this.log`) pages `this.ctx.api.activities.search(page, 500, { accountIds: [wfAccountId] }, '', { id: 'date', desc: true })` from page 0 until a page shorter than 500, maps rows with `fromSearchRow`, and sets the `postedLedgerTotal` when the read completed and the total is not null. Past 40 pages: omitted.
- `companion/src/sqlite-native.ts` `getNativeAccountBalances`: build the effective-type expression as `getNativeUncategorizedSpending` does (`hasActivityTypeOverride(dbPath) ? "UPPER(COALESCE(NULLIF(TRIM(a.activity_type_override), ''), a.activity_type, ''))" : "UPPER(COALESCE(a.activity_type, ''))"`) and replace the inline `CASE` with `(${cashSignSql(T, "UPPER(COALESCE(acc.account_type, ''))")}) * ABS(CAST(COALESCE(a.amount, '0') AS REAL))`. Rewrite the doc paragraph on the sign table: it is `typeCashSign` through `cashSignSql`, signed by the EFFECTIVE type since 1.64 (R14), which corrects a card with an overridden row. Leave `companion/src/ledger-facts.ts` `CASH_EFFECT` alone (out of scope).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice npx vitest run --maxWorkers=2 shared/ledger-total.test.ts src/utils/addon-host.test.ts shared/audit-balance.test.ts`
Expected: `33 passed (33)` (the first two files alone: `13 passed (13)`).
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/ledger-sign-agreement.test.ts src/sqlite-native.test.ts)`
Expected: `108 passed (108)`.
Run: `nice npm run type-check` and `nice npm --prefix companion run build` — both clean.

- [ ] **Step 5: Full suites**

Root: `171` files, `3803` tests, all pass. Companion: `68` files, `1530` tests, all pass.

- [ ] **Step 6: Commit**

```bash
git add shared/audit-ledger.ts shared/ledger-total.ts shared/ledger-total.test.ts shared/sync-host.ts src/utils/addon-host.ts src/utils/addon-host.test.ts companion/src/sqlite-native.ts companion/src/sqlite-native.test.ts companion/src/ledger-sign-agreement.test.ts
git commit -m "One sign table for both card totals; the app totals a card from its whole history (B1, R14)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The companion learns transfer names and publishes `transfer_names` (A1–A4)

**Files:**
- Create: `shared/transfer-names.ts`, `shared/learn-transfer-names.ts`, `companion/src/transfer-names.ts`
- Modify: `companion/src/index.ts` (imports; `runCompanionSync`, just before `log(\`Fetching SimpleFin transactions from …\`)`)
- Test: `shared/transfer-names.test.ts` (new), `shared/learn-transfer-names.test.ts` (new), `companion/src/transfer-names.test.ts` (new), `companion/src/index.test.ts`

**Interfaces:**
- Consumes: `typeCashSign` (Task 2); `GENERIC_BANK_WORDS` (shared/category-guess.ts); `bankWords` (shared/rule-pattern.ts); `descriptionFromComment`, `isInternalMarkerComment`, `IN_TRANSIT_COMMENT_PREFIX`, `txIdFromComment` (shared/sync-core.ts); `hasTxOverride`, `loadSyncOverrides` (shared/sync-overrides.ts); `accountTxKey`; `AuditLedger`/`AuditLedgerRow`; `getNativeAuditLedger` (companion/src/sqlite-audit.ts, throws when unreadable).
- Produces (shared/transfer-names.ts — imported by the sync core in Task 4, so it must NOT import shared/sync-core.ts):
  - `export const TRANSFER_NAMES_SECRET_KEY = 'transfer_names'`; `export const MAX_TRANSFER_NAMES = 500`
  - `export type TransferDirection = 'in' | 'out'`; `export interface LearnedTransferName { accountId: string; direction: TransferDirection; signature: string }`; `export interface TransferNames { version: 1; computedAt: string; names: LearnedTransferName[] }`
  - `export function transferSignature(bankText: string): string` — split on whitespace, drop every token holding a digit, lower-case, split each on `/[^a-z]+/`, drop empties, join with one space.
  - `export function isDistinctiveSignature(signature: string): boolean` — some word not in `GENERIC_BANK_WORDS` ∪ {to, from, at, for}.
  - `export function parseTransferNames(raw: string | null | undefined): TransferNames | null` — null when absent, not JSON, `version !== 1` or `names` not an array; malformed entries dropped.
- Produces (shared/learn-transfer-names.ts):
  - `export const TRANSFER_NAMES_LOOKBACK_DAYS = 365`
  - `export function noteSignature(notes: string): string` = `transferSignature(bankWords(descriptionFromComment(notes)))`
  - `export function learnTransferNames(input: { ledger: AuditLedger; mapping: AccountMapping; overrides: SyncOverrides; now: Date }): TransferNames`
- Produces (companion/src/transfer-names.ts): `export interface PublishTransferNamesDeps { readLedger: () => AuditLedger; readMapping: () => Promise<AccountMapping | null>; readOverrides: () => Promise<SyncOverrides | null>; write: (raw: string) => Promise<void>; log: (message: string) => void; now: Date }` and `export async function publishTransferNames(deps): Promise<number | null>`.

- [ ] **Step 1: Write the failing tests**

Create `shared/transfer-names.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isDistinctiveSignature, parseTransferNames, transferSignature } from './transfer-names.js';
import { noteSignature } from './learn-transfer-names.js';
import { IN_TRANSIT_COMMENT_PREFIX } from './sync-core.js';

describe('transferSignature (A2)', () => {
  it('gives the three signatures the spec quotes', () => {
    expect(transferSignature('RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT')).toBe('transfer capital one ach web payment');
    expect(transferSignature('*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR')).toBe('payment citi autopay ach web recur');
    expect(transferSignature('Withdrawal to 360 Performance Savings XXXXXX1580')).toBe('withdrawal to performance savings');
  });

  it('drops a whole token that holds a digit, before splitting it', () => {
    expect(transferSignature('ONLINE TRANSFER TO SAV-0000 REF#12AB')).toBe('online transfer to');
    expect(transferSignature('A1B2C3 ZELLE')).toBe('zelle');
    expect(transferSignature('  ')).toBe('');
  });
});

describe('noteSignature strips what the sync adds to a stored note (A2)', () => {
  it('the transaction id, the pending marker, the in-transit prefix, a Venmo note and an Amazon label', () => {
    expect(noteSignature('Withdrawal to 360 Performance Savings XXXXXX1580 · TRN-000')).toBe('withdrawal to performance savings');
    expect(noteSignature('RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT · TRN-000 · pending')).toBe('transfer capital one ach web payment');
    expect(noteSignature(`${IN_TRANSIT_COMMENT_PREFIX}*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR · TRN-000`)).toBe('payment citi autopay ach web recur');
    expect(noteSignature('VENMO PAYMENT ACH WEB · Venmo: rent split · TRN-000')).toBe('venmo payment ach web');
    expect(noteSignature('AMAZON MKTPL · Amazon: Kitchen · TRN-000')).toBe('amazon mktpl');
  });
});

describe('isDistinctiveSignature (A3, R3)', () => {
  it('needs one word that is neither a generic bank word nor to/from/at/for', () => {
    expect(isDistinctiveSignature('payment')).toBe(false);
    expect(isDistinctiveSignature('ach debit')).toBe(false);
    expect(isDistinctiveSignature('online transfer')).toBe(false);
    expect(isDistinctiveSignature('online transfer to')).toBe(false);
    expect(isDistinctiveSignature('')).toBe(false);
    expect(isDistinctiveSignature('withdrawal to performance savings')).toBe(true);
    expect(isDistinctiveSignature('transfer capital one ach web payment')).toBe(true);
  });
});

describe('parseTransferNames', () => {
  it('reads the document, dropping a malformed name', () => {
    const raw = JSON.stringify({ version: 1, computedAt: '2026-10-18T15:00:00.000Z', names: [
      { accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' },
      { accountId: 'wf-spend', direction: 'sideways', signature: 'x' },
      { accountId: 'wf-spend', direction: 'out', signature: '' },
      null,
    ] });
    expect(parseTransferNames(raw)).toEqual({ version: 1, computedAt: '2026-10-18T15:00:00.000Z', names: [
      { accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' },
    ] });
  });

  it('is null when absent, unreadable or another version', () => {
    expect(parseTransferNames(null)).toBeNull();
    expect(parseTransferNames('{nope')).toBeNull();
    expect(parseTransferNames(JSON.stringify({ version: 2, names: [] }))).toBeNull();
    expect(parseTransferNames(JSON.stringify({ version: 1 }))).toBeNull();
  });
});
```

Create `shared/learn-transfer-names.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { AuditAccount, AuditLedger, AuditLedgerRow } from './audit-ledger.js';
import { learnTransferNames } from './learn-transfer-names.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import { IN_TRANSIT_COMMENT_PREFIX } from './sync-core.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-18T15:00:00Z');
const SAVINGS_TO_SPEND = 'RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT';
const TO_PERFORMANCE = 'Withdrawal to 360 Performance Savings XXXXXX1580';

const accounts: AuditAccount[] = [
  { id: 'wf-spend', name: 'Spend', type: 'CASH', archived: false },
  { id: 'wf-sav', name: 'Savings', type: 'CASH', archived: false },
  { id: 'wf-360', name: '360 Checking', type: 'CASH', archived: false },
  { id: 'wf-perf', name: '360 Performance Savings', type: 'CASH', archived: false },
  { id: 'wf-citi', name: 'Citi Double Cash® Card', type: 'CREDIT_CARD', archived: false },
];
const mapping = { 'sfin-spend': 'wf-spend', 'sfin-sav': 'wf-sav', 'sfin-360': 'wf-360', 'sfin-perf': 'wf-perf', 'sfin-citi': 'wf-citi' };

let n = 0;
const row = (accountId: string, type: string, notes: string, group: string, date = '2026-10-01'): AuditLedgerRow => ({
  id: `r${(n += 1)}`, accountId, date, currency: 'USD', rawType: type, type, status: 'POSTED', absCents: 60000,
  group, assetId: '', external: false, phantomCash: false, notes,
});
/** Both legs of one linked transfer. */
const pair = (out: [string, string], into: [string, string], group: string, date = '2026-10-01'): AuditLedgerRow[] => [
  row(out[0], 'TRANSFER_OUT', out[1], group, date),
  row(into[0], 'TRANSFER_IN', into[1], group, date),
];
const learn = (rows: AuditLedgerRow[], overrides = emptySyncOverrides()) =>
  learnTransferNames({ ledger: { accounts, rows } as AuditLedger, mapping, overrides, now: NOW }).names;

describe('learnTransferNames — which rows teach (A1)', () => {
  it('learns both legs of a linked savings → Spend transfer, each in its own direction', () => {
    expect(learn(pair(['wf-sav', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-1'], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-2`], 'g1'))).toEqual([
      { accountId: 'wf-sav', direction: 'out', signature: 'withdrawal to pnc bank' },
      { accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' },
    ]);
  });

  it("learns 360 Checking's withdrawal to Performance Savings from one past link (R1)", () => {
    expect(learn(pair(['wf-360', `${TO_PERFORMANCE} · TRN-3`], ['wf-perf', 'Deposit from 360 Checking XXXXXX0000 · TRN-3'], 'g2'))).toContainEqual(
      { accountId: 'wf-360', direction: 'out', signature: 'withdrawal to performance savings' },
    );
  });

  it('reads the direction off the effective type', () => {
    const [leg, partner] = pair(['wf-sav', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-1'], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-2`], 'g1');
    const overridden = { ...partner, rawType: 'WITHDRAWAL', type: 'TRANSFER_IN' };
    expect(learn([leg, overridden])).toContainEqual({ accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' });
  });

  it('teaches nothing from rows that are not one leg of a link between two accounts, nor from older than a year', () => {
    expect(learn([
      row('wf-spend', 'DEPOSIT', `${SAVINGS_TO_SPEND} · TRN-4`, ''),
      row('wf-spend', 'TRANSFER_IN', `${SAVINGS_TO_SPEND} · TRN-5`, 'g-solo'),
      row('wf-spend', 'TRANSFER_OUT', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-6', 'g-solo'),
      ...pair(['wf-sav', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-7'], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-8`], 'g-old', '2025-10-17'),
    ])).toEqual([]);
  });

  it("never learns from the sync's own bookkeeping, a row typed by hand, or a card", () => {
    expect(learn([
      ...pair(['wf-sav', 'Starting balance · sfin-sav'], ['wf-spend', 'Balance adjustment · sfin-spend · 2026-10-01'], 'g3'),
      ...pair(['wf-sav', `${IN_TRANSIT_COMMENT_PREFIX}Withdrawal to PNC Bank XXXXXX0000 · TRN-9`], ['wf-spend', 'Moved money to checking'], 'g4'),
      ...pair(['wf-spend', '*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR · TRN-10'], ['wf-citi', 'AUTOPAY AUTO-PMT · TRN-11'], 'g5'),
    ])).toEqual([{ accountId: 'wf-spend', direction: 'out', signature: 'payment citi autopay ach web recur' }]);
  });

  it('teaches nothing from a group whose two legs carry the same note (R12), but a shared id with different wording teaches', () => {
    expect(learn(pair(['wf-sav', `${SAVINGS_TO_SPEND} · TRN-12`], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-12`], 'g6'))).toEqual([]);
    expect(learn(pair(['wf-sav', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-13'], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-13`], 'g7'))).toHaveLength(2);
  });
});

describe('learnTransferNames — guards (A3)', () => {
  it('never learns a signature of only generic words', () => {
    expect(learn(pair(['wf-sav', 'ONLINE TRANSFER TO 0000 · TRN-14'], ['wf-spend', 'ACH DEBIT · TRN-15'], 'g8'))).toEqual([]);
  });

  it('one notTransfer on any row with that signature on that account blocks the name, both directions (R4)', () => {
    const undone = row('wf-spend', 'DEPOSIT', `${SAVINGS_TO_SPEND} · TRN-16`, '', '2026-10-10');
    const overrides = setTxOverride(emptySyncOverrides(), accountTxKey('sfin-spend', 'TRN-16'), 'notTransfer', NOW);
    expect(learn([...pair(['wf-sav', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-1'], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-2`], 'g1'), undone], overrides)).toEqual([
      { accountId: 'wf-sav', direction: 'out', signature: 'withdrawal to pnc bank' },
    ]);
  });
});

describe('learnTransferNames — the list', () => {
  it('is newest first, one entry per name, stamped with the time it was computed', () => {
    const doc = learnTransferNames({ ledger: { accounts, rows: [
      ...pair(['wf-sav', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-1'], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-2`], 'g1', '2026-09-01'),
      ...pair(['wf-360', `${TO_PERFORMANCE} · TRN-3`], ['wf-perf', 'Deposit from 360 Checking XXXXXX0000 · TRN-3'], 'g2', '2026-10-05'),
      ...pair(['wf-sav', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-4'], ['wf-spend', `${SAVINGS_TO_SPEND} · TRN-5`], 'g3', '2026-10-01'),
    ] }, mapping, overrides: emptySyncOverrides(), now: NOW });
    expect(doc.computedAt).toBe('2026-10-18T15:00:00.000Z');
    expect(doc.names.map((x) => `${x.accountId} ${x.direction}`)).toEqual(['wf-360 out', 'wf-perf in', 'wf-sav out', 'wf-spend in']);
  });

  it('keeps at most 500 names', () => {
    const rows = Array.from({ length: 260 }, (_, i) => pair(
      ['wf-sav', `Withdrawal to Brokerage ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} · TRN-a${i}`],
      ['wf-spend', `Deposit from Brokerage ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} · TRN-b${i}`],
      `gx${i}`,
    )).flat();
    expect(learn(rows)).toHaveLength(500);
  });
});
```

Create `companion/src/transfer-names.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { publishTransferNames, type PublishTransferNamesDeps } from './transfer-names.js';
import { emptySyncOverrides } from '../../shared/sync-overrides.js';
import { parseTransferNames } from '../../shared/transfer-names.js';
import type { AuditLedger } from '../../shared/audit-ledger.js';

const NOW = new Date('2026-10-18T15:00:00Z');
const leg = (id: string, accountId: string, type: string, notes: string) => ({
  id, accountId, date: '2026-10-01', currency: 'USD', rawType: type, type, status: 'POSTED', absCents: 60000,
  group: 'g1', assetId: '', external: false, phantomCash: false, notes,
});
const LEDGER: AuditLedger = {
  accounts: [{ id: 'wf-sav', name: 'Savings', type: 'CASH', archived: false }, { id: 'wf-spend', name: 'Spend', type: 'CASH', archived: false }],
  rows: [
    leg('r1', 'wf-sav', 'TRANSFER_OUT', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-1'),
    leg('r2', 'wf-spend', 'TRANSFER_IN', 'RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT · TRN-2'),
  ],
};
const deps = (over: Partial<PublishTransferNamesDeps> = {}): PublishTransferNamesDeps & { write: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> } => ({
  readLedger: () => LEDGER,
  readMapping: async () => ({ 'sfin-sav': 'wf-sav', 'sfin-spend': 'wf-spend' }),
  readOverrides: async () => emptySyncOverrides(),
  write: vi.fn(async () => {}),
  log: vi.fn(),
  now: NOW,
  ...over,
}) as any;

describe('publishTransferNames (A4)', () => {
  it('writes the learned list as the transfer_names document', async () => {
    const d = deps();
    expect(await publishTransferNames(d)).toBe(2);
    expect(parseTransferNames(d.write.mock.calls[0][0])).toEqual({ version: 1, computedAt: '2026-10-18T15:00:00.000Z', names: [
      { accountId: 'wf-sav', direction: 'out', signature: 'withdrawal to pnc bank' },
      { accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' },
    ] });
  });

  it('keeps the previous list when the database or the overrides cannot be read', async () => {
    const noDb = deps({ readLedger: () => { throw new Error('no database'); } });
    expect(await publishTransferNames(noDb)).toBeNull();
    expect(noDb.write).not.toHaveBeenCalled();
    expect(noDb.log).toHaveBeenCalledWith(expect.stringContaining('no database'));

    const noOverrides = deps({ readOverrides: async () => null });
    expect(await publishTransferNames(noOverrides)).toBeNull();
    expect(noOverrides.write).not.toHaveBeenCalled();

    const failing = deps({ readOverrides: async () => { throw new Error('401'); } });
    expect(await publishTransferNames(failing)).toBeNull();
    expect(failing.write).not.toHaveBeenCalled();
  });
});
```

In `companion/src/index.test.ts`, inside `describe('runCompanionSync')`, before "derives force from MIN_SYNC_INTERVAL_HOURS…":

```ts
  it('publishes the learned transfer names before the sync types anything (1.64, A4)', async () => {
    const { getNativeAuditLedger } = await import('./sqlite-audit.js');
    const leg = (id: string, accountId: string, type: string, notes: string) => ({
      id, accountId, date: new Date().toISOString().slice(0, 10), currency: 'USD', rawType: type, type, status: 'POSTED',
      absCents: 60000, group: 'g1', assetId: '', external: false, phantomCash: false, notes,
    });
    vi.mocked(getNativeAuditLedger).mockReturnValueOnce({
      accounts: [{ id: 'wf-sav', name: 'Savings', type: 'CASH', archived: false }, { id: 'wf-spend', name: 'Spend', type: 'CASH', archived: false }],
      rows: [leg('r1', 'wf-sav', 'TRANSFER_OUT', 'Withdrawal to PNC Bank XXXXXX0000 · TRN-1'),
        leg('r2', 'wf-spend', 'TRANSFER_IN', 'RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT · TRN-2')],
    });
    await runCompanionSync();
    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client = vi.mocked(WealthfolioClient).mock.results.at(-1)!.value as any;
    const call = client.setAddonSecret.mock.calls.findIndex((c: string[]) => c[1] === 'transfer_names');
    expect(call).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(client.setAddonSecret.mock.calls[call][2]).names).toEqual([
      { accountId: 'wf-sav', direction: 'out', signature: 'withdrawal to pnc bank' },
      { accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' },
    ]);
    expect(client.setAddonSecret.mock.invocationCallOrder[call]).toBeLessThan(vi.mocked(runSyncCore).mock.invocationCallOrder[0]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 shared/transfer-names.test.ts shared/learn-transfer-names.test.ts`
Expected: both files fail to load ("Failed to resolve import").
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/transfer-names.test.ts src/index.test.ts)`
Expected: the publisher file fails to load; `1 failed | 345 passed (346)` — "expected -1 to be greater than or equal to 0" (no `transfer_names` write).

- [ ] **Step 3: Implement**

- `shared/transfer-names.ts`: as in Interfaces, with a header comment carrying the live cases (2026-10-18: savings → PNC landing first and asking for a category; 360 Checking's `Withdrawal to 360 Performance Savings XXXXXX1580` matching no wording rule) and the A2 table in the `transferSignature` doc.
- `shared/learn-transfer-names.ts` — `learnTransferNames`:
  1. `since` = `now − 365 days` as `toISOString().slice(0, 10)`; account types from `ledger.accounts` (upper-cased); `sfinIdsOf` = the mapping inverted (wf id → SimpleFin ids).
  2. Blocked `(account, signature)`: every ledger row whose `txIdFromComment(notes)` is set and whose `accountTxKey(sfinId, txId)` carries `notTransfer` for any of its account's SimpleFin ids → block `accountId + noteSignature(notes)` (both directions, R4).
  3. Group rows by `group` (non-empty). Skip a whole group when two legs in DIFFERENT accounts have the same trimmed note (R12).
  4. A leg teaches when: `date >= since`; the group has a leg in another account; its account is not `CREDIT_CARD`; it is a bank row (`!isInternalMarkerComment(notes) && !notes.startsWith(IN_TRANSIT_COMMENT_PREFIX) && !!txIdFromComment(notes)`); `typeCashSign(r.type, accountType) !== 0` (direction `in` for +, `out` for −; `r.type` is the effective type); its signature is distinctive and not blocked.
  5. One entry per `(accountId, direction, signature)`, keeping the newest date; sort newest first (stable on ties); cap at `MAX_TRANSFER_NAMES`; `computedAt: now.toISOString()`.
- `companion/src/transfer-names.ts` — `publishTransferNames`: `readLedger()` in a try/catch (on a throw log `Transfer names not learned — the database could not be read (<message>).` and return null); `readOverrides().catch(() => null)` — null logs `Transfer names not learned — the sync overrides could not be read.` and returns null; mapping `?? {}`; then `write(JSON.stringify(learnTransferNames(...)))`, log `Learned N transfer name(s).`, return N. Header: not `transfer-learning.ts` (the Telegram "make it a transfer rule" menu); never publishes from a read it cannot trust; no companion means learning is off (R6).
- `companion/src/index.ts`: import `loadSyncOverrides` (extend the existing sync-overrides import), `TRANSFER_NAMES_SECRET_KEY`, `publishTransferNames`, `getNativeAuditLedger`; in `runCompanionSync`, after the access-URL check and Amazon poll, immediately before `log(\`Fetching SimpleFin transactions …\`)`:

  ```ts
  // 1.64 (A4): the transfer names both writers' syncs read, learned from the
  // database before this run types anything. The startup sync reaches here
  // too, interval-skipped or not, so this is also the "once at startup".
  await publishTransferNames({
    readLedger: () => getNativeAuditLedger(wealthfolioDbPath()),
    readMapping: () => store.getAccountMapping(),
    readOverrides: async () => {
      const loaded = await loadSyncOverrides((k) => wfClient.getAddonSecret('simplefin-sync', k));
      return loaded.unreadable ? null : loaded.overrides;
    },
    write: (raw) => wfClient.setAddonSecret('simplefin-sync', TRANSFER_NAMES_SECRET_KEY, raw),
    log,
    now: new Date(),
  }).catch((e) => log(`Transfer names skipped: ${formatError(e)}`));
  ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice npx vitest run --maxWorkers=2 shared/transfer-names.test.ts shared/learn-transfer-names.test.ts` — Expected: `16 passed (16)`.
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/transfer-names.test.ts src/index.test.ts)` — Expected: `348 passed (348)`.
Type-check and companion build: clean.

- [ ] **Step 5: Full suites**

Root: `173` files, `3819` tests. Companion: `69` files, `1533` tests. All pass.

- [ ] **Step 6: Commit**

```bash
git add shared/transfer-names.ts shared/transfer-names.test.ts shared/learn-transfer-names.ts shared/learn-transfer-names.test.ts companion/src/transfer-names.ts companion/src/transfer-names.test.ts companion/src/index.ts companion/src/index.test.ts
git commit -m "Learned transfer names: the companion learns them from linked transfers and publishes transfer_names (A1-A4)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Learned names type a cash row a held transfer; stored paybacks kept out (A5, R13)

**Files:**
- Modify: `shared/transfer-names.ts` (append), `shared/sync-host.ts` (`SyncStore`), `shared/sync-core.ts` (typing loop), `shared/fake-host.ts`, `src/utils/secrets.ts`, `companion/src/rest-host.ts`
- Test: `shared/sync-core-learned-transfers.test.ts` (new), `shared/transfer-names.test.ts`, `src/utils/secrets.test.ts`, `companion/src/rest-host.test.ts`

**Interfaces:**
- Consumes: `transferSignature`, `parseTransferNames`, `TRANSFER_NAMES_SECRET_KEY`, `TransferNames` (Task 3); `MappedType` (shared/mapper.ts, type-only).
- Produces:
  - `export function learnedNameKeys(doc: TransferNames | null | undefined): Set<string>`
  - `export function learnedTransferType(names: ReadonlySet<string>, row: { wfAccountId: string; accountType: string | undefined; amount: number; mapped: MappedType; description: string }): 'TRANSFER_IN' | 'TRANSFER_OUT' | null` — null unless `accountType === 'CASH'`, `!mapped.fromRule`, and (`mapped.type === 'DEPOSIT' && amount > 0` → `in`) or (`mapped.type === 'WITHDRAWAL' && amount < 0` → `out`), and `(wfAccountId, direction, transferSignature(description))` is listed.
  - `SyncStore.getTransferNames?(): Promise<TransferNames | null>`; `SecretsStore.getTransferNames()` and `RestSyncStore.getTransferNames()` = `parseTransferNames(<secret>)`; `KEYS.transferNames` in secrets.ts (Reset clears it).
  - `FakeHostSeed.transferNames?: TransferNames` (absent: no `getTransferNames` on the store).

- [ ] **Step 1: Write the failing tests**

Create `shared/sync-core-learned-transfers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { IN_TRANSIT_COMMENT_PREFIX, runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { LearnedTransferName } from './transfer-names.js';
import type { SimplefinAccount, SimplefinTransaction } from './types.js';

const NOW = new Date('2026-10-18T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const SAVINGS_TO_SPEND = 'RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT';
const TO_PERFORMANCE = 'Withdrawal to 360 Performance Savings XXXXXX1580';

const tx = (id: string, iso: string, amount: string, description: string, pending = false): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description, ...(pending ? { pending: true } : {}) });
const account = (id: string, name: string, transactions: SimplefinTransaction[], org?: string): SimplefinAccount => ({
  id, name, currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-18T12:00:00Z'), transactions, ...(org ? { org: { name: org } } : {}),
});
const names = (...list: LearnedTransferName[]) => ({ version: 1 as const, computedAt: '2026-10-18T14:00:00.000Z', names: list });
const SPEND_IN: LearnedTransferName = { accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' };
const CHECKING_OUT: LearnedTransferName = { accountId: 'wf-360', direction: 'out', signature: 'withdrawal to performance savings' };

/** Spend (PNC), Savings, 360 Checking and 360 Performance Savings, all cash. */
const seedOf = (feeds: Partial<Record<'spend' | 'sav' | '360' | 'perf', SimplefinTransaction[]>>, extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    account('sfin-spend', 'Spend', feeds.spend ?? [], 'PNC Bank'),
    account('sfin-sav', 'Savings', feeds.sav ?? []),
    account('sfin-360', '360 Checking', feeds['360'] ?? [], 'Capital One'),
    account('sfin-perf', '360 Performance Savings', feeds.perf ?? [], 'Capital One'),
  ] },
  mapping: { 'sfin-spend': 'wf-spend', 'sfin-sav': 'wf-sav', 'sfin-360': 'wf-360', 'sfin-perf': 'wf-perf' },
  accountTypes: { 'wf-spend': 'CASH', 'wf-sav': 'CASH', 'wf-360': 'CASH', 'wf-perf': 'CASH' },
  ...extra,
});
const rowOf = (rows: HostActivity[] | undefined, txId: string) => (rows ?? []).find((r) => (r.comment ?? '').includes(` · ${txId}`));
const inTransit = (r: HostActivity | undefined) => (r?.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX);

describe('runSyncCore — learned transfer names hold a transfer whichever half posts first (A5)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('holds the savings → Spend deposit as an in-transit TRANSFER_IN, then links it when the savings half posts', async () => {
    // Both syncs on ONE fake host (a second host restarts its ids at fh-1).
    const seed = seedOf({ spend: [tx('in-1', '2026-10-17T12:00:00Z', '600.00', SAVINGS_TO_SPEND)] }, { transferNames: names(SPEND_IN) });
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, {});
    const held = rowOf(fh.activities.get('wf-spend'), 'in-1');
    // A cash inflow placeholder is a bare CREDIT: neither income nor spending.
    expect(held?.activityType).toBe('CREDIT');
    expect(inTransit(held)).toBe(true);

    vi.setSystemTime(new Date('2026-10-19T15:00:00Z'));
    seed.accountSet!.accounts.find((a) => a.id === 'sfin-sav')!.transactions!.push(
      tx('out-1', '2026-10-18T12:00:00Z', '-600.00', 'Withdrawal to PNC Bank XXXXXX0000'),
    );
    await runSyncCore(fh.host, fh.store, { force: true });
    expect(fh.links).toHaveLength(1);
    const into = rowOf(fh.activities.get('wf-spend'), 'in-1');
    const out = rowOf(fh.activities.get('wf-sav'), 'out-1');
    expect([out?.activityType, into?.activityType]).toEqual(['TRANSFER_OUT', 'TRANSFER_IN']);
    expect(inTransit(into)).toBe(false);
    expect(fh.activities.get('wf-spend')).toHaveLength(1);
  });

  it('with no partner, past 10 days it becomes an ordinary deposit marked Needs review', async () => {
    const fh = createFakeHost(seedOf({ spend: [tx('in-old', '2026-10-05T12:00:00Z', '600.00', SAVINGS_TO_SPEND)] }, { transferNames: names(SPEND_IN) }));
    await runSyncCore(fh.host, fh.store, {});
    const create = fh.saved.flatMap((r) => r.creates ?? []).find((c) => c.comment.includes('in-old'))!;
    expect(create).toMatchObject({ activityType: 'DEPOSIT', needsReview: true });
    expect(create.comment.startsWith(IN_TRANSIT_COMMENT_PREFIX)).toBe(false);
  });

  it("holds 360 Checking's withdrawal to Performance Savings from a past link, and a pending one too", async () => {
    const fh = createFakeHost(seedOf({ '360': [
      tx('w-1', '2026-10-17T12:00:00Z', '-500.00', TO_PERFORMANCE),
      tx('w-p', '2026-10-18T12:00:00Z', '-25.00', TO_PERFORMANCE, true),
    ] }, { transferNames: names(CHECKING_OUT) }));
    await runSyncCore(fh.host, fh.store, {});
    for (const id of ['w-1', 'w-p']) {
      const held = rowOf(fh.activities.get('wf-360'), id);
      expect([id, held?.activityType, inTransit(held)]).toEqual([id, 'TRANSFER_OUT', true]);
    }
  });

  it('without the list, every one of those rows is typed exactly as before (R6)', async () => {
    const fh = createFakeHost(seedOf({
      spend: [tx('in-1', '2026-10-17T12:00:00Z', '600.00', SAVINGS_TO_SPEND)],
      '360': [tx('w-1', '2026-10-17T12:00:00Z', '-500.00', TO_PERFORMANCE)],
    }));
    await runSyncCore(fh.host, fh.store, {});
    expect(rowOf(fh.activities.get('wf-spend'), 'in-1')?.activityType).toBe('DEPOSIT');
    expect(rowOf(fh.activities.get('wf-360'), 'w-1')?.activityType).toBe('WITHDRAWAL');
  });

  it('leaves alone: a bill, cashback never linked, the other direction, a card, and a row the person undid', async () => {
    const seed = seedOf({
      spend: [
        tx('gas', '2026-10-15T12:00:00Z', '-61.20', '*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT'),
        tx('undone', '2026-10-16T12:00:00Z', '80.00', SAVINGS_TO_SPEND),
      ],
      '360': [tx('dir', '2026-10-16T12:00:00Z', '500.00', TO_PERFORMANCE)],
    }, {
      transferNames: names(SPEND_IN, CHECKING_OUT, { accountId: 'wf-citi', direction: 'out', signature: 'amazon mktpl' }),
      syncOverrides: setTxOverride(emptySyncOverrides(), accountTxKey('sfin-spend', 'undone'), 'notTransfer', NOW),
    });
    seed.accountSet!.accounts.push(
      account('sfin-citi', 'Citi Double Cash® Card', [tx('card', '2026-10-16T12:00:00Z', '-19.99', 'AMAZON MKTPL')]),
      account('sfin-rhi', 'Robinhood individual', [tx('cashback', '2026-10-16T12:00:00Z', '12.67', 'Credit card cashback rewards of $12.67 transferred to Robinhood Brokerage account')]),
    );
    Object.assign(seed.mapping!, { 'sfin-citi': 'wf-citi', 'sfin-rhi': 'wf-rhi' });
    Object.assign(seed.accountTypes!, { 'wf-citi': 'CREDIT_CARD', 'wf-rhi': 'CASH' });
    const fh = createFakeHost(seed);
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(result.errors).toEqual([]);
    const typed = (wf: string, id: string) => {
      const r = rowOf(fh.activities.get(wf), id);
      return [id, r?.activityType, inTransit(r)];
    };
    expect(typed('wf-spend', 'gas')).toEqual(['gas', 'WITHDRAWAL', false]);
    expect(typed('wf-spend', 'undone')).toEqual(['undone', 'DEPOSIT', false]);
    expect(typed('wf-360', 'dir')).toEqual(['dir', 'DEPOSIT', false]);
    expect(typed('wf-citi', 'card')).toEqual(['card', 'WITHDRAWAL', false]);
    expect(typed('wf-rhi', 'cashback')).toEqual(['cashback', 'DEPOSIT', false]);
  });

  it('never overrides a rule', async () => {
    const fh = createFakeHost(seedOf({ sav: [tx('ruled', '2026-10-16T12:00:00Z', '75.00', 'Deposit from PNC Bank XXXXXX0000')] }, {
      transferNames: names({ accountId: 'wf-sav', direction: 'in', signature: 'deposit from pnc bank' }),
      mappingRules: [{ pattern: 'Deposit from PNC', matchType: 'contains', activityType: 'DEPOSIT' }],
    }));
    await runSyncCore(fh.host, fh.store, {});
    const r = rowOf(fh.activities.get('wf-sav'), 'ruled');
    expect([r?.activityType, inTransit(r)]).toEqual(['DEPOSIT', false]);
  });

  it('a payback the person filed (asReimbursement) stays a payback when its wording is a learned name', async () => {
    const fh = createFakeHost(seedOf({ spend: [tx('pb-f', '2026-10-16T12:00:00Z', '600.00', SAVINGS_TO_SPEND)] }, {
      transferNames: names(SPEND_IN),
      syncOverrides: setTxOverride(emptySyncOverrides(), accountTxKey('sfin-spend', 'pb-f'), 'asReimbursement', NOW),
    }));
    await runSyncCore(fh.host, fh.store, {});
    const r = rowOf(fh.activities.get('wf-spend'), 'pb-f');
    expect([r?.activityType, r?.subtype, inTransit(r)]).toEqual(['CREDIT', 'REIMBURSEMENT', false]);
  });

  it('leaves a stored payback as it is, and out of pairing, even when its bank text is a learned name (R13)', async () => {
    const fh = createFakeHost(seedOf({
      spend: [tx('pb-1', '2026-10-16T12:00:00Z', '600.00', SAVINGS_TO_SPEND)],
      sav: [tx('out-1', '2026-10-16T12:00:00Z', '-600.00', 'Withdrawal to PNC Bank XXXXXX0000')],
    }, {
      transferNames: names(SPEND_IN),
      existing: new Map([['wf-spend', [{ id: 'stored-pb', accountId: 'wf-spend', activityType: 'CREDIT', subtype: 'REIMBURSEMENT',
        date: '2026-10-16', amount: 600, comment: `${SAVINGS_TO_SPEND} · pb-1`, sourceGroupId: null }]]]),
    }));
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(result.errors).toEqual([]);
    expect(fh.links).toEqual([]);
    expect(fh.activities.get('wf-spend')).toEqual([expect.objectContaining({ id: 'stored-pb', activityType: 'CREDIT', subtype: 'REIMBURSEMENT' })]);
    // "PNC BANK" is a wording rule, so the savings half is a transfer on its own
    // — and, with no partner to pair with, a placeholder.
    expect(inTransit(rowOf(fh.activities.get('wf-sav'), 'out-1'))).toBe(true);
  });
});
```

Append to `shared/transfer-names.test.ts` (and add `learnedNameKeys, learnedTransferType` to its import from `./transfer-names.js`):

```ts
describe('learnedTransferType (A5)', () => {
  const keys = learnedNameKeys({ version: 1, computedAt: '', names: [
    { accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' },
  ] });
  const row = (over: Partial<Parameters<typeof learnedTransferType>[1]> = {}) => ({
    wfAccountId: 'wf-spend', accountType: 'CASH' as string | undefined, amount: 600,
    mapped: { type: 'DEPOSIT' as const, fromRule: false }, description: 'RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT', ...over,
  });

  it('types a listed (account, direction, signature) a transfer', () => {
    expect(learnedTransferType(keys, row())).toBe('TRANSFER_IN');
  });

  it('needs a known CASH account, no rule, a plain built-in type in the listed direction, and the listed account', () => {
    expect(learnedTransferType(keys, row({ accountType: undefined }))).toBeNull();
    expect(learnedTransferType(keys, row({ accountType: 'CREDIT_CARD' }))).toBeNull();
    expect(learnedTransferType(keys, row({ mapped: { type: 'DEPOSIT', fromRule: true } }))).toBeNull();
    expect(learnedTransferType(keys, row({ mapped: { type: 'CREDIT', fromRule: false } }))).toBeNull();
    expect(learnedTransferType(keys, row({ amount: -600, mapped: { type: 'WITHDRAWAL', fromRule: false } }))).toBeNull();
    expect(learnedTransferType(keys, row({ wfAccountId: 'wf-other' }))).toBeNull();
    expect(learnedTransferType(learnedNameKeys(null), row())).toBeNull();
  });
});
```

In `src/utils/secrets.test.ts`, before "clearAll removes the unreadable Venmo emails the companion keeps":

```ts
  it('reads the learned transfer names the companion publishes, null when absent or unreadable, and clearAll removes them (1.64)', async () => {
    const { ctx, data } = makeCtxWithData();
    const s = new SecretsStore(ctx);
    expect(await s.getTransferNames()).toBeNull();
    const doc = { version: 1, computedAt: '2026-10-18T15:00:00.000Z', names: [{ accountId: 'wf-spend', direction: 'in', signature: 'transfer capital one ach web payment' }] };
    data['transfer_names'] = JSON.stringify(doc);
    expect(await s.getTransferNames()).toEqual(doc);
    data['transfer_names'] = '{not json';
    expect(await s.getTransferNames()).toBeNull();
    await s.clearAll();
    expect(data['transfer_names']).toBeUndefined();
  });
```

In `companion/src/rest-host.test.ts`, inside `describe('RestSyncStore')`, before "reads the skip list the addon shares…":

```ts
  it('reads the learned transfer names it publishes, null when absent or unreadable (1.64)', async () => {
    const secrets = new Map<string, string>();
    const client = { getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null), setAddonSecret: vi.fn() } as any;
    const store = new RestSyncStore(client);
    expect(await store.getTransferNames()).toBeNull();
    const doc = { version: 1, computedAt: '2026-10-18T15:00:00.000Z', names: [{ accountId: 'wf-360', direction: 'out', signature: 'withdrawal to performance savings' }] };
    secrets.set('transfer_names', JSON.stringify(doc));
    expect(await store.getTransferNames()).toEqual(doc);
    secrets.set('transfer_names', '[]');
    expect(await store.getTransferNames()).toBeNull();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-learned-transfers.test.ts shared/transfer-names.test.ts src/utils/secrets.test.ts`
Expected: `5 failed | 50 passed (55)`, and `shared/transfer-names.test.ts` fails to load (`learnedNameKeys` is not a function at describe time). The four learned-typing tests fail (e.g. `expected 'DEPOSIT' to be 'CREDIT'`; the R13 test sees a link); the "leaves alone", "never overrides a rule" and filed-payback tests already pass — they pin today's behavior.
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/rest-host.test.ts)` — Expected: `1 failed | 19 passed (20)`.

- [ ] **Step 3: Implement**

- `shared/transfer-names.ts`: append `learnedNameKeys` and `learnedTransferType` (key: `${accountId}\u0000${direction}\u0000${signature}`); `import type { MappedType } from './mapper.js'`.
- `shared/sync-core.ts`:
  - import `learnedNameKeys, learnedTransferType`.
  - Just before `const nameWords = new Map…` (the block "Each mapped account's name words, built once and BEFORE typing"): read the list once — `const learnedNames = learnedNameKeys(await store.getTransferNames?.().catch(() => null));` — and add a lazy, memoized per-account reader `storedPaybacksOf(wfId): Promise<Set<string> | null>` = `fetchExistingRows(host, wfId)` → the tx ids of rows with `type === 'CREDIT'` and subtype `REIMBURSEMENT_SUBTYPE` (case-insensitive); a rejected read → `null`. Comment: no list (no companion, or one not yet on 1.64) is an empty set and typing is exactly as before (R6).
  - In the per-row typing, replace the `const mapped = bankFirstTransferOut(...) ? … : builtIn;` statement with:

    ```ts
    const bankFirst = bankFirstTransferOut(tx.description, amount, acctType, builtIn, otherAccountWords);
    // R13: from the bank text ALONE, before learned typing.
    const keepPayback = !payback && !builtIn.fromRule && builtIn.type === 'DEPOSIT' && amount > 0 && (!acctType || acctType === 'CASH');
    let learned = bankFirst ? null : learnedTransferType(learnedNames, {
      wfAccountId, accountType: acctType, amount, mapped: builtIn, description: tx.description,
    });
    let heldAsPayback = false;
    if (learned && keepPayback) {
      const paybackIds = await storedPaybacksOf(wfAccountId);
      if (!paybackIds || paybackIds.has(tx.id)) learned = null;
      heldAsPayback = !!paybackIds && paybackIds.has(tx.id);
    }
    const mapped = bankFirst
      ? { ...builtIn, type: 'TRANSFER_OUT' as ActivityType }
      : learned ? { ...builtIn, type: learned as ActivityType } : builtIn;
    ```

    with WHY comments (the 2026-10-18 live cases; learned typing sits before the payback and `notTransfer` handling so both still win; an unreadable stored-row read means no learned typing, i.e. today's typing).
  - In `prepared.push`, the `keepPayback` spread becomes `...(keepPayback ? { keepPayback: true as const } : {})`.
  - The pairing exclusion `if (notTransfer || payback) continue;` becomes `if (notTransfer || payback || heldAsPayback) continue;` (comment: a stored payback a learned name matched stays out too, R13).
- `shared/sync-host.ts`: `getTransferNames?` on `SyncStore` with a doc (null = absent or unreadable, learning off; optional).
- `src/utils/secrets.ts`: `getTransferNames()`; `KEYS.transferNames: TRANSFER_NAMES_SECRET_KEY` (comment: companion-published, add-on-read-only, the companion recomputes it, so Reset clears it).
- `companion/src/rest-host.ts`: `RestSyncStore.getTransferNames()`.
- `shared/fake-host.ts`: the `transferNames` seed and the conditional `getTransferNames` on the store.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-learned-transfers.test.ts shared/transfer-names.test.ts src/utils/secrets.test.ts` — Expected: `63 passed (63)`.
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/rest-host.test.ts)` — Expected: `20 passed (20)`.
Type-check and companion build: clean.

- [ ] **Step 5: Full suites**

Root: `174` files, `3830` tests. Companion: `69` files, `1534` tests. All pass (in particular `shared/sync-core-bank-first.test.ts` and `shared/sync-core-payback-keep.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add shared/transfer-names.ts shared/transfer-names.test.ts shared/sync-host.ts shared/sync-core.ts shared/fake-host.ts shared/sync-core-learned-transfers.test.ts src/utils/secrets.ts src/utils/secrets.test.ts companion/src/rest-host.ts companion/src/rest-host.test.ts
git commit -m "Learned transfer names type a cash row a held transfer, stored paybacks kept out (A5, R13)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Every card checked after a manual Sync's own saves, on the badge only (B2, B3, R15)

**Files:**
- Modify: `shared/sync-core.ts` (`SyncOptions`, new `badgeVerdict`, the valuations read ~line 1962, the block right before `await store.setAccountBalances(accountBalances);`)
- Modify: `shared/fake-host.ts`, `src/utils/sync.ts` (`bookkeepingHost`, `runSync`), `src/pages/SyncPage.tsx` (`doSync`, `doHeal`)
- Modify: `companion/src/sqlite-native.ts` (`tryQueryNativeDb`, new `nativeDbUris`, `getNativeAccountBalances`), `companion/src/rest-host.ts` (`RestSyncHost`)
- Test: `shared/sync-core-card-check.test.ts` (new), `src/utils/sync.test.ts`, `src/pages/SyncPage.test.tsx`, `companion/src/rest-host.test.ts`, `companion/src/sqlite-native.test.ts`

**Interfaces:**
- Consumes: `postedLedgerTotal`, `SyncHost.postedLedgerTotals?`, `AddonSyncHost` `fullCardHistory` (Task 2).
- Produces:
  - `SyncOptions.manual?: boolean` — a person asked (Sync button, Deep scan, `/sync`). In this task it only turns on the add-on's card read; Task 7 gives it its core meaning.
  - `export function badgeVerdict(bankBalance: number, wealthfolioFigure: number): { drift: number | null; measured: true }` — `d = round2(bank − figure)`; `drift = |d| > DRIFT_THRESHOLD_DOLLARS ? d : null`.
  - `export function nativeDbUris(dbPath: string, liveOnly = false): string[]` — `[mode=ro, mode=ro&readonly_shm=1, immutable=1]`, the last dropped when `liveOnly`; a `file:` path is returned alone.
  - `getNativeAccountBalances(dbPath, opts: { liveOnly?: boolean } = {})`.
  - `RestSyncHost.postedLedgerTotals(accounts)` — `getNativeAccountBalances(dbPath, { liveOnly: true })` filtered to the requested ids; empty without a `dbPath`.
  - `FakeHostSeed.cardTotals?: boolean` — gives the fake host `postedLedgerTotals` computed with `postedLedgerTotal(rowsFor(id), accountType)` over its LIVE rows.

- [ ] **Step 1: Write the failing tests**

Create `shared/sync-core-card-check.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { badgeVerdict, runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { SimplefinTransaction } from './types.js';

const NOW = new Date('2026-10-18T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const tx = (id: string, iso: string, amount: string, description: string, pending = false): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description, ...(pending ? { pending: true } : {}) });

/** The Citi card, with one charge already stored, and Spend (cash, valued). */
const citiSeed = (balance: string, feed: SimplefinTransaction[], extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-citi', name: 'Citi Double Cash® Card', currency: 'USD', balance, 'balance-date': epoch('2026-10-18T12:00:00Z'),
      transactions: [tx('c-0', '2026-10-01T12:00:00Z', '-100.00', 'GROCERY'), ...feed] },
    { id: 'sfin-spend', name: 'Spend', currency: 'USD', balance: '500.00', 'balance-date': epoch('2026-10-18T12:00:00Z'), transactions: [] },
  ] },
  mapping: { 'sfin-citi': 'wf-citi', 'sfin-spend': 'wf-spend' },
  accountTypes: { 'wf-citi': 'CREDIT_CARD', 'wf-spend': 'CASH' },
  valuations: new Map([['wf-spend', 500]]),
  existing: new Map([['wf-citi', [{ id: 'old-0', accountId: 'wf-citi', activityType: 'WITHDRAWAL', date: '2026-10-01', amount: 100,
    comment: 'GROCERY · c-0', sourceGroupId: null, assetId: '$CASH-USD' }]]]),
  ...extra,
});
const NEW_CHARGE = tx('c-1', '2026-10-17T12:00:00Z', '-61.20', 'HARDWARE STORE');
const badge = async (fh: ReturnType<typeof createFakeHost>, sf = 'sfin-citi') =>
  (await fh.store.getAccountBalances())[sf] as { drift: number | null; measured?: boolean };

describe('badgeVerdict', () => {
  it('is in sync within a dollar, else off by bank − Wealthfolio to the cent', () => {
    expect(badgeVerdict(-161.2, -161.2)).toEqual({ drift: null, measured: true });
    expect(badgeVerdict(-161.2, -160.5)).toEqual({ drift: null, measured: true });
    expect(badgeVerdict(-200, -161.2)).toEqual({ drift: -38.8, measured: true });
  });
});

describe('runSyncCore — a card gets a real verdict after the run\'s own saves (B2, B3)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('a Sync that imports a new Citi charge shows Citi in sync when the total matches', async () => {
    const fh = createFakeHost(citiSeed('-161.20', [NEW_CHARGE], { cardTotals: true }));
    const result = await runSyncCore(fh.host, fh.store, { manual: true });
    expect(result.imported).toBe(1);
    expect(await badge(fh)).toMatchObject({ measured: true, drift: null });
  });

  it('and off by $X when it does not — on the badge only: no alert, no correction (R15)', async () => {
    const fh = createFakeHost(citiSeed('-200.00', [NEW_CHARGE], { cardTotals: true, driftAlertThreshold: 10 }));
    const result = await runSyncCore(fh.host, fh.store, { manual: true });
    expect(await badge(fh)).toMatchObject({ measured: true, drift: -38.8 });
    expect(result.balanceDriftAlerts).toEqual([]);
    expect(await fh.store.getDriftAlerts()).toEqual({});
    expect(fh.imported.flat()).toEqual([]);
  });

  it('checks a card with pending charges (B3)', async () => {
    const fh = createFakeHost(citiSeed('-161.20', [NEW_CHARGE, tx('c-p', '2026-10-18T12:00:00Z', '-15.00', 'COFFEE', true)], { cardTotals: true }));
    await runSyncCore(fh.host, fh.store, { manual: true });
    expect(await badge(fh)).toMatchObject({ measured: true, drift: null });
  });

  it('leaves a card holding an in-flight transfer leg "not checked"', async () => {
    const fh = createFakeHost(citiSeed('-118.80', [NEW_CHARGE, tx('pay', '2026-10-17T12:00:00Z', '42.40', 'AUTOPAY 000000000000000RAUTOPAY AUTO-PMT')], { cardTotals: true }));
    await runSyncCore(fh.host, fh.store, { manual: true });
    expect(await badge(fh)).toMatchObject({ measured: false, drift: null });
  });

  it('leaves the card "not checked" without the read (a scheduled app run, R7), or when the read fails', async () => {
    const without = createFakeHost(citiSeed('-161.20', [NEW_CHARGE]));
    await runSyncCore(without.host, without.store, {});
    expect(await badge(without)).toMatchObject({ measured: false });

    const failing = createFakeHost(citiSeed('-161.20', [NEW_CHARGE], { cardTotals: true }));
    failing.host.postedLedgerTotals = async () => { throw new Error('offline'); };
    const result = await runSyncCore(failing.host, failing.store, { manual: true });
    expect(result.errors).toEqual([]);
    expect(await badge(failing)).toMatchObject({ measured: false });
  });

  it('asks only about unvalued accounts left unchecked; a verdict the run already measured stands', async () => {
    // The companion's shape: a ledger figure before the saves (here stale by
    // $11.20) and a live total after. Nothing was imported, so the before-save
    // figure was trusted, and the after-save read is not consulted.
    const fh = createFakeHost(citiSeed('-100.00', [], { cardTotals: true, ledgerBalances: new Map([['wf-citi', -88.8]]) }));
    const asked: string[][] = [];
    const read = fh.host.postedLedgerTotals!.bind(fh.host);
    fh.host.postedLedgerTotals = async (accounts) => { asked.push(accounts.map((a) => a.wfAccountId)); return read(accounts); };
    await runSyncCore(fh.host, fh.store, { manual: true });
    expect(await badge(fh)).toMatchObject({ measured: true, drift: -11.2 });
    expect(asked).toEqual([]);
  });
});
```

In `src/utils/sync.test.ts`, inside `describe('runSync')`, before "returns 0 imported when no transactions":

```ts
  it('totals a card after the saves on a manual run, and leaves it unchecked on a scheduled one (1.64, B1, R7)', async () => {
    const run = async (opts: { manual?: boolean }) => {
      vi.mocked(fetchAccounts).mockResolvedValueOnce({ errors: [], accounts: [{
        id: 'sfin-2', name: 'Card', currency: 'USD', balance: '-61.20', 'balance-date': Date.now() / 1000, transactions: [],
      }] } as any);
      const ctx = makeCtx();
      // Wealthfolio values cash accounts only: nothing for the card.
      ctx.api.portfolio.getLatestValuations = vi.fn(async () => []);
      ctx.api.activities.search = vi.fn(async () => ({ data: [
        { id: 'a1', accountId: 'wf-account-b', activityType: 'WITHDRAWAL', date: '2026-10-17', amount: '61.20', comment: 'HARDWARE STORE · t1' },
      ] }));
      const store = makeStore({ getAccountMapping: vi.fn(async () => ({ 'sfin-2': 'wf-account-b' })) });
      await runSync(ctx, store as any, opts);
      return (store.setAccountBalances.mock.calls.at(-1)![0] as Record<string, unknown>)['sfin-2'];
    };
    expect(await run({ manual: true })).toMatchObject({ measured: true, drift: null });
    expect(await run({})).toMatchObject({ measured: false });
  });
```

In `src/pages/SyncPage.test.tsx`, before "shows sync result after clicking Sync Now":

```ts
  it('tells the sync a person asked for it — Sync now and Deep scan both (1.64)', async () => {
    render(<SyncPage {...makeProps()} />);
    await waitFor(() => screen.getByRole('button', { name: /sync now/i }));
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    await waitFor(() => expect(runSync).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ manual: true })));
    fireEvent.click(headerButton(/deep scan/i));
    await waitFor(() => expect(runSync).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ heal: true, manual: true })));
  });
```

In `companion/src/rest-host.test.ts`, add `import { mkdtempSync, rmSync } from 'fs'; import { tmpdir } from 'os'; import { join } from 'path'; import { DatabaseSync } from 'node:sqlite';` at the top and, before `describe('RestSyncStore', …)`:

```ts
describe('RestSyncHost.postedLedgerTotals — the after-save card total (1.64, B2)', () => {
  it('reads each requested account live from the database, and only those', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfin-rest-total-'));
    try {
      const path = join(dir, 'wealthfolio.db');
      const db = new DatabaseSync(path);
      db.exec(`
        CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, account_type TEXT);
        CREATE TABLE activities (id TEXT PRIMARY KEY, account_id TEXT, activity_type TEXT, activity_type_override TEXT, amount TEXT, activity_date TEXT, notes TEXT);
        INSERT INTO accounts VALUES ('wf-citi', 'Citi', 'CREDIT_CARD'), ('wf-rh', 'Robinhood', 'CREDIT_CARD');
        INSERT INTO activities VALUES ('a1', 'wf-citi', 'WITHDRAWAL', NULL, '61.20', '2026-10-17', 'HARDWARE STORE · t1'),
                                      ('a2', 'wf-citi', 'WITHDRAWAL', NULL, '15.00', '2026-10-18', 'COFFEE · t2 · pending'),
                                      ('a3', 'wf-rh', 'WITHDRAWAL', NULL, '9.99', '2026-10-17', 'STREAMING · t3');
      `);
      db.close();
      const host = new RestSyncHost({} as any, path);
      const totals = await host.postedLedgerTotals([{ wfAccountId: 'wf-citi', accountType: 'CREDIT_CARD' }]);
      expect([...totals]).toEqual([['wf-citi', -61.2]]);
      expect((await new RestSyncHost({} as any).postedLedgerTotals([{ wfAccountId: 'wf-citi', accountType: 'CREDIT_CARD' }])).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

In `companion/src/sqlite-native.test.ts`, add `nativeDbUris` to the `./sqlite-native.js` import and append:

```ts
describe('nativeDbUris — a live read or none (1.64, B2)', () => {
  it('drops the immutable snapshot, which ignores the write-ahead log, when the read must be live', () => {
    expect(nativeDbUris('/mnt/wealthfolio.db')).toEqual([
      'file:/mnt/wealthfolio.db?mode=ro', 'file:/mnt/wealthfolio.db?mode=ro&readonly_shm=1', 'file:/mnt/wealthfolio.db?immutable=1',
    ]);
    expect(nativeDbUris('/mnt/wealthfolio.db', true)).toEqual([
      'file:/mnt/wealthfolio.db?mode=ro', 'file:/mnt/wealthfolio.db?mode=ro&readonly_shm=1',
    ]);
    expect(nativeDbUris('file:/x.db', true)).toEqual(['file:/x.db']);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-card-check.test.ts src/utils/sync.test.ts src/pages/SyncPage.test.tsx`
Expected: `7 failed | 119 passed (126)` — `badgeVerdict` missing, five card-check tests (Citi stays `measured: false`), the add-on manual run, and the SyncPage `manual: true` assertion. ("leaves a card holding an in-flight transfer leg…" and "…without the read, or when the read fails" pass already: they pin today.)
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/rest-host.test.ts src/sqlite-native.test.ts)` — Expected: `2 failed | 125 passed (127)`.

- [ ] **Step 3: Implement**

- `shared/sync-core.ts`:
  - `SyncOptions.manual` with the doc in Interfaces.
  - `badgeVerdict` exported next to `INTERVAL_SKIP_MESSAGE`.
  - Right after the `latestValuations` try/catch (before the ledger fallback fills the gaps): `const valuedWfIds = new Set(wfBalances?.keys() ?? []);` — the accounts Wealthfolio VALUED.
  - Immediately before `await store.setAccountBalances(accountBalances);` (after every write, link and relink of the run):

    ```ts
    if (host.postedLedgerTotals && wfBalances !== null) {
      const unchecked = accountSet.accounts.filter((sf) => {
        const wf = mapping[sf.id];
        const snap = accountBalances[sf.id];
        return !!wf && !valuedWfIds.has(wf) && !!snap && snap.measured !== true && snap.balance !== null;
      });
      if (unchecked.length > 0) {
        const wanted = [...new Set(unchecked.map((sf) => mapping[sf.id]))]
          .map((wfAccountId) => ({ wfAccountId, accountType: wfTypes.get(wfAccountId) ?? '' }));
        const totals = await host.postedLedgerTotals(wanted).catch(() => null);
        for (const sf of unchecked) {
          const total = totals?.get(mapping[sf.id]);
          const snap = accountBalances[sf.id];
          if (total === undefined || snap.balance === null) continue;
          Object.assign(snap, badgeVerdict(snap.balance, total));
        }
      }
    }
    ```

    The comment carries the live case (every card "not checked" after an in-app Sync, 2026-10-18), B3 (a posted-only total is comparable whatever is pending), and R15 (the badge only: alerts, the starting balance, auto-heal, the baseline-fix offer and every write keep the before-save figure, which subtracts this run's rows from a before-save read and would count them twice if fed this one).
- `shared/fake-host.ts`: `cardTotals` seed → `postedLedgerTotals` on the host (import `postedLedgerTotal`).
- `src/utils/sync.ts`: `bookkeepingHost(ctx, store, log?, fullCardHistory = false)` passes `fullCardHistory` to `AddonSyncHost`; `runSync` calls `bookkeepingHost(ctx, store, warn, !!opts.manual)`. The two other `bookkeepingHost(ctx, store)` callers stay as they are.
- `src/pages/SyncPage.tsx`: `doSync` calls `runSync(ctx, store, { force, manual: true })`; `doHeal` calls `runSync(ctx, store, { heal: true, manual: true })`.
- `companion/src/sqlite-native.ts`: `tryQueryNativeDb` gains a trailing `liveOnly = false` parameter and builds its URIs with `nativeDbUris(dbPath, liveOnly)` (doc: the `immutable=1` snapshot ignores the write-ahead log and has been seen two days stale; a read that must see writes made seconds ago is better unread than stale; the CLI fallback opens the file normally, which reads the log or fails). `getNativeAccountBalances` calls `tryQueryNativeDb(..., '|', undefined, !!opts.liveOnly) ?? []`.
- `companion/src/rest-host.ts`: `postedLedgerTotals` with a doc saying that when only the stale snapshot opens nothing is returned and every card stays "not checked".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-card-check.test.ts src/utils/sync.test.ts src/pages/SyncPage.test.tsx` — Expected: `126 passed (126)`.
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/rest-host.test.ts src/sqlite-native.test.ts)` — Expected: `127 passed (127)`.
Type-check and companion build: clean.

- [ ] **Step 5: Full suites**

Root: `175` files, `3839` tests. Companion: `69` files, `1536` tests. All pass.

- [ ] **Step 6: Commit**

```bash
git add shared/sync-core.ts shared/fake-host.ts shared/sync-core-card-check.test.ts src/utils/sync.ts src/utils/sync.test.ts src/pages/SyncPage.tsx src/pages/SyncPage.test.tsx companion/src/sqlite-native.ts companion/src/sqlite-native.test.ts companion/src/rest-host.ts companion/src/rest-host.test.ts
git commit -m "Every card checked after a manual Sync's own saves, on the badge only (B2, B3, R15)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: A check-only pass re-checks every balance against the last download (C3, R9, R16)

**Files:**
- Modify: `shared/sync-core.ts` (`AccountBalanceSnapshot`, the line before `host.fetchSimplefin`, the snapshot write ~`measured: measuredDrift !== null`, new `checkBalancesOnly` above `type RecordChange`), `src/utils/secrets.ts` (`AccountBalanceInfo`)
- Modify (existing assertions): `shared/sync-core.test.ts` — the two exact-shape `getAccountBalances()` expectations in "runSyncCore with ONE SimpleFin tx id in two accounts" (the looped "leaves a correctly-typed live pair … untouched on a heal" and "measures drift per account with each leg's own sign")
- Test: `shared/sync-core-check-only.test.ts` (new)

**Interfaces:**
- Consumes: `badgeVerdict`, `SyncHost.postedLedgerTotals?` (Task 5); `PENDING_SUFFIX`.
- Produces:
  - `AccountBalanceSnapshot.fetchedAt?: number` (and `AccountBalanceInfo.fetchedAt?: number`): ms when the download that produced `balance`/`date` was sent. Every downloaded run stamps it on every snapshot it writes.
  - `export async function checkBalancesOnly(host: SyncHost, store: SyncStore, opts: { mapping: AccountMapping; newestRequestAt: number | null }): Promise<{ dataAt: number | null }>` — writes only `account_balances`. An account is compared when its stored `fetchedAt` is a number and `>= newestRequestAt` (always when `newestRequestAt` is null) and its stored `balance` is a number: a VALUED account against `valuation − (asset-backed TRANSFER_OUT legs)` when `host.listActivities` shows no row ending in `PENDING_SUFFIX`; any other account against `host.postedLedgerTotals`. Compared → `badgeVerdict`; otherwise `{ drift: null, measured: false }`. Every mapped stored entry loses `baselineFix`; unmapped entries are kept untouched. `dataAt` = the newest `fetchedAt` among compared-fresh accounts, or null when none was fresh.

- [ ] **Step 1: Write the failing tests**

Create `shared/sync-core-check-only.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { checkBalancesOnly, runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { SimplefinTransaction } from './types.js';

const NOW = new Date('2026-10-18T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const tx = (id: string, iso: string, amount: string, description: string, pending = false): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description, ...(pending ? { pending: true } : {}) });

/** Spend (cash, valued at $500) and the Citi card (one charge stored), both with something new this run. */
const seedOf = (spend: SimplefinTransaction[] = [tx('pay', '2026-10-17T12:00:00Z', '100.00', 'PAYROLL')]): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-spend', name: 'Spend', currency: 'USD', balance: '500.00', 'balance-date': epoch('2026-10-18T12:00:00Z'), transactions: spend },
    { id: 'sfin-citi', name: 'Citi Double Cash® Card', currency: 'USD', balance: '-161.20', 'balance-date': epoch('2026-10-18T12:00:00Z'),
      transactions: [tx('c-0', '2026-10-01T12:00:00Z', '-100.00', 'GROCERY'), tx('c-1', '2026-10-17T12:00:00Z', '-61.20', 'HARDWARE STORE')] },
  ] },
  mapping: { 'sfin-spend': 'wf-spend', 'sfin-citi': 'wf-citi' },
  accountTypes: { 'wf-spend': 'CASH', 'wf-citi': 'CREDIT_CARD' },
  valuations: new Map([['wf-spend', 500]]),
  cardTotals: true,
});
type Snap = { balance: number | null; drift: number | null; measured?: boolean; fetchedAt?: number; baselineFix?: unknown };
const snaps = async (fh: ReturnType<typeof createFakeHost>) => (await fh.store.getAccountBalances()) as Record<string, Snap>;

describe('checkBalancesOnly — a Sync inside the gap re-checks against the last download (C3, R9, R16)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('stamps every bank figure a download keeps with when that download was sent', async () => {
    const fh = createFakeHost(seedOf());
    await runSyncCore(fh.host, fh.store, { manual: true });
    const s = await snaps(fh);
    expect([s['sfin-spend'].fetchedAt, s['sfin-citi'].fetchedAt]).toEqual([NOW.getTime(), NOW.getTime()]);
    // The cash account imported a row this run, so its valuation was not trusted.
    expect(s['sfin-spend'].measured).toBe(false);
  });

  it('checks every account without asking SimpleFin or writing a row, and says how old the bank data is', async () => {
    const fh = createFakeHost(seedOf());
    await runSyncCore(fh.host, fh.store, { manual: true });
    const fetch = vi.spyOn(fh.host, 'fetchSimplefin');
    const saves = fh.saved.length;
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 60_000));
    const { dataAt } = await checkBalancesOnly(fh.host, fh.store, { mapping: { 'sfin-spend': 'wf-spend', 'sfin-citi': 'wf-citi' }, newestRequestAt: NOW.getTime() });
    expect(dataAt).toBe(NOW.getTime());
    expect(fetch).not.toHaveBeenCalled();
    expect(fh.saved.length).toBe(saves);
    const s = await snaps(fh);
    expect(s['sfin-spend']).toMatchObject({ balance: 500, measured: true, drift: null, fetchedAt: NOW.getTime() });
    expect(s['sfin-citi']).toMatchObject({ balance: -161.2, measured: true, drift: null });
  });

  it('reports a cash account off by its difference from the valuation', async () => {
    const seed = seedOf();
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, { manual: true });
    seed.valuations!.set('wf-spend', 450);
    await checkBalancesOnly(fh.host, fh.store, { mapping: seed.mapping!, newestRequestAt: NOW.getTime() });
    expect((await snaps(fh))['sfin-spend']).toMatchObject({ measured: true, drift: 50 });
  });

  it('leaves a cash account with a pending row "not checked"', async () => {
    const seed = seedOf([tx('pend', '2026-10-18T12:00:00Z', '-20.00', 'COFFEE', true)]);
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, { manual: true });
    await checkBalancesOnly(fh.host, fh.store, { mapping: seed.mapping!, newestRequestAt: NOW.getTime() });
    expect((await snaps(fh))['sfin-spend']).toMatchObject({ measured: false, drift: null });
  });

  it('checks nothing while a newer download than the stored figures is in flight (R16)', async () => {
    const seed = seedOf();
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, { manual: true });
    const { dataAt } = await checkBalancesOnly(fh.host, fh.store, { mapping: seed.mapping!, newestRequestAt: NOW.getTime() + 60_000 });
    expect(dataAt).toBeNull();
    const s = await snaps(fh);
    expect([s['sfin-spend'].measured, s['sfin-citi'].measured]).toEqual([false, false]);
  });

  it('never calls a snapshot written without fetchedAt (an older writer) in sync', async () => {
    const seed = seedOf();
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, { manual: true });
    const s = await snaps(fh);
    const { fetchedAt: _old, ...olderWriter } = s['sfin-spend'];
    await fh.store.setAccountBalances({ ...s, 'sfin-spend': { ...olderWriter, measured: true, drift: null } });
    await checkBalancesOnly(fh.host, fh.store, { mapping: seed.mapping!, newestRequestAt: NOW.getTime() });
    expect((await snaps(fh))['sfin-spend']).toMatchObject({ measured: false, drift: null });
  });

  it('keeps every other snapshot and drops a stale baseline-fix offer', async () => {
    const seed = seedOf();
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, { manual: true });
    const s = await snaps(fh);
    await fh.store.setAccountBalances({
      ...s,
      'sfin-spend': { ...s['sfin-spend'], baselineFix: { activityId: 'sb-1', currentAmount: 10, suggestedAmount: 12 } },
      'sfin-old': { balance: 1, currency: 'USD', date: 0, drift: null },
    });
    await checkBalancesOnly(fh.host, fh.store, { mapping: seed.mapping!, newestRequestAt: NOW.getTime() });
    const after = await snaps(fh);
    expect(after['sfin-spend'].baselineFix).toBeUndefined();
    expect(after['sfin-old']).toEqual({ balance: 1, currency: 'USD', date: 0, drift: null });
  });
});
```

In `shared/sync-core.test.ts`, add `fetchedAt: expect.any(Number)` to the four snapshot objects in those two `toEqual` assertions (both sites carry `'sfin-sav': { balance: 610.65, …, measured: true }` and `'sfin-spend': { balance: 3475.23, …, measured: true }`).

- [ ] **Step 2: Run them to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-check-only.test.ts shared/sync-core.test.ts`
Expected: `11 failed | 184 passed (195)` — the seven check-only tests (`checkBalancesOnly is not a function`; the first sees `[undefined, undefined]` for `fetchedAt`) and the four exact-shape assertions (no `fetchedAt`).

- [ ] **Step 3: Implement**

- `fetchedAt` doc on the snapshot interface: what it is, that a check-only run compares these figures only while no newer request has been sent (R16), and that a snapshot from an older build lacks it.
- Just before `const accountSet = await host.fetchSimplefin(...)`: `const fetchedAt = Date.now();` (Task 7 moves this up and sets it from the recorded request time). Add `fetchedAt,` to the `accountBalances[sfAccount.id] = { … }` literal.
- `checkBalancesOnly` as in Interfaces (import `AccountMapping` from `./types.js`). Read `store.getAccountBalances()` (a failed read is `{}`), `host.listAccounts()` (types; failure `[]`), `host.latestValuations(fresh wf ids)` (failure → null: nothing compared), `host.postedLedgerTotals` for the fresh unvalued ids (failure → none). Doc: what a manual Sync inside the gap does; nothing written but the badges; alerts, corrections and the episode ledger untouched as for B2 (R15); a stale baseline-fix offer dropped (a Deep scan re-offers it).
- `src/utils/secrets.ts`: `fetchedAt?: number` on `AccountBalanceInfo` with a one-line doc.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-check-only.test.ts shared/sync-core.test.ts` — Expected: `195 passed (195)`.
Type-check: clean.

- [ ] **Step 5: Full suites**

Root: `176` files, `3846` tests. Companion unchanged (`1536`). All pass.

- [ ] **Step 6: Commit**

```bash
git add shared/sync-core.ts shared/sync-core.test.ts shared/sync-core-check-only.test.ts src/utils/secrets.ts
git commit -m "A check-only pass re-checks every balance against the last download (C3, R9, R16)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: A SimpleFin download budget both writers share; manual Syncs inside five minutes only check (C1–C3, C6)

**Files:**
- Create: `shared/simplefin-budget.ts`
- Modify: `shared/sync-host.ts` (`SyncStore`), `shared/sync-core.ts` (`SyncResult`, `notDownloaded`, interval guard, the gate after the mapping check, `fetchedAt`), `shared/fake-host.ts`, `src/utils/secrets.ts`, `companion/src/rest-host.ts`
- Test: `shared/simplefin-budget.test.ts` (new), `shared/sync-core-budget.test.ts` (new), `src/utils/secrets.test.ts`, `companion/src/rest-host.test.ts`

**Interfaces:**
- Consumes: `checkBalancesOnly` and `fetchedAt` (Task 6); `SyncOptions.manual` (Task 5).
- Produces (shared/simplefin-budget.ts — imports nothing from the project):
  - `SIMPLEFIN_REQUESTS_SECRET_KEY = 'simplefin_requests'`, `SIMPLEFIN_DAILY_LIMIT = 20`, `SIMPLEFIN_SETUP_CEILING = 24`, `SIMPLEFIN_GAP_MS = 5 * 60_000`, `SIMPLEFIN_WINDOW_MS = 24 * 60 * 60_000`
  - `type SimplefinPurpose = 'manual' | 'scheduled' | 'auto' | 'setup'`
  - `type SimplefinGate = { kind: 'go'; at: Date } | { kind: 'checkOnly'; lastAt: Date } | { kind: 'wait'; lastAt: Date } | { kind: 'budget'; nextAt: Date } | { kind: 'unreadable' }`
  - `interface RequestLogIo { read(): Promise<string | null>; write(raw: string): Promise<void> }`
  - `parseRequestLog(raw): number[] | null` (ms, newest first; absent/empty → `[]`; anything but an array of parseable time strings → null)
  - `requestsInWindow(log, now): number[]` — every request newer than `now − 24 h`, future-stamped ones included, newest first
  - `decideSimplefinRequest(log, purpose, now): SimplefinGate` — limit 24 for `setup`, else 20; at/over the limit → `budget` with `nextAt` = (the window's requests oldest-first)[count − limit] + 24 h; else, except for `setup`, newest within the gap → `checkOnly` for `manual`, `wait` otherwise; else `{ kind: 'go', at: now }`
  - `reserveSimplefinRequest(io, purpose, now): Promise<SimplefinGate>` — read rejects → `unreadable`; corrupt → write `'[]'` (ignore its failure) and `unreadable`; on `go`, write `JSON.stringify([now, ...requestsInWindow(log, now)].map(ISO))` BEFORE returning, a rejected write → `unreadable`
  - `clockTime(d): string` ("3:10 PM", local, 12-hour); `gateLine(gate, now): string | null`; `checkedLine(dataAt: number | null, now): string`; `requestsToday(raw, now): number | null`; `budgetStatusLine(count: number): string`; `requestLogIo(store): RequestLogIo | null` (null unless both store methods exist)
  - Exact copy (minutes = `max(1, round(ms / 60000))`):
    - budget: `SimpleFin's daily limit is used up — next sync at ${clockTime(nextAt)}.`
    - unreadable: `Couldn't read the SimpleFin request log — nothing was downloaded.`
    - wait: `SimpleFin was asked ${n} min ago — this scheduled sync was skipped.`
    - checkOnly / `checkedLine(dataAt)`: `Balances checked · bank data is from ${n} min ago.`; `checkedLine(null)`: `Balances not checked — the last download is still being saved.`
    - status: `SimpleFin: ${count} of 20 today`
- Produces (core/stores):
  - `SyncStore.getSimplefinRequests?(): Promise<string | null>` (REJECTS when the record cannot be read) and `setSimplefinRequests?(raw: string): Promise<void>` on `SecretsStore` and `RestSyncStore` — key `simplefin_requests`, NOT in `KEYS` (Reset must not erase a count SimpleFin keeps).
  - `SyncResult.download?: { kind: 'checkOnly' | 'skipped'; line: string }` — absent on a run that downloaded; never an error.
  - `FakeHostSeed.requestLog?: { raw: string | null; failReads?: boolean }` — shared BY REFERENCE (two hosts given the same object are two writers sharing one count).

- [ ] **Step 1: Write the failing tests**

Create `shared/simplefin-budget.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  budgetStatusLine, checkedLine, clockTime, decideSimplefinRequest, gateLine, parseRequestLog, requestLogIo,
  requestsToday, reserveSimplefinRequest, SIMPLEFIN_DAILY_LIMIT, SIMPLEFIN_GAP_MS, SIMPLEFIN_SETUP_CEILING, type RequestLogIo,
} from './simplefin-budget.js';

// Local wall-clock dates, so "next sync at 3:10 PM" reads the same in every zone.
const NOW = new Date(2026, 9, 18, 15, 0, 0);
const minutes = (m: number) => NOW.getTime() - m * 60_000;
/** `n` requests, the newest `newestMinutesAgo` ago, one every 30 minutes before it. */
const logOf = (n: number, newestMinutesAgo = 60) => Array.from({ length: n }, (_, i) => minutes(newestMinutesAgo + i * 30));
const memoryIo = (raw: string | null): RequestLogIo & { raw: string | null } => {
  const io = { raw, read: async () => io.raw, write: async (v: string) => { io.raw = v; } };
  return io;
};

describe('the limits (C2, C5)', () => {
  it('are 20 a day, 24 for Setup and Refresh accounts, 5 minutes apart', () => {
    expect([SIMPLEFIN_DAILY_LIMIT, SIMPLEFIN_SETUP_CEILING, SIMPLEFIN_GAP_MS]).toEqual([20, 24, 300_000]);
  });
});

describe('decideSimplefinRequest', () => {
  it('lets the 20th download of the day through and refuses the 21st, for a sync and an automatic call alike', () => {
    for (const purpose of ['manual', 'scheduled', 'auto'] as const) {
      expect(decideSimplefinRequest(logOf(19), purpose, NOW)).toEqual({ kind: 'go', at: NOW });
      expect(decideSimplefinRequest(logOf(20), purpose, NOW).kind).toBe('budget');
    }
  });

  it('says when the oldest counted request leaves the 24 hours', () => {
    // 20 requests: the oldest was 60 + 19 × 30 = 630 minutes ago, so it leaves the window 24 h after.
    const gate = decideSimplefinRequest(logOf(20), 'manual', NOW);
    expect(gate).toEqual({ kind: 'budget', nextAt: new Date(minutes(630) + 24 * 3_600_000) });
  });

  it('lets Setup and Refresh accounts use the headroom up to 24, ignoring the gap', () => {
    expect(decideSimplefinRequest(logOf(23, 1), 'setup', NOW)).toEqual({ kind: 'go', at: NOW });
    expect(decideSimplefinRequest(logOf(24), 'setup', NOW).kind).toBe('budget');
  });

  it('inside 5 minutes of the last download: a manual action checks only, anything else waits', () => {
    expect(decideSimplefinRequest(logOf(3, 2), 'manual', NOW)).toEqual({ kind: 'checkOnly', lastAt: new Date(minutes(2)) });
    expect(decideSimplefinRequest(logOf(3, 2), 'scheduled', NOW)).toEqual({ kind: 'wait', lastAt: new Date(minutes(2)) });
    expect(decideSimplefinRequest(logOf(3, 2), 'auto', NOW).kind).toBe('wait');
    expect(decideSimplefinRequest(logOf(3, 5), 'manual', NOW).kind).toBe('go');
  });

  it('forgets requests older than 24 hours, and counts one the other writer stamped a little ahead', () => {
    expect(decideSimplefinRequest([...logOf(19), minutes(24 * 60 + 1)], 'scheduled', NOW).kind).toBe('go');
    expect(decideSimplefinRequest([NOW.getTime() + 60_000], 'manual', NOW).kind).toBe('checkOnly');
  });
});

describe('reserveSimplefinRequest (C1)', () => {
  it('records the request BEFORE the caller sends it, newest first, pruned to 24 hours', async () => {
    const io = memoryIo(JSON.stringify([new Date(minutes(10)).toISOString(), new Date(minutes(25 * 60)).toISOString()]));
    expect(await reserveSimplefinRequest(io, 'manual', NOW)).toEqual({ kind: 'go', at: NOW });
    expect(JSON.parse(io.raw!)).toEqual([NOW.toISOString(), new Date(minutes(10)).toISOString()]);
  });

  it('records nothing when it says no', async () => {
    const io = memoryIo(JSON.stringify(logOf(20).map((t) => new Date(t).toISOString())));
    const before = io.raw;
    expect((await reserveSimplefinRequest(io, 'manual', NOW)).kind).toBe('budget');
    expect(io.raw).toBe(before);
  });

  it('fails closed: a read that fails, a corrupt record (reset, so only this call is blocked), a write that fails', async () => {
    expect(await reserveSimplefinRequest({ read: async () => { throw new Error('401'); }, write: vi.fn() }, 'manual', NOW)).toEqual({ kind: 'unreadable' });
    const corrupt = memoryIo('{not json');
    expect(await reserveSimplefinRequest(corrupt, 'manual', NOW)).toEqual({ kind: 'unreadable' });
    expect(corrupt.raw).toBe('[]');
    expect((await reserveSimplefinRequest(corrupt, 'manual', NOW)).kind).toBe('go');
    expect(await reserveSimplefinRequest({ read: async () => null, write: async () => { throw new Error('offline'); } }, 'manual', NOW)).toEqual({ kind: 'unreadable' });
  });

  it('is absent for a store that keeps no record', () => {
    expect(requestLogIo({})).toBeNull();
    expect(requestLogIo({ getSimplefinRequests: async () => null, setSimplefinRequests: async () => {} })).not.toBeNull();
  });
});

describe('parseRequestLog', () => {
  it('reads a list of times newest first; absent is empty; anything else is corrupt', () => {
    expect(parseRequestLog(JSON.stringify(['2026-10-18T10:00:00.000Z', '2026-10-18T12:00:00.000Z'])))
      .toEqual([Date.parse('2026-10-18T12:00:00.000Z'), Date.parse('2026-10-18T10:00:00.000Z')]);
    expect(parseRequestLog(null)).toEqual([]);
    expect(parseRequestLog('{"a":1}')).toBeNull();
    expect(parseRequestLog('["not a time"]')).toBeNull();
  });
});

describe('the one lines (C3, C4)', () => {
  it('say why nothing was downloaded, each under 80 characters', () => {
    const lines = [
      gateLine({ kind: 'budget', nextAt: new Date(2026, 9, 18, 15, 10) }, NOW),
      gateLine({ kind: 'unreadable' }, NOW),
      gateLine({ kind: 'wait', lastAt: new Date(minutes(3)) }, NOW),
      gateLine({ kind: 'checkOnly', lastAt: new Date(minutes(3)) }, NOW),
      checkedLine(null, NOW),
    ];
    expect(lines).toEqual([
      "SimpleFin's daily limit is used up — next sync at 3:10 PM.",
      "Couldn't read the SimpleFin request log — nothing was downloaded.",
      'SimpleFin was asked 3 min ago — this scheduled sync was skipped.',
      'Balances checked · bank data is from 3 min ago.',
      'Balances not checked — the last download is still being saved.',
    ]);
    for (const line of lines) expect(line!.length).toBeLessThanOrEqual(80);
    expect(gateLine({ kind: 'go', at: NOW }, NOW)).toBeNull();
  });

  it('read the clock the way a person does', () => {
    expect([clockTime(new Date(2026, 9, 18, 0, 5)), clockTime(new Date(2026, 9, 18, 9, 0)), clockTime(new Date(2026, 9, 18, 12, 30)), clockTime(new Date(2026, 9, 18, 23, 59))])
      .toEqual(['12:05 AM', '9:00 AM', '12:30 PM', '11:59 PM']);
  });

  it('show the day\'s count quietly', () => {
    expect(requestsToday(JSON.stringify(logOf(7).map((t) => new Date(t).toISOString())), NOW)).toBe(7);
    expect(requestsToday(null, NOW)).toBe(0);
    expect(requestsToday('{bad', NOW)).toBeNull();
    expect(budgetStatusLine(7)).toBe('SimpleFin: 7 of 20 today');
  });
});
```

Create `shared/sync-core-budget.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { INTERVAL_SKIP_MESSAGE, runSyncCore, VALUATION_POLL } from './sync-core.js';
import { clockTime } from './simplefin-budget.js';
import type { SimplefinTransaction } from './types.js';

const NOW = new Date('2026-10-18T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const at = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000);
const tx = (id: string, iso: string, amount: string, description: string): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description });
/** `n` requests, the newest `newestMinutesAgo` before NOW, one every 30 minutes before it. */
const logOf = (n: number, newestMinutesAgo = 60) =>
  JSON.stringify(Array.from({ length: n }, (_, i) => at(-(newestMinutesAgo + i * 30)).toISOString()));

const seedOf = (requestLog: { raw: string | null; failReads?: boolean }, extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-spend', name: 'Spend', currency: 'USD', balance: '500.00', 'balance-date': epoch('2026-10-18T12:00:00Z'),
      transactions: [tx('pay', '2026-10-17T12:00:00Z', '100.00', 'PAYROLL')] },
  ] },
  mapping: { 'sfin-spend': 'wf-spend' },
  accountTypes: { 'wf-spend': 'CASH' },
  valuations: new Map([['wf-spend', 500]]),
  requestLog,
  ...extra,
});
const fetchSpy = (fh: ReturnType<typeof createFakeHost>) => vi.spyOn(fh.host, 'fetchSimplefin');
const requests = (log: { raw: string | null }) => (JSON.parse(log.raw ?? '[]') as string[]);

describe('runSyncCore — SimpleFin is never asked more often than it allows (C)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('refuses the 21st download in 24 hours — manual, /sync and scheduled — with the one line, and writes nothing', async () => {
    const line = `SimpleFin's daily limit is used up — next sync at ${clockTime(at(-630 + 24 * 60))}.`;
    for (const opts of [{ manual: true }, { manual: true, force: true }, {}]) {
      const log = { raw: logOf(20) };
      const fh = createFakeHost(seedOf(log));
      const fetch = fetchSpy(fh);
      const result = await runSyncCore(fh.host, fh.store, opts);
      expect(fetch).not.toHaveBeenCalled();
      expect(result.download).toEqual({ kind: 'skipped', line });
      expect(result.errors).toEqual([]);
      expect(fh.saved).toEqual([]);
      expect(requests(log)).toHaveLength(20);
    }
  });

  it('records each download before sending it, and a failed one still counts', async () => {
    const log = { raw: null as string | null };
    const fh = createFakeHost(seedOf(log));
    await runSyncCore(fh.host, fh.store, { manual: true });
    expect(requests(log)).toEqual([NOW.toISOString()]);

    vi.setSystemTime(at(10));
    fh.host.fetchSimplefin = async () => { throw new Error('SimpleFin is unreachable'); };
    await expect(runSyncCore(fh.host, fh.store, { manual: true })).rejects.toThrow('unreachable');
    expect(requests(log)).toEqual([at(10).toISOString(), NOW.toISOString()]);
  });

  it('a Sync 2 minutes after a download does not call SimpleFin and still re-checks balances', async () => {
    const log = { raw: null as string | null };
    const fh = createFakeHost(seedOf(log));
    await runSyncCore(fh.host, fh.store, { manual: true });
    // The payroll deposit was imported this run, so Spend could not be checked.
    expect((await fh.store.getAccountBalances())['sfin-spend']).toMatchObject({ measured: false });

    vi.setSystemTime(at(2));
    const fetch = fetchSpy(fh);
    for (const opts of [{ manual: true }, { manual: true, heal: true }]) {
      const result = await runSyncCore(fh.host, fh.store, opts);
      expect(result.download).toEqual({ kind: 'checkOnly', line: 'Balances checked · bank data is from 2 min ago.' });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(requests(log)).toHaveLength(1);
    expect((await fh.store.getAccountBalances())['sfin-spend']).toMatchObject({ measured: true, drift: null });
  });

  it('both writers share one count: the other writer\'s scheduled run inside the gap is skipped quietly', async () => {
    const log = { raw: null as string | null };
    const app = createFakeHost(seedOf(log));
    await runSyncCore(app.host, app.store, { manual: true });
    vi.setSystemTime(at(3));
    const companion = createFakeHost(seedOf(log));
    const fetch = fetchSpy(companion);
    const result = await runSyncCore(companion.host, companion.store, {});
    expect(fetch).not.toHaveBeenCalled();
    expect(result.download).toEqual({ kind: 'skipped', line: 'SimpleFin was asked 3 min ago — this scheduled sync was skipped.' });
    expect(result.errors).toEqual([]);
  });

  it('an unreadable record blocks the download', async () => {
    const fh = createFakeHost(seedOf({ raw: null, failReads: true }));
    const fetch = fetchSpy(fh);
    const result = await runSyncCore(fh.host, fh.store, { manual: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.download).toEqual({ kind: 'skipped', line: "Couldn't read the SimpleFin request log — nothing was downloaded." });
  });

  it('the one-hour wall is gone for manual actions, and stays for scheduled runs (C6)', async () => {
    const log = { raw: logOf(1, 10) };
    const fh = createFakeHost(seedOf(log));
    await fh.store.setLastSyncAt(at(-10));
    const fetch = fetchSpy(fh);
    expect((await runSyncCore(fh.host, fh.store, {})).errors).toEqual([INTERVAL_SKIP_MESSAGE]);
    expect(fetch).not.toHaveBeenCalled();
    const manual = await runSyncCore(fh.host, fh.store, { manual: true });
    expect(manual.download).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a store with no record downloads as before', async () => {
    const seed = seedOf({ raw: null });
    delete seed.requestLog;
    const fh = createFakeHost(seed);
    const fetch = fetchSpy(fh);
    expect((await runSyncCore(fh.host, fh.store, { manual: true })).download).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
```

In `src/utils/secrets.test.ts`, before "reads the learned transfer names the companion publishes…":

```ts
  it('keeps the SimpleFin request record under the key the companion shares, and Reset leaves it (1.64, C1)', async () => {
    const { ctx, data } = makeCtxWithData();
    const s = new SecretsStore(ctx);
    expect(await s.getSimplefinRequests()).toBeNull();
    await s.setSimplefinRequests('["2026-10-18T15:00:00.000Z"]');
    expect(data['simplefin_requests']).toBe('["2026-10-18T15:00:00.000Z"]');
    await s.clearAll();
    // SimpleFin keeps counting after a Reset, so the record does too.
    expect(data['simplefin_requests']).toBe('["2026-10-18T15:00:00.000Z"]');
    ctx.api.secrets.get.mockRejectedValueOnce(new Error('401'));
    await expect(s.getSimplefinRequests()).rejects.toThrow('401');
  });
```

In `companion/src/rest-host.test.ts`, inside `describe('RestSyncStore')`, before "reads the learned transfer names it publishes…":

```ts
  it('reads and writes the SimpleFin request record under the key the add-on shares, and a failed read rejects (1.64, C1)', async () => {
    const secrets = new Map<string, string>();
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;
    const store = new RestSyncStore(client);
    await store.setSimplefinRequests('["2026-10-18T15:00:00.000Z"]');
    expect(secrets.get('simplefin_requests')).toBe('["2026-10-18T15:00:00.000Z"]');
    expect(await store.getSimplefinRequests()).toBe('["2026-10-18T15:00:00.000Z"]');
    client.getAddonSecret.mockRejectedValueOnce(new Error('401'));
    await expect(store.getSimplefinRequests()).rejects.toThrow('401');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 shared/simplefin-budget.test.ts shared/sync-core-budget.test.ts src/utils/secrets.test.ts`
Expected: both budget files fail to load ("Failed to resolve import ./simplefin-budget.js"); `1 failed | 47 passed (48)`.
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/rest-host.test.ts)` — Expected: `1 failed | 21 passed (22)`.

- [ ] **Step 3: Implement**

- `shared/simplefin-budget.ts` as in Interfaces; the header carries the why (nothing limited downloads; "Sync anyway" and `/sync` bypassed the hour; Bridge expects ~24 a day, warns, then disables the token, cutting off every bank — link https://beta-bridge.simplefin.org/info/developers) and the rules (C2, R8, C5, R17).
- `shared/sync-core.ts`:
  - `SyncResult.download` with its doc; `notDownloaded()` (every array empty, `unmappedAccounts: null`, `holdingsSnapshots: noHoldings()`), a function, placed above `noHoldings`.
  - The interval guard becomes `if (!opts.manual && !opts.force && !heal && lastSync && …)` with a comment: scheduled runs only (C6, R18); a person is governed by the gap and the daily limit, because a Sync pressed 5–60 minutes after the last one used to check nothing.
  - Right after the "Not configured: no account mapping" return, before `const rules = await store.getMappingRules();`:

    ```ts
    const requestLog = requestLogIo(store);
    let fetchedAt = Date.now();
    if (requestLog) {
      const now = new Date();
      const gate = await reserveSimplefinRequest(requestLog, opts.manual ? 'manual' : 'scheduled', now);
      if (gate.kind === 'checkOnly') {
        const { dataAt } = await checkBalancesOnly(host, store, { mapping, newestRequestAt: gate.lastAt.getTime() });
        return { ...notDownloaded(), download: { kind: 'checkOnly', line: checkedLine(dataAt, now) } };
      }
      if (gate.kind !== 'go') {
        const line = gateLine(gate, now)!;
        console.log(`[simplefin-sync] ${line}`);
        return { ...notDownloaded(), download: { kind: 'skipped', line } };
      }
      fetchedAt = gate.at.getTime();
    }
    ```

    (comment: recorded BEFORE the download is sent — SimpleFin counts attempts; one record shared with the other writer; fails closed; a store with no record keeps no budget). Remove Task 6's `const fetchedAt = Date.now();` before `fetchSimplefin` (leave a one-line comment that `fetchedAt` is stamped on every bank figure).
- `shared/sync-host.ts`: the two optional methods, documented ("both or neither").
- `src/utils/secrets.ts`, `companion/src/rest-host.ts`: the two methods (raw get/set of the key). Comment on the add-on side why the key is not in `KEYS`.
- `shared/fake-host.ts`: the `requestLog` seed and, when present, the two store methods (`failReads` → reject with `secrets unavailable`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice npx vitest run --maxWorkers=2 shared/simplefin-budget.test.ts shared/sync-core-budget.test.ts src/utils/secrets.test.ts` — Expected: `69 passed (69)`.
Run the two budget files again under `TZ=America/New_York` and `TZ=Pacific/Auckland` — Expected: `21 passed (21)` each (the verified replay also ran UTC).
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/rest-host.test.ts)` — Expected: `22 passed (22)`.
Type-check and companion build: clean.

- [ ] **Step 5: Full suites**

Root: `178` files, `3868` tests. Companion: `69` files, `1537` tests. All pass.

- [ ] **Step 6: Commit**

```bash
git add shared/simplefin-budget.ts shared/simplefin-budget.test.ts shared/sync-core-budget.test.ts shared/sync-host.ts shared/sync-core.ts shared/fake-host.ts src/utils/secrets.ts src/utils/secrets.test.ts companion/src/rest-host.ts companion/src/rest-host.test.ts
git commit -m "A SimpleFin download budget both writers share; manual Syncs inside five minutes only check (C1-C3, C6)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Telegram — `/sync` is a manual action answered in one line; `/status` shows the day's count (C3, C4, C6)

**Files:**
- Modify: `shared/telegram-commands.ts` (`StatusReplyInput`, `formatStatusReply`, new `formatSyncSkipReply` after `formatSyncReply`), `companion/src/index.ts` (`runCompanionSync`, `startTelegramSync`, the `case 'sync'` comment, `readStatusReplyInput`)
- Test: `shared/telegram-commands.test.ts`, `companion/src/index.test.ts`

**Interfaces:**
- Consumes: `budgetStatusLine`, `requestsToday`, `SIMPLEFIN_REQUESTS_SECRET_KEY` (Task 7); `SyncResult.download` (Task 7).
- Produces:
  - `StatusReplyInput.simplefinToday?: number | null` — `formatStatusReply` pushes `budgetStatusLine(n)` right after the "Last sync" line when it is a number.
  - `export function formatSyncSkipReply(line: string): string` = `escapeMarkdown(line)`.
  - `runCompanionSync(opts: { force?: boolean; manual?: boolean } = {})` passes `manual: true` to `runSyncCore` when set and logs `Sync: ${result.download.line}` when the run did not download.

- [ ] **Step 1: Write the failing tests**

In `shared/telegram-commands.test.ts`, add `formatSyncSkipReply` to the import list (after `formatSyncReply`) and insert before `describe('formatSyncReply', …)`:

```ts
describe('formatStatusReply — the SimpleFin count (1.64, C4)', () => {
  const input: StatusReplyInput = { version: '1.64.0', lastSyncAt: null, lastSyncSummary: null, accounts: [], uncategorizedCount: null, amazonUnparsed: null };
  it('shows "SimpleFin: N of 20 today" when the count was read, and nothing otherwise', () => {
    expect(formatStatusReply({ ...input, simplefinToday: 7 }, now)).toContain('SimpleFin: 7 of 20 today');
    expect(formatStatusReply({ ...input, simplefinToday: null }, now)).not.toContain('SimpleFin:');
    expect(formatStatusReply(input, now)).not.toContain('SimpleFin:');
  });
});

describe('formatSyncSkipReply (1.64, C3)', () => {
  it('is the one line, escaped for Markdown', () => {
    expect(formatSyncSkipReply("SimpleFin's daily limit is used up — next sync at 3:10 PM.")).toBe("SimpleFin's daily limit is used up — next sync at 3:10 PM.");
    expect(formatSyncSkipReply('a_b')).toBe('a\\_b');
  });
});
```

In `companion/src/index.test.ts`, inside `describe('buildTelegramCommandHandler')`, before "runs /sync FORCED, so a command typed minutes after the cron tick is not refused…":

```ts
  it('runs /sync as a manual action, and answers a run the SimpleFin budget refused with just its one line (1.64, C3, C6)', async () => {
    vi.mocked(runSyncCore).mockClear();
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      ...FAKE_SYNC_RESULT, download: { kind: 'skipped', line: "SimpleFin's daily limit is used up — next sync at 3:10 PM." },
    });
    const secrets = new Map<string, string>([['simplefin_access_url', 'https://user:pass@bridge.simplefin.org/simplefin']]);
    const client: any = {
      login: vi.fn(async () => {}),
      getAddonSecret: vi.fn(async (_a: string, k: string) => secrets.get(k) ?? null),
      setAddonSecret: vi.fn(async (_a: string, k: string, v: string) => { secrets.set(k, v); }),
    };
    const { WealthfolioClient } = await import('./wealthfolio.js');
    vi.mocked(WealthfolioClient).mockImplementation(function () { return client; } as any);
    const { sent, reply } = collector();
    await buildTelegramCommandHandler(client)({ command: 'sync', args: '' }, reply);
    await waitFor('the sync summary', () => sent.length >= 2);
    expect(vi.mocked(runSyncCore).mock.calls[0][2]).toMatchObject({ force: true, manual: true });
    expect(sent[1]).toBe("SimpleFin's daily limit is used up — next sync at 3:10 PM.");
  });

  it('/status shows the day\'s SimpleFin count quietly, and no line when the record cannot be read (1.64, C4)', async () => {
    const recent = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const { client } = clientFor([['simplefin_requests', JSON.stringify([recent(5), recent(90), recent(26 * 60)])]]);
    expect((await run(client, 'status'))[0]).toContain('SimpleFin: 2 of 20 today');
    client.getAddonSecret.mockImplementation(async (_a: string, k: string) => {
      if (k === 'simplefin_requests') throw new Error('401');
      return null;
    });
    expect((await run(client, 'status'))[0]).not.toContain('SimpleFin:');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 shared/telegram-commands.test.ts` — Expected: `2 failed | 134 passed (136)`.
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/index.test.ts)` — Expected: `2 failed | 346 passed (348)`.

- [ ] **Step 3: Implement**

- `shared/telegram-commands.ts`: as in Interfaces (import `budgetStatusLine` from `./simplefin-budget.js`). `formatSyncSkipReply`'s doc: the whole reply — "0 imported" beside "the limit is used up" would read as a sync that ran and found nothing.
- `companion/src/index.ts`:
  - `runCompanionSync` signature and the `runSyncCore(host, store, { force, changeLog, ...(opts.manual ? { manual: true } : {}) })` call (comment: `/sync` is a person, so no one-hour wall; the budget applies); after the `Sync note:` loop, `if (result.download) log(\`Sync: ${result.download.line}\`);` (a status line, never an alert).
  - `startTelegramSync`: `runCompanionSync({ force: true, manual: true })`; summary `r.download ? formatSyncSkipReply(r.download.line) : formatSyncReply({...})`. Import `formatSyncSkipReply`.
  - Rewrite the `case 'sync':` comment: MANUAL, unlike the cron tick (1.64, C6) — no one-hour wall; the budget applies (inside five minutes only a re-check; with the day's 20 used, refused in one line); still forced, so it re-pulls the 30-day window as before.
  - `readStatusReplyInput`: `const requestsRead = await readableSecret(SIMPLEFIN_REQUESTS_SECRET_KEY); const simplefinToday = requestsRead.read ? requestsToday(requestsRead.raw, new Date()) : null;` and `simplefinToday` in the returned object (a failed read is no line, never "0 of 20").

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice npx vitest run --maxWorkers=2 shared/telegram-commands.test.ts` — Expected: `136 passed (136)`.
Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/index.test.ts)` — Expected: `348 passed (348)`.
Type-check and companion build: clean.

- [ ] **Step 5: Full suites**

Root: `178` files, `3870` tests. Companion: `69` files, `1539` tests. All pass.

- [ ] **Step 6: Commit**

```bash
git add shared/telegram-commands.ts shared/telegram-commands.test.ts companion/src/index.ts companion/src/index.test.ts
git commit -m "Telegram: /sync is a manual action answered in one line when SimpleFin is not asked; /status shows the day's count (C3, C4, C6)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The app — every SimpleFin call counts, one-line Sync notices, the day's count, no "Sync anyway" (C3–C6)

**Files:**
- Modify: `shared/simplefin-budget.ts` (append `directCallLine`)
- Modify: `src/pages/SetupPage.tsx` (`handleConnect`), `src/tabs/SettingsTab.tsx` (`loadAccounts`), `src/pages/SyncPage.tsx` (state, `backfillNames`, `refreshLiveState`, `doSync`, `doHeal`, header, callout), `src/components/SyncStatus.tsx`, `src/components/ui.tsx` (drop `.sfin-callout-action`)
- Test: `shared/simplefin-budget.test.ts`, `src/pages/SyncPage.test.tsx`, `src/pages/SetupPage.test.tsx`, `src/tabs/SettingsTab.test.tsx`

**Interfaces:**
- Consumes: `requestLogIo`, `reserveSimplefinRequest`, `gateLine`, `requestsToday`, `budgetStatusLine` (Task 7); `SyncResult.download` (Task 7); `SyncOptions.manual` (Task 5).
- Produces:
  - `export async function directCallLine(store: Parameters<typeof requestLogIo>[0], purpose: 'setup' | 'auto', now = new Date()): Promise<string | null>` — null when the call may go ahead (recorded) or the store keeps no record; otherwise `gateLine(...)`.
  - `SyncStatus` prop `simplefinToday?: number | null` → appends ` • ${budgetStatusLine(n)}` after the imported count.
  - `SyncPage`: `doSync()` takes no argument; no `intervalBlocked`, no "Sync anyway", no `INTERVAL_SKIP_MESSAGE` import.

- [ ] **Step 1: Write the failing tests**

Append to `shared/simplefin-budget.test.ts` (add `directCallLine` to its import):

```ts
describe('directCallLine — a SimpleFin call outside a sync (C5)', () => {
  it('records and allows Setup into the headroom; refuses an automatic call past 20 or inside the gap', async () => {
    let raw: string | null = JSON.stringify(logOf(23, 1).map((t) => new Date(t).toISOString()));
    const store = { getSimplefinRequests: async () => raw, setSimplefinRequests: async (v: string) => { raw = v; } };
    expect(await directCallLine(store, 'setup', NOW)).toBeNull();
    expect(JSON.parse(raw!)).toHaveLength(24);
    expect(await directCallLine(store, 'setup', NOW)).toMatch(/^SimpleFin's daily limit is used up/);
    raw = JSON.stringify(logOf(3, 2).map((t) => new Date(t).toISOString()));
    expect(await directCallLine(store, 'auto', NOW)).not.toBeNull();
    expect(await directCallLine({}, 'auto', NOW)).toBeNull();
  });
});
```

In `src/pages/SyncPage.test.tsx`: change the import to `import { runSync } from '../utils/sync';` (the `vi.mock` may keep re-exporting `INTERVAL_SKIP_MESSAGE`; reword its comment — the page no longer compares against it); DELETE the test "refreshes the displayed last-synced time when a sync reports the interval skip" (a manual Sync never gets the interval skip any more); in its place:

```ts
  it('says in one line, as a status, why SimpleFin was not asked — and offers no "Sync anyway" (1.64, C3, C6)', async () => {
    const props = makeProps();
    vi.mocked(runSync).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], download: { kind: 'skipped', line: "SimpleFin's daily limit is used up — next sync at 3:10 PM." },
    } as any);
    render(<SyncPage {...props} />);
    await waitFor(() => screen.getByRole('button', { name: /sync now/i }));
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    const status = await screen.findByText("SimpleFin's daily limit is used up — next sync at 3:10 PM.");
    expect(status.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /sync anyway/i })).not.toBeInTheDocument();
  });

  it('re-reads the balances after a check-only Sync, and says how old the bank data is (1.64, C3)', async () => {
    const props = makeProps();
    vi.mocked(runSync).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [], download: { kind: 'checkOnly', line: 'Balances checked · bank data is from 2 min ago.' },
    } as any);
    render(<SyncPage {...props} />);
    await waitFor(() => screen.getByRole('button', { name: /sync now/i }));
    const reads = props.store.getAccountBalances.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /sync now/i }));
    expect(await screen.findByText('Balances checked · bank data is from 2 min ago.')).toBeInTheDocument();
    await waitFor(() => expect(props.store.getAccountBalances.mock.calls.length).toBeGreaterThan(reads));
  });

  it('shows the day\'s SimpleFin count quietly beside the last sync (1.64, C4)', async () => {
    const props = makeProps();
    const recent = Array.from({ length: 7 }, (_, i) => new Date(Date.now() - (10 + i) * 60_000).toISOString());
    props.store.getSimplefinRequests = vi.fn(async () => JSON.stringify(recent));
    render(<SyncPage {...props} />);
    expect(await screen.findByText(/SimpleFin: 7 of 20 today/)).toBeInTheDocument();
  });
```

Append inside `describe('SetupPage')` in `src/pages/SetupPage.test.tsx`:

```ts
  it('counts Setup against the SimpleFin budget: refused at 24 in one line, before the token is claimed (1.64, C5)', async () => {
    const { claimToken } = await import('../utils/simplefin');
    vi.mocked(claimToken).mockClear();
    vi.mocked(fetchAccounts).mockClear();
    const props = makeProps();
    const recent = Array.from({ length: 24 }, (_, i) => new Date(Date.now() - (60 + i) * 60_000).toISOString());
    props.store.getSimplefinRequests = vi.fn(async () => JSON.stringify(recent));
    props.store.setSimplefinRequests = vi.fn(async () => {});
    render(<SetupPage {...props} />);
    fireEvent.change(screen.getByPlaceholderText(/setup token/i), { target: { value: 'token' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    expect(await screen.findByText(/SimpleFin's daily limit is used up — next sync at/)).toBeInTheDocument();
    expect(claimToken).not.toHaveBeenCalled();
    expect(fetchAccounts).not.toHaveBeenCalled();
  });
```

In `src/tabs/SettingsTab.test.tsx`, inside `describe('Accounts card')`, before "reports a bridge failure instead of showing an empty mapper":

```ts
    it('counts a refresh against the SimpleFin budget: allowed into the headroom, refused at 24 with the one line (1.64, C5)', async () => {
      const { fetchAccounts } = await import('../utils/simplefin');
      const recent = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => new Date(Date.now() - (60 + i) * 60_000).toISOString()));
      const run = async (count: number) => {
        vi.mocked(fetchAccounts).mockClear();
        const props = makeProps();
        let raw: string | null = recent(count);
        props.store.getSimplefinRequests = vi.fn(async () => raw);
        props.store.setSimplefinRequests = vi.fn(async (v: string) => { raw = v; });
        const view = render(<SyncPage {...props} />);
        await switchTab(/settings/i);
        await openMapper();
        return { view, raw: () => raw };
      };
      const allowed = await run(20);
      await waitFor(() => expect(fetchAccounts).toHaveBeenCalledOnce());
      expect(JSON.parse(allowed.raw()!)).toHaveLength(21);
      allowed.view.unmount();

      await run(24);
      expect(await screen.findByText(/SimpleFin's daily limit is used up — next sync at/)).toBeInTheDocument();
      expect(fetchAccounts).not.toHaveBeenCalled();
    });

    it('skips the automatic name backfill quietly once the day\'s 20 are used (1.64, C5)', async () => {
      const { fetchAccounts } = await import('../utils/simplefin');
      const recent = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => new Date(Date.now() - (60 + i) * 60_000).toISOString()));
      for (const [count, calls] of [[20, 0], [3, 1]] as const) {
        vi.mocked(fetchAccounts).mockClear();
        const props = makeProps();
        props.store.getAccountNames = vi.fn(async () => ({}));
        props.store.getSimplefinRequests = vi.fn(async () => recent(count));
        props.store.setSimplefinRequests = vi.fn(async () => {});
        const view = render(<SyncPage {...props} />);
        await waitFor(() => expect(props.store.getSimplefinRequests).toHaveBeenCalled());
        await waitFor(() => expect(fetchAccounts).toHaveBeenCalledTimes(calls));
        expect(props.store.setSimplefinRequests).toHaveBeenCalledTimes(calls);
        view.unmount();
      }
    });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 src/pages/SyncPage.test.tsx src/pages/SetupPage.test.tsx src/tabs/SettingsTab.test.tsx shared/simplefin-budget.test.ts`
Expected: `7 failed | 74 passed (81)` — `directCallLine is not a function`; the three SyncPage tests (no status line, no count); Setup's refusal; Settings' refresh and backfill.

- [ ] **Step 3: Implement**

- `shared/simplefin-budget.ts`: `directCallLine` with a doc naming the three callers and their purposes (C5).
- `src/pages/SetupPage.tsx` (`handleConnect`, first thing inside the `try`): `const refused = await directCallLine(store, 'setup'); if (refused) { setError(refused); return; }` — comment: asked BEFORE the one-time token is claimed, so a refusal costs nothing.
- `src/tabs/SettingsTab.tsx` (`loadAccounts`, after the access-URL check): the same with `setAccountsError(refused)`.
- `src/pages/SyncPage.tsx`:
  - `backfillNames`: after the access-URL check, `if (await directCallLine(store, 'auto')) return;` (automatic, obeys the budget like a sync; cosmetic, so it just skips).
  - State: `syncNotice: string | null` (replaces `intervalBlocked`) and `simplefinToday: number | null`. A `readSimplefinCount` callback: `store.getSimplefinRequests?.().then((raw) => setSimplefinToday(requestsToday(raw, new Date()))).catch(() => {})`, called from `refreshLiveState` (add it to that callback's deps) and right after each `runSync` in `doSync`/`doHeal`.
  - `doSync()`: `runSync(ctx, store, { manual: true })`; after it, `if (result.download) { setSyncNotice(result.download.line); if (result.download.kind === 'checkOnly') loadBalances(); return; }` before the existing error/imported handling; `setSyncNotice(null)` at the start. `doHeal`: the same three lines. Header button: `onClick={() => doSync()}`.
  - Replace the interval-skip callout with `{syncNotice && (<div className="sfin-callout" role="status">{syncNotice}</div>)}`.
  - `<SyncStatus … simplefinToday={simplefinToday} />`.
- `src/components/SyncStatus.tsx`: the prop and the suffix.
- `src/components/ui.tsx`: delete the `.sfin-callout-action` rule and its comment (its only user is gone).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice npx vitest run --maxWorkers=2 src/pages/SyncPage.test.tsx src/pages/SetupPage.test.tsx src/tabs/SettingsTab.test.tsx shared/simplefin-budget.test.ts` — Expected: `81 passed (81)`, under both `TZ=UTC` and `TZ=America/New_York`.
Type-check: clean.

- [ ] **Step 5: Full suites**

Root: `178` files, `3876` tests. Companion: `69` files, `1539` tests. All pass.

- [ ] **Step 6: Commit**

```bash
git add shared/simplefin-budget.ts shared/simplefin-budget.test.ts src/pages/SetupPage.tsx src/pages/SetupPage.test.tsx src/tabs/SettingsTab.tsx src/tabs/SettingsTab.test.tsx src/pages/SyncPage.tsx src/pages/SyncPage.test.tsx src/components/SyncStatus.tsx src/components/ui.tsx
git commit -m "The app: every SimpleFin call counts, one-line Sync notices, the day's count, no Sync anyway (C3-C6)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs — CHANGELOG `## [Unreleased]` and follow-ups §20

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`, which is empty), `docs/superpowers/follow-ups.md` (new §20 after §19, before "## Reference: name mismatches…")

**Interfaces:** none.

- [ ] **Step 1: Write the CHANGELOG entry** — exactly:

```markdown
### Added
- **A transfer between your accounts is held whichever half posts first.**
  The companion learns the bank wording of every transfer it has seen linked
  in the last year (per account and direction, reference numbers left out),
  and both the app and the companion hold the next one as a transfer while
  its other half is on the way: a savings → PNC deposit that lands first, and
  360 Checking's "Withdrawal to 360 Performance Savings". It links when the
  other half posts and, as before, counts as ordinary money in or out marked
  "Needs review" after 10 days. Card accounts, wording made only of generic
  bank words, rows a rule types and stored paybacks are never touched, and
  one "Not a transfer" Undo stops trusting that wording. Without the
  companion nothing changes.
- **Pressing Sync checks every account, cards included.** After the run's own
  saves the app adds up each card's whole history and compares it with
  SimpleFin's posted balance, so a card reads "in sync" or "off by $X"
  instead of "not checked" — even with pending charges, and even when the
  run imported a new charge. The companion does the same, reading the
  database live. This changes the badge only; alerts and corrections work as
  before. A card with a transfer still on its way stays "not checked".
- **SimpleFin is never asked more often than it allows.** Both the app and
  the companion share one record of SimpleFin requests: at most 20 a day,
  5 minutes apart, failed requests included. When the day's 20 are used up,
  Sync and `/sync` say so in one line ("SimpleFin's daily limit is used up —
  next sync at 3:10 PM") and scheduled syncs skip quietly. Setup and Refresh
  accounts may go up to 24. The Sync status and `/status` show
  "SimpleFin: 7 of 20 today".

### Changed
- **No more "Sync anyway".** The one-hour wait no longer applies to Sync,
  Deep scan or `/sync`. Pressed within 5 minutes of the last download, they
  re-check every balance against that download instead of asking SimpleFin
  again ("Balances checked · bank data is from 3 min ago."). Scheduled syncs
  keep their schedule and the one-hour minimum.
- **The companion's card balances read Wealthfolio's own types.** A row whose
  type you changed in Wealthfolio is now counted the way Wealthfolio counts
  it, so a card with such a row may read differently than before.

### Fixed
- **Evening syncs no longer fail the Robinhood holdings snapshot.** The
  snapshot is dated by your local day; after 8 PM Eastern it used the next UTC
  day, which Wealthfolio refused.
```

- [ ] **Step 2: Write follow-ups §20** — exactly:

```markdown
## 20. Learned transfer names, every account checked, a SimpleFin budget (2026-10-18, plan `2026-10-18-learned-transfers-and-sync-budget.md`)

- **An Undo blocks a name only once the companion recomputes.** The
  `notTransfer` block (A3, R4) is applied where the list is learned, at the
  start of each companion sync. An app Sync before that still uses the name
  for the account's other rows (the undone row itself is protected by its own
  override).
- **A stored payback outside the learned names can still pair.** R13 keeps a
  learned-name row whose stored form is a payback out of learned typing and
  pairing. Pairing itself ignores types, so a payback whose wording was never
  learned can still meet a same-amount outflow in another account within 5
  days (pre-existing).
- **A blank `activity_type_override`.** The companion's SQL reads a blank
  override as none; what `activities.search` hands the app for one is not
  verified, so the two card totals could disagree on such a row.
- **The request record has no lock.** Two writers recording in the same
  instant can lose one entry (one request uncounted). A corrupt record blocks
  one download and is reset to empty, forgetting the day's count (R8).
- **A check-only Sync trusts the valuation as it stands.** Inside the gap a
  cash account is compared with its current valuation; Wealthfolio
  recomputes valuations asynchronously, and a valuation that has not caught
  up with the previous run's imports reads as drift for a few minutes.
- **A scheduled run inside the 5-minute gap is skipped** with a status line
  (the spec's table covers manual runs and the daily limit only).
- **"Next sync at"** is when the request holding the window at the limit
  leaves it — the oldest one at exactly 20; later when Setup used the
  headroom above 20.
- **Learning reads the whole ledger** at the start of every companion sync
  (`getNativeAuditLedger`, as the audits do). Fine at personal scale.
- **A check-only run drops a baseline-fix offer**; the next Deep scan offers it
  again when it still applies.
```

- [ ] **Step 3: Verify**

Run: `grep -n '^## \[Unreleased\]' -A3 CHANGELOG.md` and `grep -n '^## 20\. ' docs/superpowers/follow-ups.md` — both found; §20 sits after §19.

- [ ] **Step 4: The four gates, once**

Run, one at a time: `nice npm test -- --maxWorkers=2`; `(cd companion && nice npx vitest run --maxWorkers=2)`; `nice npm run type-check`; `nice npm --prefix companion run build`.
Expected: root `178 passed (178)` files, `3876 passed (3876)` tests; companion `69 passed (69)` files, `1539 passed (1539)` tests; type-check and build exit 0.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md docs/superpowers/follow-ups.md
git commit -m "Docs: 1.64 in the CHANGELOG, follow-ups §20

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Verification record (scratch replay, 2026-10-18/19)

- Baseline at 70d8e8a on the owner's machine (`TZ` America/New_York): root `1 failed | 169 passed (170)` files, `1 failed | 3793 passed (3794)` tests (the holdings test, Task 1); companion `67` files, `1526` tests, all pass; type-check and companion build clean.
- Each task's Step 2 and Step 4 counts above were read off the replay (Tasks 4, 6 and 9 re-run on a worktree of the previous task's commit with that task's final test files).
- After Task 10: root `178` files / `3876` tests, companion `69` / `1539`, type-check 0, build 0. The release's test files pass under `TZ=UTC` and `TZ=America/New_York` (root 12 files / 320 tests; companion 5 files / 481 tests); the budget files also under `TZ=Pacific/Auckland`.
