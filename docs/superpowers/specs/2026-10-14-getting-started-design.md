# Getting started — design (project 4)

> **Not yet approved by Nick.** Claude designed this overnight on 2026-10-13/14,
> under Nick's standing instruction "keep going until we're done with all the
> phases", taking the recommended option at each decision. The rulings below
> record those choices. It ships as an **open PR, not merged**, so Nick can review
> the design before it reaches main.

Project 4 of the roadmap approved on 2026-10-12 is "Getting started", for people who install the add-on from Wealthfolio's store. The roadmap names three things:
- a Docker compose helper card;
- a sample-data preview before a bank is linked;
- budgets suggested from 3 months' history.

## Decisions (rulings, each with what it costs if wrong)

| # | Decision | Cost if wrong |
|---|---|---|
| G1 | **One compose snippet, written once in shared code.** The app's "Background sync (Docker)" card, the README and `docker-compose.example.yml` all use it, and a test keeps them identical. The three versions that disagree today go away. The card fills in the browser's timezone and the add-on's id. It never fills in a password. | The app's snippet follows the README's network style, which may not fit a host-network install. A comment line in the snippet covers that case. |
| G2 | **The preview uses a built-in sample report cube, Budget tab only.** That tab is driven entirely by the cube. The preview is offered on the Budget tab's empty state and as a link on setup step 1 ("See what it looks like"). A banner says "Sample data — not your money". It is read-only: Customize, and every write, is off. | The preview covers Budget only. Home and Reports keep their empty states. |
| G3 | **Suggested budgets are applied from Telegram (`/budgets`).** The add-on has no budget write (the SDK has no budget API), and only the companion can write through REST. In the app, the empty budget-vs-actual card says "No budgets yet — /budgets in Telegram suggests some from your last 3 months." | The app has no apply button. |
| G4 | **Suggestions only fill categories with no budget.** An existing target is never overwritten. Each suggestion is the average of the last 3 FULL months of that category's spending, rounded up to the nearest $5. Categories averaging under $10 are skipped. | Fewer suggestions. |
| G5 | **Every budget written is a change-log entry with Undo.** A new kind, `budget-set`, records the target it created. Undo deletes that target. | none |

## What exists today (facts)

**Setup.**
- `SetupPage` has two steps: claim the SimpleFin token, then map accounts.
- Home exists only after setup. Its `SetupChecklist` has three optional rows; "Background sync" opens Settings card `docker`.

**Compose snippets.** There are three, and they disagree:
- README.md:216-229: bridge network, `http://wealthfolio:8088`, `TZ`.
- `docker-compose.example.yml`: the same, plus `user` and an external network.
- `SettingsTab.tsx:558-574`: `network_mode: host`, `127.0.0.1:8088`, and **no `TZ`**, even though the companion warns when `TZ` is missing.

**Companion settings.**
- The documented database mount is the FOLDER, read-only, with `WEALTHFOLIO_DB_PATH=/mnt/wealthfolio/wealthfolio.db`.
- The code's default is `/mnt/wealthfolio.db`.
- Auth is one of `WEALTHFOLIO_PASSWORD`, `WEALTHFOLIO_PASSWORD_FILE` or `WEALTHFOLIO_API_KEY`.

**Empty states.** With no companion:
- the Budget tab shows a calm empty state with a "Set up background sync" button;
- the Reports tab shows "No reports yet".

**The report cube.** Everything on the Budget tab is a pure function of the `report_cube` secret:
- `parseReportCube` validates it;
- 24 months, values in cents, index-aligned arrays.

**Budgets.**
- Wealthfolio budget targets live in `budget_targets`, one per period key: `'YYYY-MM'` or `'default'`.
- REST:
  - `GET /spending/budget?periodKey=` returns a `BudgetSnapshot`;
  - `POST /spending/budget/targets` takes `{periodKey, targetType:"category", taxonomyId, categoryId, amount:"…"}`;
  - `DELETE /spending/budget/targets/{id}` removes one.
- The companion reads budgets from SQLite (`getNativeWealthfolioBudgets`) but has no budget write.
- The add-on SDK has no budget API.

**Spend history.** `getNativeSpendMatrix` and the cube's `spend[m][cat][acct]` already hold the monthly spending per category.

