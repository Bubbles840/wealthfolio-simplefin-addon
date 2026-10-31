# Receipts read by a local model — design

> Draft for review. Everything marked **(my call)** is open to change; the rulings table says what each costs if wrong.

## Why

A charge from a store that sells many kinds of things lands as one row in one category, so groceries, clothes and gifts
bought together are all filed as whichever one the rule picks. Splitting it by hand means reading the receipt, adding
up the lines per category and sharing out the tax. The same is true of orders paid by gift card, which never reach the
bank feed at all and today have to be typed in.

This lets the person send a photo of a printed receipt, or a screenshot of an online order, to the Telegram bot. A
vision model running on their own hardware reads it, the companion does the arithmetic, and the bot proposes the rows
for the person to confirm.

## What the model does, and what code does

The model only **transcribes**: each line's text and amount, the tax flag printed beside it, discount lines, subtotal,
tax, total, and each payment method with its amount. It is asked for this through a JSON schema (`format` on Ollama's
`/api/chat`, temperature 0).

Code does everything that is arithmetic, because tests showed the model gets it wrong when asked:

- **Discounts** are applied to the line they name (a discount line refers to its item by number), so a discounted
  taxable item is taxed on the discounted price.
- **A "number / number" line** is a discount on the item with the second number, whatever kind the model gave it.
- **Checks**: the lines add up to the subtotal, and items plus charges plus tax equal the printed total plus any gift
  cards. A receipt that fails a check is not written; the bot says which check failed.
- **Which items were taxed** comes from the receipt itself, never from a flag letter alone (a model copies letters
  printed before an item number as if they were flags):
  1. A printed tax line with a rate ("A 8.5% TAX 4.25") names the letter and the rate; it is used when that rate on
     the lettered items gives the printed tax.
  2. An order page prints no rate. The reader remembers the rates earlier receipts printed and looks for the one set
     of items whose tax at such a rate is the printed tax. More than one set fitting counts as none.
  3. Otherwise the tax is shared over every item, and the proposal says so.

  A rate is never looked up from an address: rates are set per district and change often, and a lookup service would
  send the address out.
- **Tax and charges are shared out** in proportion, in integer cents (largest remainder), so the rows add up to the
  total exactly.
- **Signs**: amounts are read as magnitudes; a model's minus sign on a gift card or discount is ignored.
- **Only printed numbers are asked for**: an order paid partly by gift card prints the gift card and what was left to
  pay, not the total before the gift card, so the model copies those two and code adds them.

Money is integer cents throughout, never a float.

## Categories

An item the person confirmed before is filed as they filed it last time, without asking the model. For the rest, a
second, text-only model call **(my call)** maps each item's text to one of the person's spending categories. The
schema lists the category keys as an enum, so the answer is always a real category; the prompt includes the category
paths and a few of the person's recently categorized descriptions. Items are then grouped: one proposed row per
category, each with its share of the tax.

The bot shows the groups ("Groceries $42.10: bread, eggs, …") with Confirm, Change a category and Cancel. Changing a
category moves one item; the totals are recomputed and shown again. An item the model could not place shows as "Needs a
category", and Confirm waits for it. Nothing is written before Confirm.

## Where the rows go

By what paid for it, from the payment lines:

- **A card or bank account**: the companion looks for the charge already imported: same total, a date within 3 days
  **(my call)**, on an account in the spending set. Exactly one match → it **splits** that charge by category through
  Wealthfolio's split API (`PUT /api/v1/spending/activities/{id}/splits`), the same lines a person makes by hand. More
  than one → the bot asks which. None yet (the charge is often still pending) → the confirmed receipt waits and is
  matched on each later sync for 7 days **(my call)**, then the bot asks.
- **A gift card or store credit**: one WITHDRAWAL per category in the cash account that tracks that card, dated on the
  receipt's date, with the item names in the note. The first time a store's gift card is used, the bot asks which cash
  account tracks it (a button per cash account) and remembers the answer by store name. With no such account, it asks
  the person to create one rather than creating it itself.
- **Both**: the receipt does not say which items the gift card paid for, so every payment gets the same category mix,
  in proportion to what it covered (largest-remainder cents, so each side still adds up exactly).

A payment line of $0 is ignored. Loading a gift card and a refund back onto one stay manual in this version.

A charge that already has splits is never re-split without asking. A split charge counts as categorized (PR #52), so the
needs-a-category list and the order-email filing leave it alone.

The Done message carries an Undo button for 7 days: it removes the gift-card rows, and takes the splits off the charge
and puts back the category it had before. The change log's own Undo does not cover receipts yet; that is a separate
piece of work, as the change log has no entry kind for splits.

## Who reads it: the companion, through a queue

The model runs on the person's own computer, which may be asleep, and an add-on can only reach the hosts in its
manifest. So only the companion talks to the model.

- **The listener accepts a photo or an image file** from the configured chat (today it only takes text and buttons).
- **It queues the Telegram `file_id`**, not the image, in a `receipt_queue` secret, and replies "Reading it…". Nothing
  is stored on disk; the image is downloaded from Telegram when it is read.
- **A reader drains the queue** one receipt at a time. If the model host does not answer, the entry stays and the bot
  says once that it will read it when the computer is back; it retries every 5 minutes **(my call)**. An entry older
  than 7 days is dropped with a message.
- **A slow model is expected**: reading takes one to two minutes with the default model, so the request timeout is
  5 minutes **(my call)**.
- **The same receipt twice**: a receipt whose date, total and payments match one already confirmed is flagged before it
  is proposed.

## Settings

A "Receipt reader" card in Settings, with its own Save: the model host URL (for example `http://192.168.1.20:11434`),
the vision model (default `qwen2.5vl:32b`) and on/off. Every 5 minutes the companion calls the host's `/api/tags` and
writes `receipt_status` (`{ checkedAt, error }`) when the answer changes, and hourly otherwise; the card shows it, so a
wrong address or a model that was never pulled is visible without reading container logs. The card notes that Ollama listens only on its own machine
unless started with `OLLAMA_HOST=0.0.0.0`, and that it has no password, so it should only be reachable on a home
network.

The card only appears when the companion understands it (a new `RECEIPTS_SINCE` in shared/version.ts).

## Rulings

| Ruling | If wrong |
|---|---|
| Model transcribes, code computes | More code than asking the model for totals; the checks are needed either way. |
| Tax from printed rates, remembered for order pages | An order shipped somewhere the person never shopped in person gets its tax shared over every item. |
| Default model `qwen2.5vl:32b` | ~21 GB of memory while reading and 1–2 minutes per image; the 7B model is faster but needs more cleanup. Either is a setting. |
| Second model call for categories | One more call per receipt; history-only matching would ask about every new item. |
| Split the imported charge rather than add rows | Needs Wealthfolio's split API (3.8+); adding rows would double-count spending. |
| 3-day match window, 7-day wait | A charge posting later than a week is asked about instead of matched. |
| Queue by `file_id` | A `file_id` stays usable; only the download link `getFile` returns expires (after an hour), so it is fetched just before reading. |
| Ollama's API only | An OpenAI-compatible endpoint can be added beside it; the transcription schema is the same. |
