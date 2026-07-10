/**
 * Tests for companion/src/index.ts
 *
 * Strategy:
 *  - Network modules (simplefin, wealthfolio) are mocked with vi.mock.
 *  - fs is NOT mocked; instead STATE_FILE is pointed at /tmp/… so real writes
 *    work without requiring /app to exist.
 *  - State file is cleaned up in afterEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('./simplefin.js', () => ({
  fetchAccountsNode: vi.fn(),
}));

vi.mock('./wealthfolio.js', () => {
  const MockWealthfolioClient = vi.fn();
  return { WealthfolioClient: MockWealthfolioClient };
});

// ── Imports (after mocks are hoisted) ─────────────────────────────────────────

import { maskUrl, validateStartupEnv, runCompanionSync, getLastSyncAt, setLastSyncAt } from './index.js';
import { fetchAccountsNode } from './simplefin.js';
import { WealthfolioClient } from './wealthfolio.js';

// ── Shared test state ──────────────────────────────────────────────────────────

const TEST_STATE_FILE = '/tmp/test-simplefin-sync-state.json';

const validEnv: Record<string, string> = {
  SIMPLEFIN_ACCESS_URL: 'https://user:pass@bridge.simplefin.org/simplefin',
  WEALTHFOLIO_API_URL: 'http://wealthfolio:7500',
  ACCOUNT_MAPPING: JSON.stringify({ 'sfin-account-1': 'wf-account-1' }),
  STATE_FILE: TEST_STATE_FILE,
};

function setEnv(overrides: Record<string, string | undefined> = {}): void {
  const merged = { ...validEnv, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearEnv(): void {
  const keys = [
    'SIMPLEFIN_ACCESS_URL', 'WEALTHFOLIO_API_URL', 'WEALTHFOLIO_API_KEY',
    'ACCOUNT_MAPPING', 'SYNC_SCHEDULE', 'MAPPING_RULES', 'LOOKBACK_DAYS',
    'MIN_SYNC_INTERVAL_HOURS', 'LOG_LEVEL', 'WEALTHFOLIO_USERNAME',
    'WEALTHFOLIO_PASSWORD', 'STATE_FILE',
  ];
  for (const k of keys) delete process.env[k];
}

function removeStateFile(): void {
  if (existsSync(TEST_STATE_FILE)) unlinkSync(TEST_STATE_FILE);
}

/** Build a minimal WealthfolioClient mock instance */
function makeWfClientMock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    login: vi.fn().mockResolvedValue(undefined),
    checkImport: vi.fn().mockResolvedValue([]),
    importActivities: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('maskUrl', () => {
  it('replaces user:pass segment with ***', () => {
    expect(maskUrl('https://user:pass@bridge.simplefin.org/path')).toBe(
      'https://***@bridge.simplefin.org/path',
    );
  });

  it('is a no-op when there are no credentials in the URL', () => {
    const plain = 'https://bridge.simplefin.org/path';
    expect(maskUrl(plain)).toBe(plain);
  });
});

describe('validateStartupEnv', () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  it('throws when SIMPLEFIN_ACCESS_URL is missing', () => {
    setEnv({ SIMPLEFIN_ACCESS_URL: undefined });
    expect(() => validateStartupEnv()).toThrow('SIMPLEFIN_ACCESS_URL');
  });

  it('throws when SIMPLEFIN_ACCESS_URL uses http://', () => {
    setEnv({ SIMPLEFIN_ACCESS_URL: 'http://user:pass@bridge.simplefin.org/simplefin' });
    expect(() => validateStartupEnv()).toThrow('https://');
  });

  it('throws when WEALTHFOLIO_API_URL is missing', () => {
    setEnv({ WEALTHFOLIO_API_URL: undefined });
    expect(() => validateStartupEnv()).toThrow('WEALTHFOLIO_API_URL');
  });

  it('throws when ACCOUNT_MAPPING is missing', () => {
    setEnv({ ACCOUNT_MAPPING: undefined });
    expect(() => validateStartupEnv()).toThrow('ACCOUNT_MAPPING');
  });

  it('passes when all required env vars are present with https URL', () => {
    setEnv();
    expect(() => validateStartupEnv()).not.toThrow();
  });
});

