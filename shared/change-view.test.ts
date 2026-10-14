import { describe, it, expect } from 'vitest';
import {
  amazonLabelChange, bankUpdateChange, bookkeepingChange, categoryFiledChange, CHANGE_KINDS, importChange,
  stampChange, startingBalanceMovedChange, transferLinkChange, transferTypeChange, venmoNoteChange, type ChangeDraft,
} from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import {
  changeAccountNames, changeAccountText, changeAmountText, changeBeforeAfter, changeClock, changeGroupOf,
  changeLocalDay, changeLogNotes, changeRows, changeRowSummary, changeSourceText, changesWithin, matchesChangeSearch,
} from './change-view.js';
import { accountTxKey } from './transfers.js';

const CHECKING = { sfinId: 'ACT-1f2e', wfId: 'wf-checking', name: 'Checking' };
const CARD = { sfinId: 'ACT-9c8d', wfId: 'wf-citi', name: 'Citi Card' };
/** Local wall-clock moments, so the clock and day assertions hold in any TZ. */
const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m);
const item = (draft: ChangeDraft, when: Date, run?: string): ChangeLogItem => stampChange(draft, 'companion', when, run);
const imp = (n: number, when: Date, run?: string) => item(importChange({
  account: CHECKING, txKey: accountTxKey('ACT-1f2e', `TRN-${n}`), activityId: `act-${n}`, description: `KROGER #${n}`,
  amountCents: -1234, date: '2026-10-11', pending: false, activityType: 'WITHDRAWAL',
}), when, run);

describe('groups', () => {
  it('puts every kind in one of the six groups', () => {
    for (const kind of CHANGE_KINDS) {
      expect(['categories', 'transfers', 'corrections', 'imports', 'rules', 'background']).toContain(changeGroupOf(kind));
    }
    expect(changeGroupOf('bookkeeping')).toBe('background');
    expect(changeGroupOf('import')).toBe('imports');
    expect(changeGroupOf('category-rule-created')).toBe('rules');
    expect(changeGroupOf('venmo-note')).toBe('categories');
  });

  it('shows a kind from a newer version instead of hiding it', () => {
    expect(changeGroupOf('subscription-hidden')).toBe('corrections');
  });
});

describe('words for one entry', () => {
  it('names both accounts of a transfer link', () => {
    const link = item(transferLinkChange(
      { account: CHECKING, txKey: 'k1', description: 'CITI AUTOPAY', amountCents: -46460, date: '2026-10-08', oldActivityId: 'o1', newActivityId: 'n1' },
      { account: CARD, txKey: 'k2', description: 'PAYMENT THANK YOU', amountCents: 46460, date: '2026-10-08', oldActivityId: 'o2', newActivityId: 'n2' },
    ), at(8, 9, 0));
    expect(changeAccountNames(link)).toEqual(['Checking', 'Citi Card']);
    expect(changeAccountText(link)).toBe('Checking → Citi Card');
    expect(changeAmountText(link)).toBe('-$464.60');
  });

  it('says who did it', () => {
    expect(changeSourceText({ writer: 'companion', actor: 'auto' })).toBe('Automatic — the background sync');
    expect(changeSourceText({ writer: 'addon', actor: 'auto' })).toBe('Automatic — a sync in the app');
    expect(changeSourceText({ writer: 'companion', actor: 'you' })).toBe('You, in Telegram');
    expect(changeSourceText({ writer: 'addon', actor: 'you' })).toBe('You, in the app');
  });

  it.each([
    ['a filing', categoryFiledChange({ actor: 'auto', activityId: 'a', description: 'X', before: null, after: { categoryId: 'c', categoryName: 'Groceries' } }),
      'No category → Groceries'],
    ['a move', categoryFiledChange({ actor: 'you', activityId: 'a', description: 'X', before: { categoryId: 'd', categoryName: 'Dining' }, after: { categoryId: 'c', categoryName: 'Groceries' } }),
      'Dining → Groceries'],
    ['a baseline move', startingBalanceMovedChange({
      account: CHECKING, actor: 'auto', activityId: 'sb',
      before: { amountCents: 120000, date: '2026-06-19', activityType: 'CREDIT' }, after: { amountCents: 80000, date: '2026-04-22', activityType: 'CREDIT' },
    }), '$1,200.00 on Jun 19 → $800.00 on Apr 22'],
    ['a bank update', bankUpdateChange({
      account: CHECKING, txKey: 'k', activityId: 'a', description: 'X', amountCents: -1234,
      before: { absCents: 1200, date: '2026-10-03', pending: true, activityType: 'WITHDRAWAL' },
      after: { absCents: 1234, date: '2026-10-03', pending: false, activityType: 'WITHDRAWAL' },
    }), '$12.00 → $12.34, posted'],
    ['a late label', amazonLabelChange({
      account: CARD, txKey: 'k', activityId: 'a', description: 'AMAZON', amountCents: -1, date: '2026-09-15',
      beforeNote: 'AMAZON · TRN-1', afterNote: 'AMAZON · Amazon: Books · TRN-1', label: 'Books',
    }), 'AMAZON · TRN-1 → AMAZON · Amazon: Books · TRN-1'],
    ['a Venmo note', venmoNoteChange({
      account: CHECKING, txKey: 'k', activityId: 'a', description: 'VENMO', amountCents: -2500, date: '2026-10-04',
      beforeNote: 'VENMO · TRN-1', afterNote: 'VENMO · Venmo: Rent · TRN-1', note: 'Rent',
    }), 'VENMO · TRN-1 → VENMO · Venmo: Rent · TRN-1'],
    ['a held transfer', transferTypeChange({
      account: CHECKING, txKey: 'k', activityId: 'a', description: 'X', amountCents: -1, date: '2026-10-01',
      activityType: 'TRANSFER_OUT', previousType: null, held: true,
    }), 'New → TRANSFER_OUT (in transit)'],
  ])('before → after for %s', (_name, draft, want) => {
    expect(changeBeforeAfter(item(draft, at(12, 9, 0)))).toBe(want);
  });

  it('has no before → after for an import', () => {
    expect(changeBeforeAfter(imp(1, at(12, 9, 0)))).toBeNull();
  });
});

