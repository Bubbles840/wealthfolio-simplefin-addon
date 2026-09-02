import { describe, it, expect } from 'vitest';
import {
  renderScreen,
  applyTap,
  parseNewRuleArgs,
  MENU_PAGE_SIZE,
  MENU_CALLBACK_PREFIX,
} from './categorize-menu';
import type { CategorizeTxn, SpendingCategory, MenuSession, MenuScreen, MenuAction } from './categorize-menu';

// ---- fixtures -------------------------------------------------------------

function txn(overrides: Partial<CategorizeTxn> = {}): CategorizeTxn {
  return {
    activityId: 'act-1',
    date: '2026-08-08',
    amountCents: -1000,
    description: 'BOOK STORES',
    accountName: 'Checking',
    ...overrides,
  };
}

const groceries: SpendingCategory = { id: 'cat-groceries', name: 'Groceries', parentId: null, parentName: null };
const dining: SpendingCategory = { id: 'cat-dining', name: 'Dining', parentId: null, parentName: null };
const diningFastFood: SpendingCategory = {
  id: 'cat-dining-fastfood',
  name: 'Fast Food',
  parentId: 'cat-dining',
  parentName: 'Dining',
};
const diningCoffee: SpendingCategory = {
  id: 'cat-dining-coffee',
  name: 'Coffee',
  parentId: 'cat-dining',
  parentName: 'Dining',
};

function session(overrides: Partial<MenuSession> = {}): MenuSession {
  return {
    txns: [txn()],
    categories: [groceries, dining, diningFastFood, diningCoffee],
    screen: { kind: 'list', page: 0 },
    buttons: [],
    // Any non-zero value would do; a fixed one keeps the tokens below readable.
    generation: 7,
    // Defaulted to the long-standing behaviour so every test written before
    // recategorize existed keeps exercising exactly what it always did.
    mode: 'categorize',
    ...overrides,
  };
}

// Every callback_data must byte-fit under Telegram's 64-byte cap. Checked with
// TextEncoder (not .length) because a name with multi-byte characters would
// under-count on .length — though here it's ASCII, this is the honest way to
// measure what Telegram actually caps.
function assertCallbackBytesFit(keyboard: { inline_keyboard: Array<Array<{ callback_data: string }>> }) {
  for (const row of keyboard.inline_keyboard) {
    for (const button of row) {
      const bytes = new TextEncoder().encode(button.callback_data).length;
      expect(bytes).toBeLessThanOrEqual(64);
    }
  }
}

// ---- renderScreen: list ----------------------------------------------------

describe('renderScreen — list', () => {
  it('empty list renders the fixed empty-state text and only a Done button', () => {
    const s = session({ txns: [] });
    const { text, keyboard } = renderScreen(s);
    expect(text).toBe('Nothing needs a category right now.');
    expect(keyboard.inline_keyboard).toEqual([[{ text: 'Done', callback_data: `${MENU_CALLBACK_PREFIX}7:0` }]]);
  });

  it('renders one row per transaction as date · description · amount', () => {
    const s = session({ txns: [txn({ date: '2026-08-08', description: 'BOOK STORES', amountCents: -1000 })] });
    const { keyboard, buttons } = renderScreen(s);
    const rowLabel = keyboard.inline_keyboard[0][0].text;
    expect(rowLabel).toBe('Aug 8 · BOOK STORES · -$10');
    expect(buttons[0]).toEqual({ kind: 'goto', screen: { kind: 'txn', activityId: 'act-1' } });
  });

  it('short-formats the date from the raw YYYY-MM-DD string (no Date parsing)', () => {
    const s = session({ txns: [txn({ date: '2026-01-31' })] });
    const { keyboard } = renderScreen(s);
    expect(keyboard.inline_keyboard[0][0].text).toContain('Jan 31');
  });

  it('Done is always present and closes the menu', () => {
    const s = session();
    const { keyboard, buttons } = renderScreen(s);
    const doneIndex = keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Done');
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    expect(buttons[doneIndex]).toEqual({ kind: 'close' });
  });

  it('shows only More » (no Prev) on the first of several pages', () => {
    const txns = Array.from({ length: MENU_PAGE_SIZE + 2 }, (_, i) => txn({ activityId: `act-${i}`, date: '2026-08-08' }));
    const s = session({ txns, screen: { kind: 'list', page: 0 } });
    const { keyboard } = renderScreen(s);
    const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain('More »');
    expect(labels).not.toContain('« Prev');
    // exactly MENU_PAGE_SIZE row buttons on this page
    expect(keyboard.inline_keyboard.filter((row) => row.length === 1 && row[0].text.includes('·')).length).toBe(MENU_PAGE_SIZE);
  });

  it('shows only « Prev (no More) on the last page', () => {
    const txns = Array.from({ length: MENU_PAGE_SIZE + 2 }, (_, i) => txn({ activityId: `act-${i}`, date: '2026-08-08' }));
    const s = session({ txns, screen: { kind: 'list', page: 1 } });
    const { keyboard } = renderScreen(s);
    const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain('« Prev');
    expect(labels).not.toContain('More »');
  });

  it('neither paging button appears when everything fits on one page', () => {
    const s = session({ txns: [txn()] });
    const { keyboard } = renderScreen(s);
    const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).not.toContain('More »');
    expect(labels).not.toContain('« Prev');
  });
});

// ---- renderScreen: txn -----------------------------------------------------

describe('renderScreen — txn', () => {
  it('shows description, amount, date, and account in the text', () => {
    const s = session({
      txns: [txn({ description: 'BOOK STORES', amountCents: -1000, date: '2026-08-08', accountName: 'Checking' })],
      screen: { kind: 'txn', activityId: 'act-1' },
    });
    const { text } = renderScreen(s);
    expect(text).toContain('BOOK STORES');
    expect(text).toContain('-$10');
    expect(text).toContain('Aug 8');
    expect(text).toContain('Checking');
  });

  it('lays out parent categories two per row', () => {
    const s = session({ screen: { kind: 'txn', activityId: 'act-1' } });
    const { keyboard } = renderScreen(s);
    // Two parents (Groceries, Dining) -> one row of two buttons.
    const categoryRow = keyboard.inline_keyboard.find((row) => row.some((b) => b.text === 'Groceries'));
    expect(categoryRow).toBeDefined();
    expect(categoryRow!.length).toBe(2);
    expect(categoryRow!.map((b) => b.text)).toEqual(['Groceries', 'Dining']);
  });

  it('a parent with children goes to the subcats screen', () => {
    const s = session({ screen: { kind: 'txn', activityId: 'act-1' } });
    const { keyboard, buttons } = renderScreen(s);
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Dining');
    expect(buttons[idx]).toEqual({
      kind: 'goto',
      screen: { kind: 'subcats', activityId: 'act-1', parentId: 'cat-dining' },
    });
  });

  it('a parent with no children assigns directly', () => {
    const s = session({ screen: { kind: 'txn', activityId: 'act-1' } });
    const { keyboard, buttons } = renderScreen(s);
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Groceries');
    expect(buttons[idx]).toEqual({ kind: 'assign', activityId: 'act-1', categoryId: 'cat-groceries' });
  });

  it('has a Keep uncategorized button that dismisses', () => {
    const s = session({ screen: { kind: 'txn', activityId: 'act-1' } });
    const { keyboard, buttons } = renderScreen(s);
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Keep uncategorized');
    expect(buttons[idx]).toEqual({ kind: 'dismiss', activityId: 'act-1' });
  });

  it('has a « Back button that returns to the list', () => {
    const s = session({ screen: { kind: 'txn', activityId: 'act-1' } });
    const { keyboard, buttons } = renderScreen(s);
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === '« Back');
    expect(buttons[idx]).toEqual({ kind: 'goto', screen: { kind: 'list', page: 0 } });
  });

  it('falls back to the list when the transaction is no longer present', () => {
    const s = session({ txns: [], screen: { kind: 'txn', activityId: 'gone' } });
    const { text, keyboard } = renderScreen(s);
    expect(text.split('\n')[0]).toBe('That transaction is no longer uncategorized.');
    expect(keyboard.inline_keyboard).toEqual([[{ text: 'Done', callback_data: `${MENU_CALLBACK_PREFIX}7:0` }]]);
  });
});

