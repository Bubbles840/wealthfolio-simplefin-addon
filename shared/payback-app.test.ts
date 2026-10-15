import { describe, it, expect } from 'vitest';
import * as copy from './payback-copy.js';
import {
  PAYBACK_APP_ACTION, PAYBACK_APP_UNDO_HINT, PAYBACK_PICK, PAYBACK_UNAVAILABLE, PAYBACK_UPDATE_COMPANION,
  paybackAlreadyFiled, paybackFiledFirst, paybackLeftoverRule, paybackOnceName,
} from './payback-copy.js';
import {
  appPaybackGate, leftoverPaybackKeys, PAYBACK_ONCE_PRIORITY, paybackCategoriesOf, paybackOfferedInStory, paybackOnceKey, paybackOnceRule,
  paybackPickList, type ListedRule,
} from './payback-app.js';
import type { TxStoryFacts } from './tx-story.js';

const EMOJI = /\p{Extended_Pictographic}/u;
const ONE_OFF: ListedRule = {
  name: 'Payback (one-off) — VENMO CASHOUT', pattern: 'VENMO CASHOUT · TRN-77', accountId: 'wf-chk', activityType: 'CREDIT', priority: 1_000_000,
};

describe('the one-off filing rule', () => {
  it('matches only this row once it is a CREDIT: its exact note, its account, far above every other rule', () => {
    expect(paybackOnceRule({ accountId: 'wf-chk', notes: 'VENMO CASHOUT · TRN-77' }, 'cat-rest')).toEqual({
      ruleKey: 'payback-once:wf-chk:TRN-77',
      name: 'Payback (one-off) — VENMO CASHOUT',
      pattern: 'VENMO CASHOUT · TRN-77',
      matchType: 'exact',
      kind: 'expense',
      categoryId: 'cat-rest',
      activityType: 'CREDIT',
      accountId: 'wf-chk',
      priority: 1_000_000,
    });
  });

  it('is named by its tx id when the bank gave no words', () => {
    expect(paybackOnceRule({ accountId: 'wf-chk', notes: ' · TRN-77' }, 'cat-rest')?.name).toBe('Payback (one-off) — TRN-77');
  });

  it('has none for a row whose note carries no tx id', () => {
    expect(paybackOnceRule({ accountId: 'wf-chk', notes: 'Cash deposit' }, 'cat-rest')).toBeNull();
  });

  it("outranks W10's rules (50) and stays within Wealthfolio's 32-bit priority", () => {
    expect(PAYBACK_ONCE_PRIORITY).toBeGreaterThan(50);
    expect(PAYBACK_ONCE_PRIORITY).toBeLessThanOrEqual(2 ** 31 - 1);
  });
});

describe('the leftover sweep', () => {
  it('rebuilds the key of each one-off rule left in Wealthfolio from its account and the tx id in its pattern, once', () => {
    expect(leftoverPaybackKeys([
      ONE_OFF,
      { ...ONE_OFF, name: 'Payback (one-off) — ZELLE FROM SAM', pattern: 'ZELLE FROM SAM · TRN-9', accountId: 'wf-sav' },
      { ...ONE_OFF, name: 'renamed in Wealthfolio' },
    ])).toEqual([paybackOnceKey('wf-chk', 'TRN-77'), paybackOnceKey('wf-sav', 'TRN-9')]);
  });

  it.each<[string, ListedRule]>([
    ['a rule at another priority', { ...ONE_OFF, priority: 50 }],
    ['a rule for another type', { ...ONE_OFF, activityType: 'WITHDRAWAL' }],
    ['a rule for every account', { ...ONE_OFF, accountId: null }],
    ['a pattern with no tx id', { ...ONE_OFF, pattern: 'VENMO' }],
    ['a rule with no pattern', { ...ONE_OFF, pattern: undefined }],
  ])('leaves %s alone', (_name, rule) => {
    expect(leftoverPaybackKeys([rule])).toEqual([]);
  });
});

describe('the gate (W11)', () => {
  it.each<[string, boolean, string | null, string | null]>([
    ['a 3.9 host and a 1.62 companion', true, '1.62.0', null],
    ['a newer companion', true, '1.70.1', null],
    ['no companion at all: nothing could undo it', true, null, PAYBACK_UNAVAILABLE],
    ['a 1.61 companion, which turns a payback back into a deposit', true, '1.61.0', PAYBACK_UPDATE_COMPANION],
    ['a companion version it cannot read', true, 'garbage', PAYBACK_UPDATE_COMPANION],
    ['a 3.8 host, which has no facts to confirm the filing', false, '1.62.0', PAYBACK_UNAVAILABLE],
  ])('%s', (_name, hostOffersFacts, companionVersion, expected) => {
    expect(appPaybackGate({ hostOffersFacts, companionVersion })).toBe(expected);
  });
});

