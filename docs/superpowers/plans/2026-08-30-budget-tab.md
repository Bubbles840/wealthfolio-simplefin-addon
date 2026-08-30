# Budget Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Budget tab, first and default in the addon, rendering ten standard reports and user-built custom reports from one companion-published `report_cube` secret, with a customizable dashboard + drill-in layout that works on phones.

**Architecture:** The companion aggregates the Wealthfolio DB into a versioned `ReportCube` secret each sync (Approach A in the spec). Every report — standard and custom — is a pure function of that object, evaluated addon-side. Charts use host-provided `recharts` + `@wealthfolio/ui/chart` (zero bundle cost; they are in `hostProvidedDependencies` in vite.config.ts).

**Tech Stack:** TypeScript, React (addon iframe), vitest (+ jsdom for `src/`), node:sqlite readers in the companion, Wealthfolio addon-secret storage as the only data channel.

**Spec:** `docs/superpowers/specs/2026-08-30-budget-tab-design.md`

## Global Constraints

- TDD for every task: failing test first, watch it fail, minimal code, watch it pass, commit. Run root tests from repo root (`npx vitest run <file>`), companion tests from `companion/` (`cd companion && npx vitest run <file>`).
- The addon bundle must not import `companion/` code, `node:sqlite`, or anything Node-only. `shared/` modules import nothing host-specific.
- Money is integer cents in every new interface; dollars appear only inside SQL readers (DB stores dollars) and at render time.
- Mobile is a hard requirement: no hover-only controls, touch targets ≥ 44px, tables scroll inside their own container, single-column stacking.
- Absence explains itself: a missing/stale/unknown-version cube renders one explanatory banner, never empty charts; per-report gaps follow the spec's report list.
- House style: doc comments explain WHY (see existing files), every fallible read degrades to its feature's off state, never fails a sync or a page.
- Version for release: **1.29.0** (package.json + manifest.json + shared/version.ts — version.test.ts pins all three).
- Commit messages follow house style (imperative sentence, body explains why) and end with the Claude Fable co-author line used by prior commits.

---

## Locked cross-task interfaces

Copied into tasks below; if a later task disagrees with this section, this section wins.

