import { describe, it, expect } from 'vitest';
import type { PaybackBreadth } from './payback.js';
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

  const preview = (breadth?: PaybackBreadth, txns?: CategorizeTxn[]) =>
    view(session({ kind: 'paybackRulePreview', activityId: 'act-7', categoryId: 'cat-rest', ...(breadth ? { breadth } : {}) }, txns));

  it('previews both rules, escaped, and the breadth the ledger found: filed and waiting, from today on (I1)', () => {
    const v = preview({ ok: true, filed: 2, waiting: 1 });
    expect(v.text).toBe([
      'Make every VENMO CASHOUT deposit a payback?',
      'From today on, money into PNC\\_Checking whose description contains "VENMO CASHOUT" becomes a payback under Restaurants (Food & Dining): '
        + 'the sync marks it when it imports, and Wealthfolio files it. Deposits already in your ledger are not changed. Undo either rule from /changes.',
      'In the last 90 days, 3 deposits here read that way: 2 already in your ledger, 1 waiting for a category. File the waiting ones one by one with It\'s a payback ».',
    ].join('\n'));
    expect(v.action('Create both rules')).toEqual({ kind: 'paybackRules', activityId: 'act-7', categoryId: 'cat-rest' });
    expect(v.labels).toEqual(['Create both rules', '‹ Back to list']);
  });

  it('says when no deposit in the last 90 days reads that way, and when the ledger could not be read', () => {
    expect(preview({ ok: true, filed: 0, waiting: 0 }).text.split('\n')[2]).toBe('No deposit in the last 90 days reads that way.');
    expect(preview().text.split('\n')).toHaveLength(2);
  });

  it('shows why a refused breadth was refused, with nothing to create (I1/I2)', () => {
    const v = preview({ ok: false, message: 'That description is only common bank words (like DEPOSIT or ACH), so a rule on it would catch things that aren\'t paybacks — nothing was changed.' });
    expect(v.text).toContain('only common bank words');
    expect(v.labels).toEqual(['‹ Back to list']);
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
