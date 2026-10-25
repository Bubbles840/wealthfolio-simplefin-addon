# SimpleFin Sync for Wealthfolio

Import your bank and credit-card transactions into
[Wealthfolio](https://wealthfolio.app) automatically, via
[SimpleFin](https://beta-bridge.simplefin.org) — a privacy-focused, read-only
bank aggregation service.

Your data goes from your bank to SimpleFin to your own Wealthfolio instance.
Nothing is sent anywhere else, and SimpleFin access is read-only: nothing can
move money.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/cover-dark.webp">
  <img alt="SimpleFin Sync's Home tab: a status strip, then the budget reports" src="assets/cover-light.webp">
</picture>

## Set up in three steps

1. Install the addon in Wealthfolio (**Settings → Add-ons**).
2. Open **SimpleFin Sync** in the sidebar and paste your SimpleFin setup token.
3. Pick the Wealthfolio account each bank account writes into.

That's it: saving the mapping runs the first sync and turns on auto-sync every
6 hours. Rules, the Telegram bot and Amazon categorization are optional, and
live in **Settings** when you want them.

You need Wealthfolio **3.8 or newer** (it works with 3.10) and a SimpleFin account with a one-time
**setup token**. The token is exchanged once for a long-lived access URL, kept
in Wealthfolio's encrypted secret storage; the token itself is not kept.

**Using Lunch Flow instead of SimpleFin Bridge?** [Lunch Flow](https://www.lunchflow.app)
runs a SimpleFIN server too: add an **Actual Budget** destination there, and
paste the setup token it gives you in step 2. An add-on installed before it
supported Lunch Flow leaves the Lunch Flow hosts unticked when it updates,
unless you tick them in the update's permission dialog, as Wealthfolio does
with any host an update adds. To tick them later: in **Settings → Add-ons**,
hover over the SimpleFin Sync card and click its eye icon (View permissions),
tick `lunchflow.app` and `*.lunchflow.app` under **Network hosts**, and click
**Save**. Setup tells you so if you forget.

## What you get

The addon has three tabs: **Home**, **Reports** and **Settings**.

- **Home** — "Why is this here?" at the top: find any transaction by a few
  words or an amount and read its story — where it came from, what it is, who
  filed it and every change made to it, with Undo. Then a status strip (last
  sync, accounts, anything that needs you; a needs-a-category row opens its
  story, and shows the category you probably meant when you filed the same
  merchant that way before; a deposit there that pays you back — a friend's
  Venmo for dinner — offers **It's a payback…** (Wealthfolio 3.9 or newer,
  with the companion): pick the spending it pays back and it comes off that
  spending, with Undo in Telegram's `/changes`; with the companion, **Next 30 days** — your cash
  if nothing comes in: cash today, minus your known bills on their dates and a
  typical day of other spending — which opens what it counted),
  then your budget: six reports to start (headline numbers, cash flow or the
  semester-pool burn-down, budget vs actual, top merchants, subscriptions & bills (remind, rename, hide, add by hand)),
  with more a tap away under **+ Add report**, or build your own. Until the
  companion has synced, **Preview with sample data** shows the board over
  made-up numbers, read-only (setup's first step has it too: **See what it
  looks like**).
- **Syncing that gets the money right.**
  - Every SimpleFin account (checking, savings and cards) is imported on a
    schedule, with a catch-up when you open the app.
  - Pending charges are updated in place when they post, never duplicated.
  - A transfer between your own accounts, like a card payment, is linked
    as one movement and kept out of spending and income.
  - A one-time starting balance lands each account on the bank's real
    balance; any difference is flagged with a one-click fix.
  - A loan account (a mortgage or car loan servicer) can be linked to a
    Wealthfolio loan instead: pick the loan under **Loans** in the account
    mapping. Each sync records the servicer's balance as that day's confirmed
    balance, so the loan follows the servicer instead of an estimate. Its
    transactions are not imported (the payments already come in from the
    account that paid them). A balance is written only when it differs from
    the loan's latest recorded one, never onto a loan you closed (or
    confirmed at zero), and never over one you confirmed yourself that day. A
    day's balance you edit but leave the "SimpleFin" note on counts as the
    sync's, so the next sync can replace it; the feed's balance wins from the
    next day either way. Whatever
    the servicer reports is trusted: if it sends a payoff amount rather than
    the principal, that is what the loan shows. A feed showing nothing owed is
    reported, not written, so you can close the loan yourself.
- **Reports** (with the companion) — the daily, weekly and monthly reports
  as they stand right now, plus every edition that was sent. On a Wealthfolio
  server with Web Push, each report is also pushed to your devices. The tab
  counts the editions you haven't opened and marks them New; opening a
  report's tab marks it seen, on every device. In Full detail the monthly
  report for a completed month ends with a month in review: the biggest
  category changes, top merchants, subscriptions that started or rose in
  price, net worth, savings rate (as on the Budget tab), and how many changes
  were made to your books. "No longer charging" names only subscriptions
  found missing their charge near the month's end; ones that stopped earlier
  have already left the subscription list.
- **Telegram bot** (with the companion) — one short daily report: what you
  spent, what's left, and a single "🧹 N things to fix" line with buttons.
  File transactions, check what you can afford and pull charts from the chat.
  `/categorize` offers the category you filed the same merchant under before
  as the first, one-tap choice ("✓ Groceries (like the last 3)"), and a rule
  made from a filing can be for one account only ("Only <account>" on its
  preview; `/newrule trader joes = groceries in checking` does the same).
  A deposit that pays you back — a friend's Venmo for dinner — goes under the
  spending it pays back with **It's a payback »**, and the next screen can
  make every deposit like it a payback; Undo either from `/changes`.
  Commands that need details — `/pool`, `/newrule`, `/afford` — ask for them
  one question at a time; the one-line forms still work. Bare `/pool` shows
  the pool with Set and Clear buttons.
  `/subscriptions` lists your subscriptions and bills — set a reminder before
  a charge, rename one, hide one you cancelled, or add an annual plan by hand —
  and the daily report's "Coming up" lines say what charges soon. In a group chat, answer a question by
  replying to it. `/changes` lists what changed in the last 7 days, with Undo
  or Redo where an entry offers one, and `/changes venmo` searches it.
  `/why kroger 54.20` finds a transaction and tells its story; the 🔎 Why?
  buttons on large-transaction alerts, import notices and the `/categorize`
  screen do the same. `/audit` explains why a balance is off from the bank,
  why the month's spending differs from Wealthfolio's, and what Wealthfolio's
  Health page flags — checked live on every tap; `/status` puts a 🔎 under
  each account that is off. `/forecast` shows your cash over the next 30
  days if nothing comes in, with the bills it counts; the weekly check-in
  carries the same line in Full detail, and the daily report warns when cash
  may run short within two weeks. Health's list offers **Link** on a transfer with
  exactly one likely other half (**Link all** for two or more), and a story
  offers **Remove for good…** for a row the bank reported twice: it goes on
  the skip list and is deleted, so the bank feed never brings it back. Both
  are in the change log, with Undo. `/budgets` suggests a monthly budget for each
  category that has none (your average over the last 3 full months the ledger
  covers, rounded up to the nearest $5) and sets the ones you pick in
  Wealthfolio, never over a budget you already have; Undo any of them from
  `/changes`.
- **Checks** (with the companion) — the same three explanations in the app:
  an account's "off by" chip in **Settings → Accounts** opens why in place,
  the Budget tab's "Why is this different from Wealthfolio?" breaks down the
  month, and **Settings → Checks** lists what Health flags, each with what to
  do, and **Link** for a transfer with one likely other half. They come from a
  snapshot the companion publishes after each sync, and say when it was
  taken; a fix shows there after the next sync. A transaction's story in the
  app offers **Remove for good…** too. The report counts spending the same way
  as Wealthfolio's Spending page does (see the changelog's Known limits), so
  after each sync the two month totals
  are compared: more than a cent apart (after setting aside accounts the
  add-on doesn't sync), the daily report says so (in Brief too) and Home's
  Accounts tile shows it.
- **Change log** — every change the sync, the companion and you made, the last
  90 days, under **Settings → Change log**: imports, bank updates, transfer
  links, removed duplicates, rows you removed for good, starting balances,
  corrections, filings and rules,
  each with why and, where there is one, what it was before. Undo or Redo
  most of it from the entry — no confirmation; a transfer the sync stopped
  waiting on, bank updates, removed pending charges, background bookkeeping
  and accounts created offer nothing.
  Undoing something the sync decided also tells the sync not to decide it
  again (the card's **Your overrides** lists those, each with Remove). Most
  of it happens at once; undoing or redoing a transfer link or hold or a
  transaction rule, and redoing an import, an Amazon label or a removed
  duplicate, take effect on the next sync — Sync now is right there. Category,
  rule and budget changes are undone from Telegram's `/changes`.
- **Amazon categorization** (optional) — reads Amazon's order emails from a
  throwaway mailbox and files each `AMAZON.COM*…` charge under what you bought.
- **Venmo notes** (optional, the same mailbox) — a bank row for a Venmo
  payment gets the payment's note from Venmo's email.
- **Rules** — map a description pattern to a category or activity type when a
  bank's wording needs help. Your rules always win.

## Requirements

- Wealthfolio **3.8 or newer** (works with 3.10). Newer versions unlock more:
  - **3.9 and newer:** the app links and unlinks transfers in place (the
    companion does on 3.8 too), and reads whether a transaction is linked and
    what it is filed under, so its Link, Remove for good… and Undo go by
    Wealthfolio's word, and a transaction's story names its category and the
    other half of its transfer.
  - **3.10 and newer:** a credit card's opening debt, corrections and held
    transfers are Transfer Out, which Wealthfolio's Spending page leaves out on
    its own, with the Docker companion running (the add-on learns the version
    from it); the companion also rewrites the existing ones once.
- A SimpleFin account (or a Lunch Flow one) and a one-time **setup token**
- Optional: Docker, for the background companion (background sync, Reports,
  the Telegram bot and Amazon categorization)

### Upgrading Wealthfolio to 3.10

Before or right after you upgrade:

- If you reach Wealthfolio through a proxy (Tailscale or tsdproxy), set
  `WF_CORS_ALLOW_ORIGINS` to the exact URL you open it at. Otherwise the app and
  the add-on may not load.
- Keep one default profile with no lock. The companion stops with
  `PROFILE_LOCKED` otherwise.
- Keep the database unencrypted (`WF_DB_REQUIRE_ENCRYPTION` off). The companion
  reads it directly.
- After the upgrade, Wealthfolio rebuilds every account's history. Wait until its
  Health page no longer shows a stale projection before running a Deep scan.
- On its next sync, and every sync after, the companion makes sure "Opening
  balances" and "Sync bookkeeping" are excluded from Wealthfolio's spending,
  each once it exists (the sync creates "Sync bookkeeping" the first time it
  has a bookkeeping row to file). Once it has a live database read and the
  1.62 add-on is installed, it also rewrites a credit card's bookkeeping
  withdrawals as Transfer Out, once (it clears their phantom `$CASH` asset and
  leaves rows in a transfer group, rows you split, retyped or filed yourself,
  a real security, and a starting balance whose opening-balance filing you
  undid).

### Updating the add-on to 1.62.0

1.62.0 asks for new permissions, and Wealthfolio's **Update** button refuses an
update that does. Install 1.62.0 over the installed add-on with **Install from
File**, without removing the old one first, and approve them: linking and
unlinking transfers, reading how Wealthfolio files and links each transaction,
your spending categories' names, and making, running and deleting the one-off
rule that files a payback from the app. Your settings stay.

Upload the add-on zip before the companion, or together with it. The
companion's two one-time passes, the date repair (see "Date repair" below) and
the card rewrite above, wait for the 1.62 add-on when the companion can see
the installed add-on; when it can't, they run at once. Then reload any browser
tab still running 1.61: until it is reloaded it keeps writing bare dates,
writes a card's bookkeeping as withdrawals, and turns a payback back into a
deposit.

### Adding or removing accounts later

Accounts you link at your SimpleFin bridge *after* setup are not synced until
they are mapped, because a mapping is what tells the sync which Wealthfolio
account to write into. Map them under **Settings → Accounts → Edit mapping**: it reads the
live account list from SimpleFin and lets you map each one to an existing
Wealthfolio account or create a new one. Nothing else you have configured is
touched — there is no need to run setup again.

Clearing an account's selection stops syncing it. Transactions already imported
into Wealthfolio stay; delete the Wealthfolio account itself if you want them
gone.

The addon does not let a newly-linked account go unnoticed: Home shows
a banner naming any SimpleFin account nothing is mapped to, and the companion
names it in the daily Telegram report (or, with the daily report off,
sends one notice per account the first time it sees it).

## How it works

### Syncing

A sync runs when you open Wealthfolio, on your chosen interval while a tab is
open, and whenever you press **Sync now**. A one-hour minimum interval acts as
a cooldown, so reloading the page is a cheap no-op.

Each run re-scans a two-week overlap rather than only new transactions, because
card purchases often post days later with a backdated timestamp. Transactions
are matched by their SimpleFin id, so re-scanning already-imported rows changes
nothing.

### Transfers, card payments & refunds

- Transfers between two mapped accounts (for example, paying a credit card from
  checking) are matched on equal amounts, opposite signs, within five days, and
  imported as a linked Transfer Out / Transfer In pair — excluded from both
  spending and income. Wealthfolio links the two rows itself wherever it can,
  so they keep their ids and categories.
- Positive amounts on a credit-card account import as **Credit** (a refund,
  netted against spending) unless they look like a card payment — "payment",
  "autopay", "thank you", "e-pay" — which become Transfer In.
- Cash-transfer legs are deliberately imported with **no asset**, which is what
  lets Wealthfolio book the cash movement and pair the two legs. See
  `companion/upstream-pr.md` for the underlying upstream issue.

### Ignore rules

Some accounts report money moving *inside* the account as ordinary rows. A
brokerage cash account, for example, lists both sides of every sweep into and
out of its core fund as separate rows.
Wealthfolio's Transactions mode treats every row as cash moving, so those rows
never cancel and the account's value climbs far above the bank's balance.

**Settings → Categorizing → Ignore rules** tells the sync never to import rows
whose description contains (or, as a regular expression, matches) a pattern.
Each rule applies to one account you pick, or to all synced accounts if you
choose that.
**Preview last 30 days** shows what a rule would catch before you save it (it
uses one SimpleFin download). Ignore only rows that net to zero inside the
account: ignoring a real payment makes the balance differ from the bank's by
that amount, and the balance-drift alert will say so.

A rule never removes rows that are already imported. After adding one, delete
the old rows it covers in Wealthfolio, sync, and fix the balance. An empty
pattern, or a regular expression that matches an empty description, is never
saved, and the sync ignores one it finds stored. A Docker companion obeys the
same rules once it is updated to the same release as the add-on.

### Dividends on their security

A dividend whose bank text names the security is booked as a Wealthfolio
**Dividend** on that holding, so the Income page shows which one paid it. Only a
known wording counts (today Fidelity's `DIVIDEND RECEIVED … (VOO) (Cash)`), only
in an investment account, and only when exactly one security under that ticker
is found: in the account's holdings; or, for a position already sold, in the
account's own earlier activity (a dividend, a trade); or in its holdings
snapshots from the weeks before the dividend. Anything else is imported as
before. A transaction rule wins, as always: a rule typed **DIVIDEND** books the
security the same way, or **Interest** when none is named (a Dividend needs one:
written on cash, Wealthfolio makes up a `$CASH` security to hold it). A booked
dividend stays on its security on later syncs. Naming a security starts once the
add-on and the companion are both on 1.69.0 or later. To add your bank's
wording, add an entry to `DIVIDEND_PATTERNS` in `shared/dividends.ts` with its
real text in the test.

### Starting balances

On an account's first sync the addon reads its current balance from
Wealthfolio's valuations API and adds a one-time correction, so the account
lands on its real bank balance. For a brand-new account the valuation is
computed asynchronously after the first import, so the addon polls briefly and
applies the correction in the same run.

If a later wide re-scan recovers transactions older than that entry, the
baseline is adjusted by their total — otherwise those transactions would be
counted twice, once in the baseline and again individually — and moved to the
day before the earliest transaction, so the account's history never dips
below zero.

A credit card that started out owing money gets its opening debt as a
Transfer Out on Wealthfolio 3.10 and newer (the companion reads the version itself; the add-on needs a companion that
synced in the last two days), which its Spending page leaves out. Before 3.10 it is a
withdrawal, the only money-out type Wealthfolio accepts on a card; the Docker
companion files it under an **Opening balances** spending category and
excludes that category from spending, so Wealthfolio's Spending page does not
read it as a purchase. On Wealthfolio 3.9 and later it does the same for the
sync's other bookkeeping rows that Wealthfolio would count as spending (a
transfer waiting for its other half, a balance correction, a cash account's
negative starting balance) under **Sync bookkeeping**, and takes a row back
out once it stops being bookkeeping. That pass has no Undo; to keep a
bookkeeping row counted, file it under another category, which it never
touches. It never touches a row with split lines either.

### Date repair (upgrading to 1.62)

New rows are written at noon UTC on the bank's date, and the companion moves
rows already stored at midnight UTC the same way, once, in small batches. It
waits for the 1.62 add-on: see "Updating the add-on to 1.62.0" above for the
order. It leaves linked transfers and rows with a type override alone, and
touches only the accounts the add-on syncs. It reads the database live only,
so it waits when the database can only be read as a snapshot. The repair
resumes on its own on the next sync if interrupted. To run it again, delete
the `date_repair_done` secret.

### Deep scan

**Deep scan** (the header button; "reconcile & link" in the logs) re-scans a
wider window (about 90 days) to recover transactions an earlier sync missed,
re-checks each account against its SimpleFin balance, and links any transfer
pairs that aren't yet linked.

Two optional toggles:

- **Auto re-scan** (`auto-heal` in the logs) — run the wide re-scan on every
  sync. Balance corrections stay manual.
- **Aggressively auto re-scan** — additionally insert balance corrections
  automatically, at most one per account per day.

Balance corrections are written as a spending-neutral `CREDIT`, so they move
the balance without appearing as income or as spending in your budget.

### Background sync & Telegram notifications

Wealthfolio addons run while a browser tab is open. If you want data to
refresh automatically without keeping a browser tab open, or receive real-time
Telegram import alerts and native Spending Tracker budget breakdown reports,
run the optional companion container:

```bash
docker pull ghcr.io/bubbles840/wealthfolio-simplefin-sync:latest
```

The companion runs on the exact same shared sync core as the in-app addon. Account
mappings and credentials are configured directly in Wealthfolio via the addon UI,
so the companion container runs as a lightweight background daemon. Add it to the
`docker-compose.yml` that runs Wealthfolio (alongside it: merge the snippet's
`services:` and `secrets:` into that file's, don't duplicate them), put Wealthfolio's password in
`wealthfolio_password.txt` beside that file (readable by the container: `chmod 644`), and run `docker compose up -d`. The
addon's **Settings → Background sync (Docker)** card shows the same service with
your timezone filled in, and a Copy button:

```yaml
services:
  simplefin-sync:
    image: ghcr.io/bubbles840/wealthfolio-simplefin-sync:latest
    restart: unless-stopped
    environment:
      - WEALTHFOLIO_API_URL=http://wealthfolio:8088   # Wealthfolio's service name and port
      - WEALTHFOLIO_PASSWORD_FILE=/run/secrets/wealthfolio_password
      # Or sign in with an API key instead of the password:
      # - WEALTHFOLIO_API_KEY=your_api_key
      - WEALTHFOLIO_DB_PATH=/mnt/wealthfolio/wealthfolio.db
      - TZ=America/New_York   # change to your timezone, or every schedule runs on UTC
    secrets:
      - wealthfolio_password
    volumes:
      # The FOLDER holding wealthfolio.db, read-only. A file-only mount hides
      # the -wal/-shm files beside it, so the companion reads stale data.
      - /path/to/wealthfolio:/mnt/wealthfolio:ro
    # Wealthfolio on the host network instead? Uncomment the next line and
    # set WEALTHFOLIO_API_URL=http://127.0.0.1:8088 above.
    # network_mode: host

secrets:
  wealthfolio_password:
    file: ./wealthfolio_password.txt   # Wealthfolio's password, on one line
```

It syncs every 6 hours; add `SYNC_SCHEDULE` (a cron line, e.g. `0 */3 * * *`) to
the environment to change that. `docker-compose.example.yml` is the same service.

Images are published for `linux/amd64`, tagged `:latest` and `:vX.Y.Z`. To
upgrade:

```bash
docker compose pull simplefin-sync
docker compose up -d simplefin-sync
```

Pin `:vX.Y.Z` instead of `:latest` if you would rather upgrade deliberately.
The companion logs its version on startup (`Starting companion v…`), and the
addon shows a banner when the tab, the installed addon and the companion
are different versions, naming the fix (reload, upload the zip, or pull the image).

### Amazon auto-categorization

A bank charge reads `AMAZON.COM*MB3T81` and says nothing about what you bought.
Amazon's order emails name the category, so forwarding those to a mailbox the
companion can read lets it label each Amazon charge automatically:

```
Email:  Order 113-0728509 · 1 Lawn & Garden item · $21.18
Bank:   AMAZON.COM*MB3T81 · $21.18
   →    comment becomes "AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · TRN-…"
   →    Wealthfolio's own rule files it under Housing
```

Set up in the **Amazon categorization** card on the Sync page (three fields).
No extra container: the mailbox is read at the start of each sync, which is the
only moment the data is used.

**Use a separate, empty mailbox.** No email provider offers a per-sender scope —
an app password grants the whole account — so instead of handing over your real
inbox, you add one filter forwarding `auto-confirm@amazon.com` and
`shipment-tracking@amazon.com` to a throwaway address that contains nothing but
receipts. If that password ever leaked, receipts are all it could reach, and you
revoke it by deleting one filter.

**It cannot double-count a purchase.** Order emails never create a transaction —
they only add text to the comment of a row SimpleFin already imported. An email
with no matching charge does nothing and is pruned after 90 days. Where two Amazon
orders share an amount inside the ±5 day window, neither is applied: an ambiguous
match is worse than none, since a wrong category is invisible while a missing one
surfaces in the needs-a-category sweep.

To check it works before waiting on a real order, forward one Amazon email to the
mailbox and run the read-only diagnostic — it marks nothing read and records
nothing, so the real poll still picks the message up:

```bash
docker compose exec simplefin-sync node dist/companion/src/amazon-check.js \
  --host imap.gmail.com --user you@gmail.com --password 'xxxx xxxx xxxx xxxx'
```

A Gmail app password (`myaccount.google.com/apppasswords`, with 2-Step
Verification on) is all the mailbox needs — there is no IMAP setting to enable,
since Google removed that toggle and IMAP is always on. Paste it as Google shows
it; the spaces are removed for you.

Three things trip up almost everyone setting this up:

- **The Gmail filter's _To_ field must be empty.** A filter with your address in
  _To_ matches nothing Amazon sends, so nothing is forwarded and nothing fails —
  the card just never sees an email. The card says so once the companion has
  checked the mailbox and found it empty.
- **Gmail only forwards mail that arrives after the filter exists.** Forward one
  old order email by hand to test, as above.
- **`AMAZON_IMAP_HOST`, `AMAZON_IMAP_USER`, `AMAZON_IMAP_PASSWORD` and
  `AMAZON_IMAP_PORT` in the companion's environment override the card.** Useful
  for keeping the password out of Wealthfolio; confusing if you forget they are
  set and then edit the card.

If the companion cannot sign in to the mailbox, the card shows the error itself
(before 1.57.0 it was only in `docker logs`).

#### Venmo notes

The same mailbox reads Venmo's emails. Add a second Gmail filter — _From_
`venmo@venmo.com`, _To_ empty, **Forward it to** the same address — and a bank
row for a Venmo payment gets the payment's note:

```
Email:  You paid Jane Doe $25.00 · Rent October
Bank:   VENMO PAYMENT 1023 · -$25.00
   →    comment becomes "VENMO PAYMENT 1023 · Venmo: Rent October · TRN-…"
```

A note goes on only when the match is certain: one Venmo payment with the
same amount and direction, the bank row dated from the day before its email
to five days after, and no other bank row in the same sync that the payment
could also be. Two payments of the same amount that week, or two bank rows
that could each be the one payment, mean no note. Only posted rows get one: a
pending row is noted once it posts, and while it is pending no other row gets
the payment it could be. A transfer to your bank gets the note "Transfer to
your bank". A cash-out gets no note when it moves exactly one payment you were
paid: "Sam paid you $40" and "Transfer to your bank $40" in the same week are
two money-in emails of the same amount, so the $40 deposit could be either.
Each note is in the change log, where Undo takes it off and keeps it off.
Wealthfolio's rules read the note when it is added at import, so a rule on
`Venmo: Rent` files those rows. A note added later — the email arrived after
the row was imported, or a pending row posted — reaches the row by an update,
and whether Wealthfolio re-runs its rules on an update has not been checked:
file such a row yourself if it stays uncategorized. With no Venmo mail
forwarded, nothing happens.

Keep the forwarding address private. The companion cannot tell a real Venmo
email from a forged one with a `venmo@venmo.com` From line, so anyone who knows
the address could send mail that writes a "Venmo note" onto a matching bank
row. The note is only text, and a matching amount and date are still needed.

Venmo's email formats are built from its documented wording and have not yet
been checked against real emails. One that does not read stays unread in the
mailbox, and the companion's log counts it (`Venmo mail: … unrecognised`).

**Proton Mail does not work for this**, for two reasons. An alias delivers into the
same mailbox, so credentials for it reach everything in the account — no isolation
at all. And Proton has no plain IMAP: it requires Proton Mail Bridge, which is a
paid, desktop-only app. Use a separate free Gmail or GMX account instead.

To change where a label files, use the dropdown on the Sync page and save — then
re-run the rules script, which re-points the existing rule rather than skipping it.

`companion/scripts/amazon-rules.mjs` needs Node and write access to the database, so
run it in a throwaway container rather than via `docker exec` into the companion —
the companion's database mount is read-only by design. Dry-run first (it is the
default), and **stop Wealthfolio before `--apply`**:

```bash
docker run --rm \
  -v /path/to/wealthfolio-dir:/db:ro \
  -v ~/wealthfolio-simplefin-addon/companion/scripts:/s:ro \
  -v /tmp/labels.json:/labels.json:ro \
  node:22-alpine node /s/amazon-rules.mjs --db /db/wealthfolio.db --labels /labels.json
```

Labels are matched by pattern rather than a lookup table, so a label Amazon
invents next month files itself. Anything unmatched goes to a configurable default
*and* is announced once in Telegram. `companion/scripts/amazon-rules.mjs` inserts
the matching Wealthfolio rules (dry-run by default).

**Itemization is not possible.** Amazon removed item names, quantities and unit
prices from these emails on 2026-07-08; only a category label, a total and an item
count remain. Splitting a charge into per-item rows needs per-item prices, so that
is dead at the source — which is also why category tagging is safe: with nothing
to split, reconciliation is never involved.

## Privacy

- SimpleFin access is **read-only**.
- Credentials live in Wealthfolio's encrypted secret storage and are never
  logged or included in error messages.
- Network access is restricted to the SimpleFin bridge hosts, declared in
  `manifest.json`.
- Amazon categorization is off unless configured, and reads only the mailbox you
  point it at — deliberately a throwaway one holding nothing but receipts.

## Development

```bash
npm install
npm test          # 1,556 tests (plus 703 in companion/)
npm run type-check
npm run bundle    # builds and zips to dist/
```

## License

MIT — see [LICENSE](LICENSE).
