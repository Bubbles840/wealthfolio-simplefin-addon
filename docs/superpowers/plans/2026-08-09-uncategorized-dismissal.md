# Uncategorized Dismissal Implementation Plan (v1.10.1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user see which transactions need a category in the addon and dismiss individual ones, sharing one dismissal ledger with the existing Telegram buttons.

**Architecture:** The addon cannot see categories (the SDK exposes none), so the companion already publishes a count in `uncategorized_status`. That secret gains a capped `rows[]`. A new `shared/uncategorized.ts` holds the one definition of "still needs a category", imported by BOTH hosts so they cannot drift. The addon renders the rows under the existing tile and writes the same `uncategorized_dismissals` secret the Telegram buttons write. Spec: `docs/superpowers/specs/2026-08-09-uncategorized-dismissal-design.md` — read it first.

**Tech Stack:** React 18 + TypeScript, Vite, vitest + @testing-library/react (addon); Node/TypeScript (companion). All addon CSS lives in one template string: `ThemeStyles` in `src/components/ui.tsx`.

## Global Constraints

- **Zero sync-behavior change.** Nothing in `shared/sync-core.ts`, reconcile, drift, or the companion's import/alert logic. This feature only reads the database and writes two UI secrets.
- **Frozen strings (data contracts — never edit):** stored comment markers `Starting balance · `, `Balance adjustment · `, `↔️ In-transit transfer · `, ` · pending`; the Amazon comment format `· Amazon: <label> ·`; all existing secret keys **including `uncategorized_dismissals` and `uncategorized_status`**; log tags `duplicate-refused`, `duplicate-prune`.
- **One ledger, one definition.** The addon and the companion must both filter through the same `visibleUncategorized`. A second copy of that logic is the defect this feature exists to avoid.
- **`count` never lies.** `rows[]` is capped at 50; `count` always reports the true total after dismissal filtering.
- **Version skew must degrade, not crash.** A v1.10.1 addon reading a v1.10.0 secret (no `rows`) shows the tile with no list. A v1.10.0 addon reading a v1.10.1 secret ignores the extra field.
- **No test deleted or weakened.** Baselines: addon+shared **614 passing**, companion **159 passing**.
- **All addon CSS in `ThemeStyles`** (`src/components/ui.tsx`); components carry no `style={{…}}` layout props.
- **Copy policy:** sentence case, no "(optional)", no emoji in UI chrome. `src/pages/copy-policy.test.tsx` enforces it across all three tabs and SetupPage.
- **File size target:** no component file over ~400 lines. `OverviewTab.tsx` is already 407 — the list goes in its own file, not inline.
- **Version pinning:** `shared/version.test.ts` pins `manifest.json` + `package.json` to `SIMPLEFIN_SYNC_VERSION` — bump all three together (Task 6 only).
- Run addon/shared tests from repo root: `npx vitest run`. Companion: `cd companion && npx vitest run`. Typecheck BOTH: `npx tsc --noEmit -p .` and `npx tsc --noEmit -p companion`. Build: `npm run build`; package: `npm run package`.
- **Import extensions:** files under `shared/` and `companion/src/` are compiled by the companion's tsc with NodeNext resolution, so imports between them need `.js` extensions. `src/**` is bundled by Vite and imports `shared/` extensionless. Both are correct; do not "fix" either.

---

### Task 1: `shared/uncategorized.ts` — the single definition

Moves the ledger type and prune out of the companion into `shared/`, and adds the one filter both hosts will use.

**Files:**
- Create: `shared/uncategorized.ts`, `shared/uncategorized.test.ts`
- Modify: `companion/src/dismissals.ts` (re-export the moved names; keep `pollTelegramDismissals`)

**Interfaces:**
- Produces:
  - `export interface DismissalLedger { [activityId: string]: string }`
  - `export interface UncategorizedRow { activityId: string; date: string; amountCents: number; description: string; accountName: string }`
  - `export const DISMISSAL_MAX_AGE_DAYS = 60;`
  - `export function pruneDismissals(ledger: DismissalLedger, now: Date): DismissalLedger`
  - `export function visibleUncategorized<T extends { activityId: string }>(rows: T[], ledger: DismissalLedger): T[]`
  - `export const UNCATEGORIZED_ROWS_CAP = 50;`
- `companion/src/dismissals.ts` re-exports `DismissalLedger` and `pruneDismissals` from the new module so its existing importers (`companion/src/index.ts`) keep one import site.

- [ ] **Step 1: Write the failing tests**

