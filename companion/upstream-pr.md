# Upstream Issues for Wealthfolio

Filed as issues (not PRs) against https://github.com/afadil/wealthfolio.
Reporting a needed change in someone else's project is what the Issues tab
is for; a PR is only worth it once you've written and tested the fix in
their codebase yourself.

## Status

| # | Title | Kind | Status | Our follow-up when it ships |
|---|-------|------|--------|------------------------------|
| 1 | Basic auth in addon network requests | feature | **Shipped in v3.6.2** | Drop the patched `wealthfolio-patched` image; use the official image. See "Follow-up 1" below. |
| 2 | Sandbox `.import()` rewrite bug | bug | **Shipped in v3.6.2** | Remove the post-minify `["import"]` workaround from `vite.config.ts`. See "Follow-up 2". |
| 3 | Expose `activities.link` to addons | feature | Not yet filed — post the section below | Being addressed via a self-assigned shared sourceGroupId (see 2026-07-18 plan, Task 12); the dedicated link() method is still not in 3.6.2. |
| 4 | Expose spending-tracker settings to addons | feature | Not yet filed — post the section below | Auto-enroll CASH / CREDIT_CARD accounts during setup, skip investment accounts. See "Follow-up 4". |
| 5 | Bulk import doesn't move cash for transfer legs | bug | Not yet filed — post the section below | Drop the balance-adjustment "heal" workaround for internal cash transfers once cash transfers move balances natively. |

Once a release lands that includes #1 and #2, do the follow-ups below and
bump `minWealthfolioVersion` in `manifest.json` to that release.

---
---

# Upstream Issue #1 — Basic auth in addon network requests

**Status: accepted upstream, expected in the next release.** Kept here for
the record and for the follow-up work it unblocks.

---

## Title

`feat: support Basic auth type in addon network requests`

---

## Body

### Problem

The addon network proxy (`crates/core/src/addons/network.rs`) currently only
supports `auth.type = "bearer"`, which injects `Authorization: Bearer <secret>`.

Several real-world APIs — most notably **SimpleFin Bridge**, the open banking
protocol used by many personal finance apps — require **HTTP Basic auth**
(`Authorization: Basic base64(user:pass)`). There is no way to reach these
APIs from an addon today, even though the addon SDK's `NetworkAuth` interface
could trivially model a `"basic"` type alongside `"bearer"`.

### Proposed change

**`crates/core/src/addons/network.rs`** — in `resolve_addon_network_auth_header`:

```rust
// BEFORE
if auth.auth_type != "bearer" {
    return Err("Addon network auth type is not supported".to_string());
}
// ... secret lookup ...
Ok(Some(format!("Bearer {}", secret)))

// AFTER
let auth_type = auth.auth_type.as_str();
if auth_type != "bearer" && auth_type != "basic" {
    return Err("Addon network auth type is not supported".to_string());
}
// ... secret lookup (unchanged) ...
let scheme = if auth_type == "basic" { "Basic" } else { "Bearer" };
Ok(Some(format!("{} {}", scheme, secret)))
```

**`@wealthfolio/addon-sdk`** — update the `NetworkAuth` type:

```typescript
// BEFORE
interface NetworkAuth {
  type: 'bearer';
  secretKey: string;
}

// AFTER
interface NetworkAuth {
  type: 'bearer' | 'basic';
  secretKey: string;
}
```

### Security model (unchanged)

- The secret is always fetched from the server-side secrets store — the addon
  JS never sees the credential value.
- URL-embedded credentials and direct `Authorization` headers remain blocked.
- The only change is that the stored secret can be injected with `Basic` scheme
  instead of `Bearer` scheme, depending on which `type` the addon declares.

### Use case: SimpleFin Sync addon