// ---- renderScreen: subcats --------------------------------------------------

describe('renderScreen — subcats', () => {
  const subcatsScreen: MenuScreen = { kind: 'subcats', activityId: 'act-1', parentId: 'cat-dining' };

  it('lists the parent’s children as assign buttons', () => {
    const s = session({ screen: subcatsScreen });
    const { keyboard, buttons } = renderScreen(s);
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Fast Food');
    expect(buttons[idx]).toEqual({ kind: 'assign', activityId: 'act-1', categoryId: 'cat-dining-fastfood' });
    const idx2 = keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Coffee');
    expect(buttons[idx2]).toEqual({ kind: 'assign', activityId: 'act-1', categoryId: 'cat-dining-coffee' });
  });

  it('offers "Just <parent> itself" which assigns the parent', () => {
    const s = session({ screen: subcatsScreen });
    const { keyboard, buttons } = renderScreen(s);
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Just Dining itself');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(buttons[idx]).toEqual({ kind: 'assign', activityId: 'act-1', categoryId: 'cat-dining' });
  });

  it('« Back returns to the txn screen', () => {
    const s = session({ screen: subcatsScreen });
    const { keyboard, buttons } = renderScreen(s);
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === '« Back');
    expect(buttons[idx]).toEqual({ kind: 'goto', screen: { kind: 'txn', activityId: 'act-1' } });
  });

  it('falls back to the list when the parent category is gone', () => {
    const s = session({ screen: { kind: 'subcats', activityId: 'act-1', parentId: 'nonexistent' } });
    const { text } = renderScreen(s);
    expect(text.split('\n')[0]).toBe('That transaction is no longer uncategorized.');
  });
});

// ---- renderScreen: filed ----------------------------------------------------

describe('renderScreen — filed', () => {
  const filedScreen: MenuScreen = { kind: 'filed', activityId: 'act-1', categoryId: 'cat-groceries', undone: false };

  it('confirms the filing with the exact "Filed X → Y." wording', () => {
    const s = session({
      txns: [txn({ description: 'BOOK STORES' })],
      screen: filedScreen,
    });
    const { text } = renderScreen(s);
    expect(text).toBe('Filed BOOK STORES → Groceries.');
  });

  it('offers Undo, Make this a rule, Next transaction, and Done', () => {
    const s = session({ screen: filedScreen });
    const { keyboard, buttons } = renderScreen(s);
    const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toEqual(['Undo', 'Make this a rule', 'Next transaction', 'Done']);

    const undo = buttons[keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Undo')];
    expect(undo).toEqual({ kind: 'unassign', activityId: 'act-1', categoryId: 'cat-groceries' });

    const rule = buttons[keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Make this a rule')];
    expect(rule).toEqual({
      kind: 'goto',
      screen: { kind: 'rulePreview', activityId: 'act-1', categoryId: 'cat-groceries' },
    });

    const next = buttons[keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Next transaction')];
    expect(next).toEqual({ kind: 'goto', screen: { kind: 'list', page: 0 } });

    const done = buttons[keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Done')];
    expect(done).toEqual({ kind: 'close' });
  });

  it('after undo, states the filing was undone and offers only Back to list / Done', () => {
    const s = session({
      txns: [txn({ description: 'BOOK STORES' })],
      screen: { kind: 'filed', activityId: 'act-1', categoryId: 'cat-groceries', undone: true },
    });
    const { text, keyboard } = renderScreen(s);
    expect(text).toBe('Filing undone — BOOK STORES is uncategorized again.');
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['Back to list', 'Done']);
  });

  it('escapes Markdown specials in the description and category name', () => {
    const s = session({
      txns: [txn({ description: 'A*B_C' })],
      categories: [{ id: 'cat-groceries', name: 'Foo_Bar', parentId: null, parentName: null }],
      screen: filedScreen,
    });
    const { text } = renderScreen(s);
    expect(text).toBe('Filed A\\*B\\_C → Foo\\_Bar.');
  });
});

// ---- renderScreen: dismissed -------------------------------------------------

describe('renderScreen — dismissed', () => {
  const dismissedScreen: MenuScreen = { kind: 'dismissed', activityId: 'act-1', undone: false };

  it('states the transaction will stay uncategorized', () => {
    const s = session({ txns: [txn({ description: 'BOOK STORES' })], screen: dismissedScreen });
    const { text } = renderScreen(s);
    expect(text).toBe('BOOK STORES will stay uncategorized.');
  });

  it('offers Undo, Back to list, Done', () => {
    const s = session({ screen: dismissedScreen });
    const { keyboard, buttons } = renderScreen(s);
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['Undo', 'Back to list', 'Done']);
    const undo = buttons[keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Undo')];
    expect(undo).toEqual({ kind: 'undismiss', activityId: 'act-1' });
  });

  it('mirrors filed’s undone wording and buttons', () => {
    const s = session({
      txns: [txn({ description: 'BOOK STORES' })],
      screen: { kind: 'dismissed', activityId: 'act-1', undone: true },
    });
    const { text, keyboard } = renderScreen(s);
    expect(text).toBe('Dismissal undone — BOOK STORES is uncategorized again.');
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['Back to list', 'Done']);
  });
});

// ---- renderScreen: rulePreview / freeRulePreview (locked copy) --------------

describe('renderScreen — rulePreview', () => {
  const ruleScreen: MenuScreen = { kind: 'rulePreview', activityId: 'act-1', categoryId: 'cat-groceries' };

  it('renders the exact locked rule-preview copy', () => {
    const s = session({ txns: [txn({ description: 'BOOK STORES' })], screen: ruleScreen });
    const { text } = renderScreen(s);
    expect(text).toBe(
      'Create this rule?\n'
      + 'Descriptions containing "BOOK STORES" → Groceries\n'
      + 'It will also file any other uncategorized transactions that match, now and on every future import. Already-categorized transactions are never touched.',
    );
  });

  it('offers Create rule and « Back', () => {
    const s = session({ screen: ruleScreen });
    const { keyboard, buttons } = renderScreen(s);
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['Create rule', '« Back']);
    const create = buttons[keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Create rule')];
    expect(create).toEqual({ kind: 'createRule', activityId: 'act-1', categoryId: 'cat-groceries' });
    const back = buttons[keyboard.inline_keyboard.flat().findIndex((b) => b.text === '« Back')];
    expect(back).toEqual({ kind: 'goto', screen: { kind: 'txn', activityId: 'act-1' } });
  });

  it('falls back to the list when the transaction or category is gone', () => {
    const s = session({ txns: [], screen: ruleScreen });
    const { text } = renderScreen(s);
    expect(text.split('\n')[0]).toBe('That transaction is no longer uncategorized.');
  });
});

describe('renderScreen — freeRulePreview', () => {
  const freeScreen: MenuScreen = { kind: 'freeRulePreview', pattern: 'trader joes', categoryId: 'cat-groceries' };

  it('renders the exact locked copy with the typed pattern in place of a description', () => {
    const s = session({ screen: freeScreen });
    const { text } = renderScreen(s);
    expect(text).toBe(
      'Create this rule?\n'
      + 'Descriptions containing "trader joes" → Groceries\n'
      + 'It will also file any other uncategorized transactions that match, now and on every future import. Already-categorized transactions are never touched.',
    );
  });

  it('offers Create rule and Cancel — no Back, since there is no prior screen', () => {
    const s = session({ screen: freeScreen });
    const { keyboard, buttons } = renderScreen(s);
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['Create rule', 'Cancel']);
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).not.toContain('« Back');
    const create = buttons[keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Create rule')];
    expect(create).toEqual({ kind: 'createFreeRule', pattern: 'trader joes', categoryId: 'cat-groceries' });
  });

  it('falls back to the list when the category is gone', () => {
    const s = session({ screen: { kind: 'freeRulePreview', pattern: 'x', categoryId: 'nonexistent' } });
    const { text } = renderScreen(s);
    expect(text.split('\n')[0]).toBe('That transaction is no longer uncategorized.');
  });
});

describe('renderScreen — ruleCreated', () => {
  it('with an activityId, offers Back to list and Done', () => {
    const s = session({ screen: { kind: 'ruleCreated', activityId: 'act-1', categoryId: 'cat-groceries' } });
    const { keyboard } = renderScreen(s);
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['Back to list', 'Done']);
  });

  it('confirms the category by name in the text', () => {
    const s = session({ screen: { kind: 'ruleCreated', activityId: 'act-1', categoryId: 'cat-groceries' } });
    const { text } = renderScreen(s);
    expect(text).toContain('Groceries');
  });

  it('from /newrule (activityId: null), offers only Done', () => {
    const s = session({ screen: { kind: 'ruleCreated', activityId: null, categoryId: 'cat-groceries' } });
    const { keyboard, buttons } = renderScreen(s);
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['Done']);
    expect(buttons[0]).toEqual({ kind: 'close' });
  });

  it('falls back to the list when the category is gone', () => {
    const s = session({ screen: { kind: 'ruleCreated', activityId: 'act-1', categoryId: 'nonexistent' } });
    const { text } = renderScreen(s);
    expect(text.split('\n')[0]).toBe('That transaction is no longer uncategorized.');
  });
});