describe('state persistence (real fs, temp path)', () => {
  beforeEach(() => {
    process.env.STATE_FILE = TEST_STATE_FILE;
    removeStateFile();
  });

  afterEach(() => {
    removeStateFile();
    delete process.env.STATE_FILE;
  });

  it('getLastSyncAt returns null when state file does not exist', () => {
    expect(getLastSyncAt()).toBeNull();
  });

  it('getLastSyncAt returns parsed Date from state file', () => {
    const isoDate = '2026-07-01T12:00:00.000Z';
    writeFileSync(TEST_STATE_FILE, JSON.stringify({ lastSyncAt: isoDate }));
    const result = getLastSyncAt();
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe(isoDate);
  });

  it('getLastSyncAt returns null for malformed state file', () => {
    writeFileSync(TEST_STATE_FILE, 'not-json');
    expect(getLastSyncAt()).toBeNull();
  });

  it('setLastSyncAt writes ISO string to state file', () => {
    const date = new Date('2026-07-01T12:00:00.000Z');
    setLastSyncAt(date);
    expect(existsSync(TEST_STATE_FILE)).toBe(true);
    const written = JSON.parse(readFileSync(TEST_STATE_FILE, 'utf8')) as { lastSyncAt: string };
    expect(written.lastSyncAt).toBe(date.toISOString());
  });

  it('setLastSyncAt and getLastSyncAt round-trip', () => {
    const date = new Date('2026-07-05T08:30:00.000Z');
    setLastSyncAt(date);
    const read = getLastSyncAt();
    expect(read!.toISOString()).toBe(date.toISOString());
  });
});