```ts
// shared/uncategorized.test.ts
import { describe, it, expect } from 'vitest';
import {
  pruneDismissals, visibleUncategorized, DISMISSAL_MAX_AGE_DAYS, UNCATEGORIZED_ROWS_CAP,
  type DismissalLedger, type UncategorizedRow,
} from './uncategorized.js';

const row = (over: Partial<UncategorizedRow> = {}): UncategorizedRow => ({
  activityId: 'act-1',
  date: '2026-08-01',
  amountCents: 7000,
  description: 'Thankyou Points Redeemed',
  accountName: 'Citi Double Cash',
  ...over,
});

describe('visibleUncategorized', () => {
  it('hides rows the user dismissed and keeps the rest', () => {
    // THE definition of "still needs a category". Both hosts call this — the
    // companion to size its count, the addon to render its list — so a second
    // copy of this rule is how the tile and the list start disagreeing.
    const rows = [row({ activityId: 'a' }), row({ activityId: 'b' }), row({ activityId: 'c' })];
    const ledger: DismissalLedger = { b: '2026-08-01T00:00:00.000Z' };
    expect(visibleUncategorized(rows, ledger).map((r) => r.activityId)).toEqual(['a', 'c']);
  });

  it('ignores ledger entries for rows that are not present', () => {
    // A dismissal outlives its row by design (60 days vs a 90-day window), so
    // stale entries are normal, not a bug to guard against.
    const rows = [row({ activityId: 'a' })];
    expect(visibleUncategorized(rows, { zzz: '2026-01-01T00:00:00.000Z' })).toHaveLength(1);
  });

  it('is a no-op for an empty ledger', () => {
    const rows = [row({ activityId: 'a' }), row({ activityId: 'b' })];
    expect(visibleUncategorized(rows, {})).toHaveLength(2);
  });

  it('does not mutate its inputs', () => {
    // The addon calls this on every render against state it also holds.
    const rows = [row({ activityId: 'a' }), row({ activityId: 'b' })];
    const ledger: DismissalLedger = { a: '2026-08-01T00:00:00.000Z' };
    visibleUncategorized(rows, ledger);
    expect(rows).toHaveLength(2);
    expect(Object.keys(ledger)).toEqual(['a']);
  });
});

describe('pruneDismissals', () => {
  it('drops entries past the retention window and keeps fresh ones', () => {
    const now = new Date('2026-08-09T12:00:00.000Z');
    const old = new Date(now.getTime() - (DISMISSAL_MAX_AGE_DAYS + 1) * 86400_000).toISOString();
    const fresh = new Date(now.getTime() - 5 * 86400_000).toISOString();
    expect(pruneDismissals({ stale: old, keep: fresh }, now)).toEqual({ keep: fresh });
  });

  it('drops an unparseable timestamp rather than keeping it forever', () => {
    const now = new Date('2026-08-09T12:00:00.000Z');
    expect(pruneDismissals({ bad: 'not a date' }, now)).toEqual({});
  });
});

describe('UNCATEGORIZED_ROWS_CAP', () => {
  it('is 50 — the published list is capped while the count stays true', () => {
    expect(UNCATEGORIZED_ROWS_CAP).toBe(50);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run shared/uncategorized.test.ts` → FAIL (cannot resolve `./uncategorized.js`).

- [ ] **Step 3: Implement**

```ts
// shared/uncategorized.ts  (whole file)
/**
 * What "still needs a category" means — defined ONCE, for both syncers.
 *
 * The companion sizes its published count with this; the addon renders its list
 * with it. They must agree, because they are answering the same question in two
 * places, and during the v1.10.0 work three separate bugs came from exactly that
 * shape of duplication (a diagnostic that classified messages differently from
 * the poll; a tile that ignored the dismissals the sweep honoured; a check
 * script that disagreed with the sync). One function, imported twice.
 */

/** Dismissed activity id → when it was dismissed (ISO). */
export interface DismissalLedger {
  [activityId: string]: string;
}

/** One uncategorized transaction, as published for the addon to render. */
export interface UncategorizedRow {
  activityId: string;
  /** ISO date (yyyy-mm-dd). */
  date: string;
  /** Magnitude in cents — sign is not meaningful here. */
  amountCents: number;
  /** Display text, already stripped of bookkeeping decorations. */
  description: string;
  accountName: string;
}

/**
 * How long a dismissal is kept.
 *
 * A dismissed row leaves the sweep window weeks before this, so entries only
 * need to outlive the window, not the account — otherwise the secret grows
 * forever.
 */
export const DISMISSAL_MAX_AGE_DAYS = 60;

/**
 * How many rows the companion publishes.
 *
 * The list is capped and the COUNT is not: a truncated list must never make the
 * tile understate the real backlog.
 */
export const UNCATEGORIZED_ROWS_CAP = 50;

/** Drop ledger entries old enough to be inert. An unparseable timestamp is
 *  dropped rather than kept forever — it can never be compared against. */
export function pruneDismissals(ledger: DismissalLedger, now: Date): DismissalLedger {
  const cutoff = now.getTime() - DISMISSAL_MAX_AGE_DAYS * 86400_000;
  const pruned: DismissalLedger = {};
  for (const [id, at] of Object.entries(ledger)) {
    const t = Date.parse(at);
    if (Number.isFinite(t) && t >= cutoff) pruned[id] = at;
  }
  return pruned;
}

/**
 * The rows that still need a category: everything not dismissed.
 *
 * Generic over the row shape so the companion can pass its richer native row and
 * the addon its published one, without either converting first.
 */
export function visibleUncategorized<T extends { activityId: string }>(
  rows: T[],
  ledger: DismissalLedger,
): T[] {
  return rows.filter((r) => !(r.activityId in ledger));
}
```

Then in `companion/src/dismissals.ts`: DELETE the local `DismissalLedger` interface, the local `DISMISSAL_MAX_AGE_DAYS`, and the local `pruneDismissals` body, and replace them with a re-export so existing importers are unaffected:

