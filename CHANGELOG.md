# Changelog

All notable changes to SimpleFin Sync are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