describe('the categories', () => {
  const RAW: unknown[] = [
    { kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-rest', key: 'restaurants', name: 'Restaurants', path: 'Food & Dining / Restaurants' },
    { kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-food', key: 'food', name: 'Food & Dining', path: 'Food & Dining' },
    { kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-open', key: 'opening', name: 'Opening balances', path: 'Opening balances' },
    { kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-book', key: 'book', name: 'Sync bookkeeping', path: 'Sync bookkeeping' },
    { kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-auto', key: 'auto', name: 'Auto', path: '' },
    { kind: 'income', taxonomyId: 'income_categories', categoryId: 'cat-gift', key: 'gifts', name: 'Gifts', path: 'Gifts' },
    { kind: 'expense', categoryId: '', name: 'broken' },
    'nonsense',
  ];

  it('reads each with its parent, whose spending a payback comes off', () => {
    const cats = paybackCategoriesOf(RAW);
    expect(cats.map((c) => c.id)).toEqual(['cat-rest', 'cat-food', 'cat-open', 'cat-book', 'cat-auto', 'cat-gift']);
    expect(cats[0]).toEqual({ id: 'cat-rest', name: 'Restaurants', parentName: 'Food & Dining', path: 'Food & Dining / Restaurants', kind: 'expense' });
    expect(cats[1].parentName).toBeNull();
    expect(cats[4]).toMatchObject({ path: 'Auto', parentName: null });
  });

  it("offers only spending categories, by path, without the add-on's own bookkeeping ones", () => {
    expect(paybackPickList(paybackCategoriesOf(RAW)).map((c) => c.path)).toEqual(['Auto', 'Food & Dining', 'Food & Dining / Restaurants']);
  });

  it('reads nothing from something that is not a list', () => {
    expect(paybackCategoriesOf(null)).toEqual([]);
    expect(paybackCategoriesOf({ items: [] })).toEqual([]);
  });
});

describe("the story's offer", () => {
  const base: TxStoryFacts = {
    row: { activityId: 'act-7', note: 'VENMO CASHOUT · TRN-77', absCents: 1400, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking', accountType: 'CASH' },
    feed: { sfinAccountId: 'sfin-chk' },
    partner: null,
    category: null,
    overrides: [],
  };
  const row = (over: Partial<TxStoryFacts['row']>) => ({ ...base, row: { ...base.row, ...over } });

  it('is made on a posted deposit from the bank feed that Wealthfolio says is filed nowhere', () => {
    expect(paybackOfferedInStory(base)).toBe(true);
  });

  it("is not made without Wealthfolio's word that it is filed nowhere (a 3.8 host), even from the needs-a-category list", () => {
    const { category: _none, ...noFact } = base;
    expect(paybackOfferedInStory({ ...noFact, needsCategory: true })).toBe(false);
    expect(paybackOfferedInStory(noFact)).toBe(false);
  });

  it.each<[string, TxStoryFacts]>([
    ['a row filed already', { ...base, category: { name: 'Gifts' } }],
    ['a withdrawal', row({ activityType: 'WITHDRAWAL' })],
    ['a payback already', row({ activityType: 'CREDIT' })],
    ['a card', row({ accountType: 'CREDIT_CARD' })],
    ['an account of unknown type', row({ accountType: undefined })],
    ['a pending row', row({ note: 'VENMO CASHOUT · TRN-77 · pending' })],
    ['a row not from the bank feed', { ...base, feed: null }],
    ['a row the sync manages', row({ note: 'Starting balance · 2026-10-01' })],
    ['$0', row({ absCents: 0 })],
    ['half of a transfer', { ...base, partner: { accountName: 'Ally Savings' } }],
    ['a transfer it could not rule out', { ...base, partner: undefined }],
    ['a row the payback setting is on', { ...base, overrides: ['asReimbursement'] }],
    ['a story whose overrides could not be read', { ...base, failed: ['overrides'] }],
    ['a story whose mapping could not be read', { ...base, failed: ['mapping'] }],
  ])('is not made on %s', (_name, facts) => {
    expect(paybackOfferedInStory(facts)).toBe(false);
  });
});

describe("the app's words", () => {
  it('are the rulings’ own, and the picker reuses Telegram’s heading', () => {
    expect(PAYBACK_APP_ACTION).toBe("It's a payback…");
    expect(PAYBACK_PICK).toBe('Pick the spending it pays you back for.');
    expect(paybackOnceName('VENMO CASHOUT')).toBe('Payback (one-off) — VENMO CASHOUT');
    expect(PAYBACK_APP_UNDO_HINT).toBe('Undo it from Telegram: /changes.');
    expect(paybackLeftoverRule('Payback (one-off) — VENMO CASHOUT')).toBe(
      'A one-off rule named "Payback (one-off) — VENMO CASHOUT" is still in Wealthfolio\'s rules; delete it there if it stays.',
    );
    expect(paybackFiledFirst('Groceries')).toBe("Wealthfolio filed it under Groceries first — it's a payback there; move it in Wealthfolio if that's wrong.");
    expect(paybackAlreadyFiled('Gifts')).toBe("It's filed under Gifts already — take that off in Wealthfolio first.");
  });

  it('carry no emoji', () => {
    const said = [
      copy.PAYBACK_APP_ACTION, copy.PAYBACK_APP_FILE, copy.PAYBACK_APP_CANCEL, copy.PAYBACK_APP_CATEGORY_LABEL, copy.PAYBACK_APP_CHOOSE,
      copy.PAYBACK_APP_LOADING, copy.PAYBACK_APP_CATEGORIES_FAILED, copy.PAYBACK_APP_UNDO_HINT, copy.PAYBACK_UPDATE_COMPANION,
      copy.PAYBACK_COMPANION_UNKNOWN, copy.PAYBACK_NOT_IN_SPENDING, copy.PAYBACK_RULE_REFUSED, copy.PAYBACK_APP_UPDATE_STUCK,
      copy.PAYBACK_APP_UPDATE_UNSURE, copy.PAYBACK_APP_SETTING_HINT, copy.paybackOnceName('VENMO'), copy.paybackLeftoverRule('x'),
      copy.paybackFiledFirst('x'), copy.paybackAlreadyFiled('x'), copy.paybackAppUnfiled('x'), copy.paybackAppUnsure('x'),
    ];
    expect(said.filter((s) => EMOJI.test(s))).toEqual([]);
  });
});
