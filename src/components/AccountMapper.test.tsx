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
});
