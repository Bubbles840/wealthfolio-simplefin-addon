import { describe, it, expect, vi } from 'vitest';
import {
  editSkippedTransactions, parseSkippedTransactions, parseSkippedTransactionsStrict, SKIPPED_TRANSACTIONS_SECRET_KEY,
  SkippedTransactionsUnreadableError, withoutSkipped, withSkipped,
} from './skipped-transactions.js';

function secrets(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
  };
}

const PNC = { account: 'ACT-1f2e', txId: 'TRN-600', note: 'reported twice by the bank feed', at: '2026-10-09T12:00:00Z' };

describe('parseSkippedTransactionsStrict', () => {
  it('tells absent, ok and corrupt apart, where the lenient reader cannot', () => {
    expect(parseSkippedTransactionsStrict(null)).toEqual({ kind: 'absent' });
    expect(parseSkippedTransactionsStrict('')).toEqual({ kind: 'absent' });
    expect(parseSkippedTransactionsStrict(JSON.stringify([PNC]))).toEqual({ kind: 'ok', list: [PNC] });
    const half = JSON.stringify([PNC, { account: 'x' }]);
    expect(parseSkippedTransactionsStrict(half)).toEqual({ kind: 'corrupt' });
    expect(parseSkippedTransactions(half)).toEqual([PNC]);
    expect(parseSkippedTransactionsStrict('{"account":"x"}')).toEqual({ kind: 'corrupt' });
    expect(parseSkippedTransactionsStrict('[')).toEqual({ kind: 'corrupt' });
  });
});

describe('editSkippedTransactions', () => {
  it('adds once per account and transaction, and removes', async () => {
    const s = secrets({ [SKIPPED_TRANSACTIONS_SECRET_KEY]: JSON.stringify([PNC]) });
    const entry = { account: 'ACT-9c8d', txId: 'TRN-600', note: 'Undone in the change log', at: '2026-10-13T15:00:00.000Z' };
    await editSkippedTransactions(s.get, s.set, (l) => withSkipped(l, entry));
    await editSkippedTransactions(s.get, s.set, (l) => withSkipped(l, entry));
    expect(JSON.parse(s.store.get(SKIPPED_TRANSACTIONS_SECRET_KEY)!)).toEqual([PNC, entry]);
    await editSkippedTransactions(s.get, s.set, (l) => withoutSkipped(l, 'ACT-9c8d', 'TRN-600'));
    expect(JSON.parse(s.store.get(SKIPPED_TRANSACTIONS_SECRET_KEY)!)).toEqual([PNC]);
  });

  it('never overwrites a list it cannot read in full', async () => {
    const raw = JSON.stringify([PNC, { txId: 'no account' }]);
    const s = secrets({ [SKIPPED_TRANSACTIONS_SECRET_KEY]: raw });
    await expect(editSkippedTransactions(s.get, s.set, (l) => l)).rejects.toBeInstanceOf(SkippedTransactionsUnreadableError);
    expect(s.set).not.toHaveBeenCalled();
    expect(s.store.get(SKIPPED_TRANSACTIONS_SECRET_KEY)).toBe(raw);
  });
});
