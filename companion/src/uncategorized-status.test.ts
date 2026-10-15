import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { publishUncategorizedStatus, publishUncategorizedStatusForDbPath, uncategorizedWindow } from './uncategorized-status.js';

const native = (id: string, over: Record<string, unknown> = {}) => ({
  activityId: id,
  wfAccountId: 'wf-a',
  notes: `THANKYOU POINTS REDEEMED · TRN-${id}`,
  amountCents: 7000,
  date: '2026-08-01',
  accountName: 'Citi Double Cash',
  ...over,
});

describe('publishUncategorizedStatus', () => {
  it('publishes count and timestamp under the shared key', async () => {
    const writes: Record<string, string> = {};
    await publishUncategorizedStatus(
      async (k, v) => { writes[k] = v; },
      () => [],
      async () => ({}),
      new Date('2026-08-08T12:00:00Z'),
    );
    expect(JSON.parse(writes['uncategorized_status'])).toEqual({
      count: 0, asOf: '2026-08-08T12:00:00.000Z', rows: [],
    });
  });

  it('never throws — a stats tile must not be able to break a sync', async () => {
    await expect(
      publishUncategorizedStatus(
        async () => { throw new Error('host down'); },
        () => [],
        async () => ({}),
      ),
    ).resolves.toBeUndefined();
    await expect(
      publishUncategorizedStatus(
        async () => {},
        () => { throw new Error('db gone'); },
        async () => ({}),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('publishing the row list', () => {
  it('publishes a display-ready row per uncategorized transaction', async () => {
    // The addon cannot compute this list — the SDK exposes no category data — so
    // whatever is published here is all it will ever know.
    const writes: Record<string, string> = {};
    await publishUncategorizedStatus(
      async (k, v) => { writes[k] = v; },
      () => [native('a', { direction: 'in' })],
      async () => ({}),
      new Date('2026-08-09T12:00:00.000Z'),
    );
    const payload = JSON.parse(writes['uncategorized_status']);
    expect(payload.count).toBe(1);
    expect(payload.rows).toEqual([{
      activityId: 'a',
      date: '2026-08-01',
      amountCents: 7000,
      // The stored note's ` · TRN-…` bookkeeping suffix is stripped: the addon
      // renders this verbatim and must not show an internal id.
      description: 'THANKYOU POINTS REDEEMED',
      accountName: 'Citi Double Cash',
      // Direction rides through untouched — the addon's list signs with it.
      direction: 'in',
    }]);
  });

  it('excludes dismissed rows from BOTH the count and the list', async () => {
    // The tile and the list are the same number seen two ways. Filtering one and
    // not the other is the bug this feature was built to remove.
    const writes: Record<string, string> = {};
    await publishUncategorizedStatus(
      async (k, v) => { writes[k] = v; },
      () => [native('a'), native('b'), native('c')],
      async () => ({ b: '2026-08-01T00:00:00.000Z' }),
      new Date('2026-08-09T12:00:00.000Z'),
    );
    const payload = JSON.parse(writes['uncategorized_status']);
    expect(payload.count).toBe(2);
    expect(payload.rows.map((r: any) => r.activityId)).toEqual(['a', 'c']);
  });

  it('caps the list at 50 while the count keeps reporting the truth', async () => {
    // A truncated list must not make the tile understate the backlog.
    const writes: Record<string, string> = {};
    const many = Array.from({ length: 63 }, (_, i) => native(`a${i}`));
    await publishUncategorizedStatus(
      async (k, v) => { writes[k] = v; },
      () => many,
      async () => ({}),
      new Date('2026-08-09T12:00:00.000Z'),
    );
    const payload = JSON.parse(writes['uncategorized_status']);
    expect(payload.count).toBe(63);
    expect(payload.rows).toHaveLength(50);
  });

  it('still never throws when reading the ledger fails', async () => {
    // A stats tile must not be able to fail a sync; a hidden or stale tile is
    // also its off state, so swallowing degrades to the correct thing.
    await expect(publishUncategorizedStatus(
      async () => {},
      () => [native('a')],
      async () => { throw new Error('secret unreadable'); },
    )).resolves.toBeUndefined();
  });
});

describe('guessed categories', () => {
  const NOW = new Date('2026-10-14T12:00:00Z');
  const filing = (description: string, categoryId = 'cat-gro', categoryName = 'Groceries') => ({ description, categoryId, categoryName });
  const publish = async (rows: ReturnType<typeof native>[], readFilings?: () => ReturnType<typeof filing>[]) => {
    const writes: Record<string, string> = {};
    await publishUncategorizedStatus(async (k, v) => { writes[k] = v; }, () => rows, async () => ({}), NOW, readFilings);
    return JSON.parse(writes['uncategorized_status']);
  };

  it('puts the guess on a row whose merchant you filed the same way twice', async () => {
    const payload = await publish(
      [native('a', { notes: 'KROGER #415 · TRN-a' }), native('b', { notes: 'TARGET 0042 · TRN-b' })],
      () => [filing('KROGER #415'), filing('KROGER #9')],
    );
    expect(payload.rows[0].guess).toEqual({ categoryId: 'cat-gro', name: 'Groceries' });
    expect('guess' in payload.rows[1]).toBe(false);
  });

  it('gives an Amazon row no guess, nor a row that takes an income category', async () => {
    const payload = await publish(
      [native('a', { notes: 'AMAZON.COM*MB3T81 · TRN-a' }), native('b', { notes: 'KROGER #415 · TRN-b', incomeEligible: true })],
      () => [filing('AMAZON.COM*MB3T81'), filing('AMAZON.COM*MB3T81'), filing('KROGER #415'), filing('KROGER #415')],
    );
    expect(payload.rows.map((r: { guess?: unknown }) => r.guess)).toEqual([undefined, undefined]);
  });

  it('a failed read of the filings publishes no guesses at all — never a wrong one — and the status as usual', async () => {
    const payload = await publish([native('a', { notes: 'KROGER #415 · TRN-a' })], () => { throw new Error('database is locked'); });
    expect(payload.count).toBe(1);
    expect(payload.rows[0].description).toBe('KROGER #415');
    expect('guess' in payload.rows[0]).toBe(false);
  });

  it('says why when the filings cannot be read — the one log line a missing guess leaves', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await publish([native('a', { notes: 'KROGER #415 · TRN-a' })], () => { throw new Error('database is locked'); });
      expect(logs.mock.calls.map((c) => c.join(' '))).toEqual(['[simplefin-sync] Guessed categories skipped: database is locked']);
      logs.mockClear();
      await publish([native('a', { notes: 'KROGER #415 · TRN-a' })], () => [filing('KROGER #415'), filing('KROGER #415')]);
      expect(logs).not.toHaveBeenCalled();
    } finally {
      logs.mockRestore();
    }
  });

  it('reads the filings from a year back, through the db-path entry point', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfin-uncategorized-guess-'));
    const dbPath = join(dir, 'wealthfolio.db');
    writeFileSync(dbPath, '');
    try {
      const readFilings = vi.fn(() => [filing('KROGER #415'), filing('KROGER #415')]);
      const writes: Record<string, string> = {};
      await publishUncategorizedStatusForDbPath(
        dbPath, async (k, v) => { writes[k] = v; }, () => [native('a', { notes: 'KROGER #415 · TRN-a' })], async () => ({}), NOW, readFilings,
      );
      expect(readFilings).toHaveBeenCalledWith(dbPath, '2025-10-14');
      expect(JSON.parse(writes['uncategorized_status']).rows[0].guess).toEqual({ categoryId: 'cat-gro', name: 'Groceries' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('payback rows (W11)', () => {
  const publish = async (rows: ReturnType<typeof native>[]) => {
    const writes: Record<string, string> = {};
    await publishUncategorizedStatus(async (k, v) => { writes[k] = v; }, () => rows, async () => ({}), new Date('2026-10-14T12:00:00Z'));
    return JSON.parse(writes['uncategorized_status']).rows as Array<{ activityId: string; paybackEligible?: true }>;
  };
  const deposit = { notes: 'VENMO CASHOUT · TRN-77', direction: 'in' as const, incomeEligible: true, activityType: 'DEPOSIT', pending: false };

  it("marks a posted deposit on a cash account: the rows Telegram offers \"It's a payback »\" on", async () => {
    const [row] = await publish([native('a', deposit)]);
    expect(row.paybackEligible).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ['interest', { ...deposit, activityType: 'INTEREST' }],
    ['a pending deposit', { ...deposit, pending: true }],
    ['a card credit', { ...deposit, incomeEligible: false, activityType: 'CREDIT' }],
    ['a withdrawal', { ...deposit, direction: 'out', incomeEligible: false, activityType: 'WITHDRAWAL' }],
    ['a row read without its type', { notes: 'VENMO CASHOUT · TRN-77', direction: 'in', incomeEligible: true }],
  ])('marks no %s', async (_name, over) => {
    const [row] = await publish([native('a', over)]);
    expect('paybackEligible' in row).toBe(false);
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
    const readRows = vi.fn(() => [native('a'), native('b'), native('c')]);
    const readLedger = vi.fn(async () => ({}));
    await publishUncategorizedStatusForDbPath('', setSecret, readRows, readLedger);
    expect(setSecret).not.toHaveBeenCalled();
    expect(readRows).not.toHaveBeenCalled();
    expect(readLedger).not.toHaveBeenCalled();
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
    const readRows = vi.fn(() => []);
    const readLedger = vi.fn(async () => ({}));
    await publishUncategorizedStatusForDbPath(
      '/nonexistent/path/wealthfolio.db',
      setSecret,
      readRows,
      readLedger,
    );
    expect(setSecret).not.toHaveBeenCalled();
    expect(readRows).not.toHaveBeenCalled();
    expect(readLedger).not.toHaveBeenCalled();
  });

  it('publishes the rows and count when the db path exists, using the 90-day window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sfin-uncategorized-status-test-'));
    const dbPath = join(dir, 'wealthfolio.db');
    writeFileSync(dbPath, '');
    try {
      const writes: Record<string, string> = {};
      const readRows = vi.fn(() => [native('a'), native('b'), native('c'), native('d'), native('e')]);
      const readLedger = vi.fn(async () => ({}));
      await publishUncategorizedStatusForDbPath(
        dbPath,
        async (k, v) => { writes[k] = v; },
        readRows,
        readLedger,
        new Date('2026-08-08T15:30:00Z'),
      );
      expect(readRows).toHaveBeenCalledWith(dbPath, '2026-05-10', '2026-08-09');
      const payload = JSON.parse(writes['uncategorized_status']);
      expect(payload.count).toBe(5);
      expect(payload.asOf).toBe('2026-08-08T15:30:00.000Z');
      expect(payload.rows).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
