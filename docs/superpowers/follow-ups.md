# Known follow-ups

Findings that survived a review cycle without being fixed, with enough context
to act on them later. Each says why it was deferred, so a future reader can
tell "decided against" from "not got to yet".

Last updated: 2026-10-13, after the "Why is this here?" plan (new section 10).
Previous revision: 2026-10-13, after the change log Undo plan (new section 9).
Previous revision: 2026-10-12, after the subscriptions & bills plan (new
section 7). Previous revision: 2026-07-30, after fixing the shared-transaction-id collision
(former item 1, now under "Fixed"; former items 2-6 are now 1-5). Previous
revision: 2026-07-29, after fixing the duplicate-transaction import
(then-new item 1, which pushed former items 1-5 down to 2-6, plus three new
entries under "Smaller items"). Earlier: 2026-07-29, after adding the weekly
report's "biggest this week" section (two new entries under "Smaller items").
Earlier: 2026-07-29, after adding the monthly wrap-up report (three new
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


### One transaction id in two accounts corrupted everything keyed by tx id (was item 1)

Fixed 2026-07-30 in `shared/transfers.ts`, `shared/sync-core.ts` and
`shared/link-pair.ts` (commit e8603f1). SimpleFin issues ONE transaction id for
BOTH sides of a transfer between two accounts it connects, so every map and set
in the run keyed by transaction id **across accounts** had the second leg
silently overwrite the first.

**The write-up's open question — is this live or latent? — is answered, and the
answer changes what the evidence was worth.** The original entry rested on
calling `detectTransferPairs` in isolation, and flagged that the user's live rows
(correctly typed, and a heal reporting `plan: { creates: 0, updates: 0, deletes: 0 }`
on both accounts) did not match. Driving the whole of `runSyncCore` settled it:
the end-to-end path is **not** safe, and it is worse than the isolated call
suggested. With two mapped accounts whose feeds carry one id with opposite signs
and both legs already stored, correctly typed and grouped, a heal:

| | What actually happened |
|---|---|
| `detection.typeByTxId` | Both legs resolved to `TRANSFER_IN`, so the stored `TRANSFER_OUT` was **UPDATED** into a +$1,300 inflow — a $2,600 error — and relabelled with the *other* account's bank description. |
| `linkRowByTxId` | Both legs of the pair resolved to the SAME row. `linkPair` got `[leg, leg]`, and `linkPairByRecreate` deleted that one row and created **two in one account**, while the other account's leg was never linked. |
| `signedByTxId` | The OUT account's baseline was computed from the IN account's `+700`: `WITHDRAWAL 700` where `DEPOSIT 700` was correct, off by $1,400. Drift took the same wrong sign. |

So the live rows being clean does **not** mean the code is. Note the shape of the
`plan: { … }` log line that made them look clean: it prints inside
`if (noPending && createOnly && …)`, so it can only ever *print* `updates: 0` —
an account that planned an update produces no line at all. Both accounts printing
one really does mean neither was updated, and since a truly-shared id makes an
update on exactly one of the two accounts unavoidable, the most likely reading is
that **the three ids collide only in the 8-hex prefix that was logged**
(`TRN-<uuid>` truncated), not in full. Not confirmable from here — the local
`app.db` holds 0 activities, the live database is on the deployed server — so it
stays a reading, not a finding. Either way the code path was broken and is the
kind that fires the first time a full id really is reused.

Now keyed on `accountTxKey(sfAccountId, txId)`: `detection.typeByAccountTx` (was
`typeByTxId`), `descByKey`, `signedByKey`, `pairedKeys`, `linkRowByKey`,
`linkedKeys`, `detectTransferPairs`'s own `usedPositives`, and
`linkPairByRecreate`'s echo map — where the tx-id key made "did both legs come
back on one gid" compare the surviving leg's gid with **itself** and report
success on a dropped group, which is the single failure that echo exists to
catch. `detectTransferPairs` returns `pairs: [{ out, in }]` with each side an
`{ accountId, txId }`; a pair whose legs share an id is a legitimate transfer —
arguably the most legitimate kind — and "a leg cannot pair with itself" remains
true through the existing same-account guard rather than a new check.

Left keyed by bare tx id, deliberately: `fetchExistingRows`,
`planReconciliation`, `planDuplicatePrune`, `dedupeAccountTransactions` and the
per-account created/updated echo maps, all of which operate inside ONE account.
And both PERSISTED ledgers, `linked_groups` and `transfer_link_failures`: a
shared id identifies exactly one pair (SimpleFin does not put a third occurrence
in a third account), so one entry answers for both legs, while re-keying would
orphan live entries — every already-linked pair would read as unlinked and be
re-attempted, which on the addon means deleting and re-creating correctly-linked
financial rows, and a stuck pair's strike count and `alerted` flag would reset and
re-announce. If a shared id ever does span three accounts, that is the line to
revisit, and it becomes a read-both-shapes/write-new migration rather than a
silent re-key.

Eleven new tests, nine of which fail the moment `accountTxKey` is collapsed back
to a bare tx id (verified by mutation), including the three live pairs' exact
shape surviving a heal with zero writes. No pre-existing test needed weakening;
`shared/transfers.test.ts`'s assertions were rewritten for the new return shape
only. The one thing still NOT covered end to end is the same-id case through the
fake's own `linkPair` — it only stamps a gid — so the duplicate-row assertion
swaps in the real `linkPairByRecreate` over the fake's `saveMany`. Fixing the fake
properly is item 1 below.

---

### A link failure reported no reason, and a shared tx id vouched for both legs (was items 2-adjacent and 4)

Two failures that were invisible rather than wrong.

`linkPairByRecreate` collected every host error into a local `problems` array and
then **discarded it**, returning a bare `{ linked: false }`. That function deletes
both rows before re-creating them, so a refused re-create loses financial rows —
and the only trace anywhere was a heal-gated `N transfer leg(s) could not be
linked`. It cost a full diagnostic cycle on 2026-07-30, chasing a create failure
that had never happened. `LinkResult.problems` now carries the reason, a silently
dropped group names itself rather than failing reasonlessly, and `runSyncCore`
surfaces it on **every** sync rather than only a heal (bounded to 3 pairs, so a
systematically broken account cannot flood `errors`).

The `linked_groups` ledger — the only evidence a host that cannot read
`sourceGroupId` back has for "is this pair already linked" — was keyed by bare tx
id. A shared-id pair collapses to ONE entry, and that entry cannot distinguish
"both legs confirmed" from "the echo collapsed and only one leg was grouped",
because the writer that produced it could not tell either. The companion
therefore skipped a half-linked pair forever, leaving a transfer leg counted as
spending. Writes are now per-leg (`accountTxKey`); reads accept **both** shapes,
still trusting a legacy bare entry where the two legs carry different ids, so
live ledgers are neither orphaned nor churned — only the ambiguous shared-id case
is re-verified, once, and the legacy entry is drained as each pair is confirmed.

### Drift that no transaction can explain is now attributed to the baseline

A drift with an **empty reconciliation plan** over the heal window is a proof:
every transaction the bank reports is already stored and already matches, so
nothing inside the window accounts for the gap. The remaining candidate is the
starting-balance row — the one row standing in for history never seen — and
`drift` is by construction exactly the amount it is wrong by.
`AccountBalanceSnapshot.baselineFix` now carries that offer and the Sync page
renders `Fix baseline: $X → $Y`, demoting the plug to `(plug instead)`.

Never automatic, by explicit decision: rewriting a baseline moves a real balance.
A `Balance adjustment` plug was the only remedy before, and it dates the
correction today, shows as its own activity, accumulates a row per use, and
leaves the wrong constant in place — for the live case (two accounts off by
$1,300 in mirror image, from a transfer in flight across two baselines captured
five days apart) it would have been a four-figure lie about where money came
from.

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
added to `linkedKeys` *before* `host.linkPair(legs)` is called. When linking
fails, the promoted leg keeps its phantom `$CASH` asset, and the end-of-run
relink sweep — the one mechanism that could repair it — skips it precisely
because it is in `linkedKeys`. It does not self-heal on later runs either: the
pair is re-detected, re-added, and re-skipped every time.

The stuck-transfer alert does fire after three consecutive failures, so the
situation is not silent — but nothing repairs it.

Fix direction: do **not** simply move the `add` after a successful link — the
sweep would then run in the same pass against `wfId`s that `linkPair` may have
already deleted. Better: once `linkFailures[key].count` crosses the alert
threshold, stop offering that pair to `linkPair` and let the *next* run's sweep
(which reads fresh rows) repair the legs asset-free.

---

## 3. ~~The addon consumes alerts it cannot deliver~~ — FIXED

Fixed 2026-07-29 via direction 1 below. `src/utils/sync.ts` now exports
`deliverAddonAlerts`, called from `runSync` inside the single-flight lock and
inside the returned promise, so an in-app sync sends its own three alert arrays
through `ctx.api.network`. The message builders moved to `shared/telegram.ts`
(`formatStuckTransferAlert` joined the two already there), so both hosts render
identical text from one place and only sending + ledger bookkeeping differ.

The addon mirrors the companion's delivery discipline: `alerted` is rolled back
on a confirmed failed send for the stuck-transfer and drift ledgers, and
large-transaction alerts go through the shared `pending_large_tx_alerts` outbox
(key now `LARGE_TX_OUTBOX_SECRET_KEY` in `shared/telegram.ts`, imported by both)
because that alert is not re-derivable. A non-attempt — no Telegram config, an
unreadable one, or `enabled === false` — does nothing at all: no sends, no
rollbacks, no outbox write, exactly as before.

Duplicates stay impossible because the ledger is the interlock and both syncers
share it: the core emits a stuck-transfer or drift alert only when `alerted` is
false and flips it true in the same pass, and a large-transaction alert is
emitted once per SimpleFin tx id by whichever syncer created the row, with the
outbox merged by tx id. Residual caveat, inherent to the shared secret rather
than to the fix: these are read-modify-write cycles with no compare-and-swap, so
two syncers running in the same instant could both observe `alerted: false`.

Original text follows, for the reasoning.

> Every alert `runSyncCore` produces is marked delivered — or simply dropped — by
> whichever syncer ran, but only the **companion** can actually send a Telegram
> message. The addon runs the identical core, so an in-app sync:
>
> - writes `transfer_link_failures[key].alerted = true` and `drift_alerts[id].alerted
>   = true` for episodes nobody ever announces, which the companion then skips
>   because the ledger says the user was already told;
> - discards `largeTransactionAlerts` entirely, and since a create happens once per
>   SimpleFin tx id, a row the addon imported can never be announced afterwards.
>
> Pre-existing for the stuck-transfer alert (shipped with the notification
> redesign); the drift and large-transaction alerts added 2026-07-29 inherit it by
> following the same pattern deliberately. Only bites users who run both syncers
> against one Wealthfolio instance — which this repo's own deployment does.
>
> Fix directions, roughly in order of appeal:
> 1. Have the addon deliver too (it has `ctx.api.network`, which
>    `sendTelegramMessage` already accepts as its `network` argument) — no shared/
>    change needed, the addon just calls the senders itself.
> 2. Give the ledgers a `queuedBy: 'addon' | 'companion'` field so the companion
>    re-queues anything the addon marked.
> 3. Have the addon pass an option telling the core not to mark or emit alerts at
>    all, leaving every notification to the companion's own sync cycle.

---

## 4. Smaller items

- **The duplicate sweep only reaches ids in the current fetch window.**
  `planDuplicatePrune` requires the transaction id to be one SimpleFin reported
  for that account on the same run, so a duplicate whose transaction has aged past
  even the 89-day heal window is never pruned. Deliberate: any Wealthfolio note
  containing ` · ` parses to a "tx id" (`Lunch · Tuesday`, `Coffee · Tuesday`), and
  without the bank vouching for the id, a sweep that deletes financial rows cannot
  tell a duplicated import from two unrelated hand-entered activities. Reachable
  fix if it ever bites: read the account's full history and require the note to
  match the exact `<description> · <txId>` shape the syncers write, with the id
  matching the `TRN-`/UUID form SimpleFin actually issues.
- **A failed duplicate-prune Telegram notice is not retried.** Unlike a
  large-transaction alert (which has the `pending_large_tx_alerts` outbox) the
  prune has no queue: the rows are already deleted, so the message is not
  re-derivable on the next run. The deletions are still recorded by the per-row
  `duplicate-prune` log line and on the Sync page, so the information is not lost
  — only the push. An outbox keyed on the deleted `wfId`s would close it.
- **Pruning an account makes its drift unmeasurable for that one run,** because
  `wfValuation` is read before the sweep and so still counts the deleted rows
  (`createOnly` includes `prunedThisAccount === 0` for exactly this reason). The
  account reads "in sync" on the Sync page for one cycle even if it is not, and an
  open drift episode is neither opened nor closed. Same tradeoff the existing
  update/delete guard already makes; a re-read of the valuation after the sweep
  would fix it at the cost of another round trip and the same async-recompute lag.
- **`shared/link-pair.ts`** collects delete errors into `problems` but issues the
  creates anyway, short-circuiting only afterwards. Now that both hosts
  delete-and-re-create, two concurrent syncers can double-create legs. Moving
  the `if (problems.length > 0) return { linked: false };` above the create
  block is two lines and removes the question entirely. (The `problems` array
  now reaches the caller — see Fixed — so a failure here is at least
  diagnosable; the ordering itself is untouched.)
- **A hand-entered row cannot be deduped against a later feed backfill.** Both
  the feed dedup and `planDuplicatePrune` match on the SimpleFin transaction id,
  and a row the user typed (or a `Balance adjustment` plug) has none — so if
  SimpleFin later reports the transaction it was standing in for, the account
  double-counts and the drift swings by that amount in the opposite direction.
  Exposed on 2026-07-30 while deciding whether to enter a missing $1,300 by
  hand. Not a code defect so much as a structural blind spot in an id-based
  scheme; the detectable pattern is a marker-less row whose amount matches an
  incoming feed transaction within a few days, which is exactly the shape a
  "possible duplicate" prompt would need. Worth building only if it recurs —
  amount-and-date proximity is also how the transfer matcher produces its false
  positives.
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

## 6. Question flows (2026-10-12, plan `2026-10-12-ask-flows.md`)

Minor findings from the task and whole-branch reviews, left on purpose. None
changes what a user sees today.

- **One-liner "Which one?" replies, then "not waiting".** `/left`, `/afford`
  and `/newrule` one-liners that hit an ambiguous category print "Which one?
  …"; answering that now gets "I'm not waiting for an answer" (before: silence).
  Fix: say "send /left <one of these>" in those replies. Deferred because
  `formatCategoryQueryMiss` is shared with the question flows' retry hints.
- **`queryNativeDb` swallows errors**, so a failed read in `/newrule`'s count
  shows a confident "No transactions … match yet". Pre-existing helper.
- **The one-year window is computed twice** (transfer learning's
  `countMatches` and the `/newrule` question). Same arithmetic; no helper.
- **Typed `cancel`, `stop`, `back` are reserved** on every question, so a rule
  pattern or category literally named one of those cannot be typed.
- **Engine paths without a test:** Back from a summary (a live `/pool` path),
  `c`/`q` buttons on the wrong step kind.
- **Duplicated amount-hint wording** in `companion/src/ask-flows.ts`.
- **Pre-existing, noted while here:** bare `/pool` says "No pool set." when
  reading the status fails although a pool exists; `/pool`'s "past date" is
  judged in UTC.

---

## 7. Subscriptions & bills (2026-10-12, plan `2026-10-12-subscriptions.md`)

- **Remove the legacy-list mirror one release after 1.60.** `editSubscriptionPrefs`
  writes `hidden_subscriptions` and `confirmed_subscriptions` after every edit
  so an older companion or a stale tab reads correct lists mid-upgrade. Once
  1.61 has shipped: drop the mirror and `legacySubscriptionPrefs`'s writers'
  dependence on it, keep the two keys in `KEYS` (Reset must still clear what
  older versions wrote), and keep the read-side import from them for one more
  release so a never-edited install still imports its old choices.
- **No no-companion mode in the app.** Without a cube the Budget board is an
  empty state, so hand-added entries are only reachable from Telegram there.
  `buildRoster` already supports `detectionAvailable: false`.
- **A bill cannot be moved into Subscriptions from the UI** (only an old
  `confirmed_subscriptions` entry does that). Add a "Count it as a
  subscription" action to the bill detail if anyone asks.
- **Hidden names the detector has dropped vanish from the Hidden list** (they
  are no longer roster entries). Harmless — they come back hidden if the
  merchant recurs — but they cannot be restored ahead of time.
- **`today` is the local day, cube dates are UTC `date()` strings.** A charge
  posted in the evening west of UTC can land a day "late" on the late/overdue
  windows. Pre-existing seam (see the R2 facts); not worth a migration.
- **Weekly-cadence subscriptions and annual detection** stay out of scope
  (spec, "Out of scope").
- **A linked hand-added entry revives once detection lapses.** Detection drops
  a merchant 45 days after its last charge; the linked entry then falls back
  to `rollForward` of its stored date, so it keeps counting and reminding as
  if nothing happened. Suggested rule: when a linked entry loses its detection
  row, treat it as overdue from its last known predicted date and stop
  counting it until a charge matches again. Deferred because once detection
  lapses there is no last-charge date left to count from.
- **The `subs-cost` headline stat is a fourth copy of "what counts".**
  `shared/report-data.ts` (~403-406) ignores hidden, confirmed and hand-added
  entries, so it can disagree with the card and Telegram. Feed it the roster
  (`buildRoster`) instead of the raw cube rows.
- **Billers on the 29th-31st are predicted a day early after a short month.**
  The from-last-charge rule steps from the clamped Feb 28 to Mar 28. Suggested
  improvement: use the largest day-of-month seen in `recent` as the anchor.
- **Corrupt legacy list, and the closed document shape.** A corrupt legacy
  `hidden_subscriptions` / `confirmed_subscriptions` list imports as empty
  (the pre-existing parse). The `v:1` document has a closed shape: a new
  top-level field needs `v: 2`, or an older writer drops it on rewrite.
- **A reminder on an entry with no known date cannot be switched off.** Once
  `nextDate` is null (watched, or overdue), neither the card nor `/subscriptions`
  offers the reminder choices, so an existing reminder stays set (the app row
  still says "reminder 3d"). It cannot fire without a date and resumes when one
  returns. Suggested fix: keep a single Off button while `remind` is set.

## 8. Change log — Record (2026-10-12, plan `2026-10-12-change-log-record.md`)

- **Undo is release R2** (spec Part B). Every R1 entry already carries what its
  undo needs; deleting a category rule will need a new client method for
  upstream's `DELETE /api/v1/spending/rules/{id}` — nothing in this codebase
  calls it yet.
- **The transfer-learning menu's own ↩ Undo is not logged** (it removes the
  rule it wrote seconds earlier); the creation is. R2's state check finds the
  rule gone and refuses cleanly.
