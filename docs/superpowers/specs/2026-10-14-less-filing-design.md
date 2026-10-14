# Less filing — design (project 3, R1)

> **Not yet approved by Nick.** On the night of 2026-10-13, Nick asked Claude to
> "keep going until we're done with all the phases". Claude designed this piece
> overnight without him, choosing the recommended option at each decision; the
> rulings are listed below. It ships as an **open PR, not merged**, so Nick can
> review the design before anything reaches main.

This is project 3 of the roadmap approved on 2026-10-12, "Less filing". The roadmap
names three ideas:
- Venmo notes from email, through the Amazon mailbox pipeline;
- an in-app needs-a-category inbox with a guessed category;
- account-scoped rules.

## Decisions (rulings, each with its cost if wrong)

| # | Decision | Cost if wrong |
|---|---|---|
| L1 | **Split into two releases.** <br>• **R1** (this spec) needs nothing new from the add-on SDK. <br>• **R2** (filing from the app) needs SDK 3.9's `spending` permission. Nick has kept that decision for himself, so R2 is listed but not designed. | Filing from the app waits for R2. |
| L2 | **Venmo notes are on by default** whenever the Amazon mailbox is configured. They use the same mailbox and add no new settings. They only act on Venmo emails that arrive, so nothing changes until Nick forwards Venmo mail there. | A Venmo note appears without being asked for; Undo removes it. |
| L3 | **Guesses come from how you filed the same merchant before.** <br>• Source: your own filings in the last 365 days. <br>• A guess needs at least 2 filings, and at least 80% of them in one category. <br>• No machine learning and no outside service. <br>• Amazon rows are left to the Amazon pipeline. | Few guesses at first. |
| L4 | **A guess never files anything on its own.** <br>• In Telegram it is a one-tap first choice. <br>• In the app it is a hint. | none |
| L5 | **Account scope applies to Wealthfolio category rules created from Telegram**, as an "Only <account>" option on the rule preview. The add-on's own `mapping_rules` (activity typing) stay global for now. | Typing rules can't be scoped yet. |

## What exists today (facts)

**Mailbox pipeline.**
- The companion polls an IMAP mailbox at the start of every sync. It reads `UNSEEN` mail in INBOX plus any `\Junk` folder, and marks consumed messages `\Seen`.
- An Amazon filter (`isAmazonMessage`) picks the messages, and a parser (`shared/amazon.ts`) reads them into the `amazon_order_ledger` secret (90 days).
- During the sync, a charge is matched to an order (`matchAmazonCharge`). A match needs:
  - "amazon/amzn" in the bank description;
  - the exact amount;
  - ±5 days;
  - exactly one order.
- A matched charge gets ` · Amazon: <label>` appended to its note: at import, or later through a late label. This is logged as `amazon-label`, and undone through the `noAmazonLabel` override.
- Unreadable messages stay unread and are kept as samples.
- The IMAP adapter, the ledger pattern, consume-by-txKey, late labels and the overrides are all generic. The parser, the filter, the matcher and the note suffix are Amazon-specific.
- Venmo appears nowhere in the code today. It is only in help text and user mapping rules.

**Needs a category.**
- The companion publishes `uncategorized_status`: `{count, asOf, rows ≤ 50}`. Each row has activityId, date, amountCents, description, accountName and direction. There is no account id and no guess.
- The app's list is read-only, apart from Dismiss.
- Telegram's `/categorize` lists rows, files them by direct assignment (REST), and offers "Make this a rule" (a global `contains` rule at priority 50, with a preview count).
- Nothing guesses a category today.

**Rules.**
- Wealthfolio category rules support an account scope: `isGlobal:false` plus `accountId`, and the matcher skips other accounts.
- The companion always sends `isGlobal:true`.
- The add-on SDK, even at 3.9 or 3.10, has no assign method. It has only `saveRule` and `rerunRules`, behind a `spending` permission the add-on doesn't request.

## A. Venmo notes

**What you see.** A bank row for a Venmo payment gets the Venmo note appended: `VENMO PAYMENT 1023 · Venmo: Rent October · TRN-…`. Its story (2b) says "Note from a Venmo email", and `/categorize` shows the note. Your rules can match on the note text too, because Wealthfolio rules read the note.

**Reading emails.**
- A Venmo message is one from `@venmo.com`, or a hand-forwarded one whose body has a `From: …@venmo.com` line.
- The parser reads the direction, the amount, the other person's name and the note.
  - "You paid <name>" means money went out.
  - "<name> paid you" and transfers to your bank mean money came in.
  - Charge requests you completed count as paid.
  - Other Venmo mail (security notices, marketing) is ignored.
  - A Venmo email the parser can't read is left unread and kept as a sample, like Amazon's.
