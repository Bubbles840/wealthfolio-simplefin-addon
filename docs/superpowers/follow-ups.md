# Known follow-ups

Findings that survived a review cycle without being fixed, with enough context
to act on them later. Each says why it was deferred, so a future reader can
tell "decided against" from "not got to yet".

Last updated: 2026-07-29, after adding the weekly report's "biggest this week"
section (two new entries under "Smaller items"). Previous revision: 2026-07-29,
after adding the monthly wrap-up report (three new
entries under "Smaller items"). Earlier: 2026-07-29, after adding the
large-transaction and balance-drift Telegram alerts (which surfaced new item 3;
former items 3 and 4 are now 4 and 5). Earlier: 2026-07-29, after fixing the
companion drift inflation
(former item 1, now under "Fixed"). Earlier: 2026-07-28, after the
notification-system-redesign branch
(plan: `docs/superpowers/plans/2026-07-28-notification-system-redesign.md`).

---

## Fixed

### Companion drift was inflated by every linked TRANSFER_OUT (was item 1)

Fixed 2026-07-29 in `shared/sync-core.ts`. The drift measurement decided
"is this leg linked?" by consulting `ledgerLinkedTxIds`, which is only ever
populated inside `if (!readsGroups)` — so on the companion
(`RestSyncHost.capabilities.readsSourceGroupId === true`) the set was
permanently empty and **every** `TRANSFER_OUT` was subtracted from
Wealthfolio's valuation, including correctly-linked legs whose cash had already
moved.

Confirmed live against the user's real accounts before the fix
(`reported = sfBalance − wfValuation + unlinkedTransferOut`):

| Account | Bank | Wealthfolio | True drift | Reported drift | Wrongly subtracted |
|---|---|---|---|---|---|
| Spend | 3475.23 | 2175.23 | 1300.00 | 8650.45 | 7350.45 |
| Savings | 610.65 | −686.85 | 1297.50 | 10797.50 | 9500.00 |

With **Aggressively auto-heal** on, those figures would have been written into
real accounts as spending-neutral `CREDIT` balance adjustments.

First fix (e80707a) made the test capability-aware, mirroring the linking step:
on a host that reads groups the row's own `sourceGroupId` was treated as
authoritative; only where that field is unreadable (the addon) did the ledger
stand in. That took Spend from 8650.45 to 2700.00 — a real improvement, but it
treated the symptom.

### …and then the predicate itself was measuring the wrong property

