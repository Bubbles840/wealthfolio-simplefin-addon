import { describe, it, expect } from 'vitest';
import { planReconciliation } from './reconcile';
import type { FeedTx, ExistingRow } from './reconcile';

const feed = (o: Partial<FeedTx>): FeedTx => ({
  txId: 't1', wfAccountId: 'A', absCents: 500, type: 'WITHDRAWAL', date: '2026-07-13', pending: false, ...o,
});
const row = (o: Partial<ExistingRow>): ExistingRow => ({
  wfId: 'w1', wfAccountId: 'A', txId: 't1', absCents: 500, type: 'WITHDRAWAL', date: '2026-07-13', pending: false, ...o,
});

describe('planReconciliation', () => {
  it('creates a transaction not already imported', () => {
    const plan = planReconciliation([feed({ txId: 'new', pending: true })], []);
    expect(plan.creates.map((c) => c.txId)).toEqual(['new']);
    expect(plan.updates).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
  });

  it('skips an unchanged already-imported transaction', () => {
    const plan = planReconciliation([feed({})], [row({})]);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
  });

  it('updates in place when a pending amount changes (same id, same wfId)', () => {
    const plan = planReconciliation([feed({ pending: true, absCents: 650 })], [row({ pending: true, absCents: 500 })]);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([{ wfId: 'w1', to: expect.objectContaining({ absCents: 650 }) }]);
    expect(plan.deleteIds).toEqual([]);
  });

  it('updates in place when a pending posts under the same id', () => {
    const plan = planReconciliation([feed({ pending: false, date: '2026-07-15' })], [row({ pending: true, date: '2026-07-13' })]);
    expect(plan.updates).toEqual([{ wfId: 'w1', to: expect.objectContaining({ pending: false, date: '2026-07-15' }) }]);
    expect(plan.deleteIds).toEqual([]);
  });

  it('matches a vanished pending to a new posted id and updates in place (no delete, no dup)', () => {
    // pending t1 gone from feed; a new posted t2 in same account, same amount, 1 day later
    const plan = planReconciliation(
      [feed({ txId: 't2', pending: false, date: '2026-07-14', absCents: 500 })],
      [row({ txId: 't1', pending: true, date: '2026-07-13', absCents: 500 })],
    );
    expect(plan.creates).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.updates).toEqual([{ wfId: 'w1', to: expect.objectContaining({ txId: 't2', pending: false }) }]);
  });

  it('deletes a vanished pending with no posted match', () => {
    const plan = planReconciliation([], [row({ txId: 't1', pending: true })]);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.deleteIds).toEqual(['w1']);
  });

  it('never deletes a posted row that merely aged out of the feed', () => {
    const plan = planReconciliation([], [row({ txId: 't1', pending: false })]);
    expect(plan.deleteIds).toEqual([]);
  });

  it('does not match a vanished pending to a posted row in a different account', () => {
    const plan = planReconciliation(
      [feed({ txId: 't2', wfAccountId: 'B', pending: false, absCents: 500 })],
      [row({ txId: 't1', wfAccountId: 'A', pending: true, absCents: 500 })],
    );
    expect(plan.deleteIds).toEqual(['w1']);
    expect(plan.creates.map((c) => c.txId)).toEqual(['t2']);
  });

  it('does not match when the posted date is outside the window', () => {
    const plan = planReconciliation(
      [feed({ txId: 't2', pending: false, date: '2026-07-20', absCents: 500 })],
      [row({ txId: 't1', pending: true, date: '2026-07-13', absCents: 500 })],
    );
    expect(plan.deleteIds).toEqual(['w1']);
    expect(plan.creates.map((c) => c.txId)).toEqual(['t2']);
  });
});
