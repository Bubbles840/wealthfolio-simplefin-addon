/**
 * shared/receipt-prompt.ts
 *
 * What the vision model is asked (./receipt.ts holds what is done with the
 * answer). The prompt asks for a transcription only, line by line as printed;
 * the JSON schema (`format` on Ollama's /api/chat) makes the answer parse and
 * keeps every line's kind to a fixed list.
 *
 * Only printed numbers are asked for: every payment line as printed, and the
 * total as printed. A till prints its total before a gift card, an order page
 * after it, and asking for the other would be asking the model to calculate;
 * ./receipt.ts accepts either.
 *
 * Amounts are asked for as text, as printed: a number in JSON would let the
 * model round or reformat them.
 */
import type { FoundDiscount, ReceiptTranscript } from './receipt.js';

const text = { type: 'string' } as const;

export const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    store: text,
    date: text,
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['item', 'discount', 'charge', 'charge_discount'] },
          text,
          amount: text,
          number: text,
          appliesTo: text,
          flag: text,
        },
        required: ['kind', 'text', 'amount'],
      },
    },
    subtotal: text,
    tax: text,
    taxLines: {
      type: 'array',
      items: { type: 'object', properties: { flag: text, rate: text, amount: text }, required: ['flag', 'rate', 'amount'] },
    },
    total: text,
    payments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: text, amount: text, kind: { type: 'string', enum: ['card', 'gift_card'] } },
        required: ['label', 'amount', 'kind'],
      },
    },
  },
  required: ['store', 'date', 'lines', 'subtotal', 'tax', 'total', 'payments'],
};

export const RECEIPT_PROMPT = [
  'This image is a store receipt or an online order summary. Copy what is printed; do not calculate anything.',
  'store: the store or website name, from the header or logo. date: the purchase or order date as YYYY-MM-DD.',
  'lines: every purchased item and every discount, shipping or fee line, top to bottom, one entry per printed line:',
  '- kind "item" for a purchased item; "discount" for a discount, coupon or instant savings on one item;',
  '  "charge" for shipping, delivery, a bag fee or another fee; "charge_discount" for a discount on shipping',
  '  or on the whole order.',
  '- A line whose text is two numbers joined by "/" (for example "0000123456 / 7654321", or "123456 /7654321")',
  '  with an amount ending in "-" is a discount on the item with the second number: kind "discount", appliesTo',
  '  that second number.',
  '- A quantity line such as "2 @ 6.50" is not an item: the item below it carries the total. Do not list it.',
  '- text: the description as printed. amount: the amount as printed, including any minus sign.',
  '- number: the item number printed on the line, if any.',
  '- flag: the letter printed right AFTER the amount on the same line, copied for EVERY line that has one:',
  '  "4.99 N" is flag "N", "9.99 Y" is flag "Y", "24.99 A" is flag "A". A letter printed before the item number',
  '  (at the start of the line) is not a flag.',
  'Do not list as lines: the subtotal, tax, totals, payments, change, or a summary of savings',
  '(for example "INSTANT SAVINGS", "TOTAL SAVINGS", "YOU SAVED").',
  'subtotal: the items subtotal as printed. tax: the total tax as printed.',
  'taxLines: each tax line that prints a rate, for example "A 8.5% TAX 4.25" is flag "A", rate "8.5%",',
  '  amount "4.25". flag is the letter the tax line starts with, "" if none. Leave taxLines empty when no rate is printed.',
  'total: the total as printed ("TOTAL", "Grand Total").',
  'payments: every payment line, each with its amount as printed: a card ("VISA 82.40"), a gift card, shop card,',
  '  store card, store credit or promotional balance ("Gift Card Amount -25.00", "WALLET - SHOPCARD 30.00").',
  '  kind "gift_card" for anything paid from a balance, "card" for a credit or debit card. A payment method named',
  '  with no amount beside it (an order page often shows only the card): amount "". Never list CHANGE.',
  'Use "" for anything not printed.',
].join('\n');

/** The request body for Ollama's /api/chat. */
export function receiptChatRequest(model: string, imageBase64: string) {
  return {
    model,
    stream: false,
    format: RECEIPT_SCHEMA,
    options: { temperature: 0 },
    messages: [{ role: 'user', content: RECEIPT_PROMPT, images: [imageBase64] }],
  };
}

/** The model's answer as a transcript; null when it is not one. */
export function parseTranscript(content: string): ReceiptTranscript | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  const t = value as Partial<ReceiptTranscript> | null;
  if (!t || typeof t !== 'object' || !Array.isArray(t.lines) || !Array.isArray(t.payments)) return null;
  return {
    store: String(t.store ?? ''),
    date: String(t.date ?? ''),
    lines: t.lines,
    subtotal: t.subtotal ?? '',
    tax: t.tax ?? '',
    taxLines: Array.isArray(t.taxLines) ? t.taxLines : [],
    total: t.total ?? '',
    payments: t.payments,
  };
}

/**
 * A second, narrower question, asked only when the lines read the first time
 * don't add up to the subtotal: a model reading a whole receipt sometimes
 * leaves out a discount line ("0000123456 / 7654321 3.00-"), and asked for
 * nothing but those it finds them. ./receipt.ts adds the ones the first answer
 * missed (`withFoundDiscounts`), and the receipt still has to pass every check.
 */
export const DISCOUNT_SCHEMA = {
  type: 'object',
  properties: {
    discounts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text, amount: text, appliesTo: text },
        required: ['text', 'amount', 'appliesTo'],
      },
    },
  },
  required: ['discounts'],
};

export const DISCOUNT_PROMPT = [
  'This image is a store receipt. List ONLY its discount lines, top to bottom: a line whose amount ends in "-"',
  'or is negative, such as an instant saving or a coupon on one item. Copy what is printed; do not calculate anything.',
  '- text: the line as printed, for example "0000123456 / 7654321". amount: the amount as printed.',
  '- appliesTo: the item number the discount names: in "0000123456 / 7654321" the number after the "/". "" if it names none.',
  'Do not list items, the subtotal, tax, totals, payments, or a summary of savings',
  '("INSTANT SAVINGS", "TOTAL SAVINGS", "YOU SAVED"). An empty list when there are no discount lines.',
].join('\n');

/** The request body for the discounts-only question. */
export function discountChatRequest(model: string, imageBase64: string) {
  return {
    model,
    stream: false,
    format: DISCOUNT_SCHEMA,
    options: { temperature: 0 },
    messages: [{ role: 'user', content: DISCOUNT_PROMPT, images: [imageBase64] }],
  };
}

/** The discounts the model listed; null when the answer is not a list of them. */
export function parseDiscounts(content: string): FoundDiscount[] | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  const list = (value as { discounts?: unknown } | null)?.discounts;
  if (!Array.isArray(list)) return null;
  return list
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
    .map((d) => ({ text: String(d.text ?? ''), amount: String(d.amount ?? ''), appliesTo: String(d.appliesTo ?? '') }));
}
