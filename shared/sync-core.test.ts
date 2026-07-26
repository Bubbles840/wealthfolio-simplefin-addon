import { describe, it, expect, beforeEach } from 'vitest';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import { createFakeHost } from './fake-host.js';

describe('runSyncCore', () => {
  beforeEach(() => {
    // Keep the same-run valuation poll effectively instant (mirrors sync.test.ts).
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 3;
  });

  it('imports a new transaction with the cash symbol and tx-id comment', async () => {
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '100.00',
        'balance-date': 1700000000,
        transactions: [{ id: 'tx-1', posted: 1700000000, amount: '-12.50', description: 'Coffee' }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
    });
    const result = await runSyncCore(host, store, {});
    expect(result.imported).toBe(1);
    const create = saved[0].creates![0];
    expect(create.symbol).toEqual({ symbol: '$CASH-USD' });
    expect(create.comment).toBe('Coffee · tx-1');
  });

  it('finds an existing starting balance on an account with more than a page of activities', async () => {
    // The marker is by construction the OLDEST row on the account, so a
    // recent-first page misses it once the account outgrows one page — and the
    // guard would then write a SECOND baseline, silently doubling it.
    const filler: Array<{
      id: string; accountId: string; activityType: string; date: string;
      amount: number; comment: string;
    }> = [{
      id: 'sb', accountId: 'wf-a', activityType: 'DEPOSIT', date: '2020-01-01',
      amount: 500, comment: 'Starting balance · sfin-1',
    }];
    for (let i = 0; i < 600; i++) {
      // No ' · ' in the comment, so these are invisible to the tx-id matcher and
      // only serve to push the marker off a recent-first page.
      const day = String((i % 28) + 1).padStart(2, '0');
      const month = String((i % 12) + 1).padStart(2, '0');
      filler.push({
        id: `old-${i}`, accountId: 'wf-a', activityType: 'DEPOSIT',
        date: `2025-${month}-${day}`, amount: 1, comment: `Filler ${i}`,
      });
    }
    const { host, store, imported } = createFakeHost({
      accountSet: { errors: [], accounts: [{
        id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '100.00',
        'balance-date': 1700000000,
        transactions: [{ id: 'tx-1', posted: 1700000000, amount: '-12.50', description: 'Coffee' }],
      }] },
      mapping: { 'sfin-1': 'wf-a' },
      // Readable valuation → the starting-balance branch runs, and the guard is
      // the only thing standing between it and a duplicate baseline.
      valuations: new Map([['wf-a', 0]]),
      existing: new Map([['wf-a', filler.map((r) => ({ ...r, sourceGroupId: null }))]]),
    });

    await runSyncCore(host, store, {});

    const startingBalanceImports = imported
      .flat()
      .filter((r) => r.comment === 'Starting balance · sfin-1');
    expect(startingBalanceImports).toEqual([]);
  });

  it('omits the asset on transfer legs', async () => {
    const { host, store, saved } = createFakeHost({
      accountSet: { errors: [], accounts: [
        { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': 1,
          transactions: [{ id: 'tx-out', posted: 1700000000, amount: '-500.00', description: 'Payment to Card' }] },
        { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '0', 'balance-date': 1,
          transactions: [{ id: 'tx-in', posted: 1700086400, amount: '500.00', description: 'PAYMENT THANK YOU' }] },
      ] },
      mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' },
    });
    await runSyncCore(host, store, {});
    const creates = saved.flatMap((s) => s.creates ?? []);
    const out = creates.find((c) => c.comment.includes('tx-out'))!;
    expect(out.activityType).toBe('TRANSFER_OUT');
    expect(out.symbol).toBeUndefined();
  });
});
