import { describe, it, expect } from 'vitest';
import { createFakeHost } from './fake-host.js';

describe('createFakeHost', () => {
  it('records saveMany calls and assigns ids to creates', async () => {
    const { host, saved } = createFakeHost();
    const res = await host.saveMany({
      creates: [{ accountId: 'a', activityType: 'WITHDRAWAL', activityDate: '2026-07-01',
                  amount: 5, currency: 'USD', comment: 'Coffee · tx-1' }],
    });
    expect(res.created).toHaveLength(1);
    expect(res.created[0].id).toBeTruthy();
    expect(res.errors).toEqual([]);
    expect(saved).toHaveLength(1);
  });

  it('links a pair and reports the group id', async () => {
    const { host } = createFakeHost();
    const leg = (wfId: string, accountId: string, type: string) => ({
      wfId, accountId, txId: wfId, activityType: type, date: '2026-07-01',
      absCents: 100, currency: 'USD', comment: `x · ${wfId}`,
    });
    const out = await host.linkPair([leg('o', 'a', 'TRANSFER_OUT'), leg('i', 'b', 'TRANSFER_IN')]);
    expect(out.linked).toBe(true);
    expect(out.groupId).toBeTruthy();
  });
});