// ---- rule screens name the parent, so two same-named children differ --------

describe('renderScreen — same-named categories on the rule screens', () => {
  // Wealthfolio's own preset tree ships duplicates like this (an `Other` under
  // several parents, a `Gas` under both Transportation and Bills), and
  // `/newrule`'s resolver matches on NAME over the flat tree: it returns the
  // FIRST of two `Other`s. The preview is the only thing standing between a
  // typo and a rule that sweeps every matching row into the wrong category, so
  // it has to say WHICH `Other` it means.
  const home: SpendingCategory = { id: 'cat-home', name: 'Home', parentId: null, parentName: null };
  const auto: SpendingCategory = { id: 'cat-auto', name: 'Auto', parentId: null, parentName: null };
  const homeOther: SpendingCategory = {
    id: 'cat-home-other', name: 'Other', parentId: 'cat-home', parentName: 'Home',
  };
  const autoOther: SpendingCategory = {
    id: 'cat-auto-other', name: 'Other', parentId: 'cat-auto', parentName: 'Auto',
  };
  const cats = [home, auto, homeOther, autoOther];

  const previewText = (categoryId: string): string => renderScreen(session({
    categories: cats,
    screen: { kind: 'freeRulePreview', pattern: 'lowes', categoryId },
  })).text;

  it('distinguishes two children that share a name in the /newrule preview', () => {
    expect(previewText('cat-home-other')).toContain('Descriptions containing "lowes" → Other (Home)');
    expect(previewText('cat-auto-other')).toContain('Descriptions containing "lowes" → Other (Auto)');
    expect(previewText('cat-home-other')).not.toBe(previewText('cat-auto-other'));
  });

  it('names the parent on the created-confirmation too', () => {
    const text = renderScreen(session({
      categories: cats,
      screen: { kind: 'ruleCreated', activityId: null, categoryId: 'cat-auto-other' },
    })).text;
    expect(text).toBe('Rule created — future matches will file automatically under Other (Auto).');
  });

  it('names the parent on the tapped-off-a-transaction preview as well', () => {
    const text = renderScreen(session({
      txns: [txn({ description: 'BOOK STORES' })],
      categories: cats,
      screen: { kind: 'rulePreview', activityId: 'act-1', categoryId: 'cat-home-other' },
    })).text;
    expect(text).toContain('Descriptions containing "BOOK STORES" → Other (Home)');
  });

  it('leaves a TOP-LEVEL category bare — there is no parent to name', () => {
    expect(previewText('cat-home')).toContain('Descriptions containing "lowes" → Home\n');
  });
});

// ---- renderScreen: recategorize mode — list ---------------------------------

describe('renderScreen — recategorize mode: list', () => {
  it('appends the current category to the row label', () => {
    const s = session({
      mode: 'recategorize',
      txns: [txn({
        date: '2026-08-08',
        description: 'BOOK STORES',
        amountCents: -1000,
        currentCategory: { taxonomyId: 'spending', categoryId: 'cat-dining', name: 'Dining' },
      })],
    });
    const { keyboard } = renderScreen(s);
    expect(keyboard.inline_keyboard[0][0].text).toBe('Aug 8 · BOOK STORES · -$10 · Dining');
  });

  it('regression: categorize-mode row label is byte-identical to before recategorize existed', () => {
    const s = session({
      mode: 'categorize',
      txns: [txn({ date: '2026-08-08', description: 'BOOK STORES', amountCents: -1000 })],
    });
    const { keyboard } = renderScreen(s);
    expect(keyboard.inline_keyboard[0][0].text).toBe('Aug 8 · BOOK STORES · -$10');
  });

  it('header says "Recategorize — tap a transaction" instead of the categorize count line', () => {
    const s = session({
      mode: 'recategorize',
      txns: [txn({ currentCategory: { taxonomyId: 'spending', categoryId: 'cat-dining', name: 'Dining' } })],
    });
    const { text } = renderScreen(s);
    expect(text).toBe('Recategorize — tap a transaction');
  });

  it('empty list uses the recategorize-specific empty state with only Done', () => {
    const s = session({ mode: 'recategorize', txns: [] });
    const { text, keyboard } = renderScreen(s);
    expect(text).toBe('Nothing categorized in the last 90 days matches.');
    expect(keyboard.inline_keyboard).toEqual([[{ text: 'Done', callback_data: `${MENU_CALLBACK_PREFIX}7:0` }]]);
  });
});

// ---- renderScreen: recategorize mode — txn ----------------------------------

