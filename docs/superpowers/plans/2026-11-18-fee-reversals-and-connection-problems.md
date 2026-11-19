# Fee reversals (#79) and SimpleFin connection problems (#81) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Type a bank fee coming back as a refund (and, in the companion, file it under the fee's category), and show SimpleFin's connection problems everywhere instead of letting stale figures look current.

**Architecture:** #79 adds a fee-reversal branch to the shared mapper (both writers), keeps those rows out of transfer pairing, and adds a companion-only filing pass beside the Amazon filing, built on a pure matcher in `shared/fee-reversal.ts`. #81 asks SimpleFIN Bridge for protocol v2, normalises v2 back to v1's `org`, and has the shared sync core keep a `simplefin_problems` record (read, merge, write after every 200) that the add-on banner, Telegram, the daily report, Home Assistant and `/status` all read through `shared/connection-problems.ts`.

**Tech Stack:** TypeScript, React 19 (add-on), Node + `node:sqlite` / `sqlite3` CLI (companion), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-18-issues-79-83-design.md`, sections "#79: fee reversals import as income" and "#81: stale institution data looks current", plus their CHANGELOG/README lines. #83 and #80 are another plan's; do not touch them. The design's order of work is #83 → #80 → #79 → #81, so this plan runs after that one: find code by the anchors quoted below, not by line number.

Verified on a scratch clone of `fix/issues-79-83` at 995eece: every task applied in order, every Step 2 seen failing for the stated reason and every Step 4 passing with the counts given.

## Global Constraints

- Gates: `nice npx vitest run --maxWorkers=2`, `(cd companion && nice npx vitest run --maxWorkers=2)` (never `--root`), `npm run type-check`, `nice npm --prefix companion run build`.
- Every vitest run uses `nice` and `--maxWorkers=2` (the machine overheats). While working a task, run single files only.
- Tests pin their dates (a fixed `NOW`, or `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(...)` restored in `afterEach`) and must pass with the clock forced into 2027 (Task 16).
- Fee words: `fee`/`fees` as whole words (so "COFFEE" never matches), `service charge`, `late charge`. Reversal words: waived/waiver, reversal/reversed, refund/refunded, rebate, reimbursement, adjustment/adj, credit.
- Fixture lists (verbatim): matches "Monthly Maintenance Fee Waived", "ADJUST FEE CHARGED ATM FEE REBATE", "LATE CHARGE ADJUSTMENT", "LATE PAYMENT FEE REVERSAL", "OVERDRAFT FEE REFUND", "ATM FEE REIMBURSEMENT", "SERVICE CHARGE REVERSAL"; non-matches "TAX REFUND", "COFFEE REFUND", "AMAZON REFUND", "MONTHLY MAINTENANCE FEE", and any outflow.
- A fee reversal is `CREDIT`, subtype `REFUND`, `fromRule: false`, `feeReversal: true`. Never `REIMBURSEMENT` (that means "payback"). Checked after the user rule, before the card-payment and bank-transfer keywords.
- The category pass is companion only, never touches a row with a spending (expense-kind) category, and treats an income-kind category as none.
- `version=2` goes only to SimpleFIN Bridge hosts (`simplefin.org` and subdomains). Lunch Flow's request is unchanged byte for byte.
- v2 → v1: `org.name ← connection.name` (NOT `org_name`), `domain ← host of org_url`, `url ← org_url`, `'sfin-url' ← sfin_url`; the account keeps `conn_id`.
- The record is the add-on secret `simplefin_problems`: `{checkedAt, problems: [{key, code, kind: 'signin' | 'other', connectionName?, sfinAccountIds, message, firstSeenAt, lastSeenAt}]}`.
- `signin` = `con.auth`, `gen.auth`, shown at once; everything else `other`, shown once it has lasted 24 hours; the add-on ignores a record whose `checkedAt` is more than 48 hours old. Never kept: window notices (`isSimplefinNotice`), `gen.api`, problems whose known accounts are all unmapped or ignored.
- `message` is plain text, at most 200 characters. Telegram text is Markdown-escaped (`escapeMarkdown`). No emoji in add-on copy (`src/pages/copy-policy.test.tsx`).
- Home Assistant alert ids include `firstSeenAt`; there is no Home Assistant "updating again" alert. `/status` carries a count only, no names.
- New store methods are optional on `SyncStore` and optional-called (`store.x?.()`), like `setUnmappedAccounts`.
- CHANGELOG lines go under `## [Unreleased]` only, no version bump. The #83/#80 plan adds lines there too: keep both.
- Commit messages end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Run `gh api user --jq .login` before any gh write (it must be Bubbles840). No push, merge or tag without Nick's go-ahead.

## Rulings made while verifying

The spec leaves these open or did not foresee them. Each is decided here and pinned by a test.

1. **Unknown account type.** The mapper reads a fee reversal on CASH, CREDIT_CARD, or an account whose type is unknown (no type read), which is the mapper's existing cash path. A known investment account is excluded. Otherwise a failed `listAccounts` would retype stored refunds to DEPOSIT and back.
2. **The leftover income category stays in place.** The pass assigns the spending category and does not remove the income one. On a CREDIT/REFUND row the income assignment counts nowhere (Wealthfolio's bucket rule; the companion's income readers go by type, its spend lines by the spending taxonomy only). Removing it would break Undo: Wealthfolio refuses an income category on a spending-bucket row, so Undo could never put it back. The change entry records it as `before` (taxonomy `income_sources`) with `restore: [that assignment]`, so Undo takes only the spending filing off and sets `noAutoFile`.
3. **Every fee-reversal refund takes part in matching**, filed or not and up to 90 days old, so a refund already filed, undone, or older than 60 days keeps its fee and a second same-amount refund cannot take it. Only unfiled ones from the last 60 days are filed. "0–30 days before" includes day 30.
4. **"Prints in full and can be snoozed"** contradicts `isSnoozable` (problems may not be snoozed). `isSnoozable` now allows kind `connection-problem`, `printsInFull` includes it, and the report's "Show what to fix" button also appears when a printed finding can be snoozed (`needsFindingsButton`).
5. **The story names the pass's filing.** `resolveFiler` assumed Amazon is the only automatic filer, so a fee-reversal filing read "set by hand". A filer kind `fee` (cube code `f`) says "by the sync, the same category as the fee it reverses". An older add-on decodes `f` as unknown and shows "Filed under X."
6. **A failed record read writes nothing** and leaves `SyncResult.connectionProblems` absent. Writing over it would restart every episode, and Telegram would then say "updating again" for problems that never cleared. A record that reads but does not parse is replaced.
7. **A problem that names no account** (`gen.*`, a v1 string, a dead connection listing no accounts) is kept; the "all unmapped or ignored" drop applies only when it names accounts. "In use" means mapped or linked to a loan, and not ignored.
8. **`gen.auth`** has no connection to sign in to, so it reads "SimpleFIN Bridge turned this sync away: …" rather than "sign in again at SimpleFIN Bridge".
9. **The Telegram ledger keys by problem key**; Home Assistant keys by episode (key + `firstSeenAt`), as the spec says. A problem the add-on saw clear and come back between two companion syncs therefore gets a new HA alert but no new Telegram notice.
10. **`/status`'s `connectionProblems` is optional:** absent until a run has read the record, then the last such run's count (a too-soon or budget-limited run keeps it).
11. **v1's `org.id`** (= v2 `org_id`) is not filled: nothing reads it and the type has no such field.
12. **The companion's daily finding does not apply the 48-hour rule** (the spec gives that rule to the add-on). A stale record there means the companion is not syncing, which `sync-stale` already reports.

