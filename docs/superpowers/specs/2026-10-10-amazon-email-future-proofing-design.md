# Amazon emails: read any layout, label late charges, ask when unreadable — design

Nick approved this design section by section on 2026-10-10. It responds to the
Amazon card's warning "5 recent emails could not be read", and to his request
to future-proof Amazon categorization so every Amazon charge ends up correctly
categorized.

## Decisions

| Question | Decision |
|---|---|
| Send unreadable emails to an outside AI service? | **No.** Everything stays on the server. |
| What happens to an Amazon charge with no readable email? | It joins the **needs-a-category list** (`/categorize`), rather than silently keeping "Online Shopping". |
| How the parser reads an email | **Each copy separately** (subject, plain text, HTML). Results are combined by order number, and copies must agree. |

## What broke (evidence)

The five emails were read by `companion/tools/amazon-unread.mjs` on the server.
All four shipment emails parse correctly from their HTML copy alone. Fed the
joined subject + plain text + HTML document, the current parser returns nothing.
Three separate faults:

1. **The two body copies conflict.** The plain-text copy now has its own
   `Order #`, with no category line. `parseAmazonEmail` slices the joined text
   at every `Order #`, and it chooses one layout for the whole email by looking
   before the first marker. The result: the category line lands in one chunk,
   and the only readable total lands in the next. Neither chunk is a complete
   order.
2. **Plain-text totals are unrounded floats**, e.g. `10.799999999999999 USD`.
   `TOTAL` demands exactly two decimals before `USD`.
3. **Cancellation notices** (`order-update@`, `Item cancelled successfully`)
   are a new message type. They are classified `unrecognised`.

A new single-category wording also appeared (`1 item: Charging Accessories`).
The breakdown pattern already reads it.

