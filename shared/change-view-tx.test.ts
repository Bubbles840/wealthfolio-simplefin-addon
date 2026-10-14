import { describe, it, expect } from 'vitest';
import {
  bankUpdateChange, categoryFiledChange, importChange, stampChange, transferLinkChange, type ChangeDraft,
} from './change-entries';
import type { ChangeLogItem } from './change-log';
import { changesForTransaction } from './change-view';

const CHECKING = { sfinId: 'ACT-chk', wfId: 'wf-chk', name: 'PNC Checking' };
const ALLY = { sfinId: 'ACT-ally', wfId: 'wf-ally', name: 'Ally Savings' };
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 12, 0));
const item = (draft: ChangeDraft, day: number): ChangeLogItem => stampChange(draft, 'companion', at(day));

const imported = (txKey: string, activityId: string, day: number, pending = false) => item(importChange({
  account: CHECKING, txKey, activityId, description: 'KROGER #415', amountCents: -5420, date: '2026-10-01',
  pending, activityType: 'WITHDRAWAL',
}), day);
const posted = (newKey: string, oldKey: string, activityId: string, day: number) => item(bankUpdateChange({
  account: CHECKING, txKey: newKey, activityId, description: 'KROGER #415', amountCents: -5420,
  before: { absCents: 5420, date: '2026-10-01', pending: true, activityType: 'WITHDRAWAL' },
  after: { absCents: 5420, date: '2026-10-02', pending: false, activityType: 'WITHDRAWAL' },
  previousTxKey: oldKey,
}), day);
const filedOn = (activityId: string, day: number) => item(categoryFiledChange({
  actor: 'you', activityId, description: 'KROGER #415', before: null, after: { categoryId: 'cat-gro', categoryName: 'Groceries' },
}), day);
const link = (day: number) => item(transferLinkChange(
  { account: CHECKING, txKey: 'k-out', description: 'TRANSFER TO ALLY', amountCents: -60000, date: '2026-10-04', oldActivityId: 'old-out', newActivityId: 'new-out' },
  { account: ALLY, txKey: 'k-in', description: 'TRANSFER FROM PNC', amountCents: 60000, date: '2026-10-04', oldActivityId: 'old-in', newActivityId: 'new-in' },
), day);

describe('changesForTransaction', () => {
  it('finds entries by the transaction’s key, oldest first', () => {
    const log = [filedOn('act-9', 5), imported('k1', 'act-1', 3), imported('k2', 'act-2', 4)];
    expect(changesForTransaction(log, { txKeys: ['k1'] }).map((e) => e.summary)).toEqual(['Imported KROGER #415']);
  });

  it('follows a pending row that posted under a new transaction id back to its pending import', () => {
    const log = [posted('k-new', 'k-old', 'act-1', 6), imported('k-old', 'act-1', 2, true)];
    const found = changesForTransaction(log, { txKeys: ['k-new'] });
    expect(found.map((e) => e.summary)).toEqual([
      'Imported KROGER #415 (pending)',
      'Updated KROGER #415 from the bank: Oct 1 → Oct 2, posted',
    ]);
  });

  it('finds entries by activity id, the current one and the one a transfer link replaced', () => {
    const log = [filedOn('old-out', 2), link(4), filedOn('new-out', 6)];
    const found = changesForTransaction(log, { activityIds: ['new-out'] });
    expect(found.map((e) => e.at)).toEqual([at(2), at(4), at(6)].map((d) => d.toISOString()));
  });

  it('matches by before.activityIds alone', () => {
    const found = changesForTransaction([link(4)], { activityIds: ['old-in'] });
    expect(found).toHaveLength(1);
  });

  it('never pulls in the other half of a link', () => {
    const otherHalf = item(importChange({
      account: ALLY, txKey: 'k-in', activityId: 'old-in', description: 'TRANSFER FROM PNC', amountCents: 60000,
      date: '2026-10-04', pending: false, activityType: 'DEPOSIT',
    }), 3);
    const thisHalf = item(importChange({
      account: CHECKING, txKey: 'k-out', activityId: 'old-out', description: 'TRANSFER TO ALLY', amountCents: -60000,
      date: '2026-10-04', pending: false, activityType: 'WITHDRAWAL',
    }), 3);
    const found = changesForTransaction([otherHalf, thisHalf, link(4)], { txKeys: ['k-out'], activityIds: ['new-out'] });
    expect(found.map((e) => e.summary)).toEqual([
      'Imported TRANSFER TO ALLY',
      'Linked TRANSFER TO ALLY and TRANSFER FROM PNC as one transfer',
    ]);
  });

  it('finds nothing for a transaction with no identity', () => {
    expect(changesForTransaction([imported('k1', 'act-1', 3)], {})).toEqual([]);
  });
});
