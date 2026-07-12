import { describe, it, expect } from 'vitest';
import { detectTransferPairs, TRANSFER_MATCH_WINDOW_SECONDS } from './transfers';
import type { TransferCandidate } from './transfers';

const DAY = 24 * 60 * 60;
const T0 = 1_760_000_000;

function cand(over: Partial<TransferCandidate>): TransferCandidate {
  return { txId: 'tx', accountId: 'acct', posted: T0, amount: 0, ruleTyped: false, ...over };
}

describe('detectTransferPairs', () => {
  it('pairs equal-amount opposite-sign transactions in different accounts', () => {
    const out = cand({ txId: 'out-1', accountId: 'checking', amount: -1982.19 });
    const inn = cand({ txId: 'in-1', accountId: 'card', amount: 1982.19, posted: T0 + DAY });
    const d = detectTransferPairs([out, inn]);
    expect(d.pairs).toEqual([{ outTxId: 'out-1', inTxId: 'in-1' }]);
    expect(d.typeByTxId.get('out-1')).toBe('TRANSFER_OUT');
    expect(d.typeByTxId.get('in-1')).toBe('TRANSFER_IN');
  });

  it('does not pair transactions in the same account', () => {
    const d = detectTransferPairs([
      cand({ txId: 'a', accountId: 'checking', amount: -50 }),
      cand({ txId: 'b', accountId: 'checking', amount: 50 }),
    ]);
    expect(d.pairs).toHaveLength(0);
  });

  it('does not pair different amounts (cent precision)', () => {
    const d = detectTransferPairs([
      cand({ txId: 'a', accountId: 'x', amount: -50.01 }),
      cand({ txId: 'b', accountId: 'y', amount: 50.02 }),
    ]);
    expect(d.pairs).toHaveLength(0);
  });

  it('does not pair beyond the 3-day window', () => {
    const d = detectTransferPairs([
      cand({ txId: 'a', accountId: 'x', amount: -50 }),
      cand({ txId: 'b', accountId: 'y', amount: 50, posted: T0 + TRANSFER_MATCH_WINDOW_SECONDS + 1 }),
    ]);
    expect(d.pairs).toHaveLength(0);
  });

  it('excludes rule-typed transactions from pairing', () => {
    const d = detectTransferPairs([
      cand({ txId: 'a', accountId: 'x', amount: -50, ruleTyped: true }),
      cand({ txId: 'b', accountId: 'y', amount: 50 }),
    ]);
    expect(d.pairs).toHaveLength(0);
    expect(d.typeByTxId.size).toBe(0);
  });

  it('prefers the nearest-dated counterpart', () => {
    const d = detectTransferPairs([
      cand({ txId: 'out', accountId: 'x', amount: -50, posted: T0 + DAY }),
      cand({ txId: 'far', accountId: 'y', amount: 50, posted: T0 + 3 * DAY }),
      cand({ txId: 'near', accountId: 'y', amount: 50, posted: T0 + DAY }),
    ]);
    expect(d.pairs).toEqual([{ outTxId: 'out', inTxId: 'near' }]);
  });

  it('is deterministic on exact ties (earlier posted, then txId order wins)', () => {
    const d1 = detectTransferPairs([
      cand({ txId: 'out', accountId: 'x', amount: -50 }),
      cand({ txId: 'tie-b', accountId: 'y', amount: 50, posted: T0 + DAY }),
      cand({ txId: 'tie-a', accountId: 'z', amount: 50, posted: T0 + DAY }),
    ]);
    expect(d1.pairs).toEqual([{ outTxId: 'out', inTxId: 'tie-a' }]);
  });

  it('matches multiple pairs, each transaction at most once', () => {
    const d = detectTransferPairs([
      cand({ txId: 'o1', accountId: 'x', amount: -50 }),
      cand({ txId: 'o2', accountId: 'x', amount: -50, posted: T0 + DAY }),
      cand({ txId: 'i1', accountId: 'y', amount: 50 }),
      cand({ txId: 'i2', accountId: 'y', amount: 50, posted: T0 + DAY }),
    ]);
    expect(d.pairs).toHaveLength(2);
    const used = d.pairs.flatMap((p) => [p.outTxId, p.inTxId]);
    expect(new Set(used).size).toBe(4);
  });

  it('never types a credit-card charge as TRANSFER_OUT (card negatives excluded from OUT side)', () => {
    const d = detectTransferPairs([
      cand({ txId: 'card-charge', accountId: 'card', amount: -50, accountType: 'CREDIT_CARD' }),
      cand({ txId: 'cash-in', accountId: 'checking', amount: 50, posted: T0 + DAY }),
    ]);
    expect(d.pairs).toHaveLength(0);
    expect(d.typeByTxId.size).toBe(0);
  });

  it('still pairs a cash payment out with a credit-card payment in', () => {
    const d = detectTransferPairs([
      cand({ txId: 'cash-out', accountId: 'checking', amount: -50, accountType: 'CASH' }),
      cand({ txId: 'card-in', accountId: 'card', amount: 50, posted: T0 + DAY, accountType: 'CREDIT_CARD' }),
    ]);
    expect(d.pairs).toEqual([{ outTxId: 'cash-out', inTxId: 'card-in' }]);
    expect(d.typeByTxId.get('card-in')).toBe('TRANSFER_IN');
  });

  it('ignores zero and non-finite amounts', () => {
    const d = detectTransferPairs([
      cand({ txId: 'a', accountId: 'x', amount: 0 }),
      cand({ txId: 'b', accountId: 'y', amount: NaN }),
    ]);
    expect(d.pairs).toHaveLength(0);
  });
});
