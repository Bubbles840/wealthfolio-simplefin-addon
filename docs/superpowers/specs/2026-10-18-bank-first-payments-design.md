# Bank-first card payments, reference numbers, renamed subscriptions — design

> **Approved by Nick on 2026-10-18** ("all those fixes sound good") after the
> diagnosis below. The probe of his ledger then changed fix C: his Google One
> plan is monthly, so a yearly tier would not have helped. C is now "follow a
> renamed charge" and "a price step is a plan change". The rulings below fill in
> what the approval leaves open, and each one says what it costs if it is wrong.

## Why

**A card payment asked for a category.** On Saturday 2026-10-17, a $42.40 Citi
autopay posted at PNC as `*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR`. The daily
report listed it under "Needs a category", and it counted as uncategorized
spending.

The add-on knows a bank row is one half of a transfer in only two ways:

- **The wording says so.** On a cash account this means `credit card payment`,
  `card payment`, a bank-transfer phrase, or a mapping rule. PNC changed its
  wording around 2026-09-22. It now puts a reference token first and the payee
  after it (`PAYMENT CITI AUTOPAY`, `PAYMENT ROBINHOOD CCB`). None of the
  built-in phrases matches that.
- **The other half has already arrived.** The sync pairs halves by amount, and
  the needs-a-category list hides a row whose unlinked partner already sits in
  another account (`NOT_AWAITING_TRANSFER_HALF`).

Citi usually posts its half first: the probe showed Citi first in four of
five autopays. This time PNC posted first. So until Citi posts, the row is an
ordinary withdrawal. It is not an in-transit placeholder, and nothing hides it.

**"↔ Mark one as a transfer" would not fix it for good.** `rulePatternFor`
keeps PNC's leading reference, so the rule it writes is
`0082 PAYMENT CITI AUTOPAY ACH WEB`. September's autopay was `*0062`, so the
rule would match this payment and never another. It also strips punctuation,
but mapping rules are a `contains` match on the raw bank text. So a
punctuated word inside the first six (`WEB-RECUR` → `WEB RECUR`) makes a rule
that matches nothing, not even its own transaction. Today the cap of six
words hides that by cutting before `RECUR`, but only while the reference
takes up one of the six slots.

**The same leading reference breaks merchant identity everywhere else.**
`categoryRulePattern` is the key for category rules, category guesses,
subscription grouping, forecast bills and subscription links. It trims trailing
reference noise but not leading noise. So
`*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT` and next month's
`*NNNN PAYMENT LOUISVILLE GAS & ACH DEBIT` count as two merchants. Only
`paybackRulePattern` strips a leading `*NNNN`.

**Google One is not shown as a subscription.** The probe found six Google One
charges on the Citi card:

| Date | Bank text | Amount |
| --- | --- | --- |
| Jun 6, Jul 6, Aug 6 | `GOOGLE *Google One MOUNTAIN VIEW CA` | $5.29 |
| Sep 6 | `GOOGLE *Google One MOUNTAIN VIEW CA` | $21.19 (plan upgrade) |
| Oct 6 | `GOOGLE *G1AI101M MOUNTAIN VIEW CA` | $21.19 (Google renamed the charge) |

Running the real `detectSubscriptions` on these charges:

- **Today** gives one entry, `kind: 'bill'`, at $5.29. The upgrade makes the
  last three charges ($5.29, $5.29, $21.19) "unstable", so the entry is a bill,
  and its price is the median.
- **On Oct 22** gives nothing at all. The old name's last charge (Sep 6) is
  more than 45 days old by then. The Oct 6 charge is a new merchant with one
  charge.

## The change

### A. A payment that names one of your own accounts is a transfer from the moment it posts

On a **cash** account, a **money-out** row becomes `TRANSFER_OUT` when all of
these hold:

- no mapping rule decided its type;
- the person has not undone a transfer decision on it (`notTransfer`);
- the built-in mapper typed it `WITHDRAWAL`;
- its bank text names **another connected account**;
- its bank text has **money-movement wording**.

From there the existing in-transit path does everything:

- An unpaired leg becomes the spending-neutral placeholder. It is off the
  needs-a-category list, and since 1.62 it is filed as "Sync bookkeeping".
- It links when the other half posts.
- After 10 days it gives up and becomes spending with "Needs review", unless
  the feed-aware hold applies.

The "Why?" story already explains a held row: "A transfer the sync is holding:
it waits until … for its other half". The change log already records the
decision, and Undo (`notTransfer`) already reverses it.

### B. One leading-reference cleanup for every pattern builder

A new `stripLeadingReference` helper in `shared/rule-pattern.ts` returns a
verbatim suffix of the text. These builders use it:

- `categoryRulePattern`, which feeds category rules, guesses, subscription
  keys, forecast bills and links;
- `paybackRulePattern`, replacing its own regex;
- the transfer flow's `rulePatternFor`.

`rulePatternFor` also becomes a verbatim substring of the bank's words
(`bankWords`). It is built the way `categoryRulePattern` is built, so a
transfer rule always matches the transaction it was made from.

### C. Subscriptions follow a renamed charge, and a price step is a plan change

- **C1. Renamed charge.** A merchant whose charges stop is joined with a new
  merchant that picks up where it stopped. "Picks up where it stopped" means
  all of these: the same account, the same brand word, the next monthly date,
  and the same price. The joined entry keeps the older name. Hidden, confirmed
  and linked state are stored under that name, so they carry over.
- **C2. Price step.** Within the trailing three charges, suppose one pair of
  neighbours agrees to the cent (within 2%) and the third charge differs by
  more than the 15% tolerance. That is a plan change, not a bill. The entry is
  a `subscription` at the newest price. `creep` is set in the month the price
  goes up, so the card shows "$5.29 → $21.19". Charges that wander
  (gas & electric) stay bills.