SimpleFin Bridge (<https://www.simplefin.org>) issues access URLs of the form
`https://user:pass@bridge.simplefin.org/simplefin`. The addon:

1. At setup time, extracts `user:pass`, base64-encodes it, and stores it as a
   secret via `ctx.api.secrets.set`.
2. At sync time, calls `ctx.api.network.request({ auth: { type: 'basic', secretKey: 'key' } })`.
3. The backend looks up the secret and injects `Authorization: Basic <value>`.

This keeps credentials out of addon JS entirely and reuses the existing secrets
and network proxy machinery.

---

## Files to change

| File | Change |
|------|--------|
| `crates/core/src/addons/network.rs` | Accept `"basic"` in type check; emit correct scheme |
| `packages/addon-sdk/src/types.ts` (or equivalent) | Widen `NetworkAuth.type` to `'bearer' \| 'basic'` |

The Rust diff is ~5 lines. The TypeScript change is one character (`\| 'basic'`).

---
---

# Upstream Issue #2 — Sandbox Import Rewrite Bug

**Status: accepted upstream, expected in the next release.** Kept for the
record and the follow-up it unblocks.

---

## Title

`bug: sandbox dynamic-import rewrite mangles .import() method calls`

---

## Body

### Problem

The addon sandbox entry point (`apps/frontend/src/addons/iframe/addon-sandbox-entry.tsx`)
rewrites addon code to block dynamic `import()` expressions:

```ts
code.replace(/\bimport\s*\(/g, `globalThis.__wealthfolioImport(...`)
```

The regex uses `\b` (word boundary) to anchor the match, but `\b` matches
between `.` and `i` — meaning it triggers on **legitimate method calls** like
`ctx.api.activities.import(activities)`, not just standalone `import()` statements.

The rewritten code becomes:

```ts
ctx.api.activities.globalThis.__wealthfolioImport(...)
```

This fails at runtime with:

> *"Unknown addon host API method 'activities.globalThis.__wealthfolioImport'"*

### Steps to reproduce

1. Create an addon that calls a host API method named `import`, e.g.:
   ```ts
   const result = await ctx.api.activities.import(activities);
   ```
2. Load the addon in Wealthfolio.
3. The sandbox rewrites the call, and the addon crashes with the error above.

### Suggested fix

Replace the regex with a negative lookbehind that excludes matches preceded by
`.`, word characters, or `$`:

```ts
// BEFORE
code.replace(/\bimport\s*\(/g, `globalThis.__wealthfolioImport(...`)

// AFTER
code.replace(/(?<![.\w$])import\s*\(/g, `globalThis.__wealthfolioImport(...`)
```

This ensures only standalone `import()` expressions are rewritten, while
`foo.import(...)` method calls pass through untouched.

### Workaround

Addon authors can work around this by using bracket notation in their bundles:

```ts
ctx.api.activities["import"](activities)
```

However, any addon using the documented `activities.import(...)` API will hit
this bug without the workaround.

### Files to change

| File | Change |
|------|--------|
| `apps/frontend/src/addons/iframe/addon-sandbox-entry.tsx` | Update regex to `(?<![.\w$])import\s*\(` |

The fix is a single regex change.

---

# Upstream Issue #3 — Expose transfer linking to addons

**Status: ready to post.** Copy the Title and Body below into
https://github.com/afadil/wealthfolio/issues/new (label it a feature
request). Post it as an issue, not a PR — the change lives across the SDK,
the sandbox allowlist, and the permission catalog, so it's cleanest for a
maintainer to implement.

---

## Title

`feat: expose activities.link / activities.unlink in the addon SDK`

---

## Body

### Problem

Wealthfolio has first-class internal-transfer support: two activities typed
`TRANSFER_OUT` / `TRANSFER_IN` can be linked (`POST /api/v1/activities/link`),
and linked pairs classify as `InternalTransfer` — correctly excluded from
spending and income analytics. Addons that import bank data (e.g. via
SimpleFin) can detect transfer pairs and import them with the right types,
but **cannot link them**: the addon SDK's activities API has no `link` /
`unlink` methods, and the sandbox RPC allowlist has no corresponding entries.

The result is that addon-imported transfers keep counting as spending /
income until the user links each pair by hand in the Spending UI. For a
bank-sync addon that produces these pairs automatically, the missing link
step is the one thing it can't finish on its own.

### Proposed change

- **`@wealthfolio/addon-sdk`** — add to the activities host API:
  ```ts
  link(activityAId: string, activityBId: string): Promise<void>;
  unlink(activityAId: string, activityBId: string): Promise<void>;
  ```
- **Sandbox RPC allowlist** — add `activities.link` and `activities.unlink`
  alongside the existing `activities.*` entries.
- **Permission catalog** — add `link` / `unlink` to the `activities`
  category (already high-risk and consent-gated, so no new risk tier).

The server endpoints already exist (`/activities/link`,
`/activities/unlink`), so this is frontend/SDK plumbing only — the same
shape as the existing `activities.import` / `activities.checkImport` wiring.

### Use case

A bank-sync addon detects that a −$500 charge in checking and a +$500 credit
on a card within a few days are one card payment, imports them as
`TRANSFER_OUT` / `TRANSFER_IN`, and links them so spending analytics don't
double-count the payment — end to end, without asking the user to link each
pair manually.

### Files to change

| File | Change |
|------|--------|
| `packages/addon-sdk/src/host-api.ts` (activities API) | Add `link` / `unlink` method signatures |
| `apps/frontend/src/addons/iframe/addon-iframe-manager.ts` | Add `activities.link`, `activities.unlink` to the RPC allowlist |
| `apps/frontend/src/addons/…` runtime context | Wire the two methods to the existing `/activities/link` + `/activities/unlink` calls |
| `packages/addon-sdk/src/permissions.ts` | Add `link` / `unlink` to the `activities` permission category |

No server-side changes — the endpoints already exist.

---
---

# Upstream Issue #4 — Expose spending-tracker settings to addons

**Status: ready to post.** Copy the Title and Body below into
https://github.com/afadil/wealthfolio/issues/new (feature request). Post as
an issue, not a PR.

---

## Title

`feat: expose spending-tracker settings (spending.getSettings / updateSettings) in the addon SDK`

---

## Body

### Problem

Enrolling an account in the Spending Tracker is a manual step
(Settings → Spending Tracker → select accounts). The server already exposes
it (`GET`/`PUT /api/v1/spending/settings` with
`{ enabled, account_ids }`), but the addon SDK has no `spending` API, the
sandbox RPC allowlist has no `spending.*` entries, and there is no
`spending` permission category.

A bank-sync addon (e.g. SimpleFin) knows each account's type at setup time
via `accounts.getAll()` (`accountType`). It could enroll the accounts a user
would obviously want tracked — cash/checking/savings and credit cards — and
skip investment accounts, so the user doesn't have to repeat the mapping in
a second place. Today it can't, because the setting isn't reachable from an
addon.

### Proposed change

- **`@wealthfolio/addon-sdk`** — add a `spending` host API:
  ```ts
  getSettings(): Promise<{ enabled: boolean; accountIds: string[] }>;
  updateSettings(update: { enabled?: boolean; accountIds?: string[] }): Promise<…>;
  ```
- **Sandbox RPC allowlist** — add `spending.getSettings`,
  `spending.updateSettings`.
- **Permission catalog** — add a `spending` category (high-risk,
  consent-gated) with `getSettings` / `updateSettings`.

Server endpoints already exist (`/spending/settings`) — frontend/SDK
plumbing only.

### Use case

On first setup, a bank-sync addon reads `accountType` for each mapped
account and adds the CASH / CREDIT_CARD ones to the spending tracker's
`accountIds`, leaving investment accounts out — so spending analytics work
immediately without a separate manual enrollment step.

### Files to change

| File | Change |
|------|--------|
| `packages/addon-sdk/src/host-api.ts` | Add a `spending` API with `getSettings` / `updateSettings` |
| `apps/frontend/src/addons/iframe/addon-iframe-manager.ts` | Add `spending.getSettings`, `spending.updateSettings` to the RPC allowlist |
| `apps/frontend/src/addons/…` runtime context | Wire to `/spending/settings` GET/PUT |
| `packages/addon-sdk/src/permissions.ts` | Add a `spending` permission category |

No server-side changes — the endpoints already exist.

---
---

# Follow-up work on our side (this repo) once each ships

These are the changes to make **here** after a Wealthfolio release includes
the upstream fixes. Bump `minWealthfolioVersion` in `manifest.json` to that
release as part of the same change.

## Follow-up 1 — drop the patched image (after Issue #1 ships)

- Stop building/running the `wealthfolio-patched` image; use the official
  Wealthfolio image. The addon already sends `auth: { type: 'basic', … }`,
  which the official build will then accept natively.
- Remove `companion/build-wealthfolio.sh` (or mark it legacy) and any README
  mention of the patched image.

## Follow-up 2 — remove the `import()` workaround (after Issue #2 ships)

- Delete the post-minify transform in `vite.config.ts` that rewrites
  `.import(` → `["import"](` (the `escapeImportPropertyCalls` plugin). Once
  the sandbox regex is fixed upstream, `ctx.api.activities.import(...)`
  survives untouched and the workaround is dead weight.
- Keep the `grep -c '\.import('` build check until this is done, then drop it.

## Follow-up 3 — native transfer linking (after Issue #3 ships)

- Add `link` to the addon's activities calls and link detected pairs directly
  in `runSync` (mirror the companion's reconciliation sweep, which already
  does this via the HTTP API). Add `activities: [..., 'link']` to the
  manifest permissions.
- Drop the "link manually in the Spending tab" step from the README; the
  addon becomes fully hands-off for transfers.

## Follow-up 4 — auto-enroll in the spending tracker (after Issue #4 ships)

- During setup (and on each sync, idempotently), read `accountType` from
  `accounts.getAll()` and call `spending.updateSettings` to add the mapped
  `CASH` / `CREDIT_CARD` account IDs to the tracker, leaving investment
  (`SECURITIES`) accounts out. Merge with the existing `accountIds` — never
  remove an account the user enrolled themselves.
- Add a `spending` entry to the manifest permissions, and drop the
  "enable the Spending Tracker manually" callout from the SyncPage / README.

---
---

# Upstream Issue #5 — Bulk import doesn't resolve $CASH for transfer legs

**Status: ready to post.** Copy the Title and Body below into
https://github.com/afadil/wealthfolio/issues/new (label it a bug). Discovered
2026-07-19 debugging cash-account balance drift.

## Title

`bug: /activities/bulk resolves $CASH-<ccy> to real cash for DEPOSIT/WITHDRAWAL but not TRANSFER_IN/TRANSFER_OUT`

## Body

### Problem

Creating cash activities through `POST /api/v1/activities/bulk` with the reserved
cash symbol (`{ symbol: "$CASH-USD" }`):

- **DEPOSIT / WITHDRAWAL** → resolve to the account's real **Cash** asset; the
  `amount` moves the cash balance correctly. ✓
- **TRANSFER_IN / TRANSFER_OUT** → resolve to a literal **security** named
  "$CASH"; the leg shows Price/Amount **$0.00** (real figure only in Total),
  quantity is empty, and **the account's cash balance does not move**. ✗

The two linked legs still pair (shared `source_group_id`) and classify as an
internal transfer (excluded from spending) — but because neither leg moves
cash, both accounts drift from their true balances by the transfer amount.

A transfer created through Wealthfolio's own **Add Activity → Transfer (Cash)**
form works correctly (symbol shows "Cash", Price/Amount = the amount, both
balances move). So the cash-symbol resolution exists; it just isn't applied on
the bulk-import path for transfer legs. Adding `quantity`/`unitPrice` to the
bulk payload does not override it.

### Expected

`/activities/bulk` should resolve `$CASH-<ccy>` to the account's cash asset for
`TRANSFER_IN`/`TRANSFER_OUT` the same way it does for `DEPOSIT`/`WITHDRAWAL`, so
an amount-only cash transfer moves both accounts' cash balances.

### Impact for the SimpleFin Sync addon

Internal cash transfers between two synced accounts (e.g. savings → checking)
import as linked TRANSFER_OUT/TRANSFER_IN (correctly excluded from spending) but
leave both account balances wrong. Today the addon works around it with a
balance-adjustment "heal" — but a native fix here removes the need entirely.

### Steps to reproduce

1. `POST /api/v1/activities/bulk` with two linked cash legs, e.g.:
   ```json
   {
     "creates": [
       { "accountId": "<A>", "activityType": "TRANSFER_OUT",
         "symbol": { "symbol": "$CASH-USD" }, "amount": 100, "currency": "USD",
         "sourceGroupId": "grp-1" },
       { "accountId": "<B>", "activityType": "TRANSFER_IN",
         "symbol": { "symbol": "$CASH-USD" }, "amount": 100, "currency": "USD",
         "sourceGroupId": "grp-1" }
     ]
   }
   ```
2. Open either account: the leg shows symbol **"$CASH"**, Price/Amount **$0.00**
   (the 100 only appears in Total), and the **cash balance is unchanged**.
3. Now create the same transfer via **Add Activity → Transfer (Cash)** between
   A and B: symbol shows **"Cash"**, Price/Amount = **$100**, and **both cash
   balances move**. Same intent, different result.

### Files to change (likely)

| File | Change |
|------|--------|
| `crates/core/src/activities/…` (bulk-import asset resolution) | Resolve the reserved `$CASH-<ccy>` symbol to the account's cash asset for `TRANSFER_IN` / `TRANSFER_OUT` legs, the same resolution already applied to `DEPOSIT` / `WITHDRAWAL`, so the leg's `amount` moves the cash balance. |
