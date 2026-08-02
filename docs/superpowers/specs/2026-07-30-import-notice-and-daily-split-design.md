# Import notice with categorization sweep, and the daily report's on/off-budget split

Date: 2026-07-30. Approved by Nick in conversation.

## What and why

Two report changes, both companion-rendered:

1. **The per-sync import notice lists what arrived and what still needs a
   category.** Today it says only `Imported N new transaction(s)`. Nick wants to
   see the transactions, and to be told when something — new or weeks old — has
   no category in Wealthfolio's spending tracker. His mapping rules categorize
   the recurring stuff, so uncategorized rows are rare and only ever *enter* via
   an import; the import notice is therefore the natural (and only) nag site.
   The daily report deliberately does NOT get this — it is bloated enough.

2. **The daily spending digest splits budgeted from unbudgeted categories.**
   Budgeted categories always render (envelope tracking). Unbudgeted categories
   render under an `Off budget:` heading ONLY when money moved this month. The
   `no budget · $0 spent` noise line can never render again.

## The import notice

```
🔔 3 new transactions

• $67.74  TRADER JOE S #628 — Spend (4937)
• $22.58  NETFLIX.COM — Citi Double Cash
• $600.00  CAPITAL ONE TRANSFER — Spend (4937) · pending

🏷️ Needs a category (2):
• $45.16  VENMO PAYMENT · Jul 9 — Spend (4937)
• $22.58  CHECK #1042 · Jul 28 — Spend (4937)
```

- **New-transactions block**: every real feed transaction this run created,
  capped at 10 lines + `+N more`. Internal rows (starting balances, balance
  adjustments, plugs) never listed. Pending and in-transit rows are marked.
  Data source: a new `SyncResult.importedTransactions` array populated by the
  shared core where creates are planned — description, amountCents, currency,
  accountName, txId, sfAccountId, pending/inTransit flags. The addon receives
  the data too but does not render it (the category sweep needs the native DB).
- **Needs-a-category block**: a SWEEP, not a per-import flag. Every spending
  transaction from the native DB in the **last 30 days** with no taxonomy
  assignment, minus dismissed ones, capped at 5 + `+N more`. Omitted entirely
  when empty. Sweeping (rather than flagging this run's rows) is what makes the
  WAL-snapshot lag harmless — a row invisible at send time appears in the next
  notice — and covers addon-imported transactions, which produce no notice of
  their own.
- Gated by the existing `notifyOnImport` toggle; no new setting.
- All bank-supplied strings go through `escapeMarkdown`, escaped text OUTSIDE
  every Markdown entity (legacy-Markdown rule).

## Dismissing a nag

Each listed needs-a-category line gets a Telegram **inline keyboard button**
(`Dismiss: VENMO $45.16`). Pressing it records a `callback_query` with
`dismiss:<sfAccountId>:<txId>` (account-scoped — shared tx ids exist).

The companion polls `getUpdates` once per sync run (offset persisted in a
`telegram_update_offset` secret), records dismissals into an
`uncategorized_dismissals` secret keyed `(sfAccountId, txId)`, and answers the
callback. Consequence of poll-per-run: the button press shows Telegram's
loading spinner briefly and the item vanishes from the NEXT notice, not
instantly. Accepted — a webhook or continuous polling is not worth the surface.
Dismissal entries are pruned once older than 60 days (past the 30-day sweep
window they are inert). Categorizing the transaction in Wealthfolio is the
natural dismissal and needs no button.

## The daily split

`formatDailySpendingDigest` changes:
- Categories WITH a budget: unchanged rendering, always listed.
- Categories WITHOUT a budget: listed under `Off budget:` only when
  `monthSpent > 0`, as `{emoji} {name}  {money} spent`.
- A category with no budget and no spend renders nothing.

## Out of scope

- Instant dismissal acknowledgement (webhook/long-poll).
- Addon-side rendering of the notice or sweep.
- Any change to the daily/weekly/monthly schedules or category selection.

## Testing

TDD throughout. Builders: caps, plurals, escaping, empty-section omission,
off-budget rendering, no-budget-no-spend absence. Core: importedTransactions
contents and exclusions (markers, updates vs creates). Companion: sweep query
shape, dismissal filtering, offset handling, callback parsing (account-scoped
key), ledger pruning.
