# /recategorize: fixing a filed transaction from Telegram

Date: 2026-08-11. Approved by Nick against the decisions below. Ships as
v1.13.0, companion-only.

## Why

`/categorize` files what has no category. But wrong categories need fixing too:
Nick's Venmo/Zelle paybacks auto-file under **Reimbursements** (an income
category), when many of them are friends paying him back for dinner or a movie
— which should *offset the spending category* instead, reducing that week's
Food & Dining rather than counting as income. Today fixing one means opening
Wealthfolio.

## Decisions

1. **`/recategorize` lists recent categorized transactions; an argument
   searches.** Bare: newest first, `MENU_PAGE_SIZE` per page, each row showing
   its current category — `Aug 9 · VENMO PAYMENT · $24.00 · Reimbursements`.
   `/recategorize venmo` filters by case-insensitive substring on the cleaned
   description, so the real workflow is one command → every Venmo row → tap.
2. **Tapping opens the exact picker `/categorize` uses** (parents,
   subcategories, Back, generation-stamped tokens). The confirmation shows the
   move — `VENMO PAYMENT: Reimbursements → Food & Dining` — and **Undo restores
   the exact previous category**, a verified restore, not a blind write.
3. **The import notice shows what each transaction was filed as, plus one
   button.** Each imported line gains `→ filed under Groceries`, read back
   from the database AFTER the import lands so it reflects what actually
   happened (rules included; still-uncategorized rows say nothing — the
   needs-a-category section below already owns them). One `Recategorize`
   button at the bottom opens a fresh menu (never editing the notice) listing
   this import's transactions; after a companion restart, where that import's
   identity is gone, it falls back to the plain recent list.
4. **Cross-system moves clear the old side.** Wealthfolio keeps one assignment
   per taxonomy per transaction (the API's DELETE is per-taxonomy), so setting
   a spending category on a row that carries an income-taxonomy assignment
   would otherwise leave BOTH — counted as income and as a spending offset at
   once. The recategorize write therefore deletes every non-spending
   assignment the row carries, then sets the spending one. The reverse
   direction (moving something INTO an income category) is out of scope — the
   picker offers spending categories only, same as `/categorize`.
5. **The new current-category reader retroactively fixes `/categorize`'s
   Undo.** That Undo has been a documented blind spot since v1.12.0 (nothing
   could read a row's current assignment, so un-filing could erase a category
   someone else had just set). With the reader, both commands' Undos verify
   before writing: if the row's category is no longer the one this menu set,
   Undo declines with a fresh render instead of erasing someone else's work.

## The flow

```
/recategorize [text]              (or the import notice's Recategorize button)
  ─ up to 8 categorized rows: "Aug 9 · VENMO PAYMENT · $24.00 · Reimbursements"
    · More » / « Prev paging · Done
tap a row
  ─ details incl. current category + the spending-category picker
    + « Back  (no "Keep uncategorized" here — the row HAS a category)
tap a category (or into subcategories first)
  ─ clear other-taxonomy assignments → PUT spending assignment
  ─ "VENMO PAYMENT: Reimbursements → Food & Dining"
    + Undo · Next · Done
```

- Same safety rails as `/categorize`, unchanged: every screen renders from
  fresh reads; a stale tap (older generation) is rejected before any index
  resolves; a row whose category changed elsewhere mid-flow drops out or
  declines rather than mis-writing; only the configured chat is honored.
- A row that became UNcategorized elsewhere mid-flow simply stops appearing
  here (it belongs to `/categorize` now).

## Mechanics

- New native reader: recent spending-relevant transactions WITH their
  assignments — per row, every `(taxonomyId, categoryId, categoryName)` it
  carries. Powers the list, the current-category display, the cross-system
  clear (it knows which taxonomies to delete), both Undo verifications, and
  the notice's read-back (matched to imported rows by the stored note's txId
  suffix, the sync's own identity mechanism — never by description).
- Menu machinery is EXTENDED, not duplicated: the session gains a mode, list
  rows optionally carry a current category, and the confirmation gains the
  old→new form. One state machine, one token codec, one 64-byte guarantee.
- Writes go through the existing client methods (`unassignActivityCategory`
  for each non-spending taxonomy, then `assignActivityCategory`); republish
  keeps the addon's tile honest within a minute.
- Search is plain substring on the cleaned description, in the companion,
  after the ledger-independent read. No fuzzy matching, no regex.

## Known consequences, stated rather than discovered later

- A credit recategorized to a spending category reduces that category's
  week/month figures (`/left`, `/afford`, digests) by its amount. That is the
  point, and every cross-system confirmation says so in one extra line
  (`This payment now offsets Food & Dining instead of counting as income.`).
- The notice's `→ filed under` reflects the database at notice time; a rule
  that runs later (e.g. a `/newrule` created afterwards sweeping uncategorized
  rows) is not retroactively reflected in old notices.
- The import-notice button's "just this import" scope lives in companion
  memory; a restart degrades it to the plain recent list, honestly.
- `/recategorize` shows spending-relevant rows regardless of which taxonomy
  currently holds them; rows with NO assignment belong to `/categorize` and do
  not appear here.

## Non-goals

- No bulk recategorize ("move all Venmo to X" is `/newrule` + its
  uncategorized-only sweep; rewriting categorized history stays manual and
  deliberate, one tap per row).
- No income-category picker. Moving something INTO an income category stays in
  Wealthfolio.
- No date-range or amount filters on the search. Substring on description
  covers the stated use case; more can come when wanted.
- No editing of anything but the category.

## Testing

- Menu: recategorize list rows render the current category; the confirmation
  renders old→new; Undo declines when the current category is not the one this
  menu set; token/64-byte invariants re-proven for the new screens.
- Reader: a row with two taxonomies' assignments reports both; aliasing
  verified (the Task-2 lesson from v1.12.0); CLI-fallback NULL normalization
  (the whole-branch lesson from v1.12.0); missing db → empty.
- Controller: cross-system move deletes the income assignment then assigns;
  same-system move performs no deletes; Undo restores the previous category
  and re-verifies first; search filters; a mid-flow external change declines.
- Notice: `→ filed under` lines match by txId, uncategorized rows show
  nothing, the button opens a FRESH message scoped to the import, restart
  falls back to recent.
- Integration: `/categorize`'s Undo now verifies (the closed debt), pinned by
  a test where the category changed externally between filing and Undo.

## Ship

v1.13.0, functionally companion-only: rsync + docker build + one-service
restart; the addon zip changes only its version string.