With both, Nick's charges read **Google One, subscription, $21.19 a month,
5 charges, last Oct 6**.

## Rulings

| # | Decision | Cost if wrong |
| --- | --- | --- |
| R1 | **A covers money out on cash accounts only.** Money in is left to pairing and to `NOT_AWAITING_TRANSFER_HALF`. The probe shows why: Robinhood cashback deposits say "…transferred to Robinhood Brokerage account" and name a connected account (the Robinhood card), so they would be held as transfers for 10 days and then flagged. Card accounts are excluded too, because a card's negative is never a transfer (`detectTransferPairs`). | A deposit that arrives before its outflow half is still income for a day or two. That was true before, and the outflow side usually posts first (probe: savings → PNC posted savings-first in every pair). |
| R2 | **"Names another connected account"** is a whole-word, case-insensitive match against `accountNameWords(name, org)` of every *other mapped* SimpleFin account. This is the signal the expiry hold already trusts. The row's own account never counts. | A bill whose text contains a product word from an account name (`double`, `freedom`, `unlimited`, `individual`) *and* money-movement wording is held as neutral for up to 10 days. It then counts as spending, marked "Needs review". Recoverable, and visible in /why. |
| R3 | **Money-movement wording** is `payment`, `pmt`, `autopay`, `auto-pmt`, `e-pay`/`epay`/`e-payment`, `transfer` or `ach`, each a whole word. `ach` is in so that PNC's pending `ACH DEBIT ROBINHOOD CCB` is caught. It keeps out a debit-card *purchase* at a store that shares a word with an account (e.g. a "CITI TRENDS" purchase). | A store purchase worded with "payment" whose name matches an account word is held for 10 days (as R2). |
| R4 | **No new state, no new setting.** A is a typing decision inside the sync's preparation step. It runs before the `notTransfer` and `asReimbursement` handling, so both still win, and a mapping rule always wins. | None beyond R2/R3. Undo already exists. |
| R5 | **What counts as a leading reference** (stripped repeatedly from the front, never the last token that has a letter): a token that starts with `*` or `#` and has a digit (`*0082`); a token of 3 or more digits (`4090`); or a code of 6 or more letters and digits with at least 3 digits (`RT08C248B2E7C8B`, `3447db1440b44a1`, `XX9257`). | A merchant whose real name starts with such a token loses it from its pattern (`7-ELEVEN`, `1PASSWORD` and `76` are *not* stripped by these rules). The pattern still identifies the merchant by the words that follow. |
| R6 | **Names stored under an old key keep working.** Hidden subscriptions, confirmed subscriptions, a manual entry's linked `merchant` and `declinedLinks` are compared through the normalizer. The normalizer is idempotent, so `normalize(stored) === key`. | Without this, a hidden subscription whose old key started with a stable reference would reappear once. |
| R7 | **Existing rules are untouched.** Only patterns built from now on change. A rule saved under an old pattern still matches what it matched. | None. |
| R8 | **C1 joins only when the match is clear:** same Wealthfolio account; same brand word (the first letters-only word of at least 3 letters after B's cleanup that is not a generic bank word like `PAYMENT`, `ACH` or `POS` — amended after the final review, since after B every PNC ACH row starts with `PAYMENT` — e.g. `google`); the new merchant's first charge 24–38 days after the old merchant's last charge, within 15% of its price; the old merchant has at least 2 charges; and exactly one old candidate for the new merchant, and one new merchant for the old one. Anything ambiguous is left apart. `SubscriptionCharge` gains an optional `accountId`; without it nothing is joined. | Two different same-brand services on one card at the same price, one stopping as the other starts, would show as one entry. Rare, and harmless: the money is the same. |
| R9 | **C2 tolerance** is "agree" = within 2% of each other, "step" = more than 15% apart. This is applied to the trailing three charges of groups with 3 or more charges. A 2-charge group keeps today's rules (known brand → subscription, else possible). | A bill that happens to repeat an amount and then jump would read as a subscription for a month. |
| R10 | **No yearly tier in this round.** Nick's plan is monthly. Annual detection goes in follow-ups. | An annual plan stays invisible, as it is today. |
| R11 | **Ships in the next release, both halves.** `shared/` changes reach the add-on and the companion. Release only when Nick asks. | — |

## Tests (the acceptance cases)

- **A:** a PNC `*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR` outflow with a mapped
  Citi card and no card half becomes an in-transit placeholder. When the
  card's `AUTOPAY … AUTO-PMT` half arrives, the two link.
- **A, not applied:**
  - Robinhood `Credit card cashback rewards … Robinhood` money in;
  - `*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT`, which names no account;
  - `*8768 PAYMENT VENMO ACH WEB`;
  - a card's own negative;
  - a row with a mapping rule;
  - a row with `notTransfer`.
- **A, past the window:** the leg expires with "Needs review", and the
  dead-feed hold still applies.
- **B:**
  - `categoryRulePattern('*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT')` and
    `('*9999 …')` agree;
  - `rulePatternFor('*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR')` matches both
    `*0082 …` and `*0062 …` through `ruleApplies`;
  - `RT…` and `3447db…` codes are stripped;
  - `7-ELEVEN …`, `1PASSWORD` and `76 …` are kept.
- **C:** Nick's six Google rows (above) give one `subscription` at $21.19
  with 5 charges, on 2026-10-18 and on 2026-10-22.
  - The Sep-6 state gives `subscription`, $21.19, `creep: true`.
  - Two same-brand merchants on *different* accounts are not joined.
  - A wandering bill stays `bill`.
- **R6:** a hidden name stored as `*8712 PAYMENT LOUISVILLE GAS & ACH` still
  hides the new key `PAYMENT LOUISVILLE GAS & ACH`.