```ts
// shared/report-cube.ts
export const REPORT_CUBE_SECRET_KEY = 'report_cube';
export const REPORT_CUBE_TARGET_MONTHS = 24;
export const REPORT_CUBE_MAX_MONTHS = 36;
export const REPORT_CUBE_MAX_BYTES = 200_000;
export interface CubeAccount { sfinId: string; name: string; type: string }
export interface CubeMerchant { name: string; cents: number; count: number }
export interface CubePool { config: SemesterPoolConfig; daily: Array<{ date: string; spentCents: number }> }
export interface ReportCube {
  version: 1; asOf: string;
  months: string[];            // 'YYYY-MM', oldest first
  categories: string[];        // parent-level, alphabetical
  accounts: CubeAccount[];
  spend: number[][][];         // [month][category][account] signed cents
  uncategorized: number[][];   // [month][account] cents
  income: number[][];          // [month][account] cents
  budgets: number[][];         // [month][category] cents
  merchants: CubeMerchant[][]; // [month] top-20, desc by cents
  feesInterest: number[];      // [month] cents
  netWorth: Array<number | null>;
  liquid: Array<number | null>;
  pool: CubePool | null;
}
export function parseReportCube(raw: string | null | undefined): ReportCube | null;
export function monthlySpendTotals(cube: ReportCube, accounts?: string[] | null): number[];        // categorized + uncategorized
export function monthlyIncomeTotals(cube: ReportCube, accounts?: string[] | null): number[];
export function monthlyUncategorizedTotals(cube: ReportCube, accounts?: string[] | null): number[];
export function categorySeries(cube: ReportCube, category: string, accounts?: string[] | null): number[] | null;

// shared/report-eval.ts
export type CustomChart = 'line' | 'bars' | 'stacked' | 'area' | 'donut' | 'table';
export type CustomRange = { kind: 'months'; n: number } | { kind: 'all' } | { kind: 'pool' };
export interface CustomReportTerm { sign: 1 | -1; source: 'category' | 'income' | 'spending' | 'uncategorized'; category?: string }
export interface CustomReportSeries { label: string; terms: CustomReportTerm[] }
export interface CustomReport { id: string; name: string; chart: CustomChart; range: CustomRange; accounts: string[] | null; series: CustomReportSeries[] }
export interface EvaluatedSeries { label: string; values: number[]; unknownCategories: string[] }
export interface EvaluatedReport { months: string[]; series: EvaluatedSeries[] }
export function evaluateCustomReport(cube: ReportCube, def: CustomReport): EvaluatedReport;
export function parseCustomReports(raw: string | null | undefined): CustomReport[];
export function newCustomReportId(): string;                  // 'cr-' + crypto random

// shared/budget-layout.ts
export const STANDARD_REPORT_IDS: readonly string[]; // ['pool-burndown','cash-flow','category-trends','net-worth','savings-rate','merchants','budget-vs-actual','seasonality','fees-interest','runway-trend']
export interface BudgetLayout { heroes: string[]; order: string[]; hidden: string[] }
export interface ResolvedLayout { heroes: string[]; grid: string[]; hidden: string[] }
export function parseBudgetLayout(raw: string | null | undefined): BudgetLayout | null;
export function resolveBudgetLayout(stored: BudgetLayout | null, availableIds: string[], poolPresent: boolean): ResolvedLayout;
export function pinHero(stored: BudgetLayout, availableIds: string[], id: string): BudgetLayout;
export function moveCard(stored: BudgetLayout, availableIds: string[], id: string, delta: -1 | 1): BudgetLayout;
export function toggleHidden(stored: BudgetLayout, availableIds: string[], id: string): BudgetLayout;

// companion/src/sqlite-native.ts additions (dollars in rows, like existing readers)
export function getNativeSpendMatrix(dbPath: string, startInclusive: string, endExclusive: string): Array<{ month: string; category: string; accountId: string; amount: number }>;
export function getNativeIncomeByMonthAccount(dbPath: string, startInclusive: string, endExclusive: string): Array<{ month: string; accountId: string; amount: number }>;
export function getNativeUncategorizedByMonthAccount(dbPath: string, startInclusive: string, endExclusive: string, excludedActivityIds: string[]): Array<{ month: string; accountId: string; amount: number }>;
export function getNativeMerchantRows(dbPath: string, startInclusive: string, endExclusive: string): Array<{ month: string; notes: string; amount: number }>;
export function getNativeFeesInterestByMonth(dbPath: string, startInclusive: string, endExclusive: string): Array<{ month: string; amount: number }>;
export function getNativeSpendDailyTotals(dbPath: string, startInclusive: string, endExclusive: string, excludedActivityIds: string[]): Array<{ date: string; amount: number }>;
export function getNativeValuationByMonth(dbPath: string, months: string[]): Array<{ month: string; accountId: string; amount: number }>; // [] when no valuation table

// companion/src/report-cube-build.ts
export interface CubeBuildDeps {
  accountMeta(): Promise<Array<{ sfinId: string; wfId: string; name: string; type: string }>>;
  dismissedIds(): Promise<string[]>;
  poolConfig(): Promise<SemesterPoolConfig | null>;
  spendMatrix(start: string, endEx: string): ReturnType<typeof getNativeSpendMatrix>;
  incomeByMonthAccount(start: string, endEx: string): ReturnType<typeof getNativeIncomeByMonthAccount>;
  uncategorizedByMonthAccount(start: string, endEx: string, excluded: string[]): ReturnType<typeof getNativeUncategorizedByMonthAccount>;
  budgetsForMonth(yearMonth: string): Record<string, number>;   // getNativeWealthfolioBudgets
  merchantRows(start: string, endEx: string): ReturnType<typeof getNativeMerchantRows>;
  feesInterestByMonth(start: string, endEx: string): ReturnType<typeof getNativeFeesInterestByMonth>;
  spendDaily(start: string, endEx: string, excluded: string[]): ReturnType<typeof getNativeSpendDailyTotals>;
  valuationByMonth(months: string[]): ReturnType<typeof getNativeValuationByMonth>;
}
export async function buildReportCube(deps: CubeBuildDeps, now: Date, monthsWanted?: number): Promise<ReportCube>;

// src/utils/secrets.ts additions
async getReportCube(): Promise<ReportCube | null>;
async getCustomReports(): Promise<CustomReport[]>;
async setCustomReports(reports: CustomReport[]): Promise<void>;
async getBudgetLayout(): Promise<BudgetLayout | null>;
async setBudgetLayout(layout: BudgetLayout): Promise<void>;

// src/components/budget/report-data.ts — pure chart-data prep (all take cents in, hand recharts-ready rows out)
export interface MonthRow { month: string; [k: string]: number | string | null }
export function cashFlowData(cube: ReportCube): MonthRow[];                       // { month, income, spending, net } dollars
export function categoryTrendData(cube: ReportCube, categories: string[]): MonthRow[];
export function netWorthData(cube: ReportCube): MonthRow[];                       // { month, netWorth|null }
export function savingsRateData(cube: ReportCube): MonthRow[];                    // { month, rate|null } rate 0..1, null when income 0
export function merchantTable(cube: ReportCube, monthCount: number): Array<{ name: string; total: number; count: number; trend: number | null }>;
export function budgetVsActualData(cube: ReportCube, month: string): Array<{ category: string; budget: number; actual: number }>;
export function seasonalityGrid(cube: ReportCube): { categories: string[]; months: string[]; cells: number[][] };
export function feesInterestData(cube: ReportCube): MonthRow[];
export function runwayTrendData(cube: ReportCube): MonthRow[];                    // { month, months|null }
export function poolBurndownData(cube: ReportCube): Array<{ date: string; actual: number; ideal: number }>; // dollars remaining
```

Report-id → data mapping used by Tasks 9–13: hero/grid cards render by id via `<ReportView id=... cube=... />`; custom reports use id `custom:<CustomReport.id>`.

---

### Task 1: `shared/report-cube.ts` — cube type, parser, selectors

**Files:**
- Create: `shared/report-cube.ts`
- Test: `shared/report-cube.test.ts`

