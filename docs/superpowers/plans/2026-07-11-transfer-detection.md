# Transfer Detection, Card Refund Typing & Drift Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transfers between synced accounts import as linked TRANSFER_OUT/TRANSFER_IN pairs (excluded from spending analytics), credit-card refunds import as CREDIT, and the companion warns when balances drift from SimpleFin.

**Architecture:** A pure pair-matching module in `shared/` used by both syncers; account-type-aware default typing in the shared mapper; the Docker companion links pairs via Wealthfolio's `/activities/link` API through a search-based reconciliation sweep each run (the in-app addon only types, never links — SDK has no link method).

**Tech Stack:** TypeScript, Vitest, Node 22 fetch (companion), Wealthfolio addon SDK v3.6 (addon).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-11-transfer-detection-design.md`.
- Never break the dedup key: activity `comment` stays exactly `` `${tx.description} · ${tx.id}` `` and `Starting balance · ${sfAccount.id}`.
- Rule-typed transactions are never overridden by auto-pairing.
- Link/search failures are logged, never fatal, and never block `lastSyncAt` advancement.
- Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Addon tests run from repo root (`npx vitest run`), companion tests from `companion/` (`cd companion && npx vitest run`). Both must stay green after every task.
- Amendment to spec §3 (recorded in spec): linking is sweep-only — the sweep runs immediately after import in the same cycle, so separate import-response-ID linking is redundant.

---

### Task 1: Pair-matching module (`shared/transfers.ts`)

**Files:**
- Create: `shared/transfers.ts`
- Test: `shared/transfers.test.ts` (picked up by root vitest, same as `shared/mapper.test.ts`)

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `TRANSFER_MATCH_WINDOW_SECONDS: number` (3 days in seconds)
  - `interface TransferCandidate { txId: string; accountId: string; posted: number; amount: number; ruleTyped: boolean }`
  - `interface TransferPair { outTxId: string; inTxId: string }`
  - `interface TransferDetection { typeByTxId: Map<string, 'TRANSFER_OUT' | 'TRANSFER_IN'>; pairs: TransferPair[] }`
  - `function detectTransferPairs(candidates: TransferCandidate[]): TransferDetection`

- [ ] **Step 1: Write the failing tests**

```typescript
// shared/transfers.test.ts
import { describe, it, expect } from 'vitest';
import { detectTransferPairs, TRANSFER_MATCH_WINDOW_SECONDS } from './transfers';
import type { TransferCandidate } from './transfers';

const DAY = 24 * 60 * 60;
const T0 = 1_760_000_000;

function cand(over: Partial<TransferCandidate>): TransferCandidate {
  return { txId: 'tx', accountId: 'acct', posted: T0, amount: 0, ruleTyped: false, ...over };
}

