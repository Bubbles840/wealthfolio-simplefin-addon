import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSync, MIN_SYNC_INTERVAL_MS } from './sync';

vi.mock('./simplefin', () => ({
  fetchAccounts: vi.fn(),
}));

import { fetchAccounts } from './simplefin';

const makeStore = (overrides: Record<string, unknown> = {}) => ({
  getAccessUrl: vi.fn(async () => 'https://u:p@bridge.simplefin.org/simplefin'),
  getAccountMapping: vi.fn(async () => ({ 'sfin-1': 'wf-account-a' })),
  getMappingRules: vi.fn(async () => []),
  getLastSyncAt: vi.fn(async () => null),
  setLastSyncAt: vi.fn(async () => {}),
  getAuthB64Key: vi.fn(async () => 'simplefin_auth_b64'),
  // Default: starting balance already handled, so existing tests exercise
  // plain transaction imports. Starting-balance tests override this.
  getBalanceInitialized: vi.fn(async () => ['sfin-1']),
  addBalanceInitialized: vi.fn(async () => {}),
  ...overrides,
});

const makeCtx = () => ({
  api: {
    network: { request: vi.fn() },
    accounts: {
      getAll: vi.fn(async () => [{ id: 'wf-account-a', name: 'Checking', balance: 0 }]),
    },
    activities: {
      checkImport: vi.fn(async (acts: any[]) =>
        acts.map((a: any) => ({ ...a, isValid: true })),
      ),
      import: vi.fn(async (acts: any[]) => acts),
    },
  },
} as any);

const makeAccountSet = (transactions: any[] = []) => ({
  errors: [],
  accounts: [
    {
      id: 'sfin-1',
      name: 'Checking',
      currency: 'USD',
      balance: '1000.00',
      'balance-date': Date.now() / 1000,
      transactions,
    },
  ],
});

