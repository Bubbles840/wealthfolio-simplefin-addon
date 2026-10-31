import { describe, it, expect } from 'vitest';
import {
  CHARGE_WINDOW_DAYS, DEFAULT_RECEIPT_MODEL, modelProblem, parseReceiptHostStatus, RECEIPT_LIMITS, confirmedFilings, giftAccountKey, giftCardWrites, matchingCharges,
  moveItem, newProposal, parseReceiptReaderConfig, parseReceiptState, parseReceiptTap, proposalRows, proposalRowsByPayment,
  pruneReceiptState, receiptFingerprint, receiptReaderConfigForEditing, renderCategoryPicker, renderGiftAccountPicker,
  renderChargePicker, renderItemPicker, renderProposal, splitLines, undoKeyboard, fullyCategorized, NO_CATEGORY,
  type ReceiptCategory, type ReceiptProposal, type ReceiptState,
} from './receipt-flow.js';
import { buildReceipt, type Receipt } from './receipt.js';
import type { SpendRow } from './wf-spending.js';

const NOW = new Date('2027-03-15T15:00:00Z');
const DAY = 86_400_000;
const UUID = (n: number) => `${String(n).padStart(8, '0')}-1111-2222-3333-444444444444`;

const CATS: ReceiptCategory[] = [
  { id: UUID(1), name: 'Groceries', parentId: null },
  { id: UUID(2), name: 'Home', parentId: null },
  { id: UUID(3), name: 'Lamps & Lighting', parentId: UUID(2) },
  { id: UUID(4), name: 'Gifts & Donations', parentId: null },
];

const receipt = (): Receipt => {
  const r = buildReceipt({
    store: 'Corner Market', date: '2027-03-14',
    lines: [
      { kind: 'item', text: 'BREAD', amount: '10.00' },
      { kind: 'item', text: 'LAMP', amount: '100.00', flag: 'A' },
      { kind: 'item', text: 'VASE', amount: '20.00', flag: 'A' },
    ],
    subtotal: '130.00', tax: '12.00', total: '102.00',
    taxLines: [{ flag: 'A', rate: '10%', amount: '12.00' }],
    payments: [{ label: 'Store gift card', amount: '40.00', kind: 'gift_card' }, { label: 'VISA', amount: '102.00' }],
  });
  if (!r.ok) throw new Error(r.problem);
  return r.receipt;
};
const proposal = (): ReceiptProposal => newProposal('abcd1234', receipt(), [UUID(1), UUID(3), UUID(4)], NOW);

describe('settings', () => {
  it('counts the reader as set up only when switched on with a host, trimming the host', () => {
    expect(parseReceiptReaderConfig(JSON.stringify({ enabled: true, url: ' http://mac.local:11434/ ', model: '' })))
      .toEqual({ enabled: true, url: 'http://mac.local:11434', model: DEFAULT_RECEIPT_MODEL });
    expect(parseReceiptReaderConfig(JSON.stringify({ enabled: false, url: 'http://x' }))).toBeNull();
    expect(parseReceiptReaderConfig(JSON.stringify({ url: ' ' }))).toBeNull();
    expect(receiptReaderConfigForEditing('not json')).toEqual({ enabled: true, url: '', model: DEFAULT_RECEIPT_MODEL });
  });
});

