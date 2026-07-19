import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runSync, MIN_SYNC_INTERVAL_MS, VALUATION_POLL } from './sync';

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
      search: vi.fn(async () => ({ data: [] })),
      saveMany: vi.fn(async (req: any) => ({
        created: req.creates ?? [],
        updated: req.updates ?? [],
        deleted: req.deleteIds ?? [],
        createdMappings: [],
        errors: [],
      })),
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
  beforeEach(() => {
    vi.mocked(fetchAccounts).mockReset();
    // Keep the same-run valuation poll effectively instant in tests
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 3;
  });

  it('returns 0 imported when no transactions', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const result = await runSync(makeCtx(), makeStore() as any);
    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('imports a valid transaction via saveMany', async () => {
    const tx = { id: 'tx-1', posted: 1700000000, amount: '-12.50', description: 'Coffee' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx]));
    const ctx = makeCtx();
    const result = await runSync(ctx, makeStore() as any);
    expect(result.imported).toBe(1);
    expect(ctx.api.activities.saveMany).toHaveBeenCalledOnce();
    const req = vi.mocked(ctx.api.activities.saveMany).mock.calls[0][0];
    expect(req.creates).toHaveLength(1);
    expect(req.creates![0].accountId).toBe('wf-account-a');
    expect(req.creates![0].activityType).toBe('WITHDRAWAL');
    expect(req.creates![0].symbol).toBe('$CASH-USD');
    expect(req.creates![0].comment).toBe('Coffee \u00b7 tx-1');
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

  it('force bypasses the minimum sync interval and re-pulls the full 30-day window', async () => {
    const recentSync = new Date(Date.now() - 30 * 60 * 1000);
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const store = makeStore({ getLastSyncAt: vi.fn(async () => recentSync) });
    const ctx = makeCtx();
    const result = await runSync(ctx, store as any, { force: true });
    expect(result.errors).toHaveLength(0);
    expect(fetchAccounts).toHaveBeenCalledOnce();
    // startDate (2nd arg) must be ~30 days ago, not the recent lastSync
    const startDate = vi.mocked(fetchAccounts).mock.calls[0][1] as Date;
    const daysAgo = (Date.now() - startDate.getTime()) / (24 * 60 * 60 * 1000);
    expect(daysAgo).toBeGreaterThan(29);
  });

  it('re-scans a lookback overlap before lastSyncAt so late-posting backdated transactions are not missed', async () => {
    // Card purchases post a few days late with `posted` backdated to the
    // purchase date, which lands before lastSyncAt. An incremental window that
    // began exactly at lastSyncAt would let SimpleFin's start-date filter drop
    // them forever. The window must reach back a lookback overlap.
    const lastSync = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const store = makeStore({ getLastSyncAt: vi.fn(async () => lastSync) });
    const ctx = makeCtx();
    await runSync(ctx, store as any);
    const startDate = vi.mocked(fetchAccounts).mock.calls[0][1] as Date;
    const daysAgo = (Date.now() - startDate.getTime()) / (24 * 60 * 60 * 1000);
    // 2 days (lastSync) + 14 days (overlap) ≈ 16 days back, well before lastSync
    expect(daysAgo).toBeGreaterThan(15);
    expect(daysAgo).toBeLessThan(17);
  });

  it('updates lastSyncAt after a successful sync', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const store = makeStore();
    await runSync(makeCtx(), store as any);
    expect(store.setLastSyncAt).toHaveBeenCalledOnce();
  });

  it('drops only transactions with neither posted nor transacted_at', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([
      { id: 'tx-undatable', posted: 0, amount: '-5.00', description: 'No date' },
      { id: 'tx-pending', posted: 0, transacted_at: 1700000000, amount: '-5.00', description: 'Pending', pending: true },
    ]));
    const ctx = makeCtx();
    await runSync(ctx, makeStore() as any);
    const creates = vi.mocked(ctx.api.activities.saveMany).mock.calls[0]?.[0].creates ?? [];
    const comments = creates.map((a: any) => a.comment);
    expect(comments.some((c: string) => c.includes('tx-pending'))).toBe(true);
    expect(comments.some((c: string) => c.includes('tx-undatable'))).toBe(false);
  });

  it('imports a pending transaction with a · pending comment suffix', async () => {
    const tx = { id: 'tx-p', posted: 0, transacted_at: 1700000000, amount: '-5.00', description: 'Pending Coffee', pending: true };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx]));
    const ctx = makeCtx();
    const result = await runSync(ctx, makeStore() as any);
    expect(ctx.api.activities.saveMany).toHaveBeenCalledOnce();
    const req = vi.mocked(ctx.api.activities.saveMany).mock.calls[0][0];
    expect(req.creates).toHaveLength(1);
    expect(req.creates![0].comment).toBe('Pending Coffee · tx-p · pending');
    expect(result.imported).toBe(1);
  });

  it('updates a pending row in place when it posts (no new create)', async () => {
    // Same tx, now posted (pending:false). An existing pending row for the
    // same txId must be updated in place, not re-created.
    const tx = { id: 'tx-x', posted: 1700000000, amount: '-5.00', description: 'Coffee' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx]));
    const ctx = makeCtx();
    ctx.api.activities.search = vi.fn(async () => ({
      data: [{ id: 'act-x', comment: 'Coffee · tx-x · pending', amount: '-5.00', activityType: 'WITHDRAWAL', date: '2023-11-14' }],
    }));
    await runSync(ctx, makeStore() as any);
    const req = vi.mocked(ctx.api.activities.saveMany).mock.calls[0][0];
    expect(req.creates ?? []).toHaveLength(0);
    expect(req.updates).toHaveLength(1);
    expect(req.updates![0].id).toBe('act-x');
    expect(req.updates![0].comment).toBe('Coffee · tx-x'); // pending suffix dropped
  });

  it('deletes a previously-imported pending row that vanished with no match', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([])); // empty feed
    const ctx = makeCtx();
    ctx.api.activities.search = vi.fn(async () => ({
      data: [{ id: 'act-gone', comment: 'Gone · tx-gone · pending', amount: '-9.99', activityType: 'WITHDRAWAL', date: '2023-11-14' }],
    }));
    await runSync(ctx, makeStore() as any);
    const req = vi.mocked(ctx.api.activities.saveMany).mock.calls[0][0];
    expect(req.deleteIds).toEqual(['act-gone']);
  });

  it('excludes pending transactions from transfer detection', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce({
      errors: [],
      accounts: [
        { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '1000.00', 'balance-date': 1700000000,
          transactions: [{ id: 'tx-out', posted: 0, transacted_at: 1700000000, amount: '-500.00', description: 'Transfer', pending: true }] },
        { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '-500.00', 'balance-date': 1700000000,
          transactions: [{ id: 'tx-in', posted: 1700086400, amount: '500.00', description: 'PAYMENT THANK YOU' }] },
      ],
    });
    const ctx = makeCtx();
    const store = makeStore({
      getAccountMapping: vi.fn(async () => ({ 'sfin-1': 'wf-account-a', 'sfin-2': 'wf-account-b' })),
    });
    await runSync(ctx, store as any);
    const creates = vi.mocked(ctx.api.activities.saveMany).mock.calls.flatMap((c: any) => c[0].creates ?? []);
    const out = creates.find((a: any) => a.comment.includes('tx-out'));
    // A pending row is not a transfer candidate, so it stays WITHDRAWAL rather
    // than pairing with the incoming card payment.
    expect(out.activityType).toBe('WITHDRAWAL');
  });


  it('never creates a duplicate for an existing SimpleFin id, reconciling in place instead', async () => {
    const tx = { id: 'tx-1', posted: 1700000000, amount: '-1982.19', description: 'Payment to Citibank' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx]));
    const ctx = makeCtx();
    // Already exists as a DEPOSIT (a since-changed type); the txId guard must
    // reconcile the row in place rather than create a second one.
    ctx.api.activities.search = vi.fn(async () => ({
      data: [{ id: 'act-1', comment: 'Payment to Citibank · tx-1', amount: '-1982.19', activityType: 'DEPOSIT', date: '2023-11-14' }],
    }));
    await runSync(ctx, makeStore() as any);

    const req = vi.mocked(ctx.api.activities.saveMany).mock.calls[0]?.[0];
    expect(req?.creates ?? []).toHaveLength(0);   // no duplicate created
    expect(req?.updates?.[0]?.id).toBe('act-1');  // reconciled in place
    expect(ctx.api.activities.import).not.toHaveBeenCalled();
  });

  it('skips an already-imported unchanged transaction (no create/update)', async () => {
    const tx = { id: 'tx-1', posted: 1700000000, amount: '-1982.19', description: 'Payment to Citibank' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx]));
    const ctx = makeCtx();
    ctx.api.activities.search = vi.fn(async () => ({
      data: [{ id: 'act-1', comment: 'Payment to Citibank · tx-1', amount: '-1982.19', activityType: 'WITHDRAWAL', date: '2023-11-14' }],
    }));
    const result = await runSync(ctx, makeStore() as any);

    expect(ctx.api.activities.saveMany).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
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
    const creates = vi.mocked(ctx.api.activities.saveMany).mock.calls.flatMap((c: any) => c[0].creates ?? []);
    const out = creates.find((a: any) => a.comment.includes('tx-out'));
    const inn = creates.find((a: any) => a.comment.includes('tx-in'));
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
    const creates = vi.mocked(ctx.api.activities.saveMany).mock.calls[0][0].creates ?? [];
    expect(creates[0].activityType).toBe('CREDIT');
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

  it('applies the starting balance in the same run once the first valuation appears', async () => {
    const tx = { id: 'tx-1', posted: 1700000000, amount: '-12.50', description: 'Coffee' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx])); // balance 1000.00
    const ctx = makeCtx();
    let calls = 0;
    // Pre-loop read: no valuation row yet (brand-new account). Later polls:
    // the post-import recalculation has produced one.
    ctx.api.portfolio.getLatestValuations = vi.fn(async () => {
      calls += 1;
      return calls >= 3 ? [{ accountId: 'wf-account-a', totalValue: 987.5 }] : [];
    });
    const store = makeStore({ getBalanceInitialized: vi.fn(async () => []) });
    const result = await runSync(ctx, store as any);

    // Feed transactions now go through saveMany; import() carries only the
    // second-pass correction.
    const importCalls = vi.mocked(ctx.api.activities.import).mock.calls;
    expect(importCalls).toHaveLength(1);
    const correction = importCalls[0][0][0];
    expect(correction.comment).toBe('Starting balance · sfin-1');
    expect(correction.activityType).toBe('DEPOSIT');
    // 1000.00 target − 987.50 fresh valuation (already includes the import)
    expect(correction.amount).toBe(12.5);
    expect(store.addBalanceInitialized).toHaveBeenCalledWith('sfin-1');
    expect(result.imported).toBe(2); // 1 create (saveMany) + 1 correction
  });

  it('does not create a second starting balance when one already exists in Wealthfolio', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([])); // balance 1000.00
    const ctx = makeCtx();
    // Valuation is stale/wrong (0), but Wealthfolio already holds a
    // starting-balance entry created by the companion
    ctx.api.activities.search = vi.fn(async () => ({
      data: [{ id: 'act-sb', comment: 'Starting balance · sfin-1' }],
    }));
    const store = makeStore({ getBalanceInitialized: vi.fn(async () => []) });
    await runSync(ctx, store as any);

    expect(ctx.api.activities.import).not.toHaveBeenCalled();
    // Still marks done so the search isn't repeated every run
    expect(store.addBalanceInitialized).toHaveBeenCalledWith('sfin-1');
  });

  it('starting balance self-cancels when window transactions already exist and the valuation is already correct', async () => {
    const tx = { id: 'tx-1', posted: 1700000000, amount: '-50.00', description: 'Groceries' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx])); // balance 1000.00
    const ctx = makeCtx();
    // The window tx is already imported (unchanged), so it is neither a create
    // nor part of the window delta.
    ctx.api.activities.search = vi.fn(async () => ({
      data: [{ id: 'act-1', comment: 'Groceries · tx-1', amount: '-50.00', activityType: 'WITHDRAWAL', date: '2023-11-14' }],
    }));
    ctx.api.portfolio.getLatestValuations = vi.fn(async () => [
      { accountId: 'wf-account-a', totalValue: 1000 },
    ]);
    const store = makeStore({ getBalanceInitialized: vi.fn(async () => []) });
    const result = await runSync(ctx, store as any);

    // 1000 target − 0 window delta − 1000 valuation = 0 → no correction
    expect(ctx.api.activities.import).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('isolates a failing account so others still import', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce({
      errors: [],
      accounts: [
        { id: 'sfin-bad', name: 'Bad', currency: 'USD', balance: '0', 'balance-date': 0,
          transactions: [{ id: 'tx-bad', posted: 1700000000, amount: '-5.00', description: 'X' }] },
        { id: 'sfin-1', name: 'Good', currency: 'USD', balance: '0', 'balance-date': 0,
          transactions: [{ id: 'tx-good', posted: 1700000000, amount: '-9.00', description: 'Y' }] },
      ],
    });
    const ctx = makeCtx();
    // saveMany throws only for the bad account's activity
    ctx.api.activities.saveMany = vi.fn(async (req: any) => {
      if ((req.creates ?? []).some((a: any) => a.comment.includes('tx-bad'))) throw new Error('boom');
      return { created: req.creates ?? [], updated: req.updates ?? [], deleted: req.deleteIds ?? [], createdMappings: [], errors: [] };
    });
    const store = makeStore({
      getAccountMapping: vi.fn(async () => ({ 'sfin-bad': 'wf-account-a', 'sfin-1': 'wf-account-b' })),
    });
    const result = await runSync(ctx, store as any);

    // Good account still imported; error recorded for the bad one
    const creates = vi.mocked(ctx.api.activities.saveMany).mock.calls.flatMap((c: any) => c[0].creates ?? []);
    expect(creates.some((a: any) => a.comment.includes('tx-good'))).toBe(true);
    expect(result.errors.some((e) => /failed/i.test(e))).toBe(true);
  });

  it('coalesces concurrent calls into a single run (single-flight)', async () => {
    let resolveFetch: (v: any) => void = () => {};
    vi.mocked(fetchAccounts).mockReturnValueOnce(
      new Promise((res) => { resolveFetch = res; }) as any,
    );
    const ctx = makeCtx();
    const store = makeStore();
    const a = runSync(ctx, store as any);
    const b = runSync(ctx, store as any); // same in-flight run
    resolveFetch(makeAccountSet([]));
    await Promise.all([a, b]);
    // fetchAccounts called once despite two runSync calls
    expect(fetchAccounts).toHaveBeenCalledTimes(1);
  });
});

describe('MIN_SYNC_INTERVAL_MS', () => {
  it('equals 1 hour in ms', () => {
    expect(MIN_SYNC_INTERVAL_MS).toBe(3_600_000);
  });
});
