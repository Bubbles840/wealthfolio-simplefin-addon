# Notification System Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single, mislabeled automated Telegram report with real daily/weekly reports sourced from Wealthfolio's native budget data, fix the budget-selection bug behind it, and stop unlinked in-transit transfers from inflating the Spending Tracker.

**Architecture:** All transfer/reconciliation logic lives in `shared/sync-core.ts` so both the addon and the companion pick it up identically. The companion (`companion/src/index.ts`) gains a second cron and reads/writes a few new addon-secret keys through the existing `WealthfolioClient`/`RestSyncStore` plumbing. No new services or containers. New code is added alongside the old in early tasks; consumers migrate onto it in the middle tasks; the old code is deleted only once nothing references it (Task 11) — so every task leaves both `npm test` and `tsc --noEmit` clean, in both the root and `companion/` projects, with no multi-task broken-build window.

**Tech Stack:** TypeScript, vitest, node-cron, `node:sqlite`, Wealthfolio addon SDK.

## Global Constraints

- Every new/changed function needs a passing vitest test in the same PR — this repo has no separate CI test gate, so untested code ships silently broken.
- `shared/*.ts` files must stay host-agnostic (no `fetch`, no DOM/browser APIs, no Node-only APIs) — both the addon (browser iframe) and the companion (Node) import them directly.
- Comments on synced activities must keep ending in `· <txId>` (optionally followed by ` · pending`) — `txIdFromComment` in `shared/sync-core.ts` parses that suffix, and every reconciliation match depends on it.
- Run `npm test` at the repo root and `cd companion && npm test` before every commit that touches shared or companion code (they are separate vitest projects with separate `node_modules`). Both must be green, and both `npx tsc --noEmit` (root) and `cd companion && npx tsc --noEmit` must be clean, at the end of **every** task, not just the plan's final task.

---

## File Structure

| File | Responsibility |
|---|---|
| `companion/package.json` | Modify: pin `vitest` explicitly |
| `companion/src/sqlite-native.ts` | Modify: budget-row selection fix, spending date upper bound |
| `shared/types.ts` | Modify: `TelegramConfig` new fields (Task 3), `CategoryRule`/`categoryRules` removed (Task 11) |
| `shared/telegram.ts` | Modify: new report formatters added (Task 4), old ones removed (Task 11) |
| `shared/sync-host.ts` | Modify: `SyncStore` gains transfer-link-failure tracking |
| `companion/src/rest-host.ts` | Modify: `RestSyncStore` implements the new `SyncStore` methods |
| `src/utils/secrets.ts` | Modify: `SecretsStore` implements the same methods, plus a new read-only category-list getter |
| `shared/reconcile.ts` | Modify: `FeedTx` gains `feeCents`/`inTransit` |
| `shared/fake-host.ts` | Modify: test double implements the new `SyncStore` methods |
| `shared/sync-core.ts` | Modify: in-transit placeholder classification, stuck-pair alerting |
| `companion/src/index.ts` | Modify: second cron, category-filtered reports (using the new formatters), sync-health tracking |
| `src/pages/SyncPage.tsx` | Modify: replace the keyword-rule UI with a Report Categories checklist (using the new formatters/fields) |
| `companion/Dockerfile` | Modify: add `HEALTHCHECK` |

---

### Task 1: Fix the companion's broken test harness

**Files:**
- Modify: `companion/package.json`

**Interfaces:** None — this only changes which `vitest` binary runs.

- [ ] **Step 1: Confirm the current failure**

Run: `cd companion && npm test`
Expected: every test file fails to load (e.g. `Cannot find module '.../companion/src/test-setup.ts'`, or — depending on what a prior `npm install` cached — `Failed to load url sqlite`). Either symptom traces to the same root cause: `companion/package.json` never pins its own `vitest`, so the `vitest` binary that actually runs is whatever gets resolved from outside the `companion/` directory.

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
git commit -m "fix: pin companion vitest to match root, unbreaking test loading"
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

### Task 3: Add the new `TelegramConfig` fields (additive)

**Files:**
- Modify: `shared/types.ts`

**Interfaces:**
- Produces: `TelegramConfig` gains `dailyReportCategories?: string[] | 'all'` and `weeklyReportCategories?: string[] | 'all'`.
- **Does not** remove `CategoryRule` or `TelegramConfig.categoryRules` — both are still referenced by `shared/telegram.ts` and `src/pages/SyncPage.tsx` at this point in the plan. They are deleted in Task 11, once every consumer has migrated off them. Deleting them now would leave the addon non-compiling for 7 tasks; this task is purely additive so the build stays green throughout.

- [ ] **Step 1: Edit `shared/types.ts`**

Add two fields to the existing `TelegramConfig` interface (do not remove anything):

```typescript
export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
  notifyOnImport?: boolean;
  dailyReportEnabled?: boolean;
  weeklyReportEnabled?: boolean;
  categoryRules?: CategoryRule[];
  /** Category names to include in the daily digest. 'all' (default) means
   *  every category the companion has published via
   *  `available_report_categories`. */
  dailyReportCategories?: string[] | 'all';
  /** Same as dailyReportCategories, for the weekly total-remaining summary. */
  weeklyReportCategories?: string[] | 'all';
}
```

- [ ] **Step 2: Verify the build is unaffected**

Run: `npx tsc --noEmit && npm test`
Expected: both clean — this change is purely additive.

- [ ] **Step 3: Commit**

```bash
git add shared/types.ts
git commit -m "feat: add per-report category selection fields to TelegramConfig"
```

---

### Task 4: New report formatters (additive)

**Files:**
- Modify: `shared/telegram.ts`
- Modify: `shared/telegram.test.ts`

**Interfaces:**
- Produces: `formatWeeklyRemainingDigest(categories: Array<{ name: string; spent: number; budget: number }>, weeksLeftInMonth: number): string`
- Produces: `formatMonthlyRemainingSummary(totalSpent: number, totalBudget: number): string`
- **Does not** remove `formatDailyReport`, `formatWeeklyReport`, `formatNativeBudgetBreakdown`, `categorizeActivity`, or `DEFAULT_SPENDING_KEYWORDS` — `companion/src/index.ts` still imports `formatNativeBudgetBreakdown` and `src/pages/SyncPage.tsx` still imports the other two at this point in the plan. They're deleted in Task 11 once Tasks 8 and 10 have migrated their callers onto the new formatters.

- [ ] **Step 1: Write the failing tests**