For Nick, not code: the residual risk the spec lists (a real Bridge deriving v1 `org.name` differently from the demo's connection `name`) cannot be tested offline. Task 8's test pins the demo; do not "fix" a mismatch by switching to `org_name`.

## Review Focus

1. **A dead connection that lists no accounts** (`con.auth` on a `conn_id` no account carries, the Discover case): it must still be shown, with no account marked. Pinned in Task 9: `keeps a problem on a connection that lists no accounts at all (a dead feed)`.
2. **A companion without `node:sqlite`** reading fee rows through the `sqlite3` CLI, with `|` or a line break in a note: every column must still land. Pinned in Task 5: the real-CLI test `getNativeFeeReversalRows (#79): every column, a note with "|" and a line break included`.
3. **Two same-amount refunds near one fee**, one already filed (or undone): the filed one keeps its fee, and the other is not filed from it. Pinned in Task 4: `never files a refund that has a spending category, though it still takes its fee`.
4. **The record secret unreadable** (a 401 mid-sync): no episode restarts, nothing written, no notice. Pinned in Task 10 (`writes nothing, and says nothing, when the record cannot be read`) and Task 12 (`reads and writes nothing for a run that read no record`).
5. **Names that break the channel they are shown in**: a connection named `Fidelity_NetBenefits` must not 400 Telegram's Markdown, and the access URL's credentials must never reach the page. Pinned in Task 12 (escaped notice text) and Task 11 (`never the access URL`).

## Files

- `shared/fee-reversal.ts` (new): wording, subtype, the filing `why`, and the pure matcher `planFeeReversalFilings`.
- `shared/mapper.ts`, `shared/sync-core.ts`, `shared/reconcile.ts` (doc only), `shared/tx-story.ts`: the type, pairing and payback exclusions, the story lines.
- `companion/src/sqlite-native.ts` (reader), `companion/src/fee-reversal-filing.ts` (new pass), `companion/src/index.ts` (wiring).
- `shared/simplefin-hosts.ts`, `src/utils/simplefin.ts`, `companion/src/simplefin.ts`: `version=2` for the Bridge.
- `shared/types.ts`, `shared/simplefin-payload.ts`, `shared/__fixtures__/simplefin-demo/*.json` (new): v2 normalisation.
- `shared/connection-problems.ts` (new): the record, its rules and its copy.
- `shared/sync-host.ts`, `src/utils/secrets.ts`, `companion/src/rest-host.ts`, `shared/sync-core.ts`: the record's store methods and the sync's write.
- `src/components/ConnectionProblemBanners.tsx` (new), `src/components/AccountList.tsx`, `src/tabs/HomeTab.tsx`, `src/tabs/SettingsTab.tsx`, `src/pages/SyncPage.tsx`: the add-on's banner and mark.
- `companion/src/connection-problem-notices.ts` (new) + `index.ts`: Telegram.
- `shared/self-check.ts`, `shared/findings.ts`, `companion/src/findings-menu.ts`, `companion/src/daily-findings.ts`, `index.ts`: the daily finding.
- `shared/home-assistant.ts`, `companion/src/status-server.ts`: alerts and `/status`.
- `CHANGELOG.md`, `README.md`.

---

### Task 1: Fee-reversal wording and the mapper's type

**Files:**
- Create: `shared/fee-reversal.ts`, `shared/fee-reversal.test.ts`
- Modify: `shared/mapper.ts` (`MappedType`, `mapTransactionWithSource`)
- Test: `shared/mapper.test.ts` (append)

**Interfaces:**
- Produces (in `shared/fee-reversal.ts`, which imports nothing):
  - `FEE_WORDS: RegExp` = `/\bfees?\b|\bservice\s+charge\b|\blate\s+charge\b/i`
  - `FEE_REVERSAL_WORDS: RegExp` = `/\b(?:waived|waiver|reversal|reversed|refund|refunded|rebate|reimbursement|adjustment|adj|credit)\b/i`
  - `FEE_REVERSAL_SUBTYPE = 'REFUND'`
  - `isFeeReversalWording(text: string): boolean` (a fee word and a reversal word)
  - `isFeeWording(text: string): boolean` (a fee word and no reversal word)
  - `feeReversalAccount(accountType: string | undefined): boolean` (true for `undefined`, `''`, `'CASH'`, `'CREDIT_CARD'`)
- Produces (in `shared/mapper.ts`): `MappedType.feeReversal?: true`.

- [ ] **Step 1: Write the failing tests**

`shared/fee-reversal.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isFeeReversalWording, isFeeWording } from './fee-reversal';

/** The design's fixture lists (#79), verbatim. */
const REVERSALS = [
  'Monthly Maintenance Fee Waived',
  'ADJUST FEE CHARGED ATM FEE REBATE',
  'LATE CHARGE ADJUSTMENT',
  'LATE PAYMENT FEE REVERSAL',
  'OVERDRAFT FEE REFUND',
  'ATM FEE REIMBURSEMENT',
  'SERVICE CHARGE REVERSAL',
];
const NOT_REVERSALS = ['TAX REFUND', 'COFFEE REFUND', 'AMAZON REFUND', 'MONTHLY MAINTENANCE FEE'];

describe('fee reversal wording (#79)', () => {
  it.each(REVERSALS)('reads "%s" as a fee coming back', (text) => {
    expect(isFeeReversalWording(text)).toBe(true);
    expect(isFeeWording(text)).toBe(false);
  });

  it.each(NOT_REVERSALS)('does not read "%s" as a fee coming back', (text) => {
    expect(isFeeReversalWording(text)).toBe(false);
  });

  it('reads a fee with no reversal word as the fee itself, and never COFFEE as a fee', () => {
    expect(isFeeWording('MONTHLY MAINTENANCE FEE')).toBe(true);
    expect(isFeeWording('OVERDRAFT FEES')).toBe(true);
    expect(isFeeWording('SERVICE CHARGE')).toBe(true);
    expect(isFeeWording('LATE CHARGE')).toBe(true);
    expect(isFeeWording('COFFEE SHOP')).toBe(false);
    expect(isFeeWording('FEEDBACK SURVEY')).toBe(false);
  });
});
```

Append to `shared/mapper.test.ts` (it already imports `mapTransactionWithSource` and `MappingRule`):

```ts
describe('fee reversals (#79)', () => {
  const reversal = { type: 'CREDIT', fromRule: false, subtype: 'REFUND', feeReversal: true };

  it('types money in on a cash account as a refund, not a deposit', () => {
    expect(mapTransactionWithSource('OVERDRAFT FEE REFUND', 35, [], 'CASH')).toEqual(reversal);
    expect(mapTransactionWithSource('Monthly Maintenance Fee Waived', 12, [], 'CASH')).toEqual(reversal);
  });

  it('beats the card-payment keywords on a card ("payment" is in the text)', () => {
    expect(mapTransactionWithSource('LATE PAYMENT FEE REVERSAL', 40, [], 'CREDIT_CARD')).toEqual(reversal);
  });

  it('beats the bank-transfer keywords on a cash account', () => {
    expect(mapTransactionWithSource('ONLINE TRANSFER FEE REFUND', 3, [], 'CASH')).toEqual(reversal);
  });

  it('reads an unknown account type the way the cash path does', () => {
    expect(mapTransactionWithSource('ATM FEE REIMBURSEMENT', 3, [], undefined)).toEqual(reversal);
    expect(mapTransactionWithSource('ATM FEE REIMBURSEMENT', 3, [], '')).toEqual(reversal);
  });

  it('leaves money out, investment accounts and plain refunds alone', () => {
    expect(mapTransactionWithSource('OVERDRAFT FEE REFUND', -35, [], 'CASH')).toEqual({ type: 'WITHDRAWAL', fromRule: false });
    expect(mapTransactionWithSource('ADVISORY FEE REFUND', 20, [], 'SECURITIES')).toEqual({ type: 'DEPOSIT', fromRule: false });
    expect(mapTransactionWithSource('TAX REFUND', 500, [], 'CASH')).toEqual({ type: 'DEPOSIT', fromRule: false });
    expect(mapTransactionWithSource('COFFEE REFUND', 5, [], 'CREDIT_CARD')).toEqual({ type: 'CREDIT', fromRule: false });
  });

  it('lets a user rule win', () => {
    const rules: MappingRule[] = [{ pattern: 'OVERDRAFT', matchType: 'contains', activityType: 'DEPOSIT' }];
    expect(mapTransactionWithSource('OVERDRAFT FEE REFUND', 35, rules, 'CASH')).toEqual({ type: 'DEPOSIT', fromRule: true });
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `nice npx vitest run --maxWorkers=2 shared/fee-reversal.test.ts shared/mapper.test.ts`
Expected: FAIL. `shared/fee-reversal.test.ts`: `Failed to resolve import "./fee-reversal"`. `shared/mapper.test.ts`: 4 failed (the first four new tests receive `DEPOSIT`/`TRANSFER_IN`); the last two already pass.

- [ ] **Step 3: Implement**

Create `shared/fee-reversal.ts` with the exports above (a short header saying what #79 is). In `mapTransactionWithSource`, right after the `if (ruled) return …` line:

```ts
  if (amount > 0 && feeReversalAccount(accountType) && isFeeReversalWording(description)) {
    return { type: 'CREDIT', fromRule: false, subtype: FEE_REVERSAL_SUBTYPE, feeReversal: true };
  }
```

Add `feeReversal?: true` to `MappedType` with a doc line (never paired, never typed a transfer by a learned name).

- [ ] **Step 4: Run the tests to see them pass**

Run: `nice npx vitest run --maxWorkers=2 shared/fee-reversal.test.ts shared/mapper.test.ts`
Expected: PASS, 58 tests (12 in `fee-reversal.test.ts`). Then `nice npx vitest run --maxWorkers=2 shared/payback.test.ts shared/payback-rules.test.ts src/components/RuleEditor.test.tsx`: PASS, 89.

- [ ] **Step 5: Commit**

```bash
git add shared/fee-reversal.ts shared/fee-reversal.test.ts shared/mapper.ts shared/mapper.test.ts
git commit -m "Fee reversals import as refunds, not income (#79)"
```

---

### Task 2: Sync core keeps fee reversals out of pairing and keeps paybacks

**Files:**
- Modify: `shared/sync-core.ts` (the `keepPayback` const in the typing loop, the pairing `continue`, the feed's `keepPayback` spread, an import), `shared/reconcile.ts` (doc of `FeedTx.keepPayback` only)
- Create: `shared/sync-core-fee-reversal.test.ts`

**Interfaces:**
- Consumes: `MappedType.feeReversal`, `FEE_REVERSAL_SUBTYPE` (Task 1).
- Produces: nothing new; behaviour only.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { SimplefinTransaction } from './types.js';

const NOW = new Date('2026-11-18T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const REFUND = 'OVERDRAFT FEE REFUND';
const tx = (id: string, iso: string, amount: string, description: string): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description });

/** PNC checking (cash) and a Citi card; `other` is a second cash account. */
const seedOf = (feeds: { chk?: SimplefinTransaction[]; card?: SimplefinTransaction[]; other?: SimplefinTransaction[] }, extra: Partial<FakeHostSeed> = {}): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-chk', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': epoch('2026-11-18T12:00:00Z'), transactions: feeds.chk ?? [] },
    { id: 'sfin-card', name: 'Citi', currency: 'USD', balance: '0', 'balance-date': epoch('2026-11-18T12:00:00Z'), transactions: feeds.card ?? [] },
    { id: 'sfin-oth', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': epoch('2026-11-18T12:00:00Z'), transactions: feeds.other ?? [] },
  ] },
  mapping: { 'sfin-chk': 'wf-chk', 'sfin-card': 'wf-card', 'sfin-oth': 'wf-oth' },
  accountTypes: { 'wf-chk': 'CASH', 'wf-card': 'CREDIT_CARD', 'wf-oth': 'CASH' },
  ...extra,
});
const rowOf = (fh: ReturnType<typeof createFakeHost>, wf: string, txId: string): HostActivity | undefined =>
  (fh.activities.get(wf) ?? []).find((r) => (r.comment ?? '').includes(` · ${txId}`));
const carry = (fh: ReturnType<typeof createFakeHost>) => new Map([...fh.activities].map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));

describe('runSyncCore — fee reversals are refunds, never income or a transfer half (#79)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('imports a cash fee reversal as CREDIT/REFUND and a card one too', async () => {
    const fh = createFakeHost(seedOf({
      chk: [tx('t-1', '2026-11-10T12:00:00Z', '35.00', REFUND)],
      card: [tx('t-2', '2026-11-10T12:00:00Z', '40.00', 'LATE PAYMENT FEE REVERSAL')],
    }));
    await runSyncCore(fh.host, fh.store, {});
    expect(rowOf(fh, 'wf-chk', 't-1')).toMatchObject({ activityType: 'CREDIT', subtype: 'REFUND' });
    expect(rowOf(fh, 'wf-card', 't-2')).toMatchObject({ activityType: 'CREDIT', subtype: 'REFUND' });
  });

  it('retypes a fee reversal stored as a DEPOSIT', async () => {
    const a = createFakeHost(seedOf({ chk: [tx('t-1', '2026-11-10T12:00:00Z', '35.00', REFUND)] }));
    await runSyncCore(a.host, a.store, {});
    const old = carry(a);
    old.get('wf-chk')!.forEach((r) => { r.activityType = 'DEPOSIT'; r.subtype = null as never; });
    const b = createFakeHost(seedOf({ chk: [tx('t-1', '2026-11-10T12:00:00Z', '35.00', REFUND)] }, { existing: old }));
    await runSyncCore(b.host, b.store, { force: true });
    expect(rowOf(b, 'wf-chk', 't-1')).toMatchObject({ activityType: 'CREDIT', subtype: 'REFUND' });
  });

  it('is never paired with a same-amount outflow in another account', async () => {
    const fh = createFakeHost(seedOf({
      chk: [tx('t-in', '2026-11-10T12:00:00Z', '35.00', REFUND)],
      other: [tx('t-out', '2026-11-09T12:00:00Z', '-35.00', 'ZELLE TO JOE')],
    }));
    await runSyncCore(fh.host, fh.store, {});
    expect(rowOf(fh, 'wf-chk', 't-in')).toMatchObject({ activityType: 'CREDIT', subtype: 'REFUND' });
    expect(rowOf(fh, 'wf-oth', 't-out')?.activityType).toBe('WITHDRAWAL');
    expect(fh.links).toEqual([]);
  });

  it('is never typed a transfer by a learned name', async () => {
    const fh = createFakeHost(seedOf({ chk: [tx('t-1', '2026-11-10T12:00:00Z', '35.00', REFUND)] }, {
      transferNames: { version: 1, computedAt: '2026-11-18T14:00:00.000Z', names: [{ accountId: 'wf-chk', direction: 'in', signature: 'overdraft fee refund' }] },
    }));
    await runSyncCore(fh.host, fh.store, {});
    expect(rowOf(fh, 'wf-chk', 't-1')).toMatchObject({ activityType: 'CREDIT', subtype: 'REFUND' });
  });

  it('keeps a stored payback a payback (never REFUND)', async () => {
    const a = createFakeHost(seedOf({ chk: [tx('t-1', '2026-11-10T12:00:00Z', '35.00', REFUND)] }));
    await runSyncCore(a.host, a.store, {});
    const hand = carry(a);
    hand.get('wf-chk')!.forEach((r) => { r.activityType = 'CREDIT'; r.subtype = 'REIMBURSEMENT'; });
    const b = createFakeHost(seedOf({ chk: [tx('t-1', '2026-11-10T12:00:00Z', '35.00', REFUND)] }, { existing: hand }));
    await runSyncCore(b.host, b.store, { force: true });
    expect(rowOf(b, 'wf-chk', 't-1')).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });

  it('lets the payback override win', async () => {
    const overrides = setTxOverride(emptySyncOverrides(), accountTxKey('sfin-chk', 't-1'), 'asReimbursement', NOW, { label: REFUND });
    const fh = createFakeHost(seedOf({ chk: [tx('t-1', '2026-11-10T12:00:00Z', '35.00', REFUND)] }, { syncOverrides: overrides }));
    await runSyncCore(fh.host, fh.store, {});
    expect(rowOf(fh, 'wf-chk', 't-1')).toMatchObject({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-fee-reversal.test.ts`
Expected: FAIL, 2 failed | 4 passed (6). `is never paired…` receives `activityType: "TRANSFER_IN"`; `keeps a stored payback a payback` receives `subtype: "REFUND"`. The other four already pass on Task 1's mapper.

- [ ] **Step 3: Implement (three edits in `runSyncPass`'s typing loop, `shared/sync-core.ts`)**

1. The `const keepPayback = …` line: a fee reversal counts like a plain DEPOSIT there.
   `const keepPayback = !payback && !builtIn.fromRule && (builtIn.type === 'DEPOSIT' || !!builtIn.feeReversal) && amount > 0 && (!acctType || acctType === 'CASH');`
2. The pairing guard `if (notTransfer || payback || heldAsPayback) continue;` becomes `if (notTransfer || payback || heldAsPayback || builtIn.feeReversal) continue;` (comment: a refund of a fee, never a transfer half).
3. In the feed built for `planReconciliation`, the spread `...(keepPayback && type === 'DEPOSIT' && !inTransit ? …)` becomes `...(keepPayback && (type === 'DEPOSIT' || (type === 'CREDIT' && subtype === FEE_REVERSAL_SUBTYPE)) && !inTransit ? { keepPayback: true as const } : {})`.

Import `FEE_REVERSAL_SUBTYPE` from `./fee-reversal.js`. Learned typing needs no change: `learnedTransferType` only types DEPOSIT/WITHDRAWAL rows (the fourth test pins it). Add "or a fee reversal's CREDIT/REFUND (#79)" to the doc of `FeedTx.keepPayback` in `shared/reconcile.ts` and of `PreparedTx.keepPayback` in sync-core.

- [ ] **Step 4: Run the tests to see them pass**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-fee-reversal.test.ts`
Expected: PASS, 6.
Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-payback-keep.test.ts shared/sync-core-payback.test.ts shared/sync-core-learned-transfers.test.ts shared/reconcile.test.ts`
Expected: PASS, 66.

- [ ] **Step 5: Commit**

```bash
git add shared/sync-core.ts shared/reconcile.ts shared/sync-core-fee-reversal.test.ts
git commit -m "Keep fee reversals out of transfer pairing; paybacks stay paybacks (#79)"
```

---

### Task 3: "Why is this here?" for a fee reversal

**Files:**
- Modify: `shared/fee-reversal.ts` (one constant), `shared/tx-story.ts`
- Create: `shared/tx-story-fee-reversal.test.ts`

**Interfaces:**
- Produces: `FEE_REVERSAL_FILING_WHY = 'Same category as the fee it reverses'` (in `shared/fee-reversal.ts`; Task 6 writes it as the change entry's `why`).
- Produces (in `shared/tx-story.ts`): `TX_STORY_FEE_REVERSAL = 'A refund of a bank fee, going by its wording: it lowers your spending.'`; `isFeeReversalStoryRow(row: Pick<TxStoryRow, 'activityType' | 'subtype' | 'accountType' | 'note'>): boolean`; `TxFiler` gains `{ kind: 'fee' }`, encoded `'f'`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { categoryFiledChange, stampChange } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import { FEE_REVERSAL_FILING_WHY } from './fee-reversal.js';
import {
  buildTxStory, decodeFiler, encodeFiler, resolveFiler, TX_STORY_FEE_REVERSAL, TX_STORY_MONEY_IN, type TxStoryFacts,
} from './tx-story.js';

const AT = '2026-11-18T12:00:00.000Z';
const story = (row: Partial<TxStoryFacts['row']> = {}, over: Partial<TxStoryFacts> = {}) => buildTxStory({
  now: new Date(AT),
  row: { activityId: 'act-1', note: 'OVERDRAFT FEE REFUND · TRN-9', absCents: 3500, date: '2026-11-10', activityType: 'CREDIT', subtype: 'REFUND', accountName: 'PNC Checking', accountType: 'CASH', ...row },
  feed: { sfinAccountId: 'sfin-chk' }, partner: null, ...over,
});
const filing = (why: string): ChangeLogItem => stampChange(categoryFiledChange({
  actor: 'auto', activityId: 'act-1', description: 'OVERDRAFT FEE REFUND', before: null,
  after: { categoryId: 'cat-fees', categoryName: 'Bank Fees', taxonomyId: 'spending_categories' }, why,
}), 'companion', new Date(AT));

describe('a fee reversal in "Why is this here?" (#79)', () => {
  it('says it is a bank fee coming back, on cash and on a card', () => {
    expect(TX_STORY_FEE_REVERSAL).toBe('A refund of a bank fee, going by its wording: it lowers your spending.');
    expect(story().answer).toContain(TX_STORY_FEE_REVERSAL);
    expect(story({ accountType: 'CREDIT_CARD', note: 'LATE PAYMENT FEE REVERSAL · TRN-9' }).answer).toContain(TX_STORY_FEE_REVERSAL);
  });

  it('says nothing of the kind for a plain refund or a fee reversal stored as a deposit', () => {
    expect(story({ note: 'AMAZON REFUND · TRN-9' }).answer).toContain(TX_STORY_MONEY_IN);
    expect(story({ activityType: 'DEPOSIT', subtype: undefined }).answer).not.toContain(TX_STORY_FEE_REVERSAL);
  });

  it("names the companion's filing as the fee's category, not \"set by hand\"", () => {
    const filer = resolveFiler({ activityId: 'act-1', source: 'manual', categoryId: 'cat-fees', row: { note: 'OVERDRAFT FEE REFUND · TRN-9', activityType: 'CREDIT', accountId: 'wf-chk', absCents: 3500 }, history: [filing(FEE_REVERSAL_FILING_WHY)], rules: null });
    expect(filer).toEqual({ kind: 'fee' });
    expect(story({}, { category: { name: 'Bank Fees', filer: { kind: 'fee' } } }).answer)
      .toContain('Filed under Bank Fees by the sync, the same category as the fee it reverses.');
    expect(decodeFiler(encodeFiler({ kind: 'fee' }))).toEqual({ kind: 'fee' });
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `nice npx vitest run --maxWorkers=2 shared/tx-story-fee-reversal.test.ts`
Expected: FAIL, 2 failed | 1 passed. `expected undefined to be 'A refund of a bank fee…'` and `expected { kind: 'hand' } to deeply equal { kind: 'fee' }`.

- [ ] **Step 3: Implement**

- `isFeeReversalStoryRow`: type CREDIT, subtype REFUND (trimmed, case-insensitive), account type CASH or CREDIT_CARD, and `isFeeReversalWording(txDescription(row.note))`.
- `buildTxStory`'s "What it is" line becomes `out ? TX_STORY_SPENDING : isPaybackStoryRow(row) ? TX_STORY_PAYBACK : isFeeReversalStoryRow(row) ? TX_STORY_FEE_REVERSAL : TX_STORY_MONEY_IN`.
- `resolveFiler`: right after the `filing?.actor === 'you'` line, `if (filing?.why === FEE_REVERSAL_FILING_WHY) return { kind: 'fee' };`. Update the comment that says Amazon is the only automatic filer.
- `filedLine` case `'fee'`: `` `Filed under ${name} by the sync, the same category as the fee it reverses.` ``; `encodeFiler` `'f'`, `decodeFiler` `'f'`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `nice npx vitest run --maxWorkers=2 shared/tx-story-fee-reversal.test.ts shared/tx-story.test.ts shared/tx-story-payback.test.ts`
Expected: PASS, 66. Run `nice npm run type-check`: succeeds (no other exhaustive switch over `TxFiler`).

- [ ] **Step 5: Commit**

```bash
git add shared/fee-reversal.ts shared/tx-story.ts shared/tx-story-fee-reversal.test.ts
git commit -m "Tell a fee reversal's story, and who filed it (#79)"
```

---

### Task 4: Which refund reverses which fee (pure)

**Files:**
- Modify: `shared/fee-reversal.ts`
- Test: `shared/fee-reversal.test.ts` (append; add `planFeeReversalFilings, type FeeReversalRow` to its import)

**Interfaces:**
- Produces:
  - `FEE_REVERSAL_FILING_DAYS = 60`, `FEE_REVERSAL_FEE_WINDOW_DAYS = 30`
  - `interface FiledCategoryRef { categoryId: string; categoryName: string }`
  - `interface FeeReversalRow { activityId: string; wfAccountId: string; description: string /* bank words */; amountCents: number /* magnitude */; date: string /* YYYY-MM-DD */; direction: 'in' | 'out'; activityType: string /* effective, upper */; subtype: string | null; spending: FiledCategoryRef | null; income: FiledCategoryRef | null }`
  - `interface FeeReversalFiling<R extends FeeReversalRow = FeeReversalRow> { refund: R; fee: R; category: FiledCategoryRef }`
  - `planFeeReversalFilings<R extends FeeReversalRow>(rows: readonly R[], today: string): Array<FeeReversalFiling<R>>`

- [ ] **Step 1: Write the failing tests**

```ts
const TODAY = '2026-11-18';
const FEES = { categoryId: 'cat-fees', categoryName: 'Bank Fees' };
const refund = (id: string, date: string, over: Partial<FeeReversalRow> = {}): FeeReversalRow => ({
  activityId: id, wfAccountId: 'wf-chk', description: 'OVERDRAFT FEE REFUND', amountCents: 3500, date,
  direction: 'in', activityType: 'CREDIT', subtype: 'REFUND', spending: null, income: null, ...over,
});
const fee = (id: string, date: string, over: Partial<FeeReversalRow> = {}): FeeReversalRow => ({
  activityId: id, wfAccountId: 'wf-chk', description: 'OVERDRAFT FEE', amountCents: 3500, date,
  direction: 'out', activityType: 'WITHDRAWAL', subtype: null, spending: FEES, income: null, ...over,
});
const filed = (rows: FeeReversalRow[]) => planFeeReversalFilings(rows, TODAY).map((f) => [f.refund.activityId, f.fee.activityId, f.category.categoryId]);

describe('planFeeReversalFilings (#79)', () => {
  it('files a refund under the category of the closest same-amount fee before it, same account', () => {
    expect(filed([
      refund('r', '2026-11-10'),
      fee('near', '2026-11-07', { spending: { categoryId: 'cat-near', categoryName: 'Near' } }),
      fee('far', '2026-10-20'),
    ])).toEqual([['r', 'near', 'cat-near']]);
  });

  it('counts a fee from the same day to 30 days before, and none older', () => {
    expect(filed([refund('r', '2026-11-10'), fee('f', '2026-11-10')])).toEqual([['r', 'f', 'cat-fees']]);
    expect(filed([refund('r', '2026-11-10'), fee('f', '2026-10-11')])).toEqual([['r', 'f', 'cat-fees']]);
    expect(filed([refund('r', '2026-11-10'), fee('f', '2026-10-10')])).toEqual([]);
  });

  it.each<[string, Partial<FeeReversalRow>]>([
    ['in another account', { wfAccountId: 'wf-other' }],
    ['of another amount', { amountCents: 3501 }],
    ['dated after the refund', { date: '2026-11-11' }],
    ['worded as a reversal itself', { description: 'FEE REVERSAL' }],
    ['not a fee at all', { description: 'COFFEE' }],
    ['money in', { direction: 'in' }],
    ['with no spending category', { spending: null }],
  ])('copies nothing from a fee %s', (_name, over) => {
    expect(filed([refund('r', '2026-11-10'), fee('f', '2026-11-09', over)])).toEqual([]);
  });

  it('lets one fee reverse one refund, the closest first', () => {
    expect(filed([refund('r12', '2026-11-12'), refund('r10', '2026-11-10'), fee('f', '2026-11-09')])).toEqual([['r10', 'f', 'cat-fees']]);
  });

  it('never files a refund that has a spending category, though it still takes its fee', () => {
    expect(filed([
      refund('mine', '2026-11-10', { spending: { categoryId: 'cat-x', categoryName: 'X' } }),
      refund('r', '2026-11-11'),
      fee('f', '2026-11-09'),
    ])).toEqual([]);
  });

  it('treats an income category as none and hands it back for the change log', () => {
    const income = { categoryId: 'cat-inc', categoryName: 'Refunds' };
    const [f] = planFeeReversalFilings([refund('r', '2026-11-10', { income }), fee('f', '2026-11-09')], TODAY);
    expect(f.refund.income).toEqual(income);
    expect(f.category).toEqual(FEES);
  });

  it('files only refunds from the last 60 days, and only CREDIT/REFUND rows with fee-reversal wording', () => {
    expect(filed([refund('old', '2026-09-18'), fee('f', '2026-09-17')])).toEqual([]);
    expect(filed([refund('r', '2026-09-19'), fee('f', '2026-09-18')])).toEqual([['r', 'f', 'cat-fees']]);
    expect(filed([refund('dep', '2026-11-10', { activityType: 'DEPOSIT', subtype: null }), fee('f', '2026-11-09')])).toEqual([]);
    expect(filed([refund('tax', '2026-11-10', { description: 'TAX REFUND' }), fee('f', '2026-11-09')])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `nice npx vitest run --maxWorkers=2 shared/fee-reversal.test.ts`
Expected: FAIL, 13 failed with `TypeError: planFeeReversalFilings is not a function`; Task 1's 12 pass.

- [ ] **Step 3: Implement `planFeeReversalFilings`**

1. Refunds: `direction === 'in'`, type CREDIT, subtype REFUND (trimmed, case-insensitive), `isFeeReversalWording(description)`. Fees: `direction === 'out'` and `isFeeWording(description)`.
2. Every (refund, fee) pair in the same account with equal `amountCents` and `gap = refund day − fee day` (whole UTC days) in `[0, 30]`.
3. Sort pairs by gap, then refund date, refund id, fee id. Walk them greedily: a pair whose refund or fee is already used is skipped; otherwise mark both used.
4. A used pair is returned only when the refund has no `spending`, the fee has `spending`, and the refund is dated on or after `today − 60` days. `category` is the fee's `spending`.

Every refund in `rows` takes part in step 3, filed or not (ruling 3).

- [ ] **Step 4: Run the tests to see them pass**

Run: `nice npx vitest run --maxWorkers=2 shared/fee-reversal.test.ts`
Expected: PASS, 25.

- [ ] **Step 5: Commit**

```bash
git add shared/fee-reversal.ts shared/fee-reversal.test.ts
git commit -m "Match each fee reversal to the fee it reverses (#79)"
```

---

### Task 5: The companion reads candidate fee rows

**Files:**
- Modify: `companion/src/sqlite-native.ts` (new reader, beside `getNativeRuleCategorizedAmazonRows`)
- Test: `companion/src/sqlite-native.test.ts` (append), `companion/src/sqlite-native-real-cli.test.ts` (one test inside the `describe.skipIf(!hasSqlite3)` block)

**Interfaces:**
- Consumes: `FEE_WORDS`, `FeeReversalRow` (Tasks 1, 4).
- Produces: `interface NativeFeeReversalRow extends FeeReversalRow { notes: string /* raw stored note */; accountName: string }`; `getNativeFeeReversalRows(dbPath: string, startInclusive: string, endExclusive: string): NativeFeeReversalRow[]` (`[]` without a readable database or with malformed bounds).

- [ ] **Step 1: Write the failing tests**

Append to `companion/src/sqlite-native.test.ts` (add `getNativeFeeReversalRows` to an import from `./sqlite-native.js`; it uses the file's `makeTestDb`, whose spending scope covers `acct-cash` and `acct-card`):

```ts
describe('getNativeFeeReversalRows (#79)', () => {
  it('reads fee-worded rows on tracked cash and card accounts, with each taxonomy’s category', () => {
    const { path, cleanup } = makeTestDb();
    try {
      const db = new DatabaseSync(path);
      db.exec(`
        INSERT INTO accounts (id, name, account_type) VALUES ('acct-inv', 'Brokerage', 'SECURITIES'), ('acct-off', 'Untracked', 'CASH');
        INSERT INTO taxonomy_categories (id, name, parent_id, taxonomy_id) VALUES
          ('cat-fees', 'Bank Fees', NULL, 'spending_categories'), ('cat-inc', 'Refunds', NULL, 'income_sources');
        INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id, subtype, source_group_id) VALUES
          ('fee',    '35.00', '2026-11-09T12:00:00Z', 'WITHDRAWAL', 'OVERDRAFT FEE · TRN-1', 'acct-cash', NULL, NULL),
          ('refund', '35.00', '2026-11-10T12:00:00Z', 'CREDIT', 'OVERDRAFT FEE REFUND · TRN-2', 'acct-cash', 'REFUND', NULL),
          ('late',   '40.00', '2026-11-11T12:00:00Z', 'CREDIT', 'LATE CHARGE ADJUSTMENT · TRN-3', 'acct-card', 'REFUND', NULL),
          ('coffee', '5.00',  '2026-11-11T12:00:00Z', 'WITHDRAWAL', 'COFFEE SHOP · TRN-4', 'acct-cash', NULL, NULL),
          ('inv',    '20.00', '2026-11-11T12:00:00Z', 'DEPOSIT', 'ADVISORY FEE REFUND · TRN-5', 'acct-inv', NULL, NULL),
          ('off',    '9.00',  '2026-11-11T12:00:00Z', 'WITHDRAWAL', 'ATM FEE · TRN-6', 'acct-off', NULL, NULL),
          ('linked', '3.00',  '2026-11-11T12:00:00Z', 'TRANSFER_OUT', 'TRANSFER FEE · TRN-7', 'acct-cash', NULL, 'g-1'),
          ('split',  '3.00',  '2026-11-11T12:00:00Z', 'WITHDRAWAL', 'ATM FEE · TRN-8', 'acct-cash', NULL, NULL),
          ('old',    '3.00',  '2026-07-01T12:00:00Z', 'WITHDRAWAL', 'ATM FEE · TRN-9', 'acct-cash', NULL, NULL);
        INSERT INTO activity_taxonomy_assignments (activity_id, category_id, taxonomy_id, source) VALUES
          ('fee', 'cat-fees', 'spending_categories', 'manual'),
          ('refund', 'cat-inc', 'income_sources', 'manual');
        INSERT INTO spending_activity_splits (id, activity_id, taxonomy_id, category_id, amount, sort_order) VALUES ('s1', 'split', 'spending_categories', 'cat-fees', '3.00', 0);
      `);
      db.close();
      expect(getNativeFeeReversalRows(path, '2026-08-20', '2026-11-19')).toEqual([
        {
          activityId: 'fee', wfAccountId: 'acct-cash', accountName: 'Spend', notes: 'OVERDRAFT FEE · TRN-1', description: 'OVERDRAFT FEE',
          amountCents: 3500, date: '2026-11-09', direction: 'out', activityType: 'WITHDRAWAL', subtype: null,
          spending: { categoryId: 'cat-fees', categoryName: 'Bank Fees' }, income: null,
        },
        {
          activityId: 'refund', wfAccountId: 'acct-cash', accountName: 'Spend', notes: 'OVERDRAFT FEE REFUND · TRN-2', description: 'OVERDRAFT FEE REFUND',
          amountCents: 3500, date: '2026-11-10', direction: 'in', activityType: 'CREDIT', subtype: 'REFUND',
          spending: null, income: { categoryId: 'cat-inc', categoryName: 'Refunds' },
        },
        {
          activityId: 'late', wfAccountId: 'acct-card', accountName: 'Card', notes: 'LATE CHARGE ADJUSTMENT · TRN-3', description: 'LATE CHARGE ADJUSTMENT',
          amountCents: 4000, date: '2026-11-11', direction: 'in', activityType: 'CREDIT', subtype: 'REFUND', spending: null, income: null,
        },
      ]);
    } finally {
      cleanup();
    }
  });

  it('reads nothing without a database', () => {
    expect(getNativeFeeReversalRows('/nonexistent/wealthfolio.db', '2026-08-20', '2026-11-19')).toEqual([]);
  });
});
```

In `companion/src/sqlite-native-real-cli.test.ts`, add `getNativeFeeReversalRows` to the `./sqlite-native.js` import and, first inside `describe.skipIf(!hasSqlite3)('the sqlite3 CLI fallback, for real', …)`:

```ts
  it('getNativeFeeReversalRows (#79): every column, a note with "|" and a line break included', () => {
    const path = database(`
      INSERT INTO taxonomy_categories (id, name, parent_id, taxonomy_id) VALUES ('cat-fees', 'Bank Fees', NULL, 'spending_categories');
      INSERT INTO activities (id, amount, activity_date, activity_type, notes, account_id, subtype) VALUES
        ('fee', '35.00', '2026-11-09T12:00:00Z', 'WITHDRAWAL', 'OVERDRAFT FEE | ITEM' || char(10) || '2 · TRN-1', 'acct-cash', NULL),
        ('refund', '35.00', '2026-11-10T12:00:00Z', 'CREDIT', 'OVERDRAFT FEE REFUND · TRN-2', 'acct-cash', 'REFUND');
      INSERT INTO activity_taxonomy_assignments (activity_id, category_id, taxonomy_id, source) VALUES ('fee', 'cat-fees', 'spending_categories', 'manual');
    `);
    expect(getNativeFeeReversalRows(path, '2026-08-20', '2026-11-19').map((r) => [r.activityId, r.amountCents, r.direction, r.subtype, r.spending?.categoryId ?? null, r.notes])).toEqual([
      ['fee', 3500, 'out', null, 'cat-fees', 'OVERDRAFT FEE | ITEM 2 · TRN-1'],
      ['refund', 3500, 'in', 'REFUND', null, 'OVERDRAFT FEE REFUND · TRN-2'],
    ]);
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd companion && nice npx vitest run --maxWorkers=2 src/sqlite-native.test.ts -t getNativeFeeReversalRows`
Expected: FAIL, 2 failed (`TypeError: getNativeFeeReversalRows is not a function`) | 112 skipped.
Run: `cd companion && nice npx vitest run --maxWorkers=2 src/sqlite-native-real-cli.test.ts`
Expected: FAIL, 1 failed (same TypeError) | 4 passed.

- [ ] **Step 3: Implement `getNativeFeeReversalRows`**

Mirror `getNativeUncategorizedSpending`: the same effective-type expression `T` (honouring `activity_type_override`), the same `NOT_SPLIT` clause, `IN_SPENDING_SCOPE`, `validDateBounds`. Query (columns positional; the note LAST so the CLI path can rejoin it with `tail(parts, 12)`; run with `CLI_SEPARATOR`):

```sql
SELECT a.id, COALESCE(a.account_id, ''), COALESCE(ac.name, ''),
       ROUND(ABS(CAST(a.amount AS REAL)) * 100), substr(a.activity_date, 1, 10),
       CASE WHEN ${T} IN ('WITHDRAWAL', 'FEE', 'TAX')
              OR (${T} = 'INTEREST' AND UPPER(COALESCE(ac.account_type, '')) = 'CREDIT_CARD')
            THEN 'out' ELSE 'in' END,
       ${T}, COALESCE(a.subtype, ''),
       COALESCE(sp.category_id, ''), COALESCE(spc.name, ''),
       COALESCE(inc.category_id, ''), COALESCE(incc.name, ''),
       ${NOTES}
FROM activities a
JOIN accounts ac ON a.account_id = ac.id
LEFT JOIN activity_taxonomy_assignments sp ON sp.activity_id = a.id AND sp.taxonomy_id = 'spending_categories'
LEFT JOIN taxonomy_categories spc ON spc.id = sp.category_id
LEFT JOIN activity_taxonomy_assignments inc ON inc.activity_id = a.id AND inc.taxonomy_id = 'income_sources'
LEFT JOIN taxonomy_categories incc ON incc.id = inc.category_id
WHERE UPPER(COALESCE(ac.account_type, '')) IN ('CASH', 'CREDIT_CARD')
  AND a.activity_date >= '${startInclusive}' AND a.activity_date < '${endExclusive}'
  AND COALESCE(a.source_group_id, '') = ''
  AND (LOWER(COALESCE(a.notes, '')) LIKE '%fee%' OR LOWER(COALESCE(a.notes, '')) LIKE '%charge%')
  ${IN_SPENDING_SCOPE}
  ${NOT_SPLIT}
ORDER BY a.activity_date, a.id;
```

Map each row positionally (`Object.values`), as the other readers do: `subtype` `''` → `null`; a category whose id is `''` → `null`; `description = descriptionFromComment(notes)`. The LIKE is only a prefilter ("COFFEE" passes it): finish with `.filter((r) => FEE_WORDS.test(r.description))`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd companion && nice npx vitest run --maxWorkers=2 src/sqlite-native.test.ts src/sqlite-native-real-cli.test.ts`
Expected: PASS, 114 and 5.

- [ ] **Step 5: Commit**

```bash
git add companion/src/sqlite-native.ts companion/src/sqlite-native.test.ts companion/src/sqlite-native-real-cli.test.ts
git commit -m "Read candidate fee rows and refunds from the database (#79)"
```

---

### Task 6: The companion files each fee reversal under its fee's category

**Files:**
- Create: `companion/src/fee-reversal-filing.ts`, `companion/src/fee-reversal-filing.test.ts`
- Modify: `companion/src/index.ts` (a wiring function beside `fileAmazonLabelledCharges`, and one call after it)

**Interfaces:**
- Consumes: `planFeeReversalFilings`, `FEE_REVERSAL_FILING_WHY` (Tasks 3–4), `NativeFeeReversalRow`, `getNativeFeeReversalRows` (Task 5), `categoryFiledChange` (`shared/change-entries.ts`), `txIdFromComment` (`shared/sync-core.ts`), `accountTxKey` (`shared/transfers.ts`).
- Produces:

```ts
export interface FeeReversalFilingDeps {
  rows(): Promise<NativeFeeReversalRow[]>;          // the last 90 days
  assign(activityId: string, categoryId: string): Promise<void>;   // spending taxonomy
  record(draft: ChangeDraft): void;
  sfinAccountOf(wfAccountId: string): string | undefined;
  noAutoFile(txKey: string): boolean;
  anyNoAutoFile: boolean;
  log(msg: string): void;
  today: string;                                    // YYYY-MM-DD
}
export async function fileFeeReversals(deps: FeeReversalFilingDeps): Promise<{ filed: number }>;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { stampChange, type ChangeDraft } from '../../shared/change-entries.js';
import { planChangeUndo } from '../../shared/change-undo.js';
import { FEE_REVERSAL_FILING_WHY } from '../../shared/fee-reversal.js';
import { accountTxKey } from '../../shared/transfers.js';
import { fileFeeReversals, type FeeReversalFilingDeps } from './fee-reversal-filing.js';
import type { NativeFeeReversalRow } from './sqlite-native.js';

const TODAY = '2026-11-18';
const FEES = { categoryId: 'cat-fees', categoryName: 'Bank Fees' };
const INCOME = { categoryId: 'cat-inc', categoryName: 'Refunds' };
const row = (over: Partial<NativeFeeReversalRow>): NativeFeeReversalRow => ({
  activityId: 'x', wfAccountId: 'wf-chk', accountName: 'PNC Checking', notes: '', description: '', amountCents: 3500,
  date: '2026-11-10', direction: 'in', activityType: 'CREDIT', subtype: 'REFUND', spending: null, income: null, ...over,
});
const refund = (over: Partial<NativeFeeReversalRow> = {}) => row({ activityId: 'r', notes: 'OVERDRAFT FEE REFUND · TRN-2', description: 'OVERDRAFT FEE REFUND', ...over });
const fee = (over: Partial<NativeFeeReversalRow> = {}) => row({
  activityId: 'f', notes: 'OVERDRAFT FEE · TRN-1', description: 'OVERDRAFT FEE', date: '2026-11-09', direction: 'out',
  activityType: 'WITHDRAWAL', subtype: null, spending: FEES, ...over,
});
const KEY = accountTxKey('sfin-chk', 'TRN-2');

function make(rows: NativeFeeReversalRow[], over: Partial<FeeReversalFilingDeps> = {}) {
  const drafts: ChangeDraft[] = [];
  const deps: FeeReversalFilingDeps = {
    rows: vi.fn(async () => rows),
    assign: vi.fn(async () => {}),
    record: (d) => { drafts.push(d); },
    sfinAccountOf: (wf) => (wf === 'wf-chk' ? 'sfin-chk' : undefined),
    noAutoFile: () => false,
    anyNoAutoFile: false,
    log: vi.fn(),
    today: TODAY,
    ...over,
  };
  return { deps, drafts };
}

describe('fileFeeReversals (#79)', () => {
  it('files a refund under its fee’s spending category and records it for Undo', async () => {
    const { deps, drafts } = make([fee(), refund()]);
    expect(await fileFeeReversals(deps)).toEqual({ filed: 1 });
    expect(deps.assign).toHaveBeenCalledWith('r', 'cat-fees');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      actor: 'auto', kind: 'category-filed', why: FEE_REVERSAL_FILING_WHY,
      account: { sfinId: 'sfin-chk', wfId: 'wf-chk', name: 'PNC Checking' },
      subject: { txKeys: [KEY], activityIds: ['r'], description: 'OVERDRAFT FEE REFUND', amountCents: 3500, date: '2026-11-10' },
      before: { categoryId: null }, after: { categoryId: 'cat-fees', categoryName: 'Bank Fees', taxonomyId: 'spending_categories' },
    });
  });

  it('files over a leftover income category, leaves it in place, and Undo takes only the filing off', async () => {
    const { deps, drafts } = make([fee(), refund({ income: INCOME })]);
    await fileFeeReversals(deps);
    expect(deps.assign).toHaveBeenCalledWith('r', 'cat-fees');
    expect(drafts[0].before).toMatchObject({ categoryId: 'cat-inc', categoryName: 'Refunds', taxonomyId: 'income_sources' });
    const undo = planChangeUndo(stampChange(drafts[0], 'companion', new Date('2026-11-18T12:00:00Z')), 'undo', {
      assignments: [{ taxonomyId: 'income_sources', categoryId: 'cat-inc' }, { taxonomyId: 'spending_categories', categoryId: 'cat-fees' }],
    }, { latest: null });
    expect(undo.ok && undo.plan.steps).toEqual([
      { do: 'set-tx', txKey: KEY, flag: 'noAutoFile', label: expect.any(String) },
      { do: 'unassign', activityId: 'r', taxonomyId: 'spending_categories' },
    ]);
  });

  it('never refiles a refund whose filing was undone, nor any keyless row while one is', async () => {
    const undone = make([fee(), refund()], { noAutoFile: (k) => k === KEY });
    expect(await fileFeeReversals(undone.deps)).toEqual({ filed: 0 });
    const keyless = make([fee(), refund()], { sfinAccountOf: () => undefined, anyNoAutoFile: true });
    expect(await fileFeeReversals(keyless.deps)).toEqual({ filed: 0 });
    expect(undone.deps.assign).not.toHaveBeenCalled();
    expect(keyless.deps.assign).not.toHaveBeenCalled();
  });

  it('goes on past a refusal, records only what landed, and never throws on a failed read', async () => {
    const rows = [fee(), refund(), fee({ activityId: 'f2', amountCents: 1200 }), refund({ activityId: 'r2', amountCents: 1200, notes: 'ATM FEE REBATE · TRN-4', description: 'ATM FEE REBATE' })];
    const { deps, drafts } = make(rows, { assign: vi.fn(async (id: string) => { if (id === 'r') throw new Error('400'); }) });
    expect(await fileFeeReversals(deps)).toEqual({ filed: 1 });
    expect(drafts.map((d) => d.subject.activityIds)).toEqual([['r2']]);
    const broken = make([], { rows: vi.fn(async () => { throw new Error('db gone'); }) });
    expect(await fileFeeReversals(broken.deps)).toEqual({ filed: 0 });
    expect(broken.deps.log).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd companion && nice npx vitest run --maxWorkers=2 src/fee-reversal-filing.test.ts`
Expected: FAIL, `Cannot find module './fee-reversal-filing.js'`.

- [ ] **Step 3: Implement `fileFeeReversals`, then wire it**

For each filing from `planFeeReversalFilings(await deps.rows(), deps.today)`:
- tx key = `accountTxKey(sfinAccountOf(wfAccountId), txIdFromComment(notes))` when both exist. Skip when `noAutoFile(key)`, or with no key when `anyNoAutoFile` (Amazon's rule).
- `assign(refund.activityId, category.categoryId)`. On a throw: log, skip, no record.
- On success, count it and `record(categoryFiledChange({ actor: 'auto', account: { sfinId?, wfId, name: accountName }, txKey?, activityId, description, amountCents, date, before: income ? { ...income, taxonomyId: 'income_sources' } : null, after: { ...category, taxonomyId: 'spending_categories' }, why: FEE_REVERSAL_FILING_WHY, ...(income ? { restore: [{ taxonomyId: 'income_sources', categoryId: income.categoryId }] } : {}) }))`. A throw from `record` is logged, never fatal.
- Never removes or reassigns the income category (ruling 2). The whole body is in a try/catch that logs; it never throws.

In `companion/src/index.ts`, import `fileFeeReversals` and add `getNativeFeeReversalRows` to the existing `./sqlite-native.js` import. Add beside `fileAmazonLabelledCharges`:

```ts
async function fileFeeReversalRefunds(wfClient: WealthfolioClient, run?: string, overrides: SyncOverrides = emptySyncOverrides()): Promise<void> {
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 90);
  const mapping = parseSecretJson<Record<string, string>>(
    await wfClient.getAddonSecret('simplefin-sync', 'account_mapping').catch(() => null),
    'account_mapping',
  ) ?? {};
  const sfinOf = new Map(Object.entries(mapping).map(([sfin, wf]) => [wf, sfin]));
  const changes: ChangeDraft[] = [];
  const res = await fileFeeReversals({
    rows: async () => getNativeFeeReversalRows(wealthfolioDbPath(), toDateString(start), toDateString(new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1))),
    assign: (activityId, categoryId) => wfClient.assignActivityCategory(activityId, SPENDING_TAXONOMY_ID, categoryId),
    record: (draft) => changes.push(draft),
    sfinAccountOf: (wfAccountId) => sfinOf.get(wfAccountId),
    noAutoFile: (txKey) => hasTxOverride(overrides, txKey, 'noAutoFile'),
    anyNoAutoFile: Object.keys(overrides.tx).some((key) => hasTxOverride(overrides, key, 'noAutoFile')),
    log,
    today: toDateString(end),
  });
  await recordCompanionChanges(wfClient, changes, run).catch((e) => log(`Change log skipped: ${formatError(e)}`));
  if (res.filed > 0) log(`Filed ${res.filed} fee reversal(s) under the category of the fee they reverse.`);
}
```

and call it right after `await fileAmazonLabelledCharges(wfClient, changeLog.run, overrides);` in `runCompanionSyncOnce`:
`await fileFeeReversalRefunds(wfClient, changeLog.run, overrides);`

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd companion && nice npx vitest run --maxWorkers=2 src/fee-reversal-filing.test.ts`
Expected: PASS, 4. Run `cd companion && nice npx tsc --noEmit -p .`: no errors.

- [ ] **Step 5: Commit**

```bash
git add companion/src/fee-reversal-filing.ts companion/src/fee-reversal-filing.test.ts companion/src/index.ts
git commit -m "Companion files fee reversals under the fee's category, with Undo (#79)"
```

---

### Task 7: Ask SimpleFIN Bridge for protocol v2

**Files:**
- Modify: `shared/simplefin-hosts.ts`, `src/utils/simplefin.ts` (`fetchAccounts`), `companion/src/simplefin.ts` (`fetchAccountsNode`)
- Test: `shared/simplefin-hosts.test.ts`, `src/utils/simplefin.test.ts`, `companion/src/simplefin.test.ts`

**Interfaces:**
- Produces: `isSimplefinBridgeHost(hostname: string): boolean` (`simplefin.org` or any `*.simplefin.org`, case-insensitive).

- [ ] **Step 1: Write the failing tests**

`shared/simplefin-hosts.test.ts`: add `isSimplefinBridgeHost` to the import and append

```ts
describe('isSimplefinBridgeHost (#81: only the Bridge is asked for protocol v2)', () => {
  it('is simplefin.org and its subdomains, nothing else', () => {
    expect(isSimplefinBridgeHost('bridge.simplefin.org')).toBe(true);
    expect(isSimplefinBridgeHost('beta-bridge.simplefin.org')).toBe(true);
    expect(isSimplefinBridgeHost('SimpleFIN.org')).toBe(true);
    expect(isSimplefinBridgeHost('www.lunchflow.app')).toBe(false);
    expect(isSimplefinBridgeHost('evilsimplefin.org')).toBe(false);
    expect(isSimplefinBridgeHost('simplefin.org.evil.com')).toBe(false);
  });
});
```

`src/utils/simplefin.test.ts`, inside `describe('fetchAccounts', …)` before `fetches from a Lunch Flow access URL (#25)`:

```ts
  it('asks SimpleFIN Bridge for protocol v2 (#81)', async () => {
    const network = makeNetwork(() => okResponse(JSON.stringify({ errlist: [], connections: [], accounts: [] })));
    await fetchAccounts('https://user:pass@beta-bridge.simplefin.org/simplefin', new Date('2024-01-01T00:00:00Z'), network);
    const [calledReq] = (network.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledReq.url).toBe('https://beta-bridge.simplefin.org/simplefin/accounts?start-date=1704067200&pending=1&version=2');
  });

  it('sends Lunch Flow the request it always sent, byte for byte (#81)', async () => {
    const network = makeNetwork(() => okResponse(JSON.stringify({ errors: [], accounts: [] })));
    await fetchAccounts('https://user:pass@www.lunchflow.app/simplefin', new Date('2024-01-01T00:00:00Z'), network);
    const [calledReq] = (network.request as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledReq.url).toBe('https://www.lunchflow.app/simplefin/accounts?start-date=1704067200&pending=1');
  });
```

`companion/src/simplefin.test.ts`, inside `describe('fetchAccountsNode', …)` before `requests pending transactions`:

```ts
  it('asks SimpleFIN Bridge for protocol v2, and sends Lunch Flow the request it always sent (#81)', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ errors: [], accounts: [] }) });
    await fetchAccountsNode('https://u:p@beta-bridge.simplefin.org/simplefin', new Date('2024-01-01T00:00:00Z'));
    await fetchAccountsNode('https://u:p@www.lunchflow.app/simplefin', new Date('2024-01-01T00:00:00Z'));
    expect(mockFetch.mock.calls[0][0]).toBe('https://beta-bridge.simplefin.org/simplefin/accounts?start-date=1704067200&pending=1&version=2');
    expect(mockFetch.mock.calls[1][0]).toBe('https://www.lunchflow.app/simplefin/accounts?start-date=1704067200&pending=1');
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `nice npx vitest run --maxWorkers=2 shared/simplefin-hosts.test.ts src/utils/simplefin.test.ts`
Expected: FAIL, 2 failed | 37 passed: `isSimplefinBridgeHost is not a function`, and the Bridge URL lacks `&version=2`.
Run: `cd companion && nice npx vitest run --maxWorkers=2 src/simplefin.test.ts`
Expected: FAIL, 1 failed | 6 passed.

- [ ] **Step 3: Implement**

`isSimplefinBridgeHost` in `shared/simplefin-hosts.ts` (doc: Lunch Flow's v2 support is unverified). In both fetchers, right after the `pending` parameter is set: `if (isSimplefinBridgeHost(<url>.hostname)) <url>.searchParams.set('version', '2');`. Nothing else in either request changes.

- [ ] **Step 4: Run the tests to see them pass**

Same commands. Expected: PASS, 39 and 7.

- [ ] **Step 5: Commit**

```bash
git add shared/simplefin-hosts.ts shared/simplefin-hosts.test.ts src/utils/simplefin.ts src/utils/simplefin.test.ts companion/src/simplefin.ts companion/src/simplefin.test.ts
git commit -m "Ask SimpleFIN Bridge for protocol v2; Lunch Flow unchanged (#81)"
```

---

### Task 8: Read v2 the way v1 read

**Files:**
- Create: `shared/__fixtures__/simplefin-demo/v1-balances-only.json`, `shared/__fixtures__/simplefin-demo/v2-balances-only.json`
- Modify: `shared/types.ts`, `shared/simplefin-payload.ts` (`normalizeAccountSet`, `describeBridgeError`)
- Test: `shared/simplefin-payload.test.ts`

**Interfaces:**
- Produces: `SimplefinAccount.conn_id?: string`; `interface SimplefinConnection { connId: string; name: string }`; `SimplefinAccountSet.connections?: SimplefinConnection[]` (present only when the payload listed any).

- [ ] **Step 1: Save the fixtures**

The public demo Bridge's answers, fetched 2026-11-18 (`curl -s "https://demo:demo@beta-bridge.simplefin.org/simplefin/accounts?balances-only=1"`, and the same with `&version=2`). Save these exactly; do not refetch (the demo's balances move).

`v1-balances-only.json`:

```json
{
  "errors": [],
  "accounts": [
    {"id": "Demo Savings", "name": "SimpleFIN Savings", "currency": "USD", "balance": "114965.51", "available-balance": "114965.51", "balance-date": 1795046400, "transactions": [], "holdings": [], "org": {"domain": "beta-bridge.simplefin.org", "name": "SimpleFIN Demo", "sfin-url": "https://beta-bridge.simplefin.org/simplefin", "url": "https://beta-bridge.simplefin.org", "id": "simplefin.demoorg"}},
    {"id": "Demo Checking", "name": "SimpleFIN Checking", "currency": "USD", "balance": "25401.15", "available-balance": "25401.15", "balance-date": 1795046400, "transactions": [], "holdings": [], "org": {"domain": "beta-bridge.simplefin.org", "name": "SimpleFIN Demo", "sfin-url": "https://beta-bridge.simplefin.org/simplefin", "url": "https://beta-bridge.simplefin.org", "id": "simplefin.demoorg"}},
    {"id": "Demo Empty Account", "name": "SimpleFIN Empty Account", "currency": "USD", "balance": "0.00", "available-balance": "0.00", "balance-date": 1795046400, "transactions": [], "holdings": [], "org": {"domain": "beta-bridge.simplefin.org", "name": "SimpleFIN Demo", "sfin-url": "https://beta-bridge.simplefin.org/simplefin", "url": "https://beta-bridge.simplefin.org", "id": "simplefin.demoorg"}}
  ]
}
```

`v2-balances-only.json`:

```json
{
  "errlist": [],
  "accounts": [
    {"id": "Demo Savings", "name": "SimpleFIN Savings", "currency": "USD", "balance": "114965.51", "available-balance": "114965.51", "balance-date": 1795046400, "transactions": [], "holdings": [], "conn_id": "CON-SIMPLEFIN-DEMO"},
    {"id": "Demo Checking", "name": "SimpleFIN Checking", "currency": "USD", "balance": "25401.15", "available-balance": "25401.15", "balance-date": 1795046400, "transactions": [], "holdings": [], "conn_id": "CON-SIMPLEFIN-DEMO"},
    {"id": "Demo Empty Account", "name": "SimpleFIN Empty Account", "currency": "USD", "balance": "0.00", "available-balance": "0.00", "balance-date": 1795046400, "transactions": [], "holdings": [], "conn_id": "CON-SIMPLEFIN-DEMO"}
  ],
  "connections": [
    {"conn_id": "CON-SIMPLEFIN-DEMO", "name": "SimpleFIN Demo", "org_id": "simplefin.demoorg", "org_name": "SimpleFIN Bridge", "org_url": "https://beta-bridge.simplefin.org", "sfin_url": "https://beta-bridge.simplefin.org/simplefin"}
  ]
}
```

- [ ] **Step 2: Write the failing tests**

In `shared/simplefin-payload.test.ts`, add at the top `import { readFileSync } from 'node:fs';`, `import { join } from 'node:path';`, `import { accountNameWords } from './sync-core.js';`, and append:

```ts
/** The public demo Bridge's answer to `/accounts?balances-only=1`, without and
 *  with `version=2`, as fetched 2026-11-18. */
const demo = (v: 'v1' | 'v2') => JSON.parse(readFileSync(join(process.cwd(), 'shared', '__fixtures__', 'simplefin-demo', `${v}-balances-only.json`), 'utf8'));

describe('normalizeAccountSet reads protocol v2 the way v1 read (#81)', () => {
  it('gives every v2 account the org v1 gave it: the connection name, not org_name', () => {
    const v1 = normalizeAccountSet(demo('v1'));
    const v2 = normalizeAccountSet(demo('v2'));
    expect(v2.accounts.map((a) => a.id)).toEqual(v1.accounts.map((a) => a.id));
    v2.accounts.forEach((a, i) => {
      const old = v1.accounts[i].org!;
      expect(a.org).toEqual({ name: old.name, domain: old.domain, url: old.url, 'sfin-url': old['sfin-url'] });
      expect(a.org!.name).toBe('SimpleFIN Demo');
      expect(a.conn_id).toBe('CON-SIMPLEFIN-DEMO');
      expect(accountNameWords(a.name, a.org?.name)).toEqual(accountNameWords(v1.accounts[i].name, v1.accounts[i].org?.name));
    });
    expect(v2.connections).toEqual([{ connId: 'CON-SIMPLEFIN-DEMO', name: 'SimpleFIN Demo' }]);
    expect(v1.connections).toBeUndefined();
  });

  it('leaves an org v2 already sent, and an account whose connection is not listed', () => {
    const set = normalizeAccountSet({
      connections: [{ conn_id: 'C1', name: 'Fidelity NetBenefits', org_url: 'not a url' }],
      accounts: [
        { id: 'a', name: 'A', currency: 'USD', balance: '0', 'balance-date': 1, conn_id: 'C1' },
        { id: 'b', name: 'B', currency: 'USD', balance: '0', 'balance-date': 1, conn_id: 'C9' },
        { id: 'c', name: 'C', currency: 'USD', balance: '0', 'balance-date': 1, conn_id: 'C1', org: { name: 'Kept' } },
      ],
    });
    expect(set.accounts.map((a) => a.org)).toEqual([{ name: 'Fidelity NetBenefits' }, undefined, { name: 'Kept' }]);
  });

  it('names the connection on a connection error', () => {
    const set = normalizeAccountSet({
      errlist: [{ code: 'con.auth', msg: 'Authentication required', conn_id: 'C1' }],
      connections: [{ conn_id: 'C1', name: 'Fidelity NetBenefits' }],
      accounts: [],
    });
    expect(set.errors).toEqual(['Fidelity NetBenefits: Authentication required']);
  });
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `nice npx vitest run --maxWorkers=2 shared/simplefin-payload.test.ts`
Expected: FAIL, 3 failed | 8 passed (`expected undefined to deeply equal { name: 'SimpleFIN Demo', …(3) }`, and so on).

- [ ] **Step 4: Implement**

In `normalizeAccountSet`:
- Read `raw.connections` (array; entries without a `conn_id` dropped) into `connections: SimplefinConnection[]` (`connId`, `name`) and a map `conn_id → org`, where each org is built by `orgOf(connection)`: `name ← name` when non-empty; `domain ← new URL(org_url).hostname` and `url ← org_url` only when `org_url` parses (else neither); `'sfin-url' ← sfin_url` when non-empty.
- Map each account: one with no `org` and a listed `conn_id` becomes `{ ...a, org }` (a copy; others unchanged). `nameById` is built from these accounts.
- Return `...(connections.length > 0 ? { connections } : {})` beside `accounts`, `errors`, `errorList` (so a v1 set's shape is unchanged; `src/utils/simplefin.test.ts` asserts it).
- `describeBridgeError(nameById, connNameById)`: the account's name first (as now); then, for a `connId` whose connection is listed, `` `${connectionName}: ${msg}` ``; then the existing `(account …)`, `(connection …)` and bare fallbacks.

`shared/types.ts`: `conn_id?: string` on `SimplefinAccount` (doc: v2 only; `normalizeAccountSet` fills `org` from it), `SimplefinConnection` (doc: `name` is what v1 sent as `org.name`, checked against the live demo), and `connections?` on `SimplefinAccountSet`.

- [ ] **Step 5: Run the tests to see them pass**

Run: `nice npx vitest run --maxWorkers=2 shared/simplefin-payload.test.ts src/utils/simplefin.test.ts`
Expected: PASS, 40 (11 + 29).

- [ ] **Step 6: Commit**

```bash
git add shared/__fixtures__/simplefin-demo shared/types.ts shared/simplefin-payload.ts shared/simplefin-payload.test.ts
git commit -m "Read SimpleFin protocol v2 the way v1 read (#81)"
```

---

### Task 9: The connection-problems record, its rules and its words

**Files:**
- Create: `shared/connection-problems.ts`, `shared/connection-problems.test.ts`

**Interfaces:**
- Consumes: `isSimplefinBridgeHost` (Task 7), `SimplefinAccountSet.connections`, `SimplefinAccount.conn_id` (Task 8), `isSimplefinNotice` (`shared/simplefin-payload.ts`). Must NOT import `shared/telegram.ts` or `shared/sync-core.ts` (sync-core imports this module).
- Produces:

```ts
export const SIMPLEFIN_PROBLEMS_SECRET_KEY = 'simplefin_problems';
export const PROBLEM_SHOW_AFTER_MS = 24 * 60 * 60 * 1000;
export const PROBLEM_RECORD_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const PROBLEM_MESSAGE_MAX_CHARS = 200;
export type ConnectionProblemKind = 'signin' | 'other';
export interface ConnectionProblem { key: string; code: string; kind: ConnectionProblemKind; connectionName?: string; sfinAccountIds: string[]; message: string; firstSeenAt: string; lastSeenAt: string }
export interface ConnectionProblemsRecord { checkedAt: string; problems: ConnectionProblem[] }
export type FoundConnectionProblem = Omit<ConnectionProblem, 'firstSeenAt' | 'lastSeenAt'>;
export function problemKind(code: string): ConnectionProblemKind;
export function sanitizeProblemText(text: string, max?: number): string;
export function findConnectionProblems(set: SimplefinAccountSet, inUse: (sfinAccountId: string) => boolean): FoundConnectionProblem[];
export function mergeConnectionProblems(prev: ConnectionProblemsRecord | null, found: readonly FoundConnectionProblem[], now: Date): ConnectionProblemsRecord;
export function parseConnectionProblems(raw: string | null | undefined): ConnectionProblemsRecord | null;
export function isConnectionProblem(p: unknown): p is ConnectionProblem;
export function shownConnectionProblems(record: ConnectionProblemsRecord | null, now: Date, opts?: { maxRecordAgeMs?: number }): ConnectionProblem[];
export function bridgeSiteOf(accessUrl: string | null | undefined): string | null;
export function connectionProblemTitle(p: ConnectionProblem): string;
export function connectionProblemText(p: ConnectionProblem): string;
export function connectionProblemClearedText(p: ConnectionProblem): string;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import {
  bridgeSiteOf, connectionProblemClearedText, connectionProblemText, connectionProblemTitle, findConnectionProblems,
  mergeConnectionProblems, parseConnectionProblems, PROBLEM_RECORD_MAX_AGE_MS, problemKind, sanitizeProblemText,
  shownConnectionProblems, type ConnectionProblem,
} from './connection-problems.js';
import { normalizeAccountSet } from './simplefin-payload.js';

const NOW = new Date('2026-11-18T15:00:00.000Z');
const HOUR = 3_600_000;
const acct = (id: string, conn: string) => ({ id, name: id.toUpperCase(), currency: 'USD', balance: '0', 'balance-date': 1, conn_id: conn });

/** A v2 payload: Fidelity (C1: a1, a2) needs a sign-in, a3 (C3) failed a read,
 *  C2's only account is unmapped, plus a developer error and a bare gen.auth. */
const set = normalizeAccountSet({
  errlist: [
    { code: 'con.auth', msg: 'Authentication required', conn_id: 'C1' },
    { code: 'act.failed', msg: 'Failed to get account information. Try again later.', account_id: 'a3' },
    { code: 'con.auth', msg: 'Authentication required', conn_id: 'C2' },
    { code: 'gen.api', msg: 'Bad parameter' },
    { code: 'gen.auth', msg: 'No credentials provided' },
  ],
  connections: [
    { conn_id: 'C1', name: 'Fidelity NetBenefits' }, { conn_id: 'C2', name: 'Old Bank' }, { conn_id: 'C3', name: 'Ally' },
  ],
  accounts: [acct('a1', 'C1'), acct('a2', 'C1'), acct('a3', 'C3'), acct('a9', 'C2')],
});
const inUse = (id: string) => id !== 'a9';

const problem = (over: Partial<ConnectionProblem>): ConnectionProblem => ({
  key: 'con.auth:C1', code: 'con.auth', kind: 'signin', connectionName: 'Fidelity NetBenefits', sfinAccountIds: ['a1', 'a2'],
  message: 'Fidelity NetBenefits: Authentication required', firstSeenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(), ...over,
});

describe('connection problems (#81)', () => {
  it('reads con.auth and gen.auth as a sign-in, everything else as other', () => {
    expect(['con.auth', 'gen.auth', 'CON.AUTH'].map(problemKind)).toEqual(['signin', 'signin', 'signin']);
    expect(['con.', 'con.weird', 'act.failed', 'act.missingdata', 'legacy'].map(problemKind)).toEqual(['other', 'other', 'other', 'other', 'other']);
  });

  it('keeps each real problem, with the accounts it reaches, and drops the rest', () => {
    expect(findConnectionProblems(set, inUse)).toEqual([
      { key: 'con.auth:C1', code: 'con.auth', kind: 'signin', connectionName: 'Fidelity NetBenefits', sfinAccountIds: ['a1', 'a2'], message: 'Fidelity NetBenefits: Authentication required' },
      { key: 'act.failed:a3', code: 'act.failed', kind: 'other', connectionName: 'Ally', sfinAccountIds: ['a3'], message: 'A3: Failed to get account information. Try again later.' },
      { key: 'gen.auth:No credentials provided', code: 'gen.auth', kind: 'signin', sfinAccountIds: [], message: 'No credentials provided' },
    ]);
  });

  it('keeps a problem on a connection that lists no accounts at all (a dead feed)', () => {
    const dead = normalizeAccountSet({
      errlist: [{ code: 'con.auth', msg: 'Authentication required', conn_id: 'C7' }],
      connections: [{ conn_id: 'C7', name: 'Discover' }],
      accounts: [],
    });
    expect(findConnectionProblems(dead, () => false)).toEqual([
      { key: 'con.auth:C7', code: 'con.auth', kind: 'signin', connectionName: 'Discover', sfinAccountIds: [], message: 'Discover: Authentication required' },
    ]);
  });

  it('keeps a v1 string as other, keyed by its message, and never a window notice', () => {
    const v1 = normalizeAccountSet({ errors: ['Connection to Example Bank may need attention', 'Date range exceeds 60 days'], accounts: [] });
    expect(findConnectionProblems(v1, () => true)).toEqual([
      { key: 'legacy:Connection to Example Bank may need attention', code: 'legacy', kind: 'other', sfinAccountIds: [], message: 'Connection to Example Bank may need attention' },
    ]);
  });

  it('makes what SimpleFin sent plain, short text', () => {
    expect(sanitizeProblemText('  Sign <b>in</b>\nagain\u0007 now ')).toBe('Sign in again now');
    expect(sanitizeProblemText('x'.repeat(500))).toHaveLength(200);
    expect(sanitizeProblemText('x'.repeat(500)).endsWith('…')).toBe(true);
  });

  it('keeps firstSeenAt while a problem is still reported, and drops one that is not', () => {
    const earlier = new Date(NOW.getTime() - 30 * HOUR).toISOString();
    const prev = { checkedAt: earlier, problems: [problem({ firstSeenAt: earlier, lastSeenAt: earlier }), problem({ key: 'gone', firstSeenAt: earlier })] };
    const found = findConnectionProblems(set, inUse);
    const next = mergeConnectionProblems(prev, found, NOW);
    expect(next.checkedAt).toBe(NOW.toISOString());
    expect(next.problems.map((p) => [p.key, p.firstSeenAt, p.lastSeenAt])).toEqual([
      ['con.auth:C1', earlier, NOW.toISOString()],
      ['act.failed:a3', NOW.toISOString(), NOW.toISOString()],
      ['gen.auth:No credentials provided', NOW.toISOString(), NOW.toISOString()],
    ]);
    expect(mergeConnectionProblems(null, [], NOW)).toEqual({ checkedAt: NOW.toISOString(), problems: [] });
  });

  it('shows a sign-in at once and anything else after 24 hours', () => {
    const record = { checkedAt: NOW.toISOString(), problems: [
      problem({}),
      problem({ key: 'young', kind: 'other', firstSeenAt: new Date(NOW.getTime() - 23 * HOUR).toISOString() }),
      problem({ key: 'old', kind: 'other', firstSeenAt: new Date(NOW.getTime() - 24 * HOUR).toISOString() }),
    ] };
    expect(shownConnectionProblems(record, NOW).map((p) => p.key)).toEqual(['con.auth:C1', 'old']);
  });

  it('shows nothing from a record older than 48 hours when asked to judge its age (the add-on)', () => {
    const stale = { checkedAt: new Date(NOW.getTime() - 49 * HOUR).toISOString(), problems: [problem({})] };
    expect(PROBLEM_RECORD_MAX_AGE_MS).toBe(48 * HOUR);
    expect(shownConnectionProblems(stale, NOW, { maxRecordAgeMs: PROBLEM_RECORD_MAX_AGE_MS })).toEqual([]);
    expect(shownConnectionProblems(stale, NOW)).toHaveLength(1);
    expect(shownConnectionProblems(null, NOW)).toEqual([]);
  });

  it('reads back what it wrote, and nothing from garbage', () => {
    const record = { checkedAt: NOW.toISOString(), problems: [problem({}), { key: 'bad' }] };
    expect(parseConnectionProblems(JSON.stringify(record))).toEqual({ checkedAt: NOW.toISOString(), problems: [problem({})] });
    expect(parseConnectionProblems('{nope')).toBeNull();
    expect(parseConnectionProblems(null)).toBeNull();
    expect(parseConnectionProblems('[]')).toBeNull();
  });

  it('links to the Bridge the access URL points at, never with its credentials', () => {
    expect(bridgeSiteOf('https://user:secret@beta-bridge.simplefin.org/simplefin')).toBe('https://beta-bridge.simplefin.org');
    expect(bridgeSiteOf('https://user:secret@www.lunchflow.app/simplefin')).toBeNull();
    expect(bridgeSiteOf('garbage')).toBeNull();
    expect(bridgeSiteOf(null)).toBeNull();
  });

  it('words each problem the same way everywhere', () => {
    expect(connectionProblemTitle(problem({}))).toBe('Fidelity NetBenefits needs you to sign in again');
    expect(connectionProblemText(problem({}))).toBe(
      "Fidelity NetBenefits needs you to sign in again at SimpleFIN Bridge. Until you do, its accounts show the last figures SimpleFin got, not today's.",
    );
    const genAuth = problem({ code: 'gen.auth', connectionName: undefined, sfinAccountIds: [], message: 'No credentials provided' });
    expect(connectionProblemTitle(genAuth)).toBe('SimpleFIN Bridge turned this sync away');
    expect(connectionProblemText(genAuth)).toBe(
      "SimpleFIN Bridge turned this sync away: No credentials provided. Until that's fixed, your accounts show the last figures SimpleFin got, not today's.",
    );
    const other = problem({ kind: 'other', code: 'act.failed', connectionName: 'Ally', message: 'A3: Failed to get account information', firstSeenAt: '2026-11-16T09:00:00.000Z' });
    expect(connectionProblemTitle(other)).toBe("Ally isn't updating");
    expect(connectionProblemText(other)).toBe(
      'SimpleFin has reported this since Nov 16: A3: Failed to get account information. Until it clears, the figures shown are the last ones SimpleFin got.',
    );
    expect(connectionProblemClearedText(problem({}))).toBe('Fidelity NetBenefits is updating again.');
    expect(connectionProblemClearedText(genAuth)).toBe('SimpleFin no longer reports: No credentials provided.');
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `nice npx vitest run --maxWorkers=2 shared/connection-problems.test.ts`
Expected: FAIL, `Failed to resolve import "./connection-problems.js"`.

- [ ] **Step 3: Implement**

- `problemKind`: `signin` for `con.auth`/`gen.auth` (case-insensitive), else `other`.
- `sanitizeProblemText`: strip `<…>` tags, turn control characters (`\u0000-\u001f`, `\u007f-\u009f`) into spaces, collapse whitespace, trim; over `max` (default 200) characters, cut to `max − 1` and add `…`.
- `findConnectionProblems`: entries are `set.errorList` when its length equals `set.errors.length`, else each string of `set.errors` as `{ code: 'legacy', msg, connId: null, accountId: null, key: 'legacy:' + msg }` (sync-core's own convention). For entry `i`, `line = set.errors[i]`. Skip when `isSimplefinNotice(line)` or the code starts with `gen.api`. `sfinAccountIds`: with a `connId`, every account whose `conn_id` matches; else `[accountId]`; else `[]`. Skip when that list is non-empty and none of it is `inUse` (ruling 7). `connectionName`: the listed connection's name for the `connId`, else the named account's connection name, else its `org.name`; sanitised to 80 characters; omitted when empty. `message = sanitizeProblemText(line)`.
- `mergeConnectionProblems`: `checkedAt = now`; each found problem keeps the previous record's `firstSeenAt` for its key (else `now`), `lastSeenAt = now`; anything not found is dropped.
- `isConnectionProblem` / `parseConnectionProblems`: the record must be an object with a parseable `checkedAt` and a `problems` array; malformed problems are filtered out by `isConnectionProblem`; anything else is `null`.
- `shownConnectionProblems`: `[]` for no record; with `maxRecordAgeMs`, `[]` when `now − checkedAt` exceeds it; otherwise `signin` problems, and `other` ones with `now − firstSeenAt ≥ 24h`.
- `bridgeSiteOf`: the URL's `origin` when it parses, is https, and its host is a Bridge host; else `null`.
- Copy (exact, the tests pin it). `who = connectionName ?? 'A SimpleFin connection'`; `sentence(t)` adds a full stop unless `t` ends in `.`, `!`, `?` or `…`; the day is the UTC `Mon D` of `firstSeenAt`, done locally (no `telegram.ts` import):
  - title: signin with a name `` `${name} needs you to sign in again` ``; signin without `'SimpleFIN Bridge turned this sync away'`; other `` `${who} isn't updating` ``.
  - text: signin with a name `` `${name} needs you to sign in again at SimpleFIN Bridge. Until you do, its accounts show the last figures SimpleFin got, not today's.` ``; without `` `SimpleFIN Bridge turned this sync away: ${sentence(message)} Until that's fixed, your accounts show the last figures SimpleFin got, not today's.` ``; other `` `SimpleFin has reported this since ${day}: ${sentence(message)} Until it clears, the figures shown are the last ones SimpleFin got.` ``.
  - cleared: `` `${name} is updating again.` ``, or `` `SimpleFin no longer reports: ${sentence(message)}` ``.

- [ ] **Step 4: Run the test to see it pass**

Run: `nice npx vitest run --maxWorkers=2 shared/connection-problems.test.ts`
Expected: PASS, 11.

- [ ] **Step 5: Commit**

```bash
git add shared/connection-problems.ts shared/connection-problems.test.ts
git commit -m "The SimpleFin connection problems record, its rules and words (#81)"
```

---

### Task 10: Both syncs keep the record

**Files:**
- Modify: `shared/sync-host.ts` (`SyncStore`), `shared/sync-core.ts` (`SyncResult`, `runSyncPass`), `src/utils/secrets.ts` (`KEYS`, two methods), `companion/src/rest-host.ts` (two methods)
- Create: `shared/sync-core-connection-problems.test.ts`
- Test: `src/utils/secrets.test.ts`, `companion/src/rest-host.test.ts`

**Interfaces:**
- Consumes: Task 9's module.
- Produces:
  - `SyncStore.getSimplefinProblems?(): Promise<ConnectionProblemsRecord | null>` (null when absent or not parseable; REJECTS when the secret cannot be read) and `SyncStore.setSimplefinProblems?(record: ConnectionProblemsRecord): Promise<void>`; both implemented by `SecretsStore` and `RestSyncStore` under `simplefin_problems`.
  - `SyncResult.connectionProblems?: ConnectionProblem[]`: the problems shown now; absent when the run downloaded nothing or could not read the record.

- [ ] **Step 1: Write the failing tests**

`shared/sync-core-connection-problems.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConnectionProblemsRecord } from './connection-problems.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { normalizeAccountSet } from './simplefin-payload.js';
import { INTERVAL_SKIP_MESSAGE, runSyncCore, VALUATION_POLL } from './sync-core.js';

const NOW = new Date('2026-11-18T15:00:00.000Z');
const HOUR = 3_600_000;
const acct = (id: string, conn: string) => ({ id, name: id.toUpperCase(), currency: 'USD', balance: '0', 'balance-date': 1795046400, transactions: [], conn_id: conn });
const payload = (errlist: unknown[]) => normalizeAccountSet({
  errlist,
  connections: [{ conn_id: 'C1', name: 'Fidelity NetBenefits' }, { conn_id: 'C2', name: 'Old Bank' }],
  accounts: [acct('a1', 'C1'), acct('a2', 'C1'), acct('a9', 'C2')],
});
const SIGNIN = { code: 'con.auth', msg: 'Authentication required', conn_id: 'C1' };
const FAILED = { code: 'act.failed', msg: 'Failed to get account information', account_id: 'a2' };

/** a1 and a2 mapped; a9 (Old Bank) unmapped. The record lives in `saved`. */
function setup(errlist: unknown[], prev: ConnectionProblemsRecord | null = null, extra: Partial<FakeHostSeed> = {}) {
  const fh = createFakeHost({ accountSet: payload(errlist), mapping: { a1: 'wf-1', a2: 'wf-2' }, accountTypes: { 'wf-1': 'CASH', 'wf-2': 'CASH' }, ...extra });
  const saved: { record: ConnectionProblemsRecord | null } = { record: prev };
  Object.assign(fh.store, {
    getSimplefinProblems: vi.fn(async () => saved.record),
    setSimplefinProblems: vi.fn(async (r: ConnectionProblemsRecord) => { saved.record = r; }),
  });
  return { fh, saved };
}

describe('runSyncCore — SimpleFin connection problems are remembered (#81)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('records a sign-in problem, shows it at once, and still lists the error on the Sync page', async () => {
    const { fh, saved } = setup([SIGNIN, { code: 'con.auth', msg: 'Authentication required', conn_id: 'C2' }]);
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(saved.record).toEqual({ checkedAt: NOW.toISOString(), problems: [{
      key: 'con.auth:C1', code: 'con.auth', kind: 'signin', connectionName: 'Fidelity NetBenefits', sfinAccountIds: ['a1', 'a2'],
      message: 'Fidelity NetBenefits: Authentication required', firstSeenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(),
    }] });
    expect(result.connectionProblems?.map((p) => p.key)).toEqual(['con.auth:C1']);
    expect(result.errors).toContain('SimpleFin: Fidelity NetBenefits: Authentication required');
  });

  it('keeps the episode start, and shows an account problem once it has lasted a day', async () => {
    const start = new Date(NOW.getTime() - 30 * HOUR).toISOString();
    const prev = { checkedAt: start, problems: [{ key: 'act.failed:a2', code: 'act.failed', kind: 'other' as const, connectionName: 'Fidelity NetBenefits', sfinAccountIds: ['a2'], message: 'A2: Failed to get account information', firstSeenAt: start, lastSeenAt: start }] };
    const { fh, saved } = setup([FAILED], prev);
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(saved.record?.problems[0]).toMatchObject({ key: 'act.failed:a2', firstSeenAt: start, lastSeenAt: NOW.toISOString() });
    expect(result.connectionProblems?.map((p) => p.key)).toEqual(['act.failed:a2']);
  });

  it('drops a problem SimpleFin no longer reports', async () => {
    const { fh, saved } = setup([], { checkedAt: NOW.toISOString(), problems: [] });
    saved.record = { checkedAt: '2026-11-17T00:00:00.000Z', problems: [{ key: 'con.auth:C1', code: 'con.auth', kind: 'signin', sfinAccountIds: ['a1'], message: 'x', firstSeenAt: '2026-11-17T00:00:00.000Z', lastSeenAt: '2026-11-17T00:00:00.000Z' }] };
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(saved.record).toEqual({ checkedAt: NOW.toISOString(), problems: [] });
    expect(result.connectionProblems).toEqual([]);
  });

  it('leaves out a problem whose accounts are all ignored', async () => {
    const { fh, saved } = setup([SIGNIN]);
    (fh.store as any).getIgnoredAccounts = async () => ['a1', 'a2'];
    await runSyncCore(fh.host, fh.store, {});
    expect(saved.record?.problems).toEqual([]);
  });

  it('writes nothing, and says nothing, when the record cannot be read', async () => {
    const { fh } = setup([SIGNIN]);
    (fh.store as any).getSimplefinProblems = vi.fn(async () => { throw new Error('401'); });
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(fh.store.setSimplefinProblems).not.toHaveBeenCalled();
    expect(result.connectionProblems).toBeUndefined();
  });

  it('touches nothing on a run that downloaded nothing', async () => {
    const { fh } = setup([SIGNIN]);
    await runSyncCore(fh.host, fh.store, {});
    vi.mocked(fh.store.setSimplefinProblems!).mockClear();
    const skipped = await runSyncCore(fh.host, fh.store, {});
    expect(skipped.errors).toEqual([INTERVAL_SKIP_MESSAGE]);
    expect(skipped.connectionProblems).toBeUndefined();
    expect(fh.store.setSimplefinProblems).not.toHaveBeenCalled();
  });
});
```

Append to `src/utils/secrets.test.ts`:

```ts
describe('SecretsStore SimpleFin connection problems (#81)', () => {
  it('reads and writes the record under the key the companion shares, and nothing from garbage', async () => {
    const { ctx, data } = makeCtxWithData();
    const s = new SecretsStore(ctx);
    expect(await s.getSimplefinProblems()).toBeNull();
    const record = { checkedAt: '2026-11-18T15:00:00.000Z', problems: [{ key: 'con.auth:C1', code: 'con.auth', kind: 'signin' as const, sfinAccountIds: ['a1'], message: 'x', firstSeenAt: '2026-11-18T15:00:00.000Z', lastSeenAt: '2026-11-18T15:00:00.000Z' }] };
    await s.setSimplefinProblems(record);
    expect(JSON.parse(data['simplefin_problems'])).toEqual(record);
    expect(await s.getSimplefinProblems()).toEqual(record);
    data['simplefin_problems'] = '{nope';
    expect(await s.getSimplefinProblems()).toBeNull();
    await s.clearAll();
    expect(data['simplefin_problems']).toBeUndefined();
  });
});
```

First inside `describe('RestSyncStore', …)` in `companion/src/rest-host.test.ts`:

```ts
  it('reads and writes the SimpleFin connection problems under the key the add-on shares, and a failed read rejects (#81)', async () => {
    const secrets = new Map<string, string>();
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;
    const store = new RestSyncStore(client);
    expect(await store.getSimplefinProblems()).toBeNull();
    const record = { checkedAt: '2026-11-18T15:00:00.000Z', problems: [] };
    await store.setSimplefinProblems(record);
    expect(secrets.get('simplefin_problems')).toBe(JSON.stringify(record));
    expect(await store.getSimplefinProblems()).toEqual(record);
    client.getAddonSecret.mockRejectedValueOnce(new Error('401'));
    await expect(store.getSimplefinProblems()).rejects.toThrow('401');
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-connection-problems.test.ts src/utils/secrets.test.ts`
Expected: FAIL, 5 failed | 54 passed: the first four sync-core tests (nothing is recorded) and the secrets test (`getSimplefinProblems is not a function`). The two "nothing" sync-core tests already pass.
Run: `cd companion && nice npx vitest run --maxWorkers=2 src/rest-host.test.ts`
Expected: FAIL, 1 failed | 25 passed.

- [ ] **Step 3: Implement**

- `shared/sync-host.ts`: the two optional methods with a doc comment (who writes it, null vs reject, optional like `setUnmappedAccounts`). Type-only import of `ConnectionProblemsRecord`.
- `src/utils/secrets.ts`: `KEYS.simplefinProblems = SIMPLEFIN_PROBLEMS_SECRET_KEY` (so `clearAll` deletes it); `getSimplefinProblems()` returns `parseConnectionProblems(await secrets.get(KEYS.simplefinProblems))`; `setSimplefinProblems(record)` writes `JSON.stringify(record)`.
- `companion/src/rest-host.ts`: the same through `this.client.getAddonSecret(this.addonId, SIMPLEFIN_PROBLEMS_SECRET_KEY)` (a failed read rejects) and `this.setJson(…)`.
- `shared/sync-core.ts`: add `connectionProblems?: ConnectionProblem[]` to `SyncResult` with the doc above. In `runSyncPass`, right after `const linkedLoan = …` (past the download, the mapping, the ignored list and the loan links):

```ts
  let connectionProblems: ConnectionProblem[] | undefined;
  let priorProblems: ConnectionProblemsRecord | null | undefined;
  try {
    priorProblems = store.getSimplefinProblems ? await store.getSimplefinProblems() : null;
  } catch {
    priorProblems = undefined;            // unreadable: write nothing (ruling 6)
  }
  if (priorProblems !== undefined) {
    const inUse = (id: string) => (!!mapping[id] || linkedLoan(id)) && !ignoredAccountIds.has(id);
    const problemsAt = new Date();
    const record = mergeConnectionProblems(priorProblems, findConnectionProblems(accountSet, inUse), problemsAt);
    await store.setSimplefinProblems?.(record).catch(() => {});
    connectionProblems = shownConnectionProblems(record, problemsAt);
  }
```

and add `...(connectionProblems ? { connectionProblems } : {})` to the final return. Early returns (interval skip, budget, not configured) are untouched, so they carry no `connectionProblems`. The Sync page's `SimpleFin: …` errors are unchanged (Task 8 already names the connection).

- [ ] **Step 4: Run the tests to see them pass**

Same commands. Expected: PASS, 59 and 26. Run `nice npm run type-check`: succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/sync-host.ts shared/sync-core.ts shared/sync-core-connection-problems.test.ts src/utils/secrets.ts src/utils/secrets.test.ts companion/src/rest-host.ts companion/src/rest-host.test.ts
git commit -m "Both syncs keep the SimpleFin connection problems record (#81)"
```

---

### Task 11: The add-on's Home banner and "not updating" mark

**Files:**
- Create: `src/components/ConnectionProblemBanners.tsx`
- Modify: `src/components/AccountList.tsx`, `src/tabs/HomeTab.tsx`, `src/tabs/SettingsTab.tsx`, `src/pages/SyncPage.tsx`
- Test: `src/components/AccountList.test.tsx`, `src/tabs/HomeTab.test.tsx`

**Interfaces:**
- Consumes: `shownConnectionProblems`, `PROBLEM_RECORD_MAX_AGE_MS`, `bridgeSiteOf`, `connectionProblemText`, `connectionProblemTitle` (Task 9); `SecretsStore.getSimplefinProblems` (Task 10).
- Produces: `ConnectionProblemBanners({ problems: readonly ConnectionProblem[]; bridgeSite: string | null })`; `AccountListProps.notUpdating?: ReadonlySet<string>`; HomeTab props `connectionProblems?: readonly ConnectionProblem[]`, `bridgeSite?: string | null`; SettingsTab prop `notUpdating?: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing tests**

`src/components/AccountList.test.tsx`, before `says so when nothing is mapped yet…`:

```tsx
  it('marks only the accounts SimpleFin is not updating (#81)', () => {
    render(<AccountList mapping={mapping} balances={balances} sfinNames={sfinNames} wfNames={wfNames} onOpenAccount={() => {}} notUpdating={new Set(['s2'])} />);
    const chips = screen.getAllByText('not updating');
    expect(chips).toHaveLength(1);
    expect(chips[0].closest('.sfin-acct-card')?.textContent).toContain('Citi Double Cash');
    expect(chips[0].getAttribute('title')).toMatch(/SimpleFin/);
  });
```

Append to `src/tabs/HomeTab.test.tsx` (it already imports `within`, `cleanup`, `waitFor`, `beforeEach`, `afterEach`, and defines `makeProps` and `openAccounts`; `makeProps`' access URL is `https://u:p@bridge.simplefin.org/simplefin`):

```tsx
describe('SimpleFin connection problems on Home (#81)', () => {
  const NOW = new Date('2026-11-18T15:00:00.000Z');
  const HOUR = 3_600_000;
  const signin = {
    key: 'con.auth:C1', code: 'con.auth', kind: 'signin' as const, connectionName: 'Fidelity NetBenefits', sfinAccountIds: ['sfin-1'],
    message: 'Fidelity NetBenefits: Authentication required', firstSeenAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(),
  };
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); cleanup(); });

  it('shows a sign-in banner linking to the Bridge, never the access URL, and marks the account in Settings', async () => {
    const props = makeProps();
    props.store.getSimplefinProblems = vi.fn(async () => ({ checkedAt: NOW.toISOString(), problems: [signin] }));
    const { container } = render(<SyncPage {...props} />);
    expect(await screen.findByText(/Fidelity NetBenefits needs you to sign in again at SimpleFIN Bridge/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open simplefin bridge/i })).toHaveAttribute('href', 'https://bridge.simplefin.org');
    expect(container.innerHTML).not.toContain('u:p@');
    await openAccounts();
    const row = (await screen.findByText('Growth')).closest('.sfin-acct-card') as HTMLElement;
    expect(within(row).getByText('not updating')).toBeInTheDocument();
  });

  it('shows nothing from a record more than 48 hours old, nor a read problem younger than a day', async () => {
    const stale = makeProps();
    stale.store.getSimplefinProblems = vi.fn(async () => ({ checkedAt: new Date(NOW.getTime() - 49 * HOUR).toISOString(), problems: [signin] }));
    render(<SyncPage {...stale} />);
    await waitFor(() => expect(stale.store.getSimplefinProblems).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/needs you to sign in again/)).toBeNull();
    cleanup();

    const young = makeProps();
    young.store.getSimplefinProblems = vi.fn(async () => ({ checkedAt: NOW.toISOString(), problems: [{ ...signin, key: 'act.failed:sfin-1', code: 'act.failed', kind: 'other' as const, firstSeenAt: new Date(NOW.getTime() - 23 * HOUR).toISOString() }] }));
    render(<SyncPage {...young} />);
    await waitFor(() => expect(young.store.getSimplefinProblems).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/isn't updating/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `nice npx vitest run --maxWorkers=2 src/components/AccountList.test.tsx src/tabs/HomeTab.test.tsx -t "not updating|connection problems"`
Expected: FAIL, 3 failed | 68 skipped. The third fails because the page never reads the record (`getSimplefinProblems` not called).

- [ ] **Step 3: Implement**

- `ConnectionProblemBanners`: one `<div className="sfin-banner-warn"><div className="sfin-banner-body">` per problem (key `p.key`). Body: for `other`, `<b>{connectionProblemTitle(p)}. </b>` first; then `connectionProblemText(p)`. For `signin` with a `bridgeSite`, a `<div className="sfin-banner-actions">` holding `<a className="sfin-btn sfin-btn--outline" href={bridgeSite} target="_blank" rel="noreferrer">Open SimpleFIN Bridge</a>` (ReportsTab's link precedent). No emoji.
- `AccountList`: when `notUpdating?.has(sfinId)`, under the row's `.sfin-acct-map` line, `<span className="sfin-chip sfin-chip--off" title="SimpleFin reports a problem with this connection: the figures are the last ones it got. See Home.">not updating</span>`.
- `HomeTab`: render `<ConnectionProblemBanners problems={connectionProblems ?? []} bridgeSite={bridgeSite ?? null} />` right after the `WhyCard`, above the unmapped-account banner.
- `SettingsTab`: pass `notUpdating` through to `AccountList`.
- `SyncPage`:
  - state `simplefinProblems: ConnectionProblemsRecord | null` and `bridgeSite: string | null`;
  - read `store.getSimplefinProblems?.().then(setSimplefinProblems).catch(() => {})` beside each `store.getUnmappedAccounts?.()` call in `loadBalances` and `refreshLiveState` (the post-sync path calls `loadBalances`);
  - one effect on `[store]`: `store.getAccessUrl().then((url) => setBridgeSite(bridgeSiteOf(url))).catch(() => {})` (only the origin is kept);
  - just before the component's final `return (`: `const shownProblems = shownConnectionProblems(simplefinProblems, new Date(), { maxRecordAgeMs: PROBLEM_RECORD_MAX_AGE_MS });` and `const notUpdating = new Set(shownProblems.flatMap((p) => p.sfinAccountIds));`;
  - pass `connectionProblems={shownProblems}` and `bridgeSite={bridgeSite}` to `HomeTab`, `notUpdating={notUpdating}` to `SettingsTab`.

- [ ] **Step 4: Run the tests to see them pass**

Run the Step 2 command. Expected: PASS, 3.
Run: `nice npx vitest run --maxWorkers=2 src/components/AccountList.test.tsx src/tabs/HomeTab.test.tsx src/tabs/SettingsTab.test.tsx src/pages/SyncPage.test.tsx`
Expected: PASS, 152.
Run: `nice npx vitest run --maxWorkers=2 src/tabs/BudgetTab.test.tsx src/tabs/NotificationsTab.test.tsx src/pages/audit-fix-app.test.tsx src/pages/forecast-app.test.tsx src/pages/copy-policy.test.tsx src/pages/reports-inbox.test.tsx src/pages/audit-app.test.tsx src/pages/payback-app.test.tsx src/pages/held-transfers-app.test.tsx`
Expected: PASS, 166 (every other test that renders `SyncPage`).
Run `nice npm run type-check`: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/ConnectionProblemBanners.tsx src/components/AccountList.tsx src/components/AccountList.test.tsx src/tabs/HomeTab.tsx src/tabs/HomeTab.test.tsx src/tabs/SettingsTab.tsx src/pages/SyncPage.tsx
git commit -m "Home says when SimpleFin can't update a connection (#81)"
```

---

### Task 12: Telegram says when a problem starts and when it clears

**Files:**
- Create: `companion/src/connection-problem-notices.ts`, `companion/src/connection-problem-notices.test.ts`
- Modify: `companion/src/index.ts` (one call after `sendUnmappedAccountsNotice`)

**Interfaces:**
- Consumes: `connectionProblemTitle`, `connectionProblemText`, `connectionProblemClearedText`, `isConnectionProblem` (Task 9); `SyncResult.connectionProblems` (Task 10); `escapeMarkdown`, `TelegramSendResult` (`shared/telegram.ts`).
- Produces:

```ts
export const ANNOUNCED_PROBLEMS_SECRET_KEY = 'announced_simplefin_problems';
export interface ProblemNoticeDeps {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  telegram(): Promise<{ send(text: string): Promise<Pick<TelegramSendResult, 'ok' | 'description'>> } | null>; // null: off or unconfigured
  log(msg: string): void;
}
export async function sendConnectionProblemNotices(deps: ProblemNoticeDeps, shown: readonly ConnectionProblem[] | undefined): Promise<void>;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import type { ConnectionProblem } from '../../shared/connection-problems.js';
import { ANNOUNCED_PROBLEMS_SECRET_KEY, sendConnectionProblemNotices, type ProblemNoticeDeps } from './connection-problem-notices.js';

const AT = '2026-11-18T15:00:00.000Z';
const fidelity: ConnectionProblem = {
  key: 'con.auth:C1', code: 'con.auth', kind: 'signin', connectionName: 'Fidelity_NetBenefits', sfinAccountIds: ['a1'],
  message: 'Fidelity_NetBenefits: Authentication required', firstSeenAt: AT, lastSeenAt: AT,
};

function make(over: Partial<ProblemNoticeDeps> = {}, stored?: unknown) {
  const secrets = new Map<string, string>(stored === undefined ? [] : [[ANNOUNCED_PROBLEMS_SECRET_KEY, JSON.stringify(stored)]]);
  const sent: string[] = [];
  const send = vi.fn(async (text: string) => { sent.push(text); return { ok: true }; });
  const deps: ProblemNoticeDeps = {
    getSecret: vi.fn(async (k: string) => secrets.get(k) ?? null),
    setSecret: vi.fn(async (k: string, v: string) => { secrets.set(k, v); }),
    telegram: vi.fn(async () => ({ send })),
    log: vi.fn(),
    ...over,
  };
  const ledger = () => JSON.parse(secrets.get(ANNOUNCED_PROBLEMS_SECRET_KEY) ?? '[]');
  return { deps, sent, send, ledger };
}

describe('sendConnectionProblemNotices (#81)', () => {
  it('announces a newly shown problem once, Markdown-escaped, and records it', async () => {
    const { deps, sent, ledger } = make();
    await sendConnectionProblemNotices(deps, [fidelity]);
    await sendConnectionProblemNotices(deps, [fidelity]);
    expect(sent).toEqual([
      "*Fidelity\\_NetBenefits needs you to sign in again*\nFidelity\\_NetBenefits needs you to sign in again at SimpleFIN Bridge. Until you do, its accounts show the last figures SimpleFin got, not today's.",
    ]);
    expect(ledger()).toEqual([fidelity]);
  });

  it('says when an announced problem clears, and forgets it', async () => {
    const { deps, sent, ledger } = make({}, [fidelity]);
    await sendConnectionProblemNotices(deps, []);
    expect(sent).toEqual(['Fidelity\\_NetBenefits is updating again.']);
    expect(ledger()).toEqual([]);
  });

  it('retries next sync when Telegram did not confirm the send', async () => {
    const send = vi.fn(async () => ({ ok: false, description: 'Bad Request' }));
    const { deps, ledger } = make({ telegram: vi.fn(async () => ({ send })) });
    await sendConnectionProblemNotices(deps, [fidelity]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ledger()).toEqual([]);
  });

  it('with Telegram off sends nothing and records nothing new, but still forgets what cleared', async () => {
    const other = { ...fidelity, key: 'act.failed:a2' };
    const { deps, ledger } = make({ telegram: vi.fn(async () => null) }, [other]);
    await sendConnectionProblemNotices(deps, [fidelity]);
    expect(ledger()).toEqual([]);
  });

  it('reads and writes nothing for a run that read no record', async () => {
    const { deps } = make({}, [fidelity]);
    await sendConnectionProblemNotices(deps, undefined);
    expect(deps.getSecret).not.toHaveBeenCalled();
    expect(deps.setSecret).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const { deps } = make({ getSecret: vi.fn(async () => { throw new Error('down'); }) });
    await expect(sendConnectionProblemNotices(deps, [fidelity])).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `cd companion && nice npx vitest run --maxWorkers=2 src/connection-problem-notices.test.ts`
Expected: FAIL, `Cannot find module './connection-problem-notices.js'`.

- [ ] **Step 3: Implement**

`sendConnectionProblemNotices`:
1. `shown` undefined → return without reading anything.
2. Read the ledger (`ANNOUNCED_PROBLEMS_SECRET_KEY`): a JSON array filtered by `isConnectionProblem`; anything else is `[]`. Match by `key` (ruling 9).
3. `fresh` = shown problems not in the ledger; `cleared` = ledger problems not shown; the next ledger starts as the ledger minus `cleared`.
4. Ask `deps.telegram()` only when `fresh` or `cleared` is non-empty. With a sender:
   - fresh: ONE message, the problems joined by a blank line, each `` `*${escapeMarkdown(title)}*\n${escapeMarkdown(text)}` ``. On `ok`, add them to the ledger; otherwise log `Connection problem notice failed to send, will retry next sync: …` and leave them out.
   - cleared: ONE message, `escapeMarkdown(connectionProblemClearedText(p))` lines joined by `\n`. If it is not `ok`, put them back in the ledger so the next sync says it.
   - Telegram off (`null`): send nothing; fresh problems stay unannounced; cleared ones are simply forgotten.
5. Write the ledger only when its JSON differs from what was read (`raw ?? '[]'`).
6. Everything in a try/catch that logs `Connection problem notice error: …`; it never throws.

In `index.ts`, import it and, right after `await sendUnmappedAccountsNotice(wfClient, result.unmappedAccounts);`:

```ts
    await sendConnectionProblemNotices({
      getSecret: (key) => wfClient.getAddonSecret('simplefin-sync', key),
      setSecret: (key, value) => wfClient.setAddonSecret('simplefin-sync', key, value),
      telegram: async () => {
        const tg = parseSecretJson<any>(await wfClient.getAddonSecret('simplefin-sync', 'telegram_config').catch(() => null), 'telegram_config');
        return tg?.botToken && tg?.chatId && tg.enabled !== false
          ? { send: (text: string) => sendTelegramMessage(tg.botToken, tg.chatId, text) }
          : null;
      },
      log,
    }, result.connectionProblems);
```

Unlike the unmapped notice, it does not defer to the daily report (`dailyReportWillCarry`): the spec wants the one-time notice and the finding both.

- [ ] **Step 4: Run the test to see it pass**

Run: `cd companion && nice npx vitest run --maxWorkers=2 src/connection-problem-notices.test.ts`
Expected: PASS, 6. Run `cd companion && nice npx tsc --noEmit -p .`: no errors.

- [ ] **Step 5: Commit**

```bash
git add companion/src/connection-problem-notices.ts companion/src/connection-problem-notices.test.ts companion/src/index.ts
git commit -m "Telegram says when a SimpleFin connection breaks and when it updates again (#81)"
```

---

### Task 13: The daily report's finding

**Files:**
- Modify: `shared/self-check.ts`, `shared/findings.ts` (`isSnoozable`), `companion/src/findings-menu.ts`, `companion/src/daily-findings.ts` (`gatherFindings`), `companion/src/index.ts` (the report's button)
- Test: `shared/self-check.test.ts`, `companion/src/findings-menu.test.ts`, `companion/src/daily-findings.test.ts`

**Interfaces:**
- Consumes: Task 9's `ConnectionProblem`, `connectionProblemTitle`, `connectionProblemText`, `parseConnectionProblems`, `shownConnectionProblems`, `SIMPLEFIN_PROBLEMS_SECRET_KEY`.
- Produces: `SelfCheckFinding['kind']` gains `'connection-problem'`; `SelfCheckInput.connectionProblems?: readonly ConnectionProblem[]` (already judged shown); finding key `` `connection-problem:${p.key}@${p.firstSeenAt}` ``; `needsFindingsButton(visible: readonly SelfCheckFinding[]): boolean` in `findings-menu.ts`.

- [ ] **Step 1: Write the failing tests**

`shared/self-check.test.ts`: add `formatFindingsSummary, printsInFull` to the `./self-check.js` import, `import { isSnoozable } from './findings.js';` and `import type { ConnectionProblem } from './connection-problems.js';`, and append (the file's `NOW` and `hoursAgo` are used):

```ts
describe('connection problems in the daily report (#81)', () => {
  const signin: ConnectionProblem = {
    key: 'con.auth:C1', code: 'con.auth', kind: 'signin', connectionName: 'Fidelity NetBenefits', sfinAccountIds: ['a1'],
    message: 'Fidelity NetBenefits: Authentication required', firstSeenAt: hoursAgo(2), lastSeenAt: hoursAgo(0),
  };

  it('is one problem per connection, printed in full, that can still be snoozed by its episode', () => {
    const [f] = evaluateSelfCheck({ lastSuccessAt: hoursAgo(1), connectionProblems: [signin] }, NOW);
    expect(f).toEqual({
      kind: 'connection-problem', severity: 'problem',
      key: `connection-problem:con.auth:C1@${signin.firstSeenAt}`,
      label: 'Fidelity NetBenefits needs you to sign in again',
      message: "Fidelity NetBenefits needs you to sign in again at SimpleFIN Bridge. Until you do, its accounts show the last figures SimpleFin got, not today's.",
    });
    expect(printsInFull(f)).toBe(true);
    expect(isSnoozable(f)).toBe(true);
    expect(formatFindingsSummary([f])).toContain('🚨 Fidelity NetBenefits needs you to sign in again at SimpleFIN Bridge');
  });

  it('says nothing without problems', () => {
    expect(evaluateSelfCheck({ lastSuccessAt: hoursAgo(1), connectionProblems: [] }, NOW)).toEqual([]);
  });
});
```

`companion/src/findings-menu.test.ts`: add `needsFindingsButton` to the `./findings-menu.js` import and append:

```ts
describe('needsFindingsButton (#81)', () => {
  const finding = (over: Partial<SelfCheckFinding>): SelfCheckFinding => ({ kind: 'feed-stale', severity: 'warning', message: 'm', key: 'k', ...over });
  it('is there when something is folded, or a problem printed in full can be snoozed', () => {
    expect(needsFindingsButton([finding({})])).toBe(true);
    expect(needsFindingsButton([finding({ kind: 'connection-problem', severity: 'problem' })])).toBe(true);
    expect(needsFindingsButton([finding({ kind: 'sync-failing', severity: 'problem', key: undefined })])).toBe(false);
    expect(needsFindingsButton([])).toBe(false);
  });
});
```

`companion/src/daily-findings.test.ts`, appended (uses the file's `NOW`, `makeDeps`, `healthy`, `FINDING_SNOOZES_SECRET_KEY`):

```ts
describe('gatherFindings — SimpleFin connection problems (#81)', () => {
  const at = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  const problem = (key: string, kind: 'signin' | 'other', firstSeenAt: string) => ({
    key, code: kind === 'signin' ? 'con.auth' : 'act.failed', kind, connectionName: 'Fidelity NetBenefits', sfinAccountIds: ['a1'],
    message: 'Fidelity NetBenefits: Authentication required', firstSeenAt, lastSeenAt: at(0),
  });

  it('reports the problems being shown, and leaves a snoozed one out', async () => {
    const record = { checkedAt: at(0), problems: [problem('con.auth:C1', 'signin', at(1)), problem('act.failed:a2', 'other', at(2)), problem('act.failed:a3', 'other', at(30))] };
    const { deps } = makeDeps({ simplefin_problems: JSON.stringify(record) });
    const found = await gatherFindings(deps, NOW, { recordLedgerChecks: false, ...healthy });
    expect(found.visible.filter((f) => f.kind === 'connection-problem').map((f) => f.key)).toEqual([
      `connection-problem:con.auth:C1@${at(1)}`, `connection-problem:act.failed:a3@${at(30)}`,
    ]);
    const snoozed = makeDeps({
      simplefin_problems: JSON.stringify(record),
      [FINDING_SNOOZES_SECRET_KEY]: JSON.stringify({ [`connection-problem:con.auth:C1@${at(1)}`]: at(-24) }),
    });
    const after = await gatherFindings(snoozed.deps, NOW, { recordLedgerChecks: false, ...healthy });
    expect(after.snoozed.map((f) => f.key)).toEqual([`connection-problem:con.auth:C1@${at(1)}`]);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `nice npx vitest run --maxWorkers=2 shared/self-check.test.ts`
Expected: FAIL, 1 failed | 28 passed.
Run: `cd companion && nice npx vitest run --maxWorkers=2 src/findings-menu.test.ts src/daily-findings.test.ts`
Expected: FAIL, 2 failed | 40 passed (`needsFindingsButton is not a function`; no `connection-problem` finding).

- [ ] **Step 3: Implement**

- `shared/self-check.ts`: the kind and the input field (docs: printed in full, yet snoozable; already judged shown). In `evaluateSelfCheck`, before the unmapped-account finding, one finding per problem: `{ kind: 'connection-problem', severity: 'problem', key: \`connection-problem:${p.key}@${p.firstSeenAt}\`, label: connectionProblemTitle(p), message: connectionProblemText(p) }`. `printsInFull` also returns true for `connection-problem`.
- `shared/findings.ts`: `isSnoozable(f)` = `!!f.key && (!printsInFull(f) || f.kind === 'connection-problem')` (ruling 4).
- `companion/src/findings-menu.ts`: `needsFindingsButton(visible)` = `visible.some((f) => !printsInFull(f) || isSnoozable(f))` (import `printsInFull`).
- `companion/src/index.ts` (the daily report composer): replace `const folded = …` and `if (folded > 0) rows.push([SHOW_FINDINGS_BUTTON]);` with `if (needsFindingsButton(visible)) rows.push([SHOW_FINDINGS_BUTTON]);`, and drop `printsInFull` from the `../../shared/self-check.js` import if nothing else uses it.
- `companion/src/daily-findings.ts`: pass to `evaluateSelfCheck` `connectionProblems: shownConnectionProblems(parseConnectionProblems(await deps.getSecret(SIMPLEFIN_PROBLEMS_SECRET_KEY).catch(() => null)), now)` (no 48-hour rule here: ruling 12).

- [ ] **Step 4: Run the tests to see them pass**

Run: `nice npx vitest run --maxWorkers=2 shared/self-check.test.ts shared/findings.test.ts`
Expected: PASS, 37.
Run: `cd companion && nice npx vitest run --maxWorkers=2 src/findings-menu.test.ts src/daily-findings.test.ts`
Expected: PASS, 42.
Run `nice npm run type-check` and `cd companion && nice npx tsc --noEmit -p .`: no errors.

- [ ] **Step 5: Commit**

```bash
git add shared/self-check.ts shared/self-check.test.ts shared/findings.ts companion/src/findings-menu.ts companion/src/findings-menu.test.ts companion/src/daily-findings.ts companion/src/daily-findings.test.ts companion/src/index.ts
git commit -m "The daily report lists SimpleFin connection problems; snoozable (#81)"
```

---

### Task 14: Home Assistant alerts and the `/status` count

**Files:**
- Modify: `shared/home-assistant.ts` (`HA_KINDS`, `syncAlertEntries`), `companion/src/status-server.ts` (`SyncStatus`, `createSyncStatus`, `statusReply`)
- Test: `shared/home-assistant.test.ts`, `companion/src/status-server.test.ts`

**Interfaces:**
- Consumes: `SyncResult.connectionProblems` (Task 10), `connectionProblemTitle`, `connectionProblemText` (Task 9).
- Produces: HA entry id `` `sfproblem:${p.key}@${p.firstSeenAt}` ``, `HA_KINDS.sfproblem = 'connection_problem'`; `SyncStatus.connectionProblems?: number`; `finish(outcome, counts: { imported: number; skipped: number; connectionProblems?: readonly unknown[] })`.

- [ ] **Step 1: Write the failing tests**

`shared/home-assistant.test.ts`: add `haKind` to the `./home-assistant.js` import and `import type { ConnectionProblem } from './connection-problems.js';`; append (uses the file's `NOW`, `emptyResult`, `nothingKnown`, `IMPORTS_OFF`):

```ts
describe('syncAlertEntries — SimpleFin connection problems (#81)', () => {
  const signin: ConnectionProblem = {
    key: 'con.auth:C1', code: 'con.auth', kind: 'signin', connectionName: 'Fidelity NetBenefits', sfinAccountIds: ['a1'],
    message: 'Fidelity NetBenefits: Authentication required', firstSeenAt: '2027-03-15T09:00:00.000Z', lastSeenAt: NOW.toISOString(),
  };

  it('alerts once per episode: the id carries when the problem started', () => {
    const [e] = syncAlertEntries(emptyResult({ connectionProblems: [signin] }), NOW, nothingKnown, IMPORTS_OFF);
    expect(e).toEqual({
      id: 'sfproblem:con.auth:C1@2027-03-15T09:00:00.000Z',
      title: 'Fidelity NetBenefits needs you to sign in again',
      message: "Fidelity NetBenefits needs you to sign in again at SimpleFIN Bridge. Until you do, its accounts show the last figures SimpleFin got, not today's.",
      createdAt: NOW.toISOString(),
      link: expect.stringContaining('home'),
    });
    expect(haKind(e)).toBe('connection_problem');
    const [again] = syncAlertEntries(emptyResult({ connectionProblems: [{ ...signin, firstSeenAt: '2027-03-20T09:00:00.000Z' }] }), NOW, nothingKnown, IMPORTS_OFF);
    expect(again.id).not.toBe(e.id);
  });

  it('says nothing for a run that read no problems', () => {
    expect(syncAlertEntries(emptyResult(), NOW, nothingKnown, IMPORTS_OFF)).toEqual([]);
    expect(syncAlertEntries(emptyResult({ connectionProblems: [] }), NOW, nothingKnown, IMPORTS_OFF)).toEqual([]);
  });
});
```

`companion/src/status-server.test.ts`, appended (uses the file's `clock`, `T0`, `counts`):

```ts
describe('the connection problem count (#81)', () => {
  const problem = { key: 'k' };
  it('keeps the count of the last run that read the record, with no names', () => {
    const status = createSyncStatus(clock(T0));
    expect(status.snapshot()).not.toHaveProperty('connectionProblems');
    status.begin().finish('synced', { ...counts, connectionProblems: [problem, problem] });
    expect(status.snapshot().connectionProblems).toBe(2);
    status.begin().finish('too-soon', counts);
    expect(status.snapshot().connectionProblems).toBe(2);
    status.begin().finish('synced', { ...counts, connectionProblems: [] });
    expect(status.snapshot().connectionProblems).toBe(0);
  });

  it('puts the count on the page', () => {
    const out = statusReply('GET', '/status', 'v', { running: false, lastRun: null, lastSyncedAt: null, connectionProblems: 1 });
    expect(JSON.parse(out.body)).toEqual({ version: 'v', ok: true, running: false, lastRun: null, lastSyncedAt: null, connectionProblems: 1 });
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `nice npx vitest run --maxWorkers=2 shared/home-assistant.test.ts`
Expected: FAIL, 1 failed | 66 passed.
Run: `cd companion && nice npx vitest run --maxWorkers=2 src/status-server.test.ts`
Expected: FAIL, 2 failed | 31 passed.

- [ ] **Step 3: Implement**

- `syncAlertEntries`: before the import notice, push for each `result.connectionProblems ?? []` an entry `{ id: \`sfproblem:${p.key}@${p.firstSeenAt}\`, title: connectionProblemTitle(p), message: connectionProblemText(p), createdAt: now.toISOString() }` (the existing final map adds the Home link). Comment: the id carries the episode because a known id is ignored for 30 days; no "updating again" alert here. Add `sfproblem: 'connection_problem'` to `HA_KINDS`. Both writers already call `syncAlertEntries` with their `SyncResult`.
- `createSyncStatus`: keep `connectionProblems: number | null` (start `null`); in `finish`, before settling and only for a first finish, set it to `counts.connectionProblems.length` when that array is given (a run without it keeps the last count, ruling 10); `snapshot()` adds `connectionProblems` only when not `null`; `statusReply`'s body adds it only when defined. `runCompanionSync` already passes the whole `SyncResult` to `finish`.

- [ ] **Step 4: Run the tests to see them pass**

Same commands. Expected: PASS, 67 and 33. Run `cd companion && nice npx tsc --noEmit -p .`: no errors.

- [ ] **Step 5: Commit**

```bash
git add shared/home-assistant.ts shared/home-assistant.test.ts companion/src/status-server.ts companion/src/status-server.test.ts
git commit -m "Home Assistant alerts and /status count SimpleFin connection problems (#81)"
```

---

### Task 15: CHANGELOG and README

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`), `README.md`

- [ ] **Step 1: CHANGELOG**

Under `## [Unreleased]`, in a `### Fixed` subsection (create it, or add to the one the #83/#80 plan made):

```markdown
- **A bank fee coming back is a refund, not income (#79).** "OVERDRAFT FEE
  REFUND", "Monthly Maintenance Fee Waived", "LATE PAYMENT FEE REVERSAL" and
  the like now import as a Credit marked Refund on cash and card accounts,
  which Wealthfolio takes off spending, instead of a deposit (income) or a card
  payment. Ones still in the fetch window are retyped on the next sync, and the
  change log says "Retyped". A transaction rule still wins, and a payback stays
  a payback. With the companion, each is also filed under the category of the
  fee it reverses (same account, same amount, up to 30 days before), with Undo
  in the change log; one you or a rule already put in a spending category is
  never touched. An ATM rebate of another bank's fee has no fee row to copy
  from: file it once, or add a rule. Update both halves: an older add-on or
  companion types these back to deposits.
- **SimpleFin's connection problems are shown, not hidden (#81).** Both halves
  now ask SimpleFIN Bridge for protocol version 2, which names the bank
  connection behind each problem (Lunch Flow is asked exactly as before). A
  connection that needs you to sign in again at the Bridge gets a banner on
  Home at once, with a link to the Bridge, and its accounts are marked "not
  updating" in Settings → Accounts. Other problems show once they have lasted a
  day. The companion sends a Telegram notice when one starts and when it
  clears, lists it in the daily report until then (snooze it there if you
  know), sends a Home Assistant alert, and counts them on the status page.
  Until you sign in again, the add-on can only show the last figures SimpleFin
  got.
```

- [ ] **Step 2: README**

1. In "Transfers, card payments & refunds", before the "Cash-transfer legs…" bullet:

```markdown
- A bank fee coming back ("OVERDRAFT FEE REFUND", "Monthly Maintenance Fee
  Waived", "LATE PAYMENT FEE REVERSAL") imports as a **Credit** marked Refund on
  a cash or card account, never as income, a card payment or half of a
  transfer. The text needs a fee word (`fee`, `service charge`, `late charge`)
  and a word saying it came back (waived, reversal, refund, rebate,
  reimbursement, adjustment, credit). A transaction rule overrides it. With the
  companion, it is filed under the category of the fee it reverses: same
  account, same amount, up to 30 days before, closest first. One you already
  put in a spending category is left alone, and Undo in the change log takes
  the filing off for good.
```

2. A new section right before "### Ignore rules":

```markdown
### When SimpleFin can't update a connection

SimpleFIN Bridge keeps serving a connection's last figures when the bank needs
you to sign in again, so its accounts look current. The add-on and companion
ask the Bridge (protocol version 2; Lunch Flow is asked as before) which
connection has a problem, and say so:
- **Sign in again**: a banner on Home at once, with a link to the Bridge, and
  "not updating" next to the affected accounts in Settings → Accounts.
- **Anything else** (an account SimpleFin could not read, say): the same, once
  it has lasted a day, so a one-off "try again later" stays quiet.
- With the companion: a Telegram notice when a problem starts and another when
  it clears, a line in the daily report while it lasts (snoozable), a Home
  Assistant alert, and a count on the status page.

A problem on an account you don't sync is left out. The add-on hides a record
more than two days old. The figures update again once SimpleFin does.
```

3. "Home Assistant alerts": the list of problem alerts gains "SimpleFin connection problems" after "new accounts".
4. "Status page": the JSON sample's last line becomes `"lastSyncedAt": "…", "connectionProblems": 0 }`, followed by: "`connectionProblems` counts the SimpleFin connection problems being shown, as of the last run that read the feed. It is absent until one has."

- [ ] **Step 3: Check and commit**

Run: `grep -n "#79\|#81" CHANGELOG.md` (two lines under `[Unreleased]`) and `grep -n "When SimpleFin can't update a connection\|connectionProblems" README.md` (the section and the status line).

```bash
git add CHANGELOG.md README.md
git commit -m "Docs: fee reversals (#79) and SimpleFin connection problems (#81)"
```

---

### Task 16: Gates and the 2027 clock

- [ ] **Step 1: Run every gate once**

Run: `nice npx vitest run --maxWorkers=2` → PASS. On the verification clone (base 995eece plus this plan only): 217 files, 4759 tests (+71).
Run: `(cd companion && nice npx vitest run --maxWorkers=2)` → PASS. On the clone: 79 files, 1769 tests (+19).
Run: `nice npm run type-check` → succeeds.
Run: `nice npm --prefix companion run build` → succeeds.
With the #83/#80 plan landed first, the totals are higher by that plan's tests; every file must pass.

- [ ] **Step 2: Run the changed test files with the clock forced to 2027**

The repo's throwaway recipe (nothing here is committed):

```sh
cat > zz-2027.setup.ts <<'EOF2'
import { beforeEach, vi } from 'vitest';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-01-01T12:00:00Z')); });
EOF2
cp zz-2027.setup.ts companion/zz-2027.setup.ts
printf "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { environment: 'jsdom', globals: true, testTimeout: 15000, setupFiles: ['./src/test-setup.ts', './zz-2027.setup.ts'] } });\n" > zz-2027.config.mts
printf "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { globals: true, setupFiles: ['./zz-2027.setup.ts'] } });\n" > companion/zz-2027.config.mts
nice npx vitest run --maxWorkers=2 --config zz-2027.config.mts shared/fee-reversal.test.ts shared/mapper.test.ts shared/sync-core-fee-reversal.test.ts shared/tx-story-fee-reversal.test.ts shared/simplefin-hosts.test.ts src/utils/simplefin.test.ts shared/simplefin-payload.test.ts shared/connection-problems.test.ts shared/sync-core-connection-problems.test.ts src/utils/secrets.test.ts src/components/AccountList.test.tsx src/tabs/HomeTab.test.tsx shared/self-check.test.ts shared/home-assistant.test.ts
(cd companion && nice npx vitest run --maxWorkers=2 --config zz-2027.config.mts src/sqlite-native.test.ts src/sqlite-native-real-cli.test.ts src/fee-reversal-filing.test.ts src/simplefin.test.ts src/rest-host.test.ts src/connection-problem-notices.test.ts src/findings-menu.test.ts src/daily-findings.test.ts src/status-server.test.ts)
rm zz-2027.setup.ts zz-2027.config.mts companion/zz-2027.setup.ts companion/zz-2027.config.mts
git status --short
```

Expected: PASS. On the clone: 14 files, 367 tests (root) and 9 files, 237 tests (companion). `git status --short` shows nothing: the throwaway files are gone.

---

## Self-review

- **Spec coverage.** #79 type (Task 1), its place before the keywords and after rules (Task 1), the flag out of pairing and learned typing (Task 2), paybacks kept and never REFUND (Task 2), retyping stored DEPOSITs (Task 2), the story line (Task 3), the companion-only pass with its window, matching, expense-kind guard, income-as-none, Undo and no refiling (Tasks 4–6), the release-notes warning about two writers (Task 15). #81 v2 for the Bridge only (Task 7), the normalisation and real-payload test (Task 8), error lines naming the connection (Task 8), the record, its write by every 200 in both hosts, kinds, drops and sanitising (Tasks 9–10), the 24h and 48h rules (Tasks 9, 11), Home banner with link and the "not updating" mark (Task 11), Telegram notice and clear notice with a ledger (Task 12), the daily finding (Task 13), Home Assistant with episode keys and no "updating again", and the `/status` count (Task 14), docs (Task 15). Nothing in "Not doing" is built.
- **Step scan.** Each test step carries its code; each code step names the file, the signature and the values the spec pins; algorithm bodies are given only for the matcher, the reader's SQL, the sync-core write, the notice flow and the index wiring.
- **Type consistency.** `FeeReversalRow` / `NativeFeeReversalRow` / `planFeeReversalFilings<R>` / `fileFeeReversals`; `ConnectionProblem` / `ConnectionProblemsRecord` / `findConnectionProblems` / `mergeConnectionProblems` / `shownConnectionProblems` / `isConnectionProblem`; `getSimplefinProblems` / `setSimplefinProblems`; `SyncResult.connectionProblems`; the key strings `simplefin_problems`, `announced_simplefin_problems`, `connection-problem:<key>@<firstSeenAt>`, `sfproblem:<key>@<firstSeenAt>` are used identically in every task.
- **Review Focus.** Each of the five lines has its test in the owning task (9, 5, 4, 10 and 12, 12 and 11).
