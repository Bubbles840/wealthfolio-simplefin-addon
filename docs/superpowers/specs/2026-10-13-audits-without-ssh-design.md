# Audits without SSH — design

Nick approved this design section by section on 2026-10-13. It is piece **2c**
of project 2 ("Trust & control") of the roadmap approved on 2026-10-12, and the
last piece of project 2. Piece 2b ("Why is this here?") left "a wrong account
balance" to this piece.

**Nick's goal**, from the trust goals he picked: "The checks you currently run on
the server (ledger audit, headline audit) available from the app or Telegram
instead."

**What he chose** (all four):
- why a balance is off;
- why "$X left" differs from Wealthfolio's figure;
- what Wealthfolio's Health page flags;
- the fix tools.

**Two releases from one spec:**
- **R1 — Explain.** Three read-only checks, in Telegram and the app.
- **R2 — Fix.** Link transfer pairs, and remove a transaction the bank reported twice, in Telegram and the app. Both are logged in the change log and can be undone.

## Decisions

| Question | Decision |
|---|---|
| Scope | All four: balance, "$X left", Health, and fixes. |
| Where | **Both**, including **fixes in both** surfaces. |
| Approach | Shared pure checks. Telegram's `/audit` runs them **live**. The app reads a **snapshot** the companion publishes after each sync. App fixes act on the snapshot only after re-reading the rows involved. |
| Releases | R1 Explain, then R2 Fix. Each has its own plan. |
| Fix confirmation | Link: the list is the preview, and one tap acts. Remove for good: two taps (it deletes your data). Every fix is in the change log, with Undo. |
| Kept on the server | Creating a missing transfer leg and the phantom `$CASH` asset cleanup (asset-level writes). The `companion/tools` scripts stay for deep dives. |

## What exists today (facts this design builds on)

**The server tools.** These live in `companion/tools/*.mjs` and are piped into `docker exec -i simplefin-sync node --input-type=module`, from a commit-pinned raw URL. They take no CLI arguments; configuration is by environment variable. Output is human-readable text.

| Tool | Writes? | What it does |
|---|---|---|
| `audit.mjs` | No | Per account: SimpleFin balance, Wealthfolio valuation, drift, row counts. Transfers by type, this month's uncategorised rows, FLAGS. |
| `audit-headline.mjs` | No | Six reasons the report's "$X left" differs from Wealthfolio's: <br>• rows dated the 1st at midnight UTC <br>• future-dated rows <br>• bookkeeping rows <br>• excluded categories <br>• rows filed under two categories <br>• uncategorised refunds |
| `audit-health.mjs` | No | The ledger as Wealthfolio's Health and Spending pages read it: <br>• incomplete transfer legs <br>• starting balances dated after the earliest row <br>• phantom `$CASH` rows <br>• monthly categorised vs uncategorised spending <br>• each cash account's ledger against the bank |
| `audit-pairs.mjs` | No | Splits a card's ledger into posted and pending. Lists unlinked inflows next to same-amount outflows. |
| `audit-categories.mjs` | No | Reconciles every account from the ledger (the only way to check a card), plus a category dump. |
| `fix-transfers.mjs` | Yes (`APPLY=1`) | Links the incomplete legs Health flags. Match rule: same amount to the cent, opposite direction, another account, within `MATCH_DAYS=5`, unique both ways. Retypes a counterpart stored as DEPOSIT/CREDIT/WITHDRAWAL. Can create a missing leg. Cleans up `$CASH`. |
| `skip-transaction.mjs` | Yes (`APPLY=1`) | `TX=TRN-…`: appends to `skipped_transactions`, then deletes the stored row. Refuses on a companion older than 1.58.0. |

**Checks that already run automatically.** The companion's daily self-check (`shared/self-check.ts`) and ledger checks (`shared/ledger-checks.ts`, with facts in `companion/src/ledger-facts.ts`, "each began as a hand-run audit script") cover:
- sync health and version skew;
- feed staleness;
- non-card balance drift;
- unlinked, stuck and held transfers;
- missing legs;
- card balance against the bank;
- idle refunds.

They show in the 08:00 digest and the 🧹 findings menu.

**Balances.** The bank's figure is SimpleFin's posted balance, kept per account in the `account_balances` secret (`AccountBalanceSnapshot`: `balance`, `date`, `drift`, `measured`, `driftSince`, `baselineFix?`).
- **Cash accounts:** the Wealthfolio figure is `/valuations/latest`.
- **Cards:** it is the ledger summed by `getNativeAccountBalances`, which excludes pending rows and skips accounts holding a placeholder.
- **Drift:** measured only on a clean run (`measured` keeps "not checked" apart from "in sync").
- **The app's account list and `/status`** show the BANK balance and a chip: "off by $X" / "in sync" / "not checked". **Nothing in the app or Telegram shows the Wealthfolio figure or what makes up a gap.**

**Surfaces:**
- **Telegram:** `/status` (bank balance plus chip per account). The `cz:` menu conventions are legacy Markdown, stateless menus and 64-byte callback data.
- **App:**
  - Settings shows the account list, the change log and Your overrides.
  - The Budget tab's report shows "$X left" and the Data check card ("✓ Your budget matches the ledger" compares the cube with the digest readers, not with Wealthfolio).
  - Home shows the Accounts tile.