Add to `shared/telegram.test.ts` (after the existing `describe('formatWeeklyReport', ...)` block — do not remove any existing `describe` blocks):

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

Add the two new names to the existing import line at the top of the test file (keep `formatDailyReport`/`formatWeeklyReport`, they're still tested by the `describe` blocks above this one):

```typescript
import { sendTelegramMessage, formatDailyReport, formatWeeklyReport, formatWeeklyRemainingDigest, formatMonthlyRemainingSummary } from './telegram.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/telegram.test.ts`
Expected: FAIL — `formatWeeklyRemainingDigest`/`formatMonthlyRemainingSummary` are not exported yet. Existing `formatDailyReport`/`formatWeeklyReport` tests still pass.

- [ ] **Step 3: Add the new formatters to `shared/telegram.ts`**

Add at the end of the file (after `getCategoryEmoji`), leaving every existing export in place:

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

`money()` is the existing private helper a few lines above — unchanged, already does `Math.abs` internally, so passing a negative `remaining` to it is intentional and correct.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run shared/telegram.test.ts`
Expected: PASS — every test in the file, old and new.

- [ ] **Step 5: Commit**

```bash
git add shared/telegram.ts shared/telegram.test.ts
git commit -m "feat: add weekly-remaining daily digest and monthly summary formatters"
```

---

### Task 5: `SyncStore` gains transfer-link-failure tracking (companion + addon together)

**Files:**
- Modify: `shared/sync-host.ts`
- Modify: `companion/src/rest-host.ts`
- Modify: `companion/src/rest-host.test.ts`
- Modify: `src/utils/secrets.ts`
- Modify: `src/utils/secrets.test.ts` (already exists with ~7 tests — append a new `describe` block, do not overwrite)
- Modify: `shared/fake-host.ts`

**Interfaces:**
- Produces (shared/sync-host.ts): `TransferLinkFailureEntry { count: number; firstFailedAt: string; alerted: boolean }`, added to `SyncStore`:
  - `getTransferLinkFailures(): Promise<Record<string, TransferLinkFailureEntry>>`
  - `setTransferLinkFailures(map: Record<string, TransferLinkFailureEntry>): Promise<void>`
- **All THREE `SyncStore` implementers are updated in this same task**, so `SyncStore` never has an incomplete implementer at any commit boundary: `RestSyncStore` (`companion/src/rest-host.ts:126`), `SecretsStore` (`src/utils/secrets.ts`), and the test double at `shared/fake-host.ts:243`. Adding the interface methods without all three makes `tsc --noEmit` fail in BOTH projects (`shared/` is compiled by each), which would violate this plan's every-task-green constraint.

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

- [ ] **Step 2: Write the failing companion test**

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

- [ ] **Step 3: Write the failing addon test**

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

- [ ] **Step 4: Run both tests to verify they fail**

Run: `cd companion && npx vitest run src/rest-host.test.ts && cd .. && npx vitest run src/utils/secrets.test.ts`
Expected: both FAIL — neither `RestSyncStore` nor `SecretsStore` implements the new methods yet, and (until Step 5/6 land) the whole `SyncStore` interface is unsatisfied so these files may not even compile.

- [ ] **Step 5: Implement in `RestSyncStore`**

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

- [ ] **Step 6: Implement in `SecretsStore`**

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

- [ ] **Step 7: Implement in the `shared/fake-host.ts` test double (the third implementer)**

`shared/fake-host.ts:243` declares `const store: SyncStore = { … }`, so it must satisfy the interface too or `tsc` fails in both projects. Add local state near the existing `let linkedGroups`:

```typescript
  let transferLinkFailures: Record<string, TransferLinkFailureEntry> = {};
```

and two methods on the `store` object, after `setLinkedGroups`:

```typescript
    async getTransferLinkFailures() {
      return transferLinkFailures;
    },
    async setTransferLinkFailures(map: Record<string, TransferLinkFailureEntry>) {
      transferLinkFailures = map;
    },
```

Add `TransferLinkFailureEntry` to the existing `import type { … } from './sync-host.js';` block at the top. Task 7 later changes the initializer to seed from `seed.transferLinkFailures`; a plain `{}` is correct for now.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd companion && npx vitest run src/rest-host.test.ts && cd .. && npx vitest run src/utils/secrets.test.ts`
Expected: PASS, both.

- [ ] **Step 9: Run the full addon and companion type-checks and test suites**

Run: `npx tsc --noEmit && npm test && cd companion && npx tsc --noEmit && npm test`
Expected: all four clean — `SyncStore` is now fully implemented across all three implementers, in the same commit.

- [ ] **Step 10: Commit**

```bash
git add shared/sync-host.ts companion/src/rest-host.ts companion/src/rest-host.test.ts src/utils/secrets.ts src/utils/secrets.test.ts shared/fake-host.ts
git commit -m "feat: add transfer-link-failure tracking to SyncStore, implement in all three implementers"
```

---

### Task 6: In-transit transfer placeholders in `shared/sync-core.ts`

**Files:**
- Modify: `shared/reconcile.ts`
- Modify: `shared/sync-core.ts`
- Modify: `shared/fake-host.ts`
- Modify: `shared/sync-core.test.ts`

**Interfaces:**
- Produces (shared/reconcile.ts): `FeedTx` gains `feeCents?: number` and `inTransit?: boolean`.
- Produces (shared/sync-core.ts): `IN_TRANSIT_TIMEOUT_SECONDS` exported constant (10 days, in seconds).
- Consumes: `neutralAdjustmentFields` (already defined in `shared/sync-core.ts`), `isTransferType`, `detectTransferPairs`.
- This task is purely additive to `shared/sync-core.ts`'s public surface — no existing export changes shape, so no other file's build is affected.

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

- [ ] **Step 2: (Already done in Task 5 — verify only, do not re-add)**

`shared/fake-host.ts` already implements `getTransferLinkFailures`/`setTransferLinkFailures`; Task 5 added them because that file is the third `SyncStore` implementer and `tsc` fails in both projects without it. Confirm they are present (`grep -n "TransferLinkFailures" shared/fake-host.ts` → 2 method definitions plus the `let transferLinkFailures` state) and move on. If they are missing, STOP and report — a prior task regressed.

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
    expect(create.amount).toBe(0);
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

Run: `npx vitest run shared/sync-core.test.ts -t "in-transit|placeholder|promotes|timeout"`
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

`toActivityUpdate` is unchanged — it already spreads `toActivityCreate(t)` and adds `id`, so it picks up the same fee/prefix handling automatically. When `amount` evaluates to `0` (the fee-side placeholder, where the full amount moved to `fee`), that's correct and intentional — it matches the exact shape `importAdjustmentActivity` already sends for balance-adjustment plugs elsewhere in this file.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run shared/sync-core.test.ts shared/reconcile.test.ts shared/fake-host.test.ts`
Expected: PASS — including every pre-existing test in these files (the fake-host and reconcile changes are additive).

- [ ] **Step 7: Run the full shared+addon test suite and type-check, and the companion's**

Run: `npm test && npx tsc --noEmit && cd companion && npm test && npx tsc --noEmit`
Expected: all clean — this is the point where every prior consumer of `FeedTx`/`createFakeHost` (in both projects) is exercised again.

- [ ] **Step 8: Commit**

```bash
git add shared/reconcile.ts shared/sync-core.ts shared/fake-host.ts shared/sync-core.test.ts
git commit -m "feat: import unpaired transfer legs as spending-neutral in-transit placeholders, promote or expire them on later syncs"
```

---

### Task 7: Stuck-transfer failure tracking and alerting

**Files:**
- Modify: `shared/sync-core.ts`
- Modify: `shared/sync-core.test.ts`

**Interfaces:**
- Produces: `SyncResult.stuckTransferAlerts: Array<{ description: string; amountCents: number; currency: string }>` (a new required field on `SyncResult`, always an array). Safe to make required: only `runSyncCore` itself constructs `SyncResult` values — every early-return and the final return are updated in this same task — and no existing test asserts the full `SyncResult` shape via `toEqual` (confirmed by grep before writing this plan). Nothing outside `shared/sync-core.ts` reads this field until Task 9, so no other file's build is affected by adding it now.
- Produces: `STUCK_TRANSFER_ALERT_THRESHOLD` exported constant (3).
- Consumes: `store.getTransferLinkFailures`/`setTransferLinkFailures` (Task 5).

**Behavior:** distinct from Task 6's ordinary in-transit case — this fires only when **both** legs of a pair are detected (`detection.pairs` contains them) but `host.linkPair()` keeps returning `linked: false`. After 3 consecutive failing sync runs on the same pair, `runSyncCore` reports it once via `stuckTransferAlerts`; the caller (Task 9) is responsible for actually sending the Telegram message.

- [ ] **Step 1: Extend the fake host to accept a seeded failure map**

In `shared/fake-host.ts`, add to `FakeHostSeed`:

```typescript
export interface FakeHostSeed {
  // ...existing fields...
  transferLinkFailures?: Record<string, { count: number; firstFailedAt: string; alerted: boolean }>;
}
```

Change the `let transferLinkFailures = {}` initializer added in **Task 5** to seed from it:

```typescript
  let transferLinkFailures: Record<string, TransferLinkFailureEntry> =
    seed.transferLinkFailures ?? {};
```

(the getter/setter methods on `store` added in Task 5 are unchanged — they already read/write this variable). Use the imported `TransferLinkFailureEntry` type in the `FakeHostSeed` field too, rather than re-spelling the inline object shape — it is already imported in this file as of Task 5.

- [ ] **Step 2: Write the failing tests**

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

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run shared/sync-core.test.ts -t "stuck-transfer|re-alert|clears a failure"`
Expected: FAIL — `result.stuckTransferAlerts` is `undefined` (property doesn't exist yet).

- [ ] **Step 4: Implement in `shared/sync-core.ts`**

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

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run shared/sync-core.test.ts`
Expected: PASS — all tests, including Task 6's and every pre-existing one.

- [ ] **Step 6: Run the full shared+addon+companion test suites and type-checks**

Run: `npm test && npx tsc --noEmit && cd companion && npm test && npx tsc --noEmit`
Expected: clean, all four.

- [ ] **Step 7: Commit**

```bash
git add shared/sync-core.ts shared/sync-core.test.ts shared/fake-host.ts
git commit -m "feat: alert once when a detected transfer pair fails to link 3 sync runs in a row"
```

---

### Task 8: Companion — two report schedules, category filtering, published category list

**Files:**
- Modify: `companion/src/index.ts`
- Modify: `companion/src/index.test.ts`

**Interfaces:**
- Produces: `sendWeeklyTelegramReport(wfClient: WealthfolioClient): Promise<void>`
- Modifies: `sendDailyTelegramReport` (same signature; now built from `formatWeeklyRemainingDigest` instead of `formatNativeBudgetBreakdown` — this is where `companion/src/index.ts` migrates off the old formatter, so Task 11 can safely delete it afterward).
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

Run: `cd companion && npx vitest run src/index.test.ts -t "sendDailyTelegramReport|sendWeeklyTelegramReport"`
Expected: FAIL — `sendWeeklyTelegramReport` isn't exported; `sendDailyTelegramReport` doesn't publish `available_report_categories` or filter by category yet.

- [ ] **Step 3: Implement in `companion/src/index.ts`**

Update the telegram import line to bring in the two new formatters alongside `sendTelegramMessage` (leave `formatNativeBudgetBreakdown` out of this import — it's being replaced, and Task 11 removes it from `shared/telegram.ts` once this is the only place that used it):

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

- [ ] **Step 5: Run the full companion type-check**

Run: `cd companion && npx tsc --noEmit`
Expected: clean — `formatNativeBudgetBreakdown` is unused here now but still exists in `shared/telegram.ts` (Task 4 kept it), so nothing is broken; it's simply no longer imported by this file.

- [ ] **Step 6: Commit**

```bash
git add companion/src/index.ts companion/src/index.test.ts
git commit -m "feat: add weekly Telegram report schedule, category filtering, and published category list"
```

---

### Task 9: Companion — sync health tracking, stuck-transfer alert delivery

**Files:**
- Modify: `companion/src/index.ts`
- Modify: `companion/src/index.test.ts`

**Interfaces:**
- Modifies: `runCompanionSync(): Promise<SyncResult>` (was `Promise<void>` — now returns the result so `stuckTransferAlerts` can be consumed). No caller currently uses the resolved value, so widening it is safe.
- Consumes: `SyncResult.stuckTransferAlerts` (Task 7).

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

Import `SyncResult` type — add to the existing `import { runSyncCore } from '../../shared/sync-core.js';` line:

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

### Task 10: Addon UI — replace the keyword-rule editor with a Report Categories checklist

**Files:**
- Modify: `src/pages/SyncPage.tsx`
- Modify: `src/pages/SyncPage.test.tsx`
- Modify: `src/utils/secrets.ts`

**Interfaces:**
- Consumes: `SecretsStore.getAvailableReportCategories()` — **new**, added in this task (mirrors the `linked_groups`-style pattern; the companion writes `available_report_categories` via `wfClient.setAddonSecret`, Task 8, so the addon only needs a getter, no setter).
- This task migrates `SyncPage.tsx` off `formatDailyReport`, `formatWeeklyReport`, `categorizeActivity`, and `CategoryRule` entirely — after this task, nothing outside `shared/telegram.ts`/`shared/types.ts` themselves references them, which is what makes Task 11's deletion safe.

- [ ] **Step 1: Add the getter to `SecretsStore`**

In `src/utils/secrets.ts`, add a key:

```typescript
  availableReportCategories: 'available_report_categories',
```

Add a method (after `getTransferLinkFailures`/`setTransferLinkFailures` from Task 5):

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

(Adjust the exact `getByLabelText` matcher once Step 5's markup is in place — the label text pattern below is `"Dining — Daily"` / `"Dining — Weekly"` per-checkbox, so a regex like `/Dining.*Daily/i` matches. If this repo's existing SyncPage tests use a different render/query setup — e.g. a custom `renderPage()` helper — follow that instead of raw `render()`.)

Also remove (not just leave failing) any pre-existing test in this file that exercises the "Send Sample Budget Report" button or the "Customize Category Modes & Budgets" panel — both are deleted from the component in Step 4/5 below, so tests asserting their presence would otherwise fail permanently. Search for `Send Sample Budget Report`, `Customize Category`, and `categoryRules` in the file.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/pages/SyncPage.test.tsx -t "Report Categories|categories will appear|saves the selected"`
Expected: FAIL — no such UI exists yet.

- [ ] **Step 4: Remove the retired UI from `SyncPage.tsx`**

Delete `DEFAULT_CATEGORY_RULES` (lines 13-24) and drop `CategoryRule` from the `import type { AccountMapping, MappingRule, CategoryRule } from '../../shared/types';` line (11) — leave `AccountMapping`/`MappingRule`.

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

(remove the old `if (Array.isArray(tg.categoryRules) ...) setCategoryRules(...)` block entirely — this is the point where `SyncPage.tsx` stops referencing `tg.categoryRules`, even though the field still exists on `TelegramConfig` until Task 11.)

Update the import line (line 8) to drop `formatDailyReport`, `formatWeeklyReport`, `categorizeActivity`:

```typescript
import { sendTelegramMessage, getCategoryEmoji } from '../../shared/telegram';
```

Delete the entire "Send Sample Budget Report" button block (lines 681-780, from `<Button variant="outline" disabled={testingTelegram || !botToken || !chatId} onClick={async () => { setTestingTelegram(true); setTelegramStatus('Sending budget breakdown report...');` through its matching `</Button>`) — its only purpose was exercising the formatters this task is migrating away from.

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

(this call no longer sends `categoryRules` — the field still exists on the `TelegramConfig` type per Task 3/11's sequencing, but nothing writes it anymore after this task; Task 11 removes the field from the type once this is confirmed to be its last writer).

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run src/pages/SyncPage.test.tsx`
Expected: PASS — all tests, including pre-existing ones.

- [ ] **Step 8: Run the full addon test suite and type-check**

Run: `npm test && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add src/pages/SyncPage.tsx src/pages/SyncPage.test.tsx src/utils/secrets.ts
git commit -m "feat: replace keyword-rule category editor with a Report Categories checklist sourced from the companion"
```

---

### Task 11: Remove the superseded keyword-based category system

**Files:**
- Modify: `shared/telegram.ts`
- Modify: `shared/telegram.test.ts`
- Modify: `shared/types.ts`

**Interfaces:**
- Removes: `formatDailyReport`, `formatWeeklyReport`, `formatNativeBudgetBreakdown`, `DailyReportData`, `WeeklyReportData`, `CategoryReportItem`, `categorizeActivity`, `DEFAULT_SPENDING_KEYWORDS` from `shared/telegram.ts`.
- Removes: `CategoryRule`, `TelegramConfig.categoryRules` from `shared/types.ts`.
- Keeps unchanged: `sendTelegramMessage`, `getCategoryEmoji`, `DEFAULT_CATEGORY_EMOJIS`, `money`, `formatWeeklyRemainingDigest`, `formatMonthlyRemainingSummary`.
- Safe now because: Task 8 migrated `companion/src/index.ts` off `formatNativeBudgetBreakdown`; Task 10 migrated `src/pages/SyncPage.tsx` off `formatDailyReport`/`formatWeeklyReport`/`categorizeActivity`/`CategoryRule`. This task starts with a grep to reconfirm zero remaining references before deleting anything.

- [ ] **Step 1: Confirm nothing still references the code being removed**

Run: `grep -rn "formatDailyReport\|formatWeeklyReport\|formatNativeBudgetBreakdown\|categorizeActivity\|DEFAULT_SPENDING_KEYWORDS\|CategoryRule\|categoryRules" --include="*.ts" --include="*.tsx" src/ companion/src/ shared/ | grep -v "\.test\."`

Expected: no output (the only remaining hits should be inside `shared/telegram.ts`/`shared/types.ts` themselves and their own test files, which this task is about to edit) — if anything else shows up, STOP and report it rather than deleting out from under a live caller.

- [ ] **Step 2: Remove the retired tests first**

In `shared/telegram.test.ts`, delete the `describe('formatDailyReport', ...)` and `describe('formatWeeklyReport', ...)` blocks (their formatters are about to be deleted) and drop `formatDailyReport`, `formatWeeklyReport` from the import line at the top, leaving:

```typescript
import { sendTelegramMessage, formatWeeklyRemainingDigest, formatMonthlyRemainingSummary } from './telegram.js';
```

- [ ] **Step 3: Run tests to verify the file is still green with the reduced test set**

Run: `npx vitest run shared/telegram.test.ts`
Expected: PASS (fewer tests than before, all passing — this just confirms the test file itself is internally consistent before the source deletion, which will make the *old* import line fail to compile if done in the wrong order).

- [ ] **Step 4: Delete the retired code from `shared/telegram.ts`**

Delete: `DailyReportData`, `WeeklyReportData`, `CategoryReportItem` interfaces, `formatDailyReport`, `formatWeeklyReport`, `formatNativeBudgetBreakdown`, `categorizeActivity`, `DEFAULT_SPENDING_KEYWORDS`, and the `import type { CategoryRule } from './types.js';` line that only `categorizeActivity`'s signature used.

- [ ] **Step 5: Delete `CategoryRule` and `categoryRules` from `shared/types.ts`**

Remove the `CategoryRule` interface entirely, and remove the `categoryRules?: CategoryRule[];` line from `TelegramConfig` (added in Task 3, now dead).

- [ ] **Step 6: Run the full test suites and type-checks, both projects**

Run: `npx tsc --noEmit && npm test && cd companion && npx tsc --noEmit && npm test`
Expected: all four clean.

- [ ] **Step 7: Commit**

```bash
git add shared/telegram.ts shared/telegram.test.ts shared/types.ts
git commit -m "chore: remove the keyword-based category system, fully superseded by the native-DB report formatters"
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

This is a process-liveness check (the container's only process is this Node daemon; if it's not running, Docker already reports the container as exited). It does not (and can't, without adding an HTTP server this daemon has no other reason to run) check sync health specifically — that's what Task 9's Telegram alert covers instead.

- [ ] **Step 3: Verify the image still builds**

Run: `docker build -f companion/Dockerfile -t simplefin-sync:test .` (from the repo root)
Expected: builds successfully.

- [ ] **Step 4: Commit**

```bash
git add companion/package.json companion/Dockerfile
git commit -m "chore: sync companion version with root, add container healthcheck"
```

---

### Task 13: Make the companion's `linkPair` clear a promoted leg's phantom asset

**Added mid-execution.** Task 6's implementer surfaced this and the controller confirmed it: an in-transit placeholder is imported with `symbol: $CASH-<ccy>` (its type is `CREDIT`/`DEPOSIT`, not a transfer type, so `toActivityCreate` attaches the cash asset). When the second leg posts and the row is promoted to `TRANSFER_OUT`/`TRANSFER_IN`, the update **cannot clear** that stored asset — the server's `asset` field is a plain `Option`, not the `Option<Option<…>>` patch shape its numeric fields use.

The addon is unaffected: `AddonSyncHost.linkPair` deletes both legs and re-creates them asset-free, so promotion self-heals. **The companion is not:** `RestSyncHost.linkPair` (`companion/src/rest-host.ts`) calls `/activities/link` by id and never re-creates, so the phantom `$CASH` survives — and per this repo's own `companion/upstream-pr.md` (issue #5, "Second symptom"), `validate_asset_shape` in `transfer_pairs.rs` then treats the pair as a *security* transfer and refuses it for lacking quantities. Worse, a leg being linked this run is in `linkedTxIds`, so the end-of-run relink sweep skips it — the pair sticks permanently on the companion, which is precisely the bug Task 6 exists to fix.

Rather than copy the addon's ~30-line delete-and-re-create block into the companion (verbatim duplication of a logic block, which this plan's review rubric treats as a defect), extract it once and have both hosts delegate.

**Files:**
- Create: `shared/link-pair.ts`
- Create: `shared/link-pair.test.ts`
- Modify: `src/utils/addon-host.ts` (delegate)
- Modify: `companion/src/rest-host.ts` (delegate)
- Modify: `companion/src/rest-host.test.ts` (update the two `linkPair` tests — they currently assert `linkTransferActivities` is called, which is exactly the behavior being replaced)

**Interfaces:**
- Produces: `linkPairByRecreate(saveMany: (req: SaveManyRequest) => Promise<SaveManyResult>, legs: [LinkLeg, LinkLeg]): Promise<LinkResult>`
- Consumes: `newTransferGroupId`, `INTERNAL_TRANSFER_METADATA`, `txIdFromComment` (all already exported from `shared/sync-core.ts`).

- [ ] **Step 1: Write the failing test**

Create `shared/link-pair.test.ts`. Drive the helper with a fake `saveMany` that records requests and echoes created rows, so the test verifies real behavior rather than asserting on a spy:

```typescript
import { describe, it, expect } from 'vitest';
import { linkPairByRecreate } from './link-pair.js';
import { TRANSFER_GROUP_PREFIX } from './sync-core.js';
import type { LinkLeg, SaveManyRequest, SaveManyResult } from './sync-host.js';

const leg = (wfId: string, accountId: string, type: string): LinkLeg => ({
  wfId, accountId, txId: `tx-${wfId}`, activityType: type,
  date: '2026-07-20', absCents: 198219, currency: 'USD',
  comment: `Transfer · tx-${wfId}`,
});

/** Fake host: echoes creates back with the gid it was sent, like a host that accepts the group. */
function acceptingHost() {
  const requests: SaveManyRequest[] = [];
  const saveMany = async (req: SaveManyRequest): Promise<SaveManyResult> => {
    requests.push(req);
    return {
      created: (req.creates ?? []).map((c, i) => ({
        id: `new-${i}`, accountId: c.accountId, activityType: c.activityType,
        date: c.activityDate, amount: c.amount ?? null, comment: c.comment,
        sourceGroupId: c.sourceGroupId ?? null,
      })),
      updated: [], errors: [],
    };
  };
  return { requests, saveMany };
}

describe('linkPairByRecreate', () => {
  it('deletes both legs before re-creating them, so a stored asset cannot survive', async () => {
    const { requests, saveMany } = acceptingHost();
    await linkPairByRecreate(saveMany, [leg('a', 'wf-a', 'TRANSFER_OUT'), leg('b', 'wf-b', 'TRANSFER_IN')]);
    expect(requests[0].deleteIds).toEqual(['a', 'b']);
    expect(requests[1].creates).toHaveLength(2);
  });

  it('re-creates both legs with NO symbol, so they book cash and stay pairable', async () => {
    const { requests, saveMany } = acceptingHost();
    await linkPairByRecreate(saveMany, [leg('a', 'wf-a', 'TRANSFER_OUT'), leg('b', 'wf-b', 'TRANSFER_IN')]);
    for (const c of requests[1].creates!) {
      expect(c.symbol).toBeUndefined();
      expect(c.amount).toBe(1982.19);
    }
  });

  it('sends both legs in ONE saveMany carrying a shared wf-transfer- gid and the internal marker', async () => {
    const { requests, saveMany } = acceptingHost();
    await linkPairByRecreate(saveMany, [leg('a', 'wf-a', 'TRANSFER_OUT'), leg('b', 'wf-b', 'TRANSFER_IN')]);
    const creates = requests[1].creates!;
    expect(creates[0].sourceGroupId).toBe(creates[1].sourceGroupId);
    expect(creates[0].sourceGroupId!.startsWith(TRANSFER_GROUP_PREFIX)).toBe(true);
    for (const c of creates) expect(c.metadata).toBeTruthy();
  });

  it('reports the gid the host actually stored, not the one we sent', async () => {
    const requests: SaveManyRequest[] = [];
    const saveMany = async (req: SaveManyRequest): Promise<SaveManyResult> => {
      requests.push(req);
      return {
        created: (req.creates ?? []).map((c, i) => ({
          id: `new-${i}`, accountId: c.accountId, activityType: c.activityType,
          date: c.activityDate, amount: c.amount ?? null, comment: c.comment,
          sourceGroupId: 'gid-the-host-chose',
        })),
        updated: [], errors: [],
      };
    };
    const res = await linkPairByRecreate(saveMany, [leg('a', 'wf-a', 'TRANSFER_OUT'), leg('b', 'wf-b', 'TRANSFER_IN')]);
    expect(res).toEqual({ linked: true, groupId: 'gid-the-host-chose' });
  });

  it('reports linked: false when the host silently drops the group', async () => {
    const saveMany = async (req: SaveManyRequest): Promise<SaveManyResult> => ({
      created: (req.creates ?? []).map((c, i) => ({
        id: `new-${i}`, accountId: c.accountId, activityType: c.activityType,
        date: c.activityDate, amount: c.amount ?? null, comment: c.comment,
        sourceGroupId: null,
      })),
      updated: [], errors: [],
    });
    const res = await linkPairByRecreate(saveMany, [leg('a', 'wf-a', 'TRANSFER_OUT'), leg('b', 'wf-b', 'TRANSFER_IN')]);
    expect(res.linked).toBe(false);
  });

  it('reports linked: false when a save returns errors', async () => {
    const saveMany = async (): Promise<SaveManyResult> => ({
      created: [], updated: [], errors: [{ action: 'create', message: 'boom' }],
    });
    const res = await linkPairByRecreate(saveMany, [leg('a', 'wf-a', 'TRANSFER_OUT'), leg('b', 'wf-b', 'TRANSFER_IN')]);
    expect(res.linked).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run shared/link-pair.test.ts`
Expected: FAIL — `shared/link-pair.ts` does not exist.

- [ ] **Step 3: Create `shared/link-pair.ts`**

Move the body of `AddonSyncHost.linkPair` here verbatim, parameterized on `saveMany`. Keep its full explanatory comment — every clause in it was established the hard way and must not be lost in the move:

```typescript
import { INTERNAL_TRANSFER_METADATA, newTransferGroupId, txIdFromComment } from './sync-core.js';
import type { LinkLeg, LinkResult, SaveManyRequest, SaveManyResult } from './sync-host.js';

/**
 * Link two legs as one internal transfer by DELETING both rows and re-creating
 * them together under a shared marked group. Shared by both hosts so they
 * cannot drift.
 *
 * Every part of this is load-bearing, and each was established the hard way:
 *  • DELETE, don't update. An existing row's stored asset cannot be cleared by
 *    an update (the server's `asset` field is a plain Option, not the
 *    Option<Option<…>> patch shape its numeric fields use), and Wealthfolio
 *    refuses to move an already-grouped row into a different group. Deleting
 *    first clears both states, so the fresh group always forms — and the
 *    delete goes first so the re-creates can't collide with the originals on
 *    the host's dedup. This is also what clears the phantom `$CASH` asset an
 *    in-transit placeholder leaves behind when it is promoted to a real leg.
 *  • NO `symbol`. A transfer leg carrying any asset resolves to a literal
 *    "$CASH" security, which neither moves the cash balance nor passes
 *    `validate_asset_shape` — so it can never be paired.
 *  • The `metadata` marker AND the `wf-transfer-` prefix. A shared
 *    sourceGroupId alone does NOT classify a pair as internal; a marker is
 *    also required, and metadata must be the JSON *string* (an object 422s).
 *  • ONE saveMany carrying BOTH legs. A per-leg call looks like a lone leg and
 *    Wealthfolio silently drops the half-formed group.
 *
 * The echo is the only channel that reports the persisted `sourceGroupId`
 * (search's ActivityDetails omits it), so the return value is read from there
 * rather than assumed: a save can "succeed" with the group silently dropped.
 */
export async function linkPairByRecreate(
  saveMany: (req: SaveManyRequest) => Promise<SaveManyResult>,
  legs: [LinkLeg, LinkLeg],
): Promise<LinkResult> {
  const groupId = newTransferGroupId();
  const problems: string[] = [];

  const del = await saveMany({ deleteIds: legs.map((l) => l.wfId) });
  for (const e of del.errors) problems.push(`delete (${e.action}): ${e.message}`);

  const res = await saveMany({
    creates: legs.map((leg) => ({
      accountId: leg.accountId,
      activityType: leg.activityType,
      activityDate: leg.date,
      amount: leg.absCents / 100,
      currency: leg.currency,
      comment: leg.comment,
      metadata: INTERNAL_TRANSFER_METADATA,
      sourceGroupId: groupId,
    })),
  });
  for (const e of res.errors) problems.push(`save (${e.action}): ${e.message}`);
  if (problems.length > 0) return { linked: false };

  // Adopt the gid Wealthfolio actually stored — it keeps its own for rows that
  // were already grouped, and reports null when it dropped the group entirely.
  const echoed = new Map<string, string | null | undefined>();
  for (const a of [...res.updated, ...res.created]) {
    const txId = txIdFromComment(a.comment);
    if (txId) echoed.set(txId, a.sourceGroupId);
  }
  const stored = legs.map((l) => echoed.get(l.txId));
  const linked = !!stored[0] && stored[0] === stored[1];
  return linked ? { linked: true, groupId: stored[0]! } : { linked: false };
}
```

- [ ] **Step 4: Delegate from both hosts**

In `src/utils/addon-host.ts`, replace `AddonSyncHost.linkPair`'s body (and move its comment to the shared file per Step 3) with:

```typescript
  async linkPair(legs: [LinkLeg, LinkLeg]): Promise<LinkResult> {
    return linkPairByRecreate((req) => this.saveMany(req), legs);
  }
```

adding `import { linkPairByRecreate } from '../../shared/link-pair';` at the top.

In `companion/src/rest-host.ts`, replace `RestSyncHost.linkPair`'s entire `/activities/link`-based body with the same two-line delegation (importing from `'../../shared/link-pair.js'`). Leave `WealthfolioClient.linkTransferActivities` in place — it is no longer called by the sync path, but it is a thin API wrapper and deleting it is out of scope for this task.

- [ ] **Step 5: Update the companion's `linkPair` tests**

`companion/src/rest-host.test.ts` has two tests asserting the old id-based behavior (`expect(client.linkTransferActivities).toHaveBeenCalledWith('act-out', 'act-in')` and a throws-→-`linked:false` case). Replace them with tests against the new delegation: a fake client whose `saveMany` echoes a shared gid should yield `{ linked: true, groupId }`, and one returning `errors` should yield `{ linked: false }`. Keep every other test in the file.

- [ ] **Step 6: Verify**

Run: `npx vitest run shared/link-pair.test.ts && npm test && npx tsc --noEmit && cd companion && npm test && npx tsc --noEmit`
Expected: all green/clean. Note `src/utils/sync.test.ts` has an existing test asserting the addon's link behavior — it should still pass, since the delegation preserves semantics exactly; if it fails, the move was not faithful.

- [ ] **Step 7: Commit**

```bash
git add shared/link-pair.ts shared/link-pair.test.ts src/utils/addon-host.ts companion/src/rest-host.ts companion/src/rest-host.test.ts
git commit -m "fix: companion linkPair now deletes and re-creates legs, clearing a promoted placeholder's phantom asset"
```

---

### Task 14: Stop the root vitest project from collecting companion tests

**Added mid-execution.** Task 8's implementer hit this and the controller confirmed it: the root `vitest.config.ts` declares no `exclude`, so `npx vitest list` shows the root project collecting all five `companion/src/*.test.ts` files — 35 tests — under `environment: 'jsdom'`, *in addition to* the companion's own node-environment run. That is why the same three new tests appeared in both the root total (218→221) and the companion total (32→35).

Consequences, in order of importance:

1. **Production code is being shaped by the misconfiguration.** Task 8 had to change `companion/src/index.ts` from `import { readFileSync, existsSync } from 'fs'` to `import * as fs from 'fs'`, because `vi.mock('fs', …)` does not propagate to named imports consumed in another module under the accidental jsdom run. That workaround is invisible at the call site and will break mysteriously the first time someone "tidies" the import back.
2. **Two runs of the same file can disagree**, since each resolves mocks under a different config. A developer fixing one can silently break the other.
3. Test counts are misleading, and every companion file runs twice.

`environment: 'jsdom'` is right for the addon (a browser iframe) and wrong for the companion (a Node daemon using `node:sqlite`, `child_process`, `fs`). Each project already has its own correct config; the root just needs to stop reaching into the other one.

**Files:**
- Modify: `vitest.config.ts`
- Modify: `companion/src/index.ts` (revisit the `fs` import once the constraint is gone)

**Interfaces:** None.

- [ ] **Step 1: Confirm the defect before changing anything**

Run: `npx vitest list | awk -F' > ' '{print $1}' | sort -u`
Expected: the list includes `companion/src/index.test.ts`, `companion/src/rest-host.test.ts`, `companion/src/simplefin.test.ts`, `companion/src/sqlite-native.test.ts`, and `companion/src/wealthfolio.test.ts` alongside the `src/` and `shared/` files. Record the full root test count (`npm test`) so you can prove the delta afterwards.

- [ ] **Step 2: Exclude the companion from the root project**

In `vitest.config.ts`, add an `exclude` that keeps vitest's defaults and adds the companion. Do not hand-write a bare `exclude: ['companion/**']` — that would drop vitest's built-in `node_modules`/`dist` exclusions and start collecting tests out of dependencies:

```typescript
import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
    // The companion is a separate vitest project with its own node-environment
    // config. Without this the root project also collects companion/src/*.test.ts
    // and runs them under jsdom, so every companion file ran twice under two
    // different configs — which is how a `vi.mock('fs')` that only works for
    // namespace imports came to dictate the shape of production code.
    exclude: [...configDefaults.exclude, 'companion/**'],
  },
});
```

Verify `configDefaults` is importable from `vitest/config` at the installed version (4.1.x); if it is not, import it from `vitest/config`'s named exports per that version's docs rather than inlining a guessed default list, and say what you used in your report.

- [ ] **Step 3: Verify the split is clean**

Run: `npx vitest list | awk -F' > ' '{print $1}' | sort -u`
Expected: no `companion/` entries. Then `npm test` — expected to pass with the root count reduced by exactly the 35 companion tests versus Step 1's baseline (i.e. 221 → 186); and `cd companion && npm test` — expected still 35 passing, unchanged.

- [ ] **Step 4: Revisit the `fs` import now that the constraint is gone**

With the companion no longer running under the root's jsdom config, `vi.mock('fs', …)` in `companion/src/index.test.ts` runs only under the companion's own config. Try restoring the conventional named import in `companion/src/index.ts`:

```typescript
import { readFileSync, existsSync } from 'fs';
```

and updating its use sites back from `fs.readFileSync`/`fs.existsSync`. Then run `cd companion && npm test`.

- If the companion suite stays green, keep the named import — it is the codebase's prevailing style and removes an unexplained shape.
- If it fails, **revert to the namespace import** and leave a one-line comment at the import site saying it must stay a namespace import for `vi.mock('fs')` to intercept it. An unexplained workaround is the actual hazard; a documented one is fine.

Report which branch you landed on and the evidence.

- [ ] **Step 5: Full verification**

Run: `npm test && npx tsc --noEmit && cd companion && npm test && npx tsc --noEmit`
Expected: all four clean.

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts companion/src/index.ts
git commit -m "test: stop the root vitest project from collecting companion tests"
```

---

### Task 15: Don't mark a stuck-transfer pair "alerted" until the alert is actually delivered

**Added mid-execution.** Task 9's implementer found this while fixing the identical bug one layer down, and correctly flagged it rather than reaching into another task's file. Controller-confirmed.

`runSyncCore` sets `linkFailures[failureKey].alerted = true` at the moment it *queues* an alert into `stuckTransferAlerts` (`shared/sync-core.ts:1061-1062`), and that flag is persisted at the end of the run (`:1087`). But delivery happens later and elsewhere — the companion's `sendStuckTransferAlert`. If that send fails (Telegram down, bad token, rate limit, a 400), the ledger already claims the user was notified, and because the emit is guarded by `!alerted` the pair will never alert again. The user silently never learns about a permanently stuck transfer.

This is exactly the bug Task 9 fixed in `checkSyncHealthAlert`; leaving the sibling unfixed would be inconsistent. Note `sendTelegramMessage` returns `{ ok: false }` rather than throwing, so a failed send is invisible unless the result is inspected.

**Design constraint:** `shared/sync-core.ts` is host-agnostic and must not learn about Telegram, so the confirmation cannot move into it. Keep the emit-and-mark where it is and have the *delivering* side roll the flag back on failure — the store is already reachable from the companion, and a rollback is idempotent and safe to retry.

**Files:**
- Modify: `companion/src/index.ts`
- Modify: `companion/src/index.test.ts`

**Interfaces:**
- Consumes: `RestSyncStore.getTransferLinkFailures` / `setTransferLinkFailures` (exists), `SyncResult.stuckTransferAlerts` (exists).
- Produces: no new exported surface — `sendStuckTransferAlert` gains a return value indicating delivery.

- [ ] **Step 1: Write the failing tests**

Add to `companion/src/index.test.ts`. These need the alert entry keyed the way `runSyncCore` keys it — by the OUT leg's `txId` — so `stuckTransferAlerts` entries must carry that key for the rollback to find its entry. **That is the crux of this task:** check whether the alert payload currently includes the key. `SyncResult.stuckTransferAlerts` is `{ description, amountCents, currency }` — no txId. If it has no key, the companion cannot identify which ledger entry to roll back, and you must add the key to the payload in `shared/sync-core.ts` (and its type) as part of this task, updating Task 7's tests accordingly. Decide and report which you did.

```typescript
describe('stuck-transfer alert delivery confirmation', () => {
  it('rolls the ledger entry back to un-alerted when the Telegram send fails', async () => {
    // runSyncCore has already persisted alerted:true for this pair when it queued the alert.
    // A failed delivery must undo that so the next sync re-alerts.
    // Seed: transfer_link_failures = { 'tx-out': { count: 3, firstFailedAt: <iso>, alerted: true } }
    // Mock fetch to resolve { ok: false, description: 'Bad Request' }.
    // Assert: after runCompanionSync, the persisted entry for 'tx-out' has alerted === false,
    // and count/firstFailedAt are unchanged.
  });

  it('leaves the ledger entry alerted when the send succeeds', async () => {
    // Same seed, but fetch resolves { ok: true }.
    // Assert: the persisted entry still has alerted === true (no spurious write is also fine —
    // assert the final state, not the number of writes).
  });

  it('rolls back only the entry whose send failed', async () => {
    // Two alerts queued; first send fails, second succeeds.
    // Assert: first entry alerted === false, second alerted === true.
  });
});
```

Write these out fully against the file's existing mock conventions (the `WealthfolioClient` mock must use a regular function, not an arrow — arrow functions cannot be `new`-targeted, a trap that already bit this file once).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/index.test.ts -t "stuck-transfer alert delivery"`
Expected: FAIL — no rollback exists, so a failed send leaves `alerted: true`.

- [ ] **Step 3: Implement**

Have `sendStuckTransferAlert` report delivery, e.g. return `Promise<boolean>` (`false` when it did not send — including the "no telegram config" early returns, or `true` for those if you decide a non-attempt shouldn't trigger rollback; **state your choice and why**, since rolling back when Telegram simply isn't configured would re-queue an alert nobody can receive on every single sync).

In `runCompanionSync`, collect the alerts whose delivery failed and roll their ledger entries back in one read-modify-write through `RestSyncStore`:

```typescript
    const undelivered: string[] = [];
    for (const alert of result.stuckTransferAlerts) {
      const ok = await sendStuckTransferAlert(wfClient, alert);
      if (!ok) undelivered.push(alert.<key>);
    }
    if (undelivered.length > 0) {
      const failures = await store.getTransferLinkFailures();
      let changed = false;
      for (const key of undelivered) {
        if (failures[key]?.alerted) {
          failures[key] = { ...failures[key], alerted: false };
          changed = true;
        }
      }
      if (changed) await store.setTransferLinkFailures(failures);
    }
```

Read-modify-write rather than reusing an in-memory map: `runSyncCore` already wrote the ledger by this point, so re-read to avoid clobbering anything it changed.

- [ ] **Step 4: Verify**

Run: `cd companion && npx vitest run src/index.test.ts && npm test && npx tsc --noEmit && cd .. && npm test && npx tsc --noEmit`
Expected: all clean. If you added a key to `stuckTransferAlerts`, `shared/sync-core.test.ts` must also still pass.

- [ ] **Step 5: Commit**

```bash
git add companion/src/index.ts companion/src/index.test.ts
# plus shared/sync-core.ts shared/sync-core.test.ts if you added the key to the payload
git commit -m "fix: re-alert a stuck transfer when its Telegram alert failed to deliver"
```

---

## Self-Review Notes

- **Spec coverage:** every numbered component in `docs/superpowers/specs/2026-07-28-notification-system-redesign-design.md` maps to a task — budget fix (Task 2), formatters/schedules/category selection (Tasks 4, 8), in-transit transfers (Task 6), stuck-transfer alert (Task 7, delivered in Task 9), sync health (Task 9), removal of the keyword system (Tasks 10, 11), test harness fix (Task 1), minor polish (Task 12).
- **Type consistency verified:** `SyncResult.stuckTransferAlerts` shape (`{ description, amountCents, currency }`) is identical across Task 7 (producer), Task 8's test mocks, and Task 9 (consumer in `sendStuckTransferAlert`). `TransferLinkFailureEntry` shape is identical across Task 5 (interface + both implementers) and Task 6/7 (fake host). `FeedTx.feeCents`/`inTransit` are only read in Task 6's `toActivityCreate` — no other task reads them, no drift risk.
- **No broken-build windows:** every task ends its own steps with a full type-check + test run of every project it touched (see each task's verification steps), and no task leaves a dangling reference for a later task to clean up — additions (Tasks 3, 4) land before deletions (Task 11), and interface changes (Task 5) update every implementer in the same task, never split across a commit boundary.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-28-notification-system-redesign.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
