import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountMapper } from './AccountMapper';

describe('AccountMapper', () => {
  it('reports an account it created, for the change log', async () => {
    const ctx = {
      api: {
        accounts: {
          getAll: vi.fn(async () => []),
          create: vi.fn(async () => ({ id: 'wf-new', name: 'Citi Card' })),
        },
      },
    } as any;
    const onAccountCreated = vi.fn();
    render(
      <AccountMapper
        ctx={ctx}
        simplefinAccounts={[{ id: 'ACT-9c8d', name: 'Citi Card', currency: 'USD', balance: '-464.60', 'balance-date': 1, transactions: [] } as any]}
        initialMapping={{}}
        onSave={vi.fn()}
        onAccountCreated={onAccountCreated}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__create_new__' } });
    fireEvent.click(screen.getByRole('button', { name: 'Credit Card' }));
    await waitFor(() => expect(onAccountCreated).toHaveBeenCalledWith({
      sfinId: 'ACT-9c8d', wfId: 'wf-new', name: 'Citi Card', accountType: 'CREDIT_CARD',
    }));
  });

  it('reports nothing when the create fails', async () => {
    const ctx = {
      api: { accounts: { getAll: vi.fn(async () => []), create: vi.fn(async () => { throw new Error('nope'); }) } },
    } as any;
    const onAccountCreated = vi.fn();
    render(
      <AccountMapper
        ctx={ctx}
        simplefinAccounts={[{ id: 'ACT-1', name: 'Spend', currency: 'USD', balance: '1', 'balance-date': 1, transactions: [] } as any]}
        initialMapping={{}}
        onSave={vi.fn()}
        onAccountCreated={onAccountCreated}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '__create_new__' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bank / Cash' }));
    await screen.findByText('nope');
    expect(onAccountCreated).not.toHaveBeenCalled();
  });

  it('links a loan account to a liability instead of mapping it, and back', async () => {
    const ctx = {
      api: {
        accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', name: 'Checking' }]) },
        alternativeAssets: { getAll: vi.fn(async () => [
          { id: 'LIAB-1', kind: 'liability', name: 'Home Loan' },
          { id: 'PROP-1', kind: 'property', name: 'House' },
        ]) },
      },
    } as any;
    const onSave = vi.fn();
    render(
      <AccountMapper
        ctx={ctx}
        simplefinAccounts={[
          { id: 'ACT-chk', name: 'Checking', currency: 'USD', balance: '10', 'balance-date': 1, transactions: [] } as any,
          { id: 'ACT-loan', name: 'Servicer', currency: 'USD', balance: '-1000', 'balance-date': 1, transactions: [] } as any,
        ]}
        initialMapping={{ 'ACT-chk': 'wf-chk' }}
        onSave={onSave}
      />,
    );
    await screen.findAllByRole('option', { name: 'Home Loan' });
    expect(screen.queryByRole('option', { name: 'House' })).toBeNull();
    const [, loanSelect] = screen.getAllByRole('combobox');
    fireEvent.change(loanSelect, { target: { value: 'loan:LIAB-1' } });
    screen.getByText(/records this account's balance on the loan/);
    fireEvent.click(screen.getByRole('button', { name: 'Save Mapping' }));
    expect(onSave).toHaveBeenLastCalledWith({ 'ACT-chk': 'wf-chk' }, { 'ACT-loan': 'LIAB-1' });

    fireEvent.change(loanSelect, { target: { value: 'wf-chk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Mapping' }));
    expect(onSave).toHaveBeenLastCalledWith({ 'ACT-chk': 'wf-chk', 'ACT-loan': 'wf-chk' }, {});
  });

  const loanCtx = () => ({
    api: {
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', name: 'Checking' }]) },
      alternativeAssets: { getAll: vi.fn(async () => [{ id: 'LIAB-1', kind: 'liability', name: 'Home Loan' }]) },
    },
  }) as any;
  const servicer = { id: 'ACT-loan', name: 'Servicer', currency: 'USD', balance: '-1000', 'balance-date': 1, transactions: [] } as any;

  it('saves when the only change is a loan link', async () => {
    const onSave = vi.fn();
    render(<AccountMapper ctx={loanCtx()} simplefinAccounts={[servicer]} initialMapping={{}} onSave={onSave} />);
    await screen.findByRole('option', { name: 'Home Loan' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'loan:LIAB-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Mapping' }));
    expect(onSave).toHaveBeenCalledWith({}, { 'ACT-loan': 'LIAB-1' });
  });

  it('asks before turning a mapped account into a loan, since its imports stop', async () => {
    const onSave = vi.fn();
    render(<AccountMapper ctx={loanCtx()} simplefinAccounts={[servicer]} initialMapping={{ 'ACT-loan': 'wf-chk' }} onSave={onSave} />);
    await screen.findByRole('option', { name: 'Home Loan' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'loan:LIAB-1' } });
    screen.getByText(/stops importing its transactions into/);
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('wf-chk');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/stops importing/)).toBeNull();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'loan:LIAB-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Link to the loan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Mapping' }));
    expect(onSave).toHaveBeenLastCalledWith({}, { 'ACT-loan': 'LIAB-1' });
  });

  it('says a linked loan no longer exists, and drops the link on save', async () => {
    const onSave = vi.fn();
    render(<AccountMapper ctx={loanCtx()} simplefinAccounts={[servicer]} initialMapping={{ 'ACT-chk': 'wf-chk' }}
      initialLoanLinks={{ 'ACT-loan': 'LIAB-gone' }} onSave={onSave} />);
    await screen.findByText(/no longer exists/);
    expect(screen.queryByText(/records this account's balance/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save Mapping' }));
    expect(onSave).toHaveBeenCalledWith({ 'ACT-chk': 'wf-chk' }, {});
  });

  it('keeps a link it cannot check when the loans cannot be read', async () => {
    const ctx = loanCtx();
    ctx.api.alternativeAssets.getAll.mockRejectedValue(new Error('no permission'));
    const onSave = vi.fn();
    render(<AccountMapper ctx={ctx} simplefinAccounts={[servicer]} initialMapping={{ 'ACT-chk': 'wf-chk' }}
      initialLoanLinks={{ 'ACT-loan': 'LIAB-1' }} onSave={onSave} />);
    await waitFor(() => expect(ctx.api.alternativeAssets.getAll).toHaveBeenCalled());
    expect(screen.queryByText(/no longer exists/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save Mapping' }));
    expect(onSave).toHaveBeenCalledWith({ 'ACT-chk': 'wf-chk' }, { 'ACT-loan': 'LIAB-1' });
  });

  it('offers no loans until the companion reads loan links', async () => {
    render(<AccountMapper ctx={loanCtx()} simplefinAccounts={[servicer]} initialMapping={{}} companionVersion="1.67.1" onSave={vi.fn()} />);
    await screen.findByRole('option', { name: 'Checking' });
    expect(screen.queryByRole('option', { name: 'Home Loan' })).toBeNull();
  });

  it('offers no loans when the host cannot list them', async () => {
    const ctx = { api: { accounts: { getAll: vi.fn(async () => []) } } } as any;
    render(
      <AccountMapper ctx={ctx} initialMapping={{}} onSave={vi.fn()}
        simplefinAccounts={[{ id: 'ACT-1', name: 'Spend', currency: 'USD', balance: '1', 'balance-date': 1, transactions: [] } as any]} />,
    );
    await waitFor(() => expect(ctx.api.accounts.getAll).toHaveBeenCalled());
    expect(screen.queryByRole('group')).toBeNull();
  });
});