**Reusable from earlier pieces:**
- the strict, read-only DB reader with the `\x1f` CLI separator (2b);
- the change log with Undo, the create-first linker `linkPairByRecreate`, the corrupt-safe skip-list and overrides edit paths (2a);
- the story view's actions area (2b).

## A. R1 — Explain

### A1. The balance explanation (one account)

```
PNC Checking
Bank: $2,481.07 (Oct 13)   Wealthfolio: $2,431.07   Off by $50.00
• $38.20 in 2 pending charges the bank hasn't posted
• $11.80 not explained by anything the add-on knows
Includes: starting balance $1,204.00 (Aug 2) · 1 correction, +$12.40 (Sep 30)
```

- **Header line:**
  - the bank's figure and its date;
  - Wealthfolio's figure: the valuation for cash accounts, the full ledger total for cards;
  - "Off by $X", or "Matches the bank."
- **Named causes.** Each shows an amount and a count, and appears only when non-zero:
  - pending charges the bank hasn't posted;
  - transfers held waiting for their other half;
  - rows dated after the bank's balance date ("the bank's figure is from Oct 10");
  - card payments still unlinked.
- **"Not explained by anything the add-on knows":** whatever the named causes don't cover.
- **"Includes":** the starting balance (amount and date) and the corrections (count, total and the latest date).
- **Special cases:**
  - An account with no bank balance: "The bank hasn't sent a balance for this account."
  - An unmapped account isn't listed.

### A2. The "$X left" breakdown (this month)

- The report's "$X left" and Wealthfolio's Spending total for the month, side by side.
- The difference is broken into `audit-headline.mjs`'s six reasons. Each shows its amount, plus its rows (date, description, amount, account) when opened.
- Reasons with nothing in them are left out.
- When the two agree: "The report and Wealthfolio agree this month."

### A3. Health issues

What Wealthfolio's own Health page would flag, each with what to do:

- **Incomplete transfer legs.** Each shows its likely other half when EXACTLY one candidate matches `fix-transfers.mjs`'s rule: same amount to the cent, opposite direction, another account, within 5 days, unique both ways. In R1 the line says "Likely the other half: …". R2 adds the Link button.
- **Phantom `$CASH` rows:** "Wealthfolio files these under a $CASH asset. Clean-up needs the server tool fix-transfers.mjs."
- **Starting balances dated after the account's earliest row:** "A deep scan moves it to the day before your earliest transaction."
- **Nothing to report:** "Wealthfolio's Health page has nothing to flag."

### A4. Telegram

- **`/audit`** opens a stateless menu (prefix `cz:au:`) with three entries:
  - Balances: one line per account, tap for A1;
  - "$X left": A2;
  - Health (N): A3.
- Every tap re-reads, and checks run live.
- Bank text is escaped and kept outside bold/italic.
- Callback data stays at or under 64 bytes. Accounts, reasons and issues travel as short `findingHandle`s.
- `/status`'s "off by $X" lines get a 🔎 button that opens A1 for that account.
- `/audit` joins /help's More commands, not the seven-command ☰ menu.

### A5. App

- **Settings → account list:** an "off by $X" chip opens A1 for that account in place.
- **Budget tab:** next to "$X left", a "Why is this different from Wealthfolio?" link opens A2 in place.
- **Settings → new Checks card:** A3 with a count. Home's Accounts tile links to it when there are issues.
- **Data source:** the app reads the companion's snapshot (B2) and says when it was taken ("as of the 2:00 PM sync").
  - Older than 2 days: "These checks are from Oct 11 — the companion hasn't synced since."
  - No companion: "These checks need the companion."
  - Unreadable snapshot: "Couldn't read the checks — run /audit in Telegram."
- **Copy:** no emoji in app copy. Each `.sfin-*` CSS rule appears once at column 0.

## B. How it's built

### B1. Shared checks (pure)

| Module | Function | Returns |
|---|---|---|
| `shared/audit-balance.ts` | `explainBalance(facts)` | `{ bank, wealthfolio, offCents, causes[], unexplainedCents, includes, notes[] }` |
| `shared/audit-headline.ts` | `explainHeadline(facts)` | `{ reportCents, wealthfolioCents, reasons[], notes[] }` |
| `shared/audit-health.ts` | `healthIssues(facts)` | `{ issues[], notes[] }` |

- In `explainHeadline`, each reason carries `{ kind, cents, rows }`.
- In `healthIssues`, an incomplete-leg issue carries its unique counterpart when there is one.
- Every fact is optional. A failed read adds a note and leaves out only its own part.
- Bank and user text is RAW. Telegram escapes it at render, and the app renders it as text.

### B2. Companion

- **`companion/src/audit-facts.ts`** gathers each check's facts:
  - read-only SQLite through the strict reader (`\x1f` separator), using queries ported from the `companion/tools` scripts;
  - REST for valuations;
  - the `account_balances`, `account_mapping` and report-cube secrets.

  The scripts stay as they are.
