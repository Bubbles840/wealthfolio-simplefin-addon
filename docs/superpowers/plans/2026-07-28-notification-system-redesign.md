# Notification System Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single, mislabeled automated Telegram report with real daily/weekly reports sourced from Wealthfolio's native budget data, fix the budget-selection bug behind it, and stop unlinked in-transit transfers from inflating the Spending Tracker.

**Architecture:** All transfer/reconciliation logic lives in `shared/sync-core.ts` so both the addon and the companion pick it up identically. The companion (`companion/src/index.ts`) gains a second cron and reads/writes a few new addon-secret keys through the existing `WealthfolioClient`/`RestSyncStore` plumbing. No new services or containers.

**Tech Stack:** TypeScript, vitest, node-cron, `node:sqlite`, Wealthfolio addon SDK.

## Global Constraints

- Every new/changed function needs a passing vitest test in the same PR — this repo has no separate CI test gate, so untested code ships silently broken.
- `shared/*.ts` files must stay host-agnostic (no `fetch`, no DOM/browser APIs, no Node-only APIs) — both the addon (browser iframe) and the companion (Node) import them directly.
- Comments on synced activities must keep ending in `· <txId>` (optionally followed by ` · pending`) — `txIdFromComment` in `shared/sync-core.ts` parses that suffix, and every reconciliation match depends on it.
- Run `npm test` at the repo root and `cd companion && npm test` before every commit that touches shared or companion code (they are separate vitest projects with separate `node_modules`).

---

## File Structure

| File | Responsibility |
|---|---|
| `companion/package.json` | Modify: pin `vitest` explicitly |
| `companion/src/sqlite-native.ts` | Modify: budget-row selection fix, spending date upper bound |
| `shared/types.ts` | Modify: `TelegramConfig` new fields, remove `CategoryRule` |
| `shared/telegram.ts` | Modify: new report formatters, remove retired ones |
| `shared/sync-host.ts` | Modify: `SyncStore` gains transfer-link-failure tracking |
| `companion/src/rest-host.ts` | Modify: `RestSyncStore` implements the new `SyncStore` methods |
| `src/utils/secrets.ts` | Modify: `SecretsStore` implements the same methods |
| `shared/reconcile.ts` | Modify: `FeedTx` gains `feeCents`/`inTransit` |
| `shared/fake-host.ts` | Modify: test double implements the new `SyncStore` methods |
| `shared/sync-core.ts` | Modify: in-transit placeholder classification, stuck-pair alerting |
| `companion/src/index.ts` | Modify: second cron, category-filtered reports, sync-health tracking |
| `src/pages/SyncPage.tsx` | Modify: replace the keyword-rule UI with a Report Categories checklist |
| `companion/Dockerfile` | Modify: add `HEALTHCHECK` |

---

### Task 1: Fix the companion's broken test harness

**Files:**
- Modify: `companion/package.json`

**Interfaces:** None — this only changes which `vitest` binary runs.

- [ ] **Step 1: Confirm the current failure**

Run: `cd companion && npm test`
Expected: `src/sqlite-native.test.ts` and `src/index.test.ts` FAIL with `Failed to load url sqlite (resolved id: sqlite)`.

- [ ] **Step 2: Pin vitest to the same major version the root project uses**

Read the root version first:

Run: `node -p "require('./node_modules/vitest/package.json').version"` (repo root — currently `4.1.10`)

Edit `companion/package.json`'s `devDependencies` to add:

```json
    "vitest": "^4.1.10"
```

- [ ] **Step 3: Reinstall and verify**

Run: `cd companion && npm install && npm test`
Expected: all 5 test files load and run (19+ tests passing, 0 failed-to-load suites).

- [ ] **Step 4: Commit**

```bash
git add companion/package.json companion/package-lock.json
git commit -m "fix: pin companion vitest to match root, unbreaking node:sqlite test loading"
```

---

### Task 2: Fix the budget-target selection bug and the spending query's missing upper bound

**Files:**
- Modify: `companion/src/sqlite-native.ts`
- Modify: `companion/src/sqlite-native.test.ts`

**Interfaces:**
- Produces: `getNativeWealthfolioSpending(dbPath: string, yearMonth: string): Record<string, number>` (signature unchanged, behavior fixed)
- Produces: `getNativeWealthfolioBudgets(dbPath: string, yearMonth: string): Record<string, number>` (signature unchanged, behavior fixed)

- [ ] **Step 1: Write the failing tests**

These tests need a real (tiny, temp) SQLite file, since the functions shell out to `node:sqlite`/`sqlite3` against a file path — mocking the query string isn't meaningful here. Add to `companion/src/sqlite-native.test.ts` (after the existing two tests, before the closing `});`):

```typescript
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

function makeTestDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sfin-sqlite-test-'));
  const path = join(dir, 'wealthfolio.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE taxonomy_categories (id TEXT PRIMARY KEY, name TEXT, parent_id TEXT);
    CREATE TABLE activities (id TEXT PRIMARY KEY, amount TEXT, activity_date TEXT, activity_type TEXT);
    CREATE TABLE activity_taxonomy_assignments (activity_id TEXT, category_id TEXT);
    CREATE TABLE budget_targets (category_id TEXT, amount TEXT, period_key TEXT, updated_at TEXT);
  `);
  db.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('getNativeWealthfolioBudgets month-vs-default selection', () => {
  it('prefers the month-specific budget row even when the default row was edited more recently', () => {
    const { path, cleanup } = makeTestDb();
    try {
      const db = new DatabaseSync(path);
      db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-1', 'Groceries', NULL)`);
      // Month-specific row, edited FIRST (older updated_at)...
      db.exec(`INSERT INTO budget_targets (category_id, amount, period_key, updated_at)
               VALUES ('cat-1', '400', '2026-07', '2026-06-01T00:00:00Z')`);
      // ...default row, edited LATER (newer updated_at) — must still lose.
      db.exec(`INSERT INTO budget_targets (category_id, amount, period_key, updated_at)
               VALUES ('cat-1', '999', 'default', '2026-07-15T00:00:00Z')`);
      db.close();

      const result = getNativeWealthfolioBudgets(path, '2026-07');
      expect(result['Groceries']).toBe(400);
    } finally {
      cleanup();
    }
  });

  it('falls back to the default row when no month-specific row exists', () => {
    const { path, cleanup } = makeTestDb();
    try {
      const db = new DatabaseSync(path);
      db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-1', 'Groceries', NULL)`);
      db.exec(`INSERT INTO budget_targets (category_id, amount, period_key, updated_at)
               VALUES ('cat-1', '250', 'default', '2026-01-01T00:00:00Z')`);
      db.close();

      const result = getNativeWealthfolioBudgets(path, '2026-07');
      expect(result['Groceries']).toBe(250);
    } finally {
      cleanup();
    }
  });
});

