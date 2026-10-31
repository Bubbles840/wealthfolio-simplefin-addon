/**
 * shared/receipt.ts
 *
 * A receipt or order, read by a vision model, checked and shared out by code
 * (docs/superpowers/specs/2026-10-29-receipt-reader-design.md).
 *
 * The model only TRANSCRIBES (`ReceiptTranscript`): each line as printed, its
 * amount and the flag printed after it, the totals and any gift cards. Tests on
 * real receipts showed a model gets the arithmetic wrong when asked for it —
 * which line a discount comes off, which lines are taxed — while it copies
 * text reliably. So everything that is arithmetic happens here:
 *
 * - a discount comes off the item it names (or, naming none, the item above
 *   it), so a discounted taxable item is taxed on its discounted price; a
 *   savings summary the model listed anyway ("INSTANT SAVINGS", the sum of the
 *   discounts above it) is dropped;
 * - the lines must add up to the subtotal, items + charges + tax to the
 *   payments, and the printed total to the order either before or after its
 *   gift cards (a till prints it before, an order page after), or nothing is
 *   written;
 * - which items were taxed comes from the tax line a receipt prints ("A
 *   8.5% TAX"), or, on an order page that prints no rate, from the rates
 *   earlier receipts printed: the one set of items whose tax at that rate is
 *   the printed tax (`taxedItems`). A flag letter alone is not trusted — a
 *   model copies letters printed before an item number as its flag;
 * - tax is shared over the taxed items and charges (shipping) over every
 *   item, in proportion and in whole cents, so the items add up to the total
 *   exactly.
 *
 * Amounts are magnitudes: a model's minus sign is ignored, because the line's
 * kind already says which way it goes. Money is integer cents, never a float.
 * Pure — the companion calls the model and writes the rows.
 */

/** One printed line. `charge` is shipping or a fee; `charge_discount` takes one off. */
export type TranscriptLineKind = 'item' | 'discount' | 'charge' | 'charge_discount';
export type PaymentKind = 'card' | 'gift_card';

export interface TranscriptLine {
  kind: TranscriptLineKind;
  text: string;
  amount: string | number;
  /** The item number printed on the line, if any. */
  number?: string;
  /** A discount: the item number it names, if any. */
  appliesTo?: string;
  /** Letters printed after the amount (a tax flag), if any. */
  flag?: string;
}

/** A printed tax line: "A 8.5% TAX 4.25". */
export interface TranscriptTaxLine {
  /** The letter that marks the items it taxes; "" when it names none. */
  flag: string;
  rate: string;
  amount: string | number;
}

/** One payment line as printed: "VISA 82.40", "WALLET - SHOPCARD 30.00", "Gift Card Amount -25.00". */
export interface TranscriptPayment {
  label: string;
  /** "" when the line prints no amount (an order page names the card but not what it paid). */
  amount: string | number;
  /** The model's reading; a gift-card label wins over it (`isGiftCardLabel`). */
  kind?: PaymentKind;
}

/** What the model returns. */
export interface ReceiptTranscript {
  store: string;
  /** YYYY-MM-DD. */
  date: string;
  lines: TranscriptLine[];
  subtotal: string | number;
  tax: string | number;
  /** Tax lines that print a rate, if any. */
  taxLines?: TranscriptTaxLine[];
  /** The total as printed: before gift cards on a till receipt, after them on an order page. */
  total: string | number;
  /** Every payment line, gift cards included; never the change. */
  payments: TranscriptPayment[];
}

/** One item after its discounts, with its share of the tax and charges. */
export interface ReceiptItem {
  text: string;
  /** Price after discounts. */
  cents: number;
  taxable: boolean;
  taxCents: number;
  chargeCents: number;
}

export interface ReceiptPayment {
  kind: PaymentKind;
  label: string;
  cents: number;
}

/** How the taxed items were found: a printed tax line, a rate an earlier
 *  receipt printed, or neither (the tax is shared over every item). */
export type TaxBasis = 'printed' | 'known-rate' | 'shared';

