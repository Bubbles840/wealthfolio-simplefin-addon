# Amazon Email Future-Proofing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read Amazon's order emails whatever their layout. Label charges that were imported before their email could be read. Send every Amazon charge without a readable email to `/categorize` instead of a silent fallback rule.

**Architecture:** The parser reads an email's subject, plain-text and HTML copies separately and combines them by order number. With one order number, no layout logic is used; with several, positional pairing runs inside one copy and is cross-checked against the others. The sync adds a missing Amazon label to an existing row's note (note only). Unreadable emails are saved, redacted, for the Amazon card to show and copy.

**Tech Stack:** TypeScript, vitest (root: jsdom; companion: node), React (addon card), Node companion (imapflow + mailparser).

**Spec:** `docs/superpowers/specs/2026-10-10-amazon-email-future-proofing-design.md`

## Global Constraints

- **Absent beats wrong.** Any ambiguity yields no order and no label. Never a guess. (Spec: "Absent is still the only acceptable failure direction.")
- **`shared/` non-test files stay host-agnostic.** No Node APIs, no IMAP, no fetch. Tests in `shared/` may use `fs`/`path`, as `shared/tab-names.test.ts` does.
- **New store reads are called optionally** (`store.getAmazonMailSamples?.()`). An older companion or a test mock without the method must read as "nothing".
- **Comment style:** match the surrounding files. Long-form *why* comments on non-obvious decisions, none on the obvious.
- **Gates for every task:**
  - root: `npx vitest run <file>`, then `npx tsc --noEmit` before committing
  - companion tasks: also `cd companion && npx vitest run <file>`
