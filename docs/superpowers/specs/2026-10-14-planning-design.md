# Planning — design (project 5, R1)

> **Approved by Nick on 2026-10-14** and released in 1.61.0. Claude designed
> it overnight on 2026-10-13/14 under Nick's standing instruction to keep going
> until every phase was done, choosing the recommended option at each decision;
> the rulings below record those choices.

This is project 5 of the roadmap approved on 2026-10-12, "Planning". The roadmap lists four ideas:
- a low-balance forecast (built on project 1's upcoming bills);
- savings goals;
- a month-end review;
- an in-add-on report inbox.

## Decisions (rulings, each with its cost if wrong)

| # | Decision | Cost if wrong |
|---|---|---|
| N1 | **The forecast assumes no income.** Nothing in the add-on detects paychecks, and Nick's own income is lump-sum (the pool exists for that reason). The forecast is framed as "if nothing comes in": cash today, minus known bills on their dates, minus typical daily spending. It never claims a paycheck that may not come. | People with regular paychecks see a pessimistic line. The wording makes the assumption plain. |
| N2 | **Cash means CASH accounts only.** Cards are left out. A card bill is already a dated bill in the roster when it's a recurring payment; otherwise card debt isn't modelled. | none |
| N3 | **The forecast shows in three places:** <br>• a Home tile <br>• a weekly check-in line (Full detail) <br>• `/forecast` in Telegram (More commands) <br>The daily report only gains a warning line when cash would run short within 14 days. | none |
| N4 | **Month-end review = the existing monthly wrap-up plus a Full-detail section.** The section covers: <br>• the biggest month-over-month changes <br>• top merchants <br>• subscription changes (new, gone, price rises) <br>• net worth and savings rate <br>• the change log's count of changes. <br>Brief mode is unchanged. | none |
| N5 | **Report inbox = unread state on the Reports tab.** <br>• A count on the tab. <br>• "New" on unseen editions. <br>• Opening a report marks it seen. <br>Seen state is kept in an add-on secret, `reports_seen`, written by the add-on only, so it is shared across the person's devices. | none |
| N6 | **Savings goals are deferred (R2).** Wealthfolio already has save-up Goals, funded by account shares. Building separate spending-side goals would duplicate them. R2 can show their progress in the reports, read-only, through the companion's REST. | Goals wait. |

## What exists today (facts)

**Upcoming bills.** The roster (`shared/subscription-roster.ts`) has `nextDate` and `cents` per subscription or bill. `dueWithin(roster, today, days)` lists what is due. There is no funding account per bill, and no income detection.

**Balances.** `account_balances` holds the bank balance per SimpleFin account, in dollars. The cube's `liquid`/`netWorth` are month-end series.

**Projections that already exist:**
- `computeRunwayMonths` (a ratio, in the weekly check-in);
- `monthEndForecast` (a spending-only transcription of Wealthfolio's own);
- the pool burn-down (a run-out date at the current pace).

There is no dated balance projection.

**Monthly wrap-up.** `composeMonthlyWrapUpMessage` → `formatMonthlyWrapUp` lists category spent against budget, plus a verdict. The cube holds 24 months; report-data has mom-delta, savings rate, merchants and subscriptions. The change log holds 90 days.

**Reports tab.**
- The archives `reports_daily`, `reports_weekly` and `reports_monthly` hold `{live, archive[]}` text editions.
- The companion writes them; the add-on only reads them.
- There is no unread state, badge or count.

## A. Low-balance forecast (N1–N3)

`shared/forecast.ts` exports `forecastCash({ cashCents, today, bills, dailySpendCents, days: 30 })`. It returns:
- the daily balance series;
- the low point (amount and date);
- the first date the balance goes below $0, if any.

Its inputs:
- **Cash:** the sum of CASH accounts' bank balances (from `account_balances` and the account types).
- **Bills:** roster entries due in the next 30 days, each subtracted on its date. Monthly entries repeat if a second date falls inside the window.
- **Daily spend:** `monthEndForecast`'s daily average over the previous 3 full months, minus the recurring bills' share, so bills are not counted twice.

The companion computes it after each sync and publishes `cash_forecast`: `{at, cashCents, lowCents, lowDate, shortDate?, bills: [...], dailySpendCents}`.

What it says (the plan fixes the exact copy):
- **Home tile** "Next 30 days":
  - "If nothing comes in: $1,240 left on Nov 13", or
  - "If nothing comes in: short around Nov 3".
  - Tapping it shows the bills it counted and the daily-spend assumption.
- **Weekly check-in (Full):** "🔮 Next 30 days: $X left at the low point (Nov 13) if nothing comes in."
- **`/forecast`:** the same line, plus the bills list.
- **Daily report:** only when `shortDate` is within 14 days: "⚠️ Cash may run short around Nov 3 if nothing comes in."

Failures: if the balances or the roster can't be read, there is no forecast, and the tile says so. A failed read is never shown as a confident number.

## B. Month-end review (N4)

The monthly report on the 1st keeps today's per-category lines. In Full detail it adds a section, built from the cube and the change log:
- The 3 biggest category changes against the month before (mom-delta).
- The top 3 merchants.
- Subscriptions that are new this month, are no longer charging ("cancelled?"), or rose in price.
- Net worth: the month-end change.
- Savings rate.
- "N changes were made to your books (see /changes)."

Each line is left out when its data is missing or empty. Bank and merchant text is escaped, and the section is archived with the report.

## C. Report inbox (N5)

- `reports_seen`: `{daily?: iso, weekly?: iso, monthly?: iso}`, the newest `generatedAt` seen per kind. The add-on is the only writer.
- The Reports tab shows:
  - **an unread count** (editions with `generatedAt` > seen), on the tab and on each kind's sub-tab;
  - **a "New" marker** on unseen editions.
- **Marking seen:** opening a kind's sub-tab marks it seen (one write, best-effort).
- **First run:** on an install with no `reports_seen`, everything counts as seen, so a new user doesn't get a wall of "new".

## D. Testing and release

**Tests:**
- **Forecast:**
  - bills on their dates;
  - a monthly bill repeating inside 30 days;
  - the low point;
  - the short date;
  - no bills;
  - failed reads.
- **The review section:** each line, and each missing-data case.
- **Unread counts:**
  - first run;
  - the mark-seen write;
  - a corrupt `reports_seen` (treated as all seen and rewritten).
- **Telegram:** escaping, and callbacks of 64 bytes or fewer.
- **App:** no emoji, each CSS rule once, and dates pinned in tests.

**Release:**
- One release.
- CHANGELOG under [Unreleased]; README (`/forecast`, the forecast tile, the inbox); follow-ups §15.
- Gates:
  - `npm test`
  - `npm --prefix companion test`
  - `npm run type-check`
  - `npm --prefix companion run build`

## Out of scope (R2 and later)

- Savings goals: show Wealthfolio Goals' progress read-only (N6).
- Income detection (recurring deposits), which would make the forecast optimistic-capable.
- Card balances in the forecast.
- Charts in the report archive.
