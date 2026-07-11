# Upstream PR / Issue for Wealthfolio

Submit this to: https://github.com/afadil/wealthfolio/issues/new
Or as a PR against the `main` branch.

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

Submit this to: https://github.com/afadil/wealthfolio/issues/new

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

Submit this to: https://github.com/afadil/wealthfolio/issues/new

---

## Title

`feat: expose activities.link / activities.unlink in the addon SDK`

---

## Body

### Problem

Wealthfolio has first-class internal-transfer support: two activities typed
TRANSFER_OUT / TRANSFER_IN can be linked (`POST /api/v1/activities/link`),
and linked pairs classify as InternalTransfer — correctly excluded from
spending and income analytics. Addons that import bank data (e.g. via
SimpleFin) can detect transfer pairs and import them with the right types,
but **cannot link them**: the addon SDK's activities API has no `link` /
`unlink` methods and the sandbox RPC allowlist has no corresponding entries.

The result is that addon-imported transfers count as expenses/income until
the user links each pair manually in the Spending UI (or runs a separate
server-side process against the HTTP API).

### Proposed change

- `@wealthfolio/addon-sdk`: add `link(activityAId, activityBId)` and
  `unlink(activityAId, activityBId)` to the activities API.
- Sandbox RPC allowlist: add `activities.link`, `activities.unlink`.
- Permission catalog: add `link` / `unlink` to the `activities` category
  (already high-risk, consent-gated).

The server endpoints already exist (`/activities/link`, `/activities/unlink`)
— this is only frontend/SDK plumbing.

### Use case

A bank-sync addon detects that -$500 in checking and +$500 on a credit card
within 3 days are one card payment, imports them as TRANSFER_OUT/TRANSFER_IN,
and links them so spending analytics don't double-count the payment.
