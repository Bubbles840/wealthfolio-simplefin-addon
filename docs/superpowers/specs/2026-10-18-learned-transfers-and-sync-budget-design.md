# Learned transfer names, every account checked on Sync, a SimpleFin budget — design (1.64.0)

> **Approved by Nick on 2026-10-18, part by part in chat:**
> - the learned-transfer-names playback ("that sounds good");
> - "if you are pressing sync manually then you should have the card checked right then and there even if it takes a
>   little bit longer, but you shouldn't be able to spam SimpleFin";
> - the budget proposal ("it sounds good");
> - "block it outright … give them a short one-liner" when the budget is used up.
>
> Everything marked **(my call)** below was decided by Claude and is listed in the rulings table with what it costs
> if wrong.

## Why

What Nick saw after installing 1.63.0:

1. **Money that arrives before it leaves still asks for a category.** 1.63's bank-first rule covers only money
   *leaving* a bank account. A transfer whose incoming half posts first, for example savings → PNC landing at PNC
   before savings shows it, is an ordinary deposit until the other half arrives. Nick's idea: "if we know a transfer
   has a certain name, once one of those goes through, then no matter which side it's coming in or out of, we should
   be able to recognize … this is the name for a transfer payment."
2. **360 Checking is now tracked for spending.** Its `Withdrawal to 360 Performance Savings XXXXXX1580` matches no
   wording rule. It has been a linked transfer before, so learning (1) covers it.
3. **Cards always say "not checked" after an in-app Sync.** Wealthfolio gives the add-on balances for cash accounts
   only. Only the companion can total a card, because it reads the database. The companion also skips any account
   with a pending charge, and the Robinhood card nearly always has one.
