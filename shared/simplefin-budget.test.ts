import { describe, it, expect, vi } from 'vitest';
import {
  budgetStatusLine, checkedLine, clockTime, decideSimplefinRequest, directCallLine, gateLine, parseRequestLog, requestLogIo,
  requestsToday, reserveSimplefinRequest, SIMPLEFIN_DAILY_LIMIT, SIMPLEFIN_GAP_MS, SIMPLEFIN_SETUP_CEILING, type RequestLogIo,
} from './simplefin-budget.js';

// Local wall-clock dates, so "next sync at 3:10 PM" reads the same in every zone.
const NOW = new Date(2026, 9, 18, 15, 0, 0);
const minutes = (m: number) => NOW.getTime() - m * 60_000;
/** `n` requests, the newest `newestMinutesAgo` ago, one every 30 minutes before it. */
const logOf = (n: number, newestMinutesAgo = 60) => Array.from({ length: n }, (_, i) => minutes(newestMinutesAgo + i * 30));
const memoryIo = (raw: string | null): RequestLogIo & { raw: string | null } => {
  const io = { raw, read: async () => io.raw, write: async (v: string) => { io.raw = v; } };
  return io;
};

describe('the limits (C2, C5)', () => {
  it('are 20 a day, 24 for Setup and Refresh accounts, 5 minutes apart', () => {
    expect([SIMPLEFIN_DAILY_LIMIT, SIMPLEFIN_SETUP_CEILING, SIMPLEFIN_GAP_MS]).toEqual([20, 24, 300_000]);
  });
});

describe('decideSimplefinRequest', () => {
  it('lets the 20th download of the day through and refuses the 21st, for a sync and an automatic call alike', () => {
    for (const purpose of ['manual', 'scheduled', 'auto'] as const) {
      expect(decideSimplefinRequest(logOf(19), purpose, NOW)).toEqual({ kind: 'go', at: NOW });
      expect(decideSimplefinRequest(logOf(20), purpose, NOW).kind).toBe('budget');
    }
  });

  it('says when the oldest counted request leaves the 24 hours', () => {
    // 20 requests: the oldest was 60 + 19 × 30 = 630 minutes ago, so it leaves the window 24 h after.
    const gate = decideSimplefinRequest(logOf(20), 'manual', NOW);
    expect(gate).toEqual({ kind: 'budget', nextAt: new Date(minutes(630) + 24 * 3_600_000) });
  });

  it('lets Setup and Refresh accounts use the headroom up to 24, ignoring the gap', () => {
    expect(decideSimplefinRequest(logOf(23, 1), 'setup', NOW)).toEqual({ kind: 'go', at: NOW });
    expect(decideSimplefinRequest(logOf(24), 'setup', NOW).kind).toBe('budget');
  });

  it('inside 5 minutes of the last download: a manual action checks only, anything else waits', () => {
    expect(decideSimplefinRequest(logOf(3, 2), 'manual', NOW)).toEqual({ kind: 'checkOnly', lastAt: new Date(minutes(2)) });
    expect(decideSimplefinRequest(logOf(3, 2), 'scheduled', NOW)).toEqual({ kind: 'wait', lastAt: new Date(minutes(2)) });
    expect(decideSimplefinRequest(logOf(3, 2), 'auto', NOW).kind).toBe('wait');
    expect(decideSimplefinRequest(logOf(3, 5), 'manual', NOW).kind).toBe('go');
  });

  it('budget wins over the gap', () => {
    expect(decideSimplefinRequest(logOf(20, 2), 'manual', NOW).kind).toBe('budget');
  });

  it('ignores a stamp more than an hour ahead for the gap, but still counts it', () => {
    const far = NOW.getTime() + 3 * 3_600_000;
    for (const purpose of ['manual', 'scheduled'] as const) {
      expect(decideSimplefinRequest([far, ...logOf(3)], purpose, NOW)).toEqual({ kind: 'go', at: NOW });
    }
    expect(decideSimplefinRequest([far, ...logOf(19)], 'manual', NOW).kind).toBe('budget');
    expect(decideSimplefinRequest([NOW.getTime() + 2 * 60_000], 'scheduled', NOW).kind).toBe('wait');
  });

  it('forgets requests older than 24 hours, and counts one the other writer stamped a little ahead', () => {
    expect(decideSimplefinRequest([...logOf(19), minutes(24 * 60 + 1)], 'scheduled', NOW).kind).toBe('go');
    expect(decideSimplefinRequest([NOW.getTime() + 60_000], 'manual', NOW).kind).toBe('checkOnly');
  });
});

