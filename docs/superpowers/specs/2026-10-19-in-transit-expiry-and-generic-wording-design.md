# In-transit rows always settle; generic transfer wording needs corroboration — design (1.65.0)

> **Approved by Nick on 2026-10-19** ("let's do A, B, and C"), after reviewing the diagnosis of issue #13 (salmonumbrella,
> "third-party wires remaining as in-transit transfers"). The reply posted on the issue describes these three changes.
> Everything marked **(my call)** was decided by Claude; the rulings table says what each costs if wrong.

## Why

Issue #13: an outgoing wire to a third party (`WIRE TRANSFER TO ACME LLC`) arrives as an unlinked `TRANSFER_OUT` with the
`↔️ In-transit transfer · ` prefix and stays that way. Verified in the code:

1. **Generic wording makes it a transfer.** `BANK_TRANSFER_KEYWORDS` (shared/mapper.ts) includes `wire transfer`, so any
   outgoing wire is typed `TRANSFER_OUT`, held as a spending-neutral placeholder, and waits for an incoming half that
   never comes.
2. **The 10-day give-up only runs on rows in the current download.** The expiry (`IN_TRANSIT_TIMEOUT_SECONDS`,
   `expiredTransferLegType`, the feed-aware `expiryHoldAccount`) is decided while typing the feed. An incremental sync
   re-downloads from the last sync minus 14 days (`SYNC_LOOKBACK_OVERLAP_MS`). A leg not re-evaluated between day 10
   and day 14 — a lagging feed held it then, or no sync ran — leaves the window and keeps its in-transit shape forever.
   Only a Deep scan (90 days) or auto-heal (44 days) reaches back far enough. Nothing re-checks old placeholders today.
3. **The audit blames the wrong thing.** The "held transfer" finding (shared/ledger-checks.ts, facts from
   companion/src/ledger-facts.ts) always says "a silent bank feed is holding it open", shows once, and offers no way out.

## A. Old in-transit rows settle on every sync

- Each sync, for each mapped account, look at STORED rows that are in-transit placeholders (note starts with
  `IN_TRANSIT_COMMENT_PREFIX`), carry a SimpleFin transaction id, are NOT in this run's feed, are not linked, and are
  older than the 10-day timeout.
- Apply exactly the in-feed decision: `expiryHoldAccount` (a mapped feed that hasn't published past the leg's pairing
  window holds it; a feed silent > 21 days holds only legs whose text names it). Not held → rewrite the row the way the
  in-feed expiry does: `expiredTransferLegType(accountType, signedAmount)`, `needsReview: true`, the note without the
  in-transit prefix, and whatever the placeholder carried for bookkeeping undone (external metadata, the 1.62
  "Sync bookkeeping" filing) — so the result is indistinguishable from an in-feed expiry.
- A `notTransfer` row, a linked row and a pending row are never touched. The change log records the expiry like the
  in-feed one, with Undo.
- **Read source (my call):** the stored rows the sync already reads for each account. Where that read is bounded (the
  add-on's recent-page `listActivities`), a placeholder beyond it is not seen by that writer; the companion's run
  covers it. No new full-history read.

## B. Generic transfer wording needs corroboration for money going out

- On a CASH account, money OUT whose type came ONLY from one of the four generic phrases — `online transfer`,
  `wire transfer`, `bank transfer`, `member transfer` — is `TRANSFER_OUT` only when its text also names another
  connected account (1.63's `namesConnectedAccount`) or matches a learned `out` name for that account (1.64's
  `transfer_names`). Otherwise it is an ordinary `WITHDRAWAL` from the start.
- Pairing by amount is unchanged, so a transfer between the person's own accounts still links when its other half
  arrives within 5 days, whatever it was typed first.
- **Unchanged (my call):** money IN with these phrases (it holds and, with A, always settles); the institution-specific
  phrases `pnc bank` and `capital one transfer` (they name a bank, and existing setups rely on them); the card-payment
  phrases; mapping rules (still win); card accounts.

## C. The "still in transit" finding says why and offers a way out

- The finding names the real reason: the connected account whose feed is behind (the hold's account), when there is
  one; otherwise that the next sync settles it.
- It offers **"Not a transfer"**, which records `notTransfer` for that bank transaction — the same override the change
  log's Undo writes — so the next sync makes it an ordinary withdrawal or deposit and never pairs it.
- **Where (my call):** wherever this finding is shown today (the daily report's findings in Telegram and the app's
  Checks). Shown while the row stays held past 14 days, not only once (my call).

## Rulings

| # | Decision | Cost if wrong |
| --- | --- | --- |
| R1 | A applies the in-feed expiry decision unchanged (10 days, feed-aware hold, dead-feed rule) to stored placeholders outside the download. | None beyond today's hold rules. |
| R2 | A expires rows into exactly the in-feed expiry shape, undoing bookkeeping metadata/filing. | A missed piece of placeholder bookkeeping would leave an expired row excluded from spending — the tests pin it. |
| R3 | A uses the rows each writer already reads; no new full-history read. | The add-on alone may not reach a placeholder beyond its recent page; the companion does. |
| R4 | B covers money OUT on CASH accounts and only the four generic phrases. | A first-time transfer between own accounts worded only generically shows as spending until its other half posts and pairs. |
| R5 | `pnc bank` and `capital one transfer` keep today's behavior. | A third-party payment worded with those phrases is still held (and, with A, settles after 10 days). |
| R6 | C's action writes `notTransfer` (the existing override), not a new mechanism. | None. |
| R7 | C's finding shows while the row is held past 14 days, not once. | One more line in the daily findings while a feed lags. |
| R8 | Ships as 1.65.0, both halves; release when Nick says. | — |

## Tests (acceptance)

- **A:** a placeholder 20 days old, outside the download, with all feeds current → expired to WITHDRAWAL, Needs review,
  prefix gone, bookkeeping undone, change logged; the same with a lagging mapped feed → held; a linked, pending or
  `notTransfer` row → untouched; a placeholder inside the window → today's in-feed path (no double write).
- **B:** `WIRE TRANSFER TO ACME LLC` out on CASH → WITHDRAWAL (not held); `ONLINE TRANSFER TO <connected account name>`
  → TRANSFER_OUT; a learned out name → TRANSFER_OUT; `WIRE TRANSFER FROM …` in → unchanged; `PNC BANK …` out →
  unchanged; a rule → wins; pairing still links a WITHDRAWAL-typed generic out with a same-amount in within 5 days.
- **C:** the finding names a lagging account when the hold has one; "Not a transfer" writes `notTransfer` for that
  transaction and the next sync expires it to WITHDRAWAL.
- Privacy: neutral ids and invented descriptors only (the issue's own `WIRE TRANSFER TO ACME LLC` is invented).
