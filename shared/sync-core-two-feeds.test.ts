// Two SimpleFin feeds mapped to ONE Wealthfolio card account (a reissued card), both in the download:
// the old feed must not sweep the new feed's in-download placeholder as if it were outside it (1.65 A).
// re-creates it under a new id (the CREDIT update left a $CASH asset). This repeats every other run.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { EXTERNAL_BOOKKEEPING_METADATA, IN_TRANSIT_COMMENT_PREFIX, runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import type { SimplefinAccount, SimplefinTransaction } from './types.js';

const NOW = new Date('2026-10-19T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const account = (id: string, aliveIso: string, transactions: SimplefinTransaction[]): SimplefinAccount => ({
  id, name: 'Northwind Card', currency: 'USD', balance: '0', 'balance-date': epoch(aliveIso), transactions,
});

describe('two feeds share one card account', () => {
  beforeEach(() => { VALUATION_POLL.delayMs = 1; VALUATION_POLL.attempts = 1; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  it("the old feed's pass leaves the new feed's in-download placeholder to the new feed's own pass", async () => {
    const ph: HostActivity = {
      id: 'ph-pay', accountId: 'wf-card', activityType: 'TRANSFER_IN', date: '2026-10-07', amount: 250,
      comment: `${IN_TRANSIT_COMMENT_PREFIX}PAYMENT THANK YOU · pay-1`, sourceGroupId: null, metadata: EXTERNAL_BOOKKEEPING_METADATA,
    };
    const seed: FakeHostSeed = {
      accountSet: { errors: [], accounts: [
        account('sfin-old', '2026-10-05T12:00:00Z', []), // reissued card's old feed: behind, not yet 21 days silent
        account('sfin-new', '2026-10-19T12:00:00Z', [
          { id: 'pay-1', posted: epoch('2026-10-07T12:00:00Z'), amount: '250.00', description: 'PAYMENT THANK YOU' },
        ]),
      ] },
      mapping: { 'sfin-old': 'wf-card', 'sfin-new': 'wf-card' },
      accountTypes: { 'wf-card': 'CREDIT_CARD' },
      existing: new Map([['wf-card', [ph]]]),
    };
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, { force: true });
    const writes = fh.saved.flatMap((r) => [...(r.updates ?? []), ...(r.creates ?? [])]).filter((w) => String(w.comment).includes('pay-1'));
    // Still held: neither feed rewrites, deletes or re-creates it.
    expect(writes).toEqual([]);
    expect(fh.saved.flatMap((r) => r.deleteIds ?? [])).toEqual([]);
  });
});