- **Commits go to `main`** (the repo's convention). **No push and no tag** without Nick's explicit go-ahead.
- **Every commit message ends with:**
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- **Release version:** `1.59.0`, in `package.json`, `manifest.json` and `shared/version.ts`.
- **Fixtures in this public repo carry no personal details.**
  - The delivery line is always `Jordan - SPRINGFIELD, IL`.
  - Link query strings are removed.
  - Product names in the cancellation fixture are replaced with `Example item`.

## Review Focus

1. **A copy stating both a per-shipment `Total` and a `Grand Total`.** Expected: the grand total wins, not a conflict. Pinned in Task 2.
2. **A pending charge, or a linked transfer half, whose order matched.** Expected: no late label. The pending update that posts the charge carries the label itself, and a linked half must never be rewritten. Pinned in Task 8.
3. **A note that already carries the label.** Expected: never rewritten again, so the late label is idempotent across syncs and across the two writers. Pinned in Task 8.
4. **A hand-forwarded email.** Its body holds the user's own address in a `From:` line. Expected: the sample removes it, but keeps Amazon's own sender addresses, which the forwarded-mail check needs. Pinned in Task 4.
5. **New addon with an old companion** (no samples secret, and no `getAmazonMailSamples` on a mock). Expected: the card renders exactly as before. Pinned in Task 7.

---

### Task 1: Totals — unrounded floats and `Subtotal`

**Files:**
- Modify: `shared/amazon.ts` (the `TOTAL` constant, ~line 77; the total handling in `parseAmazonEmail`, ~lines 205-219)
- Test: `shared/amazon.test.ts` (inside `describe('parseAmazonEmail', …)`)

**Interfaces:**
- Produces: `TOTAL` with capture groups `1` = `Grand ` (optional), `2` = the `$` amount, `3` = the `USD` amount. Also `function toCents(m: RegExpMatchArray): number`. Both are module-private, and used by Tasks 2–3.

- [ ] **Step 1: Write the failing tests.** Add inside `describe('parseAmazonEmail', …)`, after the `'accepts the "N.NN USD" total…'` test:

```ts
  it('rounds the unrounded float the plain-text copy prints', () => {
    // Live from 2026-09-15: `Total` / `10.799999999999999 USD` for a $10.80
    // shipment. Exactly-two-decimals refused it, and the order was lost.
    const rows = parseAmazonEmail(
      'Your package was shipped!\nOrder # 113-2704312-9904237\n1 Hair Care item\nTotal\n10.799999999999999 USD',
    );
    expect(rows[0].totalCents).toBe(1080);
  });

  it('does not read an item subtotal as the total', () => {
    const rows = parseAmazonEmail(
      'Thanks for your order!\nOrder # 111-2223334-4445556\n1 Electronics item\nItem Subtotal: $9.00\nGrand Total: $9.54',
    );
    expect(rows[0].totalCents).toBe(954);
  });
```

- [ ] **Step 2: Run them and see them fail.**
  - Run: `npx vitest run shared/amazon.test.ts -t "unrounded float|item subtotal"`
  - Expected: FAIL. The first test gets `rows[0]` undefined (TypeError). The second gets `900`.

- [ ] **Step 3: Implement.** Replace the `TOTAL` constant and its doc comment's last paragraph with:

```ts
/**
 * `Grand Total:\t$21.18` on a confirmation, `Total\t$10.55` on a shipment — the
 * `$` form used until ~Aug 2026. Since then Amazon also writes the amount with no
 * dollar sign and a `USD` suffix instead, on the NEXT line: `Grand Total:` then
 * `4.23 USD`. The `\s*` already spans the newline, so only the currency marker
 * needed widening. One of `$` or `USD` is required either way — a bare number
 * must never be read as a total, or `Total items shipped: 4` would misparse.
 *
 * Any number of decimals, rounded to cents: since Sep 2026 the plain-text copy
 * prints an unrounded binary float (`10.799999999999999 USD` for $10.80). And
 * `Total` must be a whole word, so `Item Subtotal:` is never read as the total.
 * Group 1 is `Grand ` when present (see `copyTotal`), 2 the `$` amount, 3 the
 * `USD` amount.
 */
const TOTAL = /\b(Grand\s+)?Total\b:?\s*(?:\$\s*([\d,]+\.\d+)|([\d,]+\.\d+)\s*USD\b)/i;

/** Integer cents from a `TOTAL` match. Rounded, not truncated — see `TOTAL`. */
function toCents(m: RegExpMatchArray): number {
  return Math.round(parseFloat((m[2] ?? m[3] ?? '').replace(/,/g, '')) * 100);
}
```

  In `parseAmazonEmail`, replace these lines:

```ts
    const totalMatch = TOTAL.exec(part);
    const total = totalMatch?.[1] ?? totalMatch?.[2];
    // All three or nothing: an order with no total cannot be matched to a charge,
    // and half a record would sit in the ledger forever pretending to be usable.
    if (!id || !item || !total) continue;
```

  with:

```ts
    const totalMatch = TOTAL.exec(part);
    // All three or nothing: an order with no total cannot be matched to a charge,
    // and half a record would sit in the ledger forever pretending to be usable.
    if (!id || !item || !totalMatch) continue;
```

  Then replace `totalCents: Math.round(parseFloat(total.replace(/,/g, '')) * 100),` with `totalCents: toCents(totalMatch),`.

- [ ] **Step 4: Run the whole file.**
  - Run: `npx vitest run shared/amazon.test.ts`
  - Expected: PASS, every test, old and new.

- [ ] **Step 5: Commit.**

```bash
npx tsc --noEmit && git add shared/amazon.ts shared/amazon.test.ts && git commit -m "Amazon totals: round unrounded floats; Subtotal is not a total

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Read each copy separately

**Files:**
- Modify: `shared/amazon.ts`. This replaces everything from `export function parseAmazonEmail` through `export function classifyAmazonEmail`, keeps `findItemLine`, and updates `splitLabels`.
- Create: `shared/__fixtures__/amazon-emails/2026-09-15-shipped-hair-care.json`
- Create: `shared/__fixtures__/amazon-emails/2026-10-05-shipped-four-items.json`
- Create: `shared/__fixtures__/amazon-emails/2026-10-07-shipped-charging-accessories.json`
- Create: `shared/__fixtures__/amazon-emails/2026-10-07-shipped-electronics.json`
- Create: `shared/amazon-fixtures.test.ts`
- Test: `shared/amazon.test.ts` (a new `describe` at the end)

**Interfaces:**
- Consumes: `TOTAL`, `toCents` (Task 1).
- Produces:
  - `export interface AmazonMailParts { subject?: string | null; plain?: string | null; html?: string | null }`
  - `parseAmazonEmail(input: string | AmazonMailParts): AmazonOrderRecord[]`
  - `classifyAmazonEmail(input: string | AmazonMailParts): AmazonEmailClassification`
  - Module-private, used by Task 3: `toParts`, `joinParts`, `stripMarks`, `orderIdsIn`.
  - A bare string means `{ plain: string }`, so every existing caller and test keeps working.

- [ ] **Step 1: Create the four shipment fixtures.** Content is exact: rebuilt from the 2026-10-10 `amazon-unread` output, then redacted.

`shared/__fixtures__/amazon-emails/2026-09-15-shipped-hair-care.json`:

```json
{
  "note": "Live 2026-09-15, shipment-tracking@amazon.com. Rebuilt from amazon-unread output (lines trimmed, delivery line and link queries redacted). The plain copy has its own Order # but no category line, and prints its total as an unrounded float.",
  "subject": "Shipped 1 item: Hair Care",
  "plain": [
    "Your Orders",
    "https://www.amazon.com/gp/css/order-history",
    "Your Account",
    "https://www.amazon.com/your-account",
    "Buy Again",
    "https://www.amazon.com/gp/buyagain",
    "    Your package was shipped!",
    "Ordered",
    "Shipped",
    "Out for delivery",
    "Delivered",
    "Arriving tomorrow",
    "Jordan - SPRINGFIELD, IL",
    "Order #",
    "113-2704312-9904237",
    "Track package",
    "https://www.amazon.com/progress-tracker/package",
    "Total",
    "10.799999999999999 USD",
    "View related transactions in Your Transactions",
    "https://www.amazon.com/cpe/yourpayments/transactions delivery driver may contact you on the day of delivery",
    "©2026 Amazon.com, Inc. or its affiliates. Amazon and all related marks are trademarks of Amazon.com, Inc. or its affiliates, Amazon.com, Inc. 410 Terry Avenue N",
    "Your invoice can be accessed [here.](https://www.amazon.com/gp/css/summary/print.html) One or more items in",
    "Privacy Notice https://www.amazon.com/gp/help/customer/display.html",
    "Amazon.com",
    "96",
    "96"
  ],
  "html": [
    "Shipped 1 item: Hair Care",
    "Your Orders",
    "Your Account",
    "Buy Again",
    "Your package was shipped!",
    "Ordered",
    "Shipped",
    "Out for delivery",
    "Delivered",
    "Arriving tomorrow",
    "1 Hair Care item",
    "Jordan - SPRINGFIELD, IL",
    "Order #",
    "113-2704312-9904237",
    "Track package",
    "Total",
    "  $10.80",
    "View related transactions in",
    "Your Transactions",
    ".",
    "A delivery driver may contact you on the day of delivery. For everyone’s safety, ensure a clear, well-lit path and secure pets before arrival.",
    "©2026 Amazon.com, Inc. or its affiliates. Amazon and all related marks are trademarks of Amazon.com, Inc. or its affiliates, Amazon.com, Inc. 410 Terry Avenue N",
    "Your invoice can be accessed",
    "here.",
    "One or more items in your shipment was supplied by a different seller than the seller you purchased the item from. Visit",
    "Your Orders",
    " from a web browser to see the suppliers of these items on your invoices.",
    "Unless otherwise noted, items sold by Amazon are subject to sales tax in selected states or provinces in accordance with the applicable laws of that state. If y",
    "tax and seller information",
    ".",
    "Privacy Notice"
  ],
  "expect": {
    "status": "orders",
    "orders": [
      { "orderId": "113-2704312-9904237", "kind": "shipped", "totalCents": 1080, "itemCount": 1, "labels": ["Hair Care"] }
    ]
  }
}
```

`shared/__fixtures__/amazon-emails/2026-10-05-shipped-four-items.json`:

```json
{
  "note": "Live 2026-10-05, shipment-tracking@amazon.com. Rebuilt from amazon-unread output (lines trimmed, delivery line and link queries redacted; the tool cut the HTML copy one line short). Three-plus categories: the body names two and withholds two.",
  "subject": "Shipped 4 items: Electronics, Irons & Steamers, and more",
  "plain": [
    "Your Orders",
    "https://www.amazon.com/gp/css/order-history",
    "Your Account",
    "https://www.amazon.com/your-account",
    "Buy Again",
    "https://www.amazon.com/gp/buyagain",
    "    Your package was shipped!",
    "Ordered",
    "Shipped",
    "Out for delivery",
    "Delivered",
    "Arriving tomorrow",
    "Jordan - SPRINGFIELD, IL",
    "Order #",
    "113-3583199-4585009",
    "Track package",
    "https://www.amazon.com/progress-tracker/package",
    "Total",
    "127.01000000000002 USD",
    "View related transactions in Your Transactions",
    "https://www.amazon.com/cpe/yourpayments/transactions delivery driver may contact you on the day of delivery",
    "transactional-pbdd-lu-banner-prime",
    "https://www.amazon.com/primebigdealdays",
    "©2026 Amazon.com, Inc. or its affiliates. Amazon and all related marks are trademarks of Amazon.com, Inc. or its affiliates, Amazon.com, Inc. 410 Terry Avenue N",
    "Your invoice can be accessed [here.](https://www.amazon.com/gp/css/summary/print.html) One or more items in",
    "Privacy Notice https://www.amazon.com/gp/help/customer/display.html",
    "Amazon.com",
    "96",
    "96"
  ],
  "html": [
    "Shipped 4 items: Electronics, Irons & Steamers, and more",
    "Your Orders",
    "Your Account",
    "Buy Again",
    "Your package was shipped!",
    "Ordered",
    "Shipped",
    "Out for delivery",
    "Delivered",
    "Arriving tomorrow",
    "4 items: 1 Electronics, 1 Irons & Steamers, and 2 others",
    "Jordan - SPRINGFIELD, IL",
    "Order #",
    "113-3583199-4585009",
    "Track package",
    "Total",
    "  $127.01",
    "View related transactions in",
    "Your Transactions",
    ".",
    "A delivery driver may contact you on the day of delivery. For everyone’s safety, ensure a clear, well-lit path and secure pets before arrival.",
    "©2026 Amazon.com, Inc. or its affiliates. Amazon and all related marks are trademarks of Amazon.com, Inc. or its affiliates, Amazon.com, Inc. 410 Terry Avenue N",
    "Your invoice can be accessed",
    "here.",
    "One or more items in your shipment was supplied by a different seller than the seller you purchased the item from. Visit",
    "Your Orders",
    " from a web browser to see the suppliers of these items on your invoices.",
    "Unless otherwise noted, items sold by Amazon are subject to sales tax in selected states or provinces in accordance with the applicable laws of that state. If y",
    "tax and seller information",
    "."
  ],
  "expect": {
    "status": "orders",
    "orders": [
      { "orderId": "113-3583199-4585009", "kind": "shipped", "totalCents": 12701, "itemCount": 4, "labels": ["Electronics", "Irons & Steamers"], "partial": true }
    ]
  }
}
```

`shared/__fixtures__/amazon-emails/2026-10-07-shipped-charging-accessories.json`:

```json
{
  "note": "Live 2026-10-07, shipment-tracking@amazon.com. Rebuilt from amazon-unread output (lines trimmed, delivery line and link queries redacted; the tool cut the HTML copy one line short). First package of a two-package order: single-category wording `1 item: X`.",
  "subject": "Shipped 1 item: Charging Accessories",
  "plain": [
    "Your Orders",
    "https://www.amazon.com/gp/css/order-history",
    "Prime Big Deals",
    "https://www.amazon.com/primebigdealdays",
    "Buy Again",
    "https://www.amazon.com/gp/buyagain",
    "    Your package was shipped!",
    "Ordered",
    "Shipped",
    "Out for delivery",
    "Delivered",
    "Arriving tomorrow",
    "Jordan - SPRINGFIELD, IL",
    "Order #",
    "114-6128714-5558609",
    "Track package",
    "https://www.amazon.com/progress-tracker/package",
    "Total",
    "8.110000000000001 USD",
    "View related transactions in Your Transactions",
    "https://www.amazon.com/cpe/yourpayments/transactions delivery driver may contact you on the day of delivery",
    "transactional-pbdd-lu-banner-prime",
    "https://www.amazon.com/primebigdealdays",
    "©2026 Amazon.com, Inc. or its affiliates. Amazon and all related marks are trademarks of Amazon.com, Inc. or its affiliates, Amazon.com, Inc. 410 Terry Avenue N",
    "Your invoice can be accessed [here.](https://www.amazon.com/gp/css/summary/print.html) One or more items in",
    "Privacy Notice https://www.amazon.com/gp/help/customer/display.html",
    "Amazon.com",
    "96",
    "96"
  ],
  "html": [
    "Shipped 1 item: Charging Accessories",
    "Your Orders",
    "Prime Big Deals",
    "Buy Again",
    "Your package was shipped!",
    "Ordered",
    "Shipped",
    "Out for delivery",
    "Delivered",
    "Arriving tomorrow",
    "1 item: Charging Accessories",
    "Jordan - SPRINGFIELD, IL",
    "Order #",
    "114-6128714-5558609",
    "Track package",
    "Total",
    "  $8.11",
    "View related transactions in",
    "Your Transactions",
    ".",
    "A delivery driver may contact you on the day of delivery. For everyone’s safety, ensure a clear, well-lit path and secure pets before arrival.",
    "©2026 Amazon.com, Inc. or its affiliates. Amazon and all related marks are trademarks of Amazon.com, Inc. or its affiliates, Amazon.com, Inc. 410 Terry Avenue N",
    "Your invoice can be accessed",
    "here.",
    "One or more items in your shipment was supplied by a different seller than the seller you purchased the item from. Visit",
    "Your Orders",
    " from a web browser to see the suppliers of these items on your invoices.",
    "Unless otherwise noted, items sold by Amazon are subject to sales tax in selected states or provinces in accordance with the applicable laws of that state. If y",
    "tax and seller information",
    "."
  ],
  "expect": {
    "status": "orders",
    "orders": [
      { "orderId": "114-6128714-5558609", "kind": "shipped", "totalCents": 811, "itemCount": 1, "labels": ["Charging Accessories"] }
    ]
  }
}
```

`shared/__fixtures__/amazon-emails/2026-10-07-shipped-electronics.json`:

```json
{
  "note": "Live 2026-10-07, shipment-tracking@amazon.com. Rebuilt from amazon-unread output (lines trimmed, delivery line and link queries redacted). Second package of the same order as the Charging Accessories email, at a different total.",
  "subject": "Shipped 1 item: Electronics",
  "plain": [
    "Your Orders",
    "https://www.amazon.com/gp/css/order-history",
    "Prime Big Deals",
    "https://www.amazon.com/primebigdealdays",
    "Buy Again",
    "https://www.amazon.com/gp/buyagain",
    "    Your package was shipped!",
    "Ordered",
    "Shipped",
    "Out for delivery",
    "Delivered",
    "Arriving tomorrow",
    "Jordan - SPRINGFIELD, IL",
    "Order #",
    "114-6128714-5558609",
    "Track package",
    "https://www.amazon.com/progress-tracker/package",
    "Total",
    "50.870000000000005 USD",
    "View related transactions in Your Transactions",
    "https://www.amazon.com/cpe/yourpayments/transactions delivery driver may contact you on the day of delivery",
    "transactional-pbdd-lu-banner-prime",
    "https://www.amazon.com/primebigdealdays",
    "©2026 Amazon.com, Inc. or its affiliates. Amazon and all related marks are trademarks of Amazon.com, Inc. or its affiliates, Amazon.com, Inc. 410 Terry Avenue N",
    "Your invoice can be accessed [here.](https://www.amazon.com/gp/css/summary/print.html) Unless otherwise not",
    "Privacy Notice https://www.amazon.com/gp/help/customer/display.html",
    "Amazon.com",
    "96",
    "96"
  ],
  "html": [
    "Shipped 1 item: Electronics",
    "Your Orders",
    "Prime Big Deals",
    "Buy Again",
    "Your package was shipped!",
    "Ordered",
    "Shipped",
    "Out for delivery",
    "Delivered",
    "Arriving tomorrow",
    "1 item: Electronics",
    "Jordan - SPRINGFIELD, IL",
    "Order #",
    "114-6128714-5558609",
    "Track package",
    "Total",
    "  $50.87",
    "View related transactions in",
    "Your Transactions",
    ".",
    "A delivery driver may contact you on the day of delivery. For everyone’s safety, ensure a clear, well-lit path and secure pets before arrival.",
    "©2026 Amazon.com, Inc. or its affiliates. Amazon and all related marks are trademarks of Amazon.com, Inc. or its affiliates, Amazon.com, Inc. 410 Terry Avenue N",
    "Your invoice can be accessed",
    "here.",
    "Unless otherwise noted, items sold by Amazon are subject to sales tax in selected states or provinces in accordance with the applicable laws of that state. If y",
    "tax and seller information",
    ".",
    "Privacy Notice"
  ],
  "expect": {
    "status": "orders",
    "orders": [
      { "orderId": "114-6128714-5558609", "kind": "shipped", "totalCents": 5087, "itemCount": 1, "labels": ["Electronics"] }
    ]
  }
}
```

- [ ] **Step 2: Create the fixture runner.** Write `shared/amazon-fixtures.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { classifyAmazonEmail, type AmazonEmailClassification } from './amazon.js';

/**
 * Every real Amazon email the parser has been fixed against, one file each, in
 * the shape the Amazon card's "Show what couldn't be read" copies (plus
 * `expect`). One test per file, so a fix for a new layout can never silently
 * break an old one — which is how the Sept 2026 fix shipped a parser that read
 * a single copy and broke on the real three-copy message.
 *
 * Adding a format: paste the card's copied sample into a new file here, add
 * `expect`, and make it pass.
 */
interface AmazonEmailFixture {
  note: string;
  subject: string;
  plain: string[];
  html: string[];
  expect: AmazonEmailClassification;
}

const DIR = join(process.cwd(), 'shared', '__fixtures__', 'amazon-emails');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

describe('real Amazon emails', () => {
  it('has fixtures to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(file, () => {
      const fx = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as AmazonEmailFixture;
      expect(classifyAmazonEmail({
        subject: fx.subject,
        plain: fx.plain.join('\n'),
        html: fx.html.join('\n'),
      })).toEqual(fx.expect);
    });
  }
});
```

- [ ] **Step 3: Write the unit tests.** Append to `shared/amazon.test.ts`:

```ts
describe('reading each copy of an email separately', () => {
  // Since 2026-09-15 Amazon's plain-text copy carries its own "Order #" but no
  // category line, and prints its total as an unrounded float. Glued into one
  // document with the HTML copy, the category and the only readable total fell
  // into different chunks and every shipment read as unrecognised.
  const html = [
    'Your package was shipped!', '1 Hair Care item', 'Order #', '113-2704312-9904237', 'Total', '  $10.80',
  ].join('\n');
  const plain = [
    'Your package was shipped!', 'Order #', '113-2704312-9904237', 'Total', '10.799999999999999 USD',
  ].join('\n');

  it('takes the category from the copy that has it and checks the totals agree', () => {
    expect(parseAmazonEmail({ subject: 'Shipped 1 item: Hair Care', plain, html })).toEqual([{
      orderId: '113-2704312-9904237', kind: 'shipped', totalCents: 1080, itemCount: 1, labels: ['Hair Care'],
    }]);
  });

  it('refuses an order whose copies state different totals', () => {
    const wrong = plain.replace('10.799999999999999', '12.50');
    expect(classifyAmazonEmail({ subject: 'Shipped 1 item: Hair Care', plain: wrong, html }).status)
      .toBe('unrecognised');
  });

  it('falls back to the subject when no body copy names a category', () => {
    const bare = html.replace('1 Hair Care item\n', '');
    expect(parseAmazonEmail({ subject: 'Shipped 1 item: Hair Care', plain, html: bare })[0].labels)
      .toEqual(['Hair Care']);
  });

  it('marks a subject list ending "and more" as partial', () => {
    const bare = html.replace('1 Hair Care item\n', '');
    const [order] = parseAmazonEmail({
      subject: 'Shipped 4 items: Electronics, Irons & Steamers, and more', plain, html: bare,
    });
    expect(order).toMatchObject({ itemCount: 4, labels: ['Electronics', 'Irons & Steamers'], partial: true });
  });

  it('takes the email type from the subject verb', () => {
    const neutral = html.replace('Your package was shipped!\n', '');
    expect(parseAmazonEmail({ subject: 'Shipped 1 item: Hair Care', html: neutral })[0].kind).toBe('shipped');
  });

  it('prefers the grand total when a copy also states a per-shipment total', () => {
    const [order] = parseAmazonEmail({
      html: ['Thanks for your order!', '1 Books item', 'Order #', '113-0000000-0000009', 'Total $5.00', 'Grand Total: $9.54'].join('\n'),
    });
    expect(order.totalCents).toBe(954);
  });

  it('pairs several orders inside one copy and drops one another copy contradicts', () => {
    const htmlTwo = [
      'Thanks for your order!',
      '1 Hair Care item', 'Order # 113-0000000-0000001', 'Grand Total:', '$10.80',
      '2 Books items', 'Order # 113-0000000-0000002', 'Grand Total:', '$25.00',
    ].join('\n');
    const plainTwo = [
      'Thanks for your order!',
      'Order # 113-0000000-0000001', 'Grand Total:', '10.80 USD',
      'Order # 113-0000000-0000002', 'Grand Total:', '26.00 USD',
    ].join('\n');
    expect(parseAmazonEmail({ html: htmlTwo, plain: plainTwo }).map((o) => o.orderId))
      .toEqual(['113-0000000-0000001']);
  });
});
```

- [ ] **Step 4: Run them and see them fail.**
  - Run: `npx vitest run shared/amazon.test.ts shared/amazon-fixtures.test.ts`
  - Expected: FAIL. The new tests and the four fixture tests fail: `classifyAmazonEmail` calls `.replace` on an object, which throws a TypeError. All pre-existing tests still PASS.

- [ ] **Step 5: Implement.** In `shared/amazon.ts`:

  (a) In `splitLabels`, change the filter line to drop the subject's `and more` as well. Then add one line to its doc comment: "`more` is the subject line's version of the same thing (`Shipped 4 items: A, B, and more`)."

```ts
  const labels = parts.filter((p) => !/^(?:others?|more)$/i.test(p));
