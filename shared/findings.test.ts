import { describe, it, expect } from 'vitest';
import {
  parseSnoozes,
  activeSnoozes,
  isSnoozable,
  partitionSnoozed,
  withSnooze,
  findingHandle,
  findingLabel,
  formatFindingsList,
  SNOOZE_DAYS,
} from './findings.js';
import type { SelfCheckFinding } from './self-check.js';

const NOW = new Date('2026-10-09T12:00:00Z');

describe('parseSnoozes', () => {
  it('parses valid ISO entries and safely handles malformed or non-object input', () => {
    // A corrupted secret must cost the snoozes, never crash the report that reads them.
    expect(parseSnoozes(null)).toEqual({});
    expect(parseSnoozes('')).toEqual({});
    expect(parseSnoozes('{ invalid json')).toEqual({});
    expect(parseSnoozes('["2026-10-10T12:00:00Z"]')).toEqual({});

    const raw = JSON.stringify({
      'feed-stale:Discover': '2026-11-08T12:00:00.000Z',
      'feed-stale:InvalidDate': 'not-a-date',
      'feed-stale:NotAString': 12345,
    });
    expect(parseSnoozes(raw)).toEqual({
      'feed-stale:Discover': '2026-11-08T12:00:00.000Z',
    });
  });
});

describe('activeSnoozes', () => {
  it('drops expired or current snoozes and keeps future ones', () => {
    // Expired entries are pruned so the stored secret does not grow indefinitely
    // and forgotten snoozes resurface on schedule.
    const past = new Date(NOW.getTime() - 1000).toISOString();
    const exactNow = NOW.toISOString();
    const future = new Date(NOW.getTime() + 86_400_000).toISOString();

    expect(activeSnoozes({
      'feed-stale:Past': past,
      'feed-stale:Now': exactNow,
      'feed-stale:Future': future,
    }, NOW)).toEqual({ 'feed-stale:Future': future });
  });
});

describe('isSnoozable', () => {
  it('allows keyed warnings to be snoozed while prohibiting problems, unkeyed findings, and unreadable signals', () => {
    // Problems (failing sync, unmapped accounts) and unreadable health signals
    // are failures or unknown health that must never be silenced.
    expect(isSnoozable({ kind: 'feed-stale', severity: 'warning', message: 'Quiet feed' })).toBe(false);
    expect(isSnoozable({ kind: 'sync-failing', severity: 'problem', key: 'sync-failing', message: 'Sync is failing' })).toBe(false);
    expect(isSnoozable({ kind: 'signals-unreadable', severity: 'warning', key: 'signals-unreadable', message: 'Health unknown' })).toBe(false);
    expect(isSnoozable({ kind: 'feed-stale', severity: 'warning', key: 'feed-stale:Discover', message: 'Discover is quiet' })).toBe(true);
  });
});

describe('partitionSnoozed', () => {
  it('separates active snoozable findings from visible ones while preserving order and keeping problems visible', () => {
    // Snoozing silences recurring warnings for a while; problems can never be
    // snoozed even if a key matches, and the visible order must stay stable.
    const activeUntil = new Date(NOW.getTime() + 86_400_000).toISOString();
    const expiredUntil = new Date(NOW.getTime() - 86_400_000).toISOString();

    const snoozedWarning: SelfCheckFinding = { kind: 'feed-stale', severity: 'warning', key: 'feed-stale:Discover', message: 'Discover feed stale' };
    const expiredWarning: SelfCheckFinding = { kind: 'feed-stale', severity: 'warning', key: 'feed-stale:Spend', message: 'Spend feed stale' };
    const snoozedProblem: SelfCheckFinding = { kind: 'sync-failing', severity: 'problem', key: 'sync-failing', message: 'Sync failing' };
    const normalWarning: SelfCheckFinding = { kind: 'feed-stale', severity: 'warning', key: 'feed-stale:Checking', message: 'Checking feed stale' };

    const { visible, snoozed } = partitionSnoozed(
      [snoozedWarning, expiredWarning, snoozedProblem, normalWarning],
      { 'feed-stale:Discover': activeUntil, 'feed-stale:Spend': expiredUntil, 'sync-failing': activeUntil },
      NOW,
    );

    expect(snoozed).toEqual([snoozedWarning]);
    expect(visible).toEqual([expiredWarning, snoozedProblem, normalWarning]);
  });
});

