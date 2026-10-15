import { describe, it, expect, vi } from 'vitest';
import { readCashFacts, readCategoryNames, readTransferPartner } from './wf-facts';

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id, accountId: 'wf-chk', activityType: 'TRANSFER_OUT', activityDate: '2026-10-08T12:00:00Z', sourceGroupId: null,
  cashFlowBucket: 'spending', assignments: [], splits: [], transferLinkStatus: 'unlinked', netAmount: -1, ...over,
});

/** A 3.9+ host's SDK: the cash search (the feature check's too), Wealthfolio's pair, and the category names. */
function host39(pages: Array<{ items: unknown[]; totalCount: number }>) {
  const searchCashActivities = vi.fn(async (req: { offset: number; startDate: string }) =>
    (req.startDate.startsWith('1970') ? undefined : pages[req.offset / 1000]) ?? { items: [], totalCount: 0 });
  return {
    api: {
      spending: {
        searchCashActivities,
        getCategories: vi.fn(async () => [{ kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-food', key: 'food', name: 'Restaurants', path: 'Food / Restaurants' }]),
      },
      activities: {
        getTransferPair: vi.fn(async (id: string) => (id === 'act-out'
          ? { transferOut: { id: 'act-out', accountId: 'wf-chk', activityDate: '2026-10-08T12:00:00Z' }, transferIn: { id: 'act-in', accountId: 'wf-sav', activityDate: '2026-10-09T04:30:00Z' } }
          : null)),
      },
    },
  } as any;
}

describe('Wealthfolio\'s facts, read in the app', () => {
  it('on a 3.8 host reads no facts and calls nothing 3.9 offers', async () => {
    const ctx = { api: { activities: { getTransferPair: vi.fn() }, spending: { getCategories: vi.fn(async () => []) } } } as any;
    expect(await readCashFacts(ctx, [{ id: 'a', accountId: 'wf-chk', date: '2026-10-08' }])).toBeNull();
    expect(await readTransferPartner(ctx, 'a')).toBeUndefined();
    expect(ctx.api.activities.getTransferPair).not.toHaveBeenCalled();
  });

  it('finds each row by its account and UTC day, page by page, and keeps only the rows asked for', async () => {
    const page0 = { items: [...Array.from({ length: 999 }, (_, i) => item(`other-${i}`)), item('act-out', { transferLinkStatus: 'linked', sourceGroupId: 'g' })], totalCount: 1001 };
    const page1 = { items: [item('act-2')], totalCount: 1001 };
    const ctx = host39([page0, page1]);
    const facts = await readCashFacts(ctx, [
      { id: 'act-out', accountId: 'wf-chk', date: '2026-10-08T12:00:00Z' },
      { id: 'act-2', accountId: 'wf-chk', date: '2026-10-08T23:00:00Z' },
      { id: 'act-hidden', accountId: 'wf-chk', date: '2026-10-08T01:00:00Z' },
    ]);
    // The feature check's search, then two pages of the 8th.
    expect(ctx.api.spending.searchCashActivities.mock.calls.map(([r]: [{ offset: number; startDate: string }]) => [r.offset, r.startDate])).toEqual([
      [0, '1970-01-01T00:00:00.000Z'], [0, '2026-10-08T00:00:00.000Z'], [1000, '2026-10-08T00:00:00.000Z'],
    ]);
    expect([...facts!.keys()].sort()).toEqual(['act-2', 'act-out']);
    expect(facts!.get('act-out')).toMatchObject({ link: 'linked', grouped: true });
  });

  it('reads none when the search fails', async () => {
    const ctx = host39([]);
    ctx.api.spending.searchCashActivities = vi.fn()
      .mockResolvedValueOnce({ items: [], totalCount: 0 })
      .mockRejectedValue(new Error('Failed to fetch'));
    expect(await readCashFacts(ctx, [{ id: 'a', accountId: 'wf-chk', date: '2026-10-08' }])).toBeNull();
  });

  it('reads the other half of a linked transfer, and nothing for a row in no pair', async () => {
    const ctx = host39([]);
    expect(await readTransferPartner(ctx, 'act-out')).toEqual({ activityId: 'act-in', accountId: 'wf-sav', date: '2026-10-09' });
    expect(await readTransferPartner(ctx, 'act-lone')).toBeNull();
  });

  it('names categories by id — a call Wealthfolio has offered since 3.8', async () => {
    expect(await readCategoryNames(host39([]))).toEqual(new Map([['cat-food', 'Restaurants']]));
    expect(await readCategoryNames({ api: {} } as any)).toBeNull();
  });
});
