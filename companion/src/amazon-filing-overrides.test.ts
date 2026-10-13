import { describe, it, expect, vi } from 'vitest';
import { fileAmazonCharges } from './amazon-filing.js';
import { accountTxKey } from '../../shared/transfers.js';

describe('fileAmazonCharges — noAutoFile', () => {
  it('leaves a charge whose automatic filing the person undid, and files the rest', async () => {
    const assigned: Array<[string, string]> = [];
    const res = await fileAmazonCharges({
      uncategorized: vi.fn(async () => [
        { activityId: 'a1', notes: 'Amazon · Amazon: Skincare · TRN-1', wfAccountId: 'wf-card' },
        { activityId: 'a2', notes: 'Amazon · Amazon: Skincare · TRN-2', wfAccountId: 'wf-card' },
      ]),
      categories: vi.fn(async () => [{ id: 'cat-personal', name: 'Personal Care' }]),
      readConfig: vi.fn(async () => ({})),
      assign: vi.fn(async (a: string, c: string) => { assigned.push([a, c]); }),
      log: vi.fn(),
      sfinAccountOf: (wf) => (wf === 'wf-card' ? 'sfin-card' : undefined),
      noAutoFile: (key) => key === accountTxKey('sfin-card', 'TRN-1'),
    });
    expect(assigned).toEqual([['a2', 'cat-personal']]);
    expect(res.filed).toBe(1);
  });
});