export interface Receipt {
  store: string;
  date: string;
  items: ReceiptItem[];
  taxCents: number;
  taxBasis: TaxBasis;
  /** Rates this receipt printed, in basis points (8.5% = 850), to remember for order pages. */
  printedRates: number[];
  /** Charges less charge discounts; may be 0. */
  chargesCents: number;
  /** The whole order: items, charges and tax, before any gift card. */
  totalCents: number;
  /** Gift cards first, then cards; none of $0. They add up to `totalCents`. */
  payments: ReceiptPayment[];
}

export type ReceiptProblem =
  | 'no-items' | 'no-date' | 'unreadable-amount' | 'discount-too-large'
  | 'lines-dont-add-up' | 'total-doesnt-add-up' | 'payments-dont-add-up' | 'tax-looks-wrong';

export type ReceiptResult = { ok: true; receipt: Receipt } | { ok: false; problem: ReceiptProblem };

/** What the bot says when a receipt fails a check. */
export const RECEIPT_PROBLEM_TEXT: Record<ReceiptProblem, string> = {
  'no-items': "I couldn't find any items on it.",
  'no-date': "I couldn't read the date.",
  'unreadable-amount': "I couldn't read one of the amounts.",
  'discount-too-large': 'A discount came out larger than the item it belongs to.',
  'lines-dont-add-up': "The items I read don't add up to the subtotal.",
  'total-doesnt-add-up': "The items, charges and tax I read don't add up to the order total.",
  'payments-dont-add-up': "The gift cards and total I read don't add up to the order.",
  'tax-looks-wrong': "The tax I read doesn't fit the taxed items.",
};

/** Tax above this share of the taxed items is a misread, not a tax rate. */
export const MAX_TAX_PERCENT = 20;

/** A printed rate ("8.5%", "8.5") in basis points; null when unreadable. */
export function rateBasisPoints(value: string | null | undefined): number | null {
  const m = /^(\d{1,2})(?:\.(\d{1,3}))?$/.exec((value ?? '').replace(/[%\s]/g, ''));
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Math.round(Number(`0.${m[2] ?? '0'}`) * 100);
  return bp > 0 && bp <= MAX_TAX_PERCENT * 100 ? bp : null;
}

/**
 * A line printed as two numbers joined by "/" ("0000123456 / 7654321", or
 * "/7654321" with the first number in its own column) is a discount on the item
 * with the second number, whatever kind the model gave it: the text is fixed,
 * the model's label for it is not. The pattern is looked for in the item-number
 * field too, where a model sometimes puts it.
 */
function asDiscount(line: TranscriptLine): TranscriptLine {
  const pattern = /^\s*(?:\d+\s*)?\/\s*(\d+)\s*$/;
  const m = pattern.exec(line.text ?? '') ?? pattern.exec(line.number ?? '');
  return m ? { ...line, kind: 'discount', appliesTo: m[1] } : line;
}

/** A summary label ("SUBTOTAL", "TOTAL", "TAX") that a model gave to a line: never an item. */
const isSummaryLabel = (text: string) => /^\s*(sub\s*total|total|tax|total tax)\b/i.test(text);

/** A quantity line ("2 @ 6.50") printed above an item that carries the total: not an item itself. */
const isQuantityLine = (line: TranscriptLine) => /^\s*\d+\s*@\s*\$?\d+(\.\d{1,2})?\s*$/.test(line.text ?? '');

/** A label that names a gift card, a store's own card or credit: paid from a balance, not by a bank card. */
export const isGiftCardLabel = (label: string) => /gift|shop\s*card|store\s*card|store\s*credit|wallet|promotional|reward/i.test(label);

/** A printed label without the colon a summary table puts after it. */
const cleanLabel = (label: string | null | undefined) => (label ?? '').trim().replace(/\s*:$/, '');

/** Tax at `bp` basis points on `cents`, rounded to the cent. */
const taxAt = (cents: number, bp: number) => Math.round((cents * bp) / 10_000);

/** How far a printed tax may be from the rate's: a store that rounds each item's tax can be off half a cent per item. */
const taxSlack = (taxedCount: number) => Math.max(1, Math.ceil(taxedCount / 2));

/** Above this many items or this many cents, `taxedItems` does not search: its
 *  table is items × cents bytes, about 12 MB at these limits. */
