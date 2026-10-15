import { describe, it, expect } from 'vitest';
import { paybackFiledChange, stampChange } from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import { buildTxStory, resolveFiler, TX_STORY_MONEY_IN, TX_STORY_PAYBACK, type FilerInput, type TxStoryFacts } from './tx-story.js';

const AT = '2026-10-14T12:00:00.000Z';
const filedAsPayback = (categoryId: string | null, over: Partial<ChangeLogItem> = {}): ChangeLogItem => ({
  ...stampChange(paybackFiledChange({
    account: { sfinId: 'sfin-chk', wfId: 'wf-chk', name: 'PNC Checking' }, txKeys: ['sfin-chk\u0000TRN-77'], activityId: 'act-7',
    description: 'VENMO CASHOUT', amountCents: 1400, date: '2026-10-09', subtypeBefore: null,
    categoryId, categoryName: categoryId ? 'Restaurants' : null,
  }), 'addon', new Date(AT)),
  ...over,
});
const input = (history: ChangeLogItem[] | null, over: Partial<FilerInput> = {}): FilerInput => ({
  activityId: 'act-7', source: 'rule', categoryId: 'cat-rest', categoryName: 'Restaurants',
  row: { note: 'VENMO CASHOUT · TRN-77', activityType: 'CREDIT', accountId: 'wf-chk', absCents: 1400 },
  history, rules: null, ...over,
});
const story = (over: Partial<TxStoryFacts> = {}, row: Partial<TxStoryFacts['row']> = {}) => buildTxStory({
  now: new Date(AT),
  row: { activityId: 'act-7', note: 'VENMO CASHOUT · TRN-77', absCents: 1400, date: '2026-10-09', activityType: 'CREDIT', subtype: 'REIMBURSEMENT', accountName: 'PNC Checking', accountType: 'CASH', ...row },
  feed: { sfinAccountId: 'sfin-chk' }, partner: null, ...over,
});

describe('who filed a payback', () => {
  it('is you, as a payback, though the app filed it through a rule (W11)', () => {
    expect(resolveFiler(input([filedAsPayback('cat-rest')]))).toEqual({ kind: 'you', at: AT, payback: true });
  });

  it("is you, as a payback, when Telegram's /categorize filed it by hand — not \"set by hand\"", () => {
    expect(resolveFiler(input([filedAsPayback('cat-rest')], { source: 'manual' }))).toEqual({ kind: 'you', at: AT, payback: true });
  });

  it.each<[string, ChangeLogItem]>([
    ['the payback was undone', filedAsPayback('cat-rest', { undone: { by: 'u1', at: AT } })],
    ['it is under another category than the payback chose', filedAsPayback('cat-groc')],
    ['the payback left it with no category', filedAsPayback(null)],
    ["the entry is another row's", filedAsPayback('cat-rest', { subject: { txKeys: [], activityIds: ['act-9'] } })],
  ])('is a rule, as before, when %s', (_name, entry) => {
    expect(resolveFiler(input([entry]))).toEqual({ kind: 'rule', pattern: null, unknown: true });
  });

  it('is named as a payback in the story, with the day when it is known', () => {
    expect(story({ category: { name: 'Restaurants', filer: { kind: 'you', at: AT, payback: true } } }).answer)
      .toContain('Filed under Restaurants by you, as a payback, Oct 14.');
    expect(story({ category: { name: 'Restaurants', filer: { kind: 'you', payback: true } } }).answer)
      .toContain('Filed under Restaurants by you, as a payback.');
    expect(story({ category: { name: 'Restaurants', filer: { kind: 'you', at: AT } } }).answer)
      .toContain('Filed under Restaurants by you, in Telegram, Oct 14.');
  });
});

describe("a payback's money line", () => {
  it('says a payback lowers your spending, not "Money in."', () => {
    const answer = story().answer;
    expect(answer).toContain(TX_STORY_PAYBACK);
    expect(TX_STORY_PAYBACK).toBe('A payback: it lowers your spending.');
    expect(answer).not.toContain(TX_STORY_MONEY_IN);
  });

  it.each<[string, Partial<TxStoryFacts['row']>]>([
    ['a deposit', { activityType: 'DEPOSIT', subtype: undefined }],
    ['a CREDIT with no subtype', { subtype: undefined }],
    ['a refund', { subtype: 'REFUND' }],
    ['an account of unknown type', { accountType: undefined }],
  ])('keeps "Money in." for %s', (_name, row) => {
    expect(story({}, row).answer).toContain(TX_STORY_MONEY_IN);
  });
});
