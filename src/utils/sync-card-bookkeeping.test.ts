import { describe, it, expect, vi } from 'vitest';
import { applyBalanceAdjustment } from './sync';

/** A card in the add-on's SDK: the import endpoint records what it is handed. */
function cardCtx() {
  return {
    api: {
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-c', name: 'Citi Card', accountType: 'CREDIT_CARD' }]) },
      activities: {
        import: vi.fn(async () => ({})),
        search: vi.fn(async () => ({ data: [], meta: { totalRowCount: 0 } })),
      },
    },
  } as any;
}
const FRESH = () => ({ lastSuccessAt: new Date().toISOString() });
const store = (version: string | null, health: () => { lastSuccessAt?: string | null } | null = FRESH) => ({
  getWealthfolioVersion: vi.fn(async () => version),
  getSyncHealth: vi.fn(async () => health()),
  getAccountBalances: vi.fn(async () => ({})),
  setAccountBalances: vi.fn(async () => {}),
});

describe('the app shapes a card\'s balance plug by the Wealthfolio the companion published', () => {
  it.each([
    ['3.10.0', 'TRANSFER_OUT'],
    ['3.9.1', 'WITHDRAWAL'],
    [null, 'WITHDRAWAL'],
  ])('on %s a card plug out is a %s', async (version, type) => {
    const ctx = cardCtx();
    await applyBalanceAdjustment(ctx, store(version) as any, { sfinAccountId: 'sfin-c', wfAccountId: 'wf-c', currency: 'USD', amount: -12.5 });
    expect(ctx.api.activities.import).toHaveBeenCalledWith([expect.objectContaining({ activityType: type, amount: 12.5, symbol: '$CASH-USD' })]);
  });

  it.each([
    ['a stale companion (3 days)', () => ({ lastSuccessAt: new Date(Date.now() - 3 * 86_400_000).toISOString() })],
    ['no sync_health at all', () => null],
    ['a sync_health without lastSuccessAt', () => ({})],
  ])('does not trust a published 3.10.0 behind %s: the plug stays a WITHDRAWAL', async (_what, health) => {
    const ctx = cardCtx();
    await applyBalanceAdjustment(ctx, store('3.10.0', health) as any, { sfinAccountId: 'sfin-c', wfAccountId: 'wf-c', currency: 'USD', amount: -12.5 });
    expect(ctx.api.activities.import).toHaveBeenCalledWith([expect.objectContaining({ activityType: 'WITHDRAWAL' })]);
  });

  it('trusts a published 3.10.0 while the companion synced less than 2 days ago', async () => {
    const ctx = cardCtx();
    const recent = () => ({ lastSuccessAt: new Date(Date.now() - 36 * 3_600_000).toISOString() });
    await applyBalanceAdjustment(ctx, store('3.10.0', recent) as any, { sfinAccountId: 'sfin-c', wfAccountId: 'wf-c', currency: 'USD', amount: -12.5 });
    expect(ctx.api.activities.import).toHaveBeenCalledWith([expect.objectContaining({ activityType: 'TRANSFER_OUT' })]);
  });
});
