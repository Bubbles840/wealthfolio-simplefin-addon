import { describe, it, expect } from 'vitest';
import {
  activeRelinks, declineKey, detectRelinks, openRelinkQuestions, parseRelinkDecisions, planRelinkAdoption,
  type Relink, type RelinkRow, type RelinkTx,
} from './relink.js';

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
  wfId, txId, description, date: '2026-09-02', absCents: 450, pending: false, bookkeeping: false, linked: false, ...extra,
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

  it('keeps the old row, and removes every copy under the new id', () => {
    const old = row('a1', 'TRN-old', 'COFFEE SHOP'), copy = row('b1', 'TRN-new', 'COFFEE SHOP'), again = row('c1', 'TRN-new', 'COFFEE SHOP');
    const plan = planRelinkAdoption([old, copy, again], [tx('TRN-new', 'COFFEE SHOP')], live('TRN-new'));
    expect(plan.duplicates).toEqual([{ keep: old, remove: [copy, again], txId: 'TRN-new' }]);
  });

  it('keeps the one linked row, and leaves two linked ones alone', () => {
    const old = row('a1', 'TRN-old', 'TRANSFER TO SAVINGS');
    const linkedCopy = row('b1', 'TRN-new', 'TRANSFER TO SAVINGS', { linked: true });
    expect(planRelinkAdoption([old, linkedCopy], [tx('TRN-new', 'TRANSFER TO SAVINGS')], live('TRN-new')).duplicates)
      .toEqual([{ keep: linkedCopy, remove: [old], txId: 'TRN-new' }]);
    const both = planRelinkAdoption([{ ...old, linked: true }, linkedCopy], [tx('TRN-new', 'TRANSFER TO SAVINGS')], live('TRN-new'));
    expect(both.duplicates).toEqual([]);
    expect(both.leftAlone).toBe(1);
  });
});

describe('re-link decisions', () => {
  const R: Relink = { wfAccountId: 'wf', newId: 'new', oldIds: ['old'] };

  it('reads the stored document, dropping anything malformed', () => {
    expect(parseRelinkDecisions(JSON.stringify({
      confirmed: [R, { wfAccountId: 'wf', newId: 'x', oldIds: [] }, { wfAccountId: 'wf', newId: 'y', oldIds: ['y'] }, 'junk'],
      declined: ['wf|a|b', 3],
    }))).toEqual({ confirmed: [R], declined: ['wf|a|b'] });
    for (const raw of [null, '', 'nope', '[]', 'null']) expect(parseRelinkDecisions(raw)).toEqual({ confirmed: [], declined: [] });
  });

  it('keeps a confirmed re-link in force while its new id feeds the same account', () => {
    expect(activeRelinks([R], { new: 'wf', old: 'wf' })).toEqual([R]);
    expect(activeRelinks([R], { new: 'other', old: 'wf' })).toEqual([]);
    expect(activeRelinks([R], { old: 'wf' })).toEqual([]);
  });

  it('asks only about shapes nobody answered', () => {
    const mapping = { new: 'wf', old: 'wf' };
    const feed = new Set(['new']);
    expect(openRelinkQuestions(mapping, feed, { confirmed: [], declined: [] })).toEqual([R]);
    expect(openRelinkQuestions(mapping, feed, { confirmed: [R], declined: [] })).toEqual([]);
    expect(openRelinkQuestions(mapping, feed, { confirmed: [], declined: [declineKey(R)] })).toEqual([]);
  });
});
