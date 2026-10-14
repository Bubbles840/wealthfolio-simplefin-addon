import { describe, it, expect, vi } from 'vitest';
import { categoryFiledChange, stampChange } from '../../shared/change-entries';
import { TX_STORY_NOT_FILED, TX_STORY_SPENDING } from '../../shared/tx-story';
import { accountTxKey } from '../../shared/transfers';
import { appTxStory } from './tx-story';

const NOW = new Date('2026-10-14T15:00:00Z');
const detail = (over: Record<string, unknown> = {}) => ({
  id: 'act-1', accountId: 'wf-chk', accountName: 'Checking', activityType: 'TRANSFER_OUT', date: '2026-10-08T12:00:00.000Z', amount: '600',
  currency: 'USD', comment: 'TO SAVINGS · TRN-1', ...over,
});

/** A 3.9+ host: the row, its fact from the cash search, Wealthfolio's pair, and the category names. */
function host39(row: Record<string, unknown>, fact: Record<string, unknown>, pairWith?: { id: string; accountId: string; activityDate: string }) {
  return {
    api: {
      activities: {
        search: vi.fn(async () => ({ data: [row], meta: { totalRowCount: 1 } })),
        getTransferPair: vi.fn(async (id: string) => (pairWith ? { transferOut: { id, accountId: row.accountId, activityDate: row.date }, transferIn: pairWith } : null)),
      },
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', name: 'Checking', accountType: 'CASH' }, { id: 'wf-sav', name: 'Savings', accountType: 'CASH' }]) },
      spending: {
        searchCashActivities: vi.fn(async () => ({ items: [{ ...row, activityDate: row.date, splits: [], ...fact }], totalCount: 1 })),
        getCategories: vi.fn(async () => [{ kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-food', key: 'food', name: 'Restaurants', path: 'Food / Restaurants' }]),
      },
    },
  } as any;
}
const store = { getAccountMapping: vi.fn(async () => ({ 'sfin-chk': 'wf-chk' })) };
const filed = (source: string) => ({ taxonomyId: 'spending_categories', categoryId: 'cat-food', source, id: 'x', activityId: 'act-1', weight: 1, createdAt: '', updatedAt: '' });

describe('a story in the app, on Wealthfolio 3.9 and newer', () => {
  it('names the other half of a linked transfer from Wealthfolio\'s own pair, and offers no Remove', async () => {
    const ctx = host39(detail(), { transferLinkStatus: 'linked', sourceGroupId: 'grp-1', cashFlowBucket: 'neutral', assignments: [] }, { id: 'act-2', accountId: 'wf-sav', activityDate: '2026-10-09T12:00:00Z' });
    const out = await appTxStory(ctx, store, { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.answer).toContain('Half of a transfer: $600.00 into Savings, Oct 9.');
    expect(out.kind === 'ok' && out.removal).toBeUndefined();
  });

  it('calls an unlinked transfer leg spending, and offers Remove for good…', async () => {
    const ctx = host39(detail(), { transferLinkStatus: 'unlinked', sourceGroupId: null, cashFlowBucket: 'spending', assignments: [] });
    const out = await appTxStory(ctx, store, { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.answer).toContain(TX_STORY_SPENDING);
    expect(out.kind === 'ok' && out.removal?.activityId).toBe('act-1');
    expect(ctx.api.activities.getTransferPair).not.toHaveBeenCalled();
  });

  it('says what a row is filed under and who filed it, as the companion\'s story does', async () => {
    const spend = detail({ activityType: 'WITHDRAWAL', comment: 'CHIPOTLE 1234 · TRN-9' });
    const byRule = await appTxStory(host39(spend, { transferLinkStatus: null, cashFlowBucket: 'spending', assignments: [filed('rule')] }), store, { activityId: 'act-1' }, NOW);
    expect(byRule.kind === 'ok' && byRule.story.answer).toContain('Filed under Restaurants by a rule.');
    // Who filed it is told from the change log; without it, only where.
    const unread = await appTxStory(host39(spend, { transferLinkStatus: null, cashFlowBucket: 'spending', assignments: [filed('manual')] }), store, { activityId: 'act-1' }, NOW);
    expect(unread.kind === 'ok' && unread.story.answer).toContain('Filed under Restaurants.');
    const emptyLog = { ...store, getChangeLog: vi.fn(async () => ({ entries: [], gaps: [], trimmed: 0, unreadable: [] })) };
    const byHand = await appTxStory(host39(spend, { transferLinkStatus: null, cashFlowBucket: 'spending', assignments: [filed('manual')] }), emptyLog as any, { activityId: 'act-1' }, NOW);
    expect(byHand.kind === 'ok' && byHand.story.answer).toContain('Filed under Restaurants — set by hand.');
    const entry = stampChange(categoryFiledChange({
      actor: 'you', account: { sfinId: 'sfin-chk', wfId: 'wf-chk', name: 'Checking' }, txKey: accountTxKey('sfin-chk', 'TRN-9'), activityId: 'act-1',
      description: 'CHIPOTLE 1234', amountCents: -60000, date: '2026-10-08',
      before: null, after: { categoryId: 'cat-food', categoryName: 'Restaurants', taxonomyId: 'spending_categories' },
    }), 'companion', new Date('2026-10-09T15:00:00Z'));
    const withLog = { ...store, getChangeLog: vi.fn(async () => ({ entries: [entry], gaps: [], trimmed: 0, unreadable: [] })) };
    const byYou = await appTxStory(host39(spend, { transferLinkStatus: null, cashFlowBucket: 'spending', assignments: [filed('manual')] }), withLog as any, { activityId: 'act-1' }, NOW);
    expect(byYou.kind === 'ok' && byYou.story.answer).toContain('Filed under Restaurants by you, in Telegram, Oct 9.');
  });

  it('says a spending row Wealthfolio has not filed is not filed', async () => {
    const spend = detail({ activityType: 'WITHDRAWAL', comment: 'CHIPOTLE 1234 · TRN-9' });
    const out = await appTxStory(host39(spend, { transferLinkStatus: null, cashFlowBucket: 'spending', assignments: [] }), store, { activityId: 'act-1' }, NOW);
    expect(out.kind === 'ok' && out.story.answer).toContain(TX_STORY_NOT_FILED);
  });
});
