# Replace the SimpleFIN token without Reset: design

Date: 2026-11-26. Requested by Nick after lilyusi asked on #58 how to update the token without resetting. Nick handed over
the design ("do what you think is best… just make it easy to use"), so every call below is Claude's unless it says otherwise.

## Why

Today a new setup token can only be pasted on the first-run Setup page, and the only way back to it is Reset. Reset clears
the account mapping, the transaction and ignore rules, the change log, and the Telegram and Amazon setup. People need a new
token when:

- SimpleFIN Bridge disables an access token for over-use;
- they disconnect the app in Bridge or Lunch Flow;
- they make a new token, which can cut off the old one;
- they move from Bridge to Lunch Flow.

A dead token also shows up badly today. The add-on says only `SimpleFin /accounts failed: 403 — …`. The companion's
Telegram alert says `Last error: SimpleFin /accounts failed: 403`. Neither says what to do.

**Success:** someone whose connection stopped working sees a "Replace token" button where the error is. They paste a new
token into one box, and syncing carries on with every setting kept. If the new connection's accounts have new ids, they're
sent straight to the mapping, where the existing reconnection questions take over.

## Goals

1. A **SimpleFIN connection** card in Settings, with one token box and a **Connect** button that swaps the connection and
   keeps everything else.
2. The working connection is never replaced by one that hasn't listed accounts. A new token is tested first.
3. Wherever a refused connection (HTTP 401/403 from `/accounts`) is reported, there's a way to fix it:
   - the add-on's sync error box;
   - the Settings Accounts refresh error;
   - a Home banner for the companion's failure;
   - the companion's Telegram "failing since" alert, as text.
4. Mapped accounts missing from the new connection are named, and the mapper opens on the new account list.

## Non-goals and anti-goals

- **No change to how reconnected accounts are matched.** The mapper's relink questions and the sync's reconnection handling
  (shared/relink.ts) stay exactly as they are; this feature only gets the person to them.
- **No change to the SimpleFIN request budget** (shared/simplefin-budget.ts) or the 24-hour Telegram alert delay.
- **Never show or log the access URL** or its credentials. The card shows only the provider's name.
- **Anti-goal:** a replace that silently breaks a working setup. Pasting a token for an empty or wrong SimpleFIN account must
  leave the current connection as it was.
- **Anti-goal:** a second, divergent copy of Setup's claim code. Setup and the new card share one helper.

## Approaches considered

1. **A card in Settings that tests, then swaps (chosen).** Claim the token, test it with credentials saved under a temporary
   secret key, and swap the stored connection only after the test lists accounts. Nothing else is touched. It reuses the
   mapper for any ids that changed.
2. **Send the person back to the Setup page in a "keep settings" mode.** Less new UI, but Setup's second step saves a fresh
   mapping and turns the schedule back to the default, so every step would need a special case. It also takes them out of
   Settings, away from the mapper they may need.
3. **Swap first, restore on failure.** Simpler code, but a page closed between the two steps leaves an untested connection
   stored, and the companion can sync with it in between. That is the anti-goal.

## Design

### Shared logic: new `shared/simplefin-connection.ts`

It imports nothing from the add-on or companion, so both halves use it.

