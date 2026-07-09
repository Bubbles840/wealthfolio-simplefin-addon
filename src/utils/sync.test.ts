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
  ...overrides,
});

const makeCtx = () => ({
  api: {
    activities: {
      checkImport: vi.fn(async (_accountId: string, acts: any[]) =>
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
    ctx.api.activities.checkImport = vi.fn(async (_id: string, acts: any[]) =>
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
});

describe('MIN_SYNC_INTERVAL_MS', () => {
  it('equals 1 hour in ms', () => {
    expect(MIN_SYNC_INTERVAL_MS).toBe(3_600_000);
  });
});