- **The `audit_snapshot` secret** is written after each sync:
  - shape: `{ v: 1, at, balances: { [wfAccountId]: … }, headline: …, health: … }`;
  - size budget about 100 KB, pinned by a worst-case test;
  - row lists are trimmed first, with "and N more";
  - the companion is its ONLY writer;
  - publishing is best-effort: it never fails or changes a sync, and a failed publish keeps the previous snapshot.
- **`companion/src/audit-menu.ts`** holds `/audit`, the `cz:au:` menu and the 🔎 buttons on `/status`.

### B3. App

- A new optional-called SecretsStore method reads `audit_snapshot` corrupt-aware (ok | absent | corrupt).
- Components render A1/A2/A3 from the snapshot:
  - A1 inline in the account list;
  - A2 next to "$X left" in the report;
  - A3 in a new `ChecksCard` in Settings.

## C. R2 — Fix

### C1. Link transfer pairs

- **Where:** in `/audit` → Health and on the app's Checks card.
  - Each incomplete leg with a unique counterpart shows the pair and a **Link** button.
  - With two or more, **Link all N** appears too.
  - The list is the preview, so one tap acts.
- **How:**
  - `linkPairByRecreate` (create-first) re-creates both rows as a transfer pair.
  - A card's outflow is created as a WITHDRAWAL (v1.55).
  - A counterpart stored as an ordinary row gets the right type.
  - On the add-on, the pair is recorded in its `linked_groups` ledger.
- **Safety, checked right before writing:**
  - Both rows are re-read by id. Telegram reads live; the app reads through the SDK.
  - Nothing is written, and the reply is "It has changed since — nothing was linked.", when either row:
    - changed account, amount, date or type;
    - is already linked (or may be, on the add-on, per 2a's "maybe linked" rule);
    - has a `notTransfer` override.
- **Logging:** each link is a `transfer-link` change entry with actor "you". The existing Undo unlinks it.

### C2. Remove a transaction the bank reported twice

- **Where:** a **Remove for good…** action on a transaction's story (`/why` and the app's story view).
- **Two taps:**
  1. The first explains: "Deletes this row and stops the bank feed importing it again. Undo puts it back."
  2. **Remove** acts.
- **What it does:** deletes the row and adds it to the skip list through the corrupt-safe edit path (2a).
- **Logging:** the change entry keeps the row's full create payload. Undo re-creates it exactly and takes it off the skip list, even after the bank stopped sending it. Redo removes it again.
- **Refused:**
  - half of a linked (or maybe-linked) transfer: "Unlink it first."
  - a held transfer, a starting balance or a correction;
  - a row not from the bank feed;
  - an unreadable skip list: "Couldn't save the skip list — nothing was changed."
- **Safety:** right before writing, the row is re-read. If it changed: "It has changed since — nothing was removed."

### C3. Left to the server

Creating a missing transfer leg and the `$CASH` asset clean-up stay in `fix-transfers.mjs`. Health says so in plain words.

## D. Failures, testing and releases

### D1. Failures

- **Reads:** every read is wrapped on its own. A failed read says so and is never treated as "nothing wrong".
- **Drift:** "not checked" stays distinct from "in sync".
- **Cards:** pending rows are their own cause, never hidden inside the total.
- **The snapshot:** a corrupt snapshot is reported, never shown as empty.
- **Fixes** write only through the existing paths:
  - the create-first linker;
  - the corrupt-safe skip-list edit;
  - the change log.

### D2. Tests

- **Checks:** fixtures ported from the scripts' known cases:
  - each of the six "$X left" reasons;
  - each balance cause and the unexplained remainder;
  - each Health issue kind;
  - a counterpart that matches two rows, which must NOT be offered.
- **Reads:** each read failing on its own.
- **Snapshot:** a worst-case snapshot inside its budget.
- **Telegram:**
  - escaping, with Markdown characters in a bank name;
  - every callback ≤ 64 bytes;
  - routing before the categorize fallthrough;
  - stateless taps.
- **App:**
  - rendering;
  - a stale, missing or corrupt snapshot;
  - no emoji;
  - each CSS rule once.
- **R2:**
  - a changed row is refused on both hosts;
  - a linked row, an override, or a sync-managed row is refused;
  - Undo round trips: link then undo unlinks; remove then undo re-creates the exact row and un-skips it;
  - the two-tap remove.
- **Dates:** every test that renders a date pins it.

### D3. Releases

- R1 and R2 each have their own plan, review and release notes.
- R2 depends on R1's snapshot and Health matching.
- Each updates the CHANGELOG under [Unreleased], the README, and `docs/superpowers/follow-ups.md` section 11.
- Gates:
  - `npm test`
  - `npm --prefix companion test`
  - `npm run type-check`
  - `npm --prefix companion run build`

## Out of scope

- New detection: the daily self-check and ledger checks already find these problems.
- Creating a missing transfer leg, and the `$CASH` asset clean-up (they stay on the server).
- Notifications: no new digest lines. The 🧹 menu stays as it is.
- Deleting or replacing the server scripts.