- **A Telegram filing has no account-scoped tx key** (the categorize rows carry
  no SimpleFin account id). R2 restores the category by activity id; only
  automatic filings need `noAutoFile`, and those carry the key. An Amazon
  filing whose account isn't mapped also omits the key.
- **A corrupt bucket stays until it ages out** (four months) or Reset clears it.
  A "repair" button would have to decide what in it is real; not worth it yet.
- **The Undo of a move records the complete prior state** (fixed in the R1 fix
  wave): on every `category-filed` entry `before.assignments` is the complete
  state before that action ran, so R2 can rely on it.
- **A partial move records nothing** (the unassign landed, the assign failed):
  the row is left uncategorized and no entry exists for it.
- **Rule-id fallback by name:** when the create reply carries no id, the entry's
  `ruleId` is null; R2 finds the rule by `name` via `GET /api/v1/spending/rules`.
- **An Amazon filing loses its tx key on a transient `account_mapping` read
  failure.** R2 can re-derive it from the row's note plus the mapping.
- **Watch for "older changes were trimmed" notes after deploy.** If a writer
  trims most months, split buckets by half-month or raise the cap, after
  checking the host's real secret-size limit (200 KB is a guess at about 235
  entries per writer per month at real id lengths).
- **The read-back of a new starting balance or plug costs one activity read**,
  only when a change log is attached and only on the rare run that writes one.