describe('renderScreen — recategorize mode: txn', () => {
  const recatTxn = () => txn({
    description: 'BOOK STORES',
    currentCategory: { taxonomyId: 'spending', categoryId: 'cat-groceries', name: 'Groceries' },
  });

  it('shows the current category in the text', () => {
    const s = session({ mode: 'recategorize', txns: [recatTxn()], screen: { kind: 'txn', activityId: 'act-1' } });
    const { text } = renderScreen(s);
    expect(text).toContain('Groceries');
  });

  it('has no "Keep uncategorized" button', () => {
    const s = session({ mode: 'recategorize', txns: [recatTxn()], screen: { kind: 'txn', activityId: 'act-1' } });
    const { keyboard } = renderScreen(s);
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).not.toContain('Keep uncategorized');
  });

  it('a leaf category tap yields reassign, not assign — including the CURRENT category’s own button, which is not suppressed or special-cased', () => {
    // recatTxn()'s currentCategory IS cat-groceries, so this same tap also
    // proves the current category's own button is still offered rather than
    // filtered out: re-filing to the same category is a no-op the controller
    // shrugs off, not a state this screen needs to special-case.
    const s = session({ mode: 'recategorize', txns: [recatTxn()], screen: { kind: 'txn', activityId: 'act-1' } });
    const { keyboard, buttons } = renderScreen(s);
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Groceries');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(buttons[idx]).toEqual({ kind: 'reassign', activityId: 'act-1', categoryId: 'cat-groceries' });
  });

  it('a parent with children still goes to the subcats screen (unchanged by mode)', () => {
    const s = session({ mode: 'recategorize', txns: [recatTxn()], screen: { kind: 'txn', activityId: 'act-1' } });
    const { keyboard, buttons } = renderScreen(s);
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Dining');
    expect(buttons[idx]).toEqual({
      kind: 'goto',
      screen: { kind: 'subcats', activityId: 'act-1', parentId: 'cat-dining' },
    });
  });
});

// ---- renderScreen: recategorize mode — subcats ------------------------------

describe('renderScreen — recategorize mode: subcats', () => {
  const subcatsScreen: MenuScreen = { kind: 'subcats', activityId: 'act-1', parentId: 'cat-dining' };

  it('a child category tap yields reassign', () => {
    const s = session({
      mode: 'recategorize',
      txns: [txn({ currentCategory: { taxonomyId: 'spending', categoryId: 'cat-groceries', name: 'Groceries' } })],
      screen: subcatsScreen,
    });
    const { keyboard, buttons } = renderScreen(s);
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Fast Food');
    expect(buttons[idx]).toEqual({ kind: 'reassign', activityId: 'act-1', categoryId: 'cat-dining-fastfood' });
  });

  it('"Just <parent> itself" also yields reassign', () => {
    const s = session({
      mode: 'recategorize',
      txns: [txn({ currentCategory: { taxonomyId: 'spending', categoryId: 'cat-groceries', name: 'Groceries' } })],
      screen: subcatsScreen,
    });
    const { keyboard, buttons } = renderScreen(s);
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Just Dining itself');
    expect(buttons[idx]).toEqual({ kind: 'reassign', activityId: 'act-1', categoryId: 'cat-dining' });
  });
});

// ---- renderScreen: refiled ---------------------------------------------------

