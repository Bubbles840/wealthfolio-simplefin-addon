import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HoldingsWithoutCost, readHoldingsWithoutCost } from './HoldingsWithoutCost';

const holding = (symbol: string, quantity: number, cost: number | null, holdingType = 'security') => ({
  holdingType, instrument: { symbol }, quantity, costBasis: cost === null ? null : { local: cost },
});

function ctxWith(holdings: Record<string, unknown[] | Error>) {
  return {
    api: {
      accounts: {
        getAll: vi.fn(async () => [
          { id: 'wf-401k', name: 'Plan 401(k)', accountType: 'SECURITIES', trackingMode: 'HOLDINGS' },
          { id: 'wf-ira', name: 'Brokerage IRA', accountType: 'SECURITIES', trackingMode: 'TRANSACTIONS' },
          { id: 'wf-cash', name: 'Checking', accountType: 'CASH', trackingMode: 'TRANSACTIONS' },
          { id: 'wf-other', name: 'Not mapped', accountType: 'SECURITIES', trackingMode: 'HOLDINGS' },
          { id: 'wf-old', name: 'Closed plan', accountType: 'SECURITIES', trackingMode: 'HOLDINGS', isArchived: true },
        ]),
      },
      portfolio: {
        getHoldings: vi.fn(async (id: string) => {
          const h = holdings[id] ?? [];
          if (h instanceof Error) throw h;
          return h;
        }),
      },
    },
  } as any;
}

const mapping = { 'sfin-1': 'wf-401k', 'sfin-2': 'wf-ira', 'sfin-3': 'wf-cash', 'sfin-4': 'wf-old' };

describe('readHoldingsWithoutCost', () => {
  it('lists holdings with shares and no cost, in mapped investment accounts only', async () => {
    const ctx = ctxWith({
      'wf-401k': [holding('TARGET FUND (AAAA1111)', 50, 0), holding('INDEX FUND', 10, 1000), holding('$CASH-USD', 5, 0, 'cash')],
      'wf-ira': [holding('VT', 3, null), holding('SOLD', 0, 0)],
      'wf-other': [holding('ELSEWHERE', 1, 0)],
      'wf-old': [holding('ARCHIVED', 1, 0)],
    });
    expect(await readHoldingsWithoutCost(ctx, mapping)).toEqual([
      { symbol: 'TARGET FUND (AAAA1111)', account: 'Plan 401(k)', accountId: 'wf-401k' },
      { symbol: 'VT', account: 'Brokerage IRA', accountId: 'wf-ira' },
    ]);
    // A cash account's holdings, and an archived account's, are never read.
    expect(ctx.api.portfolio.getHoldings).not.toHaveBeenCalledWith('wf-cash');
    expect(ctx.api.portfolio.getHoldings).not.toHaveBeenCalledWith('wf-old');
  });

  it('leaves out an account whose holdings cannot be read', async () => {
    const ctx = ctxWith({ 'wf-401k': new Error('denied'), 'wf-ira': [holding('VT', 3, 0)] });
    expect(await readHoldingsWithoutCost(ctx, mapping)).toEqual([{ symbol: 'VT', account: 'Brokerage IRA', accountId: 'wf-ira' }]);
  });
});

describe('HoldingsWithoutCost', () => {
  it('shows each holding and what to do', async () => {
    render(<HoldingsWithoutCost ctx={ctxWith({ 'wf-401k': [holding('TARGET FUND (AAAA1111)', 50, 0)] })} mapping={mapping} syncing={false} />);
    await screen.findByRole('status', { name: 'Holdings without a cost' });
    expect(screen.getByText('TARGET FUND (AAAA1111)')).toBeInTheDocument();
    expect(screen.getByText(/Give it a cost in Wealthfolio/)).toBeInTheDocument();
  });

  it('shows nothing when every holding has a cost', async () => {
    const ctx = ctxWith({ 'wf-401k': [holding('INDEX FUND', 10, 1000)] });
    const { container } = render(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} />);
    await waitFor(() => expect(ctx.api.portfolio.getHoldings).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('reads again when a sync finishes, so an entered cost leaves the list', async () => {
    const holdings: Record<string, unknown[]> = { 'wf-401k': [holding('TARGET FUND (AAAA1111)', 50, 0)] };
    const ctx = ctxWith(holdings);
    const { rerender } = render(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} />);
    await screen.findByText('TARGET FUND (AAAA1111)');
    holdings['wf-401k'] = [holding('TARGET FUND (AAAA1111)', 50, 900)];
    rerender(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={true} />);
    rerender(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} />);
    await waitFor(() => expect(screen.queryByText('TARGET FUND (AAAA1111)')).not.toBeInTheDocument());
  });

  it('reads again when the page re-reads balances (a companion\'s sync)', async () => {
    const holdings: Record<string, unknown[]> = { 'wf-401k': [holding('TARGET FUND (AAAA1111)', 50, 0)] };
    const ctx = ctxWith(holdings);
    const { rerender } = render(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} refresh={{ n: 1 }} />);
    await screen.findByText('TARGET FUND (AAAA1111)');
    holdings['wf-401k'] = [holding('TARGET FUND (AAAA1111)', 50, 900)];
    rerender(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} refresh={{ n: 2 }} />);
    await waitFor(() => expect(screen.queryByText('TARGET FUND (AAAA1111)')).not.toBeInTheDocument());
  });
});
