import { describe, it, expect } from 'vitest';
import {
  amountCents, buildReceipt, groupByCategory, rateBasisPoints, rowsByPayment, shareCents, taxedItems,
  type Receipt, type ReceiptTranscript, type TranscriptLine,
} from './receipt.js';

const item = (text: string, amount: string, more: Partial<TranscriptLine> = {}): TranscriptLine => ({ kind: 'item', text, amount, ...more });

/** A till receipt: taxed lines flagged "A" and a tax line saying so, a discount naming its item by number. */
const till = (over: Partial<ReceiptTranscript> = {}): ReceiptTranscript => ({
  store: 'Corner Market',
  date: '2027-03-14',
  lines: [
    item('BREAD', '10.00', { number: '111' }),
    item('LAMP', '49.99', { number: '222', flag: 'A' }),
    item('SOAP', '25.00', { number: '333', flag: 'A' }),
    { kind: 'discount', text: '0099 / 222', amount: '10.00-', appliesTo: '222', flag: 'A' },
  ],
  subtotal: '74.99', tax: '6.50', total: '81.49',
  taxLines: [{ flag: 'A', rate: '10.00%', amount: '6.50' }],
  payments: [{ label: 'VISA', amount: '' }],
  ...over,
});

/** An order page: subtotal before discounts, free shipping, part gift card. */
const order = (over: Partial<ReceiptTranscript> = {}): ReceiptTranscript => ({
  store: 'Online Store',
  date: '2027-03-10',
  lines: [
    item('Board book', '14.00'),
    item('Kitchen grater', '36.00'),
    { kind: 'charge', text: 'Shipping', amount: '2.99' },
    { kind: 'charge_discount', text: 'Free shipping', amount: '-2.99' },
  ],
  subtotal: '50.00', tax: '4.25', total: '14.25',
  payments: [
    { label: 'Gift card:', amount: '-40.00', kind: 'gift_card' },
    { label: 'Promotional balance', amount: '0.00', kind: 'gift_card' },
    { label: 'Visa ending in 0000', amount: '' },
  ],
  ...over,
});

const built = (t: ReceiptTranscript, knownRates: number[] = []): Receipt => {
  const r = buildReceipt(t, knownRates);
  if (!r.ok) throw new Error(r.problem);
  return r.receipt;
};
const itemTotal = (r: Receipt) => r.items.reduce((s, i) => s + i.cents + i.taxCents + i.chargeCents, 0);

describe('amountCents', () => {
  it('reads printed amounts as magnitudes in whole cents', () => {
    expect(['10.00', '10', '$1,234.5', '10.00-', '-0.99', '.5', 12.3].map(amountCents)).toEqual([1000, 1000, 123450, 1000, 99, 50, 1230]);
  });

  it('refuses what is not an amount', () => {
    expect(['', 'abc', '1.234', '1.2.3', null, undefined].map(amountCents)).toEqual([null, null, null, null, null, null]);
  });
});

describe('rateBasisPoints', () => {
  it('reads a printed rate in basis points and refuses what is not a sales tax rate', () => {
    expect(['8.5%', '8.5', ' 7 %', '8.875%'].map(rateBasisPoints)).toEqual([850, 850, 700, 888]);
    expect(['', 'A', '0%', '35%', null].map(rateBasisPoints)).toEqual([null, null, null, null, null]);
  });
});

describe('taxedItems', () => {
  it('finds the one set of items a rate explains', () => {
    expect(taxedItems([1250, 4000], 340, [850])).toEqual([false, true]);
    expect(taxedItems([1250, 4000], 446, [850])).toEqual([true, true]);
  });

  it('says nothing when two sets fit, or none does', () => {
    expect(taxedItems([1000, 1000], 100, [1000])).toBeNull();
    expect(taxedItems([1250, 4000], 500, [850])).toBeNull();
    expect(taxedItems([1250, 4000], 340, [])).toBeNull();
  });

  it('taxes nothing when there is no tax', () => {
    expect(taxedItems([1250, 4000], 0, [])).toEqual([false, false]);
  });
});

