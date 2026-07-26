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
    expect((res.created[0] as { notes?: string | null }).notes).toBe('Coffee · tx-1');
    expect(res.errors).toEqual([]);
    expect(saved).toHaveLength(1);
  });

  it('links a pair and reports the group id', async () => {
    const { host, activities } = createFakeHost();
    const write = (accountId: string, txId: string) => ({
      accountId, activityType: 'WITHDRAWAL', activityDate: '2026-07-01',
      amount: 1, currency: 'USD', comment: `x · ${txId}`,
    });

    const outRes = await host.saveMany({ creates: [write('a', 'o')] });
    const inRes = await host.saveMany({ creates: [write('b', 'i')] });
    const outId = outRes.created[0].id;
    const inId = inRes.created[0].id;

    const leg = (wfId: string, accountId: string, txId: string, type: string) => ({
      wfId, accountId, txId, activityType: type, date: '2026-07-01',
      absCents: 100, currency: 'USD', comment: `x · ${txId}`,
    });
    const out = await host.linkPair([
      leg(outId, 'a', 'o', 'TRANSFER_OUT'),
      leg(inId, 'b', 'i', 'TRANSFER_IN'),
    ]);
    expect(out.linked).toBe(true);
    expect(out.groupId).toBeTruthy();

    const outRow = activities.get('a')!.find((r) => r.id === outId);
    const inRow = activities.get('b')!.find((r) => r.id === inId);
    expect(outRow?.sourceGroupId).toBeTruthy();
    expect(outRow?.sourceGroupId).toMatch(/^wf-transfer-/);
    expect(inRow?.sourceGroupId).toBe(outRow?.sourceGroupId);
    expect(outRow?.sourceGroupId).toBe(out.groupId);
  });
});
