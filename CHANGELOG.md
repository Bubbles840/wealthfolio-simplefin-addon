# Changelog

All notable changes to SimpleFin Sync are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.8.2] - 2026-08-07

### Fixed

- **Scrolling the emoji panel closed it.** 1.8.1 closes the panel on page scroll,
  because its coordinates are fixed and would otherwise drift away from the button
  — but that listener is capturing, so it also saw the panel's own scroll and shut
  it the instant the user reached for an emoji further down, dragging its scrollbar
  included. Scrolls originating inside the panel are now ignored; a scroll anywhere
  else still closes it.

## [1.8.1] - 2026-08-07

### Fixed

- **The emoji picker never appeared.** Clicking a category's emoji toggled the
  button but showed nothing: the panel was rendering and then being clipped out of
  existence by two ancestors that set `overflow: hidden` for their rounded corners
  (`.sfin-disc-inset` and `.sfin-card--collapsible`), which an absolutely-
  positioned child cannot escape. It is now positioned in viewport coordinates
  taken from the button's own rect, which ancestor overflow cannot clip. It also
  flips above the button when there is no room below, clamps to the right edge, and
  closes on scroll or resize rather than floating away from the button it belongs
  to.

## [1.8.0] - 2026-08-07

### Added

- **Categories are grouped the way Wealthfolio groups them** — one collapsible
  section per budget group (Needs, Wants, Savings, Giving, Personal, Other), each
  showing how many categories it holds. Read from `budget_groups` and
  `budget_group_assignments`, so a group you add, rename or reorder in
  Wealthfolio appears here on the next sync with nothing hardcoded on our side;
  the same is already true of categories. A category no group claims lands under
  `Ungrouped` rather than disappearing, because Wealthfolio permits that state.
  Group order follows Wealthfolio's own `sort_order`, not alphabetical.

## [1.7.2] - 2026-08-07

### Changed

- **The category selector lists parents only.** Wealthfolio budgets at the parent
  level — its own Spending Tracker has no subcategory amount field — and the
  reports aggregate children into their parent, so a per-child checkbox controlled
  nothing a report could act on while making the list 52 rows long. Subcategory
  detail now lives solely in the `Break down under the parent` report mode, and the
  hint says so and counts how many are hiding in there.
- **Per-category emoji is a palette, not a text field.** The input assumed the user
  knows how to type an emoji on their platform; it is now a click-to-pick grid of
  ~80 budget-relevant glyphs grouped by theme, with a `Default` option to clear an
  override. Curated rather than a picker dependency, because the addon runs in a
  sandboxed iframe under a strict CSP.
- **The emoji column disappears entirely in `Clean` mode**, where an override does
  nothing — and where the old input's `—` placeholder read as a missing budget
  figure rather than an empty setting.
- **Overrides apply in `glyphs` mode only.** They previously applied in both, which
  made `Clean` a lie: a report could carry glyphs while the setting said none. One
  rule is easier to hold than an exception.
- The `Report icons` label now reads `Telegram report icons`, since it never
  affected the addon's own icons — those always come from Wealthfolio.

## [1.7.1] - 2026-08-07

### Fixed

- **`DEPOSIT` is not a valid activity type on a credit card**, and the in-transit
  placeholder used it — so an unpaired card payment (an AUTOPAY arriving at a Citi
  card) was refused every sync with `Invalid data: DEPOSIT activities are not
  supported for credit card accounts`. The old reasoning was that DEPOSIT is safe
  on a card because the spending classifier ignores it: true, and beside the point,
  since the API rejects the type before anything classifies it. Cards now use the
  same `CREDIT` shape as cash accounts — demonstrably accepted, since Wealthfolio
  writes `CREDIT` rows to that account itself — which is spending-neutral in both
  directions. 1.6.1's row-by-row fallback is what surfaced this cleanly instead of
  failing the whole account's batch.