**Interfaces:** Produces everything under `shared/report-cube.ts` in the locked section. Consumes `SemesterPoolConfig` from `shared/pool.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// shared/report-cube.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseReportCube, monthlySpendTotals, monthlyIncomeTotals,
  monthlyUncategorizedTotals, categorySeries, type ReportCube,
} from './report-cube.js';

/** Two months × two categories × two accounts. sfin-1 CASH, sfin-2 CREDIT_CARD. */
export const CUBE: ReportCube = {
  version: 1, asOf: '2026-08-30T12:00:00Z',
  months: ['2026-07', '2026-08'],
  categories: ['Dining', 'Groceries'],
  accounts: [
    { sfinId: 'sfin-1', name: 'Checking', type: 'CASH' },
    { sfinId: 'sfin-2', name: 'Card', type: 'CREDIT_CARD' },
  ],
  spend: [
    [[1000, 2000], [3000, 0]],   // Jul: Dining 10+20, Groceries 30+0
    [[1500, 500], [0, 2500]],    // Aug
  ],
  uncategorized: [[100, 0], [0, 200]],
  income: [[50_000, 0], [0, 0]],
  budgets: [[4000, 3500], [4000, 3500]],
  merchants: [[{ name: 'CHIPOTLE', cents: 1500, count: 2 }], []],
  feesInterest: [0, 250],
  netWorth: [900_000, null],
  liquid: [400_000, 410_000],
  pool: null,
};

describe('selectors', () => {
  it('totals spend across categories and accounts, uncategorized included', () => {
    expect(monthlySpendTotals(CUBE)).toEqual([6100, 4700]);
  });
  it('filters totals to the named accounts', () => {
    expect(monthlySpendTotals(CUBE, ['sfin-2'])).toEqual([2000, 3200]);
  });
  it('reads one category series, account-filtered, null for unknown categories', () => {
    expect(categorySeries(CUBE, 'Dining')).toEqual([3000, 2000]);
    expect(categorySeries(CUBE, 'Dining', ['sfin-1'])).toEqual([1000, 1500]);
    expect(categorySeries(CUBE, 'Nope')).toBeNull();
  });
  it('totals income and uncategorized the same way', () => {
    expect(monthlyIncomeTotals(CUBE)).toEqual([50_000, 0]);
    expect(monthlyUncategorizedTotals(CUBE, ['sfin-2'])).toEqual([0, 200]);
  });
});

describe('parseReportCube', () => {
  it('round-trips a valid cube', () => {
    expect(parseReportCube(JSON.stringify(CUBE))).toEqual(CUBE);
  });
  it('rejects null, garbage, wrong version, and dimension mismatches', () => {
    expect(parseReportCube(null)).toBeNull();
    expect(parseReportCube('nope')).toBeNull();
    expect(parseReportCube(JSON.stringify({ ...CUBE, version: 2 }))).toBeNull();
    // spend outer length must equal months length
    expect(parseReportCube(JSON.stringify({ ...CUBE, spend: [CUBE.spend[0]] }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run shared/report-cube.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// shared/report-cube.ts  (doc comments in house style: what each series means,
// who writes it, why version-gated — crib the tone from shared/pool.ts)
import type { SemesterPoolConfig } from './pool.js';

export const REPORT_CUBE_SECRET_KEY = 'report_cube';
export const REPORT_CUBE_TARGET_MONTHS = 24;
export const REPORT_CUBE_MAX_MONTHS = 36;
export const REPORT_CUBE_MAX_BYTES = 200_000;

export interface CubeAccount { sfinId: string; name: string; type: string }
export interface CubeMerchant { name: string; cents: number; count: number }
export interface CubePool { config: SemesterPoolConfig; daily: Array<{ date: string; spentCents: number }> }
export interface ReportCube { /* exactly the locked shape */ }

export function parseReportCube(raw: string | null | undefined): ReportCube | null {
  if (!raw) return null;
  let v: any;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object' || v.version !== 1) return null;
  const m = Array.isArray(v.months) ? v.months.length : -1;
  const c = Array.isArray(v.categories) ? v.categories.length : -1;
  const a = Array.isArray(v.accounts) ? v.accounts.length : -1;
  if (m < 0 || c < 0 || a < 0) return null;
  const len = (x: unknown) => (Array.isArray(x) ? x.length : -1);
  if (len(v.spend) !== m || len(v.uncategorized) !== m || len(v.income) !== m
    || len(v.budgets) !== m || len(v.merchants) !== m || len(v.feesInterest) !== m
    || len(v.netWorth) !== m || len(v.liquid) !== m) return null;
  for (const monthSlice of v.spend) {
    if (len(monthSlice) !== c) return null;
    for (const catSlice of monthSlice) if (len(catSlice) !== a) return null;
  }
  return v as ReportCube;
}

function accountIdx(cube: ReportCube, accounts: string[] | null | undefined): number[] {
  if (!accounts) return cube.accounts.map((_, i) => i);
  const wanted = new Set(accounts);
  return cube.accounts.map((acc, i) => (wanted.has(acc.sfinId) ? i : -1)).filter((i) => i >= 0);
}

export function monthlySpendTotals(cube: ReportCube, accounts: string[] | null = null): number[] {
  const idx = accountIdx(cube, accounts);
  return cube.months.map((_, mi) => {
    let sum = 0;
    for (const catSlice of cube.spend[mi]) for (const ai of idx) sum += catSlice[ai];
    for (const ai of idx) sum += cube.uncategorized[mi][ai];
    return sum;
  });
}
export function monthlyIncomeTotals(cube: ReportCube, accounts: string[] | null = null): number[] {
  const idx = accountIdx(cube, accounts);
  return cube.months.map((_, mi) => idx.reduce((s, ai) => s + cube.income[mi][ai], 0));
}
export function monthlyUncategorizedTotals(cube: ReportCube, accounts: string[] | null = null): number[] {
  const idx = accountIdx(cube, accounts);
  return cube.months.map((_, mi) => idx.reduce((s, ai) => s + cube.uncategorized[mi][ai], 0));
}
export function categorySeries(cube: ReportCube, category: string, accounts: string[] | null = null): number[] | null {
  const ci = cube.categories.indexOf(category);
  if (ci === -1) return null;
  const idx = accountIdx(cube, accounts);
  return cube.months.map((_, mi) => idx.reduce((s, ai) => s + cube.spend[mi][ci][ai], 0));
}
```

- [ ] **Step 4: Run to verify pass** — same command → all green.
- [ ] **Step 5: Commit** — `git add shared/report-cube.ts shared/report-cube.test.ts && git commit` ("Add the report cube type, parser, and selectors").

---

### Task 2: `shared/report-eval.ts` — custom report model + evaluation

**Files:** Create `shared/report-eval.ts`, test `shared/report-eval.test.ts`.

**Interfaces:** Consumes Task 1's cube + selectors. Produces the locked `CustomReport` types, `evaluateCustomReport`, `parseCustomReports`, `newCustomReportId`.

