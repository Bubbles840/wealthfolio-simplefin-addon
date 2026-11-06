# Alerts to Home Assistant — design

> Draft for review. Everything marked **(my call)** is open to change; the rulings table says what each costs if wrong.

## Why

Many self-hosters already run Home Assistant and route every alert through it (Uptime Kuma, for one, has a Home
Assistant notification provider). Today the only channel is Telegram. This adds Home Assistant as a second channel for
the alerts, beside Telegram, not instead of it.

## What is sent

Alerts only (my call), each as a title and a plain-text message: sync failing, balance drift (young and aged), stuck
transfers, large transactions, unmapped accounts, refused creates and duplicates removed. New transactions imported only
when switched on (off by default, and with or without buys and sells, like Telegram's two switches but its own).

The title is the Telegram alert's own first line (for example "⚠️ Transfer stuck"), and the message is the rest; a
one-line alert (a large transaction) gets a fixed title. So the titles cannot drift from the Telegram wording.

Not sent: the daily, weekly and monthly reports, subscription news, and anything with buttons. They are long Markdown
written for Telegram, and their buttons only work there.

The message text comes from the same `shared/telegram.ts` formatters as Telegram, run through one Markdown-to-plain-text
step, so the two channels never say different things.

## How it reaches Home Assistant

Two ways, picked in Settings:

- **Notify service**, as Uptime Kuma does: `POST <url>/api/services/notify/<service>` with a long-lived access token and
  `{ title, message }`. The person enters the URL, the token and the service (for example `notify.mobile_app_my_phone`).
- **Webhook**: `POST <webhook url>` (Home Assistant's `/api/webhook/<id>`), no token, with
  `{ title, message, source: "simplefin-sync", kind, id }`. An automation on the Home Assistant side decides where it
  goes, so a setup that routes every service's alerts through one automation can branch on `source` and `kind`.
  Home Assistant answers an unknown webhook id the same as a known one, so only Send a test shows a wrong id.

A config stored without a mode is the notify service.

Two optional settings shape every alert: a **title prefix** (for example `[Wealth]`), and **Wealthfolio's address** as
the phone reaches it. With an address, each alert carries a tap link into the add-on, sent as `url` to a webhook and as
`data.url` / `data.clickAction` to the notify service (the iOS and Android companion apps): a large transaction opens
Home on its story (`?tab=home&story=<activity id>`), a new account opens Settings, everything else opens Home. Links are
stored relative and made absolute when sent, so changing the address needs nothing requeued.

## Who sends it: the companion, through an outbox

An add-on can only reach the hosts in its manifest, and a Home Assistant address is different for every install. So
only the companion talks to Home Assistant.

- **One queue per writer**: the companion writes `ha_outbox` (its own pending entries, plus what was delivered), the add-on
  writes `ha_outbox_addon`. Each is a list of `{ id, title, message, createdAt }`, appended when Home Assistant is set up.
  The companion reads both and never writes the add-on's key, and the add-on drops what `ha_outbox` says was delivered, so
  neither writer can overwrite what the other queued.
- **The companion drains it** on its own short schedule (every 5 minutes, my call), so an alert raised by an in-app
  sync arrives within minutes, not at the next 6-hourly sync. A delivered entry is removed; a failed one stays for the
  next pass.
- **Deduplicated by `id`**, built from what the alert is about (for example `drift:<account>:<phase>:<day>`,
  `largetx:<tx id>`), so the two writers queueing the same alert send it once. Delivered ids (and, for alerts a sync
  re-reports every run, such as refusals and unmapped accounts, their per-item keys) are remembered for 30 days in the
  same secret, so a re-reported alert is not sent again.
- **One drain at a time, merged on write**: the companion's after-sync drain (not awaited, so a slow Home Assistant never
  holds the sync) and its 5-minute drain share one in-flight run, and a drain re-reads `ha_outbox` before writing it back.
- **Bounded (my call)**: the drain sends the 50 newest, and drops (and counts, in the status) an entry older than 7 days.
  An entry dated in the future (a fast clock) counts as queued now.
- **Failures**: a 401/403, a notify 400/404, a webhook 404/405 or any redirect parks delivery until the access fields
  (mode, URL, token, service) change, or a test the drain has not tried yet is queued (tracked by id, never by comparing
  the browser's clock with the companion's). Redirects are never followed. A 5xx or a network error backs off from 5
  minutes, doubling, up to 4 hours; a change to those fields ends the wait, and the card says the change is unchecked.
- **Two memories, one horizon**: the add-on drops its own entries after 7 days, and the drain ignores add-on entries
  older than its 30-day memory of what it sent, so a long-delivered alert can't come back as pending. Stored errors name the kind of failure (timed out,
  connection refused, host not found, certificate problem), never fetch's message, which can carry the URL.
- **Quiet when unused**: without Home Assistant set up, the 5-minute drain reads the config once per 15 minutes, and never
  signs in again or logs.
- **Independent of Telegram.** The Telegram ledgers (`alerted` flags, the large-transaction outbox, the daily-report
  folding) are unchanged. An alert is queued for Home Assistant whether or not Telegram delivered it, and whether or not
  the daily report will carry it.

## Settings

A "Home Assistant" card under the Telegram cards in Settings, with its own Save: URL, token, notify service, the import
switches, on/off, and "Send a test", which queues a test alert (and says when Home Assistant is off, or the queue can't be
written). Only an http(s) URL with a host and no credentials is accepted, by both halves. The companion records a status
(last delivery, last error, parked or backing off, alerts dropped) inside `ha_outbox`, in the same write as what it sent,
after a drain that sent or dropped something; the section shows it, so a wrong token or service is visible without
reading container logs. One write means the two never fall out of step. A pass sends nothing unless a save just before
it succeeds, so while saves fail nothing goes out; if the save after sending fails, the next pass sends that pass's
alerts again, once. Reset clears all three secrets.

The section only appears when the companion understands it (`HOME_ASSISTANT_SINCE` in shared/version.ts): with an
older companion, nothing would drain the outbox.

## Rulings

| Ruling | If wrong |
|---|---|
| Alerts only, no reports | Reports can follow in a later PR; nothing here blocks them. |
| Notify service and webhook | Two request shapes to keep working; the outbox is the same for both. |
| 5-minute drain | An add-on-raised alert waits up to 5 minutes (15 right after first setup). Shorter costs one secret read per tick. |
| Import notices off by default | Someone who wants them ticks one box. |
| 50 entries / 7 days | Older alerts are lost if Home Assistant is down for a week. |
| Queue regardless of Telegram | Someone with both gets each alert twice, once per channel. That is the point of two channels. |