describe('renderScreen — refiled', () => {
  const refiledScreen: MenuScreen = {
    kind: 'refiled', activityId: 'act-1', fromName: 'Dining', toCategoryId: 'cat-groceries',
    crossTaxonomy: false, undone: false,
    restore: [{ taxonomyId: 'spending', categoryId: 'cat-dining' }],
    // The controller decides this per render from the row's cash-flow bucket;
    // `false` is the ordinary case — a spending-to-spending move, whose restore
    // is as legal as the move was.
    restoreBlocked: false,
  };

  function refiledTxn(overrides: Partial<CategorizeTxn> = {}): CategorizeTxn {
    return txn({
      description: 'BOOK STORES',
      currentCategory: { taxonomyId: 'spending', categoryId: 'cat-dining', name: 'Dining' },
      ...overrides,
    });
  }

  it('confirms with the exact "X: old → new." wording', () => {
    const s = session({ txns: [refiledTxn()], screen: refiledScreen });
    const { text } = renderScreen(s);
    expect(text).toBe('BOOK STORES: Dining → Groceries.');
  });

  it('adds the exact cross-taxonomy offset line when crossTaxonomy is true', () => {
    const s = session({
      txns: [refiledTxn({
        description: 'PAYPAL REFUND',
        currentCategory: { taxonomyId: 'income', categoryId: 'cat-income-refunds', name: 'Refunds' },
      })],
      screen: { ...refiledScreen, fromName: 'Refunds', crossTaxonomy: true },
    });
    const { text } = renderScreen(s);
    expect(text).toBe(
      'PAYPAL REFUND: Refunds → Groceries.\n'
      + 'This payment now offsets Groceries instead of counting toward its previous category.',
    );
  });

  it('the offset line says nothing income-specific when the cleared assignment was a savings one', () => {
    // crossTaxonomy is set from "cleared some non-spending taxonomy", not
    // "cleared income specifically" — a savings-taxonomy clear must not be
    // described as if it stopped counting as income, since it never did.
    const s = session({
      txns: [refiledTxn({
        description: 'HOUSE FUND TRANSFER',
        currentCategory: { taxonomyId: 'savings', categoryId: 'cat-savings-house', name: 'House Fund' },
      })],
      screen: { ...refiledScreen, fromName: 'House Fund', crossTaxonomy: true },
    });
    const { text } = renderScreen(s);
    expect(text).toBe(
      'HOUSE FUND TRANSFER: House Fund → Groceries.\n'
      + 'This payment now offsets Groceries instead of counting toward its previous category.',
    );
    expect(text).not.toContain('income');
  });

  it('omits the offset line when crossTaxonomy is false', () => {
    const s = session({ txns: [refiledTxn()], screen: refiledScreen });
    const { text } = renderScreen(s);
    expect(text).not.toContain('offsets');
  });

  it('offers Undo, Next transaction, Done — same goto-list label as the filed screen — with Undo yielding undoReassign back to the old category', () => {
    const s = session({ txns: [refiledTxn()], screen: refiledScreen });
    const { keyboard, buttons } = renderScreen(s);
    const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toEqual(['Undo', 'Next transaction', 'Done']);

    const undo = buttons[labels.indexOf('Undo')];
    expect(undo).toEqual({
      kind: 'undoReassign',
      activityId: 'act-1',
      toRestore: [{ taxonomyId: 'spending', categoryId: 'cat-dining' }],
    });

    const next = buttons[labels.indexOf('Next transaction')];
    expect(next).toEqual({ kind: 'goto', screen: { kind: 'list', page: 0 } });

    const done = buttons[labels.indexOf('Done')];
    expect(done).toEqual({ kind: 'close' });
  });

  it('hands Undo EVERY assignment the move cleared, not the one the screen displays', () => {
    // The defect this list shape exists for: a row holding a spending category
    // AND an income one loses the income assignment to the move, and an undo
    // built from the displayed category alone would never put it back — while
    // this screen said "back under Dining" as if it had.
    const s = session({
      txns: [refiledTxn()],
      screen: {
        ...refiledScreen,
        crossTaxonomy: true,
        restore: [
          { taxonomyId: 'spending', categoryId: 'cat-dining' },
          { taxonomyId: 'income', categoryId: 'cat-income-refunds' },
          { taxonomyId: 'savings', categoryId: 'cat-house' },
        ],
      },
    });
    const { keyboard, buttons } = renderScreen(s);
    const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(buttons[labels.indexOf('Undo')]).toEqual({
      kind: 'undoReassign',
      activityId: 'act-1',
      toRestore: [
        { taxonomyId: 'spending', categoryId: 'cat-dining' },
        { taxonomyId: 'income', categoryId: 'cat-income-refunds' },
        { taxonomyId: 'savings', categoryId: 'cat-house' },
      ],
    });
  });

  it('offers NO Undo button when there is nothing to restore', () => {
    // A move that wrote nothing (re-filing to the category the row already had)
    // has nothing to reverse. An Undo here could only either do nothing and
    // claim success, or write a category the row already carries.
    const s = session({ txns: [refiledTxn()], screen: { ...refiledScreen, restore: [] } });
    const { keyboard, buttons } = renderScreen(s);
    const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toEqual(['Next transaction', 'Done']);
    expect(buttons.some((b) => b.kind === 'undoReassign')).toBe(false);
    // The confirmation itself still renders — the move is still what happened.
    expect(renderScreen(s).text).toBe('BOOK STORES: Dining → Groceries.');
  });

  it('withholds Undo and says why when the restore is one Wealthfolio would refuse', () => {
    // CRITICAL, the release's own headline flow: a payback re-typed as a
    // reimbursement sits in the SPENDING bucket, which is what made the move
    // legal — and what makes putting its income assignment back illegal. Undoing
    // would delete the new category and then be refused, leaving the transaction
    // with none at all (docs/upstream-spending-buckets.md §1).
    const s = session({
      txns: [refiledTxn({
        description: 'VENMO PAYBACK',
        currentCategory: { taxonomyId: 'income', categoryId: 'cat-income-refunds', name: 'Refunds' },
      })],
      screen: {
        ...refiledScreen,
        fromName: 'Refunds',
        crossTaxonomy: true,
        restore: [{ taxonomyId: 'income_sources', categoryId: 'cat-income-refunds' }],
        restoreBlocked: true,
      },
    });
    const { text, keyboard, buttons } = renderScreen(s);
    const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toEqual(['Next transaction', 'Done']);
    expect(buttons.some((b) => b.kind === 'undoReassign')).toBe(false);
    // The move still reads as the success it was — the extra sentence is about
    // the way back, and says nothing about anything having failed.
    expect(text).toBe(
      'VENMO PAYBACK: Refunds → Groceries.\n'
      + 'This payment now offsets Groceries instead of counting toward its previous category.\n'
      + 'This transaction can no longer hold everything it had before the move, so there is no Undo.',
    );
    expect(text).not.toContain('failed');
    // Never Wealthfolio's own API prose, on this screen either.
    expect(text).not.toContain('can only use');
    expect(text).not.toContain('400');
  });

  it('restores NOTHING rather than the legal subset when only one leg of the restore is refused', () => {
    // All legs or no button. Restoring just the spending half here would drop the
    // income assignment for good while the screen reported the undo as done —
    // the worst defect of the original build, and the reason a blocked restore
    // withholds the button instead of filtering the list.
    const s = session({
      txns: [refiledTxn()],
      screen: {
        ...refiledScreen,
        crossTaxonomy: true,
        restore: [
          { taxonomyId: 'spending', categoryId: 'cat-dining' },
          { taxonomyId: 'income_sources', categoryId: 'cat-income-refunds' },
        ],
        restoreBlocked: true,
      },
    });
    const { buttons } = renderScreen(s);
    expect(buttons.some((b) => b.kind === 'undoReassign')).toBe(false);
  });

  it('says nothing about Undo when the move wrote nothing, blocked or not — there was never a button to explain', () => {
    // An empty restore already has its own reason for no Undo (nothing was
    // written). Explaining a constraint on top of that would answer a question
    // this reader never asked.
    const s = session({
      txns: [refiledTxn()],
      screen: { ...refiledScreen, restore: [], restoreBlocked: true },
    });
    const { text, keyboard } = renderScreen(s);
    expect(text).toBe('BOOK STORES: Dining → Groceries.');
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['Next transaction', 'Done']);
  });

  it('says nothing about Undo on the undone confirmation', () => {
    // The undo already happened, so a sentence about not being able to undo
    // would contradict the screen it is on.
    const s = session({
      txns: [refiledTxn()],
      screen: { ...refiledScreen, undone: true, restoreBlocked: true },
    });
    const { text } = renderScreen(s);
    expect(text).toBe('Refiling undone — BOOK STORES is back under Dining.');
  });

  it('undone: true mirrors the existing undo wording pattern and offers only Back to list / Done', () => {
    const s = session({
      txns: [refiledTxn()],
      screen: { ...refiledScreen, undone: true },
    });
    const { text, keyboard } = renderScreen(s);
    expect(text).toBe('Refiling undone — BOOK STORES is back under Dining.');
    expect(keyboard.inline_keyboard.flat().map((b) => b.text)).toEqual(['Back to list', 'Done']);
  });

  it('escapes Markdown specials in the description, old name, and new category name', () => {
    const s = session({
      txns: [refiledTxn({ description: 'A*B_C' })],
      categories: [{ id: 'cat-groceries', name: 'Baz*Qux', parentId: null, parentName: null }],
      screen: { ...refiledScreen, fromName: 'Foo_Bar' },
    });
    const { text } = renderScreen(s);
    expect(text).toBe('A\\*B\\_C: Foo\\_Bar → Baz\\*Qux.');
  });

  it('falls back to the list with the recategorize-worded note (not "uncategorized") when the transaction is gone', () => {
    const s = session({ mode: 'recategorize', txns: [], screen: refiledScreen });
    const { text } = renderScreen(s);
    expect(text.split('\n')[0]).toBe('That transaction is no longer available to recategorize.');
    // The whole point of this fallback existing separately from GONE_NOTE: the
    // transaction was never uncategorized, it was being MOVED, so the fallback
    // must not claim otherwise.
    expect(text).not.toContain('uncategorized');
  });

  it('falls back to the list with the recategorize-worded note when the target category is gone', () => {
    const s = session({ mode: 'recategorize', txns: [refiledTxn()], categories: [], screen: refiledScreen });
    const { text } = renderScreen(s);
    expect(text.split('\n')[0]).toBe('That transaction is no longer available to recategorize.');
    expect(text).not.toContain('uncategorized');
  });

  it('renders and still offers Undo when the transaction carries no currentCategory', () => {
    // This used to be a third fallback branch: while the undo was derived from
    // `txn.currentCategory`, a txn without one could not render this screen at
    // all. The restore data lives on the SCREEN now — which is the only place
    // that knows the state BEFORE the move — so the display-only field being
    // absent no longer costs the reader their confirmation or their Undo.
    const s = session({
      mode: 'recategorize',
      txns: [txn({ description: 'BOOK STORES' })],
      screen: refiledScreen,
    });
    const { text, keyboard, buttons } = renderScreen(s);
    expect(text).toBe('BOOK STORES: Dining → Groceries.');
    const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toEqual(['Undo', 'Next transaction', 'Done']);
    expect(buttons[labels.indexOf('Undo')]).toEqual({
      kind: 'undoReassign',
      activityId: 'act-1',
      toRestore: [{ taxonomyId: 'spending', categoryId: 'cat-dining' }],
    });
  });

  it('falls back with the ORIGINAL GONE_NOTE wording in categorize mode (defensive: this screen should never actually render there)', () => {
    const s = session({ mode: 'categorize', txns: [], screen: refiledScreen });
    const { text } = renderScreen(s);
    expect(text.split('\n')[0]).toBe('That transaction is no longer uncategorized.');
  });
});

// ---- renderScreen: refused ---------------------------------------------------

