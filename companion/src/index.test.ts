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
  claimTokenNode: vi.fn(),
}));

vi.mock('./wealthfolio.js', () => {
  const MockWealthfolioClient = vi.fn();
  return { WealthfolioClient: MockWealthfolioClient };
});

// ── Imports (after mocks are hoisted) ─────────────────────────────────────────

import { maskUrl, validateStartupEnv, runCompanionSync, getLastSyncAt, setLastSyncAt, resolveAccessUrl } from './index.js';
import { fetchAccountsNode, claimTokenNode } from './simplefin.js';
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
    'WEALTHFOLIO_PASSWORD', 'STATE_FILE', 'SIMPLEFIN_SETUP_TOKEN',
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
    getAccounts: vi.fn().mockResolvedValue([]),
    getLatestValuations: vi.fn().mockResolvedValue([]),
    searchActivities: vi.fn().mockResolvedValue([]),
    linkTransferActivities: vi.fn().mockResolvedValue(undefined),
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

  it('passes with only SIMPLEFIN_SETUP_TOKEN (no access URL)', () => {
    setEnv({ SIMPLEFIN_ACCESS_URL: undefined, SIMPLEFIN_SETUP_TOKEN: 'some-token' });
    expect(() => validateStartupEnv()).not.toThrow();
  });
});

