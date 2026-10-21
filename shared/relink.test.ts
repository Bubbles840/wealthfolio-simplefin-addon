import { describe, it, expect } from 'vitest';
import { detectRelinks, planRelinkAdoption, type RelinkRow, type RelinkTx } from './relink.js';

describe('detectRelinks', () => {
  it('finds a Wealthfolio account whose old SimpleFin id was replaced by a new one', () => {
    expect(detectRelinks({ 'sfin-old': 'wf', 'sfin-new': 'wf', 'sfin-card': 'wf-card' }, new Set(['sfin-new', 'sfin-card'])))
      .toEqual([{ wfAccountId: 'wf', newId: 'sfin-new', oldIds: ['sfin-old'] }]);
  });

  it('is not a re-link when both feeds are in the download (two feeds mapped to one account)', () => {
    expect(detectRelinks({ a: 'wf', b: 'wf' }, new Set(['a', 'b']))).toEqual([]);
  });

  it('is not a re-link when the account is missing from the download altogether (a feed that is down)', () => {
    expect(detectRelinks({ a: 'wf', b: 'wf' }, new Set())).toEqual([]);
    expect(detectRelinks({ a: 'wf' }, new Set())).toEqual([]);
  });
});

const row = (wfId: string, txId: string, description: string, extra: Partial<RelinkRow> = {}): RelinkRow => ({
  wfId, txId, description, date: '2026-09-02', absCents: 450, pending: false, bookkeeping: false, ...extra,
});
const tx = (txId: string, description: string, extra: Partial<RelinkTx> = {}): RelinkTx => ({
  txId, description, date: '2026-09-02', absCents: 450, pending: false, ...extra,
});

describe('planRelinkAdoption', () => {
  const live = (...ids: string[]) => new Set(ids);

  it('reads an old row under the new id when the new transaction has no row of its own', () => {
    const plan = planRelinkAdoption([row('a1', 'TRN-old', 'COFFEE SHOP')], [tx('TRN-new', 'COFFEE SHOP')], live('TRN-new'));
    expect([...plan.adopt]).toEqual([['a1', 'TRN-new']]);
    expect(plan.duplicates).toEqual([]);
  });

  it('needs the same day, amount and description', () => {
    const rows = [row('a1', 'TRN-old', 'COFFEE SHOP')];
    expect(planRelinkAdoption(rows, [tx('TRN-new', 'COFFEE SHOP', { date: '2026-09-03' })], live('TRN-new')).adopt.size).toBe(0);
    expect(planRelinkAdoption(rows, [tx('TRN-new', 'COFFEE SHOP', { absCents: 451 })], live('TRN-new')).adopt.size).toBe(0);
    expect(planRelinkAdoption(rows, [tx('TRN-new', 'BAKERY')], live('TRN-new')).adopt.size).toBe(0);
  });

  it('matches regardless of spacing and case', () => {
    const plan = planRelinkAdoption([row('a1', 'TRN-old', 'coffee  shop ')], [tx('TRN-new', 'COFFEE SHOP')], live('TRN-new'));
    expect(plan.adopt.get('a1')).toBe('TRN-new');
  });

  it('takes a stored description that adds a note after the bank text, when it is the only candidate', () => {
    const plan = planRelinkAdoption([row('a1', 'TRN-old', 'VENMO PAYMENT · Dinner split')], [tx('TRN-new', 'VENMO PAYMENT')], live('TRN-new'));
    expect(plan.adopt.get('a1')).toBe('TRN-new');
  });

  it('pairs identical rows off when the counts agree, and leaves them when they do not', () => {
    const two = [row('a1', 'TRN-o1', 'COFFEE SHOP'), row('a2', 'TRN-o2', 'COFFEE SHOP')];
    const even = planRelinkAdoption(two, [tx('TRN-n1', 'COFFEE SHOP'), tx('TRN-n2', 'COFFEE SHOP')], live('TRN-n1', 'TRN-n2'));
    expect([...even.adopt].sort()).toEqual([['a1', 'TRN-n1'], ['a2', 'TRN-n2']]);
    const odd = planRelinkAdoption(two, [tx('TRN-n1', 'COFFEE SHOP')], live('TRN-n1'));
    expect(odd.adopt.size).toBe(0);
    expect(odd.leftAlone).toBe(1);
  });

  it('never touches a row whose id is still reported, a bookkeeping row, or a pending row', () => {
    const plan = planRelinkAdoption([
      row('a1', 'TRN-still', 'COFFEE SHOP'),
      row('a2', 'sfin-old', 'Starting balance', { bookkeeping: true }),
      row('a3', 'TRN-pend', 'COFFEE SHOP', { pending: true }),
    ], [tx('TRN-new', 'COFFEE SHOP')], live('TRN-still', 'TRN-new'));
    expect(plan.adopt.size).toBe(0);
    expect(plan.duplicates).toEqual([]);
  });

  it('keeps the old row of two stored copies', () => {
    const old = row('a1', 'TRN-old', 'COFFEE SHOP'), copy = row('b1', 'TRN-new', 'COFFEE SHOP');
    const plan = planRelinkAdoption([old, copy], [tx('TRN-new', 'COFFEE SHOP')], live('TRN-new'));
    expect(plan.duplicates).toEqual([{ keep: old, remove: copy, txId: 'TRN-new' }]);
  });

  it('keeps a linked copy over an unlinked old row, and leaves two linked copies alone', () => {
    const old = row('a1', 'TRN-old', 'TRANSFER TO SAVINGS');
    const linkedCopy = row('b1', 'TRN-new', 'TRANSFER TO SAVINGS', { sourceGroupId: 'g1' });
    expect(planRelinkAdoption([old, linkedCopy], [tx('TRN-new', 'TRANSFER TO SAVINGS')], live('TRN-new')).duplicates)
      .toEqual([{ keep: linkedCopy, remove: old, txId: 'TRN-new' }]);
    const both = planRelinkAdoption([{ ...old, sourceGroupId: 'g0' }, linkedCopy], [tx('TRN-new', 'TRANSFER TO SAVINGS')], live('TRN-new'));
    expect(both.duplicates).toEqual([]);
    expect(both.leftAlone).toBe(1);
  });
});
