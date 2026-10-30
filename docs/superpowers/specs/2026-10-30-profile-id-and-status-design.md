# Companion: pick a Wealthfolio profile (#50) and an optional status page (#51)

Both requests come from a self-hoster who runs the companion headless in Docker,
next to a Wealthfolio 3.10 with two profiles. Nick approved both designs in chat on
2026-10-30, with one standing rule: **neither feature may add a vulnerability.**
The security rulings below are part of the design, not extras.

## #50: `WEALTHFOLIO_PROFILE_ID`

**Today:** Wealthfolio 3.10 answers `423 PROFILE_LOCKED` to any request without a
profile scope once there are several profiles, or the one profile has a lock. The
companion then stops, and the README says to keep one profile with no lock.

**How 3.10 works** (upstream tag `v3.10.0`):
- `POST /api/v1/profiles/get_profile_state {}` lists the profiles:
  `{ profiles: [{ id, name, lockEnabled, isLegacy, … }], … }`.
- `POST /api/v1/profiles/unlock_profile { profileId }` answers `{ profileId, scopeId }`.
- Every later request sends `x-wf-profile-scope: <scopeId>`.
- A grant belongs to the signed-in **owner**:
  - a password login: its JWT's `sid` (each login is a new owner);
  - an API key: the key's `sid` (every connection using the key is ONE owner);
  - auth off: the `wf_browser` cookie, or a fresh owner per request without one.
- Unlocking replaces that owner's grant. Grants live in memory and are lost when
  Wealthfolio restarts. An unlocked (no-lock) grant never idles out.
- Every profile failure is HTTP 423 with a text reason.
- A request without an `Origin` header passes the profile commands' origin check.
- Files: the original profile keeps the root database (`isLegacy`). Every other
  profile lives at `<data dir>/profiles/<id>/app.db`, with its add-ons in
  `<data dir>/profiles/<id>/addons`.

**Decided:**
- New optional env `WEALTHFOLIO_PROFILE_ID`. Unset: nothing changes, byte for byte.
- The Wealthfolio client opens the profile before its first request, after every
  login, and again after a 423 (then retries that request once).
- One grant per credential is shared by every client in the process. This avoids an
  API-key sync and the long-lived Telegram client cancelling each other's grant.
- With a profile set, requests also send a stable per-process `wf_browser` cookie.
  On a server with auth off, that makes the companion one owner instead of a new
  one per request. On an auth server the cookie is ignored.
- **Refusals** (the client throws and no request goes to the profile):
  - Unknown ID. The log lists the profiles by name and ID; the error itself
    doesn't, because it can appear on the status page.
  - The profile has a lock. No password support: a locked grant idles out after
    5 minutes, and a locked profile's data may be encrypted on disk.
  - A Wealthfolio with no profile API (before 3.10).
  - **Database mismatch (Nick: refuse).** Every account the API lists must be in
    the database file the companion reads. If the API lists none, the file must
    have none. A missing or unreadable file is refused too: a check that can't run
    is not a pass. (Changed after the security review; the first draft let a
    missing file through.)
  - Once the check passes, the checked file is pinned for the process. Every
    reader uses it instead of deciding again, so a profile folder that goes away
    can't hand the readers another profile's file.
- The check runs inside the client every time the profile opens. So it guards
  every consumer (the sync, the Telegram bot, the scheduled reports, the mini app),
  not only the sync.
