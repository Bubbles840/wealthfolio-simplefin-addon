# Transfer Detection, Card Refund Typing & Drift Warning — Design

**Date:** 2026-07-11
**Status:** Approved pending user review

## Problem

Transfers between synced accounts (e.g. a credit-card payment from checking)
import as WITHDRAWAL + DEPOSIT. Wealthfolio counts the checking-side
WITHDRAWAL as an expense and ignores the card-side DEPOSIT, so card payments
double-count against spending (the purchases were already counted when they
posted to the card). Wealthfolio's fix for this is first-class: type both
sides TRANSFER_OUT / TRANSFER_IN and link them (shared `source_group_id` via
`POST /api/v1/activities/link`); linked pairs classify as InternalTransfer and
are excluded from spending/income analytics. **Unlinked** transfers on cash
accounts still count as expense/income, so linking is required, not optional.

Two adjacent gaps ride along:

1. **Card refunds:** a merchant refund on a credit card imports as DEPOSIT,
   which Wealthfolio's classifier ignores on CREDIT_CARD accounts. Typed as
   CREDIT it classifies as ExpenseRefund and nets against spending.
2. **Balance drift:** the starting-balance correction is one-time; nothing
   detects later drift between SimpleFin's reported balance and Wealthfolio.

## Decisions (user-approved)

- Detection: **both** automatic pair-matching and description rules.
- The in-app addon sync types transfer pairs but cannot link (SDK gap); the
  **companion links them** via a reconciliation sweep each run.
- Existing mistyped rows: **fixed manually** by the user; no migration code.
- Scope adds: **card-refund typing** and **drift warning** both included.

## Design

### 1. Type resolution order (shared, both syncers)

For each fetched transaction, the activity type resolves in priority order:

1. **User rule match** (existing `mapTransaction` rules) — always wins; never
   overridden by auto-pairing.
2. **Auto-detected transfer pair** — negative side TRANSFER_OUT, positive side
   TRANSFER_IN.
3. **Account-type default:**
   - CASH (and any non-card account): positive → DEPOSIT, negative →
     WITHDRAWAL (today's behavior).
   - CREDIT_CARD: negative → WITHDRAWAL; positive → TRANSFER_IN when the
     description matches payment keywords (`/payment|autopay|thank you|e-?pay/i`),
     otherwise **CREDIT** (refund).

The payment-keyword heuristic applies **only** to positive amounts on
credit-card accounts. On cash accounts "payment" is too generic (rent payment
= real expense). An unlinked keyword-typed TRANSFER_IN on a card classifies as
neutral — never income — so a false keyword hit is harmless to analytics.

Account types come from data both syncers already fetch: the addon's
`accounts.getAll()` (already called for balances) and the companion's
`GET /api/v1/accounts` (`accountType` field).

### 2. Pair matching algorithm (`shared/transfers.ts`)

Input: all post-filter transactions of one sync batch, across all mapped
accounts, plus each transaction's resolved-so-far type source (rule vs
default).

- Candidates: transactions whose type came from defaults (rule-typed
  transactions are excluded).
- A pair = two candidates in **different** accounts, equal absolute amount
  (cent precision), opposite signs, posted dates within **3 days**.
- Greedy matching, nearest posted-date first; each transaction pairs at most
  once. Ambiguity (two equal candidates) resolves to the earliest by date,
  then stable input order — deterministic across runs.
- Output: type overrides (TRANSFER_OUT / TRANSFER_IN) plus the list of pairs
  (by SimpleFin tx id) for the linking step.

Cross-currency pairs are out of scope (amounts won't match; falls back to
default typing).

### 3. Linking (companion only)

Linking happens exclusively via the reconciliation sweep (§4), which runs
immediately after import in the same cycle — pairs imported this run are
linked seconds later. (Amended from the original import-response-ID design:
id population in the import response is not contractually guaranteed, and
the sweep is required anyway for addon-imported pairs.)

### 4. Reconciliation sweep (companion, each run)

After linking, the companion fetches recent activities for the mapped
accounts (`POST /api/v1/activities/search`, window = lookback + 7 days),
filters to TRANSFER_IN / TRANSFER_OUT rows with no `sourceGroupId`, re-runs
the pair matcher over them, and links matches. This covers:

- pairs imported by the in-app addon sync (which cannot link),
- pairs whose link call failed on a previous run,
- pairs the user typed manually in the UI but didn't link.

### 5. Drift warning (companion, each run)

For accounts already balance-initialized, reuse the starting-balance
arithmetic as a check instead of a correction:
`drift = simplefinBalance − nonDuplicateWindowDelta − wealthfolioValuation`.
If `|drift| > $1.00`, log a warning naming the account and the amount. No
automatic adjustment (avoids fighting Wealthfolio's async valuation recalc);
the log line tells the user exactly what to look at.

### 6. Error handling

- Pair matching is pure and total — no failure modes beyond empty output.
- Link and search calls: caught per-call, logged, counted as non-fatal (do
  not block `lastSyncAt` advancement — transactions themselves imported).
- Accounts fetch failure already skips balance logic; it now also skips
  refund typing's account-type lookup — unknown types fall back to CASH-style
  defaults for that run.

### 7. Testing

- `shared/transfers.test.ts`: pairing — basic pair, amount mismatch, same
  account excluded, >3-day gap excluded, ambiguity determinism, rule-typed
  exclusion, multiple pairs, unpaired remainder.
- Mapper tests: credit-card refund → CREDIT, card payment keyword →
  TRANSFER_IN, cash behavior unchanged.
- Companion tests: link called per pair after import; link failure non-fatal;
  reconciliation links unlinked pairs from search results; drift warning
  logged when valuation disagrees.
- Addon test: detected pair imports with transfer types (no link attempted).

## Known limitations (accepted)

- If a transfer's two sides post in different sync windows, the earlier side
  keeps its WITHDRAWAL/DEPOSIT type (recurring transfers are best handled by
  a description rule; one-off stragglers are a manual edit + UI link).
- Cross-currency transfers are not matched.
- The in-app sync's pairs stay unlinked (counting in spending) until the next
  companion run or a manual UI link.
- The reconciliation sweep can link a keyword-typed card TRANSFER_IN to an
  unrelated cash TRANSFER_OUT if their amounts and dates coincide — the same
  amount+date collision risk the pair matcher already accepts.
