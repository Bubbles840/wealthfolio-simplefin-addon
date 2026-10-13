import { describe, it, expect, vi } from 'vitest';
import { readSubscriptionRoster } from './subscription-data.js';

const TODAY = '2026-10-12';
/** A report_cube secret as the companion publishes it — every required field. */
const cubeJson = (subscriptions: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({
  version: 1, asOf: '2026-10-12T06:00:00.000Z', months: ['2026-09', '2026-10'], categories: [], accounts: [],
  spend: [[], []], uncategorized: [[], []], income: [[], []], budgets: [[], []], merchants: [[], []],
  feesInterest: [0, 0], netWorth: [null, null], liquid: [null, null], pool: null, subscriptions, ...extra,
});
const SPOTIFY = {
  name: 'SPOTIFY', monthlyCents: 1199, count: 5, lastDate: '2026-09-15', lastCents: 1199, prevCents: 1199,
  creep: false, kind: 'subscription', recent: [{ date: '2026-09-15', cents: 1199 }],
};
const getter = (entries: Record<string, string>) => vi.fn(async (k: string) => entries[k] ?? null);

describe('readSubscriptionRoster', () => {
  it('builds the roster from the cube and the stored document', async () => {
    const read = await readSubscriptionRoster(getter({
      report_cube: cubeJson([SPOTIFY]),
      subscription_prefs: JSON.stringify({ v: 1, names: { SPOTIFY: 'Spotify' } }),
    }), TODAY);
    expect(read.roster.subscriptions[0]).toMatchObject({ displayName: 'Spotify', nextDate: '2026-10-15' });
    expect(read.prefs.names).toEqual({ SPOTIFY: 'Spotify' });
    expect(read).toMatchObject({ unreadable: false, today: TODAY });
  });

  it('reads the legacy lists while no document exists', async () => {
    const read = await readSubscriptionRoster(getter({ report_cube: cubeJson([SPOTIFY]), hidden_subscriptions: '["SPOTIFY"]' }), TODAY);
    expect(read.roster.subscriptions).toEqual([]);
    expect(read.roster.hidden.map((e) => e.key)).toEqual(['SPOTIFY']);
  });

  it('flags a corrupt document and falls back to the legacy lists', async () => {
    const read = await readSubscriptionRoster(getter({
      report_cube: cubeJson([SPOTIFY]), subscription_prefs: '{"v":1,"hidden":', hidden_subscriptions: '["SPOTIFY"]',
    }), TODAY);
    expect(read.unreadable).toBe(true);
    expect(read.roster.hidden.map((e) => e.key)).toEqual(['SPOTIFY']);
  });

  it('without a cube: hand-added only, detection unavailable', async () => {
    const read = await readSubscriptionRoster(getter({
      subscription_prefs: JSON.stringify({ v: 1, manual: [{ id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' }] }),
    }), TODAY);
    expect(read.roster.detectionAvailable).toBe(false);
    expect(read.roster.subscriptions.map((e) => e.displayName)).toEqual(['Hulu']);
  });

  it("passes the cube's link suggestions through", async () => {
    const read = await readSubscriptionRoster(getter({
      report_cube: cubeJson([], { subscriptionLinks: [{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-09-19', cents: 999 }] }),
      subscription_prefs: JSON.stringify({ v: 1, manual: [{ id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' }] }),
    }), TODAY);
    expect(read.roster.linkSuggestions.map((s) => s.merchant)).toEqual(['HULU']);
  });

  it('rejects when Wealthfolio cannot be read', async () => {
    await expect(readSubscriptionRoster(vi.fn(async () => { throw new Error('ECONNREFUSED'); }), TODAY)).rejects.toThrow('ECONNREFUSED');
  });
});
