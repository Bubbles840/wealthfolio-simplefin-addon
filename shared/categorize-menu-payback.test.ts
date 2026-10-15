import { describe, it, expect } from 'vitest';
import {
  applyTap, renderScreen, type CategorizeTxn, type MenuAction, type MenuScreen, type MenuSession, type SpendingCategory,
} from './categorize-menu.js';
import { PAYBACK_PICK, PAYBACK_SWITCH } from './payback-copy.js';

const FOOD: SpendingCategory = { id: 'cat-food', name: 'Food & Dining', parentId: null, parentName: null };
const REST: SpendingCategory = { id: 'cat-rest', name: 'Restaurants', parentId: 'cat-food', parentName: 'Food & Dining' };
const FUN: SpendingCategory = { id: 'cat-fun', name: 'Entertainment', parentId: null, parentName: null };
const SALARY: SpendingCategory = { id: 'inc-sal', name: 'Salary', parentId: null, parentName: null };

const deposit = (over: Partial<CategorizeTxn> = {}): CategorizeTxn => ({
  activityId: 'act-7', date: '2026-10-09', amountCents: 1400, description: 'VENMO CASHOUT', accountName: 'PNC Checking',
  accountId: 'wf-chk', direction: 'in', incomeEligible: true, activityType: 'DEPOSIT', pending: false, ...over,
});
const session = (screen: MenuScreen, over: Partial<MenuSession> = {}): MenuSession => ({
  txns: [deposit()], categories: [FOOD, REST, FUN], incomeCategories: [SALARY], screen, buttons: [], generation: 7, mode: 'categorize', ...over,
});
const view = (s: MenuSession) => {
  const r = renderScreen(s);
  const labels = r.keyboard.inline_keyboard.flat().map((b) => b.text);
  const action = (label: string): MenuAction => r.buttons[labels.indexOf(label)];
  return { ...r, labels, action };
};
const maxBytes = (s: MenuSession) => Math.max(...renderScreen(s).keyboard.inline_keyboard.flat()
  .map((b) => new TextEncoder().encode(b.callback_data).length));

describe('the payback switch is for a non-pending DEPOSIT only (Task 6 m1)', () => {
  it.each([
    ['an INTEREST row', { activityType: 'INTEREST' }],
    ['an INCOME row', { activityType: 'INCOME' }],
    ['a DIVIDEND row', { activityType: 'DIVIDEND' }],
    ['a pending DEPOSIT', { pending: true }],
  ] as Array<[string, Partial<CategorizeTxn>]>)('%s sees the income grid and no switch', (_n, over) => {
    const v = view(session({ kind: 'txn', activityId: 'act-7' }, { txns: [deposit(over)] }));
    expect(v.labels).toContain('Salary');
    expect(v.labels).not.toContain(PAYBACK_SWITCH);
    expect(v.labels).not.toContain('« Income categories');
  });

  it('shows such a row the spending grid as before, with no payback wording, when there are no income categories', () => {
    const v = view(session({ kind: 'txn', activityId: 'act-7' }, { incomeCategories: [], txns: [deposit({ activityType: 'INTEREST' })] }));
    expect(v.text).not.toContain(PAYBACK_PICK);
    expect(v.action('Entertainment')).toEqual({ kind: 'assign', activityId: 'act-7', categoryId: 'cat-fun' });
  });
});