describe('reserveSimplefinRequest (C1)', () => {
  it('records the request BEFORE the caller sends it, newest first, pruned to 24 hours', async () => {
    const io = memoryIo(JSON.stringify([new Date(minutes(10)).toISOString(), new Date(minutes(25 * 60)).toISOString()]));
    expect(await reserveSimplefinRequest(io, 'manual', NOW)).toEqual({ kind: 'go', at: NOW });
    expect(JSON.parse(io.raw!)).toEqual([NOW.toISOString(), new Date(minutes(10)).toISOString()]);
  });

  it('records nothing when it says no', async () => {
    const io = memoryIo(JSON.stringify(logOf(20).map((t) => new Date(t).toISOString())));
    const before = io.raw;
    expect((await reserveSimplefinRequest(io, 'manual', NOW)).kind).toBe('budget');
    expect(io.raw).toBe(before);
  });

  it('fails closed: a read that fails, a corrupt record (reset, so only this call is blocked), a write that fails', async () => {
    expect(await reserveSimplefinRequest({ read: async () => { throw new Error('401'); }, write: vi.fn() }, 'manual', NOW)).toEqual({ kind: 'unreadable' });
    const corrupt = memoryIo('{not json');
    expect(await reserveSimplefinRequest(corrupt, 'manual', NOW)).toEqual({ kind: 'unreadable' });
    expect(corrupt.raw).toBe('[]');
    expect((await reserveSimplefinRequest(corrupt, 'manual', NOW)).kind).toBe('go');
    expect(await reserveSimplefinRequest({ read: async () => null, write: async () => { throw new Error('offline'); } }, 'manual', NOW)).toEqual({ kind: 'unreadable' });
  });

  it('is absent for a store that keeps no record', () => {
    expect(requestLogIo({})).toBeNull();
    expect(requestLogIo({ getSimplefinRequests: async () => null, setSimplefinRequests: async () => {} })).not.toBeNull();
  });
});

describe('parseRequestLog', () => {
  it('reads a list of times newest first; absent is empty; anything else is corrupt', () => {
    expect(parseRequestLog(JSON.stringify(['2026-10-18T10:00:00.000Z', '2026-10-18T12:00:00.000Z'])))
      .toEqual([Date.parse('2026-10-18T12:00:00.000Z'), Date.parse('2026-10-18T10:00:00.000Z')]);
    expect(parseRequestLog(null)).toEqual([]);
    expect(parseRequestLog('{"a":1}')).toBeNull();
    expect(parseRequestLog('["not a time"]')).toBeNull();
  });
});

describe('the one lines (C3, C4)', () => {
  it('say why nothing was downloaded, each under 80 characters', () => {
    const lines = [
      gateLine({ kind: 'budget', nextAt: new Date(2026, 9, 18, 15, 10) }, NOW),
      gateLine({ kind: 'unreadable' }, NOW),
      gateLine({ kind: 'wait', lastAt: new Date(minutes(3)) }, NOW),
      gateLine({ kind: 'checkOnly', lastAt: new Date(minutes(3)) }, NOW),
      checkedLine(null, NOW),
    ];
    expect(lines).toEqual([
      "SimpleFin's daily limit is used up — next sync at 3:10 PM.",
      "Couldn't read the SimpleFin request log — nothing was downloaded.",
      'SimpleFin was asked 3 min ago — this scheduled sync was skipped.',
      'Balances checked · bank data is from 3 min ago.',
      'Balances not checked this time — the next download will check them.',
    ]);
    for (const line of lines) expect(line!.length).toBeLessThanOrEqual(80);
    expect(gateLine({ kind: 'go', at: NOW }, NOW)).toBeNull();
  });

  it('read the clock the way a person does', () => {
    expect([clockTime(new Date(2026, 9, 18, 0, 5)), clockTime(new Date(2026, 9, 18, 9, 0)), clockTime(new Date(2026, 9, 18, 12, 30)), clockTime(new Date(2026, 9, 18, 23, 59))])
      .toEqual(['12:05 AM', '9:00 AM', '12:30 PM', '11:59 PM']);
  });

  it('show the day\'s count quietly', () => {
    expect(requestsToday(JSON.stringify(logOf(7).map((t) => new Date(t).toISOString())), NOW)).toBe(7);
    expect(requestsToday(null, NOW)).toBe(0);
    expect(requestsToday('{bad', NOW)).toBeNull();
    expect(budgetStatusLine(7)).toBe('SimpleFin: 7 of 20 today');
  });
});

describe('directCallLine — a SimpleFin call outside a sync (C5)', () => {
  it('records and allows Setup into the headroom; refuses an automatic call past 20 or inside the gap', async () => {
    let raw: string | null = JSON.stringify(logOf(23, 1).map((t) => new Date(t).toISOString()));
    const store = { getSimplefinRequests: async () => raw, setSimplefinRequests: async (v: string) => { raw = v; } };
    expect(await directCallLine(store, 'setup', NOW)).toBeNull();
    expect(JSON.parse(raw!)).toHaveLength(24);
    expect(await directCallLine(store, 'setup', NOW)).toMatch(/^SimpleFin's daily limit is used up/);
    raw = JSON.stringify(logOf(3, 2).map((t) => new Date(t).toISOString()));
    expect(await directCallLine(store, 'auto', NOW)).not.toBeNull();
    expect(await directCallLine({}, 'auto', NOW)).toBeNull();
  });
});
