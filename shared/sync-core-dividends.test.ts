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

  describe('a booked dividend on a later sync', () => {
    const booked = async (extra: Partial<FakeHostSeed> = {}) => {
      const s = seed(VOO, extra);
      const fh = createFakeHost(s);
      await runSyncCore(fh.host, fh.store, { dividendSecurities: true });
      expect(theRow(fh)).toMatchObject({ activityType: 'DIVIDEND', assetId: 'asset-voo' });
      return { s, fh, before: fh.saved.length };
    };
    const writesSince = (fh: ReturnType<typeof createFakeHost>, before: number) =>
      fh.saved.slice(before).filter((s) => (s.creates?.length ?? 0) + (s.updates?.length ?? 0) > 0);

    it('stays on its security once the position is sold, and nothing is written', async () => {
      const { s, fh, before } = await booked();
      s.heldSecurities!['wf-1'] = [];
      await runSyncCore(fh.host, fh.store, { dividendSecurities: true, force: true });
      expect(theRow(fh)).toMatchObject({ activityType: 'DIVIDEND', assetId: 'asset-voo' });
      expect(writesSince(fh, before)).toEqual([]);
    });

    it('stays when the holdings read fails, or the other writer is not new enough', async () => {
      const { fh, before } = await booked();
      fh.host.listHeldSecurities = async () => { throw new Error('holdings unavailable'); };
      await runSyncCore(fh.host, fh.store, { dividendSecurities: true, force: true });
      await runSyncCore(fh.host, fh.store, { force: true });
      expect(theRow(fh)).toMatchObject({ activityType: 'DIVIDEND', assetId: 'asset-voo' });
      expect(writesSince(fh, before)).toEqual([]);
    });

    it('keeps its security when it is rewritten for another reason (the amount changed)', async () => {
      const { s, fh } = await booked({ mappingRules: [rule('Dividend Received', 'DIVIDEND')] });
      s.accountSet!.accounts[0].transactions![0].amount = '12.50';
      await runSyncCore(fh.host, fh.store, { force: true });
      expect(theRow(fh)).toMatchObject({ activityType: 'DIVIDEND', assetId: 'asset-voo', amount: 12.5 });
    });

    it('moves to the security the holdings name now', async () => {
      const { s, fh } = await booked();
      s.heldSecurities!['wf-1'] = [{ assetId: 'asset-voo-manual', symbol: 'VOO' }];
      await runSyncCore(fh.host, fh.store, { dividendSecurities: true, force: true });
      expect(theRow(fh)).toMatchObject({ activityType: 'DIVIDEND', assetId: 'asset-voo-manual' });
    });

    it('a rule typing it something else still wins', async () => {
      const { s, fh } = await booked({ mappingRules: [] });
      s.mappingRules!.push(rule('Dividend Received', 'INTEREST'));
      await runSyncCore(fh.host, fh.store, { dividendSecurities: true, force: true });
      expect(theRow(fh)).toMatchObject({ activityType: 'INTEREST', assetId: '$CASH-USD' });
    });
  });

  describe('a dividend paid after the position was sold', () => {
    const earlier = (assetId: string, assetSymbol?: string): HostActivity => ({
      id: 'act-old', accountId: 'wf-1', activityType: 'DIVIDEND', date: '2026-12-10', amount: 11.9,
      comment: `${VOO} · tx-old`, assetId, ...(assetSymbol ? { assetSymbol } : {}), sourceGroupId: null, metadata: null,
    });

    it('is booked on the security this account\'s earlier dividend under the ticker is on', async () => {
      const fh = createFakeHost(seed(VOO, { heldSecurities: { 'wf-1': [] }, existing: new Map([['wf-1', [earlier('asset-voo')]]]) }));
      await runSyncCore(fh.host, fh.store, { dividendSecurities: true });
      expect(theRow(fh)).toMatchObject({ activityType: 'DIVIDEND', assetId: 'asset-voo' });
    });

    it('never uses an earlier dividend on a phantom `$CASH` security, and moves a ruled one off it', async () => {
      const fh = createFakeHost(seed(VOO, { heldSecurities: { 'wf-1': [] }, existing: new Map([['wf-1', [earlier('uuid-phantom', '$CASH')]]]) }));
      await runSyncCore(fh.host, fh.store, { dividendSecurities: true });
      expect(theRow(fh)).toMatchObject({ activityType: 'DEPOSIT' });

      const stored = { ...earlier('uuid-phantom', '$CASH'), id: 'act-1', comment: `${VOO} · tx-div`, date: '2027-03-10', amount: 12.34 };
      const ruled = createFakeHost(seed(VOO, {
        heldSecurities: { 'wf-1': [] }, mappingRules: [rule('Dividend Received', 'DIVIDEND')], existing: new Map([['wf-1', [stored]]]),
      }));
      await runSyncCore(ruled.host, ruled.store, { dividendSecurities: true, force: true });
      expect(theRow(ruled)).toMatchObject({ id: 'act-1', activityType: 'INTEREST', assetId: '$CASH-USD' });
    });
  });

  describe('a position bought and sold between two dividends', () => {
    const snapshots = {
      'wf-1': [
        { date: '2027-02-20', positionCount: 1, securities: [{ assetId: 'asset-voo', symbol: 'VOO' }] },
        { date: '2027-03-05', positionCount: 0, securities: [] },
      ],
    };

    it('is booked on the security the last snapshot before the sale holds, and the next sync reads no snapshot', async () => {
      const fh = createFakeHost(seed(VOO, { heldSecurities: { 'wf-1': [] }, snapshots }));
      await runSyncCore(fh.host, fh.store, { dividendSecurities: true });
      expect(theRow(fh)).toMatchObject({ activityType: 'DIVIDEND', assetId: 'asset-voo' });

      const read = vi.fn(fh.host.listSnapshotSecurities!);
      fh.host.listSnapshotSecurities = read;
      const before = fh.saved.length;
      await runSyncCore(fh.host, fh.store, { dividendSecurities: true, force: true });
      expect(read).not.toHaveBeenCalled();
      expect(fh.saved.slice(before).filter((x) => (x.creates?.length ?? 0) + (x.updates?.length ?? 0) > 0)).toEqual([]);
    });

    it('reads no snapshot while the other writer is not new enough', async () => {
      const fh = createFakeHost(seed(VOO, { heldSecurities: { 'wf-1': [] }, snapshots }));
      const days = vi.fn(fh.host.listSnapshotDays!);
      fh.host.listSnapshotDays = days;
      await runSyncCore(fh.host, fh.store, {});
      expect(days).not.toHaveBeenCalled();
      expect(theRow(fh)).toMatchObject({ activityType: 'DEPOSIT' });
    });
  });

  describe('two writers, one of them with the gate shut', () => {
    const run = (fh: ReturnType<typeof createFakeHost>, gate: boolean) =>
      runSyncCore(fh.host, fh.store, { force: true, ...(gate ? { dividendSecurities: true } : {}) });
    const writes = (fh: ReturnType<typeof createFakeHost>, before: number) =>
      fh.saved.slice(before).filter((x) => (x.creates?.length ?? 0) + (x.updates?.length ?? 0) > 0);

    it('a DIVIDEND rule naming no security is INTEREST on both, so neither undoes the other', async () => {
      const fh = createFakeHost(seed('Dividend Received', { mappingRules: [rule('Dividend Received', 'DIVIDEND')], heldSecurities: { 'wf-1': [] } }));
      await run(fh, false);
      expect(theRow(fh)).toMatchObject({ activityType: 'INTEREST', assetId: '$CASH-USD' });
      const before = fh.saved.length;
      for (const gate of [true, false, true, false]) await run(fh, gate);
      expect(writes(fh, before)).toEqual([]);
    });

    it('a dividend one writer booked on its security stays there when the other syncs', async () => {
      const fh = createFakeHost(seed(VOO));
      await run(fh, true);
      expect(theRow(fh)).toMatchObject({ activityType: 'DIVIDEND', assetId: 'asset-voo' });
      const before = fh.saved.length;
      for (const gate of [false, true, false]) await run(fh, gate);
      expect(writes(fh, before)).toEqual([]);
    });

    it('an older writer\'s DIVIDEND on a phantom `$CASH` asset is left alone while the gate is shut', async () => {
      const phantom: HostActivity = {
        id: 'act-1', accountId: 'wf-1', activityType: 'DIVIDEND', date: '2027-03-10', amount: 12.34,
        comment: 'Dividend Received · tx-div', assetId: 'uuid-phantom', assetSymbol: '$CASH', sourceGroupId: null, metadata: null,
      };
      const fh = createFakeHost(seed('Dividend Received', {
        mappingRules: [rule('Dividend Received', 'DIVIDEND')], heldSecurities: { 'wf-1': [] }, existing: new Map([['wf-1', [phantom]]]),
      }));
      await run(fh, false);
      expect(theRow(fh)).toMatchObject({ activityType: 'DIVIDEND', assetId: 'uuid-phantom' });
      expect(writes(fh, 0)).toEqual([]);
    });
  });

  it('a trade entered by hand (no SimpleFin id in its note) names the security of a dividend paid after the sale', async () => {
    const buy: HostActivity = {
      id: 'act-buy', accountId: 'wf-1', activityType: 'BUY', date: '2027-01-05', amount: 1000,
      comment: 'Bought 2 VOO', assetId: 'asset-voo', assetSymbol: 'VOO', sourceGroupId: null, metadata: null,
    };
    const fh = createFakeHost(seed(VOO, { heldSecurities: { 'wf-1': [] }, existing: new Map([['wf-1', [buy]]]) }));
    await runSyncCore(fh.host, fh.store, { dividendSecurities: true });
    expect(theRow(fh)).toMatchObject({ activityType: 'DIVIDEND', assetId: 'asset-voo' });
  });
});