describe('the payback grid (W6)', () => {
  it('offers "It’s a payback »" beside a deposit’s income grid', () => {
    const v = view(session({ kind: 'txn', activityId: 'act-7' }));
    expect(PAYBACK_SWITCH).toBe("It's a payback »");
    expect(v.labels).toContain(PAYBACK_SWITCH);
    expect(v.labels).not.toContain('Spending categories »');
    expect(v.action(PAYBACK_SWITCH)).toEqual({ kind: 'goto', screen: { kind: 'txn', activityId: 'act-7', showSpending: true } });
  });

  it('files every spending category there as a payback, and says what the grid is for', () => {
    const v = view(session({ kind: 'txn', activityId: 'act-7', showSpending: true }));
    expect(v.text).toBe(`VENMO CASHOUT\n+$14 · Oct 9 · PNC Checking\n${PAYBACK_PICK}`);
    expect(v.action('Entertainment')).toEqual({ kind: 'payback', activityId: 'act-7', categoryId: 'cat-fun' });
    expect(v.action('Food & Dining')).toEqual({ kind: 'goto', screen: { kind: 'subcats', activityId: 'act-7', parentId: 'cat-food', payback: true } });
    expect(v.action('« Income categories')).toEqual({ kind: 'goto', screen: { kind: 'txn', activityId: 'act-7' } });
  });

  it('keeps a payback a payback one level down, and Back returns to the payback grid', () => {
    const v = view(session({ kind: 'subcats', activityId: 'act-7', parentId: 'cat-food', payback: true }));
    expect(v.action('Restaurants')).toEqual({ kind: 'payback', activityId: 'act-7', categoryId: 'cat-rest' });
    expect(v.action('Just Food & Dining itself')).toEqual({ kind: 'payback', activityId: 'act-7', categoryId: 'cat-food' });
    expect(v.action('‹ Back')).toEqual({ kind: 'goto', screen: { kind: 'txn', activityId: 'act-7', showSpending: true } });
  });

  it('gives a deposit the payback grid straight away when there is no income grid', () => {
    const v = view(session({ kind: 'txn', activityId: 'act-7' }, { incomeCategories: [] }));
    expect(v.labels).not.toContain(PAYBACK_SWITCH);
    expect(v.action('Entertainment')).toEqual({ kind: 'payback', activityId: 'act-7', categoryId: 'cat-fun' });
  });

  it('never offers the one-tap guess there: every tap goes through the payback', () => {
    const v = view(session({ kind: 'txn', activityId: 'act-7', showSpending: true }, {
      txns: [deposit({ guess: { categoryId: 'cat-fun', name: 'Entertainment', count: 3 } })],
    }));
    expect(v.labels.some((l) => l.startsWith('✓'))).toBe(false);
  });

  it('leaves money out, a card credit and /recategorize filing as before', () => {
    const out = view(session({ kind: 'txn', activityId: 'act-7' }, { txns: [deposit({ direction: 'out', incomeEligible: false })] }));
    expect(out.action('Entertainment')).toEqual({ kind: 'assign', activityId: 'act-7', categoryId: 'cat-fun' });
    expect(out.text).not.toContain(PAYBACK_PICK);
    const card = view(session({ kind: 'txn', activityId: 'act-7' }, { txns: [deposit({ incomeEligible: false })] }));
    expect(card.action('Entertainment')).toEqual({ kind: 'assign', activityId: 'act-7', categoryId: 'cat-fun' });
    const recat = view(session({ kind: 'txn', activityId: 'act-7' }, {
      mode: 'recategorize', txns: [deposit({ currentCategory: { taxonomyId: 'income_sources', categoryId: 'inc-sal', name: 'Salary' } })],
    }));
    expect(recat.action('Entertainment')).toEqual({ kind: 'reassign', activityId: 'act-7', categoryId: 'cat-fun' });
  });

  it('resolves a tap on a payback button', () => {
    const s = session({ kind: 'txn', activityId: 'act-7', showSpending: true });
    const r = renderScreen(s);
    s.buttons = r.buttons;
    const fun = r.keyboard.inline_keyboard.flat().find((b) => b.text === 'Entertainment')!;
    expect(applyTap(s, fun.callback_data)).toEqual({ ok: true, action: { kind: 'payback', activityId: 'act-7', categoryId: 'cat-fun' } });
  });
});

describe('the payback’s outcome', () => {
  it('shows the runner’s words, escaped, then the way on', () => {
    const v = view(session({
      kind: 'paybackResult', activityId: 'act-7', categoryId: 'cat-rest', offerRules: false,
      text: 'Filed as a payback under Dine_Out — it takes $14 off your Food & Dining spending.\nUndo it from /changes.',
    }));
    expect(v.text).toBe('Filed as a payback under Dine\\_Out — it takes $14 off your Food & Dining spending.\nUndo it from /changes.');
    expect(v.labels).toEqual(['Next transaction', 'Done']);
  });

  it('shows a refusal with Back to the payback grid', () => {
    const v = view(session({ kind: 'paybackRefused', activityId: 'act-7', text: "It's still pending — file it as a payback once it posts." }));
    expect(v.text).toBe("It's still pending — file it as a payback once it posts.");
    expect(v.action('‹ Back')).toEqual({ kind: 'goto', screen: { kind: 'txn', activityId: 'act-7', showSpending: true } });
  });

  it('keeps every button within 64 bytes, at any generation', () => {
    for (const screen of [
      { kind: 'txn', activityId: 'act-7', showSpending: true },
      { kind: 'subcats', activityId: 'act-7', parentId: 'cat-food', payback: true },
      { kind: 'paybackResult', activityId: 'act-7', categoryId: 'cat-rest', offerRules: true, text: 'x' },
      { kind: 'paybackRefused', activityId: 'act-7', text: 'x' },
    ] as MenuScreen[]) {
      expect(maxBytes(session(screen, { generation: Number.MAX_SAFE_INTEGER }))).toBeLessThanOrEqual(64);
    }
  });
});

describe('the list shows an amount as the reply does (PB-B cosmetic)', () => {
  it('keeps the cents of a $14.50 deposit on the list and on its own screen — never "$15"', () => {
    const s = session({ kind: 'list', page: 0 }, { txns: [deposit({ amountCents: 1450 })] });
    expect(view(s).labels[0]).toBe('Oct 9 · VENMO CASHOUT · +$14.50');
    expect(view({ ...s, screen: { kind: 'txn', activityId: 'act-7' } }).text).toContain('+$14.50 · Oct 9');
  });

  it('still drops the cents of a whole amount', () => {
    expect(view(session({ kind: 'list', page: 0 })).labels[0]).toBe('Oct 9 · VENMO CASHOUT · +$14');
  });
});
