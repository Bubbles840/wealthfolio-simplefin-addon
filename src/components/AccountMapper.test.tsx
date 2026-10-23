import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RelinkDecisions } from '../../shared/relink';
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

  it('offers a loan on one row only: another row already links it', async () => {
    const other = { ...servicer, id: 'ACT-loan-2', name: 'Servicer (relinked)' };
    render(<AccountMapper ctx={loanCtx()} simplefinAccounts={[servicer, other]} initialMapping={{}}
      initialLoanLinks={{ 'ACT-loan': 'LIAB-1' }} onSave={vi.fn()} />);
    await screen.findAllByRole('option', { name: 'Home Loan' });
    const [first, second] = screen.getAllByRole('combobox');
    expect(within(first).getByRole('option', { name: 'Home Loan' })).toBeTruthy();
    expect(within(second).queryByRole('option', { name: 'Home Loan' })).toBeNull();
    expect((first as HTMLSelectElement).value).toBe('loan:LIAB-1');
  });

  it('offers a loan whose only other link is from an account no longer in the feed', async () => {
    render(<AccountMapper ctx={loanCtx()} simplefinAccounts={[servicer]} initialMapping={{}}
      initialLoanLinks={{ 'ACT-gone': 'LIAB-1' }} onSave={vi.fn()} />);
    expect(await screen.findByRole('option', { name: 'Home Loan' })).toBeTruthy();
  });

  it('still shows a link two rows share (saved before one link per loan)', async () => {
    const other = { ...servicer, id: 'ACT-loan-2', name: 'Servicer (relinked)' };
    render(<AccountMapper ctx={loanCtx()} simplefinAccounts={[servicer, other]} initialMapping={{}}
      initialLoanLinks={{ 'ACT-loan': 'LIAB-1', 'ACT-loan-2': 'LIAB-1' }} onSave={vi.fn()} />);
    await screen.findAllByRole('option', { name: 'Home Loan' });
    for (const select of screen.getAllByRole('combobox') as HTMLSelectElement[]) {
      expect(select.value).toBe('loan:LIAB-1');
      expect(select.selectedOptions[0].textContent).toBe('Home Loan');
    }
  });

  it('shows an existing link, not "Select account", when loans are not offered or not read', async () => {
    const old = render(<AccountMapper ctx={loanCtx()} simplefinAccounts={[servicer]} initialMapping={{}}
      initialLoanLinks={{ 'ACT-loan': 'LIAB-1' }} companionVersion="1.67.1" onSave={vi.fn()} />);
    await screen.findByRole('option', { name: 'Checking' });
    let select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.selectedOptions[0].textContent).toBe('Home Loan');
    expect(select.value).toBe('loan:LIAB-1');
    old.unmount();

    const ctx = loanCtx();
    ctx.api.alternativeAssets.getAll.mockRejectedValue(new Error('no permission'));
    render(<AccountMapper ctx={ctx} simplefinAccounts={[servicer]} initialMapping={{}}
      initialLoanLinks={{ 'ACT-loan': 'LIAB-1' }} onSave={vi.fn()} />);
    await waitFor(() => expect(ctx.api.alternativeAssets.getAll).toHaveBeenCalled());
    select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.selectedOptions[0].textContent).toBe('Linked loan');
    expect(select.value).toBe('loan:LIAB-1');
  });

  it('keeps asking when a second loan is picked while the prompt is open', async () => {
    const ctx = loanCtx();
    ctx.api.alternativeAssets.getAll.mockResolvedValue([
      { id: 'LIAB-1', kind: 'liability', name: 'Home Loan' },
      { id: 'LIAB-2', kind: 'liability', name: 'Car Loan' },
    ]);
    const onSave = vi.fn();
    render(<AccountMapper ctx={ctx} simplefinAccounts={[servicer]} initialMapping={{ 'ACT-loan': 'wf-chk' }} onSave={onSave} />);
    await screen.findByRole('option', { name: 'Home Loan' });
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'loan:LIAB-1' } });
    fireEvent.change(select, { target: { value: 'loan:LIAB-2' } });

    screen.getByText(/records its balance on Car Loan instead/);
    expect(select.value).toBe('wf-chk');
    fireEvent.click(screen.getByRole('button', { name: 'Save Mapping' }));
    expect(onSave).toHaveBeenLastCalledWith({ 'ACT-loan': 'wf-chk' }, {});

    fireEvent.click(screen.getByRole('button', { name: 'Link to the loan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Mapping' }));
    expect(onSave).toHaveBeenLastCalledWith({}, { 'ACT-loan': 'LIAB-2' });
  });

  describe('a reconnection', () => {
    const ctx = () => ({ api: { accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', name: 'Checking' }]) } } }) as any;
    const newFeed = { id: 'ACT-new', name: 'Checking', currency: 'USD', balance: '10', 'balance-date': 1, transactions: [] } as any;
    const mapping = { 'ACT-old': 'wf-chk', 'ACT-new': 'wf-chk' };
    const none = (): RelinkDecisions => ({ confirmed: [], declined: [] });
    /** A store that applies each answer to what it holds, as SecretsStore.updateRelinkDecisions does. */
    const store = (start: RelinkDecisions = none()) => {
      let held = start;
      return { save: vi.fn(async (change: (d: RelinkDecisions) => RelinkDecisions) => (held = change(held))), now: () => held };
    };

    it('asks per account, with when it last reported, and saves a confirmed one', async () => {
      const st = store();
      render(<AccountMapper ctx={ctx()} simplefinAccounts={[newFeed]} initialMapping={mapping} onSave={vi.fn()}
        relinkDecisions={none()} onRelinkDecisions={st.save} sfinNames={{ 'ACT-old': 'Old Checking' }}
        lastSeen={{ 'ACT-old': Date.parse('2020-02-10T12:00:00Z') / 1000 }} />);
      await screen.findByText(/Old Checking \(last reported Feb 10, 2020\) is also mapped here/);
      fireEvent.click(screen.getByRole('button', { name: 'Yes, it replaces it' }));
      await waitFor(() => expect(st.now()).toEqual({
        confirmed: [{ wfAccountId: 'wf-chk', newId: 'ACT-new', oldIds: ['ACT-old'] }], declined: [],
      }));
      await screen.findByText(/Reconnection of Old Checking/);
      screen.getByText(/doesn't bring back copies already removed/);
    });

    it('asks about two absent accounts one at a time', async () => {
      const st = store();
      render(<AccountMapper ctx={ctx()} simplefinAccounts={[newFeed]} initialMapping={{ ...mapping, 'ACT-other': 'wf-chk' }} onSave={vi.fn()}
        relinkDecisions={none()} onRelinkDecisions={st.save} sfinNames={{ 'ACT-old': 'Old Checking', 'ACT-other': 'Savings' }} />);
      await screen.findByText(/Savings \(not reported recently\)/);
      const [first] = screen.getAllByRole('button', { name: 'No, both feed this account' });
      fireEvent.click(first);
      await waitFor(() => expect(st.now().declined).toEqual(['wf-chk|ACT-new|ACT-old']));
      fireEvent.click(screen.getByRole('button', { name: 'Yes, it replaces it' }));
      await waitFor(() => expect(st.now().confirmed).toEqual([{ wfAccountId: 'wf-chk', newId: 'ACT-new', oldIds: ['ACT-other'] }]));
    });

    it('remembers a no, asks nothing more, and can take it back', async () => {
      const st = store();
      render(<AccountMapper ctx={ctx()} simplefinAccounts={[newFeed]} initialMapping={mapping} onSave={vi.fn()}
        relinkDecisions={none()} onRelinkDecisions={st.save} />);
      fireEvent.click(await screen.findByRole('button', { name: 'No, both feed this account' }));
      await waitFor(() => expect(st.now()).toEqual({ confirmed: [], declined: ['wf-chk|ACT-new|ACT-old'] }));
      await waitFor(() => expect(screen.queryByText(/is also mapped here/)).toBeNull());
      fireEvent.click(screen.getByRole('button', { name: 'Ask again' }));
      await screen.findByText(/is also mapped here/);
      expect(st.now()).toEqual(none());
    });

    it('keeps an answer saved elsewhere since the screen read the document', async () => {
      const st = store({ confirmed: [], declined: ['wf-sav|ACT-x|ACT-y'] });
      render(<AccountMapper ctx={ctx()} simplefinAccounts={[newFeed]} initialMapping={mapping} onSave={vi.fn()}
        relinkDecisions={none()} onRelinkDecisions={st.save} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Yes, it replaces it' }));
      await waitFor(() => expect(st.now().declined).toEqual(['wf-sav|ACT-x|ACT-y']));
      expect(st.now().confirmed).toHaveLength(1);
    });

    it('asks nothing without a writer, and offers no answer until the companion reads them', async () => {
      const { unmount } = render(<AccountMapper ctx={ctx()} simplefinAccounts={[newFeed]} initialMapping={mapping} onSave={vi.fn()} />);
      await screen.findByRole('option', { name: 'Checking' });
      expect(screen.queryByText(/is also mapped here/)).toBeNull();
      unmount();

      render(<AccountMapper ctx={ctx()} simplefinAccounts={[newFeed]} initialMapping={mapping} onSave={vi.fn()}
        relinkDecisions={none()} onRelinkDecisions={store().save} companionVersion="1.67.1" />);
      await screen.findByText(/Update the companion to/);
      expect(screen.queryByRole('button', { name: /Yes, it replaces/ })).toBeNull();
    });

    it('can undo a confirmation', async () => {
      const confirmed = { confirmed: [{ wfAccountId: 'wf-chk', newId: 'ACT-new', oldIds: ['ACT-old'] }], declined: [] };
      const st = store(confirmed);
      render(<AccountMapper ctx={ctx()} simplefinAccounts={[newFeed]} initialMapping={mapping} onSave={vi.fn()}
        relinkDecisions={confirmed} onRelinkDecisions={st.save} />);
      // What Undo costs, said before it is pressed.
      expect(await screen.findByText(/Ignore rules saved on the old account stop applying to this one\./)).toBeInTheDocument();
      fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(st.now()).toEqual(none()));
    });
  });
});
