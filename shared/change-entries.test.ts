import { describe, it, expect } from 'vitest';
import {
  accountCreatedChange, amazonLabelChange, amazonLabelOf, balanceCorrectionChange, bankUpdateChange, bookkeepingChange, budgetSetChange,
  categoryFiledChange, categoryRuleCreatedChange, CHANGE_KINDS, changeDay, changeMoney, duplicateRemovedChange,
  importChange, mappingRuleCreatedChange, newEntryId, newRunId, openingBalanceFiledChange, pendingRemovedChange,
  stampChange, startingBalanceChange, startingBalanceMovedChange, transferLinkChange, transferTypeChange,
  type ChangeDraft,
} from './change-entries.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-12T14:05:00Z');
const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };
const CARD = { sfinId: 'ACT-9c8d', wfId: 'wf-citi', name: 'Citi Card' };
const KEY = accountTxKey('ACT-1f2e', 'TRN-a1b2');

describe('ids and stamps', () => {
  it('mints a run id from the writer and the millisecond', () => {
    expect(newRunId('companion', NOW)).toBe(`c${NOW.getTime().toString(36)}`);
    expect(newRunId('addon', NOW)).toBe(`a${NOW.getTime().toString(36)}`);
  });

  it('never mints the same entry id twice in one millisecond', () => {
    const ids = Array.from({ length: 50 }, () => newEntryId('addon', NOW));
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) expect(id).toMatch(new RegExp(`^a${NOW.getTime().toString(36)}[0-9a-z]+$`));
  });

  it('stamps id, time, writer and run onto a draft', () => {
    const draft = bookkeepingChange({ step: 'external-marker', activityIds: ['x'] });
    const entry = stampChange(draft, 'companion', NOW, 'cRUN');
    expect(entry).toMatchObject({ at: '2026-10-12T14:05:00.000Z', writer: 'companion', run: 'cRUN', kind: 'bookkeeping' });
    expect(entry.id.startsWith('c')).toBe(true);
    expect('run' in stampChange(draft, 'addon', NOW)).toBe(false);
  });

  it('lists every kind once', () => {
    expect(new Set(CHANGE_KINDS).size).toBe(17);
  });
});

describe('changeMoney / changeDay', () => {
  it.each([
    [-1234, '-$12.34'], [1250000, '$12,500.00'], [5, '$0.05'], [0, '$0.00'], [-123456789, '-$1,234,567.89'],
  ])('%i cents reads %s', (cents, want) => {
    expect(changeMoney(cents)).toBe(want);
  });

  it('reads a calendar day without shifting it', () => {
    expect(changeDay('2026-10-03')).toBe('Oct 3');
    expect(changeDay('2026-01-31T23:59:00Z')).toBe('Jan 31');
  });
});

