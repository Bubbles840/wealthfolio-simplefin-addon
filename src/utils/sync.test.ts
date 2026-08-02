import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runSync,
  deliverAddonAlerts,
  applyBalanceAdjustment,
  applyBaselineCorrection,
  neutralAdjustmentFields,
  MIN_SYNC_INTERVAL_MS,
  VALUATION_POLL,
} from './sync';
import {
  formatStuckTransferAlert,
  formatBalanceDriftAlert,
  formatFeedLagNotice,
  formatLargeTransactionAlert,
  formatDuplicatePruneAlert,
} from '../../shared/telegram';

vi.mock('./simplefin', () => ({
  fetchAccounts: vi.fn(),
}));

import { fetchAccounts } from './simplefin';
import { AddonSyncHost } from './addon-host';

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
  getLinkedGroups: vi.fn(async (): Promise<Record<string, string>> => ({})),
  setLinkedGroups: vi.fn(async (_map: Record<string, string>) => {}),
  getTransferLinkFailures: vi.fn(
    async (): Promise<Record<string, { count: number; firstFailedAt: string; alerted: boolean }>> => ({}),
  ),
  setTransferLinkFailures: vi.fn(
    async (_map: Record<string, { count: number; firstFailedAt: string; alerted: boolean }>) => {},
  ),
  // Null = never configured, so the large-transaction alert is off for every
  // test that doesn't deliberately turn it on. The drift threshold's null falls
  // back to the $100 default instead, so these tests DO see drift alerting —
  // which is the realistic default and keeps it exercised here.
  getLargeTransactionThreshold: vi.fn(async (): Promise<number | null> => null),
  getDriftAlertThreshold: vi.fn(async (): Promise<number | null> => null),
  getDriftAlerts: vi.fn(
    async (): Promise<Record<string, { driftAmount: number; firstDetectedAt: string; alerted: boolean }>> => ({}),
  ),
  setDriftAlerts: vi.fn(
    async (_map: Record<string, { driftAmount: number; firstDetectedAt: string; alerted: boolean }>) => {},
  ),
  getAccountBalances: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  setAccountBalances: vi.fn(async (_map: Record<string, unknown>) => {}),
  getAutoHeal: vi.fn(async () => false),
  setAutoHeal: vi.fn(async (_on: boolean) => {}),
  getAutoAdjust: vi.fn(async () => false),
  setAutoAdjust: vi.fn(async (_on: boolean) => {}),
  // No Telegram: `runSync` now delivers the alerts its core produced, and the
  // default store must exercise the real "not configured" branch (which does
  // nothing) rather than an absent method. The delivery tests below override it.
  getTelegramConfig: vi.fn(async (): Promise<any | null> => null),
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
      // Mimic the host: echo saved rows back as Activity objects (which name the
      // comment field `notes`), assigning a new id to each create so the atomic
      // transfer-link flush can address them.
      saveMany: vi.fn(async (req: any) => ({
        created: (req.creates ?? []).map((c: any, i: number) => ({
          ...c, id: c.id ?? `created-${i}`, notes: c.comment,
        })),
        updated: (req.updates ?? []).map((u: any) => ({ ...u, notes: u.comment })),
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

  it('surfaces SimpleFin error strings verbatim (not "undefined — undefined")', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce({
      errors: ['Connection to 360 Performance Savings may need attention'],
      accounts: [],
    });
    const result = await runSync(makeCtx(), makeStore() as any);
    expect(result.errors.some((e) => e.includes('may need attention'))).toBe(true);
    expect(result.errors.some((e) => e.includes('undefined'))).toBe(false);
  });

  it('drops benign SimpleFin window-size notices (not real errors)', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce({
      errors: [
        'Requested date range exceeds recommended range of 45 days. In the future, this may be capped.',
        'Connection to Chase may need attention',
      ],
      accounts: [],
    });
    const result = await runSync(makeCtx(), makeStore() as any);
    expect(result.errors.some((e) => e.includes('recommended range'))).toBe(false);
    expect(result.errors.some((e) => e.includes('may need attention'))).toBe(true);
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
    expect(req.creates![0].symbol).toEqual({ symbol: '$CASH-USD' });
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

  it('captures the SimpleFin balance and drift for a quiet, diverged account', async () => {
    // balance 1000 from makeAccountSet, no transactions → stable run; the
    // default valuation for wf-account-a is 0, so drift = 1000 - 0.
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const store = makeStore();
    await runSync(makeCtx(), store as any);
    const captured = vi.mocked(store.setAccountBalances).mock.calls.at(-1)![0] as any;
    expect(captured['sfin-1'].balance).toBe(1000);
    expect(captured['sfin-1'].currency).toBe('USD');
    expect(captured['sfin-1'].drift).toBe(1000);
  });

  it('reports no drift when SimpleFin and Wealthfolio agree', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const ctx = makeCtx();
    ctx.api.portfolio.getLatestValuations = vi.fn(async () => [
      { accountId: 'wf-account-a', totalValue: 1000 },
    ]);
    const store = makeStore();
    await runSync(ctx, store as any);
    const captured = vi.mocked(store.setAccountBalances).mock.calls.at(-1)![0] as any;
    expect(captured['sfin-1'].drift).toBeNull();
  });

  it('does not flag drift on a run that imported (valuation lags the import)', async () => {
    const tx = { id: 'tx-x', posted: 1700000000, amount: '-25.00', description: 'Coffee' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx]));
    const store = makeStore();
    await runSync(makeCtx(), store as any);
    const captured = vi.mocked(store.setAccountBalances).mock.calls.at(-1)![0] as any;
    expect(captured['sfin-1'].balance).toBe(1000);
    expect(captured['sfin-1'].drift).toBeNull();
  });

  it('heal mode re-scans a 90-day window and bypasses the interval', async () => {
    const recentSync = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const store = makeStore({ getLastSyncAt: vi.fn(async () => recentSync) });
    await runSync(makeCtx(), store as any, { heal: true });
    expect(fetchAccounts).toHaveBeenCalledOnce();
    const startDate = vi.mocked(fetchAccounts).mock.calls[0][1] as Date;
    const daysAgo = (Date.now() - startDate.getTime()) / (24 * 60 * 60 * 1000);
    expect(daysAgo).toBeGreaterThan(88);
    expect(daysAgo).toBeLessThan(90);
  });

  it('the Auto-heal setting uses the narrower recurring window (≤45 days, not 30 or 90)', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const store = makeStore({ getAutoHeal: vi.fn(async () => true) });
    await runSync(makeCtx(), store as any);
    const startDate = vi.mocked(fetchAccounts).mock.calls[0][1] as Date;
    const daysAgo = (Date.now() - startDate.getTime()) / (24 * 60 * 60 * 1000);
    expect(daysAgo).toBeGreaterThan(43);
    expect(daysAgo).toBeLessThan(45); // recurring auto-heal stays within SimpleFin's 45-day recommendation
  });

  it('heal measures residual drift lag-free (accounting for what it imports)', async () => {
    // SimpleFin balance 1000, valuation 0, importing a +900 deposit this run →
    // residual = 1000 - 0 - 900 = 100 (still off by 100 after the import).
    const tx = { id: 'tx-dep', posted: 1700000000, amount: '900.00', description: 'Deposit' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx]));
    const store = makeStore();
    await runSync(makeCtx(), store as any, { heal: true });
    const captured = vi.mocked(store.setAccountBalances).mock.calls.at(-1)![0] as any;
    expect(captured['sfin-1'].drift).toBe(100);
  });

  it('aggressive auto-heal auto-inserts the adjustment and leaves no residual drift', async () => {
    // Quiet account: SimpleFin 1000, valuation 0 → residual 1000 in heal mode.
    // The episode is seeded AGED: a fresh over-threshold drift is deliberately
    // not plugged (the feed-lag gate); this test is about the plug happening
    // and the drift clearing once it legitimately fires.
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const store = makeStore({
      getAutoAdjust: vi.fn(async () => true),
      getDriftAlerts: vi.fn(async () => ({
        'sfin-1': { driftAmount: 1000, firstDetectedAt: new Date(Date.now() - 11 * 86400_000).toISOString(), alerted: true },
      })),
    });
    const ctx = makeCtx();
    await runSync(ctx, store as any);
    // A spending-neutral CREDIT of 1000 was imported (wf-account-a is CASH)...
    const imports = vi.mocked(ctx.api.activities.import).mock.calls.flatMap((c: any) => c[0]);
    const adj = imports.find((a: any) => String(a.comment).startsWith('Balance adjustment'));
    expect(adj).toBeTruthy();
    expect(adj.activityType).toBe('CREDIT');
    expect(adj.amount).toBe(1000);
    expect(adj.fee).toBe(0);
    // ...and the stored drift is cleared.
    const captured = vi.mocked(store.setAccountBalances).mock.calls.at(-1)![0] as any;
    expect(captured['sfin-1'].drift).toBeNull();
  });

  it('heal does not measure drift when the account has pending activity (not comparable)', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const ctx = makeCtx();
    // An existing pending row: Wealthfolio's valuation includes it but
    // SimpleFin's posted balance does not, so drift is not measurable.
    ctx.api.activities.search = vi.fn(async () => ({
      data: [
        { id: 'act-p', accountId: 'wf-account-a', activityType: 'WITHDRAWAL', date: '2026-07-10', amount: '5.00', comment: 'Coffee · tx-p · pending' },
      ],
    }));
    const store = makeStore();
    await runSync(ctx, store as any, { heal: true });
    const captured = vi.mocked(store.setAccountBalances).mock.calls.at(-1)![0] as any;
    expect(captured['sfin-1'].drift).toBeNull();
  });

  it('aggressive auto-heal does not stack a second adjustment when one exists today', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const ctx = makeCtx();
    const today = new Date().toISOString().split('T')[0];
    ctx.api.activities.search = vi.fn(async () => ({
      data: [
        { id: 'act-adj', accountId: 'wf-account-a', activityType: 'DEPOSIT', date: today, amount: '1000', comment: `Balance adjustment · sfin-1 · ${today}` },
      ],
    }));
    // Aged episode so the plug path actually runs — the once-per-day guard is
    // what this test is about, and a young drift never reaches it.
    const store = makeStore({
      getAutoAdjust: vi.fn(async () => true),
      getDriftAlerts: vi.fn(async () => ({
        'sfin-1': { driftAmount: 1000, firstDetectedAt: new Date(Date.now() - 11 * 86400_000).toISOString(), alerted: true },
      })),
    });
    await runSync(ctx, store as any);
    const imports = vi.mocked(ctx.api.activities.import).mock.calls.flatMap((c: any) => c[0]);
    const adjustments = imports.filter((a: any) => String(a.comment).startsWith('Balance adjustment'));
    expect(adjustments).toHaveLength(0); // guarded: one already exists today
    const captured = vi.mocked(store.setAccountBalances).mock.calls.at(-1)![0] as any;
    expect(captured['sfin-1'].drift).toBeNull();
  });

  it('applyBalanceAdjustment imports a spending-neutral CREDIT on a CASH account and clears the drift', async () => {
    const ctx = makeCtx();
    const store = makeStore({
      getAccountBalances: vi.fn(async () => ({
        'sfin-1': { balance: 1000, currency: 'USD', date: 1700000000, drift: 250.5 },
      })),
    });
    await applyBalanceAdjustment(ctx, store as any, {
      sfinAccountId: 'sfin-1', wfAccountId: 'wf-account-a', currency: 'USD', amount: 250.5,
    });
    const imported = vi.mocked(ctx.api.activities.import).mock.calls.at(-1)![0] as any[];
    expect(imported[0].activityType).toBe('CREDIT');
    expect(imported[0].amount).toBe(250.5);
    expect(imported[0].fee).toBe(0);
    expect(imported[0].comment).toMatch(/^Balance adjustment · sfin-1 · /);
    const persisted = vi.mocked(store.setAccountBalances).mock.calls.at(-1)![0] as any;
    expect(persisted['sfin-1'].drift).toBeNull();
  });

  it('applyBaselineCorrection rewrites the baseline row and clears both the drift and the spent offer', async () => {
    const ctx = makeCtx();
    ctx.api.activities.search = vi.fn(async () => ({
      data: [{
        id: 'sb-1', accountId: 'wf-account-a', activityType: 'DEPOSIT', date: '2026-06-19',
        amount: '11355.12', comment: 'Starting balance · sfin-1',
      }],
    }));
    const store = makeStore({
      getAccountBalances: vi.fn(async () => ({
        'sfin-1': {
          balance: 10.65, currency: 'USD', date: 1700000000, drift: -1300,
          baselineFix: { activityId: 'sb-1', currentAmount: 11355.12, suggestedAmount: 10055.12 },
        },
      })),
    });
    await applyBaselineCorrection(ctx, store as any, {
      sfinAccountId: 'sfin-1', wfAccountId: 'wf-account-a', currency: 'USD',
      suggestedAmount: 10055.12,
    });
    const update = vi.mocked(ctx.api.activities.saveMany).mock.calls.at(-1)![0].updates![0] as any;
    expect(update.id).toBe('sb-1');
    expect(update.amount).toBe(10055.12);
    const persisted = vi.mocked(store.setAccountBalances).mock.calls.at(-1)![0] as any;
    expect(persisted['sfin-1'].drift).toBeNull();
    // The offer has been spent. Leaving it would re-render the button for a
    // correction that has already been applied — one more click, one more $1,300.
    expect(persisted['sfin-1'].baselineFix).toBeUndefined();
  });

  it('applyBaselineCorrection throws instead of reporting success when the write is refused', async () => {
    const ctx = makeCtx();
    ctx.api.activities.search = vi.fn(async () => ({
      data: [{
        id: 'sb-1', accountId: 'wf-account-a', activityType: 'DEPOSIT', date: '2026-06-19',
        amount: '11355.12', comment: 'Starting balance · sfin-1',
      }],
    }));
    ctx.api.activities.saveMany = vi.fn(async () => ({
      created: [], updated: [], deleted: [], createdMappings: [],
      errors: [{ action: 'update', message: 'validation failed' }],
    }));
    const store = makeStore({ setAccountBalances: vi.fn(async () => {}) });
    await expect(
      applyBaselineCorrection(ctx, store as any, {
        sfinAccountId: 'sfin-1', wfAccountId: 'wf-account-a', currency: 'USD',
        suggestedAmount: 10055.12,
      }),
    ).rejects.toThrow(/validation failed/);
    // Nothing may be cleared on a failed write, or the page would show the
    // account as fixed while the wrong baseline is still in place.
    expect(store.setAccountBalances).not.toHaveBeenCalled();
  });

  it('applyBalanceAdjustment imports a spending-neutral CREDIT+fee for a negative drift on a CASH account', async () => {
    const ctx = makeCtx();
    const store = makeStore({
      getAccountBalances: vi.fn(async () => ({
        'sfin-1': { balance: 1000, currency: 'USD', date: 1700000000, drift: -2635.26 },
      })),
    });
    await applyBalanceAdjustment(ctx, store as any, {
      sfinAccountId: 'sfin-1', wfAccountId: 'wf-account-a', currency: 'USD', amount: -2635.26,
    });
    const imported = vi.mocked(ctx.api.activities.import).mock.calls.at(-1)![0] as any[];
    expect(imported[0].activityType).toBe('CREDIT');
    expect(imported[0].amount).toBe(0);
    expect(imported[0].fee).toBe(2635.26);
  });

  it('applyBalanceAdjustment keeps DEPOSIT/WITHDRAWAL on a non-CASH account', async () => {
    const ctx = makeCtx();
    const store = makeStore({
      getAccountBalances: vi.fn(async () => ({
        'sfin-2': { balance: 100, currency: 'USD', date: 1700000000, drift: -80 },
      })),
    });
    await applyBalanceAdjustment(ctx, store as any, {
      sfinAccountId: 'sfin-2', wfAccountId: 'wf-account-b', currency: 'USD', amount: -80,
    });
    const imported = vi.mocked(ctx.api.activities.import).mock.calls.at(-1)![0] as any[];
    expect(imported[0].activityType).toBe('WITHDRAWAL');
    expect(imported[0].amount).toBe(80);
    expect(imported[0].fee).toBe(0);
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

  // A matching TRANSFER_OUT (account A) and TRANSFER_IN (account B) posted
  // within the 3-day window, used by the linking tests below.
  const transferPairAccountSet = () => ({
    errors: [],
    accounts: [
      { id: 'sfin-1', name: 'Checking', currency: 'USD', balance: '1000.00', 'balance-date': 1700000000,
        transactions: [{ id: 'tx-out', posted: 1700000000, amount: '-500.00', description: 'Payment to Citibank' }] },
      { id: 'sfin-2', name: 'Card', currency: 'USD', balance: '-500.00', 'balance-date': 1700086400,
        transactions: [{ id: 'tx-in', posted: 1700086400, amount: '500.00', description: 'PAYMENT THANK YOU' }] },
    ],
  });
  const twoAccountStore = (overrides: Record<string, unknown> = {}) =>
    makeStore({
      getAccountMapping: vi.fn(async () => ({ 'sfin-1': 'wf-account-a', 'sfin-2': 'wf-account-b' })),
      ...overrides,
    });

  it('auto-links a new transfer pair: both legs share a sourceGroupId in a SINGLE atomic flush call', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(transferPairAccountSet());
    const ctx = makeCtx();
    const store = twoAccountStore();
    await runSync(ctx, store as any);

    // Linking is NOT done on the per-account import creates (a per-account call
    // only ever holds one leg of a cross-account pair). Both legs are re-created
    // together in one saveMany so Wealthfolio sees a complete 2-leg group.
    const flushCall = vi.mocked(ctx.api.activities.saveMany).mock.calls
      .find((c: any) => (c[0].creates ?? []).some((u: any) => u.sourceGroupId));
    expect(flushCall).toBeTruthy();
    const flushCreates = flushCall![0].creates as any[];
    const out = flushCreates.find((u) => u.comment.includes('tx-out'));
    const inn = flushCreates.find((u) => u.comment.includes('tx-in'));
    expect(out.sourceGroupId).toBeTruthy();
    expect(inn.sourceGroupId).toBe(out.sourceGroupId);
    // Both legs are in the SAME call (atomic) — that is the whole fix.
    expect(flushCreates.filter((u) => u.sourceGroupId).length).toBe(2);

    expect(store.setLinkedGroups).toHaveBeenCalled();
    const persisted = vi.mocked(store.setLinkedGroups).mock.calls.at(-1)![0] as Record<string, string>;
    // Keyed PER LEG (account + tx id), not by tx id alone: SimpleFin issues one
    // id for both sides of a transfer it can see end to end, and a bare-txId
    // ledger collapses such a pair into a single entry that cannot say whether
    // both legs were grouped.
    const keys = Object.keys(persisted);
    expect(keys).toHaveLength(2);
    expect(keys.filter((k) => k.endsWith('\u0000tx-out') || k.endsWith('\u0000tx-in'))).toHaveLength(2);
    expect(new Set(Object.values(persisted))).toEqual(new Set([out.sourceGroupId]));
  });

  it('re-links an already-imported transfer pair by deleting and re-creating both legs', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(transferPairAccountSet());
    const ctx = makeCtx();
    // Both sides already exist as unchanged rows (matching type/amount/date), so
    // the reconciler produces no create and no update — the link flush must
    // recreate them: an update can neither clear a stored asset nor move a row
    // out of a stale group, and a half-formed group gets dropped by the host.
    const existingByAccount: Record<string, any[]> = {
      'wf-account-a': [{ id: 'act-out', comment: 'Payment to Citibank · tx-out', amount: '-500.00', activityType: 'TRANSFER_OUT', date: '2023-11-14' }],
      'wf-account-b': [{ id: 'act-in', comment: 'PAYMENT THANK YOU · tx-in', amount: '500.00', activityType: 'TRANSFER_IN', date: '2023-11-15' }],
    };
    ctx.api.activities.search = vi.fn(async (_p: number, _l: number, filter: any) => ({
      data: existingByAccount[filter.accountIds[0]] ?? [],
    }));
    const store = twoAccountStore();
    await runSync(ctx, store as any);

    const calls = vi.mocked(ctx.api.activities.saveMany).mock.calls.map((c: any) => c[0]);
    const del = calls.find((r: any) => (r.deleteIds ?? []).length > 0);
    expect(del.deleteIds.sort()).toEqual(['act-in', 'act-out']);
    const flush = calls.find((r: any) => (r.creates ?? []).some((c: any) => c.sourceGroupId))!.creates as any[];
    expect(flush).toHaveLength(2);
    expect(flush[0].sourceGroupId).toBe(flush[1].sourceGroupId);
    expect(store.setLinkedGroups).toHaveBeenCalledOnce();
  });

  it('does nothing for a transfer pair already linked in the ledger (idempotent, no churn)', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(transferPairAccountSet());
    const ctx = makeCtx();
    const existingByAccount: Record<string, any[]> = {
      'wf-account-a': [{ id: 'act-out', comment: 'Payment to Citibank · tx-out', amount: '-500.00', activityType: 'TRANSFER_OUT', date: '2023-11-14' }],
      'wf-account-b': [{ id: 'act-in', comment: 'PAYMENT THANK YOU · tx-in', amount: '500.00', activityType: 'TRANSFER_IN', date: '2023-11-15' }],
    };
    ctx.api.activities.search = vi.fn(async (_p: number, _l: number, filter: any) => ({
      data: existingByAccount[filter.accountIds[0]] ?? [],
    }));
    // An echo-confirmed gid (carries the wf-transfer- prefix) is trusted.
    const store = twoAccountStore({
      getLinkedGroups: vi.fn(async () => ({
        'tx-out': 'wf-transfer-existing', 'tx-in': 'wf-transfer-existing',
      })),
    });
    await runSync(ctx, store as any);

    const calls = vi.mocked(ctx.api.activities.saveMany).mock.calls.map((c: any) => c[0]);
    expect(calls.flatMap((r: any) => r.creates ?? []).some((c: any) => c.sourceGroupId)).toBe(false);
    expect(calls.flatMap((r: any) => r.deleteIds ?? [])).toHaveLength(0);
    expect(store.setLinkedGroups).not.toHaveBeenCalled();
  });

  it('drops pre-prefix ledger gids once so a wrongly-"linked" pair is retried', async () => {
    // Gids written before the ledger was echo-confirmed may claim a link that
    // never landed. They are purged on load, so the pair gets one clean retry.
    vi.mocked(fetchAccounts).mockResolvedValueOnce(transferPairAccountSet());
    const ctx = makeCtx();
    const existingByAccount: Record<string, any[]> = {
      'wf-account-a': [{ id: 'act-out', comment: 'Payment to Citibank · tx-out', amount: '-500.00', activityType: 'TRANSFER_OUT', date: '2023-11-14' }],
      'wf-account-b': [{ id: 'act-in', comment: 'PAYMENT THANK YOU · tx-in', amount: '500.00', activityType: 'TRANSFER_IN', date: '2023-11-15' }],
    };
    ctx.api.activities.search = vi.fn(async (_p: number, _l: number, filter: any) => ({
      data: existingByAccount[filter.accountIds[0]] ?? [],
    }));
    const store = twoAccountStore({
      getLinkedGroups: vi.fn(async () => ({ 'tx-out': 'legacy-uuid', 'tx-in': 'legacy-uuid' })),
    });
    await runSync(ctx, store as any);

    const calls = vi.mocked(ctx.api.activities.saveMany).mock.calls.map((c: any) => c[0]);
    const flush = calls.find((r: any) => (r.creates ?? []).some((c: any) => c.sourceGroupId));
    expect(flush).toBeTruthy(); // retried despite the ledger claiming "linked"
    const persisted = vi.mocked(store.setLinkedGroups).mock.calls.at(-1)![0] as Record<string, string>;
    expect(persisted['tx-out']).not.toBe('legacy-uuid');
  });

  it('sends transfer legs with NO asset so they book real cash and stay pairable', async () => {
    // $CASH-<ccy> resolves to a literal "$CASH" security for TRANSFER_IN/OUT
    // (upstream #5): the balance never moves (the holdings calculator only books
    // cash when asset_id is empty) and the pair fails validate_asset_shape as a
    // quantity-less security transfer, so it can't be linked. Omitting the
    // symbol takes the cash branch in both places.
    vi.mocked(fetchAccounts).mockResolvedValueOnce(transferPairAccountSet());
    const ctx = makeCtx();
    await runSync(ctx, twoAccountStore() as any);

    const creates = vi.mocked(ctx.api.activities.saveMany).mock.calls.flatMap((c: any) => c[0].creates ?? []);
    const out = creates.find((a: any) => a.comment.includes('tx-out'));
    const inn = creates.find((a: any) => a.comment.includes('tx-in'));
    expect(out.activityType).toBe('TRANSFER_OUT');
    expect(inn.activityType).toBe('TRANSFER_IN');
    expect(out.symbol).toBeUndefined();
    expect(inn.symbol).toBeUndefined();
    // The amount is what books the cash movement on the empty-asset path.
    expect(out.amount).toBe(500);
    expect(inn.amount).toBe(500);
  });

  it('link writes carry the internal-transfer marker, a wf-transfer- gid, and no asset', async () => {
    // A shared sourceGroupId alone does NOT make Wealthfolio treat the pair as
    // internal — activity_has_internal_transfer_marker requires
    // metadata.flow.is_external === false (or a wf-transfer- group id).
    vi.mocked(fetchAccounts).mockResolvedValueOnce(transferPairAccountSet());
    const ctx = makeCtx();
    const existingByAccount: Record<string, any[]> = {
      'wf-account-a': [{ id: 'act-out', comment: 'Payment to Citibank · tx-out', amount: '-500.00', activityType: 'TRANSFER_OUT', date: '2023-11-14' }],
      'wf-account-b': [{ id: 'act-in', comment: 'PAYMENT THANK YOU · tx-in', amount: '500.00', activityType: 'TRANSFER_IN', date: '2023-11-15' }],
    };
    ctx.api.activities.search = vi.fn(async (_p: number, _l: number, filter: any) => ({
      data: existingByAccount[filter.accountIds[0]] ?? [],
    }));
    await runSync(ctx, twoAccountStore() as any);

    const flush = vi.mocked(ctx.api.activities.saveMany).mock.calls
      .find((c: any) => (c[0].creates ?? []).some((u: any) => u.sourceGroupId))![0].creates as any[];
    expect(flush).toHaveLength(2);
    for (const u of flush) {
      expect(u.symbol).toBeUndefined();
      // Must be a JSON *string* — the server's metadata is Option<String> and
      // an object 422s ("Unprocessable Entity").
      expect(typeof u.metadata).toBe('string');
      expect(JSON.parse(u.metadata)).toEqual({ flow: { is_external: false } });
      expect(String(u.sourceGroupId).startsWith('wf-transfer-')).toBe(true);
    }
    expect(flush[0].sourceGroupId).toBe(flush[1].sourceGroupId);
  });

  it('re-creates legacy transfer legs that still carry an asset (an update cannot clear it)', async () => {
    // Legs imported before we knew transfers must be asset-free hold the phantom
    // "$CASH" security. The server's `asset` is a plain Option (not the
    // Option<Option<…>> patch shape), so omitting it does NOT clear a stored
    // asset — and a leg with an asset neither books cash nor passes
    // validate_asset_shape. So they must be deleted and re-created asset-free.
    vi.mocked(fetchAccounts).mockResolvedValueOnce(transferPairAccountSet());
    const ctx = makeCtx();
    const existingByAccount: Record<string, any[]> = {
      'wf-account-a': [{ id: 'act-out', assetId: '$CASH', comment: 'Payment to Citibank · tx-out', amount: '-500.00', activityType: 'TRANSFER_OUT', date: '2023-11-14' }],
      'wf-account-b': [{ id: 'act-in', assetId: '$CASH', comment: 'PAYMENT THANK YOU · tx-in', amount: '500.00', activityType: 'TRANSFER_IN', date: '2023-11-15' }],
    };
    ctx.api.activities.search = vi.fn(async (_p: number, _l: number, filter: any) => ({
      data: existingByAccount[filter.accountIds[0]] ?? [],
    }));
    await runSync(ctx, twoAccountStore() as any);

    const calls = vi.mocked(ctx.api.activities.saveMany).mock.calls.map((c: any) => c[0]);
    // Stale legs deleted...
    const del = calls.find((r: any) => (r.deleteIds ?? []).length > 0);
    expect(del.deleteIds.sort()).toEqual(['act-in', 'act-out']);
    // ...then both re-created asset-free, in ONE call, sharing a marked group.
    const recreate = calls.find((r: any) =>
      (r.creates ?? []).some((c: any) => c.sourceGroupId));
    expect(recreate.creates).toHaveLength(2);
    for (const c of recreate.creates) {
      expect(c.symbol).toBeUndefined();
      expect(typeof c.metadata).toBe('string');
      expect(String(c.sourceGroupId).startsWith('wf-transfer-')).toBe(true);
    }
    expect(recreate.creates[0].sourceGroupId).toBe(recreate.creates[1].sourceGroupId);
    // No update was attempted for these legs (it could not have worked).
    expect((recreate.updates ?? []).some((u: any) => u.id === 'act-out')).toBe(false);
  });

  it('nets recovered pre-baseline history out of the starting balance (no double-count)', async () => {
    // A wide re-scan reaches back past the starting-balance date. Those rows are
    // already baked into the baseline, so importing them without adjusting it
    // makes the account drift by exactly their sum.
    const older = { id: 'tx-old', posted: Date.parse('2026-04-23T12:00:00Z') / 1000, amount: '-1300.00', description: 'ACH Withdrawal PNC' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([older]));
    const ctx = makeCtx();
    // An existing $4,500.38 baseline dated AFTER the recovered transaction.
    ctx.api.activities.search = vi.fn(async () => ({
      data: [{
        id: 'act-start', accountId: 'wf-account-a', activityType: 'DEPOSIT',
        date: '2026-06-18', amount: '4500.38', comment: 'Starting balance · sfin-1',
      }],
    }));
    await runSync(ctx, makeStore() as any);

    const update = vi.mocked(ctx.api.activities.saveMany).mock.calls
      .flatMap((c: any) => c[0].updates ?? [])
      .find((u: any) => u.id === 'act-start');
    expect(update).toBeTruthy();
    // The baseline already reflects that this $1,300 withdrawal happened, so the
    // newly-imported row would subtract it a second time. Netting it out means
    // baseline − signed = 4500.38 − (−1300) = 5800.38, which then leaves
    // 5800.38 − 1300 = 4500.38 — the balance the baseline always represented.
    expect(update.amount).toBeCloseTo(5800.38, 2);
    expect(update.activityType).toBe('DEPOSIT');
  });

  it('leaves the starting balance alone when nothing older than it was imported', async () => {
    const recent = { id: 'tx-new', posted: Date.parse('2026-07-20T12:00:00Z') / 1000, amount: '-25.00', description: 'Coffee' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([recent]));
    const ctx = makeCtx();
    ctx.api.activities.search = vi.fn(async () => ({
      data: [{
        id: 'act-start', accountId: 'wf-account-a', activityType: 'DEPOSIT',
        date: '2026-06-18', amount: '4500.38', comment: 'Starting balance · sfin-1',
      }],
    }));
    await runSync(ctx, makeStore() as any);

    const touched = vi.mocked(ctx.api.activities.saveMany).mock.calls
      .flatMap((c: any) => c[0].updates ?? [])
      .some((u: any) => u.id === 'act-start');
    expect(touched).toBe(false);
  });

  it('does not set a sourceGroupId on a non-pair (lone) transaction', async () => {
    const tx = { id: 'tx-solo', posted: 1700000000, amount: '-12.50', description: 'Coffee' };
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([tx]));
    const ctx = makeCtx();
    const store = makeStore();
    await runSync(ctx, store as any);
    const create = vi.mocked(ctx.api.activities.saveMany).mock.calls[0][0].creates![0];
    expect(create.sourceGroupId).toBeUndefined();
    expect(store.setLinkedGroups).not.toHaveBeenCalled();
  });

  it('never reuses a stored gid when re-linking (a half-formed group gets dropped)', async () => {
    // Wealthfolio refuses to move an already-grouped row, so reusing a gid can
    // leave the new group with one leg — which it drops, leaving that leg
    // unlinked. Re-linking therefore always mints a fresh group id.
    vi.mocked(fetchAccounts).mockResolvedValueOnce(transferPairAccountSet());
    const ctx = makeCtx();
    const existingByAccount: Record<string, any[]> = {
      'wf-account-a': [{ id: 'act-out', comment: 'Payment to Citibank · tx-out', amount: '-500.00', activityType: 'TRANSFER_OUT', date: '2023-11-14' }],
      'wf-account-b': [{ id: 'act-in', comment: 'PAYMENT THANK YOU · tx-in', amount: '500.00', activityType: 'TRANSFER_IN', date: '2023-11-15' }],
    };
    ctx.api.activities.search = vi.fn(async (_p: number, _l: number, filter: any) => ({
      data: existingByAccount[filter.accountIds[0]] ?? [],
    }));
    const store = twoAccountStore({
      getLinkedGroups: vi.fn(async () => ({ 'tx-out': 'legacy-uuid', 'tx-in': 'legacy-uuid' })),
    });
    await runSync(ctx, store as any, { heal: true });

    const flush = vi.mocked(ctx.api.activities.saveMany).mock.calls
      .map((c: any) => c[0])
      .find((r: any) => (r.creates ?? []).some((c: any) => c.sourceGroupId))!.creates as any[];
    expect(flush[0].sourceGroupId).toBe(flush[1].sourceGroupId);
    expect(flush[0].sourceGroupId).not.toBe('legacy-uuid');
    expect(String(flush[0].sourceGroupId).startsWith('wf-transfer-')).toBe(true);
  });

  it('purges the ledger entry when Wealthfolio drops a stamped gid (echoed null → retry fresh)', async () => {
    // Reproduces the stuck-pair bug: the save succeeds (no error) but Wealthfolio
    // silently stores NO sourceGroupId for the row (poisoned/invalid group). The
    // ledger must then FORGET that pair so the next heal mints a fresh, clean gid.
    vi.mocked(fetchAccounts).mockResolvedValueOnce(transferPairAccountSet());
    const ctx = makeCtx();
    const existingByAccount: Record<string, any[]> = {
      'wf-account-a': [{ id: 'act-out', comment: 'Payment to Citibank · tx-out', amount: '-500.00', activityType: 'TRANSFER_OUT', date: '2023-11-14' }],
      'wf-account-b': [{ id: 'act-in', comment: 'PAYMENT THANK YOU · tx-in', amount: '500.00', activityType: 'TRANSFER_IN', date: '2023-11-15' }],
    };
    ctx.api.activities.search = vi.fn(async (_p: number, _l: number, filter: any) => ({
      data: existingByAccount[filter.accountIds[0]] ?? [],
    }));
    // saveMany "succeeds" but echoes the row back with sourceGroupId dropped to null.
    ctx.api.activities.saveMany = vi.fn(async (req: any) => ({
      created: (req.creates ?? []).map((c: any, i: number) => ({ ...c, id: `new-${i}`, notes: c.comment, sourceGroupId: null })),
      updated: (req.updates ?? []).map((u: any) => ({ ...u, notes: u.comment, sourceGroupId: null })),
      deleted: req.deleteIds ?? [],
      createdMappings: [],
      errors: [],
    }));
    const store = twoAccountStore({
      getLinkedGroups: vi.fn(async () => ({ 'tx-out': 'legacy-poisoned', 'tx-in': 'legacy-poisoned' })),
    });
    await runSync(ctx, store as any, { heal: true });

    // The dropped entries must be purged from the persisted ledger.
    expect(store.setLinkedGroups).toHaveBeenCalled();
    const persisted = vi.mocked(store.setLinkedGroups).mock.calls.at(-1)![0] as Record<string, string>;
    expect(persisted['tx-out']).toBeUndefined();
    expect(persisted['tx-in']).toBeUndefined();
  });

  it('adopts Wealthfolio\'s real gid on reconcile when it differs from what we sent (kills churn)', async () => {
    // Already-grouped rows: Wealthfolio keeps its own gid and ignores ours. The
    // ledger should adopt the REAL gid so future runs stop re-stamping.
    vi.mocked(fetchAccounts).mockResolvedValueOnce(transferPairAccountSet());
    const ctx = makeCtx();
    const existingByAccount: Record<string, any[]> = {
      'wf-account-a': [{ id: 'act-out', comment: 'Payment to Citibank · tx-out', amount: '-500.00', activityType: 'TRANSFER_OUT', date: '2023-11-14' }],
      'wf-account-b': [{ id: 'act-in', comment: 'PAYMENT THANK YOU · tx-in', amount: '500.00', activityType: 'TRANSFER_IN', date: '2023-11-15' }],
    };
    ctx.api.activities.search = vi.fn(async (_p: number, _l: number, filter: any) => ({
      data: existingByAccount[filter.accountIds[0]] ?? [],
    }));
    // Wealthfolio keeps its pre-existing 'gid-real', regardless of what we sent.
    ctx.api.activities.saveMany = vi.fn(async (req: any) => ({
      created: (req.creates ?? []).map((c: any, i: number) => ({ ...c, id: `new-${i}`, notes: c.comment, sourceGroupId: 'gid-real' })),
      updated: (req.updates ?? []).map((u: any) => ({ ...u, notes: u.comment, sourceGroupId: 'gid-real' })),
      deleted: req.deleteIds ?? [],
      createdMappings: [],
      errors: [],
    }));
    const store = twoAccountStore({
      getLinkedGroups: vi.fn(async () => ({ 'tx-out': 'gid-stale', 'tx-in': 'gid-stale' })),
    });
    await runSync(ctx, store as any, { heal: true });

    const persisted = vi.mocked(store.setLinkedGroups).mock.calls.at(-1)![0] as Record<string, string>;
    // The REAL gid is adopted, under one PER-LEG key each...
    expect(Object.keys(persisted)).toHaveLength(2);
    expect(new Set(Object.values(persisted))).toEqual(new Set(['gid-real']));
    // ...and the legacy bare-txId entries are drained rather than left behind to
    // shadow the per-leg ones on the next run.
    expect(persisted['tx-out']).toBeUndefined();
    expect(persisted['tx-in']).toBeUndefined();
  });

  it('does not persist the ledger when a save errors (retries next sync)', async () => {
    vi.mocked(fetchAccounts).mockResolvedValueOnce(transferPairAccountSet());
    const ctx = makeCtx();
    ctx.api.activities.saveMany = vi.fn(async (req: any) => ({
      created: [],
      updated: [],
      deleted: req.deleteIds ?? [],
      createdMappings: [],
      errors: [{ action: 'create', message: 'boom' }],
    }));
    const store = twoAccountStore();
    const result = await runSync(ctx, store as any);

    // The import errored, so no rows were registered for the flush and the
    // ledger must not be recorded as linked — the pair retries on a later sync.
    expect(result.errors.some((e) => /save error/.test(e))).toBe(true);
    expect(store.setLinkedGroups).not.toHaveBeenCalled();
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

describe('neutralAdjustmentFields', () => {
  it('CASH + positive drift: CREDIT with amount, no fee', () => {
    expect(neutralAdjustmentFields('CASH', 250.5)).toEqual({
      activityType: 'CREDIT', amount: 250.5, fee: 0,
    });
  });

  it('CASH + negative drift: CREDIT with fee, no amount — nets to the drift', () => {
    const result = neutralAdjustmentFields('CASH', -2635.26);
    expect(result).toEqual({ activityType: 'CREDIT', amount: 0, fee: 2635.26 });
    expect(result.amount - result.fee).toBeCloseTo(-2635.26);
  });

  it('CREDIT_CARD: keeps DEPOSIT/WITHDRAWAL', () => {
    expect(neutralAdjustmentFields('CREDIT_CARD', 40)).toEqual({
      activityType: 'DEPOSIT', amount: 40, fee: 0,
    });
    expect(neutralAdjustmentFields('CREDIT_CARD', -40)).toEqual({
      activityType: 'WITHDRAWAL', amount: 40, fee: 0,
    });
  });

  it('unknown/SECURITIES account type: keeps DEPOSIT/WITHDRAWAL', () => {
    expect(neutralAdjustmentFields('SECURITIES', 10)).toEqual({
      activityType: 'DEPOSIT', amount: 10, fee: 0,
    });
    expect(neutralAdjustmentFields('', -10)).toEqual({
      activityType: 'WITHDRAWAL', amount: 10, fee: 0,
    });
  });

  it('rounds to cents', () => {
    expect(neutralAdjustmentFields('CASH', 10.129)).toEqual({
      activityType: 'CREDIT', amount: 10.13, fee: 0,
    });
  });
});

describe('deliverAddonAlerts', () => {
  // The addon runs the identical core, so it consumes the same three alert
  // arrays the companion does — marking `alerted` in the shared ledger and, for
  // large transactions, permanently spending the only chance to announce a row
  // (a create happens once per SimpleFin tx id). Before this, an in-app sync that
  // won the race against the companion silently swallowed all three.

  /** A network whose Telegram POSTs succeed. `sendTelegramMessage` prefers this
   *  over `fetch`, which is the whole point of the addon path: the SDK broker is
   *  what `manifest.json`'s allowedHosts actually permits. */
  const okNet = () =>
    vi.fn(async (_opts: any) => ({ status: 200, headers: {}, body: JSON.stringify({ ok: true }) }));
  /** A network whose POSTs are ACCEPTED by the transport but rejected by the
   *  Telegram API — the failure `sendTelegramMessage` reports by resolving
   *  `{ ok: false }` rather than throwing, which is the one a naive caller loses. */
  const rejectingNet = () =>
    vi.fn(async (_opts: any) => ({
      status: 200, headers: {},
      body: JSON.stringify({ ok: false, description: "can't parse entities" }),
    }));

  const alertCtx = (request: any) => ({ api: { network: { request } } }) as any;

  const tgStore = (overrides: Record<string, unknown> = {}) =>
    makeStore({
      getTelegramConfig: vi.fn(async () => ({ botToken: 'tok', chatId: '42', enabled: true })),
      getPendingLargeTxAlerts: vi.fn(async (): Promise<any[]> => []),
      setPendingLargeTxAlerts: vi.fn(async (_a: any[]) => {}),
      ...overrides,
    }) as any;

  const emptyResult = (over: Partial<any> = {}) => ({
    imported: 0, skipped: 0, errors: [],
    stuckTransferAlerts: [], importedTransactions: [], largeTransactionAlerts: [],
    balanceDriftAlerts: [], prunedDuplicates: [],
    ...over,
  });

  const sentTexts = (request: any) =>
    request.mock.calls.map((c: any[]) => JSON.parse(c[0].body).text);

  it('sends a stuck-transfer alert through the SDK network, not bare fetch', async () => {
    const request = okNet();
    const store = tgStore();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await deliverAddonAlerts(alertCtx(request), store as any, emptyResult({
      stuckTransferAlerts: [
        { outTxId: 'tx-out', description: 'AMAZON *MKTPLACE ↔ Payment', amountCents: 130000, currency: 'USD' },
      ],
    }));

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0][0].url).toContain('https://api.telegram.org/bottok/sendMessage');
    // Byte-identical to what the companion sends: one shared formatter, so the
    // escaping travels with it.
    expect(sentTexts(request)[0]).toBe(formatStuckTransferAlert({
      description: 'AMAZON *MKTPLACE ↔ Payment', amountCents: 130000, currency: 'USD',
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    // Delivered, so the `alerted: true` runSyncCore already wrote is correct and
    // there is nothing left to write.
    expect(store.setTransferLinkFailures).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('rolls back the stuck-transfer ledger when Telegram rejects the send', async () => {
    const store = tgStore({
      getTransferLinkFailures: vi.fn(async () => ({
        'tx-out': { count: 3, firstFailedAt: '2026-07-01T00:00:00.000Z', alerted: true },
        'tx-other': { count: 1, firstFailedAt: '2026-07-02T00:00:00.000Z', alerted: false },
      })),
    });

    await deliverAddonAlerts(alertCtx(rejectingNet()), store as any, emptyResult({
      stuckTransferAlerts: [
        { outTxId: 'tx-out', description: 'Payment ↔ Payment', amountCents: 50000, currency: 'USD' },
      ],
    }));

    const written = (store.setTransferLinkFailures as any).mock.calls[0][0];
    expect(written['tx-out'].alerted).toBe(false);
    // The 3-strike streak survives — a rollback re-arms delivery, it does not
    // declare the transfer healthy.
    expect(written['tx-out'].count).toBe(3);
    expect(written['tx-out'].firstFailedAt).toBe('2026-07-01T00:00:00.000Z');
    expect(written['tx-other']).toEqual({ count: 1, firstFailedAt: '2026-07-02T00:00:00.000Z', alerted: false });
  });

  it('rolls back the drift ledger when Telegram rejects the send, keeping the episode', async () => {
    const store = tgStore({
      getDriftAlerts: vi.fn(async () => ({
        'sfin-1': { driftAmount: 1300, firstDetectedAt: '2026-07-01T00:00:00.000Z', alerted: true },
      })),
    });

    await deliverAddonAlerts(alertCtx(rejectingNet()), store as any, emptyResult({
      balanceDriftAlerts: [
        { sfinAccountId: 'sfin-1', accountName: 'Spend', driftAmount: 1300, currency: 'USD', bankBalance: 3475.23, phase: 'young' },
      ],
    }));

    const written = (store.setDriftAlerts as any).mock.calls[0][0];
    expect(written['sfin-1'].alerted).toBe(false);
    expect(written['sfin-1'].driftAmount).toBe(1300);
    expect(written['sfin-1'].firstDetectedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('sends a YOUNG drift as the soft feed-lag notice, not the alarm', async () => {
    // A young unexplainable drift is usually the bank's balance ahead of its
    // own feed. The alarm styling goaded users toward the Add button, which
    // bakes lag into a fake transaction that double-counts days later.
    const request = okNet();
    const store = tgStore();
    await deliverAddonAlerts(alertCtx(request), store as any, emptyResult({
      balanceDriftAlerts: [
        { sfinAccountId: 'sfin-1', accountName: 'Joint_Spend', driftAmount: 1300, currency: 'USD', bankBalance: 3475.23, phase: 'young' },
      ],
    }));
    expect(sentTexts(request)[0]).toBe(formatFeedLagNotice({
      accountName: 'Joint_Spend', driftAmount: 1300, currency: 'USD', bankBalance: 3475.23,
    }));
    expect(store.setDriftAlerts).not.toHaveBeenCalled();
  });

  it('sends an AGED drift with the alarm formatter', async () => {
    const request = okNet();
    const store = tgStore();
    await deliverAddonAlerts(alertCtx(request), store as any, emptyResult({
      balanceDriftAlerts: [
        { sfinAccountId: 'sfin-1', accountName: 'Joint_Spend', driftAmount: 1300, currency: 'USD', bankBalance: 3475.23, phase: 'aged' },
      ],
    }));
    expect(sentTexts(request)[0]).toBe(formatBalanceDriftAlert({
      accountName: 'Joint_Spend', driftAmount: 1300, currency: 'USD', bankBalance: 3475.23,
    }));
  });

  it('rolls back only alertedAged when an AGED send fails, keeping the young alert delivered', async () => {
    const store = tgStore({
      getDriftAlerts: vi.fn(async () => ({
        'sfin-1': { driftAmount: 1300, firstDetectedAt: '2026-07-01T00:00:00.000Z', alerted: true, alertedAged: true },
      })),
    });
    await deliverAddonAlerts(alertCtx(rejectingNet()), store as any, emptyResult({
      balanceDriftAlerts: [
        { sfinAccountId: 'sfin-1', accountName: 'Spend', driftAmount: 1300, currency: 'USD', bankBalance: 3475.23, phase: 'aged' },
      ],
    }));
    const written = (store.setDriftAlerts as any).mock.calls[0][0];
    // The escalation retries next sync; the original young delivery does not.
    expect(written['sfin-1'].alertedAged).toBe(false);
    expect(written['sfin-1'].alerted).toBe(true);
  });

  it('queues an undelivered large-transaction alert into the shared outbox', async () => {
    // Nothing can re-derive this alert: the row is created once per SimpleFin tx
    // id, so a dropped result is a notification lost forever.
    const store = tgStore();
    const alert = { txId: 'tx-1', description: 'SQ *BLUE BOTTLE', amountCents: 124000, currency: 'USD', accountName: 'Spend' };

    await deliverAddonAlerts(alertCtx(rejectingNet()), store as any, emptyResult({
      largeTransactionAlerts: [alert],
    }));

    expect((store.setPendingLargeTxAlerts as any).mock.calls[0][0]).toEqual([alert]);
  });

  it('drains the outbox a previous run (or the companion) left behind', async () => {
    const queued = { txId: 'tx-old', description: 'Roof repair', amountCents: 250099, currency: 'USD', accountName: 'Spend' };
    const fresh = { txId: 'tx-new', description: 'DELTA AIR LINES', amountCents: 124000, currency: 'USD', accountName: 'Spend' };
    const request = okNet();
    const store = tgStore({ getPendingLargeTxAlerts: vi.fn(async () => [queued]) });

    await deliverAddonAlerts(alertCtx(request), store as any, emptyResult({
      largeTransactionAlerts: [fresh],
    }));

    expect(sentTexts(request)).toEqual([
      formatLargeTransactionAlert(queued), formatLargeTransactionAlert(fresh),
    ]);
    expect((store.setPendingLargeTxAlerts as any).mock.calls[0][0]).toEqual([]);
  });

  it('never sends the same large transaction twice when a queued entry is re-reported', async () => {
    const alert = { txId: 'tx-1', description: 'DELTA AIR LINES', amountCents: 124000, currency: 'USD', accountName: 'Spend' };
    const request = okNet();
    const store = tgStore({ getPendingLargeTxAlerts: vi.fn(async () => [alert]) });
    await deliverAddonAlerts(alertCtx(request), store as any, emptyResult({
      largeTransactionAlerts: [alert],
    }));
    expect(request).toHaveBeenCalledOnce();
  });

  it('does nothing at all — no sends, no ledger writes — when Telegram is not configured', async () => {
    // This is the "behaves exactly as before" case. A ledger write here would
    // suppress the companion for an episode nobody announced, and growing the
    // outbox for a user who opted out is an unbounded backlog that can never drain.
    const request = okNet();
    const store = tgStore({ getTelegramConfig: vi.fn(async () => null) });

    await deliverAddonAlerts(alertCtx(request), store as any, emptyResult({
      stuckTransferAlerts: [{ outTxId: 'tx-out', description: 'x', amountCents: 1, currency: 'USD' }],
      balanceDriftAlerts: [{ sfinAccountId: 'sfin-1', accountName: 'Spend', driftAmount: 200, currency: 'USD', bankBalance: 1 }],
      largeTransactionAlerts: [{ txId: 'tx-1', description: 'x', amountCents: 1, currency: 'USD', accountName: 'Spend' }],
    }));

    expect(request).not.toHaveBeenCalled();
    expect(store.setTransferLinkFailures).not.toHaveBeenCalled();
    expect(store.setDriftAlerts).not.toHaveBeenCalled();
    expect(store.setPendingLargeTxAlerts).not.toHaveBeenCalled();
  });

  it('treats an explicitly disabled Telegram config the same way', async () => {
    const request = okNet();
    const store = tgStore({
      getTelegramConfig: vi.fn(async () => ({ botToken: 'tok', chatId: '42', enabled: false })),
    });
    await deliverAddonAlerts(alertCtx(request), store as any, emptyResult({
      largeTransactionAlerts: [{ txId: 'tx-1', description: 'x', amountCents: 1, currency: 'USD', accountName: 'Spend' }],
    }));
    expect(request).not.toHaveBeenCalled();
    expect(store.setPendingLargeTxAlerts).not.toHaveBeenCalled();
  });

  it('reads no secrets when the run produced no alerts and the outbox is untouched', async () => {
    // A sync with nothing to say must not cost two secret reads and a write.
    const store = tgStore();
    await deliverAddonAlerts(alertCtx(okNet()), store as any, emptyResult());
    expect(store.getTelegramConfig).not.toHaveBeenCalled();
  });

  it('never throws — a notification problem must not be reported as a sync failure', async () => {
    const store = tgStore({
      getTelegramConfig: vi.fn(async () => { throw new Error('unreadable secret'); }),
    });
    await expect(
      deliverAddonAlerts(alertCtx(okNet()), store as any, emptyResult({
        stuckTransferAlerts: [{ outTxId: 'tx-out', description: 'x', amountCents: 1, currency: 'USD' }],
      })),
    ).resolves.toBeUndefined();
  });

  it('announces the duplicates the reconcile sweep deleted', async () => {
    // Automatic deletion of financial rows must not be silent, so the prune gets
    // its own message — one send for the whole sweep, not one per row.
    const request = okNet();
    const store = tgStore();
    const pruned = [
      { sfinAccountId: 'sfin-1', accountName: 'Savings', txId: 'TRN-3917f117',
        description: 'PNC BANK 1234 Transfer', date: '2026-07-27', amountCents: 130000,
        currency: 'USD', wfId: 'act-2' },
      { sfinAccountId: 'sfin-1', accountName: 'Savings', txId: 'TRN-ce426394',
        description: 'Monthly Interest Paid', date: '2026-06-30', amountCents: 250,
        currency: 'USD', wfId: 'act-4' },
    ];

    await deliverAddonAlerts(alertCtx(request), store as any, emptyResult({
      prunedDuplicates: pruned,
    }));

    expect(request).toHaveBeenCalledOnce();
    // Byte-identical to the companion's: one shared formatter.
    expect(sentTexts(request)[0]).toBe(formatDuplicatePruneAlert(pruned));
  });

  it('sends nothing for a prune when Telegram is disabled', async () => {
    const request = okNet();
    const store = tgStore({
      getTelegramConfig: vi.fn(async () => ({ botToken: 'tok', chatId: '42', enabled: false })),
    });
    await deliverAddonAlerts(alertCtx(request), store as any, emptyResult({
      prunedDuplicates: [{
        sfinAccountId: 'sfin-1', accountName: 'Savings', txId: 'TRN-1', description: 'x',
        date: '2026-07-27', amountCents: 250, currency: 'USD', wfId: 'act-2',
      }],
    }));
    expect(request).not.toHaveBeenCalled();
  });

  it('runSync delivers the alerts its own core produced', async () => {
    // The seam: without this, everything above is dead code. A quiet account
    // whose bank balance is $1000 against a $0 Wealthfolio valuation drifts past
    // the $100 default, so the core emits a real balance-drift alert here.
    vi.mocked(fetchAccounts).mockResolvedValueOnce(makeAccountSet([]));
    const request = okNet();
    const ctx = makeCtx();
    ctx.api.network = { request };
    const store = tgStore();

    await runSync(ctx, store as any);

    expect(sentTexts(request)).toHaveLength(1);
    // A just-opened episode is YOUNG, so the seam delivers the soft feed-lag
    // notice — the alarm only ever arrives via the 10-day escalation.
    expect(sentTexts(request)[0]).toContain('Waiting on the bank feed');
  });
});

describe('AddonSyncHost.linkPair', () => {
  const legs = (): [any, any] => [
    { wfId: 'act-out', accountId: 'wf-account-a', txId: 'tx-out', activityType: 'TRANSFER_OUT',
      date: '2023-11-14', absCents: 50000, currency: 'USD', comment: 'Payment to Citibank · tx-out' },
    { wfId: 'act-in', accountId: 'wf-account-b', txId: 'tx-in', activityType: 'TRANSFER_IN',
      date: '2023-11-15', absCents: 50000, currency: 'USD', comment: 'PAYMENT THANK YOU · tx-in' },
  ];

  it('deletes both legs, then re-creates them together, marked and grouped', async () => {
    const ctx = makeCtx();
    const result = await new AddonSyncHost(ctx).linkPair(legs());

    const calls = vi.mocked(ctx.api.activities.saveMany).mock.calls.map((c: any) => c[0]);
    // Delete FIRST: an update can neither clear a stored asset nor move a row
    // out of a stale group, and re-creating before deleting would collide with
    // the originals on the host's dedup.
    expect(calls[0].deleteIds.sort()).toEqual(['act-in', 'act-out']);
    expect(calls[0].creates).toBeUndefined();
    // Then ONE call holding BOTH legs — a per-leg call looks like a lone leg and
    // Wealthfolio silently drops the half-formed group.
    expect(calls).toHaveLength(2);
    const creates = calls[1].creates as any[];
    expect(creates).toHaveLength(2);
    for (const c of creates) {
      expect(c.symbol).toBeUndefined(); // any asset makes the leg unpairable
      expect(typeof c.metadata).toBe('string'); // an object 422s
      expect(JSON.parse(c.metadata)).toEqual({ flow: { is_external: false } });
      expect(String(c.sourceGroupId).startsWith('wf-transfer-')).toBe(true);
      expect(c.amount).toBe(500);
    }
    expect(creates[0].sourceGroupId).toBe(creates[1].sourceGroupId);
    expect(result).toEqual({ linked: true, groupId: creates[0].sourceGroupId });
  });

  it('reports linked:false when the host silently drops the group', async () => {
    // The save "succeeds" but the echo comes back ungrouped — the only way to
    // learn the link never landed, since search's ActivityDetails omits the gid.
    const ctx = makeCtx();
    ctx.api.activities.saveMany = vi.fn(async (req: any) => ({
      created: (req.creates ?? []).map((c: any, i: number) => ({
        ...c, id: `new-${i}`, notes: c.comment, sourceGroupId: null,
      })),
      updated: [], deleted: req.deleteIds ?? [], createdMappings: [], errors: [],
    }));
    const res = await new AddonSyncHost(ctx).linkPair(legs());
    expect(res.linked).toBe(false);
    // Not a bare `{ linked: false }`: both rows have already been deleted by
    // this point, so the caller has to be able to say why re-creating them
    // didn't restore the group.
    expect(res.problems?.join(' ')).toMatch(/group/i);
  });

  it('returns linked:false when a write errors, carrying the host message', async () => {
    const ctx = makeCtx();
    ctx.api.activities.saveMany = vi.fn(async () => ({
      created: [], updated: [], deleted: [], createdMappings: [],
      errors: [{ action: 'create', message: 'boom' }],
    }));
    const res = await new AddonSyncHost(ctx).linkPair(legs());
    expect(res.linked).toBe(false);
    expect(res.problems?.join(' ')).toContain('boom');
  });
});