- **Finding the file:** the check decides it each time the profile opens, from
  what Wealthfolio says:
  - The original profile (`isLegacy`) uses `WEALTHFOLIO_DB_PATH`.
  - Any other profile uses `<dir of WEALTHFOLIO_DB_PATH>/profiles/<id>/app.db`.
  - If `profiles.json` sits beside the configured file, that file is the
    original profile's, so another profile never falls back to it; a missing
    file is refused instead. Only a path with no `profiles.json` beside it
    (pointed straight at the profile's file) stands as given.
  - The sync opens the profile before it reads the path, so a profile's very
    first sync reads the file Wealthfolio has just created, not a guess.
  - The add-on folder follows the file, as it already does.
  (Changed after the correctness review: the first draft fell back to the
  configured file whenever the profile's own file didn't exist yet.)
- Without a profile ID, the 423 message now says to set `WEALTHFOLIO_PROFILE_ID`.

**Security:**
- The ID must be a UUID. That's checked at startup, before it is used in a path or
  a request. It is lowercased to match Wealthfolio's folder names. A bad ID stops
  the daemon at startup with the format it expects; this rules out path traversal.
- The `scopeId` from Wealthfolio must be a UUID before it goes in a header.
- No new secret is stored or sent. The unlock call carries only the profile ID.
- The account check compares IDs in JavaScript. Nothing from the API is put in SQL.
- Server text in errors stays bounded by the existing `httpError` (300 chars).
- One credential per call: `send()` reads the token once and uses it for the
  session lookup, the opening and the request. A `login()` landing mid-call
  can't pair the old token with the new owner's session.

## #51: `STATUS_PORT` and `GET /status`

**Decided:**
- New optional env `STATUS_PORT` (1–65535). Unset: no server.
- Optional `STATUS_HOST`, the bind address, defaults to all interfaces. The
  in-container healthcheck works with `127.0.0.1`. Claude's call, added for the
  security rule.
- It's separate from `MINIAPP_PORT`, which uses Telegram auth. The mini app server
  is unchanged.
- A process-memory record of the companion's own runs (scheduled, startup,
  `/sync`). It covers a failed Wealthfolio login, which `sync_health` cannot
  record. It doesn't cover syncs started in the add-on.
- The body:
  ```json
  { "version": "1.71.0", "ok": true, "running": false,
    "lastRun": { "startedAt": "…", "finishedAt": "…", "outcome": "synced",
                 "imported": 3, "skipped": 120, "error": null },
    "lastSyncedAt": "…" }
  ```
- Outcomes and status codes:
  - `failed` (the run threw): 503.
  - `synced`, `limited` (SimpleFin's request budget stopped the download),
    `too-soon` (the 1-hour minimum interval) and `not-configured`: 200.
  - No run finished yet (`lastRun: null`): 200, so a slow first sync doesn't flip a
    healthcheck.
- `lastSyncedAt` is the last `synced` run in this process.
- No staleness check: the caller has the times.
- The image's built-in HEALTHCHECK stays. The README shows a compose healthcheck
  that uses `/status`.

**Security** (Nick: the failure message is shown):
- Read-only and side-effect free. Nothing on this port starts a sync, calls
  Wealthfolio, or reads the database. A request only serializes the in-memory record.
- Only `GET`/`HEAD` on exactly `/status` (any query string ignored). Other methods
  get 405 with `Allow`; other paths get 404. Request input is never reflected.
  The request body is never read.
- Headers: `Content-Type: application/json; charset=utf-8`,
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. No CORS headers, so
  another site's page cannot read it from a browser.
- Short server timeouts (headers 5 s, request 10 s, keep-alive 5 s, idle socket
  10 s). They're enforced every second, where Node's default check is every 30 s.
  At most 64 connections, and an 8 KB header limit.
- A bind failure (port taken) is logged, never a crash.
- The error text is scrubbed before it is stored. The log keeps the full text.
  - The Wealthfolio password and API key are blanked wherever they appear.
  - URL credentials are masked up to the authority's last `@`, spaces included,
    because Node quotes a raw URL unencoded.
  - Telegram bot tokens, `Bearer`/`Basic` tokens and JWT-shaped strings are
    masked.
  - Text a server sent is dropped: `httpError`'s response body, and the input
    snippet a JSON parse error quotes, which could hold amounts or payees.
  - Control characters are collapsed, and the result is capped at 300 characters.
- No amounts, account names, bank names, profile names, or the access URL.
- Accepted risk: a DNS-rebinding page could read the record (counts, times,
  version, scrubbed error). It holds nothing sensitive, and the port is off unless
  turned on. A Host allowlist was considered and declined: it would make everyone
  who reaches the page by a hostname add another setting.

## Not doing
- Password-locked profiles.
- Several profiles from one companion.
- A staleness threshold.
- Changing the mini app server or the image HEALTHCHECK.
