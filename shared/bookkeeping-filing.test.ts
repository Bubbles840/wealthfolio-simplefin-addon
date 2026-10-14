import { describe, it, expect } from 'vitest';
import { isSyncBookkeepingNote, planBookkeepingFiling, SYNC_BOOKKEEPING_CATEGORY, type BookkeepingRow } from './bookkeeping-filing.js';
import { neutralAdjustmentFields, startingBalanceFields } from './sync-core.js';
import { bookkeepingChange } from './change-entries.js';

const CAT = 'cat-sync';
const row = (over: Partial<BookkeepingRow> = {}): BookkeepingRow => ({
  id: 'r', accountType: 'CASH', type: 'TRANSFER_OUT', subtype: '', groupId: '', notes: '↔️ In-transit transfer · ZELLE · TRN-1',
  spendingCategoryIds: [], ...over,
});
const plan = (rows: BookkeepingRow[], categoryId: string | null = CAT) => planBookkeepingFiling(rows, { categoryId });

describe('the sync’s bookkeeping rows, by marker', () => {
  it('knows its three notes and nothing else', () => {
    expect(SYNC_BOOKKEEPING_CATEGORY).toBe('Sync bookkeeping');
    expect(isSyncBookkeepingNote('↔️ In-transit transfer · ZELLE · TRN-1')).toBe(true);
    expect(isSyncBookkeepingNote('Balance adjustment · sfin-1 · 2026-10-02')).toBe(true);
    expect(isSyncBookkeepingNote('Starting balance · sfin-1')).toBe(true);
    expect(isSyncBookkeepingNote('ZELLE TO MOM · TRN-1')).toBe(false);
  });
});

describe('planBookkeepingFiling', () => {
  it('files a spending-bucket placeholder that has no filing', () => {
    expect(plan([row({ id: 'out' })])).toEqual({ file: ['out'], unfile: [] });
  });

  it('files every money-out shape the sync writes, on cash and on a card, and no money-in one', () => {
    const shapes: BookkeepingRow[] = [];
    for (const accountType of ['CASH', 'CREDIT_CARD']) {
      for (const signed of [-50, 50]) {
        const adj = neutralAdjustmentFields(accountType, signed);
        const sb = startingBalanceFields(accountType, signed);
        shapes.push(row({ id: `adj-${accountType}-${signed}`, accountType, type: adj.activityType, notes: 'Balance adjustment · sfin-1 · 2026-10-02' }));
        shapes.push(row({ id: `sb-${accountType}-${signed}`, accountType, type: sb.activityType, notes: 'Starting balance · sfin-1' }));
        shapes.push(row({ id: `ph-${accountType}-${signed}`, accountType, type: signed < 0 ? adj.activityType : 'TRANSFER_IN' }));
      }
    }
    expect(plan(shapes).file.sort()).toEqual([
      'adj-CASH--50', 'adj-CREDIT_CARD--50', 'ph-CASH--50', 'ph-CREDIT_CARD--50', 'sb-CASH--50', 'sb-CREDIT_CARD--50',
    ]);
  });

  it('skips a row Wealthfolio does not count as spending: a linked leg, a card’s transfer out (3.10), an override to money in', () => {
    expect(plan([
      row({ id: 'linked', groupId: 'g-1' }),
      row({ id: 'card-out-310', accountType: 'CREDIT_CARD', type: 'TRANSFER_OUT' }),
      row({ id: 'retyped', type: 'TRANSFER_OUT', typeOverride: 'TRANSFER_IN' }),
    ])).toEqual({ file: [], unfile: [] });
  });

  it('leaves a row filed by hand, by a rule or by the opening-balance filing alone', () => {
    expect(plan([row({ spendingCategoryIds: ['cat-groceries'] }), row({ id: 'opening', notes: 'Starting balance · sfin-c', accountType: 'CREDIT_CARD', type: 'WITHDRAWAL', spendingCategoryIds: ['cat-opening'] })]))
      .toEqual({ file: [], unfile: [] });
  });

  it('takes out a row filed under it that is no longer bookkeeping — a placeholder that expired — and keeps one that still is', () => {
    expect(plan([
      row({ id: 'expired', type: 'WITHDRAWAL', notes: 'ZELLE TO MOM · TRN-1', spendingCategoryIds: [CAT] }),
      row({ id: 'still', spendingCategoryIds: [CAT] }),
      row({ id: 'theirs', type: 'WITHDRAWAL', notes: 'KROGER · TRN-2', spendingCategoryIds: ['cat-groceries'] }),
    ])).toEqual({ file: [], unfile: ['expired'] });
  });

  it('keeps a starting balance unfiled when the person undid its account’s opening filing', () => {
    const rows = [row({ id: 'sb', notes: 'Starting balance · sfin-chk', type: 'WITHDRAWAL' })];
    expect(planBookkeepingFiling(rows, { categoryId: CAT, noOpeningFile: (id) => id === 'sfin-chk' }).file).toEqual([]);
    expect(planBookkeepingFiling(rows, { categoryId: CAT, noOpeningFile: () => false }).file).toEqual(['sb']);
  });

  it('files before the category exists, and takes out nothing then', () => {
    expect(plan([row({ id: 'out' }), row({ id: 'x', notes: 'KROGER · TRN-2', spendingCategoryIds: ['cat-groceries'] })], null)).toEqual({ file: ['out'], unfile: [] });
  });
});

describe('one change-log entry per pass', () => {
  it('names what it filed and what it took out', () => {
    expect(bookkeepingChange({ step: 'sync-bookkeeping', activityIds: ['a', 'b'], unfiledIds: [], categoryName: 'Sync bookkeeping' })).toMatchObject({
      kind: 'bookkeeping', undoable: false, subject: { activityIds: ['a', 'b'] }, after: { step: 'sync-bookkeeping', count: 2, unfiled: 0 },
      summary: 'Filed 2 bookkeeping rows under "Sync bookkeeping", which Wealthfolio leaves out of spending',
    });
    expect(bookkeepingChange({ step: 'sync-bookkeeping', activityIds: [], unfiledIds: ['c'], categoryName: 'Sync bookkeeping' }).summary)
      .toBe('Took 1 row that is no longer bookkeeping out of "Sync bookkeeping"');
    expect(bookkeepingChange({ step: 'sync-bookkeeping', activityIds: ['a'], unfiledIds: ['c', 'd'], categoryName: 'Sync bookkeeping' }))
      .toMatchObject({ subject: { activityIds: ['a', 'c', 'd'] }, summary: 'Filed 1 bookkeeping row under "Sync bookkeeping" and took 2 that are no longer bookkeeping out' });
  });
});