describe('resolveAccessUrl', () => {
  beforeEach(() => {
    clearEnv();
    process.env.STATE_FILE = TEST_STATE_FILE;
    removeStateFile();
    vi.mocked(claimTokenNode).mockReset();
  });

  afterEach(() => {
    removeStateFile();
    clearEnv();
  });

  it('claims a setup token, persists the result, and does not re-claim on later calls', async () => {
    process.env.SIMPLEFIN_SETUP_TOKEN = 'one-time-token';
    vi.mocked(claimTokenNode).mockResolvedValueOnce(
      'https://user:pass@bridge.simplefin.org/simplefin',
    );

    const first = await resolveAccessUrl();
    expect(first).toBe('https://user:pass@bridge.simplefin.org/simplefin');
    expect(claimTokenNode).toHaveBeenCalledWith('one-time-token');
    expect(claimTokenNode).toHaveBeenCalledTimes(1);

    // Second call must come from the state file, not another claim
    const second = await resolveAccessUrl();
    expect(second).toBe(first);
    expect(claimTokenNode).toHaveBeenCalledTimes(1);
  });

  it('prefers SIMPLEFIN_ACCESS_URL env over claiming a token', async () => {
    process.env.SIMPLEFIN_ACCESS_URL = 'https://u:p@bridge.simplefin.org/simplefin';
    process.env.SIMPLEFIN_SETUP_TOKEN = 'unused-token';
    const url = await resolveAccessUrl();
    expect(url).toBe('https://u:p@bridge.simplefin.org/simplefin');
    expect(claimTokenNode).not.toHaveBeenCalled();
  });

  it('throws when no credentials are configured at all', async () => {
    await expect(resolveAccessUrl()).rejects.toThrow('SIMPLEFIN_SETUP_TOKEN');
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
    // Mark fixture accounts as already balance-initialized so these tests
    // exercise plain transaction imports; starting-balance behavior has its
    // own dedicated tests below.
    writeFileSync(
      TEST_STATE_FILE,
      JSON.stringify({
        balanceInitialized: ['sfin-account-1', 'sfin-account-2', 'sfin-unmapped-account'],
      }),
    );
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
          comment: expect.stringContaining('tx-1'), sourceSystem: 'simplefin', isDraft: false, isValid: true,
          symbol: '$CASH-USD',
        }),
        expect.objectContaining({ comment: expect.stringContaining('tx-2') }),
      ]),
    );
    // Only the non-duplicate activity should be imported
    const importedArg = (mockClient.importActivities as ReturnType<typeof vi.fn>).mock.calls[0][0] as unknown[];
    expect(importedArg).toHaveLength(1);
    expect(importedArg[0].comment).toContain('tx-1');
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

  it('calls login with password only when WEALTHFOLIO_PASSWORD is set (no API key)', async () => {
    process.env.WEALTHFOLIO_PASSWORD = 'secret';

    const mockClient = makeWfClientMock();
    vi.mocked(WealthfolioClient).mockImplementation(function () { return mockClient; } as unknown as new (url: string) => WealthfolioClient);
    vi.mocked(fetchAccountsNode).mockResolvedValue({ errors: [], accounts: [] });

    await runCompanionSync();

    expect(mockClient.login).toHaveBeenCalledWith('secret');

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

  it('stores the description and SimpleFin tx ID in the comment field', async () => {
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
    expect(submitted[0].comment).toContain('simplefin-tx-id-abc');
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
    // lastSyncAt must NOT advance after a partial failure, so the failed
    // account's window is retried on the next run
    expect(getLastSyncAt()).toBeNull();
  });

  it('advances lastSyncAt only on a clean run', async () => {
    const wfMock = makeWfClientMock();
    vi.mocked(WealthfolioClient).mockImplementation(function () { return wfMock; } as unknown as new (url: string) => WealthfolioClient);
    vi.mocked(fetchAccountsNode).mockResolvedValue({ errors: [], accounts: [] });

    await runCompanionSync();
    expect(getLastSyncAt()).not.toBeNull();
  });

  it('adds a starting-balance entry on first sync and persists initialization', async () => {
    // Fresh state: no accounts initialized yet
    writeFileSync(TEST_STATE_FILE, JSON.stringify({}));

    const mockCheckImport = vi.fn().mockImplementation((_id: string, acts: unknown[]) =>
      Promise.resolve((acts as Array<{ comment: string }>).map((a) => ({ ...a, isDuplicate: false }))),
    );
    const mockImportActivities = vi.fn().mockResolvedValue(undefined);
    const wfMock = makeWfClientMock({
      checkImport: mockCheckImport,
      importActivities: mockImportActivities,
      getLatestValuations: vi.fn().mockResolvedValue([{ accountId: 'wf-account-1', totalValue: '0' }]),
    });
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
            { id: 'tx-1', posted: 1700000000, amount: '-50.00', description: 'Groceries' },
          ],
        },
      ],
    });

    await runCompanionSync();

    // checkImport sees only the real transactions; the starting-balance entry
    // is prepended to the import list afterwards
    const submittedToCheck = mockCheckImport.mock.calls[0][1] as Array<{ comment: string }>;
    expect(submittedToCheck[0].comment).toContain('tx-1');

    const imported = mockImportActivities.mock.calls[0][0] as Array<{
      comment: string; activityType: string; amount: number;
    }>;
    // 1000 target − (−50 window) − 0 current = 1050 starting deposit
    expect(imported[0].comment).toBe('Starting balance · sfin-account-1');
    expect(imported[0].activityType).toBe('DEPOSIT');
    expect(imported[0].amount).toBe(1050);

    const state = JSON.parse(readFileSync(TEST_STATE_FILE, 'utf8')) as { balanceInitialized?: string[] };
    expect(state.balanceInitialized).toContain('sfin-account-1');
  });

  it('starting balance self-cancels when the window transactions are already imported duplicates', async () => {
    // Fresh state (not initialized), but Wealthfolio already holds the
    // transactions (e.g. the addon synced first) and its balance is correct
    writeFileSync(TEST_STATE_FILE, JSON.stringify({}));

    const mockCheckImport = vi.fn().mockImplementation((_id: string, acts: unknown[]) =>
      Promise.resolve((acts as Array<{ comment: string }>).map((a) => ({ ...a, isDuplicate: true }))),
    );
    const mockImportActivities = vi.fn().mockResolvedValue(undefined);
    const wfMock = makeWfClientMock({
      checkImport: mockCheckImport,
      importActivities: mockImportActivities,
      getLatestValuations: vi.fn().mockResolvedValue([{ accountId: 'wf-account-1', totalValue: '1000' }]),
    });
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
            { id: 'tx-1', posted: 1700000000, amount: '-50.00', description: 'Groceries' },
          ],
        },
      ],
    });

    await runCompanionSync();

    // Everything was a duplicate and WF already sits at the target balance:
    // 1000 − 0 (no non-dup deltas) − 1000 = 0 → no correction entry
    expect(mockImportActivities).not.toHaveBeenCalled();
  });

  it('skips pending and unposted transactions', async () => {
    const mockCheckImport = vi.fn().mockResolvedValue([]);
    const wfMock = makeWfClientMock({ checkImport: mockCheckImport });
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
            { id: 'tx-p', posted: 1700000000, amount: '-5.00', description: 'Pending', pending: true },
            { id: 'tx-u', posted: 0, amount: '-5.00', description: 'Unposted' },
          ],
        },
      ],
    });

    await runCompanionSync();
    // Both filtered out and account already initialized → nothing to check/import
    expect(mockCheckImport).not.toHaveBeenCalled();
  });

  it('types matched cross-account pairs as transfers', async () => {
    process.env.ACCOUNT_MAPPING = JSON.stringify({
      'sfin-account-1': 'wf-account-1',
      'sfin-account-2': 'wf-account-2',
    });
    // both accounts pre-initialized so no starting-balance entries interfere
    writeFileSync(TEST_STATE_FILE, JSON.stringify({ balanceInitialized: ['sfin-account-1', 'sfin-account-2'] }));

    const mockCheckImport = vi.fn().mockImplementation((_id: string, acts: unknown[]) =>
      Promise.resolve((acts as object[]).map((a) => ({ ...a, isDuplicate: false }))),
    );
    const wfMock = makeWfClientMock({
      checkImport: mockCheckImport,
      getAccounts: vi.fn().mockResolvedValue([
        { id: 'wf-account-1', accountType: 'CASH' },
        { id: 'wf-account-2', accountType: 'CREDIT_CARD' },
      ]),
    });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return wfMock; } as unknown as new (url: string) => WealthfolioClient);

    vi.mocked(fetchAccountsNode).mockResolvedValue({
      errors: [],
      accounts: [
        { id: 'sfin-account-1', name: 'Checking', currency: 'USD', balance: '1000.00', 'balance-date': 1700000000,
          transactions: [{ id: 'tx-out', posted: 1700000000, amount: '-500.00', description: 'Payment to Citibank' }] },
        { id: 'sfin-account-2', name: 'Card', currency: 'USD', balance: '-500.00', 'balance-date': 1700000000,
          transactions: [{ id: 'tx-in', posted: 1700086400, amount: '500.00', description: 'PAYMENT THANK YOU' }] },
      ],
    });

    await runCompanionSync();

    const submitted = mockCheckImport.mock.calls.flatMap((c) => c[1] as Array<{ comment: string; activityType: string }>);
    expect(submitted.find((a) => a.comment.includes('tx-out'))!.activityType).toBe('TRANSFER_OUT');
    expect(submitted.find((a) => a.comment.includes('tx-in'))!.activityType).toBe('TRANSFER_IN');
  });

  it('logs a drift warning when an initialized account disagrees with SimpleFin by > $1', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const wfMock = makeWfClientMock({
      getLatestValuations: vi.fn().mockResolvedValue([{ accountId: 'wf-account-1', totalValue: '900' }]),
    });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return wfMock; } as unknown as new (url: string) => WealthfolioClient);
    vi.mocked(fetchAccountsNode).mockResolvedValue({
      errors: [],
      accounts: [
        { id: 'sfin-account-1', name: 'Checking', currency: 'USD', balance: '1000.00', 'balance-date': 1700000000, transactions: [] },
      ],
    });
    // account already initialized -> drift check active, no correction entry
    writeFileSync(TEST_STATE_FILE, JSON.stringify({ balanceInitialized: ['sfin-account-1'] }));

    await runCompanionSync();

    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/Balance drift.*wf-account-1.*100/);
    logSpy.mockRestore();
  });

  it('skips the drift check when an initialized account has no valuation entry', async () => {
    const logSpy = vi.spyOn(console, 'log');
    const wfMock = makeWfClientMock({
      getLatestValuations: vi.fn().mockResolvedValue([]),
    });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return wfMock; } as unknown as new (url: string) => WealthfolioClient);
    vi.mocked(fetchAccountsNode).mockResolvedValue({
      errors: [],
      accounts: [
        { id: 'sfin-account-1', name: 'Checking', currency: 'USD', balance: '1000.00', 'balance-date': 1700000000, transactions: [] },
      ],
    });
    writeFileSync(TEST_STATE_FILE, JSON.stringify({ balanceInitialized: ['sfin-account-1'] }));

    await runCompanionSync();

    expect(logSpy.mock.calls.flat().join('\n')).not.toMatch(/Balance drift/);
    logSpy.mockRestore();
  });

  it('reconciliation links unlinked transfer pairs found via search', async () => {
    const mockLink = vi.fn().mockResolvedValue(undefined);
    const wfMock = makeWfClientMock({
      searchActivities: vi.fn().mockResolvedValue([
        { id: 'act-out', accountId: 'wf-account-1', activityType: 'TRANSFER_OUT', date: '2026-07-05', amount: '500', sourceGroupId: null },
        { id: 'act-in', accountId: 'wf-account-2', activityType: 'TRANSFER_IN', date: '2026-07-06', amount: '500', sourceGroupId: null },
        { id: 'act-linked', accountId: 'wf-account-1', activityType: 'TRANSFER_OUT', date: '2026-07-05', amount: '75', sourceGroupId: 'grp-1' },
      ]),
      linkTransferActivities: mockLink,
    });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return wfMock; } as unknown as new (url: string) => WealthfolioClient);
    vi.mocked(fetchAccountsNode).mockResolvedValue({ errors: [], accounts: [] });

    await runCompanionSync();

    expect(mockLink).toHaveBeenCalledTimes(1);
    expect(mockLink).toHaveBeenCalledWith('act-out', 'act-in');
  });

  it('reconciliation failures are non-fatal and do not block lastSyncAt', async () => {
    const wfMock = makeWfClientMock({
      searchActivities: vi.fn().mockRejectedValue(new Error('boom')),
    });
    vi.mocked(WealthfolioClient).mockImplementation(function () { return wfMock; } as unknown as new (url: string) => WealthfolioClient);
    vi.mocked(fetchAccountsNode).mockResolvedValue({ errors: [], accounts: [] });

    await expect(runCompanionSync()).resolves.toBeUndefined();
    expect(getLastSyncAt()).not.toBeNull();
  });
});