## 9. Change log — Undo (2026-10-13, plan `2026-10-13-change-log-undo.md`)

- **`SYNC_OVERRIDES_SINCE` is `1.60.0`** (shared/version.ts) — R1 and Undo
  shipped together in 1.60.0, so the first companion that obeys overrides is
  that release. `shared/change-undo.test.ts` fails a release that ships BELOW
  it, but cannot catch one shipped above it.
- **A held transfer's Undo waits for the leg to be in a sync's window.** The
  sync applies `notTransfer` to a feed transaction (14-day routine overlap,
  44/89 days on a re-scan). A placeholder held past that by a dead feed stays
  a placeholder until a re-scan reaches it. A linked pair is different: it is
  unlinked from the stored rows, in or out of the feed.
- **A linked leg whose other half is not in view stays linked** and the sync
  says so ("its other half is not in this sync"): deleting one leg of a pair
  deletes both, and the unseen half could not be re-created. Reached when the
  partner's account is unmapped or the row is past the 500-row read.
- **Undoing an automatic starting-balance MOVE** restores the amount and the
  date, but the next sync moves the DATE back in front of older rows (it moves
  no money); the restored amount stays. No override exists for the date.
- **Undoing a removed duplicate is almost always refused** as an exact copy —
  the prune removes copies, and copies share a fingerprint. Working as the
  spec says ("nothing changes and the entry says why"); the override is taken
  back out.
- **An automatic balance correction's Undo sets `noAutoCorrect`; your own
  Add adjustment's does not** (you added it; auto-correction may be off).
- **A redone category rule comes back at priority 50**, as `/categorize`
  creates it, even if it had been edited in Wealthfolio since.
- **The Rules card writes `mapping_rules` from its own snapshot** (pre-existing
  whole-list write). Undoing a transaction rule while that card is open and
  then saving the card puts the rule back. Same race the card already has with
  the transfer-learning menu.
- **On the add-on, "is it linked?" is the `linked_groups` ledger — plus a
  guess.** The add-on reads no groups back, and its ledger knows only the
  links IT made; the companion never writes it. So for an Undo of an import or
  an Amazon label (the kinds that delete or update one row), the app counts a
  row as linked when the ledger confirms it ("Undo the transfer link first.")
  OR when it is `TRANSFER_IN`/`TRANSFER_OUT` and is not a held in-transit
  placeholder, an opening balance or adjustment, or flagged
  `flow.is_external: true` — that "maybe" case refuses with "This may be half
  of a linked transfer — undo the link first, or undo it from Telegram:
  /changes" (`UNDO_MAYBE_LINKED`). Deleting one half deletes both, and an
  update to one half is copied onto the other. The cost: the import or label
  of an UNLINKED rule-typed transfer (a `TRANSFER_OUT` your rule made that
  never paired) can't be undone from the app; Telegram, which reads groups
  off the rows, can. The sync side is the same story: a ledger that lost a
  pair lets a `notTransfer` leg be retyped by an ordinary update, which
  Wealthfolio copies onto its partner (not seen).
- **A refused placeholder promotion can be linked with its placeholder note**
  (sync-core): when the update promoting a held placeholder is refused in the
  same run its partner arrives, `linkRowByKey` keeps the pre-update snapshot
  and `linkPair` re-creates the leg with the `↔️ In-transit transfer` note. The
  undo check no longer trusts that note on a row a link wrote
  (`is_external: false` → still "maybe linked"), but the sync's own
  note-based placeholder checks (`isPlaceholder` in the unlink pre-pass) can
  still misread it. Fix in sync-core: don't link a pair whose promotion update
  was not echoed back. Rare (needs a refused update mid-run); not seen.
- **Telegram lists no overrides** — only the app card does (spec B3).
- **An import's Undo has no "changed since" check** (ruled, not a gap): a
  later bank update to that row is its own entry, and removing the row as it
  is now and skip-listing its transaction is what the person asked for.
- **A Telegram Undo runs outside the sync lock** (ruled): it writes its
  override first, so a sync running at that moment may act on the old
  decision once; the next sync obeys the override and corrects it.
- **The app's version gate fails closed.** When `companion_version` can't be
  read, a sync decision's Undo is refused ("Couldn't check the companion's
  version — nothing was changed. Try again."); a Redo, and an undo the gate
  doesn't cover, go ahead. No published version at all still means no
  companion, and the gate is open.
- **Amazon filing while any filing is undone.** A row whose tx key can't be
  built (the account mapping read failed) is skipped whenever any
  `noAutoFile` override exists, so such a run files no keyless charge; the
  next run with a readable mapping files them.
- **Section 8's R2 notes are settled:** the DELETE rule client exists
  (`deleteCategorizationRule`), a rule without an id is found by name, an
  Amazon filing without a tx key has it re-derived from the row's note and the
  account mapping (refused when that fails).

### Transfer unlinks (Task 3)

- **A single `notTransfer` override on a linked pair.** The undo planner always
  sets `notTransfer` on both legs of a link, but "Your overrides" → Remove can
  leave one. The sync unlinks the pair from either leg, after which the leg
  without an override is an ordinary row again and can be re-typed or re-held as
  a transfer candidate on later syncs (held, then relinked or expired after 10
  days). Pinned today by `shared/sync-core-not-transfer.test.ts` (one-override
  case); Remove should probably clear both legs of a pair together.
- **A linked leg already stored as ordinary money** (a half-typed pair) cannot
  be unlinked create-first: re-creating it is refused as an exact copy, so the
  pair stays linked and the sync reports it each run.
- **The add-on leaves any non-held `notTransfer` transfer leg it cannot confirm
  in its own ledger for the companion** (it cannot tell a companion link from an
  unlinked rule-typed leg), reporting a note each sync.
- **A stale unlink waits rather than guess.** The old linked pair of an unlink
  whose delete failed is deleted only once BOTH legs have an ordinary row of
  their own in the same run (`planUnlinkPrepass`); until then the sync reports
  "Transfer-unlink cleanup waiting (…)" each run, the old pair stays next to the
  new rows (a visible double count) and drift is not measured for those
  accounts. A leg left as an in-transit placeholder waits for it to expire; one
  whose transaction leaves the feed first never gets an ordinary row, so that
  pair waits until it is fixed by hand.
- **A failed account read holds every `notTransfer` unlink for that run** — no
  unlink, cleanup, duplicate prune, relink sweep or drift measurement anywhere —
  with one note (it fires whenever that read was uncertain, held pair or not).
  On the companion — and on the add-on when the overridden leg's ledger entry
  is a legacy bare-txId key, which the override's account-scoped key can't
  match — a held pair's leg in an account read BEFORE the unreadable one is not
  taken out of that account's plan that run (it cannot be matched to the pair
  without the unread rows); nothing deletes it, at worst its ordinary row is
  re-held as a placeholder and the cleanup waits for it.

## 10. "Why is this here?" (2026-10-13, plan `2026-10-13-why-is-this-here.md`)

