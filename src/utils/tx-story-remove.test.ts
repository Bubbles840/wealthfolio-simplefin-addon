import { describe, it, expect, vi } from 'vitest';
import { removalFingerprint } from '../../shared/tx-remove';
import { appTxStory } from './tx-story';

const NOW = new Date('2026-10-14T15:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: 'dup-1', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'DEPOSIT', date: '2026-10-09T00:00:00.000Z', amount: '600',
  currency: 'USD', comment: 'MOBILE DEPOSIT · TRN-600', ...over,
});
const ctx = (r: Record<string, unknown>) => ({
  api: {
    activities: { search: vi.fn(async () => ({ data: [r], meta: { totalRowCount: 1 } })) },
    accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', name: 'PNC Checking', accountType: 'CASH' }]) },
  },
}) as any;
const store = { getAccountMapping: vi.fn(async () => ({ 'sfin-chk': 'wf-chk' })) };

describe('a story in the app offers "Remove for good…"', () => {
  it('on a row from the bank feed, carrying the row as shown', async () => {
    const out = await appTxStory(ctx(row()), store, { activityId: 'dup-1' }, NOW);
    expect(out.kind === 'ok' && out.removal).toEqual({
      activityId: 'dup-1',
      fingerprint: removalFingerprint({
        activityId: 'dup-1', note: 'MOBILE DEPOSIT · TRN-600', absCents: 60000, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking',
      }),
    });
  });

  it('not on a transfer leg whose other half it cannot see, nor a row typed by hand', async () => {
    const leg = await appTxStory(ctx(row({ activityType: 'TRANSFER_OUT' })), store, { activityId: 'dup-1' }, NOW);
    expect(leg.kind === 'ok' && leg.removal).toBeUndefined();
    const byHand = await appTxStory(ctx(row({ comment: 'Cash for rent' })), store, { activityId: 'dup-1' }, NOW);
    expect(byHand.kind === 'ok' && byHand.removal).toBeUndefined();
  });

  it('carries the UTC day the story shows, whatever offset the stored date has', async () => {
    // 23:30 on the 9th in New York is the 10th in UTC: the story, and so the fingerprint, say the 10th.
    const out = await appTxStory(ctx(row({ date: '2026-10-09T23:30:00-04:00' })), store, { activityId: 'dup-1' }, NOW);
    const want = removalFingerprint({
      activityId: 'dup-1', note: 'MOBILE DEPOSIT · TRN-600', absCents: 60000, date: '2026-10-10', activityType: 'DEPOSIT', accountName: 'PNC Checking',
    });
    expect(out.kind === 'ok' && out.removal?.fingerprint).toBe(want);
  });
});
