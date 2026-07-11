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
  // Default: starting balance already handled, so most tests exercise plain
  // transaction imports. Starting-balance tests override this.
  getBalanceInitialized: vi.fn(async () => ['sfin-1', 'sfin-2']),
  addBalanceInitialized: vi.fn(async () => {}),
  ...overrides,
});

const makeCtx = () => ({
  api: {
    network: { request: vi.fn() },
    accounts: {
      getAll: vi.fn(async () => [
        { id: 'wf-account-a', name: 'Checking', accountType: 'CASH' },
        { id: 'wf-account-b', name: 'Card', accountType: 'CREDIT_CARD' },
      ]),
    },
    portfolio: {
      getLatestValuations: vi.fn(async () => [
        { accountId: 'wf-account-a', totalValue: 0 },
        { accountId: 'wf-account-b', totalValue: 0 },
      ]),
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





  it('types matched cross-account pairs as transfers', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce({
      errors: [],
      accounts: [
        { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '1000.00', 'balance-date': 1700000000,
          transactions: [{ id: 'tx-out', posted: 1700000000, amount: '-500.00', description: 'Payment to Citibank' }] },
        { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '-500.00', 'balance-date': 1700000000,
          transactions: [{ id: 'tx-in', posted: 1700086400, amount: '500.00', description: 'PAYMENT THANK YOU' }] },
      ],
    });
    const ctx = makeCtx();
    const store = makeStore({
      getAccountMapping: vi.fn(async () => ({ 'sfin-1': 'wf-account-a', 'sfin-2': 'wf-account-b' })),
    });
    await runSync(ctx, store as any);
    const imported = vi.mocked(ctx.api.activities.import).mock.calls.flatMap((c: any) => c[0]);
    const out = imported.find((a: any) => a.comment.includes('tx-out'));
    const inn = imported.find((a: any) => a.comment.includes('tx-in'));
    expect(out.activityType).toBe('TRANSFER_OUT');
    expect(inn.activityType).toBe('TRANSFER_IN');
  });

  it('types unmatched positive card amounts as CREDIT (refund)', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce({
      errors: [],
      accounts: [
        { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '0', 'balance-date': 1700000000,
          transactions: [{ id: 'tx-r', posted: 1700000000, amount: '66.45', description: 'UNIQLO REFUND' }] },
      ],
    });
    const ctx = makeCtx();
    const store = makeStore({
      getAccountMapping: vi.fn(async () => ({ 'sfin-2': 'wf-account-b' })),
    });
    await runSync(ctx, store as any);
    const imported = vi.mocked(ctx.api.activities.import).mock.calls[0][0];
    expect(imported[0].activityType).toBe('CREDIT');
  });
  it('adds a starting-balance entry on first sync using the valuation balance', async () => {
    const tx = { id: 'tx-1', posted: 1700000000, amount: '-12.50', description: 'Coffee' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx])); // balance 1000.00
    const ctx = makeCtx();
    const store = makeStore({ getBalanceInitialized: vi.fn(async () => []) });
    const result = await runSync(ctx, store as any);

    expect(result.imported).toBe(2);
    const imported = vi.mocked(ctx.api.activities.import).mock.calls[0][0];
    // 1000.00 target − (−12.50 window delta) − 0 valuation = 1012.50
    expect(imported[0].comment).toBe('Starting balance · sfin-1');
    expect(imported[0].activityType).toBe('DEPOSIT');
    expect(imported[0].amount).toBe(1012.5);
    expect(store.addBalanceInitialized).toHaveBeenCalledWith('sfin-1');
  });

  it('accounts for the existing valuation balance in the starting-balance entry', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([])); // balance 1000.00
    const ctx = makeCtx();
    ctx.api.portfolio.getLatestValuations = vi.fn(async () => [
      { accountId: 'wf-account-a', totalValue: -3000 },
    ]);
    const store = makeStore({ getBalanceInitialized: vi.fn(async () => []) });
    await runSync(ctx, store as any);

    const imported = vi.mocked(ctx.api.activities.import).mock.calls[0][0];
    // 1000 target − 0 window − (−3000 valuation) = 4000 correction
    expect(imported[0].activityType).toBe('DEPOSIT');
    expect(imported[0].amount).toBe(4000);
  });

  it('does not add a starting balance for already-initialized accounts', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const ctx = makeCtx();
    await runSync(ctx, makeStore() as any); // default: initialized
    expect(ctx.api.activities.import).not.toHaveBeenCalled();
  });

  it('skips the starting balance and does not mark initialized when the account has no valuation', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([])); // balance 1000.00
    const ctx = makeCtx();
    ctx.api.portfolio.getLatestValuations = vi.fn(async () => []);
    const store = makeStore({ getBalanceInitialized: vi.fn(async () => []) });
    const result = await runSync(ctx, store as any);

    expect(ctx.api.activities.import).not.toHaveBeenCalled();
    expect(store.addBalanceInitialized).not.toHaveBeenCalled();
    expect(result.errors).toHaveLength(0); // per-account skip is silent, not an error
  });

  it('starting balance self-cancels when window transactions are duplicates and the valuation is already correct', async () => {
    const tx = { id: 'tx-1', posted: 1700000000, amount: '-50.00', description: 'Groceries' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx])); // balance 1000.00
    const ctx = makeCtx();
    ctx.api.activities.checkImport = vi.fn(async (acts: any[]) =>
      acts.map((a: any) => ({ ...a, isValid: true, duplicateOfId: 'existing' })),
    );
    ctx.api.portfolio.getLatestValuations = vi.fn(async () => [
      { accountId: 'wf-account-a', totalValue: 1000 },
    ]);
    const store = makeStore({ getBalanceInitialized: vi.fn(async () => []) });
    const result = await runSync(ctx, store as any);

    // 1000 target − 0 non-dup deltas − 1000 valuation = 0 → no correction
    expect(ctx.api.activities.import).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });
});

describe('MIN_SYNC_INTERVAL_MS', () => {
  it('equals 1 hour in ms', () => {
    expect(MIN_SYNC_INTERVAL_MS).toBe(3_600_000);
  });
});
