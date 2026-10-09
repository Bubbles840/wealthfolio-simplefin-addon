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

  it('flags each quiet feed on its own, so each can be snoozed on its own', () => {
    const findings = evaluateSelfCheck({
      lastSuccessAt: hoursAgo(1),
      accounts: [
        { name: 'Discover', balanceDate: daysAgoUnix(FEED_STALE_DAYS + 30) },
        { name: 'Spend', balanceDate: daysAgoUnix(FEED_STALE_DAYS + 1) },
      ],
    }, NOW);
    expect(findings.map((f) => f.key)).toEqual(['feed-stale:Discover', 'feed-stale:Spend']);
    expect(findings[0].label).toBe('Discover: no new data');
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

describe('version skew', () => {
  const healthy = { lastSuccessAt: hoursAgo(2) };

  it('flags an addon and companion running different versions', () => {
    // The two halves deploy separately (pull the image, upload the zip), and
    // forgetting one leaves them skewed silently — the exact failure this
    // finding exists to make loud.
    const findings = evaluateSelfCheck(
      { ...healthy, addonVersion: '1.33.0', companionVersion: '1.34.0' }, NOW,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('version-skew');
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].message).toContain('1.33.0');
    expect(findings[0].message).toContain('1.34.0');
  });

  it('stays quiet when both halves match', () => {
    expect(evaluateSelfCheck(
      { ...healthy, addonVersion: '1.34.0', companionVersion: '1.34.0' }, NOW,
    )).toEqual([]);
  });

  // The skew warning used to offer both remedies at once — "upload the zip, OR
  // reload the tab if you already have" — because the addon's self-reported
  // version cannot tell them apart: it is written when the bundle LOADS, so it
  // means "the newest build that ever ran in a browser". Twice that read as a
  // false alarm (2026-09-06, 2026-09-20). The installed zip is on disk in the
  // directory the companion already mounts, and its manifest settles which
  // remedy applies.
  it('says the zip was never uploaded when the INSTALLED addon is the old one', () => {
    const [finding] = evaluateSelfCheck({
      ...healthy, addonVersion: '1.49.0', installedAddonVersion: '1.49.0', companionVersion: '1.52.0',
    }, NOW);
    expect(finding.kind).toBe('version-skew');
    expect(finding.message).toContain('simplefin-sync-1.52.0.zip');
    expect(finding.message).toContain('1.49.0');
    // Not the tab's fault, so the reload hint would only mislead.
    expect(finding.message).not.toMatch(/reload|refresh/i);
  });

  it('leaves a stale TAB to the in-app banner when the right zip is installed', () => {
    // The browser-reported version is the most recent build to LOAD, so it
    // also reads stale for someone who has simply not opened Wealthfolio since
    // updating — and the morning report nagged about a tab that did not exist
    // (2026-10). From 1.57.0 a stale tab shows its own banner, which is where
    // it can actually be refreshed.
    expect(evaluateSelfCheck({
      ...healthy, addonVersion: '1.49.0', installedAddonVersion: '1.52.0', companionVersion: '1.52.0',
    }, NOW)).toEqual([]);
  });

  it('flags an out-of-date installed zip even when no bundle has reported in', () => {
    // A zip older than 1.34.0 never writes its version, and neither does one
    // nobody has opened since install. The manifest is evidence on its own.
    const [finding] = evaluateSelfCheck({
      ...healthy, installedAddonVersion: '1.49.0', companionVersion: '1.52.0',
    }, NOW);
    expect(finding.kind).toBe('version-skew');
    expect(finding.message).toContain('simplefin-sync-1.52.0.zip');
  });

  it('stays quiet when installed, running and companion all agree', () => {
    expect(evaluateSelfCheck({
      ...healthy, addonVersion: '1.52.0', installedAddonVersion: '1.52.0', companionVersion: '1.52.0',
    }, NOW)).toEqual([]);
  });

  it('stays quiet when the right zip is installed and nothing has loaded it yet', () => {
    // Installed and current, no browser report at all: there is no evidence of
    // anything stale, and a warning here would fire for every user who updates
    // from the server and has not opened the app since.
    expect(evaluateSelfCheck({
      ...healthy, installedAddonVersion: '1.52.0', companionVersion: '1.52.0',
    }, NOW)).toEqual([]);
  });

  it('stays quiet when the addon version is unknown', () => {
    // Older zips never published their version; treating absence as skew would
    // alarm every user whose companion updated first, forever.
    expect(evaluateSelfCheck({ ...healthy, companionVersion: '1.34.0' }, NOW)).toEqual([]);
  });
});

describe('balance drift (1.57: the daily report carries what the drift alerts said)', () => {
  const daysAgoIso = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

  it('names each account that differs from the bank, on its own snoozable key', () => {
    const findings = evaluateSelfCheck({
      lastSuccessAt: hoursAgo(1),
      accounts: [
        { name: 'Checking', balanceDate: daysAgoUnix(1), drift: 1234.5, driftSince: daysAgoIso(1) },
        { name: 'Savings', balanceDate: daysAgoUnix(1), drift: null },
      ],
    }, NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'balance-drift', severity: 'warning', key: 'balance-drift:Checking', label: 'Checking: balance differs',
    });
    // bank − Wealthfolio is positive, so Wealthfolio is the lower one.
    expect(findings[0].message).toMatch(/^Checking is \$1,234\.50 below the bank's balance/);
    // Young: most often the bank's feed catching up, so it asks for nothing yet.
    expect(findings[0].message).toContain('clears on its own');
  });

  it('says "above" when Wealthfolio is the higher of the two', () => {
    const [f] = evaluateSelfCheck({
      lastSuccessAt: hoursAgo(1),
      accounts: [{ name: 'Checking', balanceDate: daysAgoUnix(1), drift: -36.1, driftSince: daysAgoIso(2) }],
    }, NOW);
    expect(f.message).toMatch(/^Checking is \$36\.10 above the bank's balance/);
  });

  it('says nothing below the alert threshold, where no alert episode is open', () => {
    // `drift` is recorded from $1 for the balance chips; only an open episode
    // (past the user's alert threshold, never when alerts are off) dates it.
    expect(evaluateSelfCheck({
      lastSuccessAt: hoursAgo(1),
      accounts: [{ name: 'Savings', balanceDate: daysAgoUnix(1), drift: 5.25, driftSince: null }],
    }, NOW)).toEqual([]);
  });

  it('says so once it has outlived feed lag, and stays snoozable', () => {
    const [f] = evaluateSelfCheck({
      lastSuccessAt: hoursAgo(1),
      accounts: [{ name: 'Checking', balanceDate: daysAgoUnix(1), drift: 50, driftSince: daysAgoIso(11) }],
    }, NOW);
    // A warning, not a problem: problems print in full every morning with no
    // snooze, and the old aged alert was said once.
    expect(f.severity).toBe('warning');
    expect(f.message).toContain('over 10 days');
    expect(f.message).not.toContain('clears on its own');
    // Same condition, same key: a snooze taken while it was young still holds.
    expect(f.key).toBe('balance-drift:Checking');
  });
});

describe('accounts that share a name (1.57.1)', () => {
  it('gives each its own key and says which is which', () => {
    // Two "CHECKING"s used to share one key: snoozing one silenced both, and
    // the menu opened the first one's detail for either button.
    const findings = evaluateSelfCheck({
      lastSuccessAt: hoursAgo(1),
      accounts: [
        { id: 'ACT-aaaa1111', name: 'CHECKING', balanceDate: daysAgoUnix(FEED_STALE_DAYS + 1) },
        { id: 'ACT-bbbb2222', name: 'CHECKING', balanceDate: daysAgoUnix(FEED_STALE_DAYS + 1) },
        { id: 'ACT-cccc3333', name: 'Savings', balanceDate: daysAgoUnix(FEED_STALE_DAYS + 1) },
      ],
    }, NOW);
    expect(findings.map((f) => f.key)).toEqual([
      'feed-stale:CHECKING#ACT-aaaa1111', 'feed-stale:CHECKING#ACT-bbbb2222',
      // A unique name keeps its key, so a snooze taken before still holds.
      'feed-stale:Savings',
    ]);
    expect(findings[0].message).toMatch(/^CHECKING \(…1111\) has sent no new data/);
    expect(findings[1].label).toBe('CHECKING (…2222): no new data');
  });
});