- `isRefusedConnection(err | message, status?)` is true for status 401 or 403. With no status, it matches the message
  `/\/accounts failed: 40[13]\b/` (the companion's errors and stored `lastError` carry only the text). It is never true for
  402 (SimpleFIN's "payment required") or any other status.
- `REFUSED_CONNECTION_LINE` is the one wording for the fix: "SimpleFIN no longer accepts this connection. Paste a new setup
  token in SimpleFin Sync → Settings → SimpleFIN connection; your mapping and rules stay." Telegram and the UI may shorten
  the second half around a button.
- `providerName(accessUrl)` gives "SimpleFIN Bridge" (simplefin.org), "Lunch Flow" (lunchflow.app), the hostname for
  anything else, or null for an unparseable or empty value. It never returns the credentials.
- `missingMappedAccounts(mapping, accounts)` lists the SimpleFIN ids that are mapped to a Wealthfolio account (a non-empty
  target, loans included if the loan links are keyed the same way: the builder checks) but absent from the new list.

### One claim helper for Setup and the card

Move Setup's claim and credentials code out of `src/pages/SetupPage.tsx` into one helper module (for example
`src/utils/connect.ts`):

- Claim reuse when the same token is pasted again: `claimed.current?.token === pasted`.
- `claimToken`.
- The base64(user:pass) computation.

Setup keeps its current order: it saves the access URL and credentials, then fetches. It has no working connection to
protect. Its behaviour and tests must not change.

### Store

`src/utils/secrets.ts` gets:

- a temporary credentials key, `simplefin_auth_b64_next`, used only to test a new token;
- `simplefin_connection_replaced_at`, an ISO time.

Both go in `KEYS`, so Reset's `clearAll` deletes them.

### Replace flow (Connect)

1. Check `directCallLine(store, 'setup')` first, as Setup does. Refused means a message and no claim, so the token stays
   unspent.
2. Claim the token through the shared helper. Keep `{ token, accessUrl }` in a ref, so retrying after a failed test needs no
   new token while the page stays open. That is how Setup behaves now.
3. Write the new credentials under `simplefin_auth_b64_next` and run `fetchAccounts(newUrl, yesterday, network,
   'simplefin_auth_b64_next')`. The fetch has a one-day window: only the list is needed.
4. If the fetch fails or lists **zero accounts**, change nothing stored except the temporary key. Show: "The token was
   accepted, but SimpleFIN didn't list any accounts: <reason>. Your current connection is unchanged. Press Connect to try
   again: the same token works while this page stays open." Errors in the account set (`set.errors`) with at least one account
   are shown but don't block.
5. On success, write in this order:
   1. `setAccessUrl(newUrl)`;
   2. `setAuthB64(b64)`;
   3. delete the temporary key;
   4. write `simplefin_connection_replaced_at`;
   5. merge the new names into the stored account names, never replacing them, like `loadAccounts`;
   6. record a change-log entry, `kind: 'connection-replaced'`, `actor: 'you'`, `undoable: false`, summary "Replaced the
      SimpleFIN connection", with the old and new provider names (never URLs). The builder adds the kind wherever
      `CHANGE_KINDS` and the log's rendering need it.
6. Then show the result:
   - **All mapped accounts found:** "✓ Connected through <provider>. All N mapped accounts are in this connection. The next
     sync uses it."
   - **Some missing:** "✓ Connected through <provider>. N mapped accounts aren't in this connection: <names>. If your bank
     lists them under new names, map them below." The card hands the fetched list to the Accounts card, which is already in
     SettingsTab (`setSfAccounts`, plus `sfAccountsHadErrors` from the set). It opens that card, so the mapper and its relink
     questions show with no second SimpleFIN download.
7. Clear the page's sync error if it was a refused connection. SyncPage passes a callback such as `onConnectionReplaced`.
8. The token box is cleared only after a successful swap. Connect is disabled while the box is empty, while connecting, and
   while a sync is running, if SettingsTab can see that. If it can't, the builder notes it.

### The card

It goes in the Settings "Accounts" group, directly after the Accounts card, as a `CollapsibleCard` with id
`CARD.connection = 'connection'`, collapsed by default.

```
SimpleFIN connection                         SimpleFIN Bridge   ▸
──────────────────────────────────────────────────────────────────
Replace the token if SimpleFIN stopped accepting this connection, or
you made a new token in SimpleFIN Bridge or Lunch Flow. Your mapping,
rules and history stay.

[ Paste new setup token                       ]  [ Connect ]
```

- Collapsed summary: the provider name, "Not connected" with no URL, or "Stopped accepting this connection" when a refused
  connection is the current known state.
- The same Lunch Flow host-approval message as Setup (`hostNotApprovedMessage`) is reached through the shared helper.

### Making the fix easy to find

All the "Replace token" buttons below call the existing `navigate('settings', CARD.connection)`, which opens and scrolls to
the card.

- **Add-on sync error** (SyncPage's `ErrorBox`): when the thrown error `isRefusedConnection`, show the plain line and a
  **Replace token** button under the error. `ErrorBox` gains an optional action slot.
- **Settings Accounts refresh error:** same treatment, next to "Refresh from SimpleFin".
- **Home banner for the companion:**
  - It shows when `sync_health` has `firstFailedAt` and `lastError` matches `isRefusedConnection`, unless the connection was
    replaced after the companion's last failure.
  - To know that, the companion adds `lastFailedAt: now` to `sync_health` on each failure. The banner hides when
    `connection_replaced_at > (lastFailedAt ?? firstFailedAt)`.
  - Text: "Background sync stopped: SimpleFIN no longer accepts this connection." plus a **Replace token** button.
  - It disappears for good when the companion next succeeds (`{ lastSuccessAt }` only).
  - `getSyncHealth`'s type widens to the fields it reads.
- **Companion Telegram alert:** when `lastError` is a refused connection, add `REFUSED_CONNECTION_LINE` under the existing
  "failing since" message, escaped. The Home Assistant copy of the alert gets the same line if it is built from the same text;
  otherwise it is left alone.

### Compatibility

- There are no manifest or permission changes, so the in-app Update works.
- `lastFailedAt` is additive. Old add-ons ignore it, and the new add-on falls back to `firstFailedAt` with an old companion.
- The companion already reads the access URL on every sync, so it picks up a replaced connection with no change.
- Ships in the next minor release (1.78.0) under `[Unreleased]`. No version gate is needed.

### Docs

- README: the setup section and the Settings description say how to replace the token.
- CHANGELOG `[Unreleased]` → `### Added`.

## Left to the builder

- Exact file split, component names and test layout, within the repo's conventions.
- Whether `missingMappedAccounts` covers loan links, which depends on how `LoanLinks` is keyed.
- Wording polish that keeps the meaning above.

Tests pin dates (the repo's forced-2027 check). Gates: `npm test`, `(cd companion && npx vitest run)`, `npm run type-check`,
`nice npm --prefix companion run build`.
