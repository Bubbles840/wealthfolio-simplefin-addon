import { describe, it, expect } from 'vitest';
import { IN_TRANSIT_COMMENT_PREFIX, planReconciliation } from './reconcile';
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

  describe('subtype', () => {
    // The feed omits `subtype` entirely when a rule has no subtype (undefined),
    // while a stored row's adapter normalizes absent subtype to `null` — and some
    // rows predate the field entirely and may read back `''`. All three must be
    // treated as the same "no subtype" so an unrelated sync does not report a
    // difference (and therefore a rewrite) on every row that never had one.
    it('is unchanged when the row has no subtype (undefined) and the feed has none', () => {
      const plan = planReconciliation([feed({})], [row({ subtype: undefined })]);
      expect(plan.updates).toEqual([]);
    });

    it('is unchanged when the row subtype is null and the feed has none', () => {
      const plan = planReconciliation([feed({})], [row({ subtype: null })]);
      expect(plan.updates).toEqual([]);
    });

    it('is unchanged when the row subtype is the empty string and the feed has none', () => {
      const plan = planReconciliation([feed({})], [row({ subtype: '' })]);
      expect(plan.updates).toEqual([]);
    });

    it('backfills in place when a rule newly assigns a subtype to an already-imported row', () => {
      const plan = planReconciliation([feed({ subtype: 'REIMBURSEMENT' })], [row({})]);
      expect(plan.updates).toEqual([{ wfId: 'w1', to: expect.objectContaining({ subtype: 'REIMBURSEMENT' }) }]);
    });

    it('is unchanged when the stored and feed subtype already match', () => {
      const plan = planReconciliation([feed({ subtype: 'REIMBURSEMENT' })], [row({ subtype: 'REIMBURSEMENT' })]);
      expect(plan.updates).toEqual([]);
    });

    it('is unchanged on a case-only subtype difference (upstream canonicalizes case-insensitively)', () => {
      const plan = planReconciliation([feed({ subtype: 'REIMBURSEMENT' })], [row({ subtype: 'reimbursement' })]);
      expect(plan.updates).toEqual([]);
    });

    it('does NOT update when a rule change removes the subtype (sync only ever adds one)', () => {
      // Ruled on by the user: clearing a subtype would mean sending `''`, which
      // is indistinguishable from a deliberate wipe of a subtype the user set
      // by hand in Wealthfolio — the sync cannot tell those apart. Comparing
      // symmetrically here would ALSO mean the update that gets issued can never
      // actually clear the stored value, so the row looks changed again next
      // sync: an identical no-op update, forever. The accepted consequence: a
      // removed rule does not reach rows already imported; those are cleared
      // manually.
      const plan = planReconciliation([feed({})], [row({ subtype: 'REIMBURSEMENT' })]);
      expect(plan.updates).toEqual([]);
    });

    it('updates in place when the feed subtype differs from the stored one (both present, not equal)', () => {
      // Proves the guard above is not simply "ignore subtype whenever the row
      // already has one" — a genuine change between two non-empty subtypes must
      // still reach the row.
      const plan = planReconciliation([feed({ subtype: 'REFUND' })], [row({ subtype: 'REIMBURSEMENT' })]);
      expect(plan.updates).toEqual([{ wfId: 'w1', to: expect.objectContaining({ subtype: 'REFUND' }) }]);
    });
  });
});

describe('planReconciliation — a createOnly tx keeps the stored in-transit marker (PB-M m-a)', () => {
  const placeholder = row({ type: 'DEPOSIT', comment: `${IN_TRANSIT_COMMENT_PREFIX}VENMO · t1`, pending: true });

  it('is not an update when only the marker differs', () => {
    const plan = planReconciliation([feed({ type: 'CREDIT', subtype: 'REIMBURSEMENT', createOnly: true, pending: true })], [placeholder]);
    expect(plan.updates).toEqual([]);
  });

  it('writes the marker back when the row moves for another reason (it posts)', () => {
    const plan = planReconciliation([feed({ type: 'CREDIT', subtype: 'REIMBURSEMENT', createOnly: true, pending: false })], [placeholder]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].to).toMatchObject({ type: 'DEPOSIT', inTransit: true });
  });

  it('a plain tx still clears the marker', () => {
    const plan = planReconciliation([feed({ type: 'DEPOSIT', pending: true })], [placeholder]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].to.inTransit).toBeUndefined();
  });
});

describe('planReconciliation — a keepDividend tx keeps a stored dividend on its security', () => {
  const dividend = row({ type: 'DIVIDEND', assetId: 'asset-voo' });

  it('is not an update when only the type differs', () => {
    const plan = planReconciliation([feed({ type: 'DEPOSIT', keepDividend: true })], [dividend]);
    expect(plan.updates).toEqual([]);
  });

  it('writes the stored type and security back when the row moves for another reason', () => {
    const plan = planReconciliation([feed({ type: 'INTEREST', keepDividend: true, absCents: 510 })], [dividend]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].to).toMatchObject({ type: 'DIVIDEND', assetId: 'asset-voo', absCents: 510 });
  });

  it('keeps nothing on a cash asset, or without the flag', () => {
    for (const assetId of ['$CASH-USD', 'CASH:USD', '', undefined]) {
      const plan = planReconciliation([feed({ type: 'DEPOSIT', keepDividend: true })], [row({ type: 'DIVIDEND', assetId })]);
      expect(plan.updates.map((u) => u.to.type)).toEqual(['DEPOSIT']);
    }
    expect(planReconciliation([feed({ type: 'DEPOSIT' })], [dividend]).updates.map((u) => [u.to.type, u.to.assetId])).toEqual([
      ['DEPOSIT', undefined],
    ]);
  });
});