- **The category catalog was only published when a report ran**, so a fresh
  deployment showed the legacy budget-or-spent list — no icons, no subcategories —
  until the next morning's 8am report. It is now published on every sync, which is
  where it belongs: what categories exist has nothing to do with report
  scheduling.

## [1.7.0] - 2026-08-06

### Added

- **Every category is now selectable, not just budgeted-or-spent ones.** The
  addon's list came from a companion-published union of this month's spending and
  budgets, so a category like Personal Care could not be chosen until money
  happened to move through it. A new catalog publishes all of them with their
  parent, and reports keep printing only the ones with a budget or spending — two
  separate questions, now answered separately.
- **Categories carry Wealthfolio's own icons and colours** in the addon. Those
  come straight from `taxonomy_categories.icon`, which holds lucide-react export
  names, so there is no mapping of ours to drift and a category Wealthfolio gives
  a new icon to simply renders. The selector is grouped, with subcategories
  indented under their parent — 52 rows flat was unreadable.
- **A subcategory display toggle.** `Roll up into the parent` is unchanged and
  remains the default; `Break down under the parent` lists children beneath the
  parent's envelope line, spend-only and biggest first, so a Transportation
  budget can show where the money actually went.
- **The companion reports its version** in its startup banner and to the addon,
  which shows both halves in its footer and flags a mismatch. `shared/version.ts`
  is now the single source, pinned by a test against `manifest.json` and
  `package.json`. Previously the only honest way to identify a running companion
  was grepping compiled JavaScript, because `companion/package.json` is a
  dependency manifest that has read `1.0.1` since the project began.

### Changed