```

  (b) Directly after `const ORDER_ID = …;`, add:

```ts
const ORDER_ID_ALL = new RegExp(ORDER_ID.source, 'g');
```

  (c) Replace the whole `export function parseAmazonEmail(body: string) { … }` with the code below. Keep its existing doc comment, and append the "ONE ORDER NUMBER / SEVERAL" paragraph shown here.

```ts
/**
 * One message's three copies, each already plain text (the companion reduces
 * the HTML part with `htmlToText` before it gets here).
 *
 * KEPT APART, not joined. Until Oct 2026 the companion glued all three into
 * one document, and that broke the moment the copies stopped agreeing on
 * layout: Amazon's plain-text copy grew its own `Order #` with no category
 * line, so slicing the joined text at every `Order #` left the category in one
 * chunk and the only readable total in the next. Each copy is now read on its
 * own and the results are combined by order number.
 */
export interface AmazonMailParts {
  subject?: string | null;
  plain?: string | null;
  html?: string | null;
}

/** A bare string is one copy — how every caller worked before the copies were
 *  kept apart, and how a hand-pasted body still arrives. */
function toParts(input: string | AmazonMailParts): AmazonMailParts {
  return typeof input === 'string' ? { plain: input } : input;
}

function joinParts(parts: AmazonMailParts): string {
  return [parts.subject, parts.plain, parts.html].filter((s): s is string => !!s).join('\n');
}

const stripMarks = (s: string | null | undefined): string => (s ?? '').replace(BIDI_CONTROLS, '');

/** `Shipped 1 item: Hair Care` — the subject's first word names the email type. */
const SUBJECT_KIND = /^\s*(Ordered|Shipped|Delivered)\b/i;
/**
 * The category list in a SUBJECT, in its two observed shapes:
 *   Shipped 4 items: Electronics, Irons & Steamers, and more   (Sep 2026 on)
 *   Ordered: 1 Essentials item                                 (Aug 2026)
 * A backup only: subjects get cut short (`Item cancelled successfully:
 * "Amazon Basics USB-C to..."`), so a body line wins whenever one exists.
 */
const SUBJECT_ITEMS_COLON = /^\s*(?:Ordered|Shipped|Delivered)\s+(\d+)\s+items?\s*:\s*(.+?)\s*$/i;
const SUBJECT_ITEMS_SUFFIX = /^\s*(?:Ordered|Shipped|Delivered)\s*:\s*(\d+)\s+(.+?)\s+items?\s*$/i;

interface ItemFacts { count: number; labels: string[]; partial: boolean }

function kindOf(subject: string, bodies: string[]): AmazonOrderRecord['kind'] | null {
  const verb = SUBJECT_KIND.exec(subject)?.[1];
  if (verb) return verb.toLowerCase() as AmazonOrderRecord['kind'];
  return detectKind(bodies.join('\n'));
}

