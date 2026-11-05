# Privacy

SimpleFin Sync runs entirely on hardware you control: the addon inside your
Wealthfolio instance, and — if you choose to run it — the companion container
on your own machine. **Nothing is sent to the author of this addon, and there
is no analytics or telemetry of any kind.**

Your financial data does leave your device in one direction that matters: this
addon exists to fetch it from SimpleFIN, and it can optionally send summaries
of it to Telegram and read an email inbox. Those are described below.

## What the addon reaches, and why

Every host is declared in `manifest.json`, and Wealthfolio's addon sandbox
enforces that list — the addon cannot reach anything else.

| Service | Required? | What is sent | What comes back |
|---|---|---|---|
| **SimpleFIN Bridge** (`bridge.simplefin.org`, `beta-bridge.simplefin.org`) | Yes | Your SimpleFIN access credentials, as HTTP Basic auth | Account balances and transactions for the accounts you linked at SimpleFIN |
| **Lunch Flow** (`lunchflow.app`, `*.lunchflow.app`) | No — only if your setup token came from Lunch Flow instead of SimpleFIN Bridge | Your Lunch Flow SimpleFIN access credentials, as HTTP Basic auth | Account balances and transactions for the accounts you shared with that Lunch Flow destination |
| **Telegram Bot API** (`api.telegram.org`) | No — only if you configure it | The content of the notifications you enabled: transaction descriptions, amounts, account names, category names, and spending/budget totals | Commands you send your bot |

Your **bank credentials are never seen by this addon**. SimpleFIN's model is
that you authenticate with your bank at SimpleFIN, and hand this addon a
one-time setup token, which is exchanged once for an access URL. That access
URL is stored in Wealthfolio's encrypted secret storage. The token itself is
not retained.

## The companion container (optional)

The companion is a separate program you run yourself, so that syncing and
notifications continue when Wealthfolio is not open in a browser. It reaches
the same two services above, plus:

| Service | Required? | What is sent | What comes back |
|---|---|---|---|
| **Your Wealthfolio instance** | Yes | Its password or API key, and the transactions being imported | Your existing activities and settings |
| **Your mail provider, over IMAP** | No — only if you set up Amazon categorisation | Your mailbox host, username, and app password | Amazon order-confirmation emails |
| **Your model host (Ollama)** | No — only if you set up the receipt reader | Each receipt photo you send the bot, its item names, your spending category names and paths, and the descriptions of up to 40 items you filed before (as examples) | What the receipt says, and a category for each item |
| **Your Home Assistant** | No — only if you set up Home Assistant alerts | Each alert's title and message (which can name an account, a transaction's description and its amount), and with the notify service your long-lived access token | Only whether it accepted the alert |

The mail host is whichever server you configure; this project does not choose
one or route mail through anything. Use a dedicated app password, and if your
provider supports it, one scoped to mail only.

**What the mailbox feature reads and keeps.** It searches for Amazon order
emails, extracts the order total, date, and Amazon's own category label for
the items, and stores those few fields locally so a matching bank charge can
be labelled with the category. It does not read, store, or transmit unrelated
mail, and message bodies are not retained. The records live in Wealthfolio's
secret storage alongside your other settings, and are consumed once matched.

**What the receipt reader sends, and where.** The model host is whichever
address you enter in its settings card; this project does not run one or
choose one. The photo and the category details above go to that host and
nowhere else, so they stay on your own network as long as the host is on
your network. Ollama has no password: give it your home network or Tailscale
address rather than `0.0.0.0`, and never forward its port to the internet.
The companion downloads the photo from Telegram, passes it to the host and
does not keep it; it keeps only Telegram's reference to the photo while the
receipt is waiting to be read.

The companion also reads your `wealthfolio.db` file **read-only**, to count
uncategorised transactions and to fill in category names and budget figures in
its reports.

## What is stored, and where

Everything this addon persists is stored in your own Wealthfolio instance, in
its encrypted addon-secret storage: the SimpleFIN access URL, your account
mapping, transaction rules, notification settings, the Telegram bot token and
chat id, the mailbox settings above, and small bookkeeping ledgers used to
avoid duplicate imports and repeated alerts. Home Assistant alerts add the
Home Assistant address, the access token, and the alerts waiting to be sent.
The receipt reader adds its own:
the model host address, receipts waiting to be read or confirmed, and what it
learned from receipts you filed (item names and their categories, the account
each store's gift card goes to, tax rates, and a fingerprint of each receipt
to flag the same one sent twice).

Nothing is stored anywhere else. Removing the addon and running **Reset** in
Advanced clears all of it.

## Third-party policies

This addon's use of those services is governed by their own terms, not this
document:

- SimpleFIN — <https://www.simplefin.org/>
- Lunch Flow — <https://www.lunchflow.app/>
- Telegram — <https://telegram.org/privacy>
- Your mail provider — whichever you configured

## Questions

Open an issue at
<https://github.com/Bubbles840/wealthfolio-simplefin-addon/issues>.