describe('runCompanionSync', () => {
  beforeEach(() => {
    clearEnv();
    setEnv();
    removeStateFile();
    vi.mocked(fetchAccountsNode).mockReset();
    vi.mocked(WealthfolioClient).mockReset();
  });
  afterEach(() => {
    removeStateFile();
    clearEnv();
  });

  it('imports new transactions and skips duplicates', async () => {
    const mockClient = makeWfClientMock({
      checkImport: vi.fn().mockResolvedValue([
        { isDuplicate: false, comment: 'tx-1', activityType: 'DEPOSIT' },
        { isDuplicate: true, comment: 'tx-2', activityType: 'WITHDRAWAL' },
      ]),
      importActivities: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return mockClient; } as unknown as new (url: string) => WealthfolioClient);

    vi.mocked(fetchAccountsNode).mockResolvedValue({
      errors: [],
      accounts: [
        {
          id: 'sfin-account-1',
          name: 'Checking',
          currency: 'USD',
          balance: '1000.00',
          'balance-date': 1700000000,
          transactions: [
            { id: 'tx-1', posted: 1700000000, amount: '100.00', description: 'Payroll' },
            { id: 'tx-2', posted: 1700000000, amount: '-50.00', description: 'Groceries' },
          ],
        },
      ],
    });

    await runCompanionSync();

    expect(fetchAccountsNode).toHaveBeenCalledOnce();
    expect(mockClient.checkImport).toHaveBeenCalledWith(
      'wf-account-1',
      expect.arrayContaining([
        expect.objectContaining({
          comment: 'tx-1', sourceSystem: 'simplefin', isDraft: false, isValid: true,
        }),
        expect.objectContaining({ comment: 'tx-2' }),
      ]),
    );
    // Only the non-duplicate activity should be imported
    const importedArg = (mockClient.importActivities as ReturnType<typeof vi.fn>).mock.calls[0][0] as unknown[];
    expect(importedArg).toHaveLength(1);
    expect(importedArg[0]).toMatchObject({ comment: 'tx-1' });
  });

  it('skips accounts not present in ACCOUNT_MAPPING', async () => {
    const mockClient = makeWfClientMock();
    vi.mocked(WealthfolioClient).mockImplementation(function () { return mockClient; } as unknown as new (url: string) => WealthfolioClient);

    vi.mocked(fetchAccountsNode).mockResolvedValue({
      errors: [],
      accounts: [
        {
          id: 'sfin-unmapped-account',
          name: 'Savings',
          currency: 'USD',
          balance: '500.00',
          'balance-date': 1700000000,
          transactions: [
            { id: 'tx-3', posted: 1700000000, amount: '25.00', description: 'Interest' },
          ],
        },
      ],
    });

    await runCompanionSync();

    expect(mockClient.checkImport).not.toHaveBeenCalled();
  });

  it('skips sync when MIN_SYNC_INTERVAL_HOURS has not elapsed', async () => {
    // Write a state file indicating a sync 30 minutes ago
    const recentSync = new Date(Date.now() - 30 * 60 * 1000);
    writeFileSync(TEST_STATE_FILE, JSON.stringify({ lastSyncAt: recentSync.toISOString() }));
    process.env.MIN_SYNC_INTERVAL_HOURS = '1';

    await runCompanionSync();

    // fetchAccountsNode must not have been called because the interval guard exits early
    expect(fetchAccountsNode).not.toHaveBeenCalled();
  });

  it('proceeds when MIN_SYNC_INTERVAL_HOURS has elapsed', async () => {
    // Sync happened 2 hours ago, interval is 1 hour
    const oldSync = new Date(Date.now() - 2 * 60 * 60 * 1000);
    writeFileSync(TEST_STATE_FILE, JSON.stringify({ lastSyncAt: oldSync.toISOString() }));
    process.env.MIN_SYNC_INTERVAL_HOURS = '1';

    const mockClient = makeWfClientMock();
    vi.mocked(WealthfolioClient).mockImplementation(function () { return mockClient; } as unknown as new (url: string) => WealthfolioClient);
    vi.mocked(fetchAccountsNode).mockResolvedValue({ errors: [], accounts: [] });

    await runCompanionSync();

    expect(fetchAccountsNode).toHaveBeenCalledOnce();
  });

  it('uses WEALTHFOLIO_API_KEY as Bearer token without calling login', async () => {
    process.env.WEALTHFOLIO_API_KEY = 'test-api-key';

    const instance = makeWfClientMock({ token: undefined as unknown });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return instance; } as unknown as new (url: string) => WealthfolioClient);
    vi.mocked(fetchAccountsNode).mockResolvedValue({ errors: [], accounts: [] });

    await runCompanionSync();

    expect(instance.login).not.toHaveBeenCalled();
    expect((instance as Record<string, unknown>).token).toBe('test-api-key');

    delete process.env.WEALTHFOLIO_API_KEY;
  });

  it('calls login when USERNAME and PASSWORD are set (no API key)', async () => {
    process.env.WEALTHFOLIO_USERNAME = 'admin';
    process.env.WEALTHFOLIO_PASSWORD = 'secret';

    const mockClient = makeWfClientMock();
    vi.mocked(WealthfolioClient).mockImplementation(function () { return mockClient; } as unknown as new (url: string) => WealthfolioClient);
    vi.mocked(fetchAccountsNode).mockResolvedValue({ errors: [], accounts: [] });

    await runCompanionSync();

    expect(mockClient.login).toHaveBeenCalledWith('admin', 'secret');

    delete process.env.WEALTHFOLIO_USERNAME;
    delete process.env.WEALTHFOLIO_PASSWORD;
  });

  it('assigns DEPOSIT to positive amounts and WITHDRAWAL to negative (no matching rules)', async () => {
    const mockClient = makeWfClientMock({
      checkImport: vi.fn().mockResolvedValue([
        { isDuplicate: false, comment: 'tx-pos' },
        { isDuplicate: false, comment: 'tx-neg' },
      ]),
    });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return mockClient; } as unknown as new (url: string) => WealthfolioClient);

    vi.mocked(fetchAccountsNode).mockResolvedValue({
      errors: [],
      accounts: [
        {
          id: 'sfin-account-1',
          name: 'Checking',
          currency: 'USD',
          balance: '1000.00',
          'balance-date': 1700000000,
          transactions: [
            { id: 'tx-pos', posted: 1700000000, amount: '50.00', description: 'Income' },
            { id: 'tx-neg', posted: 1700000000, amount: '-20.00', description: 'Coffee' },
          ],
        },
      ],
    });

    await runCompanionSync();

    const submitted = (mockClient.checkImport as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as Array<{ activityType: string; amount: number }>;
    expect(submitted[0]).toMatchObject({ activityType: 'DEPOSIT', amount: 50 });
    expect(submitted[1]).toMatchObject({ activityType: 'WITHDRAWAL', amount: 20 });
  });

  it('stores the dedup key (SimpleFin tx ID) in the comment field', async () => {
    const mockClient = makeWfClientMock({
      checkImport: vi.fn().mockResolvedValue([
        { isDuplicate: false, comment: 'simplefin-tx-id-abc' },
      ]),
    });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return mockClient; } as unknown as new (url: string) => WealthfolioClient);

    vi.mocked(fetchAccountsNode).mockResolvedValue({
      errors: [],
      accounts: [
        {
          id: 'sfin-account-1',
          name: 'Checking',
          currency: 'USD',
          balance: '1000.00',
          'balance-date': 1700000000,
          transactions: [
            {
              id: 'simplefin-tx-id-abc',
              posted: 1700000000,
              amount: '100.00',
              description: 'Payment',
            },
          ],
        },
      ],
    });

    await runCompanionSync();

    const submitted = (mockClient.checkImport as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as Array<{ comment: string; sourceSystem: string }>;
    expect(submitted[0].comment).toBe('simplefin-tx-id-abc');
    expect(submitted[0].sourceSystem).toBe('simplefin');
  });

  it('persists lastSyncAt to STATE_FILE after a successful sync', async () => {
    const mockClient = makeWfClientMock();
    vi.mocked(WealthfolioClient).mockImplementation(function () { return mockClient; } as unknown as new (url: string) => WealthfolioClient);
    vi.mocked(fetchAccountsNode).mockResolvedValue({ errors: [], accounts: [] });

    const before = Date.now();
    await runCompanionSync();
    const after = Date.now();

    expect(existsSync(TEST_STATE_FILE)).toBe(true);
    const state = JSON.parse(readFileSync(TEST_STATE_FILE, 'utf8')) as { lastSyncAt: string };
    const written = new Date(state.lastSyncAt).getTime();
    expect(written).toBeGreaterThanOrEqual(before);
    expect(written).toBeLessThanOrEqual(after);
  });

  it('continues processing remaining accounts when one throws', async () => {
    process.env.ACCOUNT_MAPPING = JSON.stringify({
      'sfin-account-1': 'wf-account-1',
      'sfin-account-2': 'wf-account-2',
    });

    let callCount = 0;
    const mockCheckImport = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('Network error'));
      return Promise.resolve([{ isDuplicate: false, comment: 'tx-ok' }]);
    });
    const mockImportActivities = vi.fn().mockResolvedValue(undefined);
    const wfMock = makeWfClientMock({ checkImport: mockCheckImport, importActivities: mockImportActivities });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return wfMock; } as unknown as new (url: string) => WealthfolioClient);

    vi.mocked(fetchAccountsNode).mockResolvedValue({
      errors: [],
      accounts: [
        {
          id: 'sfin-account-1',
          name: 'Checking',
          currency: 'USD',
          balance: '1000.00',
          'balance-date': 1700000000,
          transactions: [
            { id: 'tx-fail', posted: 1700000000, amount: '10.00', description: 'Test' },
          ],
        },
        {
          id: 'sfin-account-2',
          name: 'Savings',
          currency: 'USD',
          balance: '500.00',
          'balance-date': 1700000000,
          transactions: [
            { id: 'tx-ok', posted: 1700000000, amount: '5.00', description: 'Interest' },
          ],
        },
      ],
    });

    // Must resolve even though account-1 throws
    await expect(runCompanionSync()).resolves.toBeUndefined();
    // account-2 should still have been processed
    expect(mockImportActivities).toHaveBeenCalledOnce();
  });
});
