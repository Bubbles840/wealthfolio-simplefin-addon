# Holdings cost basis (#83) and the Amazon fallback (#80) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a sync from wiping a cost basis (and net contribution) entered by hand (#83: A, don't write a snapshot that changes nothing; B, carry the cost onto hand-priced shared funds and put their price back; the dividends lookback that A's sparse snapshots need), and let the Amazon fallback category be a subcategory (#80).

**Architecture:** A pure comparator, `sameAsHeld` in `shared/holdings.ts`, says whether the snapshot about to be written matches Wealthfolio's holdings read exactly; `syncHoldingsWithFeedPrices` (`src/utils/holdings-prices.ts`) decides `write` from it before building the positions, and skips the import (counted in `skipped`) while step 5 still prices per-account assets. B extends the cost carry to shared assets the market does not price, reading the asset's price history before the import (a same-day quote first, else the latest earlier) and writing it back after; the `kept` path uses the same read-before/restore-after list. Restore failures surface through a new optional `HoldingsSyncOutcome.priceNotRestored`, which the sync core turns into a sync error. Dividends gain the snapshot in force at the window's start as a last candidate, with a two-year listing. #80 is one list (`labelOptions`) and one display helper shared by the label rows and the fallback dropdown in `AmazonCard.tsx`.

**Tech Stack:** TypeScript; vitest (root project: jsdom, `src/` + `shared/`; companion project: node, `companion/src/`); the fake Wealthfolio in `src/utils/holdings-prices.test.ts`; the sync core's fake host (`shared/fake-host.ts`); React Testing Library for the card.

**Spec:** `docs/superpowers/specs/2026-11-18-issues-79-83-design.md` — only the sections "#83: a sync wipes a cost basis entered by hand" (A and B) and "#80: the Amazon fallback can't be a subcategory", plus their CHANGELOG/README lines. #79 and #81 are a separate plan that runs after this one.

**Target tree:** branch `fix/issues-79-83` at 995eece. Every block below was applied task by task to a scratch clone of that commit; every FAIL/PASS count was read off that replay (each task's tests run against the previous task's tree, then against its own).

**Execution:** subagent-driven development — one implementer per task, one reviewer per task, tasks in order (each consumes the ones before).

## Global Constraints

- Every vitest run: `nice npx vitest run --maxWorkers=2 <file>` in the repo root; companion: `(cd companion && nice npx vitest run --maxWorkers=2)`, never `--root`. Run single files while working; full suites only in Task 6. The machine overheats.
- Tests pin their dates (fixed `NOW`/`DAY` constants, or `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime`), and must pass with the clock forced into 2027 (Task 6 checks).
- #83 A: **anything unreadable or ambiguous means write, as today.** The skip must never be the risky branch. Share counts are compared as decimals, never floats.
- #83 B sync error, verbatim (X = the holding's own symbol): `Couldn't put back the price of X after saving its holdings. It shows at its cost until its next price.`
- No version bump, no release. CHANGELOG entries go under `## [Unreleased]`.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `shared/` is compiled into the companion too: `nice npm --prefix companion run build` must stay clean (Task 6).
- `src/utils/addon-host.ts` needs no change: the SDK's `Holding` already carries `holdingType`, and its `Quote` carries `currency` and `notes`; `pricingApi()` passes both through.

## Deviations and readings (decided — do not "fix")

