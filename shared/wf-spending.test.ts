import { describe, it, expect } from 'vitest';
import {
  effectiveType, excludedWithDescendants, isSpendingBucket, localDay, spendLine, spendLines, spentCents, topCategoryId, wfSpendSign,
  type SpendRow, type SpendScope,
} from './wf-spending.js';

let seq = 0;
const row = (over: Partial<SpendRow> = {}): SpendRow => {
  seq += 1;
  return {
    id: `act-${seq}`, date: '2026-10-05T12:00:00+00:00', accountId: 'wf-chk', accountName: 'PNC Checking', accountType: 'CASH',
    type: 'WITHDRAWAL', subtype: '', groupId: '', absCents: 1000, notes: `SHOP · TRN-${seq}`,
    filings: [{ id: `asg-${seq}`, categoryId: 'cat-food', createdAt: '2026-10-05T13:00:00Z', source: 'manual' }], splits: [],
    ...over,
  };
};
const NY: SpendScope = { timezone: 'America/New_York', spendingAccountIds: null, excludedCategoryIds: [], categoryParents: {} };

describe('wfSpendSign — Wealthfolio’s classifier (3.8–3.10)', () => {
  it.each([
    ['CASH', 'WITHDRAWAL', '', 1], ['CASH', 'TRANSFER_OUT', '', 1], ['CASH', 'FEE', '', 1], ['CASH', 'TAX', '', 1],
    ['CASH', 'CREDIT', 'REFUND', -1], ['CASH', 'CREDIT', 'REBATE', -1], ['CASH', 'CREDIT', 'REIMBURSEMENT', -1],
    ['CASH', 'CREDIT', '', 0], ['CASH', 'CREDIT', 'BONUS', 0], ['CASH', 'DEPOSIT', '', 0], ['CASH', 'TRANSFER_IN', '', 0], ['CASH', 'INTEREST', '', 0],
    ['CREDIT_CARD', 'WITHDRAWAL', '', 1], ['CREDIT_CARD', 'FEE', '', 1], ['CREDIT_CARD', 'INTEREST', '', 1], ['CREDIT_CARD', 'CREDIT', '', -1],
    ['CREDIT_CARD', 'TRANSFER_OUT', '', 0], ['CREDIT_CARD', 'TRANSFER_IN', '', 0], ['SECURITIES', 'WITHDRAWAL', '', 0],
  ] as const)('%s %s %s → %d', (accountType, type, subtype, sign) => {
    expect(wfSpendSign({ accountType, type, subtype, groupId: '' })).toBe(sign);
  });

  it('never counts a linked transfer, inside the spending accounts or crossing out of them', () => {
    expect(wfSpendSign({ accountType: 'CASH', type: 'TRANSFER_OUT', subtype: '', groupId: 'g-1' })).toBe(0);
    expect(wfSpendSign({ accountType: 'CREDIT_CARD', type: 'TRANSFER_IN', subtype: '', groupId: 'g-1' })).toBe(0);
    // A grouped row that is not a transfer is classified as itself.
    expect(wfSpendSign({ accountType: 'CASH', type: 'WITHDRAWAL', subtype: '', groupId: 'g-1' })).toBe(1);
  });

  it('classifies by the effective type: a non-blank override wins, a blank one is none', () => {
    expect(effectiveType({ type: 'TRANSFER_OUT', typeOverride: 'WITHDRAWAL' })).toBe('WITHDRAWAL');
    expect(effectiveType({ type: 'WITHDRAWAL', typeOverride: '  ' })).toBe('WITHDRAWAL');
    expect(wfSpendSign({ accountType: 'CASH', type: 'WITHDRAWAL', typeOverride: 'DEPOSIT', subtype: '', groupId: '' })).toBe(0);
    expect(wfSpendSign({ accountType: 'CASH', type: 'TRANSFER_OUT', typeOverride: 'TRANSFER_OUT', subtype: '', groupId: 'g' })).toBe(0);
    expect(isSpendingBucket({ accountType: 'CASH', type: 'DEPOSIT', typeOverride: 'WITHDRAWAL', subtype: '', groupId: '' })).toBe(true);
  });
});

describe('localDay — Wealthfolio places a row by its local date', () => {
  it('puts a row stored at 00:00 UTC on the 1st in the previous month west of UTC, and noon on the day itself', () => {
    expect(localDay('2026-10-01T00:00:00+00:00', 'America/New_York')).toBe('2026-09-30');
    expect(localDay('2026-10-01', 'America/New_York')).toBe('2026-09-30');
    expect(localDay('2026-10-01T12:00:00+00:00', 'America/New_York')).toBe('2026-10-01');
    expect(localDay('2026-10-01T12:00:00Z', 'Pacific/Auckland')).toBe('2026-10-02');
    // 3.10 stores a hand-entered date at the zone's own midnight.
    expect(localDay('2026-10-01T04:00:00+00:00', 'America/New_York')).toBe('2026-10-01');
  });

  it('reads an unknown zone as the process’s own, and an unreadable date as none', () => {
    const d = new Date('2026-10-05T12:00:00Z');
    const own = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(localDay('2026-10-05T12:00:00Z', 'Mars/Olympus')).toBe(own);
    expect(localDay('2026-10-05T12:00:00Z', null)).toBe(own);
    expect(localDay('soon', 'America/New_York')).toBeNull();
  });
});