```ts
import { pruneDismissals, type DismissalLedger } from '../../shared/uncategorized.js';

// Re-exported so this module stays the one import site for the Telegram half of
// dismissals, even though the ledger's shape and retention now live in shared/
// (the addon needs them too, and two copies would drift).
export { pruneDismissals };
export type { DismissalLedger };
```

Keep `pollTelegramDismissals` here unchanged — it is Telegram-transport-specific and does not belong in `shared/`.

- [ ] **Step 4: Verify** — `npx vitest run shared/uncategorized.test.ts` → PASS; `cd companion && npx vitest run` → 159 pass (the moved `pruneDismissals` tests still cover it through the re-export); `npx tsc --noEmit -p .` and `npx tsc --noEmit -p companion` clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Define 'still needs a category' once, in shared/"
```

---

### Task 2: The companion publishes `rows[]`

**Files:**
- Modify: `companion/src/uncategorized-status.ts`, `companion/src/uncategorized-status.test.ts`
- Modify: `companion/src/index.ts` (the publish call site — grep `publishUncategorizedStatusForDbPath`)

**Interfaces:**
- Consumes: `visibleUncategorized`, `UNCATEGORIZED_ROWS_CAP`, `UncategorizedRow`, `DismissalLedger` from `../../shared/uncategorized.js`; `getNativeUncategorizedSpending(dbPath, startInclusive, endExclusive)` from `./sqlite-native.js`, which returns `NativeUncategorizedTx[]` where each row is `{ activityId, wfAccountId, notes, amountCents, date, accountName }` and `notes` is the RAW stored note (`<description> · <txId>[ · pending]`); `descriptionFromComment` from `../../shared/sync-core.js`.
- Produces: the published secret becomes `{ count: number; asOf: string; rows: UncategorizedRow[] }`. `publishUncategorizedStatusForDbPath` gains a `readLedger: () => Promise<DismissalLedger>` parameter.

- [ ] **Step 1: Write the failing tests** (append to `companion/src/uncategorized-status.test.ts`)

```ts
describe('publishing the row list', () => {
  const native = (id: string, over: Record<string, unknown> = {}) => ({
    activityId: id,
    wfAccountId: 'wf-a',
    notes: `THANKYOU POINTS REDEEMED · TRN-${id}`,
    amountCents: 7000,
    date: '2026-08-01',
    accountName: 'Citi Double Cash',
    ...over,
  });

  it('publishes a display-ready row per uncategorized transaction', async () => {
    // The addon cannot compute this list — the SDK exposes no category data — so
    // whatever is published here is all it will ever know.
    const writes: Record<string, string> = {};
    await publishUncategorizedStatus(
      async (k, v) => { writes[k] = v; },
      () => [native('a')],
      async () => ({}),
      new Date('2026-08-09T12:00:00.000Z'),
    );
    const payload = JSON.parse(writes['uncategorized_status']);
    expect(payload.count).toBe(1);
    expect(payload.rows).toEqual([{
      activityId: 'a',
      date: '2026-08-01',
      amountCents: 7000,
      // The stored note's ` · TRN-…` bookkeeping suffix is stripped: the addon
      // renders this verbatim and must not show an internal id.
      description: 'THANKYOU POINTS REDEEMED',
      accountName: 'Citi Double Cash',
    }]);
  });

  it('excludes dismissed rows from BOTH the count and the list', async () => {
    // The tile and the list are the same number seen two ways. Filtering one and
    // not the other is the bug this feature was built to remove.
    const writes: Record<string, string> = {};
    await publishUncategorizedStatus(
      async (k, v) => { writes[k] = v; },
      () => [native('a'), native('b'), native('c')],
      async () => ({ b: '2026-08-01T00:00:00.000Z' }),
      new Date('2026-08-09T12:00:00.000Z'),
    );
    const payload = JSON.parse(writes['uncategorized_status']);
    expect(payload.count).toBe(2);
    expect(payload.rows.map((r: any) => r.activityId)).toEqual(['a', 'c']);
  });

  it('caps the list at 50 while the count keeps reporting the truth', async () => {
    // A truncated list must not make the tile understate the backlog.
    const writes: Record<string, string> = {};
    const many = Array.from({ length: 63 }, (_, i) => native(`a${i}`));
    await publishUncategorizedStatus(
      async (k, v) => { writes[k] = v; },
      () => many,
      async () => ({}),
      new Date('2026-08-09T12:00:00.000Z'),
    );
    const payload = JSON.parse(writes['uncategorized_status']);
    expect(payload.count).toBe(63);
    expect(payload.rows).toHaveLength(50);
  });

  it('still never throws when reading the ledger fails', async () => {
    // A stats tile must not be able to fail a sync; a hidden or stale tile is
    // also its off state, so swallowing degrades to the correct thing.
    await expect(publishUncategorizedStatus(
      async () => {},
      () => [native('a')],
      async () => { throw new Error('secret unreadable'); },
    )).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd companion && npx vitest run src/uncategorized-status.test.ts` → FAIL (`publishUncategorizedStatus` takes a count function, not a rows function; no `rows` in the payload).

- [ ] **Step 3: Implement.** Change `publishUncategorizedStatus`'s second parameter from `readCount: () => number` to `readRows: () => Array<{ activityId: string; notes: string; amountCents: number; date: string; accountName: string }>`, add a third parameter `readLedger: () => Promise<DismissalLedger>`, and move `now` to fourth. Inside the existing `try`:

```ts
    const ledger = await readLedger();
    const visible = visibleUncategorized(readRows(), ledger);
    const status = {
      count: visible.length,
      asOf: now.toISOString(),
      // Capped: see UNCATEGORIZED_ROWS_CAP. `count` above is the true total, so
      // truncating here cannot make the tile understate the backlog.
      rows: visible.slice(0, UNCATEGORIZED_ROWS_CAP).map((r) => ({
        activityId: r.activityId,
        date: r.date,
        amountCents: r.amountCents,
        // The stored note carries ` · <txId>` and possibly ` · pending`; the
        // addon renders this string, so strip the bookkeeping first.
        description: descriptionFromComment(r.notes) || r.notes,
        accountName: r.accountName,
      })),
    };
    await setSecret(UNCATEGORIZED_STATUS_SECRET_KEY, JSON.stringify(status));
```

Update `publishUncategorizedStatusForDbPath` to take and forward `readLedger`, and to pass `getNativeUncategorizedSpending(dbPath, start, end)` (the array, not `.length`).

At the call site in `companion/src/index.ts`, supply the ledger reader using the same secret the Telegram half uses:

```ts
    () => getNativeUncategorizedSpending(dbPathForStatus, start, end),
    async () => parseSecretJson<DismissalLedger>(
      await wfClient.getAddonSecret('simplefin-sync', 'uncategorized_dismissals'),
      'uncategorized_dismissals',
    ) ?? {},
```

(Match the exact `parseSecretJson` signature already used for `uncategorized_dismissals` further down that file — grep it and copy the call shape rather than inventing one.)

- [ ] **Step 4: Verify** — `cd companion && npx vitest run` (all pass, 159 + 4 new), `npx tsc --noEmit -p companion` clean, and from the repo root `npx vitest run` (614 — the addon is untouched so far).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Publish the uncategorized rows, filtered by the shared dismissal ledger"
```

---

### Task 3: Addon reads `rows[]` and the ledger

**Files:**
- Modify: `src/utils/secrets.ts`, `src/utils/secrets.test.ts`

**Interfaces:**
- Consumes: `DismissalLedger`, `UncategorizedRow` from `../../shared/uncategorized` (extensionless — Vite).
- Produces:
  - `getUncategorizedStatus(): Promise<{ count: number; asOf: string; rows: UncategorizedRow[] } | null>` — `rows` defaults to `[]` when the field is absent (a v1.10.0 companion), so the tile still renders with no list.
  - `getDismissals(): Promise<DismissalLedger>` — absent/malformed → `{}`.
  - `setDismissals(ledger: DismissalLedger): Promise<void>` — writes the SAME `uncategorized_dismissals` key the companion reads. Add `dismissals: 'uncategorized_dismissals'` to the `KEYS` map so `clearAll()` covers it (the map is what `clearAll` iterates; three secrets were previously missed exactly this way).

- [ ] **Step 1: Write the failing tests** (append to `src/utils/secrets.test.ts`, reusing its existing `makeCtx` helper)

```ts
describe('uncategorized rows and dismissals', () => {
  const row = { activityId: 'a', date: '2026-08-01', amountCents: 7000,
    description: 'Thankyou Points Redeemed', accountName: 'Citi Double Cash' };

  it('reads the published rows', async () => {
    const { ctx, data } = makeCtx();
    data['uncategorized_status'] = JSON.stringify({ count: 1, asOf: 'x', rows: [row] });
    const store = new SecretsStore(ctx);
    expect((await store.getUncategorizedStatus())?.rows).toEqual([row]);
  });

  it('treats a companion that publishes no rows as an empty list, not a failure', async () => {
    // Version skew: a v1.10.0 companion publishes only count+asOf. The tile must
    // still render; only the list is absent.
    const { ctx, data } = makeCtx();
    data['uncategorized_status'] = JSON.stringify({ count: 3, asOf: 'x' });
    const store = new SecretsStore(ctx);
    const status = await store.getUncategorizedStatus();
    expect(status?.count).toBe(3);
    expect(status?.rows).toEqual([]);
  });

  it('ignores a rows field that is not an array', async () => {
    const { ctx, data } = makeCtx();
    data['uncategorized_status'] = JSON.stringify({ count: 1, asOf: 'x', rows: 'nope' });
    const store = new SecretsStore(ctx);
    expect((await store.getUncategorizedStatus())?.rows).toEqual([]);
  });

  it('round-trips the dismissal ledger through the SAME key the companion reads', async () => {
    const { ctx, data } = makeCtx();
    const store = new SecretsStore(ctx);
    expect(await store.getDismissals()).toEqual({});
    await store.setDismissals({ a: '2026-08-09T00:00:00.000Z' });
    // Asserted on the raw key, not just the round trip: a typo here means the
    // addon and the companion keep separate ledgers and neither notices.
    expect(JSON.parse(data['uncategorized_dismissals'])).toEqual({ a: '2026-08-09T00:00:00.000Z' });
    expect(await store.getDismissals()).toEqual({ a: '2026-08-09T00:00:00.000Z' });
  });

  it('reads a corrupt ledger as empty rather than throwing', async () => {
    const { ctx, data } = makeCtx();
    data['uncategorized_dismissals'] = 'not json{';
    const store = new SecretsStore(ctx);
    expect(await store.getDismissals()).toEqual({});
  });

  it('clearAll deletes the dismissal ledger', async () => {
    // clearAll iterates the KEYS map; three secrets were previously absent from
    // it and survived a reset that claimed to clear everything.
    const { ctx, data } = makeCtx();
    const store = new SecretsStore(ctx);
    await store.setDismissals({ a: '2026-08-09T00:00:00.000Z' });
    await store.clearAll();
    expect(data['uncategorized_dismissals']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/utils/secrets.test.ts` → FAIL (`getDismissals is not a function`).

- [ ] **Step 3: Implement.** Add `dismissals: 'uncategorized_dismissals',` to `KEYS`. Extend `getUncategorizedStatus`'s return to include `rows`, defaulting defensively:

```ts
      return typeof parsed?.count === 'number' && Number.isFinite(parsed.count)
        ? {
            count: parsed.count,
            asOf: String(parsed.asOf ?? ''),
            // Absent on a v1.10.0 companion — an empty list, not a failure. The
            // tile renders from `count`; only the disclosure needs `rows`.
            rows: Array.isArray(parsed.rows) ? (parsed.rows as UncategorizedRow[]) : [],
          }
        : null;
```

And add, following the file's established accessor pattern:

```ts
  /** Transactions the user has chosen to leave uncategorized. The SAME secret
   *  the Telegram dismiss buttons write and the companion sweep filters on —
   *  two ledgers answering one question is the defect this shares it to avoid. */
  async getDismissals(): Promise<DismissalLedger> {
    const raw = await this.ctx.api.secrets.get(KEYS.dismissals);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  async setDismissals(ledger: DismissalLedger): Promise<void> {
    await this.ctx.api.secrets.set(KEYS.dismissals, JSON.stringify(ledger));
  }
```

- [ ] **Step 4: Verify** — `npx vitest run` (all pass), `npx tsc --noEmit -p .` clean.
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Read the published rows and the shared dismissal ledger in the addon"
```

---

### Task 4: `UncategorizedList` component

**Files:**
- Create: `src/components/UncategorizedList.tsx`, `src/components/UncategorizedList.test.tsx`
- Modify: `src/components/ui.tsx` (CSS only, inside `ThemeStyles`)

**Interfaces:**
- Consumes: `UncategorizedRow` from `../../shared/uncategorized`; `Disclosure` and `Button` from `./ui`.
- Produces:
  ```tsx
  export function UncategorizedList(props: {
    rows: UncategorizedRow[];          // ALREADY filtered by the caller
    total: number;                     // the true count, may exceed rows.length
    id: string;                        // disclosure id for open-state persistence
    open: boolean;
    onToggle: () => void;
    onDismiss: (activityId: string) => void;
    justDismissed: string | null;      // shows the undo affordance when set
    onUndo: () => void;
  }): React.ReactElement | null;
  ```
  Renders `null` when `rows.length === 0` — NOT when `total === 0`. With a v1.10.0 companion the count is non-zero while `rows` is empty, and gating on `total` would render a disclosure that opens to nothing. CSS classes: `.sfin-uncat-row`, `.sfin-uncat-when`, `.sfin-uncat-what`, `.sfin-uncat-amt`, `.sfin-uncat-undo`.

- [ ] **Step 1: Write the failing tests**

```tsx
// src/components/UncategorizedList.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { UncategorizedList } from './UncategorizedList';
import type { UncategorizedRow } from '../../shared/uncategorized';

const row = (over: Partial<UncategorizedRow> = {}): UncategorizedRow => ({
  activityId: 'a', date: '2026-08-01', amountCents: 7000,
  description: 'Thankyou Points Redeemed', accountName: 'Citi Double Cash', ...over,
});

const base = {
  rows: [row()], total: 1, id: 'uncat', open: true,
  onToggle: vi.fn(), onDismiss: vi.fn(), justDismissed: null, onUndo: vi.fn(),
};

describe('UncategorizedList', () => {
  it('shows each transaction with what a person needs to recognise it', () => {
    render(<UncategorizedList {...base} />);
    expect(screen.getByText(/Thankyou Points Redeemed/)).toBeTruthy();
    expect(screen.getByText(/Citi Double Cash/)).toBeTruthy();
    expect(screen.getByText('$70.00')).toBeTruthy();
    expect(screen.getByText('2026-08-01')).toBeTruthy();
  });

  it('renders nothing at all when nothing needs a category', () => {
    const { container } = render(<UncategorizedList {...base} rows={[]} total={0} />);
    expect(container.textContent).toBe('');
  });

  it('renders nothing when there are no rows even if the count is non-zero', () => {
    // Version skew: a v1.10.0 companion publishes a count and no rows. Gating on
    // `total` would open a disclosure onto an empty panel; the tile alone carries
    // the number in that case.
    const { container } = render(<UncategorizedList {...base} rows={[]} total={3} />);
    expect(container.textContent).toBe('');
  });

  it('dismissing reports the id up rather than hiding locally', () => {
    // The parent owns the ledger and the count, so a component that hid its own
    // row would leave the tile disagreeing with the list.
    const onDismiss = vi.fn();
    render(<UncategorizedList {...base} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledWith('a');
  });

  it('offers undo after a dismissal, and reports that up too', () => {
    // Without this a misclick silently hides a transaction for 60 days.
    const onUndo = vi.fn();
    render(<UncategorizedList {...base} justDismissed="a" onUndo={onUndo} />);
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    expect(onUndo).toHaveBeenCalled();
  });

  it('says when the list is shorter than the count, so a cap cannot mislead', () => {
    // The published list is capped; the total is not. Showing 50 rows under a
    // heading that says 63 without explanation would read as a bug.
    render(<UncategorizedList {...base} rows={[row(), row({ activityId: 'b' })]} total={63} />);
    expect(screen.getByText(/showing 2 of 63/i)).toBeTruthy();
  });

  it('summarises the count in its header', () => {
    render(<UncategorizedList {...base} rows={[row(), row({ activityId: 'b' })]} total={2} open={false} />);
    expect(screen.getByText(/2 need a category/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/components/UncategorizedList.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Implement**

```tsx
// src/components/UncategorizedList.tsx  (whole file)
import React from 'react';
import { Button, Disclosure } from './ui';
import type { UncategorizedRow } from '../../shared/uncategorized';

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    .format(cents / 100);
}

/**
 * The transactions behind the "Needs a category" tile, and a way to stop caring
 * about one.
 *
 * Purely presentational: the parent owns the ledger, the optimistic count and the
 * undo window. A row that hid itself would leave the tile disagreeing with the
 * list — the same class of split this feature exists to close.
 *
 * Its own file rather than more of OverviewTab, which is already at the 400-line
 * size target.
 */
export function UncategorizedList({
  rows, total, id, open, onToggle, onDismiss, justDismissed, onUndo,
}: {
  rows: UncategorizedRow[];
  total: number;
  id: string;
  open: boolean;
  onToggle: () => void;
  onDismiss: (activityId: string) => void;
  justDismissed: string | null;
  onUndo: () => void;
}) {
  // Gated on ROWS, not on `total`: a v1.10.0 companion publishes a count with no
  // rows, and a disclosure that opens onto nothing is worse than no disclosure.
  if (rows.length === 0) return null;
  return (
    <div className="sfin-disc-inset">
      <Disclosure
        id={id}
        variant="inline"
        title={`${total} need${total === 1 ? 's' : ''} a category`}
        open={open}
        onToggle={onToggle}
      >
        {justDismissed && (
          <div className="sfin-uncat-undo" role="status">
            <span className="sfin-subtle">Dismissed.</span>
            <Button variant="ghost" onClick={onUndo}>Undo</Button>
          </div>
        )}
        {rows.map((r) => (
          <div className="sfin-uncat-row" key={r.activityId}>
            <span className="sfin-uncat-when">{r.date}</span>
            <span className="sfin-uncat-what">
              {r.description}
              <span className="sfin-subtle"> · {r.accountName}</span>
            </span>
            <span className="sfin-uncat-amt">{money(r.amountCents)}</span>
            <Button
              variant="ghost"
              onClick={() => onDismiss(r.activityId)}
              title="Stop counting this transaction as needing a category"
            >
              Dismiss
            </Button>
          </div>
        ))}
        {rows.length < total && (
          <div className="sfin-subtle">
            Showing {rows.length} of {total}. Categorize or dismiss some to see the rest.
          </div>
        )}
      </Disclosure>
    </div>
  );
}
```

CSS to append inside the `ThemeStyles` template string in `src/components/ui.tsx`, near the other row/list rules:

```css
.sfin-uncat-row {
  display: flex; align-items: center; gap: 10px; padding: 5px 0;
  border-top: 1px solid color-mix(in srgb, var(--muted-foreground) 14%, transparent);
}
.sfin-uncat-row:first-of-type { border-top: none; }
.sfin-uncat-when { flex: none; font-size: 11px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.sfin-uncat-what { flex: 1; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sfin-uncat-amt { flex: none; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.sfin-uncat-undo { display: flex; align-items: center; gap: 8px; padding: 4px 0 8px; }
```

- [ ] **Step 4: Verify** — `npx vitest run src/components/UncategorizedList.test.tsx` → PASS; `npx vitest run` → all pass; `npx tsc --noEmit -p .` clean.
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Add the uncategorized list with per-row dismiss and undo"
```

---

### Task 5: Wire it into Overview

**Files:**
- Modify: `src/tabs/OverviewTab.tsx`, `src/tabs/OverviewTab.test.tsx`
- Modify: `src/pages/SyncPage.tsx` (pass the dismissal state down, and refresh it with the rest)

**Interfaces:**
- Consumes: `UncategorizedList` from `../components/UncategorizedList`; `visibleUncategorized` from `../../shared/uncategorized`; `store.getDismissals()` / `setDismissals()`.
- Produces: no new exports. `OverviewTab` gains props `dismissals: DismissalLedger` and `onDismissalsChange: (next: DismissalLedger) => void`.

**Where the state lives:** in the SHELL (`SyncPage.tsx`), not the tab. Inactive tabs unmount, and a dismissal made on Overview must survive a trip to Advanced and back — the same reason the Telegram and Amazon drafts were hoisted during the v1.10.0 work. Load it in the existing mount `Promise.all` and refresh it inside `refreshDerivedSignals` alongside `getUncategorizedStatus`, so the list and the count never come from different moments.

- [ ] **Step 1: Write the failing tests** (append to `src/tabs/OverviewTab.test.tsx`; it renders `<SyncPage/>` — keep that)

```tsx
describe('uncategorized list', () => {
  const statusWith = (rows: any[], count = rows.length) => ({
    count, asOf: '2026-08-09T12:00:00.000Z', rows,
  });
  const r = (id: string, over: any = {}) => ({
    activityId: id, date: '2026-08-01', amountCents: 7000,
    description: `Row ${id}`, accountName: 'Citi Double Cash', ...over,
  });

  it('lists the published rows under the tile', async () => {
    const props = makeProps();
    props.store.getUncategorizedStatus = vi.fn(async () => statusWith([r('a'), r('b')])) as any;
    render(<SyncPage {...props} />);
    expect(await screen.findByText(/2 need a category/i)).toBeTruthy();
  });

  it('dismissing hides the row and drops the tile in the same tick', async () => {
    // The whole point of holding both numbers in the addon: waiting for the
    // companion's next publish would leave the button looking broken for an hour.
    const props = makeProps();
    let saved: any = {};
    props.store.getUncategorizedStatus = vi.fn(async () => statusWith([r('a'), r('b')])) as any;
    props.store.getDismissals = vi.fn(async () => saved) as any;
    props.store.setDismissals = vi.fn(async (l: any) => { saved = l; }) as any;
    render(<SyncPage {...props} />);

    fireEvent.click(await screen.findByRole('button', { name: /^2 need/i }));
    const dismissButtons = await screen.findAllByRole('button', { name: /dismiss/i });
    fireEvent.click(dismissButtons[0]);

    await waitFor(() => expect(props.store.setDismissals).toHaveBeenCalled());
    expect(screen.queryByText('Row a')).toBeNull();
    const tile = (await screen.findByText(/Needs a category/i)).closest('.sfin-tile');
    expect(tile?.textContent).toContain('1');
  });

  it('undo puts the row back and restores the count', async () => {
    const props = makeProps();
    let saved: any = {};
    props.store.getUncategorizedStatus = vi.fn(async () => statusWith([r('a')])) as any;
    props.store.getDismissals = vi.fn(async () => saved) as any;
    props.store.setDismissals = vi.fn(async (l: any) => { saved = l; }) as any;
    render(<SyncPage {...props} />);

    fireEvent.click(await screen.findByRole('button', { name: /^1 needs/i }));
    fireEvent.click(await screen.findByRole('button', { name: /dismiss/i }));
    await screen.findByText(/Dismissed\./i);
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));

    expect(await screen.findByText('Row a')).toBeTruthy();
    const tile = (await screen.findByText(/Needs a category/i)).closest('.sfin-tile');
    expect(tile?.textContent).toContain('1');
  });

  it('a dismissal survives switching tabs and coming back', async () => {
    // Inactive tabs unmount. State kept in the tab would resurrect the row.
    const props = makeProps();
    let saved: any = {};
    props.store.getUncategorizedStatus = vi.fn(async () => statusWith([r('a'), r('b')])) as any;
    props.store.getDismissals = vi.fn(async () => saved) as any;
    props.store.setDismissals = vi.fn(async (l: any) => { saved = l; }) as any;
    render(<SyncPage {...props} />);

    fireEvent.click(await screen.findByRole('button', { name: /^2 need/i }));
    fireEvent.click((await screen.findAllByRole('button', { name: /dismiss/i }))[0]);
    await waitFor(() => expect(props.store.setDismissals).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('tab', { name: /advanced/i }));
    fireEvent.click(screen.getByRole('tab', { name: /overview/i }));

    const tile = (await screen.findByText(/Needs a category/i)).closest('.sfin-tile');
    expect(tile?.textContent).toContain('1');
  });

  it('shows the tile with no list when the companion published no rows', async () => {
    // Version skew against a v1.10.0 companion.
    const props = makeProps();
    props.store.getUncategorizedStatus = vi.fn(async () => (
      { count: 3, asOf: '2026-08-09T12:00:00.000Z', rows: [] }
    )) as any;
    render(<SyncPage {...props} />);
    const tile = (await screen.findByText(/Needs a category/i)).closest('.sfin-tile');
    expect(tile?.textContent).toContain('3');
    expect(screen.queryByText(/need a category$/i)).toBeNull();
  });
});
```

Also add `getDismissals: vi.fn(async () => ({}))` and `setDismissals: vi.fn(async () => {})` to the shared store mock in `src/pages/test-props.ts`.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/tabs/OverviewTab.test.tsx` → FAIL (no list rendered).

- [ ] **Step 3: Implement.** In `SyncPage.tsx`: add `const [dismissals, setDismissals] = useState<DismissalLedger>({})`, load it in the mount `Promise.all` via `store.getDismissals()`, refresh it in `refreshDerivedSignals` next to `getUncategorizedStatus`, and pass `dismissals` plus an `onDismissalsChange` that sets state and persists:

```tsx
  const onDismissalsChange = useCallback((next: DismissalLedger) => {
    setDismissals(next);
    // Pruned on write so the secret cannot grow without bound; the companion
    // prunes on its own schedule too and the two agree because both use the
    // shared helper.
    store.setDismissals(pruneDismissals(next, new Date())).catch(() => {});
  }, [store]);
```

In `OverviewTab.tsx`: keep the tile reading a count that now subtracts dismissals, and render the list beneath the tiles.

```tsx
  const visibleRows = uncategorized
    ? visibleUncategorized(uncategorized.rows, dismissals)
    : [];
  // The tile subtracts locally-known dismissals so it can never disagree with
  // the list under it. `count` is the companion's true total; dismissals made
  // since its last publish are not in it yet.
  const uncatCount = uncategorized
    ? Math.max(0, uncategorized.count - Object.keys(dismissals)
        .filter((id) => uncategorized.rows.some((r) => r.activityId === id)).length)
    : 0;
```

Use `uncatCount` in the tile instead of `uncategorized.count`, then after the `.sfin-strip` div:

```tsx
      {uncategorized && (
        <UncategorizedList
          rows={visibleRows}
          total={uncatCount}
          id={CARD.uncategorized}
          open={isOpen(CARD.uncategorized)}
          onToggle={() => toggleCard(CARD.uncategorized)}
          onDismiss={(activityId) => {
            onDismissalsChange({ ...dismissals, [activityId]: new Date().toISOString() });
            setJustDismissed(activityId);
            window.setTimeout(() => setJustDismissed((cur) => (cur === activityId ? null : cur)), 6000);
          }}
          justDismissed={justDismissed}
          onUndo={() => {
            if (!justDismissed) return;
            const next = { ...dismissals };
            delete next[justDismissed];
            onDismissalsChange(next);
            setJustDismissed(null);
          }}
        />
      )}
```

with `const [justDismissed, setJustDismissed] = useState<string | null>(null);` local to the tab (a 6-second toast need not survive a tab switch) and a new `uncategorized: 'uncategorized-list'` entry in the `CARD` id map.

- [ ] **Step 4: Verify** — `npx vitest run` (all pass), `npx tsc --noEmit -p .` clean, `npm run build` clean, and `wc -l src/tabs/OverviewTab.tsx` (report it; if it passes ~430, move the dismiss/undo handlers into a small `useDismissals` hook in `UncategorizedList.tsx` rather than letting the tab grow).
- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Show the uncategorized list on Overview with optimistic dismiss"
```

---

### Task 6: Version 1.10.1, changelog, full verification

**Files:**
- Modify: `manifest.json`, `package.json`, `shared/version.ts` (all three `1.10.0` → `1.10.1`), `CHANGELOG.md`

- [ ] **Step 1: Bump** all three version carriers. `shared/version.test.ts` pins them together.

- [ ] **Step 2: CHANGELOG** — insert a new `## [1.10.1] - 2026-08-09` between `## [Unreleased]` and `## [1.10.0]`:

```markdown
### Added

- **You can now see and dismiss what needs a category.** The Overview tile
  reported a number with nothing to act on, so a transaction you had
  deliberately decided to leave uncategorized counted forever. The tile now opens
  into the actual transactions — date, description, amount, account — each with a
  dismiss control, and dismissing takes effect immediately rather than waiting up
  to an hour for the companion's next sync. A short undo window follows each
  dismissal, because without one a misclick silently hides a transaction for 60
  days.

  Dismissals share the same ledger the Telegram notice's buttons already wrote,
  so a dismissal holds in both places. Behaviour matches what Telegram already
  did: keyed by transaction, kept 60 days.

### Fixed

- **The needs-a-category tile ignored dismissals.** The Telegram sweep filtered
  them out; the tile did not, so a transaction dismissed from Telegram still
  counted. Harmless while nobody used those buttons, and the exact reason the
  addon's own dismiss button had to come with this fix rather than after it.
- **A reset left the dismissal ledger behind.** `uncategorized_dismissals` was
  not registered in the map `clearAll()` iterates, so it survived a reset that
  said it cleared everything — the same gap that previously left an Amazon
  mailbox password in storage.
```

- [ ] **Step 3: Full verification** — from the repo root: `npx vitest run`, `cd companion && npx vitest run`, `npx tsc --noEmit -p .`, `npx tsc --noEmit -p companion`, `npm run build`, `npm run package`. All clean; report the final counts and confirm the zip is `dist/simplefin-sync-1.10.1.zip`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "Bump to 1.10.1 with the uncategorized dismissal changelog"
```

(Release itself — tag, GitHub release, both store files' six version fields, screenshots, and the rsync + companion rebuild — is Nick's separate flow after he has seen it running. Not part of this plan.)
