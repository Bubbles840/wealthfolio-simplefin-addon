import { describe, it, expect } from 'vitest';
import { publishUncategorizedStatus, uncategorizedWindow } from './uncategorized-status.js';

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