- **The app tells less than Telegram, on purpose.** The add-on SDK has no
  categories and no link groups. The app names a filer only when the cube's
  drill-down (this month's categorized spending) or the needs-a-category list
  knows it; otherwise it says "Ask /why in Telegram to see who filed it." (a
  companion has published a version) or "Category set in Wealthfolio." (none
  has). The other half of a transfer comes from the change log's link entry
  (90 days) or the add-on's own `linked_groups`; an older companion-linked
  transfer gets no "what it is" line in the app.
- **Rule inference names the rule that would file the row TODAY** — the
  highest-priority current rule for its category whose pattern matches
  (Wealthfolio's own order). A rule edited since the filing can be named in
  its place, or none ("none of your current rules matches it"). A `regex`
  rule is matched with JavaScript's `RegExp`, which differs from Rust's
  `regex` at the edges.
- **"By hand" is an inference too.** A manual filing with no Telegram or Amazon
  entry in the last 90 days, and no Amazon label in its note, reads "set by
  hand" — not "in Wealthfolio": a Telegram filing older than the log, or from
  before v1.60, looks the same. With the log unreadable — or read only in
  part, a bucket unreadable or a gap recorded — it says only "Filed under
  X.", and a story read from part of the log keeps what it read, adds "Part
  of the change log can't be read, so this list may be missing changes." and
  never says "No changes in the last 90 days." A starting balance with no
  filing in the log (the companion filed card opening balances over REST
  before v1.60) is the add-on's when it sits under "Opening balances", and
  "Filed under X." anywhere else.
- **Drill-down stories name the rolled-up (parent) category.** A budget
  drill-down row carries the category it is rolled up under, not the leaf a
  rule filed it into: "Filed under Food by a rule — 'KROGER' matches it." for
  a row in Food › Groceries. The rule still filed the row under that parent;
  naming the leaf would add its name to every drill row, with the worst-case
  cube already near 80% of its byte cap. Telegram's `/why` reads the leaf from the database.
- **A button whose row a transfer link re-created still opens it.** A story
  by an id that no longer exists follows the change log forward once
  (`currentActivityId`: a link's old leg to its new one, by position; an Undo
  or Redo that put the row back), and an import notice's list opens each
  import's current row. An undone link is not followed — its legs come back
  on the next sync under ids no entry ties back — so such a button still says
  "That transaction has changed since".
- **`/why` queries are cut to 17 bytes**, so a story's Back button (the query
  rides in it) fits Telegram's 64: words drop from the end, never the amount,
  and a dropped word only widens the match. A story reached back from a
  `/changes` entry has no Back of its own.
- **Which number is the amount.** In a query, the first number written with
  `$` is the amount; else the first with cents; else the LAST number (so
  "kroger 415 54" searches $54, with 415 as a word). Buttons write the amount
  first as `$<amount>`, so paging and Back repeat the same search.
- **Only the companion's messages carry 🔎 Why?.** The add-on's sync sends its
  large-transaction alert and import notice text-only, as its notice always
  was — no listener is guaranteed to answer. An alert the add-on queues keeps
  its activity id, so the companion's retry carries the button.
- **An import notice's 🔎 Why? reads the run's import entries from the log.**
  If that run's entries were never saved (a gap record), the button answers
  "That sync is past the change log's 90 days — search with /why."
- **Search limits.** Telegram searches all history in the database, or the
  last 12 months over REST when the database cannot be read (it says so). The
  app asks Wealthfolio for a word no account name contains across all history
  (up to 10 pages of 500) and otherwise reads the last 12 months (up to 20
  pages). Both stop at 40 matches: "Too many matches — add a word or an
  amount."
- **`/why` is under /help's More commands**, not the seven-command ☰ menu
  (Telegram's registered list), which stays at seven.

## 11. Audits without SSH — R1 Explain (2026-10-13, plan `2026-10-13-audits-r1-explain.md`)

- **"$X left" compares SPENT figures.** `audit-headline.mjs` compares no two
  numbers: it sizes six differences in what each side counts and leaves a
  person to match them by eye. Both sides' "left" is plan − spent, so the
  check compares the report's "Spent this month" (the cube's current month)
  with Wealthfolio's Spending page `headline.spent` (`POST /spending/insight`
  for the calendar month in Wealthfolio's timezone). The copy says so; R2 or
  later could add the budgets' side if a gap ever comes from plans.
- **The other half of a transfer is matched one leg at a time.** A balance's
  "held" or "still unlinked" cause needs ONE unlinked leg elsewhere whose
  amount equals what is left of exactly one account's gap, as the daily
  missing-leg check matches. Two legs into one account, or two accounts off
  by the same amount, stay in "not explained".
- **Split lines are not modelled.** Wealthfolio allocates a split row by its
  lines; the add-on never writes splits, so a split row's difference stays in
  "not explained by these reasons".
- **Health is the add-on's three checks, not Wealthfolio's whole page.**
  Wealthfolio 3.10 also flags rejected, oversold and amountless activities and
  a stale projection; the empty state says "Nothing the add-on checks for".
- **The app's checks are as fresh as the last sync.** Telegram's `/audit`
  re-reads on every tap; the app shows the snapshot with when it was taken,
  "These checks are from … — the companion hasn't synced since." after two
  days, and lists at most what fits 100 KB (each list says how many it left
  out).
- **Health follows Wealthfolio 3.10's pair rules on every host.** A same-account
  currency conversion and a security moved with the same asset and quantity are
  valid pairs in 3.10; the check never flags them, even on 3.8 (a missed flag is
  safer than a false "won't accept").
- **Wealthfolio's Spending figure is only compared when its Spending page is on**
  with accounts selected (`spending.enabled` and `spending.account_ids`, the same
  gate Wealthfolio uses); otherwise the check says the page is turned off. A
  page whose every selected account is archived or non-spending still returns
  $0 and is compared — rare.
- **A2's scope: a reason is a row exactly one side counts** (final review,
  ruling C-G). The report's side is the cube's own rules (mapped accounts;
  the sync's corrections and in-transit placeholders dropped by marker —
  starting balances are NOT; filings not rolled up to a transfer-named
  category; an uncategorized charge only when ungrouped and in a Spending
  account). Wealthfolio's is its Spending page's: the accounts in
  `spending.account_ids` that exist and are not archived, never a linked
  transfer (a grouped TRANSFER_IN/OUT is an internal transfer or a saving),
  excluded categories and their descendants, and the WHOLE calendar month in
  its timezone — so there is no "after today" reason, and "first midnight" is
  named only west of UTC. What only one side counts for a rule no reason names
  stays in "not explained": a spending account the add-on does not map; a
  categorized row in a mapped account the Spending page does not read (the
  report counts it); a linked transfer filed under a spending category; an
  unlinked transfer filed under your own transfer-named category (the report
  drops the filing, Wealthfolio counts the transfer); a grouped row that is
  not a transfer (the uncategorized reader skips it, Wealthfolio counts it); a
  row Wealthfolio puts in another month other than at 00:00 UTC on this
  month's 1st (an east-of-UTC local midnight at the month's end, 3.10, and,
  west of UTC, a row stored at 00:00 UTC on the NEXT month's 1st, which
  Wealthfolio counts this month); an activity type override; the
  uncategorized reader's dismissed rows and rows awaiting a transfer's other
  half; and split lines. (R2 added the four this list missed: ruling C-H.)
  A card's opening debt is counted by the report (the
  cube excludes no starting balance), so on 3.9+, filed under the excluded
  "Opening balances", it shows as "excluded" — whether the report should
  drop starting balances like the digest does is its own question.
- **A mapped ARCHIVED account reads "not compared".** `GET /accounts` omits
  archived accounts, so its type is unknown and its balance is not compared.
  Follow-up: read the list with `includeArchived=true` (the route takes it on
  3.8 and 3.10).
- **A pending row is never offered as the other half** of a Health leg: the
  sync never pairs a ` · pending` row (the bank's provisional copy, whose
  amount can still change before it posts).
- **R2 (Fix)** — Link and Remove for good — is §12.

## 12. Audits without SSH — R2 Fix (2026-10-14, plan `2026-10-14-audits-r2-fix.md`)

What R2 deliberately leaves open:

- **The linker deletes first.** Link goes through the sync's own
  `linkPairByRecreate`: delete both rows, then re-create them as one marked
  group. When the re-create is refused or the request throws, R2 reads both
  rows again by id, writes back any that are gone, and names what may have
  been lost; but a connection lost between the two requests can still leave
  rows deleted until the next sync re-imports what the bank still sends, and
  a lost response after a committed create leaves the linked pair plus the
  written-back originals (on 3.8, or with a fee that gets past 3.10's
  duplicate check) — the message then says to check both accounts. SDK
  3.9's `activities.linkTransfer` links in place and would close the window,
  but it needs new add-on permissions: Nick's call.
- **Money leaving a card is never linked**, whatever type the card stores it
  as — a TRANSFER_OUT on 3.10 included: the sync never links money leaving a
  card, 3.8 and 3.9 accept no TRANSFER_OUT on one (v1.55), and a WITHDRAWAL
  is never half of a valid pair.
- **The app links from a snapshot.** It re-reads both rows by id first. A
  transfer leg a link has marked since (`flow.is_external: false`), or one
  whose metadata the host did not report, may be linked and is refused; a pair
  the card linked hides its button until the next snapshot.
- **Remove for good refuses a pending row**: SimpleFin often gives a pending
  transaction a new id when it posts, so skipping the pending id would not
  keep the posted copy out. It also refuses, and never offers, a $0 row
  (Undo could not put it back).
