# Line up with Wealthfolio, and paybacks — design (1.62.0)

> **Approved by Nick on 2026-10-14.** He asked to "make sure things line up with
> Wealthfolio to the best of their ability" and chose "fix the cause + match +
> tripwire". He also approved the Venmo payback fix, items 1–5, and asked for paybacks from inside the app too ("since we have the newer add-on permission"). The rulings
> below fill in what that choice leaves open, and each one says what it costs if
> it is wrong.

## Why

**The Checks card showed the gap on 2026-10-14.** The report counted $2,292.06
spent this month, and Wealthfolio's Spending page counted $3,243.51. Two causes
explained all of it:

- **−$48.55 — dates.** The sync writes a bare date, which older Wealthfolio
  stores at 00:00 UTC. West of UTC, that is the previous evening, so Wealthfolio
  counts a row dated the 1st in the month before.
- **+$1,000.00 — the add-on's bookkeeping.** This row is a transfer waiting for
  its other half, or a balance correction. Wealthfolio counts it as spending.
  The report drops it, rightly.

**The audit knows three more causes that can appear any month:**

- a category Wealthfolio is set to exclude, which the report still counts;
- a row filed under two categories, which the report counts twice;
- a refund with no category, which Wealthfolio subtracts and the report
  ignores.

**A Venmo payback cannot be filed under Restaurants.** Since 3.9, Wealthfolio
decides which categories a row can take from the row's type. A cash `DEPOSIT`
is always income. Only a `CREDIT` marked `REIMBURSEMENT`, `REFUND` or `REBATE`
offsets spending (upstream `classify_activity`). The bot's "Spending
categories »" button on a money-in row was therefore a dead end, and it showed
Wealthfolio's raw error. A hand edit in Wealthfolio does not help: the next
sync turns the row back into a deposit, because its type differs from the
feed's.

## Rulings

| # | Decision | Cost if wrong |
|---|---|---|
| W1 | **New rows are written at 12:00 UTC on the bank's date** (`YYYY-MM-DDT12:00:00Z`), never as a bare date. That instant falls on the bank's date in every zone from UTC−11 to UTC+11, on every Wealthfolio version (3.10 keeps a timestamp as sent). Every reader in the add-on already takes the first 10 characters, so no existing comparison changes. | Zones beyond ±11 h land a day off, as they do today. |
| W2 | **A one-time repair moves rows stored at exactly 00:00 UTC to 12:00 UTC on the same date.** It runs on the companion. It skips any row in a group (linked transfer legs): Wealthfolio copies an updated leg's note and date onto its partner, and transfers are neutral to spending anyway. The repair is batched, logged as one bookkeeping change-log entry per run, and marked done in a secret so it runs once. It is re-runnable with `/audit`'s tools if it is interrupted. | A linked leg keeps showing the previous day in Wealthfolio's activity list. |
| W3 | **The sync's bookkeeping rows are filed under an excluded category, "Sync bookkeeping".** These are transfers in transit, balance corrections and starting balances. The companion creates the category in the spending taxonomy and adds it to Wealthfolio's excluded categories, the same way it already does for "Opening balances" (3.9+). Only rows in the spending bucket can take it; an income-bucket placeholder cannot, and it does not touch spending. When a placeholder links (it is re-created) or expires into an ordinary deposit or withdrawal, its bookkeeping filing goes with it or is removed, so the real row is uncategorized as it should be. | Wealthfolio's Income page still counts an inbound transfer in transit. |
| W4 | **The report counts spending exactly as Wealthfolio's Spending page does.** That means the same classification by effective type, subtype and account type. A category Wealthfolio excludes is left out, together with its descendants. A row filed under several categories counts once, under its earliest spending filing. A refund with no category is subtracted under "Uncategorized". The audit's model of Wealthfolio's side becomes the report's definition, and both are read from one shared place so they cannot drift. | Nothing found yet that Wealthfolio counts and the add-on should not. |
| W5 | **Tripwire.** After every companion sync, the month's report total is compared with Wealthfolio's own `/spending/insight` figure. More than a cent apart becomes a finding: the daily report says "⚠️ The report and Wealthfolio differ by $X this month — /audit explains", and the app's status strip shows it. It is never silent. The finding clears itself when the two agree. | One extra REST read per sync. |
| W6 | **Paybacks: picking a spending category for a money-in row files it as a payback.** On a CASH account, a `DEPOSIT` filed through `/categorize`'s spending grid becomes a `CREDIT` with subtype `REIMBURSEMENT`, and then takes the category. The reply reads "Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending." The button is renamed **It's a payback »**. Rows that are transfers, linked or pending are refused in their own words. | — |
| W7 | **The sync keeps a payback.** A new per-transaction override, `asReimbursement`, makes the sync plan that transaction as `CREDIT`/`REIMBURSEMENT` instead of reverting it. It is change-logged, and Undo removes the override, turns the row back into a `DEPOSIT` and unfiles it. | — |
| W8 | **Version gate: `PAYBACK_SINCE = 1.62.0`.** A 1.61 reader ignores an unknown override flag and would revert the type. Telegram's payback, its Undo and its Redo therefore need an installed add-on of 1.62.0 or newer; the refusal names the app's Change log. The app's Undo of a payback needs a companion of 1.62.0 or newer. The same pattern as `VENMO_NOTE_SINCE`. | Until both halves are updated, paybacks are refused, with the reason given. |
| W9 | **No raw Wealthfolio error on a category refusal.** Any bucket refusal from `assignActivityCategory` maps to the add-on's plain sentences, which `/recategorize` already uses. | — |
| W10 | **"Make every <pattern> deposit a payback" (item 5).** After a payback is filed, the Filed screen offers this instead of "Make this a rule". It creates two rules: an add-on transaction rule that carries the `REIMBURSEMENT` classifier for that description pattern, which the sync applies on import, and a Wealthfolio category rule for the chosen category. Both are change-logged with Undo, and it is scoped to the account like project 3's rules. | One payee's deposits may be mixed (some paybacks, some not); the preview shows how many it would catch. |
| W11 | **Paybacks in the app, too.** A money-in row in the needs-a-category list (and its story) gets **It's a payback…**: pick a spending category; the add-on re-types the row (`activities` write it already has), records the `asReimbursement` override, and files it. The add-on SDK has no "file this one transaction" call, so the filing goes through an add-on-owned one-off categorization rule matching the row's unique transaction id, run at once with `rerunRules(true)` (uncategorized only) and deleted after — Wealthfolio records it as a rule filing. Change-logged; the app's Undo of a payback says "Undo this from Telegram: /changes" (the SDK cannot un-file — the 2a rule for category kinds). Gated like W8 on the companion's version. | The filing shows as "rule" in Wealthfolio, not "manual". |
| W12 | **Adopt add-on SDK 3.9.** `@wealthfolio/addon-sdk` 3.9.0 and the manifest permissions its spending calls need; `minWealthfolioVersion` stays 3.8.0 — the payback action appears only when the host offers the spending API (feature-detected), so 3.8 installs keep working without it. | A 3.8 user does not get app paybacks (they need 3.9+). |