describe('detectTransferPairs', () => {
  it('pairs equal-amount opposite-sign transactions in different accounts', () => {
    const out = cand({ txId: 'out-1', accountId: 'checking', amount: -1982.19 });
    const inn = cand({ txId: 'in-1', accountId: 'card', amount: 1982.19, posted: T0 + DAY });
    const d = detectTransferPairs([out, inn]);
    expect(d.pairs).toEqual([{ outTxId: 'out-1', inTxId: 'in-1' }]);
    expect(d.typeByTxId.get('out-1')).toBe('TRANSFER_OUT');
    expect(d.typeByTxId.get('in-1')).toBe('TRANSFER_IN');
  });

  it('does not pair transactions in the same account', () => {
    const d = detectTransferPairs([
      cand({ txId: 'a', accountId: 'checking', amount: -50 }),
      cand({ txId: 'b', accountId: 'checking', amount: 50 }),
    ]);
    expect(d.pairs).toHaveLength(0);
  });

  it('does not pair different amounts (cent precision)', () => {
    const d = detectTransferPairs([
      cand({ txId: 'a', accountId: 'x', amount: -50.01 }),
      cand({ txId: 'b', accountId: 'y', amount: 50.02 }),
    ]);
    expect(d.pairs).toHaveLength(0);
  });

  it('does not pair beyond the 3-day window', () => {
    const d = detectTransferPairs([
      cand({ txId: 'a', accountId: 'x', amount: -50 }),
      cand({ txId: 'b', accountId: 'y', amount: 50, posted: T0 + TRANSFER_MATCH_WINDOW_SECONDS + 1 }),
    ]);
    expect(d.pairs).toHaveLength(0);
  });

  it('excludes rule-typed transactions from pairing', () => {
    const d = detectTransferPairs([
      cand({ txId: 'a', accountId: 'x', amount: -50, ruleTyped: true }),
      cand({ txId: 'b', accountId: 'y', amount: 50 }),
    ]);
    expect(d.pairs).toHaveLength(0);
    expect(d.typeByTxId.size).toBe(0);
  });

  it('prefers the nearest-dated counterpart', () => {
    const d = detectTransferPairs([
      cand({ txId: 'out', accountId: 'x', amount: -50, posted: T0 + DAY }),
      cand({ txId: 'far', accountId: 'y', amount: 50, posted: T0 + 3 * DAY }),
      cand({ txId: 'near', accountId: 'y', amount: 50, posted: T0 + DAY }),
    ]);
    expect(d.pairs).toEqual([{ outTxId: 'out', inTxId: 'near' }]);
  });

  it('is deterministic on exact ties (earlier posted, then txId order wins)', () => {
    const d1 = detectTransferPairs([
      cand({ txId: 'out', accountId: 'x', amount: -50 }),
      cand({ txId: 'tie-b', accountId: 'y', amount: 50, posted: T0 + DAY }),
      cand({ txId: 'tie-a', accountId: 'z', amount: 50, posted: T0 + DAY }),
    ]);
    expect(d1.pairs).toEqual([{ outTxId: 'out', inTxId: 'tie-a' }]);
  });

  it('matches multiple pairs, each transaction at most once', () => {
    const d = detectTransferPairs([
      cand({ txId: 'o1', accountId: 'x', amount: -50 }),
      cand({ txId: 'o2', accountId: 'x', amount: -50, posted: T0 + DAY }),
      cand({ txId: 'i1', accountId: 'y', amount: 50 }),
      cand({ txId: 'i2', accountId: 'y', amount: 50, posted: T0 + DAY }),
    ]);
    expect(d.pairs).toHaveLength(2);
    const used = d.pairs.flatMap((p) => [p.outTxId, p.inTxId]);
    expect(new Set(used).size).toBe(4);
  });

  it('ignores zero and non-finite amounts', () => {
    const d = detectTransferPairs([
      cand({ txId: 'a', accountId: 'x', amount: 0 }),
      cand({ txId: 'b', accountId: 'y', amount: NaN }),
    ]);
    expect(d.pairs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd "/Users/nawrig04/Personal Projects/wealthfolio-simplefin-addon" && npx vitest run shared/transfers.test.ts`
Expected: FAIL — cannot resolve `./transfers`.

- [ ] **Step 3: Write the implementation**

```typescript
// shared/transfers.ts
/**
 * Automatic transfer-pair detection across synced accounts.
 *
 * Two transactions form a transfer pair when they sit in different accounts,
 * have equal absolute amounts (cent precision) with opposite signs, and
 * posted within TRANSFER_MATCH_WINDOW_SECONDS of each other. Matching is
 * greedy (nearest posted date first) and deterministic: candidates are
 * processed in (posted, txId) order, so ties resolve to the earlier-posted,
 * then lexicographically-first counterpart.
 *
 * Rule-typed transactions never participate — an explicit user rule always
 * wins over auto-detection.
 */

export const TRANSFER_MATCH_WINDOW_SECONDS = 3 * 24 * 60 * 60;

export interface TransferCandidate {
  /** SimpleFin transaction id (or activity id in the reconciliation sweep) */
  txId: string;
  /** Account the transaction belongs to — pairs must span two accounts */
  accountId: string;
  /** Unix seconds */
  posted: number;
  /** Signed amount */
  amount: number;
  /** True when a user mapping rule set the type — excluded from pairing */
  ruleTyped: boolean;
}

export interface TransferPair {
  outTxId: string;
  inTxId: string;
}

export interface TransferDetection {
  typeByTxId: Map<string, 'TRANSFER_OUT' | 'TRANSFER_IN'>;
  pairs: TransferPair[];
}

export function detectTransferPairs(candidates: TransferCandidate[]): TransferDetection {
  const eligible = candidates
    .filter((c) => !c.ruleTyped && Number.isFinite(c.amount) && c.amount !== 0)
    .sort((a, b) => a.posted - b.posted || a.txId.localeCompare(b.txId));

  const negatives = eligible.filter((c) => c.amount < 0);
  const positives = eligible.filter((c) => c.amount > 0);

  const usedPositives = new Set<string>();
  const pairs: TransferPair[] = [];
  const typeByTxId = new Map<string, 'TRANSFER_OUT' | 'TRANSFER_IN'>();

  for (const neg of negatives) {
    const negCents = Math.round(Math.abs(neg.amount) * 100);
    let best: TransferCandidate | null = null;
    let bestGap = Infinity;
    // positives are pre-sorted by (posted, txId): the first candidate at a
    // given gap wins, which makes tie-breaking deterministic
    for (const pos of positives) {
      if (usedPositives.has(pos.txId)) continue;
      if (pos.accountId === neg.accountId) continue;
      if (Math.round(pos.amount * 100) !== negCents) continue;
      const gap = Math.abs(pos.posted - neg.posted);
      if (gap > TRANSFER_MATCH_WINDOW_SECONDS) continue;
      if (gap < bestGap) {
        best = pos;
        bestGap = gap;
      }
    }
    if (best) {
      usedPositives.add(best.txId);
      pairs.push({ outTxId: neg.txId, inTxId: best.txId });
      typeByTxId.set(neg.txId, 'TRANSFER_OUT');
      typeByTxId.set(best.txId, 'TRANSFER_IN');
    }
  }

  return { typeByTxId, pairs };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd "/Users/nawrig04/Personal Projects/wealthfolio-simplefin-addon" && npx vitest run shared/transfers.test.ts`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
cd "/Users/nawrig04/Personal Projects/wealthfolio-simplefin-addon"
git add shared/transfers.ts shared/transfers.test.ts
git commit -m "feat: transfer pair detection module

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Account-type-aware defaults in the mapper

**Files:**
- Modify: `shared/mapper.ts`
- Test: `shared/mapper.test.ts` (append cases)

**Interfaces:**
- Consumes: `ActivityType`, `MappingRule` from `shared/types.ts`.
- Produces (used by Tasks 3 and 5):
  - `const CARD_PAYMENT_KEYWORDS: RegExp`
  - `interface MappedType { type: ActivityType; fromRule: boolean }`
  - `function mapTransactionWithSource(description: string, amount: number, rules: MappingRule[], accountType?: string): MappedType`
  - Existing `mapTransaction(description, amount, rules): ActivityType` keeps its exact behavior (delegates with no accountType; RuleEditor's preview depends on it).

- [ ] **Step 1: Write the failing tests** — append to `shared/mapper.test.ts`:

```typescript
import { mapTransactionWithSource, CARD_PAYMENT_KEYWORDS } from './mapper';

describe('mapTransactionWithSource', () => {
  it('reports fromRule=true when a rule matched', () => {
    const rules = [{ pattern: 'dividend', matchType: 'contains' as const, activityType: 'DIVIDEND' as const }];
    expect(mapTransactionWithSource('AAPL DIVIDEND', 5, rules)).toEqual({ type: 'DIVIDEND', fromRule: true });
  });

  it('defaults cash accounts by sign, fromRule=false', () => {
    expect(mapTransactionWithSource('Coffee', -4.5, [], 'CASH')).toEqual({ type: 'WITHDRAWAL', fromRule: false });
    expect(mapTransactionWithSource('Payroll', 100, [], 'CASH')).toEqual({ type: 'DEPOSIT', fromRule: false });
  });

  it('types positive credit-card amounts as CREDIT (refund) by default', () => {
    expect(mapTransactionWithSource('UNIQLO REFUND', 66.45, [], 'CREDIT_CARD'))
      .toEqual({ type: 'CREDIT', fromRule: false });
  });

  it('types payment-keyword credits on cards as TRANSFER_IN', () => {
    for (const desc of ['PAYMENT THANK YOU', 'AUTOPAY RECEIVED', 'ONLINE E-PAY', 'Payment to Citibank']) {
      expect(mapTransactionWithSource(desc, 1982.19, [], 'CREDIT_CARD').type).toBe('TRANSFER_IN');
    }
  });

  it('does NOT apply payment keywords on cash accounts (rent payment is an expense)', () => {
    expect(mapTransactionWithSource('RENT PAYMENT', -1200, [], 'CASH').type).toBe('WITHDRAWAL');
    expect(mapTransactionWithSource('REFUND PAYMENT', 25, [], 'CASH').type).toBe('DEPOSIT');
  });

  it('negative credit-card amounts stay WITHDRAWAL', () => {
    expect(mapTransactionWithSource('SP THERMALTAKE', -69.85, [], 'CREDIT_CARD').type).toBe('WITHDRAWAL');
  });

  it('rules beat card defaults', () => {
    const rules = [{ pattern: 'cashback', matchType: 'contains' as const, activityType: 'CREDIT' as const }];
    expect(mapTransactionWithSource('CASHBACK BONUS', 12, rules, 'CREDIT_CARD'))
      .toEqual({ type: 'CREDIT', fromRule: true });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run shared/mapper.test.ts`
Expected: FAIL — `mapTransactionWithSource` is not exported.

- [ ] **Step 3: Implement** — replace `shared/mapper.ts` content:

```typescript
import type { ActivityType, MappingRule } from './types';

/**
 * Payment-shaped descriptions on credit cards (incoming card payments).
 * Applied ONLY to positive amounts on CREDIT_CARD accounts — on cash accounts
 * "payment" is too generic (rent payment, utility payment are real expenses).
 */
export const CARD_PAYMENT_KEYWORDS = /payment|autopay|thank you|e-?pay/i;

export interface MappedType {
  type: ActivityType;
  /** True when a user mapping rule decided the type (never auto-overridden) */
  fromRule: boolean;
}

function matchRule(description: string, rules: MappingRule[]): ActivityType | null {
  for (const rule of rules) {
    if (rule.matchType === 'contains') {
      if (description.toLowerCase().includes(rule.pattern.toLowerCase())) {
        return rule.activityType;
      }
    } else {
      // Skip rules with invalid regex rather than crashing a whole sync run.
      // RuleEditor surfaces the error at save/preview time so the user can fix it.
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, 'i');
      } catch {
        continue;
      }
      if (re.test(description)) {
        return rule.activityType;
      }
    }
  }
  return null;
}

export function mapTransactionWithSource(
  description: string,
  amount: number,
  rules: MappingRule[],
  accountType?: string,
): MappedType {
  const ruled = matchRule(description, rules);
  if (ruled) return { type: ruled, fromRule: true };

  if (accountType === 'CREDIT_CARD') {
    if (amount < 0) return { type: 'WITHDRAWAL', fromRule: false };
    // Positive on a card: a payment (transfer) or a merchant refund (CREDIT,
    // which Wealthfolio nets against spending as an expense refund)
    return {
      type: CARD_PAYMENT_KEYWORDS.test(description) ? 'TRANSFER_IN' : 'CREDIT',
      fromRule: false,
    };
  }

  return { type: amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL', fromRule: false };
}

export function mapTransaction(
  description: string,
  amount: number,
  rules: MappingRule[],
): ActivityType {
  return mapTransactionWithSource(description, amount, rules).type;
}
```

- [ ] **Step 4: Run the full root suite (mapper is shared — nothing else may regress)**

Run: `npx vitest run`
Expected: all pass (existing mapper/sync/page tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add shared/mapper.ts shared/mapper.test.ts
git commit -m "feat: account-type-aware activity typing (card refunds -> CREDIT, card payments -> TRANSFER_IN)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Addon sync — two-phase typing with transfer detection

**Files:**
- Modify: `src/utils/sync.ts`
- Test: `src/utils/sync.test.ts`

**Interfaces:**
- Consumes: `detectTransferPairs`, `TransferCandidate` (Task 1); `mapTransactionWithSource` (Task 2).
- Produces: `runSync(ctx, store)` signature unchanged. Behavior: transfer pairs import as TRANSFER_OUT/TRANSFER_IN (unlinked — the SDK has no link API; the companion's sweep links them later).

- [ ] **Step 1: Write the failing tests** — in `src/utils/sync.test.ts`, first extend `makeCtx` so `accounts.getAll` returns `accountType`:

```typescript
    accounts: {
      getAll: vi.fn(async () => [
        { id: 'wf-account-a', name: 'Checking', balance: 0, accountType: 'CASH' },
        { id: 'wf-account-b', name: 'Card', balance: 0, accountType: 'CREDIT_CARD' },
      ]),
    },
```

Then append tests (note `makeStore` maps only `sfin-1`; add a two-account store where needed):

```typescript
  it('types matched cross-account pairs as transfers', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce({
      errors: [],
      accounts: [
        { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '1000.00', 'balance-date': 1700000000,
          transactions: [{ id: 'tx-out', posted: 1700000000, amount: '-500.00', description: 'Payment to Citibank' }] },
        { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '-500.00', 'balance-date': 1700000000,
          transactions: [{ id: 'tx-in', posted: 1700086400, amount: '500.00', description: 'PAYMENT THANK YOU' }] },
      ],
    });
    const ctx = makeCtx();
    const store = makeStore({
      getAccountMapping: vi.fn(async () => ({ 'sfin-1': 'wf-account-a', 'sfin-2': 'wf-account-b' })),
      getBalanceInitialized: vi.fn(async () => ['sfin-1', 'sfin-2']),
    });
    await runSync(ctx, store as any);
    const imported = vi.mocked(ctx.api.activities.import).mock.calls.flatMap((c: any) => c[0]);
    const out = imported.find((a: any) => a.comment.includes('tx-out'));
    const inn = imported.find((a: any) => a.comment.includes('tx-in'));
    expect(out.activityType).toBe('TRANSFER_OUT');
    expect(inn.activityType).toBe('TRANSFER_IN');
  });

  it('types unmatched positive card amounts as CREDIT (refund)', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce({
      errors: [],
      accounts: [
        { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '0', 'balance-date': 1700000000,
          transactions: [{ id: 'tx-r', posted: 1700000000, amount: '66.45', description: 'UNIQLO REFUND' }] },
      ],
    });
    const ctx = makeCtx();
    const store = makeStore({
      getAccountMapping: vi.fn(async () => ({ 'sfin-2': 'wf-account-b' })),
      getBalanceInitialized: vi.fn(async () => ['sfin-2']),
    });
    await runSync(ctx, store as any);
    const imported = vi.mocked(ctx.api.activities.import).mock.calls[0][0];
    expect(imported[0].activityType).toBe('CREDIT');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/utils/sync.test.ts`
Expected: the two new tests FAIL (types come out WITHDRAWAL/DEPOSIT).

- [ ] **Step 3: Implement in `src/utils/sync.ts`.** Imports:

```typescript
import { mapTransactionWithSource } from '../../shared/mapper';
import { detectTransferPairs } from '../../shared/transfers';
import type { TransferCandidate } from '../../shared/transfers';
import type { SimplefinAccount, SimplefinTransaction, ActivityType } from '../../shared/types';
```

Replace the accounts fetch + per-account loop with a two-phase structure. Phase A (before the loop), replacing the current `wfBalances` block:

```typescript
  const wfAccounts = await ctx.api.accounts.getAll().catch(() => []);
  const wfBalances = new Map<string, number>(
    wfAccounts.map((a): [string, number] => [a.id, a.balance ?? 0]),
  );
  const wfTypes = new Map<string, string>(
    wfAccounts.map((a): [string, string] => [a.id, String(a.accountType ?? '')]),
  );

  // Phase A: resolve activity types for every transaction across all mapped
  // accounts, so transfer pairs can be detected across account boundaries
  interface PreparedTx {
    sfAccountId: string;
    tx: SimplefinTransaction;
    type: ActivityType;
  }
  const preparedByAccount = new Map<string, PreparedTx[]>();
  const candidates: TransferCandidate[] = [];

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
    if (!wfAccountId) continue;
    const transactions = (sfAccount.transactions ?? []).filter(
      (tx) => !tx.pending && tx.posted > 0,
    );
    const prepared: PreparedTx[] = [];
    for (const tx of transactions) {
      const amount = parseFloat(tx.amount);
      const { type, fromRule } = mapTransactionWithSource(
        tx.description, amount, rules, wfTypes.get(wfAccountId),
      );
      prepared.push({ sfAccountId: sfAccount.id, tx, type });
      candidates.push({
        txId: tx.id, accountId: sfAccount.id, posted: tx.posted, amount, ruleTyped: fromRule,
      });
    }
    preparedByAccount.set(sfAccount.id, prepared);
  }

  const detection = detectTransferPairs(candidates);
  for (const prepared of preparedByAccount.values()) {
    for (const p of prepared) {
      const override = detection.typeByTxId.get(p.tx.id);
      if (override) p.type = override;
    }
  }
```

Phase B: inside the existing per-account loop, replace the `transactions` filter + `activities` map with reads from `preparedByAccount` (starting-balance math and import flow unchanged):

```typescript
  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
    if (!wfAccountId) continue;

    const prepared = preparedByAccount.get(sfAccount.id) ?? [];
    const transactions = prepared.map((p) => p.tx);

    const activities = prepared.map(({ tx, type }) => ({
      accountId: wfAccountId,
      activityType: type,
      date: new Date(tx.posted * 1000).toISOString().split('T')[0],
      symbol: `$CASH-${sfAccount.currency}`,
      amount: Math.abs(parseFloat(tx.amount)),
      currency: sfAccount.currency,
      sourceSystem: 'simplefin' as const,
      comment: `${tx.description} · ${tx.id}`,
      isValid: true,
      isDraft: false,
    }));
    // ... rest of the loop (checkImport, starting balance, import,
    //     addBalanceInitialized) unchanged ...
```

(`mapTransaction` import can be dropped from sync.ts once unused.)

- [ ] **Step 4: Run the full root suite**

Run: `npx vitest run`
Expected: all pass, including the two new tests and all pre-existing sync tests (starting-balance math untouched).

- [ ] **Step 5: Commit**

```bash
git add src/utils/sync.ts src/utils/sync.test.ts
git commit -m "feat: addon sync detects transfer pairs and card refunds

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Companion Wealthfolio client — link + search + account types

**Files:**
- Modify: `companion/src/wealthfolio.ts`
- Test: `companion/src/wealthfolio.test.ts`

**Interfaces:**
- Consumes: existing `authHeaders()` / `baseUrl` plumbing.
- Produces (used by Tasks 5–6):
  - `getAccounts(): Promise<Array<{ id: string; accountType?: string }>>` (widened return type; same endpoint)
  - `linkTransferActivities(activityAId: string, activityBId: string): Promise<void>` — `POST /api/v1/activities/link`, body `{ activityAId, activityBId }` (verified against server: `LinkTransferActivitiesBody`, camelCase)
  - `interface ActivitySearchItem { id: string; accountId: string; activityType: string; date: string; amount?: string | number | null; sourceGroupId?: string | null }`
  - `searchActivities(body: { page: number; pageSize: number; accountIdFilter?: string[]; activityTypeFilter?: string[]; dateFrom?: string; dateTo?: string }): Promise<ActivitySearchItem[]>` — `POST /api/v1/activities/search` (verified: `ActivitySearchBody`, camelCase; response `{ data, meta }`), returns `data`.

- [ ] **Step 1: Write the failing tests** — append to `companion/src/wealthfolio.test.ts`:

```typescript
  it('linkTransferActivities POSTs both ids to /activities/link', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [{}, {}] });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    await client.linkTransferActivities('act-out', 'act-in');
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/activities/link');
    expect(JSON.parse((opts as any).body)).toEqual({ activityAId: 'act-out', activityBId: 'act-in' });
  });

  it('linkTransferActivities throws on non-ok status', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422 });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    await expect(client.linkTransferActivities('a', 'b')).rejects.toThrow('422');
  });

  it('searchActivities POSTs filters and returns the data array', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: 'act-1', accountId: 'wf-a', activityType: 'TRANSFER_OUT', date: '2026-07-05', amount: '500', sourceGroupId: null }], meta: {} }),
    });
    const client = new WealthfolioClient('http://wealthfolio:8088');
    const items = await client.searchActivities({
      page: 1, pageSize: 200,
      accountIdFilter: ['wf-a'],
      activityTypeFilter: ['TRANSFER_IN', 'TRANSFER_OUT'],
      dateFrom: '2026-06-28',
    });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('http://wealthfolio:8088/api/v1/activities/search');
    expect(JSON.parse((opts as any).body).activityTypeFilter).toEqual(['TRANSFER_IN', 'TRANSFER_OUT']);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('act-1');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd companion && npx vitest run src/wealthfolio.test.ts`
Expected: FAIL — methods do not exist.

- [ ] **Step 3: Implement** — in `companion/src/wealthfolio.ts`, widen `getAccounts` and add below `getLatestValuations`:

```typescript
  async getAccounts(): Promise<Array<{ id: string; accountType?: string }>> {
    const res = await fetch(`${this.baseUrl}/api/v1/accounts`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`getAccounts failed: ${res.status}`);
    return res.json() as Promise<Array<{ id: string; accountType?: string }>>;
  }

  /** Marks two activities as one internal transfer (shared source_group_id). */
  async linkTransferActivities(activityAId: string, activityBId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v1/activities/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ activityAId, activityBId }),
    });
    if (!res.ok) throw new Error(`linkTransferActivities failed: ${res.status}`);
  }

  async searchActivities(body: {
    page: number;
    pageSize: number;
    accountIdFilter?: string[];
    activityTypeFilter?: string[];
    dateFrom?: string;
    dateTo?: string;
  }): Promise<ActivitySearchItem[]> {
    const res = await fetch(`${this.baseUrl}/api/v1/activities/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`searchActivities failed: ${res.status}`);
    const json = (await res.json()) as { data: ActivitySearchItem[] };
    return json.data;
  }
```

And the exported interface at the top of the file (after imports):

```typescript
export interface ActivitySearchItem {
  id: string;
  accountId: string;
  activityType: string;
  /** ISO date or datetime string */
  date: string;
  amount?: string | number | null;
  sourceGroupId?: string | null;
}
```

- [ ] **Step 4: Run companion suite**

Run: `cd companion && npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add companion/src/wealthfolio.ts companion/src/wealthfolio.test.ts
git commit -m "feat: companion client link/search endpoints and account types

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Companion sync — two-phase typing + drift warning

**Files:**
- Modify: `companion/src/index.ts`
- Test: `companion/src/index.test.ts`

**Interfaces:**
- Consumes: `mapTransactionWithSource` (Task 2), `detectTransferPairs`/`TransferCandidate` (Task 1), `getAccounts` with `accountType` (Task 4).
- Produces: same `runCompanionSync()` behavior plus: transfer typing identical to Task 3, and a drift log line `Balance drift on account <wfId>: ...` for initialized accounts where `|simplefinBalance − nonDupWindowDelta − wfValuation| > 1.00`.

- [ ] **Step 1: Write the failing tests** — append to `companion/src/index.test.ts` (inside `describe('runCompanionSync')`):

```typescript
  it('types matched cross-account pairs as transfers', async () => {
    process.env.ACCOUNT_MAPPING = JSON.stringify({
      'sfin-account-1': 'wf-account-1',
      'sfin-account-2': 'wf-account-2',
    });
    // both accounts pre-initialized so no starting-balance entries interfere
    writeFileSync(TEST_STATE_FILE, JSON.stringify({ balanceInitialized: ['sfin-account-1', 'sfin-account-2'] }));

    const mockCheckImport = vi.fn().mockImplementation((_id: string, acts: unknown[]) =>
      Promise.resolve((acts as object[]).map((a) => ({ ...a, isDuplicate: false }))),
    );
    const wfMock = makeWfClientMock({
      checkImport: mockCheckImport,
      getAccounts: vi.fn().mockResolvedValue([
        { id: 'wf-account-1', accountType: 'CASH' },
        { id: 'wf-account-2', accountType: 'CREDIT_CARD' },
      ]),
    });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return wfMock; } as unknown as new (url: string) => WealthfolioClient);

    vi.mocked(fetchAccountsNode).mockResolvedValue({
      errors: [],
      accounts: [
        { id: 'sfin-account-1', name: 'Checking', currency: 'USD', balance: '1000.00', 'balance-date': 1700000000,
          transactions: [{ id: 'tx-out', posted: 1700000000, amount: '-500.00', description: 'Payment to Citibank' }] },
        { id: 'sfin-account-2', name: 'Card', currency: 'USD', balance: '-500.00', 'balance-date': 1700000000,
          transactions: [{ id: 'tx-in', posted: 1700086400, amount: '500.00', description: 'PAYMENT THANK YOU' }] },
      ],
    });

    await runCompanionSync();

    const submitted = mockCheckImport.mock.calls.flatMap((c) => c[1] as Array<{ comment: string; activityType: string }>);
    expect(submitted.find((a) => a.comment.includes('tx-out'))!.activityType).toBe('TRANSFER_OUT');
    expect(submitted.find((a) => a.comment.includes('tx-in'))!.activityType).toBe('TRANSFER_IN');
  });

  it('logs a drift warning when an initialized account disagrees with SimpleFin by > $1', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const wfMock = makeWfClientMock({
      getLatestValuations: vi.fn().mockResolvedValue([{ accountId: 'wf-account-1', totalValue: '900' }]),
    });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return wfMock; } as unknown as new (url: string) => WealthfolioClient);
    vi.mocked(fetchAccountsNode).mockResolvedValue({
      errors: [],
      accounts: [
        { id: 'sfin-account-1', name: 'Checking', currency: 'USD', balance: '1000.00', 'balance-date': 1700000000, transactions: [] },
      ],
    });
    // account already initialized -> drift check active, no correction entry
    writeFileSync(TEST_STATE_FILE, JSON.stringify({ balanceInitialized: ['sfin-account-1'] }));

    await runCompanionSync();

    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/Balance drift.*wf-account-1.*100/);
    logSpy.mockRestore();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd companion && npx vitest run src/index.test.ts`
Expected: the two new tests FAIL.

- [ ] **Step 3: Implement in `companion/src/index.ts`.** Imports:

```typescript
import { mapTransactionWithSource } from '../../shared/mapper.js';
import { detectTransferPairs } from '../../shared/transfers.js';
import type { TransferCandidate } from '../../shared/transfers.js';
```

After the `wfBalances` block, fetch account types and build Phase A:

```typescript
  let wfTypes = new Map<string, string>();
  try {
    wfTypes = new Map(
      (await wfClient.getAccounts()).map((a): [string, string] => [a.id, String(a.accountType ?? '')]),
    );
  } catch (err) {
    debug(`Could not fetch account types: ${(err as Error).message}`);
  }

  // Phase A: resolve activity types for every transaction across all mapped
  // accounts, so transfer pairs can be detected across account boundaries
  interface PreparedTx {
    tx: SimplefinTransaction;
    type: ActivityType;
  }
  const preparedByAccount = new Map<string, PreparedTx[]>();
  const candidates: TransferCandidate[] = [];

  for (const sfAccount of accountSet.accounts) {
    const wfAccountId = mapping[sfAccount.id];
    if (!wfAccountId) continue;
    // Pending transactions often have no posted timestamp yet (posted: 0),
    // producing a 1970 date the server rejects. They import once posted.
    const transactions = (sfAccount.transactions ?? []).filter(
      (tx) => !tx.pending && tx.posted > 0,
    );
    const prepared: PreparedTx[] = [];
    for (const tx of transactions) {
      const amount = parseFloat(tx.amount);
      const { type, fromRule } = mapTransactionWithSource(
        tx.description, amount, rules, wfTypes.get(wfAccountId),
      );
      prepared.push({ tx, type });
      candidates.push({
        txId: tx.id, accountId: sfAccount.id, posted: tx.posted, amount, ruleTyped: fromRule,
      });
    }
    preparedByAccount.set(sfAccount.id, prepared);
  }

  const detection = detectTransferPairs(candidates);
  for (const prepared of preparedByAccount.values()) {
    for (const p of prepared) {
      const override = detection.typeByTxId.get(p.tx.id);
      if (override) p.type = override;
    }
  }
```

(`SimplefinTransaction` and `ActivityType` come from `'../../shared/types.js'` — extend the existing type import.) In the per-account loop, delete the old `transactions` filter + `mapTransaction` activity building and read from Phase A instead:

```typescript
    const prepared = preparedByAccount.get(sfAccount.id) ?? [];
    const transactions = prepared.map((p) => p.tx);

    const activities: ActivityImport[] = prepared.map(({ tx, type }) => ({
      accountId: wfAccountId,
      activityType: type,
      date: new Date(tx.posted * 1000).toISOString().split('T')[0],
      symbol: `$CASH-${sfAccount.currency}`,
      amount: Math.abs(parseFloat(tx.amount)),
      currency: sfAccount.currency,
      sourceSystem: 'simplefin',
      // Shown as the activity title; also part of the dedup key, so the
      // SimpleFin tx ID keeps it unique per transaction
      comment: `${tx.description} · ${tx.id}`,
      isValid: true,
      isDraft: false,
    }));
```

(The `debug(\`Processing ...\`)` line and everything from `try {` on stays as-is.) Note the local `ActivityImport` interface's `activityType` field is typed `ActivityType`, so no cast is needed. Then add the drift check inside the loop's `try`, right after the starting-balance block:

```typescript
      // Drift warning: for already-initialized accounts, the same arithmetic
      // that sizes a starting balance now acts as a consistency check.
      // No auto-correction — valuations recalculate asynchronously after
      // imports, so a correction here could fight the recalc.
      if (wfBalances !== null && balanceInitialized.includes(sfAccount.id)) {
        const targetBalance = parseFloat(sfAccount.balance);
        const signedByComment = new Map(
          transactions.map((tx) => [`${tx.description} · ${tx.id}`, parseFloat(tx.amount)]),
        );
        const windowDelta = toImport.reduce(
          (sum, a) => sum + (signedByComment.get(a.comment) ?? 0),
          0,
        );
        const currentWfBalance = wfBalances.get(wfAccountId) ?? 0;
        const drift = targetBalance - windowDelta - currentWfBalance;
        if (Number.isFinite(drift) && Math.abs(drift) > 1.0) {
          log(
            `Balance drift on account ${wfAccountId}: Wealthfolio will be off by ${drift.toFixed(2)} ` +
            `${sfAccount.currency} after this sync — review the account's activities`,
          );
        }
      }
```

- [ ] **Step 4: Run companion suite**

Run: `cd companion && npx vitest run`
Expected: all pass (pre-existing tests unaffected: fixture accounts are pre-initialized and valuations default to `[]`, so no drift lines fire).

- [ ] **Step 5: Commit**

```bash
git add companion/src/index.ts companion/src/index.test.ts
git commit -m "feat: companion transfer typing and balance drift warning

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Companion reconciliation sweep (linking)

**Files:**
- Modify: `companion/src/index.ts`
- Test: `companion/src/index.test.ts`

**Interfaces:**
- Consumes: `searchActivities`, `linkTransferActivities`, `ActivitySearchItem` (Task 4); `detectTransferPairs` (Task 1).
- Produces: exported `reconcileTransferLinks(wfClient: WealthfolioClient, wfAccountIds: string[], lookbackDays: number): Promise<number>` (returns pairs linked), called at the end of `runCompanionSync` before the `lastSyncAt` logic. Failures are logged and non-fatal.

- [ ] **Step 1: Write the failing tests** — append to `companion/src/index.test.ts`:

```typescript
  it('reconciliation links unlinked transfer pairs found via search', async () => {
    const mockLink = vi.fn().mockResolvedValue(undefined);
    const wfMock = makeWfClientMock({
      searchActivities: vi.fn().mockResolvedValue([
        { id: 'act-out', accountId: 'wf-account-1', activityType: 'TRANSFER_OUT', date: '2026-07-05', amount: '500', sourceGroupId: null },
        { id: 'act-in', accountId: 'wf-account-2', activityType: 'TRANSFER_IN', date: '2026-07-06', amount: '500', sourceGroupId: null },
        { id: 'act-linked', accountId: 'wf-account-1', activityType: 'TRANSFER_OUT', date: '2026-07-05', amount: '75', sourceGroupId: 'grp-1' },
      ]),
      linkTransferActivities: mockLink,
    });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return wfMock; } as unknown as new (url: string) => WealthfolioClient);
    vi.mocked(fetchAccountsNode).mockResolvedValue({ errors: [], accounts: [] });

    await runCompanionSync();

    expect(mockLink).toHaveBeenCalledTimes(1);
    expect(mockLink).toHaveBeenCalledWith('act-out', 'act-in');
  });

  it('reconciliation failures are non-fatal and do not block lastSyncAt', async () => {
    const wfMock = makeWfClientMock({
      searchActivities: vi.fn().mockRejectedValue(new Error('boom')),
    });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return wfMock; } as unknown as new (url: string) => WealthfolioClient);
    vi.mocked(fetchAccountsNode).mockResolvedValue({ errors: [], accounts: [] });

    await expect(runCompanionSync()).resolves.toBeUndefined();
    expect(getLastSyncAt()).not.toBeNull();
  });
```

Also add to `makeWfClientMock` defaults:

```typescript
    searchActivities: vi.fn().mockResolvedValue([]),
    linkTransferActivities: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 2: Run to verify failure**

Run: `cd companion && npx vitest run src/index.test.ts`
Expected: first new test FAILS (link never called).

- [ ] **Step 3: Implement** — in `companion/src/index.ts`, add the sweep (exported, above `runCompanionSync`):

```typescript
/**
 * Reconciliation sweep: find unlinked TRANSFER_IN / TRANSFER_OUT activities
 * in the mapped accounts and link matching pairs. Covers pairs imported by
 * the in-app addon sync (which cannot call the link API), earlier link
 * failures, and manually retyped rows. Returns the number of pairs linked.
 */
export async function reconcileTransferLinks(
  wfClient: WealthfolioClient,
  wfAccountIds: string[],
  lookbackDays: number,
): Promise<number> {
  if (wfAccountIds.length === 0) return 0;

  const from = new Date(Date.now() - (lookbackDays + 7) * 24 * 60 * 60 * 1000);
  const items = await wfClient.searchActivities({
    page: 1,
    pageSize: 200,
    accountIdFilter: wfAccountIds,
    activityTypeFilter: ['TRANSFER_IN', 'TRANSFER_OUT'],
    dateFrom: from.toISOString().split('T')[0],
  });

  const unlinked = items.filter((a) => !a.sourceGroupId);
  // Activities store absolute amounts; direction lives in the type. Rebuild
  // signed candidates so the shared pair matcher applies unchanged.
  const candidates: TransferCandidate[] = unlinked.map((a) => ({
    txId: a.id,
    accountId: a.accountId,
    posted: Math.floor(new Date(a.date).getTime() / 1000),
    amount: Math.abs(parseFloat(String(a.amount ?? '0'))) *
      (a.activityType === 'TRANSFER_OUT' ? -1 : 1),
    ruleTyped: false,
  }));

  const { pairs } = detectTransferPairs(candidates);
  let linked = 0;
  for (const pair of pairs) {
    try {
      await wfClient.linkTransferActivities(pair.outTxId, pair.inTxId);
      linked += 1;
    } catch (err) {
      log(`Could not link transfer pair ${pair.outTxId} + ${pair.inTxId}: ${(err as Error).message}`);
    }
  }
  return linked;
}
```

Call it in `runCompanionSync`, after the per-account loop and before the `lastSyncAt` block:

```typescript
  try {
    const lookbackDays = parseInt(process.env.LOOKBACK_DAYS ?? '7', 10);
    const linked = await reconcileTransferLinks(wfClient, Object.values(mapping), lookbackDays);
    if (linked > 0) log(`Linked ${linked} transfer pair(s)`);
  } catch (err) {
    log(`Transfer reconciliation skipped: ${(err as Error).message}`);
  }
```

- [ ] **Step 4: Run companion suite, then both suites**

Run: `cd companion && npx vitest run && cd .. && npx vitest run`
Expected: all pass in both.

- [ ] **Step 5: Commit**

```bash
git add companion/src/index.ts companion/src/index.test.ts
git commit -m "feat: companion reconciliation sweep links transfer pairs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Typecheck, builds, spec amendment, ship artifacts

**Files:**
- Modify: `docs/superpowers/specs/2026-07-11-transfer-detection-design.md` (record the sweep-only amendment in §3)
- Modify: `README.md` (add a "Transfers & refunds" subsection under sync behavior)
- Rebuild: `dist/addon.js`, `dist/simplefin-sync-1.0.0.zip`, `companion/dist/`

**Interfaces:** none new.

- [ ] **Step 1: Typecheck both packages**

Run: `npx tsc --noEmit && cd companion && npx tsc --noEmit && cd ..`
Expected: no output (clean).

- [ ] **Step 2: Amend spec §3** — replace the paragraph starting "After `importActivities` succeeds" with:

```markdown
Linking happens exclusively via the reconciliation sweep (§4), which runs
immediately after import in the same cycle — pairs imported this run are
linked seconds later. (Amended from the original import-response-ID design:
id population in the import response is not contractually guaranteed, and
the sweep is required anyway for addon-imported pairs.)
```

- [ ] **Step 3: Add README subsection** (under the sync/usage section, adjust heading level to match):

```markdown
### Transfers, card payments & refunds

- Transfers between two synced accounts (e.g. paying a credit card from
  checking) are detected automatically — equal amounts, opposite signs,
  within 3 days — and imported as a linked Transfer Out / Transfer In pair,
  excluded from spending and income analytics.
- The in-app **Sync Now** can type transfers but not link them; the Docker
  companion links them on its next run (or link manually in the Spending UI).
- Positive amounts on credit-card accounts import as **Credit** (refunds,
  netted against spending) unless they look like a card payment
  ("payment", "autopay", "thank you", "e-pay"), which become Transfer In.
- Your mapping rules always win over automatic detection — add a rule if a
  bank's phrasing needs different treatment.
- The companion logs a warning when a synced account's balance drifts more
  than $1 from what SimpleFin reports.
```

- [ ] **Step 4: Rebuild artifacts**

Run: `cd companion && npm run build && cd .. && npm run build && grep -c '\.import(' dist/addon.js; rm -f dist/simplefin-sync-1.0.0.zip && zip -q dist/simplefin-sync-1.0.0.zip manifest.json dist/addon.js`
Expected: builds succeed; grep prints `0` (sandbox-rewrite guard still effective); zip recreated.

- [ ] **Step 5: Run both full suites one final time**

Run: `npx vitest run && cd companion && npx vitest run && cd ..`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-07-11-transfer-detection-design.md README.md
git commit -m "docs: transfer behavior docs and sweep-only spec amendment

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Post-implementation deployment (user-facing, not part of the tasks)

1. Reinstall `dist/simplefin-sync-1.0.0.zip` in the Wealthfolio web UI.
2. Re-copy companion source to the server and rebuild:
   `rsync -a --exclude node_modules --exclude dist companion shared user@your-server.example:/opt/yams/simplefin-sync/`
   then `docker build --network=host -f /opt/yams/simplefin-sync/companion/Dockerfile -t wealthfolio-simplefin-sync /opt/yams/simplefin-sync && cd /opt/yams && yams restart`.
3. Hand-fix the few pre-existing mistyped payment rows (edit types, or just
   retype them and let the next companion run link them).
