# Dismissing transactions from the needs-a-category count

Date: 2026-08-09. Approved by Nick against the four decisions below. Ships as
v1.10.1.

## Why

v1.10.0 added a **Needs a category** tile to Overview, fed by a count the
companion publishes each sync. The number is all the addon gets, so there is
nothing to act on: a transaction you have deliberately decided to leave
uncategorized counts forever.

A dismissal mechanism already exists — the Telegram import notice ships inline
`Dismiss` buttons that write an `uncategorized_dismissals` secret, and the sweep
filters on it (`companion/src/index.ts:797`). It is unreachable from the addon,
and the new tile ignores that ledger entirely
(`grep -c ledger companion/src/uncategorized-status.ts` → `0`).

That second fact is currently theoretical — Nick has never used the Telegram
buttons — but it becomes a real bug the moment a dismiss button exists in the
addon: you would click it and watch the number not move. The fix is therefore not
a separate chore; it is this feature's foundation.

## The constraint that shapes everything

The addon cannot see categories at all. Wealthfolio's SDK exposes no
category/taxonomy data — the same wall that forces the one-time
categorization-rule insert to be a script. That is why the count is published by
the companion rather than computed in the addon, and it means **listing the rows
requires the companion to publish them too**.

## Decisions

1. **Publish the rows, dismiss individually** — not a bulk "dismiss all". Nick
   wants to categorize everything; wholesale dismissal is the wrong affordance to
   make easy. Seeing *what* needs categorizing is useful on its own.
2. **Dismissed means permanently hidden**, keyed by activity id, pruned at 60
   days — identical to today's Telegram behaviour, not a second set of rules.
3. **Hide immediately and adjust the count locally.** The addon holds both the
   row list and the ledger, so it computes the visible set itself instead of
   waiting up to an hour for the companion's next publish.
4. **Undo toast**, ~6 seconds. Without it a misclick silently hides a row for 60
   days.

## Data flow

```
companion (each sync)          addon secrets                   addon (Overview)
────────────────────           ─────────────                   ────────────────
reads SQLite ───────────────►  uncategorized_status  ─────────► list of rows
                               { count, asOf, rows[] }
                                                     ◄───────── writes on dismiss
                               uncategorized_dismissals
sweep filters on it ◄────────  { activityId: whenIso }
```

**`uncategorized_status` gains `rows[]`.** Each entry carries exactly what a row
needs to be read and dismissed:

```ts
interface UncategorizedRow {
  activityId: string;   // the dismissal key
  date: string;         // YYYY-MM-DD
  amountCents: number;  // magnitude
  description: string;  // already run through descriptionFromComment
  accountName: string;
}
```

`count` stays the TRUE total and `rows` is capped at **50**. When the cap bites,
the count still reports reality — a truncated list must never make the tile lie.
`count` remains the field the tile reads, so a v1.10.0 addon against a v1.10.1
companion is unaffected, and a v1.10.1 addon against a v1.10.0 companion shows
the tile with no list (exactly today's behaviour).

**One shared ledger.** The addon writes the same `uncategorized_dismissals`
secret the Telegram buttons write, and the companion sweep already filters on it.
Dismiss in either place and it holds in both. Two ledgers answering one question
is the divergence that produced three separate bugs during the v1.10.0 work
(check-script vs. poll, tile vs. sweep, addon vs. companion classification);
this design refuses to add a fourth.

## UI

Under the tile, a disclosure headed `3 need a category`. Open it for one row per
transaction — date, description, amount, account — each with a dismiss control,
and a link into Wealthfolio's Activities page for the ones worth categorizing.

The tile's number subtracts locally-known dismissals, so **the tile and the list
always agree**. Dismissing takes 3 → 2 immediately; the companion's next publish
confirms it, because it filters on the same ledger.

Dismiss → row disappears, count drops, `Dismissed — Undo` appears for ~6s. Undo
removes the ledger entry before the companion has read it. After it fades, the
dismissal stands.

Lives in its own component (`src/components/UncategorizedList.tsx`) — `OverviewTab`
is already 407 lines, at the size target.

## Shared logic

New `shared/uncategorized.ts`, imported by BOTH hosts so they cannot drift:

- `DismissalLedger` (moved from `companion/src/dismissals.ts`, re-exported there
  so the Telegram half keeps one import site)
- `pruneDismissals(ledger, now)` — moved, unchanged, 60-day cutoff
- `visibleUncategorized(rows, ledger)` — the single definition of "still needs a
  category". The companion filters its count through it; the addon filters its
  list through it.

`companion/src/dismissals.ts` keeps `pollTelegramDismissals` — that is
Telegram-transport-specific and does not belong in `shared/`.

## Known consequences, stated rather than discovered later

- **A dismissal is keyed by activity id.** If a reconcile deletes and re-creates
  a row (which it does for asset-carrying transfer legs), it returns under a new
  id. Rare, and defensible: it is a new row.
- **Categorizing a dismissed row makes the dismissal moot** — it stops being
  uncategorized, so it leaves the list regardless of the ledger.
- **The list is as fresh as the last companion publish**, so a transaction
  categorized in Wealthfolio still appears until the next sync (up to an hour).
  Refreshing on focus does not help: the data's source is the companion.

## Non-goals

- No bulk dismiss.
- No "dismissed items" browser with restore. The undo toast covers the misclick
  case; auditing past decisions is not a need Nick has expressed, and it would
  require publishing dismissed rows too.
- Nothing about the Wealthfolio display bug found while diagnosing this (a
  `CREDIT` row assigned an income-taxonomy category renders as uncategorized and
  its dropdown filters to spending only). That is upstream, not ours, and is
  recorded here only so the next person does not re-diagnose it.

## Testing

- `visibleUncategorized` — dismissed rows excluded, unknown ids ignored, empty
  ledger a no-op. Shared, so one definition is tested once.
- `pruneDismissals` — unchanged behaviour after the move (its existing tests move
  with it).
- Companion: publishes `rows[]`; the count and the list agree after filtering;
  the cap truncates `rows` without changing `count`.
- Addon: the list renders one row per entry; dismissing writes the ledger, hides
  the row, and decrements the tile in the same tick; undo restores both; a
  v1.10.0-shaped secret (no `rows`) renders the tile with no list and no crash.

## Ship

v1.10.1. Both halves change, so it needs an addon reinstall AND a companion
rebuild. Degrades gracefully in both version-skew directions (see the `rows[]`
note above).