describe('runSync', () => {
  beforeEach(() => vi.mocked(fetchAccounts).mockReset());

  it('returns 0 imported when no transactions', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const result = await runSync(makeCtx(), makeStore() as any);
    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('imports a valid transaction', async () => {
    const tx = { id: 'tx-1', posted: 1700000000, amount: '-12.50', description: 'Coffee' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx]));
    const ctx = makeCtx();
    const result = await runSync(ctx, makeStore() as any);
    expect(result.imported).toBe(1);
    expect(ctx.api.activities.import).toHaveBeenCalledOnce();
    const imported = vi.mocked(ctx.api.activities.import).mock.calls[0][0];
    expect(imported[0].accountId).toBe('wf-account-a');
    expect(imported[0].activityType).toBe('WITHDRAWAL');
    expect(imported[0].symbol).toBe('$CASH-USD');
    expect(imported[0].comment).toBe('Coffee \u00b7 tx-1');
    expect(imported[0].sourceSystem).toBe('simplefin');
  });

  it('skips transactions for unmapped SimpleFin accounts', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce({
      errors: [],
      accounts: [{ id: 'sfin-UNMAPPED', name: 'Unknown', currency: 'USD',
        balance: '0', 'balance-date': 0, transactions: [
          { id: 'tx-2', posted: 1700000000, amount: '5.00', description: 'Test' },
        ],
      }],
    });
    const ctx = makeCtx();
    const result = await runSync(ctx, makeStore() as any);
    expect(result.imported).toBe(0);
    expect(ctx.api.activities.import).not.toHaveBeenCalled();
  });

  it('enforces 1-hour minimum sync interval', async () => {
    const recentSync = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    const store = makeStore({ getLastSyncAt: vi.fn(async () => recentSync) });
    const ctx = makeCtx();
    const result = await runSync(ctx, store as any);
    expect(result.errors[0]).toMatch(/minimum sync interval/i);
    expect(fetchAccounts).not.toHaveBeenCalled();
  });

  it('skips activities marked as duplicates by checkImport', async () => {
    const tx = { id: 'tx-dup', posted: 1700000000, amount: '100.00', description: 'Paycheck' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx]));
    const ctx = makeCtx();
    ctx.api.activities.checkImport = vi.fn(async (acts: any[]) =>
      acts.map((a: any) => ({ ...a, isValid: true, duplicateOfId: 'existing-id' })),
    );
    const result = await runSync(ctx, makeStore() as any);
    expect(result.skipped).toBe(1);
    expect(result.imported).toBe(0);
    expect(ctx.api.activities.import).not.toHaveBeenCalled();
  });

  it('updates lastSyncAt after a successful sync', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const store = makeStore();
    await runSync(makeCtx(), store as any);
    expect(store.setLastSyncAt).toHaveBeenCalledOnce();
  });

  it('skips pending and unposted transactions', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([
      { id: 'tx-pending', posted: 1700000000, amount: '-5.00', description: 'Pending', pending: true },
      { id: 'tx-unposted', posted: 0, amount: '-5.00', description: 'Unposted' },
    ]));
    const ctx = makeCtx();
    const result = await runSync(ctx, makeStore() as any);
    expect(result.imported).toBe(0);
    expect(ctx.api.activities.import).not.toHaveBeenCalled();
  });

  it('adds a starting-balance entry on first sync so the account lands on the SimpleFin balance', async () => {
    const tx = { id: 'tx-1', posted: 1700000000, amount: '-12.50', description: 'Coffee' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx])); // balance 1000.00
    const ctx = makeCtx();
    const store = makeStore({ getBalanceInitialized: vi.fn(async () => []) });
    const result = await runSync(ctx, store as any);

    expect(result.imported).toBe(2);
    const imported = vi.mocked(ctx.api.activities.import).mock.calls[0][0];
    const starting = imported[0];
    // 1000.00 target − (−12.50 window delta) − 0 current = 1012.50
    expect(starting.comment).toBe('Starting balance · sfin-1');
    expect(starting.activityType).toBe('DEPOSIT');
    expect(starting.amount).toBe(1012.5);
    expect(store.addBalanceInitialized).toHaveBeenCalledWith('sfin-1');
  });

  it('accounts for the existing Wealthfolio balance in the starting-balance entry', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([])); // balance 1000.00
    const ctx = makeCtx();
    ctx.api.accounts.getAll = vi.fn(async () => [
      { id: 'wf-account-a', name: 'Checking', balance: -3000 },
    ]);
    const store = makeStore({ getBalanceInitialized: vi.fn(async () => []) });
    await runSync(ctx, store as any);

    const imported = vi.mocked(ctx.api.activities.import).mock.calls[0][0];
    // 1000 target − 0 window − (−3000 current) = 4000 correction
    expect(imported[0].activityType).toBe('DEPOSIT');
    expect(imported[0].amount).toBe(4000);
  });

  it('does not add a starting balance for already-initialized accounts', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const ctx = makeCtx();
    await runSync(ctx, makeStore() as any); // default: sfin-1 initialized
    expect(ctx.api.activities.import).not.toHaveBeenCalled();
  });

  it('starting balance self-cancels when window transactions are duplicates and WF is already correct', async () => {
    const tx = { id: 'tx-1', posted: 1700000000, amount: '-50.00', description: 'Groceries' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx])); // balance 1000.00
    const ctx = makeCtx();
    // Another syncer (e.g. the Docker companion) already imported everything
    // and the account sits at the true balance
    ctx.api.activities.checkImport = vi.fn(async (acts: any[]) =>
      acts.map((a: any) => ({ ...a, isValid: true, duplicateOfId: 'existing' })),
    );
    ctx.api.accounts.getAll = vi.fn(async () => [
      { id: 'wf-account-a', name: 'Checking', balance: 1000 },
    ]);
    const store = makeStore({ getBalanceInitialized: vi.fn(async () => []) });
    const result = await runSync(ctx, store as any);

    // 1000 target − 0 non-dup deltas − 1000 current = 0 → no correction
    expect(ctx.api.activities.import).not.toHaveBeenCalled();
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
  });
});

describe('MIN_SYNC_INTERVAL_MS', () => {
  it('equals 1 hour in ms', () => {
    expect(MIN_SYNC_INTERVAL_MS).toBe(3_600_000);
  });
});