## A. One compose snippet (G1)

`shared/compose-snippet.ts` exports `composeSnippet({ timezone?, wealthfolioUrl? })`.
- **Image:** `ghcr.io/bubbles840/wealthfolio-simplefin-sync:latest`.
- **Network:** the README's bridge style. A commented line shows the host-network alternative.
- **Environment:**
  - `WEALTHFOLIO_API_URL` (default `http://wealthfolio:8088`);
  - `WEALTHFOLIO_PASSWORD_FILE` with a secrets example, plus a commented `WEALTHFOLIO_API_KEY` alternative;
  - `WEALTHFOLIO_DB_PATH=/mnt/wealthfolio/wealthfolio.db`;
  - `TZ` (filled from the browser when known; otherwise `America/New_York` with a comment saying to change it).
- **Volumes:** the read-only folder mount.
- **Restart policy:** `restart: unless-stopped`.

How each place uses it:
- The Settings card renders it with a Copy button.
- The README and `docker-compose.example.yml` are generated from it, or checked against it. A test fails if they drift.

## B. Sample-data preview (G2)

`shared/sample-cube.ts` holds a fixed, plausible 6-month sample:
- 8 categories;
- 3 accounts;
- a few budgets;
- merchants;
- income.

It must pass `parseReportCube`, and its dates are relative to "now" (the latest month is the current one).

The Budget tab gets a `preview` mode:
- It renders the sample cube under the banner.
- Customize, layout writes and every other write are disabled.
- Leaving the preview restores the empty state.

Entry points:
- The Budget tab's empty state: "Preview with sample data".
- Setup step 1: "See what it looks like", which opens the same preview in a modal or panel. It writes nothing.

## C. Suggested budgets (G3–G5)

**Computing suggestions.** The companion works from the spend matrix:
1. Take the last 3 FULL calendar months, in Wealthfolio's timezone.
2. Average each spending category across them, summing all accounts. Refunds net out.
3. Skip:
   - categories that already have a `'default'` target or a target for the current month;
   - excluded categories;
   - "Opening balances";
   - categories averaging under $10.
4. Round each amount up to the nearest $5.

Categories are matched by id. The spend matrix is keyed by name, so the category catalog maps names to ids.

**`/budgets` in Telegram** (under More commands) opens a list: "Groceries $420 · Dining out $180 · …". It offers:
- **Apply all**;
- per-category toggles;
- **Apply selected**.

**Applying.**
- Each suggestion is `POST /spending/budget/targets` with `periodKey: 'default'` and `targetType: 'category'`.
- Each one is logged as `budget-set` (actor you), recording the new target's id and amount.
- Undo deletes that target, through `/changes` or the app's Change log.
- Before writing, the companion re-reads the budget. A category that gained a target since the list was shown is skipped and reported: "Already has a budget — left alone."

**In the app.** The budget-vs-actual card's empty state ("no budgets") points to `/budgets`.

**Failures.** If the budget read fails, the reply is "Couldn't read your budgets — nothing was set." A POST that fails is reported per category, and the rest still apply.

## D. Testing and release

**Tests.**
- **Snippet:** `composeSnippet`'s content, and the drift check across README, example and card.
- **Sample cube:** it passes `parseReportCube`.
- **Preview mode:**
  - it renders and is labelled;
  - writes are blocked;
  - it has no emoji;
  - each CSS rule appears once.
- **Suggestions:**
  - the 3-full-months window across a year boundary;
  - rounding;
  - every skip rule, including an existing target never being overwritten;
  - re-read before write;
  - a single failing POST does not stop the others.
- **Telegram:**
  - callbacks stay within 64 bytes;
  - category names are escaped;
  - Undo works through the change log.
- Tests pin their dates.

**Release.**
- One release. CHANGELOG under [Unreleased].
- README: the generated snippet and `/budgets`.
- follow-ups §14.
- Gates:
  - `npm test`
  - `npm --prefix companion test`
  - `npm run type-check`
  - `npm --prefix companion run build`

## Out of scope

- Applying budgets from the app. It needs an SDK budget API, or an upstream PR.
- Month-specific budgets (only `'default'` targets are suggested).
- A sample preview for Home and Reports.
- Auto-detecting the Wealthfolio URL or the database path.