## Testing

- **Dates (W1):** a created row's `activityDate` is `…T12:00:00Z`. The sync
  never rewrites a 00:00Z row for its date alone. A forced-2027 check, with the
  dates pinned.
- **The repair (W2):**
  - it skips grouped rows;
  - it runs only once (the marker);
  - a partial failure is reported and re-runnable;
  - it touches nothing that isn't at 00:00Z.
- **Bookkeeping (W3):** a placeholder is filed on creation. When it links, the
  re-created rows carry no bookkeeping filing. When it expires, the filing is
  removed. A starting balance is excluded on both sides.
- **The report (W4):** the audit's reason matrix becomes a "both sides agree"
  matrix. Every case where they used to differ — excluded, double-filed,
  uncategorized refund, first-midnight — is now equal.
- **The tripwire (W5):**
  - equal gives no line;
  - a $0.01 difference gives no line;
  - $0.02 gives the line;
  - a failed read gives no confident claim.
- **Paybacks (W6–W10):**
  - the retype plus file;
  - the refusals;
  - the sync keeps the override;
  - Undo and Redo;
  - the version gates on both sides;
  - the two-rule offer and its preview count;
  - Telegram escaping, and every callback ≤ 64 bytes.

## Release

- **Version and changelog:** 1.62.0. CHANGELOG under [Unreleased], and
  follow-ups §16.
- **Release order:** the add-on and the companion together. The repair runs on
  the first companion sync after deploy.
- **Gates:**
  - `nice npm test`
  - `(cd companion && nice npx vitest run)`
  - `nice npm run type-check`
  - `nice npm --prefix companion run build`
  - the real-sqlite3 CLI test.

## Out of scope

- **Matching Wealthfolio's Income page.** The tripwire compares spending only.
  An inbound transfer in transit still counts as income there (W3).
- **Filing any row from the app** (not just paybacks) — the same SDK route
  would allow it; a later release.
