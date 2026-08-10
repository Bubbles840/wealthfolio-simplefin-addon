# Telegram commands: ask the bot, get an answer

Date: 2026-08-09. Approved by Nick against the decisions below. Ships as v1.11.0.

## Why

The bot already talks — scheduled digests, alerts, an import notice with dismiss
buttons — but it does not listen. Regenerating a report after recategorizing,
checking what is left in a category, or asking "can I afford this?" all require
opening the addon. Nick wants to type at the bot and get an answer in seconds.

Explicitly NOT in scope: AI. Wealthfolio's AI assistant is wired into its in-app
chat only — no API, no headless mode, nothing an external tool can call — so it
cannot be bridged to Telegram (verified against its docs 2026-08-09). Our own
LLM layer is deliberately deferred: every question Nick actually asked for has a
deterministic answer that arrives instantly and costs nothing. The command
handlers built here become the tool set an LLM would call if free-form questions
ever justify one. Also deferred: tap-to-categorize from Telegram — its own build,
next, because it needs a write-path investigation (the companion's database mount
is read-only by design); it will plug into the listener this build creates.

## Decisions

1. **Slash commands + registered menu** — not buttons, not plain-English
   matching. Commands are registered via `setMyCommands` on startup, so
   Telegram's ☰ menu lists them all with descriptions; nothing to memorize.
   Bonus: bots in groups see only `/`-prefixed messages under default privacy
   mode, so slash commands need no bot-settings changes.
2. **Six commands**: `/report`, `/left`, `/afford`, `/status`, `/sync`, `/help`.
3. **`/report` is instant, from the database.** It reflects recategorizing just
   done; bank data is as of the last sync and the footer says so. `/sync` exists
   separately for the times new charges are actually wanted.
4. **Same container, no new services.** The listener lives in the companion
   process. Nick's standing constraint.

## The listener (the one architectural change)

An always-on **long-poll loop** in the companion: `getUpdates` with a ~50s open
timeout, replying near-instantly, restarting with capped backoff on any error.
Telegram permits ONE update consumer per bot, so the listener becomes the single
owner of the stream and of the `telegram_update_offset` secret:

- **It takes over the import notice's Dismiss buttons.** `sendImportNotice`
  stops polling entirely; button taps land in the dismissal ledger within a
  second of the tap (today they wait up to 6 hours for the next sync to collect
  them). The pre-sweep "collect presses first" step becomes unnecessary — the
  ledger is simply current. Ledger writes go through `mergeDismissals`, so the
  listener and a concurrent sync cannot clobber each other (the 1.10.1
  guarantee).
- A 409 from Telegram (a second consumer somewhere) is logged in words that say
  what it means, since it looks like "the bot ignores me" from outside.
- Runs only when Telegram is configured; re-reads the Telegram config secret
  every 60 seconds while idle, so configuring or deconfiguring in the addon
  takes effect within a minute, no container restart.

**Authorization:** only messages from the configured chat id are honored.
Anything else advances the offset and is dropped (logged once per sender, not
per message). Commands arrive as `/cmd`, `/cmd args`, or `/cmd@BotName args` —
all handled.

## The commands

- **`/report`** — today's spending digest, exactly the scheduled 8am format,
  built fresh from the database. Footer: `Data as of last sync, <ago> —
  /sync to pull new charges.`
- **`/left`** — one line per budgeted parent category: week envelope remaining +
  month remaining, same math (`weekEnvelope`) and state glyphs as the digest.
  `/left <text>` narrows by case-insensitive prefix match on parent categories;
  an ambiguous prefix lists the matches; a category without a budget reports its
  spend and says there is no budget to be over.
- **`/afford <amount> <category>`** — before/after for week envelope and month
  remaining, then a verdict: fits this week · fits the month but blows this
  week's allowance · over budget for the month. Amount accepts `20`, `$20`,
  `20.50`. Missing/garbled arguments get a usage line, not a shrug.
- **`/status`** — companion version; last sync time and outcome; per-account
  balance with in-sync / drift / not-checked (same states as the addon);
  needs-a-category count; the Amazon unread-mail warning when it is non-zero.
- **`/sync`** — replies `Syncing…`, runs the same forced sync as the addon's
  Sync Now, then replies with the outcome (imported/skipped, drift found). If a
  sync is already running (scheduled or another `/sync`): `Already syncing` and
  no second run — one mutex shared with the scheduler.
- **`/help`** — the six commands, one line each. Also the reply to any
  unrecognized `/command`, prefixed with `Unknown command.`

Any handler error → one short apologetic reply + the real error logged. The
listener never dies with a command.

## Where the code lives

- `shared/telegram-commands.ts` — parsing (`parseCommand(text, botName)`) and
  every reply FORMATTER, as pure functions taking plain data. Host-agnostic,
  tested without a network or database, beside the existing report formatters.
- `companion/src/telegram-listener.ts` — the long-poll loop, offset ownership,
  authorization, dispatch. Transport injected (same pattern as
  `pollTelegramDismissals`, which it replaces).
- Handlers wire formatters to existing data sources: digest builder,
  `weekEnvelope`, native budget/spend queries, balance/uncategorized/Amazon
  secrets, the sync entry point. Roughly 90% of reply content is reuse.
- `companion/src/index.ts` — start the listener beside the cron scheduler;
  remove the poll from `sendImportNotice`.

## Testing

- Parser: every command form, `@BotName` suffixes, junk, non-commands.
- Formatters: golden replies for each command from fixed inputs, including the
  ambiguous-category and no-budget cases and the `/afford` verdict boundaries.
- Listener (injected transport): dispatches only for the configured chat,
  advances offset past foreign messages, applies a dismiss tap to the ledger via
  merge, survives a transport error and resumes, reports 409 distinctly.
- Sync mutex: `/sync` during a running sync does not start a second one.
- Import notice: no longer polls; dismiss keyboard still renders.

## Ship

v1.11.0. Functionally companion-only; the shared version bump keeps both halves'
version strings matching, so the usual rsync + docker build + one-service
restart, plus a zip reinstall for the version string. Inactive unless Telegram
is configured — every other install behaves exactly as before.
