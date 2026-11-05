# Alerts to Home Assistant — design

> Draft for review. Everything marked **(my call)** is open to change; the rulings table says what each costs if wrong.

## Why

Many self-hosters already run Home Assistant and route every alert through it (Uptime Kuma, for one, has a Home
Assistant notification provider). Today the only channel is Telegram. This adds Home Assistant as a second channel for
the alerts, beside Telegram, not instead of it.

## What is sent

Alerts only (my call), each as a title and a plain-text message: sync failing, balance drift (young and aged), stuck
transfers, large transactions, new transactions imported, unmapped accounts, refused creates and duplicates removed.

The title is the Telegram alert's own first line (for example "⚠️ Transfer stuck"), and the message is the rest; a
one-line alert (a large transaction) gets a fixed title. So the titles cannot drift from the Telegram wording.

Not sent: the daily, weekly and monthly reports, subscription news, and anything with buttons. They are long Markdown
written for Telegram, and their buttons only work there.

The message text comes from the same `shared/telegram.ts` formatters as Telegram, run through one Markdown-to-plain-text
step, so the two channels never say different things.

## How it reaches Home Assistant

The notify service, as Uptime Kuma does: `POST <url>/api/services/notify/<service>` with a long-lived access token and
`{ title, message }`. The person enters the URL, the token and the service (for example `notify.mobile_app_my_phone`).

## Who sends it: the companion, through an outbox

An add-on can only reach the hosts in its manifest, and a Home Assistant address is different for every install. So
only the companion talks to Home Assistant.

- **One outbox secret, `ha_outbox`**: a list of `{ id, title, message, createdAt }`. Whichever writer produces an alert
  (the add-on or the companion) appends it, if Home Assistant is set up.
- **The companion drains it** on its own short schedule (every 5 minutes, my call), so an alert raised by an in-app
  sync arrives within minutes, not at the next 6-hourly sync. A delivered entry is removed; a failed one stays for the
  next pass.
- **Deduplicated by `id`**, built from what the alert is about (for example `drift:<account>:<phase>:<day>`,
  `largetx:<tx id>`), so the two writers queueing the same alert send it once. Delivered ids (and, for alerts a sync
  re-reports every run, such as refusals and unmapped accounts, their per-item keys) are remembered for 30 days in the
  same secret, so a re-reported alert is not sent again.
- **One drain at a time, merged on write**: the companion's after-sync drain and its 5-minute drain share one in-flight
  run, and a drain re-reads the outbox before writing it back, so an alert the add-on queued during the sends is kept.
- **Bounded (my call)**: at most 50 entries, and an entry older than 7 days is dropped, so a broken Home Assistant
  setup can't grow the secret forever.
- **Independent of Telegram.** The Telegram ledgers (`alerted` flags, the large-transaction outbox, the daily-report
  folding) are unchanged. An alert is queued for Home Assistant whether or not Telegram delivered it, and whether or not
  the daily report will carry it.

## Settings

A "Home Assistant" card under the Telegram cards in Settings, with its own Save: URL, token, notify service, on/off, and "Send a test", which
queues a test alert. The companion writes `ha_status` (`{ lastOkAt, lastError, lastErrorAt }`) after each drain, and the section
shows it, so a wrong token or service is visible without reading container logs.

The section only appears when the companion understands it (`HOME_ASSISTANT_SINCE` in shared/version.ts): with an
older companion, nothing would drain the outbox.

## Rulings

| Ruling | If wrong |
|---|---|
| Alerts only, no reports | Reports can follow in a later PR; nothing here blocks them. |
| Notify service, no webhook | A webhook option can be added beside it; the outbox is the same. |
| 5-minute drain | An add-on-raised alert waits up to 5 minutes. Shorter costs one secret read per tick. |
| 50 entries / 7 days | Older alerts are lost if Home Assistant is down for a week. |
| Queue regardless of Telegram | Someone with both gets each alert twice, once per channel. That is the point of two channels. |
