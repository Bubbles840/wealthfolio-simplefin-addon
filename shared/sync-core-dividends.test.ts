import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import type { MappingRule } from './types.js';

/** A dividend the bank names the security of, booked on that held security (shared/dividends.ts). */
describe('runSyncCore — dividends on their security', () => {
  const NOW = new Date('2027-03-15T15:00:00Z');
  const epoch = (iso: string) => Date.parse(iso) / 1000;
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  const VOO = 'DIVIDEND RECEIVED VANGUARD INDEX FUNDS S&P 500 ETF USD (VOO) (Cash)';
  const seed = (description: string, extra: Partial<FakeHostSeed> = {}, accountType = 'SECURITIES'): FakeHostSeed => ({
    accountSet: { errors: [], accounts: [{
      id: 'sfin-1', name: 'Brokerage', currency: 'USD', balance: '0', 'balance-date': epoch('2027-03-15T12:00:00Z'),
      transactions: [{ id: 'tx-div', posted: epoch('2027-03-10T12:00:00Z'), amount: '12.34', description }],
    }] },
    mapping: { 'sfin-1': 'wf-1' },
    accountTypes: { 'wf-1': accountType },
    heldSecurities: { 'wf-1': [{ assetId: 'asset-voo', symbol: 'VOO' }] },
    ...extra,
  });
  const theRow = (fh: ReturnType<typeof createFakeHost>) =>
    (fh.activities.get('wf-1') ?? []).find((r) => String(r.comment ?? '').endsWith('· tx-div'));
  const rule = (pattern: string, activityType: string): MappingRule => ({ pattern, matchType: 'contains', activityType: activityType as MappingRule['activityType'] });

  it('books a known dividend wording on the held security, and a second sync writes nothing', async () => {
    const fh = createFakeHost(seed(VOO));
    await runSyncCore(fh.host, fh.store, { dividendSecurities: true });
    expect(theRow(fh)).toMatchObject({ activityType: 'DIVIDEND', assetId: 'asset-voo', amount: 12.34 });

    const before = fh.saved.length;
    await runSyncCore(fh.host, fh.store, { dividendSecurities: true, force: true });
    const writes = fh.saved.slice(before).filter((s) => (s.creates?.length ?? 0) + (s.updates?.length ?? 0) > 0);
    expect(writes).toEqual([]);
  });

  it('types it as before when the other writer does not book dividends yet', async () => {
    const fh = createFakeHost(seed(VOO));
    await runSyncCore(fh.host, fh.store, {});
    expect(theRow(fh)).toMatchObject({ activityType: 'DEPOSIT' });
  });

  it('leaves a ticker the account does not hold, a cash account, and a host without the read as they were', async () => {
    const notHeld = createFakeHost(seed(VOO, { heldSecurities: { 'wf-1': [{ assetId: 'asset-x', symbol: 'MSFT' }] } }));
    await runSyncCore(notHeld.host, notHeld.store, { dividendSecurities: true });
    expect(theRow(notHeld)).toMatchObject({ activityType: 'DEPOSIT' });

    const cash = createFakeHost(seed(VOO, {}, 'CASH'));
    await runSyncCore(cash.host, cash.store, { dividendSecurities: true });
    expect(theRow(cash)).toMatchObject({ activityType: 'DEPOSIT' });

    const noRead = createFakeHost(seed(VOO, { heldSecurities: undefined }));
    await runSyncCore(noRead.host, noRead.store, { dividendSecurities: true });
    expect(theRow(noRead)).toMatchObject({ activityType: 'DEPOSIT' });
  });

  it('a rule wins: INTEREST stays interest; DIVIDEND books the security, or interest when none is named', async () => {
    const interest = createFakeHost(seed(VOO, { mappingRules: [rule('Dividend Received', 'INTEREST')] }));
    await runSyncCore(interest.host, interest.store, { dividendSecurities: true });
    expect(theRow(interest)).toMatchObject({ activityType: 'INTEREST' });

    const dividend = createFakeHost(seed(VOO, { mappingRules: [rule('Dividend Received', 'DIVIDEND')] }));
    await runSyncCore(dividend.host, dividend.store, { dividendSecurities: true });
    expect(theRow(dividend)).toMatchObject({ activityType: 'DIVIDEND', assetId: 'asset-voo' });

    const nameless = createFakeHost(seed('Dividend Received', { mappingRules: [rule('Dividend Received', 'DIVIDEND')] }));
    await runSyncCore(nameless.host, nameless.store, { dividendSecurities: true });
    expect(theRow(nameless)).toMatchObject({ activityType: 'INTEREST' });
  });

  it('updates a dividend already stored as interest onto its security', async () => {
    const stored: HostActivity = {
      id: 'act-1', accountId: 'wf-1', activityType: 'INTEREST', date: '2027-03-10', amount: 12.34,
      comment: `${VOO} · tx-div`, sourceGroupId: null, metadata: null,
    };
    const fh = createFakeHost(seed(VOO, { existing: new Map([['wf-1', [stored]]]) }));
    await runSyncCore(fh.host, fh.store, { dividendSecurities: true, force: true });
    expect(theRow(fh)).toMatchObject({ id: 'act-1', activityType: 'DIVIDEND', assetId: 'asset-voo' });
  });
});
