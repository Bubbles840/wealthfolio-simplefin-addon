import { describe, it, expect } from 'vitest';
import { parseAmazonEmail, mapAmazonLabel, DEFAULT_AMAZON_LABEL_RULES } from './amazon.js';

/**
 * Fixtures are the REAL text of Nick's forwarded emails, directional marks and
 * all. Amazon wraps the order number in U+202B and the item count in
 * U+2066/U+2069, which are invisible in a terminal and will silently break any
 * regex written from a screenshot — so they are preserved here deliberately.
 */
const CONFIRMATION_TWO_ORDERS = `
   Your Orders       Your Account       Buy Again
Thanks for your order!
Completed
Ordered
Pending
Shipped
Arriving tomorrow 10 AM – 3 PM

Nicholas - LOUISVILLE, KY
Order # ‫113-0728509-1925031
⁦1⁩ Lawn & Garden item

View or edit order


Grand Total:\t$21.18


Arriving tomorrow 10 AM – 3 PM

Nicholas - LOUISVILLE, KY
Order # ‫113-9144805-5261817
⁦1⁩ Nutrition & Wellness item

View or edit order


Grand Total:\t$7.95
`;

const SHIPMENT = `
   Your Orders       Your Account       Buy Again
Your package was shipped!
Completed
Ordered
Completed
Shipped
Arriving tomorrow

Nicholas - LOUISVILLE, KY
Order # ‫114-7332240-9157866
⁦1⁩ Electronics item

Track package


Total\t$10.55

info icon\tView related transactions in Your Transactions.
`;

describe('parseAmazonEmail', () => {
  it('returns one record per order, because a single email can carry several', () => {
    const rows = parseAmazonEmail(CONFIRMATION_TWO_ORDERS);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      orderId: '113-0728509-1925031',
      kind: 'ordered',
      totalCents: 2118,
      itemCount: 1,
      labels: ['Lawn & Garden'],
    });
    expect(rows[1]).toMatchObject({
      orderId: '113-9144805-5261817',
      totalCents: 795,
      labels: ['Nutrition & Wellness'],
    });
  });

  it('reads a shipment email, whose total is what the bank will actually charge', () => {
    // Amazon charges on shipment, so this figure — not the confirmation's grand
    // total, which can span several shipments — is the one that matches a charge.
    const rows = parseAmazonEmail(SHIPMENT);
    expect(rows).toEqual([expect.objectContaining({
      orderId: '114-7332240-9157866',
      kind: 'shipped',
      totalCents: 1055,
      itemCount: 1,
      labels: ['Electronics'],
    })]);
  });

  it('splits a mixed order into its labels', () => {
    // Documented form: "2 Home Improvement and Skincare items". The " and " is
    // itself the signal that an order spans categories.
    const rows = parseAmazonEmail(
      `Thanks for your order!\nOrder # ‫111-2223334-4445556\n⁦2⁩ Home Improvement and Skincare items\nGrand Total:\t$48.10`,
    );
    expect(rows[0]).toMatchObject({
      itemCount: 2,
      labels: ['Home Improvement', 'Skincare'],
      totalCents: 4810,
    });
  });

  it('keeps an ampersand label whole rather than splitting on it', () => {
    // "Lawn & Garden" is ONE label. Splitting on "&" as well as " and " would
    // turn it into two, and then every single-category garden order would look
    // mixed and stop being auto-categorized.
    const rows = parseAmazonEmail(
      `Thanks for your order!\nOrder # ‫111-2223334-4445556\n⁦1⁩ Lawn & Garden item\nGrand Total:\t$9.99`,
    );
    expect(rows[0].labels).toEqual(['Lawn & Garden']);
  });

  it('parses thousands separators in the total', () => {
    const rows = parseAmazonEmail(
      `Thanks for your order!\nOrder # ‫111-2223334-4445556\n⁦1⁩ Electronics item\nGrand Total:\t$1,299.00`,
    );
    expect(rows[0].totalCents).toBe(129900);
  });

  it('skips an email it does not recognise instead of guessing', () => {
    // Amazon changed this format on 2026-07-08 and may again. A parser that
    // guesses puts a wrong category on real money — silently, since a wrong
    // category looks exactly like a right one. Absent is the safe direction.
    expect(parseAmazonEmail('Your Amazon.com account was accessed from a new device')).toEqual([]);
    expect(parseAmazonEmail('')).toEqual([]);
    // An order with no recoverable total is useless for matching, so it is not
    // half-reported.
    expect(parseAmazonEmail(
      `Thanks for your order!\nOrder # ‫111-2223334-4445556\n⁦1⁩ Electronics item`,
    )).toEqual([]);
  });
});

describe('mapAmazonLabel', () => {
  const map = (label: string) => mapAmazonLabel(label, DEFAULT_AMAZON_LABEL_RULES, 'Shopping');

  it('maps the labels seen on the live account', () => {
    expect(map('Lawn & Garden')).toBe('Housing');
    expect(map('Nutrition & Wellness')).toBe('Health & Wellness');
    expect(map('Electronics')).toBe('Electronics');
  });

  it('maps labels reported elsewhere but never seen here', () => {
    expect(map('Baking')).toBe('Groceries');
    expect(map('Essentials')).toBe('Groceries');
    expect(map('Skincare')).toBe('Personal Care');
    expect(map('Home Improvement')).toBe('Housing');
  });

  it('maps a label nobody has seen yet, which is the whole point of patterns', () => {
    // Amazon's labels are plain English and the set is likely hundreds long and
    // still growing, so an exact-match table would be permanently incomplete.
    // These are labels invented for this test and never observed anywhere.
    expect(map('Vitamins & Supplements')).toBe('Health & Wellness');
    expect(map('Coffee & Tea')).toBe('Groceries');
    expect(map('Dog Food')).toBe('Pet Care');
    expect(map('Computer Accessories')).toBe('Electronics');
  });

  it('is case- and spacing-insensitive, since the label is display text', () => {
    expect(map('LAWN AND GARDEN')).toBe('Housing');
    expect(map('  electronics  ')).toBe('Electronics');
  });

  it('falls back to the default rather than leaving a charge uncategorized', () => {
    // The user explicitly does not want things arriving uncategorized. An
    // unmatched label is filed in the default and REPORTED (see the caller), so
    // it is one pattern away from correct rather than silently missing.
    // A real Amazon department the patterns deliberately do not cover. ('Watersports'
    // was the first choice and was a bad test: it matches /sport/ and lands in
    // Entertainment, which is correct behaviour, not a miss.)
    expect(map('Industrial & Scientific')).toBe('Shopping');
    expect(mapAmazonLabel('Industrial & Scientific', DEFAULT_AMAZON_LABEL_RULES, 'Other')).toBe('Other');
  });

  it('reports no match distinctly from a match, so the caller can announce it', () => {
    expect(mapAmazonLabel('Industrial & Scientific', DEFAULT_AMAZON_LABEL_RULES, 'Shopping', true))
      .toBeNull();
    expect(mapAmazonLabel('Electronics', DEFAULT_AMAZON_LABEL_RULES, 'Shopping', true))
      .toBe('Electronics');
  });
});