4. **Nothing limits SimpleFin downloads.** "Sync anyway" and Telegram `/sync` both bypass the one-hour interval.
   SimpleFin Bridge expects about 24 requests a day per connection. Its quota refills through the day. Going over
   first produces warnings, and going well over disables the access token
   ([developer guide](https://beta-bridge.simplefin.org/info/developers)). That would cut off every bank.
5. **Evening syncs failed the Robinhood holdings snapshot** ("Date 2026-10-19 can't be imported"). The cause was a
   UTC date on SimpleFin's balance timestamp. **Already fixed** on this branch (commit 9d194d6): the snapshot now
   takes the local day. It ships in this release.

## Goals

- A transfer between Nick's own accounts never asks for a category and never counts as spending or income while its
  other half is on the way, **whichever half posts first**, once that transfer's bank text has been seen as a linked
  transfer before.
- **Pressing Sync in the app gives every account a real verdict** ("in sync" or "off by $X"), credit cards included,
  unless the account genuinely cannot be compared. Taking a few seconds longer is fine.
- **SimpleFin is never asked more often than it allows**, whoever asks: the app, the companion's schedule, or
  Telegram. When the limit is reached, Sync says why in one short line.

## Non-goals

- No change to which transactions are fetched or to the fetch window.
- No yearly subscriptions. That stays in follow-ups §19.
- No change to the "Why?" story wording. Its existing "A transfer the sync is holding…" line already describes a
  held row.
- No learning for credit-card accounts (see A3).

## Anti-goals (would be a failure even if it "works")

- Real spending or real income hidden as a transfer. Robinhood cashback must stay income, and an LG&E bill must stay
  spending.
- A SimpleFin token disabled because of this add-on.
- A Sync that reports "in sync" for an account it did not actually compare.

---

## A. Learned transfer names

**A1. What is learned.** A **name** is the pair *(Wealthfolio account, direction)* plus a **signature** of the
bank's own text:
- **Which rows teach:** every row in the last 365 days that is one leg of a linked transfer. That means its
  `source_group_id` is set and the group holds a leg in another account.
- **Which rows don't:** only real bank rows teach, meaning rows whose note carries a SimpleFin transaction id. The
  add-on's own bookkeeping never teaches: no starting balances, corrections, in-transit placeholders, or rows typed
  in by hand without a bank id.
- **Skip copied notes:** a group whose two legs carry the *same* note teaches nothing. Wealthfolio 3.8 copies an
  updated leg's note onto its partner (shared/sync-core.ts ~220–231), so such a leg shows the other bank's wording
  on the wrong account. A shared transaction id with different wording is legitimate (transfers.ts ~109–113) and
  still teaches.
- **Direction** is whether the leg moved money into or out of that account.

**A2. The signature.**
1. Take the bank words. That's the note without the transaction id and without any appended Venmo note or Amazon
   label (`bankWords`), and without an in-transit prefix.
2. Lower-case them and split on anything that is not a letter.
3. Drop every token that held a digit before splitting (reference codes, masks like `XXXXXX1580`, `*0082`).
4. Join what's left with single spaces.

| Bank text | Signature |
| --- | --- |
| `RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT` | `transfer capital one ach web payment` |
| `*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR` | `payment citi autopay ach web recur` |
| `Withdrawal to 360 Performance Savings XXXXXX1580` | `withdrawal to performance savings` |

**A3. Guards (my call).**
- **Distinctive word:** a signature counts only if it has at least one word that is neither a generic bank word
  (`GENERIC_BANK_WORDS` in shared/category-guess.ts) nor `to`/`from`/`at`/`for`. So `payment`, `ach debit` or
  `online transfer` alone are never learned.
- **Card accounts are left out of learning and of use.** A card's incoming payment is already a transfer by wording,
  and a card's charge is never a transfer.
- **An Undo blocks the name.** If any row with that signature on that account carries a `notTransfer` override, the
  name is not learned. Saying "not a transfer" once means that name stops being trusted.

**A4. Who learns, where it lives.**
- **The companion computes the list** from the database at the start of every sync it runs, and once at startup. It
  can see links and history; the add-on cannot (its `listActivities` is recent-only, and `readsSourceGroupId` is
  false).
- It writes the list to a new add-on secret, `transfer_names`:
  `{ version: 1, computedAt, names: [{ accountId, direction: 'in' | 'out', signature }] }`, capped at 500 names,
  newest first.
- **Both writers read it** when typing rows, so in-app syncs benefit too.
- **No companion means no learning.** The feature is then simply off, and nothing else changes.

**A5. How it is used.**
- **Where:** in the sync's typing step, where 1.63's bank-first rule (A) is decided, and before the payback and
  `notTransfer` handling, so both still win.
- **When it applies:** a row on a CASH account, not decided by a rule, whose built-in type is WITHDRAWAL (money out)
  or DEPOSIT (money in), and whose *(account, direction, signature)* is in the list.
- **What happens:** it is typed TRANSFER_OUT or TRANSFER_IN. From there the existing path does the rest:
  - pairing by amount;
  - the in-transit placeholder, which is spending- and income-neutral and stays off the needs-a-category list;
  - expiry after 10 days to an ordinary deposit or withdrawal marked Needs review;
  - the dead-feed hold.
- **A stored payback is never retyped.** Today `keepPayback` is decided from the matched type
  (sync-core.ts ~2237) and only reaches the plan when the final type is a plain DEPOSIT (~2687), so a learned
  TRANSFER_IN would silently drop it. Decide `keepPayback` from the type the bank text alone gives, before learned
  typing. Keep a row whose stored form is a payback out of learned typing **and** out of pairing.
- **Pending rows:** typed the same way. They do not pair (as today), but they become placeholders.

**A6. Telling Nick.** The existing change log already records a transfer typing and offers Undo, so nothing new is
needed.

## B. Every account checked on a manual Sync

**B1. Cards totaled by the app.** On a **manual** Sync in the app (the Sync button, including "Sync anyway"), the
app reads every mapped credit card's **full** activity history. It pages `activities.search` 500 rows at a time
until a short page.
- **The total:** it uses Wealthfolio's own sign rules (`type_directed_cash_effect`). Reuse the TypeScript table
  that already exists (`cashEffectCents` in shared/audit-ledger.ts ~67; `CASH_EFFECT` in companion/src/ledger-facts.ts
  ~46) rather than writing a new one.
- **Both sides use the effective type, not the raw one.** `activities.search` returns
  `COALESCE(activity_type_override, activity_type)`, and Wealthfolio's own cash maths uses the override.
  `getNativeAccountBalances` signs the raw `activity_type` (sqlite-native.ts ~307–310), so change it to use the
  effective type too **(my call)**. That corrects the companion's existing card figures for any overridden row. Pin
  app total == companion total on the same rows, overrides included.
- **Pending rows are left out**, exactly as the companion does.
- **Omitted, as in the companion:** an account holding an in-flight transfer leg (a leg posted at one end only).
- **Scheduled app syncs don't do this read (my call).** They stay light, and the companion's scheduled runs already
  total cards.

**B2. The total is taken after the run's own writes.** A Sync that imports a new card charge must still be able to
check that card. So on a manual run the app computes card totals after its saves and compares them with SimpleFin's
posted balance for that run. The companion does the same for cards on its runs. Cash accounts keep using valuations
and the existing rules: `VALUATION_POLL` and the "nothing created/updated this run" conditions.
- **The companion's after-save read must be live.** When `getNativeAccountBalances` cannot open the live database it
  falls back to `immutable=1` (sqlite-native.ts ~108–117), which ignores the write-ahead log and has been seen two
  days stale. An after-save verdict from that read would miss this run's writes, so it yields "not checked".
- **The after-save total drives the badge only (my call).** The drift alert, the starting balance, the auto-heal
  top-up, the baseline-fix offer and every ledger write keep today's before-save figure and today's conditions.
  That code subtracts this run's new rows from a before-save read (sync-core.ts ~3138–3152, ~3780–3786), so feeding
  it an after-save total would count them twice. It also keeps card alert frequency where it is today.

**B3. Pending charges no longer block a card's check.** A card's figure is a posted-only total, which is
comparable with SimpleFin's posted balance whether or not pending rows exist. The `noPending` condition applies only
where the Wealthfolio figure includes pending rows, meaning valuation-based (cash) accounts.

**B4. What doesn't change.**
- The three badge states.
- The drift alert's thresholds.
- Starting-balance and auto-heal behavior. A balance correction is still never written from a figure the existing
  rules would not trust.
- "Not checked" remains correct for an account that really cannot be compared: an in-flight transfer leg, a
  SimpleFin account without a balance, or a failed read.

## C. A SimpleFin download budget

**C1. One shared record.**
- A new add-on secret, `simplefin_requests`, holds the timestamps of SimpleFin requests in the last 24 hours, newest
  first, pruned on write.
- Whichever writer is about to call SimpleFin (`host.fetchSimplefin`, which today is once per run, heal scans
  included) appends its timestamp **before** sending. SimpleFin counts attempts, so a failed request still counts.
- A failed read of the record blocks the download, so it fails closed.

**C2. Limits (my call on the numbers).**
- **20 downloads per rolling 24 hours.** SimpleFin expects about 24; the rest is headroom for setup and repair
  scans.
- **5 minutes between downloads.** Both are constants in shared code.

**C3. Behavior.**

| Situation | What happens | The one line Nick sees (exact copy left to the builder, ≤ ~80 characters) |
| --- | --- | --- |
| Manual Sync inside the 5-minute gap | No download. Every balance is re-checked (B) against the bank figures from the last download. | "Balances checked · bank data is from 3 min ago." |
| Daily budget used up, manual Sync / "Sync anyway" / Telegram `/sync` | **Blocked outright**, no download. | "SimpleFin's daily limit is used up — next sync at 3:10 PM." |
| Daily budget used up, scheduled run (either writer) | Skipped quietly, with a status line, no alert. | (status line, same wording) |

- **"Next sync at"** is when the oldest counted request leaves the 24-hour window.
- **A check-only run needs bank figures.** The last download's per-account SimpleFin balance and balance date are
  kept (new add-on secret, or the existing sync-status snapshot if it already holds them; builder's choice).
- **A download still in flight makes the check "not checked" (my call).** The request time is recorded before
  sending, but bank figures are written only at the end of a run (sync-core.ts ~4378), and the two writers share no
  lock. When the newest recorded request is newer than the stored bank figures, a check-only run reports
  "not checked" rather than comparing the previous run's bank figures with a half-updated ledger.

**C5. Every SimpleFin caller counts (my call).** Besides the sync's `host.fetchSimplefin`, three places call
SimpleFin directly: Setup (src/pages/SetupPage.tsx ~59), Settings → Refresh accounts (src/tabs/SettingsTab.tsx ~216),
and the automatic account-name backfill on Sync page load (src/pages/SyncPage.tsx ~528). All of them record a
request.
- **Automatic calls (the backfill) obey the 20 like a sync**, and are skipped when it is used up.
- **Setup and Refresh accounts are rare and deliberate.** They may use the headroom above 20, up to a hard ceiling of
  24 per rolling 24 hours, so a bank can still be reconnected after a busy day. At 24 they are refused with the same
  one line.

**C6. What a manual Sync means now (my call).**
- **The 1-hour minimum interval no longer applies to manual actions,** meaning the Sync button, Deep scan and
  Telegram `/sync`. The 5-minute gap and the daily budget replace it, and the "Sync anyway" callout goes away.
  Otherwise a Sync pressed 5–60 minutes after the last one would still check nothing, which defeats goal B.
- **Scheduled runs keep their schedule and the existing 1-hour floor.**
- **Inside the 5-minute gap, every manual action is check-only,** Deep scan and `/sync` included.
- **The sync core gains a `manual` option,** because a button press and a scheduled tick reach it identically today
  (SyncPage.tsx ~593 vs src/addon.tsx ~37/53/107).
- **The new learning module needs a name other than `transfer-learning`.** companion/src/transfer-learning.ts is the
  Telegram "make it a transfer rule" menu.

**C4. Showing the budget.** The app's sync status shows a quiet "SimpleFin: 7 of 20 today". Telegram `/status`
shows the same, if it exists.

## Rulings

| # | Decision | Cost if wrong |
| --- | --- | --- |
| R1 | One past link is enough to learn a name (Nick agreed in the playback). | A one-off coincidence teaches a name. Bounded by A3 and by the 10-day expiry with Needs review. |
| R2 | Signature = letters-only words; any token with a digit is dropped (A2). | Two different payees whose words differ only by numbers share a signature. Rare between one person's own accounts. |
| R3 | A distinctive non-generic word is required (A3). | A transfer whose text is only generic words is never learned and behaves as today. |
| R4 | One `notTransfer` on any row with the name blocks it (A3). | One Undo turns off learning for that name until the override expires (1 year). |
| R5 | Cards are excluded from learning (A3). | None today; card wording already covers card payments. |
| R6 | The companion computes, both writers read, no companion = off (A4). | Store users without the companion don't get learning. |
| R7 | Scheduled app syncs don't do the full card read (B1). | An app-only user's scheduled runs leave cards unchecked, as today. |
| R8 | Budget is 20 per rolling 24 h; gap is 5 min; failed attempts count; an unreadable record fails closed (C1–C2). | Slightly fewer syncs than SimpleFin would allow; one blocked sync if the record is unreadable. |
| R9 | A check-only Sync inside the gap re-checks balances against the last download (C3). | The verdict uses bank figures up to 5 minutes old. |
| R10 | The holdings snapshot uses the local day (done, 9d194d6). | — |
| R11 | Ships as 1.64.0, both halves; release only when Nick asks. | — |
| R12 | A linked group with identical notes on both legs teaches nothing (A1). | A genuine transfer whose two banks happen to word it identically is not learned. It behaves as today. |
| R13 | `keepPayback` is decided before learned typing, and stored paybacks are kept out of learned typing and pairing (A5). | None known. A payback can never become a transfer through learning. |
| R14 | Both totals use the effective (override) type, which changes the companion's card figures for overridden rows (B1). | A card with an overridden row reads differently from before. It now matches Wealthfolio's own maths. |
| R15 | The after-save card verdict drives the badge only; alerts and writes keep today's figures; a non-live companion read means "not checked" (B2). | A card that is off shows "off by $X" on the badge without a Telegram alert until the existing check also sees it. |
| R16 | A download in flight makes a check-only run report "not checked" (C3). | One extra "not checked" during a concurrent download. |
| R17 | Every SimpleFin caller counts; the backfill obeys 20; Setup and Refresh may go to 24 (C5). | Setup is refused after 24 requests in a day. |
| R18 | The 1-hour wall is retired for manual actions and "Sync anyway" removed; manual actions inside 5 minutes are check-only (C6). | Up to 20 manual downloads a day instead of one an hour. Still inside SimpleFin's limit. |

## Tests (acceptance)

- **A, learned:**
  - A deposit `RT… TRANSFER CAPITAL ONE ACH WEB PAYMENT` on Spend, with a past linked leg of that signature into
    Spend, is held as an in-transit TRANSFER_IN. It links when the savings half arrives; with no partner it expires
    to DEPOSIT with Needs review after 10 days.
  - `Withdrawal to 360 Performance Savings XXXXXX1580` on 360 Checking is held from a past link.
- **A, not learned:**
  - Robinhood cashback (never linked) stays DEPOSIT/income.
  - LG&E stays WITHDRAWAL.
  - A signature of only generic words is not learned.
  - A card row is not learned.
  - A rule-typed row is not overridden.
  - A `notTransfer` row stays as Nick set it, and blocks learning of its name.
  - No `transfer_names` secret means today's behavior.
- **A, signature:** the three examples in A2. A token with a digit is dropped. Enrichment and the in-transit prefix
  are stripped.
- **B:**
  - A manual app Sync that imports a new Citi charge shows Citi "in sync" when the total matches, and "off by $X"
    when it doesn't.
  - A card with pending charges is still checked.
  - A card holding an in-flight leg stays "not checked".
  - The TypeScript sign table agrees with the SQL one on every type × account type × direction.
- **C:**
  - The 21st download in 24 hours is refused for manual, "Sync anyway", `/sync` and scheduled runs, with the one
    line.
  - A Sync 2 minutes after a download does not call SimpleFin and still re-checks balances.
  - Both writers share one count.
  - A failed SimpleFin request still counts.
  - An unreadable record blocks.
- **Holdings:** an evening balance timestamp gets the local day (done).
