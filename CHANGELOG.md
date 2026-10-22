# Changelog

All notable changes to SimpleFin Sync are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Lunch Flow setup tokens (#25).** Lunch Flow runs a SimpleFIN server of
  its own, the one it feeds Actual Budget from. A setup token from a Lunch
  Flow Actual Budget destination now connects like a SimpleFin Bridge one;
  setup used to refuse it with "SimpleFin claim URL must be hosted at
  simplefin.org". The add-on may now reach `lunchflow.app` and
  `*.lunchflow.app`. A new install approves them with the other hosts. An
  add-on updated in place leaves them unticked unless they're ticked in the
  update's permission dialog, as Wealthfolio does with any host an update
  adds. Setup then says where to tick them (Settings → Add-ons, the eye icon
  on the SimpleFin Sync card, Network hosts, Save) instead of showing
  Wealthfolio's bare "host is not approved". Nothing changes for SimpleFin
  Bridge users, and the in-app Update still works.

### Fixed
- **Setup no longer spends the token on a retry.** When the first download
  failed after the token was claimed (SimpleFin unreachable, a host not yet
  approved), Connect claimed the same one-time token again and got "this
  setup token was already used". It now retries with the access URL the
  token already gave; only a different token is claimed.
- **A fresh companion learns transfer names and files bookkeeping (#28,
  @mandishshah).** Wealthfolio answers a secret that was never stored with
  `null`, and the companion read that as the text "null", so both read as
  corrupt on every sync until something else wrote them.
- **Holdings cost is the cost basis divided by the shares (#29,
  @mandishshah).** Some providers send a position's total cost as its
  per-share `purchase_price`, which showed every holding at a near-100% loss,
  and a `0.00` meaning unknown was written as a zero cost, which showed the
  whole value as gain. Snapshots already written keep their cost; the next
  sync's snapshot has the right one.

## [1.66.0] - 2026-10-20

Update the add-on and the companion together: a companion older than 1.66.0
never reads ignore rules, so its syncs keep importing the rows they leave out,
and the app won't add a rule until the companion is on 1.66.0.

### Added
- **Ignore rules: keep a kind of bank row out of the import.** Settings →
  Categorizing → **Ignore rules** leaves out every transaction whose
  description contains (or matches) a pattern, in one account or in every
  synced one. They are for rows that only move money inside one account, like
  a brokerage cash account's sweeps into and out of its core fund. In a
  Transactions-mode account those rows never cancel, so the account's value
  drifts far above its bank balance. **Preview last 30
  days** shows which rows a rule would catch before you save it. An empty
  pattern, or a regular expression that matches any text at all (such as
  `.*` or `.`), is refused, and the sync drops one it finds stored. Rows
  already imported are left alone: delete them in Wealthfolio once, then fix
  the balance. Don't point a rule at one side of a transfer between two of
  your accounts: the other side then pairs with the wrong row or expires. A
  Docker companion has to be updated too, or its syncs import those rows
  again: it must be on 1.66.0 or later, and the app won't add rules until it
  is.

### Fixed
- **An account whose bank sends no currency imports again.** Some providers
  (seen on a retirement plan) send SimpleFin a blank currency, and every row failed
  with "Invalid symbol '$CASH-'". The sync now uses the Wealthfolio account's
  currency (or, failing that, its holdings' when they agree) and never guesses
  one; an account with none anywhere is named once in the sync's errors.
- **An empty transaction rule no longer turns every transaction into a
  deposit.** "+ Add rule" saved a blank Deposit rule at once, and a blank
  pattern matches every description, so money out was imported as money in
  (and a card account refused the sync). A new row is now saved only once it
  has a pattern, and the sync ignores any rule that would match everything (an
  empty pattern, or a regex like `.*`), including one already stored.

## [1.65.0] - 2026-10-19

Update the add-on and the companion together: both decide how a transfer is
typed, and a 1.64 writer beside a 1.65 one retypes the same payment back and
forth on each sync until both are on 1.65.

### Changed
- **A wire or online transfer to someone else counts as spending from the
  start** (issue #13). Money out of a bank account worded only "wire
  transfer", "online transfer", "bank transfer" or "member transfer" was held
  as a transfer waiting for an other half that never came. It is now an
  ordinary withdrawal unless its text names another connected account or
  matches a transfer wording the companion learned. A transfer between your
  own accounts still links when its other half arrives within 5 days; until
  then it counts as spending (and, if large, can raise a large-spend alert).
  Money in, the "PNC Bank" and "Capital One transfer" wordings, cards and
  your rules are unchanged.
- **"Still in transit" says why, every day, and offers a way out.** A
  transfer held 14 days or more names the connected account whose feed is
  behind (or says the next sync settles it), shows in the daily findings
  every day until it settles, and offers **Not a transfer**: in Telegram
  after a confirm, and in Settings → Checks, which now lists these
  transfers. It writes the same override the change log's Undo writes; the
  app re-checks the transaction first and changes nothing if it was linked
  or settled since the checks ran. A marked transfer says so until the next
  sync settles it.

### Fixed
- **A transfer still waiting after 10 days settles even when the bank no
  longer sends it** (issue #13). The give-up only ran on rows in the current
  download, so a leg a lagging feed held past the 14-day re-download window
  stayed "In-transit" forever. Every sync now settles stored placeholders
  outside the download exactly as it settles those inside: ordinary money in
  or out, marked Needs review, unless a connected feed that has not caught
  up still holds it. The first 1.65 sync settles the older stuck transfers
  it can reach (each account's newest 500 rows) at once, so past months'
  spending or income can change; each one waits in Needs review.

## [1.64.1] - 2026-10-19

### Fixed
- **An investment account's holdings are no longer counted twice.** Most
  brokers (Fidelity among them) report the account's *total* value as its
  `balance`. The snapshot wrote that figure as the cash line on top of the
  positions, so a Holdings-mode account showed "cash" equal to the sum of its
  holdings and a total about double the truth. The cash line is now what is left
  of the balance after the positions' market values: zero for a fully invested
  account, the remainder when there is real cash. A balance smaller than the
  holdings is still read as cash alone, and an account whose holdings lack a
  market value (or are priced in another currency) is written as before.
- **A holdings snapshot is never dated ahead of today.** 1.64.0 moved the
  snapshot to the local calendar; it is now also clamped to today, for a feed
  whose timestamp runs ahead of the clock.

## [1.64.0] - 2026-10-19

### Added
- **A transfer between your accounts is held whichever half posts first.**
  The companion learns the bank wording of every transfer it has seen linked
  in the last year (per account and direction, reference numbers left out),
  and both the app and the companion hold the next one as a transfer while
  its other half is on the way: a savings → PNC deposit that lands first, and
  360 Checking's "Withdrawal to 360 Performance Savings". It links when the
  other half posts and, as before, counts as ordinary money in or out marked
  "Needs review" after 10 days. Card accounts, wording made only of generic
  bank words, rows a rule types and stored paybacks are never touched, and
  one "Not a transfer" Undo stops trusting that wording. Without the
  companion nothing changes.
- **Pressing Sync checks every bank account and card.** After the run's own
  saves the app adds up each card's whole history and compares it with
  SimpleFin's posted balance, so a card reads "in sync" or "off by $X"
  instead of "not checked" — even with pending charges, and even when the
  run imported a new charge. The companion does the same, reading the
  database live. This changes the badge only; alerts and corrections work as
  before. A card with a transfer still on its way stays "not checked".
- **SimpleFin is never asked more often than it allows.** Both the app and
  the companion share one record of SimpleFin requests: at most 20 a day,
  5 minutes apart, failed requests included. Automatic syncs (scheduled ones
  and the account-name fill-in) ask at most once an hour and at most 16
  times a day, so a SimpleFin outage can't use up the day and 4 downloads
  always stay for a Sync you press. When the day's 20 are used up, Sync and
  `/sync` say so in one line ("SimpleFin's daily limit is used up — next
  sync at 3:10 PM") and scheduled syncs skip quietly. Setup and Refresh
  accounts may go up to 24. The Sync status and `/status` show
  "SimpleFin: 7 of 20 today".

### Changed
- **No more "Sync anyway".** The one-hour wait no longer applies to Sync,
  Deep scan or `/sync`. Pressed within 5 minutes of the last download, they
  re-check every balance against that download instead of asking SimpleFin
  again ("Balances checked · bank data is from 3 min ago."); a Deep scan then
  says when it can run. "Sync now" in the change log and in a transaction's
  story follows the same 5-minute rule and says so in the same one line.
  Scheduled syncs keep their schedule and the one-hour minimum.
- **The companion's card balances read Wealthfolio's own types.** A row whose
  type you changed in Wealthfolio is now counted the way Wealthfolio counts
  it, so a card with such a row may read differently than before.

### Fixed
- **Evening syncs no longer fail the Robinhood holdings snapshot.** The
  snapshot is dated by your local day; after 8 PM Eastern it used the next UTC
  day, which Wealthfolio refused.

## [1.63.0] - 2026-10-18

### Changed
- **A card payment that names one of your accounts is a transfer from the
  moment it posts.** On a cash account, money out whose bank text names another
  connected account (Citi, Robinhood, Discover…) in payment words (`payment`,
  `autopay`, `e-payment`, `transfer`, `ach`…) is held as a transfer while its
  other half is on the way, instead of asking for a category. It links when the
  other half posts and, as before, counts as spending marked "Needs review"
  after 10 days. A transaction rule or an Undo still wins. Money in is left to
  pairing.
- **A bank's leading reference number no longer splits a merchant.** PNC now
  puts a fresh reference first (`*0082 PAYMENT CITI AUTOPAY …`). Category rules,
  category guesses, subscriptions, the forecast's bills and "Make every …
  deposit a payback" now leave it out, so this month's rule matches next
  month's charge. Rules you already saved are untouched, and anything you hid,
  confirmed, linked or said No to under the old name still applies.
- **A subscription survives a rename and a plan change.** When a merchant
  renames its charge on the same account, at the same price, a month after the
  last one, it stays one subscription under its old name, in the forecast, link
  suggestions and the watch list too. A price that steps
  once and then holds is a subscription at the new price, shown as a rise in
  the month it changes, instead of a bill priced at the old one.

### Fixed
- **"↔ Mark one as a transfer" writes a rule that matches.** The rule dropped
  the bank's punctuation (`WEB-RECUR` became `WEB RECUR`) and kept its leading
  reference, so it matched nothing, or only that one payment. It is now built
  from the bank's own words, the way a category rule is.

## [1.62.0] - 2026-10-15

### Added
- **The report and Wealthfolio are compared after every sync.** When this
  month's spending totals are more than a cent apart, the daily report says
  "The report and Wealthfolio differ by $X this month — /audit explains", in
  Brief and Full, and Home's Accounts tile shows it. $X is the difference
  after setting aside accounts Wealthfolio's Spending page reads that the
  add-on doesn't sync, so those alone are not a warning. It goes away on its
  own once they agree, and a figure that couldn't be read says nothing.
- **The sync's bookkeeping rows stay out of Wealthfolio's spending.** A
  transfer waiting for its other half, a balance correction or a starting
  balance that Wealthfolio would count as spending is filed under a new
  **Sync bookkeeping** category, which the companion excludes from spending
  (Wealthfolio 3.9 and later), and taken back out once it stops being
  bookkeeping. The pass never touches a row that has split lines, or a filing
  it didn't make (it remembers its own in the `sync_bookkeeping_filed`
  secret), and it reads the database live only: when the database can only be
  read as a snapshot it waits. It has no Undo. To keep a bookkeeping row
  counted, file it under another category; the pass leaves that alone. Each
  sync it also makes sure the category is still excluded (a Wealthfolio
  upgrade or reset can drop it from the list), and "Why is this here?" says
  such a row was filed by the sync as bookkeeping, not set by hand.
- **Wealthfolio's own link, on every version the companion supports.** A
  transfer pair is linked through Wealthfolio's own link (the companion's sync
  and Telegram's Link on 3.8 and newer, the app on 3.9 and newer), so both rows
  keep their ids, their categories and their place in the change log. A pair
  whose rows are not already exactly its two transfer legs (a leg stored as
  ordinary money, one carrying an asset, a held transfer, another note, amount
  or day) is re-created as before. So is a pair Wealthfolio refuses to link,
  unless one of the rows is already half of another transfer: that is refused
  with "One of these is already half of another transfer — nothing was
  changed", because re-creating it would delete the other pair's partner. On
  3.8 and 3.9 a pair Wealthfolio says is already linked to each other is kept
  as it is when Wealthfolio itself marked it (both rows marked internal, or a
  sync group); otherwise it is re-created. Undoing a link unlinks it the same
  way, then makes both rows ordinary money in or out. On a 3.8 host that runs
  both writers, the add-on's next sync still re-creates a pair the companion
  linked in place, because its ledger does not know the pair; that is the same
  as 1.61.
- **The app reads Wealthfolio's own facts (Wealthfolio 3.9 and newer).** Link,
  Remove for good… and Undo ask Wealthfolio whether a row is half of a linked
  transfer: they no longer refuse an unlinked transfer as "may be linked", and
  never offer Remove on a linked one. A transaction's story in the app names
  its category, who filed it, and the other half of its transfer, as `/why`
  does. On Wealthfolio 3.8 the app works exactly as before.
- **A card's bookkeeping is a transfer out (Wealthfolio 3.10 and newer).** The
  sync writes a credit card's opening debt, balance corrections and held
  transfers as Transfer Out, which Wealthfolio's Spending page leaves out on
  its own, with no category needed. The companion's sync reads Wealthfolio's
  version itself each sync. The add-on, which cannot ask, uses the version the
  companion publishes, and only while the companion's last successful sync is
  under two days old. Otherwise it writes a withdrawal. The companion also
  rewrites the card rows already there, once: it waits for a live database
  read and for the 1.62 add-on, clears the phantom `$CASH` asset older
  withdrawals carry, and leaves rows in a transfer group, rows you split,
  retyped or filed yourself, rows carrying a real security, a starting balance
  whose opening-balance filing you undid, and any row Wealthfolio refuses
  twice. The change log records what it rewrote and which rows Wealthfolio
  refused; the companion's log names the rest.
- **Paybacks.** A deposit that pays you back for spending — a friend's Venmo
  for dinner — is filed against that spending. In `/categorize`, a posted
  deposit on a bank (cash) account gets **It's a payback »** (it read
  "Spending categories »"), which shows the spending categories; picking one
  re-types the row to a `CREDIT` marked `REIMBURSEMENT` — Wealthfolio takes
  money in off spending only as a `CREDIT` marked refund, rebate or
  reimbursement — and files it: "Filed as a payback under Restaurants — it
  takes $14 off your Food & Dining spending." Interest, dividend, income and
  pending rows get no payback switch and keep the income grid. A new sync
  override, `asReimbursement`, keeps the sync from turning it back into a
  deposit while the bank row is money in on a cash account. **A payback
  stays a payback unless a rule or your own choice changes it:** the sync
  leaves a stored cash money-in `CREDIT`/`REIMBURSEMENT` row as it is when no
  rule and no override decides its type, so a payback you make by hand in
  Wealthfolio sticks too, and removing the override or undoing the
  transaction rule never turns a filed payback into a deposit that is still
  under a spending category. The sync also keeps a payback exactly as it is
  when it cannot read your overrides (it says so in its notes). **Undo and
  Redo are in `/changes`**: Undo takes the override off (a key that held
  another override gets that entry back exactly as it was), makes the row a
  deposit again and takes the category off; Redo does it all again. If the
  category's answer is lost after it landed, the filing is read back and
  counts as done. Refused, each in its own words and with nothing written: a
  transfer, half of a linked transfer, a pending row, a row outside a bank
  (cash) account, a row that is not a deposit or is already a payback, one the
  sync manages, one not from the bank feed, and an unreadable overrides
  document. A step that fails partway says what stands. A payback the sync
  left with no category, which you then filed from `/categorize`, must have
  that filing undone from `/changes` before the payback itself can be undone.
  In the app's **Your overrides** list a Payback is shown read-only, with
  "Undo it from Telegram: /changes" — removing only its flag is not an undo.
  Only when no Undo is behind it (the change log could not be written, or the
  setting was left on a row that is gone) does the row offer **Remove**, which
  takes the flag off and nothing else.
- **Make every <pattern> deposit a payback.** After a payback, the Filed
  screen offers this instead of "Make this a rule": two rules made together —
  an add-on transaction rule (money into that account only, matched on the
  bank's own words, placed first in the list) and a Wealthfolio category rule
  (that account, `CREDIT`s only) that files those paybacks under the
  category. The transaction rule decides only deposits the sync creates from
  now on; a deposit already in your ledger keeps its type, and an in-transit
  placeholder the rule matches keeps its marker. The preview looks back 90 days and says how many other
  deposits read that way: "N already in your ledger, M waiting for a
  category" (file those with **It's a payback »**), or "No other deposit in
  the last 90 days reads that way."; if the count cannot be read it says so
  and the rules are checked again when they are made. It refuses a pattern
  made only of common bank words (DEPOSIT, ACH, MOBILE …; VENMO, CASHOUT and
  ZELLE are fine), a pattern a bank-transfer keyword or one of your transfer
  rules already decides (and one a ledger row typed as a transfer matches),
  and the whole offer when the ledger cannot be read; also an older payback
  rule that sits behind another rule, and a Wealthfolio rule for the same or a
  broader pattern that would win. Both rules are in the change log, with Undo
  and Redo; undoing the transaction rule leaves its paybacks as they are.
- **The rule editor shows a rule's limits** (settings → Transaction rules):
  money in only, one account (by its name) and the `since` day are listed
  read-only on a payback rule and kept when you edit the list; "Test a
  description" honours them: pick the direction and the account to see a
  payback rule apply. Saving refuses to overwrite rules changed elsewhere — "Your rules
  changed elsewhere — reload them first." — so the companion's payback rule is
  never silently dropped.
- **Paybacks in the app** (Wealthfolio 3.9 and newer, with a companion of
  1.62.0 or newer). A posted deposit on a bank (cash) account from your bank
  feed offers **It's a payback…** on Home's needs-a-category list, and in its
  story when Wealthfolio says it is filed nowhere: pick the spending it pays back ("Pick the
  spending it pays you back for.") and **File it**. It becomes a payback as in
  Telegram — the `asReimbursement` override, then a `CREDIT` marked
  `REIMBURSEMENT` — and leaves the list at once: "Filed as a payback under
  Restaurants — it takes $14 off your Food & Dining spending. Undo it from
  Telegram: /changes." The add-on SDK cannot file one transaction, so the
  add-on makes a one-off Wealthfolio rule that matches only that row
  ("Payback (one-off) — <bank words>"), runs Wealthfolio's rules over the rows
  with no category, reads the filing back and deletes the rule; Wealthfolio
  records the filing as a rule's. The rule is made before the row is
  re-typed, so it wins over an older rule for paybacks; if another rule still
  filed it first, the reply names that category. A one-off rule that could
  not be deleted is named, and the next payback from the app tries to delete it again.
  Refused in its own words, with nothing written: a row already filed under
  any category ("take that off in Wealthfolio first" — the add-on cannot take
  a filing off), a category the sync keeps for its own bookkeeping, an account Wealthfolio's Spending does not track, half of a
  linked transfer, a row that changed since its story showed it, and
  everything Telegram refuses. The change log names the category Wealthfolio
  confirmed, and when the entry could not be written the reply says there is
  no Undo. It is not offered on Wealthfolio 3.8, without a companion, or with
  a companion older than 1.62.0, which would turn the payback back into a
  deposit.
- **A payback's story says so**, in the app and in `/why`: "A payback: it
  lowers your spending." instead of "Money in.", and "Filed under Restaurants
  by you, as a payback" — a payback filed from `/categorize` used to read
  "set by hand".

### Changed
- **Updating: Install from File, and the add-on zip first.**
  - **New permissions.** Wealthfolio's Update button refuses an update that
    adds permissions. Install 1.62.0 over the installed add-on with Install
    from File (don't remove it first) and approve: linking and unlinking
    transfers, reading how Wealthfolio files and links each transaction,
    your spending categories' names, and making, running and deleting the
    one-off rule that files a payback from the app.
  - **The add-on zip before the companion, or together with it.** The
    companion's two one-time passes, the date repair (under Fixed) and the
    card rewrite (under Added), wait for the 1.62 add-on ("Date repair waits
    for the 1.62 add-on", "Card bookkeeping rewrite waits for the 1.62
    add-on") when the companion can see the installed add-on. When it can't,
    they run at once, so upload the zip first. Telegram's paybacks wait for
    the 1.62 add-on too (below).
  - **Then reload any browser tab still running 1.61.** Until it is reloaded
    it keeps writing bare dates, writes a card's bookkeeping as withdrawals,
    and turns a payback back into a deposit.
- Built against add-on SDK 3.9.0. It still installs on Wealthfolio 3.8.
- Paybacks need both halves on 1.62.0. Telegram's payback, its Undo and Redo
  and the two-rule offer wait for an installed add-on of 1.62.0 or newer —
  an older one ignores the new override and would turn the row back into a
  deposit — and the app's Change log waits for a companion of 1.62.0 before it
  points a payback's Undo at Telegram ("Update the companion first" until
  then).
- /categorize's list shows every amount to the cent ($14.50, not $15), so it
  matches the payback reply.
- A category Wealthfolio refuses because the row counts as a different kind
  of money than money in or money out (a saving) gets a plain neutral line
  instead of being called money in.
- **The report counts spending the same way as Wealthfolio** (see Known
  limits). The digest's "spent this month", the weekly and pool figures, the Budget tab, budget vs
  actual, suggested budgets and the cash forecast now read one definition —
  Wealthfolio's own: the effective type (a type override wins), the subtype
  and the account type; a linked transfer never; a row filed twice counts
  once, under its earliest filing (split lines win when there are any); a
  category Wealthfolio excludes, and its subcategories, left out; an
  uncategorized refund netted; each row placed in its month by its date in
  Wealthfolio's timezone; only the accounts Wealthfolio's Spending page
  reads. Budgets are keyed as Wealthfolio's budget page keys them, by the
  top-level category, and count only the targets its page lists: category
  targets in the spending taxonomy, not a category excluded from spending (an
  income target no longer inflates "left this month"). Three things now count that used to be left out,
  because Wealthfolio counts them: a charge you dismissed from the
  needs-a-category list (dismissing still keeps it off the list), a charge
  whose transfer's other half is still on its way, and a withdrawal filed
  under a category named "Transfers". On Wealthfolio 3.8, which excludes no
  category, the sync's own bookkeeping rows count too, as they do there.
- **"Why is this different from Wealthfolio?"** now names the one gap left:
  rows on an account Wealthfolio's Spending page reads that the add-on
  doesn't sync (and, for another currency, amounts Wealthfolio converts that
  the report doesn't). A snapshot from an older companion still shows its
  reasons.
- **The card opening-balance filing reads the database live only** (it waits
  when the database can only be read as a snapshot) and re-reads Wealthfolio's
  exclusion list just before adding to it, as the bookkeeping pass does.
- **Telegram's category pickers no longer offer "Sync bookkeeping".**
- **The report cube fails to publish, rather than publishing zeros,** when
  the database can't be read for its spending series, and the comparison
  above says nothing unless the cube was published in the same sync run.
- **Redoing a correction or a starting balance, and moving a starting
  balance back, write noon UTC** when the change log recorded a bare date.

### Fixed
- **A row dated the 1st no longer lands in the month before.** New rows are
  written at noon UTC on the bank's date instead of as a bare date, which
  Wealthfolio 3.8 and 3.9 store at midnight UTC, the previous evening west
  of UTC. On the first sync after the update, the companion moves the rows
  already stored at midnight UTC to noon on the same date, in small batches
  with one entry in the change log. Each batch is re-read right before it is
  written; a linked transfer, a row with a type override, and a row changed
  meanwhile are left alone. A row Wealthfolio refuses is asked twice; if it
  refuses both times it is left at midnight, named in the companion's log and
  listed in the change log, as the card rewrite does. Only Wealthfolio's
  refusal of the row counts (an answer naming it, or a 400 or 422); any other
  failure leaves the repair unfinished, and the next sync carries on. A final
  sweep, on a fresh live read of the database, checks nothing movable is left
  before the repair is recorded. The repair reads the database live only:
  when it can only be read as a snapshot ("Date repair waits: the database
  can only be read as a snapshot"), it does nothing, and a row the database
  read doesn't know yet is never taken for a retyped one.
  If it is interrupted, it resumes on the next sync.
  - **It waits for the 1.62 add-on** ("Date repair waits for the 1.62
    add-on"), because a 1.61 add-on keeps writing bare dates: see the deploy
    order under Changed.
  - **To run it again,** delete the `date_repair_done` secret; the next sync
    checks every row again.
  - **UTC+12 to UTC+14 (Auckland, Fiji, Kiritimati) are worse off.** There,
    midnight UTC is already the bank's day, and noon UTC is the next one: new
    rows land a day late, which 1.61 did not do. The repair itself leaves a
    row alone when noon UTC on its day isn't that day in Wealthfolio's
    timezone, so it doesn't move correct rows there. Writing those zones'
    new rows correctly is open.
- The app's sync no longer re-links, on its next run, a pair whose group id
  Wealthfolio chose itself.
- `/categorize` and `/recategorize` never show Wealthfolio's own error text
  when it turns a category down: a filing, a move or a move's Undo that
  Wealthfolio refuses says so in plain words (money in or out, spending
  tracking off), with the reason in the log. Picking a spending category for a
  deposit used to end there, on Wealthfolio's raw refusal.
- **Link never takes a payback for half of a transfer.** Health no longer
  offers a row the payback setting is on as a transfer's other half, and
  Link (Telegram's `/audit`, the app's Checks card) refuses a payback — the
  setting, or a cash `CREDIT` marked `REIMBURSEMENT` — in its own words: "One
  of these is a payback, not half of a transfer — nothing was linked."
  Re-creating it as a transfer would have lost the payback and its category.
- "Make every <pattern> deposit a payback" says "Undo either rule from
  /changes" only when both change-log entries were written.
- The date repair's and the card rewrite's change-log entries list at most 200
  rows Wealthfolio refused, with the full count beside them.

### Known limits
- The spending definition is Wealthfolio 3.10's. On 3.8 and 3.9 a blank
  type override counts as a type (the row then counts as nothing there), and
  exclusions exist only from 3.9, so the sync's bookkeeping rows count on 3.8.
- The CLI fallback for reading the database prints control characters in
  caret form (display only; the data is unchanged). That depends on the
  sqlite3 version (3.50 and later); older versions print them raw, which the
  note-last layout tolerates.
- A foreign-currency row isn't converted, and the Budget tab's "✓ matches the
  ledger" check compares the cube with the same spending lines, so it checks
  assembly only; the tripwire is the independent check.

## [1.61.0] - 2026-10-14

### Added
- **"Why is this here?" — one transaction's story.** In Telegram,
  `/why kroger 54.20` finds any transaction — words, an amount, or both (a
  number written with `$`, or else one with cents, is the amount; otherwise
  the last number is); bare `/why` asks — and a tap tells its story: the bank feed it came from (or that
  it was added by hand), what it is (spending, money in, half of a transfer
  and with which account, a transfer the sync is holding, a starting balance
  or a correction), its category and who filed it (the rule that matches it,
  you in Telegram, an Amazon email, or by hand), anything you
  told the sync about it, and **What happened**: every change-log entry about
  it, oldest first, each opening its `/changes` entry, where Undo lives. A
  🔎 Why? button on the `/categorize` screen, on large-transaction alerts and
  on import notices (which list that sync's imports) sends the story as a new
  message. In the app, **Home** starts with a "Why is this here?" search, and
  needs-a-category rows and budget drill-down rows open their story in
  place, with the change log's Undo on each history line. Read-only: the
  story explains; changes still go through Undo or `/categorize`.
- Budget drill-down rows carry their transaction and who filed it, so they
  open a story once the companion is updated; rows from an older companion
  stay as they were.
- **Audits without SSH — explain.** The checks that used to need the server's
  `companion/tools` scripts, read-only, in Telegram and the app:
  - **Why a balance is off.** The bank's figure against Wealthfolio's (a
    card's is its whole ledger, pending included), and what makes up the
    gap: pending transactions the bank hasn't posted, transactions newer than
    the bank's figure, a transfer held waiting for its other half, a card
    payment (or transfer) still unlinked, a transfer out Wealthfolio never
    took out of the balance — and whatever none of those explains. Plus the
    starting balance and corrections the balance includes.
  - **Why the month's spending differs from Wealthfolio's.** The report's
    "Spent this month" against Wealthfolio's Spending page, split into the
    known reasons — each a set of rows only one side counts: rows at
    midnight UTC on the 1st (west of UTC), the add-on's own corrections and
    held transfers, excluded categories, rows filed twice, refunds with no
    category — each with its rows, and the rest. Only the accounts
    Wealthfolio's Spending page reads; a linked transfer is never a reason.
  - **What Wealthfolio's Health page flags** of the things the add-on checks:
    incomplete transfer legs (with the likely other half when exactly one row
    fits, both ways), starting balances dated after an account's first
    transaction, and older rows on a `$CASH` asset — each with what to do.
  - In Telegram, `/audit` runs them live on every tap; `/status` puts a 🔎
    under each account that is off. In the app, an account's "off by" chip
    opens why in place, the Budget tab has "Why is this different from
    Wealthfolio?", and **Settings → Checks** lists Health's issues — from a
    snapshot the companion publishes after each sync, which says when it was
    taken and when it is out of date or unreadable. Home's Accounts tile
    points at the checks when there is something to look at.
- **Less filing (R1).**
  - **Venmo notes.** Forward Venmo's emails to the Amazon mailbox (a second
    Gmail filter, `from:venmo@venmo.com`) and a bank row for a Venmo payment
    gets the payment's note: `VENMO PAYMENT 1023 · Venmo: Rent October`. A
    note goes on only when exactly one payment has the same amount and
    direction, the bank row is dated from the day before its email to five
    days after, and no other bank row in the same sync could be that payment
    (a pending one included); it is clipped to 60 characters. Only posted rows
    get one (a pending row gets its note once it posts), and never a transfer.
    A cash-out of exactly one payment you were paid gets none (the payment's
    email and the transfer's are two of the same amount).
    Each note is in the change log; Undo takes it off and keeps it off. Your
    rules can match on a note added at import; one added later arrives by an
    update, and whether Wealthfolio re-runs rules then is not yet checked.
    Venmo's email formats are built from its documented wording and not yet
    checked against real emails: one that does not read is left unread and
    kept.
  - **Guessed categories.** A needs-a-category row whose merchant you filed
    the same way before (at least 2 filings in a rolling 365 days, 80% of them
    in one category) gets a guess. A row you re-filed counts from when you
    re-filed it, a rule's filing from when the rule filed it. A Venmo row is
    guessed by its note only (no note, no guess); bank text made only of
    generic banking words ("POS PURCHASE 1234") gets none; neither does a row
    that takes an income category. `/categorize` offers it as the first button —
    "✓ Groceries (like the last 3)", one tap files it exactly as the grid
    would — and shows it beside the row on the list; the app shows "Probably
    Groceries" under the row. A guess never files anything on its own; Amazon
    rows get none.
  - **Rules for one account.** The rule preview after a filing offers "All
    accounts ⇄ Only <account>", and `/newrule trader joes = groceries in
    checking` opens it for that account. The change log names the account,
    and Redo brings the rule back for it. A category whose own name holds
    " in " still works: `/newrule x = Dine In Out` is that category, for
    every account.
  - **Update the add-on and the companion together.** Undoing a Venmo note
    saves a new override, `noVenmoNote`. An add-on or companion of 1.60.0
    reads the whole overrides list holding it as corrupt, and its sync then
    ignores EVERY override — `keepDuplicate` (the duplicate check may delete a
    copy you chose to keep), `notTransfer` (a pair you unlinked is paired and
    linked again) and `noAmazonLabel` — until the flag is gone (Redo, or 365
    days). So a Venmo note's Undo waits for both halves: the app's asks for a
    companion of 1.61.0 or newer ("Update the companion first"), and
    Telegram's Undo and Redo ask for an installed add-on of 1.61.0 or newer
    ("Update the add-on first — or undo it from the app's Change log.", also
    while the companion cannot tell which add-on is installed). The overrides reader now ignores flags it does
    not know and keeps them, so a later flag will not break this release's
    add-on.
- **Getting started.**
  - **Suggested budgets: `/budgets` in Telegram.** For each spending
    category with no budget, the average of the last 3 full months the
    synced ledger covers (only Wealthfolio's Spending accounts, refunds
    netted out, an excluded subcategory's spending left out) rounded up to
    the nearest $5; categories under $10 a month, excluded categories and
    "Opening balances" are left out. A ledger with no full month yet gets
    "once a full calendar month has synced". Tap a category to leave it out,
    then **Apply all** or **Apply selected**: each becomes a default monthly
    budget in Wealthfolio. An existing budget (other than a cleared $0
    default, which Wealthfolio shows as empty) is never overwritten: the
    budget is read again right before each write, and a
    category that gained one since is left alone and said so. Applying the
    same list again shows "✓ ... (already set)", and one that fails to save
    doesn't stop the rest. Each budget set is in the change log, and Undo
    (from `/changes`) deletes it. In the app, the budget card with no
    budgets says where to get some.
  - **A sample-data preview.** Before the companion has synced, the Budget
    board offers **Preview with sample data**: six months of made-up
    accounts and spending, under a "Sample data — not your money" banner,
    read-only. Setup's first step has **See what it looks like**.
  - **A $0 default budget counts as no budget.** Wealthfolio saves a cleared
    budget as "0" and cannot delete a default, so `/budgets` may suggest for
    such a category and apply over it, and a Redo of a budget set goes over it.
    A this-month $0 target or an unreadable amount still counts as a budget.
- **Planning — the next 30 days, a month in review, and unread reports.**
  - **Next 30 days.** A cash forecast "if nothing comes in": the bank
    balances of your cash accounts, minus your known subscriptions and bills
    on their dates (a monthly one twice when it falls twice), minus a typical
    day of other spending (your last three full months, the bills taken out
    so nothing counts twice). Home's **Next 30 days** tile shows the low
    point and its date — or when cash may run short — and opens what it
    counted: each account (an old balance with its date, one the bank sent
    without a date marked "balance date unknown", an account with no
    balance named), each bill, and the assumption. `/forecast` in Telegram
    says the same; the weekly check-in carries it in Full detail; the daily
    report warns, in Brief too, when cash may run short within 14 days. The
    companion works it out after each sync, and the app says when it is out
    of date, could not be made, or needs a newer companion. A balance or
    spending figure that is not a finite number is never turned into a
    forecast: it is reported as unreadable, not as an all-clear.
  - **A month in review.** In Full detail the monthly report for a completed
    month adds the biggest category changes against the month before, the top
    merchants, subscriptions that started (any charge in the month) or rose
    in price, net worth, savings rate (the same figure as the Budget tab) and
    how many changes were made to your books. A "No longer charging" line
    names subscriptions found missing their charge near the month's end; ones
    that stopped earlier have already left the subscription list, so for now
    the line is rare. Brief is unchanged, and the live "so far" edition of
    the current month carries no review.
  - **Unread reports.** The Reports tab and each report's tab count the
    editions you haven't opened and mark them New; opening a report's tab
    marks it seen, on every device. The inbox re-reads what is stored before
    it writes, so a second device never puts an older time back, and it
    refreshes with the app's live state (on focus and on its interval). A new
    install starts with everything seen.
- **Audits without SSH — fix.** Two repairs that used to need the server's
  `fix-transfers.mjs` and `skip-transaction.mjs`, in Telegram and the app,
  each in the change log with Undo:
  - **Link.** On `/audit` → Health and on **Settings → Checks**, a transfer
    leg with exactly one likely other half shows that half and **Link**;
    with two or more, **Link all**. Health never offers a pair where either
    row is in a group, whatever its type, or is the add-on's held-transfer
    placeholder. Both rows are read again right before anything is written,
    and nothing is linked if either changed, is linked (or may be), is
    pending, is one of the add-on's own rows, or is one you told the sync is
    not a transfer: "It has changed since — nothing was linked." The pair is linked by the sync's own linker, which deletes both
    rows and re-creates them as a group. If Wealthfolio refuses the new pair,
    or the request fails part-way, both rows are read again and whichever are
    gone are written back; anything that may have been lost is named by row,
    and after a failed request it says to check both accounts (the link may
    have gone through after all). A duplicate refusal says "a matching row
    already exists". Money leaving a credit card is never linked, whatever
    type it is stored as, and says so. Telegram shows Health again after
    each tap (clipped to fit a message) and the outcome as a toast — a tap
    that finds nothing left to link only toasts, so a double tap keeps
    "Linked." on screen; the app's card shows a snapshot, so it says
    "Changes show here after the next sync."
  - **Remove for good…** on a transaction's story (`/why` and the app), for a
    row the bank reported twice. The first tap explains; **Remove** puts it
    on the skip list, then deletes it, so the bank feed never imports it
    again; after a delete that throws, the row is read again to see whether it
    went. If the change log can't be written, it says "no Undo". Refused for
    half of a linked transfer ("Unlink it first."), a held transfer, a
    starting balance or a correction, a row not from the bank feed, a pending
    row, a $0 row (never offered), an unreadable skip list or account
    mapping, a row that changed since, and a second removal of the same row
    while one is running. The app never
    removes a transfer-typed row. Undo writes the row back exactly and takes
    off the skip list only the keys this removal added (one already skipped
    before stays, and Undo says so); Redo removes it again.
  - **One write at a time in the app.** Syncs, Link, Remove and the Change
    log's Undo/Redo share one add-on write lock. A sync waits for a running
    Link, Remove or Undo; one started during a sync, or during another
    change, is refused, and says which. A result is tied to the snapshot it
    was made against.
  - **One write at a time in Telegram.** While the companion syncs, Link,
    Remove for good and `/changes` Undo/Redo of a removal are refused ("A
    sync is running — try again when it finishes."); a sync that starts
    during one of them waits for it. A double tap on Link or Remove keeps
    "Linked." or "Removed." on screen. The add-on's lock and the
    companion's don't cover each other.
  - An older add-on reads a snapshot from a newer companion instead of
    calling it unreadable: a reason or a Health issue it doesn't know is left
    out — its amount counts as not explained, the issue under "and N more".

### Fixed
- **The companion's sqlite3 fallback kept every filter.** When `node:sqlite`
  couldn't open the database, the fallback put each query on one line, so a
  `--` comment swallowed the rest of it. Every spending total read through the
  fallback was affected — the digest, weekly and pool figures, the reports and
  the Budget tab (the spend matrix summed everything into one row), and the
  `/budgets` suggestions' budget spend and history start — and the
  needs-a-category list lost its filters (linked rows, transfers, starting
  balances and untracked accounts were listed). Queries now go through as
  written. The default `node:sqlite` path was never affected.
- **The "Opening balances" spending exclusion is re-applied.** It was only set
  while there was an opening debt to file, so a category created on Wealthfolio
  3.8 (which ignores the setting) stayed counted as spending. The companion now
  also sets it, on its next sync, when there is nothing to file and the host is
  3.9 or newer; on 3.8 or an unknown version it skips the step instead of
  sending a request that is ignored.

### Changed
- SimpleFin `/accounts` requests ask the host for the longest timeout (120 s,
  Wealthfolio 3.9+; older hosts ignore it).
- The add-on now requires Wealthfolio 3.8 or newer (it relied on 3.8's cash
  semantics since 1.49); the README says so.
- The companion reports a Wealthfolio HTTP 423 as a clear "profile is locked or
  there is more than one profile" error.
- **One Docker Compose snippet.** Settings → Background sync (Docker), the
  README and `docker-compose.example.yml` now show the same service, written
  once: Wealthfolio's service name on a shared network (host networking as a
  comment), the password from a Compose secret file (an API key as the
  alternative), never a password in the snippet, the database folder
  mounted read-only, `restart: unless-stopped`, and `TZ`. The card fills in
  your browser's timezone and has a Copy button. The card's old snippet used
  host networking and set no `TZ`; a working install needs no change.
  `docker-compose.example.yml` loses its `user:` line and external network.

### Wealthfolio 3.10
Works with 3.10. When upgrading: set `WF_CORS_ALLOW_ORIGINS` to your proxy URL,
keep one default profile with no lock, keep the database unencrypted, and let
Wealthfolio finish rebuilding history (Health page) before a Deep scan. See
"Upgrading Wealthfolio to 3.10" in the README.

## [1.60.0] - 2026-10-13

### Added
- **A change log.** Every change the sync, the companion and you make to your
  books is recorded: each import, bank update and removed pending charge;
  transfer links and transfers held in transit; removed duplicates; starting
  balances and balance corrections; Amazon labels and filings; card
  opening-balance filings; categories you set, moved or took off in Telegram;
  rules you created; accounts you created. `/changes` in Telegram lists the
  last 7 days (`/changes venmo` searches the last 90 days; background
  bookkeeping is never matched), and **Settings → Change log** in the app shows
  the last 90 days (30 by default) with filters. Recording can never fail or
  alter a sync or something you did. When a change could not be saved to the
  log, a note says so ("3 changes may be missing"); the add-on keeps such gaps
  only in that tab's memory until the next successful save.
- **Undo and Redo in the change log.** Most automatic decisions and every
  filing you made can be undone from its entry — in `/changes` (`↩ Undo`,
  `Redo`) or on the app card (Undo, Redo) — with no "are you sure?". The
  result is said right there. Undoing a decision the sync makes (a transfer
  link or a transfer held in transit, a removed duplicate, an automatic
  balance correction, an import, an Amazon label) also tells the sync not to
  make it again. Most of it happens at once: a correction is deleted, an
  import is removed (and never imported again), an Amazon label comes off,
  a removed duplicate is put back, and filings, category rules and starting
  balances are reversed. Only these take effect on the next sync, where both
  surfaces say so and offer **Sync now**: undoing a transfer link (both
  halves are unlinked and each counts as spending or money in) or a transfer
  held in transit, undoing or redoing a transaction rule, and redoing an
  import, an Amazon label, a transfer link or hold (the next sync makes the
  decision again) or a removed duplicate (the next re-scan removes the copy
  again). A rule you created offers `↩ Undo rule` or `↩ Undo rule + un-file
  N` (the N charges it filed go back to the needs-a-category list). An undo
  never overwrites a filing, label, correction or starting balance changed
  since: "It has changed since — nothing was undone." Some entries offer
  nothing: a transfer the sync stopped waiting on, bank
  updates, removed pending charges, background bookkeeping and accounts
  created. **Your overrides**, at the bottom of the app card, lists what the
  sync now leaves alone; Remove lets it decide again. Category and rule
  entries are undone from Telegram (the add-on cannot reach categories); the
  app says so, and it also sends you to Telegram for an import or Amazon
  label on a transfer-typed row it cannot tell is unlinked (the app cannot
  read Wealthfolio's transfer links, and undoing one half would remove both).
- **The bot asks instead of making you remember argument order.** Send
  `/newrule` or `/afford` on its own, or tap **Set a new pool** under `/pool`,
  and it asks one question at a time — buttons where there is a choice, and
  `‹ Back` and `✖ Cancel` on every question. Setting a pool ends on a summary
  with `✅ Save`; a new rule still shows the usual preview before anything is
  written. Your next message answers the question; any command cancels it; an
  unanswered question expires after 15 minutes. Type `cancel` or `back` to
  do what the buttons do. In a group chat the first question says to answer
  by replying to it.
- `/pool` shows **Set a new pool** and **Clear pool** buttons under the pool.
- `/newrule` says how many transactions in the past year the words match, and
  offers your most-used recent categories as buttons.
- **Subscriptions & bills, in the app and the bot.** One list both edit:
  hide one you cancelled, confirm a maybe, set a reminder 1, 3 or 7 days
  before a charge, rename it, or add one the bank data can't show (an annual
  plan) by hand. Every entry shows its next charge date. `/subscriptions` in
  Telegram does all of it with buttons and ↩ Undo; adding and renaming ask one
  question at a time.
- **"Coming up" in the daily report:** reminders, the week's charges (Full
  detail), a price rise, and "didn't charge — cancelled?" with a Hide button.
  With the daily report off, the reminders and news still arrive, as one short
  message, each said once.
- The weekly report adds `Next week: N charges · $X` and a **See all** button.
- When a charge looks like one you added by hand, the card and the bot ask
  "Is HULU your Hulu?" — Yes merges them into one row.

### Changed
- Bills (monthly, varying amount) now have their own group with an "about"
  subtotal, instead of being asked about one by one; they stay out of the
  subscriptions total.
- The mini app's Subscriptions section shows the same names and totals as the
  card. Subscription amounts drop a trailing `.00` everywhere (`$20/mo`).
- Your subscription choices are stored as one document, written by re-reading
  first, so a change made in Telegram is never overwritten by an open app tab.
  In Telegram, a save that could not be read back is refused ("Couldn't save
  that — nothing was changed."); in the app, nothing changes. A document that
  is already unreadable is never overwritten: the app card turns read-only
  with a notice.
- **Upgrade order (Undo):** update the companion before undoing a sync
  decision in the app — until a companion that obeys overrides is running,
  those Undo buttons stay off with "Update the companion first". Undo from
  Telegram needs nothing more.
- **Upgrade order:** update the addon (upload the zip and reload the tab)
  before using `/subscriptions` from Telegram. Hides made in a not-yet-updated
  addon after the companion has created the new document are not carried over.
- The one-line forms still work: `/pool 16000 Dec 12`,
  `/newrule trader joes = groceries`, `/afford 20 shopping`. `/pool`'s date
  now also accepts `today`, `tomorrow` and `Dec 12th`, and an amount with
  misplaced commas (`1,6000`) is refused instead of guessed.
- In a private chat, a plain message when no question is open now gets "I'm
  not waiting for an answer right now" instead of silence.
- `/afford` one-liner amounts are read the same way as the question
  (`$1,200` works; a third decimal is refused).

### Fixed
- A bank name with `*` or `_` in the daily report's price-rise line no longer
  stops the whole report from being delivered.
- The companion's sqlite3 fallback no longer runs through a shell.

## [1.59.2] - 2026-10-10

1.59.1 was tagged but never published: its CI run stopped on a test-file
error before anything was built. This is the same fix.

### Fixed

- **The needs-a-category list only shows what Wealthfolio will let you file.**
  Wealthfolio refuses a category on any transaction in an account it does not
  track for spending, so those rows sat in the list and in Telegram's count,
  and every attempt to file one failed. They are now left out of the list, the
  count, the digest's uncategorized total and the charts, matching
  Wealthfolio's own totals. With spending tracking off the list is empty,
  because Wealthfolio files nothing then.
- **A card payment still pending at the bank no longer asks for a category.**
  While one half of a transfer is pending the sync cannot pair it, so it looked
  like a purchase: nagged about, counted in the digest, and one tap from being
  filed as spending. A transaction is now left out of the list, the count and
  the totals when its other half already waits in another account as a
  transfer (same amount to the cent, the opposite direction, within 5 days).
  Nothing is written, and if the halves never link the charge comes back to
  the list once the other half's 10-day in-transit period ends.

## [1.59.0] - 2026-10-10

### Fixed

- **Amazon's new shipment emails are read again.** Since mid-September Amazon
  sends a plain-text copy with its own order number but no category, and
  prints its total as `10.799999999999999 USD`. The parser joined that copy
  with the HTML one and lost the order, so every shipment read as "could not
  be read". It now reads the subject, plain text and HTML separately and
  combines them by order number. An email with one order number (every
  shipment notice) needs no layout logic at all, and an order whose copies
  disagree on the total is skipped, never guessed.
- **A charge imported before its email was readable gets its category.** The
  sync only ever added the Amazon label when it first imported a charge, so a
  charge that arrived during an outage stayed unlabelled for good. Each sync
  now adds the label to such a charge's note — only to a note the sync wrote
  and nobody edited, never to a linked transfer — and the charge is filed.
- **Cancellation emails are skipped**, not reported as unreadable. They also
  retire the cancelled order's confirmation, so a different charge for the
  same amount cannot pick up its category. Only an email whose subject says
  it was cancelled and that states no total counts — one that merely mentions
  a cancelled item still has to parse, or it is reported.

### Added

- **"Show what couldn't be read"** on the Amazon card. The emails the parser
  could not read, with email addresses, your name and delivery line, card
  digits and link codes removed, ready to copy into a bug report (look it over
  before posting it anywhere public). Each one becomes a test, so a fixed
  format stays fixed.

### Changed

- **`/categorize` no longer offers "Make this a rule" for an Amazon purchase.**
  A rule on `AMAZON MKTPL` would file every later Amazon charge the same way.
  Prime, AWS and Kindle Unlimited charges still get the offer.
- **Remove any catch-all Amazon rule** (for example `Amazon → Online
  Shopping`). It files every Amazon charge before its order email is read, so
  a charge whose email never parses silently keeps the rule's category instead
  of reaching `/categorize`. Deleting a rule leaves the charges it already
  filed as they are.

## [1.58.0] - 2026-10-09

### Fixed

- **A linked transfer keeps both of its halves.** When the sync updated one
  half of a linked transfer, Wealthfolio copied that half's date and note onto
  the other — and the note is where the sync keeps each bank's transaction id.
  The other half then read as the wrong bank's transaction, its own bank record
  looked new, and every full sync reported it as "not imported" (or, if the
  amount had changed, imported it a second time). Seen live on two card
  payments and a savings transfer. Two changes:
  - The sync no longer rewrites a half that is already linked just because its
    partner fell outside this sync's date range. That rewrite — back into an
    "in transit" placeholder, or after ten days into a plain deposit or
    withdrawal — was what set the copying off. A bank's real change of amount
    still goes through.
  - A half that is carrying its partner's identity is recognised, and the pair
    is re-linked with each half under its own bank's description, date and id.
    The bank's own record is no longer offered as a new transaction.
- **A transaction your own rule types as a transfer links up with its other
  half.** Rule-typed transactions were kept out of automatic pairing (so a
  pairing could never override your choice), which also meant one a rule
  called a transfer could never be linked: it waited "in transit", then after
  ten days counted as spending. Pairing only adds the link now when your rule
  already says "transfer" in the same direction; rules naming any other type
  still keep the transaction out. Seen live on a $500 savings → checking move.
- **A refused import names the row Wealthfolio matched it to,** in the
  companion log, so a refusal can be traced instead of guessed at.

### Added

- **Skip list for transactions a bank reports twice.** Deleting the extra copy
  by hand did not stick: the next sync imported it again. The sync now never
  imports a transaction on the list (per account; nothing already stored is
  deleted for you). `companion/tools/skip-transaction.mjs` adds one and deletes
  its row, after a dry run that shows the account's balance against the bank's.

## [1.57.1] - 2026-10-09

### Fixed

- **Every stuck transfer reaches the daily report.** 1.57.0 folded the
  "Transfer stuck" alert into the daily report, but the report only noticed
  unlinked transfers on checking and savings accounts from the last 60 days.
  It now reads the sync's record of pairs that failed to link three times and
  names each leg that is still unlinked, on any account and at any age. A
  pair you have since linked drops out on its own.
- **A card with a transfer in flight is checked again.** The ledger's card
  check skips such a card, and 1.57.0 also kept it out of the new
  balance-difference finding, so a real mismatch said nothing until the
  transfer cleared. The finding now covers it.
- **No alert is lost on a morning the daily report cannot run.** If the
  companion cannot find the Wealthfolio database, it sends the unmapped-account,
  balance-difference and stuck-transfer messages itself, as before 1.57.
- **Two accounts with the same name get separate findings.** Snoozing one
  no longer silences the other, and each is labelled with the end of its id,
  e.g. "CHECKING (…1111)". Accounts with unique names keep their snoozes.
- **/left reads a number in a category's name as the name.** `/left travel
  2026` looks up "Travel 2026" when that category exists, instead of asking
  whether $2,026 of travel fits.
- **The card menu's Pin and Range items have their old names back** for
  screen readers ("Pin Cash flow", "Range for Cash flow").
- **A fresh budget opens with the headline numbers across the top**, instead
  of below the first two charts. Boards you have dragged or pinned keep their
  positions.

## [1.57.0] - 2026-10-09

A minimalism release: three tabs, a calmer look, fewer settings, one Telegram
voice, and a two-step setup.

### Changed

- **Three tabs instead of five: Home, Reports and Settings.**
  - **Home** is what needs you: banners, unfinished setup, and a status strip.
    The strip shows your accounts and whether any balance differs, what needs
    a category, and the semester pool. The budget sits underneath.
  - **Settings** is everything else, on one page, grouped: Accounts, Budget,
    Notifications, Sync, Categorizing, Reset.
  - The account balances moved into Settings → Accounts, beside the mapping.
    Opening that card no longer contacts SimpleFin; only "Edit mapping" does.
  - The pool editor moved to Settings → Budget. The pool tile on Home opens the
    pool's burn-down.
  - Your last-opened tab carries over.
  - "Set up →" and the unmapped-account banner now open the right card and
    scroll to it, instead of leaving you on a page of collapsed cards.
  - The "Imported last run" tile is gone; the header already says how many
    transactions the last sync imported.
- **A calmer look ("Soft").** The addon now uses one visual system:
  - **Type:** one type scale instead of 15 font sizes, and two weights.
  - **Shape:** three corner radii, and one faint lift under surfaces instead of
    a heavy drop shadow on every card.
  - **Background:** the green glow behind the page is gone.
  - **Tabs:** the tabs, the Reports sub-tabs and the Budget range chips are now
    one segmented control.
  - **Overview:** the stat tiles are one divided strip with no coloured rails,
    and the accounts are one list instead of a stack of floating cards.
  - **Banners:** they share one shape. Amber means "check this" (a balance
    difference, duplicates removed); red is kept for real errors.
  - **Colours:** they come from Wealthfolio's theme, so light and dark both
    follow it. Chart colours are unchanged for now.
- **Fewer settings.** One **Report detail** switch (Brief or Full) replaces
  eight controls:
  - Always on: the "$X left this month" line and the weekly pool section.
  - Always allowed, and still only there to warn: the semester pool line and
    the month-end forecast.
  - Full only: the off-budget block in the daily report, and the cash runway
    and subscriptions lines in the weekly one.
  - Biggest spends in the weekly report: 5 in Full, 3 in Brief.

  Existing setups read as **Full**, so nothing changes until you pick Brief. A
  new setup starts on Brief. If you had switched one of the retired controls
  off, it comes back.
- **Auto-sync runs every 4, 6, 12 or 24 hours** (or off). Hourly is gone: the
  SimpleFin bridge only refreshes every few hours. A stored value outside the
  list still shows as its own option.
- **Report content is shorter.** Weekly amounts per category, spent figures
  when over budget, and subcategories are under **More options**.
- **Long banners are one sentence**, with the rest under **Why?**: the
  balance-difference and unmapped-account banners, the Amazon "no emails yet"
  note, the pool card and the Spending Tracker note.
- **The budget starts on six reports** in a fresh layout: the headline
  numbers, cash flow (or the pool burn-down when a pool is set), category
  trends (or cash flow), budget vs actual, top merchants and subscriptions.
  A layout you already arranged keeps exactly what it had.
- **+ Add report** lists the hidden reports, so bringing one back no longer
  needs Customize. "Build your own…" opens the builder.
- **Customize has one ⋯ button per card**, opening a menu (Edit, Duplicate,
  Delete, Move, Size, Range, Colors, Hide) instead of seven buttons.
- **Setup is two steps:** connect, then map accounts. Saving the mapping
  finishes setup and turns on auto-sync every 6 hours. Rules start empty and
  live in Settings.
- **Without the companion, the budget shows a calm empty state** instead of a
  warning. Its **Set up background sync** button opens Settings on the Docker
  instructions.
- **One Telegram voice.** While the daily report is on, three things stop
  arriving as messages of their own and are listed in its "🧹 things to fix"
  line instead:
  - a SimpleFin account nothing is mapped to;
  - a balance that differs from the bank, including the "waiting on the bank
    feed" notice;
  - a transfer that would not auto-link.

  With the daily report off, they are sent exactly as before. So are the
  addon's own alerts when no companion has synced in the last two days (an
  addon-only install, or a stopped container), since then no daily report
  will carry them. Imports,
  large transactions, a day of failed syncs, refused imports, removed
  duplicates and new Amazon labels still arrive straight away.
- **One vocabulary in Telegram.**
  - ✅ only means "synced". "On track", under-budget rows in the monthly
    wrap-up, and "Nothing to fix" no longer carry it.
  - Back buttons read "‹ Back" and undo buttons "↩ Undo".
  - Amounts have thousands separators everywhere ($1,300.00, not $1300.00).
  - Dates read "Oct 9", and times "Oct 9, 3:40 PM", instead of 2026-10-09,
    10-09 or the container's locale format.
- **The ☰ menu has seven commands:** /report, /left, /categorize, /charts,
  /status, /sync and /help. /afford, /pool, /recategorize, /newrule and
  /dismissed still work and are listed under "More commands" in /help.
- **The pool tile says how long the pool lasts** ("lasts past Dec 12" or "out
  by Nov 20"), and the Accounts tile says "all match the bank" only when every
  balance was actually checked.
- **The README** opens with what the addon does, a screenshot and three setup
  steps. The store covers are new, rendered from the 1.57 UI with sample data.

- **The daily report is shorter.** It now opens with only the categories
  that need a decision today: over budget, over this week, or nearly out. The
  rest become one line ("7 others on track"). Choose **All selected
  categories** under Settings → Notifications → Daily category rows to get
  every row back. The setting is stored under a new key, because earlier versions saved
  "all" on every save whether you chose it or not.
- **"Needs attention" no longer takes over the message.** Problems (a failing
  sync, an unmapped account) still print in full. Everything else is one line,
  "🧹 5 things to fix", with a **Show what to fix** button. The Reports tab
  and push notifications still list every finding, since they have no button.
- **The headline says what's left per day** ("about $74/day").
- **The month-end forecast only speaks to warn.** It says "on pace to go
  $X over", only from the 8th of the month. Before that it was a few days of
  rent extrapolated, and it read as a contradiction next to "$X left".
- **The semester pool leaves the daily report while it's healthy.** It
  comes back when the pool is overspent or on pace to run out early. The
  weekly check-in still carries the full section.
- **An over-budget line no longer says the same figure twice.** When a
  category was already over before this week, it reads "· nothing left this
  wk" instead of repeating the month's overage as a weekly one.
- **A dead bank feed is one finding per account**, so each can be snoozed
  separately.

### Added

- **A balance-difference finding per account** in the daily report, for
  accounts other than cards (cards already have their own check). It appears
  only past your drift-alert threshold, never with drift alerts off. It says
  which way and by how much, says it usually clears on its own while it is
  young, and says it is more than feed lag after 10 days. It can be snoozed
  like any other finding.
- **/left groceries 20** answers "can I afford $20 of groceries", the same as
  /afford 20 groceries.
- **Fix and snooze from Telegram.** Show what to fix lists every finding.
  Tapping one opens it, with:
  - **Make it a transfer**, for a payment linked as a transfer but still
    counting as spending. It goes through the usual rule preview: count, then
    confirm, with Undo afterwards.
  - **Pick a category**, for a refund that reduces nothing. It opens the
    category picker on that one transaction.
  - **Snooze 30 days**, for anything you already know about, such as a closed
    card's dead feed. A snoozed finding comes back if it changes.
  - **Unsnooze**, to bring snoozed findings back early.
- **A stale tab now says so itself.** A banner at the top of the addon tells an
  old tab to reload, or tells you to upload the new zip if the old one is still
  installed. It re-checks every minute. The morning report no longer carries
  the "a tab is still running vX" line. That line also fired when no tab was
  open at all.
- **Amazon mailbox problems show on the Amazon card.** That covers a failed
  sign-in (wrong app password or address), and a mailbox the companion has read
  but never found an Amazon email in. The second usually means the Gmail
  filter's To field isn't empty. Both used to be visible only in
  `docker logs`.
- **Startup warnings** for a `WEALTHFOLIO_PASSWORD_FILE` that does not exist,
  which used to fail later as a wrong password, and for an unset `TZ`, which
  runs every schedule on UTC.
- `companion/tools/audit-headline.mjs` is read-only. It measures each known
  difference between the report's "$X left" and Wealthfolio's budget card:
  - rows dated the 1st at midnight UTC,
  - rows dated after today,
  - sync bookkeeping rows,
  - excluded categories,
  - rows filed twice,
  - uncategorized refunds.

### Fixed

- **A refused import is announced once.** Before, Wealthfolio refused the same
  transaction on every sync and the "not imported" alert repeated every six
  hours until the transaction left the bank feed. The companion and the addon
  share one record of what was already announced.
- `/report` stated the last sync time twice. It keeps the "failing since"
  warning when a sync is failing.
- In Settings → Notifications → Report content, each hint now sits under the setting it
  explains. "These six apply immediately" was wrong (there are seven) and now
  reads "These apply immediately".
- The semester pool's inputs had no styling and were nearly invisible.
- Three style classes the components used were never defined.
- 🧹 now only means "things to fix"; the duplicates-removed notice uses 🗑️.
- A reused SimpleFin setup token now explains that tokens are single-use,
  instead of a bare "403". Text that isn't a setup token at all, such as an
  access URL, is named as such.
- Telegram bot tokens and chat IDs are trimmed on save. A pasted trailing
  newline broke every API call, and the only error was "Not Found".
- `/report` no longer marks a "say once" ledger finding as seen, so it can
  no longer use one up before the 8am report.
- `docker-compose.example.yml` now mounts the database folder (not the bare
  `.db` file, which reads days stale) and sets `TZ`. The README's port now
  matches Wealthfolio's default (8088).
- Six tests with fixed dismissal dates started failing once those dates aged
  past the 60-day pruning window. They now use dates relative to today.

## [1.56.1] - 2026-09-24

### Fixed

- **Amazon's September order emails are read again.** Amazon moved the
  category line ("1 Hair Care item") above the order number, and the parser
  looked for it below. Every new order email was left unread as "could not be
  read". Both layouts now parse, including emails with several orders.
- **An order email's label now beats a categorization rule.** A broad rule
  such as "Amazon → Online Shopping" files each charge on import, before the
  email arrives, and used to decide the category for good. A rule's category is
  now a fallback: the email's label replaces it. A category you chose yourself
  is never touched. The daily-audit warning added in 1.56.0 about such rules is
  gone, because the rule is harmless now.

### Added

- `companion/tools/amazon-unread.mjs` prints the Amazon emails the parser
  could not read, exactly as the parser sees them. It is read-only and marks
  nothing as read.

## [1.56.0] - 2026-09-23

### Added

- **Reports tab.** Daily, Weekly and Monthly sub-tabs, each showing the
  report as it stands right now and every edition that was sent before it.
  The companion recomposes the live edition after each sync from the local
  database, and archives each scheduled report whether or not Telegram is set
  up. The daily history keeps about two months, weekly half a year, monthly two
  years.
- **Push notifications for reports.** On a Wealthfolio server that supports
  Web Push, the companion pushes each scheduled report to every browser that
  turned notifications on. Tapping it opens that report's sub-tab. A report you
  switched off in Notifications is still archived, but not sent. Servers
  without push support are skipped quietly.
- **Two new daily-audit findings**, from problems found by hand:
  - A transfer whose other half never arrived. The finding names the account
    that is off from its bank by exactly that amount.
  - A card whose opening balance says it started in credit. That usually
    means the balance absorbed a payment the feed never delivered.
- **Card opening debts are filed automatically.** The companion files a card's
  opening debt under an "Opening balances" category excluded from spending,
  creating both the category and the exclusion only if needed.

### Fixed

- **A dead bank feed no longer holds every transfer open.** A feed silent for
  three weeks now holds only the transfers that name its account. Everything
  else pairs or expires normally. The stale-feed warning now says what to do:
  reconnect the feed in SimpleFin, or unmap a closed account.
- **Amazon email setup.** A Google app password pasted with its display spaces
  now works, for new and existing configs. If a categorization rule files every
  Amazon charge before the order emails can label it, the daily audit says so
  once.

## [1.55.0] - 2026-09-23

### Fixed

- **A credit card that starts out owing money gets its opening balance.**
  Wealthfolio 3.8 accepts only withdrawals, fees, interest, transfers in and
  credits on a credit card. The addon wrote a card's opening debt, a negative
  balance plug, and a restated old placeholder as a transfer out, which
  Wealthfolio refuses. The write failed on every sync and the card's history
  began at zero. These rows are now withdrawals.

### Known limitation

- Every money-out type Wealthfolio accepts on a card counts as spending. A
  card's opening debt therefore appears on Wealthfolio's own Spending page on
  its opening date, unless you file it under a category excluded from spending
  (Settings → Spending). The addon's Budget tab and reports already leave it
  out.

## [1.54.0] - 2026-09-23

### Fixed

- **Wealthfolio's Health page no longer lists the addon's own rows as
  "incomplete transfers".** Opening balances, balance plugs and in-transit
  placeholders are stored as transfer legs because that is how they stay out of
  spending. None of them has a partner, and Wealthfolio 3.8 reports every
  unpartnered transfer leg as an error unless it is marked as money crossing
  the portfolio boundary. Each sync now marks the addon's own such rows that
  way, and new placeholders are written with the mark. Your own transfers and
  linked pairs are never touched. Spending totals do not change.
- **An account's early history no longer dips below zero.** When a re-scan
  brought in transactions older than the starting balance, the addon corrected
  the starting balance's amount but left its date alone, after the history it
  stands for. Wealthfolio then replayed that history against an empty account
  and reported "cash account had a negative balance". The starting balance now
  moves to the day before the earliest transaction. Every sync checks this, so
  a ledger corrected by an older version is repaired too. Only the date moves.
- **A card's opening balance kept its sign when adjusted.** A card's opening
  debt is stored as a transfer out, but it was read back as a positive amount.
  Recovering an older charge would have turned the debt into a credit of the
  same size. The same repair also no longer attaches a cash symbol to a
  transfer-leg starting balance, which would have stopped it moving the balance.
- **"Fix the starting balance" keeps the row's shape.** Accepting the offer
  rewrote a cash opening balance as a deposit, which counted it as income again,
  and on a card wrote a type the API refuses. It now writes the same shape the
  sync uses for opening balances.
- **The addon zip always carries the code for its version.** Packaging zipped
  whatever `dist/addon.js` was already on disk. A locally built v1.53.0 zip
  therefore shipped the v1.49.0 bundle, and the Sync page footer said so.
  `npm run package` now builds first and refuses to pack a bundle compiled as a
  different version. The zips attached to GitHub releases were built fresh by
  CI and were not affected.

### Added

- `companion/tools/audit-health.mjs` shows the rows behind Wealthfolio's Health
  and Spending pages, using Wealthfolio's own rules. It lists incomplete
  transfers, late starting balances, rows on the phantom `$CASH` asset, spending
  by month split into purchases, unlinked transfers and sync rows, and each
  cash account against the bank. It also names the version compiled into the
  installed addon. Read-only.
- `companion/tools/fix-transfers.mjs` links the transfer legs Wealthfolio
  reports as incomplete to their counterpart in another account, matched on the
  same amount within five days. It retypes a counterpart stored as a deposit,
  credit or withdrawal, and deletes the phantom `$CASH` asset once nothing
  points at it. It acts only on matches that are unique both ways. Dry run by
  default.

## [1.53.1] - 2026-09-23

### Fixed

- **Findings the five-line cap hid were being marked as said.** On the first
  morning after v1.53.0 the ledger checks had eleven things to say, showed four
  and "…and 7 more" — and stamped all eleven as seen, so the seven once-only
  findings nobody read expired without ever being shown. A finding the cap
  hides is now left unstamped, so it takes its turn as the visible ones age
  out. Always-on findings are stamped regardless (they repeat until fixed), and
  a card mismatch keeps aging so a busy morning cannot reset its two-day clock.

## [1.53.0] - 2026-09-20

### Added

- **The daily report audits the ledger itself, and only speaks when something
  is wrong.** Balances agreeing with the bank was never enough: every shape a
  row can take moves the same cash, so a ledger that reconciles to the cent can
  still count your own money as income. A day of auditing by hand found exactly
  that — $1,900 of transfers booked as income, a card five months short of its
  opening balance, reimbursements filed where they reduced nothing — and all of
  it is detectable mechanically. Those checks now run every morning under
  *Needs attention*:

  - a refund or card credit with no spending category, which reduces nothing;
  - an unlinked cash transfer, which Wealthfolio counts as income or spending;
  - a row inside a transfer group that is typed as a deposit or withdrawal;
  - a credit card whose posted ledger has disagreed with the bank for over two
    days — cards could never be balance-checked before, and the two-day wait
    exists because a bank's balance leads its own transactions;
  - rows Wealthfolio has flagged Needs review.

- **Budget scenarios, not just ledger errors.** Some things break a budget
  without being a bug. Said ONCE each, because the question is only useful the
  first time: a single purchase bigger than its category's whole budget
  (reimbursable, a one-off, or time to raise the budget?); a category over
  budget three months running, where the budget is probably what is wrong; a
  deposit filed under an income category named like a reimbursement, which
  offsets no spending; and a transfer held open for weeks by a silent feed.

  The block is capped at five lines, and a healthy ledger adds nothing at all.

## [1.52.1] - 2026-09-20

### Fixed

- **The "different builds" warning now says which half is stale, and what to
  do about it.** The addon reports its version when its bundle LOADS in a
  browser, so that figure means "the newest build that has ever run" — and a
  Wealthfolio tab pinned open for a week keeps it stale however many zips are
  uploaded underneath it. The warning could not tell "you never uploaded the
  zip" from "you did, and your tab is old", so it offered both remedies at once
  and twice read as a false alarm. The companion now reads the INSTALLED
  addon's manifest off disk — it already mounts that data directory to reach
  the database — and names the one remedy that applies: upload
  `simplefin-sync-<version>.zip`, or hard-refresh the tab. With no addons
  directory mounted it falls back to the old wording, and a current zip that no
  browser has opened yet is not a warning at all.

### Internal

- Defused four date-dependent test fixtures. Dismissals are pruned past 60
  days, and the fixtures hardcoded July and August dates, so one test began
  failing on 2026-09-18 with no code change and three more would have followed
  on 2026-10-08. They are now relative to the clock.

## [1.52.0] - 2026-09-12

### Fixed

- **An opening balance no longer counts as income.** A cash account's one-time
  starting balance was written as a DEPOSIT, which Wealthfolio classifies as
  income — so every account's whole opening balance read as earnings on the day
  it was first synced ($11,224.68 across two accounts, live). A baseline is not
  earnings; it is the statement that everything before its date is already in
  the bank's figure. It is now a bare CREDIT, which the classifier treats as
  `Ignored`: neither spending nor income.

  **The balance does not move.** Cash movement and classification are
  independent in Wealthfolio: `type_directed_cash_effect` adds the amount for a
  CREDIT exactly as it does for a DEPOSIT, and income types book their cash
  regardless. A test pins the amount as identical across every account type and
  direction, and the same conversion was verified live on two rows, after which
  the account still reconciled with SimpleFin to the cent.

  A NEGATIVE cash baseline stays a WITHDRAWAL, because no neutral outflow
  exists on a cash account — WITHDRAWAL, TRANSFER_OUT, FEE and TAX all classify
  as Expense, and only a linked transfer escapes that. The later
  baseline-adjustment path now runs through the same chooser, so correcting a
  baseline cannot quietly restore the old income-shaped one.

## [1.51.1] - 2026-09-12

### Fixed

- **A card with a payment in flight no longer invents a starting balance.**
  v1.51.0 gave credit cards a readable balance for the first time, which also
  handed them to the one-time starting-balance correction — and a card is
  exactly the account most likely to have a transfer that has posted at one end
  and not the other. Caught on live data within the hour: a $471.74 card
  payment had left the bank and not yet reached the card, so the ledger counted
  it and SimpleFin's balance did not, and the resulting $208.78 of pure timing
  would have been written into the ledger as a fabricated opening balance on a
  real card. An account holding an in-flight transfer is now omitted from the
  ledger-balance fallback entirely, which reads downstream as "cannot check
  this account right now" — the same contract the valuations API already has,
  and the same conservative behaviour every un-valued account had before the
  fallback existed. The correction waits for a settled run.

## [1.51.0] - 2026-09-12

### Fixed

- **A credit card can finally get its opening balance, and its balance can be
  checked at all.** Wealthfolio reports valuations for CASH accounts only —
  measured live: six accounts, two rows — and `/accounts` carries no balance
  either (the field exists on the SDK's TypeScript type but arrives `undefined`
  from the self-hosted server). The one-time starting-balance correction needs
  that figure, so it had never once run on a card: a card's ledger silently
  began at zero on whatever its first synced transaction happened to be. Found
  live, and it was real money — one card's ledger stood $235.40 more owed than
  the bank said, for five months, with nothing able to notice. The companion now
  falls back to summing the account's own activities, using Wealthfolio 3.8's
  own sign rules including the credit-card interest exception. Pending rows are
  excluded, deliberately: SimpleFin reports a card's POSTED balance, so counting
  unsettled rows would report timing as drift and feed that difference into a
  correction that writes real money. Companion-only, and the mirror of holdings
  sync — this one needs the whole ledger, and only the companion has the
  database. A valuation, where one exists, stays authoritative.

- **A card's opening balance no longer books a phantom purchase.** The
  correction chose between DEPOSIT and WITHDRAWAL on the sign alone, and on a
  credit card both are wrong: the API refuses DEPOSIT outright, and WITHDRAWAL
  classifies as SPENDING — so the first correction on a card would have charged
  the user for the size of their own starting debt. Cards now take the same
  spending-neutral shape the drift plugs use. Cash accounts are deliberately
  untouched: turning their opening balance into a bare CREDIT would be arguably
  more correct, since a baseline is not income, but this project's reports
  already exclude starting-balance rows by their note marker, so only
  Wealthfolio's own income view would move — a decision worth taking on its own
  merits rather than as a side effect.

## [1.50.0] - 2026-09-12

### Added

- **Investment accounts finally sync their positions.** SimpleFin publishes a
  `holdings` array for brokerage accounts and the sync had been dropping it, so
  a brokerage arrived as a bank account that happened to be at a broker: cash
  balance, transactions, no positions. They now import as Wealthfolio holdings
  snapshots. A snapshot states the WHOLE position list for a date, so anything
  less than a complete one writes nothing rather than a partial: no holdings,
  an empty array, or a list where every entry lacks a symbol or a share count
  all produce no snapshot, because a positions-free snapshot is
  indistinguishable from "I sold everything". Unresolvable tickers are still
  imported and reported, since a bare BTC gets priced against whatever listing
  it matches. Addon-only, and by upstream's shape: the self-hosted REST server
  exposes no snapshot write route, so the companion declines the capability
  instead of failing at the call.

- **A dead bank connection now names itself.** The Bridge's structured
  `errlist` carries a code, a connection id and an account id per failure, and
  the sync was reading only the older prose `errors` array. When Discover's
  feed died it published nothing for weeks and the only signal was an
  untethered sentence that never said which connection had stopped. Failures
  are now resolved against the accounts in the same payload, so they read
  "Discover it Card: Connection to institution failed", and repeats of one
  failure across several accounts collapse into one line. Both syncers share
  one normaliser, which also means neither trusts `errors` to exist — an
  absent field used to be a TypeError mid-sync rather than "nothing went
  wrong".

### Fixed

- **A transfer whose other half never arrives no longer changes your income in
  silence.** An unpaired leg that runs out of its pairing window is booked as
  ordinary spending or income, which is the honest reading — but it is a guess,
  and it now arrives flagged for review, so Wealthfolio's own Needs review
  screen is the thing that says "this might have been a transfer". The inflow
  direction is the expensive one: two real savings transfers expired into
  deposits and counted as $1,900 of income for two months, which inflates the
  sustainable-spend figure and tells you to spend money you do not have.
  Resting neutral instead was considered and rejected — since Wealthfolio 3.8
  no cash-moving outflow type is neutral to the classifier unless the transfer
  is linked, so a neutral outflow would count as spending upstream while our
  reports excluded it, leaving two views permanently disagreeing. The flag is
  never re-applied once cleared.

- **`CAPITAL ONE TRANSFER ACH WEB PAYMENT` is recognised as a transfer.** It
  matched none of the bank-transfer keywords and so defaulted to a deposit,
  while the same transfer's other leg was typed as a transfer by a user's
  mapping rule — and pair detection only considers transfer-typed legs, so the
  two halves never met. Added to the keyword branch rather than as a mapping
  rule deliberately: that branch picks its type from the direction the money
  moved, where a rule returns one type regardless and would mis-book an
  outgoing transfer of the same name.

## [1.49.0] - 2026-09-07

### Changed

- **Wealthfolio 3.8.0 compatibility.** 3.8 makes an activity's `amount` the
  final cash moved and demotes the fee to information ("it is not deducted
  again"). Every outflow placeholder and drift plug this sync wrote — a
  `CREDIT` with the amount in `fee` — booked zero cash there, and 3.8's
  one-shot migration keeps such rows at $0 and flags them "Needs review", so
  every affected account would read high by the sum of them. Outflow
  placeholders and plugs are now a `TRANSFER_OUT` carrying the real amount,
  which books the same cash on 3.7 and 3.8 — and, as a bonus, in-transit
  card payments finally show their amount instead of $0.
- **Legacy rows are restated automatically.** On its next run (every mode,
  both halves) the sync rewrites its own pre-1.49 fee-side rows to the new
  shape and clears the review flag it caused. Only rows carrying the sync's
  own note marker qualify; a hand-entered CREDIT with a fee is never touched.
- **Reports exclude the sync's bookkeeping by marker, not by type.** An
  unlinked `TRANSFER_OUT` on a cash account is spending to Wealthfolio's own
  classifier (only a linked transfer is neutral, and 3.8 left no cash-moving
  outflow type that isn't), so a Wealthfolio rule can file a placeholder
  before its counterpart posts. The addon's readers now drop in-transit and
  balance-adjustment rows from every category, top-spending and
  uncategorised figure regardless of category. Wealthfolio's own spending
  page will show a placeholder as an uncategorised outflow until the pair
  links — the honest trade for a correct balance.

## [1.48.0] - 2026-09-07

### Added

- **Click a category to see the purchases.** Budget-vs-actual rows are now
  buttons: tap "Shopping" and the card opens full-screen as that category's
  transactions this month — date, description, account, amount, with refunds
  in green and a total — plus an "Open in Wealthfolio" escape hatch. The
  companion publishes the lists with the cube (the host API can't filter by
  category), built from the exact SQL the bars use, so the list always sums
  to the bar you clicked.

### Fixed

- **Every checkbox in the app was misaligned** — the data-check card (v1.34)
  reused the checkbox-row class name `.sfin-check` with a column layout, and
  being later in the stylesheet it silently won everywhere. Renamed, and a
  stylesheet guard test now fails the build on any duplicated top-level
  selector, so this class of drift can't ship again. Five other duplicated
  blocks were merged in the same pass, and the "Slim it down" mode picker
  uses the same label-left/control-right layout as its neighbors.

## [1.47.0] - 2026-09-06

### Added

- **Slim the reports.** Notifications → Reports gains a "Slim it down"
  group: daily category rows can be *all*, *only over-budget*, or *none —
  summary only*; the "$X left this month" line and the off-budget block each
  have their own switch; and the weekly's pool section, cash-runway line,
  and subscriptions line are individually optional. `/report` follows the
  same settings. Defaults keep today's full report.

### Changed

- Over-for-the-month rows keep their week figure ("… over for the month ·
  $42 over this wk") instead of dropping it — the subtitle promises a
  weekly number, and that branch was the one place it vanished.
- The version-skew warning now says to reload the Wealthfolio tab if the
  update is already done: the addon publishes its version when it LOADS, so a
  tab pinned open for days keeps reporting the old build.

## [1.46.1] - 2026-09-03

### Fixed

- The phone dashboard's ▲/▼ moved cards by column geometry — beside a wide
  card that meant two-slot jumps or a dead button. On the phone's single
  column they now mean exactly "one slot up or down the list."

## [1.46.0] - 2026-09-03

### Changed

- **The phone dashboard is YOUR board now.** It renders the same arrangement
  as the Budget tab — your order, your hidden set, your headline picks, your
  per-card range pins — including merchants, subscriptions, the data check,
  and your **custom reports** (evaluated server-side; donut/bars/line/table
  all render). Cards the phone can't translate well (seasonality, calendars)
  stay desktop-only.
- **Organize from the phone**: every card carries ▲ ▼ ✕ controls and hidden
  cards get an unhide row — edits write the same layout secret the Budget
  tab uses, so phone and desktop always agree. (Building new tiles stays in
  the desktop builder; anything you build there appears here.)

### Fixed

- The "Where it went" donut hugged the left edge with its legend adrift —
  ring and legend now center as one group.

## [1.45.1] - 2026-09-03

### Fixed

- Chart photos rendered with NO text at all — no axis numbers, no month
  labels, no legend names — because the Alpine image ships no fonts and
  resvg silently drops text it cannot face. The image now bundles DejaVu
  and resvg is told to use it.

## [1.45.0] - 2026-09-03

### Changed

- **Chart photos read on their own now**: multi-series charts carry a legend
  chip row, line charts print the newest value at the line's end, and every
  photo's caption states the key latest numbers in words ("Cash flow — this
  month: $8,910 in · $2,833 out") — a picture has no hover, so the numbers
  ride along.

## [1.44.2] - 2026-09-03

### Fixed

- Chart-image taps silently produced nothing: the SVG renderer emitted two
  bits of HTML leniency (a duplicated stroke-width on dashed lines, a bare
  data attribute) that browsers forgive and resvg's strict XML parser
  rejects. Both fixed, and the suite now RASTERIZES every renderable report
  through the real resvg so this class of failure cannot ship again.

## [1.44.1] - 2026-09-03

### Changed

- The mobile-reports command is **/charts** (the ☰ menu entry too) — one
  letter away from `/report`, the daily digest, was one confusion too many.
  `/reports` keeps working as a silent alias.

## [1.44.0] - 2026-09-03

### Added

- **Reports on your phone, inside Telegram.** Two surfaces, one `/reports`
  command:
  - **The mini app dashboard**: the companion serves a mobile dashboard —
    headline numbers plus the glanceable charts (burn-down, cash flow, net
    worth, savings rate, donut, budget-vs-actual, trends) with range chips —
    that opens inside Telegram's own webview. Auth is Telegram's signed
    `initData` (HMAC over the bot token) plus an allowlist built simply by
    having used `/reports` in the configured chat: no passwords, no setup
    screens. Enable with `MINIAPP_PORT` (serve it over HTTPS, e.g. tailscale
    serve), mint the `t.me/<bot>/<app>` link once via BotFather `/newapp`,
    and set it as `MINIAPP_LINK`.
  - **Chart images as a fallback** for when the phone can't reach the
    server: `/reports` shows a tap-through menu, and each tap renders that
    chart server-side (hand-rolled SVG → PNG via resvg, no native deps) and
    sends it as a photo over Telegram's own pipe.
- Charts for both surfaces come from one shared SVG renderer
  (`shared/svg-charts.ts` + `shared/report-render.ts`), and `report-data`
  moved to `shared/` so all three surfaces — Budget tab, mini app, images —
  prepare numbers identically.

## [1.43.0] - 2026-09-02

### Added

- **Per-tile time windows.** Any card can pin its own range (Month / 3 / 6 /
  12 / All) via the ⏱ button in Customize — pinned cards ignore the shared
  chips and wear a small badge; everything else keeps following the chips.
- **Pick your headline numbers.** The headline card's catalog grows to 14
  stats — income, net flow, average daily spend, month-end projection, net
  worth, liquid cash, uncategorized, fees, subscriptions cost, spend vs last
  month, pool left, and the classic trio — and the open card lets you choose
  any one to five of them.
- **Color palettes.** Ten palettes (Sage, Ocean, Sunset, Forest, Berry,
  Slate, Autumn, Pastel, Mono green, Bold): pick one globally from the
  Customize toolbar swatches, and/or override any single card with its 🎨
  button. Charts recolor everywhere via CSS custom properties.
- **Cancelling feels like a win.** Dismissing a subscription pops a small
  celebration with the money freed ("🎉 … $4.99/mo back in your pocket"),
  and the card's rows got a general polish (separators, hover, tabular
  numbers).

### Fixed

- Budget-vs-actual now shows EVERY category, compressing row height and type
  to fit the card instead of cutting off the bottom of the list.

## [1.42.0] - 2026-09-02

### Changed

- **The pool's start date is editable** alongside the amount and end date on
  the burn-down's full screen — a pool that began with the semester is no
  longer stuck at whenever /pool was first typed.

### Fixed

- The pool legend was clipped by the card body's overflow-and-fade cage; it
  now sits inside the card's top-right corner, which the burn-down leaves
  empty by construction.

## [1.41.1] - 2026-09-02

### Fixed

- The drag ghost's chart no longer balloons past the tile: every rule that
  cages a chart inside its cell (overflow, container sizing, chart
  min-height, the fade mask) was scoped to grid cells only, and the floating
  ghost lives outside the grid. The same cage now applies to the ghost, so
  the card you drag looks exactly like the card you grabbed.

## [1.41.0] - 2026-09-02

### Changed

- **The board is a real 2-D grid now** — the model react-grid-layout and
  Gridstack converge on, per the drag-and-drop best-practice research: every
  card keeps an explicit x/y position, a drop lands in the exact cell under
  your cursor, anything you land on pushes straight *down* (never sideways,
  never repacked), and gravity closes gaps upward. The old model — a 1-D
  order that CSS dense-packing rearranged — is why moving one tile could
  shuffle everything; that cannot happen any more. Your current arrangement
  migrates automatically, and the ↑/↓ buttons now swap a card with its
  vertical neighbor (the honest meaning of the buttons under gravity).
  Phones still collapse to one column in reading order.

## [1.40.0] - 2026-09-02

### Changed

- **Budget-vs-actual bars finally fill.** Every bar was scaled by the biggest
  row's budget, so a $174 overspend of a $100 budget rendered as a sliver
  next to Housing's $1,550. Bars now scale to their own row: overspending
  fills the whole bar in the warning color with a tick where the budget sat.
- **The card follows the range control.** Budget-vs-actual shows the monthly
  average across the selected window (labeled), and a **Month** chip joins
  3/6/12/All at the top for the single-month view.
- "Month vs last" is titled **"This month vs last"**.

## [1.39.0] - 2026-09-02

### Changed

- **Watch list looks back.** "Watch a merchant" (and watched-item pricing)
  now draws on the last three months of merchants, not just the current one —
  on the 2nd of a month the current month is two days deep, which is exactly
  why a mid-August Claude charge was nowhere to be found. The open view also
  keeps its Watch/Dismissed sections even when the roster is empty.
- **"varies" says what varied.** A bill or question row whose last two
  charges differ shows the movement — "$54.20 → $61.73/mo" — and just the one
  number when nothing changed.
- **Subscription rows line up.** Name, price, and buttons are strict columns
  now; the price no longer drifts with the number of buttons in the row.
- **The pool chart reads at a glance.** Actual is a bold solid line, ideal a
  thin dashed one, with a small legend — they were both thin sage and
  indistinguishable where they overlapped.

## [1.38.0] - 2026-09-02

### Added

- **Undo a dismissal one at a time.** The open Subscriptions view lists what
  you've dismissed, each with its own ↩ Restore — an accidental ✕ is one tap
  back. (The card keeps the restore-all link.)
- **Watch a merchant.** The open view offers this month's merchants with a
  + Watch button: one charge so far, or something you know recurs — watching
  treats it as a confirmed subscription immediately ("$20.00/mo · watching"),
  counted in the total, with the detector taking over as charges accumulate.

### Fixed

- Tapping a button INSIDE a card (a subscription's ✓/✕) no longer also opens
  that card full-screen.

## [1.37.0] - 2026-09-02

### Changed

- **The ghost is glued to the cursor now.** Its position updates by a direct
  style write instead of re-rendering twenty charts per pointer event — the
  reported lag was React doing exactly that.
- **Dropping right on top of a card works.** Targeting is real rectangle
  hit-testing over whole cells (headers, tools, and padding included — the
  old approach only matched the inner chart body, leaving dead zones), with a
  halves rule: the front half of a card means "before it", the back half
  "after it".
- **"Is this a subscription?"** Anything charging on a monthly cadence — same
  price or not, so rent, utilities, and a just-upgraded plan all qualify —
  now appears as a question on the card with ✓ / ✕. Yes counts it in the
  roster, the total, and the weekly line permanently; No hides it forever
  (restorable). Only the unambiguous stable-price case is auto-counted, so a
  gas bill never sneaks into "subscriptions" on its own — and nothing with a
  monthly cadence can silently vanish the way a plan upgrade used to make
  two-charge history "unstable" and invisible.

## [1.36.0] - 2026-09-02

### Changed

- **The dragged card rides your cursor.** Picking up a card lifts the card
  itself into a floating ghost that follows the pointer; its grid cell stays
  behind as a dashed landing slot that reorders live — the slot IS the
  "here's where it will drop" indicator, and the other cards keep gliding out
  of the way.
- **Recurring detection now has tiers.** *Subscriptions* (stable monthly
  price) as before; *bills* — a monthly merchant whose amount varies, like
  gas & electric, shown as "~$120/mo · varies" with no price-creep nagging;
  *known brands* (Netflix, Spotify, Claude/Anthropic, Adobe, …) count with
  just two charges, so a subscription started six weeks ago no longer hides
  for a month; and a **"Possibly recurring"** section surfaces two-charge
  maybes so you can see what's on the bubble — dismissible like everything
  else, and never counted in the money total or the weekly line.

## [1.35.0] - 2026-09-02

### Changed

- **You can see cards move now.** Dragging a card makes it lift, fade, and
  cast a shadow while every other card *glides* into its new place instead of
  teleporting; resizing gets a dashed live outline and the same gliding
  neighbors. (FLIP animations over the real grid — no fake drag layer.)
- **Near-custom sizes.** The grid is 12 fine columns with short rows instead
  of 3 coarse columns: the corner drag now snaps every ~40px, so "super thin",
  "super wide", or anything between is just a drag — no numbers to type.
  Existing saved sizes migrate automatically. Because it stays a grid (not
  free pixels), layouts still reflow cleanly on wider/narrower screens, and
  phones still collapse to one column with each card keeping its height.
- **Subscriptions detect better and can be dismissed.** Charges whose bank
  descriptors differ only by per-charge reference codes ("CLAUDE.AI *SUB
  8ZK1" vs "…41XP") now group as one subscription; cadence and price are
  judged on the latest three charges, so a plan upgrade or an old billing
  hiccup no longer disqualifies a real subscription. Each row has a ✕ for
  "cancelled that already" — dismissals leave the card, the weekly total, and
  the creep line immediately, with a one-tap restore.

## [1.34.0] - 2026-09-02

### Added

- **Rule learning.** Filing a transaction in Telegram now counts, live, how
  many other uncategorized rows the same merchant pattern would catch, and the
  "Make this a rule" button says so ("⚡ files 2 more like it"). Rules are
  built from the **trimmed head** of the description — trailing reference
  numbers, phone numbers, and "#42"s are dropped (capped at six tokens), so a
  rule finally survives the merchant's next charge instead of memorizing one.
  The preview quotes exactly what the rule will use and how many rows it files
  right now. (Patterns stay verbatim substrings — never punctuation-stripped —
  because Wealthfolio's contains-match runs on raw text.)
- **One-step updates.** Every release now attaches the addon zip to the GitHub
  release (built and version-checked in CI); the daily report gains an
  "⬆ v1.35.0 is available" line when a newer release exists (checked at most
  once per 6h, fail-silent); and the addon publishes its version so the
  self-check can warn loudly when the zip and the image are **different
  builds** — the half-finished-update trap.
- **Data check report.** The companion recomputes the current month's spending
  through the digest's own single-shot readers — a pipeline sharing no
  aggregation code with the report cube — and a new standard card renders
  "✓ matches the ledger" or each divergent measure with both sides and the
  delta (a ledger-side surplus usually means an unmapped account).
- **Subscriptions report.** The companion detects monthly recurring charges
  (≥3 charges, monthly cadence, stable price, still active) and the new card
  lists them with prices, flags **price creep** (▲ was $10.99), and totals
  the monthly cost. The weekly check-in carries the one-line total; a fresh
  creep earns a daily-report line for three mornings, then goes quiet.
- **Budget-tab quality of life.** A two-tap **Reset layout** in Customize
  restores the defaults; hiding a card raises an **Undo** toast; and the
  semester pool's amount and end date are editable right on the burn-down's
  full screen — no Telegram required.

## [1.33.0] - 2026-09-02

### Changed

- **One grid, no special cases.** The hero row and the fixed stat strip are
  gone: the big charts are ordinary cards that default to 2×2 at the front,
  the headline numbers (spent / runway / savings rate) are a full-width card
  of their own — and every card now moves, hides, and resizes the same way.
- **Both drags actually work now**, rebuilt on pointer capture (the previous
  window-listener approach silently died inside the sandboxed iframe): drag a
  card's **corner** to resize it, drag **anywhere else on the card** (in
  Customize) to move it and drop it where you want. A drop-state bug that
  could throw away a resize on release is fixed too.
- **The date-range chips live on the dashboard** and drive every report at
  once (3/6/12 months, All, Pool) — no per-report fiddling.
- **Savings rate speaks percent everywhere**: the chart plotted raw fractions
  next to a chip saying "20%"; chart, chip, and tooltip now share one unit.
- **Small screens conform**: card spans collapse to a single column on
  phones via CSS custom properties (inline spans would have overridden the
  media query), the headline card stacks its tiles when narrow, and the
  auto-density rules from 1.32.0 keep applying per card.

## [1.32.0] - 2026-09-02

### Fixed

- **The sage gradient actually shows now.** 1.31.0 painted it on a layer
  stacked beneath the sandbox body's opaque background — invisible by
  construction. It lives on the body itself, slightly stronger.

### Added

- **Drag-to-resize.** In Customize, every grid card grows a corner handle:
  drag right to widen, down to grow, snapping to the grid rhythm (up to 3×4),
  stored per card. The size-cycle button stays for phones and keyboards.
- **Auto-density.** Content conforms to the box it is given: short cards
  shrink their type (CSS container queries), fade out at the bottom edge
  instead of clipping mid-row, and list reports (merchants, budget vs actual)
  budget their row count to the card's height with a "+ N more" note.
- **Six new reports**: *Where it went* (last month's donut), *Month vs last*
  (change per category, jumps first), *Spending calendar* (per-day heat over
  the pool window), *Pool pace* (both paces with a green/amber/red verdict),
  *Money in vs out* (cumulative income against spending), and *Uncategorized
  trend*. Pool-window reports appear only while a pool is set.
- **Builder upgrades**: any series can render as **% of income or spending**;
  a report can apply a **3-month rolling average** (kills lump-sum noise);
  and a months-range report can **overlay the previous window** ("(prev)"
  series) for comparison.

## [1.31.0] - 2026-09-02

### Changed

- **The Budget tab wears Wealthfolio's own look**: a faint sage radial
  gradient behind every tab of the addon, and the chart palette re-tuned from
  primary-color defaults to the app's muted greens and earth tones.
- **Exact card sizes.** Widen/Narrow grew into a real size cycle — every grid
  card steps through **compact → medium → wide → tall → big** (column *and*
  row spans on a fixed grid rhythm, so the boxes are the size you pick and
  the grid stays flush). Stored per card; old widened layouts carry over.
- **Customize controls live on the card now** — a compact tool cluster in each
  card's corner instead of a row floating beneath it.
- **The merchants card previews its top six** with a "+ N more" note; the full
  list lives in the opened view. It no longer stretches its whole grid row.
- Quiet reports (fees & interest) default to compact.

## [1.30.0] - 2026-09-02

### Fixed

- **A linked transfer can no longer appear in `/categorize`.** A linked pair
  may hold a WITHDRAWAL-typed leg, and the row list behind the tile, the
  import notice, and the menu lacked the transfer-group exclusion the count
  always had — so a paired Citi card payment was offered for categorization
  while the tile said nothing needed one. List and count now share one rule.

### Added

- **Income categorization from Telegram.** A money-in row whose bucket is
  income (deposits, cash interest — your grant check) now gets Wealthfolio's
  *income* categories in `/categorize`, which are the only ones upstream will
  accept there; the old spending grid offered such rows nothing but 400s. The
  filing carries its taxonomy through Undo, and a "Spending categories »"
  escape hatch covers deposits that are really refunds. Card credits keep the
  spending grid: money in, but a spending-bucket refund.
- **Signs and colors on every listed amount.** The import notice, its
  needs-a-category block, the `/categorize` screens, and the addon's
  uncategorized list now show `+$16,000` / `−$87.26` — with 🟢/🔴 dots in
  emoji style and green/red styling in the addon — so money in and money out
  are never ambiguous again.
- **Mixed Amazon orders file under your default Amazon category** (the one in
  the Amazon card — set it to Shopping and that's where they go). No rule can
  ever match a mixed label, so leaving them stranded meant hand-filing each
  one forever; the label text still says what the order contained.
- **Budget tab polish**: full-width on desktop, hero charts at proper height,
  hoverable cards, pill range chips, a dashed New-report card, merchant and
  preview tables that fit, a seasonality heatmap whose quiet cells stay
  visible, and per-card **Widen/Narrow** in Customize (a persisted
  double-width span that folds to one column on phones).

## [1.29.0] - 2026-08-30

### Added

- **The Budget tab** — the addon's new first and default view: your money as
  reports, rendered from one `report_cube` secret the companion publishes on
  every sync (24 months of spending by category and account, income, budgets,
  merchants, fees, valuations, and the pool's daily burn — all from the same
  classifier transcription the Telegram reports use, so nothing here can
  disagree with the digest).
- **Ten standard reports**: pool burn-down (ideal glide vs actual), cash flow
  by month, category trends, net worth, savings rate, merchant leaderboard
  with trend arrows, budget vs actual, a seasonality heatmap, fees & interest,
  and cash-runway trend. Every chart uses Wealthfolio's own host-provided
  chart kit, so the tab looks native and costs almost nothing in bundle size.
- **A custom report builder**, Actual-style: build named series from signed
  terms — add and subtract categories, income, total spending, uncategorized —
  pick line/bars/stacked/area/donut/table and a date range, filter by account,
  and watch a live preview update on every tap. Saved reports join the grid
  beside the standard ones, with edit, duplicate, and delete.
- **A dashboard you arrange**: tap any card to open it full-screen (with the
  one shared range control — 6/12/24 months, all, or the pool window);
  Customize mode pins up to two hero charts, reorders with up/down buttons,
  and hides reports into a recoverable row. Buttons, not drag — it works the
  same on a phone, where the whole tab is built single-column-first.
- **Absence explains itself**: without a companion publish the tab shows one
  banner (not ten empty charts); a stale cube gets an "as of" strip; months
  without valuation data render as gaps; an all-zero fees history says
  "nothing — as it should be"; a custom report naming a since-renamed category
  wears a warning chip instead of breaking.

### Notes for self-hosters

- The companion now also publishes the `report_cube` addon secret each sync.
  Net worth and runway history read Wealthfolio's valuation table when one
  exists; otherwise those charts accrue from the companion's own monthly
  snapshots going forward.

## [1.28.0] - 2026-08-30

### Added

- **Semester pool burn-down** — a money lens built for lump-sum funding, where
  "income minus spending this month" means nothing: a loan disbursement lands
  once and has to last until a date. Tell the addon the amount and the date —
  the new **Semester pool** card on Overview, or `/pool 16000 Dec 12` in
  Telegram (`/pool` shows it, `/pool off` clears it; both write the same
  config) — and from then on:
  - the **daily digest** carries one line: remaining pool, the sustainable
    weekly pace, and the verdict — `lasts past Dec 12`, or `at this pace out by
    Nov 28`;
  - the **weekly check-in** gets a pool section with totals, both paces
    (sustainable vs actual), and percent used;
  - the **Overview strip** gets a pool tile with the remaining amount and
    sustainable pace, republished by the companion every sync
    (`pool_status`).
  "Spent" is the same figure every other report prints — the classifier
  transcription plus uncategorized spending, dismissed rows excluded — so the
  pool can never disagree with the digest. After the end date the pool reports
  its outcome (`$412 unspent` / `$180 over`) for a week, then goes quiet until
  the next one is set. A hidden pool line is one toggle in Notifications →
  Report content.
- **Cash runway on the weekly check-in** — `🛟 4.8 months of cash runway`:
  liquid cash net of card debt, divided by the trailing-90-day average monthly
  spend. Rendered only when every input is readable; an unknowable runway says
  nothing rather than guessing.

## [1.27.0] - 2026-08-30

### Fixed

- **A transfer leg no longer expires into spending while a counterpart feed is
  down.** The 10-day in-transit timeout assumed the other bank's feed was alive
  and merely slow — so when Discover's connection went silent for weeks
  (an issuer-side transition), a real $87.26 card payment ran out the clock and
  demoted to an uncategorized `WITHDRAWAL`, polluting the spending report it was
  correctly held out of for ten days. The give-up now checks its own premise:
  a leg past the timeout is demoted only when every *other* mapped account's
  feed has proven itself alive past the leg's pairing window — the later of
  SimpleFin's `balance-date` (frozen exactly when a connection breaks) and the
  account's newest transaction, with an account absent from the feed counting
  as no life at all. While any counterpart feed is behind, the leg keeps its
  spending-neutral placeholder and the sync log records which account is being
  waited on. No new I/O: both signals are already in every run.
- **A leg the old build already demoted heals itself** — while the transaction
  is still inside the fetch window, the next sync re-resolves it to a held
  placeholder and rewrites the row in place, taking it back out of spending and
  the needs-a-category nudge with no manual step.
- The deliberate trade, documented on `expiryHoldAccount`: if a feed stays dead
  until the leg ages out of the fetch window, the placeholder remains
  permanently neutral rather than ever becoming spending — for a card payment
  whose counterpart data is lost, that is the correct resting state, and a heal
  re-scan can still pair it if the bank backfills.

## [1.26.2] - 2026-08-30

### Fixed

- **A positive drift-heal plug on a credit card no longer reads as a refund** —
  the known issue left open in 1.26.1, now closed on evidence rather than
  guesswork. A $0.05 `TRANSFER_IN` with `$CASH-USD` was written to a real card
  through the import endpoint, read back with `asset_id` null (the real-cash
  branch, no phantom asset), and deleted. The same probe showed the endpoint
  rejects a row without a `symbol` field, so the plug keeps its cash symbol.
  Card inflows — placeholder and plug alike — are now one shape, `TRANSFER_IN`,
  from one function; the placeholder/plug split introduced in 1.26.1 is gone.

## [1.26.1] - 2026-08-27

### Fixed

- **A card payment waiting for its cash leg no longer counts as a refund.**
  The in-transit placeholder for money arriving at a credit card was booked as
  a bare `CREDIT` — chosen on 2026-08-07 because the API accepts it where it
  rejects `DEPOSIT`, without re-checking how it classifies. On a card,
  Wealthfolio treats *every* `CREDIT` as an expense refund, so a $429.71
  payment showed the day's spending as −$400.51 until the other bank's feed
  caught up. Card inflows are now booked as `TRANSFER_IN`: ignored by the
  classifier, accepted by the API, the real amount visible, and the type the
  row becomes on pairing anyway. Cash placeholders are unchanged — they were
  correct.
- **An existing placeholder written the old way is migrated on the next sync**,
  not left as a refund until its pair happens to arrive.
- **A card placeholder that times out no longer demotes to `DEPOSIT`**, the one
  type a card refuses. It becomes `CREDIT` — a positive that never paired is a
  refund — and an outflow becomes `WITHDRAWAL`.
- **A new test checks every placeholder shape against the spending classifier
  itself** — each account type, both directions — with a control row so a zero
  can never be the vacuous kind, and the old card shape kept as the negative
  case. This is the test that would have failed on 2026-08-07.

### Known issue

- A **positive drift-heal balance plug on a credit card** reads as a refund for
  the same reason, and plugs never pair, so it is permanent. Left as is on
  purpose: the plug goes through the import endpoint with an explicit cash
  symbol, where a `TRANSFER` type has a known cash-asset quirk (upstream
  issue #5) that cannot be verified without a live write. Rare — a positive
  card plug means Wealthfolio thought the balance owed was higher than the
  bank's — and the addon's own reports do not count it (an uncategorized row
  is outside the spending join), but Wealthfolio's spending page does.

## [1.26.0] - 2026-08-25

### Added

- **Month-end projection on the daily headline**, matched to Wealthfolio's own
  forecast: `· on pace for $3,120 (+$520 vs budget)`. It is the app's formula
  transcribed — the previous three full months' outflow ÷ their days × days
  in this month, with the app's fallback (spent ÷ day-of-month × days) when
  there is no history — so the report and the budget page say the same
  number. Note what it does not do: when history exists, this month's
  spending plays no part; "on pace" means "at your recent average". Toggle
  under Notifications → Report content → "Month-end projection" (default
  shown). Expect it to sit within a few dollars of the app rather than match
  to the cent — the two classify spending by transcription, not by one shared
  function.
- **Undo for a transfer rule taught from Telegram.** The confirmation after
  "✓ Make the rule" now carries "↩ Undo this rule", which removes exactly the
  rule just written — pattern and direction — and nothing else, so hand-written
  rules survive. Anything the rule already retyped goes back to normal on the
  next sync. Not offered when the rule already existed, since that undo would
  delete a rule the user wrote earlier.

## [1.25.0] - 2026-08-25

### Added

- **Undo for dismissals, from Telegram.** Tapping *Dismiss* on an import
  notice now turns that button into *↩ Undo*, and Undo turns it back — the
  notice itself is the way back, so there is nothing new to find. A dismissal
  used to be one tap with no recovery short of waiting ~60 days for the ledger
  to forget it.
- **`/dismissed`** lists what you dismissed recently, newest first, each with
  its own Undo — for a notice that has scrolled out of reach, or one from
  before this build.
- **Spent figures once over budget**, under Notifications → Report content →
  "Spent figures when over budget". The budget is a floor; above it most people
  hold a second, harder number in their head, and `$329 over` says nothing
  about how close that is. The over-budget headline now reads
  `🚨 $297 over budget this month · $2,897 spent` (default: monthly total
  only). *Total and each category* also appends each over-budget category's
  own spend — opt-in, because several over categories become several extra
  numbers. *Neither* keeps every line as it was. Nothing changes while under
  budget.

## [1.24.1] - 2026-08-25

### Fixed

- **The import notice no longer offers to "mark as a transfer" a transfer the
  sync already recognized.** An unpaired transfer leg waiting for its
  counterpart is booked as a spending-neutral placeholder wearing a CREDIT
  type, and the transfer-learning menu filtered candidates by activity type
  alone — so the placeholder walked straight through and the button appeared
  on it. Worse than redundant: teaching a rule from it would have matched the
  descriptor of the user's own bank, converting every future deposit from
  that bank into a transfer leg. The placeholder flag now travels with the
  imported row and such rows are excluded outright.
- **The Wealthfolio database path had thirteen hand-written fallbacks in three
  spellings**, including three that silently skipped their feature. All now
  agree on one constant, and the companion complains loudly at startup when
  the file is missing — a report built against a missing database describes a
  perfectly healthy-looking empty month, which is the one failure that must
  not be quiet.

## [1.24.0] - 2026-08-24

### Added

- **Self-check: the daily report now says when something is wrong with the
  pipeline itself.** Every signal involved was already published and already
  readable — but only by running `/status`, and nobody runs `/status` unless
  they already suspect something. The checks now run on their own and report
  into the message already being read:

  - the sync has been failing, and for how long, with the error;
  - no successful sync in over 12 hours (comfortably past the 4-hour default,
    so an ordinary skipped run never cries wolf);
  - a SimpleFin account is unmapped, so nothing from it is syncing — named,
    because the name is the whole fix;
  - an account has sent no new data in over 14 days, which SimpleFin does not
    report as an error;
  - the health signal could not be READ, reported distinctly from "healthy",
    because a 401 rendering as a clean bill of health is how a dead connection
    reads as fine.

  Nothing is added on a healthy day. A reassurance printed every single day
  stops being read long before the day it is wrong — the existing
  `✅ synced Nh ago` footer already carries proof of life.

## [1.23.0] - 2026-08-24

### Fixed

- **A dismissed charge no longer shrinks every category.** Dismissing an
  uncategorized charge means "not spending I need to file", but its amount kept
  counting toward the month's pool — so one dismissed charge quietly reduced
  every category's figure with nothing on screen explaining why. The count and
  the total are filtered together, in SQL, so they cannot disagree about which
  rows they describe.
- **A refund larger than a month's spend no longer inflates a category past its
  own budget.** `budget - monthSpent` exceeds the budget once `monthSpent` goes
  negative, showing $350 left on a $300 category — and because these figures
  feed the pool, one inflated category overstated all of them. A refund
  restores room that was always inside the budget; it does not raise the
  ceiling.
- **A permanent Telegram rejection is reported immediately** instead of
  consuming the whole retry budget first. Bad token, wrong chat id and
  malformed Markdown fail identically on every attempt, so `TelegramSendResult`
  now distinguishes them from "come back in a moment".

### Changed

- **Scheduled reports retry for about two and a half minutes** (was 11
  seconds). The old budget only ever covered an instantaneous blip, while a
  Telegram outage is usually minutes. Still firmly bounded: a daily report that
  lands an hour late describes a day already spent into, so failing loudly
  beats arriving stale.

## [1.22.2] - 2026-08-22

### Fixed

- **A category could still advertise money the month did not have.** When a
  category had blown the week's pace but kept month budget, its line read
  `⚠️ $62 over · $36 left mo` — and that `left mo` figure ignored the pool cap
  1.21.0 introduced, so it could exceed what every category combined had left.
  One report showed `$36 left mo` directly above `🚨 $93 over budget this
  month`.

  1.21.0 scaled the weekly figure and deliberately left month figures raw, on
  the rule that they state a fact about the budget. That holds for
  `🚨 $329 over`, which promises nothing, and fails for `$36 left mo`, which
  promises spendable money exactly as a weekly figure does. The cap now applies
  wherever a figure is money still available, and nowhere it is not — a healthy
  pool leaves the figure untouched, and switching capping off keeps it raw.

## [1.22.1] - 2026-08-22

### Fixed

- **1.22.0 reported itself as `1.21.0`.** Both halves display the single
  constant in `shared/version.ts`, and the release bumped `package.json` and
  `manifest.json` without it — so the Sync page footer and the companion's
  startup log named the previous build. Only the version strings were wrong;
  the 1.22.0 code was the 1.22.0 code.
- The version-guard test that exists for exactly this had been run *before*
  the bump and never again after it. A tag push now re-checks the tag against
  all three version strings in CI, before the registry login, so a mismatched
  tag publishes nothing.
- Report content said "These three apply immediately" after the weekly-capping
  dropdown made it four.

## [1.22.0] - 2026-08-22

### Added

- **Weekly per-category amounts are now a choice**, under Notifications →
  Report content → "Weekly amounts per category". The two options answer
  different questions and neither is wrong:

  - **Limited by what the month can afford** (the default, and what 1.21.0
    did): the per-category figures are scaled so they cannot add up to money
    the month no longer has. Honest about what is spendable, but when the pool
    is tight every category collapses toward the same small number and stops
    telling you which one has room.
  - **The full budget for each category**: Wealthfolio's own envelope view.
    Each category keeps its own budget regardless of the others, so the
    categories stay distinguishable — at the cost of figures that overstate
    when the pool is short. Because they overstate, the subtitle names the
    pool outright (`left in each budget · only $150 left overall`) rather than
    letting the envelopes read as money in hand.

  Whichever is chosen, the report states which one it is showing, and the
  monthly headline is identical either way — the setting only moves the
  per-category figures.

## [1.21.0] - 2026-08-21

### Changed

- **A category's weekly figure can no longer promise money the month does not
  have.** The daily digest was printing two budgeting models at once and they
  contradicted each other: the category lines are *envelopes* (Groceries has
  its own $80 whatever else happens) while the headline is a *pool* ($297 over
  across everything). With one category far over, every other envelope went on
  offering its full weekly allowance — money that did not exist.

  Weekly figures are now scaled by what the pool can actually cover, and the
  subtitle says which state you are in:

  - room for everything → `left to spend this week`, unchanged
  - pool short → `left to spend this week · reduced to fit what is left
    overall`, with each figure scaled proportionally
  - month spent → `the month is spent — nothing left to spend this week`, and
    the figures read $0

  The **month** figure on each line is untouched: that states the envelope,
  which is a real fact about your budget. It is the spend-this-week number
  that must not over-promise. Spending with no budget and unfiled charges
  count against the pool too — money gone is gone, whatever it was labelled.

  One consequence worth knowing: these weekly figures now deliberately differ
  from Wealthfolio's per-category view, which is pure envelope budgeting.

## [1.20.1] - 2026-08-21

### Changed

- **The daily headline is one figure again.** It had grown a parenthetical —
  `· after $100 off budget & uncategorized` — which was accurate and still
  cluttered the one line most people actually read, putting three numbers
  where the question has one answer. The "Off budget" and "Uncategorized"
  blocks above it already itemise every dollar involved, so nothing is hidden
  and the arithmetic stays checkable.

  The figure itself is unchanged: it is still net of both.

## [1.20.0] - 2026-08-21

Three fixes for the cases that fail **quietly** — the only kind that costs you
anything when you are not watching.

### Added

- **A transaction the bank reported but Wealthfolio refused is now announced.**
  Wealthfolio rejects a create when its own date+amount check reads it as a
  duplicate. Usually right — and once, badly wrong: a real $1,300 withdrawal
  was refused as a copy of its same-amount sibling from the day before, and the
  account was wrong by that amount for six weeks, because the refusal was
  logged at debug level and surfaced nowhere. It is now a message, worded as a
  question rather than an alarm, since most refusals genuinely are duplicates
  and only you can tell which kind it is. Sent from whichever side ran the
  sync. Nothing is auto-retried: inventing a second copy of a real transaction
  is the worse error.

### Changed

- **"Mark one as a transfer" now shows what the rule would catch before
  writing it.** The rule is a text match applied to everything, so a generic
  descriptor like `ACH WITHDRAWAL` would retype every such transaction as a
  transfer and remove all of it from spending — silently, and retroactively.
  The confirm step names the pattern and counts what else it matches, so that
  is a choice rather than an accident. It also warns when an earlier rule
  already shadows the new one, since the first matching rule wins and the
  button would otherwise appear to do nothing.

- **An Amazon label no rule matched is left unfiled, not filed under the
  default.** v1.18.0 filed everything, which buried a mis-guessed category
  where nothing showed it. An unmatched label is now reported and left in the
  needs-a-category list — which is exactly what the "N need a rule" count in
  the Amazon card is for. Setting a category (in the card, or with the
  **Change: <label>** button) makes it file from then on.

## [1.19.0] - 2026-08-21

### Added

- **Teach the sync what a transfer is, from Telegram.** The import notice now
  carries **↔ Mark one as a transfer**. Tap it, pick the transaction, and a
  matching rule is written — the next sync retypes that transaction *and*
  every future one like it, so it stops counting as spending.

  This exists because a keyword list can never be complete. v1.18.1 widened
  the built-in patterns for card payments, but the case that prompted it was
  `Payment to Ccb Credit Card Payments`, where "Ccb" is Coastal Community Bank
  — a string no list would have contained. One tap handles whatever the
  patterns miss, permanently, for any wording your bank happens to use.

  The rule is the payee wording with trailing reference numbers dropped, so it
  matches the next payment rather than one day's reference. Direction is taken
  from how the transaction imported, never guessed. Rules are appended, so
  anything you wrote by hand keeps its precedence, and everything remains
  editable under **Advanced → Transaction Rules**.

## [1.18.1] - 2026-08-21

### Fixed

- **Paying a credit card from a bank account is recognised as a transfer, not
  spending.** Only the receiving side was: a payment landing ON a card was
  typed as a transfer, while the money leaving the bank account was typed as
  an ordinary purchase. Found live — payments to a Discover card and to "Ccb"
  (Coastal Community Bank, the Robinhood card's issuer) added $228 to a
  month's spending, while payments to the same user's Citibank card behaved
  correctly, because a hand-written rule already typed those.

  Typing also gates transfer pairing, so this is what lets the two legs link
  and show as *in transit* rather than sitting as an unexplained withdrawal.

  Kept deliberately narrow: only phrasings that cannot describe an ordinary
  bill (`credit card payment`, `card payment`). A bare "payment" still means
  spending, because rent, utilities and insurance all describe themselves that
  way — and `autopay` is excluded for the same reason. Whatever this misses,
  a mapping rule in **Advanced → Transaction Rules** still overrides it.

## [1.18.0] - 2026-08-21

### Fixed

- **Amazon charges are now actually filed into their category.** The feature
  stopped one step short of its name: a matched charge got its label written
  into the description (`… · Amazon: Skincare`) and the label→category mapping
  was recorded and announced — but nothing ever put a category on the
  transaction. It assumed a Wealthfolio categorisation rule would match that
  description, and nothing creates those rules either, so every Amazon charge
  landed uncategorised while the addon reported the category it *would* have
  used.

  Each sync now files uncategorised Amazon-labelled charges from the last 60
  days, so ones stranded by the old behaviour are picked up too, not just new
  ones. A **mixed-category order is deliberately left alone** — one charge
  covering $190 of electronics and $10 of groceries has no honest single
  category, and belongs in the needs-a-category list for you to split.

- **The weekly check-in moves to Sunday 8pm** (was Saturday 9am). Both reports
  define a week as Monday–Sunday, so a Saturday send summarised a week with
  two days still to run: the check-in would arrive, and the next two daily
  digests would go on showing leftover for that same week. Sunday evening is
  the last useful moment inside the week — the figures are effectively final,
  and it lands while there is still time to act before Monday.

  Set `WEEKLY_REPORT_SCHEDULE` if you want a different time; an explicit value
  in your compose file is unaffected by this change.

## [1.17.1] - 2026-08-21

### Fixed

- **Spending with no category now counts toward the monthly total.** Every
  other figure in the reports is per-category, and the query behind them
  joins the category table — so a charge you have not filed yet was invisible
  to all of them, while Wealthfolio counts it against the same month. That
  was the last of the gap between the report and the app.

  It appears as its own line, with the count, rather than being folded
  silently into a total:

  ```
  ❓ Uncategorized  $21 · 2 charges with no category
  ```

  **Internal transfers are excluded**, which is the whole difficulty: a
  transfer between your own accounts cannot be categorized in Wealthfolio, so
  it looks exactly like an unfiled charge. Counting those would have reported
  $3,210 of "spending" for a month whose real unfiled total was $20.76 — the
  difference being a savings transfer and two card payments.

  Governed by the same **Spending with no budget** setting as off-budget
  spending, since it is the same question; either way it stays visible.

## [1.17.0] - 2026-08-21

### Added

- **Change an Amazon label's category straight from Telegram.** The notice
  announcing a new Amazon label now carries a **Change: <label>** button per
  label. Tap it, pick a category, done — the override is saved and every
  future order with that label files there. Previously the notice told you
  where an order had landed and left the only fix in the app, which is the
  trip the notice exists to save.

  Main categories only, matching the rest of the feature: every built-in
  Amazon rule targets a top-level category, so the picker offers exactly the
  ones your Wealthfolio has (falling back to the built-in list when the
  companion has no database mount). Charges already imported keep the
  category they were given; the override applies from the next one on.

## [1.16.1] - 2026-08-21

### Fixed

- **Report spending now matches what Wealthfolio itself shows.** The
  companion's spending query implemented a simplified version of the app's
  classification — `WITHDRAWAL`, `FEE`, `TAX` and nothing else — which
  disagreed with the app in three ways, all of them over-reporting what you
  had spent:

  - A **reimbursement, refund or rebate** credit on a cash account reduces the
    category it is filed under in Wealthfolio. The reports ignored it. Found
    live: Food & Dining read **$157.16** in Telegram against **$16.35** in the
    app — a $140.81 gap made entirely of Venmo paybacks, the exact rows v1.14.0
    taught Wealthfolio to treat this way while this query was never told.
  - **Any credit on a credit-card account** is a refund in Wealthfolio,
    whatever its subtype. A $14.42 statement credit went uncounted.
  - `TRANSFER_OUT` on a cash account and `INTEREST` on a credit card are
    spending in Wealthfolio, and were not counted at all.

  All four report types read through that one query, so the daily digest, the
  weekly check-in, the monthly wrap-up and the biggest-spends list were every
  one of them affected. Refunds are netted off the category totals but kept
  OUT of "biggest spends", which answers where money went, not where it came
  back from.

- **A reimbursement is no longer counted twice.** These rows carry two
  category assignments — an income one and a spending one — and the query
  joined every taxonomy, so the same amount appeared under two different
  category names. It now reads the spending taxonomy alone.

## [1.16.0] - 2026-08-21

### Changed

- **Spending in categories you have not budgeted now counts against the daily
  report's "left this month".** It did not before, which meant a $68 charge in
  an unbudgeted category left the headline still promising $135 to spend —
  money that was already gone. The old behaviour was defensible if you read
  that line as *budget headroom*; it is wrong if you read it as *money still
  available*, which is what the words say.

  The figure now says so explicitly, e.g. `💰 $67 left this month · after $68
  off budget`, and the "Off budget" list is unchanged, so the subtraction can
  always be reconciled against it. This also makes the daily agree with the
  **weekly** check-in, which has always counted this spending — the two used
  to disagree about the same month.

  If your unbudgeted categories are deliberate exclusions (investments being
  the case this was kept for), set **Notifications → Report content →
  Spending with no budget** to *Listed only, does not count* to restore the
  previous sum.

### Added

- `PRIVACY.md`, describing exactly what each service receives — required for
  the Wealthfolio community addon directory listing.

## [1.15.2] - 2026-08-16

### Fixed

- **Transactions imported by the addon are now announced on Telegram.** The
  import notice existed only in the companion, on the assumption that the
  companion does the importing. It does not always: the addon imports
  whenever you press **Sync now**, and whenever its in-page schedule fires on
  a Wealthfolio tab left open. Anything imported that way — including the
  first sync of a newly-mapped account, which is usually a backlog — was
  announced nowhere, and the "needs a category" prompt that rides along with
  the notice never arrived either.

  The addon now sends the same notice, using the same formatter, so the two
  are indistinguishable in the chat. Two deliberate differences: it carries no
  inline buttons (the *Categorize these* button is scoped by state that lives
  in the companion's process, so a button drawn from this side would open the
  wrong rows), and no "filed under" read-back (that comes from the companion's
  direct database read). Honours `notifyOnImport`, and a config saved before
  this existed counts as opted in.

## [1.15.1] - 2026-08-15

### Fixed

- **You can now say an account should not be synced.** v1.15.0's "not mapped
  to Wealthfolio" banner had no dismissal, on the assumption that an unmapped
  account always means something is wrong. It does not: an account you have
  no intention of tracking is a perfectly good steady state, and the banner
  nagged about it permanently with nothing to do about it. **Don't sync
  these** on the banner records that decision — it also stops the companion's
  Telegram notice for those accounts — and **Advanced → Accounts** lists what
  you have excluded and can put it back. Mapping an account removes it from
  that list automatically.

## [1.15.0] - 2026-08-15

### Added

- **Add or remove accounts without re-running setup.** An account linked at
  SimpleFin *after* setup was skipped in silence: the sync reported success,
  imported nothing from it, and the only evidence was an account that never
  appeared in Wealthfolio. Mapping it meant Reset, which clears every other
  setting. **Advanced → Accounts** now re-reads the live SimpleFin account
  list and maps against it, leaving the rest of your configuration alone.
  Clearing a row stops syncing that account; transactions already imported
  stay.
- **A newly-linked account announces itself.** The Overview shows a banner
  naming any SimpleFin account nothing is mapped to — with a button that
  opens the Accounts card — and the companion sends one Telegram notice the
  first time it sees each one. Neither can be missed the way silence was.

### Fixed

- **A scheduled Telegram report is no longer lost to a momentary network
  failure.** The daily, weekly and monthly reports retry twice before giving
  up; previously a single `fetch failed` discarded the entire period's
  report, with the next attempt a full day (or week, or month) away.
- **Pushes to `main` now build-check the companion image**, so a broken
  Dockerfile surfaces before release day rather than on it, and a prerelease
  tag no longer moves `:latest`.
- **README:** the example compose file mounted the `.db` *file*, which hides
  the `-wal` file beside it and can serve data days stale. It mounts the
  containing folder now, sets the required `TZ`, and documents upgrading by
  pulling the published image rather than building it.

## [1.14.1] - 2026-08-11

### Fixed

- **A sync that imported transactions could fail to send the Telegram import
  notice and say nothing anywhere.** New transactions would appear in
  Wealthfolio with no message and no way to find out why one never arrived.
  The failure is now logged with the count of transactions it covered, and,
  when Telegram itself rejected the message, Telegram's own reason. This
  makes the failure visible — it does not prevent it; the original cause of
  any given failure is still whatever it always was (a database lock, a bad
  chat id, a blocked bot, rate limiting), just no longer silent.

Needs the companion rebuild; the addon zip changes only its version string.

## [1.14.0] - 2026-08-11

### Added

- **Transaction rules can mark a payback as a reimbursement.** A rule now sets
  an activity's subtype as well as its type, so "Venmo Transfers" can import as
  a CREDIT marked REIMBURSEMENT. Wealthfolio then treats it as money that
  reduces whatever category you file it under, instead of income — which is what
  a friend paying you back for dinner actually is. Set it in Advanced →
  Transaction Rules.
- **The rule applies to transactions already imported**, not just future ones:
  the next sync updates matching rows in place, so you fix a recurring payback
  once instead of per transaction.

### Changed

- `/recategorize` now refuses a move Wealthfolio would reject, and says why —
  pointing to Advanced → Transaction Rules, where marking the payback a
  reimbursement is what makes the move possible — instead of clearing the old
  category first and failing afterwards.
- Removing a subtype from a rule does not take effect on transactions already
  imported: the sync only ever adds a subtype, never removes one, so it can't
  be confused with a subtype you set by hand in Wealthfolio. Those have to be
  changed in Wealthfolio directly.
- Undo is not offered after a move when the transaction can no longer hold
  what it had before the move — putting the old category back would be a
  write Wealthfolio refuses. This replaces what 1.13.0's notes described for
  that same move.

Needs the companion rebuild AND the addon zip, since both halves change.

## [1.13.0] - 2026-08-11

### Added

- **/recategorize — fix a filed transaction from Telegram.** Lists recent
  transactions with their current categories; /recategorize venmo narrows to
  matching ones. Tap a transaction, tap the right category, done — with an
  Undo that restores every assignment the move cleared, not just the one
  category shown. Moving a payment out of an income category (a Venmo payback
  filed under Reimbursements, say) into a spending category clears the income
  side in the same act, so it offsets that category's budget instead of
  counting as income — the confirmation says so.
- **The import notice now shows where each transaction was filed** ("→ filed
  under Groceries"), read back from the database after the import so rules are
  reflected, plus a Recategorize button scoped to just that import.

### Fixed

- **Undo after filing verifies before it un-files.** Both menus now check that
  a transaction's category is still the one they set before undoing, so an
  Undo can no longer erase a category someone set elsewhere in between — a
  known blind spot since 1.12.0.

Needs the companion rebuild; the addon zip changes only its version string.

## [1.12.0] - 2026-08-10

### Added

- **/categorize — file transactions without leaving Telegram.** The bot lists
  what needs a category as tappable buttons; tap a transaction, tap a category
  (subcategories included), done — one message that edits itself in place,
  with Back buttons all the way down. You can dismiss ("keep uncategorized")
  from the same menu, and both paths offer Undo. Every write goes through
  Wealthfolio's own spending API — the companion's database access stays
  read-only.
- **Make it a rule, from the confirmation — or from thin air.** After filing
  something, one tap previews and creates a categorization rule (priority 50,
  below your hand-made rules). Or type one directly: `/newrule trader joes =
  groceries` — plain text matching, no patterns to learn, same
  preview-before-create. Either way Wealthfolio then also files any other
  *uncategorized* matches — it never touches transactions that already have a
  category.
- The import notice's needs-a-category list now ends with a **Categorize
  these** button that opens the same menu.

### Changed

- Categorizing or dismissing from Telegram updates the addon's "Needs a
  category" tile within about a minute, instead of at the next sync.

Needs the companion rebuild; the addon zip is unchanged apart from the
version string.

## [1.11.0] - 2026-08-10

### Added

- **The Telegram bot now answers.** Six commands, listed in Telegram's ☰ menu:
  /report (today's digest, fresh from the database), /left (what's left per
  category — /left groceries narrows it), /afford 20 shopping (before/after for
  the week and month, with a verdict), /status (last sync, balances, what needs
  attention), /sync (pull new transactions now), /help. Commands work only from
  your configured chat and answer in a second or two.

  /report works even if you have the 8am daily digest switched off — asking for
  one now is a different question from wanting one every morning. /sync always
  forces a fresh pull, the same as the addon's Sync Now button, so a command
  typed minutes after a scheduled sync still fetches. It acknowledges
  immediately and reports the outcome when the run finishes, so a sync in
  progress never stops the bot answering anything else. /status now says when
  accounts have no balance yet, instead of quietly leaving them out of the list,
  and says when a signal could not be read rather than reporting it as absent.

  Needs the matching companion rebuild — the bot lives entirely in the
  companion, so a zip-only reinstall shows v1.11.0 with a bot that answers
  nothing. Against an older companion the addon behaves exactly as before.

### Changed

- **Dismiss buttons act immediately.** The companion now listens to Telegram
  continuously instead of collecting button presses at the next sync, so
  dismissing an uncategorized transaction takes effect within a second instead
  of within six hours. Same ledger, same rules — just no waiting.

## [1.10.2] - 2026-08-09

### Fixed

- **Amazon changed their order-email format, and categorization silently stopped.**
  The new emails no longer carry the category line in their plain-text part (it
  now exists only in the subject and the HTML), the total lost its dollar sign
  (`4.23 USD` instead of `$4.23`), and every email gained a shipping progress
  tracker whose bare `Out for delivery` line made order confirmations look like
  ignorable delivery notices — so they were skipped and marked read without a
  word. Classification now reads the subject, the plain text, AND the HTML part
  (Amazon has yet to change all three at once), understands both total forms, and
  the delivery-notice check only accepts wording a real notice actually uses.
  Fixed against the raw captured emails, which are now sanitized test fixtures.

### Added

- **The addon now tells you when Amazon mail stops parsing.** Unreadable emails
  deliberately stay unread in the mailbox; that count now surfaces as a warning
  on the Amazon card (and in its collapsed summary) instead of only in a server
  log. It clears itself on the first clean scan. The failure above was invisible
  for two days; this is what would have made it loud on day one.

### Changed

- **The "Needs a category" tile is now the dropdown.** v1.10.1 shipped the tile
  and a separate disclosure bar underneath saying the same number twice; the tile
  itself now expands into the transaction list, and the extra bar is gone.

## [1.10.1] - 2026-08-09

### Added

- **You can now see and dismiss what needs a category.** The Overview tile
  reported a number with nothing to act on, so a transaction you had
  deliberately decided to leave uncategorized counted forever. The tile now opens
  into the actual transactions — date, description, amount, account — each with a
  dismiss control, and dismissing takes effect immediately rather than waiting up
  to an hour for the companion's next sync. A short undo window follows each
  dismissal, because without one a misclick silently hides a transaction for 60
  days. For the ones worth categorizing, a **Categorize in Wealthfolio** button
  opens the Activities page, where a category can actually be set.

  Dismissals share the same ledger the Telegram notice's buttons already wrote,
  so a dismissal holds in both places. Behaviour matches what Telegram already
  did: keyed by transaction, kept 60 days.

  Needs the matching companion rebuild — the addon SDK exposes no category data,
  so the list can only come from the companion. Against an older companion the
  tile still shows its count, just without the list.

### Fixed

- **The needs-a-category tile ignored dismissals.** The Telegram sweep filtered
  them out; the tile did not, so a transaction dismissed from Telegram still
  counted. Harmless while nobody used those buttons, and the exact reason the
  addon's own dismiss button had to come with this fix rather than after it.
- **A reset left the dismissal ledger behind.** `uncategorized_dismissals` was
  not registered in the map `clearAll()` iterates, so it survived a reset that
  said it cleared everything — the same gap that previously left an Amazon
  mailbox password in storage.

## [1.10.0] - 2026-08-09

### Added

- **A self-completing setup checklist** on Overview, covering the three
  optional features — background sync, Telegram alerts, Amazon
  categorization. Each row ticks itself off a real stored signal (a
  companion version, a saved Telegram token, a saved Amazon config) rather
  than tracking wizard progress, so it can't say "done" when the underlying
  setting was reset, or "not done" when it was configured some other way.
  Dismissible once you no longer need it.
- **A "Needs a category" tile** on Overview, counting uncategorized spending
  from the last 90 days. The addon SDK exposes no category data at all, so
  the companion now publishes the count itself on every sync
  (`uncategorized_status`); the tile stays hidden until a companion has
  actually published a count, rather than showing a misleading zero to
  anyone not running one yet.

### Changed

- **The addon is reorganized into three tabs — Overview, Notifications,
  Advanced — with the active tab persisted.** Overview is the daily glance:
  alerts only when something needs you, the setup checklist, stat tiles, and
  accounts. The old single Telegram mega-card is now three focused cards in
  Notifications, sharing one save bar that appears only once something is
  actually dirty. Advanced holds Auto-sync, Docker, Amazon categorization,
  transaction rules, and Reset connection — which keeps the two-step
  confirmation it already had, now inside a marked-off destructive boundary
  with a title and a description of what it actually clears.
- **New dashboard look**, built mostly on Wealthfolio's own theme variables,
  so light and dark still follow whatever the host is set to (a few accent
  hues and shadows are the addon's own). No emoji anywhere in the chrome — icons
  only — and this is now enforced by a test that renders every surface,
  including the first-run setup page, and fails on any emoji or the phrase
  "(optional)".
- **Plainer language throughout.** "Deep scan" replaces "Reconcile & link"
  (the technical term survives in the button's tooltip for anyone who knows
  it from the logs or old docs), "off by $X" replaces drift, and "opening
  balance" replaces starting balance. The underlying stored data markers
  were deliberately left untouched — only display copy changed, so nothing
  about how data is written or matched shifted underneath the wording.

### Fixed

- **"Reset everything" left the Amazon mailbox app password sitting in
  storage.** Three secret keys (`amazon_config`, `amazon_labels`,
  `amazon_order_ledger`) read and write their key constants directly instead
  of going through the map `clearAll()` iterates, so a reset that claimed to
  clear everything quietly skipped all three — a real credential survived a
  reset that said it removed it. The same gap left a stale "needs a
  category" count on screen afterward. All three keys are now registered and
  cleared like everything else.
- **The reset confirmation understated what it does.** It said reset "clears
  the account mapping"; it actually clears every setting — connection,
  account mapping, sync schedule, transaction rules, and any Telegram or
  Amazon setup. The copy now lists what's actually cleared, so nobody
  confirms expecting to keep something that's about to be wiped.
- **A Telegram stuck-transfer alert told users to press a button that no
  longer exists**, saying to try "Reconcile & link" when that control is now
  named "Deep scan". Fixed in the alert text itself and in the README
  references that still named the old label.
- **The setup checklist could claim background sync was unconfigured for up
  to a minute after opening the page.** The companion's version was only
  re-read on the 60-second refresh timer, not when the page first mounted,
  so opening the page against a perfectly healthy companion could show the
  background-sync row unticked until the first refresh caught up.

## [1.9.0] - 2026-08-08

### Added

- **`amazon-descriptors`**, a read-only check for the one assumption in Amazon
  categorization that no fixture can test: whether the matcher recognises *your
  bank's* Amazon descriptor. That string is whatever the issuer writes and varies
  between them — `AMAZON.COM*MB3T81`, `AMZN Mktp US*XY7Q2`, `AMAZON MKTPLACE PMTS`
  are all real — and if the pattern misses the form a user actually gets, nothing
  matches and there is no error at all. Amazon charges simply stay uncategorized,
  indistinguishable from never having set the feature up.

  It casts wider than the matcher does and shows both lists, so the gap between them
  is the answer. Prime/AWS appearing under "not recognised" is correct and the output
  says so.

  ```
  docker exec simplefin-sync node dist/companion/src/amazon-descriptors.js
  ```


- **Automatic categorization of Amazon charges.** A bank charge reads
  `AMAZON.COM*MB3T81` and says nothing about what you bought, so every Amazon
  purchase landed uncategorized. Amazon's order emails *do* name the category, so
  forwarding those to a throwaway mailbox lets the companion label each Amazon
  charge on its way in — `AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · TRN-…` — and
  Wealthfolio's own rule engine files it from there.

  Set up in the new **Amazon auto-categorization** card, below the Docker card:
  three fields, one Gmail filter, one throwaway address. No new container — the
  mailbox is read at the start of each sync, since that is the only moment the
  data is used. Entirely optional; an empty ledger is the off switch.

  Labels are matched by **pattern, not by lookup table**. Amazon's label
  vocabulary is unpublished, includes mid-level categories (`Baking`, `Skincare`)
  as well as departments, and grows whenever Amazon feels like it — so ~12 regex
  patterns cover more ground than 200 exact entries, and a label invented next
  month (`Vitamins & Supplements`) files itself with no change. Anything unmatched
  goes to a configurable default *and* is announced once in Telegram, so it is
  visible and one rule away from correct rather than silently wrong. The card
  lists the labels your own orders have actually used, with a dropdown to fix any
  that were filed wrong.

  **This cannot double-count a purchase.** Order emails never create a
  transaction — they only add text to the comment of a row SimpleFin itself
  imported. An email with no matching charge does nothing at all and is pruned
  after 90 days. Amounts, types and dates are never touched, and where two Amazon
  orders share an amount inside the window, neither is applied: an ambiguous match
  is worse than none, because a wrong category is invisible while a missing one
  shows up in the needs-a-category sweep.

- **`amazon-check`**, a read-only diagnostic. The two ways Amazon categorization
  can silently do nothing — a mailbox that will not connect, and a message shape
  the parser does not recognise — look identical from the outside, so this connects,
  parses whatever is unread, and prints the category each order would get. It marks
  nothing read and records nothing, so the real poll still picks the messages up:

  ```
  docker exec simplefin-sync node dist/companion/src/amazon-check.js \
    --host imap.gmail.com --user you@gmail.com --password 'xxxx xxxx xxxx xxxx'
  ```

- **`companion/scripts/amazon-rules.mjs`**, a one-time helper that inserts the
  Wealthfolio categorization rules for your discovered labels. Dry-run by default,
  introspects the real schema instead of hard-coding an INSERT, and refuses to
  write while Wealthfolio is running.

### Changed

- **An account that could not be checked now says "not checked", not "in sync".**
  The account list showed a green *in sync* chip whenever no drift was reported —
  but "no drift reported" covers both *the two balances were compared and matched*
  and *they could not be compared at all* (a pending transaction, a run that
  reconciled anything, a pruned duplicate, a create the host refused). The second
  case was claiming a verification that never happened, and it is how two phantom
  drift episodes on one account were read as verified balances.

  The snapshot now carries `measured`, so the three states render distinctly: `off
  by $X` (a real figure), `in sync` (compared and matched), and a muted `not
  checked` with an explanation on hover. Deliberately neither green nor red —
  absence of information should not be coloured like a verdict. A snapshot written
  by an older build reads as not checked, since it proves nothing about the current
  state either.

### Fixed

- **A refused create produced phantom drift equal to its own amount.** `windowDelta`
  — the term that keeps a heal run's drift measurement lag-free — is computed from
  `plan.creates`, i.e. what the sync INTENDS to write. It assumes every planned
  create lands. Seen live: a re-authorised bank re-issued one $1,300 transaction
  under a new id, Wealthfolio refused the create as a duplicate, and the account
  reported $1,300 of drift while its ledger matched the bank to the penny
  (`sfBalance: 3014.78, wfValuation: 3014.78, windowDelta: -1300`).

  Such a run is now declared **not measurable** — the meaning `null` already carries
  here, and what every normal sync with creates already does — and any drift episode
  it opened is rolled back, so a phantom cannot announce itself or leave state a
  later run has to reason about. The next run measures accurately against a fresh
  valuation. The heal path still measures drift when its creates all land.

- **`adjustStartingBalanceForOlderRows` could net out a create that never landed.**
  It rewrites the starting balance, so a refused row moved real money for a row that
  does not exist. Previously shielded by the error a duplicate refusal raised — which
  the fix above (correctly) stopped raising — so it now filters on what actually
  landed.

- **A thrown bulk save discarded the whole account's batch.** The row-by-row
  fallback added in 1.8.0 only handled a host that RETURNS `{errors}` — the
  companion's REST adapter. The addon's SDK adapter lets
  `ctx.api.activities.saveMany` throw, so on that path the very first call threw,
  escaped to the per-account catch, and every good row in the batch was lost.
  Surfaced as one red `Account … failed: Duplicate activity detected`, naming the
  symptom and hiding the damage. Hit live when a bank came back online and
  republished history. A thrown save is now normalised into the same shape as a
  reported one, so the fallback runs on both hosts.

- **A duplicate refusal is no longer reported as a failure.** "A matching activity
  already exists" means the row is there — the create's goal is met. A red banner
  over it sends the user hunting transactions that were never lost, and buries the
  refusals that are real problems. Still logged (grep `duplicate-refused`) with the
  transaction named, since reconciliation not recognising an existing row means the
  tx-id match missed or something outside this addon wrote it.

- **The feed-lag banner asserted a direction it had not checked.** It read "is ahead
  of SimpleFin's feed" for either sign, off `Math.abs(drift)`. Positive drift means
  the bank is ahead of its own feed — genuine lag, clears itself, which is what the
  reassuring copy is for. Negative means Wealthfolio holds MORE than the bank, which
  lag cannot cause and which does not clear on its own, so "this typically clears in
  a few days" was advice to wait out a real problem. Each direction now gets its own
  explanation, and the negative one explicitly says not to add a plug.


- **Delivery notices are now skipped as expected rather than counted as failures.**
  A delivery notice names the categories but restates no price — Amazon billed on
  shipment — so it can never be matched to a charge. They were being treated as
  parse failures, which meant left deliberately unread so a real format change stays
  visible. But every order produces one, so the mailbox would fill with
  permanently-unread mail, re-read on every sync, burying the one signal that says
  the parser actually broke.

  The check excludes the word "arriving" on purpose, even though delivery notices use
  it: order CONFIRMATIONS say `Arriving Monday` a few lines above their Grand Total,
  so matching on it would file a confirmation whose total stopped parsing as an
  ignorable notice — making a real format change invisible, the one outcome this must
  never produce. It also requires the total to be genuinely absent, so a notice that
  starts carrying one becomes usable again.

- **Forwarded order emails land in Spam, and the poll only read INBOX.** Amazon's
  own message arriving from a different account is exactly the pattern spam
  heuristics dislike, and it happened on the very first test forward — so those
  orders were invisible, which is indistinguishable from "the parser broke" and is
  the kind of wall a user hits before they have any reason to trust the feature.
  The poll now scans INBOX *and* the spam folder. A `never send it to Spam` filter
  on the receipts mailbox is still worth adding — Google deletes spam after 30 days
  — and the setup guide asks for one, but forgetting it no longer breaks anything.

  Flagging messages read is now keyed by **mailbox and uid**, not uid alone. IMAP
  uids are scoped per mailbox, so uid 5 in Spam and uid 5 in INBOX are different
  messages; the old code would have marked the wrong one read the moment a second
  folder was in play — re-ingesting one order forever while hiding an unrelated
  message from the next poll.

- **Three-plus-category Amazon orders were dropped entirely.** The body form for
  those is `6 items: 1 Home Improvement, 1 Bath, and 4 others` — count first, line
  ending in "others" rather than "items", and a per-category count on each entry.
  The original pattern required the line to END with `item`/`items`, so it matched
  nothing and every such order was silently skipped. Now parsed, with `4 others`
  recorded as "part of the list was withheld" rather than treated as a category
  called "other".

  Worth recording that the subject line is a *third* wording (`6 Home Improvement,
  Bath, and other items`), so a pattern written from the subject — as the first fix
  attempt was — produces something that never matches the body it has to read.

- **A mixed order no longer fires a single-category rule.** Wealthfolio matches
  rules on substrings, so `Amazon: Home Improvement + Bath` would have triggered
  the `Amazon: Home Improvement` rule and filed the whole charge under Housing. The
  per-label amounts do not exist in the email, so that is a guess — a $200 order
  could be $190 of electronics and $10 of groceries, or the reverse. Mixed orders
  are now written `Amazon: mixed — Home Improvement + Bath + more`, which no
  single-category rule can match, so they keep their readable categories and reach
  the needs-a-category sweep for a human to split.

- **Hand-forwarded order emails are now accepted.** Gmail's "also apply filter to
  matching conversations" does not forward existing mail, so seeding the mailbox or
  testing the setup at all means forwarding a few by hand — and a hand forward
  rewrites `From:` to the forwarder, which the envelope-only sender check rejected.
  The `From:` line inside the forwarded block now counts. The parser is still the
  real gate, so mail that merely mentions Amazon yields nothing.

### Note

- **Amazon itemization is not possible**, and this is not a limitation of the
  addon. Until 2026-07-08 the order emails carried item names, quantities and unit
  prices; Amazon removed all of it, leaving a category label, a total and an item
  count. Splitting one charge into per-item rows needs per-item prices, so that
  half of the original idea is dead at the source. Category tagging is what
  remains — and it needs no splitting, which is also why it cannot affect
  reconciliation.

## [1.8.2] - 2026-08-07

### Fixed

- **Scrolling the emoji panel closed it.** 1.8.1 closes the panel on page scroll,
  because its coordinates are fixed and would otherwise drift away from the button
  — but that listener is capturing, so it also saw the panel's own scroll and shut
  it the instant the user reached for an emoji further down, dragging its scrollbar
  included. Scrolls originating inside the panel are now ignored; a scroll anywhere
  else still closes it.

## [1.8.1] - 2026-08-07

### Fixed

- **The emoji picker never appeared.** Clicking a category's emoji toggled the
  button but showed nothing: the panel was rendering and then being clipped out of
  existence by two ancestors that set `overflow: hidden` for their rounded corners
  (`.sfin-disc-inset` and `.sfin-card--collapsible`), which an absolutely-
  positioned child cannot escape. It is now positioned in viewport coordinates
  taken from the button's own rect, which ancestor overflow cannot clip. It also
  flips above the button when there is no room below, clamps to the right edge, and
  closes on scroll or resize rather than floating away from the button it belongs
  to.

## [1.8.0] - 2026-08-07

### Added

- **Categories are grouped the way Wealthfolio groups them** — one collapsible
  section per budget group (Needs, Wants, Savings, Giving, Personal, Other), each
  showing how many categories it holds. Read from `budget_groups` and
  `budget_group_assignments`, so a group you add, rename or reorder in
  Wealthfolio appears here on the next sync with nothing hardcoded on our side;
  the same is already true of categories. A category no group claims lands under
  `Ungrouped` rather than disappearing, because Wealthfolio permits that state.
  Group order follows Wealthfolio's own `sort_order`, not alphabetical.

## [1.7.2] - 2026-08-07

### Changed

- **The category selector lists parents only.** Wealthfolio budgets at the parent
  level — its own Spending Tracker has no subcategory amount field — and the
  reports aggregate children into their parent, so a per-child checkbox controlled
  nothing a report could act on while making the list 52 rows long. Subcategory
  detail now lives solely in the `Break down under the parent` report mode, and the
  hint says so and counts how many are hiding in there.
- **Per-category emoji is a palette, not a text field.** The input assumed the user
  knows how to type an emoji on their platform; it is now a click-to-pick grid of
  ~80 budget-relevant glyphs grouped by theme, with a `Default` option to clear an
  override. Curated rather than a picker dependency, because the addon runs in a
  sandboxed iframe under a strict CSP.
- **The emoji column disappears entirely in `Clean` mode**, where an override does
  nothing — and where the old input's `—` placeholder read as a missing budget
  figure rather than an empty setting.
- **Overrides apply in `glyphs` mode only.** They previously applied in both, which
  made `Clean` a lie: a report could carry glyphs while the setting said none. One
  rule is easier to hold than an exception.
- The `Report icons` label now reads `Telegram report icons`, since it never
  affected the addon's own icons — those always come from Wealthfolio.

## [1.7.1] - 2026-08-07

### Fixed

- **`DEPOSIT` is not a valid activity type on a credit card**, and the in-transit
  placeholder used it — so an unpaired card payment (an AUTOPAY arriving at a Citi
  card) was refused every sync with `Invalid data: DEPOSIT activities are not
  supported for credit card accounts`. The old reasoning was that DEPOSIT is safe
  on a card because the spending classifier ignores it: true, and beside the point,
  since the API rejects the type before anything classifies it. Cards now use the
  same `CREDIT` shape as cash accounts — demonstrably accepted, since Wealthfolio
  writes `CREDIT` rows to that account itself — which is spending-neutral in both
  directions. 1.6.1's row-by-row fallback is what surfaced this cleanly instead of
  failing the whole account's batch.
- **The category catalog was only published when a report ran**, so a fresh
  deployment showed the legacy budget-or-spent list — no icons, no subcategories —
  until the next morning's 8am report. It is now published on every sync, which is
  where it belongs: what categories exist has nothing to do with report
  scheduling.

## [1.7.0] - 2026-08-06

### Added

- **Every category is now selectable, not just budgeted-or-spent ones.** The
  addon's list came from a companion-published union of this month's spending and
  budgets, so a category like Personal Care could not be chosen until money
  happened to move through it. A new catalog publishes all of them with their
  parent, and reports keep printing only the ones with a budget or spending — two
  separate questions, now answered separately.
- **Categories carry Wealthfolio's own icons and colours** in the addon. Those
  come straight from `taxonomy_categories.icon`, which holds lucide-react export
  names, so there is no mapping of ours to drift and a category Wealthfolio gives
  a new icon to simply renders. The selector is grouped, with subcategories
  indented under their parent — 52 rows flat was unreadable.
- **A subcategory display toggle.** `Roll up into the parent` is unchanged and
  remains the default; `Break down under the parent` lists children beneath the
  parent's envelope line, spend-only and biggest first, so a Transportation
  budget can show where the money actually went.
- **The companion reports its version** in its startup banner and to the addon,
  which shows both halves in its footer and flags a mismatch. `shared/version.ts`
  is now the single source, pinned by a test against `manifest.json` and
  `package.json`. Previously the only honest way to identify a running companion
  was grepping compiled JavaScript, because `companion/package.json` is a
  dependency manifest that has read `1.0.1` since the project began.

### Changed

- **Reports are clean by default.** The decorative glyphs are gone — no sun over
  the daily check, no moneybag on the summary, no label on every category line.
  Glyphs that encode STATE remain, because Telegram renders neither colour nor
  Wealthfolio's icons and they are the only way left to mark a line: `🚨` over
  budget, `⚠️` over the week's pace, `⏳` waiting on the bank feed. `Emoji per
  category` restores the old style, and any single category can be given a glyph
  in either mode.
- **The Sync page stays current.** It re-reads last-synced, balances and the
  companion version on window focus and every 60 seconds. It previously rendered
  once, so a tab left open froze — on 2026-08-06 it showed a day-old sync time and
  an already-resolved error, prompting a hunt for a fault that no longer existed.

## [1.6.1] - 2026-08-06

### Fixed

- **One un-importable transaction could silently strand an entire account's
  import.** Wealthfolio's bulk save endpoint is all-or-nothing: a single row it
  considers a duplicate discards the whole batch. The run still completed and
  reported `0 imported`, indistinguishable from a day with no activity, so
  nothing surfaced. Found live on a Citi card holding two legitimately
  identical same-day charges — the same merchant for the same amount twice,
  which Wealthfolio's duplicate detection cannot tell apart because it does not
  key on the SimpleFin transaction id.

  A refused batch is now re-sent one row at a time — deletes, then updates, then
  creates — skipping anything the batch already stored so a partial success
  cannot become a double-create. The reported errors name the specific row
  refused, with its description, instead of a bare batch failure. The happy path
  is unchanged at exactly one call.

## [1.6.0] - 2026-08-02

### Fixed

- **The companion's database reads were up to days stale.** It read
  Wealthfolio's SQLite file in `immutable` mode, which sees only data
  checkpointed into the main file — and a live instance was observed with
  **two days** of writes (2.4 MB) still sitting in the write-ahead log. Every
  consumer was affected: the needs-a-category sweep missed all recent rows
  (four uncategorized transactions went unreported on a live install), and the
  daily/weekly reports served days-old spending and budget figures. Reads now
  attach the WAL (`mode=ro`, with `readonly_shm=1` for the read-only mount),
  falling back to the old snapshot mode if the WAL files aren't visible.
  **Requires a compose change**: bind-mount the Wealthfolio *directory* rather
  than the bare `.db` file, so the companion can see `-wal`/`-shm`.

### Changed

- The needs-a-category sweep now covers income too — deposits, credits,
  interest, dividends — not just spending. A live user's interest payment and a
  card-points credit both wanted categorizing. Transfers stay excluded (they
  are classified by linking, not by category), as do all machine-written rows.

## [1.5.0] - 2026-08-01

### Changed

- **A young drift no longer looks like an emergency.** A drift that no
  transaction can explain and that appeared within the last 10 days is almost
  always the bank's balance running ahead of SimpleFin's transaction list —
  posted activity the feed hasn't published yet, which resolves itself in days
  (observed twice on a live account, at $1,300 and $490.75). That case now
  renders as a calm "waiting on the bank's feed" banner with **no Add button at
  all** — the red banner's one-click plug was a loaded gun that would
  double-count the moment the feed caught up. The red banner, the plug, and the
  `Fix baseline` offer return only once the drift has stood for 10 days.
  Drifts too small to alert (under the drift-alert threshold) keep the old
  immediate treatment — that's the small-divergence case the plug exists for.
- **Aggressive auto-heal respects the same 10-day gate.** It previously would
  have plugged feed lag automatically and then plugged the flipped drift again
  when the feed caught up — two garbage rows, no human involved. Small
  sub-threshold divergences still plug immediately.
- **The Telegram drift alert now matches the diagnosis.** A new episode sends
  an informational ⏳ notice naming feed lag as the likely cause and asking for
  nothing. If the same episode is still unresolved after 10 days, a one-time 🚨
  escalation with the original alarm styling follows.

## [1.4.0] - 2026-07-30

### Added

- The per-sync import notice now lists what arrived — description, amount, and
  account per transaction, with pending and in-transit rows marked — instead of
  a bare count. Gated by the same `notifyOnImport` toggle as before.
- The notice also carries a `🏷️ Needs a category` section: every spending
  transaction from the last 30 days with no category in Wealthfolio's spending
  tracker, however and whenever it was imported. Sweeping rather than flagging
  this run's rows makes the companion's read-snapshot lag harmless (a row
  invisible at send time is caught by the next notice) and covers transactions
  imported by the addon, which produce no notice of their own. Rows the sync
  itself writes — starting balances, adjustments, in-transit placeholders —
  are never nagged about.
- Each listed uncategorized row gets a Telegram **Dismiss** button, for a
  transaction deliberately left uncategorized. Presses are collected once per
  sync run, so a dismissal takes effect on the next notice rather than
  instantly; categorizing the transaction in Wealthfolio remains the natural
  way to clear a nag.

### Changed

- The daily spending digest now splits budgeted from unbudgeted categories:
  budgeted ones always render, unbudgeted ones appear under `Off budget:` only
  when money actually moved this month. A category with a leftover zero-amount
  budget row and no spending — previously rendered as `no budget · $0 spent` —
  no longer appears at all.

## [1.3.1] - 2026-07-30

### Fixed

- `Fix baseline` could blame the baseline for feed lag. A bank balance that
  already includes a posted transaction SimpleFin's transaction list has not
  reported yet produces the exact signature 1.3.0 read as a wrong baseline: a
  gap no stored transaction explains, constant across the whole window. Found
  live the day the feature shipped — the offer was taken, the feed caught up
  hours later, and the account double-counted $1,300. What tells the two apart
  is time: a wrong baseline has been wrong since the day it was written and
  never resolves itself, while feed lag clears in days. The offer now also
  requires the drift to have been standing for at least 10 days.

## [1.3.0] - 2026-07-30

Balance accuracy and transfer correctness, driven almost entirely by
discrepancies found on a live install. Every figure quoted below is a real one.

### Fixed

- One SimpleFin transaction id appearing in **two** accounts corrupted
  everything keyed by that id alone. SimpleFin issues a single id for both sides
  of a transfer between two accounts it can see end to end, so the two legs
  collapsed into one entry: a savings `TRANSFER_OUT` could be rewritten as a
  +$1,300 inflow carrying the other account's description, `linkPair` could be
  handed the same row twice, and an account's starting-balance baseline could
  take the wrong sign. Identity is now `(account, transaction id)` everywhere it
  matters. On the live install this had already half-linked three transfer pairs
  — one leg grouped, the other not — leaving $2,700 of transfers out counted as
  spending; a reconcile repairs them.
- A failed transfer link reported no reason. Linking deletes both rows before
  re-creating them, so a refused re-create loses financial rows, yet every host
  error was collected and then discarded behind a generic "could not be linked"
  that only appeared during a reconcile. The reason now travels with the failure,
  a silently dropped group says so explicitly, and both are reported on ordinary
  syncs too.
- The Docker companion could never repair a half-linked transfer pair. Its
  record of "already linked" was keyed by bare transaction id, so a shared-id
  pair collapsed to one entry that could not distinguish "both legs confirmed"
  from "only one leg was grouped". Entries are now per leg, while still reading
  the old format so existing records are neither lost nor needlessly re-linked.
- A SimpleFin payload that reported the same transaction twice for one account
  imported it twice. Both copies were planned as creates and landed in a single
  bulk request, which is the one place Wealthfolio's duplicate guard cannot
  compare rows against each other, so a savings account silently read $1,297.50
  low. Each account's transaction list is now collapsed to one entry per
  transaction id before anything is planned from it — preferring a posted copy
  over a pending one, and otherwise the last occurrence — and every dropped copy
  is logged. Deduplication is per account: one transaction id legitimately
  appears in two accounts as the two legs of an internal transfer.
- Budget targets read from Wealthfolio's database picked whichever row was
  edited most recently, so editing a category's `default` budget after setting
  a month-specific one silently reported the wrong number. Month-specific rows
  now always win, with `updated_at` only breaking ties between rows of the same
  kind.
- The monthly spending query had no upper date bound, so a future-dated
  transaction leaked into the current month's total.
- A transfer whose second leg had not posted at the bank yet counted as
  spending, because Wealthfolio only excludes a transfer once both legs are
  *linked* and a solo leg can never be linked. Unpaired transfer legs now
  import as spending-neutral placeholders that promote to a real linked
  transfer when the other leg arrives, or expire to ordinary spending after
  10 days if it never does.
- On the Docker companion, a promoted transfer leg kept a phantom `$CASH`
  asset (an update cannot clear a stored asset), which made the pair
  permanently unlinkable. Both syncers now share one delete-and-re-create
  linking path.
- Report messages no longer break when a category name, error message, or bank
  description contains Markdown characters — previously a single `_` or `*`
  could make Telegram reject an entire report.
- A corrupt addon secret no longer destroys a whole report or aborts alert
  delivery mid-run.
- Unchecking one report category could silently re-enable *all* of them, because
  the "everything selected" check compared list lengths rather than membership
  and the available-category list legitimately shrinks month to month.

### Added

- `↻ Reconcile & link` (and auto-heal) now removes activities that are surplus
  copies of a transaction the account already holds, keeping one of each. It
  reports exactly what it deleted — on the Sync page, as a Telegram message, and
  as a log line per row — because automatic deletion of a financial record must
  not be silent. Starting-balance baselines and balance-adjustment entries are
  excluded by their note prefixes and can never be swept, and only transaction
  ids the bank reported for that account on the same run are eligible.

- A drift that no transaction can explain is now attributed to the account's
  starting balance, and offered as a one-click correction rather than a plug.
  When a wide re-scan finds every transaction the bank reports already stored and
  already matching, nothing inside the window can account for the gap — so the
  remaining candidate is the baseline row that stands in for history the sync
  never saw, and the drift is exactly the amount it is wrong by. The Sync page
  shows `Fix baseline: $11,355.12 → $10,055.12` and demotes the balance
  adjustment to `(plug instead)`. Never applied automatically, and never offered
  while any transaction is still unaccounted for — folding a genuinely missing
  transaction into the baseline would hide it permanently.

  This came from two live accounts sitting $1,300 out in mirror image, one
  baseline overstated and the other understated, from a transfer in flight
  across two baselines captured five days apart. Both feeds reconciled
  completely; a balance adjustment would have been a four-figure fabrication
  about where the money came from.

- Two independent scheduled reports: a daily per-category spending check
  (`DAILY_REPORT_SCHEDULE`) and a weekly month-to-date summary
  (`WEEKLY_REPORT_SCHEDULE`, default Saturday). Previously one schedule existed
  and the weekly toggle was stored but never read.
- Per-report category selection, configured in the addon's Telegram section.
- Sync health tracking: a footer on the daily report, plus a one-time Telegram
  alert once syncs have been failing for 24 hours.
- A one-time alert when a transfer pair repeatedly fails to link, rolled back
  and retried if the alert itself fails to deliver.
- `HEALTHCHECK` in the companion image.

### Changed

- Reports are built entirely from Wealthfolio's own category and budget data.
  The keyword-based categoriser that guessed categories from transaction text
  (and its settings UI) has been removed — it was a second, hand-maintained
  guess that disagreed with Wealthfolio's real assignments.
- The daily report leads with the true amount left this month and presents the
  weekly figure as an explicitly approximate pace. The previous
  `remaining ÷ weeks-left` figure doubled overnight mid-month and moved by only
  a fraction of what was actually spent.

## [1.0.1] - 2026-07-28

### Added

- Telegram notifications, spending and budget figures read natively from
  Wealthfolio's SQLite database, and exact Spending Tracker integration.

## [1.0.0] - 2026-07-26

First public release.

### Added

- Transaction import from every SimpleFin-connected account, with per-account
  mapping to Wealthfolio accounts (existing or created during setup).
- One-time starting-balance entry so each account lands on its real bank
  balance rather than the sum of imported transactions, including a brief poll
  for brand-new accounts whose valuation is computed asynchronously.
- Pending-transaction support: pending rows are imported and reconciled in
  place when they post — updated if the amount changed, removed if they vanish.
- Automatic internal-transfer detection and linking. Matching legs across two
  mapped accounts are imported as a linked Transfer Out / Transfer In pair and
  excluded from spending and income analytics.
- Custom description-to-activity-type mapping rules, which take precedence over
  automatic detection.
- Per-account SimpleFin balance and drift display, with one-click correction.
- "Reconcile & link": a wider re-scan that recovers missed transactions,
  re-measures balances, and links outstanding transfer pairs. Optional
  auto-heal and aggressive auto-heal toggles.
- Auto-sync on a configurable interval with a startup catch-up, plus a one-hour
  minimum interval so reloading the page is a no-op.
- Optional Docker companion for background sync (earlier sync logic; see
  README).

### Fixed

- Cash-transfer legs are imported with no asset. Sending the reserved
  `$CASH-<ccy>` symbol made Wealthfolio create a literal `"$CASH"` security,
  which neither moved the cash balance nor allowed the two legs to be paired —
  by this addon or by Wealthfolio's own transfer linker.
- Both legs of a pair are written in a single request, so Wealthfolio sees a
  complete two-leg group; a per-account write looks like a lone leg and the
  group is silently dropped.
- Transfer groups carry the internal-transfer marker Wealthfolio requires; a
  shared group id alone is not enough to classify a pair as internal.
- Balance corrections are written as a spending-neutral `CREDIT`, so they no
  longer inflate the Spending total or appear as income.
- The starting-balance baseline is adjusted when a wide re-scan recovers older
  transactions, which would otherwise be counted twice.
- The link ledger is reconciled against what Wealthfolio actually stored, so a
  link that silently failed is retried instead of being recorded as done.
- Incremental syncs re-scan a two-week overlap, so card purchases that post
  late with a backdated timestamp are no longer missed permanently.
- Sync windows stay inside SimpleFin's limits, and its informational
  window-size notices are no longer surfaced as errors.

[Unreleased]: https://github.com/Bubbles840/wealthfolio-simplefin-addon/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Bubbles840/wealthfolio-simplefin-addon/releases/tag/v1.0.0
