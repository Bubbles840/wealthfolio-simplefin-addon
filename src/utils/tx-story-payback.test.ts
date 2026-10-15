import { describe, it, expect, vi } from 'vitest';
import { paybackFiledChange, stampChange } from '../../shared/change-entries';
import { emptySyncOverrides, setTxOverride } from '../../shared/sync-overrides';
import { accountTxKey } from '../../shared/transfers';
import { removalFingerprint } from '../../shared/tx-remove';
import { TX_STORY_PAYBACK } from '../../shared/tx-story';
import { appTxStory } from './tx-story';

const NOW = new Date('2026-10-14T15:00:00Z');
const KEY = accountTxKey('sfin-chk', 'TRN-77');
const detail = (over: Record<string, unknown> = {}) => ({
  id: 'act-7', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'DEPOSIT', date: '2026-10-09T12:00:00.000Z', amount: '14',
  currency: 'USD', comment: 'VENMO CASHOUT · TRN-77', ...over,
});
const SHOWN = removalFingerprint({ activityId: 'act-7', note: 'VENMO CASHOUT · TRN-77', absCents: 1400, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking' });

/** A 3.9+ host: the row, its fact from the cash search, and the category names. `accountType` for the row's account. */
function host39(row: Record<string, unknown>, fact: Record<string, unknown>, accountType = 'CASH') {
  return {
    api: {
      activities: { search: vi.fn(async () => ({ data: [row], meta: { totalRowCount: 1 } })), getTransferPair: vi.fn(async () => null) },
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', name: 'PNC Checking', accountType }]) },
      spending: {
        searchCashActivities: vi.fn(async () => ({ items: [{ ...row, activityDate: row.date, splits: [], transferLinkStatus: null, sourceGroupId: null, ...fact }], totalCount: 1 })),
        getCategories: vi.fn(async () => [{ kind: 'expense', taxonomyId: 'spending_categories', categoryId: 'cat-rest', key: 'r', name: 'Restaurants', path: 'Food & Dining / Restaurants' }]),
      },
    },
  } as any;
}
const store = (over: Record<string, unknown> = {}) => ({
  getAccountMapping: vi.fn(async () => ({ 'sfin-chk': 'wf-chk' })),
  readSyncOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: false })),
  ...over,
});
const income = { cashFlowBucket: 'income', assignments: [] };

describe('"It\'s a payback…" on a story in the app (W11)', () => {
  it('is offered on a posted deposit Wealthfolio says is filed nowhere, with the row as shown', async () => {
    const out = await appTxStory(host39(detail(), income), store(), { activityId: 'act-7' }, NOW);
    expect(out.kind === 'ok' && out.payback).toEqual({ activityId: 'act-7', fingerprint: SHOWN });
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, string?]>([
    ['a row Wealthfolio says is filed', detail(), { ...income, assignments: [{ taxonomyId: 'income_categories', categoryId: 'cat-gift', source: 'manual' }] }],
    ['a card', detail(), income, 'CREDIT_CARD'],
    ['a pending deposit', detail({ comment: 'VENMO CASHOUT · TRN-77 · pending' }), income],
    ['a withdrawal', detail({ activityType: 'WITHDRAWAL' }), { ...income, cashFlowBucket: 'spending' }],
  ])('is not offered on %s', async (_name, row, fact, accountType) => {
    const out = await appTxStory(host39(row, fact, accountType), store(), { activityId: 'act-7' }, NOW);
    expect(out.kind).toBe('ok');
    expect(out.kind === 'ok' && out.payback).toBeUndefined();
  });

  it('is not offered on a row the payback setting is already on', async () => {
    const overrides = setTxOverride(emptySyncOverrides(), KEY, 'asReimbursement', NOW);
    const out = await appTxStory(host39(detail(), income), store({ readSyncOverrides: vi.fn(async () => ({ overrides, unreadable: false })) }), { activityId: 'act-7' }, NOW);
    expect(out.kind === 'ok' && out.payback).toBeUndefined();
  });

  it('is not offered on a Wealthfolio 3.8 host, which has no facts', async () => {
    const ctx = host39(detail(), income);
    ctx.api.spending.searchCashActivities = vi.fn(async () => { throw new Error("Unknown addon host API method 'spending.searchCashActivities'"); });
    const status = { count: 1, asOf: '2026-10-14T00:00:00Z', rows: [{ activityId: 'act-7', date: '2026-10-09', amountCents: 1400, description: 'VENMO CASHOUT', accountName: 'PNC Checking', paybackEligible: true }] };
    const out = await appTxStory(ctx, store({ getUncategorizedStatus: vi.fn(async () => status) }), { activityId: 'act-7' }, NOW);
    expect(out.kind === 'ok' && out.story.answer).toContain("Not filed yet — it's on your needs-a-category list.");
    expect(out.kind === 'ok' && out.payback).toBeUndefined();
  });

  it('says a payback the app filed lowers your spending and was filed by you, as a payback, though Wealthfolio says a rule filed it', async () => {
    const entry = stampChange(paybackFiledChange({
      account: { sfinId: 'sfin-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKeys: [KEY], activityId: 'act-7', description: 'VENMO CASHOUT',
      amountCents: 1400, date: '2026-10-09', subtypeBefore: null, categoryId: 'cat-rest', categoryName: 'Restaurants',
    }), 'addon', new Date('2026-10-14T12:00:00Z'));
    const log = { entries: [entry], gaps: [], trimmed: 0, unreadable: [] };
    const credit = detail({ activityType: 'CREDIT', subtype: 'REIMBURSEMENT' });
    const out = await appTxStory(
      host39(credit, { cashFlowBucket: 'spending', assignments: [{ taxonomyId: 'spending_categories', categoryId: 'cat-rest', source: 'rule' }] }),
      store({ getChangeLog: vi.fn(async () => log) }), { activityId: 'act-7' }, NOW,
    );
    expect(out.kind === 'ok' && out.story.answer).toContain(TX_STORY_PAYBACK);
    expect(out.kind === 'ok' && out.story.answer).toContain('Filed under Restaurants by you, as a payback, Oct 14.');
    expect(out.kind === 'ok' && out.payback).toBeUndefined();
  });
});
