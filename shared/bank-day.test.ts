import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bankDayInstant, BANK_DAY_HOUR_UTC } from './bank-day.js';
import { runSyncCore, VALUATION_POLL } from './sync-core.js';
import { createFakeHost } from './fake-host.js';
import { linkPairByRecreate, unlinkPairByRecreate } from './link-pair.js';
import { recreateWrite, type FixRow } from './fix-row.js';
import type { SaveManyRequest } from './sync-host.js';

/** Wealthfolio's dedupe key keeps only the activity's UTC calendar date
 *  (`compute_idempotency_key`: `activity_date.format("%Y-%m-%d")` on a
 *  `DateTime<Utc>`, 3.8–3.10). */
const wealthfolioKeyDay = (stored: string) => new Date(stored).toISOString().slice(0, 10);

describe('bankDayInstant', () => {
  it('writes a bank day at noon UTC', () => {
    expect(BANK_DAY_HOUR_UTC).toBe(12);
    expect(bankDayInstant('2026-10-01')).toBe('2026-10-01T12:00:00Z');
    expect(bankDayInstant('2027-01-01')).toBe('2027-01-01T12:00:00Z');
  });

  it('leaves a timestamp, and anything that is not a bare date, as it is', () => {
    expect(bankDayInstant('2026-10-01T04:00:00+00:00')).toBe('2026-10-01T04:00:00+00:00');
    expect(bankDayInstant('2026-10-01T12:00:00Z')).toBe('2026-10-01T12:00:00Z');
    expect(bankDayInstant('')).toBe('');
    expect(bankDayInstant('soon')).toBe('soon');
  });

  it('falls on the bank day from UTC−11 to UTC+11', () => {
    const at = Date.parse(bankDayInstant('2026-10-01'));
    for (let offset = -11; offset <= 11; offset++) {
      expect(new Date(at + offset * 3_600_000).toISOString().slice(0, 10)).toBe('2026-10-01');
    }
  });

  it('shares Wealthfolio’s dedupe date with a row already stored at 00:00 UTC that day', () => {
    for (const stored of ['2026-10-01', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00+00:00']) {
      expect(wealthfolioKeyDay(bankDayInstant('2026-10-01'))).toBe(wealthfolioKeyDay(stored));
    }
  });
});

describe('the sync writes bank days at noon', () => {
  const NOW = new Date('2026-10-05T15:00:00Z');
  const OCT_1 = Math.floor(Date.parse('2026-10-01T18:00:00Z') / 1000);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
  });
  afterEach(() => vi.useRealTimers());

  const feed = (transactions: Array<{ id: string; amount: string; description: string; pending?: boolean }>) => ({
    errors: [],
    accounts: [{
      id: 'sfin-chk', name: 'Checking', currency: 'USD', balance: '0', 'balance-date': OCT_1,
      transactions: transactions.map((t) => ({ ...t, posted: OCT_1 })),
    }],
  });

  it('creates a new row at noon UTC on the bank date', async () => {
    const { host, store, saved } = createFakeHost({
      accountSet: feed([{ id: 'TRN-1', amount: '-12.50', description: 'KROGER' }]),
      mapping: { 'sfin-chk': 'wf-chk' },
    });
    await runSyncCore(host, store, { force: true });
    expect(saved.flatMap((s) => s.creates ?? []).map((c) => c.activityDate)).toEqual(['2026-10-01T12:00:00Z']);
  });

  it('never rewrites a row stored at 00:00 UTC for its date alone, and never creates it again', async () => {
    const { host, store, saved } = createFakeHost({
      accountSet: feed([{ id: 'TRN-1', amount: '-12.50', description: 'KROGER' }]),
      mapping: { 'sfin-chk': 'wf-chk' },
      upstreamWriteRules: true,
      existing: new Map([['wf-chk', [{
        id: 'row-1', accountId: 'wf-chk', activityType: 'WITHDRAWAL', date: '2026-10-01T00:00:00+00:00', amount: 12.5,
        comment: 'KROGER · TRN-1', sourceGroupId: null, subtype: null,
      }]]]),
    });
    const result = await runSyncCore(host, store, { force: true });
    expect(result.imported).toBe(0);
    expect(saved.flatMap((s) => [...(s.creates ?? []), ...(s.updates ?? [])])).toEqual([]);
  });

  it('updates a row the bank changed at noon on its date', async () => {
    const { host, store, saved } = createFakeHost({
      accountSet: feed([{ id: 'TRN-1', amount: '-14.00', description: 'KROGER' }]),
      mapping: { 'sfin-chk': 'wf-chk' },
      existing: new Map([['wf-chk', [{
        id: 'row-1', accountId: 'wf-chk', activityType: 'WITHDRAWAL', date: '2026-10-01T00:00:00+00:00', amount: 12.5,
        comment: 'KROGER · TRN-1', sourceGroupId: null, subtype: null,
      }]]]),
    });
    await runSyncCore(host, store, { force: true });
    expect(saved.flatMap((s) => s.updates ?? []).map((u) => [u.id, u.activityDate, u.amount])).toEqual([['row-1', '2026-10-01T12:00:00Z', 14]]);
  });
});

describe('re-creates from a stored row are written at noon', () => {
  const leg = (wfId: string, accountId: string, activityType: string) => ({
    wfId, accountId, txId: `TRN-${wfId}`, activityType, date: '2026-10-01', absCents: 5000, currency: 'USD', comment: `MOVE · TRN-${wfId}`,
  });

  it('linking re-creates both legs at noon on their dates', async () => {
    const requests: SaveManyRequest[] = [];
    await linkPairByRecreate(async (req) => {
      requests.push(req);
      return { created: (req.creates ?? []).map((c, i) => ({ id: `new-${i}`, accountId: c.accountId, activityType: c.activityType, date: c.activityDate, amount: c.amount ?? null, comment: c.comment, sourceGroupId: c.sourceGroupId ?? null })), updated: [], errors: [] };
    }, [leg('a', 'wf-chk', 'TRANSFER_OUT'), leg('b', 'wf-sav', 'TRANSFER_IN')]);
    expect(requests[1].creates!.map((c) => c.activityDate)).toEqual(['2026-10-01T12:00:00Z', '2026-10-01T12:00:00Z']);
  });

  it('unlinking re-creates both legs at noon on their dates', async () => {
    const requests: SaveManyRequest[] = [];
    await unlinkPairByRecreate(async (req) => {
      requests.push(req);
      return { created: (req.creates ?? []).map((c, i) => ({ id: `new-${i}`, accountId: c.accountId, activityType: c.activityType, date: c.activityDate, amount: c.amount ?? null, comment: c.comment })), updated: [], errors: [] };
    }, [{ ...leg('a', 'wf-chk', 'TRANSFER_OUT'), newType: 'WITHDRAWAL' }, { ...leg('b', 'wf-sav', 'TRANSFER_IN'), newType: 'DEPOSIT' }]);
    expect(requests[0].creates!.map((c) => c.activityDate)).toEqual(['2026-10-01T12:00:00Z', '2026-10-01T12:00:00Z']);
  });

  it('a fix writes a row back at noon on its date', () => {
    const row: FixRow = {
      id: 'a1', accountId: 'wf-chk', accountName: 'Checking', accountType: 'CASH', type: 'WITHDRAWAL', date: '2026-10-01',
      absCents: 1250, feeCents: 0, currency: 'USD', notes: 'KROGER · TRN-1', subtype: null, flowExternal: null, grouped: false,
    };
    expect(recreateWrite(row).activityDate).toBe('2026-10-01T12:00:00Z');
  });
});
