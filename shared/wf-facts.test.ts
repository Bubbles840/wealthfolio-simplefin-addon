import { describe, it, expect } from 'vitest';
import { cashFactOf, cashFactQuery, filingOfFact, linkedOfFact } from './wf-facts.js';

/** A `CashActivity` as SDK 3.9's `spending.searchCashActivities` returns it. */
const cash = (over: Record<string, unknown> = {}) => ({
  id: 'act-1', accountId: 'wf-chk', activityType: 'TRANSFER_OUT', activityDate: '2026-10-08T12:00:00Z', amount: '600', currency: 'USD',
  notes: 'TO SAVINGS · TRN-1', sourceGroupId: null, cashFlowBucket: 'neutral', assignments: [], splits: [], transferLinkStatus: 'unlinked',
  netAmount: -600, ...over,
});

describe('a row as Wealthfolio files it', () => {
  it.each([
    ['half of a valid pair', { sourceGroupId: 'grp-1', transferLinkStatus: 'linked' }, 'confirmed'],
    ['a transfer leg with no group', {}, false],
    ['a transfer leg in a broken group (deleting it deletes the rest)', { sourceGroupId: 'grp-2', transferLinkStatus: 'invalid' }, 'confirmed'],
    ['ordinary money', { activityType: 'DEPOSIT', transferLinkStatus: null }, false],
    ['ordinary money someone grouped', { activityType: 'WITHDRAWAL', transferLinkStatus: null, sourceGroupId: 'grp-3' }, 'confirmed'],
  ])('%s is linked: %s', (_what, over, linked) => {
    expect(linkedOfFact(cashFactOf(cash(over))!)).toBe(linked);
  });

  it('reads its bucket and what it is filed under — the spending filing first', () => {
    const fact = cashFactOf(cash({
      activityType: 'WITHDRAWAL', transferLinkStatus: null, cashFlowBucket: 'spending',
      assignments: [
        { id: 'a1', activityId: 'act-1', taxonomyId: 'income_sources', categoryId: 'cat-gift', weight: 1, source: 'manual', createdAt: '', updatedAt: '' },
        { id: 'a2', activityId: 'act-1', taxonomyId: 'spending_categories', categoryId: 'cat-food', weight: 1, source: 'rule', createdAt: '', updatedAt: '' },
      ],
    }))!;
    expect(fact.bucket).toBe('spending');
    expect(filingOfFact(fact)).toEqual({ taxonomyId: 'spending_categories', categoryId: 'cat-food', source: 'rule' });
    expect(filingOfFact(cashFactOf(cash())!)).toBeNull();
  });

  it('reads nothing it cannot be sure of: no id, or a link status this build does not know', () => {
    expect(cashFactOf({ ...cash(), id: undefined })).toBeNull();
    expect(cashFactOf(cash({ transferLinkStatus: 'pending-review' }))).toBeNull();
    expect(cashFactOf('row')).toBeNull();
  });
});

describe('finding a row', () => {
  it('searches its account over the UTC day of its stored instant, a full page at a time', () => {
    // 21:30 on the 8th in Los Angeles is 04:30 on the 9th in UTC.
    expect(cashFactQuery({ accountId: 'wf-chk', date: '2026-10-08T21:30:00-07:00' })).toEqual({
      accountIds: ['wf-chk'], startDate: '2026-10-09T00:00:00.000Z', endDate: '2026-10-09T23:59:59.999Z', offset: 0, limit: 1000,
    });
    expect(cashFactQuery({ accountId: 'wf-chk', date: '2026-10-08' }, 1000).offset).toBe(1000);
  });
});