- **Reports are clean by default.** The decorative glyphs are gone — no sun over
  the daily check, no moneybag on the summary, no label on every category line.
  Glyphs that encode STATE remain, because Telegram renders neither colour nor
  Wealthfolio's icons and they are the only way left to mark a line: `🚨` over
  budget, `⚠️` over the week's pace, `⏳` waiting on the bank feed. `Emoji per
  category` restores the old style, and any single category can be given a glyph
  in either mode.
- **The Sync page stays current.** It re-reads last-synced, balances and the
  companion version on window focus and every 60 seconds. It previously rendered
  once, so a tab left open froze — on 2026-08-06 it showed a day-old sync time and
  an already-resolved error, prompting a hunt for a fault that no longer existed.

## [1.6.1] - 2026-08-06

### Fixed

- **One un-importable transaction could silently strand an entire account's
  import.** Wealthfolio's bulk save endpoint is all-or-nothing: a single row it
  considers a duplicate discards the whole batch. The run still completed and
  reported `0 imported`, indistinguishable from a day with no activity, so
  nothing surfaced. Found live on a Citi card holding two legitimately
  identical same-day charges — the same merchant for the same amount twice,
  which Wealthfolio's duplicate detection cannot tell apart because it does not
  key on the SimpleFin transaction id.

  A refused batch is now re-sent one row at a time — deletes, then updates, then
  creates — skipping anything the batch already stored so a partial success
  cannot become a double-create. The reported errors name the specific row
  refused, with its description, instead of a bare batch failure. The happy path
  is unchanged at exactly one call.

## [1.6.0] - 2026-08-02

### Fixed

- **The companion's database reads were up to days stale.** It read
  Wealthfolio's SQLite file in `immutable` mode, which sees only data
  checkpointed into the main file — and a live instance was observed with
  **two days** of writes (2.4 MB) still sitting in the write-ahead log. Every
  consumer was affected: the needs-a-category sweep missed all recent rows
  (four uncategorized transactions went unreported on a live install), and the
  daily/weekly reports served days-old spending and budget figures. Reads now
  attach the WAL (`mode=ro`, with `readonly_shm=1` for the read-only mount),
  falling back to the old snapshot mode if the WAL files aren't visible.
  **Requires a compose change**: bind-mount the Wealthfolio *directory* rather
  than the bare `.db` file, so the companion can see `-wal`/`-shm`.

### Changed

- The needs-a-category sweep now covers income too — deposits, credits,
  interest, dividends — not just spending. A live user's interest payment and a
  card-points credit both wanted categorizing. Transfers stay excluded (they
  are classified by linking, not by category), as do all machine-written rows.

## [1.5.0] - 2026-08-01

### Changed

- **A young drift no longer looks like an emergency.** A drift that no
  transaction can explain and that appeared within the last 10 days is almost
  always the bank's balance running ahead of SimpleFin's transaction list —
  posted activity the feed hasn't published yet, which resolves itself in days
  (observed twice on a live account, at $1,300 and $490.75). That case now
  renders as a calm "waiting on the bank's feed" banner with **no Add button at
  all** — the red banner's one-click plug was a loaded gun that would
  double-count the moment the feed caught up. The red banner, the plug, and the
  `Fix baseline` offer return only once the drift has stood for 10 days.
  Drifts too small to alert (under the drift-alert threshold) keep the old
  immediate treatment — that's the small-divergence case the plug exists for.
- **Aggressive auto-heal respects the same 10-day gate.** It previously would
  have plugged feed lag automatically and then plugged the flipped drift again
  when the feed caught up — two garbage rows, no human involved. Small
  sub-threshold divergences still plug immediately.
- **The Telegram drift alert now matches the diagnosis.** A new episode sends
  an informational ⏳ notice naming feed lag as the likely cause and asking for
  nothing. If the same episode is still unresolved after 10 days, a one-time 🚨
  escalation with the original alarm styling follows.

## [1.4.0] - 2026-07-30

### Added

- The per-sync import notice now lists what arrived — description, amount, and
  account per transaction, with pending and in-transit rows marked — instead of
  a bare count. Gated by the same `notifyOnImport` toggle as before.
- The notice also carries a `🏷️ Needs a category` section: every spending
  transaction from the last 30 days with no category in Wealthfolio's spending
  tracker, however and whenever it was imported. Sweeping rather than flagging
  this run's rows makes the companion's read-snapshot lag harmless (a row
  invisible at send time is caught by the next notice) and covers transactions
  imported by the addon, which produce no notice of their own. Rows the sync
  itself writes — starting balances, adjustments, in-transit placeholders —
  are never nagged about.
- Each listed uncategorized row gets a Telegram **Dismiss** button, for a
  transaction deliberately left uncategorized. Presses are collected once per
  sync run, so a dismissal takes effect on the next notice rather than
  instantly; categorizing the transaction in Wealthfolio remains the natural
  way to clear a nag.

### Changed

- The daily spending digest now splits budgeted from unbudgeted categories:
  budgeted ones always render, unbudgeted ones appear under `Off budget:` only
  when money actually moved this month. A category with a leftover zero-amount
  budget row and no spending — previously rendered as `no budget · $0 spent` —
  no longer appears at all.

## [1.3.1] - 2026-07-30

### Fixed

- `Fix baseline` could blame the baseline for feed lag. A bank balance that
  already includes a posted transaction SimpleFin's transaction list has not
  reported yet produces the exact signature 1.3.0 read as a wrong baseline: a
  gap no stored transaction explains, constant across the whole window. Found
  live the day the feature shipped — the offer was taken, the feed caught up
  hours later, and the account double-counted $1,300. What tells the two apart
  is time: a wrong baseline has been wrong since the day it was written and
  never resolves itself, while feed lag clears in days. The offer now also
  requires the drift to have been standing for at least 10 days.

## [1.3.0] - 2026-07-30

Balance accuracy and transfer correctness, driven almost entirely by
discrepancies found on a live install. Every figure quoted below is a real one.

### Fixed

- One SimpleFin transaction id appearing in **two** accounts corrupted
  everything keyed by that id alone. SimpleFin issues a single id for both sides
  of a transfer between two accounts it can see end to end, so the two legs
  collapsed into one entry: a savings `TRANSFER_OUT` could be rewritten as a
  +$1,300 inflow carrying the other account's description, `linkPair` could be
  handed the same row twice, and an account's starting-balance baseline could
  take the wrong sign. Identity is now `(account, transaction id)` everywhere it
  matters. On the live install this had already half-linked three transfer pairs
  — one leg grouped, the other not — leaving $2,700 of transfers out counted as
  spending; a reconcile repairs them.
- A failed transfer link reported no reason. Linking deletes both rows before
  re-creating them, so a refused re-create loses financial rows, yet every host
  error was collected and then discarded behind a generic "could not be linked"
  that only appeared during a reconcile. The reason now travels with the failure,
  a silently dropped group says so explicitly, and both are reported on ordinary
  syncs too.
- The Docker companion could never repair a half-linked transfer pair. Its
  record of "already linked" was keyed by bare transaction id, so a shared-id
  pair collapsed to one entry that could not distinguish "both legs confirmed"
  from "only one leg was grouped". Entries are now per leg, while still reading
  the old format so existing records are neither lost nor needlessly re-linked.
- A SimpleFin payload that reported the same transaction twice for one account
  imported it twice. Both copies were planned as creates and landed in a single
  bulk request, which is the one place Wealthfolio's duplicate guard cannot
  compare rows against each other, so a savings account silently read $1,297.50
  low. Each account's transaction list is now collapsed to one entry per
  transaction id before anything is planned from it — preferring a posted copy
  over a pending one, and otherwise the last occurrence — and every dropped copy
  is logged. Deduplication is per account: one transaction id legitimately
  appears in two accounts as the two legs of an internal transfer.
- Budget targets read from Wealthfolio's database picked whichever row was
  edited most recently, so editing a category's `default` budget after setting
  a month-specific one silently reported the wrong number. Month-specific rows
  now always win, with `updated_at` only breaking ties between rows of the same
  kind.
- The monthly spending query had no upper date bound, so a future-dated
  transaction leaked into the current month's total.
- A transfer whose second leg had not posted at the bank yet counted as
  spending, because Wealthfolio only excludes a transfer once both legs are
  *linked* and a solo leg can never be linked. Unpaired transfer legs now
  import as spending-neutral placeholders that promote to a real linked
  transfer when the other leg arrives, or expire to ordinary spending after
  10 days if it never does.
- On the Docker companion, a promoted transfer leg kept a phantom `$CASH`
  asset (an update cannot clear a stored asset), which made the pair
  permanently unlinkable. Both syncers now share one delete-and-re-create
  linking path.
- Report messages no longer break when a category name, error message, or bank
  description contains Markdown characters — previously a single `_` or `*`
  could make Telegram reject an entire report.
- A corrupt addon secret no longer destroys a whole report or aborts alert
  delivery mid-run.
- Unchecking one report category could silently re-enable *all* of them, because
  the "everything selected" check compared list lengths rather than membership
  and the available-category list legitimately shrinks month to month.

### Added

- `↻ Reconcile & link` (and auto-heal) now removes activities that are surplus
  copies of a transaction the account already holds, keeping one of each. It
  reports exactly what it deleted — on the Sync page, as a Telegram message, and
  as a log line per row — because automatic deletion of a financial record must
  not be silent. Starting-balance baselines and balance-adjustment entries are
  excluded by their note prefixes and can never be swept, and only transaction
  ids the bank reported for that account on the same run are eligible.

- A drift that no transaction can explain is now attributed to the account's
  starting balance, and offered as a one-click correction rather than a plug.
  When a wide re-scan finds every transaction the bank reports already stored and
  already matching, nothing inside the window can account for the gap — so the
  remaining candidate is the baseline row that stands in for history the sync
  never saw, and the drift is exactly the amount it is wrong by. The Sync page
  shows `Fix baseline: $11,355.12 → $10,055.12` and demotes the balance
  adjustment to `(plug instead)`. Never applied automatically, and never offered
  while any transaction is still unaccounted for — folding a genuinely missing
  transaction into the baseline would hide it permanently.

  This came from two live accounts sitting $1,300 out in mirror image, one
  baseline overstated and the other understated, from a transfer in flight
  across two baselines captured five days apart. Both feeds reconciled
  completely; a balance adjustment would have been a four-figure fabrication
  about where the money came from.

- Two independent scheduled reports: a daily per-category spending check
  (`DAILY_REPORT_SCHEDULE`) and a weekly month-to-date summary
  (`WEEKLY_REPORT_SCHEDULE`, default Saturday). Previously one schedule existed
  and the weekly toggle was stored but never read.
- Per-report category selection, configured in the addon's Telegram section.
- Sync health tracking: a footer on the daily report, plus a one-time Telegram
  alert once syncs have been failing for 24 hours.
- A one-time alert when a transfer pair repeatedly fails to link, rolled back
  and retried if the alert itself fails to deliver.
- `HEALTHCHECK` in the companion image.

### Changed

- Reports are built entirely from Wealthfolio's own category and budget data.
  The keyword-based categoriser that guessed categories from transaction text
  (and its settings UI) has been removed — it was a second, hand-maintained
  guess that disagreed with Wealthfolio's real assignments.
- The daily report leads with the true amount left this month and presents the
  weekly figure as an explicitly approximate pace. The previous
  `remaining ÷ weeks-left` figure doubled overnight mid-month and moved by only
  a fraction of what was actually spent.

## [1.0.1] - 2026-07-28

### Added

- Telegram notifications, spending and budget figures read natively from
  Wealthfolio's SQLite database, and exact Spending Tracker integration.

## [1.0.0] - 2026-07-26

First public release.

### Added

- Transaction import from every SimpleFin-connected account, with per-account
  mapping to Wealthfolio accounts (existing or created during setup).
- One-time starting-balance entry so each account lands on its real bank
  balance rather than the sum of imported transactions, including a brief poll
  for brand-new accounts whose valuation is computed asynchronously.
- Pending-transaction support: pending rows are imported and reconciled in
  place when they post — updated if the amount changed, removed if they vanish.
- Automatic internal-transfer detection and linking. Matching legs across two
  mapped accounts are imported as a linked Transfer Out / Transfer In pair and
  excluded from spending and income analytics.
- Custom description-to-activity-type mapping rules, which take precedence over
  automatic detection.
- Per-account SimpleFin balance and drift display, with one-click correction.
- "Reconcile & link": a wider re-scan that recovers missed transactions,
  re-measures balances, and links outstanding transfer pairs. Optional
  auto-heal and aggressive auto-heal toggles.
- Auto-sync on a configurable interval with a startup catch-up, plus a one-hour
  minimum interval so reloading the page is a no-op.
- Optional Docker companion for background sync (earlier sync logic; see
  README).

### Fixed

- Cash-transfer legs are imported with no asset. Sending the reserved
  `$CASH-<ccy>` symbol made Wealthfolio create a literal `"$CASH"` security,
  which neither moved the cash balance nor allowed the two legs to be paired —
  by this addon or by Wealthfolio's own transfer linker.
- Both legs of a pair are written in a single request, so Wealthfolio sees a
  complete two-leg group; a per-account write looks like a lone leg and the
  group is silently dropped.
- Transfer groups carry the internal-transfer marker Wealthfolio requires; a
  shared group id alone is not enough to classify a pair as internal.
- Balance corrections are written as a spending-neutral `CREDIT`, so they no
  longer inflate the Spending total or appear as income.
- The starting-balance baseline is adjusted when a wide re-scan recovers older
  transactions, which would otherwise be counted twice.
- The link ledger is reconciled against what Wealthfolio actually stored, so a
  link that silently failed is retried instead of being recorded as done.
- Incremental syncs re-scan a two-week overlap, so card purchases that post
  late with a backdated timestamp are no longer missed permanently.
- Sync windows stay inside SimpleFin's limits, and its informational
  window-size notices are no longer surfaced as errors.

[Unreleased]: https://github.com/Bubbles840/wealthfolio-simplefin-addon/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Bubbles840/wealthfolio-simplefin-addon/releases/tag/v1.0.0
