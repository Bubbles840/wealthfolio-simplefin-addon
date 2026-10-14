import { describe, it, expect } from 'vitest';
import { renderScreen, type CategorizeTxn, type MenuAction, type MenuScreen, type MenuSession, type SpendingCategory } from './categorize-menu.js';

const FOOD: SpendingCategory = { id: 'cat-food', name: 'Food & Dining', parentId: null, parentName: null };
const REST: SpendingCategory = { id: 'cat-rest', name: 'Restaurants', parentId: 'cat-food', parentName: 'Food & Dining' };
const deposit = (activityId: string, description: string, over: Partial<CategorizeTxn> = {}): CategorizeTxn => ({
  activityId, date: '2026-10-09', amountCents: 1400, description, accountName: 'PNC_Checking', accountId: 'wf-chk',
  direction: 'in', incomeEligible: true, ...over,
});
const FILED = 'Filed as a payback under Restaurants — it takes $14 off your Food & Dining spending.\nUndo it from /changes.';
const session = (screen: MenuScreen, txns: CategorizeTxn[] = [deposit('act-7', 'VENMO CASHOUT · Venmo: Dinner')]): MenuSession => ({
  txns, categories: [FOOD, REST], screen, buttons: [], generation: 7, mode: 'categorize',
});
const view = (s: MenuSession) => {
  const r = renderScreen(s);
  const labels = r.keyboard.inline_keyboard.flat().map((b) => b.text);
  return { ...r, labels, action: (label: string): MenuAction => r.buttons[labels.indexOf(label)] };
};
const result = (offerRules: boolean): MenuScreen => ({ kind: 'paybackResult', activityId: 'act-7', categoryId: 'cat-rest', text: FILED, offerRules });

describe('"Make every … deposit a payback" (W10)', () => {
  it('is offered after a payback filed in full, named by the bank’s words', () => {
    const v = view(session(result(true)));
    expect(v.labels).toEqual(['Make every VENMO CASHOUT deposit a payback', 'Next transaction', 'Done']);
    expect(v.action('Make every VENMO CASHOUT deposit a payback'))
      .toEqual({ kind: 'goto', screen: { kind: 'paybackRulePreview', activityId: 'act-7', categoryId: 'cat-rest' } });
  });

  it('is not offered after a partial payback, nor for a row without an account', () => {
    expect(view(session(result(false))).labels).toEqual(['Next transaction', 'Done']);
    expect(view(session(result(true), [deposit('act-7', 'VENMO CASHOUT', { accountId: undefined })])).labels).toEqual(['Next transaction', 'Done']);
  });

  it('previews both rules, escaped, with how many waiting deposits they catch now', () => {
    const v = view(session({ kind: 'paybackRulePreview', activityId: 'act-7', categoryId: 'cat-rest' }, [
      deposit('act-7', 'VENMO CASHOUT · Venmo: Dinner'),
      deposit('a', 'VENMO CASHOUT 7781'),
      deposit('out', 'VENMO CASHOUT', { direction: 'out' }),
    ]));
    expect(v.text).toBe([
      'Make every VENMO CASHOUT deposit a payback?',
      'Money into PNC\\_Checking whose description contains "VENMO CASHOUT" becomes a payback under Restaurants (Food & Dining): '
        + 'the sync marks it when it imports, and Wealthfolio files it. Undo either rule from /changes.',
      'Right now that also catches 1 other deposit waiting for a category.',
    ].join('\n'));
    expect(v.action('Create both rules')).toEqual({ kind: 'paybackRules', activityId: 'act-7', categoryId: 'cat-rest' });
    expect(v.labels).toEqual(['Create both rules', '‹ Back to list']);
  });

  it('says when nothing else matches', () => {
    const v = view(session({ kind: 'paybackRulePreview', activityId: 'act-7', categoryId: 'cat-rest' }));
    expect(v.text.split('\n')[2]).toBe('Nothing else waiting for a category matches right now.');
  });

  it('shows what making them did, with no way to make them twice', () => {
    const v = view(session({ kind: 'paybackRulesResult', activityId: 'act-7', text: 'Both rules are already there — nothing was added.' }));
    expect(v.text).toBe('Both rules are already there — nothing was added.');
    expect(v.labels).toEqual(['‹ Back to list', 'Done']);
  });

  it('keeps every button within 64 bytes, at any generation', () => {
    for (const screen of [
      result(true),
      { kind: 'paybackRulePreview', activityId: 'act-7', categoryId: 'cat-rest' },
      { kind: 'paybackRulesResult', activityId: 'act-7', text: 'x' },
    ] as MenuScreen[]) {
      const s = { ...session(screen), generation: Number.MAX_SAFE_INTEGER };
      for (const b of renderScreen(s).keyboard.inline_keyboard.flat()) {
        expect(new TextEncoder().encode(b.callback_data).length).toBeLessThanOrEqual(64);
      }
    }
  });
});
