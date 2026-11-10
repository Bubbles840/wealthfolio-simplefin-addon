import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HoldingsWithoutCost, readHoldingsWithoutCost } from './HoldingsWithoutCost';

const holding = (symbol: string, quantity: number, cost: number | null, holdingType = 'security') => ({
  holdingType, instrument: { symbol }, quantity, costBasis: cost === null ? null : { local: cost },
});

function ctxWith(holdings: Record<string, unknown[] | Error | null>, secrets: Record<string, string> = {}) {
  return {
    api: {
      secrets: {
        get: vi.fn(async (k: string) => secrets[k] ?? null),
        set: vi.fn(async (k: string, v: string) => { secrets[k] = v; }),
      },
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
          const h = id in holdings ? holdings[id] : [];
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

  it('leaves out only the account whose holdings read resolves to no list', async () => {
    const ctx = ctxWith({ 'wf-401k': null, 'wf-ira': [holding('VT', 3, 0)] });
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

describe('HoldingsWithoutCost: Don\'t show', () => {
  const KEY = 'holdings_cost_hidden';

  it('hides a holding for good, kept in a secret, and Undo brings it back', async () => {
    const secrets: Record<string, string> = {};
    const ctx = ctxWith({ 'wf-401k': [holding('TARGET FUND (AAAA1111)', 50, 0)], 'wf-ira': [holding('VT', 3, 0)] }, secrets);
    const { unmount } = render(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} />);
    fireEvent.click(await screen.findByRole('button', { name: "Don't show VT in Brokerage IRA" }));
    expect(screen.queryByText('VT')).not.toBeInTheDocument();
    await waitFor(() => expect(Object.keys(JSON.parse(secrets[KEY]))).toEqual(['wf-ira|VT']));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(JSON.parse(secrets[KEY])).toEqual({}));
    expect(screen.getByText('VT')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Don't show VT in Brokerage IRA" }));
    await waitFor(() => expect(Object.keys(JSON.parse(secrets[KEY]))).toEqual(['wf-ira|VT']));
    unmount();
    // Another visit (or another browser) reads it from the secret.
    render(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} />);
    await screen.findByText('TARGET FUND (AAAA1111)');
    expect(screen.queryByText('VT')).not.toBeInTheDocument();
  });

  it('a new holding without a cost still shows, and the banner goes once all are hidden', async () => {
    const secrets: Record<string, string> = { [KEY]: JSON.stringify({ 'wf-ira|VT': '2026-01-01T00:00:00.000Z' }) };
    const holdings: Record<string, unknown[]> = { 'wf-ira': [holding('VT', 3, 0)] };
    const ctx = ctxWith(holdings, secrets);
    const { container, rerender } = render(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} refresh={1} />);
    await waitFor(() => expect(ctx.api.portfolio.getHoldings).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    holdings['wf-ira'] = [holding('VT', 3, 0), holding('NEW FUND', 2, 0)];
    rerender(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} refresh={2} />);
    await screen.findByText('NEW FUND');
    expect(screen.queryByText('VT')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Don't show NEW FUND in Brokerage IRA" }));
    // The last one hidden: only the Undo stays, until it times out.
    expect(screen.queryByRole('status', { name: 'Holdings without a cost' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('two hides in a row both reach the secret', async () => {
    const secrets: Record<string, string> = {};
    const ctx = ctxWith({ 'wf-401k': [holding('TARGET FUND (AAAA1111)', 50, 0)], 'wf-ira': [holding('VT', 3, 0)] }, secrets);
    render(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} />);
    fireEvent.click(await screen.findByRole('button', { name: "Don't show VT in Brokerage IRA" }));
    fireEvent.click(screen.getByRole('button', { name: "Don't show TARGET FUND (AAAA1111) in Plan 401(k)" }));
    await waitFor(() => expect(Object.keys(JSON.parse(secrets[KEY] ?? '{}')).sort()).toEqual(['wf-401k|TARGET FUND (AAAA1111)', 'wf-ira|VT']));
  });

  it('keeps a hide another browser saved in between', async () => {
    const secrets: Record<string, string> = {};
    const ctx = ctxWith({ 'wf-ira': [holding('VT', 3, 0)] }, secrets);
    render(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} />);
    const button = await screen.findByRole('button', { name: "Don't show VT in Brokerage IRA" });
    secrets[KEY] = JSON.stringify({ 'wf-401k|OTHER': '2026-01-01T00:00:00.000Z' });
    fireEvent.click(button);
    await waitFor(() => expect(Object.keys(JSON.parse(secrets[KEY])).sort()).toEqual(['wf-401k|OTHER', 'wf-ira|VT']));
  });

  it('shows the holding again when the hide could not be saved', async () => {
    const ctx = ctxWith({ 'wf-ira': [holding('VT', 3, 0)] });
    ctx.api.secrets.set.mockRejectedValue(new Error('write failed'));
    render(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} />);
    fireEvent.click(await screen.findByRole('button', { name: "Don't show VT in Brokerage IRA" }));
    await screen.findByText('VT');
    expect(screen.getByText(/could not be saved/)).toBeInTheDocument();
    expect(screen.queryByText('Hidden.')).not.toBeInTheDocument();
  });

  it('a read that started before a hide does not bring the holding back', async () => {
    const secrets: Record<string, string> = {};
    const ctx = ctxWith({ 'wf-ira': [holding('VT', 3, 0)] }, secrets);
    const { rerender } = render(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} refresh={1} />);
    const button = await screen.findByRole('button', { name: "Don't show VT in Brokerage IRA" });
    let release!: () => void;
    // The second read is held open (its first account) until after the hide.
    ctx.api.portfolio.getHoldings.mockImplementationOnce(() => new Promise((r) => { release = () => r([]); }));
    rerender(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} refresh={2} />);
    fireEvent.click(button);
    await waitFor(() => expect(secrets[KEY]).toBeDefined());
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('VT')).not.toBeInTheDocument();
  });

  it('Home opened again while a hide is still saving reads it after the save', async () => {
    const secrets: Record<string, string> = {};
    const ctx = ctxWith({ 'wf-ira': [holding('VT', 3, 0)], 'wf-401k': [holding('TARGET FUND (AAAA1111)', 50, 0)] }, secrets);
    let release!: () => void;
    ctx.api.secrets.set.mockImplementationOnce((k: string, v: string) => new Promise<void>((r) => { release = () => { secrets[k] = v; r(); }; }));
    const { unmount } = render(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} />);
    fireEvent.click(await screen.findByRole('button', { name: "Don't show VT in Brokerage IRA" }));
    await waitFor(() => expect(ctx.api.secrets.set).toHaveBeenCalled());
    unmount();
    render(<HoldingsWithoutCost ctx={ctx} mapping={mapping} syncing={false} />);
    release();
    await screen.findByText('TARGET FUND (AAAA1111)');
    expect(screen.queryByText('VT')).not.toBeInTheDocument();
  });
});