describe('withSnooze', () => {
  it('adds a new snooze expiring in SNOOZE_DAYS and prunes expired entries', () => {
    // Snoozing sets an exact future expiry and cleans up old state so storage stays bounded.
    const past = new Date(NOW.getTime() - 86_400_000).toISOString();
    const active = new Date(NOW.getTime() + 86_400_000).toISOString();
    const expectedUntil = new Date(NOW.getTime() + SNOOZE_DAYS * 86_400_000).toISOString();

    expect(withSnooze({ 'feed-stale:Expired': past, 'feed-stale:Active': active }, 'feed-stale:Discover', NOW)).toEqual({
      'feed-stale:Active': active,
      'feed-stale:Discover': expectedUntil,
    });
  });
});

describe('findingHandle', () => {
  it('produces an 8-character hex hash that is deterministic, distinct across keys, and within callback_data byte limits', () => {
    // Telegram caps callback_data at 64 bytes; the handle has to fit beside
    // an action prefix like "cz:fx:d:".
    const handle1 = findingHandle('feed-stale:Discover');
    const handle2 = findingHandle('feed-stale:Spend');

    expect(handle1).toBe(findingHandle('feed-stale:Discover'));
    expect(handle1).toMatch(/^[0-9a-f]{8}$/);
    expect(handle2).toMatch(/^[0-9a-f]{8}$/);
    expect(handle1).not.toBe(handle2);
    expect(new TextEncoder().encode(`cz:fx:d:${handle1}`).length).toBeLessThanOrEqual(64);
  });
});

describe('findingLabel', () => {
  it('prefers label over message and truncates long text to max characters ending with an ellipsis', () => {
    // Inline buttons have limited width; labels must stay short and readable.
    expect(findingLabel({
      kind: 'feed-stale', severity: 'warning', label: 'Discover: no new data',
      message: 'Discover has sent no new data in over 14 days',
    })).toBe('Discover: no new data');
    expect(findingLabel({ kind: 'sync-stale', severity: 'problem', message: 'No sync in 13h' })).toBe('No sync in 13h');

    const truncated = findingLabel({
      kind: 'feed-stale', severity: 'warning',
      message: 'This is a very long descriptive error message for an account feed',
    }, 20);
    expect(truncated).toHaveLength(20);
    expect(truncated.endsWith('…')).toBe(true);
  });
});

describe('formatFindingsList', () => {
  it('formats empty and multi-item lists, escapes markdown, includes snoozed count, and caps output within character budget', () => {
    // The list must render in Telegram: escaped, numbered, marked by
    // severity, and short of Telegram's 4096-character message limit.
    expect(formatFindingsList([])).toContain('*Nothing to fix.*');
    expect(formatFindingsList([])).not.toContain('✅');

    const formatted = formatFindingsList([
      { kind: 'feed-stale', severity: 'warning', message: 'Discover_Card feed stale' },
      { kind: 'sync-failing', severity: 'problem', message: 'Sync failing completely' },
    ], { snoozedCount: 2 });
    expect(formatted).toContain('🧹 *2 things to fix*');
    expect(formatted).toContain('1. ⚠️ Discover\\_Card feed stale');
    expect(formatted).toContain('2. 🚨 Sync failing completely');
    expect(formatted).toContain('2 snoozed');

    const longOutput = formatFindingsList(Array.from({ length: 200 }, (_, i) => ({
      kind: 'feed-stale' as const,
      severity: 'warning' as const,
      message: `Account_${i} repeated description message padding to ensure length reaches approximately 100 characters in total`,
    })));
    expect(longOutput.length).toBeLessThanOrEqual(4096);
    expect(longOutput).toMatch(/…and \d+ more/);
  });
});