describe('search', () => {
  const filed = item(categoryFiledChange({
    actor: 'auto', account: CARD, activityId: 'a', description: 'AMAZON MKTPL*2K4', before: { categoryId: 'o', categoryName: 'Online Shopping' },
    after: { categoryId: 'p', categoryName: 'Personal Care' },
  }), at(12, 9, 0));

  it('matches description, account and either category, every word, any case', () => {
    expect(matchesChangeSearch(filed, 'amazon')).toBe(true);
    expect(matchesChangeSearch(filed, 'citi personal')).toBe(true);
    expect(matchesChangeSearch(filed, 'ONLINE')).toBe(true);
    expect(matchesChangeSearch(filed, 'amazon groceries')).toBe(false);
    expect(matchesChangeSearch(filed, '   ')).toBe(true);
  });

  it('does not match the summary’s own verbs', () => {
    expect(matchesChangeSearch(filed, 'filed')).toBe(false);
  });
});

describe('rows', () => {
  it('collapses one run’s imports into one row at the newest import’s place', () => {
    const entries = [
      imp(3, at(12, 14, 5), 'runA'),
      item(bookkeepingChange({ step: 'external-marker', activityIds: ['x'] }), at(12, 14, 5), 'runA'),
      imp(2, at(12, 14, 4), 'runA'),
      imp(9, at(12, 9, 0), 'runB'),
      imp(1, at(12, 8, 0), 'runA'),
    ];
    const rows = changeRows(entries);
    expect(rows.map((r) => r.kind)).toEqual(['run', 'entry', 'entry']);
    expect(rows[0].kind === 'run' && rows[0].entries.map((e) => e.subject.activityIds![0])).toEqual(['act-3', 'act-2', 'act-1']);
    expect(changeRowSummary(rows[0])).toBe('Imported 3 transactions');
    expect(changeRowSummary(rows[2])).toBe('Imported KROGER #9');
  });

  it('says "1 transaction" for a run of one', () => {
    expect(changeRowSummary({ kind: 'run', run: 'runA', entries: [imp(1, at(12, 8, 0), 'runA')] } as never)).toBe('Imported 1 transaction');
  });

  it('keeps the window and the local clock', () => {
    const now = at(12, 15, 0);
    const recent = imp(1, at(10, 7, 9));
    const old = imp(2, at(1, 7, 9));
    expect(changesWithin([recent, old], now, 7)).toEqual([recent]);
    expect(changeClock(recent.at)).toBe('07:09');
    expect(changeLocalDay(recent.at)).toBe('2026-10-10');
  });
});

describe('changeLogNotes', () => {
  it('words gaps, trims and unreadable buckets', () => {
    expect(changeLogNotes({
      gaps: [{ at: at(12, 10, 0).toISOString(), count: 3, reason: "couldn't save the log", writer: 'companion' }],
      trimmed: 12,
      unreadable: [{ writer: 'companion', month: '2026-10', paused: false }, { writer: 'addon', month: '2026-09', paused: true }],
    })).toEqual([
      "3 changes may be missing — couldn't save the log Oct 12.",
      '12 older changes were trimmed to keep the log small.',
      "Part of the companion's log for October 2026 can't be read — it was left as it was.",
      "The app's log for September 2026 can't be read, so its new changes aren't being saved.",
    ]);
    expect(changeLogNotes({ gaps: [{ at: at(12, 10, 0).toISOString(), count: 1, reason: 'x', writer: 'addon' }], trimmed: 1, unreadable: [] }))
      .toEqual(['1 change may be missing — x Oct 12.', '1 older change was trimmed to keep the log small.']);
  });
});