const SEARCH_MAX_ITEMS = 60;
const SEARCH_MAX_CENTS = 200_000;

/**
 * The ONE set of items whose tax at one of `rates` is `tax`, as a mask over
 * `cents`; null when no set fits or more than one does (then nothing says
 * which items were taxed). Counts subsets by sum, capped at 2, so it is a table
 * of items × cents, not a walk over every subset.
 */
export function taxedItems(cents: readonly number[], tax: number, rates: readonly number[]): boolean[] | null {
  const total = cents.reduce((s, c) => s + c, 0);
  if (tax <= 0) return cents.map(() => false);
  if (cents.length > SEARCH_MAX_ITEMS || total > SEARCH_MAX_CENTS) return null;
  // ways[i][s]: subsets of the first i items adding up to s, capped at 2.
  const ways = [new Uint8Array(total + 1)];
  ways[0][0] = 1;
  cents.forEach((c, i) => {
    const prev = ways[i];
    const next = prev.slice();
    for (let s = c; s <= total; s++) next[s] = Math.min(2, next[s] + prev[s - c]);
    ways.push(next);
  });
  let found: { sum: number } | null = null;
  for (const bp of new Set(rates)) {
    for (let sum = 1; sum <= total; sum++) {
      const n = ways[cents.length][sum];
      if (n === 0) continue;
      // The slack depends on how many items are taxed; a unique sum has one count, bounded by all items.
      if (Math.abs(taxAt(sum, bp) - tax) > taxSlack(cents.length)) continue;
      if (n > 1 || (found && found.sum !== sum)) return null;
      found = { sum };
    }
  }
  if (!found) return null;
  const mask = cents.map(() => false);
  let sum = found.sum;
  for (let i = cents.length; i > 0; i--) {
    if (ways[i - 1][sum] > 0) continue;
    mask[i - 1] = true;
    sum -= cents[i - 1];
  }
  return mask;
}

/** A printed amount as whole cents, sign dropped; null when unreadable. */
export function amountCents(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[$,\s-]/g, '');
  if (!/^\d+(\.\d{1,2})?$|^\.\d{1,2}$/.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  return Number(whole || '0') * 100 + Number(frac.padEnd(2, '0'));
}

/**
 * `total` shared over `weights` in proportion, in whole cents that add up to
 * `total` exactly: each gets its floor, then the leftover cents go to the
 * largest remainders (ties to the larger weight, then the earlier one). With no
 * weight at all, everything goes to the first.
 */
export function shareCents(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const shares = weights.map((w) => Math.floor((abs * w) / sum));
  let left = abs - shares.reduce((s, x) => s + x, 0);
  const order = weights
    .map((w, i) => ({ i, w, rem: (abs * w) % sum }))
    .sort((a, b) => b.rem - a.rem || b.w - a.w || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    shares[i] += 1;
    left -= 1;
  }
  return shares.map((x) => x * sign);
}

/** Checks a transcript and shares out its tax and charges. `knownRates` are
 *  rates earlier receipts printed (basis points), for an order page that prints none. */
