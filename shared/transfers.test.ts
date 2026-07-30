import { describe, it, expect } from 'vitest';
import { accountTxKey, detectTransferPairs, TRANSFER_MATCH_WINDOW_SECONDS } from './transfers';
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
    expect(d.pairs).toEqual([
      { out: { accountId: 'checking', txId: 'out-1' }, in: { accountId: 'card', txId: 'in-1' } },
    ]);
    expect(d.typeByAccountTx.get(accountTxKey('checking', 'out-1'))).toBe('TRANSFER_OUT');
    expect(d.typeByAccountTx.get(accountTxKey('card', 'in-1'))).toBe('TRANSFER_IN');
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

  it('does not pair beyond the match window', () => {
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
    expect(d.typeByAccountTx.size).toBe(0);
  });

  it('prefers the nearest-dated counterpart', () => {
    const d = detectTransferPairs([
      cand({ txId: 'out', accountId: 'x', amount: -50, posted: T0 + DAY }),
      cand({ txId: 'far', accountId: 'y', amount: 50, posted: T0 + 3 * DAY }),
      cand({ txId: 'near', accountId: 'y', amount: 50, posted: T0 + DAY }),
    ]);
    expect(d.pairs).toEqual([
      { out: { accountId: 'x', txId: 'out' }, in: { accountId: 'y', txId: 'near' } },
    ]);
  });

  it('is deterministic on exact ties (earlier posted, then txId order wins)', () => {
    const d1 = detectTransferPairs([
      cand({ txId: 'out', accountId: 'x', amount: -50 }),
      cand({ txId: 'tie-b', accountId: 'y', amount: 50, posted: T0 + DAY }),
      cand({ txId: 'tie-a', accountId: 'z', amount: 50, posted: T0 + DAY }),
    ]);
    expect(d1.pairs).toEqual([
      { out: { accountId: 'x', txId: 'out' }, in: { accountId: 'z', txId: 'tie-a' } },
    ]);
  });

  it('matches multiple pairs, each transaction at most once', () => {
    const d = detectTransferPairs([
      cand({ txId: 'o1', accountId: 'x', amount: -50 }),
      cand({ txId: 'o2', accountId: 'x', amount: -50, posted: T0 + DAY }),
      cand({ txId: 'i1', accountId: 'y', amount: 50 }),
      cand({ txId: 'i2', accountId: 'y', amount: 50, posted: T0 + DAY }),
    ]);
    expect(d.pairs).toHaveLength(2);
    const used = d.pairs.flatMap((p) => [
      accountTxKey(p.out.accountId, p.out.txId),
      accountTxKey(p.in.accountId, p.in.txId),
    ]);
    expect(new Set(used).size).toBe(4);
  });

  it('never types a credit-card charge as TRANSFER_OUT (card negatives excluded from OUT side)', () => {
    const d = detectTransferPairs([
      cand({ txId: 'card-charge', accountId: 'card', amount: -50, accountType: 'CREDIT_CARD' }),
      cand({ txId: 'cash-in', accountId: 'checking', amount: 50, posted: T0 + DAY }),
    ]);
    expect(d.pairs).toHaveLength(0);
    expect(d.typeByAccountTx.size).toBe(0);
  });

  it('still pairs a cash payment out with a credit-card payment in', () => {
    const d = detectTransferPairs([
      cand({ txId: 'cash-out', accountId: 'checking', amount: -50, accountType: 'CASH' }),
      cand({ txId: 'card-in', accountId: 'card', amount: 50, posted: T0 + DAY, accountType: 'CREDIT_CARD' }),
    ]);
    expect(d.pairs).toEqual([
      { out: { accountId: 'checking', txId: 'cash-out' }, in: { accountId: 'card', txId: 'card-in' } },
    ]);
    expect(d.typeByAccountTx.get(accountTxKey('card', 'card-in'))).toBe('TRANSFER_IN');
  });

  it('ignores zero and non-finite amounts', () => {
    const d = detectTransferPairs([
      cand({ txId: 'a', accountId: 'x', amount: 0 }),
      cand({ txId: 'b', accountId: 'y', amount: NaN }),
    ]);
    expect(d.pairs).toHaveLength(0);
  });
  /**
   * SimpleFin issues ONE transaction id for BOTH sides of a transfer between two
   * accounts it connects — the most unambiguous transfer there is. Keyed by tx id
   * alone this produced a "pair" of one id and a type map holding only
   * TRANSFER_IN, so the outflow was written back as an inflow.
   */
  it('pairs the two sides of ONE shared transaction id in different accounts', () => {
    const d = detectTransferPairs([
      cand({ txId: 'TRN-shared', accountId: 'savings', amount: -1300 }),
      cand({ txId: 'TRN-shared', accountId: 'spend', amount: 1300, posted: T0 + 3600 }),
    ]);
    expect(d.pairs).toEqual([
      { out: { accountId: 'savings', txId: 'TRN-shared' }, in: { accountId: 'spend', txId: 'TRN-shared' } },
    ]);
    // BOTH types survive — this is the assertion the old tx-id-keyed map could
    // not make, because the second `set` overwrote the first.
    expect(d.typeByAccountTx.get(accountTxKey('savings', 'TRN-shared'))).toBe('TRANSFER_OUT');
    expect(d.typeByAccountTx.get(accountTxKey('spend', 'TRN-shared'))).toBe('TRANSFER_IN');
    expect(d.typeByAccountTx.size).toBe(2);
  });

  it('does not let a shared transaction id pair a leg with itself', () => {
    // One account, one id, one row: nothing to pair with, and the same-account
    // guard is the only thing standing between this and a self-pair.
    const d = detectTransferPairs([cand({ txId: 'TRN-shared', accountId: 'savings', amount: -1300 })]);
    expect(d.pairs).toHaveLength(0);
    expect(d.typeByAccountTx.size).toBe(0);
  });

  it('does not let one account\'s used positive block another account\'s same-id positive', () => {
    // Two separate transfers that happen to share a transaction id: without a
    // per-leg `usedPositives`, matching the first would mark the id used and the
    // second pair would never form.
    const d = detectTransferPairs([
      cand({ txId: 'TRN-shared', accountId: 'out-a', amount: -50 }),
      cand({ txId: 'TRN-shared', accountId: 'in-b', amount: 50, posted: T0 + 60 }),
      cand({ txId: 'TRN-shared', accountId: 'out-c', amount: -50, posted: T0 + 120 }),
      cand({ txId: 'TRN-shared', accountId: 'in-d', amount: 50, posted: T0 + 180 }),
    ]);
    expect(d.pairs).toHaveLength(2);
    expect(d.typeByAccountTx.size).toBe(4);
  });
});
