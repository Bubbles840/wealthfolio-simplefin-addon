import { describe, it, expect, beforeEach } from 'vitest';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import { createFakeHost } from './fake-host.js';
import { parseSkippedTransactions } from './skipped-transactions.js';

/**
 * A bank feed can report one real transaction twice under two ids (live,
 * 2026-10-09: PNC sent the same $600 deposit in its old and new wording). Deleting
 * the extra row does not stick — the next sync imports it again — so the user
 * needs a way to say "this one is not real".
 */
describe('skipped bank transactions', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
  });

  const posted = () => Math.floor(Date.now() / 1000) - 3600;

  it('never imports a transaction on the skip list', async () => {
    const { host, store, activities } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-spend', name: 'Spend', currency: 'USD', balance: '0', 'balance-date': posted(),
        transactions: [
          { id: 'TRN-old-wording', posted: posted(), amount: '600.00', description: 'Transfer from Capital One Transfers' },
          { id: 'TRN-new-wording', posted: posted(), amount: '600.00', description: 'RT0553 TRANSFER CAPITAL ONE ACH WEB PAYMENT' },
        ],
      }] },
      mapping: { 'sfin-spend': 'wf-spend' },
      skippedTransactions: [{ account: 'sfin-spend', txId: 'TRN-new-wording' }],
    });

    const result = await runSyncCore(host, store, { force: true });

    expect(result.imported).toBe(1);
    const rows = activities.get('wf-spend') ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].comment).toMatch(/· TRN-old-wording$/);
  });

  it('skips only in the account it was listed for', async () => {
    const { host, store, activities } = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-a', name: 'A', currency: 'USD', balance: '0', 'balance-date': posted(),
          transactions: [{ id: 'TRN-shared', posted: posted(), amount: '-25.00', description: 'Coffee' }] },
        { id: 'sfin-b', name: 'B', currency: 'USD', balance: '0', 'balance-date': posted(),
          transactions: [{ id: 'TRN-shared', posted: posted(), amount: '-40.00', description: 'Lunch' }] },
      ] },
      mapping: { 'sfin-a': 'wf-a', 'sfin-b': 'wf-b' },
      skippedTransactions: [{ account: 'sfin-a', txId: 'TRN-shared' }],
    });

    await runSyncCore(host, store, { force: true });

    expect(activities.get('wf-a') ?? []).toEqual([]);
    expect((activities.get('wf-b') ?? []).map((r) => r.comment)).toEqual(['Lunch · TRN-shared']);
  });

  it('leaves an already-stored copy for the user to delete', async () => {
    const day = new Date(posted() * 1000).toISOString().slice(0, 10);
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-spend', name: 'Spend', currency: 'USD', balance: '0', 'balance-date': posted(),
        transactions: [{ id: 'TRN-dup', posted: posted(), amount: '600.00', description: 'Dup' }],
      }] },
      mapping: { 'sfin-spend': 'wf-spend' },
      existing: new Map([['wf-spend', [{
        id: 'row-1', accountId: 'wf-spend', activityType: 'DEPOSIT', date: day, amount: 600,
        comment: 'Dup · TRN-dup', sourceGroupId: null,
      }]]]),
      skippedTransactions: [{ account: 'sfin-spend', txId: 'TRN-dup' }],
    });

    await runSyncCore(host, store, { force: true });

    expect(saved.flatMap((s) => [...(s.deleteIds ?? []), ...(s.updates ?? []).map((u) => u.id)])).toEqual([]);
  });
});

describe('parseSkippedTransactions', () => {
  it('reads the stored list and drops malformed entries', () => {
    expect(parseSkippedTransactions(JSON.stringify([
      { account: 'sfin-1', txId: 'TRN-1', note: 'PNC sent it twice' },
      { account: 'sfin-1' },
      'junk',
      null,
    ]))).toEqual([{ account: 'sfin-1', txId: 'TRN-1', note: 'PNC sent it twice' }]);
  });

  it('reads nothing from garbage', () => {
    expect(parseSkippedTransactions('not json')).toEqual([]);
    expect(parseSkippedTransactions(null)).toEqual([]);
    expect(parseSkippedTransactions('{"a":1}')).toEqual([]);
  });
});