export function buildReceipt(t: ReceiptTranscript, knownRates: readonly number[] = []): ReceiptResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date ?? '')) return { ok: false, problem: 'no-date' };

  interface Working { text: string; number?: string; gross: number; cents: number; flag: string }
  const items: Working[] = [];
  let charges = 0;
  let discounted = 0;
  // Lines a model mislabelled with a summary label, and the item each followed:
  // one may be a discount whose own label the model lost (see below).
  const mislabelled: Array<{ cents: number; after: Working | undefined }> = [];
  for (const raw of t.lines ?? []) {
    if (isQuantityLine(raw)) continue;
    const line = asDiscount(raw);
    const cents = amountCents(line.amount);
    if (cents === null) return { ok: false, problem: 'unreadable-amount' };
    if (line.kind === 'item' && isSummaryLabel(line.text)) {
      mislabelled.push({ cents, after: items.at(-1) });
      continue;
    }
    if (line.kind === 'item') {
      const number = line.number?.trim() || undefined;
      // A model sometimes repeats the item number at the start of the text.
      const text = number && line.text.trim().startsWith(`${number} `) ? line.text.trim().slice(number.length).trim() : line.text.trim();
      items.push({ text, number, gross: cents, cents, flag: (line.flag ?? '').trim() });
    } else if (line.kind === 'discount') {
      const named = line.appliesTo?.trim();
      // The receipt's own savings summary, listed although the prompt says not to: it repeats the discounts above it.
      if (!named && discounted > 0 && cents === discounted) continue;
      discounted += cents;
      // A number that matches no item is a misread: guessing the line would tax the wrong price.
      const target = named ? [...items].reverse().find((i) => i.number === named) : items.at(-1);
      if (!target) return { ok: false, problem: 'lines-dont-add-up' };
      target.cents -= cents;
      if (target.cents < 0) return { ok: false, problem: 'discount-too-large' };
    } else if (line.kind === 'charge') {
      charges += cents;
    } else {
      charges -= cents;
    }
  }
  const kept = items.filter((i) => i.gross > 0);
  if (kept.length === 0) return { ok: false, problem: 'no-items' };

  const subtotal = amountCents(t.subtotal);
  const tax = amountCents(t.tax) ?? 0;
  const total = amountCents(t.total);
  if (subtotal === null || total === null) return { ok: false, problem: 'unreadable-amount' };

  let net = kept.reduce((s, i) => s + i.cents, 0);
  // Short by exactly one mislabelled line's amount: that line was a discount on
  // the item above it. Only then — the totals below must still reconcile.
  const missing = mislabelled.filter((m) => m.after && net - m.cents === subtotal && m.after.cents >= m.cents);
  if (subtotal !== net && missing.length === 1) {
    missing[0].after!.cents -= missing[0].cents;
    net -= missing[0].cents;
  }
  const gross = kept.reduce((s, i) => s + i.gross, 0);
  // An order page prints the subtotal before its item discounts, a till receipt after them.
  if (subtotal !== net && subtotal !== gross) return { ok: false, problem: 'lines-dont-add-up' };
  const orderCents = net + charges + tax;

  // Payments: what each printed line paid. A card whose amount is not printed
  // (an order page) paid whatever the gift cards left.
  const printed: ReceiptPayment[] = [];
  const unpriced: string[] = [];
  for (const p of t.payments ?? []) {
    const label = cleanLabel(p.label);
    const kind: PaymentKind = isGiftCardLabel(label) || p.kind === 'gift_card' ? 'gift_card' : 'card';
    const raw = String(p.amount ?? '').trim();
    const cents = raw === '' ? null : amountCents(raw);
    if (raw !== '' && cents === null) return { ok: false, problem: 'unreadable-amount' };
    if (cents === null) { if (kind === 'card') unpriced.push(label); continue; }
    if (cents > 0) printed.push({ kind, label, cents });
  }
  const giftCents = printed.filter((p) => p.kind === 'gift_card').reduce((s, p) => s + p.cents, 0);
  // The printed total is the order before its gift cards (a till) or after them (an order page).
  if (total !== orderCents && total !== orderCents - giftCents) return { ok: false, problem: 'total-doesnt-add-up' };
  const left = orderCents - printed.reduce((s, p) => s + p.cents, 0);
  if (left > 0) printed.push({ kind: 'card', label: unpriced[0] ?? '', cents: left });
  if (left < 0) return { ok: false, problem: 'payments-dont-add-up' };
  const payments = [...printed.filter((p) => p.kind === 'gift_card'), ...printed.filter((p) => p.kind === 'card')];

  // Which items were taxed: by the printed tax lines' letters when their rates
  // account for the tax; else the one set of items a known rate explains; else all.
  const taxLines = (t.taxLines ?? [])
    .map((l) => ({ flag: (l.flag ?? '').trim().toUpperCase(), bp: rateBasisPoints(String(l.rate ?? '')) }))
    .filter((l): l is { flag: string; bp: number } => l.bp !== null);
  const printedRates = [...new Set(taxLines.map((l) => l.bp))];
  let taxBasis: TaxBasis = 'shared';
  let taxable = kept.map(() => true);
  const lettered = taxLines.filter((l) => /^[A-Z]$/.test(l.flag));
  if (lettered.length > 0) {
    const letterOf = (i: Working) => lettered.find((l) => i.flag.toUpperCase().includes(l.flag));
    const expected = kept.reduce((s, i) => s + (letterOf(i) ? taxAt(i.cents, letterOf(i)!.bp) : 0), 0);
    const count = kept.filter((i) => letterOf(i)).length;
    if (count > 0 && Math.abs(expected - tax) <= taxSlack(count)) {
      taxable = kept.map((i) => !!letterOf(i));
      taxBasis = 'printed';
    }
  }
  // No rate beside a letter: the ONE letter whose items a printed or remembered
  // rate explains ("all the Y items"). Tried before the search over every set of
  // items, whose slack grows with a long receipt until many sets fit.
  const rates = [...printedRates, ...knownRates];
  if (taxBasis === 'shared' && tax > 0) {
    const letters = [...new Set(kept.flatMap((i) => i.flag.toUpperCase().match(/[A-Z]/g) ?? []))];
    const fits = letters.filter((letter) => {
      const set = kept.filter((i) => i.flag.toUpperCase().includes(letter));
      const base = set.reduce((s, i) => s + i.cents, 0);
      return rates.some((bp) => Math.abs(taxAt(base, bp) - tax) <= taxSlack(set.length));
    });
    if (fits.length === 1) {
      taxable = kept.map((i) => i.flag.toUpperCase().includes(fits[0]));
      taxBasis = 'known-rate';
    }
  }
  if (taxBasis === 'shared') {
    const mask = taxedItems(kept.map((i) => i.cents), tax, rates);
    if (mask && mask.some(Boolean) === tax > 0) {
      taxable = mask;
      taxBasis = 'known-rate';
    }
  }
  if (taxBasis === 'shared' && tax * 100 > net * MAX_TAX_PERCENT) return { ok: false, problem: 'tax-looks-wrong' };

  const taxShares = shareCents(tax, kept.map((i, n) => (taxable[n] ? i.cents : 0)));
  const chargeShares = shareCents(charges, kept.map((i) => i.cents));
  // An order-wide discount larger than an item's share of it would leave that item below zero.
  if (kept.some((i, n) => i.cents + taxShares[n] + chargeShares[n] < 0)) return { ok: false, problem: 'discount-too-large' };
  return {
    ok: true,
    receipt: {
      store: t.store.trim(),
      date: t.date,
      items: kept.map((i, n) => ({ text: i.text, cents: i.cents, taxable: taxable[n], taxCents: taxShares[n], chargeCents: chargeShares[n] })),
      taxCents: tax,
      taxBasis,
      printedRates,
      chargesCents: charges,
      totalCents: orderCents,
      payments,
    },
  };
}

