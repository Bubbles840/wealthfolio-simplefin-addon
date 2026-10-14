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
const store = (version: string | null) => ({
  getWealthfolioVersion: vi.fn(async () => version),
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
});