function orderIdsIn(text: string): string[] {
  const ids: string[] = [];
  for (const m of text.matchAll(ORDER_ID_ALL)) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

function itemFacts(found: { match: RegExpExecArray; breakdown: boolean } | null): ItemFacts | null {
  if (!found) return null;
  const { labels, partial } = splitLabels(found.match[2], found.breakdown);
  return labels.length > 0 ? { count: Number(found.match[1]) || 1, labels, partial } : null;
}

function subjectItemFacts(subject: string): ItemFacts | null {
  const m = SUBJECT_ITEMS_COLON.exec(subject) ?? SUBJECT_ITEMS_SUFFIX.exec(subject);
  if (!m) return null;
  const { labels, partial } = splitLabels(m[2]);
  return labels.length > 0 ? { count: Number(m[1]) || 1, labels, partial } : null;
}

/**
 * The one total a copy states for a single-order email: cents, `null` when it
 * states none, `'conflict'` when it states two different ones.
 *
 * `Grand Total` outranks a bare `Total` — a confirmation can carry both, and
 * the grand figure is the order's. Two different figures at the same rank are
 * not resolved by guessing which one the bank will show.
 */
function copyTotal(text: string): number | null | 'conflict' {
  const all = [...text.matchAll(new RegExp(TOTAL.source, 'gi'))];
  const grand = all.filter((m) => !!m[1]);
  const cents = [...new Set((grand.length > 0 ? grand : all).map(toCents))];
  if (cents.length === 0) return null;
  return cents.length === 1 ? cents[0] : 'conflict';
}

/** Each order's total in one copy, keyed by order id — the cross-check for a
 *  multi-order email. Totals follow their `Order #` in every layout seen. */
function totalsByOrder(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const starts = [...text.matchAll(/Order\s*#/g)].map((m) => m.index ?? 0);
  starts.forEach((start, i) => {
    const chunk = text.slice(start, starts[i + 1] ?? text.length);
    const id = ORDER_ID.exec(chunk)?.[1];
    const total = TOTAL.exec(chunk);
    if (id && total && !out.has(id)) out.set(id, toCents(total));
  });
  return out;
}

/**
 * Every order an email describes.
 *
 * Returns an ARRAY because one message legitimately covers several orders — the
 * live sample carried two, each with its own order number, label and grand total.
 *
 * Unrecognised text yields `[]` rather than a partial guess. Amazon changed this
 * format five weeks ago and may again; a wrong category on real money is invisible
 * (it looks exactly like a right one) whereas a missing one is merely absent, so
 * absent is the only acceptable failure direction.
 *
 * ONE ORDER NUMBER (every shipment notice seen so far): no positional logic at
 * all. The category comes from the first body copy that has a category line,
 * else the subject; every copy that states a total must state the same one.
 * SEVERAL: the positional pairing in `parseCopy`, run inside one copy at a
 * time (HTML first), with the other copies' totals as a cross-check.
 */
export function parseAmazonEmail(input: string | AmazonMailParts): AmazonOrderRecord[] {
  const parts = toParts(input);
  const subject = stripMarks(parts.subject);
  // HTML first: it is the copy that still carries the category line.
  const bodies = [stripMarks(parts.html), stripMarks(parts.plain)].filter((b) => b.trim() !== '');
  const kind = kindOf(subject, bodies);
  if (!kind) return [];
  const ids = [...new Set(bodies.flatMap(orderIdsIn))];
  if (ids.length === 0) return [];
  return ids.length === 1 ? singleOrder(ids[0], kind, subject, bodies) : severalOrders(kind, bodies);
}

function singleOrder(
  orderId: string,
  kind: AmazonOrderRecord['kind'],
  subject: string,
  bodies: string[],
): AmazonOrderRecord[] {
  const totals = bodies.map(copyTotal);
  if (totals.includes('conflict')) return [];
  const stated = [...new Set(totals.filter((t): t is number => typeof t === 'number'))];
  // All three or nothing (see `parseCopy`), and every copy that names a total
  // must name the same one.
  if (stated.length !== 1) return [];
  const item = bodies.map((b) => itemFacts(findItemLine(b, 'first'))).find((f): f is ItemFacts => f !== null)
    ?? subjectItemFacts(subject);
  if (!item) return [];
  return [{
    orderId,
    kind,
    totalCents: stated[0],
    itemCount: item.count,
    labels: item.labels,
    ...(item.partial ? { partial: true } : {}),
  }];
}

function severalOrders(kind: AmazonOrderRecord['kind'], bodies: string[]): AmazonOrderRecord[] {
  for (let i = 0; i < bodies.length; i++) {
    const records = parseCopy(bodies[i], kind);
    if (records.length === 0) continue;
    const others = bodies.filter((_, j) => j !== i).map(totalsByOrder);
    return records.filter((r) => others.every((t) => !t.has(r.orderId) || t.get(r.orderId) === r.totalCents));
  }
  return [];
}

/** The positional reading of ONE copy: what `parseAmazonEmail` did to the
 *  whole message before the copies were kept apart. */
function parseCopy(text: string, kind: AmazonOrderRecord['kind']): AmazonOrderRecord[] {
  // One message can hold several orders, each introduced by its own `Order #`.
  // Slicing on that marker keeps each order's label and total with the right id;
  // a single global regex pass would happily pair order A's id with order B's
  // total.
  const parts: string[] = [];
  const marker = /Order\s*#/g;
  const starts: number[] = [];
  for (let m = marker.exec(text); m; m = marker.exec(text)) starts.push(m.index);
  if (starts.length === 0) return [];
  for (let i = 0; i < starts.length; i++) {
    parts.push(text.slice(starts[i], starts[i + 1] ?? text.length));
  }

  // Two layouts. Until Sep 2026 the item line FOLLOWED "Order #"; since then
  // (live, 2026-09-14: "Ordered 1 item: Hair Care") it comes BEFORE it. In the
  // new layout an order's item line sits between the previous order number and
  // its own, so it is the LAST item line in that stretch; reading the chunk
  // after "Order #" would find the NEXT order's line, or none.
  const itemFirst = findItemLine(text.slice(0, starts[0]), 'first') !== null;

  const records: AmazonOrderRecord[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const id = ORDER_ID.exec(part)?.[1];
    const found = itemFirst
      ? findItemLine(text.slice(i === 0 ? 0 : starts[i - 1], starts[i]), 'last')
      : findItemLine(part, 'first');
    const breakdown = found?.breakdown ? found.match : null;
    const item = found?.match ?? null;
    const totalMatch = TOTAL.exec(part);
    // All three or nothing: an order with no total cannot be matched to a charge,
    // and half a record would sit in the ledger forever pretending to be usable.
    if (!id || !item || !totalMatch) continue;
    const { labels, partial } = splitLabels(item[2], !!breakdown);
    if (labels.length === 0) continue;
    records.push({
      orderId: id,
      kind,
      totalCents: toCents(totalMatch),
      itemCount: Number(item[1]) || 1,
      labels,
      ...(partial ? { partial: true } : {}),
    });
  }
  return records;
}
```

  (d) Replace `classifyAmazonEmail` (keep its doc comment):

```ts
export function classifyAmazonEmail(input: string | AmazonMailParts): AmazonEmailClassification {
  const orders = parseAmazonEmail(input);
  if (orders.length > 0) return { orders, status: 'orders' };
  return { orders, status: isAmazonNoticeWithoutTotal(joinParts(toParts(input))) ? 'ignored' : 'unrecognised' };
}
```

- [ ] **Step 6: Run the parser tests.**
  - Run: `npx vitest run shared/amazon.test.ts shared/amazon-fixtures.test.ts`
  - Expected: PASS, every test, including all the pre-existing ones.
  - If a pre-existing single-order test fails with `[]`, that copy states two different same-rank totals. Print the copy's matches and decide from the evidence. Do not loosen `copyTotal` blindly.

- [ ] **Step 7: Run everything that imports the parser, then commit.**
  - Run: `npx vitest run shared && npx tsc --noEmit`
  - Expected: PASS.

```bash
git add shared/amazon.ts shared/amazon.test.ts shared/amazon-fixtures.test.ts shared/__fixtures__/amazon-emails
git commit -m "Amazon parser: read subject, plain text and HTML separately; one order needs no layout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Cancellation notices

**Files:**
- Modify: `shared/amazon.ts` (the `AmazonEmailClassification` interface and `classifyAmazonEmail`)
- Modify: `shared/amazon-ledger.ts` (new export after `pruneAmazonLedger`)
- Create: `shared/__fixtures__/amazon-emails/2026-10-06-cancelled.json`
- Test: `shared/amazon.test.ts`, `shared/amazon-ledger.test.ts`

**Interfaces:**
- Consumes: `toParts`, `joinParts`, `stripMarks`, `orderIdsIn` (Task 2).
- Produces:
  - `AmazonEmailClassification.cancelledOrderIds?: string[]`, present only on a cancellation.
  - `retireCancelledOrders(ledger: AmazonLedger, orderIds: readonly string[]): { ledger: AmazonLedger; removed: number }`

- [ ] **Step 1: Create the cancellation fixture.** Write `shared/__fixtures__/amazon-emails/2026-10-06-cancelled.json`:

```json
{
  "note": "Live 2026-10-06, order-update@amazon.com. Rebuilt from amazon-unread output (lines trimmed, delivery line and link queries redacted, product name replaced with 'Example item'). A cancellation: nothing was charged, so it is skipped and names the order it cancels.",
  "subject": "Item cancelled successfully: \"Example item...\"",
  "plain": [
    "Your Orders",
    "https://www.amazon.com/gp/css/order-history",
    "Your Account",
    "https://www.amazon.com/your-account",
    "Buy Again",
    "https://www.amazon.com/gp/buyagain",
    "    Your items were cancelled",
    "Cancelled",
    "Your order was cancelled. You have not been charged for this order.",
    "Jordan - SPRINGFIELD, IL",
    "Order #",
    "113-2018846-2323410",
    "View order details",
    "https://www.amazon.com/your-orders/order-details",
    "* Example item",
    "  Quantity: 1",
    "  8.39 USD",
    "©2026 Amazon.com, Inc. or its affiliates. Amazon and all related marks are trademarks of Amazon.com, Inc. or its affiliates, Amazon.com, Inc. 410 Terry Avenue N",
    "Privacy Notice https://www.amazon.com/gp/help/customer/display.html",
    "Amazon.com",
    "96",
    "96"
  ],
  "html": [
    "Item cancelled successfully: \"Example item...\"",
    "Your Orders",
    "Your Account",
    "Buy Again",
    "Your items were cancelled",
    "Cancelled",
    "Your order was cancelled. You have not been charged for this order.",
    "Jordan - SPRINGFIELD, IL",
    "Order #",
    "113-2018846-2323410",
    "View order details",
    "Example item...",
    "Quantity: 1",
    "$",
    "8",
    "39",
    "$",
    "8",
    "39",
    "©2026 Amazon.com, Inc. or its affiliates. Amazon and all related marks are trademarks of Amazon.com, Inc. or its affiliates, Amazon.com, Inc. 410 Terry Avenue N",
    "Privacy Notice"
  ],
  "expect": { "orders": [], "status": "ignored", "cancelledOrderIds": ["113-2018846-2323410"] }
}
```

- [ ] **Step 2: Write the failing tests.** Append to `shared/amazon.test.ts`:

```ts
describe('cancellation notices', () => {
  const CANCELLED = {
    subject: 'Item cancelled successfully: "Example item..."',
    plain: [
      'Your items were cancelled',
      'Your order was cancelled. You have not been charged for this order.',
      'Order #', '113-2018846-2323410', 'Quantity: 1', '8.39 USD',
    ].join('\n'),
  };

  it('skips a cancellation and names the order it cancels', () => {
    expect(classifyAmazonEmail(CANCELLED)).toEqual({
      orders: [], status: 'ignored', cancelledOrderIds: ['113-2018846-2323410'],
    });
  });

  it('still reads the order in a shipment that mentions a cancelled item', () => {
    const r = classifyAmazonEmail(
      'Your package was shipped!\nOne item was cancelled.\nOrder # 113-0000000-0000003\n1 Books item\nTotal $12.00',
    );
    expect(r.status).toBe('orders');
    expect(r.cancelledOrderIds).toBeUndefined();
  });
});
```

  In `shared/amazon-ledger.test.ts`, add `retireCancelledOrders` to the existing import from `'./amazon-ledger.js'`, then append:

```ts
describe('retireCancelledOrders', () => {
  const rec = (orderId: string, kind: 'ordered' | 'shipped', consumedBy?: string) => ({
    orderId, kind, totalCents: 839, itemCount: 1, labels: ['Electronics'], emailDate: '2026-10-05',
    ...(consumedBy ? { consumedBy } : {}),
  });

  it('drops only the unconsumed confirmation records of a cancelled order', () => {
    // A shipment record means a charge happened, and a consumed record already
    // found its charge — neither is the cancelled order's leftover total.
    const ledger = {
      'A|ordered|839': rec('A', 'ordered'),
      'A|shipped|839': rec('A', 'shipped'),
      'B|ordered|839': rec('B', 'ordered'),
      'C|ordered|839': rec('C', 'ordered', 'sfin-1|tx-9'),
    };
    const { ledger: next, removed } = retireCancelledOrders(ledger, ['A', 'C']);
    expect(removed).toBe(1);
    expect(Object.keys(next).sort()).toEqual(['A|shipped|839', 'B|ordered|839', 'C|ordered|839']);
  });

  it('returns the same ledger when nothing was cancelled', () => {
    const ledger = { 'A|ordered|839': rec('A', 'ordered') };
    expect(retireCancelledOrders(ledger, [])).toEqual({ ledger, removed: 0 });
  });
});
```

- [ ] **Step 3: Run them and see them fail.**
  - Run: `npx vitest run shared/amazon.test.ts shared/amazon-ledger.test.ts shared/amazon-fixtures.test.ts -t "cancel|retire"`
  - Expected: FAIL. The status is `unrecognised` with no `cancelledOrderIds`, and `retireCancelledOrders` is not a function.

- [ ] **Step 4: Implement.** In `shared/amazon.ts`, add above `classifyAmazonEmail`:

```ts
/**
 * Amazon's cancellation notice, verbatim from the live 2026-10-06 message:
 * subject `Item cancelled successfully: "…"`, body `Your items were cancelled`
 * and `Your order was cancelled. You have not been charged for this order.`
 * Both spellings, since Amazon writes "canceled" elsewhere.
 */
const CANCELLATION = /\bcancell?ed successfully\b|\b(?:was|were|been)\s+cancell?ed\b/i;
```

  Add to `AmazonEmailClassification`:

```ts
  /**
   * Present only on a cancellation notice: the order numbers it names. The
   * mail reader retires their confirmation records, so a cancelled order's
   * total cannot be matched to an unrelated charge of the same amount.
   */
  cancelledOrderIds?: string[];
```

  Replace the body of `classifyAmazonEmail`:

```ts
export function classifyAmazonEmail(input: string | AmazonMailParts): AmazonEmailClassification {
  const orders = parseAmazonEmail(input);
  if (orders.length > 0) return { orders, status: 'orders' };
  const all = stripMarks(joinParts(toParts(input)));
  // Checked only once nothing parsed: a shipment that mentions a cancelled
  // item still carries its own order and must keep it.
  if (CANCELLATION.test(all)) return { orders, status: 'ignored', cancelledOrderIds: orderIdsIn(all) };
  return { orders, status: isAmazonNoticeWithoutTotal(all) ? 'ignored' : 'unrecognised' };
}
```

  In `shared/amazon-ledger.ts`, after `pruneAmazonLedger`:

```ts
/**
 * Drop the confirmation records of orders Amazon says were cancelled.
 *
 * A cancelled order's confirmation total will never be charged, but it would
 * sit in the ledger for 90 days as a candidate — and an unrelated Amazon charge
 * of the same amount inside the window would take its label. Only `ordered`
 * records go, and only unconsumed ones: a shipment record means a charge
 * happened, and a consumed record has already found its charge.
 */
export function retireCancelledOrders(
  ledger: AmazonLedger,
  orderIds: readonly string[],
): { ledger: AmazonLedger; removed: number } {
  if (orderIds.length === 0) return { ledger, removed: 0 };
  const next: AmazonLedger = {};
  let removed = 0;
  for (const [key, rec] of Object.entries(ledger)) {
    if (orderIds.includes(rec.orderId) && rec.kind === 'ordered' && !rec.consumedBy) {
      removed += 1;
      continue;
    }
    next[key] = rec;
  }
  return { ledger: next, removed };
}
```

- [ ] **Step 5: Run the tests.**
  - Run: `npx vitest run shared/amazon.test.ts shared/amazon-ledger.test.ts shared/amazon-fixtures.test.ts`
  - Expected: PASS. That includes all five fixture files.

- [ ] **Step 6: Commit.**

```bash
npx tsc --noEmit && git add shared/amazon.ts shared/amazon.test.ts shared/amazon-ledger.ts shared/amazon-ledger.test.ts shared/__fixtures__/amazon-emails/2026-10-06-cancelled.json
git commit -m "Amazon: skip cancellation notices and retire the cancelled order's confirmation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Redacted failure samples (shared)

**Files:**
- Modify: `shared/status-keys.ts` (append after `AmazonMailStatus`)
- Create: `shared/amazon-sample.ts`
- Test: `shared/amazon-sample.test.ts`

**Interfaces:**
- Consumes: `AmazonMailParts` (Task 2).
- Produces:
  - `AMAZON_MAIL_SAMPLES_SECRET_KEY = 'amazon_mail_samples'`
  - `interface AmazonMailSample { at: string; from?: string; subject: string; plain: string; html: string }`
  - `interface AmazonMailSamples { asOf: string; samples: AmazonMailSample[] }`
  - `AMAZON_SAMPLE_LIMIT = 5`
  - `redactAmazonText(text: string): string`
  - `toAmazonMailSample(msg: { date: string; from?: string; parts: AmazonMailParts }): AmazonMailSample`
  - `amazonSamplesAsFixtureText(samples: readonly AmazonMailSample[]): string`

- [ ] **Step 1: Write the failing tests.** Create `shared/amazon-sample.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { redactAmazonText, toAmazonMailSample, amazonSamplesAsFixtureText, AMAZON_SAMPLE_LIMIT } from './amazon-sample.js';

describe('redactAmazonText', () => {
  it('replaces the delivery line with the fixtures\' stand-in', () => {
    expect(redactAmazonText('Arriving tomorrow\nNicholas - LOUISVILLE, KY\nOrder #'))
      .toBe('Arriving tomorrow\nJordan - SPRINGFIELD, IL\nOrder #');
  });

  it('removes a personal address but keeps Amazon\'s own', () => {
    // A hand-forwarded order carries the forwarder's address AND Amazon's in its
    // From: lines; the forwarded-mail check needs Amazon's to recognise it.
    expect(redactAmazonText('From: Nick <nick@example.com>\nFrom: "Amazon.com" <auto-confirm@amazon.com>'))
      .toBe('From: Nick <<email>>\nFrom: "Amazon.com" <auto-confirm@amazon.com>');
  });

  it('drops link query strings, which carry tracking and shipment codes', () => {
    expect(redactAmazonText('https://www.amazon.com/progress-tracker/package?orderId=1&shipmentId=X'))
      .toBe('https://www.amazon.com/progress-tracker/package');
    expect(redactAmazonText('[here.](https://www.amazon.com/print.html?orderID=1) One'))
      .toBe('[here.](https://www.amazon.com/print.html) One');
  });
});

describe('toAmazonMailSample', () => {
  it('keeps the copies apart, redacted, without blank lines', () => {
    const s = toAmazonMailSample({
      date: '2026-10-05T17:11:52.000Z',
      from: 'shipment-tracking@amazon.com',
      parts: { subject: 'Shipped 1 item: Hair Care', plain: 'Order #\n\n   \nNicholas - LOUISVILLE, KY', html: '1 Hair Care item' },
    });
    expect(s).toEqual({
      at: '2026-10-05T17:11:52.000Z',
      from: 'shipment-tracking@amazon.com',
      subject: 'Shipped 1 item: Hair Care',
      plain: 'Order #\nJordan - SPRINGFIELD, IL',
      html: '1 Hair Care item',
    });
  });

  it('hides a sender that is not Amazon', () => {
    expect(toAmazonMailSample({ date: 'd', from: 'nick@example.com', parts: {} }).from).toBe('<email>');
  });

  it('trims each copy to 80 lines and 4,000 characters', () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n');
    const s = toAmazonMailSample({ date: 'd', parts: { plain: long } });
    expect(s.plain.split('\n').length).toBeLessThanOrEqual(80);
    expect(s.plain.length).toBeLessThanOrEqual(4000);
  });

  it('keeps at most five', () => {
    expect(AMAZON_SAMPLE_LIMIT).toBe(5);
  });
});

describe('amazonSamplesAsFixtureText', () => {
  it('writes the fixture shape, copies as line arrays', () => {
    const sample = { at: '2026-10-05T17:11:52.000Z', from: 'shipment-tracking@amazon.com', subject: 'S', plain: 'a\nb', html: 'c' };
    expect(JSON.parse(amazonSamplesAsFixtureText([sample]))).toEqual([{
      note: 'Captured 2026-10-05 from shipment-tracking@amazon.com',
      subject: 'S', plain: ['a', 'b'], html: ['c'],
    }]);
  });
});
```

- [ ] **Step 2: Run them and see them fail.**
  - Run: `npx vitest run shared/amazon-sample.test.ts`
  - Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement.** Append to `shared/status-keys.ts`:

```ts
/**
 * Up to five recent emails the parser could not read, personal details
 * removed — what the Amazon card's "Show what couldn't be read" copies.
 * Replaced on every completed scan, so it always matches
 * `AmazonMailStatus.unparsed` and clears itself once a fix reads the mail.
 * Left alone when the scan fails, like the status's count.
 */
export const AMAZON_MAIL_SAMPLES_SECRET_KEY = 'amazon_mail_samples';

/** One unreadable email, each copy redacted and trimmed (shared/amazon-sample.ts). */
export interface AmazonMailSample {
  /** The message's own date. */
  at: string;
  /** Amazon's sender address; `<email>` for anything else. */
  from?: string;
  subject: string;
  plain: string;
  html: string;
}

/** What the companion publishes under `AMAZON_MAIL_SAMPLES_SECRET_KEY`. */
export interface AmazonMailSamples {
  asOf: string;
  samples: AmazonMailSample[];
}
```

  Create `shared/amazon-sample.ts`:

```ts
/**
 * shared/amazon-sample.ts
 *
 * A copy of an Amazon email the parser could not read, safe to show and paste.
 *
 * WHY THIS EXISTS. When Amazon changes its format the failing text never left
 * the companion: diagnosing the 2026-10 break took a shell on the server and a
 * pasted terminal dump. The companion now keeps these, the Amazon card shows
 * them, and its Copy button produces a test fixture
 * (`shared/__fixtures__/amazon-emails/`) directly.
 *
 * Redaction is aimed at what a receipt actually carries about a person: the
 * delivery line, email addresses, and the query strings on links (tracking and
 * shipment codes). Order numbers stay — the parser needs them, and on their own
 * they open nothing. Host-agnostic: the companion builds samples, the addon
 * formats them.
 */
import type { AmazonMailParts } from './amazon.js';
import type { AmazonMailSample } from './status-keys.js';

export const AMAZON_SAMPLE_LIMIT = 5;
const MAX_LINES = 80;
const MAX_CHARS = 4000;

const EMAIL = /[\w.+-]+@(?:[\w-]+\.)+[\w-]+/g;
const AMAZON_ADDRESS = /@amazon\.[a-z.]+$/i;
/** `Nicholas - LOUISVILLE, KY` — Amazon's "ship to" line. Replaced with the
 *  stand-in every fixture already uses, so a sample pastes in unchanged. */
const DELIVERY_LINE = /^(\s*)\S[^\n]{0,60}? - [A-Z][A-Z .'-]*, [A-Z]{2}\s*$/gm;
/** Stops at `)` and `]` so a markdown link keeps its closing bracket. */
const URL_QUERY = /(https?:\/\/[^\s?#)\]]+)[?#][^\s)\]]*/g;

export function redactAmazonText(text: string): string {
  return text
    .replace(EMAIL, (addr) => (AMAZON_ADDRESS.test(addr) ? addr : '<email>'))
    .replace(DELIVERY_LINE, '$1Jordan - SPRINGFIELD, IL')
    .replace(URL_QUERY, '$1');
}

function trimCopy(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .slice(0, MAX_LINES)
    .join('\n')
    .slice(0, MAX_CHARS);
}

export function toAmazonMailSample(msg: { date: string; from?: string; parts: AmazonMailParts }): AmazonMailSample {
  const copy = (t: string | null | undefined) => trimCopy(redactAmazonText(t ?? ''));
  return {
    at: msg.date,
    ...(msg.from ? { from: AMAZON_ADDRESS.test(msg.from) ? msg.from : '<email>' } : {}),
    subject: redactAmazonText(msg.parts.subject ?? ''),
    plain: copy(msg.parts.plain),
    html: copy(msg.parts.html),
  };
}

/** The samples as test fixtures — the shape `shared/amazon-fixtures.test.ts`
 *  loads, minus the `expect` a fix adds. Copies are line arrays so a fixture
 *  diffs line by line. */
export function amazonSamplesAsFixtureText(samples: readonly AmazonMailSample[]): string {
  return JSON.stringify(samples.map((s) => ({
    note: `Captured ${s.at.slice(0, 10)} from ${s.from ?? 'an unknown sender'}`,
    subject: s.subject,
    plain: s.plain ? s.plain.split('\n') : [],
    html: s.html ? s.html.split('\n') : [],
  })), null, 2);
}
```

- [ ] **Step 4: Run the tests.**
  - Run: `npx vitest run shared/amazon-sample.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
npx tsc --noEmit && git add shared/status-keys.ts shared/amazon-sample.ts shared/amazon-sample.test.ts
git commit -m "Amazon: redacted samples of unreadable emails, in fixture shape

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Mail reader and ingest use the separate copies

**Files:**
- Modify: `companion/src/amazon-mail.ts`. Affected: `MailMessage`, `AmazonIngestResult`, `buildAmazonMailText` (replaced), `ingestAmazonMail`, and the `scan` loop in `createImapSource`.
- Modify: `companion/src/amazon-check.ts` (~lines 116-140)
- Modify: `companion/tools/amazon-unread.mjs`
- Test: `companion/src/amazon-mail.test.ts`

**Interfaces:**
- Consumes:
  - `classifyAmazonEmail(parts)` and `cancelledOrderIds` (Tasks 2-3)
  - `retireCancelledOrders` (Task 3)
  - `toAmazonMailSample`, `AMAZON_SAMPLE_LIMIT`, `AmazonMailSample` (Task 4)
- Produces:
  - `MailMessage.parts: AmazonMailParts`, which replaces `text`
  - `AmazonIngestResult.cancelled: number` and `AmazonIngestResult.samples: AmazonMailSample[]`
  - `buildAmazonMailParts(subject, textPlain, html): AmazonMailParts`

- [ ] **Step 1: Move the existing tests onto `parts`.**
  - Run: `perl -pi -e "s/\btext: (email\([^)]*\)|'[^']*')/parts: { plain: \$1 }/g" companion/src/amazon-mail.test.ts`
  - Then run `grep -n "text: " companion/src/amazon-mail.test.ts`. Expected: no message literal still uses `text:`. `const text = htmlToText(...)` lines are fine.
  - Change the import of `buildAmazonMailText` to `buildAmazonMailParts`.
  - Replace the whole `describe('buildAmazonMailText', …)` block with:

```ts
describe('buildAmazonMailParts', () => {
  it('keeps subject, plain text and html-derived text apart', () => {
    expect(buildAmazonMailParts(
      'Ordered: ⁦1⁩ Essentials item',
      'Thanks for your order!',
      '<span class="rio-text rio-text-339">⁦1⁩ Essentials item</span>',
    )).toEqual({
      subject: 'Ordered: ⁦1⁩ Essentials item',
      plain: 'Thanks for your order!',
      html: '\n⁦1⁩ Essentials item\n',
    });
  });

  it('omits a copy the message did not carry', () => {
    expect(buildAmazonMailParts(undefined, 'plain only', undefined)).toEqual({ plain: 'plain only' });
    expect(buildAmazonMailParts('subject only', undefined, undefined)).toEqual({ subject: 'subject only' });
  });
});
```

- [ ] **Step 2: Write the failing tests.** Add inside `describe('ingestAmazonMail', …)`:

```ts
  it('skips a cancellation, retires its confirmation, and marks it read', async () => {
    const ledger: AmazonLedger = {
      '113-2018846-2323410|ordered|839': {
        orderId: '113-2018846-2323410', kind: 'ordered', totalCents: 839, itemCount: 1,
        labels: ['Electronics'], emailDate: '2026-08-04',
      },
    };
    const { source, seen } = fakeSource([{
      uid: 31, date: '2026-08-06T00:00:00Z', from: 'order-update@amazon.com',
      parts: {
        subject: 'Item cancelled successfully: "Example item..."',
        plain: 'Your order was cancelled. You have not been charged for this order.\nOrder #\n113-2018846-2323410',
      },
    }]);
    const { store, state } = fakeStore(ledger);
    const r = await ingestAmazonMail(source, store, {}, NOW);
    expect(r).toMatchObject({ cancelled: 1, ignored: 0, unparsed: 0 });
    expect(state.ledger).toEqual({});
    expect(seen().map((m) => m.uid)).toEqual([31]);
  });

  it('keeps a redacted copy of each email it could not read, newest five', async () => {
    const msgs = Array.from({ length: 6 }, (_, i) => ({
      uid: 40 + i,
      date: `2026-08-0${i + 1}T00:00:00Z`,
      from: 'shipment-tracking@amazon.com',
      parts: { subject: `Shipped ${i + 1} item: Mystery`, plain: 'Nicholas - LOUISVILLE, KY\nnick@example.com' },
    }));
    const r = await ingestAmazonMail(fakeSource(msgs).source, fakeStore().store, {}, NOW);
    expect(r.unparsed).toBe(6);
    expect(r.samples.map((s) => s.subject)).toEqual([2, 3, 4, 5, 6].map((n) => `Shipped ${n} item: Mystery`));
    expect(r.samples[0].plain).toBe('Jordan - SPRINGFIELD, IL\n<email>');
  });
```

- [ ] **Step 3: Run them and see them fail.**
  - Run: `cd companion && npx vitest run src/amazon-mail.test.ts`
  - Expected: FAIL. `buildAmazonMailParts` is not exported, `cancelled` is undefined, and `samples` is undefined. The pre-existing ingest tests may also fail, because `msg.parts` is not read yet.

- [ ] **Step 4: Implement** in `companion/src/amazon-mail.ts`.

  Imports: change the parser import, and add the ledger and sample imports:

```ts
import {
  mergeAmazonOrders, pruneAmazonLedger, retireCancelledOrders, type AmazonLedger,
} from '../../shared/amazon-ledger.js';
import { classifyAmazonEmail, type AmazonMailParts } from '../../shared/amazon.js';
import { toAmazonMailSample, AMAZON_SAMPLE_LIMIT } from '../../shared/amazon-sample.js';
import type { AmazonMailSample } from '../../shared/status-keys.js';
```

  In `MailMessage`, replace `text: string;` with:

```ts
  /** Subject, plain text and HTML-as-text, kept apart — see `AmazonMailParts`. */
  parts: AmazonMailParts;
```

  In `AmazonIngestResult`, after `ignored`, add:

```ts
  /** Cancellation notices: nothing was charged. Flagged read, and their
   *  orders' confirmation records retired (see `retireCancelledOrders`). */
  cancelled: number;
```

  After `unparsedSenders`, add:

```ts
  /** Redacted copies of the unreadable messages, newest `AMAZON_SAMPLE_LIMIT`. */
  samples: AmazonMailSample[];
```

  Replace `buildAmazonMailText` and its doc comment with:

```ts
/**
 * The three copies `classifyAmazonEmail` reads, each only when present.
 *
 * KEPT APART. As of ~Aug 2026 the category label lives only in the subject and
 * the HTML, and since Sep 2026 the plain-text copy has its own `Order #` with
 * no label — so joining the copies into one document put the label and the
 * readable total into different orders' chunks. The parser now reads each copy
 * on its own and combines them by order number (see `AmazonMailParts`).
 */
export function buildAmazonMailParts(
  subject: string | undefined | null,
  textPlain: string | undefined | null,
  html: string | undefined | null,
): AmazonMailParts {
  return {
    ...(subject ? { subject } : {}),
    ...(textPlain ? { plain: textPlain } : {}),
    ...(html ? { html: htmlToText(html) } : {}),
  };
}
```

  In `ingestAmazonMail`, initialise the result with `cancelled: 0` and `samples: []`, and add `let retired = false;` after `const consumed: MailMessage[] = [];`. Then replace the loop's non-orders branch with:

```ts
    const { orders, status, cancelledOrderIds } = classifyAmazonEmail(msg.parts);
    if (status !== 'orders') {
      // A delivery notice restates no price, so it can never match a charge. Read
      // and dropped rather than counted as a failure: every order produces one, and
      // leaving them unread would fill the mailbox and bury a real format change
      // under permanent noise. A cancellation is the same, plus its order's
      // confirmation total must stop being a candidate.
      if (status === 'ignored') {
        if (cancelledOrderIds) {
          result.cancelled += 1;
          const out = retireCancelledOrders(ledger, cancelledOrderIds);
          ledger = out.ledger;
          if (out.removed > 0) retired = true;
        } else {
          result.ignored += 1;
        }
        consumed.push(msg);
        continue;
      }
      result.unparsed += 1;
      const who = msg.from ?? 'unknown sender';
      result.unparsedSenders[who] = (result.unparsedSenders[who] ?? 0) + 1;
      result.samples.push(toAmazonMailSample(msg));
      continue;
    }
```

  After the loop (before `pruneAmazonLedger`):

```ts
  // Messages arrive oldest first; the newest are the ones worth showing.
  result.samples = result.samples.slice(-AMAZON_SAMPLE_LIMIT);
```

  Change the ledger write condition to:

```ts
  if (result.added > 0 || pruned.removed > 0 || retired) await store.setAmazonLedger(pruned.ledger);
```

  In `createImapSource`'s `scan`, replace the `const text = buildAmazonMailText(...)` block and the sender check with the code below, and set `parts` instead of `text` in `out.push({...})`:

```ts
        // Subject, plain text and HTML-as-text, kept apart (see `buildAmazonMailParts`).
        const parts = buildAmazonMailParts(
          parsed.subject, parsed.text, parsed.html ? String(parsed.html) : undefined,
        );
        // Sender check here rather than in the IMAP search: the forwarding mailbox
        // should contain nothing else, but "should" is not a reason to parse
        // whatever else lands in it. Needs the decoded body too, so a hand-forwarded
        // order — whose From: is the person who forwarded it — still counts.
        if (!isAmazonMessage(from[0], [parts.plain, parts.html].filter(Boolean).join('\n'))) continue;
```

  In `companion/src/amazon-check.ts`, the message loop changes as follows.
  - Use `const { orders, status, cancelledOrderIds } = classifyAmazonEmail(msg.parts);`
  - For the `ignored` log line, use:

```ts
        console.log(cancelledOrderIds
          ? `— ${date} — cancellation, skipped (nothing was charged)`
          : `— ${date} — delivery notice, skipped (no total to match)`);
```

  - For the "First lines of the body" loop, read:

```ts
        const body = [msg.parts.subject, msg.parts.plain, msg.parts.html].filter(Boolean).join('\n');
        for (const line of body.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8)) {
```

  In `companion/tools/amazon-unread.mjs`:
  - Change the header sentence "(subject, plain text and HTML text merged by `buildAmazonMailText`)" to "(subject, plain text and HTML text, printed separately, the way the parser reads them)".
  - Replace the loop body from `const { status } = …` down to the `… more line(s)` line with:

```js
  const { status } = classifyAmazonEmail(msg.parts);
  if (status !== 'unrecognised') continue;
  shown++;
  console.log(`\n══════ ${msg.date} · from ${msg.from ?? 'unknown'} · ${msg.mailbox} ══════`);
  for (const [name, text] of [['subject', msg.parts.subject], ['plain text', msg.parts.plain], ['html', msg.parts.html]]) {
    if (!text) continue;
    console.log(`  ── ${name} ──`);
    const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
    for (const line of lines.slice(0, 60)) console.log(`  ${line.slice(0, 160)}`);
    if (lines.length > 60) console.log(`  … ${lines.length - 60} more line(s)`);
  }
```

- [ ] **Step 5: Run the companion tests and build.**
  - Run: `cd companion && npx vitest run src/amazon-mail.test.ts src/index.test.ts && npm run build`
  - Expected: `amazon-mail.test.ts` PASSES, and the build succeeds.
  - `index.test.ts` still PASSES, because its mocks only lack the two new fields. Task 6 adds them.

- [ ] **Step 6: Commit.**

```bash
git add companion/src/amazon-mail.ts companion/src/amazon-mail.test.ts companion/src/amazon-check.ts companion/tools/amazon-unread.mjs
git commit -m "Companion mail: pass the copies separately; count cancellations; keep unreadable samples

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The companion publishes the samples

**Files:**
- Modify: `companion/src/index.ts` (the import at ~line 76; `pollAmazonMail` at ~lines 566-601)
- Test: `companion/src/index.test.ts` (`describe('Amazon mail status publishing', …)`)

**Interfaces:**
- Consumes: `AMAZON_MAIL_SAMPLES_SECRET_KEY`, `AmazonMailSamples` (Task 4); `AmazonIngestResult.samples` and `.cancelled` (Task 5).
- Produces: the `amazon_mail_samples` addon secret, written on every completed scan.

- [ ] **Step 1: Update the mocks, then write the failing tests.**
  - Run: `perl -pi -e 's/unparsedSenders: \{\},/unparsedSenders: {}, cancelled: 0, samples: [],/g' companion/src/index.test.ts`
  - Add `AMAZON_MAIL_SAMPLES_SECRET_KEY` to the `../../shared/status-keys.js` import on line 8.
  - Add inside `describe('Amazon mail status publishing', …)`:

```ts
  it('publishes the unreadable emails as samples, replacing the previous set', async () => {
    const secrets = configuredSecrets();
    secrets.set(AMAZON_MAIL_SAMPLES_SECRET_KEY, JSON.stringify({
      asOf: '2026-10-01T00:00:00.000Z', samples: [{ at: 'old', subject: 'stale', plain: '', html: '' }],
    }));
    await clientFor(secrets);
    const sample = {
      at: '2026-10-05T17:11:52.000Z', from: 'shipment-tracking@amazon.com',
      subject: 'Shipped 4 items: Electronics', plain: 'Order #', html: '4 items: 1 Electronics',
    };
    vi.mocked(ingestAmazonMail).mockResolvedValueOnce({
      scanned: 1, added: 0, unparsed: 1, ignored: 0, cancelled: 0, pruned: 0,
      newLabels: [], unparsedSenders: {}, samples: [sample],
    });

    await runCompanionSync();

    expect(JSON.parse(secrets.get(AMAZON_MAIL_SAMPLES_SECRET_KEY)!).samples).toEqual([sample]);
  });

  it('keeps the last samples when the mailbox check fails', async () => {
    const secrets = configuredSecrets();
    const standing = JSON.stringify({
      asOf: '2026-10-01T00:00:00.000Z', samples: [{ at: 'x', subject: 'kept', plain: '', html: '' }],
    });
    secrets.set(AMAZON_MAIL_SAMPLES_SECRET_KEY, standing);
    await clientFor(secrets);
    vi.mocked(ingestAmazonMail).mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await runCompanionSync();

    expect(secrets.get(AMAZON_MAIL_SAMPLES_SECRET_KEY)).toBe(standing);
  });
```

- [ ] **Step 2: Run them and see them fail.**
  - Run: `cd companion && npx vitest run src/index.test.ts -t "samples"`
  - Expected: the first test FAILS (the secret still holds the stale set). The second PASSES already. Keep it: it pins the failure path.

- [ ] **Step 3: Implement.** In `companion/src/index.ts`, extend the status-keys import with `AMAZON_MAIL_SAMPLES_SECRET_KEY` and `type AmazonMailSamples`. In `pollAmazonMail`'s log call, add after the `ignored` fragment:

```ts
      `${result.cancelled ? `, ${result.cancelled} cancellations skipped` : ''}` +
```

  Directly after the status `setAddonSecret(...).catch(() => {});` in the success path, add:

```ts
    // The unreadable emails themselves, replaced every completed scan so the set
    // always matches `unparsed` and clears itself once a fix reads them. A failed
    // scan never gets here, so a standing set survives it (see the catch below).
    const samples: AmazonMailSamples = { asOf: now, samples: result.samples };
    await wfClient
      .setAddonSecret('simplefin-sync', AMAZON_MAIL_SAMPLES_SECRET_KEY, JSON.stringify(samples))
      .catch(() => {});
```

- [ ] **Step 4: Run the tests and build.**
  - Run: `cd companion && npx vitest run src/index.test.ts && npm run build`
  - Expected: PASS, and the build succeeds.

- [ ] **Step 5: Commit.**

```bash
git add companion/src/index.ts companion/src/index.test.ts
git commit -m "Companion: publish redacted samples of unreadable Amazon mail

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The Amazon card shows and copies the samples

**Files:**
- Modify: `src/utils/secrets.ts`: the import on line 6, the `KEYS` map (~line 127), and a new getter after `getAmazonMailStatus` (~line 615)
- Modify: `src/components/AmazonCard.tsx`: imports, `AmazonDraftState`, `useAmazonDraft`, the warning block (~line 243), and a new `UnreadableSamples` component
- Test: `src/utils/secrets.test.ts`, `src/components/AmazonCard.test.tsx`

**Interfaces:**
- Consumes: `AMAZON_MAIL_SAMPLES_SECRET_KEY`, `AmazonMailSamples`, `AmazonMailSample` (Task 4); `amazonSamplesAsFixtureText` (Task 4).
- Produces:
  - `SecretsStore.getAmazonMailSamples(): Promise<AmazonMailSamples | null>`
  - `AmazonDraftState.samples?: AmazonMailSamples | null`

- [ ] **Step 1: Write the failing tests.**
  - In `src/utils/secrets.test.ts`, add `AMAZON_MAIL_SAMPLES_SECRET_KEY` to the status-keys import on line 5.
  - Next to the `getAmazonMailStatus` clearAll test (~line 160), add:

```ts
  it('reads the unreadable-email samples, dropping malformed ones, and clearAll removes them', async () => {
    const ctx = makeCtx();
    const s = new SecretsStore(ctx);
    const sample = { at: '2026-10-05', subject: 'Shipped 4 items', plain: 'p', html: 'h' };
    await ctx.api.secrets.set(AMAZON_MAIL_SAMPLES_SECRET_KEY, JSON.stringify({ asOf: '2026-10-05', samples: [sample, { junk: true }] }));
    expect(await s.getAmazonMailSamples()).toEqual({ asOf: '2026-10-05', samples: [sample] });
    await s.clearAll();
    expect(await s.getAmazonMailSamples()).toBeNull();
  });

  it('reads a corrupt samples secret as none', async () => {
    const ctx = makeCtx();
    await ctx.api.secrets.set(AMAZON_MAIL_SAMPLES_SECRET_KEY, '{not json');
    expect(await new SecretsStore(ctx).getAmazonMailSamples()).toBeNull();
  });
```

  - In `src/components/AmazonCard.test.tsx`, inside `describe('AmazonCard unparsed-mail warning', …)`, change the assertion `toMatch(/stay uncategorized until this addon gets an update/i)` to `toMatch(/won.t get an Amazon category until this addon gets an update/i)`.
  - Then add:

```tsx
  it('offers the unreadable emails for copying', async () => {
    const props = configuredProps();
    props.store.getAmazonMailStatus = vi.fn(async () => ({ unparsed: 1, asOf: '2026-10-10T12:00:00.000Z' })) as any;
    (props.store as any).getAmazonMailSamples = vi.fn(async () => ({
      asOf: '2026-10-10T12:00:00.000Z',
      samples: [{
        at: '2026-10-05T17:11:52.000Z', from: 'shipment-tracking@amazon.com',
        subject: 'Shipped 4 items: Electronics, Irons & Steamers, and more',
        plain: 'Order #\n113-3583199-4585009', html: '4 items: 1 Electronics',
      }],
    }));
    render(<Harness {...props} />);

    fireEvent.click(await screen.findByRole('button', { name: /Show what couldn.t be read/i }));
    const box = screen.getByLabelText(/Emails that could not be read/i) as HTMLTextAreaElement;
    const [fixture] = JSON.parse(box.value);
    expect(fixture.subject).toBe('Shipped 4 items: Electronics, Irons & Steamers, and more');
    expect(fixture.plain).toEqual(['Order #', '113-3583199-4585009']);

    // jsdom has no clipboard — the same situation as a sandboxed iframe that
    // refuses it — so the card must say how to copy by hand.
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText(/select the text above and copy it/i)).toBeTruthy();
  });

  it('shows no samples section on a companion that publishes none', async () => {
    // Version skew: an older companion writes no samples secret, and its store
    // mock has no getter at all. The card must look exactly as before.
    const props = configuredProps();
    props.store.getAmazonMailStatus = vi.fn(async () => ({ unparsed: 1, asOf: '2026-10-10T12:00:00.000Z' })) as any;
    render(<Harness {...props} />);
    await screen.findByText(/1 recent email could not be read/i);
    expect(screen.queryByRole('button', { name: /Show what couldn.t be read/i })).toBeNull();
  });
```

- [ ] **Step 2: Run them and see them fail.**
  - Run: `npx vitest run src/utils/secrets.test.ts src/components/AmazonCard.test.tsx`
  - Expected: FAIL. `getAmazonMailSamples` is not a function, the wording assertion fails, and the disclosure button is missing.

- [ ] **Step 3: Implement.** In `src/utils/secrets.ts`:
  - Extend the status-keys import with `AMAZON_MAIL_SAMPLES_SECRET_KEY` and `type AmazonMailSamples`.
  - In `KEYS`, directly after `amazonMailStatus: AMAZON_MAIL_STATUS_SECRET_KEY,`, add:

```ts
  // And the unreadable-email samples beside it: companion-written, the same
  // easy-to-forget shape, and they hold (redacted) receipt text.
  amazonMailSamples: AMAZON_MAIL_SAMPLES_SECRET_KEY,
```

  After `getAmazonMailStatus`:

```ts
  /**
   * Companion-published copies of the Amazon emails the parser could not read
   * (see `AMAZON_MAIL_SAMPLES_SECRET_KEY`). `null` when absent or corrupt, and
   * malformed entries are dropped — like the status, an older companion that
   * never writes this must look identical to "nothing to show".
   */
  async getAmazonMailSamples(): Promise<AmazonMailSamples | null> {
    const raw = await this.ctx.api.secrets.get(AMAZON_MAIL_SAMPLES_SECRET_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed?.samples)) return null;
      const samples = parsed.samples.filter((s: any) => s
        && typeof s.subject === 'string' && typeof s.plain === 'string' && typeof s.html === 'string');
      return { asOf: String(parsed.asOf ?? ''), samples };
    } catch {
      return null;
    }
  }
```

  In `src/components/AmazonCard.tsx`:

  (a) Imports:
  - Change the React import to `import React, { useCallback, useEffect, useMemo, useState } from 'react';`
  - Change the status-keys import to `import type { AmazonMailSample, AmazonMailSamples, AmazonMailStatus } from '../../shared/status-keys';`
  - Add `import { amazonSamplesAsFixtureText } from '../../shared/amazon-sample';`

  (b) In `AmazonDraftState`, after `mailStatus`:

```ts
  /** The unreadable emails, when the companion published any. Optional so a
   *  hand-built state (tests, an older page) needs no change. */
  samples?: AmazonMailSamples | null;
```

  (c) In `useAmazonDraft`:
  - Add `const [samples, setSamples] = useState<AmazonMailSamples | null>(null);`
  - In the `Promise.all`, add a fourth entry, `store.getAmazonMailSamples?.() ?? null`. Destructure it as `unreadable`, and call `setSamples(unreadable ?? null);` beside `setMailStatus(status);`.
  - Add `samples,` to the returned object.

  (d) In `AmazonCard`, destructure `samples` from `amazon`. Then replace the `{unparsed > 0 && (<ErrorBox>…</ErrorBox>)}` block with:

```tsx
      {unparsed > 0 && (
        <ErrorBox>
          {unparsed} recent email{unparsed === 1 ? '' : 's'} could not be read — Amazon
          may have changed their email format. They stay unread in the mailbox, and
          their charges won&apos;t get an Amazon category until this addon gets an update.
        </ErrorBox>
      )}

      {unparsed > 0 && samples && samples.samples.length > 0 && (
        <UnreadableSamples samples={samples.samples} />
      )}
```

  (e) Add the component at the end of the file:

```tsx
/**
 * The emails the parser could not read, ready to paste into a bug report — and
 * from there straight into `shared/__fixtures__/amazon-emails/` as a test.
 *
 * A textarea as well as a Copy button: the addon runs in a sandboxed iframe,
 * where the clipboard API may be refused, and a selectable box always works.
 */
function UnreadableSamples({ samples }: { samples: AmazonMailSample[] }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const text = useMemo(() => amazonSamplesAsFixtureText(samples), [samples]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <div className="sfin-disc-inset" style={{ marginBottom: 12 }}>
      <Disclosure
        id="amazon-unreadable"
        variant="inline"
        title="Show what couldn't be read"
        open={open}
        onToggle={() => setOpen((o) => !o)}
      >
        <p className="sfin-subtle">
          Personal details are removed. Paste this into a bug report so the addon can
          learn the new format.
        </p>
        <textarea
          readOnly
          aria-label="Emails that could not be read"
          value={text}
          rows={10}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
          onFocus={(e) => e.currentTarget.select()}
        />
        <div style={{ marginTop: 8 }}>
          <Button variant="outline" onClick={copy}>Copy</Button>
          {copied === 'ok' && <span className="sfin-subtle"> Copied.</span>}
          {copied === 'failed' && (
            <span className="sfin-subtle"> Couldn&apos;t copy here — select the text above and copy it.</span>
          )}
        </div>
      </Disclosure>
    </div>
  );
}
```

- [ ] **Step 4: Run the tests and type-check.**
  - Run: `npx vitest run src/utils/secrets.test.ts src/components/AmazonCard.test.tsx && npx tsc --noEmit`
  - Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/utils/secrets.ts src/utils/secrets.test.ts src/components/AmazonCard.tsx src/components/AmazonCard.test.tsx
git commit -m "Amazon card: show and copy the emails that could not be read

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Late label for charges imported before their email was read

**Files:**
- Modify: `shared/sync-core.ts`:
  - a new export next to `planExternalMarkerStamp` (~line 1165)
  - a map beside `amazonLedgerChanged` (~line 1674)
  - the hit block (~line 1758)
  - a new pass after the external-marker block (~line 2190)
- Test: `shared/sync-core.test.ts`

**Interfaces:**
- Consumes: the existing `StoredRow`, `ActivityWrite`, `host.saveMany`, `amazonDescription`.
- Produces:
  - `export const AMAZON_LATE_LABEL_LOG_TAG = 'amazon-late-label'`
  - `export function planAmazonLateLabels(rows: ReadonlyArray<StoredRow>, labelled: ReadonlyMap<string, { bare: string; enriched: string }>, currency: string): ActivityWrite[]`, where `labelled` is keyed by tx id within one account

- [ ] **Step 1: Write the failing tests.**
  - Add `planAmazonLateLabels` to the `./sync-core.js` import on line 2 of `shared/sync-core.test.ts`.
  - Inside `describe('runSyncCore + Amazon order categories', …)`, add:

```ts
  it('adds the order category to a charge imported before its email was read', async () => {
    // The gap behind the 2026-10 outage: reconciliation never compares notes,
    // so a row that existed before its order email parsed kept the bare bank
    // text forever, and no category ever reached it.
    const { host, store, saved } = createFakeHost({
      ...amazonSeed(ledgerFixture()),
      existing: new Map([['wf-a', [{
        id: 'act-amz', accountId: 'wf-a', activityType: 'WITHDRAWAL', date: '2026-08-06',
        amount: 21.18, comment: 'AMAZON.COM*MB3T81 · tx-amz', sourceGroupId: null,
      }]]]),
    });
    await runSyncCore(host, store, {});
    const updates = saved.flatMap((s) => s.updates ?? []).filter((u) => u.id === 'act-amz');
    expect(updates).toEqual([expect.objectContaining({
      comment: 'AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · tx-amz',
      activityType: 'WITHDRAWAL', activityDate: '2026-08-06', amount: 21.18,
    })]);
  });
```

  Append a new top-level block:

```ts
describe('planAmazonLateLabels', () => {
  const row = (over: Partial<{ txId: string; comment: string; pending: boolean; sourceGroupId: string | null }> = {}) => ({
    wfId: 'act-amz', wfAccountId: 'wf-a', txId: 'tx-amz', absCents: 2118, type: 'WITHDRAWAL',
    date: '2026-08-06', pending: false, comment: 'AMAZON.COM*MB3T81 · tx-amz', sourceGroupId: null,
    ...over,
  });
  const labelled = new Map([['tx-amz', {
    bare: 'AMAZON.COM*MB3T81', enriched: 'AMAZON.COM*MB3T81 · Amazon: Lawn & Garden',
  }]]);

  it('labels the sync\'s own note and passes everything else through unchanged', () => {
    expect(planAmazonLateLabels([row()], labelled, 'USD')).toEqual([{
      id: 'act-amz', accountId: 'wf-a', activityType: 'WITHDRAWAL', activityDate: '2026-08-06',
      amount: 21.18, currency: 'USD', comment: 'AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · tx-amz',
    }]);
  });

  it('leaves a note someone edited alone', () => {
    expect(planAmazonLateLabels([row({ comment: 'Garden hose · tx-amz' })], labelled, 'USD')).toEqual([]);
  });

  it('never touches half of a linked transfer', () => {
    // Wealthfolio copies an updated linked leg's note onto its partner.
    expect(planAmazonLateLabels([row({ sourceGroupId: 'grp-1' })], labelled, 'USD')).toEqual([]);
  });

  it('leaves a pending charge to the update that posts it', () => {
    expect(planAmazonLateLabels(
      [row({ pending: true, comment: 'AMAZON.COM*MB3T81 · tx-amz · pending' })], labelled, 'USD',
    )).toEqual([]);
  });

  it('never rewrites a note that already carries the label', () => {
    // Idempotent across syncs and across the two writers (addon + companion).
    expect(planAmazonLateLabels(
      [row({ comment: 'AMAZON.COM*MB3T81 · Amazon: Lawn & Garden · tx-amz' })], labelled, 'USD',
    )).toEqual([]);
  });

  it('ignores rows no order matched', () => {
    expect(planAmazonLateLabels([row({ txId: 'tx-other', comment: 'AMAZON.COM*X · tx-other' })], labelled, 'USD'))
      .toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and see them fail.**
  - Run: `npx vitest run shared/sync-core.test.ts -t "imported before|planAmazonLateLabels"`
  - Expected: FAIL. The integration test gets `updates` = `[]`, which is the gap the spec describes. The unit tests fail because `planAmazonLateLabels` is not a function.
  - **If the integration test PASSES before any code change,** reconciliation rewrote the row for another reason. Print `updates`, make the seeded row agree with the feed (type/date/amount) so nothing else changed, and re-run until it fails for the right reason.
  - **If it fails with a CREATE for `tx-amz`,** the seed was not recognised as an existing row. Check what `fetchExistingRows` (~line 1093) requires, and fix the seed. Do not touch sync-core.

- [ ] **Step 3: Implement.** In `shared/sync-core.ts`, after `planExternalMarkerStamp`:

```ts
export const AMAZON_LATE_LABEL_LOG_TAG = 'amazon-late-label';

/**
 * Existing rows whose Amazon order email was read only after the row was
 * imported, as note-only updates. Nothing is written here.
 *
 * Needed because `changed()` (shared/reconcile.ts) never compares notes: a row
 * imported while its email was unreadable — Amazon's 2026-10 format change left
 * four charges that way — kept the bare bank text forever, so the Amazon filer
 * never saw a label and the charge never got its category.
 *
 * Deliberately narrow, because a note is the user's as much as the sync's:
 *  - Only a note in the sync's own unedited form, `<bank text> · <txId>`. An
 *    edited note, a pending one, or one already labelled is left alone, which
 *    is also what makes the pass idempotent across both writers.
 *  - Never a grouped row: Wealthfolio copies an updated linked leg's note onto
 *    its partner.
 *  - Labels are only ever added. Type, date and amount are passed through, the
 *    same shape as `planExternalMarkerStamp`.
 */
export function planAmazonLateLabels(
  rows: ReadonlyArray<StoredRow>,
  labelled: ReadonlyMap<string, { bare: string; enriched: string }>,
  currency: string,
): ActivityWrite[] {
  const updates: ActivityWrite[] = [];
  for (const row of rows) {
    if (row.sourceGroupId || row.pending) continue;
    const hit = labelled.get(row.txId);
    if (!hit || (row.comment ?? '') !== `${hit.bare} · ${row.txId}`) continue;
    updates.push({
      id: row.wfId,
      accountId: row.wfAccountId,
      activityType: row.type,
      activityDate: row.date,
      amount: row.absCents / 100,
      currency,
      comment: `${hit.enriched} · ${row.txId}`,
    });
  }
  return updates;
}
```

  After `let amazonLedgerChanged = false;`:

```ts
  /** Charges this run matched to an order, per SimpleFin account then tx id,
   *  with the bank's own text beside the labelled one — what the late-label
   *  pass needs to recognise a note written before the email was readable. */
  const amazonLabelled = new Map<string, Map<string, { bare: string; enriched: string }>>();
```

  In the hit block, directly after `description = amazonDescription(description, hit.labels, hit.partial);`:

```ts
          if (description !== tx.description) {
            const forAccount = amazonLabelled.get(sfAccount.id) ?? new Map<string, { bare: string; enriched: string }>();
            forAccount.set(tx.id, { bare: tx.description, enriched: description });
            amazonLabelled.set(sfAccount.id, forAccount);
          }
```

  Directly after the external-marker block (the one ending in `errors.push(\`external marker (${sfAccount.name}): …\`);` and its closing braces), add:

```ts
    // ── Amazon late label (every mode) ───────────────────────────────────────
    // A charge imported before its order email was readable gets the label
    // added to its note now (see planAmazonLateLabels); the Amazon filer then
    // files it on this same companion run. The snapshot is patched so the rest
    // of the pass sees the note as written.
    const lateLabels = planAmazonLateLabels(existing, amazonLabelled.get(sfAccount.id) ?? new Map(), sfAccount.currency);
    if (lateLabels.length) {
      try {
        const res = await host.saveMany({ updates: lateLabels });
        if (res.errors.length) {
          errors.push(...res.errors.map((e) => `Amazon late label (${sfAccount.name}): ${e.message}`));
        } else {
          for (const u of lateLabels) {
            const row = existing.find((r) => r.wfId === u.id);
            if (row) row.comment = u.comment;
          }
          console.info(
            `[simplefin-sync] ${AMAZON_LATE_LABEL_LOG_TAG}: added the Amazon category to ${lateLabels.length} charge(s) in account ${sfAccount.id} imported before their order email was read`,
          );
        }
      } catch (e: any) {
        errors.push(`Amazon late label (${sfAccount.name}): ${String(e?.message ?? e)}`);
      }
    }
```

- [ ] **Step 4: Run the sync-core suites.**
  - Run: `npx vitest run shared/sync-core.test.ts shared/sync-core-pair-identity.test.ts shared/sync-core-skip-list.test.ts && npx tsc --noEmit`
  - Expected: PASS.

- [ ] **Step 5: Run the companion suite.** sync-core runs inside the companion too.
  - Run: `cd companion && npx vitest run && npm run build`
  - Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add shared/sync-core.ts shared/sync-core.test.ts
git commit -m "Sync: add a late Amazon label to charges imported before their email was read

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: No "make this a rule" for Amazon purchases; retire the fallback rule

**Files:**
- Modify: `shared/categorize-menu.ts` (imports; `renderFiled`, ~lines 608-650)
- Modify: `companion/tools/fix-ledger.mjs` (the `RULES` list, ~line 162)
- Test: `shared/categorize-menu.test.ts` (`describe('renderScreen — filed', …)`)

**Interfaces:**
- Consumes: `isAmazonDescription` from `shared/amazon-ledger.ts` (existing).
- Produces: nothing new.
- **The controller (`companion/src/categorize.ts`) needs no guard.** The spec mentions it, but menu sessions and their button tables live in memory. An upgrade restarts the companion, so no button rendered before this change can be tapped after it.

- [ ] **Step 1: Write the failing tests.** Add inside `describe('renderScreen — filed', …)`:

```ts
  it('offers no rule for an Amazon purchase, whose descriptor names the store and not the purchase', () => {
    // `AMAZON MKTPL → Electronics` would file every later Amazon charge as
    // Electronics: the silent wrong category the order emails exist to prevent.
    const s = session({ txns: [txn({ description: 'AMAZON MKTPL*ZK4GH1 · Amazon: Hair Care' })], screen: filedScreen });
    const labels = renderScreen(s).keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toEqual(['↩ Undo', 'Next transaction', 'Done']);
  });

  it('still offers a rule for an Amazon subscription, which always means the same thing', () => {
    const s = session({ txns: [txn({ description: 'Amazon Prime*RT4HD2' })], screen: filedScreen });
    const labels = renderScreen(s).keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain('Make this a rule');
  });
```

- [ ] **Step 2: Run them and see them fail.**
  - Run: `npx vitest run shared/categorize-menu.test.ts -t "Amazon"`
  - Expected: the first test FAILS, because "Make this a rule" is present. The second PASSES.

- [ ] **Step 3: Implement.**
  - In `shared/categorize-menu.ts`, add `import { isAmazonDescription } from './amazon-ledger.js';` beside the `rule-pattern` import.
  - In `renderFiled`, build `rows` as below. Keep the existing button objects exactly as they are; only the rule button becomes conditional.

```ts
  // No rule from an Amazon purchase: the descriptor names the store, not the
  // purchase, so `AMAZON MKTPL → Electronics` would file every later Amazon
  // charge as Electronics — the silent wrong category the order emails exist
  // to prevent. Prime, AWS and Kindle Unlimited are not purchases
  // (`isAmazonDescription` excludes them) and keep the offer.
  const offerRule = !isAmazonDescription(txn.description);
  const ruleRow: Btn[] = [{
    // Count-aware: the button was always here, but nothing ever said it
    // would clear other rows in the same tap.
    text: (() => {
      const catches = ruleCatchCount(session, screen.activityId, txn.description);
      return catches > 0
        ? `⚡ Make this a rule — files ${catches} more like it`
        : 'Make this a rule';
    })(),
    action: {
      kind: 'goto',
      screen: { kind: 'rulePreview', activityId: screen.activityId, categoryId: screen.categoryId },
    },
  }];
  const rows: Btn[][] = [
    [{
      text: '↩ Undo',
      action: {
        kind: 'unassign',
        activityId: screen.activityId,
        categoryId: screen.categoryId,
        // The taxonomy the filing actually wrote to — an income Undo clearing
        // the SPENDING assignment would clear nothing and report success.
        ...(screen.taxonomyId ? { taxonomyId: screen.taxonomyId } : {}),
      },
    }],
    ...(offerRule ? [ruleRow] : []),
    [{ text: 'Next transaction', action: { kind: 'goto', screen: { kind: 'list', page: 0 } } }],
    [DONE_BTN],
  ];
```

  - In `companion/tools/fix-ledger.mjs`, delete the line `{ name: 'Amazon → Online Shopping', pattern: 'Amazon', category: 'Online Shopping' },` from `RULES`. Put this comment in its place:

```js
  // No catch-all Amazon rule: it filed every Amazon charge before its order
  // email was read, hiding the ones whose email never parsed (v1.59.0).
```

- [ ] **Step 4: Run the tests.**
  - Run: `npx vitest run shared/categorize-menu.test.ts && npx tsc --noEmit && cd companion && npx vitest run src/categorize.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add shared/categorize-menu.ts shared/categorize-menu.test.ts companion/tools/fix-ledger.mjs
git commit -m "Categorize: no merchant rule from an Amazon purchase; fix-ledger drops the catch-all Amazon rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Release prep for v1.59.0 (stop before tag and push)

**Files:**
- Modify: `CHANGELOG.md`, `package.json`, `manifest.json`, `shared/version.ts`

- [ ] **Step 1: Write the CHANGELOG.** Under `## [Unreleased]`, add the entries below. Then rename the heading to `## [1.59.0] - 2026-10-10` (use the actual date if the release slips), and put a fresh empty `## [Unreleased]` above it.

```markdown
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
  same amount cannot pick up its category.

### Added

- **"Show what couldn't be read"** on the Amazon card. The emails the parser
  could not read, with your name, address and link codes removed, ready to
  copy into a bug report. Each one becomes a test, so a fixed format stays
  fixed.

### Changed

- **`/categorize` no longer offers "Make this a rule" for an Amazon purchase.**
  A rule on `AMAZON MKTPL` would file every later Amazon charge the same way.
  Prime, AWS and Kindle Unlimited charges still get the offer.
- **Remove any catch-all Amazon rule** (for example `Amazon → Online
  Shopping`). It files every Amazon charge before its order email is read, so
  a charge whose email never parses silently keeps the rule's category instead
  of reaching `/categorize`. Deleting a rule leaves the charges it already
  filed as they are.
```

- [ ] **Step 2: Bump the version to `1.59.0`** in `package.json` (`"version"`), `manifest.json` (`"version"`) and `shared/version.ts` (`SIMPLEFIN_SYNC_VERSION`).

- [ ] **Step 3: Run every gate.**
  - Run: `npx tsc --noEmit && npx vitest run && (cd companion && npx vitest run && npm run build) && rm -f dist/*.zip && npm run package`
  - Expected: every suite PASSES, the companion build succeeds, and the bundle-version check passes.
  - Confirm the zip carries the new code: `unzip -p dist/simplefin-sync-1.59.0.zip dist/addon.js | grep -c "Show what couldn"` should print `1` or more.

- [ ] **Step 4: Commit.**

```bash
git add CHANGELOG.md package.json manifest.json shared/version.ts
git commit -m "v1.59.0: Amazon emails read any layout; late labels; unreadable charges reach /categorize

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: STOP and ask Nick** before `gh auth switch --user Bubbles840`, `git push`, `git tag -a v1.59.0` and `gh release create`. Then hand him the deploy and verify steps from spec section 3.