describe('renderScreen — refused', () => {
  /** The one route out of both subtype-governed refusals, and the only thing a
   *  reader can act on — so both screens carry it verbatim. */
  const HINT = 'A payback can be turned into a spending offset by marking it a reimbursement in Advanced → Transaction Rules.';

  it('neutral: states the constraint and offers NO way out, because a subtype has none to offer', () => {
    // This reason is reached when the ACCOUNT TYPE decides — a SECURITIES
    // account, an account type this build does not know, a CREDIT_CARD
    // non-expense type. Naming the reimbursement rule there would send its
    // reader to a setting that cannot move their transaction, which is the same
    // reason `scope` gets no hint either.
    const s = session({ screen: { kind: 'refused', activityId: 'act-1', reason: 'neutral' } });
    const { text } = renderScreen(s);
    expect(text).toBe(
      'The transaction is not counted as spending or income at all, so no category can be attached to it as it stands.',
    );
    expect(text).not.toContain('reimbursement');
    expect(text).not.toContain('Transaction Rules');
  });

  it('neutral-subtype: the SAME constraint, plus the way out, for a row a refund subtype would lift', () => {
    // A CASH credit that has simply not been marked a refund yet. Identical
    // first sentence — the constraint really is the same — and the second line
    // is the whole difference between the two reasons.
    const s = session({ screen: { kind: 'refused', activityId: 'act-1', reason: 'neutral-subtype' } });
    const { text } = renderScreen(s);
    expect(text).toBe(
      'The transaction is not counted as spending or income at all, so no category can be attached to it as it stands.'
      + `\n${HINT}`,
    );
    const bare = renderScreen(session({ screen: { kind: 'refused', activityId: 'act-1', reason: 'neutral' } }));
    expect(text.split('\n')[0]).toBe(bare.text);
  });

  it('wrong-bucket: states it is recorded as money in and can only take an income category, then the way out', () => {
    const s = session({ screen: { kind: 'refused', activityId: 'act-1', reason: 'wrong-bucket' } });
    const { text } = renderScreen(s);
    expect(text).toBe(
      'It is recorded as money in and can only take an income category while that is true.'
      + `\n${HINT}`,
    );
  });

  it('scope: states the account is not set up for spending tracking, and offers NO subtype route', () => {
    // A subtype cannot opt an account into spending tracking, so the
    // reimbursement hint would send this reader somewhere that changes nothing.
    const s = session({ screen: { kind: 'refused', activityId: 'act-1', reason: 'scope' } });
    const { text } = renderScreen(s);
    expect(text).toBe('Its account is not set up for spending tracking.');
    expect(text).not.toContain('reimbursement');
  });

  it('promises nothing the bot does: the way out is a rule the reader sets, stated in the passive', () => {
    // The menu writes no subtypes at all (rules own that), so any wording that
    // implied "tap here and we will fix it" would be a promise it cannot keep —
    // and this refusal exists precisely because a promise like that once cost a
    // user their category.
    for (const reason of ['neutral-subtype', 'wrong-bucket'] as const) {
      const s = session({ screen: { kind: 'refused', activityId: 'act-1', reason } });
      const { text } = renderScreen(s);
      expect(text).toContain('Advanced → Transaction Rules');
      expect(text).not.toMatch(/\bI(?:'| w)ll\b|we(?:'| w)ill|tap|press/i);
      // And it never tells the reader they did something wrong.
      expect(text).not.toMatch(/you (?:should|need to|must)|instead of what you/i);
    }
  });

  it('offers only « Back (to the txn screen) and Done, for every reason', () => {
    for (const reason of ['neutral', 'neutral-subtype', 'wrong-bucket', 'scope'] as const) {
      const s = session({ screen: { kind: 'refused', activityId: 'act-1', reason } });
      const { keyboard, buttons } = renderScreen(s);
      const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
      expect(labels).toEqual(['« Back', 'Done']);
      expect(buttons[labels.indexOf('« Back')]).toEqual({
        kind: 'goto', screen: { kind: 'txn', activityId: 'act-1' },
      });
      expect(buttons[labels.indexOf('Done')]).toEqual({ kind: 'close' });
    }
  });

  it('never pastes Wealthfolio’s raw API sentence, for any reason', () => {
    // The real upstream strings (docs/upstream-spending-buckets.md §1, §7):
    // "Neutral transfers cannot be categorized. Change or unlink the transfer
    // if it should count as spending.", "{bucket} activities can only use
    // {taxonomy} categories. Categories label the cash-flow bucket; they do
    // not change it.", "Activity account is not opted into spending
    // tracking", "Activity account does not support spending tracking".
    for (const reason of ['neutral', 'neutral-subtype', 'wrong-bucket', 'scope'] as const) {
      const s = session({ screen: { kind: 'refused', activityId: 'act-1', reason } });
      const { text } = renderScreen(s);
      expect(text).not.toContain('Neutral transfers cannot be categorized');
      expect(text).not.toContain('do not change it');
      expect(text).not.toContain('opted into spending tracking');
      expect(text).not.toContain('does not support spending tracking');
    }
  });
});

// ---- every category tap in recategorize mode yields a plain reassign -------

describe('renderScreen — recategorize mode: a category tap always yields reassign', () => {
  // This module has none of the data (account type, activity type, subtype)
  // that assignabilityOf needs to decide whether a move is even legal — only
  // the controller has that, via the gate in companion/src/categorize.ts,
  // which runs AFTER this action reaches it. So every category tap emits a
  // plain reassign regardless of mode or screen; refusing (or not) is
  // entirely the controller's job, never something this module decides for
  // itself.
  it('a leaf category tap on the txn screen yields reassign', () => {
    const s = session({ mode: 'recategorize', screen: { kind: 'txn', activityId: 'act-1' } });
    const { keyboard, buttons } = renderScreen(s);
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Groceries');
    expect(buttons[idx]).toEqual({ kind: 'reassign', activityId: 'act-1', categoryId: 'cat-groceries' });
  });

  it('a child category tap on the subcats screen yields reassign', () => {
    const s = session({
      mode: 'recategorize',
      screen: { kind: 'subcats', activityId: 'act-1', parentId: 'cat-dining' },
    });
    const { keyboard, buttons } = renderScreen(s);
    const idx = keyboard.inline_keyboard.flat().findIndex((b) => b.text === 'Fast Food');
    expect(buttons[idx]).toEqual({ kind: 'reassign', activityId: 'act-1', categoryId: 'cat-dining-fastfood' });
  });
});

// ---- token codec / applyTap -------------------------------------------------

