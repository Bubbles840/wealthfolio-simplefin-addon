import { describe, it, expect } from 'vitest';
import { categoryFiledChange, stampChange } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import { FEE_REVERSAL_FILING_WHY } from './fee-reversal.js';
import {
  buildTxStory, decodeFiler, encodeFiler, resolveFiler, TX_STORY_FEE_REVERSAL, TX_STORY_MONEY_IN, type TxStoryFacts,
} from './tx-story.js';

const AT = '2026-11-18T12:00:00.000Z';
const story = (row: Partial<TxStoryFacts['row']> = {}, over: Partial<TxStoryFacts> = {}) => buildTxStory({
  now: new Date(AT),
  row: { activityId: 'act-1', note: 'OVERDRAFT FEE REFUND · TRN-9', absCents: 3500, date: '2026-11-10', activityType: 'CREDIT', subtype: 'REFUND', accountName: 'PNC Checking', accountType: 'CASH', ...row },
  feed: { sfinAccountId: 'sfin-chk' }, partner: null, ...over,
});
const filing = (why: string): ChangeLogItem => stampChange(categoryFiledChange({
  actor: 'auto', activityId: 'act-1', description: 'OVERDRAFT FEE REFUND', before: null,
  after: { categoryId: 'cat-fees', categoryName: 'Bank Fees', taxonomyId: 'spending_categories' }, why,
}), 'companion', new Date(AT));

describe('a fee reversal in "Why is this here?" (#79)', () => {
  it('says it is a bank fee coming back, on cash and on a card', () => {
    expect(TX_STORY_FEE_REVERSAL).toBe('A refund of a bank fee, going by its wording: it lowers your spending.');
    expect(story().answer).toContain(TX_STORY_FEE_REVERSAL);
    expect(story({ accountType: 'CREDIT_CARD', note: 'LATE PAYMENT FEE REVERSAL · TRN-9' }).answer).toContain(TX_STORY_FEE_REVERSAL);
  });

  it('says nothing of the kind for a plain refund or a fee reversal stored as a deposit', () => {
    expect(story({ note: 'AMAZON REFUND · TRN-9' }).answer).toContain(TX_STORY_MONEY_IN);
    expect(story({ activityType: 'DEPOSIT', subtype: undefined }).answer).not.toContain(TX_STORY_FEE_REVERSAL);
  });

  it("names the companion's filing as the fee's category, not \"set by hand\"", () => {
    const filer = resolveFiler({ activityId: 'act-1', source: 'manual', categoryId: 'cat-fees', row: { note: 'OVERDRAFT FEE REFUND · TRN-9', activityType: 'CREDIT', accountId: 'wf-chk', absCents: 3500 }, history: [filing(FEE_REVERSAL_FILING_WHY)], rules: null });
    expect(filer).toEqual({ kind: 'fee' });
    expect(story({}, { category: { name: 'Bank Fees', filer: { kind: 'fee' } } }).answer)
      .toContain('Filed under Bank Fees by the sync, the same category as the fee it reverses.');
    expect(decodeFiler(encodeFiler({ kind: 'fee' }))).toEqual({ kind: 'fee' });
  });
});
