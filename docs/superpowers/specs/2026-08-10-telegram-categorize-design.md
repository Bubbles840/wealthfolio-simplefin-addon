# /categorize: filing transactions from Telegram

Date: 2026-08-10. Approved by Nick against the decisions below. Ships as
v1.12.0, companion-only.

## Why

The bot can now say what needs a category (`/status`, the import notice, the
addon's tile) and can dismiss a row, but fixing one still means opening
Wealthfolio. Nick wants the whole loop in Telegram: see the uncategorized
transactions, tap one, tap a category, done — with subcategories and Back
buttons, as tappable menus rather than typed names.

## The discovery that shapes everything

Wealthfolio's server build exposes a first-class REST API for exactly this
(upstream `apps/server/src/api/spending.rs`, present since 2026-06, older than
Nick's build):

- `PUT  /api/v1/spending/activities/{activity_id}/assignments`
  body `{ taxonomyId, categoryId }` — assign a category to an activity
- `DELETE /api/v1/spending/activities/{activity_id}/assignments/{taxonomy_id}`
  — un-assign (a real Undo)
- `POST /api/v1/spending/rules` (+ update/delete) — categorization rules
- `POST /api/v1/spending/rules/rerun` — retroactive re-run (NOT used; see
  non-goals)

So the companion's read-only database mount stays read-only: every write goes
through the same authenticated REST server the companion already uses, and
Wealthfolio's own service enforces its invariants. The write-path
investigation this feature was blocked on is resolved — no raw SQLite writes,
no new mounts, no new permissions.

## Decisions

1. **Menus, not typed arguments.** Inline keyboards with in-place message
   editing (`editMessageText`): one message morphs list → transaction →
   categories → subcategories → confirmation. `« Back` on every screen; `Done`
   closes the menu. The dismiss buttons already prove the callback plumbing.
2. **One definition of "needs a category."** The list is the same set the
   addon shows: uncategorized spending rows filtered through the dismissal
   ledger via `visibleUncategorized`. A row dismissed anywhere never appears
   here.
3. **Dismiss lives inside the menu.** The transaction screen offers `Keep
   uncategorized` beside the categories — same ledger, same
   read-merge-prune-write the listener already has, Undo on the confirmation.
4. **"Always file it here" is offered, never assumed.** After filing, the
   confirmation offers `Make this a rule`. Tapping shows the EXACT rule
   (`descriptions containing "TRADER JOE S #628" → Groceries`) and asks for one
   more tap to create it. Priority 50 — below Nick's hand-made rules (60) and
   Wealthfolio's presets (70–90), where LOWER wins — so a tapped rule never
   outranks a deliberate one. The pattern is the cleaned descriptor as an
   escaped, case-insensitive literal: narrow and honest beats clever and
   wrong, and rules are editable in Wealthfolio's settings afterwards.
5. **The addon hears about it in seconds.** After every assignment, dismissal,
   or undo made from Telegram, the companion republishes
   `uncategorized_status`, so the purple tile and its list update on the next
   addon refresh (≤60s) instead of at the next 6-hour sync.
6. **The import notice funnels in.** Its needs-a-category section gains one
   `Categorize` button that opens the same menu. One flow, three entry points
   (command, notice, and the addon's own list which links to Wealthfolio).

## The flow

```
/categorize                     (or the import notice's Categorize button)
  ─ up to 8 rows as buttons: "Aug 8 · BOOK STORES · $4.23"
    · More » paging when there are more; Done closes
tap a row
  ─ transaction details + parent categories as a button grid
    + Keep uncategorized · « Back
tap a parent
  ─ its subcategories + "Just ⟨parent⟩ itself" · « Back
tap a category
  ─ PUT assignment → "✓ BOOK STORES → Groceries"
    + Undo · Make this a rule · Next transaction · Done
```

- Every screen renders from a FRESH read (uncategorized query, category
  catalog, ledger). A row categorized elsewhere mid-flow simply disappears;
  a stale tap answers with a toast ("that list changed — refreshing") and
  re-renders, never a wrong write.
- `Undo` calls the DELETE endpoint (assignment) or the merge-remove
  (dismissal), then re-renders the confirmation as undone.
- Only the configured chat is honored — the listener's existing authorization
  covers callbacks, and every callback is re-validated against fresh data
  before any write.

## Mechanics

- **Callback data is capped at 64 bytes** (the reason dismiss buttons carry
  `d:<activityId>`). Multi-level navigation cannot fit ids for
  transaction+category+screen, so callbacks carry short tokens
  (`cz:<screen>:<index>`) resolved against a small per-chat session state the
  listener holds in memory. State is rebuilt from fresh reads on every screen,
  so a restarted companion or an expired session degrades to "menu expired —
  send /categorize again", never to a misdirected write.
- **`taxonomyId`** comes from the category catalog read (each
  `taxonomy_categories` row carries its `taxonomy_id`); the menu only offers
  spending-taxonomy categories, parent-grouped exactly as the addon's report
  matrix does.
- New shared formatters/state machine in `shared/` (pure, tested without a
  network); transport and the two REST calls in the companion beside the
  existing client methods. The listener gains one dep for the categorize
  callbacks, constructed in `buildTelegramListenerDeps` like the others.
- The exact request/response bodies for the rules POST are verified against
  upstream source during planning, not guessed.

## Known consequences, stated rather than discovered later

- A rule created from the button applies at IMPORT time, to future
  transactions only. Existing history is untouched (see non-goals).
- Store-numbered descriptors (`#628`) make narrow rules. Accepted: narrow
  rules never mis-file, and widening one is a settings edit in Wealthfolio.
- The in-memory menu session does not survive a companion restart. Accepted:
  the menu is ephemeral by design and one `/categorize` away.
- `/categorize` writes real category data from a group chat any member can
  tap. Accepted: the group is Nick's own three-member alerts group, the same
  trust boundary every other command already has.

## Non-goals

- **No retroactive rule re-run.** `POST /spending/rules/rerun` exists upstream
  and is deliberately not called: a one-tap mass recategorization of history
  is exactly the invisible bulk change this project refuses to make implicit.
  If wanted later, it is its own feature with its own dry-run.
- No editing or deleting existing rules from Telegram (settings UI owns that).
- No splits, no multi-category assignment (the API supports splits; the menu
  does not — YAGNI until Nick asks).
- No free-text category entry. The menu offers what exists; creating
  categories stays in Wealthfolio.

## Testing

- Shared: the menu state machine (every screen's keyboard from fixed inputs,
  token round-trips, stale-token behavior), rule-preview formatting, the
  64-byte invariant for every button the machine can emit.
- Companion: the two REST calls against a fake server (assign, unassign,
  rule create — exact paths/bodies pinned); republish fires after each write;
  dismiss-from-menu goes through the merge path; a failed write renders an
  error screen and never half-applies; the listener's new dep is constructed
  with the same guarantees as the others (synchronous log, non-rejecting).
- Integration: a dismissed row never appears in the list; categorizing the
  last row renders the empty state; the import-notice button opens the same
  menu.

## Ship

v1.12.0, functionally companion-only: rsync + docker build + one-service
restart. The addon's behavior does not change — it reads the same secrets it
already reads, just fresher — so reinstalling the zip is optional, worth doing
only to keep the two version strings matching in the footer.
