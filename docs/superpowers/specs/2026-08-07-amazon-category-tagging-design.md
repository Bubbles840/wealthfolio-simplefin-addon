# Automatic categorization of Amazon charges

Date: 2026-08-07. Approved by Nick in conversation. Ships inside SimpleFin Sync.

## The problem, and what changed under it

A bank charge for an Amazon order reads `AMAZON.COM*MB3T81` — no indication of what
was bought, so every Amazon purchase lands uncategorized or in one blunt bucket.

The original ask was itemization: split a $47 charge into "$12.99 shampoo, $18.50
coffee, $15.83 cable" with a category each. **That is no longer possible.** Amazon
removed item details from order emails on 2026-07-08; the body now carries only a
category label, a total, an item count and a link. No product names, no
quantities, no unit prices, in either the HTML or plain-text part. Another project
(`email-to-lunchmoney` issue #7) hit the same wall and found no alternative source.
Splitting needs per-item prices, which no longer exist in the message, so the
itemization half of the request is dead at the source rather than hard.

What remains is more useful anyway: the emails DO state a category, so Amazon
charges can be categorized automatically.

```
Email:  Order 113-0728509 · 1 Lawn & Garden item · $21.18
Bank:   AMAZON.COM*MB3T81 · $21.18
   →    comment becomes "Amazon · Lawn & Garden · TRN-…"
   →    Wealthfolio's own rule maps that to Housing
```

## Constraints that shaped the design

- **No email API offers a per-sender scope.** `gmail.readonly` and an IMAP app
  password both grant the entire mailbox. Reading ~20 Amazon messages a month is
  not worth that, especially for an addon other people install.
- **No category API exists.** `ActivityCreate`/`ActivityUpdate` have no category
  field and the SDK exposes no taxonomy endpoint (verified). Assigning a category
  directly would mean writing `activity_taxonomy_assignments` in a read-write
  mount, continuously, into a live database owned by another process.
- **`comment` IS writable** through the supported API.
- **Amazon charges on shipment**, so the shipment email's total is the figure the
  bank will show, and it arrives a day or two BEFORE the charge posts.

## Architecture

**1. Ingestion — a dedicated forwarding mailbox.** The user adds one Gmail filter
sending mail from `auto-confirm@amazon.com` and `shipment-tracking@amazon.com` to a
separate throwaway mailbox. The companion holds credentials for that mailbox only,
which contains nothing but Amazon receipts; a compromise exposes receipts, not the
user's real inbox, and revoking means deleting one filter. Automatic after a
one-time setup, which is what rules out the file-drop alternative.

Documented alternative for the privacy-maximal, not built now: a Google Apps
Script the user owns, running on their own trigger, POSTing parsed JSON to the
companion — the mail permission then lives in their account and the companion holds
no credential at all.

**2. Parser.** Extracts per email: `orderId`, `kind` (ordered | shipped |
delivered), `total`, `itemCount`, `labels[]`, `date`. Multi-category orders join
labels with " and " (`2 Home Improvement and Skincare items`), so the presence of
" and " is itself the mixed-order signal. **Fails safe**: an email whose shape it
does not recognise is skipped and logged, never guessed at. Amazon changed this
format five weeks ago and may change it again; the failure mode must be "no
auto-categorization", never "wrong category on real money".

**3. Order ledger.** Parsed records persist in an addon secret, keyed by
`(orderId, kind, total)`, pruned past 90 days. Records are consumed, not deleted,
so a re-parsed email is idempotent.

**4. Matching.** For a feed transaction whose description matches Amazon's
descriptor pattern, find ledger records with the same amount within a ±5 day
window. **A match must be UNIQUE** — two Amazon orders for the same amount in the
same window are ambiguous and both are skipped rather than guessed between. This
mirrors the transfer matcher's "different accounts is the whole test" discipline:
an ambiguous match is worse than no match, because a wrong category is invisible
while a missing one is merely absent.

**5. Application — comment enrichment at CREATE.** A matched transaction is created
with `Amazon · <labels> · <txId>`. The txId suffix is preserved verbatim because
`txIdFromComment` parses it and every reconciliation match depends on it.

Then Wealthfolio's own engine does the categorization, via a one-time
`spending_categorization_rules` insert — the same mechanism and the same
stopped-Wealthfolio procedure already used twice for merchant rules. Nothing in the
recurring path writes to the database.

**6. Label → category mapping: patterns, not a lookup table.** The observed labels
(`Lawn & Garden`, `Nutrition & Wellness`, `Electronics`, `Essentials`, `Baking`,
`Skincare`, `Home Improvement`, `Office`) include mid-level merchandising
categories, not just top-level departments — `Baking` sits under Grocery,
`Skincare` under Beauty. So the set is likely hundreds of labels, Amazon can extend
it at will, and nobody has published it. An exact-match table would be permanently
incomplete.

The labels are plain English, so ~15 regex patterns generalize where 200 exact
entries would not: a label Amazon invents next month like `Vitamins & Supplements`
matches `/vitamin|supplement/` and files itself correctly with no edit.

```
/grocer|baking|snack|beverage|coffee|pantry|essentials/ → Groceries
/nutrition|wellness|vitamin|supplement|pharmacy/        → Health & Wellness
/skincare|beauty|hair|cosmetic|grooming/                → Personal Care
/lawn|garden|patio|outdoor|tool|home improvement/       → Housing
/electronic|computer|phone|audio|camera/                → Electronics
/pet|dog|cat/                                           → Pet Care
…
```

**Nothing is ever left uncategorized.** An unmatched label falls back to a
configurable default (Shopping), and the first sighting of a new label is reported
once in the daily digest — `New Amazon category "Watersports" → filed under
Shopping` — so it is visible and one pattern away from correct, rather than silent.

**Mixed orders.** Labels are known but amounts per label are not, so these are not
split. They get the enriched comment (`Amazon · Home Improvement and Skincare`)
and the default category, and surface through the existing needs-a-category sweep
with the context already in the description.

## What this deliberately does not do

- **No splitting**, and therefore no interaction with reconciliation at all. This
  was the biggest risk in the original design and the email data removes it: with
  no per-item prices there is nothing to split, so no child activities exist to be
  re-created or orphaned by a later sync.
- **No item names.** They do not exist in the source.
- **No live database writes.** Only the one-time rule insert.

## Testing

TDD. Parser: each observed email shape, the multi-label form, and an unrecognised
shape skipping rather than guessing. Matching: exact/unique match applied,
ambiguous pair skipped, out-of-window skipped, non-Amazon descriptor untouched.
Mapping: each seeded pattern, an unseen-but-matching label, an unmatched label
hitting the default AND being reported once. Ledger: idempotent re-parse, pruning.

## Open risks, stated rather than assumed away

- **Whether Wealthfolio re-runs rules on an edited comment.** Create-time
  enrichment is the normal path (the email precedes the charge), so this only
  affects late-arriving emails, which fall back to the needs-a-category nag.
- **Amazon may change the format again.** Fail-safe parsing degrades to no
  categorization, which is the acceptable direction.
- **The label vocabulary is unknown.** The parser records every distinct label seen
  so the addon can show the user their real set, which matters more than the
  global one.
