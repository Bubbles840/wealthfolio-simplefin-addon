# Minimalism pass, parts 2b, 2c, 3 and 4 — design

Nick approved the idea list on 2026-10-09 and then asked for all of it to be
built without stopping for per-part approval. This file records the decisions
made in that mode, so each one can be checked and reversed. Part 2a (three tabs)
has its own spec: `2026-10-09-three-tab-navigation-design.md`.

## 2b. Settings diet

### Report detail: one switch replaces eight

| Removed control | What happens now |
|---|---|
| "$X left this month" summary line (checkbox) | Always shown |
| Off-budget section in the daily report (checkbox) | Shown in **Full**, hidden in **Brief** (still counted in the total either way) |
| Pool section in the weekly report (checkbox) | Always shown while a pool is set |
| Cash runway line in the weekly report (checkbox) | **Full** only |
| Subscriptions line in the weekly report (checkbox) | **Full** only |
| Biggest spends in the weekly report (checkbox + count) | 5 in **Full**, 3 in **Brief** |
| Semester pool line (select, Report content) | Always allowed; the line itself only appears when the pool is in trouble (1.57) |
| Month-end projection (select, Report content) | Always allowed; it only appears to warn, from the 8th (1.57) |

- **New stored key:** `reportDetail: 'brief' | 'full'`.
- **Readers:**
  - An existing config without the key reads as `full`, so nothing changes for
    anyone who already has Telegram set up.
  - A brand-new config defaults to `brief`.
- **Legacy keys are ignored:** `digestSummary`, `digestOffBudget`,
  `weeklyPoolSection`, `weeklyRunway`, `weeklySubscriptions`,
  `weeklyTopSpendCount`, and the `pool_line` and `month_projection` secrets.
  Someone who had switched one of these off sees it come back. The CHANGELOG
  says so.

### Other cuts

- **Auto-sync interval:** options are Off / 4 / 6 / 12 / 24 hours in both
  setup and Settings. Hourly is gone, since the bridge refreshes every few
  hours anyway. A stored value not in the list (1 or 8) still shows as its own
  option, so the select never goes blank.
- **Report content:** "Weekly amounts per category", "Spent figures when over
  budget" and "Subcategories" move under a **More options** disclosure. The
  icon style and "Spending with no budget" stay visible.

### Shorter banners

Each long banner becomes one sentence, plus a **Why?** disclosure holding the
rest of today's text, nothing deleted. This applies to:
- the two balance-difference banners and the unmapped-accounts banner on Home;
- the Amazon "no emails yet" note;
- the pool card's explanation;
- the Spending Tracker note in Settings.

## 2c. Budget

- **Starting set:** a fresh layout (no stored layout, or after Reset layout)
  shows 6 reports:
  - the headline numbers;
  - the pool burn-down when a pool is set, otherwise cash flow;
  - cash flow when a pool is set, otherwise category trends;
  - budget vs actual;
  - top merchants;
  - subscriptions.

  Everything else, "Data check" included, starts hidden. A stored layout keeps
  exactly what it had, so Nick's arrangement does not change.
- **"+ Add report"** replaces "+ New report". It lists the hidden reports
  (tap to add one back) and "Build your own…", which opens the existing
  builder. Hidden reports no longer need Customize to come back.
- **Customize:** each card's seven buttons become one **⋯** button opening a
  menu with:
  - for a custom report: Edit, Duplicate, Delete;
  - Move to front, Move up, Move down;
  - Size, Range, Colors;
  - Hide.

  The items keep their accessible names. Drag-to-move and the resize handle
  are unchanged.

## 4. New users

- **Setup** is two steps: connect, then map accounts. Saving the mapping
  finishes setup and turns on auto-sync every 6 hours. Rules start empty and
  live in Settings → Transaction rules.
- **Budget without the companion:** instead of the amber "Reports need the
  companion" banner, an empty state. It says, in one sentence, that budget
  reports come from the background companion, with a **Set up background
  sync** button that opens Settings → Sync → Background sync.
- **README:** the top is what it does, a screenshot, and three setup steps.
  The feature list is updated (Home and Budget, Reports, the Telegram bot,
  Amazon categorization). Deep detail stays below, under its own headings.
- **Cover images:** new light and dark covers rendered from the real 1.57 UI
  with sample data, replacing the v1.12 ones.

## 3. Telegram: one voice

### Fewer separate messages

When the daily report is on, these stop arriving as their own messages and are
covered by the daily report's 🧹 list instead:

| Message | Where it now appears |
|---|---|
| Unmapped-account notice | The daily report's problem line (it already printed there) |
| Balance-difference and feed-lag alerts | A new finding per account: "{account} is {$X} {above/below} the bank's balance" (snoozable) |
| Stuck-transfer alert | The existing unlinked-transfer and held-transfer findings |

- **Daily report off:** the separate messages are sent exactly as before, so
  nothing goes unannounced.
- **No companion running** (found in the final review): only the companion
  sends a daily report, so the addon folds its own alerts only when the
  companion's `sync_health.lastSuccessAt` is under two days old. Otherwise it
  sends them, as before.
- **The drift finding needs an open alert episode** (found in the final
  review): `drift` is recorded from $1 for the balance chips, so the finding
  appears only past the drift-alert threshold, and never with alerts off. It
  stays a warning (folded and snoozable) after 10 days rather than a problem
  printed in full every morning.
- **Kept as instant messages:**
  - the import notice (it carries the categorize buttons);
  - large-transaction alerts;
  - the 24-hour sync-failure alert;
  - refused imports (already once only, and about possibly-missing money);
  - pruned duplicates (only on deep scans);
  - new Amazon labels.

### One vocabulary

- **✅** only ever means "synced". "On track" in the daily report, under-budget
  rows in the monthly wrap-up and "Nothing to fix" lose their ✅.
- **Back buttons** read "‹ Back"; **undo buttons** read "↩ Undo".
- **Money:** a single transaction keeps cents, with thousands separators
  everywhere (the alerts and findings used `toFixed(2)` without commas).
  Totals stay whole dollars.
- **Dates** read "Oct 9" in every message, timestamps "Oct 9, 3:40 PM".
  Replaced: raw `YYYY-MM-DD` in refused-import and prune notices, `MM-DD` in
  /dismissed, and container-locale timestamps in failure alerts.

### Fewer commands

The ☰ menu and `/help` list seven commands:

| Command | Does |
|---|---|
| `/report` | Today's report |
| `/left` | What's left; `/left groceries` narrows it, `/left groceries 20` answers "can I afford $20 of groceries" |
| `/categorize` | File, refile and review transactions |
| `/charts` | Charts and the dashboard |
| `/status` | Last sync, balances, what needs attention |
| `/sync` | Pull new transactions now |
| `/help` | The list, plus "more commands" |

- `/afford`, `/pool`, `/recategorize`, `/newrule` and `/dismissed` keep
  working. They move out of the ☰ menu into `/help`'s "More commands" section.
