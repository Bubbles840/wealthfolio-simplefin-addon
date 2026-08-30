# Budget Tab — Design

**Date:** 2026-08-30 · **Status:** approved in discussion, pending spec review
**Owner:** Nick (Bubbles840) · **Phase:** 2 of the budget arc (Phase 1 = semester
pool + runway, shipped in v1.28.0)

## What and why

A new **Budget tab, first in the addon's tab bar and the default landing view**:
Actual-Budget-quality reports over the money data the companion already reads,
plus a custom report builder. Wealthfolio's own budgeting tab is the weak spot;
this replaces the *viewing* half. Budget **editing** stays in Wealthfolio —
this tab writes nothing to the ledger.

Scope decisions made with Nick:

- Reports first, read-only over financial data; the only writes are addon-owned
  config secrets (custom reports, layout, pool config).
- Custom builder is a must: user-defined series with category add/subtract
  math, chart type + range, account filters, saved named reports.
- Ten standardized reports (list below).
- Mobile is a hard requirement — the tab, every report, and the builder must
  work well on a phone.
- Layout: dashboard + drill-in (chosen visually), with a user-customizable
  arrangement (pin heroes, reorder, hide).
- Addon keeps the SimpleFin Sync name for now.

## Architecture: published data cube (Approach A)

The addon SDK exposes no category data, so all aggregation happens in the
**companion**, which publishes one compact secret per sync:

### `report_cube` (shared/report-cube.ts, `REPORT_CUBE_SECRET_KEY`)

- `version: 1` — addon treats unknown version or absent cube as "companion not
  ready" and says so in one banner rather than rendering empty charts.
- `asOf` ISO timestamp.
- Dimensions, index-aligned: `months` (last 24, cap 36), `categories`
  (parent-level names), `accounts` (`{ sfinId, name, type }`).
- Series:
  - `spend[month][category][account]` — signed cents, refunds negative, from
    the classifier transcription every existing report uses (transfers excluded
    by construction).
  - `uncategorized[month][account]`, `income[month][account]` — income as
    Wealthfolio classifies it, with internal transfers and in-transit
    placeholders excluded (a card payment must never read as income).
  - `budgets[month][category]` — from `budget_targets`, `default` rows filled
    per month.
  - `merchants[month]` — top 20 `{ name, cents, count }` by normalized
    description (tx-id/markers stripped).
  - `feesInterest[month]` — cents.
  - `netWorth[month]`, `liquid[month]` — month-end cents, `null` = unknowable.
    **Open verification:** depends on Wealthfolio's valuation-history table;
    verify with `PRAGMA table_info` against the live DB during implementation.
    Fallback: the companion accrues its own monthly snapshot from the latest
    valuations, charts grow forward from install day.
  - `pool` — current `SemesterPoolConfig` + daily cumulative spend over the
    pool window (for the burn-down chart), or null.
- Size guard: dense arrays, ~30–50 KB at 24 months; if serialization exceeds
  ~200 KB the companion trims oldest months, never fails the publish.
- Publish is guarded like `pool_status`: a broken publish costs a stale tab,
  never a sync; skipped when the DB is unreadable (a cube of zeros is a lie).

Everything the tab renders — standard and custom — is a pure function of this
one object. Rejected alternatives: a companion HTTP API for the iframe (new
auth/CORS/network surface, not worth it for v1) and addon-side computation
(impossible: no category data in the SDK).

### Charts

`recharts` and `@wealthfolio/ui/chart` (`ChartContainer`, `ChartTooltip`,
`ChartLegend`, …) are **host-provided** (see `hostProvidedDependencies` in
vite.config.ts): ~zero bundle cost and native Wealthfolio look/theming. The
seasonality heatmap is plain divs.

## The ten standard reports

Shared: one date-range control (default 12 months; 6/12/24/all/pool-window),
each report also usable full-screen with its own controls.

1. **Pool burn-down** — actual remaining vs ideal glide line to the end date,
   run-out crossing marked. Absent (not empty) when no pool is set.
2. **Cash flow by month** — income vs spending bars + net line.
3. **Category trends** — stacked bars ⇄ lines, category chips to isolate.
4. **Net worth over time** — line; null months are gaps; an all-null series
   explains it is accruing.
5. **Savings rate trend** — (income − spending) ÷ income; zero-income months
   render as gaps with a note (lump-sum loan income makes this spiky — known
   and accepted; the pool is the honest lens meanwhile).
6. **Merchant leaderboard** — month/quarter table: rank, merchant, total,
   count, trend arrow vs that merchant's trailing 3-month average.
7. **Budget vs actual** — per category, budget bar with actual overlay, sorted
   by worst overshoot; defaults to last complete month.
8. **Seasonality heatmap** — category × month, color = spend.
9. **Fees & interest** — bars by month; all-zero renders "nothing — as it
   should be".
10. **Runway trend** — `liquid ÷ trailing-90d monthly spend` line; gap rules
    as net worth.

## Custom report builder

Definition (versioned, in addon-owned `custom_reports` secret, array):

- `id`, `name`, `chart` (line/bars/stacked/area/donut/table),
  `range` (last N months / all / pool window), `accounts` (sfin ids or all);
- `series[]`: label + `terms[]` of `{ sign: +1|−1, source }`, where source is a
  category, total income, total spending, or uncategorized.

Evaluation is one pure `shared/` function over the cube (month value =
Σ sign × account-filtered slice); donut aggregates the range; table = months ×
series. Builder UI: chip-based (touch-first), live preview on every tap,
save/edit/delete/duplicate. A term naming a category missing from the cube
contributes zero and shows an "unknown category" chip on the card — never a
crash, self-heals if the name returns.

## Layout: dashboard + drill-in, user-arranged

- Tab order: `budget` first and default for users with no stored tab.
- **Hero row**: up to two large charts (default pool + cash flow; pool
  auto-yields to cash flow + category trends when no pool). Stat chips under
  it: runway, this-month spend, savings rate when meaningful.
- **Card grid**: every other report as a live small preview, tap → full-screen
  view with controls and back. Custom reports in the same grid; "+ New report"
  last.
- **Customize mode**: per-card buttons — pin as hero (max 2, oldest bumps),
  move up/down, hide (hidden collect in a recoverable bottom row). No drag in
  v1 (buttons work on phone and keyboard). Persisted in addon-owned
  `budget_layout` secret `{ heroes, order, hidden }` keyed by stable report
  ids; unknown ids ignored, new reports append — upgrades and deletions cannot
  corrupt the arrangement.

## Mobile

Single-column-first: heroes stack; grid `auto-fit` to one/two columns;
full-screen report view is the primary phone experience; touch targets ≥44 px;
tables scroll horizontally inside their own container (no sideways page
scroll); tooltips on tap via host chart kit; builder is chips/selects only.

## Empty/error states

Absence explains itself: no cube → one banner naming the companion and the
last publish, not ten empty charts; stale cube (>2 days) → "as of" warning
strip, charts still render; unknown version → upgrade banner; per-report gaps
per the report list above.

## Testing

- Companion cube assembly against mocked native readers; every new SQL reader
  (per-account spend, merchants, fees, valuation history) pinned by tests.
- `shared/` cube selectors, builder evaluation (+/− math, account filters),
  and layout-merge rules pure-tested against cube literals.
- Tab UI integration-tested through `SyncPage` (house pattern): grid renders
  from a cube fixture, customize persists, builder saves, drill-in opens,
  banner states.
- Charts: assert the data handed to recharts, not pixels.

## Out of scope (v1)

Per-transaction drill-down inside a report, budget editing, drag-and-drop
arrangement, report sharing/export, more than 36 months of history.
