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
  stays in "not explained": a spending account the add-on does not map, a
  linked transfer filed under a spending category, a row Wealthfolio puts in
  another month other than at 00:00 UTC on the 1st (an east-of-UTC local
  midnight at the month's end, 3.10), an activity type override, the
  uncategorized reader's dismissed rows and rows awaiting a transfer's other
  half, and split lines. A card's opening debt is counted by the report (the
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
- **R2 (Fix) is next:** Link on a Health leg with a unique other half (the
  snapshot already carries both rows' ids, accounts, tx keys, amounts and
  dates), and "Remove for good…" on a transaction's story.

## 14. Getting started (2026-10-14, plan `2026-10-14-getting-started.md`)

- **Suggested budgets' spend read differs from Wealthfolio's own budget actuals** (`getNativeBudgetSpend`, companion/src/sqlite-native.ts). It matches them on the spending accounts and the excluded categories (an excluded subcategory's own rows dropped before the roll-up) only. Three known differences: a LINKED `TRANSFER_OUT` filed under a category counts here (upstream treats a linked transfer as neutral); `activity_type_override` is ignored (the raw `activity_type` classifies); `spending_activity_splits` are ignored (an activity counts whole, under its one assignment). Cost: a suggestion can be off by those rows; it is only a suggestion.

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
