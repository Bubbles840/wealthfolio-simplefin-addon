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