- [ ] **Step 1: Failing tests** (import `CUBE` fixture from `./report-cube.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { evaluateCustomReport, parseCustomReports, newCustomReportId, type CustomReport } from './report-eval.js';
import { CUBE } from './report-cube.test.js';

const def = (over: Partial<CustomReport> = {}): CustomReport => ({
  id: 'cr-1', name: 'Food', chart: 'line', range: { kind: 'all' }, accounts: null,
  series: [{ label: 'Food', terms: [
    { sign: 1, source: 'category', category: 'Dining' },
    { sign: 1, source: 'category', category: 'Groceries' },
  ] }],
  ...over,
});

describe('evaluateCustomReport', () => {
  it('adds category series per month', () => {
    const r = evaluateCustomReport(CUBE, def());
    expect(r.months).toEqual(['2026-07', '2026-08']);
    expect(r.series[0].values).toEqual([6000, 4500]);
  });
  it('subtracts, mixes sources, and honors account filters', () => {
    const r = evaluateCustomReport(CUBE, def({
      accounts: ['sfin-1'],
      series: [{ label: 'Cash surplus', terms: [
        { sign: 1, source: 'income' },
        { sign: -1, source: 'spending' },
      ] }],
    }));
    // sfin-1: income 500/0; spending (cat 10+30 / 15) + uncat (1/0)
    expect(r.series[0].values).toEqual([50_000 - 4100, 0 - 1500]);
  });
  it('clips the month window for range months:n', () => {
    const r = evaluateCustomReport(CUBE, def({ range: { kind: 'months', n: 1 } }));
    expect(r.months).toEqual(['2026-08']);
    expect(r.series[0].values).toEqual([4500]);
  });
  it('scores an unknown category as zero and names it', () => {
    const r = evaluateCustomReport(CUBE, def({
      series: [{ label: 'X', terms: [{ sign: 1, source: 'category', category: 'Ghost' }] }],
    }));
    expect(r.series[0].values).toEqual([0, 0]);
    expect(r.series[0].unknownCategories).toEqual(['Ghost']);
  });
});

describe('parseCustomReports', () => {
  it('round-trips and rejects malformed entries individually', () => {
    const good = def();
    const raw = JSON.stringify([good, { id: 'bad' }, 42]);
    expect(parseCustomReports(raw)).toEqual([good]);
    expect(parseCustomReports(null)).toEqual([]);
    expect(parseCustomReports('junk')).toEqual([]);
  });
});

it('newCustomReportId is cr-prefixed and unique-ish', () => {
  const a = newCustomReportId(); const b = newCustomReportId();
  expect(a).toMatch(/^cr-[0-9a-f]{12}$/); expect(a).not.toBe(b);
});
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** — evaluation walks months in range (`pool` range = months intersecting `cube.pool.config` window, `all` when no pool); per term: `category` → `categorySeries` (null → zeros + record label once), `income`/`spending`/`uncategorized` → the matching selector; per-entry validation in `parseCustomReports` (id/name strings, chart in the union, terms well-formed — drop bad entries, keep good). `newCustomReportId` = `'cr-' + [crypto.getRandomValues 6 bytes as hex]` with a `Math.random` fallback (jsdom + node both have webcrypto; fallback keeps the function total).
- [ ] **Step 4: Verify pass.** — also re-run Task 1's file (fixture import must not have broken it).
- [ ] **Step 5: Commit** ("Add the custom report model and evaluator").

---

### Task 3: `shared/budget-layout.ts` — layout model + mutations

**Files:** Create `shared/budget-layout.ts`, test `shared/budget-layout.test.ts`.

**Interfaces:** Produces the locked layout API. No dependencies on other new modules.

- [ ] **Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest';
import {
  STANDARD_REPORT_IDS, parseBudgetLayout, resolveBudgetLayout,
  pinHero, moveCard, toggleHidden, type BudgetLayout,
} from './budget-layout.js';

const AVAIL = [...STANDARD_REPORT_IDS, 'custom:cr-1'];

describe('resolveBudgetLayout', () => {
  it('defaults heroes to pool + cash flow when a pool exists', () => {
    const r = resolveBudgetLayout(null, AVAIL, true);
    expect(r.heroes).toEqual(['pool-burndown', 'cash-flow']);
    expect(r.grid).toEqual(AVAIL.filter((id) => !r.heroes.includes(id)));
    expect(r.hidden).toEqual([]);
  });
  it('pool hero yields to category trends when no pool is set', () => {
    const r = resolveBudgetLayout(null, AVAIL, false);
    expect(r.heroes).toEqual(['cash-flow', 'category-trends']);
    // pool card is NOT in the grid either — the report is absent without a pool
    expect(r.grid).not.toContain('pool-burndown');
  });
  it('ignores unknown ids and appends new reports at the end', () => {
    const stored: BudgetLayout = { heroes: ['net-worth'], order: ['merchants', 'gone-report'], hidden: ['fees-interest'] };
    const r = resolveBudgetLayout(stored, AVAIL, true);
    expect(r.heroes).toEqual(['net-worth']);
    expect(r.grid[0]).toBe('merchants');
    expect(r.grid).not.toContain('gone-report');
    expect(r.grid).toContain('custom:cr-1');       // appended, never lost
    expect(r.hidden).toEqual(['fees-interest']);
    expect(r.grid).not.toContain('fees-interest');
  });
});

describe('mutations', () => {
  const base: BudgetLayout = { heroes: ['pool-burndown', 'cash-flow'], order: [], hidden: [] };
  it('pinning a third hero bumps the oldest back into the grid', () => {
    const next = pinHero(base, AVAIL, 'net-worth');
    expect(next.heroes).toEqual(['cash-flow', 'net-worth']);
  });
  it('moveCard swaps within resolved grid order and clamps at the edges', () => {
    const r = resolveBudgetLayout(base, AVAIL, true);
    const next = moveCard(base, AVAIL, r.grid[1], -1);
    expect(resolveBudgetLayout(next, AVAIL, true).grid[0]).toBe(r.grid[1]);
    const clamped = moveCard(next, AVAIL, resolveBudgetLayout(next, AVAIL, true).grid[0], -1);
    expect(resolveBudgetLayout(clamped, AVAIL, true).grid[0]).toBe(r.grid[1]); // unchanged
  });
  it('toggleHidden hides and un-hides', () => {
    const hiddenOnce = toggleHidden(base, AVAIL, 'merchants');
    expect(hiddenOnce.hidden).toContain('merchants');
    expect(toggleHidden(hiddenOnce, AVAIL, 'merchants').hidden).not.toContain('merchants');
  });
});

it('parseBudgetLayout rejects junk and non-string arrays', () => {
  expect(parseBudgetLayout(null)).toBeNull();
  expect(parseBudgetLayout('x')).toBeNull();
  expect(parseBudgetLayout(JSON.stringify({ heroes: [1], order: [], hidden: [] }))).toBeNull();
  const ok = { heroes: [], order: ['cash-flow'], hidden: [] };
  expect(parseBudgetLayout(JSON.stringify(ok))).toEqual(ok);
});
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** `resolveBudgetLayout`: drop `'pool-burndown'` from `availableIds` when `poolPresent` is false; heroes = stored heroes filtered to available (default `['pool-burndown','cash-flow']` → substitute `'category-trends'` for the pool hero when absent), capped at 2; hidden = stored hidden ∩ available; grid = stored order filtered to available minus heroes/hidden, then remaining available appended in `availableIds` order. Mutations return new `BudgetLayout` objects: `pinHero` appends and trims front to 2 (bumped id goes to the FRONT of `order`); `moveCard` operates on the resolved grid, writes the whole resolved grid back as `order` (that snapshot semantics is what makes up/down stable); `toggleHidden` adds/removes from `hidden` and removes from `heroes` if hiding a hero.
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** ("Add the budget layout model: heroes, order, hidden").

---

### Task 4: sqlite-native readers, part 1 — spend matrix, income, uncategorized by month×account

**Files:** Modify `companion/src/sqlite-native.ts` (append after `getNativeUncategorizedSpendingTotal`), test `companion/src/sqlite-native.test.ts` (append; this file builds REAL temp DBs — follow its existing fixture helpers for schema; extend the fixture with a second account where needed).

**Interfaces:** Produces the three locked readers. Reuses `SPENDING_SIGN`, `SPENDING_SIGNED_AMOUNT`, `spendingWhere` internals.

- [ ] **Step 1: Failing tests** — in the existing test file's style: build a temp DB with two accounts (`acc-cash` CASH, `acc-card` CREDIT_CARD), categories Dining/Groceries with `activity_taxonomy_assignments`, activities across two months, one uncategorized charge, one internal `TRANSFER_IN`, one interest row on the card, one refund. Assert:

```ts
it('getNativeSpendMatrix groups signed spend by month, parent category, and account', () => {
  const rows = getNativeSpendMatrix(dbPath, '2026-07-01', '2026-09-01');
  expect(rows).toContainEqual({ month: '2026-07', category: 'Dining', accountId: 'acc-cash', amount: 25.5 });
  // refund subtracts, transfers never appear
});
it('getNativeIncomeByMonthAccount counts cash deposits and interest, never transfers or card credits', () => {
  const rows = getNativeIncomeByMonthAccount(dbPath, '2026-07-01', '2026-09-01');
  expect(rows).toContainEqual({ month: '2026-07', accountId: 'acc-cash', amount: 500 });
  expect(rows.find((r) => r.accountId === 'acc-card')).toBeUndefined();
});
it('getNativeUncategorizedByMonthAccount excludes the given activity ids', () => {
  const rows = getNativeUncategorizedByMonthAccount(dbPath, '2026-07-01', '2026-09-01', ['uncat-dismissed']);
  expect(rows).toEqual([{ month: '2026-08', accountId: 'acc-card', amount: 12 }]);
});
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** `getNativeSpendMatrix`: the existing spending query with `strftime('%Y-%m', a.activity_date)` and `a.account_id` added to SELECT/GROUP BY. `getNativeIncomeByMonthAccount`: `UPPER(acc.account_type)='CASH' AND UPPER(a.activity_type) IN ('DEPOSIT','INTEREST')` — deliberately NOT `TRANSFER_IN` (internal moves and card payments must not read as income; the spec accepts missing a keyword-typed external transfer-in), and NOT in-transit placeholders (they are `CREDIT`, already outside the list). `getNativeUncategorizedByMonthAccount`: the existing uncategorized query (`LEFT JOIN … IS NULL`) with month + account grouping and the id-exclusion list interpolated the way `getNativeUncategorizedSpendingTotal` already does. All three go through `queryNativeDb` with positional fallback mapping like every neighbor.
- [ ] **Step 4: Verify pass** — `cd companion && npx vitest run src/sqlite-native.test.ts`.
- [ ] **Step 5: Commit** ("Add month-by-account spend, income, and uncategorized readers").

---

### Task 5: sqlite-native readers, part 2 — merchants, fees/interest, daily spend, valuation history

**Files:** Modify `companion/src/sqlite-native.ts`, test `companion/src/sqlite-native.test.ts`.

**Interfaces:** Produces the remaining four locked readers.

- [ ] **Step 1: Failing tests**

```ts
it('getNativeMerchantRows hands back raw notes with month and signed amount', () => {
  const rows = getNativeMerchantRows(dbPath, '2026-07-01', '2026-09-01');
  expect(rows).toContainEqual({ month: '2026-07', notes: 'CHIPOTLE 1234 · TRN-1', amount: 25.5 });
});
it('getNativeFeesInterestByMonth sums FEE everywhere plus INTEREST on cards only', () => {
  expect(getNativeFeesInterestByMonth(dbPath, '2026-07-01', '2026-09-01'))
    .toContainEqual({ month: '2026-08', amount: 7.5 }); // 5 fee + 2.50 card interest; cash interest is income
});
it('getNativeSpendDailyTotals buckets spending by day, exclusions honored', () => {
  const rows = getNativeSpendDailyTotals(dbPath, '2026-07-01', '2026-09-01', []);
  expect(rows).toContainEqual({ date: '2026-07-09', amount: 25.5 });
});
describe('getNativeValuationByMonth', () => {
  it('returns [] when no valuation table exists', () => {
    expect(getNativeValuationByMonth(dbPath, ['2026-07'])).toEqual([]);
  });
  it('reads month-end totals per account when the table exists', () => {
    // fixture: CREATE TABLE daily_account_valuation (account_id TEXT, valuation_date TEXT, total_value TEXT);
    // rows on the 15th and 31st — the 31st must win.
    expect(getNativeValuationByMonth(dbWithValuations, ['2026-07']))
      .toContainEqual({ month: '2026-07', accountId: 'acc-cash', amount: 4200 });
  });
});
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** Merchants: spending rows (both taxonomy-joined and uncategorized) selecting `a.notes` raw — normalization happens in Task 6 with `descriptionFromComment` (SQL string-mangling is how bugs happen). Fees: `UPPER(a.activity_type)='FEE' OR (UPPER(a.activity_type)='INTEREST' AND UPPER(acc.account_type)='CREDIT_CARD')`, plus the fee SIDE-CHANNEL: `CAST(a.fee AS REAL)` summed for spending rows where fee > 0 is **out of scope** (placeholders park money in `fee`; counting it would call transfers fees). Daily: the uncategorized+categorized union grouped by `a.activity_date`. Valuations: `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('daily_account_valuation','account_valuations','valuations')` — first hit wins; `PRAGMA table_info` to pick the date column (`valuation_date` else `date`) and value column (`total_value` else `market_value`); per month take the max-date row per account; any step failing → `[]` (charts render their accruing state). **This is the live-DB verification the spec called out — after this task lands, run the discovery query against Nick's real DB via the docker-exec recipe in the memory notes and record the actual table/columns in the commit message.**
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** ("Add merchant, fees, daily, and valuation-history readers").

---

### Task 6: `companion/src/report-cube-build.ts` — cube assembly

**Files:** Create `companion/src/report-cube-build.ts`, test `companion/src/report-cube-build.test.ts` (DI fakes, no module mocks — mirror `pool-report.test.ts`).

**Interfaces:** Consumes Task 1's types + Task 4/5 reader shapes (via `CubeBuildDeps`), `descriptionFromComment` from `shared/sync-core.js`, `parsePoolConfig`/pool types. Produces `buildReportCube(deps, now, monthsWanted?)`.

- [ ] **Step 1: Failing tests** — fake deps returning the Task 4/5 row shapes; assert:
  - months = last `monthsWanted` (default 24) ending at `now`'s month, oldest first;
  - `spend[mi][ci][ai]` lands rows by index, cents rounded, accounts keyed by **wf id → sfin id** through `accountMeta`;
  - categories = union of category names seen in spend + budgets, alphabetical;
  - merchants: notes normalized via `descriptionFromComment`, same-name rows aggregated, top-20 by cents desc, count kept;
  - `netWorth[mi]` = Σ all accounts' valuation cents or null when the reader returned nothing for that month; `liquid` = Σ CASH + CREDIT_CARD only;
  - `pool`: null without config; with config, `daily` = cumulative sum of `spendDaily` over the pool window;
  - size guard: with `monthsWanted = 36` and a deps fake yielding > `REPORT_CUBE_MAX_BYTES` serialized, the result trims oldest months until under the cap (assert `months.length < 36` and `JSON.stringify(cube).length <= REPORT_CUBE_MAX_BYTES`);
  - the whole result round-trips through `parseReportCube`.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** Build month list from `now`; call each dep once over `[firstMonth-01, firstOfNextMonth)`; index maps for month/category/account; fill dense zero arrays then add rows; merchants aggregation with a Map keyed by normalized name; `budgetsForMonth` looped per month (dollars → cents); trim loop: while serialized > cap and months > 6, drop index 0 of every month-indexed array. Wrap in the same "cents everywhere" discipline (`Math.round(amount * 100)`).
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** ("Assemble the report cube from the native readers").

---

### Task 7: companion publish wiring

**Files:** Modify `companion/src/index.ts` (imports; a `cubeBuildDeps(wfClient, dbPath)` builder beside `poolReportDeps`; publish block directly after the pool-status publish), test `companion/src/index.test.ts` (append).

**Interfaces:** Consumes Tasks 4–6 + `REPORT_CUBE_SECRET_KEY`. The sqlite-native mock factory in index.test.ts must gain the seven new reader exports (vi.mock replaces the whole module — a missing export fails every test in the file).

- [ ] **Step 1: Failing test** — mirror the `pool_status publish` test:

```ts
describe('report_cube publish', () => {
  it('publishes a versioned cube after a sync', async () => {
    process.env.WEALTHFOLIO_API_URL = 'http://wf';
    process.env.WEALTHFOLIO_PASSWORD = 'pw';
    const { WealthfolioClient } = await import('./wealthfolio.js');
    vi.mocked(WealthfolioClient as any).mockClear();
    await runCompanionSync();
    const instance = (vi.mocked(WealthfolioClient as any).mock.instances.at(-1)) as any;
    const call = instance.setAddonSecret.mock.calls.find((c: any[]) => c[1] === 'report_cube');
    expect(call).toBeTruthy();
    expect(JSON.parse(call[2]).version).toBe(1);
  });
});
```

  Plus mock-factory additions (all `vi.fn(() => [])`, `getNativeValuationByMonth: vi.fn(() => [])`).
- [ ] **Step 2: Verify failure** (and that no OTHER test broke from the factory edit).
- [ ] **Step 3: Implement.** `cubeBuildDeps`: `accountMeta` from `RestSyncStore.getAccountMapping()` + `wfClient.getAccounts()` + the `account_names` secret (name fallback = sfin id); readers bound to `dbPath`; `dismissedIds`/`poolConfig` shared with `poolReportDeps`. Publish inside the same guarded block as `pool_status`, `log(...)` on failure, skipped when the DB is missing.
- [ ] **Step 4: Verify pass** — full `cd companion && npx vitest run`.
- [ ] **Step 5: Commit** ("Publish the report cube every sync").

---

### Task 8: addon store accessors

**Files:** Modify `src/utils/secrets.ts` (KEYS + accessors + imports), no dedicated test (house precedent: accessors are exercised through the page tests; KEYS entry is what puts them under `clearAll`).

**Interfaces:** Produces the five locked accessors. Consumes `parseReportCube`, `parseCustomReports`, `parseBudgetLayout`, the three key constants (`REPORT_CUBE_SECRET_KEY`; literals `'custom_reports'`, `'budget_layout'`).

- [ ] **Step 1:** Add `reportCube: REPORT_CUBE_SECRET_KEY, customReports: 'custom_reports', budgetLayout: 'budget_layout'` to KEYS (with the companion-published comment on `reportCube`), then the accessors: `getReportCube` → `parseReportCube(raw)`; `getCustomReports` → `parseCustomReports(raw)`; `setCustomReports` → `JSON.stringify`; `getBudgetLayout`/`setBudgetLayout` likewise. All get-paths `try/catch → null/[]`.
- [ ] **Step 2:** `npx tsc -p tsconfig.json --noEmit` clean; root suite still green.
- [ ] **Step 3: Commit** ("Add report cube, custom report, and layout store accessors").

---

### Task 9: `report-data.ts` — pure chart-data prep for all ten reports

**Files:** Create `src/components/budget/report-data.ts`, test `src/components/budget/report-data.test.ts`.

**Interfaces:** Consumes Task 1 selectors + `computeRunwayMonths` from `shared/pool.ts` + `computePoolStatus`. Produces the locked `report-data.ts` functions (all dollars-out for recharts, `MonthRow` shape).

- [ ] **Step 1: Failing tests** — use the Task 1 `CUBE` fixture; one focused test per function:
  - `cashFlowData`: `[{ month: '2026-07', income: 500, spending: 61, net: 439 }, …]`;
  - `savingsRateData`: Jul `(50000-6100)/50000 = 0.878`; Aug income 0 → `rate: null`;
  - `merchantTable(CUBE, 1)`: aggregates the last month, `trend` null with < 3 prior months;
  - `budgetVsActualData(CUBE, '2026-08')`: `[{ category: 'Dining', budget: 40, actual: 20 }, …]` sorted by overshoot;
  - `seasonalityGrid`: cells[ci][mi] in cents, dimensions match;
  - `runwayTrendData`: `liquid/ (trailing spend avg)` per month with nulls where liquid is null;
  - `poolBurndownData` with a pool fixture: `ideal` straight line from amount→0, `actual` = amount − cumulative daily;
  - `netWorthData`/`feesInterestData`/`categoryTrendData` shape checks.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** — each function 5–15 lines over the selectors; `runwayTrendData` uses up-to-3-month trailing spend mean ÷ into `computeRunwayMonths`.
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** ("Add pure chart-data preparation for the ten standard reports").

---

### Task 10: Budget tab shell — first tab, banner states, heroes + grid

**Files:** Modify `src/components/Tabs.tsx` (`TabId` gains `'budget'`), `src/pages/SyncPage.tsx` (tab list `[{id:'budget',label:'Budget'}, …]` first; default `activeTab` `'budget'`; load cube/customReports/layout in the refresh `Promise.all` with optional-calls; pass props; render `<BudgetTab …>` in a `TabPanel`), create `src/tabs/BudgetTab.tsx`, create `src/components/budget/ReportView.tsx` (stub for now: renders `<div data-report-id={id}>` + title; Tasks 11–12 fill it), test `src/tabs/BudgetTab.test.tsx`.

**Interfaces:** Consumes Tasks 1/3/8/9. Produces `BudgetTab` props: `{ cube: ReportCube | null; customReports: CustomReport[]; layout: BudgetLayout | null; onLayoutChange(next: BudgetLayout): void; onCustomReportsChange(next: CustomReport[]): void; store: SecretsStore }` and `ReportView` props `{ id: string; cube: ReportCube; customReports: CustomReport[]; full?: boolean }`.

- [ ] **Step 1: Failing tests** — SyncPage-level like OverviewTab tests; mock recharts once for the file:

```tsx
vi.mock('recharts', () => new Proxy({}, { get: () => (p: any) => <div>{p?.children ?? null}</div> }));
vi.mock('@wealthfolio/ui/chart', () => ({
  ChartContainer: (p: any) => <div>{p.children}</div>,
  ChartTooltip: () => null, ChartTooltipContent: () => null,
  ChartLegend: () => null, ChartLegendContent: () => null, ChartStyle: () => null,
}));
```

  - Budget is the first tab and the default: `render(<SyncPage {...makeProps()} />)` → `screen.getAllByRole('tab')[0]` has name /budget/i and `aria-selected="true"`.
  - No cube → one banner matching /reports need the companion/i and zero `[data-report-id]` nodes.
  - With `getReportCube` returning the CUBE fixture (pool null): heroes are cash-flow + category-trends (`data-report-id` order), grid holds the rest minus pool.
  - Stale cube (`asOf` 3 days old) → an /as of/i warning strip AND charts still present.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** `BudgetTab` computes `availableIds` (standard ids minus pool when `cube.pool` is null, plus `custom:` ids), `resolveBudgetLayout`, renders hero row (`.sfin-budget-heroes`, CSS grid `repeat(auto-fit,minmax(280px,1fr))`), stat chips (this-month spend from `monthlySpendTotals`, runway from `runwayTrendData` last value, savings rate last non-null), then the card grid. Banner logic before anything else: `!cube` → companion banner; `version` mismatch handled by `parseReportCube` (null → same banner + "or update" copy); stale check `Date.now() - Date.parse(asOf) > 2 days`.
- [ ] **Step 4: Verify pass** — plus the whole root suite (Tabs/SyncPage/Overview tests must survive the default-tab change: existing tests that assumed Overview-by-default need their expectations updated to click the Overview tab first — do that in this task, it is the deliberate behavior change).
- [ ] **Step 5: Commit** ("Make Budget the first tab, rendering heroes and grid from the cube").

---

### Task 11: `ReportView` — the ten standard reports rendered

**Files:** Rewrite `src/components/budget/ReportView.tsx`, test `src/components/budget/ReportView.test.tsx` (component-level with the recharts mocks from Task 10; assert against `report-data` outputs rendered into the DOM — e.g. the merchant table's rows, the seasonality grid's cell titles, empty-state copy).

**Interfaces:** Consumes Task 9 prep functions + `formatPoolLine` context is NOT reused (charts have their own captions). Produces: `ReportView` renders per id — recharts `LineChart`/`BarChart`/`AreaChart` inside `ChartContainer` for chart reports; plain-div heatmap; `<table>` inside `.sfin-scroll-x` for merchants. Per-report empty states exactly as spec §Empty ("nothing — as it should be" for all-zero fees; accruing copy for all-null net worth; gaps for null months via recharts `connectNulls={false}`).

- [ ] **Steps 1–5:** failing tests per report (10 small `it`s: given CUBE, the right rows/labels/empty copy appear), verify fail, implement one component per report inside the file (each 20–40 lines, a `switch` on id at the bottom), verify pass, commit ("Render the ten standard reports from the cube").

---

### Task 12: drill-in full-screen view + range control

**Files:** Modify `src/tabs/BudgetTab.tsx` (open-state: `useState<string | null>` of the drilled report id; full-screen overlay `.sfin-budget-full` with back button, range chips (6/12/24/all/pool) filtering the cube months via a `sliceCubeMonths(cube, n | 'all' | 'pool')` helper added to `shared/report-cube.ts` with its own test), test in `src/tabs/BudgetTab.test.tsx`.

**Interfaces:** Produces `sliceCubeMonths(cube: ReportCube, range: number | 'all' | 'pool'): ReportCube` (new export, Task 1's file — slices every month-indexed array; 'pool' → months intersecting the pool window, whole cube when no pool).

- [ ] **Steps:** failing tests (`sliceCubeMonths` unit tests in `shared/report-cube.test.ts` + UI: tapping a grid card shows the full-screen view with a back button; tapping a range chip re-renders with fewer months — assert via the cash-flow rows rendered), fail, implement, pass, commit ("Open any report full-screen with a shared range control").

---

### Task 13: customize mode

**Files:** Modify `src/tabs/BudgetTab.tsx`, test `src/tabs/BudgetTab.test.tsx`.

**Interfaces:** Consumes Task 3 mutations; persists via `onLayoutChange` → `store.setBudgetLayout` (wired in SyncPage in Task 10).

- [ ] **Steps:** failing tests — "Customize" button flips edit state; every card shows Pin/Up/Down/Hide buttons (role=button, accessible names include the report title, e.g. /pin cash flow/i); pinning a third hero bumps the oldest (assert new `data-report-id` order); hiding moves the card into a /hidden/i section with an Unhide button; every mutation calls `setBudgetLayout` with the value from the Task 3 helpers. Then fail → implement (buttons call `pinHero`/`moveCard`/`toggleHidden` and hand the result up) → pass → commit ("Let the user arrange the dashboard: pin, reorder, hide").

---

### Task 14: custom report builder

**Files:** Create `src/components/budget/ReportBuilder.tsx`, modify `src/tabs/BudgetTab.tsx` ("+ New report" card opens it; edit/duplicate/delete on `custom:` cards), test `src/components/budget/ReportBuilder.test.tsx`.

**Interfaces:** Consumes Task 2 (`CustomReport`, `evaluateCustomReport`, `newCustomReportId`) and Task 11's chart rendering for the live preview. Produces `<ReportBuilder cube existing={CustomReport | null} onSave(def) onCancel />`.

- [ ] **Steps:** failing tests — name input; chart select; range select; account chips; series list with "add series"; per-series term chips: a category select + sign toggle rendering "+ Dining", "− Rent"; live preview updates after adding a term (assert evaluated numbers in the preview table); Save calls `onSave` with a well-formed `CustomReport` (id from `newCustomReportId` for new, preserved for edits); saved report appears as a grid card; delete removes it; an unknown-category card shows the /unknown category/i chip. Fail → implement (controlled component over a `CustomReport` draft; preview = `evaluateCustomReport` straight into the Task 11 table renderer) → pass → commit ("Add the custom report builder with live preview").

---

### Task 15: release polish — changelog, version, full verify, package

**Files:** Modify `CHANGELOG.md` (a 1.29.0 section: Budget tab, ten reports, builder, customize, mobile; cube secret named for self-hosters), `package.json` + `manifest.json` + `shared/version.ts` → **1.29.0**.

- [ ] **Step 1:** Bump all three versions (`npm version 1.29.0 --no-git-tag-version` + sed the other two), write the changelog section.
- [ ] **Step 2:** Full verify: `npx tsc -p tsconfig.json --noEmit` && `npx vitest run` && `cd companion && npx vitest run` — all green, no skips.
- [ ] **Step 3:** `npm run build && npm run package` → `dist/simplefin-sync-1.29.0.zip` exists; check `dist/addon.js` size did not balloon (recharts must NOT be bundled — grep the bundle for `recharts` internals; it should only appear as an import specifier).
- [ ] **Step 4:** Commit ("Release v1.29.0: the Budget tab"). Tag/push only on the user's go.

---

## Self-review (done at write time)

- **Spec coverage:** cube contract → T1/T6/T7; ten reports → T9/T11 (+pool burn-down data T9, chart T11); builder → T2/T14; layout+customize → T3/T10/T13; drill-in+range → T12; mobile → global constraint + T10 CSS + T13 buttons; empty/error → T10 banners + T11 per-report; testing story → every task; valuation verification → T5 step 3; version/release → T15. No gaps found.
- **Placeholders:** none — every step names code or exact assertions.
- **Type consistency:** all cross-task names come from the locked section; `sliceCubeMonths` added there implicitly via Task 12 (single definition, single consumer).