- **The app never removes a transfer-typed row**: the SDK cannot be counted
  on to report groups. `/why`, which reads them, can remove an unlinked one.
- **Remove's Undo writes the row back as the bank feed wrote it.** A category
  filed on it is not part of the row and does not come back. A $0 surplus
  copy the sync pruned cannot be put back.
- **The exact-id read is Wealthfolio 3.8's** (`activityIds` / `activityIdFilter`);
  an older host ignores it, and a fix then reads the row as changed and
  writes nothing.
- **One lock per host, none across them.** The add-on's write lock covers its
  syncs, Link, Remove and the Change log's Undo/Redo; the companion makes its
  own sync and Telegram's Link, Remove and a removal's Undo/Redo take turns.
  Neither covers the other host: the companion's sync and Telegram's
  Link/Remove are not behind the add-on's lock, and the add-on's sync and the
  app's Link/Remove are not behind the companion's. So a fix on one host
  racing a sync on the other can re-import a removed row once, or leave a
  duplicate. On the companion, only a removal's `/changes` Undo/Redo waits for
  its sync; other kinds that write rows or the skip list (an `import` Undo
  skips then deletes, since 2a) are not guarded there, while the add-on locks
  every Undo. The
  add-on's `linked_groups` is also still a copy a companion write can
  outdate, and the add-on's sync then treats a pair the companion linked as
  one it did not link.
- **Link all covers what the list shows**: what fits one Telegram message
  (clipped, a pair's button only if its line is on screen), what fits the
  snapshot in the app.
- **A link you make is undone like the sync's** (`notTransfer` on both legs,
  carried out by the next sync), so the app's "Update the companion first"
  gate now covers a transfer link whoever made it.
- **Version skew**: an older snapshot from a companion without R1+R2's
  Health rule can still offer a pair with a grouped row; they ship together.
- **Ruling C-H's residuals are done**: an unknown reason or Health issue kind
  is dropped, not read as a corrupt snapshot; `more` must be a number; §11's
  remainder list names the four cases it missed.

Minor, deferred (not fixed in R2):

- Task 1: a dropped reason's cents vanish when `unexplainedCents` is null;
  unknown kinds still need cents/rows/more; coverage gaps (more absent, all
  reasons dropped, null passthrough, cents 0).
- Task 3: the write-back reuses step `transfer-relink` (naming only).
- Task 4: a Redo of a removal skips only the keys the removal added; it
  should skip every key (idempotent) and record what it added for the next
  Undo, so a hand edit to the skip list between Undo and Redo is honoured.
- Task 6: `report.notes` is counted but not clipped in Health's 4096 fit.
- Task 8: a grouped row that contests an ungrouped leg's match still makes
  that leg "many" (dropped from offers only after contest counting).

## 13. Less filing — R1 (2026-10-14, plan `2026-10-14-less-filing.md`)

- **Venmo's email formats are unverified.** `shared/venmo.ts` reads the
  wording Venmo documents ("You paid <name> $X", "<name> paid you $X", a
  completed charge request, a transfer to your bank); no real email has been
  seen. Needed from Nick: one real email of each kind (redacted is fine) to
  replace the built fixtures in `shared/venmo.test.ts`. Until then a Venmo
  email that does not read stays unread, is counted in the log
  (`Venmo mail: … unrecognised`) and kept in the `venmo_mail_samples` secret.
- **The Venmo samples are not shown anywhere yet.** Amazon's are on its card
  with Copy; Venmo's sit in `venmo_mail_samples`. Show them on the same card
  once the formats are known to drift.
- **A cash-out of exactly one payment gets no note.** "Sam paid you $40" and
  "Transfer to your bank $40" in the same week are two records of the same
  amount and direction, so the $40 bank deposit gets neither (the two-record
  rule). Preferring the payment's note there is a later refinement.
- **One payment, one row, per sync run (ruling P3-K).** `matchVenmoPayments`
  matches every VENMO row of the run together: a row keeps a payment it
  already consumed; otherwise it gets a note only when it could be exactly one
  payment from the start (identical twins are one) and no other row of the
  run — a pending row counts, as a blocker — could be that payment too
  (ruling P3-L: a row that could be two payments stays note-free even when
  another row contests one of them). The window is a bank row dated
  from the day before its email to five days after (calendar days). Costs: a
  bank row dated two or more days before its email gets no note; a payment
  whose email never came (mail before the filter, an unreadable email) still
  blocks a same-amount row in the window; a stale pending row the feed keeps
  reporting blocks the payment until it goes. Transfer-typed and
  `noVenmoNote` rows compete and consume like any posted row; they only get
  no note.
- **Undo takes a Venmo note off at once**, as an Amazon label's Undo does,
  rather than leaving it for the next sync; the sync then never adds it again.