- **Built from Venmo's documented notification formats.** Nick should check it against real emails (see the follow-ups).
- Venmo records are kept in the `venmo_ledger` secret (90 days), with the same merge, prune and consume pattern as Amazon's.

**Matching** a bank row to a Venmo record needs all of these:
- the description contains `VENMO` (word boundary, any case);
- the exact amount;
- the matching direction (money out against "paid", money in against "received");
- ±5 days;
- exactly one record.

Two records with the same amount in the window means no note.

**The note.** ` · Venmo: <note>` is appended at import, or later as a late note, exactly as Amazon labels are. The note is clipped to 60 characters, and newlines become spaces.
- A new change kind, `venmo-note` (actor auto), records it.
- It is a sync decision: Undo sets a new `noVenmoNote` override, and the sync takes the note back off.
- The app's Your overrides list shows it.

**Setup** (README): forward Venmo emails to the same mailbox you use for Amazon, using a second Gmail filter on `from:venmo@venmo.com` with "forward to".

**The one-mailbox rule.** Both parsers see every message. Each takes only its own, and a message neither claims stays unread, as today.

## B. Guessed categories

**How a guess is made.** For each uncategorized row, the companion looks at your filings in the last 365 days:
1. It considers spending-category assignments of source `manual` (you) and those the change log shows as yours. Rule filings count too.
2. It keeps the rows whose rule pattern (`categoryRulePattern`, the same key `/categorize` uses for rules) equals this row's pattern.
3. If at least 2 such rows exist and at least 80% share one category, that category is the guess.

Amazon rows get no guess; the Amazon pipeline handles them. A Venmo row with a note uses the note as well, since the same note usually means the same category.

**Where the guess appears.**
- **Published.** `uncategorized_status` rows gain `guess?: {categoryId, name}`. Older add-ons ignore the field.
- **Telegram.** On `/categorize`'s transaction screen, the guess is the first button: "✓ Groceries (like the last 3)". One tap files it, exactly as picking Groceries from the grid would: it is undoable, logged as `category-filed` with actor `you`, and the rule offer follows as usual. The list screen shows the guess beside each row.
- **App.** The needs-a-category list shows a muted "Probably Groceries" under the description. The app can't file, so the hint is read-only. Filing still happens in Telegram or Wealthfolio until R2.

## C. Account-scoped rules

On Telegram's rule preview, after a filing or from `/newrule`, a toggle offers "All accounts ⇄ Only <account>":
- **Default:** All accounts, as today.
- **"Only" from a filing:** the rule is created with `isGlobal:false` and `accountId` = the filed row's account.
- **`/newrule`:** asks "Which account?" only when you add `in <account>` to the command, or pick an account on the preview.
- **The preview count** ("files N more like it") counts only that account.
- **The change log entry** (`category-rule-created`) records the scope, and its summary says "in <account>".
- **Undo** is unchanged: it deletes the rule by id.

## D. Failures, testing, release

**Failures.**
- Every mailbox failure is non-fatal, as today.
- A failed guess read means no guesses. It is never a wrong guess, and the list simply shows no hints.
- If a rule with an account scope is refused by the server, the reply says so and no change is logged.

**Tests.**
- **Venmo parser:** paid, received, charge completed, a hand-forwarded message, a non-payment Venmo message, and an unreadable message.
- **Matcher:** direction, exact amount, window, a two-record tie, consume.
- **Note handling:** the note appended at import and as a late note; Undo through the override.
- **Guesses:** the threshold edges (2 filings, 80%), Amazon excluded, and a failed read.
- **Telegram:** the guess button files and can be undone; callbacks stay within 64 bytes; bank text is escaped.
- **Scoped rules:** created with `accountId`, the scoped preview count, and the change entry.
- **App:** the hint renders, with no emoji.
- Tests pin their dates.

**Release.**
- One release.
- CHANGELOG under [Unreleased]; README for Venmo setup and the scoped-rule toggle; follow-ups §13.
- Gates:
  - `npm test`
  - `npm --prefix companion test`
  - `npm run type-check`
  - `npm --prefix companion run build`

## Out of scope (R2 and later)

- Filing from the app. It needs SDK 3.9 and a `spending` permission (`saveRule`, `rerunRules`); Nick's call.
- Account scope for the add-on's `mapping_rules`.
- Guesses from anything other than your own filing history.
- PayPal, Zelle and Cash App notes. If Venmo proves out, the same pattern extends to them.
