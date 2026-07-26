# Companion parity via a shared sync core

**Date:** 2026-07-26
**Status:** approved, ready for implementation planning

## Problem

The Docker companion (`companion/`) runs an older, diverged copy of the sync
logic. It drops pending transactions outright, sends `$CASH-<ccy>` on transfer
legs (the phantom-security bug that prevents cash from moving and makes pairs
unlinkable), and lacks pending reconciliation, drift healing, spending-neutral
balance plugs, and the starting-balance baseline fix.

Porting those fixes by hand would duplicate roughly 600 lines of subtle,
hard-won orchestration — precisely the code whose sequencing bugs took a full
day to find. The two implementations would drift again.

Separately, the companion duplicates configuration: it reads `ACCOUNT_MAPPING`
from an env var while the addon stores mapping and rules in Wealthfolio's
encrypted addon secrets. If the companion becomes the primary syncer, editing a
rule in the UI would silently not affect background syncs.

## Goal

The companion becomes the primary, always-on syncer: open Wealthfolio and the
data is already correct. The addon remains the setup and manual-control UI, and
must continue to work standalone for users without Docker.

## Key findings that shape the design

Both were verified against the Wealthfolio source before designing:

1. **`GET /api/v1/addons/{addon_id}/secrets?key=<key>` exists.** The companion
   can read the addon's own stored config and state — including
   `simplefin_access_url` — using the session token it already obtains via
   `login()`. Configuration and shared state therefore live in exactly one
   place, and the two syncers cannot disagree about what has already been
   synced.
2. **The REST API is more capable than the addon SDK for linking.**
   `POST /api/v1/activities/link` takes two activity ids, and
   `searchActivities` returns `sourceGroupId`. The addon SDK offers neither: it
   cannot read `sourceGroupId` back, and has no link endpoint, which is why it
   needs the delete-and-recreate-both-legs workaround.

The second finding means strict mechanical parity is the wrong target. The
hosts genuinely differ; forcing the companion through the addon's workaround
would make it worse.

## Architecture

Split the current 982-line `src/utils/sync.ts` along its three existing
concerns: deciding what to do, talking to Wealthfolio, and reading config.

```
shared/
  mapper.ts  transfers.ts  reconcile.ts   unchanged (pure, already shared)
  sync-host.ts                            NEW  interfaces + normalized types
  sync-core.ts                            NEW  runSyncCore(host, store, opts)

src/utils/addon-host.ts                   NEW  adapter over ctx.api.*
companion/src/rest-host.ts                NEW  adapter over WealthfolioClient
src/utils/sync.ts                         shrinks to a thin wrapper
```

### SyncHost

Everything that touches the outside world:

```ts
interface SyncHost {
  fetchSimplefin(accessUrl, since, authKey?): Promise<SimplefinAccountSet>;
  listAccounts(): Promise<Array<{ id; accountType; name? }>>;
  latestValuations(ids: string[]): Promise<Map<string, number>>;
  listActivities(accountId): Promise<HostActivity[]>;
  saveMany(req: SaveManyRequest): Promise<SaveManyResult>;
  importActivities(rows: ImportRow[]): Promise<void>;
  linkPair(legs: [LinkLeg, LinkLeg]): Promise<{ linked: boolean; groupId?: string }>;
  readonly capabilities: { readsSourceGroupId: boolean };
}
```

`HostActivity` is a normalized row: `id`, `accountId`, `activityType`, `date`,
`amount`, `comment`, `assetId?`, `sourceGroupId?`.

### SyncStore

Config and shared state, backed by the same secret keys on both sides:
`simplefin_access_url`, `account_mapping`, `mapping_rules`,
`balance_initialized`, `last_sync_at`, `linked_groups`, `account_balances`,
`auto_heal`, `auto_adjust`, `account_names`.

### Two deliberate asymmetries

**`linkPair` is a host capability, not core logic.** The core decides *which two
activities belong together*; the host decides *how to say so*. The addon mints a
`wf-transfer-` group id, deletes both legs, and re-creates them in a single
`saveMany` carrying the internal-transfer metadata marker, then reads the echo
to confirm. The companion issues one `POST /activities/link`.

**`capabilities.readsSourceGroupId` handles the read asymmetry.** When true (the
companion), the core reads link state directly from the activity row and skips
the `linked_groups` ledger entirely — removing a whole class of stale-ledger
bugs on that side. When false (the addon), it falls back to the ledger.

## Data flow: one sync run

1. Read config and state from `store`; resolve the window (normal, auto-heal
   44 days, manual heal 89 days).
2. `host.fetchSimplefin(...)`; filter SimpleFin's informational window notices.
3. Per account: resolve activity types (user rules take precedence); collect
   transfer candidates.
4. Detect transfer pairs across all accounts.
5. Per account: `listActivities` → `planReconciliation` → `saveMany`
   (creates, updates, deletes).
6. Adjust the starting-balance baseline by the signed total of any newly
   created rows dated before it.
7. Measure drift on settled accounts only; insert a spending-neutral `CREDIT`
   plug when aggressive auto-heal is enabled, at most one per account per day.
8. Link outstanding pairs via `host.linkPair`; reconcile `linked_groups` unless
   the host reads `sourceGroupId` directly.
9. Persist `last_sync_at` and per-account balances.

## Error handling

Semantics are unchanged: per-account failures are isolated so one bad account
cannot abort the run; save errors are collected and surfaced to the caller;
SimpleFin's benign window-size notices are filtered out rather than shown as
errors; a leg that could not be linked is reported on an explicit reconcile and
retried on the next run.

## Testing

- The existing 196 tests keep passing against the addon adapter. That is the
  regression proof for the refactor.
- `sync-core` gets its own tests against a fake in-memory `SyncHost`, which is
  substantially simpler than the current SDK mocks.
- Companion tests reuse that fake, plus a `linkPair` test asserting the REST
  path links in a single call and reads the group id back.

## Distribution and rollout

- **Addon:** nothing public changes during this work. Registry PR #9 pins tag
  `v1.0.0`. A `v1.1.0` tag and a repin PR follow only when the user chooses.
- **Companion image:** published to GHCR as
  `ghcr.io/bubbles840/wealthfolio-simplefin-sync`, built and pushed by a GitHub
  Action on tag push. Free for public images, no extra account, and consistent
  with how Wealthfolio itself is distributed.
- **Companion configuration** reduces to `WEALTHFOLIO_API_URL` and
  `WEALTHFOLIO_PASSWORD`. The SimpleFin access URL, mapping, and rules are read
  from the addon's secrets.

## Out of scope

- **Budget notifications** (for example, a daily "you have $20 left for food
  this week" digest). This is budget monitoring rather than sync, and belongs
  in its own project. The companion is a reasonable future home for it, since
  it is already a long-running scheduled service.
- **Removing the addon's in-browser scheduler.** Once the companion is trusted,
  running one scheduler avoids two writers racing. Deferred until the companion
  is proven in practice.