- **Mixed versions and `noVenmoNote` — gated (was a release blocker).**
  `parseSyncOverrides` now ignores and preserves flags it does not know (still
  strict on known keys' types), so later flags never break this release. A
  released 1.60.0 half is still strict: an add-on OR a companion of 1.60.0
  reads a `sync_overrides` document holding `noVenmoNote` as corrupt, and its
  sync then ignores EVERY override — `keepDuplicate` (the duplicate prune can
  delete a copy the person chose to keep), `notTransfer` (re-pairs and
  re-links), `noAmazonLabel` — and refuses its own Undo and override edits,
  until the flag is gone (Redo, or 365 days). Only an Undo of a Venmo note
  writes it. So `VENMO_NOTE_SINCE = '1.61.0'` (shared/version.ts) gates both
  sides: the app's Undo of a `venmo-note` needs the companion at that version
  or newer ("Update the companion first" — `SYNC_OVERRIDES_SINCE` 1.60.0 alone
  would have let a 1.60.0 companion through, reachable after a downgrade, since
  only the new companion writes `venmo_ledger`); Telegram's Undo AND Redo of
  one need `installed_addon_version` at that version or newer, and are refused
  ("Update the add-on first — or undo it from the app's Change log.") while
  it is older or unknown (the companion cannot see the addons directory). `shared/change-undo.test.ts` fails a release
  that ships BELOW the constant, but cannot catch one shipped above it.
- **Released in 1.61.0**, so VENMO_NOTE_SINCE (1.61.0) is right as it stands.
- **Forged From line (accepted risk).** The companion reads Venmo mail by its
  From line, which anyone who knows the forwarding address can forge (the same
  as Amazon's). The worst case is a "Venmo note" on a bank row whose amount and
  date also match. Keep the forwarding address private (README, Venmo notes).
- **Guesses.** A Venmo row is guessed by its note only (none without one); bank
  text made only of generic banking words gets none; the window is a rolling
  365 days; a money-in row that takes an income category gets none (a guess is
  a spending category, which Wealthfolio refuses there). Guesses come only from
  filings with `source` `manual` or `rule`, never `migrated`. Filing a guess
  from the app waits for R2 (SDK 3.9 `spending`).
- **The guess window counts when a filing was made (P3-J, done).** Wealthfolio
  keeps one assignment per activity and taxonomy and re-files in place
  (INSERT … ON CONFLICT DO UPDATE keeps `created_at`, moves `updated_at`), so
  a `manual` filing counts from `updated_at` and a `rule` filing from
  `created_at` (a rules re-run bumps `updated_at`). The `NOT EXISTS` in
  `sqlite-guess.ts` only guards a future schema with several rows per
  activity. A failed read logs "Guessed categories skipped: <error>".
- **Minor, deferred (not covered by the final fix wave):**
  - Venmo parser: an imperative marketing line ("Transfer $50.00 to your bank
    today!") under a neutral subject reads as a transfer; the sample redactor
    keeps `••••1234`, does not cap the subject, and redacts a hand-forwarded
    "From: Venmo <…>" line to `<email>`.
  - Matcher: no test of a timestamped `emailDate` rolling to the next UTC day;
    `VENMO_X` is untested.
  - Sync: pin the placeholder half of the no-note gate (an inflow
    placeholder) and the three ledger write-merge guards (taken meanwhile,
    missing record, re-read readability); an add-on and a companion sync at
    the same moment can leave a note while the ledger records the other
    writer (narrow). ("Decided after pairing" is now pinned.)
  - A corrupt `venmo_ledger` can only be cleared by a full Reset: the sync
    says "Couldn't read the Venmo payments list" on every run and nothing
    repairs it. Add a repair command, or a Reset of that one secret.
  - Venmo-note Redo says "the next sync adds the note again", which never
    happens for a row outside the feed window or once its payment is pruned
    (90 days). Amazon's Redo has the same gap.
  - Mail: the Amazon and Venmo views are not disjoint (a venmo.com email whose
    body has a `From: …amazon.com` line also reaches Amazon's parser; give each
    message one owner, sender first); the poll's wiring and its Venmo log lines
    are untested; the adapter builds the body inline instead of `mailBody`;
    `MailSource.fetch`'s doc comment is stale, and the accepted forged-From
    risk comment in `amazon-mail.ts` still names Amazon only.
  - Overrides: an unknown flag's value is kept whatever its size (low risk).
  - Guesses ignore a rule's scope: filings by a rule for account A make
    "Probably X" for the same merchant in account B, which the person
    deliberately left out of that rule.
  - "Make this a rule" on a noted Venmo row offers
    `VENMO PAYMENT 1023 · Venmo: Rent` — tied to the bank's reference number
    (before this branch it offered `VENMO PAYMENT`). Build the pattern from
    the note, the same key the guess uses.
  - `/categorize`: assign does not re-check a category deleted between render
    and tap (the write fails on the foreign key); the guess gate's lookup also
    matches income categories; the list suffix is not tree-gated; a row
    switched to the spending grid is not pinned to have no guess; the pinned
    "longest callback is 15" is fixture-bound; a one-tap guess filing costs
    about three reads (fine at this scale; memoise per callback if needed).
  - App: the hint becomes part of the story button's accessible name.
  - Scoped rules: Redo does not re-check the account still exists; the
    `rules.list()`/filed-by fallbacks ignore scope; a runner-level scoped Redo
    is untested; the toggle label uses the database's account name; two
    accounts with the same name cannot be told apart (`/newrule … in
    checking` answers "Which account? Checking, Checking" with no way to pick
    one); an OLD companion's Redo of a scoped rule (after a downgrade)
    re-creates it for every account. (`/newrule` now reads the whole category
    side first, so "Dine In Out" works, and the toggle is pinned both ways.)
- **Scoped rules, what stays global:** the bare `/newrule` questions have no
  account step; the add-on's `mapping_rules` have no scope (L5); a scoped
  rule's Wealthfolio name does not mention its account; "Undo rule + un-file N"
  counts by pattern and category, not account.

## 14. Getting started (2026-10-14, plan `2026-10-14-getting-started.md`)

Designed overnight under Nick's standing instruction; approved by Nick on
2026-10-14 and released in 1.61.0.

- **Suggested budgets' spend read differs from Wealthfolio's own budget actuals** (`getNativeBudgetSpend`, companion/src/sqlite-native.ts). It matches them on the spending accounts and the excluded categories (an excluded subcategory's own rows dropped before the roll-up) only. Three known differences: a LINKED `TRANSFER_OUT` filed under a category counts here (upstream treats a linked transfer as neutral); `activity_type_override` is ignored (the raw `activity_type` classifies); `spending_activity_splits` are ignored (an activity counts whole, under its one assignment). Cost: a suggestion can be off by those rows; it is only a suggestion.
- **Budgets are set from Telegram only.** The add-on SDK has no budget API;
  applying from the app needs one (or an upstream PR). Only `'default'`
  targets are suggested, never month-specific ones. A `'default'` target of
  exactly `$0` counts as NO budget (Wealthfolio's cleared state: its editor
  saves a cleared amount as "0" and its UI cannot delete a default, so a
  cleared budget is a `$0` target); suggestions may fill it, apply's re-read
  and Redo go over it. A NaN amount, a this-month `$0` target and any
  non-zero default still block.
- **Re-read before write narrows the race; it cannot close it.** Wealthfolio's
  `POST /spending/budget/targets` overwrites an existing target (an upsert on
  period, taxonomy, category) with no create-only form, so a budget added
  between the re-read and the POST would be overwritten with the suggested
  amount, and Undo would then delete it; the earlier amount cannot be
  recovered. A write that lands after the POST is kept (Undo refuses, because
  the amount differs). One re-read covers each POST, not a batch.
- **The window is placed in Wealthfolio's timezone; rows are bucketed by their
  stored date,** as the cube and the digest read them. Wealthfolio's own actuals
  place a row by its local date, so a row stored at an east-of-UTC local
  midnight at a month's end (3.10) can count in the neighboring month.
- **At most 24 suggestions** (one button each, a 24-bit mask); past that, the
  smallest are left out (the cap applies before the has-budget filter).
- **The preview covers the Budget board only.** Home's other cards and the
  Reports tab keep their empty states; drill-down rows open no story.
- **The compose snippet does not fill in the add-on's id**: the companion
  reads no variable for it (`simplefin-sync` is fixed in the code). The
  password file must be readable by the container's `node` user (a 0600 file
  owned by another uid is not). `docker-compose.example.yml` is exactly the
  snippet and lost its `user:` line and external network.
- **Deferred minors.**
  - Compose: `WEB_URL` accepts a trailing `:` (YAML then reads a map).
  - Setup preview toggle: no `aria-controls`; the "doesn't disturb step 1" test
    never types a token; an empty-months cube would say "No budgets yet"; no
    test that the pointer is absent in the sample preview.
  - Sample: `headlineStatValues` on day 1-2 extrapolates rent ("Projected
    $43,400"); `asOf` is read in UTC on the last local evening; card interest
    is kept as one month's fee.
  - `/budgets`: a POST that throws after committing leaves an unlogged budget
    (the after-loop recovery covers it only when the re-read shows the sent
    amount); a tracker switched off between reads reads as "Couldn't read
    your budgets"; errors are clipped to 120 characters per category but
    category names are not, so the result message can still pass 4096
    characters with very many categories.
  - The "No budgets yet — /budgets" pointer on the budget card is not gated
    on the companion's version (an older companion has no `/budgets`).
  - `/budgets`' history start is the earliest activity across ALL spending
    accounts, so months a later-linked bank never covered still count, which
    understates its categories.
  - An Undo of a budget set whose DELETE throws after Wealthfolio committed
    leaves the budget gone and the entry live; Redo is then never offered.
  - The password file: `chmod 644` makes it readable by every user on the
    host; `chown 1000` (the image's uid) and keeping 600 is tighter.
  - Dead menu paths: the `cz:bg:m` view is never offered; "Pick at least one
    first." is unreachable; Apply all ignores the toggles by design.
  - Undo of a budget set: "nothing undone" wording on an unreachable Redo is
    pre-existing.

## 15. Planning — R1 (2026-10-14, plan `2026-10-14-planning.md`)

- **`getNativeMerchantRows` still uses the `'|'` CLI separator** (the sqlite3
  newline fix in `tryQueryNativeDb` shipped with 2c R2), so a note containing `'|'` (or a newline) drops a row on the
  sqlite3 fallback, even under the strict flag. Fix: use `DRILL_CLI_SEPARATOR`
  (`\x1f`) with a join, and test with a `'|'` note.
- **Savings goals are R2 (N6).** Wealthfolio already has save-up Goals,
  funded by account shares; R2 shows their progress read-only in the reports
  through the companion's REST instead of building spending-side goals that
  duplicate them.
- **Income detection.** The forecast assumes no income (N1): nothing detects
  paychecks (recurring deposits). Until something does, a regular earner sees
  a pessimistic line, and the wording says "if nothing comes in".
- **Card balances.** Cards are left out of the forecast (N2): card spending
  reaches cash through the card payment, which the daily spending stands in
  for. A card's statement balance and due date would replace that average
  with the real payment.
- **Charts in the archive.** The Reports tab keeps each edition's text; the
  companion's chart images (`/charts`) are not kept with it.
- **A bill charged to a card is subtracted from cash.** Neither the roster nor
  the cube knows which account a subscription charges, so a card-charged one
  is subtracted on its date; its past charges leave the daily figure, so it
  is not counted twice; it only lands earlier than the card payment would.
- **No weekly cadence.** The roster knows monthly and yearly (the detector is
  monthly-only); the forecast repeats whatever cadence an entry has, so a
  weekly one needs only the roster to learn it.
- **"New" subscriptions in the review** are any whose first charge is this
  month or last and which was charged in the month; a subscription reaches
  the roster only at its second charge (an unknown brand at its third, so it
  is never called new). Two charges in one month can make it new two months
  running.
- **"No longer charging" is rare in R1.** The detector drops a subscription 45
  days after its last charge (`ACTIVE_WITHIN_DAYS`, `shared/subscriptions.ts`)
  and the roster calls an entry overdue only after its predicted date + 7
  days. So on the review date the line names only subscriptions found missing
  their charge near the month's end (for a September review on Oct 1, last
  charges about Aug 18 to Aug 23, a week-wide band); ones that stopped earlier
  have already left the subscription list. Pinned through the real
  `detectSubscriptions` + `buildRoster` in `shared/month-review.test.ts`. The
  real fix, for R2: the cube keeps recently silent subscriptions (for example
  a `stoppedSince` date for the 45 to 75 days after their last charge), and
  the review names those that stopped inside the month.
- **The "possible" exception.** A user-confirmed "possible" (two charges, an
  unknown merchant) reaches the roster at its second charge, so it can be
  called new at that charge: its whole history is known and one charge was in
  the month. The unconfirmed ones stay out until a third charge.
- **A past short date silences the daily warning (plan-mandated).** The
  warning shows for a short date from today to today + 14 and never for a day
  already past, so a forecast whose short date has passed (cash already
  negative) says nothing in the daily report until the next sync recomputes.
- **A frozen balance counts silently on the headline.** A bank balance that
  stops updating (an old date) is counted and dated on the forecast's own
  panel, but nothing on the Home tile or the weekly line says it is old. An
  undated balance counts and is shown "· balance date unknown".
- **The forecast's unbounded calls precede the health write.**
  `GET /accounts` has no timeout, and the forecast publishes before
  `updateSyncHealth` and the live report editions; a hung call (here or in the
  audit snapshot's reads) holds both. Bound the calls.
- **The open sub-tab's list doesn't refresh.** The Reports tab's badge and
  counts follow the live state, but the editions listed under a sub-tab that is
  already open are read once; a new edition shows after reopening the tab.
- **The forced-2027 run isn't scripted.** Every new test file is checked with
  the date forced to 2027-01-01 by a throwaway setup file during the final
  task; it should be a repeatable script (an `npm run test:2027`).
- **Live editions lagged the forecast (fixed).** The Reports tab's live
  editions used to publish before the cube and the forecast, so the daily
  warning and the weekly line were one sync behind Home's tile. They now
  publish after both.
- **A card payment that never linked** can be detected as a bill. The
  forecast leaves out an entry whose name reads like one (the sync's own
  `CASH_CARD_PAYMENT_KEYWORDS`); one worded otherwise ("ACH DEBIT ROBINHOOD
  CCB") is still subtracted. A hand-added unlinked entry is a mild
  pessimistic double count.
- **`CASH_FORECAST_SINCE` is 1.61.0**, the release this shipped in.
- **Minor, deferred (from the task reviews):**
  - Forecast arithmetic: `days < 0` gives an empty series; the doc says only
    LATE entries are subtracted today though any past date is (unreachable,
    the roster rolls dates forward, so reword); fractional bill cents are
    unrounded; an extra `Number.isFinite` guard in `forecastCash` itself.
  - `cash_forecast` parsing: pin an unknown or
    pre-release companion version ("1.61.0-beta"); a failed (`ok: false`)
    forecast never goes stale, so show its age too.
  - Inputs: (a balance date of 0 or absent is now an unknown date, counted,
    never missing); cents should be
    `Number.isSafeInteger` and normalise -0; the `cashToday` sum-overflow
    guard is untested; the bill keys include entries with cents <= 0 (filter
    cents > 0); `dailySpendCents` adds days for months missing from the cube;
    `asOf` and the balance-age comparison use UTC (cosmetic).
  - Companion: log one line when `publishCashForecast` returns false
    (unreachable, the previous forecast is kept); a persistent 500 on one
    secret never yields an `ok: false` reason (brief-mandated); the timezone
    fallback is silent.
  - App: pin the page-level throwing read, `FORECAST_NO_BILLS` and the panel's stale status and
    class; `SyncPage`'s `.catch` hides the tile instead of "Couldn't read"
    (unreachable today); a div inside a button follows the tile precedent.
  - Inbox: the unmount test cannot fail under React 19 (setState after
    unmount is silent), so it pins "no further reads or writes after unmount".

## 16. Line up with Wealthfolio (2026-10-14, plan `2026-10-14-line-up.md`)

- **One definition of spending** (`shared/wf-spending.ts`), Wealthfolio's,
  read by every report figure and by the audit's two sides. What it does not
  model:
  - **Currency conversion.** Wealthfolio converts a foreign-currency row to
    the base currency at the period's end; the report sums it as stored. The
    audit names such rows as their own reason, capped at the foreign rows'
    own absolute total, so a rate above 2 leaves an honest unexplained
    excess. Converting them is open.
  - Split lines that don't add up to the row (Wealthfolio's editor keeps
    them adding up).
- **The "identical on 3.8, 3.9 and 3.10" claim was wrong** and the header of
  `wf-spending.ts` now says so. The definition is 3.10's: 3.8 and 3.9 treat a
  blank type override as a type (the row then counts as nothing there), and
  exclusions exist only from 3.9.
- **The CLI fallback prints control characters in caret form** (display
  only; the stored text is unchanged).
- **About 11 `readSpendLines` per sync.** Each reader makes its own read;
  they could share one 24-month read. In the CLI fallback every read is
  logged, so the log volume grows with them.
- **The cube's accounts are still the mapped ones.** A spending account the
  add-on doesn't map is counted by Wealthfolio and not by the cube: the
  audit names it ("On accounts the add-on doesn't sync") and the tripwire
  sets that amount aside, so it is not a warning (the covered difference is
  compared). The digest's own figures cover every spending account.
- **Dismissed charges, and charges whose transfer's other half is on its
  way, now count** in every figure (1.23.0 left dismissed ones out):
  Wealthfolio counts both, and a report that didn't would trip the wire
  every day. Both stay off the needs-a-category list.
- **On 3.8 the bookkeeping pass does nothing** (no excluded categories), so
  in-transit placeholders and corrections that are spending to Wealthfolio
  count on both sides there. An income-bucket placeholder (money in) can't
  take a spending category: Wealthfolio's Income page still counts it. The
  pass files nothing it can't read live, and has no Undo.
- **Dates.** Noon UTC (`bankDayInstant`) is the bank's day in UTC-12 to
  UTC+11. UTC+12 to +14 land a day late, a regression from 1.61, and the
  repair leaves their already-correct rows alone (it moves a row only when
  noon UTC on its day is that day in Wealthfolio's timezone). Writing those
  zones' new rows correctly is open. A write replayed from what the change
  log recorded: Undo of a removed duplicate or a removed row replays a
  recorded payload, which has been noon since 1.62; re-importing a starting
  balance or a correction, and moving a starting balance back, replay a
  recorded day, and wrap a bare one in `bankDayInstant`, so they write noon
  too (a recorded timestamp is put back as it was).
  `companion/tools/audit-headline.mjs` still matches only T00:00:00 rows.
- **The date repair** resumes on the next sync rather than being re-runnable
  from the audit's tools (the spec's wording); delete the `date_repair_done`
  secret to run it again. It leaves rows at 00:00 UTC on purpose or by
  necessity: a linked leg (Wealthfolio copies an updated leg's date onto its
  partner); a row with a type override, or whose stored type differs from the
  search's (a blank override on 3.8/3.9; Wealthfolio's search shows only the
  effective type, and an update writes the type it is sent); rows in accounts
  the add-on doesn't map; rows Wealthfolio refuses twice (an `errors[]` entry
  or a thrown 400/422, the card rewrite's rule too: `companion/src/row-refusal.ts`;
  both list them in their entry's `refused`); rows the database
  read doesn't know yet (newer than the read: never counted as retyped, the
  repair isn't done while any is left); and rows written at midnight after it
  finished (a 1.61 browser tab, a replay). It reads the database LIVE only
  (`openLiveDatabase`), also before its verifying sweep, so it waits
  ("Date repair waits: the database can only be read as a snapshot") while the
  database can't be read live, and it waits for the 1.62 add-on when the
  companion can see it.
- **Tripwire timing.** The cube is built moments before Wealthfolio is asked
  for its figure; a write in between shows as a difference until the next
  sync. The cube's months follow the UTC month of the sync; the digest and
  the audit, the companion's local month (unchanged).
- **Left as they were:** `countRulePatternMatches` (a rule preview's count)
  keeps its SQL sign; `companion/tools/audit-month.mjs` and
  `audit-headline.mjs` keep their own copies; the ledger audit's idle-refund
  check still reads the stored type.
- **With the platform work (U4, merged in 1.62.0):** on 3.10 a card's
  bookkeeping rows become TRANSFER_OUT, which Wealthfolio ignores; the pass
  reads the bucket, so it files none of them, and the two compose. Rows filed on 3.9 keep their
  filing after U4's rewrite (harmless), and U2's link in place leaves the held
  placeholder to re-creation.
- **The Budget tab's "✓ matches the ledger" check** now compares the cube
  with the same spending lines. It checks assembly only; the tripwire is the
  independent check now.
- **The cube's spending series are strict** (a failed read fails the publish
  and the previous cube stays), and the tripwire reads a cube only if its
  `asOf` is from the same sync run; otherwise it says nothing.
- **Budgets** (both readers) keep only `target_type='category'` targets in
  `spending_categories`, in categories not excluded from spending, as
  upstream's budget page does (budget/service.rs:250-251 at v3.10.0). A
  sub-category target under an excluded top-level category is still summed
  into its top.
- **Rows past the 200-id cap read "set by hand".** A `sync-bookkeeping` entry
  lists at most 200 ids (plus the total), and "Why is this here?" recognises a
  bookkeeping filing only by an id the entry lists, so a filed row beyond the
  cap says it was filed by hand. Recognise one by its category and note too,
  or list every id.
- **The on-demand /audit skips the same-run cube check.** Only the audit
  after a sync passes `cubeNotBefore`; `/audit` accepts whatever cube is
  published, so one left stale by a failed publish can show a difference
  there (as in 1.61).
- **Two ports of upstream's classifier.** `shared/cash-flow-bucket.ts`
  (`bucketFor`) and `shared/wf-spending.ts` (`isSpendingBucket`) each port
  Wealthfolio's cash-flow classifier, and they disagree on grouped transfers
  and the effective type (a type override). Make `bucketFor` delegate to one
  port, or keep both in step.

## 17. Paybacks (2026-10-14, plan `2026-10-14-paybacks.md`)

1.62.0 part 2 — W6–W10 of `2026-10-14-line-up-and-paybacks-design.md`.
Lining up (W1–W5) and the platform work (U1–U4) are planned on their own
branches.

- **W11 (paybacks in the app) is next**, its own small plan. It consumes the
  fixed interface this part ships: the `asReimbursement` override, the
  `payback-filed` change kind (`paybackFiledChange`), `PAYBACK_SINCE` /
  `companionUnderstandsPaybacks`, and the pure `planPayback`. Nothing of W11
  is in this part: the app cannot file or undo a payback yet.
- **Telegram's paybacks wait for an installed add-on of 1.62.0.** A companion
  that cannot see the add-ons directory reads it as unknown and refuses, as
  the Venmo note's Undo does; W11 then offers paybacks from the app.
- **A flag under one feed's key only.** The override is keyed by transaction
  id and put on the row's key under every feed of its account; two feeds
  mapped to one account can still disagree about a key a later write adds
  (the same pattern as every per-key override).
- **The override yields** when the bank row turns into money out, or the
  account is known not to be a cash account: the row is typed as usual, and
  keeps the `REIMBURSEMENT` subtype (Expense either way on a cash
  `WITHDRAWAL`) and its category. An account type the sync could not read
  never makes it yield. Like every transaction override it is pruned a year
  after it was set, on the next write of the document — long after the row
  left the sync's window; an expired but unpruned override still applies.
- **A re-type writes back the stored instant exactly** (`activityDate` as
  Wealthfolio reported it), so a payback never moves a row to another day.
  The sync's own fallback re-type uses the bank day, like every sync update.
- **The payback's Undo is in `/changes`.** The Filed screen says so; it has no
  ↩ Undo of its own. The app's Change log says "Undo this from Telegram:
  /changes" (the add-on SDK cannot take a category off).
- **The one-tap guess is not offered on the payback grid**: every tap there
  goes through the payback.
- **The transaction rule's limits are shown read-only** in Settings → Transaction
  rules (money in only, one account by name, and the `since` day), and the
  editor keeps them when the list is edited; the "Test a description" box
  honours them: pick the direction and the account to see a payback rule
  apply. Saving re-reads the list first and refuses with "Your
  rules changed elsewhere — reload them first." when the companion changed it
  meanwhile. A reader before 1.62 ignores the limits — the reason the offer
  waits for an installed add-on of 1.62.0.
- **Deposits already imported are never re-typed by the payback rule**; the
  ones the 90-day preview finds are filed by hand with **It's a payback »**.
  A pending deposit the rule typed is replaced on posting like any pending
  row; an in-transit placeholder the rule matches keeps its type and its
  marker.
- **A payback stays a payback unless a rule or your own choice changes it.**
  The sync leaves a stored cash money-in `CREDIT`/`REIMBURSEMENT` row as
  stored when neither a rule nor an override decides its type, so the reverse
  cases cannot happen: removing the override (the list shows it read-only
  anyway) or undoing the W10 transaction rule leaves the paybacks as they
  are. A payback made by hand in Wealthfolio sticks too. A rule or the
  override that later decides a different type still wins.
- **W10 refuses a pattern a transfer keyword or rule decides**, and when the
  ledger cannot be read. The preview's own count failing is a note, and the
  checks run again when the rules are made. A Wealthfolio rule that is broader
  than the pattern and would win is a conflict too.
- **A stuck payback** — the override saved, Wealthfolio refusing the re-type,
  and the override not taken back — is said so: the next sync makes the row a
  payback with no category, which `/categorize` then offers. If it is filed
  there, the payback's Undo refuses and says to undo that filing from
  `/changes` first.
- **A key that held another override** (a `notTransfer`, say) keeps that entry:
  a payback set over it remembers the entry (`was`), and taking the payback
  off — Undo, a refused filing, a take-back — puts its `at` and `label` back
  exactly, with no `entryId` left from a Redo.

## 18. Platform upgrades (2026-10-14, plan `2026-10-14-platform.md`)

- **SDK 3.9, feature-detected.** `hostCan` (src/utils/host-can.ts) makes a cash
  search no row can match (`spending.searchCashActivities`, 3.9+) once per
  context: inside the sandbox `ctx.api` is a Proxy on which every path is a
  function, so `typeof` proves nothing, and a 3.8 host rejects the call with
  "Unknown addon host API method". `spending.isEnabled`, `getCategories` and
  the rule calls cannot tell the two apart (3.8 already offers them). Never
  call an SDK function through `.call`, `.apply` or `.bind`: on the Proxy that
  is one more path.
- **1.62.0 adds manifest permissions**, so Wealthfolio's Update button refuses
  it; the README and CHANGELOG say to install over the old one. W11 (app
  paybacks) adds its spending rule permissions to the same manifest before
  1.62.0 ships, so one reinstall covers both.
- **FINDING: `readsSourceGroupId` is stale.** `AddonSyncHost.capabilities.
  readsSourceGroupId` (false since db08f48) is wrong: search has returned
  `sourceGroupId` since 3.6.2 or earlier. Flipping it changes sync-core's
  add-on path (linked-leg detection, the ledger migration, change-undo-run.ts
  ~160) and would let the add-on see links on 3.8 too. It is its own small plan
  after 1.62.0, not this branch.
- **Link in place keeps re-creating** a pair whose stored rows are not exactly
  its legs (in place cannot change a type or clear an asset; a held placeholder
  marked external must not keep a bookkeeping filing on a real transfer;
  another note, amount, day, subtype or fee), and any pair Wealthfolio refuses
  except one already half of another transfer, which is refused outright
  (re-creating would delete the other pair's partner). On 3.8 and 3.9 an
  "already linked" refusal whose first read showed both rows in one shared
  group with a marker is reported linked, ids kept. The sync's brand-new pairs
  mostly link in place; a promoted held placeholder still re-creates.
- **A lost link answer** is read again: a row still in an earlier group that
  its partner does not share is left unlinked with "Couldn't tell whether
  Wealthfolio linked them — it will try again next sync." and retried next
  sync. Variants that still hit the old re-create data-loss path (a row of
  another pair deleted with its partner): a shape refusal on a row already in
  another pair, a failed first read, and a 3.8 add-on (it cannot read the group,
  so it cannot tell).
- **The add-on's ledger keeps Wealthfolio's own group ids** under the
  `wf-transfer-` prefix (`ledgerGroupId`); its one-time migration drops bare
  ids. This also ends a churn that predates 1.62.0.
- **Unlink in place, then retype.** If the retype is refused the pair stays
  apart, as transfers marked external; the add-on keeps its ledger records and
  retries it next sync, and the companion retypes each while the bank feed
  still sends it.
  - The companion never logs a transfer-unlink for an incomplete unlink; its
    later retype shows as two bank-update lines.
  - The add-on's ledger keeps keys whose stored rows are no longer
    transfer-typed (two-writer staleness); drain them.
  - Adopting a pair Wealthfolio says is already linked (3.8/3.9) logs a second
    "Linked" entry, as before this branch.
- **Facts are read per row:** `searchCashActivities` has no id filter, so a row
  is found by account and its stored instant's UTC day. A row it does not
  return (an account outside Spending) keeps the 3.8 rule; 3.10 returns every
  transfer on a cash or card account, so a card's bookkeeping TRANSFER_OUT
  reads as unlinked. A row in any group, even a broken one, counts as linked.
- **The app's story** says "by a rule" without naming it: the SDK lists only
  the add-on's own rules.
- **A card's bookkeeping shape needs the host version.** The SDK cannot ask, so
  the companion publishes `wealthfolio_version` each sync and the add-on reads
  it, trusting it only while the companion's sync_health is under two days old
  (absent or stale: WITHDRAWAL). Both shapes are one row to both syncers
  (`keepBookkeepingOutflow`, reconcile's `sameType`).
  - Convergence: an add-on that cannot tell the version may retype a stored
    card TRANSFER_OUT to WITHDRAWAL once, on a real change (pending to posted,
    amount, date); then both writers keep WITHDRAWAL and W3's bookkeeping filing excludes it.
    Accepted: protecting TRANSFER_OUT on an unknown host risks writing one to
    3.8/3.9, which refuse it.
  - A netting by a pre-3.10 writer still writes WITHDRAWAL.
- **The one-time card rewrite** (`card_bookkeeping_rewrite`) rewrites each
  batch from a REST re-read (stored instant and note kept, amount and fee
  omitted), never from the database snapshot. It clears the phantom `$CASH`
  asset older withdrawals carry (sent as `$CASH-<ccy>`, which 3.10 clears). It
  needs a live database read (`openLiveDatabase`, no immutable snapshot), is off below 3.10, and
  waits while an installed add-on is below 1.62.0. Left as they are, and logged:
  rows in a transfer group, retyped rows, real security assets, rows with
  split lines, rows carrying a filing the sync did not make, and a starting
  balance whose opening-balance filing you undid (`noOpeningFile`). A refused
  batch is retried row by row; a row refused twice joins the left rows (listed
  in the entry); only a refusal (an `errors[]` entry, or a thrown 400/422) is the row's fault, so any other failure (5xx, network, any other 4xx) stops the run unmarked, as does a failed batch re-read. A run whose rows were all refused is marked done and records its entry once.
- **One shared open-ladder helper:** the writers (the card rewrite, both
  filers, the date repair's reads) now open through `companion/src/live-db.ts`;
  the readers' ladder (with its immutable rung) is still copied in
  `sqlite-native.ts` and `ledger-facts.ts`; make one.
- **Task 8 writes NEW 3.10 card starting balances as TRANSFER_OUT even under
  noOpeningFile**; the rewrite respects that setting, the first write does not.
- **Not taken:** pairing money leaving a card (3.10 takes card TRANSFER_OUT, so
  it could now be half of a pair; the detector still never pairs one);
  `findTransferMatchCandidates`, `saveTransferPair`, alternative assets.

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