describe('summaries — one per kind, bank text raw', () => {
  const cases: Array<[string, ChangeDraft, string]> = [
    ['import', importChange({
      account: CHECKING, txKey: KEY, activityId: 'act-1', description: 'SQ *BLUE_BOTTLE', amountCents: -650,
      date: '2026-10-11', pending: true, activityType: 'WITHDRAWAL',
    }), 'Imported SQ *BLUE_BOTTLE (pending)'],
    ['bank-update', bankUpdateChange({
      account: CHECKING, txKey: KEY, activityId: 'act-1', description: 'KROGER #123', amountCents: -1234,
      before: { absCents: 1200, date: '2026-10-03', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 1234, date: '2026-10-04', pending: false, activityType: 'WITHDRAWAL' },
    }), 'Updated KROGER #123 from the bank: $12.00 → $12.34, Oct 3 → Oct 4, posted'],
    ['pending-removed', pendingRemovedChange({
      account: CHECKING, txKey: KEY, activityId: 'act-2', description: 'UBER *TRIP', amountCents: -1810, date: '2026-10-10',
    }), 'Removed pending UBER *TRIP — the bank dropped it'],
    ['transfer-type held', transferTypeChange({
      account: CHECKING, txKey: KEY, activityId: 'act-3', description: 'TRANSFER TO SAV', amountCents: -50000,
      date: '2026-10-09', activityType: 'TRANSFER_OUT', previousType: null, held: true,
    }), 'Held TRANSFER TO SAV as a transfer in transit'],
    ['transfer-type expired', transferTypeChange({
      account: CHECKING, txKey: KEY, activityId: 'act-3', description: 'ZELLE FROM MOM', amountCents: 4000,
      date: '2026-09-28', activityType: 'DEPOSIT', previousType: 'CREDIT', held: false,
    }), 'Stopped waiting for the other half of ZELLE FROM MOM — now counted as money in'],
    ['transfer-link', transferLinkChange(
      { account: CHECKING, txKey: KEY, description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-10-08', oldActivityId: 'old-1', newActivityId: 'new-1' },
      { account: CARD, txKey: accountTxKey('ACT-9c8d', 'TRN-a1b2'), description: 'PAYMENT THANK YOU', amountCents: 46460, date: '2026-10-08', oldActivityId: 'old-2', newActivityId: 'new-2' },
    ), 'Linked CITI AUTOPAY and PAYMENT THANK YOU as one transfer'],
    ['duplicate-removed', duplicateRemovedChange({
      account: CHECKING, txKey: KEY, activityId: 'act-dup', description: 'TRADER JOE S #628', amountCents: -2120,
      date: '2026-08-06', payload: { accountId: 'wf-checking', activityType: 'WITHDRAWAL', activityDate: '2026-08-06', amount: 21.2, currency: 'USD', comment: 'TRADER JOE S #628 · TRN-a1b2' },
    }), 'Removed a duplicate copy of TRADER JOE S #628'],
    ['starting-balance', startingBalanceChange({
      account: CARD, activityId: 'sb-1', amountCents: -46460, date: '2026-06-18', activityType: 'WITHDRAWAL', comment: 'Starting balance · ACT-9c8d',
    }), 'Set the starting balance, dated Jun 18'],
    ['starting-balance-moved (date)', startingBalanceMovedChange({
      account: CHECKING, actor: 'auto', activityId: 'sb-2',
      before: { amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' },
      after: { amountCents: 120000, date: '2026-04-22', activityType: 'CREDIT' },
    }), 'Moved the starting balance to Apr 22 (was Jun 19)'],
    ['starting-balance-moved (amount)', startingBalanceMovedChange({
      account: CHECKING, actor: 'you', activityId: 'sb-2',
      before: { amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' },
      after: { amountCents: 125000, date: '2026-06-19', activityType: 'CREDIT' },
    }), 'Changed the starting balance (was $1,200.00)'],
    ['starting-balance-moved (both)', startingBalanceMovedChange({
      account: CHECKING, actor: 'auto', activityId: 'sb-2',
      before: { amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' },
      after: { amountCents: 80000, date: '2026-04-22', activityType: 'CREDIT' },
    }), 'Changed the starting balance and moved it to Apr 22 (was $1,200.00 on Jun 19)'],
    ['balance-correction', balanceCorrectionChange({
      account: CHECKING, actor: 'auto', activityId: 'plug-1', amountCents: -215, date: '2026-10-12', activityType: 'TRANSFER_OUT',
      comment: 'Balance adjustment · ACT-1f2e · 2026-10-12',
    }), 'Added a balance correction'],
    ['amazon-label', amazonLabelChange({
      account: CARD, txKey: KEY, activityId: 'act-4', description: 'AMAZON MKTPL*2K4', amountCents: -1080, date: '2026-09-15',
      beforeNote: 'AMAZON MKTPL*2K4 · TRN-a1b2', afterNote: 'AMAZON MKTPL*2K4 · Amazon: Hair Care · TRN-a1b2', label: 'Hair Care',
    }), 'Added the Amazon label "Hair Care" to AMAZON MKTPL*2K4'],
    ['category-filed (first)', categoryFiledChange({
      actor: 'auto', account: CARD, activityId: 'act-4', description: 'AMAZON MKTPL*2K4',
      before: null, after: { categoryId: 'cat-hair', categoryName: 'Personal Care' }, why: 'Amazon: Hair Care',
    }), 'Filed AMAZON MKTPL*2K4 under Personal Care'],
    ['category-filed (move)', categoryFiledChange({
      actor: 'you', activityId: 'act-5', description: 'VENMO *J SMITH',
      before: { categoryId: 'cat-din', categoryName: 'Dining' }, after: { categoryId: 'cat-gro', categoryName: 'Groceries' },
    }), 'Moved VENMO *J SMITH from Dining to Groceries'],
    ['category-filed (off)', categoryFiledChange({
      actor: 'you', activityId: 'act-5', description: '',
      before: { categoryId: 'cat-gro', categoryName: 'Groceries' }, after: null,
    }), 'Took a transaction out of Groceries'],
    ['opening-balance-filed', openingBalanceFiledChange({
      account: CARD, activityId: 'sb-1', amountCents: -46460, date: '2026-06-18',
      category: { categoryId: 'cat-open', categoryName: 'Opening balances' },
    }), 'Filed the opening balance under Opening balances'],
    ['category-rule-created', categoryRuleCreatedChange({
      ruleId: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro', categoryName: 'Groceries',
    }), 'Created a rule: descriptions containing "TRADER JOE S" go to Groceries'],
    ['mapping-rule-created', mappingRuleCreatedChange({
      rule: { pattern: 'Payment to Ccb', matchType: 'contains', activityType: 'TRANSFER_OUT' }, description: 'Payment to Ccb Credit Card',
    }), 'Added a transaction rule: "Payment to Ccb" is a transfer out'],
    ['account-created', accountCreatedChange({ sfinId: 'ACT-9c8d', wfId: 'wf-citi', name: 'Citi Card', accountType: 'CREDIT_CARD' }),
      'Created a Wealthfolio account'],
    ['budget-set', budgetSetChange({ targetId: 'bt-1', categoryId: 'cat-gro', categoryName: 'Groceries', amountCents: 42500 }),
      'Set a $425.00 monthly budget for Groceries'],
    ['bookkeeping', bookkeepingChange({ step: 'legacy-placeholder', account: CHECKING, activityIds: ['a', 'b'] }),
      'Restated 2 old placeholder rows with their real amounts'],
  ];

  it.each(cases)('%s', (_name, draft, summary) => {
    expect(draft.summary).toBe(summary);
  });

  it('covers every kind', () => {
    expect(new Set(cases.map(([, d]) => d.kind))).toEqual(new Set(CHANGE_KINDS));
  });

  it('words each bookkeeping step, singular and plural', () => {
    expect(bookkeepingChange({ step: 'legacy-placeholder', activityIds: ['a'] }).summary).toBe('Restated 1 old placeholder row with its real amount');
    expect(bookkeepingChange({ step: 'external-marker', activityIds: ['a'] }).summary).toBe("Marked 1 bookkeeping row as outside transfers for Wealthfolio's Health page");
    expect(bookkeepingChange({ step: 'transfer-relink', activityIds: ['a', 'b'] }).summary).toBe('Re-created 2 old transfer rows so they move cash');
    expect(bookkeepingChange({ step: 'opening-category', activityIds: [], categoryName: 'Opening balances' }).summary)
      .toBe('Set up the "Opening balances" category and kept it out of spending');
  });
});

describe('what R2 needs to undo it (P1)', () => {
  it('an import carries its activity id and tx key', () => {
    const d = importChange({
      account: CHECKING, txKey: KEY, activityId: 'act-1', description: 'X', amountCents: -100, date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
    });
    expect(d).toMatchObject({ undoable: true, actor: 'auto', after: { activityType: 'WITHDRAWAL', pending: false }, subject: { activityIds: ['act-1'], txKeys: [KEY] } });
    expect(d.subject.txKeys).toEqual([KEY]);
  });

  it('a link carries both tx keys and both NEW activity ids', () => {
    const inKey = accountTxKey('ACT-9c8d', 'TRN-a1b2');
    const d = transferLinkChange(
      { account: CHECKING, txKey: KEY, description: 'A', amountCents: -100, date: '2026-10-08', oldActivityId: 'old-1', newActivityId: 'new-1' },
      { account: CARD, txKey: inKey, description: 'B', amountCents: 100, date: '2026-10-08', oldActivityId: 'old-2', newActivityId: 'new-2' },
    );
    expect(d.subject).toMatchObject({ txKeys: [KEY, inKey], activityIds: ['new-1', 'new-2'] });
    expect(d.before).toEqual({ activityIds: ['old-1', 'old-2'] });
    expect(d.after).toMatchObject({
      activityIds: ['new-1', 'new-2'],
      legs: [{ txKey: KEY, accountName: 'Checking', description: 'A' }, { txKey: inKey, accountName: 'Citi Card', description: 'B' }],
    });
  });

  it('a link without new ids still carries the tx keys', () => {
    const d = transferLinkChange(
      { account: CHECKING, txKey: KEY, description: 'A', amountCents: -100, date: '2026-10-08', oldActivityId: 'old-1' },
      { account: CARD, txKey: 'k2', description: 'B', amountCents: 100, date: '2026-10-08', oldActivityId: 'old-2' },
    );
    expect(d.subject.activityIds).toBeUndefined();
    expect(d.subject.txKeys).toEqual([KEY, 'k2']);
  });

  it('a removed duplicate carries its full create payload', () => {
    const payload = { accountId: 'wf-checking', activityType: 'WITHDRAWAL', activityDate: '2026-08-06', amount: 21.2, currency: 'USD', comment: 'X · TRN-a1b2' };
    expect(duplicateRemovedChange({ account: CHECKING, txKey: KEY, activityId: 'dup', description: 'X', amountCents: -2120, date: '2026-08-06', payload }).before)
      .toEqual({ activityId: 'dup', activity: payload });
  });

  it('a moved baseline carries its prior amount and date', () => {
    const d = startingBalanceMovedChange({
      account: CHECKING, actor: 'auto', activityId: 'sb-2',
      before: { amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' },
      after: { amountCents: 120000, date: '2026-04-22', activityType: 'CREDIT' },
    });
    expect(d.before).toEqual({ activityId: 'sb-2', amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' });
  });

  it('a balance correction carries the row id, account and amount', () => {
    const d = balanceCorrectionChange({
      account: CHECKING, actor: 'you', activityId: 'plug-1', amountCents: 215, date: '2026-10-12', activityType: 'CREDIT', comment: 'Balance adjustment · ACT-1f2e · 2026-10-12',
    });
    expect(d.after).toMatchObject({ activityId: 'plug-1', accountId: 'wf-checking', amountCents: 215 });
    expect(d.why).toBeUndefined();
  });

  it('a filing carries the prior category id and name, or none', () => {
    const first = categoryFiledChange({ actor: 'auto', activityId: 'a', description: 'X', before: null, after: { categoryId: 'c1', categoryName: 'Groceries' } });
    expect(first.before).toEqual({ categoryId: null, categoryName: null });
    const move = categoryFiledChange({
      actor: 'you', activityId: 'a', description: 'X',
      before: { categoryId: 'c0', categoryName: 'Dining', taxonomyId: 'spending_categories' },
      after: { categoryId: 'c1', categoryName: 'Groceries' },
      restore: [{ taxonomyId: 'spending_categories', categoryId: 'c0' }, { taxonomyId: 'income_categories', categoryId: 'i1' }],
    });
    expect(move.before).toEqual({
      categoryId: 'c0', categoryName: 'Dining', taxonomyId: 'spending_categories',
      assignments: [{ taxonomyId: 'spending_categories', categoryId: 'c0' }, { taxonomyId: 'income_categories', categoryId: 'i1' }],
    });
  });

  it('a rule carries its id, pattern and category', () => {
    const d = categoryRuleCreatedChange({ ruleId: 'rule-7', name: 'Telegram: X', pattern: 'X', categoryId: 'c1', categoryName: 'Groceries' });
    expect(d.subject).toEqual({ ruleId: 'rule-7', rulePattern: 'X', categoryName: 'Groceries' });
    expect(d.after).toEqual({ ruleId: 'rule-7', name: 'Telegram: X', pattern: 'X', categoryId: 'c1', categoryName: 'Groceries' });
    expect(categoryRuleCreatedChange({ ruleId: null, name: 'n', pattern: 'X', categoryId: 'c1', categoryName: 'G' }).subject.ruleId).toBeUndefined();
  });

  it('a late label carries the label text and both notes', () => {
    expect(amazonLabelOf('AMAZON MKTPL', 'AMAZON MKTPL · Amazon: mixed — Books + Toys')).toBe('mixed — Books + Toys');
    const d = amazonLabelChange({
      account: CARD, txKey: KEY, activityId: 'a', description: 'AMAZON MKTPL', amountCents: -100, date: '2026-09-15',
      beforeNote: 'AMAZON MKTPL · TRN-1', afterNote: 'AMAZON MKTPL · Amazon: Books · TRN-1', label: 'Books',
    });
    expect(d.before).toEqual({ comment: 'AMAZON MKTPL · TRN-1' });
    expect(d.after).toEqual({ comment: 'AMAZON MKTPL · Amazon: Books · TRN-1', label: 'Books' });
  });

  it('bank changes and bookkeeping are never undoable', () => {
    const update = bankUpdateChange({
      account: CHECKING, txKey: KEY, activityId: 'a', description: 'X', amountCents: -1,
      before: { absCents: 1, date: '2026-10-01', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 1, date: '2026-10-01', pending: false, activityType: 'WITHDRAWAL' },
    });
    expect(update.undoable).toBe(false);
    expect(pendingRemovedChange({ account: CHECKING, txKey: KEY, activityId: 'a', description: 'X', amountCents: -1, date: '2026-10-01' }).undoable).toBe(false);
    expect(bookkeepingChange({ step: 'external-marker', activityIds: ['a'] }).undoable).toBe(false);
    expect(accountCreatedChange({ sfinId: 's', wfId: 'w', name: 'N', accountType: 'CASH' }).undoable).toBe(false);
    expect(transferTypeChange({
      account: CHECKING, txKey: KEY, activityId: 'a', description: 'X', amountCents: -1, date: '2026-10-01',
      activityType: 'WITHDRAWAL', previousType: 'TRANSFER_OUT', held: false,
    }).undoable).toBe(false);
  });

  it('a subtype-only update says what it was marked', () => {
    const d = bankUpdateChange({
      account: CHECKING, txKey: KEY, activityId: 'a', description: 'VENMO', amountCents: 500,
      before: { absCents: 500, date: '2026-10-01', pending: false, activityType: 'CREDIT', subtype: null },
      after: { absCents: 500, date: '2026-10-01', pending: false, activityType: 'CREDIT', subtype: 'REIMBURSEMENT' },
    });
    expect(d.summary).toBe('VENMO marked REIMBURSEMENT');
    expect(d.why).toBe('A rule changed it');
  });

  it('a type-only update is the sync retyping it, not the bank', () => {
    const d = bankUpdateChange({
      account: CHECKING, txKey: KEY, activityId: 'a', description: 'Online Transfer', amountCents: -500,
      before: { absCents: 500, date: '2026-10-01', pending: false, activityType: 'WITHDRAWAL' },
      after: { absCents: 500, date: '2026-10-01', pending: false, activityType: 'TRANSFER_OUT' },
    });
    expect(d.summary).toBe('Retyped Online Transfer: WITHDRAWAL → TRANSFER_OUT');
    expect(d.why).toBe('The sync retyped it');
  });

  it('an amount, date or pending change is still the bank, and a new tx id keeps the old key', () => {
    const d = bankUpdateChange({
      account: CHECKING, txKey: KEY, activityId: 'a', description: 'X', amountCents: -600, previousTxKey: 'old-key',
      before: { absCents: 500, date: '2026-10-01', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 600, date: '2026-10-01', pending: false, activityType: 'WITHDRAWAL' },
    });
    expect(d.why).toBe('The bank changed it');
    expect(d.before).toMatchObject({ txKey: 'old-key' });
  });

  it('an import entry stays small at real id lengths', () => {
    const uuid = (n: number) => `${n}`.repeat(8).slice(0, 8) + '-aaaa-bbbb-cccc-dddddddddddd';
    const d = importChange({
      account: { sfinId: `ACT-${uuid(1)}`, wfId: uuid(2), name: 'Everyday Checking' },
      txKey: accountTxKey(`ACT-${uuid(1)}`, `TRN-${uuid(3)}`), activityId: uuid(4),
      description: 'KROGER #123 SPRINGFIELD', amountCents: -1234, date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
    });
    const entry = stampChange(d, 'companion', new Date('2026-10-12T14:05:00Z'), 'cmgt1abc');
    expect(JSON.stringify(entry).length).toBeLessThan(700);
  });
});

describe('transfer-unlink summary', () => {
  it('pluralises for several pairs', () => {
    expect(bookkeepingChange({ step: 'transfer-unlink', activityIds: ['a', 'b'] }).summary)
      .toBe('Unlinked a transfer you undid: re-created its 2 rows as spending or money in');
    expect(bookkeepingChange({ step: 'transfer-unlink', pairs: 3, rows: 6, activityIds: ['a', 'b', 'c', 'd', 'e', 'f'] }).summary)
      .toBe('Unlinked 3 transfers you undid: re-created their 6 rows as spending or money in');
  });
});