1. **Zero shares count as not held, on both sides.** Wealthfolio's snapshot save drops zero-quantity positions and its holdings read drops closed ones, so a feed that keeps listing a sold fund at 0 shares matches a holding that isn't there. Without this, such an account would write every day.
2. **No cash line means zero cash.** Wealthfolio 3.8–3.13 emit a cash line per currency only for a non-dust balance (`is_cash_dust` in `holdings_service.rs`). "Cash can't be read" means a cash line whose amount or currency is unreadable, or two lines for one currency. Reading a missing line as unreadable would make the reporter's 529s (cash 0) write every day, and A would do nothing for them.
3. **"Same assets" compares every non-cash line, whatever its `holdingType`** (an alternative asset in the account forces a write), by asset id, one to one. Two positions on one asset, or a position whose asset doesn't exist yet, never match.
4. **B reads price history only on a day the snapshot is written, and only when the carry has something to say (a cost or an ask).** No quote, or an unreadable history, means no carry and no ask, which is today's behaviour for these funds. So A's skip costs no extra read. This is pinned by a test.
5. **The restored quote keeps the remembered quote's own note** (`''` when it had none), not `FEED_PRICE_NOTE`: the price is the person's ("remember it exactly"). `manualQuote` gains a `notes` parameter that defaults to `FEED_PRICE_NOTE`.
6. **`kept` and B restores are one list, with one retry rule and one error.** `kept` used to log only. Its history read moves from after the import to before it, which "prefer a same-day quote" requires: after the import, the day's quote is the import's own. A `kept` holding whose history read fails before the import is reported too, because the import will overwrite its price with no way back.
7. **Same-day quote choice:** a MANUAL quote dated that day first (it's the one the import replaces), then any source on that day, then the latest before it. Quotes with a close of 0 or less don't count.
8. **Dividends: list 730 days** (`SNAPSHOT_WINDOW_DAYS` 180 → 730), still one listing per account per sync. `SnapshotInfo` rows are five small fields. The in-force snapshot is the newest one dated on or before the window's first day. One dated exactly on that day is already in the window, so it isn't added twice.
9. **#80 also changes the label rows with an older companion:** the bookkeeping exclusion now applies there too, and the list is sorted. The spec says the fallback uses `labelOptions` and never offers the bookkeeping categories. The fallback also shows the "fits N categories" hint for an ambiguous legacy bare name, the way the label rows show it.
10. **Existing tests rebuilt.** Task 2 changes ten tests in `holdings-prices.test.ts`: nine that relied on an unchanged snapshot being written now change the cash (`nextDay`) or the share count, and one expectation becomes `imported: 0, skipped: 1`. Task 3 turns "carries nothing back onto a shared asset the person prices by hand" into its B positive. Task 4 appends the in-force date to one `snapshotDatesToRead` expectation. The fake Wealthfolio gains cash lines, `holdingType`, notes on quotes, and "latest snapshot on or before the day" valuation, which is how Wealthfolio values.
11. **Found, then planned by the lead:** a hand-priced shared fund for which SimpleFin *does* send a cost had that day's price overwritten by the import's average-cost quote. Task 3 now restores it too (see the amendment bullets).
12. **Lead's amendment: B needs a REPORTED `MANUAL` mode.** An unreported mode keeps today's behaviour, so B never writes a MANUAL quote onto an asset the market may price. The spec was amended to match.

## Review Focus

Inputs the spec implies that are likely to bite. Each one has a test in the task that owns it:

1. **Float-printed numbers from Wealthfolio:** a share count stored with more digits than a double keeps, or one JavaScript prints with an exponent (`1e-7`). That holding writes every sync, as before, and is never skipped on a guess. Task 1: "compares share counts as decimals…".
2. **Margin cash below zero** is compared like positive cash. Task 1: "compares cash per currency to the cent".
3. **A feed quantity spelled differently** (`'+010.000'` against `10`) is the same count. Task 1.
4. **A hand-priced fund quoted in another currency than the holding** gets its price put back in the quote's own currency. Task 3: "puts the price back in the currency it was entered in".
5. **Price history unreadable on a write day.** For B: no carry, as for a fund with no price. For `kept`: the fund is named in the sync errors. Task 3: "carries nothing when the price history cannot be read…" and "names a kept holding whose price could not be read before its import".

## File map

| File | Change | Task |
|---|---|---|
| `shared/holdings.ts` | `sameCurrency` (moved here), `PositionOnAsset`, `HeldLine`, `sameAsHeld` | 1 |
| `src/utils/holdings-prices.ts` | import `sameCurrency`; A's `write` decision; B carry + restore; `kept` same-day; `manualQuote(…, notes)`; history entries' `currency`/`notes` | 1, 2, 3 |
| `shared/sync-host.ts` | `HoldingsSyncOutcome.priceNotRestored?` | 3 |
| `shared/sync-core.ts` | the restore error in the holdings pass | 3 |
| `shared/dividends.ts` | in-force candidate, `SNAPSHOT_WINDOW_DAYS = 730` | 4 |
| `src/components/AmazonCard.tsx` | one `labelOptions`, `shownAs`, fallback dropdown | 5 |
| `CHANGELOG.md`, `README.md` | [Unreleased] lines, four README spots | 6 |

---

### Task 1: `sameAsHeld`, the comparator

**Files:**
- Modify: `shared/holdings.ts` (add after `holdingsWithoutCost`, before the money-market constants)
- Modify: `src/utils/holdings-prices.ts:74-82` (delete the local `sameCurrency`; import it from shared)
- Test: `shared/holdings.test.ts`

**Interfaces:**
- Consumes: `parseDecimal` (private in `shared/holdings.ts`, non-negative `{ n: bigint; scale: number }`), usable for the cost total.
- Produces (all exported from `shared/holdings.ts`):
  - `sameCurrency(a: string, b: string): boolean`: moved verbatim from `holdings-prices.ts`, same behaviour.
  - `interface PositionOnAsset { assetId: string | undefined; quantity: string; currency: string; sentAvgCost?: string }`
  - `interface HeldLine { holdingType?: string | null; instrument?: { id?: string | null } | null; quantity?: number | string | null; costBasis?: { local?: number | string | null } | null; localCurrency?: string | null }`. `HeldAsset` (holdings-prices.ts) must stay assignable to it.
  - `sameAsHeld(positions: readonly PositionOnAsset[], cashBalances: Readonly<Record<string, string>>, held: readonly HeldLine[]): boolean`

- [ ] **Step 1: Write the failing tests**

In `shared/holdings.test.ts`, extend the import to `import { accountTag, balanceShowsTotal, carriedCost, feedPrices, holdingsWithoutCost, holdingSymbol, sameAsHeld, sameCurrency, scopedSymbol, toHoldingsSnapshot, type HeldLine, type PositionOnAsset } from './holdings.js';` and add these two describes right before `describe('holdingsWithoutCost', …)`:

```ts
describe('sameAsHeld', () => {
  const sec = (id: string, quantity: number | string, cost: number | null = 0, localCurrency = 'USD'): HeldLine =>
    ({ holdingType: 'security', instrument: { id }, quantity, costBasis: cost === null ? null : { local: cost }, localCurrency });
  const cashLine = (quantity: number | string, localCurrency: string | null = 'USD'): HeldLine =>
    ({ holdingType: 'cash', instrument: { id: `cash:${localCurrency}` }, quantity, localCurrency });
  const pos = (assetId: string | undefined, quantity: string, sentAvgCost?: string): PositionOnAsset =>
    ({ assetId, quantity, currency: 'USD', ...(sentAvgCost ? { sentAvgCost } : {}) });

  it('is true for the same assets, share counts, sent cost and cash', () => {
    // a-1 came without a cost: what Wealthfolio holds for it is not compared.
    expect(sameAsHeld(
      [pos('a-1', '400.5'), pos('a-2', '10', '50.005')],
      { USD: '1234.56' },
      [sec('a-1', 400.5, 999), sec('a-2', 10, 500.05), cashLine(1234.56)],
    )).toBe(true);
  });

  it('reads a cash balance of zero as no cash line, the way Wealthfolio reports it', () => {
    expect(sameAsHeld([pos('a-1', '5')], { USD: '0' }, [sec('a-1', 5)])).toBe(true);
    expect(sameAsHeld([pos('a-1', '5')], { USD: '0.004' }, [sec('a-1', 5)])).toBe(true);
    expect(sameAsHeld([pos('a-1', '5')], { USD: '0' }, [sec('a-1', 5), cashLine(5)])).toBe(false);
    expect(sameAsHeld([pos('a-1', '5')], { USD: '5' }, [sec('a-1', 5)])).toBe(false);
  });

  it('compares share counts as decimals, and a count the read cannot show exactly as different', () => {
    expect(sameAsHeld([pos('a-1', '10.10')], { USD: '0' }, [sec('a-1', 10.1)])).toBe(true);
    expect(sameAsHeld([pos('a-1', '0.123456789')], { USD: '0' }, [sec('a-1', 0.123456789)])).toBe(true);
    expect(sameAsHeld([pos('a-1', '10.1')], { USD: '0' }, [sec('a-1', '10.10')])).toBe(true);
    expect(sameAsHeld([pos('a-1', '+010.000')], { USD: '0' }, [sec('a-1', 10)])).toBe(true);
    expect(sameAsHeld([pos('a-1', '400.5')], { USD: '0' }, [sec('a-1', 400.50000001)])).toBe(false);
    // 1e-7 has no plain decimal form in JavaScript.
    expect(sameAsHeld([pos('a-1', '0.0000001')], { USD: '0' }, [sec('a-1', 1e-7)])).toBe(false);
    expect(sameAsHeld([pos('a-1', '10')], { USD: '0' }, [sec('a-1', 'ten')])).toBe(false);
  });

  it('needs every position held and every holding in the feed', () => {
    expect(sameAsHeld([pos('a-1', '5')], { USD: '0' }, [sec('a-1', 5), sec('a-2', 1)])).toBe(false);
    expect(sameAsHeld([pos('a-1', '5'), pos('a-2', '1')], { USD: '0' }, [sec('a-1', 5)])).toBe(false);
    expect(sameAsHeld([pos('a-1', '5')], { USD: '0' }, [])).toBe(false);
    // No shares on either side is the same thing as not held.
    expect(sameAsHeld([pos('a-1', '5'), pos('a-2', '0')], { USD: '0' }, [sec('a-1', 5)])).toBe(true);
    expect(sameAsHeld([pos('a-1', '5')], { USD: '0' }, [sec('a-1', 5), sec('a-2', 0)])).toBe(true);
  });

  it('is false for anything it cannot match one to one', () => {
    // An asset that does not exist yet (a first move, a new ticker).
    expect(sameAsHeld([pos(undefined, '5')], { USD: '0' }, [sec('a-1', 5)])).toBe(false);
    // Two positions on one asset.
    expect(sameAsHeld([pos('a-1', '2'), pos('a-1', '3')], { USD: '0' }, [sec('a-1', 5)])).toBe(false);
    // A holding the read names no asset for.
    expect(sameAsHeld([pos('a-1', '5')], { USD: '0' }, [sec('a-1', 5), { holdingType: 'security', instrument: null, quantity: 1 }])).toBe(false);
  });

  it('compares a cost SimpleFin sent with the total Wealthfolio holds, within a cent', () => {
    const sent = (cost: number | null, currency = 'USD') =>
      sameAsHeld([pos('a-2', '10', '50.005')], { USD: '0' }, [sec('a-2', 10, cost, currency)]);
    expect(sent(500.06)).toBe(true);
    expect(sent(500.04)).toBe(true);
    expect(sent(500.07)).toBe(false);
    expect(sent(null)).toBe(false);
    expect(sent(500.05, 'CAD')).toBe(false);
    expect(sameAsHeld([pos('a-3', '10', '50')], { USD: '0' }, [sec('a-3', 10, 500)])).toBe(true);
  });

  it('compares cash per currency to the cent', () => {
    const cash = (amounts: Record<string, string>, ...lines: HeldLine[]) =>
      sameAsHeld([pos('a-1', '5')], amounts, [sec('a-1', 5), ...lines]);
    expect(cash({ USD: '1234.56' }, cashLine(1234.564))).toBe(true);
    expect(cash({ USD: '1234.56' }, cashLine(1234.57))).toBe(false);
    expect(cash({ USD: '1234.56' }, cashLine(1234.56), cashLine(10, 'CAD'))).toBe(false);
    expect(cash({ USD: '1234.56' }, cashLine('n/a'))).toBe(false);
    expect(cash({ USD: '1234.56' }, cashLine(1234.56, null))).toBe(false);
    expect(cash({ USD: 'n/a' }, cashLine(1234.56))).toBe(false);
    // Margin: cash below zero is compared the same way.
    expect(cash({ USD: '-120.50' }, cashLine(-120.5))).toBe(true);
    expect(cash({ USD: '-120.50' }, cashLine(120.5))).toBe(false);
  });
});

describe('sameCurrency', () => {
  it('ignores case, except in a code that mixes it (pence is not pounds)', () => {
    expect(sameCurrency('usd', 'USD')).toBe(true);
    expect(sameCurrency(' USD', 'USD ')).toBe(true);
    expect(sameCurrency('GBp', 'GBP')).toBe(false);
    expect(sameCurrency('CAD', 'USD')).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 shared/holdings.test.ts`
Expected: FAIL — `8 failed | 61 passed (69)`: seven `TypeError: sameAsHeld is not a function`, one `TypeError: sameCurrency is not a function`.

- [ ] **Step 3: Implement in `shared/holdings.ts`; move `sameCurrency`**

Move `sameCurrency` (with its doc comment) from `src/utils/holdings-prices.ts` into `shared/holdings.ts` as an export, and change holdings-prices.ts's import to `import { carriedCost, sameCurrency, scopedSymbol, type FeedPrice, type HoldingsSnapshot } from '../../shared/holdings';`.

Add `PositionOnAsset`, `HeldLine` and `sameAsHeld` as in Interfaces. `sameAsHeld` is true only on an exact match, and false for anything it can't read:
- **Decimals.** Read each count with a private exact reader: a plain decimal (`/^([+-]?)(\d+)(?:\.(\d*))?$/` on the trimmed string) in one spelling, with leading and trailing zeros dropped and `-0` read as `0`. A number is read as `String(n)`, so a non-finite number, or one printed with an exponent, is unreadable (null).
- **Positions.** An unreadable quantity → false. A quantity of 0 → skipped. Otherwise it needs an `assetId` (missing → false), and that id must be used by no other position (a repeat → false).
- **Held lines.** A line with `holdingType` `cash` (case-insensitive) is a cash line. It needs a trimmed `localCurrency` and a readable `quantity`, rounded to cents half away from zero. Anything else, or a second line for one currency (by `sameCurrency`), → false. Every other line needs `instrument.id` and a readable `quantity`, with no repeated id (else → false). A line at 0 is skipped.
- **Matching.** Same id set, and each count equal as decimals.
- **A position with `sentAvgCost`.** If the held line has a `localCurrency`, it must be `sameCurrency` with the position's currency. The held `costBasis.local` must be readable and within $0.01 of `sentAvgCost × quantity`, computed exactly in bigint. Work at a common scale of at least 2 decimals: the integer case `'50' × '10'` against `500` must not drop below cents. Positions without `sentAvgCost` don't compare cost.
- **Cash.** Over every currency in `cashBalances` and in the cash lines (matched by `sameCurrency`), the written amount (none = 0; unreadable → false) and the held amount (no line = 0) must be equal in cents.

Give `sameAsHeld` a doc comment saying why (#83: Wealthfolio resets net contribution to 0 on every snapshot it saves), and that no cash line means zero.

- [ ] **Step 4: Run the tests and the type check**

Run: `nice npx vitest run --maxWorkers=2 shared/holdings.test.ts` → Expected: PASS, `69 passed (69)`.
Run: `nice npx vitest run --maxWorkers=2 src/utils/holdings-prices.test.ts` → Expected: PASS, `41 passed (41)`.
Run: `nice npm run type-check` → Expected: exit 0, no output after the `tsc --noEmit` line.

- [ ] **Step 5: Commit**

```bash
git add shared/holdings.ts shared/holdings.test.ts src/utils/holdings-prices.ts
git commit -m "Holdings: tell a snapshot that says what Wealthfolio already holds (#83)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: A — don't write a snapshot that changes nothing

**Files:**
- Modify: `src/utils/holdings-prices.ts` (`HeldAsset`; `syncHoldingsWithFeedPrices` around the step-4 decision; the header doc comment)
- Test: `src/utils/holdings-prices.test.ts`

**Interfaces:**
- Consumes: `sameAsHeld`, `PositionOnAsset` (Task 1).
- Produces:
  - `HeldAsset.holdingType?: string | null` (`cash` for a cash line, else `security` / `alternativeAsset`).
  - Inside `syncHoldingsWithFeedPrices`: `read: HeldAsset[] | null` (the whole holdings read, cash lines included; null when no read was made) and `write: boolean`, decided **before** the positions to write are built. Task 3 gates its price reads on `write`.
  - Test file: the fake `wealthfolio()` returns `holdingType` and cash lines; `value()` uses the latest snapshot on or before the day; `snap(symbol, quantity, date = DAY, avgCost?, cash = '0')`.

- [ ] **Step 1: Update the fake, write the new tests, rebuild the tests A flips**

In `src/utils/holdings-prices.test.ts`:

(a) The fake's `getHoldings` returns the positions with `holdingType: 'security'`, plus a cash line per non-zero cash balance. Replace its `return snapshots.get(dates[dates.length - 1])!.positions.map(…)` with:

```ts
      const snap = snapshots.get(dates[dates.length - 1])!;
      const positions = snap.positions.map((p) => {
        const asset = assets.get(key(p.symbol))!;
        const quantity = Number(p.quantity);
        return {
          holdingType: 'security',
          instrument: { id: asset.id, symbol: asset.displayCode ?? p.symbol, pricingMode: asset.quoteMode },
          price: latest(asset.id),
          quantity,
          costBasis: { local: p.avgCost ? Math.round(Number(p.avgCost) * quantity * 100) / 100 : 0 },
        };
      });
      // A cash line per currency, none for a zero balance (Wealthfolio skips it).
      const cash = Object.entries(snap.cashBalances).filter(([, amount]) => Number(amount) !== 0).map(([currency, amount]) => ({
        holdingType: 'cash',
        instrument: { id: `cash:${currency}`, symbol: currency, pricingMode: 'MANUAL' },
        price: 1,
        quantity: Number(amount),
        costBasis: { local: Number(amount) },
        localCurrency: currency,
      }));
      return [...positions, ...cash];
```

(b) `value()` values from the latest snapshot on or before the day, as Wealthfolio does:

```ts
  /** What a position is worth in this account on this day, as Wealthfolio values
   *  it: the shares of the latest snapshot on or before the day. */
  const value = (account: string, date: string, symbolPrefix: string) => {
    const on = [...snapshots.keys()].filter((k) => k.startsWith(`${account}|`) && k.split('|')[1] <= date).sort();
    const snap = snapshots.get(on[on.length - 1])!;
```

(the rest of `value` is unchanged).

(c) `snap` takes the cash:

```ts
const snap = (symbol: string, quantity: string, date = DAY, avgCost?: string, cash = '0'): HoldingsSnapshot => ({
  date,
  positions: [{ symbol, quantity, currency: 'USD', ...(avgCost ? { avgCost } : {}) }],
  cashBalances: { USD: cash },
});
```

(d) Rebuild the ten existing tests that relied on an unchanged snapshot being written. In `describe('a holding the feed sends without a cost')`, right after the `written` helper, add:

```ts
    /** The day after: the same shares, and a dividend paid in cash, so the
     *  snapshot is written (one that changed nothing is not: #83). */
    const nextDay = (symbol: string, shares: string) => snap(symbol, shares, NEXT, undefined, '25.00');
```

Then make these changes:
1. "reads no profile for a holding already on its own asset": the expectation becomes `expect(r).toMatchObject({ imported: 0, skipped: 1, pricedFromFeed: ['MODEL BASKET (AAAA1111)'] });`, with the comment `// Held unchanged, so no snapshot (#83); the day's price is still written.`
2. "keeps the cost Wealthfolio already has": `snap('VOO', '10', NEXT)` → `nextDay('VOO', '10')`.
3. "finds the holding by asset id when its shown code drops the exchange suffix": `snap('SHOP.TO', '10', NEXT)` → `nextDay('SHOP.TO', '10')`.
4. "carries nothing when the held cost is in another currency": `snap('VOO', '10', NEXT)` → `nextDay('VOO', '10')`.
5. "carries it when the held cost is in the same currency": the same change.
6. "carries nothing, and does not ask, when the held cost is in another currency (pence is not pounds)": the same change.
7. "carries nothing onto a shared asset whose pricing mode the read does not report": the same change.
8. "does not ask when that day's snapshot already exists and nothing is written": the first sync becomes `snap('VOO', '9', NEXT)` (a sale, written); the second stays `snap('VOO', '12', NEXT)`.
9. "never puts one on a shared asset the person prices by hand, where it would become the day's price": `snap('VOO', '10', NEXT)` → `nextDay('VOO', '10')`.
10. "keeps the cost of a holding on its own asset, valued at the feed's price": the NEXT sync uses `nextDay('MODEL BASKET', '400.5')`, and the `later` sync uses `snap('MODEL BASKET', '400.5', later, undefined, '30.00')`.

(e) Add a new describe right before `it('reads nothing and moves nothing without an account tag', …)` (inside `describe('syncHoldingsWithFeedPrices')`):

```ts
  describe('a snapshot that says what Wealthfolio already holds (#83)', () => {
    const NEXT = '2026-10-20';

    it('is not written, so a cost entered by hand stays, and the day\'s price is still written', async () => {
      // A plan fund named from its description, on its own asset since DAY.
      const wf = wealthfolio();
      const fund = (date: string) => snap('TARGET DATE FUND 2060', '40', date);
      await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-plan', fund(DAY), priceOf('TARGET DATE FUND 2060', '250.00', { fromDescription: true }), 'CCCC3333', undefined, NOW);
      // The person enters the real cost: $200 a share.
      wf.snapshots.set(`wf-plan|${DAY}`, snap('TARGET DATE FUND 2060 (CCCC3333)', '40', DAY, '200'));

      const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-plan', fund(NEXT), priceOf('TARGET DATE FUND 2060', '255.00', { fromDescription: true }), 'CCCC3333', undefined, NOW);
      expect(r).toEqual({ imported: 0, skipped: 1, unresolvedSymbols: [], pricedFromFeed: ['TARGET DATE FUND 2060 (CCCC3333)'] });
      expect(wf.snapshots.has(`wf-plan|${NEXT}`)).toBe(false);
      expect((await wf.pricing.getHoldings('wf-plan'))[0].costBasis.local).toBe(8000);
      expect(wf.value('wf-plan', NEXT, 'TARGET DATE')).toEqual({ symbol: 'TARGET DATE FUND 2060 (CCCC3333)', value: 10200 });
    });

    it('is not written for a ticker the market prices, and costs no read past the holdings', async () => {
      const wf = wealthfolio();
      wf.seedAsset('VOO', 'MARKET', OLD);
      wf.snapshots.set(`wf-a|${DAY}`, snap('VOO', '10', DAY, '50', '25.00'));
      const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('VOO', '10', NEXT, undefined, '25.00'), [], 'AAAA1111', undefined, NOW);

      expect(r).toEqual({ imported: 0, skipped: 1, unresolvedSymbols: [] });
      expect(wf.io.importSnapshots).not.toHaveBeenCalled();
      expect(wf.pricing.getHistory).not.toHaveBeenCalled();
      expect(wf.pricing.getProfile).not.toHaveBeenCalled();
    });

    it('is written when anything in it changed', async () => {
      const day: HoldingsSnapshot = {
        date: DAY,
        positions: [{ symbol: 'VOO', quantity: '10', currency: 'USD', avgCost: '50' }, { symbol: 'VTI', quantity: '4', currency: 'USD', avgCost: '200' }],
        cashBalances: { USD: '25.00' },
      };
      const next = (change: (s: HoldingsSnapshot) => HoldingsSnapshot) =>
        change({ ...day, date: NEXT, positions: day.positions.map((p) => ({ ...p })), cashBalances: { ...day.cashBalances } });
      const changes: Array<[string, HoldingsSnapshot]> = [
        ['nothing (the control)', next((s) => s)],
        ['a share count', next((s) => ({ ...s, positions: [{ ...s.positions[0], quantity: '10.5' }, s.positions[1]] }))],
        ['the cash', next((s) => ({ ...s, cashBalances: { USD: '25.01' } }))],
        ['a cost SimpleFin sent', next((s) => ({ ...s, positions: [{ ...s.positions[0], avgCost: '50.01' }, s.positions[1]] }))],
        ['a position sold', next((s) => ({ ...s, positions: [s.positions[0]] }))],
        ['a new position', next((s) => ({ ...s, positions: [...s.positions, { symbol: 'BND', quantity: '3', currency: 'USD' }] }))],
      ];
      const imported: Record<string, number> = {};
      for (const [what, snapshot] of changes) {
        const wf = wealthfolio();
        wf.seedAsset('VOO', 'MARKET', OLD);
        wf.seedAsset('VTI', 'MARKET', OLD);
        wf.snapshots.set(`wf-a|${DAY}`, day);
        imported[what] = (await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snapshot, [], 'AAAA1111', undefined, NOW)).imported;
      }
      expect(imported).toEqual({
        'nothing (the control)': 0, 'a share count': 1, 'the cash': 1, 'a cost SimpleFin sent': 1, 'a position sold': 1, 'a new position': 1,
      });
    });

    it('is written on the day a holding moves onto its own asset that already exists', async () => {
      const wf = withBasket();
      wf.seedAsset('MODEL BASKET (AAAA1111)', 'MANUAL', OLD);
      const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5', NEXT), priceOf('MODEL BASKET', '125'), 'AAAA1111', undefined, NOW);

      expect(r).toMatchObject({ imported: 1, pricedFromFeed: ['MODEL BASKET (AAAA1111)'] });
      expect(wf.value('wf-a', NEXT, 'MODEL BASKET')).toEqual({ symbol: 'MODEL BASKET (AAAA1111)', value: 50062.5 });
    });

    it('is written, as before, when the cash in Wealthfolio cannot be read', async () => {
      const wf = wealthfolio();
      wf.seedAsset('VOO', 'MARKET', OLD);
      wf.snapshots.set(`wf-a|${DAY}`, snap('VOO', '10', DAY, '50', '25.00'));
      const read = wf.pricing.getHoldings.getMockImplementation()!;
      wf.pricing.getHoldings.mockImplementation(async (account: string) =>
        (await read(account)).map((h) => (h.holdingType === 'cash' ? { ...h, quantity: Number.NaN } : h)));
      const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('VOO', '10', NEXT, undefined, '25.00'), [], 'AAAA1111', undefined, NOW);

      expect(r.imported).toBe(1);
    });
  });
```

The existing "moves a holding back to the shared asset once that one has a market quote" (a move back writes) and "moves a basket…" / "puts a holding named from its description…" (first moves write) stay as they are, and pin the other two changes of asset.

- [ ] **Step 2: Run them to verify the right ones fail**

Run: `nice npx vitest run --maxWorkers=2 src/utils/holdings-prices.test.ts`
Expected: FAIL — `4 failed | 42 passed (46)`. The failing tests are "reads no profile for a holding already on its own asset", "is not written, so a cost entered by hand stays…", "is not written for a ticker the market prices…" and "is written when anything in it changed" (the control imports 1). Each fails because the snapshot is written today.

- [ ] **Step 3: Implement the decision in `syncHoldingsWithFeedPrices`**

- Add `holdingType?: string | null` to `HeldAsset`, with the doc comment in Interfaces.
- Keep the whole read: `read = holdings ?? []` right after `getHoldings`, declared `let read: HeldAsset[] | null = null` next to `kept`. The existing `usable`/`held`/`heldById` maps stay as they are.
- After the moved-back loop, and before `costUnknown`/`backModes`, decide `write`:
  - move the existing `firstMove` line up here, unchanged;
  - `unchanged = read !== null && sameAsHeld(…, snapshot.cashBalances, read)`. Map each **`snapshot.positions`** entry (SimpleFin's own costs, not the carried ones) to `{ assetId: ids.get(own ? symbolKey(scoped(p.symbol)) : symbolKey(p.symbol)), quantity: p.quantity, currency: p.currency, ...(p.avgCost ? { sentAvgCost: p.avgCost } : {}) }`, where `own = moving.has(key) || kept.has(key)`;
  - `write = !unchanged && (firstMove || !check.existingDates.some((d) => dayOf(d) === snapshot.date))`.
- The import runs only `if (write)`; otherwise `skipped = 1`. Nothing else changes: step 5 still runs on a skipped import, and `costUnknown` is still reported only when `imported > 0`.
- Header doc comment: add a paragraph saying a snapshot that matches what Wealthfolio already holds (same assets, share counts, the costs SimpleFin sent, and cash) is not written (#83, `sameAsHeld`), because Wealthfolio sets net contribution to 0 on every snapshot it saves. Reword step 4 of the function's doc: "written unless it says what Wealthfolio already holds, or the date already has one, except on the day a holding first moves…".

- [ ] **Step 4: Run the tests and the type check**

Run: `nice npx vitest run --maxWorkers=2 src/utils/holdings-prices.test.ts` → Expected: PASS, `46 passed (46)`.
Run: `nice npm run type-check` → Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/utils/holdings-prices.ts src/utils/holdings-prices.test.ts
git commit -m "Holdings: skip a snapshot that changes nothing, so a hand-entered cost stays (#83)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: B — carry onto hand-priced shared funds, put the price back

**Files:**
- Modify: `src/utils/holdings-prices.ts` (`PricingApi.getHistory`, `manualQuote`, a private `priceToRestore`, the positions build, the restore after the import, the header)
- Modify: `shared/sync-host.ts:155-173` (`HoldingsSyncOutcome`)
- Modify: `shared/sync-core.ts` (holdings pass, next to the `costUnknown` errors, ~4971)
- Test: `src/utils/holdings-prices.test.ts`, `shared/sync-core.test.ts`

**Interfaces:**
- Consumes: `write` and `read` (Task 2), decided before the positions are built.
- Produces:
  - `PricingApi.getHistory` entries gain `currency?: string | null; notes?: string | null`.
  - `manualQuote(assetId: string, date: string, price: string, currency: string, now = new Date(), notes = FEED_PRICE_NOTE): ManualQuote`.
  - `HoldingsSyncOutcome.priceNotRestored?: string[]`: hand-priced holdings whose price the import overwrote and that could not be put back, even on a second try. Present only when non-empty.
  - Test fake: quotes carry `notes`; `updateQuote` stores `quote.notes`; `handQuote(id, day, close, notes?)` seeds a MANUAL quote.

- [ ] **Step 1: Write the failing tests**

(a) Fake changes in `src/utils/holdings-prices.test.ts`:
- the `quotes` map's value type becomes `{ close: number; dataSource: string; notes?: string | null }`;
- `quotesOf` maps to `{ timestamp: …, close: q.close, dataSource: q.dataSource, notes: q.notes ?? null }`;
- `updateQuote` stores the note:

```ts
    updateQuote: vi.fn(async (id: string, quote: { timestamp: string; close: number; notes?: string }) => {
      quotes.set(`${id}|${quote.timestamp.slice(0, 10)}|MANUAL`, { close: quote.close, dataSource: 'MANUAL', notes: quote.notes });
    }),
```

- after `marketQuote`, add the helper below, and add `handQuote` to the returned object:

```ts
  /** A price the person entered by hand. */
  const handQuote = (id: string, day: string, close: number, notes?: string) => quotes.set(`${id}|${day}|MANUAL`, { close, dataSource: 'MANUAL', notes });
```

(b) Two top-level tests, right before `it('leaves a shared asset the person set to manual alone', …)`:

```ts
  it('keeps a price entered for the day itself on a kept holding', async () => {
    const wf = withBasket();
    await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', undefined, NOW);
    const next = '2026-10-20';
    wf.handQuote(wf.assets.get('MODEL BASKET (AAAA1111)')!.id, next, 130);
    await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5', next, '100'), [], 'AAAA1111', undefined, NOW);
    expect(wf.value('wf-a', next, 'MODEL BASKET')).toEqual({ symbol: 'MODEL BASKET (AAAA1111)', value: 52065 });
  });

  it('names a kept holding whose price could not be read before its import', async () => {
    // The import writes the cost as the day's price, and there is no price to put back.
    const wf = withBasket();
    await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', undefined, NOW);
    wf.pricing.getHistory.mockRejectedValueOnce(new Error('timeout'));
    const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5', '2026-10-20', '100'), [], 'AAAA1111', undefined, NOW);

    expect(r).toMatchObject({ imported: 1, priceNotRestored: ['MODEL BASKET'] });
  });
```

(c) In `describe('a holding the feed sends without a cost')`, replace the test "carries nothing back onto a shared asset the person prices by hand" with its B positive (the setup is unchanged; the name and the last two lines change):

```ts
    it('carries the cost back onto a shared asset the person prices by hand, and keeps its price', async () => {
      const wf = withBasket();
      await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5'), priceOf('MODEL BASKET', '124.84394507'), 'AAAA1111', undefined, NOW);
      wf.snapshots.set(`wf-a|${DAY}`, snap('MODEL BASKET (AAAA1111)', '400.5', DAY, '100'));
      wf.marketQuote(wf.assets.get('MODEL BASKET')!.id, DAY, 126);
      wf.assets.get('MODEL BASKET')!.quoteMode = 'MANUAL';

      await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('MODEL BASKET', '400.5', NEXT), priceOf('MODEL BASKET', '125'), 'AAAA1111', undefined, NOW);
      expect(written(wf, NEXT)).toMatchObject({ symbol: 'MODEL BASKET', avgCost: '100.00' });
      // The import wrote 100 as the day's price; the last price, 126, is back.
      expect(wf.value('wf-a', NEXT, 'MODEL BASKET')).toEqual({ symbol: 'MODEL BASKET', value: 50463 });
    });
```

(d) Right after it, add:

```ts
    describe('on a shared fund the person prices by hand', () => {
      /** A plan fund on a shared asset priced by hand: 100 shares at a cost of
       *  $10 entered by hand, its price $11.50 on DAY. */
      function withHandPriced() {
        const wf = wealthfolio();
        const fund = wf.seedAsset('PLAN FUND', 'MANUAL', OLD);
        wf.handQuote(fund.id, DAY, 11.5, 'From my statement');
        wf.snapshots.set(`wf-a|${DAY}`, snap('PLAN FUND', '100', DAY, '10'));
        return { wf, fund };
      }
      // A contribution: 4 more shares at the feed's $12.
      const contribute = (wf: ReturnType<typeof wealthfolio>, log?: (line: string) => void) =>
        syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('PLAN FUND', '104', NEXT), priceOf('PLAN FUND', '12'), 'AAAA1111', log, NOW);

      it('carries the cost, then puts back the price the import overwrote', async () => {
        const { wf, fund } = withHandPriced();
        const r = await contribute(wf);

        // (100 × $10 + 4 × $12) ÷ 104
        expect(written(wf, NEXT).avgCost).toBe('10.07692308');
        expect(r).toEqual({ imported: 1, skipped: 0, unresolvedSymbols: [] });
        // The latest price before the day, with its own note; not the cost.
        expect(wf.quotes.get(`${fund.id}|${NEXT}|MANUAL`)).toEqual({ close: 11.5, dataSource: 'MANUAL', notes: 'From my statement' });
        // Still the person's: same asset, still priced by hand.
        expect(fund.quoteMode).toBe('MANUAL');
        expect(written(wf, NEXT).symbol).toBe('PLAN FUND');
      });

      it('puts back a price entered for that very day', async () => {
        const { wf, fund } = withHandPriced();
        wf.handQuote(fund.id, NEXT, 12.25);
        await contribute(wf);

        expect(wf.value('wf-a', NEXT, 'PLAN FUND')).toEqual({ symbol: 'PLAN FUND', value: 1274 });
      });

      it('asks, as for any holding, when the shares change by 1.5× or more', async () => {
        const { wf, fund } = withHandPriced();
        const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('PLAN FUND', '160', NEXT), priceOf('PLAN FUND', '12'), 'AAAA1111', undefined, NOW);

        expect(written(wf, NEXT).avgCost).toBeUndefined();
        expect(r.costUnknown).toEqual(['PLAN FUND']);
        expect(wf.quotes.has(`${fund.id}|${NEXT}|MANUAL`)).toBe(false);
      });

      it('carries nothing, and asks nothing, for a fund with no price at all', async () => {
        for (const shares of ['104', '160']) {
          const { wf, fund } = withHandPriced();
          wf.quotes.clear();
          const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('PLAN FUND', shares, NEXT), priceOf('PLAN FUND', '12'), 'AAAA1111', undefined, NOW);

          expect(written(wf, NEXT).avgCost).toBeUndefined();
          expect(r.costUnknown).toBeUndefined();
          expect(wf.quotes.has(`${fund.id}|${NEXT}|MANUAL`)).toBe(false);
        }
      });

      it('tries the price once more when putting it back fails', async () => {
        const { wf, fund } = withHandPriced();
        wf.pricing.updateQuote.mockRejectedValueOnce(new Error('busy'));
        const r = await contribute(wf);

        expect(r.priceNotRestored).toBeUndefined();
        expect(wf.pricing.updateQuote).toHaveBeenCalledTimes(2);
        expect(wf.quotes.get(`${fund.id}|${NEXT}|MANUAL`)?.close).toBe(11.5);
      });

      it('names the fund when the price cannot be put back', async () => {
        const { wf } = withHandPriced();
        wf.pricing.updateQuote.mockRejectedValue(new Error('refused'));
        const log = vi.fn();
        const r = await contribute(wf, log);

        expect(r).toMatchObject({ imported: 1, priceNotRestored: ['PLAN FUND'] });
        expect(wf.pricing.updateQuote).toHaveBeenCalledTimes(2);
        expect(log).toHaveBeenCalledWith(expect.stringContaining('could not put back the price of PLAN FUND: refused'));
      });

      it('puts the price back in the currency it was entered in', async () => {
        const { wf, fund } = withHandPriced();
        const read = wf.pricing.getHistory.getMockImplementation()!;
        wf.pricing.getHistory.mockImplementation(async (id: string) => (await read(id)).map((q) => ({ ...q, currency: 'CAD' })));
        await contribute(wf);

        expect(wf.pricing.updateQuote).toHaveBeenCalledWith(fund.id, expect.objectContaining({ close: 11.5, currency: 'CAD' }));
      });

      it('carries nothing when the price history cannot be read, as for a fund with no price', async () => {
        const { wf } = withHandPriced();
        wf.pricing.getHistory.mockRejectedValue(new Error('timeout'));
        const r = await contribute(wf);

        expect(r).toEqual({ imported: 1, skipped: 0, unresolvedSymbols: [] });
        expect(written(wf, NEXT).avgCost).toBeUndefined();
      });

      it('reads no price on a day nothing changed', async () => {
        const { wf } = withHandPriced();
        const r = await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('PLAN FUND', '100', NEXT), priceOf('PLAN FUND', '12'), 'AAAA1111', undefined, NOW);

        expect(r).toEqual({ imported: 0, skipped: 1, unresolvedSymbols: [] });
        expect(wf.pricing.getHistory).not.toHaveBeenCalled();
      });

      // Lead's amendment (after plan verification): the restore also covers a cost SimpleFin sent.
      it('puts back the price when SimpleFin sent the cost itself', async () => {
        const { wf, fund } = withHandPriced();
        await syncHoldingsWithFeedPrices(wf.io, wf.pricing, 'wf-a', snap('PLAN FUND', '104', NEXT, '10.07692308'), priceOf('PLAN FUND', '12'), 'AAAA1111', undefined, NOW);

        expect(written(wf, NEXT).avgCost).toBe('10.07692308');
        expect(wf.quotes.get(`${fund.id}|${NEXT}|MANUAL`)).toEqual({ close: 11.5, dataSource: 'MANUAL', notes: 'From my statement' });
      });

      // Lead's amendment: B only on a mode REPORTED as MANUAL. Unreported may be a market-priced
      // asset, where a MANUAL quote could replace the market's quote for the day.
      it('carries nothing and writes no price when Wealthfolio does not report the mode', async () => {
        const { wf } = withHandPriced();
        const read = wf.pricing.getHoldings.getMockImplementation()!;
        wf.pricing.getHoldings.mockImplementation(async (account: string) =>
          (await read(account)).map((h: any) => (h.instrument ? { ...h, instrument: { ...h.instrument, pricingMode: undefined } } : h)));
        const r = await contribute(wf);

        expect(written(wf, NEXT).avgCost).toBeUndefined();
        expect(r.costUnknown).toBeUndefined();
        expect(wf.pricing.getHistory).not.toHaveBeenCalled();
        expect(wf.pricing.updateQuote).not.toHaveBeenCalled();
      });
    });
```

(The two amendment tests were added by the lead after this plan's verification run. Adapt the
`getHoldings` override to the fake's actual shape if it differs (see the existing override near
line 393 of the test file), keeping the assertions.)

(e) In `shared/sync-core.test.ts`, right before `it('dates the holdings pass on a host that can write snapshots', …)`:

```ts
  it('says when a hand-entered price could not be put back after the holdings were saved', async () => {
    const seed = brokerageSeed();
    seed.holdingsOutcome = { imported: 1, skipped: 0, unresolvedSymbols: [], priceNotRestored: ['PLAN FUND'] };
    const { host, store } = createFakeHost(seed);
    const result = await runSyncCore(host, store, { force: true });
    expect(result.errors).toEqual([
      "Couldn't put back the price of PLAN FUND after saving its holdings. It shows at its cost until its next price.",
    ]);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 src/utils/holdings-prices.test.ts`
Expected: FAIL — `9 failed | 50 passed (59)` (the lead's two amendment tests: "puts back the price when SimpleFin sent the cost itself" fails; "carries nothing … does not report the mode" already passes today). The planner's original eight failures: "keeps a price entered for the day itself on a kept holding" (today's code restores the price from before the day), "names a kept holding…", "carries the cost back…", "carries the cost, then puts back…", "asks, as for any holding…", "tries the price once more…", "names the fund…", "puts the price back in the currency…". The rest already hold today and pin what B must keep: no carry without a price, the same-day price winning, no read on an unchanged day.
Run: `nice npx vitest run --maxWorkers=2 shared/sync-core.test.ts`
Expected: FAIL — `1 failed | 225 passed (226)`, `expected [] to deeply equal [ Array(1) ]`. (`priceNotRestored` isn't on the type yet; vitest doesn't type-check.)

- [ ] **Step 3: Implement**

`src/utils/holdings-prices.ts`:
- `PricingApi.getHistory` entries: add `currency?: string | null; notes?: string | null`.
- `manualQuote` gains `notes = FEED_PRICE_NOTE` after `now`, and writes it as `notes`.
- A private `interface KeptPrice { close: number; currency?: string; notes: string }` and a private `priceToRestore(history: History, date: string): KeptPrice | undefined` (declare both after `History`/`dayOf`). Only quotes with `Number(close) > 0` count. Pick, in order: a MANUAL quote dated `date`; any quote dated `date`; the latest dated before `date`. Return its close, its currency when it has one, and its notes (`''` when none). Return undefined when there's none.
- Build the positions in a `for … of` loop (it needs `await`), keeping what each position becomes today, and keep one list `restores: Array<{ assetId: string; symbol: string; currency: string; price: KeptPrice | null }>` (null: the price history couldn't be read). Reading a price to restore is a helper that returns undefined unless `write` is true and there's an asset id, `priceToRestore(await getHistory(id))` on success, and null when `getHistory` throws.
  - The carry for a position the feed sent without a cost: find the held line `h` as today. A currency mismatch → nothing, as today. Then `carried = carriedCost(…)`.
  - The holding is hand-priced (`byHand`) when it isn't on its own asset and `sharedMode` (as today: the read's mode, else the move-back profile mode) is **reported and equals `MANUAL`** (case-insensitive). **Lead's amendment:** a mode that isn't reported (`undefined`) is NOT `byHand`. It keeps today's behaviour exactly (no carry, no read, no restore), because it may be a market-priced asset, and a MANUAL quote written there could replace the market's quote for the day. Then: if `carried` has neither `avgCost` nor `ask`, do nothing and skip the read. Otherwise read the price to restore for the shared asset (`ids.get(key)`). With no usable price (undefined or null), carry nothing and ask nothing. With one, apply `carried` as for a MARKET holding (the ask, and the `avgCost`), and when there's an `avgCost` push `{ assetId: ids.get(key)!, symbol: p.symbol, currency: p.currency, price }`.
  - Not `byHand`: apply `carried` exactly as today.
  - **Lead's amendment, a cost SimpleFin sent:** a position written with the feed's own `avgCost`, not on its own asset, whose `sharedMode` is reported `MANUAL` (same test as `byHand`). On a write day, read the price to restore for `ids.get(key)`. Undefined (no price) means nothing, as today. Otherwise push `{ assetId, symbol: p.symbol, currency: p.currency, price }` onto `restores`; a null price is then reported after the import like any other.
  - Then, for a `kept` holding whose written position has an `avgCost` (sent or carried): read the price to restore for its per-account asset (`ids.get(symbolKey(out.symbol))`) **before the import**. If the result is not undefined, push it, with the holding's own symbol (`p.symbol`, not the per-account one). Delete the old after-import `kept` block.
- After a successful import (`imported > 0`), for each entry in `restores`:
  - if `price` is null, or `updateQuote` fails twice (call it once more after the first failure), log `[simplefin-sync] could not put back the price of ${symbol}: ${reason}` and push `symbol` into `priceNotRestored`;
  - otherwise write `manualQuote(assetId, snapshot.date, String(price.close), price.currency ?? currency, now, price.notes)`.
- Return `priceNotRestored` (only when non-empty) on every return path after the import, alongside `costUnknown`. That includes the `moving.size === 0` early return and the firstMove-recheck failure.
- Header doc comment: replace "Never onto a shared asset the person prices by hand, where the import would write that cost as the day's price." with: the cost goes onto a shared asset the person prices by hand only when it has a price to put back; the import writes the cost as that day's price there, so the price from before the import (that day's, else the latest) is written back after it (#83).

`shared/sync-host.ts`: add `priceNotRestored?: string[]` to `HoldingsSyncOutcome`, with a doc comment (hand-priced holdings whose price the snapshot import overwrote with their average cost and that could not be put back, even on a second try; #83).

`shared/sync-core.ts`: in the holdings pass, right after the `costUnknown` loop:

```ts
        for (const symbol of outcome.priceNotRestored ?? []) {
          errors.push(`Couldn't put back the price of ${symbol} after saving its holdings. It shows at its cost until its next price.`);
        }
```

- [ ] **Step 4: Run the tests and the type check**

Run: `nice npx vitest run --maxWorkers=2 src/utils/holdings-prices.test.ts` → Expected: PASS, `59 passed (59)`.
Run: `nice npx vitest run --maxWorkers=2 shared/sync-core.test.ts` → Expected: PASS, `226 passed (226)`.
Run: `nice npm run type-check` → Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/utils/holdings-prices.ts src/utils/holdings-prices.test.ts shared/sync-host.ts shared/sync-core.ts shared/sync-core.test.ts
git commit -m "Holdings: keep the cost of a hand-priced fund and put its price back (#83)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Dividends — the snapshot in force when the window opens

**Files:**
- Modify: `shared/dividends.ts:161-190` (`SNAPSHOT_WINDOW_DAYS`, `snapshotDatesToRead` and its doc)
- Test: `shared/dividends.test.ts`, `shared/sync-core-dividends.test.ts`

**Interfaces:**
- Consumes: nothing new. `shared/sync-core.ts`'s `snapshotReads` already lists `SNAPSHOT_WINDOW_DAYS` back from today and needs no change.
- Produces: `SNAPSHOT_WINDOW_DAYS = 730`; `snapshotDatesToRead(days, dividendDate)` with the same signature and one more candidate.

- [ ] **Step 1: Write the failing tests**

In `shared/dividends.test.ts`, in `describe('a position bought and sold between two dividends')`:
- the first test becomes:

```ts
  it('reads snapshots on or within 60 days before the dividend: the last before a sale first, then newest first, then the one in force when the window opens', () => {
    expect(snapshotDatesToRead(days, '2027-03-10')).toEqual(['2027-02-10', '2027-02-25', '2027-01-20', '2026-12-01']);
    expect(snapshotDatesToRead(days, 'not a date')).toEqual([]);
  });
```

- "reads at most eight" becomes the first test below, and the second is new:

```ts
  it('reads at most eight, the one in force when the window opens last of all', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ date: `2027-02-${String(i + 1).padStart(2, '0')}`, positionCount: 3 }));
    expect(snapshotDatesToRead(many, '2027-03-01')).toHaveLength(8);
    expect(snapshotDatesToRead([{ date: '2026-12-01', positionCount: 3 }, ...many], '2027-03-01')).not.toContain('2026-12-01');
  });

  it('reads the snapshot in force when the window opens however old it is, since one is written only when holdings change', () => {
    // The window for a dividend on 2027-03-10 opens on 2027-01-09.
    const sparse = [{ date: '2026-03-02', positionCount: 2 }, { date: '2026-11-30', positionCount: 2 }, { date: '2027-02-25', positionCount: 1 }];
    expect(snapshotDatesToRead(sparse, '2027-03-10')).toEqual(['2027-02-25', '2026-11-30']);
    expect(snapshotDatesToRead([{ date: '2026-11-30', positionCount: 2 }], '2027-03-10')).toEqual(['2026-11-30']);
    // One dated the day the window opens is in it already.
    expect(snapshotDatesToRead([{ date: '2026-11-30', positionCount: 2 }, { date: '2027-01-09', positionCount: 2 }], '2027-03-10')).toEqual(['2027-01-09']);
  });
```

In `shared/sync-core-dividends.test.ts`, in `describe('a position bought and sold between two dividends')`, before "reads no snapshot while the other writer is not new enough":

```ts
    it('is booked from the snapshot in force when the window opens, though it is older than six months', async () => {
      // Held unchanged from June 2026 until the sale, so no snapshot in between.
      const sparse = {
        'wf-1': [
          { date: '2026-06-01', positionCount: 1, securities: [{ assetId: 'asset-voo', symbol: 'VOO' }] },
          { date: '2027-03-05', positionCount: 0, securities: [] },
        ],
      };
      const fh = createFakeHost(seed(VOO, { heldSecurities: { 'wf-1': [] }, snapshots: sparse }));
      await runSyncCore(fh.host, fh.store, { dividendSecurities: true });
      expect(theRow(fh)).toMatchObject({ activityType: 'DIVIDEND', assetId: 'asset-voo' });
    });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 shared/dividends.test.ts` → Expected: FAIL — `2 failed | 25 passed (27)`, with each list missing its last (in-force) date.
Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-dividends.test.ts` → Expected: FAIL — `1 failed | 18 passed (19)`, with the row still a DEPOSIT (2026-06-01 lies outside the 180-day listing).

- [ ] **Step 3: Implement in `shared/dividends.ts`**

- `SNAPSHOT_WINDOW_DAYS = 730`. Its doc now says it also covers the snapshot in force when a dividend's window opens, which can be long before it, since a snapshot is written only on a day the holdings changed (#83).
- `snapshotDatesToRead`: after the in-window candidates (the order is unchanged), append the newest listed day dated **on or before** the window's first day, but only when it isn't in the window itself (one dated exactly on the start already is). Then `.slice(0, SNAPSHOT_READS)` as before, so the in-force one is the first cut. Extend the doc comment to match.

- [ ] **Step 4: Run the tests**

Run: `nice npx vitest run --maxWorkers=2 shared/dividends.test.ts` → Expected: PASS, `27 passed (27)`.
Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-dividends.test.ts` → Expected: PASS, `19 passed (19)`.
Run: `nice npm run type-check` → Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add shared/dividends.ts shared/dividends.test.ts shared/sync-core-dividends.test.ts
git commit -m "Dividends: read the snapshot in force when the window opens (#83)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: #80 — the Amazon fallback offers the label rows' list

**Files:**
- Modify: `src/components/AmazonCard.tsx` (~196-210: the option lists; ~395-405: the fallback `<select>`; ~420-430: the label row's display logic)
- Test: `src/components/AmazonCard.test.tsx`

**Interfaces:**
- Consumes: `companionFilesAmazonSubcategories`, `amazonCategoryValue`, `findAmazonCategory`, `SYNC_BOOKKEEPING_CATEGORY`, `OPENING_BALANCES_CATEGORY` (already imported).
- Produces (component-internal):
  - `labelOptions: string[]`: every category except the two bookkeeping ones; subcategories only when `subcategories` is true; mapped with `amazonCategoryValue`, deduped, sorted with `localeCompare`. The old `options` constant goes away.
  - `shownAs(stored: string): { hit, entry, current, list }`: the label row's existing display logic, lifted out. `hit = findAmazonCategory(stored, categories)`; `entry` is the found entry; `current` is `amazonCategoryValue(entry)` when found and `subcategories`, else `stored`; `list` is `labelOptions`, with `current` prepended when it isn't in it.

- [ ] **Step 1: Write the failing tests**

In `src/components/AmazonCard.test.tsx`, inside `describe('AmazonCard')`, right before `it('explains that this cannot double-count a purchase', …)` (the file's `sub` helper is in scope there):

```ts
  describe('the category for anything unrecognized (#80)', () => {
    const configured = (defaultCategory: string) => vi.fn(async () => ({
      host: 'imap.gmail.com', user: 'r@g.com', password: 'x', defaultCategory,
    })) as any;
    const fallback = () => screen.getByLabelText(/Category for anything unrecognized/i) as HTMLSelectElement;
    const values = (select: HTMLSelectElement) => [...select.options].map((o) => o.value);

    it('offers the same list as the label rows: subcategories as Parent / Child, no bookkeeping', async () => {
      const props = makeProps({
        companionVersion: AMAZON_SUBCATEGORIES_SINCE,
        categories: [...catalog('Shopping', 'Housing', 'Sync bookkeeping', 'Opening balances'), sub('Clothing', 'Shopping')],
      });
      props.store.getAmazonConfig = configured('Shopping');
      render(<Harness {...props} />);
      await screen.findByDisplayValue('r@g.com');
      expect(values(fallback())).toEqual(['Housing', 'Shopping', 'Shopping / Clothing']);

      fireEvent.change(fallback(), { target: { value: 'Shopping / Clothing' } });
      fireEvent.click(screen.getByRole('button', { name: /Save Amazon Settings/i }));
      await waitFor(() => expect(props.store.setAmazonConfig).toHaveBeenCalled());
      expect((props.store.setAmazonConfig as any).mock.calls[0][0].defaultCategory).toBe('Shopping / Clothing');
    });

    it('offers top-level categories only while the companion is older, and no bookkeeping either', async () => {
      const props = makeProps({
        companionVersion: '1.73.0',
        categories: [...catalog('Shopping', 'Housing', 'Sync bookkeeping'), sub('Rent', 'Housing')],
      });
      props.store.getAmazonConfig = configured('Shopping');
      render(<Harness {...props} />);
      await screen.findByDisplayValue('r@g.com');
      expect(values(fallback())).toEqual(['Housing', 'Shopping']);
    });

    it('shows an old bare subcategory name as the option it files under, and saves it untouched', async () => {
      const props = makeProps({
        companionVersion: AMAZON_SUBCATEGORIES_SINCE,
        categories: [...catalog('Shopping'), sub('Home Goods', 'Shopping')],
      });
      props.store.getAmazonConfig = configured('Home Goods');
      render(<Harness {...props} />);
      await screen.findByDisplayValue('r@g.com');
      expect(fallback().value).toBe('Shopping / Home Goods');

      fireEvent.click(screen.getByRole('button', { name: /Save Amazon Settings/i }));
      await waitFor(() => expect(props.store.setAmazonConfig).toHaveBeenCalled());
      expect((props.store.setAmazonConfig as any).mock.calls[0][0].defaultCategory).toBe('Home Goods');
    });

    it('keeps a stored value that is not an option, as stored', async () => {
      // A subcategory with an older companion; a category since deleted.
      for (const [companionVersion, stored, list] of [
        ['1.73.0', 'Home Goods', ['Home Goods', 'Shopping']],
        [AMAZON_SUBCATEGORIES_SINCE, 'Gone', ['Gone', 'Shopping', 'Shopping / Home Goods']],
      ] as const) {
        const props = makeProps({ companionVersion, categories: [...catalog('Shopping'), sub('Home Goods', 'Shopping')] });
        props.store.getAmazonConfig = configured(stored);
        const { unmount } = render(<Harness {...props} />);
        await screen.findByDisplayValue('r@g.com');
        expect(fallback().value).toBe(stored);
        expect(values(fallback())).toEqual(list);
        unmount();
      }
    });

    it('flags an old bare name two subcategories share, as a label row does', async () => {
      const props = makeProps({
        companionVersion: AMAZON_SUBCATEGORIES_SINCE,
        categories: [...catalog('Hobbies', 'Shopping'), sub('Clothing', 'Hobbies'), sub('Clothing', 'Shopping')],
      });
      props.store.getAmazonConfig = configured('Clothing');
      render(<Harness {...props} />);
      await screen.findByDisplayValue('r@g.com');
      expect(fallback().value).toBe('Clothing');
      expect(screen.getByText(/fits 2 categories, pick the one you mean/i)).toBeTruthy();
    });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 src/components/AmazonCard.test.tsx`
Expected: FAIL — `5 failed | 24 passed (29)`. The fallback lists top-level names unsorted and with "Sync bookkeeping"; it shows the bare `'Home Goods'`; it lacks `'Shopping / Home Goods'`; there's no hint.

- [ ] **Step 3: Implement in `AmazonCard.tsx`**

- Replace `options` and the conditional `labelOptions` with the single `labelOptions` from Interfaces. Replace the "The fallback stays top-level…" comment with the new reasoning: the fallback offers the same list (#80), since it's also where a label with no rule starts, and someone who keeps e.g. a "Shopping / Amazon" subcategory wants unrecognized orders there too.
- Add `shownAs` with a doc comment carrying the label row's old explanation: a legacy bare name is shown as the option it files under, or flagged when it fits several; it's shown as stored while the companion is older, so leaving the dropdown alone can never save a path the companion can't read; and a value that isn't an option stays in the list, so leaving it alone never changes it. The label row uses `const { hit, entry, current, list: shown } = shownAs(resolved.category);` in place of its inline lines.
- The fallback `<select id="sfin-amz-default">` uses `value={fallback.current}` and lists `fallback.list`, where `fallback = shownAs(defaultCategory)`. `onChange` is unchanged. Below the select, when `fallback.hit.kind === 'ambiguous'`, render:

```tsx
              <div className="sfin-subtle">
                {`Fits ${fallback.hit.candidates.length} categories, pick the one you mean`}
              </div>
```
- No change to the Telegram label picker.

- [ ] **Step 4: Run the tests**

Run: `nice npx vitest run --maxWorkers=2 src/components/AmazonCard.test.tsx` → Expected: PASS, `29 passed (29)`.
Run: `nice npx vitest run --maxWorkers=2 src/tabs/SettingsTab.test.tsx` → Expected: PASS, `51 passed (51)` (it renders the card).
Run: `nice npm run type-check` → Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/AmazonCard.tsx src/components/AmazonCard.test.tsx
git commit -m "Amazon: the fallback category can be a subcategory (#80)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Docs, the forced-date run, every gate

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]`), `README.md` (four places)

- [ ] **Step 1: CHANGELOG**

Replace the empty `## [Unreleased]` section (the line, then a blank line, then `## [1.76.1] - 2026-11-15`) with:

```markdown
## [Unreleased]

### Fixed
- **A cost entered by hand on a holding is no longer wiped by the next sync
  (#83).** On accounts whose provider sends no cost (a deferred-comp plan, a
  529), every sync saved a holdings snapshot that put each position back at
  cost 0, so Wealthfolio showed "incomplete cost basis" again. Wealthfolio also
  sets an account's net contribution to 0 on every holdings snapshot it saves,
  its own holdings editor included, and read that drop as a withdrawal.
  - A snapshot is now saved only when the holdings changed: a share count, a
    cost SimpleFin sent, the cash, or the asset a holding is on. Prices are
    still written every sync. Wealthfolio's snapshot history gets an entry on
    those days only, and a net contribution you entered lasts until then.
  - A fund you price by hand keeps its cost like any other holding. Saving a
    snapshot makes Wealthfolio write the fund's cost as that day's price, so
    the sync puts the fund's price back afterwards: the one you entered for that
    day, else the latest before it. A fund with no price at all gets no cost
    carried, as before. If the price can't be put back, the sync says which
    fund, and it shows at its cost until its next price.
  - A dividend paid after a sale still finds its security in an older
    snapshot: the snapshot in force when the 60 days before the dividend begin
    is read too, and the add-on and the companion list two years of snapshots
    for it instead of six months.

  The snapshot and price changes are the add-on's (the companion writes no
  snapshots); the dividend change is in both halves.

### Changed
- **The Amazon "Category for anything unrecognized" can be a subcategory
  (#80).** It offers the same list as the label rows: subcategories as
  `Parent / Child` with a companion on 1.74.0 or later (which already files
  under them), top-level categories only with an older one, and never the
  sync's own bookkeeping categories (no longer offered to the label rows with
  an older companion either). A value saved by an older build shows as the
  category it files under, and leaving the dropdown alone never changes what
  is saved. Add-on only.

## [1.76.1] - 2026-11-15
```

- [ ] **Step 2: README**

1. "### Syncing": after the paragraph ending "Snapshots still need Wealthfolio open in a browser at least once a day.", add a paragraph:

```markdown
A snapshot is saved only on a day an account's holdings changed: a share
count, a cost the provider sent, the cash, or the asset a holding is on.
Wealthfolio sets an account's net contribution to 0 on every holdings snapshot
it saves (its own holdings editor does the same), so a snapshot every day undid
a net contribution entered by hand. Prices are written every sync either way.
```

2. "### Dividends on their security": "or in its holdings snapshots from the weeks before the dividend." becomes "or in its holdings snapshots from the weeks before the dividend, or the last one before those weeks (a snapshot is saved only when holdings change)."

3. "### Cost of investment positions": replace the sentence "A cost Wealthfolio holds in another currency than the feed's is not carried (each day's snapshot is then written without one, so a cost entered by hand does not last for such a holding)." with the text below, and rewrap the paragraph to the file's ~80 columns:

```markdown
A fund you price by hand in Wealthfolio keeps its cost
too. Saving a snapshot makes Wealthfolio write a hand-priced fund's cost as
that day's price, so the sync then puts the fund's price back: the one you
entered for that day, else the latest before it. A hand-priced fund with no
price at all gets no cost carried. If the price can't be put back, the sync
reports the fund by name, and it shows at its cost until its next price. A
cost Wealthfolio holds in another currency than the feed's is not carried (a
snapshot saved then is written without one, so a cost entered by hand lasts
only until the holdings next change).
```

4. "### Amazon auto-categorization": after "Anything unmatched goes to a configurable default *and* is announced once in Telegram.", add: "The default is the card's **Category for anything unrecognized**, picked from the same list as the labels: a subcategory too (`Parent / Child`), with a companion on 1.74.0 or later."

Run: `nice npx vitest run --maxWorkers=2 shared/release-guards.test.ts` → Expected: PASS, `6 passed (6)`.

- [ ] **Step 3: Run every new and touched test file with the date forced to 2027**

A throwaway setup file fakes `Date` before the test files load and before every test. Delete it afterwards; none of it is committed.

```sh
cat > zz-2027.setup.ts <<'EOF2'
import { beforeEach, vi } from 'vitest';
const forced = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-06-01T12:00:00Z')); };
forced();
beforeEach(forced);
EOF2
cat > zz-2027.config.mts <<'EOF2'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', globals: true, testTimeout: 15000, setupFiles: ['./src/test-setup.ts', './zz-2027.setup.ts'] } });
EOF2
for tz in UTC America/Los_Angeles; do TZ=$tz nice npx vitest run --maxWorkers=2 --config zz-2027.config.mts shared/holdings.test.ts src/utils/holdings-prices.test.ts shared/sync-core.test.ts shared/dividends.test.ts shared/sync-core-dividends.test.ts src/components/AmazonCard.test.tsx; done
rm zz-2027.setup.ts zz-2027.config.mts
git status --short
```

Expected: PASS twice — `6 passed (6)` files, `427 passed (427)` tests (69 + 57 + 226 + 27 + 19 + 29). `git status --short` lists only ` M CHANGELOG.md` and ` M README.md`. (Don't use a zone past UTC+11: `shared/sync-core.test.ts`'s existing "hands the mapped account one snapshot…" pins a noon-UTC balance date, which is the next day there. This was the case before this plan too.)

- [ ] **Step 4: Run every gate**

```sh
nice npx vitest run --maxWorkers=2
(cd companion && nice npx vitest run --maxWorkers=2)
nice npm run type-check
nice npm --prefix companion run build
```

Expected: root `212 passed (212)` files, `4722 passed (4722)` tests (4688 before this plan, +34, including the lead's two amendment tests); companion `77 passed (77)` files, `1750 passed (1750)` tests (unchanged); type-check and the companion build exit 0.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md README.md
git commit -m "Docs: #83 holdings cost and #80 Amazon fallback" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage

| Spec line | Task |
|---|---|
| A: compare `written` with the holdings read after the check resolves ids | 2 (`sameAsHeld` from 1) |
| A: same set of assets; a sold position writes | 1 (unit), 2 ("a position sold") |
| A: share counts exactly equal as decimals; unrepresentable → different | 1 |
| A: SimpleFin's cost within $0.01; carried cost not compared | 1, 2 ("a cost SimpleFin sent") |
| A: cash per currency to the cent, from cash lines (`holdingType`); unreadable → write | 1, 2 |
| A: firstMove / movedBack / shared→existing per-account write; staying put doesn't | 2 (new test + existing move tests), 2 (plan-fund skip) |
| A: skip counts in `skipped`; step 5 still runs | 2 |
| A: existing same-date skip unchanged | existing tests pass in 2 |
| A: dividends in-force candidate, lowest priority within `SNAPSHOT_READS`; listing reaches it | 4 |
| B: carry onto MANUAL/unreported shared, same rules (keep / add at price / ask) | 3 |
| B: same-day quote exactly, else latest earlier; no quote → no carry | 3 |
| B: restore with `manualQuote` (same id), quote's currency; retry once; error copy | 3 |
| B: `kept` prefers a same-day quote | 3 |
| B: no mode change, no move | 3 ("carries the cost, then puts back…") |
| #80: same list as label rows, gated, no bookkeeping; legacy shown as it files; current kept; comment replaced | 5 |
| CHANGELOG [Unreleased] + README | 6 |