describe('spendLine — the allocation and the exclusions', () => {
  const excludedNone = new Set<string>();

  it('allocates a row filed twice to its EARLIEST filing, once', () => {
    const line = spendLine(row({ filings: [
      { id: 'b', categoryId: 'cat-late', createdAt: '2026-10-06T00:00:00Z', source: 'rule' },
      { id: 'a', categoryId: 'cat-early', createdAt: '2026-10-05T00:00:00Z', source: 'manual' },
    ] }), NY, excludedNone)!;
    expect(line.cents).toBe(1000);
    expect(line.allocations).toEqual([{ categoryId: 'cat-early', cents: 1000, source: 'manual' }]);
  });

  it('breaks a created-at tie by the filing’s id', () => {
    const at = '2026-10-05T00:00:00Z';
    const line = spendLine(row({ filings: [
      { id: 'z', categoryId: 'cat-z', createdAt: at, source: '' }, { id: 'm', categoryId: 'cat-m', createdAt: at, source: '' },
    ] }), NY, excludedNone)!;
    expect(line.allocations.map((a) => a.categoryId)).toEqual(['cat-m']);
  });

  it('lets split lines win over the filing, signed like the row', () => {
    const splits = [{ categoryId: 'cat-food', absCents: 600 }, { categoryId: 'cat-home', absCents: 400 }];
    expect(spendLine(row({ splits }), NY, excludedNone)!.allocations).toEqual([
      { categoryId: 'cat-food', cents: 600, source: '' }, { categoryId: 'cat-home', cents: 400, source: '' },
    ]);
    const refund = spendLine(row({ type: 'CREDIT', subtype: 'REFUND', splits }), NY, excludedNone)!;
    expect(refund.allocations.map((a) => a.cents)).toEqual([-600, -400]);
    expect(refund.cents).toBe(-1000);
  });

  it('nets a refund with no category against Uncategorized', () => {
    const line = spendLine(row({ accountType: 'CREDIT_CARD', type: 'CREDIT', filings: [] }), NY, excludedNone)!;
    expect(line).toMatchObject({ cents: -1000, uncategorizedCents: -1000, allocations: [] });
  });

  it('drops an excluded allocation, and its descendants, but never an uncategorized row', () => {
    const parents = { 'cat-school': null, 'cat-tuition': 'cat-school', 'cat-food': null };
    const excluded = excludedWithDescendants(['cat-school'], parents);
    expect([...excluded].sort()).toEqual(['cat-school', 'cat-tuition']);
    expect(spendLine(row({ filings: [{ id: 'x', categoryId: 'cat-tuition', createdAt: '', source: '' }] }), NY, excluded)).toBeNull();
    const split = spendLine(row({ splits: [{ categoryId: 'cat-tuition', absCents: 700 }, { categoryId: 'cat-food', absCents: 300 }] }), NY, excluded)!;
    expect(split).toMatchObject({ cents: 300, allocations: [{ categoryId: 'cat-food', cents: 300, source: '' }], uncategorizedCents: 0 });
    expect(spendLine(row({ filings: [] }), NY, excluded)).toMatchObject({ cents: 1000, uncategorizedCents: 1000 });
  });

  it('counts only the accounts the Spending page reads', () => {
    const scope = { ...NY, spendingAccountIds: ['wf-card'] };
    expect(spendLine(row(), scope, excludedNone)).toBeNull();
    expect(spendLine(row({ accountId: 'wf-card', accountType: 'CREDIT_CARD' }), scope, excludedNone)).not.toBeNull();
  });

  it('places the line on Wealthfolio’s local day and month', () => {
    expect(spendLine(row({ date: '2026-10-01T00:00:00+00:00' }), NY, excludedNone)).toMatchObject({ day: '2026-09-30', month: '2026-09' });
    expect(spendLine(row({ date: '2026-10-01T12:00:00+00:00' }), NY, excludedNone)).toMatchObject({ day: '2026-10-01', month: '2026-10' });
  });
});

describe('spendLines and spentCents', () => {
  it('sums what Wealthfolio’s headline counts: expenses less refunds, excluded categories left out', () => {
    const lines = spendLines([
      row({ absCents: 5000 }),
      row({ type: 'CREDIT', subtype: 'REIMBURSEMENT', absCents: 1400 }),
      row({ type: 'DEPOSIT', absCents: 99999 }),
      row({ absCents: 2500, filings: [{ id: 'x', categoryId: 'cat-skip', createdAt: '', source: '' }] }),
      row({ type: 'TRANSFER_OUT', groupId: 'g', absCents: 30000 }),
    ], { ...NY, excludedCategoryIds: ['cat-skip'] });
    expect(lines).toHaveLength(2);
    expect(spentCents(lines)).toBe(3600);
  });

  it('rolls a category up to its top-level ancestor, bounded against a cycle', () => {
    const parents = { a: null, b: 'a', c: 'b', x: 'y', y: 'x' };
    expect(topCategoryId('c', parents)).toBe('a');
    expect(topCategoryId('a', parents)).toBe('a');
    expect(topCategoryId('gone', parents)).toBe('gone');
    expect(['x', 'y']).toContain(topCategoryId('x', parents));
  });
});
