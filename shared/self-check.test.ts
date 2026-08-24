import { describe, it, expect } from 'vitest';
import {
  evaluateSelfCheck, formatSelfCheckBlock, SYNC_STALE_HOURS, FEED_STALE_DAYS,
} from './self-check.js';

const NOW = new Date('2026-08-24T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const daysAgoUnix = (d: number) => Math.floor((NOW.getTime() - d * 86_400_000) / 1000);

describe('evaluateSelfCheck', () => {
  it('says nothing when everything is healthy', () => {
    // The whole point of the daily block: on a good day it must not exist.
    // A reassurance printed every single day stops being read long before the
    // day it is wrong.
    const findings = evaluateSelfCheck({
      lastSuccessAt: hoursAgo(2),
      unmappedAccountNames: [],
      accounts: [{ name: 'Checking', balanceDate: daysAgoUnix(1) }],
    }, NOW);
    expect(findings).toEqual([]);
    expect(formatSelfCheckBlock(findings)).toBe('');
  });

  it('separates "could not check" from "checked and healthy"', () => {
    // The distinction /status already draws, and the one that matters most: a
    // 401 rendering as a clean bill of health is how a dead connection reads
    // as fine. An unreadable signal does not support an all-clear.
    const findings = evaluateSelfCheck({ lastSuccessAt: null, healthUnreadable: true }, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('signals-unreadable');
    expect(findings[0].message).toContain('not confirmed healthy');
  });

  it('does not claim a stale sync when the health record was never written', () => {
    // Before the companion's first sync there is no record. That is a fresh
    // install, not a failure, and reporting it as one would greet every new
    // user with a red alarm.
    expect(evaluateSelfCheck({ lastSuccessAt: null }, NOW)).toEqual([]);
  });

  it('reports a sync that has stopped succeeding', () => {
    const findings = evaluateSelfCheck({ lastSuccessAt: hoursAgo(SYNC_STALE_HOURS + 1) }, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('sync-stale');
    expect(findings[0].severity).toBe('problem');
    expect(findings[0].message).toContain('13h');
  });

  it('tolerates an ordinary skipped run', () => {
    // The default schedule is 4 hours. A container restart or a sleeping
    // laptop must not produce an alarm, or the alarm means nothing.
    expect(evaluateSelfCheck({ lastSuccessAt: hoursAgo(SYNC_STALE_HOURS - 1) }, NOW)).toEqual([]);
  });

  it('does not read a clock disagreement as a stale sync', () => {
    // A future timestamp is a clock problem, not an old sync. "-3h stale"
    // would be a false alarm about entirely the wrong thing.
    expect(evaluateSelfCheck({ lastSuccessAt: hoursAgo(-3) }, NOW)).toEqual([]);
  });

  it('prefers the active failure over the staleness it causes', () => {
    // Both are true while a streak runs, but the error text is the actionable
    // half. Reporting both would just say the same outage twice.
    const findings = evaluateSelfCheck({
      lastSuccessAt: hoursAgo(30),
      firstFailedAt: hoursAgo(26),
      lastError: 'SimpleFin /accounts failed: 524',
    }, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('sync-failing');
    expect(findings[0].message).toContain('26h');
    expect(findings[0].message).toContain('524');
  });

  it('names an unmapped account rather than counting it', () => {
    // This is the failure that started the whole investigation: an account
    // mapped to nothing syncs nothing, and says nothing. The name IS the fix,
    // so a bare count would only prompt a hunt through the addon.
    const findings = evaluateSelfCheck({
      lastSuccessAt: hoursAgo(1), unmappedAccountNames: ['Robinhood Gold'],
    }, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('unmapped-accounts');
    expect(findings[0].message).toContain('Robinhood Gold');
    expect(findings[0].message).toContain('nothing from it is syncing');
  });

  it('lists several unmapped accounts', () => {
    const findings = evaluateSelfCheck({
      lastSuccessAt: hoursAgo(1), unmappedAccountNames: ['A', 'B'],
    }, NOW);
    expect(findings[0].message).toContain('2 accounts');
    expect(findings[0].message).toContain('A, B');
  });

  it('flags a feed that has gone quiet', () => {
    const findings = evaluateSelfCheck({
      lastSuccessAt: hoursAgo(1),
      accounts: [
        { name: 'Spend', balanceDate: daysAgoUnix(FEED_STALE_DAYS + 1) },
        { name: 'Savings', balanceDate: daysAgoUnix(2) },
      ],
    }, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('feed-stale');
    expect(findings[0].message).toContain('Spend');
    expect(findings[0].message).not.toContain('Savings');
  });

  it('does not treat a missing balance date as a stale one', () => {
    // SimpleFin omits the date for some accounts. Treating unknown as old
    // would flag them permanently, with nothing the user could do about it.
    expect(evaluateSelfCheck({
      lastSuccessAt: hoursAgo(1),
      accounts: [{ name: 'Odd', balanceDate: null }],
    }, NOW)).toEqual([]);
  });

  it('puts problems above warnings', () => {
    const findings = evaluateSelfCheck({
      lastSuccessAt: hoursAgo(1),
      unmappedAccountNames: ['Robinhood Gold'],
      accounts: [{ name: 'Spend', balanceDate: daysAgoUnix(FEED_STALE_DAYS + 1) }],
    }, NOW);
    expect(findings.map((f) => f.kind)).toEqual(['unmapped-accounts', 'feed-stale']);
  });
});

describe('formatSelfCheckBlock', () => {
  it('marks problems and warnings differently', () => {
    const text = formatSelfCheckBlock([
      { kind: 'unmapped-accounts', severity: 'problem', message: 'X is not mapped' },
      { kind: 'feed-stale', severity: 'warning', message: 'Y has sent no new data' },
    ]);
    expect(text).toContain('*Needs attention*');
    expect(text).toContain('🚨 X is not mapped');
    expect(text).toContain('⚠️ Y has sent no new data');
  });
});