Fixed 2026-07-29, same file. "Is the leg linked?" was never the right question.
Cash movement depends on whether the leg carries an **asset**:
`handlers/transfers.rs`'s `handle_transfer_in`/`handle_transfer_out` book cash
**only** on the `if asset_id.is_empty()` branch (`companion/upstream-pr.md`,
issue #5, "WORKAROUND FOUND" — source-verified). So an asset-free leg moves cash
whether or not it is linked, and a leg carrying the mis-resolved literal `$CASH`
*security* moves nothing. Linking governs spending **classification**, not the
balance.

Proven against the live database — every one of his 18 transfer-out legs is
asset-free, so all 18 booked cash, yet the 4 unlinked ones were still being
subtracted, double-counting money already gone:

```
grp       asset       n   total
UNLINKED  (no asset)   4   4000.00
linked    (no asset)  14  12850.45
```

| Account | Bank | Wealthfolio | True drift | Reported after e80707a |
|---|---|---|---|---|
| Spend | 3475.23 | 2175.23 | 1300.00 | 2700.00 |
| Savings | — | — | 1297.50 | 3897.50 |

The predicate is now `r.type === 'TRANSFER_OUT' && !!r.assetId`, and the variable
is `assetBackedTransferOut` (the old name described the wrong property). Two
consequences: it agrees with the relink sweep below it, which keys on exactly the
same property (`!row.assetId → skip`) to decide which legs are broken; and the
`isLinked` helper e80707a introduced here is gone, along with any capability
check in this expression. `ledgerLinkedTxIds` stays — the linking step still needs
it.

Regression tests in `shared/sync-core.test.ts` now pin the property rather than
the symptom: asset-free legs are never compensated for (linked or not, on both
host capabilities), an asset-carrying leg still is, and the live two-account case
above is reproduced end to end down to the figure reaching
`store.setAccountBalances` and the balance-drift alert. The user's true drift is
over the alert's $100 default, so he is legitimately alerted for 1300.00 /
1297.50 — that is correct behaviour.

Note the block is **legacy-only** — an unpaired leg is imported as an in-transit
placeholder (`CREDIT`/`DEPOSIT`) and the relink sweep re-creates asset-carrying
legs asset-free, so no new data reaches it — but production still holds
pre-placeholder `TRANSFER_OUT` rows, so it should not be "cleaned up".

---

## 1. The test double models the server's update semantics backwards

`shared/fake-host.ts`: `saveMany` **replaces** a row on update
(`rows[idx] = toHostActivity(w.id, w)`), so an omitted `symbol` clears
`assetId`. The real server does the opposite — its `asset` field is a plain
`Option`, so an omitted symbol means *leave unchanged*. That inverted
assumption is the exact premise of the phantom-`$CASH` bug the branch's merge
gate existed to fix.

Also: the fake's `linkPair` stamps a `sourceGroupId` onto the existing rows
instead of deleting and re-creating them, which is no longer what either real
host does.

Consequence: in the fake's universe the phantom asset **cannot exist**, so the
promotion test passes without being able to assert the thing that actually
matters (final row carries no asset and the full amount). The production code is
correct — verified by reading — but the regression net has a hole precisely where
the most expensive lessons were learned.

Fix direction: make the fake's update **merge** onto the existing row
(preserving `assetId` when `symbol` is absent), and have its `linkPair`
delegate to `linkPairByRecreate` over its own `saveMany`. Expect to fix a few
existing tests — that is the point. Then extend the promotion test to assert the
final row has no asset and the full amount.

---

## 2. A failed `linkPair` leaves a leg the relink sweep will never repair

`shared/sync-core.ts` (a comment at the site records this too): both legs are
added to `linkedTxIds` *before* `host.linkPair(legs)` is called. When linking
fails, the promoted leg keeps its phantom `$CASH` asset, and the end-of-run
relink sweep — the one mechanism that could repair it — skips it precisely
because it is in `linkedTxIds`. It does not self-heal on later runs either: the
pair is re-detected, re-added, and re-skipped every time.

The stuck-transfer alert does fire after three consecutive failures, so the
situation is not silent — but nothing repairs it.

Fix direction: do **not** simply move the `add` after a successful link — the
sweep would then run in the same pass against `wfId`s that `linkPair` may have
already deleted. Better: once `linkFailures[key].count` crosses the alert
threshold, stop offering that pair to `linkPair` and let the *next* run's sweep
(which reads fresh rows) repair the legs asset-free.

---

## 3. The addon consumes alerts it cannot deliver

Every alert `runSyncCore` produces is marked delivered — or simply dropped — by
whichever syncer ran, but only the **companion** can actually send a Telegram
message. The addon runs the identical core, so an in-app sync:

- writes `transfer_link_failures[key].alerted = true` and `drift_alerts[id].alerted
  = true` for episodes nobody ever announces, which the companion then skips
  because the ledger says the user was already told;
- discards `largeTransactionAlerts` entirely, and since a create happens once per
  SimpleFin tx id, a row the addon imported can never be announced afterwards.

Pre-existing for the stuck-transfer alert (shipped with the notification
redesign); the drift and large-transaction alerts added 2026-07-29 inherit it by
following the same pattern deliberately. Only bites users who run both syncers
against one Wealthfolio instance — which this repo's own deployment does.

Fix directions, roughly in order of appeal:
1. Have the addon deliver too (it has `ctx.api.network`, which
   `sendTelegramMessage` already accepts as its `network` argument) — no shared/
   change needed, the addon just calls the senders itself.
2. Give the ledgers a `queuedBy: 'addon' | 'companion'` field so the companion
   re-queues anything the addon marked.
3. Have the addon pass an option telling the core not to mark or emit alerts at
   all, leaving every notification to the companion's own sync cycle.

---

## 4. Smaller items

- **`shared/link-pair.ts`** collects delete errors into `problems` but issues the
  creates anyway, short-circuiting only afterwards. Now that both hosts
  delete-and-re-create, two concurrent syncers can double-create legs. Moving
  the `if (problems.length > 0) return { linked: false };` above the create
  block is two lines and removes the question entirely.
- **`companion/src/wealthfolio.ts`** — `linkTransferActivities` is dead
  production code since linking moved to `shared/link-pair.ts`; two tests still
  pin it. Delete all three.
- **`companion/src/index.ts`** — the 24h health alert interpolates a
  companion-generated timestamp inside a `*…*` bold entity unescaped. Not
  user-controlled, so not currently reachable, but inconsistent with
  `escapeMarkdown` usage elsewhere.
- **`companion/src/sqlite-native.ts`** — no test covers the December→January
  branch of the `nextMonth` calculation. Verified correct by hand; a four-line
  test would pin a branch that fires once a year and cannot be noticed manually.
- **An amount revision on a cash-outflow in-transit placeholder is invisible**
  while it is in transit: both the stored `amount` and the computed
  `bookedCents` are 0 regardless of magnitude, so a bank restating $1,300 →
  $1,400 plans no update. Auto-heal may plug the $100 and the later promotion
  then corrects it again, double-counting. Bounded at 10 days and
  self-correcting; structurally unfixable without a `fee` field on
  `ExistingRow`.
- **`addon.store.json`** version still trails `package.json` / `manifest.json` /
  `companion/package.json`.
- **README / `docker-compose.example.yml`** do not document
  `DAILY_REPORT_SCHEDULE`, `WEEKLY_REPORT_SCHEDULE`, `MONTHLY_REPORT_SCHEDULE`,
  or `TZ`.
- **`monthlyReportEnabled` / `monthlyReportCategories` have no UI.** The fields
  exist on `TelegramConfig` and the companion honours them, but
  `src/pages/SyncPage.tsx` renders only the daily and weekly toggles, so the
  monthly wrap-up can currently only be disabled or narrowed by hand-editing the
  `telegram_config` secret. Deliberate — the settings UI was scoped out of the
  report's own task.
- **`weeklyTopSpendCount` has no UI,** same as `monthlyReportEnabled` above: the
  Saturday report's "biggest this week" section defaults to 5 rows and can only
  be resized or switched off (`0`) by hand-editing the `telegram_config` secret.
  Deliberate — the settings UI was scoped out of the section's own task.
- **The "biggest this week" list is NOT narrowed by `weeklyReportCategories`,**
  while the headline total above it is. Deliberate: the section answers "where
  did the money go this week", and suppressing the week's largest charge because
  its category is not budgeted would mislead. Each row carries its category, so
  a reader can see when a listed spend is outside the budgeted set — but the two
  halves of the message do describe slightly different populations. If this ever
  needs to change, filter in SQL by category ID (never by interpolating
  user-entered category NAMES into the query) and over-fetch, since the `LIMIT`
  applies before any post-filter.
- **A multi-category activity is listed once per assignment.** The
  `activity_taxonomy_assignments` join can match an activity more than once, so
  such a row would appear twice in the top-N list (and is already double-counted
  by the two aggregate readers). Not observed in practice — Wealthfolio's UI
  assigns one category per activity — and fixing it properly means deciding
  which category owns the spend.
- **All three reports write `available_report_categories`,** and the monthly one
  publishes the union for the month it reports — i.e. the PREVIOUS month. On the
  1st the checklist therefore reflects last month until the next morning's daily
  digest republishes the current one. Harmless in practice (a closed month's
  union is usually a superset of a day-old one), but it does mean the secret's
  meaning depends on which report wrote it last.

---

## 5. Verify on a real instance

Not code findings — things a test suite structurally cannot answer.

1. **`docker build -f companion/Dockerfile -t simplefin-sync:test .`** — never
   run during the redesign; Docker was unavailable in that environment. The new
   `HEALTHCHECK` was verified by inspection only.
2. **Send a report containing a category name with an underscore or asterisk.**
   The highest-value manual check: Telegram's legacy Markdown rejects an
   unbalanced entity by failing the *whole* message, and escaping behaviour
   inside entities is the one thing that cannot be settled locally.
3. **Set `TZ` in the compose file.** `node:22-alpine` has no timezone, so
   `0 8 * * *` fires at 08:00 **UTC** — 04:00 Eastern — and the Saturday report
   at 05:00 Eastern. `formatSyncHealthFooter` will also render UTC timestamps.
4. **Watch one real in-transit transfer end to end.** After it links, confirm:
   both legs carry no asset, the account balance moved by the transfer amount
   exactly once, and neither leg appears on the Spending page.
5. **Audit for stray `Balance adjustment ·` rows** on cash accounts that have
   linked transfers — the fingerprint of the now-fixed drift inflation (see
   "Fixed"). The fix stops new ones; any written before it are still there and
   have to be removed by hand.
6. **Confirm the Saturday report is wanted by default.** Only
   `weeklyReportEnabled === false` suppresses it, so an existing
   `telegram_config` without that field opts in silently.

---

## Reference: name mismatches between the database, the REST API, and the SDK

Every one of these cost a diagnostic cycle against the live instance on
2026-07-29. Check here before writing a query or trusting a field name.

- **The activity comment column is `notes` in SQLite, but `comment` over the REST
  API.** `SELECT comment FROM activities` fails with `no such column: comment`.
  `RestSyncHost`'s mapper tolerates either (`a.comment ?? a.notes ?? a.description`),
  which is why this only bites hand-written SQL and new queries.
- **The activity search endpoint is 0-indexed** — `page: 0` is the first page.
  Asking for `page: 1` with `pageSize: 500` returns an *empty* list on any account
  with under 500 activities, which reads as "nothing has ever been imported".
- **Its account filter key is `accountIdFilter`**, not the SDK's `accountIds`.
  Passing `accountIds` is silently ignored and returns rows from every account.
- **It accepts no sort parameter**, so `RestSyncHost.listOldestActivities` has to
  paginate and sort client-side; the SDK adapter passes `{ id: 'date', desc: false }`
  and gets it server-side.
- **The addon-secrets write endpoint wants `{ key, secret }`**, not `{ key, value }`.
  The wrong shape 422s with `missing field 'secret'`. Reads pass the key as a query
  parameter and were never affected, so writes can be broken while reads look fine.
- **`/activities/bulk` rejects a colliding create with a 400 `Duplicate activity
  detected`, and that aborts the entire batch** — one duplicate loses every create
  in the request. Rows carry an `idempotencyKey` the server computes.
- **Transfer cash movement depends on `asset_id` being empty, not on linking.**
  `handlers/transfers.rs` books cash only on the `if asset_id.is_empty()` branch;
  linking (`source_group_id` + marker) governs spending *classification* only. See
  `companion/upstream-pr.md` issue #5.