/** One proposed row: a category and everything filed under it, tax and charges included. */
export interface CategoryRow {
  categoryId: string;
  cents: number;
  items: string[];
}

/** Items grouped by category, in the order each category first appears. */
export function groupByCategory(items: readonly ReceiptItem[], categoryOf: readonly string[]): CategoryRow[] {
  const rows = new Map<string, CategoryRow>();
  items.forEach((item, n) => {
    const id = categoryOf[n];
    const row = rows.get(id) ?? { categoryId: id, cents: 0, items: [] };
    row.cents += item.cents + item.taxCents + item.chargeCents;
    row.items.push(item.text);
    rows.set(id, row);
  });
  return [...rows.values()];
}

/**
 * The rows each payment covers. A receipt does not say which items a gift card
 * paid for, so every payment gets the same category mix, in proportion. Each
 * payment's rows add up to the payment, and each category's rows across the
 * payments add up to the category: a payment takes its share of what is left,
 * and the last takes the rest.
 */
export function rowsByPayment(rows: readonly CategoryRow[], payments: readonly ReceiptPayment[]): CategoryRow[][] {
  const left = rows.map((r) => r.cents);
  return payments.map((payment, p) => {
    const cents = p === payments.length - 1
      ? [...left]
      : shareCents(payment.cents, left);
    cents.forEach((c, n) => { left[n] -= c; });
    return rows.map((r, n) => ({ ...r, cents: cents[n] })).filter((r) => r.cents > 0);
  });
}