describe('shareCents', () => {
  it('adds up to the total exactly and gives leftover cents to the largest remainders', () => {
    expect(shareCents(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(shareCents(500, [1000, 3999])).toEqual([100, 400]);
  });

  it('breaks an even remainder toward the larger weight', () => {
    expect(shareCents(1, [1, 3])).toEqual([0, 1]);
  });

  it('shares a negative total and puts everything on the first share with no weight', () => {
    expect(shareCents(-10, [1, 1])).toEqual([-5, -5]);
    expect(shareCents(7, [0, 0])).toEqual([7, 0]);
    expect(shareCents(0, [])).toEqual([]);
  });
});

describe('buildReceipt', () => {
  it('takes a discount off the item it names, so the item is taxed on its discounted price', () => {
    const r = built(till());
    expect(r.items.map((i) => [i.text, i.cents, i.taxable, i.taxCents])).toEqual([
      ['BREAD', 1000, false, 0],
      ['LAMP', 3999, true, 400],
      ['SOAP', 2500, true, 250],
    ]);
    expect(itemTotal(r)).toBe(r.totalCents);
  });

  it('taxes only the letter the tax line names, not a letter a model copied from before the item number', () => {
    const lines = [item('GROCERY', '20.00', { flag: 'E' }), item('VASE', '30.00', { flag: 'A' })];
    const r = built(till({ lines, subtotal: '50.00', tax: '2.55', total: '52.55', taxLines: [{ flag: 'A', rate: '8.5%', amount: '2.55' }] }));
    expect([r.taxBasis, r.printedRates, r.items.map((i) => i.taxCents)]).toEqual(['printed', [850], [0, 255]]);
  });

  it('on an order page with no rate, taxes the items a known rate explains', () => {
    const r = built(order({ lines: [item('Snack', '12.50'), item('Toy', '40.00')], subtotal: '52.50', tax: '3.40', total: '0.00',
      payments: [{ label: 'Gift card', amount: '55.90', kind: 'gift_card' }] }), [850]);
    expect([r.taxBasis, r.items.map((i) => [i.taxable, i.taxCents])]).toEqual(['known-rate', [[false, 0], [true, 340]]]);
  });

  it('shares the tax over every item when nothing says which were taxed', () => {
    const r = built(till({ taxLines: [] }));
    expect([r.taxBasis, r.items.every((i) => i.taxable)]).toEqual(['shared', true]);
  });

  it('does not trust a printed rate that does not account for the tax', () => {
    expect(built(till({ taxLines: [{ flag: 'A', rate: '5%', amount: '6.50' }] })).taxBasis).not.toBe('printed');
  });

  it('reads a "number / number" line as a discount on that item, whatever kind the model gave it', () => {
    const lines = till().lines.map((l) => (l.kind === 'discount' ? { ...l, kind: 'item' as const, appliesTo: undefined, amount: '10.00', text: '0099 / 222' } : l));
    expect(built(till({ lines })).items.map((i) => i.cents)).toEqual([1000, 3999, 2500]);
  });

  it('drops a savings summary the model listed as a discount, and the item number repeated in the text', () => {
    const lines = [...till().lines, { kind: 'discount' as const, text: 'INSTANT SAVINGS', amount: '-10.00' }]
      .map((l) => (l.kind === 'item' && l.number === '222' ? { ...l, text: '222 LAMP' } : l));
    const r = built(till({ lines }));
    expect(r.items.map((i) => [i.text, i.cents])).toEqual([['BREAD', 1000], ['LAMP', 3999], ['SOAP', 2500]]);
  });

  it('reads "/7654321" with the first number in its own column as a discount, and skips quantity lines', () => {
    const lines: TranscriptLine[] = [
      { kind: 'item', text: '2 @ 5.00', amount: '5.00' },
      item('BREAD', '10.00', { number: '111' }),
      item('LAMP', '49.99', { number: '222', flag: 'A' }),
      item('SOAP', '25.00', { number: '333', flag: 'A' }),
      { kind: 'item', text: 'SUBTOTAL', number: '0099 /222', amount: '10.00' },
    ];
    expect(built(till({ lines })).items.map((i) => [i.text, i.cents])).toEqual([['BREAD', 1000], ['LAMP', 3999], ['SOAP', 2500]]);
  });

  it('reads a discount the model labelled SUBTOTAL as one, when it is exactly what the items are short by', () => {
    const lines: TranscriptLine[] = [
      item('BREAD', '10.00', { number: '111' }),
      item('LAMP', '49.99', { number: '222', flag: 'A' }),
      item('SOAP', '25.00', { number: '333', flag: 'A' }),
      { kind: 'item', text: 'SUBTOTAL', number: '0099', amount: '10.00' },
    ];
    expect(built(till({ lines })).items.map((i) => [i.text, i.cents])).toEqual([['BREAD', 1000], ['LAMP', 4999], ['SOAP', 1500]]);
    // Not the amount the items are short by: refused, never guessed.
    const off = lines.map((l) => (l.text === 'SUBTOTAL' ? { ...l, amount: '9.00' } : l));
    expect(buildReceipt(till({ lines: off }))).toEqual({ ok: false, problem: 'lines-dont-add-up' });
  });

  it('takes a discount that names no item off the item above it', () => {
    const lines = [item('A', '5.00'), item('B', '8.00'), { kind: 'discount' as const, text: 'COUPON', amount: '3.00' }];
    expect(built(till({ lines, subtotal: '10.00', tax: '0', total: '10.00' }))
      .items.map((i) => i.cents)).toEqual([500, 500]);
  });

  it('taxes every item when the receipt flags none, and shares charges over every item', () => {
    const r = built(order({
      lines: [item('Book', '20.00'), item('Grater', '40.00'), { kind: 'charge', text: 'Shipping', amount: '3.00' }],
      subtotal: '60.00', tax: '6.00', total: '69.00', payments: [{ label: 'Visa', amount: '' }],
    }));
    expect(r.items.map((i) => [i.taxable, i.taxCents, i.chargeCents])).toEqual([[true, 200, 100], [true, 400, 200]]);
    expect(itemTotal(r)).toBe(6900);
  });

  it('reads an order page: subtotal before discounts, free shipping, minus signs ignored, $0 gift cards dropped', () => {
    const r = built(order());
    expect(r.chargesCents).toBe(0);
    expect(r.payments).toEqual([
      { kind: 'gift_card', label: 'Gift card', cents: 4000 },
      { kind: 'card', label: 'Visa ending in 0000', cents: 1425 },
    ]);
    expect([r.totalCents, itemTotal(r)]).toEqual([5425, 5425]);
  });

  it('reads an order a gift card paid in full: a printed total of $0 is no card payment', () => {
    const r = built(order({ total: '0.00', payments: [{ label: 'Gift card', amount: '-54.25', kind: 'gift_card' }, { label: 'Visa', amount: '' }] }));
    expect(r.payments).toEqual([{ kind: 'gift_card', label: 'Gift card', cents: 5425 }]);
  });

  it('reads a till that prints its total before a store card, and knows a shop card by its label', () => {
    const r = built(till({ payments: [{ label: 'VISA', amount: '41.49' }, { label: 'WALLET - SHOPCARD', amount: '40.00', kind: 'card' }] }));
    expect(r.payments).toEqual([
      { kind: 'gift_card', label: 'WALLET - SHOPCARD', cents: 4000 },
      { kind: 'card', label: 'VISA', cents: 4149 },
    ]);
  });

  it('taxes the one letter whose items a remembered rate explains, on a long receipt', () => {
    const lines = [
      item('SHIRT', '9.99', { flag: 'Y' }), item('SNACK', '60.01', { flag: 'Y' }),
      ...[3.25, 11.40, 17.05, 8.15, 9.70, 6.35, 13.80, 22.10, 12.65, 5.55, 8.85, 26.40, 11.20, 13.95]
        .map((p, n) => item(`FOOD ${n}`, p.toFixed(2), { flag: 'N' })),
    ];
    const subtotal = lines.reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0);
    const r = built(till({ lines, subtotal: (subtotal / 100).toFixed(2), tax: '5.95', total: ((subtotal + 595) / 100).toFixed(2), taxLines: [] }), [850]);
    expect([r.taxBasis, r.items.filter((i) => i.taxCents > 0).map((i) => i.text)]).toEqual(['known-rate', ['SHIRT', 'SNACK']]);
  });

  it('accepts a subtotal printed before item discounts', () => {
    expect(buildReceipt(till({ subtotal: '84.99' })).ok).toBe(true);
  });

  it('accepts a till subtotal that counts a fee, and shares the fee out once', () => {
    const lines: TranscriptLine[] = [
      item('TOYS', '20.00', { flag: 'T' }), item('TOPS', '30.00', { flag: 'T' }),
      { kind: 'charge', text: 'BAG FEE', amount: '0.10', flag: 'N' },
    ];
    const r = built(till({ lines, subtotal: '50.10', tax: '4.25', total: '54.35', taxLines: [{ flag: '', rate: '8.5%', amount: '4.25' }],
      payments: [{ label: 'MASTERCARD', amount: '54.35' }] }));
    expect([r.chargesCents, r.totalCents, itemTotal(r)]).toEqual([10, 5435, 5435]);
    expect(r.items.map((i) => i.taxCents)).toEqual([170, 255]);
  });

  it('still refuses a subtotal that is neither the items alone nor the items and fees', () => {
    const lines: TranscriptLine[] = [item('TOYS', '20.00'), { kind: 'charge', text: 'BAG FEE', amount: '0.10' }];
    expect(buildReceipt(till({ lines, subtotal: '20.20', tax: '0.00', total: '20.30', taxLines: [], payments: [{ label: 'VISA', amount: '20.30' }] })))
      .toEqual({ ok: false, problem: 'lines-dont-add-up' });
  });

  it.each([
    ['no-date', { date: '03/14/2027' }],
    ['no-items', { lines: [] }],
    ['unreadable-amount', { total: 'ab.cd' }],
    ['lines-dont-add-up', { subtotal: '70.00' }],
    ['total-doesnt-add-up', { total: '81.50' }],
    ['payments-dont-add-up', { payments: [{ label: 'VISA', amount: '81.49' }, { label: 'Gift card', amount: '30.00' }] }],
  ])('refuses %s', (problem, over) => {
    expect(buildReceipt(till(over))).toEqual({ ok: false, problem });
  });

  it('refuses a discount naming an item that is not there, or larger than its item', () => {
    const stray = till().lines.map((l) => (l.kind === 'discount' ? { ...l, appliesTo: '999', text: '0099 / 999' } : l));
    expect(buildReceipt(till({ lines: stray }))).toEqual({ ok: false, problem: 'lines-dont-add-up' });
    const huge = till().lines.map((l) => (l.kind === 'discount' ? { ...l, amount: '60.00' } : l));
    expect(buildReceipt(till({ lines: huge }))).toEqual({ ok: false, problem: 'discount-too-large' });
  });

  it('refuses an order-wide discount that would leave an item below zero', () => {
    // $11.50 off a $10.00 order, $1.80 tax on B: the order still totals $0.30, but A's share of the discount is $1.15.
    const lines = [item('A', '1.00'), item('B', '9.00', { flag: 'A' }), { kind: 'charge_discount' as const, text: 'PROMO', amount: '11.50' }];
    expect(buildReceipt(till({ lines, subtotal: '10.00', tax: '1.80', total: '0.30', taxLines: [{ flag: 'A', rate: '20%', amount: '1.80' }] })))
      .toEqual({ ok: false, problem: 'discount-too-large' });
  });

  it('refuses tax far above any real rate on the taxed items', () => {
    const lines = [item('BREAD', '10.00'), item('PEN', '1.00', { flag: 'A' })];
    expect(buildReceipt(till({ lines, subtotal: '11.00', tax: '3.00', total: '14.00', taxLines: [] })))
      .toEqual({ ok: false, problem: 'tax-looks-wrong' });
  });
});

describe('groupByCategory and rowsByPayment', () => {
  it('groups items by category with their tax and charges', () => {
    const r = built(till());
    const rows = groupByCategory(r.items, ['groceries', 'home', 'home']);
    expect(rows).toEqual([
      { categoryId: 'groceries', cents: 1000, items: ['BREAD'] },
      { categoryId: 'home', cents: 3999 + 400 + 2500 + 250, items: ['LAMP', 'SOAP'] },
    ]);
  });

  it('gives every payment the same category mix, adding up both ways', () => {
    const r = built(order());
    const rows = groupByCategory(r.items, ['books', 'home']);
    const split = rowsByPayment(rows, r.payments);
    split.forEach((payRows, p) => expect(payRows.reduce((s, x) => s + x.cents, 0)).toBe(r.payments[p].cents));
    rows.forEach((row) => expect(split.flat().filter((x) => x.categoryId === row.categoryId).reduce((s, x) => s + x.cents, 0)).toBe(row.cents));
    expect(split[0].map((x) => x.cents)).toEqual([1120, 2880]);
  });
});