describe('the host check', () => {
  it('finds the model in the host\'s list, with or without a tag', () => {
    const tags = { models: [{ name: 'qwen2.5vl:32b' }, { name: 'llava:latest' }] };
    expect([modelProblem(tags, 'qwen2.5vl:32b'), modelProblem(tags, 'llava')]).toEqual([null, null]);
    expect(modelProblem(tags, 'qwen2.5vl:7b')).toMatch(/isn't installed.*ollama pull qwen2.5vl:7b/);
    expect(modelProblem('junk', 'm')).toMatch(/isn't installed/);
  });

  it('reads the stored status, and nothing from a damaged one', () => {
    expect(parseReceiptHostStatus(JSON.stringify({ checkedAt: 'x', error: null }))).toEqual({ checkedAt: 'x', error: null });
    expect(parseReceiptHostStatus('{')).toBeNull();
  });
});

describe('state', () => {
  it('reads a damaged secret as empty and drops malformed entries', () => {
    expect(parseReceiptState('{').queue).toEqual([]);
    const s = parseReceiptState(JSON.stringify({ queue: [{ fileId: 'f' }, { nope: 1 }], rates: [850, -1, 'x'], giftAccounts: [] }));
    expect([s.queue.length, s.rates, s.giftAccounts]).toEqual([1, [850], {}]);
  });

  it('forgets a week-old photo or proposal, keeps the newest of each list, and keeps what it learned', () => {
    const old = new Date(NOW.getTime() - 8 * DAY).toISOString();
    const s: ReceiptState = {
      ...parseReceiptState(null),
      queue: [{ fileId: 'a', fileUniqueId: 'a', receivedAt: old }, { fileId: 'b', fileUniqueId: 'b', receivedAt: NOW.toISOString() }],
      rates: Array.from({ length: RECEIPT_LIMITS.rates + 3 }, (_, n) => 100 + n),
      giftAccounts: { store: 'acct' },
    };
    const p = pruneReceiptState(s, NOW);
    expect(p.queue.map((q) => q.fileId)).toEqual(['b']);
    expect(p.rates).toHaveLength(RECEIPT_LIMITS.rates);
    expect(p.rates.at(-1)).toBe(100 + RECEIPT_LIMITS.rates + 2);
    expect(p.giftAccounts).toEqual({ store: 'acct' });
  });

  it('fingerprints a purchase by day, total and payments, in any order', () => {
    const a = receiptFingerprint({ date: '2027-03-14', payments: [{ kind: 'gift_card', label: 'x', cents: 1 }, { kind: 'card', label: 'y', cents: 2 }] });
    const b = receiptFingerprint({ date: '2027-03-14', payments: [{ kind: 'card', label: 'z', cents: 2 }, { kind: 'gift_card', label: 'w', cents: 1 }] });
    expect(a).toBe(b);
  });

  it('remembers a gift card account by store, or by the card name when no store was printed', () => {
    expect(giftAccountKey({ store: 'Corner  Market!', payments: [] })).toBe('corner market');
    expect(giftAccountKey({ store: '', payments: [{ kind: 'gift_card', label: 'Store Gift Card', cents: 1 }] })).toBe('store gift card');
  });
});

describe('the proposal', () => {
  it('carries each item with its tax, so the rows add up to what was paid', () => {
    const p = proposal();
    expect(p.items.map((i) => i.cents)).toEqual([1000, 11000, 2200]);
    expect(proposalRows(p).reduce((s, r) => s + r.cents, 0)).toBe(14200);
  });

  it('shows rows, payments and the tax basis, with Confirm, Change and Cancel', () => {
    const { text, keyboard } = renderProposal(proposal(), CATS, { duplicateOf: true });
    expect(text).toContain('*Home / Lamps & Lighting* — $110.00');
    expect(text).toContain('$40.00 by Store gift card → rows in the account that tracks it');
    expect(renderProposal(proposal(), CATS, { giftAccountName: 'Gift card cash' }).text).toContain('rows in Gift card cash');
    expect(text).toContain('from the rate printed');
    expect(text).toContain('same date, total and payments');
    expect(keyboard.inline_keyboard[0].map((b) => b.text)).toEqual(['✓ Confirm', '✎ Change', '✕ Cancel']);
  });

  it('leaves out whole rows, never half a line, past Telegram\'s limit', () => {
    const many = Array.from({ length: 80 }, (_, n): ReceiptCategory => ({ id: `cat-${n}`, name: `Category number ${n} with a long name`, parentId: null }));
    const p = { ...proposal(), items: many.map((c, n) => ({ text: `ITEM ${n} *SALE*`, cents: 100, categoryId: c.id })) };
    const { text } = renderProposal(p, many);
    expect(text.length).toBeLessThanOrEqual(3500);
    expect(text).toMatch(/…and \d+ more categories/);
    expect(text).toContain('Tax:');
  });

  it('moves one item and leaves the rest', () => {
    const moved = moveItem(proposal(), 2, UUID(1));
    expect(proposalRows(moved).map((r) => [r.categoryId, r.cents])).toEqual([[UUID(1), 3200], [UUID(3), 11000]]);
  });

  it('marks an item with no category and holds Confirm until it has one', () => {
    const p = moveItem(proposal(), 0, NO_CATEGORY);
    expect(renderProposal(p, CATS).text).toContain('*Needs a category* — $10.00');
    expect([fullyCategorized(p), fullyCategorized(proposal())]).toEqual([false, true]);
  });

  it('remembers what was confirmed, item by item', () => {
    expect(confirmedFilings(proposal())[1]).toEqual({ text: 'LAMP', categoryId: UUID(3) });
  });
});

describe('the buttons', () => {
  const p = proposal();
  const screens = [
    renderProposal(p, CATS),
    renderItemPicker(p, CATS, 0),
    renderCategoryPicker(p, 1, CATS, null),
    renderCategoryPicker(p, 1, CATS, UUID(2)),
    renderGiftAccountPicker(p, [{ id: UUID(9), name: 'Gift card cash' }]),
    renderChargePicker(p, [{ id: UUID(7), date: '2027-03-15T12:00:00+00:00', accountName: 'Card', absCents: 10200 } as SpendRow]),
    { keyboard: undoKeyboard(p.id) },
  ];
  const all = screens.flatMap((s) => s.keyboard.inline_keyboard.flat());

  it('fit Telegram\'s 64-byte limit and every one parses back', () => {
    for (const b of all) {
      expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
      expect(parseReceiptTap(b.callback_data)).not.toBeNull();
    }
  });

  it('open a parent that has subcategories, and offer the parent itself there', () => {
    const top = renderCategoryPicker(p, 1, CATS, null).keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(top).toEqual(['Groceries', 'Home ›', 'Gifts & Donations', '« Back']);
    expect(parseReceiptTap(`cz:rc:pa:${p.id}:1:${UUID(2)}`)).toEqual({ kind: 'parent', id: p.id, n: 1, categoryId: UUID(2) });
    const home = renderCategoryPicker(p, 1, CATS, UUID(2)).keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(home).toEqual(['Just Home', 'Lamps & Lighting', '« Back']);
  });

  it('page through a long receipt', () => {
    const many = { ...p, items: Array.from({ length: 10 }, (_, n) => ({ text: `ITEM ${n}`, cents: 100, categoryId: UUID(1) })) };
    const first = renderItemPicker(many, CATS, 0).keyboard.inline_keyboard;
    expect(first.at(-1)!.map((b) => b.text)).toEqual(['« Back', 'Next ›']);
    expect(renderItemPicker(many, CATS, 1).keyboard.inline_keyboard).toHaveLength(3);
  });

  it('refuses data that is not this flow\'s or is damaged', () => {
    expect(['cz:ok:x', 'cz:rc:', 'cz:rc:ok:', 'cz:rc:ch:id:x', 'cz:rc:set:id:1', 'cz:rc:zz:id'].map(parseReceiptTap)).toEqual([null, null, null, null, null, null]);
  });
});

describe('the writes', () => {
  const row = (over: Partial<SpendRow>): SpendRow => ({
    id: 'a1', date: '2027-03-15T12:00:00+00:00', accountId: 'card', accountName: 'Card', accountType: 'CREDIT_CARD',
    type: 'WITHDRAWAL', subtype: '', groupId: '', absCents: 10200, notes: '', filings: [], splits: [], ...over,
  });

  it('matches the card charge by amount, account and date, and skips one already split', () => {
    const rows = [
      row({}),
      row({ id: 'late', date: `2027-03-${14 + CHARGE_WINDOW_DAYS + 1}T12:00:00+00:00` }),
      row({ id: 'split', splits: [{ categoryId: 'c', absCents: 10200 }] }),
      row({ id: 'other-amount', absCents: 10201 }),
      row({ id: 'deposit', type: 'DEPOSIT' }),
      row({ id: 'brokerage', accountType: 'SECURITIES' }),
      row({ id: 'not-spending', accountId: 'elsewhere' }),
    ];
    expect(matchingCharges(rows, 10200, '2027-03-14', ['card']).map((r) => r.id)).toEqual(['a1']);
    expect(matchingCharges(rows, 10200, '2027-03-14', null).map((r) => r.id)).toEqual(['a1', 'not-spending']);
  });

  it('splits the card payment into exact decimal lines that add up to the charge', () => {
    const [, card] = proposalRowsByPayment(proposal());
    const lines = splitLines(card);
    expect(lines.reduce((s, l) => s + Math.round(Number(l.amount) * 100), 0)).toBe(10200);
    expect(lines.every((l) => /^\d+\.\d{2}$/.test(l.amount) && l.taxonomyId === 'spending_categories')).toBe(true);
    expect(lines[0].note).toBe('BREAD');
  });

  it('adds one withdrawal per category for the gift card, dated on the receipt', () => {
    const [gift] = proposalRowsByPayment(proposal());
    const writes = giftCardWrites(proposal(), gift, 'gift-acct', 'USD');
    expect(writes.reduce((s, w) => s + Math.round((w.amount ?? 0) * 100), 0)).toBe(4000);
    expect(writes[0]).toMatchObject({ accountId: 'gift-acct', activityType: 'WITHDRAWAL', symbol: { symbol: '$CASH-USD' }, currency: 'USD', comment: 'Corner Market: BREAD' });
    expect(writes[0].activityDate.startsWith('2027-03-14')).toBe(true);
  });
});