describe('applyTap', () => {
  it('resolves a cz:<generation>:<index> token against the buttons most recently rendered', () => {
    const s = session({ screen: { kind: 'list', page: 0 } });
    const { buttons } = renderScreen(s);
    s.buttons = buttons;
    const result = applyTap(s, `${MENU_CALLBACK_PREFIX}7:0`);
    expect(result).toEqual({ ok: true, action: buttons[0] });
  });

  it('every emitted token carries the session generation', () => {
    const s = session({ generation: 12, screen: { kind: 'list', page: 0 } });
    const { keyboard } = renderScreen(s);
    for (const button of keyboard.inline_keyboard.flat()) {
      expect(button.callback_data).toMatch(/^cz:12:\d+$/);
    }
  });

  it('a token from an EARLIER generation is expired, whatever sits at its index now', () => {
    // The defect this exists for: two renders of the same SHAPE have identically
    // sized button arrays holding different ids, so an in-range index from the
    // older message would resolve position-for-position against the newer screen
    // and act on a row the user never tapped. The generation is checked before
    // the index precisely so that cannot happen.
    const first = session({ generation: 7, screen: { kind: 'txn', activityId: 'act-1' } });
    const rendered = renderScreen(first);
    const staleToken = rendered.keyboard.inline_keyboard.flat()[0].callback_data;
    expect(staleToken).toBe(`${MENU_CALLBACK_PREFIX}7:0`);

    // Same screen shape, one render later, about a DIFFERENT transaction.
    const second = session({
      generation: 8,
      txns: [txn({ activityId: 'act-2' })],
      screen: { kind: 'txn', activityId: 'act-2' },
    });
    second.buttons = renderScreen(second).buttons;
    expect(second.buttons.length).toBeGreaterThan(0);

    expect(applyTap(second, staleToken)).toEqual({ ok: false, reason: 'expired' });
  });

  it('a LATER generation than the session holds is expired too', () => {
    const s = session({ generation: 7, buttons: [{ kind: 'close' }] });
    expect(applyTap(s, `${MENU_CALLBACK_PREFIX}8:0`)).toEqual({ ok: false, reason: 'expired' });
  });

  it('is out of range -> unknown: the current render cannot have emitted it', () => {
    const s = session({ buttons: [{ kind: 'close' }] });
    expect(applyTap(s, `${MENU_CALLBACK_PREFIX}7:5`)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects callback_data with no cz: prefix as unknown', () => {
    const s = session({ buttons: [{ kind: 'close' }] });
    expect(applyTap(s, 'd:some-other-id')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects a malformed token after the prefix as unknown', () => {
    const s = session({ buttons: [{ kind: 'close' }] });
    expect(applyTap(s, `${MENU_CALLBACK_PREFIX}abc`)).toEqual({ ok: false, reason: 'unknown' });
    // The single-number form this module used to emit is no longer one of ours.
    expect(applyTap(s, `${MENU_CALLBACK_PREFIX}0`)).toEqual({ ok: false, reason: 'unknown' });
    expect(applyTap(s, `${MENU_CALLBACK_PREFIX}7:0:1`)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('never resolves against a stale render — buttons are replaced wholesale on every render', () => {
    const s = session({ screen: { kind: 'txn', activityId: 'act-1' } });
    const first = renderScreen(s);
    s.buttons = first.buttons;
    // Session moves on to a screen with fewer buttons (list, empty)...
    s.txns = [];
    s.screen = { kind: 'list', page: 0 };
    s.generation += 1; // ...which the controller stamps as a new render
    const second = renderScreen(s);
    s.buttons = second.buttons; // caller always re-stores buttons after rendering
    // A tap referencing an index that only existed on the old (larger) screen:
    const staleIndex = first.buttons.length - 1;
    expect(staleIndex).toBeGreaterThanOrEqual(second.buttons.length);
    expect(applyTap(s, `${MENU_CALLBACK_PREFIX}7:${staleIndex}`)).toEqual({ ok: false, reason: 'expired' });
  });
});

// ---- 64-byte callback invariant ---------------------------------------------

describe('callback_data byte cap', () => {
  it('every emitted callback_data fits Telegram’s 64-byte limit, even for a large session with long names', () => {
    const longTxns: CategorizeTxn[] = Array.from({ length: 50 }, (_, i) => ({
      activityId: `activity-id-that-is-quite-long-${'x'.repeat(20)}-${i}`,
      date: '2026-08-08',
      amountCents: -123456,
      description: `A VERY LONG MERCHANT DESCRIPTOR THAT GOES ON AND ON #${i} ${'Y'.repeat(40)}`,
      accountName: `Some Long Account Name For A Household Member ${'Z'.repeat(30)} #${i}`,
    }));
    const longParents: SpendingCategory[] = Array.from({ length: 20 }, (_, i) => ({
      id: `category-id-that-is-long-${'p'.repeat(20)}-${i}`,
      name: `A Really Long Parent Category Name Number ${'Q'.repeat(30)} #${i}`,
      parentId: null,
      parentName: null,
    }));
    const longChildren: SpendingCategory[] = Array.from({ length: 40 }, (_, i) => ({
      id: `child-category-id-that-is-long-${'c'.repeat(20)}-${i}`,
      name: `A Really Long Child Category Name Number ${'R'.repeat(30)} #${i}`,
      parentId: longParents[i % longParents.length].id,
      parentName: longParents[i % longParents.length].name,
    }));
    const categories = [...longParents, ...longChildren];
    expect(categories.length).toBe(60);

    // A deliberately huge generation: the counter climbs for the life of the
    // process, so the widest token the format can ever produce is the one to
    // measure, not the one a fresh session happens to start at.
    //
    // `mode: 'categorize'` is spelled out explicitly even though the field is
    // optional (every read treats a missing value as `'categorize'`) — this
    // session predates recategorize, and the value below is exactly what an
    // omitted field defaults to, so nothing about this test's behaviour
    // changes.
    const base = {
      txns: longTxns, categories, buttons: [] as MenuAction[], generation: 4294967295,
      mode: 'categorize' as const,
    };

    assertCallbackBytesFit(renderScreen({ ...base, screen: { kind: 'list', page: 0 } }).keyboard);
    assertCallbackBytesFit(renderScreen({ ...base, screen: { kind: 'list', page: 5 } }).keyboard);
    assertCallbackBytesFit(
      renderScreen({ ...base, screen: { kind: 'txn', activityId: longTxns[0].activityId } }).keyboard,
    );
    assertCallbackBytesFit(
      renderScreen({
        ...base,
        screen: { kind: 'subcats', activityId: longTxns[0].activityId, parentId: longParents[0].id },
      }).keyboard,
    );
  });

  it('every emitted callback_data fits the 64-byte limit for recategorize screens too, even with long current-category names', () => {
    const longTxns: CategorizeTxn[] = Array.from({ length: 50 }, (_, i) => ({
      activityId: `activity-id-that-is-quite-long-${'x'.repeat(20)}-${i}`,
      date: '2026-08-08',
      amountCents: -123456,
      description: `A VERY LONG MERCHANT DESCRIPTOR THAT GOES ON AND ON #${i} ${'Y'.repeat(40)}`,
      accountName: `Some Long Account Name For A Household Member ${'Z'.repeat(30)} #${i}`,
      currentCategory: {
        taxonomyId: 'spending',
        categoryId: `current-category-id-that-is-long-${'p'.repeat(20)}-${i}`,
        name: `A Really Long Current Category Name Number ${'Q'.repeat(30)} #${i}`,
      },
    }));
    const longParents: SpendingCategory[] = Array.from({ length: 20 }, (_, i) => ({
      id: `category-id-that-is-long-${'p'.repeat(20)}-${i}`,
      name: `A Really Long Parent Category Name Number ${'Q'.repeat(30)} #${i}`,
      parentId: null,
      parentName: null,
    }));
    const longChildren: SpendingCategory[] = Array.from({ length: 40 }, (_, i) => ({
      id: `child-category-id-that-is-long-${'c'.repeat(20)}-${i}`,
      name: `A Really Long Child Category Name Number ${'R'.repeat(30)} #${i}`,
      parentId: longParents[i % longParents.length].id,
      parentName: longParents[i % longParents.length].name,
    }));
    const categories = [...longParents, ...longChildren];

    const base = {
      txns: longTxns, categories, buttons: [] as MenuAction[], generation: 4294967295,
      mode: 'recategorize' as const,
    };

    assertCallbackBytesFit(renderScreen({ ...base, screen: { kind: 'list', page: 0 } }).keyboard);
    assertCallbackBytesFit(
      renderScreen({ ...base, screen: { kind: 'txn', activityId: longTxns[0].activityId } }).keyboard,
    );
    assertCallbackBytesFit(
      renderScreen({
        ...base,
        screen: { kind: 'subcats', activityId: longTxns[0].activityId, parentId: longParents[0].id },
      }).keyboard,
    );
    // The refiled confirmation is a new screen KIND, not just a new mode on an
    // existing one — worth its own check that a long fromName/category name
    // still never reaches callback_data (buttons there stay index-only).
    assertCallbackBytesFit(
      renderScreen({
        ...base,
        screen: {
          kind: 'refiled',
          activityId: longTxns[0].activityId,
          fromName: `A Really Long Old Category Name ${'O'.repeat(40)}`,
          toCategoryId: longParents[0].id,
          crossTaxonomy: true,
          undone: false,
          // Several assignments, every id long: the restore list rides on the
          // SCREEN, never in a token, so none of this can reach callback_data.
          restore: [
            { taxonomyId: 'spending_categories', categoryId: longParents[0].id },
            { taxonomyId: 'income_categories', categoryId: `income-category-id-${'i'.repeat(40)}` },
            { taxonomyId: 'savings_categories', categoryId: `savings-category-id-${'s'.repeat(40)}` },
          ],
          restoreBlocked: false,
        },
      }).keyboard,
    );

    // refused: fixed « Back/Done buttons regardless of reason. Looped over
    // EVERY reason `refused` can carry, via a Record (not a plain array) keyed
    // by the reason union — the same exhaustiveness trick `REFUSED_TEXT` uses
    // in categorize-menu.ts — so a future reason added to the union is a
    // compile error here until this list grows too, rather than a silently
    // uncovered case. This passes trivially today and is expected to: the
    // reason string never reaches callback_data, only the screen's TEXT does
    // (checked elsewhere), so a green result here is not evidence about the
    // text — only that the fixed buttons stay fixed regardless of reason.
    const everyRefusedReason: Record<Extract<MenuScreen, { kind: 'refused' }>['reason'], true> = {
      neutral: true,
      'neutral-subtype': true,
      'wrong-bucket': true,
      scope: true,
    };
    for (const reason of Object.keys(everyRefusedReason) as Array<keyof typeof everyRefusedReason>) {
      assertCallbackBytesFit(
        renderScreen({
          ...base,
          screen: { kind: 'refused', activityId: longTxns[0].activityId, reason },
        }).keyboard,
      );
    }
  });
});

// ---- parseNewRuleArgs -------------------------------------------------------

describe('parseNewRuleArgs', () => {
  it('splits on the first "="', () => {
    expect(parseNewRuleArgs('trader joes = groceries')).toEqual({ pattern: 'trader joes', categoryQuery: 'groceries' });
  });

  it('splits on the first "→"', () => {
    expect(parseNewRuleArgs('trader joes → groceries')).toEqual({ pattern: 'trader joes', categoryQuery: 'groceries' });
  });

  it('trims both sides', () => {
    expect(parseNewRuleArgs('  trader joes   =   groceries  ')).toEqual({
      pattern: 'trader joes',
      categoryQuery: 'groceries',
    });
  });

  it('keeps special characters in the pattern verbatim', () => {
    expect(parseNewRuleArgs('trader joe*s (west) = Groceries')).toEqual({
      pattern: 'trader joe*s (west)',
      categoryQuery: 'Groceries',
    });
  });

  it('an "=" embedded in the category side does not cause a second split', () => {
    expect(parseNewRuleArgs('pattern = cat = ory')).toEqual({ pattern: 'pattern', categoryQuery: 'cat = ory' });
  });

  it('an empty pattern side returns null', () => {
    expect(parseNewRuleArgs('= groceries')).toBeNull();
  });

  it('an empty category side returns null', () => {
    expect(parseNewRuleArgs('trader joes =')).toBeNull();
  });

  it('no separator at all returns null', () => {
    expect(parseNewRuleArgs('just some text')).toBeNull();
  });
});

// ---- constants ---------------------------------------------------------------

describe('constants', () => {
  it('MENU_PAGE_SIZE is 8', () => {
    expect(MENU_PAGE_SIZE).toBe(8);
  });

  it('MENU_CALLBACK_PREFIX is "cz:"', () => {
    expect(MENU_CALLBACK_PREFIX).toBe('cz:');
  });
});

describe('direction-aware menu', () => {
  const incomeCats: SpendingCategory[] = [
    { id: 'inc-sal', name: 'Salary & Wages', parentId: null, parentName: null },
    { id: 'inc-oth', name: 'Other Income', parentId: null, parentName: null },
  ];

  it('signs the list rows when direction is known', () => {
    const s = session({
      txns: [
        txn({ direction: 'out', amountCents: 1200 }),
        txn({ activityId: 'act-2', description: 'GRANT CHECK', direction: 'in', amountCents: 99_900 }),
      ],
    });
    const { keyboard } = renderScreen(s);
    const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels.some((l) => l.includes('−$12'))).toBe(true);
    expect(labels.some((l) => l.includes('+$999'))).toBe(true);
  });

  it('offers income categories to a money-in row, with taxonomy-carrying assigns', () => {
    const s = session({
      txns: [txn({ direction: 'in' })],
      incomeCategories: incomeCats,
      screen: { kind: 'txn', activityId: 'act-1' },
    });
    const { keyboard, buttons } = renderScreen(s);
    const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain('Salary & Wages');
    expect(labels).not.toContain('Groceries');
    const i = labels.indexOf('Salary & Wages');
    expect(buttons[i]).toEqual({
      kind: 'assign', activityId: 'act-1', categoryId: 'inc-sal', taxonomyId: 'income_sources',
    });
    expect(labels).toContain('Spending categories »');
  });

  it('lets a money-in row switch to the spending grid, with a way back', () => {
    const s = session({
      txns: [txn({ direction: 'in' })],
      incomeCategories: incomeCats,
      screen: { kind: 'txn', activityId: 'act-1', showSpending: true },
    });
    const { keyboard, buttons } = renderScreen(s);
    const labels = keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain('Groceries');
    expect(labels).not.toContain('Salary & Wages');
    expect(labels).toContain('« Income categories');
    const i = labels.indexOf('Groceries');
    expect(buttons[i]).toEqual({ kind: 'assign', activityId: 'act-1', categoryId: 'cat-groceries' });
  });

  it('keeps the spending grid for money-out rows even when income categories exist', () => {
    const s = session({
      txns: [txn({ direction: 'out' })],
      incomeCategories: incomeCats,
      screen: { kind: 'txn', activityId: 'act-1' },
    });
    const labels = renderScreen(s).keyboard.inline_keyboard.flat().map((b) => b.text);
    expect(labels).toContain('Groceries');
    expect(labels).not.toContain('Salary & Wages');
    expect(labels).not.toContain('Spending categories »');
  });

  it("an income filing's Undo carries the taxonomy back", () => {
    const s = session({
      txns: [txn({ direction: 'in' })],
      incomeCategories: incomeCats,
      screen: { kind: 'filed', activityId: 'act-1', categoryId: 'inc-sal', taxonomyId: 'income_sources', undone: false },
    });
    const { text, buttons } = renderScreen(s);
    expect(text).toContain('Salary & Wages'); // name resolved from the income list
    expect(buttons).toContainEqual({
      kind: 'unassign', activityId: 'act-1', categoryId: 'inc-sal', taxonomyId: 'income_sources',
    });
  });
});
