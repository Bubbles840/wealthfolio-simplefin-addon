import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { publishUncategorizedStatus, publishUncategorizedStatusForDbPath, uncategorizedWindow } from './uncategorized-status.js';

describe('publishUncategorizedStatus', () => {
  it('publishes count and timestamp under the shared key', async () => {
    const writes: Record<string, string> = {};
    await publishUncategorizedStatus(
      async (k, v) => { writes[k] = v; },
      () => 7,
      new Date('2026-08-08T12:00:00Z'),
    );
    expect(JSON.parse(writes['uncategorized_status'])).toEqual({
      count: 7, asOf: '2026-08-08T12:00:00.000Z',
    });
  });

  it('never throws — a stats tile must not be able to break a sync', async () => {
    await expect(
      publishUncategorizedStatus(async () => { throw new Error('host down'); }, () => 1),
    ).resolves.toBeUndefined();
    await expect(
      publishUncategorizedStatus(async () => {}, () => { throw new Error('db gone'); }),
    ).resolves.toBeUndefined();
  });
});

describe('uncategorizedWindow', () => {
  it('spans the last 90 days, end-exclusive tomorrow', () => {
    expect(uncategorizedWindow(new Date('2026-08-08T15:30:00Z'))).toEqual({
      start: '2026-05-10', end: '2026-08-09',
    });
  });
});

describe('publishUncategorizedStatusForDbPath', () => {
  it('publishes nothing when the path is unset', async () => {
    const setSecret = vi.fn(async () => {});
    const countUncategorized = vi.fn(() => 3);
    await publishUncategorizedStatusForDbPath('', setSecret, countUncategorized);
    expect(setSecret).not.toHaveBeenCalled();
    expect(countUncategorized).not.toHaveBeenCalled();
  });

  it('publishes nothing — not even count: 0 — when the path does not exist', async () => {
    // The point of this test: getNativeUncategorizedSpending-style readers return
    // [] rather than throwing for a missing file, so without an existsSync check
    // here a stale or misconfigured WEALTHFOLIO_DB_PATH would publish a confident
    // "count: 0" (nothing needs a category) instead of skipping — which is the
    // exact false-vs-unknown outcome the guard exists to prevent. This must fail
    // against a version of publishUncategorizedStatusForDbPath that only checks
    // truthiness of dbPath and not its existence.
    const setSecret = vi.fn(async () => {});
    const countUncategorized = vi.fn(() => 0);
    await publishUncategorizedStatusForDbPath(
      '/nonexistent/path/wealthfolio.db',
      setSecret,
      countUncategorized,
    );
    expect(setSecret).not.toHaveBeenCalled();
    expect(countUncategorized).not.toHaveBeenCalled();
  });

  it('publishes the count when the db path exists, using the 90-day window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfin-uncategorized-status-test-'));
    const dbPath = join(dir, 'wealthfolio.db');
    writeFileSync(dbPath, '');
    try {
      const writes: Record<string, string> = {};
      const countUncategorized = vi.fn(() => 5);
      await publishUncategorizedStatusForDbPath(
        dbPath,
        async (k, v) => { writes[k] = v; },
        countUncategorized,
        new Date('2026-08-08T15:30:00Z'),
      );
      expect(countUncategorized).toHaveBeenCalledWith(dbPath, '2026-05-10', '2026-08-09');
      expect(JSON.parse(writes['uncategorized_status'])).toEqual({
        count: 5, asOf: '2026-08-08T15:30:00.000Z',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
