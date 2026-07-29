# Changelog

All notable changes to SimpleFin Sync are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

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