describe('getNativeWealthfolioSpending month upper bound', () => {
  it('excludes transactions dated in a later month', () => {
    const { path, cleanup } = makeTestDb();
    try {
      const db = new DatabaseSync(path);
      db.exec(`INSERT INTO taxonomy_categories (id, name, parent_id) VALUES ('cat-1', 'Groceries', NULL)`);
      db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type)
               VALUES ('a1', '-50', '2026-07-15', 'WITHDRAWAL')`);
      db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('a1', 'cat-1')`);
      // Next month — must NOT be counted in the July total.
      db.exec(`INSERT INTO activities (id, amount, activity_date, activity_type)
               VALUES ('a2', '-999', '2026-08-01', 'WITHDRAWAL')`);
      db.exec(`INSERT INTO activity_taxonomy_assignments (activity_id, category_id) VALUES ('a2', 'cat-1')`);
      db.close();

      const result = getNativeWealthfolioSpending(path, '2026-07');
      expect(result['Groceries']).toBe(50);
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd companion && npx vitest run src/sqlite-native.test.ts`
Expected: the month-vs-default test FAILs (`Groceries` comes back `999`, not `400`); the upper-bound test FAILs (`Groceries` comes back `1049`, not `50`).

- [ ] **Step 3: Fix `getNativeWealthfolioBudgets`'s ranking**

In `companion/src/sqlite-native.ts`, inside `getNativeWealthfolioBudgets`, change the `ROW_NUMBER()` ordering (currently `ORDER BY updated_at DESC`) to prefer the month-specific row first, `updated_at` only as a tiebreaker:

```typescript
        ROW_NUMBER() OVER (
          PARTITION BY category_id 
          ORDER BY (period_key = '${yearMonth}') DESC, updated_at DESC
        ) as rn
```

- [ ] **Step 4: Add the missing upper bound to `getNativeWealthfolioSpending`**

At the top of `getNativeWealthfolioSpending`, compute the next month's boundary from `yearMonth`:

```typescript
export function getNativeWealthfolioSpending(dbPath: string, yearMonth: string): Record<string, number> {
  if (!dbPath || !existsSync(dbPath)) {
    return {};
  }

  const [y, m] = yearMonth.split('-').map(Number);
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;

  const query = `
    SELECT 
      COALESCE(parent.name, tc.name) as parent_category,
      ROUND(SUM(ABS(CAST(a.amount AS REAL))), 2) as total_spent
    FROM activities a
    JOIN activity_taxonomy_assignments ata ON a.id = ata.activity_id
    JOIN taxonomy_categories tc ON ata.category_id = tc.id
    LEFT JOIN taxonomy_categories parent ON tc.parent_id = parent.id
    WHERE a.activity_date >= '${yearMonth}-01' 
      AND a.activity_date < '${nextMonth}-01'
      AND UPPER(a.activity_type) IN ('WITHDRAWAL', 'FEE', 'TAX')
      AND LOWER(COALESCE(parent.name, tc.name)) NOT IN ('transfers', 'transfer', 'internal transfers', 'savings & transfers')
    GROUP BY COALESCE(parent.name, tc.name);
  `;
```

(The rest of the function, including the `sqlite3` CLI fallback which reuses `query`, is unchanged — the fallback picks up the new WHERE clause automatically since it reuses the same `query` string.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd companion && npx vitest run src/sqlite-native.test.ts`
Expected: all tests PASS, including the two existing "empty record" tests.

- [ ] **Step 6: Commit**

```bash
git add companion/src/sqlite-native.ts companion/src/sqlite-native.test.ts
git commit -m "fix: budget query prefers month-specific row over most-recently-edited, spending query gains month upper bound"
```

---

### Task 3: Update `TelegramConfig`, remove `CategoryRule`

**Files:**
- Modify: `shared/types.ts`

**Interfaces:**
- Produces: `TelegramConfig` with `dailyReportCategories?: string[] | 'all'` and `weeklyReportCategories?: string[] | 'all'`, `categoryRules` removed.
- Removes: `CategoryRule` (no longer exported — Task 4 and Task 11 depend on its removal being complete first, so their own imports of it fail to compile until updated).

This task's own build will fail (other files still import `CategoryRule`) — that's expected here; Tasks 4 and 11 fix those imports. There is no test for a type-only change; verification is `tsc`.

- [ ] **Step 1: Edit `shared/types.ts`**

Remove the `CategoryRule` interface (lines 45-51):

```typescript
export interface CategoryRule {
  categoryId: string;
  categoryName: string;
  mode: 'daily' | 'weekly' | 'monthly';
  monthlyBudget?: number;
  keywords?: string[];
}
```

Replace `TelegramConfig` (lines 53-61):

```typescript
export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
  notifyOnImport?: boolean;
  dailyReportEnabled?: boolean;
  weeklyReportEnabled?: boolean;
  /** Category names to include in the daily digest. 'all' (default) means
   *  every category the companion has published via
   *  `available_report_categories`. */
  dailyReportCategories?: string[] | 'all';
  /** Same as dailyReportCategories, for the weekly total-remaining summary. */
  weeklyReportCategories?: string[] | 'all';
}
```

- [ ] **Step 2: Commit**

This intentionally leaves the repo non-compiling until Task 4 and Task 11 land — commit anyway so each task is a clean, reviewable diff; the working tree just isn't shippable mid-plan.

```bash
git add shared/types.ts
git commit -m "refactor: replace TelegramConfig.categoryRules with per-report category selection"
```

---

### Task 4: New report formatters, remove the retired ones

**Files:**
- Modify: `shared/telegram.ts`
- Modify: `shared/telegram.test.ts`

**Interfaces:**
- Produces: `formatWeeklyRemainingDigest(categories: Array<{ name: string; spent: number; budget: number }>, weeksLeftInMonth: number): string`
- Produces: `formatMonthlyRemainingSummary(totalSpent: number, totalBudget: number): string`
- Removes: `formatDailyReport`, `formatWeeklyReport`, `formatNativeBudgetBreakdown`, `DailyReportData`, `WeeklyReportData`, `CategoryReportItem`, `categorizeActivity`, `DEFAULT_SPENDING_KEYWORDS`.
- Keeps unchanged: `sendTelegramMessage`, `getCategoryEmoji`, `DEFAULT_CATEGORY_EMOJIS`, `money` (still used by the new formatters and by Task 11's companion code).

- [ ] **Step 1: Write the failing tests**

Replace the `formatDailyReport`/`formatWeeklyReport` `describe` blocks in `shared/telegram.test.ts` (lines 45-79) with:

```typescript
describe('formatWeeklyRemainingDigest', () => {
  it('shows remaining budget divided across the weeks left in the month', () => {
    const text = formatWeeklyRemainingDigest(
      [{ name: 'Groceries', spent: 200, budget: 800 }],
      3,
    );
    expect(text).toContain('🛒 *Groceries*: *$200.00 left this week*');
  });

  it('flags a category that is over budget instead of dividing a negative number', () => {
    const text = formatWeeklyRemainingDigest(
      [{ name: 'Dining', spent: 550, budget: 500 }],
      2,
    );
    expect(text).toContain('🍽️ *Dining*: 🚨 *$50.00 over budget!*');
  });

  it('flags spending in a category with no budget set', () => {
    const text = formatWeeklyRemainingDigest(
      [{ name: 'Shopping', spent: 40, budget: 0 }],
      2,
    );
    expect(text).toContain('🛍️ *Shopping*: 🚨 *$40.00 over budget!*');
  });

  it('shows a placeholder message with no categories', () => {
    const text = formatWeeklyRemainingDigest([], 2);
    expect(text).toContain('No budgeted categories to report');
  });
});

describe('formatMonthlyRemainingSummary', () => {
  it('shows total remaining when under budget', () => {
    const text = formatMonthlyRemainingSummary(1200, 2000);
    expect(text).toContain('$800.00 remaining');
    expect(text).toContain('spent $1200.00 of $2000.00, 60%');
  });

  it('flags being over budget for the month', () => {
    const text = formatMonthlyRemainingSummary(2200, 2000);
    expect(text).toContain('🚨');
    expect(text).toContain('$200.00 over budget');
  });
});
```

Update the import at the top of the test file:

```typescript
import { sendTelegramMessage, formatWeeklyRemainingDigest, formatMonthlyRemainingSummary } from './telegram.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/telegram.test.ts`
Expected: FAIL — `formatWeeklyRemainingDigest`/`formatMonthlyRemainingSummary` are not exported yet.

- [ ] **Step 3: Remove the retired code from `shared/telegram.ts`**

Delete: `DailyReportData`, `WeeklyReportData` interfaces (lines 20-31), `formatDailyReport` (lines 176-208), `formatWeeklyReport` (lines 210-231), `formatNativeBudgetBreakdown` (lines 233-274), `categorizeActivity` (lines 142-162), `DEFAULT_SPENDING_KEYWORDS` (lines 108-140), and the `import type { CategoryRule } from './types.js';` line (line 108, immediately above `DEFAULT_SPENDING_KEYWORDS`). Keep `CategoryReportItem` deleted too (lines 13-18) — nothing references it once the two report functions are gone.

- [ ] **Step 4: Add the new formatters**

Add at the end of `shared/telegram.ts` (after `getCategoryEmoji`, replacing the space the deleted functions left):

```typescript
export interface WeeklyDigestCategory {
  name: string;
  spent: number;
  budget: number;
}

/**
 * Formats the daily "how much left to spend this week" digest — one line per
 * category, dividing the month's remaining budget across the weeks left in
 * the month. A category already over budget for the month gets the 🚨 alert
 * line instead of a (nonsensical, negative) per-week number.
 */
export function formatWeeklyRemainingDigest(
  categories: WeeklyDigestCategory[],
  weeksLeftInMonth: number,
): string {
  let msg = `🗓️ *Weekly Spending Update*\n\n`;

  if (categories.length === 0) {
    msg += `No budgeted categories to report. Set up budgets in Wealthfolio to see weekly allowances.`;
    return msg;
  }

  for (const c of categories) {
    const emoji = getCategoryEmoji(c.name);
    const remaining = c.budget - c.spent;
    if (remaining < 0) {
      msg += `• ${emoji} *${c.name}*: 🚨 *${money(remaining)} over budget!*\n`;
    } else {
      const perWeek = weeksLeftInMonth > 0 ? remaining / weeksLeftInMonth : remaining;
      msg += `• ${emoji} *${c.name}*: *${money(perWeek)} left this week*\n`;
    }
  }

  return msg;
}

/**
 * Formats the weekly (Saturday) "one number" summary: total remaining across
 * every included category's budget for the month.
 */
export function formatMonthlyRemainingSummary(totalSpent: number, totalBudget: number): string {
  const remaining = totalBudget - totalSpent;
  const pct = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;
  let msg = `📊 *Weekly Budget Check-In*\n\n`;
  if (remaining < 0) {
    msg += `🚨 *You're ${money(remaining)} over budget this month* (spent ${money(totalSpent)} of ${money(totalBudget)}, ${pct}%).`;
  } else {
    msg += `💰 *${money(remaining)} remaining* this month (spent ${money(totalSpent)} of ${money(totalBudget)}, ${pct}%).`;
  }
  return msg;
}
```

(`money()` is the existing private helper a few lines above — unchanged, already does `Math.abs` internally, so passing a negative `remaining` to it is intentional and correct.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run shared/telegram.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/telegram.ts shared/telegram.test.ts
git commit -m "feat: add weekly-remaining daily digest and monthly summary formatters, remove retired report formatters"
```

---

### Task 5: `SyncStore` gains transfer-link-failure tracking; companion implements it

**Files:**
- Modify: `shared/sync-host.ts`
- Modify: `companion/src/rest-host.ts`
- Modify: `companion/src/rest-host.test.ts`

**Interfaces:**
- Produces (shared/sync-host.ts): `TransferLinkFailureEntry { count: number; firstFailedAt: string; alerted: boolean }`, added to `SyncStore`:
  - `getTransferLinkFailures(): Promise<Record<string, TransferLinkFailureEntry>>`
  - `setTransferLinkFailures(map: Record<string, TransferLinkFailureEntry>): Promise<void>`
- Consumes (companion/src/rest-host.ts): `WealthfolioClient.getAddonSecret`/`setAddonSecret` (existing, from `companion/src/wealthfolio.ts`).

- [ ] **Step 1: Add the interface to `shared/sync-host.ts`**

Add near the top (after the `HostActivity` interface, before `ActivityWrite`):

```typescript
export interface TransferLinkFailureEntry {
  count: number;
  firstFailedAt: string;
  alerted: boolean;
}
```

Add two methods to the `SyncStore` interface (after `setLinkedGroups`):

```typescript
  /** Per-pair (keyed by the OUT leg's txId) record of consecutive linkPair
   *  failures, so a persistently-rejected transfer group — not ordinary
   *  in-transit lag — can trigger a one-time alert. */
  getTransferLinkFailures(): Promise<Record<string, TransferLinkFailureEntry>>;
  setTransferLinkFailures(map: Record<string, TransferLinkFailureEntry>): Promise<void>;
```

This intentionally breaks the build (every `SyncStore` implementer is now incomplete) until Step 2 and Task 6 land — same rationale as Task 3.

- [ ] **Step 2: Write the failing test**

Add to `companion/src/rest-host.test.ts`, inside the `describe('RestSyncStore', ...)` block:

```typescript
  it('reads and writes transfer link failures as JSON', async () => {
    const secrets = new Map<string, string>();
    const client = {
      getAddonSecret: vi.fn(async (_addonId: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_addonId: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;
    const store = new RestSyncStore(client);

    expect(await store.getTransferLinkFailures()).toEqual({});
    await store.setTransferLinkFailures({ 'tx-out-1': { count: 2, firstFailedAt: '2026-07-27T00:00:00Z', alerted: false } });
    expect(await store.getTransferLinkFailures()).toEqual({
      'tx-out-1': { count: 2, firstFailedAt: '2026-07-27T00:00:00Z', alerted: false },
    });
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd companion && npx vitest run src/rest-host.test.ts`
Expected: FAIL — `store.getTransferLinkFailures` is not a function (and the file doesn't even compile yet, per Step 1's intentional break).

- [ ] **Step 4: Implement in `RestSyncStore`**

In `companion/src/rest-host.ts`, add to `RestSyncStore` (after `setLinkedGroups`, reusing the existing private `getJson`/`setJson` helpers):

```typescript
  async getTransferLinkFailures(): Promise<Record<string, TransferLinkFailureEntry>> {
    return (await this.getJson<Record<string, TransferLinkFailureEntry>>('transfer_link_failures')) ?? {};
  }

  async setTransferLinkFailures(map: Record<string, TransferLinkFailureEntry>): Promise<void> {
    await this.setJson('transfer_link_failures', map);
  }
```

Add `TransferLinkFailureEntry` to the existing `import type { ... } from '../../shared/sync-host.js';` block at the top of the file.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd companion && npx vitest run src/rest-host.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/sync-host.ts companion/src/rest-host.ts companion/src/rest-host.test.ts
git commit -m "feat: add transfer-link-failure tracking to SyncStore, implement in companion's RestSyncStore"
```

---

### Task 6: Addon implements the same `SyncStore` methods

**Files:**
- Modify: `src/utils/secrets.ts`
- Create: `src/utils/secrets.test.ts`

**Interfaces:**
- Produces: `SecretsStore.getTransferLinkFailures(): Promise<Record<string, TransferLinkFailureEntry>>`, `SecretsStore.setTransferLinkFailures(...): Promise<void>` — completes the `SyncStore` contract on the addon side (Task 5 completed it on the companion side).

- [ ] **Step 1: Write the failing test**

There's no existing `secrets.test.ts` — create one, mirroring the `linkedGroups` behavior already implemented in the class, against a minimal fake `AddonContext`:

```typescript
import { describe, it, expect } from 'vitest';
import { SecretsStore } from './secrets';

function fakeCtx() {
  const store = new Map<string, string>();
  return {
    ctx: {
      api: {
        secrets: {
          get: async (key: string) => store.get(key) ?? null,
          set: async (key: string, val: string) => { store.set(key, val); },
          delete: async (key: string) => { store.delete(key); },
        },
      },
    } as any,
  };
}

describe('SecretsStore transfer link failures', () => {
  it('returns an empty record when nothing is stored', async () => {
    const { ctx } = fakeCtx();
    const store = new SecretsStore(ctx);
    expect(await store.getTransferLinkFailures()).toEqual({});
  });

  it('round-trips a stored failure map', async () => {
    const { ctx } = fakeCtx();
    const store = new SecretsStore(ctx);
    await store.setTransferLinkFailures({
      'tx-out-1': { count: 3, firstFailedAt: '2026-07-27T00:00:00Z', alerted: true },
    });
    expect(await store.getTransferLinkFailures()).toEqual({
      'tx-out-1': { count: 3, firstFailedAt: '2026-07-27T00:00:00Z', alerted: true },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/utils/secrets.test.ts`
Expected: FAIL — `store.getTransferLinkFailures` is not a function.

- [ ] **Step 3: Implement in `SecretsStore`**

In `src/utils/secrets.ts`, add a key to the `KEYS` object (after `linkedGroups`):

```typescript
  transferLinkFailures: 'transfer_link_failures',
```

Add the import at the top:

```typescript
import type { TransferLinkFailureEntry } from '../../shared/sync-host';
```

Add methods (after `setLinkedGroups`), following the exact `getLinkedGroups`/`setLinkedGroups` pattern immediately above them:

```typescript
  async getTransferLinkFailures(): Promise<Record<string, TransferLinkFailureEntry>> {
    const raw = await this.ctx.api.secrets.get(KEYS.transferLinkFailures);
    return raw ? (JSON.parse(raw) as Record<string, TransferLinkFailureEntry>) : {};
  }
  async setTransferLinkFailures(map: Record<string, TransferLinkFailureEntry>): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.transferLinkFailures, JSON.stringify(map));
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/utils/secrets.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full addon and companion type-checks**

Run: `npx tsc --noEmit && cd companion && npx tsc --noEmit`
Expected: both clean — this is the point where `SyncStore` becomes fully implemented on both sides again (Tasks 3 and 5's intentional breaks are now resolved for this interface).

- [ ] **Step 6: Commit**

```bash
git add src/utils/secrets.ts src/utils/secrets.test.ts
git commit -m "feat: implement transfer-link-failure tracking in the addon's SecretsStore"
```

---

### Task 7: In-transit transfer placeholders in `shared/sync-core.ts`

**Files:**
- Modify: `shared/reconcile.ts`
- Modify: `shared/sync-core.ts`
- Modify: `shared/fake-host.ts`
- Modify: `shared/sync-core.test.ts`

**Interfaces:**
- Produces (shared/reconcile.ts): `FeedTx` gains `feeCents?: number` and `inTransit?: boolean`.
- Produces (shared/sync-core.ts): `IN_TRANSIT_TIMEOUT_SECONDS` exported constant (10 days, in seconds).
- Consumes: `neutralAdjustmentFields` (already defined in `shared/sync-core.ts`), `isTransferType`, `detectTransferPairs`.

**Behavior:** a transaction typed `TRANSFER_OUT`/`TRANSFER_IN` (by keyword match or pair detection) that has **no** detected pair this run imports as a spending-neutral placeholder (reusing `neutralAdjustmentFields`) instead of a bare transfer type. Once the matching leg posts on a later sync and a pair is detected, the existing row (matched by txId) updates in place to the real transfer type. Past `IN_TRANSIT_TIMEOUT_SECONDS` with still no pair, it converts to a plain `DEPOSIT`/`WITHDRAWAL` instead (never going to pair — likely external).

- [ ] **Step 1: Extend `FeedTx`**

In `shared/reconcile.ts`, add two optional fields to the `FeedTx` interface:

```typescript
export interface FeedTx {
  txId: string;
  wfAccountId: string;
  absCents: number;
  type: string;
  date: string;      // YYYY-MM-DD
  pending: boolean;
  /** Cents of `absCents` to book as `fee` instead of `amount` — used only by
   *  the in-transit transfer placeholder (see sync-core.ts), which needs the
   *  same amount/fee split neutralAdjustmentFields uses for balance plugs. */
  feeCents?: number;
  /** True when this row is a spending-neutral placeholder for a transfer leg
   *  whose other side hasn't posted yet. Only affects the comment prefix —
   *  `type` (CREDIT/DEPOSIT/WITHDRAWAL vs TRANSFER_OUT/IN) is what
   *  `changed()` uses to detect the transition to a real linked transfer. */
  inTransit?: boolean;
}
```

No change needed to `changed()` — it already compares `row.type !== tx.type`, which is what flips when a placeholder promotes to a real transfer.

- [ ] **Step 2: Add the new `SyncStore` methods to the fake host**

In `shared/fake-host.ts`, add local state (near `let linkedGroups`):

```typescript
  let transferLinkFailures: Record<string, { count: number; firstFailedAt: string; alerted: boolean }> = {};
```

Add methods to the `store` object (after `setLinkedGroups`):

```typescript
    async getTransferLinkFailures() {
      return transferLinkFailures;
    },
    async setTransferLinkFailures(map: Record<string, { count: number; firstFailedAt: string; alerted: boolean }>) {
      transferLinkFailures = map;
    },
```

(This is needed now because `SyncStore` is the interface `runSyncCore` depends on — without it, `createFakeHost` won't type-check against the Task 5/6 interface change, and every existing `sync-core.test.ts` test breaks.)

- [ ] **Step 3: Write the failing tests**

Add to `shared/sync-core.test.ts`:

```typescript
  it('imports a solo transfer-typed leg as a spending-neutral placeholder, not a bare transfer', async () => {
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [{ id: 'tx-out', posted: 1700000000, amount: '-1300.00', description: 'Online Transfer to Savings' }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
    });
    const result = await runSyncCore(host, store, {});
    expect(result.imported).toBe(1);
    const create = saved[0].creates![0];
    // CREDIT (not TRANSFER_OUT), fee-side of the split since the amount left the account.
    expect(create.activityType).toBe('CREDIT');
    expect(create.fee).toBe(1300);
    expect(create.amount).toBeUndefined();
    expect(create.comment).toContain('↔️ In-transit transfer ·');
    expect(create.comment).toContain('· tx-out');
  });

  it('promotes a placeholder to a real linked transfer once the matching leg appears on a later sync', async () => {
    const seed = {
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [{ id: 'tx-out', posted: 1700000000, amount: '-1300.00', description: 'Online Transfer to Savings' }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
    };
    const { host, store } = createFakeHost(seed);
    await runSyncCore(host, store, {}); // first run: placeholder only, other leg not posted yet

    // Second run: both legs now present in the SimpleFin feed.
    const { host: host2, store: store2, activities, links } = createFakeHost({
      ...seed,
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': 1,
          transactions: [{ id: 'tx-out', posted: 1700000000, amount: '-1300.00', description: 'Online Transfer to Savings' }] },
        { id: 'sfin-2', name: 'Savings', currency: 'USD', balance: '0', 'balance-date': 1,
          transactions: [{ id: 'tx-in', posted: 1700000000, amount: '1300.00', description: 'Online Transfer from Checking' }] },
      ] },
      mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
      existing: new Map([['wf-a', [{
        id: 'existing-1', accountId: 'wf-a', activityType: 'CREDIT', date: '2023-11-14',
        amount: null, comment: '↔️ In-transit transfer · Online Transfer to Savings · tx-out',
        assetId: undefined, sourceGroupId: null,
      }]]]),
    });
    await runSyncCore(host2, store2, {});

    expect(links).toHaveLength(1);
    const updatedRow = activities.get('wf-a')!.find((a) => a.id === 'existing-1')!;
    expect(updatedRow.activityType).toBe('TRANSFER_OUT');
  });

  it('converts a solo transfer-typed leg to plain WITHDRAWAL once it is older than the in-transit timeout', async () => {
    const staleEpoch = Math.floor(Date.now() / 1000) - (IN_TRANSIT_TIMEOUT_SECONDS + 3600);
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': 1,
        transactions: [{ id: 'tx-out', posted: staleEpoch, amount: '-1300.00', description: 'Online Transfer to Savings' }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
    });
    const result = await runSyncCore(host, store, { force: true });
    expect(result.imported).toBe(1);
    const create = saved[0].creates![0];
    expect(create.activityType).toBe('WITHDRAWAL');
    expect(create.comment).not.toContain('In-transit');
  });
```

Update the test file's import line to include the new constant:

```typescript
import { runSyncCore, VALUATION_POLL, IN_TRANSIT_TIMEOUT_SECONDS } from './sync-core.js';
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run shared/sync-core.test.ts -t "in-transit\|placeholder\|promotes\|timeout"`
Expected: FAIL — `IN_TRANSIT_TIMEOUT_SECONDS` isn't exported, and current behavior imports these as bare `TRANSFER_OUT`/`WITHDRAWAL` without the placeholder step.

- [ ] **Step 5: Implement in `shared/sync-core.ts`**

Add the constant near the other window constants (after `HEAL_WINDOW_MS`/`AUTO_HEAL_WINDOW_MS`):

```typescript
/** How long a transfer-typed transaction may sit without a detected pair
 *  before we give up waiting and let it count as ordinary spending — wider
 *  than TRANSFER_MATCH_WINDOW_SECONDS (5 days) so it never fires while a
 *  normal pairing is still plausible. */
export const IN_TRANSIT_TIMEOUT_SECONDS = 10 * 24 * 60 * 60; // 10 days
```

Add `inTransit?: boolean` to the `PreparedTx` interface (inside `runSyncCore`, where it's currently declared):

```typescript
  interface PreparedTx {
    sfAccountId: string;
    tx: SimplefinTransaction;
    type: ActivityType;
    inTransit?: boolean;
  }
```

Right after the existing override loop:

```typescript
  const detection = detectTransferPairs(candidates);
  for (const prepared of preparedByAccount.values()) {
    for (const p of prepared) {
      const override = detection.typeByTxId.get(p.tx.id);
      if (override) p.type = override;
    }
  }
```

add:

```typescript
  // A transfer-typed transaction with no detected pair yet is either still in
  // transit (the other leg hasn't posted) or was never going to pair (a
  // transfer-shaped description to an untracked external account). Import it
  // as a spending-neutral placeholder while waiting; past the timeout give up
  // and let it count as ordinary spending.
  const pairedTxIds = new Set<string>();
  for (const pair of detection.pairs) {
    pairedTxIds.add(pair.outTxId);
    pairedTxIds.add(pair.inTxId);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  for (const prepared of preparedByAccount.values()) {
    for (const p of prepared) {
      if (!isTransferType(p.type) || pairedTxIds.has(p.tx.id)) continue;
      const postedAt = txEpoch(p.tx) ?? nowSec;
      if (nowSec - postedAt > IN_TRANSIT_TIMEOUT_SECONDS) {
        const amount = signedByTxId.get(p.tx.id) ?? 0;
        p.type = (amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL') as ActivityType;
      } else {
        p.type = 'CREDIT' as ActivityType; // placeholder marker
        p.inTransit = true;
      }
    }
  }
```

Change the `feed` construction (currently `preparedAll.map(({ tx, type }) => ({...}))`) to compute the fee split for placeholders:

```typescript
    const feed: FeedTx[] = preparedAll.map(({ tx, type, inTransit }) => {
      const absCents = Math.round(Math.abs(parseFloat(tx.amount)) * 100);
      let feeCents: number | undefined;
      if (inTransit) {
        const { fee } = neutralAdjustmentFields(wfTypes.get(wfAccountId) ?? '', signedByTxId.get(tx.id) ?? 0);
        feeCents = Math.round(fee * 100);
      }
      return {
        txId: tx.id,
        wfAccountId,
        absCents,
        type,
        date: new Date(txEpoch(tx)! * 1000).toISOString().split('T')[0],
        pending: !!tx.pending,
        ...(feeCents ? { feeCents } : {}),
        ...(inTransit ? { inTransit: true } : {}),
      };
    });
```

Change `toActivityCreate` to respect the fee split and comment prefix:

```typescript
    const toActivityCreate = (t: FeedTx): ActivityWrite => ({
      accountId: t.wfAccountId,
      activityType: t.type,
      activityDate: t.date,
      ...(isTransferType(t.type) ? {} : { symbol: { symbol: cashSymbol } }),
      amount: (t.absCents - (t.feeCents ?? 0)) / 100,
      ...(t.feeCents ? { fee: t.feeCents / 100 } : {}),
      currency: sfAccount.currency,
      comment: `${t.inTransit ? '↔️ In-transit transfer · ' : ''}${descByTxId.get(t.txId) ?? ''} · ${t.txId}${t.pending ? PENDING_SUFFIX : ''}`,
    });
```

`toActivityUpdate` is unchanged — it already spreads `toActivityCreate(t)` and adds `id`, so it picks up the same fee/prefix handling automatically.

One more consequence: when `amount: (t.absCents - (t.feeCents ?? 0)) / 100` evaluates to `0` (the fee-side placeholder, where the full amount moved to `fee`), the `ActivityWrite.amount` field being `0` rather than `undefined` is correct and intentional — it matches the exact shape `importAdjustmentActivity` already sends for balance-adjustment plugs elsewhere in this file (`amount: fieldAmount` where `fieldAmount` can be `0`).

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run shared/sync-core.test.ts shared/reconcile.test.ts shared/fake-host.test.ts`
Expected: PASS — including every pre-existing test in these files (the fake-host and reconcile changes are additive).

- [ ] **Step 7: Run the full shared+addon test suite**

Run: `npm test`
Expected: all pass — this is the point where every prior consumer of `FeedTx`/`createFakeHost` is exercised again.

- [ ] **Step 8: Commit**

```bash
git add shared/reconcile.ts shared/sync-core.ts shared/fake-host.ts shared/sync-core.test.ts
git commit -m "feat: import unpaired transfer legs as spending-neutral in-transit placeholders, promote or expire them on later syncs"
```

---

### Task 8: Stuck-transfer failure tracking and alerting

**Files:**
- Modify: `shared/sync-core.ts`
- Modify: `shared/sync-core.test.ts`

**Interfaces:**
- Produces: `SyncResult.stuckTransferAlerts: Array<{ description: string; amountCents: number; currency: string }>` (now a required field, always an array — no existing test asserts the full `SyncResult` shape via `toEqual`, confirmed by grep before writing this plan).
- Produces: `STUCK_TRANSFER_ALERT_THRESHOLD` exported constant (3).
- Consumes: `store.getTransferLinkFailures`/`setTransferLinkFailures` (Task 5/6).

**Behavior:** distinct from Task 7's ordinary in-transit case — this fires only when **both** legs of a pair are detected (`detection.pairs` contains them) but `host.linkPair()` keeps returning `linked: false`. After 3 consecutive failing sync runs on the same pair, `runSyncCore` reports it once via `stuckTransferAlerts`; the caller (Task 10) is responsible for actually sending the Telegram message.

- [ ] **Step 1: Write the failing tests**

Add to `shared/sync-core.test.ts`, reusing the `transferPairSeed()` helper already defined in that file:

```typescript
  it('reports a stuck-transfer alert after 3 consecutive failed link attempts on the same pair', async () => {
    let attempt = 0;
    const seed = transferPairSeed();

    for (let i = 0; i < 3; i++) {
      const { host, store } = createFakeHost(seed);
      host.linkPair = async () => ({ linked: false });
      const result = await runSyncCore(host, store, { force: true });
      attempt++;
      if (attempt < 3) {
        expect(result.stuckTransferAlerts).toEqual([]);
      } else {
        expect(result.stuckTransferAlerts).toHaveLength(1);
        expect(result.stuckTransferAlerts[0].amountCents).toBe(50000);
        expect(result.stuckTransferAlerts[0].currency).toBe('USD');
      }
      // Persist the failure ledger to the next iteration's fresh host, the
      // way the real companion persists addon secrets across cron runs.
      seed.transferLinkFailures = await store.getTransferLinkFailures();
    }
  });

  it('does not re-alert on the same pair after it has already alerted once', async () => {
    const seed = transferPairSeed();
    seed.transferLinkFailures = {
      'tx-out': { count: 5, firstFailedAt: '2026-07-01T00:00:00Z', alerted: true },
    };
    const { host, store } = createFakeHost(seed);
    host.linkPair = async () => ({ linked: false });
    const result = await runSyncCore(host, store, { force: true });
    expect(result.stuckTransferAlerts).toEqual([]);
  });

  it('clears a failure entry once the pair successfully links', async () => {
    const seed = transferPairSeed();
    seed.transferLinkFailures = {
      'tx-out': { count: 2, firstFailedAt: '2026-07-01T00:00:00Z', alerted: false },
    };
    const { host, store } = createFakeHost(seed);
    await runSyncCore(host, store, { force: true }); // fake host's default linkPair succeeds
    expect(await store.getTransferLinkFailures()).toEqual({});
  });
```

This requires `FakeHostSeed` (in `shared/fake-host.ts`) to accept a seeded `transferLinkFailures` map, and `createFakeHost`'s `store.getTransferLinkFailures`/`setTransferLinkFailures` (added in Task 7 Step 2) to read/write actual mutable state instead of always returning `{}`. Update `shared/fake-host.ts`:

```typescript
export interface FakeHostSeed {
  // ...existing fields...
  transferLinkFailures?: Record<string, { count: number; firstFailedAt: string; alerted: boolean }>;
}
```

```typescript
  let transferLinkFailures: Record<string, { count: number; firstFailedAt: string; alerted: boolean }> =
    seed.transferLinkFailures ?? {};
```

(replacing the `let transferLinkFailures = {}` added in Task 7 Step 2 — the getter/setter methods on `store` are unchanged, they already read/write this variable).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/sync-core.test.ts -t "stuck-transfer\|re-alert\|clears a failure"`
Expected: FAIL — `result.stuckTransferAlerts` is `undefined` (property doesn't exist yet).

- [ ] **Step 3: Implement in `shared/sync-core.ts`**

Add the constant near `IN_TRANSIT_TIMEOUT_SECONDS`:

```typescript
/** Consecutive failed linkPair attempts on the same pair before we alert —
 *  roughly 3 sync cycles (≈18h at the default 6h SYNC_SCHEDULE). */
export const STUCK_TRANSFER_ALERT_THRESHOLD = 3;
```

Extend `SyncResult`:

```typescript
export interface SyncResult {
  imported: number;
  skipped: number;
  errors: string[];
  stuckTransferAlerts: Array<{ description: string; amountCents: number; currency: string }>;
}
```

Add `stuckTransferAlerts: []` to the three early-return statements (interval skip, no access URL, no mapping) — e.g.:

```typescript
    return { imported: 0, skipped: 0, errors: [INTERVAL_SKIP_MESSAGE], stuckTransferAlerts: [] };
```

(same addition to the `'Not configured: no access URL'` and `'Not configured: no account mapping'` returns).

In the transfer-linking section, replace:

```typescript
  let unlinkedLegs = 0;
  for (const legs of pairsToLink) {
    let result: { linked: boolean; groupId?: string };
    try {
      result = await host.linkPair(legs);
    } catch (e: any) {
      errors.push(`Transfer-link failed (${legs[0].txId}/${legs[1].txId}): ${e?.message ?? e}`);
      continue;
    }
    if (!result.linked || !result.groupId) unlinkedLegs += legs.length;
    if (readsGroups) continue;
```

with:

```typescript
  const linkFailures = await store.getTransferLinkFailures();
  let linkFailuresChanged = false;
  const stuckTransferAlerts: SyncResult['stuckTransferAlerts'] = [];

  let unlinkedLegs = 0;
  for (const legs of pairsToLink) {
    let result: { linked: boolean; groupId?: string };
    try {
      result = await host.linkPair(legs);
    } catch (e: any) {
      errors.push(`Transfer-link failed (${legs[0].txId}/${legs[1].txId}): ${e?.message ?? e}`);
      continue;
    }
    if (!result.linked || !result.groupId) unlinkedLegs += legs.length;

    // Track repeated failures on a genuinely-detected pair (both legs
    // present) so a persistently-rejected group — not ordinary in-transit
    // lag, which never reaches this loop — surfaces as a one-time alert.
    const failureKey = legs[0].txId;
    if (result.linked && result.groupId) {
      if (failureKey in linkFailures) {
        delete linkFailures[failureKey];
        linkFailuresChanged = true;
      }
    } else {
      const prior = linkFailures[failureKey];
      const count = (prior?.count ?? 0) + 1;
      const firstFailedAt = prior?.firstFailedAt ?? new Date().toISOString();
      const alerted = prior?.alerted ?? false;
      linkFailures[failureKey] = { count, firstFailedAt, alerted };
      linkFailuresChanged = true;
      if (count >= STUCK_TRANSFER_ALERT_THRESHOLD && !alerted) {
        linkFailures[failureKey].alerted = true;
        stuckTransferAlerts.push({
          description: `${legs[0].comment} ↔ ${legs[1].comment}`,
          amountCents: legs[0].absCents,
          currency: legs[0].currency,
        });
      }
    }

    if (readsGroups) continue;
```

And after the `for (const legs of pairsToLink)` loop closes (right after its closing brace, before the existing `if (opts.heal && unlinkedLegs > 0) { ... }` block):

```typescript
  if (linkFailuresChanged) await store.setTransferLinkFailures(linkFailures);
```

Finally, update the function's return statement:

```typescript
  return { imported, skipped, errors, stuckTransferAlerts };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run shared/sync-core.test.ts`
Expected: PASS — all tests, including Task 7's and every pre-existing one.

- [ ] **Step 5: Run the full shared+addon test suite and type-check**

Run: `npm test && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add shared/sync-core.ts shared/sync-core.test.ts shared/fake-host.ts
git commit -m "feat: alert once when a detected transfer pair fails to link 3 sync runs in a row"
```

---

### Task 9: Companion — two report schedules, category filtering, published category list

**Files:**
- Modify: `companion/src/index.ts`
- Modify: `companion/src/index.test.ts`

**Interfaces:**
- Produces: `sendWeeklyTelegramReport(wfClient: WealthfolioClient): Promise<void>`
- Modifies: `sendDailyTelegramReport` (same signature, new content/formatter).
- Consumes: `formatWeeklyRemainingDigest`, `formatMonthlyRemainingSummary` (Task 4), `getNativeWealthfolioSpending`, `getNativeWealthfolioBudgets` (Task 2), `TelegramConfig.dailyReportCategories`/`weeklyReportCategories` (Task 3).

- [ ] **Step 1: Write the failing tests**

Add to `companion/src/index.test.ts`:

```typescript
import { sendDailyTelegramReport, sendWeeklyTelegramReport } from './index.js';
import * as sqliteNative from './sqlite-native.js';

vi.mock('./sqlite-native.js', () => ({
  getNativeWealthfolioSpending: vi.fn(() => ({ Groceries: 200, Dining: 550 })),
  getNativeWealthfolioBudgets: vi.fn(() => ({ Groceries: 800, Dining: 500 })),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => true) };
});

describe('sendDailyTelegramReport', () => {
  it('publishes the available category list and filters the digest to the configured selection', async () => {
    const secrets = new Map<string, string>();
    secrets.set('telegram_config', JSON.stringify({
      botToken: 'tok', chatId: '1', enabled: true, dailyReportCategories: ['Groceries'],
    }));
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await sendDailyTelegramReport(client);

    expect(client.setAddonSecret).toHaveBeenCalledWith(
      'simplefin-sync', 'available_report_categories', JSON.stringify(['Dining', 'Groceries']),
    );
    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    expect(text).toContain('Groceries');
    expect(text).not.toContain('Dining');
  });

  it('does nothing when dailyReportEnabled is false', async () => {
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true, dailyReportEnabled: false })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async () => {}),
    } as any;
    await sendDailyTelegramReport(client);
    expect(client.setAddonSecret).not.toHaveBeenCalled();
  });
});

describe('sendWeeklyTelegramReport', () => {
  it('sends the total-remaining summary across all included categories', async () => {
    const secrets = new Map<string, string>([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true })],
    ]);
    const client = {
      getAddonSecret: vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null),
      setAddonSecret: vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); }),
    } as any;
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await sendWeeklyTelegramReport(client);

    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    // totalSpent = 750, totalBudget = 1300, remaining = 550
    expect(text).toContain('$550.00 remaining');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd companion && npx vitest run src/index.test.ts -t "sendDailyTelegramReport\|sendWeeklyTelegramReport"`
Expected: FAIL — `sendWeeklyTelegramReport` isn't exported; `sendDailyTelegramReport` doesn't publish `available_report_categories` or filter by category yet.

- [ ] **Step 3: Implement in `companion/src/index.ts`**

Update the import line:

```typescript
import { sendTelegramMessage, formatWeeklyRemainingDigest, formatMonthlyRemainingSummary } from '../../shared/telegram.js';
```

Add helpers above `sendDailyTelegramReport`:

```typescript
function unionCategoryNames(spentMap: Record<string, number>, budgetMap: Record<string, number>): string[] {
  return Array.from(new Set([...Object.keys(spentMap), ...Object.keys(budgetMap)])).sort();
}

function filterCategories(names: string[], selection: string[] | 'all' | undefined): string[] {
  if (!selection || selection === 'all') return names;
  const allowed = new Set(selection);
  return names.filter((n) => allowed.has(n));
}

function daysLeftInMonth(now: Date): number {
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Math.max(1, lastDay - now.getDate());
}

async function publishAvailableCategories(
  wfClient: WealthfolioClient,
  spentMap: Record<string, number>,
  budgetMap: Record<string, number>,
): Promise<string[]> {
  const names = unionCategoryNames(spentMap, budgetMap);
  await wfClient.setAddonSecret('simplefin-sync', 'available_report_categories', JSON.stringify(names));
  return names;
}
```

Replace the existing `sendDailyTelegramReport`:

```typescript
export async function sendDailyTelegramReport(wfClient: WealthfolioClient): Promise<void> {
  const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config');
  if (!tgRaw) return;

  const tg = JSON.parse(tgRaw);
  if (!tg.botToken || !tg.chatId || tg.enabled === false) return;
  if (tg.dailyReportEnabled === false) return;

  const dbPath = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
  if (!dbPath || !existsSync(dbPath)) {
    log('WEALTHFOLIO_DB_PATH not found or missing, skipping daily digest.');
    return;
  }

  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const spentMap = getNativeWealthfolioSpending(dbPath, yearMonth);
  const budgetMap = getNativeWealthfolioBudgets(dbPath, yearMonth);
  const allNames = await publishAvailableCategories(wfClient, spentMap, budgetMap);

  const names = filterCategories(allNames, tg.dailyReportCategories);
  const categories = names.map((name) => ({
    name, spent: spentMap[name] ?? 0, budget: budgetMap[name] ?? 0,
  }));
  const weeksLeft = Math.max(1, Math.ceil(daysLeftInMonth(now) / 7));
  const message = formatWeeklyRemainingDigest(categories, weeksLeft);
  const result = await sendTelegramMessage(tg.botToken, tg.chatId, message);
  if (result.ok) {
    log('Daily Telegram weekly-remaining digest sent successfully.');
  } else {
    log(`Failed to send daily Telegram report: ${result.description}`);
  }
}

export async function sendWeeklyTelegramReport(wfClient: WealthfolioClient): Promise<void> {
  const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config');
  if (!tgRaw) return;

  const tg = JSON.parse(tgRaw);
  if (!tg.botToken || !tg.chatId || tg.enabled === false) return;
  if (tg.weeklyReportEnabled === false) return;

  const dbPath = process.env.WEALTHFOLIO_DB_PATH || '/mnt/wealthfolio.db';
  if (!dbPath || !existsSync(dbPath)) {
    log('WEALTHFOLIO_DB_PATH not found or missing, skipping weekly summary.');
    return;
  }

  const now = new Date();
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const spentMap = getNativeWealthfolioSpending(dbPath, yearMonth);
  const budgetMap = getNativeWealthfolioBudgets(dbPath, yearMonth);
  const allNames = await publishAvailableCategories(wfClient, spentMap, budgetMap);

  const names = filterCategories(allNames, tg.weeklyReportCategories);
  const totalSpent = names.reduce((sum, n) => sum + (spentMap[n] ?? 0), 0);
  const totalBudget = names.reduce((sum, n) => sum + (budgetMap[n] ?? 0), 0);
  const message = formatMonthlyRemainingSummary(totalSpent, totalBudget);
  const result = await sendTelegramMessage(tg.botToken, tg.chatId, message);
  if (result.ok) {
    log('Weekly Telegram total-remaining summary sent successfully.');
  } else {
    log(`Failed to send weekly Telegram report: ${result.description}`);
  }
}
```

Add the second cron registration in the startup block (after the existing `dailySchedule` cron registration, before "Run initial sync on startup"):

```typescript
  const weeklySchedule = process.env.WEEKLY_REPORT_SCHEDULE ?? '0 9 * * 6'; // Saturday 9am
```

(add this alongside the existing `const dailySchedule = ...` line), and:

```typescript
  cron.schedule(weeklySchedule, () => {
    log('Triggering scheduled weekly budget summary report...');
    const password = resolvePassword();
    const apiKey = process.env.WEALTHFOLIO_API_KEY;
    if (apiKey) {
      (wfClient as unknown as { token: string }).token = apiKey;
    }
    const loginPromise = apiKey ? Promise.resolve() : (password ? wfClient.login(password) : Promise.resolve());
    loginPromise
      .then(() => sendWeeklyTelegramReport(wfClient))
      .catch((err) => log(`Weekly report error: ${formatError(err)}`));
  });
```

Update the startup log line to mention the new schedule:

```typescript
  log(`Starting companion — sync schedule: ${schedule}, daily report schedule: ${dailySchedule}, weekly report schedule: ${weeklySchedule}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd companion && npx vitest run src/index.test.ts`
Expected: PASS — all tests, including pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add companion/src/index.ts companion/src/index.test.ts
git commit -m "feat: add weekly Telegram report schedule, category filtering, and published category list"
```

---

### Task 10: Companion — sync health tracking, stuck-transfer alert delivery

**Files:**
- Modify: `companion/src/index.ts`
- Modify: `companion/src/index.test.ts`

**Interfaces:**
- Modifies: `runCompanionSync(): Promise<SyncResult>` (was `Promise<void>` — now returns the result so `stuckTransferAlerts` can be consumed).
- Consumes: `SyncResult.stuckTransferAlerts` (Task 8).

**Documented limitation:** sync-health tracking writes to Wealthfolio via the same authenticated `wfClient` the sync itself uses. If login to Wealthfolio fails outright, there is no authenticated channel left to record or alert on that failure — it still only surfaces via `docker logs`, same as today. This only covers failures *after* a successful login (SimpleFin errors, `runSyncCore` throwing, etc.).

- [ ] **Step 1: Write the failing tests**

Add to `companion/src/index.test.ts` (the existing `vi.mock('../../shared/sync-core.js', ...)` at the top needs its mock return value to include `stuckTransferAlerts: []` — update it):

```typescript
vi.mock('../../shared/sync-core.js', () => ({
  runSyncCore: vi.fn(async () => ({ imported: 2, skipped: 1, errors: [], stuckTransferAlerts: [] })),
}));
```

Add:

```typescript
describe('runCompanionSync sync health', () => {
  let secrets: Map<string, string>;

  beforeEach(() => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    secrets = new Map();
    vi.mocked(runSyncCore).mockClear();
  });

  it('records lastSuccessAt and clears any failure streak on success', async () => {
    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client = new (WealthfolioClient as any)();
    client.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    client.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    vi.mocked(WealthfolioClient).mockImplementation(() => client);

    await runCompanionSync();

    const health = JSON.parse(secrets.get('sync_health')!);
    expect(health.lastSuccessAt).toBeTruthy();
    expect(health.firstFailedAt).toBeUndefined();
  });

  it('sends one Telegram alert per stuck-transfer entry in the result', async () => {
    vi.mocked(runSyncCore).mockResolvedValueOnce({
      imported: 0, skipped: 0, errors: [],
      stuckTransferAlerts: [{ description: 'Payment ↔ Payment', amountCents: 130000, currency: 'USD' }],
    });
    secrets.set('telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true }));

    const { WealthfolioClient } = await import('./wealthfolio.js');
    const client = new (WealthfolioClient as any)();
    client.getAddonSecret = vi.fn(async (_a: string, key: string) => secrets.get(key) ?? null);
    client.setAddonSecret = vi.fn(async (_a: string, key: string, val: string) => { secrets.set(key, val); });
    vi.mocked(WealthfolioClient).mockImplementation(() => client);

    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);

    await runCompanionSync();

    expect(fetchMock).toHaveBeenCalled();
    const [, sentBody] = fetchMock.mock.calls[0];
    const text = JSON.parse((sentBody as any).body).text;
    expect(text).toContain('$1300.00');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd companion && npx vitest run src/index.test.ts -t "sync health"`
Expected: FAIL — `sync_health` is never written; no Telegram send happens for `stuckTransferAlerts`.

- [ ] **Step 3: Implement in `companion/src/index.ts`**

Add near the top-level helpers:

```typescript
const SYNC_HEALTH_ALERT_MS = 24 * 60 * 60 * 1000;

async function updateSyncHealth(wfClient: WealthfolioClient, error: Error | null): Promise<void> {
  const raw = await wfClient.getAddonSecret('simplefin-sync', 'sync_health').catch(() => null);
  const health = raw ? JSON.parse(raw) : {};
  const now = new Date().toISOString();
  const next = error === null
    ? { lastSuccessAt: now }
    : {
        lastSuccessAt: health.lastSuccessAt ?? null,
        firstFailedAt: health.firstFailedAt ?? now,
        lastError: error.message,
        alerted: health.alerted ?? false,
      };
  await wfClient.setAddonSecret('simplefin-sync', 'sync_health', JSON.stringify(next)).catch(() => {});
}

async function checkSyncHealthAlert(wfClient: WealthfolioClient): Promise<void> {
  const raw = await wfClient.getAddonSecret('simplefin-sync', 'sync_health').catch(() => null);
  if (!raw) return;
  const health = JSON.parse(raw);
  if (!health.firstFailedAt || health.alerted) return;
  if (Date.now() - new Date(health.firstFailedAt).getTime() < SYNC_HEALTH_ALERT_MS) return;

  const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config').catch(() => null);
  if (!tgRaw) return;
  const tg = JSON.parse(tgRaw);
  if (!tg.botToken || !tg.chatId || tg.enabled === false) return;

  await sendTelegramMessage(
    tg.botToken,
    tg.chatId,
    `⚠️ *SimpleFin Sync has been failing since ${new Date(health.firstFailedAt).toLocaleString()}*\nLast error: ${health.lastError}`,
  );
  await wfClient.setAddonSecret('simplefin-sync', 'sync_health', JSON.stringify({ ...health, alerted: true })).catch(() => {});
}

async function sendStuckTransferAlert(
  wfClient: WealthfolioClient,
  alert: { description: string; amountCents: number; currency: string },
): Promise<void> {
  const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config').catch(() => null);
  if (!tgRaw) return;
  const tg = JSON.parse(tgRaw);
  if (!tg.botToken || !tg.chatId || tg.enabled === false) return;
  const amount = (alert.amountCents / 100).toFixed(2);
  await sendTelegramMessage(
    tg.botToken,
    tg.chatId,
    `⚠️ *Transfer stuck — couldn't auto-link after 3 tries*\n${alert.description}\nAmount: $${amount} ${alert.currency}\nTry "Reconcile & link" in the addon, or check for a duplicate/mismatched leg.`,
  );
}
```

Import `SyncResult` type and `sendTelegramMessage` (already imported) — add to the existing `import { runSyncCore } from '../../shared/sync-core.js';` line:

```typescript
import { runSyncCore } from '../../shared/sync-core.js';
import type { SyncResult } from '../../shared/sync-core.js';
```

Change `runCompanionSync`'s signature and wrap its post-login body:

```typescript
export async function runCompanionSync(): Promise<SyncResult> {
  const apiUrl = process.env.WEALTHFOLIO_API_URL ?? '';
  if (!apiUrl) throw new Error('Missing WEALTHFOLIO_API_URL');

  const wfClient = new WealthfolioClient(apiUrl);
  const apiKey = process.env.WEALTHFOLIO_API_KEY;
  log(`Connecting to Wealthfolio at ${apiUrl}...`);
  if (apiKey) {
    (wfClient as unknown as { token: string }).token = apiKey;
    debug('Using WEALTHFOLIO_API_KEY for authentication');
  } else {
    const password = resolvePassword();
    if (password) {
      log('Authenticating with Wealthfolio...');
      let attempts = 0;
      while (true) {
        try {
          await wfClient.login(password);
          log('Authenticated successfully.');
          break;
        } catch (err) {
          attempts++;
          if (attempts >= 5) throw err;
          log(`Wealthfolio starting up — retrying connection in 3s (${attempts}/5)...`);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
  }

  const store = new RestSyncStore(wfClient);
  const host = new RestSyncHost(wfClient);

  try {
    log('Reading SimpleFin credentials from Wealthfolio addon secrets...');
    const accessUrl = await store.getAccessUrl();
    if (!accessUrl) {
      log('No SimpleFin access URL found in Wealthfolio addon secrets. Please configure the SimpleFin Sync addon in Wealthfolio first.');
      const empty: SyncResult = { imported: 0, skipped: 0, errors: [], stuckTransferAlerts: [] };
      await updateSyncHealth(wfClient, null);
      return empty;
    }

    const minIntervalHours = parseFloat(process.env.MIN_SYNC_INTERVAL_HOURS ?? '1');
    const force = minIntervalHours <= 0;

    log(`Fetching SimpleFin transactions from ${maskUrl(accessUrl)}...`);
    const result = await runSyncCore(host, store, { force });

    for (const err of result.errors) {
      log(`Sync note: ${err}`);
    }
    log(`Done: ${result.imported} imported, ${result.skipped} skipped`);

    for (const alert of result.stuckTransferAlerts) {
      await sendStuckTransferAlert(wfClient, alert);
    }

    try {
      const tgRaw = await wfClient.getAddonSecret('simplefin-sync', 'telegram_config');
      if (tgRaw) {
        const tg = JSON.parse(tgRaw);
        if (tg.botToken && tg.chatId && tg.enabled !== false) {
          log(`Telegram notifications active (chat: ${tg.chatId}).`);
          if (result.imported > 0 && tg.notifyOnImport !== false) {
            await sendTelegramMessage(
              tg.botToken,
              tg.chatId,
              `🔔 *SimpleFin Sync Update*\nImported ${result.imported} new transaction(s) into Wealthfolio!`,
            );
          }
        }
      }
    } catch (err) {
      debug(`Telegram check note: ${formatError(err)}`);
    }

    await updateSyncHealth(wfClient, null);
    return result;
  } catch (err) {
    await updateSyncHealth(wfClient, err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    await checkSyncHealthAlert(wfClient).catch(() => {});
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd companion && npx vitest run src/index.test.ts`
Expected: PASS — all tests.

- [ ] **Step 5: Run the full companion test suite and type-check**

Run: `cd companion && npm test && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add companion/src/index.ts companion/src/index.test.ts
git commit -m "feat: track sync health and alert after 24h of failures, deliver stuck-transfer alerts to Telegram"
```

---

### Task 11: Addon UI — replace the keyword-rule editor with a Report Categories checklist

**Files:**
- Modify: `src/pages/SyncPage.tsx`
- Modify: `src/pages/SyncPage.test.tsx`

**Interfaces:**
- Consumes: `SecretsStore.getAvailableReportCategories()` — **new**, added in this task (mirrors the `linked_groups`-style pattern; the companion writes `available_report_categories` via `wfClient.setAddonSecret`, Task 9, so the addon only needs a getter, no setter).

- [ ] **Step 1: Add the getter to `SecretsStore`**

In `src/utils/secrets.ts`, add a key:

```typescript
  availableReportCategories: 'available_report_categories',
```

Add a method (after `getTransferLinkFailures`/`setTransferLinkFailures` from Task 6):

```typescript
  /** Category names the companion has seen while building its last report —
   *  read-only from the addon's side, published by the companion. */
  async getAvailableReportCategories(): Promise<string[]> {
    const raw = await this.ctx.api.secrets.get(KEYS.availableReportCategories);
    return raw ? (JSON.parse(raw) as string[]) : [];
  }
```

- [ ] **Step 2: Write the failing SyncPage test**

Add to `src/pages/SyncPage.test.tsx` (follow the file's existing pattern for mocking `store` — check the top of the file for how other `store.get*` mocks are set up, and add `getAvailableReportCategories` to that same mock object so existing tests don't break on a missing method):

```typescript
it('renders a Report Categories checklist populated from the companion-published list, defaulting to all selected', async () => {
  store.getAvailableReportCategories = vi.fn(async () => ['Dining', 'Groceries']);
  render(<SyncPage ctx={ctx} store={store} onReset={() => {}} scheduler={scheduler} />);
  await screen.findByText('Dining');
  const dailyCheckbox = screen.getByLabelText(/Dining.*Daily/i) as HTMLInputElement;
  expect(dailyCheckbox.checked).toBe(true);
});

it('shows a placeholder before the companion has published any categories', async () => {
  store.getAvailableReportCategories = vi.fn(async () => []);
  render(<SyncPage ctx={ctx} store={store} onReset={() => {}} scheduler={scheduler} />);
  await screen.findByText(/categories will appear here/i);
});

it('saves the selected daily/weekly category lists in Telegram config', async () => {
  store.getAvailableReportCategories = vi.fn(async () => ['Dining', 'Groceries']);
  store.setTelegramConfig = vi.fn(async () => {});
  render(<SyncPage ctx={ctx} store={store} onReset={() => {}} scheduler={scheduler} />);
  await screen.findByText('Dining');
  fireEvent.click(screen.getByLabelText(/Dining.*Daily/i)); // uncheck
  fireEvent.click(screen.getByText('Save Telegram Settings'));
  await waitFor(() => {
    expect(store.setTelegramConfig).toHaveBeenCalledWith(
      expect.objectContaining({ dailyReportCategories: ['Groceries'] }),
    );
  });
});
```

(Adjust the exact `getByLabelText` matcher once Step 4's markup is in place — the label text pattern below is `"Dining — Daily"` / `"Dining — Weekly"` per-checkbox, so a regex like `/Dining.*Daily/i` matches. If this repo's existing SyncPage tests use a different render/query setup — e.g. a custom `renderPage()` helper — follow that instead of raw `render()`.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/pages/SyncPage.test.tsx -t "Report Categories\|categories will appear\|saves the selected"`
Expected: FAIL — no such UI exists yet.

- [ ] **Step 4: Remove the retired UI from `SyncPage.tsx`**

Delete `DEFAULT_CATEGORY_RULES` (lines 13-24) and its now-dangling `CategoryRule` import (update the `import type { AccountMapping, MappingRule, CategoryRule } from '../../shared/types';` on line 11 to drop `CategoryRule`).

Delete the `categoryRules`/`showCategorySettings` state (lines 89-90) and replace with:

```typescript
  const [dailyReportCategories, setDailyReportCategories] = useState<string[] | 'all'>('all');
  const [weeklyReportCategories, setWeeklyReportCategories] = useState<string[] | 'all'>('all');
  const [availableCategories, setAvailableCategories] = useState<string[]>([]);
```

In the `useEffect` data-load `Promise.all` (line 100), add `store.getAvailableReportCategories()` and its destructured result:

```typescript
      store.getTelegramConfig(),
      store.getAvailableReportCategories(),
      ctx.api.accounts.getAll().catch(() => []),
    ]).then(([last, m, r, h, names, bal, ah, aa, tg, availableCats, wfAccounts]) => {
      // ...
      setAvailableCategories(availableCats);
      if (tg) {
        setBotToken(tg.botToken ?? '');
        setChatId(tg.chatId ?? '');
        setNotifyOnImport(tg.notifyOnImport ?? true);
        setDailyReportEnabled(tg.dailyReportEnabled ?? true);
        setWeeklyReportEnabled(tg.weeklyReportEnabled ?? true);
        setDailyReportCategories(tg.dailyReportCategories ?? 'all');
        setWeeklyReportCategories(tg.weeklyReportCategories ?? 'all');
      }
```

(remove the old `if (Array.isArray(tg.categoryRules) ...) setCategoryRules(...)` block entirely.)

Update the import line (line 8) to drop `formatDailyReport`, `formatWeeklyReport`, `categorizeActivity`:

```typescript
import { sendTelegramMessage, getCategoryEmoji } from '../../shared/telegram';
```

Delete the entire "Send Sample Budget Report" button block (lines 681-780, from `<Button variant="outline" disabled={testingTelegram || !botToken || !chatId} onClick={async () => { setTestingTelegram(true); setTelegramStatus('Sending budget breakdown report...');` through its matching `</Button>`) — its only purpose was exercising the retired formatters.

- [ ] **Step 5: Add the Report Categories checklist**

Replace the "Customize Category Modes & Budgets" block (the button at lines 562-566 and the `showCategorySettings && (...)` panel at lines 568-637) with:

```tsx
          <div style={{
            background: 'var(--card-bg, rgba(0,0,0,0.15))',
            padding: 12,
            borderRadius: 6,
            border: '1px solid var(--border, rgba(255,255,255,0.1))',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            marginTop: 4,
          }}>
            <div style={{ fontWeight: 600, fontSize: 11, color: 'var(--muted-foreground)', letterSpacing: '0.05em' }}>
              REPORT CATEGORIES
            </div>
            {availableCategories.length === 0 ? (
              <div className="sfin-subtle" style={{ fontSize: 12 }}>
                Categories will appear here after the companion's first sync.
              </div>
            ) : (
              availableCategories.map((name) => {
                const emoji = getCategoryEmoji(name);
                const inDaily = dailyReportCategories === 'all' || dailyReportCategories.includes(name);
                const inWeekly = weeklyReportCategories === 'all' || weeklyReportCategories.includes(name);
                const toggle = (
                  current: string[] | 'all',
                  setCurrent: (v: string[] | 'all') => void,
                  checked: boolean,
                ) => {
                  const base = current === 'all' ? availableCategories : current;
                  const next = checked ? base.filter((n) => n !== name) : [...base, name];
                  setCurrent(next.length === availableCategories.length ? 'all' : next);
                };
                return (
                  <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 16, width: 24, textAlign: 'center' }}>{emoji}</span>
                    <span style={{ minWidth: 120, fontWeight: 500, fontSize: 13 }}>{name}</span>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        aria-label={`${name} — Daily`}
                        checked={inDaily}
                        onChange={() => toggle(dailyReportCategories, setDailyReportCategories, inDaily)}
                      />
                      Daily
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        aria-label={`${name} — Weekly`}
                        checked={inWeekly}
                        onChange={() => toggle(weeklyReportCategories, setWeeklyReportCategories, inWeekly)}
                      />
                      Weekly
                    </label>
                  </div>
                );
              })
            )}
          </div>
```

- [ ] **Step 6: Update "Save Telegram Settings" to persist the new fields**

Replace the `store.setTelegramConfig({...})` call (the "primary" button, currently listing `categoryRules`):

```typescript
              onClick={async () => {
                await store.setTelegramConfig({
                  botToken,
                  chatId,
                  enabled: true,
                  notifyOnImport,
                  dailyReportEnabled,
                  weeklyReportEnabled,
                  dailyReportCategories,
                  weeklyReportCategories,
                });
                setTelegramStatus('✅ Telegram configuration saved!');
              }}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/pages/SyncPage.test.tsx`
Expected: PASS — all tests, including pre-existing ones (any pre-existing test referencing the removed "Keywords"/"Send Sample Budget Report" UI must be deleted alongside it — search the test file for `Send Sample Budget Report`, `Customize Category`, and `categoryRules` and remove those specific tests, since the behavior no longer exists).

- [ ] **Step 8: Run the full addon test suite and type-check**

Run: `npm test && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/pages/SyncPage.tsx src/pages/SyncPage.test.tsx src/utils/secrets.ts
git commit -m "feat: replace keyword-rule category editor with a Report Categories checklist sourced from the companion"
```

---

### Task 12: Minor polish — version sync, container healthcheck

**Files:**
- Modify: `companion/package.json`
- Modify: `companion/Dockerfile`

**Interfaces:** None.

- [ ] **Step 1: Bump companion's version to match root**

In `companion/package.json`, change `"version": "1.0.0"` to `"version": "1.0.1"`.

- [ ] **Step 2: Add a Dockerfile healthcheck**

In `companion/Dockerfile`, after the `USER node` line and before the final `CMD`, add:

```dockerfile
HEALTHCHECK --interval=5m --timeout=10s --start-period=30s \
  CMD node -e "process.exit(0)" || exit 1
```

This is a process-liveness check (the container's only process is this Node daemon; if it's not running, Docker already reports the container as exited). It does not (and can't, without adding an HTTP server this daemon has no other reason to run) check sync health specifically — that's what Task 10's Telegram alert covers instead.

- [ ] **Step 3: Verify the image still builds**

Run: `docker build -f companion/Dockerfile -t simplefin-sync:test .` (from the repo root)
Expected: builds successfully.

- [ ] **Step 4: Commit**

```bash
git add companion/package.json companion/Dockerfile
git commit -m "chore: sync companion version with root, add container healthcheck"
```

---

## Self-Review Notes

- **Spec coverage:** every numbered component in `docs/superpowers/specs/2026-07-28-notification-system-redesign-design.md` maps to a task — budget fix (Task 2), formatters/schedules/category selection (Tasks 4, 9), in-transit transfers (Task 7), stuck-transfer alert (Task 8, delivered in Task 10), sync health (Task 10), removal of the keyword system (Tasks 3, 4, 11), test harness fix (Task 1), minor polish (Task 12).
- **Type consistency verified:** `SyncResult.stuckTransferAlerts` shape (`{ description, amountCents, currency }`) is identical across Task 8 (producer), Task 9's test mocks, and Task 10 (consumer in `sendStuckTransferAlert`). `TransferLinkFailureEntry` shape is identical across Task 5 (interface + companion), Task 6 (addon), and Task 7/8 (fake host). `FeedTx.feeCents`/`inTransit` are only read in Task 7's `toActivityCreate` — no other task reads them, no drift risk.
- **Ordering dependency:** Tasks 3 and 5 each intentionally leave the repo non-compiling until their paired implementation task (4/11 and 6, respectively) lands — this is called out explicitly in each task rather than silently assumed.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-28-notification-system-redesign.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
