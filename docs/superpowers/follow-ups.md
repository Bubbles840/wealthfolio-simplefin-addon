# Known follow-ups

Findings that survived a review cycle without being fixed, with enough context
to act on them later. Each says why it was deferred, so a future reader can
tell "decided against" from "not got to yet".

Last updated: 2026-07-28, after the notification-system-redesign branch
(plan: `docs/superpowers/plans/2026-07-28-notification-system-redesign.md`).

---

## 1. Companion drift is inflated by every linked TRANSFER_OUT

**Priority: highest — this one can write wrong numbers into real accounts.**
Pre-existing; predates the notification redesign and was verified unmodified by
it.

`shared/sync-core.ts`, drift measurement: `unlinkedTransferOut` subtracts every
`TRANSFER_OUT` not present in `ledgerLinkedTxIds` from Wealthfolio's valuation
before computing drift. But `ledgerLinkedTxIds` is only ever populated inside
`if (!readsGroups)`, and `RestSyncHost.capabilities.readsSourceGroupId` is
`true` — so **on the companion that set is always empty and every
`TRANSFER_OUT` reads as unlinked**, including correctly-linked legs whose cash
has already moved.

Consequence: on a settled run (no pending rows, no updates or deletes) the
computed drift is inflated by the transfer amount. With **Aggressively
auto-heal** enabled that inserts a bogus spending-neutral `CREDIT` balance
adjustment, up to once per account per day, for as long as the leg stays within
the 500-row `listActivities` page.

Fingerprint to look for: unexplained `Balance adjustment · <account> · <date>`
rows on a CASH account that also has linked transfers.

Fix direction: the guard needs a capability-aware equivalent for hosts that read
`sourceGroupId` off the rows — on those hosts a leg's own `sourceGroupId` already
says whether it is linked, so the ledger is the wrong source of truth. Until
then, prefer plain **Auto-heal** over **Aggressively auto-heal** on the
companion.

---

## 2. The test double models the server's update semantics backwards

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

## 3. A failed `linkPair` leaves a leg the relink sweep will never repair

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
  `DAILY_REPORT_SCHEDULE`, `WEEKLY_REPORT_SCHEDULE`, or `TZ`.

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
   linked transfers — that is item 1's fingerprint.
6. **Confirm the Saturday report is wanted by default.** Only
   `weeklyReportEnabled === false` suppresses it, so an existing
   `telegram_config` without that field opts in silently.