The existing September fixture (`shared/amazon.test.ts`, "item line BEFORE the
order number") is one copy only. That is why fault 1 shipped unnoticed.

## 1. Reading the emails

### Contract change

```ts
/** One message's three copies, each already plain text (HTML via htmlToText). */
export interface AmazonMailParts {
  subject?: string;
  plain?: string;
  html?: string;
}
classifyAmazonEmail(parts: AmazonMailParts): AmazonEmailClassification
```

- **`MailMessage`:** replaces `text` with `parts: AmazonMailParts`.
- **Call sites that change:**
  - `ingestAmazonMail` and `createImapSource` (`companion/src/amazon-mail.ts`)
  - `companion/src/amazon-check.ts`
  - `companion/tools/amazon-unread.mjs`
- **`buildAmazonMailText`:** survives only if a caller still needs one string
  for display. The parser no longer reads it.
- **`isAmazonMessage`:** still receives a body to find a forwarded `From:` line.
  It is given the plain text plus the HTML text.

### Per-copy extraction

Each copy is read on its own, for:

- **Order ids:** `Order\s*#\s*(\d{3}-\d{7}-\d{7})`, as today.
- **Totals:**
  - Recognised forms: `$10.80`, `10.80 USD` and `10.799999999999999 USD`.
    Any decimal places, rounded to cents.
  - Still requires the word `Total` and one of `$`/`USD`.
  - `Total` gains a word boundary, so `Subtotal` is not a total.
  - Within one copy, prefer `Grand Total` over `Total`. A copy holding two
    different candidate totals for one order yields no total.
- **Category lines** (body):
  - The suffix form: `1 Hair Care item`.
  - The breakdown form: `4 items: 1 Electronics, …, and 2 others`, and
    `1 item: X`.
- **Subject category** (backup only): `<Verb> N item(s): A, B, and more`.
  - `and more` / `others` set `partial`, as `other` does today.
  - Used only when no body copy has a category line, because subjects are cut
    short (`"Amazon Basics USB-C to..."`).
- **Kind:**
  - From the subject's first word: `Ordered` → ordered, `Shipped` → shipped,
    `Delivered` → delivered, `cancelled`/`canceled` → cancellation.
  - Then the body phrases `detectKind` uses today.

### Combining

- **Exactly one distinct order id across all copies** (every shipment notice
  seen so far): one record.
  - **Category:** from the first body copy that has one, else the subject.
  - **Total:** from any copy that has one. Every copy that has a total must
    agree after rounding.
  - **No positional logic** at all in this case.
- **More than one order id:** today's positional pairing, including the
  item-first/item-after layout detection, run **inside one copy at a time**
  (HTML first, then plain).
  - Where the other copy also yields a total for the same order id, the two
    must agree.
- **Disagreement on a total** → that order is dropped and the message counts
  as unreadable. In a multi-order email one contradiction voids the whole
  message (final review): keeping the other orders would mark it read with no
  warning or sample. Absent is still the only acceptable failure direction.

### Message types

- **Delivery notice:** `ignored`, as today. `isAmazonNoticeWithoutTotal` keeps
  its narrow wording rules.
- **Cancellation:** `ignored` and marked read. Judged on the subject
  (`cancelled`/`canceled`) and only for a message stating no total (final
  review): a body that merely mentions cancelling must still parse or be
  reported.
  - The classification also returns the cancelled order ids.
  - `ingestAmazonMail` removes those orders' **unconsumed `ordered`** ledger
    records. A same-amount charge then cannot match a cancelled order.
  - `shipped` records and consumed records are never removed.
- **Anything else** that yields no order: `unrecognised`, counted as today and
  left unread. This includes refunds, returns and unseen wordings.

### Failure samples

- **New secret:** `amazon_mail_samples`, keyed in `shared/status-keys.ts`.
  Shape:
  `{ asOf, samples: Array<{ at, from, subject, plain, html }> }`.
- **Contents:**
  - Every completed scan **replaces** the set with that scan's unrecognised
    messages, newest 5.
  - Failures stay unread, so each scan sees all of them. The set therefore
    matches the published `unparsed` count, and clears once a fix reads them.
  - A failed scan (connection error) leaves the previous set alone, the same
    rule as the status record.
- **Size:** each copy is trimmed to 80 non-blank lines and 4,000 characters,
  so five samples stay near 60 KB in the secret store. The real HTML copies
  are about 2.5 KB of text.
- **Redaction:** `redactAmazonSample` in `shared/`, host-agnostic and unit-tested.
  - Removed: email addresses, the delivery line (`<Name> - <City>, <ST>`, any
    case, optional ZIP, inside direction marks), names on `From:`/`To:` lines,
    greetings, card digits (`ending in 1234`), and the query string of every
    URL (final review). The card asks for a look before posting publicly.
  - Order ids stay. The parser needs them, and fixtures already carry real ones.
- **Amazon card** (`src/components/AmazonCard.tsx`):
  - Under the existing warning, a collapsed "Show what couldn't be read"
    section, with a Copy button.
  - The button copies the samples in fixture form (below).
  - Read through a new `secrets.ts` getter. Every new store method is called
    optionally, so an older companion reads as "no samples".

### Test set built from real emails

- **Folder:** `shared/__fixtures__/amazon-emails/`, one JSON file per real email:
  `{ note, subject, plain, html, expect: { status, orders } }`.
- **One test** loads every file and asserts `classifyAmazonEmail` returns
  `expect`. A fix for a new layout cannot silently break an old one.
- **First entries:** today's five emails, rebuilt from the `amazon-unread`
  output.
  - The subject is line 1.
  - The HTML copy starts at the second occurrence of the subject line, which
    is its `<title>`.
  - The tool trimmed lines and cut each email at 60, so the rebuild is faithful
    in structure but not byte-exact.
  - Samples captured from now on are exact.
- **Existing hand-written cases** in `shared/amazon.test.ts` stay, moved onto
  `AmazonMailParts` input.

## 2. Getting categories onto the charges

### Late label

Today `runSyncCore` re-matches every Amazon charge in the feed against the
ledger on each run. Re-matching is idempotent, because a record consumed by the
same `txKey` still matches. But it only writes the label into the note when it
**creates** the row: `shared/sync-core.ts`, where the comment reads "won't be
re-written". The plan's first step is a test proving this. Without that test the
late label is not built.

New behavior:

- **When:** a hit lands on a row that already exists in Wealthfolio.
- **Conditions,** all required:
  - The row is not transfer-typed and not grouped (`source_group_id` empty).
    Wealthfolio copies a linked leg's note onto its partner, and the addon host
    never reads `source_group_id`, so the type is the guard on both writers
    (final review).
  - Its stored note is exactly the sync's own unedited form,
    `<bank description> · <txId>`.
  - The note has no `· Amazon:` label yet.
- **Then:** issue a note-only update to `amazonDescription(...) · <txId>`.
  - Type, date and amount are passed through unchanged, the same pattern as
    `planExternalMarkerStamp`.
  - Log tag: `amazon-late-label`.
- **Labels are only added:** never replaced, never removed. A pruned ledger
  record (after 90 days) changes nothing, because nothing rewrites existing
  notes from the bank text.
- **Both writers** run this: the companion, and the addon's Sync Now. It is
  idempotent.
- **Filing:** the existing `fileAmazonCharges` then files the charge.
  - It already reads uncategorised rows, and rule-categorised rows that carry a
    label.
  - It writes source `manual`, so rule re-runs cannot overwrite the result.
  - It never sees a category the user picked.

**Expected outcome for the four stuck charges.** These are the default mappings;
a label remapped on the card wins.

| Charge | Label | Category |
|---|---|---|
| $10.80 | Hair Care | Personal Care |
| $8.11 | Charging Accessories | Electronics |
| $50.87 | Electronics | Electronics |
| $127.01 | mixed: Electronics + Irons & Steamers + more | default Amazon category (2026-09-02 decision on mixed orders) |

### No readable email → the needs-a-category list

- **Nick deletes "Amazon → Online Shopping"** from Wealthfolio, once. He does
  this only after the upstream source (`wealthfolio-upstream`) confirms that
  deleting a categorization rule leaves its existing assignments in place.
- **`companion/tools/fix-ledger.mjs`:** drops that rule from its rule list, so
  a rerun cannot recreate it.
- **No new code path is needed.** An unlabelled Amazon charge imports with no
  category. The import notice, `/categorize` and the card's count already
  handle it.
- **Ordering is already right:** `pollAmazonMail` runs before `runSyncCore`,
  which runs before `fileAmazonLabelledCharges` (`companion/src/index.ts`). And
  Amazon emails at shipment, ahead of the charge, so the label is normally
  present at import.
- **Late email:** the charge sits in the list until the next sync labels it,
  then files itself.
- **No grace period:** deliberately. It would need the same filter in the count,
  the list and the notice, all for a rare case.
- **What will reach the list:**
  - charges whose email was unreadable
  - two orders at one amount within 5 days
  - Amazon purchases the forwarding filter does not cover, such as digital
    orders
  - Prime charges, which the deleted rule's `Amazon` pattern also caught
  - labels no pattern matches (as today)

### No "make this a rule" for Amazon purchases

- **Where:** `shared/categorize-menu.ts`'s filed screen.
- **No guard in the controller** (`companion/src/categorize.ts`). Menu sessions
  and their button tables live in memory, and an upgrade restarts the
  companion, so no button rendered before the change can be tapped after it.
- **Change:** the rule offer is hidden when `isAmazonDescription(description)`
  is true.
- **Why:** a rule on `AMAZON MKTPL` would file every later Amazon charge the
  same way, which is the failure this removes.
- **Exceptions:** `isAmazonDescription` already excludes Prime, AWS, Prime Video
  and Kindle Unlimited. Those charges always mean the same thing, so they keep
  the offer.
- **Unchanged:** `/newrule`, typed by hand, is the user's explicit choice.

## 3. Release and verification

- **Release:** v1.59.0. Both halves change: the shared parser, `sync-core`, the
  card and Telegram.
- **Gates before tagging:**
  - both test suites
  - `cd companion && npm run build`
  - `rm -f dist/*.zip && npm run package` (the bundle-version check)
- **Publishing:** the tag builds the zip and the ghcr image.
- **Deploy,** either order:
  - Companion: pull the image and `up -d`. Its startup sync reads the five
    waiting emails.
  - Addon: install the v1.59.0 zip.
- **Verify on the server:**
  1. Mail log: 4 orders added, 1 cancellation skipped, then a
     `Filed N Amazon charge(s)` line.
  2. `amazon-unread`: `0 the parser could not read`.
  3. The card's warning is gone, and the four charges carry the categories
     above.
  4. Only then: delete the rule (see section 2).
- **Rollback:** the v1.58.0 image and zip. This release only adds note labels,
  and the categories filed from them. v1.58.0 ignores both.

## Out of scope

- **An AI fallback reader:** declined.
- **Refund and return emails:** no sample exists. The first one to arrive is
  saved as a failure sample, and handling it is its own change. Filing a refund
  under its order's category is an idea for then.
- **Per-item splitting:** still impossible. The emails carry no per-item prices
  (see `shared/amazon.ts`).
- **A warning about broad Amazon rules for other installers:** not requested.
  The CHANGELOG explains why such a rule hides unreadable charges.
