import { describe, it, expect } from 'vitest';
import { createFakeHost, HOST_PAGE_LIMIT } from './fake-host.js';

describe('createFakeHost', () => {
  it('pages listActivities newest-first and listOldestActivities oldest-first', async () => {
    const rows = Array.from({ length: HOST_PAGE_LIMIT + 5 }, (_, i) => ({
      id: `r-${i}`, accountId: 'a', activityType: 'DEPOSIT',
      // r-0 is the oldest, r-504 the newest.
      date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
      amount: 1, comment: `row ${i}`, sourceGroupId: null,
    }));
    const { host } = createFakeHost({ existing: new Map([['a', rows]]) });

    const page = await host.listActivities('a');
    expect(page).toHaveLength(HOST_PAGE_LIMIT);
    expect(page[0].id).toBe(`r-${HOST_PAGE_LIMIT + 4}`);
    // The five oldest rows fall off the recent-first page entirely...
    expect(page.some((r) => r.id === 'r-0')).toBe(false);

    // ...but are exactly what the ascending read returns.
    const oldest = await host.listOldestActivities('a', 3);
    expect(oldest.map((r) => r.id)).toEqual(['r-0', 'r-1', 'r-2']);
  });

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
